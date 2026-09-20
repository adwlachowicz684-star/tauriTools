import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 节点库「显示说明」开关。
 *
 * ================= 要什么 ====================
 *
 * 标题右侧一个「显示说明」按钮，点一下 **所有** 节点下面各铺一行说明，
 * 再点收起。不需要展开完整说明块，只要那一句话。
 *
 * ================= 守卫什么 ====================
 *
 * ① 按钮存在，且能切两个态（显示 / 隐藏）
 * ② 简版说明与"点开单条"的完整说明 **不叠加**
 *    同一条同时铺两遍说明，看着像渲染重复，很难联想到是条件漏了
 * ③ 每条节点用自己的 type 取说明
 *    以前写 `getDef(g.presets[0].type)` —— 用分组**第一条**的，
 *    于是同组里没有 hint 的预设会显示别人的说明。
 *    说明张冠李戴，而它看起来完全正常，是最难发现的那一类。
 * ④ .side-desc-brief 有定义（否则那行是裸文本，字号颜色走浏览器默认）
 */

const ROOT = process.env.AF_SRC ?? path.resolve(__dirname, '..');
const SB = path.join(ROOT, 'components/Sidebar.tsx');

/** 剥注释 —— 注释里为说明"以前错在哪"会把旧写法原样写出来，不剥会假阴性 */
function strip(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, '');
}

function sidebar(): string {
  return strip(fs.readFileSync(SB, 'utf-8'));
}

test('有「显示说明」按钮，且能切两个态', () => {
  const t = sidebar();
  assert.match(t, /setShowAllDesc/, '没有 showAllDesc 状态');
  // 按钮文案要能看出当前是开还是关 —— 只写"说明"的话点了不知道生效没有
  assert.match(t, /showAllDesc \? '隐藏说明' : '显示说明'/);
  // 开着时按钮自己也要变样：否则几十条说明铺开了，按钮却还是老样子
  assert.match(t, /side-head-btn'\s*\+\s*\(showAllDesc \? ' is-on' : ''\)/);
});

test('简版说明不与完整说明叠加', () => {
  /*
   * 点开的那条已经有 NodeDesc 完整版，再铺一行简版就是重复。
   * 条件是 `!open && showAllDesc`。
   */
  const t = sidebar();
  assert.match(
    t,
    /!open\s*&&\s*showAllDesc/,
    '简版说明要排掉"已展开"的那一条，否则同一条铺两遍说明',
  );
});

test('每条节点用自己的 type 取说明', () => {
  const t = sidebar();
  /*
   * 这是当初那个 bug 的直接位置。
   * 不剥注释的话，注释里那句"以前写的是 def（= g.presets[0].type…）"
   * 会让检查永远通过 —— 是假阴性。
   */
  assert.ok(
    !/getDef\(g\.presets\[0\]\.type\)/.test(t),
    '不该用分组第一条节点的 def 取说明 —— 同组里会显示错的说明',
  );
  assert.match(t, /getDef\(p\.type\)/, '每条预设要按自己的 type 取 def');
});

test('MCP 工具也跟着「显示说明」', () => {
  /*
   * MCP 是独立子组件，props 得透传下去。
   * 漏传的话：内置节点有说明、MCP 工具没有 ——
   * 看着像"MCP 工具本来就没说明"，实际是漏传。
   */
  const t = sidebar();
  assert.match(t, /showAllDesc=\{showAllDesc\}/);
});

test('.side-desc-brief 在 styles.css 里有定义', () => {
  const css = strip(fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf-8'));
  const m = css.match(/\.side-desc-brief\s*\{[^}]*\}/);
  assert.ok(m, '.side-desc-brief 没定义 —— 那行会是裸文本');
  // 全部铺开时不能每条都带左边条和色块，会很吵
  assert.ok(!/border-left/.test(m[0]), '简版说明不该有左边条');
  assert.match(m[0], /white-space:\s*nowrap/, '简版说明要单行截断');
});
