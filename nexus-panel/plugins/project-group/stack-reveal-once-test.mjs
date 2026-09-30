/**
 * 跳转后滚进视野：只滚一次，不能每次渲染都滚
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/stack-reveal-once-test.mjs
 *
 * 为什么要"跑真身"而不是断言源码里有没有那行：
 * 这个 BUG 的形状是 **`cardsOf` 进了依赖数组**——它在渲染间是新的引用，
 * 于是 effect 每次渲染都重跑。文本断言只能证明"依赖数组里有 cardsOf 这几个字"，
 * 证明不了"重跑会发生"。这里把 effect 的回调与依赖数组**真的取出来跑一遍**，
 * 用"渲染 → 比较依赖 → 是否再排一次 rAF"这条真实链路来验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const SRC = strip(fs.readFileSync(path.join(HERE, 'components/StackedGroups.tsx'), 'utf8'));

/* ── 把 reveal 那个 effect 的回调与依赖数组挖出来 ──────────────────────── */

/** 从 `useEffect(() => {` 起按大括号配平切出整段（含 `}, [...]);`） */
function cutEffect(src) {
  const anchor = 'if (!reveal) return;';
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  const start = src.lastIndexOf('useEffect(() => {', at);
  if (start < 0) return null;
  let i = src.indexOf('{', start + 'useEffect(() =>'.length);
  let d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) break; }
  }
  const bodyOpen = src.indexOf('{', start + 'useEffect(() =>'.length);
  const body = src.slice(bodyOpen + 1, i);
  // 依赖数组：闭括号之后到 `);` 之前
  const tail = src.slice(i, src.indexOf(');', i) + 2);
  const d0 = tail.indexOf('[');
  const d1 = tail.indexOf(']', d0);
  return { body, depsSrc: tail.slice(d0 + 1, d1), tail };
}

const cut = cutEffect(SRC);

console.log('\n=== 1. 挖得到锚点（否则后面全是假绿）===');
t('找得到 reveal 那段 effect', cut !== null);
if (!cut) { done(); process.exit(1); }
/* 这条最容易空跑：锚点取到别处时，切出来的"body"是别的 effect，
   后面所有行为断言都会变成"拿错的东西去验"，全绿但没验到。 */
t('切到的是 reveal 那段（含 rAF 滚动）', cut.body.includes('requestAnimationFrame'));
t('切到的是 reveal 那段（含展开折叠）', cut.body.includes('setCollapsed'));
console.log('   依赖数组 =', '[' + cut.depsSrc.trim() + ']');

console.log('\n=== 2. 依赖数组里不能有 cardsOf ===');
{
  const deps = cut.depsSrc.split(',').map((x) => x.trim()).filter(Boolean);
  console.log('   解析出依赖 =', JSON.stringify(deps));
  t('cardsOf 不在依赖里', !deps.includes('cardsOf'));
  t('reveal 在依赖里', deps.includes('reveal'));
  t('tabs 在依赖里（补"跳转时分类还没到"）', deps.includes('tabs'));
}

/* ── 极简 React 替身：只做"依赖变了就重跑 effect"这一件事 ─────────────── */

let rafSeq = 0;
let rafCalls = 0;

function makeEnv() {
  rafSeq = 0; rafCalls = 0;
  const collapased = { v: new Set([0]) };
  const scrolled = [];
  const pending = new Map();
  return {
    collapased, scrolled,
    /** 把排到的 rAF 回调真跑掉（否则"滚没滚"永远验不到） */
    flush() {
      const list = [...pending.entries()];
      pending.clear();
      for (const [, cb] of list) cb();
    },
    setCollapsed: (fn) => { collapased.v = fn(collapased.v); },
    requestAnimationFrame: (cb) => { rafSeq++; rafCalls++; pending.set(rafSeq, cb); return rafSeq; },
    cancelAnimationFrame: (id) => { pending.delete(id); },
    document: {
      querySelector: (sel) => ({
        scrollIntoView: (o) => { scrolled.push({ sel, o }); },
      }),
    },
    window: { CSS: { escape: (x) => x } },
  };
}

/** 把 body 编成可执行的函数 */
function compile(body) {
  const code = body.replace(/querySelector<[^>]*>/g, 'querySelector');
  // eslint-disable-next-line no-new-func
  return new Function(
    'reveal', 'tabs', 'cardsOf', 'setCollapsed',
    'requestAnimationFrame', 'cancelAnimationFrame', 'document', 'window', 'CSS',
    code,
  );
}
const run = compile(cut.body);
const depsOf = new Function('reveal', 'tabs', 'cardsOf', 'return [' + cut.depsSrc + '];');

/** 模拟一次渲染：依赖变了才重跑（React 的实际行为） */
let pendingCleanup = null;
function render(env, prev, { reveal, tabs, cardsOf }) {
  const deps = depsOf(reveal, tabs, cardsOf);
  const changed = !prev
    || prev.length !== deps.length
    || prev.some((d, i) => !Object.is(d, deps[i]));
  if (!changed) return deps;
  /* cleanup 必须在**下次重跑之前**调用、不是跑完立刻调：
     立刻调会把刚排的 rAF 取消掉（真实 React 里不会这样），
     结果"到底滚没滚"永远验不到。 */
  if (pendingCleanup) { pendingCleanup(); pendingCleanup = null; }
  const ret = run(
    reveal, tabs, cardsOf,
    env.setCollapsed, env.requestAnimationFrame, env.cancelAnimationFrame,
    env.document, env.window, env.window.CSS,
  );
  if (typeof ret === 'function') pendingCleanup = ret;
  return deps;
}

console.log('\n=== 3. 跳转一次 → 只排一次 rAF（真跑）===');
{
  const env = makeEnv();
  const tabs = [{ name: 'A', items: [{ path: '/g1' }] }];
  const cardsOf = (i) => tabs[i].items;
  const reveal = { path: '/g1', seq: 1 };
  pendingCleanup = null;
  let prev = render(env, null, { reveal, tabs, cardsOf });
  t('首次跳转排了一次 rAF', rafCalls === 1);
  /* 关键：cardsOf 换新引用（真实渲染里就是这样），reveal / tabs 不变 */
  let n = 0;
  for (let k = 0; k < 5; k++) {
    prev = render(env, prev, { reveal, tabs, cardsOf: (i) => tabs[i].items });
    n = rafCalls;
  }
  console.log('   连续 5 次重渲染后 rAF 次数 =', n);
  t('后续渲染不再排 rAF（不再反复滚回去）', n === 1);
  env.flush();
  console.log('   实际滚动次数 =', env.scrolled.length);
  t('目标卡只被滚一次', env.scrolled.length === 1);
  t('滚的是目标那张卡', (env.scrolled[0]?.sel || '').includes('/g1'));
  t('block 用 nearest（已可见时不动）', env.scrolled[0]?.o?.block === 'nearest');
}

console.log('\n=== 4. 连跳同一张卡仍要滚（seq 变了）===');
{
  const env = makeEnv();
  const tabs = [{ name: 'A', items: [{ path: '/g1' }] }];
  const cardsOf = (i) => tabs[i].items;
  pendingCleanup = null;
  let prev = render(env, null, { reveal: { path: '/g1', seq: 1 }, tabs, cardsOf });
  prev = render(env, prev, { reveal: { path: '/g1', seq: 2 }, tabs, cardsOf });
  console.log('   连跳两次后 rAF 次数 =', rafCalls);
  t('seq 变化会重跑（第二次跳转也滚）', rafCalls === 2);
}

console.log('\n=== 5. 仍会展开折叠 + 真去滚动（功能没被改坏）===');
{
  const env = makeEnv();
  const tabs = [{ name: 'A', items: [{ path: '/g1' }] }];
  env.collapased.v = new Set([0]);
  render(env, null, { reveal: { path: '/g1', seq: 1 }, tabs, cardsOf: (i) => tabs[i].items });
  t('折叠着的分类被展开', !env.collapased.v.has(0));
  env.flush();
  t('真去滚了目标那张卡', (env.scrolled[0]?.sel || '').includes('/g1'));
}

console.log('\n=== 6. 目标不在任何分类里 → 不动、不排 rAF ===');
{
  const env = makeEnv();
  const tabs = [{ name: 'A', items: [{ path: '/g1' }] }];
  render(env, null, { reveal: { path: '/不存在', seq: 1 }, tabs, cardsOf: (i) => tabs[i].items });
  t('找不到时不排 rAF', rafCalls === 0);
}

done();
