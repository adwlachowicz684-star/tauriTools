import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 守卫："属性面板组件引用必须稳定"。
 *
 * 管的是这个 bug：点开 CLI 节点的下拉框刚展开就关、输入框点一下光标就没。
 * 看着像失焦，实际是**组件在每次重渲染时被卸载重建** ——
 * React 用 `===` 比较元素类型，类型引用一变就把整棵子树销毁重挂，
 * 于是 <input> 失去光标、<select> 被合上、子树里的 useState 全被重置。
 *
 * 两个成因都在这份测试里盯着：
 *   1. makeInspector 每次返回一个新的函数组件（已修：加了缓存表）
 *   2. 字段 key 用 Math.random() 生成（已修：改用字段原始下标兜底）
 *
 * 为什么是源码级检查而不是直接 import 组件测引用相等：
 * 这两个文件都是 .tsx，含 JSX，而本项目的测试链路（scripts/strip-ts.py）
 * 只做类型剥离、不转 JSX，Node 加载不了。真要测行为得上 esbuild/tsx，
 * 为两条断言引一条构建链不划算。这里退而求其次盯源码形态 ——
 * 若哪天换了实现方式（比如改用 useMemo），请连同本测试一起更新。
 */
const SRC = process.env.AF_SRC;

/**
 * 去掉块注释再检查。
 *
 * 必须剥：下面几个断言匹配的是"坏的写法"，而注释里为了说明这个坑，
 * 恰好要把坏写法原样写出来（ `key={f.key ?? Math.random()}` ）。
 * 不剥注释的话，注释本身就是一条永久的假阳性 —— 反过来会逼人为了过测试
 * 去改写说明，那是本末倒置。
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

function read(rel: string): string {
  assert.ok(SRC, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
  return stripComments(readFileSync(join(SRC, rel), 'utf8'));
}

test('字段 key 不得用 Math.random() 生成（会每次重建 DOM，输入框失焦）', () => {
  const src = read('components/inspectors/fields.tsx');
  const bad = src.match(/key=\{[^}]*Math\.random\(\)/);
  assert.equal(
    bad,
    null,
    'key 里出现了 Math.random()：每次渲染都是新 key，React 会销毁重建该元素。' +
      '没有 key 的字段请用其在清单里的原始下标兜底。',
  );
});

test('makeInspector 必须缓存组件（每次新建会让整个面板重挂载）', () => {
  const src = read('components/inspectors/fields.tsx');
  // 定位 makeInspector 的函数体，避免匹配到文件里别处的 .get/.set
  const at = src.indexOf('export function makeInspector');
  assert.ok(at > 0, '没找到 makeInspector');
  const body = src.slice(at, at + 1200);

  assert.match(
    body,
    /Cache\.get\(|cache\.get\(/,
    'makeInspector 没有查缓存：每次调用都会造一个新的函数组件，' +
      'Inspector.tsx 每次渲染都调它，于是面板反复重挂载、输入框失焦。',
  );
});

test('未注册节点的兜底定义必须缓存（否则画布卡片与面板同样会重挂载）', () => {
  const src = read('nodes/registry.tsx');
  assert.match(
    src,
    /const fallbacks\s*=\s*new Map/,
    '缺少 fallbacks 缓存表：getDef() 在渲染里被反复调用，未注册类型每次都新造一份 def，' +
      '其 Canvas/Inspector 也是新引用，导致组件反复重挂载。',
  );
});
