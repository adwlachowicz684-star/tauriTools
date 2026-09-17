/**
 * MCP 工具 → 节点定义的**生成逻辑**（纯逻辑，不依赖 React）。
 *
 * ================= 这一层解决什么 =================
 *
 * MCP server 连上后会报一堆工具（tools/list）。每个工具都长成
 * 「名字 + 说明 + 入参 JSON Schema」。这个形状**足够生成出一个节点**：
 * 名字当标题、说明当副标题、入参 schema 当字段清单。
 *
 * 于是"为某个软件做专属节点"不再需要手写代码 ——
 * 连上它的 MCP，节点就自动生成出来了。
 *
 * ================= 三个关键决定 =================
 *
 * ① **dataKind 统一为 'mcp'**，不是一工具一个。
 *    一工具一个 dataKind 就意味着一工具一个执行器（要注册几十个），
 *    而它们做的事完全一样：把 data 里的参数交给 server 的那个工具。
 *    真正的区分（哪个 server、哪个工具）放在 data 里，执行器只需要一个。
 *
 * ② **type 带 mcp: 前缀**。
 *    server 名与工具名是外部输入，不加前缀可能撞上内置的 'task' / 'log'，
 *    撞了会**静默覆盖**掉内置节点 —— 侧栏里原本的节点凭空变了行为。
 *
 * ③ 嵌套对象降级成 JSON 文本框。
 *    JSON Schema 能表达任意深的嵌套，而表单只能平铺一层。
 *    硬要渲染嵌套会让面板变得没法用，所以降级 + 明确说明，
 *    比"渲染出一堆看不懂的控件"好。
 *
 * ================= 当前不做 =================
 * 不实现 MCP 协议（tools/list 怎么发、tools/call 怎么调）。
 * 这一层只消费"已经拿到手的工具清单"。
 */

/** JSON Schema 的属性描述（只取用得到的部分） */
export type JsonSchemaProp = {
  type?: string | string[];
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: unknown;
  properties?: Record<string, unknown>;
  minimum?: number;
  maximum?: number;
};

/** MCP tools/list 里的一条 */
export type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
  };
};

/** 生成出的字段描述（纯数据，React 侧再转成 FieldDef） */
export type BlueprintField = {
  key: string;
  label: string;
  /** 映射到 FieldDef 的 type */
  kind: 'text' | 'textarea' | 'number' | 'select' | 'switch';
  hint?: string;
  placeholder?: string;
  options?: string[];
  required: boolean;
  /**
   * 是否为降级字段（嵌套对象 / 数组 → JSON 文本框）。
   * 面板上要提示"这里填 JSON"，否则用户不知道该写什么格式。
   */
  degraded?: boolean;
};

/** 一个生成出来的节点蓝图 */
export type NodeBlueprint = {
  /** 注册表主键。形如 mcp:notion:create_page */
  type: string;
  /** 统一 'mcp' —— 所有生成节点共用同一个执行器 */
  dataKind: string;
  server: string;
  tool: string;
  label: string;
  sub: string;
  fields: BlueprintField[];
  /** 生成时间。工具签名变了要靠它判断是否需要刷新 */
  generatedAt: number;
  /**
   * 这个工具在 server 上已经不存在了。
   *
   * **仍然注册**（画布上已有节点照常显示，否则它们会变成未知类型、
   * 参数面板变空，用户连修都没法修），但**不在侧栏出现**
   * —— 已经不存在的工具不该还能新建。
   */
  stale?: boolean;
};

export const MCP_DATaKIND = 'mcp';
export const MCP_TYPE_PREFIX = 'mcp:';

/* ------------------------------------------------------------------ */
/* 命名                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把外部名字压成可安全用作 type / 字段名的片段。
 *
 * server 名与工具名可能带空格、点、斜杠（如 `filesystem.read_file`、
 * `Notion MCP`）。直接拼进 type 会生成出带奇怪字符的 node.type，
 * 而 type 是注册表主键、会进存档 —— 脏数据一旦落地很难清。
 */
export function slugify(raw: string): string {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'x';
}

export function mcpTypeOf(server: string, tool: string): string {
  return `${MCP_TYPE_PREFIX}${slugify(server)}:${slugify(tool)}`;
}

/** 反解：这个 type 是不是生成出来的 */
export function isMcpType(type: string): boolean {
  return String(type ?? '').startsWith(MCP_TYPE_PREFIX);
}

/* ------------------------------------------------------------------ */
/* 类型映射                                                            */
/* ------------------------------------------------------------------ */

/**
 * JSON Schema 的类型可能是数组（OpenAPI 风格 `['string','null']`），
 * 取第一个非 null 的作为主类型。
 */
function primaryType(prop: JsonSchemaProp): string {
  const t = prop?.type;
  if (Array.isArray(t)) {
    for (const one of t) {
      const low = String(one ?? '').toLowerCase();
      if (low && low !== 'null') return low;
    }
    return '';
  }
  return String(t ?? '').toLowerCase();
}

function kindOf(prop: JsonSchemaProp): BlueprintField['kind'] {
  if (Array.isArray(prop?.enum) && prop.enum.length > 0) return 'select';
  const t = primaryType(prop);
  if (t === 'boolean') return 'switch';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'object' || t === 'array') return 'textarea';
  // 没写 type 但有 properties → 当对象
  if (!t && prop?.properties) return 'textarea';
  return 'text';
}

/**
 * 长文本用 textarea。
 *
 * 判据是**说明里有没有暗示多行的词** + 名字，而不是长度 ——
 * description 里写 "markdown content" 就该是多行，
 * 而一个 200 字的枚举说明不该把输入框撑成六行。
 */
function wantsTextarea(prop: JsonSchemaProp, key: string): boolean {
  const k = String(key ?? '').toLowerCase();
  const d = String(prop?.description ?? '').toLowerCase();
  for (const w of ['content', 'body', 'text', 'markdown', 'html', 'json', 'description', 'note', 'query']) {
    if (k.includes(w) || d.includes(w)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

export type BuildOptions = {
  /** 给 label 加的前缀，默认不加以免太长 */
  color?: string;
};

/**
 * 把一条 MCP 工具 schema 变成节点蓝图。
 *
 * @param server 服务名（用于 type 与展示）
 * @param tool   工具 schema
 */
export function buildBlueprint(
  server: string,
  tool: McpToolSchema,
  opts: BuildOptions = {},
): NodeBlueprint | null {
  const toolName = String(tool?.name ?? '').trim();
  if (!toolName) return null;

  const schema = tool?.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map((x) => String(x)) : [],
  );

  const fields: BlueprintField[] = [];
  for (const key of Object.keys(props)) {
    const prop = props[key] ?? {};
    const kind = kindOf(prop);
    const degraded = kind === 'textarea' && (primaryType(prop) === 'object' || primaryType(prop) === 'array');

    let hint = prop.description ? String(prop.description) : '';
    if (degraded) {
      // 降级字段必须说明怎么填 —— 否则用户面对一个空文本框不知道写什么
      hint = hint ? `${hint}（这个参数是嵌套结构，在这里填 JSON）` : '嵌套结构，在这里填 JSON';
    }

    const f: BlueprintField = {
      key,
      label: key,
      kind: kind === 'text' && wantsTextarea(prop, key) ? 'textarea' : kind,
      hint: hint || undefined,
      required: required.has(key),
    };
    if (kind === 'select') f.options = (prop.enum ?? []).map((x) => String(x));
    if (degraded) f.degraded = true;
    if (prop.default !== undefined && prop.default !== null) {
      f.placeholder = String(prop.default);
    }
    fields.push(f);
  }

  const serverName = String(server ?? '').trim() || 'mcp';
  return {
    type: mcpTypeOf(serverName, toolName),
    dataKind: MCP_DATaKIND,
    server: serverName,
    tool: toolName,
    // 标题用「服务 · 工具」，只写工具名的话多个 server 的同名工具分不清
    label: `${serverName} · ${toolName}`,
    sub: String(tool?.description ?? '').trim() || `调用 ${toolName}`,
    fields,
    generatedAt: Date.now(),
  };
}

/** 一批工具 → 一批蓝图。schema 坏掉的会被跳过（不静默塞进侧栏） */
export function buildBlueprints(
  server: string,
  tools: McpToolSchema[],
  opts: BuildOptions = {},
): { list: NodeBlueprint[]; skipped: { name: string; reason: string }[] } {
  const list: NodeBlueprint[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const t of tools ?? []) {
    const name = String(t?.name ?? '').trim();
    if (!name) {
      skipped.push({ name: '（无名）', reason: '工具没有名字' });
      continue;
    }
    const bp = buildBlueprint(server, t, opts);
    if (!bp) {
      skipped.push({ name, reason: '生成失败' });
      continue;
    }
    /*
     * 同 type 只留一个 ——
     * slugify 会把 `read_file` 与 `read.file` 压成同一个片段，
     * 不排队的话后者会覆盖前者（覆盖在注册表里是静默的）。
     */
    if (seen.has(bp.type)) {
      skipped.push({ name, reason: `与另一个工具的名字压成了同一个标识（${bp.type}）` });
      continue;
    }
    seen.add(bp.type);
    list.push(bp);
  }
  return { list, skipped };
}

/* ------------------------------------------------------------------ */
/* 建节点数据                                                          */
/* ------------------------------------------------------------------ */

/**
 * 按蓝图造一份节点 data。
 *
 * 参数**平铺在 data 上**，不套一层 args ——
 * 模板 `{{xx.output}}` 与字段读写都按顶层 key 走，套一层会让
 * 所有通用机制（校验、卡片、默认值）都失效。
 */
export function createMcpData(
  bp: NodeBlueprint,
  partial: Record<string, unknown> = {},
): Record<string, unknown> {
  const d: Record<string, unknown> = {
    kind: MCP_DATaKIND,
    mcpServer: bp.server,
    mcpTool: bp.tool,
    status: 'idle',
    output: '',
    error: '',
  };
  for (const f of bp.fields) {
    d[f.key] = f.kind === 'switch' ? false : '';
  }
  return { ...d, ...partial };
}

/**
 * 取出要发给 server 的参数。
 *
 * 只发**有值**的字段：JSON Schema 里多半参数可选，
 * 把一堆空串发出去，server 那边会把它们当成显式传的空值，
 * 于是"没填"和"填了空"变得没区别 —— 而这两者语义通常不同。
 */
export function mcpArgsOf(data: Record<string, unknown>, bp: NodeBlueprint): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const f of bp.fields) {
    const v = data?.[f.key];
    if (v === '' || v === undefined || v === null) continue;
    if (f.degraded && typeof v === 'string') {
      // 降级字段尽力解析成真对象；解析不了就原样发，让 server 去报错
      try {
        args[f.key] = JSON.parse(v);
        continue;
      } catch {
        args[f.key] = v;
        continue;
      }
    }
    args[f.key] = v;
  }
  return args;
}

/** 必填参数缺哪些 —— 执行前就该发现，别等 server 报 */
export function missingRequired(
  data: Record<string, unknown>,
  bp: NodeBlueprint,
): string[] {
  const miss: string[] = [];
  for (const f of bp.fields) {
    if (!f.required) continue;
    const v = data?.[f.key];
    if (v === '' || v === undefined || v === null) miss.push(f.key);
  }
  return miss;
}

/** 按工具名给一个稳定的颜色（同一 server 的工具色系相近更好认） */
export function mcpColorOf(server: string): string {
  const palette = [
    '#f472b6', '#a78bfa', '#60a5fa', '#34d399',
    '#fbbf24', '#fb923c', '#f87171', '#22d3ee',
  ];
  let h = 0;
  const s = String(server ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) % 100000;
  }
  return palette[h % palette.length];
}

/* ------------------------------------------------------------------ */
/* 按 server 分组（侧栏折叠用）                                          */
/* ------------------------------------------------------------------ */

export type ServerGroup = {
  server: string;
  color: string;
  blueprints: NodeBlueprint[];
};

/**
 * 按 server 把蓝图分成小组。
 *
 * 一工具一节点会让侧栏条目数直接等于工具总数，
 * 不折叠的话连一个 40 工具的 server 就会把侧栏撑爆。
 *
 * 组按 server 名排序 —— 顺序稳定，否则每次刷新分组位置都在跳。
 */
export function groupByServer(list: NodeBlueprint[]): ServerGroup[] {
  const map = new Map<string, NodeBlueprint[]>();
  for (const bp of list ?? []) {
    const k = String(bp?.server ?? '').trim() || 'mcp';
    const cur = map.get(k);
    if (cur) cur.push(bp);
    else map.set(k, [bp]);
  }
  const out: ServerGroup[] = [];
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b));
  for (const k of keys) {
    const bps = (map.get(k) ?? []).slice().sort((a, b) => a.tool.localeCompare(b.tool));
    out.push({ server: k, color: mcpColorOf(k), blueprints: bps });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 签名比对：判断"工具变了没有"                                          */
/* ------------------------------------------------------------------ */

/**
 * 一个工具的签名（用于比对是否需要刷新）。
 *
 * 只比**字段与必填**，不比 description ——
 * 说明文字改了不影响调用，拿它当变化依据会造成大量无意义的"有更新"。
 */
export function signatureOf(bp: NodeBlueprint): string {
  const parts: string[] = [];
  for (const f of bp.fields ?? []) {
    parts.push(`${f.key}:${f.kind}${f.required ? '*' : ''}${(f.options ?? []).join('|')}`);
  }
  return parts.join(',');
}

export type DiffKind = 'added' | 'removed' | 'changed';

export type BlueprintDiff = {
  kind: DiffKind;
  type: string;
  label: string;
};

/**
 * 比对新旧两批蓝图。
 *
 * 「变了」只关心**会不会影响已有节点** ——
 * 字段类型变了或必填性变了才算 changed，单纯多了个新工具是 added。
 */
export function diffBlueprints(
  oldList: NodeBlueprint[],
  newList: NodeBlueprint[],
): BlueprintDiff[] {
  const oldMap = new Map<string, NodeBlueprint>();
  for (const b of oldList ?? []) oldMap.set(b.type, b);
  const newMap = new Map<string, NodeBlueprint>();
  for (const b of newList ?? []) newMap.set(b.type, b);

  const out: BlueprintDiff[] = [];
  for (const [t, b] of newMap) {
    if (!oldMap.has(t)) {
      out.push({ kind: 'added', type: t, label: b.label });
      continue;
    }
    if (signatureOf(oldMap.get(t) as NodeBlueprint) !== signatureOf(b)) {
      out.push({ kind: 'changed', type: t, label: b.label });
    }
  }
  for (const [t, b] of oldMap) {
    if (!newMap.has(t)) out.push({ kind: 'removed', type: t, label: b.label });
  }
  return out;
}

/**
 * 刷新会不会**弄坏**画布上已有的节点。
 *
 * 只有 removed / changed 才危险：
 * 画布上的节点存的是 data（参数按字段名读写），
 * 工具被删了那个节点就没处可去；字段变了老参数可能读不出来。
 * 新增工具不影响任何已有节点。
 */
export function refreshBreaksNodes(diffs: BlueprintDiff[]): boolean {
  for (const d of diffs) {
    if (d.kind === 'removed' || d.kind === 'changed') return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 导入导出（跨环境分享一批生成好的节点）                                */
/* ------------------------------------------------------------------ */

export type BlueprintFile = {
  format: 'agent-flow.mcp-blueprints/v1';
  exportedAt: string;
  blueprints: NodeBlueprint[];
};

/**
 * 导出一批蓝图。
 *
 * **不含任何密钥** —— 蓝图里只有工具名与参数结构，
 * 密钥属于画布上 MCP 服务的配置（那部分有自己的脱敏），不在这里。
 */
export function exportBlueprints(list: NodeBlueprint[]): string {
  const file: BlueprintFile = {
    format: 'agent-flow.mcp-blueprints/v1',
    exportedAt: new Date().toISOString(),
    blueprints: list ?? [],
  };
  return JSON.stringify(file, null, 2);
}

export type ImportResult = {
  list: NodeBlueprint[];
  skipped: { name: string; reason: string }[];
};

/**
 * 导入蓝图。
 *
 * 逐条校验：格式不对的**跳过并说明原因**，而不是整批失败 ——
 * 一份文件里坏了两条就让其余三十条都导不进来太可惜。
 */
export function importBlueprints(text: string): ImportResult {
  const list: NodeBlueprint[] = [];
  const skipped: { name: string; reason: string }[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return { list, skipped: [{ name: '（整个文件）', reason: '不是合法的 JSON' }] };
  }

  const o = parsed as BlueprintFile;
  if (!o || o.format !== 'agent-flow.mcp-blueprints/v1') {
    return { list, skipped: [{ name: '（整个文件）', reason: '不是本工具导出的蓝图文件' }] };
  }

  for (const bp of o.blueprints ?? []) {
    if (!bp || typeof bp.type !== 'string' || !bp.type) {
      skipped.push({ name: '（无名）', reason: '缺少 type' });
      continue;
    }
    if (!isMcpType(bp.type)) {
      /*
       * 只接受 mcp: 前缀的 ——
       * 放行任意 type 会让一份文件有能力覆盖注册表中的内置节点。
       */
      skipped.push({ name: bp.type, reason: '不是 MCP 节点的标识（应带 mcp: 前缀）' });
      continue;
    }
    if (!bp.server || !bp.tool) {
      skipped.push({ name: bp.type, reason: '缺 server 或 tool' });
      continue;
    }
    list.push({ ...bp, fields: bp.fields ?? [] });
  }
  return { list, skipped };
}

/**
 * 合并两批蓝图（同 type 用新的盖旧的）。
 *
 * 导入时同名工具重复会堆副本 —— 侧栏里出现两个一样的节点，
 * 用户分不清该用哪个。所以按 type 去重。
 */
export function mergeBlueprints(
  base: NodeBlueprint[],
  incoming: NodeBlueprint[],
): NodeBlueprint[] {
  const map = new Map<string, NodeBlueprint>();
  for (const b of base ?? []) map.set(b.type, b);
  for (const b of incoming ?? []) map.set(b.type, b);
  const out: NodeBlueprint[] = [];
  for (const v of map.values()) out.push(v);
  return out;
}
