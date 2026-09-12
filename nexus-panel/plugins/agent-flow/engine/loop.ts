import type { Graph, LoopNodeData, LoopCtx } from '../types';
import { MAX_LOOP_ITERATIONS } from '../types';

export type LoopResolve = {
  items: string[];
  /** 来源说明，展示在节点卡片上 */
  reason: string;
  /** 非致命问题（如被上限截断） */
  warnings: string[];
  /** 致命错误：无法解析出任何迭代项 */
  error: string | null;
};

/**
 * 把分隔符字面量里的转义还原成真实字符。
 * 界面上存的是 '\n' 两个字符，这里要变成真正的换行。
 */
export function unescapeSeparator(sep: string): string {
  if (sep === '') return '\n';
  const map: Record<string, string> = {
    '\\n': '\n', '\\r': '\r', '\\t': '\t', '\\r\\n': '\r\n',
  };
  return map[sep] ?? sep;
}

/**
 * 安全上限：既不能超过节点自设的 maxIterations，也不能超过全局硬上限。
 *
 * `max` 必须防御非法值：maxIterations 是后来才加的字段，
 * 老画布从 localStorage 读出来的节点没有这个属性，传进来是 undefined。
 * 而 Math.min(5, undefined) === NaN，一路传到 Array.from({length: NaN})
 * 就得到空数组 —— 循环静默变成 0 轮，还显示成功，用户根本看不出没跑。
 */
export function clampIterations(n: number, max: number): number {
  const maxSafe = Number.isFinite(max) && max >= 0 ? max : MAX_LOOP_ITERATIONS;
  const want = Number.isFinite(n) ? n : 0;
  const capped = Math.min(want, maxSafe, MAX_LOOP_ITERATIONS);
  return Math.max(0, Math.floor(capped));
}

/**
 * 被上限截断成 0 轮是一种异常，不该当成"正常跑完 0 轮"。
 *
 * 用户显式把次数设成 0 的入口已被 `want < 1` 的检查拦下，
 * 走到这里还想迭代却得到 0，只能是 max 配成了 0 / 负数这类坏数据
 * —— 报出来比静默跑 0 轮好得多。
 */
export function zeroIterationError(want: number, got: number, what: string): string | null {
  if (want > 0 && got === 0) {
    return `${what}：请求 ${want} 轮但被上限截成 0（检查"轮数上限"是否配成了 0）`;
  }
  return null;
}

/**
 * 解析循环节点本轮要遍历的项。
 *
 * 三种来源：
 *  - times：固定次数，项为 '1' '2' '3'…（便于 {{loop.item}} 直接用）
 *  - list ：把上游输出按分隔符切分，去掉空项
 *  - glob ：通配符展开，由 Rust 侧执行后把结果放进 outputs，
 *          这里只负责按行拆分（真正的文件匹配在 fsOp 里做）
 */
export function resolveLoopItems(
  data: LoopNodeData,
  ctx: { outputs: Record<string, string>; input?: string },
): LoopResolve {
  const warnings: string[] = [];

  /* ---------- 固定次数 ---------- */
  if (data.mode === 'times') {
    const want = Math.floor(data.times);
    if (!Number.isFinite(want) || want < 1) {
      return {
        items: [],
        reason: '固定次数：未设置有效次数',
        warnings,
        error: '迭代次数必须 ≥ 1',
      };
    }
    const n = clampIterations(want, data.maxIterations);
    const zeroErr = zeroIterationError(want, n, '固定次数');
    if (zeroErr) {
      return { items: [], reason: '固定次数：被上限截成 0 轮', warnings, error: zeroErr };
    }
    if (n < want) warnings.push(`迭代次数被上限截断：${want} → ${n}`);
    const items = Array.from({ length: n }, (_, i) => String(i + 1));
    return { items, reason: `固定 ${n} 次`, warnings, error: null };
  }

  /* ---------- 取来源文本 ---------- */
  let text: string;
  if (data.mode === 'glob') {
    // glob 模式：路径展开由 Rust 完成，结果已写入 outputs[source]
    text = data.source && data.source !== 'input'
      ? (ctx.outputs[data.source] ?? '')
      : (ctx.input ?? '');
  } else if (data.source && data.source !== 'input') {
    text = ctx.outputs[data.source] ?? '';
    if (text === '' && !(data.source in ctx.outputs)) {
      warnings.push(`来源节点 ${data.source} 还没有输出`);
    }
  } else if (data.source === 'input') {
    text = ctx.input ?? '';
  } else {
    // 未指定来源：拼接全部已有输出
    text = Object.values(ctx.outputs).join('\n');
  }

  if (data.mode === 'glob') {
    const items = splitLines(text);
    if (items.length === 0) {
      return {
        items: [],
        reason: '匹配文件：无匹配结果',
        warnings,
        error: '通配符没有匹配到任何文件',
      };
    }
    const n = clampIterations(items.length, data.maxIterations);
    const zeroErr = zeroIterationError(items.length, n, '匹配文件');
    if (zeroErr) {
      return { items: [], reason: '匹配文件：被上限截成 0 轮', warnings, error: zeroErr };
    }
    if (n < items.length) warnings.push(`匹配到 ${items.length} 个，超过上限只取前 ${n} 个`);
    return {
      items: items.slice(0, n),
      reason: `匹配 ${n} 个文件`,
      warnings,
      error: null,
    };
  }

  /* ---------- 列表切分 ---------- */
  const sep = unescapeSeparator(data.separator);
  let items = text
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (items.length === 0) {
    return {
      items: [],
      reason: '遍历列表：来源为空',
      warnings,
      error: '来源文本为空，没有可遍历的项',
    };
  }

  const before = items.length;
  const n = clampIterations(items.length, data.maxIterations);
  const zeroErr = zeroIterationError(before, n, '遍历列表');
  if (zeroErr) {
    return { items: [], reason: '遍历列表：被上限截成 0 轮', warnings, error: zeroErr };
  }
  items = items.slice(0, n);
  if (n < before) warnings.push(`列表共 ${before} 项，超过上限只取前 ${n} 项`);

  return { items, reason: `遍历 ${items.length} 项`, warnings, error: null };
}

/** 按行拆分，兼容 \r\n，去空行 */
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 构造迭代上下文 */
export function makeLoopCtx(item: string, index: number, count: number): LoopCtx {
  return { item, index, count };
}

/**
 * 找出循环节点的"循环体"——即从 body 出口可达、且不属于 done 路径的节点。
 *
 * 算法：先从所有 body 边出发做正向 BFS 收集候选；
 * 再从 done 边出发 BFS，把只通过 done 才能到达的节点剔除。
 * 遇到循环节点自身停止扩展（回边不构成新的循环体成员）。
 */
export function loopBodyOf(loopId: string, graph: Graph): Set<string> {
  const fwd = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!fwd.has(e.source)) fwd.set(e.source, []);
    fwd.get(e.source)!.push(e.target);
  }

  const bodyEdges = graph.edges.filter(
    (e) => e.source === loopId && e.loopRole !== 'done',
  );
  const doneEdges = graph.edges.filter(
    (e) => e.source === loopId && e.loopRole === 'done',
  );

  const walk = (starts: string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === loopId || seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(fwd.get(cur) ?? []));
    }
    return seen;
  };

  const body = walk(bodyEdges.map((e) => e.target));
  const done = walk(doneEdges.map((e) => e.target));

  // done 独有的节点不属于循环体
  for (const id of done) {
    if (!body.has(id)) continue;
    // 同时可达时：只有"仅通过 done 可达"才剔除。
    // 这里用保守策略——若该节点的所有入边都来自 done 侧，则剔除
    const inEdges = graph.edges.filter((e) => e.target === id);
    const allFromDone = inEdges.length > 0 && inEdges.every((e) => done.has(e.source) && !body.has(e.source));
    if (allFromDone) body.delete(id);
  }
  return body;
}

/** 收集图中所有循环节点及其循环体 */
/**
 * 收集所有循环节点及其循环体成员。
 *
 * 必须容忍坏节点：手工改过的 JSON、旧版本迁移残留、导入的第三方 canvas
 * 都可能缺 data。这个函数在 runGraph 开头就调用，
 * 一旦抛异常整张画布都跑不起来，而堆栈指向内部函数很难定位。
 */
export function collectLoops(graph: Graph): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const n of graph.nodes ?? []) {
    if (n?.data?.kind !== 'loop') continue;
    map.set(n.id, loopBodyOf(n.id, graph));
  }
  return map;
}
