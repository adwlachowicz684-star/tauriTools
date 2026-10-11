/**
 * 连锁动作快捷键：冲突检测 / 谁生效 / 显示侧与注册侧是否同一个结论（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/chain-hotkey-conflict-test.mjs
 *
 * `findConflicts` 只管内置注册表（`HOTKEYS`）那一份，而连锁动作的
 * `action.shortcut` 交给**外壳**注册（`ctx.registerShortcut`），两条路
 * 各管各的、谁也看不见对方。于是"谁占了哪个键"在全项目里没有一处完整答案。
 *
 * 后果（都不报错，只是界面上写着却按不动）：
 *   · 两个动作设成同一个键 → 外壳那张 accel→event 表只留一个，
 *     **先设的那个静默失效**，而侧边栏与右键菜单上两个都照样显示键位；
 *   · 与内置键位撞车（把动作设成 F2）→ 按下后两条路都收到，谁先抢到不确定，
 *     表现为"按 F2 有时改名、有时拉起一个 AI 进程"。
 *
 * 两种情况下界面都显示着一个**不生效或不稳定生效**的键位，而设置里的
 * 冲突提示一言不发 —— 用户看到"无冲突"，实际是没人查。
 *
 * 判据本身直接 `loadTs` 加载真身来跑（不是另抄一份清单，抄的那份迟早漂移）；
 * 注册侧与显示侧是 JSX / hook，跑不了，用文本断言，但锚点都钉在
 * **判据调用**上，不钉注释里的话（注释喂饱断言是本仓踩过 26 次的坑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';
import { stripCommentsJs as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const R = (rel) => strip(fs.readFileSync(path.join(HERE, rel), 'utf8'));

const HK = await loadTs(path.join(HERE, 'utils/hotkeys.ts'));
const hookSrc = R('hooks/useChainActions.ts');
const railSrc = R('components/SideRail.tsx');
const panelSrc = R('components/ChainActionsPanel.tsx');

/* ------------------------------------------------------------------ */
console.log('\n=== 1. 冲突检测（真身）: 两个动作抢一个键 ===');

const two = [
  { id: 'a1', shortcut: 'ctrl+shift+1' },
  { id: 'a2', shortcut: 'ctrl+shift+1' },
];
const cTwo = HK.chainShortcutConflicts(two, null);
t('两个动作同一个键 → 报出一条冲突', cTwo.length === 1, JSON.stringify(cTwo));
t('冲突里两个动作 id 都在（不是只报一个）',
  !!cTwo[0] && cTwo[0].ids.includes('a1') && cTwo[0].ids.includes('a2'),
  JSON.stringify(cTwo[0]?.ids ?? null));
t('冲突的 combo 是归一化后的形式（大小写与顺序无关）',
  !!cTwo[0] && cTwo[0].combo === HK.normalizeCombo('ctrl+shift+1'),
  cTwo[0]?.combo);

console.log('\n=== 2. 写法不同也算同一个键（大小写 / 顺序）===');

const cCase = HK.chainShortcutConflicts([
  { id: 'a1', shortcut: 'Ctrl+Shift+A' },
  { id: 'a2', shortcut: 'shift+ctrl+a' },
], null);
t("'Ctrl+Shift+A' 与 'shift+ctrl+a' 判为同一个键",
  cCase.length === 1 && cCase[0].ids.length === 2, JSON.stringify(cCase));

console.log('\n=== 3. 与内置键位撞车（必须看覆盖表）===');

/* 默认「改名」= f2。不看覆盖表就会把"用户已让出的键"误判成冲突，
   等于凭空砍掉他刚设好的快捷键。 */
const cF2 = HK.chainShortcutConflicts([{ id: 'a1', shortcut: 'f2' }], null);
t('动作设成 f2 → 与内置「改名」撞车（hotkeyIds 含 rename）',
  cF2.length === 1 && cF2[0].hotkeyIds.includes('rename'), JSON.stringify(cF2));

const cF2Free = HK.chainShortcutConflicts([{ id: 'a1', shortcut: 'f2' }], { rename: 'ctrl+r' });
t('内置「改名」被改成 ctrl+r 后，f2 已让出 → 不算冲突',
  cF2Free.length === 0, JSON.stringify(cF2Free));

console.log('\n=== 4. 谁生效：清单里靠前的那个 ===');

const wTwo = HK.chainShortcutWinners(two, null);
t('两个同键 → 只有一个赢家', wTwo.winners.size === 1, [...wTwo.winners].join(','));
t('赢家是清单里靠前的那个（a1）',
  wTwo.winners.has('a1') && !wTwo.winners.has('a2'), [...wTwo.winners].join(','));
t('两个都记进 conflicted（被砍掉的那个也要能被界面点名）',
  wTwo.conflicted.has('a1') && wTwo.conflicted.has('a2'), [...wTwo.conflicted].join(','));

const wThree = HK.chainShortcutWinners([
  { id: 'a1', shortcut: 'ctrl+shift+1' },
  { id: 'a2', shortcut: 'ctrl+shift+1' },
  { id: 'a3', shortcut: 'ctrl+shift+1' },
], null);
t('三个同键 → 仍然只有一个赢家', wThree.winners.size === 1, [...wThree.winners].join(','));

console.log('\n=== 5. 与内置键位撞车时不能声称"稳赢" ===');

const wF2 = HK.chainShortcutWinners([{ id: 'a1', shortcut: 'f2' }], null);
t('与内置键位撞车 → 没有赢家（谁生效不确定，不能显示成可靠键位）',
  wF2.winners.size === 0, [...wF2.winners].join(','));
t('与内置键位撞车 → 仍记进 conflicted（要能被提示点名）',
  wF2.conflicted.has('a1'), [...wF2.conflicted].join(','));

const wF2Free = HK.chainShortcutWinners([{ id: 'a1', shortcut: 'f2' }], { rename: 'ctrl+r' });
t('内置键位让出后 → 恢复成赢家（不误砍）',
  wF2Free.winners.has('a1'), [...wF2Free.winners].join(','));

console.log('\n=== 6. 空 / 未设键位不参与冲突 ===');

const wEmpty = HK.chainShortcutWinners([
  { id: 'a1', shortcut: 'ctrl+1' },
  { id: 'a2', shortcut: '' },
  { id: 'a3', shortcut: null },
], null);
t('空串与 null 都不算冲突方', wEmpty.conflicted.size === 0, [...wEmpty.conflicted].join(','));
t('设了键的那个照常是赢家', wEmpty.winners.has('a1'), [...wEmpty.winners].join(','));

const wSolo = HK.chainShortcutWinners([{ id: 'a1', shortcut: 'ctrl+shift+2' }], null);
t('唯一一个键 → 无冲突且是赢家',
  wSolo.winners.has('a1') && wSolo.conflicted.size === 0, [...wSolo.conflicted].join(','));

/* ------------------------------------------------------------------ */
console.log('\n=== 7. 注册侧：只注册赢家 ===');

/*
 * 锚点钉在 `chainShortcutWinners(` 上：它只出现在注册那段，
 * 按 `winners` 或 `registerShortcut` 取都可能命中别处（注释已剥，
 * 但同名变量在别的文件里也有）。
 */
t('注册侧走的是与显示侧同一个判据（chainShortcutWinners）',
  hookSrc.includes('chainShortcutWinners('), `调用 ${hookSrc.split('chainShortcutWinners(').length - 1} 次`);

/*
 * 判据必须是"注册调用紧跟在 winners 守卫之后"，而不是"有 shortcut 就注册"。
 *
 * 这里取的是**守卫那句往后的一段窗口**再验里面有没有 registerShortcut，
 * 而不是用括号配平去切 if 条件：注册句是两层 if 嵌套
 * （外层 `a.shortcut && …`、内层 `winners.has(a.id)`），
 * 从 registerShortcut 往回找最近的 `if (` 只会切到内层那一句，
 * 于是"含 registerShortcut 调用"这条恒假 —— 切错段会让断言空跑。
 */
const regWin = (() => {
  const i = hookSrc.indexOf('if (winners.has(a.id))');
  return i < 0 ? '' : hookSrc.slice(i, i + 240);
})();
t('切到的是 winners 守卫那一段', regWin.includes('if (winners.has(a.id))'),
  regWin.slice(0, 60) || '(没找到守卫)');
t('registerShortcut 调用就在该守卫之内（不是"有键就注册"）',
  /winners\.has\(a\.id\)\)\s*\{[\s\S]{0,160}ctx\.registerShortcut\(/.test(regWin),
  regWin.replace(/\n/g, ' ').slice(0, 120));
t('全文件只有一处 registerShortcut（没有绕过守卫的第二条注册路径）',
  hookSrc.split('ctx.registerShortcut(').length - 1 === 1,
  `出现 ${hookSrc.split('ctx.registerShortcut(').length - 1} 次`);

console.log('\n=== 8. 被跳过的键位必须说出来 ===');

/* 不说的话，被砍掉的那个在界面上仍显示键位、按下去毫无反应，
   用户没有任何线索能把它归到"键位撞车"。 */
const skippedBlock = (() => {
  const i = hookSrc.indexOf('const skipped =');
  if (i < 0) return '';
  return hookSrc.slice(i, hookSrc.indexOf('if (skipped.length > 0)', i) + 600).slice(0, 900);
})();
t('有收集"被跳过"的动作', skippedBlock.includes('const skipped ='), `片段 ${skippedBlock.length} 字符`);
t('被跳过时会 pushLog 说明（不是静默砍掉）',
  /pushLog\(/.test(skippedBlock), (skippedBlock.match(/[^\n]{0,30}pushLog[^\n]{0,50}/) ?? [''])[0]);
t('日志里点名了要去哪儿改（连锁动作）',
  /连锁动作/.test(skippedBlock), (skippedBlock.match(/[^\n]{0,20}连锁动作[^\n]{0,20}/) ?? [''])[0]);

console.log('\n=== 9. 显示侧：只显示真注册成功的键位 ===');

/*
 * 显示一个按不动的键，比什么都不显示更糟：后者他还会去点一下。
 * 锚点钉 `chainKeyWinners.has(` —— 光钉 `a.shortcut` 会命中别处。
 */
t('侧边栏走的是同一个判据（chainShortcutWinners）',
  railSrc.includes('chainShortcutWinners('), `调用 ${railSrc.split('chainShortcutWinners(').length - 1} 次`);
const railRender = (() => {
  const i = railSrc.indexOf('a.shortcut && chainKeyWinners.has');
  return i < 0 ? '' : railSrc.slice(i, i + 120);
})();
t('侧边栏渲染键位前先用 winners 判一遍',
  railRender.includes('chainKeyWinners.has('), railRender.slice(0, 80) || '(没找到)');
const shortcutUses = [...railSrc.matchAll(/a\.shortcut/g)]
  /* 窗口要**往前**取：`{a.shortcut.replace(...)}` 是判据之后的**渲染体**，
     它的 gate 在它前面。只往后取的话这处会被当成"没加判据"，恒红。 */
  .map((m) => railSrc.slice(Math.max(0, m.index - 200), m.index + 140));
t('每一处 a.shortcut 的渲染都落在 winners 判据之内（不是"有键就显示"）',
  shortcutUses.length > 0 && shortcutUses.every((u) => /chainKeyWinners\.has\(/.test(u)),
  `共 ${shortcutUses.length} 处，未加判据 ${shortcutUses.filter((u) => !/chainKeyWinners\.has\(/.test(u)).length} 处`);
t('侧边栏里不再有无条件的 a.shortcut 渲染',
  railSrc.split('a.shortcut &&').length - 1 <= 2,
  `a.shortcut && 出现 ${railSrc.split('a.shortcut &&').length - 1} 次`);

console.log('\n=== 10. 设置里要说明"跟谁撞了" ===');

/* 只说"有冲突"不够：用户会反复重设同一个键，因为他不知道该改哪一个。 */
t('设置面板调用 chainShortcutConflicts',
  panelSrc.includes('chainShortcutConflicts('), `调用 ${panelSrc.split('chainShortcutConflicts(').length - 1} 次`);
/*
 * 必须钉 `{conflictWith}`（JSX 里真的把它渲染出来了），
 * 不能只钉 `conflictWith` 这个词 —— 它在上面的**定义处**也出现，
 * 提示里若把它换成一句笼统的"键位重复"，只钉词的话照样通过。
 */
t('冲突提示里点名了另一方（内置/动作都算）',
  /\{conflictWith\}/.test(panelSrc),
  (panelSrc.match(/[^\n]{0,20}\{conflictWith\}[^\n]{0,20}/) ?? ['(没渲染)'])[0]);
t('提示写明这个键不会注册（否则用户以为保存没生效）',
  /不会注册/.test(panelSrc), (panelSrc.match(/[^\n]{0,40}不会注册[^\n]{0,30}/) ?? [''])[0]);
t('判据看的是当前值 cur.shortcut（手打也要判，不只是按出来的）',
  /normalizeCombo\(cur\.shortcut\)/.test(panelSrc), (panelSrc.match(/[^\n]{0,30}normalizeCombo\(cur\.shortcut\)[^\n]{0,20}/) ?? [''])[0]);

console.log('\n=== 11. 兜底：归一化判据全项目只有一份 ===');

/*
 * 各写一份的话，'Ctrl+Shift+A' 与 'shift+ctrl+a' 在一边算同一个键、
 * 在另一边不算 —— 漏的那边就是又一处静默失效。
 *
 * 判据是"三个文件里的 normalizeCombo 都必须来自 utils/hotkeys 那一份"：
 * 只数出现次数的话，本地再写一份 `function normalizeCombo` 也会算通过。
 */
const impBlock = (src) => {
  const i = src.indexOf("from '../utils/hotkeys'");
  if (i < 0) return '';
  const s = src.lastIndexOf('import {', i);
  return s < 0 ? '' : src.slice(s, i);
};
t('面板的 normalizeCombo 来自 utils/hotkeys（不是本地再写一份）',
  /normalizeCombo/.test(impBlock(panelSrc)), impBlock(panelSrc).replace(/\n/g, ' ').slice(0, 80));
t('注册侧不自带归一化（判据全在 utils/hotkeys 里）',
  !/function normalizeCombo/.test(hookSrc) && !/function normalizeCombo/.test(panelSrc)
  && !/function normalizeCombo/.test(railSrc), '');

/* ------------------------------------------------------------------ */
console.log('\n=== 12. 提示块要真的看得出来是警告 ===');

/*
 * 这一段守的是"提示写了、但看起来不是提示"。
 *
 * `.fpx-ca-shortcut-conflict` 曾经**只有 JSX 用了、CSS 里没有定义** ——
 * 于是它落到裸 div 的默认样式，与上方那行 `p-muted` 灰字完全一样。
 * 那段文案说的是「这个键不会注册」，看着却像普通说明，用户照旧保存，
 * 然后快捷键按下去毫无反应。
 *
 * 只断言"源码里有这个类名"证明不了它长得像警告 —— 那正是当时的事实。
 * 所以这里钉的是**样式定义本身**，且要求带警示色。
 */
const cssSrc = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
const ruleAt = cssSrc.indexOf('.fpx-ca-shortcut-conflict');
const rule = ruleAt >= 0 ? cssSrc.slice(ruleAt, cssSrc.indexOf('}', ruleAt) + 1) : '';
t('提示块取到了（否则后面两条空跑）', rule.length > 40, `${rule.length} 字节`);
t('提示用的类名在 style.css 里有定义（只写 className 没写样式 = 与灰字无异）',
  /^\.fpx-ca-shortcut-conflict\s*\{/.test(rule), rule.split('\n')[0] ?? '(没定义)');
t('定义里带警示色（否则看着像补充说明，不当回事）',
  /--warn/.test(rule), (rule.match(/[^\n]{0,30}--warn[^\n]{0,20}/) ?? ['(没有)'])[0]);

/* 界面文案里写 `**强调**` 是文档习惯，浏览器会**原样显示两个星号**。 */
t('界面文案里不留 Markdown 记号（** 会被原样显示）',
  !/\*\*/.test(panelSrc), (panelSrc.match(/[^\n]{0,24}\*\*[^\n]{0,24}/) ?? ['(没有)'])[0]);
t('提示文案本身取到了（否则上一条是空跑）', /不会注册/.test(panelSrc), '');

done();
