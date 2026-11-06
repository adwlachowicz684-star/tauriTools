#!/usr/bin/env node
/**
 * 市场编排层「接线」欠账守卫
 * ============================================================================
 *
 * 为什么单独做这个守卫（不是 repeat orphan-modules-guard）
 * ------------------------------------------------------------
 * 第 48 轮远端把 6 条运行时欠账全部销空：入口闭包 10 个模块
 * safe 10 / blocked 0，隔离 realm 里能真加载、真解包、真校验、真卸载。
 * 但 market-runtime-debt.json 的 note 自己写着「能加载 ≠ 已被调用」。
 * 这句话此前**没有任何守卫验证**。orphan-modules-guard 判的是「模块级
 * 可达性」：只要 host.js 里出现一条 import，BFS 会把整组 9 个模块一起
 * 点亮并判为已接线 —— 几十个守卫全绿、体检单 0 红，产品里却没有装插件
 * 这个能力。本守卫只判「生产入口里有没有真的实例化」。
 *
 * 第 50 轮升级：三态，不把「代码接上了」当成「产品能力可用」
 * ------------------------------------------------------------
 *   unbound  生产入口零实例化
 *   wired    装配层就位、生产入口真实例化、三个能力各有调用点
 *   bound    还要 runtimeVerified=true（阶段 0 加载侧 + CSP 302 真机实测）
 *
 * 接线落地后仍停在 wired 是有原因的：install() 把插件落到
 * `${appDataDir}/installed-plugins/<id>/`，ledger 能记、list() 能列、
 * checkUpdates 能查、卸载能删；但「装完的插件被外壳加载并出现在侧边栏」
 * 属阶段 0 加载侧，资产 302 到 objects.githubusercontent.com 的 CSP 放行
 * 也未经真机确认。这两条没验完就写 bound，等于拿「能下载落盘」冒充
 * 「装了能用」——正是本项目反复栽的假绿。
 *
 * ⑥ 节钉住装配层自身的四条红线：零 node:、不是空壳（真调
 * createPluginMarket）、headerBox 引用共享（拷贝会让运行时输入的 PAT
 * 永远用不上且不报错）、凭据不落盘不进日志不内嵌。
 * ⑦ 节钉住三个能力在生产入口各自有调用点，防「只接了 list」。
 *
 * 已知边界：纯静态守卫挡不住「把主断言整行删掉或改成 true」。
 * 这一层靠每轮破坏验证兜，不假装能自证。
 *
 * 零外部依赖，按 import.meta.url 定位根，从任意 cwd 可跑。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const DEBT = join(ROOT, 'scripts', 'market-binding-debt.json');
const ASSEMBLY = join(ROOT, 'js', 'market-binding.js');
const STORE = join(ROOT, 'plugins', 'store', 'index.js');

/* 生产入口白名单：故意写死，不扫全仓。
 * 扫全仓会把守卫自己、测试、探针、构建产物里的调用字符串算成「已接线」，
 * 那是本守卫最要防的自证陷阱。新增生产入口时必须显式补这里。 */
const PROD_FILES = [
  'js/host.js',
  'js/shell.js',
  'plugins/store/index.js',
  'plugins/store/module.js',
  'plugins/settings/index.js',
  'plugins/home/index.js',
  'plugins/updater/module.js',
];

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/** 剥 // 与 /* *\/ 注释（保留字符串内的 // —— 注释里出现实例化形态
 *  是最常见的假接线来源，必须剥掉）。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const IMPORT_RE = /^\s*(?:import|export)\b.*\bcreatePluginMarket\b/m;
const DEF_RE = /^\s*(?:async\s+)?function\s+createPluginMarket\b|^\s*(?:const|let|var)\s+createPluginMarket\s*=\s*(?:async\s*)?\(?/m;
/** 实例化：编排层工厂或 webview 装配器出现在赋值/调用位置。
 *  装配器内部再调 createPluginMarket，由 ⑥b 单独钉，避免空壳骗过本判据。 */
const INSTANTIATE_RE = /(?:=\s*|return\s+|\bawait\s+)(?:createPluginMarket|createWebviewMarket)\s*\(/;

/** 从一段源码文本判「有没有真的实例化」。导出给元断言直接喂样例。 */
export function hasBinding(text) {
  const s = stripComments(String(text));
  const lines = s.split('\n');
  let importOrDefOnly = true;
  let instantiated = false;
  for (const line of lines) {
    if (IMPORT_RE.test(line) || DEF_RE.test(line)) continue;
    if (INSTANTIATE_RE.test(line)) {
      instantiated = true;
      importOrDefOnly = false;
    }
  }
  // 补充：整段里若出现实例化，即便被换行拆开也要认（避免只看单行漏判）
  if (!instantiated && INSTANTIATE_RE.test(s.replace(/\n/g, ' '))) {
    instantiated = true;
    importOrDefOnly = false;
  }
  return { instantiated, importOrDefOnly };
}

/** headerBox 引用契约：必须是 `headers: headerBox` 原样传引用。
 *  写成展开拷贝 / 新对象 / 字面量都会让运行时输入的 PAT 失效。 */
export function sharesHeaderBox(text) {
  const s = stripComments(String(text));
  const declared = /\b(?:const|let|var)\s+headerBox\s*=\s*\{\s*\}/.test(s);
  const passed = /\bheaders\s*:\s*headerBox\s*[,}]/.test(s);
  const copied = /\bheaders\s*:\s*\{\s*(?:\.\.\.\s*headerBox|\.\.\.\s*o\.headers)/.test(s)
              || /\bheaders\s*:\s*Object\.assign\s*\(/.test(s);
  return declared && passed && !copied;
}

function readProd() {
  const out = [];
  for (const rel of PROD_FILES) {
    const p = join(ROOT, rel);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    out.push({ rel, text: readFileSync(p, 'utf8') });
  }
  return out;
}

/** 实际接线状态：任一生产入口里出现实例化即算 wired */
function actualBinding(files) {
  const found = [];
  for (const f of files) {
    const r = hasBinding(f.text);
    if (r.instantiated) found.push(f.rel);
  }
  return found;
}

const TOKEN_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/;

/* ────────────────────────────────────────────────────────────────
 * 元断言：判据本身必须能区分多种形态。
 * 判据存在 ≠ 判据被验过（第 44/46/47 轮三次栽在这里）。
 * ──────────────────────────────────────────────────────────────── */
const SAMPLES = {
  A_instantiate: "const market = createPluginMarket({ fs, headers });",
  A2_assembly: "const wired = await createWebviewMarket({ getToken });",
  B_import_only: "import { createPluginMarket } from './plugin-market.js';",
  C_comment_only: "// const market = createPluginMarket({ fs });\nconst x = 1;",
  D_definition: "export function createPluginMarket(opts) { return opts; }",
  E_multiline: "const market =\n  createPluginMarket({ fs });",
  F_bare_call: "createPluginMarket({ fs });",
};
t('元断言 A：编排层真实例化判为接线', hasBinding(SAMPLES.A_instantiate).instantiated === true);
t('元断言 A2：装配器真实例化判为接线', hasBinding(SAMPLES.A2_assembly).instantiated === true);
t('元断言 B：只有 import 不判为接线', hasBinding(SAMPLES.B_import_only).instantiated === false);
t('元断言 C：注释里的调用不判为接线', hasBinding(SAMPLES.C_comment_only).instantiated === false);
t('元断言 D：函数定义不判为接线', hasBinding(SAMPLES.D_definition).instantiated === false);
t('元断言 E：换行拆开的实例化仍能识别', hasBinding(SAMPLES.E_multiline).instantiated === true);
t('元断言 F：剥注释不误伤 https:// 形态', stripComments("const u = 'https://api.github.com';").includes('https://api.github.com'));
t('元断言 G：headerBox 判据认「传引用」', sharesHeaderBox(
  'const headerBox = {}; const m = createPluginMarket({ headers: headerBox, fs });') === true);
t('元断言 H：headerBox 判据拒绝「展开拷贝」', sharesHeaderBox(
  'const headerBox = {}; const m = createPluginMarket({ headers: { ...headerBox }, fs });') === false);
t('元断言 I：headerBox 判据拒绝「没声明」', sharesHeaderBox(
  'const m = createPluginMarket({ headers: headerBox, fs });') === false);
/** fetch 默认回退形态：注入口不能把全局 fetch 顶掉。 */
export function hasFetchFallback(text) {
  return /\(\s*fetchFn\s*\|\|\s*fetch\s*\)\s*\(\s*url\s*,\s*opts\s*\)/.test(stripComments(String(text)));
}
t('元断言 M：认「fetchFn || fetch」回退形态', hasFetchFallback(
  'return (fetchFn || fetch)(url, opts);') === true);
t('元断言 N：拒绝「只有注入、没有全局回退」', hasFetchFallback(
  'return fetchFn(url, opts);') === false);

/* ① 台账存在且可解析 */
t('①a 台账文件存在', existsSync(DEBT));
let debt = null;
try { debt = JSON.parse(readFileSync(DEBT, 'utf8')); } catch (e) { debt = null; }
t('①b 台账是合法 JSON 且有 status', !!(debt && typeof debt.status === 'string'), debt ? debt.status : 'parse failed');
t('①c status 只能是 unbound / wired / bound',
  !!(debt && ['unbound', 'wired', 'bound'].includes(debt.status)));
t('①d 台账必须写明 blockers 与 unblock', !!(debt && Array.isArray(debt.blockers) && debt.blockers.length > 0 && Array.isArray(debt.unblock) && debt.unblock.length > 0));
t('①e runtimeVerified 必须是布尔', !!(debt && typeof debt.runtimeVerified === 'boolean'));

/* ② 实际接线状态必须与台账一致（双向） */
const prod = readProd();
t('②a 生产入口白名单全部存在', prod.length === PROD_FILES.length, `${prod.length}/${PROD_FILES.length}`);
const actual = actualBinding(prod);
const status = debt?.status;
const expectedWired = status === 'wired' || status === 'bound';
t('②b 实测接线状态 == 台账 status',
  (actual.length > 0) === expectedWired,
  `实测=${actual.length ? actual.join(',') : 'unbound'} 台账=${status}`);
t('②c unbound 时生产入口零实例化', expectedWired || actual.length === 0);
t('②d wired/bound 时必须附 evidence',
  !expectedWired || !!(debt?.evidence && String(debt.evidence).trim()));
t('②e bound 必须 runtimeVerified=true（阶段 0 + CSP 真机实测）',
  status !== 'bound' || debt?.runtimeVerified === true);
t('②f runtimeVerified=true 时 status 必须是 bound',
  debt?.runtimeVerified !== true || status === 'bound');

/* ③ 编排层自身不能重新引入 node:（第 48 轮销空成果的交叉钉） */
const marketPath = join(ROOT, 'js', 'plugin-market.js');
const marketSrc = existsSync(marketPath) ? readFileSync(marketPath, 'utf8') : '';
t('③a plugin-market.js 存在', !!marketSrc);
t('③b 编排层入口零 node: import', !/from\s*['"]node:/.test(stripComments(marketSrc)));
t('③c 编排层导出 createPluginMarket', /export\s+(?:async\s+)?function\s+createPluginMarket\b/.test(marketSrc));

/* ④ 凭据红线：生产文件里绝不内嵌 token */
const leaks = [];
for (const f of prod) if (TOKEN_RE.test(f.text)) leaks.push(f.rel);
t('④a 生产入口零内嵌凭据', leaks.length === 0, leaks.join(','));
/* 样例必须动态合成，不能把真 token 字面量写进仓库文件：
 * GitHub secret scanning 会拒收整个 blob（第 49 轮首次推送即被 422 拦下）。 */
const FAKE_TOKEN = 'github_pat_' + 'A'.repeat(40);
t('④b 凭据判据能认出真 token 形态', TOKEN_RE.test(FAKE_TOKEN));
t('④c 凭据判据不误伤普通字符串', !TOKEN_RE.test('const tokenFromUser = input.value;'));

/* ⑤ 台账欠账守恒：每个 blocker 必须有 why 与 options */
if (debt && Array.isArray(debt.blockers)) {
  const bad = debt.blockers.filter((b) => !b.id || !b.why || !Array.isArray(b.options) || b.options.length < 2);
  t('⑤a 每条 blocker 都有 id/why/options', bad.length === 0, bad.map((b) => b.id || '?').join(','));
  t('⑤b blocker 至少覆盖凭据、UI 动作、CSP、加载侧四类',
    ['credentials', 'ui-actions', 'csp-asset', 'runtime-load']
      .every((k) => debt.blockers.some((b) => b.id === k)));
}

/* ⑥ 装配层红线（第 50 轮新增） */
const asmSrc = existsSync(ASSEMBLY) ? readFileSync(ASSEMBLY, 'utf8') : '';
const asm = stripComments(asmSrc);
t('⑥a 装配层 js/market-binding.js 存在', !!asmSrc);
t('⑥b 装配层不是空壳：真调 createPluginMarket(',
  /(?:=\s*|return\s+)createPluginMarket\s*\(/.test(asm));
t('⑥c 装配层零 node: import', !/from\s*['"]node:/.test(asm));
t('⑥d headerBox 传引用（运行时输入的 PAT 才生效）', sharesHeaderBox(asmSrc));
t('⑥e 装配层不落盘（无 localStorage / sessionStorage / setItem）',
  !/\b(?:localStorage|sessionStorage|setItem)\b/.test(asm));
t('⑥f 装配层不进日志（无 console.*）', !/\bconsole\s*\./.test(asm));
t('⑥g 装配层零内嵌凭据', !TOKEN_RE.test(asmSrc));
t('⑥h 装配层明确导出 setToken（凭据可撤销）', /\bsetToken\b/.test(asm));
t('⑥i 生产入口 PAT 输入框是 password（不是明文）',
  /type\s*:\s*['"]password['"]/.test(readFileSync(STORE, 'utf8')));
t('⑥j 生产入口不把 PAT 写进任何存储',
  !/\b(?:localStorage|sessionStorage|setItem)\s*\(?[^;\n]*\b(?:sessionPat|pat|token)\b/i
    .test(stripComments(readFileSync(STORE, 'utf8'))));
/* 注入口只给测试用，不能把生产默认路径顶掉：
   少了这两条，装配层会「测试里能跑、产品里 createFs 不生效」。 */
t('⑥k 装配层默认路径含 createFs(invoke)', /\bcreateFs\s*\(\s*invoke\s*\)/.test(asm));
t('⑥l 装配层 fetch 默认回退到全局 fetch', hasFetchFallback(asmSrc));

/* ⑦ 三个能力各自有生产调用点（防「只接了 list」） */
const storeRaw = readFileSync(STORE, 'utf8');
const storeCode = stripComments(storeRaw);
for (const [label, re] of [
  ['list', /\bmarket\.list\s*\(/],
  ['install', /\bmarket\.install\s*\(/],
  ['uninstall', /\bmarket\.uninstall\s*\(/],
  ['checkUpdates', /\bmarket\.checkUpdates\s*\(/],
]) {
  /* 描述里刻意不写方法名+括号：async-call-await-test ⑤ 全仓扫调用点，
     断言文案里的 `xxx()` 会被当成真调用报「漏 await」。 */
  t(`⑦ 生产入口调用 market.${label} 方法`, re.test(storeCode));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
