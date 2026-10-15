/**
 * 插件面板（store 插件 + 外壳「＋」面板）四处静默失败
 * ------------------------------------------------------------
 * 为什么不用"查源码里有没有某个字符串"来测：
 * 这四处的共同形状都是**点了没反应 / 报了成功其实没成**，
 * 源码里有 `await` 两个字，证明不了它排在 render() 之前；
 * 源码里有 `commands:` 也证明不了解析出来是什么。
 * 所以这里把两处 onclick 与 refreshShell **原样抽出来真跑**，
 * 「＋」面板则用真实 React 渲染后真点按钮。
 *
 * 抽取而不是手抄：手抄的版本一旦与源文件漂移，
 * 就会出现"测试绿、线上照样静默"。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, 'plugins/store/index.js');
const DIALOG = path.join(HERE, 'src/components/AddPluginDialog.tsx');

/*
 * ⚠️ 反向验证时发现的：撤回「await」之后，refreshShell 的 rejection 没人接，
 * Node 20 直接把它当致命错误终止进程 —— 于是脚本崩在半路，
 * 后面「noop / 添加流程 / ＋面板」那十几条**一条都没跑**，
 * 报告上看着像"只红了 4 条"，其实是证据被吃掉了。
 * 崩溃必须显式失败，不能靠结束进程来"表达"。
 */
process.on('unhandledRejection', (e) => {
  fail++;
  console.log(`❌ 出现未处理的 Promise 拒绝（刷新失败没人接）→ ${e?.message || e}`);
});

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------------- DOM 环境 ---------------- */
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
for (const k of ['navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  if (globalThis[k] === undefined && dom.window[k] !== undefined) {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  }
}

/* ---------------- 工具：括号配平切片 ----------------
 * 教训（本项目反复栽）：用 indexOf('}') 或 `[\s\S]*?` 取函数体，
 * 会在内层 if / 箭头函数的右括号处截断 —— 切片看着拿到了，
 * 其实只剩半截，后面的断言全成了"验了个空壳"。
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

/* ================================================================
 * 第 1 节：refreshShell 跑真身
 * ================================================================ */
const storeSrc = fs.readFileSync(STORE, 'utf8');

const refreshShellSrc = sliceBalanced(storeSrc, 'async function refreshShell(shell) {', 'refreshShell');
t('抽到 refreshShell（源结构没变）',
  /await loadRegistry\(\)/.test(refreshShellSrc) && /shell\.state\.plugins = list/.test(refreshShellSrc));

/* 动态 import 在 new Function 里没有模块解析上下文，换成注入 */
const refreshShell = new Function('hostMod',
  `${refreshShellSrc.replace("await import('../../js/host.js')", 'hostMod')}\nreturn refreshShell;`);

{
  const shell = { state: {}, refresh: () => { shell.refreshed = true; } };
  const hostMod = { loadRegistry: async () => [{ id: 'a' }], filterByRuntime: (l) => l.filter((x) => x.id !== 'z') };
  const list = await refreshShell(hostMod)(shell);
  t('正常时把新列表写回 shell.state.plugins',
    Array.isArray(shell.state.plugins) && shell.state.plugins.length === 1,
    JSON.stringify(shell.state.plugins));
  t('正常时调 shell.refresh（侧边栏才会跟着变）', shell.refreshed === true);
  t('返回新列表供调用方接着用', Array.isArray(list) && list.length === 1);
}
{
  /* 拿不到外壳时：原来是 shell.state 直接 TypeError，
     而调用方没 await、也没 catch —— 界面上只剩那句"已移除"。 */
  let threw = false, msg = '';
  try { await refreshShell({})(); } catch (e) { threw = true; msg = String(e?.message || e); }
  t('shell 取不到时抛错（而不是 TypeError 被吞）', threw === true, msg);
  t('抛错的文案说清是取不到外壳', /外壳/.test(msg), msg);
}

/* ================================================================
 * 第 2 节：移除流程跑真身
 * ================================================================ */
const removeSrc = sliceBalanced(storeSrc, 'label: \'移除\', danger: true,', '移除 onclick');
const removeOnclick = new Function(
  'ctx', 'shell', 'p', 'getCustomPlugins', 'saveCustomPlugins', 'render', 'refreshShell',
  /*
   * 桩：这两个是本轮新增的"落盘结果"入口。这里只跑**正常路径**
   * （没写失败），所以 take 恒为 null —— 守卫不该挡住正常流程。
   * 失败路径由 custom-plugin-save-test.mjs 专门验。
   *
   * 注意桩必须**返回 true**：saveCustomPlugins 现在如实回答存没存成，
   * 桩不返回值（undefined）会被判成"没存下"，整个 onclick 直接 return，
   * refreshShell 一次都不会被调用 —— 后面的时序断言全崩。
   */
  `const takeCustomPluginWriteError = () => null;
   const customPluginWriteFailMsg = (k, n, e) => k + '失败:' + (n || '') + ':' + e;
   return { ${removeSrc} };`
);

function makeCtx() {
  const toasts = [];
  const invokes = [];
  /*
   * invoke 按真实 SDK 的样子给：命令不存在 → rejected。
   * 少了它，撤回 noop 那行时 `ctx.invoke?.('noop')` 得到 undefined，
   * 后面的 `.catch?.()` 直接 TypeError —— 脚本崩在第 2 节，
   * 后面的断言全跑不到，等于那组反向验证白做。
   */
  return {
    toasts,
    invokes,
    invoke: async (name) => { invokes.push(name); throw new Error(`命令不存在: ${name}`); },
    toast: (msg, type) => toasts.push({ msg: String(msg), type }),
  };
}

{
  /* 时序证据：refreshShell 挂起时，不得先报"已移除" */
  const ctx = makeCtx();
  let saved = null;
  let release;
  const fn = removeOnclick(
    ctx,
    { state: {}, refresh() {} },
    { id: 'x', name: '我的插件' },
    () => [{ id: 'x', name: '我的插件' }, { id: 'y' }],
    (l) => { saved = l; return true; },
    () => {},
    () => new Promise((r) => { release = r; }),
  ).onclick;
  const pr = fn();
  /*
   * 等 refreshShell 真的被调用。
   * 反向验证时发现的：旧代码在刷新之前还 await 了一次 invoke，
   * 会让出一个微任务 —— 直接 release 时它还 undefined，脚本当场崩，
   * 后面十几条一条都没跑。这里轮询等它挂上（最多 10 轮）。
   */
  for (let i = 0; i < 10 && !release; i++) await new Promise((r) => setTimeout(r, 0));
  t('刷新挂起时确实走到了刷新那一步', typeof release === 'function');
  t('刷新未完成时不得先报成功（await 生效）',
    ctx.toasts.length === 0, `实际 ${JSON.stringify(ctx.toasts)}`);
  t('保存确实发生了', Array.isArray(saved) && saved.length === 1 && saved[0].id === 'y',
    JSON.stringify(saved));
  release([]);
  await pr;
  t('刷新完成后才报成功',
    ctx.toasts.length === 1 && ctx.toasts[0].type === 'ok', JSON.stringify(ctx.toasts));
}
{
  /* 失败：报 err 且带原因，不得谎报成功 */
  const ctx = makeCtx();
  let rendered = 0;
  const fn = removeOnclick(
    ctx, { state: {}, refresh() {} }, { id: 'x', name: '我的插件' },
    () => [{ id: 'x' }], () => true, () => { rendered++; },
    async () => { throw new Error('注册表读不到'); },
  ).onclick;
  await fn();
  t('刷新失败时报 err，不是 ok',
    ctx.toasts.length === 1 && ctx.toasts[0].type === 'err', JSON.stringify(ctx.toasts));
  t('失败文案带出真原因', /注册表读不到/.test(ctx.toasts[0]?.msg || ''), ctx.toasts[0]?.msg);
  t('失败时不渲染（列表维持原样 + 报错，不做半套）', rendered === 0, String(rendered));
}

/* ================================================================
 * 第 3 节：noop 死代码
 * ================================================================ */
{
  t('store 面板不再调不存在的 noop 命令', !/['"]noop['"]/.test(storeSrc));
  {
    const ctx = makeCtx();
    const fn = removeOnclick(
      ctx, { state: {}, refresh() {} }, { id: 'x', name: 'P' },
      () => [], () => true, () => {}, async () => [],
    ).onclick;
    await fn();
    t('移除一次 invoke 都不调（旧代码那行 noop 是纯死代码）',
      ctx.invokes.length === 0, JSON.stringify(ctx.invokes));
  }
  /* 后端命令表里确实没有 noop —— 否则上面这条就是误报 */
  const rsRoot = path.join(HERE, 'src-tauri', 'src');
  let hasNoop = false;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.rs') && /\bfn\s+noop\b/.test(fs.readFileSync(p, 'utf8'))) hasNoop = true;
    }
  };
  walk(rsRoot);
  t('后端确实没有 noop 这条命令（死代码成立）', hasNoop === false);
}

/* ================================================================
 * 第 4 节：添加流程跑真身
 * ================================================================ */
const addSrc = sliceBalanced(storeSrc, 'onclick: async () => {\n            /*\n             * validate', '添加 onclick');
t('抽到添加 onclick（源结构没变）', /saveCustomPlugins/.test(addSrc) && /askPrompt/.test(addSrc));

const addOnclick = new Function(
  'ctx', 'shell', 'getCustomPlugins', 'saveCustomPlugins', 'render', 'refreshShell', 'askPrompt',
  `const takeCustomPluginWriteError = () => null;
   const customPluginWriteFailMsg = (k, n, e) => k + '失败:' + (n || '') + ':' + e;
   return { ${addSrc} };`
);

{
  /* 四问都按"提问 → 记录参数"的方式跑，顺带真跑 validate */
  const asked = [];
  const ctx = makeCtx();
  let saved = null;
  let release;
  const fn = addOnclick(
    ctx, { state: {}, refresh() {} }, () => [], (l) => { saved = l[0]; return true; }, () => {},
    () => new Promise((r) => { release = r; }),
    async (o) => { asked.push(o); return o?.__v ?? ''; },
  ).onclick;

  /* 名称问：注入空串走一遍 validate */
  const pr = fn();
  await new Promise((r) => setTimeout(r, 0));
  release?.([]);
  await pr;
  t('名称问带 validate（空值当场拦住，不是静默 return）',
    typeof asked[0]?.validate === 'function', JSON.stringify(Object.keys(asked[0] || {})));
  t('validate("") 返回错误文案（拦得住）',
    typeof asked[0]?.validate?.('') === 'string' && asked[0].validate('').length > 0,
    String(asked[0]?.validate?.('')));
  t('validate("  ") 也拦（只填空格不算填了）',
    typeof asked[0]?.validate?.('  ') === 'string', String(asked[0]?.validate?.('  ')));
  t('validate("日志查看器") 放行', asked[0]?.validate?.('日志查看器') === null,
    String(asked[0]?.validate?.('日志查看器')));
}
{
  /* 完整走一遍：名称 / 入口 / 命令 三问都答 */
  const asked = [];
  const ctx = makeCtx();
  let saved = null;
  const answers = ['  我的工具  ', './plugins/x/index.html', 'app_version, fs_op'];
  let n = 0;
  const fn = addOnclick(
    ctx, { state: {}, refresh() {} }, () => [], (l) => { saved = l[0]; return true; }, () => {},
    async () => [],
    async (o) => { asked.push(o); return answers[n++]; },
  ).onclick;
  await fn();
  t('添加问了三项（含需要的后端命令）', asked.length === 3, String(asked.length));
  t('第三问问的是后端命令', /命令/.test(asked[2]?.title || ''), asked[2]?.title);
  t('第三问的取消是「跳过」而不是「取消」（可选项不该把取消当中止）',
    asked[2]?.cancelText === '跳过', String(asked[2]?.cancelText));
  t('第三问写清了不填的后果', /app_version/.test(asked[2]?.message || ''), asked[2]?.message);
  t('保存的插件带 commands（否则只能调两个只读命令）',
    Array.isArray(saved?.commands) && saved.commands.length === 2
      && saved.commands[0] === 'app_version' && saved.commands[1] === 'fs_op',
    JSON.stringify(saved?.commands));
  t('名称与入口做了 trim', saved?.name === '我的工具' && saved?.entry === './plugins/x/index.html',
    `${saved?.name} / ${saved?.entry}`);
  t('添加成功后报 ok', ctx.toasts.some((x) => x.type === 'ok'), JSON.stringify(ctx.toasts));
}
{
  /* 命令那一问跳过（返回 null）时：commands 为空数组，不是 undefined */
  const ctx = makeCtx();
  let saved = null;
  const answers = ['A', './a.html', null];
  let n = 0;
  const fn = addOnclick(
    ctx, { state: {}, refresh() {} }, () => [], (l) => { saved = l[0]; return true; }, () => {},
    async () => [], async () => answers[n++],
  ).onclick;
  await fn();
  t('跳过命令问时 commands 是空数组（不是 undefined）',
    Array.isArray(saved?.commands) && saved.commands.length === 0, JSON.stringify(saved?.commands));
}

/* ================================================================
 * 第 5 节：「＋」面板真渲染
 * ================================================================ */
const React = (await import('react')).default ?? (await import('react'));
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');
const ts = (await import('typescript')).default;

const dialogSrcRaw = fs.readFileSync(DIALOG, 'utf8');
/* import 行与类型 import 在 new Function 里无法解析，去掉；
   hooks 由参数注入。 */
const dialogSrc = dialogSrcRaw
  .split('\n')
  .filter((l) => !/^\s*import\s/.test(l))
  .join('\n');

const dialogJs = ts.transpileModule(dialogSrc, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.React,
  },
}).outputText;

/*
 * new Function 里不能有 export —— 组件要靠 return 取出来。
 * 之前是 ModuleKind.ESNext 直接喂进去，结果 SyntaxError: Unexpected token 'export'，
 * 而它出现在**第 5 节最前面**，把后面「真点按钮」那 8 条全吃掉了。
 */
const dialogBody = dialogJs.replace(/\bexport\s+default\s+/g, '');
if (/\bexport\s/.test(dialogBody)) throw new Error('转译结果里仍有 export（源结构变了）');

const AddPluginDialog = new Function(
  'React', 'useState', 'useEffect', 'createElement',
  `${dialogBody}\nreturn AddPluginDialog;`,
)(React, React.useState, React.useEffect, createElement);

t('转译出「＋」面板组件（源结构没变）', typeof AddPluginDialog === 'function');

const submissions = [];
const container = dom.window.document.getElementById('root');
let root;
await act(async () => {
  root = createRoot(container);
  root.render(createElement(AddPluginDialog, {
    onClose: () => {},
    onSubmit: (p) => submissions.push(p),
    plugins: [{ id: 'b1', name: '内置插件', builtin: true, kind: 'app', type: 'iframe' }],
    onRemove: () => {},
  }));
});

/** 找到按钮（按可见文案） */
const buttons = () => [...container.querySelectorAll('button')];
const byText = (s) => buttons().find((b) => (b.textContent || '').trim() === s);
/*
 * ⚠️ 页签按钮的文案**也叫「添加」**，用 find 拿到的是它 ——
 * 于是"点了没反应"那条断言点在页签上，恒绿而什么都没验到，
 * 真正的提交按钮一次都没被点到（submissions 始终是 0）。
 * 提交按钮在底部操作行里，取**最后一个**同文案的按钮。
 */
const submitBtn = () => buttons().filter((b) => (b.textContent || '').trim() === '添加').pop();
/** 受控输入：必须走 React 的 value setter，直接赋值 React 收不到 */
const setValue = (input, v) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, v);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};

await act(async () => { byText('添加').click(); });
{
  const add = submitBtn();
  t('切到「添加」页后能找到提交按钮', !!add);
  t('提交按钮不是页签那个「添加」（两者同名）', add !== byText('添加'));
  const inputs = [...container.querySelectorAll('input')];
  t('表单里有名称与入口两个输入框', inputs.length >= 2, String(inputs.length));

  await act(async () => { add.click(); });
  t('没填时点了不会提交（按钮已置灰）', submissions.length === 0, String(submissions.length));
  t('没填时按钮 disabled（点了没反应可见为"不能点"）',
    submitBtn()?.disabled === true, String(submitBtn()?.disabled));
  t('没填时写明还差什么', /还差插件名称/.test(container.textContent || ''),
    (container.textContent || '').slice(-80));

  await act(async () => { setValue(inputs[0], '日志查看器'); });
  t('填了名称后提示改成还差入口文件',
    /还差入口文件/.test(container.textContent || '') && !/还差插件名称/.test(container.textContent || ''),
    (container.textContent || '').slice(-80));
  t('只填名称时按钮仍 disabled', submitBtn()?.disabled === true);

  await act(async () => { setValue([...container.querySelectorAll('input')][1], './plugins/log/index.html'); });
  t('两项都填后按钮可用', submitBtn()?.disabled === false);
  t('可用时不再显示"还差"提示', !/还差/.test(container.textContent || ''));

  await act(async () => { submitBtn().click(); });
  t('提交了一次', submissions.length === 1, String(submissions.length));
  t('提交的字段带 commands（后端能力声明）',
    Array.isArray(submissions[0]?.commands), JSON.stringify(submissions[0]));
  t('提交的名称与入口已 trim',
    submissions[0]?.name === '日志查看器' && submissions[0]?.entry === './plugins/log/index.html',
    `${submissions[0]?.name} / ${submissions[0]?.entry}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
