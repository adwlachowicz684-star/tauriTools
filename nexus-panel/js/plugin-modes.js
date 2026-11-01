/**
 * 插件模式（module / iframe）的解析
 * ============================================================
 * 为什么要有这个文件
 * ------------------------------------------------------------
 * 静态准入扫描会把 `window.xxx =` / `document.body.appendChild` 报成
 * "污染宿主"（黄区 review）。但这个判定**取决于插件跑在哪里**：
 *
 *   · 同页（module）—— 与宿主**同文档**，污染的是主文档，卸载带不走
 *     → 这才是真残留，必须报
 *   · 沙箱（iframe）—— 它自己的 window / body，随 iframe.remove() 消失
 *     → **根本不污染宿主**，报了就是误报
 *
 * 第一版扫描器不区分模式，于是把 14 条 iframe 插件内部的正常写法
 * 全报成 review。噪音淹没队列，等于没有队列（与"动态调用规则太宽
 * 一次扫出 23 条"是同一类教训）。
 *
 * 所以：扫描器必须先知道每个插件跑在什么模式。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/**
 * 从 registry.js 源码里解析每个插件的模式。
 *
 * 用**正则解析源码**而不是 import registry.js ——
 * 后者在 Node 里跑不起来（它引用 `globalThis.__NEXUS_NO_BUILD__`、
 * 而且是给浏览器用的 ESM，还可能带 TS/JSX 依赖）。
 *
 * @returns {Map<string, {module: boolean, iframe: boolean}>}
 *          module / iframe 表示该插件**是否可能**跑在这个模式下
 */
export function parsePluginModes(registryPath = path.join(ROOT, 'plugins/registry.js')) {
  const out = new Map();
  let src;
  try {
    src = fs.readFileSync(registryPath, 'utf8');
  } catch {
    return out;
  }

  /*
   * 按顶层条目切块：每个 `{ id: 'xxx', ... }` 到下一个同级 `{` 为止。
   * 用简单的括号配平来定位条目边界，比按行猜要稳。
   */
  const blockRe = /\{\s*id:\s*'([^']+)'/g;
  const starts = [...src.matchAll(blockRe)].map((m) => ({ id: m[1], at: m.index }));

  for (let i = 0; i < starts.length; i += 1) {
    const { id, at } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
    const block = src.slice(at, end);

    /*
     * 两种写法：
     *   type: 'module'                          —— 常量，两种模式都一样
     *   type: noBuild ? 'module' : 'iframe'     —— 三元，随模式切换
     */
    const tri = block.match(/type:\s*noBuild\s*\?\s*'(\w+)'\s*:\s*'(\w+)'/);
    const konst = block.match(/type:\s*'(\w+)'/);

    let modes;
    if (tri) {
      /*
       * `noBuild ? A : B`：A 是无构建下的模式，B 是构建下的模式，
       * **两者都会真实发生**（取决于运行方式）。所以某个模式只要在
       * 任一支出现过，它就是"可能"的。
       *
       * ⛔ 不能写成 { module: A === 'module', iframe: B === 'iframe' } ——
       * 那等于**假设了 A/B 的顺序**。真写成
       * `type: noBuild ? 'iframe' : 'module'` 时两项同时为 false，
       * 于是该插件的全部污染检查被跳过、而扫描报告照常显示"干净"。
       * 这是**漏报**：比误报危险得多，且无任何提示。
       * （当前 registry.js 全是常量写法，三元分支尚未触发 ——
       *   所以这个洞现在看不出来，只能靠下面的断言钉住。）
       */
      const vals = [tri[1], tri[2]];
      modes = { module: vals.includes('module'), iframe: vals.includes('iframe') };
    } else if (konst) {
      const v = konst[1];
      modes = { module: v === 'module', iframe: v === 'iframe' };
    } else {
      continue;   // 没有 type 字段，不猜
    }
    out.set(id, modes);
  }
  return out;
}

/**
 * 从文件路径推出插件 id。
 *
 * `plugins/<id>/...` → id；不在 plugins/ 下的返回 null。
 */
export function pluginIdFromPath(relPath) {
  const m = String(relPath).replace(/\\/g, '/').match(/^plugins\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * 该插件是否**可能**跑在同页（module）模式。
 *
 * 取"可能"而不是"必然"：三元写法 `noBuild ? 'module' : 'iframe'`
 * 意味着无构建下是 module —— 那种模式下确实会污染宿主，
 * 所以必须报。**宁可多报一条，不可漏掉真残留。**
 */
export function mayRunAsModule(id, modes = parsePluginModes()) {
  const m = modes.get(id);
  if (!m) return true;    // 未知插件：保守按"可能"处理
  /*
   * 两个都 false = 解析失手（第三种模式名、写法变了、或三元判据没跟上）。
   * 此时**不能**返回 false —— 那会让该插件的全部污染检查被静默跳过，
   * 报告却显示干净。宁可多报一条噪音，不可漏掉真残留。
   */
  if (m.module !== true && m.iframe !== true) return true;
  return m.module === true;
}

/** 诊断用：列出各插件的模式 */
export function describeModes(modes = parsePluginModes()) {
  return [...modes.entries()]
    .map(([id, m]) => `${id}: ${[m.module && 'module', m.iframe && 'iframe'].filter(Boolean).join(' | ')}`)
    .sort();
}
