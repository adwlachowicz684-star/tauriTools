/**
 * MCP 服务的**全局库** —— 一处配置，全图可用。
 *
 * ================= 为什么从画布配置里升上来 =================
 *
 * 以前每张画布各存一份 `config.mcpServers`。同一个 xmind 服务
 * 在五张画布上要用，就得配五遍 —— 改个地址要改五处，漏一处
 * 表现为"这张画布上的 MCP 节点连的是旧地址"，**且不报错**。
 *
 * 连接管理器本来就是全局的，MCP 服务的性质与它一致（都是"这机器上
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
/*
 * 传输判据用**协议层**那份（mcpClient），不用本文件的 transportOf ——
 *
 * 本文件 transportOf 返回 'local' / 'remote'，是给界面页签用的（本地/远程）；
 * 协议层返回 'http' / 'stdio'，是真正去连时用的那套。
 * 两套名字说的是同一件事，各判各的就会出现"面板说能连、连的时候说不能"。
 * 这里要回答的是"能不能连"，所以用协议层的。
 */
import { stdioSupported, transportOf as protocolTransportOf } from './mcpClient';

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

/**
 * 这个服务**现在**的状态（面板上每个服务那一格显示什么）。
 *
 * ================= 为什么收成一处 =================
 *
 * 以前面板上是一个全局布尔 prop（protocolReady）在分三支，
 * 而 App **从来没传过它** —— 于是恒为 undefined：
 *
 *   · 已经连上、侧栏都生成出 3 个工具了，面板上还写着「未接入协议」
 *   · 而且那条说明写着"还没去连过，不代表服务有问题" —— 那是假话
 *
 * 用户面对的是同一行里「未接入协议」和「3 个工具」并排，
 * 两个数字自相矛盾，只能以为系统坏了。
 *
 * 全局布尔也表达不了真正要说的事：**能不能连，是按服务不同的** ——
 * HTTP 已经接上，stdio 还没有。用同一个布尔回答，必然有一个是假的
 * （给 true 则 stdio 服务假显示"已就绪"，而它其实连不上）。
 *
 * 所以按服务算，且 stdio 单独一种状态 —— 不能并进"配置不全"：
 * 用户填得规规矩矩，却被说成"配置不全"，会一直去改一个本来就对的配置。
 */
export type McpState = {
  /** 面板上显示的短标签 */
  label: string;
  /** 绿（可以连）还是灰（连不上） */
  on: boolean;
  /** hover 时的解释；空串表示不用解释 */
  hint: string;
};

export function mcpStateOf(s: GlobalMcpServer): McpState {
  if (!isRunnable(s)) {
    return { label: '配置不全', on: false, hint: '要把启动命令或地址填上一个' };
  }
  if (protocolTransportOf(s) === 'stdio' && !stdioSupported()) {
    return {
      label: 'stdio 未接入',
      on: false,
      hint: 'stdio 传输（command 方式）还没接上 —— 请改用 HTTP 地址',
    };
  }
  return { label: '已就绪', on: true, hint: '' };
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
      /*
       * 逐字段搬，不用展开 ——
       *
       * 展开会把画布上的杂字段一起带进来；逐个搬则要**记得每个字段**，
       * 漏掉 disabled 的后果是：用户在画布上关掉的服务迁过来变成启用，
       * 于是被拿去连接、刷新失败并记一条"连不上"。
       * 用户看到的是凭空冒出来的连接失败，而他根本没启用过它。
       */
      merged.push({
        id: String(s?.id ?? '') || newServer(name).id,
        name,
        command: s?.command,
        url: s?.url,
        env: s?.env,
        note: s?.note,
        disabled: s?.disabled,
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
  const all = (list ?? []).filter((s) => s && typeof s === 'object');
  const usable = all.filter((s) => !s.disabled);
  const picked = String(choice ?? '').trim();
  const nameOf = (s: GlobalMcpServer) => String(s?.name ?? '').trim();

  if (usable.length === 0) {
    /*
     * **"一个都没配"和"配了但全停用了"要说不同的话**。
     *
     * 统一说"没配任何 MCP 服务"的话，用户去全局库一看服务明明在那
     * —— 于是以为解析坏了，去查一个不存在的问题。
     */
    if (picked) {
      if (all.length === 0) {
        return { ok: false, reason: `选了「${picked}」，但全局没配任何 MCP 服务`, names: [] };
      }
      return {
        ok: false,
        reason: `选了「${picked}」，但全局的 ${all.length} 个服务都停用了`,
        names: all.map(nameOf),
      };
    }
    return { ok: true, server: null };
  }

  if (picked) {
    const hits = usable.filter((s) => nameOf(s) === picked);

    /*
     * **同名服务是歧义，不能靠顺序挑一个**。
     *
     * 名字是节点里引用的依据，同名的两个服务根本无法区分引用。
     * find 取第一个的话，选中的是哪个取决于配置顺序 ——
     * 两个服务提供同名工具时结果看着还挺合理，但连的是另一个服务。
     */
    if (hits.length > 1) {
      return {
        ok: false,
        reason: `有 ${hits.length} 个服务都叫「${picked}」，分不清该用哪个`,
        names: usable.map(nameOf),
      };
    }
    if (hits.length === 1) return { ok: true, server: hits[0] };

    /*
     * **"有这个名字但停用了" ≠ "没有这个名字"**。
     *
     * 说"没有这个名字"的话，用户去全局库一看它明明在 ——
     * 与上面同理，会以为解析坏了。
     */
    if (all.some((s) => s.disabled && nameOf(s) === picked)) {
      return {
        ok: false,
        reason: `「${picked}」已停用 —— 在全局服务里启用它，或换一个服务`,
        names: usable.map(nameOf),
      };
    }
    return {
      ok: false,
      reason: `选了「${picked}」，但全局服务里没有这个名字`,
      names: usable.map(nameOf),
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
      names: usable.map(nameOf),
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
