/**
 * MCP 节点的运行时登记表 —— 把"蓝图"接进注册表，并按 server 分组。
 *
 * 这一层是**纯逻辑 + 注册表副作用**，不依赖 React，
 * 所以 App 启动时能直接调、也能单测。
 */

import {
  loadBlueprints, saveBlueprints, visibleBlueprints, refreshAll,
  describeRefresh, collectServers, pruneByServers,
  type McpToolFetcher, type RefreshOutcome, type ServerRef,
} from './mcpStore';
import { registerBlueprints } from '../nodes/mcpGenerated';
import { groupByServer, type NodeBlueprint, type ServerGroup } from './mcpTools';

/**
 * 启动时调用：把存下来的蓝图注册进注册表。
 *
 * **同步**完成 —— 这是"先用快照立刻可用"的关键：
 * 不等网络，界面一上来就有这些节点。
 */
export function hydrateMcpNodes(): NodeBlueprint[] {
  const list = loadBlueprints();
  registerBlueprints(list);
  return list;
}

/** 侧栏分组：只显示没过期的 */
export function mcpServerGroups(list: NodeBlueprint[]): ServerGroup[] {
  return groupByServer(visibleBlueprints(list));
}

/** 侧栏一个 MCP 条目 */
export type McpSidebarItem = { key: string; label: string; hint?: string };

/** 侧栏一个 server 小组 */
export type McpSidebarGroup = { server: string; color: string; items: McpSidebarItem[] };

/**
 * 转成侧栏要的形状。
 *
 * key 用 bp.type —— 注册时没给 meta.presets，
 * 注册表会用 meta 生成单个预设，key 就是 type（见 allPresets）。
 * 侧栏拿到 key 后 onAdd({kind:key})，与其余节点走同一条路径。
 */
export function mcpSidebarGroups(list: NodeBlueprint[]): McpSidebarGroup[] {
  return mcpServerGroups(list).map((g) => ({
    server: g.server,
    color: g.color,
    items: g.blueprints.map((b) => ({
      key: b.type,
      label: b.tool,
      hint: b.sub,
    })),
  }));
}

export type BootRefreshResult = {
  outcome: RefreshOutcome;
  message: string;
};

/**
 * 启动后刷新一次。
 *
 * 刻意**不在 hydrate 里等它** —— MCP server 起进程慢、还可能起不来，
 * 阻塞启动就等于让一个外部进程决定插件能不能开。
 *
 * @param serverList 画布上配的服务（全部画布的并集）
 * @param fetcher    协议实现；不传则这次刷新必然退化成用快照
 */
export async function bootRefresh(
  serverList: ServerRef[],
  previous: NodeBlueprint[],
  fetcher?: McpToolFetcher,
): Promise<BootRefreshResult> {
  const outcome = await refreshAll({ servers: serverList, previous, fetcher });
  if (outcome.ok) {
    /*
     * 刷完按当前服务列表裁剪：服务已经从画布上删掉的，
     * 它的工具标 stale（不在侧栏出现，但画布上的老节点照常显示）。
     */
    const pruned = pruneByServers(outcome.list, serverList);
    saveBlueprints(pruned);
    // 重新注册 —— 新增/变更的节点得出现在侧栏
    registerBlueprints(pruned);
    return { outcome: { ...outcome, list: pruned }, message: describeRefresh(outcome) };
  }
  return { outcome, message: describeRefresh(outcome) };
}
