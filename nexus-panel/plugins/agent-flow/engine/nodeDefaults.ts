import { stripRuntime, cloneData } from './duplicate';
import {
  hadInlineSecret, stripSecrets, stripViewKeys, SECRET_PATHS, looksLikeSecretName,
} from './sanitize';
import { defaultKV, loadObject, type KV } from './kv';

/**
 * 节点参数默认值 —— 「设为默认」按钮的背后。
 *
 * 把当前节点的配置存成该类型节点的默认值，之后新建同类节点就用这套值。
 *
 * ================= 存储键：按 preset.key，不按 node.type =================
 *
 * 任务节点有两个变体（WorkBuddy / TraeCode），它们在侧栏是两条独立的
 * 预设，靠 preset.init() 写入不同的 cli。
 *
 * 若按 node.type 存一份默认，那么给 WorkBuddy 变体设的默认会连带把
 * TraeCode 变体的 cli 也改掉 —— 而用户根本没碰过那个变体。
 * 按 preset.key 存则各管各的。
 *
 * ================= 存之前要剥掉三类字段 =================
 *
 *  1. 运行时：status / output / error / last*
 *     不剥的话新建节点会带着 status='success' 和旧输出 ——
 *     看起来"已经跑完了"，实际一次都没跑。
 *
 *  2. **显示与布局状态：size / stackParent / stackCollapsed**
 *     这几个是后加的字段，尤其 stackParent ——
 *     不剥的话每个新建节点都会"嵌合"到一个不存在的父节点上，
 *     引擎靠 stackEdges 把它转成边，于是新节点莫名跑不起来。
 *     （这类字段以后还会加，所以这里用显式清单 + 注释说明原因。）
 *
 *  3. 内联密钥：token / llm.apiKey / config.token
 *     默认值是明文存 localStorage 的，不能当密钥仓库用。
 *     连接引用（credentialId）保留 —— 它只是个 id，不是密钥本身。
 */

export const NODE_DEFAULTS_KEY = 'agent-flow.node-defaults.v1';

/* 密钥清单、显示状态清单与剥离统一走 ./sanitize —— 见那里的说明 */


/* KV / defaultKV / loadObject 统一走 ./kv */

export type DefaultsFile = Record<string, Record<string, unknown>>;

export function loadAll(kv: KV = defaultKV()): DefaultsFile {
  return loadObject(kv, NODE_DEFAULTS_KEY) as DefaultsFile;
}

function saveAll(file: DefaultsFile, kv: KV = defaultKV()): void {
  kv.set(NODE_DEFAULTS_KEY, JSON.stringify(file));
}

/** 取某个预设的默认值；没有则为空对象 */
export function getDefault(presetKey: string, kv: KV = defaultKV()): Record<string, unknown> {
  return loadAll(kv)[presetKey] ?? {};
}

export function hasDefault(presetKey: string, kv: KV = defaultKV()): boolean {
  return Object.keys(getDefault(presetKey, kv)).length > 0;
}

export function clearDefault(presetKey: string, kv: KV = defaultKV()): void {
  const file = loadAll(kv);
  if (!(presetKey in file)) return;
  delete file[presetKey];
  if (Object.keys(file).length === 0) {
    // 空了就把整个键删掉，别留一个 {} 在那儿
    kv.remove?.(NODE_DEFAULTS_KEY);
    return;
  }
  saveAll(file, kv);
}

/** 改动是否涉及内联密钥（用于提示"这部分不会被存"） */
/* ------------------------------------------------------------------ */
/* 存                                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 单字段默认值                                                        */
/* ------------------------------------------------------------------ */

/**
 * 某个字段能不能进默认值。
 *
 * 密钥一律不进 —— 默认值是**明文**存 localStorage 的，不能当密钥仓库用。
 * 判定与 bulk 存共用 SECRET_PATHS：'llm.apiKey' 这种嵌套路径，
 * 字段名等于首段（'llm'）也算命中，否则整个 llm 对象会被存进去
 * 而里面的 apiKey 一起泄露。
 */
export function isSecretField(fieldKey: string): boolean {
  const k = String(fieldKey ?? '');
  if (!k) return false;
  for (const path of SECRET_PATHS) {
    if (path === k) return true;
    if (path.split('.')[0] === k) return true;
  }
  return looksLikeSecretName(k);
}

/**
 * 只把**指定的几个字段**存成默认，不动其它字段。
 *
 * 以前「设为默认」是一个按钮管整个节点：想只改一个字段的默认，
 * 得先把整个节点配成想要的样子再整份存 —— 而这会顺带把其它字段
 * 当前的值也一并定死（哪怕你只是路过改了一下）。
 *
 * @returns ok 是否真的存了；skipped 是因为密钥 / 空值被跳过的字段名
 */
export function setFieldsDefault(
  presetKey: string,
  patch: Record<string, unknown>,
  kv: KV = defaultKV(),
): { ok: boolean; skipped: string[] } {
  const clean: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const k of Object.keys(patch ?? {})) {
    const v = patch[k];
    if (isSecretField(k)) { skipped.push(k); continue; }
    // undefined 不存：分不清是"想设成空"还是"这个字段压根没值"
    if (v === undefined) { skipped.push(k); continue; }
    clean[k] = cloneData(v);
  }
  if (Object.keys(clean).length === 0) return { ok: false, skipped };

  const file = loadAll(kv);
  file[presetKey] = { ...(file[presetKey] ?? {}), ...clean };
  saveAll(file, kv);
  return { ok: true, skipped };
}

/** 清掉某几个字段的默认值。整份空了就把键删掉，别留一个 {} */
export function clearFieldsDefault(
  presetKey: string,
  fieldKeys: string[],
  kv: KV = defaultKV(),
): void {
  const file = loadAll(kv);
  const cur = file[presetKey];
  if (!cur) return;
  const next: Record<string, unknown> = { ...cur };
  let touched = false;
  for (const k of fieldKeys ?? []) {
    if (k in next) { delete next[k]; touched = true; }
  }
  if (!touched) return;

  if (Object.keys(next).length === 0) {
    delete file[presetKey];
    if (Object.keys(file).length === 0) {
      kv.remove?.(NODE_DEFAULTS_KEY);
      return;
    }
    saveAll(file, kv);
    return;
  }
  file[presetKey] = next;
  saveAll(file, kv);
}

/** 这个字段有没有单独设过默认 */
export function hasFieldDefault(
  presetKey: string,
  fieldKey: string,
  kv: KV = defaultKV(),
): boolean {
  const cur = loadAll(kv)[presetKey];
  return !!cur && Object.prototype.hasOwnProperty.call(cur, fieldKey);
}

/**
 * 把一份节点数据净化成可当默认值的内容。
 *
 * 顺序：先剥运行时 → 再剥显示状态 → 最后挖密钥。
 * 三步互不依赖，但记在一个地方才能看出"总共剥了什么"。
 */
export function sanitizeForDefault(data: unknown): Record<string, unknown> {
  // 顺序：先剥运行时 → 再剥显示状态 → 最后挖密钥
  return stripSecrets(stripViewKeys(stripRuntime(data)));
}


/**
 * 存为默认。
 *
 * @param presetKey 预设键；由调用方判定（见 presetKeyFor 的说明）
 * @returns 被剥掉的密钥字段数，供界面提示
 */
export function setDefault(
  presetKey: string,
  data: unknown,
  kv: KV = defaultKV(),
): { strippedSecrets: boolean } {
  const file = loadAll(kv);
  // 深拷贝：调用方之后改了节点，默认值不该跟着变
  file[presetKey] = cloneData(sanitizeForDefault(data)) as Record<string, unknown>;
  saveAll(file, kv);
  return { strippedSecrets: hadInlineSecret(data) };
}

/* ------------------------------------------------------------------ */
/* 应用                                                                */
/* ------------------------------------------------------------------ */

/**
 * 新建节点时叠加默认值。
 *
 * 调用顺序必须是 create() → init() → defaults()：
 *   create 铺全字段，init 覆盖变体差异，defaults 最后盖用户设的值。
 * 反过来写，用户精心设的默认会被 create 的出厂值盖掉。
 */
export function withDefault(
  presetKey: string,
  data: Record<string, unknown>,
  kv: KV = defaultKV(),
): Record<string, unknown> {
  const d = getDefault(presetKey, kv);
  if (Object.keys(d).length === 0) return data;
  // 深拷贝：多个新建节点不能共享嵌套对象（llm / config / rules）
  return { ...data, ...(cloneData(d) as Record<string, unknown>) };
}

/* ------------------------------------------------------------------ */
/* 节点 → 预设键 的反查                                                 */
/* ------------------------------------------------------------------ */

export type PresetLike = {
  key: string;
  type: string;
  init: () => unknown;
};

/**
 * 判断一个节点属于哪条侧栏预设。
 *
 * 新建时能直接拿到 preset.key（拖拽载荷里带着），但**存默认**时只有一个
 * 节点对象 —— 得反过来查它当初是从哪条预设拖出来的。
 *
 * 判据：type 相同，且 preset.init() 写进去的每个字段都与当前 data 一致。
 * 例如 WorkBuddy 变体 init 写 cli='codebuddy'，若节点 data.cli 还是这个值，
 * 就说明它没被改过、属于这条预设。
 *
 * 找不到匹配时返回 null（调用方应回落到 node.type）。
 * 这种情况很常见：用户改过 init 涉及的字段（比如把 cli 改成了另一个），
 * 此时它已不完全属于任何一条预设。
 */
export function matchPresetKey(
  presets: PresetLike[],
  type: string,
  data: Record<string, unknown>,
): string | null {
  const cands = presets.filter((p) => p.type === type);
  if (cands.length === 0) return null;

  for (const p of cands) {
    const init = (p.init() ?? {}) as Record<string, unknown>;
    const keys = Object.keys(init);
    if (keys.length === 0) continue;
    if (keys.every((k) => data[k] === init[k])) return p.key;
  }

  // 没有 init 的预设（多数类型只有一条）：就是它
  const plain = cands.find((p) => Object.keys((p.init() ?? {}) as object).length === 0);
  return plain ? plain.key : null;
}
