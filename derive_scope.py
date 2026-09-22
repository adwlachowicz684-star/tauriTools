#!/usr/bin/env python3
"""
derive_scope.py —— 自动派生「同步管辖清单」
================================================================
取代 replay.py 里手工维护的 MINE_FILES。

为什么必须自动派生
------------------------------------------------------------
手工清单会漏，而**漏了没有任何机制能发现**。这条已经栽过五次：

  1. brushVars            改了、测了，同步后没了
  2. --ctl-faux-bold      同上
  3. --sp-*               同上
  4. project-group/style.css（49 处字号令牌化整份丢失）
  5. mindmap/index.js + panels.js（本次被他人提交冲掉）

这类失效最坏的地方在于：**测试永远发现不了**——测试跑的是当前这份，
而丢失发生在"下次同步"。等发现时，改动已经没了，而且不知道没了多久。

原理
------------------------------------------------------------
不做"猜谁改的"，而是三方比对 blob sha：

                本地 ≠ base   本地 == base
  远端 ≠ base     BOTH          THEIRS
  远端 == base    MINE          SAME

  MINE    我改的、远端没动      → 管辖：保留本地，推送
  THEIRS  远端改的、我没动      → 同步：用远端覆盖
  BOTH    两边都改了            → 三方合并（冲突则报人工）
  SAME    都没动                → 忽略

判据用的是 **git blob sha**（`git hash-object --no-filters`），
已实测与 GitHub 返回的 blob sha 逐位一致（见 README 的验证记录），
不需要下载文件内容再逐字节比——830 个文件也只用两次 API。

关键设计：base 必须持久化为"上次同步时的远端 HEAD"
------------------------------------------------------------
若拿远端 main 当 base，则"远端改了而本地没同步"这一类**永远检测不到**
（本地==main 恒成立），THEIRS 恒为空 —— 表面上一切正常，实际上别人推的
东西你永远同步不下来。所以 base 存在 .git/derive-base.json，
每次同步/推送成功后用 --update-base 推进。
"""
import io, json, os, subprocess, sys, time, urllib.request, urllib.error

TOKEN = os.environ.get('GITHUB_TOKEN', '')
REPO = os.environ.get('PAT_REPO', 'adwlachowicz684-star/tauriTools')
ROOT = os.environ.get('PAT_ROOT', '/data/workspace/tauriTools')
API = 'https://api.github.com/repos/' + REPO + '/'
BASE_FILE = os.path.join(ROOT, '.git', 'derive-base.json')

# 本地扫目录时的排除项。node_modules 不排会有几万个文件，
# 不仅慢，还会让 LOCAL_ONLY 淹没有效信息。
EXCLUDE_DIRS = {
    'node_modules', '.git', 'target', 'dist', 'build',
    '.tauri', '__pycache__', '.venv', 'venv',
}


def api(path, tries=6):
    """
    路径可能含中文（如 docs/原版对齐复查-差异清单.md）。
    urllib 会用 ascii 编码 URL，遇到非 ascii 直接抛
    "'ascii' codec can't encode characters" —— 表现为**中文路径的文件永远
    同步不了**，而英文路径一切正常，极易误判成"远端没这个文件"。
    故这里先做 percent-encode；safe 里保留 URL 自身的结构字符。
    """
    from urllib.parse import quote
    path = quote(path, safe="/:?=&%.,-_~+")
    last = None
    for i in range(tries):
        try:
            r = urllib.request.Request(API + path)
            for k, v in [('Authorization', 'Bearer ' + TOKEN),
                         ('Accept', 'application/vnd.github+json'),
                         ('User-Agent', 'derive-scope')]:
                r.add_header(k, v)
            with urllib.request.urlopen(r, timeout=90) as resp:
                return json.loads(resp.read())
        except Exception as e:
            last = e
            time.sleep(2 + i * 2)
    raise last


def remote_head():
    return api('commits?per_page=1')[0]['sha']


def tree_of(ref):
    """一次拿全部 blob 的 {path: sha}。recursive=1 已实测 truncated=False。"""
    d = api('git/trees/%s?recursive=1' % ref)
    if d.get('truncated'):
        sys.exit('远端文件树被截断（truncated=True），结果不可信，已中止。')
    return {x['path']: x['sha'] for x in d['tree'] if x['type'] == 'blob'}


def local_files():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            # 断链符号链接会被 os.walk 列进 filenames，但读不了 ——
            # 不过滤的话 git hash-object 直接 fatal 退出，整个派生失败。
            if not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
            out.append(rel)
    return out


def local_hashes(paths):
    """
    批量算 blob sha。

    必须 --no-filters：否则 git 会按 .gitattributes 应用 clean filter，
    算出的 sha 与 GitHub 存的原始字节不符，全部文件都会被误判成"有改动"。
    实测三个文件用 --no-filters 与远端 sha 完全一致。

    -z + --stdin-paths：路径可能含空格/中文，用 NUL 分隔才不会切错。
    """
    if not paths:
        return {}
    p = subprocess.run(['git', 'hash-object', '--no-filters', '--stdin-paths'],
                       cwd=ROOT, input=('\n'.join(paths)).encode('utf-8'),
                       capture_output=True)
    if p.returncode != 0:
        sys.exit('git hash-object 失败: ' + p.stderr.decode()[:300])
    # --stdin-paths 按行读取。本仓库无含换行的路径；真有的话数量校验会拦下，
    # 不会静默错位（曾经想过用 -z，但此 git 版本不支持该开关）。
    shas = [x.strip() for x in p.stdout.decode('utf-8', 'replace').splitlines() if x.strip()]
    if len(shas) != len(paths):
        sys.exit('hash 数量不匹配：输入 %d 输出 %d（可能有路径含特殊字符）'
                 % (len(paths), len(shas)))
    return dict(zip(paths, shas))


def load_base():
    try:
        return json.load(io.open(BASE_FILE, encoding='utf-8'))['base']
    except Exception:
        return None


def save_base(sha):
    d = os.path.dirname(BASE_FILE)
    if not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    io.open(BASE_FILE, 'w', encoding='utf-8').write(
        json.dumps({'base': sha, 'updated': time.strftime('%Y-%m-%d %H:%M:%S')},
                   ensure_ascii=False, indent=1))


def classify(base=None):
    head = remote_head()
    # 必须用**具体 commit sha** 而不是 'main'：
    # 'main' 是浮动的，取文件列表与取 HEAD 之间若有人推了新提交，
    # 两边就不是同一份内容 —— 那会导致 base 与"实际拉到的内容"不一致，
    # 表现为本地明明已同步却仍被判成 MINE（实测踩到）。
    remote = tree_of(head)
    if base is None:
        base = load_base()
    if base is None:
        # 首次运行：没有历史基准。此时只能用 main 当基准，
        # 代价是 THEIRS 类检测不到 —— 所以立刻把 main 记为基准，
        # 从下一轮起就能正常区分了。
        base = head
        save_base(head)
        first_run = True
    else:
        first_run = False
    try:
        base_tree = tree_of(base)
    except Exception as e:
        sys.exit('取基准 %s 的文件树失败：%s\n'
                 '基准可能已被 GC 或分支重写，请用 --base 指定一个新的（如当前 main）。'
                 % (base[:10], str(e)[:80]))

    locals_ = local_files()
    lhash = local_hashes(locals_)

    groups = {'MINE': [], 'THEIRS': [], 'BOTH': [], 'LOCAL_ONLY': [],
              'REMOTE_ONLY': [], 'SAME': 0}
    allpaths = set(remote) | set(lhash)
    for p in sorted(allpaths):
        r = remote.get(p)
        l = lhash.get(p)
        b = base_tree.get(p)
        if l is None:
            groups['REMOTE_ONLY'].append(p); continue
        if r is None:
            groups['LOCAL_ONLY'].append(p); continue
        if l == r:
            groups['SAME'] += 1; continue
        # 到这里：本地与远端不一致，需要 base 判断是谁动的
        if b is None:
            # base 里没有：两边都是"相对基准的新增"，按本地优先
            groups['MINE'].append(p); continue
        l_changed = (l != b)
        r_changed = (r != b)
        if l_changed and r_changed:
            groups['BOTH'].append(p)
        elif l_changed:
            groups['MINE'].append(p)
        else:
            groups['THEIRS'].append(p)
    return dict(head=head, base=base, first_run=first_run, **groups)


def fetch_remote_text(path, ref):
    d = api('contents/%s?ref=%s' % (path, ref))
    import base64 as _b
    return _b.b64decode(d['content']).decode('utf-8')


def sync_theirs(base=None, include_both=False):
    """
    把 THEIRS（远端改了、本地没动）同步为远端版。

    只做 THEIRS，**不碰 BOTH** —— BOTH 意味着两边都动过，覆盖会丢改动，
    必须人工或三方合并。宁可留着让人看一眼，也不能自动覆盖。

    覆盖前先备份到 .git/sync-backup/，万一判错还能捞回来。
    """
    r = classify(base)
    targets = list(r['THEIRS'])
    if include_both:
        # BOTH 默认**不自动同步**：两边都动过，覆盖会丢一边。
        # 只有调用方已确认"本地这些差异不是我要的"时，才显式加这个开关。
        targets += list(r['BOTH'])
        print('已按 --include-both 纳入 BOTH %d 个（调用方需自行确认安全）' % len(r['BOTH']))
    if not targets:
        print('THEIRS 为空，无需同步。'); return
    bdir = os.path.join(ROOT, '.git', 'sync-backup')
    os.makedirs(bdir, exist_ok=True)
    n = 0
    for p in targets:
        full = os.path.join(ROOT, p)
        try:
            if os.path.exists(full):
                import shutil
                shutil.copy2(full, os.path.join(bdir, p.replace('/', '__')))
            txt = fetch_remote_text(p, r['head'])
            os.makedirs(os.path.dirname(full), exist_ok=True)
            io.open(full, 'w', encoding='utf-8').write(txt)
            n += 1
        except Exception as e:
            print('  ✗ %-50s %s' % (p.split('/')[-1], str(e)[:50]))
    print('已同步 %d/%d 个（备份在 .git/sync-backup/）' % (n, len(targets)))
    # 同步完把基准推进到**实际拉取的那个 commit**（不是再取一次 HEAD）——
    # 两者必须严格对应，否则"本地已同步"会被误判成 MINE。
    save_base(r['head'])
    print('基准已同步推进为 %s' % r['head'][:10])
    print('BOTH %d 个未处理（需人工/三方合并）: %s'
          % (len(r['BOTH']), ', '.join(x.split('/')[-1] for x in r['BOTH'][:5])))


def main():
    args = [a for a in sys.argv[1:]]
    only_mine = '--mine' in args
    as_json = '--json' in args
    if '--update-base' in args:
        """
        手动推进基准前**必须**先确认本地已对齐，否则会把"我落后于远端的
        差异"固化成 MINE —— 实测踩到过：base 被推到 HEAD 后，那 10 个
        "别人推的、我没同步"的文件全被判成我改的。
        """
        cur = classify(load_base())
        unresolved = len(cur['THEIRS']) + len(cur['BOTH'])
        if unresolved and '--force' not in args:
            print('✗ 本地还有 THEIRS %d + BOTH %d 未同步，此时推进基准会把它们'
                  % (len(cur['THEIRS']), len(cur['BOTH'])))
            print('  固化成 MINE（表现为"我没改过的文件被当成我改的"）。')
            print('  请先跑 --sync-theirs，或确认无误后加 --force。')
            return
        h = remote_head(); save_base(h)
        print('基准已更新为 %s' % h[:10]); return
    b = None
    if '--base' in args:
        b = args[args.index('--base') + 1]
    if '--sync-theirs' in args:
        sync_theirs(b, include_both=('--include-both' in args))
        return
    r = classify(b)

    if as_json:
        print(json.dumps(r, ensure_ascii=False, indent=1)); return
    if only_mine:
        for p in r['MINE']:
            print(p)
        return

    print('远端 HEAD : %s' % r['head'][:10])
    print('基准 base : %s%s' % (r['base'][:10],
                                '  （首次运行，已记为基准）' if r['first_run'] else ''))
    print()
    for k in ['MINE', 'THEIRS', 'BOTH', 'LOCAL_ONLY', 'REMOTE_ONLY']:
        v = r[k]
        print('%-12s %4d' % (k, len(v)))
        for p in v[:8]:
            print('             %s' % p)
        if len(v) > 8:
            print('             … 另 %d 个' % (len(v) - 8))
    print('%-12s %4d' % ('SAME', r['SAME']))


if __name__ == '__main__':
    main()
