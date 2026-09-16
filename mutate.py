#!/usr/bin/env python3
"""变异测试：往 push_api.py 里注入已知回归，看测试套件抓不抓得到。

用途和普通测试相反 —— 测试证明「代码能工作」，变异测试证明
「测试真的能发现问题」。一个从没失败过的测试套件，可能只是没测到点上。

三类结果：
  KILLED     注入后测试变红 → 这套测试确实守住了这个逻辑
  SURVIVED  注入后仍然全绿 → 真盲区，需要补测试
  NOT_APPLIED 替换没生效   → 空变异（见下），是 mutate.py 自身的配置问题

关于「空变异」（报告里的重点）：
  变异体在源码里根本不存在（函数改名后忘了同步、缩进对不上），
  于是替换不生效、文件没变，测试当然全绿 —— 这不是测试盲区，
  是 mutate.py 在自欺欺人。必须显式识别出来，否则会花时间去
  「补测试」一个根本没被测到的位置。

关于单实例锁（报告里的重点）：
  所有 test_*.py 都用 /dev/shm 下的**固定**路径（test_pr_flow 用
  /dev/shm/_pr_repo 等）。两个进程同时跑，会互相 rmtree 对方的仓库、
  unlink 对方的状态文件，表现为随机失败 + 基线不绿。
  本工具全程串行，并持有一把全局锁，避免与外部正在跑的测试抢路径。

用法：
  python3 mutate.py                    # 跑全部变异
  python3 mutate.py --only p01,token   # 只跑指定变异
  python3 mutate.py --list             # 列出所有变异
  python3 mutate.py --keep             # 保留变异后的源码供人工检查
"""
import argparse
import contextlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "push_api.py")
LOCK_PATH = "/tmp/mutate.lock"

# 测试套件：自动发现，不写死。
# 手写列表会漏配 —— 报告里「三个变异未被捕获」正是漏了 test_hardening.py
# 这类后加的套件。自动发现保证新增套件立刻纳入。
def discover_tests():
    names = []
    for fn in sorted(os.listdir(HERE)):
        if fn.startswith("test_") and fn.endswith(".py"):
            names.append(fn)
    return names


# ---------------------------------------------------------------- 变异定义
# 每条都对应一个**真实修过**的缺陷，注入它等于把代码退回修复前。
# old 必须能在当前源码里唯一匹配到，否则判定 NOT_APPLIED。

MUTATIONS = [
    # ---- P0：覆盖防护 ----
    dict(id="p01_force_file_bypass",
         desc="P0-1：--force-file 放行整层「本地副本过期」检查",
         old="    bypass = force\n",
         new="    bypass = force or bool(allowed)\n"),

    dict(id="p01_extra_stale",
         desc="P0-1：把「本地没改过、只是旧」的文件也纳入推送（回退主干）",
         old="            if _local_matches_baseline(state, lmap, p):\n"
             "                skipped_stale.append(p)\n"
             "                continue\n",
         new="            if False:\n"
             "                skipped_stale.append(p)\n"
             "                continue\n"),

    dict(id="ref_force_true",
         desc="第三层：PATCH 用 force=True（非快进不再被 GitHub 拒绝）",
         old='{"sha": commit["sha"], "force": False}',
         new='{"sha": commit["sha"], "force": True}'),

    # ---- 安全 ----
    # 注意：这条曾长期是**空变异** —— old 串还对着第一版「所有可打印
    # ASCII」白名单，而源码早已收紧到 [A-Za-z0-9_.-]，于是 token 注入
    # 防线从未被变异验证过：测试在守一堵已经不存在的墙。
    # 改对之后才是真防线：把白名单放宽回「所有可打印 ASCII」，即可验出
    # test_security_data.token_whitelist_strictness 是否真能拦住 `"` `\`
    # 反引号 `$()` 这些能提前闭合 curl 配置 header 引号的字符。
    dict(id="token_whitelist",
         desc="token 白名单放宽回「所有可打印 ASCII」→ 放行引号/反斜杠，"
              "可提前闭合 curl 配置的 header 引号",
         old='    if not re.fullmatch(r"[A-Za-z0-9_.-]+", TOKEN or ""):',
         new='    if not re.fullmatch(r"[\\x21-\\x7E]+", TOKEN or ""):'),

    # ---- v4 报告：P0-10（一行解两个 P0）----
    dict(id="v4_no_baseline_refresh",
         desc="P0-10：pull「远端无变化」不刷新基线 → direct 死锁 "
              "+ PR 静默回退主干（同一个根因）",
         old='            if (state["files"].get(rel) or {}).get("sha") != rsha:\n'
             '                state["files"][rel] = {"mode": rmode, "sha": rsha}\n',
         new=""),

    dict(id="v4_generator_exhaust",
         desc="P0-5：preview 不物化生成器 → 删除行恒 0，"
              "推送前最后一道人工确认失真",
         old="        d = list(difflib.unified_diff(old, new, n=0))",
         new="        d = difflib.unified_diff(old, new, n=0)"),

    dict(id="v4_no_dry_gate",
         desc="P0-11：--dry-run 不拦子命令（--delete-branch 会真删远端分支，"
              "不可逆）",
         old='    if dry:\n        MUTATING = ("init", "reset", "mark_synced", "pull", "resolve",\n'
             '                    "merge", "close_pr", "delete_branch")',
         new="    if False:\n        MUTATING = ()"),

    dict(id="v4_delete_main_allowed",
         desc="P0-6：--delete-branch 无白名单，可删除主干",
         old='    if branch == BRANCH:\n        raise SystemExit(\n            f"拒绝删除主干分支 {BRANCH}。',
         new='    if False:\n        raise SystemExit(\n            f"拒绝删除主干分支 {BRANCH}。'),

    dict(id="v4_branch_main_allowed",
         desc="P0-7：-b main 可绕过 PR 流程直推主干",
         old='            if branch == BRANCH:\n                raise SystemExit(\n                    f"不能用主干 {BRANCH} 当任务分支。',
         new='            if False:\n                raise SystemExit(\n                    f"不能用主干 {BRANCH} 当任务分支。'),

    dict(id="v4_symlink_encode_crash",
         desc="P0-4：symlink 目标非 UTF-8 时崩溃",
         old='        raw = os.readlink(full).encode("utf-8", "surrogateescape")',
         new="        raw = os.readlink(full)"),

    # ---- v4 报告：批次 2（P1-18 / P1-20 / P1-21）----
    dict(id="v4_save_state_valueerror",
         desc="P1-18：save_state 不兜 ValueError → surrogate 路径崩溃在推送之后",
         old="    except (TypeError, ValueError, RecursionError) as e:",
         new="    except TypeError as e:"),

    # 注意：这条也曾长期是**空变异** —— old 串里用的是旧变量名 `target`，
    # 而源码改名为 `_check`（校验用 strip 后的值、落盘保留原字节）后未同步，
    # 于是 P1-21（远端可让软链指向仓库外）这条防线从未被变异验证。
    # 现在 old 串直接取自 push_api.py 当前实现，并逐字对齐 _inside_root() 判据。
    dict(id="v4_symlink_target_unchecked",
         desc="P1-21：symlink 目标不校验 → 远端可让软链指向仓库外。"
              "注意必须移除**整块**（isabs + _inside_root 两道）："
              "只去掉 isabs，realpath 仍会兜住，属于无效变异。",
         old='        if os.path.isabs(_check):\n            raise SystemExit(\n                f"{rel} 是符号链接，目标 {_check!r} 是绝对路径，拒绝创建。\\n"\n                f"  仓库内不应出现指向绝对位置的软链；请确认远端内容是否可信。")\n        # 相对目标：解析后必须仍在仓库内。\n        # 判据走 _inside_root()（基准 = realpath(ROOT)），与 safe_rel 同源：\n        # 早先这里直接拿裸 ROOT 比，仓库根是软链时会被判成越界而 SystemExit，\n        # 中断整个 --pull（实测复现）。\n        resolved = os.path.realpath(os.path.join(os.path.dirname(full), _check))\n        if not _inside_root(resolved):\n            raise SystemExit(\n                f"{rel} 是符号链接，目标 {_check!r} 解析后指向仓库外：{resolved}\\n"\n                f"  拒绝创建（防止路径穿越）。")\n        os.symlink(target, full)\n',
         new=r"""        os.symlink(target, full)
        return"""),

    # ---- v4 报告：P0-3 / P2-22~26 ----
    dict(id="v4_hash_object_with_filters",
         desc="P0-3：hash-object 不加 --no-filters → 应用 clean filter，"
              "sha 与上传的原始字节不一致，永久误报「远端被他人改动」",
         old='    return git("hash-object", "--no-filters", rel)',
         new='    return git("hash-object", rel)'),

    dict(id="v4_days_since_positive_only",
         desc="P2-24：_days_since 只剥 + 偏移 → 负时区解析失败返回 None，"
              "陈旧分支静默归入「无需处理」",
         old='    s = re.sub(r"[+-]\d{2}:?\d{2}$", "", s).split(".")[0].strip()',
         new='    s = s.split("+")[0].split(".")[0]'),

    dict(id="v4_ref_path_encodes_slash",
         desc="P2-23 反向：把 / 也编码 → 所有 task/* 分支 404"
              "（safe 必须是 / 而非空）",
         old='    return "/git/refs/heads/" + quote(ref, safe="/")',
         new='    return "/git/refs/heads/" + quote(ref, safe="")'),

    dict(id="v4_ref_path_no_encoding",
         desc="P2-23：分支名不编码 → 含 ? # 的分支名会截断 URL",
         old='    return "/git/refs/heads/" + quote(ref, safe="/")',
         new='    return f"/git/refs/heads/{ref}"'),

    dict(id="v4_no_help",
         desc="P2-25：没有 --help，打错参数只能去翻源码",
         old='        if a in ("--help", "-h"):',
         new='        if a in ("--__nope__",):'),

    # ---- v4 报告后半（6.3 之后）----
    dict(id="v4_find_pr_returns_first",
         desc="P1-19：find_pr 返回第一个匹配 → 拿到已合并的旧 PR，"
              "报「未合并，删除会丢改动」，方向反了",
         old='    for p in matches:\n        if p.get("state") == "open":\n            return p\n    return matches[-1]',
         new="    return matches[0]"),

    dict(id="v4_exec_bit_not_reset",
         desc="P1-13：写非执行文件不回退权限位 → 与 pull 永久打架，"
              "「可执行→不可执行」的远端变更永远同步不完",
         old='        try:\n            os.chmod(full, 0o644)\n        except OSError:\n            pass                      # 权限改不动不该阻断写入',
         new="        pass"),

    dict(id="v4_clock_skew_hidden",
         desc="P1-17：时钟不一致被静默归入「无需处理」"
              "（注意：max(0,d) 也不行，必须让负值显形）",
         old='            if d is not None and d < 0:\n                skewed.append((name, pr["number"], d))',
         new="            pass"),

    dict(id="v4_resolve_no_membership",
         desc="P1-4：--resolve 不校验成员资格 → 对无关文件声明"
              "「本地已含远端最新」，无凭无据解除 P0-1 闸门",
         old='    if rel not in (state.get("conflicts") or []):',
         new="    if False:"),

    dict(id="v4_git_reset_undetected",
         desc="§7.4：git reset --hard 后推送不拦 → 本地旧版本静默回退主干"
              "（报告自己都没展开的推论，实测可复现）",
         old="    rewound, why = _local_head_rewound(state)",
         new="    rewound, why = False, None"),

    # ---- P1-1：merge 失败判据改用权威字段 ----
    dict(id="v4_merge_strmatch_only",
         desc="P1-1：合并被拒原因退回字符串匹配 → dirty/behind 同为 409，措辞一变就误判",
         old=r"""        if mstate:
            s = mstate.lower()
            if s == "dirty":
                return None, "conflict"
            if s in ("behind", "blocked", "unstable", "draft"):
                # behind  = 分支不够新（重新基于最新主干推一次即可）
                # blocked = 保护规则挡住（需 review / 状态检查）
                # 这两类都不是内容冲突，不该引导人去手工解冲突
                return None, "need_update"
""",
         new="        if False:\n            pass\n"),

    dict(id="v4_mergeable_no_poll",
         desc="P1-1：mergeable 为 None（异步未算出）时不轮询 → 被当成 falsy，一律判 conflict",
         old="        if mergeable is not None:\n            break\n        # mergeable 还没算出来：触发一次计算并等待\n        if i + 1 < tries:\n            time.sleep(delay * (2 ** i))     # 1s, 2s, 4s",
         new="        break"),

    # ---- 补充描述批次：P1-5 / P1-8 / P1-10 / P1-12 / P1-16 / P2-19 / P3 ----
    # 注：P1-5 有意做了**两道防线**（启动时 require_git_repo + 读取路径
    # fatal=True），只拆其中一道时另一道会兜住，变异必然存活 —— 那是
    # 纵深防御生效，不是测试盲区，故不作为独立变异注册。
    # 端到端行为由 test_v4_fixes.git_broken_not_silent_no_changes 守着。

    dict(id="v5_fetch_fail_as_conflict",
         desc="P1-10：拉取远端失败被归为冲突 → 污染 conflicts，"
              "逼用户对网络抖动做「冲突解决」",
         old="            failed.append(rel)",
         new="            conflicted.append(rel)"),

    dict(id="v5_symlink_preview_prefix",
         desc="P1-16：_local_lines 给 symlink 加 '-> ' 前缀 → "
              "预览恒显示 +1/-1，最后一道人工确认失真",
         old='        return [os.readlink(full)]',
         new='        return [f"-> {os.readlink(full)}"]'),

    dict(id="v5_no_pagination",
         desc="P1-12：列表不翻页 → --prune 漏报，给出「很干净」的错误安全感",
         old='    return _paginate("/branches")',
         new='    return api("GET", "/branches?per_page=100") or []'),

    dict(id="v5_exec_bit_zero_samples",
         desc="P2-19：零样本时宣称「可执行位探测可靠」→ "
              "整个仓库权限位静默翻转",
         old="        return False\n    if samples:\n        flagged",
         new="        return True\n    if samples:\n        flagged"),

    dict(id="v5_version_bool_accepted",
         desc="P3-2：bool 是 int 子类，version: true 通过校验",
         old='    chk("version", int, optional=True, exact=True)',
         new='    chk("version", int, optional=True)'),

    dict(id="v5_reset_loses_workflow",
         desc="P3-8：--reset-baseline 把 --direct 用户静默改回 PR 工作流",
         old='"workflow": (prev_workflow if prev_workflow else DEFAULT_WORKFLOW),',
         new='"workflow": DEFAULT_WORKFLOW,'),

    # ---- P2-16：非交互环境 EOF 保护 ----
    # 注意：这个变异是「把 9 处调用点全部退回 input」，必须整体回退。
    # 只回退一处的变异会 SURVIVED —— 顶层 EOFError 兜底会把 traceback
    # 换成人话，而「流程已中断」这一点在单点上不易断言。
    dict(id="v5_input_no_eof_guard",
         desc="P2-16：9 处 input() 无 EOF 保护 → CI/管道下裸 EOFError 中断流程",
         multi=True,
         pairs=[("safe_input(", "input(")],
         skip_def="def safe_input"),

    # ---- P2 第二批 ----
    dict(id="v6_direct_no_persist",
         desc="P2-20：--direct 不落盘 workflow → 用户每次都得手动加，"
              "且 --reset-baseline 后被静默改回 PR",
         old='    if opts["direct"] and state.get("workflow") != "direct":\n'
             '        state["workflow"] = "direct"\n        save_state(state)',
         new="    pass"),

    dict(id="v6_now_local_time",
         desc="P2-21：_now 写本地时间 → 与 _days_since 的 UTC 口径混用，"
              "非 UTC 环境下 --prune 的宽限判定偏移",
         old='    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())',
         new='    return time.strftime("%Y-%m-%dT%H:%M:%SZ")'),

    dict(id="v6_merge_ignores_response_sha",
         desc="P2-14：合并后不用 merge 响应的 sha → "
              "GitHub ref 更新延迟时拿到旧 head，误判远端又前进了",
         old='    merged_sha = (r or {}).get("sha") or ref_sha(BRANCH)',
         new='    merged_sha = ref_sha(BRANCH)'),

    dict(id="v6_lock_world_readable",
         desc="P2-05：锁文件 0644 → 同机其他用户可推测仓库布局",
         old="os.O_CREAT | os.O_RDWR, 0o600)",
         new="os.O_CREAT | os.O_RDWR, 0o644)"),

    dict(id="v6_main_new_file_lagging",
         desc="P2-13：主干新增文件被判 lagging → 刚合并成功就被 P0-1 拦",
         old='        if p not in lmap:\n'
             '            # 本地根本没有这个文件 → 是**主干新增**，不是「本地落后」。',
         new='        if False:\n'
             '            # 本地根本没有这个文件 → 是**主干新增**，不是「本地落后」。'),

    # ---- P2 第二批（02/04/18）----
    # P2-06 有意**不注册变异**：实测两处 exists/lexists 当前等价
    # （前置的 islink 预删已处理悬空软链），回退后测试仍全绿 ——
    # 注册它只会得到一个恒 SURVIVED 的假信号。其真实防线由
    # write_local_handles_dangling_symlink 守着（守的是 islink 预删那行）。
    dict(id="v6_no_rate_limit_dump",
         desc="P2-02：不 dump 响应头 → 限流时只能给「等几分钟」的模糊提示",
         old='                "-D", hdrf.name,               # 响应头 → 文件',
         new="                # (无 -D)"),

    dict(id="v6_no_api_version_header",
         desc="P2-02：不带 X-GitHub-Api-Version → GitHub 会持续告警",
         old='                "-H", "X-GitHub-Api-Version: 2022-11-28",',
         new="                # (无 Api-Version)"),

    dict(id="v6_429_fixed_backoff",
         desc="P2-02：429 退避不用 Retry-After → 远低于 GitHub 建议，硬撞限流",
         old='                wait = 2 ** attempt\n'
             '                if code == "429":\n'
             '                    ra = _hdr_info.get("retry-after")\n'
             '                    if ra and ra.isdigit():\n'
             '                        wait = max(wait, min(int(ra), 60))',
         new="                wait = 2 ** attempt"),

    dict(id="v6_last_push_dead_field",
         desc="P2-18：last_push 只写不读 → 死字段误导后来者",
         old='            pushed = ((state.get("tasks") or {}).get(name) or {}).get("last_push")',
         new="            pushed = None"),

    # ---- 报告 A 补漏 ----
    dict(id="a_pull_mode_only_judge_by_sha",
         desc="A-P1-2①：pull 待合并判据只比 sha → "
              "远端只改权限位时判成『远端没变』，本地权限位永远拉不下来",
         old='                      and (p not in lmap\n'
             '                           or ((state["files"].get(p) or {}).get("mode"),\n'
             '                               (state["files"].get(p) or {}).get("sha"))\n'
             '                           != rstate[p]))',
         new='                      and (p not in lmap\n'
             '                           or (state["files"].get(p) or {}).get("sha")\n'
             '                           != rstate[p][1]))'),

    dict(id="a_pull_mode_only_no_chmod",
         desc="A-P1-2②：local==remote 只改基线不 chmod 本地 → "
              "基线说 644、本地实际 755，两边永久打架",
         old='            cur_mode = (lmap.get(rel) or ("100644", ""))[0]\n'
             '            if cur_mode != rmode:\n'
             '                _write_local(rel, remote, rmode)\n'
             '                print(f"  = {rel} 内容一致，仅权限位 {cur_mode} → {rmode}")',
         new='            cur_mode = rmode'),

    dict(id="a_conflict_block_global",
         desc="A-P1-5：冲突拦截改回全局 → 1 个冲突挡住其他所有文件",
         old='        unresolved = [r for r in state["conflicts"] if r in pending]',
         new='        unresolved = list(state["conflicts"])'),

    # ---- 报告 A 补漏 ----
    dict(id="a_pull_mode_only_judge_by_sha",
         desc="A-P1-2①：pull 待合并判据只比 sha → "
              "远端只改权限位时判成『远端没变』，本地权限位永远拉不下来",
         old='                      and (p not in lmap\n'
             '                           or ((state["files"].get(p) or {}).get("mode"),\n'
             '                               (state["files"].get(p) or {}).get("sha"))\n'
             '                           != rstate[p]))',
         new='                      and (p not in lmap\n'
             '                           or (state["files"].get(p) or {}).get("sha")\n'
             '                           != rstate[p][1]))'),

    dict(id="a_pull_mode_only_no_chmod",
         desc="A-P1-2②：local==remote 只改基线不 chmod 本地 → "
              "基线说 644、本地实际 755，两边永久打架",
         old='            cur_mode = (lmap.get(rel) or ("100644", ""))[0]\n'
             '            if cur_mode != rmode:\n'
             '                _write_local(rel, remote, rmode)\n'
             '                print(f"  = {rel} 内容一致，仅权限位 {cur_mode} → {rmode}")',
         new='            cur_mode = rmode'),

    dict(id="a_conflict_block_global",
         desc="A-P1-5：冲突拦截改回全局 → 1 个冲突挡住其他所有文件",
         old='        unresolved = [r for r in state["conflicts"] if r in pending]',
         new='        unresolved = list(state["conflicts"])'),

    # ---- git 回退 / stash ----
    dict(id="a_head_rewind_detection_off",
         desc="本地 HEAD 回退检测失效 → "
              "git reset/checkout 后推送静默回退主干（实测可复现的 P0）",
         old='    rc = subprocess.run(["git", "-C", ROOT, "merge-base",\n'
             '                         "--is-ancestor", old, cur]).returncode',
         new='    rc = 0'),

    dict(id="a_stash_hint_removed",
         desc="stash 提示移除 → 工作区干净时只说「没有改动」，"
              "用户以为改动凭空消失（实际在 stash 里）",
         old='        hint = _stash_hint()\n        if hint:\n            print(hint)',
         new='        pass'),

    # ---- C2：远端删除 ----
    dict(id="c2_no_deletion_detection",
         desc="C2：不比对基线 → 远端删掉的文件静默留在基线里，"
              "日后一改就作为「新增」被推回（复活别人删掉的文件）",
         old='    deleted_remote = [p for p in sorted(state.get("files") or {})\n'
             '                      if p not in rstate]',
         new='    deleted_remote = []'),

    dict(id="c2_compare_local_not_baseline",
         desc="C2：按「本地有而远端没有」判定 → "
              "所有本地新增文件被误报成「远端已删除」，诱导用户删自己的文件",
         old='    deleted_remote = [p for p in sorted(state.get("files") or {})\n'
             '                      if p not in rstate]',
         new='    deleted_remote = [p for p in sorted(local_state_map())\n'
             '                      if p not in rstate]'),

    dict(id="c2_silent_when_no_merge",
         desc="C2：提示只在循环后打印 → 远端只删文件时 paths 为空、"
              "提前 return，最常见场景反而完全静默",
         old='        _report_remote_deletions(deleted_remote)\n'
             '        if state.get("conflicts"):',
         new='        if state.get("conflicts"):'),

    dict(id="s1_prune_deletes_tracked_branch",
         desc="自查：--prune 把 tasks 跟踪的分支当孤儿 → "
              "建议用户删掉自己刚推上去的改动（与 P1-8 提示自相矛盾）",
         old='        tracked = set((state.get("tasks") or {}).keys())\n'
             '        orphan_free = [(n, t) for n, t in orphan if n not in tracked]\n'
             '        orphan_held = [(n, t) for n, t in orphan if n in tracked]',
         new='        tracked = set()\n'
             '        orphan_free = list(orphan)\n'
             '        orphan_held = []'),

    # ---- 第四轮审查 ----
    dict(id="r4_pull_rewind_check_removed",
         desc="P0：--pull 声明已同步前不查回退 → "
              "local_head 被改写、证据抹掉，v2 静默覆盖主干 v3",
         old='        if _refuse_if_rewound(state, "--pull",\n'
             '                              "   恢复后重跑 --pull，届时它会真正合并远端改动。"):\n'
             '            return False\n'
             '        if state.get("conflicts"):',
         new='        if state.get("conflicts"):'),

    dict(id="r4_marksynced_rewind_check_removed",
         desc="P0：--mark-synced 不查回退 → 照常解除 P0-1，本地旧内容覆盖远端",
         old='    if _refuse_if_rewound(state, "--mark-synced",\n'
             '                          "   恢复后重跑 --mark-synced。"):\n'
             '        raise SystemExit("已取消标记（本地副本状态存疑，未解除过期拦截）。")\n\n',
         new=''),

    dict(id="r4_unresolvable_commit_fail_open",
         desc="P1-2：old 提交查不到时 fail-open → "
              "本地被动过的最强信号被当成「一切正常」放行",
         old='    return True, (f"无法解析上次同步时记录的本地提交 {old[:8]}"',
         new='    return False, (f"无法解析上次同步时记录的本地提交 {old[:8]}"'),

    dict(id="r4_conflict_artifacts_not_reported",
         desc="P1-3：--status/--prune 不列 .push-conflicts → "
              "该目录只增不减，里面是完整远端明文内容，却无人可见",
         multi=True, pairs=[("    _report_conflict_artifacts()", "")]),

    # ---- --direct 分支保护检测 ----
    dict(id="d1_direct_protection_check_removed",
         desc="--direct 不检测分支保护 → "
              "开启保护后直推被服务端拒绝，只剩一个看不懂的 403",
         old='    if wf == "direct":\n        _refuse_direct_if_protected(BRANCH)',
         new='    pass'),

    dict(id="d1_protection_judge_by_truthiness",
         desc="保护判据用真值 → required_pull_request_reviews 为 {} 时"
              "（空字典 falsy）漏判，保护开了却当没开，主干被直推",
         old='        if not any(k in prot for k in KEYS):\n'
             '            return                              # 响应里没有任何保护项',
         new='        if not (prot.get("required_status_checks")\n'
             '                or prot.get("required_pull_request_reviews")\n'
             '                or prot.get("enforce_admins") or prot.get("restrictions")):\n'
             '            return'),

    dict(id="d1_protection_wrong_path",
         desc="用 _ref_path 拼 URL → /branches//git/refs/heads/main/protection"
              " 永远 404，被当成『没开保护』放行",
         old="""        from urllib.parse import quote
        return api("GET",
                   f"/branches/{quote(branch, safe='/')}/protection",
                   allow_404=True)""",
         new="""        return api("GET", f"/branches/{_ref_path(branch)}/protection",
                   allow_404=True)"""),

    dict(id="safe_rel_realpath",
         desc="safe_rel：去掉 realpath 校验，允许 ../ 越出仓库",
         old="    real = os.path.realpath(full)\n",
         new="    real = full\n"),

    # ---- 安全（第 8 轮：token 白名单 / 状态文件权限）----
    dict(id="token_whitelist_loose",
         desc="token 白名单放宽回「可打印 ASCII」（放行引号/反斜杠，"
              "可闭合 curl 配置的引号）",
         old='    if not re.fullmatch(r"[A-Za-z0-9_.-]+", TOKEN or ""):\n'
             "        raise SystemExit(\n"
             '            "GITHUB_TOKEN 含非法字符（可能是复制时混入了换行、引号或空格）。\\n"\n'
             "            f\"  GitHub 的 token 只由 A-Z a-z 0-9 和 _ - . 组成（当前 \"\n"
             "            f\"{len(TOKEN or '')} 个字符）。\\n\"\n"
             '            "  请重新复制，注意不要带上换行或首尾空格。"\n'
             "        )\n"
             "    tok = TOKEN",
         new='    tok = re.sub(r"[^\\x21-\\x7E]", "", TOKEN)\n'
             "    if tok != TOKEN:\n"
             "        raise SystemExit(\n"
             '            "GITHUB_TOKEN 含不可见字符或非 ASCII 字符（可能复制时混入了换行）。\\n"\n'
             '            "  GitHub 的 token 只由 A-Z a-z 0-9 和 _ - . 组成，请重新复制。"\n'
             "        )"),

    dict(id="token_whitelist_absent",
         desc="token 白名单整个去掉（换行可直接注入 curl 配置新指令）",
         old='    if not re.fullmatch(r"[A-Za-z0-9_.-]+", TOKEN or ""):\n'
             "        raise SystemExit(\n"
             '            "GITHUB_TOKEN 含非法字符（可能是复制时混入了换行、引号或空格）。\\n"\n'
             "            f\"  GitHub 的 token 只由 A-Z a-z 0-9 和 _ - . 组成（当前 \"\n"
             "            f\"{len(TOKEN or '')} 个字符）。\\n\"\n"
             '            "  请重新复制，注意不要带上换行或首尾空格。"\n'
             "        )\n"
             "    tok = TOKEN",
         new="    tok = TOKEN"),

    dict(id="state_file_world_readable",
         desc="状态文件保持 0644（私有仓库下文件清单也算泄露面）",
         old="        try:\n"
             "            os.chmod(tmp, 0o600)\n"
             "        except OSError:\n"
             "            pass                      # 权限改不动不该阻断推送",
         new="        pass"),

    dict(id="cleanup_excludes_local_commit",
         desc="P2：本地 commit 移出补偿清理的 try"
              "（PATCH 成功后 Ctrl-C 会留下有内容的孤儿分支）",
         # 必须是**结构回退**：把 git add/commit 挪到 except 之后。
         # 若简单替换成 `pass`，等于「跳过本地 commit」，中断点根本不会
         # 被触发，变异测不出任何东西（实测：那样写 SURVIVED 但无意义）。
         old='        git("add", "--", *todo)\n'
             '        if git("diff", "--cached", "--name-only", "--", *todo):\n'
             '            git("-c", "user.name=yuanbao", "-c", "user.email=yuanbao@users.noreply.github.com",\n'
             '                "commit", "-q", "-m", msg, "--", *todo)\n'
             '\n'
             '    # 清理范围**停在「开 PR」之前**是有意的：PR 一旦建出来就有编号、\n'
             '    # 能被 --prune 看见、也能 --merge 继续 —— 那时该做的是提示用户，\n'
             '    # 而不是悄悄删掉。\n'
             '    except BaseException:\n'
             '        _cleanup_failed_branch(branch_created_now)\n'
             '        raise',
         new='    except BaseException:\n'
             '        _cleanup_failed_branch(branch_created_now)\n'
             '        raise\n'
             '\n'
             '    git("add", "--", *todo)\n'
             '    if git("diff", "--cached", "--name-only", "--", *todo):\n'
             '        git("-c", "user.name=yuanbao", "-c", "user.email=yuanbao@users.noreply.github.com",\n'
             '            "commit", "-q", "-m", msg, "--", *todo)'),

    # ---- 并发 / 重试 ----
    dict(id="retry_all_idempotent",
         desc="幂等：所有写请求都允许重试（PATCH 重试会误报「他人抢先提交」）",
         old="    if method == \"GET\":\n        return True\n",
         new="    return True\n    if method == \"GET\":\n        return True\n"),

    # ---- PR 工作流 ----
    dict(id="pr_reuse_closed",
         desc="P1-3：复用已关闭/已合并的旧 PR（改动不进主干）",
         old='    if pr and pr.get("state") == "open":\n',
         new="    if pr:\n"),

    dict(id="hold_baseline_follow",
         desc="P1-1：合并后不认「主干版本就是我推的」，基线不跟进",
         old="        if merged_pushed and merged_pushed.get(p) == s:\n",
         new="        if False and merged_pushed and merged_pushed.get(p) == s:\n"),

    dict(id="pull_noop_synced",
         desc="P1-2：--pull 空转时不解除 P0-1（用户被永久挡住）",
         old='            state["base_commit"] = head_sha\n'
             "            state[\"synced_commit\"] = head_sha\n"
             "            save_state(state)\n"
             '            print(f"  · 本地内容已与远端一致',
         new='            pass\n'
             '            print(f"  · 本地内容已与远端一致'),

    # ---- 状态文件健壮性 ----
    dict(id="state_no_dict_check",
         desc="状态校验：不检查 state 是否为 dict",
         old="    if not isinstance(state, dict):\n"
             '        _corrupt_state(f"期望一个 JSON 对象，实际是 {type(state).__name__}", path)\n',
         new="    if False:\n        pass\n"),

    dict(id="state_null_accepted",
         desc="状态校验：JSON null 被当成「文件不存在」→ 静默重建基线",
         old='        _corrupt_state("文件内容是 null（空基线应删掉文件，而不是写入 null）")\n',
         new="        return None\n"),

    dict(id="path_type_check",
         desc="路径类型检查：不拦目录/FIFO（FIFO 会让 open 永久阻塞）",
         old='    if stat.S_ISDIR(st.st_mode):\n'
             '        return True, "是一个目录（应是文件）"\n'
             '    if stat.S_ISFIFO(st.st_mode):\n'
             '        return True, "是一个 FIFO/管道（按文件读会一直阻塞）"\n'
             '    if not stat.S_ISREG(st.st_mode):\n'
             '        return True, f"不是普通文件，而是{_ftype(st.st_mode)}"\n',
         new="    pass\n"),

    # ---- 杂项 ----
    dict(id="days_since_local_tz",
         desc="P3-2：用本地时区解析 UTC 时间戳（东八区偏 8 小时）",
         old="return (time.time() - calendar.timegm(time.strptime(s, fmt))) / 86400.0",
         new="return (time.time() - time.mktime(time.strptime(s, fmt))) / 86400.0"),

    dict(id="conflict_marker_allowed",
         desc="允许把带 <<<<<<< 冲突标记的内容推上去",
         old='    if b"<<<<<<<" in data or b">>>>>>>" in data:\n',
         new="    if False:\n"),

    # ---- 本轮新增（P1/P2/P3）----
    dict(id="gitignore_no_warn",
         desc="P1：推送被 .gitignore 屏蔽的文件时不警告（后续改动会静默漏推）",
         old="    if files:\n        ignored = sorted(gitignored_set(files))\n",
         new="    if False:\n        ignored = []\n"),

    dict(id="typo_no_warn",
         desc="P2：打错文件名 / 点名目录时不提示，只说「本地没有待推送的改动」",
         old="    if rejected:\n"
             '        print(f"\\n❌ 以下路径越出仓库范围或非法，已忽略：{rejected}")\n'
             "    if dropped:\n",
         new="    if False:\n        pass\n    if False:\n"),

    dict(id="method_no_validate",
         desc="P3-2：--method 非法值不校验（发给 GitHub 收一串 422 JSON）",
         old='    if opts["method"] not in VALID_MERGE_METHODS:\n',
         new="    if False:\n"),

    dict(id="new_task_ignored",
         desc="P3-1：--new-task 无效（仍复用旧任务分支）",
         old="        elif opts[\"hold\"] and state.get(\"task_branch\"):\n"
             "            if opts[\"new_task\"]:\n",
         new="        elif opts[\"hold\"] and state.get(\"task_branch\"):\n"
             "            if False:\n"),

    dict(id="base_src_ignored",
         desc="不区分 base 来源：git HEAD 那份在用户 commit 后已含其改动，"
              "当成可信基点会让 --pull 静默覆盖掉已 commit 的改动",
         old="        if base_src == \"baseline\":\n"
             "            base_ok = True\n"
             "        elif base_src == \"git\":\n"
             "            base_ok = (local != base)\n"
             "        else:\n"
             "            base_ok = False",
         new="        base_ok = base is not None"),

    dict(id="base_git_head_never_trusted",
         desc="过度修复：git HEAD 的 base 一律不可信 → 未 commit 时退化成空 base，"
              "撞出假冲突",
         old="        elif base_src == \"git\":\n"
             "            base_ok = (local != base)",
         new="        elif base_src == \"git\":\n"
             "            base_ok = False"),

    # ---- 非 UTF-8 文件名（第 6 轮 P2）----
    dict(id="utf8_no_surrogateescape",
         desc="P2：git() 不用 surrogateescape（非 UTF-8 文件名让 detect_changes 崩）",
         old='capture_output=True, text=True,\n'
             '                           errors="surrogateescape")',
         new="capture_output=True, text=True)"),

    dict(id="utf8_no_path_filter",
         desc="P2：不过滤无法编码成 UTF-8 的路径 → 崩在建 payload 时，"
              "且已在远端留下僵尸分支",
         old='        try:\n'
             '            rel.encode("utf-8")\n'
             '        except UnicodeEncodeError:\n'
             '            unencodable.append(rel)\n'
             '            continue\n',
         new=""),

    # ---- 远端新增文件拉取不到（用户实测缺 148 个）----
    dict(id="pull_ignores_missing_files",
         desc="--pull 不纳入本地缺失的远端文件 → 新增文件永远拉不下来，"
              "且谎报「没有需要合并的远端改动」",
         old='                       and ((state["files"].get(p) or {}).get("sha") != rstate[p][1]\n'
             '                            or p not in lmap))',
         new='                       and (state["files"].get(p) or {}).get("sha") != rstate[p][1])'),

    dict(id="pull_missing_not_filled_first",
         desc="循环内不优先补齐本地缺失文件 → 被「远端无变化」分支跳过",
         old="        if local is None:\n"
             "            # 本地根本没有这个文件：远端新增，或本地副本不完整。",
         new="        if False:\n"),

    dict(id="init_silently_missing",
         desc="init 时不提示本地缺失的远端文件（用户无从察觉本地少了一批）",
         old="    if missing:\n"
             '        print(f"\\n  · 本地缺少 {len(missing)} 个远端存在的文件"',
         new="    if False:\n        pass\n    if False:\n"
             '        print(f"\\n  · 本地缺少 {len(missing)} 个远端存在的文件"'),

    # ---- 缓存失效（用户实测：改了文件推送，改动静默丢失）----
    dict(id="lmap_uses_stale_cache",
         desc="local_state_map() 用缓存的 detect_changes() → 改动文件拿到"
              "git 索引旧值 → 误判「已与远端一致」→ 改动静默丢失",
         old="    for rel in detect_changes(refresh=True):",
         new="    for rel in detect_changes():"),

    dict(id="no_branch_cleanup",
         desc="P1：推送中途失败不清理分支（远端留僵尸，本地 tasks 里却没有）",
         old="    except BaseException:\n"
             "        _cleanup_failed_branch(branch_created_now)\n"
             "        raise",
         new="    except BaseException:\n        raise"),

    dict(id="lock_before_build_only",
         desc="P2：PATCH 前不做第二遍 ref 乐观锁（真正的并发窗口没盖住）",
         old='    _recheck_ref(target_ref, base_sha, "建对象完成后")',
         new="    pass"),

    dict(id="no_http_hints",
         desc="P2：HTTP 错误码不加下一步提示（用户看到 422 只会往权限上猜）",
         old="            _raise_api_error(method, url, code, body)",
         new='            raise SystemExit(f"API {method} {url} → HTTP {code}: {body[:400]}")'),

    dict(id="write_local_keeps_stale_cache",
         desc="_write_local() 改写工作区后不失效缓存 → 后续检测拿到写入前快照",
         old="    # 工作区刚被改写，detect_changes() 的缓存立即失效。\n"
             "    # 不清的话，后续任何 detect_changes()（无 refresh）都会返回**写入前**\n"
             "    # 的旧快照，把刚落盘的改动当成「本地无改动」—— 这正是 pull 里那句\n"
             "    # 「写入文件后再检测必须 refresh」注释所指，但要靠每个调用点自觉传参\n"
             "    # 太脆弱，这里从源头失效掉。\n"
             "    global _CHANGES_CACHE\n"
             "    _CHANGES_CACHE = None",
         new="    pass"),
]


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                     # 存在但无权发信号 → 仍算活着
    return True


@contextlib.contextmanager
def single_instance_lock():
    """全局单实例锁（PID 标记文件，不是 flock）。

    所有 test_*.py 都写 /dev/shm 下的固定路径。两个进程同时跑会
    互相 rmtree 仓库、unlink 状态文件，表现为随机失败、基线不绿 ——
    看起来像代码 bug，其实是测试之间在打架。

    用 PID 文件而非 flock：本机 /dev/shm 上 flock 的状态在进程被
    timeout/SIGKILL 后并不释放，会留下一个**永久占着却没人持有**的锁，
    之后所有运行都被挡在外面（实测：遍历 /proc 找不到任何持锁进程，
    但 flock 仍返回 EAGAIN）。PID 文件能自愈 —— 进程不存在就当锁已释放。
    """
    try:
        raw = open(LOCK_PATH).read().strip()
    except FileNotFoundError:
        raw = ""
    if raw.isdigit() and _pid_alive(int(raw)):
        raise SystemExit(
            f"另一个 mutate.py 正在运行（PID {raw}，锁 {LOCK_PATH}）。\n"
            f"  测试套件共用 /dev/shm 下的固定路径，并发跑会互相删对方的\n"
            f"  仓库和状态文件，结果不可信。请等它结束。\n"
            f"  确认那是僵死进程后可手动删除锁文件。"
        )
    with open(LOCK_PATH, "w") as f:
        f.write(str(os.getpid()))
    try:
        yield
    finally:
        try:
            if open(LOCK_PATH).read().strip() == str(os.getpid()):
                os.unlink(LOCK_PATH)
        except (FileNotFoundError, ValueError):
            pass


def apply_mutation(src, mut):
    """返回 (新源码, 改动处数)。改不动就是空变异。

    两种模式：
      · 默认：old → new 单处替换，要求 old 唯一（沿用原判据）
      · multi=True：pairs 里的每一对做**全局**替换，用于对同一模式的所有
        调用点一起回退。比如 9 处 safe_input() 只退回 1 处的话，
        顶层 EOFError 兜底会把 traceback 换成人话，单点上断言不到
        「流程已中断」—— 必须整体回退才测得出来。
    """
    if mut.get("multi"):
        out, skip = src, mut.get("skip_def")
        total = 0
        for a, b in mut["pairs"]:
            lines, n = out.split("\n"), 0
            for i, l in enumerate(lines):
                if a in l and not (skip and skip in l):
                    lines[i] = l.replace(a, b)
                    n += 1
            out, total = "\n".join(lines), total + n
        return (out, total) if total else (None, 0)
    old, new = mut["old"], mut["new"]
    n = src.count(old)
    if n != 1:
        return None, n          # 0 = 位置没了；>1 = 不唯一，都不该继续
    return src.replace(old, new, 1), 1


def run_suite(script, target, timeout=180):
    """跑一个测试套件，返回 (是否通过, 输出)。"""
    try:
        p = subprocess.run(
            [sys.executable, script, target],
            cwd=HERE, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "TIMEOUT"
    out = (p.stdout or "") + (p.stderr or "")
    ok = "ALL PASS" in out or "总判定: ALL PASS" in out
    return ok, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只跑指定变异（逗号分隔 id）")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--keep", action="store_true", help="保留变异后源码")
    ap.add_argument("--timeout", type=int, default=180)
    args = ap.parse_args()

    if args.list:
        for m in MUTATIONS:
            print(f"  {m['id']:<26} {m['desc']}")
        return

    tests = discover_tests()
    print(f"目标      : {TARGET}")
    print(f"测试套件  : {len(tests)} 个（自动发现）")
    for t in tests:
        print(f"   - {t}")
    print()

    with single_instance_lock():
        src = open(TARGET, encoding="utf-8").read()

        # 基线：未变异时测试必须全绿，否则后面所有结论都不可信
        print("=== 基线（未变异）===")
        baseline_ok = True
        for t in tests:
            ok, _ = run_suite(t, TARGET, args.timeout)
            print(f"  {'PASS' if ok else 'FAIL'}  {t}")
            baseline_ok = baseline_ok and ok
        if not baseline_ok:
            print("\n基线不绿 —— 先修测试，变异结果无意义。")
            return 1
        print("  基线全绿 ✓\n")

        muts = MUTATIONS
        if args.only:
            want = set(args.only.split(","))
            muts = [m for m in MUTATIONS if m["id"] in want]

        results = []
        for m in muts:
            mutated, n = apply_mutation(src, m)
            if mutated is None:
                results.append((m, "NOT_APPLIED", n, []))
                print(f"  ⚠️  {m['id']}: 空变异（old 匹配到 {n} 处，应恰好 1 处）")
                continue

            tmp = os.path.join(HERE, f"_mut_{m['id']}.py")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(mutated)

            killed_by = []
            for t in tests:
                ok, _ = run_suite(t, tmp, args.timeout)
                if not ok:
                    killed_by.append(t)
                    break           # 一个套件抓到就算 KILLED

            verdict = "KILLED" if killed_by else "SURVIVED"
            results.append((m, verdict, 1, killed_by))
            mark = "✓" if killed_by else "✗"
            extra = f"（{killed_by[0]} 抓到）" if killed_by else "（盲区！）"
            print(f"  {mark} {m['id']:<26} {verdict}{extra}")

            if not args.keep:
                os.unlink(tmp)

    print("\n" + "=" * 62)
    killed = [r for r in results if r[1] == "KILLED"]
    survived = [r for r in results if r[1] == "SURVIVED"]
    empty = [r for r in results if r[1] == "NOT_APPLIED"]

    total = len(results)
    print(f"变异总数   : {total}")
    print(f"  KILLED   : {len(killed)}  （测试守住了）")
    print(f"  SURVIVED : {len(survived)}  （盲区，需补测试）")
    print(f"  空变异   : {len(empty)}  （mutate.py 配置问题，需修）")
    if total:
        score = 100.0 * len(killed) / max(1, len(killed) + len(survived))
        print(f"\n变异得分   : {score:.0f}%  （KILLED / (KILLED+SURVIVED)）")

    if empty:
        print("\n--- 空变异（不是测试问题，是 mutate.py 的 old 串没对上）---")
        for m, _, n, _ in empty:
            print(f"  {m['id']}: 匹配 {n} 处 —— {m['desc']}")

    if survived:
        print("\n--- 盲区：测试没守住这些逻辑 ---")
        for m, _, _, _ in survived:
            print(f"  {m['id']}: {m['desc']}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
