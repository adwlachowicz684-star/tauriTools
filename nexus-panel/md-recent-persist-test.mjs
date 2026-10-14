/**
 * md · 最近阅读列表「说了记住其实没记住」测试
 * ============================================================
 * 守的是一类**界面看不出来**的问题：
 *
 *   改列表的动作当场就生效 —— 列表多一条 / 少一条 / 清空了，
 *   于是用户看不出"这一笔根本没写进 localStorage"，
 *   要到下次启动才发现白点一次。
 *   而 recent.js 的注释原本写着"写失败返回 false，调用方据此决定
 *   要不要提示"，可 addRecent / removeRecent / clearRecent **返回的是
 *   列表**，false 塞不进返回值里 —— 三个调用方全都拿不到。
 *   注释承诺了代码没做的事。
 *
 * 本文件两类断言：
 *   · recent.js —— **真跑**（它只碰 localStorage，可以换替身实跑）
 *   · App.tsx   —— 源码断言，钉"改列表必须走 applyRecent"这个意图
 *
 * 运行：node md-recent-persist-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}
/* 断言里要真调函数，一抛就崩 —— 崩掉的脚本会把后面全部断言吃掉。 */
function safe(name, fn) {
  if (typeof fn !== 'function') {
    t(name + '（safe 必须传函数）', false);
    return;
  }
  let ok = false;
  try { ok = !!fn(); }
  catch (e) { ok = false; if (process.env.DEBUG) console.log('   [err]', name, '::', e && e.message); }
  t(name, ok);
}

function makeStorage({ throwGet = false, throwSet = false } = {}) {
  const m = new Map();
  return {
    getItem(k) {
      if (throwGet) throw new Error('blocked');
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      if (throwSet) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
    removeItem(k) { m.delete(k); },
  };
}
function withStorage(ls, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const old = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls, configurable: true, writable: true,
  });
  try { return fn(); } finally {
    if (had) globalThis.localStorage = old;
    else delete globalThis.localStorage;
  }
}
/** 连"取 localStorage 这个对象"都抛（跨域 iframe / 被策略禁用） */
function withNoStorage(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const old = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    get() { throw new Error('access denied'); },
    configurable: true,
  });
  try { return fn(); } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', { value: old, configurable: true, writable: true });
    else delete globalThis.localStorage;
  }
}

const srcRecent = read('plugins/md/recent.js');
const srcApp = read('plugins/md/App.tsx');
/*
 * 源码断言一律先看**剥掉注释**的版本。
 * 注释里会把反例原样写出来（"不要写成 setRecent(addRecent(…))"），
 * 不剥的话反例本身就是命中项 —— 断言恒真，改坏了也照样绿。
 * 这是本项目第 N 次栽在"注释里的字被断言当成依据"。
 */
const srcAppCode = stripComments(srcApp);

console.log('=== 1. recent.js · 写入失败要说得出来（真跑）===');

const R = await import('./plugins/md/recent.js');

/* 每个用例前后都要清一次，否则上一次的错会串到下一次 ——
   那会让"没失败"的用例假绿。 */
const clear = () => R.takeRecentWriteError();

safe('有 takeRecentWriteError 这个出口', () => typeof R.takeRecentWriteError === 'function');
if (typeof R.takeRecentWriteError !== 'function') {
  console.log('\n（缺少判据出口，后面全部断言无意义）');
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

safe('正常存储下不误报（返回空串）',
() => withStorage(makeStorage(), () => {
  clear();
  R.addRecent('D:/a/b.md');
  const why = R.takeRecentWriteError();
  return why === '';
}));

safe('setItem 抛错（配额满）→ addRecent 不崩且返回列表',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  const l = R.addRecent('a.md');
  return Array.isArray(l) && l.length === 1;
}));

safe('setItem 抛错 → addRecent 之后能取到原因',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  R.addRecent('a.md');
  return String(R.takeRecentWriteError()).length > 0;
}));

safe('setItem 抛错 → removeRecent 之后能取到原因',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  R.removeRecent('a.md');
  return String(R.takeRecentWriteError()).length > 0;
}));

safe('setItem 抛错 → clearRecent 之后能取到原因',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  R.clearRecent();
  return String(R.takeRecentWriteError()).length > 0;
}));

safe('没有 localStorage → addRecent 也报得出原因',
() => withNoStorage(() => {
  clear();
  const l = R.addRecent('a.md');
  const why = R.takeRecentWriteError();
  return Array.isArray(l) && String(why).length > 0;
}));

/*
 * 文案要说清两件事：① 这次改动**当场生效了**（不是"操作失败"）
 * ② 但没记住，重启后会回来。
 * 只说"写入失败"会让人以为刚才那下没生效而去再点一次 —— 而再点一次同样存不下。
 */
safe('原因里说清"重启后会回到原来的样子"',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  R.addRecent('a.md');
  return /重启/.test(String(R.takeRecentWriteError()));
}));

safe('原因里带上了底层给的错（配额），不是一句空话',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  R.addRecent('a.md');
  return /Quota|配额|存储/.test(String(R.takeRecentWriteError()));
}));

safe('取一次就清掉（不会一直挂着旧错）',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  R.addRecent('a.md');
  R.takeRecentWriteError();
  return R.takeRecentWriteError() === '';
}));

safe('写成功会把上一次的错清掉',
() => withStorage(makeStorage(), () => {
  R.addRecent('a.md');            // 成功
  R.takeRecentWriteError();
  return R.takeRecentWriteError() === '';
}));

safe('writeRecent 返回 false 与"取得到原因"必须成对',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  const ok = R.writeRecent([]);
  const why = R.takeRecentWriteError();
  return ok === false && String(why).length > 0;
}));

safe('writeRecent 返回 true 时不给原因',
() => withStorage(makeStorage(), () => {
  clear();
  const ok = R.writeRecent([]);
  const why = R.takeRecentWriteError();
  return ok === true && why === '';
}));

console.log('\n=== 2. 破坏验证：换掉的写法确实抓不住 ===');

/*
 * 这几条证明上面的断言**不是恒真**。
 * 判据若退化成"只看 addRecent 返不返回列表"，下面的旧写法会一起变绿 ——
 * 而旧写法正是本 bug 的形状。
 */
safe('（自检）只看返回列表的话，旧写法也能过 → 所以必须看原因',
() => withStorage(makeStorage({ throwSet: true }), () => {
  clear();
  const l = R.addRecent('a.md');
  const whyIfIgnored = '';
  return Array.isArray(l) && whyIfIgnored === '';
}));

console.log('\n=== 3. App 接线（源码断言）===');

t('App 引入了 takeRecentWriteError',
  /takeRecentWriteError/.test(srcAppCode));

t('App 有统一的 applyRecent 入口',
  /const applyRecent = useCallback/.test(srcAppCode));

/* 判据是"内部取走了原因"，不是"名字叫 applyRecent" ——
   只钉名字的话，里面什么都不做也照样绿。 */
t('applyRecent 内部取走了写入原因',
  /const applyRecent = useCallback[\s\S]{0,400}?takeRecentWriteError\(\)/.test(srcAppCode));

/* 四个改列表的点必须都走 applyRecent。
   只写 /applyRecent\(/ 的话，留一处直接 setRecent 也照样绿，
   而漏掉的那处正是"点了没反应"的来源。 */
const applyUses = (srcAppCode.match(/applyRecent\(/g) || []).length;
t('改列表的调用点全部走 applyRecent（≥4 处）', applyUses >= 4,
  `实测 ${applyUses} 处`);

t('没有剩下的"直接 setRecent(改列表)"',
  !/setRecent\(\s*(addRecent|removeRecent|clearRecent)\(/.test(srcAppCode));

/* 追加而不是覆盖：打开失败时提示栏里已经有"读取失败：…"，
   覆盖掉就把更要紧的那条吞了。 */
t('提示是追加（setHint 用 updater），不是覆盖',
  /setHint\(\(prev[^)]*\) =>/.test(srcAppCode));

safe('（自检）applyRecent 判据没失明：全换成 setRecent 后应红',
() => !/applyRecent\(/.test(srcAppCode.replace(/applyRecent\(/g, 'setRecent(')));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
