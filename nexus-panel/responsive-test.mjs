/**
 * 小窗口下的挤压问题。
 *
 * 两类症状，两个不同的根因 —— 分开测，避免"改了一个以为都好了"：
 *
 *   看不见右边 = 横向 flex 容器不能换行、子项 min-width:auto 不收缩，
 *                后面的兄弟被挤出容器
 *   看不见下面 = 纵向 flex 滚动区缺 min-height:0，被内容顶开导致
 *                overflow:auto 失效
 *
 * 窗口最小 940×620（tauri.conf.json），但插件感知的是 iframe 宽度：
 *   940 − 侧边栏 218(展开) − padding 36 = 686px
 */
import { readFileSync } from 'node:fs';

let pass = 0; const fails = [];
const t = (name, cond, extra = '') => {
  cond ? pass++ : fails.push(`${name}${extra ? ' → ' + extra : ''}`);
};
const read = (p) => readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const shell = strip(read('css/neumorphism.css'));
const dialog = strip(read('css/dialog.css'));
const af = strip(read('plugins/agent-flow/styles.css'));
const mm = strip(read('plugins/mindmap/styles.css'));
const pg = strip(read('plugins/project-group/style.css'));

/** 取一个选择器的规则体 */
const bodyOf = (css, sel) => {
  const m = css.match(new RegExp('(^|[}\\n])\\s*' + sel.replace(/[.[\]]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  return m ? m[2] : '';
};

console.log('=== 1. 规范存在 ===');
t('外壳写明了响应式断点规范（含宽度换算）',
  /响应式断点/.test(read('css/neumorphism.css')) && /686/.test(read('css/neumorphism.css')));

console.log('=== 2. 横向：容器能换行或子项可收缩 ===');
/* agent-flow .toolbar 有 11 个按钮 + 1 下拉 ≈ 920px，
   而窗口最小时 iframe 只有 686px —— 不换行必然挤出右边。 */
const tb = bodyOf(af, '.toolbar');
t('agent-flow 工具栏能换行（11 个按钮放不下 686px）',
  /flex-wrap:\s*wrap/.test(tb));
t('换行后行间距不会挤在一起', /row-gap/.test(tb));

/* 主面板 plugin-bar：标题省略，操作区不被挤出去 */
const bar = bodyOf(shell, '#plugin-bar h1');
t('plugin-bar 标题可收缩', /min-width:\s*0/.test(bar));
t('plugin-bar 标题超长时省略', /text-overflow:\s*ellipsis/.test(bar));
t('plugin-bar 操作区不参与收缩（按钮压扁比标题省略更难用）',
  /flex:\s*none/.test(bodyOf(shell, '.bar-actions')));

/* 弹窗底部：按钮可能很多（确定/取消/自定义） */
t('弹窗底部按钮可换行', /flex-wrap:\s*wrap/.test(bodyOf(dialog, '.nx-dlg-foot')));

console.log('=== 3. 纵向：滚动区必须写 min-height: 0 ===');
/* min-height:auto 会让滚动区被内容顶开、overflow 失效 ——
   表现是"下面的内容看不见，且滚不动"。 */
for (const [css, sel, label] of [
  [shell, '#plugin-list', '侧边栏插件列表'],
  /* `.sidebar` 是重构前的节点库外壳，后来三个库（节点/模块/画布）
     共用 `.side-pane` + `.side-body`（见 styles.css 里那段长注释），
     旧类名已不存在 —— 断言指着一个查无此类的选择器会**永远红**，
     而实际代码 `.side-body` 早就写了 min-height:0。
     重构换类名时这里漏改，属"改了代码没同步守卫"。 */
  [af, '.side-body', 'agent-flow 侧栏滚动区'],
  [mm, '.mm-icon-side', '脑图图标栏'],
  [mm, '.mm-list', '脑图列表'],
  [mm, '.mm-files', '脑图文件列表'],
]) {
  t(`${label} 滚动区写了 min-height:0`, /min-height:\s*0/.test(bodyOf(css, sel)));
}

console.log('=== 4. 断点存在且合理 ===');
/* 断点按 iframe 宽度定：窗口 940 → iframe 约 686~818 */
for (const [css, label, min] of [
  [af, 'agent-flow', 1], [mm, 'mindmap', 1], [pg, 'project-group', 1],
]) {
  const n = (css.match(/@media[^{]*max-width/g) || []).length;
  t(`${label} 有窄屏断点`, n >= min, `实际 ${n} 个`);
}
/* 断点值应落在 iframe 宽度区间内，而不是照抄窗口宽度 */
const afBreaks = [...af.matchAll(/max-width:\s*(\d+)px/g)].map((m) => +m[1]);
t('断点按 iframe 宽度定（≤1200）', afBreaks.every((v) => v <= 1200), afBreaks.join(','));

console.log('=== 5. 极窄档：把宽度让给主内容 ===');
/* 画布 / 主内容比侧栏更需要空间 */
t('agent-flow 极窄时收窄节点库侧栏',
  /max-width:\s*8\d\dpx[\s\S]{0,200}--af-side-w/.test(af)
  || /--af-side-w:\s*2\d\dpx/.test(af));
t('mindmap 极窄时收窄侧栏', /max-width:\s*\d+px[\s\S]{0,200}\.mm-side/.test(mm));

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) { fails.forEach((f) => console.log('  ❌ ' + f)); process.exit(1); }
