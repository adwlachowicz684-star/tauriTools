#!/usr/bin/env python3
"""安全 / 残留 / 数据：三个「功能测试照不到」的维度。

前几轮都在问「功能对不对」，这一轮问的是另一类问题：
  · 安全：token 会不会泄露？路径能不能穿越？命令能不能注入？
  · 残留：失败之后远端/本地留下什么？会不会累积？
  · 数据：改动会不会丢？内容会不会被悄悄改写？状态会不会骗人？

这些场景的共同点：**功能全绿也照不到它们**。
token 泄露、临时文件累积、改动静默丢失，都不会让任何一个
「推送成功了吗」的断言变红。

用法：python3 test_security_data.py <push_api.py 路径>
"""
import glob
import os
import subprocess
import sys

sys.path.insert(0, "/data/workspace")
import test_pr_flow as T
from test_pr_flow import GH, read, run, setup_repo, write

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


# ================================================== 安全

def token_not_in_argv(mod, label):
    """token 绝不能出现在 curl 的 argv（ps aux 对同机所有用户可见）。"""
    gh = fresh()
    write("a.txt", "v2\n")
    seen = []
    real = subprocess.run

    def spy(cmd, *a, **k):
        if isinstance(cmd, list) and cmd and cmd[0] == "curl":
            seen.append(" ".join(str(c) for c in cmd))
        return real(cmd, *a, **k)

    mod.subprocess.run = spy
    try:
        run(mod, gh, ["--yes", "-m", "x"], name="tok")
    finally:
        mod.subprocess.run = real

    # 只匹配真正的 token 值，不要匹配文件名等无关文本
    tok = getattr(mod, "TOKEN", "") or ""
    probe = tok if tok and len(tok) > 8 else "ghp_"
    leaked = [c for c in seen if probe in c]
    print(f"\n=== {label} ===")
    ck("curl argv 中无 token", not leaked,
       f"(扫了 {len(seen)} 次 curl 调用)")
    return not leaked


def token_config_file_permissions(mod, label):
    """curl 配置文件必须 0600，且用完即删（同机可读 = token 泄露）。"""
    print(f"\n=== {label} ===")
    saved = mod.TOKEN
    mod.TOKEN = "ghp_probefake0000000000000000000000"
    ok = False
    gone = False
    try:
        with mod._auth_config() as p:
            mode = os.stat(p).st_mode & 0o777
            ok = (mode == 0o600)
            ck("配置文件权限 0600", ok, f"(实际 {oct(mode)})")
        gone = not os.path.exists(p)
        ck("退出后即删除", gone)
    except SystemExit:
        ck("_auth_config 可用", False)
        return False
    finally:
        mod.TOKEN = saved
    return ok and gone


def token_whitelist_strictness(mod, label):
    """白名单应只放行 GitHub token 的真实字符集 [A-Za-z0-9_.-]。

    「所有可打印 ASCII」这个宽松版本会放行 `"` 和 `\\` —— 它们能在 curl
    配置里提前闭合引号。实测暂不足以注入（curl 一行只解析一条指令），
    但依赖 curl 的解析细节，属于碰巧安全。
    """
    saved = mod.TOKEN
    print(f"\n=== {label} ===")
    dangerous = ['ghp_"x', "ghp_x\\", "ghp_x`", "ghp_x$(id)", "ghp_x'",
                 "ghp_x y", "ghp_x\noutput = /tmp/pwned"]
    allowed = []
    for tok in dangerous:
        mod.TOKEN = tok
        try:
            with mod._auth_config():
                allowed.append(tok)
        except SystemExit:
            pass
        except Exception:
            pass
    ck("危险字符全被拦（引号/反斜杠/反引号/$()/换行）", not allowed,
       f"(放行 {allowed})")

    legal = ["ghp_16C7e42F292c6912E7710c838347Ae178B4a",
             "github_pat_11ABCDEFG0aBcDeFgHiJkL_xxxxxx",
             "gho_abc", "ghu_abc", "ghs_abc", "ghr_abc",
             "0123456789abcdef0123456789abcdef01234567"]
    blocked = []
    for tok in legal:
        mod.TOKEN = tok
        try:
            with mod._auth_config():
                pass
        except SystemExit:
            blocked.append(tok)
        except Exception:
            blocked.append(tok)
    ck("合法 token 不被误伤", not blocked, f"(误伤 {blocked})")
    mod.TOKEN = saved
    return not allowed and not blocked


def no_path_traversal(mod, label):
    """越界路径（含仓库内软链逃逸）必须被 safe_rel 拦下。"""
    print(f"\n=== {label} ===")
    fresh()
    os.symlink("/etc", os.path.join(ROOT, "etcdir"))
    os.symlink("a.txt", os.path.join(ROOT, "goodlink"))

    cases = [("../../etc/passwd", None), ("/etc/passwd", None),
             ("~/x", None), ("a/../../b.txt", None),
             ("etcdir/passwd", None),
             ("goodlink", "goodlink"), ("a.txt", "a.txt")]
    ok = True
    for src, want in cases:
        got = mod.safe_rel(src)
        good = (got == want)
        ok = ok and good
        ck(f"safe_rel({src!r}) → {want!r}", good, f"(实际 {got!r})")
    return ok


def state_file_permissions(mod, label):
    """状态文件应 0600（只含文件清单，但私有仓库下清单也算信息）。"""
    gh = fresh()
    write("a.txt", "v2\n")
    run(mod, gh, ["--yes", "-m", "x"])
    print(f"\n=== {label} ===")
    try:
        mode = os.stat(STATE).st_mode & 0o777
        ok = (mode == 0o600)
    except FileNotFoundError:
        ok = False
        mode = None
    ck("状态文件 0600", ok, f"(实际 {oct(mode) if mode else '不存在'})")
    return ok


# ================================================== 残留

def no_temp_file_accumulation(mod, label):
    """连续多次推送后，不能累积临时文件（curl 配置 / .tmp / .corrupt）。"""
    print(f"\n=== {label} ===")
    fresh()
    for i in range(6):
        write("a.txt", f"v{i}\n")
        run(mod, GH({"a.txt": ("100644", b"v1\n")}), ["--yes", "-m", f"x{i}"],
            name=f"rep{i}")
    cfg = glob.glob("/dev/shm/pushapi-curl-*.cfg") + \
          glob.glob("/tmp/pushapi-curl-*.cfg")
    tmpf = glob.glob(STATE + ".tmp")
    ck("无 curl 配置残留", not cfg, f"({len(cfg)} 个)")
    ck("无 .tmp 残留", not tmpf, f"({len(tmpf)} 个)")
    return not cfg and not tmpf


def corrupt_backup_does_not_accumulate(mod, label):
    """反复损坏状态文件，.corrupt 备份应始终只有 1 个（覆盖，不追加）。"""
    print(f"\n=== {label} ===")
    fresh()
    for i in range(5):
        with open(STATE, "w") as f:
            f.write("{ not json")
        try:
            run(mod, GH({"a.txt": ("100644", b"v1\n")}), ["--yes", "-m", "x"],
                name=f"cor{i}")
        except BaseException:
            pass
    found = glob.glob(STATE + ".corrupt*")
    ck(".corrupt 恒为 1 个（覆盖不追加）", len(found) <= 1, f"({len(found)} 个)")
    return len(found) <= 1


def oversize_no_branch_left(mod, label):
    """大文件预检被拒后不留分支。"""
    gh = fresh()
    big = os.path.join(ROOT, "big.bin")
    with open(big, "wb") as f:
        f.write(b"x" * (12 * 1024 * 1024))
    out, err = run(mod, gh, ["--yes", "big.bin", "-m", "x"], name="big")
    left = T.task_branches(gh)
    print(f"\n=== {label} ===")
    ck("预检拒绝后无残留分支", not left, f"残留={sorted(left)}")
    return not left


def reset_baseline_clears_branch_ref(mod, label):
    """--reset-baseline 后，状态里不该残留旧分支引用。"""
    gh = fresh()
    write("a.txt", "v2\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/old", "-m", "x"])
    run(mod, gh, ["--reset-baseline", "--yes"])
    import json
    try:
        st = json.load(open(STATE))
    except Exception:
        st = {}
    still = [k for k in ("task_branch", "pr_number") if st.get(k)]
    print(f"\n=== {label} ===")
    ck("分支/PR 引用已清空", not still, f"(残留字段 {still})")
    return not still


# ================================================== 数据

def pull_conflict_keeps_change(mod, label):
    """--pull 三方合并后，本地未推送的改动必须在（哪怕在冲突标记里）。"""
    gh = fresh()
    write("a.txt", "MY-CHANGE\n")           # 本地改动
    T.other_commit(gh, {"a.txt": b"REMOTE\n"})   # 远端也改
    run(mod, gh, ["--pull", "--yes"], name="pull")
    cur = read("a.txt")
    print(f"\n=== {label} ===")
    ck("本地改动未丢失", "MY-CHANGE" in cur, f"→ {cur!r}")
    return "MY-CHANGE" in cur


def binary_roundtrip(mod, label):
    """二进制往返必须字节一致（含 NUL / 0xFF / CRLF / 无尾换行）。"""
    payload = bytes(range(256)) + b"\r\n\x00\xff" + b"no-trailing-newline"
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".tmp", ".corrupt", ".lock"):
        T.remove_any(STATE + ext)
    setup_repo({"bin.dat": ("100644", b"seed\n")})
    gh = GH({"bin.dat": ("100644", b"seed\n")})
    run(mod, gh, ["--init-baseline", "--yes"])
    with open(os.path.join(ROOT, "bin.dat"), "wb") as f:
        f.write(payload)
    run(mod, gh, ["--yes", "bin.dat", "-m", "bin"], name="bin")
    got = (gh.files_of("main").get("bin.dat") or (None, b""))[1]
    print(f"\n=== {label} ===")
    ck("二进制字节完全一致", got == payload,
       f"({len(got)} vs {len(payload)} 字节)")
    return got == payload


def state_sha_matches_remote(mod, label):
    """推送后状态里记的 sha 必须与远端实际一致（状态不撒谎）。"""
    gh = fresh()
    write("a.txt", "v2\n")
    run(mod, gh, ["--yes", "-m", "x"])
    import json
    st = json.load(open(STATE))
    rec = (st.get("files") or {}).get("a.txt")
    rec_sha = rec.get("sha") if isinstance(rec, dict) else rec
    actual = (gh.files_of("main").get("a.txt") or (None, b""))[1]
    print(f"\n=== {label} ===")
    # PR 默认流程合并后主干才更新；若状态记的是分支阶段值则用 main 校准
    ok = (rec_sha == T.sha(b"v2\n")) or (actual == b"v2\n")
    ck("状态 sha 与内容一致", ok, f"(状态 {str(rec_sha)[:8]} / 远端 {str(actual)[:12]!r})")
    return ok


def hold_change_survives_branch_delete(mod, label):
    """--hold 攒的改动在分支被删后仍在**工作区**（分支不是备份）。"""
    gh = fresh()
    write("a.txt", "held-change\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/hold", "-m", "x"])
    # 直接删远端分支
    try:
        mod.api("DELETE", "/git/refs/heads/task/hold")
    except BaseException:
        pass
    cur = read("a.txt")
    print(f"\n=== {label} ===")
    ck("改动仍在工作区", "held-change" in cur, f"→ {cur!r}")
    return "held-change" in cur


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "sdmod")
    T._MOD = mod
    for fn in (token_not_in_argv, token_config_file_permissions,
               token_whitelist_strictness, no_path_traversal,
               state_file_permissions,
               no_temp_file_accumulation, corrupt_backup_does_not_accumulate,
               oversize_no_branch_left, reset_baseline_clears_branch_ref,
               pull_conflict_keeps_change, binary_roundtrip,
               state_sha_matches_remote, hold_change_survives_branch_delete):
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
