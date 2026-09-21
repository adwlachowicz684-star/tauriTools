import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 侧栏与画布要用**同一套**视觉语言表示"节点类型"。
 *
 * ================= 起因 ====================
 *
 * 画布上的节点卡片用**左边条**表示类型（`border-left: 4px` + 内联色），
 * 而侧栏里用一个**彩色圆球**（.side-dot）。
 *
 * 两套语言指同一件事，于是"看颜色认类型"这件本能的事失效了 ——
 * 用户每次都得先在脑子里换算一次："这个圆球 = 卡片上那条边"。
 * 更糟的是，圆球在侧栏里是"节点类型色"，在别处又可能是"状态"，
 * 同一个圆球形两种含义，误导就从这来的。
 *
 * 现在统一成边条：侧栏项 = 画布卡片的"极矮版"，只有标题行 + 左边条。
 *
 * ================= 守卫什么 ====================
 *
 * ① .side-dot 不得复活（圆球是另一套语言）
 * ② .side-item 必须留透明边条占位 —— 省掉的话，
 *    有色的项比无色的项窄 3px，整列文字对不齐
 * ③ 展开态不得再占左边条（那是类型色的位置）
 * ④ 每个侧栏项都要注入 borderLeftColor ——
 *    漏一个就是"那一项缺一块色条"，而它看着像渲染问题，很难联想到是漏传
 */

const ROOT = process.env.AF_SRC ?? path.resolve(__dirname, '..');
const CSS = path.join(ROOT, 'styles.css');

/** 剥注释 —— 注释里为说明"以前错在哪"会把旧写法原样写出来，不剥会假阴性 */
function strip(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, '');
}

function cssText(): string {
  return strip(fs.readFileSync(CSS, 'utf-8'));
}

/** 取某个选择器的规则块（到第一个 } 为止） */
function rule(css: string, selector: string): string {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `styles.css 里找不到 ${selector}`);
  return css.slice(at, css.indexOf('}', at) + 1);
}

test('.side-dot 不再被任何组件使用', () => {
  const files = [
    'components/Sidebar.tsx',
    'components/ModuleLibrary.tsx',
    'components/CanvasLibrary.tsx',
  ];
  for (const rel of files) {
    const t = strip(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
    assert.ok(!/side-dot/.test(t), `${rel} 还在用圆球表示颜色，应改为左边条`);
  }
});

test('.side-item 留了透明边条占位', () => {
  /*
   * 不是"有 border-left 就行"，要 transparent ——
   * 给个实色的话，没有注入颜色的项会显示成那个实色，看着像它有类型色。
   */
  const block = rule(cssText(), '.side-item {');
  assert.match(block, /border-left:\s*3px solid transparent/);
});

test('展开态不再占用左边条', () => {
  /*
   * 左边条现在是类型色。
   * 若 is-open 再写 border-left，展开时类型色就被展开色盖掉 ——
   * 一展开就认不出是哪种节点，正好是这个改动要解决的问题。
   */
  const block = rule(cssText(), '.side-item.is-open {');
  assert.ok(!/border-left/.test(block), 'is-open 不该再写 border-left');
  // 展开要靠别的标记，否则只剩背景、与 hover 分不清
  assert.match(block, /box-shadow|background/);
});

test('每个侧栏项都注入了 borderLeftColor', () => {
  const cases: { file: string; min: number }[] = [
    { file: 'components/Sidebar.tsx', min: 2 }, // 节点预设项 + MCP 工具项
    { file: 'components/ModuleLibrary.tsx', min: 1 },
  ];
  for (const c of cases) {
    const t = strip(fs.readFileSync(path.join(ROOT, c.file), 'utf-8'));
    const hits = t.match(/borderLeftColor:/g) ?? [];
    assert.ok(
      hits.length >= c.min,
      `${c.file} 只有 ${hits.length} 处 borderLeftColor，至少要 ${c.min} 处`,
    );
  }
});

/*
 * 这条防的是"新加一个侧栏项忘了传颜色" ——
 * 漏了不报错，只是那一项没有色条；
 * 而它看起来像渲染问题，很难联想到是这里漏传。
 */
test('每个 side-item 就近注入了颜色', () => {
  /*
   * 逐项检查而不是"总数相等" ——
   * 总数相等但配错位置（两个颜色都给了同一项）照样通过。
   */
  const t = strip(fs.readFileSync(path.join(ROOT, 'components/Sidebar.tsx'), 'utf-8'));
  let at = t.indexOf('side-item');
  let n = 0;
  while (at >= 0) {
    n += 1;
    // style 紧跟在 className 之后，取这一小段就够
    assert.ok(
      /borderLeftColor:/.test(t.slice(at, at + 300)),
      `第 ${n} 个 side-item 附近没有 borderLeftColor —— 那一项会缺一条色条`,
    );
    at = t.indexOf('side-item', at + 1);
  }
  assert.ok(n >= 2, '侧栏至少要有节点项与 MCP 工具项两类');
  // MCP 组标题也要有色（它是那一组工具的来源色）
  assert.match(t, /mcp-sec-title[\s\S]{0,400}?borderLeftColor:/);
});
