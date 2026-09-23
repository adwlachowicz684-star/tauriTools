/**
 * config 兜底整理对齐原版 ConfigService.Normalize（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/config-normalize-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const store = fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/store.rs'), 'utf8');

console.log('\n=== 1. 空名页签要兜底（原版 t.Name = "页签"）★★ ===');
{
  /*
   * 原版：if (string.IsNullOrWhiteSpace(t.Name)) t.Name = "页签";
   *
   * 不兜底的后果：手改 config.json 把页签名设成空串或纯空格，
   * 界面上那个页签按钮是**空白的、宽度塌到几乎为零** ——
   * 用户不知道它存在、点不中它、也没法给它改名（找不到它在哪）。
   * 它里面的卡片就这样被"藏"起来了，且没有任何报错。
   */
  const i = store.indexOf('fn ensure_default_tabs(');
  const b = store.slice(i, store.indexOf('\nfn ensure_ranges(', i));
  t('项目页签空名兜底', /for t in cfg\.project_tabs\.iter_mut\(\)/.test(b));
  t('项目组页签空名兜底', /for t in cfg\.group_tabs\.iter_mut\(\)/.test(b));
  /* 必须按 trim 后判空，纯空格名同样看不出是什么 */
  t('按 trim 后判空（纯空格也算）', (b.match(/t\.name\.trim\(\)\.is_empty\(\)/g) || []).length === 2);
  t('兜底名是"页签"', (b.match(/t\.name = "页签"\.into\(\)/g) || []).length === 2);
}

console.log('\n=== 2. 图标分组只兜底空名，**绝不能**凭空补一个空分组 ★★ ===');
{
  const i = store.indexOf('fn ensure_default_tabs(');
  const b = store.slice(i, store.indexOf('\nfn ensure_ranges(', i));
  t('分组空名兜底为"分组"', /if g\.name\.trim\(\)\.is_empty\(\) \{ g\.name = "分组"\.into\(\); \}/.test(b));
  /*
   * 反面证据（本轮真踩过）：后端一旦补出空分组，前端那个兜底
   * 就永远不触发 —— 图标区彻底空白，用户既看不到内置图标、
   * 也分不清是"没图标"还是"加载失败"。
   *
   * 这类"后端加兜底、把前端兜底顶掉"的坑没有报错，只有空白。
   */
  t('不补空分组（会顶掉前端的内置图标兜底）', !/if cfg\.icon_groups\.is_empty\(\)/.test(b));
  t('注释写明为什么不能补', /为什么不能补一个空分组/.test(b));
  const grid = fs.readFileSync(path.join(HERE, 'components/PresetIconGrid.tsx'), 'utf8');
  t('前端兜底依赖"一个分组都没有"', /if \(groups\.length > 0\) return groups;/.test(grid));
  t('前端兜底给出全部内置图标', /\{ name: DEFAULT_GROUP, icons: \[\.\.\.PRESET_ICON_NAMES\] \}/.test(grid));
}

console.log('\n=== 3. 原有兜底没被改坏 ===');
{
  const i = store.indexOf('fn ensure_default_tabs(');
  const b = store.slice(i, store.indexOf('\nfn ensure_ranges(', i));
  t('项目页签至少一个', /if cfg\.project_tabs\.is_empty\(\)/.test(b));
  t('项目组页签至少一个', /if cfg\.group_tabs\.is_empty\(\)/.test(b));
  t('新建的叫"默认"', (b.match(/first\.name = "默认"\.into\(\)/g) || []).length === 2);
  t('仍走 load_config', /fn load_config\(dir: &Path\)/.test(store));
  t('ensure_default_tabs 被 load_config 调', /ensure_default_tabs\(&mut cfg\);/.test(store));
  t('ensure_ranges 仍在', /fn ensure_ranges\(/.test(store));
  t('migrate_config 仍在', /migrate_config\(&mut cfg\);/.test(store));
}

console.log('\n=== 4. 写入路径仍安全 ===');
{
  t('损坏时隔离现场而非静默默认', /LoadOutcome::Corrupted/.test(store));
  t('原子写仍在', /replace_file\(&tmp, path\)/.test(store));
  t('写失败清临时文件', /fs::remove_file\(&tmp\)\.ok\(\);/.test(store));
}

done();
