/**
 * MCP 工具 → 真正的 NodeDef。
 *
 * ================= 为什么与 mcpTools.ts 分开 =================
 *
 * `engine/mcpTools.ts` 是纯逻辑（schema → 蓝图），能单测、不依赖 React。
 * 这一层把蓝图变成注册表要的 NodeDef —— 需要 JSX，所以只能是 tsx。
 *
 * 分开的价值：**生成规则可以被测试覆盖**。
 * 混在组件里的话，要验证"某个 schema 生成出什么字段"就得渲染 React。
 *
 * ================= 一工具一节点 =================
 *
 * 每个工具一个 node.type，侧栏里按 server 折叠成小组（见分组逻辑）。
 * 好处是连线时一眼看得出用的是哪个工具；
 * 代价是工具多时 type 也多 —— 但它们共用同一个 dataKind 与执行器，
 * 所以**不会**带来执行器数量的膨胀。
 */

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from '../components/NodeShell';
import type { FieldDef } from '../components/inspectors/fields';
import type { NodeDef } from './types';
import { registerNode } from './registry';
import { withNodeRun, NodeFailError } from '../engine/runnerKit';
import { missingRequired } from '../engine/mcpTools';
import type { RunContext } from '../engine/runContext';
import {
  createMcpData, mcpColorOf, slugify,
  type NodeBlueprint,
} from '../engine/mcpTools';

/** 蓝图 → 字段清单 */
export function fieldsOf(bp: NodeBlueprint): FieldDef[] {
  const out: FieldDef[] = [
    /*
     * 顶部说明放在**字段之前**：这个节点是生成出来的，
     * 用户第一次看到时最想知道"它连的是哪个工具的哪个能力"。
     */
    {
      type: 'note',
      content: `${bp.sub}　（${bp.server} 的 ${bp.tool}）`,
    },
  ];

  for (const f of bp.fields) {
    const field: FieldDef = {
      type: f.kind,
      key: f.key,
      label: f.label + (f.required ? '（必填）' : ''),
    };
    if (f.hint) field.hint = f.hint;
    if (f.placeholder) field.placeholder = f.placeholder;
    if (f.options && f.options.length > 0) {
      field.options = f.options.map((v) => ({ value: v, label: v }));
    }
    out.push(field);
  }

  if (bp.fields.length === 0) {
    out.push({ type: 'note', content: '这个工具不需要参数。' });
  }
  return out;
}

/** 蓝图 → NodeDef（注册进注册表） */
export function defOf(bp: NodeBlueprint): NodeDef {
  const color = mcpColorOf(bp.server);
  return {
    type: bp.type,
    dataKind: bp.dataKind,
    meta: {
      label: bp.label,
      color,
      category: 'mcp',
      // id 前缀带 server 片段：画布上出现 mcpNotion1 比 mcp1 好认
      idPrefix: `mcp${slugify(bp.server).slice(0, 6)}`,
      sub: bp.sub,
    },
    create: (id, partial) => createMcpData(bp, {
      ...(partial ?? {}),
      id,
      label: bp.label,
    } as never) as never,
    Canvas: McpNodeCard,
    fields: () => fieldsOf(bp),
    /*
     * 执行器这一轮**不接协议**。
     *
     * 留空意味着节点会"直通成功"而不真的调用 ——
     * 那是最糟的结果（看着跑通了，其实什么都没做）。
     * 所以给一个明确失败的执行器，把"还没接上"说出来。
     */
    run: runPlaceholder(bp),
  };
}

/**
 * 所有生成节点共用的卡片。
 *
 * 不为每个工具生成专属卡片 —— 它们的差别（工具名、说明）都在 data 里，
 * 共用一张卡片即可，也省掉了"生成组件"这种没法测试的东西。
 */
function McpNodeCard({ id, type, data, selected }: NodeProps) {
  const d = (data ?? {}) as Record<string, unknown>;
  const tool = String(d.mcpTool ?? '');
  const server = String(d.mcpServer ?? '');
  return (
    <NodeShell
      id={id}
      type={type}
      data={d}
      selected={selected}
      statusText={{
        idle: '待运行', running: '调用中', success: '已完成',
        failed: '已失败', skipped: '已跳过',
      }}
      footExtra={<span className="node-model">{server}</span>}
    >
      <div className="node-brief">{tool || 'MCP 工具'}</div>
    </NodeShell>
  );
}

/**
 * 占位执行器 —— MCP 协议还没接上。
 *
 * 刻意**失败而不是直通成功**：直通会让这类节点看起来跑通了，
 * 实际什么都没做，那比报错难查得多。
 *
 * 不过**必填参数缺失会先报缺参数** —— 那是用户能修的问题，
 * 优先说它，而不是笼统一句"协议没接上"。
 */
function runPlaceholder(bp: NodeBlueprint) {
  return async function runMcpPlaceholder(ctx: RunContext): Promise<void> {
    await withNodeRun(ctx, async () => {
      const d = (ctx.node.data ?? {}) as Record<string, unknown>;
      const miss = missingRequired(d, bp);
      if (miss.length > 0) {
        throw new NodeFailError(`缺必填参数：${miss.join('、')}`);
      }
      throw new NodeFailError(
        `「${bp.tool}」由 ${bp.server} 提供，但 MCP 协议还没接上 —— 配好通道后才能真的调用`,
      );
    });
  };
}

/** 批量注册一批蓝图 */
export function registerBlueprints(list: NodeBlueprint[]): void {
  for (const bp of list) registerNode(defOf(bp));
}
