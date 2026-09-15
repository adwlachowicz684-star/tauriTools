/**
 * A71 诊断错误捕获
 * ============================================================
 * 对应 WPF `KityMinderHost.xaml.cs:183-198`：捕获 `onerror`、
 * `unhandledrejection`、`console.error/warn` 并轮询取回。
 *
 * 为什么需要它：脑图的核心（kityminder）跑在**嵌套 iframe** 里，
 * 那里的报错不会出现在外壳的控制台里 —— 除非特意打开 iframe 的开发者工具。
 * 于是「点了没反应」「画布空白」这类问题在用户侧完全没有线索可查。
 *
 * 与 C# 版的差异：原版靠 C# **轮询**取回；Web 版内层直接 postMessage 推上来，
 * 少一个轮询循环。外层仍保留「最多 N 条」的环形收口，避免长时间运行后无限堆积。
 */

/** 环形缓冲上限：诊断信息只保留最近这些条 */
export const MAX_ENTRIES = 100;

/**
 * 归一化一条诊断记录（纯函数，可测）。
 *
 * 各来源字段不一致（onerror 有 lineno/col，Promise 只有 reason，
 * console 只有参数列表），统一成一种结构，UI 才好展示。
 *
 * @returns {object|null} 无法提取任何信息时返回 null（过滤掉噪声）
 */
export function normalize(raw) {
  if (raw == null) return null;
  // 已经是条目（来自 iframe 转发）→ 只做字段补全
  if (typeof raw === 'object' && raw.message !== undefined) {
    const msg = String(raw.message ?? '').trim();
    if (!msg) return null;
    return {
      level: raw.level === 'warn' ? 'warn' : 'error',
      message: msg,
      stack: raw.stack ? String(raw.stack) : '',
      source: raw.source ? String(raw.source) : 'editor',
      at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
    };
  }
  const msg = String(raw).trim();
  return msg ? { level: 'error', message: msg, stack: '', source: 'shell', at: Date.now() } : null;
}

/**
 * 环形缓冲（纯函数，可测）。
 *
 * 超限时**丢弃最旧的**，保留最近的 —— 诊断看的是「刚刚发生了什么」，
 * 留着几分钟前的旧报错反而把真正相关的挤掉了。
 *
 * @param {Array} list 现有条目
 * @param {Array} incoming 新条目
 * @param {number} [max]
 * @returns {Array} 新数组（不改动入参）
 */
export function pushEntries(list = [], incoming = [], max = MAX_ENTRIES) {
  const all = [...list, ...incoming];
  return all.length > max ? all.slice(all.length - max) : all;
}

/** 按级别过滤（纯函数，可测） */
export function filterByLevel(list = [], level) {
  if (!level) return list;
  return list.filter((e) => e.level === level);
}

/**
 * 格式化成可复制的文本（纯函数，可测）。
 * 用户报问题时能整段贴出来，比截图有用。
 */
export function formatReport(list = []) {
  if (!list.length) return '（无诊断记录）';
  const t = (n) => {
    try { return new Date(n).toLocaleString(); } catch { return String(n); }
  };
  return list.map((e) => `[${t(e.at)}] ${e.level.toUpperCase()} (${e.source})\n${e.message}${e.stack ? '\n' + e.stack : ''}`).join('\n\n');
}
