import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { upstreamText } from '../upstream';
import {
  parseCsv, toCsv, deriveColumn, filterRows, aggregate, tableBrief,
  type Table,
} from '../table';

/**
 * 表格节点执行器。
 *
 * 表格以 CSV 文本在节点间流动，所以"取上游的表"就是取上游输出 ——
 * 没有隐藏状态，重跑一定得到同样结果。
 */

/** 从上游拿表；上游没内容时报错而不是当空表 */
function tableFrom(ctx: RunContext): Table {
  const raw = upstreamText(ctx.graph.edges, ctx.id, ctx.outputs, ctx.opts.input);
  if (!raw.trim()) {
    throw new NodeFailError('上游没有表格数据 —— 前面要接一个「读表格」节点');
  }
  const t = parseCsv(raw);
  if (t.header.length === 0) {
    throw new NodeFailError('上游的内容不是有效表格（没读到表头）');
  }
  return t;
}

/** 读表格文件 */
export async function runTableRead(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as Record<string, unknown>;
    const path = ctx.tpl(String(d.path ?? '')).trim();
    if (!path) throw new NodeFailError('没填表格文件路径');

    if (!ctx.opts.tableReader) {
      throw new NodeFailError('读表格需要桌面端（当前环境没有文件读取能力）');
    }
    let text: string;
    try {
      text = await ctx.opts.tableReader(path);
    } catch (err) {
      throw new NodeFailError(err instanceof Error ? err.message : String(err));
    }
    if (!text.trim()) throw new NodeFailError(`文件是空的：${path}`);

    const delim = String(d.delim ?? '').trim();
    const t = parseCsv(text, delim || undefined);
    if (t.header.length === 0) throw new NodeFailError('没读到表头，确认文件是 CSV / TSV 格式');

    const csv = toCsv(t);
    return {
      output: csv,
      fields: { 行数: String(t.rows.length), 列数: String(t.header.length), 摘要: tableBrief(t) },
    };
  });
}

/** 推导新列 */
export async function runDerive(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as Record<string, unknown>;
    const t = tableFrom(ctx);
    const newCol = ctx.tpl(String(d.newCol ?? '')).trim();
    const expr = ctx.tpl(String(d.expr ?? ''));

    const r = deriveColumn(t, newCol, expr, { replace: String(d.replace) === 'true' });
    if (!r.ok && r.errors.length === 1 && r.errors[0].includes('没填')) {
      throw new NodeFailError(r.errors[0]);
    }
    if (!r.ok && r.table === t) {
      // 列名冲突这类整体失败
      throw new NodeFailError(r.errors[0] ?? '推导失败');
    }
    /*
     * 个别行算错时**不算失败** ——
     * 一张 200 行的表因为某一行有空值就全部作废，用户没法定位问题。
     * 把错误作为提示挂上去，结果照常往下传。
     */
    const warn = r.errors.length > 0
      ? `${r.errors.length} 行没算出来：${r.errors[0]}${r.errors.length > 1 ? ' …' : ''}`
      : undefined;
    return {
      output: toCsv(r.table),
      warn,
      fields: { 摘要: tableBrief(r.table), 行数: String(r.table.rows.length) },
    };
  });
}

/** 筛选行 */
export async function runFilter(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as Record<string, unknown>;
    const t = tableFrom(ctx);
    const cond = ctx.tpl(String(d.cond ?? ''));
    const r = filterRows(t, cond);
    if (!r.ok) throw new NodeFailError(r.error);
    return {
      output: toCsv(r.table),
      fields: { 保留行数: String(r.table.rows.length), 摘要: tableBrief(r.table) },
    };
  });
}

/** 汇总某一列 */
export async function runAgg(ctx: RunContext): Promise<void> {
  await withNodeRun(ctx, async () => {
    const d = ctx.node.data as Record<string, unknown>;
    const t = tableFrom(ctx);
    const col = ctx.tpl(String(d.col ?? '')).trim();
    const op = String(d.op ?? 'sum') as 'sum' | 'avg' | 'min' | 'max' | 'count';
    if (!col) throw new NodeFailError('没填要汇总的列名');

    const r = aggregate(t, col, op);
    if (!r.ok) throw new NodeFailError(r.error);
    const value = Number.isInteger(r.value) ? String(r.value) : String(Number(r.value.toFixed(10)));
    return {
      output: value,
      fields: { 列名: col, 方式: op, 结果: value },
    };
  });
}
