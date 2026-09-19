/**
 * 布局记忆回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/layout-test.mjs，然后
 *         node plugins/project-group/layout-test.mjs
 *
 * 覆盖 #54（三栏 star）/ #55（日志高度）/ #56（浮层高度）/ #193 的取值规则：
 *   · 前后端常量同数（漂移护栏，同 log-test）
 *   · star 归一化：数量不对回默认、逐项夹取
 *   · resizeColStars：只动两侧、两侧都不能被拖穿下限
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');

const L = await loadTs(path.join(HERE, 'utils/layout.ts'));
const { t, done } = makeT();

const {
  COL_STARS_DEFAULT, COL_STAR_MIN, COL_STAR_MAX,
  LOG_HEIGHT_DEFAULT, LOG_HEIGHT_MIN, LOG_HEIGHT_MAX,
  PANEL_HEIGHT_MIN, PANEL_HEIGHT_MAX,
  clampLogHeight, clampPanelHeight, normalizeColStars, starsToCss, resizeColStars,
} = L;

console.log('\n=== 1. 默认值与区间 ===');
t('默认 star = [1, 1, 1.4]（与改动前 CSS 一致）',
  JSON.stringify(COL_STARS_DEFAULT) === '[1,1,1.4]', JSON.stringify(COL_STARS_DEFAULT));
t('默认日志高 132（与改动前 CSS max-height 一致）', LOG_HEIGHT_DEFAULT === 132);
t('star 下限 < 上限', COL_STAR_MIN < COL_STAR_MAX);
t('日志高下限 < 上限', LOG_HEIGHT_MIN < LOG_HEIGHT_MAX);
t('浮层下限 < 上限', PANEL_HEIGHT_MIN < PANEL_HEIGHT_MAX);
t('默认日志高落在区间内',
  LOG_HEIGHT_DEFAULT >= LOG_HEIGHT_MIN && LOG_HEIGHT_DEFAULT <= LOG_HEIGHT_MAX);

console.log('\n=== 2. 与后端常量同数（漂移护栏）===');
const rsPath = path.join(ROOT, 'src-tauri/src/fpx/model.rs');
if (!fs.existsSync(rsPath)) {
  console.log('（跳过：未找到 model.rs）');
} else {
  const rs = fs.readFileSync(rsPath, 'utf8');
  const num = (re) => { const m = rs.match(re); return m ? Number(m[1]) : null; };
  t('COL_STAR_MIN 一致', num(/pub const COL_STAR_MIN: f64 = ([\d.]+)/) === COL_STAR_MIN,
    `后端 ${num(/pub const COL_STAR_MIN: f64 = ([\d.]+)/)} / 前端 ${COL_STAR_MIN}`);
  t('COL_STAR_MAX 一致', num(/pub const COL_STAR_MAX: f64 = ([\d.]+)/) === COL_STAR_MAX);
  t('LOG_HEIGHT_MIN 一致', num(/pub const LOG_HEIGHT_MIN: u32 = (\d+)/) === LOG_HEIGHT_MIN);
  t('LOG_HEIGHT_MAX 一致', num(/pub const LOG_HEIGHT_MAX: u32 = (\d+)/) === LOG_HEIGHT_MAX);
  t('LOG_HEIGHT_DEFAULT 一致',
    num(/pub const LOG_HEIGHT_DEFAULT: u32 = (\d+)/) === LOG_HEIGHT_DEFAULT);
  t('PANEL_HEIGHT_MIN 一致', num(/pub const PANEL_HEIGHT_MIN: u32 = (\d+)/) === PANEL_HEIGHT_MIN);
  t('PANEL_HEIGHT_MAX 一致', num(/pub const PANEL_HEIGHT_MAX: u32 = (\d+)/) === PANEL_HEIGHT_MAX);
  t('后端 star 默认数组长度与前端一致',
    /COL_STARS_DEFAULT: \[f64; 3\]/.test(rs) && COL_STARS_DEFAULT.length === 3);
  t('后端有 normalize_col_stars', /pub fn normalize_col_stars/.test(rs));
}

console.log('\n=== 3. star 归一化 ===');
t('合法值原样返回',
  JSON.stringify(normalizeColStars([1, 2, 0.8])) === '[1,2,0.8]',
  JSON.stringify(normalizeColStars([1, 2, 0.8])));
t('null → 默认', JSON.stringify(normalizeColStars(null)) === JSON.stringify(COL_STARS_DEFAULT));
t('数量不对（2 个）→ 整体回默认',
  JSON.stringify(normalizeColStars([1, 2])) === JSON.stringify(COL_STARS_DEFAULT));
t('数量不对（4 个）→ 整体回默认',
  JSON.stringify(normalizeColStars([1, 2, 3, 4])) === JSON.stringify(COL_STARS_DEFAULT));
t('不是数组 → 默认',
  JSON.stringify(normalizeColStars('x')) === JSON.stringify(COL_STARS_DEFAULT));
t('低于下限 → 夹到下限',
  normalizeColStars([0.01, 1, 1])[0] === COL_STAR_MIN, String(normalizeColStars([0.01, 1, 1])[0]));
t('高于上限 → 夹到上限',
  normalizeColStars([99, 1, 1])[0] === COL_STAR_MAX);
t('NaN 项 → 夹到下限（不产生 NaN 布局）',
  Number.isFinite(normalizeColStars([NaN, 1, 1])[0]));
t('数字串能解析', normalizeColStars(['2', 1, 1])[0] === 2);

console.log('\n=== 4. starsToCss ===');
t('三栏生成三个 fr', starsToCss([1, 1, 1.4]) === '1fr 1fr 1.4fr', starsToCss([1, 1, 1.4]));
t('非法输入也能出合法 CSS', /^([\d.]+fr ?){3}$/.test(starsToCss(null).trimEnd()),
  starsToCss(null));

console.log('\n=== 5. 拖动：只动分隔条两侧 ===');
{
  // 三栏 [1,1,1.4]，总宽 1000px，拖第 0 条分隔条向右 100px
  const r = resizeColStars([1, 1, 1.4], 0, 100, 1000);
  t('第 3 栏不动', Math.abs(r[2] - 1.4) < 1e-9, String(r[2]));
  t('第 1 栏变大', r[0] > 1, String(r[0]));
  t('第 2 栏变小', r[1] < 1, String(r[1]));
  /* 像素守恒：star 总量不变（只挪不增） */
  const sum0 = 1 + 1 + 1.4;
  const sum1 = r[0] + r[1] + r[2];
  t('star 总量守恒（只挪动，不凭空增减）', Math.abs(sum0 - sum1) < 1e-9,
    `${sum0} → ${sum1}`);
}
{
  // 拖第 1 条分隔条（第 2/3 栏之间）
  const r = resizeColStars([1, 1, 1.4], 1, 100, 1000);
  t('拖第 2 条时第 1 栏不动', Math.abs(r[0] - 1) < 1e-9, String(r[0]));
  t('第 2 栏变大', r[1] > 1, String(r[1]));
  t('第 3 栏变小', r[2] < 1.4, String(r[2]));
}

console.log('\n=== 6. 拖动：不得拖穿下限（关键不变量）===');
/* 往右拖 = 左栏变大、右栏变小。疯狂往右拖时，被挤到下限的是**右栏**，
   左栏只是涨到它能涨的上限（两侧原 star 之和减去下限）。 */
{
  const r = resizeColStars([1, 1, 1.4], 0, 99999, 1000);
  t('往右拖到底：右栏停在下限',
    Math.abs(r[1] - COL_STAR_MIN) < 1e-9, String(r[1]));
  t('往右拖到底：左栏不为负', r[0] > 0, String(r[0]));
  t('往右拖到底：左栏不超过上限', r[0] <= COL_STAR_MAX + 1e-9, String(r[0]));
  // 两侧 star 之和守恒：1 + 1 = 1.6 + 0.4
  t('两侧之和守恒', Math.abs(r[0] + r[1] - 2) < 1e-9, `${r[0]} + ${r[1]}`);
}
{
  const r = resizeColStars([1, 1, 1.4], 0, -99999, 1000);
  t('往左拖到底：左栏停在下限',
    Math.abs(r[0] - COL_STAR_MIN) < 1e-9, String(r[0]));
  t('往左拖到底：右栏不为负', r[1] > 0, String(r[1]));
  t('往左拖到底：右栏不超过上限', r[1] <= COL_STAR_MAX + 1e-9, String(r[1]));
  t('往左拖到底：两侧之和守恒', Math.abs(r[0] + r[1] - 2) < 1e-9, `${r[0]} + ${r[1]}`);
}
{
  /* 穷举：任意位移下，三栏都必须仍在合法区间，且总量守恒 */
  let bad = 0, sumBad = 0;
  for (const stars of [[1, 1, 1.4], [0.4, 0.4, 4], [4, 4, 0.4], [1, 1, 1]]) {
    for (const idx of [0, 1]) {
      for (let d = -3000; d <= 3000; d += 37) {
        const r = resizeColStars(stars, idx, d, 1000);
        if (r.some((x) => !(x >= COL_STAR_MIN - 1e-9 && x <= COL_STAR_MAX + 1e-9))) bad++;
        const s0 = stars.reduce((a, b) => a + b, 0);
        const s1 = r.reduce((a, b) => a + b, 0);
        if (Math.abs(s0 - s1) > 1e-6) sumBad++;
      }
    }
  }
  t('穷举：所有位移结果都在合法区间', bad === 0, `越界 ${bad} 例`);
  t('穷举：所有位移都守恒（不凭空增减宽度）', sumBad === 0, `不守恒 ${sumBad} 例`);
}

console.log('\n=== 7. 拖动的非法输入 ===');
t('分隔条下标越界 → 原样返回',
  JSON.stringify(resizeColStars([1, 1, 1.4], 5, 100, 1000)) === '[1,1,1.4]');
t('负下标 → 原样返回',
  JSON.stringify(resizeColStars([1, 1, 1.4], -1, 100, 1000)) === '[1,1,1.4]');
t('总宽为 0 → 原样返回（不能除零）',
  JSON.stringify(resizeColStars([1, 1, 1.4], 0, 100, 0)) === '[1,1,1.4]');
t('总宽为负 → 原样返回',
  JSON.stringify(resizeColStars([1, 1, 1.4], 0, 100, -500)) === '[1,1,1.4]');
t('位移为 0 → 不变',
  JSON.stringify(resizeColStars([1, 1, 1.4], 0, 0, 1000)) === '[1,1,1.4]');

console.log('\n=== 8. 高度夹取 ===');
t('区间内原样', clampLogHeight(300) === 300);
t('低于下限 → 夹到下限', clampLogHeight(10) === LOG_HEIGHT_MIN, String(clampLogHeight(10)));
t('高于上限 → 夹到上限', clampLogHeight(9999) === LOG_HEIGHT_MAX);
t('null → 默认', clampLogHeight(null) === LOG_HEIGHT_DEFAULT);
t('空串 → 默认', clampLogHeight('') === LOG_HEIGHT_DEFAULT);
t('NaN → 默认', clampLogHeight(NaN) === LOG_HEIGHT_DEFAULT);
t('小数 → 取整', clampLogHeight(150.6) === 151, String(clampLogHeight(150.6)));
t('数字串能解析', clampLogHeight('280') === 280);

console.log('\n=== 9. 浮层高度：null 表示自适应（不能被夹成 0）===');
t('null → 仍为 null（自适应）', clampPanelHeight(null) === null);
t('undefined → 仍为 null', clampPanelHeight(undefined) === null);
t('空串 → 仍为 null', clampPanelHeight('') === null);
t('低于下限 → 夹到下限', clampPanelHeight(50) === PANEL_HEIGHT_MIN, String(clampPanelHeight(50)));
t('高于上限 → 夹到上限', clampPanelHeight(99999) === PANEL_HEIGHT_MAX);
t('合法值原样', clampPanelHeight(520) === 520);

done();
