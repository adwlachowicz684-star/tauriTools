#!/usr/bin/env python3
"""推送**中途失败**时会留下什么。

前几轮的测试几乎都在验证「成功时行为是否正确」，而可靠性真正的差别
在于「失败时留下什么」—— 这个维度以前是空白，本套件一上来就是红的。

核心场景：分支在建 blob **之前**创建，于是后面每一步失败都会留下一个
空分支，而本地状态文件的 tasks 里根本没有它（那要 PATCH 成功之后才写），
用户只能靠 --prune 才发现。

最典型的是大文件预检被拒：改了个 12MB 文件、推送、被拒 ——
远端已经多了一个空分支，用户完全不知道。

用法：python3 test_push_failpoints.py <push_api.py 路径>
"""
import os
import sys

sys.path.insert(0, "/data/workspace")
import test_pr_flow as T
from test_pr_flow import GH, run, setup_repo, write, task_branches

ROOT, STATE = T.ROOT, T.STATE
RES = []


def ck(name, ok, extra=""):
    RES.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {extra}")


def fresh(files, big=None):
    """建仓库。big=(path, n_mb) 时额外造一个超大文件。"""
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt"):
        T.remove_any(STATE + ext)
    setup_repo(files)
    gh = GH(files)
    run(T._MOD, gh, ["--init-baseline", "--yes"])
    if big:
        p, mb = big
        full = os.path.join(ROOT, p)
        os.makedirs(os.path.dirname(full) or ROOT, exist_ok=True)
        with open(full, "wb") as f:
            f.write(b"x" * (mb * 1024 * 1024))
    return gh


def _fail_at(mod, gh, substr, times=1):
    """让匹配 substr 的 API 调用失败（1 = 只让第一次失败）。

    必须包装 **gh.api**，不能替换 mod.api：test_pr_flow.run() 每次都会
    执行 `mod.api = gh.api`，直接改 mod.api 会被它覆盖掉 —— 那样注入
    根本没生效，推送照常成功，而「无残留分支」的断言也照样通过
    （成功推送合并后分支本就会被删）。实测踩过：5 个用例全是这种假阳性。

    所以每个用例都要额外断言「推送确实失败了」，否则测了个寂寞。
    """
    real = gh.api
    st = {"n": 0}

    def fake(method, path, *a, **k):
        if substr in str(path) and st["n"] < times:
            st["n"] += 1
            raise SystemExit(f"注入失败：{method} {path}")
        return real(method, path, *a, **k)

    gh.api = fake
    try:
        return run(mod, gh, ["--yes", "-m", "x"], name="failpoint")
    except BaseException as e:
        return "", e
    finally:
        gh.api = real


def _no_leftover(gh):
    return not task_branches(gh)


# ------------------------------------------------ 各失败点

def fail_first_blob(mod, label):
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")
    out, err = _fail_at(mod, gh, "/git/blobs")
    left = task_branches(gh)
    failed = err is not None or "注入失败" in out
    print(f"\n=== {label} ===")
    ck("注入生效（推送确实失败）", failed, f"err={str(err)[:36]}")
    ck("建第 1 个 blob 失败后无残留分支", not left, f"残留={left}")
    return failed and not left


def fail_second_blob(mod, label):
    """两个文件：让第 2 个 blob 失败（第 1 个已建好）。"""
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt"):
        T.remove_any(STATE + ext)
    setup_repo({"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"v1\n")})
    gh = GH({"a.txt": ("100644", b"v1\n"), "b.txt": ("100644", b"v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"])
    write("a.txt", "v2\n")
    write("b.txt", "v2\n")
    out, err = _fail_at(mod, gh, "/git/blobs", times=2)
    left = task_branches(gh)
    failed = err is not None or "注入失败" in out
    print(f"\n=== {label} ===")
    ck("注入生效（推送确实失败）", failed, f"err={str(err)[:36]}")
    ck("建第 2 个 blob 失败后无残留分支", not left, f"残留={left}")
    return failed and not left


def fail_tree(mod, label):
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")
    out, err = _fail_at(mod, gh, "/git/trees")
    left = task_branches(gh)
    failed = err is not None or "注入失败" in out
    print(f"\n=== {label} ===")
    ck("注入生效（推送确实失败）", failed, f"err={str(err)[:36]}")
    ck("建 tree 失败后无残留分支", not left, f"残留={left}")
    return failed and not left


def fail_commit(mod, label):
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")
    out, err = _fail_at(mod, gh, "/git/commits")
    left = task_branches(gh)
    failed = err is not None or "注入失败" in out
    print(f"\n=== {label} ===")
    ck("注入生效（推送确实失败）", failed, f"err={str(err)[:36]}")
    ck("建 commit 失败后无残留分支", not left, f"残留={left}")
    return failed and not left


def fail_oversize_precheck(mod, label):
    """用户最容易撞的：大文件预检被拒。

    预检在建分支之后，所以修复前会留下一个空分支。
    """
    gh = fresh({"a.txt": ("100644", b"v1\n")}, big=("big.bin", 12))
    out, err = run(mod, gh, ["--yes", "big.bin", "-m", "x"], name="oversize")
    left = task_branches(gh)
    rejected = "上限" in out or "上限" in str(err or "")
    print(f"\n=== {label} ===")
    ck("确实被预检拒绝", rejected)
    ck("预检失败后无残留分支", not left, f"残留={left}")
    return rejected and not left


# ------------------------------------------------ 清理本身的安全性

def cleanup_keeps_hold_branch(mod, label):
    """--hold 复用的分支里已有用户攒的改动，失败时**不能**删。

    补偿清理只能删本次新建的分支；删掉复用分支会丢掉用户已推的内容。
    """
    gh = fresh({"h.txt": ("100644", b"v1\n")})
    write("h.txt", "v2\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/keep", "-m", "第一次"])

    write("h.txt", "v3\n")
    out, err = _fail_at(mod, gh, "/git/trees")     # 复用分支时推送失败
    left = task_branches(gh)
    print(f"\n=== {label} ===")
    ck("复用的 --hold 分支被保留", "task/keep" in left, f"分支={left}")
    return "task/keep" in left


def cleanup_silent_on_network_error(mod, label):
    """清理本身失败时不能掩盖真正的错误。

    注入同样要包装 gh.api（run() 会覆盖 mod.api），并且要按 **method + path**
    精确匹配：只按子串 "/git/trees" 会误伤 preview 拉远端 blob 的 GET 请求，
    那样失败发生在 preview 而非建 tree，断言就跑偏了。
    """
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")

    real = gh.api
    st = {"n": 0}

    def fake(method, path, *a, **k):
        if method == "POST" and "/git/trees" in str(path) and st["n"] < 1:
            st["n"] += 1
            raise SystemExit("注入失败：建 tree")
        if method == "DELETE":                     # 清理也挂了
            raise SystemExit("注入失败：清理分支")
        return real(method, path, *a, **k)

    gh.api = fake
    try:
        _, err = run(mod, gh, ["--yes", "-m", "x"], name="cleanup-fail")
    except BaseException as e:
        err = e              # 未捕获异常路径：不需要 out
    finally:
        gh.api = real

    msg = str(err or "")
    print(f"\n=== {label} ===")
    ck("报的是真正的错误（建 tree），不是清理失败",
       "建 tree" in msg, f"→ {msg.splitlines()[0][:50] if msg else '(无)'}")
    return "建 tree" in msg


def fail_after_patch_no_orphan(mod, label):
    """PATCH 成功之后、开 PR 之前中断 → 不得留下孤儿分支。

    报告第 8 轮实测：这个中断点是唯一会留残留的。大文件刚传完用户
    最容易在这里 Ctrl-C，而分支上**已经有内容**了（不只是空分支），
    本地 tasks 里却没它 —— 只能靠 --prune 偶然发现。

    修法是把 PATCH 和紧随其后的本地 commit 一并纳入补偿清理的 try。
    """
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")

    # 注入点在 **git add** —— PATCH 成功后的第一步。
    # 不能注入在 PATCH 调用本身：那还在 try 内（无论修复与否都在），
    # 两种代码行为一致，测不出差异（实测：这样写坏副本也全绿）。
    real_git = mod.git
    st = {"n": 0}

    def flaky(*args, **k):
        if args and args[0] == "add" and st["n"] < 1:
            st["n"] += 1
            raise KeyboardInterrupt("模拟 Ctrl-C")
        return real_git(*args, **k)

    mod.git = flaky
    try:
        run(mod, gh, ["--yes", "-m", "x"], name="after-patch")
    except BaseException:
        pass                                  # KeyboardInterrupt 不该冒出去
    finally:
        mod.git = real_git

    left = sorted(task_branches(gh))
    print(f"\n=== {label} ===")
    ck("PATCH 后中断无孤儿分支", not left, f"残留={left}")
    return not left


def fail_local_commit_no_orphan(mod, label):
    """本地 git commit 阶段中断（KeyboardInterrupt）也不留分支。

    KeyboardInterrupt 是 BaseException 的子类，except Exception 抓不到 ——
    所以补偿清理必须用 BaseException，这点现有代码是对的，但要锁住。
    """
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")

    real_git = mod.git
    st = {"n": 0}

    def flaky(*args, **k):
        # 注意实参形式：脚本调的是 git("-c","user.name=...","commit",...)，
        # args[0] 是 "-c" 而不是 "commit"。按 args[0] 匹配会永远不命中
        # —— 那样用例恒绿，坏副本也测不出来（实测踩过）。
        if "commit" in args and st["n"] < 1:
            st["n"] += 1
            raise KeyboardInterrupt("模拟 Ctrl-C")
        return real_git(*args, **k)

    mod.git = flaky
    try:
        run(mod, gh, ["--yes", "-m", "x"], name="local-commit")
    except BaseException:
        pass
    finally:
        mod.git = real_git

    left = sorted(task_branches(gh))
    print(f"\n=== {label} ===")
    ck("本地 commit 中断无孤儿分支", not left, f"残留={left}")
    return not left


def pr_created_means_no_cleanup(mod, label):
    """边界：PR 已建出来后失败，**不该**悄悄删分支。

    清理范围停在「开 PR」之前是有意的 —— PR 有编号、能被 --prune 看见、
    也能 --merge 继续。这时该提示用户，而不是把他的东西删掉。
    """
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")

    real = gh.api
    st = {"n": 0}

    def fake(method, path, *a, **k):
        r = real(method, path, *a, **k)
        # 开完 PR 之后在合并阶段失败
        if "/pulls" in str(path) and method == "POST" and st["n"] < 1:
            st["n"] += 1
            raise SystemExit("注入失败：合并阶段")
        return r

    gh.api = fake
    try:
        run(mod, gh, ["--yes", "-m", "x"], name="after-pr")
    except BaseException:
        pass
    finally:
        gh.api = real

    left = sorted(task_branches(gh))
    print(f"\n=== {label} ===")
    ck("PR 已建时分支被保留（不静默删）", bool(left), f"分支={left}")
    return bool(left)


def second_lock_catches_race(mod, label):
    """建对象期间他人推了提交 → PATCH 前的第二遍锁必须拦下并指向 --pull。

    只查一遍是不够的：建对象（尤其大文件建 blob）耗时几十秒，那才是真正的
    并发窗口。若锁只放在建对象**之前**，改动虽仍不丢（force=False 挡住非快进），
    但报错变成 GitHub 的 422 原文 "not fast-forward" ——
    用户只会往权限/设置上猜，不知道该去 --pull。

    判据因此是「报错指向 --pull」，而不是「有没有报错」：去掉第二遍锁时
    PATCH 照样失败，但报的是 422 原文，测试若只判「失败」就会漏掉。
    """
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")

    real = gh.api
    st = {"n": 0}

    def fake(method, path, *a, **k):
        r = real(method, path, *a, **k)
        # 建完 commit 之后、PATCH 之前：他人推到主干
        if method == "POST" and "/git/commits" in str(path) and st["n"] < 1:
            st["n"] += 1
            T.other_commit(gh, {"a.txt": b"v1\nOTHER\n"})
        return r

    gh.api = fake
    try:
        _, err = run(mod, gh, ["--yes", "--direct", "-m", "x"], name="race")
    except BaseException as e:
        err = e              # 未捕获异常路径：不需要 out
    finally:
        gh.api = real

    msg = str(err or "")
    print(f"\n=== {label} ===")
    ck("确实中止了", err is not None, f"→ {msg.splitlines()[0][:50] if msg else '(无)'}")
    ck("提示去 --pull（不是 422 原文）", "--pull" in msg)
    ck("说明改动没丢", "没丢" in msg or "还在本地" in msg)
    return err is not None and "--pull" in msg and ("没丢" in msg or "还在本地" in msg)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "fpmod")
    T._MOD = mod
    for fn in (fail_first_blob, fail_second_blob, fail_tree, fail_commit,
               fail_oversize_precheck, cleanup_keeps_hold_branch,
               cleanup_silent_on_network_error,
               second_lock_catches_race,
               fail_after_patch_no_orphan, fail_local_commit_no_orphan,
               pr_created_means_no_cleanup):
        try:
            RES.append((fn.__name__, fn(mod, fn.__name__)))
        except Exception:
            import traceback
            traceback.print_exc()
            RES.append((fn.__name__ + "（异常）", False))
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt"):
        T.remove_any(STATE + ext)
    print("\n---- 汇总 ----")
    for n, ok in RES:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    bad = [n for n, ok in RES if not ok]
    print("总判定:", "ALL PASS" if not bad else f"有失败 -> {bad}")
