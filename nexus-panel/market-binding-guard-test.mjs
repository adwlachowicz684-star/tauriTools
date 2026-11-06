#!/usr/bin/env node
/**
 * 市场编排层「接线」欠账守卫
 * ============================================================================
 *
 * 为什么单独做这个守卫（不是 repeat orphan-modules-guard）
 * ------------------------------------------------------------
 * 第 48 轮远端把 6 条运行时欠账全部销空：入口闭包 10 个模块
 * safe 10 / blocked 0，隔离 realm 里能真加载、真解包、真校验、真卸载。
 * 但 market-runtime-debt.json 的 note 自己写着：
 *
 *   「🔴 能加载 ≠ 已被调用：产品里仍没有一处实例化编排层，
 *     装/卸/查更新能力依旧不存在」
 *
 * 这句话此前**没有任何守卫验证**。orphan-modules-guard 判的是「模块级
 * 可达性」：只要 host.js 里出现一条 import，BFS 会把整组 9 个模块一起
 * 点亮并判为已接线（该文件头第 4 节已把这条列为固有边界）。于是会出现
 * 本项目反复栽的形状——几十个守卫全绿、体检单 0 红，产品里却没有装
 * 插件这个能力。
 *
 * 本守卫不判「import 有没有」，只判「生产入口里有没有真的实例化」，
 * 并把当前 unbound 状态登记成台账：有人接线 → 红，逼你销账；台账改成
 * bound 却没接线 → 也红。集合恒真类陷阱（status 与实测都为空/都一致
 * 时判据不执行）由元断言 A–F 兜住。
 *
 * 已知边界：纯静态守卫挡不住「把主断言整行删掉或改成 true」。
 * 这一层靠每轮破坏验证兜，不假装能自证。
 *
 * 零外部依赖，按 import.meta.url 定位根，从任意 cwd 可跑。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const DEBT = join(ROOT, 'scripts', 'market-binding-debt.json');

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

/** 剥 // 与 /* *\/ 注释（保留字符串内的 // —— 本判据只看调用形态，
 *  但注释里出现 createPluginMarket 是最常见的假接线来源，必须剥掉）。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const IMPORT_RE = /^\s*(?:import|export)\b.*\bcreatePluginMarket\b/m;
const DEF_RE = /^\s*(?:async\s+)?function\s+createPluginMarket\b|^\s*(?:const|let|var)\s+createPluginMarket\s*=\s*(?:async\s*)?\(?/m;
/** 实例化：createPluginMarket( 出现在赋值/调用位置，且不是 import / 定义行 */
const INSTANTIATE_RE = /(?:=\s*|return\s+|\bawait\s+)createPluginMarket\s*\(/;

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

function readProd() {
  const out = [];
  for (const rel of PROD_FILES) {
    const p = join(ROOT, rel);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    out.push({ rel, text: readFileSync(p, 'utf8') });
  }
  return out;
}

/** 实际接线状态：任一生产入口里出现实例化即算 bound */
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
 * 元断言：判据本身必须能区分五种形态。
 * 判据存在 ≠ 判据被验过（第 44/46/47 轮三次栽在这里）。
 * ──────────────────────────────────────────────────────────────── */
const SAMPLES = {
  A_instantiate: "const market = createPluginMarket({ fs, headers });",
  B_import_only: "import { createPluginMarket } from './plugin-market.js';",
  C_comment_only: "// const market = createPluginMarket({ fs });\nconst x = 1;",
  D_definition: "export function createPluginMarket(opts) { return opts; }",
  E_multiline: "const market =\n  createPluginMarket({ fs });",
  F_bare_call: "createPluginMarket({ fs });",
};
t('元断言 A：真实例化判为 bound', hasBinding(SAMPLES.A_instantiate).instantiated === true);
t('元断言 B：只有 import 不判为接线', hasBinding(SAMPLES.B_import_only).instantiated === false);
t('元断言 C：注释里的调用不判为接线', hasBinding(SAMPLES.C_comment_only).instantiated === false);
t('元断言 D：函数定义不判为接线', hasBinding(SAMPLES.D_definition).instantiated === false);
t('元断言 E：换行拆开的实例化仍能识别', hasBinding(SAMPLES.E_multiline).instantiated === true);
t('元断言 F：剥注释不误伤 https:// 形态', stripComments("const u = 'https://api.github.com';").includes('https://api.github.com'));

/* ① 台账存在且可解析 */
t('①a 台账文件存在', existsSync(DEBT));
let debt = null;
try { debt = JSON.parse(readFileSync(DEBT, 'utf8')); } catch (e) { debt = null; }
t('①b 台账是合法 JSON 且有 status', !!(debt && typeof debt.status === 'string'), debt ? debt.status : 'parse failed');
t('①c status 只能是 unbound / bound', !!(debt && ['unbound', 'bound'].includes(debt.status)));
t('①d 台账必须写明 blockers 与 unblock', !!(debt && Array.isArray(debt.blockers) && debt.blockers.length > 0 && Array.isArray(debt.unblock) && debt.unblock.length > 0));

/* ② 实际接线状态必须与台账一致（双向） */
const prod = readProd();
t('②a 生产入口白名单全部存在', prod.length === PROD_FILES.length, `${prod.length}/${PROD_FILES.length}`);
const actual = actualBinding(prod);
const expectedBound = debt?.status === 'bound';
t('②b 实测接线状态 == 台账 status',
  (actual.length > 0) === expectedBound,
  `实测=${actual.length ? actual.join(',') : 'unbound'} 台账=${debt?.status}`);
t('②c unbound 时生产入口零实例化', expectedBound || actual.length === 0);
t('②d bound 时必须附 evidence', !expectedBound || !!(debt.evidence && String(debt.evidence).trim()));

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
 * GitHub secret scanning 会拒收整个 blob（本轮首次推送即被 422 拦下）。
 * 判据验的是「形态」，合成串与真凭据同形，足够了。 */
const FAKE_TOKEN = 'github_pat_' + 'A'.repeat(40);
t('④b 凭据判据能认出真 token 形态', TOKEN_RE.test(FAKE_TOKEN));
t('④c 凭据判据不误伤普通字符串', !TOKEN_RE.test('const tokenFromUser = input.value;'));

/* ⑤ 台账欠账守恒：每个 blocker 必须有 why 与 options */
if (debt && Array.isArray(debt.blockers)) {
  const bad = debt.blockers.filter((b) => !b.id || !b.why || !Array.isArray(b.options) || b.options.length < 2);
  t('⑤a 每条 blocker 都有 id/why/options', bad.length === 0, bad.map((b) => b.id || '?').join(','));
  t('⑤b blocker 至少覆盖凭据、UI 动作、CSP 三类',
    ['credentials', 'ui-actions', 'csp-asset'].every((k) => debt.blockers.some((b) => b.id === k)));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
