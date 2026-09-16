/**
 * 通用弹窗测试
 * ============================================================
 * 之前弹窗散在四处各写各的（shell / project-group/ui.tsx / mindmap/panels.js
 * 以及 23 处原生 confirm & alert & prompt），现在收敛成 js/dialog.js 一套。
 *
 * 这里盯三件事：
 *   1. 行为对不对 —— 返回值、Esc、点遮罩、校验、焦点
 *   2. 样式接没接上 —— 引了 JS 的地方必须也引了 CSS（否则又是一个"裸 div"）
 *   3. 原生调用清干净没有 —— 23 处要全部换成这一套
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

const dom = new JSDOM('<!doctype html><html><body><button id="opener">open</button></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.location = dom.window.location;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame
  ?? ((f) => setTimeout(f, 0));

const { confirm, alert, prompt, open, isOpen, closeTop } = await import('./js/dialog.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* 关闭后遮罩会留 160ms 做淡出，所以取"最新的那个"而不是第一个 ——
   取第一个会拿到正在淡出的旧弹窗。这也是真实场景的写法。 */
const masks = () => [...document.querySelectorAll('.nx-mask:not(.closing)')];
const btns = (i = 0) => masks()[i]?.querySelectorAll('.nx-btn') ?? [];
const click = (b) => b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const find = (label) => [...btns()].find((b) => b.textContent === label);
const esc = () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown',
  { key: 'Escape', bubbles: true }));

console.log('=== 1. confirm ===');
{
  const p = confirm({ message: '确定删除？', danger: true });
  t('弹窗已挂载', masks().length === 1);
  t('有标题（默认「确认」）', /确认/.test(masks()[0].querySelector('.nx-dlg-title').textContent));
  t('消息是文本节点（不是 HTML，天然免疫 XSS）',
    masks()[0].querySelector('.nx-dlg-msg').textContent === '确定删除？');
  t('两个按钮：取消 / 确定', btns().length === 2);
  t('确定按钮带 danger 变体', !!masks()[0].querySelector('.nx-btn.danger'));
  click(find('确定'));
  t('点确定 resolve true', await p === true);
}
{
  const p = confirm({ message: 'x' });
  click(find('取消'));
  t('点取消 resolve false', await p === false);
}
{
  const p = confirm({ message: 'x' });
  esc();
  t('按 Esc resolve false（等同取消）', await p === false);
}

console.log('\n=== 2. alert ===');
{
  const p = alert({ message: '操作完成', type: 'ok' });
  t('只有一个按钮', btns().length === 1);
  t('默认按钮文案「知道了」', btns()[0].textContent === '知道了');
  t('type=ok 带上状态色 class', !!masks()[0].querySelector('.nx-dlg-msg.nx-ok'));
  click(btns()[0]);
  await p;
  t('resolve 后弹窗移除', masks().length === 0);
}

console.log('\n=== 3. prompt ===');
{
  const p = prompt({ message: '起个名字', defaultValue: '默认' });
  const input = masks()[0].querySelector('.nx-input');
  t('有输入框', !!input);
  t('带默认值', input.value === '默认');
  input.value = '改过了';
  click(find('确定'));
  t('返回输入的值', await p === '改过了');
}
{
  const p = prompt({ message: 'x' });
  click(find('取消'));
  t('取消返回 null（不是空字符串，调用方能区分）', await p === null);
}
{
  /* 校验不通过时不能关，且要显示错误文案 */
  const p = prompt({
    message: '名字', defaultValue: '',
    validate: (v) => (v.trim() ? null : '不能为空'),
  });
  click(find('确定'));
  await new Promise((r) => setTimeout(r, 0));
  t('校验不通过时弹窗还在', masks().length === 1);
  t('显示错误文案', masks()[0].querySelector('.nx-dlg-err').textContent === '不能为空');
  const input = masks()[0].querySelector('.nx-input');
  input.value = 'ok';
  click(find('确定'));
  t('改对后能提交', await p === 'ok');
}

console.log('\n=== 4. 栈与键盘 ===');
{
  const p1 = confirm({ message: '第一层' });
  const p2 = confirm({ message: '第二层' });
  t('两层同时存在', masks().length === 2);
  t('isOpen 为 true', isOpen());
  t('第二层 z-index 更高（嵌套时不至于被盖住）',
    Number(masks()[1].style.zIndex) > Number(masks()[0].style.zIndex));
  esc();
  t('Esc 只关最上层', masks().length === 1);
  t('最上层 resolve 了', await p2 === false);
  t('下层还在 pending', p1 instanceof Promise);
  closeTop();
  t('closeTop 关掉剩下的', await p1 === false);
  t('栈空后 isOpen 为 false', !isOpen());
}

console.log('\n=== 5. open（自定义内容）===');
{
  const node = document.createElement('div');
  node.textContent = '自定义内容';
  const p = open({ title: '自定义', body: [node], actions: [{ label: '关闭' }, { label: '提交', value: 42, primary: true }] });
  t('自定义节点被放进 body', masks()[0].querySelector('.nx-dlg-body').textContent === '自定义内容');
  click(find('提交'));
  t('返回 action.value', await p === 42);
}

console.log('\n=== 6. 源码契约 ===');
const src = read('js/dialog.js');
t('所有文案走 textContent（不拼 HTML 字符串）',
  /textContent/.test(src) && !/innerHTML/.test(src));
t('点遮罩关闭，但点弹窗内部不关',
  /e\.target === mask/.test(src) && /stopPropagation/.test(src));
t('有关闭后恢复焦点的处理', /prevFocus/.test(src));
t('尊重 Esc 只关最上层', /stack\[stack\.length - 1\]/.test(src));

console.log('\n=== 7. 样式必须接上（防"裸 div"）===');
const css = read('css/dialog.css');
t('CSS 定义了 .nx-mask 与 .nx-dlg',
  /\.nx-mask\s*\{/.test(css) && /\.nx-dlg\s*\{/.test(css));
/* 底板必须是 --surface-overlay：玻璃主题下 --surface 只有 7% 白，
   后面的界面全透上来，弹窗就没法读了（这是踩过的坑） */
t('弹窗底板用 --surface-overlay（不是 --surface）',
  /\.nx-dlg\s*\{[^}]*background\s*:\s*var\(--surface-overlay/.test(css)
  && !/\.nx-dlg\s*\{[^}]*background\s*:\s*var\(--surface\)/.test(css));
t('主按钮文字色用 --badge-fg（不写死 #fff）',
  /\.nx-btn\.primary\s*\{[^}]*color\s*:\s*var\(--badge-fg/.test(css)
  && !/\.nx-btn\.primary\s*\{[^}]*#fff/i.test(css));
t('按钮边框用 --divider（不是风格开关 --border）',
  /\.nx-btn\s*\{[^}]*border\s*:\s*[^;]*var\(--divider/.test(css));
t('内容区可滚动且写了 min-height:0',
  /\.nx-dlg-body\s*\{[\s\S]{0,160}min-height\s*:\s*0/.test(css));
t('尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(css));

/* 引了 JS 的地方必须也引了 CSS —— 插件是独立文档，漏引就是裸 div */
const walk = (dir, out = []) => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(d.name)) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const files = walk(HERE);
const jsUsers = files.filter((f) => /\.(jsx?|tsx?)$/.test(f)
  && /dialog\.js|components\/Dialog/.test(readFileSync(f, 'utf8'))
  && !f.includes('js/dialog.js') && !f.endsWith('dialog-test.mjs'));
/* 外壳主文档（src/、js/shell.js）由 index.html 加载 css/neumorphism.css，
   那份文件里 @import 了 dialog.css —— 这类模块算已接上。
   插件在独立文档里，只有自己 @import 的那份 CSS 才算数。 */
const shellSheetHasIt = /dialog\.css/.test(read('css/neumorphism.css'));

/** 顺着 @import 链找，最多 3 层（够用，也防成环） */
function reachesDialogCss(file, depth = 0) {
  if (depth > 3) return false;
  const text = readFileSync(file, 'utf8');
  if (/dialog\.css/.test(text)) return true;
  for (const m of text.matchAll(/@import\s+url\(['"]?([^'")]+)['"]?\)/g)) {
    const next = join(dirname(file), m[1]);
    if (existsSync(next) && reachesDialogCss(next, depth + 1)) return true;
  }
  return false;
}
const missCss = jsUsers.filter((f) => {
  const rel = f.slice(HERE.length + 1).replace(/\\/g, '/');
  if (shellSheetHasIt && /^(src|js)\/|^[^/]*\.(jsx?|tsx?)$/.test(rel)) return false;
  /* 插件：样式可能由 .css 引入，也可能由 **JS/TS 里的 import 'xx.css'**
     引入（settings 就是 main.tsx 里 import '../../css/neumorphism.css'），
     两条路都要算。 */
  const cssEntries = new Set();
  let dir = dirname(f);
  for (let i = 0; i < 4; i++) {
    const here = walk(dir);
    const cssHere = here.filter((c) => /\.css$/.test(c));
    if (cssHere.length || i === 3) {
      for (const c of cssHere) cssEntries.add(c);
      // JS/TS 侧引入的样式（相对该 JS 文件解析）
      for (const j of here.filter((c) => /\.(jsx?|tsx?)$/.test(c))) {
        for (const m of readFileSync(j, 'utf8')
          .matchAll(/import\s+['"]([^'"]+\.css)['"]/g)) {
          const p2 = join(dirname(j), m[1]);
          if (existsSync(p2)) cssEntries.add(p2);
        }
      }
      break;
    }
    dir = dirname(dir);
  }
  if (cssEntries.size) return ![...cssEntries].some((c) => reachesDialogCss(c));
  return true;
});
t('用到弹窗的模块都能拿到 dialog.css', missCss.length === 0,
  missCss.map((f) => f.slice(HERE.length + 1)).join(', ') || `${jsUsers.length} 处均已接上`);

console.log('\n=== 8. 原生弹窗是否清干净 ===');
const SKIP = /kityminder\.core\.min\.js|node_modules|\.test\.|tests\/|dialog-test\.mjs/;
const native = [];
for (const f of files) {
  if (!/\.(jsx?|tsx?)$/.test(f)) continue;
  const rel = f.slice(HERE.length + 1).replace(/\\/g, '/');
  if (SKIP.test(rel)) continue;
  /* js/dialog.js 自身的导出就叫 confirm/alert/prompt，不算原生调用 */
  if (rel === 'js/dialog.js') continue;
  const text = readFileSync(f, 'utf8');
  /* 只找真正的调用：window.confirm( / confirm( / window.alert( / alert(
     排除注释里提到的（说明里允许提"以前用 window.confirm"） */
  for (const m of text.matchAll(/(?:window\.)?(confirm|alert|prompt)\s*\(/g)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const line = text.slice(lineStart, m.index);
    if (/^\s*(\*|\/\/|\/\*|#|\/)/.test(line)) continue;   // 注释行
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    /* 排除紧跟在 . 后面的（如 dialog.confirm(）*/
    if (/[.\w]$/.test(before.replace(/window\.$/, ''))) continue;
    /* 排除我们自己的 API：await confirm( / await prompt( / const x = alert( ...
       原生调用的特征是**没有 await** 且带 window. 前缀或直接裸调 */
    if (/await\s+$/.test(before)) continue;
    native.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
  }
}
t('业务代码里不再有原生 confirm/alert/prompt',
  native.length === 0, native.slice(0, 6).join(', ') || '已全部替换');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
