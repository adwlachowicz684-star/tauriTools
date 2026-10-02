import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

/* ================================================================ */
/* 面板三件套的优先级：写了却不渲染的三种组合                        */
/* ================================================================ */

/*
 * inspectorOf 的判定是**短路**的：
 *
 *   if (def.Inspector) return def.Inspector;          ← fields 到此为止
 *   if (def.fields)   return makeInspector(fields, panelFooter);
 *   return EmptyInspector;                            ← panelFooter 到此为止
 *
 * 于是两种组合是"写了却不渲染"，而且都不报错：
 *
 *  1. 同时给 Inspector 与 fields —— fields 被完全忽略。
 *     更糟的是**参数文档仍按 def.fields 生成**：文档说这个节点有这些参数，
 *     界面上一个都不显示。这是"文档与界面对不上"里最难查的一种。
 *
 *  2. 只给 panelFooter 不给 fields —— 走进 EmptyInspector 分支，
 *     footer 永远不出现（那正是"试跑一下"这类按钮挂的地方）。
 *
 * 目前两种组合都不存在（45 个 def 逐个扫过），但没有任何东西拦着它们长出来。
 */
const DEFS_DIR = 'nodes/defs';

function defFiles(): string[] {
  return readdirSync(join(SRC!, DEFS_DIR)).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

/** 认 `fields:` 与 `fields,` 两种写法 —— 少认简写会把 def 判成"没有字段" */
function hasProp(src: string, prop: string): boolean {
  const s = stripComments(src).replace(/^\s*\/\/.*$/gm, '');
  return new RegExp(`\\b${prop}\\s*[:,]`).test(s);
}

test('def 不得同时给 Inspector 与 fields（fields 会被整个忽略）', () => {
  const bad = defFiles().filter((f) => {
    const s = readFileSync(join(SRC!, DEFS_DIR, f), 'utf8');
    return hasProp(s, 'Inspector') && hasProp(s, 'fields');
  });
  assert.deepEqual(
    bad, [],
    `这些 def 同时给了 Inspector 与 fields —— inspectorOf 会直接返回 Inspector，fields 一个都不渲染，` +
      `而参数文档仍按 fields 生成，于是"文档说有、界面没有"：${bad.join('、')}`,
  );
});

test('def 给了 panelFooter 就必须也给 fields（否则 footer 永远不渲染）', () => {
  const bad = defFiles().filter((f) => {
    const s = readFileSync(join(SRC!, DEFS_DIR, f), 'utf8');
    return hasProp(s, 'panelFooter') && !hasProp(s, 'fields');
  });
  assert.deepEqual(
    bad, [],
    `这些 def 只给了 panelFooter —— 没有 fields 时 inspectorOf 走 EmptyInspector 分支，` +
      `footer 永远显示不出来：${bad.join('、')}`,
  );
});

test('def 至少要有 fields 或 Inspector（否则面板只有一句「还没有配置面板」）', () => {
  const bad = defFiles().filter((f) => {
    const s = readFileSync(join(SRC!, DEFS_DIR, f), 'utf8');
    if (!s.includes('registerNode(')) return false; // 字段库等不是 def
    return !hasProp(s, 'fields') && !hasProp(s, 'Inspector');
  });
  assert.deepEqual(bad, [], `这些 def 既无 fields 也无 Inspector：${bad.join('、')}`);
});
