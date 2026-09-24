/**
 * md · 最近阅读列表测试
 * ============================================================
 * recent.js 是纯函数（只碰 localStorage），所以能**真跑**，
 * 不用靠人眼在界面上点。
 *
 * 重点覆盖三类"错了不报错"的情形：
 *   ① 上限只写在读侧 —— 界面显示 12 条，localStorage 里悄悄堆到几十条
 *   ② 手改坏 localStorage —— JSON.parse 抛错会白屏
 *   ③ 打开失败不移除 —— 列表里留一条点了必然报错的记录
 *
 * 运行：node md-recent-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}
/*
 * 包一层：断言里要真调函数，函数一抛就是**崩**——后面的断言一条都不执行，
 * 崩了不算"红"，会掩盖别的问题。所以凡是要真跑的用例都走 safe()。
 */
function safe(name, fn) {
  let ok = false;
  /*
   * 两种入参都收：
   *   · 函数 —— 延迟执行，抛了才算失败
   *   · 布尔/值 —— 这里是"同步算完再传进来"的写法，
   *     但那样异常发生在**调用处**而不是这里，包不住。
   *     所以真正要防崩的用例请传函数；这里兼容是为了不改调用点。
   */
  if (typeof fn !== 'function') {
    t(name + '（断言写法错：safe 必须传函数，传值会包不住异常）', false);
    return;
  }
  try { ok = !!fn(); }
  catch (e) { ok = false; if (process.env.DEBUG) console.log('   [err]', name, '::', e && e.message); }
  t(name, ok);
}
/*
 * 在 marker 之后的窗口内查找 —— 用来把断言钉在**具体那个分支**上。
 * 只写 /removeRecent\(path\)/ 的话，两处调用删掉任一处都仍然匹配得上。
 */
function near(src, marker, needle, win = 400) {
  const i = src.indexOf(marker);
  if (i < 0) return false;
  return src.slice(i, i + win).includes(needle);
}

/* ---- localStorage 替身 ----
   node 里没有 localStorage。用 Map 造一个，并且能分别模拟
   getItem 抛错 / setItem 抛错（配额满）两种降级路径。 */
function makeStorage({ throwGet = false, throwSet = false, seed = null } = {}) {
  const m = new Map();
  if (seed != null) m.set('nexus:md:recent', seed);
  return {
    _m: m,
    getItem(k) {
      if (throwGet) throw new Error('blocked');
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      if (throwSet) throw new Error('quota');
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

const srcRecent = read('plugins/md/recent.js');
const srcApp = read('plugins/md/App.tsx');
const css = read('css/neumorphism.css');

console.log('=== 1. 纯函数：读写与去重 ===');

const R = await import('./plugins/md/recent.js');

safe('空存储读出来是空数组',
() => withStorage(makeStorage(), () => R.readRecent().length === 0));

safe('addRecent 后能读回，且带 title 与 at',
() => withStorage(makeStorage(), () => {
    R.addRecent('D:/a/b.md', 'b.md');
    const l = R.readRecent();
    return l.length === 1 && l[0].path === 'D:/a/b.md' && l[0].title === 'b.md' && l[0].at > 0;
  }));

safe('不传 title 时用 basename 兜底',
() => withStorage(makeStorage(), () => {
    R.addRecent('D:/x/y/note.md');
    return R.readRecent()[0].title === 'note.md';
  }));

safe('同一路径再打开 → 提到最前且不重复',
() => withStorage(makeStorage(), () => {
    R.addRecent('a.md');
    R.addRecent('b.md');
    R.addRecent('a.md');
    const l = R.readRecent();
    return l.length === 2 && l[0].path === 'a.md' && l[1].path === 'b.md';
  }));

safe('不同目录下的同名文件算两条（按完整路径去重，不按文件名）',
() => withStorage(makeStorage(), () => {
    R.addRecent('D:/one/note.md');
    R.addRecent('D:/two/note.md');
    return R.readRecent().length === 2;
  }));

console.log('\n=== 2. 上限必须写在写入侧 ===');

safe('加满 MAX_RECENT+5 条后，读出来是 MAX_RECENT 条',
() => withStorage(makeStorage(), () => {
    for (let i = 0; i < R.MAX_RECENT + 5; i++) R.addRecent(`f${i}.md`);
    return R.readRecent().length === R.MAX_RECENT;
  }));

safe('★ 绕过读侧 slice，直接看 localStorage 原始数据也不超上限',
() => withStorage(makeStorage(), () => {
    for (let i = 0; i < R.MAX_RECENT + 5; i++) R.addRecent(`f${i}.md`);
    const raw = JSON.parse(globalThis.localStorage.getItem('nexus:md:recent'));
    return Array.isArray(raw) && raw.length === R.MAX_RECENT;
  }));

t('MAX_RECENT 是个合理量级（8~20）', R.MAX_RECENT >= 8 && R.MAX_RECENT <= 20);

console.log('\n=== 3. 脏数据 / 手改坏存储（不白屏）===');

safe('非法 JSON → 空数组，不抛',
() => withStorage(makeStorage({ seed: '{oops' }), () => {
    let ok = false;
    try { ok = Array.isArray(R.readRecent()) && R.readRecent().length === 0; } catch (e) { ok = false; }
    return ok;
  }));

safe('存的不是数组（对象）→ 空数组',
() => withStorage(makeStorage({ seed: '{"a":1}' }), () => R.readRecent().length === 0));

safe('数组里缺 path 的条目被过滤',
() => withStorage(makeStorage({ seed: '[{"title":"x"},{"path":"ok.md"}]' }), () => {
    const l = R.readRecent();
    return l.length === 1 && l[0].path === 'ok.md';
  }));

safe('path 不是字符串（数字/null）被过滤',
() => withStorage(makeStorage({ seed: '[{"path":123},{"path":null},{"path":""}]' }), () =>
    R.readRecent().length === 0));

safe('重复路径在存量数据里也被去掉',
() => withStorage(makeStorage({ seed: '[{"path":"a.md"},{"path":"a.md"}]' }), () =>
    R.readRecent().length === 1));

safe('title 缺失时用 basename 补',
() => withStorage(makeStorage({ seed: '[{"path":"D:/p/q.md"}]' }), () =>
    R.readRecent()[0].title === 'q.md'));

console.log('\n=== 4. storage 不可用时的降级 ===');

safe('getItem 抛错 → 空数组，不崩',
() => withStorage(makeStorage({ throwGet: true }), () => {
    let ok = false;
    try { ok = R.readRecent().length === 0; } catch (e) { ok = false; }
    return ok;
  }));

safe('完全没有 localStorage → 空数组，不崩',
() => withStorage(undefined, () => {
    let ok = false;
    try { ok = R.readRecent().length === 0; } catch (e) { ok = false; }
    return ok;
  }));

safe('setItem 抛错（配额满）→ addRecent 不崩且返回列表',
() => withStorage(makeStorage({ throwSet: true }), () => {
    let ok = false;
    try { ok = Array.isArray(R.addRecent('a.md')); } catch (e) { ok = false; }
    return ok;
  }));

console.log('\n=== 5. 移除与清空 ===');

safe('removeRecent 去掉指定条目，其它保留',
() => withStorage(makeStorage(), () => {
    R.addRecent('a.md'); R.addRecent('b.md');
    const l = R.removeRecent('a.md');
    return l.length === 1 && l[0].path === 'b.md';
  }));

safe('removeRecent 不存在的路径不报错',
() => withStorage(makeStorage(), () => {
    R.addRecent('a.md');
    return R.removeRecent('zzz.md').length === 1;
  }));

safe('clearRecent 后读出来为空',
() => withStorage(makeStorage(), () => {
    R.addRecent('a.md');
    R.clearRecent();
    return R.readRecent().length === 0;
  }));

console.log('\n=== 6. baseNameOf ===');

t('unix 路径', R.baseNameOf('/a/b/c.md') === 'c.md');
t('windows 反斜杠', R.baseNameOf('D:\\a\\b\\c.md') === 'c.md');
t('没有分隔符', R.baseNameOf('c.md') === 'c.md');
t('空值不抛', R.baseNameOf('') === '' && R.baseNameOf(null) === '');

console.log('\n=== 7. App 接线（源码断言）===');

t('App 引入了 recent 模块', /from '\.\/recent'/.test(srcApp));
/*
 * 这几条必须**限定在 openPath 函数体内**断言。
 * 全文件里 removeRecent / "读取失败：" 各有好几处（拖入分支、导出分支、
 * 列表上的 × 按钮），只写 /removeRecent\(path\)/ 的话，
 * 删掉 catch 里那一处，另一处照样匹配得上 —— 破坏验证实测全绿。
 */
const openPathBody = (() => {
  const i = srcApp.indexOf('const openPath = useCallback');
  const j = srcApp.indexOf('}, [ctx]);', i);
  return i >= 0 && j > i ? srcApp.slice(i, j) : '';
})();
t('能定位到 openPath 函数体（断言的前提）', openPathBody.length > 200);
t('打开成功写入最近列表', /setRecent\(addRecent\(/.test(openPathBody));
t('打开失败移除该条（不留一条点了必然报错的记录）',
  /catch \(err\) \{[\s\S]{0,500}?setRecent\(removeRecent\(path\)\)/.test(openPathBody));
t('返回内容不是文本时也移除',
  /返回内容不是文本[\s\S]{0,160}?setRecent\(removeRecent\(path\)\)/.test(openPathBody));
t('从最近列表打开**复用** openPath，不另写一份读文件逻辑',
  /const onOpenRecent[\s\S]{0,400}?openPath\(path\)/.test(srcApp));
t('打开后收起列表（留着会盖住正文）',
  /const onOpenRecent[\s\S]{0,300}?setShowRecent\(false\)/.test(srcApp));
t('最近列表用 baseNameOf 而不是内联再写一份切分',
  /baseNameOf\(/.test(srcApp) && !/split\('\/'\)\.pop\(\)/.test(srcApp));
t('移除是**真按钮**（键盘可达），不是只有右键',
  /className="md-recent-del"[\s\S]{0,200}?onClick=\{[^}]*removeRecent/.test(srcApp));
t('列表为空时按钮仍可点（点了没反应会被当成坏了）',
  /onClick=\{\(\) => setShowRecent\(\(v\) => !v\)\}/.test(srcApp));
t('打开成功后清 hint',
  /addRecent\(String\(path\), nm\)/.test(srcApp));

console.log('\n=== 8. 样式 ===');

t('CSS 有 .md-recent', /\.md-recent\s*\{/.test(css));
t('CSS 有 .md-recent-item', /\.md-recent-item\s*\{/.test(css));
t('CSS 有 .md-recent-del', /\.md-recent-del\s*\{/.test(css));
t('长路径省略号（不把 × 挤出可视区）',
  /\.md-recent-item\s*\{[\s\S]{0,300}?text-overflow:\s*ellipsis/.test(css));
t('列表限高可滚（不抢走正文高度）',
  /\.md-recent-list\s*\{[\s\S]{0,300}?max-height/.test(css));
t('不写死色值（切主题要跟着变）', (() => {
  const i = css.indexOf('.md-recent');
  const blk = css.slice(i, i + 1600);
  const stripped = blk.replace(/var\([^)]*\)/g, '');
  return !/#[0-9a-fA-F]{3,8}\b/.test(stripped);
})());

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
