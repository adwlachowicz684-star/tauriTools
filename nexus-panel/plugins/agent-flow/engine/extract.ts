/**
 * 数据提取：把上游的一大段文本（典型是 HTTP 响应）裁成下游能用的值。
 *
 * 为什么需要这个节点：通用 HTTP 节点拿回来的是整段响应文本，
 * 直接接条件节点没法判断 —— 得先取出 `data.items[0].title` 这样的字段。
 * 没有这一环，HTTP 节点只能"拿到但用不了"。
 *
 * 纯逻辑、零依赖：不碰 DOM、不发请求，因此可以在 Node 下直接单测。
 */

/** 提取方式 */
export type ExtractMode = 'json' | 'regex' | 'line' | 'text';

/*
 * 下面几个别名是为了迁就 scripts/strip-ts.py：
 * 它剥不掉 `(string | number)[] | null` 这种带括号与方括号的组合类型，
 * 原样留在 .mjs 里会让 Node 语法错误。用别名把复杂结构隔离在类型声明行里，
 * 函数签名就只剩一个标识符，能干净剥掉。
 */
type PathToken = string | number;
type JsonPath = PathToken[];
type JsonPathOrNull = JsonPath | null;

/** stringify 的返回。同理：内联对象类型注解也剥不掉，起个别名 */
type StringifyOut = { text: string; warn?: string };

/** 取行的规则 */
export type LineRule =
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'index'; value: number }
  | { kind: 'contains'; value: string };

export type ExtractResult = {
  ok: boolean;
  /** 提取结果；失败时为空串 */
  text: string;
  /** 失败原因（给界面显示） */
  error?: string;
  /** 非致命提示，如"取到的是对象，已转成 JSON 字符串" */
  warn?: string;
};

/** 解析行规则。返回 null 表示格式不认识 */
export function parseLineRule(spec: string): LineRule | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  if (s === 'first') return { kind: 'first' };
  if (s === 'last') return { kind: 'last' };
  if (/^-?\d+$/.test(s)) return { kind: 'index', value: Number(s) };
  // 支持 `contains:关键字` 与直接给关键字两种写法
  const m = s.match(/^contains:\s*(.*)$/);
  if (m) return { kind: 'contains', value: m[1] };
  return { kind: 'contains', value: spec };
}

/**
 * 按路径取值。
 *
 * 支持的写法（都转成同一套 token 再走一遍）：
 *   data.items[0].title   → ['data', 'items', 0, 'title']
 *   data.items.0.title    → 同上（下标段的纯数字写法）
 *   [0].title             → [0, 'title']（从数组根开始）
 *   a.b[2][3]             → ['a','b',2,3]
 *
 * 为什么要兼容 `[0]` 和 `.0`：用户从浏览器/接口文档里抄路径时两种都会遇到，
 * 只认一种就得回去手改，这种摩擦不值得。
 */
export function parseJsonPath(path: string): JsonPathOrNull {
  const s = path.trim();
  if (!s) return null;
  const tokens: JsonPath = [];

  // 先把 `name[0][1]` 拆开：`name` + 连续下标
  const segRe = /([^.[\]]+)|\[(-?\d+)\]/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = segRe.exec(s)) !== null) {
    matched = true;
    if (m[1] !== undefined) {
      // 纯数字段当下标：`.0` 与 `[0]` 是同一个意思，
      // 不转数字就会拿字符串 '0' 去查数组，取到 undefined
      const seg = m[1];
      tokens.push(/^-?\d+$/.test(seg) ? Number(seg) : seg);
    } else {
      tokens.push(Number(m[2]));
    }
  }
  // 一个 token 都没匹配上说明整串是分隔符/空白之类的怪东西
  return matched ? tokens : null;
}

/** 按已解析的路径取值；取不到返回 undefined */
function getByTokens(root: unknown, tokens: JsonPath): unknown {
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof t === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t < 0 ? cur.length + t : t];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur;
}

/** 取到的值转成可放进 {{变量}} 的字符串 */
function stringify(v: unknown): StringifyOut {
  if (typeof v === 'string') return { text: v };
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v) };
  // 对象/数组：条件节点判"等于 true"要的是字符串，这里转 JSON 并给个提示，
  // 免得用户看到 [object Object] 不知道发生了什么
  try {
    return { text: JSON.stringify(v), warn: '取到的是对象或数组，已转成 JSON 字符串' };
  } catch {
    return { text: '', warn: '取到的值无法序列化' };
  }
}

/**
 * 主入口。
 *
 * @param input 待提取的文本（通常来自上游输出）
 * @param mode  提取方式
 * @param spec  各方式的参数：json→路径、regex→正则、line→行规则
 * @param group 正则模式下取第几个捕获组（0 是整段匹配）
 */
export function extractText(
  input: string,
  mode: ExtractMode,
  spec: string,
  group = 1,
): ExtractResult {
  const src = input ?? '';

  if (mode === 'text') {
    return { ok: true, text: src };
  }

  if (mode === 'json') {
    const tokens = parseJsonPath(spec);
    if (!tokens) return { ok: false, text: '', error: '请填写 JSON 路径，如 data.items[0].title' };

    let root: unknown;
    try {
      root = JSON.parse(src);
    } catch (e) {
      return {
        ok: false,
        text: '',
        error: `响应不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const v = getByTokens(root, tokens);
    if (v === undefined) {
      return { ok: false, text: '', error: `路径 ${spec} 在响应里取不到值` };
    }
    const { text, warn } = stringify(v);
    return { ok: true, text, warn };
  }

  if (mode === 'regex') {
    if (!spec) return { ok: false, text: '', error: '请填写正则表达式' };
    let re: RegExp;
    try {
      re = new RegExp(spec);
    } catch (e) {
      return { ok: false, text: '', error: `正则不合法：${e instanceof Error ? e.message : String(e)}` };
    }
    const m = re.exec(src);
    if (!m) return { ok: false, text: '', error: '没有匹配到内容' };

    // 没写捕获组却要 group 1：退回整段匹配，比直接报"取不到"更符合预期
    const idx = m.length > 1 ? group : 0;
    const picked = m[idx];
    if (picked === undefined) {
      return { ok: false, text: '', error: `没有第 ${group} 个捕获组（该正则共 ${m.length - 1} 个）` };
    }
    return { ok: true, text: picked };
  }

  /* mode === 'line' */
  const rule = parseLineRule(spec);
  if (!rule) return { ok: false, text: '', error: '请填写行规则：first / last / 行号 / 包含的文字' };

  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  switch (rule.kind) {
    case 'first':
      return { ok: true, text: lines[0] ?? '' };
    case 'last':
      return { ok: true, text: lines[lines.length - 1] ?? '' };
    case 'index': {
      const i = rule.value < 0 ? lines.length + rule.value : rule.value;
      const hit = lines[i];
      if (hit === undefined) {
        return { ok: false, text: '', error: `没有第 ${rule.value} 行（共 ${lines.length} 行）` };
      }
      return { ok: true, text: hit };
    }
    case 'contains': {
      const hit = lines.find((l) => l.includes(rule.value));
      if (hit === undefined) {
        return { ok: false, text: '', error: `没有包含「${rule.value}」的行` };
      }
      return { ok: true, text: hit };
    }
  }
}
