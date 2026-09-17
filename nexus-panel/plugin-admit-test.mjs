/**
 * 插件静态准入 —— 行为测试
 *
 * 全部用**真实 AST 解析**跑，不是查源码字符串。
 * 重点验证"正则会漏的写法这里能抓住"，因为那才是 AST 的意义所在。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let mod;
try {
  mod = await import('./js/plugin-admit.js');
} catch (e) {
  console.error('❌ 无法加载 plugin-admit.js（缺 acorn / esbuild？）:', e.message);
  process.exit(1);
}
const { scanCode, scanFileText, admit, renderMember, isGlobalRoot, toJs } = mod;

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); }
};

/** 判定一段代码的级别 */
const level = (code) => {
  const r = scanCode(code, { file: 't.js' });
  if (r.error) return 'error';
  return r.deny.length ? 'deny' : (r.review.length ? 'review' : 'clean');
};

console.log('=== 1. 红区：不可撤销 / 危险 → deny ===');
t('customElements.define（无法 undefine，进程内永久残留）',
  level("customElements.define('x', class{});") === 'deny');
t('Service Worker 注册（注册到 origin，跨会话残留）',
  level('navigator.serviceWorker.register("/sw.js");') === 'deny');
t('原型修改（全局生效，影响其它插件）',
  level('Array.prototype.foo = 1;') === 'deny');
t('Object.defineProperty 到 window（可能锁死宿主 API）',
  level('Object.defineProperty(window, "a", {});') === 'deny');
t('location.href = （主面板被导航走）',
  level('location.href = "http://x";') === 'deny');
t('history.pushState（主面板被导航走）',
  level('history.pushState({}, "", "/x");') === 'deny');

console.log('\n=== 2. 黄区：应走 owned，不阻断 → review ===');
t('往 window 挂属性', level('window.myGlobal = 1;') === 'review');
t('document.body.appendChild（portal）',
  level('document.body.appendChild(el);') === 'review');
t('window.setInterval（定时器）', level('window.setInterval(fn, 100);') === 'review');

console.log('\n=== 3. 关键：正则会漏的写法（AST 的意义所在）===');
/*
 * 这几条如果用正则扫 `customElements.define`，全部会漏 ——
 * 它们就是"白名单看着在、其实形同虚设"的典型。
 */
t('动态成员调用 → 虽判不了 deny，但**不当没看见**（进 review）',
  level("window['custom' + 'Elements'].define('x', class{});") === 'review');
t('动态成员赋值 → 进 review', level('window[name] = 1;') === 'review');
t('字符串里提到不算命中（不会误报）',
  level('const s = "customElements.define 是危险的";') === 'clean');
t('注释里提到不算命中（不会误报）',
  level('// customElements.define\nconst a = 1;') === 'clean');

console.log('\n=== 4. 正常代码必须放行（安全不能影响功能）===');
t('普通模块代码 clean', level('const a = 1; export default a;') === 'clean');
t('容器内的 DOM 操作不算污染宿主',
  level('const el = document.createElement("div"); root.appendChild(el);') === 'clean');
t('对象自身属性赋值 clean', level('const o = {}; o.a = 1;') === 'clean');
t('数组操作 clean', level('const a = []; a.push(1);') === 'clean');

console.log('\n=== 5. 准入判定 ===');
t('有 deny → 拒绝', admit(scanCode("customElements.define('x',class{});")).ok === false);
t('只有 review → 放行（不阻断）', admit(scanCode('window.a = 1;')).ok === true);
t('干净 → 放行', admit(scanCode('const a = 1;')).ok === true);

console.log('\n=== 6. TS / TSX 能扫（否则危险会藏在解析不了的文件里）===');
{
  const r = scanFileText('const x: number = 1; window.foo = x;', 'a.ts');
  t('TS 文件无解析错误', !r.error);
  t('TS 文件里的 window 赋值被抓到', r.review.length >= 1);

  const r2 = scanFileText(
    'const A = () => { customElements.define("x", class{}); return null; };',
    'b.tsx',
  );
  t('TSX 文件无解析错误', !r2.error);
  t('TSX 里的 customElements.define 被判 deny', r2.deny.length === 1);
}

console.log('\n=== 7. 解析失败必须暴露，不能当"没问题" ===');
{
  const r = scanCode('const = = = ;;;', { file: 'bad.js' });
  t('语法错误被报出（而不是静默返回空）', !!r.error);
  t('解析失败时 deny 为空 —— 但 error 字段在，调用方不能当成干净',
    r.deny.length === 0 && !!r.error);
}

console.log('\n=== 8. 辅助函数 ===');
{
  const ast = (await import('acorn')).parse('window.document.body', { ecmaVersion: 2022 });
  const mem = ast.body[0].expression;
  t('renderMember 渲染点号串', renderMember(mem) === 'window.document.body');
  t('isGlobalRoot 认出宿主全局', isGlobalRoot(mem) === true);
  t('isGlobalRoot 不认局部对象',
    isGlobalRoot((await import('acorn')).parse('a.b.c', { ecmaVersion: 2022 }).body[0].expression) === false);
  t('toJs 对 .js 原样返回', toJs('const a = 1;', 'x.js').code === 'const a = 1;');
}

console.log('\n=== 9. 现实：当前全部插件无 deny ===');
/*
 * 这条是"安全不影响功能"的实地验证：
 * 现有插件不该被这道闸门挡住，否则就是误伤。
 */
{
  const out = src('scripts/scan-admit.mjs');
  t('扫描脚本排除了第三方目录（editor/dist/node_modules）',
    /'node_modules', 'dist', 'editor', 'build', '.git'/.test(out));
  /*
   * 直接对 EXTS 正则求值，而不是写第二份正则去匹配它 ——
   * 写两份的话，改了脚本这边不会跟着变，断言就成了摆设。
   */
  const extsRe = new RegExp(out.match(/const EXTS = (\/.*\/)/)?.[1]?.replace(/^\/|\/$/g, '') || '(?!)');
  t('扫描脚本把 TS/TSX 纳入',
    ['a.ts', 'a.tsx', 'a.jsx', 'a.js'].every((f) => extsRe.test(f)));
  t('扫描脚本不收无关后缀', !extsRe.test('a.json') && !extsRe.test('a.css'));
  t('解析失败会被单列出来（不混进"没问题"）',
    /解析失败 \$\{errors\.length\} 个/.test(out));
}

console.log('\n=== 10. 局限已写明（不夸大能力）===');
const admit_src = src('js/plugin-admit.js');
t('写明解构后调用绕得过', /解构后调用绕得过/.test(admit_src));
t('写明只在构建/CI 期跑（esbuild 进不了前端产物）',
  /只在构建\/CI 期跑/.test(admit_src));
t('写明运行时靠 iframe 兜底', /iframe/.test(admit_src));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
