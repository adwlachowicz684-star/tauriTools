/**
 * MCP 服务的**全局库** —— 一处配置，全图可用。
 *
 * ================= 为什么从画布配置里升上来 =================
 *
 * 以前每张画布各存一份 `config.mcpServers`。同一个 xmind 服务
 * 在五张画布上要用，就得配五遍 —— 改个地址要改五处，漏一处
 * 表现为"这张画布上的 MCP 节点连的是旧地址"，**且不报错**。
 *
 * 凭据中心本来就是全局的，MCP 服务的性质与它一致（都是"这机器上
 * 有什么外部能力"），所以归到一处管。
 *
 * ================= 迁移 =================
 *
 * 老画布上已经配过的服务不能丢。`migrateFromCanvases` 把它们并进来，
 * 已存在的同名服务保留原样（不覆盖用户新配的）。迁移是幂等的，
 * 调用方可以在每次加载时放心调。
 */

import { defaultKV, loadList, saveWrapped, type KV } from './kv';
import { looksLikeSecretName } from './sanitize';

/** 复用画布配置里的形状，不另起一套 —— 两处形状漂移更麻烦 */
export type McpTransport = 'local' | 'remote';

export type GlobalMcpServer = {
  id: string;
  /** 展示名，也是节点里引用的名字 */
  name: string;
  /** 启动命令（stdio，本地起进程） */
  command?: string;
  /** HTTP 地址（远端服务） */
  url?: string;
  env?: Record<string, string>;
  note?: string;
  /** 不参与生成节点 / 不被引用，但配置留着 */
  disabled?: boolean;
};

export const MCP_SERVERS_KEY = 'agent-flow.mcpServers.v1';
const FIELD = 'servers';
const VERSION = 1;

export function transportOf(s: GlobalMcpServer): McpTransport {
  const hasCmd = !!(s?.command && String(s.command).trim());
  const hasUrl = !!(s?.url && String(s.url).trim());
  if (hasCmd && hasUrl) return 'local'; // 两个都填时按命令优先
  if (hasUrl) return 'remote';
  return 'local';
}

/** 填了才算"可用"；两个都空的服务起不来 */
export function isRunnable(s: GlobalMcpServer): boolean {
  return !!(String(s?.command ?? '').trim() || String(s?.url ?? '').trim());
}

export function loadServers(kv: KV = defaultKV()): GlobalMcpServer[] {
  const raw = loadList(kv, MCP_SERVERS_KEY, FIELD) as GlobalMcpServer[];
  return (raw ?? []).filter((s) => s && typeof s === 'object');
}

export function saveServers(list: GlobalMcpServer[], kv: KV = defaultKV()): void {
  saveWrapped(kv, MCP_SERVERS_KEY, VERSION, FIELD, list ?? []);
}

export function newServer(name = ''): GlobalMcpServer {
  return {
    id: `mcp${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
    name,
  };
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export type ServerIssue = { field: string; message: string };

/**
 * 与 validateCanvasConfig 里那段规则一致（重名 / 至少一个传输 / 双填提示）。
 *
 * 抽到一处而不是两边各写：以后加规则（比如命令格式校验）时
 * 漏改一边，就会出现"画布设置说不合法、全局库说合法"。
 */
export function validateServers(list: GlobalMcpServer[]): ServerIssue[] {
  const issues: ServerIssue[] = [];
  const seenName = new Set<string>();
  const seenId = new Set<string>();

  for (const s of list ?? []) {
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name ?? '').trim();
    const label = name || String(s.id ?? '（无名）');

    if (!name) {
      issues.push({ field: label, message: '服务没填名字' });
    } else if (seenName.has(name)) {
      /*
       * 重名必须拦住：节点按名字引用，重名会导致
       * "改了 A 的配置、实际生效的是 B"，且不报错。
       */
      issues.push({ field: name, message: '服务重名了 —— 节点按名字引用，重名会指错' });
    }
    seenName.add(name);

    if (s.id) {
      if (seenId.has(s.id)) issues.push({ field: label, message: '服务 id 重复' });
      seenId.add(s.id);
    }

    const hasCmd = !!String(s.command ?? '').trim();
    const hasUrl = !!String(s.url ?? '').trim();
    if (!hasCmd && !hasUrl) {
      issues.push({ field: label, message: '既没填启动命令也没填地址，这个服务起不来' });
    }
    if (hasCmd && hasUrl) {
      issues.push({ field: label, message: '命令和地址都填了 —— 会按命令优先，留一个就好' });
    }
  }
  return issues;
}

/**
 * 环境变量名像密钥的有哪些。
 *
 * MCP 的环境变量是"最顺手填 token 的地方"，而全局库是明文存的。
 * 这里不阻止用户填（有些服务确实需要），但导出 / 展示时要脱敏，
 * 所以得先知道哪些是。
 */
export function secretEnvNames(s: GlobalMcpServer): string[] {
  const out: string[] = [];
  for (const k of Object.keys(s?.env ?? {})) {
    if (looksLikeSecretName(k)) out.push(k);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 迁移                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把老画布上配的服务并进全局库。
 *
 * @returns 是否真的写入了（false 表示无需迁移，调用方不用再存一次）
 */
export function migrateFromCanvases(
  canvases: unknown[],
  kv: KV = defaultKV(),
): { added: number; list: GlobalMcpServer[] } {
  const cur = loadServers(kv);
  const have = new Set(cur.map((s) => String(s.name ?? '').trim()).filter(Boolean));

  const merged: GlobalMcpServer[] = [...cur];
  let added = 0;

  for (const one of canvases ?? []) {
    const c = one as { config?: { mcpServers?: unknown[] } };
    for (const item of c?.config?.mcpServers ?? []) {
      const s = item as GlobalMcpServer;
      const name = String(s?.name ?? '').trim();
      if (!name || have.has(name)) continue;
      have.add(name);
      merged.push({
        id: String(s?.id ?? '') || newServer(name).id,
        name,
        command: s?.command,
        url: s?.url,
        env: s?.env,
        note: s?.note,
      });
      added += 1;
    }
  }

  if (added === 0) return { added: 0, list: cur };
  saveServers(merged, kv);
  return { added, list: merged };
}

/**
 * 解析节点该用哪个服务。规则与画布版一致（唯一时可省略）。
 *
 * 签名刻意保持与 canvasConfig 的 resolveMcpServer 一致，
 * 这样调用方换数据源时不用改判断逻辑。
 */
export function resolveServer(
  list: GlobalMcpServer[],
  choice?: string | null,
): { ok: true; server: GlobalMcpServer | null } | { ok: false; reason: string; names: string[] } {
  const usable = (list ?? []).filter((s) => !s.disabled);
  const picked = String(choice ?? '').trim();

  if (usable.length === 0) {
    if (picked) {
      return { ok: false, reason: `选了「${picked}」，但全局没配任何 MCP 服务`, names: [] };
    }
    return { ok: true, server: null };
  }

  if (picked) {
    const hit = usable.find((s) => String(s.name ?? '').trim() === picked);
    if (hit) return { ok: true, server: hit };
    return {
      ok: false,
      reason: `选了「${picked}」，但全局服务里没有这个名字`,
      names: usable.map((s) => String(s.name ?? '')),
    };
  }

  if (usable.length > 1) {
    /*
     * 多个时必须显式选：自动挑一个的话，两个服务提供同名工具时
     * 只能靠顺序猜，猜错不报错 —— 读了错误服务的文件，结果看着还挺合理。
     */
    return {
      ok: false,
      reason: `配了 ${usable.length} 个 MCP 服务，必须指定用哪一个`,
      names: usable.map((s) => String(s.name ?? '')),
    };
  }
  return { ok: true, server: usable[0] };
}

/** 配了多个（且都启用）时节点才必选 */
export function choiceRequired(list: GlobalMcpServer[]): boolean {
  return (list ?? []).filter((s) => !s.disabled).length > 1;
}

/* ------------------------------------------------------------------ */
/* 与刷新管线对接                                                        */
/* ------------------------------------------------------------------ */

/** 刷新管线用的形状（mcpStore 的 ServerRef） */
export type ServerRefLike = { name: string; command?: string; url?: string };

/**
 * 转成刷新管线要的形状。
 *
 * 停用的不转 —— 停用了就别去连它，也别为它生成节点。
 * 没名字的不转：节点按名字引用，没名字引用不了。
 */
export function toServerRefs(list: GlobalMcpServer[]): ServerRefLike[] {
  const out: ServerRefLike[] = [];
  const seen = new Set<string>();
  for (const s of list ?? []) {
    if (s?.disabled) continue;
    const name = String(s?.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, command: s.command, url: s.url });
  }
  return out;
}
