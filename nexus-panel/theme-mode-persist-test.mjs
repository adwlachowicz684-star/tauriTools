#!/usr/bin/env node
/**
 * 外观模式（原生 / 跟随面板）落盘守卫。
 *
 * ------------------------------------------------------------------
 * 为什么单独立一份
 * ------------------------------------------------------------------
 *
 * 这是整个面板里**第三个**"写了存储却不说"的地方，前两个已经修掉：
 *   · js/theme-manager.js  → takePersistError()（settings 插件在用）
 *   · plugins/settings/App.tsx → 各写入点改判据
 *
 * 而 agent-flow 有自己的一套：`af:theme-mode`。它**不经过** theme-manager，
 * 所以那两处修补完全管不到它。旧写法是
 *
 *     try { localStorage.setItem(THEME_MODE_KEY, mode); } catch { /* 忽略 *\/ }
 *
 * 写不进去时异常被吞，但 `dataset.afMode` **已经改了** —— 下拉框显示「原生」、
 * 画布当场就变。界面上没有任何"没存下"的线索，用户只会在重启后发现它
 * 变回「跟随面板」，然后归因成"这功能不记事儿"，一遍遍重选。
 *
 * 它属于**整个插件**的偏好（注释里明写"换画布不会变"），
 * 所以静默回退的代价是长期的。
 *
 * ------------------------------------------------------------------
 * 判据跑真身
 * ------------------------------------------------------------------
 *
 * 下面的 applyThemeMode 是**从 App.tsx 里切出来实跑**的，不是看源码里
 * 有没有那几个字 —— 看字面的判据会在"改成 return 却 return 错值"时照样绿。
 */
import fs from 'node:fs';
import { stripCommentsJs } from './test-scan-utils.mjs';

const APP = 'plugins/agent-flow/App.tsx';
const INS = 'plugins/agent-flow/components/Inspector.tsx';
const CCP = 'plugins/agent-flow/components/inspectors/CanvasConfigPanel.tsx';

let pass = 0;
let fail = 0;
const t = (name, ok, note = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${note ? ` → ${note}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${note ? ` → ${note}` : ''}`); }
};

const read = (p) => fs.readFileSync(p, 'utf8');
/**
 * 剥注释后的源码。
 *
 * ⚠️ 必须剥：本轮修的时候，说明里原样写了「没能记住」这几个字，
 *    不剥注释的话，下面"界面要显示提示"这条断言会被**注释喂饱** ——
 *    真把提示删掉它也照样绿。这是本项目踩过第三次的坑。
 */
const bare = (p) => stripCommentsJs(read(p));

/* ---------------- 1. 切片：取出 applyThemeMode 真身 ---------------- */

function sliceFn(src, head) {
  const i = src.indexOf(head);
  if (i < 0) return '';
  const j = src.indexOf('{', i);
  if (j < 0) return '';
  let d = 0;
  for (let k = j; k < src.length; k += 1) {
    if (src[k] === '{') d += 1;
    else if (src[k] === '}') { d -= 1; if (d === 0) return src.slice(i, k + 1); }
  }
  return '';
}

const appRaw = read(APP);
const fnRaw = sliceFn(appRaw, 'function applyThemeMode');
/*
 * 剥掉 TS 标注才能在 node 里直接跑。
 *
 * ⚠️ 第一版只剥了**返回值**标注（`: boolean`），没剥参数标注（`: ThemeMode`）。
 *    反向验证时一撤修复，签名变回 `(mode: ThemeMode)`，转译漏掉它，
 *    `new Function` 直接 SyntaxError —— 脚本**崩在半路**，
 *    后面 17 条断言一条都没跑，报告上只留 1 条红。
 *
 *    这比"断言写错"更糟：崩掉的脚本连"自己没在干活"都不会告诉你。
 *    所以这里**整段签名一起换掉**（参数标注 + 返回值标注），
 *    并在下面加一条"必须能编译"的断言，编译不过就报红而不是崩。
 */
const fnSrc = fnRaw.replace(
  /function applyThemeMode[^{]*\{/,
  'function applyThemeMode(mode) {',
);

t('能从 App.tsx 切出 applyThemeMode 真身', fnRaw.length > 0
  && /localStorage\.setItem/.test(fnRaw) && /documentElement\.dataset/.test(fnRaw),
  `${fnRaw.length} 字符`);
t('切出来的是本轮改过的形态（带返回值的 TS 标注）', /:\s*boolean\s*\{/.test(fnRaw));

const KEY = (bare(APP).match(/const THEME_MODE_KEY\s*=\s*'([^']+)'/) || [])[1];
t('取到真实存储键名', !!KEY, KEY || '未取到');

/* ---------------- 2. 实跑：存得下 / 存不下 ---------------- */

/**
 * 用可控的存储替身跑真身。
 * throwOnSet = true 模拟配额满 / 隐私模式 / 隔离 iframe 拿不到存储。
 */
function run(src, mode, { throwOnSet = false } = {}) {
  const writes = [];
  const ls = {
    getItem: () => null,
    setItem: (k, v) => {
      writes.push([k, v]);
      if (throwOnSet) throw new Error('QuotaExceededError');
    },
  };
  const ds = {};
  const doc = { documentElement: { dataset: ds } };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'localStorage', 'document', 'THEME_MODE_KEY',
    `${src}\nreturn applyThemeMode;`,
  );
  const fn = factory(ls, doc, KEY);
  const ret = fn(mode);
  return { ret, writes, ds };
}

/*
 * 编译闸门：转译不干净时**报红**，不能让脚本崩掉。
 * 崩掉的脚本会把后面全部断言吃掉 —— 报告上看着"只有 1 条红"，
 * 实际是这一整份测试当时不可信。
 */
let compiled = true;
try {
  // eslint-disable-next-line no-new-func
  new Function(`${fnSrc}\nreturn applyThemeMode;`);
} catch (e) {
  compiled = false;
  console.log(`   ⛔ 转译失败：${String(e).slice(0, 80)}`);
}
t('切出的函数能编译（转译没漏掉类型标注）', compiled);
if (!compiled) {
  // 不能继续跑 —— 后面每条 run() 都会抛，脚本崩掉反而掩盖真正的红
  console.log('\n⛔ 转译失败，后续断言无法进行，按失败退出');
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

const okRun = run(fnSrc, 'native');
t('存得下 → 返回 true', okRun.ret === true, `返回 ${okRun.ret}`);
t('存得下 → 确实写了一次，且用的是真实键名',
  okRun.writes.length === 1 && okRun.writes[0][0] === KEY && okRun.writes[0][1] === 'native',
  JSON.stringify(okRun.writes));

const badRun = run(fnSrc, 'native', { throwOnSet: true });
t('存不下 → 返回 false', badRun.ret === false, `返回 ${badRun.ret}`);
t('存不下时仍然尝试写过（不是提前返回）', badRun.writes.length === 1);

/*
 * 这条是整个缺陷的**形状证明**：
 * 视觉切换与落盘是两步，落盘失败不影响第一步 ——
 * 所以界面当场就变了，用户据此认定"存下了"。
 */
t('存不下时 dataset 照样被改（界面当场生效，正是被误认成"已保存"的来源）',
  badRun.ds.afMode === 'native', `afMode=${badRun.ds.afMode}`);

/* ---------------- 3. 元断言：判据必须能认出旧写法 ---------------- */

const OLD_FN = [
  'function applyThemeMode(mode) {',
  '  document.documentElement.dataset.afMode = mode;',
  '  try { localStorage.setItem(THEME_MODE_KEY, mode); } catch { /* 忽略 */ }',
  '}',
].join('\n');

const oldBad = run(OLD_FN, 'native', { throwOnSet: true });
t('元断言：旧写法在存不下时不返回 false（判据能区分，不是恒绿）',
  oldBad.ret !== false, `旧写法返回 ${oldBad.ret}`);
t('元断言：旧写法同样会改 dataset（缺陷的可见性来源一致）',
  oldBad.ds.afMode === 'native');

/* ---------------- 4. 界面：必须把"没记住"说出来 ---------------- */

const appBare = bare(APP);
const insBare = bare(INS);
const ccpBare = bare(CCP);

t('App.tsx 把落盘结果传给了界面', /themePersistFailed=\{!themePersistOk\}/.test(appBare));
t('App.tsx 用块体 useEffect 收返回值',
  /useEffect\(\(\)\s*=>\s*\{\s*setThemePersistOk\(applyThemeMode\(themeMode\)\);\s*\}, \[themeMode\]\);/.test(appBare));
/*
 * ⚠️ 这条单独钉住一个 React 陷阱：写成 `useEffect(() => applyThemeMode(...))`
 *    —— applyThemeMode 现在返回布尔值，React 会把返回值当成**清理函数**，
 *    报"effect 不能返回非函数值"。这不是风格问题，是运行时警告。
 */
t('App.tsx 没有把 applyThemeMode 的返回值直接当 effect 返回值',
  !/useEffect\(\(\)\s*=>\s*applyThemeMode\(/.test(appBare));

t('Inspector 声明了 themePersistFailed', /themePersistFailed\?: boolean;/.test(insBare));
t('Inspector 解构了 themePersistFailed', /themeMode, onThemeModeChange, themePersistFailed,/.test(insBare));
t('Inspector 把它透传下去', /themePersistFailed=\{themePersistFailed\}/.test(insBare));

t('CanvasConfigPanel 声明了 themePersistFailed', /themePersistFailed\?: boolean;/.test(ccpBare));
t('CanvasConfigPanel 解构了 themePersistFailed', /themeMode, onThemeModeChange, themePersistFailed,/.test(ccpBare));
t('CanvasConfigPanel 在失败时渲染提示', /themePersistFailed \? \(/.test(ccpBare) && /没能记住/.test(ccpBare));
t('折叠标题上也带标记（收起后仍看得见）', /⚠ 未记住/.test(ccpBare));

/*
 * 元断言：剥注释真的生效了。
 * 少了这条，"界面要显示提示"会被我自己的说明注释喂饱 —— 删掉提示也全绿。
 */
const ccpRaw = read(CCP);
const nRaw = ccpRaw.split('没能记住').length - 1;
const nBare = ccpBare.split('没能记住').length - 1;
t('元断言：剥注释确实去掉了说明里的同名字样（断言不是被注释喂饱的）',
  nRaw > nBare, `原文 ${nRaw} 处 / 剥注释后 ${nBare} 处`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
