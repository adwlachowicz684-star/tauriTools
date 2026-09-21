import { defaultKV, type KV } from './kv';

/**
 * 节点类型的自定义颜色。
 *
 * ================= 为什么是「类型级」 ====================
 *
 * 画布卡片的颜色取自 `getDef(type).meta.color`（节点定义里声明的类型色），
 * 侧栏条目用的也是同一份。也就是说颜色的自然粒度是**类型**，不是预设。
 *
 * 若按预设存覆盖，同一类型下的多个预设会各有一份颜色，
 * 而画布上的卡片只有 type 可查 —— 不知道该用哪一份，
 * 于是侧栏和画布又开始显示不同的颜色（这正是之前反复出现的问题）。
 *
 * 所以覆盖以 type 为键：改一处，侧栏与画布同时生效。
 *
 * ================= 自定义预设 ====================
 *
 * 自定义预设自带 `color` 字段，它比类型覆盖**更具体**，
 * 所以优先级更高 —— 见 resolveNodeColor。
 */

const STORAGE_KEY = 'agent-flow.nodeColors.v1';
const FORMAT_VERSION = 1;

export type ColorMap = Record<string, string>;

/** 十六进制色值的严格校验。宽松的正则会把 `#GGG` 之类也放过去 */
const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v.trim());
}

function parse(raw: string | null): ColorMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    const body = Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown> | null)?.colors;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    const out: ColorMap = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length > 0 && isHexColor(v)) out[k] = (v as string).trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function loadColorOverrides(kv: KV = defaultKV()): ColorMap {
  return parse(kv.get(STORAGE_KEY));
}

export function saveColorOverrides(map: ColorMap, kv: KV = defaultKV()): void {
  try {
    kv.set(STORAGE_KEY, JSON.stringify({ version: FORMAT_VERSION, colors: map }));
  } catch {
    /* 存不下就算了，不能让整个插件挂掉 */
  }
}

/** 设色。传 null / 非法值即恢复默认（删掉这一条，不留空值） */
export function setColorOverride(
  type: string,
  color: string | null,
  kv: KV = defaultKV(),
): ColorMap {
  const map = loadColorOverrides(kv);
  if (color === null || !isHexColor(color)) delete map[type];
  else map[type] = color.trim();
  saveColorOverrides(map, kv);
  return map;
}

/**
 * 最终显示色。
 *
 * 优先级：自定义预设自己的 > 类型覆盖 > 类型默认色。
 * 自定义预设那份更具体（是"这一条"的设定），所以压过类型级覆盖。
 */
export function resolveNodeColor(
  type: string,
  fallback: string,
  presetColor?: string,
  overrides: ColorMap = loadColorOverrides(),
): string {
  if (presetColor && isHexColor(presetColor)) return presetColor.trim();
  const own = overrides[type];
  if (own && isHexColor(own)) return own;
  return fallback;
}
