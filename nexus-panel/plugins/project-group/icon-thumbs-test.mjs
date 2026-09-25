/**
 * 卡片图标缩略图：中断的请求必须能重取（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/icon-thumbs-test.mjs
 *
 * useIconThumbs 逐个问后端要图标的 data URI，用 done 集合避免重复取。
 *
 * 最容易写错的一处（**静默、永久**）：
 *   在 `await` **之前**就把路径加进 done。
 * 切页签 / 增删卡片会让 paths 变化，effect 被拆掉重建，那些还在飞的请求
 * 永远等不到 setThumbs；而它们已经在 done 里，下次进来被当成"处理过了"
 * 直接跳过 —— 那几张卡片的图标**从此永远停在占位符**，既不报错也不重试。
 *
 * 这里用一个极简 React 替身**真跑**这个 hook（不是文本断言）：
 * 文本断言只能证明"源码里有 pending 这几个字"，证明不了它真能重取。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeT, stripTS } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

/* ---------- 极简 React 替身：够跑这一个 hook 就行 ---------- */
const REACT = path.join(os.tmpdir(), `.fake-react.iconthumbs.${process.pid}.mjs`);
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
/* hook 顶部 import 的三个钩子转发给当前 host，
   这样每个用例各自 makeHost() 就能拿到干净的一套 state/refs/effects。
   （注释里不能写反引号：这段本身在模板字符串里，会把模板提前闭合。） */
export const useState = (...a) => globalThis.__host.useState(...a);
export const useRef = (...a) => globalThis.__host.useRef(...a);
export const useEffect = (...a) => globalThis.__host.useEffect(...a);
`);
const reactMod = await import(pathToFileURL(REACT).href);

/* ---------- 把 hook 源码转成可 import 的 ESM ---------- */
const SRC = path.join(HERE, 'hooks', 'useIconThumbs.ts');
let code = stripTS(fs.readFileSync(SRC, 'utf8'));
/* 剩下的 import 全是类型/外部包：'react' 指到替身，其余（本文件只有 Api 类型）删掉 */
/* 先删掉所有 import（含 'react' 那句），再单独补一句指向替身的。
   顺序不能反：先把 'react' 改写成 file:// URL，再跑"删 import"会把它一起删掉，
   于是 hook 里的 useState 变成未定义 —— 而改动本身看起来毫无问题。 */
code = code.replace(/^import [^;]*from\s+'[^']+';\s*$/gm, '');
code = `import { useEffect, useRef, useState } from '${pathToFileURL(REACT).href}';\n` + code;
/* stripTS 不处理**泛型调用**的类型实参：`useState<Record<string, string>>({})`
   会原样留下尖括号 → import 时 SyntaxError（括号平衡检查抓不到）。
   不能用 `<[^<>]*>`：类型实参里常有嵌套（`Record<string, string>`），
   必须自己配平尖括号深度再判断后面是不是 `(`（是才是调用、是类型实参）。 */
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
      /* 配平且紧跟着 '(' → 是调用的类型实参，整段丢掉（'(' 下一轮照常接上） */
      if (d === 0 && s[j + 1] === '(') { i = j; continue; }
    }
    out += ch;
  }
  return out;
}
code = dropCallGenerics(code);
code = `import { makeHost } from '${pathToFileURL(REACT).href}';\n` + code;
const OUT = path.join(os.tmpdir(), `.iconthumbs.${process.pid}.mjs`);
fs.writeFileSync(OUT, code);
const { useIconThumbs } = await import(pathToFileURL(OUT).href);

/** 受控的 api：iconData 返回的 promise 由测试决定何时落地 */
/**
 * 重渲染一次只为**读回最新的 thumbs**。
 * setThumbs 改的是替身里那份 state，不重渲染的话测试拿到的还是渲染时那个旧对象
 * —— 断言会全部失败，而 hook 本身是对的。这个坑只存在于替身里，真 React 会自动重渲染。
 */
function reread(api, paths) {
  let out = {};
  globalThis.__host.render(() => { out = useIconThumbs(api, paths); });
  return out;
}

function makeApi(onAsk) {
  return { iconData: async (p) => { onAsk(p); return `data:${p}`; } };
}

/** 让所有已排队的微任务跑完 */
const flush = () => new Promise((r) => setTimeout(r, 0));

console.log('\n=== 1. 正常路径：取到就进 thumbs，不重复取 ===');
{
  reactMod.makeHost();
  const asked = [];
  const api = makeApi((p) => asked.push(p));
  let thumbs = {};
  const host = globalThis.__host;
  host.render(() => { thumbs = useIconThumbs(api, ['a', 'b']); });
  await flush();
  await flush();
  t('两个路径都取过', asked.includes('a') && asked.includes('b'));
  thumbs = reread(api, ['a', 'b']);
  t('都进了 thumbs', thumbs.a === 'data:a' && thumbs.b === 'data:b');
  const n1 = asked.length;
  host.render(() => { thumbs = useIconThumbs(api, ['a', 'b']); });
  await flush();
  t('同一路径集合不再重取（deps 未变）', asked.length === n1);
}

console.log('\n=== 2. 中断的请求：下次必须重新取（本次修复的核心） ===');
{
  reactMod.makeHost();
  const host = globalThis.__host;
  const gate = { open: false, waiters: [] };
  const asked = [];
  /* 'a' 的请求被 gate 卡住，模拟"切走时它还在飞" */
  const api = {
    iconData: async (p) => {
      asked.push(p);
      if (p === 'a' && !gate.open) {
        await new Promise((r) => gate.waiters.push(r));
      }
      return `data:${p}`;
    },
  };

  let thumbs = {};
  host.render(() => { thumbs = useIconThumbs(api, ['a', 'b']); });
  await flush();
  t('已开始取 a', asked.includes('a'));

  /* 切页签：paths 变成别的集合 → 上一个 effect 被拆掉 */
  host.render(() => { thumbs = useIconThumbs(api, ['c']); });
  await flush();
  t('中断后 a 还没进 thumbs', thumbs.a === undefined);

  /* 切回来：a 必须重新去取（旧写法在这里会被 done 挡住，永远取不到） */
  const before = asked.filter((x) => x === 'a').length;
  gate.open = true;
  gate.waiters.forEach((r) => r());
  await flush();
  host.render(() => { thumbs = useIconThumbs(api, ['a']); });
  await flush();
  await flush();

  const after = asked.filter((x) => x === 'a').length;
  t('切回来后重新取了 a', after > before, `取了 ${after} 次（中断前 ${before} 次）`);
  thumbs = reread(api, ['a']);
  t('a 最终进了 thumbs', thumbs.a === 'data:a');
}

console.log('\n=== 3. 真失败仍留在 done 里，不反复重试 ===');
{
  reactMod.makeHost();
  const host = globalThis.__host;
  let n = 0;
  /* 只让 'x' 失败：全部失败的话 'y' 自然也取不到，
     那条断言验的就不是"失败不影响别的路径"了 —— 是我第一版写错的地方。 */
  const api = {
    iconData: async (p) => { n++; if (p === 'x') throw new Error('boom'); return `data:${p}`; },
  };
  let thumbs = {};
  host.render(() => { thumbs = useIconThumbs(api, ['x']); });
  await flush();
  await flush();
  const afterFirst = n;
  host.render(() => { thumbs = useIconThumbs(api, ['x', 'y']); });
  await flush();
  await flush();
  t('失败的路径不重取（避免刷 IPC 报错）', n === afterFirst + 1, `${afterFirst} → ${n}`);
  thumbs = reread(api, ['x', 'y']);
  t('失败不影响别的路径', thumbs.y === 'data:y');
}

console.log('\n=== 4. 源码约束（文本层，钉住上面行为的实现前提） ===');
{
  const src = fs.readFileSync(SRC, 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
  t('中断时把没回来的从 done 里摘掉',
    /for \(const p of pending\) done\.current\.delete\(p\)/.test(codeOnly));
  t('cleanup 里 alive 置 false', /alive = false/.test(codeOnly));
  t('finally 里从 pending 移除', /finally \{[\s\S]{0,80}?pending\.delete\(p\)/.test(codeOnly));
  t('失败分支静默（不刷屏）', /catch \{[\s\S]{0,120}?\}/.test(codeOnly));
}

fs.rmSync(REACT, { force: true });
fs.rmSync(OUT, { force: true });
done();
