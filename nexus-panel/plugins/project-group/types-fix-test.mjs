/**
 * 类型错误清单 49 处：本轮修的六类（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/types-fix-test.mjs
 *
 * 沙箱跑不了 tsc，所以每条都用**源码形态断言**锁住，
 * 并且每条都做过反向验证（改回错误写法会红）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const app = R('App.tsx');
const hub = R('components/DialogsHub.tsx');
const hk = R('utils/hotkeys.ts');
const hint = R('utils/hint.ts');
const tabs = R('utils/tabs.ts');
const setDlg = R('components/SettingsDialog.tsx');

console.log('\n=== 1. 运算符优先级：iconTargetPath（会崩，不只是类型报错）===');
{
  /*
   * `??` 优先级高于 `?:`。漏了内层括号就被解析成
   *   (selCard?.path ?? (dialog.type === 'icons')) ? dialog.card.path : ''
   * 条件变成"路径字符串"本身：只要选中了卡片（不管开的是什么弹窗）就为真
   * → 取 dialog.card.path → dialog 多半是 {type:'none'} → 崩。
   * 默认跟随 + 选中任意卡片 + 没开图标弹窗 = 必崩。
   */
  const line = hub.split('\n').find((l) => l.includes('const iconTargetPath'));
  t('有这一行', !!line);
  /* 判据：?? 后面必须紧跟一个带括号的三元 */
  t('?? 后的三元带括号', /\?\? \(dialog\.type === 'icons' \? dialog\.card\.path : ''\)/.test(hub));
  /* 反例形态：?? 后直接跟 dialog.type（无括号） */
  t('不是无括号的旧写法', !/\?\? dialog\.type === 'icons' \? dialog\.card/.test(hub));
  /* 与下一行 iconTargetName 写法一致 */
  const nameLine = hub.split('\n').find((l) => l.includes('const iconTargetName'));
  t('两行写法一致（都有内层括号）', /\?\? \(dialog\.type === 'icons'/.test(nameLine));
}

console.log('\n=== 2. boot 判空：不解构 + 早退（19 处同源）===');
{
  /*
   * TS 不会把 s.boot 的判空窄化传递到已解构出来的局部变量 boot 上，
   * 所以 19 处 boot.xxx 全部报"可能为 null"。
   */
  t('不再解构 boot', !/const \{ ctx, boot \} = s;/.test(hub));
  t('用局部常量', /const \{ ctx \} = s;\n\s*const boot = s\.boot;/.test(hub));
  t('有早退', /if \(!boot\) return null;/.test(hub));
  /* 早退必须在所有 hooks 之后，否则 hooks 调用顺序会变 */
  const iEarly = hub.indexOf('if (!boot) return null;');
  const iUseMemo = hub.indexOf('const selCard = useMemo(');
  /* 两端都判（>= 0 而非 > 0）：iEarly 找不到时 `iEarly > iUseMemo` 恒假（脆断），
     少判 iUseMemo 那端则恒真（空跑）—— 两种都要挡住 */
  t('早退在 useMemo 之后', iUseMemo >= 0 && iEarly >= 0 && iEarly > iUseMemo);
  /* useMemo 在早退之前，拿不到窄化，必须自己判一次 */
  const seg = hub.slice(iUseMemo, iEarly);
  t('useMemo 内自己判空', /if \(!selPath \|\| !boot\) return null;/.test(seg));
}

console.log('\n=== 3. HotkeyId 收窄（3 处：App + hint×2）===');
{
  t('有类型守卫', /export function isHotkeyId\(id: string\): id is HotkeyId/.test(hk));
  /* 判定必须用 HOTKEY_BY_ID，不能另抄一份 id 列表（抄了就会漂移） */
  t('用 HOTKEY_BY_ID 判定', /hasOwnProperty\.call\(HOTKEY_BY_ID, id\)/.test(hk));
  /*
   * 守卫不再内联在 App 里 —— 已收进 utils/hint.ts 的 shouldShowHint，
   * 由 App.tsx 调用。钉"App 里写 showHints && isHotkeyId"会在接线后误报；
   * 真正要钉的是**判定逻辑只有一份**（收窄函数定义在 hotkeys.ts）。
   */
  /*
   * 入口已收敛成 `toolbarHint`（显示判据 + 格式化都在 hint.ts）。
   * 钉"App 调用了它、且不内联 isHotkeyId/effectiveCombo"——
   * 钉具体哪个内部函数会在重构时误报（shouldShowHint 现在是内部实现）。
   */
  t('App 走 hint.ts 的 toolbarHint（不内联守卫）',
    /toolbarHint\(/.test(app) && !/isHotkeyId\(/.test(app) && !/effectiveCombo\(/.test(app));
  t('hint 的 comboHintOf 用了', /isHotkeyId\(actionId\) \? effectiveCombo/.test(hint));
  t('hint 的 shouldShowHint 用了', /isHotkeyId\(actionId\) \? !!effectiveCombo/.test(hint));
  /* 不许用 as 断言抹平 */
  /*
   * 只禁"把**变量**断言成 HotkeyId"：字面量 `'refresh' as HotkeyId`
   * 是安全的 —— 拼错时 TS 会直接报"转换可能是错的"。
   * 变量断言才是把"id 拼错"抹平的那一种。
   */
  const asVar = (src) => {
    let bad = false;
    for (const m of src.matchAll(/(.) as HotkeyId/g)) {
      if (m[1] !== "'" && m[1] !== '"') bad = true;
    }
    return bad;
  };
  t('没有把变量断言成 HotkeyId', !asVar(app) && !asVar(hint));
}

console.log('\n=== 4. skipDropToTab 要收两种形态（守卫曾静默失效）===');
{
  /*
   * 调用方传的是 TabInfo[]（items: CardInfo[]），而签名只写 string[] ——
   * items.includes(path) 拿对象比字符串恒为 false，
   * 于是 #103「拖回源页签=无操作」一次都没生效。
   */
  t('签名收联合形态', /export type DropItem = string \| \{ path: string \};/.test(tabs));
  t('参数用该别名', /tabs: \{ items: DropItem\[\] \}\[\],/.test(tabs));
  t('显式比较 path', /typeof it === 'string' \? it : it\.path/.test(tabs));
  t('用 some 而不是 includes', /t\.items\.some\(/.test(tabs));
  t('不是只收 string[]', !/tabs: \{ items: string\[\] \}\[\]/.test(tabs));
}

console.log('\n=== 5. 可选回调要 ?.()（TS2722）===');
{
  t('onResetLayout 用可选链', /onResetLayout\?\.\(\)/.test(setDlg));
  t('不是直接调用', !/void onResetLayout\(\)/.test(setDlg));
}

console.log('\n=== 6. Column 不再直接引用 App 的 setter（TS2304，会崩）===');
{
  /* Column 是独立组件，拿不到 App 里的 setConfirmLink → ReferenceError */
  t('Column 有 onEditLink prop', /onEditLink\?: \(project: string, group: string\) => void;/.test(app));
  t('Column 解构了它', /onJumpToGroup, onEditLink,/.test(app));
  t('透传而不是重建', /onEditLink=\{onEditLink\}/.test(app));
  t('Column 体内不再有 setConfirmLink', (() => {
    const i = app.indexOf('function Column({');
    const blk = app.slice(i);
    return !/setConfirmLink/.test(blk.slice(blk.indexOf('}) {')));
  })());
  /* 调用处由 App 传入 */
  t('调用处传了', /onEditLink=\{\(p, g\) => setConfirmLink\(\{ project: p, group: g \}\)\}/.test(app));
}

console.log('\n=== 7. 行为：isHotkeyId / skipDropToTab ===');
{
  const { isHotkeyId } = await loadTs(path.join(HERE, 'utils/hotkeys.ts'));
  t('合法 id 为真', isHotkeyId('open') === true);
  t('拼错 id 为假', isHotkeyId('opne') === false);
  t('空串为假', isHotkeyId('') === false);

  const { skipDropToTab } = await loadTs(path.join(HERE, 'utils/tabs.ts'));
  /* CardInfo[] 形态：这是真实调用点的形态，旧签名恒 false */
  const cardTabs = [{ items: [{ path: '/a' }, { path: '/b' }] }];
  t('对象形态能命中', skipDropToTab(cardTabs, 0, '/a') === true);
  t('对象形态不命中', skipDropToTab(cardTabs, 0, '/c') === false);
  /* string[] 形态仍要支持 */
  t('字符串形态也能用', skipDropToTab([{ items: ['/a'] }], 0, '/a') === true);
  t('越界返回 false', skipDropToTab([{ items: ['/a'] }], 5, '/a') === false);
}

done();
