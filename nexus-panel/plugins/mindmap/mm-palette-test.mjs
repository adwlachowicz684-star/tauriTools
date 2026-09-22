/**
 * 脑图预置主题配色测试
 * ------------------------------------------------------------
 * 只验证**能算出来的部分**（对比度 / 层级差 / 字段完整性），
 * 不试图评判"好不好看" —— 那是主观的，测不了。
 *
 * 为什么单独成文件而不是塞进 mindmap-test.mjs：
 *   那一份已经很长，且它 import 的是 index.js（要 mock 一堆宿主接口）。
 *   配色校验**只读 themes.js**（零依赖模块），独立跑更快，
 *   也避免"想验个配色却要先把整个插件环境搭起来"。
 *
 * 关键约束的由来（改配色前务必先读）：
 *   registerCustomTheme() 内部把同一个 textColor 同时写进
 *   root-color / main-color / sub-color —— 三级节点**共用一个文字色**。
 *   于是三个层级背景必须落在同一明暗侧，否则必有某一级文字看不清。
 */
import { PRESET_THEMES, mergePresetThemes, THEMES } from './themes.js';

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
};

/* ---------- WCAG 计算 ---------- */
const rgb = (h) => {
  const x = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
};
const relLum = (h) => {
  const [r, g, b] = rgb(h).map((v) => {
    const y = v / 255;
    return y <= 0.03928 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const cr = (a, b) => {
  const la = relLum(a), lb = relLum(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};
/** 感知明度 L*。对比度是比值，判断"层级差多少"要用感知均匀空间。 */
const Lstar = (h) => {
  const y = relLum(h);
  return y <= 0.008856 ? y * 903.3 : Math.cbrt(y) * 116 - 16;
};
const solid = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

console.log('\n=== 1. 每个预置主题的结构 ===');
t('预置主题数量 ≥ 4', PRESET_THEMES.length >= 4, String(PRESET_THEMES.length));
t('id 唯一', new Set(PRESET_THEMES.map((x) => x.id)).size === PRESET_THEMES.length);
t('id 统一 mm-preset- 前缀（与用户自建区分）',
  PRESET_THEMES.every((x) => x.id.startsWith('mm-preset-')),
  PRESET_THEMES.find((x) => !x.id.startsWith('mm-preset-'))?.id || '全部合规');
t('id 不与内置主题撞车',
  PRESET_THEMES.every((x) => !THEMES.some((b) => b.value === x.id)), '无重名');
t('每个都有 name / base / palette',
  PRESET_THEMES.every((x) => x.name && (x.base === 'light' || x.base === 'dark') && x.palette));

console.log('\n=== 2. palette 字段完整（缺键会被 core 按默认值兜底，间距变 0 会贴死）===');
const REQUIRED = [
  'background', 'textColor', 'selectedColor', 'connectColor', 'connectWidth',
  'rootBackground', 'rootFontSize', 'rootRadius', 'rootSpace',
  'mainBackground', 'mainFontSize', 'mainRadius', 'mainSpace', 'mainMargin',
  'subBackground', 'subFontSize', 'subRadius', 'subSpace', 'subMargin',
];
{
  const miss = [];
  for (const p of PRESET_THEMES) {
    for (const k of REQUIRED) {
      if (p.palette[k] === undefined || p.palette[k] === null || p.palette[k] === '') {
        miss.push(`${p.id}.${k}`);
      }
    }
  }
  t('必填字段齐全', miss.length === 0, miss.slice(0, 4).join(' ') || `${PRESET_THEMES.length}×${REQUIRED.length} 项`);
}
{
  // 间距为 0 是最隐蔽的一种：不报错，但节点上下左右贴死
  const zero = [];
  for (const p of PRESET_THEMES) {
    for (const k of ['rootSpace', 'mainSpace', 'subSpace', 'mainMargin', 'subMargin']) {
      if (Number(p.palette[k]) <= 0) zero.push(`${p.id}.${k}=${p.palette[k]}`);
    }
  }
  t('间距均 > 0（为 0 会被 core 当"贴死"处理）', zero.length === 0, zero.join(' ') || '全部 > 0');
}

console.log('\n=== 3. 文字对比度（三级共用一个 textColor，这是核心约束）===');
{
  const bad = [];
  for (const p of PRESET_THEMES) {
    const { textColor: tx, rootBackground: rt, mainBackground: mn, subBackground: sb } = p.palette;
    for (const [bg, label] of [[rt, 'root'], [mn, 'main'], [sb, 'sub']]) {
      if (!solid(tx) || !solid(bg)) { bad.push(`${p.id}.${label} 非实色`); continue; }
      const c = cr(tx, bg);
      if (c < 4.5) bad.push(`${p.name} ${label} ${c.toFixed(2)}<4.5`);
    }
  }
  t('文字在 root/main/sub 三处均 ≥ 4.5', bad.length === 0,
    bad.slice(0, 3).join(' | ') || '全部达标');

  /*
   * 这条是上面那条之外**单独**要验的：
   * 背景色本身没进对比度检查，但若画布上直接有文字（游离文本 / 提示），
   * textColor 与 background 的组合必须成立。
   */
  const onBg = [];
  for (const p of PRESET_THEMES) {
    if (!solid(p.palette.textColor) || !solid(p.palette.background)) continue;
    const c = cr(p.palette.textColor, p.palette.background);
    if (c < 4.5) onBg.push(`${p.name} ${c.toFixed(2)}`);
  }
  t('文字在画布底色上也 ≥ 4.5', onBg.length === 0, onBg.join(' | ') || '全部达标');
}

console.log('\n=== 4. 层级可辨识（相邻级 L* 差 ≥ 8）===');
{
  const flat = [];
  for (const p of PRESET_THEMES) {
    const L = [p.palette.rootBackground, p.palette.mainBackground, p.palette.subBackground].map(Lstar);
    if (Math.abs(L[0] - L[1]) < 8) flat.push(`${p.name} root-main ${L[0].toFixed(0)}/${L[1].toFixed(0)}`);
    if (Math.abs(L[1] - L[2]) < 8) flat.push(`${p.name} main-sub ${L[1].toFixed(0)}/${L[2].toFixed(0)}`);
  }
  t('root / main / sub 相邻级 L* 差 ≥ 8', flat.length === 0, flat.slice(0, 3).join(' | ') || '层级分明');
}
{
  // sub 与画布底太接近 → 子节点"看不见"，只剩连线悬空
  const sink = [];
  for (const p of PRESET_THEMES) {
    const d = Math.abs(Lstar(p.palette.subBackground) - Lstar(p.palette.background));
    if (d < 2) sink.push(`${p.name} ΔL*=${d.toFixed(1)}`);
  }
  t('sub 与画布底有区分（ΔL* ≥ 2）', sink.length === 0, sink.join(' | ') || '全部可辨');
}

console.log('\n=== 5. 连线与选中色（结构信息，太淡等于没有骨架）===');
{
  const dim = [];
  for (const p of PRESET_THEMES) {
    const c = cr(p.palette.connectColor, p.palette.background);
    if (c < 3.0) dim.push(`${p.name} 连线 ${c.toFixed(2)}`);
  }
  t('连线对画布底 ≥ 3.0', dim.length === 0, dim.join(' | ') || '全部达标');
}
{
  const dim = [];
  for (const p of PRESET_THEMES) {
    const c = cr(p.palette.selectedColor, p.palette.background);
    if (c < 3.0) dim.push(`${p.name} 选中 ${c.toFixed(2)}`);
  }
  t('选中色对画布底 ≥ 3.0', dim.length === 0, dim.join(' | ') || '全部达标');
}

console.log('\n=== 6. mergePresetThemes 行为 ===');
{
  t('空列表并入全部', mergePresetThemes([], []).length === PRESET_THEMES.length);
  t('重复并入不增殖（幂等）',
    mergePresetThemes(mergePresetThemes([], []), []).length === PRESET_THEMES.length);
  t('removed 里的 id 被跳过',
    mergePresetThemes([], ['mm-preset-mist-blue']).length === PRESET_THEMES.length - 1);
  t('removed 不认识自建主题 id 也不影响',
    mergePresetThemes([{ id: 'my-own' }], ['whatever']).length === PRESET_THEMES.length + 1);

  const custom = [{ id: 'mm-preset-deep-ink', name: '我改过的深墨', palette: {} }];
  const merged = mergePresetThemes(custom, []);
  t('同名 id 以用户版为准（改动不被覆盖）',
    merged.find((x) => x.id === 'mm-preset-deep-ink').name === '我改过的深墨');

  /* 这条最容易被漏：若 push 的是模块级常量本身，用户"编辑预置主题"
     会直接改掉 PRESET_THEMES，刷新后所有文档都跟着变。 */
  const fresh = mergePresetThemes([], []);
  fresh[0].name = '污染';
  t('并入的是深拷贝（不会污染模块常量）', PRESET_THEMES[0].name !== '污染', PRESET_THEMES[0].name);

  t('null / 非数组入参不抛异常',
    mergePresetThemes(null, null).length === PRESET_THEMES.length);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
