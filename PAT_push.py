#!/usr/bin/env python3
"""
PAT_push.py —— 直接推送，绕过 push_api.py 的冲突状态机。

为什么不用 push_api.py：
  push_api.py 模拟了 pull / merge / conflict / resolve / push 的完整流程，
  并把冲突状态自行记在 .git/push-sync.json 里。但通过 API 提交**根本
  不需要 merge** —— 网络一旦中断，"有冲突未解决"这个自造状态就会卡死，
  重试多少次都推不上去（本次实测卡了 8 轮以上）。

本脚本的做法：
  1. 以远端 main 的最新 commit 为 base（显式指定，防覆盖他人改动）
  2. 对每个要改的文件做三方合并（base / 本地 / 远端），冲突则报告
  3. 用 Git Data API 建 blob → 新 tree → 新 commit → 更新 ref
     更新 ref 时带 base sha 做**乐观锁**：期间若有人先推了，这里会失败
     而不是静默覆盖。

用法：
  export GITHUB_TOKEN=xxx
  export PAT_PUSH_FILES="a.js,b.css"      # 相对仓库根，逗号分隔
  export PAT_BASE=<远端最新 commit sha>   # 必填，防覆盖
  python3 PAT_push.py
"""
import os, sys, io, json, base64, time, urllib.request

TOKEN = os.environ.get('GITHUB_TOKEN', '')
REPO  = os.environ.get('PAT_REPO', 'adwlachowicz684-star/tauriTools')
ROOT  = os.environ.get('PAT_ROOT', '/data/workspace/tauriTools')
API   = 'https://api.github.com/repos/' + REPO + '/'
BASE  = os.environ.get('PAT_BASE', '')
FILES = [f.strip() for f in os.environ.get('PAT_PUSH_FILES', '').split(',') if f.strip()]
MSG   = os.environ.get('PAT_MSG', 'chore: 同步本地改动')
OLD   = os.environ.get('PAT_SYNCED', '')   # 上次已同步到的 commit，用作三方合并的 base

if not TOKEN: sys.exit('缺 GITHUB_TOKEN')
if not FILES: sys.exit('缺 PAT_PUSH_FILES')
if not BASE:  sys.exit('缺 PAT_BASE（远端最新 commit sha，用于防覆盖）')


def api(path, data=None, method=None, tries=8):
    """带重试的请求。curl 退出码 6 = DNS 解析失败，是沙盒实例问题，重试即可。"""
    last = None
    for i in range(tries):
        try:
            r = urllib.request.Request(API + path, data=data, method=method)
            r.add_header('Authorization', 'Bearer ' + TOKEN)
            r.add_header('Accept', 'application/vnd.github+json')
            r.add_header('User-Agent', 'PAT_push')
            with urllib.request.urlopen(r, timeout=90) as resp:
                return json.loads(resp.read())
        except Exception as e:
            last = e
            # 偶发 403：GitHub 侧的瞬时拒绝，短暂等待后重试通常即可恢复，
            # 与限流(429)/鉴权失败(401)不同 —— 后者重试无意义，直接抛出。
            code = getattr(e, 'code', None)
            if code in (401, 403) and i >= tries - 2:
                raise
            time.sleep(2 + i * 2)
    raise last


def get_file(path, ref):
    """
    取指定 ref 下的文件内容。

    返回 None 表示**该版本不存在此文件** —— 这对新增文件是正常情况：
    以 PAT_SYNCED 为共同祖先做三方合并时，新文件在祖先里本就没有，
    若当成错误直接崩掉（实测 HTTP 404），新增文件就永远推不上去。
    """
    try:
        d = api('contents/%s?ref=%s' % (path, ref))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None
        raise
    return base64.b64decode(d['content']).decode('utf-8'), d['sha']


def three_way(ours_path, base_text, theirs_text, rel):
    """三方合并。base→ours 与 base→theirs 改动不重叠时自动合并，
    重叠则落冲突标记并报告。"""
    import subprocess, tempfile
    with tempfile.TemporaryDirectory() as td:
        o, b, t = (td + '/o', td + '/b', td + '/t')
        io.open(o, 'w', encoding='utf-8').write(io.open(ours_path, encoding='utf-8').read())
        io.open(b, 'w', encoding='utf-8').write(base_text)
        io.open(t, 'w', encoding='utf-8').write(theirs_text)
        p = subprocess.run(['git', 'merge-file', '-p', o, b, t],
                           capture_output=True, text=True)
        return p.stdout, (p.returncode != 0)


print('base   : %s' % BASE[:10])
print('已同步 : %s' % (OLD[:10] if OLD else '(未指定，将直接用本地版)'))
print('文件   : %d 个' % len(FILES))
print()

tree_entries = []
conflicts = []
identical = []

for rel in FILES:
    local_path = os.path.join(ROOT, rel)
    if not os.path.exists(local_path):
        print('  ✗ %-44s 本地不存在' % rel.split('/')[-1]); conflicts.append(rel); continue
    theirs, _ = get_file(rel, BASE)
    ours = io.open(local_path, encoding='utf-8').read()

    if OLD:
        old_text, _ = get_file(rel, OLD)
        if old_text is None:
            # 共同祖先里没这个文件 —— 本次是新增。
            # 远端若也同时新增了同名文件，按远端优先（避免覆盖他人刚建的文件）；
            # 否则直接用本地版。
            if theirs is not None:
                final, bad = theirs, False
                tag = '远端也已存在，保留远端'
                if final == theirs:
                    print('  · %-44s 远端已存在同名文件' % rel.split('/')[-1])
                    identical.append(rel); continue
            else:
                final, bad = ours, False
                tag = '新增文件'
        elif theirs is None:
            # 远端把它删了而本地还在改 —— 不擅自复活，交给人工判断
            print('  ✗ %-44s 远端已删除此文件' % rel.split('/')[-1])
            conflicts.append(rel); continue
        elif theirs == old_text:
            # 期间无人改动 → 本地版即最终版
            final, bad = ours, False
            tag = '期间无人改动'
        elif ours == old_text:
            # 本地没改，只有远端改了 → 采用远端
            final, bad = theirs, False
            tag = '本地未改，用远端'
        else:
            final, bad = three_way(local_path, old_text, theirs, rel)
            tag = '三方合并'
    else:
        final, bad = ours, False
        tag = '直接采用本地'

    if bad:
        print('  ✗ %-44s 冲突，需人工' % rel.split('/')[-1]); conflicts.append(rel); continue
    if final == theirs:
        print('  · %-44s 与远端一致，跳过 (%s)' % (rel.split('/')[-1], tag))
        identical.append(rel); continue

    blob = api('git/blobs', data=json.dumps(
        {'content': final, 'encoding': 'utf-8'}).encode(), method='POST')
    tree_entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    # theirs 为 None 表示远端还没有这个文件（新增）—— 打印进度时必须处理，
    # 否则 the**irs.count() 直接 AttributeError，新增文件永远推不上去。
    before = 0 if theirs is None else theirs.count('\n') + 1
    print('  ✓ %-44s %s  %s%d行 → 提交%d行' % (
        rel.split('/')[-1], tag, '新增' if theirs is None else '远端',
        before, final.count('\n') + 1))

if conflicts:
    sys.exit('\n有 %d 个文件冲突，未推送。' % len(conflicts))
if not tree_entries:
    sys.exit('\n没有需要提交的内容。')

# 建 tree（base=远端最新，只替换指定路径，其余不动）
tree = api('git/trees', data=json.dumps(
    {'base_tree': BASE, 'tree': tree_entries}).encode(), method='POST')
commit = api('git/commits', data=json.dumps(
    {'message': MSG, 'tree': tree['sha'], 'parents': [BASE]}).encode(), method='POST')

# 更新 ref：带 base sha 做乐观锁，期间有人先推则失败而非覆盖
r = urllib.request.Request(API + 'git/refs/heads/main',
                           data=json.dumps({'sha': commit['sha'], 'force': False}).encode(),
                           method='PATCH')
r.add_header('Authorization', 'Bearer ' + TOKEN)
r.add_header('Accept', 'application/vnd.github+json')
r.add_header('User-Agent', 'PAT_push')
try:
    with urllib.request.urlopen(r, timeout=90) as resp:
        json.loads(resp.read())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    if 'not a fast forward' in body or e.code in (409, 422):
        sys.exit('\n✗ 期间远端已前进（非快进/父提交过期）。请重取最新 sha 填 PAT_BASE 后重试。')
    sys.exit('\n✗ 更新 ref 失败 HTTP %s: %s' % (e.code, body[:200]))

print('\n✅ 已推送 %s (%d 个文件)' % (commit['sha'][:10], len(tree_entries)))
