/**
 * 按钮快捷键提示回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/hint-test.mjs，然后
 *         node plugins/project-group/hint-test.mjs
 *
 * #50 的两条核心：
 *   · 键位**从 HOTKEYS 动态取**，不手抄（手抄会漂，本项目已吃过这个亏）
 *   · 用户**取消绑定**后按钮上不能显示任何提示 ——
 *     退回默认值的话，用户按按钮上的提示去按却没反应
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const HK = await loadTs(path.join(HERE, 'utils/hotkeys.ts'));
const H = await loadTs(path.join(HERE, 'utils/hint.ts'));
const { effectiveCombo, formatCombo, HOTKEYS } = HK;
const { comboHintOf, shouldShowHint, toolbarHint } = H;

console.log('\n=== 1. 键位一律动态取（不手抄）===');
{
  // 默认键位
  t('备份 → F7', comboHintOf('backupNow', null, false) === 'F7',
    comboHintOf('backupNow', null, false));
  t('使用说明 → F1', comboHintOf('toggleTips', null, false) === 'F1');
  t('刷新 → F5', comboHintOf('refresh', null, false) === 'F5');
  t('清除无效项 → F8', comboHintOf('clearInvalid', null, false) === 'F8');
  // 用户改了键位，提示要跟着变
  t('覆盖后提示跟着变（Ctrl+B）',
    comboHintOf('backupNow', { backupNow: 'mod+b' }, false) === 'Ctrl+B',
    comboHintOf('backupNow', { backupNow: 'mod+b' }, false));
  t('mac 上显示 ⌘ 而非 Ctrl',
    comboHintOf('toggleMcp', null, true) === '⌘M',
    comboHintOf('toggleMcp', null, true));
}

console.log('\n=== 2. 取消绑定后不显示（核心）===');
{
  t('显式空串 → 提示为空（不是退回默认）',
    comboHintOf('backupNow', { backupNow: '' }, false) === '',
    JSON.stringify(comboHintOf('backupNow', { backupNow: '' }, false)));
  t('取消绑定后 shouldShowHint 为假',
    shouldShowHint(true, 'backupNow', { backupNow: '' }) === false);
  t('取消绑定后按钮上没有任何键位',
    toolbarHint('backupNow', { backupNow: '' }, false, true) === '',
    JSON.stringify(toolbarHint('backupNow', { backupNow: '' }, false, true)));
  /* 反面：没取消绑定时，同一个函数要能带上键位 */
  t('正常时按钮上带键位',
    toolbarHint('backupNow', null, false, true) === 'F7',
    toolbarHint('backupNow', null, false, true));
}

console.log('\n=== 3. 开关（#50 的设置项）===');
{
  t('开关关闭 → 不显示', shouldShowHint(false, 'backupNow', null) === false);
  t('开关关闭 → 按钮上不带键位',
    toolbarHint('backupNow', null, false, false) === '',
    JSON.stringify(toolbarHint('backupNow', null, false, false)));
  t('开关开启 → 显示', shouldShowHint(true, 'backupNow', null) === true);
  t('未映射的动作（无 actionId）→ 不显示',
    shouldShowHint(true, undefined, null) === false);
  t('未知动作 id → 不显示（不炸）',
    shouldShowHint(true, 'nope', null) === false);
}

console.log('\n=== 4. 界面上用到的键位 id 都真实存在 ===');
{
  /*
   * 原来是"hint.ts 里的映射表"，现在调用方直接传 id（不再有映射表）：
   * 改文案不会静默丢提示了，但**拼错 id** 同样静默丢提示 ——
   * 所以直接从 App.tsx 里把 comboHint('xxx') 抠出来逐个验真。
   */
  const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');
  const ids = new Set(HOTKEYS.map((h) => h.id));
  const used = [...app.matchAll(/comboHint\('([^']+)'\)/g)].map((m) => m[1]);
  const bad = used.filter((id) => !ids.has(id));
  t('抠到了界面上用到的 id（判据非空）', used.length >= 4, `${used.length} 个`);
  t('每个 id 都在 HOTKEYS 里',
    bad.length === 0, bad.join(',') || '无');
}

console.log('\n=== 5. 界面接线 ===');
{
  const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');
  t('读取设置的 showShortcuts（默认开）',
    /boot\?\.config\.showShortcuts \?\? true/.test(app));
  t('四个按钮都带键位 span', (app.match(/fpx-key/g) || []).length === 4,
    `${(app.match(/fpx-key/g) || []).length} 处`);
  /*
   * 键位值走 comboHint（动态）而非写死。
   * 判据是"由 comboHint 算出"，不钉 formatCombo 包裹 ——
   * 那层包裹已移到 hint.ts 的 comboHintOf 里（返回的已是格式化串），
   * 钉死旧写法会在接线方式调整时误报。
   */
  t('键位值走 comboHint（动态）而非写死',
    /<span className="fpx-key">\{comboHint\(/.test(app));
  /* 显示与否的判据在 utils/hint.ts，App 不内联第二份 */
  t('App 不内联 effectiveCombo / isHotkeyId',
    !/effectiveCombo\(/.test(app) && !/isHotkeyId\(/.test(app));
  t('按钮里没有硬编码的键位文字',
    !/>备份 F7</.test(app) && !/备份\s*F7\s*</.test(app));
  /* 关键：取消绑定时 span 整体不渲染，而不是渲染成默认键 */
  t('取消绑定时 span 不渲染（&& 短路）',
    /comboHint\('[^']+'\) && <span/.test(app));
}
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8');
  t('设置页有开关', /在按钮上显示快捷键/.test(dlg));
  t('开关绑到 config.showShortcuts',
    /checked=\{config\.showShortcuts\}/.test(dlg));
}
{
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
  t('有 .fpx-key 样式', /\.fpx-key/.test(css));
}

console.log('\n=== 6. 后端字段 ===');
{
  const rsPath = path.join(HERE, '../../src-tauri/src/fpx/model.rs');
  if (!fs.existsSync(rsPath)) {
    console.log('（跳过：未找到 model.rs）');
  } else {
    const rs = fs.readFileSync(rsPath, 'utf8');
    t('Rust 有 show_shortcuts 字段', /pub show_shortcuts: bool/.test(rs));
    t('默认值为 true（默认开）',
      /fn default_show_shortcuts\(\) -> bool \{ true \}/.test(rs));
    t('Default 里用上了默认值',
      /show_shortcuts: default_show_shortcuts\(\)/.test(rs));
  }
  const ts = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');
  t('前端 types 有 showShortcuts', /showShortcuts: boolean/.test(ts));
}

done();
