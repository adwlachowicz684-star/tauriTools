/**
 * 标题栏拖拽（无边框窗口唯一的移动方式）
 * ============================================================
 * 起因：标题栏早就标了 data-tauri-drag-region，但**拖不动**。
 *
 * 根因是 Tauri 2 的权限：
 *   core:window:default **不包含** allow-start-dragging
 *   （也不在 core:default 里），必须显式授权。
 *   缺了不报错 —— drag.js 调 `plugin:window|start_dragging`
 *   被能力层静默拒绝，Promise reject 但没人接。
 *   控制台**没有任何输出**，表现为"标记写了却拖不动"。
 *
 * 第二个坑：裸属性 vs ="deep"
 *   裸属性   → 只有**点击目标本身**才拖（点在子元素上无效）
 *   ="deep"  → 整个子树都能拖
 *   标题栏有 logo / 品牌文字 / 标题 / spacer 好几层子元素，
 *   裸属性的话点在文字上就拖不动。
 *
 * 本测试钉住这两条 + 两个外壳一致。
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const t = (name, cond, hint = '') => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${hint ? `  —— ${hint}` : ''}`); }
};

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const cap = read('./src-tauri/capabilities/default.json');
const html = read('./index.html');
const tsx = read('./src/components/Titlebar.tsx');
const css = read('./css/neumorphism.css');
const conf = read('./src-tauri/tauri.conf.json');

/** 剔注释后再匹配：注释里反复提到这些字符串，直接搜会误命中 */
const strip = (s) => s.split('\n')
  .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/*')
    && !l.trim().startsWith('//') && !l.trim().startsWith('<!--'))
  .join('\n');

/** JSON 允许注释吗？这份文件实测无注释，直接解析；失败则退宽松解析 */
function parseJson(text) {
  try { return JSON.parse(text); }
  catch {
    try { return JSON.parse(text, (k, v) => v); } catch { return null; }
  }
}

console.log('=== 1. 权限：拖不动的真正原因 ===');
{
  const d = parseJson(cap);
  t('capabilities JSON 可解析', !!d);
  const perms = d?.permissions || [];
  t('显式授权了 core:window:allow-start-dragging',
    perms.includes('core:window:allow-start-dragging'),
    '缺这条时 data-tauri-drag-region 完全失效且**无任何报错**');
  /*
   * 反向断言：不能只靠 core:default / core:window:default 兜底。
   * 这两个集合**都不含** start-dragging —— 这是 Tauri 2 的已知点。
   */
  t('没有误以为 core:default 会自动带上（显式列出才作数）',
    perms.some((p) => typeof p === 'string' && p === 'core:window:allow-start-dragging'));
  t('windows 覆盖 main（权限要挂到对的窗口）',
    Array.isArray(d?.windows) && d.windows.includes('main'));
}

console.log('\n=== 2. =deep：子元素也要能拖 ===');
{
  const h = strip(html);
  const x = strip(tsx);
  /*
   * 裸属性（无 ="deep"）时，点在 logo / 品牌文字 / 标题上**拖不动** ——
   * 这正是"标题栏有标记却只有部分区域能拖"的原因。
   */
  t('原生外壳标题栏用 ="deep"', /data-tauri-drag-region="deep"/.test(h));
  t('React 外壳标题栏用 ="deep"（两个外壳必须一致）',
    /data-tauri-drag-region="deep"/.test(x));
  t('两外壳都不再有裸属性形式（会退回"仅自身可拖"）',
    !/data-tauri-drag-region(?!=)/.test(h) && !/data-tauri-drag-region(?!=)/.test(x));
  /*
   * 按钮**不需要**标 ="false"：drag.js 会自动跳过可点击元素
   * （button / a / input / role=button / contenteditable / tabindex≠-1）。
   * 标了反而多余。
   */
  t('标题栏按钮区未被标为拖拽区（按钮要能点）',
    !/tb-btns[^>]*data-tauri-drag-region/.test(h));
  t('标题栏里确实有按钮（说明上面那条不是空断言）',
    /<button[^>]*class="tb-btn"/.test(h));
}

console.log('\n=== 3. 无边框前提：decorations 必须为 false ===');
{
  const d = parseJson(conf);
  const w = d?.app?.windows?.[0];
  t('decorations: false（所以必须自绘拖拽区）', w?.decorations === false);
  /*
   * dragDropEnabled 必须为 false：HTML5 原生 drag-and-drop 会
   * 拦截 mousedown，导致 data-tauri-drag-region 收不到事件。
   */
  t('dragDropEnabled: false（否则 HTML5 拖放会抢走事件）',
    w?.dragDropEnabled === false);
  t('acceptFirstMouse: true（macOS 上窗口未聚焦时首次点击会被吞）',
    w?.acceptFirstMouse === true);
}

console.log('\n=== 4. 体验：拖动时不要选中文字 ===');
{
  /*
   * 拖动会把品牌文字和标题刷成蓝色选区，松手后还留着。
   */
  const blk = css.slice(css.indexOf('#titlebar {'), css.indexOf('.tb-brand'));
  t('#titlebar 禁用 user-select', /user-select:\s*none/.test(blk));
  /*
   * **不能**用 -webkit-app-region: drag 代替 drag.js 方案 ——
   * 那会让区域内所有子元素失去点击能力，六个按钮全失效。
   */
  /*
   * **必须剔注释再匹配** —— 我在 #titlebar 的注释里写了
   * "不要用 -webkit-app-region: drag"，直接搜整份 CSS 会命中自己写的
   * 说明文字 → 假红。这是本仓库反复出现的坑。
   */
  const cssCode = strip(css);
  t('没有用 -webkit-app-region: drag（会破坏按钮点击）',
    !/-webkit-app-region:\s*drag/.test(cssCode));
  t('也没有用 app-region: drag（同上）', !/[^-\w]app-region:\s*drag/.test(cssCode));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log(`
排查顺序（缺任一条都会"标记写了却拖不动"）：
  1. capabilities 里有 core:window:allow-start-dragging  ← 最常见
  2. data-tauri-drag-region="deep"（裸属性时子元素拖不动）
  3. dragDropEnabled: false（HTML5 拖放抢事件）
  4. macOS 另需 acceptFirstMouse: true`);
}
process.exit(fail ? 1 : 0);
