/**
 * 渲染异常兜底（#195）回归测试
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/error-boundary-test.mjs
 *
 * 守的是「重试」这个按钮**说了什么**：
 *
 * 错误边界的「重试」只能把子树重新挂一遍。它对**子组件内部的一次性坏状态**
 * 有效（重新挂载会重置那些 state），但对**喂进来的坏数据**（配置 / 后端快照）
 * 无效 —— 重挂一遍拿到同一份数据，于是再错一次。
 *
 * 不说出来时，用户看到的是：点「重试」→ 界面闪一下 → 又回到同一块错误。
 * **这个表现与「按钮坏了」完全无法区分**，他会连点几下然后放弃，
 * 而真正能解决问题的那一步（去改掉坏数据）他根本没被告知存在。
 *
 * 所以必须区分「重试成功」与「重试后仍然出错」，并把后者讲明白。
 *
 * 两条必须同时成立，缺一条都不算修好：
 *   · 重试后再错 → 标记 repeat，界面给出「再点也没用」的说明
 *   · 非重试引起的出错（第一次出错）→ 不显示那句说明，
 *     否则每次出错都先糊一句"重试解决不了"，而那时重试往往正是对的
 *
 * 测试方式说明：
 *   · 状态机（getDerivedStateFromError / componentDidCatch / retry）
 *     **跑真身** —— 用替身 Component 提供同步 setState，把类实例化后实跑。
 *   · render() 含 JSX，node 直接 import 会 SyntaxError，且本套件要求零依赖
 *     （不引 esbuild），所以 render 那一层用**剥注释后的结构断言**，
 *     并且每条都做了反向验证（撤掉必须变红），不是"源码里有这几个字"就算过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeT, stripTS } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const SRC = path.join(HERE, 'components/ErrorBoundary.tsx');
const src = fs.readFileSync(SRC, 'utf8');

/** 剥注释：注释里写的反例（"不是一次性的坏状态"之类）会把形态断言带偏 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const code = strip(src);

/* ── 替身 Component：同步 setState ────────────────────────────── */
const SHIM = path.join(os.tmpdir(), `.react-shim.${process.pid}.mjs`);
fs.writeFileSync(SHIM, `
export class Component {
  constructor(props) { this.props = props || {}; }
  setState(u) {
    const n = typeof u === 'function' ? u(this.state, this.props) : u;
    this.state = Object.assign({}, this.state, n);
  }
}
`);

/**
 * 把 render() 整段换成 return null 后加载真身。
 *
 * 为什么必须挖掉 render：它含 JSX，node import 直接 SyntaxError；
 * 而本套件不引 esbuild（drag-payload 那套就是因为这个在沙箱里跑不了）。
 * 状态机那几个方法都是真代码，不受影响。
 */
function loadWithoutRender() {
  const anchor = '  render(): ReactNode {';
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error('找不到 render()，测试需同步更新');
  let j = src.indexOf('{', src.indexOf('{', i) + 1);
  let depth = 1, k = i + anchor.length;
  while (k < src.length) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) break; }
    k++;
  }
  const body = src.slice(0, i) + '  render(): ReactNode { return null; }\n}\n';
  const out = path.join(os.tmpdir(), `.eb.${process.pid}.mjs`);
  /* stripTS 剥不掉 import 里的 `type X`（只留 Component）——
     留着会 SyntaxError，所以先把整条 import 换成只要 Component 的形式。 */
  const noType = body
    .replace(/import \{[\s\S]*?\} from 'react'/, "import { Component } from 'react'")
    /* 跨行的 `extends Component<...>` stripTS 也剥不掉（它按尖括号深度配平，
       遇到跨行就断），留着直接 SyntaxError。这只去掉类型实参，不影响行为。 */
    .replace(/extends Component<[\s\S]*?>\s*\{/, 'extends Component {')
    /* 类字段初值里的 `err: null` 会被 stripTS 当成类型注解剪成 `err`，
       实例化时就 ReferenceError。整行删掉即可：初值由测试注入
       （本测试关心的正是状态迁移，不是初值本身）。 */
    .replace(/state: \{[\s\S]*?\} = \{[\s\S]*?\};/, '')
    /* TS 的 `private` 修饰符 node 不认 */
    .replace(/^\s*private\s+/gm, '  ')
    .replace(/\): (void|ReactNode) \{/g, ') {')
    /* `{ err: null }` 里的 null 会被 stripTS 当成类型注解剪掉（变成 `{ err }`），
       于是 setState 时 ReferenceError。先换成占位符，剥完再换回来。 */
    .replace(/:\s*null\b/g, ': __NULL__');
  fs.writeFileSync(out, stripTS(noType)
    .split('__NULL__').join('null')
    .split(`from 'react'`).join(`from '${pathToFileURL(SHIM).href}'`));
  return import(pathToFileURL(out).href);
}

const { ErrorBoundary } = await loadWithoutRender();

/* ── 1. 状态机真身：出错 → 重试 → 又错 ──────────────────────── */
console.log('\n=== 1. 状态机真身（实例化实跑）===');
{
  t('导出 ErrorBoundary', typeof ErrorBoundary === 'function');

  const mk = () => {
    const b = new ErrorBoundary({ children: null });
    b.state = { err: null, repeat: false };
    return b;
  };
  const boom = () => new Error('boom');
  /** 模拟 React：先 getDerivedStateFromError，再 componentDidCatch */
  const crash = (b) => {
    const e = boom();
    b.state = Object.assign({}, b.state, ErrorBoundary.getDerivedStateFromError(e));
    b.componentDidCatch(e, { componentStack: '' });
  };

  const a = mk();
  crash(a);
  t('首次出错：记下错误', a.state.err instanceof Error);
  t('首次出错**不**报「重试无效」', a.state.repeat === false,
    '第一次出错就糊一句"重试解决不了"是错的 —— 那时重试往往正是对的');

  a.retry();
  t('重试：清掉错误', a.state.err === null);
  t('重试：清掉 repeat', a.state.repeat === false);

  crash(a);
  t('重试后**立刻又错** → 报 repeat', a.state.repeat === true,
    '不说出来的话，"重试失败"和"按钮坏了"在界面上长得一样');
  t('重试后又错：错误仍在（没被吞）', a.state.err instanceof Error);

  /* 再点一次重试：repeat 必须清掉，否则下一次若真成功了，
     界面上还挂着"重试解决不了"，与事实相反。 */
  a.retry();
  crash(a);
  t('连续重试都失败：repeat 保持为 true', a.state.repeat === true);
}

/* ── 2. 状态机真身：非重试引起的出错不得误报 ─────────────────── */
console.log('\n=== 2. 不误报（第二次出错不是重试引起的）===');
{
  const b = new ErrorBoundary({ children: null });
  b.state = { err: null, repeat: false };
  const crash = () => {
    const e = new Error('x');
    b.state = Object.assign({}, b.state, ErrorBoundary.getDerivedStateFromError(e));
    b.componentDidCatch(e, { componentStack: '' });
  };
  crash();
  b.retry();
  /* 关键：重试**成功**了（没有再错），此时 repeat 必须仍是 false */
  t('重试成功后 repeat 仍为 false', b.state.repeat === false);
}

/* ── 3. 结构：render 必须把 repeat 显示出来 ──────────────────── */
console.log('\n=== 3. render 结构（剥注释后判，反向验证见文件末）===');
{
  /* 不能写 `\{[^}]*repeat`：类型那半 `{ err: Error | null; repeat: boolean }`
     先遇到 `}` 就断了，而 `repeat: false` 在**初值**那一半里 —— 断言恒假。 */
  t('state 含 repeat 字段', /state:\s*\{[\s\S]*?repeat:\s*false\s*\}/.test(code));
  t('render 里按 repeat 判显示', code.includes('this.state.repeat &&'));
  t('提示文案讲明「重试解决不了」', code.includes('重试后仍然出错'));
  t('提示指向可自救的一步（设置页）', code.includes('设置页'));
  t('按钮调的是 retry()，不是直接 setState', code.includes('onClick={() => this.retry()}'));
  t('不再有 `setState({ err: null })` 这种无痕重试',
    !code.includes('setState({ err: null })'),
    '无痕重试下"重试失败"与"按钮失灵"无法区分');
  t('retry() 里带 justRetried 标记', /retry\(\): void \{[\s\S]{0,200}justRetried = true/.test(code));
  t('componentDidCatch 里清掉标记（不重复报）',
    /componentDidCatch[\s\S]{0,600}justRetried = false/.test(code));
}

/* ── 4. 样式：说明块必须有自己的样式 ────────────────────────── */
console.log('\n=== 4. 样式与接线 ===');
{
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
  t('.fpx-crash-hint 有样式定义', /\.fpx-crash-hint\s*\{/.test(css));
  const main = fs.readFileSync(path.join(HERE, 'main.tsx'), 'utf8');
  t('主视图包了 ErrorBoundary', main.includes('<ErrorBoundary label="主视图">'));
  t('设置页包了 ErrorBoundary', main.includes('<ErrorBoundary label="设置页">'));
}

done();
