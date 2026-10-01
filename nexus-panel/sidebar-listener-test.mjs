/**
 * 侧边栏重建的监听器行为实证（开发用，可删）
 *
 * 审查清单 P1-6 称：renderSidebar 用匿名箭头注册 click 且从不
 * removeEventListener → "侧边栏重建时旧监听残留，表现为点一次导航两次"。
 *
 * 本测试验证这个推断是否成立：
 *   · 若旧节点随 innerHTML='' 被丢弃，监听器随之失效 → 推断不成立
 *   · 若真的残留 → 应该观察到 navigate 被多次调用
 *
 * 无论结论如何都记录下来：不成立的话，改成事件委托就属于"更稳的写法"
 * 而非修 bug；成立的话，这条就是真 bug，必须修。
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="plugin-list"></div></body></html>',
  { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const list = document.getElementById('plugin-list');
let navigateCalls = [];
const navigate = (id) => navigateCalls.push(id);

/** 复刻 shell.js renderSidebar 的写法：清空 + 重建 + 匿名监听 */
function renderSidebar(plugins) {
  list.innerHTML = '';
  for (const p of plugins) {
    const btn = document.createElement('button');
    btn.dataset.id = p.id;
    btn.appendChild(document.createTextNode(p.name));
    btn.addEventListener('click', () => navigate(p.id));
    list.appendChild(btn);
  }
}

const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const items = () => [...list.querySelectorAll('button')];

/*
 * 必须有汇总行 + 非零退出码，否则全量体检（sweep-tests.mjs）会把它判成
 * "退出码 0 且 0 条断言"—— 也就是「看着在跑、其实一条都没守」那一类。
 * 原先这里只 console.log 结论、没有汇总行，体检单上一直是"可疑"。
 */
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

console.log('=== 场景：连续重建 3 次后点一次 ===');
renderSidebar([{ id: 'a', name: 'A' }]);
renderSidebar([{ id: 'a', name: 'A' }]);
renderSidebar([{ id: 'a', name: 'A' }]);

navigateCalls = [];
click(items()[0]);
console.log('点击 1 次 → navigate 调用', navigateCalls.length, '次：', navigateCalls.join(','));
const once = navigateCalls.length === 1;

console.log('\n=== 场景：插件列表变长后再点 ===');
renderSidebar([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
navigateCalls = [];
click(items()[2]);
console.log('点第 3 个 → navigate 调用', navigateCalls.length, '次：', navigateCalls.join(','));
const correct = navigateCalls.length === 1 && navigateCalls[0] === 'c';

/* 对照：如果**不清空**（模拟"复用节点"的写法），才会真的叠加 */
console.log('\n=== 对照组：故意不清空就重复注册 ===');
const rogue = document.createElement('button');
document.body.appendChild(rogue);
for (let i = 0; i < 3; i++) rogue.addEventListener('click', () => navigate('rogue'));
navigateCalls = [];
click(rogue);
console.log('同一节点注册 3 次后点 1 次 → navigate 调用', navigateCalls.length, '次');
const control = navigateCalls.length === 3;

console.log('\n================ 结论 ================');
t('P1-6 推断不成立：innerHTML="" 连节点一起丢弃，点一次只导航一次',
  once && correct, once ? '' : '点一次触发了多次 → 监听器真的残留了，是真 bug');
/* 对照组必须"叠加"，否则说明这套检测方法根本测不出问题，上面那条绿是假绿 */
t('对照组符合预期：不清空时才会叠加（证明检测方法有效）',
  control, control ? '' : '对照组没叠加 → 检测方法有问题，上面结论不可信');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
