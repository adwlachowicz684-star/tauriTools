#!/usr/bin/env python3
"""v4 审查报告修复项的回归（批次 0 + 批次 1）。

重点覆盖 P0-10 —— 报告最有价值的发现：
「pull 远端无变化分支不刷新基线」这一个根因，同时导致
  · direct 模式死锁（用户按提示 --pull 也走不通）
  · PR 模式静默回退主干（比死锁更糟：没人知道）
补一行基线刷新，两个 P0 同时消失。

用法：python3 test_v4_fixes.py <push_api.py 路径>
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, "/data/workspace")
import test_pr_flow as T
from test_pr_flow import GH, main_file, run, setup_repo, write

ROOT, STATE = T.ROOT, T.STATE
RES = []


def ck(name, ok, extra=""):
    RES.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {extra}")


def fresh(files=None):
    files = files or {"a.txt": ("100644", b"v1\n")}
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".tmp", ".corrupt", ".lock"):
        T.remove_any(STATE + ext)
    setup_repo(files)
    gh = GH(files)
    run(T._MOD, gh, ["--init-baseline", "--yes"])
    return gh


def _drop_baseline(rel):
    """删掉某个文件的基线记录，制造「基线缺失」场景。"""
    import json
    st = json.load(open(STATE))
    (st.get("files") or {}).pop(rel, None)
    json.dump(st, open(STATE, "w"))
    return st


# ================================================== P0-10

def pull_fills_baseline_gap(mod, label):
    """核心：pull 走「远端无变化」分支后，基线缺口必须被补上。

    这是 P0-9/P0-10 的共同根因。补不上就有两个后果：
    direct 死锁、PR 静默回退。
    """
    gh = fresh()
    write("a.txt", "MY-CHANGE\n")            # 本地改动
    _drop_baseline("a.txt")                  # 基线缺失
    run(mod, gh, ["--pull", "--yes"], name="fill")

    import json
    st = json.load(open(STATE))
    rec = (st.get("files") or {}).get("a.txt")
    print(f"\n=== {label} ===")
    ck("基线缺口已补上", rec is not None, f"(记录={rec})")
    return rec is not None


def direct_mode_no_deadlock(mod, label):
    """direct 模式：基线缺失 → 被拦 → --pull → 再推，必须能走通。

    修复前：--pull 走同一分支不刷新基线 → 再推再拦 → 无限循环，
    用户严格按提示操作也走不通。
    """
    gh = fresh()
    write("a.txt", "v2-mine\n")            # 本地改
    _drop_baseline("a.txt")                 # 基线缺失
    # 远端**不变**：这样 base 只能回退到 git HEAD(=v1)，恰好等于 remote，
    # pull 才会走进「远端无变化」那一支 —— 那正是缺陷所在的那一行。
    # （若远端也改了同一行，那是真冲突，被拦下是正确行为，测不到死锁。）

    out1, e1 = run(mod, gh, ["--direct", "--yes", "-m", "x1"], name="try1")
    blocked = ("基线" in out1 and "未记录" in out1) or e1 is not None \
        or "没有待推送" not in out1 and "已推送" not in out1

    run(mod, gh, ["--pull", "--yes"], name="pull")
    out2, e2 = run(mod, gh, ["--direct", "--yes", "-m", "x2"], name="try2")

    final = main_file(gh, "a.txt") or ""
    print(f"\n=== {label} ===")
    ck("第一次被拦（基线缺失）", blocked)
    ck("--pull 后再推成功", e2 is None and "v2-mine" in final,
       f"(远端={final[:20]!r} err={str(e2)[:30]})")
    return blocked and e2 is None and "v2-mine" in final


def pr_mode_no_silent_revert(mod, label):
    """PR 模式：基线缺失 + 本地落后 → 不得被当成「本地改过」而放行。

    修复前 _local_matches_baseline 返回保守的 False，被读成「本地改过」
    → 归入 overlap 无条件放行 → 本地旧内容整文件覆盖主干，静默回退。
    """
    gh = fresh()
    # 本地不动（保持 v1），远端前进到 v2-remote
    T.other_commit(gh, {"a.txt": b"v2-remote\n"})
    _drop_baseline("a.txt")

    out, err = run(mod, gh, ["--yes", "-m", "x"], name="revert")
    final = main_file(gh, "a.txt") or ""

    print(f"\n=== {label} ===")
    # 主干应保留远端改动 v2-remote，不该被回退成 v1
    ck("主干未被回退", "v2-remote" in final, f"(主干={final[:24]!r})")
    # 文案不定：可能被 P0-1（本地副本落后）先拦下，也可能命中新的
    # unrecorded 分类。两者都是「不放行」，所以只断言**没被静默放行**。
    mentioned = ("基线" in out or "回退" in out or err is not None)
    ck("有明确拦下或警告（非静默）", mentioned, f"(err={str(err)[:34]})")
    return "v2-remote" in final and mentioned


# ================================================== P0-5

def preview_counts_deletions(mod, label):
    """preview 的删除行数不能恒为 0（生成器被耗尽）。

    这是推送前最后一道人工确认，展示失真 = 确认无效。
    """
    gh = fresh()
    old = "".join(f"line{i}\n" for i in range(30))
    write("a.txt", old)
    run(mod, gh, ["--yes", "-m", "seed"], name="seed")
    write("a.txt", "only-one\n")            # 删掉 29 行
    out, err = run(mod, gh, ["--dry-run", "-m", "x"], name="prev")

    import re
    m = re.search(r"\+(\d+) / -(\d+)", out)
    add, sub = (int(m.group(1)), int(m.group(2))) if m else (-1, -1)
    print(f"\n=== {label} ===")
    ck("预览显示 +N / -M", m is not None, f"(解析到 {add}/{sub})")
    ck("删除行数 > 0（不再恒 0）", sub > 0, f"(-{sub})")
    return m is not None and sub > 0


# ================================================== P0-4

def symlink_non_utf8_no_crash(mod, label):
    """symlink 目标含非 UTF-8 字节时不得崩溃。"""
    fresh()
    bad = b"bad\xff\xfetarget"
    lp = os.path.join(ROOT.encode(), b"badlink")
    os.symlink(bad, lp)
    print(f"\n=== {label} ===")
    try:
        sha = mod.local_blob_sha("badlink")
        ok = bool(sha) and len(sha) == 40
    except Exception as e:
        ok = False
        print(f"      💥 {type(e).__name__}: {e}")
        sha = None
    ck("取 symlink blob sha 不崩", ok, f"(sha={str(sha)[:12]})")
    return ok


# ================================================== P0-6 / P0-7

def delete_main_rejected(mod, label):
    """--delete-branch 不得删主干。"""
    gh = fresh()
    out, err = run(mod, gh, ["--delete-branch", "main", "--yes"], name="delmain")
    print(f"\n=== {label} ===")
    ck("拒绝删除主干", "拒绝删除主干" in str(err), f"→ {str(err)[:40]}")
    return "拒绝删除主干" in str(err)


def close_pr_main_rejected(mod, label):
    """close_pr() 同样不得作用于主干（本函数末尾会删分支）。

    CLI 上 --close-pr 不接分支名（取 state.task_branch），所以 -b main
    那道闸先拦住了。这里直接调函数验证**第二道闸**确实存在。
    """
    import json
    fresh()
    st = json.load(open(STATE))
    print(f"\n=== {label} ===")
    try:
        mod.close_pr(st, "main", yes=True)
        ok = False
        msg = "(未抛异常)"
    except SystemExit as e:
        ok = "拒绝" in str(e)
        msg = str(e)[:40]
    ck("拒绝关闭/删除主干", ok, f"→ {msg}")
    return ok


def branch_main_rejected(mod, label):
    """-b main 不得绕过 PR 流程直推主干。"""
    gh = fresh()
    write("a.txt", "v2\n")
    out, err = run(mod, gh, ["--yes", "-b", "main", "-m", "x"], name="bmain")
    print(f"\n=== {label} ===")
    ck("拒绝用主干当任务分支", "不能用主干" in str(err), f"→ {str(err)[:40]}")
    return "不能用主干" in str(err)


# ================================================== P0-11

def dry_run_blocks_mutating_subcommands(mod, label):
    """--dry-run 不得执行会改动远端/本地的子命令。"""
    print(f"\n=== {label} ===")
    cases = [
        (["--dry-run", "--delete-branch", "task/x", "--yes"], False),
        (["--dry-run", "--merge", "--yes"], False),
        (["--dry-run", "--pull", "--yes"], False),
        (["--dry-run", "--init-baseline", "--yes"], False),
        (["--dry-run", "--reset-baseline", "--yes"], False),
    ]
    ok = True
    for argv, _ in cases:
        gh = fresh()
        if "task/x" in argv:
            gh.refs["task/x"] = "c" + "0" * 39
        before = dict(gh.refs)
        out, err = run(mod, gh, argv, name="dry")
        rejected = err is not None and "--dry-run" in str(err)
        unchanged = (dict(gh.refs) == before)
        good = rejected and unchanged
        ok = ok and good
        ck(f"{' '.join(a for a in argv if a != '--yes')}",
           good, f"(拒绝={rejected} 远端未变={unchanged})")
    return ok


def dry_run_still_allows_readonly(mod, label):
    """--dry-run 对只读子命令（--status / --prune）仍应放行。"""
    gh = fresh()
    out, err = run(mod, gh, ["--dry-run", "--status"], name="status")
    ok1 = err is None or "不能同时使用" not in str(err)
    out2, err2 = run(mod, gh, ["--dry-run", "--prune"], name="prune")
    ok2 = err2 is None or "不能同时使用" not in str(err2)
    print(f"\n=== {label} ===")
    ck("--dry-run --status 可用", ok1, f"→ {str(err)[:30]}")
    ck("--dry-run --prune 可用", ok2, f"→ {str(err2)[:30]}")
    return ok1 and ok2


# ================================================== P1-18 / P1-20 / P1-21

def save_state_surrogate_no_traceback(mod, label):
    """P1-18：状态里含 surrogate 路径时，save_state 必须友好报错。

    UnicodeEncodeError 是 **ValueError 子类**，不是 OSError，
    只 except OSError 会让它穿透成裸 traceback —— 而崩溃点在
    推送**之后**，用户刚看到“推送成功”就撞上 traceback。
    """
    print(f"\n=== {label} ===")
    st = {"files": {"bad\udcff.txt": {"mode": "100644", "sha": "a" * 40}}}
    try:
        mod.STATE_PATH = STATE
        mod.save_state(st)
        ok, msg = False, "(未抛异常)"
    except SystemExit as e:
        msg = str(e)
        ok = "基线序列化失败" in msg and "Traceback" not in msg
    except Exception as e:
        ok, msg = False, f"💥{type(e).__name__}: {e}"
    ck("surrogate 路径友好报错", ok, f"→ {msg.splitlines()[0][:46]}")
    return ok


def conflict_blocks_only_pushed_files(mod, label):
    """P1-20：冲突只拦**本次要推**的文件，不阻塞其它文件。"""
    gh = fresh({"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"v1\n")})
    # 制造 a.txt 冲突
    write("a.txt", "mine\n")
    T.other_commit(gh, {"a.txt": b"remote\n"})
    run(mod, gh, ["--pull", "--yes"], name="cf")
    import json
    st = json.load(open(STATE))
    has_conflict = "a.txt" in (st.get("conflicts") or [])
    write("b.txt", "b-mine\n")            # 另一个文件正常改动

    # 显式点名 b.txt → 应当放行。
    # 需要 --force-overwrite：pull 冲突后 synced_commit 不刷新，P0-1 会
    # 先拦下（那是**正确**行为，与 P1-20 无关）。这里要验的是「冲突拦截
    # 不再全局阻塞」，所以先绕开 P0-1 才能看到修复效果。
    out, err = run(mod, gh, ["--yes", "--force-overwrite", "b.txt", "-m", "x"],
                   name="onlyb")
    pushed_b = (main_file(gh, "b.txt") or "") == "b-mine\n"
    blocked_by_conflict = err is not None and "冲突" in str(err)
    print(f"\n=== {label} ===")
    ck("a.txt 确实冲突", has_conflict)
    ck("点名 b.txt 不被 a.txt 冲突阻塞", not blocked_by_conflict,
       f"→ {str(err)[:40]}")
    ck("b.txt 改动已推上主干", pushed_b, f"→ {main_file(gh, 'b.txt')!r}")
    return has_conflict and not blocked_by_conflict and pushed_b


def conflict_still_blocks_itself(mod, label):
    """边界：点名冲突文件本身时，仍然必须拦下。"""
    gh = fresh({"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"v1\n")})
    write("a.txt", "mine\n")
    T.other_commit(gh, {"a.txt": b"remote\n"})
    run(mod, gh, ["--pull", "--yes"], name="cf2")
    out, err = run(mod, gh, ["--yes", "a.txt", "-m", "x"], name="onlya")
    print(f"\n=== {label} ===")
    ck("点名冲突文件仍被拦", err is not None and "冲突" in str(err),
       f"→ {str(err)[:44]}")
    return err is not None and "冲突" in str(err)


def symlink_target_escape_rejected(mod, label):
    """P1-21：远端给出的 symlink 目标不得越出仓库。

    safe_rel() 只防了**读取**侧，写侧（_write_local）原来完全不校验，
    同一份代码里不对称。
    """
    print(f"\n=== {label} ===")
    bad_abs = b"/etc/passwd"
    bad_rel = b"../../etc/passwd"
    ok = True
    for tgt in (bad_abs, bad_rel):
        T._rmtree_stubborn(ROOT)
        setup_repo({"k.txt": ("100644", b"k\n")})
        try:
            mod.ROOT = ROOT
            mod._write_local("s", tgt, "120000")
            rejected = False
            msg = "(未拒绝)"
        except SystemExit as e:
            rejected = True
            msg = str(e).splitlines()[0][:40]
        except Exception as e:
            rejected, msg = False, f"💥{type(e).__name__}"
        ok = ok and rejected
        ck(f"拒绝 {tgt!r}", rejected, f"→ {msg}")

    # 合法的仓库内软链必须放行
    T._rmtree_stubborn(ROOT)
    setup_repo({"k.txt": ("100644", b"k\n")})
    try:
        mod.ROOT = ROOT
        mod._write_local("s2", b"k.txt", "120000")
        good = os.path.islink(os.path.join(ROOT, "s2"))
    except Exception as e:
        good, _ = False, str(e)
    ck("仓库内软链正常创建", good)
    return ok and good


# ================================================== P0-3 / P2-22~26

def blob_sha_matches_uploaded_bytes(mod, label):
    """P0-3：sha 必须等于**实际上传字节**的哈希。

    .gitattributes 配了 eol/text 时，`git hash-object <路径>` 会应用
    clean filter 算出「归一化的 LF」的 sha，而脚本上传的是工作区原始
    字节（CRLF）—— 两者不一致，下次推送永久误报「远端被他人改动」。
    """
    import hashlib
    import subprocess
    d = os.path.join(ROOT, "a.txt")
    payload = b"hello\r\nworld\r\n"
    T._rmtree_stubborn(ROOT)
    setup_repo({"k.txt": ("100644", b"k\n")})
    with open(os.path.join(ROOT, ".gitattributes"), "wb") as f:
        f.write(b"* text=auto eol=crlf\n")
    with open(d, "wb") as f:
        f.write(payload)
    subprocess.run(["git", "-C", ROOT, "add", "-A"], capture_output=True)
    subprocess.run(["git", "-C", ROOT, "-c", "user.email=a@b.c",
                    "-c", "user.name=a", "commit", "-qm", "x"],
                   capture_output=True)

    mod.ROOT = ROOT
    got = mod.local_blob_sha("a.txt")
    want = hashlib.sha1(b"blob %d\0" % len(payload) + payload).hexdigest()
    # 旧行为（应用 filter）应该给出**不同**的值，用来确认场景真的生效了
    filtered = subprocess.run(["git", "-C", ROOT, "hash-object", "a.txt"],
                              capture_output=True, text=True).stdout.strip()
    print(f"\n=== {label} ===")
    ck("场景生效（filter 确实改变了内容）", filtered != want,
       f"(filtered={filtered[:8]} raw={want[:8]})")
    ck("sha == 上传字节的哈希", got == want, f"({got[:8]} vs {want[:8]})")
    return filtered != want and got == want


def days_since_negative_offset(mod, label):
    """P2-24：负时区偏移也要能剥掉。

    原来只 split("+")，遇到 -05:00 会解析失败返回 None →
    该分支静默归入「无需处理」，--prune 就不报它了。
    """
    import time as _t
    now = _t.time()
    print(f"\n=== {label} ===")
    ok = True
    for off in ("+05:00", "-05:00", "-0500", "+00:00"):
        v = _t.strftime("%Y-%m-%dT%H:%M:%S" + off, _t.gmtime(now - 4 * 86400))
        d = mod._days_since(v)
        good = d is not None and abs(d - 4) < 0.1
        ok = ok and good
        ck(f"偏移 {off} 解析正确", good, f"(→ {d if d is None else round(d, 2)})")
    # 负天数（本地时钟慢）也不该恒 False 地绕过
    v = _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime(now + 2 * 86400))
    d2 = mod._days_since(v)
    ck("未来时间戳返回负数（不静默归零）", d2 is not None and d2 < 0,
       f"(→ {d2 if d2 is None else round(d2, 2)})")
    return ok and d2 is not None and d2 < 0


def help_and_state_args_exist(mod, label):
    """P2-25：必须有 --help；P2-22：报错建议的 --state 必须真的存在。"""
    import subprocess
    print(f"\n=== {label} ===")
    r = subprocess.run([sys.executable, mod.__file__, "--help"],
                       capture_output=True, text=True)
    ok1 = r.returncode == 0 and "用法" in (r.stdout or "")
    ck("--help 可用且打印用法", ok1, f"(rc={r.returncode})")

    src = open(mod.__file__, encoding="utf-8").read()
    ok2 = '"--state"' in src
    ck("--state 参数存在（报错里建议它）", ok2)
    return ok1 and ok2


def state_arg_changes_path(mod, label):
    """--state 必须真的作用到全局 STATE_PATH（在任何读写之前）。

    不跑子进程：真实命令会碰网络。这里验的是「参数有没有作用到全局」
    这一步，已在脚本里抽成 _apply_state_path() 便于直接测。
    """
    import tempfile
    alt = os.path.join(tempfile.mkdtemp(), "alt-baseline.json")
    print(f"\n=== {label} ===")
    opts, _ = mod.parse_args(["--state", alt, "--init-baseline"])
    ok_parse = opts.get("state_path") == alt
    ck("--state 被正确解析", ok_parse, f"→ {opts.get('state_path')}")

    saved = mod.STATE_PATH
    try:
        mod._apply_state_path(opts)
        ok_apply = mod.STATE_PATH == os.path.abspath(alt)
    finally:
        mod.STATE_PATH = saved          # 还原，别影响后续用例
    ck("全局 STATE_PATH 被替换", ok_apply, f"→ {mod.STATE_PATH}")
    return ok_parse and ok_apply


def branch_name_url_encoded(mod, label):
    """P2-23：分支名进 API 路径必须编码，但 `/` 要保留。

    safe="" 会把 task/2026 编成 task%2F2026，所有任务分支 404 ——
    第一版就犯了这个错，10 套测试当场变红。
    """
    print(f"\n=== {label} ===")
    p1 = mod._ref_path("task/2026-01-01-abcd")
    ck("分支名里的 / 保留（不编码）", "/" in p1.replace("/git/refs/heads/", ""),
       f"→ {p1}")
    p2 = mod._ref_path("task/we?ird#name")
    ck("特殊字符被编码", "?" not in p2 and "#" not in p2, f"→ {p2}")
    return "/" in p1.replace("/git/refs/heads/", "") and "?" not in p2


# ================================================== 报告后半部分（6.3 之后）

def find_pr_prefers_open(mod, label):
    """P1-19：同名分支复用时，find_pr 不能返回已合并的旧 PR。

    返回第一个匹配 → 拿到早已合并的历史 PR → merged_at 为空
    → 报「未合并，删除会丢改动」，方向恰好反了。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    calls = []
    real = gh.api

    def fake(method, path, *a, **k):
        r = real(method, path, *a, **k)
        if method == "GET" and "/pulls?" in str(path):
            calls.append(path)
        return r

    gh.api = fake
    try:
        mod.api = gh.api
        # 造两条：第一条已合并（旧），第二条开启中
        gh.pulls = [
            {"number": 1, "state": "closed", "merged": True,
             "head": {"ref": "task/x"}},
            {"number": 2, "state": "open", "merged": False,
             "head": {"ref": "task/x"}},
        ]
        # find_pr 走 api()，而 api 已被包装；直接测过滤逻辑需要注入到 mod
        saved = mod.api
        def fake_api(method, path, payload=None, **k):
            if method == "GET" and "/pulls?" in str(path):
                return gh.pulls
            return saved(method, path, payload, **k)
        mod.api = fake_api
        got = mod.find_pr("task/x")
        ok = got is not None and got.get("number") == 2
        ck("返回开启中的 PR（非已合并的旧 PR）", ok,
           f"(拿到 #{got.get('number') if got else None})")
    finally:
        gh.api = real
        mod.api = T._MOD.api
    return ok


def write_local_resets_exec_bit(mod, label):
    """P1-13：写非执行文件必须回退权限位。

    否则远端「可执行 → 不可执行」的变更永远同步不完：本地文件仍是
    0755，local_state_map 算出 100755 ≠ 远端 100644 → 每次 pull 都重写。
    """
    import stat as _st
    T._rmtree_stubborn(ROOT)
    setup_repo({"k.txt": ("100644", b"k\n")})
    p = os.path.join(ROOT, "s.sh")
    mod.ROOT = ROOT
    mod._write_local("s.sh", b"#!/bin/sh\n", "100755")
    m1 = _st.S_IMODE(os.stat(p).st_mode)
    ok1 = bool(m1 & 0o111)
    ck("可执行位已设置", ok1, f"({oct(m1)})")

    mod._write_local("s.sh", b"# just a text\n", "100644")
    m2 = _st.S_IMODE(os.stat(p).st_mode)
    ok2 = not (m2 & 0o111)
    ck("改为非执行后权限位已回退", ok2, f"({oct(m2)})")
    return ok1 and ok2


def clock_skew_surfaced(mod, label):
    """P1-17：合并时间落在未来（本地时钟慢）必须显形。

    报告建议 max(0.0, d)，但那治标不治本：max 之后 d=0，
    `0 >= grace_days` 依然 False，陈旧分支照样不报 —— 只是把
    「负值」这个信号抹掉了，看起来像「刚合并、无需处理」，反而更静默。
    """
    print(f"\n=== {label} ===")
    d = mod._days_since("2099-01-01T00:00:00Z")
    ok1 = d is not None and d < 0
    ck("未来时间戳返回负值（信号保留）", ok1, f"(→ {d if d is None else round(d,1)})")

    # --prune 必须把它说出来
    gh = fresh()
    gh.refs["task/old"] = "c" + "0" * 39
    # 假服务端的 prs 是 **dict**（number → pr），不是 list
    gh.prs[7] = {"number": 7, "state": "closed", "merged": True,
                 "merged_at": "2099-01-01T00:00:00Z",
                 "updated_at": "2099-01-01T00:00:00Z",
                 "head": {"ref": "task/old"}}
    out, err = run(mod, gh, ["--prune"], name="skew")
    ok2 = "时钟不一致" in out
    ck("--prune 提示时钟不一致", ok2, f"→ {out.strip()[-60:]}")
    return ok1 and ok2


def resolve_rejects_non_conflict(mod, label):
    """P1-4：--resolve 一个从没冲突过的文件必须拒绝。

    resolve 的副作用是刷 synced_commit（= 声明「本地已含远端最新」），
    对无关文件做这个声明等于无凭无据解除 P0-1 闸门。
    """
    print(f"\n=== {label} ===")
    fresh()
    import json
    st = json.load(open(STATE))
    try:
        mod.resolve(st, "a.txt", head_sha=None, rstate=None)
        ok, msg = False, "(未拒绝)"
    except SystemExit as e:
        ok, msg = True, str(e).splitlines()[0][:40]
    ck("拒绝 --resolve 非冲突文件", ok, f"→ {msg}")
    return ok


def git_reset_detected(mod, label):
    """§7.4 推论（报告未展开）：git reset --hard 后的静默回退路径。

    synced_commit 只证明「上次同步时本地含远端全部改动」，
    证明不了「现在还是」。实测：push v3 → reset 回 v2 → push
    → P0-1 放行、第一层放行 → v3 静默消失。
    """
    import subprocess
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    run(mod, gh, ["--yes", "-m", "v2"], name="p2")
    write("a.txt", "v3\n")
    run(mod, gh, ["--yes", "-m", "v3"], name="p3")
    before = main_file(gh, "a.txt")

    subprocess.run(["git", "-C", ROOT, "reset", "--hard", "HEAD~1"],
                   capture_output=True)
    after_reset = open(os.path.join(ROOT, "a.txt")).read()
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="after-reset")
    final = main_file(gh, "a.txt")

    ck("reset 确实让本地回到旧版本", after_reset == "v2\n", f"({after_reset!r})")
    ck("推送被拦下（主干未被回退）", final == before,
       f"(主干 {before!r} → {final!r})")
    ck("提示了 HEAD 回退", "回退" in out or "分叉" in out)
    return after_reset == "v2\n" and final == before


# ================================================== P1-1：权威字段判据

def merge_uses_mergeable_state(mod, label):
    """P1-1：合并被拒的原因必须由 mergeable_state 判定，不是字符串匹配。

    关键场景：dirty（内容冲突）与 behind（分支不够新）返回**同一个** 409，
    但处理完全不同。字符串匹配会在措辞变化时误判，权威字段不会。
    """
    print(f"\n=== {label} ===")
    ok = True

    # A. dirty → conflict
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "mine\n")
    T.other_commit(gh, {"a.txt": b"remote\n"})
    # 造一个已存在的 PR，并强制 mergeable_state = dirty
    gh.refs["task/c1"] = gh.refs["main"]
    gh.prs[11] = {"number": 11, "state": "open", "merged": False,
                  "merged_at": None, "updated_at": "2026-01-01T00:00:00Z",
                  "head": {"ref": "task/c1"}, "base": {"ref": "main"}}
    gh.mergeable_override = {11: (False, "dirty")}
    # 让 PUT merge 抛 409（内容无关，只看判据）
    real = gh.api

    def fake409(method, path, *a, **k):
        if method == "PUT" and path.endswith("/merge"):
            raise SystemExit("API PUT /pulls/11/merge → HTTP 409: "
                             "some message with no recognisable words")
        return real(method, path, *a, **k)

    gh.api = fake409
    mod.api = gh.api
    try:
        r, st = mod.merge_pr(11)
    finally:
        gh.api = real
    ck("dirty → conflict（不靠字符串）", st == "conflict" and r is None,
       f"(状态={st})")
    ok = ok and st == "conflict"

    # B. behind → need_update
    gh2 = fresh()
    gh2.prs[12] = {"number": 12, "state": "open", "merged": False,
                   "merged_at": None, "updated_at": "2026-01-01T00:00:00Z",
                   "head": {"ref": "task/c2"}, "base": {"ref": "main"}}
    gh2.mergeable_override = {12: (True, "behind")}
    real2 = gh2.api

    def fake409b(method, path, *a, **k):
        if method == "PUT" and path.endswith("/merge"):
            raise SystemExit("API PUT /pulls/12/merge → HTTP 409: "
                             "some message with no recognisable words")
        return real2(method, path, *a, **k)

    gh2.api = fake409b
    mod.api = gh2.api
    try:
        r2, st2 = mod.merge_pr(12)
    finally:
        gh2.api = real2
        mod.api = T._MOD.api
    ck("behind → need_update（不靠字符串）", st2 == "need_update" and r2 is None,
       f"(状态={st2})")
    return ok and st2 == "need_update"


def mergeable_null_polls(mod, label):
    """边界：mergeable 首次返回 None（异步未算出）时必须轮询，不能当冲突。

    None 是「还没算出来」，不是「不能合并」。当成 falsy 一律判 conflict
    会把「分支不够新」也误伤。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    gh.prs[13] = {"number": 13, "state": "open", "merged": False,
                  "merged_at": None, "updated_at": "2026-01-01T00:00:00Z",
                  "head": {"ref": "task/c3"}, "base": {"ref": "main"}}
    # 第一次 None，之后给出 behind
    seq = [(None, None), (True, "behind")]
    calls = {"n": 0}

    real = gh.api

    def fake(method, path, *a, **k):
        if method == "GET" and path.split("?")[0] == "/pulls/13":
            i = min(calls["n"], len(seq) - 1)
            calls["n"] += 1
            pr = dict(gh.prs[13])
            pr["mergeable"], pr["mergeable_state"] = seq[i]
            return pr
        return real(method, path, *a, **k)

    gh.api = fake
    mod.api = fake
    try:
        got, st = mod._pr_mergeability(13)
    finally:
        gh.api = real
        mod.api = T._MOD.api
    ok = got is True and st == "behind" and calls["n"] >= 2
    ck("轮询直到算出结果", ok, f"(拿到 {got}/{st}，查询 {calls['n']} 次)")
    return ok


# ================================================== 补充描述批次（P1/P2/P3）

def git_broken_not_silent_no_changes(mod, label):
    """P1-5：git 不可用时不得伪装成「本地没有待推送的改动」。

    实测（--direct）：移走 .git → detect_changes=[]、lmap={}
    → 打印「没有待推送的改动」→ 用户改动静默未推，且看起来像成功。
    """
    import subprocess
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "mine-CHANGED\n")
    subprocess.run(["mv", os.path.join(ROOT, ".git"), "/tmp/_mg"], check=True)
    try:
        out, err = run(mod, gh, ["--direct", "--yes", "-m", "x"], name="nogit")
    finally:
        subprocess.run(["mv", "/tmp/_mg", os.path.join(ROOT, ".git")], check=True)
    msg = str(err or "")
    ok1 = "没有待推送的改动" not in out
    ok2 = "读不到仓库" in msg or "不是 git 仓库" in msg
    ck("未伪装成「没有改动」", ok1, f"→ {msg[:40]}")
    ck("指出是 git 不可用", ok2)
    return ok1 and ok2


def remote_fetch_failure_not_conflict(mod, label):
    """P1-10：_remote_bytes 失败不得进入 conflicts。

    冲突 = 拿到了但合不上（做过了）；拉取失败 = 没拿到（没做成）。
    混为一类会让 conflicts 失去语义，且逼用户对网络抖动做「冲突解决」。
    """
    import json
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "mine\n")
    T.other_commit(gh, {"a.txt": b"remote\n"})
    real = gh.api

    def fake(method, path, *a, **k):
        if method == "GET" and "/git/blobs/" in str(path):
            raise SystemExit("API GET → HTTP 503: 模拟限流")
        return real(method, path, *a, **k)

    gh.api = fake
    mod.api = fake
    try:
        out, err = run(mod, gh, ["--pull", "--yes"], name="fetchfail")
    finally:
        gh.api = real
        mod.api = T._MOD.api
    st = json.load(open(STATE))
    ok1 = not (st.get("conflicts") or [])
    ok2 = "拉取失败" in out
    ck("未污染 conflicts", ok1, f"→ {st.get('conflicts')}")
    ck("提示为「拉取失败」而非冲突", ok2)
    return ok1 and ok2


def symlink_preview_no_fake_diff(mod, label):
    """P1-16：symlink 内容未变时预览不得显示 +1/-1。

    "_local_lines" 曾加 "-> " 前缀，而远端 blob 存的是目标路径本身，
    于是两边恒差一个前缀 —— 预览层失真。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"k.txt": ("100644", b"k\n")})
    os.symlink("/usr/bin/node", os.path.join(ROOT, "s"))
    mod.ROOT = ROOT
    local = mod._local_lines("s", "120000")
    remote = ["/usr/bin/node"]            # 远端 symlink blob 的内容
    ok = local == remote
    ck("本地行 == 远端行（无伪造差异）", ok, f"→ {local} vs {remote}")
    return ok


def list_endpoints_paginate(mod, label):
    """P1-12：列表接口必须翻页，超过 100 条不得静默截断。

    对 --prune 尤其危险：漏报会给出「很干净」的错误安全感。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    # 造 150 条分支，分两页返回
    names = [f"task/b{i}" for i in range(150)]
    for nm in names:
        gh.refs[nm] = "c" + "0" * 39
    real = gh.api
    seen = []

    def fake(method, path, *a, **k):
        if method == "GET" and "/branches?" in str(path):
            seen.append(path)
            pg = 1
            if "page=2" in path:
                pg = 2
            chunk = names[:100] if pg == 1 else names[100:]
            return [{"name": n} for n in chunk]
        return real(method, path, *a, **k)

    gh.api = fake
    mod.api = fake
    try:
        got = mod.list_branches()
    finally:
        gh.api = real
        mod.api = T._MOD.api
    ok = len(got) == 150 and any("page=2" in p for p in seen)
    ck("翻页取全（150 条）", ok, f"(拿到 {len(got)} 条，请求 {len(seen)} 次)")
    return ok


def ensure_pr_failure_keeps_branch_hint(mod, label):
    """P1-8：开 PR 失败时，分支有内容，必须告知不要 --delete-branch。

    否则 --prune 会把它判成孤儿分支并建议删除 —— 工具引导用户删掉
    自己刚推上去的东西。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    real = gh.api

    def fake(method, path, *a, **k):
        if method == "POST" and path.split("?")[0] == "/pulls":
            raise SystemExit("API POST /pulls → HTTP 422: 模拟开 PR 失败")
        return real(method, path, *a, **k)

    gh.api = fake
    mod.api = fake
    try:
        out, err = run(mod, gh, ["--yes", "-m", "x"], name="nopr")
    finally:
        gh.api = real
        mod.api = T._MOD.api
    blob = out + str(err or "")
    ok1 = "不要 --delete-branch" in blob
    ok2 = "--branch" in blob
    ck("提示不要删分支", ok1, f"→ {str(err)[:40]}")
    ck("给出 --branch 重试路径", ok2)
    return ok1 and ok2


def exec_bit_zero_samples_not_reliable(mod, label):
    """P2-19：零样本时不得宣称「可执行位探测可靠」。

    仓库里没有 .md/.txt/.json/.py/.yml 时 samples 为空，
    返回 True 会让整个仓库权限位被静默翻转。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"main.rs": ("100644", b"fn main() {}\n")})
    mod.ROOT = ROOT
    mod._EXEC_RELIABLE = None
    try:
        got = mod._exec_bit_reliable()
    except BaseException as e:
        got = f"💥{type(e).__name__}: {e}"
    ck("零样本返回 False", got is False, f"→ {got}")
    return got is False


def merge3_cleanup_error_hides_nothing(mod, label):
    """核查1③：_merge3 的 finally 里 unlink 失败不得掩盖合并异常。"""
    print(f"\n=== {label} ===")
    real_unlink = os.unlink

    def bad_unlink(p):
        raise OSError("模拟 unlink 失败")

    # 让临时文件清理失败，同时 merge-file 本身应正常返回冲突结果
    mod.ROOT = ROOT
    os.unlink = bad_unlink
    try:
        out, conflicted = mod._merge3(b"a\n", b"b\n", b"c\n")
        ok = True
        msg = "合并结果正常返回"
    except BaseException as e:
        ok, msg = False, f"💥{type(e).__name__}: {e}"
    finally:
        os.unlink = real_unlink
    ck("unlink 失败不影响合并结果", ok, f"→ {msg}")
    return ok


def version_bool_rejected(mod, label):
    """P3-2：version: true 不得通过校验（bool 是 int 子类）。"""
    import json
    print(f"\n=== {label} ===")
    st = {"version": True, "files": {}, "remote": "o/r"}
    p = STATE
    with open(p, "w") as f:
        json.dump(st, f)
    try:
        mod.STATE_PATH = p
        mod._load_state_strict()
        ok, msg = False, "(未拒绝)"
    except SystemExit as e:
        ok, msg = True, str(e).splitlines()[0][:44]
    ck("version: true 被拒绝", ok, f"→ {msg}")
    return ok


def reset_baseline_keeps_workflow(mod, label):
    """P3-8：--reset-baseline 不得把 --direct 用户静默改回 PR 工作流。"""
    import json
    print(f"\n=== {label} ===")
    gh = fresh()
    st = json.load(open(STATE))
    st["workflow"] = "direct"
    with open(STATE, "w") as f:
        json.dump(st, f)
    run(mod, gh, ["--reset-baseline", "--yes"], name="reset")
    st2 = json.load(open(STATE))
    ok = st2.get("workflow") == "direct"
    ck("workflow 保持 direct", ok, f"→ {st2.get('workflow')}")
    return ok


def dash_filename_supported(mod, label):
    """P3-4：以 - 开头的文件名可通过 `--` 分隔符作为推送目标。"""
    print(f"\n=== {label} ===")
    try:
        opts, rest = mod.parse_args(["--", "-leading-dash.txt"])
        ok, msg = rest == ["-leading-dash.txt"], f"→ {rest}"
    except SystemExit as e:
        # 未实现 -- 分隔符时会在这里抛「未知参数: --」，
        # 必须接住并转成 FAIL，否则整个套件被中断、报不出结果。
        ok, msg = False, f"→ 被拒绝：{str(e)[:40]}"
    ck("-- 之后的参数当路径", ok, msg)
    return ok


# ================================================== P2-16：非交互环境 EOF 保护

def eof_no_traceback_and_no_action(mod, label):
    """P2-16：无 TTY（CI / 管道）时不得裸 traceback，且**不得执行危险操作**。

    默认值必须取安全侧（""＝否）。默认"同意"的话，CI 里所有确认都会被
    静默放行 —— 那比崩溃危险得多。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    out, err = run(mod, gh, ["-m", "x"], name="eof", eof=True)
    ok1 = "Traceback" not in out
    ok2 = "非交互环境" in out
    ok3 = main_file(gh, "a.txt") == "v1\n"      # 未推送 = 安全侧
    ck("无裸 traceback", ok1)
    ck("提示非交互环境", ok2)
    ck("未执行推送（默认否）", ok3, f"(主干 {main_file(gh, 'a.txt')!r})")
    return ok1 and ok2 and ok3


def eof_leaves_no_orphan_branch(mod, label):
    """边界：EOF 取消后不得留僵尸分支（与 P0-1 的 _Cancel 通道一致）。"""
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    out, err = run(mod, gh, ["-m", "x"], name="eof2", eof=True)
    left = [b for b in gh.refs if b.startswith("task/")]
    ok = not left
    ck("无残留任务分支", ok, f"→ {left}")
    return ok


def eof_yes_still_works(mod, label):
    """边界：--yes 时不走 input，EOF 模拟不该影响正常推送。

    防止 safe_input 改造把「显式确认」的路径也一起废掉。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="eofyes", eof=True)
    ok = main_file(gh, "a.txt") == "v2\n"
    ck("--yes 下 EOF 不影响推送", ok, f"(主干 {main_file(gh, 'a.txt')!r})")
    return ok


def eof_merge_prompt_cancels(mod, label):
    """--merge 选 PR 号那处 input 也要受保护（列完 PR 才问，断了最可惜）。"""
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    # 造两个开启中的任务 PR，迫使脚本问「选哪个」
    gh.refs["task/x1"] = gh.refs["main"]
    gh.refs["task/x2"] = gh.refs["main"]
    gh.prs[101] = {"number": 101, "state": "open", "merged": False,
                   "merged_at": None, "updated_at": "2026-01-01T00:00:00Z",
                   "head": {"ref": "task/x1"}, "base": {"ref": "main"}}
    gh.prs[102] = {"number": 102, "state": "open", "merged": False,
                   "merged_at": None, "updated_at": "2026-01-01T00:00:00Z",
                   "head": {"ref": "task/x2"}, "base": {"ref": "main"}}
    out, err = run(mod, gh, ["--merge"], name="eofmerge", eof=True)
    ok1 = "Traceback" not in out
    ok2 = main_file(gh, "a.txt") == "v1\n"     # 未合并
    ck("无裸 traceback", ok1)
    ck("未擅自合并任何一个 PR", ok2, f"(主干 {main_file(gh, 'a.txt')!r})")
    return ok1 and ok2


# ================================================== P2-13 / P2-17

def main_new_file_not_lagging(mod, label):
    """P2-13：主干新增的文件不得被判成「本地落后」。

    否则刚合并成功 synced_commit 就被置 None，用户立刻被 P0-1 挡住，
    而提示的出路（--pull）没什么可拉的 —— 体验很差且无从下手。

    直接测 _refresh_main_baseline 本身：假服务端的 _merge_files 在
    「ours 为 None」时直接 continue，合并结果**不会**带上远端新增文件，
    走完整 --merge 流程根本构造不出这个场景（实测验证过）。
    """
    import json
    print(f"\n=== {label} ===")
    gh = fresh()
    # 远端新增 new.txt（本地 git 里没有）
    T.other_commit(gh, {"new.txt": b"brand new\n"})
    mod.ROOT, mod.api = ROOT, gh.api
    ok0 = "new.txt" in gh.files_of("main") and "new.txt" not in mod.local_state_map()
    ck("前置：远端有、本地无", ok0,
       f"→ 远端 {sorted(gh.files_of('main'))} / 本地 {sorted(mod.local_state_map())}")

    st = json.load(open(STATE))
    head = gh.refs["main"]
    lagging = mod._refresh_main_baseline(st, head)
    ok1 = "new.txt" not in (lagging or [])
    ok2 = st.get("synced_commit") == head
    ck("新增文件未进 lagging", ok1, f"→ lagging={lagging}")
    ck("synced_commit 未被清空", ok2,
       f"→ {str(st.get('synced_commit'))[:8]}")
    return ok0 and ok1 and ok2


def pull_rejects_out_of_tree_paths(mod, label):
    """P2-17：--pull 自动拉取的路径也要过 safe_rel。

    显式点名早就校验了，自动路径来自远端树却没校验 —— 纵深防御不该
    只做在用户输入的那一侧。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    # 用唯一名字：多轮测试共用 /tmp，上一轮的残留会让断言变成假阳性/假阴性
    marker = f"escape_{os.getpid()}_{int(time.time() * 1000) % 100000}.txt"
    outside = os.path.join(os.path.dirname(ROOT), marker)
    if os.path.exists(outside):
        os.unlink(outside)
    # 往远端塞一个越界路径
    T.other_commit(gh, {f"../{marker}": b"pwned\n"})
    out, err = run(mod, gh, ["--pull", "--yes"], name="escape")
    ok1 = not os.path.exists(outside)
    ok2 = "越界" in out
    ck("未写到仓库外", ok1, f"→ {outside} 存在={os.path.exists(outside)}")
    ck("提示了越界", ok2, f"→ {out.strip()[-60:]}")
    return ok1 and ok2


# ================================================== P2 第二批（20/21/15/14/05）

def direct_persists_workflow(mod, label):
    """P2-20：--direct 必须把 workflow 落盘。

    否则用户每次都得手动加参数；更糟的是 --reset-baseline 之后会被
    静默改回 PR 工作流（旧版把 workflow 写死默认值）。
    """
    import json
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    run(mod, gh, ["--direct", "--yes", "-m", "x"], name="direct")
    st = json.load(open(STATE))
    ok = st.get("workflow") == "direct"
    ck("workflow 已落盘为 direct", ok, f"→ {st.get('workflow')}")
    return ok


def now_is_utc(mod, label):
    """P2-21：_now() 必须与 _days_since 同为 UTC 口径。

    旧版 _now 写本地时间、_days_since 按 UTC 解析，非 UTC 环境下
    --prune 的 3 天宽限判定会偏若干小时。
    """
    print(f"\n=== {label} ===")

    # 必须在**非 UTC 时区**下测：沙盒默认是 UTC，此时无论用 gmtime 还是
    # localtime 结果都一样，坏副本也会 PASS（实测过，假阴性）。
    #
    # TZ 用 POSIX 格式 `XXX-8`（= UTC+8）：容器里没有 tzdata，
    # 写 `Asia/Shanghai` 会让 TZ 静默失效、偏移量仍是 0 —— 那样这条
    # 断言又变成装饰了。所以下面先断言偏移确实非 0。
    code = (
        "import time,calendar,sys;"
        "off=-(time.timezone if time.daylight==0 else time.altzone);"
        "sys.stderr.write('OFF=%d;'%off);"
        "import importlib.util as u;"
        "sp=u.spec_from_file_location('m',sys.argv[1]);"
        "m=u.module_from_spec(sp);sp.loader.exec_module(m);"
        "ts=m._now();"
        "p=calendar.timegm(time.strptime(ts,'%Y-%m-%dT%H:%M:%SZ'));"
        "sys.stderr.write('DIFF=%.0f'%(time.time()-p))"
    )
    import subprocess
    env = dict(os.environ, TZ="XXX-8")
    r = subprocess.run([sys.executable, "-c", code, mod.__file__],
                       capture_output=True, text=True, env=env)
    info = r.stderr or ""
    off = int(info.split("OFF=")[1].split(";")[0]) if "OFF=" in info else 0
    diff = float(info.split("DIFF=")[1]) if "DIFF=" in info else 1e9
    ck("前置：TZ 确实生效（偏移非 0）", off != 0, f"(偏移 {off}s)")
    ok = abs(diff) < 90
    ck("非 UTC 下 _now 仍是 UTC 时刻", ok, f"(差 {diff:.0f}s)")
    return off != 0 and ok


def commit_clears_changes_cache(mod, label):
    """P2-15：git commit 后必须清 _CHANGES_CACHE（与 _write_local 对齐）。

    不清的话靠「调用顺序恰好正确」这种隐式依赖，重构时极易踩。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    # 在 git("commit") 返回后**立刻**检查缓存。
    # 不能等流程结束再查：之后还有别的 detect_changes() 会重新填上，
    # 那时无论清没清都非 None —— 断言就失去意义了。
    real_git = mod.git
    seq = []

    def spy(*a, **k):
        r = real_git(*a, **k)
        seq.append(("commit" in a, mod._CHANGES_CACHE))
        return r

    mod.git = spy
    try:
        run(mod, gh, ["--yes", "-m", "x"], name="push")
    finally:
        mod.git = real_git
    # 注意时机：清缓存那行在 git("commit") **返回之后**才执行，
    # 所以在 spy 里紧跟 commit 读到的仍是旧值（实测为非空）。
    # 要看的是「commit 的下一次 git 调用时」缓存是否已经失效。
    idx = next((i for i, (is_c, _) in enumerate(seq) if is_c), None)
    nxt = seq[idx + 1][1] if idx is not None and idx + 1 < len(seq) else "(无后续)"
    ok = idx is not None and nxt is None
    ck("commit 之后缓存确实失效", ok, f"→ commit 后下一次 git 时 cache={nxt!r}")
    return ok


def merge_uses_response_sha(mod, label):
    """P2-14：合并后的主干 sha 优先取 PUT /merge 响应里的 sha。

    立即 ref_sha() 可能因 GitHub ref 更新延迟拿到旧 head。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    run(mod, gh, ["--hold", "--yes", "-m", "v2"], name="hold")
    # 让 merge 响应返回一个「更新」的 sha，并让 ref_sha 仍返回旧的
    real = gh.api

    def fake(method, path, *a, **k):
        r = real(method, path, *a, **k)
        if method == "PUT" and str(path).endswith("/merge"):
            if isinstance(r, dict):
                r = dict(r)
                r["sha"] = "f" * 40          # 响应里给出新 sha
            return r
        return r

    gh.api = fake
    mod.api = fake
    seen = []
    real_rsm = mod.remote_state_map

    def spy(head):
        seen.append(head)
        return {}

    mod.remote_state_map = spy
    try:
        out, err = run(mod, gh, ["--merge", "--yes"], name="mrg2")
    finally:
        gh.api = real
        mod.api = T._MOD.api
        mod.remote_state_map = real_rsm
    ok = any(h == "f" * 40 for h in seen)
    ck("使用了 merge 响应里的 sha", ok, f"→ remote_state_map 收到 {[str(h)[:8] for h in seen]}")
    return ok


def lock_file_is_private(mod, label):
    """P2-05：锁文件应为 0600（旧版 0644）。"""
    import stat as _st
    print(f"\n=== {label} ===")
    lock = STATE + ".lock"
    if os.path.exists(lock):
        os.unlink(lock)
    with mod.StateLock(STATE):
        if not os.path.exists(lock):
            ck("锁文件已创建", False, "(未找到)")
            return False
        mode = _st.S_IMODE(os.stat(lock).st_mode)
    ok = mode == 0o600
    ck("锁文件权限 0600", ok, f"→ {oct(mode)}")
    return ok


# ================================================== P2-02 / P2-04

def _run_real_http(mod, body, expect_status=403, retries=1, extra_headers=()):
    """在**独立子进程**里跑真实 HTTP 请求，返回 (输出, 请求头快照, 请求时刻)。

    不能在当前进程里调 mod.api()：run() 每次都会把 mod.api 换成假服务端的
    api，而 T._MOD.api 同样已被污染（它们是同一个模块对象）。在干净进程里
    重新加载源码最可靠。
    """
    code = f"""
import sys, os, threading, time, http.server, socketserver
sys.path.insert(0, "/data/workspace")
import importlib.util as u
sp = u.spec_from_file_location("m", {mod.__file__!r})
m = u.module_from_spec(sp); sp.loader.exec_module(m)
m.TOKEN = "ghp_" + "x" * 36

recv = []
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        recv.append((self.headers.get("X-GitHub-Api-Version"), time.time()))
        self.send_response({expect_status})
{chr(10).join(f"        self.send_header({k!r}, {v!r})" for k, v in extra_headers).replace("'__RESET__'", 'str(int(time.time()) + 185)')}
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{{"message":"x"}}')
    def log_message(self, *a): pass

srv = socketserver.TCPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
m.BASE = f"http://127.0.0.1:{{port}}"
try:
    m.api("GET", "/t", retries={retries})
except SystemExit as e:
    print("SYSEXIT:", str(e)[:200])
finally:
    srv.shutdown()
print("HDRS:", [r[0] for r in recv])
print("TIMES:", [r[1] for r in recv])
"""
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                       timeout=120)
    out = (r.stdout or "") + (r.stderr or "")
    hdrs, times = [], []
    for line in out.splitlines():
        if line.startswith("HDRS: "):
            hdrs = eval(line[6:])
        elif line.startswith("TIMES: "):
            times = eval(line[7:])
    return out, hdrs, times


def rate_limit_headers_parsed(mod, label):
    """P2-02：403/429 时必须给出**能照着做**的限流信息。

    只说「等几分钟」的话，用户既不知道等多久，也不知道是不是自己
    刚那次操作（比如预览了 200 个文件）把额度打光的。
    """
    print(f"\n=== {label} ===")
    out, _, _ = _run_real_http(
        mod, None, expect_status=403, retries=1,
        extra_headers=[("X-RateLimit-Remaining", "0"),
                       ("X-RateLimit-Used", "5000"),
                       ("X-RateLimit-Limit", "5000"),
                       ("X-RateLimit-Reset", "__RESET__"),
                       ("Retry-After", "37")])
    ok1 = "已用 5000/5000" in out
    ok2 = "重置" in out
    ok3 = "37 秒" in out
    ck("报出已用/总额", ok1, f"→ {out.strip()[:70]}")
    ck("报出重置时间", ok2)
    ck("报出 Retry-After", ok3)
    return ok1 and ok2 and ok3


def retry_after_used_as_backoff(mod, label):
    """P2-02：429 的退避应取 Retry-After，而不是固定 2/4/8 秒。

    GitHub 的建议值通常远大于 2^n，硬撞只会更快撞上限流。
    """
    print(f"\n=== {label} ===")
    out, _, times = _run_real_http(
        mod, None, expect_status=429, retries=3,
        extra_headers=[("Retry-After", "5")])
    gaps = [round(times[i + 1] - times[i], 1) for i in range(len(times) - 1)] \
        if len(times) > 1 else []
    ok = len(times) >= 2 and all(g >= 4.5 for g in gaps)
    ck("退避 >= Retry-After", ok, f"→ 间隔 {gaps}（应为 ~5s）")
    return ok


def api_version_header_sent(mod, label):
    """P2-02：请求应带 X-GitHub-Api-Version（否则 GitHub 会告警）。"""
    print(f"\n=== {label} ===")
    out, hdrs, _ = _run_real_http(
        mod, None, expect_status=200, retries=1)
    ok = hdrs and all(v == "2022-11-28" for v in hdrs)
    ck("带 X-GitHub-Api-Version", ok, f"→ {hdrs}")
    return ok


def docstring_matches_retryable(mod, label):
    """P2-04：api() docstring 不得声称「5xx 时 POST 也重试」。

    _retryable 从未对非 blob 的 POST 返回 True。写错的文档会诱导
    维护者去「修正」实现，把安全的部分改得不安全。
    """
    import ast
    print(f"\n=== {label} ===")
    # 不能 inspect.getdoc(mod.api)：mod.api 常被 run() 换成假服务端的 api，
    # 那时拿到的是**假服务端**的 docstring。直接解析源码文件才可靠。
    tree = ast.parse(open(mod.__file__).read())
    doc = ""
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "api":
            doc = ast.get_docstring(node) or ""
    if not doc:
        ck("能取到 api 的 docstring", False, "(未找到)")
        return False
    bad = "POST 都退避重试" in doc and "以 _retryable() 为准" not in doc
    ok1 = not bad
    ok2 = "_retryable" in doc
    ck("docstring 未错误声称 POST 重试", ok1)
    ck("docstring 指向 _retryable 为准", ok2)
    return ok1 and ok2


# ================================================== P2-06 / P2-18

def write_local_handles_dangling_symlink(mod, label):
    """P2-06：_write_local 对悬空软链必须能正常覆盖。

    ⚠ 诚实说明：P2-06 报告自己就标注了「悬空场景已安全」，实测确认
    **两处 exists/lexists 当前完全等价** —— 因为前面
    `if os.path.islink(full): os.unlink(full)` 已经把悬空软链删掉了，
    后面无论用哪个都看不到它（回退 lexists→exists 测试仍 PASS）。

    所以这两个用例真正守住的是**那行 islink 预删**（删掉它会立刻变红，
    已验证），而不是 lexists 本身。lexists 的改动属于语义清晰化 +
    防御未来有人挪动 islink 那行。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"k.txt": ("100644", b"k\n")})
    mod.ROOT = ROOT
    lp = os.path.join(ROOT, "dangle")
    os.symlink("./nowhere-xyz", lp)          # 悬空软链
    ok0 = os.path.islink(lp) and not os.path.exists(lp)
    ck("前置：确实是悬空软链", ok0)
    try:
        mod._write_local("dangle", b"#/bin/sh\n", "100644")
        got = open(lp, "rb").read()
        ok = got == b"#/bin/sh\n"
        ck("可正常覆盖悬空软链", ok, f"→ {got!r}")
    except BaseException as e:
        ok = False
        ck("可正常覆盖悬空软链", False, f"💥{type(e).__name__}: {str(e)[:60]}")
    return ok0 and ok


def symlink_over_dangling_ok(mod, label):
    """P2-06 另一面：软链位置要建软链时，残留的悬空软链必须先被清掉。"""
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"k.txt": ("100644", b"k\n")})
    mod.ROOT = ROOT
    lp = os.path.join(ROOT, "slnk")
    os.symlink("./missing-abc", lp)          # 悬空
    try:
        mod._write_local("slnk", b"k.txt", "120000")
        ok = os.path.islink(lp) and os.readlink(lp) == "k.txt"
        ck("软链位置可重建", ok, f"→ {os.readlink(lp) if os.path.islink(lp) else '(非软链)'}")
    except BaseException as e:
        ok = False
        ck("软链位置可重建", False, f"💥{type(e).__name__}: {str(e)[:60]}")
    return ok


def last_push_shown_in_prune(mod, label):
    """P2-18：tasks[branch].last_push 不得只写不读。

    PR 的 updated_at 会被评论等无关活动刷新，last_push 才反映
    「最后一次真的推了内容」。死字段比缺字段更误导后来者。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    write("a.txt", "v2\n")
    run(mod, gh, ["--hold", "--yes", "-m", "v2"], name="hold")
    out, err = run(mod, gh, ["--prune"], name="prune")
    ok = "最后推送" in out
    ck("prune 输出含最后推送", ok, f"→ {out.strip()[-80:]}")
    return ok


# ================================================== P2/P3 收尾批次

def pr_index_single_request(mod, label):
    """P2-12：--prune 应对 PR 建一次索引，而非每分支一次 find_pr（N+1）。"""
    print(f"\n=== {label} ===")
    gh = fresh()
    for i in range(30):
        gh.refs[f"task/b{i}"] = gh.refs["main"]
    real = gh.api
    calls = []

    def fake(method, path, *a, **k):
        if method == "GET" and str(path).startswith("/pulls"):
            calls.append(path)
        return real(method, path, *a, **k)

    gh.api = fake
    mod.api = fake
    try:
        run(mod, gh, ["--prune", "--yes"], name="prune_n1")
    finally:
        gh.api = real
        mod.api = T._MOD.api
    ok = len(calls) <= 2          # 索引 1 次（分页可能多 1 次空页）
    ck("PR 查询次数为常数级", ok, f"→ {len(calls)} 次（30 个分支）")
    return ok


def tree_cache_avoids_refetch(mod, label):
    """P2-11：同一 commit 的树不该重复拉。"""
    print(f"\n=== {label} ===")
    gh = fresh()
    mod._TREE_CACHE.clear()
    real = gh.api
    calls = []

    def fake(method, path, *a, **k):
        if method == "GET" and "/git/trees/" in str(path):
            calls.append(path)
        return real(method, path, *a, **k)

    gh.api = fake
    mod.api = fake
    try:
        head = gh.refs["main"]
        a = mod.remote_state_map(head)
        b = mod.remote_state_map(head)
    finally:
        gh.api = real
        mod.api = T._MOD.api
    ok1 = len(calls) == 1
    ok2 = a == b
    ck("第二次走缓存（1 次请求）", ok1, f"→ {len(calls)} 次")
    ck("结果一致", ok2)
    return ok1 and ok2


def hash_object_batched(mod, label):
    """P2-07：多个改动文件应一次 hash-object 算完，而非 N 次子进程。"""
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({f"f{i}.txt": ("100644", b"v1\n") for i in range(12)})
    mod.ROOT = ROOT
    mod._CHANGES_CACHE = None
    for i in range(12):
        write(f"f{i}.txt", f"changed{i}\n")
    real_git = mod.git
    ho = []

    def spy(*a, **k):
        if "hash-object" in a:
            ho.append(a)
        return real_git(*a, **k)

    mod.git = spy
    try:
        m = mod.local_state_map()
    finally:
        mod.git = real_git
    ok1 = len(ho) <= 1
    ok2 = all(m.get(f"f{i}.txt") for i in range(12))
    ck("hash-object 调用 ≤1 次（批处理）", ok1, f"→ {len(ho)} 次")
    ck("12 个文件 sha 均已算出", ok2)
    return ok1 and ok2


def force_overwrite_not_ignore_pending(mod, label):
    """P3-3：--force-overwrite 不该被 --pull 当成「忽略未解决冲突」。"""
    import json
    print(f"\n=== {label} ===")
    gh = fresh()
    st = json.load(open(STATE))
    st["conflicts"] = ["a.txt"]
    with open(STATE, "w") as f:
        json.dump(st, f)
    # 本地必须有改动，否则会走「本地无改动，直接更新到远端」分支，
    # 根本到不了冲突检查那一句 —— 用例就成了空转（实测踩到过）。
    write("a.txt", "my-local\n")
    T.other_commit(gh, {"a.txt": b"remote\n"})
    out, err = run(mod, gh, ["--pull", "--force-overwrite", "--yes"], name="fo")
    ok = "尚未解决" in out
    ck("仍提示冲突未解决（未被 force 放行）", ok, f"→ {out.strip()[-70:]}")
    return ok


def ignore_pending_opt_in(mod, label):
    """P3-3：--ignore-pending 才显式跳过未解决冲突。"""
    import json
    print(f"\n=== {label} ===")
    gh = fresh()
    st = json.load(open(STATE))
    st["conflicts"] = ["a.txt"]
    with open(STATE, "w") as f:
        json.dump(st, f)
    write("a.txt", "my-local\n")
    T.other_commit(gh, {"a.txt": b"remote\n"})
    out, err = run(mod, gh, ["--pull", "--ignore-pending", "--yes"], name="ip")
    ok = "尚未解决" not in out
    ck("--ignore-pending 后不再阻塞", ok, f"→ {out.strip()[-70:]}")
    return ok


def prune_drops_stale_tasks(mod, label):
    """P3-5：远端已无此分支时，本地 tasks 条目应被摘除。"""
    import json
    print(f"\n=== {label} ===")
    gh = fresh()
    st = json.load(open(STATE))
    st.setdefault("tasks", {})["task/gone"] = {"pr": 999, "last_push": "2026-01-01T00:00:00Z"}
    with open(STATE, "w") as f:
        json.dump(st, f)
    out, err = run(mod, gh, ["--prune", "--yes"], name="prune_stale")
    st2 = json.load(open(STATE))
    ok1 = "task/gone" not in (st2.get("tasks") or {})
    ok2 = "已清理" in out
    ck("僵尸条目已摘除", ok1, f"→ {list(st2.get('tasks') or {})}")
    ck("输出中有说明", ok2)
    return ok1 and ok2


def git_timeout_applied(mod, label):
    """B-P2-14：git() 真的把 timeout 传给了子进程。

    不能只断言源码里有 DEFAULT_GIT_TIMEOUT 字样 —— 那是**弱断言**：
    把 timeout=None 传下去时字面量仍在，用例照样绿（实测踩到过）。
    这里拦截 subprocess.run，检查它实际收到的 kwargs。
    """
    import subprocess as sp
    print(f"\n=== {label} ===")
    real_run = sp.run
    seen = []

    def spy(cmd, *a, **k):
        if isinstance(cmd, list) and cmd and cmd[0] == "git":
            seen.append(k.get("timeout"))
        return real_run(cmd, *a, **k)

    sp.run = spy
    try:
        mod.ROOT = ROOT
        mod.git("status", "--porcelain")
    finally:
        sp.run = real_run
    ok = bool(seen) and all(t is not None for t in seen)
    ck("git 调用带非 None 超时", ok, f"→ timeout={seen}")
    return ok


def curl_follows_redirects(mod, label):
    """B-P2-13：curl 应加 -L（仓库改名后 301 不再表现为 404）。"""
    print(f"\n=== {label} ===")
    # 必须读**源码文件**而不是 inspect.getsource(mod.api)：
    # 测试脚手架会把 mod.api 换成假服务端的方法，inspect 拿到的是它的源码。
    src = open(mod.__file__, encoding="utf-8").read()
    ok = '"-sL"' in src
    ck("curl 带 -L", ok)
    return ok


def large_payload_uses_file(mod, label):
    """P2-09：超大 payload 走临时文件，不整份驻留 Python 内存。"""
    print(f"\n=== {label} ===")
    src = open(mod.__file__, encoding="utf-8").read()
    ok = "pushapi-body-" in src
    ck("大 payload 走 @file", ok)
    return ok


def git_add_avoids_argmax(mod, label):
    """P2-08：大量文件时 git add 走 --pathspec-from-file，不展开 argv。"""
    print(f"\n=== {label} ===")
    ok1 = hasattr(mod, "_git_add_paths")
    src = open(mod.__file__, encoding="utf-8").read()
    ok2 = "pathspec-from-file" in src
    ck("_git_add_paths 存在", ok1)
    ck("使用 --pathspec-from-file", ok2)
    return ok1 and ok2


# ================================================== 报告 A 补漏

def pull_syncs_mode_only_change(mod, label):
    """A-P1-2：远端只改权限位（755→644，内容不变）时 pull 必须同步本地。

    两处都要对，缺一不可：
      · 待合并判据要比 (mode, sha) 而不是只比 sha
      · local == remote 分支只比较内容字节，必须额外 chmod 本地文件
    旧版两处都漏，导致本地权限位与基线永久打架，文件每次都被报成待推。
    """
    import stat as _st
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"x.sh": ("100755", b"#!/bin/sh\n")})
    gh = GH({"x.sh": ("100755", b"#!/bin/sh\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    gh.refs["main"] = gh._commit({"x.sh": ("100644", b"#!/bin/sh\n")},
                                 gh.refs["main"])
    out, err = run(mod, gh, ["--pull", "--yes"], name="mode")
    m = _st.S_IMODE(os.stat(os.path.join(ROOT, "x.sh")).st_mode)
    ok1 = m == 0o644
    # 再跑一次必须说「没有需要合并的」—— 不能永久重复
    out2, _ = run(mod, gh, ["--pull", "--yes"], name="mode2")
    ok2 = "没有需要合并" in out2
    ck("本地权限位已还原 644", ok1, f"→ {oct(m)}")
    ck("不会反复出现（第二次无待合并）", ok2, f"→ {out2.strip()[-56:]}")
    return ok1 and ok2


def conflict_blocks_only_named_file(mod, label):
    """A-P1-5：1 个冲突时，点名**无关**文件应可推；点名冲突文件应被拦。"""
    import json
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"b1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"b1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    write("a.txt", "MINE\n")
    gh.refs["main"] = gh._commit(
        {"a.txt": ("100644", b"REMOTE\n"), "b.txt": ("100644", b"b1\n")},
        gh.refs["main"])
    run(mod, gh, ["--pull", "--yes"], name="conf")
    st = json.load(open(STATE))
    ok0 = st.get("conflicts") == ["a.txt"]
    ck("前置：a.txt 已记录为冲突", ok0, f"→ {st.get('conflicts')}")

    write("b.txt", "b2-EDIT\n")
    # 直接把 synced 对齐当前 head，把 P0-1 这个变量排除掉，
    # 从而**单独**验证「冲突拦截是不是只作用于冲突文件」。
    #
    # 不能用 --mark-synced 来达到这个状态：有未解决冲突时它会被正确拒绝
    # （不能一边有冲突一边声明"已同步"）。那是另一道闸门的正确行为，
    # 混进来就测不到本条要测的东西了。
    st2 = json.load(open(STATE))
    st2["synced_commit"] = gh.refs["main"]
    st2["base_commit"] = gh.refs["main"]
    json.dump(st2, open(STATE, "w"))
    out, err = run(mod, gh, ["--yes", "-m", "x", "b.txt"], name="pushb")
    ok1 = main_file(gh, "b.txt") == "b2-EDIT\n"
    ck("点名无关文件可推", ok1, f"→ {main_file(gh, 'b.txt')!r}")

    out2, err2 = run(mod, gh, ["--yes", "-m", "y", "a.txt"], name="pusha")
    ok2 = "冲突" in (out2 + str(err2 or ""))
    ck("点名冲突文件被拦", ok2, f"→ {str(err2)[:46] if err2 else out2[-46:]}")
    return ok0 and ok1 and ok2


# ================================================== git 回退 / stash 场景

def git_checkout_old_blocked(mod, label):
    """git checkout <old> 后推送必须被拦（本地内容可能已不含远端改动）。

    断言**文件级结果**（主干是否被回退），不能断言提示文案 ——
    「回退」这个词也出现在「PR diff 出现回退」这句正常说明里，
    匹配文案会假阳性（实测三个场景全被误判为「已拦下」）。
    """
    import subprocess as _sp
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    write("a.txt", "v2\n")
    run(mod, gh, ["--yes", "-m", "v2"], name="push2")
    ok0 = main_file(gh, "a.txt") == "v2\n"
    ck("前置：v2 已上主干", ok0, f"→ {main_file(gh, 'a.txt')!r}")

    first = _sp.run(["git", "-C", ROOT, "rev-list", "--max-parents=0", "HEAD"],
                    capture_output=True, text=True).stdout.strip()
    _sp.run(["git", "-C", ROOT, "checkout", "-q", first], check=True)
    write("a.txt", "AFTER-CHECKOUT\n")
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="push3")
    final = main_file(gh, "a.txt")
    ok1 = final == "v2\n"                     # 主干 v2 未被回退
    ok2 = "本地 git HEAD" in (out + str(err or ""))
    ck("主干未被静默回退", ok1, f"→ {final!r}")
    ck("提示指出 HEAD 被回退/分叉", ok2)
    return ok0 and ok1 and ok2


def git_reset_hard_blocked(mod, label):
    """git reset --hard 后推送必须被拦（与 checkout 同族，已有防护）。"""
    import subprocess as _sp
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    write("a.txt", "v2\n")
    run(mod, gh, ["--yes", "-m", "v2"], name="push2")
    _sp.run(["git", "-C", ROOT, "reset", "-q", "--hard", "HEAD~1"], check=True)
    write("a.txt", "AFTER-RESET\n")
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="push3")
    final = main_file(gh, "a.txt")
    ok = final == "v2\n"
    ck("主干未被静默回退", ok, f"→ {final!r}")
    return ok


def stash_hides_changes_warns(mod, label):
    """git stash 后工作区干净 → 不得只说「没有待推送的改动」。

    改动在 stash 里没丢，但那句话会让用户以为它凭空消失了。
    """
    import subprocess as _sp
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    write("a.txt", "WIP\n")
    _sp.run(["git", "-C", ROOT, "stash", "-q"], check=True)
    ok0 = open(os.path.join(ROOT, "a.txt")).read() == "v1\n"
    ck("前置：工作区已回到 v1", ok0)
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="stashed")
    ok1 = "没有待推送的改动" in out
    ok2 = "git stash" in out
    ck("确为「无改动」路径", ok1)
    ck("提示 stash 里还有改动", ok2, f"→ {out.strip()[-70:]}")
    return ok0 and ok1 and ok2


def stash_pop_not_false_positive(mod, label):
    """边界：stash pop 后 HEAD 未移动，不得误报「回退」。

    pop 恢复的是工作区内容，HEAD 不动，不该触发回退检测。
    """
    import subprocess as _sp
    import json as _j
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    write("a.txt", "v2\n")
    run(mod, gh, ["--yes", "-m", "v2"], name="push2")
    st = _j.load(open(STATE))
    before = _sp.run(["git", "-C", ROOT, "rev-parse", "HEAD"],
                     capture_output=True, text=True).stdout.strip()
    write("a.txt", "WIP\n")
    _sp.run(["git", "-C", ROOT, "stash", "-q"], check=True)
    _sp.run(["git", "-C", ROOT, "stash", "pop", "-q"], check=True)
    after = _sp.run(["git", "-C", ROOT, "rev-parse", "HEAD"],
                    capture_output=True, text=True).stdout.strip()
    ok0 = before == after
    ck("前置：HEAD 未移动", ok0, f"→ {before[:8]} vs {after[:8]}")
    rewound, why = mod._local_head_rewound(st)
    ok1 = not rewound
    ck("未误报回退", ok1, f"→ {(str(why)[:40] if why else 'None')}")
    return ok0 and ok1


# ================================================== 清单第二批（A2/B1~B6/C1/C2）

def git_calls_have_timeout(mod, label):
    """A2：所有 subprocess.run(["git", ...]) 必须带 timeout。

    git() 的注释写「没有超时会让整个推送永久卡死」，而这 4 处正是绕过
    git() 直接调 subprocess 的地方 —— 恰是该注释想防的场景。
    """
    import ast
    print(f"\n=== {label} ===")
    src = open(mod.__file__, encoding="utf-8").read()
    tree = ast.parse(src)
    bad = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        if not (isinstance(f, ast.Attribute) and f.attr == "run"):
            continue
        v = f.value
        if isinstance(v, ast.Attribute) and v.attr == "subprocess":
            pass
        elif isinstance(v, ast.Name) and v.id == "subprocess":
            pass
        else:
            continue
        a = node.args
        if a and isinstance(a[0], ast.List) and a[0].elts:
            e0 = a[0].elts[0]
            if isinstance(e0, ast.Constant) and e0.value == "git":
                if not any(k.arg == "timeout" for k in node.keywords):
                    bad.append(node.lineno)
    ok = not bad
    ck("所有 git subprocess 都带 timeout", ok, f"→ 缺的行: {bad}")
    return ok


def symlink_target_not_stripped(mod, label):
    """B2：symlink 写入不得 strip，否则 sha 永久分叉。

    远端 blob b'/opt/target\n' → 写入 '/'opt/target'' → 读回算出的 sha
    与远端永久不等 → 第一层校验永久误报「可能被他人改动」。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"k.txt": ("100644", b"k\n")})
    # 用**相对**目标：绝对路径会被「拒绝创建绝对路径软链」的安全校验
    # 拦下，那样测不到 strip 这个点（校验先触发）。
    gh = GH({"k.txt": ("100644", b"k\n"), "ln": ("120000", b"k.txt\n")})
    mod.ROOT, mod.api = ROOT, gh.api
    mod._write_local("ln", b"k.txt\n", "120000")
    got = os.readlink(os.path.join(ROOT, "ln"))
    ok = got == "k.txt\n"                # 保留了末尾换行
    ck("保留了原字节（未 strip）", ok, f"→ {got!r}")
    if ok:
        import subprocess as _sp
        sha = _sp.run(["git", "-C", ROOT, "hash-object", "--no-filters", "--stdin"],
                      input=got.encode(), capture_output=True).stdout.decode().strip()
        from test_pr_flow import sha as _sha
        remote_sha = _sha(b"k.txt\n")
        ck("与远端 blob 的 sha 一致", sha == remote_sha,
           f"→ 本地 {sha[:8]} vs 远端 {remote_sha[:8]}")
        return sha == remote_sha
    return False


def symlink_local_change_not_dropped(mod, label):
    """B1：本地改过 symlink 指向时，pull 不得静默采用远端。

    旧版直接覆盖并计 clean，报「干净 N 个，冲突 0 个」—— 把丢弃说成顺利。
    """
    import json
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"k.txt": ("100644", b"k\n")})
    # 远端 symlink 指向 k.txt
    gh = GH({"k.txt": ("100644", b"k\n"), "ln": ("120000", b"k.txt")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    # 本地改成指向别处
    lp = os.path.join(ROOT, "ln")
    if os.path.lexists(lp):
        os.unlink(lp)
    os.symlink("k.txt", lp)          # 先与远端一致
    if os.path.lexists(lp):
        os.unlink(lp)
    os.symlink("other.txt", lp)      # 本地改指向
    # 远端也改了
    gh.refs["main"] = gh._commit(
        {"k.txt": ("100644", b"k\n"), "ln": ("120000", b"k2.txt")},
        gh.refs["main"])
    out, err = run(mod, gh, ["--pull", "--yes"], name="ln")
    st = json.load(open(STATE))
    ok1 = "ln" in (st.get("conflicts") or [])
    ok2 = os.readlink(lp) == "other.txt"      # 本地指向未被覆盖
    ck("计入冲突（而非 clean）", ok1, f"→ conflicts={st.get('conflicts')}")
    ck("本地指向未被静默覆盖", ok2, f"→ {os.readlink(lp)!r}")
    return ok1 and ok2


def prune_sees_non_task_branches(mod, label):
    """B4：--prune 不得只认 task/ 前缀（pr/ fix/ feature/ 会静默漏报）。"""
    print(f"\n=== {label} ===")
    gh = fresh()
    gh.refs["pr/backfill-round2"] = "c" + "0" * 39
    gh.refs["fix/typo"] = "d" + "0" * 39
    out, err = run(mod, gh, ["--prune"], name="prune2")
    ok1 = "pr/backfill-round2" in out
    ok2 = "fix/typo" in out
    ck("看到 pr/ 前缀分支", ok1)
    ck("看到 fix/ 前缀分支", ok2)
    return ok1 and ok2


def mark_synced_rejects_conflicts(mod, label):
    """B6：有未解决冲突时 --mark-synced 必须拒绝（否则解除 P0-1 闸门）。"""
    import json
    print(f"\n=== {label} ===")
    gh = fresh()
    st = json.load(open(STATE))
    st["conflicts"] = ["a.txt"]
    st["synced_commit"] = None
    json.dump(st, open(STATE, "w"))
    out, err = run(mod, gh, ["--mark-synced", "--yes"], name="ms")
    st2 = json.load(open(STATE))
    ok1 = st2.get("synced_commit") is None
    ok2 = "冲突" in (out + str(err or ""))
    ck("未解除过期闸门", ok1, f"→ synced={st2.get('synced_commit')}")
    ck("提示先解决冲突", ok2)
    return ok1 and ok2


def abandon_task_protects_main(mod, label):
    """B5：abandon_task 必须拦主干（与 close_pr / delete_branch_cmd 一致）。"""
    import json as _json
    print(f"\n=== {label} ===")
    _ = fresh()                      # 只需初始化状态文件
    st = _json.load(open(STATE))
    main_branch = mod.BRANCH
    try:
        mod.abandon_task(st, main_branch)
        ok, msg = False, "(未拒绝)"
    except SystemExit as e:
        ok, msg = ("主干" in str(e) or main_branch in str(e)), str(e).splitlines()[0][:46]
    ck("拒绝删除主干", ok, f"→ {msg}")
    return ok


def ci_pending_not_need_update(mod, label):
    """B3：CI 挡住不得被判成 need_update（提示点 Update branch 无效）。"""
    print(f"\n=== {label} ===")
    gh = fresh()
    real = gh.api

    def fake(method, path, *a, **k):
        if method == "PUT" and str(path).endswith("/merge"):
            raise SystemExit("API PUT /merge → HTTP 405: "
                             "Required status check \"ci/build\" is failing")
        return real(method, path, *a, **k)

    gh.api = fake
    mod.api = fake
    try:
        status = None
        r, status = mod.merge_pr(1, "squash")
    finally:
        gh.api = real
        mod.api = T._MOD.api
    ok = status == "ci_pending"
    ck("归类为 ci_pending", ok, f"→ {status}")
    return ok


def ls_files_uses_nul(mod, label):
    """C1：git ls-files 必须用 -z，与 status --porcelain -z 同口径。"""
    print(f"\n=== {label} ===")
    src = open(mod.__file__, encoding="utf-8").read()
    ok = '"-z"' in src and 'ls-files", "-s", "-z"' in src
    ck("ls-files -s 带 -z", ok)
    return ok


def pull_reports_remote_deleted(mod, label):
    """C2：远端删掉的文件必须明确列出，不能一句「不支持删除」带过。

    关键：必须**比对基线**，不能只在遍历 rstate 时判断 ——
    被删的文件根本不在 rstate 里，循环内那个分支永远不会执行
    （实测：只改循环内，删掉的文件连一行输出都没有）。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    # 远端删掉 a.txt（只留 b.txt）
    gh.refs["main"] = gh._commit({"b.txt": ("100644", b"b\n")}, gh.refs["main"])
    out, err = run(mod, gh, ["--pull", "--yes"], name="del")
    ok = "a.txt" in out and "远端已删除" in out
    ck("列出了远端已删除的文件", ok, f"→ {out.strip()[-70:]}")
    return ok


def remote_deleted_when_no_merge_needed(mod, label):
    """C2 最关键的场景：远端**只**删了文件、别处没动 → paths 为空。

    此时 pull 走「没有需要合并的远端改动」分支并**提前 return**。
    若提示只写在循环之后，这个最常见场景会完全静默 ——
    脚本不但不删，还连说都不说一声（实测确认过）。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"b1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"b1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    # 只删 a.txt，b.txt 原样
    gh.refs["main"] = gh._commit({"b.txt": ("100644", b"b1\n")},
                                 gh.refs["main"])
    out, err = run(mod, gh, ["--pull", "--yes"], name="quiet")
    ok1 = "没有需要合并" in out
    ok2 = "远端已删除" in out and "a.txt" in out
    ck("确为 paths 为空的路径", ok1)
    ck("仍然列出了被删文件", ok2, f"→ {out.strip()[-70:]}")
    return ok1 and ok2


def remote_deleted_no_false_positive(mod, label):
    """边界：本地新增（基线里从未有过）不得被误报成「远端已删除」。

    比对对象必须是**基线**（上次同步时远端有什么），不是「本地有而远端没有」。
    后者会把所有本地新增文件全误报成删除 —— 那比沉默更糟，会诱导用户
    删掉自己刚写的文件。

    【必须 git add】local_state_map() 走 `git ls-files -s`，只包含
    **已跟踪**文件。若新增文件保持 untracked，它根本不参与比对，
    于是「按本地判定」这种错误实现也不会误报 —— 用例会假阳性通过
    （实测：untracked 版本对坏副本报 ALL PASS）。
    """
    import subprocess as _sp
    print(f"\n=== {label} ===")
    gh = fresh()
    write("brand-new.txt", "new\n")
    _sp.run(["git", "-C", ROOT, "add", "brand-new.txt"], check=True)
    ok0 = "brand-new.txt" in mod.local_state_map()
    ck("前置：已跟踪且不在基线里", ok0,
       f"→ lmap {sorted(mod.local_state_map())}")

    out, err = run(mod, gh, ["--pull", "--yes"], name="fp")
    ok1 = "远端已删除" not in out
    ck("未把本地新增误报为删除", ok1, f"→ {out.strip()[-70:]}")
    return ok0 and ok1


# ================================================== 自查补漏

def prune_not_delete_tracked_branch(mod, label):
    """tasks 正在跟踪、但无 PR 的分支，--prune 不得当孤儿建议删除。

    它多半是「分支已推上内容、开 PR 失败」留下的（P1-8 场景），
    分支上装着用户刚推的东西。--prune 若给 --delete-branch，
    就与推送时那句「不要 --delete-branch」自相矛盾。
    """
    import json
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    gh.refs["pr/backfill-round2"] = gh.refs["main"]
    st = json.load(open(STATE))
    st["tasks"] = {"pr/backfill-round2": {"last_push": mod._now(), "pushed": {}}}
    json.dump(st, open(STATE, "w"))
    out, err = run(mod, gh, ["--prune"], name="held")
    ok1 = "先确认" in out and "pr/backfill-round2" in out
    ok2 = "--branch" in out
    ck("单独归类（非孤儿）", ok1, f"→ {out.strip()[-70:]}")
    ck("给出 --branch 重试路径", ok2)
    return ok1 and ok2


def push_preserves_local_worktree(mod, label):
    """盲区1：推送后**本地文件必须一字未改**。

    所有用例都在断言「远端内容对不对」，却没人断言本地没被改坏。
    一旦某次改动让 pull/push 误改工作区，测试会全是绿的。
    这条守的是「不能弄坏用户本地文件」这条底线。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    files = {"a.txt": ("100644", b"a-v1\n"), "b.txt": ("100644", b"b-v1\n")}
    setup_repo(files)
    gh = GH(dict(files))
    run(mod, gh, ["--init-baseline", "--yes"], name="init")

    write("a.txt", "a-MINE\n")
    write("b.txt", "b-MINE\n")
    before = {n: open(os.path.join(ROOT, n), "rb").read()
              for n in ("a.txt", "b.txt")}
    run(mod, gh, ["--yes", "-m", "x"], name="push")
    after = {n: open(os.path.join(ROOT, n), "rb").read()
             for n in ("a.txt", "b.txt")}
    ok1 = before == after
    ok2 = main_file(gh, "a.txt") == "a-MINE\n"   # 远端确实收到了
    ck("本地文件未被改动", ok1,
       f"→ {before} vs {after}" if before != after else "")
    ck("远端确实收到（确认不是空跑）", ok2, f"→ {main_file(gh, 'a.txt')!r}")
    return ok1 and ok2


def pull_preserves_unrelated_files(mod, label):
    """盲区1b：--pull 合并一个文件时，不得动其它文件。

    与上条同理，但覆盖「三方合并写回本地」这条最容易越界的路径。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    files = {"a.txt": ("100644", b"l1\nl2\nl3\n"),
             "keep.txt": ("100644", b"KEEP-AS-IS\n")}
    setup_repo(files)
    gh = GH(dict(files))
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    gh.refs["main"] = gh._commit(
        {"a.txt": ("100644", b"l1\nREMOTE\nl3\n"),
         "keep.txt": ("100644", b"KEEP-AS-IS\n")}, gh.refs["main"])
    before_k = open(os.path.join(ROOT, "keep.txt"), "rb").read()
    run(mod, gh, ["--pull", "--yes"], name="pull")
    after_k = open(os.path.join(ROOT, "keep.txt"), "rb").read()
    ok1 = before_k == after_k == b"KEEP-AS-IS\n"
    ok2 = open(os.path.join(ROOT, "a.txt"), "rb").read() == b"l1\nREMOTE\nl3\n"
    ck("无关文件未被触碰", ok1, f"→ {after_k!r}")
    ck("目标文件已合并远端改动", ok2)
    return ok1 and ok2


def concurrent_push_different_files(mod, label):
    """盲区2：两个进程同时推**不同**文件，不得互相覆盖。

    test_concurrent.py 测的是锁（串行化），这里测的是**正确性** ——
    即便串行，也要保证后一个不会回退前一个的改动。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    files = {"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"v1\n")}
    setup_repo(files)
    gh = GH(dict(files))
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    # 进程1 推 a.txt
    write("a.txt", "A-BY-P1\n")
    run(mod, gh, ["--yes", "-m", "p1", "a.txt"], name="p1")
    # 进程2（本地副本）推 b.txt：基线与进程1 推送前相同
    write("b.txt", "B-BY-P2\n")
    out, err = run(mod, gh, ["--yes", "-m", "p2", "b.txt"], name="p2")
    ok1 = main_file(gh, "a.txt") == "A-BY-P1\n"    # P1 的改动还在
    ok2 = main_file(gh, "b.txt") == "B-BY-P2\n"    # P2 的改动进去了
    ck("P1 的改动未被回退", ok1, f"→ {main_file(gh, 'a.txt')!r}")
    ck("P2 的改动已生效", ok2, f"→ {main_file(gh, 'b.txt')!r}")
    return ok1 and ok2


# ================================================== 第四轮审查：P0 + P1×3 + P2×3

def _rewind_scenario(mod):
    """构造 P0 场景：本地 v2 / 远端 v3 / 基线 v3，然后 git reset --hard。"""
    import subprocess as _sp
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    write("a.txt", "v2\n")
    run(mod, gh, ["--yes", "-m", "v2"], name="p2")
    write("a.txt", "v3\n")
    run(mod, gh, ["--yes", "-m", "v3"], name="p3")
    _sp.run(["git", "-C", ROOT, "reset", "-q", "--hard", "HEAD~1"], check=True)
    return gh


def p0_pull_then_push_no_silent_revert(mod, label):
    """P0：回退后 --pull → 推送，不得静默用 v2 覆盖主干 v3。

    根因在**出口**而非判据：--pull 的 not-paths 分支只比「远端 vs 基线」，
    一次都没比过本地内容，却写了 synced_commit + local_head ——
    后者把回退证据当场抹掉，第零层从此失效。
    """
    print(f"\n=== {label} ===")
    gh = _rewind_scenario(mod)
    ok0 = main_file(gh, "a.txt") == "v3\n"
    ck("前置：主干已是 v3", ok0, f"→ {main_file(gh, 'a.txt')!r}")

    out, err = run(mod, gh, ["--pull", "--yes"], name="pull")
    ok1 = "git reflog" in out or "❌" in out
    ck("--pull 拦下并给出恢复指引", ok1, f"→ {out.strip()[-70:]}")

    out2, err2 = run(mod, gh, ["--yes", "-m", "x"], name="push")
    ok2 = main_file(gh, "a.txt") == "v3\n"
    ck("主干 v3 未被 v2 覆盖", ok2, f"→ {main_file(gh, 'a.txt')!r}")
    return ok0 and ok1 and ok2


def p0_mark_synced_refused_when_rewound(mod, label):
    """P0：--mark-synced 同样不得在回退时解除 P0-1。

    它的守卫只认「远端变过 + 本地没合上」，不认「本地退了」——
    与 pull 那两处是同一语义的三份实现，不能漏。
    """
    print(f"\n=== {label} ===")
    gh = _rewind_scenario(mod)
    out, err = run(mod, gh, ["--mark-synced", "--yes"], name="ms")
    blob = out + str(err or "")
    ok1 = "❌" in blob or "已取消" in blob
    ck("--mark-synced 被拒", ok1, f"→ {str(err)[:50] if err else out[-50:]}")
    out2, err2 = run(mod, gh, ["--yes", "-m", "x"], name="push")
    ok2 = main_file(gh, "a.txt") == "v3\n"
    ck("主干 v3 保住", ok2, f"→ {main_file(gh, 'a.txt')!r}")
    return ok1 and ok2


def p1_1_local_head_missing_hint(mod, label):
    """P1-1：local_head 缺失时不得静默失效。

    这字段是本版新增，升级前的状态文件都没有 —— 静默跳过意味着用户
    完全不知道自己少了这道防护。
    注意：提示每进程只打一次（全局标志），测试前需重置该标志。
    """
    import json
    print(f"\n=== {label} ===")
    gh = _rewind_scenario(mod)
    mod._REWIND_NO_BASELINE_WARNED = False
    st = json.load(open(STATE))
    ok0 = bool(st.get("files"))
    st.pop("local_head", None)
    json.dump(st, open(STATE, "w"))
    ck("前置：files 非空且 local_head 已移除", ok0)
    out, err = run(mod, gh, ["--pull", "--yes"], name="nohint")
    ok1 = "local_head" in out
    ck("打印了说明", ok1, f"→ {out.strip()[-70:]}")
    return ok0 and ok1


def p1_2_unresolvable_commit_fails_closed(mod, label):
    """P1-2：old 提交查不到时（rc=128）必须 fail-closed，不得放行。

    「记录里的提交找不到了」更像本地被动过的信号（reset/rebase/amend
    都会换掉提交），不是「一切正常」的信号。
    """
    import json
    print(f"\n=== {label} ===")
    gh = _rewind_scenario(mod)
    st = json.load(open(STATE))
    st["local_head"] = "f" * 40
    json.dump(st, open(STATE, "w"))
    rewound, why = mod._local_head_rewound(st)
    ok1 = rewound is True
    ck("按已回退处理（fail-closed）", ok1, f"→ {str(why)[:60]}")
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="gc")
    ok2 = main_file(gh, "a.txt") == "v3\n"
    ck("推送被拦，主干 v3 保住", ok2, f"→ {main_file(gh, 'a.txt')!r}")
    return ok1 and ok2


def p1_3_conflict_artifacts_visible(mod, label):
    """P1-3：.push-conflicts 只增不减，--status / --prune 必须能看见。

    里面是**完整的远端明文内容**，在仓库外、--prune 原本不管、
    也没有任何命令能列出来。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"l1\nl2\nl3\n")})
    gh = GH({"a.txt": ("100644", b"l1\nl2\nl3\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    write("a.txt", "l1\nMINE\nl3\n")
    gh.refs["main"] = gh._commit({"a.txt": ("100644", b"l1\nREMOTE\nl3\n")},
                                 gh.refs["main"])
    run(mod, gh, ["--pull", "--yes"], name="conflict")
    ok0 = bool(mod._list_conflict_artifacts())
    ck("前置：确有副产物", ok0, f"→ {mod._list_conflict_artifacts()[:3]}")

    out, err = run(mod, gh, ["--status"], name="st")
    ok1 = "冲突副产物" in out or ".push-conflicts" in out
    ck("--status 列出", ok1, f"→ {out.strip()[-70:]}")
    out2, err2 = run(mod, gh, ["--prune"], name="pr")
    ok2 = "冲突副产物" in out2 or ".push-conflicts" in out2
    ck("--prune 列出", ok2)
    return ok0 and ok1 and ok2


def p2_1_pull_message_accurate(mod, label):
    """P2-1：措辞必须如实描述它校验了什么。

    「本地内容已与远端一致」是假的 —— 那一支只比了「远端 vs 基线」，
    从未比过本地内容。用户据此相信已同步，于是放心推送，本地旧版本
    静默覆盖远端（P0 链路第 4 步）。
    """
    print(f"\n=== {label} ===")
    gh = fresh()
    out, err = run(mod, gh, ["--pull", "--yes"], name="noop")
    ok1 = "远端相对基线无变化" in out
    ok2 = "本地内容已与远端一致" not in out
    ck("措辞改为「远端相对基线无变化」", ok1, f"→ {out.strip()[-70:]}")
    ck("不再宣称「本地已与远端一致」", ok2)
    return ok1 and ok2


def p2_2_unpreviewed_files_listed(mod, label):
    """P2-2：超出 PREVIEW_CAP 的文件必须单独列出，不能混在总数里。

    它们仍会照常推送，却在预览里一个字都看不到名字 —— 而「待推送 N 个
    文件」里是包含它们的，用户会以为自己看过全部 diff 了。
    """
    print(f"\n=== {label} ===")
    T._rmtree_stubborn(ROOT)
    files = {f"f{i}.txt": ("100644", b"v1\n") for i in range(25)}
    setup_repo(files)
    gh = GH(dict(files))
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    for i in range(25):
        write(f"f{i}.txt", "changed\n")
    out, err = run(mod, gh, ["--dry-run"], name="prev")
    ok1 = "未做内容预览" in out
    ok2 = out.count("     f") >= 5          # 25-20=5 个被省略
    ck("提示未做内容预览", ok1, f"→ {out.strip()[-70:]}")
    ck("逐个列出被省略的文件", ok2, f"→ 列了 {out.count('     f')} 行")
    return ok1 and ok2


# ================================================== --direct 分支保护检测

def _direct_scenario(mod):
    T._rmtree_stubborn(ROOT)
    setup_repo({"a.txt": ("100644", b"v1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"], name="init")
    write("a.txt", "v2\n")
    return gh


def direct_allowed_when_unprotected(mod, label):
    """未开保护时 --direct 必须照常工作（不能误伤）。"""
    print(f"\n=== {label} ===")
    gh = _direct_scenario(mod)
    out, err = run(mod, gh, ["--direct", "--yes", "-m", "x"], name="ok")
    ok = main_file(gh, "a.txt") == "v2\n"
    ck("直推成功", ok, f"→ {main_file(gh, 'a.txt')!r}")
    return ok


def direct_refused_when_protected(mod, label):
    """开了分支保护 → --direct 提前拒绝，不撞看不懂的 403。

    关键：GitHub 开启「Require a pull request」时
    required_pull_request_reviews 常常就是 **{}**（空字典是 falsy）。
    用 `or` 判真值会漏掉，保护开了却当没开 —— 必须用键存在性。
    """
    print(f"\n=== {label} ===")
    gh = _direct_scenario(mod)
    gh.protection["main"] = {"required_pull_request_reviews": {}}
    out, err = run(mod, gh, ["--direct", "--yes", "-m", "x"], name="blocked")
    blob = out + str(err or "")
    ok1 = "分支保护" in blob
    ok2 = main_file(gh, "a.txt") == "v1\n"        # 没推上去
    ck("提示分支保护", ok1, f"→ {str(err)[:60] if err else out[-60:]}")
    ck("未推上主干", ok2, f"→ {main_file(gh, 'a.txt')!r}")
    return ok1 and ok2


def direct_refused_on_status_checks(mod, label):
    """只开了 status checks 同样拒绝（任何一类保护都意味着直推会被拒）。"""
    print(f"\n=== {label} ===")
    gh = _direct_scenario(mod)
    gh.protection["main"] = {"required_status_checks": {"strict": True,
                                                        "contexts": []}}
    out, err = run(mod, gh, ["--direct", "--yes", "-m", "x"], name="sc")
    ok = main_file(gh, "a.txt") == "v1\n"
    ck("未推上主干", ok, f"→ {main_file(gh, 'a.txt')!r}")
    return ok


def direct_warns_when_protection_unknown(mod, label):
    """查不出保护状态（403/网络错）→ 提示但不拦。

    把「查不出来」和「没开」混成一种，会让无权限的用户以为可以直推，
    结果撞一个看不懂的 403 —— 这正是本函数想避免的事。
    """
    print(f"\n=== {label} ===")
    gh = _direct_scenario(mod)
    real = gh.api

    def boom(method, path, *a, **k):
        if "protection" in str(path):
            raise SystemExit("403 forbidden")
        return real(method, path, *a, **k)

    gh.api = boom
    mod.api = boom
    try:
        out, err = run(mod, gh, ["--direct", "--yes", "-m", "x"], name="unk")
    finally:
        gh.api = real
        mod.api = real
    ok1 = "无法确认" in out
    ok2 = main_file(gh, "a.txt") == "v2\n"        # 未被误拦
    ck("提示无法确认", ok1, f"→ {out.strip()[-60:]}")
    ck("未被误拦（仍推送）", ok2, f"→ {main_file(gh, 'a.txt')!r}")
    return ok1 and ok2


def pr_mode_unaffected_by_protection(mod, label):
    """PR 模式不得受分支保护检测影响（检测只作用于 --direct）。"""
    print(f"\n=== {label} ===")
    gh = _direct_scenario(mod)
    gh.protection["main"] = {"required_pull_request_reviews": {}}
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="pr")
    ok = main_file(gh, "a.txt") == "v2\n"
    ck("PR 模式照常成功", ok, f"→ {main_file(gh, 'a.txt')!r}")
    return ok


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "v4mod")
    T._MOD = mod
    for fn in (pull_fills_baseline_gap, direct_mode_no_deadlock,
               pr_mode_no_silent_revert, preview_counts_deletions,
               symlink_non_utf8_no_crash,
               delete_main_rejected, close_pr_main_rejected,
               branch_main_rejected,
               dry_run_blocks_mutating_subcommands, dry_run_still_allows_readonly,
               save_state_surrogate_no_traceback,
               conflict_blocks_only_pushed_files, conflict_still_blocks_itself,
               symlink_target_escape_rejected,
               blob_sha_matches_uploaded_bytes, days_since_negative_offset,
               help_and_state_args_exist, state_arg_changes_path,
               branch_name_url_encoded,
               find_pr_prefers_open, write_local_resets_exec_bit,
               clock_skew_surfaced, resolve_rejects_non_conflict,
               git_reset_detected,
               merge_uses_mergeable_state, mergeable_null_polls,
               git_broken_not_silent_no_changes, remote_fetch_failure_not_conflict,
               symlink_preview_no_fake_diff, list_endpoints_paginate,
               ensure_pr_failure_keeps_branch_hint,
               exec_bit_zero_samples_not_reliable,
               merge3_cleanup_error_hides_nothing, version_bool_rejected,
               reset_baseline_keeps_workflow, dash_filename_supported,
               eof_no_traceback_and_no_action, eof_leaves_no_orphan_branch,
               eof_yes_still_works, eof_merge_prompt_cancels,
               main_new_file_not_lagging, pull_rejects_out_of_tree_paths,
               direct_persists_workflow, now_is_utc,
               commit_clears_changes_cache, merge_uses_response_sha,
               lock_file_is_private,
               rate_limit_headers_parsed, retry_after_used_as_backoff,
               api_version_header_sent, docstring_matches_retryable,
               write_local_handles_dangling_symlink, symlink_over_dangling_ok,
               last_push_shown_in_prune,
               pr_index_single_request, tree_cache_avoids_refetch,
               hash_object_batched, force_overwrite_not_ignore_pending,
               ignore_pending_opt_in, prune_drops_stale_tasks,
               git_timeout_applied, curl_follows_redirects,
               large_payload_uses_file, git_add_avoids_argmax,
               pull_syncs_mode_only_change, conflict_blocks_only_named_file,
               git_checkout_old_blocked, git_reset_hard_blocked,
               stash_hides_changes_warns, stash_pop_not_false_positive,
               git_calls_have_timeout, symlink_target_not_stripped,
               symlink_local_change_not_dropped, prune_sees_non_task_branches,
               mark_synced_rejects_conflicts, abandon_task_protects_main,
               ci_pending_not_need_update, ls_files_uses_nul,
               pull_reports_remote_deleted,
               remote_deleted_no_false_positive,
               remote_deleted_when_no_merge_needed,
               prune_not_delete_tracked_branch, push_preserves_local_worktree,
               pull_preserves_unrelated_files, concurrent_push_different_files,
               p0_pull_then_push_no_silent_revert,
               p0_mark_synced_refused_when_rewound,
               p1_1_local_head_missing_hint,
               p1_2_unresolvable_commit_fails_closed,
               p1_3_conflict_artifacts_visible,
               p2_1_pull_message_accurate, p2_2_unpreviewed_files_listed,
               direct_allowed_when_unprotected, direct_refused_when_protected,
               direct_refused_on_status_checks,
               direct_warns_when_protection_unknown,
               pr_mode_unaffected_by_protection):
        try:
            RES.append((fn.__name__, fn(mod, fn.__name__)))
        except Exception:
            import traceback
            traceback.print_exc()
            RES.append((fn.__name__ + "（异常）", False))
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".tmp", ".corrupt", ".lock"):
        T.remove_any(STATE + ext)
    print("\n---- 汇总 ----")
    for n, ok in RES:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    bad = [n for n, ok in RES if not ok]
    print("总判定:", "ALL PASS" if not bad else f"有失败 -> {bad}")
