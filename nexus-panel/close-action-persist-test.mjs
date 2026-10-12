/**
 * ✕ 关闭行为的落盘：「桥接说成功，其实没存下」
 * ================================================================
 * 本轮修的那半边，形状是**谎报成功**：
 *
 *   js/host.js 的 setCloseAction 在 localStorage.setItem 抛异常时
 *   `catch { /* 无妨 *\/ }` 之后照常返回新值 —— 于是设置页两处
 *   「先本地反映、失败回滚」的写法**永远等不到失败**：桥接没抛异常、
 *   返回值还是新的，界面就把「退出程序」画成选中、✕ 的提示也跟着改成
 *   「退出」，而磁盘上仍是「隐藏到托盘」，**重启后悄悄变回去**。
 *
 * 存不下的场景不是假设：设置页在 Vite 模式下是 iframe，隔离态
 * （opaque origin）下 localStorage 不可用 —— plugin-sdk.js 同一段
 * 注释里就写着这件事。
 *
 * 这是"一设就忘"的窗口行为，谎报成功比不报更糟：不报他还会再设一次，
 * 报了成功他就不会再确认，直到某次重启才发现 ✕ 又变回藏托盘了。
 *
 * 为什么抽出来真跑：源码里有 `closeAction = prev` 证明不了它排在
 * catch 里 —— 必须真给一个会抛错的存储，看状态机停在哪。
 *
 * 运行：node close-action-persist-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, 'js/host.js');
const SDK = path.join(HERE, 'js/plugin-sdk.js');
const DTS = path.join(HERE, 'js/host.d.ts');
const WIN = path.join(HERE, 'plugins/settings/WindowCard.tsx');
const VANILLA = path.join(HERE, 'plugins/settings/index.js');

const read = (p) => fs.readFileSync(p, 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const group = (name) => console.log(`\n── ${name} ──`);

/* 崩在半路会把后面的断言全吃掉，报告上看着像"只红几条" —— 必须显式记失败 */
process.on('unhandledRejection', (e) => {
  fail++;
  console.log(`❌ 出现未处理的 Promise 拒绝 → ${e?.message || e}`);
});

/* ---------------- 括号配平切片 ----------------
 * indexOf('}') 会在内层 if 处截断，切片看着拿到了、其实只剩半截。 */
function sliceBalanced(src, startMark, label) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error(`抽取失败（找不到起点）：${label}`);
  const open = src.indexOf('{', i);
  if (open < 0) throw new Error(`抽取失败（起点后没有 {）：${label}`);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error(`抽取失败（括号没配平）：${label}`);
}

/** 剥注释：注释里写的"没存成/回滚"这类字会把意图判成反的 */
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ==================== ① 判据跑真身 ==================== */
group('① saveCloseAction：存不进去必须如实回答，并回滚内存值');

const hostSrc = read(HOST);
const fnSrc = sliceBalanced(hostSrc, 'export function saveCloseAction(v) {', 'saveCloseAction')
  // `export` 在 new Function 里是 SyntaxError —— 而且崩在最前面会把
  // 后面整节真跑的断言全吃掉（本项目反复栽在这一条上）
  .replace(/^export\s+/, '');
t('（前置）抽到 saveCloseAction（源结构没变）', /saveCloseAction/.test(fnSrc) && /localStorage\.setItem/.test(fnSrc));

/**
 * 注入一个会抛错的存储桩，实跑真实函数体。
 * closeAction / CLOSE_ACTION_KEY / closeActionHooks / localStorage 都是宿主模块的闭包量，
 * 全部按真实形态注入（hooks 用数组，for…of 一样能跑）。
 */
function buildSave(initial, storage) {
  const notified = [];
  const api = new Function(
    'CLOSE_ACTION_KEY', 'closeActionHooks', 'localStorage', 'console',
    `let closeAction = ${JSON.stringify(initial)};\n${fnSrc}\n` +
    'return { save: saveCloseAction, get: () => closeAction };',
  )('nexus:close-action', [(v) => notified.push(v)], storage, console);
  return { ...api, notified };
}

{
  const ok = { writes: [] };
  const s = buildSave('hide', { setItem: (k, v) => ok.writes.push([k, v]) });
  const r = s.save('close');
  t('★ 落盘成功时 saved=true', r.saved === true, JSON.stringify(r));
  t('落盘成功时内存值跟上', s.get() === 'close' && r.action === 'close', `内存=${s.get()}`);
  t('落盘成功时通知外壳刷新 ✕ 的提示', s.notified.length === 1 && s.notified[0] === 'close', JSON.stringify(s.notified));
  t('写的是关闭行为那一个键', ok.writes.length === 1 && ok.writes[0][0] === 'nexus:close-action', JSON.stringify(ok.writes));
}
{
  /* 存储不可用：隐私模式 / 配额满 / 隔离态 */
  const s = buildSave('hide', { setItem: () => { throw new Error('QuotaExceededError'); } });
  const r = s.save('close');
  t('★ 存不进去时 saved=false（不能静默当成功）', r.saved === false, JSON.stringify(r));
  t('★ 存不进去时回滚内存值（不停在没落盘的值上）', s.get() === 'hide' && r.action === 'hide', `内存=${s.get()}`);
  t('★ 回滚后不通知外壳（否则 ✕ 的提示改了、磁盘没改）', s.notified.length === 0, JSON.stringify(s.notified));
}
{
  /* 值没变：不该白白通知一次，也不该被判成"没存成" */
  const s = buildSave('close', { setItem: () => { throw new Error('quota'); } });
  const r = s.save('close');
  t('值没变时不算失败（本来就没有东西要存）', r.saved === true, JSON.stringify(r));
  t('值没变时不重复通知', s.notified.length === 0, JSON.stringify(s.notified));
}
{
  /* 非法值一律 hide —— 与 readCloseAction 同一套口径 */
  const s = buildSave('hide', { setItem: () => undefined });
  t('非 close 的值一律按 hide 处理', s.save('CLOSE').action === 'hide' && s.save(undefined).action === 'hide');
}

/* ==================== ② 判据只有一份 ==================== */
group('② 判据只有一份：写这个键的地方不许有第二处');

const bare = strip(hostSrc);
t('★ 落盘这个键的地方只有一处（两处就会又漂成两套规则）',
  (bare.match(/localStorage\.setItem\(CLOSE_ACTION_KEY/g) || []).length === 1,
  String((bare.match(/localStorage\.setItem\(CLOSE_ACTION_KEY/g) || []).length));
t('★ setCloseAction 只是转发壳（真正判据在 saveCloseAction 里）',
  /export function setCloseAction\(v\) \{\s*return saveCloseAction\(v\)\.action;\s*\}/.test(bare),
  (bare.match(/export function setCloseAction[\s\S]{0,120}/) || [''])[0].replace(/\s+/g, ' '));
t('★ 不再有"落盘失败也无妨"的吞法',
  !/catch\s*\{\s*\/\*\s*无妨\s*\*\/\s*\}/.test(bare) && !/setItem[^\n]*catch\s*\{\s*\}/.test(bare));

/* ==================== ③ 桥接面要跟着开 ==================== */
group('③ 桥接面：插件得拿得到落盘版');

t('★ windowApi 暴露 saveCloseAction（否则插件只能调到只回值的那个）',
  /const windowApi = \{[\s\S]{0,200}saveCloseAction/.test(bare),
  (bare.match(/const windowApi = \{[\s\S]{0,200}/) || [''])[0].replace(/\s+/g, ' '));
const sdk = strip(read(SDK));
t('★ plugin-sdk 把 saveCloseAction 接出去', /method: 'saveCloseAction'/.test(sdk));
const dts = read(DTS);
t('host.d.ts 有对应声明（类型面不能缺）', /saveCloseAction\(v: CloseAction\)/.test(dts));

/* ==================== ④ 两处界面都必须用落盘版 ==================== */
group('④ 界面：只回值的那个不能用来报「已保存」');

const win = strip(read(WIN));
t('★ React 版用落盘版', /sh\.saveCloseAction\(v\)/.test(win));
t('★ React 版检查 saved === false（桥接没抛也可能没落盘）', /saved\s*===\s*false/.test(win));
t('React 版不再直接调只回值的那个', !/await sh\.setCloseAction\(/.test(win));

const van = strip(read(VANILLA));
t('★ 无构建版用落盘版', /window\.saveCloseAction\(v\)/.test(van));
t('★ 无构建版检查 saved === false', /saved\s*===\s*false/.test(van));
t('无构建版不再直接调只回值的那个', !/window\.setCloseAction\(v\)/.test(van));
t('两版的提示都说清"重启后会回到原来的设置"',
  /重启后会回到原来的设置/.test(win) && /重启后会回到原来的设置/.test(van));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) console.log('关闭行为落盘测试全部通过');
else process.exitCode = 1;
