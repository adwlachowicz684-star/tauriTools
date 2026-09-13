import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CliKind, FsOp, FsNodeData } from '../types';

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
/**
 * 可选：Tauri 的 http 插件。
 *
 * Rust 端若未启用 tauri-plugin-http（当前仓库就没有，重构时删掉了），
 * 这里会拿到 null，调用方降级到浏览器 fetch。
 *
 * 用变量而非字面量做动态 import：这样 Rollup 无法静态解析，
 * 不会因为"包没装"而让整个构建失败（@vite-ignore 在 TS 转换后会被 esbuild 丢掉，靠不住）。
 */
async function loadTauriHttp(): Promise<null | ((url: string, init?: any) => Promise<Response>)> {
  if (!isTauri()) return null;
  try {
    const spec = '@tauri-apps/plugin-http';
    const mod: any = await import(/* @vite-ignore */ spec);
    return typeof mod?.fetch === 'function' ? mod.fetch : null;
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

  // 1) Tauri http 插件（仅当 Rust 端启用了 tauri-plugin-http 且前端装了对应 npm 包）
  const tauriFetch = await loadTauriHttp();
  if (tauriFetch) {
    try {
      const res = await tauriFetch(url, { method: 'GET', headers, connectTimeout: timeoutMs });
      const raw = await res.text();
      return { ok: res.ok, status: res.status, text: raw.slice(0, max) };
    } catch (err) {
      // 插件在但请求失败（如 scope 未放行该域名）→ 交给下面的浏览器路径再试一次
      console.warn('[agent-flow] Tauri http 请求失败，尝试浏览器 fetch：', err);
    }
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
        ? '当前外壳未启用 Tauri http 插件，请求走浏览器通道，受 CORS 与 CSP connect-src 限制；多数订阅源会被拒绝。'
        : '浏览器模式下多数订阅源不允许跨域，请用桌面端运行。'),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 各源通用的浏览器 UA。B站不给这个会直接拒绝。 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
