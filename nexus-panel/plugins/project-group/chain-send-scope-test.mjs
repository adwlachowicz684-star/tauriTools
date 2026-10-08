/**
 * 连锁发送的路径收口：收口装反了
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/chain-send-scope-test.mjs
 *
 * ## 这一条为什么值得单开一个文件
 *
 * `chain::send(client, directory, prompt, custom)` 的第二个参数**不是只被
 * 拼进文案** —— 它是交给外部 AI 客户端的**工作目录**：
 *   · opencode：`opencode://new-session?directory={directory}&prompt=...`
 *   · vscode / 自定义客户端：`run(&exe, &[directory])`
 * 也就是说，传什么目录，AI 会话就在什么目录下被打开。
 *
 * 而这条通道此前**没有**路径收口，同一件事里几乎无害的那一侧
 * （`fpx_chain_preview`，只把拼好的文案显示给用户看）反而有 —— **收口装反了**。
 * 预览只是把路径显示在自己窗口里，发送却把它交给了外部进程；
 * 最该拦的那条通道此前是敞开的。
 *
 * ## 断言的写法要点
 *
 * 只断言"文件里有 ensure_path_in 这几个字"是不够的：
 *   · 它可能收的是**别的变量**（收了 directory 却把 path 发出去，等于没收）；
 *   · 它可能收在 send **之后**（越界路径已经交出去了才拦）。
 * 所以每条都钉三件事：**收了 / 收的是同一个变量 / 收在发出之前**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripCommentsFlatJs } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { t, done } = makeT();

/**
 * 剥注释后再判：本文件自己的说明里就写着 `ensure_path_in` / `chain::send`
 * 这些字样，不剥的话"反面证据"那几条会被注释喂饱、恒真。
 */
const mod = stripCommentsFlatJs(fs.readFileSync(path.join(ROOT, 'src-tauri/src/fpx/mod.rs'), 'utf8'));
const mcp = stripCommentsFlatJs(fs.readFileSync(path.join(ROOT, 'src-tauri/src/fpx/mcp.rs'), 'utf8'));

/** 按 `pub fn 名(` 起、下一个同级 `pub fn ` 止，切出函数体 */
function bodyOf(src, name) {
  const i = src.indexOf(`pub fn ${name}(`);
  if (i < 0) return '';
  const j = src.indexOf('\npub ', i + 1);
  return src.slice(i, j < 0 ? src.length : j);
}

/* ---------------------- 1. 两个发送命令都收口了 ---------------------- */

const send = bodyOf(mod, 'fpx_chain_send');
const sendAction = bodyOf(mod, 'fpx_chain_send_action');

t('切到了 fpx_chain_send', send.includes('pub fn fpx_chain_send'));
t('切到了 fpx_chain_send_action', sendAction.includes('pub fn fpx_chain_send_action'));

t('fpx_chain_send 有收口', /ensure_path_in\(&dir, &cfg, &directory\)/.test(send), send.slice(0, 60));
t('fpx_chain_send_action 有收口', /ensure_path_in\(&dir, &cfg, &path\)/.test(sendAction));

/* ---------------------- 2. 收的必须是真正交出去的那个变量 ---------------------- */

/*
 * 交出去的是 `chain::send` 的第二个参数。收口必须收**同一个变量**：
 * 收 directory 却把 path 发出去（或反之），代码看着"有收口"，实际没拦住。
 */
const SEND_RE = /chain::send\(&[^,]+,\s*&(\w+)/g;
function sentVars(src) {
  const out = [];
  let m;
  while ((m = SEND_RE.exec(src))) out.push(m[1]);
  return out;
}

t('fpx_chain_send 交出去的是 directory', sentVars(send).includes('directory'), sentVars(send).join(','));
t('fpx_chain_send_action 交出去的是 path', sentVars(sendAction).includes('path'), sentVars(sendAction).join(','));

/* ---------------------- 3. 收口必须在交出去之前 ---------------------- */

const iGuard1 = send.indexOf('ensure_path_in(');
const iSend1 = send.indexOf('chain::send(');
t('fpx_chain_send：收口在 send 之前', iGuard1 >= 0 && iSend1 > iGuard1, `${iGuard1} < ${iSend1}`);

const iGuard2 = sendAction.indexOf('ensure_path_in(');
const iSend2 = sendAction.indexOf('chain::send(');
t('fpx_chain_send_action：收口在 send 之前', iGuard2 >= 0 && iSend2 > iGuard2, `${iGuard2} < ${iSend2}`);

/*
 * 还要早于"拼指令"：越界的路径不该先被填进文案。
 * 这条是上一节的加强版 —— 只钉 send 之前的话，"先拼文案再收口"也能溜过去。
 */
const iFill2 = sendAction.search(/chain::(fill_all|resolve_prompt)\(/);
t('fpx_chain_send_action：收口还在拼指令之前', iGuard2 >= 0 && iFill2 > iGuard2, `${iGuard2} < ${iFill2}`);

/* ---------------------- 4. 兜底：凡是交目录给 chain 的入口都要收口 ---------------------- */

/*
 * 逐个函数判，而不是全仓比条数：
 * 比条数的话（收口总数 ≥ 调用总数）恒真 ——
 * 全仓几十处收口会把"这两条没收"完全淹没，正是这次事故能长期存活的原因。
 *
 * 判据：含 `chain::send(` / `chain::send_command(` 的函数体里，
 * 必须出现任意一种收口判据。以后新加一个发送通道忘了收口，这里会指名。
 */
const SCOPE_RE = /ensure_path_in\(|within_raw\(|ensure_path_allowed\(|guard::must_be_under\(/;

function fnBodies(src) {
  const out = [];
  const re = /\n(?:\s*)pub(?:\(crate\))? (?:async )?fn (\w+)\(/g;
  const hits = [...src.matchAll(re)];
  hits.forEach((h, k) => {
    const end = k + 1 < hits.length ? hits[k + 1].index : src.length;
    out.push({ name: h[1], body: src.slice(h.index, end) });
  });
  return out;
}

const senders = [...fnBodies(mod), ...fnBodies(mcp)]
  .filter((f) => /chain::send\(|chain::send_command\(/.test(f.body));

t('至少找到 3 个发送入口（含 MCP 那条）', senders.length >= 3, `找到 ${senders.length}: ${senders.map((f) => f.name).join(', ')}`);
for (const f of senders) {
  t(`发送入口 ${f.name} 有收口`, SCOPE_RE.test(f.body));
}

/*
 * MCP 那一条（deploy_skill）此前就有 `within_raw`，它必须**还在** ——
 * 它是这条规则之所以成立的证据：同一个函数，MCP 通道收了、命令通道没收。
 */
const deploy = mcp.slice(mcp.indexOf('"deploy_skill" => {'));
t('MCP deploy_skill 的 within_raw 仍在', /within_raw\(&target\)/.test(deploy));

/* ---------------------- 5. 反面证据：改回旧写法必须报红 ---------------------- */

t('fpx_chain_send 不得还是裸发（无收口即报错）',
  !/let cfg = store::load_config\(&dir\);\s*\n\s*let tpl = prompt/.test(send));
t('fpx_chain_send_action 不得还是裸发',
  !/let mut cfg = store::load_config\(&dir\);\s*\n\s*let list = chain::ensure_actions/.test(sendAction));

done();
