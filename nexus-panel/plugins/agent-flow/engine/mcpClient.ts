/**
 * MCP 协议客户端（JSON-RPC 2.0 over HTTP）。
 *
 * ================= 为什么先做 HTTP 传输 =================
 *
 * MCP 有两种传输：stdio（起子进程）与 HTTP。
 * 先做 HTTP 的理由很实在：
 *   · 前端就能完成，不需要 Rust 起子进程 —— stdio 要 spawn + 双向管道，
 *     那是另一块作业，且你在本地另开了两个窗口在推进
 *   · 现有 postJson 已经能发 JSON 并拿到文本，不必新增依赖
 *   · 用户侧的 MCP server 大多也提供 HTTP 传输
 *
 * stdio 的口子留着（见下 `transport` 字段），接上后这一层不用改。
 *
 * ================= 关键取舍：不做静默降级 =================
 *
 * 握手失败、不支持的工具、调用报错 —— 全部**抛出明确错误**。
 * 假装成功（返回空工具列表）会比报错危险得多：
 * 用户会以为"连上了，只是这个 server 没有工具"，
 * 于是所有 MCP 节点凭空消失而不知原因。
 */

import type { McpToolSchema } from './mcpTools';
import { MCP_SINGLE_TIMEOUT_SEC, MCP_CALL_TIMEOUT_SEC } from './mcpTools';

/** 注入的发送函数，方便测试替换 */
export type HttpPost = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutSec: number,
) => Promise<{ status: number; text: string }>;

export type Transport = 'http' | 'stdio';

export type McpServerRef = {
  name: string;
  command?: string;
  url?: string;
};

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

export class McpError extends Error {
  constructor(message: string, readonly server: string, readonly detail?: string) {
    super(message);
    this.name = 'McpError';
  }
}

/* ------------------------------------------------------------------ */
/* JSON-RPC                                                            */
/* ------------------------------------------------------------------ */

type RpcResponse = {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

let rpcSeq = 0;
const nextId = (): number => {
  rpcSeq += 1;
  return rpcSeq;
};

/**
 * 解析响应体。
 *
 * MCP 的 streamable HTTP 允许返回 **SSE 格式**（`data: {...}`），
 * 不只是 JSON。只按 JSON 解析的话，遇到 SSE 会抛一个
 * "Unexpected token d" 这种完全看不懂的错误 ——
 * 用户会以为是 server 坏了，其实是传输格式没处理。
 */
/**
 * 判断这是不是一条**单条** JSON-RPC 响应 —— 只认对象。
 *
 * ================= 为什么必须排除数组 =================
 *
 * JSON-RPC 的**批处理**响应是数组（`[{...}, {...}]`）。
 * 而这一层的每个函数都是"发一个请求、收一个响应"，
 * 从来没发过批处理请求，所以收到数组就意味着"格式不认识"。
 *
 * 以前 `JSON.parse(src) as RpcResponse` 直接返回了数组 ——
 * `as` 是断言，不做检查，于是数组一路被当成合法响应：
 *
 *   listBody.result  → undefined（数组没有这个属性）
 *   raw = []         → 抛「返回了 0 个工具」
 *
 * 报错了，但**说错了原因**：真问题是格式不认识，而提示让人去查
 * "server 为什么没暴露工具"。
 *
 * callTool 那条路更糟 —— 它不查 result 是不是 undefined：
 *
 *   body.result → undefined → blocks = [] → text = ''
 *   return { ok: true, text: '', isError: false }
 *
 * **绿着成功、输出为空、什么都没做。** 与 runMcp 里那段注释说的是
 * 同一类失效：不报错、日志干净、界面上一切正常。
 *
 * 所以这里只认对象 —— 批处理数组按"读不懂"处理，让上层报出真原因。
 */
function isRpcObject(v: unknown): v is RpcResponse {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parseRpcBody(text: string): RpcResponse | null {
  const src = String(text ?? '').trim();
  if (!src) return null;

  // 先按 JSON 试 —— 大多数 server 走这条路
  if (src.startsWith('{') || src.startsWith('[')) {
    try {
      const one = JSON.parse(src) as unknown;
      // 数组（批处理）不算 —— 见上面 isRpcObject 的说明
      if (isRpcObject(one)) return one as RpcResponse;
    } catch {
      /* 落到 SSE 解析 */
    }
  }

  // SSE：可能有多个事件，取最后一个带 result / error 的
  let last: RpcResponse | null = null;
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as unknown;
      if (isRpcObject(obj)
        && (obj.result !== undefined || obj.error !== undefined)) {
        last = obj as RpcResponse;
      }
    } catch {
      /* 忽略心跳等无法解析的行 */
    }
  }
  return last;
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

export type McpSession = {
  server: string;
  transport: Transport;
  url: string;
  sessionId?: string;
};

/**
 * 握手。
 *
 * 返回会话信息（含 session id）。
 * MCP 要求先 initialize 才能调其它方法，跳过握手直接 tools/list
 * 会被拒绝 —— 而且拒绝信息往往只有一句 "no session"，很难定位。
 */
export async function initialize(
  ref: McpServerRef,
  httpPost: HttpPost,
  timeoutSec = MCP_SINGLE_TIMEOUT_SEC,
): Promise<McpSession> {
  const url = String(ref.url ?? '').trim();
  if (!url) {
    throw new McpError(
      `MCP 服务「${ref.name}」没有填 HTTP 地址`,
      ref.name,
      'stdio 传输（command 方式）还没接上，目前只能连 HTTP 的 MCP 服务',
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // MCP 规定必须同时接受这两种；只写 application/json 时，
    // 部分 server 会坚持以 SSE 返回，导致解析失败
    Accept: 'application/json, text/event-stream',
  };

  const res = await httpPost(url, {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nexus-panel-agent-flow', version: '1.0.0' },
    },
  }, headers, timeoutSec);

  if (res.status >= 400) {
    throw new McpError(
      `连不上 MCP 服务「${ref.name}」（HTTP ${res.status}）`,
      ref.name,
      trimText(res.text),
    );
  }

  const body = parseRpcBody(res.text);
  if (!body) {
    throw new McpError(
      `MCP 服务「${ref.name}」返回的内容读不懂`,
      ref.name,
      trimText(res.text),
    );
  }
  if (body.error) {
    throw new McpError(
      `MCP 服务「${ref.name}」握手失败：${body.error.message ?? '未知错误'}`,
      ref.name,
    );
  }

  return {
    server: ref.name,
    transport: 'http',
    url,
    sessionId: undefined, // 由调用方从响应头取；这里拿不到头，故留空
  };
}

function trimText(t: string): string {
  const s = String(t ?? '').trim().replace(/\s+/g, ' ');
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/* ------------------------------------------------------------------ */
/* 工具清单                                                            */
/* ------------------------------------------------------------------ */

type RawTool = {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  input_schema?: unknown;
};

/**
 * 拉工具清单（含握手）。
 *
 * 一次调用完成 initialize → notifications/initialized → tools/list，
 * 因为调用方（刷新逻辑）只关心"拿到工具"，拆成三步会让每个调用点
 * 都要重复这一段，漏一步就握手失败。
 */
export async function listTools(
  ref: McpServerRef,
  httpPost: HttpPost,
  timeoutSec = MCP_SINGLE_TIMEOUT_SEC,
): Promise<McpToolSchema[]> {
  const url = String(ref.url ?? '').trim();
  if (!url) {
    throw new McpError(
      `MCP 服务「${ref.name}」没有填 HTTP 地址`,
      ref.name,
      'stdio 传输还没接上，目前只能连 HTTP 的 MCP 服务',
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  // 1. initialize
  const initRes = await httpPost(url, {
    jsonrpc: '2.0', id: nextId(), method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nexus-panel-agent-flow', version: '1.0.0' },
    },
  }, headers, timeoutSec);

  /*
   * HTTP 错误与"读不懂"必须**分开说** ——
   *
   * 以前合成一句 `连不上：${body?.error?.message ?? 'HTTP ' + status}`：
   * 状态码是 200 而响应读不懂时（`body` 为 null），
   * 那句会退化成「**连不上**：HTTP **200**」—— 自相矛盾。
   *
   * 实测：把地址填成一个网页，就会拿到这一句。用户看到 200 却说连不上，
   * 只会以为程序坏了。而真实情况恰恰相反：**连上了**，
   * 只是对方返回的不是 MCP 响应（多半是地址填错了、或是登录页）。
   *
   * 下面 initialize() 那一份本来就是分开写的（对的），
   * 这里内联的这份是第二套实现 —— 于是两套口径不一致。
   */
  if (initRes.status >= 400) {
    throw new McpError(
      `连不上 MCP 服务「${ref.name}」（HTTP ${initRes.status}）`,
      ref.name,
      trimText(initRes.text),
    );
  }
  const initBody = parseRpcBody(initRes.text);
  if (!initBody) {
    throw new McpError(
      `MCP 服务「${ref.name}」返回的内容读不懂 —— 地址可能填错了（对方返回的不是 MCP 响应）`,
      ref.name,
      trimText(initRes.text),
    );
  }
  if (initBody.error) {
    throw new McpError(
      `MCP 服务「${ref.name}」握手失败：${initBody.error.message ?? '未知错误'}`,
      ref.name,
    );
  }

  // 2. 通知已初始化（不需要响应，但必须发，否则部分 server 拒绝后续调用）
  await httpPost(url, {
    jsonrpc: '2.0', method: 'notifications/initialized',
  }, headers, timeoutSec).catch(() => undefined);

  // 3. tools/list
  const listRes = await httpPost(url, {
    jsonrpc: '2.0', id: nextId(), method: 'tools/list', params: {},
  }, headers, timeoutSec);

  // 同上：HTTP 错误与"读不懂"分开，否则会说成「没返回工具清单：HTTP 200」
  if (listRes.status >= 400) {
    throw new McpError(
      `MCP 服务「${ref.name}」没返回工具清单（HTTP ${listRes.status}）`,
      ref.name,
      trimText(listRes.text),
    );
  }
  const listBody = parseRpcBody(listRes.text);
  if (!listBody) {
    throw new McpError(
      `MCP 服务「${ref.name}」的工具清单读不懂 —— 响应不是单条 JSON-RPC 响应`,
      ref.name,
      trimText(listRes.text),
    );
  }
  if (listBody.error) {
    throw new McpError(
      `MCP 服务「${ref.name}」没返回工具清单：${listBody.error.message ?? '未知错误'}`,
      ref.name,
      trimText(listRes.text),
    );
  }

  const result = listBody.result as { tools?: RawTool[] } | undefined;
  const raw = Array.isArray(result?.tools) ? result!.tools! : [];

  /*
   * 空清单**不静默通过** ——
   * 空可能是真的没有工具，也可能是协议走通了但字段名不认识
   * （比如 server 返回的是 tools 而不是 result.tools）。
   * 静默返回空会让"节点凭空消失"，用户没有任何线索。
   */
  if (raw.length === 0) {
    throw new McpError(
      `MCP 服务「${ref.name}」返回了 0 个工具`,
      ref.name,
      '可能是响应格式不认识，或这个 server 确实没暴露工具',
    );
  }

  return raw.map((t) => ({
    name: String(t.name ?? '').trim(),
    description: String(t.description ?? '').trim(),
    inputSchema: (t.inputSchema ?? t.input_schema ?? {}) as Record<string, unknown>,
  })).filter((t) => t.name.length > 0);
}

/* ------------------------------------------------------------------ */
/* 调用工具                                                            */
/* ------------------------------------------------------------------ */

export type McpCallResult = {
  ok: boolean;
  /** 取出的文本；content 里可能有多种块，拼起来 */
  text: string;
  isError?: boolean;
};

/**
 * 调一个工具。
 *
 * 与 listTools 一样自带握手 —— 每次调用都重新初始化看似浪费，
 * 但 MCP 的 HTTP 会话要保持 session id，而我们在拿不到响应头的情况下
 * 无法可靠地维持会话。重新握手的代价是一次往返，
 * 换来的是"不会因为过期会话而莫名其妙失败"。
 */
export async function callTool(
  ref: McpServerRef,
  tool: string,
  args: Record<string, unknown>,
  httpPost: HttpPost,
  timeoutSec = MCP_CALL_TIMEOUT_SEC,
): Promise<McpCallResult> {
  const url = String(ref.url ?? '').trim();
  if (!url) {
    throw new McpError(
      `MCP 服务「${ref.name}」没有填 HTTP 地址`, ref.name,
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  await httpPost(url, {
    jsonrpc: '2.0', id: nextId(), method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nexus-panel-agent-flow', version: '1.0.0' },
    },
  }, headers, timeoutSec);
  await httpPost(url, {
    jsonrpc: '2.0', method: 'notifications/initialized',
  }, headers, timeoutSec).catch(() => undefined);

  const res = await httpPost(url, {
    jsonrpc: '2.0', id: nextId(), method: 'tools/call',
    params: { name: tool, arguments: args ?? {} },
  }, headers, timeoutSec);

  const body = parseRpcBody(res.text);
  if (!body) {
    throw new McpError(
      `MCP 服务「${ref.name}」的响应读不懂`, ref.name, trimText(res.text),
    );
  }
  if (body.error) {
    throw new McpError(
      `调用 ${tool} 失败：${body.error.message ?? '未知错误'}`, ref.name,
    );
  }

  const r = body.result as { content?: unknown[]; isError?: boolean } | undefined;
  const blocks = Array.isArray(r?.content) ? r!.content! : [];
  const text = blocks.map((b) => {
    const o = b as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    return JSON.stringify(o);
  }).join('\n');

  return { ok: true, text, isError: r?.isError === true };
}

/* ------------------------------------------------------------------ */
/* 传输选择                                                            */
/* ------------------------------------------------------------------ */

/**
 * 判断用哪种传输。
 *
 * 填了 url 走 HTTP；只填 command 走 stdio —— 后者**暂未实现**，
 * 明确报错而不是悄悄当作 HTTP 去连（那会产生"地址为空"这种
 * 完全误导的错误信息）。
 */
export function transportOf(ref: McpServerRef): Transport {
  if (String(ref.url ?? '').trim()) return 'http';
  return 'stdio';
}

export function stdioSupported(): boolean {
  return false;
}
