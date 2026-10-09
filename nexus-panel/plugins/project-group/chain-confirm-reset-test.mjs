/**
 * 发送前的确认框：待确认目标被换掉时，草稿必须跟着换（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/chain-confirm-reset-test.mjs
 *
 * `ChainConfirmDialog` 的草稿是 `useState(text)` —— 只在**挂载时**取一次。
 * 而调用方是条件渲染（`{pendingSend && ...}`）：弹窗开着时再按另一个动作的
 * 快捷键，`setPendingSend` 直接换成新那份，中间不经过 null，组件**不卸载**，
 * 于是草稿仍停在旧动作的指令全文上。
 *
 * 后果比"显示旧内容"更实：动作名与客户端名都是 props，会更新成新的，
 * 而文本框里是旧动作的指令。用户看到「动作 B → 客户端 X」配着 A 的指令全文，
 * 点确认就把 **A 的指令发给 B 动作** —— 一条与该动作毫不相干的指令发进了
 * 外部 AI 进程，无法撤销。
 *
 * 所以这里必须把那段同步 effect 抽出来**真跑**：
 * 只断言"源码里有 useEffect 这几个字"，
 * 证明不了换目标时 setDraft 真的收到了新的 text。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripCommentsJs as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

const dlg = strip(read('components/ChainConfirmDialog.tsx'));
const hub = strip(read('components/DialogsHub.tsx'));
const panel = strip(read('components/ToolsPanel.tsx'));

/* ---------------- 1. 抽出那段同步 effect，真跑 ---------------- */

/*
 * 锚点用 `setDraft(text)` 而不是 `useEffect(`：
 * 全文件里只有这一处 useEffect，但将来若加了别的（比如自动聚焦），
 * 按 `useEffect(` 取首个命中就会切错。先定位 setDraft，再向外取整个调用，
 * 切错了下面第 2 条会立刻报红，不会静默空跑。
 */
const call = (() => {
  const i = dlg.indexOf('setDraft(text)');
  if (i < 0) return '';
  const start = dlg.lastIndexOf('useEffect(', i);
  if (start < 0) return '';
  /* 从 '(' 起做括号配对，取到这个调用的结尾 */
  let depth = 0;
  for (let j = start + 'useEffect'.length; j < dlg.length; j += 1) {
    if (dlg[j] === '(') depth += 1;
    else if (dlg[j] === ')') {
      depth -= 1;
      if (depth === 0) return dlg.slice(start, j + 1);
    }
  }
  return '';
})();

t('切到的是确认框里那段同步 effect（含 setDraft(text)）',
  call.includes('setDraft(text)'), call.slice(0, 60));

const m = call.match(/^\s*useEffect\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[([^\]]*)\]\s*\)\s*;?\s*$/);
t('形状是 useEffect(() => { … }, [ … ])', !!m, m ? m[2].trim() : '(没匹配上)');

if (m) {
  const body = m[1];
  const deps = m[2];

  /* 依赖里必须有 text：写成 `[]` 的话只在挂载时跑一次，等于没写 */
  t('依赖数组含 text（不是空依赖）',
    deps.split(',').some((s) => s.trim() === 'text'), `[${deps.trim()}]`);

  /* 真跑：给一个"新指令"，看 setDraft 收到的是不是它 */
  const calls = [];
  const setDraft = (v) => calls.push(v);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('setDraft', 'text', body);
    fn(setDraft, '发给 B 动作的指令全文');
    t('换目标后草稿被重置为新的 text（跑真身）',
      calls.length === 1 && calls[0] === '发给 B 动作的指令全文',
      JSON.stringify(calls));
  } catch (e) {
    t('换目标后草稿被重置为新的 text（跑真身）', false, String(e));
  }

  /* 旧值不该被写回：写成 setDraft(draft) 就永远不会变 */
  t('回调里没有把旧草稿写回自己（不是 setDraft(draft)）',
    !/setDraft\(\s*draft\s*\)/.test(body), body.trim());
} else {
  t('依赖数组含 text（不是空依赖）', false, '(effect 没切到)');
  t('换目标后草稿被重置为新的 text（跑真身）', false, '(effect 没切到)');
  t('回调里没有把旧草稿写回自己（不是 setDraft(draft)）', false, '(effect 没切到)');
}

/* ---------------- 2. 文本框读的是草稿，所以草稿必须跟着换 ---------------- */

/*
 * 若 textarea 直接读 props 的 text，那草稿不同步就无所谓；
 * 正因为读的是 draft，不同步才会"动作名是新的、指令是旧的"。
 * 这条把因果钉住，免得有人改成 value={text} 后顺手把 effect 删掉。
 */
t('textarea 读的是 draft（不是 props 的 text）',
  /<textarea[\s\S]*?value=\{draft\}/.test(dlg));

/* ---------------- 3. 两处调用点都是条件渲染 → 确实可能不卸载就换 ---------------- */

/*
 * 条件渲染（`{x && <ChainConfirmDialog …>}`）本身不意味着会不卸载，
 * 关键是换目标时中间不经过 null。DialogsHub 那处由 `setPendingSend(B)` 直接换，
 * 这就是"不卸载"的证据 —— 同一份代码里 `sentRef` 的 useEffect
 * 正是为"每次新的待确认进来都要复位"而写的（它依赖 [pendingSend]）。
 */
t('侧边栏/快捷键入口：确认框由 pendingSend 条件渲染',
  /\{pendingSend && \([\s\S]{0,200}<ChainConfirmDialog/.test(hub));
t('侧边栏/快捷键入口：确认框收到了 pendingSend.text',
  /<ChainConfirmDialog[\s\S]{0,400}text=\{pendingSend\.text\}/.test(hub));

/*
 * 佐证：DialogsHub 里已有一份"每次新的待确认进来都要复位"的 effect，
 * 说明作者知道 pendingSend 会不卸载就被换掉 —— 本轮补的是同一件事的另一半。
 * 这条不是装饰：它把"为什么这里也要同步"钉在源码上，
 * 将来有人删掉 sentRef 那条时，这里会跟着红，提醒连带关系。
 */
t('同一弹窗已有「换目标要复位」的先例（sentRef 依赖 pendingSend）',
  /useEffect\(\(\)\s*=>\s*\{\s*sentRef\.current\s*=\s*false;\s*\},\s*\[pendingSend\]\)/.test(hub));

/* 面板入口同样是条件渲染，走的是同一份草稿逻辑 */
t('面板入口：确认框由 confirm 条件渲染',
  /\{confirm && \([\s\S]{0,200}<ChainConfirmDialog/.test(panel));

/* ---------------- 4. 兜底：不得再有别的"只取一次"的草稿 ---------------- */

/*
 * 全仓（本插件内）不得再出现 `useState(text)` 这种"只取一次"的草稿初值，
 * 而旁边没有对应的同步 effect。当前只有一处，且已配了 effect。
 * 只判"有 useState(text)"会误伤修复后的代码本身，所以按**出现次数**判。
 */
const takeOnce = (dlg.match(/useState\(text\)/g) || []).length;
const syncs = (dlg.match(/setDraft\(text\)/g) || []).length;
t('草稿初值只有一处，且配了同样数量的同步点（1:1）',
  takeOnce === 1 && syncs === 1, `useState(text)=${takeOnce}, setDraft(text)=${syncs}`);

done();
