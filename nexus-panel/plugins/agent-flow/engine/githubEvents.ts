/**
 * GitHub 事件监听 —— 轮询部分（纯逻辑层，网络靠注入的 fetcher）。
 *
 * ================= 为什么先做轮询 =================
 *
 * 真 webhook 要**公网能访问到本机**：GitHub 主动发请求过来。
 * 而现在 webhook 绑的是 127.0.0.1（只听本机回环），GitHub 根本连不上 ——
 * 得先有内网穿透或公网 IP。
 *
 * 轮询不需要任何网络入口，立刻能用，所以它是托底方案：
 * webhook 配好了用它（秒级），配不好还有轮询（分钟级）。
 *
 * ================= 配额是核心约束 =================
 *
 * GitHub API 未鉴权 60 次/小时，带 token 5000 次/小时。
 * 4 种事件 × 每 60 秒一轮 = 240 次/小时，未鉴权直接爆。
 *
 * 所以**必须**用条件请求（If-None-Match / ETag）：
 * 没变化时 GitHub 返回 304，**不消耗配额**。
 * 有变化才返回 200 并计费。
 */

export type GithubEventKind = 'push' | 'pr' | 'issue' | 'release';

export const GITHUB_EVENT_KINDS: GithubEventKind[] = ['push', 'pr', 'issue', 'release'];

export const GITHUB_EVENT_LABEL: Record<GithubEventKind, string> = {
  push: '代码推送',
  pr: 'PR / 合并请求',
  issue: 'Issue / 评论',
  release: 'Release 发布',
};

/** 一种事件要查的 API 路径（相对 https://api.github.com） */
export function eventPath(kind: GithubEventKind, owner: string, repo: string, branch?: string): string {
  const o = encodeURIComponent(String(owner ?? '').trim());
  const r = encodeURIComponent(String(repo ?? '').trim());
  const base = `/repos/${o}/${r}`;
  switch (kind) {
    case 'push':
      /* per_page=1：只要最新一条，别把整个提交历史拉回来 */
      return `${base}/commits?per_page=1${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`;
    case 'pr':
      return `${base}/pulls?state=all&sort=updated&direction=desc&per_page=5`;
    case 'issue':
      return `${base}/issues?state=all&sort=updated&direction=desc&per_page=5`;
    case 'release':
      return `${base}/releases/latest`;
    default:
      return `${base}/commits?per_page=1`;
  }
}

/* ------------------------------------------------------------------ */
/* 事件标识                                                            */
/* ------------------------------------------------------------------ */

export type GithubEvent = {
  kind: GithubEventKind;
  /** 稳定标识：同一件事重复轮询不能算新事件 */
  id: string;
  title: string;
  /** 给下游节点看的正文（{{input}} 会拿到它） */
  body: string;
  url: string;
  actor: string;
  at: string;
};

function pick(o: unknown, k: string): unknown {
  if (!o || typeof o !== 'object') return undefined;
  return (o as Record<string, unknown>)[k];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * 从 API 响应里摘出"当前最新事件"。
 *
 * 返回 null 表示**解析不出来** —— 调用方必须区分
 * 「没变化」与「拿到了但看不懂」，后者要报错而不是静默跳过。
 */
export function latestEvent(kind: GithubEventKind, json: unknown): GithubEvent | null {
  if (kind === 'push') {
    const arr = Array.isArray(json) ? json : null;
    const c = arr && arr.length > 0 ? arr[0] : null;
    if (!c) return null;
    const commit = pick(c, 'commit') ?? {};
    const author = pick(c, 'author') ?? pick(commit, 'author') ?? {};
    return {
      kind,
      id: str(pick(c, 'sha')),
      title: `新提交 ${str(pick(c, 'sha')).slice(0, 7)}`,
      body: str(pick(commit, 'message')),
      url: str(pick(c, 'html_url')),
      actor: str(pick(author, 'login')) || str(pick(commit, 'author') && pick(pick(commit, 'author'), 'name')),
      at: str(pick(commit, 'author') && pick(pick(commit, 'author'), 'date')),
    };
  }

  if (kind === 'pr' || kind === 'issue') {
    const arr = Array.isArray(json) ? json : null;
    /*
     * issues API **会把 PR 一起返回**（PR 是一种 issue）。
     * 不过滤的话，只监听 Issue 的人会被 PR 刷屏，
     * 而且两条路径拿到同一件事，去重也拦不住 —— id 不同。
     */
    const list = (arr ?? []).filter((it) => {
      const isPr = pick(it, 'pull_request') != null;
      return kind === 'pr' ? isPr : !isPr;
    });
    const it = list.length > 0 ? list[0] : null;
    if (!it) return null;
    const user = pick(it, 'user') ?? {};
    const num = pick(it, 'number');
    return {
      kind,
      id: `${kind}-${str(num)}-${str(pick(it, 'updated_at'))}`,
      title: `${kind === 'pr' ? 'PR' : 'Issue'} #${str(num)}：${str(pick(it, 'title')).slice(0, 60)}`,
      body: str(pick(it, 'body')).slice(0, 4000),
      url: str(pick(it, 'html_url')),
      actor: str(pick(user, 'login')),
      at: str(pick(it, 'updated_at')),
    };
  }

  if (kind === 'release') {
    if (!json || typeof json !== 'object') return null;
    const tag = str(pick(json, 'tag_name'));
    if (!tag) return null;
    const author = pick(json, 'author') ?? {};
    return {
      kind,
      id: `release-${tag}`,
      title: `发布 ${tag}`,
      body: str(pick(json, 'body')).slice(0, 4000),
      url: str(pick(json, 'html_url')),
      actor: str(pick(author, 'login')),
      at: str(pick(json, 'published_at')) || str(pick(json, 'created_at')),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 去重                                                                */
/* ------------------------------------------------------------------ */

/**
 * 判断是不是新事件。
 *
 * 只看 id —— 用"时间更新过"判断会有个坑：
 * PR 被加了条评论也会更新 updated_at，于是 id 变、被判成新事件，
 * 实际上 PR 本身早报过了。所以 id 里带上 updated_at 是刻意的，
 * 但**同一轮内**的重复必须拦住。
 */
export function isNewEvent(id: string, seen: string[]): boolean {
  const s = String(id ?? '');
  if (!s) return false;
  return !(seen ?? []).includes(s);
}

/** 记录已见过的 id，只保留最近 N 个 —— 无限增长会撑爆存档 */
export function rememberEvent(id: string, seen: string[], keep = 50): string[] {
  const s = String(id ?? '');
  if (!s) return seen ?? [];
  const next = [s, ...(seen ?? []).filter((x) => x !== s)];
  return next.slice(0, keep);
}

/* ------------------------------------------------------------------ */
/* 条件请求（ETag 省配额）                                             */
/* ------------------------------------------------------------------ */

export type PollState = {
  /** 上一次收到的 ETag，下次带着走条件请求 */
  etag: string;
  /** 已见过的事件 id */
  seen: string[];
};

export function emptyPollState(): PollState {
  return { etag: '', seen: [] };
}

/** 构造条件请求头 */
export function condHeaders(token: string, etag: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nexus-panel-agent-flow',
  };
  const t = String(token ?? '').trim();
  if (t) h.Authorization = `Bearer ${t}`;
  const e = String(etag ?? '').trim();
  if (e) h['If-None-Match'] = e;
  return h;
}

/** 从响应头取 ETag（大小写不敏感） */
export function etagOf(headers: Record<string, string>): string {
  const h = headers ?? {};
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'etag') return String(h[k] ?? '');
  }
  return '';
}

export type PollOutcome = {
  /** 有没有变化 */
  changed: boolean;
  /** 新事件（changed 为 true 时才有） */
  event: GithubEvent | null;
  /** 更新后的状态，调用方要存下来 */
  next: PollState;
  /** 人话说明，进日志 */
  note: string;
  /** 配额相关提示 */
  limited: boolean;
};

/**
 * 处理一次轮询响应。
 *
 * 四种结果必须分开，不能都归成"没变化"：
 *
 *   304      → 真没变化，**不消耗配额**
 *   200      → 有变化，解析并去重
 *   403/429  → 配额耗尽 —— 这时**不该**继续按原频率轮询，
 *              否则只会一直撞墙。必须告诉调用方退避。
 *   其它     → 报错，让用户看到
 */
export function handlePollResponse(
  kind: GithubEventKind,
  prev: PollState,
  resp: { status: number; ok: boolean; text: string; headers: Record<string, string> },
): PollOutcome {
  const base: PollState = {
    etag: prev?.etag ?? '',
    seen: Array.isArray(prev?.seen) ? prev.seen : [],
  };
  const status = Number(resp?.status ?? 0);

  if (status === 304) {
    return { changed: false, event: null, next: base, note: '无变化（304，未消耗配额）', limited: false };
  }

  /* 配额耗尽 / 被限流 —— 继续按原频率撞墙只会更糟 */
  if (status === 403 || status === 429) {
    const remain = String((resp?.headers ?? {})['x-ratelimit-remaining'] ?? '');
    return {
      changed: false,
      event: null,
      next: base,
      note: `配额不足或被限流（HTTP ${status}${remain ? `，剩余 ${remain}` : ''}）—— 建议降低频率或填 Token`,
      limited: true,
    };
  }

  if (status === 404) {
    return {
      changed: false, event: null, next: base,
      note: '仓库不存在、已私有化，或无访问权限', limited: false,
    };
  }

  if (status < 200 || status >= 300) {
    return {
      changed: false, event: null, next: base,
      note: `查询失败（HTTP ${status}）`, limited: false,
    };
  }

  let json: unknown = null;
  try {
    json = JSON.parse(String(resp?.text ?? ''));
  } catch {
    return {
      changed: false, event: null, next: base,
      note: '响应不是合法 JSON', limited: false,
    };
  }

  const ev = latestEvent(kind, json);
  const nextEtag = etagOf(resp?.headers ?? {}) || base.etag;
  if (!ev) {
    /* 拿到了但看不懂 —— 与"没变化"区分开，静默跳过会让人以为一直在正常监听 */
    return {
      changed: false, event: null,
      next: { etag: nextEtag, seen: base.seen },
      note: '拿到了响应但没解析出事件（可能是空仓库）',
      limited: false,
    };
  }

  const seen = rememberEvent(ev.id, base.seen);
  const fresh = isNewEvent(ev.id, base.seen);
  return {
    changed: fresh,
    event: fresh ? ev : null,
    next: { etag: nextEtag, seen },
    note: fresh ? `发现${GITHUB_EVENT_LABEL[kind]}：${ev.title}` : '无新事件',
    limited: false,
  };
}

/* ------------------------------------------------------------------ */
/* 退避                                                                */
/* ------------------------------------------------------------------ */

/**
 * 被限流后的退避间隔（毫秒）。
 *
 * 撞墙后立刻重试只会再撞一次 —— 必须拉开间隔。
 * 上限 30 分钟：再长用户会以为监听挂了。
 */
export function backoffMs(attempt: number): number {
  const a = Math.max(0, Math.floor(Number(attempt ?? 0)));
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
  return steps[Math.min(a, steps.length - 1)];
}

/* ------------------------------------------------------------------ */
/* 给下游节点的文本                                                    */
/* ------------------------------------------------------------------ */

/**
 * 事件 → 下游节点拿到的文本。
 *
 * 给 JSON 而不是纯文本：下游可以用提取节点取具体字段。
 * 只给标题的话，"谁提的 PR""改了哪些文件"全都丢了。
 */
export function eventToText(ev: GithubEvent): string {
  if (!ev) return '';
  return JSON.stringify(
    { kind: ev.kind, id: ev.id, title: ev.title, body: ev.body, url: ev.url, actor: ev.actor, at: ev.at },
    null,
    2,
  );
}
