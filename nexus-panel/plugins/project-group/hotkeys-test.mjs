/**
 * 快捷键注册表回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：把它存成 nexus-panel/plugins/project-group/hotkeys-test.mjs，然后
 *         node plugins/project-group/hotkeys-test.mjs
 *
 * 为什么不用 esbuild：本文件直接吃 utils/hotkeys.ts 的源码，用一个内嵌的极简
 * TS 类型剥离器转成 ESM 再 import —— 不需要装任何东西，也不会因为构建工具
 * 版本差异而跑不起来。这是"直接测源码"与"零依赖"的折中。
 *
 * 测的是这些容易悄悄腐化的地方：
 *   · 加新键位忘了给 group → 分组列表里直接少一条，谁也不会发现
 *   · 两个动作默认键位撞车 → 用户按 A 却做了 B，还以为是自己设重了
 *   · 覆盖/取消绑定的语义被改坏 → 重启后又活过来
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HK = await loadTs(path.join(HERE, 'utils/hotkeys.ts'));
const { t, done } = makeT();

const { HOTKEYS, GROUP_LABEL, hotkeysByGroup, effectiveCombo, effectiveMap,
        findConflicts, formatCombo, normalizeCombo, comboFromEvent } = HK;

console.log('\n=== 1. 注册表完整性 ===');
/* 20 → 22：补了上下键导航（原版 NavigateAdjacent）两条 */
t('总条数 = 22', HOTKEYS.length === 22, `${HOTKEYS.length} 条`);
t('id 无重复', new Set(HOTKEYS.map((h) => h.id)).size === HOTKEYS.length);
const missingGroup = HOTKEYS.filter((h) => !h.group);
t('每条都标了 group（漏标会在分组列表里静默消失）',
  missingGroup.length === 0, missingGroup.map((h) => h.id).join(',') || '无');
const badGroup = HOTKEYS.filter((h) => !['general', 'card', 'tab'].includes(h.group));
t('group 取值都在三组内', badGroup.length === 0, badGroup.map((h) => h.id).join(',') || '无');

console.log('\n=== 2. 分组（#229）===');
const grouped = hotkeysByGroup();
t('分成三组', grouped.length === 3, grouped.map((g) => g.group).join('/'));
t('三组加起来不丢不重', grouped.reduce((n, g) => n + g.items.length, 0) === HOTKEYS.length);
t('每组都有中文标题', grouped.every((g) => GROUP_LABEL[g.group]));
t('组序为 常规→项目操作→页签切换',
  grouped.map((g) => g.group).join(',') === 'general,card,tab');

console.log('\n=== 3. 默认键位不得撞车 ===');
const byCombo = new Map();
for (const h of HOTKEYS) {
  const c = normalizeCombo(h.combo);
  byCombo.set(c, [...(byCombo.get(c) ?? []), h.id]);
}
const dup = [...byCombo.entries()].filter(([, ids]) => ids.length > 1);
t('默认键位无重复', dup.length === 0,
  dup.map(([c, ids]) => `${c}(${ids.join('+')})`).join(' ') || '无');
t('每条都有非空默认键位', HOTKEYS.every((h) => normalizeCombo(h.combo)));

console.log('\n=== 4. 补齐的 5 条必须在册 ===');
for (const [id, combo, label] of [
  ['toggleTips', 'f1', '使用说明 #222'],
  ['backupNow', 'f7', '一键备份 #226'],
  ['toggleMcp', 'mod+m', 'MCP 启停 #221'],
  ['toggleSidebar', 'shift+~', '收起左栏 #225'],
  ['openMarkdown', 'mod+d', '编辑文件 #223'],
]) {
  const h = HOTKEYS.find((x) => x.id === id);
  t(label, !!h && normalizeCombo(h.combo) === normalizeCombo(combo), h ? h.combo : '缺失');
}
t('#224 HideToTray 不在册（托盘归主窗口任务）',
  !HOTKEYS.some((h) => h.id === 'hideToTray'));

console.log('\n=== 5. shift 精确匹配（Web 与 WPF 的差异点）===');
const side = HOTKEYS.find((h) => h.id === 'toggleSidebar');
t('toggleSidebar 显式带 shift', /shift/.test(normalizeCombo(side.combo)), side.combo);

console.log('\n=== 6. 覆盖与取消绑定 ===');
t('未覆盖时取默认', effectiveCombo('rename', null) === 'f2');
t('覆盖生效', effectiveCombo('rename', { rename: 'mod+r' }) === 'mod+r');
t('显式空串 = 取消绑定（不能退回默认）', effectiveCombo('rename', { rename: '' }) === '');
t('未知 id 不炸', effectiveCombo('nope', {}) === '');
{
  const m = effectiveMap({ open: 'mod+shift+o' });
  t('effectiveMap 覆盖项生效', m.open === 'mod+shift+o');
  t('effectiveMap 未覆盖项取默认', m.lock === 'mod+l');
}

console.log('\n=== 7. 冲突检测 ===');
t('无冲突时返回空', findConflicts(null).length === 0);
{
  const c = findConflicts({ rename: 'f4', color: 'f4' });
  t('两个动作撞同一个键 → 报出来', c.length === 1 && c[0].ids.length === 2, JSON.stringify(c));
  t('冲突项里含两个 id', !!c[0] && c[0].ids.includes('rename') && c[0].ids.includes('color'));
}
t('空串（已取消绑定）不参与冲突', findConflicts({ rename: '', color: '' }).length === 0);
t('大小写/分隔符差异视为同一键',
  findConflicts({ rename: 'MOD+R', move: 'mod+r' }).length === 1);

console.log('\n=== 8. 展示格式化 ===');
t('mod → Ctrl（非 mac）', formatCombo('mod+o', false) === 'Ctrl+O', formatCombo('mod+o', false));
t('mod → ⌘（mac）', formatCombo('mod+o', true) === '⌘O', formatCombo('mod+o', true));
t('修饰键顺序 mod/ctrl → shift → alt（不能倒过来）',
  formatCombo('alt+shift+mod+k', false) === 'Ctrl+Shift+Alt+K',
  formatCombo('alt+shift+mod+k', false));
t('功能键大写', formatCombo('f7', false) === 'F7');
t('方向键转符号', formatCombo('mod+arrowleft', false) === 'Ctrl+←');
t('未绑定显示占位', formatCombo('', false) === '（未绑定）');

console.log('\n=== 9. 从按键事件反推 combo ===');
const keyEvt = (init) => ({ key: '', code: '', ctrlKey: false, shiftKey: false,
                            altKey: false, metaKey: false, ...init });
t('单按修饰键不算', comboFromEvent(keyEvt({ key: 'Shift' })) === null);
t('Ctrl+O → mod+o', comboFromEvent(keyEvt({ key: 'o', ctrlKey: true })) === 'mod+o');
t('⌘+O 也归一到 mod+o', comboFromEvent(keyEvt({ key: 'o', metaKey: true })) === 'mod+o');
t('F7 → f7', comboFromEvent(keyEvt({ key: 'F7', code: 'F7' })) === 'f7');
t('Shift+~ → shift+~（与默认键位写法一致）',
  comboFromEvent(keyEvt({ key: '~', shiftKey: true })) === 'shift+~');
t('Escape → esc', comboFromEvent(keyEvt({ key: 'Escape' })) === 'esc');

done();
