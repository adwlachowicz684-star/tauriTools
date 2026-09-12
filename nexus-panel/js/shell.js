/**
 * 原生外壳 UI 层（无构建模式）
 * ------------------------------------------------------------
 * 插件宿主逻辑全部在 js/host.js（与 React 外壳共用同一份引擎），
 * 这里只负责：DOM 绑定、侧边栏、路由、Toast、安装弹窗、快捷键。
 */

import {
  createHost, loadRegistry, getCustomPlugins, saveCustomPlugins,
  filterByRuntime, isInsideTauri,
} from './host.js';
import {
  applyTheme, setAccent, setThemeColor, getThemeColor, getCurrent, exportVars, getBase,
} from './theme-manager.js';

const $ = (s) => document.querySelector(s);
const state = { badges: {} };

/* ---------------------------- Toast ---------------------------- */
function toast(msg, type = 'info') {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'info' ? '' : type);
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

/* ---------------------------- 宿主（主题在引擎内初始化） ---------------------------- */
const host = createHost({
  getStage: () => $('#stage-scroll'),
  hooks: {
    toast,
    onTitle: (t) => { $('#bar-title').textContent = t; $('#tb-title').textContent = t; },
    onSubtitle: (t) => { $('#bar-sub').textContent = t; },
    onBadges: (b) => { state.badges = b; syncBadges(); },
    onActive: (id) => {
      document.querySelectorAll('.nav-item').forEach((el) =>
        el.classList.toggle('active', el.dataset.id === id));
    },
    onOpen: (id) => navigate(id),
  },
});

/* ---------------------------- 侧边栏 ---------------------------- */
function renderSidebar() {
  const list = $('#plugin-list');
  if (!list) return;
  list.innerHTML = '';
  for (const p of host.getPlugins()) {
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (p.id === host.state.activeId ? ' active' : '');
    btn.dataset.id = p.id;
    btn.title = p.name + (p.type === 'iframe' ? '（沙箱）' : '（同页）');
    btn.innerHTML = `<span class="nav-icon">${p.icon || '◌'}</span>
      <span class="nav-label">${p.name}</span>
      <span class="nav-badge" data-badge="${p.id}"></span>`;
    btn.addEventListener('click', () => navigate(p.id));
    list.appendChild(btn);
  }
  syncBadges();
}

function syncBadges() {
  document.querySelectorAll('[data-badge]').forEach((el) => {
    const n = state.badges[el.dataset.badge];
    el.textContent = n > 99 ? '99+' : (n || '');
    el.style.display = n ? 'grid' : 'none';
  });
}

/* ---------------------------- 路由 ---------------------------- */
function navigate(id) {
  if (location.hash.slice(1) === id) host.mount(id);
  else location.hash = id;
}
async function route() {
  const id = location.hash.slice(1) || host.getPlugins()[0]?.id || '';
  await host.mount(id);
}

/* ---------------------------- 安装插件 ---------------------------- */
function openAddDialog() {
  const mask = document.createElement('div');
  mask.className = 'mask';
  const box = document.createElement('div');
  box.className = 'p-card dialog';
  box.innerHTML = `
    <h2 style="margin-bottom:18px">安装插件</h2>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div><div class="p-muted" style="margin-bottom:6px">插件名称</div>
        <input class="p-input" id="p-name" placeholder="例如：日志查看器"></div>
      <div><div class="p-muted" style="margin-bottom:6px">入口文件（相对项目根目录）</div>
        <input class="p-input" id="p-entry" placeholder="./plugins/my-plugin/index.html"></div>
      <div><div class="p-muted" style="margin-bottom:6px">图标（可选，单字符）</div>
        <input class="p-input" id="p-icon" placeholder="◆" maxlength="2"></div>
      <div><div class="p-muted" style="margin-bottom:6px">挂载模式</div>
        <select class="p-input" id="p-type">
          <option value="iframe">沙箱 iframe（默认·推荐）</option>
          <option value="module">同页模块（可直调 Rust）</option>
        </select></div>
      <div><div class="p-muted" style="margin-bottom:6px">插件自身基调（影响主题适配）</div>
        <select class="p-input" id="p-theme">
          <option value="auto">自动检测</option>
          <option value="dark">与面板同基调（不适配）</option>
          <option value="light">与面板相反（需适配）</option>
        </select></div>
    </div>
    <div class="p-row" style="margin-top:20px;justify-content:flex-end">
      <button class="p-btn" id="p-cancel">取消</button>
      <button class="p-btn primary" id="p-ok">添加</button>
    </div>`;
  mask.appendChild(box);
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => e.target === mask && mask.remove());
  box.querySelector('#p-cancel').onclick = () => mask.remove();
  box.querySelector('#p-ok').onclick = async () => {
    const name = box.querySelector('#p-name').value.trim();
    const entry = box.querySelector('#p-entry').value.trim();
    if (!name || !entry) { toast('名称与入口路径必填', 'err'); return; }
    const p = {
      id: 'custom-' + Date.now().toString(36),
      name, entry, custom: true,
      type: box.querySelector('#p-type').value,
      icon: box.querySelector('#p-icon').value.trim() || '◌',
      theme: box.querySelector('#p-theme').value,
    };
    saveCustomPlugins([...getCustomPlugins(), p]);
    mask.remove();
    toast(`已添加「${name}」`, 'ok');
    await init(true);
    navigate(p.id);
  };
  box.querySelector('#p-name').focus();
}

window.__nexusRemovePlugin = async (id) => {
  host.removePlugin(id);
  toast('已移除插件', 'ok');
  await init(true);
  navigate(host.getPlugins()[0]?.id || 'home');
};

/* ---------------------------- 启动 ---------------------------- */
async function init(refresh = false) {
  host.state.plugins = refresh
    ? filterByRuntime(await loadRegistry())
    : filterByRuntime(await loadRegistry());
  renderSidebar();
}

(async function () {
  await init();

  const saved = localStorage.getItem('nexus:sidebar-open');
  $('#body').classList.toggle('open', saved === null ? true : saved === '1');

  $('#side-toggle').onclick = () => {
    const open = $('#body').classList.toggle('open');
    localStorage.setItem('nexus:sidebar-open', open ? '1' : '0');
  };
  $('#btn-min').onclick = () => host.win('minimize');
  $('#btn-max').onclick = () => host.win('maximize');
  $('#btn-close').onclick = () => host.win('close');
  $('#btn-top').onclick = (e) => { e.currentTarget.classList.toggle('on'); host.win('topmost'); };
  $('#btn-add').onclick = openAddDialog;
  $('#btn-settings').onclick = () => navigate('settings');
  $('#bar-reload').onclick = () => host.state.activeId && host.mount(host.state.activeId);

  window.addEventListener('hashchange', route);
  if (!location.hash) {
    const last = localStorage.getItem('nexus:last-plugin');
    location.hash = last && host.getPlugins().some((p) => p.id === last)
      ? last : (host.getPlugins()[0]?.id || '');
  }
  await route();
  window.addEventListener('beforeunload', () =>
    localStorage.setItem('nexus:last-plugin', host.state.activeId));

  window.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'b') { e.preventDefault(); $('#side-toggle').click(); }
    if (meta && e.key.toLowerCase() === 'r' && host.state.activeId) {
      e.preventDefault(); host.mount(host.state.activeId);
    }
  });

  if (!isInsideTauri()) toast('当前为浏览器调试模式，Rust 命令不可用', 'err');

  window.__NEXUS__ = {
    state: host.state, bus: host.bus, toast, navigate,
    mountPlugin: (id) => host.mount(id),
    getPlugins: () => host.getPlugins(),
    getInstance: () => host.state.instance,
    removePlugin: (id) => window.__nexusRemovePlugin(id),
    theme: { applyTheme, setAccent, setThemeColor, getThemeColor, getCurrent, exportVars, getBase },
  };
})();
