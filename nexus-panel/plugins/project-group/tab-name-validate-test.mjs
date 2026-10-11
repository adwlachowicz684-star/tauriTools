/**
 * 页签名校验回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/tab-name-validate-test.mjs
 *
 * 测的是上一轮记下、本轮修掉的这条：
 * **改名不校验非法字符**（`前端/后端`、`CON`、末尾句点）。
 * 新建与迁移两条路都走后端 `sys::validate_name`，改名这条**不走** ——
 * 于是改名收下、之后在该分类下建项目才炸（"错在 A、炸在 B"）。
 *
 * 判据是 `utils/tabs.ts::validateTabName`，与后端 `sys::validate_name_as`
 * 同一套规则。两份规则迟早漂移，所以这里**从 sys.rs 解析出**非法字符集、
 * 保留设备名清单与长度上限，与前端常量逐一比对 —— 改任一侧不同步另一侧就报红。
 * （与 clientDetect.ts 的 BUILTIN_CLIENT_IDS 是同一套做法。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SYS = path.join(ROOT, 'src-tauri/src/fpx/sys.rs');
const USE_FPX = path.join(HERE, 'hooks/useFpx.ts');

const src = fs.readFileSync(SYS, 'utf8');
const sysTxt = fs.existsSync(SYS) ? src : '';
const fpxTxt = fs.readFileSync(USE_FPX, 'utf8');

const T = await loadTs(path.join(HERE, 'utils/tabs.ts'));
const { t, done } = makeT();
const { validateTabName, TAB_NAME_ILLEGAL_CHARS, TAB_NAME_RESERVED, TAB_NAME_MAX_CHARS } = T;

/* ------------------------------------------------------------------ */
console.log('\n=== 0. 自检：sys.rs 必须读到，否则后面全是空跑 ===');
t('sys.rs 存在且非空', sysTxt.length > 1000, `${sysTxt.length} 字节`);
t('validate_name_as 在 sys.rs 里', sysTxt.includes('pub fn validate_name_as'));

/* ------------------------------------------------------------------ */
console.log('\n=== 1. 从 sys.rs 解析出后端的判据 ===');

/** 取 `matches!(c, ...)` 里的字符字面量 */
function rustIllegalChars() {
  const i = sysTxt.indexOf('matches!(c,');
  if (i < 0) return null;
  // 从 matches!( 的括号开始配平
  let d = 0, j = sysTxt.indexOf('(', i);
  for (; j < sysTxt.length; j++) {
    if (sysTxt[j] === '(') d++;
    else if (sysTxt[j] === ')') { d--; if (d === 0) break; }
  }
  const body = sysTxt.slice(i, j + 1);
  const out = [];
  const re = /'((?:\\.|[^'\\])*)'/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1].replace(/\\(.)/g, '$1'));
  return out;
}
const rustChars = rustIllegalChars();

/** 取 `const RESERVED: [&str; N] = [...]` 里的名字 */
function rustReserved() {
  const m = /const RESERVED:\s*\[&str;\s*\d+\]\s*=\s*\[([\s\S]*?)\];/.exec(sysTxt);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
const rustRes = rustReserved();

const rustMax = (() => {
  const m = /name\.chars\(\)\.count\(\)\s*>\s*(\d+)/.exec(sysTxt);
  return m ? Number(m[1]) : null;
})();

t('解析到后端非法字符集', Array.isArray(rustChars) && rustChars.length >= 9, String(rustChars));
t('解析到后端保留名清单', Array.isArray(rustRes) && rustRes.length >= 24, `${rustRes && rustRes.length} 个`);
t('解析到后端长度上限', rustMax === 120, String(rustMax));

console.log('\n=== 2. 漂移守卫：前端常量必须与 sys.rs 一致 ===');
const feChars = [...TAB_NAME_ILLEGAL_CHARS];
const feRes = [...TAB_NAME_RESERVED];
t('非法字符集与后端逐项相同',
  rustChars !== null && feChars.length === rustChars.length && feChars.every((c, i) => c === rustChars[i]),
  `前端 ${JSON.stringify(feChars)} / 后端 ${JSON.stringify(rustChars)}`);
t('保留名清单与后端逐项相同',
  rustRes !== null && feRes.length === rustRes.length && feRes.every((c, i) => c === rustRes[i]),
  `前端 ${feRes.length} 个 / 后端 ${rustRes && rustRes.length} 个`);
t('长度上限与后端相同', TAB_NAME_MAX_CHARS === rustMax, `${TAB_NAME_MAX_CHARS} / ${rustMax}`);

/* ------------------------------------------------------------------ */
console.log('\n=== 3. validateTabName：合法名字放行 ===');
for (const ok of ['前端', '页签2', 'a_b', '2024 Q1', '我的 项目', 'a.b']) {
  t(`「${ok}」合法`, validateTabName(ok) === null, String(validateTabName(ok)));
}
t('前后空白被 trim 后合法', validateTabName('  归档  ') === null, String(validateTabName('  归档  ')));
/* 常用词不能被保留名规则误伤（按主名判，`config` / `console` 都以 CON 开头） */
for (const ok of ['config', 'console', 'controller', 'CONTROL']) {
  t(`「${ok}」不是保留名`, validateTabName(ok) === null, String(validateTabName(ok)));
}

console.log('\n=== 4. validateTabName：非法名字给出原因 ===');
const bad = {
  '前端/后端': '不能包含',
  'A\\B': '不能包含',
  'A:B': '不能包含',
  'A*B': '不能包含',
  'A?B': '不能包含',
  'A"B': '不能包含',
  'A<B': '不能包含',
  'A>B': '不能包含',
  'A|B': '不能包含',
  '.': '不能是',
  '..': '不能是',
  '...': '不能是',
  'foo.': '句点',
  CON: '保留设备名',
  nul: '保留设备名',
  'CON.txt': '保留设备名',
  'com1': '保留设备名',
  'lpt9': '保留设备名',
};
for (const [n, kw] of Object.entries(bad)) {
  const r = validateTabName(n);
  t(`「${n}」被拒且原因含「${kw}」`, typeof r === 'string' && r.includes(kw), String(r));
}
t('空名被拒', typeof validateTabName('') === 'string', String(validateTabName('')));
t('纯空白被拒', typeof validateTabName('   ') === 'string', String(validateTabName('   ')));
t('控制符（\\u0007）被拒', typeof validateTabName('a\u0007b') === 'string', String(validateTabName('a\u0007b')));
t('U+009F 控制符被拒', typeof validateTabName('a\u009Fb') === 'string', String(validateTabName('a\u009Fb')));
t('超长（121 字）被拒', typeof validateTabName('x'.repeat(121)) === 'string');
t('刚好 120 字放行', validateTabName('x'.repeat(120)) === null);
/* 中文按字符数算：40 个汉字只有 120 字节，按字节判会误伤 */
t('40 个汉字放行（按字符数而非字节数）', validateTabName('项'.repeat(40)) === null, String(validateTabName('项'.repeat(40))));
t('报错里带得上是哪个名字（能定位）', String(validateTabName('前端/后端')).includes('前端/后端'),
  String(validateTabName('前端/后端')));

/* ------------------------------------------------------------------ */
console.log('\n=== 5. renameTab 必须真的调用它（且挡在写盘之前）===');
const ri = fpxTxt.indexOf('const renameTab');
t('找到 renameTab', ri > 0);
const seg = ri > 0 ? fpxTxt.slice(ri, ri + 3000) : '';
t('renameTab 里调用了 validateTabName', /validateTabName\(/.test(seg));
t('校验结果会报给用户（pushLog + toast）',
  /bad[\s\S]{0,400}pushLog\(bad,\s*true\)/.test(seg) && /ctx\.toast\(bad/.test(seg));
t('非法时直接 return，不走写盘',
  /if\s*\(bad\)\s*\{[\s\S]{0,300}?return;/.test(seg));
/* 顺序：校验必须早于 updateConfig，否则已经写盘了才拦 */
const iVal = seg.indexOf('validateTabName(');
const iUpd = seg.indexOf('updateConfig(');
t('校验在 updateConfig 之前', iVal > 0 && iUpd > 0 && iVal < iUpd, `validate@${iVal} updateConfig@${iUpd}`);
/* 重名检查保留（两条规则各有各的用处，不能互相顶掉） */
t('重名检查仍在（isTabNameTaken）', seg.includes('isTabNameTaken('));
t('从 utils/tabs 引入 validateTabName', /import\s*\{[^}]*validateTabName[^}]*\}\s*from\s*'\.\.\/utils\/tabs'/.test(fpxTxt));

done();
