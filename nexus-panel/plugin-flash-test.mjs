/**
 * 插件切换防白闪契约测试（开发用，可删）
 * ============================================================
 * 覆盖三段，每一段都对应一个真实事故：
 *   1. CSS：插件 iframe 初始隐身，靠 .revealed 摘遮罩
 *   2. host.js：显形时机在「适配完成后」，且有兜底不会永久隐身
 *   3. 插件页面：iframe 内的独立文档要有首帧底色（UA 默认画布是白的）
 *
 * 为什么全是静态检查：jsdom 不真正加载 iframe 子文档，
 * iframe 的挂载路径跑不起来（smoke-test 里也注明了这点），
 * 所以这里校验的是"DOM 与 CSS 各写一半"这类结构性问题。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const css = read('css/neumorphism.css');
const host = read('js/host.js');

/* 取出某个选择器对应的声明块（只取第一条，够用且不会被后面的覆盖干扰） */
const ruleOf = (sel) => {
  const i = css.indexOf(sel);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return open < 0 || close < 0 ? null : css.slice(open + 1, close);
};

console.log('\n=== 1. CSS：iframe 挂载期遮罩 ===');
const frameRule = ruleOf('.plugin-frame {');
t('.plugin-frame 存在', !!frameRule);
t('.plugin-frame 初始 opacity 为 0', /opacity\s*:\s*0\s*;/.test(frameRule || ''),
  (frameRule || '').match(/opacity\s*:\s*[^;]+;/)?.[0] || '未声明');
t('.plugin-frame 有淡入过渡，不是硬切', /transition\s*:[^;]*opacity/.test(frameRule || ''));
t('摘遮罩的 .revealed 规则存在',
  /\.plugin-frame\.revealed\s*\{[^}]*opacity\s*:\s*1/.test(css));

console.log('\n=== 2. host.js：显形时机 ===');
t('定义了 revealFrame', /function revealFrame\s*\(/.test(host));

/* 显形必须排在 reAdapt 之后：滤镜挂上前摘遮罩 = 把白底那帧放给用户看。
   取 reAdapt 调用的**后一段**文本来搜，能防止顺序被改回去。 */
const mainMount = host.slice(host.indexOf('async function mount('), host.indexOf('async function mountSettings('));
const iRe = mainMount.indexOf('await reAdapt(instance)');
const iReveal = mainMount.indexOf('revealFrame(');
t('主视图：revealFrame 在 reAdapt 之后', iRe >= 0 && iReveal > iRe,
  `reAdapt@${iRe} → reveal@${iReveal}`);
t('主视图：适配关掉时也显形（else 分支之后）',
  mainMount.indexOf('adapt-disabled') < iReveal);

const settingsMount = host.slice(host.indexOf('async function mountSettings('));
t('设置面板视图也会显形',
  settingsMount.indexOf('await reAdapt(inst)') < settingsMount.indexOf('revealFrame('));

t('有兜底显形，适配卡住不会永久隐身', /armRevealFallback/.test(host));
t('兜底挂在 cleanupFns 上（切插件时清定时器）',
  /cleanupFns\.push\(armRevealFallback/.test(host));
t('失败的挂载路径不会留下隐身 iframe',
  /catch \(err\) \{[\s\S]{0,200}wrap\.remove\(\)/.test(host));

console.log('\n=== 3. 插件页面：首帧底色 ===');
/* iframe 内是独立文档，UA 默认画布是白的 —— 而插件自己的 CSS 是外链，
   加载完成前那几十毫秒就是一帧白。所以要么自己铺底色，要么靠宿主遮罩。
   宿主遮罩对所有插件兜底，这里检查的是"内置插件自己铺得够不够快"。 */

/* 故意留白的例外：demo-light 是「典型浅色第三方插件」的演示样本，
   它必须保持纯白底，才能演示主题适配把它翻成深色 —— 给它铺底色就演不了。 */
const EXEMPT = new Set(['demo-light']);

const pluginDirs = readdirSync(join(HERE, 'plugins'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(HERE, 'plugins', d.name, 'index.html')))
  .map((d) => d.name);

const noBase = [];
const withBase = [];
for (const id of pluginDirs) {
  if (EXEMPT.has(id)) continue;
  const html = read(`plugins/${id}/index.html`);
  const head = html.slice(0, html.indexOf('</head>') + 7) || html;
  const transparent = /background\s*:\s*transparent/.test(head);
  const themed = /background\s*:\s*var\(--(bg|surface)/.test(head);
  const preload = /nexus:preload-bg/.test(head);
  (transparent || themed || preload ? withBase : noBase).push(id);
}
t('每个内置插件页面首帧都有底色', noBase.length === 0,
  noBase.join(', ') || `${withBase.length} 个页面均已铺底`);

/* 内置插件里那些没引 neumorphism.css 的，靠内联脚本读缓存底色；
   脚本必须带 try/catch —— 隔离态（无 allow-same-origin）下
   访问 localStorage 会抛 SecurityError，不兜住会连累后面的解析。 */
const snippets = pluginDirs
  .map((id) => read(`plugins/${id}/index.html`))
  .filter((h) => h.includes('nexus:preload-bg'));
t('读缓存底色的脚本都带 try/catch',
  snippets.length > 0 && snippets.every((s) => /try\s*\{[\s\S]*?preload-bg[\s\S]*?\}\s*catch/.test(s)),
  `${snippets.length} 处`);

console.log('\n=== 4. 出错兜底：插件没渲染出来时不能是一片白 ===');
/* iframe 内是独立文档，UA 默认画布是白的。以下情况内部都画不出东西：
     · 入口文件缺失 / 未构建        · 插件脚本报错，一个节点都没挂上
   此刻露出的是 iframe **元素自己**的背景 —— 若它是 transparent，就是白底。
   注意：不给 .plugin-wrap 加底色（那是永久垫在插件底下，会改掉透明插件的
   观感），但 .plugin-frame 自己必须有 --bg。 */
const frameBlock = ruleOf('.plugin-frame {') || '';
t('.plugin-frame 有主题底色，不是 transparent',
  /background\s*:\s*var\(--bg\)/.test(frameBlock),
  (frameBlock.match(/background\s*:\s*[^;]+;/) || ['未声明'])[0]);
t('该底色不是 transparent（曾写过，出错时就露出白底）',
  !/background\s*:\s*transparent/.test(frameBlock));

/* 空页面不能干等 10s 握手超时 —— 那 10 秒里屏上一片"什么都没有"，
   用户分不清是加载中还是坏了。现在 load 之后会再判一次空。 */
t('load 后会检测空白页面并提前失败',
  /iframe\.addEventListener\('load', onLoad\)/.test(host));
/* 现在 onLoad 里第一件事是记加载耗时（供诊断报告用），之后才判 handshaked。
   所以不再要求 if (handshaked 紧跟在函数名后 —— 只要还在这个回调里即可。 */
t('判空只在未握手时进行（已握手的插件不误伤）',
  /const onLoad = \(\) => \{[\s\S]{0,220}if \(handshaked/.test(host));
t('隔离态读不到 contentDocument 时跳过检测，不误报',
  /catch\s*\{\s*return;\s*\}/.test(host));

console.log('\n=== 5. 首帧脚本同时设 color-scheme ===');
/* iframe 内的表单控件/滚动条不吃父级 color-scheme，
   不设的话深色面板下插件里的下拉框、滚动条仍是浅色的。 */
const withScheme = pluginDirs
  .map((id) => read(`plugins/${id}/index.html`))
  .filter((h) => h.includes('nexus:preload-bg'));
t('首帧脚本设置了 colorScheme',
  withScheme.length > 0 && withScheme.every((h) => /colorScheme/.test(h)),
  `${withScheme.length} 处`);
t('外壳缓存了基调供插件读取',
  /nexus:preload-base/.test(read('js/theme-manager.js')));

console.log('\n=== 6. 加载覆盖层：加载期间要有东西看，且不能挡住就绪的插件 ===');
/* 以前「正在加载…」是直接写进 stage.innerHTML 的，而挂载 iframe 时
   一句 hostEl.innerHTML = '' 就把它抹了 —— 插件却还要等适配完成才淡入，
   中间那段屏上只有 iframe 的底色，看着像卡死。现在改成了覆盖层。 */
const loadingBlock = ruleOf('.plugin-loading {') || '';
t('.plugin-loading 存在', !!loadingBlock);
t('加载层是不透明的（transparent 盖不住下面没显形的 iframe）',
  /background\s*:\s*var\(--bg\)/.test(loadingBlock),
  (loadingBlock.match(/background\s*:\s*[^;]+;/) || ['未声明'])[0]);
t('加载层用绝对定位铺满（是覆盖层，不是占位元素）',
  /position\s*:\s*absolute/.test(loadingBlock) && /inset\s*:\s*0/.test(loadingBlock));
t('有淡出态（成功时先透出插件再摘掉，避免跳变）',
  /\.plugin-loading\.loading-done\s*\{[^}]*opacity\s*:\s*0/.test(css));

t('挂载 iframe 时保留加载层，不再无条件 innerHTML = \'\'',
  /for \(const n of \[\.\.\.hostEl\.children\]\)[\s\S]{0,120}plugin-loading/.test(host));
t('加载层在插件显形时自动退场（连 900ms 兜底那条路径也覆盖）',
  /function revealFrame\([\s\S]{0,400}dismissLoading/.test(host));
t('同页插件（module，没有 iframe）也会收掉加载层',
  /revealFrame\(instance\?\.iframe\);[\s\S]{0,200}dismiss\(\);/.test(host));
t('失败时立即摘掉加载层，别挡着错误框',
  /function showError\([\s\S]{0,300}dismissLoading\(stage, true\)/.test(host));
t('加载层用了主题变量而非写死颜色（换肤要跟着变）',
  /\.plugin-loading \.loading-inner[\s\S]{0,200}var\(--surface-overlay\)/.test(css));
t('加载超过 3s 有补充说明（避免用户以为卡死）',
  /3000/.test(host) && /首次加载可能较慢/.test(host));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
