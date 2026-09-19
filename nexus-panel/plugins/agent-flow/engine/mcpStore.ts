/**
 * MCP 节点蓝图的持久化与刷新。
 *
 * ================= 为什么存快照 + 启动刷新 =================
 *
 * 只存快照不刷新 → server 上工具变了，这边永远不知道。
 * 每次启动都同步刷新 → MCP server 起进程慢、还可能起不来，
 * **整个插件启动会被一个外部进程拖住**，还会因为网络抖动而卡白屏。
 *
 * 所以：启动时**先用快照立刻可用**，同时后台刷新一次，刷完再更新。
 * 刷新失败就用快照继续跑，并把失败原因说出来。
 *
 * ================= 刷新失败时的两个关键取舍 =================
 *
 * ① **一个 server 连不上，不该让其它 server 的节点消失。**
 *    整批失败的话，连上一次坏网络就能让用户所有的 MCP 节点凭空不见。
 *
 * ② **工具被删了也不注销它。**
 *    注销会让画布上已有节点瞬间变成"未知类型"—— 卡片走兜底变灰、
 *    参数面板变空，用户连修都没法修。
 *    所以标记成 stale：**仍然注册**（老节点照常显示），
 *    但**不在侧栏出现**（已经不存在的工具不该还能新建）。
 */

import { defaultKV, loadList, saveWrapped, type KV } from './kv';
import {
  buildBlueprints, diffBlueprints, mergeBlueprints, isMcpType,
  type NodeBlueprint, type McpToolSchema,
} from './mcpTools';

export const MCP_BP_KEY = 'agent-flow.mcpBlueprints.v1';

/*
 * 存的是带版本号的包装对象 { version, blueprints: [...] }，与其余几处
 * 存储同一口径（见 kv.ts）—— 以后要改结构靠 version 判断能不能直接读。
 */
const BP_VERSION = 1;
const BP_FIELD = 'blueprints';

/**
 * 服务的最小引用 —— 刷新只需要名字与连法，不需要画布上的其它字段。
 *
 * 写成**类型别名**而不是到处内联对象类型：
 * 返回注解里写 `{ name: string; command?: string }` 时
 * 剥不干净 `?:`，生成的 .mjs 直接语法错误（这个脚本的第六个坑）。
 */
export type ServerRef = { name: string; command?: string; url?: string };

/** 去拿某个 server 的工具清单。没有实现协议时**不提供** */
export type McpToolFetcher = (server: {
  name: string; command?: string; url?: string;
}) => Promise<McpToolSchema[]>;

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

export function loadBlueprints(kv: KV = defaultKV()): NodeBlueprint[] {
  const raw = loadList(kv, MCP_BP_KEY, BP_FIELD) as NodeBlueprint[];
  /*
   * 逐条过滤而不是整批信任 ——
   * 存档可能被手改过、也可能是旧版本写下的，
   * 坏数据一旦进注册表就是"侧栏有条目但点了没反应"。
   */
  const out: NodeBlueprint[] = [];
  for (const bp of raw ?? []) {
    if (!bp || typeof bp.type !== 'string' || !isMcpType(bp.type)) continue;
    if (!bp.server || !bp.tool) continue;
    out.push({ ...bp, fields: Array.isArray(bp.fields) ? bp.fields : [] });
  }
  return out;
}

export function saveBlueprints(list: NodeBlueprint[], kv: KV = defaultKV()): void {
  saveWrapped(kv, MCP_BP_KEY, BP_VERSION, BP_FIELD, list ?? []);
}

/** 侧栏要显示哪些（过滤掉 stale 的） */
export function visibleBlueprints(list: NodeBlueprint[]): NodeBlueprint[] {
  return (list ?? []).filter((b) => !b.stale);
}

/* ------------------------------------------------------------------ */
/* 刷新                                                                */
/* ------------------------------------------------------------------ */

export type RefreshFailure = { server: string; reason: string };

export type RefreshOutcome = {
  /** 至少有一个 server 刷成功了 */
  ok: boolean;
  list: NodeBlueprint[];
  diffs: ReturnType<typeof diffBlueprints>;
  failures: RefreshFailure[];
  /**
   * 退化成用快照了吗。
   * true 表示这次刷新**没有真的拿到任何新数据**。
   */
  usedFallback: boolean;
};

export type RefreshOptions = {
  /** 画布上配的 MCP 服务 */
  servers: ServerRef[];
  /**
   * 真正的协议实现。**不提供时刷新必然失败** ——
   * 这时函数会退化成返回旧快照，并把这个原因写进 failures，
   * 而不是假装成功（假装成功会让用户以为工具已经是新的了）。
   */
  fetcher?: McpToolFetcher;
  /** 已有快照 */
  previous?: NodeBlueprint[];
};

/**
 * 刷新所有 server 的工具清单。
 *
 * 逐个 server 独立处理：一个失败不影响其它。
 */
export async function refreshAll(opts: RefreshOptions): Promise<RefreshOutcome> {
  const previous = opts.previous ?? [];
  const servers = opts.servers ?? [];
  const failures: RefreshFailure[] = [];

  if (!opts.fetcher) {
    /*
     * 没有协议实现 —— 这不是异常，是"还没接上"。
     * 明确说出来，让用户知道为什么刷新没效果。
     */
    failures.push({
      server: '（全部）',
      reason: 'MCP 协议还没接上，这次用的是上次保存的快照',
    });
    return { ok: false, list: previous, diffs: [], failures, usedFallback: true };
  }

  if (servers.length === 0) {
    failures.push({ server: '（全部）', reason: '画布上还没配任何 MCP 服务' });
    return { ok: false, list: previous, diffs: [], failures, usedFallback: true };
  }

  const fresh: NodeBlueprint[] = [];
  let anyOk = false;

  for (const s of servers) {
    const name = String(s?.name ?? '').trim();
    if (!name) continue;

    /*
     * 还没填完的服务**跳过，不算失败**。
     *
     * 用户点「＋加一个服务」后，命令与地址都是空的，
     * 这时候去连必然失败并报"连不上" —— 那是噪音，不是问题。
     * 等他填了命令再刷新才连。
     */
    const hasCmd = !!(s?.command && String(s.command).trim());
    const hasUrl = !!(s?.url && String(s.url).trim());
    if (!hasCmd && !hasUrl) {
      // 保留它的旧快照，但不报失败
      for (const old of previous) {
        if (old.server === name && !old.stale) fresh.push(old);
      }
      continue;
    }

    try {
      const tools = await opts.fetcher(s);
      const { list, skipped } = buildBlueprints(name, tools ?? []);
      for (const b of list) fresh.push(b);
      for (const sk of skipped) {
        // 单个工具坏掉只记一条，不影响这个 server 的其它工具
        failures.push({ server: name, reason: `工具「${sk.name}」：${sk.reason}` });
      }
      anyOk = true;
    } catch (err) {
      /*
       * 这个 server 连不上 —— **把它旧的蓝图保留下来**。
       * 整批丢弃的话，一次网络抖动就会让用户所有 MCP 节点消失。
       */
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ server: name, reason: msg || '连不上' });
      for (const old of previous) {
        if (old.server === name) fresh.push(old);
      }
    }
  }

  if (!anyOk) {
    return { ok: false, list: previous, diffs: [], failures, usedFallback: true };
  }

  /*
   * 合并后标 stale：**只在"这个 server 刷新成功了、但工具已不在新列表里"时标**。
   *
   * 连不上的 server 不标 —— 它的数据是旧的，但没证据说工具没了，
   * 标了会让用户以为工具真被删了。
   *
   * 标记而不是删除：画布上可能还有用着这个工具的节点，
   * 注销会让它们变成未知类型、参数面板变空，用户连修都没法修。
   *
   * （第一版写成"标记完再按 okServers 过滤掉"，自相矛盾 ——
   *  刚标上的 stale 立刻被删了，等于没保留。是测试发现的。）
   */
  const freshTypes = new Set(fresh.map((b) => b.type));
  const okServers = new Set(fresh.map((b) => b.server));
  const final = mergeBlueprints(previous, fresh).map((b) =>
    !freshTypes.has(b.type) && okServers.has(b.server) ? { ...b, stale: true } : b);

  return {
    ok: true,
    list: final,
    diffs: diffBlueprints(previous, fresh),
    failures,
    usedFallback: false,
  };
}

/**
 * 把刷新结果说成一句话（给日志用）。
 *
 * 刷成功了但没变化、刷成功了有变化、刷失败了 —— 三种情况要说的话不同。
 * 统一说"刷新完成"的话，用户不知道到底有没有更新。
 */
export function describeRefresh(r: RefreshOutcome): string {
  if (r.usedFallback) {
    const why = r.failures[0]?.reason ?? '未知原因';
    return `⚠ MCP 节点没有刷新：${why}（现有 ${r.list.length} 个节点仍可用）`;
  }
  const added = r.diffs.filter((d) => d.kind === 'added').length;
  const changed = r.diffs.filter((d) => d.kind === 'changed').length;
  const removed = r.diffs.filter((d) => d.kind === 'removed').length;

  if (added === 0 && changed === 0 && removed === 0) {
    return `✅ MCP 节点已刷新，工具没变化（${r.list.length} 个）`;
  }
  const parts: string[] = [];
  if (added) parts.push(`新增 ${added}`);
  if (changed) parts.push(`变更 ${changed}`);
  if (removed) parts.push(`移除 ${removed}`);
  return `✅ MCP 节点已刷新：${parts.join('、')}（共 ${r.list.length} 个）`;
}

/* ------------------------------------------------------------------ */
/* 服务列表变了：把不再存在的服务标 stale                                */
/* ------------------------------------------------------------------ */

/**
 * 服务标识 —— 用来判断"这个服务改了没有"。
 *
 * 比 name + command + url：改命令就是换了个服务（连的是别处），
 * 只比名字的话改了命令不会重新拉工具，用户会以为刷新失效了。
 */
export function serverKey(s: ServerRef): string {
  return `${String(s?.name ?? '').trim()}\u0001${String(s?.command ?? '')}\u0001${String(s?.url ?? '')}`;
}

/** 服务列表是否变了（顺序无关） */
export function serversChanged(a: ServerRef[], b: ServerRef[]): boolean {
  const ka = (a ?? []).map(serverKey).sort();
  const kb = (b ?? []).map(serverKey).sort();
  if (ka.length !== kb.length) return true;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return true;
  }
  return false;
}

/**
 * 把"服务已经不在画布上"的蓝图标 stale。
 *
 * **不删除** —— 画布上可能还有用着这些工具的节点，
 * 删了会让它们变成未知类型、参数面板变空，用户连修都没法修。
 *
 * 与刷新时的 stale 语义一致：不在侧栏出现，但老节点照常显示。
 */
export function pruneByServers(
  list: NodeBlueprint[],
  servers: ServerRef[],
): NodeBlueprint[] {
  const alive = new Set((servers ?? []).map((s) => String(s?.name ?? '').trim()));
  return (list ?? []).map((b) =>
    alive.has(String(b?.server ?? '').trim()) ? b : { ...b, stale: true });
}

/**
 * 服务被删后，它的工具该不该从注册表注销。
 *
 * 这里返回**建议**，不直接执行 —— 注销会影响画布上的老节点，
 * 属于 App 那边（它有画布状态）才能判断的事。
 */
export function serversToDrop(
  previousServers: ServerRef[],
  currentServers: ServerRef[],
): string[] {
  const now = new Set((currentServers ?? []).map((s) => String(s?.name ?? '').trim()));
  const out: string[] = [];
  for (const s of previousServers ?? []) {
    const n = String(s?.name ?? '').trim();
    if (n && !now.has(n)) out.push(n);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 从画布配置里收集服务                                                  */
/* ------------------------------------------------------------------ */

/**
 * 从所有画布的配置里收集 MCP 服务（按名字去重）。
 *
 * 刷新是**全局**的，不是按当前画布 ——
 * 否则切个画布就得重新连一次 server，而同一台机器上的 MCP
 * 服务本来就是同一批。
 *
 * 同名只留第一个：两个画布给同名服务配了不同命令的话，
 * 留两个会让刷新结果取决于遍历顺序（不确定行为）。
 */
/*
 * 参数刻意写成 unknown[] + 内部断言，而不是内联嵌套对象类型
 * （`{ config?: { mcpServers?: {...}[] } }[]`）——
 * 后者写在签名里太长，会盖掉这个函数真正要说的事。
 */
export function collectServers(
  canvases: unknown[],
): ServerRef[] {
  const map = new Map<string, ServerRef>();
  for (const one of canvases ?? []) {
    const c = one as { config?: { mcpServers?: unknown[] } };
    for (const item of c?.config?.mcpServers ?? []) {
      const s = item as { name?: string; command?: string; url?: string };
      const name = String(s?.name ?? '').trim();
      if (!name || map.has(name)) continue;
      map.set(name, { name, command: s.command, url: s.url });
    }
  }
  const out: ServerRef[] = [];
  for (const v of map.values()) out.push(v);
  return out;
}
