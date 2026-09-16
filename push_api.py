#!/usr/bin/env python3
"""通过 GitHub Git Data API 推送本地改动到远端 main。

背景
----
沙盒到 github.com 的 git / https 协议被网关拦成 403（带 token 也一样），
只有 api.github.com 通，所以推送只能走 Git Data API。

但 API 的 tree 更新是**整文件替换**，不带三方合并与冲突检测：
只要 ref 能快进（parent 取的是远端最新提交），本地某个文件的全文就会
直接顶掉远端同名文件——如果远端该文件已被别人改动，改动会静默消失。
因此本脚本加了四层防护（见 main() 里的注释）。

用法
----
  【默认 · 每次新建分支】推 → 自动合并 → 删分支，一条命令走完
  python3 push_api.py                 # 新建分支 → 推 → 开 PR → squash 合并 → 删分支
  python3 push_api.py -b feat/login   # 指定分支名（不给就自动生成 task/时间戳-随机）
  python3 push_api.py --hold          # 先不合并，保留分支攒改动
  python3 push_api.py --merge         # 合并 --hold 留下的 PR
  python3 push_api.py --method rebase # 换合并方式（默认 squash）

  【分支体检】只报告，不删任何东西
  python3 push_api.py --prune             # 列出所有任务分支的状态和建议
  python3 push_api.py --delete-branch 名字 # 真正删除（逐个确认）
  python3 push_api.py --branch 名字 --close-pr
  python3 push_api.py --status

  【直推主干】旧行为，四层防护照旧
  python3 push_api.py --direct

  【通用】
  python3 push_api.py --dry-run / --yes / -m "信息" / a.js b.js
  python3 push_api.py --pull [文件...]  # 三方合并主干改动到本地
  python3 push_api.py --resolve 文件    # 标记冲突已手工解决
  python3 push_api.py --init-baseline / --reset-baseline / --mark-synced
  python3 push_api.py --force-file 文件 / --force-overwrite   # 只有 --direct 才需要

为什么默认走 PR
----------------
  把「互相覆盖」交给 GitHub 的 merge 判定：合并时它做真正的**三方合并**
  （以 merge base 为基准）。两人从同一基点各自改动 → 自动合上，或明确报
  409 冲突，都不会静默丢改动。

  每次推送都新建分支，是为了让分支基点 = 当前主干最新。基点越新，PR diff
  越小，三方合并的冲突面也越小；反过来，一个活了很久的分支基点会停在
  建分支那一刻，diff 越滚越大，人工介入越多就越容易出错。

  有一种情况 PR 也救不了：本地副本落后于主干，分支却是从最新主干建的。
  这时你的旧内容相对分支基点等于「把主干改动改回去」，GitHub 会当成你
  故意回退并直接采纳。所以「本地副本落后」**依然拦截** —— 先 --pull。

分支体检（--prune）
------------------
  判据是「合并状态 + 活动状态」，不是「N 天没用」：
    已合并 > 3 天，分支却还在 → 报告（正常流程早该删了）
    已合并 ≤ 3 天              → 静默（删除流程多半还在跑）
    PR 仍开启                  → 报告并保留（可能是进行中的工作）
    PR 已关闭 / 孤儿分支        → 报告，给删除命令
  一个开发到一半的 WIP，恰恰就是「开着、没合并、好几天没动」，
  按时间自动删会最先误杀它 —— 所以 --prune 只报告，删除一律走
  --delete-branch 并逐个确认。

同机并发
--------
  同一台机器上同时跑两个本脚本，第二个会**等待**第一个跑完（基线文件有锁），
  不是并行、也不是报错。锁会持有到整次推送结束，等待时屏幕上有提示。
  多人各用一台机器则不受影响 —— 那种并发由 GitHub 的合并机制保证。

约定
----
  · 基线状态写在 /data/workspace/.push-sync.json（仓库外，不入库）
  · 首次使用必须先跑 --init-baseline，否则推送会被拒绝
  · token 从环境变量 GITHUB_TOKEN 读取（禁止写进脚本）；
    传给 curl 时走 --config 临时文件，不出现在进程列表里
  · --dry-run 会做大文件预检并给出警告，但不推送、不建分支
  · 分支不是备份：改动存在本地工作区，合并失败时收掉分支不会丢东西
"""
import base64
import calendar
import contextlib
import difflib
import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

# Token 只从环境变量读取，不落盘、不入库。
#   导出方式：export GITHUB_TOKEN=github_pat_xxx
# 注意：旧版本曾把 PAT 明文写在本文件里，若该 PAT 曾被推送到公开仓库，
# 请立刻到 GitHub → Settings → Developer settings → Personal access tokens 吊销。
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
OWNER, REPO = "adwlachowicz684-star", "tauriTools"
BASE = f"https://api.github.com/repos/{OWNER}/{REPO}"
ROOT = "/data/workspace/tauriTools"
BRANCH = "main"
STATE_PATH = "/data/workspace/.push-sync.json"
MSG_FALLBACK = "chore: 通过 API 推送本地改动"

STATE_VERSION = 2                     # 1=只记 sha；2=记 (mode, sha)

USAGE = __doc__          # --help 直接打印模块 docstring（用法段就在里面）

MAX_BLOB_BYTES = 10 * 1024 * 1024     # 超过这个大小直接拒推（应改走 Git LFS）
MAX_PREVIEW_LINES = 20000             # 预览用 diff 的行数上限，超了只报行数差
MAX_PREVIEW_BYTES = 256 * 1024        # 超过这个大小不拉远端内容做预览
VALID_MODES = ("100644", "100755", "120000")
VALID_MERGE_METHODS = ("merge", "squash", "rebase")   # GitHub 支持的三种合并方式
DEFAULT_TIMEOUT = 60                  # 默认 curl 超时（秒）

# ---- PR 工作流 ----
TASK_PREFIX = "task/"                 # 任务分支前缀（清理时按它识别）

# 长期分支：--prune 体检时排除（主干另由 BRANCH 排除）。
# 用集合而非前缀白名单，理由见 prune() 里的注释。
PROTECTED_BRANCHES = set(
    b.strip() for b in
    os.environ.get("PUSH_API_PROTECTED", "main,master,develop,release").split(",")
    if b.strip())
DEFAULT_WORKFLOW = "pr"               # pr=任务分支+PR；direct=旧版直推主干
MERGED_GRACE_DAYS = 3                  # 已合并但分支仍在，超过这个天数才报告
                                      # （防止刚合并、删除流程还在跑就被反复报告）


# ---------------------------------------------------------------- 基础

def _timeout_for(size_bytes):
    """超时按体积动态算：每 MB 加 10 秒，30 秒保底，10 分钟封顶。"""
    return min(600, max(30, 30 + size_bytes // (1024 * 1024) * 10))


class _Cancel(Exception):
    """正常取消：不推送，但必须走与失败相同的分支清理路径。

    为什么不用 return：分支在 create_branch() 时就已经建好了，
    而下面还有多处「发现问题 → return」的提前退出。每处 return 都会
    把那个空分支留在远端，本地 tasks 里却没有记录 —— 只能靠 --prune
    偶然发现。实测最高频的一条：用户在确认提示按 N，100% 留僵尸分支。

    改成抛异常后，取消与失败走同一条清理通道，新增退出点时也不会忘记。
    """


class StateLock:
    """同一台机器上多个进程并发跑本脚本时，保护 .push-sync.json。

    基线是单机共享的，两个进程同时读写会互相覆盖：后写的那个会把先写的
    base_commit / synced_commit 冲掉，导致其中一个进程拿着过期基线继续判定，
    文件级防护随之失效。

    锁住让它们串行，反而更安全：脚本只用 `git add -- <本次文件>`，
    先跑完的那个不会卷走另一个人在工作区里的改动。

    **锁的持有范围是整个 _main()，包含全部网络请求** —— 建 blob、建树、
    建提交、开 PR、合并都会持锁。一次推送慢的话要等几分钟。
    这里刻意选了「简单且绝对安全」而不是「细粒度但容易写错」：
    基线的读→判定→写必须原子，拆成多段短锁反而会重新引入竞态。
    等待时会打印提示，不会无声卡住。

    注意：flock 只在**同一台机器**上有效。多人各用一台机器时不需要它 ——
    那种并发由 GitHub 的合并机制保证（见 merge_pr 的注释）。
    """
    def __init__(self, state_path, enabled=True):
        self.path = (state_path or STATE_PATH) + ".lock"
        self.enabled = enabled
        self.fd = None

    def __enter__(self):
        if not self.enabled:
            return self
        try:
            # 0600：与状态文件同权限（状态文件已改 0600）。锁文件本身不
            # 含敏感信息，但 0644 意味着同机其他用户能看到/推测仓库布局。
            self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
            # 先试非阻塞：抢不到就打一行提示再阻塞等待。
            # 锁会持有到整次推送结束（含全部网络请求），等待可能长达数分钟；
            # 一声不响地卡住会让人以为进程挂了，从而 Ctrl-C 或重复启动。
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                print(f"  ⏳ 另一个 push_api 进程正在运行，等待它释放 {os.path.basename(self.path)}…")
                print("     （同一台机器上并发推送会串行执行，这是刻意的："
                      "共享的基线文件不能被并发写坏）")
                fcntl.flock(self.fd, fcntl.LOCK_EX)
                print("  ✓ 已获得锁，继续执行")
        except OSError as e:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            raise SystemExit(f"无法锁定 {self.path}：{e}\n"
                             f"  另一个 push_api 进程正在跑；等它结束再试。")
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None
        return False


def require_token():
    """缺 token 必须在发请求前就失败，而不是拿到 401 后靠猜。"""
    if not TOKEN:
        raise SystemExit(
            "缺少 GITHUB_TOKEN 环境变量。\n"
            "  用法：export GITHUB_TOKEN=github_pat_xxx && python3 push_api.py ...\n"
            "  （token 请勿写进脚本或提交到仓库）"
        )
    return TOKEN


@contextlib.contextmanager
def _auth_config():
    """把 Authorization 头写进 0600 的临时文件，交给 curl --config 读。

    token 直接拼进 curl 的 argv 时，同机任何用户 `ps aux` 都能看到它 ——
    和「把 PAT 明文写进脚本」是同一类泄露，只是暴露面从仓库变成了进程列表。
    改用 --config 后，argv 里只剩一个不敏感的临时文件名。

    选 --config 而不是 `-H @file`：后者要 curl ≥ 7.55，且 @file 语法在不同
    版本间语义有差异；--config 是长期稳定的接口。stdin 也留给 payload 用。

    文件放 /dev/shm（内存盘，不落磁盘），不可用时回退系统临时目录；
    权限 0600，退出即删。

    token 先过白名单，只放行 GitHub token 的真实字符集 [A-Za-z0-9_.-]。

    写入的配置行是 `header = "Authorization: Bearer {tok}"`。
    token 里一旦出现 `"` 就能提前闭合引号、出现换行就能开启新的一行 ——
    而 curl 配置是「每行一条指令」，那意味着可以注入 `output = /path`
    或 `url = attacker.host` 这类指令。

    第一版白名单是 `re.sub(r"[^\x21-\x7E]", "", TOKEN)`（所有可打印 ASCII），
    它拦得住换行，却放行 `"` `\` 反引号 `$()`。实测这些字符暂不足以造成
    实际注入（curl 一行只解析一条指令，且后续内容被丢弃），但这是**碰巧
    安全** —— 依赖 curl 具体的解析细节，换版本或换配置写法就可能失效。

    收紧到 GitHub token 的真实字符集后，引号闭合这条路从根上就没有了。
    实测各类 token 均不受影响：ghp_ / gho_ / ghu_ / ghs_ / ghr_ /
    github_pat_ 前缀，以及旧版 40 位十六进制。

    用「拒绝」而不是「清洗掉非法字符」：清洗后 token 变了，请求必然 401，
    用户只会看到「认证失败」而不知为何；直接报「可能复制时混入了换行」
    才可诊断。
    """
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", TOKEN or ""):
        raise SystemExit(
            "GITHUB_TOKEN 含非法字符（可能是复制时混入了换行、引号或空格）。\n"
            f"  GitHub 的 token 只由 A-Z a-z 0-9 和 _ - . 组成（当前 "
            f"{len(TOKEN or '')} 个字符）。\n"
            "  请重新复制，注意不要带上换行或首尾空格。"
        )
    tok = TOKEN
    tmpdir = "/dev/shm" if os.path.isdir("/dev/shm") and os.access("/dev/shm", os.W_OK) else None
    fd, path = tempfile.mkstemp(prefix="pushapi-curl-", suffix=".cfg", dir=tmpdir)
    try:
        # try 从 mkstemp 之后就包住：chmod 若抛异常，fd 既没关闭也没被
        # finally 回收，属于泄漏。概率极低，但改起来没有成本。
        os.chmod(path, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            fd = None                     # 所有权已交给文件对象
            f.write(f'header = "Authorization: Bearer {tok}"\n')
        yield path
    finally:
        if fd is not None:                # 还没交给 fdopen，需要自己关
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(path)
        except OSError:
            pass


def _parse_headers(path):
    """读 curl dump 出的响应头，取限流相关字段。

    返回 dict（可能为空）。解析失败一律静默返回空 —— 解析限流头只是
    **改善提示**，不该因为格式变化就让请求失败。
    """
    info = {}
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                k, v = k.strip().lower(), v.strip()
                if k in ("x-ratelimit-remaining", "x-ratelimit-reset",
                         "retry-after", "x-ratelimit-used", "x-ratelimit-limit"):
                    info[k] = v
    except OSError:
        pass
    return info


def _rate_limit_hint(info):
    """把限流字段转成**能照着做**的提示。

    GitHub 的 Retry-After / X-RateLimit-Reset 都给了确切时间，
    却只提示「等几分钟」—— 用户既不知道等多久，也不知道是不是自己
    刚那次操作（比如预览了 200 个文件）把额度打光的。
    """
    if not info:
        return ""
    parts = []
    used, limit = info.get("x-ratelimit-used"), info.get("x-ratelimit-limit")
    if used and limit:
        parts.append(f"已用 {used}/{limit} 次")
    rem = info.get("x-ratelimit-remaining")
    if rem == "0":
        reset = info.get("x-ratelimit-reset")
        when = ""
        if reset and reset.isdigit():
            try:
                secs = int(reset) - time.time()
                if secs > 0:
                    m, sec = divmod(int(secs), 60)
                    when = f"约 {m} 分 {sec} 秒后" if m else f"约 {sec} 秒后"
            except (ValueError, OverflowError):
                when = ""
        parts.append("额度已用尽" + (f"，{when}重置" if when else ""))
    ra = info.get("retry-after")
    if ra:
        parts.append(f"服务端要求等待 {ra} 秒")
    if parts:
        parts.append("减少预览文件数（--yes 推进）或稍后重跑可缓解")
    return "；".join(parts)


def _retryable(method, path):
    """这个请求在 5xx / 429 时能否安全重试。

    判据是**幂等性**：服务端可能已经处理完毕、只是响应丢了，此时重发
    非幂等写会造成两类问题
      · PATCH /git/refs：第二次撞 422 not fast-forward，而调用方那句
        「出现并发提交，已中止」会把自己的重试**误报成他人抢先提交**，
        用户据此去排查根本不存在的并发
      · POST /git/commits、/git/trees、/pulls：重复建对象、重复消耗限流额度
    无法区分「没处理」和「处理了但响应丢了」，所以宁可不重试 ——
    失败是安全的（用户重跑即可），误报却会误导排查方向。

    例外：POST /git/blobs 是**内容寻址**的，重发得到同一个 sha，天然幂等，
    且大文件最容易撞 5xx，允许重试收益明显。
    """
    if method == "GET":
        return True
    if method == "POST" and path.startswith("/git/blobs"):
        return True
    return False


# GitHub 错误码 → 可操作的下一步。
# 只给出「原文」是不够的：用户看到 not fast-forward 只会往权限/设置上猜，
# 而正确的动作是 --pull。401/403/404/422 是最常撞的四条。
_HTTP_HINTS = {
    "401": ("token 无效或已过期：检查 GITHUB_TOKEN 环境变量是否设置、"
            "是否复制完整。\n        （GitHub 的 token 只由 A-Z a-z 0-9 和 _ - . 组成）"),
    "403": ("通常是限流或 token 缺权限"
            "（需要 Contents: write / Pull requests: write）。"),
    "404": ("仓库不存在，或 token 没有该仓库的访问权限。"),
    "409": ("冲突。PR 合并时报 409 有两种，处理方式完全不同：\n"
            "        · 内容冲突 → 先 --pull 合入远端改动；\n"
            "        · 分支不够新（仓库开了「必须与主干同步」保护）→ 在网页点\n"
            "          Update branch 即可，不必本地重推。"),
    "422": ("请求被拒绝。若是 not fast-forward：远端已前进，"
            "先跑 --pull 合入远端改动再推。"),
    "429": ("触发限流，稍后重试。"),
    "451": ("仓库因法律原因被封锁，通常需要联系 GitHub 支持。"),
}


CONFLICT_DIR = os.path.join(os.path.dirname(ROOT) or ".", ".push-conflicts")


def _local_head():
    """本地 git HEAD 的简短 sha（没有仓库时返回 None）。

    用来检测「用户在本地做了回退类 git 操作」。

    P0-1 的判据是 synced_commit == 远端 head_sha，含义是
    「本地包含了远端全部改动」。但 git 操作可以**悄悄改变本地文件内容**
    而不动 synced_commit：

        push v3  → synced_commit = 远端 v3
        git reset --hard HEAD~1  → 本地文件回到 v2，synced_commit 仍是 v3
        push     → P0-1 放行（v3 == v3），第一层也放行（远端 v3 == 基线 v3）
                 → 本地 v2 覆盖主干，v3 静默消失（已实测复现）

    git checkout <old> / git stash pop 同理。所以除了记「基于哪个远端版本」，
    还要记「当时本地 HEAD 在哪」，两者一起才能发现本地被回退。
    """
    out = git("rev-parse", "HEAD")
    return out or None


_REWIND_NO_BASELINE_WARNED = False


def _local_head_rewound(state):
    """本地 HEAD 是否被回退/分叉（相对上次同步时记录的 local_head）。

    判据：记录的 local_head 应该是当前 HEAD 的**祖先**（本地只会前进）。
    若不是 —— 说明用户在本地 reset/checkout 过，本地内容可能已经
    不包含远端的全部改动，此时推送有静默回退风险。

    返回 (是否回退, 说明)。无法判定时返回 (False, None)，不误报。
    """
    global _REWIND_NO_BASELINE_WARNED
    old = state.get("local_head")
    if not old:
        # P1-1：local_head 是本版新增字段，升级前的状态文件里都没有。
        # 静默跳过意味着**第零层对它们一律不生效**，用户完全不知道自己
        # 少了这道防护 —— 与「读不到仓库伪装成仓库干净」是同一类静默失败。
        if state.get("files") and not _REWIND_NO_BASELINE_WARNED:
            _REWIND_NO_BASELINE_WARNED = True
            print("  ! 状态文件里没有 local_head（本版新增字段），"
                  "本地回退检测暂不生效，将在下次成功同步后自动启用。")
        return False, None                    # 没记过 → 跳过，不猜
    cur = _local_head()
    if not cur or cur == old:
        return False, None
    # local_head 是 cur 的祖先？是 → 正常前进
    rc = subprocess.run(["git", "-C", ROOT, "merge-base",
                         "--is-ancestor", old, cur],
                        timeout=DEFAULT_GIT_TIMEOUT).returncode
    if rc == 0:
        return False, None                    # 正常前进
    if rc == 1:
        # P2-3：措辞要覆盖**合法切换分支**——git checkout 另一分支同样
        # 让 old 不是 cur 的祖先，语义上这不是「回退」而是「换了工作树」。
        return True, (f"本地 git HEAD 发生变化（回退/分叉，或切换了分支）："
                      f"上次同步时是 {old[:8]}，现在是 {cur[:8]}")
    # P1-2：rc>1（查不到 old 提交、仓库异常）**不能** fail-open。
    #
    # old 被 gc 回收时 git 返回 128。旧版走 `return False, None` 判成
    # 「未回退」直接放行 —— 而「记录里的提交找不到了」恰恰更像本地被动过
    # 的信号（reset/rebase/amend 都会换掉提交），不是「一切正常」的信号。
    # 静默 fail-open 等于在最该拦的时候解除防护。
    return True, (f"无法解析上次同步时记录的本地提交 {old[:8]}"
                  f"（git merge-base 退出码 {rc}）：该提交可能已被 gc 回收。"
                  f"\n   这更像本地被动过的信号，按「已回退」处理（fail-closed）。"
                  f"\n   确认本地没问题的话：python3 push_api.py --init-baseline 重建基线。")


def _refuse_if_rewound(state, action, extra=""):
    """「声明已同步」之前检查本地回退。回退时返回 True（调用方应中止）。

    必须在写 synced_commit / local_head **之前**调用：那两行一写，
    local_head 就被改写成当前 HEAD，回退证据当场抹掉，第零层从此失效。
    这正是 P0 的根因 —— 判据是对的，坏在出口。

    被拦下的用户最需要知道的是：**远端与基线一致时，--pull 不会动你的
    本地文件**。他跑了 --pull 以为同步好了，其实一个字节都没同步。
    """
    rewound, why = _local_head_rewound(state)
    if not rewound:
        return False
    print(f"\n❌ {why}")
    print(f"   这不是「远端有改动要合并」：远端与基线一致，{action} 没有可合并的内容，")
    print("   所以**不会改动你的本地文件**（这正是它刚才什么都没拉下来的原因）。")
    print("   此时声明「已同步」会让本地旧内容把远端静默覆盖掉。")
    print("   请先把本地恢复到回退前的版本：")
    print("     git reflog                  # 找到回退前的提交")
    print("     git reset --hard <那个提交>  # 或 git checkout <原分支>")
    if extra:
        print(extra)
    return True


def _conflict_path(rel, kind):
    """冲突副产物（.remote / .base）写到**仓库外**。

    写在 `rel + ".remote"`（仓库内）有三个问题，而且第三个最隐蔽：
      · 可能覆盖用户同名业务文件（rel.remote 恰好是真实文件），无备份不可恢复
      · resolve() 按名字删除时同样可能删掉用户的文件
      · **是未跟踪文件**：detect_changes() 用
        `git status --porcelain -z --untracked-files=all` 且无后缀过滤，
        会把它拾取 → 下次推送直接上远端。
        后果不只是污染：冲突内容等于换个文件名重新提交了一遍，
        若冲突文件含敏感信息就是明文泄露。

    路径里的分隔符换成 `__`，避免嵌套目录名与分隔符混淆。
    """
    safe = rel.replace(os.sep, "__").replace("/", "__")
    # 目录 0700、文件 0600：里面存的是**完整的远端明文内容**
    # （_report_conflict_artifacts 自己就是这么描述的），敏感度高于只含
    # 文件名清单的状态文件 —— 而状态文件早已收紧到 0600。明文那个反而
    # 更松（实测 0777）就没有道理了。
    #
    # makedirs 的 mode 只在**新建**时生效，已存在的目录要补一次 chmod；
    # 这里按「不存在才建、建完统一收紧」处理，避免依赖创建时机。
    if not os.path.isdir(CONFLICT_DIR):
        os.makedirs(CONFLICT_DIR, mode=0o700, exist_ok=True)
    try:
        os.chmod(CONFLICT_DIR, 0o700)
    except OSError:
        pass                      # 权限改不动不该阻断冲突处理
    return os.path.join(CONFLICT_DIR, f"{safe}.{kind}")


def _write_conflict_artifact(rel, kind, data):
    """写冲突副产物，创建即 0600 —— 里面是远端明文，不能沿用默认 umask。

    不用 `open(p, "wb")`：那样文件权限由 umask 决定（常见 0644 甚至 0777），
    事后 chmod 又留一个「刚创建时短暂可读」的窗口。os.open 建时给 mode
    才是原子的。
    """
    p = _conflict_path(rel, kind)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        f = os.fdopen(fd, "wb")          # 成功即接管 fd 的所有权
    except BaseException:
        os.close(fd)
        raise
    with f:
        f.write(data)
    return p


def _cleanup_failed_branch(branch, expect_sha=None, commit_sha=None):
    """推送中途失败时，删掉本次新建的分支（补偿式清理）。

    只删**本次新建**的：`--hold` 复用的分支里可能已有用户攒的改动，
    删掉会丢东西 —— 那种分支保留着，用户可以用 --merge / --prune 处理。

    还要挡住两种「删了反而更糟」的情况：

      · **PATCH 已成功**（分支 sha == commit_sha）：分支上已经有本次推送
        的内容，删掉等于回滚一次已完成的推送。这时该提示用户继续
        （--merge / --branch 复用），而不是悄悄抹掉。
      · **分支已被改动**（当前 sha != 创建时的 base）：说明不是我们留下的
        空分支，可能是别人也在用它，删掉会丢别人的东西。

    清理本身**静默失败**：网络也挂了的时候，删分支的错误会掩盖真正
    的失败原因，让用户看到一堆无关报错。
    """
    if not branch:
        return
    try:
        cur = ref_sha(branch)
    except BaseException:
        return
    if cur is None:
        return                                  # 已经没了
    if commit_sha and cur == commit_sha:
        # PATCH 已成功：分支上已有本次推送的内容。
        #
        # 仍然删除，但必须**明说**，不能静默回滚。理由：
        #   · 这是本次新建的分支（复用的分支 branch_created_now 为 None，
        #     上面已直接返回），内容只来自本次推送，工作区里完整保留，
        #     重跑一次即可重推 —— 删掉不丢东西。
        #   · 留着反而更糟：它既没有 PR、也不在本地 tasks 记录里，
        #     会成为只能靠 --prune 偶然发现的孤儿分支。
        # 报告担心的是「静默回滚」，那就把回滚说出来，而不是不删。
        print(f"\n  ! 分支 {branch} 已含本次推送内容，将回滚删除"
              f"（本地改动仍在，重跑即可重推）")
    elif expect_sha and cur != expect_sha:
        # 必须是 elif：PATCH 成功时 cur 是本次 commit，自然不等于主干
        # head_sha（expect_sha）。若写成独立的 if，这条会把「我们自己刚
        # 推上去的内容」误判成「被他人改动」而跳过清理，孤儿分支就回来了。
        print(f"\n  ! 分支 {branch} 已被改动（不是本次创建的空分支），跳过清理。"
              f"  请手动确认：--prune")
        return
    try:
        api("DELETE", _ref_path(branch), retries=1)
        print(f"  · 已清理本次新建的分支 {branch}（推送未完成）")
    except KeyboardInterrupt:
        # 只重抛 KeyboardInterrupt，不能吞：这里是**失败清理**路径，
        # 用户多半刚按过 Ctrl-C，静默 pass 会让第二次 Ctrl-C 失去响应，
        # 看起来像卡死。
        #
        # 但 SystemExit **必须继续吞**——清理本身失败（网络挂了）正是以
        # SystemExit 抛出的（api 走 _raise_api_error）。若一并重抛，
        # 「清理失败」会盖掉真正的失败原因，那正是这段 swallow 想避免的。
        raise
    except BaseException:
        pass


def _ref_path(ref):
    """分支名进 API 路径前必须编码。

    分支名允许含 `/`（task/2026...）以及 `?` `#` `%` 空格等字符 ——
    不编码的话 `?` 之后的部分会被当成 query string，请求打到别的
    端点上去，行为完全不可预测（且可能误操作到别的 ref）。

    只有 find_pr() 原本做了 quote，其余几处都是裸拼。统一走这里，
    避免下次新增调用点又漏掉。

    safe="/" 是**必须的**：GitHub 的端点是 `/git/refs/heads/{ref}`，
    `heads/` 之后的**整段**就是 ref 名（task/2026-xxx 里的斜杠是分支名
    的一部分）。第一版写成 safe="" 把 `/` 编成 %2F，结果所有任务分支
    都变成 task%2F2026xxx，请求全部 404 —— 10 套测试当场变红。
    """
    return "/git/refs/heads/" + quote(ref, safe="/")


def _recheck_ref(ref, expect_sha, when):
    """确认 ref 仍停在 expect_sha，否则中止并给出下一步。

    报错必须说清三件事，否则用户只会往权限上猜：
      · 远端前进到了哪（实际值 vs 预期值）
      · 是在哪个阶段发现的
      · 下一步该做什么（--pull），以及改动**没丢**（避免用户慌张重做）
    """
    now = api("GET", _ref_path(ref))["object"]["sha"]
    if now == expect_sha:
        return
    raise SystemExit(
        f"远端 {ref} 已前进到 {now[:8]}（本次基于 {str(expect_sha)[:8]}），"
        f"{when}检测到并发提交，已中止。\n"
        f"  先跑 python3 push_api.py --pull 把远端改动合进本地，再重新推送。\n"
        f"  （你的改动还在本地工作区，没丢。）"
    )


def _raise_api_error(method, url, code, body):
    """统一的 API 报错出口：GitHub 原文 + 可操作的下一步。

    raw 分支与 JSON 分支**共用这一个出口**。分成两处写迟早会漂移 ——
    上上轮的 P0 正是 raw 分支漏改造成的（引用了不存在的变量）。
    """
    hint = _HTTP_HINTS.get(code)
    msg = f"API {method} {url} → HTTP {code}"
    if body:
        msg += f": {body[:400]}"
    if hint:
        msg += f"\n  → {hint}"
    raise SystemExit(msg)


def api(method, path, payload=None, retries=3, timeout=None, raw=False,
        allow_404=False):
    """调 GitHub API。path 以 http 开头时按绝对 URL 用。

    raw=True 时改取原始字节（Accept: application/vnd.github.raw），
    用于拉大文件内容——JSON 形式的 blob 对超过 1MB 的文件不返回 content。
    此时返回 bytes 而非 dict。raw 只用于 GET，幂等，仍按下方策略退避重试。


    显式检查 HTTP 状态码：curl -s 会把 403/404/422 的错误体也原样返回，
    不检查的话调用方只能靠 "sha" in resp 这种启发式猜，排查成本很高。

    重试策略（**区分幂等性**，以 _retryable() 为准，不是这里写的）：
      · 超时（curl 退出码 28）**一律不重试** —— 服务端可能已生效，
        重试会重复建对象、重复消耗限流额度
      · curl 网络层失败（52/56 等）：同样过 _retryable，因为这类失败
        也可能是「服务端已处理、响应传输中断」
      · 5xx / 429：仅当 _retryable() 为真才重试 ——
        实现只对 GET 与 POST /git/blobs（内容寻址、天然幂等）返回 True
      · 429 的等待时间取 Retry-After（若有），不只用 2^n

    ⚠ 上一版 docstring 写的是「5xx：GET / POST 都退避重试」，与实现
    **不一致**：_retryable 从未对非 blob 的 POST 返回 True。
    写错的文档比没文档更糟 —— 维护者会照着它去「修正」实现，
    把安全的部分改得不安全。文档必须跟着实现走。
    """
    require_token()
    url = path if path.startswith("https") else BASE + path
    max_time = str(timeout or DEFAULT_TIMEOUT)
    # 响应头写临时文件：限流信息只在头里，不解析就只能给「等几分钟」
    # 这种模糊提示 —— 用户不知道要等多久，也不知道是不是自己的操作
    # （比如 preview 拉了上百次 blob）把额度打光的。
    #
    # 在循环**外**创建一次：curl -D 每次会覆盖文件，重试时无需重建；
    # 放循环内则每个 continue 分支都要记得删，极易漏（且漏了会积累
    # 一堆临时文件）。统一在 finally 里清理一处即可。
    hdrf = tempfile.NamedTemporaryFile(prefix="pushapi-hdr-", delete=False)
    hdrf.close()
    try:
      with _auth_config() as auth_cfg:
        for attempt in range(1, retries + 1):
            cmd = [
                # -L 跟随重定向：仓库改名 / 迁移后 GitHub 会返回 301，
                # 不加 -L 时 curl 把 301 的响应体原样返回，脚本按状态码
                # 判断会看到 404 —— 报「仓库不存在」，而真实原因是改名了。
                # 排查方向完全跑偏。
                "curl", "-sL", "--max-time", max_time, "-X", method, url,
                "--config", auth_cfg,          # token 走这里，不进 argv
                "-H", "Accept: application/vnd.github.raw" if raw
                      else "application/vnd.github+json",
                "-H", "Content-Type: application/json",
                "-H", "X-GitHub-Api-Version: 2022-11-28",
                "-D", hdrf.name,               # 响应头 → 文件
                "-w", "\n%{http_code}",
            ]
            if raw:
                # 原始字节写临时文件：不进 stdout，避免 8bit 数据被 text=True 破坏，
                # 也避免大文件整份驻留内存两次。
                # 状态码仍由 -w 写进 stdout，所以下面能和非 raw 分支共用重试判定。
                tmp = tempfile.NamedTemporaryFile(prefix="pushapi-", delete=False)
                tmp.close()
                try:
                    cmd += ["-o", tmp.name]
                    out = subprocess.run(cmd, capture_output=True, text=True)
                    code = (out.stdout.rpartition("\n")[2].strip()
                            if out.returncode == 0 else "")
                    if out.returncode == 0 and code.startswith("2"):
                        with open(tmp.name, "rb") as f:
                            return f.read()
                finally:
                    os.unlink(tmp.name)

                # 与 JSON 分支同一套重试语义：raw 只用于拉大文件，
                # 而大文件恰恰更容易撞 5xx —— 不重试的话一次抖动就整个失败。
                if out.returncode == 28:
                    raise SystemExit(
                        f"拉取超时（{max_time}s）{method} {url}\n"
                        f"  不重试：请确认网络后重跑。"
                    )
                if out.returncode != 0:
                    # 与 JSON 分支同一套判据（raw 目前只用于 GET，恒为 True，
                    # 但保持一致，将来 raw 若扩展到写请求不会静默变得不安全）。
                    if attempt < retries and _retryable(method, path):
                        time.sleep(2 ** attempt)
                        continue
                    raise SystemExit(f"curl 失败（退出码 {out.returncode}）: {out.stderr}")
                if allow_404 and code == "404":
                    return None
                retryable = ((code in ("500", "502", "503", "504") or code == "429")
                             and _retryable(method, path))
                if retryable and attempt < retries:
                    time.sleep(2 ** attempt)
                    continue
                # raw 分支把响应体写到临时文件且不保留文本，这里没有 body 可传。
                # 传 None 而不是直接用变量名 —— 用不存在的变量会 NameError，
                # 上上轮的 P0 就是这么来的。
                _raise_api_error(method, url, code, None)
            if payload is not None:
                body = json.dumps(payload)
                # 大 payload 走临时文件：10MB 文件在推送路径上会同时存在
                # base64 串、JSON 串、编码后字节**三份**，峰值内存约 3×。
                # 让 curl 直接读文件（@file），Python 侧只留一份。
                if len(body) > 8 * 1024 * 1024:
                    pf = tempfile.NamedTemporaryFile(
                        prefix="pushapi-body-", mode="w", delete=False,
                        encoding="utf-8")
                    try:
                        pf.write(body)
                        pf.close()
                        cmd += ["--data-binary", "@" + pf.name]
                        out = subprocess.run(cmd, capture_output=True, text=True)
                    finally:
                        try:
                            os.unlink(pf.name)
                        except OSError:
                            pass
                else:
                    cmd += ["--data-binary", "@-"]
                    out = subprocess.run(cmd, input=body, capture_output=True,
                                         text=True)
            else:
                out = subprocess.run(cmd, capture_output=True, text=True)

            if out.returncode != 0:
                if out.returncode == 28:
                    raise SystemExit(
                        f"请求超时（{max_time}s）{method} {url}\n"
                        f"  不重试：服务端可能已生效，重试会重复创建。请确认远端状态后重跑。"
                    )
                # 网络层失败（7 / 52 / 56 …）同样要过 _retryable()。
                #
                # 这类失败与「响应丢了」无法区分 —— 服务端可能已经处理完，
                # 只是传输中断。对非幂等写重试的后果 _retryable() 里写得很
                # 清楚：PATCH /git/refs 第二次撞 422，而调用方那句「出现并发
                # 提交，已中止」会把**自己的重试**误报成他人抢先提交，
                # 用户据此去排查一个根本不存在的并发。
                #
                # 这里原先无条件重试，与 api() docstring 里「同样过
                # _retryable」的声明不一致 —— 文档是对的，实现漏了。
                if attempt < retries and _retryable(method, path):
                    time.sleep(2 ** attempt)
                    continue
                raise SystemExit(f"curl 失败（退出码 {out.returncode}）: {out.stderr}")

            body, _, code = out.stdout.rpartition("\n")
            code = code.strip()
            _hdr_info = _parse_headers(hdrf.name)
            if _hdr_info and code in ("403", "429"):
                hint = _rate_limit_hint(_hdr_info)
                if hint:
                    print(f"  ! 限流：{hint}")
            try:
                data = json.loads(body or "{}")
            except json.JSONDecodeError:
                raise SystemExit(f"响应非 JSON (HTTP {code}): {body[:400]}")

            if code.startswith("2"):
                return data
            if allow_404 and code == "404":
                return None
            retryable = ((code in ("500", "502", "503", "504") or code == "429")
                         and _retryable(method, path))
            if retryable and attempt < retries:
                # 429 时 GitHub 会在 Retry-After 里给出确切等待时间，
                # 固定 2/4/8 秒远低于它的建议 —— 按建议等，别硬撞。
                wait = 2 ** attempt
                if code == "429":
                    ra = _hdr_info.get("retry-after")
                    if ra and ra.isdigit():
                        wait = max(wait, min(int(ra), 60))
                time.sleep(wait)
                continue
            _raise_api_error(method, url, code, body)
    finally:
        try:
            os.unlink(hdrf.name)
        except OSError:
            pass


def _git_add_paths(paths):
    """git add 一批路径，用 --pathspec-from-file 而不是 argv 展开。

    `git add -- *paths` 在文件数上千时会触碰 ARG_MAX（典型 2MB），
    触发 E2BIG 让整个推送失败。--pathspec-from-file 从 stdin 读路径，
    没有 argv 长度限制。

    用 -z（`--pathspec-file-nul`）接收 NUL 分隔：路径可能含换行，
    按行分隔会把它拆成两个 pathspec。

    失败时**回退**到逐个 add：批处理模式下单个路径有问题（比如被
    .gitignore 拦下）会让整批失败，而逐个子进程时坏的会被跳过、
    正常文件仍进暂存区。宁可慢一点，不能一个坏路径拖垮整批。
    """
    if not paths:
        return
    if len(paths) < 200:
        # 少量路径没必要走 stdin，直接 argv 更简单也更易诊断
        git("add", "--", *paths)
        return
    try:
        proc = subprocess.run(
            ["git", "-C", ROOT, "add", "--pathspec-from-file=-",
             "--pathspec-file-nul"],
            input="\0".join(paths), capture_output=True, text=True,
            errors="surrogateescape", timeout=DEFAULT_GIT_TIMEOUT)
        if proc.returncode == 0:
            return
    except subprocess.TimeoutExpired:
        pass
    print(f"  ! 批量 git add 未成功，回退为逐个添加（{len(paths)} 个）")
    for p in paths:
        git("add", "--", p)


def safe_input(prompt, default=""):
    """读一行输入；非交互环境（无 TTY / 管道 / CI）返回 default 而不抛异常。

    `input()` 在 stdin 关闭或耗尽时直接抛 EOFError。脚本里有 9 处交互确认，
    任何一处抛出来都是**裸 traceback 中断整个流程** —— 用户看到的不是
    「请加 --yes」而是一堆栈，且不知道该怎么继续。

    顶层虽然也兜了 EOFError，但那只能把 traceback 换成人话，**流程已经断了**：
    比如 --merge 时先列了 PR 再问选哪个，EOF 一抛，用户连列表都白看了。

    默认值一律取**安全侧**（""，即"否"）：
      · 确认类问题（删除 / 覆盖 / 合并）→ 不确认，宁可什么都不做
      · 提交信息类 → 空串，由调用方回落到默认文案
    绝不能默认"同意"——否则 CI 里所有确认都会被静默放行。
    """
    try:
        return input(prompt)
    except EOFError:
        # 只提示一次：多个确认点连续 EOF 时会刷屏。
        if not getattr(safe_input, "_warned", False):
            safe_input._warned = True
            print("\n  ! 非交互环境（无 TTY / 管道 / CI），"
                  "所有确认按「否」处理。加 --yes 或 -y 可跳过交互。")
        return default


# git 超时。个别 git 操作（大仓库的 hash-object、ls-files）可能挂住，
# 没有超时会让整个推送永久卡死 —— 用户只能 Ctrl-C，而那时远端状态未知。
DEFAULT_GIT_TIMEOUT = 120


def git(*args, check=False, fatal=False, timeout=None):
    """跑 git。check=True 时非 0 直接中止；fatal=True 时给**可诊断**的报错。

    默认不中断但**必须告警**：只看 stdout 会让失败完全静默——
    `git add` 部分路径被 .gitignore 拦下时退出码为 1，
    正常文件虽然进了暂存区，调用方却以为全部成功。

    只去掉末尾换行，**不用 strip()**：git status --porcelain 的 X 列是
    「暂存区状态」，未暂存修改输出为 " M a.txt"（开头一个空格）。
    strip() 会把这个空格吃掉，字符串变成 "M a.txt"，按 `item[3:]` 切出来的
    路径就成了 ".txt" —— 最常见的「改完文件没 add」场景会静默推空。

    fatal=True 与 check=True 的区别：check 只抛原始错误信息，fatal 会
    先跑 _git_env_error() 给出**成因与解法**。用于「git 挂了就完全没有
    正确性可言」的读取路径（detect_changes / local_state_map）——
    它们一旦返回空，脚本会把「读不到仓库」伪装成「仓库是干净的」。
    """
    try:
        proc = subprocess.run(["git", "-C", ROOT, *args], capture_output=True,
                              text=True, errors="surrogateescape",
                              timeout=timeout or DEFAULT_GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        # 超时也要给可诊断的错误，不能裸抛 TimeoutExpired 堆栈。
        raise SystemExit(_git_env_error(
            f"git {' '.join(str(a) for a in args)[:60]} 超时"
            f"（>{timeout or DEFAULT_GIT_TIMEOUT}s）",
            ""))
    if proc.returncode != 0:
        msg = f"git {' '.join(args)} 退出码 {proc.returncode}"
        if proc.stderr.strip():
            msg += f"：{proc.stderr.strip()[:300]}"
        if fatal:
            raise SystemExit(_git_env_error(msg, proc.stderr or ""))
        if check:
            raise SystemExit(msg)
        print(f"  ! {msg}")
    return proc.stdout.rstrip("\n")


def _git_env_error(msg, stderr=""):
    """git 失败时给出**可诊断**的报错。

    不能直接把「git 退出码 128」抛给用户：那只会让人去查命令语法，
    而真实成因通常是环境问题，且**每一种都有明确解法**。

    最危险的是「fatal: not a git repository」与「dubious ownership」——
    两者都让 git 返回空，于是 detect_changes()=[]、local_state_map()={}，
    脚本最终打印「本地没有待推送的改动」—— **读不到仓库被伪装成仓库是
    干净的**。用户以为没事，改动其实一个都没推（--direct 模式实测）。
    """
    hint = ""
    low = (stderr or "").lower()
    if "not a git repository" in low:
        hint = (f"\n  当前目录不是 git 仓库：{ROOT}\n"
                f"  本脚本靠 git 检测改动，仓库不可用就无法判断「改了什么」。\n"
                f"  解决：cd 到仓库根目录，或先 git init。")
    elif "dubious ownership" in low:
        hint = (f"\n  仓库属主与当前用户不一致，git 拒绝操作（dubious ownership）。\n"
                f"  这在容器 / 挂载卷场景下极常见：仓库属主是宿主机 uid，"
                f"容器内 euid 不同。\n"
                f"  解决：git config --global --add safe.directory {ROOT}")
    elif "not inside" in low or "is-inside-work-tree" in low:
        hint = (f"\n  {ROOT} 不在 git 工作树内。\n"
                f"  解决：cd 到仓库根目录再运行。")
    return msg + (hint or "\n  git 不可用，无法判断本地改动。") + \
        "\n  ⚠ 不是「没有改动」，是**读不到仓库** —— 请勿据此认为推送成功。"


def _stash_hint():
    """git stash 里还有东西时返回一句提示，否则返回空串。

    `git stash` 之后工作区变干净，detect_changes() 自然为空，脚本只会说
    「本地没有待推送的改动」。改动没丢（在 stash 里），但这句话会让用户
    以为它凭空消失了 —— 尤其是他自己忘了刚 stash 过的时候。

    只在「没有改动」这条路径上提示，平时不打扰；查不到就返回空串，
    绝不因为这条附加信息阻断任何流程。
    """
    try:
        p = subprocess.run(["git", "-C", ROOT, "stash", "list"],
                           capture_output=True, text=True,
                           timeout=DEFAULT_GIT_TIMEOUT)
        if p.returncode != 0:
            return ""
        n = len([l for l in (p.stdout or "").splitlines() if l.strip()])
        if not n:
            return ""
        return (f"  ! git stash 里还有 {n} 条改动（未丢失）："
                f"`git stash list` 查看，`git stash pop` 取回。\n"
                f"    工作区此刻是干净的吗？你可能是 stash 之后忘了 pop。")
    except BaseException:
        return ""


def branch_protection(branch):
    """查分支保护配置；未开启返回 None，查询失败返回 False（未知）。

    三态而不是两态：
      · dict  → 确实开了保护
      · None  → 确认没开（GitHub 对未保护分支返回 404）
      · False → **查不出来**（403 权限不足 / 网络错 / 响应异常）
    把「查不出来」和「没开」混成一种，会让无权限的用户以为可以直推，
    结果撞一个看不懂的 403 —— 这正是本函数想避免的事。
    """
    try:
        # 不能用 _ref_path()：那是 /git/refs/heads/... 的**完整路径**，
        # 而 /branches/{branch}/protection 要的是**分支名**（URL 编码后）。
        # 分支名含 / 时必须保留（quote 的 safe="/"），否则 task/xxx 变
        # task%2Fxxx → 404 → 被当成「没开保护」放行。
        from urllib.parse import quote
        return api("GET",
                   f"/branches/{quote(branch, safe='/')}/protection",
                   allow_404=True)
    except BaseException:
        return False


def _refuse_direct_if_protected(branch):
    """--direct 且主干开了 PR 保护时提前拒绝，别让用户撞看不懂的 403。

    开启「Require a pull request before merging」后，服务端会直接拒绝
    直推主干。此时 --direct 的所有优势（少几次 API、历史线性）都拿不到，
    只剩一个含糊的 403。早点说清楚，用户好改用默认 PR 流程。
    """
    prot = branch_protection(branch)
    if prot is None:
        return                                  # 确认没开保护，放行
    if prot is False:
        # 查不出来时**不拦**，但要说一声：静默放行等于把 403 留给用户猜。
        print(f"  ! 无法确认 {branch} 是否开启了分支保护（权限不足或网络问题）。"
              f"\n    若仓库开启了「Require a pull request」，本次直推会被服务端拒绝。")
        return
    # 判据必须用**键存在性**，不能用真值。
    #
    # GitHub 开启「Require a pull request」时 required_pull_request_reviews
    # 常常就是 {}（内部无附加要求）—— 空字典是 falsy，用 `or` 一判断就
    # 漏掉，保护开了却当成没开（实测：主干被直推成功）。
    # 这里任何一类保护存在即意味着「直推会被拒」，不需要细分。
    try:
        KEYS = ("required_pull_request_reviews", "required_status_checks",
                "enforce_admins", "restrictions", "required_signatures",
                "required_linear_history", "allow_force_pushes",
                "allow_deletions", "required_conversation_resolution")
        if not any(k in prot for k in KEYS):
            return                              # 响应里没有任何保护项
    except TypeError:
        return                                  # 响应结构异常，不猜
    if not isinstance(prot, dict):
        return
    raise SystemExit(
        f"❌ {branch} 已开启分支保护，--direct（直推主干）会被服务端拒绝。\n"
        f"   直推主干的优势（少几次 API 请求、历史线性）在开启保护后都不存在了。\n"
        f"   改用默认 PR 流程（去掉 --direct 即可）：\n"
        f"     python3 push_api.py -m \"<消息>\"\n"
        f"   若确认要直推，请先在仓库设置里关闭 "
        f"「Require a pull request before merging」。")


def require_git_repo():
    """启动即校验 git 可用。不可用直接中止，不让流程走到「误判无改动」。

    放在**最前面**（在拉远端状态之前）：git 不可用时后面全是无用功，
    而且越晚报错，用户越容易把「没推上去」当成「已经推了」。
    """
    proc = subprocess.run(["git", "-C", ROOT, "rev-parse", "--is-inside-work-tree"],
                          capture_output=True, text=True,
                          timeout=DEFAULT_GIT_TIMEOUT)
    if proc.returncode != 0 or proc.stdout.strip() != "true":
        raise SystemExit(_git_env_error(
            f"git rev-parse --is-inside-work-tree 失败（{ROOT}）",
            proc.stderr or ""))


def _inside_root(real_path):
    """realpath 之后的路径是否仍在仓库内 —— **唯一**的越界判据。

    必须抽成函数、让读侧（safe_rel）与写侧（_write_local 的 symlink 目标
    校验）共用：这两处原本各写一遍「路径在不在仓库内」，左边用
    realpath(ROOT) 比、右边拿裸 ROOT 比 —— 一边解析一边不解析。

    于是仓库根本身是软链时（容器挂载卷 / CI 工作区的常态）出现不对称：
    同一个合法路径，读侧放行、写侧判成「指向仓库外」并 SystemExit，
    而 SystemExit 会中断**整个** --pull，不只是跳过这一个文件（实测复现）。

    基准统一取 realpath(ROOT)：leading 软链解析掉之后，两侧才有可比性。
    """
    root = os.path.realpath(ROOT)
    return real_path == root or real_path.startswith(root + os.sep)


def safe_rel(rel):
    """把用户/脚本给的路径规范成仓库内相对路径；越界的返回 None。

    越界校验必须用 realpath 而非 normpath：normpath 只做字符串规整，
    会放过「仓库内指向外部的符号链接」——`etcdir -> /etc` 时
    `etcdir/passwd` 能通过 normpath 检查，open() 却读到 /etc/passwd。

    但返回值仍按 normpath 算，避免把 `link`（合法内部链接）改写它的目标路径。
    """
    if not rel or os.path.isabs(rel) or rel.startswith("~"):
        return None
    full = os.path.normpath(os.path.join(ROOT, rel))
    out = os.path.relpath(full, ROOT)
    if out == ".." or out.startswith(".." + os.sep):
        return None
    real = os.path.realpath(full)
    if not _inside_root(real):
        return None
    return out


def local_blob_sha(rel):
    """本地文件的 git blob sha（与 GitHub 的 blob sha 同一算法）

    必须用 `--no-filters`。

    `git hash-object <路径>` 会按 .gitattributes 应用 **clean filter**
    （CRLF 归一化、LFS 的指针替换等），算出的是「入库形态」的 sha；
    而本脚本上传的是工作区**原始字节**，GitHub 也照原样存。
    两者不一致 → 状态里记的 sha 与远端实际 blob sha 对不上 →
    下次推送误判「远端被他人改动」。

    实测（.gitattributes = `* text=auto eol=crlf`，工作区 CRLF）：
        git hash-object a.txt              → 94954abd（LF 归一化后）
        git hash-object --no-filters a.txt → 23eb407b（原始 CRLF）
        远端实际收到的是 CRLF，blob sha = 23eb407b
    用第一个就会永久误报。加 --no-filters 后 sha 恒等于所传字节的哈希。

    代价：当仓库配了 filter 时，本脚本推送的内容与 `git push` 的不一致
    （git 会存归一化后的，我们存原始字节）。这个差异由
    warn_if_filters_active() 显式告知，不静默。

    符号链接特殊处理：git 存的 symlink blob 内容是「目标路径字符串」，
    而 hash-object 默认会跟随链接读取目标文件内容，两者 sha 不一致。
    """
    full = os.path.join(ROOT, rel)
    if os.path.islink(full):
        # symlink 目标是**任意字节**（Linux 只排除 / 和 NUL），可以是非法
        # UTF-8。text=True 下 subprocess 用严格 UTF-8 编码 stdin，
        # 遇 surrogate 直接抛 UnicodeEncodeError —— 而这是**推送路径**上
        # 的调用，崩在 halfway 会留下脏的远端状态。
        # 用 surrogateescape 双向还原原始字节；去掉 text=True 后 stdout
        # 是 bytes，需显式 decode。
        raw = os.readlink(full).encode("utf-8", "surrogateescape")
        out = subprocess.run(["git", "-C", ROOT, "hash-object", "--stdin"],
                             input=raw, capture_output=True,
                             timeout=DEFAULT_GIT_TIMEOUT)
        return out.stdout.decode("utf-8", "replace").strip()
    return git("hash-object", "--no-filters", rel)


def local_blob_shas(rels):
    """批量算 git blob sha：一次子进程处理所有路径。

    逐个调 local_blob_sha() 时 N 个文件 = N 次 `git hash-object` 子进程。
    沙盒里 git 单次调用可到 1~5 秒，100 个改动文件就是几分钟 ——
    而这纯粹是可避免的进程开销。

    用 `--stdin-paths`：从 stdin 读路径列表，一次给出所有 sha（按输入顺序）。
    失败时**回退**到逐个计算：批处理下单个路径出问题会让整批失败，
    而逐个模式坏的会被跳过、其余仍然可用。
    """
    if len(rels) <= 1:
        return {r: local_blob_sha(r) for r in rels}
    try:
        proc = subprocess.run(
            ["git", "-C", ROOT, "hash-object", "--no-filters", "--stdin-paths"],
            input="\n".join(rels), capture_output=True, text=True,
            errors="surrogateescape", timeout=DEFAULT_GIT_TIMEOUT)
        if proc.returncode == 0:
            out = proc.stdout.split()
            if len(out) == len(rels):
                return dict(zip(rels, out))
    except subprocess.TimeoutExpired:
        pass
    return {r: local_blob_sha(r) for r in rels}


def warn_if_filters_active(files):
    """待推文件若受 .gitattributes 的 filter / 换行归一化影响，必须告知。

    用 --no-filters 求 sha 保证了「状态里的 sha == 远端实际 blob sha」，
    但副作用是本脚本推的是**原始字节**，与 `git push`（会存 clean 之后的
    内容）不一致。这个差异必须让人知道，否则用户以为两者等价。

    Git LFS 是**必须拒绝**的特例：clean filter 会把它变成一个小指针文件，
    而我们若上传原始字节，等于把整个大文件塞进 git 仓库、绕过 LFS ——
    仓库体积失控，且其他 clone 的人拿到内容与 LFS 不一致。

    批量查询（一次 git 调用），不为每个文件跑一遍 —— 上百个文件时
    逐个 subprocess 的开销实测很可观。
    """
    if not files:
        return
    out = git("check-attr", "text", "eol", "filter", "--", *files)
    rows = []
    for line in (out or "").splitlines():
        # 输出格式：<path>: <attr>: <value>
        parts = line.split(": ", 2)
        if len(parts) == 3:
            rows.append((parts[0], parts[1], parts[2]))
    lfs, normalized = [], []
    by_path = {}
    for path, attr, val in rows:
        by_path.setdefault(path, {})[attr] = val
    for p, attrs in by_path.items():
        if attrs.get("filter") not in (None, "unspecified", ""):
            if "lfs" in attrs["filter"]:
                lfs.append(p)
            else:
                normalized.append((p, f"filter={attrs['filter']}"))
        elif attrs.get("text") not in (None, "unspecified", "", "auto"):
            normalized.append((p, f"text={attrs['text']}"))
        elif attrs.get("eol") not in (None, "unspecified", ""):
            normalized.append((p, f"eol={attrs['eol']}"))

    if lfs:
        raise SystemExit(
            f"以下文件由 Git LFS 管理，本脚本拒绝推送：{sorted(lfs)[:10]}\n"
            f"  LFS 的 clean filter 会把内容换成一个小指针文件，"
            f"而这里只能上传原始字节 —— 等于绕过 LFS 把大文件塞进仓库。\n"
            f"  请用 git 命令行推送这些文件（脚本也提过：大文件应改走 Git LFS）。")

    if normalized:
        print(f"\n  ! {len(normalized)} 个文件受 .gitattributes 影响"
              f"（换行归一化 / 自定义 filter）：")
        for p, why in normalized[:5]:
            print(f"     - {p}: {why}")
        print("    本脚本上传的是**工作区原始字节**，与 `git push`"
              "（会存 clean 之后的内容）不同。")
        print("    远端内容与你本地一致，但与 git 仓库里的形态可能不同。")


# 树缓存：{ref_sha: {path: (mode, sha)}}。
# 一次推送里同一棵树会被拉 2~3 次（新分支时 base_sha == head_sha，
# 3355 行和 3002 行拉的是同一棵），每次都是一次 recursive=1 的全量请求。
# 大仓库下这笔开销可观，且是纯浪费 —— 同一个 commit 的树不会变。
_TREE_CACHE = {}


def remote_state_map(ref_sha, use_cache=True):
    """一次性取远端整棵树的 path → (mode, sha)

    mode 一起取：只比 sha 会漏掉「只改了可执行位」的变更（见 T-11）。

    use_cache：同一 ref_sha 在进程内复用结果。缓存**只按 commit sha 索引**，
    因为 git 的树是内容寻址的 —— 同一个 commit 的树不可能变化。
    需要强制刷新（比如刚推送完想看新状态）时显式传 use_cache=False。
    """
    if use_cache and ref_sha in _TREE_CACHE:
        return _TREE_CACHE[ref_sha]
    tree = api("GET", f"/git/trees/{ref_sha}?recursive=1")
    if tree.get("truncated"):
        raise SystemExit("远端 tree 被截断（仓库过大），无法做覆盖校验，已中止")
    if "tree" not in tree:
        # 别静默降级成空表：那会让每个文件都落到「基线未记录」分支，
        # 表现得像「疑似他人改动」，把网络/限流问题伪装成冲突。
        raise SystemExit(f"取远端 tree 失败: {json.dumps(tree, ensure_ascii=False)[:300]}")
    got = {t["path"]: (t.get("mode", "100644"), t["sha"])
           for t in tree["tree"] if t["type"] == "blob"}
    if use_cache:
        _TREE_CACHE[ref_sha] = got
    return got


def _corrupt_state(why, path=None):
    """状态文件非法：先把原文件留一份副本，再中止。

    必须先备份再报错：用户看到这条错误的下一步多半就是 --reset-baseline，
    那会直接覆盖原文件。留一份 .corrupt 既让他能回头检查，也不挡重建的路。
    """
    path = path or STATE_PATH
    backup = None
    try:
        # 只备份**普通文件**：目录会抛 OSError（已捕获）；FIFO 则更糟——
        # copy2 会去读它，然后永远阻塞在那里，连这条错误都打印不出来。
        if os.path.isfile(path) and not os.path.islink(path):
            backup = path + ".corrupt"
            shutil.copy2(path, backup)
    except OSError:
        backup = None
    hint = f"\n  原文已备份到 {backup}" if backup else ""
    raise SystemExit(
        f"{path} 内容不合法：{why}\n"
        f"  基线是「远端文件是否被他人改动」的唯一参照，"
        f"结构不对时继续跑会误判，因此必须停下。{hint}\n"
        f"  处理：确认无需保留后删除该文件，再跑 `python3 push_api.py --init-baseline`\n"
        f"  （重建后文件级防护会短暂失效，重建后建议先 --pull 同步一次）"
    )


def validate_state(state, path=None):
    """校验基线结构，合法则原样返回；非法则备份 + 中止。

    只拦 JSON **语法**错误远不够：语法合法但结构不对的状态文件
    （整个 state 是个数字、files 是个列表、conflicts 是个字符串……）
    会让后面的 .get() 直接 AttributeError 崩在半路，堆栈对排查毫无帮助。

    更危险的是 JSON 的 `null`：json.load 返回 None，而 load_state 用
    None 表示「文件不存在」—— 于是坏状态被当成首次使用，脚本会高高兴兴
    地引导用户重建基线，把唯一能判断「远端是否被改过」的参照**静默**丢掉。
    所以结构校验必须拦在返回 None 之前。

    逐项校验而非 try/except AttributeError：后者只能发现「用到才崩」的字段，
    没走到的分支依旧带着坏数据运行（conflicts 是字符串时就会这样）。
    """
    if not isinstance(state, dict):
        _corrupt_state(f"期望一个 JSON 对象，实际是 {type(state).__name__}", path)

    def chk(name, types, optional=False, exact=False):
        if name not in state:
            if optional:
                return
            _corrupt_state(f"缺少必需字段 {name!r}", path)
        v = state[name]
        if v is None and optional:
            return
        if exact and isinstance(v, bool) and bool not in (
                types if isinstance(types, tuple) else (types,)):
            # bool 是 int 的子类：`version: true` 能通过 int 校验。
            # 无害但语义不严谨，与整套状态校验的严谨风格不一致。
            _corrupt_state(f"{name!r} 不接受布尔值（实际是 {type(v).__name__}）", path)
        if not isinstance(v, types):
            want = "/".join(t.__name__ for t in types) if isinstance(types, tuple) else types.__name__
            _corrupt_state(f"{name!r} 应是 {want}，实际是 {type(v).__name__}", path)

    # bool 是 int 的子类，`version: true` 会被当成合法版本号。
    # 这里显式排除，与整套「18 种坏状态全拦」的严谨风格保持一致。
    chk("version", int, optional=True, exact=True)
    chk("files", dict)
    chk("tasks", dict, optional=True)
    chk("conflicts", list, optional=True)
    for k in ("base_commit", "synced_commit", "branch", "remote", "task_branch"):
        chk(k, str, optional=True)
    chk("pr_number", int, optional=True)

    ver = state.get("version")
    if isinstance(ver, int) and ver > STATE_VERSION:
        _corrupt_state(
            f"基线版本 {ver} 高于本脚本支持的 {STATE_VERSION}"
            f"（由更新版本的脚本写入），请升级脚本后再用", path)

    for p, v in state["files"].items():
        # v1 基线存的是裸 sha 字符串，v2 存 {mode, sha}；两者都由
        # migrate_state 收敛，这里只挡完全无法解释的类型。
        if not isinstance(v, (dict, str)):
            _corrupt_state(
                f"files[{p!r}] 应是对象或字符串，实际是 {type(v).__name__}", path)
        # v2 形态还要校验**字段类型**：只查 dict 的话，
        # {"mode": 100755, "sha": 123}（JSON 里写成数字）能过校验，
        # 然后在 `(lmode, lsha) == (rmode, rsha)` 比较时永远为假 →
        # 永久误报「远端被他人改动」，且没有任何提示指向真正的原因。
        # 与 version 字段用 exact=True 挡掉 bool 是同一个严格度要求。
        if isinstance(v, dict):
            for f in ("mode", "sha"):
                if f in v and not isinstance(v[f], str):
                    _corrupt_state(
                        f"files[{p!r}][{f!r}] 应是字符串，实际是 "
                        f"{type(v[f]).__name__}", path)

    for b, t in (state.get("tasks") or {}).items():
        if not isinstance(t, dict):
            _corrupt_state(
                f"tasks[{b!r}] 应是对象，实际是 {type(t).__name__}", path)

    for c in (state.get("conflicts") or []):
        if not isinstance(c, str):
            _corrupt_state(
                f"conflicts 的元素应是字符串，实际是 {type(c).__name__}", path)

    return state


def _ftype(mode):
    """文件类型的人类可读名字，用于报错。"""
    for fn, name in ((stat.S_ISDIR, "目录"), (stat.S_ISFIFO, "FIFO/管道"),
                     (stat.S_ISLNK, "符号链接"), (stat.S_ISSOCK, "socket"),
                     (stat.S_ISCHR, "字符设备"), (stat.S_ISBLK, "块设备")):
        if fn(mode):
            return name
    return "非普通文件"


def _check_state_path(path):
    """基线路径是否可读的普通文件。返回 (存在, 不可用的原因)。

    用 stat + S_ISREG 判断，不能用「能不能打开」来试：
      · 目录  → open 抛 IsADirectoryError
      · FIFO  → open **一直阻塞**，没有任何输出，看起来像卡死
      · /dev/zero 之类的字符设备 → 能打开，但读不到头，内存被吃光
    这几种都不是「内容损坏」，而是路径本身就不该指向这里，必须提前挡掉。
    """
    try:
        st = os.stat(path)              # 跟随软链
    except FileNotFoundError:
        return False, None
    except NotADirectoryError:
        return True, "路径中的某一级不是目录"
    except OSError as e:
        return True, f"无法访问（{e.strerror or e}）"

    if stat.S_ISDIR(st.st_mode):
        return True, "是一个目录（应是文件）"
    if stat.S_ISFIFO(st.st_mode):
        return True, "是一个 FIFO/管道（按文件读会一直阻塞）"
    if not stat.S_ISREG(st.st_mode):
        return True, f"不是普通文件，而是{_ftype(st.st_mode)}"
    return True, None


def _load_state_strict():
    """读基线并校验结构。内容非法一律中止（见 validate_state 的说明）。"""
    exists, bad = _check_state_path(STATE_PATH)
    if not exists:
        if os.path.islink(STATE_PATH):
            # 软链指向的目标没了。os.stat 跟随软链所以走到这里。
            # 不当成「没有基线」默默过去：基线凭空消失会让人以为是脚本出错。
            # 也不中止 —— save_state 用 os.replace，会直接替换掉这个软链，
            # 所以 --init-baseline 能自愈，没必要挡住用户。
            print(f"  ⚠️  基线路径是悬空软链，目标不存在：{STATE_PATH}")
            print("     将按「没有基线」处理；跑 --init-baseline 即可重建。")
        return None
    if bad:
        _corrupt_state(bad)

    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            state = json.load(f)
    except json.JSONDecodeError as e:
        _corrupt_state(f"不是合法 JSON（{e}）")
    except UnicodeDecodeError as e:
        # 二进制文件被误当成基线：json.load 在读的阶段就炸，不是 JSON 语法问题。
        _corrupt_state(f"不是 UTF-8 文本（{e}）")
    except OSError as e:
        # 权限不足、I/O 错误等。os.stat 已挡掉目录/FIFO，这里兜住其余。
        _corrupt_state(f"无法读取（{e.strerror or e}）")
    if state is None:
        # 文件内容是 JSON 的 null：json.load 成功但拿到 None。
        # 放过去就等于「没有基线」，会静默引导用户重建并丢掉旧基线。
        _corrupt_state("文件内容是 null（空基线应删掉文件，而不是写入 null）")
    return validate_state(state)


def load_state(strict=True):
    """读基线。返回 None 表示「没有可用基线」。

    strict=False 只给 --init-baseline / --reset-baseline 用：那两条命令本来
    就要丢弃旧基线，旧基线合不合法无关紧要。此时坏文件一律按「没有基线」
    处理，用户直接重跑一次就能修好，不必先手工删文件。
    """
    if not strict:
        try:
            return _load_state_strict()
        except SystemExit:
            return None
    return _load_state_strict()


def save_state(state):
    """原子写：写 tmp 再 os.replace，避免写一半崩溃留下坏 JSON。"""
    tmp = STATE_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
        # 收紧到 0600：状态文件不含 token、不含文件内容，只有「仓库文件清单」
        # 和 remote 字段。私有仓库场景下，文件名清单本身也算信息泄露面。
        # os.replace 会沿用 tmp 的权限，所以要在 replace **之前** chmod。
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass                      # 权限改不动不该阻断推送
        os.replace(tmp, STATE_PATH)
    except OSError as e:
        # 这一步通常在推送**之后**，所以必须说清三件事，否则用户会做错反应：
        #  · 失败的是基线文件，不是要推的内容（远端可能已经生效）
        #  · 推送其实成功了，不用重推
        #  · 千万不要 --reset-baseline —— 那会丢掉「远端文件是否被他人改过」
        #    的参照，而这正是防覆盖的唯一依据。
        # 裸的 [Errno 28] 只会让人往磁盘/权限上查，看不出推送已生效。
        raise SystemExit(
            f"基线写入失败：{STATE_PATH}\n"
            f"  {e.strerror or e}（errno {e.errno}）\n"
            f"  ⚠ 注意：这一步在推送**之后**，远端改动可能已经生效。\n"
            f"  清理磁盘或修正权限后重新运行即可（基线会自然追上），"
            f"不要 --reset-baseline ——\n"
            f"  那会丢掉「远端文件是否被他人改过」的参照。"
        )
    except (TypeError, ValueError, RecursionError) as e:
        # 只兜 OSError 是不够的：json.dump 遇到**无法序列化的值**会抛
        # TypeError，而带 surrogate 的路径（非 UTF-8 文件名）会抛
        # UnicodeEncodeError —— 后者是 **ValueError 的子类**，
        # 不是 OSError，于是直接穿透成裸 traceback。
        #
        # 这处崩溃点在推送**之后**（save_state 都在最后），用户刚看到
        # “推送成功” 就撞上 traceback，且完全不知道远端已经生效。
        # 必须给出和 OSError 同样清楚的上下文。
        raise SystemExit(
            f"基线序列化失败：{type(e).__name__}: {e}\n"
            f"  文件：{STATE_PATH}\n"
            f"  ⚠ 注意：这一步在推送**之后**，远端改动可能已经生效。\n"
            f"  常见原因：文件名含非 UTF-8 字节（surrogate），"
            f"或状态里混入了不可序列化的值。\n"
            f"  不要 --reset-baseline —— 那会丢掉「远端文件是否被他人改过」的参照。"
        )


def migrate_state(state, rstate):
    """v1（只记 sha）→ v2（记 mode+sha）。

    v1 基线里没有 mode，迁移时取**远端当前**的 mode 填上——
    v1 的 sha 本就是远端 sha，远端 mode 是当时最接近事实的值。
    """
    if state.get("version") == STATE_VERSION and all(
            isinstance(v, dict) for v in state.get("files", {}).values()):
        return state, False
    files = {}
    for p, v in state.get("files", {}).items():
        if isinstance(v, dict):
            files[p] = v
        else:
            files[p] = {"mode": rstate.get(p, ("100644", v))[0], "sha": v}
    state["files"] = files
    state["version"] = STATE_VERSION
    state.setdefault("synced_commit", state.get("base_commit"))
    state.setdefault("conflicts", [])
    return state, True


_CHANGES_CACHE = None


def gitignored_set(paths):
    """返回 paths 中被 .gitignore 屏蔽的子集（git 不跟踪的那些）。

    **一次** `git check-ignore` 查出全部，不要每文件跑一个子进程：
    批量推送上百个文件时那是上百次 git 调用，纯属浪费，
    而且会把测试里「rmtree 后残留 .git」的竞态放大成经常性失败。

    用 `--stdin -z`：输出是 NUL 分隔的命中路径，能区分「哪个被忽略」，
    而不是像 `-q` 那样只给一个「有没有」的退出码。
    退出码 0 = 有命中，1 = 一个都没有，128 = 出错（不是仓库等）。

    注意语义：只报告**未被跟踪**的路径。已跟踪文件即便匹配 ignore 规则
    也照样被 git 跟踪，这里不会报 —— 正是我们想要的（那个文件受自动检测）。
    """
    paths = [p for p in paths if p]
    if not paths:
        return set()
    # 这里的编解码要**双向**处理，不能只管输出：
    #   · 输出（stdout）：路径可能含非 UTF-8 字节 → errors="surrogateescape"
    #   · 输入（stdin） ：把 surrogate 写回子进程时同样要 surrogateescape，
    #     否则 text=True 下默认用严格 UTF-8 编码 stdin，直接抛
    #     UnicodeEncodeError。只修输出不修输入，崩溃只是换个地方（实测）。
    try:
        proc = subprocess.run(
            ["git", "-C", ROOT, "check-ignore", "-z", "--stdin"],
            input=("\0".join(paths) + "\0").encode("utf-8", "surrogateescape"),
            capture_output=True, timeout=30)
        out = proc.stdout.decode("utf-8", "surrogateescape")
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return set()
    if proc.returncode not in (0, 1):
        return set()                     # 出错就当没有，不因此打断推送
    return {p for p in out.split("\0") if p}


def detect_changes(refresh=False):
    """用 git 检测工作区相对本地基线的改动（含未跟踪文件）

    结果会缓存（一次运行内多处使用）。但**写入文件后再检测必须 refresh**：
    pull 合并过程中会改写文件，沿用旧快照会把刚落盘的改动误判成「本地无改动」，
    进而在下一轮合并里被远端版本直接覆盖掉。

    用 -z 避免 git 对含空格/中文/引号的路径做 quoting 转义（省掉反转义）。
    加 --no-renames：重命名会退化成 "D 旧路径" + "?? 新路径"，旧路径被跳过、
    新路径当新增推送，正好符合本脚本「不支持删除」的语义，也绕开了 -z 下
    重命名记录的字段顺序问题。
    """
    global _CHANGES_CACHE
    if _CHANGES_CACHE is not None and not refresh:
        return _CHANGES_CACHE

    # fatal=True：git 挂了就返回空 → 被下游误读成「没有改动」。
    # 那条伪装成成功的空结果，正是 P1-5 要根治的。
    out = git("status", "--porcelain", "-z", "--untracked-files=all",
              "--no-renames", fatal=True)
    fields = out.split("\0")
    paths, i = [], 0
    while i < len(fields):
        item = fields[i]
        i += 1
        if not item or len(item) < 3:
            continue
        xy, path = item[:2], item[3:]     # 标准格式 "XY<space>path"
        if not path:
            continue
        if "D" in xy:                     # 删除：本脚本不处理
            print(f"  ! 跳过已删除文件（脚本不支持删除）：{path}")
            continue
        if "R" in xy or "C" in xy:        # 防御：理论上 --no-renames 后不会走到
            if i < len(fields):
                path = fields[i]
                i += 1
        paths.append(path)

    _CHANGES_CACHE = paths
    return paths


# ---------------------------------------------------------------- 本地状态

_EXEC_RELIABLE = None


def _file_is_executable(full):
    """文件自身是否带执行位。

    用 st_mode & 0o111，**不用 os.access(X_OK)**：后者判断的是「当前进程能否
    执行它」，受挂载选项影响 —— noexec 挂载（本沙盒的 virtiofs 就是）下，
    即使权限位是 0755，os.access 也返回 False，于是所有文件都被判成 100644，
   chmod +x 永远推不上去。git 记录的是权限位本身，所以按位判断才对得上。
    """
    try:
        return bool(os.stat(full).st_mode & 0o111)
    except OSError:
        return False


def _exec_bit_reliable():
    """该环境能否靠文件权限位判断可执行（惰性探测，只探一次）。

    两个条件都要满足，缺一不可：
      1. git 跟踪执行位（core.fileMode != false）
      2. 文件系统真的区分权限（不是所有文件都带执行位）

    容器 / 挂载目录常两条都不满足：core.fileMode=false，或权限一律 0777，
    此时推断会把 .md / .json 全判成 100755。
    """
    global _EXEC_RELIABLE
    if _EXEC_RELIABLE is not None:
        return _EXEC_RELIABLE

    if git("config", "--bool", "core.fileMode").strip() == "false":
        _EXEC_RELIABLE = False
        print("  ! core.fileMode=false：git 不跟踪可执行位，新文件一律按 100644 处理")
        return _EXEC_RELIABLE

    # 挑明显不该可执行的已跟踪文件探一下文件系统。
    #
    # 取**多个样本**而不是第一个：单个样本可能是被合法 chmod +x 的
    # （少见但完全可能），那样整个环境会被误判成「文件系统不区分权限」，
    # 于是所有新文件按 100644 推送 —— 可执行位静默丢失，而提示只打印一行
    # 与具体文件无关的话，没人会联想到是探测踩错了样本。
    # 判定「所有样本都带执行位」才算环境不可靠，并打印文件名便于核对。
    samples = []
    for line in git("ls-files", "-z").split("\0"):
        if not line.endswith((".md", ".txt", ".json", ".py", ".yml", ".yaml")):
            continue
        probe = os.path.join(ROOT, line)
        if os.path.isfile(probe):
            samples.append(probe)
        if len(samples) >= 5:
            break

    if not samples:
        # 零样本 = 完全没探测过，却要返回 True（宣称可靠）—— 后果是
        # 整个仓库的权限位被静默翻转（实测：无 .md/.txt/.json/.py/.yml
        # 的仓库里所有文件 0777 → 新文件全被推成 100755）。
        # 宁可丢执行位，也不能在没探测的情况下给出「可靠」结论。
        return False
    if samples:
        flagged = [p for p in samples if _file_is_executable(p)]
        if len(flagged) == len(samples):
            _EXEC_RELIABLE = False
            names = ", ".join(os.path.basename(p) for p in flagged[:3])
            print(f"  ! 文件系统不区分权限（探测了 {len(samples)} 个文件，"
                  f"{names} 等全部带执行位）：新文件一律按 100644 处理")
            return _EXEC_RELIABLE

    _EXEC_RELIABLE = True
    return _EXEC_RELIABLE


def local_state_map():
    """本地 path → (mode, sha)：以 git 索引为唯一权威来源。

    新文件（索引里没有）不靠 os.access 推断——先过 _exec_bit_reliable()，
    环境不可靠时**回退 100644**：宁可丢执行位，也不要把文档推成可执行。

    必须 **refresh=True**：本函数的语义是「当前工作区的状态」，而
    detect_changes() 的结果带缓存。若缓存在文件被写入**之前**已填充，
    这里就会拿到一份过期的列表 —— 于是「刚改过、却不在列表里」的文件
    落到下方 `m[rel] = (mode, parts[1])` 分支，沿用 **git 索引里的旧 sha**。

    后果正是本脚本最想防的那类事故：本地改动被判成「已与远端一致」而跳过，
    **静默丢失，零报错**（实测复现）。宁可多跑一次 git status 也要拿新值。
    顺带把全局缓存刷新成最新，后续调用一并受益。
    """
    m = {}
    # fatal=True：与 detect_changes 同理。ls-files 失败返回空 → lmap={}
    # → 所有文件都「本地不存在」→ 后续判定全线失真。
    # 用 -z（NUL 分隔）：路径里可能出现 tab 或换行，按行分割会错位。
    # 与 detect_changes 的 `git status --porcelain -z` 保持同一解析口径 ——
    # 两处口径不一致时，含特殊字符的路径在一处正常、另一处错位，
    # 排查起来极难关联。
    for rec in git("ls-files", "-s", "-z", fatal=True).split("\0"):
        if not rec:
            continue
        if "\t" not in rec:
            continue
        meta, path = rec.split("\t", 1)
        parts = meta.split()
        mode = parts[0] if parts[0] in VALID_MODES else "100644"
        m[path] = (mode, parts[1] if len(parts) > 1 else "")

    changed = detect_changes(refresh=True)
    # symlink 走单独路径（要读链接目标而非目标文件内容），
    # 普通文件用批量 hash-object 一次算完。
    plain = []
    for rel in changed:
        full = os.path.join(ROOT, rel)
        if os.path.islink(full):
            m[rel] = ("120000", local_blob_sha(rel))
        elif os.path.isfile(full):
            plain.append(rel)
    shas = local_blob_shas(plain)
    for rel in plain:
        full = os.path.join(ROOT, rel)
        if True:
            if _exec_bit_reliable():
                # 执行位可靠时以**工作区**实际权限为准。
                # 只 chmod +x 的场景下 git status 会报 M，但索引里的 mode 还停在
                # 旧值；沿用索引的话「改成可执行」会被推成一个没变化的 100644。
                mode = "100755" if _file_is_executable(full) else "100644"
            else:
                # 环境不可靠（容器/挂载常 0777）：索引是唯一可信来源，
                # 宁可丢执行位，也不要把 .md / .json 全推成可执行。
                idx = m.get(rel)
                mode = idx[0] if idx and idx[0] in ("100644", "100755") else "100644"
            m[rel] = (mode, shas.get(rel) or local_blob_sha(rel))
    return m


def _local_matches_baseline(state, lmap, rel):
    """本地文件与基线记录完全一致 → 本地没改过。

    用于区分两种「本地 ≠ 分支」：
      · 本地改过（相对基线变了）   → 是要推的改动
      · 本地没改、只是落后于主干   → 推它只会把主干回退成本地旧版本

    基线里没记录的返回 False（保守）：那种情况归第一层的
    「基线未记录」分支处理，不算「已知未改动」。
    """
    base = (state.get("files") or {}).get(rel)
    if not isinstance(base, dict) or not base.get("sha"):
        return False
    return lmap.get(rel) == (base.get("mode"), base.get("sha"))


def baseline_changed_files(state, lmap):
    """本地与**基线**不同的文件 —— 补上 git status 看不见的「已 commit 未推送」。

    detect_changes() 的对比基准是本地 HEAD，用户一旦 `git commit`，
    工作区变干净，git status 就报不出任何东西，改动永远推不上去且**静默失败**。

    这里改用基线（上次推送/同步后记下的状态）做基准：本地 ≠ 基线 说明
    这个文件在你这儿变过（改过、或合并过远端改动），就该纳入推送候选。

    刻意**不**用远端做基准：远端被别人改了但你没动过时，本地 == 基线，
    这条不会把它算进来 —— 于是你不会拿旧版本去覆盖别人的新改动。
    「远端被改过」由第一层校验负责拦，两件事分开。

    基线里没记录的文件直接跳过：那种情况归第一层的「基线未记录」分支处理，
    在这里算进来只会制造噪音。
    """
    out = []
    for rel, lmode_lsha in lmap.items():
        base = state.get("files", {}).get(rel)
        if not isinstance(base, dict) or not base.get("sha"):
            continue
        if lmode_lsha != (base.get("mode"), base.get("sha")):
            out.append(rel)
    return out


def init_baseline(head_sha, rstate):
    """把远端当前状态记为基线。

    这一步本质是「无条件信任远端当前状态」，无法区分差异是别人改的还是你改的，
    所以「本地 ≠ 远端」的文件**不给它记基线**——留空后第一层校验会把它判为
    「基线未记录、远端却已存在」而拦住，强制先同步再推。

    （旧版做法：照样记基线、照样把 synced_commit 设成 head_sha，只打印一行警告。
     结果是本地旧副本的全文 + 你的改动会被整文件覆盖上去，把远端更新静默回退掉，
     全程零报错——正是本脚本最想防的场景，却被自己的初始化开了后门。）
    """
    lmap = local_state_map()
    # 只有**内容**不同才算风险：内容一致、仅 mode 不同（容器里文件常一律 0777，
    # 索引 mode 与远端不同但字节完全相同）推上去不会丢任何东西。
    # 若把 mode 差异也算进 diff，这类环境首次 init 会把整个仓库判成「不一致」，
    # 全部拒绝建基线，人看了只会困惑。
    diff = sorted(p for p in rstate if p in lmap and lmap[p][1] != rstate[p][1])
    mode_only = sorted(p for p in rstate if p in lmap
                       and lmap[p][1] == rstate[p][1] and lmap[p][0] != rstate[p][0])
    # 远端有、本地没有。不算 diff（否则全新目录首次 init 会被 P0-1 永久拦住，
    # 用户只想推自己的改动时不该被挡），但**必须明确提示**：
    # 这些文件此前会被一路静默忽略，表现为「本地缺一批文件且 --pull 拉不下来」。
    missing = sorted(p for p in rstate if p not in lmap)
    files = {p: {"mode": m, "sha": s} for p, (m, s) in rstate.items() if p not in set(diff)}

    # 保留既有 workflow：--direct 用户跑 --reset-baseline 不该被静默改回 PR。
    # 读当前基线（若存在）；不存在的（首次初始化）才用默认值。
    prev_workflow = None
    try:
        _prev = _load_state_strict()
        if isinstance(_prev, dict):
            prev_workflow = _prev.get("workflow")
    except BaseException:
        prev_workflow = None          # 旧基线读不了就走默认，不阻断重建

    state = {
        "version": STATE_VERSION,
        "remote": f"{OWNER}/{REPO}",
        "branch": BRANCH,
        "base_commit": head_sha,
        # 本地副本基于哪个远端 commit —— P0-1 的过期校验靠它。
        # 有 diff 时**必须留空**：本地明显不等于远端，声称「已同步到 head_sha」
        # 是假声明，会让过期防护整体失效。留空后 P0-1 一律拦（fail-closed）。
        "synced_commit": None if diff else head_sha,
        "conflicts": [],
        "tasks": {},
        "task_branch": None,
        # 不能写死默认值：--direct 用户跑 --reset-baseline 后会被静默
        # 改回 PR 工作流，下次推送走的是另一套逻辑且没有任何提示 ——
        # 静默改变行为，用户要等到出事才发现。
        "workflow": (prev_workflow if prev_workflow else DEFAULT_WORKFLOW),
        "files": files,
    }
    save_state(state)
    print(f"✅ 基线已写入 {STATE_PATH}（记录 {len(files)} 个文件，未做任何推送）")

    if missing:
        print(f"\n  · 本地缺少 {len(missing)} 个远端存在的文件"
              f"（基线已按远端记录，不影响你推送自己的改动）：")
        for p in missing[:10]:
            print(f"   - {p}")
        if len(missing) > 10:
            print(f"   … 其余 {len(missing) - 10} 个")
        print("    需要把这些文件拿到本地，跑：python3 push_api.py --pull")

    if mode_only:
        print(f"\n  · {len(mode_only)} 个文件内容一致但权限位与远端不同"
              f"（按远端 mode 记入基线；推送时会把本地权限带上去）：")
        for p in mode_only[:10]:
            print(f"   - {p} 本地 {lmap[p][0]} / 远端 {rstate[p][0]}")
        if len(mode_only) > 10:
            print(f"   … 其余 {len(mode_only) - 10} 个")

    if diff:
        print(f"\n❌ 本地与远端不一致的文件 {len(diff)} 个：已**拒绝**为它们建立基线。")
        for p in diff[:20]:
            print(f"   - {p}")
        if len(diff) > 20:
            print(f"   … 其余 {len(diff) - 20} 个")
        print("\n   这些文件本地与远端不同，无法判断差异属于谁。直接推送会把远端内容")
        print("   整文件覆盖掉且不报错。请先合并远端改动：\n")
        print("     python3 push_api.py --pull        # 三方合并远端改动到本地\n")
        print("   合并完成、本地与远端一致后，本脚本会自动补齐基线。")


def mark_synced(state, head_sha, rstate):
    """标记「本地副本已同步到远端 head_sha」，解除 P0-1 的过期拦截。

    顺带刷新「本地已与远端一致」的条目基线，避免同步后仍报旧的差异。

    有**未合并的远端改动**时拒绝标记：远端变过、本地又还没合上，此时声称
    「已同步到 head_sha」是假声明，P0-1 一旦放行，本地旧内容就会被整文件
    覆盖上去，把远端更新静默回退掉。先跑 `--pull` 再标记。
    """
    # 有未解决冲突时**不能**声明已同步。
    #
    # mark_synced 是把 P0-1（本地副本过期）这道闸门解除掉。而冲突文件的
    # 本地内容此刻是带冲突标记的半成品 —— 解除闸门后推送，等于允许把
    # 「本地旧版本 + 冲突标记」盖到远端上去。
    # 冲突拦截与 P0-1 是两道独立的闸门，这一处不能替另一处放行。
    # P0：--mark-synced 的守卫只认「远端变过 + 本地没合上」，不认「本地退了」。
    # 于是本地回退后它能照常解除 P0-1，v2 静默覆盖主干 v3（实测确认）。
    # 与 pull() 那两处是同一语义的三份实现，这里不能漏。
    if _refuse_if_rewound(state, "--mark-synced",
                          "   恢复后重跑 --mark-synced。"):
        raise SystemExit("已取消标记（本地副本状态存疑，未解除过期拦截）。")

    pending_conflicts = list(state.get("conflicts") or [])
    if pending_conflicts:
        raise SystemExit(
            f"还有 {len(pending_conflicts)} 个未解决的冲突，不能标记已同步："
            f"{pending_conflicts[:10]}\n"
            f"  冲突文件内容尚未定稿，此时解除过期拦截会让它被推上远端。\n"
            f"  手工改好后逐个运行：python3 push_api.py --resolve <文件>")

    lmap = local_state_map()
    refreshed = 0
    unmerged = []
    for p, (rmode, rsha) in rstate.items():
        lm = lmap.get(p)
        base = state["files"].get(p)
        base_sha = base.get("sha") if isinstance(base, dict) else base
        if lm != (rmode, rsha) and rsha != base_sha:
            unmerged.append(p)          # 远端变过 + 本地没合上
            continue
        if lm != (rmode, rsha):
            continue                    # 远端没变，差异纯粹是你自己的改动
        if not isinstance(base, dict) or base.get("sha") != rsha or base.get("mode") != rmode:
            state["files"][p] = {"mode": rmode, "sha": rsha}
            refreshed += 1

    if unmerged:
        print(f"\n❌ 还有 {len(unmerged)} 个文件的远端改动未合并进本地，不能标记已同步：")
        for p in unmerged[:20]:
            print(f"   - {p}")
        if len(unmerged) > 20:
            print(f"   … 其余 {len(unmerged) - 20} 个")
        print("\n     python3 push_api.py --pull      # 三方合并远端改动到本地")
        print("   合并后再跑 --mark-synced。")
        return

    state["synced_commit"] = head_sha
    state["local_head"] = _local_head()
    state["base_commit"] = head_sha
    save_state(state)
    print(f"✅ 已标记本地副本基于远端 {head_sha[:8]}（刷新 {refreshed} 条已一致的基线）")


# ---------------------------------------------------------------- 拉取与三方合并

def _remote_bytes(sha):
    """取远端 blob 原始字节。用 raw 而非 JSON：JSON 形式对 >1MB 不返回 content。"""
    try:
        return api("GET", f"/git/blobs/{sha}", raw=True,
                   timeout=_timeout_for(MAX_BLOB_BYTES) + 60)
    except SystemExit as e:
        print(f"  ! 取远端 blob {str(sha)[:8]} 失败：{e}")
        return None


def _local_bytes(rel):
    full = os.path.join(ROOT, rel)
    if os.path.islink(full):
        return os.readlink(full).encode()
    try:
        with open(full, "rb") as f:
            return f.read()
    except OSError:
        return None


def _binary(b):
    return b is not None and b"\0" in b[:64 * 1024]


def _merge3(local, base, remote):
    """三方合并，返回 (合并后字节, 是否冲突)。

    二进制不做合并——git merge-file 只按行处理，对二进制产出的结果是垃圾。
    直接判冲突，交给人工：本地/远端副本都会另存出来。
    """
    if _binary(local) or _binary(base) or _binary(remote):
        return None, True
    paths = []
    try:
        for data in (local, base, remote):
            fd = tempfile.NamedTemporaryFile(prefix="merge3-", delete=False)
            fd.write(data or b"")
            fd.close()
            paths.append(fd.name)
        out = subprocess.run(
            ["git", "merge-file", "-p",
             "-L", "本地", "-L", "基线", "-L", "远端", *paths],
            capture_output=True, timeout=DEFAULT_GIT_TIMEOUT)
        if out.returncode < 0 or (out.returncode > 0 and not out.stdout):
            return None, True
        return out.stdout, out.returncode != 0
    finally:
        for p in paths:
            # 必须吞掉：finally 里抛出的异常会**替换**掉 try 中正在传播的
            # 真实异常。届时用户看到「删除临时文件失败」，而真正的原因
            #（合并失败/冲突）被吞掉 —— 排查方向完全错。
            try:
                os.unlink(p)
            except OSError:
                pass


def _write_local(rel, data, mode):
    full = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(full) or ROOT, exist_ok=True)
    if os.path.islink(full):
        os.unlink(full)
    if mode == "120000":
        # lexists 而非 exists：exists 对**悬空软链**返回 False，
        # 于是 os.symlink 会因为目标已存在而抛 FileExistsError。
        # 上面 if islink 那行负责删软链，这里处理的是它之后的残留情况。
        if os.path.lexists(full):
            os.unlink(full)
        # **不能 strip**。
        #
        # symlink 的 blob 内容就是目标路径字符串本身，远端存什么就写什么。
        # strip 掉末尾换行后：远端 blob b'/opt/target\n' 的 sha 是
        # cfc33591，本地写入 '/opt/target' 再读回算出的 sha 是 05578718
        # —— 两者永久不等。
        #
        # 后果与已修的 autocrlf 分叉同症状：第一层校验永久报「可能被他人
        # 改动」，而根本没人改过，最终把用户推向 --force-overwrite 或
        # --reset-baseline。归一化要做在**比对侧**，不能做在写入侧。
        target = data.decode("utf-8", "replace")
        # 校验用 strip 后的值：路径语义上首尾空白无意义，
        # 但落盘必须保留原字节（否则 sha 对不上）。
        _check = target.strip()
        # 远端给的目标**必须校验**：safe_rel() 只防了**读取**侧，写侧没有。
        # 不校验的话，远端（或仓库被投毒时）给出 `../../etc/passwd`
        # 就会在落盘时被原样创建 —— 之后任何读它的操作都被带到仓库外。
        # 同一份代码里读侧防了、写侧没防，是最容易被忽略的不对称。
        #
        # 绝对路径一律拒绝：symlink 到仓库外的固定路径（/etc、/home）
        # 在推送/读取时都会造成越界，没有合法用途。
        if os.path.isabs(_check):
            raise SystemExit(
                f"{rel} 是符号链接，目标 {_check!r} 是绝对路径，拒绝创建。\n"
                f"  仓库内不应出现指向绝对位置的软链；请确认远端内容是否可信。")
        # 相对目标：解析后必须仍在仓库内。
        # 判据走 _inside_root()（基准 = realpath(ROOT)），与 safe_rel 同源：
        # 早先这里直接拿裸 ROOT 比，仓库根是软链时会被判成越界而 SystemExit，
        # 中断整个 --pull（实测复现）。
        resolved = os.path.realpath(os.path.join(os.path.dirname(full), _check))
        if not _inside_root(resolved):
            raise SystemExit(
                f"{rel} 是符号链接，目标 {_check!r} 解析后指向仓库外：{resolved}\n"
                f"  拒绝创建（防止路径穿越）。")
        os.symlink(target, full)
        return
    # 同样用 lexists：exists 对悬空软链返回 False，会让「软链被普通文件
    # 覆盖」这种情况绕过这里的类型检查。
    if os.path.lexists(full) and not os.path.isfile(full):
        raise SystemExit(f"{rel} 不是普通文件，拒绝覆盖（请手工处理）")
    with open(full, "wb") as f:
        f.write(data)
    if mode == "100755":
        os.chmod(full, 0o755)
    else:
        # 非执行文件必须显式回退权限位。
        #
        # 不然会与 pull 永久打架：远端文件从可执行改成不可执行时，
        # 本地文件若是 0755（之前 chmod 过），写入内容后权限位仍是 0755，
        # local_state_map 算出的 mode 就是 100755 ≠ 远端 100644
        # → 每次都判定「本地与远端不同」→ 每次 pull 都重写 → 永远合不完。
        # 只写内容不写权限位，等于只同步了一半状态。
        try:
            os.chmod(full, 0o644)
        except OSError:
            pass                      # 权限改不动不该阻断写入
    # 工作区刚被改写，detect_changes() 的缓存立即失效。
    # 不清的话，后续任何 detect_changes()（无 refresh）都会返回**写入前**
    # 的旧快照，把刚落盘的改动当成「本地无改动」—— 这正是 pull 里那句
    # 「写入文件后再检测必须 refresh」注释所指，但要靠每个调用点自觉传参
    # 太脆弱，这里从源头失效掉。
    global _CHANGES_CACHE
    _CHANGES_CACHE = None


def _git_blob_bytes(rev):
    """从本地 git 里取某个对象的原始字节（本地 HEAD 版本的 base 用得上）。"""
    # 大 blob 耗时长：按体积给一个宽松的动态超时，不能一律 120s。
    proc = subprocess.run(["git", "-C", ROOT, "cat-file", "blob", rev],
                          capture_output=True, timeout=DEFAULT_GIT_TIMEOUT)
    return proc.stdout if proc.returncode == 0 else None


def _base_bytes(state, rel):
    """三方合并的 base = 「本地副本所基于的那个远端版本」。

    返回 **(data, source)**，source 说明这份 base 从哪来、有多可信：
      · "baseline" —— 基线记录的远端版本。**唯一可信**的合并基点。
      · "git"      —— 基线没记，回退到本地 git HEAD 里的版本。
      · None       —— 都没有（文件连 git 都没跟踪）。

    为什么必须区分来源：git HEAD 里的版本**可能已经含用户自己的改动**。
    用户 `git commit` 之后，HEAD 就随之前进了；此时拿 HEAD 当 base，
    等于宣称「用户改动是共同祖先的一部分」，于是
    「远端没有你这行改动」会被误判成「远端故意删掉了你这行」——
    三方合并干净通过，用户的改动静默消失。实测踩到过。

    所以 "git" 这一档只能用来判断「远端有没有变过」，
    **不能**用作合并基点，也不能用来断言「本地没改动」。
    """
    entry = state["files"].get(rel)
    if isinstance(entry, dict) and entry.get("sha"):
        data = _remote_bytes(entry["sha"])
        if data is not None:
            return data, "baseline"
    sha = git("rev-parse", f"HEAD:{rel}")
    if sha and len(sha) == 40:
        data = _git_blob_bytes(sha)
        if data is not None:
            return data, "git"
    return None, None                   # 无法确定 —— 调用方要有降级方案


def _report_remote_deletions(deleted_remote):
    """打印「远端已删除、本地仍保留」的清单。

    抽成函数是因为它要在 pull() 的**两条**返回路径上打印：
      · 有文件需要合并时（循环之后）
      · 没有文件需要合并时（提前 return 之前）
    第二条恰恰是**最常见**的场景：远端只删了文件、别的都没动 →
    paths 为空 → 走到「没有需要合并的远端改动」直接 return。
    原先提示只写在循环之后，于是这个场景下完全静默 ——
    脚本不但不删，还连说都不说一声（实测：输出只有「没有需要合并的
    远端改动」）。
    """
    if not deleted_remote:
        return
    print(f"\n  ! 以下 {len(deleted_remote)} 个文件**远端已删除**，"
          f"本地仍保留（本脚本不会替你删本地文件）："
          f"{deleted_remote[:10]}")
    print("    它们仍在基线里：日后你一改，它们会作为「新增」被推回远端，"
          "相当于把别人删掉的文件复活。")
    print("    确认要删的话请手动删除本地文件，再跑 --pull。")


def pull(state, head_sha, rstate, only=None, force=False, ignore_pending=False):
    """把远端改动三方合并进本地，解决「检测到冲突却无法解决」的问题。

    没有这一步，第一层校验报「可能覆盖他人改动」后，本脚本给的出路只有
    --force-overwrite（因为 git 协议被网关拦死，用户没有 git pull 可用），
    于是唯一便捷出路就是摧毁防护本身。

    合并基（base）取**基线里记的远端 sha**——那正是本地副本所基于的版本，
    三方合并因此能分清「你改的」和「远端改的」。
    合并成功后基线更新为远端当前 sha：本地已包含远端全部内容，
    再推送时第一层校验 (远端 == 基线) 自然通过。
    """
    lmap = local_state_map()
    # 开始合并前的快照：之后每写一个文件，工作区状态就变了，
    # dirty 判断必须基于「合并开始前本地有没有自己的改动」。
    dirty0 = set(detect_changes(refresh=True))
    if only:
        paths = []
        for f in only:
            rel = safe_rel(f)
            if rel is None:
                print(f"  ! 忽略越界路径：{f}")
            else:
                paths.append(rel)
    else:
        # 默认：远端变过 且 本地还没合上的
        #
        # 额外并入**本地根本没有**的文件。原判据要求「远端相对基线变过」，
        # 于是「远端新增 → init 把它的 sha 记进基线 → 之后远端没再变过」
        # 会被判成无需拉取，本地永远缺这些文件，--pull 还报告
        # 「没有需要合并的远端改动」并谎称已同步。实测 150 个新增文件
        # 一个都没拉下来（用户侧表现为「148 个文件缺失」）。
        # 本地没有内容可丢，补齐不存在覆盖风险，故无条件纳入。
        # 自动拉取的路径同样要过 safe_rel。
        #
        # 显式点名（--pull foo.txt）早就校验了，而这条**自动**路径没有：
        # 路径直接来自远端树，_write_local 会 makedirs + open 落盘。
        # 正常 GitHub 不会返回异常路径，但这与「远端内容不可全信」是同一个
        # 原则 —— 修 symlink 目标越界（P1-21）时已经认可了这一点，
        # 这里没理由留一个口子。纵深防御不该只在用户输入的那一侧做。
        # 判据必须比 (mode, sha) 元组，不能只比 sha。
        #
        # 只比 sha 时，「远端把文件从可执行改成不可执行（100755→100644）
        # 而内容不变」会被判成「远端没变过」→ 本地权限位永远拉不下来
        # → 每次推送又把它推回 755 → 该文件永久卡在待推列表里。
        # 与 T-11（只改可执行位推不上去）是同源的对称问题：
        # 那次修的是推送侧，这次是拉取侧。
        cand = sorted(p for p in rstate
                      if lmap.get(p) != rstate[p]
                      and (p not in lmap
                           or ((state["files"].get(p) or {}).get("mode"),
                               (state["files"].get(p) or {}).get("sha"))
                           != rstate[p]))
        paths = []
        for p in cand:
            rel = safe_rel(p)
            if rel is None:
                print(f"  ! 忽略越界路径（来自远端，已拒绝落盘）：{p}")
            else:
                paths.append(rel)

    # -------- 远端删除检测（C2）--------
    # 必须**比对基线**，不能只在遍历 rstate 时判断。
    #
    # rstate 是「远端现在有什么」。被删掉的文件根本不在里面，
    # 于是「远端已删除」这件事在循环里永远遇不到 —— 只在循环内加提示
    # 等于写了个永远不会执行的分支（实测：删掉的文件连一行输出都没有）。
    # 正确做法是拿基线（上次同步时远端有什么）与现在对比，差集即删除。
    deleted_remote = [p for p in sorted(state.get("files") or {})
                      if p not in rstate]

    if not paths:
        # 也必须刷新 synced_commit，否则用户会被 P0-1 **永久挡住**：
        #
        # 「待合并集合」是「远端相对基线变了 且 本地还没合上」。下列情况它为空，
        # 但主干确实前进过，P0-1 因此一直拦 —— 而提示给的出路只有 --pull
        # （正是这条空转的路径）和 --force-overwrite（摧毁防护）：死锁。
        #   ① 远端删了某个文件（脚本不支持删除，该文件不在 rstate 里）
        #   ② 远端改动后内容又等价（改回原样 / 只动了别处）
        #   ③ 用户已用别的途径把内容同步好了
        # 这些情况下「本地与远端内容一致」为真，声明已同步是真实的。
        print("\n没有需要合并的远端改动。")
        # 必须在这里也打印：paths 为空正是「远端只删了文件」的典型表现，
        # 若只在循环之后的正常路径打印，这个场景会完全静默。
        _report_remote_deletions(deleted_remote)
        # P0：必须在写 synced_commit / local_head 之前拦。
        # 这一支从头到尾只比了「远端 vs 基线」，**一次都没比过本地内容**；
        # 它打印的「已一致」是「远端与基线一致」，不是「你的文件与远端一致」。
        if _refuse_if_rewound(state, "--pull",
                              "   恢复后重跑 --pull，届时它会真正合并远端改动。"):
            return False
        if state.get("conflicts"):
            print("  ! 但有未解决的冲突，暂不标记为已同步。")
        else:
            state["base_commit"] = head_sha
            state["synced_commit"] = head_sha
            state["local_head"] = _local_head()
            save_state(state)
            # P2-1：旧文案「本地内容已与远端一致」**是假的** ——
            # 这一支只比了「远端 vs 基线」，从未比过本地内容。
            # 措辞越肯定，出错时越误导：用户据此相信本地已经和远端一样了，
            # 于是放心推送，本地旧版本静默覆盖远端（P0 链路第 4 步）。
            print(f"  · 远端相对基线无变化，标记为已同步（{str(head_sha)[:8]}），"
                  f"可正常推送。")
        return True

    print(f"\n合并 {len(paths)} 个文件的远端改动（base = 基线记录的远端版本）：")
    clean, conflicted, failed = [], [], []
    for rel in paths:
        rmode, rsha = rstate.get(rel, (None, None))
        if rsha is None:
            # 不落地删除，但必须**登记并集中提示**。
            #
            # 远端删掉的文件会一直留在 state["files"] 基线里，本地文件也
            # 一直保留。日后本地一改这个文件，它就会被当作「普通改动」
            # 重新推上去 —— 把别人删掉的东西复活了，且无人知晓。
            # 脚本不支持删除（删除是不可逆的远端操作，不该由同步工具代劳），
            # 但至少要让用户知道「这些文件远端已经没有了」。
            deleted_remote.append(rel)
            continue
        remote = _remote_bytes(rsha)
        if remote is None:
            # 拉取失败**不是冲突**。
            #
            # 冲突 = 「拿到了远端内容，但合不上」，是**做过了**；
            # 拉取失败 = 「没拿到」，是**没做成**。混进 conflicts 有三个后果：
            #   · state["conflicts"] 被持久化 → 后续所有推送被全局拦截
            #   · 它没有 .remote / .base 副本，用户无从下手
            #   · 解除方式只有 --resolve，而 resolve 只是清标记 —— 等于逼用户
            #     对一次网络抖动做一次毫无意义的「冲突解决」
            # 一旦 conflicts 里混进非冲突项，这个列表就失去了语义。
            failed.append(rel)
            continue
        local = _local_bytes(rel)
        base, base_src = _base_bytes(state, rel)

        if local is None:
            # 本地根本没有这个文件：远端新增，或本地副本不完整。
            # 必须**先于**下面的「远端相对基线没变」判断处理 ——
            # 否则 base == remote（基线记的就是远端当前 sha）会让它
            # 走进「远端无变化，本地改动原样保留」而跳过，永远补不上。
            # 本地没有内容可丢，直接落盘不存在覆盖风险。
            _write_local(rel, remote, rmode)
            state["files"][rel] = {"mode": rmode, "sha": rsha}
            clean.append(rel)
            print(f"  ↓ {rel} 本地缺失，已从远端补齐")
            continue

        if local == remote:
            # 内容相同 ≠ 状态一致：还要同步 mode。
            #
            # 这里只比较了内容字节（_local_bytes），不比较权限位。
            # 远端 100755→100644 而内容不变时会走进这一支，旧版只把基线
            # 记成 100644 却**没有 chmod 本地文件**：
            #   · 基线说 100644，本地实际 0755
            #   · local_state_map() 算出 100755 ≠ 基线
            #   · 下次再判定有差异 → 又走进这里 → 又只改基线不 chmod
            # 于是本地权限位与基线永久打架，该文件每次都被报成待推。
            # 与 _write_local 里「非执行文件显式回退权限位」是同一个道理，
            # 只是那处在写文件时顺手做了，这一处漏了。
            cur_mode = (lmap.get(rel) or ("100644", ""))[0]
            if cur_mode != rmode:
                _write_local(rel, remote, rmode)
                print(f"  = {rel} 内容一致，仅权限位 {cur_mode} → {rmode}")
            state["files"][rel] = {"mode": rmode, "sha": rsha}
            if cur_mode == rmode:
                print(f"  = {rel} 已一致")
            clean.append(rel)
            continue
        if base is not None and base == remote:
            # 远端相对基线没变 → 这个文件远端根本没动，本地保留自己的改动即可。
            # 必须计入 clean：若所有文件都走这条分支，clean 会为空，
            # synced_commit 就不刷新，用户随即被 P0-1 永久挡住（同 P1-2）。
            #
            # 【必须同时刷新基线】base == remote 已证明「本地副本所基于的版本
            # 与远端当前内容逐字节相同」，此刻记下 rsha 是准确的。
            # 不记的话基线缺口永远补不上，两个后果同时发生：
            #   · direct 模式：推送时 base 仍缺失 → 被第一层判 blocked
            #     → 建议 --pull → --pull 又走回这一支 → 再推再拦，无限循环。
            #     用户严格按提示操作也走不通（实测死锁）。
            #   · PR 模式：_local_matches_baseline() 基线缺失时保守返回 False，
            #     调用方一律读成「本地确实改过」→ 归入 overlap 无条件放行
            #     → 本地旧内容整文件覆盖主干，静默回退（比死锁更糟：没人知道）。
            # 两个 P0 同一个根因，补这一处即同时消失。
            #
            # 此处 base 必可信：走到这一支说明 local != remote（相等的话
            # 上面的 `local == remote` 分支已拦截），而 base == remote，
            # 故 local != base —— 正是不再信任 git HEAD 那份 base 的条件。
            if (state["files"].get(rel) or {}).get("sha") != rsha:
                state["files"][rel] = {"mode": rmode, "sha": rsha}
            print(f"  · {rel} 远端无变化，本地改动原样保留")
            clean.append(rel)
            continue

        # git HEAD 那份 base 可信吗？取决于用户有没有把改动 commit 进去：
        #   · 工作区已比 HEAD 新（local != base）→ 改动还没进 HEAD，
        #     HEAD 仍是纯净的远端版本，可作共同祖先 —— **可信**
        #   · 工作区与 HEAD 一致（local == base）→ 无法排除「用户已 commit」，
        #     而 commit 后 HEAD 就含其改动了 —— **不可信**
        if base_src == "baseline":
            base_ok = True
        elif base_src == "git":
            base_ok = (local != base)
        else:
            base_ok = False

        # 「本地有没有自己的改动」必须用 local == base 判定，不能用
        # 「工作区是否有未提交改动」：推送成功后脚本会在本地补一个 commit，
        # 工作区随之变干净，按后者判断就成了「本地无改动」→ 直接用远端覆盖，
        # 把你刚推上去的改动从工作区抹掉（还在本地 git 历史里，但文件没了）。
        #
        # 但 `local == base` 只在 base **可信**时成立。若 base 是不可信的
        # git HEAD（用户已 commit），则 local == HEAD 恒成立 ——
        # 判成「本地无改动」→ 用远端覆盖，用户已 commit 的改动被静默抹掉
        # （实测：改动消失且零冲突提示）。这种情况按**有改动**处理。
        if base is not None and base_ok:
            no_local_change = (local == base)
        elif base is not None:
            no_local_change = False         # base 不可信，不敢断言
        else:
            no_local_change = rel not in dirty0     # 没 base，退回工作区脏检查

        if no_local_change:
            # 本地没有自己的改动，只是版本旧：直接更新到远端版本即可，
            # 不存在要保留的内容，硬走三方合并只会制造假冲突。
            _write_local(rel, remote, rmode)
            state["files"][rel] = {"mode": rmode, "sha": rsha}
            clean.append(rel)
            print(f"  ↓ {rel} 本地无改动，已更新到远端版本")
            continue

        # 用独立的 ignore_pending，不再复用 force。
        #
        # force 在推送路径上的语义是「覆盖远端」（放行文件级校验）；
        # 而这里的语义是「跳过自己上次未解决的冲突」。两者毫无关系，
        # 复用会让用户以为自己在「覆盖远端」，实际是「关掉冲突保护」。
        # 与 A-15「放行粒度与承诺不一致」是同一族问题。
        if not ignore_pending and rel in (state.get("conflicts") or []):
            print(f"  ! {rel} 上次冲突尚未解决（先手工改好再 --resolve {rel}），跳过")
            conflicted.append(rel)
            continue

        # 注意：此处 reachable 的前提是上面「本地缺失」那处没有 continue。
        # 这段曾被两份审查报告判为死代码（旧版确有前置 continue 提前跳出），
        # 修「远端新增文件拉不下来」时调整了控制流，它才重新可达。
        # 不加这行注释，下一个人还会再判它一次死代码并删掉。
        if local is None:                   # 本地没有：远端新增，直接落盘
            _write_local(rel, remote, rmode)
            state["files"][rel] = {"mode": rmode, "sha": rsha}
            clean.append(rel)
            print(f"  ↓ {rel} 远端新增，已写入本地")
            continue

        if rmode == "120000" or lmap.get(rel, (None,))[0] == "120000":
            # symlink 内容是路径字符串，行合并没有意义 —— 但**不能直接采用
            # 远端**。
            #
            # 走到这里意味着 no_local_change 判定已经通过（见上方），
            # 即本地确实有改动。旧版却直接 _write_local 覆盖并计入 clean：
            #   · 本地改的指向被静默丢弃，无备份
            #   · 报「干净 N 个，冲突 0 个」—— 把丢弃说成顺利
            # 同函数内普通文件冲突是写 .remote 副本 + 计 conflicted，
            # symlink 这里也必须一样，否则同一类改动两种处置。
            if local != remote:
                lp = _conflict_path(rel, "remote")
                try:
                    _write_conflict_artifact(rel, "remote", remote)
                except OSError as e:
                    print(f"  ! 写 {lp} 失败：{e}")
                conflicted.append(rel)
                print(f"  ✗ {rel} 是符号链接且本地改过指向，无法自动合并")
                print(f"     远端目标已存到 {lp}，手工选一个后 --resolve {rel}")
                continue
            _write_local(rel, remote, rmode)
            state["files"][rel] = {"mode": rmode, "sha": rsha}
            clean.append(rel)
            print(f"  ! {rel} 是符号链接，不合并，已直接采用远端目标")
            continue

        # 合并基点**只认来自基线记录的那一份**。
        #
        # base 为 None（基线没记 + git HEAD 里也没有，例如 untracked 新文件）
        # 或 base 来自 git HEAD 时，都退化成「空 base」跑三方合并 ——
        # 两侧都被视为新增，容易判成冲突，但宁可假冲突也不能静默丢改动：
        # git HEAD 那份在用户 commit 之后已含其改动，拿它当基点会让
        # 「远端没有你这行」被误读成「远端故意删了你这行」，合并干净通过
        # 而改动消失。后续有 --resolve 兜底。
        merge_base = base if base_ok else b""
        merged, bad = _merge3(local, merge_base, remote)
        if bad or merged is None:
            conflicted.append(rel)
            # .base 只在**确实知道** base 时才写。base 是 None 时
            # `f.write(base)` 会抛 TypeError（实测），整个 pull 崩在半路；
            # 也不能写成空文件 —— 那等于宣称「合并基点是空文件」，
            # 与「不知道基点」是两回事，会误导人工比对。
            # 先清掉上一轮冲突的残留。副产物目录在仓库外、跨运行保留，
            # 若这轮基点未知而上轮写过 .base，陈旧文件会让人以为
            # "有共同祖先可比对" —— 比没有更误导。
            for stale in ("remote", "base"):
                p = _conflict_path(rel, stale)
                if os.path.exists(p):
                    try:
                        os.unlink(p)
                    except OSError:
                        pass
            _write_conflict_artifact(rel, "remote", remote)
            # 只有**可信**的 base 才落盘成 .base。git HEAD 那份在用户 commit
            # 之后已含其改动，写出去会让人误以为那是共同祖先。
            if base_ok:
                _write_conflict_artifact(rel, "base", base)
            if merged is not None:
                _write_local(rel, merged, rmode)
            hint = (f"{rel}.remote / {rel}.base 供比对" if base_ok
                    else f"{rel}.remote 供比对（合并基点不可信，未生成 {rel}.base）")
            print(f"  ✗ {rel} 冲突：已生成 {hint}")
            if base_src is None:
                print("     合并基点未知：基线没记这个文件，本地 git HEAD 里也没有。"
                      "两侧都被当作新增，冲突未必是真冲突。")
            elif base_src == "git" and not base_ok:
                print("     基线没记这个文件，只有本地 git HEAD 里的版本；"
                      "而 HEAD 与你工作区一致，无法排除「你已 commit 了自己的改动」，"
                      "不能当共同祖先。")
                print(f"     故按「基点未知」处理：冲突未必是真冲突，请对照 "
                      f"{rel}.remote 人工判断。")
                print("     （补上基线可避免此类误判："
                      "python3 push_api.py --init-baseline）")
            print(f"     手工改好后运行：python3 push_api.py --resolve {rel}")
            continue

        _write_local(rel, merged, rmode)
        state["files"][rel] = {"mode": rmode, "sha": rsha}
        clean.append(rel)
        print(f"  ✓ {rel} 已合并（{len(merged)} B）")

    # failed **不进** conflicts（见上面的说明）。
    state["conflicts"] = sorted(set(state.get("conflicts") or []) | set(conflicted))
    # 判据是「没有冲突」，不是「有 clean」：clean 为空不代表没跟上 ——
    # 所有文件都走「远端无变化」分支时 clean 也为空，但本地确实已是最新。
    # 用 clean 做条件会让 synced 不刷新，用户被 P0-1 永久挡住（P1-2）。
    if _refuse_if_rewound(state, "--pull",
                          "   恢复后重跑 --pull。"):
        # 文件其实已经合并到本地了，所以 base_commit 照常推进（避免下次
        # 重复合并同一批），但**不写** synced_commit / local_head：
        # 那两行会抹掉回退证据，让后续推送绕过第零层。
        state["base_commit"] = head_sha
        save_state(state)
        return False
    if not conflicted:
        state["synced_commit"] = head_sha      # 本地确实包含远端最新
        state["local_head"] = _local_head()
    state["base_commit"] = head_sha
    save_state(state)

    print(f"\n合并完成：干净 {len(clean)} 个，冲突 {len(conflicted)} 个"
          + (f"，拉取失败 {len(failed)} 个" if failed else ""))
    _report_remote_deletions(deleted_remote)

    if failed:
        # 必须给出**区别于冲突**的指引：重跑即可，不用 --resolve。
        print(f"  ! 以下 {len(failed)} 个文件因拉取远端内容失败未处理："
              f"{failed[:10]}")
        print("    多为网络抖动或限流，重跑 --pull 即可；"
              "它们**没有**被记为冲突，不需要 --resolve。")
    if conflicted or failed:
        if conflicted:
            print("冲突文件已记录，解决前不会被推送（避免把冲突标记推上去）。")
            print("逐个解决：python3 push_api.py --resolve <文件>")
        return False

    # 这里**故意不自动 git commit**：一旦提交，工作区就"干净"了，
    # detect_changes() 再也看不到这些合并结果 —— 用户想把自己的改动
    # （连同刚合进来的远端改动）推上去时，脚本只会说「本地没有待推送的改动」。
    # 保持工作区脏，合并结果才推得出去；是否落本地提交交给推送流程统一处理。
    print(f"✅ 本地已包含远端 {head_sha[:8]} 的全部改动，可直接推送。")
    return True


def resolve(state, rel, head_sha=None, rstate=None):
    """确认某个冲突文件已手工解决：清冲突标记 + 补基线。

    调用前会检查文件里是否还留着 `<<<<<<<` 标记——带着冲突标记推送等于
    把一份损坏的文件推上去，这是最该拦的一道。

    手工解决意味着人已经看过远端版本并做了决定，所以这里把基线补成远端当前值：
    下一轮第一层校验看到「远端 == 基线」即放行，本地（人工裁定的）内容可以推上去。
    全部冲突解决完则声明「本地已包含远端最新」，解除 P0-1 过期拦截——
    否则用户解决完所有冲突仍被拦在门外，只能去加 --force-overwrite。
    """
    # 成员资格校验：不在冲突列表里的文件不该走到这里。
    # 副作用是**刷 synced_commit**（等价于声明「本地已含远端最新」），
    # 对一个从没冲突过的文件做这个声明，等于无凭无据地解除 P0-1 闸门 ——
    # 那正是防静默回退的最后一道。打错文件名时尤其危险。
    if rel not in (state.get("conflicts") or []):
        pending = state.get("conflicts") or []
        raise SystemExit(
            f"{rel} 不在未解决冲突列表里。\n"
            + (f"  当前待解决的是：{pending}\n" if pending
               else "  当前没有任何未解决冲突。\n")
            + "  --resolve 会声明「本地已含远端最新」，"
              "只能用于真实冲突过的文件。")
    data = _local_bytes(rel)
    if data is None:
        raise SystemExit(f"{rel} 本地不存在")
    if b"<<<<<<<" in data or b">>>>>>>" in data:
        raise SystemExit(
            f"{rel} 里仍有冲突标记（<<<<<<< / >>>>>>>）。\n"
            f"  请先编辑解决冲突，再运行 --resolve {rel}。"
        )
    for kind in ("remote", "base"):
        extra = _conflict_path(rel, kind)
        if os.path.exists(extra):
            os.unlink(extra)
    state["conflicts"] = [p for p in (state.get("conflicts") or []) if p != rel]
    if rstate and rel in rstate:
        state["files"][rel] = {"mode": rstate[rel][0], "sha": rstate[rel][1]}
        print(f"  · {rel} 基线已补记为远端当前版本（你的裁定内容会在推送时覆盖远端）")
    if head_sha and not state["conflicts"]:
        state["synced_commit"] = head_sha
        state["local_head"] = _local_head()
        state["base_commit"] = head_sha
        print("  · 冲突已全部解决，本地视为已包含远端最新")
    save_state(state)
    print(f"✅ {rel} 冲突已标记为解决")


# ---------------------------------------------------------------- PR 工作流

def _now():
    """当前 UTC 时间，格式与 GitHub 返回的时间戳一致。

    必须 UTC：_days_since() 按 UTC 解析 GitHub 的 `merged_at` 等字段，
    而旧版这里用 time.strftime 写的是**本地时间**。同一份 state 里两种
    口径混用，非 UTC 环境下天数会偏若干小时，直接影响 --prune 的
    3 天宽限判定（该报的不报，不该报的报了）。
    """
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _days_since(ts):
    """时间戳 → 距今天数。解析不了返回 None（只影响提示，不阻断）。"""
    if not ts:
        return None
    # 偏移里的 "+" 和 "-" 都要剥。原来只 split("+")，遇到负偏移
    # （2026-09-01T12:00:00-05:00）会把 "-05:00" 留在字符串里，
    # strptime 全部失败 → 返回 None → 该分支静默归入「无需处理」，
    # --prune 就不报它了（本该报告的陈旧分支消失）。
    #
    # 用正则先切掉尾部偏移再剥小数秒，避免 "2026-09-01" 里的日期连字符
    # 被误当成时区符号（split("-") 会把年月日也拆掉）。
    s = str(ts).replace("T", " ").replace("Z", "").strip()
    s = re.sub(r"[+-]\d{2}:?\d{2}$", "", s).split(".")[0].strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            # GitHub 的时间戳是 **UTC**（形如 2026-09-01T12:00:00Z）。
            # time.mktime 按**本地时区**解析，UTC+8 下会偏大约 8 小时，
            # 让 --prune 的 3 天宽限期提前约 1/3 天触发；东八区之外同样有偏。
            # calendar.timegm 才是按 UTC 解析，与时间戳语义一致。
            return (time.time() - calendar.timegm(time.strptime(s, fmt))) / 86400.0
        except (ValueError, OverflowError):
            continue
    return None


def _branch_date(binfo):
    """分支最后一次提交时间（孤儿分支没有 PR，只能靠它判断活动）。"""
    c = (binfo or {}).get("commit") or {}
    inner = c.get("commit") or {}
    return ((inner.get("committer") or {}).get("date")
            or (inner.get("author") or {}).get("date"))


def ref_sha(branch):
    """取分支 head；分支不存在返回 None —— 404 在这里是正常查询结果。

    必须走 _ref_path() 编码，不能裸拼 f"/git/refs/heads/{branch}"：
    分支名含 `?` 时其后的部分会被当成 query string 丢掉，请求打到**另一个
    分支**上（实测：refs 里有 task/a 与 task/a?b 时，查后者返回前者的 sha）。

    这个错误比 404 危险得多 —— 它不报错，只是静默返回一个看似合理的值，
    而下游四处都拿它当事实：
      · 撞名检测（新分支命名循环）→ 误判「已存在」，连试 5 次后中止推送
      · --hold 复用分支             → bhead 取到别的分支的 sha
      · abandon_task 内容校验       → 该拦的「分支上有他人改动」拦不住
      · _cleanup_failed_branch      → 判成「已被他人改动」而跳过清理，孤儿分支复发
    """
    r = api("GET", _ref_path(branch), allow_404=True)
    return (r or {}).get("object", {}).get("sha")


def _pr_index(state="all"):
    """一次拉全量 PR，返回 {head_ref: PR} 索引。

    --prune 原来对每个分支调一次 find_pr()：150 个分支 = 150 次请求。
    而 find_pr 内部是一次 /pulls?...&head=owner:branch 查询，
    完全可以用**一次全量拉取 + 内存索引**替代。

    同一 head 分支可能对应多个 PR（关闭后重开），保留**最新**的那个，
    与 find_pr 的语义一致。
    """
    idx = {}
    for pr in _paginate(f"/pulls?state={state}") or []:
        ref = (pr.get("head") or {}).get("ref")
        if not ref:
            continue
        cur = idx.get(ref)
        # 取 number 最大的（= 最新的），与 find_pr「取最新」对齐
        if cur is None or (pr.get("number") or 0) > (cur.get("number") or 0):
            idx[ref] = pr
    return idx


def find_pr(branch, pr_state="all"):
    """找 head 为该分支的 PR。分支名含 /，进 query 必须转义。

    state=all 时**开启中的优先**，不能返回第一个匹配。
    一个分支可能被反复用过（同名分支关掉 PR 后再开），GitHub 会保留
    历史 PR。返回第一个的话，很可能拿到一个**早已合并/关闭**的旧 PR，
    于是调用方看到 merged_at 为空就报「未合并，删除会丢改动」——
    方向恰好反了：改动其实早就在主干里了。

    取最新的：GitHub 按创建时间升序返回，所以先找开启中的，
    没有再退回最新的一个历史 PR。
    """
    prs = _paginate(f"/pulls?state={pr_state}"
                    f"&head={OWNER}:{quote(branch, safe='')}")
    matches = [p for p in prs or []
               if p.get("head", {}).get("ref") == branch]
    if not matches:
        return None
    if pr_state != "all":
        # 调用方已指定状态，按调用方要求返回（保持原语义）
        return matches[0]
    for p in matches:
        if p.get("state") == "open":
            return p
    return matches[-1]              # 全是历史 PR → 取最新的一条


def new_branch_name():
    """每次推送都新建分支：基点永远是当前主干，PR diff 才干净。

    随机后缀防并发撞名（同一秒内两人各推一次会撞纯时间戳）。
    """
    # 4 字节 = 8 hex ≈ 43 亿种。原来是 2 字节（4 hex = 65536 种），
    # 多人同时推或 CI 并发任务时，同一秒内撞名的概率不可忽略；
    # 撞名后 create_branch 收到 422，整个推送白跑一趟。
    return TASK_PREFIX + time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(4).hex()


def create_branch(branch, main_head):
    try:
        r = api("POST", "/git/refs",
                {"ref": f"refs/heads/{branch}", "sha": main_head})
    except SystemExit as e:
        # 422「Reference already exists」的真实成因是**分支名撞车**
        # （另一台机器同一秒生成了同名分支），与「远端已前进」毫无关系。
        # 走通用 hint 会让用户去 --pull，排查方向完全跑偏（P2-03）。
        if "422" in str(e) and "already exists" in str(e).lower():
            raise SystemExit(
                f"创建分支 {branch} 失败：该分支已存在。\n"
                f"  多半是另一台机器/另一个进程同时生成了同名分支。\n"
                f"  重跑一次即可（分支名带随机后缀，撞名概率极低）。")
        raise
    s = r.get("object", {}).get("sha")
    if not s:
        raise SystemExit(f"创建分支 {branch} 失败: {json.dumps(r)[:300]}")
    return s


def ensure_pr(branch, msg):
    """开 PR。分支是新建的，所以通常是新 PR（--hold 复用分支时才可能命中旧的）。

    **只复用 state == "open" 的 PR**。
    曾经不检查 state，直接命中 find_pr 的第一个结果。find_pr 默认查
    state=all，于是已关闭 / 已合并的旧 PR 会被复用：
      · 已合并：GitHub 对再 PUT /merge 返回 405 not mergeable，
        被 _NEED_UPDATE_HINTS 误判成「分支不是最新的」，提示完全跑偏
      · 已关闭：合并必然失败
    两种情况的后果都是「推送成功、改动不进主干、报错误导」，
    而用户只是用了同一个 -b 分支名（脚本自己也常提示带 -b）。
    """
    pr = find_pr(branch)
    if pr and pr.get("state") == "open":
        return pr, False
    pr = api("POST", "/pulls", {
        "title": (msg.splitlines()[0][:100] if msg else f"更新 {branch}"),
        "head": branch, "base": BRANCH,
        "body": "由 push_api.py 自动创建",
    })
    if "number" not in pr:
        raise SystemExit(f"创建 PR 失败: {json.dumps(pr)[:300]}")
    return pr, True


# GitHub 拒绝合并时的两类原因，处理方式完全不同：
#   conflict   —— 内容真冲突，要人解决
#   need_update —— 分支不够新（仓库开了「合并前必须同步主干」保护），
#                  重新基于最新主干推一次即可，改动本身没冲突
_NEED_UPDATE_HINTS = (
    "Base branch was modified",     # 主干在 PR 打开后前进过
    "not up to date", "up-to-date",
    "not mergeable",
)

# CI 状态**必须独立成类**，不能混进 _NEED_UPDATE_HINTS。
#
# 混在一起的后果：CI 未跑完被判成「分支不是最新的」→ 提示去点
# 「Update branch」—— 照做完全无效，因为分支本来就是最新的，
# 卡住的是 CI。用户会以为工具坏了，进而去试 --force-overwrite。
#
# 本脚本不主动轮询 check-runs（那需要额外 API 与等待策略），
# 但至少要**如实归类**，给出能真正推进的指引。
_CI_PENDING_HINTS = (
    "Required status check",
    "required status checks",
    "status check",
    "checks have not",
)


def _pr_mergeability(number, tries=4, delay=1.0):
    """取 PR 的权威合并状态 (mergeable, mergeable_state)。

    GitHub 的 `mergeable` 是**异步计算**的：刚创建的 PR 首次查询会返回
    `None`（表示「还没算出来」，不是「不能合并」）。必须轮询等它出结果，
    否则 `None` 会被当成 falsy → 一律判成 conflict，把「分支不够新」
    也误判成内容冲突。

    mergeable_state 的取值（GitHub 文档）：
      clean    —— 可合并
      dirty    —— 内容冲突（要人解决）
      behind   —— 分支落后于主干（仓库开了「必须同步」保护）
      blocked  —— 被保护规则挡住（需 review / 状态检查未过）
      unstable / draft / unknown
    """
    mergeable, state_name = None, None
    for i in range(tries):
        pr = api("GET", f"/pulls/{number}")
        if not isinstance(pr, dict):
            break
        mergeable = pr.get("mergeable")
        state_name = pr.get("mergeable_state")
        if mergeable is not None:
            break
        # mergeable 还没算出来：触发一次计算并等待
        if i + 1 < tries:
            time.sleep(delay * (2 ** i))     # 1s, 2s, 4s
    return mergeable, state_name


def merge_pr(number, method="squash"):
    """合并 PR。返回 (结果, 状态)；被拒时结果是 None。

    GitHub 用 409/405 同时表示「内容冲突」和「分支不够新」，
    不区分的话会把后者当冲突处理，引导人去做根本不需要的冲突解决。

    判据优先级：
      1. **权威字段** mergeable / mergeable_state（准）
      2. 拿不到时退回错误信息匹配（兜底，不如前者可靠）
    """
    try:
        r = api("PUT", f"/pulls/{number}/merge", {"merge_method": method})
    except SystemExit as e:
        msg = str(e)
        if not ("HTTP 409" in msg or "HTTP 405" in msg):
            raise

        # ① 先问 GitHub 自己：这个 PR 到底能不能合、为什么不能
        try:
            mergeable, mstate = _pr_mergeability(number)
        except BaseException:
            mergeable, mstate = None, None     # 查不到就退回字符串匹配

        if mstate:
            s = mstate.lower()
            if s == "dirty":
                return None, "conflict"
            if s in ("behind", "blocked", "unstable", "draft"):
                # behind  = 分支不够新（重新基于最新主干推一次即可）
                # blocked = 保护规则挡住（需 review / 状态检查）
                # 这两类都不是内容冲突，不该引导人去手工解冲突
                return None, "need_update"
        if mergeable is False and not mstate:
            return None, "conflict"

        # ② 兜底：错误文案匹配
        low = msg.lower()
        # CI 类必须**先于** need_update 判定。
        #
        # 原文把 "Required status check" 放在 _NEED_UPDATE_HINTS 里，
        # 于是 CI 未跑完被判成「分支不是最新的」→ 提示去点「Update branch」
        # —— 照做完全无效：分支本来就是最新的，卡住的是 CI。
        # 用户会以为工具坏了，进而尝试 --force-overwrite。
        if any(h.lower() in low for h in _CI_PENDING_HINTS):
            return None, "ci_pending"
        if any(h.lower() in low for h in _NEED_UPDATE_HINTS):
            return None, "need_update"
        return None, "conflict"
    return r, ("merged" if r.get("merged") else (r.get("message") or "unknown"))


def delete_branch(branch):
    api("DELETE", _ref_path(branch), allow_404=True)


def _paginate(path, cap=50):
    """拉一个列表接口的**全部**页。

    三处列表接口原来都是 `per_page=100` 取第一页、不翻页。
    分支或 PR 超过 100 条时：
      · --prune 静默漏分支 ——「分支体检」报「很干净」，实为漏报；
        这类**看起来正常的错误安全感**比崩溃更危险
      · --merge 的候选列表漏 PR，用户以为没有可合并的
      · find_pr 漏 PR，可能复用到一个陈旧的

    cap 是页数上限（默认 50 页 = 5000 条），防止接口异常时无限循环。
    触顶时打印警告，不假装结果完整。
    """
    out, page, sep = [], 1, "&" if "?" in path else "?"
    while page <= cap:
        batch = api("GET", f"{path}{sep}per_page=100&page={page}") or []
        if not isinstance(batch, list):
            break
        out.extend(batch)
        if len(batch) < 100:
            return out
        page += 1
    print(f"  ! 列表超过 {cap * 100} 条，已截断：{path}")
    return out


def list_branches():
    return _paginate("/branches")


def _refresh_main_baseline(state, new_head, merged_pushed=None):
    """主干前进后刷新基线：只更新「本地已是主干版本」的文件。

    本地还没合上的**保留旧基线** —— 否则 --pull 会认为主干没变过，
    再也拉不下来（和推送后刷新基线同一个坑）。

    merged_pushed：本次 PR 推到分支的内容 {path: sha}。
    合并成功后，主干上这些文件的版本就是（或包含）**我推的内容**，
    因此可以无条件刷新基线 —— 否则会出现这种误判：
        --hold 推 v2 → 继续编辑成 v3 → --merge（主干 = v2）
        本地 v3 ≠ 主干 v2，按「本地落后」处理 → 提示 --pull
        而 --pull 又拿陈旧的 v1 当 base，把 v2→v3 自己的连续改动判成冲突
    实际上本地是**领先**主干，不是落后。
    """
    new_rstate = remote_state_map(new_head)
    lmap = local_state_map()
    lagging = []
    for p, (m, s) in new_rstate.items():
        if lmap.get(p) == (m, s):
            state["files"][p] = {"mode": m, "sha": s}
            continue
        if merged_pushed and merged_pushed.get(p) == s:
            # 主干上这个版本正是我推上去的 → 基线跟进，本地的后续改动
            # 就落在正确的 base 上，不会再被当成「落后」或假冲突。
            state["files"][p] = {"mode": m, "sha": s}
            continue
        if p not in lmap:
            # 本地根本没有这个文件 → 是**主干新增**，不是「本地落后」。
            #
            # 原来两者都进 lagging，于是 synced_commit 被置 None，
            # 结果是「刚合并成功 → 立刻被 P0-1 拦住」—— 用户刚推送完
            # 就被挡在门外，且提示的出路是 --pull（没什么可拉的）。
            #
            # 主干新增不会造成覆盖：用户的 todo 里不会有它（没改过），
            # 推送时不会带上；本地补齐由 --pull 的「本地缺失」分支负责
            # （那条是独立判据 p not in lmap，不依赖 lagging）。
            state["files"][p] = {"mode": m, "sha": s}
            continue
        old = state["files"].get(p) or {}
        if old.get("sha") != s:
            lagging.append(p)
    state["base_commit"] = new_head
    state["synced_commit"] = None if lagging else new_head
    return lagging


def do_merge(state, number, method="squash", yes=False, quiet=False,
            keep_on_conflict=False):
    """合并 PR → 刷新主干基线 → 删分支。返回是否成功。

    quiet：自动合并时静音掉「确认 / 已合并」这类交互性输出。
    """
    pr = api("GET", f"/pulls/{number}")
    branch = pr.get("head", {}).get("ref")
    if pr.get("state") == "closed" and not pr.get("merged"):
        print(f"PR #{number} 已关闭且未合并")
        return False
    if not quiet:
        print(f"\n合并 PR #{number}：{branch} → {pr.get('base', {}).get('ref')}  [{method}]")
        if not yes and safe_input("确认合并？(y/N) ").strip().lower() != "y":
            print("已取消")
            return False

    r, status = merge_pr(number, method)
    if r is None:
        if status == "ci_pending":
            # CI 挡住 ≠ 内容冲突，也 ≠ 分支旧了。
            #
            # 三者的处置完全不同：
            #   conflict   → 拉取主干、手工解决冲突        （本地操作）
            #   need_update→ 网页点 Update branch 或重推   （更新分支）
            #   ci_pending → 只能等 CI 跑完/转绿           （什么都不用做）
            # 把 ci_pending 错当前两类，会把人推向一堆无效操作，
            # 最后怀疑工具坏了。
            print(f"\n⏳ PR #{number} 被 CI 状态挡住（内容无冲突，分支也是最新的）。")
            print("   · 等 CI 跑完 / 转绿后重跑 --merge 即可")
            print("   · 若仓库本就没有必需检查，说明开了分支保护规则，"
                  "需到仓库设置里调整")
            print(f"   · 分支 {branch} 与 PR #{number} 已保留，改动没丢。")
            return False
        if status == "need_update":
            # 不是内容冲突，只是分支旧了 —— 保留分支：
            # 用户可以在 GitHub 网页点「Update branch」就地解决，比本地重推快。
            print(f"\n❌ PR #{number} 暂不能合并：分支 {branch} 不是最新的。")
            print("   仓库开了「合并前分支必须与主干同步」的保护规则，改动本身没冲突。")
            print("\n   二选一：")
            print("     · 网页上点 PR 的「Update branch」后，再跑 --merge")
            print("     · 本地：push_api.py --pull   然后   push_api.py（会用新基点重建分支）")
            print(f"\n   分支 {branch} 与 PR #{number} 已保留，改动也在本地，都没丢。")
            return False
        else:
            print(f"\n❌ PR #{number} 合并冲突：GitHub 无法把 {branch} 自动合进 {BRANCH}。")
            print("   把主干改动合进本地、解决冲突后重新推送：")
            print("     python3 push_api.py --pull        # 三方合并主干改动到本地")
            print("     # 手工解决冲突标记后")
            print("     python3 push_api.py --resolve <文件>")
            print("     python3 push_api.py               # 重新推送")
        print("\n   改动没丢 —— 还在你的本地工作区。")
        if keep_on_conflict:
            print(f"\n   分支 {branch} 与 PR #{number} 已保留（--keep-on-conflict）。")
        else:
            # 收摊而不是留着：一个合不进去、又没人再推的分支就是僵尸 PR，
            # 会一直占着列表，也会让 --prune 每次都报一遍。
            abandon_task(state, branch, number)
            print(f"\n   已关闭 PR #{number} 并删除分支 {branch}（改动在本地，没丢）。")
            print("   想留着分支自己处理：加 --keep-on-conflict")
        return False

    if not quiet:
        print(f"✅ PR #{number} 已合并（{status}）")
    # 取出本次 PR 推到分支的内容，让基线能正确跟进（见 _refresh_main_baseline）
    task = (state.get("tasks") or {}).get(branch) or {}
    # 优先用 merge 响应里的 sha：PUT /merge 返回 200 后立即 ref_sha(BRANCH)，
    # 若 GitHub 的 ref 更新有延迟会拿到**旧 head**，后续判定会误以为
    # 「远端又前进了」。
    merged_sha = (r or {}).get("sha") or ref_sha(BRANCH)
    lagging = _refresh_main_baseline(state, merged_sha,
                                     merged_pushed=task.get("pushed"))
    delete_branch(branch)
    if not quiet:
        print(f"  · 已删除分支 {branch}（内容已在 {BRANCH}）")
    state.setdefault("tasks", {}).pop(branch, None)
    if state.get("task_branch") == branch:
        state["task_branch"] = None
        state["pr_number"] = None
    save_state(state)
    if lagging:
        print(f"\n  ! {len(lagging)} 个文件本地落后于合并后的 {BRANCH}，改它们前先 --pull")
    return True


def abandon_task(state, branch, pr_number=None, yes=False):
    """放弃任务：关 PR + 删分支。

    合并冲突时用。改动本来就在本地工作区，分支只是传输通道，
    删掉它不会丢任何东西；留着反而会变成僵尸 PR 一直占着列表。

    「不会丢任何东西」这个前提**只在单人单分支时成立**：
      · 机器 A 用 --hold 推 v2，机器 B 推 v3
      · A 合并冲突 → 本函数删掉分支 → B 的 v3 永久丢失
    所以删除前要比对分支 head 与 tasks 里记录的内容；对不上就说明
    分支上有别人后来推的改动，删不得。
    """
    # 主干硬拦：与 close_pr / delete_branch_cmd 一致，那两处早就有这个
    # 判断，本处没有 —— 同一个危险动作三处实现只有两处设防。
    if branch == BRANCH:
        raise SystemExit(f"拒绝删除主干分支 {BRANCH}。")

    # 内容校验：分支上有本地不知道的改动时不删。
    task = (state.get("tasks") or {}).get(branch) or {}
    head = ref_sha(branch)
    if head and task.get("head") and head != task["head"]:
        raise SystemExit(
            f"分支 {branch} 上有未记录的改动（远端 {str(head)[:8]} ≠ "
            f"记录的 {str(task['head'])[:8]}），拒绝删除。\n"
            f"  可能是另一台机器用同一分支推过内容（--hold 场景）。\n"
            f"  先确认内容归属：git fetch 后比对，或用 --branch 继续处理。")

    pr = pr_number or (find_pr(branch, pr_state="open") or {}).get("number")
    if pr:
        try:
            api("PATCH", f"/pulls/{pr}", {"state": "closed"})
        except SystemExit:
            pass
    delete_branch(branch)
    state.setdefault("tasks", {}).pop(branch, None)
    if state.get("task_branch") == branch:
        state["task_branch"] = None
        state["pr_number"] = None
    save_state(state)


def close_pr(state, branch, yes=False):
    """关闭 PR 并删分支（--hold 的任务确认不做了时用）。"""
    # 与 delete_branch_cmd 同一道闸：本函数末尾会删分支。
    if branch == BRANCH:
        raise SystemExit(
            f"拒绝关闭/删除主干分支 {BRANCH}。\n"
            f"  --close-pr 只用于 {TASK_PREFIX}* 任务分支。")
    pr = find_pr(branch, pr_state="open")
    if not pr:
        print(f"{branch} 没有开启中的 PR")
        return
    n = pr["number"]
    if not yes:
        if safe_input(f"关闭 PR #{n}（{branch} → {BRANCH}）并删除分支？(y/N) ").strip().lower() != "y":
            print("已取消")
            return
    api("PATCH", f"/pulls/{n}", {"state": "closed"})
    print(f"✅ 已关闭 PR #{n}")
    delete_branch(branch)
    state.setdefault("tasks", {}).pop(branch, None)
    if state.get("task_branch") == branch:
        state["task_branch"] = None
        state["pr_number"] = None
    save_state(state)
    print(f"  · 已删除分支 {branch}")


def delete_branch_cmd(state, branch, yes=False):
    """显式删除分支。

    --prune 只报告不删，真正要删走这里，且必须逐个确认 ——
    分支是唯一可能存着「没合进主干的改动」的地方，删错不可恢复。
    """
    # 主干必须硬拦：删掉主干等于删掉整个项目，且 GitHub 往往保护不了
    # 通过 API 发起的删除。放在这里而不是参数解析处，是因为两个入口
    #（--delete-branch / --close-pr）都要过这道闸。
    if branch == BRANCH:
        raise SystemExit(
            f"拒绝删除主干分支 {BRANCH}。\n"
            f"  --delete-branch 只用于清理 {TASK_PREFIX}* 任务分支。\n"
            f"  误删主干会丢失整个项目，且不可恢复。")
    # 受保护分支同样硬拦（main / master / develop / release …）。
    #
    # PROTECTED_BRANCHES 在 prune() 里是**排除名单**（体检时不纳入），
    # 却从没在删除侧生效 —— 于是同一份常量在报告侧说「别动它」、
    # 在删除侧照删不误（实测：--delete-branch develop --yes 直接删掉）。
    #
    # 必须**不受 yes 影响**：--yes 是脚本文档自己推荐用法，而「确认」
    # 不能授权删除一条长期集成分支 —— 那种删除不可逆，且会波及所有人。
    if branch in PROTECTED_BRANCHES:
        raise SystemExit(
            f"拒绝删除受保护分支 {branch}。\n"
            f"  受保护分支：{sorted(PROTECTED_BRANCHES)}（可用环境变量 "
            f"PUSH_API_PROTECTED 调整）。\n"
            f"  它们多为长期集成分支，删除不可逆且影响他人；\n"
            f"  确要删除请先从 PUSH_API_PROTECTED 中移除该分支名。")
    if not branch.startswith(TASK_PREFIX):
        print(f"  ⚠️  {branch} 不是 {TASK_PREFIX}* 任务分支"
              f"（可能是受保护分支或别人在用的分支）")
        if not yes and safe_input("  确认仍要删除？(y/N) ").strip().lower() != "y":
            print("已取消")
            return
    pr = find_pr(branch)
    if not pr:
        note = "没有任何 PR（孤儿分支，删除会丢改动！）"
    elif pr.get("merged_at") or pr.get("merged"):
        note = f"PR #{pr['number']} 已合并，内容已在 {BRANCH}（删掉无损失）"
    else:
        note = f"PR #{pr['number']} 状态 {pr.get('state')}（未合并，删除会丢改动！）"
    print(f"\n删除分支 {branch}")
    print(f"  {note}")
    if not yes:
        if safe_input("确认删除？(y/N) ").strip().lower() != "y":
            print("已取消")
            return
    delete_branch(branch)
    state.setdefault("tasks", {}).pop(branch, None)
    if state.get("task_branch") == branch:
        state["task_branch"] = None
        state["pr_number"] = None
    save_state(state)
    print(f"✅ 已删除 {branch}")


def _list_conflict_artifacts():
    """列出 .push-conflicts 里的残留副产物。

    这个目录**只增不减**：删除只在 --resolve 和下一轮冲突写入前的清理里。
    用户放弃解决冲突，它就永久留下 —— 在仓库外、--prune 不管、也没有
    任何命令能列出来。而里面是**完整的远端明文内容**，属于被遗忘的
    敏感数据副本。至少要让 --status / --prune 能看见它。
    """
    d = CONFLICT_DIR
    if not os.path.isdir(d):
        return []
    out = []
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            try:
                out.append((name, os.path.getsize(p)))
            except OSError:
                out.append((name, -1))
    return out


def _report_conflict_artifacts():
    items = _list_conflict_artifacts()
    if not items:
        return
    print(f"\n  ! 冲突副产物目录还有 {len(items)} 个文件未清理：{CONFLICT_DIR}")
    for name, size in items[:10]:
        print(f"     · {name}" + (f"  ({size} B)" if size >= 0 else ""))
    if len(items) > 10:
        print(f"     … 还有 {len(items) - 10} 个")
    print("     里面是完整的远端明文内容。冲突解决完请 --resolve，"
          "或确认无用后手工删除该目录。")


def show_status(state, head_sha):
    _report_conflict_artifacts()
    wf = state.get("workflow") or DEFAULT_WORKFLOW
    print(f"工作流：{'PR（每次新建 → 推送 → 自动合并 → 删分支）' if wf == 'pr' else '直推主干'}")
    print(f"主干 {BRANCH} = {str(head_sha)[:8]}")
    print(f"当前任务分支：{state.get('task_branch') or '（无，下次推送会新建）'}")
    print(f"当前 PR：{state.get('pr_number') or '（无）'}")
    print("\n常用：")
    print("  python3 push_api.py            # 新建分支 → 推 → 自动合并 → 删分支")
    print("  python3 push_api.py --hold     # 先不合并，攒几次改动")
    print("  python3 push_api.py --merge    # 合并 --hold 留下的 PR")
    print("  python3 push_api.py --prune    # 分支体检（只报告，不删）")


def _prune_stale_tasks(state, remote_names):
    """摘掉 tasks 里「远端已无此分支」的条目。

    tasks[branch] 只在 merge / abandon / new-task 时清理。推送失败时
    条目不清理，而 prune 的分类只覆盖**远端还存在的**分支，于是
    「本地记着、远端早已没了」的条目会永久累积：
      · 状态文件缓慢膨胀
      · --prune 输出里出现早已不存在的分支（用户会去找一个不存在的东西）
    分支都没了，本地记录就只剩误导作用。

    只动 state，不碰远端 —— 与「--prune 不删除任何东西」不冲突。
    """
    tasks = state.get("tasks") or {}
    stale = [n for n in tasks if n not in remote_names]
    if not stale:
        return
    for n in stale:
        tasks.pop(n, None)
    # 当前任务分支若已被摘除，同步清掉，避免指向一条空记录
    if state.get("task_branch") in stale:
        state["task_branch"] = None
    save_state(state)
    print(f"\n[已清理] {len(stale)} 条本地任务记录（远端已无此分支）："
          f" {sorted(stale)[:5]}{' …' if len(stale) > 5 else ''}")
    print("   仅清理本地记录，未改动远端。")


def prune(state, grace_days=MERGED_GRACE_DAYS):
    """分支体检：**只报告，绝不删除**。

    判据用「合并状态 + 活动状态」，不用「N 天没用」——
    一个开发到一半的 WIP 分支，恰恰就是「开着、没合并、可能好几天没动」，
    按时间自动删会最先误杀它。

    已合并但分支仍在的，只有超过 grace_days 天才报告：
    正常流程合并完立刻就删了，刚合并还没删的多半是流程还在跑，
    立刻报告会让两个人互相反复刷同一条。
    """
    # 必须放在 docstring **之后**：上一版这条语句写在 docstring 前面，
    # 于是那段长注释不再是 docstring（prune.__doc__ is None），
    # 被 Python 当成一个无用的字符串字面量丢掉 ——
    # 「只报告不删」这份核心契约因此 help() 看不到、文档工具抓不到。
    _report_conflict_artifacts()
    # 排除法，不用前缀白名单。
    #
    # 原来只认 task/ 前缀：pr/ fix/ feature/ 等前缀的分支**静默漏报**，
    # 而 --prune 的全部价值就在于「不漏」——它报出的「很干净」会被当成
    # 真的干净。实测：一次推送用的 pr/backfill-round2 根本不在视野内。
    #
    # 改成排除主干与受保护分支：只要不是这些，一律纳入体检。
    # 宁可多报（用户能自己判断），不可漏报（他以为没事）。
    protected = {BRANCH} | set(PROTECTED_BRANCHES)
    mine = [b for b in list_branches()
            if (b.get("name") or "") not in protected]
    if not mine:
        print(f"\n没有 {TASK_PREFIX}* 分支，很干净。")
        # 仍要清理僵尸 tasks 条目：一个 task/* 分支都没有，
        # 恰恰说明 tasks 里的记录**全**是过期的 —— 这里 return 掉
        # 的话它们永远清不掉，正是 P3-5 要治的累积问题。
        _prune_stale_tasks(state, set())
        return

    merged_stale, merged_recent, opening, orphan, closed = [], [], [], [], []
    skewed = []                      # 时间戳落在「未来」→ 本地时钟慢
    # 一次建索引代替循环内逐个 find_pr（N+1 → 1 次请求）。
    pr_index = _pr_index("all")
    for b in mine:
        name, last = b.get("name"), _branch_date(b)
        pr = pr_index.get(name)
        if pr is None:
            orphan.append((name, last))
        elif pr.get("merged_at") or pr.get("merged"):
            d = _days_since(pr.get("merged_at"))
            # 负值 = 本地时钟慢于 GitHub 服务器（时间戳还在「未来」）。
            #
            # 报告建议 `max(0.0, d)` 兜住，但那治标不治本：
            # max(0,d) 之后 d=0，`0 >= grace_days` 依然是 False，
            # 陈旧分支照样不报 —— 只是把「负值」这个信号抹掉了，
            # 让它看起来像「刚合并、无需处理」，反而更静默。
            #
            # 正确做法是**让时钟不一致显形**：提示用户，并按最保守的
            # 方式处理（时钟不可信时，无法判断新旧，不该假装安全）。
            if d is not None and d < 0:
                skewed.append((name, pr["number"], d))
            (merged_stale if (d is not None and d >= grace_days) else merged_recent
             ).append((name, pr["number"], d))
        elif pr.get("state") == "closed":
            closed.append((name, pr["number"], last))
        else:
            opening.append((name, pr["number"], pr.get("updated_at") or last))

    print(f"\n{TASK_PREFIX}* 分支 {len(mine)} 个（只报告，不删除任何东西）：")

    if merged_stale:
        print(f"\n[应当清理] 已合并超过 {grace_days} 天，分支却还在"
              f"（正常流程早该删了）：")
        for name, n, d in merged_stale:
            print(f"   · {name}   PR #{n}   已合并 {d:.0f} 天")
            print(f"     python3 push_api.py --delete-branch {name}")
    if skewed:
        print("\n[⚠ 时钟不一致] 以下分支的合并时间落在**未来**，"
              "说明本机时钟比 GitHub 服务器慢：")
        for name, n, d in skewed:
            print(f"   · {name}   PR #{n}   时间差 {abs(d):.1f} 天")
        print("   时钟不可信时无法判断分支新旧，上面的分类可能不准。")
        print("   建议校准本机时间（ntpdate / 系统时间设置）后重新 --prune。")
    if merged_recent:
        print(f"\n[无需处理] 刚合并、分支待删（{grace_days} 天内，属正常流程）："
              f" {len(merged_recent)} 个")
    if opening:
        print("\n[保留] PR 仍开启 —— 可能是进行中的工作，不删：")
        for name, n, ts in opening:
            d = _days_since(ts)
            extra = f"，{d:.0f} 天无更新" if d is not None else ""
            # tasks[branch]["last_push"] 以前**只写不读**（死字段）。
            # 维护者会误以为它参与判定，而实际上没有 —— 这种隐性误导
            # 比缺少字段更糟。这里让它真正派上用场：PR 的 updated_at
            # 会因为评论等无关活动而变新，而 last_push 才反映
            # 「最后一次真的推了内容」，判断 WIP 是否还在推进更准。
            pushed = ((state.get("tasks") or {}).get(name) or {}).get("last_push")
            if pushed:
                pd = _days_since(pushed)
                extra += (f"（最后推送 {pushed}"
                          + (f"，{pd:.0f} 天前" if pd is not None else "") + "）")
            print(f"   · {name}   PR #{n}   最后活动 {ts or '-'}{extra}")
        print("   确认不做了：python3 push_api.py --branch <名字> --close-pr")
    if closed:
        print("\n[按需删] PR 已关闭且未合并（改动没进主干，但分支还在）：")
        for name, n, ts in closed:
            print(f"   · {name}   PR #{n}   最后提交 {ts or '-'}")
            print(f"     python3 push_api.py --delete-branch {name}")
    if orphan:
        # tasks 里还在跟踪的分支**不能**当孤儿处理。
        #
        # 它们多半是「分支已推上内容、但开 PR 失败」留下的（见 --push 时
        # 的 P1-8 提示）。此刻分支上装着用户刚推的东西，而 --prune 恰恰
        # 会把它判成孤儿并给出 --delete-branch —— 工具引导用户删掉自己
        # 的改动，与推送时那句「不要 --delete-branch」自相矛盾。
        tracked = set((state.get("tasks") or {}).keys())
        orphan_free = [(n, t) for n, t in orphan if n not in tracked]
        orphan_held = [(n, t) for n, t in orphan if n in tracked]

        if orphan_held:
            print("\n[先确认] 无 PR、但本地还在跟踪的分支（可能装着刚推的改动）：")
            for name, ts in orphan_held:
                print(f"   · {name}   最后提交 {ts or '-'}")
                print("     多半是开 PR 失败留下的。先重试：")
                print(f"       python3 push_api.py --branch {name} -m \"<消息>\"")
                print("     ⚠ 确认分支上没有你的改动后，才可 --delete-branch。")

        if orphan_free:
            print("\n[按需删] 没有任何 PR 的孤儿分支：")
            for name, ts in orphan_free:
                print(f"   · {name}   最后提交 {ts or '-'}")
                print(f"     python3 push_api.py --delete-branch {name}")
    if not (merged_stale or opening or closed or orphan):
        print("   全部无需处理")

    _prune_stale_tasks(state, {b.get("name") for b in mine})
    print("\n（删除一律走 --delete-branch 并逐个确认；--prune 自己不删任何东西）")


# ---------------------------------------------------------------- 预览

def _remote_blob_lines(sha, size_hint=None):
    """取远端 blob 的文本行；拿不到、二进制或超大返回 None。

    注：GitHub 对超过 1MB 的 blob 在 JSON 响应里不返回 content，此时降级。
    """
    if size_hint is not None and size_hint > MAX_PREVIEW_BYTES:
        return None
    data = api("GET", f"/git/blobs/{sha}")
    if data.get("encoding") != "base64" or not data.get("content"):
        return None
    try:
        return base64.b64decode(data["content"]).decode("utf-8", "replace").splitlines()
    except Exception:
        return None


def _local_lines(rel, mode):
    """本地文件文本行；symlink 直接展示它指向哪（这才是要推上去的内容）。"""
    full = os.path.join(ROOT, rel)
    if mode == "120000":
        # 不加 "-> " 前缀：远端 symlink blob 存的就是**目标路径字符串**本身，
        # 加了前缀后本地行与远端行永远差一个前缀，diff 恒为 +1/-1，
        # 于是「内容完全没变」也被显示成有改动 —— 预览层失真，
        # 而预览是推送前最后一道人工确认。
        # 而 `if mode_changed and add == 0 and sub == 0: continue` 救不了它，
        # 因为此时 add=1、sub=1，两边都不为 0。
        return [os.readlink(full)]
    try:
        if os.path.getsize(full) > MAX_PREVIEW_BYTES:
            return None
        with open(full, "rb") as f:
            if b"\0" in f.read(64 * 1024):      # 粗判二进制
                return None
        with open(full, encoding="utf-8", errors="replace") as f:
            return f.read().splitlines()
    except OSError:
        return None


def preview(todo, rstate, lmap):
    """预览：直接对比「本地文件 vs 远端最新内容」。

    不能用 `git diff HEAD`：本地 HEAD 只是拉取时的快照，而实际推送是以
    base_tree=head_sha（远端最新）为底的，远端比你新时 diff 基准就错了，
    会出现「确认的内容 ≠ 实际推上去的内容」。
    """
    # 每个文件都要一次 GET /git/blobs 拉远端内容：100 个文件 = 100 次
    # 额外请求，串行、无缓存，且 **--dry-run 也照发不误** —— 预演既不
    # 免费也不无害。叠加建 blob 本身，API 消耗直接翻倍，撞上限流后报
    # 403，而 403 提示只说「限流或权限」，用户联想不到是预览造成的。
    # 超过阈值只对前若干个做内容 diff，其余只报行数差（不需要拉远端）。
    PREVIEW_CAP = 20
    todo_all = list(todo)
    todo_preview = todo_all[:PREVIEW_CAP]
    skipped_preview = len(todo_all) - len(todo_preview)
    if skipped_preview > 0:
        print(f"\n  ! 共 {len(todo_all)} 个文件，只对前 {PREVIEW_CAP} 个做内容预览"
              f"（其余 {skipped_preview} 个省略，避免拉远端内容打爆 API 限流）")

    print(f"\n待推送 {len(todo_all)} 个文件（对比基准 = 远端 {BRANCH} 最新内容，非本地 HEAD）：")
    for rel in todo_preview:
        try:
            size = os.path.getsize(os.path.join(ROOT, rel))
        except OSError:
            size = 0
        lmode = lmap.get(rel, ("100644", ""))[0]
        r = rstate.get(rel)
        if r is None:
            print(f"   A {rel}   新增（{size} B，mode {lmode}）")
            continue
        rmode, rsha = r
        mode_changed = (lmode != rmode)
        if mode_changed:
            print(f"   M {rel}   mode {rmode} → {lmode}（权限/类型变更）")
        old, new = _remote_blob_lines(rsha), _local_lines(rel, lmode)
        if old is None or new is None:
            # 成因要分清：old 为 None 也可能是**远端文件过大拉不下来**，
            # 而文案按本地大小写成「本地文件过大」会让排查方向完全错。
            if size > MAX_PREVIEW_BYTES:
                why = f"本地文件超过预览上限（{size} B）"
            elif old is None:
                why = "远端内容拉不下来或超过预览上限"
            else:
                why = "二进制或过大"
            if mode_changed:
                print(f"        （{why}，跳过内容预览）")
            else:
                print(f"   M {rel}   {why}，跳过内容预览（本地 {size} B）")
            continue
        if len(old) > MAX_PREVIEW_LINES or len(new) > MAX_PREVIEW_LINES:
            print(f"   M {rel}   远端 {len(old)} 行 → 本地 {len(new)} 行")
            continue
        # 必须 list() 物化：unified_diff 是**生成器**，
        # 第一个 sum() 会把它消费殆尽，第二个拿到空生成器 → 删除行恒为 0。
        # 实测推送前预览显示 "+1 / -0"，删了 30 行也显示 -0 ——
        # 这是推送前最后一道人工确认，展示失真等于确认无效。
        d = list(difflib.unified_diff(old, new, n=0))
        add = sum(1 for l in d if l.startswith("+") and not l.startswith("+++"))
        sub = sum(1 for l in d if l.startswith("-") and not l.startswith("---"))
        if mode_changed and add == 0 and sub == 0:
            continue                       # 上面已报 mode 变更，内容无变化
        print(f"   M {rel}   +{add} / -{sub}")

    # P2-2：被省略的文件必须**单独列出来**。
    # 它们仍会照常推送，却在上面一个字都看不到名字 —— 而「待推送 N 个文件」
    # 里是包含它们的。用户会以为自己看过全部 diff 了。
    if skipped_preview > 0:
        print(f"\n  · 以下 {skipped_preview} 个文件**未做内容预览**"
              f"（超出 {PREVIEW_CAP} 个上限），仍会照常推送：")
        for rel in todo_all[PREVIEW_CAP:]:
            print(f"     {rel}")


def default_msg(todo):
    if len(todo) == 1:
        return f"chore: 更新 {todo[0]}"
    if len(todo) <= 3:
        return "chore: 更新 " + "、".join(todo)
    return MSG_FALLBACK


# ---------------------------------------------------------------- 参数

def parse_args(argv):
    opts = {"dry": False, "yes": False, "init": False, "reset": False,
            "force": False, "ignore_pending": False,
            "mark_synced": False, "msg": None,
            "pull": False, "resolve": False, "force_files": [],
            "direct": False, "branch": None, "merge": False, "status": False,
            "close_pr": False, "prune": False, "new_task": False, "hold": False,
            "delete_branch": None, "keep_on_conflict": False,
            "method": "squash", "stale_days": MERGED_GRACE_DAYS,
            "state_path": None, "help": False}
    rest, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a in ("--help", "-h"):
            # 必须有：没有 -h 时打错参数会落到「未知参数」分支，
            # 用户拿不到任何用法说明，只能去翻源码。
            print(USAGE)
            raise SystemExit(0)
        elif a in ("--state",):
            # 报错文案一直建议「请换用对应的 STATE_PATH」，但此前根本没有
            # 这个参数 —— 建议的操作不存在。同一台机器推多个仓库时，
            # 每个仓库需要各自的基线文件。
            if i + 1 >= len(argv):
                raise SystemExit("--state 需要一个路径参数")
            opts["state_path"] = argv[i + 1]
            i += 1
        elif a == "--dry-run":
            opts["dry"] = True
        elif a in ("--yes", "-y"):
            opts["yes"] = True
        elif a == "--init-baseline":
            opts["init"] = True
        elif a == "--reset-baseline":
            opts["reset"] = True
        elif a == "--mark-synced":
            opts["mark_synced"] = True
        elif a == "--pull":
            opts["pull"] = True
        elif a == "--resolve":
            opts["resolve"] = True
        elif a == "--direct":
            opts["direct"] = True
        elif a == "--status":
            opts["status"] = True
        elif a == "--merge":
            opts["merge"] = True
        elif a == "--close-pr":
            opts["close_pr"] = True
        elif a == "--prune":
            opts["prune"] = True
        elif a == "--new-task":
            opts["new_task"] = True
        elif a == "--hold":
            opts["hold"] = True
        elif a == "--keep-on-conflict":
            opts["keep_on_conflict"] = True
        elif a == "--delete-branch":
            if i + 1 >= len(argv):
                raise SystemExit("--delete-branch 缺少参数")
            opts["delete_branch"] = argv[i + 1]
            i += 1
        elif a.startswith("--delete-branch="):
            opts["delete_branch"] = a.split("=", 1)[1]
        elif a in ("--branch", "-b"):
            if i + 1 >= len(argv):
                raise SystemExit("--branch 缺少参数")
            opts["branch"] = argv[i + 1]
            i += 1
        elif a.startswith("--branch="):
            opts["branch"] = a.split("=", 1)[1]
        elif a == "--method":
            if i + 1 >= len(argv):
                raise SystemExit("--method 缺少参数")
            opts["method"] = argv[i + 1]
            i += 1
        elif a.startswith("--method="):
            opts["method"] = a.split("=", 1)[1]
        elif a == "--stale-days":
            if i + 1 >= len(argv):
                raise SystemExit("--stale-days 缺少参数")
            raw = argv[i + 1]
            try:
                opts["stale_days"] = int(raw)
            except ValueError:
                raise SystemExit(
                    f"--stale-days 需要一个整数天数，收到 {raw!r}\n"
                    f"  用法：--stale-days 7")
            if opts["stale_days"] < 0:
                raise SystemExit(f"--stale-days 不能为负数：{raw}")
            i += 1
        elif a == "--force-overwrite":
            opts["force"] = True
        elif a == "--ignore-pending":
            # 独立于 --force-overwrite：--pull 场景里「跳过上次未解决的
            # 冲突」与「覆盖远端」是两件事，不能共用一个开关。
            opts["ignore_pending"] = True
        elif a in ("--force-file", "--allow-overwrite"):
            # 细粒度放行：只覆盖显式点名的文件，别把所有 blocked 一起放过去。
            if i + 1 >= len(argv):
                raise SystemExit("--force-file 缺少参数")
            opts["force_files"].append(argv[i + 1])
            i += 1
        elif a.startswith("--force-file=") or a.startswith("--allow-overwrite="):
            opts["force_files"].append(a.split("=", 1)[1])
        elif a in ("-m", "--message"):
            if i + 1 >= len(argv):
                raise SystemExit("-m/--message 缺少参数")
            opts["msg"] = argv[i + 1]
            i += 1
        elif a.startswith("--message="):
            opts["msg"] = a.split("=", 1)[1]
        elif a == "--":
            # 之后一律当路径：以 `-` 开头的文件名（虽然罕见）否则会被
            # 当成未知选项，永远推不上去，且报错是「未知参数」而非
            # 「文件不存在」—— 排查方向完全跑偏。
            rest.extend(argv[i + 1:])
            break
        elif a.startswith("--"):
            raise SystemExit(f"未知参数: {a}")
        else:
            rest.append(a)
        i += 1

    # 放在循环后统一校验：--method 和 --method=x 两种写法都能覆盖到，
    # 不必在两处各写一遍。本地校验比把非法值发给 GitHub 再收一串 422 JSON
    # 好排查得多。
    if opts["method"] not in VALID_MERGE_METHODS:
        raise SystemExit(
            f"--method 只支持 {' / '.join(VALID_MERGE_METHODS)}，"
            f"收到 {opts['method']!r}")
    return opts, rest


# ---------------------------------------------------------------- 主流程

def _apply_state_path(opts):
    """让 --state 生效：替换全局 STATE_PATH。

    必须在**任何**读写基线之前调用：save_state / load_state 都直接读
    全局 STATE_PATH，晚一步就会先动默认路径上的文件。

    抽成函数是为了能单独测 —— 子进程跑真实命令会碰网络，
    而这里要验的是「参数有没有真的作用到全局」这一步。
    """
    if not opts.get("state_path"):
        return
    global STATE_PATH
    STATE_PATH = os.path.abspath(opts["state_path"])


def main():
    opts, explicit = parse_args(sys.argv[1:])
    _apply_state_path(opts)
    # 锁**不能**用 dry 推断：dry 时子命令照样会写状态文件（上面已拦住大部分，
    # 但门禁本身也可能有漏），更关键的是「可能写」就该加锁，
    # 用「这次不是 dry」来推断会不会写，等于把并发安全寄托在另一处的判断上。
    with StateLock(STATE_PATH, enabled=True):
        try:
            _main(opts, explicit)
        except _Cancel:
            # 分支创建**之前**的取消：那时还没有东西要清理，
            # 但异常不能冒到用户面前 —— 取消是正常流程，不是错误。
            pass


def _main(opts, explicit):
    dry, yes = opts["dry"], opts["yes"]

    # -------- git 可用性校验（必须最先）--------
    # git 不可用时 detect_changes()=[]、local_state_map()={}，脚本会把
    # 「读不到仓库」伪装成「仓库是干净的」，最终打印「本地没有待推送的
    # 改动」—— 用户以为没事，改动一个都没推（--direct 模式实测复现）。
    # 必须在**任何**其它动作之前拦下，越晚越容易让人误以为推送成功。
    require_git_repo()

    # -------- --dry-run 门禁（必须前置）--------
    # 原来 dry 只在两处被检查：建分支前（2478）和推送前（2604 附近）。
    # 而**子命令全在它之前分发**：--delete-branch 会真的删远端分支，
    # --pull 会改写本地文件，--merge 会真的合并进主干。
    # 实测：`--dry-run --delete-branch task/x --yes` 分支当场消失 ——
    # dry-run 是探索陌生命令时的第一反应，而删除远端分支**不可逆**。
    #
    # 判据用「白名单剩余项」而不是逐个 if dry：新增子命令时忘了同步
    # 这里，会静默漏过门禁。所以列出所有会改动的项，命中即拒绝。
    if dry:
        MUTATING = ("init", "reset", "mark_synced", "pull", "resolve",
                    "merge", "close_pr", "delete_branch")
        hit = [k for k in MUTATING if opts.get(k)]
        if hit:
            raise SystemExit(
                f"--dry-run 与 {', '.join('--' + k.replace('_', '-') for k in hit)} "
                f"不能同时使用。\n"
                f"  这些子命令会真实改动远端或本地文件，预演模式下无法模拟。\n"
                f"  --dry-run 只支持默认推送、--status 与 --prune。")
    init, reset, force = opts["init"], opts["reset"], opts["force"]

    ref = api("GET", f"/git/refs/heads/{BRANCH}")
    head_sha = ref.get("object", {}).get("sha")
    if not head_sha:
        raise SystemExit(f"取不到远端 {BRANCH}：{json.dumps(ref)[:300]}")
    print(f"远端 {BRANCH} = {head_sha}")

    rstate = remote_state_map(head_sha)
    print(f"远端文件 {len(rstate)} 个")

    # init/reset 用非严格模式：旧基线坏了也要能重建（否则用户得先手工删文件）。
    state = load_state(strict=not (init or reset))

    # -------- 基线建立 / 重设 --------
    if init or reset or state is None:
        if state is None:
            if not (init or reset):
                print("\n⚠️  没有基线记录（首次使用），无法判断远端文件是否被他人改动过。")
                print("   请先跑一次 `python3 push_api.py --init-baseline` 建立基线，再推送。")
                return
            init_baseline(head_sha, rstate)
            return
        if not reset:
            # 旧基线是无条件覆盖的话，第一层文件级防护会随之失效，必须拦一道。
            print(f"\n⚠️  基线已存在（记录于 commit {str(state.get('base_commit'))[:8]}），未做任何改动。")
            print("   确要丢弃旧基线并重设，请加 `--reset-baseline`：")
            print("   重设后「远端文件是否被他人改过」将失去参照，请确认远端已是最新。")
            return
        ans = "y" if yes else safe_input(
            f"\n重设基线会丢弃现有 {len(state.get('files', {}))} 条记录，"
            f"文件级防覆盖校验将暂时失效。继续？(y/N) "
        ).strip().lower()
        if ans != "y":
            print("已取消")
            return
        init_baseline(head_sha, rstate)
        return

    # -------- 基线归属校验 --------
    # 换仓库推时旧基线仍生效，会让所有文件报「可能被他人改动」——
    # 方向虽然是 fail-closed，但把人引向错误的排查方向。
    if state.get("remote") not in (None, f"{OWNER}/{REPO}"):
        raise SystemExit(
            f"基线属于另一个仓库：{state.get('remote')}，当前目标是 {OWNER}/{REPO}。\n"
            f"  不是他人改动，是仓库换了。请换用对应的 STATE_PATH，或用 --reset-baseline 重建。"
        )
    # branch 也一起校验：原来只在 state 里存了却从不比对，改 BRANCH 常量重跑
    # 会让 A 分支的基线拿去校验 B 分支，所有文件都可能被误判。
    if state.get("branch") not in (None, BRANCH):
        raise SystemExit(
            f"基线记录的是分支 {state.get('branch')}，当前目标是 {BRANCH}。\n"
            f"  跨分支复用基线会让文件级校验全部失真。请换 STATE_PATH 或 --reset-baseline。"
        )

    # -------- 基线版本迁移 --------
    state, migrated = migrate_state(state, rstate)
    if migrated:
        save_state(state)
        print(f"  · 基线已从 v1 迁移到 v{STATE_VERSION}（补记 mode，取自远端当前值）")
    state.setdefault("tasks", {})
    state.setdefault("conflicts", [])

    # -------- 工作流判定 --------
    # 不能写成 `state.get("workflow") or DEFAULT_WORKFLOW` 就完事：
    # 下面 PR 分支的判据是精确匹配 wf == "pr"，而 direct 是「else」——
    # 任何非 "pr" 的值（"PR" 大写、拼错、将来新增取值）都会**静默落到
    # direct**，即绕过 PR 流程直推主干（实测：workflow="PR" 时无分支、
    # 无 PR，改动直接上主干）。退化方向恰好是最危险的一侧，且用户全程无感知。
    #
    # 所以未知取值要**报错**而不是取默认值 —— 与 _local_head_rewound 里
    # 「git merge-base 退出码异常时 fail-closed」是同一个取舍：
    # 判不了就停下来问，不要替用户选一条更危险的路。
    raw_wf = state.get("workflow") or DEFAULT_WORKFLOW
    wf = "direct" if opts["direct"] else str(raw_wf).strip().lower()
    if wf not in ("pr", "direct"):
        raise SystemExit(
            f"基线里的 workflow 是 {raw_wf!r}，只接受 'pr' / 'direct'。\n"
            f"  未知取值不会静默回退（回退到 direct 等于绕过 PR 流程直推主干）。\n"
            f"  手工改 {STATE_PATH} 里的 workflow 字段，或跑 --reset-baseline 重建。")
    # --direct 必须落盘：否则用户每次都得手动加参数，更糟的是
    # --reset-baseline 之后（旧版把 workflow 写死默认值）会被静默改回 PR
    # 工作流 —— 下次推送走的是另一套逻辑且毫无提示。
    if opts["direct"] and state.get("workflow") != "direct":
        state["workflow"] = "direct"
        save_state(state)
    # 开了分支保护就别直推了：服务端会拒，而 403 的报错看不懂。
    # 放在落盘之后、任何远端写操作之前 —— 此时还没有建分支、没有 PATCH。
    if wf == "direct":
        _refuse_direct_if_protected(BRANCH)

    # -------- PR 子命令 --------
    if opts["prune"]:
        prune(state, grace_days=opts["stale_days"])
        return
    if opts["delete_branch"]:
        delete_branch_cmd(state, opts["delete_branch"], yes=yes)
        return
    if opts["status"]:
        show_status(state, head_sha)
        return
    if opts["close_pr"]:
        b = opts["branch"] or state.get("task_branch")
        if not b:
            raise SystemExit("--close-pr 需要 --branch <名字>，或当前已有任务分支")
        close_pr(state, b, yes=yes)
        return
    if opts["merge"]:
        n = None
        if explicit and explicit[0].isdigit():
            n = int(explicit[0])
        elif state.get("pr_number"):
            n = state["pr_number"]
        if n is None:
            # 开了多个并行 PR 时，合并完当前那个后 pr_number 就空了，
            # 第二次 --merge 会直接报错 —— 得把剩下的列出来让人挑，
            # 否则用户只能去网页上翻 PR 号。
            open_prs = _paginate("/pulls?state=open")
            open_prs = [p for p in open_prs
                        if (p.get("head") or {}).get("ref", "").startswith(TASK_PREFIX)]
            if not open_prs:
                raise SystemExit("--merge 需要 PR 号（例：--merge 42）；当前没有开启中的任务 PR")
            if len(open_prs) == 1:
                n = open_prs[0]["number"]
            else:
                print("\n开启中的任务 PR：")
                for p in open_prs:
                    print(f"  #{p['number']}  {p['head']['ref']}   {p.get('title') or ''}")
                raw = safe_input("输入要合并的 PR 号：").strip()
                if not raw.isdigit():
                    print("已取消")
                    return
                n = int(raw)
        do_merge(state, int(n), opts["method"], yes=yes)
        return

    # -------- 标记已同步（解除过期拦截）--------
    if opts["mark_synced"]:
        mark_synced(state, head_sha, rstate)
        return

    # -------- 拉取：三方合并远端改动到本地 --------
    # 必须紧接在 mark_synced 之后、P0-1 之前：合完本地就包含了远端最新，
    # 后面的过期校验才有放行依据。
    if opts["pull"]:
        # force **不传**给 pull：它在这里会被当成「忽略未解决冲突」，
        # 那是完全不同的语义（见 pull 内注释）。忽略冲突必须显式 --ignore-pending。
        pull(state, head_sha, rstate, only=explicit or None,
             ignore_pending=opts.get("ignore_pending", False))
        return

    # -------- 冲突解决 --------
    if opts["resolve"]:
        if not explicit:
            raise SystemExit("--resolve 需要至少一个文件路径")
        for f in explicit:
            rel = safe_rel(f)
            if rel is None:
                print(f"  ! 忽略越界路径：{f}")
                continue
            resolve(state, rel, head_sha, rstate)
        return

    # -------- 未解决冲突拦截（按**本次待推集合**求交集）--------
    # 带着冲突标记推送 = 把损坏文件推上去，这条不能被 --force 放行。
    #
    # 必须是交集，不能是全局拦截：原来只要 state["conflicts"] 非空就一律
    # 中止，于是 1 个文件冲突会挡住另外 15 个毫不相关的文件，连显式点名
    # `push_api.py a.txt` 也推不了 —— 清冲突是另一件事，不该阻塞当前工作。
    #
    # 【位置必须在 P0-1 之前】试过放在待推文件最终确定之后（那时集合最准），
    # 结果完全执行不到：pull 产生冲突后 synced_commit 不刷新，推送会先被
    # P0-1 拦下。所以这里用**预计算**的候选集合 —— 比最终集合少一个
    # extra（分支上残留的旧版本文件），而那些文件不会是刚冲突的文件。
    if state.get("conflicts"):
        lmap_early = local_state_map()
        pending = set(explicit) if explicit else set(
            detect_changes()) | set(baseline_changed_files(state, lmap_early))
        pending = {safe_rel(p) for p in pending} - {None}
        unresolved = [r for r in state["conflicts"] if r in pending]
        if unresolved:
            raise SystemExit(
                f"本次要推送的文件中有 {len(unresolved)} 个冲突尚未解决："
                f"{unresolved[:10]}\n"
                f"  手工改好后逐个运行：python3 push_api.py --resolve <文件>\n"
                f"  或只推送其它文件（显式点名即可绕开这些冲突文件）。\n"
                f"  （冲突文件不适用 --force-overwrite："
                f"那是覆盖远端，解决不了本地冲突）"
            )

    # 细粒度放行清单：只对这些路径网开一面，其余照旧拦。
    allowed = set()
    for f in opts["force_files"]:
        rel = safe_rel(f)
        if rel is None:
            raise SystemExit(f"--force-file 路径越出仓库范围：{f}")
        allowed.add(rel)

    # P0-1 只由**全局** --force-overwrite 放行，--force-file 不行。
    #
    # 曾经这里写成 `force or bool(allowed)`，理由是「点名即承担风险」。
    # 但 P0-1 是全局闸门而非按文件判定：它回答的是「你的本地副本是不是
    # 从最新主干改的」。用户点名 e1.txt 时，并不知道自己的副本已过期，
    # 也就无从同意「把 e2 的他人改动回退掉」—— 这个同意是无效的。
    #
    # 实测后果：--force-file e1.txt 会让本地旧版的 e2 一并进 diff，
    # GitHub 三方合并时 theirs==base、ours 变了 → 直接采纳 ours，
    # 他人对 e2 的改动被静默回退且合并成功、零报错。
    bypass = force

    # -------- 第零层：本地副本是否过期（P0-1）--------
    # 前面几层只能证明「远端没被别人改」，证明不了「本地是从最新版改的」。
    # 本地副本一旦过期（CDN 缓存的 tarball、离线包、未 pull 的旧 clone），
    # 过期的全文 + 你的改动会被整文件覆盖上去，**把远端更新的内容回退掉且不报错**。
    #
    # synced 缺失（None）与落后同等危险：那意味着从没证明过本地基于哪个版本
    # （init 时检出本地≠远端就会留空），必须拦。原来写成 `if synced and ...`
    # 会让空值悄悄跳过这层防护。
    synced = state.get("synced_commit")
    stale_local = (synced is None) or (synced != head_sha)

    # 本地 git HEAD 是否被回退过（git reset / checkout <old> / stash pop）。
    #
    # synced == head_sha 只证明「上次同步时本地包含了远端全部改动」，
    # 证明不了**现在**还是那样 —— 用户随时可以用 git 把本地文件退回旧版本，
    # 而 synced_commit 一动不动。实测：
    #     push v3 → git reset --hard HEAD~1（本地回到 v2）→ push
    #   → P0-1 放行（v3==v3）、第一层放行（远端 v3 == 基线 v3）
    #   → 本地 v2 覆盖主干，v3 静默消失，全程零报错。
    # 所以这一条必须单独查，且**在 P0-1 之后**查：P0-1 拦的是「远端前进了」，
    # 这条拦的是「本地后退了」，两者正交，都要有。
    rewound, why = _local_head_rewound(state)
    if rewound and not bypass:
        print(f"\n❌ {why}")
        print("   本地文件可能被 git 操作退回了旧版本（reset / checkout / stash pop），")
        print("   而基线仍记录着「本地已含远端最新」—— 此时推送会把主干静默回退。")
        print("\n   解除方式：")
        print("     python3 push_api.py --pull        # 重新合入远端改动（首选）")
        print("     python3 push_api.py --mark-synced # 确认本地确实已含远端全部改动")
        print("     --force-overwrite                 # 确知后果时全局放行")
        return
    if rewound and bypass:
        print(f"\n  ! {why}，--force-overwrite 已放行，存在回退远端更新的风险")

    if stale_local and not bypass:
        if synced is None:
            print("\n❌ 基线未记录本地所基于的远端版本（通常因初始化时检出本地 ≠ 远端）。")
            print("   此时推送会把远端更新整文件回退掉且不报错。")
        else:
            print(f"\n❌ 本地副本落后于远端：基线上记录本地基于 {synced[:8]}，远端现在是 {head_sha[:8]}。")
            print("   此时推送会把远端这段时间的更新整文件回退掉，且不会报错。")
        if wf == "pr":
            # PR 工作流下同样必须拦：任务分支是从**最新主干**上建的，
            # 而你的内容还是旧的 —— 相对分支基点，这等于「把主干改动改回去」，
            # GitHub 合并时会当成你故意回退，直接采纳，依旧是静默覆盖。
            # 只有双方都从同一个旧基点出发、各自改动，才是真并发，
            # 那时 GitHub 才做三方合并并明确报冲突。
            print("   任务分支基于最新主干，你的内容却是旧的：合并时会被判成「你故意回退」。")
        print("\n   解除方式（按推荐顺序）：")
        print("     python3 push_api.py --pull        # 三方合并主干改动到本地（首选）")
        print("     python3 push_api.py --mark-synced # 确认本地已含远端全部改动时，直接声明同步")
        print("       · 适用：你确认本地内容与远端一致，只是脚本记录的版本号旧了")
        print("       · 例：远端删了文件、或改动后内容又等价，--pull 会说「没有需要合并的」")
        print("       · 这两条不走通时，--pull 空转也会自动标记同步并重推即可")
        print("     --force-overwrite                 # 全局放行，会回退远端更新，仅在你确知后果时用")
        return
    if stale_local:
        print(f"\n  ! 本地副本落后/未声明（{str(synced)[:8] if synced else '未声明'} → {head_sha[:8]}），"
              f"--force-overwrite 已放行，存在回退远端更新的风险")

    lmap = local_state_map()

    # -------- 任务分支（PR 工作流）--------
    # 放在 P0-1 之后：P0-1 会拦下「本地副本落后」，被拦时不该留下空分支。
    # 每次推送都**新建**分支，基点 = 当前主干最新 —— 基点越新，PR diff 越干净，
    # 合并时三方合并的冲突面越小。--hold 是唯一的例外（攒改动，显式复用）。
    target_ref, base_sha = BRANCH, head_sha
    branch_missing = False          # 该分支在远端还不存在，需要创建
    if wf == "pr":
        branch = None
        if opts["branch"]:
            branch = opts["branch"]
            # 用主干当任务分支必须硬拦：那等于绕过 PR 流程直推主干，
            # 全部覆盖防护（第一层文件级校验在 PR 模式下是「提示」而非
            # 「拦截」）形同虚设；且 PATCH 主干失败后没有回滚路径。
            if branch == BRANCH:
                raise SystemExit(
                    f"不能用主干 {BRANCH} 当任务分支。\n"
                    f"  直推主干会绕过 PR 流程与全部覆盖防护，且失败后无法回滚。\n"
                    f"  不指定 --branch 时脚本会自动生成 {TASK_PREFIX}* 分支。")
        elif opts["hold"] and state.get("task_branch"):
            if opts["new_task"]:
                # branch 保持 None → 下面新建分支。
                # 语义：放弃当前任务分支、另起一个。默认已是「每次新建」，
                # 所以它只在 --hold 攒改动时有区别 —— 那时默认会复用旧分支。
                print(f"  · --new-task：放弃当前任务分支 "
                      f"{state.get('task_branch')}，另起一个新分支")
            else:
                branch = state["task_branch"]

        if branch is None:
            # 这一阶段只**取名**、不创建：下面若发现没有待推文件就会直接 return，
            # 那时建分支只会往远端丢一个空分支。创建推迟到确认有东西要推之后。
            for _ in range(5):
                branch = new_branch_name()
                if ref_sha(branch) is None:      # 撞名就换一个（GET，无副作用）
                    break
            else:
                raise SystemExit("连续 5 次生成的分支名都已存在，请检查远端是否有异常残留")
            branch_missing = True
            bhead = head_sha                     # 新分支的内容 = 当前主干
        else:
            bhead = ref_sha(branch)
            if bhead is None:
                branch_missing = True
                bhead = head_sha
            else:
                base_rec = (state.get("tasks") or {}).get(branch, {}).get("base_commit")
                if base_rec and base_rec != head_sha:
                    print(f"\n  ! 分支 {branch} 建在 {base_rec[:8]}，主干已到 {head_sha[:8]}")
                    print("    本次会把主干已更新的文件一并同步进分支，"
                          "避免 PR diff 出现「回退主干」的假象")
        target_ref, base_sha = branch, bhead
        if opts["new_task"] and state.get("task_branch") \
                and state["task_branch"] != branch:
            # 旧分支不再由本次流程接管：从 tasks 里摘掉，让它变成孤儿分支，
            # 由 --prune 报告并给出删除命令（比悄悄留着更可控）。
            old = state["task_branch"]
            (state.get("tasks") or {}).pop(old, None)
            print(f"  · 旧任务分支 {old} 已不再接管"
                  f"（远端仍在，可用 --prune 查看、--delete-branch 清理）")
        state["task_branch"] = branch
        print(f"任务分支 {branch} = {str(bhead)[:8]}（PR 目标 {BRANCH}）")

    # -------- 收集待推文件 --------
    # PR 工作流下要扩展为「本地 vs **分支远端**」的差异全集：
    # 只推用户改动的文件，分支里残留的旧版本会让 PR diff 显示成
    # 「把主干的改动改回去」，合并时就被当成你故意回退而直接采纳 —— 静默覆盖。
    #
    # 还要并入 baseline_changed_files()：git status 的对比基准是本地 HEAD，
    # 用户先 `git commit` 到本地之后工作区就干净了，status 什么都报不出来，
    # 改动会静默卡死（git 协议被网关拦成 403 时，用户的直觉反应就是先本地提交）。
    candidates = explicit or sorted(
        set(detect_changes()) | set(baseline_changed_files(state, lmap)))
    files, rejected, dropped = [], [], []
    unencodable = []
    for f in candidates:
        rel = safe_rel(f)
        if rel is None:
            rejected.append(f)                  # 越界 / 非法
            continue
        # GitHub API 的 payload 是 JSON，只接受 UTF-8 字符串。
        # 含 surrogate 的路径（Linux 上文件名是任意字节，可能是非法 UTF-8）
        # 到 json.dumps 那一步才会炸 —— 而那时分支已在远端建好，
        # 崩完留下没人管的僵尸分支。必须在建分支之前挑出来。
        try:
            rel.encode("utf-8")
        except UnicodeEncodeError:
            unencodable.append(rel)
            continue
        full = os.path.join(ROOT, rel)
        if os.path.isfile(full) or os.path.islink(full):
            files.append(rel)
        else:
            # 显式点名却不存在，或是目录。过去二者都被静默丢掉，
            # 打到「本地没有待推送的改动」上 —— 用户无法区分
            # 「真的没改」和「我把文件名打错了 / 我点的是目录」。
            dropped.append(f)
    if unencodable:
        show = [p.encode("utf-8", "replace").decode("utf-8", "replace")
                for p in unencodable[:5]]
        print(f"\n❌ {len(unencodable)} 个路径含非 UTF-8 字节，"
              f"无法经 API 推送，已忽略：{show}")
        print("   请把这些文件改名为 UTF-8 文件名后再推。")
    if rejected:
        print(f"\n❌ 以下路径越出仓库范围或非法，已忽略：{rejected}")
    if dropped:
        # 部分命中时也要说：点了三个文件、推上去两个，用户往往察觉不到，
        # 直到后来发现第三个文件根本没上远端。
        print(f"\n❌ 以下路径不存在或不是普通文件，已忽略：{dropped}")
        print("   检查拼写；目录需要写成目录下的具体文件。")

    if wf == "pr" and not explicit:
        brstate = remote_state_map(base_sha)

        extra, skipped_stale = [], []
        for p in brstate:
            if lmap.get(p) == brstate[p]:
                continue                    # 本地已与分支一致
            if not (os.path.isfile(os.path.join(ROOT, p))
                    or os.path.islink(os.path.join(ROOT, p))):
                continue
            # 关键：本地**没改过**、只是落后的文件，不能进 extra。
            #
            # 新分支基点就是最新主干，分支里本不可能残留旧版本 ——
            # 这里 "lmap != brstate" 其实是「本地旧」，不是「分支旧」。
            # 把它推上去，等于把主干回退成本地的旧版本；GitHub 三方合并时
            # theirs==base、ours 变了 → 直接采纳 ours，静默回退他人改动。
            # 分支保持主干内容即可，本地要更新应当走 --pull。
            if _local_matches_baseline(state, lmap, p):
                skipped_stale.append(p)
                continue
            extra.append(p)

        if skipped_stale:
            print(f"  · {len(skipped_stale)} 个文件你没改过、只是本地版本旧，"
                  f"不纳入本次推送（否则会把主干回退）")
            print(f"    需要更新本地请跑 --pull：{sorted(skipped_stale)[:5]}"
                  f"{' …' if len(skipped_stale) > 5 else ''}")
        if extra:
            # 措辞必须准确：这里同步的是「分支上仍是旧版本的文件」，
            # 目的是避免 PR diff 出现回退；**不是**把主干的更新合进你的
            # 本地工作区。旧文案说成「同步主干」，而 --hold 复用分支时
            # 根本没有这个逻辑（base 仍是分支头）—— 用户信了这句提示
            # 就不会去 --pull，直接 --merge 撞上冲突判定迷宫。
            print(f"  · {len(extra)} 个文件在分支上还是旧版本（主干已更新或首次推送），"
                  f"一并写进分支，避免 PR diff 出现回退")
            print("     注意：这**不是**把主干更新合进你的本地文件；"
                  "要让本地跟上主干请跑 --pull。")
            files = sorted(set(files) | set(extra))

    # -------- .gitignore 屏蔽文件的提示（P1）--------
    # 「点名即意图，等同 git add -f」这个语义可以辩护，但必须让人知道代价：
    # 这类文件此后**不受自动检测**——git status 被 .gitignore 屏蔽，
    # local_state_map 基于 git ls-files 也看不到它，于是后续改动会静默漏推。
    # 这与当初修的「已 commit 推不上」是同一类静默漏推。
    if files:
        # 放在 files 最终确定之后：此时才包含 extra（分支上残留的旧版本文件）。
        warn_if_filters_active(files)
    if files:
        ignored = sorted(gitignored_set(files))
        if ignored:
            print(f"\n  ! {len(ignored)} 个文件被 .gitignore 屏蔽，本地 git 不跟踪："
                  f"{ignored[:5]}{' …' if len(ignored) > 5 else ''}")
            print("    本次会推上去；但之后改动不会被自动检测到，"
                  "需要再次显式点名推送。")

    if not files:
        # 显式点名却一个都没匹配上时，必须说清楚：否则「打错文件名」
        # 和「真的没有改动」在输出上完全一样，用户只能靠猜。
        if rejected or dropped:
            print(f"\n❌ 指定的路径都不存在或不是普通文件，已忽略："
                  f"{sorted(set(rejected) | set(dropped))[:10]}")
            print("   检查拼写；目录需要写成目录下的具体文件。")
        elif unencodable:
            print("   （唯一的推送候选含非 UTF-8 字节，见上方提示。）")
        print("\n本地没有待推送的改动。")
        # git stash 之后工作区变干净，改动在 stash 里而非消失。
        # 不提示这句，用户会以为改动丢了（实测：他自己忘了 stash 过）。
        hint = _stash_hint()
        if hint:
            print(hint)
        return

    # -------- 真正创建任务分支 --------
    # 到这里才 POST：确认有东西要推，且不是 --dry-run。
    # 提前创建会让「无改动」和「预演」都在远端留下一个空分支。
    #
    # 但「有东西要推」之后到推送成功之间仍有很长的路：大文件预检、N 次建
    # blob、建 tree、建 commit、PATCH —— 任一步失败都会留下一个**空分支**，
    # 而本地状态文件的 tasks 里根本没有它（那要 PATCH 成功之后才写），
    # 用户只能靠 --prune 才发现。最典型的是改了个 12MB 文件被预检拒绝。
    #
    # 所以记住「本次是不是我们建的」，失败时补偿删掉。
    branch_created_now = None
    pushed_commit = None          # PATCH 成功前保持 None
    if wf == "pr" and branch_missing:
        if dry:
            print(f"\n  · [dry-run] 将新建任务分支 {branch}"
                  f"（基点 = {BRANCH} {head_sha[:8]}），本次不创建")
        else:
            base_sha = create_branch(branch, head_sha)
            target_ref = branch
            branch_created_now = branch
            state.setdefault("tasks", {})[branch] = {"base_commit": head_sha}
            print(f"\n  · 新建任务分支 {branch}（基点 = {BRANCH} {head_sha[:8]}）")

    risky = []

    # -------- 失败即清理：以下任一步失败都不能留下僵尸分支 --------
    # 起点在**分支创建之后**尽可能早的位置，把第一层校验和 preview 也覆盖进来。
    # preview 要拉远端 blob 做 diff，网络一抖就抛错 —— 那时分支已建、
    # 却还没 PATCH，正是最容易留下僵尸分支的地方（实测）。
    try:
        # -------- 第一层：文件级基线校验（mode + sha 一起比）--------
        # 远端某文件必须等于「我们上次推送后记下的状态」，否则说明远端
        # 被别的通道改过（别人 git push / 网页编辑 / 另一台机器）。
        # 这是防静默覆盖的关键：ref 级 force=False 管不到这种情况。
        # 比 (mode, sha) 而非只比 sha：只比 sha 会让「只改了可执行位」的变更
        # 被判为「内容已一致」而跳过，改了等于没改（T-11）。
        todo, blocked = [], []
        for rel in files:
            lmode, lsha = lmap.get(rel, ("100644", ""))
            rmode, rsha = rstate.get(rel, (None, None))
            base = state["files"].get(rel)
            # 变量名必须避开 base_sha —— 那是本次推送的 ref 基点（见第二层乐观锁），
            # 同名覆盖会让它变成「基线里记的文件 sha」，乐观锁随即误报并发并中止。
            base_mode = base.get("mode") if isinstance(base, dict) else None
            base_rec_sha = base.get("sha") if isinstance(base, dict) else base

            if (lmode, lsha) == (rmode, rsha):
                print(f"  · {rel} 已与远端一致，跳过")
                continue
            ok = force or rel in allowed
            if base is None:
                if rsha is None and not ok:
                    # 基线没记录**且远端也没这个文件** → 纯新增，不存在覆盖风险。
                    # 只有当「基线没记录、远端却有」时才真的无法确认原状态，那才要拦。
                    todo.append(rel)
                    print(f"  + {rel} 新增文件（远端不存在）")
                    continue
                if ok:
                    todo.append(rel)
                    risky.append(rel)
                    print(f"  ! {rel} 基线未记录（已放行，将整文件覆盖，远端原内容丢失）")
                else:
                    blocked.append((rel, "基线里没有这个文件、远端却已存在，无法确认远端原状态"))
                continue
            if (rmode, rsha) != (base_mode, base_rec_sha):
                if ok:
                    todo.append(rel)
                    risky.append(rel)
                    print(f"  ! {rel} 远端已被改动（已放行，将整文件覆盖）")
                else:
                    detail = f"远端 {str(rsha)[:8]}/{rmode} ≠ 基线 {str(base_rec_sha)[:8]}/{base_mode}"
                    blocked.append((rel, f"{detail}，可能被他人改动"))
                continue
            todo.append(rel)

        if blocked:
            if wf == "pr":
                # 主干这些文件动过 ≠ 不能推：推的是任务分支，GitHub 合并时才判定。
                #
                # 但「不会静默覆盖」这句话只在**本地确有改动**时成立。
                # 若本地版本 == 基线（只是落后），三方合并时 theirs==base、
                # ours 变了 → GitHub 直接采纳 ours，等于把主干回退到你的旧版本，
                # 且不会报错。这正是 P0-1 想防的情形，必须单独、明确地警告。
                # 三分类，不能只分两类。
                #
                # _local_matches_baseline() 在**基线缺失**时返回 False（保守），
                # 但调用方把 False 一律读成「本地确实改过」→ 归入 overlap
                # → 下面无条件放行。于是「基线没记录、远端却有、本地其实是
                # 旧版本」的文件会被当成你的改动推进主干，静默回退主干。
                #
                # 基线缺失必须**单独成类**：那不是「已知本地改过」，
                # 是「无法证明本地改过」。二者后果相反，不能混。
                revert, unrecorded, overlap = [], [], []
                for rel, why in blocked:
                    base = (state.get("files") or {}).get(rel)
                    if not isinstance(base, dict) or not base.get("sha"):
                        unrecorded.append((rel, why))
                    elif _local_matches_baseline(state, lmap, rel):
                        revert.append((rel, why))
                    else:
                        overlap.append((rel, why))

                if revert:
                    print(f"\n❌ 以下文件你没改过、本地仍是旧版本，"
                          f"推送后 {BRANCH} 会被**回退**到你的旧内容：")
                    for rel, why in revert:
                        print(f"   - {rel}: {why}")
                    print("\n   这不是冲突，是覆盖：GitHub 会判定「你故意回退」并直接采纳。")
                    print("   先跑 --pull 把主干改动合进本地，再推送。")
                    if not bypass:
                        raise _Cancel()
                    print("   --force-overwrite 已放行，上述文件将被回退。")

                if unrecorded:
                    print("\n❌ 以下文件基线未记录、远端却已存在，"
                          "无法判断本地是「你改过」还是「只是落后」：")
                    for rel, why in unrecorded:
                        print(f"   - {rel}: {why}")
                    print("\n   先跑 --pull 补齐基线（通常一行就好）；")
                    print("   确知本地确实改过时，用 --force-file <文件> 逐个点名放行。")
                    if not bypass:
                        # 与 revert 同级处理：证明不了「本地改过」就不能放行，
                        # 否则就是拿主干冒险。bypass 时给出明确警告。
                        raise _Cancel()
                    print("   已放行，将按本地内容覆盖（无法排除是回退）。")

                if overlap:
                    print(f"\n  ! 以下文件在 {BRANCH} 上已有新改动，但你本地也改过"
                          f"（合并时可能冲突，不会静默覆盖）：")
                    for rel, why in overlap:
                        print(f"   - {rel}: {why}")
                    print("   建议先跑 --pull 把主干改动合进本地，PR 会干净很多。")

                # 只有「本地也改过」的才放行；回退类的已在上一步拦下或明确警告。
                for rel, _ in overlap:
                    todo.append(rel)
            else:
                print("\n❌ 以下文件可能覆盖他人改动，已中止：")
                for rel, why in blocked:
                    print(f"   - {rel}: {why}")
                print("\n   正确做法：python3 push_api.py --pull        # 三方合并远端改动到本地")
                print("   确知要覆盖某个文件时，用细粒度放行（别用全局 --force-overwrite），")
                print("   并显式列出要推的文件（否则其它被拦的文件会一并中止本次推送）：")
                print("     python3 push_api.py --force-file 可疑文件 要推的文件")
                raise _Cancel()

        if not todo:
            print("\n没有需要推送的内容。")
            raise _Cancel()

        # 放行的必须显式再确认一次：--force-overwrite 是全局开关，
        # 一行参数就把「可能覆盖他人改动」的文件全放过去，代价太大。
        if risky and not yes:
            print(f"\n⚠️  以下 {len(risky)} 个文件将**整文件覆盖**远端内容（远端原版本不可恢复）：")
            for rel in risky:
                print(f"   - {rel}")
            ans = safe_input("确认用本地内容覆盖远端？输入 y 继续 (y/N) ").strip()
            if ans.lower() != "y":
                print("已取消（未推送）")
                raise _Cancel()

        # -------- 远端已前进的整体提示 --------
        prev = state.get("base_commit")
        if prev and prev != head_sha:
            print(f"\n⚠️  远端自上次推送后已前进（基线 {prev[:8]} → 现在 {head_sha[:8]}），可能含他人提交。")
            print("   本次只覆盖下面校验通过的文件，其余文件保持远端原样。")

        # -------- 预览 --------
        preview(todo, rstate, lmap)

        # -------- 大文件预检 --------
        # 放在 dry-run **之前**：预演的意义就是提前暴露这种阻塞性错误，
        # 排在后面会导致「--dry-run 一切正常，真推时才报 12MB 超限」。
        # dry-run 时只警告不中止，让预演能继续走完流程。
        oversize = []
        for rel in todo:
            # 必须兜住 OSError：仓库里可以有指向不存在目标的符号链接
            # （git 允许提交这种 blob），os.path.getsize 会抛 FileNotFoundError。
            # 预览那里（见 preview）已经兜了，这里漏了就会裸 traceback，
            # 而且此时 blob 已建、分支已建、状态未落盘 —— 留下脏远端状态。
            # symlink 用 lstat：要的是链接自身长度，不是跟随后的目标大小。
            full = os.path.join(ROOT, rel)
            try:
                size = (os.lstat(full).st_size if os.path.islink(full)
                        else os.path.getsize(full))
            except OSError:
                size = 0
            if size > MAX_BLOB_BYTES:
                oversize.append((rel, size))
        if oversize:
            for rel, size in oversize:
                print(f"\n❌ {rel} 有 {size / 1024 / 1024:.1f} MB，超过 "
                      f"{MAX_BLOB_BYTES // 1024 // 1024} MB 上限。"
                      f"base64 后还会再膨胀约 33%，容易超时/被拒。请改走 Git LFS。")
            if not dry:
                raise SystemExit(f"{len(oversize)} 个文件超过大小上限，已中止")

        # -------- 提交信息 --------
        # 原来复用 `git log -1`，但推送成功后本脚本会在本地补一个同信息的 commit，
        # 导致从第二次起 log -1 永远拿到同一条 → 所有推送共用同一个提交信息。
        msg = opts["msg"]
        if msg is None and not yes:
            msg = safe_input(f"提交信息（单行，留空则用「{default_msg(todo)}」）：\n> ").strip()
        if not msg:
            msg = default_msg(todo)
        if not opts["msg"]:
            print(f"提交信息：{msg}")

        if dry:
            print("\n[dry-run] 未做任何推送")
            raise _Cancel()
        if not yes:
            ans = safe_input(f"\n推送到 {OWNER}/{REPO}@{target_ref}？(y/N) ").strip().lower()
            if ans != "y":
                print("已取消")
                raise _Cancel()

        # -------- 第二层：ref 乐观锁（分两遍，各司其职）--------
        #
        # 只查一遍是不够的：建对象（尤其大文件建 blob）可能耗时几十秒，
        # 那才是真正的并发窗口。若锁只放在建对象**之前**，窗口完全没盖住 ——
        # 改动虽仍不丢（PATCH force=False 会挡住非快进，fail-safe），
        # 但报错变成 GitHub 的 422 原文 "not fast-forward"，
        # 用户只会往权限/设置上猜，不知道该去 --pull。
        #
        # 第一遍（建对象前）：早失败，省掉几十秒的大文件上传。
        #   新分支尚未创建时 target_ref 不存在，此时要查主干 ——
        #   新分支的基点就是主干，要确认的正是「主干没前进」。
        lock_ref = BRANCH if branch_missing else target_ref
        _recheck_ref(lock_ref, base_sha, "开始建对象前")

        # -------- 建对象 --------
        entries = []
        for rel in todo:
            mode = lmap.get(rel, ("100644", ""))[0]
            full = os.path.join(ROOT, rel)
            if mode == "120000":                      # symlink：blob 内容是目标路径
                raw = os.readlink(full).encode()
            else:
                with open(full, "rb") as f:
                    raw = f.read()
            blob = api("POST", "/git/blobs",
                       {"content": base64.b64encode(raw).decode(), "encoding": "base64"},
                       timeout=_timeout_for(len(raw)))
            if "sha" not in blob:
                raise SystemExit(f"创建 blob 失败 {rel}: {json.dumps(blob)[:300]}")
            # mode 必须跟着走，否则 .sh / 二进制推上去就丢了可执行位。
            entries.append({"path": rel, "mode": mode, "type": "blob", "sha": blob["sha"]})
            print(f"  blob {rel} ({mode})")

        tree = api("POST", "/git/trees", {"base_tree": base_sha, "tree": entries})
        if "sha" not in tree:
            raise SystemExit(f"创建 tree 失败: {json.dumps(tree)[:300]}")

        commit = api("POST", "/git/commits", {"message": msg, "tree": tree["sha"], "parents": [base_sha]})
        pushed_commit = commit.get("sha")
        if "sha" not in commit:
            raise SystemExit(f"创建 commit 失败: {json.dumps(commit)[:300]}")

        # -------- 第三层：PATCH 用 force=False，非快进由 GitHub 拒绝 --------
        # 第二遍 ref 检查：覆盖建对象期间的并发窗口（真正的窗口在这里）。
        _recheck_ref(target_ref, base_sha, "建对象完成后")

        upd = api("PATCH", _ref_path(target_ref), {"sha": commit["sha"], "force": False})
        if not isinstance(upd, dict) or "object" not in upd:
            # 结构不符 ≠ 推送失败。此时 PATCH 已返回 2xx，分支很可能已经
            # 更新成功，只是响应格式与预期不同（GitHub 改结构、代理改写等）。
            # 直接报「失败」会让用户在推送其实已生效的情况下重推。
            print("  ! 无法确认 ref 更新结果（响应结构异常），"
                  "请用 --status 核实远端状态后再决定是否重推。")
        elif upd.get("object", {}).get("sha") != commit["sha"]:
            raise SystemExit(f"更新 ref 失败（可能非快进）: {json.dumps(upd, ensure_ascii=False)[:300]}")

        # 本地也落一个提交，让工作区重回干净（下次 detect_changes 才准）。
        # 注意：本地历史与远端历史并无父子关系，纯粹当快照基线用。
        # 只提交 todo 这些路径，避免把别人先前 git add 进暂存区的文件一起卷进来。
        #
        # 这两步也要在 try 内：PATCH 成功后分支上就有内容了，此时中断
        # （Ctrl-C 最容易发生在这里 —— 大文件刚传完）会留下一个**有内容
        # 但没人知道**的孤儿分支。报告第 8 轮实测确认过这个残留点。
        _git_add_paths(todo)
        if git("diff", "--cached", "--name-only", "--", *todo):
            git("-c", "user.name=yuanbao", "-c", "user.email=yuanbao@users.noreply.github.com",
                "commit", "-q", "-m", msg, "--", *todo)
            # 与 _write_local 对齐：提交后工作区变干净，缓存必须失效。
            # 不清的话靠的是「调用顺序恰好正确」这种隐式依赖，
            # 重构时极易踩（_write_local 那处就是显式清的）。
            global _CHANGES_CACHE
            _CHANGES_CACHE = None

    # 清理范围**停在「开 PR」之前**是有意的：PR 一旦建出来就有编号、
    # 能被 --prune 看见、也能 --merge 继续 —— 那时该做的是提示用户，
    # 而不是悄悄删掉。
    except _Cancel:
        # 正常取消：与失败走同一条清理通道，但**不**冒泡成错误。
        # 顺序必须在 except BaseException 之前，否则 _Cancel 会被它先接走。
        _cleanup_failed_branch(branch_created_now, head_sha, pushed_commit)
        return
    except BaseException:
        _cleanup_failed_branch(branch_created_now, head_sha, pushed_commit)
        raise

    # -------- PR 工作流：开 PR → 自动合并 → 删分支 --------
    if wf == "pr":
        # 推到分支时主干尚未改变：base_commit / synced_commit 都要记**主干**，
        # 不能记分支上的 commit（旧版记 commit["sha"]，于是 P0-1 拿它与主干
        # head_sha 比较，必然不等 → 把刚推完的用户又挡在门外）。
        # 本地确实是「主干 head_sha 的内容 + 已推到分支的改动」，记主干才准确。
        #
        # 但**基线 files 不能**记成本次推送的内容：它的语义是「远端该文件的版本」，
        # 而这里远端还是旧主干。记成推送内容后，--pull 会看到
        # local == base 而判定「本地无改动」，直接用主干（他人的）版本覆盖本地，
        # 把你刚推到分支的改动静默抹掉 —— regression 实测过。
        # 正确时机是 --merge 成功之后，见 do_merge 里的 _refresh_main_baseline。
        state["base_commit"] = head_sha
        state["synced_commit"] = head_sha
        state["local_head"] = _local_head()

        # -------- P1-9：分支已 PATCH 上内容，先把状态落盘 --------
        # ensure_pr 在这之后才跑。若它失败而此处尚未落盘，state 里既没有
        # base_commit/synced_commit、也没有 tasks[branch]，于是：
        #   · 下次推送会被 P0-1 重新拦下一个「其实已经推到分支上」的改动
        #   · 用户完全不知道分支上已经有内容
        # 所以先把「已同步」和任务登记写盘，再去做开 PR 这件可能失败的事。
        state["workflow"] = "pr"
        (state.setdefault("tasks", {}).setdefault(target_ref, {})
         ).update({"last_push": _now(),
                   # 记下分支 head：abandon_task 删分支前据此判断
                   # 「分支上是否有别人后来推的改动」（B5）。
                   "head": ref_sha(target_ref),
                   # 记下本次推到分支的内容：--merge 成功后据此判断
                   # 「主干上这个版本就是我推的」，从而安全地刷新基线。
                   "pushed": {rel: entries[i]["sha"]
                              for i, rel in enumerate(todo)}})
        save_state(state)

        # -------- P1-8：开 PR 失败 → 有内容、无 PR 的分支 --------
        # 分支已建且已 PATCH 上 commit。若开 PR 这步失败（网络抖动 / 422），
        # 远端留下的是**装着本次全部改动**的分支，而 --prune 会把它判成
        # 「孤儿分支」并建议 --delete-branch —— 工具引导用户删掉自己的东西。
        # 所以这里不能静默，也不能沿用「失败即清理」（那会删掉有内容的分支）。
        try:
            pr, _ = ensure_pr(target_ref, msg)
        except BaseException:
            print(f"\n⚠ 分支 {target_ref} 上已成功推入本次改动，"
                  f"但开 PR 失败。")
            print("  改动没丢，仍在分支上。请这样继续：")
            print(f"     python3 push_api.py --branch {target_ref} -m \"{msg}\"")
            print(f"  ⚠ 不要 --delete-branch {target_ref}（那会删掉本次改动）。")
            raise
        state["pr_number"] = pr["number"]
        (state.setdefault("tasks", {}).setdefault(target_ref, {})
         ).update({"pr": pr["number"]})
        save_state(state)
        print(f"\n✅ 已推送到 {target_ref}（{commit['sha'][:8]}）")
        print(f"   PR #{pr['number']}: {pr.get('html_url') or pr.get('url')}")

        if opts["hold"]:
            print("\n   --hold：分支与 PR 已保留，未合并。攒够改动后：")
            print("     python3 push_api.py --merge")
            return

        # 推送即合并：冲突时 GitHub 返回 409，改动不会丢（还在本地工作区），
        # 所以可以安全地把分支和 PR 一起收掉，不留僵尸。
        if do_merge(state, pr["number"], opts["method"], yes=True, quiet=True,
                    keep_on_conflict=opts["keep_on_conflict"]):
            print(f"✅ 已合并进 {BRANCH} 并删除分支 {target_ref}")
        return

    # -------- 更新基线（仅 direct 模式；PR 模式在 merge 成功后刷新）--------
    for i, rel in enumerate(todo):
        state["files"][rel] = {"mode": entries[i]["mode"], "sha": entries[i]["sha"]}

    # 非本次推送、但远端已经变了的文件：只在「本地也已经是远端版本」时刷新基线。
    #
    # 无条件刷新的话（旧版行为）会把「本地落后于远端」这个事实抹掉：
    # 下次再推动该文件，第一层看到 远端 == 基线 就放行，本地旧内容 + 你的改动
    # 会整文件覆盖上去；同时 --pull 也认为「远端没变」不再处理，彻底锁死。
    # 不刷新则保持 fail-closed：第一层拦住 → 提示 --pull → 合并后自然解锁。
    refreshed = []
    lagging = []
    for p, (rmode, rsha) in rstate.items():
        if p in todo:
            continue
        cur = state["files"].get(p)
        if not isinstance(cur, dict) or cur.get("sha") == rsha:
            continue
        if lmap.get(p) == (rmode, rsha):
            state["files"][p] = {"mode": rmode, "sha": rsha}
            refreshed.append(p)
        else:
            lagging.append(p)

    state["base_commit"] = commit["sha"]
    state["synced_commit"] = commit["sha"]     # 推送后本地即远端最新
    state["local_head"] = _local_head()
    save_state(state)

    if refreshed:
        print(f"\n  · {len(refreshed)} 个非本次推送的文件远端已更新，本地已是同一版本，基线已跟进")
    if lagging:
        print(f"\n⚠️  {len(lagging)} 个文件本地落后于远端（基线**未**刷新，推它们会覆盖远端）：")
        for p in lagging[:20]:
            print(f"   - {p}")
        if len(lagging) > 20:
            print(f"   … 其余 {len(lagging) - 20} 个")
        print("   改这些文件前请先：python3 push_api.py --pull")

    print(f"\n✅ 已推送 https://github.com/{OWNER}/{REPO}/commit/{commit['sha']}")
    print(f"   基线已同步（{STATE_PATH}），本地已补提交 {git('log', '-1', '--format=%h')}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        # 中断是正常操作，不该甩一堆堆栈。
        # 但要提醒一句：远端可能已有本次推送的内容 —— 分支由
        # _cleanup_failed_branch 负责清理，本地改动一直在工作区。
        print("\n\n已中断（Ctrl-C）。本地改动未丢失；"
              "若中断发生在推送之后，跑 --prune 可查看残留分支。")
        sys.exit(130)
    except EOFError:
        # 非交互环境（CI / 管道）里 input() 直接抛 EOFError。
        # 没有这个兜底，用户看到的是裸 traceback 而不是「请加 --yes」。
        print("\n输入已关闭（非交互环境），无法等待确认。"
              "请加 --yes 或 -y 跳过交互。")
        sys.exit(1)
