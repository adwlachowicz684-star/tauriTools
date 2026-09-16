#!/usr/bin/env python3
"""统一检查入口：静态检查 + 全部回归。

为什么要有静态检查这一环：曾有一个 P0（api() raw 分支引用未定义的 `p`）
藏在**100% 零执行**的路径上 —— 几十个动态场景全绿也没发现，
pyflakes 一句话就能报出来。动态测试再密也覆盖不到「从未被执行的代码行」。

用法：
    python3 run_all.py [push_api.py 的路径] [--strict]

    --strict  pyflakes 不可用时按失败处理（CI 用；本地可不加）
"""
import os
import shutil
import subprocess
import sys
import time

_args = [a for a in sys.argv[1:] if not a.startswith("--")]
STRICT = "--strict" in sys.argv[1:]
TARGET = _args[0] if _args else "/data/workspace/push_api.py"

def discover_suites():
    """自动发现测试套件，不要手写列表。

    手写列表漏配的后果是**静默**：新加的套件根本不跑，而汇总仍显示
    「8/8 通过」，看上去一切正常。mutate.py 曾踩过同一个坑（漏了
    test_hardening.py，导致 3 个变异被误报成「漏网」）。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    return sorted(fn for fn in os.listdir(here)
                  if fn.startswith("test_") and fn.endswith(".py"))


SUITES = discover_suites()
STATIC_FILES = ["push_api.py"] + SUITES


def _pyflakes_cmd():
    """定位 pyflakes，按可靠程度依次尝试。

    直接 `python3 -m pyflakes` 在某些环境会 ModuleNotFound（包明明装着，
    却不在该解释器的默认搜索路径里），所以先用可执行文件、再回退到
    带 PYTHONPATH 的模块方式 —— 静态检查是这道流程的意义所在，
    不能因为调用方式的小差异就静默跳过。
    """
    exe = shutil.which("pyflakes")
    if exe:
        return [exe], None
    site = None
    for p in sys.path:
        if "packages" in p and os.path.isdir(os.path.join(p, "pyflakes")):
            site = p
            break
    if site:
        env = dict(os.environ, PYTHONPATH=site)
        return [sys.executable, "-m", "pyflakes"], env
    return [sys.executable, "-m", "pyflakes"], None


def static():
    print("=" * 62)
    print("静态检查（pyflakes）")
    print("=" * 62)
    cmd, env = _pyflakes_cmd()
    try:
        p = subprocess.run(cmd + STATIC_FILES, capture_output=True,
                           text=True, timeout=120, env=env,
                           cwd=os.path.dirname(os.path.abspath(__file__)))
    except (OSError, subprocess.SubprocessError) as e:
        print(f"  ! 无法运行 pyflakes：{e}")
        return None
    out = ((p.stdout or "") + (p.stderr or "")).strip()

    # 「工具没装」和「代码有告警」必须分开报：把 No module named 当成代码
    # 告警会误导人去改代码。沙盒重启后 pip 装的包会丢，这种情况很常见。
    #
    # 但**跳过不等于通过**。本地随手跑一下可以容忍，接 CI 时这层检查会
    # 静默消失 —— 而它的价值恰恰在于发现零执行路径上的问题（曾有一个 P0
    # 几十个动态场景全绿却没发现，pyflakes 一句话就报出来了）。
    # 所以提供 --strict：不可用时按失败处理，由 CI 显式开启。
    if "No module named" in out or "not found" in out.lower():
        if STRICT:
            print("  ✗ pyflakes 不可用，--strict 下视为失败"
                  "（安装：pip install pyflakes）\n")
            return False
        print("  ! pyflakes 不可用，本项跳过（安装：pip install pyflakes）")
        print("    CI 建议加 --strict：这层检查静默消失会削弱保障\n")
        return None

    if not out:
        print("  ✓ 无告警（未定义名 / 未用变量 / 多余 f 前缀等）\n")
        return True
    print(out)
    print("  ✗ 有告警\n")
    return False


def suites():
    results = []
    print("=" * 62)
    print("回归测试")
    print("=" * 62)
    for s in SUITES:
        t0 = time.time()
        try:
            p = subprocess.run([sys.executable, s, TARGET],
                               capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired:
            print(f"  ⏱  {s:<24} 超时")
            results.append((s, False))
            continue
        out = (p.stdout or "") + (p.stderr or "")
        ok = "ALL PASS" in out
        dt = time.time() - t0
        n_pass = out.count("\n  PASS")
        tail = [l.strip() for l in out.strip().splitlines() if l.strip()][-1:]
        print(f"  {'✓' if ok else '✗'} {s:<22} {dt:5.1f}s  {n_pass:>3} 项  {tail[0][:36]}")
        if not ok:
            for l in out.strip().splitlines():
                if "FAIL" in l or "Traceback" in l or "Error" in l:
                    print(f"       {l.strip()[:110]}")
        results.append((s, ok))
    return results


if __name__ == "__main__":
    print(f"\n目标脚本：{TARGET}\n")
    s_ok = static()
    rs = suites()
    bad = [n for n, ok in rs if not ok]
    print("\n" + "=" * 62)
    print(f"静态检查：{'通过' if s_ok else '有告警' if s_ok is False else '跳过'}")
    print(f"回归测试：{len(rs) - len(bad)}/{len(rs)} 套通过，"
          f"共 {sum(1 for _, ok in rs if ok)} 套全绿")
    if bad:
        print(f"失败套件：{bad}")
    print("=" * 62)
    sys.exit(1 if (bad or s_ok is False) else 0)
