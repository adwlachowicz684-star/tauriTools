/**
 * 数据落盘前的净化 —— 什么不能进明文存储。
 *
 * 抽出来的直接原因：SECRET_PATHS 此前在 customPresets.ts 与 nodeDefaults.ts
 * **各写了一份**。这是个安全向的清单，复制两份意味着以后新增密钥字段时
 * 漏改一处就会明文泄露，而且这种泄露不会报错、测试也不会红。
 *
 * 凡是"要存进 localStorage 的节点数据"，都该先过一遍这里。
 */

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
 * 显示与布局状态 —— 不是业务配置，不该被"存为默认"之类带走。
 *
 * 尤其 stackParent：存进默认值的话，每个新建节点都会"嵌合"到一个
 * 不存在的父节点上，引擎把它转成边，于是新节点莫名跑不起来。
 * （这类字段以后还会加，加的时候记得同步这里。）
 */
export const VIEW_KEYS = ['size', 'stackParent', 'stackCollapsed'];

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
  return false;
}

/**
 * 挖掉内联密钥。挖过的位置留空串而不是删键 ——
 * 保持字段结构完整，界面上该输入框还在（只是空了），用户知道该填什么。
 *
 * 凭据引用（credentialId）**不动**：它只是个 id，不是密钥本身，
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
  return out;
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
