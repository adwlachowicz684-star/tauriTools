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
/*
 * 请求头专属的三条，都**不能**进 SECRET_NAME_HINTS —— 那边判的是参数名，
 * 加进去会误伤正常字段（'session' 会剥掉 sessionId、'signature' 剥掉
 * signatureAlgorithm、'credential' 剥掉 credentialId）。
 * 请求头这边的误伤代价小得多（多剥只是让用户重填一次），方向正好相反。
 *
 * ⛔ 别加 'key'：Idempotency-Key / X-Request-Key 都是**普通**请求头，
 * 加了会让每次幂等重试的键被挖空，用户填一次丢一次。
 * 真正带凭据的 key 头都带前缀（X-Api-Key / X-Access-Key），已由上面覆盖。
 */
export const SECRET_HEADER_HINTS = [
  ...new Set([...SECRET_NAME_HINTS, 'auth', 'cookie', 'session', 'credential', 'signature']),
];

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
 * 值是不是**纯粹引用上游** —— 形如 `{{login.token}}` / `${env.KEY}`。
 *
 * ================= 为什么必须留着它们 =================
 *
 * 脱敏的目的是"密钥字面量不进存档"。而 `{{login.token}}` 不是密钥字面量，
 * 它是一句**引用**：真正的值在运行时才从上游产出（上游又多半走连接库，
 * 令牌本来就不在画布里）。
 *
 * 一视同仁地挖掉，后果是**用户配置被永久抹掉且不报错**：
 *   · 存档里存的是 `Authorization:` 空值
 *   · 界面提示的是「这部分不会被存进去」—— 用户以为这就是预期
 *   · 下次跑，请求不带凭据 → 401，而排查方向是"令牌对不对"
 * 也就是说，模板**丢了**，且全程没有任何东西指出"你丢的是模板"。
 *
 * `Bearer ` 是 Authorization 的标准前缀，本身不含任何密钥信息，
 * 所以 `Bearer {{x}}` 同样算纯引用；但 `Bearer sk-{{x}}` 里那个 `sk-`
 * 是实打实的明文，按保守方向照挖。
 */
export function isTemplateOnlyHeaderValue(value: string): boolean {
  const rest = String(value ?? '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/^bearer\b/i, '')
    .trim();
  return rest === '';
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
    if (isTemplateOnlyHeaderValue(l.value)) return l.raw;
    const i = l.raw.indexOf(':');
    return i < 0 ? l.raw : l.raw.slice(0, i + 1);
  });
}

/** 请求头里有没有像密钥的值 —— 用于提示用户「这部分不会被存进去」 */
export function headersHaveSecret(text: string): boolean {
  for (const l of parseHeaderLines(text)) {
    /*
     * 口径必须与 redactHeadersText **完全一致**（纯引用不算），
     * 否则界面提示「这部分不会被存进去」而实际一个字都没挖 ——
     * 提示一旦与事实不符，比没有提示更费排查。
     */
    if (l.value && !isTemplateOnlyHeaderValue(l.value) && looksLikeSecretHeader(l.name)) return true;
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
/*
 * size 曾经也在这份清单里 —— **那是错的**，已移除。
 *
 * size 是用户在面板上点按钮设的"卡片显示高度"（NodeBasics 那三个按钮
 * `onChange(node.id, { size: k })`），是**配置**不是渲染派生值。
 * 列进剥离清单的后果：存成模块后卡片高度回到默认、设为默认后新建的
 * 节点也不继承 —— 用户明明设了，拖出来却没了，且不报错。
 *
 * 这与下面两个看着像、实则不同：
 *   · stackParent —— 指向**模块外**的节点，留在模块里会指向不存在的地方
 *     （有 stackEdges 把隐式边转成显式边来补偿，所以剥掉是对的）
 *   · stackCollapsed —— 折叠是"当前这一份画布"上的状态
 */
export const VIEW_KEYS = [
  'stackParent', 'stackCollapsed', 'hasStackChild', 'onFireManual', 'argLinkIssues',
] as const;

/*
 * 渲染派生 —— 与上面那份**不同**：这些是算出来的，任何出口都不该带。
 *
 * 分开的原因是存档路径（serialize → redactNodes）只剥这一份：
 * stackParent / stackCollapsed 是用户数据，刷新后必须在；
 * 而这三个一旦进了存档就是"上游已经改对了、这里还是红的"那类脏数据。
 */
export const DERIVED_KEYS = ['hasStackChild', 'onFireManual', 'argLinkIssues'] as const;

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

/* ------------------------------------------------------------------ */
/* 节点级脱敏 —— 画布存档 / 模块 / 任何"要存进 localStorage 的节点"      */
/* ------------------------------------------------------------------ */

/*
 * 这一层原来只活在 canvasStore 里，于是**只有画布存档走过它**。
 *
 * 而节点数据还有别的出口：打包成模块、存成变量、导出成文件。
 * 那些出口当时一律不脱敏 —— 同一个节点，存在画布里是空串，
 * 存成模块/变量就是明文，而且导出文件里也是明文。
 *
 * 症状最难查的那一类：不报错、功能正常，只是密钥在别人手里。
 * 所以把判定收进这里，出口们共用一份（下面 redactNodes 的注释
 * 里也写了为什么不能各抄一份）。
 */

export type SecretField = (typeof SECRET_PATHS)[number];

/** 按点号路径取值。路径不存在或不是非空字符串则返回 null */
function pathGet(data: Record<string, unknown>, path: string): string | null {
  const parts = path.split('.');
  let cur: unknown = data;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' && cur !== '' ? cur : null;
}

/** 按点号路径写值，返回新的 data。只改这一条路径，其余保持原引用 */
function pathSet(
  data: Record<string, unknown>,
  path: string,
  value: string,
): Record<string, unknown> {
  const parts = path.split('.');
  if (parts.length === 1) return { ...data, [parts[0]]: value };
  const head = data[parts[0]];
  if (!head || typeof head !== 'object' || Array.isArray(head)) return data;
  return {
    ...data,
    [parts[0]]: { ...(head as Record<string, unknown>), [parts[1]]: value },
  };
}

/** 把某个密钥字段写成空串，返回新的 data */
function blankSecretField(
  data: Record<string, unknown>,
  field: SecretField,
): Record<string, unknown> {
  return pathSet(data, field, '');
}

/**
 * 判断并处理单个节点：把密钥字段挖空。
 *
 * 用鸭子类型而不是导入 isOcr / isTranslate：
 *  · 节点在这层是 unknown，不该知道具体节点类型
 *  · 以后新增任何带 llm / token 的节点都会自动覆盖，不用回来改
 *
 * 只认「节点形态」{ id, data: { kind, … } }，不去递归扫 output ——
 * 否则用户让 AI 生成一段恰好含 llm 字样的文本，会被误改。
 */
export function redactNodeSecrets(n: unknown): unknown {
  if (!n || typeof n !== 'object') return n;
  const o = n as Record<string, unknown>;
  const d = o.data;
  if (!d || typeof d !== 'object') return n;
  const dd = d as Record<string, unknown>;
  if (typeof dd.kind !== 'string') return n;

  /* 派生字段与密钥一样不该进存档 —— 见 stripDerivedKeys 的说明 */
  if (DERIVED_KEYS.some((k) => k in dd)) {
    const stripped = stripDerivedKeys(dd);
    return redactNodeSecrets({ ...o, data: stripped } as unknown);
  }

  let next = dd;
  for (const f of SECRET_PATHS) {
    if (pathGet(next, f) !== null) next = blankSecretField(next, f);
  }
  /*
   * 请求头里的 Authorization / Cookie 也是内联密钥 ——
   * 按路径枚举认不出来（名字用户随便起），要按"名字像不像密钥"判。
   */
  if (typeof next.headersText === 'string') {
    const redacted = redactHeadersText(next.headersText);
    if (redacted !== next.headersText) next = { ...next, headersText: redacted };
  }
  /*
   * 最后按名字再兜一层 —— 固定路径覆盖不到的那些：
   *   · 触发器的 entries[].config.token（带数组下标，点号路径表达不了）
   *   · 检测更新的 biliCookie / targets[].biliCookie（压根不在清单里）
   */
  const named = blankSecretNamed(next);
  if (named !== next) next = named as Record<string, unknown>;
  if (next === dd) return n;
  return { ...o, data: next };
}

/**
 * 节点数组脱敏。
 *
 * 凡是"节点数据要离开内存"的地方都该过一遍：
 *   写 localStorage、打包成模块、导出成文件、存成变量。
 *
 * 各出口自己写一份判定的后果已经见过两次（预设与画布各一份，
 * 于是 webhook token 明文落盘）。所以只此一份，出口们调用它。
 */
export function redactNodes(nodes: unknown[]): unknown[] {
  return (nodes ?? []).map(redactNodeSecrets);
}

/**
 * 剥掉渲染派生字段。
 *
 * 接进存档路径（redactNodes 会调它）的理由：三处注释都写着
 * 「不落盘（见 VIEW_KEYS）」，而存档走的是 redactNodes ——
 * 它此前**根本不剥 VIEW_KEYS**。那三处之所以真的没落盘，
 * 靠的是"派生数组不回流 state"（App 的 canvasNodes 只是渲染 prop），
 * 与这份清单无关。
 *
 * 清单与机制对不上的代价是将来的：一旦有人为了省每帧重算而把
 * argLinkIssues 缓存进 nodes（很自然的优化），注释会让人以为有兜底，
 * 实际没有 —— 那就是 argLinkIssues 注释里明写的
 * 「上游已经改对了，这里还是红的」。
 *
 * 只剥 DERIVED_KEYS，不剥 stackParent / stackCollapsed：
 * 那两个是用户数据，刷新后必须在（嵌合＝隐式边，丢了等于丢连接）。
 */
export function stripDerivedKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if ((DERIVED_KEYS as readonly string[]).indexOf(k) >= 0) continue;
    out[k] = data[k];
  }
  return out;
}

/**
 * 变量值的脱敏。
 *
 * 变量存的是**一组的字段值**（如 llm 对象、headersText），
 * 与节点 data 同构但不带 kind，所以不能走 redactNodeSecrets。
 *
 * 判定与节点侧同一套（名字兜底 + 请求头），不另写一份 ——
 * 变量是"存成变量 → 导出分享"的，漏了同样是明文外流。
 */
export function redactVarValues(values: Record<string, unknown>): Record<string, unknown> {
  const v = (values ?? {}) as Record<string, unknown>;
  let out = v;
  if (typeof out.headersText === 'string') {
    const redacted = redactHeadersText(out.headersText);
    if (redacted !== out.headersText) out = { ...out, headersText: redacted };
  }
  const named = blankSecretNamed(out);
  return (named ?? out) as Record<string, unknown>;
}

/** 剥掉显示与布局状态 */
export function stripViewKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if ((VIEW_KEYS as readonly string[]).indexOf(k) >= 0) continue;
    out[k] = data[k];
  }
  return out;
}
