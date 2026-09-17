import type { NodeData } from '../types';
import { stripRuntime, cloneData } from './duplicate';
import { hadInlineSecret, stripSecrets } from './sanitize';
import { defaultKV, loadList, saveWrapped, type KV } from './kv';

/**
 * 用户自定义节点（本质是「预设」）。
 *
 * 为什么做成预设而不是注册新的 NodeDef：
 * 自定义节点只是"把某个已存在的节点配好一份参数"，行为完全由基础类型决定 ——
 * 执行器、画布卡片、属性面板全都该继承，一个字都不用重写。
 * 让它复用基础类型的 type，这些就自动继承；
 * 若真去注册一套新 NodeDef，就要为每种基础类型再抄一遍 Canvas / fields / run，
 * 而那份拷贝会随着基础节点演进而腐坏。
 *
 * 存的是**配置**（剥掉运行时状态的那部分），不是节点实例。
 */

export const CUSTOM_PREFIX = 'custom:';
const STORAGE_KEY = 'agent-flow.customPresets.v1';
const FORMAT_VERSION = 1;

export type CustomPreset = {
  id: string;
  /** 展示名。允许重名（不同用途叫同一个词很正常），靠 id 区分 */
  name: string;
  /** 基础节点类型，如 'generic-http' / 'extract' / 'task' */
  baseType: string;
  /** 侧栏圆点色。不填则用基础类型的色 */
  color?: string;
  /** 已剥离运行时状态的配置 */
  data: Record<string, unknown>;
  createdAt: number;
};

/* ------------------------------------------------------------------ */
/* 剥离运行时状态                                                       */
/* ------------------------------------------------------------------ */

/*
 * 口径统一到 engine/duplicate.ts 的 stripRuntime ——
 * 「复制节点」与「存成预设」要清掉的运行时字段是同一批，
 * 分成两份写迟早会漂移（比如新增一个 lastXxx，只改了一边）。
 */

/**
 * 内联密钥字段。
 *
 * 与 canvasStore 的 SECRET_FIELDS 保持同一套口径（'token' 是 GitHub 节点的
 * 内联令牌，'llm.apiKey' 是 OCR / 翻译的大模型密钥）。改一处请同步另一处。
 *
 * 为什么自定义预设也必须脱敏：预设存的是明文 localStorage，而画布里的密钥
 * 走的是加密保险箱。若把内联令牌带进预设，等于新开一处明文密钥存放地，
 * 比既有的保护还弱 —— 而导出成 JSON 分享出去时更是直接交了出去。
 *
 * 注意：**凭据引用（credentialId）不受影响，会正常保留**。
 * 也就是说走凭据中心的用法可以完整复用与分享，被剥掉的只有
 * "把令牌直接填在节点里"这种不推荐的做法。
 */
/* 密钥清单与剥离统一走 ./sanitize —— 见那里关于复制两份会泄露的说明 */

/**
 * 挑出配置部分。
 *
 * 用"status/output/error + last* 前缀"的黑名单而不是白名单：
 * 各节点配置字段差异太大（十几套），维护一份白名单既长又容易漏掉新字段；
 * 而运行时字段的命名是收敛的（都是 last 开头，或就那三个）。
 *
 * 副作用：往后会新增的运行时字段，只要沿用 last* 命名就自动被剥掉。
 */
export function sanitizeForPreset(data: unknown): Record<string, unknown> {
  return stripSecrets(stripRuntime(data));
}

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

/** 可注入的存储，便于测试与不支持 localStorage 的环境 */
/* KV / defaultKV / loadList 统一走 ./kv */

/** 读出来的东西不可信：可能是旧版本、手改过、或别的插件写坏的 */
function isPreset(x: unknown): x is CustomPreset {
  const o = x as CustomPreset;
  return (
    !!o &&
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.name === 'string' &&
    typeof o.baseType === 'string' &&
    !!o.data &&
    typeof o.data === 'object'
  );
}

export function loadCustomPresets(kv: KV = defaultKV()): CustomPreset[] {
  return loadList(kv, STORAGE_KEY, 'presets', isPreset) as CustomPreset[];
}

export function saveCustomPresets(list: CustomPreset[], kv: KV = defaultKV()): void {
  saveWrapped(kv, STORAGE_KEY, FORMAT_VERSION, 'presets', list);
}

/* ------------------------------------------------------------------ */
/* 增删改                                                              */
/* ------------------------------------------------------------------ */

function newId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 存一个新预设。
 *
 * @param data 节点当前的完整 data，内部会剥离运行时状态
 */
export function addCustomPreset(
  input: { name: string; baseType: string; data: unknown; color?: string },
  kv: KV = defaultKV(),
): CustomPreset {
  const list = loadCustomPresets(kv);
  const preset: CustomPreset = {
    id: newId(),
    name: input.name.trim() || '未命名节点',
    baseType: input.baseType,
    color: input.color,
    data: sanitizeForPreset(input.data),
    createdAt: Date.now(),
  };
  list.push(preset);
  saveCustomPresets(list, kv);
  return preset;
}

export function removeCustomPreset(id: string, kv: KV = defaultKV()): void {
  saveCustomPresets(loadCustomPresets(kv).filter((p) => p.id !== id), kv);
}

export function renameCustomPreset(id: string, name: string, kv: KV = defaultKV()): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  saveCustomPresets(
    loadCustomPresets(kv).map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
    kv,
  );
}

/* ------------------------------------------------------------------ */
/* 跨环境分享                                                          */
/* ------------------------------------------------------------------ */

/**
 * 导出成可分享的 JSON。
 *
 * 再脱一道敏：预设本身在存入时就已剥过内联密钥，但老数据（本次改动之前存的）
 * 可能还带着。导出是"交给别人"的动作，在这一步兜住比指望历史数据干净更可靠。
 */
export function exportCustomPresets(kv: KV = defaultKV()): string {
  const presets = loadCustomPresets(kv).map((p) => ({
    ...p,
    data: sanitizeForPreset(p.data),
  }));
  return JSON.stringify({ version: FORMAT_VERSION, presets }, null, 2);
}

export type ImportResult = {
  added: number;
  updated: number;
  skipped: string[];
};

/**
 * 导入预设。
 *
 * @param isKnownType 基础类型是否可用。跨环境分享时对方可能没装对应的基础节点，
 *                    这时不能硬塞 —— 塞进去侧栏会出现一个点了没反应的条目。
 *                    由调用方传入判断（注册表在 UI 层，这里不能反向依赖它，
 *                    否则 registry → customPresets → registry 成环）。
 */
export function importCustomPresets(
  json: string,
  opts: { isKnownType: (t: string) => boolean; mode?: 'merge' | 'replace' },
  kv: KV = defaultKV(),
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('不是合法的 JSON');
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { presets?: unknown })?.presets;
  if (!Array.isArray(list)) throw new Error('文件里没有预设列表');

  const result: ImportResult = { added: 0, updated: 0, skipped: [] };
  const current = opts.mode === 'replace' ? [] : loadCustomPresets(kv);

  for (const item of list) {
    if (!isPreset(item)) {
      result.skipped.push(String((item as { name?: string })?.name ?? '(无名)'));
      continue;
    }
    if (!opts.isKnownType(item.baseType)) {
      result.skipped.push(`${item.name}（本机没有「${item.baseType}」这种节点）`);
      continue;
    }
    // 同 id 视为同一条，覆盖；否则新增。这样重复导入不会堆出一堆副本。
    const at = current.findIndex((p) => p.id === item.id);
    if (at >= 0) {
      current[at] = item;
      result.updated += 1;
    } else {
      current.push(item);
      result.added += 1;
    }
  }

  saveCustomPresets(current, kv);
  return result;
}

/** 侧栏拖拽载荷用的 key */
export function presetKey(id: string): string {
  return CUSTOM_PREFIX + id;
}

/** 从载荷 key 反解出预设 id；不是自定义预设则返回 null */
export function presetIdOf(key: string): string | null {
  return key.indexOf(CUSTOM_PREFIX) === 0 ? key.slice(CUSTOM_PREFIX.length) : null;
}

/** 按预设造初始数据。每次返回新对象，避免多个实例共享同一份被就地改写 */
/**
 * 按预设造初始数据。
 *
 * 必须深拷贝（cloneData），不能只展开一层：
 * data 里有嵌套对象（llm / config / rules），浅拷贝会让**所有从这个预设
 * 拖出来的节点共享同一份嵌套对象** —— 改其中一个的模型配置，
 * 其余实例和预设本身跟着变。这类 bug 不报错，只表现为
 * "改了一个，另一个也动了"，极难定位。
 *
 * 与 engine/duplicate.ts 复制节点时用的是同一个 cloneData，口径一致。
 */
export function dataOf(p: CustomPreset): NodeData {
  return cloneData(p.data) as unknown as NodeData;
}
