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
 * 取出可用的入参属性表。
 *
 * 返回 `null` = **这份 schema 我们渲染不出来**，调用方应当跳过该工具
 * 而不是硬生成一个"看起来没参数"的节点。
 *
 * 三种情形：
 *   · 根本没给 inputSchema → 当成无参工具（`{}`）。
 *     规范里它是必填的，但现实中有 server 省略它，而"无参"恰好是
 *     对这些工具的正确理解（它们真的不要参数），判成坏 schema 会误伤。
 *   · 明确写了 type 且不是 object → `null`。
 *     这说明工具要的**不是一组具名参数**（而是一个字符串/数组整体），
 *     表单渲染不出来；当成无参会发出一份空参数，是发错而不是少发。
 *   · properties 给了但不是对象 → `null`。
 *     坏 schema。不拦的话 `Object.keys('abc')` 会得出 `['0','1','2']`，
 *     凭空生成三个名叫 0/1/2 的字段。
 */
function propsOf(schema: McpToolSchema['inputSchema']): Record<string, JsonSchemaProp> | null {
  if (!schema || typeof schema !== 'object') return {};
  const t = String((schema as { type?: unknown }).type ?? '').trim().toLowerCase();
  if (t && t !== 'object') return null;
  const p = (schema as { properties?: unknown }).properties;
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) return null;
  return p as Record<string, JsonSchemaProp>;
}

/** 这份 schema 渲染不出来时，给出能直接显示给用户的原因 */
export function schemaRejectReason(schema: McpToolSchema['inputSchema']): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const t = String((schema as { type?: unknown }).type ?? '').trim().toLowerCase();
  if (t && t !== 'object') {
    return `入参不是一组具名参数（type=${t}）—— 表单渲染不出来，按无参处理会发错参数`;
  }
  const p = (schema as { properties?: unknown }).properties;
  if (p !== undefined && p !== null && (typeof p !== 'object' || Array.isArray(p))) {
    return '入参结构里的 properties 不是对象（坏 schema）';
  }
  return null;
}

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

  const schema = tool?.inputSchema;
  const props = propsOf(schema);
  if (props === null) return null;
  const required = new Set(
    Array.isArray((schema as { required?: unknown })?.required)
      ? (schema as { required: unknown[] }).required.map((x) => String(x))
      : [],
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

  /*
   * required 里点名、properties 里却没有的参数 —— **补一个文本框**。
   *
   * 不补的话它会同时消失在两个地方：面板上没有这个格子（用户填不了），
   * 而 missingRequired 只遍历 fields、也查不到它（于是"校验通过"）。
   * 结果是一个死局：执行时把缺参数的请求发给 server，server 报
   * "缺少必填参数 X"，而用户根本无处可填 X，也不会知道是 schema 的问题。
   *
   * 补成文本是猜的（schema 没给类型），但猜了至少能用、且校验得到；
   * hint 明说这是补的，用户才知道该去核对原工具的定义。
   */
  for (const key of required) {
    if (Object.prototype.hasOwnProperty.call(props, key)) continue;
    fields.push({
      key,
      label: key,
      kind: 'text',
      required: true,
      hint: 'schema 里声明为必填、却没给出定义 —— 按文本处理（请核对原工具的参数）',
    });
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
    const bad = schemaRejectReason(t?.inputSchema);
    if (bad) {
      skipped.push({ name, reason: bad });
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

/**
 * 跨服务去重：同 type 只留第一个。
 *
 * `buildBlueprints` 的 seen 只在**同一批（同一个 server）内**查重，
 * 而 slugify 会把 `Notion MCP` 与 `notion.mcp` 压成同一个片段 ——
 * 两个服务名压成同 slug、工具又同名时，两条蓝图得到**完全相同的 type**。
 *
 * 后果比"少一个工具"糟：注册表按 type 存，后者**静默覆盖**前者，
 * 而侧栏是按原始服务名分组的，于是界面上两个条目都在、计数也各算 1，
 * 拖出来的却是同一个（后注册的那个）。用户以为拖的是 A 的工具，
 * 调的是 B 的 —— 全程不报错。
 *
 * 所以汇总后必须再排一次队，撞掉的**说出来**而不是悄悄丢掉。
 */
export function dedupeByType(
  list: NodeBlueprint[],
): { list: NodeBlueprint[]; dropped: NodeBlueprint[] } {
  const keep: NodeBlueprint[] = [];
  const dropped: NodeBlueprint[] = [];
  const seen = new Set<string>();
  for (const b of list ?? []) {
    const t = String(b?.type ?? '');
    if (t && seen.has(t)) {
      dropped.push(b);
      continue;
    }
    if (t) seen.add(t);
    keep.push(b);
  }
  return { list: keep, dropped };
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
/**
 * 参数结构的"指纹" —— 用来判断这次刷新**有没有改到参数结构**。
 *
 * ⚠️ 必须**排序后再拼**：参数格的显示顺序来自 `Object.keys(props)`，
 *    也就是 server 返回 JSON 里的属性顺序，那不是一份稳定的承诺 ——
 *    换一次顺序就指纹变了，于是每个工具都被判成 changed，
 *    刷新完界面就报「N 个节点受影响」，而实际上一个都没坏。
 *
 *    这类误报比漏报更糟：参数没变却说变了，报几次之后
 *    这条提示本身就不被信任了 —— 真出事时也没人看。
 *
 *    只把指纹排成规范序，**不去排序 fields 本身**：
 *    面板上的格子顺序沿用 schema 的顺序（往往就是"必填在前"的逻辑顺序），
 *    按字母硬排反而更难填。
 */
export function signatureOf(bp: NodeBlueprint): string {
  const parts: string[] = [];
  for (const f of bp.fields ?? []) {
    parts.push(`${f.key}:${f.kind}${f.required ? '*' : ''}${(f.options ?? []).join('|')}`);
  }
  return parts.sort().join(',');
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
 * 这次变化里**会弄坏已有节点**的工具标识（removed / changed）。
 *
 * 判定收在这一处：下面 refreshBreaksNodes 与 describeAffected 都从它来。
 * 各写一份的话，"会不会弄坏"和"点名说哪些"迟早对不上 ——
 * 表现为说了"会弄坏"却点不出名字，或反过来。
 *
 * 新增工具不影响任何已有节点，所以不在其中。
 */
export function brokenTypes(diffs: BlueprintDiff[]): string[] {
  const out: string[] = [];
  for (const d of diffs ?? []) {
    if (d?.kind === 'removed' || d?.kind === 'changed') out.push(d.type);
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
  return brokenTypes(diffs).length > 0;
}

/** 画布上每种 MCP 节点各用了几个（只看 mcp: 前缀的） */
export function countMcpUsage(canvases: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of canvases ?? []) {
    const nodes = (c as { nodes?: unknown[] } | null)?.nodes;
    for (const n of nodes ?? []) {
      const t = (n as { type?: unknown } | null)?.type;
      if (typeof t !== 'string' || !isMcpType(t)) continue;
      out[t] = (out[t] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * 把"这次变化影响了画布上哪些节点"说成一句话。
 *
 * 日志里原本只说「新增 1、变更 1、移除 1」——**不点名、也不提画布**。
 * 而用户真正要修的是画布上那些节点：工具没了、或字段改了名，
 * 已填的参数会对不上，执行时表现是"我明明填了却说缺必填参数"，
 * 排查时想不到是服务端升级改了工具。
 *
 * 只有**真的被用到**的那些才说 ——
 * 无害的新增与没被用到的移除一律不提，否则每次刷新都刷一句警告，
 * 警告就不值钱了。
 */
export function describeAffected(
  diffs: BlueprintDiff[],
  usage: Record<string, number>,
): string | null {
  const labelOf = new Map<string, string>();
  const kindOf = new Map<string, string>();
  for (const d of diffs ?? []) {
    labelOf.set(d.type, d.label);
    kindOf.set(d.type, d.kind);
  }
  const parts: string[] = [];
  let total = 0;
  for (const t of brokenTypes(diffs)) {
    const n = usage?.[t] ?? 0;
    if (n <= 0) continue;
    total += n;
    const name = labelOf.get(t) ?? t;
    const what = kindOf.get(t) === 'removed' ? '工具已不存在' : '参数结构变了';
    parts.push(`「${name}」${what}（${n} 个节点）`);
  }
  if (parts.length === 0) return null;
  return `⚠ 画布上有 ${total} 个 MCP 节点用着这次变化的工具：${parts.join('、')} —— 它们的参数可能要重填`;
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

/** 侧栏要显示哪些（过滤掉 stale 的） */
export function visibleBlueprints(list: NodeBlueprint[]): NodeBlueprint[] {
  return (list ?? []).filter((b) => !b.stale);
}

/* ------------------------------------------------------------------ */
/* 侧栏分组与计数（纯数据变换，不依赖 React 与注册表）                    */
/* ------------------------------------------------------------------ */

/** 侧栏一个 MCP 条目 */
/**
 * ================= 超时口径：三个常量必须一起看 =================
 *
 * 协议层一次调用要发**三次**请求（initialize → notifications/initialized
 * → tools/list），所以"单次上限"和"整体上限"是两回事：
 *
 *   整体上限 必须 **严格大于** 单次上限 × 握手次数
 *
 * 相等都不行 —— 三次都慢到接近单次上限时，整体那道会在最后一次
 * 请求返回前先触发，把一个**完全正常**的服务判成"迟迟不返回"。
 * （实测：单次 1 秒 × 3 次，整体设 3 秒 → 正常服务被误判超时。）
 *
 * 以前这两个数是散在三处的字面量（协议层默认 20、hook 里写 20、
 * 整体写 60_000），改一处漏一处就是两种失效：
 *   · 只改小单次 → 整体相对变宽，卡住的服务要多等很久
 *   · 只改大单次 → 整体相对变窄，**正常服务被误伤**
 *
 * 所以收在这里，整体上限由公式算出来。
 */

/** 单次请求的超时（秒）—— 拉工具清单用。listTools 的默认参数 */
export const MCP_SINGLE_TIMEOUT_SEC = 20;

/**
 * 单次请求的超时（秒）—— **调**工具用。
 *
 * 比拉清单长：工具可能真的要跑一会儿（查库、写文件），
 * 20 秒不够；但它也必须是个具名常量，
 * 否则将来给 callTool 算整体上限时又是一处写死的数。
 */
export const MCP_CALL_TIMEOUT_SEC = 60;

/** 一次协议调用发几次请求 —— 握手两次 + 真正那一次 */
export const MCP_HANDSHAKE_CALLS = 3;

/**
 * 在"单次 × 次数"之上再给的余量（秒）。
 *
 * 三次请求之间还有解析与调度开销，只留 0 余量等于把边界抖动
 * 也算成异常。
 */
export const MCP_TIMEOUT_MARGIN_SEC = 30;

export type McpSidebarItem = {
  key: string;
  label: string;
  hint?: string;
  /**
   * 参数名。只在**检索**时用，界面不显示 ——
   * 折叠状态下显示一串参数名会把条目撑成两行。
   */
  argKeys?: string[];
};

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
  return groupByServer(visibleBlueprints(list)).map((g) => ({
    server: g.server,
    color: g.color,
    items: g.blueprints.map((b) => ({
      key: b.type,
      label: b.tool,
      hint: b.sub,
      argKeys: (b.fields ?? []).map((f) => f.key),
    })),
  }));
}

/**
 * 每个服务下当前有几个工具节点，按服务名索引。
 *
 * **必须从侧栏分组派生，不能从蓝图快照算。**
 *
 * 快照（hydrateMcpNodes 的结果）是启动那一刻读的，刷新成功后它**不会变**
 * —— 于是两个地方显示同一件事，一个更新了一个没有：
 *
 *   启动快照为空、刷新拉到 3 个工具
 *     → 侧栏有 3 个，服务面板却一个工具数都不显示
 *   刷新后服务端删掉一个工具
 *     → 侧栏 2 个，服务面板还写着「3 个工具」
 *
 * 两种都不报错，只是两个数字对不上 —— 用户会以为其中一处是坏的。
 * 从同一个源派生，就不会有分叉的可能。
 */
export function toolCountOf(groups: McpSidebarGroup[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups ?? []) {
    const k = String(g?.server ?? '').trim();
    if (!k) continue;
    out[k] = (out[k] ?? 0) + (g?.items?.length ?? 0);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 检索                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按关键词过滤侧栏的 MCP 条目。
 *
 * ================= 为什么需要它 =================
 *
 * 一个稍微像样的 MCP 服务就有几十个工具，连三四个服务就是上百条。
 * 侧栏按 server 折叠后仍要一层层展开、用眼睛扫 ——
 * 而用户要找的是"那个读文件的工具"，不是"Notion 这个服务下的第 37 个"。
 *
 * 没有检索时，这类节点的可用性随工具数量**线性下降**，
 * 而"连上更多服务"恰恰是这个功能的卖点 —— 于是卖点变成负担。
 *
 * ================= 匹配范围 =================
 *
 * 工具名、说明、服务名、参数名都参与。
 *
 * 服务名参与是因为用户常记得的是"notion 那个"，而不是具体工具名；
 * 参数名参与是因为"能传 path 的那个工具"是很自然的找法 ——
 * 而参数名在界面上折叠起来根本看不见，只能靠搜。
 *
 * 不匹配 label（"服务 · 工具"拼接串）：它和上面三项完全重叠，
 * 加了只会让同一条命中两次，没有任何新增召回。
 */
export function matchesMcpTool(item: McpSidebarItem, server: string, kw: string): boolean {
  const q = String(kw ?? '').trim().toLowerCase();
  if (!q) return true;
  const hay = [item.label, item.hint ?? '', server, ...(item.argKeys ?? [])]
    .join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}

export type McpFilterResult = {
  groups: McpSidebarGroup[];
  /** 命中总数。显示"搜到 N 个"，否则零结果时分不清是没搜到还是没连上 */
  total: number;
};

/**
 * 过滤侧栏分组。
 *
 * 空关键词原样返回（不是返回空 —— 那会让"没输入"变成"什么都没有"）。
 *
 * 服务名下**一条都不剩**时整个组去掉：留一个空组，
 * 用户会以为那个服务连上了但没报工具，实际是没搜到。
 */
export function filterMcpGroups(groups: McpSidebarGroup[], kw: string): McpFilterResult {
  const q = String(kw ?? '').trim();
  if (!q) {
    let n = 0;
    for (const g of groups ?? []) n += (g?.items?.length ?? 0);
    return { groups: groups ?? [], total: n };
  }
  const out: McpSidebarGroup[] = [];
  let total = 0;
  for (const g of groups ?? []) {
    const items = (g?.items ?? []).filter((it) => matchesMcpTool(it, g.server, q));
    if (items.length === 0) continue;
    total += items.length;
    out.push({ ...g, items });
  }
  return { groups: out, total };
}

