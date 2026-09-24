/**
 * F11 —— md 渲染去重：md-editor 的预览改用共享的 md-render 服务
 * ============================================================
 *
 * 为什么这一轮存在的理由：
 *   仓库里一度有**两套 md 渲染器**（md-editor 的极简版 + md 插件的
 *   react-markdown 版）。后果不是"多一份代码"，而是**同一段 md 在
 *   编辑预览里显示成 A、在阅读器里显示成 B**。极简版实测缺：引用
 *   （> 被先转义吃掉）、图片（渲染成 !<a>）、有序列表降级、无任务列表、
 *   无删除线、代码块语言丢失、标题无 id、嵌套被拍平，
 *   且 javascript: 协议未过滤。
 *
 * 本测试真跑 renderHtml（从源码里提取出来在 node 里执行），
 * 不是只查"代码里有没有写这一行"。
 *
 * 运行：node md-dedup-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => {
  if (ok) { pass++; console.log(`✅ ${n}`); }
  else { fail++; console.log(`❌ ${n}${extra ? '  → ' + extra : ''}`); }
};

const ed = read('plugins/md-editor/index.js');
const html = read('plugins/md-editor/index.html');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const edC = strip(ed);

/* ============================================================
   0. 把 renderHtml 提取出来真跑
   ============================================================ */
console.log('\n=== 0. 提取 renderHtml ===');

const m = ed.match(/async function renderHtml\(ctx, text\) \{[\s\S]*?\n\}/);
t('能从源码里取出 renderHtml', !!m);
if (!m) { console.log(`\n通过 ${pass} 项，失败 ${fail} 项`); process.exit(1); }

/*
 * 注入一个 stub 代替极简版 render。
 * 它只要能**被认出来**就行 —— 我们要验的是"什么时候用它、什么时候用服务"，
 * 不是极简版本身的输出。用固定标记 `<FALLBACK>` 区分来源。
 */
const renderHtml = new Function('render', `return ${m[0]}`)(() => '<p>FALLBACK</p>');

const srvCtx = (impl) => ({
  services: { call: (id, method, args) => Promise.resolve(impl(id, method, args)) },
});

/*
 * 安全调用：把抛错变成返回值。
 *
 * 直接 await renderHtml(...) 的话，一旦实现里忘了降级（catch 被删、
 * 或改成 rethrow），测试进程会 **unhandled rejection 直接崩掉** ——
 * 崩了不算"红"，而且后面的断言一条都不执行，会掩盖别的问题。
 * 包一层，让它变成一条正常的失败断言。
 */
const safe = async (fn) => {
  try { return { ok: true, value: await fn() }; }
  catch (err) { return { ok: false, err }; }
};

/* ============================================================
   1. 优先服务、失败降级
   ============================================================ */
console.log('\n=== 1. 优先服务 / 失败降级 ===');

t('服务可用 → 用服务结果',
  (await safe(() => renderHtml(srvCtx(() => '<p>SERVICE</p>'), 'x'))).value === '<p>SERVICE</p>');

t('服务**抛错** → 降级（且**不 rethrow**：预览失败不该让编辑器打不开）',
  (await safe(() => renderHtml(srvCtx(() => { throw new Error('桥接超时'); }), 'x'))).value === '<p>FALLBACK</p>');

t('服务返回**空串** → 降级（空串塞进去就是一块空白预览）',
  (await safe(() => renderHtml(srvCtx(() => ''), 'x'))).value === '<p>FALLBACK</p>');

t('服务返回**纯空格** → 降级',
  (await safe(() => renderHtml(srvCtx(() => '   '), 'x'))).value === '<p>FALLBACK</p>');

t('服务返回**非字符串** → 降级',
  (await safe(() => renderHtml(srvCtx(() => ({ html: 'x' })), 'x'))).value === '<p>FALLBACK</p>');

t('服务返回 null → 降级',
  (await safe(() => renderHtml(srvCtx(() => null), 'x'))).value === '<p>FALLBACK</p>');

t('**没有 ctx** → 降级（不抛）',
  (await safe(() => renderHtml(null, 'x'))).value === '<p>FALLBACK</p>');

t('ctx 没有 services.call → 降级',
  (await safe(() => renderHtml({}, 'x'))).value === '<p>FALLBACK</p>');

t('services.call 不是函数 → 降级',
  (await safe(() => renderHtml({ services: { call: 'nope' } }, 'x'))).value === '<p>FALLBACK</p>');

/* 调的是**共享服务**，不是自己 */
let seen = null;
await renderHtml(srvCtx((id, method) => { seen = `${id}.${method}`; return '<p>S</p>'; }), 'x');
t('调的是 md-render.renderToHtml（不是自己的极简版）',
  seen === 'md-render.renderToHtml', String(seen));

/* text 为空也要能渲染，不能抛 */
t('text 为空不抛', typeof (await safe(() => renderHtml(srvCtx(() => '<p></p>'), ''))).value === 'string');

/* ============================================================
   2. 竞态与防抖（源码形式断言 + 破坏验证）
   ============================================================ */
console.log('\n=== 2. 竞态 / 防抖 ===');

/*
 * 走服务后 paint 变异步：打字快时多个请求同时在飞，先发的可能后回来。
 * 不防就会出现"预览显示几秒前的内容，再敲一个键又对了"——
 * 这类时好时坏最难查。
 */
t('有 paintSeq 计数器', /let paintSeq = 0/.test(edC));
t('每次请求领一个号', /const my = \+\+paintSeq/.test(edC));
t('**只认最后一次**的结果（my !== paintSeq 就丢弃）',
  /if \(my !== paintSeq\) return/.test(edC));
t('丢弃发生在赋值**之前**（先赋值再判断＝竞态防护无效）',
  edC.indexOf('if (my !== paintSeq) return') < edC.indexOf('pv.innerHTML = html'),
  '顺序不对');
t('有防抖（每键一次桥接太频繁）', /clearTimeout\(debounce\)/.test(edC) && /setTimeout\(paint, \d+\)/.test(edC));
t('防抖挂在 input 上', /addEventListener\('input', paintSoon\)/.test(edC));

/* ============================================================
   3. 服务方法必须接 ctx —— 最容易漏的一处
   ============================================================ */
console.log('\n=== 3. 服务方法签名（漏了 ctx ＝ 永远降级）===');

/*
 * bootServicePlugin 的方法签名是 (args, ctx)。
 * 写成 render({ text }) 就拿不到 ctx → renderHtml 永远走降级 →
 * 表现是"改了但完全没生效"，而且**没有任何报错**。
 */
t('edit 接第二个参数 ctx', /async function edit\(\{[^}]*\} = \{\}, ctx\)/.test(edC));
t('render 方法接第二个参数 ctx', /async render\(\{ text \} = \{\}, ctx\)/.test(edC));
t('render 方法走 renderHtml（不是自己再渲一遍）',
  /async render\(\{ text \} = \{\}, ctx\) \{ return renderHtml\(ctx, text\); \}/.test(edC));

/* ============================================================
   4. 预览样式（服务路径带 .markdown-body 包裹）
   ============================================================ */
console.log('\n=== 4. 预览样式 ===');

/*
 * 服务返回的 HTML 带 .markdown-body 包裹，降级路径是裸标签。
 * 已有的 h1/code/pre/blockquote 是后代选择器，两条路径都命中；
 * 这里补的是以前**完全没有**的：表格、列表、图片、hr、del、勾选框。
 */
for (const [name, re] of [
  ['表格', /\.preview table \{/],
  ['表头单元格', /\.preview th, \.preview td \{/],
  ['表头底色', /\.preview th \{ background:/],
  ['无序/有序列表', /\.preview ul, \.preview ol \{/],
  ['图片限宽（不限宽＝大图撑破面板）', /\.preview img \{ max-width: 100%/],
  ['分隔线', /\.preview hr \{/],
  ['删除线', /\.preview del \{/],
  ['任务列表勾选框', /\.preview input\[type="checkbox"\]/],
]) t(`补上了 ${name} 的样式`, re.test(html));

/* ============================================================
   5. 没有再出现第三套渲染器
   ============================================================ */
console.log('\n=== 5. 去重 ===');

t('md-editor 里仍保留极简版 render（**必须留作降级**，不能删）',
  /^function render\(md\)/m.test(edC));
t('md-editor 不再有第二套"预览用"渲染（paint 直接调 renderHtml）',
  /pv\.innerHTML = html/.test(edC) && !/pv\.innerHTML = render\(/.test(edC));
t('md-render 服务仍在注册表里', /id: 'md-render'/.test(read('plugins/registry.js')));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
