/**
 * config schema 版本化与未知键检测回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/config-schema-test.mjs，然后
 *         node plugins/project-group/config-schema-test.mjs
 *
 * NEW-4（#454）：此前全靠 `#[serde(default)]` 兼容旧配置，
 * 那只解决了"新字段缺失"，解决不了**旧字段被悄悄丢掉** ——
 * 字段改名后 JSON 里那个旧键还在，而新结构没有对应字段，
 * serde 默认忽略未知键，用户的数据静默消失（清单 #454 记过一次 clusters）。
 *
 * 这里守四件容易做错的事：
 *   · 合法字段集**由序列化自身推导**，不是手写清单（手写必然漂移）
 *   · 老配置没有版本号 → 按 1 处理，加载后升到最新
 *   · 保存时版本号**不沿用前端传来的值**（否则"未迁移"会一直传下去）
 *   · 未知键要**列出键名**，只报数量用户没法改
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx');
const { t, done } = makeT();

const model = fs.readFileSync(path.join(RS, 'model.rs'), 'utf8');
const store = fs.readFileSync(path.join(RS, 'store.rs'), 'utf8');
const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8');
const types = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');

console.log('\n=== 1. 版本常量与字段 ===');
{
  t('定义了 CURRENT_SCHEMA', /pub const CURRENT_SCHEMA: u32 = \d+;/.test(model));
  const m = model.match(/pub const CURRENT_SCHEMA: u32 = (\d+);/);
  t('当前版本 ≥ 2（1 是"没有这个键"的旧配置）', Number(m?.[1] ?? 0) >= 2, m?.[1]);
  t('FpxConfig 有 schema_version', /pub schema_version: u32/.test(model));
  t('带 serde default（老配置缺这个键也能读）',
    /#\[serde\(default = "default_schema"\)\]\s*pub schema_version/.test(model));
  const dm = model.match(/fn default_schema\(\) -> u32 \{\s*(\d+)\s*\}/);
  t('缺失时按 1 处理', dm?.[1] === '1', dm?.[1]);
  t('Default 里用 CURRENT_SCHEMA（新配置直接是最新）',
    /schema_version: CURRENT_SCHEMA,/.test(model));
}

console.log('\n=== 2. 合法字段集由序列化推导（核心）===');
{
  t('known_config_keys 存在', /pub fn known_config_keys\(\) -> HashSet<String>/.test(store));
  const fn = store.slice(store.indexOf('pub fn known_config_keys'), store.indexOf('pub fn unknown_config_keys'));
  t('用 FpxConfig::default() 序列化推导', /serde_json::to_value\(FpxConfig::default\(\)\)/.test(fn));
  t('取的是 object 的 keys', /as_object\(\)/.test(fn));
  t('推导失败时返回空集（不能因此报错）', /unwrap_or_default\(\)/.test(fn));
  t('注释说明"手写清单会漂移"', /手写的清单必然与实际字段漂移/.test(store));
}

console.log('\n=== 3. 未知键检测 ===');
{
  const fn = store.slice(store.indexOf('pub fn unknown_config_keys'), store.indexOf('pub fn migrate_config'));
  t('过滤掉已知键', /filter\(\|k\| !known\.contains\(\*k\)\)/.test(fn));
  t('结果排序（输出稳定，便于比对与测试）', /out\.sort\(\);/.test(fn));
  /* 只报数量的话，用户知道"有 3 个未知键"却不知道是哪些，没法改 */
  const notice = store.slice(store.indexOf('pub fn config_issues'), store.indexOf('pub fn save_config'));
  t('提示里列出键名（不是只报数量）', /unknown\.join\("、"\)/.test(notice));
  t('点明"会被忽略"', /不被识别的键，它们会被忽略/.test(notice));
  t('解析失败时不重复报错（交给加载路径）',
    /Err\(_\) => return Vec::new\(\)/.test(notice));
}

console.log('\n=== 4. 迁移框架 ===');
{
  t('migrate_config 存在', /pub fn migrate_config\(cfg: &mut FpxConfig\)/.test(store));
  const fn = store.slice(store.indexOf('pub fn migrate_config'), store.indexOf('pub fn load_config'));
  t('逐级升（while 而非 if）', /while cfg\.schema_version < model::CURRENT_SCHEMA/.test(fn));
  t('已是最新版则返回空（不每次刷一句"已迁移"）',
    /已是最新版则返回空/.test(store));
  t('未知版本有兜底提示', /未知的配置版本 \{other\}/.test(fn));
  t('每级都推进版本号（防死循环）', /cfg\.schema_version = from \+ 1;/.test(fn));
}

console.log('\n=== 5. 保存时盖版本号（关键）===');
{
  const fn = mod.slice(mod.indexOf('pub(crate) fn core_save_config'), mod.indexOf('pub(crate) fn core_create_link'));
  t('保存时写 CURRENT_SCHEMA', /cfg\.schema_version = model::CURRENT_SCHEMA;/.test(fn));
  t('注释说明"不沿用前端传来的值"', /不沿用前端传来的值/.test(fn));
  /* 若照抄前端的值，刚从 v1 读出来还没写回的快照会把"未迁移"一直传下去 */
  t('不是照抄 config.schema_version', !/cfg\.schema_version = config\.schema_version/.test(fn));
}

console.log('\n=== 6. 加载路径接上了 ===');
{
  const lc = store.slice(store.indexOf('pub fn load_config(dir'), store.indexOf('pub fn load_config_strict'));
  t('load_config 里跑迁移', /migrate_config\(&mut cfg\);/.test(lc));
  t('config_issues 存在', /pub fn config_issues\(dir: &Path\) -> Vec<String>/.test(store));
  t('config_issues 是只读的（不写文件）',
    /读路径不该顺手改文件/.test(store));
  t('bootstrap 带上了体检结果',
    /config_notices: store::config_issues\(&dir\)/.test(mod));
  t('Bootstrap 有 config_notices 字段', /pub config_notices: Vec<String>/.test(model));
}

console.log('\n=== 7. 前端 ===');
{
  t('types.ts 有 configNotices', /configNotices: string\[\]/.test(types));
  t('types.ts 有 schemaVersion', /schemaVersion: number/.test(types));
  const hk = fs.readFileSync(path.join(HERE, 'hooks/useFpx.ts'), 'utf8');
  t('启动后提示一次', /configNotices/.test(hk));
  t('用 ref 保证不重复提示', /noticedRef/.test(hk));
  t('提示单独一个 effect、不塞进 refresh',
    /单独一个 effect、不塞进 refresh/.test(hk));
  t('refresh 的依赖数组没被塞进 pushLog',
    !/\[api, run, ctx, pushLog\]/.test(hk));
  t('写进日志（能回头看）', /配置提醒：\$\{n\}/.test(hk));
  t('首条另弹 toast（保证不被略过）', /ctx\.toast\(notes\[0\], 'err'\)/.test(hk));
}

console.log('\n=== 8. 已有字段不受影响 ===');
{
  t('老字段仍带 serde(default)（缺了也能读）',
    (model.match(/#\[serde\(default\)\]/g) || []).length > 20);
  t('ensure_ranges 仍在（clamp 不因迁移而失效）',
    /ensure_ranges\(&mut cfg\)/.test(store));
  t('ensure_default_tabs 仍在', /ensure_default_tabs\(&mut cfg\)/.test(store));
}

done();
