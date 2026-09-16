#!/usr/bin/env python3
"""状态文件容错回归：语法合法但结构非法的基线，必须被拦下。

背景：早期 load_state() 只拦 JSON 语法错误。实测 18 种坏状态里，
只有 3 种会崩（AttributeError 裸堆栈），11 种**静默通过**，
还有 1 种（文件内容是 JSON 的 null）会被当成「文件不存在」，
进而静默引导用户重建基线 —— 把唯一能判断「远端是否被改过」的参照丢掉。

最危险的那条不是崩溃，是静默。本文件把它钉死。
"""
import builtins
import importlib.util
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, "/data/workspace")
import test_pr_flow as T

# 路径带 **PID 后缀**：允许多个测试进程并发跑。
# 实测：两个进程共用固定路径时，会互相 rmtree 对方的仓库、unlink 对方的
# 状态文件，表现为大面积随机失败（17 项 FAIL），容易被误判成代码 bug。
STATE = f"/tmp/_ss_state_{os.getpid()}.json"
ROOT = f"/tmp/_ss_repo_{os.getpid()}"
FILES = {"a.txt": ("100644", b"v1\n")}

# (用例名, 直接写进状态文件的内容)
BAD_STATES = {
    "state 是列表": [],
    "state 是字符串": "not a dict",
    "state 是数字": 42,
    "state 是布尔": True,
    "files 是列表": {"version": 2, "files": ["a.txt"], "conflicts": []},
    "files 是字符串": {"version": 2, "files": "oops", "conflicts": []},
    "files 的值是数字": {"version": 2, "files": {"a.txt": 123}, "conflicts": []},
    "files 的值是列表": {"version": 2, "files": {"a.txt": ["100644", "s"]}, "conflicts": []},
    "tasks 是列表": {"version": 2, "files": {}, "tasks": [], "conflicts": []},
    "tasks 的值是字符串": {"version": 2, "files": {}, "tasks": {"b": "x"}, "conflicts": []},
    "conflicts 是空字符串": {"version": 2, "files": {}, "conflicts": ""},
    "conflicts 是非空字符串": {"version": 2, "files": {}, "conflicts": "x"},
    "conflicts 是数字": {"version": 2, "files": {}, "conflicts": 7},
    "conflicts 元素是数字": {"version": 2, "files": {}, "conflicts": [1, 2]},
    "base_commit 是列表": {"version": 2, "files": {}, "conflicts": [],
                          "base_commit": ["c1", "c2"]},
    "branch 是数字": {"version": 2, "files": {}, "conflicts": [], "branch": 7},
    "version 是字符串": {"version": "2", "files": {}, "conflicts": []},
    "version 高于本脚本": {"version": 99, "files": {}, "conflicts": []},
    "缺少 files 字段": {"version": 2, "conflicts": []},
}

# (用例名, 原始文本)
BAD_TEXTS = {
    "JSON null": "null",
    "空文件": "",
    "只有空白": "   \n",
    "截断的 JSON": '{"version": 2, "files": {',
    "带 BOM 的合法 JSON": '\ufeff{"version": 2, "files": {}}',
}


def _remove(path):
    """删除任意形态的路径（文件 / 软链 / 目录）。

    os.unlink 碰到目录会抛 IsADirectoryError —— 上一个用例把 STATE 变成
    目录后，这里的清理自己就先崩了。删状态文件要考虑它可能被做成各种形态。
    """
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.unlink(path)
    except FileNotFoundError:
        pass


def _fresh(mod):
    """重置仓库，并从 **注入的 mod 所在文件** 重新加载一份独立实例。

    每个用例一个实例，避免 _CHANGES_CACHE / _EXEC_RELIABLE 之类模块级
    状态互相污染。路径取自 mod.__file__ 而不是写死，测的才是命令行
    传入的那份代码 —— 硬编码路径会让坏副本也「通过」，测试形同虚设。
    """
    T._rmtree_stubborn(ROOT)
    T.remove_any(STATE)
    T.remove_any(STATE + ".corrupt")
    T.setup_repo(FILES, root=ROOT, state=STATE)
    _remove(STATE)                      # setup_repo 可能重新建了它
    spec = importlib.util.spec_from_file_location("pa", mod.__file__)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.ROOT, m.STATE_PATH = ROOT, STATE
    m.TOKEN = "fake"
    return m


def _write_state(obj):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(obj, f) if not isinstance(obj, str) else f.write(obj)


def scene_bad_structures(mod, label):
    """结构非法：必须拦下（不能崩裸堆栈，更不能静默通过）。"""
    missed, crashed = [], []
    for name, bad in BAD_STATES.items():
        m = _fresh(mod)
        _write_state(bad)
        try:
            st = m.load_state()
            # 没抛错 = 防护缺口；返回 None 更糟（会被当成首次使用）
            missed.append(f"{name}（{'返回None' if st is None else '通过'}）")
        except SystemExit:
            pass
        except Exception as e:
            crashed.append(f"{name} → {type(e).__name__}")

    print(f"\n=== {label} ===")
    print(f"  覆盖 {len(BAD_STATES)} 种坏结构")
    print(f"  未拦截（静默通过）      : {len(missed)} {missed[:3]}")
    print(f"  裸崩溃（非 SystemExit） : {len(crashed)} {crashed[:3]}")
    return not missed and not crashed


def scene_bad_texts(mod, label):
    """文本非法：JSON null 尤其危险 —— 会被当成「文件不存在」。"""
    missed = []
    for name, raw in BAD_TEXTS.items():
        m = _fresh(mod)
        with open(STATE, "w", encoding="utf-8") as f:
            f.write(raw)
        try:
            st = m.load_state()
            missed.append(f"{name}（{'返回None → 会静默重建！' if st is None else '通过'}）")
        except SystemExit:
            pass
        except Exception as e:
            missed.append(f"{name} → {type(e).__name__}")

    print(f"\n=== {label} ===")
    print(f"  覆盖 {len(BAD_TEXTS)} 种坏文本")
    print(f"  未拦截                : {len(missed)} {missed[:3]}")
    return not missed


def scene_corrupt_backup(mod, label):
    """报错前必须备份原文，否则用户一 reset 就再也看不到它了。"""
    m = _fresh(mod)
    _write_state({"version": 2, "files": "坏"})
    corrupt = STATE + ".corrupt"
    if os.path.exists(corrupt):
        os.unlink(corrupt)
    try:
        m.load_state()
        print(f"\n=== {label} ===")
        print("  未报错，无法验证备份")
        return False
    except SystemExit:
        pass
    exists = os.path.exists(corrupt)
    same = False
    if exists:
        with open(corrupt) as f:
            same = json.load(f) == {"version": 2, "files": "坏"}
    print(f"\n=== {label} ===")
    print(f"  生成 .corrupt 备份      : {exists}")
    print(f"  备份内容与原文一致      : {same}")
    return exists and same


def scene_init_repairs(mod, label):
    """--init-baseline 必须能直接修好坏基线，不要求用户手工删文件。"""
    m = _fresh(mod)
    _write_state({"version": 2, "files": "坏"})
    gh = T.GH(FILES)
    m.api = gh.api

    out, err = T.run(m, gh, ["--init-baseline", "--yes"], root=ROOT, state=STATE)
    after = json.load(open(STATE))
    ok_structure = isinstance(after.get("files"), dict)

    # 修好之后正常的推送也要通
    T.write("a.txt", "v2\n", root=ROOT)
    out2, err2 = T.run(m, gh, ["--yes", "-m", "修复后推送"], root=ROOT, state=STATE)
    pushed = gh.files_of("main")["a.txt"][1] == b"v2\n"

    print(f"\n=== {label} ===")
    print(f"  init 无异常            : {err is None}")
    print(f"  init 后结构合法        : {ok_structure}")
    print(f"  修复后可正常推送        : {pushed}")
    return err is None and ok_structure and pushed


def scene_good_state(mod, label):
    """合法状态不能被误伤（v1 裸 sha 字符串也要能过，交给 migrate 收敛）。"""
    cases = {
        "v2 完整": {"version": 2, "remote": "o/r", "branch": "main",
                   "base_commit": "c" * 40, "synced_commit": "c" * 40,
                   "conflicts": [], "tasks": {}, "files": {
                       "a.txt": {"mode": "100644", "sha": "s" * 40}}},
        "v1 裸 sha": {"version": 1, "files": {"a.txt": "s" * 40}},
        "最小合法": {"version": 2, "files": {}},
        "带任务的": {"version": 2, "files": {}, "tasks": {
            "task/x": {"pr": 1, "last_push": "2026-01-01 00:00:00"}},
            "conflicts": ["a.txt"], "pr_number": 5, "task_branch": "task/x"},
    }
    blocked = []
    for name, good in cases.items():
        m = _fresh(mod)
        _write_state(good)
        try:
            st = m.load_state()
            if st is None:
                blocked.append(f"{name}（返回None）")
        except SystemExit as e:
            blocked.append(f"{name}（{str(e).splitlines()[0][:28]}）")

    print(f"\n=== {label} ===")
    print(f"  覆盖 {len(cases)} 种合法状态")
    print(f"  被误拦                : {len(blocked)} {blocked}")
    return not blocked


def scene_path_shapes(mod, label):
    """基线路径不是普通文件时，必须友好报错 —— **绝不能挂死**。

    比报错更严重的是阻塞：
      · FIFO     → open() 一直等写入端，脚本静默卡住，无任何输出
      · /dev/zero → 能打开，但读不到 EOF，内存被吃光
    这两种都不会打印任何东西，用户只能看到终端「什么都没发生」。
    所以判据是「抛 SystemExit 或正常返回」，超时一律算失败。
    """
    bad_shapes = {
        "是目录": lambda: os.makedirs(STATE),
        "是 FIFO": lambda: os.mkfifo(STATE),
        "指向 /dev/zero": lambda: os.symlink("/dev/zero", STATE),
        "指向 /dev/null": lambda: os.symlink("/dev/null", STATE),
        "二进制内容": lambda: open(STATE, "wb").write(bytes(range(256))),
    }

    # 必须在**子进程**里跑：FIFO 的 open() 阻塞时，同进程的线程即便设了
    # daemon + join 超时，解释器退出阶段仍会被拖住 —— 结果就是测试自己
    # 卡死、连 FAIL 都打不出来，反而掩盖了被测的问题。
    runner = f'''
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("pa", {mod.__file__!r})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.ROOT, m.STATE_PATH = {ROOT!r}, {STATE!r}
m.TOKEN = "fake"
try:
    st = m.load_state()
    print("none" if st is None else "ok")
except SystemExit:
    print("exit")
except Exception as e:
    print("crash:" + type(e).__name__)
'''
    hung, crashed, silent = [], [], []
    for name, setup in bad_shapes.items():
        _fresh(mod)
        setup()
        try:
            p = subprocess.run([sys.executable, "-c", runner],
                               capture_output=True, text=True, timeout=8)
            out = (p.stdout or "").strip().splitlines()
            verdict = out[-1] if out else "no-output"
        except subprocess.TimeoutExpired:
            hung.append(name)           # 超时 = 挂死，这正是要抓的
            continue
        if verdict == "none":
            silent.append(name)         # 被当成「没基线」，会静默重建
        elif verdict.startswith("crash"):
            crashed.append(f"{name} → {verdict.split(':')[1]}")

    print(f"\n=== {label} ===")
    print(f"  覆盖 {len(bad_shapes)} 种路径形态")
    print(f"  挂死（>8s 无响应）      : {len(hung)} {hung}")
    print(f"  裸崩溃                  : {len(crashed)} {crashed}")
    print(f"  被当成「没基线」        : {len(silent)} {silent}")
    return not hung and not crashed and not silent


def scene_dangling_link(mod, label):
    """悬空软链：按「没有基线」处理并提示，且 --init-baseline 能自愈。

    os.stat 跟随软链，目标没了会拿到「不存在」。不能默默当首次使用 ——
    基线凭空消失会让人以为是脚本出错。但也不该中止：save_state 用
    os.replace，会直接替换掉软链本身，所以 init 能修好。
    """
    m = _fresh(mod)
    os.symlink("/tmp/_definitely_missing_state.json", STATE)
    try:
        st = m.load_state()
        returned_none = st is None
    except SystemExit:
        returned_none = False

    gh = T.GH(FILES)
    m.api = gh.api
    out, err = T.run(m, gh, ["--init-baseline", "--yes"], root=ROOT, state=STATE)
    repaired = err is None and os.path.isfile(STATE) and not os.path.islink(STATE)

    print(f"\n=== {label} ===")
    print(f"  按「没基线」处理        : {returned_none}")
    print(f"  init 后变成普通文件      : {repaired}")
    return returned_none and repaired


def scene_unreadable(mod, label):
    """无读权限 / I/O 错误 → 友好报错，不是裸 OSError。

    本环境是 root，chmod 000 不生效，所以直接注入异常来验证分支。
    """
    results = []
    for name, exc in (("PermissionError", PermissionError(13, "Permission denied")),
                      ("OSError(EIO)", OSError(5, "Input/output error"))):
        m = _fresh(mod)
        _write_state({"version": 2, "files": {}})
        real = builtins.open

        def boom(*a, **k):
            if a and a[0] == STATE:
                raise exc
            return real(*a, **k)

        builtins.open = boom
        try:
            try:
                m.load_state()
                results.append(f"{name}（未拦截）")
            except SystemExit:
                pass
            except Exception as e:
                results.append(f"{name}（裸崩溃 {type(e).__name__}）")
        finally:
            builtins.open = real

    print(f"\n=== {label} ===")
    print(f"  未友好拦截              : {len(results)} {results}")
    return not results


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "ssmod")
    results = []
    for fn in (scene_bad_structures, scene_bad_texts, scene_corrupt_backup,
               scene_init_repairs, scene_good_state, scene_path_shapes,
               scene_dangling_link, scene_unreadable):
        try:
            ok = fn(mod, fn.__name__.replace("scene_", ""))
            results.append((fn.__name__, ok))
        except Exception:
            import traceback
            traceback.print_exc()
            results.append((fn.__name__, False))
    shutil.rmtree(ROOT, ignore_errors=True)
    for ext in ("", ".corrupt"):
        _remove(STATE + ext)
    print("\n---- 汇总 ----")
    for n, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    print("总判定:", "ALL PASS" if all(o for _, o in results) else "有失败")
