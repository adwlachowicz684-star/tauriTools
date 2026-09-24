/**
 * 画布级配置 —— MCP 服务与画布参数。
 *
 * ================= 为什么放在画布上 =================
 *
 * MCP 服务是**环境能力**：谁在这张画布上跑，就用这套服务。
 * 它不属于某个节点，所以不放节点里；换一张画布该有各自的配法，
 * 所以也不做全局设置。
 *
 * ================= 混合方案：唯一自动用、多个必须选 =================
 *
 * 纯粹的"全局注入"（节点不写名字、引擎自动接）有个致命问题：
 * 两个 MCP 都提供同名工具时引擎只能猜，**猜错不报错** ——
 * 读了错误服务的文件，结果看着还挺合理。
 *
 * 所以做成：节点上有个**可选**的"用哪个服务"字段。
 *
 *   · 画布只配了一个   → 不用选，自动用它（省事，接近全局注入）
 *   · 画布配了多个     → 必须选，不选就明确报错
 *   · 选了不存在的     → 明确报错
 *
 * "昨天还能跑、今天加了第二个服务就全都报错要选"是会发生的，
 * 但那是**明确且能修**的报错，比静默猜错好得多。
 */

/** MCP 服务的配置。命令与地址二选一 */
import type { CanvasParam } from './canvasParams';

export type McpServer = {
  id: string;
  /** 展示名，也是节点里引用的名字 */
  name: string;
  /**
   * 启动命令（stdio 传输）。
   * 例：`npx -y @modelcontextprotocol/server-filesystem /tmp`
   */
  command?: string;
  /** HTTP 传输的地址（SSE / streamable） */
  url?: string;
  /** 附加环境变量；值可以用模板引用连接 */
  env?: Record<string, string>;
  /** 备注 */
  note?: string;
};

/*
 * 旧的环境变量表。
 *
 * 界面上承诺过 {{env.NAME}} 可用，但模板层从没实现 —— 填了也没用。
 * 现在统一到下面的 params；这一份只为**不丢老存档的值**而保留，
 * 读取时由 migrateEnvVars 搬进 params。
 */
export type CanvasEnv = {
  vars: Record<string, string>;
};

export type CanvasConfig = {
  mcpServers: McpServer[];
  env: CanvasEnv;
  /**
   * 画布参数 —— 画布范围的局部变量。
   *
   * 节点里写 {{params.名字}}，每张画布各填各的值。
   * 一个模块拖到不同画布上，靠它取到不同的路径 / 账号 / 项目名，
   * 而模块本身不用改。详见 engine/canvasParams.ts 的头部说明。
   */
  params?: CanvasParam[];
};

export function emptyCanvasConfig(): CanvasConfig {
  return { mcpServers: [], env: { vars: {} }, params: [] };
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export type ConfigIssue = { field: string; message: string };

/**
 * 校验一份画布配置。
 *
 * **收集全部问题再返回**，而不是遇到第一个就停 ——
 * 用户一次改了三项，只想看到一次提示，不想改一遍提交一遍。
 */
export function validateCanvasConfig(cfg: CanvasConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const servers = cfg?.mcpServers ?? [];

  const seenId = new Set<string>();
  const seenName = new Set<string>();
  for (const s of servers) {
    if (!s.id || !s.id.trim()) issues.push({ field: s.name, message: '服务缺少 id' });
    const name = (s.name ?? '').trim();
    if (!name) {
      issues.push({ field: s.id ?? '（无名）', message: '服务没填名字' });
    } else if (seenName.has(name)) {
      /*
       * 重名必须拦住：节点是靠名字引用服务的，重名会导致
       * "改了 A 的配置、实际生效的是 B"，且不报错。
       */
      issues.push({ field: name, message: '服务重名了 —— 节点按名字引用，重名会指错' });
    }
    seenName.add(name);

    if (s.id) {
      if (seenId.has(s.id)) issues.push({ field: name, message: '服务 id 重复' });
      seenId.add(s.id);
    }

    const hasCmd = !!(s.command && s.command.trim());
    const hasUrl = !!(s.url && s.url.trim());
    if (!hasCmd && !hasUrl) {
      issues.push({ field: name, message: '既没填启动命令也没填地址，这个服务起不来' });
    }
    if (hasCmd && hasUrl) {
      // 两个都填了不报错，但按命令优先，得让用户知道
      issues.push({ field: name, message: '命令和地址都填了 —— 会按命令优先，留一个就好' });
    }
  }

  for (const k of Object.keys(cfg?.env?.vars ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      issues.push({ field: k, message: '变量名只能用字母、数字、下划线，且不能以数字开头' });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* 解析：节点该用哪个服务                                                */
/* ------------------------------------------------------------------ */

export type McpResolution =
  | { ok: true; server: McpServer | null }
  | { ok: false; reason: string; candidates: McpServer[] };

/**
 * 决定一个节点该用哪个 MCP 服务。
 *
 * @param servers 画布上配的服务
 * @param choice  节点上选的服务名（可空 —— 唯一时允许空）
 */
export function resolveMcpServer(
  servers: McpServer[],
  choice?: string | null,
): McpResolution {
  const list = servers ?? [];
  const picked = (choice ?? '').trim();

  if (list.length === 0) {
    // 没配服务：不是错误，节点照常走它自己的通道（如 httpRequester）
    if (picked) {
      return {
        ok: false,
        reason: `选了「${picked}」，但画布上没配任何 MCP 服务`,
        candidates: [],
      };
    }
    return { ok: true, server: null };
  }

  if (picked) {
    const hit = list.find((s) => (s.name ?? '').trim() === picked);
    if (hit) return { ok: true, server: hit };
    return {
      ok: false,
      reason: `找不到叫「${picked}」的 MCP 服务`,
      candidates: list,
    };
  }

  if (list.length === 1) {
    // 混合方案的关键：配了唯一一个就自动用，节点不用选
    return { ok: true, server: list[0] };
  }

  return {
    ok: false,
    reason: `画布上配了 ${list.length} 个 MCP 服务，这个节点要指定用哪个`,
    candidates: list,
  };
}

/**
 * 节点是否需要显式选择服务。
 * UI 用它决定"用哪个服务"这个下拉框是必填还是可选。
 */
export function mcpChoiceRequired(servers: McpServer[]): boolean {
  return (servers ?? []).length > 1;
}
