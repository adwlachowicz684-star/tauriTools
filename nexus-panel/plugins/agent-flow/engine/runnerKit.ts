import type { RunContext } from './runContext';
import { requiresOf } from './nodeRequires';

/**
 * 节点执行器的样板封装。
 *
 * 重构前 11 个执行器各写一遍这套流程，差别只在细节 —— 而细节恰恰是
 * 最容易漏的：GitHub 两个执行器就漏了 markFailed，导致节点变红但
 * 下游照跑、整轮还报成功（见 tests/nodeFailure.test.ts）。
 * 抽出来之后，"失败"只有一条路径，不可能再漏。
 *
 * 统一处理的四件事：
 *  1. 开头 setStatus(running)
 *  2. 成功 → 写 outputs / nodeFields，发 node-done ok:true，状态 success
 *  3. 失败 → 发 node-done ok:false（带原因），**markFailed**，状态 failed
 *  4. 无论成败，都发 node-done —— 保证每个节点都有终态事件
 *
 * 第 4 点尤其重要：此前 GitHub 执行器失败时只发 node-error（语义上是
 * "还没到完成那一步"的前置失败），日志里这个节点永远没有完成记录，
 * 而且不会触发任何收尾。
 */

/**
 * 执行器主动抛出的失败。
 *
 * 带 output 是因为有些节点失败时也要给下游一个值：
 * 更新检测类节点失败输出 'false'，下游条件判断才能正常走"无更新"分支。
 * 不带则留空。
 */
/**
 * 下面两个别名纯粹是为了迁就 scripts/strip-ts.py：
 * 它剥不掉带尖括号的类型（`Record<string, string>` 会原样留在 .mjs 里，
 * Node 直接语法错误）。用别名把尖括号隔离在这两行里即可。
 */
type Fields = Record<string, string>;
type FileList = string[];

export class NodeFailError extends Error {
  /*
   * 写法刻意避开 TS 类字段的 `?` 修饰符与类型注解：
   * scripts/strip-ts.py（沙盒里用来把 TS 剥成 ESM 跑单测）不认这些，
   * 会把 `fields?: Record<...>` 原样留在 .mjs 里，Node 直接语法错误。
   * 字段一律在构造函数里赋初值。
   */
  output: string = '';
  fields: Fields | null = null;
  files: FileList | null = null;

  constructor(
    message: string,
    output: string = '',
    fields: Fields | null = null,
    files: FileList | null = null,
  ) {
    super(message);
    this.name = 'NodeFailError';
    this.output = output;
    this.fields = fields;
    this.files = files;
  }
}

/** 执行成功时的产出 */
export type NodeRunOutput = {
  output: string;
  /** {{id.xxx}} 附加字段。给了会写进 ctx.nodeFields 并发 node-fields 事件 */
  fields?: Fields;
  /** 文件列表。仅任务节点产出，用于让 UI 显示"改了哪些文件" */
  files?: FileList;
  /**
   * 提示性错误（失败但不妨碍判定，如更新检测抓到了但解析有告警）。
   * 给了会挂在 node-done 的 error 上，但**不**算失败、不改状态。
   */
  warn?: string;
};

/** 写附加字段并通知 UI；两者都没给则什么都不做 */
function writeFields(ctx: RunContext, fields: Fields | null, files: FileList | null): void {
  if (!fields && !files) return;
  const { id, emit, nodeFields } = ctx;
  if (fields) nodeFields[id] = fields;
  emit({
    type: 'node-fields',
    id,
    files: files ?? [],
    fields: nodeFields[id] ?? {},
  });
}

/**
 * 包一层统一的运行流程。
 *
 * 用法：
 * ```ts
 * export async function runXxx(ctx: RunContext): Promise<void> {
 *   const d = node.data as XxxNodeData;
 *   await withNodeRun(ctx, async () => {
 *     if (!opts.fooExecutor) throw new NodeFailError('未提供 xx 执行器');
 *     ...
 *     return { output: text };
 *   });
 * }
 * ```
 *
 * 前置校验直接 throw NodeFailError 即可，不必再写
 * `setStatus('failed'); emit(...); return;` 三连 —— 那三连正是漏
 * markFailed 的根源。
 */
export async function withNodeRun(
  ctx: RunContext,
  run: () => Promise<NodeRunOutput>,
): Promise<void> {
  const { id, setStatus, emit, markFailed, scope, outputs, nodeFields } = ctx;

  setStatus(id, 'running');
  try {
    /*
     * 能力校验下沉：节点声明自己需要什么执行器（engine/nodeRequires.ts），
     * 这里统一检查。执行器不用再写 `if (!opts.xxx) throw`。
     *
     * 放在 try 内是刻意的 —— 校验失败走的是同一条失败路径
     * （node-done ok:false + markFailed + failed），与业务失败表现一致。
     */
    const opts = ctx.opts as unknown as Record<string, unknown>;
    for (const req of requiresOf(ctx.node.data as unknown as Record<string, unknown>)) {
      if (opts[req.key]) continue;
      throw new NodeFailError(
        `未提供${req.label}执行器（当前可能运行在浏览器模式）`,
        req.failOutput ?? '',
      );
    }

    const r = await run();
    outputs[id] = r.output;
    // 写了 fields / files 就必须发事件通知 UI，否则界面上会残留上一次的值
    writeFields(ctx, r.fields, r.files);
    emit({
      type: 'node-done',
      id,
      ok: true,
      output: r.output,
      error: r.warn,
    });
    setStatus(id, 'success');
  } catch (err) {
    const fail = err instanceof NodeFailError ? err : null;
    const msg = err instanceof Error ? err.message : String(err);
    const out = fail?.output ?? '';

    outputs[id] = out;
    writeFields(ctx, fail ? fail.fields : null, fail ? fail.files : null);

    emit({ type: 'node-done', id, ok: false, output: out, error: msg });
    // 关键：写 scope.failedSet，下游靠它决定是否跳过。
    // 漏掉这一行就会出现"节点红着、下游照跑"的假失败。
    markFailed(id, scope);
    setStatus(id, 'failed');
  }
}
