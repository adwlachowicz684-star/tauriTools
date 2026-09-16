#!/usr/bin/env python3
"""流程与边界：静态审查发现的 P1/P2/P3 + 一批对抗性边界。

覆盖的是「脚本花了大力气防静默覆盖，却在『静默什么都不做』上漏了」
这一类问题 —— 打错文件名、点名目录、被 .gitignore 屏蔽的文件，
过去都静默丢掉，用户无从区分「真的没改」和「我操作错了」。

用法：python3 test_deep_edges.py <push_api.py 路径>
"""
import os
import sys

sys.path.insert(0, "/data/workspace")
import test_pr_flow as T
from test_pr_flow import GH, main_file, read, run, setup_repo, write

ROOT, STATE = T.ROOT, T.STATE
RES = []


def ck(name, ok, extra=""):
    RES.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {extra}")


def fresh(files):
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt", ".lock"):
        T.remove_any(STATE + ext)
    setup_repo(files)
    gh = GH(files)
    run(T._MOD, gh, ["--init-baseline", "--yes"])
    return gh


# ------------------------------------------------ P1: .gitignore

def gitignore_warns(mod, label):
    """显式点名被 .gitignore 屏蔽的文件：能推上去，但**必须警告**。

    「点名即意图，等同 git add -f」这个语义可以辩护，但代价要说明白：
    这类文件此后不受自动检测（git status 被屏蔽、local_state_map 基于
    git ls-files 也看不到），后续改动会**静默漏推** ——
    与当初修的 P0「已 commit 推不上」是同一类问题。
    """
    gh = fresh({"a.txt": ("100644", b"a\n")})
    with open(os.path.join(ROOT, ".gitignore"), "w") as f:
        f.write("secret*\n")
    write("secret.key", "KEY\n")

    out, err = run(mod, gh, ["--yes", "secret.key", "-m", "推密钥"])
    pushed = gh.files_of("main").get("secret.key") is not None
    warned = "gitignore" in out
    explains = "不会" in out or "显式点名" in out or "不跟踪" in out
    not_tracked = "secret.key" not in T.git("ls-files").stdout

    print(f"\n=== {label} ===")
    ck("点名时能推上去", pushed)
    ck("有 .gitignore 警告", warned)
    ck("说明了后果", explains)
    ck("本地 git 确实不跟踪", not_tracked)
    return pushed and warned and explains and not_tracked


def gitignored_not_auto_pushed(mod, label):
    """被屏蔽的文件不会自动混进推送（不点名就不推）。"""
    gh = fresh({"a.txt": ("100644", b"a\n")})
    with open(os.path.join(ROOT, ".gitignore"), "w") as f:
        f.write("secret*\n")
    write("secret.key", "KEY\n")
    write("a.txt", "a2\n")
    out, err = run(mod, gh, ["--yes", "-m", "只改正常文件"])
    print(f"\n=== {label} ===")
    ck("未点名时不上远端", gh.files_of("main").get("secret.key") is None)
    ck("正常文件照常推送", main_file(gh, "a.txt") == "a2\n")
    return (gh.files_of("main").get("secret.key") is None
            and main_file(gh, "a.txt") == "a2\n")


# ------------------------------------------------ P2: 静默无操作

def typo_filename_warns(mod, label):
    """打错文件名：必须说「已忽略」，不能只说「本地没有待推送的改动」。"""
    gh = fresh({"a.txt": ("100644", b"a\n")})
    out, err = run(mod, gh, ["--yes", "a.tx", "-m", "x"])
    print(f"\n=== {label} ===")
    ck("明确列出被忽略的路径", "已忽略" in out and "a.tx" in out)
    ck("给出排查建议", "拼写" in out)
    return "已忽略" in out and "a.tx" in out and "拼写" in out


def dir_named_warns(mod, label):
    """点名目录（脚本只处理文件）：必须提示，不能静默忽略。"""
    gh = fresh({"a.txt": ("100644", b"a\n")})
    os.makedirs(os.path.join(ROOT, "somedir"), exist_ok=True)
    out, err = run(mod, gh, ["--yes", "somedir", "-m", "x"])
    print(f"\n=== {label} ===")
    ck("提示目录已被忽略", "已忽略" in out and "somedir" in out)
    ck("说明要写具体文件", "具体文件" in out)
    return "已忽略" in out and "somedir" in out and "具体文件" in out


def partial_typo_warns(mod, label):
    """部分命中时也要提示：点三个推上去两个，用户往往察觉不到。"""
    gh = fresh({"a.txt": ("100644", b"a\n"), "b.txt": ("100644", b"b\n")})
    write("a.txt", "a2\n")
    out, err = run(mod, gh, ["--yes", "a.txt", "b.tx", "-m", "x"])
    print(f"\n=== {label} ===")
    ck("a.txt 正常推送", main_file(gh, "a.txt") == "a2\n")
    ck("b.tx 被点名提示", "b.tx" in out and "已忽略" in out)
    return main_file(gh, "a.txt") == "a2\n" and "b.tx" in out and "已忽略" in out


# ------------------------------------------------ P3: 参数处理

def method_validated(mod, label):
    """--method 非法值在本地就报错，不发给 GitHub 收一串 422 JSON。"""
    gh = fresh({"m.txt": ("100644", b"v1\n")})
    out, err = run(mod, gh, ["--yes", "--method", "bogus", "-m", "x"])
    print(f"\n=== {label} ===")
    ck("本地报错", err is not None and "method" in err)
    ck("列出合法取值", err is not None and "squash" in err)
    ck("未发出请求（没推上去）", main_file(gh, "m.txt") == "v1\n")
    return (err is not None and "method" in err and "squash" in err
            and main_file(gh, "m.txt") == "v1\n")


def new_task_starts_fresh(mod, label):
    """--new-task 放弃当前任务分支、另起一个（--hold 攒改动时才看出区别）。"""
    gh = fresh({"n.txt": ("100644", b"v1\n")})
    write("n.txt", "v2\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/one", "-m", "第一次"])
    first = sorted(T.task_branches(gh))

    write("n.txt", "v3\n")
    out, err = run(mod, gh, ["--yes", "--hold", "--new-task", "-m", "另起一个"])
    branches = sorted(T.task_branches(gh))

    print(f"\n=== {label} ===")
    ck("第一次复用/新建了 task/one", first == ["task/one"], f"{first}")
    ck("--new-task 后是两个分支", len(branches) == 2, f"{branches}")
    ck("明确说明放弃了旧分支", "另起一个新分支" in out)
    ck("提示旧分支仍需清理", "不再接管" in out or "prune" in out)
    return (first == ["task/one"] and len(branches) == 2
            and "另起一个新分支" in out and ("不再接管" in out or "prune" in out))


def new_task_default_reuses(mod, label):
    """不带 --new-task 时，--hold 仍复用同一分支（默认行为未变）。"""
    gh = fresh({"r.txt": ("100644", b"v1\n")})
    write("r.txt", "v2\n")
    run(mod, gh, ["--yes", "--hold", "-b", "task/keep", "-m", "第一次"])
    write("r.txt", "v3\n")
    run(mod, gh, ["--yes", "--hold", "-m", "第二次"])
    branches = sorted(T.task_branches(gh))
    print(f"\n=== {label} ===")
    ck("仍是同一分支", branches == ["task/keep"], f"{branches}")
    return branches == ["task/keep"]


# ------------------------------------------------ 对抗性边界

def empty_file(mod, label):
    """清空已有文件：内容应变为空，不能被当成「无内容/未改动」跳过。"""
    gh = fresh({"e.txt": ("100644", b"placeholder\n")})
    open(os.path.join(ROOT, "e.txt"), "wb").close()
    out, err = run(mod, gh, ["--yes", "-m", "清空"])
    got = gh.files_of("main").get("e.txt")
    print(f"\n=== {label} ===")
    ck("推送无异常", err is None, f"(err={str(err)[:50]})")
    ck("远端内容为空", got is not None and got[1] == b"", f"(got={got!r})")
    return err is None and got is not None and got[1] == b""


def empty_new_file(mod, label):
    """新增一个空文件（远端没有）。"""
    gh = fresh({"k.txt": ("100644", b"k\n")})
    open(os.path.join(ROOT, "empty-new.txt"), "wb").close()
    out, err = run(mod, gh, ["--yes", "-m", "新增空文件"])
    got = gh.files_of("main").get("empty-new.txt")
    print(f"\n=== {label} ===")
    ck("空的新文件被推送", got is not None and got[1] == b"", f"(got={got!r})")
    return got is not None and got[1] == b""


def weird_names(mod, label):
    """文件名含换行/引号/反斜杠/前导横线/空格/中文/分号。"""
    names = ["with\nnewline.txt", "quote'.txt", 'dq".txt', "back\\slash.txt",
             "-leading-dash.txt", "s p a c e.txt", "中文.txt", "semi;.txt"]
    gh = fresh({"k.txt": ("100644", b"k\n")})
    written = []
    for n in names:
        try:
            with open(os.path.join(ROOT, n), "w") as f:
                f.write("v2\n")
            written.append(n)
        except OSError as e:
            print(f"      (跳过 {n!r}: {e})")
    out, err = run(mod, gh, ["--yes", *written, "-m", "特殊名"])
    missing = [n for n in written
               if (gh.files_of("main").get(n) or (None, None))[1] != b"v2\n"]
    print(f"\n=== {label} ===")
    ck("全部特殊名文件正确往返", not missing, f"(缺={missing})")
    return not missing


def deleted_file(mod, label):
    """删掉一个已跟踪文件：不支持删除，应提示跳过且不崩。"""
    gh = fresh({"d1.txt": ("100644", b"v1\n"), "d2.txt": ("100644", b"v2\n")})
    os.unlink(os.path.join(ROOT, "d1.txt"))
    out, err = run(mod, gh, ["--yes", "-m", "删了一个"])
    print(f"\n=== {label} ===")
    ck("未裸崩", err is None or "FileNotFoundError" not in str(err),
       f"(err={str(err)[:50]})")
    ck("有「不支持删除」提示", "删除" in out)
    ck("远端文件仍在", gh.files_of("main").get("d1.txt") is not None)
    return (err is None or "FileNotFoundError" not in str(err)) and "删除" in out


def empty_repo(mod, label):
    """空仓库（无任何文件）：init 与 push 都不崩。"""
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt"):
        try:
            os.unlink(STATE + ext)
        except (FileNotFoundError, IsADirectoryError):
            pass
    setup_repo({})
    gh = GH({})
    out1, err1 = run(mod, gh, ["--init-baseline", "--yes"])
    out2, err2 = run(mod, gh, ["--yes", "-m", "空仓库推送"])
    print(f"\n=== {label} ===")
    ck("init 不崩", err1 is None, f"(err={str(err1)[:50]})")
    ck("push 不崩", err2 is None, f"(err={str(err2)[:50]})")
    return err1 is None and err2 is None


def deep_nesting(mod, label):
    """20 层嵌套子目录：路径不被截断。"""
    deep = "/".join(f"d{i}" for i in range(20)) + "/leaf.txt"
    gh = fresh({"k.txt": ("100644", b"k\n")})
    full = os.path.join(ROOT, deep)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write("deep\n")
    out, err = run(mod, gh, ["--yes", deep, "-m", "深层"])
    got = gh.files_of("main").get(deep)
    print(f"\n=== {label} ===")
    ck("深层路径完整到达远端", got is not None and got[1] == b"deep\n",
       f"(got={str(got)[:60]})")
    return got is not None and got[1] == b"deep\n"


def many_files(mod, label):
    """100 个文件一次批量推送，全部到位。"""
    n = 100
    gh = fresh({"k.txt": ("100644", b"k\n")})
    for i in range(n):
        with open(os.path.join(ROOT, f"bulk{i}.txt"), "w") as f:
            f.write(f"c{i}\n")
    out, err = run(mod, gh, ["--yes", "-m", "批量"])
    missing = [i for i in range(n)
               if (gh.files_of("main").get(f"bulk{i}.txt") or (None, None))[1]
               != f"c{i}\n".encode()]
    print(f"\n=== {label} ===")
    ck(f"{n} 个文件全部到位", not missing, f"(缺 {len(missing)} 个)")
    return not missing


def resolve_loop(mod, label):
    """resolve 闭环：冲突 → 带标记推送被拒 → 手工改 → resolve → 推送成功。"""
    base = "one\ntwo\nthree\n"
    gh = fresh({"c.txt": ("100644", base.encode())})
    write("c.txt", base.replace("two", "TWO-B"))
    run(mod, gh, ["--yes", "--hold", "-b", "task/b", "-m", "我改 two"])
    T.other_commit(gh, {"c.txt": base.replace("two", "TWO-A").encode()})
    run(mod, gh, ["--merge", "--yes"])
    run(mod, gh, ["--pull", "--yes"])
    marked = "<<<<<<<" in read("c.txt")
    out, err = run(mod, gh, ["--yes", "-m", "带标记推"])
    blocked = err is not None and "冲突" in err
    write("c.txt", "one\nTWO-AB\nthree\n")
    run(mod, gh, ["--resolve", "c.txt"])
    run(mod, gh, ["--yes", "-m", "已解决"])
    print(f"\n=== {label} ===")
    ck("pull 标出冲突", marked)
    ck("带标记推送被拒", blocked)
    ck("resolve 后推送成功", main_file(gh, "c.txt") == "one\nTWO-AB\nthree\n")
    return marked and blocked and main_file(gh, "c.txt") == "one\nTWO-AB\nthree\n"


# ------------------------------------------------ 非 UTF-8 文件名

# Linux 上文件名是**任意字节**（除 / 和 NUL），不保证是合法 UTF-8。
BAD_NAME = b"bad\xff\xfename.txt"


def _make_bad_file():
    with open(os.path.join(ROOT.encode(), BAD_NAME), "wb") as f:
        f.write(b"v1\n")


def non_utf8_no_crash(mod, label):
    """含非法 UTF-8 文件名的仓库：推送不得抛未捕获异常。"""
    gh = fresh({"k.txt": ("100644", b"k\n")})
    _make_bad_file()
    out, err = run(mod, gh, ["--yes", "-m", "含非utf8"])
    crashed = ("UnicodeDecodeError" in str(err) or "UnicodeEncodeError" in str(err))
    print(f"\n=== {label} ===")
    ck("未因编解码异常崩溃", not crashed, f"(err={str(err)[:50]})")
    return not crashed


def non_utf8_explained(mod, label):
    """被跳过的文件必须说清楚，不能默默少推一个。"""
    gh = fresh({"k.txt": ("100644", b"k\n")})
    _make_bad_file()
    write("k.txt", "k2\n")
    out, err = run(mod, gh, ["--yes", "-m", "含非utf8"])
    print(f"\n=== {label} ===")
    ck("明确提到 UTF-8", "UTF-8" in out)
    ck("给出可操作建议", "改名" in out and "已忽略" in out)
    return "UTF-8" in out and "改名" in out and "已忽略" in out


def non_utf8_others_still_pushed(mod, label):
    """一个坏名字不能拖累同批的正常文件（部分失败要隔离）。"""
    gh = fresh({"k.txt": ("100644", b"k\n")})
    _make_bad_file()
    write("k.txt", "k2\n")
    out, err = run(mod, gh, ["--yes", "-m", "含非utf8"])
    print(f"\n=== {label} ===")
    ck("正常文件仍推送成功", main_file(gh, "k.txt") == "k2\n",
       f"(k.txt={main_file(gh, 'k.txt')!r})")
    return main_file(gh, "k.txt") == "k2\n"


def non_utf8_no_zombie_branch(mod, label):
    """崩溃也绝不能留下僵尸分支 —— 「只修一半」时最容易踩这个。

    只给 git() 加 surrogateescape 而不在建 payload 前过滤，崩溃会推迟到
    更晚的位置；在我的代码里实测崩在新加的 gitignored_set()（它把
    surrogate 写回 git 的 stdin），那时**分支可能已在远端建好**。
    """
    gh = fresh({"k.txt": ("100644", b"k\n")})
    _make_bad_file()
    write("k.txt", "k2\n")
    try:
        run(mod, gh, ["--yes", "-m", "含非utf8"])
    except BaseException:
        pass                                  # 崩了也要检查残留
    left = sorted(T.task_branches(gh))
    print(f"\n=== {label} ===")
    ck("远端无残留任务分支", not left, f"(残留={left})")
    return not left


def non_utf8_gitignored_set_safe(mod, label):
    """gitignored_set 自身不能被坏名字带崩（它单独起 git 子进程且要写 stdin）。"""
    fresh({"k.txt": ("100644", b"k\n")})
    _make_bad_file()
    bad_str = BAD_NAME.decode("utf-8", "surrogateescape")
    try:
        got = mod.gitignored_set(["k.txt", bad_str])
        ok = isinstance(got, set)
    except Exception as e:
        ok = False
        print(f"      💥 {type(e).__name__}: {e}")
    print(f"\n=== {label} ===")
    ck("gitignored_set 不崩", ok)
    return ok


# ------------------------------------------------ 远端新增文件的补齐

def pull_fetches_remote_new_files(mod, label):
    """远端新增、本地没有的文件，--pull 必须能补下来。

    原判据是「远端相对基线变过 且 本地还没合上」。但 init 会把远端所有文件
    （含本地没有的）都记进基线，于是「远端新增 → 记进基线 → 之后没再变过」
    被判成无需拉取 —— 本地永远缺这批文件，--pull 还报告
    「没有需要合并的远端改动」并谎称已同步。用户侧实测缺 148 个文件。

    另一半坑在循环内部：即便进了待合并集合，`base == remote`（基线记的就是
    远端当前 sha）会让它走进「远端无变化，本地改动原样保留」而跳过。
    所以两处都要对，缺一个就补不上。
    """
    n_local, n_new = 3, 20
    local_files = {f"src/local{i}.js": ("100644", f"local{i}\n".encode())
                   for i in range(n_local)}
    remote_files = dict(local_files)
    for i in range(n_new):
        remote_files[f"src/new{i}.js"] = ("100644", f"new{i}\n".encode())

    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt"):
        try:
            os.unlink(STATE + ext)
        except (FileNotFoundError, IsADirectoryError):
            pass
    setup_repo(local_files)
    gh = GH(remote_files)
    run(mod, gh, ["--init-baseline", "--yes"])
    out, err = run(mod, gh, ["--pull", "--yes"])

    got = sum(1 for i in range(n_new)
              if os.path.exists(os.path.join(ROOT, f"src/new{i}.js")))
    # 内容也要对，不能只是建了空文件
    content_ok = all(
        os.path.exists(os.path.join(ROOT, f"src/new{i}.js")) and
        open(os.path.join(ROOT, f"src/new{i}.js")).read() == f"new{i}\n"
        for i in range(n_new))
    no_false_claim = "没有需要合并的远端改动" not in out

    print(f"\n=== {label} ===")
    print(f"  补齐文件数              : {got} / {n_new}")
    print(f"  内容正确                : {content_ok}")
    print(f"  未谎报无需合并          : {no_false_claim}")
    return got == n_new and content_ok and no_false_claim


def init_reports_missing_files(mod, label):
    """init 时本地缺远端文件必须提示，不能一声不吭。

    完全静默的话，用户直到发现「本地少一批文件」才会察觉，
    而那时 --pull 又拉不下来（见上一个用例），问题会很难定位。
    """
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt"):
        try:
            os.unlink(STATE + ext)
        except (FileNotFoundError, IsADirectoryError):
            pass
    local_files = {"a.txt": ("100644", b"a\n")}
    remote_files = dict(local_files)
    for i in range(4):
        remote_files[f"m{i}.txt"] = ("100644", f"m{i}\n".encode())
    setup_repo(local_files)
    gh = GH(remote_files)
    out, err = run(mod, gh, ["--init-baseline", "--yes"])

    mentioned = "缺少" in out and "m0.txt" in out
    suggests = "--pull" in out

    print(f"\n=== {label} ===")
    print(f"  明确列出缺失文件        : {mentioned}")
    print(f"  给出 --pull 建议        : {suggests}")
    return mentioned and suggests


# ------------------------------------------------ 缓存失效

def local_state_map_reflects_latest_edit(mod, label):
    """先填充 detect_changes() 缓存、再改文件，local_state_map 必须给出新值。

    local_state_map() 只对 detect_changes() **返回的文件**重算 sha，
    其余沿用 `git ls-files -s` 的索引值。若缓存是文件被修改之前填的，
    刚改过的文件就不在列表里 → 拿到**索引里的旧 sha** →
    与远端比较时被判成「已一致」而跳过 → 改动静默丢失、零报错。

    用户实测踩到过：改了文件推送，脚本说「没有待推送的改动」，改动丢了。
    （规避办法是先 git add + commit 再推，那会让工作区变干净、
    缓存列表也为空，恰好绕开 —— 所以现象看起来像「不 commit 就有 bug」。）
    """
    fresh({"a.txt": ("100644", b"v1\n")})

    mod.ROOT, mod.STATE_PATH = ROOT, STATE
    mod.detect_changes()                    # ① 填充缓存（此时还是 v1）
    write("a.txt", "v2-MY-CHANGE\n")        # ② 改文件（缓存未刷新）

    lm = mod.local_state_map()              # ③ 不得沿用旧值
    got = lm.get("a.txt")
    want = T.sha(b"v2-MY-CHANGE\n")
    old = T.sha(b"v1\n")

    print(f"\n=== {label} ===")
    print(f"  lmap 给出   : {(got or (None, '?'))[1][:12]}")
    print(f"  期望(工作区) : {want[:12]}")
    print(f"  索引旧值    : {old[:12]}")
    return bool(got) and got[1] == want


def edit_after_cache_is_pushed(mod, label):
    """端到端：填缓存 → 改文件 → 推送，改动必须真的到远端。

    上一个是单元级验证；这个验真实推送结果 —— 光保证 lmap 数值正确
    还不够，要确认改动最终出现在远端（中间还有候选收集、diff 等环节）。
    """
    gh = fresh({"a.txt": ("100644", b"v1\n")})
    mod.ROOT, mod.STATE_PATH = ROOT, STATE
    mod.detect_changes()
    write("a.txt", "v2-MY-CHANGE\n")
    out, err = run(mod, gh, ["--yes", "-m", "缓存后改动"])

    final = main_file(gh, "a.txt")
    print(f"\n=== {label} ===")
    print(f"  远端内容含改动 : {'v2-MY-CHANGE' in (final or '')}")
    print(f"  未谎报无改动   : {'没有待推送的改动' not in out}")
    return "v2-MY-CHANGE" in (final or "") and "没有待推送的改动" not in out


def write_local_invalidates_cache(mod, label):
    """_write_local() 改写工作区后，缓存必须失效。

    只修 local_state_map() 是点上的修复；从源头让写入使缓存失效，
    才能覆盖「pull 写文件 → 后续再检测」这类调用点。
    """
    fresh({"a.txt": ("100644", b"v1\n")})
    mod.ROOT, mod.STATE_PATH = ROOT, STATE

    mod.detect_changes()                        # 填充缓存
    mod._write_local("a.txt", b"written\n", "100644")
    after = mod.detect_changes()                # 不 refresh，应已失效重算

    print(f"\n=== {label} ===")
    print(f"  写入后 detect_changes 含该文件 : {'a.txt' in after}")
    return "a.txt" in after


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/push_api.py"
    mod = T.load_mod(target, "demod")
    T._MOD = mod
    for fn in (gitignore_warns, gitignored_not_auto_pushed,
               typo_filename_warns, dir_named_warns, partial_typo_warns,
               method_validated, new_task_starts_fresh, new_task_default_reuses,
               empty_file, empty_new_file, weird_names, deleted_file,
               empty_repo, deep_nesting, many_files, resolve_loop,
               non_utf8_no_crash, non_utf8_explained,
               non_utf8_others_still_pushed, non_utf8_no_zombie_branch,
               non_utf8_gitignored_set_safe,
               pull_fetches_remote_new_files, init_reports_missing_files,
               local_state_map_reflects_latest_edit, edit_after_cache_is_pushed,
               write_local_invalidates_cache):
        try:
            RES.append((fn.__name__, fn(mod, fn.__name__)))
        except Exception:
            import traceback
            traceback.print_exc()
            RES.append((fn.__name__, False))

    # 收集**返回值**是必须的：只调用 fn() 而丢弃结果，那些用 return 而非
    # ck() 写成的用例就会被静默忽略 —— 实测过：坏副本上用例内部打印的是
    # 「补齐 0/20」，汇总却报 ALL PASS。测试形同虚设且极难察觉。
    T._rmtree_stubborn(ROOT)
    for ext in ("", ".corrupt"):
        try:
            os.unlink(STATE + ext)
        except (FileNotFoundError, IsADirectoryError):
            pass
    print("\n---- 汇总 ----")
    for n, ok in RES:
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    bad = [n for n, ok in RES if not ok]
    print("总判定:", "ALL PASS" if not bad else f"有失败 -> {bad}")
