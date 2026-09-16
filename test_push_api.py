#!/usr/bin/env python3
"""离线回归测试：用一个假的 GitHub 服务端跑 push_api 的关键路径。

重点验证旧版会被静默覆盖的场景，新版必须拦住并给出可解决的路径。
不发真实网络请求。
"""
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import time
import contextlib

# 路径带 **PID 后缀**：允许多个测试进程并发跑。
# 实测：两个进程共用固定路径时，会互相 rmtree 对方的仓库、unlink 对方的
# 状态文件，表现为大面积随机失败（17 项 FAIL），容易被误判成代码 bug。
ROOT = f"/tmp/_pt_repo_{os.getpid()}"
STATE = f"/tmp/_pt_state_{os.getpid()}.json"


_gitsha_cache = {}


def gitsha(data: bytes) -> str:
    """缓存：本环境跑一次 git 要 1~5 秒（virtiofs），不缓存测试会慢到超时。"""
    if data not in _gitsha_cache:
        p = subprocess.run(["git", "hash-object", "--stdin"], input=data,
                           capture_output=True)
        _gitsha_cache[data] = p.stdout.decode().strip()
    return _gitsha_cache[data]


class FakeGithub:
    def __init__(self, files):
        self.files = {p: (m, c) for p, (m, c) in files.items()}
        self.commits, self.trees, self.blobs, self.parents = {}, {}, {}, {}
        self.head = self._commit(dict(self.files))
        self.pushed = []

    def _commit(self, files):
        sha = "c" + str(len(self.commits) + 1).zfill(39)
        self.commits[sha] = dict(files)
        return sha

    def state(self):
        return {p: (m, gitsha(c)) for p, (m, c) in self.files.items()}

    def api(self, method, path, payload=None, retries=3, timeout=None, raw=False,
            allow_404=False):
        p = path.split("?")[0]
        if method == "GET" and p == "/git/ref/heads/main":
            return {"object": {"sha": self.head}}
        if method == "GET" and p == "/git/refs/heads/main":
            return {"object": {"sha": self.head}}
        if method == "GET" and p.startswith("/git/trees/"):
            sha = p.rsplit("/", 1)[1]
            files = self.commits.get(sha) or self.trees.get(sha)
            if files is None:
                return {"message": "no tree"}
            return {"tree": [{"path": k, "mode": m, "sha": gitsha(c), "type": "blob"}
                             for k, (m, c) in files.items()]}
        if method == "GET" and p.startswith("/git/blobs/"):
            import base64
            sha = p.rsplit("/", 1)[1]
            data = self.blobs.get(sha)
            if data is None:
                for snap in list(self.commits.values()) + [self.files]:
                    for _, (m, c) in snap.items():
                        if gitsha(c) == sha:
                            data = c
            data = data if data is not None else b""
            if raw:
                return data
            return {"encoding": "base64", "sha": sha,
                    "content": base64.b64encode(data).decode()}
        if method == "POST" and p == "/git/blobs":
            import base64
            if getattr(self, "on_blob", None):
                self.on_blob()
            raw_bytes = base64.b64decode(payload["content"])
            sha = gitsha(raw_bytes)
            self.blobs[sha] = raw_bytes
            return {"sha": sha}
        if method == "POST" and p == "/git/trees":
            files = dict(self.commits.get(payload["base_tree"], {}))
            for e in payload["tree"]:
                files[e["path"]] = (e["mode"], self.blobs[e["sha"]])
            sha = "t" + str(len(self.trees) + 1).zfill(39)
            self.trees[sha] = files
            return {"sha": sha}
        if method == "POST" and p == "/git/commits":
            sha = self._commit(self.trees[payload["tree"]])
            self.commits[sha] = self.trees[payload["tree"]]
            self.parents[sha] = payload["parents"][0] if payload.get("parents") else None
            return {"sha": sha}
        if method == "PATCH" and p == "/git/refs/heads/main":
            if payload.get("force"):
                self.head = payload["sha"]
                return {"object": {"sha": payload["sha"]}}
            if self.head == self.parents.get(payload["sha"]):
                self.head = payload["sha"]
                self.pushed.append(payload["sha"])
                self.files = dict(self.commits[payload["sha"]])
                return {"object": {"sha": payload["sha"]}}
            return {"message": "not fast-forward"}
        raise AssertionError(f"未预期的请求 {method} {path}")



def git(*a, **kw):
    return subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True, **kw)


def _rmtree_stubborn(root, tries=5):
    """删干净；容忍 git 后台进程重建 .git 造成的残留（见 test_pr_flow 同名函数）。"""
    for _ in range(tries):
        shutil.rmtree(root, ignore_errors=True)
        if not os.path.exists(root):
            return
        time.sleep(0.05)


def setup_repo(files):
    _rmtree_stubborn(ROOT)
    # 直接删、吃掉「已不存在」：先 exists 再 unlink 是 TOCTOU，
    # 慢文件系统上两步之间文件可能已被别的进程删掉，抛 FileNotFoundError。
    try:
        os.unlink(STATE)
    except (FileNotFoundError, IsADirectoryError, PermissionError):
        pass
    os.makedirs(ROOT)
    git("init", "-q")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    git("config", "core.fileMode", "true")
    for p, (m, c) in files.items():
        full = os.path.join(ROOT, p)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(c)
        os.chmod(full, 0o755 if m == "100755" else 0o644)
    git("add", "-A")
    git("commit", "-qm", "init")


def write(p, content):
    full = os.path.join(ROOT, p)
    with open(full, "w") as f:
        f.write(content)
    return full


def load_mod(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


def run(mod, gh, argv, name=""):
    # 这套用例写的是「直推主干」的四层防护语义，显式走 --direct。
    if "--direct" not in argv:
        argv = ["--direct"] + argv
    mod.ROOT, mod.STATE_PATH = ROOT, STATE
    mod.api = gh.api
    mod.TOKEN = "fake"
    mod.BRANCH = "main"
    # 每次 run 模拟一个**新进程**：清掉模块级缓存，
    # 否则上一次调用缓存的「工作区干净」会沿用，测出来的不是真实行为。
    mod._CHANGES_CACHE = None
    if hasattr(mod, "_TREE_CACHE"):
        mod._TREE_CACHE.clear()   # 模块级，跨用例存活会串味
    if hasattr(mod, "_EXEC_RELIABLE"):
        mod._EXEC_RELIABLE = None
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        old_argv = sys.argv
        sys.argv = ["push_api.py"] + argv
        try:
            mod.main()
            err = None
        except SystemExit as e:
            err = str(e)
        finally:
            sys.argv = old_argv
    if os.environ.get("DEBUG"):
        print(f"---- [{name}] argv={argv} ----")
        print(buf.getvalue().strip()[:2500])
        if err:
            print("SystemExit:", err[:500])
    return buf.getvalue(), err


def remote_contains(gh, path, text):
    return text in gh.files.get(path, ("", b""))[1].decode()


# ---------------------------------------------------------------- 场景

def scenario_stale_local(mod, label):
    """本地副本是 v1，远端已被别人推到 v5，用户在 v1 上改了 A。

    旧版：init-baseline 后一路放行 → v5 的改动被 v1' 静默覆盖。
    新版：必须拦住，且 --pull 之后能合上。
    """
    v1 = "line1\nline2\n"
    v5 = "line1\nline2\nline5-remote\n"          # 远端追加一行
    setup_repo({"a.txt": ("100644", v1.encode())})
    gh = FakeGithub({"a.txt": ("100644", v5.encode())})

    out, err = run(mod, gh, ["--init-baseline", "--yes"])
    st = json.load(open(STATE))
    base_missing = "a.txt" not in st["files"]
    synced_none = st.get("synced_commit") is None

    write("a.txt", "line1-mine\nline2\n")   # 用户改第 1 行（与远端追加末尾不冲突）
    out2, err2 = run(mod, gh, ["--yes", "-m", "my change"])
    blocked = gh.pushed == []                       # 没推出去才算拦住

    # 走正解：--pull 合并 → 再推
    out3, err3 = run(mod, gh, ["--pull", "--yes"])
    merged = open(os.path.join(ROOT, "a.txt")).read()
    out4, err4 = run(mod, gh, ["--yes", "-m", "my change"])
    pushed_ok = bool(gh.pushed)
    final = gh.files["a.txt"][1].decode()

    print(f"\n=== {label} ===")
    print(f"  init 拒绝为差异文件建基线 : {base_missing}")
    print(f"  init 未谎报已同步        : {synced_none}")
    print(f"  过期推送被拦下           : {blocked}")
    print(f"  --pull 后本地含远端改动  : {'line5-remote' in merged}")
    print(f"  --pull 后本地保留我的改动: {'line1-mine' in merged}")
    print(f"  --pull 后推送成功        : {pushed_ok}")
    print(f"  远端最终同时含两方改动   : "
          f"{'line5-remote' in final and 'line1-mine' in final}")
    return base_missing and synced_none and blocked and \
        "line5-remote" in merged and "line1-mine" in merged and pushed_ok


def scenario_parallel_same_file(mod, label):
    """两人同时改同一文件的不同部位，都应保留。"""
    base = "\n".join(f"L{i}" for i in range(1, 11)) + "\n"
    mine = base.replace("L2", "L2-mine")
    theirs = base.replace("L8", "L8-theirs")
    setup_repo({"f.txt": ("100644", base.encode())})
    gh = FakeGithub({"f.txt": ("100644", base.encode())})
    run(mod, gh, ["--init-baseline", "--yes"])
    # 别人推了 theirs
    gh.files["f.txt"] = ("100644", theirs.encode())
    gh.head = gh._commit(dict(gh.files))
    # 我改了 mine
    write("f.txt", mine)
    out, err = run(mod, gh, ["--yes", "-m", "mine"])
    first_blocked = gh.pushed == []
    run(mod, gh, ["--pull", "--yes"])
    run(mod, gh, ["--yes", "-m", "mine"])
    final = gh.files["f.txt"][1].decode()
    print(f"\n=== {label} ===")
    print(f"  未合并时推送被拦         : {first_blocked}")
    print(f"  自动合并保留双方改动     : "
          f"{'L2-mine' in final and 'L8-theirs' in final}")
    return first_blocked and "L2-mine" in final and "L8-theirs" in final


def scenario_true_conflict(mod, label):
    """同一行双方都改 → 真冲突，必须报冲突且禁止带标记推送。"""
    base = "one\ntwo\nthree\n"
    setup_repo({"c.txt": ("100644", base.encode())})
    gh = FakeGithub({"c.txt": ("100644", base.encode())})
    run(mod, gh, ["--init-baseline", "--yes"])
    gh.files["c.txt"] = ("100644", "one\nTWO-remote\nthree\n".encode())
    gh.head = gh._commit(dict(gh.files))
    write("c.txt", "one\nTWO-mine\nthree\n")
    out, _ = run(mod, gh, ["--yes"])
    blocked = gh.pushed == []
    out2, _ = run(mod, gh, ["--pull", "--yes"])
    has_marker = "<<<<<<<" in open(os.path.join(ROOT, "c.txt")).read()
    st = json.load(open(STATE))
    recorded = "c.txt" in (st.get("conflicts") or [])
    out3, err3 = run(mod, gh, ["--yes", "-m", "x"])
    push_blocked = gh.pushed == [] and err3 is not None
    # 未解决就 --resolve 应被拒绝
    out4, err4 = run(mod, gh, ["--resolve", "c.txt"])
    resolve_refused = err4 is not None
    # 手工解决后可 resolve + 推送
    write("c.txt", "one\nTWO-merged\nthree\n")
    run(mod, gh, ["--resolve", "c.txt"])
    run(mod, gh, ["--yes", "-m", "x"])
    final = gh.files["c.txt"][1].decode()
    print(f"\n=== {label} ===")
    print(f"  冲突前推送被拦           : {blocked}")
    print(f"  --pull 标出冲突          : {has_marker} / 已记录 {recorded}")
    print(f"  带冲突标记禁止推送       : {push_blocked}")
    print(f"  未解决时 --resolve 被拒  : {resolve_refused}")
    print(f"  解决后可推送且内容正确   : {'TWO-merged' in final}")
    return blocked and has_marker and recorded and push_blocked and \
        resolve_refused and "TWO-merged" in final


def scenario_force_scope(mod, label):
    """--force-file 的细粒度放行，且**不绕过 P0-1**（P0-1 回归）。

    分两步，缺一不可：
      ① 本地副本过期时，即便带了 --force-file 也必须被 P0-1 拦下。
         曾经 `bypass = force or bool(allowed)` 会把整层 P0-1 放掉，
         于是未点名文件（y.txt）的他人改动被静默回退（探针 E 实测）。
         用户点名 x.txt 时并不知道副本已过期，无从同意「回退 y」，
         这个同意是无效的。
      ② 副本确已同步后，--force-file 的细粒度放行仍然有效：
         点名的 x.txt 覆盖远端，未点名的 y.txt 不动。
    """
    setup_repo({"x.txt": ("100644", b"a\n"), "y.txt": ("100644", b"b\n")})
    gh = FakeGithub({"x.txt": ("100644", b"a\n"), "y.txt": ("100644", b"b\n")})
    run(mod, gh, ["--init-baseline", "--yes"])
    gh.files["x.txt"] = ("100644", "a-remote\n".encode())
    gh.files["y.txt"] = ("100644", "b-remote\n".encode())
    gh.head = gh._commit(dict(gh.files))
    write("x.txt", "a-mine\n")

    # ① 副本过期：仅有 --force-file 也必须被拦下
    out1, _ = run(mod, gh, ["--yes", "-m", "x", "--force-file", "x.txt", "x.txt"])
    blocked = "落后" in out1
    y_safe = "b-remote" in gh.files["y.txt"][1].decode()

    # ② 加上 --force-overwrite（明确承担过期风险）后：
    #    x 放行、y 不动，且风险在屏幕上明确可见（不是「不会静默覆盖」）
    write("x.txt", "a-mine\n")
    out2, _ = run(mod, gh, ["--yes", "-m", "x", "--force-overwrite", "x.txt"])
    fx = gh.files["x.txt"][1].decode()
    fy = gh.files["y.txt"][1].decode()
    warned = "回退" in out2
    x_pushed = "a-mine" in fx

    print(f"\n=== {label} ===")
    print(f"  ① 过期时 --force-file 被拦: {blocked}")
    print(f"  ① 未点名文件未被回退      : {y_safe}")
    print(f"  ② 加 --force-overwrite 放行: {x_pushed}")
    print(f"  ② 风险明确可见（提到回退）: {warned}")
    print(f"  ② 未点名文件未被覆盖      : {'b-remote' in fy}")
    return blocked and y_safe and x_pushed and warned and "b-remote" in fy


def scenario_ref_race(mod, label):
    """ref 层的并发保护（新旧版共有，确认改动没把它弄坏）：

      1) 建对象期间若有人抢先推了提交，第二层 re-check 必须中止；
      2) 最终 PATCH 必须带 force: False——非快进交给 GitHub 拒绝，
         这是「后推的人不会覆盖先推的人」的最后一道保险。
    """
    setup_repo({"z.txt": ("100644", b"z\n"), "r.txt": ("100644", b"r\n")})
    gh = FakeGithub({"z.txt": ("100644", b"z\n"), "r.txt": ("100644", b"r\n")})
    run(mod, gh, ["--init-baseline", "--yes"])
    gh.patch_calls = []

    # 记录 PATCH 参数
    orig_api = gh.api

    def spy(method, path, payload=None, **kw):
        if method == "PATCH" and path.endswith("/git/refs/heads/main"):
            gh.patch_calls.append(dict(payload or {}))
        return orig_api(method, path, payload, **kw)

    gh.api = spy

    write("z.txt", "z-mine\n")          # 我改 z.txt（远端没别人动过 → 第一层放行）

    # 建 blob 的瞬间别人抢先推了一个提交（模拟真实并发窗口）
    def racer(**kw):
        gh.api = orig_api
        gh.files["r.txt"] = ("100644", b"r-theirs\n")
        gh.head = gh._commit(dict(gh.files))
        gh.api = spy

    gh.on_blob = racer
    out, err = run(mod, gh, ["--yes", "-m", "mine"])
    gh.on_blob = None
    # 建对象期间的并发由第三层（PATCH force=False → GitHub 拒非快进）兜住：
    # 第二层 re-check 在建对象**之前**，覆盖不到这个窗口。
    aborted = err is not None and any(
        k in err for k in ("并发", "已前进", "非快进", "更新 ref 失败"))
    theirs_kept = b"r-theirs" in gh.files["r.txt"][1]
    pushed_nothing = gh.pushed == []

    # 正常路径下确认 PATCH 带 force: False
    write("z.txt", "z-mine2\n")
    out2, err2 = run(mod, gh, ["--pull", "--yes"])
    out3, err3 = run(mod, gh, ["--yes", "-m", "mine2"])
    forces = [c.get("force") for c in gh.patch_calls]

    print(f"\n=== {label} ===")
    print(f"  建对象期间并发被中止     : {aborted}")
    print(f"  抢先的提交未被覆盖       : {theirs_kept}")
    print(f"  中止时未产生任何推送     : {pushed_nothing}")
    print(f"  PATCH 一律 force=False   : {forces == [False] or forces == [False, False]}"
          f"  （实际 {forces}）")
    return aborted and theirs_kept and pushed_nothing and         all(f is False for f in forces) and len(forces) >= 1


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    label = sys.argv[2] if len(sys.argv) > 2 else "target"
    mod = load_mod(target, "mod_" + label)
    results = []
    for fn in (scenario_stale_local, scenario_parallel_same_file,
               scenario_true_conflict, scenario_force_scope, scenario_ref_race):
        name = fn.__name__.replace("scenario_", "")
        try:
            results.append((name, fn(mod, f"{label}/{name}")))
        except Exception:
            import traceback
            traceback.print_exc()
            results.append((name, False))
    print(f"\n---- {label} 汇总 ----")
    for n, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    print("总判定:", "ALL PASS" if all(o for _, o in results) else "有失败")
