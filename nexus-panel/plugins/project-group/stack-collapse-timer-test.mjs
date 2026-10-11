/**
 * 分类标题「单击折叠」计时器回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/stack-collapse-timer-test.mjs
 *
 * 测的是上一轮记下的第 2 项：`StackedGroups` 的 `clickTimer` 是**单个 ref**，
 * 所有分类共用。220ms 内先点 A 的标题、再点 B 的标题，B 那次会
 * `clearTimeout` 掉 A 待执行的定时器 —— 于是 **A 永远不折叠**，
 * 用户点了却毫无反应（不闪、不报错），只会当成"折叠这功能坏了"。
 *
 * 和"所有分类共用一个 editing 下标"是同一类错误：一份状态描述多个
 * 并列对象，彼此互相取消。
 *
 * 两个 handler 是从源码**切出来真跑**的：只断言"源码里有 clickTimers"
 * 证明不了"点 A 再点 B 之后 A 到底会不会折叠"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'components/StackedGroups.tsx');
const src = fs.readFileSync(FILE, 'utf8');
const { t, done } = makeT();

/**
 * 从 anchor **之后**（不是 anchor 之内）的第一个 `{` 起按括号配平取整段。
 *
 * anchor 里自带 `onClick={` 的 `{`：从 anchor 起点找 `{` 会命中 JSX 属性
 * 值那层括号，切出来的是 `() => {...}` 这个**表达式**而不是函数体 ——
 * `new Function` 拿它当语句等于造了个函数就丢掉，后面所有行为断言
 * **全部空跑**（"两个都折叠"会绿在空数组上）。本项目已多次栽在这上面。
 */
function cutBrace(text, from) {
  let s = text.indexOf('{', from);
  if (s < 0) return null;
  let d = 0;
  for (let i = s; i < text.length; i++) {
    if (text[i] === '{') d++;
    else if (text[i] === '}') { d--; if (d === 0) return text.slice(s + 1, i); }
  }
  return null;
}
/** anchor 必须以 `{` 结尾：从**它自己那个** `{` 开始配平。 */
function cutBody(text, anchor) {
  const a = text.indexOf(anchor);
  if (a < 0 || !anchor.endsWith('{')) return null;
  return cutBrace(text, a + anchor.length - 1);
}
/**
 * 卸载清理那个 effect 要**认准是哪一个**：文件里有好几个
 * `useEffect(() => () => {`（reveal 那个也是这个形状）。
 * 只取第一个会切到 reveal 那段 —— 里面引用 `reveal`，
 * 实例化运行时直接 ReferenceError 崩掉，把后面的断言全吃掉。
 */
function cutCleanup(text) {
  const anchor = 'useEffect(() => () => {';
  let from = 0;
  for (;;) {
    const a = text.indexOf(anchor, from);
    if (a < 0) return null;
    const body = cutBrace(text, a + anchor.length - 1);
    if (body && body.includes('clickTimers')) return body;
    from = a + anchor.length;
  }
}

const ANCHOR = 'title="单击折叠 / 双击重命名"';
t('找到分类标题按钮', src.includes(ANCHOR));
const tail = src.slice(src.indexOf(ANCHOR));
const onClickBody = cutBody(tail, 'onClick={() => {');
const onDblBody = cutBody(tail, 'onDoubleClick={() => {');
const cleanBody = cutCleanup(src);

console.log('\n=== 0. 自检：三段都要切到，否则后面全是空跑 ===');
t('onClick 切到', !!onClickBody, `${onClickBody ? onClickBody.length : 0} 字节`);
t('onDoubleClick 切到', !!onDblBody, `${onDblBody ? onDblBody.length : 0} 字节`);
t('卸载清理切到', !!cleanBody, `${cleanBody ? cleanBody.length : 0} 字节`);
/* 切到了但切错地方同样等于没验 —— 必须含关键语句 */
/* 切对了地方还不够：切到 `() => {...}` 这层的话上面几条照样成立，
   所以必须确认拿到的是**函数体语句**、不是整个箭头表达式 */
t('onClick 切到的是函数体而不是箭头表达式',
  onClickBody !== null && !onClickBody.trim().startsWith('()'), (onClickBody || '').slice(0, 40));
t('onDoubleClick 切到的是函数体而不是箭头表达式',
  onDblBody !== null && !onDblBody.trim().startsWith('()'), (onDblBody || '').slice(0, 40));
t('onClick 含按索引取定时器', onClickBody !== null && onClickBody.includes('clickTimers.current.get(i)'));
t('onClick 含按索引存定时器', onClickBody !== null && onClickBody.includes('clickTimers.current.set(i, id)'));
t('onDoubleClick 含只清自己那一个', onDblBody !== null && onDblBody.includes('clickTimers.current.delete(i)'));
t('清理段含遍历全部', cleanBody !== null && cleanBody.includes('forEach'));

/* `clearTimeout` 在浏览器里是裸全局（源码写的是 `clearTimeout(prev)` 而不是
   `window.clearTimeout`），所以必须作为参数注入 —— 漏了的话这里用的是
   **Node 的** clearTimeout，清不掉替身里的定时器，于是"双击取消折叠"
   "连点只折叠一次"两条**永远绿不了也红不了**（行为断言全部失真）。 */
const ARGS = ['clickTimers', 'i', 'toggle', 'window', 'setDraft', 'setEditing', 't', 'clearTimeout'];
const onClick = new Function(...ARGS, onClickBody ?? '');
const onDblClick = new Function(...ARGS, onDblBody ?? '');
const cleanup = new Function('clickTimers', 'clearTimeout', cleanBody ?? '');

/* ------------------------------------------------------------------ */
/** 极简定时器替身：不真等 220ms，手动 flush */
function makeEnv() {
  const pending = new Map();
  let seq = 0;
  const win = {
    setTimeout(fn) { const id = ++seq; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  return {
    win,
    clearTimeout: (id) => { pending.delete(id); },
    clickTimers: { current: new Map() },
    toggled: [],
    edits: [],
    /* handler 里抛异常必须**记下来继续跑**，不能直接崩：
       崩掉会把后面所有行为断言全吃掉，于是"撤回修复"看起来只红了 2 条
       （甚至一条都不红）—— 比写错的断言更危险。 */
    errors: [],
    toggle: (i) => { env.toggled.push(i); },
    setEditing: (i) => { env.edits.push(i); },
    setDraft: () => {},
    flush() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
      return fns.length;
    },
    pendingCount: () => pending.size,
  };
}
let env;
/** 包一层：handler 抛异常记进 errors，不让脚本崩在半路 */
const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { env.errors.push(String(e && e.message || e)); } };
const click = (i) => safe(onClick)(env.clickTimers, i, env.toggle, env.win, env.setDraft, env.setEditing, { name: `T${i}` }, env.clearTimeout);
const dbl = (i) => safe(onDblClick)(env.clickTimers, i, env.toggle, env.win, env.setDraft, env.setEditing, { name: `T${i}` }, env.clearTimeout);

console.log('\n=== 1. 核心：220ms 内点 A 再点 B，两个都要折叠 ===');
env = makeEnv();
click(0);
click(1);
t('handler 运行不报错（崩了就是替身与源码不符）', env.errors.length === 0, JSON.stringify(env.errors));
t('两个待执行都在（各存各的）', env.clickTimers.current.size === 2, `${env.clickTimers.current.size} 个`);
env.flush();
t('A 折叠了', env.toggled.includes(0), JSON.stringify(env.toggled));
t('B 折叠了', env.toggled.includes(1), JSON.stringify(env.toggled));
t('一共折叠两个', env.toggled.length === 2, JSON.stringify(env.toggled));
/* 折叠执行后要清掉自己的登记，否则下次点同一个会误清（虽无害但会攒垃圾） */
t('执行后登记被清掉', env.clickTimers.current.size === 0, `${env.clickTimers.current.size} 个`);

console.log('\n=== 2. 三个分类各点一次，三个都折叠 ===');
env = makeEnv();
click(0); click(1); click(2);
env.flush();
t('三个都折叠', env.toggled.length === 3 && [0, 1, 2].every((i) => env.toggled.includes(i)),
  JSON.stringify(env.toggled));

console.log('\n=== 3. 双击：取消待执行的折叠，只进改名 ===');
env = makeEnv();
click(0);
dbl(0);
t('双击后不再有待执行', env.pendingCount() === 0, `${env.pendingCount()} 个`);
env.flush();
t('双击不折叠（净效果为零，不闪）', env.toggled.length === 0, JSON.stringify(env.toggled));
t('双击进了改名', env.edits.length === 1 && env.edits[0] === 0, JSON.stringify(env.edits));

console.log('\n=== 4. 点 A 之后双击 B：A 照常折叠，B 进改名 ===');
env = makeEnv();
click(0);
dbl(1);
env.flush();
t('A 折叠了（B 的双击不能取消 A）', env.toggled.length === 1 && env.toggled[0] === 0, JSON.stringify(env.toggled));
t('B 进改名', env.edits.length === 1 && env.edits[0] === 1, JSON.stringify(env.edits));

console.log('\n=== 5. 连点同一个分类两次：只折叠一次 ===');
env = makeEnv();
click(0);
click(0);
env.flush();
t('只折叠一次', env.toggled.length === 1, JSON.stringify(env.toggled));

console.log('\n=== 6. 卸载清理：待执行的全部取消 ===');
env = makeEnv();
click(0); click(1);
try { cleanup(env.clickTimers, env.clearTimeout); } catch (e) { env.errors.push(String(e && e.message || e)); }
t('清理后登记为空', env.clickTimers.current.size === 0, `${env.clickTimers.current.size} 个`);
env.flush();
t('卸载后不再有折叠（不会 setState on unmounted）', env.toggled.length === 0, JSON.stringify(env.toggled));

console.log('\n=== 7. 源码层：不得再退回单个共用 ref ===');
t('用 Map 按下标存', /useRef<Map<number,\s*number>>\(new Map\(\)\)/.test(src));
/* 注释里提到旧名字不算，只查**声明**：单个 `clickTimer` 变量已不存在 */
t('不再有单个 clickTimer 声明', !/const clickTimer\s*[:=]/.test(src));
t('onClick 里不再无条件共用一个变量',
  !/clickTimer\.current\s*!==\s*null/.test(src.slice(src.indexOf(ANCHOR))));
t('清理段 clear 全部', /clickTimers\.current\.clear\(\)/.test(src));

done();
