/**
 * 请求头文本的解析 —— **执行器与脱敏共用同一份**。
 *
 * 为什么单独抽一个文件：请求头有两种读者 ——
 * 发送请求的 runner，和「什么不能落进存档」的脱敏。
 * 两边各写一份解析的结果就是漂移：
 *   · 执行器认得 `Authorization`、脱敏不认得 → 密钥明文进存档
 *   · 或者反过来，脱敏挖了执行器压根不会发的行 → 用户白填一次
 * 这类漂移不报错、测试也不红，只有真去翻 localStorage 才看得见。
 *
 * 这里不 import 任何东西，所以 sanitize（底层模块）也能安全依赖它，
 * 不会出现「底层反向依赖某个具体 runner」那种架构倒退。
 */

export interface HeaderLine {
  /** 原始整行，含缩进与 # 前缀。改写时从它切，才能保留用户原来的排版 */
  raw: string;
  /** 是否 # 注释行：执行器不发送，但里面的 token 一样是明文 */
  comment: boolean;
  name: string;
  value: string;
}

function headerLineOf(raw: string): HeaderLine | null {
  const s = raw.trim();
  if (!s) return null;
  const comment = s.startsWith('#');
  const body = comment ? s.slice(1).trim() : s;
  const i = body.indexOf(':');
  if (i < 0) return null;
  const name = body.slice(0, i).trim();
  if (!name) return null;
  return { raw, comment, name, value: body.slice(i + 1).trim() };
}

/** 所有认得出来的行，按原文顺序 */
export function parseHeaderLines(text: string): HeaderLine[] {
  const out: HeaderLine[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const l = headerLineOf(raw);
    if (l) out.push(l);
  }
  return out;
}

/** 逐行改写：认得出来的行交给 fn，认不出来的（空行、没有冒号的）原样保留 */
export function mapHeaderLines(text: string, fn: (l: HeaderLine) => string): string {
  return String(text ?? '')
    .split('\n')
    .map((raw) => {
      const l = headerLineOf(raw);
      return l ? fn(l) : raw;
    })
    .join('\n');
}

/**
 * 解析成 { 名字: 值 } —— 执行器真正会发出的那些头。
 * 空行与 # 注释行跳过（与抽出来之前的行为逐字一致）。
 */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of parseHeaderLines(text)) {
    if (l.comment) continue;
    out[l.name] = l.value;
  }
  return out;
}
