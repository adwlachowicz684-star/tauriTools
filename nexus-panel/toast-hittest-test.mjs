/**
 * 提示条：整棵子树都不许吃点击 + 两个壳挂同一组类名
 * ====================================================================
 * 本轮修的两处，形状都是"**已经写下的意图，被另一条规则推翻**"：
 *
 *   ① `css/controls.css` 里既有一条断言盯着「Toast 容器不拦点击
 *      （右下角不该吃掉操作）」，又有一条
 *      `.nx-toasts > *, #toasts > * { pointer-events: auto }`。
 *      pointer-events 是**继承**属性：容器 none，孩子再写 auto 就重新
 *      变成点击靶子 —— 于是每条提示都把自己盖住的那块区域吃掉 2.6 秒。
 *      右下角正是插件放操作的地方（脑图「＋新建画布」就在那条底栏上）。
 *      断言只查容器，所以"吃掉点击"这一半一直没人守。
 *
 *   ② 两个壳的类名构造不一致：原生壳 `js/shell.js` 挂 `nx-toast toast`
 *      + 状态类，`src/components/Toasts.tsx` 只挂 `toast`。现在两边
 *      选择器都在同一条 CSS 规则里所以都不炸 —— 但一旦有人按"遗留名"
 *      清理掉 `.toast` 那半，React 壳的提示条会整条失去底板/圆角/动画，
 *      而原生壳没事。这是"现在不炸、一清理就炸"。
 *
 * 为什么第 3 节要把两处的类名构造**抽出来实跑**：
 *   源码里有 `nx-toast` 这几个字，证明不了它在 `type === 'info'` 时
 *   也会带上（② 落到 React 侧就是少带）。跑真身才能看出三种输入下的
 *   类名集合是否逐一相同。
 *
 * 运行：node toast-hittest-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* 剥注释判据只留 test-scan-utils.mjs 一份：各测试内联一份会各改各的，
   一边认得出、一边认不出，体检单上就只有一半可信。 */
import { stripComments } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, 'css/controls.css');
const SHELL = path.join(HERE, 'js/shell.js');
const TOASTS = path.join(HERE, 'src/components/Toasts.tsx');

const cssRaw = fs.readFileSync(CSS, 'utf8');
const css = stripComments(cssRaw);
const shell = fs.readFileSync(SHELL, 'utf8');
const toastsSrc = fs.readFileSync(TOASTS, 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/*
 * 崩溃必须显式失败。脚本崩在半路会把后面的断言全吃掉，报告上看着像
 * "只红了几条"，其实后面的证据一条都没跑（本项目反复栽在这一条上）。
 */
process.on('unhandledRejection', (e) => {
  fail++;
  console.log(`❌ 出现未处理的 Promise 拒绝 → ${e?.message || e}`);
});

/* ---------------- 括号配平切片 ----------------
 * 用 indexOf('}') 或 `[\s\S]*?` 取规则体会**在内层右括号处截断** ——
 * 切片看着拿到了，其实只剩半截，后面的断言全成了"验了个空壳"。
 */
function sliceBalanced(src, startMark, label) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error(`抽取失败（找不到起点）：${label}`);
  const open = src.indexOf('{', i);
  if (open < 0) throw new Error(`抽取失败（起点后没有 {）：${label}`);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, k);
    }
  }
  throw new Error(`抽取失败（括号不配平）：${label}`);
}

/* 取某条规则的选择器（起点标记之前的那一整段，可能跨多行） */
function selectorOf(src, startMark, label) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error(`抽取失败（找不到起点）：${label}`);
  const open = src.indexOf('{', i);
  return src.slice(i, open).replace(/\s+/g, ' ').trim();
}

console.log('\n—— 1. 容器本身 ——');
{
  const sel = selectorOf(css, '.nx-toasts,', '.nx-toasts 规则');
  const body = sliceBalanced(css, '.nx-toasts,', '.nx-toasts 规则');
  t('Toast 容器 pointer-events: none', /pointer-events:\s*none/.test(body), body.trim().slice(0, 60));
  t('容器选择器同时认 .nx-toasts 与 #toasts',
    sel.includes('.nx-toasts') && sel.includes('#toasts'), sel);
  t('容器是 fixed + 右下角（不是跟着文档流走）',
    /position:\s*fixed/.test(body) && /bottom:\s*\d/.test(body));
}

console.log('\n—— 2. 单条不许重新打开 pointer-events ——');
{
  /*
   * 只查"容器有没有 none"是不够的 —— 老代码就是容器 none、孩子 auto，
   * 于是断言全绿而点击照吞。这里反过来：把整份 CSS 里**凡是提到 toast
   * 的规则**都翻一遍，任何一条写出 auto 就是红。
   */
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }))
    .filter((r) => /toast/i.test(r.sel))
    .filter((r) => /pointer-events/.test(r.body));
  const bad = rules.filter((r) => /pointer-events:\s*auto/.test(r.body));
  t('toast 相关规则里没有一条把 pointer-events 开成 auto ★',
    bad.length === 0,
    bad.length ? bad.map((r) => `${r.sel} { ${r.body.trim()} }`).join('；')
      : `查了 ${rules.length} 条带 pointer-events 的 toast 规则`);
  t('确实翻到了规则（不是空跑）', rules.length > 0, `${rules.length} 条`);

  /* 老写法是 `#toasts > *`，专门钉住这一类"孩子选择器" */
  t('没有 `#toasts > *` / `.nx-toasts > *` 这类孩子选择器残留',
    !/#toasts\s*>\s*\*/.test(css) && !/\.nx-toasts\s*>\s*\*/.test(css));
  t('整份 CSS 里 toast 相关规则都没有 pointer-events: auto ★',
    !/[^{}]*toast[^{}]*\{[^{}]*pointer-events:\s*auto/s.test(css));
}

console.log('\n—— 3. 两个壳的类名构造逐一相同（跑真身） ★ ——');
{
  /* 原生壳：`el.className = 'nx-toast toast' + (type === 'info' ? '' : ' ' + type);` */
  const nativeBody = sliceBalanced(shell, 'function toast(', 'shell.js toast');
  const m = nativeBody.match(/el\.className\s*=\s*([^;]+);/);
  t('抽到原生壳的类名表达式', !!m, m ? m[1].trim() : '没抽到');
  /* 表达式里的 type 是形参，这里当自由变量注入 */
  const nativeClass = new Function('type', `return (${m[1]});`);

  /* React 壳：className={...} —— 转成同样的表达式求值 */
  const rSrc = stripComments(toastsSrc);
  const rm = rSrc.match(/className\s*=\s*\{\s*([\s\S]*?)\}\s*>/);
  t('抽到 React 壳的类名表达式', !!rm, rm ? rm[1].replace(/\s+/g, ' ').trim() : '没抽到');
  const reactClass = new Function('t', `return (${rm[1]});`);

  for (const type of ['info', 'ok', 'err']) {
    const a = nativeClass(type).trim().replace(/\s+/g, ' ');
    const b = reactClass({ type }).trim().replace(/\s+/g, ' ');
    t(`type=${type} 两个壳类名相同`, a === b, `原生「${a}」 React「${b}」`);
  }
  t('类名里带 nx-toast（不是只靠遗留的 .toast）★',
    /\bnx-toast\b/.test(nativeClass('info')) && /\bnx-toast\b/.test(reactClass({ type: 'info' })));
  t('info 不多带状态类，ok/err 各自带 ★',
    nativeClass('info').trim() === 'nx-toast toast'
    && /\bok\b/.test(nativeClass('ok')) && /\berr\b/.test(nativeClass('err')));

  /* 反向：构造一个"只挂 .toast"的旧写法，确认上面那组断言抓得住 */
  const old = new Function('t', `return ('toast ' + (t.type === 'info' ? '' : t.type));`);
  t('（自检）旧写法会被这组断言判为不同',
    old({ type: 'info' }).trim() !== nativeClass('info').trim(),
    `旧「${old({ type: 'info' }).trim()}」`);
}

console.log('\n—— 4. React 组件真渲染 ——');
{
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  /*
   * TSX 含 JSX，node 直接跑不了。走 typescript 的 transpileModule
   * （只转语法、不做类型检查）—— 它就在 devDependencies 里，
   * 比引 esbuild 稳（沙箱里 esbuild 的软链经常是断的，
   * drag-payload-test 就是因此改成不依赖构建工具）。
   *
   * 拿不到就**显式跳过**：既不冒充通过，也不能让它崩在半路把后面
   * 第 5 节的守卫一起吃掉。
   */
  let ts = null;
  try { ts = (await import('typescript')).default; } catch { ts = null; }
  if (!ts || typeof ts.transpileModule !== 'function') {
    console.log('⏭  跳过真渲染：拿不到 typescript（未安装，不冒充通过）');
  } else {
    const out = ts.transpileModule(toastsSrc, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    /* ESM 的 import 行去掉；React 通过参数注入 */
    const js = out.replace(/^import[^\n]*\n/gm, '').replace(/export default /g, '');
    const factory = new Function('React', `${js}\n return Toasts;`);
    const Toasts = factory(React);
    const html = renderToStaticMarkup(React.createElement(Toasts, {
      items: [
        { id: 'a', msg: '已保存', type: 'ok' },
        { id: 'b', msg: '出错了', type: 'err' },
        { id: 'c', msg: '普通提示', type: 'info' },
      ],
    }));
    t('渲染出 #toasts 容器', /id="toasts"/.test(html), html.slice(0, 120));
    t('每条提示都带 nx-toast ★', (html.match(/nx-toast/g) || []).length === 3,
      `命中 ${(html.match(/nx-toast/g) || []).length} 次`);
    t('ok / err 状态类都在', /class="[^"]*\bok\b/.test(html) && /class="[^"]*\berr\b/.test(html), html);
    t('文案原样在（msg 没被吞）', html.includes('已保存') && html.includes('出错了'));
  }
}

console.log('\n—— 5. 全量守卫：全仓 CSS 不许有 toast 挡板 ——');
{
  /*
   * `dist/` 是**构建产物**（由 css/ 生成，且 .gitignore 已排除）。
   * 扫它会出一种特别费人的假红：源码改好之后，本地 dist 还是旧的，
   * 于是守卫报「dist/assets/index-BP3R0Ce0.css → .nx-toasts>*」——
   * 报错指向一个**手改了也没用**的文件，真因（没重新构建）一个字没提。
   */
  const isBuildOut = (name) => name === 'dist';
  /* 扫全仓而不是只扫 css/ —— 插件自己的 styles.css 里也可能补一条
     `#toasts > *`，那同样会把提示条变成挡板。 */
  const files = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || isBuildOut(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.css')) files.push(p);
    }
  };
  walk(HERE);
  const bad = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].replace(/\s+/g, ' ').trim();
      if (!/toast/i.test(sel)) continue;
      if (/pointer-events:\s*auto/.test(m[2])) bad.push(`${path.relative(HERE, f)} → ${sel}`);
    }
  }
  t('全仓没有 CSS 把提示条变成点击靶子 ★', bad.length === 0,
    bad.length ? bad.join('；') : `扫了 ${files.length} 个 css`);
  t('守卫确实扫到了文件（不是空跑）',
    files.length >= 5 && files.some((f) => f.endsWith(path.join('css', 'controls.css'))),
    `扫了 ${files.length} 个，含 controls.css：${files.some((f) => f.endsWith(path.join('css', 'controls.css')))}`);
  /* 排除写宽了会把 css/ 一起排除 → 整节空跑而主断言照样绿，
     所以这条钉住"只排除 dist，源码目录不排除"。 */
  t('只排除构建产物，源码目录不排除',
    isBuildOut('dist') && !isBuildOut('css') && !isBuildOut('plugins'));
  /*
   * 旧产物单独看一眼，**只提示不判失败**：dist 不在仓库里（.gitignore），
   * 它是本地没重建的产物。判失败会让人去改一个手改无效的文件。
   */
  const stale = [];
  const walkDist = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walkDist(p);
      else if (e.name.endsWith('.css')) {
        const src = stripComments(fs.readFileSync(p, 'utf8'));
        for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          const sel = m[1].replace(/\s+/g, ' ').trim();
          if (/toast/i.test(sel) && /pointer-events:\s*auto/.test(m[2])) {
            stale.push(`${path.relative(HERE, p)} → ${sel}`);
          }
        }
      }
    }
  };
  walkDist(path.join(HERE, 'dist'));
  if (stale.length) {
    console.log(`ℹ️  dist（本地构建产物，不在仓库里）仍有 ${stale.length} 处 → 重新构建即可，不影响源码判定`);
    console.log(`     ${stale.slice(0, 3).join('；')}${stale.length > 3 ? ' …' : ''}`);
  }
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
