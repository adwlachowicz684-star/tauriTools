/**
 * 画布参数 —— 画布范围的局部变量。
 *
 * ============ 为什么要有这一层 ============
 *
 * 节点里写 `{{params.输出目录}}`，值填在**画布**上，每张画布各一套。
 * 于是同一个模块拖到 A、B 两张画布上，用同一句模板各取各的值，
 * 而模块本身一个字都不用改 —— 这是模块能跨画布复用的前提。
 *
 * 和「变量」节点（{{var.名字}}）的区别必须说清，否则很容易合成一个：
 *
 *   vars    运行中被「变量」节点写进去的 —— 每次运行从空开始
 *   params  画布上预先填好的 —— 跟着画布存档走，运行不改写它
 *
 * 合成一个会出现"这次运行改了、下次居然还在"这种说不清的行为。
 *
 * ============ 为什么单独一个文件 ============
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

import { paramRefsIn } from './template';

export type CanvasParam = {
  /** 参数名。节点里写 `{{params.名字}}`；可以用中文 —— 中文名比拼音清楚 */
  name: string;
  /**
   * 值。渲染时填进模板。
   *
   * 可选：一键补齐出来的参数还没填值，那是正常的中间状态，
   * 不该为了凑类型给个空串再到处判断。
   */
  value?: string;
  /** 说明。写给复用这个模块的人看：这个参数该填什么 */
  note?: string;
};

/*
 * 合法名字：中文 / 字母 / 数字 / 下划线，且不以数字开头。
 *
 * 为什么卡这么死：模板按 `.` 切成「命名空间.名字」两段，
 * 名字里带点（`{{params.a.b}}`）会被切成 a，b 被丢掉 ——
 * 渲染出来是错的，而用户只会看到"没生效"。
 * 所以不合法的名字要在**填的时候**就提示，而不是等跑完。
 */
const NAME_RE = /^[A-Za-z_一-龥][A-Za-z0-9_一-龥]*$/;

export function isValidParamName(name: string): boolean {
  return NAME_RE.test(String(name ?? '').trim());
}

/* ------------------------------------------------------------------ */
/* 扫描引用                                                            */
/* ------------------------------------------------------------------ */

/**
 * 扫一批节点里引用到的画布参数名（去重、排序后返回）。
 *
 * 为什么递归翻整个 data 而不是只看某几个字段：
 * 节点种类几十个、字段各有各的名字，逐字段列举一定会有漏的，
 * 而漏掉的那个参数会**静默失效**（模板原样留下，文件被写到奇怪的地方）。
 * 节点 data 是纯 JSON，没有环，递归是安全的。
 *
 * 参数是 React Flow 的节点数组（含 data），也接受模块存档里的裸节点对象。
 */
export function paramRefsOfNodes(nodes: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const n of nodes ?? []) walk(n, out, 0);
  return [...out].sort();
}

function walk(v: unknown, out: Set<string>, depth: number): void {
  // 深度只是防御病态嵌套；正常节点 data 不超过 5 层
  if (depth > 8) return;
  if (typeof v === 'string') {
    for (const name of paramRefsIn(v)) out.add(name);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walk(x, out, depth + 1);
    return;
  }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, out, depth + 1);
  }
}

/* ------------------------------------------------------------------ */
/* 定义 vs 引用                                                        */
/* ------------------------------------------------------------------ */

export type ParamIssue = {
  /** 引用了但没定义的 */
  missing: string[];
  /** 定义了但没人用的 */
  unused: string[];
};

/**
 * 比对「定义了哪些」与「引用了哪些」。
 *
 * missing 是要命的那一边（跑起来会原样留在文本里）；
 * unused 只是提示（可能是留着给将来用的模块，不该当错误处理）。
 */
export function diffParamIssue(params: readonly CanvasParam[], used: readonly string[]): ParamIssue {
  const defined = namesOf(params);
  const usedSet = new Set(norm(used));
  return {
    missing: [...usedSet].filter((n) => !defined.has(n)).sort(),
    unused: [...defined].filter((n) => !usedSet.has(n)).sort(),
  };
}

/**
 * 把缺失的名字补进参数表（值留空，等用户填）。
 *
 * 逐个手加的话名字容易打错 —— 打错一个字就是**又一个**缺失，
 * 于是"补齐"这个动作永远做不完。
 */
export function ensureParams(
  params: readonly CanvasParam[],
  names: readonly string[],
): CanvasParam[] {
  const out = params.map(cloneParam);
  const defined = namesOf(out);
  for (const n of norm(names)) {
    if (defined.has(n)) continue;
    out.push({ name: n, value: '', note: '' });
    defined.add(n);
  }
  return out;
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

/* ------------------------------------------------------------------ */
/* 老存档                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把旧的「全局环境变量」搬进画布参数。
 *
 * env.vars 是旧称：界面上早就承诺过 `{{env.NAME}}` 可用，但模板层从没实现，
 * 填了也没用。老存档里填过的值不能丢，所以读的时候搬过来 ——
 * 已经存在同名参数的，以 params 为准（它才是现在生效的那份）。
 */
export function migrateEnvVars(
  params: readonly CanvasParam[] | undefined,
  envVars: Record<string, string> | undefined,
): CanvasParam[] {
  const out: CanvasParam[] = (params ?? []).map(cloneParam).filter((p) => p.name);
  const defined = namesOf(out);
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

function namesOf(params: readonly CanvasParam[]): Set<string> {
  const out = new Set<string>();
  for (const p of params ?? []) {
    const n = String(p?.name ?? '').trim();
    if (n) out.add(n);
  }
  return out;
}

function norm(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const n of names ?? []) {
    const s = String(n ?? '').trim();
    if (s) out.add(s);
  }
  return [...out];
}
