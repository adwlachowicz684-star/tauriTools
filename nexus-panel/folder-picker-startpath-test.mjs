/**
 * folder-picker：起点 / 收藏「列不出来」时不许被选中
 * ============================================================
 * 这个 module 是**全工具统一**的选目录服务 —— project-group 与 agent-flow
 * 的浏览按钮都走它。所以这里出的问题，比两个插件各自的内置界面影响更大。
 *
 * 三处修复：
 *   ① prepare() 曾先 `path = start` 再 `await go(start)` ——
 *      start 列不出来时（收藏是很久以前存的，目录早被删 / 改名 / 移出授权根），
 *      path 已经是那个**打不开**的目录，而 disabled 判的是 !path，
 *      于是「选择此文件夹」照常可点，交出去一个不存在的目录。
 *      更糟的是 entries 还留着**上一次会话**的内容：底部说 D:/gone，
 *      列表却是上回浏览的 C:/A 的子目录，双击第一项会跳进无关的目录。
 *   ② commitFav() 曾直接 `path = f.path; commitPick()` —— 常用项一步到位
 *      没错，但不验证就等于允许选中一个早已不存在的目录：
 *      folder-picker 自己不报错，失败要等调用方真去建东西时才冒出来。
 *   ③ createChild() 空输入静默 return —— 点了「新建并进入」毫无反应也不报错，
 *      只会当成按钮坏了。
 *
 * 为什么跑真身而不是扫源码字面量：
 *   这三处都是**状态变化**（path / entries / session 有没有被改），
 *   源码里写没写那几行字证明不了"点了之后到底交出去什么"。
 *   本文件用 jsdom 真挂载面板、真点按钮，看 Promise 到底 resolve 成什么。
 *
 * 运行：node folder-picker-startpath-test.mjs
 */

import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;

let pass = 0;
let fail = 0;
function t(name, ok, why) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${why ? ` —— ${why}` : ''}`); }
}

const mod = await import(join(ROOT, 'plugins/folder-picker/module.js'));

/** 等若干轮微任务 / 定时器，让 prepare 里的 await 跑完 */
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * 造一个 ctx。
 * `dirs` 是"能列出来的目录"白名单；不在里面的路径一律抛错，
 * 用来模拟"被删掉 / 没权限 / 不在授权根"。
 */
function makeCtx(reachable, quick = [{ path: 'C:/', name: 'C盘' }]) {
  const root = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(root);
  /*
   * 收藏要能真的存下来：panel.addFav 写盘、open 时的 loadFavs 再读回来。
   * mock 成永远返回空表的话，刚加的收藏会被 loadFavs 抹掉，
   * 于是"点收藏"那一节永远找不到 chip —— 断言会假绿或干脆崩掉。
   */
  const store = { favs: [] };
  return {
    root,
    async invoke(cmd, args) {
      if (cmd === 'fpx_list_fav_dirs') return store.favs.slice();
      if (cmd === 'fpx_save_fav_dirs') { store.favs = (args?.dirs ?? []).slice(); return null; }
      if (cmd === 'fpx_quick_roots') return quick;
      if (cmd === 'fpx_list_dirs') {
        const p = String(args?.path ?? '');
        if (!reachable.has(p)) throw new Error(`打不开这个目录：${p}`);
        return (reachable.get(p) || []).map((n) => ({ path: `${p}/${n}`, name: n }));
      }
      if (cmd === 'fpx_create_folder') return `${args.parent}/${args.name}`;
      throw new Error(`未预期的命令 ${cmd}`);
    },
  };
}

function btnByText(rootEl, text) {
  return [...rootEl.querySelectorAll('button')].find((b) => b.textContent === text);
}

/* ================================================================ */
/* 一、起点列不出来                                                   */
/* ================================================================ */
console.log('【一】起点列不出来时不许被选中');

{
  const ctx = makeCtx(new Map([['C:/A', ['a1', 'a2']]]));
  const dispose = mod.default.mount(ctx);
  const panel = ctx.__fp;
  let settled = false;
  panel.open({ startPath: 'D:/gone' }).then(() => { settled = true; });
  await settle();

  const pickBtn = btnByText(panel.root, '选择此文件夹');
  t('底部找得到「选择此文件夹」', !!pickBtn);
  t('起点列不出来时它是禁用的（不会交出打不开的目录）',
    pickBtn && pickBtn.disabled === true,
    pickBtn ? `disabled=${pickBtn.disabled}` : '没找到按钮');
  t('显示了失败原因（不是静默空态）',
    /打不开这个目录/.test(panel.root.querySelector('.fp-err')?.textContent ?? ''),
    `实际「${panel.root.querySelector('.fp-err')?.textContent}」`);
  t('列表里没有残留的目录行',
    panel.root.querySelectorAll('.fp-dirrow').length === 0,
    `残留 ${panel.root.querySelectorAll('.fp-dirrow').length} 行`);
  t('输入框仍留着起点路径（改一个字符就能重试）',
    panel.root.querySelector('.p-input')?.value === 'D:/gone',
    `实际「${panel.root.querySelector('.p-input')?.value}」`);
  t('没有直接把起点当成结果 resolve 掉', settled === false);
  dispose();
}

/* ================================================================ */
/* 二、上一个会话的内容不能带进下一个会话                              */
/* ================================================================ */
console.log('\n【二】上一次浏览的内容不能出现在下一次会话里');

{
  const ctx = makeCtx(new Map([['C:/A', ['a1', 'a2']]]));
  const dispose = mod.default.mount(ctx);
  const panel = ctx.__fp;

  // 第一次：正常浏览到 C:/A
  const p1 = panel.open({ startPath: 'C:/A' });
  await settle();
  t('第一次会话列出了子目录', panel.root.querySelectorAll('.fp-dirrow').length === 2);

  // 取消掉第一次
  btnByText(panel.root, '取消').click();
  const r1 = await p1;
  await settle();
  t('第一次取消后返回 path 为 null', r1?.path === null);

  // 第二次：换一个列不出来的起点
  let settled2 = false;
  panel.open({ startPath: 'D:/gone' }).then(() => { settled2 = true; });
  await settle();
  t('第二次起点列不出来时，列表里没有上一次的子目录',
    panel.root.querySelectorAll('.fp-dirrow').length === 0,
    `残留 ${panel.root.querySelectorAll('.fp-dirrow').length} 行 —— 底部说 D:/gone、列表却是 C:/A 的内容`);
  t('第二次也没被 resolve', settled2 === false);
  dispose();
}

/*
 * 【二b】start 为空的那条分支：path 与 entries 都空才会走到
 * `else render()` 的"请从上方选择一个起点"。只清 path 不清 entries 的话，
 * 这里既没有 err 也没有 loading 挡着，上回的内容会被直接渲染出来。
 */
console.log('\n【二b】起点为空时不能冒出上回浏览过的目录');

{
  // 不给快速起点，start 才会真的为空（否则 prepare 会落到 quick[0]）
  const ctx = makeCtx(new Map([['C:/A', ['a1', 'a2']]]), []);
  const dispose = mod.default.mount(ctx);
  const panel = ctx.__fp;

  const p1 = panel.open({ startPath: 'C:/A' });
  await settle();
  t('（准备）第一次列出了子目录', panel.root.querySelectorAll('.fp-dirrow').length === 2);
  btnByText(panel.root, '取消').click();
  await p1;

  panel.open({});   // 不传 startPath
  await settle();
  t('没给起点时不渲染上回的子目录',
    panel.root.querySelectorAll('.fp-dirrow').length === 0,
    `残留 ${panel.root.querySelectorAll('.fp-dirrow').length} 行 —— 底部没有「当前」，列表却有一批目录`);
  t('提示从上方选一个起点',
    /请从上方选择一个起点/.test(panel.root.querySelector('.fp-list')?.textContent ?? ''),
    `实际「${panel.root.querySelector('.fp-list')?.textContent}」`);
  btnByText(panel.root, '取消').click();
  dispose();
}

/* ================================================================ */
/* 三、点收藏前先验证它还能不能打开                                    */
/* ================================================================ */
console.log('\n【三】常用文件夹点不开时不提交');

{
  const ctx = makeCtx(new Map([['C:/A', ['a1']]]));
  const dispose = mod.default.mount(ctx);
  const panel = ctx.__fp;

  // 收藏一条**早已打不开**的目录（模拟目录被删 / 改名）
  await panel.addFav('D:/gone', '旧项目');
  t('收藏加进去了', panel.favs.length === 1);

  let settled = false;
  const p = panel.open({ startPath: 'C:/A' });
  p.then(() => { settled = true; });
  await settle();

  const favChip = [...panel.root.querySelectorAll('.fp-chip')]
    .find((b) => /旧项目/.test(b.textContent));
  t('找得到那条收藏', !!favChip);
  favChip.click();
  await settle(10);

  t('点打不开的收藏不会直接选中（Promise 仍未 settle）', settled === false,
    '已被 resolve —— 交出去的是一个早已不存在的目录');
  t('把原因显示出来了',
    /打不开这个目录/.test(panel.root.querySelector('.fp-err')?.textContent ?? ''),
    `实际「${panel.root.querySelector('.fp-err')?.textContent}」`);

  // 收尾：取消掉这次会话，避免悬着
  btnByText(panel.root, '取消').click();
  await p;
  dispose();
}

/* ================================================================ */
/* 三b、反过来：收藏打得开时仍然一步到位                               */
/* ================================================================ */
console.log('\n【三b】收藏打得开时仍要一步到位（不能把好用的也挡掉）');

{
  const ctx = makeCtx(new Map([['C:/A', ['a1']], ['C:/good', ['g1']]]));
  const dispose = mod.default.mount(ctx);
  const panel = ctx.__fp;

  await panel.addFav('C:/good', '能打开的项目');
  const p = panel.open({ startPath: 'C:/A' });
  await settle();

  const favChip = [...panel.root.querySelectorAll('.fp-chip')]
    .find((b) => /能打开的项目/.test(b.textContent));
  t('找得到那条能打开的收藏', !!favChip);
  favChip.click();
  const r = await Promise.race([
    p,
    new Promise((res) => setTimeout(() => res('TIMEOUT'), 800)),
  ]);
  t('点能打开的收藏会立刻选中（一步到位仍成立）',
    r !== 'TIMEOUT' && r?.path === 'C:/good',
    `实际 ${JSON.stringify(r)}`);
  dispose();
}

/* ================================================================ */
/* 四、新建子文件夹：空输入不能静默无操作                              */
/* ================================================================ */
console.log('\n【四】「新建并进入」空输入要有提示');

{
  const ctx = makeCtx(new Map([['C:/A', ['a1']]]));
  const dispose = mod.default.mount(ctx);
  const panel = ctx.__fp;

  const p = panel.open({ startPath: 'C:/A', allowCreate: true });
  await settle();
  const newBtn = btnByText(panel.root, '新建并进入');
  t('allowCreate 时找得到「新建并进入」', !!newBtn);

  newBtn.click();
  await settle();
  t('名字为空时给出提示（不是静默 return）',
    (panel.root.querySelector('.fp-err')?.textContent ?? '').length > 0,
    '错误区是空的 —— 用户点了没反应也看不到原因');
  t('提示指向"名字"（而不是含糊的一句失败）',
    /文件夹名/.test(panel.root.querySelector('.fp-err')?.textContent ?? ''),
    `实际「${panel.root.querySelector('.fp-err')?.textContent}」`);

  btnByText(panel.root, '取消').click();
  await p;
  dispose();
}

/* ================================================================ */
/* 五、回归：正常的起点仍然照常可选                                    */
/* ================================================================ */
console.log('\n【五】回归：起点正常时行为不变');

{
  const ctx = makeCtx(new Map([['C:/A', ['a1', 'a2']]]));
  const dispose = mod.default.mount(ctx);
  const panel = ctx.__fp;

  const p = panel.open({ startPath: 'C:/A', title: '挑一个' });
  await settle();
  t('起点列得出来时列出了子目录', panel.root.querySelectorAll('.fp-dirrow').length === 2);
  const pickBtn = btnByText(panel.root, '选择此文件夹');
  t('按钮可用', pickBtn && pickBtn.disabled === false);
  pickBtn.click();
  const r = await p;
  t('交出去的正是起点目录', r?.path === 'C:/A', `实际 ${r?.path}`);
  t('action 是 pick', r?.action === 'pick', `实际 ${r?.action}`);
  dispose();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
