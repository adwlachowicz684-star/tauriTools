/**
 * 链接勾选对话框：「全选」的取值 与 「全删」的可用性
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/link-pick-all-test.mjs
 *
 * 为什么单独测它：这两处都是"界面承诺了一个动作，却拒绝/越权执行"，
 * 且不报错——正是最难被发现的那一类。
 *
 *   ① 「全选」此前是 `new Set(allNames)`，把**他组占用**的名字一并勾上：
 *      用户点一下「全选」再点确定，就把别的项目组的链接全抢过来了，
 *      而他根本没打算动那边。底部说明与 ownedElsewhere 的注释都写明
 *      这类名字要"手动逐个勾"，一键全选等于绕过这道确认。
 *   ② 确认按钮 `disabled={picked.size === 0}`：全部取消勾选时，
 *      行上标着「将删除」、按钮也写着「删除 K 个」，而按钮是灰的——
 *      "把链接全删掉"这个正当操作做不了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

/* 剥块注释：断言不能靠注释里的字样通过 —— 那是本仓踩过 25 次的坑 */
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => fs.readFileSync(path.join(HERE, n), 'utf8');
const dlg = strip(R('components/LinkPickDialog.tsx'));

/** 抓 `const X = <expr>;` 的表达式（不含分号） */
const grab = (name) => {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);').exec(dlg);
  return m ? m[1] : '';
};
/** 抓 `const X = useMemo(<fn>, [deps]);` 的函数体 */
const grabMemo = (name, deps) => {
  const m = new RegExp(
    'const\\s+' + name + '\\s*=\\s*useMemo\\(([\\s\\S]*?),\\s*\\[' + deps + '\\],\\s*\\)',
  ).exec(dlg);
  return m ? m[1] : '';
};

const selExpr = grabMemo('selectable', 'allNames, ownedElsewhere');
const dropExpr = grabMemo('dropCount', 'allNames, existing, picked, group');
const allExpr = grab('all');
const toggleExpr = grab('toggleAll');
const noopExpr = grab('noop');
const labelExpr = grab('confirmLabel');

console.log('\n=== 1. 六条表达式都抓自源码（不是手写副本）===');
t('抓到 selectable', selExpr.length > 0, selExpr.slice(0, 60));
t('抓到 dropCount', dropExpr.length > 0, dropExpr.slice(0, 60));
t('抓到 all', allExpr.length > 0, allExpr);
t('抓到 toggleAll', toggleExpr.length > 0, toggleExpr);
t('抓到 noop', noopExpr.length > 0, noopExpr);
t('抓到 confirmLabel', labelExpr.length > 0, labelExpr.slice(0, 60));

console.log('\n=== 2. 「全选」不得再取全量名单（会抢别组链接）===');
/*
 * 反面证据：`new Set(allNames)` 是旧写法。只钉"selectable 存在"不够——
 * 旧写法下 selectable 也可以存在而没人用。
 */
t('selectable 排除他组占用', /ownedElsewhere/.test(selExpr), selExpr);
t('selectable 用 !has 排除', /!ownedElsewhere\.has\(/.test(selExpr), selExpr);
t('toggleAll 走 selectable', /new Set\(selectable\)/.test(toggleExpr), toggleExpr);
t('不再出现 new Set(allNames)', !/new Set\(allNames\)/.test(dlg));
t('all 判据按 selectable 而非 allNames', /selectable\.length/.test(allExpr), allExpr);

console.log('\n=== 3. 真跑：三个名字、其一被他组占用 ===');
{
  const allNames = ['claude', 'gemini', 'cursor'];
  const group = '/G';
  const existing = new Map([['claude', '/G'], ['gemini', '/G'], ['cursor', '/H']]);

  const ownedElsewhere = new Set();
  for (const [n, tg] of existing) if (tg !== group) ownedElsewhere.add(n);
  t('他组占用 = {cursor}', ownedElsewhere.has('cursor') && ownedElsewhere.size === 1, [...ownedElsewhere].join(','));

  const selectable = new Function('allNames', 'ownedElsewhere', `return (${selExpr})();`)(allNames, ownedElsewhere);
  t('selectable 含两个可勾选名', selectable.length === 2 && !selectable.includes('cursor'), selectable.join(','));

  /* 默认勾选 = 启用名单剔除他组占用 */
  let picked = new Set(['claude', 'gemini']);
  const all = new Function('picked', 'selectable', 'allNames', `return (${allExpr});`)(picked, selectable, allNames);
  t('默认状态下 all 为真（按钮显示「全不选」）', all === true, `all=${all}`);

  /* 用户手工取消两个 → 想全删 */
  picked = new Set();
  /* dropExpr 是 `() => ...` 形态，必须**调用**它，否则拿到的是函数本身 */
  const dropCount = new Function('allNames', 'existing', 'picked', 'group', 'samePath',
    `return (${dropExpr})();`)(allNames, existing, picked, group, (a, b) => a === b);
  t('全不选 → dropCount = 2', dropCount === 2, `dropCount=${dropCount}`);

  const noop = new Function('picked', 'dropCount', `return (${noopExpr});`)(picked, dropCount);
  t('全不选 + 有得删 → 按钮**不**禁用', noop === false, `noop=${noop}`);

  const label = new Function('noop', 'picked', 'dropCount', `return (${labelExpr});`)(noop, picked, dropCount);
  t('文案为「删除 2 个链接」', label === '删除 2 个链接', label);

  const onConfirmList = allNames.filter((n) => picked.has(n));
  t('提交空名单（后端据此全删）', onConfirmList.length === 0, JSON.stringify(onConfirmList));
}

console.log('\n=== 4. 真跑：一个都没有时才是「无操作」===');
{
  const picked = new Set();
  const noop = new Function('picked', 'dropCount', `return (${noopExpr});`)(picked, 0);
  t('全不选 + 无得删 → 禁用', noop === true, `noop=${noop}`);
  const label = new Function('noop', 'picked', 'dropCount', `return (${labelExpr});`)(noop, picked, 0);
  t('文案退回「建立 0 个链接」', label === '建立 0 个链接', label);
}

console.log('\n=== 5. 真跑：混合场景（新建 + 删除同时发生）===');
{
  const picked = new Set(['claude']);
  const noop = new Function('picked', 'dropCount', `return (${noopExpr});`)(picked, 3);
  t('有勾选 → 不禁用', noop === false, `noop=${noop}`);
  const label = new Function('noop', 'picked', 'dropCount', `return (${labelExpr});`)(noop, picked, 3);
  t('文案为「建立 1 个、删除 3 个」', label === '建立 1 个、删除 3 个', label);
}

console.log('\n=== 6. 真跑：toggleAll 不再勾上他组占用 ===');
{
  const allNames = ['claude', 'gemini', 'cursor'];
  const ownedElsewhere = new Set(['cursor']);
  const selectable = new Function('allNames', 'ownedElsewhere', `return (${selExpr})();`)(allNames, ownedElsewhere);
  let picked = new Set();
  const all = new Function('picked', 'selectable', 'allNames', `return (${allExpr});`)(picked, selectable, allNames);
  t('空选时 all 为假（按钮显示「全选」）', all === false, `all=${all}`);
  /* toggleAll 内部调 setPicked，用捕获器把它接住 */
  let next = null;
  new Function('all', 'selectable', 'allNames', 'setPicked', `(${toggleExpr})();`)(
    all, selectable, allNames, (v) => { next = v; },
  );
  t('点「全选」→ 不含他组占用', next.size === 2 && !next.has('cursor'), [...next].join(','));
  t('点「全选」→ 含设置里关掉的名字（临时多建是显式意图）', next.has('claude') && next.has('gemini'), [...next].join(','));
}

console.log('\n=== 7. 纯删除时按钮必须是 danger ===');
{
  /* 只钉"文案里有 danger"会被注释喂饱，所以钉 className 表达式本身 */
  const m = /className=\{([\s\S]*?)\}\s*\n\s*disabled=\{noop\}/.exec(dlg);
  const cls = m ? m[1] : '';
  t('抓到按钮 className 表达式', cls.length > 0, cls);
  t('纯删除时转 danger', /danger/.test(cls), cls);
  t('判据含 picked.size === 0', /picked\.size === 0/.test(cls), cls);
  t('判据含 !noop（否则无可删时也是红的）', /!noop/.test(cls), cls);
}

console.log('\n=== 8. 反向证据：旧写法必须已被替换 ===');
t('disabled 不再直接写 picked.size === 0', !/disabled=\{picked\.size === 0\}/.test(dlg));
t('disabled 判据改用 noop', /disabled=\{noop\}/.test(dlg));
t('JSX 用 confirmLabel（不再内联三元）', /\{confirmLabel\}/.test(dlg));

done();
