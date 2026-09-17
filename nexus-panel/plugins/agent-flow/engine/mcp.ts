/**
 * 自带 MCP 能力的节点 —— **预留层**，当前只做登记与查询。
 *
 * ================= 为什么现在就留这一层 =================
 *
 * 用户要的是：将来能有一批「专属服务某个软件/功能」的节点
 * （比如「Notion 节点」「Figma 节点」「Blender 节点」），
 * 它们内部各自知道自己该连哪个 MCP、调哪个工具。
 * 这类节点更像是社区创造的"应用界面"，而不是通用积木。
 *
 * 关键区别：
 *   通用节点（HTTP / 提取 / 条件）→ 用户在画布上配 MCP，节点按需引用
 *   专属节点（Notion / Figma…）  → **节点自带** MCP 需求，用户只填业务参数
 *
 * 现在就把"节点自带 MCP 需求"这条通道开出来，将来加专属节点时
 * 只需要登记一条 `mcpNeed`，不用再改引擎与面板的分发逻辑。
 *
 * ================= 当前不做的事 =================
 *
 * 不实现 MCP 协议的任何部分（进程启动、工具列举、调用编解码）。
 * 那一层取决于 server 的形态（stdio 子进程 / HTTP），
 * 很可能要落到 Rust 侧，属于另一个改动面。
 */

import type { McpServer } from './canvasConfig';

/** 一个节点自带的 MCP 需求 */
export type McpNeed = {
  /**
   * 需要的服务类型标识。
   * 例：'notion' / 'figma' —— 与画布上配的服务做匹配。
   */
  service: string;
  /**
   * 这个节点要用的工具名。
   * 留空表示"用到该服务的任意工具"，由节点自己在参数里指定。
   */
  tool?: string;
  /** 人类可读的说明，用于面板提示与报错 */
  desc: string;
};

/**
 * 登记：某类节点自带哪种 MCP 需求。
 *
 * key 用 dataKind，与注册表、执行分发的口径一致。
 */
export type McpNeedMap = Record<string, McpNeed>;

/**
 * 当前登记的专属节点。
 * **空表** —— 等真正做专属节点时往这里加，不需要改别处。
 */
export const MCP_NEEDS: McpNeedMap = {};

/** 查某类节点是否自带 MCP 需求 */
export function mcpNeedOf(kind: string): McpNeed | null {
  return MCP_NEEDS[kind] ?? null;
}

/**
 * 把节点自带的 MCP 需求与画布上配的服务对上。
 *
 * 匹配顺序：
 *   1. 名字精确等于 service（用户把服务名起成 'notion'）
 *   2. 名字包含 service（'notion-workspace' 也能配上）
 *
 * 返回 null 表示画布上没配对应服务 —— 调用方应提示
 * "这个节点需要 notion 的 MCP 服务，画布上还没配"。
 */
export function matchMcpForNeed(
  servers: McpServer[],
  need: McpNeed,
): McpServer | null {
  const list = servers ?? [];
  if (list.length === 0) return null;
  const key = (need.service ?? '').trim().toLowerCase();
  if (!key) return null;

  const named = (s: McpServer) => (s.name ?? '').trim().toLowerCase();
  return list.find((s) => named(s) === key)
    ?? list.find((s) => named(s).includes(key))
    ?? null;
}

/**
 * 将来做专属节点时的检查清单。
 *
 * 这份清单的存在意义：这类节点跨了"节点定义 + MCP 需求 + 面板"三处，
 * 很容易漏登记其中一处，表现为"节点在侧栏能拖出来、但一跑就说没配服务"。
 * 把步骤写在这儿，加节点时照着走一遍。
 */
export const MCP_NODE_CHECKLIST = [
  '在 nodes/defs/ 下写一份节点定义（照抄一个现有的）',
  '在 MCP_NEEDS 里登记它的 service 与 tool',
  '面板里只暴露业务参数 —— MCP 地址/命令不出现在节点上',
  '执行器里通过 resolveMcpServer + matchMcpForNeed 取到服务，再调工具',
  '缺服务时给出「去画布设置里配 XXX 服务」的提示，而不是笼统的失败',
];
