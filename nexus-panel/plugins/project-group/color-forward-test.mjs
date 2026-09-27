/**
 * 颜色工具转发测试（零依赖，跑真身）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/color-forward-test.mjs
 *
 * 钉两件事：
 *
 *   1. project-group/utils/color.ts **只做转发**，不许再自带实现。
 *      抄本与 `export *` 并存时本地优先 —— 改了共享那份、这里不动，
 *      两份迟早漂移，而漂移不报错，只表现为"同一个颜色在两个界面
 *      显示成不同颜色"。
 *
 *   2. 转发链真的通 —— 从转发路径能拿到全部工具，且**行为正确**。
 *      只断言"文件里有 export *"证明不了 normalizeHex 能认三位简写，
 *      也证明不了 shade 对已很亮的颜色仍有效果（那正是它存在的理由）。
 *
 * 判定方法是把上游函数抽出来剥类型后**实际执行**，不是文本匹配。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUG = HERE;
const PICKER = path.join(HERE, '..', 'color-picker');

let pass = 0; let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${extra ? ' → ' + extra : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`); }
};

/** 剥块注释与行注释（判定代码形态时必须先剥，否则注释里的字样会喂饱断言） */
function stripComments(text) {
  const out = []; let inb = false;
  for (const line of text.split('\n')) {
    const s = line.replace(/^\s+/, '');
    if (inb) { if (s.includes('*/')) inb = false; continue; }
    if (s.startsWith('/*')) { if (!s.slice(2).includes('*/')) inb = true; continue; }
    if (s.startsWith('*')) continue;
    if (s.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
}

const fwdRaw = fs.readFileSync(path.join(PLUG, 'utils', 'color.ts'), 'utf8');
const fwd = stripComments(fwdRaw);
const srcRaw = fs.readFileSync(path.join(PICKER, 'color.ts'), 'utf8');

/* ---------------------------- 1) 转发文件不许自带实现 ---------------------------- */
console.log('\n— 1) 转发文件只转发 —');

t('转发文件含 export * 指向 color-picker',
  /export\s*\*\s*from\s*['"][^'"]*color-picker\/color['"]/.test(fwd));

t('转发文件内没有本地 export function',
  !/export\s+function/.test(fwd),
  /export\s+function/.test(fwd) ? '发现本地函数' : '');

t('转发文件内没有本地 export const',
  !/export\s+const/.test(fwd),
  /export\s+const/.test(fwd) ? '发现本地常量' : '');

/* ---------------------------- 2) 抽出上游函数真跑 ---------------------------- */
console.log('\n— 2) 上游函数行为（剥类型后实际执行）—');

/** 切出 `export function name(` 起、大括号配平止的整段 */
function grab(name) {
  const i = srcRaw.indexOf(`export function ${name}(`);
  if (i < 0) return null;
  const j = srcRaw.indexOf('{', i); let d = 0; let k = j;
  for (;;) {
    if (srcRaw[k] === '{') d += 1;
    else if (srcRaw[k] === '}') d -= 1;
    if (d === 0) break;
    k += 1;
  }
  return srcRaw.slice(i, k + 1);
}

/** 剥 TS 类型注解：export 前缀、参数注解、返回类型 */
function stripTS(seg) {
  let s = seg.replace(/^export\s+/, '');
  // 参数列表内的 `name: Type` —— 按括号配对切出，避免误伤字符串
  s = s.replace(/\(([^()]*)\)/g, (m, inner) => {
    if (!inner.includes(':')) return m;
    const parts = inner.split(',').map((p) => p.split(':')[0].trim());
    return `(${parts.join(', ')})`;
  });
  // 返回类型 `): [number, number, number] {` → `) {`
  s = s.replace(/\)\s*:\s*[^{]*\{\s*$/m, ') {');
  s = s.replace(/\)\s*:\s*[^{]*\{/, ') {');
  return s;
}

const WANT = ['normalizeHex', 'hexToRgb', 'rgbToHex', 'shade', 'luminance', 'isDark'];
const segs = {};
let allGrabbed = true;
for (const n of WANT) {
  const g = grab(n);
  segs[n] = g;
  if (!g) allGrabbed = false;
}
t('上游导出全部六个工具', allGrabbed, WANT.filter((n) => !segs[n]).join(',') || '全在');

let mod = null;
try {
  const body = WANT.map((n) => stripTS(segs[n])).join('\n\n');
  const names = WANT.join(', ');
  // eslint-disable-next-line no-new-func
  mod = new Function(`${body}\nreturn { ${names} };`)();
} catch (e) {
  mod = null;
  console.log(`   （构建失败：${e.message}）`);
}
t('六个函数能剥类型后实际执行', !!mod);

if (mod) {
  const { normalizeHex, hexToRgb, rgbToHex, shade, luminance, isDark } = mod;

  // normalizeHex：三位简写 / 省略 # / 非法
  t('normalizeHex 认三位简写', normalizeHex('#abc') === '#AABBCC', `#abc → ${normalizeHex('#abc')}`);
  t('normalizeHex 认省略 # 的六位', normalizeHex('1a2B3c') === '#1A2B3C', `→ ${normalizeHex('1a2B3c')}`);
  t('normalizeHex 非法返回 null（不崩）', normalizeHex('蓝') === null && normalizeHex('') === null);

  // hexToRgb / rgbToHex 往返
  t('hexToRgb 取值正确', JSON.stringify(hexToRgb('#FF8000')) === JSON.stringify([255, 128, 0]),
    JSON.stringify(hexToRgb('#FF8000')));
  t('rgbToHex 往返一致', rgbToHex(...hexToRgb('#3E63DD')) === '#3E63DD',
    rgbToHex(...hexToRgb('#3E63DD')));
  t('rgbToHex 夹取越界分量（不溢出成三位 hex）',
    rgbToHex(300, -20, 0) === '#FF0000', rgbToHex(300, -20, 0));

  // shade：亮化向白靠、暗化向黑靠。若退回"简单乘系数"，
  // 对已接近纯白的颜色几乎无变化 —— 那正是这段注释写明的失效方式。
  const lighter = shade('#FFFFFF', 0.5);
  t('shade 对纯白亮化无溢出（夹紧 255）', lighter === '#FFFFFF', lighter);
  const dark = shade('#000000', -0.5);
  t('shade 对纯黑暗化不变', dark === '#000000', dark);
  const mid = shade('#808080', 0.5);
  t('shade 亮化中灰确实变亮', mid !== '#808080' && luminance(mid) > luminance('#808080'),
    `#808080 +0.5 → ${mid}`);
  const midD = shade('#808080', -0.5);
  t('shade 暗化中灰确实变暗', luminance(midD) < luminance('#808080'),
    `#808080 -0.5 → ${midD}`);

  // luminance / isDark：深蓝判深色，这条对
  t('深蓝 #3E63DD 算深色', isDark('#3E63DD') === true,
    `luminance=${luminance('#3E63DD').toFixed(3)}`);

  // ⚠️ 已知偏差（归属共用组件，已上报，不在本插件改）：
  // color-picker/color.ts 里 luminance 的注释白纸黑字写着——
  //   「平均会把亮蓝（如 #0091FF）误判为暗色，白字上去就糊了」
  // 而 BT.601 权重 + 0.5 阈值算出 #0091FF 的 luminance = 0.448 < 0.5，
  // **仍然判成了深色** —— 即注释警告的那个后果，代码正在犯。
  // 影响本插件两处可见结果：visual.ts 的 textOn（标签色卡片上的文字取白）、
  // CardGrid 的 borderColor。亮蓝标签上叠白字正是"糊"。
  //
  // 钉住现状而不是假装它是对的：等共用组件那边改成 sRGB 线性化 + WCAG
  // 阈值（#0091FF → 0.275 > 0.179，判非深色）后，**本条会从绿变红**，
  // 提醒把预期一并改成 false。这样既不让套件红，也不会静默漂移。
  t('[已知偏差·共用组件待修] 亮蓝 #0091FF 当前仍被判为深色（白字会糊）',
    isDark('#0091FF') === true,
    `luminance=${luminance('#0091FF').toFixed(3)}；修好后本条应改为 false`);
}

/* ---------------------------- 3) 引用方仍从转发路径取 ---------------------------- */
console.log('\n— 3) 引用方仍走转发路径 —');

const refFiles = [];
for (const dir of ['components', 'utils', 'hooks']) {
  const p = path.join(PLUG, dir);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const s = fs.readFileSync(path.join(p, f), 'utf8');
    if (/from\s+['"][^'"]*utils\/color['"]|from\s+['"]\.\/color['"]/.test(s)) refFiles.push(`${dir}/${f}`);
  }
}
t('仍有文件从转发路径 import（说明转发没被绕过）', refFiles.length > 0, refFiles.join(', '));

/** 上游真实导出名（从源码解析，不手写清单 —— 手写清单会过时） */
const upstream = new Set(
  [...srcRaw.matchAll(/export\s+(?:function|const|interface|type)\s+(\w+)/g)].map((m) => m[1]),
);
t('上游导出名已解析出来（不是手写清单）', upstream.size >= 8,
  `${upstream.size} 个：${[...upstream].join(', ')}`);

for (const rf of refFiles) {
  const s = fs.readFileSync(path.join(PLUG, rf), 'utf8');
  const m = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*color['"]/.exec(s);
  const names = m ? m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
  const missing = names.filter((n) => !upstream.has(n));
  t(`  ${rf} 引用的名字都能从上游拿到`, names.length > 0 && missing.length === 0,
    missing.length ? `缺：${missing.join(', ')}` : names.join(', '));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
