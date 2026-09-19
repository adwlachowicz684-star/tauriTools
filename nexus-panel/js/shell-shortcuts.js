/**
 * 外壳快捷键清单（**只用于展示与撞车判断**，不参与执行）
 * ============================================================
 * 存在理由：
 *
 * 外壳快捷键的执行逻辑分散在**两个外壳**里，而且写法不同：
 *   · js/shell.js  —— `shellCommands` 对象，原生外壳，操作 DOM
 *   · src/App.tsx  —— `onKey` 里的 if 链，React 外壳，调 setState
 *
 * 两边各写一份键位，改一处忘一处就会悄悄不一致 ——
 * 而"设置里写着这个键、按下去没反应"是最难发现的一类错
 * （用户会以为自己按错了，不会想到是文档错）。
 *
 * 这里只放**描述**（combo + 说明），执行仍归各自外壳：
 * 强行把两边执行逻辑统一成一张分派表，要动的是正在工作的代码，
 * 风险比收益大。表与两边的一致性由 settings-test 钉住 ——
 * 两个外壳里出现的键必须都能在表里查到。
 *
 * 设置页直接 import 本模块即可，**不需要桥接**：
 * 它是同页插件，与外壳同一个文档，不存在跨文档取不到的问题。
 */

/** macOS 上 mod = ⌘，其它平台 = Ctrl */
export function isMac() {
  try {
    return /mac|iphone|ipad/i.test(navigator?.platform || navigator?.userAgent || '');
  } catch {
    return false;
  }
}

/**
 * 外壳快捷键。
 *
 * combo 用 `mod+` 前缀（与 plugin-sdk 的 SHELL_SHORTCUTS 同一写法），
 * keys 是给用户看的展示串 —— 不写 `mod`，直接给出 ⌘/Ctrl 两种可能。
 */
export const SHELL_SHORTCUT_SPECS = [
  { combo: 'mod+b', keys: '⌘/Ctrl + B', desc: '收起 / 展开侧边栏' },
  { combo: 'mod+r', keys: '⌘/Ctrl + R', desc: '重载当前插件' },
  { combo: 'mod+,', keys: '⌘/Ctrl + ,', desc: '打开当前插件的设置' },
  {
    combo: 'mod+`',
    keys: '⌘/Ctrl + `',
    desc: '隐藏到托盘（点托盘图标唤回）',
    /* React 外壳下 ` 与 ~ 同键位都认（同一物理键，Shift 状态不同），
       原生外壳只认 `。列出来免得用户按了 ~ 没反应以为是坏了。 */
    alias: 'mod+~',
  },
  {
    combo: 'ctrl+shift+d',
    keys: '⌘/Ctrl + Shift + D',
    desc: '元素检查器（开发者模式）',
    /* 由 js/inspector.js 自己装，不在两个外壳的命令表里 ——
       但它确实是一个外壳级快捷键，用户要知道。 */
  },
];

/**
 * 把 combo 归一化成"需要的修饰键集合 + 主键"，用于撞车比较。
 *
 * 关键：`mod` 要**按当前平台展开**成 meta 或 ctrl。
 * 不展开的话，Windows 上插件注册 `Ctrl+B` 与外壳 `mod+B`
 * 会被判成两个不同的键 —— 而它们在那台机器上就是同一个键，
 * 撞车是真实发生的，只是没人报出来。
 *
 * @returns {string} 形如 'ctrl+b' / 'meta+b' / 'ctrl+shift+k'
 */
export function normCombo(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((x) => x.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => (p === 'mod' ? (isMac() ? 'meta' : 'ctrl') : p)));
  return [...mods].sort().concat(key).join('+');
}

/** 外壳快捷键的归一化集合，供设置页做撞车判断 */
export function shellComboSet() {
  const s = new Set();
  for (const x of SHELL_SHORTCUT_SPECS) {
    s.add(normCombo(x.combo));
    if (x.alias) s.add(normCombo(x.alias));
  }
  return s;
}
