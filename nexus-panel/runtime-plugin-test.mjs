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
 * 分两层（与 handshake-test 同一思路）：
 *   1. 源码层：各环节的接线与标记完整（registry / host.js / 构建脚本 /
 *      tauri 配置 / CSP / 插件 HTML）；
 *   2. 行为层：真实 import host.js，跑 resolveFrameSrc 的 plain 分支、
 *      getResourceDir 的双来源探测、runtimeFrameUrl 纯函数拼接。
 *      （prod 分支依赖 vite 编译期替换的 import.meta.env，Node 下不可达，
 *       所以它的逻辑被抽成纯函数 runtimeFrameUrl 单独覆盖 —— 见 host.js。）
 */
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
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
t('dev 态直指 dev server（/plugins/<id>/index.html）',
  /env && env\.DEV/.test(host));
t('prod 态才走 asset 协议', /mode !== 'prod'/.test(host));
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
t('convertFileSrc 前做反斜杠归一化',
  /replace\(\/\\\\\/g, '\/'\)/.test(host));
t('resourceDir/convertFileSrc 缺失时退回 resolveEntry（可读失败）',
  /取不到 resourceDir，退回相对路径加载/.test(host));

/* ============ 3. 源码层：构建脚本 ============ */
console.log('\n=== 3. 构建：build-plugins.mjs 独立构建 ===');
const bp = src('scripts/build-plugins.mjs');
t('扫 plugins/<id>/index.html 自动纳入（新增插件零配置）',
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
t('package.json 的 build 串联 plugins:build',
  /"build":\s*"node scripts\/build-plugins\.mjs && vite build"/.test(src('package.json')));
t('package.json 有 plugins:build script', /"plugins:build":/.test(src('package.json')));
t('vite.config.ts 不再收 iframe 插件入口', (() => {
  const cfg = src('config/nexus.config.mjs');
  const fn = cfg.match(/export function buildInputs[\s\S]*?\n}/);
  return !!fn && !/readdirSync|d\.name/.test(fn[0]);
})());
t('主构建仍拷 registry.js（运行时动态加载）',
  /copyInto\(PATHS\.registry/.test(src('vite.config.ts')));

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

/* ============ 5. 源码层：插件 HTML 防闪 query ============ */
console.log('\n=== 5. 插件 HTML：preload 读 URL query 铺底色 ===');
const PRELOAD_PLUGINS = [
  'agent-flow', 'color-picker', 'demo-react', 'demo-service', 'home',
  'project-group', 'settings', 'store', 'task-board',
];
for (const id of PRELOAD_PLUGINS) {
  const p = join(HERE, 'plugins', id, 'index.html');
  t(`${id}/index.html preload 读 nexus-bg query`, (() => {
    if (!existsSync(p)) return false;
    return /_q\.get\('nexus-bg'\)/.test(readFileSync(p, 'utf8'));
  })());
}
t('所有 preload 插件仍保留 localStorage 兜底',
  PRELOAD_PLUGINS.every((id) => {
    const p = join(HERE, 'plugins', id, 'index.html');
    return existsSync(p) && /localStorage\.getItem\('nexus:preload-bg'\)/.test(readFileSync(p, 'utf8'));
  }));

/* ============ 6. 行为层：runtimeFrameUrl 纯函数 ============ */
console.log('\n=== 6. 行为层：runtimeFrameUrl 拼接 ===');
{
  /* 最小浏览器全局：host.js 顶层代码会碰 window/document/localStorage。
     与 handshake-test 同一套最小环境。 */
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/index.html',
    pretendToBeVisual: true,
  });
  const { window: w } = dom;
  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.localStorage = w.localStorage;
  globalThis.location = w.location;
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true, writable: true });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);

  const host = await import('./js/host.js');

  /* 用 spy 捕获 convertFileSrc 收到的参数 —— 断言"传给它的是归一化
     正斜杠路径"，比断言它返回什么更能说明问题（返回值取决于 Tauri
     版本的编码习惯，冒号编不编都是它的事，不是我们的）。 */
  let cfsArg = null;
  const cfs = (p) => { cfsArg = p; return `http://asset.localhost/${encodeURI(p)}`; };
  const url = host.runtimeFrameUrl({
    convertFileSrc: cfs,
    resourceDir: 'E:\\app\\Nexus Panel\\resources',
    id: 'task-board',
    vars: { '--bg': '#101318' },
    base: 'dark',
  });
  t('传给 convertFileSrc 的是归一化正斜杠路径',
    cfsArg === 'E:/app/Nexus Panel/resources/runtime-plugins/task-board/index.html', cfsArg);
  t('路径不含反斜杠（混用会在某些 Tauri 版本上拼出坏路径）',
    !cfsArg.includes('\\'), cfsArg);
  t('带 nexus-bg 参数', /[?&]nexus-bg=%23101318/.test(url), url);
  t('带 nexus-base 参数', /[?&]nexus-base=dark/.test(url), url);

  const noTheme = host.runtimeFrameUrl({
    convertFileSrc: cfs, resourceDir: '/opt/nexus', id: 'home', vars: {}, base: null,
  });
  t('无主题信息时不带 query（不拼裸 ?）', !noTheme.includes('?'), noTheme);

  const trailing = host.runtimeFrameUrl({
    convertFileSrc: cfs, resourceDir: '/opt/nexus/', id: 'x', vars: {}, base: null,
  });
  t('resourceDir 尾部斜杠不产生双斜杠', !trailing.includes('nexus//'), trailing);

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
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log(`
失败最常见的原因：
  1. registry 新增了 iframe 插件但漏标 runtime:true —— 第 1 节
  2. host.js 的 src 赋值被改回 resolveEntry —— 第 2 节
  3. 改了构建脚本却没同步 package.json / vite.config —— 第 3 节
  4. 手改了 CSP 没过 config:sync —— 第 4 节
  5. 插件 index.html 的 preload 脚本被覆盖回纯 localStorage —— 第 5 节`);
}
process.exit(fail ? 1 : 0);
