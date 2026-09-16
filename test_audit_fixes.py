#!/usr/bin/env python3
"""本轮代码审查修复项的常驻回归。

背景：修复前 12 套测试 770+ 断言全绿、pyflakes 零告警，但下面这些
一条都没覆盖 —— 它们的共同点是「工具自己声明要保证的语义，实现里没兜住」。
现有测试的视角停留在「功能对不对」，照不到「防线内侧漏了」。

对应审查报告：
  §2  ref_sha 未编码 → 读到另一个分支的 sha
  §3  --delete-branch 不查 PROTECTED_BRANCHES
  §4  workflow 未知值静默退化成直推主干
  §5  仓库根是软链时读侧放行、写侧拒绝
  §6  curl 网络层失败对非幂等写也重试
  §7  冲突副产物目录权限 0777 / files 值形态未校验

用法：python3 test_audit_fixes.py <push_api.py 路径>
"""
import os
import subprocess
import sys

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


# ============================================ §2 ref_sha 编码

def ref_sha_encodes_special_chars(mod, label):
    """分支名含 ? / # / 空格时，ref_sha 必须返回**该分支自己**的 sha。

    修复前 ref_sha 裸拼 f"/git/refs/heads/{branch}"：分支名含 `?` 时其后
    部分被当成 query string 丢掉，请求打到**另一个分支**上 —— 不报错，
    只是静默返回一个看似合理的值（实测：查 task/a?b 返回 task/a 的 sha）。

    判据必须是「拿到自己的 sha」而不是「不报错」：错误实现也返回 2xx，
    只判「没抛异常」的测试会全绿放行（这类假阳性在本仓库已踩过多次）。
    """
    gh = fresh()
    mod.api = gh.api
    gh.refs["task/a"] = "a" * 40
    gh.refs["task/b#c"] = "b" * 40
    gh.refs["task/d?e"] = "d" * 40
    gh.refs["task/f g"] = "f" * 40

    print(f"\n=== {label} ===")
    ok = True
    for name, want in (("task/a", "a" * 40), ("task/b#c", "b" * 40),
                       ("task/d?e", "d" * 40), ("task/f g", "f" * 40)):
        got = mod.ref_sha(name)
        good = (got == want)
        ok = ok and good
        ck(f"ref_sha({name!r}) 拿到自己的 sha", good,
           f"(期望 {want[:8]} 实际 {str(got)[:8]})")
    return ok


def ref_sha_missing_branch_still_none(mod, label):
    """边界：分支不存在仍必须返回 None（不能因为改编码就变成报错）。"""
    gh = fresh()
    mod.api = gh.api
    gh.refs["task/x"] = "c" * 40
    print(f"\n=== {label} ===")
    got = mod.ref_sha("task/nope?really")
    ck("不存在的分支返回 None", got is None, f"(实际 {str(got)[:12]})")
    return got is None


# ============================================ §3 受保护分支

def delete_protected_branch_rejected(mod, label):
    """--delete-branch 不得删 PROTECTED_BRANCHES 里的分支。

    PROTECTED_BRANCHES 在 prune() 里是排除名单，却从没在删除侧生效 ——
    于是同一份常量在报告侧说「别动它」、在删除侧照删（实测 develop 被删）。

    必须**不受 --yes 影响**：--yes 是脚本文档自己推荐的用法，而「确认」
    不能授权删除一条长期集成分支。
    """
    print(f"\n=== {label} ===")
    ok = True
    for br in ("develop", "release", "master"):
        gh = fresh()
        gh.refs[br] = "c" + "0" * 39
        # 带 --yes 也要拦：这正是最容易漏的形态
        out, err = run(mod, gh, ["--delete-branch", br, "--yes"], name="del")
        rejected = err is not None and "受保护" in str(err)
        survived = br in gh.refs
        good = rejected and survived
        ok = ok and good
        ck(f"--delete-branch {br} --yes 被拒", good,
           f"(拒绝={rejected} 仍在={survived})")
    return ok


def delete_task_branch_still_works(mod, label):
    """边界：任务分支照常可删（不能因为加了保护就一刀切）。"""
    gh = fresh()
    gh.refs["task/ok"] = "c" + "0" * 39
    print(f"\n=== {label} ===")
    out, err = run(mod, gh, ["--delete-branch", "task/ok", "--yes"], name="deltask")
    ck("task/* 分支仍可删除", "task/ok" not in gh.refs,
       f"(err={str(err)[:40]})")
    return "task/ok" not in gh.refs


def delete_main_still_rejected(mod, label):
    """边界：主干仍由第一道闸拦（BRANCH 与 PROTECTED 的交集不能重复报错）。"""
    gh = fresh()
    print(f"\n=== {label} ===")
    out, err = run(mod, gh, ["--delete-branch", "main", "--yes"], name="delmain")
    ck("主干仍被拒", err is not None and "主干" in str(err),
       f"→ {str(err)[:40]}")
    return err is not None and "主干" in str(err)


# ============================================ §4 workflow 未知值

def unknown_workflow_refuses(mod, label):
    """workflow 取值未知时必须报错，不能静默退化成 direct。

    PR 分支判据是精确匹配 wf == "pr"，而 direct 是「else」—— 任何非 "pr"
    的值都会静默落到 direct，即绕过 PR 流程直推主干（实测：workflow="PR"
    时无分支、无 PR，改动直接上主干）。
    """
    gh = fresh()
    import json as _j
    st = _j.load(open(STATE))
    # 用**真正未知**的取值：大小写差异（"PR"）应被 lower() 容忍，
    # 那是 workflow_case_insensitive_ok 的领地；这里要验的是未知值。
    st["workflow"] = "staging"
    _j.dump(st, open(STATE, "w"))

    write("a.txt", "v2\n")
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="wf")
    print(f"\n=== {label} ===")
    ck("未知 workflow 报错中止", err is not None and "workflow" in str(err).lower(),
       f"→ {str(err)[:60]}")
    ck("没有偷偷直推主干", main_file(gh, "a.txt") == "v1\n",
       f"(主干={main_file(gh, 'a.txt')!r})")
    return (err is not None and "workflow" in str(err).lower()
            and main_file(gh, "a.txt") == "v1\n")


def workflow_case_insensitive_ok(mod, label):
    """workflow 大小写差异应被容忍（只报错未知值，不误伤大小写）。"""
    gh = fresh()
    import json as _j
    st = _j.load(open(STATE))
    st["workflow"] = "Direct"
    _j.dump(st, open(STATE, "w"))
    write("a.txt", "v2\n")
    out, err = run(mod, gh, ["--yes", "-m", "x"], name="wf2")
    print(f"\n=== {label} ===")
    ck("'Direct' 被正常识别（直推主干）",
       err is None and main_file(gh, "a.txt") == "v2\n",
       f"(err={str(err)[:40]} 主干={main_file(gh, 'a.txt')!r})")
    return err is None and main_file(gh, "a.txt") == "v2\n"


# ============================================ §5 仓库根软链

def symlink_write_when_root_is_link(mod, label):
    """仓库根本身是软链时，读侧放行 / 写侧也必须放行。

    修复前读侧用 realpath(ROOT) 比、写侧拿裸 ROOT 比 —— 一边解析一边不
    解析。结果是同一个合法路径 safe_rel 通过、_write_local 判成「指向
    仓库外」并 SystemExit，中断**整个** --pull（实测复现）。
    """
    link = ROOT + "_link"
    if os.path.lexists(link):
        os.unlink(link)
    fresh({"k.txt": ("100644", b"k\n")})
    os.symlink(ROOT, link)

    print(f"\n=== {label} ===")
    try:
        mod.ROOT = link
        got_rel = mod.safe_rel("s2")
        mod._write_local("s2", b"k.txt", "120000")
        read_ok = (got_rel == "s2")
        write_ok = os.path.islink(os.path.join(ROOT, "s2"))
        err = None
    except SystemExit as e:
        read_ok = write_ok = False
        err = str(e).splitlines()[0][:60]
    finally:
        mod.ROOT = ROOT
        if os.path.lexists(link):
            os.unlink(link)

    ck("读侧 safe_rel 放行", read_ok)
    ck("写侧 _write_local 放行（两侧一致）", write_ok, f"(err={err})")
    return read_ok and write_ok


def symlink_escape_still_rejected(mod, label):
    """边界：真的越界仍然必须被拒（改基准不能把防护改没了）。"""
    fresh({"k.txt": ("100644", b"k\n")})
    print(f"\n=== {label} ===")
    ok = True
    for tgt in (b"/etc/passwd", b"../../etc/passwd"):
        try:
            mod.ROOT = ROOT
            mod._write_local("s3", tgt, "120000")
            rejected, msg = False, "(未拒绝)"
        except SystemExit as e:
            rejected, msg = True, str(e).splitlines()[0][:40]
        except Exception as e:
            rejected, msg = False, f"💥{type(e).__name__}"
        ok = ok and rejected
        ck(f"拒绝越界目标 {tgt!r}", rejected, f"→ {msg}")
    return ok


# ============================================ §6 curl 网络层失败重试

def _curl_fail_calls(mod, method, path, exitcode=7, retries=3):
    """注入一次 curl 网络层失败，返回 (结果类型, 调用次数)。

    必须先设 TOKEN：api() 第一句就是 require_token()，而 T.load_mod 加载
    的模块 TOKEN 取自环境变量（本环境没有）→ 直接 SystemExit，调用次数
    为 0，于是「不重试」和「重试」两种实现**都**能让断言通过 ——
    又是一个静默假阳性。test_real_curl.py 里那句 m.TOKEN = ... 不是装饰。
    """
    mod.TOKEN = "ghp_fake_for_test"
    real = subprocess.run
    st = {"n": 0}

    def fake(cmd, *a, **k):
        if isinstance(cmd, list) and cmd and cmd[0] == "curl":
            st["n"] += 1

            class R:
                returncode = exitcode
            R.stdout = ""
            R.stderr = "connection trouble"
            return R()
        return real(cmd, *a, **k)

    mod.subprocess.run = fake
    real_sleep = mod.time.sleep
    mod.time.sleep = lambda s: None
    try:
        mod.api(method, path, payload={} if method != "GET" else None,
                retries=retries)
        kind = "成功"
    except SystemExit:
        kind = "SystemExit"
    except Exception as e:
        kind = f"💥{type(e).__name__}"
    finally:
        mod.subprocess.run = real
        mod.time.sleep = real_sleep
    return kind, st["n"]


def _fresh_mod(mod, name="curlmod"):
    """从 mod.__file__ 重新加载一份**独立**实例。

    不能复用套件共用的那个 mod：前面的用例跑过 run()，而 run() 会执行
    `mod.api = gh.api` 把 api 换成**假服务端** —— 于是 mod.api 压根不走
    subprocess.run，故障注入不生效、调用次数恒为 0。

    那样一来「重试」与「不重试」两种实现都能让断言通过 —— 假阳性，
    而且是最难发现的一种：它让测试看起来在验证，实际什么都没验。
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, mod.__file__)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def curl_failure_no_retry_on_writes(mod, label):
    """curl 网络层失败（7/52/56）对非幂等写不得重试。

    这类失败与「响应丢了」无法区分：服务端可能已处理完，只是传输中断。
    PATCH /git/refs 重试会撞 422，而调用方那句「出现并发提交，已中止」
    会把**自己的重试**误报成他人抢先提交 —— 用户据此去排查一个根本
    不存在的并发（_retryable() 的注释里逐字写了这个后果）。

    修复前这里无条件重试，与 api() docstring「同样过 _retryable」的声明
    不一致；而两种写法都能让原测试全绿（该路径 100% 无覆盖）。
    """
    print(f"\n=== {label} ===")
    # 独立实例：共用 mod 的 api 已被前面用例换成假服务端（见 _fresh_mod 说明）
    fm = _fresh_mod(mod)
    ok = True
    for m_, p_ in (("PATCH", "/git/refs/heads/x"),
                   ("POST", "/git/commits"),
                   ("POST", "/git/trees"),
                   ("POST", "/pulls")):
        kind, n = _curl_fail_calls(fm, m_, p_)
        good = (n == 1)
        ok = ok and good
        ck(f"{m_} {p_} 网络失败不重试", good, f"→ 调用 {n} 次（{kind}）")

    # GET 仍应重试（幂等），别矫枉过正
    kind, n = _curl_fail_calls(fm, "GET", "/git/blobs/" + "a" * 40)
    ck("GET 网络失败仍重试", n == 3, f"→ 调用 {n} 次")
    return ok and n == 3


# ============================================ §7 冲突副产物权限 / files 形态

def _fs_supports_mode(d):
    """该目录所在文件系统是否真的支持权限位。

    /data/workspace 是 virtiofs 挂载：chmod **静默无效**（一律 0777），
    实测 open(mode=0o600) 也拿不到 0600。与 _exec_bit_reliable() 处理的
    「文件系统不区分权限」是同一类环境限制。

    不支持时必须**跳过并说明**，不能判 FAIL —— 那会把环境限制伪装成
    代码缺陷，让人去改一段本来正确的代码。
    """
    p = os.path.join(d, "_perm_probe")
    try:
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.close(fd)
        os.chmod(p, 0o600)
        got = os.stat(p).st_mode & 0o777
        return got == 0o600
    except OSError:
        return False
    finally:
        try:
            os.unlink(p)
        except OSError:
            pass


def conflict_artifacts_are_private(mod, label):
    """冲突副产物目录 0700、文件 0600 —— 里面是完整的远端明文内容。

    状态文件只含文件名清单都已收紧到 0600（私有仓库下清单也算信息），
    含明文的副产物目录反而 0777 就说不过去了（实测）。
    """
    gh = fresh()
    write("a.txt", "MY-CHANGE\n")
    T.other_commit(gh, {"a.txt": b"REMOTE\n"})
    run(mod, gh, ["--pull", "--yes"], name="cf")

    print(f"\n=== {label} ===")
    d = mod.CONFLICT_DIR
    if not os.path.isdir(d):
        ck("冲突目录已生成", False, "(未生成，无法验证权限)")
        return False
    if not _fs_supports_mode(d):
        print("     ⚠ 该文件系统不支持权限位（chmod 无效，实测一律 0777），"
              "跳过权限断言")
        print("       目录 " + str(d))
        ck("权限位可验证（环境不支持 → 跳过）", True, "SKIP")
        return True
    dmode = os.stat(d).st_mode & 0o777
    ck(f"目录 {d} 权限 0700", dmode == 0o700, f"(实际 {oct(dmode)})")

    files = [os.path.join(d, n) for n in os.listdir(d)
             if os.path.isfile(os.path.join(d, n))]
    if not files:
        ck("有副产物文件可查", False, "(目录为空)")
        return False
    bad = []
    for p in files:
        m = os.stat(p).st_mode & 0o777
        if m != 0o600:
            bad.append((os.path.basename(p), oct(m)))
    ck(f"{len(files)} 个副产物文件权限 0600", not bad, f"(异常 {bad[:3]})")
    return dmode == 0o700 and not bad


def state_files_mode_rejected(mod, label):
    """基线 files 里的 mode/sha 写成非字符串必须被拦。

    只查 dict 形态的话 {"mode": 100755, "sha": 123} 能过校验，然后在
    `(lmode, lsha) == (rmode, rsha)` 比较时永远为假 → 永久误报「远端被
    他人改动」，且没有任何提示指向真正的原因。
    """
    print(f"\n=== {label} ===")
    fresh()
    import json as _j
    cases = {
        "mode 是 int": {"version": 2, "conflicts": [],
                        "files": {"a.txt": {"mode": 100755, "sha": "s" * 40}}},
        "sha 是 int": {"version": 2, "conflicts": [],
                       "files": {"a.txt": {"mode": "100644", "sha": 123}}},
    }
    ok = True
    for name, bad in cases.items():
        _j.dump(bad, open(STATE, "w"))
        try:
            mod.STATE_PATH = STATE
            mod.load_state()
            caught, msg = False, "(未拦截)"
        except SystemExit as e:
            caught, msg = True, str(e).splitlines()[0][:44]
        except Exception as e:
            caught, msg = False, f"💥{type(e).__name__}"
        ok = ok and caught
        ck(f"拦下 {name}", caught, f"→ {msg}")

    # 合法形态不能被误伤
    _j.dump({"version": 2, "conflicts": [],
             "files": {"a.txt": {"mode": "100644", "sha": "s" * 40}}},
            open(STATE, "w"))
    try:
        st = mod.load_state()
        good = isinstance(st, dict)
    except SystemExit:
        good, st = False, None
    ck("合法形态未被误伤", good, f"→ {str(st)[:40]}")
    return ok and good


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "afmod")
    T._MOD = mod
    for fn in (ref_sha_encodes_special_chars, ref_sha_missing_branch_still_none,
               delete_protected_branch_rejected, delete_task_branch_still_works,
               delete_main_still_rejected,
               unknown_workflow_refuses, workflow_case_insensitive_ok,
               symlink_write_when_root_is_link, symlink_escape_still_rejected,
               curl_failure_no_retry_on_writes,
               conflict_artifacts_are_private, state_files_mode_rejected):
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
