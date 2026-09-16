#!/usr/bin/env python3
"""推送成功但基线**落盘失败**的回归。

这是最阴的一类失败：远端改动已经生效（PR 已开、主干已合并），
唯独本地基线还是旧的。用户下一跑就会被 P0-1 判成「本地副本落后」，
跑去 --pull —— 而实际上只需要清理磁盘再重推一次。

修复前报错只有一行裸的 `[Errno 28] No space left on device`：
  · 不知道是哪个文件写失败（其实是基线文件，不是要推的内容）
  · 不知道推送其实已经成功了
  · 不知道下一步该干什么（更不知道不能 --reset-baseline）

注入方式用 `builtins.open` 而不是替换 `mod.save_state`：后者会让
save_state 内部新加的错误处理代码根本不执行，测了个寂寞（实测踩过）。

用法：python3 test_state_write_fail.py <push_api.py 路径>
"""
import builtins
import sys

sys.path.insert(0, "/data/workspace")
import test_pr_flow as T
from test_pr_flow import GH, run, setup_repo, write

ROOT, STATE = T.ROOT, T.STATE
RES = []


def ck(name, ok, extra=""):
    RES.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {extra}")


def fresh(files):
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt"):
        T.remove_any(STATE + ext)
    setup_repo(files)
    gh = GH(files)
    run(T._MOD, gh, ["--init-baseline", "--yes"])
    return gh


def _inject_disk_full(mod, gh, argv, skip_first=1):
    """让基线落盘在**推送之后**失败，返回 (out, err)。"""
    real_open = builtins.open
    n = {"c": 0}

    def flaky(path, *a, **k):
        s = str(path)
        if s.endswith(".json.tmp"):              # save_state 的原子写临时文件
            n["c"] += 1
            if n["c"] > skip_first:              # 放过 init 那次
                raise OSError(28, "No space left on device")
        return real_open(path, *a, **k)

    builtins.open = flaky
    try:
        return run(mod, gh, list(argv), name="disk-full")
    except BaseException as e:
        return "", e
    finally:
        builtins.open = real_open


def save_state_error_explains(mod, label):
    """落盘失败必须说清：哪个文件、推送其实成功了、下一步怎么做。"""
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")
    out, err = _inject_disk_full(mod, gh, ["--yes", "-m", "x"])
    msg = str(err) if err else ""

    print(f"\n=== {label} ===")
    print(f"  原始报错：{msg.splitlines()[0][:70] if msg else '(无)'}")
    names_file = STATE in msg or ".push-sync" in msg or "基线" in msg
    warns_remote = "远端" in msg or "生效" in msg or "推送" in msg
    warns_no_reset = "reset" in msg.lower() or "不要" in msg
    ck("指出是基线文件写入失败", names_file)
    ck("提示「远端改动可能已生效」", warns_remote)
    ck("劝阻 --reset-baseline", warns_no_reset)
    return names_file and warns_remote and warns_no_reset


def save_state_error_not_bare_oserror(mod, label):
    """不能是裸的 OSError 文案。"""
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")
    out, err = _inject_disk_full(mod, gh, ["--yes", "-m", "x"])
    msg = str(err) if err else ""
    bare = msg.startswith("[Errno") and len(msg.splitlines()) == 1
    print(f"\n=== {label} ===")
    ck("不是裸 OSError", not bare,
       f"→ {msg.splitlines()[0][:60] if msg else '(无报错)'}")
    return not bare


def save_state_fail_no_traceback(mod, label):
    """必须友好中止，不是未捕获的 OSError 堆栈。"""
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")
    out, err = _inject_disk_full(mod, gh, ["--yes", "-m", "x"])
    msg = str(err) if err else ""
    ok = "Traceback" not in msg and "OSError" not in msg
    print(f"\n=== {label} ===")
    ck("无 Traceback / 无裸 OSError 类型名", ok,
       f"→ {msg.splitlines()[0][:60] if msg else '(无报错)'}")
    return ok


def recoverable_after_disk_cleaned(mod, label):
    """磁盘恢复后重跑，基线应能自然追上（不需要手工干预）。"""
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    write("a.txt", "v2\n")
    _inject_disk_full(mod, gh, ["--yes", "-m", "x"])
    write("a.txt", "v3\n")
    out, err = run(mod, gh, ["--yes", "-m", "再推"], name="retry")
    print(f"\n=== {label} ===")
    ck("重跑不崩", err is None or "Traceback" not in str(err),
       f"→ {str(err)[:60] if err else '正常'}")
    return err is None or "Traceback" not in str(err)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "swfmod")
    T._MOD = mod
    for fn in (save_state_error_explains, save_state_error_not_bare_oserror,
               save_state_fail_no_traceback, recoverable_after_disk_cleaned):
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
