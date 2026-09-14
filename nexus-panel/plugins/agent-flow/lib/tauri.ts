import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CliKind, FsOp, FsNodeData } from '../types';
import { isHttpUrl } from '../engine/llm';

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
  if (!isTauri()) {
    // 浏览器降级：模拟流式返回，仅用于验证画布与调度逻辑
    const text = `[模拟输出] ${req.cli} 收到任务:\n${req.prompt.slice(0, 200)}`;
    for (const piece of text.match(/[\s\S]{1,24}/g) ?? []) {
      h.onStdout(piece);
      await new Promise((r) => setTimeout(r, 30));
    }
    h.onDone({ code: 0, success: true });
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

  unlisteners.push(await listen<string>(out, (e) => h.onStdout(e.payload)));
  unlisteners.push(await listen<string>(err, (e) => h.onStderr(e.payload)));
  unlisteners.push(await listen<DonePayload>(done, (e) => finish(e.payload)));

  try {
    await invoke<void>('run_node', { req });
  } catch (e) {
    h.onStderr(`启动失败: ${String(e)}\n`);
    finish({ code: null, success: false });
  }
}

/** 终止正在跑的节点进程 */
export async function killCli(runId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>('kill_node', { runId });
}

/* ---------------- 文件监听（watch 触发器） ---------------- */

/**
 * 开始监听目录。文件变化会以 `watch-event/${id}` 事件推给前端。
 * 浏览器模式下返回 false，由调用方决定是否提示。
 */
export async function startWatch(
  id: string,
  dir: string,
  recursive: boolean,
  onEvent: (path: string) => void,
): Promise<(() => void) | null> {
  if (!isTauri() || !dir) return null;

  await invoke<void>('watch_start', { id, dir, recursive });
  const un = await listen<string>(`watch-event/${id}`, (e) => onEvent(e.payload));

  return () => {
    un();
    void invoke<void>('watch_stop', { id }).catch(() => {});
  };
}

/** 浏览器模式（非 Tauri）不支持文件监听 */
export function canWatch(): boolean {
  return isTauri();
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
): Promise<(() => void) | null> {
  if (!isTauri()) return null;

  try {
    await invoke<void>('webhook_start', { id, port, path, token });
  } catch (e) {
    console.error('启动 webhook 失败', e);
    return null;
  }
  const un = await listen<string>(`webhook-event/${id}`, (e) => onEvent(e.payload));

  return () => {
    un();
    void invoke<void>('webhook_stop', { id }).catch(() => {});
  };
}

/** 浏览器模式不支持起本地 HTTP 服务 */
export function canWebhook(): boolean {
  return isTauri();
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
  if (!isTauri()) {
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
  return isTauri();
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
/** 一次 HTTP 交换的结果。只要文本 —— 订阅源与大模型返回的都是文本。 */
type HttpResult = { ok: boolean; status: number; text: string };

/** 这些状态码按规范没有响应体，不必去读 */
const NO_BODY_STATUS = [101, 103, 204, 205, 304];

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
async function tauriHttpRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    connectTimeout?: number;
    maxBytes?: number;
  } = {},
): Promise<HttpResult | null> {
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

    const res = await invoke<{ status: number; rid: number }>('plugin:http|fetch_send', { rid });
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

    return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
  } catch {
    return null;
  }
}

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
  if (isTauri()) {
    const r = await tauriHttpRequest(url, {
      method: 'GET', headers, connectTimeout: timeoutMs, maxBytes: max,
    });
    if (r) return { ok: r.ok, status: r.status, text: r.text.slice(0, max) };
    // 返回 null：插件未启用或 scope 未放行该域名 —— 交给下面的浏览器路径再试一次
    console.warn('[agent-flow] Tauri http 通道不可用，尝试浏览器 fetch');
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
    throw new Error(
      `抓取失败（${msg}）。` + (isTauri()
        ? 'Tauri http 通道不可用，已退回浏览器请求，受 CORS 与 CSP connect-src 限制；多数订阅源会被拒绝（检查 Rust 侧是否启用了 tauri-plugin-http、capabilities 是否放行该域名）。'
        : '浏览器模式下多数订阅源不允许跨域，请用桌面端运行。'),
    );
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
  if (isTauri()) {
    const r = await tauriHttpRequest(url, {
      method: 'POST',
      headers,
      body: payload,
      connectTimeout: timeoutMs,
    });
    if (r) return { status: r.status, text: r.text };
    console.warn('[agent-flow] Tauri http 通道不可用，尝试浏览器 fetch');
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
      `请求失败（${msg}）。` + (isTauri()
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
  if (!isTauri()) {
    throw new Error('读取本地图片需要运行在桌面端（当前是浏览器模式）');
  }
  if (!path.trim()) throw new Error('图片路径为空');
  return await invoke<string>('af_read_image_data_url', { path });
}

/** 浏览器模式不支持读取本地图片 */
export function canReadImage(): boolean {
  return isTauri();
}
