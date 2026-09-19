/**
 * project-group 快捷键注册表回归测试
 * ============================================================
 * 背景：注册表原本 15 条，缺 5 个动作（#221~#226）。
 *
 * 用 typescript 编译器把 hotkeys.ts 转译后 import —— 与 js/plugin-admit.js
 * 同一套剥离器（项目已有的 devDependency），不新增依赖，也不用正则
 * 去猜类型注解（猜错会得到"看起来能跑、实则漏了条目"的假结果）。
 *
 * 第 6~9 节测的是**既有**实现（effectiveCombo / effectiveMap /
 * findConflicts / formatCombo / normalizeCombo / comboFromEvent）。
 * 这批已实测通过、本轮不改，保留它们是为了防止后续改动打穿。
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const t = (name, cond, hint = '') => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${hint ? `  —— ${hint}` : ''}`); }
};

/* ---------- 剥离器：TS → JS 再 import ---------- */
const SRC = path.join(HERE, 'utils/hotkeys.ts');
const TMP = path.join(HERE, '.__hotkeys.tmp.mjs');
{
  const out = ts.transpileModule(readFileSync(SRC, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2021,
    },
  }).outputText;
  writeFileSync(TMP, out, 'utf8');
}
/** 测试结束必须删掉临时文件，否则会混进构建产物 */
const cleanup = () => { try { unlinkSync(TMP); } catch { /* 已删 */ } };
process.on('exit', cleanup);

const M = await import(`file://${TMP}`);
const {
  HOTKEYS, HOTKEY_BY_ID, GROUP_LABEL, HOTKEY_GROUPS, hotkeysByGroup,
  effectiveCombo, effectiveMap, findConflicts,
  formatCombo, normalizeCombo, comboFromEvent,
} = M;

const src = readFileSync(SRC, 'utf8');

/** 既有 id：一个都不能改字面量（写进用户 config，改了老用户覆盖项静默失效） */
const LEGACY_IDS = [
  'open', 'lock', 'rename', 'move', 'color', 'icon', 'remove',
  'refresh', 'clearInvalid', 'cycleGroup', 'cycleGroupBack',
  'cycleProject', 'cycleProjectBack', 'focusProject', 'focusGroup',
];

/** 本轮补齐的 5 个 */
const NEW_KEYS = [
  { id: 'toggleTips', label: '使用说明', combo: 'f1' },
  { id: 'backupNow', label: '一键备份', combo: 'f7' },
  { id: 'toggleMcp', label: '启停 MCP', combo: 'mod+m' },
  { id: 'toggleSidebar', label: '收起/展开左栏', combo: 'shift+~' },
  { id: 'openMarkdown', label: '编辑文件', combo: 'mod+d' },
];

console.log('=== 1. 注册表规模与 id 唯一 ===');
t('注册表 20 条（原 15 + 新增 5）', HOTKEYS.length === 20, `实际 ${HOTKEYS.length}`);
{
  const ids = HOTKEYS.map((h) => h.id);
  t('id 无重复', new Set(ids).size === ids.length);
  t('每个 id 都能在 HOTKEY_BY_ID 查到',
    ids.every((id) => HOTKEY_BY_ID[id]?.id === id));
  /* 坑1：已有 id 的字面量一个都别改 */
  t('15 个既有 id 全部保留（改字面量会让老用户覆盖项静默失效）',
    LEGACY_IDS.every((id) => ids.includes(id)),
    `缺失: ${LEGACY_IDS.filter((i) => !ids.includes(i)).join(',')}`);
  t('每条都有 label / combo / group',
    HOTKEYS.every((h) => h.label && h.combo && h.group));
}

console.log('\n=== 2. 新增的 5 条 ===');
for (const k of NEW_KEYS) {
  const h = HOTKEY_BY_ID[k.id];
  t(`${k.id} 已注册`, !!h);
  t(`  ${k.id} 默认键为 ${k.combo}`, h?.combo === k.combo, `实际 ${h?.combo}`);
  t(`  ${k.id} 归 general 组`, h?.group === 'general', `实际 ${h?.group}`);
}
t('GROUP_LABEL 已导出', !!GROUP_LABEL);
t('hotkeysByGroup 已导出且是函数', typeof hotkeysByGroup === 'function');

console.log('\n=== 3. 默认键位不得撞车 ===');
{
  const byCombo = new Map();
  for (const h of HOTKEYS) {
    const c = normalizeCombo(h.combo);
    byCombo.set(c, [...(byCombo.get(c) ?? []), h.id]);
  }
  const dup = [...byCombo.entries()].filter(([, ids]) => ids.length > 1);
  t('默认键位之间无重复', dup.length === 0,
    dup.map(([c, ids]) => `${c}: ${ids.join('/')}`).join('; '));
  /*
   * 与既有默认键的交叉检查（清单第四节）。
   * normalizeCombo 后比较，避免大小写/分隔符差异造成误判。
   */
  const existing = ['mod+o', 'mod+l', 'mod+tab', 'mod+shift+tab', 'mod+pagedown',
    'mod+pageup', 'mod+arrowleft', 'mod+arrowright',
    'f2', 'f3', 'f4', 'f5', 'f6', 'f8', 'delete'];
  const existingSet = new Set(existing.map(normalizeCombo));
  const newSet = NEW_KEYS.map((k) => normalizeCombo(k.combo));
  t('5 个新键都不撞既有默认键',
    newSet.every((c) => !existingSet.has(c)),
    `撞车: ${newSet.filter((c) => existingSet.has(c)).join(',')}`);
  t('新键之间也不重复', new Set(newSet).size === newSet.length);
  /* 无覆盖时 findConflicts 应为空 —— 默认配置不该自带冲突 */
  t('无覆盖时 findConflicts 为空', findConflicts(null).length === 0);
}

console.log('\n=== 4. 分组与组序 ===');
{
  const g = hotkeysByGroup();
  t('分 3 组', g.length === 3, `实际 ${g.length}`);
  t('组序固定为 常规 → 项目操作 → 页签切换',
    g.map((x) => x.key).join(',') === 'general,card,tab',
    `实际 ${g.map((x) => x.key).join(',')}`);
  t('组标题来自 GROUP_LABEL',
    g.every((x) => x.label === GROUP_LABEL[x.key]));
  t('三组条目数合计 = 注册表总数',
    g.reduce((n, x) => n + x.items.length, 0) === HOTKEYS.length);
  t('general 组含全部 5 个新增动作',
    NEW_KEYS.every((k) => g[0].items.some((h) => h.id === k.id)));
  t('card 组 = 9 条卡片操作', g[1].items.length === 9, `实际 ${g[1].items.length}`);
  t('tab 组 = 6 条页签切换', g[2].items.length === 6, `实际 ${g[2].items.length}`);
  t('HOTKEY_GROUPS 与 hotkeysByGroup 顺序一致',
    HOTKEY_GROUPS.join(',') === g.map((x) => x.key).join(','));
  t('每条的 group 都在 HOTKEY_GROUPS 里（拼错会被静默漏掉）',
    HOTKEYS.every((h) => HOTKEY_GROUPS.includes(h.group)));
}

console.log('\n=== 5. toggleSidebar 必须写 shift+~ ===');
{
  const h = HOTKEY_BY_ID.toggleSidebar;
  /*
   * 坑2：`~` 在物理键盘上要靠 Shift 才打得出来，comboFromEvent 对这一下
   * 产出的就是 `shift+~`。默认值若写成 `~`，用户什么都没改、只是重新录入
   * 一次，就会与默认不一致 → 界面显示"已自定义"的假差异。
   */
  t('默认键是 shift+~（不是裸 ~）', h.combo === 'shift+~', `实际 ${h.combo}`);
  /*
   * toggleTips 必须带 `toggle: true`。
   *
   * 少了它，F1 打开使用说明后 enabled 变 false（门控含 !help），
   * **再按 F1 就关不掉**，用户被困在说明里。
   * 破坏验证发现：去掉这个标记时测试红了 0 项 —— 这条断言是补上的。
   */
  t('toggleTips 标了 toggle（否则开了关不掉）',
    HOTKEY_BY_ID.toggleTips?.toggle === true);
  t('useCardHotkeys 把 toggle 传给 bind（豁免弹窗门控）',
    /HOTKEY_BY_ID\[id\]\?\.toggle/.test(
      readFileSync(path.join(HERE, 'hooks/useCardHotkeys.ts'), 'utf8')));
  const ev = { key: '~', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false };
  t('comboFromEvent(Shift+~) 产出 shift+~，与默认一致',
    comboFromEvent(ev) === 'shift+~', `实际 ${comboFromEvent(ev)}`);
  t('默认与重新录入经归一化后相同',
    normalizeCombo(h.combo) === normalizeCombo(comboFromEvent(ev)));
}

console.log('\n=== 6. effectiveCombo / effectiveMap（既有，不改） ===');
{
  t('无覆盖时用默认', effectiveCombo('open', null) === 'mod+o');
  t('覆盖生效', effectiveCombo('open', { open: 'mod+shift+o' }) === 'mod+shift+o');
  t('显式空串 = 取消绑定（不是退回默认）',
    effectiveCombo('open', { open: '' }) === '');
  t('undefined 视为没改过，用默认',
    effectiveCombo('open', { open: undefined }) === 'mod+o');
  t('未知 id 返回空串', effectiveCombo('nope', null) === '');
  const m = effectiveMap(null);
  t('effectiveMap 覆盖全部 20 个 id', Object.keys(m).length === 20);
  t('effectiveMap 的新键也已生效', m.toggleTips === 'f1' && m.openMarkdown === 'mod+d');
}

console.log('\n=== 7. findConflicts ===');
{
  t('无冲突时返回空', findConflicts(null).length === 0);
  t('两个动作抢一个键能报出来',
    findConflicts({ open: 'mod+k', lock: 'mod+k' }).length === 1);
  /* 坑4：空串 = 未绑定，不参与冲突 */
  t('空串不参与冲突（两个都取消绑定不算冲突）',
    findConflicts({ open: '', lock: '' }).length === 0);
  t('冲突条目带上两个 id',
    findConflicts({ open: 'mod+k', lock: 'mod+k' })[0].ids.length === 2);
  t('修饰键顺序不同也算同一个键（归一化）',
    findConflicts({ open: 'mod+shift+k', lock: 'shift+mod+k' }).length === 1);
}

console.log('\n=== 8. formatCombo ===');
{
  t('空 combo 显示为未绑定', formatCombo('', false) === '（未绑定）');
  t('mod 在非 mac 显示为 Ctrl', formatCombo('mod+d', false) === 'Ctrl+D');
  t('mod 在 mac 显示为 ⌘', formatCombo('mod+d', true) === '⌘D');
  t('功能键大写', formatCombo('f1', false) === 'F1');
  /* 曾经写成 reverse，结果 Ctrl+Shift+G 被显示成 Shift+Ctrl+G */
  t('修饰键顺序 mod 在前、shift 居中',
    formatCombo('mod+shift+tab', false) === 'Ctrl+Shift+Tab');
  t('方向键转箭头', formatCombo('mod+arrowleft', false) === 'Ctrl+←');
  t('shift+~ 能正常显示', formatCombo('shift+~', false) === 'Shift+~');
}

console.log('\n=== 9. comboFromEvent ===');
{
  t('单按修饰键返回 null',
    comboFromEvent({ key: 'Shift', shiftKey: true }) === null);
  t('Ctrl 或 Meta 都记作 mod',
    comboFromEvent({ key: 'd', ctrlKey: true }) === 'mod+d'
    && comboFromEvent({ key: 'd', metaKey: true }) === 'mod+d');
  t('功能键转小写 f1',
    comboFromEvent({ key: 'F1' }) === 'f1');
  t('Escape 记为 esc',
    comboFromEvent({ key: 'Escape' }) === 'esc');
  t('空格记为 space', comboFromEvent({ key: ' ' }) === 'space');
  t('Shift+Tab 产出 shift+tab',
    comboFromEvent({ key: 'Tab', shiftKey: true }) === 'shift+tab');
}

console.log('\n=== 10. 接线：4 个消费点都得认新键 ===');
{
  const rd = (p) => readFileSync(path.join(HERE, p), 'utf8');
  const app = rd('App.tsx');
  const hook = rd('hooks/useCardHotkeys.ts');
  const settings = rd('components/HotkeySettings.tsx');
  const rail = rd('components/SideRail.tsx');

  /*
   * 最容易漏的是 useCardHotkeys：不补 handler 就会出现
   * 「设置里看得见、按下去没反应」—— 比没有这项更让人困惑。
   */
  for (const k of NEW_KEYS) {
    t(`useCardHotkeys 注册了 ${k.id}`,
      new RegExp(`run\\('${k.id}'`).test(hook));
  }
  t('HotkeyActions 接口含 5 个新动作',
    NEW_KEYS.every((k) => new RegExp(`\\b${k.id}\\s*:`).test(hook)));
  t('App.tsx 提供了 5 个动作的实现（不是只注册）',
    NEW_KEYS.every((k) => new RegExp(`\\b${k.id}\\s*:`).test(app)
      || new RegExp(`\\b${k.id}\\s*\\(`).test(app)));
  t('设置界面按 group 分组渲染（hotkeysByGroup）',
    /hotkeysByGroup\(\)/.test(settings));
  t('SideRail 仍走注册表解析键位提示（按 id，不写字面量）',
    /effectiveCombo/.test(rail) && /hotkeyId/.test(rail));
  t('App.tsx 把 ContentPanel 的选中项报给 openMarkdown',
    /onSelect=/.test(app) && /setPreviewFile/.test(app));
  t('左栏折叠态有 grid 压窄，不只是隐藏组件',
    /rail-collapsed/.test(app));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log(`
常见原因：
  · 第 2 节红 → 注册表没补齐，或 group 不是 general
  · 第 3 节红 → 默认键位撞车（新键与既有 15 个键冲突）
  · 第 5 节红 → toggleSidebar 写成了裸 ~，应与 comboFromEvent 产出一致
  · 第 10 节红 → 只加了注册表没接线（设置看得见、按下去没反应）`);
}
cleanup();
process.exit(fail ? 1 : 0);
