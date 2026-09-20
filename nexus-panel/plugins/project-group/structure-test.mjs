/**
 * 结构护栏（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/structure-test.mjs
 *
 * App.tsx 曾经 1599 行，是明显的瓶颈：每加一个功能都往里塞，
 * 而里面塞的东西彼此无关（弹窗 / 使用说明 / 布局 / 右键菜单…）。
 *
 * 这里守的是**拆分本身不腐化**：
 *   · 弹窗与使用说明必须在 Dialogs.tsx，不许再搬回 App
 *   · IS_MAC 只能有一份（两份会让按钮与说明显示不同的修饰键）
 *   · 不许出现 App ⇄ Dialogs 的循环依赖
 *
 * 为什么连"不许循环依赖"都要测：它不报错、能跑，
 * 只是在某些加载顺序下拿到 undefined，是最难查的那类。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const R = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const app = R('App.tsx');
const dialogs = R('components/Dialogs.tsx');
const hotkeys = R('utils/hotkeys.ts');

console.log('\n=== 1. 拆分已落地 ===');
{
  t('App.tsx 用 <Dialogs> 一处挂载', /<Dialogs\b/.test(app));
  /* 不许再搬回去：App 里出现任何具体弹窗组件都说明拆分在倒退 */
  for (const n of ['ChainConfirmDialog', 'TabManagerDialog', 'BackupDialog',
                   'StyleDialog', 'LockDialog', 'RenameDialog', 'DirDialog',
                   'CreateDialog', 'IconPickDialog', 'LinkPickDialog',
                   'ChainDialog', 'EditorDialog', 'RenameContentDialog']) {
    t(`App 不再直接渲染 ${n}`, !new RegExp(`<${n}\\b`).test(app));
  }
  t('HelpDialog 已移出 App', !/^function HelpDialog/m.test(app));
  t('HelpDialog 在 Dialogs 里', /function HelpDialog/.test(dialogs));
}

console.log('\n=== 2. 弹窗集中在 Dialogs ===');
{
  /* 用"弹窗类型"而不是组件名：类型才是契约，组件名可能换 */
  for (const ty of ['pickDir', 'create', 'lock', 'style', 'icons', 'backup',
                    'editor', 'chain', 'rename', 'move', 'renameContent', 'tabManager']) {
    t(`Dialogs 覆盖 ${ty} 形态`, dialogs.includes(`'${ty}'`));
  }
  t('Dialog 类型定义在 Dialogs（单一定义）', /export type Dialog =/.test(dialogs));
  t('App 从 Dialogs 引入 Dialog 类型', /type Dialog/.test(app) && !/^type Dialog/m.test(app));
  t('PendingSend 类型也只在 Dialogs 定义',
    /export interface PendingSend/.test(dialogs) && !/interface PendingSend/.test(app));
}

console.log('\n=== 3. IS_MAC 只有一份 ===');
{
  /* 两份各自算 → 按钮显示 ⌘、说明写 Ctrl → 用户照其中一个按却没反应 */
  const defs = [app, dialogs].filter((s) => /const IS_MAC\s*=/.test(s)).length
             + (/export const IS_MAC\s*=/.test(hotkeys) ? 1 : 0);
  t('只有一处定义', defs === 1, `${defs} 处`);
  t('定义在 utils/hotkeys 并导出', /export const IS_MAC/.test(hotkeys));
  t('App 是从 utils 引入', /IS_MAC,\s*type HotkeyId/.test(app));
  t('Dialogs 是从 utils 引入', /hotkeysByGroup, IS_MAC/.test(dialogs));
  t('App 无本地定义', !/const IS_MAC\s*=/.test(app));
  t('Dialogs 无本地定义', !/const IS_MAC\s*=/.test(dialogs));
}

console.log('\n=== 4. 不许循环依赖 ===');
{
  /* Dialogs → App 会成环：App 引 Dialogs，Dialogs 又引 App。
     ESM 通常能跑，但在某些加载顺序下拿到 undefined，极难查。 */
  t('Dialogs 不引 App', !/from '\.\.\/App'/.test(dialogs) && !/from '\.\/App'/.test(dialogs));
  t('App 引 Dialogs（单向）', /from '\.\/components\/Dialogs'/.test(app));
}

console.log('\n=== 5. 连锁接线已抽成钩子 ===');
{
  const hook = R('hooks/useChainActions.ts');
  const app2 = R('App.tsx');
  t('App 用 useChainActions', /useChainActions\(\{/.test(app2));
  t('注册副作用在钩子里', /useEffect\(\(\) => \{/.test(hook));
  t('三个入口都返回',
    /return \{ runActionOnSelection, sendAction, requestSendAction \}/.test(hook));
  t('needConfirm 只在钩子里（App 不再需要）',
    /needConfirm/.test(hook) && !/needConfirm/.test(app2));
  /* 事件名两处必须一致：注册的和监听的是不是同一个 */
  t('shortcut/sidebar 事件名各只定义一次',
    (hook.match(/fpx:chain:/g) || []).length === 1
    && (hook.match(/fpx:sidebar:/g) || []).length === 1);
}

console.log('\n=== 6. 布局记忆已抽成钩子 ===');
{
  const hook = R('hooks/useLayoutMemory.ts');
  const app3 = R('App.tsx');
  t('App 用 useLayoutMemory', /useLayoutMemory\(\{/.test(app3));
  /* 三块尺寸（三栏 / 日志 / 浮层）必须在同一个钩子里 ——
     原本 tipsHeight 与三栏相距 70 行，改一处容易漏看另一处 */
  t('三块尺寸都返回',
    /colStars/.test(hook) && /logHeight/.test(hook) && /tipsHeight/.test(hook));
  t('布局算术仍在 utils/layout（未内联进钩子）',
    /from '\.\.\/utils\/layout'/.test(hook));
  t('App 不再自己管 colStars 初值', !/useState<number\[\]>\(\(\) =>\s*\n?\s*normalizeColStars/.test(app3));
  /* 松手才写 config：拖动中写会让拖动卡顿 */
  t('保留"松手才写"的语义', /saveLayout\(\{ colStars: cur \}\)/.test(hook));
}

console.log('\n=== 7. 规模护栏 ===');
{
  const n = app.split('\n').length;
  t('App.tsx < 1150 行（拆分前 1599）', n < 1150, `${n} 行`);
  /* 只设上限不设下限：不许再涨回去，但也不阻止继续拆 */
  t('Dialogs.tsx 已成形', dialogs.split('\n').length > 200);
}


console.log('\n=== ContentPanel：不靠调用方传稳定引用（无限渲染防护）===');
{
  const cp = fs.readFileSync(path.join(HERE, 'components/ContentPanel.tsx'), 'utf8')
    .replace(/\*[\s\S]*?\*\//g, '');
  const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');

  /* 通知外面要走 ref，不能把 onSelect 放进依赖数组 */
  t('用 ref 存回调', /onSelectRef\s*=\s*useRef\(onSelect\)/.test(cp));
  t('每次渲染同步 ref', /onSelectRef\.current = onSelect;/.test(cp));
  /* **依赖里不能出现 onSelect**：调用方传内联箭头函数的话会每次渲染重跑
     → 触发父组件 setState → 无限循环 */
  t('effect 依赖不含 onSelect',
    /\[root, kind\]\);/.test(cp) && !/\[root, kind, onSelect\]/.test(cp));
  t('effect 里走 ref 调用', /onSelectRef\.current\?\.\(null\)/.test(cp));

  /* App 侧的注释不该再写"必须稳定"—— 那条约束已消除 */
  t('App 注释不再声称必须稳定', !/必须是稳定引用/.test(app));
}

done();
