/**
 * 插件市场编排层 · 返回对象形态守卫
 * ============================================================================
 *
 * 起因（第 40 轮）：js/plugin-market.js 的 `createPluginMarket` 返回对象里
 * 曾并存**两个同名 `async uninstall`**，第一个是 install() 的半截复制粘贴：
 * 它的失败分支引用了未定义的 `warnings`，成功分支引用了 `mf` / `sha` /
 * `r.replaced` / `r.dir` —— 这些标识符在 uninstall 作用域里一个都不存在。
 *
 * 为什么 93 项端到端测试全绿却没发现：对象字面量里同名方法**后者覆盖前者**，
 * 语法完全合法，`node --check` 通过，运行时走的恰好是后面那个正确实现。
 * 所以这不是「产品崩了」，是**死代码 + 守卫缺口**：哪天有人删掉或改名第二个
 * 方法，第一个立刻 ReferenceError，而所有现有测试在此之前一直绿着。
 *
 * 本守卫守两件现有测试守不到的事：
 *   ① 返回对象内不得有重复方法名（静态判据，判据本身配元断言）
 *   ② 单个方法体内不得出现只属于别的方法的悬空标识符
 *      —— 判据必须**限定在 uninstall 体内**，否则 install 里合法的 mf./sha
 *         会让判据恒红，恒红的判据等于没人看。
 *
 * ⚠️ 已知边界：纯静态守卫挡不住「把断言本身删掉」。这层和本项目其它守卫
 * 一样，靠每次改动时的破坏验证兜；文件里另配 4 条元断言防判据假绿/恒真/空扫。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'js', 'plugin-market.js');

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`❌ ${name}${detail ? ` → ${detail}` : ''}`);
  }
}
function summary() {
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
}

/* 括号计数定位 return 对象的边界。模板字符串里的 `${...}` 与嵌套对象字面量
   都是成对出现，净计数为 0，不会把外层结束括号认错。 */
function matchBrace(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (c === '{') d += 1;
    else if (c === '}' && (d -= 1) === 0) return i;
  }
  return -1;
}

function returnBlock(src) {
  const f = src.indexOf('export function createPluginMarket');
  if (f < 0) return null;
  const r = src.indexOf('return {', f);
  if (r < 0) return null;
  const open = src.indexOf('{', r);
  const end = matchBrace(src, open);
  return end < 0 ? null : src.slice(open + 1, end);
}

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'try', 'do',
]);

/* 对象方法统一是 4 空格缩进；6 空格缩进的 `return {...}` 不会命中。 */
function methodNames(block) {
  if (block == null) return [];
  const out = [];
  const re = /^ {4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(block)) !== null) if (!RESERVED.has(m[1])) out.push(m[1]);
  return out;
}
function hasDup(names) {
  return new Set(names).size !== names.length;
}
function dupNames(names) {
  return [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
}

function methodBody(block, name) {
  if (block == null) return null;
  const re = new RegExp(`^ {4}(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const m = re.exec(block);
  if (!m) return null;
  /* 不能用 block.indexOf('{', m.index)：`uninstall(id, opts = {}) {` 里
     第一个 `{` 是参数默认值，不是方法体。正则以 `\{` 收尾，m[0] 的
     最后一个字符才是方法体起始括号。踩过一次：取错括号时 body 长度为 0，
     而空串让「不含悬空引用」判据恒真 —— ③a 的规模断言把这次假绿喊了出来。 */
  const open = m.index + m[0].length - 1;
  const end = matchBrace(block, open);
  return end < 0 ? null : block.slice(open + 1, end);
}

/* 残缺副本的特征片段：只用于元断言，证明悬空标识符判据不是恒假。 */
const LEGACY_SNIPPET = [
  '          warnings };',
  '      warnings.push(...rec.warnings);',
  '      return { ok: true, id, version: mf.manifest.version, replaced: r.replaced,',
  '        dir: r.dir, sha, warnings, errors: [] };',
].join('\n');

const DANGLING = /\bmf\.|\bsha\b|\br\.replaced\b|\br\.dir\b|\bwarnings\b/;

try {
  const src = readFileSync(SRC, 'utf8');
  const block = returnBlock(src);
  const names = methodNames(block);

  /* ① 扫描范围与形态 */
  t('①a 能定位 createPluginMarket 的 return 对象块', block != null && block.length > 100,
    block == null ? 'block=null' : `len=${block.length}`);
  t('①b 扫描范围非空：至少提取到 6 个方法名（防空集合恒绿）', names.length >= 6,
    `实得 ${names.length}: ${names.join(',')}`);
  t('①c 主判据：返回对象内没有重复方法名', !hasDup(names), dupNames(names).join(','));
  t('①d 必备方法齐全', ['list', 'checkUpdates', 'readData', 'writeData', 'install', 'uninstall']
    .every((n) => names.includes(n)), names.join(','));

  /* ② 判据自身的元断言
     第 46 轮：list() 变成 async list() 后，原先写死的注入锚点
     '    list() {' 不再命中，src.replace 空转 —— ②a/②c 一起红，
     但那不是「抓到了缺陷」，是**注入根本没生效**。这个形状在第 40 轮
     就踩过一次（改函数签名打断文本锚点），所以锚点用正则兼容 async，
     并先断言它真的命中、真的改了文本。 */
  const LIST_DEF = /^ {4}(?:async\s+)?list\s*\(\)\s*\{/m;
  const anchor = LIST_DEF.exec(src);
  t('②′ 注入锚点命中 list 定义（async 化后仍有效）', anchor != null,
    anchor ? anchor[0] : 'not found');
  const injected = anchor
    ? src.replace(anchor[0], `${anchor[0]} return 0; },\n    list() {`)
    : src;
  t('②″ 注入确实改变了源码文本（防 replace 空转）', injected !== src);
  const injNames = methodNames(returnBlock(injected));
  t('②a 注入同名方法后判据报重复（防恒假）', hasDup(injNames), `注入后=${injNames.length}`);
  t('②b 判据对干净源码返回「无重复」（防恒真）', hasDup(names) === false);
  t('②c 重复项能被点名', dupNames(injNames).includes('list'), dupNames(injNames).join(','));
  t('②d 空块/ null 块不会冒充「无重复」', methodNames('').length === 0
    && methodNames(null).length === 0 && hasDup([]) === false);

  /* ③ 悬空标识符，判据限定在 uninstall 体内 */
  const body = methodBody(block, 'uninstall');
  t('③a 能定位 uninstall 方法体', body != null && body.length > 100,
    body == null ? 'body=null' : `len=${body.length}`);
  t('③b 主判据：uninstall 体内没有 install 专属悬空引用',
    body != null && !DANGLING.test(body),
    body ? String((body.match(DANGLING) || [''])[0]) : 'body=null');
  t('③c 全文件确实存在 mf./sha（证明判据范围没有误扩到整个文件）',
    /\bmf\./.test(src) && /\bsha\b/.test(src));
  t('③d 把残缺副本喂给判据会被抓住（防恒假）', DANGLING.test(LEGACY_SNIPPET));
  t('③e 正确实现不含残缺副本的收尾行', body != null
    && !body.includes('dir: r.dir, sha, warnings, errors: []'));

  /* ④ 行为层：生效的那个 uninstall 必须还能调用（不抛 ReferenceError） */
  const mod = await import('./js/plugin-market.js');
  try {
    const market = mod.createPluginMarket({
      installedDir: join(ROOT, '.shape-no-such-installed-dir'),
      ledgerFile: join(ROOT, '.shape-no-such-ledger.json'),
      dataRoot: join(ROOT, '.shape-no-such-data-root'),
      fetch: async () => { throw new Error('shape guard 不发网络请求'); },
    });
    const r = await market.uninstall('definitely-not-installed');
    t('④a 调用 uninstall 返回结构化结果（没抛 ReferenceError）',
      r != null && typeof r === 'object', JSON.stringify(r));
    t('④b 未安装时返回 ok:false 且有明确原因', r && r.ok === false
      && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
  } catch (e) {
    t('④a 调用 uninstall 不抛异常', false, e && e.message);
    t('④b 未安装时返回 ok:false 且有明确原因', false, 'unreachable');
  }
} catch (e) {
  t('守卫执行期间不得抛异常（崩了要显式报红并保留汇总行）', false,
    e && e.message ? e.message : String(e));
} finally {
  summary();
}
