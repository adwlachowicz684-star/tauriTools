/**
 * AI 对话监听：从 CLI / IDE 落在本地的对话文件里读消息，按关键词触发流程。
 *
 * 为什么需要单独一个模块：
 *   各家 CLI 把对话写在自己的目录里、格式还不统一（JSONL 结构各不相同）。
 *   解析、增量、匹配这些是纯逻辑，抽出来才能单测 —— 读写文件那层留在调用方。
 *
 * 关于"能读到什么"的诚实说明：
 *   只有**明文落盘**的才能读。目前确定可行的是 codebuddy / workbuddy 的
 *   JSONL；Trae IDE 把对话放在 SQLite 里（且新版是加密 transcript），
 *   本项目没有 SQLite 依赖，读不了 —— 探测时会明确报出来，而不是假装成功。
 *
 * 隐私边界：这些都是用户自己跟 AI 的本地对话，只在本机读取与匹配，
 * 不外发。关键词命中后注入工作流的是**命中的那段文本**，不是整个对话。
 */

/** 归一化后的一条消息 */
export type ConvMessage = {
  /** 谁说的 */
  role: 'user' | 'assistant' | 'system';
  /** 提取出的纯文本 */
  text: string;
  /** 毫秒时间戳；解析不出则为 null */
  ts: number | null;
  /**
   * 去重键。
   * 增量读取靠"读尾部 + 过滤新消息"，同一条消息可能被重复读到
   * （两次轮询的尾部窗口重叠），所以必须有个稳定的身份标识。
   */
  key: string;
};

/** 已知来源 */
export type ConvSourceKind = 'codebuddy' | 'workbuddy' | 'trae-ide' | 'traecli' | 'custom';

export const CONV_SOURCE_META: Record<ConvSourceKind, {
  label: string;
  /** 目录里长什么样，用于探测与界面提示 */
  filePattern: string;
  /** 是否明文可读。false 时探测要如实告知读不了 */
  readable: boolean;
  hint: string;
}> = {
  codebuddy: {
    label: 'CodeBuddy CLI',
    filePattern: '~/.codebuddy/projects/<项目>/<会话>.jsonl',
    readable: true,
    hint: '对话是明文 JSONL，可以直接读',
  },
  workbuddy: {
    label: 'WorkBuddy',
    filePattern: '~/.workbuddy/projects/<项目>/<会话>.jsonl',
    readable: true,
    hint: '对话是明文 JSONL（同 CodeBuddy 结构），可以直接读',
  },
  'trae-ide': {
    label: 'Trae IDE',
    filePattern: '…/User/workspaceStorage/*/state.vscdb',
    readable: false,
    hint: '对话存在 SQLite 里，新版还是加密 transcript，本项目读不了',
  },
  traecli: {
    label: 'TraeCode CLI',
    filePattern: '（待确认）',
    readable: false,
    hint: '存储位置随版本变化，需要先探测确认',
  },
  custom: {
    label: '自定义目录',
    filePattern: '自己指定',
    readable: true,
    hint: '指向任意存放 .jsonl 对话文件的目录',
  },
};

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

/**
 * 候选根目录。
 *
 * 刻意列多个：各家在不同平台、不同版本下路径不一样，
 * 与其猜一个，不如全列出来让探测逐个试 —— 试出来哪个算哪个。
 */
export function candidateRoots(home: string, platform: 'win' | 'mac' | 'linux'): {
  kind: ConvSourceKind;
  root: string;
}[] {
  const out: { kind: ConvSourceKind; root: string }[] = [];
  const j = (...p: string[]) => p.join('/').replace(/\/+/g, '/');

  // CLI 类：三平台都是家目录下的隐藏目录
  out.push({ kind: 'codebuddy', root: j(home, '.codebuddy', 'projects') });
  out.push({ kind: 'workbuddy', root: j(home, '.workbuddy', 'projects') });

  // Trae IDE：走 VSCode 系的 user-data 目录
  if (platform === 'win') {
    const appData = j(home, 'AppData', 'Roaming');
    for (const d of ['Trae', 'Trae CN', 'TRAE SOLO CN']) {
      out.push({ kind: 'trae-ide', root: j(appData, d, 'User', 'workspaceStorage') });
    }
  } else if (platform === 'mac') {
    const base = j(home, 'Library', 'Application Support');
    for (const d of ['Trae', 'Trae CN', 'TRAE SOLO CN']) {
      out.push({ kind: 'trae-ide', root: j(base, d, 'User', 'workspaceStorage') });
    }
  } else {
    const base = j(home, '.config');
    for (const d of ['Trae', 'Trae CN', 'TRAE SOLO CN']) {
      out.push({ kind: 'trae-ide', root: j(base, d, 'User', 'workspaceStorage') });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** content 字段可能是字符串，也可能是 [{type:'text', text:'…'}] */
function textOfContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      const o = b as Record<string, unknown>;
      // 只要文本块：工具调用 / 图片等不参与关键词匹配
      if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text);
      else if (o.type === 'input_text' && typeof o.text === 'string') parts.push(o.text);
    }
    return parts.join('\n');
  }
  return '';
}

/** 时间戳：字符串 / 秒 / 毫秒都认 */
function tsOf(o: Record<string, unknown>): number | null {
  const raw = o.timestamp ?? o.ts ?? o.createdAt ?? o.time;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    // 小于 1e12 说明是秒（1e12 秒已是公元 3 万年），补成毫秒
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * 解析一行 JSONL。
 *
 * 各家字段名不同，所以是"尽力而为"：认出角色和文本就算成功，
 * 认不出返回 null —— 调用方静默跳过，不刷日志。
 */
export function parseMessage(line: string, source: string): ConvMessage | null {
  const s = line.trim();
  if (!s || s[0] !== '{') return null;

  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;

  // 角色：有的写在顶层 type，有的嵌在 message.role
  const inner = (r.message && typeof r.message === 'object')
    ? (r.message as Record<string, unknown>)
    : null;

  let role: ConvMessage['role'] | null = null;
  /*
   * 优先级：message.role > 顶层 role > 顶层 type。
   *
   * 内层最具体 —— 有的格式外层 type 是记录类型（"record" 之类），
   * 真正的说话人在 message.role 里。只看顶层 type 会把这些全漏掉。
   */
  for (const rawRole of [inner?.role, r.role, r.type]) {
    if (rawRole === 'user' || rawRole === 'human') { role = 'user'; break; }
    if (rawRole === 'assistant' || rawRole === 'ai' || rawRole === 'model') { role = 'assistant'; break; }
    if (rawRole === 'system') { role = 'system'; break; }
  }

  const text = textOfContent(r.content ?? inner?.content ?? r.text ?? r.message);
  // 没角色或没文本都不算有效消息：tool_result 之类会被这里挡掉
  if (!role || !text.trim()) return null;

  // 去重键：优先用消息 id，没有就用「来源 + 时间戳 + 文本长度 + 文本前缀」
  const id = r.uuid ?? r.id ?? r.messageId;
  const key = typeof id === 'string' && id
    ? `${source}#${id}`
    : `${source}#${tsOf(r) ?? 0}#${text.length}#${text.slice(0, 64)}`;

  return { role, text, ts: tsOf(r) ?? tsOf(inner ?? {}) , key };
}

/**
 * 从一段文件内容里解析出消息。
 *
 * 尾部窗口会切在行中间（读到的是文件末尾 N 字节），
 * 所以**第一行要丢掉** —— 它多半是半截 JSON，解析必然失败。
 * 丢掉最多只影响一条消息，而它下轮还会被完整读到。
 */
export function parseMessages(content: string, source: string): ConvMessage[] {
  const lines = content.split('\n');
  const out: ConvMessage[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const m = parseMessage(lines[i], source);
    if (m) out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 增量                                                                */
/* ------------------------------------------------------------------ */

export type SeenState = {
  /** 已处理过的消息 key */
  keys: Set<string>;
  /** 已见过的最新时间戳，用于兜底判断"是不是新的" */
  lastTs: number;
};

export function newSeenState(): SeenState {
  return { keys: new Set<string>(), lastTs: 0 };
}

/**
 * 挑出没见过的消息，并更新 seen。
 *
 * 两种判据并用：
 *   key  —— 精确去重，挡住两次轮询窗口重叠导致的重复
 *   lastTs —— 兜底。首次扫描时历史消息会被全部读进来，
 *             这些不该触发流程（用户要的是"关键词出现时"，不是"历史上出现过"）。
 *             所以首次只记录不返回，见 prime。
 */
export function takeNew(msgs: ConvMessage[], seen: SeenState, prime: boolean): ConvMessage[] {
  const out: ConvMessage[] = [];
  for (const m of msgs) {
    if (seen.keys.has(m.key)) continue;
    seen.keys.add(m.key);
    if (m.ts !== null && m.ts > seen.lastTs) seen.lastTs = m.ts;
    if (prime) continue;   // 首次只建立基线，不触发
    out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 探测                                                                */
/* ------------------------------------------------------------------ */

export type ProbeResult = {
  kind: ConvSourceKind;
  root: string;
  /** 目录是否存在 */
  exists: boolean;
  /** 找到的对话文件数量 */
  files: number;
  /** 抽样里能成功解析出消息的行数 */
  parsed: number;
  /**
   * 是否可用。SQLite / 加密来源即使目录存在也是 false ——
   * 探测的价值就在于如实区分"能读"和"看得见但读不了"，
   * 否则用户配了半天才发现配了个读不动的东西。
   */
  usable: boolean;
  /** 不可用时说明原因 */
  note: string;
  /** 最近修改的那个文件，可作为默认监听目录的参考 */
  sample: string;
};

/**
 * 根据探测结果给出结论。
 *
 * 抽出来是为了能单测：判断"到底能不能用"涉及 exists / files / parsed
 * / readable 四个条件的组合，写在 UI 里就没法验证了。
 */
export function concludeProbe(
  kind: ConvSourceKind,
  exists: boolean,
  files: number,
  parsed: number,
): Pick<ProbeResult, 'usable' | 'note'> {
  const meta = CONV_SOURCE_META[kind];

  if (!meta.readable) {
    return {
      usable: false,
      note: exists
        ? `目录存在，但${meta.hint} —— 本触发器只能读明文 JSONL`
        : `未找到该目录（${meta.hint}）`,
    };
  }
  if (!exists) return { usable: false, note: '目录不存在' };
  if (files === 0) return { usable: false, note: '目录存在，但没有找到对话文件' };
  if (parsed === 0) {
    return {
      usable: false,
      note: `找到 ${files} 个文件，但没解析出任何消息 —— 可能格式变了，或文件是加密的`,
    };
  }
  return { usable: true, note: `可用：${files} 个文件，抽样解析出 ${parsed} 条消息` };
}

/* ------------------------------------------------------------------ */
/* 匹配                                                                */
/* ------------------------------------------------------------------ */

export type MatchScope = 'user' | 'both';

export type KeywordHit = {
  message: ConvMessage;
  keyword: string;
  /** 命中位置附近的一段上下文，方便流程里判断 */
  excerpt: string;
};

/** 关键词：按行拆，去空、去注释行（# 开头） */
export function parseKeywords(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('#'));
}

/**
 * 匹配关键词。
 *
 * 大小写不敏感：对话里的 "ERROR" / "error" / "Error" 都该算命中，
 * 让用户为每个大小写变体写一遍关键词不合理。
 */
export function matchKeywords(
  msgs: ConvMessage[],
  keywords: string[],
  scope: MatchScope,
  excerptLen = 200,
): KeywordHit[] {
  if (keywords.length === 0) return [];
  const hits: KeywordHit[] = [];

  for (const m of msgs) {
    if (scope === 'user' && m.role !== 'user') continue;
    if (m.role === 'system') continue;   // 系统提示词不参与，噪声太大

    const lower = m.text.toLowerCase();
    for (const kw of keywords) {
      const at = lower.indexOf(kw.toLowerCase());
      if (at < 0) continue;
      const from = Math.max(0, at - Math.floor(excerptLen / 3));
      hits.push({
        message: m,
        keyword: kw,
        excerpt: m.text.slice(from, from + excerptLen),
      });
      // 一条消息只报第一个命中的关键词：同条消息触发多次没意义
      break;
    }
  }
  return hits;
}
