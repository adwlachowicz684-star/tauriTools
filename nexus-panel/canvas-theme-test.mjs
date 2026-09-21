/**
 * 脑图画布跟随外壳主题后，节点看不清的问题。
 *
 * 根因：画布底色由外壳主题派生，节点配色却是**自带主题的固定调色板** ——
 * 两者由不同的人选，必然出现错配。典型：
 *   · fresh-* 的 connect-color 是 white，浅色画布上直接消失
 *   · fresh-* 的 sub-color 是 #333 且 sub-background 透明，深色画布上消失
 *   · main 节点 #EEF3F6 与浅色画布对比度仅 1.30，糊成一片
 *
 * 方案（B+C）：
 *   B 关键色派生 —— 连接线 / 无填充节点文字 / 描边兜底，按画布底色算
 *   C 画布折中   —— 画布亮度夹进中间区间，给骨架色留余量
 *
 * 只覆盖"本来就不达标"的项：达标的保留原值，不冲掉用户自定义主题里
 * 精心挑的颜色。
 */
import { readFileSync } from 'node:fs';
import { deriveCanvasTheme, criticalOverrides, contrastRatio,
         clampLuma, awayFrom, luma, canvasSurface } from './plugins/mindmap/themes.js';

let pass = 0; const fails = [];
const t = (name, cond, extra = '') => {
  cond ? pass++ : fails.push(`${name}${extra ? ' → ' + extra : ''}`);
};

/** 从编辑器页里抠出内联实现，用于比对是否与 themes.js 同源 */
const html = readFileSync('plugins/mindmap/editor/index.html', 'utf8');
function extractInline(startMark, endMark) {
  const i = html.indexOf(startMark);
  if (i < 0) return null;
  const j = html.indexOf(endMark, i);
  /* 起点从 startMark **自身**开始，不要跳过 —— 跳过了就把形参名截掉了 */
  return j < 0 ? null : html.slice(i, j);
}
/* 起点要含函数签名本身，否则 new Function 里拿不到形参 */
const inlineSrc = extractInline('function _kmParseColor(', '/** 把覆盖写回内核当前主题项');
const inlineFn = inlineSrc
  ? new Function(inlineSrc + '\n return _kmCriticalOverrides;')()
  : null;

console.log('=== 0. 画布取向：色相跟随外壳，亮度固定在画布档 ===');
/* 这是本轮的核心结论：
   画布**不能跟着外壳的明暗走**。实测 14 套外壳 × 10 个节点主题，
   画布变浅时最差只有 1.08（全部糊在一起），固定深色档则最差 3.11。
   根因不是没调好，而是浅填充 vs 浅画布在数学上就不可能有对比度。 */
const SHELL_BGS = [
  ['neumorph-dark', '#2b2f36'], ['midnight', '#232838'], ['graphite', '#303236'],
  ['celadon', '#24302c'], ['amber-dusk', '#2e2723'], ['violet-dusk', '#2b2740'],
  ['carbon-blue', '#1f2430'], ['rose-noir', '#1c1618'], ['ocean-deep', '#16262e'],
  ['neumorph-light', '#e6e9ef'], ['paper', '#f0ece4'], ['mint-morning', '#e8f0ec'],
  ['sakura', '#f5ebee'], ['sandstone', '#e9e4dc'],
];
/* 节点主题的四色取自 kityminder.core.min.js 的真实定义（root / main） */
const NODE_THEMES = [
  ['fresh-blue', '#73A1BF', '#EEF3F6'], ['fresh-green', '#73BF76', '#EEF6EE'],
  ['fresh-red', '#BF7373', '#F6EEEE'], ['fresh-soil', '#BF9373', '#F6F2EE'],
  ['fresh-purple', '#7B73BF', '#EFEEF6'], ['fresh-pink', '#BF7394', '#F6EEF2'],
  ['snow', '#E9DF98', '#A4C5C0'], ['classic', '#E9DF98', '#A4C5C0'],
  ['wire', '#999999', '#999999'], ['fish', '#E9DF98', '#A4C5C0'],
];
let worst = { c: Infinity };
for (const [sn, bg] of SHELL_BGS) {
  const v = deriveCanvasTheme({ '--bg': bg });
  for (const [tn, root, main] of NODE_THEMES) {
    const c = Math.min(contrastRatio(root, v.canvasBg), contrastRatio(main, v.canvasBg));
    if (c < worst.c) worst = { c, sn, tn, bg, canvas: v.canvasBg };
  }
}
t('全部外壳 × 全部节点主题：填充对比度 ≥ 2.5',
  worst.c >= 2.5,
  `最差 ${worst.sn}/${worst.tn} = ${worst.c.toFixed(2)}（画布 ${worst.canvas}）`);

/* 画布必须落在深色档，否则浅填充会糊（这就是旧实现 1.08 的成因） */
for (const [sn, bg] of SHELL_BGS) {
  const v = deriveCanvasTheme({ '--bg': bg });
  t(`${sn} 画布在深色档（luma ≤ 70）`, luma(v.canvasBg) <= 70, `${v.canvasBg} luma=${luma(v.canvasBg).toFixed(0)}`);
}

/* 跟随的是**色相与色温**，不是明暗 —— 不同外壳要给出不同色调的画布 */
const hues = new Set(SHELL_BGS.map(([, bg]) => deriveCanvasTheme({ '--bg': bg }).canvasBg));
t('不同外壳给出不同色相的画布（不是一块死板的灰）',
  hues.size >= 10, `去重后 ${hues.size} 种`);
/* 暖色外壳的画布应偏暖：R 通道 > B 通道 */
const warm = deriveCanvasTheme({ '--bg': '#f0ece4' }).canvasBg;   // paper
const cool = deriveCanvasTheme({ '--bg': '#16262e' }).canvasBg;   // ocean-deep
const chan = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
t('暖色外壳 → 画布偏暖（R>B）', chan(warm)[0] > chan(warm)[2], warm);
t('冷色外壳 → 画布偏冷（B>R）', chan(cool)[2] > chan(cool)[0], cool);

console.log('=== 1. 画布不走到极端 ===');
/* 画布不能走到纯白 / 纯黑 —— 两端都不给骨架色留余量 */
for (const [label, bg] of [
  ['纯白外壳', '#ffffff'], ['浅色外壳', '#f4f6fa'],
  ['深色外壳', '#2b2f36'], ['纯黑外壳', '#000000'],
]) {
  const v = deriveCanvasTheme({ '--bg': bg });
  /* 判据：画布既不能是纯白也不能是纯黑 —— 与两端都留出可见差距，
     派生的描边 / 文字才有地方可去。纯黑底是最容易漏的一类（缩放提不亮）。 */
  t(`${label} 画布不走到极端`,
    contrastRatio(v.canvasBg, '#ffffff') >= 1.15
    && contrastRatio(v.canvasBg, '#000000') >= 1.35,
    `canvasBg=${v.canvasBg} vs白=${contrastRatio(v.canvasBg, '#ffffff').toFixed(2)} vs黑=${contrastRatio(v.canvasBg, '#000000').toFixed(2)}`);
}

console.log('=== 2. 关键色达标（B）===');
/* 骨架色必须对画布有足够对比 */
/* 画布恒为深色档（见 canvasSurface 注释），所以三组外壳给出的都是深画布 ——
   标签写"外壳"，别写成"画布"，否则会误导后来者以为画布还分深浅。 */
for (const [label, bg] of [['浅色外壳', '#f4f6fa'], ['深色外壳', '#2b2f36'], ['纯黑外壳', '#000000']]) {
  const v = deriveCanvasTheme({ '--bg': bg });
  t(`${label}画布：连接线对比度 ≥3`,
    contrastRatio(v.connectColor, v.canvasBg) >= 3,
    `${v.connectColor} vs ${v.canvasBg} = ${contrastRatio(v.connectColor, v.canvasBg).toFixed(2)}`);
  t(`${label}画布：无填充文字对比度 ≥4.5`,
    contrastRatio(v.canvasText, v.canvasBg) >= 4.5,
    `${v.canvasText} = ${contrastRatio(v.canvasText, v.canvasBg).toFixed(2)}`);
}

console.log('=== 3. 只覆盖不达标的，达标的保留 ===');
const fresh = {
  'connect-color': 'white',
  'root-background': '#73A1BF', 'root-stroke': '#73A1BF',
  'main-background': '#EEF3F6', 'main-stroke': '#EEF3F6',
  'sub-background': 'transparent', 'sub-color': '#333',
};
/* 显式给一个浅画布来测"填充糊了要补描边"这条路径。
   deriveCanvasTheme 现在不会产出浅画布（那是本轮修掉的问题），
   但 criticalOverrides 是 canvasBg 的纯函数 —— 自定义主题、旧存档、
   或将来再次改动都可能传进浅值，这条路径必须继续守住。 */
const LIGHT_CANVAS = '#d4d6da';
const ovL = criticalOverrides(LIGHT_CANVAS, fresh);
t('浅画布：white 连接线被覆盖', !!ovL['connect-color']);
t('浅画布：糊的 main 补描边', !!ovL['main-stroke']);
/* root #73A1BF 对比度 1.90，够区分 —— 不该动它 */
t('浅画布：够区分的 root 不动', !ovL['root-stroke'],
  `实际 ${ovL['root-stroke']}`);

const darkV = deriveCanvasTheme({ '--bg': '#2b2f36' });
const ovD = criticalOverrides(darkV.canvasBg, fresh);
t('深色画布：#333 的 sub 文字被覆盖', !!ovD['sub-color']);
t('深色画布：节点填充够亮就不补描边', !ovD['main-stroke']);

/* 用户自定义主题里挑好的颜色，只要达标就该留下 */
/* 挑一个在深色画布上确实达标的自定义色（#1a4c8b 只有 1.68，本来就该被覆盖，
   拿它当"达标"样本是我自己写错了用例） */
const custom = { ...fresh, 'connect-color': '#8ab4f8' };
const ovC = criticalOverrides(darkV.canvasBg, { ...custom, 'sub-color': '#e6e9ef' });
t('自定义主题：达标的连接线保留', !ovC['connect-color']);
t('自定义主题：达标的文字保留', !ovC['sub-color']);

console.log('=== 4. 子节点有填充时不改文字 ===');
/* snow / fish 的 sub-background 是 #FFFFFF，文字跟白底比，与画布无关 */
t('sub 有填充 → 不动 sub-color',
  !criticalOverrides(darkV.canvasBg, { ...fresh, 'sub-background': '#FFFFFF' })['sub-color']);

console.log('=== 5. 编辑器内联实现与 themes.js 一致 ===');
/* 本页是传统 script 加载，走 ES module 会被 CORS 挡，所以复制了一份。
   不比对的话两份必然各自漂移 —— 这里用同一批输入跑两边。 */
t('编辑器内联实现存在', !!inlineFn);
if (inlineFn) {
  const cases = [
    [LIGHT_CANVAS, fresh],
    [darkV.canvasBg, fresh],
    ['#d4d6da', { 'connect-color': 'white', 'root-background': '#73A1BF',
                  'root-stroke': '#73A1BF', 'main-background': '#EEF3F6',
                  'main-stroke': 'none', 'sub-background': 'transparent',
                  'sub-color': '#333' }],
    ['#262a31', { 'connect-color': '#999999', 'root-background': '#999999',
                  'root-stroke': 'none', 'main-background': '#999999',
                  'main-stroke': '#999999', 'sub-background': '#999999',
                  'sub-color': '#999999' }],
  ];
  let diff = 0;
  for (const [bg, items] of cases) {
    const a = JSON.stringify(criticalOverrides(bg, items));
    const b = JSON.stringify(inlineFn(bg, items));
    if (a !== b) { diff++; console.log(`  差异 bg=${bg}\n    themes: ${a}\n    内联:   ${b}`); }
  }
  t('两份实现输出完全一致', diff === 0, `${diff} 处不同`);
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) { fails.forEach((f) => console.log('  ❌ ' + f)); process.exit(1); }
