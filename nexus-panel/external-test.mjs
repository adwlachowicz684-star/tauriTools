/**
 * 外链策略 + 沙箱隔离配置 测试（开发用，可删）
 * ------------------------------------------------------------
 * A. 外域判定：入口 URL 哪些算外域、哪些不算（A3 的核心）
 * B. 静态扫描：从插件入口文本里提取外链
 * C. 三档策略：allow-all / smart / deny-all 与逐域名决策的优先级
 * D. 沙箱配置：两个开关独立读写，互不干扰
 * E. 隔离插件的主题兜底：外壳采样不到时，用插件自报的基调
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'file:///data/workspace/nexus-panel/index.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.CustomEvent = dom.window.CustomEvent;

const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
  key: (i) => [..._ls.keys()][i] ?? null,
  get length() { return _ls.size; },
};

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const ext = await import('./js/external-policy.js');
const cfg = await import('./js/plugin-config.js');
const nz = await import('./js/theme-normalizer.js');

/* ---------- A. 外域判定 ---------- */
console.log('\n--- A. 外域判定（哪些入口算危险） ---');
t('相对路径不是外域', !ext.isExternal('./plugins/home/index.html'));
t('站内绝对路径不是外域', !ext.isExternal('/plugins/x/index.html'));
t('file: 协议不是外域', !ext.isExternal('file:///data/x/index.html'));
t('data: 不是外域', !ext.isExternal('data:text/html,<h1>x</h1>'));
t('blob: 不是外域', !ext.isExternal('blob:http://localhost/abc'));
t('localhost 不算外域', !ext.isExternal('http://localhost:1420/x.html'));
t('127.0.0.1 不算外域', !ext.isExternal('http://127.0.0.1:1420/x.html'));
t('asset.localhost（Tauri 资源）不算外域', !ext.isExternal('http://asset.localhost/x.html'));
t('https 外部站点算外域', ext.isExternal('https://evil.example.com/p.html'));
t('http 外部站点算外域', ext.isExternal('http://cdn.example.com/p.js'));
t('入口校验：本地入口放行', ext.isAllowedEntry('./plugins/x/index.html'));
t('入口校验：外域入口拒绝', !ext.isAllowedEntry('https://evil.example.com/p.html'));
t('取 host 正确', ext.hostOf('https://a.b.com/x/y?z=1') === 'a.b.com',
  String(ext.hostOf('https://a.b.com/x/y?z=1')));

/* ---------- B. 静态扫描 ---------- */
console.log('\n--- B. 静态扫描入口文件 ---');
const sample = `
  <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=X">
  <script src="./local.js"></script>
  <script src="https://cdn.example.com/lib.js"></script>
  <iframe src="https://player.bilibili.com/player.html?bvid=1"></iframe>
  <video src="https://media.example.com/a.mp4"></video>
  <img src="./local.png">
  <style>.a{background:url(https://img.example.com/b.png)}</style>
  <script>fetch('https://api.example.com/data')</script>
  <a href="https://docs.example.com">文档</a>
`;
const found = ext.scanText(sample, 'file:///data/workspace/nexus-panel/plugins/x/index.html');
const hosts = found.map((f) => f.host).sort();
t('扫出全部 7 个外域', hosts.length === 7, `${hosts.length}: ${hosts.join(', ')}`);
t('含 cdn.example.com', hosts.includes('cdn.example.com'));
t('含 player.bilibili.com', hosts.includes('player.bilibili.com'));
t('含 api.example.com（fetch 里的）', hosts.includes('api.example.com'));
t('含 img.example.com（CSS url() 里的）', hosts.includes('img.example.com'));
t('不含本地资源', !hosts.some((h) => /local|\.png$/.test(h)), hosts.join(', '));

const scriptKind = found.find((f) => f.host === 'cdn.example.com');
t('脚本用途识别为 script', scriptKind?.kind === 'script', scriptKind?.kind);
const frameKind = found.find((f) => f.host === 'player.bilibili.com');
t('iframe 用途识别为 frame', frameKind?.kind === 'frame', frameKind?.kind);
const mediaKind = found.find((f) => f.host === 'media.example.com');
t('video 用途识别为 media', mediaKind?.kind === 'media', mediaKind?.kind);

/* ---------- C. 三档策略 ---------- */
console.log('\n--- C. 三档全局策略 + 逐域名决策 ---');
ext.savePolicy({ mode: 'smart', hosts: {} });
t('smart 模式：未知域名 → ask', ext.decideHost('new.example.com') === 'ask');
ext.setHostStatus('new.example.com', 'trusted');
t('逐条信任后 → allow（优先于全局）', ext.decideHost('new.example.com') === 'allow');
ext.setHostStatus('new.example.com', 'blocked');
t('逐条禁止后 → block', ext.decideHost('new.example.com') === 'block');

ext.savePolicy({ mode: 'allow-all', hosts: {} });
t('allow-all：未知域名 → allow', ext.decideHost('any.example.com') === 'allow');
t('allow-all 下逐条禁止仍生效', (() => {
  ext.setHostStatus('bad.example.com', 'blocked');
  return ext.decideHost('bad.example.com') === 'block';
})());

ext.savePolicy({ mode: 'deny-all', hosts: {} });
t('deny-all：未知域名 → block', ext.decideHost('any.example.com') === 'block');
t('deny-all 下逐条信任仍生效', (() => {
  ext.setHostStatus('good.example.com', 'trusted');
  return ext.decideHost('good.example.com') === 'allow';
})());

ext.removeHost('good.example.com');
t('移除后回到全局策略', ext.decideHost('good.example.com') === 'block');

ext.setHostStatus('new.example.com', 'blocked');   // 重新登记一条
const listed = ext.listHosts();
t('清单持久化并可读', listed.some((x) => x.host === 'new.example.com'), `${listed.length} 条`);
t('待决定的会被列出', ext.pendingHosts().length >= 0);

const csp = ext.suggestCsp();
t('建议 CSP 含已信任域名', !csp || csp.includes('new.example.com'), csp ? '已生成' : '（无信任项）');

/* ---------- D. 沙箱配置：两个开关独立 ---------- */
console.log('\n--- D. 沙箱 / 主题 两个开关互相独立 ---');
ext.savePolicy({ mode: 'smart', hosts: {} });
const ID = 'test-plugin';
t('默认：不隔离 + 适配主题',
  cfg.getPluginConfig(ID).isolated === false && cfg.getPluginConfig(ID).adaptTheme === true);

cfg.setPluginConfig(ID, { isolated: true });
t('只开隔离：主题适配不受影响',
  cfg.getPluginConfig(ID).isolated === true && cfg.getPluginConfig(ID).adaptTheme === true);

cfg.setPluginConfig(ID, { adaptTheme: false });
t('再关主题适配：隔离仍为开',
  cfg.getPluginConfig(ID).isolated === true && cfg.getPluginConfig(ID).adaptTheme === false);

cfg.setPluginConfig(ID, { isolated: false });
t('只关隔离：主题适配保持关',
  cfg.getPluginConfig(ID).isolated === false && cfg.getPluginConfig(ID).adaptTheme === false);

cfg.setPluginConfig(ID, { adaptTheme: true });
t('配置按插件 id 隔离，互不干扰',
  cfg.getPluginConfig('other-plugin').isolated === false
  && cfg.getPluginConfig('other-plugin').adaptTheme === true);

/* ---------- E. 隔离插件的主题兜底 ---------- */
console.log('\n--- E. 隔离插件靠自报基调完成适配 ---');
// 造一个"读不到内部"的 iframe（模拟隔离）
const iframe = dom.window.document.createElement('iframe');
Object.defineProperty(iframe, 'contentDocument', { get: () => null });   // 隔离 → 采样通道关闭
const wrap = dom.window.document.createElement('div');
wrap.style.position = 'relative';
dom.window.document.body.appendChild(wrap);

const mkManifest = (theme) => ({ id: 'iso-plugin', name: '隔离插件', theme });

// 不传 reportedBase：采样失败 → 视为与面板同基调 → 不反转（旧行为，会留白块）
const r1 = await nz.installAdapter({
  manifest: mkManifest(undefined), wrap, target: iframe, root: null,
  isIframe: true, doc: null,
});
const adaptedWithoutReport = iframe.style.filter !== '';
t('无自报时：采样失败→不反转（这正是要修的坑）', !adaptedWithoutReport,
  adaptedWithoutReport ? '意外反转了' : '未反转');

// 传 reportedBase='light'：即使采样不到也能正确判定并反转
iframe.style.filter = '';
const r2 = await nz.installAdapter({
  manifest: mkManifest(undefined), wrap, target: iframe, root: null,
  isIframe: true, doc: null, reportedBase: 'light',
});
const adaptedWithReport = iframe.style.filter !== '';
t('有自报时：即使隔离也能正确反转', adaptedWithReport,
  adaptedWithReport ? '已施加滤镜' : '仍未反转');
r2?.();

/* ---------- F. A7 坏函数已修 ---------- */
console.log('\n--- F. 主题改写工具 ---');
const out = nz.lightenToDarkVars('#ffffff; color:#222222; background:#f5f5f5;');
t('输出是合法 CSS（括号配平）',
  (out.match(/\(/g) || []).length === (out.match(/\)/g) || []).length, out);
t('白色被替换为 --surface', out.includes('var(--surface)'), out.slice(0, 60));
t('深色文字被替换为 --text', out.includes('var(--text)'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
