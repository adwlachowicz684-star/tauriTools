/**
 * 多画布管理（纯逻辑，可单测）。
 *
 * 每个画布是一个独立的工作流：自己的节点、连线、触发器。
 * 增删改名切换都在这层完成，UI 只负责调用与渲染。
 */

export type Canvas = {
  id: string;
  name: string;
  /** 节点，元素类型由调用方决定（React Flow 节点） */
  nodes: unknown[];
  edges: unknown[];
  createdAt: number;
  updatedAt: number;
};

export type CanvasMeta = {
  id: string;
  name: string;
  nodeCount: number;
  edgeCount: number;
  updatedAt: number;
};

let seq = 0;

export function makeCanvas(name: string, partial: Partial<Canvas> = {}): Canvas {
  seq += 1;
  const now = Date.now();
  return {
    id: partial.id ?? `cv${now.toString(36)}${seq}`,
    name,
    nodes: partial.nodes ?? [],
    edges: partial.edges ?? [],
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

/** 新建时给个不重复的默认名：工作流 1 / 2 / 3 … */
export function nextCanvasName(existing: Canvas[], base = '工作流'): string {
  const used = new Set(existing.map((c) => c.name));
  let i = 1;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/**
 * 改名。
 * 同名自动加后缀，避免两个画布分不清；空名回退到原名。
 */
export function renameCanvas(
  list: Canvas[],
  id: string,
  rawName: string,
): { list: Canvas[]; name: string } {
  const name = (rawName ?? '').trim();
  const target = list.find((c) => c.id === id);
  if (!target) return { list, name: rawName };

  if (name === '' || name === target.name) {
    return { list, name: target.name };
  }

  // 与其他画布重名 → 追加 (2) (3)…
  const others = new Set(list.filter((c) => c.id !== id).map((c) => c.name));
  let finalName = name;
  if (others.has(finalName)) {
    let i = 2;
    while (others.has(`${name} (${i})`)) i += 1;
    finalName = `${name} (${i})`;
  }

  return {
    list: list.map((c) => (c.id === id ? { ...c, name: finalName, updatedAt: Date.now() } : c)),
    name: finalName,
  };
}

export function removeCanvas(
  list: Canvas[],
  id: string,
): { list: Canvas[]; removed: Canvas | null } {
  const removed = list.find((c) => c.id === id) ?? null;
  return { list: list.filter((c) => c.id !== id), removed };
}

/**
 * 删除后该激活谁。
 * 优先选被删画布的**后一个**，没有则前一个，都没有则 null（说明全删光了）。
 * 这个顺序符合直觉：删掉中间一项，焦点落到它后面那项。
 */
export function nextActiveId(list: Canvas[], removedId: string, removedIndex: number): string | null {
  if (list.length === 0) return null;
  if (removedIndex < 0) return list[0]?.id ?? null;
  const nextIdx = Math.min(removedIndex, list.length - 1);
  return list[nextIdx].id;
}

export function updateCanvasContent(
  list: Canvas[],
  id: string,
  patch: { nodes?: unknown[]; edges?: unknown[] },
): Canvas[] {
  return list.map((c) =>
    c.id === id
      ? {
          ...c,
          nodes: patch.nodes ?? c.nodes,
          edges: patch.edges ?? c.edges,
          updatedAt: Date.now(),
        }
      : c,
  );
}

export function toMeta(c: Canvas): CanvasMeta {
  return {
    id: c.id,
    name: c.name,
    nodeCount: c.nodes.length,
    edgeCount: c.edges.length,
    updatedAt: c.updatedAt,
  };
}

/** 列表展示用：按更新时间倒序（最近编辑的在前面） */
export function sortForDisplay(list: Canvas[]): Canvas[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'agent-flow.canvases.v1';
const ACTIVE_KEY = 'agent-flow.activeCanvas.v1';

export type PersistedState = {
  canvases: Canvas[];
  activeId: string | null;
};

export function serialize(state: PersistedState): string {
  return JSON.stringify(state);
}

/**
 * 反序列化并做完整性修复。
 *
 * 为什么不能直接用 JSON.parse 的结果：
 *  - 手改过的 localStorage 可能缺字段
 *  - 旧版本存的数据没有新增字段
 *  - activeId 可能指向已不存在的画布
 * 任一种都会让 UI 崩在渲染阶段，所以这里统一兜底。
 */
export function deserialize(raw: string | null): PersistedState {
  if (!raw) return { canvases: [], activeId: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { canvases: [], activeId: null };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { canvases: [], activeId: null };
  }

  const obj = parsed as Record<string, unknown>;
  const rawList = Array.isArray(obj.canvases) ? obj.canvases : [];

  const canvases: Canvas[] = rawList
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x, i) => ({
      id: typeof x.id === 'string' ? x.id : `cv_restored_${i}`,
      name: typeof x.name === 'string' && x.name.trim() !== '' ? x.name : `工作流 ${i + 1}`,
      nodes: Array.isArray(x.nodes) ? x.nodes : [],
      edges: Array.isArray(x.edges) ? x.edges : [],
      createdAt: typeof x.createdAt === 'number' ? x.createdAt : Date.now(),
      updatedAt: typeof x.updatedAt === 'number' ? x.updatedAt : Date.now(),
    }));

  // 去重 id，避免 React key 冲突导致渲染错乱
  const seen = new Set<string>();
  const deduped = canvases.map((c) => {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      return c;
    }
    let k = 2;
    while (seen.has(`${c.id}_${k}`)) k += 1;
    const nid = `${c.id}_${k}`;
    seen.add(nid);
    return { ...c, id: nid };
  });

  let activeId = typeof obj.activeId === 'string' ? obj.activeId : null;
  if (activeId && !deduped.some((c) => c.id === activeId)) {
    activeId = deduped[0]?.id ?? null; // 指向已删除的画布 → 退到第一个
  }

  return { canvases: deduped, activeId };
}

export function loadFromStorage(
  get: (k: string) => string | null,
): PersistedState {
  return deserialize(get(STORAGE_KEY));
}

export function saveToStorage(
  set: (k: string, v: string) => void,
  state: PersistedState,
): void {
  set(STORAGE_KEY, serialize(state));
  if (state.activeId) set(ACTIVE_KEY, state.activeId);
}

export const STORAGE_KEYS = { canvases: STORAGE_KEY, active: ACTIVE_KEY };
