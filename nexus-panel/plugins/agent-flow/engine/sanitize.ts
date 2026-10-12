/**
 * 数据落盘前的净化 —— 什么不能进明文存储。
 *
 * 抽出来的直接原因：SECRET_PATHS 此前在 customPresets.ts 与 nodeDefaults.ts
 * **各写了一份**。这是个安全向的清单，复制两份意味着以后新增密钥字段时
 * 漏改一处就会明文泄露，而且这种泄露不会报错、测试也不会红。
 *
 * 凡是"要存进 localStorage 的节点数据"，都该先过一遍这里。
 */

import { mapHeaderLines, parseHeaderLines } from './headers';

/** 内联密钥的路径。用点号表示嵌套，如 llm.apiKey */
export const SECRET_PATHS = ['token', 'llm.apiKey', 'config.token'] as const;

/**
 * 字段名里含这些词就当它是密钥 —— 用于**无法枚举路径**的场景。
 *
 * 典型就是画布配置里的 MCP 环境变量：变量名由用户随便起
 * （`API_TOKEN` / `gh_secret` / `MY_PASSWORD`），没法写成固定路径。
 *
 * 宁可多剥（把 `tokenCount` 也剥了）也不要漏 ——
 * 漏了是明文泄露且不报错，多剥只是让用户重填一次。
 */
export const SECRET_NAME_HINTS = [
  'token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'accesskey',
  /*
   * cookie：B站的 biliCookie 是**整条会话凭据**（用来绕过风控），
   * 含金量不低于一个 token。而它的名字里不带 token / key 字样 ——
   * 不加这一条，检测更新节点的 Cookie 就明文进存档、进导出的画布文件。
   */
  'cookie',
];

/** 一个名字是否像密钥 */
export function looksLikeSecretName(name: string): boolean {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return false;
  for (const h of SECRET_NAME_HINTS) {
    if (n.includes(h)) return true;
  }
  return false;
}

/**
 * 按**名字**挖掉任意深度的密钥（嵌套对象与数组都进）。
 *
 * SECRET_PATHS 是固定路径枚举，覆盖不到这两处真实存在的密钥：
 *   · 触发器的 entries[].config.token —— 带数组下标，点号路径表达不了
 *   · 检测更新的 biliCookie / targets[].biliCookie —— 压根没进清单
 *
 * 于是这两处都是"以为挡住了、实际没有"：
 * redactNode 的注释原本写着「以后新增任何带 llm / token 的节点都会自动覆盖」，
 * 而它只对 headersText 按名字判，其余一律靠路径 —— 路径漏了就是明文落盘，
 * 而且 hadInlineSecret 也跟着漏，界面上那句"不会存进默认"根本不出现。
 *
 * 所以按名字再兜一层：字段名像密钥的**字符串叶子**一律挖空。
 * 宁可多剥也不要漏 —— 漏了是明文泄露且不报错，多剥只是让用户重填一次。
 *
 * 只认字符串叶子：maxTokens 这类数字字段即便名字含 token 也不会被动。
 */
export function blankSecretNamed(data: unknown): unknown {
  if (Array.isArray(data)) {
    let changed = false;
    const arr = data.map((v) => {
      const next = blankSecretNamed(v);
      if (next !== v) changed = true;
      return next;
    });
    return changed ? arr : data;
  }
  if (!data || typeof data !== 'object') return data;
  const src = data as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string' && v !== '' && looksLikeSecretName(k)) {
      if (!out) out = { ...src };
      out[k] = '';
      continue;
    }
    if (v && typeof v === 'object') {
      const next = blankSecretNamed(v);
      if (next !== v) {
        if (!out) out = { ...src };
        out[k] = next;
      }
    }
  }
  return out ?? data;
}

/**
 * 请求头名字里含这些词就当它带密钥。
 *
 * 在 SECRET_NAME_HINTS 之外还要加 'auth' / 'cookie'：
 * 最常见的两个「带凭据的请求头」恰恰不含 token / key 字样 ——
 * `Authorization: Bearer <token>` 与 `Cookie: session=...`。
 * 只按 SECRET_NAME_HINTS 判会**两个都漏掉**。
 */
/* 'cookie' 已进 SECRET_NAME_HINTS，这里去重，免得同一条判据列两遍 */
export const SECRET_HEADER_HINTS = [...new Set([...SECRET_NAME_HINTS, 'auth', 'cookie'])];

/** 请求头的名字是否像带密钥 */
export function looksLikeSecretHeader(name: string): boolean {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return false;
  for (const h of SECRET_HEADER_HINTS) {
    if (n.includes(h)) return true;
  }
  return false;
}

/**
 * 挖掉请求头里像密钥的那些值。
 *
 * 只挖值、留名字（`Authorization:` 还在）——
 * 界面上用户看得到「这一条要重填」，而不是整段消失后一脸茫然。
 *
 * 注释行（# 开头）也挖：执行器不会把它发出去，
 * 但里面的 token 一样以明文躺在存档里（本模块「宁可多剥」的原则）。
 *
 * 解析走 headers.ts，与执行器同一份 —— 各写一份必然漂移。
 */
export function redactHeadersText(text: string): string {
  return mapHeaderLines(text, (l) => {
    if (!looksLikeSecretHeader(l.name)) return l.raw;
    const i = l.raw.indexOf(':');
    return i < 0 ? l.raw : l.raw.slice(0, i + 1);
  });
}

/** 请求头里有没有像密钥的值 —— 用于提示用户「这部分不会被存进去」 */
export function headersHaveSecret(text: string): boolean {
  for (const l of parseHeaderLines(text)) {
    if (l.value && looksLikeSecretHeader(l.name)) return true;
  }
  return false;
}

/**
 * 显示与布局状态 —— 不是业务配置，不该被"存为默认"之类带走。
 *
 * 尤其 stackParent：存进默认值的话，每个新建节点都会"嵌合"到一个
 * 不存在的父节点上，引擎把它转成边，于是新节点莫名跑不起来。
 * （这类字段以后还会加，加的时候记得同步这里。）
 */
/*
 * hasStackChild 是**渲染时算出来的**（是否有节点嵌合在本节点下方），
 * 不落盘。列进来是为了让复制节点时把它剥掉 ——
 * 否则只复制串顶（下级没一起选中）时，副本会继承"我下面有块"，
 * 底部被压平而实际下面什么都没有。
 */
/*
 * argLinkIssues 是**渲染时算出来的**：参数连线带来的类型错，前提是看得到
 * 全图（上游产出什么）。存进存档就是脏数据 —— 上游改了它不会跟着变，
 * 表现为"上游已经改对了，这里还是红的"。列进来也让复制节点时把它剥掉。
 */
export const VIEW_KEYS = [
  'size', 'stackParent', 'stackCollapsed', 'hasStackChild', 'onFireManual', 'argLinkIssues',
];

/** 数据里是否含内联密钥 —— 用于提示用户"这部分不会被存进去" */
export function hadInlineSecret(data: unknown): boolean {
  const d = (data ?? {}) as Record<string, unknown>;
  for (const path of SECRET_PATHS) {
    const parts = path.split('.');
    let cur: unknown = d;
    for (const p of parts) {
      cur = cur && typeof cur === 'object'
        ? (cur as Record<string, unknown>)[p]
        : undefined;
    }
    if (typeof cur === 'string' && cur.length > 0) return true;
  }
  /* 请求头里的 Authorization / Cookie 也算内联密钥 —— 漏了界面就不提示，
     用户会以为自己填的东西是安全的 */
  if (headersHaveSecret(String(d.headersText ?? ''))) return true;
  /*
   * 固定路径之外的密钥（数组里的 entries[].config.token、biliCookie）：
   * 挖一遍看有没有变化 —— 变了就说明有。
   * 复用 blankSecretNamed 而不是再写一份遍历，免得两处判定漂移。
   */
  if (blankSecretNamed(d) !== d) return true;
  return false;
}

/**
 * 挖掉内联密钥。挖过的位置留空串而不是删键 ——
 * 保持字段结构完整，界面上该输入框还在（只是空了），用户知道该填什么。
 *
 * 连接引用（credentialId）**不动**：它只是个 id，不是密钥本身，
 * 而且恰恰是我们希望用户改用、并能随预设一起复用的东西。
 */
export function stripSecrets(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const path of SECRET_PATHS) {
    const parts = path.split('.');
    if (parts.length === 1) {
      if (typeof out[parts[0]] === 'string' && out[parts[0]]) out[parts[0]] = '';
      continue;
    }
    const head = out[parts[0]];
    if (head && typeof head === 'object' && !Array.isArray(head)) {
      const nested = { ...(head as Record<string, unknown>) };
      if (typeof nested[parts[1]] === 'string' && nested[parts[1]]) nested[parts[1]] = '';
      out[parts[0]] = nested;
    }
  }
  /* 请求头是「最顺手写 Authorization: Bearer xxx」的地方，
     不脱的话预设分享出去就等于把令牌贴给别人 */
  if (typeof out.headersText === 'string') {
    out.headersText = redactHeadersText(out.headersText);
  }
  /* 兜住固定路径覆盖不到的那些（数组里的、没进清单的） */
  return blankSecretNamed(out) as Record<string, unknown>;
}

/** 剥掉显示与布局状态 */
export function stripViewKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (VIEW_KEYS.indexOf(k) >= 0) continue;
    out[k] = data[k];
  }
  return out;
}
