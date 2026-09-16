# push_api.py 代码审查报告

**审查对象**：`push_api.py`（4403 行）+ 配套 11 套回归测试 + `mutate.py`（89 个变异）+ `run_all.py`
**审查日期**：2026-09-17
**审查方式**：静态阅读 + 基线回归 + 变异测试 + 定向探针复现

---

## 0. 总体结论

这是一份**工程质量明显高于平均水平**的脚本：4403 行里绝大多数防御都附了「为什么这么写、不这么写会怎样」的注释，且注释里记录的是**真实踩过的事故**（如「实测：一次推送用的 `pr/backfill-round2` 根本不在视野内」），不是空泛的规范复述。分层防护（第零层本地回退检测 → P0-1 过期校验 → 第一层文件级基线校验 → 第二层 ref 乐观锁 → 第三层 force=False）的设计是站得住的。

**验证结果**：

| 检查项 | 结果 |
|---|---|
| pyflakes 静态检查 | ✅ 0 告警（13 个文件全扫） |
| 回归测试 | ✅ 12/12 套全绿，770+ 断言 |
| 变异测试（已跑 20/89） | 18 KILLED / 0 SURVIVED / **2 空变异** |
| 定向探针 | 复现 6 个真实缺陷（2 个高危） |

**一句话**：测试套件的守备能力很强，但**防线内侧漏了**——有几处「工具自己声明要保证的语义」在实现里没兜住，而测试恰好也没覆盖到。下面按严重程度排列。

---

## 1. 高危：测试基础设施在自欺欺人（2 条空变异）

`mutate.py` 的模块 docstring 里写着：

> 变异体在源码里根本不存在……于是替换不生效、文件没变，测试当然全绿 —— **这不是测试盲区，是 mutate.py 在自欺欺人。必须显式识别出来**，否则会花时间去「补测试」一个根本没被测到的位置。

现状是：**89 个变异里有 2 条正是这种空变异，而且都是最关键的两个安全防线**。

```
⚠️  token_whitelist: 空变异（old 匹配到 0 处，应恰好 1 处）
⚠️  v4_symlink_target_unchecked: 空变异（old 匹配到 0 处，应恰好 1 处）
```

### 1.1 `token_whitelist` —— token 注入防线**从未被变异验证**

变异定义的 old 串：
```python
old='    tok = re.sub(r"[^\\x21-\\x7E]", "", TOKEN)\n    if tok != TOKEN:\n'
```
源码现在（push_api.py:254）已经是收紧后的版本：
```python
if not re.fullmatch(r"[A-Za-z0-9_.-]+", TOKEN or ""):
    raise SystemExit(...)
```
第一版「所有可打印 ASCII」的白名单**早就被换掉了**（`_auth_config` 的 docstring 里记了这个演进），但 mutate.py 没跟着改。

**后果**：`token_whitelist_strictness`（test_security_data.py）这条测试在**守一堵已经不存在的墙**。真正的 `[A-Za-z0-9_.-]` 白名单从未被注入过变异——没人知道它坏了测试会不会红。

### 1.2 `v4_symlink_target_unchecked` —— 路径穿越防线**从未被变异验证**

变异 old 串用的是 `target` 变量名：
```python
old=...  if os.path.isabs(target):
         raise SystemExit(f"{rel} 是符号链接，目标 {target!r} 是绝对路径，拒绝创建。")
```
源码现在用的是 `_check`（strip 后的值）：
```python
if os.path.isabs(_check):                              # push_api.py:1943
    raise SystemExit(f"... 目标 {_check!r} 是绝对路径 ...")
```
`_check = target.strip()` 这个改动是对的（校验用语义值、落盘用原字节，注释里讲得很清楚），但变量名一换，变异就 0 匹配。

**后果**：P1-21（远端可让软链指向仓库外）这条防线没有变异覆盖。

### 修法

```bash
python3 mutate.py --list        # 定期巡检
```
建议把「空变异」从 warning 升级为**非零退出码**（现在只有 SURVIVED 才 return 2，空变异 return 0）——否则 CI 里它会一直被忽略。

---

## 2. 高危：`ref_sha()` 未 URL 编码，会读到**另一个分支**的 sha

**位置**：`push_api.py:2518`

```python
def ref_sha(branch):
    r = api("GET", f"/git/refs/heads/{branch}", allow_404=True)
    return (r or {}).get("object", {}).get("sha")
```

而同一份文件里，`_ref_path()`（line 559）早就修好了这个问题，注释还专门写了：

> `safe="/"` 是**必须的**……第一版写成 `safe=""` 把 `/` 编成 %2F，结果所有任务分支都变成 `task%2F2026xxx`，请求全部 404 —— 10 套测试当场变红。

**`ref_sha()` 是这次修复漏掉的那个调用点**，而它是全脚本查分支 head 的**唯一入口**。

### 实测复现

```
gh3.refs["task/a"]   = c1111…
gh3.refs["task/a?b"] = c2222…
>>> mod.ref_sha("task/a?b")
c111111111111111111111111111111111111111     # ← 拿到的是 task/a 的
```

`?` 之后被当成 query string 丢掉，请求打到 `task/a` 上。

### 后果链（每一环都用到了 ref_sha 的返回值）

| 调用点 | 行号 | 后果 |
|---|---|---|
| 分支名撞名检测 | 3827 | `ref_sha(branch) is None` 恒假 → 连续 5 次误判「分支已存在」→ 直接中止推送 |
| `--hold` 复用分支 | 3834 | `bhead` 拿到**别的分支**的 sha → 后续建 tree/commit 挂在错误的父提交上 |
| `abandon_task` 内容校验 | 2920 | 拿错 sha 比对「分支上是否有别人推的改动」→ 该拦的不拦 |
| `_cleanup_failed_branch` | 519 | `cur != expect_sha` 判成「分支已被他人改动」→ 跳过清理，**孤儿分支复发** |

### 修法

```python
def ref_sha(branch):
    return (api("GET", _ref_path(branch), allow_404=True) or {}).get("object", {}).get("sha")
```
并补一条测试：分支名含 `?` / `#` / 空格时，`ref_sha` 必须返回该分支自己的 sha。

---

## 3. 高危：`--delete-branch` 完全不查 `PROTECTED_BRANCHES`

**位置**：`push_api.py:2969` `delete_branch_cmd()`

```python
if branch == BRANCH:                       # 只硬拦主干
    raise SystemExit(...)
if not branch.startswith(TASK_PREFIX):     # 只按前缀"警告"一下
    print(f"  ⚠️  {branch} 不是 {TASK_PREFIX}* 任务分支…")
    if not yes and safe_input(...) != "y":
        return
# → 照删
```

而 `PROTECTED_BRANCHES`（默认 `main,master,develop,release`）在 **line 3107 的 `prune()` 里被当作排除名单用**，注释还写着「长期分支：--prune 体检时排除（主干另由 BRANCH 排除）」。

**同一个常量：在报告侧是排除名单，在删除侧完全没人用。**

### 实测复现

```
gh2.refs["develop"] = c000…
>>> run(mod, ["--delete-branch", "develop", "--yes"])
develop 是否还在: False        # ← develop 被删掉了
```

`--yes` 下连那句「不是 task/* 分支」的警告都看不到（警告被 `if not yes` 包住了）。

### 危害

`develop` / `release` 是长期集成分支，删除是**不可逆的远端操作**。而 `--yes` 是脚本自己的文档推荐用法（`--delete-branch 名字` 的说明里就写着「真正删除（逐个确认）」），用户很容易带上。

### 修法

```python
if branch in ({BRANCH} | set(PROTECTED_BRANCHES)):
    raise SystemExit(f"拒绝删除受保护分支 {branch}。…")
```
放在 `TASK_PREFIX` 警告**之前**，且不受 `yes` 影响（"确认"不能授权删除受保护分支）。

---

## 4. 中危：`workflow` 取值大小写/未知值 → **静默退化成直推主干**

**位置**：`push_api.py:3601`

```python
wf = "direct" if opts["direct"] else (state.get("workflow") or DEFAULT_WORKFLOW)
```

PR 分支的判据是**精确匹配** `wf == "pr"`（line 3610 / 3799 / 4279），而 direct 是「else」—— 任何非 `"pr"` 的值都落到 direct。

### 实测复现

```python
st["workflow"] = "PR"          # 大写
>>> run(mod, ["--yes", "-m", "x"])
创建的任务分支: []
开的 PR 数    : 0
主干 a.txt    : 'v2\n'          # ← 直推主干，无分支、无 PR
```

### 为什么危险

退化的方向**恰好是最危险的一侧**：绕开全部 PR 流程（第一层文件级校验在 direct 下才是「拦截」，在 PR 下只是「提示」）。而且：

- 用户完全无感知——没有任何输出提到「本次走了 direct」
- `state["workflow"]` 是持久化字段，一次写错就**永久生效**
- 触发路径不罕见：手写状态文件、多仓库共享 `--state`、或将来脚本改写这个字段时大小写漂移

### 修法

```python
raw_wf = (state.get("workflow") or DEFAULT_WORKFLOW)
wf = "direct" if opts["direct"] else str(raw_wf).lower()
if wf not in ("pr", "direct"):
    raise SystemExit(f"基线里的 workflow 是 {raw_wf!r}，只接受 pr / direct。" +
                     "  未知值不会静默退化成直推主干。")
```
未知值**报错**而不是静默取默认——这与整套脚本「fail-closed」的既定风格一致（`_local_head_rewound` 里 `rc>1` 就是这么处理的）。

---

## 5. 中危：`_write_local()` 的 symlink 越界校验用 `ROOT` 而非 `realpath(ROOT)`

**位置**：`push_api.py:1948`

```python
resolved = os.path.realpath(os.path.join(os.path.dirname(full), _check))
if not (resolved == ROOT or resolved.startswith(ROOT + os.sep)):
    raise SystemExit(f"... 解析后指向仓库外：{resolved} …")
```

而**读侧** `safe_rel()`（line 1033）用的是：
```python
root = os.path.realpath(ROOT)          # ← 注意这里解析了
real = os.path.realpath(full)
if real != root and not real.startswith(root + os.sep):
    return None
```

左边 `realpath`、右边不 `realpath` —— **一边解析一边不解析**。

### 实测复现

```
ROOT = /tmp/_pr_repo_28510
通过软链 /tmp/_pr_repo_link 访问同一个仓库

mod.ROOT = LINK
>>> mod.safe_rel("s2")                        # 读侧
's2'                                          # ✅ 通过
>>> mod._write_local("s2", b"k.txt", "120000") # 写侧
SystemExit: s2 是符号链接，目标 'k.txt' 解析后指向仓库外：
            /tmp/_pr_repo_28510/k.txt         # ❌ 被拒，而它明明在仓库内

对照组 mod.ROOT = 真实路径 → OK
```

### 后果

`--pull` 一旦遇到 symlink 就 `SystemExit` 中断**整个合并流程**（不只是跳过这一个文件）。挂载卷 / 软链目录是容器和 CI 的常态。

讽刺的是，这段代码的注释（line 1936）写的正是：

> `safe_rel()` 只防了**读取**侧，写侧没有。同一份代码里读侧防了、写侧没防，是最容易被忽略的不对称。

修 P1-21 时补上了写侧，但**用了与读侧不一致的比较基准**，于是「不对称」换了个形式继续存在。

### 修法

```python
root = os.path.realpath(ROOT)
resolved = os.path.realpath(os.path.join(os.path.dirname(full), _check))
if not (resolved == root or resolved.startswith(root + os.sep)):
```
并把这段判定抽成一个 `_inside_root(path)`  helper，让 `safe_rel` 和 `_write_local` 共用——两处手写同一个「路径在不在仓库内」的判据，迟早会再漂一次。

---

## 6. 中危：curl 网络层失败对**非幂等写**也重试（实现与文档不一致）

**位置**：`push_api.py:732-741`

```python
if out.returncode != 0:
    if out.returncode == 28:
        raise SystemExit(...)        # 超时：不重试 ✅
    if attempt < retries:
        time.sleep(2 ** attempt)
        continue                     # ← 其他退出码：无条件重试，没过 _retryable()
    raise SystemExit(f"curl 失败（退出码 {out.returncode}）…")
```

而 `api()` 的 docstring（line 626）写的是：

> · curl 网络层失败（52/56 等）：**同样过 `_retryable`**，因为这类失败也可能是「服务端已处理、响应传输中断」

`_retryable()` 自己的注释（line 345）逐字描述了不这么做的后果：

> PATCH /git/refs：第二次撞 422 not fast-forward，而调用方那句「出现并发提交，已中止」会把自己的重试**误报成他人抢先提交**，用户据此去排查根本不存在的并发

**文档是对的，实现是错的。** 而 raw 分支（line 690）也一样无条件重试。

### 覆盖率实测

把这段分别改成两种「正确」写法，跑全套测试：

```
[A_no_retry]  test_real_curl: PASS    run_all 全套: ALL PASS
[B_retryable] test_real_curl: PASS    run_all 全套: ALL PASS
```

**两种写法都全绿 = 这条路径 100% 无覆盖。** `test_real_curl.py` 注入了 20 种故障（含 `exitcode=7`），但只断言「不裸崩」和「该重试的退避重试」，从未断言「POST/PATCH 不该重试」。

### 修法

```python
if attempt < retries and _retryable(method, path):
    time.sleep(2 ** attempt)
    continue
raise SystemExit(...)
```
并在 `test_real_curl.py::scene_retry_policy` 里补：
`curl 失败(7/52/56)` × `PATCH /git/refs/heads/x` → 期望 `n == 1`。

---

## 7. 低危（但值得顺手修）

### 7.1 冲突副产物目录权限 0777，比状态文件还松

`CONFLICT_DIR`（line 382）里的文件**存的是完整的远端明文内容**——`_report_conflict_artifacts()` 自己就是这么描述的：

> 里面是完整的远端明文内容

但 `os.makedirs(CONFLICT_DIR, exist_ok=True)`（line 495）没给 mode。实测：

```
目录权限: 0o777
文件权限: 0o777
```

而状态文件只含**文件名清单**，却特意收紧到 0600（`save_state` 的注释：私有仓库场景下文件名清单本身也算信息泄露面）。**含明文的那个反而更松**。

修法：`os.makedirs(CONFLICT_DIR, mode=0o700, exist_ok=True)`，并在 `_conflict_path` 里对写出的文件 `os.chmod(0o600)`。注意 `makedirs` 的 mode 只在目录**新建**时生效，已有目录要补一次 `os.chmod`。

### 7.2 `prune()` 的 docstring 是死字符串

```python
def prune(state, grace_days=MERGED_GRACE_DAYS):        # line 3087
    _report_conflict_artifacts()                        # ← 语句在前
    """分支体检：**只报告，绝不删除**。                # ← 这就不是 docstring 了
    …
    """
```

实测：`prune.__doc__ is None`。

这份长注释是 `--prune` 语义的**核心契约**（「只报告不删、删除一律走 --delete-branch 并逐个确认」），也是 `PROTECTED_BRANCHES` 排除法设计思路的唯一说明出处。现在它被 Python 当成一个字符串字面量丢弃了：`help(prune)` 看不到，文档工具抓不到，读者会误以为它是上面那句调用的注释。

修法：把 `_report_conflict_artifacts()` 挪到 docstring **之后**。

### 7.3 基线 `files` 的值只校验类型、不校验字段形态

`validate_state`（line 1271）：
```python
for p, v in state["files"].items():
    if not isinstance(v, (dict, str)):
        _corrupt_state(...)
```

`{"a.txt": {"mode": 100755, "sha": 123}}`（mode/sha 都是 int）通过校验，然后在比较 `(lmode, lsha) == (rmode, rsha)` 时永远为假 → **永久误报「远端被他人改动」**。

对比：`version` 字段已经用 `exact=True` 挡掉了 `bool`（注释：bool 是 int 的子类）。files 里这一层没贯彻同样的严格度。修法：对 dict 形态补 `chk` mode/sha 必须是 `str`。

---

## 8. 做得好的地方（值得保留的模式）

审查不是只挑毛病。以下几处是这份脚本真正有价值的部分，重构时别丢：

1. **每条防御都附「不这么写会怎样」的真实事故**，而不是规范复述。例如 `_retryable()` 里逐字写出「会把自己的重试误报成他人抢先提交」——后来人能据此判断能不能改。

2. **`_base_bytes()` 返回 `(data, source)` 而不仅是 data**（line 1992）。区分「baseline / git / None」三档可信度，避免了「用户 commit 后拿 HEAD 当合并基点 → 改动静默消失」。这是本次审查里设计得最精细的一处。

3. **`_Cancel` 异常统一取消与失败的清理通道**（line 139）。注释说得很实在：「实测最高频的一条：用户在确认提示按 N，100% 留僵尸分支」。用异常而不是 return，新增退出点时不会忘记清理。

4. **`prune()` 用排除法而非前缀白名单**（line 3099），且注释点明动机：「它报出的『很干净』会被当成真的干净」——**错误的安全感比崩溃更危险**，这个判断很准。

5. **`--prune` 的孤儿分支二次分类**（line 3188）：`tasks` 里还在跟踪的分支不当孤儿处理，避免「工具引导用户删掉自己的改动」。这是少见的「工具自我矛盾」视角。

6. **测试基建本身也在防自欺**：`test_push_failpoints.py` 每个用例都额外断言「注入确实生效」，注释写明「否则测了个寂寞（实测踩过）」；`test_blindspots.py` 的 `_reload()` 从 `mod.__file__` 加载，注释写明「硬编码路径会让坏副本也『通过』」。

---

## 9. 建议的处理顺序

| 优先级 | 项目 | 工作量 | 理由 |
|---|---|---|---|
| P0 | 修 2 条空变异定义（§1） | 10 min | 不修的话，下面所有「变异全绿」的结论都不可信 |
| P0 | `ref_sha()` 走 `_ref_path()`（§2） | 5 min + 1 测试 | 会读到错误分支的 sha，污染 base_sha |
| P1 | `--delete-branch` 查 `PROTECTED_BRANCHES`（§3） | 10 min | 不可逆的远端删除 |
| P1 | workflow 未知值报错而非静默退化（§4） | 10 min | 退化方向是「绕开 PR 直推主干」 |
| P1 | `_write_local` symlink 校验用 `realpath(ROOT)`（§5） | 15 min | `--pull` 遇到软链会整个中断 |
| P2 | curl 网络层失败过 `_retryable()`（§6） | 5 min + 1 测试 | 会误报「他人并发提交」，误导排查 |
| P3 | 冲突目录 0700 / docstring 位置 / files 值校验（§7） | 20 min | 顺手修 |

---

## 附：验证方法

```bash
# 1. 静态检查（pyflakes 需先安装，否则 run_all.py 会静默跳过这一层）
pip install pyflakes
python3 run_all.py --strict

# 2. 变异测试（串行，89 个变异约需 40+ 分钟）
python3 mutate.py

# 3. 巡检空变异
python3 mutate.py --list
```
