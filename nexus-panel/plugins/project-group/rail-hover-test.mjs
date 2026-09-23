/**
 * #58 侧边栏悬停浮出模式（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/rail-hover-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const rail = R('components/SideRail.tsx');
const css = R('style.css');
const app = R('App.tsx');

console.log('\n=== 1. 两种模式 ===');
{
  t('有 RailMode 类型', /export type RailMode = 'persistent' \| 'hover';/.test(rail));
  t('有 mode prop', /mode\?: RailMode;/.test(rail));
  t('有 onModeChange', /onModeChange\?: \(\) => void;/.test(rail));
}

console.log('\n=== 2. 浮出必须"覆盖"而非"挤开" ===');
{
  /*
   * 栏宽若跟着悬停变化，三栏会被推着左右跳，且会与布局记忆（colStars）打架 ——
   * 用户拖好的比例每次鼠标划过都被扰乱。所以外层 slot 固定窄宽、内层溢出。
   */
  t('有 slot 外层', /\.fpx-rail-slot \{/.test(css));
  /*
   * 必须**按块**取，不能写 `{...}[\s\S]{0,120}?` ——
   * 后一个字符数会滑进下一条规则（`.fpx-rail-slot.hover-mode .fpx-rail`
   * 里也有同样的 width），于是删掉 slot 的宽度后断言照样通过（漏报）。
   */
  const slotBlock = (() => {
    const i = css.indexOf('.fpx-rail-slot.hover-mode {');
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  })();
  t('slot 固定窄宽', /width: 40px; min-width: 40px;/.test(slotBlock));
  t('slot 用 flex 基宽', /flex: 0 0 40px;/.test(css));
  /* 内层栏在正常流内（保留高度），靠宽度溢出画到 slot 之外 */
  t('内层窄态 40px', /\.fpx-rail-slot\.hover-mode \.fpx-rail \{[\s\S]{0,120}?width: 40px/.test(css));
  t('浮出变 max-content', /width: max-content;/.test(css));
  /* 上限必须有：连锁动作名可以很长，不限会盖掉半个屏幕 */
  t('有最大宽度上限', /max-width: 180px;/.test(css));
  /* slot 不能裁剪，否则浮出部分被切掉 */
  t('slot 不裁剪', /\.fpx-rail-slot \{[\s\S]{0,200}?overflow: visible;/.test(css));
  /* 浮出要压在内容之上 */
  /*
   * 上游把写死的 30 换成了 var(--z-rail, 30)（走主题变量）。
   * 真正要钉的是"浮出时 z-index 高于内容"，不是具体写法 ——
   * 钉死字面量会在上游改用变量后**误报**，误报多了就会被当噪音忽略。
   */
  t('浮出抬高 z-index', /z-index:\s*(?:30|var\(--z-rail,\s*30\))\s*;/.test(css));
}

console.log('\n=== 3. 键盘也要能浮出（:focus-within）===');
{
  /* 少了它，Tab 到某个按钮时文字仍是隐藏的，键盘用户看不出自己在按什么 */
  t('hover 触发', /\.fpx-rail-slot\.hover-mode:hover \.fpx-rail,/.test(css));
  t('focus-within 触发', /\.fpx-rail-slot\.hover-mode:focus-within \.fpx-rail \{/.test(css));
  t('label 两种都显示', /:hover \.fpx-rail-label,[\s\S]{0,120}?:focus-within \.fpx-rail-label/.test(css));
  t('key 两种都显示', /:focus-within \.fpx-rail-key \{ display: block; \}/.test(css));
  t('窄态隐藏文字', /\.fpx-rail-slot\.hover-mode \.fpx-rail-label,[\s\S]{0,120}?display: none;/.test(css));
}

console.log('\n=== 4. 模式切换入口 ===');
{
  /* 悬停模式下文字是隐藏的，没有 title 就只剩一个看不懂的图标 */
  t('有切换按钮', /onClick=\{onModeChange\}/.test(rail));
  t('给了 title 提示', /title=\{mode === 'hover'/.test(rail));
  t('悬停态提示改常驻', /'左栏改为常驻/.test(rail));
  t('常驻态提示改悬停', /'左栏改为悬停浮出/.test(rail));
  /* 与「收起」并列：两个入口都管"左栏占多少地方" */
  t('与收起同组', /title="收起左操作栏[\s\S]{0,600}?onModeChange/.test(rail));
}

console.log('\n=== 5. 收起态也要有 slot ===');
{
  /* slot 是 flex 子项、宽度由它决定；直接让 rail 当子项会随内容变宽 */
  t('收起分支有 slot', /className="fpx-rail-slot">\s*<div className="fpx-rail collapsed">/.test(rail));
}

console.log('\n=== 6. App 接线 ===');
{
  t('引入 RailMode', /import \{ SideRail, type RailMode \} from '\.\/components\/SideRail';/.test(app));
  t('有 railMode state', /useState<RailMode>\('persistent'\)/.test(app));
  t('传了 mode', /mode=\{railMode\}/.test(app));
  t('切换两种模式', /setRailMode\(\(v\) => \(v === 'hover' \? 'persistent' : 'hover'\)\)/.test(app));
}

console.log('\n=== 7. 结构：JSX 嵌套层级 ===');
{
  /* slot 包 rail：直接改 rail 宽度会挤开三栏，所以必须多这一层 */
  const i = rail.indexOf('<div className={`fpx-rail-slot');
  const j = rail.indexOf('<div className="fpx-rail">', i);
  const k = rail.indexOf('</div>\n    </div>', j);
  t('slot 在 rail 之外', i < j && j > 0);
  t('两层都闭合', k > j);
}

done();
