/**
 * 原生外壳 UI 层（无构建模式）
 * ------------------------------------------------------------
 * 插件宿主逻辑全部在 js/host.js（与 React 外壳共用同一份引擎），
 * 这里只负责：DOM 绑定、侧边栏、路由、Toast、安装弹窗、快捷键。
 */

import {
  createHost, loadRegistry, getCustomPlugins, saveCustomPlugins,
  filterByRuntime, visiblePlugins, isInsideTauri, escapeHtml,
} from './host.js';
import {
  applyTheme, setAccent, getCurrent, exportVars, getBase,
  listThemes,        // 插件主题下拉：按基调分列可选主题
} from './theme-manager.js';
import { h } from './plugin-sdk.js';
import * as extPolicy from './external-policy.js';
import { getPluginConfig, setPluginConfig } from './plugin-config.js';
import { openThemePicker } from './theme-picker.js';
import { installTooltip, refreshTooltip } from './tooltip.js';
import { installInspector, toggleInspector, isInspectorOn, escInspector } from './inspector.js';
import {
  loadToolbarPlugins, mountToolbar, TOOLBAR_EVENT,
} from './toolbar-plugin.js';
import { loadModuleEntry } from './plugin-entries.js';

import { confirm as askConfirm } from './dialog.js';
const $ = (s) => document.querySelector(s);
const state = { badges: {} };

/** requestAnimationFrame 在部分环境（jsdom / 旧 WebView）缺失，降级到定时器 */
const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 16);

/* ---------------------------- Toast ---------------------------- */
function toast(msg, type = 'info') {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  /* 同时挂 .nx-toast：基础表现在 css/controls.css 里（与插件共用一套）。
     .toast 仍保留是因为既有代码/测试可能按它查找 */
  el.className = 'nx-toast toast' + (type === 'info' ? '' : ' ' + type);
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    /* 淡出时长读 --dur-slow，与入场动画 nx-toast-in 同档。
       写死 0.3s 的话，用户调快动效时入场快、退场慢，节奏会割裂 */
    const d = getComputedStyle(document.documentElement)
      .getPropertyValue('--dur-slow').trim() || '260ms';
    el.style.transition = `opacity ${d}`;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

/* 悬浮提示：接管原生 title，鼠标移上去立刻显示（原生有约 1 秒延迟，无法调整）。
   必须在插件挂载前安装 —— 插件自己的按钮也带 title。 */
installTooltip();
/* 开发者模式 · 元素检查器：Ctrl/Cmd + Shift + D 开关。
   装在宿主之前 —— 插件挂载后它内部的控件也要能查。 */
installInspector();

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
    // 「⚙ 设置」对**每个**插件都显示，不再要求插件自带设置面板：
    // 抽屉里除了插件自定义设置，还有外壳固定提供的那一段（沙箱隔离），
    // 它对任何插件都有实际意义，点开永远有内容。
    // 所以显隐只看"有没有激活插件"，不看插件有没有 settings。
    // host 在此处可能尚未赋值（createHost 期间同步回调），故用可选链。
    onSettingsAvailable: (has) => {
      const btn = $('#bar-plugin-settings');
      if (btn) btn.hidden = !host?.state?.activeId;
      // 切插件 / 重载时收起已开的抽屉（它的内容按 manifest 挂载，
      // 留着会显示上一个插件的设置）
      if (!has) closePluginSettings();
    },
    // 焦点在 iframe 插件里时，由插件把外壳保留键转发过来执行
    onShellShortcut: (combo) => runShellShortcutRef?.(combo),
    // 插件内部被 CSP 拦下的外链（跨文档事件外壳收不到，靠插件转发）
    onCspViolation: (d, manifest) => onPluginCspViolation(d, manifest),
  },
});

// runShellShortcut 在下方定义，用引用延迟绑定（hooks 在 createHost 时就可能被回调）
let runShellShortcutRef = null;

/* ---------------------------- 侧边栏 ---------------------------- */
function renderSidebar() {
  const list = $('#plugin-list');
  if (!list) return;
  list.innerHTML = '';
  /* 服务插件不进侧边栏 —— 它们没有主视图，列出来只会点开一片空白。
     过滤放在渲染处而非数据源：宿主仍要持有完整列表（服务要靠它挂载）。 */
  for (const p of visiblePlugins(host.getPlugins())) {
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (p.id === host.state.activeId ? ' active' : '');
    btn.dataset.id = p.id;
    btn.title = p.name + (p.type === 'iframe' ? '（沙箱）' : '（同页）');
    // 插件名/图标可能来自用户安装时的输入，必须转义后写入（防存储型 XSS）
    btn.innerHTML = '';
    btn.appendChild(h('span.nav-icon', {}, p.icon || '◌'));
    btn.appendChild(h('span.nav-label', {}, p.name));
    btn.appendChild(h('span.nav-badge', { 'data-badge': p.id }));
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

/* ---------------------------- 外链 ---------------------------- */

/** 记录一次被 CSP 拦下的外链；智能提醒模式下提示用户去决策 */
function onPluginCspViolation(d, manifest) {
  const host = extPolicy.hostOf(d.blockedURI);
  if (!host || extPolicy.LOCAL_HOSTS.has(host)) return;

  const policy = extPolicy.loadPolicy();
  const decision = extPolicy.decideHost(host, policy);
  if (decision === 'allow') return;               // 用户已信任（说明 CSP 还没配上）

  extPolicy.recordHosts([{
    host,
    kind: extPolicy.KIND_LABELS ? kindOf(d.directive) : 'unknown',
    sample: d.blockedURI,
  }], manifest?.id);

  if (decision === 'ask' && policy.mode === 'smart') {
    toast(`插件「${manifest?.name || ''}」想访问 ${host}，已拦下 · 设置里可放行`, 'err');
  } else if (decision === 'block') {
    console.warn('[external] 已拦截', host);
  }
  refreshExternalUI?.();
}

function kindOf(directive) {
  const s = String(directive || '').toLowerCase();
  if (s.includes('script')) return 'script';
  if (s.includes('frame')) return 'frame';
  if (s.includes('media')) return 'media';
  if (s.includes('img')) return 'image';
  if (s.includes('connect')) return 'fetch';
  if (s.includes('style') || s.includes('font')) return 'style';
  return 'unknown';
}

/** 设置页可能开着，给它一个刷新的机会 */
let refreshExternalUI = null;

/** 安装 / 更新插件时扫一遍外链（用户要求：每次导入与更新都检查） */
async function scanPluginExternal(p) {
  if (!p?.entry) return { ok: false, hosts: [] };
  const r = await extPolicy.scanEntry(p.entry, p.id);
  if (r.externalEntry) {
    toast(`⚠ 插件「${p.name}」的入口是外域地址，代码将来自网络`, 'err');
  } else if (r.hosts?.length && extPolicy.loadPolicy().mode === 'smart') {
    const names = r.hosts.map((x) => x.host).join('、');
    toast(`「${p.name}」检测到 ${r.hosts.length} 个外链：${names}`, 'err');
  }
  refreshExternalUI?.();
  return r;
}

/** 全量重扫（设置页「重新检查」按钮） */
async function rescanAllPlugins() {
  const list = host.getPlugins();
  let total = 0;
  for (const p of list) {
    const r = await extPolicy.scanEntry(p.entry, p.id).catch(() => ({ hosts: [] }));
    total += r.hosts?.length || 0;
  }
  toast(`已检查 ${list.length} 个插件，登记 ${total} 个外链`, 'ok');
  refreshExternalUI?.();
}

/* ---------------------------- 插件设置抽屉 ---------------------------- */
let settingsTeardown = null;

function closePluginSettings() {
  if (settingsTeardown) {
    try { settingsTeardown(); } catch (e) { console.error(e); }
    settingsTeardown = null;
  }
  const mask = $('#drawer-mask');
  if (mask) mask.remove();
}

async function openPluginSettings() {
  const manifest = host.getPlugins().find((p) => p.id === host.state.activeId);
  if (!manifest) return;
  closePluginSettings();

  const mask = document.createElement('div');
  mask.className = 'mask drawer-mask';
  mask.id = 'drawer-mask';

  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <header class="drawer-head">
      <div class="drawer-title">
        <h2>⚙ ${escapeHtml(manifest.name)}</h2>
        <span class="p-muted" style="font-size:11px">
          ${manifest.type === 'iframe' ? '沙箱模式' : '同页模式'}${manifest.version ? ' · v' + escapeHtml(manifest.version) : ''}
        </span>
      </div>
      <button class="tb-btn" id="dw-close" title="关闭">✕</button>
    </header>
    <div class="drawer-scroll">
      <div class="drawer-body" id="dw-body">
        <div class="loader"><div class="spinner"></div>正在载入设置…</div>
      </div>
      <div id="dw-shell"></div>
    </div>`;
  mask.appendChild(drawer);
  document.body.appendChild(mask);
  raf(() => mask.classList.add('on'));

  mask.addEventListener('click', (e) => { if (e.target === mask) closePluginSettings(); });
  drawer.querySelector('#dw-close').onclick = closePluginSettings;

  renderShellSection(drawer.querySelector('#dw-shell'), manifest);

  const body = drawer.querySelector('#dw-body');
  /* 插件不一定提供了自己的设置面板。没提供就**别让引擎挂载**：
     SDK 的 settingsFn 缺省时会回退 mainFn（js/plugin-sdk.js），
     那样抽屉里显示的是插件主界面，而不是设置。
     这里直接给占位提示，下面的外壳区块照常可用。 */
  if (host.hasSettings()) {
    try {
      settingsTeardown = await host.mountSettings(body, manifest);
    } catch (err) {
      console.error('[plugin settings]', err);
      body.innerHTML = `
        <div class="err-box">
          <h3>⚠ 设置面板加载失败</h3>
          <pre>${escapeHtml(String(err?.message || err))}</pre>
        </div>`;
    }
  } else {
    body.innerHTML = `
      <div class="nx-empty drawer-empty">
        「${escapeHtml(manifest.name)}」没有提供自己的设置面板。
        <br />
        下面的沙箱设置由外壳提供，对所有插件都有效。
      </div>`;
  }
}

/**
 * 抽屉里由外壳提供的固定区块：沙箱隔离开关 + 本插件的外链。
 * 放在插件自己的设置内容**下方**，两者互不干扰。
 *
 * ⚠️ 这里原先还有第二个开关「主题适配」（adaptTheme）。
 * 它控制的是那套给插件罩滤镜、把浅色翻深色的机制 —— 该机制已整套删除
 * （外壳推变量，插件渲染成什么样就是什么样，插件写死是插件自己的事）。
 * 机制没了之后这个开关就成了"拨了没反应"的假控件，一并删掉。
 * 清理时只删了设置页（App.tsx）那半边，shell.js 这半边漏了 ——
 * 所以无构建模式下打开插件抽屉，仍能看到一个毫无作用的开关。
 */
function renderShellSection(box, manifest) {
  if (!box) return;
  const cfg = getPluginConfig(manifest.id);

  const toggleRow = (label, desc, keyName) => {
    const btn = h('button.p-btn', {
      class: cfg[keyName] ? 'primary' : '',
      style: { height: '30px', padding: '0 12px', fontSize: '12px', flex: 'none' },
    }, cfg[keyName] ? '已开启' : '已关闭');
    const hint = h('div.p-muted', { style: { fontSize: '11px', marginTop: '2px', lineHeight: '1.7' } }, '');
    return { btn, hint, row: h('div.p-row', {
      style: {
        padding: '12px 14px', marginTop: '10px', borderRadius: 'var(--r)',
        background: 'var(--surface-sunk)',
        boxShadow: 'inset 3px 3px 6px var(--sh-dark), inset -3px -3px 6px var(--sh-light)',
      },
    },
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { style: { fontSize: '13px' } }, label),
        hint,
      ),
      btn,
    ) };
  };

  const isoTexts = {
    on: '切断插件直连主平台的通道，同时彻底阻断插件之间互访；ctx.invoke / store / 事件 / 主题 等能力通过桥接完整保留。',
    off: '插件与主平台同源，可直连访问（parent / localStorage / Tauri IPC）；代价是插件之间理论上也能互访。',
  };

  const rows = [];
  for (const [label, keyName, texts] of [
    ['严格沙箱', 'isolated', isoTexts],
  ]) {
    const t = toggleRow(label, '', keyName);
    t.hint.textContent = cfg[keyName] ? texts.on : texts.off;
    t.btn.onclick = () => {
      const next = setPluginConfig(manifest.id, { [keyName]: !getPluginConfig(manifest.id)[keyName] });
      t.btn.classList.toggle('primary', !!next[keyName]);
      t.btn.textContent = next[keyName] ? '已开启' : '已关闭';
      t.hint.textContent = next[keyName] ? texts.on : texts.off;
      toast('已保存，重载插件后生效', 'ok');
    };
    rows.push(t.row);
  }

  /* ---- 插件自选主题：深色一套、浅色一套 ----
     语义不是"锁定深浅"，而是"整体是深色时用哪套、浅色时用哪套"：
     两个都选了，插件就跟着整体的深浅在自己这两套之间切，
     但不会跟着用户在同基调里换主题（比如从石墨换到极光）。 */
  const themeRow = (label, key, base) => {
    const all = listThemes().filter((t) => t.base === base);
    const sel = h('select.p-input', {
      style: { height: '30px', fontSize: '12px', padding: '0 8px', flex: '1', minWidth: '0' },
    },
      h('option', { value: '' }, '跟随全局'),
      ...all.map((t) => h('option', { value: t.id, selected: cfg[key] === t.id }, t.name)),
    );
    sel.onchange = () => {
      setPluginConfig(manifest.id, { [key]: sel.value || null });
      // 主题是即时生效的（host 订阅了配置变更并会重推变量），不需要重载。
      // 与上面「沙箱与主题」两个开关不同 —— 那两个确实要重载。
      toast('已保存', 'ok');
    };
    return h('div.p-row', {
      style: {
        padding: '12px 14px', marginTop: '10px', borderRadius: 'var(--r)',
        background: 'var(--surface-sunk)',
        boxShadow: 'inset 3px 3px 6px var(--sh-dark), inset -3px -3px 6px var(--sh-light)',
      },
    },
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { style: { fontSize: '13px' } }, label),
        h('div.p-muted', {
          style: { fontSize: '11px', marginTop: '2px', lineHeight: '1.7' },
        }, base === 'dark' ? '整体主题为深色时，本插件用这套' : '整体主题为浅色时，本插件用这套'),
      ),
      sel,
    );
  };

  box.innerHTML = '';
  box.appendChild(
    h('div.p-card', {},
      h('h2', {}, '沙箱与主题'),
      h('div.p-muted', { style: { lineHeight: '1.9' } },
        '两个开关互相独立。改动在下次加载该插件时生效。'),
      ...rows,
      manifest.type !== 'iframe'
        ? h('div.p-muted', { style: { marginTop: '10px', fontSize: '11px' } },
            '同页插件不受影响 —— 它本来就跑在主页面里。')
        : null,
      h('div.p-muted', {
        style: {
          marginTop: '12px', paddingTop: '10px', fontSize: '10.5px', lineHeight: '1.8',
          borderTop: '1px solid var(--hairline)',
        },
      },
        '注意：「严格沙箱」切断的是直连通道，不是能力。以下能力',
        h('b', {}, '无论开关如何都照常可用'),
        '（它们在主平台侧执行）：ctx.invoke 调 Rust、ctx.store 持久化、'
        + 'ctx.on/emit 跨插件事件、ctx.setTitle/setBadge/toast、主题同步。',
      ),
    ),
    h('div.p-card', {},
      h('h2', {}, '插件主题'),
      h('div.p-muted', { style: { lineHeight: '1.9', marginBottom: '4px' } },
        '分别为深色 / 浅色各挑一套。选好后，本插件只跟随整体主题的',
        h('b', {}, '深浅'),
        '在自己这两套之间切换，不再跟随你在同基调里换哪套主题。留空则跟随全局。'),
      themeRow('深色时用', 'themeDark', 'dark'),
      themeRow('浅色时用', 'themeLight', 'light'),
    ),
  );

  // 本插件登记的外链
  const mine = extPolicy.listHosts().filter((x) => x.pluginId === manifest.id);
  if (mine.length) {
    box.appendChild(
      h('div.p-card', {},
        h('h2', {}, `外链 · ${mine.length}`),
        h('div.p-muted', { style: { marginBottom: '10px', fontSize: '11px' } },
          '扫描插件入口得到。全局策略与逐条放行在「设置 → 外链」里改。'),
        ...mine.map((x) => hostRow(x)),
      ),
    );
  }
}

function hostRow(x) {
  const label = x.status === 'trusted' ? '已信任'
    : x.status === 'blocked' ? '已禁止' : '待决定';
  return h('div.p-row', {
    style: {
      padding: '10px 12px', marginTop: '8px', borderRadius: 'var(--r-sm)',
      background: 'var(--surface-sunk)',
      boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
    },
  },
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('div.p-mono', { style: { fontSize: '12px' } }, x.host),
      h('div.p-muted', { style: { fontSize: '10.5px', marginTop: '2px' } },
        `${extPolicy.KIND_LABELS[x.kind] || x.kind} · ${label}`),
    ),
    h('span.p-tag', {
      class: x.status === 'trusted' ? 'ok' : x.status === 'blocked' ? 'danger' : '',
    }, label),
  );
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

/* ---------------------------- 插件面板（商店） ---------------------------- */
/*
 * 原本只是一个"填表单装插件"的小对话框，现在扩成插件面板：
 * 已安装（应用/服务两区）+ 添加。
 *
 * 服务插件单独一区，是因为它们**不显示在侧边栏** ——
 * 不在这里给入口，用户根本不知道装了哪些服务。
 */
function openAddDialog() {
  const mask = document.createElement('div');
  mask.className = 'mask';
  const box = document.createElement('div');
  box.className = 'p-card dialog';
  box.style.maxHeight = '84vh';
  box.style.display = 'flex';
  box.style.flexDirection = 'column';

  /* 已安装列表：在表单上方直接列出，不另开分页 ——
     原生版没有 React 的组件树，再套一层分页状态反而更绕。 */
  const all = host.getPlugins ? host.getPlugins() : [];
  const apps = visiblePlugins(all);
  const svcs = (all || []).filter((p) => p.kind === 'service');
  const rowHtml = (p) => {
    const meta = [
      p.version ? 'v' + p.version : null,
      p.builtin ? '内置' : null,
      p.custom ? '自定义' : null,
      p.kind === 'service' ? '服务插件' : (p.type === 'iframe' ? '沙箱' : '同页'),
      p.interactive ? '交互' : null,
    ].filter(Boolean).join(' · ');
    return `<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;
        margin-top:8px;border-radius:var(--r-sm);background:var(--surface-sunk);
        box-shadow:inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)">
      <div style="font-size:18px;line-height:1.4;width:24px;text-align:center">${p.icon || '◈'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600">${escapeHtml(p.name)}</div>
        <div class="p-muted" style="font-size:11px;margin-top:2px">${escapeHtml(meta)}</div>
        ${p.description ? `<div class="p-muted" style="font-size:11px;margin-top:4px;line-height:1.6">${escapeHtml(p.description)}</div>` : ''}
      </div></div>`;
  };
  const installedHtml = `
    <div style="overflow-y:auto;flex:1;min-height:0;margin-bottom:12px">
      <h3 style="font-size:13px;margin:4px 0 2px">应用插件</h3>
      <div class="p-muted" style="font-size:11px;line-height:1.6">显示在侧边栏，点开即用。</div>
      ${apps.length ? apps.map(rowHtml).join('') : '<div class="p-muted" style="padding:12px 0">还没有安装应用插件。</div>'}
      <h3 style="font-size:13px;margin:16px 0 2px">服务插件</h3>
      <div class="p-muted" style="font-size:11px;line-height:1.6">不显示在侧边栏，由其它插件通过 ctx.services.call 调用。</div>
      ${svcs.length ? svcs.map(rowHtml).join('') : '<div class="p-muted" style="padding:12px 0">还没有服务插件。</div>'}
    </div>`;

  box.innerHTML = `
    <h2 style="margin-bottom:12px">插件</h2>
    ${installedHtml}
    <div style="border-top:1px solid var(--edge);padding-top:12px">
    <h3 style="font-size:13px;margin:0 0 10px">添加</h3>
    <div style="display:flex;flex-direction:column;gap:12px">
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
    </div>
    </div>
    <div class="p-muted" style="font-size:11px;line-height:1.6;margin-top:10px">
      未来可从此浏览在线插件目录并直接安装、卸载；当前版本仅支持手动添加。
    </div>
    </div>
    <div class="p-row" style="margin-top:16px;justify-content:flex-end">
      <button class="p-btn" id="p-cancel">关闭</button>
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

    // A3：外域代码不该被当成本地插件装进来
    if (extPolicy.isExternal(entry)) {
      const host = extPolicy.hostOf(entry);
      /* 用通用弹窗而不是 window.confirm：原生对话框长相由浏览器决定，
         深色面板上是个突兀的白框，也不跟随主题。 */
      const go = await askConfirm({
        title: '安装外域插件',
        message: `⚠ 这个插件的入口是外域地址：\n\n${host}\n\n`
          + `它的代码会由 ${host} 提供，并能访问本面板的数据。\n`
          + `确定要安装吗？（建议只在完全信任该来源时继续）`,
        okText: '仍然安装',
        danger: true,
      });
      if (!go) return;
    }
    const p = {
      id: 'custom-' + Date.now().toString(36),
      name, entry, custom: true,
      type: box.querySelector('#p-type').value,
      icon: box.querySelector('#p-icon').value.trim() || '◌',
    };
    saveCustomPlugins([...getCustomPlugins(), p]);
    mask.remove();
    toast(`已添加「${name}」`, 'ok');
    await init();
    navigate(p.id);
    await scanPluginExternal(p);      // 导入即检查外链
  };
  box.querySelector('#p-name').focus();
}

window.__nexusRemovePlugin = async (id) => {
  host.removePlugin(id);
  toast('已移除插件', 'ok');
  await init();
  navigate(host.getPlugins()[0]?.id || 'home');
};

/* ---------------------------- 启动 ---------------------------- */
async function init() {
  host.state.plugins = filterByRuntime(await loadRegistry());
  renderSidebar();
}

/**
 * 加载并渲染工具栏插件（右上角那一排）。
 *
 * 放在这里而不是塞进 init()，是因为它依赖 toast / navigate 这些
 * 已经建好的外壳能力；插件拿到的 api 就是这几个。
 */
async function initToolbar() {
  const slot = $('#tb-toolbar');
  if (!slot) return;
  /*
   * loadRegistry 是 **async**（它要动态 import registry.js 并合并自定义插件），
   * 必须 await —— 不 await 拿到的是 Promise，下面的 .filter 会直接抛
   * TypeError: all.filter is not a function。
   *
   * 而 initToolbar 是在 IIFE 里 await 的，这个错会冒上去让**整个外壳初始化
   * 失败**（不只是少一排按钮）。
   */
  const all = (await loadRegistry()) || [];
  /*
   * 传**全部**清单，由 loadToolbarPlugins 自己筛：
   * 除了 kind:'toolbar'，还要处理"应用插件声明了 toolbar 入口"
   * 和"用户在设置里手动添加的插件"两类。
   * 在这里 filter 掉的话，后两种永远不会出现 ——
   * 表现就是"设置里加了入口，右上角却没反应"。
   */
  const reload = async () => {
    await loadToolbarPlugins(all, {
      /* 传 m.entry 而不是 m：loadToolbarPlugins 给的是整个 manifest，
         loadModuleEntry 要的是入口路径字符串 —— 透传 manifest 会让
         路径归一化得到 "[object Object]"，所有工具栏插件都加载失败。 */
      loadModule: (m) => loadModuleEntry(m.entry),
      onError: (id, e) => {
        console.warn('[toolbar] 加载失败', id, e);
        toast(`工具栏插件「${id}」加载失败：${e?.message || e}`, 'err');
      },
    });
    mountToolbar(slot, {
      toast,
      win: (a) => host.win(a),
      navigate,
      /*
       * 检查器能力注入给工具栏插件。
       * 插件**不要**自己 import inspector.js —— 它会被打进独立 chunk，
       * 那份模块级单例（on / locked）就成了第二份，按钮高亮永远不同步。
       */
      inspector: { isOn: isInspectorOn, toggle: toggleInspector },
      /* 工具栏插件走宿主总线。bus 是外壳与插件共用的那一套，
         agent-flow 用 ctx.on 订阅的就是它。 */
      emit: (ev, payload) => host.bus?.emit?.(ev, payload),
    });
  };

  await reload();
  /*
   * 设置页改了可见性 / 顺序 / 新增入口后要**立刻**重渲染。
   * 不监听的话，用户点了"显示"要重启才生效 —— 那就是"设置了没用"。
   * 重新 load（不只重新 mount）是因为新增入口要重新生成 def。
   */
  document.addEventListener(TOOLBAR_EVENT, () => { void reload(); });
}

(async function () {
  await init();

  const saved = localStorage.getItem('nexus:sidebar-open');
  $('#body').classList.toggle('open', saved === null ? true : saved === '1');

  $('#side-toggle').onclick = () => {
    const open = $('#body').classList.toggle('open');
    localStorage.setItem('nexus:sidebar-open', open ? '1' : '0');
    // 收起→展开时，正挂着的 nav-item 提示要立刻收掉：名字已显示出来了
    refreshTooltip();
  };
  $('#btn-min').onclick = () => host.win('minimize');
  $('#btn-max').onclick = () => host.win('maximize');
  /* ✕ 的行为由设置决定：默认藏到托盘，也可设为真正退出。
     每次点击时才取 —— 改完设置不用重启就生效。 */
  const closeLabel = () => (host.getCloseAction() === 'hide' ? '隐藏到托盘' : '退出');
  const syncCloseBtn = () => {
    $('#btn-close').title = closeLabel();
  };
  syncCloseBtn();
  host.onCloseActionChange(syncCloseBtn);
  $('#btn-close').onclick = () => {
    const act = host.getCloseAction();
    host.win(act);
    if (act === 'hide') toast('已隐藏到托盘 · 点击托盘图标可唤回', 'info');
  };
  /*
   * 主题 / 置顶 / 托盘 三个按钮**已抽成工具栏插件**（kind:'toolbar'），
   * 在 IIFE 末尾统一加载渲染（见文件底部）。这里不再直接接线 ——
   * 否则会出现"插件渲染一份 + 硬编码一份"的两套按钮。
   */
  $('#btn-add').onclick = openAddDialog;
  $('#btn-settings').onclick = () => navigate('settings');

  /* 开发者模式 · 元素检查器已抽成工具栏插件（toolbar-inspector），
     按钮渲染与高亮态同步都归它自己。这里只剩快捷键（installInspector）。 */
  $('#bar-reload').onclick = () => host.state.activeId && host.mount(host.state.activeId);
  $('#bar-plugin-settings').onclick = openPluginSettings;

  window.addEventListener('hashchange', route);
  if (!location.hash) {
    const last = localStorage.getItem('nexus:last-plugin');
    location.hash = last && host.getPlugins().some((p) => p.id === last)
      ? last : (host.getPlugins()[0]?.id || '');
  }
  await route();
  window.addEventListener('beforeunload', () =>
    localStorage.setItem('nexus:last-plugin', host.state.activeId));

  /* 外壳快捷键。抽成命令表，是为了让 iframe 插件转发回来的按键
     （焦点在沙箱里时，主窗口收不到事件）走同一套逻辑。 */
  const shellCommands = {
    'mod+b': () => { $('#side-toggle').click(); },
    'mod+r': () => { if (host.state.activeId) host.mount(host.state.activeId); },
    'mod+,': () => { if (host.hasSettings()) openPluginSettings(); },
    /* 藏到托盘。
       ------------------------------------------------------------------
       只能"藏"，不能"唤"：窗口隐藏后它**收不到任何键盘事件**，
       全局快捷键要额外插件，不值得为一个快捷键引入。

       所以隐藏时必须明确告诉用户怎么回来 —— 否则窗口凭空消失、
       任务栏里也没有它，用户只会以为程序崩了。 */
    'mod+`': () => {
      host.win('hide');
      toast('已隐藏到托盘 · 点击托盘图标可唤回', 'info');
    },
    /*
     * ESC 由插件转发回来时的处理。
     *
     * 为什么需要这条：检查器开着时鼠标扫过 iframe 里的控件会把焦点带进插件，
     * 而键盘事件**不跨文档冒泡** —— 外壳的那个 window keydown 收不到，
     * ESC 就完全失效了，检查器关不掉。
     *
     * 只在检查器开着时才消费：否则会抢走插件自己的 ESC（插件用它关弹窗）。
     */
    esc: () => {
      if (!isInspectorOn()) return false;
      escInspector();
      return true;
    },
  };
  const runShellShortcut = (combo) => shellCommands[String(combo).toLowerCase()]?.();
  runShellShortcutRef = runShellShortcut;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#drawer-mask')) { e.preventDefault(); closePluginSettings(); return; }
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); runShellShortcut('mod+b'); }
    else if (k === 'r') { e.preventDefault(); runShellShortcut('mod+r'); }
    else if (e.key === ',') { e.preventDefault(); runShellShortcut('mod+,'); }
    /* Ctrl+~ —— 反引号键位。多数布局下 e.key 是 '`'；
       带 Shift 的 `~` 一并接受，免得用户按了没反应以为是坏了。 */
    else if (e.key === '`' || e.key === '~') { e.preventDefault(); runShellShortcut('mod+`'); }
  });

  if (!isInsideTauri()) toast('当前为浏览器调试模式，Rust 命令不可用', 'err');

  // 观测主文档自己的 CSP 违规（插件内部的由 SDK 转发过来）
  extPolicy.watchViolations((v) => onPluginCspViolation(v, host.getPlugins()
    .find((p) => p.id === host.state.activeId)));

  window.__NEXUS__ = {
    state: host.state, bus: host.bus, toast, navigate,
    mountPlugin: (id) => host.mount(id),
    getPlugins: () => host.getPlugins(),
    /* 已注册的**全局**快捷键（accel → { pluginId, event, label }）。
       与 React 侧同名同形 —— 两个外壳暴露给设置页的接口必须一致，
       否则设置页要分叉处理，而分叉迟早只改一边。 */
    getShortcuts: () => host.getShortcuts?.() ?? {},
    getInstance: () => host.state.instance,
    removePlugin: (id) => window.__nexusRemovePlugin(id),
    openPluginSettings,
    closePluginSettings,
    external: {
      ...extPolicy,
      setRefreshHandler: (fn) => { refreshExternalUI = fn; },
      rescanAll: rescanAllPlugins,
      scanPlugin: scanPluginExternal,
    },
    theme: { applyTheme, setAccent, getCurrent, exportVars, getBase },
  };

  /*
   * 工具栏放在 __NEXUS__ 挂载**之后**。
   *
   * 它要 await loadRegistry（动态 import），比后面的同步初始化慢得多。
   * 放在前面的话，等它返回期间 window.__NEXUS__ 还不存在 ——
   * 设置页读 getShortcuts()、插件读 external 都会拿到 undefined，
   * 表现为"外壳起来了但各功能都空的"。
   *
   * 再包一层 try/catch：工具栏是**附加功能**，
   * 它挂了不该连累已经初始化好的外壳核心。
   */
  try {
    await initToolbar();
  } catch (e) {
    console.warn('[toolbar] 初始化失败', e);
    toast(`工具栏加载失败：${e?.message || e}`, 'err');
  }
})();
