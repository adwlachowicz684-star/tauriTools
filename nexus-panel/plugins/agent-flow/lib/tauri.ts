import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';
import { toOsKeyringRead, type OsKeyringRead } from '../engine/osKeyring';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CliKind, FsOp, FsNodeData } from '../types';
import { isHttpUrl } from '../engine/llm';
import { withinRoots } from '../engine/exportDir';
export { withinRoots };

/* ---------------- Tauri 通道：桥接优先，直连兜底 ----------------
   本插件跑在 iframe（沙箱）里，能不能直接调 Tauri 取决于沙箱强度：

     · 默认 iframe —— 与外壳同属一个 webview，window.__TAURI_INTERNALS__
       可见，直接 import 进来的 invoke / listen 就能用。
     · 严格沙箱 —— iframe 是 opaque origin，它那份 window 上没有
       __TAURI_INTERNALS__，直连全部失效，而且**不报错**：
       isTauri() 返回 false，功能要么悄悄走浏览器降级、要么抛
       「请运行在桌面端」，用户明明在桌面端却被这么提示。

   桥接（ctx.invoke）把命令转交主平台侧执行，隔离与否都走得通，
   所以调 Rust 一律桥接优先、直连兜底，不再一上来就直连。
   降级写法对照 plugins/settings/ExternalCard.tsx 的 bridge→direct。
   ------------------------------------------------------------------ */

/** 桥接只需要 invoke 这一种能力，多要一个字段就多一处要保持同步 */
type InvokeBridge = (cmd: string, args?: Record<string, any>) => Promise<any>;

let bridge: InvokeBridge | null = null;

/**
 * 注入桥接，由 main.tsx 拿到 ctx 后调用一次。
 * 传空表示没有桥接（例如脱离外壳单独打开页面调试），
 * 此时全部走直连，行为与改动前一致。
 */
export function setTauriBridge(ctx: unknown): void {
  const fn = (ctx as { invoke?: InvokeBridge } | null | undefined)?.invoke;
  bridge = typeof fn === 'function'
    ? (cmd, args) => (fn as InvokeBridge).call(ctx, cmd, args)
    : null;
}

/**
 * 调 Rust 的统一入口：先桥接，桥接不通再直连。
 * 两条路都失败就让错误冒泡 —— 不吞异常，调用方才好定位。
 */
async function invoke<T = any>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  if (bridge) {
    try {
      return await bridge(cmd, args);
    } catch (e) {
      console.warn(`[agent-flow] 桥接调用 ${cmd} 失败，回退直连`, e);
    }
  }
  return await tauriInvoke<T>(cmd, args);
}

/**
 * 是否具备调 Rust 的条件。
 *
 * 不能只看 isTauri()：隔离态下它是 false，可桥接其实还通着，
 * 照它判断会把「明明能用」的桌面端功能误判成浏览器模式。
 */
function hasTauri(): boolean {
  return !!bridge || isTauri();
}

/**
 * 能否收到 Rust 推的事件。
 *
 * 与 invoke 不同，事件只有直连一条路 —— 桥接明确不转发
 * （回调没法跨 postMessage 传，见 host.js 的 'listen' 分支），
 * 所以这一项仍以 isTauri() 为准。
 * 隔离态下拿不到事件，相关功能必须显式失败，
 * 不能让调用方傻等一个永远不会来的 done。
 */
function hasTauriEvents(): boolean {
  return isTauri();
}

export type RunRequest = {
  runId: string;
  cli: CliKind;
  /** CLI 可执行文件路径，留空则用 PATH 里的默认名 */
  cmd: string;
  prompt: string;
  workdir: string;
  model: string;
  yolo: boolean;
};

export type DonePayload = { code: number | null; success: boolean };

export type StreamHandlers = {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onDone: (p: DonePayload) => void;
};

/**
 * 启动一个 CLI 节点。
 * 在 Tauri 内走 Rust 的 shell 插件流式读取；
 * 在纯浏览器里降级为模拟输出，方便单独调试画布。
 */
export async function runCli(req: RunRequest, h: StreamHandlers): Promise<void> {
  if (!hasTauri()) {
    // 浏览器降级：模拟流式返回，仅用于验证画布与调度逻辑
    const text = `[模拟输出] ${req.cli} 收到任务:\n${req.prompt.slice(0, 200)}`;
    for (const piece of text.match(/[\s\S]{1,24}/g) ?? []) {
      h.onStdout(piece);
      await new Promise((r) => setTimeout(r, 30));
    }
    h.onDone({ code: 0, success: true });
    return;
  }

  // 命令发得出去（走桥接），事件却收不回来：进程会照常跑完，
  // 而前端既看不到输出、也等不到 done，节点永远停在 running。
  // 这种情况直接判死，好过静默卡住。
  if (!hasTauriEvents()) {
    h.onStderr('拿不到 Tauri 事件通道，CLI 节点无法运行（需桌面端，且本插件未被设为隔离模式）\n');
    h.onDone({ code: null, success: false });
    return;
  }

  const out = `cli-out/${req.runId}`;
  const err = `cli-err/${req.runId}`;
  const done = `cli-done/${req.runId}`;

  const unlisteners: UnlistenFn[] = [];
  let settled = false;

  const finish = (p: DonePayload) => {
    if (settled) return;
    settled = true;
    h.onDone(p);
    unlisteners.forEach((u) => u());
  };

  // listen 也包进 try：事件通道不可用时这里会抛，
  // 留在外面会变成 unhandled rejection，界面上什么都不显示
  try {
    unlisteners.push(await listen<string>(out, (e: { payload: string }) => h.onStdout(e.payload)));
    unlisteners.push(await listen<string>(err, (e: { payload: string }) => h.onStderr(e.payload)));
    unlisteners.push(await listen<DonePayload>(done, (e: { payload: DonePayload }) => finish(e.payload)));

    await invoke<void>('run_node', { req });
  } catch (e) {
    h.onStderr(`启动失败: ${String(e)}\n`);
    finish({ code: null, success: false });
  }
}

/** 终止正在跑的节点进程 */
export async function killCli(runId: string): Promise<void> {
  if (!hasTauri()) return;
  await invoke<void>('kill_node', { runId });
}

/* ---------------- 文件监听（watch 触发器） ---------------- */

/**
 * 开始监听目录。文件变化会以 `watch-event/${id}` 事件推给前端。
 * 浏览器模式下返回 null，由调用方决定是否提示。
 */
export async function startWatch(
  id: string,
  dir: string,
  recursive: boolean,
  onEvent: (path: string) => void,
): Promise<(() => void) | null> {
  if (!hasTauri() || !dir) return null;
  // 变化全靠 Rust 推事件，收不到事件就别起：
  // 起了也是个哑监听器，目录明明在变而界面毫无反应，比直接说不支持更难排查
  if (!hasTauriEvents()) return null;

  await invoke<void>('watch_start', { id, dir, recursive });
  const un = await listen<string>(`watch-event/${id}`, (e: { payload: string }) => onEvent(e.payload));

  return () => {
    un();
    void invoke<void>('watch_stop', { id }).catch(() => {});
  };
}

/** 浏览器模式（非 Tauri）不支持文件监听；隔离沙箱收不到事件，同样算不支持 */
export function canWatch(): boolean {
  return hasTauri() && hasTauriEvents();
}


/* ---------------- 调用触发（webhook） ---------------- */

/**
 * 启动本地 HTTP 服务，外部调用 URL 即触发工作流。
 * 事件名 `webhook-event/{id}`，payload 为请求体文本。
 */
export async function startWebhook(
  id: string,
  port: number,
  path: string,
  token: string,
  onEvent: (body: string) => void,
  /** 后端在 token 留空时会自动生成校验 Token 并返回，这里回传给界面提示用户 */
  onToken?: (token: string) => void,
): Promise<(() => void) | null> {
  if (!hasTauri()) return null;
  // 请求到达同样靠事件回传，没有事件通道就只是个开着的洞
  if (!hasTauriEvents()) return null;

  try {
    const effective = await invoke<string>('webhook_start', { id, port, path, token });
    if (effective && effective !== token) onToken?.(effective);
  } catch (e) {
    console.error('启动 webhook 失败', e);
    return null;
  }
  const un = await listen<string>(`webhook-event/${id}`, (e: { payload: string }) => onEvent(e.payload));

  return () => {
    un();
    void invoke<void>('webhook_stop', { id }).catch(() => {});
  };
}

/** 浏览器模式不支持起本地 HTTP 服务；隔离沙箱收不到事件，同样算不支持 */
export function canWebhook(): boolean {
  return hasTauri() && hasTauriEvents();
}

/* ---------------- 文件 / 文件夹操作 ---------------- */

export type FsArgs = {
  op: FsOp;
  path: string;
  target: string;
  content: string;
  recursive: boolean;
  force: boolean;
  dryRun: boolean;
  maxBytes: number;
  exts: string[];
};

export type FsOutcome = { ok: boolean; text: string };

/**
 * 执行一次文件或文件夹操作。
 *
 * 必须经 Rust：iframe 里没有磁盘访问权限。
 * 浏览器模式下直接抛错——不做模拟，因为"假装成功"比报错更危险，
 * 用户会以为工作流真的写了文件。
 */
export async function fileOp(args: FsArgs): Promise<FsOutcome> {
  if (!hasTauri()) {
    throw new Error('文件操作需要运行在桌面端（当前是浏览器模式）');
  }
  return await invoke<FsOutcome>('fs_op', { req: args });
}

/**
 * fs_op 的授权根目录管理。
 *
 * Rust 侧只接受落在授权根目录内的路径（canonicalize 后 starts_with），
 * 默认范围仅应用数据目录。要读写其它目录，必须先把它加进来 ——
 * 这是「读任意文件 + fetch 外传」组合风险的收敛点，不要图省事绕开。
 */
export async function fsAllowRoot(path: string): Promise<string[]> {
  return await invoke<string[]>('af_fs_allow_root', { path });
}

export async function fsListRoots(): Promise<string[]> {
  return await invoke<string[]>('af_fs_list_roots');
}

export async function fsDisallowRoot(path: string): Promise<string[]> {
  return await invoke<string[]>('af_fs_disallow_root', { path });
}

/** 从节点数据构造请求参数（已渲染过的 path/target/content 由调用方传入） */
export function fsArgsOf(
  data: FsNodeData,
  rendered: { path: string; target: string; content: string },
): FsArgs {
  return {
    op: data.op,
    path: rendered.path,
    target: rendered.target,
    content: rendered.content,
    recursive: data.recursive,
    force: data.force,
    dryRun: data.dryRun,
    maxBytes: data.maxBytes,
    exts: data.exts,
  };
}

/** 浏览器模式不支持文件操作 */
export function canFs(): boolean {
  return hasTauri();
}

/* ---------------- 目录浏览 / 导出落盘 ---------------- */

/**
 * 目录条目 —— 与 Rust 侧 fpx::model::DirEntryLite 对应。
 *
 * 刻意只取这三个字段：目录选择器只需要能显示名字、能往下钻。
 */
export type DirEntryLite = { name: string; path: string; has_child: boolean };

/**
 * 常用起点（桌面、文档、下载……），给目录选择器当首页。
 *
 * 走 fpx 的现成命令而不是新加 Rust ——
 * 为"选个目录"去引 tauri-plugin-dialog（要改 Cargo、重新编译、过打包），
 * 代价远大于复用已有的目录浏览能力。
 */
export async function listQuickRoots(): Promise<DirEntryLite[]> {
  const r = await invoke<DirEntryLite[]>('fpx_quick_roots');
  return Array.isArray(r) ? r : [];
}

/** 列某目录下的子目录 */
export async function listDirs(path: string): Promise<DirEntryLite[]> {
  const r = await invoke<DirEntryLite[]>('fpx_list_dirs', { path });
  return Array.isArray(r) ? r : [];
}

/**
 * 写文本文件到磁盘。
 *
 * 返回 ok —— 调用方**必须**看它，不能假定成功：
 * 以前导出用 <a download> 且 catch 是空的，
 * 下载被拦时日志照样打印"✅ 已导出"，失败伪装成成功。
 */
export async function writeTextFile(path: string, content: string): Promise<FsOutcome> {
  return await fileOp({
    op: 'write',
    path,
    target: '',
    content,
    recursive: false,
    force: true,
    dryRun: false,
    maxBytes: 0,
    exts: [],
  });
}

/** 确认目录存在（不存在则建）—— fs_op 的 write 不会自动建父目录 */
export async function ensureDir(path: string): Promise<FsOutcome> {
  return await fileOp({
    op: 'mkdir',
    path,
    target: '',
    content: '',
    recursive: true,
    force: false,
    dryRun: false,
    maxBytes: 0,
    exts: [],
  });
}

/** 当前已授权的根目录（fs_op 只接受落在这些目录内的路径） */
export async function listFsRoots(): Promise<string[]> {
  const r = await invoke<string[]>('af_fs_list_roots');
  return Array.isArray(r) ? r : [];
}

/** 目录选择能不能用：只有桌面端有（fpx 是 Rust 侧能力） */
export function canPickDir(): boolean {
  return hasTauri();
}

/** 导出能不能真正落盘到指定目录 */
export function canExportToFile(): boolean {
  return canFs();
}

/* ---------------- 网络抓取（B站 / 公众号节点用） ---------------- */

export type FetchTextOptions = {
  /** 额外的请求头，如 UA、Cookie */
  headers?: Record<string, string>;
  /** 超时秒数 */
  timeoutSec?: number;
  /** 响应体最大字节，超出截断。默认 2MB，避免异常源撑爆内存 */
  maxBytes?: number;
};

export type FetchTextResult = {
  ok: boolean;
  status: number;
  text: string;
};

/**
 * 抓取一段文本。
 *
 * 走 Tauri 的 http 插件（经 Rust 发出，不受浏览器同源策略限制）；
 * 浏览器模式下退化为原生 fetch —— 大多数源会因 CORS 失败，
 * 这时给明确提示，而不是静默返回空让人以为"确实没更新"。
 */
/**
 * 带响应头的完整结果。
 *
 * 少数场景必须读头：GitHub 令牌校验靠 `X-OAuth-Scopes` 判断读写权限，
 * 只拿文本就分不清 classic PAT 与 fine-grained PAT。
 */
export type FetchFullResult = FetchTextResult & {
  /** 键已统一转成小写，取值时不必再猜大小写 */
  headers: Record<string, string>;
};

/**
 * 抓取一段文本。
 *
 * 走 Tauri 的 http 插件（经 Rust 发出，不受浏览器同源策略限制）；
 * 浏览器模式下退化为原生 fetch —— 大多数源会因 CORS 失败，
 * 这时给明确提示，而不是静默返回空让人以为"确实没更新"。
 */
/** 一次 HTTP 交换的结果。只要文本 —— 订阅源与大模型返回的都是文本。 */
type HttpResult = FetchFullResult;

/** 这些状态码按规范没有响应体，不必去读 */
const NO_BODY_STATUS = [101, 103, 204, 205, 304];

/**
 * 把响应头规整成「小写键 → 值」。
 *
 * 两种来源形状不同：Rust 侧给的是 `[["a","1"],["b","2"]]`，
 * 浏览器侧是 `Headers` 对象。统一在这里收口，调用方只看一种格式。
 * 解析不出来就返回空对象 —— 头是辅助信息，不该因为格式变了就整条请求失败。
 */
function normalizeHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!h) return out;
    // [name, value][] —— Rust 侧与 Headers 迭代结果都是这个形状
    if (Array.isArray(h)) {
      for (const pair of h) {
        if (Array.isArray(pair) && pair.length >= 2) {
          out[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
      }
      return out;
    }
    if (typeof (h as Headers).forEach === 'function') {
      (h as Headers).forEach((v: string, k: string) => { out[String(k).toLowerCase()] = String(v); });
      return out;
    }
    if (typeof h === 'object') {
      for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
        out[k.toLowerCase()] = String(v);
      }
    }
  } catch { /* 头解析失败不影响主体 */ }
  return out;
}

/**
 * 经 Rust 的 tauri-plugin-http 发请求，绕过 webview 的同源策略。
 *
 * 这里**直接调插件的 IPC 命令**，不依赖 @tauri-apps/plugin-http 这个 npm 包。
 * 官方包本质上也只是对下面这几个 invoke 的封装（外加完整 Response 的流式语义），
 * 而本插件只用到"发请求 → 拿文本"，自己实现省掉一个依赖：
 * 拉下仓库不必为一个可选功能多装包，package-lock 也不用跟着动。
 *
 * Rust 侧启用插件的三处前提（见 src-tauri）：
 *   Cargo.toml 声明 tauri-plugin-http、main.rs 里 .plugin(init)、
 *   capabilities 放行 http(s)://**
 *
 * 返回 null 表示通道不可用（插件未启用 / scope 未放行 / 网络错误），
 * 由调用方降级到浏览器 fetch —— 不做"假装成功"。
 */
/**
 * Tauri 通道的失败原因。
 *
 * 审查项 A-04：原来一律 catch 成 null，界面只能说"受 CORS 限制"，
 * 把真正的原因（插件没启用 / scope 没放行 / 网络问题）全盖住了。
 * 分出来之后，提示语才能直指该改的地方。
 */
export type HttpFailureKind =
  /** 插件没启用或命令没注册 —— 要去 Rust 侧开 tauri-plugin-http */
  | 'no-plugin'
  /** 插件在，但目标域名没被 capabilities 放行 —— 要去加 scope */
  | 'no-scope'
  /** 通道正常，请求本身失败（DNS / 超时 / 对端拒绝） */
  | 'request';

export type HttpFailure = { kind: HttpFailureKind; message: string };

/** 一次 IPC 交换的结果：成功带响应，失败带原因 */
export type TauriHttpOutcome =
  | { ok: true; value: HttpResult }
  | { ok: false; failure: HttpFailure };

/**
 * 把 invoke 抛出的东西归类。
 *
 * Tauri 的报错是字符串，判断只能靠关键字匹配 —— 不优雅但有效；
 * 匹配不上就归到 request，至少不会把"插件没装"说成"网络不通"。
 */
function classifyInvokeError(e: unknown): HttpFailure {
  const msg = String(e instanceof Error ? e.message : e).toLowerCase();
  if (msg.includes('command not found') || msg.includes('command') && msg.includes('not found')) {
    return { kind: 'no-plugin', message: String(e) };
  }
  if (msg.includes('not allowed') || msg.includes('scope') || msg.includes('permission')
      || msg.includes('url not allowed')) {
    return { kind: 'no-scope', message: String(e) };
  }
  return { kind: 'request', message: String(e) };
}

/** 把失败原因翻译成人话，直接进运行日志 */
export function describeHttpFailure(f: HttpFailure): string {
  if (f.kind === 'no-plugin') {
    return 'Tauri http 插件未启用：请确认 Rust 侧注册了 tauri-plugin-http';
  }
  if (f.kind === 'no-scope') {
    return '目标域名未放行：请在 capabilities 里把该域名加进 http 的 scope';
  }
  return `请求失败（${f.message}）`;
}

async function tauriHttpRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    connectTimeout?: number;
    maxBytes?: number;
  } = {},
): Promise<TauriHttpOutcome> {
  try {
    const headers = Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)]);
    // 请求体按字节数组传给 Rust，与官方包一致（内部走 arrayBuffer 后转数组）
    const data = init.body
      ? Array.from(new TextEncoder().encode(init.body))
      : null;

    const rid = await invoke<number>('plugin:http|fetch', {
      clientConfig: {
        method: init.method ?? 'GET',
        url,
        headers,
        data,
        maxRedirections: 5,
        connectTimeout: init.connectTimeout ?? null,
        proxy: null,
      },
    });

    const res = await invoke<{
      status: number;
      rid: number;
      headers?: unknown;
    }>('plugin:http|fetch_send', { rid });
    const max = init.maxBytes ?? Infinity;

    let text = '';
    if (!NO_BODY_STATUS.includes(res.status)) {
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        // 每块的最后一个字节是结束标记：1 表示流已结束
        const buf = await invoke<number[]>('plugin:http|fetch_read_body', { rid: res.rid });
        const bytes = new Uint8Array(buf);
        if (bytes.byteLength === 0) break;
        const done = bytes[bytes.byteLength - 1] === 1;
        const chunk = bytes.subarray(0, bytes.byteLength - 1);
        parts.push(chunk);
        total += chunk.byteLength;
        if (done || total >= max) break;
      }
      const all = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { all.set(p, off); off += p.byteLength; }
      text = new TextDecoder('utf-8').decode(all);
      // 释放 Rust 侧的响应体资源（提前截断时尤其必要）
      void invoke('plugin:http|fetch_cancel_body', { rid: res.rid }).catch(() => {});
    }

    return {
      ok: true,
      value: {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text,
        headers: normalizeHeaders(res.headers),
      },
    };
  } catch (e) {
    return { ok: false, failure: classifyInvokeError(e) };
  }
}

/**
 * 发一个 HTTP 请求，返回文本 + 响应头。
 *
 * 通道与 `fetchText` 一致（先 Tauri 插件，失败降级浏览器），
 * 区别是能指定方法 / 请求体，并且把响应头带回来 ——
 * 校验 GitHub 令牌要靠 `X-OAuth-Scopes` 判读写权限，只拿文本不够。
 */
export async function httpRequest(
  url: string,
  opts: FetchTextOptions & {
    method?: string;
    body?: string;
    /** 是否补默认 UA。GitHub API 要用自己的 UA，关掉 */
    withDefaultUa?: boolean;
  } = {},
): Promise<FetchFullResult> {
  const max = opts.maxBytes ?? 2_000_000;
  const timeoutMs = Math.max(1, opts.timeoutSec ?? 15) * 1000;

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('地址必须以 http:// 或 https:// 开头');
  }

  const ua: Record<string, string> = opts.withDefaultUa === false ? {} : { 'User-Agent': UA };
  const headers = { ...ua, ...(opts.headers ?? {}) };

  // 1) 经 Rust 的 tauri-plugin-http（不受同源策略限制）
  let tauriFailure: HttpFailure | null = null;
  if (isTauri()) {
    const r = await tauriHttpRequest(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body,
      connectTimeout: timeoutMs,
      maxBytes: max,
    });
    if (r.ok) {
      return { ok: r.value.ok, status: r.value.status, text: r.value.text.slice(0, max), headers: r.value.headers };
    }
    // 通道没走通：记下原因，先降级到浏览器 fetch，两条都不通时再报出来
    tauriFailure = r.failure;
    console.warn('[agent-flow] Tauri http 通道不可用：', describeHttpFailure(r.failure));
  }

  // 浏览器模式：尽力而为
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await globalThis.fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body,
      signal: ac.signal,
    });
    const raw = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text: raw.slice(0, max),
      headers: normalizeHeaders(res.headers),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    /*
     * 两条通道都不通时报出来，带上各自的真实原因。
     * 此前一律写"受 CORS 限制"，把 no-plugin / no-scope 全盖住了 ——
     * 用户照着提示去查 CSP，其实该改的是 Rust 侧的插件或 scope。
     */
    const tauriHint = tauriFailure
      ? `${describeHttpFailure(tauriFailure)}；已退回浏览器请求，又受 CORS 与 CSP connect-src 限制（${msg}）`
      : `浏览器请求失败（${msg}）；浏览器模式下多数订阅源不允许跨域，请用桌面端运行`;
    throw new Error(`${tauriHint}。`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取一个 URL，返回文本 + 响应头。
 *
 * 与 `fetchText` 同一条通道、同一套降级逻辑，只是多带回头。
 * 需要头的调用方（令牌校验）用这个，其余继续用 `fetchText`。
 */

export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<FetchTextResult> {
  const max = opts.maxBytes ?? 2_000_000;
  const timeoutMs = Math.max(1, opts.timeoutSec ?? 15) * 1000;

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('地址必须以 http:// 或 https:// 开头');
  }

  const headers = {
    // B站接口对 UA 很敏感：不带浏览器 UA 大概率直接 -412
    'User-Agent': UA,
    ...(opts.headers ?? {}),
  };

  // 1) 经 Rust 的 tauri-plugin-http（不受同源策略限制）
  let tauriFailure: HttpFailure | undefined;
  if (hasTauri()) {
    const r = await tauriHttpRequest(url, {
      method: 'GET', headers, connectTimeout: timeoutMs, maxBytes: max,
    });
    if (r.ok) return { ok: r.value.ok, status: r.value.status, text: r.value.text.slice(0, max) };
    // 通道没走通：记下具体原因（插件未启用 / scope 未放行 / 请求出错），
    // 交给下面的浏览器路径再试一次；两条都不通时报出来，而不是一律甩锅 CORS
    tauriFailure = r.failure;
    console.warn('[agent-flow] Tauri http 通道不可用：', describeHttpFailure(r.failure));
  }

  // 浏览器模式：尽力而为
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await globalThis.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, ...(opts.headers ?? {}) },
      signal: ac.signal,
    });
    const raw = await res.text();
    return { ok: res.ok, status: res.status, text: raw.slice(0, max) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    /* 与 postJson 同一套降级文案：把 Tauri 通道的真实原因透出来
       （插件未启用 / 域名未放行 / 请求失败），而不是一律甩锅 CORS ——
       用户照着提示去查 CSP，其实该改的是 Rust 侧的插件注册或 scope。 */
    const tauriHint = tauriFailure
      ? `${describeHttpFailure(tauriFailure)}；已退回浏览器请求，又受 CORS 与 CSP connect-src 限制（${msg}）`
      : `浏览器请求失败（${msg}）；浏览器模式下多数订阅源不允许跨域，请用桌面端运行`;
    throw new Error(`${tauriHint}。`);
  } finally {
    clearTimeout(timer);
  }
}

/** 各源通用的浏览器 UA。B站不给这个会直接拒绝。 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/* ---------------- 大模型 API 调用 ---------------- */

export type PostJsonResult = { status: number; text: string };

/**
 * 发一个 POST JSON 请求（给 OCR / 翻译节点调大模型用）。
 *
 * 通道优先级与 fetchText 一致：先 Tauri http 插件（绕过 CORS），
 * 失败或不可用时退回浏览器 fetch。
 *
 * 这里刻意不解析 JSON —— 解析与错误归类交给 engine/llm.ts，
 * 那部分有单测；本文件只管把请求发出去。
 */
/** 审查项 A-03：postJson 的响应上限（8 MiB）。
 *
 * 大模型偶尔会返回异常大的响应（日志、超长生成），原先是 Infinity ——
 * 整包进内存再解码，足以把面板拖垮。 */
const POST_MAX_BYTES = 8 * 1024 * 1024;

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutSec: number,
): Promise<PostJsonResult> {
  if (!isHttpUrl(url)) {
    throw new Error('API 地址必须以 http:// 或 https:// 开头');
  }
  const timeoutMs = Math.max(1, timeoutSec) * 1000;
  const payload = JSON.stringify(body);

  // 请求体必须是已序列化的字符串：Rust 侧按字节数组接收，
  // 传对象会被 String() 成 "[object Object]"，请求体直接坏掉。
  if (hasTauri()) {
    const r = await tauriHttpRequest(url, {
      method: 'POST',
      headers,
      body: payload,
      connectTimeout: timeoutMs,
      // 审查项 A-03：原先是 Infinity，大模型返回异常大的响应会整包进内存
      maxBytes: POST_MAX_BYTES,
    });
    if (r.ok) return { status: r.value.status, text: r.value.text };
    console.warn('[agent-flow] Tauri http 通道不可用：', describeHttpFailure(r.failure));
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: ac.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || (err instanceof Error && err.name === 'AbortError')) {
      throw new Error(`请求超时（超过 ${timeoutSec} 秒）。长文本可考虑拆分成多个节点`);
    }
    throw new Error(
      `请求失败（${msg}）。` + (hasTauri()
        ? 'Tauri http 通道不可用，已退回浏览器请求，多数大模型 API 会因 CORS 被拒绝（检查 Rust 侧是否启用了 tauri-plugin-http，以及 CSP 的 connect-src 是否放行目标域名）。'
        : '浏览器模式下多数大模型 API 不允许跨域，请用桌面端运行。'),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取本地图片并转成 data URL。
 *
 * 需要桌面端：iframe 里没有磁盘权限，浏览器拿不到本地文件。
 * 走 Rust 命令 af_read_image_data_url（见 src-tauri 的 agent_flow_llm.rs）。
 */
export async function readImageDataUrl(path: string): Promise<string> {
  if (!hasTauri()) {
    throw new Error('读取本地图片需要运行在桌面端（当前是浏览器模式）');
  }
  if (!path.trim()) throw new Error('图片路径为空');
  return await invoke<string>('af_read_image_data_url', { path });
}

/**
 * 读取本地音频并转成 data URL。
 *
 * 与 readImageDataUrl 同构：都要经 Rust（iframe 没有磁盘权限）。
 * 走 af_read_audio_data_url，那边按扩展名判格式，
 * 不支持的后缀会直接给出可读的错误。
 */
export async function readAudioDataUrl(path: string): Promise<string> {
  if (!hasTauri()) {
    throw new Error('读取本地音频需要运行在桌面端（当前是浏览器模式）');
  }
  if (!path.trim()) throw new Error('音频路径为空');
  return await invoke<string>('af_read_audio_data_url', { path });
}

/** 浏览器模式不支持读取本地音频 */
export function canReadAudio(): boolean {
  return hasTauri();
}

/** 浏览器模式不支持读取本地图片 */
export function canReadImage(): boolean {
  return hasTauri();
}

/**
 * 取本机设备盐（连接加密用）。
 *
 * 盐原先存在 localStorage —— 同一页面上的任何脚本（包括别的插件）
 * 都能直接读走，拿到它 + 公开的本机特征就能算出连接密钥。
 * 现在由 Rust 侧生成并存在应用数据目录，只有能调这条命令的一方拿得到。
 *
 * 返回 null 表示拿不到（浏览器模式 / 隔离态 / 命令未注册），
 * 调用方应退回本地生成并落盘 —— 功能不能因为拿不到盐就坏掉。
 *
 * 注意它挡不住什么：盐文件在应用数据目录里明文明放，
 * 整个用户数据目录被拷走的人照样能拿到。它防的是"同页面其它代码顺手读"。
 */
/* ------------------------------------------------------------------ */
/* OS 连接管理器（保险箱主密钥）                                        */
/* ------------------------------------------------------------------ */

/*
 * 主密钥存进 OS 连接管理器：Windows 连接管理器 / macOS 钥匙串 /
 * Linux Secret Service。钥匙不在应用数据目录里，拷走目录也解不开。
 *
 * 三个函数都**不吞异常** —— 拿不到就是拿不到，要让上层明确知道，
 * 由它决定是否降级、怎么告诉用户。在这里静默返回 null 的话，
 * 上层会以为是"没存过"，于是新建一个密钥覆盖 —— 连接永久丢失。
 */
export type OsKeyringResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * 读主密钥。
 *
 * 直接返回 OsKeyringRead，让调用方能把它原样交给 planOsKeyringStart ——
 * 中间不经过任何"自己再判一遍"的转换，省掉一处可能写错的地方。
 */
export async function osKeyringGet(): Promise<OsKeyringRead> {
  /*
   * 用 hasTauri() 而不是 isTauri()：
   * 隔离态下 isTauri() 是 false，可桥接其实还通着（见 hasTauri 的说明）。
   * 照 isTauri 判断会把明明能用的桌面端误判成浏览器模式，
   * 于是用户无缘无故被告知"没有 OS 连接管理器"。
   */
  if (!hasTauri()) {
    return { ok: false, reason: '浏览器模式下没有 OS 连接管理器' };
  }
  try {
    const v = await invoke<string | null>('af_os_keyring_get');
    // 后端用 Option<String> 表示"没有"，到前端是 null
    return toOsKeyringRead(v);
  } catch (e) {
    return { ok: false, reason: describeInvokeErr(e, '读取 OS 连接管理器失败') };
  }
}

/** 写主密钥 */
export async function osKeyringSet(value: string): Promise<OsKeyringResult<true>> {
  if (!hasTauri()) {
    return { ok: false, reason: '浏览器模式下没有 OS 连接管理器' };
  }
  try {
    await invoke<void>('af_os_keyring_set', { value });
    return { ok: true, value: true };
  } catch (e) {
    return { ok: false, reason: describeInvokeErr(e, '写入 OS 连接管理器失败') };
  }
}

/** 删除主密钥。切换模式离开 OS 连接管理器时调用，不留残余 */
export async function osKeyringDelete(): Promise<OsKeyringResult<true>> {
  if (!hasTauri()) {
    return { ok: false, reason: '浏览器模式下没有 OS 连接管理器' };
  }
  try {
    await invoke<void>('af_os_keyring_delete');
    return { ok: true, value: true };
  } catch (e) {
    /*
     * 删不掉**不当失败**：记录不存在时后端也会报 NoEntry，
     * 而"没有这条"本来就是我们想要的结果。
     */
    return { ok: true, value: true };
  }
}

/** 把 Rust 侧透传的错误变成一句能看的话 */
function describeInvokeErr(e: unknown, prefix: string): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  const m = raw.trim();
  return m ? `${prefix}：${m}` : prefix;
}

export async function fetchDeviceSalt(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const s = await invoke<string>('af_device_salt');
    return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 读文件末尾（对话监听用）。
 *
 * 监听要隔几秒看一眼文件末尾有没有新消息。用 fs_op 的 read 得整读再切片，
 * 几十 MB 的 jsonl 每几秒整读一次，磁盘和内存都扛不住 —— 所以走 Rust 的
 * seek-from-end。
 *
 * 返回内容**可能以半截行开头**，调用方需丢掉第一行（见 engine/conversations）。
 * 拿不到（浏览器模式 / 隔离态 / 命令未注册）返回 null，调用方据此降级。
 */
export async function tailFile(path: string, maxBytes?: number): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>('af_fs_tail', { path, maxBytes: maxBytes ?? null });
  } catch {
    return null;
  }
}
