/**
 * 层级改名 / 设置页两处「界面说法与事实不符」
 * ------------------------------------------------------------------
 * 本轮修的三处都属于同一类：不是崩溃、不是报错，而是**界面主动给出了
 * 一个与事实相反的陈述**，用户照着它做就会做错事。
 *
 *   ① renameSegment：`moved === 0`（源全被跳过）时仍写「已把层级 A 改为 B」
 *      并 return true → 弹窗关闭、刷新后层级名没变。
 *   ② backupAutoStatus 静默 catch → 显示"自动备份失败原因"的唯一位置
 *      永远停在「设置后由后台定时执行」。
 *   ③ listIcons 静默 catch → 面板说「icons/ 下还没有图标」并引导再导一次。
 *
 * 测试原则（这个项目里栽过 20 多次）：
 *   · ①②的行为断言**跑真身**，不钉"源码里有这几个字"
 *   · 所有"不再出现某写法"的断言**先剥注释**——注释里写了同样的话
 *     会让断言恒真，看着在跑其实没验到
 *   · 反向验证必须一条条撤，确认每条断言都能抓到
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

/** 剥掉块注释与行注释，只留代码 —— 防"注释里的字样把断言喂饱" */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 从 from 处的 `{` 起，配平大括号切出整段（忽略字符串与注释里的括号） */
function balanced(src, from) {
  const i = src.indexOf('{', from);
  if (i < 0) return '';
  let d = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d === 0) return src.slice(i, k + 1);
    }
  }
  return '';
}

/* ============================================================
 * ① renameSegment 的 submit：跑真身
 * ========================================================== */

const cp = read('components/ContentPanel.tsx');
const anchor = 'submit: async (newName: string) => {';
const body = balanced(cp, cp.indexOf(anchor));

t('① 取到 submit 整段（非空）', body.length > 0, `${body.length} 字符`);

/** 把 submit 段变成可执行的函数；闭包变量逐个注入 */
function makeSubmit({ moves, ret }) {
  const inner = body.slice(1, -1);   // 去掉最外层 {}
  return new Function(
    'planSkillSegmentRename', 'leaves', 'depth', 'n', 'api', 'onLog', 'onRefresh', 'newName',
    `return (async () => { ${inner} })();`,
  ).bind(null, () => ({ moves }), [{ path: 'D:\\\\s\\\\a_b.md', isDir: false }], 0, { name: 'A' }, {
    renameSkillSegment: async () => ret,
  });
}

async function runSubmit(moves, ret) {
  const logs = [];
  let refreshed = 0;
  const fn = new Function(
    'planSkillSegmentRename', 'leaves', 'depth', 'n', 'api', 'onLog', 'onRefresh', 'newName',
    `return (async () => { ${body.slice(1, -1)} })();`,
  );
  const ok = await fn(
    () => ({ moves }),
    [{ path: 'D:\\s\\a_b.md', isDir: false }],
    0,
    { name: 'A' },
    { renameSkillSegment: async () => ret },
    (m, isError) => logs.push({ m, isError: !!isError }),
    () => { refreshed++; },
    'B',
  );
  return { ok, logs, refreshed };
}

// --- 全被跳过：moved = 0 ---
{
  const { ok, logs, refreshed } = await runSubmit([{ from: 'x', to: 'y' }], { moved: 0, skipped: 3 });
  t('① moved=0 时必须返回 false（弹窗留在原地）', ok === false, `ok=${ok}`);
  t('① moved=0 时不得再写「已把层级…改为」', !logs.some((l) => l.m.includes('已把层级')));
  t('① moved=0 时必须按错误通道报出来', logs.length === 1 && logs[0].isError === true);
  t('① moved=0 的报错要带上跳过条数', logs[0]?.m.includes('3'), logs[0]?.m);
  t('① moved=0 时不得触发刷新（没改成就刷，等于把谎报再确认一遍）', refreshed === 0);
}

// --- 部分成功：moved > 0 且 skipped > 0 ---
{
  const { ok, logs, refreshed } = await runSubmit([{ from: 'x', to: 'y' }], { moved: 2, skipped: 1 });
  t('① 部分成功返回 true', ok === true);
  t('① 部分成功的日志报的是 moved，不是全部条目数', logs[0]?.m.includes('2 个条目'), logs[0]?.m);
  t('① 部分成功要说明跳过原因（源已不存在）', logs[0]?.m.includes('源已不存在'), logs[0]?.m);
  t('① 部分成功不是错误', logs[0]?.isError === false);
  t('① 部分成功要刷新', refreshed === 1);
}

// --- 全部成功 ---
{
  const { ok, logs } = await runSubmit([{ from: 'x', to: 'y' }], { moved: 3, skipped: 0 });
  t('① 全成功返回 true', ok === true);
  t('① 全成功日志不提「跳过」', !logs[0]?.m.includes('跳过'), logs[0]?.m);
  t('① 全成功日志报 3 个条目', logs[0]?.m.includes('3 个条目'));
}

// --- 一条都没匹配上（moves 为空） ---
{
  const { ok, logs, refreshed } = await runSubmit([], { moved: 0, skipped: 0 });
  t('① moves 为空时返回 false', ok === false);
  t('① moves 为空时按错误通道报', logs[0]?.isError === true, logs[0]?.m);
  t('① moves 为空时不刷新', refreshed === 0);
}

/* ============================================================
 * ② ③ SettingsDialog：跑真身（两条 promise 链）
 * ========================================================== */

const sd = read('components/SettingsDialog.tsx');
const i0 = sd.indexOf('    api.backupAutoStatus()');
const tail = 'setIconErr(errText(e)); });';
const i1 = sd.indexOf(tail, i0);
const effectBody = i0 >= 0 && i1 >= 0 ? sd.slice(i0, i1 + tail.length) : '';

t('② 取到两条拉取的完整片段', effectBody.length > 0 && effectBody.includes('listIcons'), `${effectBody.length} 字符`);

async function runEffect({ statusOk, iconOk }) {
  const st = { status: '未设置', statusErr: '未设置', iconFiles: '未设置', iconErr: '未设置' };
  const fn = new Function(
    'api', 'setStatus', 'setStatusErr', 'setIconFiles', 'setIconErr', 'errText',
    effectBody,
  );
  fn(
    {
      backupAutoStatus: () => (statusOk
        ? Promise.resolve({ running: true, minutes: 30, lastRun: null, lastError: '磁盘已满' })
        : Promise.reject(new Error('命令不存在'))),
      listIcons: () => (iconOk
        ? Promise.resolve(['a.ico'])
        : Promise.reject(new Error('读不到 icons/'))),
    },
    (v) => { st.status = v; },
    (v) => { st.statusErr = v; },
    (v) => { st.iconFiles = v; },
    (v) => { st.iconErr = v; },
    (e) => String(e?.message ?? e),
  );
  await new Promise((r) => setTimeout(r, 0));
  return st;
}

{
  const st = await runEffect({ statusOk: false, iconOk: false });
  t('② backupAutoStatus 失败时 status 置 null（不留下旧值冒充当前状态）', st.status === null);
  t('② backupAutoStatus 失败时必须记下原因', st.statusErr === '命令不存在', st.statusErr);
  t('③ listIcons 失败时必须记下原因', st.iconErr === '读不到 icons/', st.iconErr);
  t('③ listIcons 失败时列表清空（不至于显示一批读不出来的图标）',
    Array.isArray(st.iconFiles) && st.iconFiles.length === 0);
}

{
  const st = await runEffect({ statusOk: true, iconOk: true });
  t('② 成功时清掉 statusErr', st.statusErr === '');
  t('③ 成功时清掉 iconErr', st.iconErr === '');
  t('② 成功时 status 为真值', st.status && st.status.running === true);
  t('③ 成功时列表有内容', st.iconFiles.length === 1);
}

/* ============================================================
 * 结构断言（剥注释后再判，防被注释喂饱）
 * ========================================================== */

const cpCode = stripComments(cp);
const sdCode = stripComments(sd);

t('① 判据是 r.moved === 0（不是只看命令不报错）', cpCode.includes('r.moved === 0'));
/*
 * 顺序比较的两端**都要先判存在**。
 *
 * `indexOf` 找不到时返回 -1，而 `-1 < 正数` 恒真 —— 少判一端的话，
 * 目标整段被删掉时断言反而通过，看着在跑其实空转。
 * 这条护栏（assertion-hygiene）在本项目里已抓到过 3 次同类写法。
 */
const iMoved = cpCode.indexOf('r.moved === 0');
const iDone = cpCode.indexOf('已把层级');
t('① 「已把层级」的日志在 moved===0 判据之后',
  iMoved >= 0 && iDone >= 0 && iDone > iMoved, `${iMoved} / ${iDone}`);
t('① moved===0 分支里带 return false',
  iMoved >= 0 && cpCode.slice(iMoved, iMoved + 400).includes('return false'));

t('② 不再有静默的 backupAutoStatus catch',
  !sdCode.includes('api.backupAutoStatus().then(setStatus).catch(() =>'));
t('② 不再有静默的 listIcons catch',
  !sdCode.includes('api.listIcons().then((r) => setIconFiles(r ?? [])).catch(() =>'));
t('② 渲染处新增了 statusErr 分支', sdCode.includes('statusErr'));
/* 锚点用 `statusErr\n`（渲染处的换行写法），
   不用裸 `statusErr` —— 后者会先命中 catch 里的 setStatusErr，
   顺序断言于是恒真，等于没验。 */
const iStatusErr = sdCode.indexOf('statusErr\n');
const iGeneric = sdCode.indexOf('设置后由后台定时执行');
t('② statusErr 分支排在「设置后由后台定时执行」之前',
  iStatusErr >= 0 && iGeneric >= 0 && iStatusErr < iGeneric, `${iStatusErr} / ${iGeneric}`);
t('③ 图标空态处新增了 iconErr 分支', sdCode.includes('iconErr'));
const iIconErr = sdCode.indexOf('iconErr\n');
const iNoIcon = sdCode.indexOf('还没有图标');
t('③ iconErr 分支排在「还没有图标」之前',
  iIconErr >= 0 && iNoIcon >= 0 && iIconErr < iNoIcon, `${iIconErr} / ${iNoIcon}`);
t('② 保存后即使 status 为 null 也补上（不再是 `: s)` 结尾）',
  !sdCode.includes('{ ...s, running, minutes: autoMinutes } : s'));
t('② 保存后补状态时清掉 statusErr', sdCode.includes("setStatusErr('');"));

done();
