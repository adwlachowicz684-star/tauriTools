#!/usr/bin/env python3
"""边界用例回归：路径、文件类型、模式位、dry-run 无副作用等。

这些是审查时临时补测的用例，沉淀成常驻回归，防止后续改动悄悄破坏。
"""
import os
import sys

import test_pr_flow as T
from test_pr_flow import GH, main_file, run, setup_repo, write

FILES = {"keep.txt": ("100644", b"keep\n")}


def _base(mod):
    """起一个已建好基线的最小仓库，返回假服务端。"""
    setup_repo(FILES)
    gh = GH(FILES)
    run(mod, gh, ["--init-baseline", "--yes"])
    return gh


# ---------------------------------------------------------------- 场景

def edge_unicode_space_path(mod, label):
    """中文 + 空格路径：不能被 -z / quoting 破坏。"""
    gh = _base(mod)
    p = "中文 目录/文件 名.txt"
    write(p, "内容\n")          # write 会按需创建父目录
    out, err = run(mod, gh, ["--yes", "-m", "中文路径"], name="push")
    got = main_file(gh, p)
    expect = "内容\n"
    print(f"\n=== {label} ===")
    print(f"  推送无异常              : {err is None}")
    print(f"  远端内容一致            : {got == expect}")
    return err is None and got == expect


def edge_new_file(mod, label):
    """纯新增文件：远端不存在，应作为新增推送，不报「基线未记录」。"""
    gh = _base(mod)
    write("brand-new.txt", "new\n")
    out, err = run(mod, gh, ["--yes", "-m", "新增"], name="push")
    got = main_file(gh, "brand-new.txt")
    expect = "new\n"
    blocked = "基线里没有这个文件" in out
    print(f"\n=== {label} ===")
    print(f"  未被误拦                : {not blocked}")
    print(f"  远端已存在              : {got == expect}")
    return (not blocked) and got == expect


def edge_symlink(mod, label):
    """符号链接：mode=120000，blob 内容是**目标路径**而非文件内容。"""
    gh = _base(mod)
    write("target.txt", "i am target\n")
    link = "link-to-target"
    full = os.path.join(T.ROOT, link)
    if os.path.lexists(full):
        os.unlink(full)
    os.symlink("target.txt", full)

    out, err = run(mod, gh, ["--yes", "-m", "软链"], name="push")
    # 远端存的应该是 (120000, b"target.txt")
    entry = gh.files_of("main").get(link)
    mode_ok = entry is not None and entry[0] == "120000"
    blob_ok = entry is not None and entry[1] == b"target.txt"
    print(f"\n=== {label} ===")
    print(f"  推送无异常              : {err is None}")
    print(f"  远端 mode=120000        : {mode_ok}")
    print(f"  blob 是目标路径         : {blob_ok}  {entry[1] if entry else None}")
    return err is None and mode_ok and blob_ok


def edge_binary(mod, label):
    """二进制：字节必须完全一致（不能经过 text 编解码）。"""
    gh = _base(mod)
    blob = bytes(range(256)) * 40 + b"\x00\x01\x02binary\xff"
    with open(os.path.join(T.ROOT, "b.bin"), "wb") as f:
        f.write(blob)
    out, err = run(mod, gh, ["--yes", "-m", "二进制"], name="push")
    got = gh.files_of("main").get("b.bin")
    same = got is not None and got[1] == blob
    print(f"\n=== {label} ===")
    print(f"  推送无异常              : {err is None}")
    print(f"  字节完全一致            : {same}  （{len(blob)} B）")
    return err is None and same


def edge_exec_bit(mod, label):
    """只改可执行位（T-11）：mode 必须跟着变，否则 .sh 推上去就丢了执行权限。"""
    gh = _base(mod)
    write("run.sh", "#!/bin/sh\necho hi\n")
    run(mod, gh, ["--yes", "-m", "先推普通文件"])
    before = gh.files_of("main").get("run.sh")

    os.chmod(os.path.join(T.ROOT, "run.sh"), 0o755)
    out, err = run(mod, gh, ["--yes", "-m", "改成可执行"], name="push")
    after = gh.files_of("main").get("run.sh")

    print(f"\n=== {label} ===")
    print(f"  初次 mode               : {before[0] if before else None}")
    print(f"  改权限后 mode=100755    : {after[0] == '100755' if after else False}")
    expect_body = b"#!/bin/sh\necho hi\n"
    print(f"  内容未被破坏            : {after[1] == expect_body if after else False}")
    return after is not None and after[0] == "100755" and after[1] == expect_body


def edge_dry_run_no_side_effect(mod, label):
    """--dry-run：不推、不建分支、不建 PR、不改基线。"""
    gh = _base(mod)
    before_refs = dict(gh.refs)
    before_prs = len(gh.prs)
    write("keep.txt", "changed\n")
    out, err = run(mod, gh, ["--yes", "--dry-run", "-m", "预演"], name="dry")

    expect = "keep\n"
    print(f"\n=== {label} ===")
    print(f"  远端未变                : {main_file(gh, 'keep.txt') == expect}")
    print(f"  未建分支                : {gh.refs == before_refs}")
    print(f"  未建 PR                 : {len(gh.prs) == before_prs}")
    print(f"  未推送                  : {gh.pushed == []}")
    return (main_file(gh, "keep.txt") == expect and gh.refs == before_refs
            and len(gh.prs) == before_prs and gh.pushed == [])


def edge_nested_path(mod, label):
    """嵌套子目录路径走完整 PR 流程。

    回归 setup_repo / write 对带子目录路径的支持 —— 两份测试里的同名
    辅助函数行为一度不一致，写嵌套路径用例会莫名 FileNotFoundError。
    """
    files = {"sub/dir/note.txt": ("100644", b"v1\n"), "top.txt": ("100644", b"t\n")}
    setup_repo(files)
    gh = GH(files)
    run(mod, gh, ["--init-baseline", "--yes"])

    write("sub/dir/note.txt", "v2\n")
    out, err = run(mod, gh, ["--yes", "-m", "嵌套路径"], name="push")
    got = main_file(gh, "sub/dir/note.txt")
    top = main_file(gh, "top.txt")
    expect_note, expect_top = "v2\n", "t\n"

    print(f"\n=== {label} ===")
    print(f"  推送无异常              : {err is None}")
    print(f"  远端路径与内容正确      : {got == expect_note}")
    print(f"  另一个文件未受影响      : {top == expect_top}")
    return err is None and got == expect_note and top == expect_top


def edge_nothing_to_push(mod, label):
    """无改动：明确告知，不建分支、不建 PR（不能空跑一遍留个空 PR）。"""
    gh = _base(mod)
    out, err = run(mod, gh, ["--yes", "-m", "没改东西"], name="noop")
    print(f"\n=== {label} ===")
    print(f"  提示无改动              : {'没有需要推送' in out or '没有待推送' in out}")
    print(f"  未建分支                : {not [b for b in gh.refs if b.startswith('task/')]}")
    print(f"  未建 PR                 : {len(gh.prs) == 0}")
    return (("没有需要推送" in out or "没有待推送" in out)
            and not [b for b in gh.refs if b.startswith("task/")]
            and len(gh.prs) == 0)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "edgemod")
    results = []
    for fn in (edge_unicode_space_path, edge_new_file, edge_symlink, edge_binary,
               edge_exec_bit, edge_dry_run_no_side_effect, edge_nothing_to_push,
               edge_nested_path):
        try:
            ok = fn(mod, fn.__name__.replace("edge_", ""))
            results.append((fn.__name__, ok))
        except Exception:
            import traceback
            traceback.print_exc()
            results.append((fn.__name__, False))
    print("\n---- 汇总 ----")
    for n, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    print("总判定:", "ALL PASS" if all(o for _, o in results) else "有失败")
