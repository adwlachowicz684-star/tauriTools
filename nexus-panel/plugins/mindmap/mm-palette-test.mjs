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
import { readFileSync } from 'node:fs';
import { PRESET_THEMES, mergePresetThemes, THEMES,
  awayFrom, contrastRatio, luma } from './themes.js';

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
  /*
   * 删除预置主题必须**把 id 写进 removedPresets**。
   *
   * 变异测试实测：把 `settings.removedPresets = list;` 换成空操作后，
   * 6 个测试共 400+ 项断言**全绿** —— 现存断言只验了
   * "removed 列表里的 id 会被 mergePresetThemes 跳过"（读侧），
   * 没验"删除动作真的往列表里写了"（写侧）。
   *
   * 而写侧才是关键：预置主题每次启动都会重新并入，
   * 不记名单的话删除按钮等于坏的 —— 点完看着没了，重启又回来。
   * 且与"深拷贝"是互补的两半：深拷贝保证编辑不污染源，
   * 移除名单保证删除能持久化。
   */
  {
    const idx = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    const fn = /markPresetRemoved[\s\S]{0,600}?\n {4}\}/.exec(idx);
    const body = fn ? fn[0] : '';
    t('删除预置主题会把 id 写进 removedPresets（否则重启又回来）',
      /settings\.removedPresets\s*=\s*list/.test(body),
      body ? '已找到写入' : '未找到 markPresetRemoved');
    t('写入后会落盘保存（只改内存不写档同样会复活）',
      /save\(settings\)|store\.settings\.save/.test(body));
  }
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

console.log('\n=== 7. awayFrom：达标是硬承诺，不是"尽力而为" ===');
{
  /*
   * 这条守的是一条**写进了函数注释的承诺**："偏移，直到对比度达标"。
   *
   * 只朝一个方向找时它是假的：
   *   随机 2000 色   ratio=4.5 未达标 21.1%   ratio=3 未达标 1.1%
   *   灰度扫描       失效区间 luma 119..140（连续 22 级）
   * 原因不是没走够步数，而是**方向选错了**：感知明暗（luma）与 WCAG
   * 相对亮度在中间调上分道扬镳，深绿 #23af17（luma 134）一路走到纯白
   * 也只有 2.91，反过来走深是 7.21。
   *
   * 当前 6 处调用全以 canvasBg 为 base，而 canvasSurface 把亮度钉在
   * 深色档（luma 实测 43~48），恰好都落在"朝浅走"那一侧 —— 所以这一条
   * 眼下**碰不到**，是潜在的，不是正在发作的。守它有两个理由：
   *   ① 注释里写着"直到达标"，代码却做不到 —— 谁改了 canvasSurface 的
   *      亮度档，文字色就会静默退化成看不清，而没有任何一处会报错；
   *   ② 兜底色（#f2f2f4）比"走到纯白"还差（2.60 vs 2.91），
   *      即失败时连"尽力"都没尽到。
   */

  /* 全量扫描：灰度阶梯 + 色域网格，两个 ratio 都不允许有漏网。
     用确定性采样而不是随机，避免"换个种子就绿了"的假通过。 */
  const gray = (v) => '#' + [v, v, v].map((n) => n.toString(16).padStart(2, '0')).join('');
  const grid = [];
  for (const r of [0, 51, 102, 153, 204, 255]) {
    for (const g of [0, 51, 102, 153, 204, 255]) {
      for (const b of [0, 51, 102, 153, 204, 255]) {
        grid.push('#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join(''));
      }
    }
  }
  const sweep = (ratio) => {
    const bad = [];
    const all = [...Array(256).keys()].map(gray).concat(grid);
    for (const c of all) {
      const got = awayFrom(c, ratio);
      if (contrastRatio(got, c) < ratio) bad.push(`${c}→${got} ${contrastRatio(got, c).toFixed(2)}`);
    }
    return bad;
  };
  const b45 = sweep(4.5), b3 = sweep(3);
  t(`全量扫描（灰度 256 + 色域 ${grid.length}）ratio=4.5 无一漏网`,
    b45.length === 0, b45.slice(0, 3).join(' | ') || `${256 + grid.length} 色全部达标`);
  t('全量扫描 ratio=3 无一漏网', b3.length === 0, b3.slice(0, 3).join(' | ') || '全部达标');

  /* 单点反例：这几个是实测抓出来的，任何一个退化都得报红 */
  const cases = ['#23af17', '#ef1803', '#a57973', '#9566f1', '#767676', '#8b8b8b'];
  const weak = cases.filter((c) => contrastRatio(awayFrom(c, 4.5), c) < 4.5);
  t('实测反例（中间调 / 高饱和红 / 紫）在 4.5 下达标', weak.length === 0,
    weak.map((c) => `${c} ${contrastRatio(awayFrom(c, 4.5), c).toFixed(2)}`).join(' | ') || '全部达标');

  /* 方向不能被"为了达标"带偏：双向都能达标时仍按感知方向走。
     #767676（luma 118）是实测唯一双向都够的一小段：白端 4.54、黑端 4.62，
     而它按 luma 属于"深底" → 必须出浅色（这是唯一能钉住 preferred 的样本）。 */
  const mid = awayFrom('#767676', 4.5);
  t('双向都达标时仍走感知方向（深底出浅色，不为达标选别扭方向）',
    luma(mid) > luma('#767676'), `${mid} luma ${luma(mid).toFixed(0)}`);

  /* 真实画布底（深色档）必须仍出浅色 —— 保住"浅字压深底"这个观感 */
  const darkBase = '#2b2f36';
  const onDark = awayFrom(darkBase, 4.5);
  t('深画布底仍派生浅色', luma(onDark) > luma(darkBase),
    `${onDark} luma ${luma(onDark).toFixed(0)} vs ${luma(darkBase).toFixed(0)}`);
  const lightBase = '#eeeeee';
  const onLight = awayFrom(lightBase, 4.5);
  t('浅画布底仍派生深色', luma(onLight) < luma(lightBase),
    `${onLight} luma ${luma(onLight).toFixed(0)} vs ${luma(lightBase).toFixed(0)}`);

  /* 兜底不许走到纯白 / 纯黑 —— 与 clampLuma 注释里"画布不能走到两端"
     是同一条规矩。兜底眼下不可达（ratio ≤ 4.58 时必有一向可达），
     这里只是钉住它别被人顺手改成 #fff / #000。 */
  let fn = '';
  try {
    const body = readFileSync(new URL('./themes.js', import.meta.url), 'utf8');
    const m = body.match(/export function awayFrom[\s\S]*?\n}/);
    fn = m ? m[0] : '';
  } catch {}
  t('源码契约：两个方向都找（不能只留单向）',
    /-\s*preferred/.test(fn), fn ? '已找到反向查找' : '未找到函数体');
  t('源码契约：兜底仍是软白 / 软黑（不走纯白纯黑）',
    /'#141418'\s*:\s*'#f2f2f4'/.test(fn), fn ? '已确认' : '未找到函数体');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
