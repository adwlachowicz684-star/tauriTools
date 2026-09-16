#!/usr/bin/env python3
"""真实 curl 路径的故障注入回归。

为什么要单独一个文件：其余测试都用假服务端替换 mod.api，
**curl 这条路径 100% 零覆盖** —— 而它只在真实使用时才执行。
本轮 P0（raw 分支 5xx 抛 NameError）就藏在这里，全绿测试完全没发现。

做法：保留真实的 api()，只把 subprocess.run 换成假的 curl，
注入各种 HTTP 码 / 退出码 / 非 JSON 响应，验证：
  · 一律 SystemExit（友好报错）或成功，**绝不裸崩**
  · 该重试的退避重试，不该重试的立即失败

用法：python3 test_real_curl.py <push_api.py 路径>
"""
import importlib.util
import subprocess
import sys

RES = []


def ck(name, ok, extra=""):
    RES.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {extra}")


def load(path="/data/workspace/push_api.py", name="rcmod"):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    m.TOKEN = "ghp_fake_for_test"
    return m


def probe(m, code="503", raw=False, exitcode=0, stdout=None, retries=3,
          method="GET", path=None):
    """注入一次 curl 故障，返回 (结果类型, 调用次数, 退避序列)。"""
    real = subprocess.run
    st = {"n": 0}
    slept = []

    def fake_run(cmd, *a, **kw):
        if isinstance(cmd, list) and cmd and cmd[0] == "curl":
            st["n"] += 1
            if raw and "-o" in cmd:                 # raw 把字节写临时文件
                open(cmd[cmd.index("-o") + 1], "wb").write(b"")

            class R:
                returncode = exitcode

            R.stdout = stdout if stdout is not None else "\n" + str(code)
            R.stderr = ""
            return R()
        return real(cmd, *a, **kw)

    m.subprocess.run = fake_run
    real_sleep = m.time.sleep
    m.time.sleep = lambda s: slept.append(s)
    try:
        m.api(method, path or ("/git/blobs/" + "a" * 40),
              raw=raw, retries=retries)
        kind = "成功"
    except SystemExit:
        kind = "SystemExit"
    except Exception as e:
        kind = f"💥{type(e).__name__}: {e}"
    finally:
        m.subprocess.run = real
        m.time.sleep = real_sleep
    return kind, st["n"], slept


def scene_no_bare_crash(mod, label):
    """任何故障都必须是 SystemExit 或成功，不能是未捕获异常。"""
    cases = [
        ("raw 200",            dict(code="200", raw=True)),
        ("raw 500",            dict(code="500", raw=True)),
        ("raw 502",            dict(code="502", raw=True)),
        ("raw 503",            dict(code="503", raw=True)),
        ("raw 504",            dict(code="504", raw=True)),
        ("raw 429",            dict(code="429", raw=True)),
        ("raw 404",            dict(code="404", raw=True)),
        ("raw 401",            dict(code="401", raw=True)),
        ("raw 超时(28)",        dict(code="", raw=True, exitcode=28)),
        ("raw curl 失败(7)",     dict(code="", raw=True, exitcode=7)),
        ("json 401",           dict(code="401")),
        ("json 403",           dict(code="403")),
        ("json 404",           dict(code="404")),
        ("json 422",           dict(code="422")),
        ("json 500",           dict(code="500")),
        ("json 503",           dict(code="503")),
        ("json 429",           dict(code="429")),
        ("json 超时(28)",        dict(code="", exitcode=28)),
        ("json 非 JSON 响应",     dict(code="200", stdout="\n200\nnot-json")),
        ("json 空响应",          dict(code="200", stdout="")),
    ]
    bad = []
    print(f"\n=== {label} ===")
    for name, kw in cases:
        kind, n, _ = probe(mod, **kw)
        ok = kind in ("成功", "SystemExit")
        if not ok:
            bad.append(f"{name} → {kind}")
        ck(f"{name:16s}", ok, f"→ {kind[:60]}")
    return not bad


def scene_retry_policy(mod, label):
    """该重试的退避重试，不该重试的立即失败。"""
    print(f"\n=== {label} ===")
    results = []
    # 5xx：GET 应重试到上限
    for code in ("500", "502", "503", "504"):
        for raw in (False, True):
            kind, n, slept = probe(mod, code=code, raw=raw, retries=3)
            ok = (n == 3 and slept == [2, 4])
            results.append(ok)
            ck(f"{'raw' if raw else 'json'} {code} 重试 3 次", ok,
               f"→ 调用{n}次 退避{slept}")
    # 429 GET 重试
    for raw in (False, True):
        kind, n, slept = probe(mod, code="429", raw=raw, retries=3)
        ok = (n == 3 and slept == [2, 4])
        results.append(ok)
        ck(f"{'raw' if raw else 'json'} 429 重试", ok,
           f"→ 调用{n}次 退避{slept}")
    # 4xx 不重试
    for code in ("401", "403", "404", "422"):
        kind, n, slept = probe(mod, code=code, retries=3)
        ok = (n == 1 and not slept)
        results.append(ok)
        ck(f"json {code} 不重试", ok, f"→ 调用{n}次")
    # 超时一律不重试
    for raw in (False, True):
        kind, n, slept = probe(mod, raw=raw, exitcode=28, retries=3)
        ok = (n == 1 and not slept)
        results.append(ok)
        ck(f"{'raw' if raw else 'json'} 超时不重试", ok,
           f"→ 调用{n}次 退避{slept}")

    # 非幂等写不重试（POST/PATCH 撞 5xx 立即失败）：
    # 服务端可能已处理、只是响应丢了，重发会造成重复建对象，
    # 更糟的是 PATCH /git/refs 会撞 422 并被误报成「他人并发提交」。
    for m_, path_ in (("POST", "/git/commits"), ("PATCH", "/git/refs/heads/x")):
        kind, n, slept = probe(mod, code="500", retries=3, method=m_, path=path_)
        ok = (n == 1 and not slept)
        results.append(ok)
        ck(f"{m_} {path_} 5xx 不重试", ok, f"→ 调用{n}次 退避{slept}")

    return all(results)


def _api_err_msg(m, code, body='{"message":"x"}', method="GET", path="/x"):
    """注入一次 HTTP 错误，返回 SystemExit 的 message（None = 没抛）。"""
    real = subprocess.run
    payload = (body + "\n" + str(code)) if body else ("\n" + str(code))

    def fake_run(cmd, *a, **kw):
        if isinstance(cmd, list) and cmd and cmd[0] == "curl":
            class R:
                returncode = 0
            R.stdout = payload
            R.stderr = ""
            return R()
        return real(cmd, *a, **kw)

    real_sleep = m.time.sleep
    m.subprocess.run = fake_run
    m.time.sleep = lambda s: None
    try:
        m.api(method, path, retries=1)
        return None
    except SystemExit as e:
        return str(e)
    finally:
        m.subprocess.run = real
        m.time.sleep = real_sleep


def scene_http_hints(mod, label):
    """HTTP 错误要给出**可操作的下一步**，不能只有 GitHub 原文。

    用户看到 not fast-forward 只会往权限/仓库设置上猜，
    而正确的动作是 --pull。401 同理，该去检查 token。
    """
    print(f"\n=== {label} ===")
    expect = {
        "401": "token",            # 检查 GITHUB_TOKEN
        "403": "限流",              # 限流或权限
        "404": "仓库",              # 仓库不存在/无权限
        "422": "--pull",           # 不是快进 → 先 --pull
        "429": "限流",
    }
    ok_all = True
    for code, kw in expect.items():
        msg = _api_err_msg(mod, code) or ""
        has_hint = kw in msg
        # 原文也要保留：只给提示不给原文会丢掉 GitHub 的诊断信息
        keeps_raw = f"HTTP {code}" in msg
        ok = has_hint and keeps_raw
        ok_all = ok_all and ok
        ck(f"{code} 有「{kw}」提示且保留原文", ok,
           f"→ {msg.splitlines()[0][:46]}")
    # 没有对应提示的码（如 500）不应编造提示。
    # 注意 "→" 是固定格式里本来就有的（"API GET url → HTTP 500"），
    # 提示行是**另起一行**的 "\n  → ..."，只能以后者为判据。
    msg500 = _api_err_msg(mod, "500") or ""
    ok_all = ok_all and "\n  →" not in msg500
    ck("500 不编造提示", "\n  →" not in msg500,
       f"→ 行数={len(msg500.splitlines())}")
    return ok_all


def scene_raw_branch_hint(mod, label):
    """raw 分支（拉大文件）也要走同一个报错出口。

    两处出口迟早会漂移 —— 上上轮的 P0 正是 raw 分支漏改造成的。
    """
    msg = _api_err_msg(mod, "404", method="GET",
                       path="/git/blobs/" + "a" * 40) or ""
    ok = "HTTP 404" in msg and "仓库" in msg
    print(f"\n=== {label} ===")
    ck("raw 分支也有提示", ok, f"→ {msg.splitlines()[0][:46]}")
    return ok


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = load(target)
    a = scene_no_bare_crash(mod, "故障注入：绝不裸崩")
    b = scene_retry_policy(mod, "重试策略：区分幂等与故障类型")
    c = scene_http_hints(mod, "HTTP 错误码：可操作的下一步")
    d = scene_raw_branch_hint(mod, "raw 分支共用同一报错出口")
    print("\n---- 汇总 ----")
    print(f"  故障注入：{a}")
    print(f"  重试策略：{b}")
    print(f"  HTTP 提示：{c}")
    print(f"  raw 出口：{d}")
    if not (a and b and c and d):
        RES.append(("场景汇总", False))
    bad = [n for n, ok in RES if not ok]
    print("总判定:", "ALL PASS" if not bad else f"有失败 -> {bad}")
