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
  resetToolbar, toolbarDefs, allToolbarDefs, validateToolbarDef, loadToolbarPlugins, mountToolbar,
  setHidden, moveEntry, addExtra, removeExtra, toolbarEntriesOf, hiddenIds,
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
  [{ id: 'bad', kind: 'toolbar', type: 'iframe', entry: 'x' }],
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
  [{ id: 'ok', kind: 'toolbar', type: 'module' }, { id: 'boom', kind: 'toolbar', type: 'module' }],
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
  [{ id: 'c', kind: 'toolbar' }, { id: 'a', kind: 'toolbar' }, { id: 'b', kind: 'toolbar' }],
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
  [{ id: 'p1', kind: 'toolbar' }, { id: 'p2', kind: 'toolbar' }],
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
  [{ id: 'boom2', kind: 'toolbar' }],
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
  [{ id: 'm', kind: 'toolbar' }],
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
/*
 * React 外壳必须接住 mountToolbar 返回的清理函数。
 * 它的 effect 依赖里有 onWin/onToast 等回调，每次渲染都是新引用 → 反复重跑；
 * 不回收就是每重跑一次多一个 document 监听（检查器按钮会闪、提示会重复弹）。
 */
/*
 * mountToolbar 的回调必须带类型注解。
 * toolbar-plugin.js 是 .js 无类型声明，noImplicitAny 下这些参数
 * 会变成隐式 any（TS7006）；签名对不上时是**运行时**才炸。
 *
 * 加这条是因为实测踩过：改 mountToolbar 这个块时整块替换，
 * 把远端有意写的注解连同注释一起抹掉了。
 */
t('Titlebar 的 mountToolbar 回调带类型注解',
  /toast: \(msg: string, type\?: string\)/.test(tb)
  && /win: \(a: WinAction\)/.test(tb)
  && /navigate: \(id: string\)/.test(tb)
  && /emit: \(ev: string, payload\?: unknown\)/.test(tb));
t('Titlebar 接住了 mountToolbar 的清理函数',
  /const cleanups = mountToolbar\(/.test(tb) && /for \(const fn of cleanups/.test(tb));
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
const tbIds = list.filter((p) => p.kind === 'toolbar').map((p) => p.id);
/* 5 个：主题 / 置顶 / 托盘 / MCP 状态 / 元素检查器 */
t('清单里含 5 个 toolbar 插件', tbIds.length === 5, String(tbIds.join(',')));
t('元素检查器也在工具栏里（已从侧边栏搬走）', tbIds.includes('toolbar-inspector'));
t('每个 toolbar 插件都有 module.js 入口（不引 settings.css 那类 iframe 补丁）',
  list.filter((p) => p.kind === 'toolbar')
    .every((p) => /\/module\.js$/.test(p.entry || '')),
  String(list.filter((p) => p.kind === 'toolbar').map((p) => p.entry).join(' ')));

/* ---------------------------------------------------------------- */
console.log('\n=== 10.6 真实挂载：onInit 清理 + 检查器状态同步 ===');
/*
 * 用真实 DOM 挂载而不是查源码字符串。
 * "按钮高亮跟不跟得上快捷键"是运行期行为，
 * 字符串匹配证明不了它；"监听器有没有重复注册"更是如此。
 */
{
  resetToolbar();
  const insp = await import('./plugins/toolbar-inspector/module.js');
  const { setInspector, isInspectorOn: isOn } = await import('./js/inspector.js');

  /* 走真实加载路径（loadToolbarPlugins），而不是把 def 塞进登记表 ——
     后者会绕过 validateToolbarDef 与 iframe 校验，测不到真加载链路 */
  const n = await loadToolbarPlugins(
    [{ id: 'toolbar-inspector', kind: 'toolbar', type: 'module' }],
    { loadModule: async () => insp },
  );
  t('检查器插件能被真实加载链路加载', n === 1, `加载 ${n} 个`);

  const box = document.createElement('div');
  document.body.appendChild(box);

  const cleanups = mountToolbar(box, {
    toast: () => {},
    /* 与宿主一致的注入方式 */
    inspector: { isOn: () => setInspector.__probe ?? isOn(), toggle: () => setInspector(!isOn()) },
  });
  const btn = box.querySelector('[data-toolbar-id="toolbar-inspector"]');
  t('检查器按钮已渲染', !!btn, btn ? btn.textContent : '（没有）');

  /* 快捷键开 → 按钮要跟着亮（这是搬运后最容易丢的一条） */
  setInspector(true);
  t('外部开启后按钮高亮（快捷键/ESC 也能同步）',
    btn.classList.contains('on'));
  setInspector(false);
  t('外部关闭后按钮灭掉', !btn.classList.contains('on'));

  /* 清理：onInit 返回的函数要被 collect */
  t('mountToolbar 回收了 onInit 的清理函数',
    Array.isArray(cleanups) && cleanups.length >= 1, `${cleanups?.length} 个`);

  for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }

  /* 注销后再开检查器，按钮不该再被改（证明监听真摘掉了） */
  btn.classList.remove('on');
  setInspector(true);
  t('注销监听后按钮不再被改（证明真摘掉了）', !btn.classList.contains('on'));

  /*
   * 重复挂载不该让监听器翻倍。
   * React 外壳的 effect 依赖里有回调，每次渲染都是新引用 → 会反复重跑。
   * 不回收的话事件处理跟着跑 N 遍。
   */
  resetToolbar();
  const api1 = { toast: () => {}, inspector: { isOn, toggle: () => setInspector(!isOn()) } };
  const c1 = mountToolbar(box, api1);
  const c2 = mountToolbar(box, api1);
  const btn2 = box.querySelector('[data-toolbar-id="toolbar-inspector"]');
  let hits = 0;
  const probe = () => { hits++; };
  document.addEventListener('nexus:inspector-toggle', probe);
  /* 只回收第二批：第一批若没被回收，这里会数到 2 */
  for (const fn of c2) { try { fn(); } catch { /* ignore */ } }
  setInspector(false);
  setInspector(true);
  t('重复挂载后只留一个监听（旧的被回收）', hits === 2, `事件派发 ${hits} 次`);
  document.removeEventListener('nexus:inspector-toggle', probe);
  for (const fn of [...c1, ...c2]) { try { fn(); } catch { /* ignore */ } }
  setInspector(false);
  void insp;
}

/* ---------------------------------------------------------------- */
console.log('\n=== 10.8 入口管理：隐藏 / 排序 / 添加（走真实存储） ===');
/*
 * 用真实 localStorage 跑，不查源码字符串。
 * "隐藏了还在不在"、"排了序生效没"是运行期行为，
 * 字符串匹配证明不了。
 */
{
  resetToolbar();
  const manifests = [
    { id: 'toolbar-theme', kind: 'toolbar', name: '主题', icon: '◐' },
    { id: 'toolbar-pin', kind: 'toolbar', name: '置顶', icon: '⇱' },
    { id: 'home', kind: 'app', name: '概览', icon: '◈' },
  ];
  const n = await loadToolbarPlugins(manifests, {
    loadModule: async (m) => ({ default: { id: m.id, label: m.icon, order: 10, onClick() {} } }),
    onError: () => {},
  });
  /* 2 个 toolbar 插件；home 没声明 toolbar、也没被手动加 → 不生成入口 */
  t('只加载 kind:toolbar 的（应用插件默认不占右上角）', n === 2, `加载 ${n}`);

  let ids = toolbarDefs().map((d) => d.id);
  t('两个按钮都在', ids.length === 2, ids.join(','));

  /* 隐藏 */
  setHidden('toolbar-theme', true);
  ids = toolbarDefs().map((d) => d.id);
  t('隐藏后不再出现在渲染列表', !ids.includes('toolbar-theme') && ids.length === 1, ids.join(','));
  t('但仍在全部列表里（设置页要能再显示出来）',
    allToolbarDefs().some((d) => d.id === 'toolbar-theme'));

  /* 排序 */
  setHidden('toolbar-theme', false);
  moveEntry('toolbar-pin', -1);
  ids = toolbarDefs().map((d) => d.id);
  t('上移生效', ids[0] === 'toolbar-pin', ids.join(','));
  t('排序持久化到 localStorage',
    JSON.parse(localStorage.getItem('nexus:toolbar-order') || '[]')[0] === 'toolbar-pin');

  /* 手动添加应用插件入口 */
  addExtra('home');
  await loadToolbarPlugins(manifests, {
    loadModule: async (m) => ({ default: { id: m.id, label: m.icon, order: 10, onClick() {} } }),
    onError: () => {},
  });
  ids = toolbarDefs().map((d) => d.id);
  t('手动添加的入口出现了', ids.includes('tb-entry:home'), ids.join(','));

  const homeDef = toolbarDefs().find((d) => d.id === 'tb-entry:home');
  let navigated = null;
  homeDef.onClick({ navigate: (id) => { navigated = id; } });
  t('点了切到对应插件', navigated === 'home', String(navigated));

  /* 移除入口 */
  removeExtra('home');
  await loadToolbarPlugins(manifests, {
    loadModule: async (m) => ({ default: { id: m.id, label: m.icon, order: 10, onClick() {} } }),
    onError: () => {},
  });
  t('移除后入口消失', !toolbarDefs().some((d) => d.id === 'tb-entry:home'));

  /* 入口推导：设置页与加载器同源 */
  addExtra('home');
  /*
   * 必须重新 load 一次：addExtra 只改存储，def 要重新生成。
   * 少了这一步，两边比的就是"存储里的 3 个"和"内存里的 2 个"——
   * 那是测试自己写错了，不是代码有问题。
   */
  await loadToolbarPlugins(manifests, {
    loadModule: async (m) => ({ default: { id: m.id, label: m.icon, order: 10, onClick() {} } }),
    onError: () => {},
  });
  const entries = toolbarEntriesOf(manifests);
  t('toolbarEntriesOf 列出全部入口（含隐藏的）',
    entries.length === 3, entries.map((e) => e.id).join(','));
  t('入口顺序与渲染一致',
    entries.map((e) => e.id).join(',') === allToolbarDefs().map((d) => d.id).join(','),
    entries.map((e) => e.id).join(','));
  resetToolbar();
}

/* ---------------------------------------------------------------- */
console.log('\n=== 10.7 插件不得自行 import 宿主单例模块 ===');
/*
 * inspector.js 的 on/locked 是模块级单例。工具栏插件走 import.meta.glob
 * 动态 import → 独立 chunk。若它自己 import，inspector.js 可能被复制一份，
 * 按钮读到的就是另一份 on —— 高亮永远同步不上，且不报错、类型检查也看不出。
 *
 * 沙盒装不上 vite，无法实测产物；所以这条断言是**事前约束**：
 * 强制走宿主注入，从根上排除这种可能。
 */
{
  const m = src('plugins/toolbar-inspector/module.js');
  const code = m.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  t('检查器插件不 import inspector.js（状态走宿主注入）',
    !/from\s+['"][^'"]*inspector\.js['"]/.test(code));
  t('检查器插件用 api.inspector', /api\.inspector\.isOn\(\)/.test(code) && /api\.inspector\.toggle\(\)/.test(code));
  t('宿主侧：shell.js 注入了 inspector',
    /inspector:\s*\{\s*isOn:\s*isInspectorOn,\s*toggle:\s*toggleInspector/.test(src('js/shell.js')));
  t('宿主侧：Titlebar 注入了 inspector',
    /inspector:\s*\{\s*isOn:\s*isInspectorOn,\s*toggle:\s*toggleInspector/.test(src('src/components/Titlebar.tsx')));
}

/* ---------------------------------------------------------------- */
console.log('\n=== 11. CSS ===');

const css = src('css/neumorphism.css');
t('有 .tb-toolbar 容器样式', /\.tb-toolbar \{/.test(css));
t('有菜单样式', /\.tb-menu \{/.test(css) && /\.tb-menu-item \{/.test(css));
t('菜单 layer 有层级（否则被内容盖住）', /\.tb-menu-layer \{[\s\S]{0,120}z-index/.test(css));
t('复用已存在的 .tb-btn.on（没有另写一套激活态）',
  (css.match(/\.tb-btn\.on \{/g) || []).length === 1);

/* ---------------------------------------------------------------- */
console.log('\n=== 12. loadModule 的入参契约 ===');

/*
 * toolbar-plugin.js 往下传的是**整个 manifest**，入口路径在 m.entry 上，
 * 调用方（宿主）负责取出来交给 loadModuleEntry。
 *
 * 两个真实调用点曾经直接透传 manifest 给 loadModuleEntry（后者要的是路径
 * 字符串），路径归一化得到 "[object Object]"、在 glob 表里永远匹配不到，
 * 结果是 5 个内置工具栏按钮**全部加载失败**。
 *
 * 这个 bug 之前能溜过去，是因为测试全都 mock 掉了 loadModule 这一层 ——
 * 恰好在被 mock 掉的地方出问题。所以除了运行时契约，这里再静态盯住
 * 两个宿主调用点，防止有人把 m.entry 又写回成 m。
 */
resetToolbar();
let handed = null;
await loadToolbarPlugins(
  [{ id: 'shape', kind: 'toolbar', type: 'module', entry: './plugins/shape/module.js' }],
  {
    loadModule: async (m) => {
      handed = m;
      return { default: { id: 'shape', label: 'S', onClick() {} } };
    },
    onError: () => {},
  },
);
t('loadModule 收到的是 manifest 对象（不是路径字符串）',
  handed !== null && typeof handed === 'object' && handed.id === 'shape');
t('manifest 上带着 entry —— 调用方据此取路径',
  handed !== null && handed.entry === './plugins/shape/module.js');

for (const f of ['src/components/Titlebar.tsx', 'js/shell.js']) {
  const code = src(f);
  t(f + '：loadModule 取的是 m.entry，不是透传 manifest',
    /loadModule:\s*\([^)]*\)\s*=>\s*loadModuleEntry\(\s*m\??\.entry/.test(code));
}

/* ---------------------------------------------------------------- */
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
