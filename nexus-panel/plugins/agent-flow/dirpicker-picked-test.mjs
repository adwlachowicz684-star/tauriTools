/**
 * agent-flow/DirPicker：「输入框里的路径」与「交出去的路径」必须是两个状态
 * ============================================================
 * 场景：用户在地址栏敲了一个打不开的路径（盘符不存在 / 没权限 /
 *       不在授权根里），点「打开」失败。
 *
 * 修复前 cwd 同时充当两样东西：
 *   · 输入框的 value（用户敲什么它就是什么）
 *   · 「选这里」真正交出去的路径（onPick(cwd)）
 * 失败时只清了 entries、cwd 原样保留 → 界面显示刚敲的那条路径，
 * 列表空着，而「选这里」按钮**仍可点**，交出去的是一个连列都列不出来的
 * 目录。导出会往那个目录写、写失败又回到"选的时候看不出来"的老问题。
 *
 * project-group/DirDialog 上一轮已修同款（清空 path、保留 input），
 * 本文件修的是 agent-flow 这一侧，并把两者的判据钉成一致。
 *
 * 四类断言：
 *   ① load 成功/失败 跑真身（catch 段原样执行，不是看源码里有没有那几个字）
 *   ② 「选这里」「设为默认」交的是 picked，且禁用判据是 !picked
 *   ③ 刻意保留 cwd（清空等于把用户刚敲的路径也抹了）
 *   ④ 上一级的起点、底部「当前」、起点 chip 高亮都以 picked 为准
 *
 * 运行：node plugins/agent-flow/dirpicker-picked-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripCommentsJs } from '../../test-scan-utils.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok, why) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${why ? ` —— ${why}` : ''}`); }
}

const src = stripCommentsJs(read('plugins/agent-flow/components/DirPicker.tsx'));

/**
 * 从 `start` 处按花括号配平切出一段。
 *
 * 【为什么不能按行数或就近 `}` 切】
 * catch 段里含模板字符串（`打不开这个目录：${...}`）与可选链，
 * 就近切会切在嵌套的 `}` 或模板串上，拿到半截代码 ——
 * 半截代码 new Function 要么崩（吃掉后面所有断言），要么恰好是合法的
 * 另一段，于是**验的是别的函数**。
 */
function sliceBalanced(s, startIdx) {
  const open = s.indexOf('{', startIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(open, i + 1);
    }
  }
  return '';
}

/* ================================================================ */
/* 一、load 跑真身                                                   */
/* ================================================================ */
console.log('【一】load：成功/失败时的状态变化（跑真身）');

const loadAnchor = src.indexOf('const load = useCallback(async (p: string) => {');
t('找得到 DirPicker 的 load', loadAnchor >= 0);
const loadBody = loadAnchor >= 0 ? sliceBalanced(src, loadAnchor) : '';
t('load 的函数体切出来了', loadBody.length > 50, `实长 ${loadBody.length}`);

/*
 * TS → JS：只去掉本项目实际用到的类型写法。
 * 不做通用转换 —— 遇到没覆盖的写法宁可让 new Function 直接抛错，
 * 也不要静默产出坏代码（静默坏代码 = 测试全绿但验的是别的东西）。
 */
const loadJs = loadBody.replace(/\(e as Error\)/g, 'e');
t('改写后没有 TS 残留', !/\bas\s+\w+/.test(loadJs) && !/:\s*string\b/.test(loadJs));

let makeLoad = null;
try {
  makeLoad = new Function(
    'setBusy', 'setErr', 'setEntries', 'setCwd', 'setPicked', 'alive', 'listDirs',
    `return async (p) => ${loadJs};`,
  );
} catch (e) {
  t('load 可实例化', false, String(e.message).slice(0, 160));
}

if (makeLoad) {
  /* ---- 成功路径 ---- */
  {
    const st = { busy: null, err: 'X', entries: null, cwd: 'old', picked: '' };
    const alive = { current: true };
    const load = makeLoad(
      (v) => { st.busy = v; }, (v) => { st.err = v; }, (v) => { st.entries = v; },
      (v) => { st.cwd = v; }, (v) => { st.picked = v; },
      alive, async () => [{ path: 'a', name: 'a' }],
    );
    await load('D:/opened');
    t('成功时 picked 记为刚打开的目录', st.picked === 'D:/opened', `实际 ${st.picked}`);
    t('成功时 cwd 同步为刚打开的目录', st.cwd === 'D:/opened', `实际 ${st.cwd}`);
    t('成功时清掉上一次的 err', st.err === null, `实际 ${st.err}`);
    t('成功时 entries 有内容', Array.isArray(st.entries) && st.entries.length === 1);
  }

  /* ---- 失败路径（本轮修的就是这组） ---- */
  {
    const st = { busy: null, err: null, entries: [{ path: 'x' }], cwd: 'D:/typed-by-user', picked: 'C:/prev' };
    const alive = { current: true };
    const load = makeLoad(
      (v) => { st.busy = v; }, (v) => { st.err = v; }, (v) => { st.entries = v; },
      (v) => { st.cwd = v; }, (v) => { st.picked = v; },
      alive, async () => { throw new Error('不在授权根内'); },
    );
    await load('D:/typed-by-user');
    t('失败时清空 picked（未打开就不许选）', st.picked === '', `实际 ${JSON.stringify(st.picked)}`);
    t('失败时清空 entries', Array.isArray(st.entries) && st.entries.length === 0);
    t('失败时说清原因（不是静默空列表）', typeof st.err === 'string' && st.err.length > 0, `实际 ${st.err}`);
    t('失败时**保留** cwd（留着刚敲的路径好改）', st.cwd === 'D:/typed-by-user', `实际 ${st.cwd}`);
    t('失败时 picked 不再等于 cwd（两态已分离）', st.picked !== st.cwd);
    t('失败后 busy 复位（不会一直转圈）', st.busy === false, `实际 ${st.busy}`);
  }
}

/* ================================================================ */
/* 二、交出去的是 picked，不是 cwd                                    */
/* ================================================================ */
console.log('\n【二】「选这里」「设为默认」交的是 picked');

const footIdx = src.indexOf('dirpicker-foot');
const footSeg = footIdx > 0 ? src.slice(footIdx, footIdx + 1400) : '';
t('找得到底部操作区', footSeg.length > 0);

const pickBtn = footSeg.match(/<button[^>]*onClick=\{\(\) => onPick\((\w+)\)\}/);
t('「选这里」交的是 picked（不是输入框的 cwd）',
  !!pickBtn && pickBtn[1] === 'picked', pickBtn ? `实际交的是 ${pickBtn[1]}` : '没匹配到 onPick');

const defBtn = footSeg.match(/onClick=\{\(\) => \{ onPickAsDefault\((\w+)\); onPick\((\w+)\); \}\}/);
t('「设为默认」交的也是 picked',
  !!defBtn && defBtn[1] === 'picked' && defBtn[2] === 'picked',
  defBtn ? `实际 ${defBtn[1]} / ${defBtn[2]}` : '没匹配到 onPickAsDefault');

/* ================================================================ */
/* 三、禁用判据必须是 !picked —— 这是"清空能挡住误选"的唯一依据        */
/* ================================================================ */
console.log('\n【三】禁用判据');

const disables = [...footSeg.matchAll(/disabled=\{!(\w+)\}/g)].map((m) => m[1]);
t('底部两处禁用都判 !picked',
  disables.length >= 2 && disables.every((d) => d === 'picked'),
  `实际 ${JSON.stringify(disables)}`);
t('底部已无 disabled={!cwd}（那就是修之前的写法）',
  !/disabled=\{!cwd\}/.test(footSeg));

/* ================================================================ */
/* 四、刻意保留 cwd                                                   */
/* ================================================================ */
console.log('\n【四】输入框的值不能被抹掉');

const catchIdx = src.indexOf('} catch (e) {', loadAnchor);
const catchBody = catchIdx > 0 ? sliceBalanced(src, catchIdx) : '';
t('catch 段切出来了', catchBody.length > 0);
t('catch 段不出现 setCwd（输入框的值要留着）', !/setCwd\s*\(/.test(catchBody),
  '出现了 setCwd —— 用户刚敲的路径会被抹掉，改一个字符重试的机会没了');
t('catch 段出现 setPicked(\'\')', /setPicked\(''\)/.test(catchBody));
t('catch 段出现 setEntries(\[\])', /setEntries\(\[\]\)/.test(catchBody));

/* ================================================================ */
/* 五、其余三处显示都以 picked 为准                                   */
/* ================================================================ */
console.log('\n【五】界面上"当前是哪个目录"一律以 picked 为准');

t('底部「当前：」显示 picked', /当前：\{picked \|\| '（未选）'\}/.test(src),
  '显示的仍是 cwd → 会显示一条打不开的路径');
t('底部授权标记判的也是 picked', /withinRoots\(picked, authorized\)/.test(src));
t('起点 chip 高亮以 picked 为准', /r\.path === picked \? ' on' : ''/.test(src));
t('「上一级」优先从 picked 起算', /String\(picked \|\| cwd \|\| ''\)/.test(src),
  '若仍用 cwd，失败后"上一级"会从一条打不开的路径往上爬');
t('up 的依赖数组带上了 picked', /\}, \[cwd, picked\]\);/.test(src));

/* ================================================================ */
/* 六、失败时给一句人话（三处各说各的会让人以为选择器坏了）            */
/* ================================================================ */
console.log('\n【六】失败时说明"已停用"');

t('err 之外另有一句说明「选这里」已停用',
  /上方路径尚未打开，已停用「选这里」/.test(src));
t('这句只在 err 且 cwd 非空时才出现', /\{err && cwd \? \(/.test(src));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
