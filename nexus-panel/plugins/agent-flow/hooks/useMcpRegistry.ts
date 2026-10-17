import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { postJson } from '../lib/tauri';
import {
  loadServers as loadMcpServers, saveServers as saveMcpServers,
  migrateFromCanvases, toServerRefs, serverRefSkips, type GlobalMcpServer,
} from '../engine/mcpServers';
import {
  collectServers, serversChanged, serversToDrop, type ServerRef,
  type McpToolFetcher,
} from '../engine/mcpStore';
import { listTools, transportOf, stdioSupported } from '../engine/mcpClient';
import { MCP_SINGLE_TIMEOUT_SEC } from '../engine/mcpTools';
import { hydrateMcpNodes, bootRefresh } from '../engine/mcpRegistry';
/*
 * 侧栏分组与计数来自 mcpTools 而不是 mcpRegistry ——
 *
 * mcpRegistry import 了 nodes/mcpGenerated（要注册进节点注册表），
 * 那会一路拉起 React 组件。把纯数据变换留在 mcpTools 里，
 * 它们才能被单测直接覆盖（mcpRegistry 本身在测试环境里 import 不了）。
 */
import { mcpSidebarGroups, toolCountOf, type NodeBlueprint } from '../engine/mcpTools';

/**
 * MCP 服务库 + 工具节点刷新。
 *
 * ================= 为什么抽出来 ====================
 *
 * App.tsx 往下拆的第四块。它只依赖"画布初始快照"（一次性迁移旧配置）
 * 和一个写日志的回调 —— 与画布交互、执行流程都不相干。
 *
 * ================= 边界 ====================
 *
 * 协议传输在 engine/mcpClient，注册表在 engine/mcpRegistry，
 * 服务库持久化在 engine/mcpServers。这里只管 state 与刷新时机。
 */

/**
 * MCP 协议实现：把 engine/mcpClient 的 HTTP 传输接到刷新流程上。
 *
 * 放在**模块级**而不是组件里 —— 它不依赖任何 state，
 * 放组件里会因为每次渲染重建而让 useCallback 的依赖数组被迫带上它。
 *
 * 用 postJson 是因为它已经处理了 Tauri 与浏览器两条路径，
 * 不必为 MCP 再开一条通道。
 *
 * 只支持 HTTP 传输：stdio 要起子进程 + 双向管道，那是 Rust 侧的活。
 * 目前 stdioSupported() 为 false，只填 command 的服务会拿到一条
 * 明确的"还没接上"，而不是静默失败。
 */
const mcpFetcher: McpToolFetcher = async (server) => {
  if (transportOf(server) === 'stdio' && !stdioSupported()) {
    throw new Error(
      `MCP 服务「${server.name}」用的是 stdio 传输（command 方式），还没接上 —— 请改用 HTTP 地址`,
    );
  }
  const tools = await listTools(
    { name: server.name, url: server.url, command: server.command },
    async (url, body, headers, timeoutSec) => await postJson(url, body, headers, timeoutSec),
    MCP_SINGLE_TIMEOUT_SEC,
  );
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
};

export function useMcpRegistry({
  initCanvases, onLog,
}: {
  initCanvases: unknown[];
  onLog: (msg: string) => void;
}) {
  /*
   * MCP 服务改由**全局库**管（一处配置，全图可用）。
   *
   * 以前每张画布各存一份，同一服务在五张画布上要用就配五遍 ——
   * 改个地址要改五处，漏一处表现为"这张画布连的是旧地址"，且不报错。
   */
  const [mcpServers, setMcpServers] = useState<GlobalMcpServer[]>(
    () => migrateFromCanvases(initCanvases).list,
  );

  /*
   * 刷新管线要的服务形状。用 ref 而不是 state：
   * doRefreshMcp 是个 useCallback，依赖里放数组会让它每次配置改动都重建，
   * 进而让用它做依赖的防抖 effect 反复重新注册。
   */
  const mcpRefsRef = useRef<ServerRef[]>(toServerRefs(mcpServers) as ServerRef[]);
  mcpRefsRef.current = toServerRefs(mcpServers) as ServerRef[];

  const commitMcp = useCallback((next: GlobalMcpServer[]) => {
    setMcpServers(next);
    saveMcpServers(next);
  }, []);

  /* ---------------- MCP 节点 ---------------- */

  /*
   * 启动时先把存下来的蓝图注册进注册表 —— **同步**完成。
   * 这是"先用快照立刻可用"的关键：不等网络，界面一上来就有这些节点。
   */
  const [mcpBlueprints] = useState(() => hydrateMcpNodes());

  const [mcpGroups, setMcpGroups] = useState(() => mcpSidebarGroups(mcpBlueprints));
  const [mcpRefreshing, setMcpRefreshing] = useState(false);
  const mcpBootedRef = useRef(false);

  /*
   * **当前**的蓝图清单 —— 刷新时要拿它当"上一次的结果"。
   *
   * 不能直接用 mcpBlueprints：那是 useState 的初值（useState 只取了第一个
   * 元素，没有 setter），**恒为启动快照**。第二次刷新拿它当 previous 会：
   *
   *   1. 第一次刷新新学到的工具（启动快照里没有的）在第二次刷新时
   *      **整条从列表里消失**，而不是被标 stale ——
   *      存盘丢了它，下次启动画布上用着它的节点就变成未知类型，
   *      参数面板变空，用户连修都没法修。而且全程不报错。
   *   2. diff 每次都算成"新增" —— 日志每次都说"新增 N"，
   *      其实一次都没变。
   *
   * 用 ref 而不是 state：改它不该触发重渲染（界面看的是 mcpGroups）。
   */
  const mcpCurrentRef = useRef<NodeBlueprint[]>(mcpBlueprints);

  const rebuildMcpGroups = useCallback((list: ReturnType<typeof mcpSidebarGroups>) => {
    setMcpGroups(list);
  }, []);

  /*
   * 每个服务已生成的工具节点数。
   *
   * **从 mcpGroups 派生，不从 mcpBlueprints 算** ——
   *
   * mcpBlueprints 是启动快照（useState 只取了第一个元素，没有 setter），
   * 刷新成功后它不变。用它算就会出现"侧栏有 3 个工具、
   * 服务面板一个都不显示"这种两个数字对不上的情况，且不报错。
   *
   * mcpGroups 刷新成功会更新、删服务会立刻裁剪，
   * 与侧栏显示的是同一份 —— 从它派生就不可能分叉（见 toolCountOf）。
   */
  const mcpToolCount = useMemo(() => toolCountOf(mcpGroups), [mcpGroups]);


  /*
   * 刷新。
   *
   * fetcher 传了 —— HTTP 传输已经接上（见 mcpFetcher）。
   * stdio 还没接上，那种服务会在 fetcher 里抛错并报出来，
   * 不假装成功：假装成功会让用户以为工具已经是新的了。
   *
   * （这段以前写的是"fetcher 暂时不传，协议还没接上"。协议接上之后
   *  没人回来改它，于是它成了"所有服务恒显示未接入协议"那个 bug 的源头 ——
   *  注释里的过期结论会一直指导后来的人，比没有注释更糟。）
   */
  /*
   * 刷新代号。
   *
   * 刷新是**异步**的（要连 MCP server 拉工具清单），而触发它的时机有三个：
   * 启动后一次、侧栏手动点、服务配置变了防抖一次。
   *
   * 没有代号的话，两次并发刷新可能"后发的先返回"：
   * 用户改了服务 → 新刷新发出；上一次旧刷新这时才返回 →
   * 用**旧的服务列表**覆盖掉刚算好的结果，侧栏显示回一批过期工具。
   * 而且不报错，只表现为"我明明改了，怎么还是老的"。
   *
   * 与存档那边的 saveSeq 是同一套做法。
   */
  const mcpRefreshSeq = useRef(0);

  const doRefreshMcp = useCallback(async (overrideServers?: ServerRef[]) => {
    const seq = mcpRefreshSeq.current + 1;
    mcpRefreshSeq.current = seq;
    setMcpRefreshing(true);
    try {
      /*
       * 允许外部传服务列表 ——
       * 配置刚改时 canvases 还没更新完，用传进来的这份才准。
       */
      /*
       * 服务取自**全局库**，不再扫各张画布的配置 ——
       * 见上面 mcpServers 的说明。
       */
      const servers = overrideServers ?? mcpRefsRef.current;
      /*
       * 过期判据要**传进去**，不能只在返回后自己判断 ——
       *
       * bootRefresh 内部会 saveBlueprints + registerBlueprints，
       * 那两处副作用发生在 await 里面。等它返回再判断"这次过期了不更新界面"，
       * 存储与注册表**已经被旧结果写完**了 —— 于是界面显示新工具（对），
       * 而存盘是旧蓝图，用户下次启动静默回到旧版本，且不报错。
       *
       * 传进去的话，过期那次在写任何东西之前就停手。
       */
      const r = await bootRefresh(servers, mcpCurrentRef.current, mcpFetcher, {
        isStale: () => seq !== mcpRefreshSeq.current,
      });
      // 被更新的刷新取代了就丢弃结果 —— 它反映的是过期的服务列表
      if (seq !== mcpRefreshSeq.current) return;
      if (r.outcome.ok) {
        // 记下这次的结果 —— 下次刷新要拿它当"上一次"，否则新学到的工具会丢
        mcpCurrentRef.current = r.outcome.list;
        rebuildMcpGroups(mcpSidebarGroups(r.outcome.list));
      }
      onLog(r.message);
    } finally {
      // 只有仍是最新那次才收起"刷新中" ——
      // 否则旧刷新返回时会把新刷新还在跑的状态提前清掉
      if (seq === mcpRefreshSeq.current) setMcpRefreshing(false);
    }
  }, [rebuildMcpGroups, onLog]);

  /*
   * 配了 MCP 服务就自动刷新一次。
   *
   * **带防抖**：服务名与命令都是输入框，onChange 每敲一个字符就触发。
   * 不防抖的话，等接上协议后就是"每敲一个键起一次子进程"。
   * 800ms 够用户停下笔，又不会让他等太久。
   */
  const mcpTimerRef = useRef<number | null>(null);
  const mcpServersRef = useRef<ServerRef[]>(toServerRefs(mcpServers) as ServerRef[]);
  const skipKeyRef = useRef<string>('');

  const scheduleMcpRefresh = useCallback((servers: ServerRef[]) => {
    if (mcpTimerRef.current !== null) window.clearTimeout(mcpTimerRef.current);
    mcpTimerRef.current = window.setTimeout(() => {
      mcpTimerRef.current = null;
      void doRefreshMcp(servers);
    }, 800);
  }, [doRefreshMcp]);

  // 组件卸载时清掉定时器，避免在已卸载的组件上 setState
  useEffect(() => () => {
    if (mcpTimerRef.current !== null) window.clearTimeout(mcpTimerRef.current);
  }, []);

  /*
   * 全局 MCP 服务库变了 → 防抖刷新一次。
   *
   * 比对只认 name / command / url（顺序无关）：
   *  · 改环境变量不触发重连 —— 那跟工具清单无关
   *  · 改命令要算变化 —— 那是换了个服务，只比名字的话改了命令不会重新拉
   */
  useEffect(() => {
    const after = toServerRefs(mcpServers) as ServerRef[];
    const before = mcpServersRef.current;
    if (!serversChanged(before, after)) return;

    mcpServersRef.current = after;
    /*
     * 没进刷新列表的服务要**说一声**。
     *
     * 不说的话，用户看到一个服务明明配着、工具却一个都没有，
     * 会去查"服务是不是挂了"，而真正原因是他没填名字（或重名）。
     *
     * 用 ref 去重：这个 effect 每敲一个字符都会跑，每次都打日志会刷屏。
     */
    const skips = serverRefSkips(mcpServers);
    const skipKey = skips.join(' | ');
    if (skips.length > 0 && skipKey !== skipKeyRef.current) {
      onLog(`⚠ MCP：${skips.join('；')}`);
    }
    skipKeyRef.current = skipKey;
    /*
     * 服务被删时**立刻**把它的工具标 stale ——
     * 不等刷新，免得侧栏还挂着已经不存在的服务。
     */
    const dropped = serversToDrop(before, after);
    if (dropped.length > 0) {
      setMcpGroups((gs) => gs.filter((g) => !dropped.includes(g.server)));
    }
    scheduleMcpRefresh(after);
  }, [mcpServers, scheduleMcpRefresh]);

  /*
   * 启动后自动刷新一次。
   *
   * 用 ref 守一次 —— 不然每次重渲染都会刷，
   * 而刷新是要连外部进程的（将来接上协议后更是如此）。
   */
  useEffect(() => {
    if (mcpBootedRef.current) return;
    mcpBootedRef.current = true;
    void doRefreshMcp();
  }, [doRefreshMcp]);

  return {
    mcpServers, commitMcp,
    mcpGroups, mcpToolCount, mcpRefreshing,
    refreshMcp: doRefreshMcp,
  };
}
