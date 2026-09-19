/**
 * GitHub webhook 的签名校验与事件识别 —— 纯逻辑层。
 *
 * ================= 为什么必须校验签名 =================
 *
 * webhook 一旦有公网地址，任何人都能往那个 URL 发请求。
 * 而触发器后面接的是**工作流**：能起 CLI、能读写授权目录。
 * 不校验签名等于把这些能力敞开给整个互联网。
 *
 * 现有的 token 校验认不出 GitHub 的请求：
 * GitHub 带的是 X-Hub-Signature-256: sha256=<HMAC-SHA256(body, secret)>，
 * 而现有实现比对的是自定义头的明文 token，两者完全对不上。
 *
 * ================= 关键安全性质 =================
 *
 * ① **必须用恒定时间比较**。
 *    用 === 比字符串会按字节提前退出，耗时差异可被逐字节爆破。
 *
 * ② **必须校验原始 body 字节**。
 *    先 JSON.parse 再 stringify 的话，空格/键序变了，签名就对不上 ——
 *    表现为"明明配对了 secret 却一直验不过"，极难排查。
 */

export type HookHeaders = Record<string, string>;

function lower(h: HookHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h ?? {})) out[k.toLowerCase()] = String(h[k] ?? '');
  return out;
}

export function headerOf(h: HookHeaders, name: string): string {
  return lower(h)[name.toLowerCase()] ?? '';
}

/* ------------------------------------------------------------------ */
/* 事件类型                                                            */
/* ------------------------------------------------------------------ */

export type HookEvent =
  | 'push' | 'pull_request' | 'issues' | 'issue_comment'
  | 'release' | 'ping' | 'unknown';

export const HOOK_EVENT_LABEL: Record<string, string> = {
  push: '代码推送',
  pull_request: 'PR',
  issues: 'Issue',
  issue_comment: 'Issue 评论',
  release: '发布',
  ping: '测试连通',
  unknown: '未知事件',
};

/** 从 X-GitHub-Event 头取事件类型 */
export function hookEventOf(h: HookHeaders): HookEvent {
  const v = headerOf(h, 'X-GitHub-Event').trim();
  const known: HookEvent[] = ['push', 'pull_request', 'issues', 'issue_comment', 'release', 'ping'];
  return (known as string[]).includes(v) ? (v as HookEvent) : 'unknown';
}

/**
 * ping 事件是 GitHub 在建 webhook 时发的测试包。
 * 它**不是**真正的业务事件 —— 当成 push 处理会莫名跑一次流程。
 */
export function isPing(h: HookHeaders): boolean {
  return hookEventOf(h) === 'ping';
}

/* ------------------------------------------------------------------ */
/* 签名                                                                */
/* ------------------------------------------------------------------ */

/** 解析 `sha256=<hex>` */
export function parseSignature(raw: string): { algo: string; hex: string } | null {
  const s = String(raw ?? '').trim();
  const i = s.indexOf('=');
  if (i <= 0) return null;
  const algo = s.slice(0, i).trim().toLowerCase();
  const hex = s.slice(i + 1).trim();
  if (!algo || !hex) return null;
  /* 只认 sha256 —— sha1 已被 GitHub 弃用，接受它等于接受弱校验 */
  if (algo !== 'sha256') return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return { algo, hex: hex.toLowerCase() };
}

/**
 * 恒定时间比较。
 *
 * 逐字节异或累积，不提前退出 —— 用 === 会因耗时差被逐字节爆破。
 * 长度不同时也不能直接返回 false 就了事，要参与累积。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const n = Math.max(sa.length, sb.length);
  let diff = sa.length === sb.length ? 0 : 1;
  for (let i = 0; i < n; i += 1) {
    const ca = i < sa.length ? sa.charCodeAt(i) : 0;
    const cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= (ca ^ cb) & 0xff;
  }
  return diff === 0;
}

export type VerifyInput = {
  /** **原始** body 文本，未经任何解析 */
  body: string;
  headers: HookHeaders;
  secret: string;
  /** 由调用方注入的 HMAC-SHA256 hex 计算（Rust 侧或 WebCrypto） */
  hmacHex: (key: string, msg: string) => Promise<string> | string;
};

export type VerifyResult = {
  ok: boolean;
  reason: string;
  event: HookEvent;
};

/**
 * 校验一个 GitHub webhook 请求。
 *
 * 失败原因必须具体 —— "签名不对"能指三件事：
 * secret 填错、body 被改过、算法不是 sha256。
 * 笼统报"验签失败"会让人反复重填 secret。
 */
export async function verifyGithubHook(input: VerifyInput): Promise<VerifyResult> {
  const ev = hookEventOf(input?.headers ?? {});
  const secret = String(input?.secret ?? '');
  if (!secret.trim()) {
    return { ok: false, reason: '没配 webhook secret —— 公网可访问的地址不校验签名等于敞开', event: ev };
  }

  const raw = headerOf(input?.headers ?? {}, 'X-Hub-Signature-256');
  if (!raw) {
    return { ok: false, reason: '请求没有 X-Hub-Signature-256 头，不是 GitHub 发来的', event: ev };
  }

  const parsed = parseSignature(raw);
  if (!parsed) {
    return { ok: false, reason: '签名格式不对（应为 sha256=<hex>）', event: ev };
  }

  let expect: string;
  try {
    expect = await input.hmacHex(secret, String(input?.body ?? ''));
  } catch (e) {
    return { ok: false, reason: `算签名失败：${String((e as Error)?.message ?? e)}`, event: ev };
  }

  if (!timingSafeEqual(expect.toLowerCase(), parsed.hex)) {
    return { ok: false, reason: '签名不匹配 —— 检查 secret 是否填对，以及 body 是否被中间环节改写', event: ev };
  }
  return { ok: true, reason: '', event: ev };
}

/* ------------------------------------------------------------------ */
/* 摘要：给下游节点看什么                                              */
/* ------------------------------------------------------------------ */

export type HookSummary = {
  event: HookEvent;
  label: string;
  title: string;
  actor: string;
  url: string;
};

function dig(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * 从 GitHub payload 摘出人能看懂的摘要。
 *
 * 完整 payload 很大（push 事件带全部 commit 与 diff），
 * 直接塞给下游会把 prompt 撑爆。摘要给关键字段，
 * 需要细节时下游再自己解析原始 payload。
 */
export function summarizeHook(ev: HookEvent, json: unknown): HookSummary {
  const label = HOOK_EVENT_LABEL[ev] ?? '未知事件';
  const pickActor = (): string =>
    s(dig(json, 'sender.login')) || s(dig(json, 'pusher.name')) || s(dig(json, 'comment.user.login'));

  if (ev === 'push') {
    const ref = s(dig(json, 'ref')).replace('refs/heads/', '');
    const commits = Array.isArray(dig(json, 'commits')) ? (dig(json, 'commits') as unknown[]) : [];
    const last = commits.length > 0 ? commits[commits.length - 1] : null;
    return {
      event: ev,
      label,
      title: `${ref} 收到 ${commits.length} 个提交${last ? `：${s(dig(last, 'message')).split('\n')[0].slice(0, 60)}` : ''}`,
      actor: pickActor(),
      url: s(dig(json, 'compare')),
    };
  }

  if (ev === 'pull_request' || ev === 'issues' || ev === 'issue_comment') {
    const pr = dig(json, 'pull_request') ?? dig(json, 'issue') ?? json;
    const num = s(dig(pr, 'number'));
    const act = s(dig(json, 'action'));
    return {
      event: ev,
      label,
      title: `#${num} ${act}：${s(dig(pr, 'title')).slice(0, 60)}`,
      actor: pickActor(),
      url: s(dig(pr, 'html_url')),
    };
  }

  if (ev === 'release') {
    return {
      event: ev,
      label,
      title: `${s(dig(json, 'action'))} ${s(dig(json, 'release.tag_name'))}`,
      actor: pickActor(),
      url: s(dig(json, 'release.html_url')),
    };
  }

  if (ev === 'ping') {
    return { event: ev, label, title: 'GitHub 在测试连通性（不是真实事件）', actor: '', url: '' };
  }

  return { event: ev, label, title: '未识别的事件', actor: pickActor(), url: '' };
}
