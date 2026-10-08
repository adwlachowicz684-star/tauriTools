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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: pathToFileURL(path.join(HERE, 'index.html')).href,
});
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
const found = ext.scanText(sample, pathToFileURL(path.join(HERE, 'plugins/x/index.html')).href);
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
/*
 * ⓘ 原写 `ext.pendingHosts().length >= 0` —— 恒真，无论登记没登记都绿。
 *   "待决定的会被列出"要守的是两件事：登记进来的算待决定；
 *   一旦决策（信任/禁止）就**不再**算待决定 —— 后者才是这条存在的意义
 *   （决策完还留在待决定清单里，用户会以为自己没设过）。
 */
ext.recordHosts([{ host: 'wait.example.com', kind: 'unknown' }], 'test-plugin');
const pend1 = ext.pendingHosts();
t('待决定的会被列出', pend1.some((h) => h.host === 'wait.example.com'),
  pend1.map((h) => h.host).join(',') || '（空）');
t('已决策的不算待决定', !pend1.some((h) => h.host === 'new.example.com'),
  pend1.map((h) => h.host).join(',') || '（空）');
ext.setHostStatus('wait.example.com', 'trusted');
t('决策后不再算待决定', !ext.pendingHosts().some((h) => h.host === 'wait.example.com'),
  ext.pendingHosts().map((h) => h.host).join(',') || '（空）');

/*
 * ⓘ 原写 `!csp || csp.includes('new.example.com')` —— 双重假绿：
 *   ① 前缀 `!csp ||` 让"没有已信任域名 → suggestCsp 返回空串"时**直接判过**，
 *      而历史上走到这里恰好一个已信任域名都没有，所以它从来没验过任何东西；
 *   ② 'new.example.com' 在上面被设成 **blocked**，suggestCsp 只列 trusted，
 *      它永远不可能出现在 CSP 里 —— 一旦真有已信任域名、csp 变非空，
 *      这条立刻红，而红的原因跟"域名有没有被信任"毫无关系。
 *   改成分三条：先钉"非空"（防空转），再钉"信任的在内、禁止的不在内"。
 */
const csp = ext.suggestCsp();
t('有已信任域名时 CSP 非空（否则下面两条会空转）', !!csp, csp ? '已生成' : '（空 —— 说明没收集到已信任域名）');
t('建议 CSP 含已信任域名', !!csp && csp.includes('wait.example.com'), csp ? csp.slice(0, 60) + '…' : '（空）');
t('建议 CSP 不含被禁止的域名', !!csp && !csp.includes('new.example.com'), csp ? '已排除' : '（空）');

/* ---------- D. 沙箱开关 ---------- */
/*
 * ⓘ 这里原本是「沙箱 / 主题适配 两个开关互相独立」。
 *   主题适配（adaptTheme / 自报基调 / 滤镜反转）整套已删除：
 *   现在只有一个机制 —— 外壳把主题变量推给插件，插件渲染成什么样就是什么样。
 *   所以 D 节只保留沙箱开关本身，E / F 两节（自报基调兜底、lightenToDarkVars）
 *   整块删除。
 *
 *   这些断言此前"存在但没人看得见"：external-test 依赖真实 DOM，
 *   沙盒里的 jsdom 曾是一个 0.0.0-shim 的假包（querySelectorAll 恒返回 []），
 *   测试根本跑不到这里。换回真 jsdom 后，F 节直接 ReferenceError（nz 未定义），
 *   D 节 3 项转红 —— 都是删机制时漏掉的残留。
 */
console.log('\n--- D. 沙箱开关 ---');
ext.savePolicy({ mode: 'smart', hosts: {} });
const ID = 'test-plugin';
t('默认：不隔离', cfg.getPluginConfig(ID).isolated === false);

cfg.setPluginConfig(ID, { isolated: true });
t('可以打开隔离', cfg.getPluginConfig(ID).isolated === true);

cfg.setPluginConfig(ID, { isolated: false });
t('可以关掉隔离', cfg.getPluginConfig(ID).isolated === false);

cfg.setPluginConfig(ID, { isolated: true });
t('配置按插件 id 隔离，互不干扰',
  cfg.getPluginConfig(ID).isolated === true
  && cfg.getPluginConfig('other-plugin').isolated === false);

/*
 * 滤镜机制已删除的确认式断言：防止它哪天被加回来而没人发现。
 * 只写"没有"这类否定式断言容易假绿（代码不存在时自然通过），
 * 所以这里钉的是**配置层**：getPluginConfig 的结果里不该再有这个键。
 */
t('主题适配开关已随滤镜机制一并删除',
  !('adaptTheme' in cfg.getPluginConfig(ID)),
  Object.keys(cfg.getPluginConfig(ID)).join(','));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
