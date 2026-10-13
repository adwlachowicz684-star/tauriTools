/**
 * 设置页两张卡片：点了「有反应、其实没生效」/「毫无反应也不说为什么」
 * ====================================================================
 * 本轮修的四处，共同形状都是**点击之后界面与真实状态不一致**：
 *
 *   ① 关闭窗口行为：乐观更新后保存失败**不回滚** →
 *      界面把「退出程序」画成选中，外壳里生效的仍是「隐藏到托盘」。
 *      用户下次点标题栏 ✕ 才会发现不对，而那时已经无从判断是哪次点击没成。
 *   ② 同上，但拿不到外壳接口时走 `sh?.` 静默跳过 →
 *      点了有反应（高亮跟着走）、其实什么都没改，且不报错。
 *   ③ 文件访问授权：输入框为空时点「添加目录」静默 return →
 *      按下去毫无反应，也不说为什么。同一张设置页里的 FavDirsCard
 *      早就写成置灰了，两张卡片不能一个说法一个做法。
 *   ④ 无构建版（settings/index.js）的同一处，行为必须与 React 版一致。
 *
 * 为什么是"抽出来真跑"而不是查源码里有没有那几个字：
 *   源码里有 `setCur(prev)` 证明不了它排在错误分支里；
 *   源码里有 `ctx.toast(...)` 证明不了空输入时它真会被调到。
 *   所以 ①②③④ 四个函数体都按括号配平抽出、剥掉类型标注后**实跑**，
 *   断言的是"调用之后状态机走到了哪里"。
 *
 * 运行：node settings-cards-click-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = path.join(HERE, 'plugins/settings/WindowCard.tsx');
const FILES = path.join(HERE, 'plugins/settings/FilesCard.tsx');
const VANILLA = path.join(HERE, 'plugins/settings/index.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/*
 * 崩溃必须显式失败，不能靠"进程退出"来表达 ——
 * 脚本崩在半路会把后面的断言全吃掉，报告上看着像"只红了几条"，
 * 其实后面的证据一条都没跑（本项目反复栽在这一条上）。
 */
process.on('unhandledRejection', (e) => {
  fail++;
  console.log(`❌ 出现未处理的 Promise 拒绝 → ${e?.message || e}`);
});

/* ---------------- 括号配平切片 ----------------
 * 用 indexOf('}') 或 `[\s\S]*?` 取函数体会在内层 if 的右括号处截断 ——
 * 切片看着拿到了，其实只剩半截，后面的断言全成了"验了个空壳"。
 */
function sliceBalanced(src, startMark, label) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error(`抽取失败（找不到起点）：${label}`);
  const open = src.indexOf('{', i);
  if (open < 0) throw new Error(`抽取失败（起点后没有 {）：${label}`);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`抽取失败（括号不配平）：${label}`);
}

/* TSX 里只有两处类型标注挡着 JS 解析，机械剥掉。
   不是手写一份：手抄的版本一旦与源文件漂移，就会"测试绿、线上照样静默"。 */
const stripTs = (s) => s
  .replace(/: CloseAction/g, '')
  .replace(/\(e: any\)/g, '(e)')
  .replace(/invoke<string\[\]>/g, 'invoke');

function makeCtx(invokeImpl) {
  const toasts = [], invokes = [];
  return {
    toasts, invokes,
    invoke: async (name, args) => {
      invokes.push({ name, args });
      if (invokeImpl) return invokeImpl(name, args);
      return [];
    },
    toast: (msg, type) => toasts.push({ msg: String(msg), type }),
  };
}

/* ================================================================
 * 第 1 节：WindowCard 的 pick —— 失败必须回滚
 * ================================================================ */
const winSrc = fs.readFileSync(WIN, 'utf8');
const pickSrc = stripTs(sliceBalanced(winSrc, 'const pick = useCallback(async (v: CloseAction) => {', 'WindowCard pick'));
t('抽到 WindowCard 的 pick（源结构没变）',
  /setCur\(v\)/.test(pickSrc) && /saveCloseAction/.test(pickSrc));
t('★ pick 必须走落盘版（setCloseAction 写不进去时也会"成功"）',
  /saveCloseAction/.test(pickSrc) && !/await sh\.setCloseAction\(/.test(pickSrc),
  pickSrc.replace(/\s+/g, ' ').slice(0, 160));

function buildPick(curInit, sh) {
  const calls = [], errs = [];
  const pick = new Function(
    'useCallback', 'cur', 'setCur', 'setErr', 'sh',
    // 切片停在箭头函数体的 `}`，useCallback( 还开着 —— 必须自己补上 `)`
    `${pickSrc});\nreturn pick;`,
  )((fn) => fn, curInit, (v) => calls.push(v), (m) => { if (m != null) errs.push(String(m)); }, sh);
  return { pick, calls, errs };
}

{
  /* 保存失败：界面必须回到"真正生效的那个" */
  const { pick, calls, errs } = buildPick('hide', {
    setCloseAction: async () => { throw new Error('外壳拒绝写入'); },
    saveCloseAction: async () => { throw new Error('外壳拒绝写入'); },
  });
  await pick('close');
  t('★ 保存失败后回滚（最后停留在 hide，而不是停在 close）',
    calls.length === 2 && calls[0] === 'close' && calls[1] === 'hide',
    JSON.stringify(calls));
  t('回滚之外还要把原因说出来', errs.length === 1 && /外壳拒绝写入/.test(errs[0]), errs[0]);
}
{
  /* 成功：不回滚 */
  const { pick, calls, errs } = buildPick('hide', {
    setCloseAction: async () => undefined,
    saveCloseAction: async () => ({ action: 'close', saved: true }),
  });
  await pick('close');
  t('成功时不回滚（停在 close）', calls.length === 1 && calls[0] === 'close', JSON.stringify(calls));
  t('成功时不报错', errs.length === 0, JSON.stringify(errs));
}
{
  /*
   * 桥接没抛异常、但**没落盘**（localStorage 在隔离态下不可用）——
   * 这是旧写法唯一漏掉的一档：setCloseAction 照样返回新值，
   * 于是界面停在 close，重启后悄悄变回 hide，一句提示都没有。
   */
  const { pick, calls, errs } = buildPick('hide', {
    setCloseAction: async () => 'close',
    saveCloseAction: async () => ({ action: 'hide', saved: false }),
  });
  await pick('close');
  t('★ 桥接说成功、但没落盘时也要回滚（停在 hide）',
    calls.length === 2 && calls[1] === 'hide', JSON.stringify(calls));
  t('没落盘时要把"重启后会变回去"说出来',
    errs.length === 1 && /没能保存/.test(errs[0]) && /重启/.test(errs[0]), errs[0]);
}
{
  /* 拿不到外壳接口：不能 sh?. 静默跳过 */
  const { pick, calls, errs } = buildPick('hide', null);
  await pick('close');
  t('★ 拿不到外壳接口时也要回滚（点了不能只留高亮）',
    calls.length === 2 && calls[1] === 'hide', JSON.stringify(calls));
  t('拿不到外壳时必须报错，不能静默', errs.length === 1 && /外壳/.test(errs[0]), errs[0]);
}

/* ================================================================
 * 第 2 节：FilesCard 的 add —— 空输入不能静默
 * ================================================================ */
const filesSrc = fs.readFileSync(FILES, 'utf8');
const addSrc = stripTs(sliceBalanced(filesSrc, 'const add = async () => {', 'FilesCard add'));
t('抽到 FilesCard 的 add（源结构没变）',
  /af_fs_allow_root/.test(addSrc) && /setBusy/.test(addSrc));

function buildAdd(draft, ctx) {
  let busy = false;
  const drafts = [];
  const add = new Function(
    'draft', 'busy', 'setBusy', 'setDraft', 'ctx', 'refresh',
    `${addSrc}\nreturn add;`,
  )(draft, busy, (v) => { busy = v; }, (v) => drafts.push(String(v)), ctx, async () => {});
  return { add, drafts };
}

{
  const ctx = makeCtx();
  const { add, drafts } = buildAdd('   ', ctx);
  await add();
  t('★ 空输入时明确提示（而不是什么都不做）',
    ctx.toasts.length === 1 && ctx.toasts[0].type === 'err', JSON.stringify(ctx.toasts));
  t('空输入时不发命令', ctx.invokes.length === 0, JSON.stringify(ctx.invokes));
  t('空输入时不清空输入框', drafts.length === 0);
}
{
  const ctx = makeCtx(async () => ['/data']);
  const { add, drafts } = buildAdd('/tmp/work', ctx);
  await add();
  t('有输入时照常发 af_fs_allow_root',
    ctx.invokes.length === 1 && ctx.invokes[0].name === 'af_fs_allow_root',
    JSON.stringify(ctx.invokes.map((i) => i.name)));
  t('成功后清空输入框', drafts.length === 1 && drafts[0] === '', JSON.stringify(drafts));
  t('成功后报成功', ctx.toasts.some((x) => x.type === 'ok'), JSON.stringify(ctx.toasts));
}

/* 第 3 节：FilesCard 的按钮必须置灰（与同页 FavDirsCard 同一套做法） */
{
  const btnBlock = filesSrc.slice(
    Math.max(0, filesSrc.indexOf('添加目录') - 400),
    filesSrc.indexOf('添加目录'),
  );
  t('★ 「添加目录」按钮在输入为空时置灰',
    /disabled=\{busy \|\| !draft\.trim\(\)\}/.test(btnBlock),
    btnBlock.slice(-160).replace(/\s+/g, ' '));
}

/* ================================================================
 * 第 4 节：无构建版 settings/index.js —— 行为必须与 React 版一致
 * ================================================================ */
const vanillaSrc = fs.readFileSync(VANILLA, 'utf8');

{
  const vPickSrc = sliceBalanced(vanillaSrc, 'const pick = async (v) => {', 'vanilla pick');
  t('抽到无构建版的 pick（源结构没变）', /saveCloseAction/.test(vPickSrc));
  t('★ 无构建版也走落盘版',
    !/window\.setCloseAction\(/.test(vPickSrc) && /window\.saveCloseAction\(/.test(vPickSrc),
    vPickSrc.replace(/\s+/g, ' ').slice(0, 160));

  const run = async (shWindow) => {
    const toasts = [];
    const ctx = { shell: shWindow ? { window: shWindow } : undefined,
      toast: (m, ty) => toasts.push({ msg: String(m), type: ty }) };
    const painted = [];
    const api = new Function('ctx', 'curInit', 'paint',
      `let cur = curInit;\n${vPickSrc}\nreturn { pick, getCur: () => cur };`)(
      ctx, 'hide', () => painted.push(1));
    await api.pick('close');
    return { cur: api.getCur(), toasts };
  };

  {
    const r = await run({ setCloseAction: async () => { throw new Error('外壳拒绝写入'); },
      saveCloseAction: async () => { throw new Error('外壳拒绝写入'); } });
    t('★ 无构建版：保存失败后回滚到 hide', r.cur === 'hide', `cur=${r.cur}`);
    t('无构建版：失败有提示', r.toasts.length === 1 && r.toasts[0].type === 'err', JSON.stringify(r.toasts));
  }
  {
    const r = await run({ setCloseAction: async () => undefined,
      saveCloseAction: async () => ({ action: 'close', saved: true }) });
    t('无构建版：成功时不报错', r.toasts.length === 0, JSON.stringify(r.toasts));
  }
  {
    /* 桥接没抛、但没落盘 —— 旧写法漏掉的那一档 */
    const r = await run({ setCloseAction: async () => 'close',
      saveCloseAction: async () => ({ action: 'hide', saved: false }) });
    t('★ 无构建版：没落盘时回滚到 hide', r.cur === 'hide', `cur=${r.cur}`);
    t('无构建版：没落盘时有提示',
      r.toasts.length === 1 && r.toasts[0].type === 'err' && /没能保存/.test(r.toasts[0].msg),
      JSON.stringify(r.toasts));
  }
  {
    const r = await run({ setCloseAction: async () => undefined,
      saveCloseAction: async () => ({ action: 'close', saved: true }) });
    t('无构建版：成功时停在 close', r.cur === 'close', `cur=${r.cur}`);
  }
  {
    const r = await run(null);
    t('★ 无构建版：拿不到外壳接口时回滚（不能静默跳过）', r.cur === 'hide', `cur=${r.cur}`);
    t('无构建版：拿不到外壳时有提示', r.toasts.length === 1, JSON.stringify(r.toasts));
  }
}

{
  const vAddSrc = sliceBalanced(vanillaSrc, 'async function add() {', 'vanilla 文件分栏 add');
  t('抽到无构建版文件分栏的 add（源结构没变）', /af_fs_allow_root/.test(vAddSrc));

  const run = async (value) => {
    const ctx = makeCtx(async () => ['/data']);
    const input = { value };
    const addBtn = { disabled: false };
    const add = new Function('input', 'addBtn', 'ctx', 'render',
      `${vAddSrc}\nreturn add;`)(input, addBtn, ctx, async () => {});
    await add();
    return { ctx, input, addBtn };
  };

  {
    const r = await run('  ');
    t('★ 无构建版：空输入时明确提示', r.ctx.toasts.length === 1 && r.ctx.toasts[0].type === 'err',
      JSON.stringify(r.ctx.toasts));
    t('无构建版：空输入时不发命令', r.ctx.invokes.length === 0);
  }
  {
    const r = await run('/tmp/work');
    t('无构建版：有输入时照常发命令',
      r.ctx.invokes.length === 1 && r.ctx.invokes[0].name === 'af_fs_allow_root');
    t('无构建版：成功后清空输入框并重新置灰', r.input.value === '' && r.addBtn.disabled === true,
      `value="${r.input.value}" disabled=${r.addBtn.disabled}`);
  }

  /* 两版说法必须一致（FilesCard.tsx 的注释就是这么承诺的） */
  const bothToast = /先粘贴要授权的目录完整路径/.test(filesSrc)
    && /先粘贴要授权的目录完整路径/.test(vAddSrc);
  t('两版空输入的提示文案一致', bothToast);
}

{
  const btnBlock = vanillaSrc.slice(
    Math.max(0, vanillaSrc.indexOf('const addBtn')),
    vanillaSrc.indexOf('const addBtn') + 300,
  );
  t('无构建版：「添加目录」初始为置灰', /disabled: true/.test(btnBlock),
    btnBlock.slice(0, 200).replace(/\s+/g, ' '));
  t('无构建版：输入变化时同步置灰状态', /oninput[\s\S]{0,120}addBtn\.disabled/.test(vanillaSrc));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
