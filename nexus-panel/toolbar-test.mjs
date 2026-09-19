/**
 * 工具栏插件（kind:'toolbar'）回归测试
 * ------------------------------------------------------------
 * 覆盖：注册表条目与类型约束、定义校验、加载拒绝 iframe、
 *       order 排序、渲染与点击、异常转提示、菜单取消语义、
 *       MCP 状态读取（含"读不到 ≠ 0"）、侧边栏与挂载的拦截、
 *       两个外壳都接上了插件口。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.CustomEvent = dom.window.CustomEvent;

const {
  resetToolbar, toolbarDefs, validateToolbarDef, loadToolbarPlugins, mountToolbar,
} = await import('./js/toolbar-plugin.js');

/* ---------------------------------------------------------------- */
console.log('\n=== 1. 注册表条目 ===');

const reg = src('plugins/registry.js');
/* 按 id 切块，避免跨块匹配（N74 教训） */
const blocks = {};
for (const part of reg.split(/\n  \{\n/)) {
  const m = part.match(/id: '([a-z0-9-]+)'/);
  if (m) blocks[m[1]] = part;
}
const TOOLBAR_IDS = ['toolbar-theme', 'toolbar-pin', 'toolbar-tray', 'toolbar-mcp'];

for (const id of TOOLBAR_IDS) {
  const b = blocks[id];
  t(`注册表里有 ${id}`, !!b);
  if (!b) continue;
  t(`  ${id} kind 是 toolbar`, /kind: 'toolbar'/.test(b));
  /*
   * 只支持 module：iframe 下这些按钮拿不到 Tauri，永远点不动。
   *
   * 必须数**出现次数**而不是"搜到就行"：只搜 /type: 'module'/ 的话，
   * 同一个插件里再冒出一行 type: 'iframe' 也能被那条匹配蒙混过去 ——
   * 而这正是"配置了却静默失效"的典型写法。
   */
  const types = b.match(/type: '[a-z]+'/g) || [];
  t(`  ${id} type 是 module 且只声明一次`,
    types.length === 1 && types[0] === "type: 'module'", types.join(','));
  t(`  ${id} 入口是 module.js`, /entry: '\.\/plugins\/[a-z-]+\/module\.js'/.test(b));
}

t('四个插件入口文件都存在', TOOLBAR_IDS.every((id) => {
  const dir = id;  // 目录名与 id 一致
  return fs.existsSync(path.join(HERE, 'plugins', dir, 'module.js'));
}));

/* ---------------------------------------------------------------- */
console.log('\n=== 2. 定义校验 ===');

t('缺 id → 报错', validateToolbarDef({ label: 'x', onClick() {} }).length > 0);
t('缺 label → 报错', validateToolbarDef({ id: 'x', onClick() {} }).length > 0);
t('缺 onClick → 报错', validateToolbarDef({ id: 'x', label: 'x' }).length > 0);
t('完整定义 → 无错', validateToolbarDef({ id: 'x', label: 'x', onClick() {} }).length === 0);
t('null → 报错（不是抛异常）', validateToolbarDef(null).length > 0);

/* ---------------------------------------------------------------- */
console.log('\n=== 3. 加载：iframe 必须被拒绝 ===');

resetToolbar();
let errId = null, errMsg = '';
const n = await loadToolbarPlugins(
  [{ id: 'bad', type: 'iframe', entry: 'x' }],
  {
    loadModule: async () => ({ default: { id: 'bad', label: 'B', onClick() {} } }),
    onError: (id, e) => { errId = id; errMsg = String(e?.message || e); },
  },
);
t('iframe 类型被拒绝（不加载）', n === 0 && errId === 'bad');
t('拒绝原因说清了为什么', /只支持 module/.test(errMsg), errMsg);
t('被拒绝的插件不会进登记表', toolbarDefs().length === 0);

/* 加载失败不能连带整排按钮消失 */
resetToolbar();
const n2 = await loadToolbarPlugins(
  [{ id: 'ok', type: 'module' }, { id: 'boom', type: 'module' }],
  {
    loadModule: async (m) => {
      if (m.id === 'boom') throw new Error('入口炸了');
      return { default: { id: 'ok', label: 'O', order: 5, onClick() {} } };
    },
    onError: () => {},
  },
);
t('一个插件加载失败，其余照常（不整排消失）', n2 === 1 && toolbarDefs().length === 1);

/* ---------------------------------------------------------------- */
console.log('\n=== 4. order 排序 ===');

resetToolbar();
await loadToolbarPlugins(
  [{ id: 'c' }, { id: 'a' }, { id: 'b' }],
  {
    loadModule: async (m) => ({
      default: { id: m.id, label: m.id, order: { c: 30, a: 10, b: 20 }[m.id], onClick() {} },
    }),
    onError: () => {},
  },
);
t('按 order 升序（不是数组顺序）',
  toolbarDefs().map((d) => d.id).join('') === 'abc',
  toolbarDefs().map((d) => d.id).join(','));

/* ---------------------------------------------------------------- */
console.log('\n=== 5. 渲染与点击 ===');

resetToolbar();
const clicked = [];
await loadToolbarPlugins(
  [{ id: 'p1' }, { id: 'p2' }],
  {
    loadModule: async (m) => ({
      default: {
        id: m.id, label: m.id === 'p1' ? '⇱' : '⇲', tip: m.id, order: 10,
        onClick: (api) => { clicked.push(m.id); api.setActive(true); },
      },
    }),
    onError: () => {},
  },
);
const host = document.createElement('div');
document.body.appendChild(host);
mountToolbar(host, { toast: () => {}, win: () => {} });

const btns = host.querySelectorAll('button');
t('渲染出两个按钮', btns.length === 2);
t('label 上到按钮文字', btns[0].textContent === '⇱');
t('tip 上到 title', btns[0].title === 'p1');

btns[0].click();
t('点击触发 onClick（走的是插件代码）', clicked.length === 1 && clicked[0] === 'p1');
t('setActive 加了 on 类', btns[0].classList.contains('on'));

/* 插件抛异常 → 转提示，不能冒出去变成"点了没反应" */
let toastMsg = '';
resetToolbar();
await loadToolbarPlugins(
  [{ id: 'boom2' }],
  {
    loadModule: async () => ({
      default: { id: 'boom2', label: 'B', onClick() { throw new Error('插件内部炸了'); } },
    }),
    onError: () => {},
  },
);
const host2 = document.createElement('div');
document.body.appendChild(host2);
mountToolbar(host2, { toast: (m) => { toastMsg = m; }, win: () => {} });
host2.querySelector('button').click();
await new Promise((r) => setTimeout(r, 10));
t('插件抛异常转成提示（不静默）', /插件内部炸了/.test(toastMsg), toastMsg);

/* ---------------------------------------------------------------- */
console.log('\n=== 6. 菜单：取消返回 null，不是抛异常 ===');

resetToolbar();
let menuResult = 'unset';
await loadToolbarPlugins(
  [{ id: 'm' }],
  {
    loadModule: async () => ({
      default: {
        id: 'm', label: 'M',
        async onClick(api) {
          menuResult = await api.menu([
            { label: '打开凭据中心', value: 'creds' },
            { separator: true },
            { label: '刷新', value: 'refresh' },
          ]);
        },
      },
    }),
    onError: () => {},
  },
);
const host3 = document.createElement('div');
document.body.appendChild(host3);
mountToolbar(host3, { toast: () => {}, win: () => {} });
host3.querySelector('button').click();
await new Promise((r) => setTimeout(r, 20));

const layer = document.querySelector('.tb-menu-layer');
t('菜单弹到了 body（不是锚点内部）', !!layer && layer.parentElement === document.body);
const items = document.querySelectorAll('.tb-menu-item');
t('菜单项渲染正确（分隔符不算一项）', items.length === 2);

/* 点第一项 */
items[0].click();
await new Promise((r) => setTimeout(r, 10));
t('选中返回 value', menuResult === 'creds', String(menuResult));
t('选完菜单移除', !document.querySelector('.tb-menu-layer'));

/* 再开一次，走 ESC 取消 */
menuResult = 'unset';
host3.querySelector('button').click();
await new Promise((r) => setTimeout(r, 20));
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
await new Promise((r) => setTimeout(r, 10));
t('ESC 取消 → resolve(null)，不抛异常', menuResult === null, String(menuResult));
t('取消后菜单移除', !document.querySelector('.tb-menu-layer'));

/* ---------------------------------------------------------------- */
console.log('\n=== 7. MCP 状态：读不到 ≠ 0 ===');

const mcp = await import('./plugins/toolbar-mcp/module.js');

localStorage.removeItem('agent-flow.mcpServers.v1');
const s0 = mcp.readMcpSummary();
t('没配过 → visible=false（不是 0）', s0.visible === false);
t('没配过的 tip 说"还没配置"或"未知"，不说 0/0',
  /还没配置|未知/.test(mcp.mcpTip(s0)), mcp.mcpTip(s0));

localStorage.setItem('agent-flow.mcpServers.v1', JSON.stringify({
  version: 1,
  servers: [
    { id: 'a', name: 'chrome-devtools' },
    { id: 'b', name: 'context7', disabled: true },
    { id: 'c', name: 'gh_grep' },
  ],
}));
const s1 = mcp.readMcpSummary();
t('解析出总数', s1.total === 3, `total=${s1.total}`);
t('disabled 的不算启用', s1.enabled === 2, `enabled=${s1.enabled}`);
t('tip 显示 2/3', /2\/3/.test(mcp.mcpTip(s1)), mcp.mcpTip(s1));

/* 存储坏了（隔离态 / 格式变更）也要诚实 */
localStorage.setItem('agent-flow.mcpServers.v1', '{不是 json');
const s2 = mcp.readMcpSummary();
t('存储坏了 → visible=false，不抛异常', s2.visible === false);
t('坏数据的 tip 说"未知"而不是 0', /未知/.test(mcp.mcpTip(s2)), mcp.mcpTip(s2));

t('MCP 插件声明了 onInit（挂载后刷新一次）',
  typeof mcp.default.onInit === 'function');

/* ---------------------------------------------------------------- */
console.log('\n=== 8. 侧边栏与挂载都要拦 toolbar ===');

const hostJs = src('js/host.js');
t('visiblePlugins 过滤 toolbar',
  /p\.kind !== 'service' && p\.kind !== 'toolbar'/.test(hostJs));
t('mount 里拦截 toolbar（侧边栏只是 UI，快捷键能绕过）',
  /manifest\?\.kind === 'service' \|\| manifest\?\.kind === 'toolbar'/.test(hostJs));
t('拦截时给出说明而不是空白', /工具栏插件，显示在标题栏右上角/.test(hostJs));

/* ---------------------------------------------------------------- */
console.log('\n=== 9. 两个外壳都接上了插件口 ===');

const html = src('index.html');
t('原生外壳有工具栏容器', /id="tb-toolbar"/.test(html));
t('原生外壳不再硬编码主题按钮', !/id="btn-theme"/.test(html));
t('原生外壳不再硬编码置顶按钮', !/id="btn-top"/.test(html));
t('原生外壳不再硬编码托盘按钮', !/id="btn-hide"/.test(html));
t('原生外壳保留窗口控制（不插件化）',
  /id="btn-min"/.test(html) && /id="btn-max"/.test(html) && /id="btn-close"/.test(html));

const shell = src('js/shell.js');
/*
 * loadRegistry 是 **async**，不 await 拿到的是 Promise：
 * .filter 直接抛 TypeError，原生外壳整段初始化挂掉（不只是少一排按钮）。
 * 这个坑真出过 —— 测试当时只查字符串没真跑初始化，所以没抓到。
 */
t('shell.js 里 await 了 loadRegistry（不是同步调用）',
  /await loadRegistry\(\)/.test(shell) && !/(?:const|let|var)\s+\w+\s*=\s*loadRegistry\(\)/.test(shell));
t('shell.js 调用了 loadToolbarPlugins', /loadToolbarPlugins\(/.test(shell));
t('shell.js 调用了 mountToolbar', /mountToolbar\(/.test(shell));
t('shell.js 的 emit 走宿主总线', /host\.bus\?\.emit/.test(shell));
t('shell.js 不再引用已删掉的 btn-top', !/\$\('#btn-top'\)/.test(shell));
t('shell.js 不再引用已删掉的 btn-hide', !/\$\('#btn-hide'\)/.test(shell));

const tb = src('src/components/Titlebar.tsx');
t('Titlebar 里 await 了 loadRegistry（不是同步调用）',
  /await loadRegistry\(\)/.test(tb) && !/(?:const|let|var)\s+\w+\s*=\s*loadRegistry\(\)/.test(tb));
t('React 外壳有工具栏插槽', /tb-toolbar/.test(tb));
t('React 外壳调用了 loadToolbarPlugins', /loadToolbarPlugins\(/.test(tb));
t('React 外壳调用了 mountToolbar', /mountToolbar\(/.test(tb));
t('React 外壳不再硬编码置顶按钮', !/onWin\('topmost'\)/.test(tb));
t('React 外壳保留窗口控制', /onWin\('minimize'\)/.test(tb) && /onWin\('maximize'\)/.test(tb));

const app = src('src/App.tsx');
t('App.tsx 把 navigate 传给 Titlebar', /onNavigate=\{handleNavigate\}/.test(app));
t('App.tsx 把 emit 传给 Titlebar', /onEmit=\{handleEmit\}/.test(app));
t('App.tsx 的 emit 走宿主总线', /hostRef\.current\?\.bus\?\.emit/.test(app));

/* ---------------------------------------------------------------- */
console.log('\n=== 10. 打开凭据中心的链路 ===');

const afMain = src('plugins/agent-flow/main.tsx');
t('agent-flow 订阅了 nexus:open-credentials',
  /ctx\.on\?\.\('nexus:open-credentials'/.test(afMain));
t('agent-flow 把总线事件转成 window 事件',
  /dispatchEvent\(new CustomEvent\('nexus:open-credentials'/.test(afMain));

const afApp = src('plugins/agent-flow/App.tsx');
t('App 接住 window 事件并打开凭据中心',
  /addEventListener\('nexus:open-credentials'/.test(afApp) && /setCredOpen\(true\)/.test(afApp));
t('CredentialPanel 收到 initialPage', /initialPage=\{credPage\}/.test(afApp));

const cp = src('plugins/agent-flow/components/CredentialPanel.tsx');
t('CredentialPanel 用 initialPage 作初始值（不是写死 cred）',
  /useState<'cred' \| 'mcp'>\(initialPage \?\? 'cred'\)/.test(cp));

const mcpSrc = src('plugins/toolbar-mcp/module.js');
t('MCP 插件先 navigate 再 emit（反过来没人接）',
  mcpSrc.indexOf("api.navigate('agent-flow')") < mcpSrc.indexOf("api.emit('nexus:open-credentials'"));

/* ---------------------------------------------------------------- */
console.log('\n=== 10.5 loadRegistry 确实是异步（不 await 就崩） ===');

const hostMod = await import('./js/host.js');
t('loadRegistry 是函数', typeof hostMod.loadRegistry === 'function');
const lr = hostMod.loadRegistry();
t('loadRegistry 返回 Promise（必须 await）',
  lr && typeof lr.then === 'function');
t('Promise resolve 后是数组（能 .filter）',
  Array.isArray(await lr), String(Object.prototype.toString.call(await lr)));
const list = await hostMod.loadRegistry();
t('清单里含 4 个 toolbar 插件',
  list.filter((p) => p.kind === 'toolbar').length === 4,
  String(list.filter((p) => p.kind === 'toolbar').map((p) => p.id).join(',')));

/* ---------------------------------------------------------------- */
console.log('\n=== 11. CSS ===');

const css = src('css/neumorphism.css');
t('有 .tb-toolbar 容器样式', /\.tb-toolbar \{/.test(css));
t('有菜单样式', /\.tb-menu \{/.test(css) && /\.tb-menu-item \{/.test(css));
t('菜单 layer 有层级（否则被内容盖住）', /\.tb-menu-layer \{[\s\S]{0,120}z-index/.test(css));
t('复用已存在的 .tb-btn.on（没有另写一套激活态）',
  (css.match(/\.tb-btn\.on \{/g) || []).length === 1);

/* ---------------------------------------------------------------- */
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
