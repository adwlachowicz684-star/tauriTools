/**
 * 插件市场的文件能力桥（webview 侧）
 * ============================================================
 * 它解决一个很具体的问题：阶段 1–3 写好的逻辑层
 * （installed-plugin-scan / plugin-installer / plugin-ledger）
 * 全都 `import node:fs`，**在 webview 里跑不了**（浏览器没有 fs）。
 * 而插件商店面板（plugins/store）是 module 插件，恰在 webview 侧。
 *
 * 所以这些能力要么"永远没人调用"，要么就得有一条不依赖 node:fs 的路。
 * 本文件就是那条路：把后端已有的通用文件命令 `af_flow::fs_op`
 * 包装成本模块这一侧的文件接口。
 *
 * ------------------------------------------------------------
 * 🟢 为什么**不需要**新增 Rust 依赖或命令（纠正清单此前的判断）
 * ------------------------------------------------------------
 * 清单阶段 4.1 原先写着「tauri-plugin-fs 不在依赖里 → 要动 Rust」。
 * 那是只查了 `Cargo.toml` 有没有那个官方插件，**没查项目自己造了什么**。
 * 实测后端早就有一整套：
 *
 * | 能力 | 命令 |
 * |---|---|
 * | 通用文件操作（read/write/mkdir/delete/list/move/copy/exists/stat/glob） | `af_flow::fs_op` |
 * | 授权根白名单 | `af_fs_allow_root` / `af_fs_list_roots` / `af_fs_disallow_root` |
 * | 路径收口（白名单 + 系统目录黑名单） | `fpx::guard::must_be_under` |
 *
 * 而且 `fs_roots_snapshot()` 有**兜底**：应用数据目录（appDataDir）
 * 永远在授权根内 —— 「刚装好、还没配过任何目录」时也能写自己的数据区
 * （af_flow.rs 的注释就是这么写的）。
 *
 * → 结论：**装插件 / 存用户数据都不需要动 Rust，也不需要用户先授权**。
 *
 * ------------------------------------------------------------
 * 三条硬约束（改代码前先看）
 * ------------------------------------------------------------
 *
 * 1. **路径校验一律交给后端，前端不重复做。**
 *    fs_op 内部走 `resolve_within` → `fpx::guard::must_be_under`，
 *    而 guard.rs 的注释明确写着：每个命令各写一套（或干脆不写）校验
 *    「迟早漏一个」。前端再写一套就是第三套，且判定规则（canonicalize
 *    后组件级比较）在 JS 侧复刻不了 —— **两套规则必然不一致**，
 *    不一致的结果不是更安全，是"前端说安全、后端说越权"或反之。
 *    → 所以这里**只传路径，不校验路径**。
 *
 * 2. **`write` 只能写文本，写不了二进制。**
 *    后端是 `std::fs::write(&p, req.content.as_bytes())` —— 把字符串当
 *    字节写，**没有 base64 解码分支**。实测确认，不是推断。
 *    → 市场插件里的二进制资源（.ico / .png / 字体）只能 **data URI
 *      内联进文本产物**。这恰好与阶段 0 那个「坑①的天然绕法」一致：
 *      要求插件构建成单文件，既绕开 asset 协议的相对资源解析问题，
 *      也绕开这里写不了二进制的限制。
 *
 * 3. **失败一律 throw，不返回 `{ok:false}`。**
 *    Tauri 的 invoke 失败是 reject；若在这里包成 `{ok:false}` 返回，
 *    调用方一旦忘记检查就变成"失败静默通过" —— 本项目反复栽的那一类。
 *    抛错至少会让 Promise 链断在这里。
 *
 * ------------------------------------------------------------
 * 刻意不提供的能力
 * ------------------------------------------------------------
 * `stat`：后端把结构化信息塞进一段展示文本
 *   （`类型: 文件\n大小: 123 字节\n修改时间(Unix 秒): …\n只读: …`）。
 * 解析它要靠中文标签与换行切分，改一次文案就断 —— **脆**。
 * 需要"存不存在"用 `exists()`（后端返回稳定的 "true"/"false"）；
 * 需要大小就 `readText` 后自己算，或将来后端补一个结构化命令。
 */

/**
 * 调一次后端 fs_op。
 *
 * @param {(cmd:string,args:object)=>Promise<any>} invoke
 * @param {object} req 见 FsRequest（后端 af_flow.rs）
 * @returns {Promise<string>} FsResult.text
 */
export async function fsOp(invoke, req) {
  if (typeof invoke !== 'function') {
    throw new Error('plugin-fs-bridge: 缺少 invoke（不在 Tauri 壳内，且未注入实现）');
  }
  const args = {
    op: req.op,
    path: req.path,
    target: req.target == null ? '' : String(req.target),
    content: req.content == null ? '' : String(req.content),
    recursive: !!req.recursive,
    force: !!req.force,
    dryRun: !!req.dryRun,
  };
  if (req.maxBytes != null) args.maxBytes = req.maxBytes;
  if (Array.isArray(req.exts)) args.exts = req.exts;

  const r = await invoke('fs_op', args);
  // 后端 Ok(FsResult{ok,text}) 会被序列化成对象；拿不到就当失败
  if (!r || typeof r !== 'object') {
    throw new Error(`fs_op ${req.op} 返回异常: ${String(r)}`);
  }
  return r.text;
}

/**
 * readdir 的空目录回执（后端写死的文案，见 af_flow.rs "list" 分支）。
 *
 * 为什么导出：它是对面写死的字符串，改一次文案这里的解析就断。
 * 导出后测试能拿它构造样本，**并**断言它与后端源码里的文案一致 ——
 * 后端真改了，那条断言会红，而不是我们对着旧文案解析出错误结果。
 */
export const EMPTY_DIR_TEXT = '（空目录）';

/**
 * 造一个文件能力对象。
 *
 * 为什么做成工厂而不是直接 import invoke：
 * 逻辑层（installer / ledger）将来要能在**两种**环境跑 ——
 * webview 里注入这里的异步实现，Node 测试里注入 node:fs 实现。
 * 写死 import 就只有一种环境能用。
 */
export function createFs(invoke) {
  const call = (req) => fsOp(invoke, req);

  return {
    /** 读文本。maxBytes 交给后端截断（默认 8MiB，硬上限 64MiB） */
    async readText(path, opts = {}) {
      return call({ op: 'read', path, maxBytes: opts.maxBytes });
    },

    /** 写文本（覆盖）。父目录由后端 create_dir_all 自动补 */
    async writeText(path, content) {
      return call({ op: 'write', path, content });
    },

    async appendText(path, content) {
      return call({ op: 'append', path, content });
    },

    async mkdir(path) {
      return call({ op: 'mkdir', path });
    },

    /**
     * 删除。目录**必须**显式 force（后端对目录有二次确认设计：
     * 不传 force 会直接拒绝删目录并提示"确认要连同内容一起删除请勾选"）。
     * 这里不替调用方默认开 force —— 默认开等于替用户确认了删除。
     */
    async remove(path, opts = {}) {
      return call({ op: 'delete', path, force: opts.force });
    },

    /**
     * 列目录。后端返回换行分隔的文本；空目录是"（空目录）"。
     * 文件/目录在文本里没有区分标记，需要区分请用 exts 过滤或另外 exists。
     */
    async readdir(path, opts = {}) {
      const text = await call({
        op: 'list',
        path,
        recursive: opts.recursive,
        exts: opts.exts,
      });
      if (!text || text === EMPTY_DIR_TEXT) return [];
      return text.split('\n').map((s) => s.trim()).filter(Boolean);
    },

    /** 存在性。后端返回 "true"/"false" 字符串 */
    async exists(path) {
      const text = await call({ op: 'exists', path });
      return String(text).trim() === 'true';
    },

    async move(src, dst, opts = {}) {
      return call({ op: 'move', path: src, target: dst, dryRun: opts.dryRun });
    },

    async copy(src, dst, opts = {}) {
      return call({ op: 'copy', path: src, target: dst, dryRun: opts.dryRun });
    },

    /**
     * 演练（dryRun）：后端只返回会做什么，不真做。
     * 供"卸载前先看会删什么"这类只读报告用 —— 与 plugin-fs 的只读报告制
     * 是同一个原则：先出报告，再由用户确认。
     */
    async dryRun(req) {
      return call({ ...req, dryRun: true });
    },
  };
}

/**
 * 取应用数据目录的绝对路径（fs_op 要绝对路径才能过 resolve_within）。
 *
 * 拿不到时返回 null 而**不是**抛错：浏览器里调 UI 时没有 Tauri，
 * 让它崩掉会导致面板整个打不开 —— 那是"调试环境退化成不可用"。
 * 调用方拿到 null 应自行降级（比如提示"仅在客户端内可用"）。
 */
export async function resolveDataDir() {
  try {
    const pathApi = await import('@tauri-apps/api/path');
    if (pathApi && typeof pathApi.appDataDir === 'function') {
      return await pathApi.appDataDir();
    }
  } catch {
    /* 没装 npm 包或不在壳内 */
  }
  const w = typeof window !== 'undefined' ? window : globalThis;
  const g = w.__TAURI_INTERNALS__;
  if (g && g.path && typeof g.path.appDataDir === 'function') {
    try {
      return await g.path.appDataDir();
    } catch {
      /* 忽略，走下面的 null */
    }
  }
  return null;
}
