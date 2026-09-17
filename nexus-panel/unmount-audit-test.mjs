/**
 * 卸载残留校验 —— 行为测试（不是源码字符串测试）
 *
 * 用 jsdom 造真实环境：真的往 window 挂属性、往 body 加节点，
 * 然后看差分能不能抓到。**只查字符串会漏掉真正的逻辑错误。**
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const {
  snapshotGlobals, diffSnapshots, auditUnmount,
} = await import('./js/unmount-audit.js');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); }
};

/** 干净的环境重新开始（避免上一项的污染串到下一项） */
function reset() {
  for (const n of [...document.body.children]) n.remove();
  for (const n of [...document.head.children]) n.remove();
  for (const k of Object.keys(window)) {
    if (!k.startsWith('_') && k !== 'window' && k !== 'document'
      && k !== 'navigator' && k !== 'location' && k !== 'top'
      && k !== 'self' && k !== 'parent' && k !== 'frames') {
      try { delete window[k]; } catch { /* 只读的跳过 */ }
    }
  }
}

console.log('=== 1. 抓得到真实污染（这是它存在的理由）===');

reset();
let b = snapshotGlobals();
window.__leaked_prop = 1;                       // 模拟插件挂全局属性
let d = diffSnapshots(b, snapshotGlobals());
t('抓到 window 上多出来的属性',
  d.suspect.some((x) => x === 'window.__leaked_prop'));

reset();
b = snapshotGlobals();
const div = document.createElement('div');       // 模拟插件往 body 挂浮层
div.className = 'plugin-portal';
document.body.appendChild(div);
d = diffSnapshots(b, snapshotGlobals());
t('抓到 body 上多出来的节点',
  d.suspect.some((x) => x.includes('plugin-portal')));

reset();
b = snapshotGlobals();
const st = document.createElement('style');      // 模拟插件插动态样式
document.head.appendChild(st);
d = diffSnapshots(b, snapshotGlobals());
t('抓到 head 上多出来的 style',
  d.suspect.some((x) => x.includes('head > style')));

console.log('\n=== 2. 干净卸载不误报 ===');
reset();
b = snapshotGlobals();
d = diffSnapshots(b, snapshotGlobals());
t('什么都没动 → 无残留', d.suspect.length === 0 && d.benign.length === 0);

console.log('\n=== 3. 多重集合语义（同类节点重复要分别算）===');
reset();
b = snapshotGlobals();
document.body.appendChild(document.createElement('div'));
document.body.appendChild(document.createElement('div'));
d = diffSnapshots(b, snapshotGlobals());
t('两个同类节点算 2 项（不能去重成一个）',
  d.suspect.filter((x) => x === 'body > div').length === 2);

console.log('\n=== 4. 宿主自身变动归入 benign，但不静默 ===');
reset();
b = snapshotGlobals();
const ov = document.createElement('div');
ov.className = 'nx-insp-overlay';               // 检查器高亮层
document.body.appendChild(ov);
d = diffSnapshots(b, snapshotGlobals());
t('检查器高亮层不算泄漏', d.suspect.length === 0);
t('但 benign 里照样列出（不静默过滤）',
  d.benign.some((x) => x.includes('nx-insp-overlay')));

console.log('\n=== 5. 只报新增，不报减少 ===');
reset();
const tmp = document.createElement('span');
tmp.className = 'will-be-removed';
document.body.appendChild(tmp);
b = snapshotGlobals();
tmp.remove();                                    // 清理生效 = 减少
d = diffSnapshots(b, snapshotGlobals());
t('节点被移除不算残留', d.suspect.length === 0);

console.log('\n=== 6. 只读：快照本身不改任何东西 ===');
reset();
const before1 = snapshotGlobals();
const before2 = snapshotGlobals();
t('连拍两次结果一致（快照无副作用）',
  JSON.stringify(before1) === JSON.stringify(before2));

console.log('\n=== 7. 绝不阻断卸载（最重要的一条）===');
/*
 * 这是"安全不影响功能"的硬要求：
 * 校验自身炸了，也不能让卸载失败。
 */
const origErr = console.error;
const origWarn = console.warn;
const origInfo = console.info;
console.error = () => {};
console.warn = () => {};
console.info = () => {};

let threw = false;
try {
  /* 传 null 快照 —— 应当静默跳过，不抛 */
  auditUnmount('x', null);
  /* 快照函数被破坏（返回 null）时也要能扛住 */
  const r = auditUnmount('x', { windowKeys: null, headNodes: null, bodyNodes: null });
  threw = false;
  t('异常输入不抛错', r && Array.isArray(r.suspect));
} catch (e) {
  threw = true;
}
t('auditUnmount 永不 throw', threw === false);

console.error = origErr;
console.warn = origWarn;
console.info = origInfo;

console.log('\n=== 8. 接线：接入 safeTeardown ===');
const host = src('js/host.js');
t('host.js 引入校验模块',
  /import \{ snapshotGlobals, auditUnmount \} from '\.\/unmount-audit\.js'/.test(host));
t('before 在任何 await 之前拍（快照不能被并发流程弄脏）', (() => {
  const i = host.indexOf('async function safeTeardown(inst) {');
  const seg = host.slice(i, i + 1400);
  const jb = seg.indexOf('snapshotGlobals()');
  const ja = seg.indexOf('clearAppShortcuts');
  return jb >= 0 && ja >= 0 && jb < ja;
})());
/*
 * 用行号顺序判定，而不是一条大正则 ——
 * 大正则容易因为注释换行数变化而失效，且失效时表现为"通过"（假绿）。
 * 行序是硬事实：audit 必须在所有既有清理之后。
 */
t('audit 在所有既有清理之后（独立一步，失败不影响它们）', (() => {
  const lines = host.split('\n');
  const iClean = lines.findIndex((l) => l.includes('inst.cleanupFns?.forEach'));
  const iAudit = lines.findIndex((l) => l.includes('auditUnmount(inst.manifest'));
  const iTryEnd = lines.findIndex((l, i) => i > iClean && l.trim() === '}');
  return iClean >= 0 && iAudit > iClean && iAudit !== iTryEnd;
})());
t('audit 不在任何 try 块内（它的失败不该被当成卸载失败）', (() => {
  const i = host.indexOf('async function safeTeardown(inst) {');
  const seg = host.slice(i, i + 1600);
  const jc = seg.indexOf('inst.cleanupFns?.forEach');
  const ja = seg.indexOf('auditUnmount(inst.manifest');
  /* 两者之间不应出现 try { —— 出现就说明 audit 被包进了某个 try */
  /*
   * 起点要跳过 cleanupFns **那一行本身** —— 它自带 `try { fn(); }`，
   * 从它开头切片会把这个 try 算进来，断言恒假（这就是假绿的反面：假红）。
   */
  const jcEnd = seg.indexOf('\n', jc);
  const between = seg.slice(jcEnd, ja);
  return !between.includes('try {');
})());
t('auditUnmount 传入 manifest.id（报告能指名）',
  /auditUnmount\(inst\.manifest\?\.id, auditBefore\)/.test(host));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
