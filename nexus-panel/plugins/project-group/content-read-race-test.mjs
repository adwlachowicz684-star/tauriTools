/**
 * 内容预览读取竞态（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/content-read-race-test.mjs
 *
 * ContentPanel 点一个叶子就 `await api.readFile(path)` 再 setText。
 *
 * 最容易漏的一处（**静默、且内容张冠李戴**）：
 *   没有读取代号，先点一个大文件、再点一个小文件时，
 *   选中态已经是后点的那个，预览区却在旧内容回来时被改写成先点的那个。
 *   界面同时显示"选中 B"与"A 的内容"，没有任何报错。
 *
 * 这里用一个极简 React 替身**真跑**这个点击流程（不是文本断言）：
 * 文本断言只能证明"源码里有 readSeq 这几个字"，证明不了过期响应真被丢弃。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeT, stripTS } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

/* ---------------- 极简 React 替身 ---------------- */
const REACT = path.join(os.tmpdir(), `.fake-react.cp.${process.pid}.mjs`);
fs.writeFileSync(REACT, `
export function makeHost() {
  const state = [], refs = [], effects = [], memos = [];
  let slot = 0;
  globalThis.__host = {
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
    useMemo(fn, deps) {
      const i = slot++;
      const prev = memos[i];
      const changed = !prev || !deps || deps.length !== prev.deps.length ||
        deps.some((d, j) => d !== prev.deps[j]);
      if (changed) memos[i] = { deps, v: fn() };
      return memos[i].v;
    },
    useCallback(fn) { return fn; },
    render(fn) { slot = 0; return fn(); },
  };
}
export const useState = (...a) => globalThis.__host.useState(...a);
export const useRef = (...a) => globalThis.__host.useRef(...a);
export const useEffect = (...a) => globalThis.__host.useEffect(...a);
export const useMemo = (...a) => globalThis.__host.useMemo(...a);
export const useCallback = (...a) => globalThis.__host.useCallback(...a);
`);
const reactMod = await import(pathToFileURL(REACT).href);

/* ---------------- 把 read 那段逻辑抽出来真跑 ----------------
 * ContentPanel 是个大组件，整体加载要拖进来一堆依赖（ui/ContextMenu 等 JSX）。
 * 这里只取 `const read = async (item) => {...}` 这一段，
 * 配上真实存在的 readSeq / setText / api，跑的是**源码里的那段代码本身**。
 */
const SRC = path.join(HERE, 'components', 'ContentPanel.tsx');
const raw = fs.readFileSync(SRC, 'utf8');

function extractRead(src) {
  const i = src.indexOf('const read = async (item: ContentItem) =>');
  if (i < 0) return '';
  /* 从 '=>' 后的 '{' 起配平大括号，只切出**箭头函数本体**（不含 'const read ='） */
  const open = src.indexOf('{', src.indexOf('=>', i));
  let d = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(open, j + 1);
}
const readSrc = extractRead(raw);
t('取到 read 源码段', readSrc.length > 40);

function build({ slowPath, fastPath }) {
  const seq = { current: 0 };
  let text = '';
  const logs = [];
  const gates = {};
  const api = {
    readFile: async (p) => {
      if (p === slowPath) {
        await new Promise((r) => (gates.slow = r));
        return `内容:${p}`;
      }
      return `内容:${p}`;
    },
  };
  const src = readSrc
    .replace(/readSeq/g, '__seq').replace(/\bonSelect\b/g, '__onSelect').replace(/\bsetText\b/g, '__setText').replace(/\bonLog\b/g, '__onLog')
    .replace(/errText\(e\)/g, 'String(e && e.message)');
  const fn = new Function(
    '__seq', '__setText', '__onSelect', '__onLog', 'api',
    `return async (item) => ${src};`,
  );
  const read = fn(
    seq,
    (v) => { text = v; },
    () => {},
    (m) => logs.push(m),
    api,
  );
  return { read, seq, api, gates, logs, text: () => text };
}

console.log('\n=== 1. 连点两个文件：慢的那个回来后不能覆盖 ===');
{
  const h = build({ slowPath: '/a/big.md' });
  const p1 = h.read({ path: '/a/big.md' });      // 慢，卡在 gate 上
  const p2 = h.read({ path: '/a/small.md' });    // 快，立刻回来
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  t('快的内容已显示', h.text() === '内容:/a/small.md', `当前=${h.text()}`);
  h.gates.slow();                                 // 慢的现在才回来
  await Promise.all([p1, p2]);
  t('慢的回来后不覆盖（核心）', h.text() === '内容:/a/small.md', `当前=${h.text()}`);
}

console.log('\n=== 2. 只点一个文件时正常工作 ===');
{
  const h = build({ slowPath: '/none' });
  await h.read({ path: '/a/one.md' });
  t('内容正常写入', h.text() === '内容:/a/one.md', `当前=${h.text()}`);
}

console.log('\n=== 3. 读取失败仍要清掉并报错 ===');
{
  const seq = { current: 0 };
  let text = 'X';
  const logs = [];
  const src = readSrc
    .replace(/readSeq/g, '__seq').replace(/\bonSelect\b/g, '__onSelect').replace(/\bsetText\b/g, '__setText').replace(/\bonLog\b/g, '__onLog')
    .replace(/errText\(e\)/g, 'String(e && e.message)');
  const fn = new Function('__seq', '__setText', '__onSelect', '__onLog', 'api',
    `return async (item) => ${src};`);
  const read = fn(seq, (v) => { text = v; }, () => {}, (m) => logs.push(m),
    { readFile: async () => { throw new Error('打不开'); } });
  await read({ path: '/a/x.md' });
  t('失败时清空', text === '', `当前=${JSON.stringify(text)}`);
  t('失败时报错', logs.some((m) => /读取失败/.test(m)), logs.join('|'));
}

console.log('\n=== 4. 源码约束（文本层） ===');
{
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  t('声明了 readSeq', /const readSeq = useRef\(0\)/.test(code));
  t('read 里取代号', /const seq = \+\+readSeq\.current/.test(code));
  /* 行尾注释也要容许：判据是"这一句后面紧跟 setText(t)"，
     写成 `\s*\n` 的话 `return;   // 说明` 里的注释会让它匹配不上，
     断言于是永远为假 —— 看着像"没写守卫"，其实写了。 */
  t('setText 前判代号',
    /if \(readSeq\.current !== seq\) return;[^\n]*\n\s*setText\(t\)/.test(code));
  t('失败分支也判代号', /catch \(e\) \{[\s\S]{0,200}?if \(readSeq\.current !== seq\) return;/.test(code));
  /* 换目录 / 换类别要让在飞的作废，否则上一位的内容落进新目录的预览区 */
  const eff = code.slice(code.indexOf('useEffect(() => {'), code.indexOf('}, [root, kind])'));
  t('换 root/kind 时递增代号', /readSeq\.current\+\+/.test(eff));
}

console.log('\n=== 5. 目录选择器 load 的同一竞态 ===');
{
  const D = path.join(HERE, 'components', 'DirDialog.tsx');
  const src = fs.readFileSync(D, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');

  function extractLoad(s) {
    const i = s.indexOf('const load = useCallback(async (p: string) =>');
    if (i < 0) return '';
    const open = s.indexOf('{', s.indexOf('=>', i));
    let d = 0, j = open;
    for (; j < s.length; j++) {
      if (s[j] === '{') d++;
      else if (s[j] === '}') { d--; if (d === 0) break; }
    }
    return s.slice(open, j + 1);
  }
  const loadSrc = extractLoad(src);
  t('取到 load 源码段', loadSrc.length > 40);

  /* 真跑：慢目录后回来，不能把 path / entries 改回去 */
  const seq = { current: 0 };
  let entries = null, cur = '', loading = null, err = '';
  const gates = {};
  const body = loadSrc
    .replace(/\} catch \(e: any\)/g, '} catch (e)')
    .replace(/loadSeq/g, '__seq')
    .replace(/\bsetEntries\b/g, '__setEntries')
    .replace(/\bsetPath\b/g, '__setPath')
    .replace(/\bsetInput\b/g, '__setInput')
    .replace(/\bsetErr\b/g, '__setErr')
    .replace(/\bsetLoading\b/g, '__setLoading');
  const fn = new Function('__seq', '__setEntries', '__setPath', '__setInput', '__setErr',
    '__setLoading', 'api', `return async (p) => ${body};`);
  const load = fn(seq, (v) => { entries = v; }, (v) => { cur = v; }, () => {},
    (v) => { err = v; }, (v) => { loading = v; }, {
      listDirs: async (p) => {
        if (p === '/slow') await new Promise((r) => (gates.slow = r));
        return [{ path: p + '/x', name: 'x' }];
      },
    });

  const p1 = load('/slow');
  const p2 = load('/fast');
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  t('快的先落地', cur === '/fast', `当前=${cur}`);
  gates.slow();
  await Promise.all([p1, p2]);
  t('慢的回来后不改 path（核心）', cur === '/fast', `当前=${cur}`);
  t('慢的回来后不改 entries', entries?.[0]?.path === '/fast/x', String(entries?.[0]?.path));
  t('收尾把 loading 清掉', loading === false, `loading=${loading}`);

  /* 两次都在飞时，**先回来的那次不能提前把 loading 清掉**：
     否则界面在"还在读"时就显示就绪，用户会以为列表已经完整。 */
  {
    const s2 = { current: 0 };
    let lg = null, cur2 = '';
    const g = {};
    const f2 = new Function('__seq', '__setEntries', '__setPath', '__setInput', '__setErr',
      '__setLoading', 'api', `return async (p) => ${body};`);
    const load2 = f2(s2, () => {}, (v) => { cur2 = v; }, () => {}, () => {},
      (v) => { lg = v; }, {
        listDirs: async (p) => {
          await new Promise((r) => (g[p] = r));
          return [{ path: p + '/x', name: 'x' }];
        },
      });
    const a = load2('/A');
    const b = load2('/B');
    g['/A']();
    await a;
    t('先回来的那次不清 loading（后一次还在读）', lg === true, `loading=${lg}`);
    g['/B']();
    await b;
    t('最后一次收尾才清 loading', lg === false, `loading=${lg}`);
    t('最终落到后点的目录', cur2 === '/B', `当前=${cur2}`);
  }

  t('声明了 loadSeq', /const loadSeq = useRef\(0\)/.test(code));
  t('load 里取代号', /const seq = \+\+loadSeq\.current/.test(code));
}

fs.rmSync(REACT, { force: true });
done();
