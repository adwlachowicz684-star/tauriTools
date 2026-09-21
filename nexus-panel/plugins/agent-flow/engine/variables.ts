import { cloneData } from './duplicate';
import { defaultKV, loadList, saveWrapped, type KV } from './kv';

/**
 * 变量。
 *
 * 把一组常用参数（如「GitHub 仓库地址 + 分支」「某个 LLM 配置」）定义成一个**变量**，
 * 之后节点**引用**它。改变量，所有引用它的节点一起变。
 *
 * ================= 语义（务必看清，这是设计的核心）=================
 *
 *   变量 = 值；节点 = 引用。
 *
 *   · 节点引用变量 → 读取时取变量当前的值（不是拷贝一份）
 *   · 在节点上改这个字段 → 改的是**变量本身**，其它引用它的节点一起变
 *   · 「脱离变量」→ 把当前值拷一份到节点上，之后自己管自己的
 *
 * ================= 为什么不是"复制"也不是纯"引用" =================
 *
 * 复制：改一个节点不会波及别处，但"变量"就不成其为变量了 ——
 *   改了变量而节点纹丝不动，用户会以为变量没生效。
 *
 * 引用而无脱离口：所有引用节点永远绑死，
 *   想让某一个节点用个别的值就只能重新建一个变量，名字越堆越多。
 *
 * 所以是「引用 + 可脱离」：默认跟着变，想独立就点一下脱离。
 *
 * ================= 作用域 =================
 *
 * 默认**画布级**：这张画布里定义的变量，只在这张画布里可见。
 * 在变量上打开「全局」开关才跨画布可见。
 *
 * 为什么默认不是全局：全局变量一多，名字就撞；
 * 而真正要跨画布共享的东西，用「画布输入 / 输出」节点传递更清楚
 * —— 那是显式的连线，看得见来龙去脉，也比全表扫描省。
 */

export const VARIABLES_KEY = 'agent-flow.variables.v1';
/** 旧名（参数卡片）。读得到就迁过来，不让用户白存一遍 */
export const LEGACY_CARDS_KEY = 'agent-flow.paramCards.v1';
const FORMAT_VERSION = 1;

export type Variable = {
  id: string;
  /** 归属组（'github-repo' / 'llm-config' …）。同组变量跨节点类型共享 */
  group: string;
  name: string;
  /** 该组字段的键值对 */
  values: Record<string, unknown>;
  createdAt: number;
  /**
   * 全局（跨画布可见）。缺省即画布级 —— 与节点 disabled 同一套口径：
   * 老数据没有这个字段也不会突然变成一堆全局变量。
   */
  global?: boolean;
  /** 归属画布。global 为 true 时忽略 */
  canvasId?: string;
};

/* ------------------------------------------------------------------ */
/* 变量组定义 —— 让变量成为通用能力，而不是某几个节点的私有特性          */
/* ------------------------------------------------------------------ */

/**
 * 一「组」变量管辖哪些字段、在界面上怎么显示、值长什么样算合法。
 *
 * 为什么要有这张表：
 * 最初变量是 GitHub 节点私有的（组名、字段、摘要全写死在节点定义里），
 * 于是"给另一个节点加变量"要重写一遍同样的东西；
 * 更关键的是**无法做类型验证** —— 不知道一组变量管哪些字段，
 * 就只能凭 group 名字字符串相等来判断能不能拖到某个节点上，
 * 而字符串是可以在两处各写一份、然后各改各的。
 *
 * 有了这张表之后：
 *   · 节点只需声明 meta.varGroups: ['github-repo']，面板自动渲染选择器
 *   · 拖动变量到节点时，能按 keys 校验变量值是否真的适配这个节点
 *   · 新增一组变量 = 注册一条 VariableGroupDef，不用碰任何节点
 */
export type VariableGroupDef = {
  group: string;
  /** 面板上的字段名 */
  label: string;
  /** 这组变量管辖的字段名。引用期间这些字段的值以变量为准 */
  keys: string[];
  /** 变量上显示的摘要，如 "acme/web" */
  summary: (values: Record<string, unknown>) => string;
  /** 新建变量时的默认名字 */
  name?: string;
  /**
   * 值合法性校验。返回错误说明，null 表示通过。
   * 拖动变量到节点时用它挡住"看着能拖、套上去是空的"这类错配。
   */
  validate?: (values: Record<string, unknown>) => string | null;
};

const VAR_GROUPS = new Map<string, VariableGroupDef>();

export function registerVariableGroup(def: VariableGroupDef): void {
  VAR_GROUPS.set(def.group, def);
}

export function getVariableGroup(group: string): VariableGroupDef | null {
  return VAR_GROUPS.get(group) ?? null;
}

export function allVariableGroups(): VariableGroupDef[] {
  return [...VAR_GROUPS.values()];
}

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

/** 读出来的东西不可信：可能是旧版本、手改过、或别的插件写坏的 */
function isVar(x: unknown): x is Variable {
  const o = x as Variable;
  return (
    !!o
    && typeof o.id === 'string' && o.id.length > 0
    && typeof o.group === 'string' && o.group.length > 0
    && typeof o.name === 'string'
    && !!o.values && typeof o.values === 'object'
  );
}

function normalize(v: Variable): Variable {
  return {
    ...v,
    // 老数据没有 global / canvasId：按**全局**处理 —— 那就是它当初的行为
    global: v.global === true ? true : (v.canvasId ? false : true),
    canvasId: typeof v.canvasId === 'string' ? v.canvasId : '',
  };
}

export function saveVariables(list: Variable[], kv: KV = defaultKV()): void {
  saveWrapped(kv, VARIABLES_KEY, FORMAT_VERSION, 'variables', list);
}

/**
 * 读全部变量。
 *
 * 首次遇到旧存储（参数卡片）就迁过来并**立刻写回**：
 * 不写回的话每次读都要迁移一遍，而用户删空变量后
 * 旧数据又会"复活" —— 删不掉的东西比没有更糟。
 */
export function loadVariables(kv: KV = defaultKV()): Variable[] {
  if (kv.get(VARIABLES_KEY)) {
    return (loadList(kv, VARIABLES_KEY, 'variables', isVar) as Variable[]).map(normalize);
  }
  const legacy = loadList(kv, LEGACY_CARDS_KEY, 'cards', isVar) as Variable[];
  if (legacy.length === 0) return [];
  const migrated = legacy.map(normalize);
  saveVariables(migrated, kv);
  return migrated;
}

/* ------------------------------------------------------------------ */
/* 增删改                                                              */
/* ------------------------------------------------------------------ */

function newId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addVariable(
  input: {
    group: string;
    name: string;
    values: Record<string, unknown>;
    global?: boolean;
    canvasId?: string;
  },
  kv: KV = defaultKV(),
): Variable {
  const list = loadVariables(kv);
  const v: Variable = {
    id: newId(),
    group: input.group,
    name: input.name.trim() || '未命名',
    // 存的时候也深拷贝：否则调用方之后改了传入的对象，变量内容跟着变
    values: cloneData(input.values),
    createdAt: Date.now(),
    global: input.global === true,
    canvasId: input.canvasId ?? '',
  };
  list.push(v);
  saveVariables(list, kv);
  return v;
}

export function renameVariable(id: string, name: string, kv: KV = defaultKV()): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  saveVariables(
    loadVariables(kv).map((v) => (v.id === id ? { ...v, name: trimmed } : v)),
    kv,
  );
}

export function removeVariable(id: string, kv: KV = defaultKV()): void {
  saveVariables(loadVariables(kv).filter((v) => v.id !== id), kv);
}

/** 改变量的值。所有引用它的节点读取时都会拿到新值 */
export function patchVariableValues(
  id: string,
  patch: Record<string, unknown>,
  kv: KV = defaultKV(),
): void {
  const list = loadVariables(kv);
  const at = list.findIndex((v) => v.id === id);
  if (at < 0) return;
  list[at] = { ...list[at], values: { ...list[at].values, ...cloneData(patch) } };
  saveVariables(list, kv);
}

/** 切换全局 / 画布级 */
export function setVariableGlobal(
  id: string,
  global: boolean,
  canvasId: string,
  kv: KV = defaultKV(),
): void {
  const list = loadVariables(kv);
  const at = list.findIndex((v) => v.id === id);
  if (at < 0) return;
  list[at] = { ...list[at], global, canvasId };
  saveVariables(list, kv);
}

/**
 * 某组可见的全部变量。
 *
 * 全局的 + 本画布的。不传 canvasId 则只给全局的 ——
 * 拿不到画布上下文时宁可少给，也不要把别张画布的变量混进来。
 */
export function varsOfGroup(
  group: string,
  canvasId?: string,
  kv: KV = defaultKV(),
): Variable[] {
  return loadVariables(kv).filter((v) => {
    if (v.group !== group) return false;
    if (normalize(v).global) return true;
    return !!canvasId && v.canvasId === canvasId;
  });
}

export function findVar(id: string | undefined | null, kv: KV = defaultKV()): Variable | null {
  if (!id) return null;
  return loadVariables(kv).find((v) => v.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* 引用 / 脱离                                                          */
/* ------------------------------------------------------------------ */

/**
 * 节点上记录「哪个组引用了哪个变量」。
 * 存在 data 里，随画布存档一起走。
 *
 * 老字段名是 varRefs（那是"参数卡片"时期留下的），
 * 读的时候两个都认 —— 老画布里的引用不该因为改名就断掉。
 */
export type VarRefs = Record<string, string>;

export type NodeLike = { data?: unknown };

function dataOf(node: NodeLike): Record<string, unknown> {
  return (node.data ?? {}) as Record<string, unknown>;
}

function refsOf(d: Record<string, unknown>): VarRefs | null {
  const r = d.varRefs ?? d.varRefs;
  return (r && typeof r === 'object') ? (r as VarRefs) : null;
}

/** 该组当前引用的是哪个变量；没有则返回 null（即已脱离 / 从未引用） */
export function varIdOf(data: unknown, group: string): string | null {
  const refs = refsOf(dataOf({ data }));
  const id = refs?.[group];
  return typeof id === 'string' && id ? id : null;
}

/** 节点上全部引用（已归一化，老字段也算） */
export function varRefsOf(data: unknown): VarRefs {
  return { ...(refsOf(dataOf({ data })) ?? {}) };
}

/**
 * 把变量的值并进节点数据，返回一份新对象。
 *
 * ================= 为什么必须解析 =================
 *
 * 引用期间，节点**不存**这组字段的值 —— 值只在变量里。
 * 于是所有"读节点字段"的地方（执行、校验、面板显示、导出）
 * 都得先过这一层，否则读到的就是 undefined。
 *
 * 集中在这里而不是各处自己拼：漏一处就是"改了变量没生效"，
 * 而这种症状用户只会以为变量功能坏了。
 */
export function resolveVars(data: unknown, kv: KV = defaultKV()): Record<string, unknown> {
  const d = { ...dataOf({ data }) } as Record<string, unknown>;
  const refs = refsOf(d);
  if (!refs) return d;
  for (const group of Object.keys(refs)) {
    const v = findVar(refs[group], kv);
    if (!v) continue;
    const gd = getVariableGroup(group);
    const keys = gd?.keys ?? Object.keys(v.values);
    for (const k of keys) {
      if (k in v.values) d[k] = cloneData(v.values[k]);
    }
  }
  return d;
}

/**
 * 引用一个变量：记下引用，并把这组字段的值从节点上撤掉。
 *
 * 撤掉是刻意的 —— 留着就会变成"第二份值"：
 * 改了变量，一部分地方读到变量的新值、一部分读到节点上的旧值，
 * 表现为"改了有时候生效有时候不生效"，最难查的那一类。
 */
export function applyVarTo(
  data: unknown,
  v: Variable,
): Record<string, unknown> {
  const d = dataOf({ data });
  const refs = { ...(refsOf(d) ?? {}) };
  refs[v.group] = v.id;

  const gd = getVariableGroup(v.group);
  const patch: Record<string, unknown> = { varRefs: refs, cardRefs: undefined };
  for (const k of gd?.keys ?? []) patch[k] = undefined;
  return patch;
}

/**
 * 脱离：把当前值拷一份到节点上，之后这个节点自己管自己的。
 *
 * 拷的是**解析后**的值 —— 拷 undefined 等于把填好的内容清空了，
 * 而用户点脱离是想"保留现在的值、只是不再跟随"。
 */
export function detachVar(
  data: unknown,
  group: string,
  kv: KV = defaultKV(),
): Record<string, unknown> {
  const d = dataOf({ data });
  const refs = { ...(refsOf(d) ?? {}) };
  if (!(group in refs)) return {};
  delete refs[group];

  const resolved = resolveVars(d, kv);
  const gd = getVariableGroup(group);
  const patch: Record<string, unknown> = { varRefs: refs, cardRefs: undefined };
  for (const k of gd?.keys ?? []) {
    if (resolved[k] !== undefined) patch[k] = resolved[k];
  }
  return patch;
}

/** 该组是否已脱离（没引用任何变量） */
export function isDetached(data: unknown, group: string): boolean {
  return varIdOf(data, group) === null;
}

/**
 * 手改字段时，把"该写进变量"的部分挑出来。
 *
 * 返回 nodePatch（照旧写节点）与 varUpdates（改变量本身）。
 * 一个 patch 可能同时命中多个组，所以是数组。
 *
 * ================= 一个必须挡掉的自我改写 =================
 *
 * 引用 / 切换变量时，patch 里同时含「varRefs」和「本组字段（置空）」。
 * 若不挡，那些置空会被当成"用户把值删了"反向写进变量 ——
 * 于是点一下切换，变量内容就被清空了。
 *
 * 挡法与 shouldDetach 同源：patch 里自带 varRefs 就说明调用方正管理引用。
 */
export function redirectVarPatch(
  data: unknown,
  patch: Record<string, unknown>,
): { nodePatch: Record<string, unknown>; varUpdates: { id: string; patch: Record<string, unknown> }[] } {
  if ('varRefs' in patch || 'varRefs' in patch) {
    return { nodePatch: patch, varUpdates: [] };
  }
  const refs = refsOf(dataOf({ data }));
  if (!refs) return { nodePatch: patch, varUpdates: [] };

  const nodePatch: Record<string, unknown> = { ...patch };
  const varUpdates: { id: string; patch: Record<string, unknown> }[] = [];

  for (const group of Object.keys(refs)) {
    const gd = getVariableGroup(group);
    const hit: Record<string, unknown> = {};
    for (const k of gd?.keys ?? []) {
      if (k in patch) {
        hit[k] = patch[k];
        delete nodePatch[k];
      }
    }
    if (Object.keys(hit).length > 0) varUpdates.push({ id: refs[group], patch: hit });
  }

  return { nodePatch, varUpdates };
}

/** 手改了某个字段时，判断要不要连带脱离（与旧 shouldDetach 同口径，保留兼容） */
export function shouldDetach(patch: Record<string, unknown>, keys: string[]): boolean {
  if ('varRefs' in patch || 'varRefs' in patch) return false;
  return Object.keys(patch).some((k) => keys.indexOf(k) >= 0);
}

/* ------------------------------------------------------------------ */
/* 复制变量（Ctrl + 拖动）                                              */
/* ------------------------------------------------------------------ */

export function duplicateVar(id: string, kv: KV = defaultKV()): Variable | null {
  const src = findVar(id, kv);
  if (!src) return null;
  const copy: Variable = {
    ...src,
    id: newId(),
    name: `${src.name} 副本`,
    values: cloneData(src.values),
    createdAt: Date.now(),
  };
  const list = loadVariables(kv);
  // 插在原件后面：副本紧挨着原件，比丢到列表末尾好找
  const at = list.findIndex((v) => v.id === id);
  list.splice(at >= 0 ? at + 1 : list.length, 0, copy);
  saveVariables(list, kv);
  return copy;
}

/* ------------------------------------------------------------------ */
/* 类型验证：变量能不能用到这个节点上                                     */
/* ------------------------------------------------------------------ */

export type CheckResult = { ok: true } | { ok: false; reason: string };

export function checkVarForNode(
  v: Variable,
  supportedGroups: string[] | undefined,
  kv: KV = defaultKV(),
): CheckResult {
  const def = getVariableGroup(v.group);
  if (!def) {
    return { ok: false, reason: `「${v.name}」属于未注册的分组 ${v.group}` };
  }
  if (!supportedGroups || supportedGroups.indexOf(v.group) < 0) {
    return { ok: false, reason: `${def.label}不能用到这个节点上` };
  }
  const err = def.validate?.(v.values) ?? null;
  if (err) return { ok: false, reason: `「${v.name}」${err}` };
  return { ok: true };
}

/** 按组定义取出要写进节点的字段（组未注册时返回空 patch） */
export function patchForVar(v: Variable): Record<string, unknown> {
  const def = getVariableGroup(v.group);
  return def ? applyVarTo({}, v) : {};
}

/* ------------------------------------------------------------------ */
/* 导入导出（跨环境分享）                                                */
/* ------------------------------------------------------------------ */

export function exportVariables(kv: KV = defaultKV()): string {
  return JSON.stringify({ version: FORMAT_VERSION, variables: loadVariables(kv) }, null, 2);
}

export type ImportResult = { added: number; updated: number; skipped: string[] };

export function importVariables(
  json: string,
  opts?: { mode?: 'merge' | 'replace'; canvasId?: string },
  kv: KV = defaultKV(),
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('不是合法的 JSON');
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { variables?: unknown; cards?: unknown })?.variables
    ?? (parsed as { cards?: unknown })?.cards;
  if (!Array.isArray(list)) throw new Error('文件里没有变量列表');

  const result: ImportResult = { added: 0, updated: 0, skipped: [] };
  const current = opts?.mode === 'replace' ? [] : loadVariables(kv);

  for (const item of list) {
    if (!isVar(item)) {
      result.skipped.push(String((item as { name?: string })?.name ?? '(无名)'));
      continue;
    }
    // 同 id 视为同一条，覆盖。重复导入不会堆副本。
    const at = current.findIndex((v) => v.id === item.id);
    const norm = normalize(item);
    if (at >= 0) {
      current[at] = norm;
      result.updated += 1;
    } else {
      current.push(opts?.canvasId && !norm.global ? { ...norm, canvasId: opts.canvasId } : norm);
      result.added += 1;
    }
  }

  saveVariables(current, kv);
  return result;
}
