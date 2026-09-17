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
 * 这个测试把上面第 6 条钉住，防止将来有人"顺手把 iframe 改成
 * module"而不知道会 404。
 *
 * 如果将来要让 Vite 模式也支持同页嵌合，必须先解决打包
 * （见文件末尾的"解法方向"），并**同步更新本测试**。
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
t('mountModule 用 @vite-ignore 动态 import',
  /import\(\/\* @vite-ignore \*\/ resolveEntry\(manifest\.entry\)\)/.test(host));
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
const badVite = entries.filter((e) => !e.vite.endsWith('.html'));
t('Vite 模式的所有 entry 都是 .html（否则 dist 里没有该文件）',
  badVite.length === 0,
);
if (badVite.length) {
  for (const e of badVite) console.log(`     ↳ 违规: ${e.vite}`);
}

console.log('\n=== 4. 核心约束：type 随模式切换 ===');
/*
 * `noBuild ? 'module' : 'iframe'` —— 不是历史遗留，是必然：
 * · 无构建：源码直出，同页 module 可行（相对路径有效）
 * · Vite  ：只有 iframe（HTML 入口被打包）能保证依赖解析
 */
const typeTriples = [...registry.matchAll(/type:\s*noBuild\s*\?\s*'(\w+)'\s*:\s*'(\w+)'/g)]
  .map((m) => ({ noBuild: m[1], vite: m[2] }));
t('存在随模式切换的 type', typeTriples.length > 0);
t('无构建模式走 module（同页嵌合）',
  typeTriples.every((x) => x.noBuild === 'module'));
t('Vite 模式走 iframe（HTML 入口才被打包）',
  typeTriples.every((x) => x.vite === 'iframe'));

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
t('三元 type 的数量与三元 entry 一致（没有被偷偷改掉）',
  typeTriples.length === entries.length && typeTriples.length > 0);
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

if (fail) {
  console.log(`
解法方向（若将来要让 Vite 模式也支持同页嵌合，三选一）：

  A. 显式入口表 —— 把同页插件入口也写进 buildInputs，
     并去掉 @vite-ignore 让 Vite 重写路径。
     代价：运行时热插拔能力受限（入口要预先知道）。

  B. import.meta.glob（业界标准）——
     import.meta.glob('../plugins/*/entry.js') 会让 Vite
     为每个文件生成 chunk 并重写路径，保留动态性。
     代价：新增插件需符合 glob 命名约定。

  C. 保持现状 —— Vite 下继续 iframe，只在无构建模式嵌合。
     代价：嵌合的收益（主题继承、零桥接、owned 生效）
     只在无构建模式拿到。

无论选哪个，本测试都要同步更新 —— 它是"当前事实"的快照。`);
}
process.exit(fail ? 1 : 0);
