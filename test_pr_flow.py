#!/usr/bin/env python3
"""PR 工作流 v2 回归测试：假 GitHub（分支 / PR / 三方合并 / 清理），纯离线。

覆盖：
  1. 两人从同一基点并行改 → 自动合并后都在，谁也没被静默覆盖
  2. 本地副本落后 → 拦下，且不留下空分支
  3. --hold 保留分支 → 后续推送复用 → --merge 合并
  4. --hold 期间主干前进 → 差异全集同步，PR diff 不出现「回退主干」
  5. 真冲突 → 409 → 收摊（关 PR + 删分支）→ --pull → 重试成功
  6. --prune 只报告不删，判据是合并/活动状态
  7. --direct 旧行为不坏
"""
import builtins
import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import time
from urllib.parse import unquote

# 测试仓库放 **/tmp**，不用 /dev/shm：/dev/shm 在本环境只有 64MB 且实测不稳定，
# 同一套用例跑 8 次会随机冒出「文件凭空消失」「rmtree 后目录仍在」（残留
# .git/COMMIT_EDITMSG）这类失败，而且报错出现在**下一个**用例里，极难定位。
# 换到 /tmp 后 8/8 全绿，速度几乎相同（git hash-object 40 次：105ms vs 100ms）。
# 路径带 **PID 后缀**：允许多个测试进程并发跑。
# 实测：两个进程共用固定路径时，会互相 rmtree 对方的仓库、unlink 对方的
# 状态文件，表现为大面积随机失败（17 项 FAIL），容易被误判成代码 bug。
ROOT = f"/tmp/_pr_repo_{os.getpid()}"
STATE = f"/tmp/_pr_state_{os.getpid()}.json"

# 各套件自有的路径前缀（都要带 PID，统一在这里登记以便清理）
_TMP_PATTERNS = ("/tmp/_pr_repo_*", "/tmp/_pr_state_*",
                 "/tmp/_pt_repo_*", "/tmp/_pt_state_*",
                 "/tmp/_ss_repo_*", "/tmp/_ss_state_*",
                 "/tmp/_cc_a_*", "/tmp/_cc_b_*", "/tmp/_cc_state_*")


def _cleanup_stale_tmp():
    """清掉上次运行留下的、属于**已退出进程**的临时仓库/状态文件。

    PID 后缀让并发跑成为可能，代价是残留会累积（每次运行一套）。
    判断依据是 PID 是否还活着：活着的跳过 —— 所以并发跑时不会互删，
    这个清理是并发安全的。PID 被系统复用的极少数情况只会让残留多留一轮。
    """
    import glob
    import re as _re
    me = os.getpid()
    for pat in _TMP_PATTERNS:
        for path in glob.glob(pat):
            m = _re.search(r"_(\d+)(?:\.json)?(?:\.lock)?(?:\.corrupt)?$", path)
            if not m:
                continue
            pid = int(m.group(1))
            if pid == me:
                continue
            try:
                os.kill(pid, 0)              # 还活着 → 别人的，跳过
                continue
            except ProcessLookupError:
                pass                          # 已退出 → 可删
            except PermissionError:
                continue                      # 无权判断，保守跳过
            except OSError:
                continue
            try:
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.unlink(path)
            except OSError:
                pass


_cleanup_stale_tmp()

_sha_cache = {}


def sha(data: bytes) -> str:
    if data not in _sha_cache:
        _sha_cache[data] = subprocess.run(
            ["git", "hash-object", "--stdin"], input=data,
            capture_output=True).stdout.decode().strip()
    return _sha_cache[data]


def iso(days_ago=0):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ",
                         time.localtime(time.time() - days_ago * 86400))


def merge3(ours: bytes, base: bytes, theirs: bytes):
    import tempfile
    paths = []
    try:
        for d in (ours, base, theirs):
            fd = tempfile.NamedTemporaryFile(prefix="m3-", delete=False)
            fd.write(d)
            fd.close()
            paths.append(fd.name)
        out = subprocess.run(["git", "merge-file", "-p", *paths], capture_output=True)
        if out.returncode < 0 or (out.returncode > 0 and not out.stdout):
            return None, True
        return out.stdout, out.returncode != 0
    finally:
        for p in paths:
            os.unlink(p)


class GH:
    def __init__(self, files):
        self.commits, self.parents, self.trees, self.blobs = {}, {}, {}, {}
        self.refs = {"main": self._commit(dict(files), None)}
        self.branch_base = {}
        self.prs, self.next_pr = {}, 1
        self.pushed, self.deleted = [], []
        self.merge_conflicts = 0
        # {branch: dict} 表示开了保护；键不存在即未开（对应 GitHub 的 404）
        self.protection = {}

    def _commit(self, files, parent):
        s = "c" + str(len(self.commits) + 1).zfill(39)
        self.commits[s] = {k: (m, v) for k, (m, v) in files.items()}
        self.parents[s] = parent
        return s

    def files_of(self, ref):
        return self.commits.get(self.refs.get(ref), {})

    def _get_ref(self, b, allow_404):
        s = self.refs.get(b)
        if s:
            return {"object": {"sha": s}}
        if allow_404:
            return None
        raise SystemExit(f"API GET /git/ref/heads/{b} → HTTP 404")

    def _merge_files(self, head_sha, base_branch, head_branch):
        ours = self.commits[head_sha]
        theirs = self.commits[self.refs[base_branch]]
        mb = self.commits.get(self.branch_base.get(head_branch), {})
        out, bad = {}, False
        for p in set(list(ours) + list(theirs) + list(mb)):
            o, t, b = ours.get(p), theirs.get(p), mb.get(p)
            if o == t:
                if o is not None:
                    out[p] = t
                continue
            if o is None:
                continue
            if t is None:
                out[p] = o
                continue
            if o == b:
                out[p] = t
                continue
            if t == b:
                out[p] = o
                continue
            merged, conflict = merge3(o[1], b[1] if b else b"", t[1])
            if conflict:
                bad = True
                continue
            out[p] = (o[0], merged)
        return out, bad

    def _with_mergeability(self, n, pr):
        """返回带 mergeable / mergeable_state 的 PR 副本。

        真实 GitHub 的这两个字段是**权威判据**（P1-1 让它取代了字符串匹配），
        假服务端原来根本没有，于是新代码路径从未被测过。

        规则：
          · override 优先（测试可强制指定，模拟异步未算出 = None）
          · 分支不够新（开了保护规则且 base 落后）→ behind
          · 内容会冲突                            → dirty
          · 否则                                  → clean
        """
        import copy
        out = copy.deepcopy(pr)
        ov = getattr(self, "mergeable_override", {}).get(n)
        if ov is not None:
            out["mergeable"], out["mergeable_state"] = ov
            return out
        if pr.get("state") == "closed":
            out["mergeable"], out["mergeable_state"] = False, "unknown"
            return out
        hb, bb = pr["head"]["ref"], pr["base"]["ref"]
        if getattr(self, "require_up_to_date", False):
            if self.branch_base.get(hb) != self.refs.get(bb):
                out["mergeable"], out["mergeable_state"] = True, "behind"
                return out
        try:
            _, bad = self._merge_files(self.refs[hb], bb, hb)
        except BaseException:
            bad = False
        out["mergeable"] = not bad
        out["mergeable_state"] = "dirty" if bad else "clean"
        return out

    def api(self, method, path, payload=None, retries=3, timeout=None,
            raw=False, allow_404=False):
        p = path.split("?")[0]
        q = path.split("?")[1] if "?" in path else ""

        # /branches/{b}/protection —— direct 模式检测需要。
        # 必须放在其它 /branches 通配分支之前；且要能返回 404
        # （未开保护时 GitHub 就是这样），allow_404 才能生效。
        if p.startswith("/branches/") and p.endswith("/protection"):
            b = p[len("/branches/"):-len("/protection")]
            b = b.replace("%2F", "/")
            prot = self.protection.get(b)
            if prot is None:
                if allow_404:
                    return None
                raise SystemExit(f"API GET {path} → HTTP 404: Branch not protected")
            return dict(prot)

        if p.startswith("/git/ref/heads/"):
            return self._get_ref(unquote(p[len("/git/ref/heads/"):]), allow_404)

        if p.startswith("/git/refs/heads/"):
            # 必须 unquote：真 GitHub 的端点里分支名是 URL 编码过的，
            # 而 push_api._ref_path() 正确地做了 quote(branch, safe="/")。
            # 假服务端原来直接截原始字符串，于是含 ? # 空格的分支名永远
            # 查不到（拿到的是 task%2Fxxx 这种形式）—— 这会把「客户端没
            # 编码」和「服务端没解码」两种 bug 掩盖成同一个 404，测试因此
            # 失去分辨力，正是 ref_sha 漏编码能长期潜伏的原因之一。
            b = unquote(p[len("/git/refs/heads/"):])
            if method == "GET":
                return self._get_ref(b, allow_404)
            if method == "DELETE":
                self.refs.pop(b, None)
                self.deleted.append(b)
                return {}
            if method == "PATCH":
                if payload.get("force"):
                    self.refs[b] = payload["sha"]
                elif self.parents.get(payload["sha"]) == self.refs.get(b):
                    self.refs[b] = payload["sha"]
                    self.pushed.append(payload["sha"])
                else:
                    raise SystemExit(f"API PATCH {path} → HTTP 422: not fast-forward")
                return {"object": {"sha": payload["sha"]}}

        if method == "POST" and p == "/git/refs":
            b = payload["ref"][len("refs/heads/"):]
            self.refs[b] = payload["sha"]
            self.branch_base[b] = payload["sha"]
            return {"object": {"sha": payload["sha"]}, "ref": payload["ref"]}

        if method == "GET" and p == "/branches":
            return [{"name": b, "commit": {"commit": {"committer": {"date": iso(1)}}}}
                    for b in self.refs]

        if method == "GET" and p.startswith("/git/trees/"):
            files = self.commits.get(p.rsplit("/", 1)[1])
            if files is None:
                raise SystemExit(f"API GET {p} → HTTP 404")
            return {"tree": [{"path": k, "mode": m, "sha": sha(v), "type": "blob"}
                             for k, (m, v) in files.items()]}

        if method == "GET" and p.startswith("/git/blobs/"):
            s = p.rsplit("/", 1)[1]
            data = self.blobs.get(s)
            if data is None:
                for c in self.commits.values():
                    for _, (m, v) in c.items():
                        if sha(v) == s:
                            data = v
            data = data if data is not None else b""
            if raw:
                return data
            import base64
            return {"encoding": "base64", "sha": s,
                    "content": base64.b64encode(data).decode()}

        if method == "POST" and p == "/git/blobs":
            import base64
            d = base64.b64decode(payload["content"])
            s = sha(d)
            self.blobs[s] = d
            return {"sha": s}

        if method == "POST" and p == "/git/trees":
            files = dict(self.commits.get(payload["base_tree"], {}))
            for e in payload["tree"]:
                files[e["path"]] = (e["mode"], self.blobs[e["sha"]])
            s = "t" + str(len(self.trees) + 1).zfill(39)
            self.trees[s] = files
            self.commits[s] = files
            return {"sha": s}

        if method == "POST" and p == "/git/commits":
            s = self._commit(self.commits[payload["tree"]],
                             payload["parents"][0] if payload.get("parents") else None)
            return {"sha": s}

        if method == "GET" and p == "/pulls":
            params = dict(kv.split("=", 1) for kv in q.split("&") if "=" in kv)
            head = unquote(params.get("head", "").split(":", 1)[-1])
            st = params.get("state", "open")
            # head 为空 = 未指定，返回**全部** PR（真 GitHub 的行为）。
            # 旧实现在这里无条件按 head 过滤，于是「不带 head 的全量查询」
            # 恒返回空 —— 会让 _pr_index 那种「一次拉全量建索引」的写法
            # 在测试里永远查不到 PR，从而掩盖真实行为。
            return [pr for pr in self.prs.values()
                    if (not head or pr["head"]["ref"] == head)
                    and (st == "all" or pr["state"] == st)]

        if method == "POST" and p == "/pulls":
            n = self.next_pr
            self.next_pr += 1
            pr = {"number": n, "state": "open", "title": payload["title"],
                  "head": {"ref": payload["head"]}, "base": {"ref": payload["base"]},
                  "merged": False, "merged_at": None, "updated_at": iso(),
                  "html_url": f"https://github.com/o/r/pull/{n}"}
            self.prs[n] = pr
            return pr

        if p.startswith("/pulls/") and "/merge" not in p:
            n = int(p.rsplit("/", 1)[1])
            pr = self.prs.get(n)
            if not pr:
                raise SystemExit(f"API {method} {path} → HTTP 404")
            if method == "GET":
                return self._with_mergeability(n, pr)
            if method == "PATCH":
                pr["state"] = payload.get("state", pr["state"])
                pr["updated_at"] = iso()
                return pr

        if method == "PUT" and p.endswith("/merge"):
            n = int(p.split("/")[2])
            pr = self.prs[n]
            if pr["state"] == "closed":
                raise SystemExit(f"API PUT {path} → HTTP 405: PR closed")
            hb, bb = pr["head"]["ref"], pr["base"]["ref"]
            # 模拟 GitHub 的「合并前分支必须与主干同步」保护规则
            if getattr(self, "require_up_to_date", False):
                if self.branch_base.get(hb) != self.refs[bb]:
                    raise SystemExit(
                        f'API PUT {path} → HTTP 409: {{"message": '
                        f'"Base branch was modified. Review and try the merge again."}}'
                    )
            merged, bad = self._merge_files(self.refs[hb], bb, hb)
            if bad:
                self.merge_conflicts += 1
                raise SystemExit(f"API PUT {path} → HTTP 409: Merge conflict")
            new = self._commit(merged, self.refs[bb])
            self.refs[bb] = new
            pr.update({"state": "closed", "merged": True, "merged_at": iso(),
                       "merge_commit_sha": new, "updated_at": iso()})
            return {"merged": True, "message": "ok", "sha": new}

        raise AssertionError(f"未预期的请求 {method} {path}")


def git(*a, root=None):
    return subprocess.run(["git", "-C", root or ROOT, *a],
                          capture_output=True, text=True)


def remove_any(path):
    """删掉 path，不管它是文件 / 目录 / 符号链接 / FIFO / 无权限文件。

    套件之间共用 /tmp 下的固定路径，上一个套件可能把 STATE 做成目录、
    FIFO 或 chmod 000 的文件（test_state_schema 就是这么测的）。
    下一个套件开头只做 os.unlink 会抛 IsADirectoryError / PermissionError，
    表现为**下一个**套件无故失败 —— 实测出现过
    （run_all 里 test_blindspots 报 FileNotFoundError）。
    先 chmod 再按类型删，能自愈。
    """
    if not path or not os.path.lexists(path):
        return
    try:
        if os.path.islink(path) or os.path.isfile(path):
            try:
                os.chmod(path, 0o644)
            except OSError:
                pass
            os.unlink(path)
        elif os.path.isdir(path):
            for dirpath, dirnames, filenames in os.walk(path):
                for n in dirnames + filenames:
                    try:
                        os.chmod(os.path.join(dirpath, n), 0o755)
                    except OSError:
                        pass
            _rmtree_stubborn(path)
        else:                       # FIFO / socket / 设备
            os.unlink(path)
    except OSError:
        pass


def _rmtree_stubborn(root, tries=5):
    """删掉 root，容忍「删到一半又被重新创建」的竞争。

    shutil.rmtree(ignore_errors=True) 会**吞掉**错误：竞态下目录没被删干净，
    后面的 os.makedirs 就抛 FileExistsError，而报错出现在下一个用例里，
    看起来像那个用例坏了。实测残留的是 .git/COMMIT_EDITMSG ——
    git commit 触发的后台 gc/maintenance 进程会去重建 .git 下的文件。

    所以：删完确认真的没了，没删干净就重试几轮再放弃。
    """
    for _ in range(tries):
        shutil.rmtree(root, ignore_errors=True)
        if not os.path.exists(root):
            return
        time.sleep(0.05)
    try:
        left = os.listdir(root)[:10]
    except OSError:
        left = "?"
    print(f"  ! 警告：{root} 未能完全删除，残留 {left}")


def setup_repo(files, root=None, state=None):
    """root/state 可换，用于模拟「两个人各自一台机器」的并发场景。"""
    root = root or ROOT
    state = state or STATE
    _rmtree_stubborn(root)
    try:
        os.unlink(state)
    except (FileNotFoundError, IsADirectoryError):
        pass
    try:
        os.makedirs(root)
    except FileExistsError:            # 见 _rmtree_stubborn 的说明
        shutil.rmtree(root, ignore_errors=True)
        os.makedirs(root, exist_ok=True)
    git("init", "-q", root=root)
    git("config", "user.email", "t@t", root=root)
    git("config", "user.name", "t", root=root)
    # 关掉 git 的后台维护：commit 会触发 gc --auto / maintenance，
    # 这些是**分离出去的**进程，会在用例已跑完、仓库被 rmtree 之后
    # 再回头重建 .git 下的文件（实测残留 .git/COMMIT_EDITMSG），
    # 导致下一个用例 makedirs 撞 FileExistsError —— 而报错显示在下一个用例里，
    # 极难定位。测试仓库不需要 gc，直接关掉，从源头消除竞态。
    git("config", "gc.auto", "0", root=root)
    git("config", "maintenance.auto", "false", root=root)
    git("config", "core.fsmonitor", "false", root=root)
    for p, (m, c) in files.items():
        full = os.path.join(root, p)
        # 父目录要按需创建：files 的 key 可以带子目录（如 "sub/b.txt"），
        # 只 makedirs(root) 的话写文件会直接 FileNotFoundError。
        # 与 test_push_api.setup_repo 的行为保持一致。
        parent = os.path.dirname(full)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(full, "wb") as f:
            f.write(c)
        os.chmod(full, 0o755 if m == "100755" else 0o644)
    git("add", "-A", root=root)
    git("commit", "-qm", "init", root=root)


def write(p, s, root=None):
    """写文件；路径带子目录时按需创建父目录。"""
    full = os.path.join(root or ROOT, p)
    parent = os.path.dirname(full)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(full, "w") as f:
        f.write(s)


def read(p, root=None):
    with open(os.path.join(root or ROOT, p)) as f:
        return f.read()


def load_mod(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


def run(mod, gh, argv, answer="y", name="", root=None, state=None,
        eof=False):
    """eof=True：让所有 input() 抛 EOFError，模拟 CI / 管道 / 无 TTY 环境。"""

    root = root or ROOT
    state = state or STATE
    mod.ROOT, mod.STATE_PATH = root, state
    mod.api = gh.api
    mod.TOKEN = "fake"
    mod.BRANCH = "main"
    mod._CHANGES_CACHE = None
    if hasattr(mod, "_TREE_CACHE"):
        mod._TREE_CACHE.clear()   # 模块级，跨用例存活会串味
    if hasattr(mod, "_EXEC_RELIABLE"):
        mod._EXEC_RELIABLE = None
    real_input = builtins.input
    if eof:
        def _eof(*a, **k):
            raise EOFError()
        builtins.input = _eof
    else:
        builtins.input = lambda *a, **k: answer
    buf = io.StringIO()
    old_argv = sys.argv
    sys.argv = ["push_api.py"] + argv
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            try:
                mod.main()
                err = None
            except SystemExit as e:
                err = str(e)
    finally:
        sys.argv = old_argv
        builtins.input = real_input
    if os.environ.get("DEBUG"):
        print(f"---- [{name}] {argv} ----")
        print(buf.getvalue().strip()[:2200])
        if err:
            print("SystemExit:", err[:300])
    return buf.getvalue(), err


def main_file(gh, path="f.txt"):
    d = gh.files_of("main").get(path)
    return d[1].decode() if d else None


def other_commit(gh, changes):
    """模拟「别人往主干推了提交」：直接改 gh，不碰本地状态文件。

    这样状态文件里的 synced_commit 就停留在旧版本，忠实地再现
    「我的副本落后于主干」—— 用自己再推一次来模拟是做不到的，
    因为那会把 state 一起刷新，P0-1 反而不触发了。
    """
    cur = dict(gh.files_of("main"))
    for p, c in changes.items():
        cur[p] = (cur.get(p, ("100644", b""))[0], c)
    gh.refs["main"] = gh._commit(cur, gh.refs["main"])


def task_branches(gh):
    return sorted(b for b in gh.refs if b.startswith("task/"))


# ---------------------------------------------------------------- 场景

def scene_stale_blocked(mod, label):
    """主干被他人推进后，我不同步就推 → 必须拦下，且不留下空分支。"""
    base = "L1\nL2\nL3\nL4\nL5\n"
    setup_repo({"f.txt": ("100644", base.encode())})
    gh = GH({"f.txt": ("100644", base.encode())})
    run(mod, gh, ["--init-baseline", "--yes"])

    other_commit(gh, {"f.txt": base.replace("L2", "L2-A").encode()})
    write("f.txt", base.replace("L4", "L4-B"))       # 本地还是旧的，且改了 L4
    out, err = run(mod, gh, ["--yes", "-m", "我要改 L4"], name="blocked")
    blocked = "落后" in out
    no_branch = not task_branches(gh)

    print(f"\n=== {label} ===")
    print(f"  落后时被拦下            : {blocked}")
    print(f"  被拦时未留空分支        : {no_branch}")
    return blocked and no_branch


def scene_parallel(mod, label):
    """接着上面：--pull 把主干改动三方合并进来，再推 → 三方改动共存。"""
    base = "L1\nL2\nL3\nL4\nL5\n"
    setup_repo({"f.txt": ("100644", base.encode())})
    gh = GH({"f.txt": ("100644", base.encode())})
    run(mod, gh, ["--init-baseline", "--yes"])

    other_commit(gh, {"f.txt": base.replace("L2", "L2-A").encode()})
    write("f.txt", base.replace("L4", "L4-B"))
    run(mod, gh, ["--pull", "--yes"], name="pull")
    local = read("f.txt")
    both_local = "L2-A" in local and "L4-B" in local

    write("f.txt", local.replace("L1", "L1-mine"))   # 再叠一层自己的改动
    run(mod, gh, ["--yes", "-m", "我也改 L1"], name="push")
    final = main_file(gh)

    print(f"\n=== {label} ===")
    print(f"  --pull 三方合并保留双方  : {both_local}")
    print(f"  主干有他人的 L2-A        : {'L2-A' in final}")
    print(f"  主干有我的 L4-B          : {'L4-B' in final}")
    print(f"  主干有我的 L1-mine       : {'L1-mine' in final}")
    print(f"  分支用完即删            : {not task_branches(gh)}")
    return (both_local and "L2-A" in final and "L4-B" in final
            and "L1-mine" in final and not task_branches(gh))


def scene_hold(mod, label):
    """--hold 保留分支，后续推送复用同一分支，最后 --merge 合并。"""
    setup_repo({"h.txt": ("100644", b"v0\n")})
    gh = GH({"h.txt": ("100644", b"v0\n")})
    run(mod, gh, ["--init-baseline", "--yes"])

    write("h.txt", "v1\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/hold", "-m", "第一次"])
    after1 = len(task_branches(gh))
    write("h.txt", "v2\n")
    run(mod, gh, ["--yes", "--hold", "-m", "第二次"])   # 复用同一分支
    branches = task_branches(gh)
    run(mod, gh, ["--merge", "--yes"], name="merge")
    final = main_file(gh, "h.txt")

    print(f"\n=== {label} ===")
    print(f"  --hold 后分支保留       : {after1 == 1}")
    print(f"  复用同一分支（应 1 个） : {len(branches)} {branches}")
    print(f"  PR 数（应 1）           : {len(gh.prs)}")
    print(f"  合并后内容正确          : {final.strip() == 'v2'}")
    print(f"  合并后分支已删          : {not task_branches(gh)}")
    return (after1 == 1 and len(branches) == 1 and len(gh.prs) == 1
            and final.strip() == "v2" and not task_branches(gh))


def scene_no_silent_revert(mod, label):
    """--hold 期间主干前进：差异全集同步，PR 不出现「回退主干」。

    这是防漏传最关键的一条：只推用户改动的文件，分支里残留的旧版本
    会让 PR diff 显示成「把主干改动改回去」，合并时被当成故意回退而采纳。
    """
    setup_repo({"f1.txt": ("100644", b"A_v1\n"), "f2.txt": ("100644", b"B_v1\n")})
    gh = GH({"f1.txt": ("100644", b"A_v1\n"), "f2.txt": ("100644", b"B_v1\n")})
    run(mod, gh, ["--init-baseline", "--yes"])

    # 我基于当前主干 --hold 开分支，改 f2
    write("f2.txt", "B_v2\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/drift", "-m", "我改 f2"])

    # 期间别人把 f1 推到主干
    other_commit(gh, {"f1.txt": b"A_v2\n"})

    # 我同步主干后再推一次 --hold（分支基点已落后）
    run(mod, gh, ["--pull", "--yes"], name="pull")
    write("f2.txt", "B_v3\n")
    out, err = run(mod, gh, ["--yes", "--hold", "-m", "我再改 f2"], name="push2")

    run(mod, gh, ["--merge", "--yes"], name="merge")
    f1 = main_file(gh, "f1.txt")
    f2 = main_file(gh, "f2.txt")

    # 只断言文件级结果，不断言提示文案：脚本改个措辞就会假阴性，
    # 而真正要保证的是「主干上别人的改动没被回退」。
    print(f"\n=== {label} ===")
    print(f"  主干 f1 保留别人的 A_v2 : {f1.strip() == 'A_v2'}")
    print(f"  主干 f2 是我的 B_v3     : {f2.strip() == 'B_v3'}")
    return f1.strip() == "A_v2" and f2.strip() == "B_v3"


def scene_conflict(mod, label):
    """真冲突：分支建好后主干被他人改了同一行 → 合并 409 → 收摊 → 解决 → 成功。

    注意本地带冲突标记时脚本会先拦住（不许把损坏文件推上去），
    所以「GitHub 侧 409」要用「分支基点落后于主干」来构造。
    """
    base = "one\ntwo\nthree\n"
    setup_repo({"c.txt": ("100644", base.encode())})
    gh = GH({"c.txt": ("100644", base.encode())})
    run(mod, gh, ["--init-baseline", "--yes"])

    # 我开了一个 --hold 分支（基点 = H0），改了 two
    write("c.txt", base.replace("two", "TWO-B"))
    run(mod, gh, ["--yes", "--hold", "-b", "task/b", "-m", "我改 two"])

    # 主干被他人改了同一行
    other_commit(gh, {"c.txt": base.replace("two", "TWO-A").encode()})

    out, err = run(mod, gh, ["--merge", "--yes"], name="merge conflict")
    conflicted = gh.merge_conflicts == 1 and "冲突" in out
    cleaned = not task_branches(gh)
    pr_closed = all(p["state"] == "closed" for p in gh.prs.values())

    # 把主干改动合进本地 → 本地出现冲突标记
    run(mod, gh, ["--pull", "--yes"], name="pull")
    marked = "<<<<<<<" in read("c.txt")

    # 带着标记推 → 应被拦下
    out2, err2 = run(mod, gh, ["--yes", "-m", "试试带标记推"], name="push marked")
    push_blocked = err2 is not None and "冲突" in err2

    # 手工解决 → --resolve → 再推
    write("c.txt", "one\nTWO-AB\nthree\n")
    run(mod, gh, ["--resolve", "c.txt"])
    run(mod, gh, ["--yes", "-m", "已解决冲突"], name="retry")
    final = main_file(gh, "c.txt")
    expect = "one\nTWO-AB\nthree"

    print(f"\n=== {label} ===")
    print(f"  GitHub 报 409 冲突      : {conflicted}")
    print(f"  收摊：分支已删          : {cleaned}")
    print(f"  收摊：PR 已关           : {pr_closed}")
    print(f"  --pull 标出冲突         : {marked}")
    print(f"  带标记推送被拦          : {push_blocked}")
    print(f"  解决后重试成功          : {final.strip() == expect}")
    return (conflicted and cleaned and pr_closed and marked
            and push_blocked and final.strip() == expect)


def scene_prune(mod, label):
    """--prune 只报告不删；判据是合并/活动状态，不是「N 天没用」。"""
    setup_repo({"p.txt": ("100644", b"p\n")})
    gh = GH({"p.txt": ("100644", b"p\n")})
    run(mod, gh, ["--init-baseline", "--yes"])

    # 已合并 5 天但分支还在（异常残留）→ 应报告
    gh.refs["task/stale-merged"] = gh.refs["main"]
    gh.branch_base["task/stale-merged"] = gh.refs["main"]
    gh.prs[90] = {"number": 90, "state": "closed", "merged": True,
                  "merged_at": iso(5), "updated_at": iso(5),
                  "head": {"ref": "task/stale-merged"}, "base": {"ref": "main"}}

    # 刚合并 1 天（正常流程）→ 应静默
    gh.refs["task/fresh-merged"] = gh.refs["main"]
    gh.branch_base["task/fresh-merged"] = gh.refs["main"]
    gh.prs[91] = {"number": 91, "state": "closed", "merged": True,
                  "merged_at": iso(1), "updated_at": iso(1),
                  "head": {"ref": "task/fresh-merged"}, "base": {"ref": "main"}}

    # 开启中（WIP）→ 报告但保留
    gh.refs["task/wip"] = gh.refs["main"]
    gh.branch_base["task/wip"] = gh.refs["main"]
    gh.prs[92] = {"number": 92, "state": "open", "merged": False, "merged_at": None,
                  "updated_at": iso(10), "head": {"ref": "task/wip"},
                  "base": {"ref": "main"}}

    # 孤儿分支（无 PR）→ 报告
    gh.refs["task/orphan"] = gh.refs["main"]
    gh.branch_base["task/orphan"] = gh.refs["main"]

    before = sorted(gh.refs)
    out, err = run(mod, gh, ["--prune"], name="prune")

    print(f"\n=== {label} ===")
    print(f"  一个分支都没删          : {sorted(gh.refs) == before}")
    print(f"  已合并 5 天 → 报告清理  : {'stale-merged' in out and '应当清理' in out}")
    print(f"  刚合并 1 天 → 静默      : {'无需处理' in out}")
    print(f"  WIP 分支 → 保留并报告   : {'wip' in out and '保留' in out}")
    print(f"  孤儿分支 → 报告         : {'orphan' in out}")
    return (sorted(gh.refs) == before and "stale-merged" in out
            and "应当清理" in out and "无需处理" in out
            and "wip" in out and "orphan" in out)


def scene_committed_change(mod, label):
    """P0 回归：用户先 git commit 到本地，改动必须还能推上去。

    git 协议被网关拦成 403 时，用户的直觉反应就是「先提交到本地」，
    而 commit 后工作区变干净，纯靠 git status 就再也看不见这些改动了 ——
    静默失败，用户会误以为已同步。direct 与 PR 两种模式都要覆盖。
    """
    results = {}
    for wf, argv in (("direct", ["--direct"]), ("pr", [])):
        files = {"cm.txt": ("100644", b"v1\n")}
        setup_repo(files)
        gh = GH(files)
        run(mod, gh, ["--init-baseline", "--yes"])

        write("cm.txt", "v2\n")
        git("add", "-A")
        git("commit", "-qm", "本地先提交")        # 工作区变干净
        assert git("status", "--porcelain").stdout.strip() == ""

        out, err = run(mod, gh, ["--yes", "-m", "推上去"] + argv, name=f"{wf} push")
        pushed = main_file(gh, "cm.txt") == "v2\n"
        no_silent = "没有待推送的改动" not in out
        results[wf] = pushed and no_silent

    print(f"\n=== {label} ===")
    print(f"  direct 模式能推上去      : {results['direct']}")
    print(f"  PR 模式能推上去          : {results['pr']}")
    return results["direct"] and results["pr"]


def scene_committed_then_pull(mod, label):
    """commit 后主干前进：先 --pull 合入远端，再推，双方改动都在。"""
    files = {"cp.txt": ("100644", "L1\nL2\nL3\nL4\nL5\n".encode())}
    setup_repo(files)
    gh = GH(files)
    run(mod, gh, ["--init-baseline", "--yes"])

    write("cp.txt", "L1\nL2\nL3\nL4-mine\nL5\n")
    git("add", "-A")
    git("commit", "-qm", "我先提交")

    other_commit(gh, {"cp.txt": "L1\nL2-theirs\nL3\nL4\nL5\n".encode()})

    out, err = run(mod, gh, ["--pull", "--yes"], name="pull")
    local = read("cp.txt")
    merged = "L4-mine" in local and "L2-theirs" in local

    out2, err2 = run(mod, gh, ["--yes", "-m", "推"], name="push")
    final = main_file(gh, "cp.txt")

    print(f"\n=== {label} ===")
    print(f"  --pull 合入远端改动      : {'L2-theirs' in local}")
    print(f"  --pull 保留我的改动      : {'L4-mine' in local}")
    print(f"  推送后主干含双方改动     : {'L2-theirs' in final and 'L4-mine' in final}")
    return merged and "L2-theirs" in final and "L4-mine" in final


def scene_direct(mod, label):
    """--direct 旧行为不坏。"""
    base = "L1\nL2\n"
    setup_repo({"d.txt": ("100644", base.encode())})
    gh = GH({"d.txt": ("100644", base.encode())})
    run(mod, gh, ["--init-baseline", "--yes"])
    write("d.txt", "L1-mine\nL2\n")
    run(mod, gh, ["--yes", "--direct", "-m", "直推"])
    print(f"\n=== {label} ===")
    print(f"  推送成功                : {bool(gh.pushed)}")
    print(f"  内容进主干              : {'L1-mine' in (main_file(gh, 'd.txt') or '')}")
    print(f"  未建任务分支            : {not task_branches(gh)}")
    return (bool(gh.pushed) and "L1-mine" in (main_file(gh, "d.txt") or "")
            and not task_branches(gh))


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = load_mod(target, "prmod")
    results = []
    for fn in (scene_stale_blocked, scene_parallel, scene_hold,
               scene_no_silent_revert, scene_conflict, scene_prune,
               scene_committed_change, scene_committed_then_pull, scene_direct):
        try:
            ok = fn(mod, fn.__name__.replace("scene_", ""))
            results.append((fn.__name__, ok))
        except Exception:
            import traceback
            traceback.print_exc()
            results.append((fn.__name__, False))
    print("\n---- 汇总 ----")
    for n, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    print("总判定:", "ALL PASS" if all(o for _, o in results) else "有失败")
