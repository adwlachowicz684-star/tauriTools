import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { upstreamText } from '../upstream';
import {
  mathOp, textOp, compareOp, randomOp,
  type MathOp, type TextOp, type CompareOp, type RandomOp,
} from '../ops';

/**
 * 四个运算节点共用一个执行器骨架 ——
 * 它们的差别只有"调哪个函数、读哪几个参数"，
 * 各写一份会多出四份几乎相同的四十行。
 */

type Args = { a: unknown; b: unknown; c: unknown };

function runOp(
  ctx: RunContext,
  kind: 'math' | 'text' | 'compare' | 'random',
  op: string,
  read: (d: Record<string, unknown>) => Args,
) {
  return withNodeRun(ctx, async () => {
    const d = ctx.node.data as Record<string, unknown>;
    const { a, b, c } = read(d);

    /*
     * 参数支持模板，所以先渲染再运算 ——
     * 直接用原始字符串的话 {{a.output}} 会被当成文本，算不出结果。
     */
    const ra = ctx.tpl(String(a ?? ''));
    const rb = ctx.tpl(String(b ?? ''));
    const rc = ctx.tpl(String(c ?? ''));

    let r;
    if (kind === 'math') r = mathOp(op as MathOp, ra, rb);
    else if (kind === 'text') r = textOp(op as TextOp, ra, rb, rc);
    else if (kind === 'compare') r = compareOp(op as CompareOp, ra, rb);
    else r = randomOp(op as RandomOp, ra, rb);

    if (!r.ok) throw new NodeFailError(r.error);
    return { output: r.value };
  });
}

/** 数学运算 */
export async function runMath(ctx: RunContext): Promise<void> {
  await runOp(ctx, 'math', String((ctx.node.data as Record<string, unknown>).op ?? 'add'),
    (d) => ({ a: d.a, b: d.b, c: '' }));
}

/** 文本运算 */
export async function runText(ctx: RunContext): Promise<void> {
  await runOp(ctx, 'text', String((ctx.node.data as Record<string, unknown>).op ?? 'concat'),
    (d) => ({ a: d.a, b: d.b, c: d.c }));
}

/** 比较运算 */
export async function runCompare(ctx: RunContext): Promise<void> {
  await runOp(ctx, 'compare', String((ctx.node.data as Record<string, unknown>).op ?? 'eq'),
    (d) => ({ a: d.a, b: d.b, c: '' }));
}

/** 随机 */
export async function runRandom(ctx: RunContext): Promise<void> {
  await runOp(ctx, 'random', String((ctx.node.data as Record<string, unknown>).op ?? 'int'),
    (d) => ({ a: d.a, b: d.b, c: '' }));
}

/** 变量：读或写一个工作流变量 */
export async function runVar(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as Record<string, unknown>;
    const name = ctx.tpl(String(d.name ?? '')).trim();
    if (!name) throw new NodeFailError('没填变量名');

    const mode = String(d.mode ?? 'set');
    const up = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);

    if (mode === 'get') {
      const v = ctx.vars[name];
      /*
       * 变量没设过时**失败**而不是给空串 ——
       * 空串会让下游以为"查到了，是空的"，
       * 而实际是"根本没赋值"，两者要修的方式完全不同。
       */
      if (v === undefined) throw new NodeFailError(`变量「${name}」还没被赋值`);
      return { output: v };
    }

    // set：值优先用配的 value，没填则取上游输出
    const raw = String(d.value ?? '');
    const val = raw.trim() ? ctx.tpl(raw) : up;
    ctx.vars[name] = val;
    // 写入后输出该值 —— 下游可以直接接着用，不必再读一次
    return { output: val };
  });
}

/** 停止：终止整个流程或当前分支 */
export async function runStop(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as Record<string, unknown>;
    const mode = String(d.mode ?? 'all') === 'branch' ? 'branch' : 'all';

    /*
     * 不算失败 ——
     * "用户/流程主动停下"与"出错"是两回事。
     * 记成失败的话日志里一片红，排查时会往错误方向找。
     */
    ctx.requestStop(mode);
    const up = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
    return { output: up };
  });
}

/** 人工输入：弹框等人填 */
export async function runAsk(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as Record<string, unknown>;
    const promptText = ctx.tpl(String(d.prompt ?? '')).trim() || '请输入内容';
    const def = ctx.tpl(String(d.value ?? ''));

    const answer = await ctx.askHuman(promptText, def);
    /*
     * null 有两种含义，必须分开说：
     * 界面没接这个能力（实现问题） vs 用户取消（用户决定）。
     * 混成一句"没有输入"的话，用户会以为是自己的问题。
     */
    if (answer === null) {
      throw new NodeFailError('这个环境不支持「人工输入」，或你取消了输入');
    }
    if (String(d.required ?? true) === 'true' && !answer.trim()) {
      throw new NodeFailError('这就是必填项，没填内容');
    }
    return { output: answer };
  });
}
