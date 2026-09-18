/**
 * 插件入口 × 构建模式 的一致性约束
 * ============================================================
 * 起因：试图把 Vite 模式下的 home 从 iframe 迁成同页（module）时，
 * 发现 `type: noBuild ? 'module' : 'iframe'` **不是随意写的**，
 * 而是被打包机制逼出来的必然选择。这些约束此前没有任何测试守护，
 * 于是"看起来只是改一行 registry"的迁移，实际会让插件 404。
 *
 * 事实链（逐条核实过源码，不是推测）
 * ------------------------------------------------------------
 * 1. 同页插件靠 `import(/* @vite-ignore *\/ ...)` 运行时动态加载
 *    —— @vite-ignore 让 Vite **跳过静态分析**，因此：
 *      · 不会生成对应 chunk
 *      · 产物里的 import 路径**不会被重写**
 * 2. 于是该入口文件必须在 dist 里**原样存在**，否则运行时 404。
 * 3. vite.config.ts 的 copyPlainPlugins 正是为此存在：
 *      · 拷贝 registry.js（注释写明"运行时动态加载"）
 *      · 拷贝 PLAIN_PLUGINS 三个 demo 的整个目录
 *      · 补拷 mindmap/editor（第三方原生资源）
 * 4. 但**普通插件目录不在拷贝名单里** —— 它们的 index.html 是
 *    Vite 的 rollup input，靠打包产出，源码不进 dist。
 * 5. 所以：Vite 构建后，dist 里**没有** plugins/<id>/index.js
 *    （除非该插件在 PLAIN_PLUGINS 里）。
 * 6. 结论：**同页 module 只在无构建模式下成立**。那时源码被浏览器
 *    直接加载，`../../js/plugin-sdk.js` 这类相对路径真实有效；
 *    Vite 构建后目录结构变了，只有被打包的入口才能解析依赖。
 *
 * 解法（已落地，方案 B：import.meta.glob）
 * ------------------------------------------------------------
 * js/plugin-entries.js 里写了 import.meta.glob('../plugins/&ast;/module.{js,mjs,ts,tsx}')。
 *（上面用 &ast; 是因为 glob 里的星号加斜杠会提前闭合块注释）
 * Vite 在**构建期静态展开**它：为每个匹配文件生成 chunk 并重写路径，
 * 运行时只是一句动态 import —— 于是同页插件在 Vite 生产构建下也能加载，
 * 且新增插件只要符合命名约定就自动纳入，不需要维护显式入口表。
 *
 * 于是约束从"Vite 下必须是 .html"变成：
 *
 *   Vite 模式下的 entry 必须是 .html（iframe 入口）
 *   **或** module.{js,mjs,ts,tsx}（被 glob 收录的同页入口）
 *
 * 本测试钉住这条新约束 —— 用别的名字（如 index.tsx）仍然会 404。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); }
};

const registry = src('plugins/registry.js');
const viteCfg = src('vite.config.ts');
const host = src('js/host.js');

console.log('=== 1. 事实：同页插件是运行时动态 import（Vite 不打包）===');
/*
 * 这两条记录的是**改造前**的事实，现已改变，作为"为什么要有 glob"的
 * 历史注脚保留断言：确认 @vite-ignore 的动态 import 确实只剩下的
 * registry 那一处（它靠 copyPlainPlugins 原样拷贝，所以能跑）。
 */
t('module 挂载已改为 loadModuleEntry（不再 @vite-ignore 直连）',
  /loadModuleEntry\(manifest\.entry\)/.test(host));
/*
 * 只查**代码**，不查注释 —— 注释里还留着 "@vite-ignore 会怎样" 的说明，
 * 直接全文匹配会被注释命中（断言恒假）。
 * 逐行剔掉注释再匹配，这是"别把说明当成实现"的老教训。
 */
t('mountModule 内的**代码**已无 @vite-ignore', (() => {
  const i = host.indexOf('async function mountModule');
  const seg = host.slice(i, i + 1400);
  return seg.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .every((l) => !l.includes('@vite-ignore'));
})());
t('registry 同样是 @vite-ignore 动态 import',
  /import\(\/\* @vite-ignore \*\/ new URL\('\.\.\/plugins\/registry\.js'/.test(host));

console.log('\n=== 2. 事实：因此有拷贝补偿机制 ===');
t('vite.config 会原样拷贝 registry.js',
  /copyInto\(PATHS\.registry, resolve\(out, 'registry\.js'\)\)/.test(viteCfg));
t('拷贝发生在 closeBundle（打包之后，不会被覆盖）',
  /apply: 'build'[\s\S]{0,120}closeBundle/.test(viteCfg));
t('PLAIN_PLUGINS 的插件整目录拷贝',
  /for \(const name of PLAIN_PLUGINS\)[\s\S]{0,160}copyInto\(src/.test(viteCfg));

console.log('\n=== 3. 核心约束：Vite 模式下插件入口必须是 HTML ===');
/*
 * 这是本测试存在的理由。
 * Vite 模式（!noBuild）下，插件 entry 必须是 .html ——
 * 因为只有 HTML 才是 rollup input，会被打包、依赖才能解析。
 * 改成 .js / .tsx 的 module 入口会在 dist 里不存在 → 404。
 */
const entries = [...registry.matchAll(/entry:\s*(noBuild\s*\?\s*'([^']+)'\s*:\s*'([^']+)')/g)]
  .map((m) => ({ noBuild: m[2], vite: m[3] }));
t('registry 里存在三元 entry（两种模式各一份）', entries.length > 0);

/*
 * 新约束：Vite 下 entry 必须是 .html（iframe）或 module.*（glob 收录）。
 *
 * 用别的名字（比如 index.tsx / main.tsx）**照样 404** ——
 * glob 只匹配 module.{js,mjs,ts,tsx}，这个命名约定是硬约束，
 * 所以必须钉住。
 */
const MODULE_RE = /module\.(js|mjs|ts|tsx)$/;
const allowedVite = (e) => e.endsWith('.html') || MODULE_RE.test(e);
const badVite = entries.filter((e) => !allowedVite(e.vite));
t('Vite 模式的 entry 都是 .html 或 module.*（否则产物里没有该文件）',
  badVite.length === 0,
);
if (badVite.length) {
  for (const e of badVite) console.log(`     ↳ 违规: ${e.vite}`);
}
t('module.* 入口都放在 plugins/<id>/ 下（glob 的匹配范围）',
  entries.filter((e) => MODULE_RE.test(e.vite))
    .every((e) => /^\.\/plugins\/[^/]+\/module\./.test(e.vite)));

console.log('\n=== 3b. glob 机制本身 ===');
const pe = src('js/plugin-entries.js');
t('用了 import.meta.glob（Vite 构建期静态展开）', /import\.meta\.glob\(/.test(pe));
t('glob 模式匹配 module.{js,mjs,ts,tsx}',
  /import\.meta\.glob\('\.\.\/plugins\/\*\/module\.\{js,mjs,ts,tsx\}'/.test(pe));
t('eager:false（懒加载 chunk，不打开就不下载）', /eager: false/.test(pe));
t('无构建模式下 try/catch 兜住（import.meta.glob 未定义不炸）',
  /try \{[\s\S]{0,120}import\.meta\.glob[\s\S]{0,80}\} catch \{/.test(pe));
t('Vite 下未收录时给出**明确错误**（而不是费解的 404）',
  /同页入口未被构建期 glob 收录/.test(pe));
t('无构建模式退回动态 import（行为一字不改）',
  /return await import\(\/\* @vite-ignore \*\//.test(pe));

console.log('\n=== 3c. 接线：host.js 走 loadModuleEntry ===');
t('host.js 引入 loadModuleEntry',
  /import \{ loadModuleEntry \} from '\.\/plugin-entries\.js'/.test(host));
t('两处 module 加载都走 loadModuleEntry（主视图 + 设置面板）',
  (host.match(/loadModuleEntry\(manifest\.entry\)/g) || []).length >= 2);

console.log('\n=== 4. 核心约束：type 与 entry 的匹配 ===');
/*
 * **本轮（D1）发现的事实变化**：远端 registry 已把 type 从
 * `noBuild ? 'module' : 'iframe'` 逐个改成**常量**，settings 是最后一个。
 * 把它改成常量 'module' 后，registry 里**不再有任何**随模式切换的 type。
 *
 * 这是"嵌合推进"的直接后果：以前"Vite 下只能 iframe"是被打包机制逼的，
 * 方案 B（import.meta.glob）解掉之后，同页与否就不再由模式决定，
 * 而是按插件**逐个**决定 —— 所以 type 变成常量是合理的。
 *
 * 但 **entry 仍随模式切换**：home / settings 无构建下走 index.js（原生 JS），
 * Vite 下走 module.tsx（React）。两入口并存，见 registry 注释。
 *
 * 下面的断言按**新现实**重写。刻意不钉"三元 type 必须存在"——
 * 那会在每次推进嵌合时假红，逼人改回去。
 */
const typeTriples = [...registry.matchAll(/type:\s*noBuild\s*\?\s*'(\w+)'\s*:\s*'(\w+)'/g)]
  .map((m) => ({ noBuild: m[1], vite: m[2] }));
const entryTriples = [...registry.matchAll(/entry:\s*noBuild\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)]
  .map((m) => ({ noBuild: m[1], vite: m[2] }));

/*
 * 三元 type 若**又出现**（有人加回双模插件），两侧的语义仍要成立。
 * 用 every 而非断言 >0：空集合时 every 为真，不会假红。
 */
t('三元 type 若存在：无构建侧必须是 module',
  typeTriples.every((x) => x.noBuild === 'module'));
t('三元 type 若存在：Vite 侧必须是 iframe',
  typeTriples.every((x) => x.vite === 'iframe'));
t('entry 三元仍存在（home/settings 两入口并存）',
  entryTriples.length >= 2);
t('entry 三元：两侧都不能是 .html（module 会去 import 它）',
  entryTriples.every((x) => !x.noBuild.endsWith('.html') && !x.vite.endsWith('.html')));

/*
 * 真正的核心约束（不随模式变化，永远成立）：
 *   module 型 → entry 必须是脚本
 *   iframe 型 → entry 必须是 .html
 * 这条比"三元"重要得多 —— 它直接决定会不会 404。
 */
/*
 * 切块方式：按 `id: 'xxx'` 定位每个条目，边界到下一个条目为止。
 *
 * **不能用 `split(/\n  \{\n/)`** —— 实测切出来块数不对（缩进/空行
 * 不完全一致），于是 every 落在错误的块上，断言**恒真**。
 * 这正是破坏2（settings entry 改 .html）没被抓到的原因：
 * 断言写了，但它根本没看对对象。
 */
function entriesByBlock() {
  const marks = [...registry.matchAll(/\{\s*id:\s*'([^']+)'/g)]
    .map((m) => ({ id: m[1], at: m.index }));
  return marks.map((mk, i) => ({
    id: mk.id,
    block: registry.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : registry.length),
  }));
}
const blocks = entriesByBlock();
t('切块数与插件数一致（切对了才谈后面）',
  blocks.length >= 12 && blocks.every((b) => b.id));
t('所有 iframe 型插件的 entry 都是 .html',
  blocks.every((b) => {
    const ty = b.block.match(/type:\s*'(\w+)'/);
    if (!ty || ty[1] !== 'iframe') return true;
    const en = b.block.match(/entry:\s*(?:noBuild\s*\?\s*'[^']+'\s*:\s*)?'([^']+)'/);
    return !en || en[1].endsWith('.html');
  }));
t('所有 module 型插件的 entry 都不是 .html',
  blocks.every((b) => {
    const ty = b.block.match(/type:\s*'(\w+)'/);
    if (!ty || ty[1] !== 'module') return true;
    /* module 型：取三元 Vite 侧，没有三元就取常量 */
    const tri = b.block.match(/entry:\s*noBuild\s*\?\s*'[^']+'\s*:\s*'([^']+)'/);
    const en = tri || b.block.match(/entry:\s*'([^']+)'/);
    return !en || !en[1].endsWith('.html');
  }));
/*
 * 划时代的一条：home 已经**两种模式都是 module**。
 * 钉住它，防止被改回 iframe 而没人发现（那等于嵌合又退回去）。
 */
t('home 在 Vite 模式下也是 module（首个完成嵌合的插件）',
  /id: 'home',[\s\S]{0,600}?type: 'module',/.test(registry));

/*
 * 下面两条是**破坏验证逼出来的**。
 *
 * 只改 type（Vite 下改成 module）、不动 entry 时，上面的断言
 * 一条都不红 —— 因为 `every` 对空数组/缩小后的集合照样为 true。
 * 于是"Vite 下 module + .html 入口"这种**自相矛盾**的配置能溜过去：
 * module 模式会去 import 一个 .html，必然失败。
 *
 * 教训：用 every 做断言时，必须同时钉住**集合规模**，
 * 否则"被检查的对象消失了"会被当成"检查通过"。
 */
/*
 * home 改成"两种模式都 module"后，三元 type 会比三元 entry 少一个
 * （它的 entry 仍是三元，type 变成常量）。所以这里钉的是：
 * **三元 entry 数 ≥ 三元 type 数**，且差出来的那些必须 type 是常量 'module'。
 * 仍然是为了防止"被检查的对象消失"被当成通过。
 */
t('entry 条目没有凭空消失（集合规模钉住）',
  entryTriples.length > 0 && entries.length >= entryTriples.length);
/*
 * 常量 'module' 的条目里，部分是"两种模式都同页"（home），
 * 部分是 demo 类本来就单模。这里钉的是**至少有一个**是双模同页的，
 * 并且它带有说明为什么能这么做（否则下次又会有人以为是笔误改回去）。
 */
t('存在"两种模式都 module"的条目（嵌合已落地）',
  (registry.match(/\n\s*type: 'module',/g) || []).length >= 1);
t('该条目注释说明了靠 glob 才能在 Vite 下同页',
  /id: 'home',[\s\S]{0,400}?import\.meta\.glob/.test(registry));
/*
 * 本轮（D1）：settings 成为第二个嵌合插件。
 *
 * 选它的理由写在 registry 注释里：它是**内置插件**，而且**本来就是双模**
 * （无构建下走 index.js 同页），所以同页这条路对它不是新东西。
 */
t('settings 两种模式都是 module（第二个嵌合插件）',
  /id: 'settings',[\s\S]{0,900}?type: 'module',/.test(registry));
t('settings 的 Vite entry 是 module.tsx（符合 glob 命名约定）',
  /id: 'settings',[\s\S]{0,900}?entry:\s*noBuild\s*\?\s*'[^']+'\s*:\s*'[^']*\/module\.tsx'/.test(registry));
t('settings 的注释说明了 iframe 入口刻意保留',
  /id: 'settings',[\s\S]{0,900}?刻意保留/.test(registry));
t('至少两个插件完成嵌合（home + settings）',
  (registry.match(/\n\s*type: 'module',/g) || []).length >= 1
  && /id: 'home',[\s\S]{0,600}?type: 'module',/.test(registry)
  && /id: 'settings',[\s\S]{0,900}?type: 'module',/.test(registry));

/*
 * **同页嵌合最容易踩的坑：iframe 的 CSS 搬到同页会污染宿主**
 *
 * settings.css 里有一条 `#root { display:flex; flex-direction:column }`，
 * 那是给 iframe 内部重建滚动链用的。但同页插件与宿主**共享全局样式表**，
 * 而 React 外壳的根容器**就叫 #root**（src/main.tsx）——
 * 于是它会命中宿主自己，把整个外壳改成 flex 列。
 *
 * 所以同页入口**必须不引入** settings.css。钉住这条，
 * 防止有人"顺手把 main.tsx 的 import 抄过来"。
 */
{
  const modSrc = fs.readFileSync(path.join(HERE, 'plugins/settings/module.tsx'), 'utf8');
  /* 剔注释后再查 import —— 注释里反复提到 settings.css，直接搜会误命中 */
  const code = modSrc
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  t('同页入口没有 import settings.css（否则会污染宿主 #root）',
    !/import\s+['"].*settings\.css/.test(code));
  t('注释里写明了为什么不引（不是忘了引）',
    /刻意不引入 settings\.css/.test(modSrc));
  t('注释点出了 #root 会被宿主命中这个具体风险',
    /React 外壳的根容器/.test(modSrc) || /就叫 #root/.test(modSrc));
  t('说清了同页下滚动由 #stage-scroll 负责（不需要补丁）',
    /#stage-scroll/.test(modSrc));
  t('体感差异已写明（分页条会随内容滚）',
    /分页条/.test(modSrc));
}

t('module 型插件的 entry 一定不是 .html（module 会去 import 它）', (() => {
  /* 找出所有"不管什么模式都是 module"的条目：type 为常量 'module' */
  const constModule = [...registry.matchAll(/type:\s*'(module)'/g)].length;
  if (!constModule) return true;   // 没有常量 module 条目，无矛盾
  /* 有常量 module 时，其 entry 必须是脚本而非 HTML */
  const bad = [...registry.matchAll(
    /type:\s*'module',[\s\S]{0,200}?entry:\s*(?:noBuild\s*\?\s*'[^']+'\s*:\s*)?'([^']+\.html)'/g,
  )];
  return bad.length === 0;
})());

console.log('\n=== 5. 反例：PLAIN_PLUGINS 是唯一的例外 ===');
/*
 * demo-module 这类在无构建与 Vite 下都是同页 ——
 * 因为它们被整目录原样拷进 dist，源码结构保持不变。
 * 所以"整目录拷贝"是同页嵌合在 Vite 下的**唯一**可行路径。
 */
const cfg = src('config/nexus.config.mjs');
const plain = cfg.match(/export const PLAIN_PLUGINS = \[([^\]]*)\]/);
t('PLAIN_PLUGINS 有定义', !!plain);
t('名单里的插件确实在 plugins/ 下', (() => {
  if (!plain) return false;
  const ids = [...plain[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return ids.length > 0 && ids.every((id) => fs.existsSync(path.join(HERE, 'plugins', id)));
})());

console.log('\n=== 6. 文档化：原因必须写在代码里 ===');
t('registry 头部说明了双实现', /各写了两份实现/.test(registry));
t('vite.config 注释说明了不能整目录拷贝普通插件',
  /整目录原样拷贝会盖掉打包产物/.test(viteCfg));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
