/**
 * GitHub 读取 / 推送 —— 纯逻辑层，网络通过注入的 fetcher 完成（便于测试）。
 *
 * 每个动作都有多条路，一条不通换下一条：
 *
 *   拉取  api  → REST API，要 token（公开库可不填）
 *         atom → commits/*.atom，免 token，仅限公开库
 *         cli  → git ls-remote，走本地 git
 *
 *   推送  api  → contents API，免本地 git 环境
 *         cli  → git commit + push，需要本地仓库与 workdir
 *
 * 为什么做兜底而不是只留一条：这几种失败都很常见且互不相干 ——
 * token 过期、仓库是私有的、机器上没装 git、公司网络只放行部分域名。
 * 只留一条的话，撞上任意一种就彻底用不了。
 */

export type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResp>;

export type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type FetchResp = {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
};

export type GithubTarget = {
  owner: string;
  repo: string;
  branch?: string;
};

export type UpdateInfo = {
  /** 默认分支名 */
  branch: string;
  /** 最新提交 sha */
  sha: string;
  /** 最新提交信息首行 */
  message: string;
  /** 提交作者 */
  author: string;
  /** 提交时间 ISO 串 */
  date: string;
  /** 相对 base 落后/领先的提交数；base 为空时是 0 */
  ahead: number;
  behind: number;
  /** 是否有更新（base 与最新 sha 不同） */
  updated: boolean;
  /** 走了哪条路 */
  via: string;
};

export type PushFile = { path: string; content: string };

export type PushResult = {
  ok: boolean;
  /** 提交 sha 或 commit 号 */
  commit: string;
  branch: string;
  files: string[];
  via: string;
  message: string;
};

export type FallbackDiag = { strategy: string; error: string };

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 以下结果类型一律用别名，不写成内联的多行对象字面量。
 * 一是签名更好读，二是跨行返回类型写在签名里会盖住函数体。
 */
export type AtomEntry = {
  sha: string;
  message: string;
  author: string;
  date: string;
};

export type TokenCheck = {
  ok: boolean;
  status: number;
  scopes: string | null;
  login: string;
  message: string;
};

export type ScopeInfo = {
  capabilities: string[];
  ambiguous: boolean;
};

/** 兜底执行器的结果：成功带走了哪条路，失败带全部诊断 */
export type FallbackOutcome<T> =
  | { ok: true; value: T; via: string }
  | { ok: false; error: string; diags: FallbackDiag[] };

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function authHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agent-flow',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
  return out;
}

/** 从 atom 订阅里抓第一个 entry 的标题 / 时间 / 作者 / sha */
export function parseAtom(xml: string): AtomEntry | null {
  if (!xml) return null;
  const entry = /<entry>[\s\S]*?<\/entry>/.exec(xml);
  const src = entry ? entry[0] : xml;

  const id = /<id>[^<]*Commit\/([0-9a-f]{7,40})<\/id>/i.exec(src);
  const title = /<title>([\s\S]*?)<\/title>/.exec(src);
  const updated = /<updated>([\s\S]*?)<\/updated>/.exec(src);
  const name = /<name>([\s\S]*?)<\/name>/.exec(src);

  // sha 是判断"有没有更新"的唯一可靠依据，没有就当解析失败
  if (!id) return null;

  return {
    sha: id[1],
    message: title ? decodeXml(title[1].trim()) : '',
    author: name ? decodeXml(name[1].trim()) : '',
    date: updated ? updated[1].trim() : '',
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 解析 `git ls-remote` 的一行输出 */
export function parseLsRemote(out: string, branch: string): string | null {
  if (!out) return null;
  const lines = out.split('\n');
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    // 形如 "<sha>\trefs/heads/main"
    const m = /^([0-9a-f]{7,40})\s+refs\/heads\/(.+)$/.exec(t);
    if (m && m[2] === branch) return m[1];
  }
  return null;
}

/** 判断 http 状态对应的人话提示 */
export function httpHint(status: number): string {
  if (status === 401) return '401 令牌无效或已过期。';
  if (status === 403) return '403 被拒绝：权限不足，或触发了速率限制（未带令牌时限额很低）。';
  if (status === 404) return '404 找不到：仓库名写错了，或令牌无权访问这个私有库。';
  if (status === 422) return '422 参数被拒：分支不存在，或 sha 与远端不一致。';
  if (status === 409) return '409 冲突：目标分支已更新，或文件 sha 不匹配。';
  return `HTTP ${status}`;
}

/* ------------------------------------------------------------------ */
/* 兜底执行器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 依次尝试策略，返回第一个成功的结果。
 * 全部失败时把所有原因汇总进 error —— 只报最后一条的话，
 * 用户看到的是"最不相关那条路"的失败，容易误判。
 */
export async function runWithFallback<T>(
  strategies: { name: string; run: () => Promise<Attempt<T>> }[],
): Promise<FallbackOutcome<T>> {
  const diags: FallbackDiag[] = [];
  for (const s of strategies) {
    let r: Attempt<T>;
    try {
      r = await s.run();
    } catch (e) {
      r = { ok: false, error: String(e && (e as Error).message ? (e as Error).message : e) };
    }
    if (r.ok) return { ok: true, value: r.value, via: s.name };
    diags.push({ strategy: s.name, error: r.error });
  }
  const summary = diags.map((d) => `${d.strategy}: ${d.error}`).join(' ｜ ');
  return { ok: false, error: `所有方案都失败 —— ${summary}`, diags };
}

/* ------------------------------------------------------------------ */
/* 拉取                                                                */
/* ------------------------------------------------------------------ */

export type UpdateOptions = {
  token: string;
  /** 本地 HEAD，用于判断是否有更新；留空表示只取远端状态 */
  base?: string;
  /** 策略顺序，默认 api → atom → cli */
  order?: string[];
  /** cli 方案的执行器（注入，便于测试） */
  cli?: (args: string[]) => Promise<string>;
};

async function byApi(
  f: Fetcher,
  t: GithubTarget,
  o: UpdateOptions,
): Promise<Attempt<UpdateInfo>> {
  const br = t.branch || '';
  const metaUrl = `https://api.github.com/repos/${t.owner}/${t.repo}`;
  const mr = await f(metaUrl, { headers: authHeaders(o.token) });
  if (!mr.ok) return { ok: false, error: `读取仓库信息失败 ${httpHint(mr.status)}` };

  let defBranch = br;
  try {
    const j = JSON.parse(mr.text);
    if (!br && j && typeof j.default_branch === 'string') defBranch = j.default_branch;
  } catch {
    // 元信息解析失败不致命，分支名可能由调用方直接给了
  }
  if (!defBranch) defBranch = 'main';

  const cUrl =
    `https://api.github.com/repos/${t.owner}/${t.repo}/commits` +
    `?sha=${encodeURIComponent(defBranch)}&per_page=1`;
  const cr = await f(cUrl, { headers: authHeaders(o.token) });
  if (!cr.ok) return { ok: false, error: `读取提交失败 ${httpHint(cr.status)}` };

  let arr: unknown;
  try {
    arr = JSON.parse(cr.text);
  } catch {
    return { ok: false, error: '提交列表不是合法 JSON' };
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    return { ok: false, error: '仓库还没有任何提交' };
  }
  const c = arr[0] as Record<string, unknown>;
  const sha = typeof c.sha === 'string' ? c.sha : '';
  if (!sha) return { ok: false, error: '提交缺少 sha' };

  const commit = (c.commit || {}) as Record<string, unknown>;
  const author = (commit.author || {}) as Record<string, unknown>;
  const base = (o.base || '').trim();

  return {
    ok: true,
    value: {
      branch: defBranch,
      sha,
      message: typeof commit.message === 'string' ? commit.message.split('\n')[0] : '',
      author: typeof author.name === 'string' ? author.name : '',
      date: typeof author.date === 'string' ? author.date : '',
      // 只比对短 sha：base 常来自 git rev-parse --short
      ahead: base && !sha.startsWith(base) ? 1 : 0,
      behind: 0,
      updated: base ? !sha.startsWith(base) : false,
      via: 'api',
    },
  };
}

async function byAtom(
  f: Fetcher,
  t: GithubTarget,
  o: UpdateOptions,
): Promise<Attempt<UpdateInfo>> {
  // atom 免 token，但只有公开仓库可取
  const br = t.branch || 'HEAD';
  const url = `https://github.com/${t.owner}/${t.repo}/commits/${br}.atom`;
  const r = await f(url, { headers: { 'User-Agent': 'agent-flow' } });
  if (!r.ok) return { ok: false, error: `atom 拉取失败 ${httpHint(r.status)}（私有库不可用）` };

  const p = parseAtom(r.text);
  if (!p) return { ok: false, error: 'atom 内容解析不出提交' };

  const base = (o.base || '').trim();
  return {
    ok: true,
    value: {
      branch: br,
      sha: p.sha,
      message: p.message,
      author: p.author,
      date: p.date,
      ahead: base && !p.sha.startsWith(base) ? 1 : 0,
      behind: 0,
      updated: base ? !p.sha.startsWith(base) : false,
      via: 'atom',
    },
  };
}

async function byCli(
  t: GithubTarget,
  o: UpdateOptions,
): Promise<Attempt<UpdateInfo>> {
  if (!o.cli) return { ok: false, error: '未提供 git 执行器' };
  const br = t.branch || 'HEAD';
  let out: string;
  try {
    out = await o.cli(['ls-remote', `https://github.com/${t.owner}/${t.repo}.git`, br]);
  } catch (e) {
    return { ok: false, error: `git ls-remote 失败 ${String(e)}` };
  }
  const sha = br === 'HEAD' ? (/^([0-9a-f]{7,40})/.exec(out.trim()) || [])[1] : parseLsRemote(out, br);
  if (!sha) return { ok: false, error: 'git 输出里找不到分支 sha' };

  const base = (o.base || '').trim();
  return {
    ok: true,
    value: {
      branch: br,
      sha,
      message: '',
      author: '',
      date: '',
      ahead: base && !sha.startsWith(base) ? 1 : 0,
      behind: 0,
      updated: base ? !sha.startsWith(base) : false,
      via: 'cli',
    },
  };
}

export async function fetchUpdate(
  f: Fetcher,
  t: GithubTarget,
  o: UpdateOptions,
): Promise<FallbackOutcome<UpdateInfo>> {
  if (!t.owner || !t.repo) {
    return { ok: false, error: '缺少 owner 或 repo', diags: [] };
  }
  const order = o.order && o.order.length ? o.order : ['api', 'atom', 'cli'];
  const table: Record<string, () => Promise<Attempt<UpdateInfo>>> = {
    api: () => byApi(f, t, o),
    atom: () => byAtom(f, t, o),
    cli: () => byCli(t, o),
  };
  const strategies = order
    .filter((n) => table[n])
    .map((n) => ({ name: n, run: table[n] }));
  return runWithFallback(strategies);
}

/* ------------------------------------------------------------------ */
/* 推送                                                                */
/* ------------------------------------------------------------------ */

export type PushOptions = {
  token: string;
  branch?: string;
  message: string;
  files: PushFile[];
  /** 本地仓库路径，cli 方案需要 */
  workdir?: string;
  order?: string[];
  cli?: (args: string[], cwd?: string) => Promise<string>;
  /** 新建分支时基于此分支 */
  fromBranch?: string;
};

/** contents API 需要文件当前的 sha 才能更新已存在的文件 */
async function getFileSha(
  f: Fetcher,
  t: GithubTarget,
  token: string,
  path: string,
  branch: string,
): Promise<string | null> {
  const url =
    `https://api.github.com/repos/${t.owner}/${t.repo}/contents/${encodeURI(path)}` +
    `?ref=${encodeURIComponent(branch)}`;
  const r = await f(url, { headers: authHeaders(token) });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.text);
    return typeof j.sha === 'string' ? j.sha : null;
  } catch {
    return null;
  }
}

async function pushByApi(
  f: Fetcher,
  t: GithubTarget,
  o: PushOptions,
): Promise<Attempt<PushResult>> {
  if (!o.token) return { ok: false, error: '未配置令牌，API 方案不可用' };
  if (!o.files || o.files.length === 0) {
    return { ok: false, error: '没有要提交的文件' };
  }
  const branch = o.branch || 'main';

  // 逐文件 PUT。GitHub 没有"一次提交多文件"的简易接口，
  // 真要用单提交得走 trees/commits 三步，复杂且更容易中途失败。
  let lastSha = '';
  for (const file of o.files) {
    const existing = await getFileSha(f, t, o.token, file.path, branch);
    const body: Record<string, unknown> = {
      message: o.message,
      content: b64Encode(file.content),
      branch,
    };
    if (existing) body.sha = existing;

    const r = await f(
      `https://api.github.com/repos/${t.owner}/${t.repo}/contents/${encodeURI(file.path)}`,
      {
        method: 'PUT',
        headers: { ...authHeaders(o.token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      return { ok: false, error: `写入 ${file.path} 失败 ${httpHint(r.status)}` };
    }
    try {
      const j = JSON.parse(r.text);
      const cs = j && j.commit && typeof j.commit.sha === 'string' ? j.commit.sha : '';
      if (cs) lastSha = cs;
    } catch {
      // 拿不到 sha 不致命，文件已经写进去了
    }
  }

  return {
    ok: true,
    value: {
      ok: true,
      commit: lastSha,
      branch,
      files: o.files.map((x) => x.path),
      via: 'api',
      message: o.message,
    },
  };
}

async function pushByCli(
  t: GithubTarget,
  o: PushOptions,
): Promise<Attempt<PushResult>> {
  if (!o.cli) return { ok: false, error: '未提供 git 执行器' };
  if (!o.workdir) return { ok: false, error: '未提供本地仓库路径' };
  if (!o.files || o.files.length === 0) return { ok: false, error: '没有要提交的文件' };

  const branch = o.branch || 'main';
  try {
    // 先切分支；已存在就 checkout，不存在就 -b
    const brs = await o.cli(['branch', '--list', branch], o.workdir);
    if ((brs || '').trim() === '') {
      await o.cli(['checkout', '-b', branch, o.fromBranch || 'main'], o.workdir);
    } else {
      await o.cli(['checkout', branch], o.workdir);
    }
    await o.cli(['add', '--'].concat(o.files.map((x) => x.path)), o.workdir);
    await o.cli(['commit', '-m', o.message], o.workdir);
    const out = await o.cli(['rev-parse', 'HEAD'], o.workdir);
    await o.cli(['push', 'origin', branch], o.workdir);
    return {
      ok: true,
      value: {
        ok: true,
        commit: (out || '').trim(),
        branch,
        files: o.files.map((x) => x.path),
        via: 'cli',
        message: o.message,
      },
    };
  } catch (e) {
    return { ok: false, error: `git 推送失败 ${String(e)}` };
  }
}

export async function pushFiles(
  f: Fetcher,
  t: GithubTarget,
  o: PushOptions,
): Promise<FallbackOutcome<PushResult>> {
  if (!t.owner || !t.repo) {
    return { ok: false, error: '缺少 owner 或 repo', diags: [] };
  }
  if (!o.message || o.message.trim() === '') {
    return { ok: false, error: '提交信息不能为空', diags: [] };
  }
  const order = o.order && o.order.length ? o.order : ['api', 'cli'];
  const table: Record<string, () => Promise<Attempt<PushResult>>> = {
    api: () => pushByApi(f, t, o),
    cli: () => pushByCli(t, o),
  };
  const strategies = order
    .filter((n) => table[n])
    .map((n) => ({ name: n, run: table[n] }));
  return runWithFallback(strategies);
}

/* ------------------------------------------------------------------ */
/* base64（UTF-8 安全）                                                */
/* ------------------------------------------------------------------ */

/**
 * GitHub contents API 要求 base64。
 * 不能直接 btoa：它只接受 Latin-1，中文会抛异常。
 * 先 UTF-8 编码再逐字节转，才不会在中文内容上炸掉。
 */
export function b64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  // 浏览器与 Node 都有 btoa；测试环境缺失时退回手写实现
  if (typeof btoa === 'function') return btoa(bin);
  const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bin.length; i += 3) {
    const c0 = bin.charCodeAt(i);
    const c1 = bin.charCodeAt(i + 1);
    const c2 = bin.charCodeAt(i + 2);
    out += KEY[c0 >> 2];
    out += KEY[((c0 & 3) << 4) | ((isNaN(c1) ? 0 : c1) >> 4)];
    out += isNaN(c1) ? '=' : KEY[((c1 & 15) << 2) | ((isNaN(c2) ? 0 : c2) >> 6)];
    out += isNaN(c2) ? '=' : KEY[c2 & 63];
  }
  return out;
}

/** 凭据校验：GET /user，顺便读 X-OAuth-Scopes */
export async function verifyToken(f: Fetcher, token: string): Promise<TokenCheck> {
  const r = await f('https://api.github.com/user', { headers: authHeaders(token) });
  const h = lowerHeaders(r.headers || {});
  const scopes = h['x-oauth-scopes'] !== undefined ? h['x-oauth-scopes'] : null;
  let login = '';
  try {
    const j = JSON.parse(r.text);
    if (j && typeof j.login === 'string') login = j.login;
  } catch {
    // 401 时返回的是错误对象，没有 login
  }
  return {
    ok: r.ok,
    status: r.status,
    scopes,
    login,
    message: r.ok ? '令牌有效' : httpHint(r.status),
  };
}

export { lowerHeaders };
