/**
 * 日志保留条数回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/log-test.mjs，然后
 *         node plugins/project-group/log-test.mjs
 *
 * 钉住 #32 的两条约定：
 *   1. 前端常量与后端常量必须同数 —— 两边一旦不一致，
 *      就会出现"设置里填 5000、后端存回 2000、界面显示 2000"这种对不上
 *   2. clamp 的边界行为：非数字收敛默认值、越界夹回、小数取整
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');

const stripTS = (src) => {
  let s = src;
  s = s.replace(/^export type [\s\S]*?;\n/gm, '');
  s = s.replace(/^export interface [\s\S]*?^\}\n/gm, '');
  s = s.replace(/^(\s*)(export )?const (\w+)\s*:\s*[^=\n]*=/gm, '$1$2const $3 =');
  s = s.replace(/:\s*Record<[^<>]*>\s*(?:\|\s*(?:null|undefined)\s*)*/g, '');
  const T = '(?:[A-Z][\\w.]*|string|number|boolean|null|undefined|void|any|unknown|never)';
  s = s.replace(new RegExp('(\\b\\w+)\\s*:\\s*' + T + '[\\w.\\[\\]| ]*?(?=\\s*[,)])', 'g'), '$1');
  s = s.replace(/\s*\w+>\s*(?=\))/g, '');
  s = s.replace(/\s*\|\s*[\w.]+\s*(?=\))/g, '');
  s = s.replace(/\)\s*:\s*\{[^{}\n]*\}\s*(?:\[\])?\s*\{/g, ') {');
  s = s.replace(/\)\s*:\s*[^{\n]*\{/g, ') {');
  s = s.replace(/new (\w+)<[^<>]*>\(/g, 'new $1(');
  s = s.replace(/\s+as\s+[\w.\[\]<>|]+/g, '');
  s = s.replace(/\breadonly\s+/g, '');
  return s;
};

const L = await loadTs(path.join(HERE, 'utils/log.ts'));
const { t, done } = makeT();

const { LOG_MAX_LINES_MIN, LOG_MAX_LINES_MAX, LOG_MAX_LINES_DEFAULT, clampLogMax } = L;

console.log('\n=== 1. 常量本身 ===');
t('下限为 10', LOG_MAX_LINES_MIN === 10, String(LOG_MAX_LINES_MIN));
t('上限为 2000', LOG_MAX_LINES_MAX === 2000, String(LOG_MAX_LINES_MAX));
t('默认为 40（与改动前"显示 40 条"一致）', LOG_MAX_LINES_DEFAULT === 40, String(LOG_MAX_LINES_DEFAULT));
t('默认落在区间内',
  LOG_MAX_LINES_DEFAULT >= LOG_MAX_LINES_MIN && LOG_MAX_LINES_DEFAULT <= LOG_MAX_LINES_MAX);
t('下限 < 上限', LOG_MAX_LINES_MIN < LOG_MAX_LINES_MAX);

console.log('\n=== 2. 与后端常量同数（前后端漂移护栏）===');
const rsPath = path.join(ROOT, 'src-tauri/src/fpx/model.rs');
if (fs.existsSync(rsPath)) {
  const rs = fs.readFileSync(rsPath, 'utf8');
  const grab = (name) => {
    const m = rs.match(new RegExp(`pub const ${name}: u32 = (\\d+)`));
    return m ? Number(m[1]) : null;
  };
  t('后端 LOG_MAX_LINES_MIN 一致', grab('LOG_MAX_LINES_MIN') === LOG_MAX_LINES_MIN,
    `后端 ${grab('LOG_MAX_LINES_MIN')} / 前端 ${LOG_MAX_LINES_MIN}`);
  t('后端 LOG_MAX_LINES_MAX 一致', grab('LOG_MAX_LINES_MAX') === LOG_MAX_LINES_MAX,
    `后端 ${grab('LOG_MAX_LINES_MAX')} / 前端 ${LOG_MAX_LINES_MAX}`);
  t('后端 LOG_MAX_LINES_DEFAULT 一致', grab('LOG_MAX_LINES_DEFAULT') === LOG_MAX_LINES_DEFAULT,
    `后端 ${grab('LOG_MAX_LINES_DEFAULT')} / 前端 ${LOG_MAX_LINES_DEFAULT}`);
  t('后端有 clamp 函数', /pub fn clamp_log_max_lines/.test(rs));
  t('后端 Default 里用上了默认值',
    /log_max_lines: LOG_MAX_LINES_DEFAULT/.test(rs));
  /* ensure_ranges 定义在 store.rs（不是 model.rs）—— 夹取发生在**加载**路径上，
     两处加载入口（宽松的 load_config 与严格的 load_config_strict）都要夹到，
     漏一处就会出现"写入时合法、只读路径却拿到越界值"。 */
  const storePath = path.join(ROOT, 'src-tauri/src/fpx/store.rs');
  const st = fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : '';
  t('后端定义了 ensure_ranges', /fn ensure_ranges\(cfg: &mut FpxConfig\)/.test(st));
  t('两处加载入口都夹（宽松 + 严格各一次）',
    (st.match(/ensure_ranges\(&mut cfg\)/g) ?? []).length === 2,
    `调用 ${(st.match(/ensure_ranges\(&mut cfg\)/g) ?? []).length} 处`);
} else {
  console.log('（跳过：未找到 model.rs）');
}

console.log('\n=== 3. clamp 边界 ===');
t('区间内的值原样返回', clampLogMax(100) === 100);
t('等于下限', clampLogMax(LOG_MAX_LINES_MIN) === LOG_MAX_LINES_MIN);
t('等于上限', clampLogMax(LOG_MAX_LINES_MAX) === LOG_MAX_LINES_MAX);
t('低于下限 → 夹到下限', clampLogMax(1) === LOG_MAX_LINES_MIN, String(clampLogMax(1)));
t('高于上限 → 夹到上限', clampLogMax(99999) === LOG_MAX_LINES_MAX, String(clampLogMax(99999)));
t('0 → 夹到下限', clampLogMax(0) === LOG_MAX_LINES_MIN);
t('负数 → 夹到下限', clampLogMax(-5) === LOG_MAX_LINES_MIN);

console.log('\n=== 4. 非法输入（手改配置 / 空输入框）===');
t('NaN → 默认值', clampLogMax(NaN) === LOG_MAX_LINES_DEFAULT);
t('undefined → 默认值', clampLogMax(undefined) === LOG_MAX_LINES_DEFAULT);
t('null → 默认值', clampLogMax(null) === LOG_MAX_LINES_DEFAULT);
t('空串 → 默认值', clampLogMax('') === LOG_MAX_LINES_DEFAULT);
t('非数字串 → 默认值', clampLogMax('abc') === LOG_MAX_LINES_DEFAULT);
t('数字串 → 正常解析', clampLogMax('120') === 120);
t('小数 → 取整', clampLogMax(50.7) === 50, String(clampLogMax(50.7)));
t('Infinity → 夹到上限', clampLogMax(Infinity) === LOG_MAX_LINES_MAX);

done();
