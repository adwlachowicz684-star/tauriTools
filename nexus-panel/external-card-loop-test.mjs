/**
 * 外链页签卡死（无限渲染循环）回归测试
 * ------------------------------------------------------------
 * 为什么不用"查源码里有没有某个字符串"来测：
 * 死循环是**运行时行为**，源码字符串匹配证明不了它会发生。
 * 这里把 ExternalCard.tsx 里的 useExternalApi / refresh / useEffect
 * 三段**原样抽出来**，用真实 React 渲染，直接数渲染次数。
 *
 * 抽取而不是手抄：手抄的版本一旦与源文件漂移，
 * 就会出现"测试绿、线上照样卡死"。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARD = path.join(HERE, 'plugins/settings/ExternalCard.tsx');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------------- DOM 环境 ---------------- */
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
/*
 * react-dom 会读 navigator / HTMLElement 等全局。
 * Node 20 里 navigator 根本不存在（Node 21+ 才有且是只读 getter），
 * 所以这里用 defineProperty 而不是赋值 —— 赋值在 21+ 会抛 TypeError。
 */
for (const k of ['navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  if (globalThis[k] === undefined && dom.window[k] !== undefined) {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  }
}

const React = (await import('react')).default ?? (await import('react'));
const { useState, useEffect, useCallback, useRef, useMemo, createElement } = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');

/* bridge 用**真实**的外链策略实现，保证 loadPolicy 每次返回新对象
   —— 这正是触发循环的前提（返回同一个对象的话 React 会 bail out）。 */
const pol = await import('./js/external-policy.js');
let loadCalls = 0;
const bridgeExternal = {
  load: async () => { loadCalls++; return pol.loadPolicy(); },
  list: async () => pol.listHosts(),
  save: async (p) => pol.savePolicy(p),
  setStatus: async (h, s) => pol.setHostStatus(h, s),
  remove: async (h) => pol.removeHost(h),
  suggestCsp: async () => pol.suggestCsp(pol.loadPolicy()),
  rescan: async () => pol.scanEntry?.() ?? [],
};

/* ---------------- 从源文件抽取真实代码 ---------------- */
const src = fs.readFileSync(CARD, 'utf8');

/*
 * 源码级断言**放在抽取之前**。
 *
 * 教训：之前放在后面，结果"把依赖退回 [api]"这种破坏会让 slice 找不到
 * 终点 → 脚本直接崩 → 没有任何 ❌ 输出 → 被我误读成"断言覆盖到了"。
 * 崩溃和"断言抓到"是两回事，**崩溃必须显式失败**，不能算通过。
 */
/*
 * apiRef 必须**每次渲染都更新**。只在 useRef 时赋初值的话，
 * ref 会永远指向挂载那一次的 api —— 通道从 bridge 切到 direct 之后，
 * refresh 用的还是旧对象，看起来"改了没反应"。
 */
t('apiRef 每次渲染都同步为最新 api',
  /const apiRef = useRef\(api\);\s*\n\s*apiRef\.current = api;/.test(src));
t('refresh 依赖是空数组（退回 [api] 会复活循环）',
  /\}, \[\]\);/.test(src) && !/\}, \[api\]\);/.test(src));
t('refresh 内部走 apiRef.current，不是直接用 api',
  /const a = apiRef\.current;/.test(src) && !/await api\.\w+\(/.test(src));
t('effect 仍依赖 refresh（只跑一次）',
  /useEffect\(\(\) => \{ refresh\(\); \}, \[refresh\]\);/.test(src));

function slice(startMark, endMark, label) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error(`抽取失败（找不到起点）：${label}`);
  const j = src.indexOf(endMark, i + startMark.length);
  if (j < 0) throw new Error(`抽取失败（找不到终点）：${label}`);
  return src.slice(i, j + endMark.length);
}

const useExternalApiSrc = slice('function useExternalApi() {', '\n}\n', 'useExternalApi');
const apiRefSrc = slice('  const apiRef = useRef(api);', '  apiRef.current = api;', 'apiRef');
const refreshSrc = slice('  const refresh = useCallback(async () => {', '  }, []);', 'refresh');
/*
 * effect 那行本身是完整语句，不需要终点标记。
 * 之前给它的终点是 ']'，而 indexOf 从起点之后开始找 ——
 * 结果匹配到了几百行之后的某个 ']'，把整个组件 JSX 都切了进来。
 * 这里改成"整行精确匹配"，并要求源码里确实存在这一行。
 */
const EFFECT_LINE = '  useEffect(() => { refresh(); }, [refresh]);';
if (!src.includes(EFFECT_LINE)) throw new Error('抽取失败（effect 行不在源码里，结构变了）');
const effectSrc = EFFECT_LINE;

t('抽到 useExternalApi（源结构没变）', /useExternalApi/.test(useExternalApiSrc));
t('抽到 apiRef（源结构没变）', /useRef\(api\)/.test(apiRefSrc) && /apiRef\.current = api/.test(apiRefSrc));
t('抽到 refresh（源结构没变）', /refresh/.test(refreshSrc));
t('抽到 useEffect（源结构没变）', /refresh\(\)/.test(effectSrc));

/* ---------------- 组装：真实代码 + 计数壳 ---------------- */
let renders = 0;
/*
 * 硬上限：真死循环时事件循环会被微任务占满，测试只会挂住不报错。
 * 超过上限就抛 —— 让"卡死"变成一个**可见的失败**而不是超时。
 */
const RENDER_LIMIT = 300;
let looped = false;

const useNexus = () => ({ shell: { external: bridgeExternal }, toast: () => {} });

/*
 * 抽出来的片段带 TS 类型标注（as any / : Policy / : any），
 * 直接 new Function 会语法错误 —— 先用项目自带的 typescript 剥掉。
 * 只剥类型、不改逻辑，验证的仍是源文件的真实代码。
 */
const ts = (await import('typescript')).default;
const stripTs = (code) => ts.transpileModule(code, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
  },
}).outputText;

const factory = new Function(
  'React', 'hooks', 'useNexus', 'pol', 'onRender',
  stripTs(`
  const { useState, useEffect, useCallback, useRef, useMemo } = hooks;
  ${useExternalApiSrc}
  return function Card() {
    const ctx = useNexus();
    const api = useExternalApi();
    const [policy, setPolicy] = useState(null);
    const [hosts, setHosts] = useState([]);
    const [csp, setCsp] = useState('');
    const [err, setErr] = useState(null);
    ${apiRefSrc}
    ${refreshSrc}
    ${effectSrc}
    onRender();
    return null;
  };
  `),
);
const Card = factory(React, { useState, useEffect, useCallback, useRef, useMemo }, useNexus, pol, () => {
  renders++;
  if (renders > RENDER_LIMIT) { looped = true; throw new Error('__RENDER_LOOP__'); }
});

/* ---------------- 渲染 ---------------- */
/* 先放一条外链，让 listHosts 返回非空（空数组时 setHosts([]) 也是新对象，
   同样会触发循环，但非空更贴近真实场景）。 */
pol.setHostStatus('example.com', 'pending');

const root = createRoot(document.getElementById('root'));
const swallow = async (fn) => {
  try { await fn(); } catch (e) {
    if (!String(e?.message || '').includes('__RENDER_LOOP__')) throw e;
  }
};
await swallow(() => act(async () => {
  root.render(createElement(Card));
}));
/* 异步 refresh 的收尾：多冲几轮，让循环（如果存在）跑出来 */
for (let i = 0; i < 20 && !looped; i++) {
  await swallow(() => act(async () => { await new Promise((r) => setTimeout(r, 0)); }));
}

console.log(`   渲染 ${renders} 次，load 调了 ${loadCalls} 次`);

/* 阈值取 10：正常情况应该只渲染 1~3 次（挂载 + 一次数据落位） */
t('渲染次数有界（不无限循环）', !looped && renders <= 10, `实际 ${renders} 次${looped ? '（触发上限）' : ''}`);
t('load 调用次数有界', loadCalls <= 10, `实际 ${loadCalls} 次`);


await act(async () => { root.unmount(); });

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
