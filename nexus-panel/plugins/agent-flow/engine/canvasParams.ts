/**
 * 画布参数 —— 画布范围的局部变量。
 *
 * ================= 解决什么 ====================
 *
 * 一个模块（几个节点编成的一组）要在多张画布上复用，
 * 而每张画布的**具体值不同**：输出目录、项目名、账号……
 *
 * 把这些写死在节点里，复用一次就得改一次；
 * 做成画布参数后，节点只写**名字**（{{params.输出目录}}），
 * 每张画布各填各的值 —— 模块本身一个字都不用改。
 *
 *   画布 A：输出目录 = D:\项目甲\out
 *   画布 B：输出目录 = D:\项目乙\out
 *   同一个模块，同一句 {{params.输出目录}}，各自取到自己的值。
 *
 * ================= 与「变量」节点的区别 =================
 *
 * 和 vars（{{var.名字}}）必须分清，否则很容易合成一个：
 *
 *   vars    运行中被「变量」节点写进去的 —— 每次运行从空开始
 *   params  画布上预先填好的 —— 跟着画布存档走，运行不改写它
 *
 * 合成一个会出现"这次运行改了、下次居然还在"这种说不清的行为。
 *
 * ================= 为什么天然成立 =================
 *
 * 不需要为"模块里的参数"另做一套机制：
 * 模块展开后，内部节点就是当前画布上的普通节点，
 * 于是 {{params.x}} 取"当前运行画布"的值 —— 复用自动成立。
 *
 * 真正要补的是**缺失检测**：
 * 模块拖进一张新画布，那张画布还没定义它要的参数 ——
 * 不检测的话引用会原样留下（或取到空值），
 * 用户看到的是"跑出来的路径不对"而不是"这个参数没填"。
 * 所以本模块的核心是 scan / report 这一组函数。
 *
 * ================= 为什么单独一个文件 =================
 *
 * 参数名要被三处用到，且三处必须一致：
 *
 *   · 配置面板：列出"引用了但没定义"的，一键补齐
 *   · 模块存档：存下模块内部引用到的名字（见下方 paramRefsOfNodes）
 *   · 运行前检查：引用了却没填的，提前写画布日志
 *
 * 各写一份扫描逻辑，就会出现"面板说缺、跑起来却不报错"。
 * 所以扫名字的函数放这里，大家共用同一份。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 模板里的前缀 */
export const PARAM_PREFIX = 'params';

/** 旧称，仍要认 —— 早期注释里承诺过 {{env.NAME}} */
export const PARAM_ALIASES = ['params', 'env'] as const;

export type CanvasParam = {
  /** 参数名。允许中文 —— 中文用户写 {{params.输出目录}} 比拼音清楚得多 */
  name: string;
  value: string;
  /** 说明：这个参数是干什么的。复用给别人时靠它知道该填什么 */
  note?: string;
};

/** 定义了哪些 vs 引用了哪些 的比对结果 */
export type ParamIssue = {
  /** 引用了但没定义的 */
  missing: string[];
  /** 定义了但没人用的 */
  unused: string[];
};

/* ------------------------------------------------------------------ */
/* 名称                                                                */
/* ------------------------------------------------------------------ */

/**
 * 参数名是否合法。
 *
 * 允许中文、字母、数字、下划线，不能以数字开头。
 * 不含 `.` —— 点号是模板里的路径分隔符（{{params.a}} 的首段即参数名）。
 */
export function isValidParamName(name: string): boolean {
  const s = String(name ?? '').trim();
  if (!s) return false;
  return /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(s);
}

/* ------------------------------------------------------------------ */
/* 扫描引用                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一个字符串里引用了哪些参数名。
 *
 * 只认 params / env 两个前缀 ——
 * 不加前缀地扫描所有 {{xxx}} 的话，{{input}}、{{loop.item}}、
 * {{节点id.output}} 全会被误当成参数，缺失清单里会冒出一堆假警报。
 */
export function scanParamRefs(text: string): string[] {
  const out = new Set<string>();
  const TOKEN = /\{\{\s*([^}\s]+)\s*\}\}/g;
  const raw = String(text ?? '');
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(raw)) !== null) {
    const key = m[1].trim();
    const dot = key.indexOf('.');
    if (dot <= 0) continue; // 没有点号 = 不是 params.x 这种写法
    const head = key.slice(0, dot);
    const rest = key.slice(dot + 1);
    if (!rest) continue;
    if (!(PARAM_ALIASES as readonly string[]).includes(head)) continue;
    // 参数名本身不再含点 —— {{params.a.b}} 视为不合法引用，跳过
    if (rest.includes('.')) continue;
    out.add(rest);
  }
  return [...out];
}

/**
 * 递归收集一个对象里所有字符串值（节点 data 的字段形状不定）。
 *
 * 跳过运行时产物（output / error / lastFiles）：
 * 上一次运行的输出里可能带着模板原文，扫进去会凭空多出一批"引用"。
 */
export function collectStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out; // 防御：万一存成了环
  if (typeof v === 'string') {
    out.push(v);
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, depth + 1);
    return out;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      if (k === 'output' || k === 'error' || k === 'lastFiles') continue;
      collectStrings((v as Record<string, unknown>)[k], out, depth + 1);
    }
  }
  return out;
}

/** 一组节点引用到的全部参数名（去重、排序 —— 顺序稳定才好对比） */
export function paramRefsOfNodes(nodes: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const n of nodes ?? []) {
    const data = (n as { data?: unknown })?.data;
    for (const s of collectStrings(data)) {
      for (const name of scanParamRefs(s)) out.add(name);
    }
  }
  return [...out].sort();
}

/* ------------------------------------------------------------------ */
/* 参数表                                                              */
/* ------------------------------------------------------------------ */

/** 取参数值。没定义返回 undefined（调用方据此区分"没定义"与"定义了空串"） */
export function paramValue(
  params: CanvasParam[] | undefined,
  name: string,
): string | undefined {
  const hit = (params ?? []).find((p) => p.name === name);
  return hit ? hit.value : undefined;
}

export function paramNamesOf(params: CanvasParam[] | undefined): string[] {
  return namesOf(params ?? []);
}

/** 参数表 → 渲染用的查表。渲染时每个变量都查一次，数组 find 是线性扫描 */
export function paramsToRecord(params: readonly CanvasParam[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params ?? []) {
    const n = String(p?.name ?? '').trim();
    if (!n) continue;
    out[n] = String(p?.value ?? '');
  }
  return out;
}

/**
 * 比对「定义了哪些」与「引用了哪些」。
 *
 * missing 是要命的那一边（跑起来会原样留在文本里）；
 * unused 只是提示（可能是留着给将来用的模块，不该当错误处理）。
 */
export function diffParamIssue(
  params: CanvasParam[] | undefined,
  used: readonly string[],
): ParamIssue {
  const defined = namesOf(params ?? []);
  const usedSet = new Set(norm(used));
  return {
    // 引用了但没定义 —— 这才是会出问题的
    missing: [...usedSet].filter((n) => !defined.includes(n)).sort(),
    // 定义了但没人用 —— 只提示，不阻断（可能是给将来预留的）
    unused: [...defined].filter((n) => !usedSet.has(n)).sort(),
  };
}

/* ------------------------------------------------------------------ */
/* 默认值：从引用反推一份待填清单                                        */
/* ------------------------------------------------------------------ */

/**
 * 给一批缺失的参数名生成待填条目。
 *
 * 用于"一键补齐"：模块拖进来后画布上缺三个参数，
 * 点一下就生成三个空条目，用户只需填值。
 * 逐个手加的话，名字容易打错 —— 打错一个字就是又一个"缺失"。
 */
export function makeParamsFor(names: string[]): CanvasParam[] {
  return norm(names)
    .filter((n) => isValidParamName(n))
    .map((n) => ({ name: n, value: '', note: '' }));
}

/**
 * 补齐：把缺失的参数名加进现有参数表（已存在的不动）。
 *
 * 不改已有条目的值 —— 用户可能已经填了一半，
 * 覆盖掉会让他以为自己没填。
 */
export function ensureParams(
  params: CanvasParam[] | undefined,
  names: readonly string[],
): CanvasParam[] {
  const out = (params ?? []).map(cloneParam);
  /*
   * 追加过程中要能判断"这个名已经有了"，所以用 Set 而不是数组 ——
   * 数组每加一个就要 includes 扫一遍，且这里本来就是边加边查。
   */
  const defined = new Set(namesOf(out));
  for (const n of norm(names)) {
    if (defined.has(n)) continue;
    if (!isValidParamName(n)) continue;
    out.push({ name: n, value: '', note: '' });
    defined.add(n);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 旧存档迁移                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把旧的 env.vars 搬进 params。
 *
 * env.vars 是「画布环境变量」，界面上承诺过 {{env.NAME}} 可用
 * （见 canvasConfig.ts 与 CanvasConfigPanel 的提示文案），
 * 但模板层从来没实现它 —— 填了也没用。
 * 现在统一到 params，老存档里的值搬过来即可，不丢。
 *
 * 已经存在同名参数的以 params 为准 —— 它才是现在生效的那份。
 */
export function migrateEnvVars(
  params: CanvasParam[] | undefined,
  envVars: Record<string, string> | undefined,
): CanvasParam[] {
  const out = (params ?? []).map(cloneParam).filter((p) => p.name);
  const defined = new Set(namesOf(out));
  for (const [k, v] of Object.entries(envVars ?? {})) {
    const name = String(k ?? '').trim();
    if (!name || defined.has(name)) continue;
    out.push({ name, value: String(v ?? '') });
    defined.add(name);
  }
  return out;
}

/* ------------------------------------------------------------------ */

function cloneParam(p: CanvasParam): CanvasParam {
  const next: CanvasParam = { name: String(p?.name ?? '').trim(), value: String(p?.value ?? '') };
  if (p?.note) next.note = p.note;
  return next;
}

function namesOf(params: readonly CanvasParam[]): string[] {
  const out = new Set<string>();
  for (const p of params ?? []) {
    const n = String(p?.name ?? '').trim();
    if (n) out.add(n);
  }
  return [...out];
}

function norm(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const n of names ?? []) {
    const s = String(n ?? '').trim();
    if (s) out.add(s);
  }
  return [...out];
}
