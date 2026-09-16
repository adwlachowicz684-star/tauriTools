#!/usr/bin/env python3
"""并发场景测试：两个 PR 同时存在 / 两人各一机同时推，会不会出问题。

验证的核心命题：
  · 跨机器并发 → GitHub 的三方合并是原子的，不会静默丢改动
  · 同一台机器并发 → 基线文件 .push-sync.json 是共享的，必须有锁
  · 真冲突 → 明确 409，谁也不覆盖谁
  · 仓库开了「分支必须最新」保护 → 第二个 PR 会被拒，改动不丢
"""
import os
import shutil
import sys
import time

import test_pr_flow as T
from test_pr_flow import GH, main_file, other_commit, read, run, setup_repo, write

# 路径带 **PID 后缀**：允许多个测试进程并发跑。
# 实测：两个进程共用固定路径时，会互相 rmtree 对方的仓库、unlink 对方的
# 状态文件，表现为大面积随机失败（17 项 FAIL），容易被误判成代码 bug。
_P = os.getpid()
A_ROOT, A_STATE = f"/tmp/_cc_a_{_P}", f"/tmp/_cc_state_a_{_P}.json"
B_ROOT, B_STATE = f"/tmp/_cc_b_{_P}", f"/tmp/_cc_state_b_{_P}.json"

LINES = "L1\nL2\nL3\nL4\nL5\nL6\nL7\n"


def _rmtree_stubborn(root, tries=5):
    """删干净；容忍 git 后台进程重建 .git 造成的残留（见 test_pr_flow 同名函数）。"""
    for _ in range(tries):
        shutil.rmtree(root, ignore_errors=True)
        if not os.path.exists(root):
            return
        time.sleep(0.05)


def fresh(files):
    """两个工作区都从同一份初始内容起步（模拟两人各 clone 了一份）。"""
    setup_repo(files, root=A_ROOT, state=A_STATE)
    setup_repo(files, root=B_ROOT, state=B_STATE)
    return GH(files)


def cleanup():
    for d in (A_ROOT, B_ROOT):
        _rmtree_stubborn(d)
    for f in (A_STATE, B_STATE):
        if os.path.exists(f):
            os.unlink(f)


# ---------------------------------------------------------------- 场景

def scene_two_hold_prs_diff_files(mod, label):
    """一人开两个并行任务（两个 --hold 分支），改不同文件，依次合并。

    --hold 不指定 -b 会复用同一分支，所以并行任务必须显式给不同 -b。
    """
    files = {"f1.txt": ("100644", b"A_v1\n"), "f2.txt": ("100644", b"B_v1\n")}
    setup_repo(files)
    gh = GH(files)
    run(mod, gh, ["--init-baseline", "--yes"])

    write("f1.txt", "A_v2\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/t1", "-m", "任务1 改 f1"])
    write("f2.txt", "B_v2\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/t2", "-m", "任务2 改 f2"])

    branches = sorted(b for b in gh.refs if b.startswith("task/"))
    two = len(branches) == 2

    run(mod, gh, ["--merge", "--yes"])
    run(mod, gh, ["--merge", "--yes"])
    f1, f2 = main_file(gh, "f1.txt"), main_file(gh, "f2.txt")

    print(f"\n=== {label} ===")
    print(f"  显式 -b 开出 2 个分支    : {two} {branches}")
    print(f"  f1 是任务1 的 A_v2       : {f1.strip() == 'A_v2'}")
    print(f"  f2 是任务2 的 B_v2       : {f2.strip() == 'B_v2'}")
    return two and f1.strip() == "A_v2" and f2.strip() == "B_v2"


def scene_two_prs_same_file_diff_lines(mod, label):
    """一人开两个 --hold 分支改**同一文件不同行**，依次合并 → 两个改动都在。

    注意 --hold 第二次的改动是叠在第一次之上的（同一个工作区），
    这正是「一人并行做两件事」的真实形态。
    """
    files = {"s.txt": ("100644", LINES.encode())}
    setup_repo(files)
    gh = GH(files)
    run(mod, gh, ["--init-baseline", "--yes"])

    write("s.txt", LINES.replace("L2", "L2-from-PR1"))
    run(mod, gh, ["--yes", "--hold", "-b", "task/p1", "-m", "PR1 改 L2"])
    # 叠在第一次之上
    write("s.txt", read("s.txt").replace("L6", "L6-from-PR2"))
    run(mod, gh, ["--yes", "--hold", "-b", "task/p2", "-m", "PR2 改 L6"])

    run(mod, gh, ["--merge", "1", "--yes"])
    run(mod, gh, ["--merge", "2", "--yes"])
    final = main_file(gh, "s.txt")

    print(f"\n=== {label} ===")
    print(f"  PR1 的 L2-from-PR1 在    : {'L2-from-PR1' in final}")
    print(f"  PR2 的 L6-from-PR2 在    : {'L6-from-PR2' in final}")
    print(f"  无冲突                   : {gh.merge_conflicts == 0}")
    return "L2-from-PR1" in final and "L6-from-PR2" in final and gh.merge_conflicts == 0


def scene_two_prs_same_line(mod, label):
    """两人各一机改**同一行** → 后合并的 409 冲突，但先合并的改动已安全落地。"""
    files = {"c.txt": ("100644", LINES.encode())}
    gh = fresh(files)
    run(mod, gh, ["--init-baseline", "--yes"], root=A_ROOT, state=A_STATE)
    run(mod, gh, ["--init-baseline", "--yes"], root=B_ROOT, state=B_STATE)

    write("c.txt", LINES.replace("L3", "L3-from-A"), root=A_ROOT)
    write("c.txt", LINES.replace("L3", "L3-from-B"), root=B_ROOT)

    # A 先推并合并
    run(mod, gh, ["--yes", "-m", "A"], root=A_ROOT, state=A_STATE)
    a_landed = "L3-from-A" in (main_file(gh, "c.txt") or "")

    # B 同步后推：主干已含 A 的改动，同一行 B 也改了 → 真冲突
    run(mod, gh, ["--pull", "--yes"], root=B_ROOT, state=B_STATE)
    marked = "<<<<<<<" in read("c.txt", root=B_ROOT)
    out_b, err_b = run(mod, gh, ["--yes", "-m", "B"], root=B_ROOT, state=B_STATE)
    # 带冲突标记 → 脚本拦下，不许把损坏文件推上去
    blocked_by_marker = err_b is not None and "冲突" in err_b

    # 主干仍是 A 的改动，没被 B 污染
    main_clean = main_file(gh, "c.txt").strip() == LINES.replace("L3", "L3-from-A").strip()
    # B 的改动还在 B 的本地
    b_kept = "L3-from-B" in read("c.txt", root=B_ROOT)

    print(f"\n=== {label} ===")
    print(f"  A 的改动已安全落地       : {a_landed}")
    print(f"  B --pull 标出冲突        : {marked}")
    print(f"  B 带标记推送被拦         : {blocked_by_marker}")
    print(f"  主干未被 B 污染          : {main_clean}")
    print(f"  B 的改动仍在 B 本地      : {b_kept}")
    return a_landed and marked and blocked_by_marker and main_clean and b_kept


def scene_two_machines(mod, label):
    """两人各一台机器同时改：A 先推成功，B 被拦 → B --pull → B 推 → 都在。"""
    files = {"m1.txt": ("100644", b"X_v1\n"), "m2.txt": ("100644", b"Y_v1\n")}
    gh = fresh(files)
    run(mod, gh, ["--init-baseline", "--yes"], root=A_ROOT, state=A_STATE)
    run(mod, gh, ["--init-baseline", "--yes"], root=B_ROOT, state=B_STATE)

    write("m1.txt", "X_v2\n", root=A_ROOT)       # A 改 m1
    write("m2.txt", "Y_v2\n", root=B_ROOT)       # B 改 m2

    run(mod, gh, ["--yes", "-m", "A 改 m1"], root=A_ROOT, state=A_STATE, name="A push")
    a_ok = "X_v2" in (main_file(gh, "m1.txt") or "")

    # B 还没同步，直接推
    out, _ = run(mod, gh, ["--yes", "-m", "B 改 m2"], root=B_ROOT, state=B_STATE,
                 name="B blocked")
    b_blocked = "落后" in out
    a_untouched = main_file(gh, "m1.txt").strip() == "X_v2"

    # B 同步后重试
    run(mod, gh, ["--pull", "--yes"], root=B_ROOT, state=B_STATE, name="B pull")
    b_local = read("m2.txt", root=B_ROOT)
    merged_local = "Y_v2" in b_local and "X_v2" in read("m1.txt", root=B_ROOT)

    run(mod, gh, ["--yes", "-m", "B 改 m2"], root=B_ROOT, state=B_STATE, name="B retry")
    f1, f2 = main_file(gh, "m1.txt"), main_file(gh, "m2.txt")

    print(f"\n=== {label} ===")
    print(f"  A 推送成功               : {a_ok}")
    print(f"  B 落后被拦下             : {b_blocked}")
    print(f"  B 被拦时未破坏 A 的改动  : {a_untouched}")
    print(f"  B --pull 后本地含双方    : {merged_local}")
    print(f"  主干最终 m1=X_v2         : {f1.strip() == 'X_v2'}")
    print(f"  主干最终 m2=Y_v2         : {f2.strip() == 'Y_v2'}")
    return (a_ok and b_blocked and a_untouched and merged_local
            and f1.strip() == "X_v2" and f2.strip() == "Y_v2")


def scene_up_to_date_protection(mod, label):
    """仓库开了「分支必须最新才能合并」：第二个 PR 被拒 → 改动不丢，可重试。"""
    files = {"u.txt": ("100644", LINES.encode())}
    setup_repo(files)
    gh = GH(files)
    run(mod, gh, ["--init-baseline", "--yes"])

    write("u.txt", LINES.replace("L2", "L2-PR1"))
    run(mod, gh, ["--yes", "--hold", "-b", "task/u1", "-m", "PR1"])

    # 主干前进（PR1 的分支基点因此过时）
    other_commit(gh, {"u.txt": LINES.replace("L6", "L6-other").encode()})

    gh.require_up_to_date = True                 # 打开保护规则
    out, _ = run(mod, gh, ["--merge", "--yes"], name="PR1 merge")
    rejected = "不是最新" in out or "更新分支" in out

    # 改动必须还在本地
    kept = "L2-PR1" in read("u.txt")
    branch_kept = "task/u1" in gh.refs           # 保护规则下不该直接删分支

    print(f"\n=== {label} ===")
    print(f"  被保护规则拒绝并说明     : {rejected}")
    print(f"  改动仍在本地             : {kept}")
    print(f"  分支未被误删             : {branch_kept}")
    return rejected and kept and branch_kept


def scene_same_machine_lock(mod, label):
    """同一台机器两个进程并发：基线文件有锁保护，不会互相踩。

    用注入的 mod（而不是重新 load 一遍），测的才是命令行指定的那份代码。
    """
    lock_path = "/tmp/_cc_lock_test.lock"
    got = []

    def hold():
        try:
            with mod.StateLock(lock_path):
                got.append("in")
                import time
                time.sleep(0.5)
                got.append("out")
        except SystemExit as e:
            got.append("failed:" + str(e)[:40])

    import threading
    t1, t2 = threading.Thread(target=hold), threading.Thread(target=hold)
    t1.start(); t2.start(); t1.join(); t2.join()

    # 串行：in,out,in,out（不能出现 in,in）
    order = got[:]
    serialized = order in (["in", "out", "in", "out"],)
    print(f"\n=== {label} ===")
    print(f"  两个进程串行进入         : {serialized}  {order}")
    if os.path.exists(lock_path + ".lock"):
        os.unlink(lock_path + ".lock")
    return serialized


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "ccmod")
    results = []
    for fn in (scene_two_hold_prs_diff_files, scene_two_prs_same_file_diff_lines,
               scene_two_prs_same_line, scene_two_machines,
               scene_up_to_date_protection, scene_same_machine_lock):
        try:
            ok = fn(mod, fn.__name__.replace("scene_", ""))
            results.append((fn.__name__, ok))
        except Exception:
            import traceback
            traceback.print_exc()
            results.append((fn.__name__, False))
    cleanup()
    print("\n---- 汇总 ----")
    for n, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    print("总判定:", "ALL PASS" if all(o for _, o in results) else "有失败")
