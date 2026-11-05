/**
 * 运行时插件加载守护（runtime plugins）
 * ============================================================
 * 背景：iframe 插件从"打进主程序（dist/plugins/）"迁到"独立构建 +
 * 运行时加载（runtime-plugins/ + asset 协议）"。这次迁移的收益是
 * 「改插件前端不重编主程序」，代价是新增了一条完整的加载链路：
 *
 *   registry.runtime:true
 *     → build-plugins.mjs 独立构建（runtime-plugins/<id>/）
 *     → tauri.conf.json bundle.resources 收进安装包（$RESOURCE）
 *     → host.js resolveFrameSrc 三态分流 + convertFileSrc + 防闪 query
 *     → 插件 index.html preload 读 query 铺首帧底色
 *
 * 链条上任何一环断了，症状都是「侧边栏点了插件名，主区域空白 +
 * 10s 握手超时」—— 完全看不出是哪一环。所以每一环都要有钉子。
 *
 * 第 38/39 轮更正（三态同文件）：12 个 iframe 插件源码已迁出主仓，
 * 现在 prod / dev / plain 三态加载的是**同一份** runtime-plugins/ 产物：
 *   prod   → dist/ 内同源相对路径（runtimeFrameUrl）
 *   dev    → vite.config.ts 的 serveRuntimePlugins() 中间件原样直出
 *   plain  → 相对 location 解析（Node / 无构建态）
 * registry 的 entry 已改指产物；源码目录退场后 build-plugins.mjs 走
 * retired 态（源码缺席时 exit 1，不假装「构建 0 个也算成功」）。
 *
 * 分两层（与 handshake-test 同一思路）：
 *   1. 源码层：各环节的接线与标记完整（registry / host.js / 构建脚本 /
 *      tauri 配置 / CSP / 插件 HTML）；
 *   2. 行为层：真实 import host.js，跑 resolveFrameSrc 的 plain 分支、
 *      getResourceDir 的双来源探测、runtimeFrameUrl 纯函数拼接。
 *      （prod 分支依赖 vite 编译期替换的 import.meta.env，Node 下不可达，
 *       所以它的逻辑被抽成纯函数 runtimeFrameUrl 单独覆盖 —— 见 host.js。）
 *
 * ⚠️ 零依赖 stub（第 39 轮）：原第 6 节用 jsdom 造最小浏览器环境。sweep-tests.mjs
 *   文件头专门记过这个坑 —— 环境反复把 jsdom 的依赖树（cssstyle / parse5 /
 *   tough-cookie / ws）裁掉时，require('jsdom') 要么 MODULE_NOT_FOUND 崩在
 *   import 之前（**无汇总行**），要么静默挂起，体检单只看到「崩在半路 /
 *   挂起」，排查方向被引到测试本身，真因在依赖。第 6 节实际只需要 window /
 *   document / localStorage 几个全局，用 `scripts/host-globals-stub.mjs`
 *   手写即可，不必拖整棵 jsdom 依赖树。
 *
 * ⚠️ 上一轮记「没有 npm script、不在体检单」是错的：`test:runtime-plugins`
 *   一直在 package.json，node 直跑 .mjs 也匹配 sweep 的 filter1，它一直被
 *   收录。真实形态是「崩得没有汇总行」，且第 5 节口径停在退场前（写死 9 个
 *   id 一律读 plugins/<id>/index.html），6 条红从未被打出来过。两处一起修。
 *
 * 运行：node runtime-plugin-test.mjs（npm run test:runtime-plugins）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ============ 1. 源码层：registry 标记 ============ */
console.log('\n=== 1. registry：iframe 必须标 runtime:true ===');
const registry = src('plugins/registry.js');
/* 按顶层条目切块（与 plugin-modes.js / dist-integrity-test 同口径） */
const blocks = [];
{
  const re = /\{\s*id:\s*'([^']+)'/g;
  const marks = [...registry.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].index : registry.length;
    blocks.push({ id: marks[i][1], blk: registry.slice(marks[i].index, end) });
  }
}
t('解析出插件条目', blocks.length > 0);
for (const { id, blk } of blocks) {
  const isIframe = /type:\s*'iframe'/.test(blk);
  const isModule = /type:\s*'module'/.test(blk);
  if (isIframe) {
    t(`${id}（iframe）标了 runtime:true`, /^\s*runtime:\s*true/m.test(blk));
  } else if (isModule) {
    t(`${id}（module）没有误标 runtime`, !/runtime:\s*true/.test(blk),
      '同页插件与外壳同文档，物理上无法独立构建');
  }
}

/* ============ 2. 源码层：host.js 接线 ============ */
console.log('\n=== 2. host.js：iframe src 走 resolveFrameSrc 分流 ===');
const host = src('js/host.js');
t('mountIframeView 用 resolveFrameSrc 赋 src',
  /iframe\.src = await resolveFrameSrc\(manifest\)/.test(host),
  '直接 resolveEntry 等于没分流');
t('不再有裸 resolveEntry 赋 src（只允许出现在函数定义/诊断里）',
  !/iframe\.src = resolveEntry\(/.test(host));
t('有三态判定 frameSrcMode', /function frameSrcMode\(\)/.test(host));
t('有三态判定的 dev 分支（env.DEV；entry 已改指产物，不再直指源码）',
  /env && env\.DEV/.test(host));
t('prod 态才走同源 runtime 路径（非 prod 退回 resolveEntry）', /mode !== 'prod'/.test(host));
t('resourceDir 探测：全局 __TAURI__.path 优先',
  /__TAURI__ && w\.__TAURI__\.path/.test(host));
t('resourceDir 探测：npm 包兜底',
  /import\('@tauri-apps\/api\/path'\)/.test(host));
t('探测失败不缓存（与 tauri-core 同策略）',
  /只缓存成功；失败不缓存/.test(host));
t('有纯函数 runtimeFrameUrl（拼接逻辑可单测）',
  /export function runtimeFrameUrl\(/.test(host));
t('URL 带 nexus-bg / nexus-base 防闪参数',
  /q\.set\('nexus-bg'/.test(host) && /q\.set\('nexus-base'/.test(host));
/* 同源化改造（2026-10-24）：asset 协议三坑（%2F 破坏相对资源解析 /
   module script 的 CORS 拒绝执行 / 跨源后空检测失效）全部实机复现后，
   runtime 插件改走 dist/ 内同源相对路径。这两条钉子防回退。 */
t('不再走 convertFileSrc（asset 协议）',
  !/convertFileSrc/.test(host.match(/export function runtimeFrameUrl[\s\S]*?\n}/)[0]));
t('resolveFrameSrc 的 prod 分支直接拼相对路径',
  /return runtimeFrameUrl\(\{ id: manifest\.id, vars, base \}\)/.test(host));

/* ============ 3. 源码层：构建脚本 ============ */
console.log('\n=== 3. 构建：build-plugins.mjs 独立构建 ===');
const bp = src('scripts/build-plugins.mjs');
t('扫 plugins/<id>/index.html 自动纳入（源码态：新增插件零配置）',
  /scanIframePlugins/.test(bp) && /existsSync\(resolve\(dir, d\.name, 'index\.html'\)\)/.test(bp));
t('configFile:false（不递归读到仓库根的 vite.config.ts）',
  /configFile:\s*false/.test(bp));
t("base:'./'（产物引用必须相对路径）", /base:\s*'\.\/'/.test(bp));
t('构建后校验入口 HTML 存在', /构建产物缺少 index\.html/.test(bp));
t('校验 HTML 引用的 JS/CSS 真的产出（防静默 404）',
  /引用了 \$\{ref\}，但产物里没有该文件/.test(bp));
t('支持 --only <id> 单插件增量构建', /--only/.test(bp));
t('NATIVE_SUBDIRS 两条原生拷贝规则都在',
  /plugin: 'mindmap', dir: 'editor'/.test(bp) && /plugin: 'project-group', dir: 'preseticons'/.test(bp));
t('package.json 的 build 串联 plugins:build + stash-dist + vite + copy-runtime',
  /"build":\s*"node scripts\/build-plugins\.mjs && node scripts\/stash-dist\.mjs && vite build && node scripts\/copy-runtime\.mjs"/.test(src('package.json')));
t('copy-runtime 把产物拷进 dist/（同源化的前提）',
  /dist.*runtime-plugins/.test(src('scripts/copy-runtime.mjs')));
/* 2026-10-24 实测：copy-runtime 用 fs.cpSync 会被本机 safe-delete shim
   直接终止进程（exit 127，且没有任何输出），改手递 readFileSync/writeFileSync。
   同理，任何 import 删除类 API / cpSync 的构建脚本都会中招。 */
t('copy-runtime 不用 cpSync / 删除类 API（会被 safe-delete shim 杀进程）',
  !/cpSync|rmSync|unlinkSync|\brm\(/.test(src('scripts/copy-runtime.mjs')));
/* 陈旧产物（dist/ 342 文件、project-group/preseticons 169 文件）会让下一轮
   构建的 emptyOutDir 撞批量守卫 → 每次构建都卡死下一次。解法是 rename
   （守卫不管）到同卷暂存区，跨卷 tmpdir 会 EXDEV。 */
t('build-plugins 构建前把旧产物 rename 挪走（避开 emptyOutDir 批量删除）',
  /function stashOutDir/.test(bp) && /renameSync/.test(bp));
t('stash 目标同卷（用 STALE_ROOT，不用 os.tmpdir 防 EXDEV）',
  /STALE_ROOT/.test(bp) && !/tmpdir\(\)/.test(bp)
  && /from '\.\/stale-root\.mjs'/.test(bp));
t('vite build 之前有 stash-dist 步骤', /scripts\/stash-dist\.mjs/.test(src('package.json')));
t('package.json 有 plugins:build script', /"plugins:build":/.test(src('package.json')));
t('vite.config.ts 不再收 iframe 插件入口', (() => {
  const cfg = src('config/nexus.config.mjs');
  const fn = cfg.match(/export function buildInputs[\s\S]*?\n}/);
  return !!fn && !/readdirSync|d\.name/.test(fn[0]);
})());
t('主构建仍拷 registry.js（运行时动态加载）',
  /copyInto\(PATHS\.registry/.test(src('vite.config.ts')));
/* 退场态：源码目录缺席时不能「构建 0 个插件却 exit 0」。三态判据与 52 项
   retired-supply 守卫是权威口径，这里只钉住脚本确实有 retired 分支与
   --verify 入口（防止有人把整段改成静默 return，而本节其余判据仍全绿）。 */
t('源码退场态有 retired 分支（不假装构建成功）',
  /retired/.test(bp) && /--verify/.test(bp));

/* ============ 4. 源码层：打包与 CSP ============ */
console.log('\n=== 4. 打包：resources 收录 + CSP 放行 ===');
const conf = src('src-tauri/tauri.conf.json');
const confVite = src('src-tauri/tauri.vite.conf.json');
t('tauri.conf.json resources 收录 runtime-plugins/',
  /"\.\.\/runtime-plugins\/":\s*"runtime-plugins\/"/.test(conf));
t('frame-src 放行 asset 源（否则 iframe 被静默拦成空白）',
  /frame-src 'self' asset: http:\/\/asset\.localhost/.test(conf)
  && /frame-src 'self' asset: http:\/\/asset\.localhost/.test(confVite));
t('connect-src 放行本地回环（插件页在 asset 源下打本地 HTTP 服务）',
  /http:\/\/127\.0\.0\.1:\*/.test(conf) && /http:\/\/localhost:\*/.test(conf));
for (const f of ['index.html', 'index.react.html']) {
  t(`${f} 的 CSP meta 同样放行 frame-src`,
    /frame-src 'self' asset: http:\/\/asset\.localhost/.test(src(f)));
}

/* ============ 5. 源码/产物层：插件 HTML 防闪 query ============ */
console.log('\n=== 5. 插件 HTML：preload 读 URL query 铺底色（按供给源分流） ===');
/**
 * 退场态更正（第 39 轮）：原判据写死 9 个 id，一律读 plugins/<id>/index.html。
 * 12 个 iframe 插件源码迁出主仓后该路径已不存在 → 6 红 + 1 条聚合红；
 * 而彼时守卫因 jsdom 依赖半残崩在 import 之前，这些红**从未被打出来过**。
 *
 * 现在按 registry 的 runtime:true 分流供给路径，不写死名单：
 *   runtime → runtime-plugins/<id>/index.html（产物，必须存在）
 *   module  → plugins/<id>/index.html（源码，多数没有 index.html，属正常）
 * 判据语义：只要用了 localStorage 兜底，就必须同时读 query。新增插件自动纳入。
 */
const preloadOk = (html) => !/nexus:preload-bg/.test(html) || /_q\.get\('nexus-bg'\)/.test(html);
t('⑤元 判据能抓到「只留兜底、删掉 query」的坏样本',
  !preloadOk("localStorage.getItem('nexus:preload-bg')"),
  '恒真会让整节假绿');
t('⑤元 判据放过「两者都没有」的插件（多数插件不做首帧底色）',
  preloadOk('<html></html>'));

const SUPPLY = blocks.map(({ id, blk }) => {
  const runtime = /runtime:\s*true/.test(blk);
  return { id, runtime, rel: runtime ? `runtime-plugins/${id}/index.html` : `plugins/${id}/index.html` };
});
t('供给源解析出全部 registry 条目', SUPPLY.length === blocks.length && blocks.length >= 20);
/* 补充：plugins/ 下仍持有 index.html 的外壳目录（如 store）不一定有 registry
   条目。按目录实扫纳入，否则「写死名单 → registry 分流」这次改造会静默少守
   一个插件，而本节其余断言照样全绿 —— 正是本项目反复踩的假绿形状。 */
const onDiskModuleHtml = readdirSync(join(HERE, 'plugins'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(HERE, 'plugins', d.name, 'index.html')))
  .map((d) => d.name);
for (const id of onDiskModuleHtml) {
  if (!SUPPLY.some((s) => s.id === id)) SUPPLY.push({ id, runtime: false, rel: `plugins/${id}/index.html` });
}
t('plugins/ 下所有含 index.html 的目录都纳入供给检查',
  onDiskModuleHtml.length > 0 && onDiskModuleHtml.every((id) => SUPPLY.some((s) => s.id === id)),
  onDiskModuleHtml.join(','));

const preloadRows = [];
for (const { id, runtime, rel } of SUPPLY) {
  const p = join(HERE, rel);
  const has = existsSync(p);
  if (runtime) t(`${id}（runtime）产物 HTML 存在`, has, rel);
  if (!has) continue;
  const html = readFileSync(p, 'utf8');
  if (/nexus:preload-bg/.test(html)) preloadRows.push({ id, rel, html });
}
/* every 对空集合恒真：没有这条规模断言，把 preloadRows 清空即可让本节全绿 */
t('至少 6 个插件带 preload 兜底（防空集合假绿）',
  preloadRows.length >= 6, `实得 ${preloadRows.length}`);
for (const { id, rel, html } of preloadRows) {
  t(`${id} 用了兜底就必须同时读 nexus-bg query`, preloadOk(html), rel);
}

/* ============ 6. 行为层：runtimeFrameUrl 纯函数 ============ */
console.log('\n=== 6. 行为层：runtimeFrameUrl 拼接（零依赖 stub） ===');
{
  let mod = null;
  let w = null;
  try {
    /* 连 stub 也动态加载：静态 import 一旦失败就崩在守卫最前面、无汇总行，
       而「stub 文件被误删 / 损坏」与「jsdom 依赖被裁」是同一类环境事故。 */
    const stub = await import('./scripts/host-globals-stub.mjs');
    w = stub.installHostGlobals();
    mod = await import('./js/host.js');
    t('行为层：host.js 在零依赖 stub 下可 import 且导出齐全',
      typeof mod.runtimeFrameUrl === 'function'
      && typeof mod.resolveFrameSrc === 'function'
      && typeof mod.getResourceDir === 'function');
  } catch (e) {
    /* 崩了必须显式报红并保留汇总行：体检单只看到「崩在半路 / 无汇总行」
       时，排查方向会被引到测试本身，而真因可能在 stub 或 host.js 顶层。 */
    t('行为层：host.js 在零依赖 stub 下可 import（崩了要显式报红）', false, String(e && e.message));
  }
  if (mod) {
    const host = mod;
    try {

      /* 同源相对路径拼接：不再过 convertFileSrc（asset 协议三坑，见 host.js
         runtimeFrameUrl 注释），产物就是 dist/ 下的相对 URL。 */
      const url = host.runtimeFrameUrl({
        id: 'task-board',
        vars: { '--bg': '#101318' },
        base: 'dark',
      });
      t('拼出同源相对路径 runtime-plugins/<id>/index.html',
        url.startsWith('runtime-plugins/task-board/index.html'), url);
      t('不带 asset.localhost / 盘符（那三条坑的温床；query 的 %23 是合法编码）',
        !url.includes('asset.localhost') && !url.includes('E:'), url);
      t('带 nexus-bg 参数', /[?&]nexus-bg=%23101318/.test(url), url);
      t('带 nexus-base 参数', /[?&]nexus-base=dark/.test(url), url);

      const noTheme = host.runtimeFrameUrl({ id: 'home', vars: {}, base: null });
      t('无主题信息时不带 query（不拼裸 ?）', !noTheme.includes('?'), noTheme);

      /* resolveFrameSrc 在 Node 下 import.meta.env 不存在 → plain 分支：
         必须退回 resolveEntry（相对 location 解析），而不是抛错。 */
      const plain = await host.resolveFrameSrc({ id: 'task-board', runtime: true, entry: './plugins/task-board/index.html' });
      t('plain 分支（Node/无构建）退回相对路径解析',
        plain === 'http://localhost/plugins/task-board/index.html', plain);
      const nonRuntime = await host.resolveFrameSrc({ id: 'demo-module', entry: './plugins/demo-module/module.js' });
      t('非 runtime 插件不受影响（走原 resolveEntry）',
        nonRuntime === 'http://localhost/plugins/demo-module/module.js', nonRuntime);

      /* getResourceDir：无 __TAURI__ 时返回 null 且不抛。
         注意用带 query 的 URL 重新 import，绕开模块级 _resourceDir 缓存
         （第一次探测的结果会被缓存，第二次 import 同一 URL 拿不到新实例）。 */
      delete w.__TAURI__;
      const fresh1 = await import('./js/host.js?rt=1');
      const rd1 = await fresh1.getResourceDir();
      t('getResourceDir：无 Tauri 环境时返回 null 不抛', rd1 === null, String(rd1));

      w.__TAURI__ = { path: { resourceDir: async () => 'E:\\app\\res' } };
      const fresh2 = await import('./js/host.js?rt=2');
      const rd2 = await fresh2.getResourceDir();
      t('getResourceDir：优先用全局 __TAURI__.path.resourceDir',
        rd2 === 'E:\\app\\res', String(rd2));
    } catch (e) {
      /* 行为层断言抛异常也要显式报红并保留汇总行：只保护 import 的话，
         host.js 改了 API / stub 少个全局，仍会崩在半路、无汇总行。 */
      t('行为层：断言执行期间不得抛异常（崩了要显式报红）', false, String(e && e.message));
    }
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log(`
失败最常见的原因：
  1. registry 新增了 iframe 插件但漏标 runtime:true —— 第 1 节
  2. host.js 的 src 赋值被改回 resolveEntry —— 第 2 节
  3. 改了构建脚本却没同步 package.json / vite.config —— 第 3 节
  4. 手改了 CSP 没过 config:sync —— 第 4 节
  5. 带 preload 兜底的 HTML 被覆盖回纯 localStorage，或供给 HTML 缺失 —— 第 5 节
  6. host.js 顶层碰了 stub 没覆盖的 API（补 stub，别拖回 jsdom）—— 第 6 节`);
}
process.exit(fail ? 1 : 0);
