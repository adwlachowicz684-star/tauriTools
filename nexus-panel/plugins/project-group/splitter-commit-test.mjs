/**
 * 分隔条「松手落盘」读的必须是最新值（真跑 hook，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/splitter-commit-test.mjs
 *
 * 分隔条支持两种改法：**鼠标拖**与**键盘微调**（方向键 ±8 / Shift ±24）。
 * 两条路径对调用方的时序要求完全不同：
 *
 *   · 拖动：pointermove → 重渲染 → pointerup。onEnd 拿到的是**新**闭包。
 *   · 键盘：onDelta 与 onEnd 在**同一次事件里同步连着调**。
 *     setState 还没重渲染，onEnd 若读闭包里的当前值，拿到的是**调整前**的
 *     旧值 —— 于是"界面变了、落盘的还是旧值"，下次打开又回到原样，
 *     全程不报错。
 *
 * 三类受害者（同一个根因）：
 *   1. 三栏宽度   useLayoutMemory.onColResizeEnd 读闭包 colStars
 *   2. 日志高度   useLayoutMemory.onLogResizeEnd 读闭包 logHeight
 *   3. 浮层高度   ui.tsx / DialogsHub.tsx 的 onEnd 读闭包 dragH
 *
 * 第 3 类更糟：dragH 初值是 null，键盘微调时读到 null → 不提交 → 紧跟着
 * setDragH(null) 把高度弹回，**键盘调高度完全无效**（闪一下就回原样）。
 *
 * 这里用极简 React 替身**真跑** useLayoutMemory。文本断言只能证明"源码里有
 * colStarsRef 这几个字"，证明不了同步连调时读到的到底是新值还是旧值 ——
 * 而后者才是 bug 本身。替身必须**不在 setState 后重跑函数体**，
 * 那正是 React 事件处理里的真实行为（批处理、事件结束才重渲染）；
 * 若在这里顺手重渲染，bug 就被替身掩盖，断言永远绿。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeT, stripTS, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

/* ---------- 极简 React 替身 ----------
   只提供本 hook 用到的四个钩子。要点：
     · setState **不重跑函数体**（模拟 React 的批处理）；
     · useCallback 直接返回传入的 fn —— 单次渲染内等价，
       而"缓存旧闭包"正是要被复现的行为，替身不能替它抹平。 */
const REACT = path.join(os.tmpdir(), `.fake-react.splitter.${process.pid}.mjs`);
fs.writeFileSync(REACT, `
export function makeHost() {
  const state = [], refs = [], effects = [];
  let slot = 0;
  globalThis.__host = {
    begin() { slot = 0; },
    useState(init) {
      const i = slot++;
      if (!(i in state)) state[i] = (typeof init === 'function') ? init() : init;
      return [state[i], (v) => { state[i] = (typeof v === 'function') ? v(state[i]) : v; }];
    },
    useRef(init) {
      const i = slot++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) {
      const i = slot++;
      const prev = effects[i];
      const changed = !prev || !deps || !prev.deps ||
        deps.length !== prev.deps.length || deps.some((d, j) => d !== prev.deps[j]);
      if (changed) {
        if (prev && typeof prev.cleanup === 'function') prev.cleanup();
        effects[i] = { deps, cleanup: fn() };
      }
    },
    render(fn) { slot = 0; return fn(); },
  };
}
export const useState = (...a) => globalThis.__host.useState(...a);
export const useRef = (...a) => globalThis.__host.useRef(...a);
export const useCallback = (...a) => globalThis.__host.useCallback(...a);
export const useEffect = (...a) => globalThis.__host.useEffect(...a);
`);
const reactMod = await import(pathToFileURL(REACT).href);
reactMod.makeHost();

/* ---------- 布局工具用真身 ----------
   自己生成产物而不是用 loadTs：hook 代码里要写死这个文件的 URL，
   两边必须指向同一份，用 loadTs 拿不到它的路径。 */
const LAYOUT_OUT = path.join(os.tmpdir(), `.layout.${process.pid}.mjs`);
fs.writeFileSync(LAYOUT_OUT, stripTS(fs.readFileSync(path.join(HERE, 'utils', 'layout.ts'), 'utf8')));
const layout = await import(pathToFileURL(LAYOUT_OUT).href);

/* ---------- 把 hook 源码转成可 import 的 ESM ---------- */
const SRC = path.join(HERE, 'hooks', 'useLayoutMemory.ts');
const raw = fs.readFileSync(SRC, 'utf8');
/* 下面两条必须在 stripTS **之前**跑：
   stripTS 会把 `FpxConfig>` 当成泛型收尾删掉，先跑就轮不到我们了。 */
const pre = raw
  /* 解构参数的类型注解：`function useLayoutMemory({ s, config }: UseLayoutMemoryArgs) {`
     类型写在 `)` **之前**，stripTS 只处理写在 `)` 之后的返回值类型，
     会原样留下 → import 时 SyntaxError（括号平衡检查抓不到）。 */
  .replace(/\}\s*:\s*[A-Za-z_][\w.]*\s*\)/g, '})')
  /* 泛型参数注解 `(patch: Partial<FpxConfig>)`：stripTS 会留下半个 `<`
     → SyntaxError。整段注解直接去掉。 */
  .replace(/\((\w+)\s*:\s*[A-Za-z_]\w*<[^<>]*>\)/g, '($1)');
let code = stripTS(pre);
/* 先删掉全部 import（含 'react' 那句）再单独注入：顺序反了会把替身那句一起删掉 */
code = code.replace(/^import [^;]*from\s+'[^']+';\s*$/gm, '');
code = `import { useCallback, useEffect, useRef, useState } from '${pathToFileURL(REACT).href}';
import { clampLogHeight, clampPanelHeight, normalizeColStars, resizeColStars } from '${pathToFileURL(LAYOUT_OUT).href}';
const errText = (e) => String((e && e.message) ? e.message : e);
` + code;
/* 泛型调用的类型实参：`useRef<number[]>(...)` 会留下尖括号 → SyntaxError。
   必须配平尖括号深度（类型实参里常有嵌套），不能用 <[^<>]*>。 */
function dropCallGenerics(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<' && /\w/.test(s[i - 1] ?? '')) {
      let d = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === '<') d++;
        else if (s[j] === '>') { d--; if (d === 0) break; }
      }
      if (d === 0 && s[j + 1] === '(') { i = j; continue; }
    }
    out += ch;
  }
  return out;
}
code = dropCallGenerics(code);
const OUT = path.join(os.tmpdir(), `.layoutmemory.${process.pid}.mjs`);
fs.writeFileSync(OUT, code);
const { useLayoutMemory } = await import(pathToFileURL(OUT).href);

/* ---------- 受控 store：记录每次落盘的 patch ---------- */
function makeStore() {
  const patches = [];
  const logs = [];
  const s = {
    updateConfig: async (mut) => {
      const d = {};
      mut(d);
      patches.push(d);
      return d;
    },
    pushLog: (m) => logs.push(m),
  };
  return { s, patches, logs };
}

function mount(config) {
  /* 必须每个用例都重置一套 state/refs：替身的 state 存在模块级数组里，
     不重置的话用例 4 会拿到用例 3 结束时的 logHeight（160）当初值，
     于是 160+20=180 —— 看着像"拖动路径写错"，其实是测试自己串了数据。 */
  reactMod.makeHost();
  const store = makeStore();
  const box = { h: null };
  const render = () => globalThis.__host.render(() => { box.h = useLayoutMemory({ s: store.s, config }); });
  render();
  /* colsRef 是 hook 内部的 ref，三栏总宽由测试给定 */
  box.h.colsRef.current = { getBoundingClientRect: () => ({ width: 900 }) };
  /* h 必须是 getter：rerender 之后要拿到**新**闭包，否则"拖动路径"用例
     用的还是第一次渲染的 onEnd —— 那测的就不是拖动路径了。
     （真 React 里 pointerup 拿到的就是重渲染后的新闭包。） */
  return {
    ...store,
    get h() { return box.h; },
    rerender: render,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const BASE_STARS = [1, 1, 1.4];

/* ================= 1. 三栏宽度：键盘路径（同步连调） ================= */
{
  const { patches, h } = mount({ colStars: BASE_STARS, logRowHeight: 140 });
  h.onColResize(0)(8);
  h.onColResizeEnd();          // 同一事件里紧接着调 —— 键盘路径的时序
  await flush();

  const expect = layout.resizeColStars(BASE_STARS, 0, 8, 900);
  t('键盘微调后落盘的是新值', patches.length === 1 && patches[0].colStars !== undefined
    && JSON.stringify(patches[0].colStars) === JSON.stringify(expect),
    JSON.stringify(patches[0]?.colStars));
  t('落盘值不是调整前的旧值',
    JSON.stringify(patches[0]?.colStars) !== JSON.stringify(BASE_STARS));
}

/* ================= 2. 连按能累加 ================= */
{
  const { patches, h } = mount({ colStars: BASE_STARS, logRowHeight: 140 });
  h.onColResize(0)(8); h.onColResizeEnd(); await flush();
  h.onColResize(0)(8); h.onColResizeEnd(); await flush();

  const a = patches[0]?.colStars, b = patches[1]?.colStars;
  t('连按两次：第二次比第一次更大（累加而非原地不动）',
    Array.isArray(a) && Array.isArray(b) && b[0] > a[0], `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  t('连按两次落盘两次', patches.length === 2);
}

/* ================= 3. 日志高度：键盘路径 ================= */
{
  const { patches, h } = mount({ colStars: BASE_STARS, logRowHeight: 140 });
  h.onLogResize(20);
  h.onLogResizeEnd();          // 同步连调
  await flush();
  t('日志高度键盘微调后落盘的是新值',
    patches.length === 1 && patches[0].logRowHeight === 160, String(patches[0]?.logRowHeight));
  t('日志高度不是调整前的旧值', patches[0]?.logRowHeight !== 140);
}

/* ================= 4. 拖动路径仍然正确（重渲染后再 onEnd） ================= */
{
  const ctx = mount({ colStars: BASE_STARS, logRowHeight: 140 });
  ctx.h.onLogResize(20);
  ctx.rerender();              // 模拟 pointermove 之后的重渲染
  ctx.h.onLogResizeEnd();
  await flush();
  t('拖动路径（重渲染后落盘）仍写新值',
    ctx.patches[0]?.logRowHeight === 160, String(ctx.patches[0]?.logRowHeight));
}

/* ================= 5. 外部改配置后，影子值与 state 同步 ================= */
{
  const { patches, h } = mount({ colStars: BASE_STARS, logRowHeight: 140 });
  h.onColResize(0)(8); h.onColResizeEnd(); await flush();
  /* 配置被外部改成别的：effect 会把 state 与影子值一起更新，
     否则下一次落盘会把"界面上已经不是这个值"的旧值写回去 */
  t('影子值随外部配置变化（源码里两处同步）', (() => {
    const src = fs.readFileSync(SRC, 'utf8');
    /* 不能用 indexOf('config?.colStars') 定位：第一处出现在 useState 的初始值里
       （`normalizeColStars(config?.colStars)`），切出来的段落不含 effect 里的赋值，
       断言于是恒假。直接钉"赋值紧贴着 setXxx"这个事实。 */
    return /colStarsRef\.current\s*=\s*next;\s*\n\s*setColStars\(next\);/.test(src)
      && /logHeightRef\.current\s*=\s*next;\s*\n\s*setLogHeight\(next\);/.test(src);
  })());
}

/* ================= 6. 落盘函数不再依赖闭包 state ================= */
{
  const src = fs.readFileSync(SRC, 'utf8');
  const i = src.indexOf('const onColResizeEnd');
  const seg = src.slice(i, i + 400);
  t('onColResizeEnd 依赖里不含 colStars（否则又会变成旧闭包）',
    /\}, \[saveLayout\]\);/.test(seg), seg.slice(seg.indexOf('}, [') , seg.indexOf('}, [') + 30));
  const k = src.indexOf('const onLogResizeEnd');
  const seg2 = src.slice(k, k + 400);
  t('onLogResizeEnd 依赖里不含 logHeight', /\}, \[saveLayout\]\);/.test(seg2));
}

/* ================= 7. 浮层高度：两处都要有影子值 ================= */
for (const f of ['components/ui.tsx', 'components/DialogsHub.tsx']) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  const i = src.indexOf('onHeightCommit && (');
  const seg = i < 0 ? '' : src.slice(i, i + 900);
  t(`${f}：拖高时同步写影子值`, /dragHRef\.current\s*=\s*v;/.test(seg));
  t(`${f}：提交时读影子值而非闭包里的 dragH`, /const next = dragHRef\.current;/.test(seg));
  t(`${f}：提交后清空影子值`, /dragHRef\.current\s*=\s*null;/.test(seg));
  /* 反面证据：一旦有人改回读闭包，上面三条仍可能因为别处的同名代码而通过 */
  t(`${f}：不再有 const next = dragH;`, !/const next = dragH;/.test(src));
}

/* ================= 8. Splitter：键盘路径的契约与卸载清理 ================= */
{
  const src = fs.readFileSync(path.join(HERE, 'components', 'Splitter.tsx'), 'utf8');
  const k = src.indexOf('onKeyDown');
  const seg = src.slice(k, k + 1400);
  t('Splitter：onDelta 后紧跟 onEnd（键盘路径同步连调）',
    /onDelta\(step\);\s*\n\s*onEnd\?\.\(\);/.test(seg));
  t('Splitter：有拖动标记 ref（卸载清理要用）', /const draggingRef = useRef\(false\);/.test(src));
  t('Splitter：pointerdown 同步置起该标记', /draggingRef\.current = true;/.test(src));
  t('Splitter：卸载时只在自己拖动中才摘 body 类',
    /useEffect\(\(\) => \(\) => \{\s*\n\s*if \(draggingRef\.current\) document\.body\.classList\.remove\('fpx-no-select'\);/.test(src));
  t('Splitter：stop 里同步清掉该标记', /setDragging\(false\);\s*\n\s*draggingRef\.current = false;/.test(src));
  /* 注释曾写"用 setPointerCapture"，而代码走的是 window 级监听 —— 注释承诺了
     代码没做的事，后来人照着去"补"反而会与 window 监听打架 */
  t('Splitter：不再声称用了 setPointerCapture（代码走 window 监听）',
    !/且 setPointerCapture 能保证/.test(src) && /window 级监听|window 监听/.test(src));
}

done();
