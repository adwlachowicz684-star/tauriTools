/**
 * 外链策略（Office 宏安全风格）
 * ============================================================
 * 三档全局策略：
 *   allow-all  全部信任 —— 不拦截，仅登记
 *   smart      智能提醒 —— 已信任放行、已禁止拦截、新域名询问（默认）
 *   deny-all   全部禁止 —— 一律拦截
 *
 * 之上还有**逐域名覆盖**：设置页列出所有外链，可单独标记 信任 / 禁止，
 * 单条决策优先级高于全局策略。
 *
 * ── 执行边界（务必读懂）────────────────────────────────
 * 真正能"拦住"外链的是 CSP，而 CSP 是静态的（写在 index.html 的 meta 里），
 * 运行时改不了。所以本模块做的是三件事：
 *   1. 静态扫描  —— 导入/更新/重载插件时读入口文件，提前列出所有外域
 *   2. 运行时观测 —— 监听 securitypolicyviolation 捕获真实被拦的外链
 *   3. 决策记账   —— 用户的选择持久化下来，并据此生成建议 CSP
 * 也就是"看得见、管得了、记得住"，而不是在 JS 层假装能拦。
 * 想让某个域名真正放行，需要把它写进 CSP（见 README「外链白名单」）。
 * ------------------------------------------------------------
 */

const KEY = 'nexus:external-policy';
const EVENT = 'nexus:external-changed';

/** 视为本域的 host（Tauri 内部服务 + 本地回环） */
export const LOCAL_HOSTS = new Set([
  'localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0',
  'asset.localhost', 'ipc.localhost', 'tauri.localhost',
]);

export const POLICY_MODES = [
  { value: 'smart', label: '智能提醒', desc: '已信任放行 / 已禁止拦截 / 新域名先问你（默认）' },
  { value: 'allow-all', label: '全部信任', desc: '不拦截任何外链，仅登记备查。风险自负' },
  { value: 'deny-all', label: '全部禁止', desc: '一律拦截，最安全。需要联网的插件会失效' },
];

/** 外链用途，仅用于展示，帮助用户判断该不该信任 */
export const KIND_LABELS = {
  script: '脚本',
  frame: '嵌入页面',
  media: '音视频',
  image: '图片',
  style: '样式/字体',
  fetch: '数据请求',
  link: '链接',
  unknown: '其他',
};

/* ---------------------------- URL 解析 ---------------------------- */

/** 取 host；相对路径 / data: / blob: / file: 等返回 null（表示不是外链） */
export function hostOf(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s || s.startsWith('#') || s.startsWith('data:') || s.startsWith('blob:')
      || s.startsWith('javascript:') || s.startsWith('about:')) return null;
  try {
    const u = new URL(s, globalThis.location?.href || 'http://localhost/');
    if (u.protocol === 'file:' || u.protocol === 'tauri:') return null;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // 用 hostname 而非 host：端口对"是否外域"没有意义，localhost:1420 仍是本地
    return (u.hostname || '').toLowerCase() || null;
  } catch { return null; }
}

/** 是否算"外域 URL" —— 只有会被当作**插件代码**加载的入口才危险 */
export function isExternal(url) {
  const h = hostOf(url);
  return !!h && !LOCAL_HOSTS.has(h);
}

/** 入口是否允许作为插件代码加载（本模块的核心校验：A3） */
export function isAllowedEntry(entry) {
  return !isExternal(entry);
}

/* ---------------------------- 策略存储 ---------------------------- */

const DEFAULT_POLICY = { mode: 'smart', hosts: {} };

export function loadPolicy() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      mode: POLICY_MODES.some((m) => m.value === raw.mode) ? raw.mode : 'smart',
      hosts: raw.hosts && typeof raw.hosts === 'object' ? raw.hosts : {},
    };
  } catch { return { ...DEFAULT_POLICY, hosts: {} }; }
}

/**
 * 落盘策略，并**如实回答"存没存成"**。
 *
 * 早先这里是一个 `catch { /* 忽略 *\/ }`，什么都不返回 ——
 * 于是调用方（设置页的两处外链卡片）**没有任何办法知道**这次改动
 * 到底有没有写进去，只能在后面无条件弹「外链策略已更新」。
 *
 * 存储不可用时（隐私模式 / 配额满 / 隔离态）的真实表现是：
 *   弹了「已更新」→ 下拉框在被 `renderExternal()` 重画时又**弹回旧值**
 *   （重画读的是 `loadPolicy()`，读回来的还是磁盘上那份）。
 * 用户看到"提示成功 + 选项自己跳回去"，只会以为这个功能抽风，
 * 而真相是"这一条根本没记下来，重启后照旧"。
 *
 * 外链策略是**安全设置**（放行哪些域），谎报成功比不报更糟：
 * 不报他还会再点一次，报了成功他就不会再确认。
 *
 * @returns {boolean} true = 已落盘；false = 没存成（调用方必须说出来）
 */
export function savePolicy(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    return false; // 存储不可用：不能算"已更新"
  }
  try {
    // 通知其他界面（设置页 / 外壳）同步。
    // 这一步失败**不影响**已经落盘的事实，所以与上面分开 try。
    globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: p }));
  } catch { /* 通知不到而已 */ }
  return true;
}

export function onPolicyChange(fn) {
  globalThis.addEventListener?.(EVENT, () => fn(loadPolicy()));
  return () => globalThis.removeEventListener?.(EVENT, fn);
}

/**
 * 单个域名的最终裁决。
 * 优先级：显式决策 > 全局策略
 * @returns 'allow' | 'block' | 'ask'
 */
export function decideHost(host, policy = loadPolicy()) {
  if (!host) return 'block';
  const rec = policy.hosts?.[host];
  if (rec?.status === 'trusted') return 'allow';
  if (rec?.status === 'blocked') return 'block';
  switch (policy.mode) {
    case 'allow-all': return 'allow';
    case 'deny-all': return 'block';
    default: return 'ask';
  }
}

/**
 * 记录一次决策。
 *
 * 返回值带上 `saved`：**改了内存不等于落了盘**。
 * 逐条放行 / 禁止是安全设置，存不下却显示成"已信任"，
 * 等于界面给了一个与事实相反的安全感 —— 而重启后它会悄悄回到原样。
 *
 * @returns {{policy: Policy, saved: boolean}}
 */
export function setHostStatus(host, status, meta = {}) {
  const p = loadPolicy();
  const prev = p.hosts[host] || {};
  p.hosts[host] = {
    status,
    decidedAt: Date.now(),
    pluginId: meta.pluginId ?? prev.pluginId,
    kind: meta.kind ?? prev.kind ?? 'unknown',
    sample: meta.sample ?? prev.sample,
  };
  return { policy: p, saved: savePolicy(p) };
}

/** @returns {{policy: Policy, saved: boolean}} 同上：必须能看出存没存成 */
export function removeHost(host) {
  const p = loadPolicy();
  delete p.hosts[host];
  return { policy: p, saved: savePolicy(p) };
}

/** 登记扫描到的外链（不改变已有决策） */
export function recordHosts(hosts, pluginId) {
  const p = loadPolicy();
  let added = 0;
  for (const { host, kind, sample } of hosts) {
    if (!host) continue;
    const rec = p.hosts[host];
    if (!rec) {
      p.hosts[host] = { status: 'pending', firstSeen: Date.now(), pluginId, kind, sample };
      added++;
    } else {
      if (rec.status === 'pending') {
        rec.pluginId = rec.pluginId || pluginId;
        rec.kind = rec.kind === 'unknown' ? kind : rec.kind;
      }
      if (!rec.sample) rec.sample = sample;
    }
  }
  if (added) savePolicy(p);
  return { added, policy: p };
}

/** 列出所有外链：已决策的 + 待决策的 */
export function listHosts() {
  const p = loadPolicy();
  return Object.entries(p.hosts)
    .map(([host, r]) => ({
      host,
      status: r.status || 'pending',
      kind: r.kind || 'unknown',
      pluginId: r.pluginId,
      sample: r.sample,
      decidedAt: r.decidedAt,
    }))
    .sort((a, b) => {
      const rank = { pending: 0, trusted: 1, blocked: 2 };
      return (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.host.localeCompare(b.host);
    });
}

export function pendingHosts() {
  return listHosts().filter((h) => h.status === 'pending');
}

/* ---------------------------- 静态扫描 ---------------------------- */

const PATTERNS = [
  [/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi, 'style'],
  [/@import\s+['"]([^'"]+)['"]/gi, 'style'],
  [/<(?:script|img|video|audio|source|iframe|embed|link)\b[^>]*?(?:src|href)\s*=\s*["']([^"']+)["']/gi, null],
  [/\b(?:fetch|import|loadURL|open)\s*\(\s*['"`]([^'"`]+)['"`]/gi, 'fetch'],
  [/["'`]((?:https?:)\/\/[^"'`\s]+)["'`]/gi, 'unknown'],
];

/** 从元素属性推断用途 */
function kindFromTag(snippet, fallback) {
  const s = snippet.toLowerCase();
  if (/<script/.test(s)) return 'script';
  if (/<iframe|<embed/.test(s)) return 'frame';
  if (/<video|<audio|<source/.test(s)) return 'media';
  if (/<img/.test(s)) return 'image';
  if (/<link/.test(s)) return 'style';
  return fallback || 'link';
}

/** 扫描一段文本里的外链 */
export function scanText(text, baseUrl = '') {
  const out = new Map();
  for (const [re, fallbackKind] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const raw = (m[1] || '').trim();
      if (!raw) continue;
      let abs = raw;
      try { abs = new URL(raw, baseUrl || globalThis.location?.href).href; } catch { /* 保持原样 */ }
      const host = hostOf(abs);
      if (!host || LOCAL_HOSTS.has(host)) continue;   // 只关心外域
      const kind = kindFromTag(m[0] || '', fallbackKind);
      const prev = out.get(host);
      // 保留"最危险"的那种用途优先展示
      const order = ['script', 'frame', 'fetch', 'media', 'image', 'style', 'link', 'unknown'];
      if (!prev || order.indexOf(kind) < order.indexOf(prev.kind)) {
        out.set(host, { host, kind, sample: abs.slice(0, 160) });
      }
    }
  }
  return [...out.values()];
}

/**
 * 扫描一个插件入口，返回外链清单。
 * 会顺带抓一层入口直接引用的本地 JS（外链常写在脚本里）。
 */
export async function scanEntry(entry, pluginId) {
  let abs;
  try {
    abs = new URL(entry, globalThis.location?.href).href;
  } catch {
    return { ok: false, error: '入口路径无法解析', hosts: [] };
  }
  if (isExternal(abs)) {
    // 入口本身就是外域 —— 这是最危险的情况，单独标记
    const host = hostOf(abs);
    const hosts = [{ host, kind: 'script', sample: abs }];
    recordHosts(hosts, pluginId);
    return { ok: true, hosts, externalEntry: true };
  }

  let text = '';
  try {
    const res = await fetch(abs);
    if (!res.ok) return { ok: false, error: `读取失败 HTTP ${res.status}`, hosts: [] };
    text = await res.text();
  } catch (e) {
    return { ok: false, error: String(e?.message || e), hosts: [] };
  }

  const found = scanText(text, abs);

  // 入口引用的本地 JS 再扫一层（动态 fetch 的 URL 常在这里）
  const localScripts = [...text.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => !isExternal(u))
    .slice(0, 5);
  for (const s of localScripts) {
    try {
      const jsUrl = new URL(s, abs).href;
      const r = await fetch(jsUrl);
      if (!r.ok) continue;
      const js = await r.text();
      for (const h of scanText(js, jsUrl)) {
        if (!found.some((x) => x.host === h.host)) found.push(h);
      }
    } catch { /* 单个脚本扫不动就算了 */ }
  }

  recordHosts(found, pluginId);
  return { ok: true, hosts: found, externalEntry: false };
}

/* ---------------------------- 运行时观测 ---------------------------- */

/**
 * 监听 CSP 违规，捕获真实被拦截的外链。
 * 注意：事件在**违规发生的那个文档**里触发，不会跨 iframe 冒泡，
 * 所以外壳监听自己、插件 SDK 监听 iframe 内并桥接上报，两边都要有。
 */
export function watchViolations(onViolation) {
  const handler = (e) => {
    const uri = e.blockedURI || '';
    const host = hostOf(uri);
    if (!host || LOCAL_HOSTS.has(host)) return;
    onViolation({
      host,
      directive: e.violatedDirective || '',
      sample: uri.slice(0, 160),
      kind: kindOfDirective(e.violatedDirective),
    });
  };
  globalThis.addEventListener?.('securitypolicyviolation', handler);
  return () => globalThis.removeEventListener?.('securitypolicyviolation', handler);
}

/**
 * 从 CSP 指令反推外链用途（'script' / 'image' / 'fetch' …）。
 *
 * 【为什么必须是全仓唯一一份 —— 且就放在本文件】
 * 这个映射一度有**三份**实现，散在三个文件里：
 *   · js/external-policy.js 本处（原为私有的 kindFromDirective）
 *   · js/shell.js           kindOf()
 *   · src/App.tsx           kindOfDirective()，注释还写着"与 shell.js 保持一致"
 * 两份壳（原生壳 shell.js / React 壳 App.tsx）**都 import 本模块**，
 * 所以本文件是唯一两边都够得着的地方 —— 放这里才谈得上同源。
 *
 * 漂了的后果不是报错，而是**同一条外链在两个壳里被标成不同用途**：
 * 用户在原生壳里看到"图片"、在 React 壳里看到"数据请求"，
 * 而他要据此决定"这个域名该不该放行"。判断依据自相矛盾。
 *
 * @param {string} [d] CSP 指令名（如 'img-src'）
 * @returns {'script'|'frame'|'media'|'image'|'style'|'fetch'|'unknown'}
 */
export function kindOfDirective(d) {
  const s = String(d || '').toLowerCase();
  if (s.includes('script')) return 'script';
  if (s.includes('frame')) return 'frame';
  if (s.includes('media')) return 'media';
  if (s.includes('img')) return 'image';
  if (s.includes('style') || s.includes('font')) return 'style';
  if (s.includes('connect')) return 'fetch';
  return 'unknown';
}

/**
 * 处理一次被 CSP 拦下的外链：登记 + 提示。
 *
 * ================= 为什么必须是全仓唯一一份 =================
 * 这段逻辑一度在**两个壳里各写一遍**：
 *   · js/shell.js   onPluginCspViolation()   —— 原生壳
 *   · src/App.tsx   handleCspViolation()     —— React 壳
 * 两者结构完全一致（取 host → 跳过本域 → 读策略 → 判决策 → 登记 → 提示），
 * 于是它们**真的漂了**，而且漂的方式是其中一个静默失效。
 *
 * ================= 已经发生的 BUG：原生壳把它自己的违规全丢了 =========
 * 违规上报有**两种形状**（见 watchViolations 与 SDK 转发两条路）：
 *   · 宿主转发插件 iframe 内的 → 带 `blockedURI`
 *   · 本模块 watchViolations 自己捕获的 → 只有 `host` + `sample`
 *
 * React 壳两种都兜（`blockedURI || sample || https://host`），
 * 原生壳**只认 `blockedURI`**。而两个壳都用同一个 watchViolations
 * 观测主文档自己的违规 —— 那条路给的是第二种形状，于是：
 *   hostOf(undefined) → null → `if (!host) return`
 * **原生壳把自己文档里每一次违规都静默丢了**：不登记、不提示、
 * 设置页的待决策列表里永远不出现该域名，且**没有任何报错**。
 *
 * 症状是"同一个插件在 React 壳里会弹外链提醒、在原生壳里什么都不发生"，
 * 而没人会往"两个壳各写了一份、其中一份漏了兜底"上想。
 *
 * 收敛到本模块：两个壳**本来就都 import 它**，且这里正是产出两种形状的
 * 地方（watchViolations 在本文件），由它来定"两种形状都要认"最自然。
 *
 * @param {{blockedURI?:string, sample?:string, host?:string,
 *          directive?:string, kind?:string}} d 违规信息（两种形状都收）
 * @param {object} [opts]
 * @param {string} [opts.pluginId]   归因到哪个插件
 * @param {string} [opts.pluginName] 提示文案里的插件名
 * @param {(msg:string, kind:string) => void} [opts.notify] 提示（toast）；
 *        不传就只 console.warn，不打断任何东西
 * @returns {{host:string, decision:string, policy:object}|null}
 *          登记了才返回非 null（调用方据此决定要不要刷新 UI）
 */
export function handleViolation(d, opts = {}) {
  /* 两种形状都要认 —— 只认 blockedURI 的话，watchViolations 捕获的
     那一路会被整条丢掉（见上方 BUG 说明） */
  const uri = d?.blockedURI || d?.sample || (d?.host ? `https://${d.host}` : '');
  const host = hostOf(uri);
  if (!host || LOCAL_HOSTS.has(host)) return null;

  const policy = loadPolicy();
  const decision = decideHost(host, policy);
  if (decision === 'allow') return null;               // 用户已信任（说明 CSP 还没配上）

  recordHosts([{
    host,
    /* 已算好用途的（watchViolations 给的）直接用，省一次反推 */
    kind: d?.kind || kindOfDirective(d?.directive),
    sample: uri,
  }], opts.pluginId);

  if (decision === 'ask' && policy.mode === 'smart') {
    opts.notify?.(`插件「${opts.pluginName || ''}」想访问 ${host}，已拦下 · 设置里可放行`, 'err');
  } else if (decision === 'block') {
    console.warn('[external] 已拦截', host);
  }
  return { host, decision, policy };
}

/** 生成建议 CSP 片段（复制给用户在 index.html / tauri.conf.json 里配置） */
export function suggestCsp(policy = loadPolicy()) {
  const trusted = Object.entries(policy.hosts)
    .filter(([, r]) => r.status === 'trusted')
    .map(([h]) => h);
  if (!trusted.length) return '';
  const list = trusted.map((h) => `https://${h} https://*.${h}`).join(' ');
  return `script-src 'self' ${list}; frame-src 'self' ${list}; media-src 'self' ${list}; img-src 'self' data: ${list}; connect-src 'self' ipc: http://ipc.localhost ${list}`;
}
