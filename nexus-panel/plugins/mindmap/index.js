/**
 * 思维导图插件（Nexus Panel）
 * ============================================================
 * 由 junction_link 的 C# 思维导图模块移植而来，采用「嵌套 iframe」结构：
 *     nexus 外壳 → 本插件层（工具栏 / 侧栏 / 页签）→ editor/index.html（kityminder 内核）
 *
 * 相比原 C# 实现的改进：
 *   命令调用由「拼 JS 字符串 + ExecuteScriptAsync」变成同源直调，
 *   不再受 U+2028/2029、async 返回值、Promise 不被等待等问题困扰。
 *
 * 注：早前曾据 editor 精简页判断「撤销/重做、视图选择、布局模板三项在 C# 侧失效」，
 * 该判断有误 —— 运行时实际加载的是 数据/plugins/kityminder/dist/index.html，
 * 那里已有 window.editor.history 与 __minder.select/setTemplate。现编辑器页已换成 dist 版。
 */

import { bootIframePlugin, h } from '../../js/plugin-sdk.js';
import { EditorBridge } from './editor-bridge.js';
import { DEFAULT_THEME, DEFAULT_LAYOUT, isBuiltinTheme, deriveCanvasTheme } from './themes.js';
import * as wb from './workbook.js';
import * as store from './store.js';
import * as io from './io.js';
import { buildSide, openVideo, openPreview } from './panels.js';
import * as xmind from './xmind.js';

/** 外壳桥接频道（plugin-sdk 的 BRIDGE_CHANNEL），用于捕获运行时主题切换 */
const SHELL_CHANNEL = 'nexus-bridge-v1';
const AUTOSAVE_MS = 800;        // 停止编辑多久后写入本地库
const BACKUP_MS = 2 * 60 * 1000; // 两次快照的最小间隔
const HISTORY_MAX = 50;

bootIframePlugin(async (ctx) => {
  ctx.setTitle('思维导图');

  /* ------------------------- 状态 ------------------------- */

  let workbook = (await store.workbook.load()) || wb.newWorkbook();
  workbook.sheets = wb.normalizeSheets(workbook.sheets);
  let customThemes = (await store.themes.load()) || [];
  let settings = (await store.settings.load()) || { animate: false, backupMinutes: 2 };

  let bridge = null;
  let side = null;
  let nodeStyleCache = {};
  let saveTimer = null;
  let lastBackupAt = 0;
  let lastBackupFp = null;      // 最新快照的指纹，用于「内容没变就不重复备份」
  let dragTabId = null;         // 页签拖拽排序：当前被拖动的画布 id
  let lastCanvasTheme = null;   // 最近一次下发的画布配色（编辑器重载后用来补套）
  let dirty = false;

  // 撤销/重做：内容快照栈
  let undoStack = [];
  let redoStack = [];
  let lastSnap = null;
  let suppress = false;

  const sheet = () => workbook.sheets.find((s) => s.id === workbook.activeId) || workbook.sheets[0];

  /**
   * 两份画布快照是否内容相同。
   * exportJson() 每次都返回新对象，只能比内容不能比引用。
   * 内容相同却判成不同，会让撤销/重做之后的自动保存误清空 redoStack。
   */
  const sameSnap = (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    const sa = typeof a === 'string' ? a : JSON.stringify(a);
    const sb = typeof b === 'string' ? b : JSON.stringify(b);
    return sa === sb;
  };

  /* ------------------------- 界面骨架 ------------------------- */

  const statusEl = h('span.mm-status', {}, '初始化…');
  const canvasEl = h('div.mm-canvas', {});
  const loadingEl = h('div.mm-loading', {}, '编辑器加载中…');
  canvasEl.appendChild(loadingEl);

  const tabsEl = h('div.mm-row', { style: { flex: '1 1 auto', flexWrap: 'nowrap', overflowX: 'auto' } });

  const foot = h('div.mm-foot', {},
    tabsEl,
    h('button.mm-btn.icon', { onclick: guard('新建画布', () => addSheet()), title: '新建画布' }, '＋'),
    statusEl,
  );

  const rail = h('div.mm-rail', {});
  const toolbar = h('div.mm-toolbar', {});
  const body = h('div.mm-body', {}, rail, canvasEl);

  const root = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', gap: '10px' } },
    toolbar, body, foot);

  ctx.root.appendChild(root);

  /* ------------------------- 状态栏 ------------------------- */

  function status(msg, warn = false) {
    statusEl.textContent = msg;
    statusEl.className = 'mm-status' + (warn ? ' warn' : '');
  }

  /**
   * 异步兜底：把失败变成状态栏提示，而不是未捕获的 Promise rejection。
   * 之前的写法大量 fire-and-forget（persist() / loadSheet() / openAttachment() 直接调用不接），
   * IndexedDB 写满（附件是 Blob，配额很容易触顶）或编辑器未就绪时，
   * 会在控制台抛 unhandled rejection，用户只看得到「什么都没发生」。
   */
  function guard(label, fn) {
    return (...args) => {
      let r;
      try {
        r = fn(...args);
      } catch (e) {
        status(`${label}失败：${e?.message || e}`, true);
        return undefined;
      }
      if (r && typeof r.then === 'function') {
        return r.catch((e) => {
          status(`${label}失败：${e?.message || e}`, true);
          return undefined;
        });
      }
      return r;
    };
  }

  /* ------------------------- 工具栏 ------------------------- */

  const B = (label, onclick, opt = {}) =>
    h('button.mm-btn' + (opt.icon ? '.icon' : ''), { onclick, title: opt.title || '' }, label);

  const group = (...els) => h('div.mm-row', {}, ...els);

  function buildToolbar() {
    toolbar.innerHTML = '';

    // 搜索
    const searchInfo = h('span.mm-search-info', {}, '');
    const searchInput = h('input.mm-input', {
      placeholder: '搜索节点…',
      style: { width: '150px' },
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const r = bridge?.search(searchInput.value);
        searchInfo.textContent = r && r.total ? `${r.index}/${r.total}` : '无匹配';
      },
    });

    toolbar.appendChild(group(
      B('导入', () => importFile(), { title: '导入 XMind / JSON / Markdown' }),
      B('导出', () => exportJson(), { title: '导出为 JSON 工作簿' }),
      B('XMIND', () => exportXMind(), { title: '导出为 .xmind（含 XMind 官方 content.json + 本工具无损快照，附件一并打包）' }),
      B('TXT', () => exportTxt(), { title: '导出为 .txt（内容与 JSON 相同，仅扩展名不同，对齐 C# 版）' }),
      B('MD', () => exportMarkdown(), { title: '导出为 Markdown' }),
      B('SVG', () => exportSvg(), { title: '导出为矢量 SVG' }),
      B('PNG', () => exportPng(), { title: '导出整幅 PNG' }),
      B('新建', guard('新建画布', () => addSheet()), { title: '新建画布' }),
      B('复制', guard('复制画布', () => duplicateSheet(workbook.activeId)),
        { title: '复制当前画布（含内容与主题布局）' }),
    ));

    toolbar.appendChild(h('div.mm-sep', {}));

    toolbar.appendChild(group(
      B('下级', () => { bridge?.exec('AppendChildNode'); commit(); }, { title: '插入下级节点 (Tab)' }),
      B('同级', () => { bridge?.exec('AppendSiblingNode'); commit(); }, { title: '插入同级节点 (Enter)' }),
      B('上级', () => { bridge?.exec('AppendParentNode'); commit(); }),
      B('删除', () => { bridge?.exec('RemoveNode'); commit(); }, { title: '删除节点 (Delete)' }),
      // 上移/下移：C# 顶栏有（arrangeup / arrangedown），内核支持但插件原先没接入口
      B('上移', () => { bridge?.exec('arrangeup'); commit(); }, { title: '将选中节点上移一位' }),
      B('下移', () => { bridge?.exec('arrangedown'); commit(); }, { title: '将选中节点下移一位' }),
      B('编辑', () => bridge?.editSelected(), { title: '编辑文字 (F2)' }),
      B('↶', () => undo(), { title: '撤销', icon: true }),
      B('↷', () => redo(), { title: '重做', icon: true }),
    ));

    toolbar.appendChild(h('div.mm-sep', {}));

    // 文字格式（字体/字号/文字色/粗斜删/水平+垂直对齐）已移到右侧栏「样式」页：
    // 顶栏原本塞了 40 多个控件，两个 select + 色块最占宽度，挤掉了其它入口。
    // C# 版 MindMapPanel 顶栏同样没有这些，它们一直在右侧栏 SidePageStyle 里。
    toolbar.appendChild(group(
      B('外框', () => { bridge?.exec('boundary'); commit(); },
        { title: '为选中节点添加/移除矩形外框（boundary，随 XMind 一起导出）' }),
    ));

    toolbar.appendChild(h('div.mm-sep', {}));

    toolbar.appendChild(group(
      B('全选', () => bridge?.select('all')),
      B('反选', () => bridge?.select('revert')),
      B('兄弟', () => bridge?.select('siblings')),
      B('同层', () => bridge?.select('level')),
      B('路径', () => bridge?.select('path')),
      B('子树', () => bridge?.select('tree')),
    ));

    toolbar.appendChild(h('div.mm-sep', {}));

    toolbar.appendChild(group(searchInput, B('定位', () => {
      const r = bridge?.search(searchInput.value);
      searchInfo.textContent = r && r.total ? `${r.index}/${r.total}` : '无匹配';
    }), searchInfo));

    toolbar.appendChild(group(
      B('重载', () => reloadEditor(), { title: '重新加载编辑器内核' }),
    ));
  }

  /* ------------------------- 侧栏 ------------------------- */

  function buildRail() {
    rail.innerHTML = '';
    const defs = [
      ['📁', '文件'],
      ['🎨', '样式'],
      ['🏷', '标签'],
      ['🌈', '主题'],
    ];
    const keys = ['file', 'style', 'tag', 'theme'];
    defs.forEach(([icon, label], i) => {
      rail.appendChild(h('button.mm-btn', {
        title: label,
        onclick: () => side.open(keys[i]),
      }, icon));
    });
  }

  /* ------------------------- 页签 ------------------------- */

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const s of workbook.sheets) {
      const active = s.id === workbook.activeId;
      const btn = h('button.mm-tab' + (active ? '.active' : ''), {
        ondblclick: guard('重命名', () => renameSheet(s.id)),
        draggable: true,                       // 拖拽排序
      }, s.title);
      btn.appendChild(h('span.x', {
        onclick: (e) => { e.stopPropagation(); guard('复制画布', () => duplicateSheet(s.id))(); },
        title: '复制该画布',
      }, '⧉'));
      if (workbook.sheets.length > 1) {
        btn.appendChild(h('span.x', {
          onclick: (e) => { e.stopPropagation(); guard('删除画布', () => removeSheet(s.id))(); },
          title: '删除该画布',
        }, '✕'));
      }
      btn.addEventListener('click', guard('切换画布', () => switchSheet(s.id)));
      wireTabDrag(btn, s.id);
      tabsEl.appendChild(btn);
    }
  }

  /**
   * 页签拖拽排序（对齐 C# 版「页签拖拽排序」）。
   * HTML5 drag 事件即可，无需指针计算：经过谁就把被拖的插到谁的位置。
   */
  function wireTabDrag(el, id) {
    el.addEventListener('dragstart', (e) => {
      dragTabId = id;
      el.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      dragTabId = null;
      el.classList.remove('dragging');
      for (const t of tabsEl.children) t.classList.remove('drop-before', 'drop-after');
    });
    el.addEventListener('dragover', (e) => {
      if (!dragTabId || dragTabId === id) return;
      e.preventDefault();                      // 允许放下
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      // 落在页签左半边插到它前面，右半边插到后面
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      el.classList.toggle('drop-before', before);
      el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-before', 'drop-after');
      if (!dragTabId || dragTabId === id) return;
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      guard('调整顺序', () => moveTab(dragTabId, id, before))();
    });
  }

  /** 把 from 移到 to 的前面或后面 */
  function moveTab(fromId, toId, before) {
    const from = workbook.sheets.findIndex((s) => s.id === fromId);
    if (from < 0) return;
    const [item] = workbook.sheets.splice(from, 1);
    let to = workbook.sheets.findIndex((s) => s.id === toId);
    if (to < 0) to = workbook.sheets.length - 1;
    workbook.sheets.splice(before ? to : to + 1, 0, item);
    renderTabs();
    persist();
    status('画布顺序已调整');
  }

  async function addSheet() {
    capture();
    const s = wb.newSheet(wb.nextTitle(workbook.sheets), '中心主题');
    workbook.sheets.push(s);
    workbook.activeId = s.id;
    renderTabs();
    await loadSheet();     // 必须等载入完成再落盘，否则存的是旧内容
    await persist();
  }

  /**
   * 复制画布（对齐 C# DuplicateSheetAsync）。
   * C# 是页签右键菜单；插件没有右键菜单，改为顶栏「复制」+ 页签 ⧉ 两个入口。
   * 副本插在原画布之后，标题「X 副本」（重名追加序号），与 C# 一致。
   */
  async function duplicateSheet(id) {
    const src = workbook.sheets.find((s) => s.id === id);
    if (!src) return;
    capture();                       // 先把当前编辑收回来，否则副本拿到的是旧内容
    const copy = wb.cloneSheet(src, workbook.sheets);
    workbook.sheets.splice(workbook.sheets.indexOf(src) + 1, 0, copy);
    workbook.activeId = copy.id;
    renderTabs();
    await loadSheet();
    await persist();
    status('已复制画布：' + copy.title);
  }

  async function removeSheet(id) {
    if (workbook.sheets.length <= 1) { status('至少保留一张画布', true); return; }
    const i = workbook.sheets.findIndex((s) => s.id === id);
    if (i < 0) return;
    workbook.sheets.splice(i, 1);
    if (workbook.activeId === id) {
      workbook.activeId = workbook.sheets[Math.min(i, workbook.sheets.length - 1)].id;
      await loadSheet();
    }
    renderTabs();
    await persist();
  }

  function renameSheet(id) {
    const s = workbook.sheets.find((x) => x.id === id);
    if (!s) return;
    const name = window.prompt('画布名称', s.title);
    if (name == null) return;
    s.title = name.trim() || s.title;
    renderTabs();
    persist();
  }

  /** 切换画布：先把当前内容收回来，再载入目标 */
  async function switchSheet(id) {
    if (id === workbook.activeId) return;
    capture();
    workbook.activeId = id;
    renderTabs();
    await loadSheet();
    persist();
  }

  /* ------------------------- 编辑器装载 ------------------------- */

  async function loadSheet() {
    const s = sheet();
    if (!bridge) return;
    if (!bridge.ready) {
      const ok = await bridge.load();
      if (!ok) return;
      loadingEl.remove();
    }
    applyOptions();

    // 顺序很关键：编辑器 importJson 会剔除未注册的主题名（否则 core 直接抛错），
    // 所以自定义主题必须在导入之后注册、再由 setTheme 补上。
    suppress = true;
    bridge.importJson(s.content || wb.emptyContent());
    suppress = false;

    if (s.theme && !isBuiltinTheme(s.theme)) {
      const t = customThemes.find((x) => x.id === s.theme);
      if (t) bridge.registerTheme(t);
    }
    bridge.setTheme(s.theme || DEFAULT_THEME);
    bridge.setTemplate(s.layout || DEFAULT_LAYOUT);

    // 切换 / 重新装载画布后重置历史：编辑器侧的 importJson 已自动 commit 新基线
    // （每次导入都是新的历史起点，不会把上一张画布的编辑带过来），这里再显式清一次双保险；
    // 插件层回退栈也要清空，避免跨画布混用。
    lastSnap = bridge.exportJson() || s.content;
    bridge?.historyClear();
    undoStack = [];
    redoStack = [];
    updateBadge();
  }

  function applyOptions() {
    // 布局动画：编辑器初始化时读的是注入变量（默认关闭），这里允许运行时切换
    bridge?.evalInEditor((win, km) => {
      if (km?.setOption) km.setOption('layoutAnimationDuration', settings.animate ? 300 : 0);
    });
  }

  async function reloadEditor() {
    capture();
    persist();
    canvasEl.appendChild(loadingEl);
    await bridge.reload();
    loadingEl.remove();
    bridge.setCanvasTheme(lastCanvasTheme);   // 新页面没有旧配色，补套一次
    await loadSheet();
    status('编辑器已重载');
  }

  /* ------------------------- 内容同步与持久化 ------------------------- */

  /** 从编辑器取回 JSON 写进当前画布（并同步主题/布局） */
  function capture() {
    if (!bridge?.ready) return false;
    const json = bridge.exportJson();
    if (!json) return false;
    const s = sheet();
    // 按内容比较：exportJson() 每次返回新对象，用 === 永远不等，
    // 「内容没变就不必写回」的判断会永远失效。
    if (sameSnap(s.content, json)) return false;
    s.content = json;
    return true;
  }

  function commit() {
    if (suppress) return;
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => doSave(), AUTOSAVE_MS);
  }

  async function doSave() {
    if (suppress || !bridge?.ready) return;
    try {
      await doSaveInner();
    } catch (e) {
      // 自动保存跑在定时器里，不兜住就只剩控制台的 unhandled rejection；
      // 附件以 Blob 存 IndexedDB，配额触顶是真实可能发生的场景。
      status('自动保存失败：' + (e?.message || e), true);
    }
  }

  async function doSaveInner() {
    const s = sheet();
    const json = bridge.exportJson();
    if (!json) return;

    // 历史栈：把「变更前的版本」压栈。
    // 必须按内容比较：exportJson() 返回对象，引用永远不等，
    // 用 !== 会把「撤销/重做后重新导出」误判成新编辑，
    // 从而清空 redoStack —— 表现为重做按钮点了没反应。
    if (lastSnap && !sameSnap(lastSnap, json)) {
      undoStack.push(lastSnap);
      if (undoStack.length > HISTORY_MAX) undoStack.shift();
      redoStack = [];
    }
    lastSnap = json;

    s.content = json;
    dirty = false;
    // store.set 失败是返回 false 而不是抛出，不检查就会在「根本没存进去」的
    // 情况下继续往下走、最后提示「已保存」——比不提示更糟。
    const saved = await store.workbook.save(workbook);
    if (!saved) {
      status('自动保存失败：本地存储写入被拒绝（可能是空间不足）', true);
      return;
    }

    // 滚动快照：间隔可配（0=关闭），且与最新快照逐张比对，内容没变就只重置计时不写盘。
    // 对齐 C# 版 MaybeBackupAsync 的行为，避免每次到点都白写一份。
    const now = Date.now();
    const intervalMs = (Number(settings.backupMinutes) || 0) * 60 * 1000;
    if (intervalMs > 0 && now - lastBackupAt > intervalMs) {
      lastBackupAt = now;
      const fp = wb.fingerprintSheets(workbook.sheets);
      if (fp !== lastBackupFp) {
        lastBackupFp = fp;
        await store.pushBackup({ sheets: JSON.parse(JSON.stringify(workbook.sheets)), activeId: workbook.activeId });
      }
    }
    status('已保存 · ' + new Date().toLocaleTimeString());
  }



  async function persist() {
    // 内部兜底：调用方基本都是 fire-and-forget，写失败（配额触顶等）必须看得见。
    // 注意 store.set 是「吞异常返回 false」而不是抛出，所以必须检查返回值，
    // 只写 try/catch 的话写失败会被静默吞掉。
    try {
      const ok = await store.workbook.save(workbook);
      if (!ok) status('保存失败：本地存储写入被拒绝（可能是空间不足）', true);
      return ok;
    } catch (e) {
      status('保存失败：' + (e?.message || e), true);
      return false;
    }
  }

  /** 编辑器侧 contentchange 回调 */
  function onDirty() {
    if (suppress) return;
    dirty = true;
    scheduleSave();
  }

  /* ------------------------- 画布跟随外壳主题 ------------------------- */

  /**
   * 把外壳主题换算成画布配色并下发到内层编辑器页。
   * 内层是独立文档，外壳注入的 CSS 变量进不去，只能 postMessage。
   */
  function syncCanvasTheme(vars) {
    const t = deriveCanvasTheme(vars);
    lastCanvasTheme = t;
    bridge?.setCanvasTheme(t);
  }

  /**
   * 外壳切换主题时，plugin-sdk 只更新 ctx.theme 并改 :root 变量，不会通知插件代码，
   * 所以这里另注册一个监听器捕获 'theme' 消息（两个监听器互不影响）。
   * 返回的注销函数必须在插件卸载时调用，否则重复挂载会叠加监听器。
   */
  function watchShellTheme() {
    const onMessage = (e) => {
      const d = e.data;
      if (!d || d.channel !== SHELL_CHANNEL) return;
      if (d.type === 'theme' && d.theme) syncCanvasTheme(d.theme);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }

  /* ------------------------- 附件打开 ------------------------- */

  /**
   * 打开节点上的附件引用。
   * ref 可能是新版引用串（含 IndexedDB id，能取到字节），也可能是由 C# 版迁移过来的
   * 老式本地路径（沙箱拿不到文件本体），后者只能提示。
   */
  async function openAttachment(raw) {
    const ref = io.decodeRef(raw);
    if (!ref) { status('附件引用无法识别', true); return; }

    // 侧栏切到文件页（已是该页就保持展开，不做 toggle 收起）
    if (side.current() !== 'file') side.open('file');

    if (!ref.a) {
      status('该附件是旧版本地路径，沙箱内无法打开（请重新附加一次）', true);
      return;
    }
    const asset = await io.getAsset(ref.a);
    if (!asset?.blob) { status('附件数据已丢失', true); return; }

    // 视频直接播；其余按扩展名判断能否内联预览，不能则另存为。
    // 注意 getAsset 每次都会新建一个 Blob URL：交给浮层的由浮层关闭时释放，
    // 走下载路径的这里必须自己释放，否则每次点附件都泄漏一个 URL。
    if (/\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(asset.name || ref.n || '')) {
      openVideo(app, { ...asset, name: asset.name || ref.n });
      status('正在播放：' + (asset.name || ref.n || '视频'));
      return;
    }
    if (/^image\//.test(asset.blob.type || '')) {
      openPreview(app, asset);
      return;
    }
    io.downloadBlob(asset.name || ref.n || '附件', asset.blob);
    if (asset.url) URL.revokeObjectURL(asset.url);
    status('已导出附件：' + (asset.name || ref.n || '附件'));
  }

  /* ------------------------- 撤销 / 重做 ------------------------- */

  function applySnapshot(json) {
    if (!json) return;
    suppress = true;
    bridge.importJson(json);
    suppress = false;
    sheet().content = json;
    lastSnap = json;
    scheduleSave();
  }

  /**
   * 撤销 / 重做：优先用编辑器自维护的历史栈（上游 dist/index.html 已补齐，100 步、基线模型），
   * 编辑器执行时会 importJson → 触发 contentchange → 自动落盘，所以这里不用再手动保存。
   * 只有拿不到编辑器历史栈（旧页面 / 编辑器未就绪）时才回退到插件层的快照栈。
   */
  function undo() {
    const r = bridge?.history('undo');
    if (r === true) { status('已撤销'); return; }
    if (!undoStack.length) { status('没有可撤销的操作', true); return; }
    redoStack.push(lastSnap);
    applySnapshot(undoStack.pop());
    status('已撤销（本地栈）');
  }

  function redo() {
    const r = bridge?.history('redo');
    if (r === true) { status('已重做'); return; }
    if (!redoStack.length) { status('没有可重做的操作', true); return; }
    undoStack.push(lastSnap);
    applySnapshot(redoStack.pop());
    status('已重做（本地栈）');
  }

  /* ------------------------- 主题 / 布局 ------------------------- */

  async function applyTheme(name) {
    const s = sheet();
    if (!isBuiltinTheme(name)) {
      const t = customThemes.find((x) => x.id === name);
      if (t && !bridge.registerTheme(t)) { status('自定义主题注册失败', true); return; }
    }
    bridge.setTheme(name);
    s.theme = name;
    await persist();
    status('主题：' + name);
  }

  async function applyLayout(name) {
    bridge.setTemplate(name);
    sheet().layout = name;
    await persist();
    status('布局：' + name);
  }

  async function saveThemes() {
    // store.set 失败返回 false 而非抛出，不检查就等于静默丢主题
    const ok = await store.themes.save(customThemes);
    if (!ok) status('自定义主题保存失败', true);
    return ok;
  }

  /* ------------------------- 导入导出 ------------------------- */

  async function exportJson() {
    capture();
    const text = wb.serializeWorkbook(workbook.sheets, workbook.activeId);
    const r = await io.saveText(io.stampName('脑图', 'json'), text, 'application/json');
    reportSave(r, 'JSON');
  }

  async function exportMarkdown() {
    const text = wb.workbookToMarkdown(workbook.sheets);
    const r = await io.saveText(io.stampName('脑图', 'md'), text, 'text/markdown');
    reportSave(r, 'Markdown');
  }

  /**
   * .txt 导出：C# 版这个分支写的就是工作簿 JSON（多画布）或单画布内容，
   * 与 .json 完全同内容、仅扩展名不同，这里原样对齐，不做额外格式化。
   */
  async function exportTxt() {
    capture();
    const text = workbook.sheets.length > 1
      ? wb.serializeWorkbook(workbook.sheets, workbook.activeId)
      : (sheet()?.content || '{}');
    const r = await io.saveText(io.stampName('脑图', 'txt'), text, 'text/plain;charset=utf-8');
    reportSave(r, 'TXT');
  }

  async function exportSvg() {
    const svg = await bridge?.exportSvg();
    if (!svg) { status('SVG 导出失败（编辑器未就绪？）', true); return; }
    const r = await io.saveText(io.stampName('脑图', 'svg'), svg, 'image/svg+xml');
    reportSave(r, 'SVG');
  }

  /**
   * 导出 .xmind。
   * 附件走 loadAssetBytes 从 IndexedDB 取字节打进包内 resources/，
   * 因此换机器导入时附件能一起还原（C# 版是拷本地文件路径，文件移动就失效）。
   */
  async function exportXMind() {
    capture();
    try {
      // 统计附件：读不到字节的会被跳过（引用原样写入），别让用户以为附件已随包带走
      let wanted = 0, packed = 0;
      const loadAsset = async (ref) => {
        wanted++;
        const b = await io.loadAssetBytes(ref);
        if (b && b.length) packed++;
        return b;
      };
      const blob = await xmind.writeXMind(workbook.sheets, workbook.activeId, loadAsset);
      const r = await io.saveBlob(io.stampName('脑图', 'xmind'), blob);
      reportSave(r, 'XMind');
      const lost = wanted - packed;
      if (lost > 0) status(`XMind 已导出，但有 ${lost} 个附件未能打包`, true);
      else if (packed > 0) status(`XMind 已导出（含 ${packed} 个附件）`);
    } catch (e) {
      status('XMind 导出失败：' + (e?.message || e), true);
    }
  }

  async function exportPng() {
    const dataUrl = await bridge?.exportPng();
    if (!dataUrl) { status('PNG 导出失败', true); return; }
    const r = await io.saveBlob(io.stampName('脑图', 'png'), io.dataUrlToBlob(dataUrl));
    reportSave(r, 'PNG');
  }

  function reportSave(r, what) {
    if (r === 'cancel') return;
    if (r === 'error') { ctx.toast(`${what} 保存失败`, 'err'); return; }
    ctx.toast(r === 'fallback' ? `${what} 已导出（由浏览器选择保存位置）` : `${what} 已保存`, 'ok');
  }

  async function importFile() {
    const f = await io.pickFile('.xmind,.json,.md,.markdown,application/json,text/markdown');
    if (!f) return;

    // .xmind：二进制 zip，走独立分支（附件会解包进 IndexedDB）
    if (xmind.isXMindName(f.name)) {
      try {
        status('正在解析 XMind…');
        const buf = await io.readBytes(f);
        const r = await xmind.readXMind(buf, io.saveAssetBytes);
        if (!r.sheets?.length) { ctx.toast('文件里没有可用画布', 'err'); return; }
        workbook.sheets = wb.normalizeSheets(r.sheets);
        workbook.activeId = r.activeId || workbook.sheets[0].id;
        renderTabs();
        await loadSheet();
        await persist();
        const srcTip = { native: '无损快照', zen: 'XMind Zen 格式', legacy: 'XMind 8 老版格式' }[r.source] || r.source;
        status(`已导入 ${workbook.sheets.length} 张画布（${srcTip}${r.attachments ? `，${r.attachments} 个附件` : ''}）`);
        ctx.toast(`已导入 ${workbook.sheets.length} 张画布`, 'ok');
      } catch (e) {
        status('XMind 导入失败：' + (e?.message || e), true);
        ctx.toast('XMind 导入失败', 'err');
      }
      return;
    }

    const text = await io.readText(f);
    let sheets = null;

    if (/\.(md|markdown|txt)$/i.test(f.name)) {
      sheets = wb.markdownToWorkbook(text);
    } else {
      const parsed = wb.parseWorkbook(text);
      if (parsed) sheets = parsed.sheets;
      else sheets = wb.markdownToWorkbook(text);   // 兜底：当 Markdown 试一次
    }
    if (!sheets || !sheets.length) { ctx.toast('无法识别该文件', 'err'); return; }

    workbook.sheets = sheets;
    workbook.activeId = sheets[0].id;
    renderTabs();
    await loadSheet();
    await persist();
    ctx.toast(`已导入 ${sheets.length} 张画布`, 'ok');
  }

  async function backupNow() {
    capture();
    // pushBackup 写失败返回 null（不抛），不判断就会提示「已创建」但实际没写进去
    const key = await store.pushBackup({ sheets: JSON.parse(JSON.stringify(workbook.sheets)), activeId: workbook.activeId });
    lastBackupAt = Date.now();
    lastBackupFp = wb.fingerprintSheets(workbook.sheets);
    if (key) ctx.toast('已创建快照', 'ok');
    else status('快照创建失败（本地存储写入被拒绝）', true);
  }

  async function restoreBackup(b) {
    workbook.sheets = wb.normalizeSheets(b.sheets);
    workbook.activeId = b.activeId || workbook.sheets[0].id;
    renderTabs();
    await loadSheet();
    await persist();
    lastBackupFp = wb.fingerprintSheets(workbook.sheets);
    ctx.toast('已从快照恢复', 'ok');
  }

  /* ------------------------- 对外能力（供 panels 用） ------------------------- */

  // api 层统一兜底：面板和工具栏都是 onclick 直接调用，拿不到 Promise，
  // 异步失败不包一层就只会在控制台留 unhandled rejection，界面上毫无反应。
  const api = {
    status,
    commit,
    backupNow: guard('备份', backupNow),
    restoreBackup: guard('恢复快照', restoreBackup),
    exportJson: guard('导出 JSON', exportJson),
    exportMarkdown: guard('导出 Markdown', exportMarkdown),
    importFile: guard('导入', importFile),
    saveThemes: guard('保存主题', saveThemes),
    applyTheme: guard('应用主题', applyTheme),
    applyLayout: guard('应用布局', applyLayout),
    toast: (m, t) => ctx.toast(m, t),
    /** 读取选中节点的附件引用（file / video） */
    selectedRef(kind) {
      const raw = kind === 'video' ? bridge?.getSelectedVideo() : bridge?.getSelectedFile();
      return io.decodeRef(raw);
    },
    /** 当前选中节点的节点级样式（由编辑器 nodestyle 事件回传） */
    nodeStyle: () => nodeStyleCache,
    /** 修改设置项（自动快照间隔 / 布局动画），改完立即持久化并生效 */
    setBackupMinutes: guard('设置快照间隔', async (m) => {
      settings.backupMinutes = Number(m) || 0;
      const ok = await store.settings.save(settings);
      if (!ok) { status('设置保存失败', true); return; }
      status(settings.backupMinutes === 0 ? '自动快照已关闭' : `自动快照间隔：${settings.backupMinutes} 分钟`);
    }),
    setAnimate: guard('设置布局动画', async (on) => {
      settings.animate = !!on;
      const ok = await store.settings.save(settings);
      if (!ok) { status('设置保存失败', true); return; }
      applyOptions();
      status(settings.animate ? '布局动画已开启' : '布局动画已关闭');
    }),
    get settings() { return settings; },
  };

  /* ------------------------- 启动 ------------------------- */

  buildToolbar();

  // 面板句柄用 getter 暴露可变状态：bridge 稍后才创建、customThemes 会被整体替换，
  // 若在这里传快照，面板里读到的会是 null / 旧数组。
  const app = {
    get bridge() { return bridge; },
    api,
    get customThemes() { return customThemes; },
    get settings() { return settings; },
    sheet,
  };
  side = buildSide(app);
  body.insertBefore(side.el, canvasEl);
  buildRail();
  renderTabs();

  bridge = new EditorBridge(canvasEl, {
    onStatus: status,
    onDirty,
    onNodeStyle: (st) => { nodeStyleCache = st || {}; side.refresh(); },
    // 点击画布上节点的附件图标。（C# 版这里是：自动切到「文件」页签展示该文件信息，
    // 视频直接在页签内播放。沙箱里拿不到真实路径、也无法调用系统默认程序打开，
    // 所以退化为「视频播浮层 / 文件另存为」，并把侧栏切到文件页以便查看信息。）
    onOpenFile: guard('打开附件', (path) => openAttachment(path)),
    onHostRequest: async (action, payload) => {
      // 编辑器的 callHost 通道：saveAs 直接落成文件
      if (action === 'saveAs') {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
        await io.saveText(io.stampName('脑图', 'json'), text, 'application/json');
        return { ok: true };
      }
      if (action === 'log') { status(String(payload || '')); return { ok: true }; }
      return { ok: false };
    },
  });

  // 画布底色跟随外壳亮/暗主题：先起监听（主题随时可能切），再按当前主题套一次
  const unwatchTheme = watchShellTheme();
  syncCanvasTheme(ctx.theme);

  const ok = await bridge.load();
  if (!ok) {
    loadingEl.textContent = '编辑器加载失败，请点「重载」重试';
    status('编辑器未就绪', true);
  } else {
    loadingEl.remove();
    // 编辑器页刚载入，重新下发一次（页面初始化期间可能错过前面的消息）
    bridge.setCanvasTheme(lastCanvasTheme);
  }

  await loadSheet();
  updateBadge();

  function updateBadge() {
    ctx.setBadge(workbook.sheets.length > 1 ? workbook.sheets.length : 0);
  }

  // 卸载前兜底保存：避免正在编辑时关掉插件丢内容
  ctx.onDestroy(async () => {
    clearTimeout(saveTimer);
    // 卸载路径不能抛：此时 UI 正在被拆掉，抛错既看不见也拦不住卸载流程
    try {
      capture();
      await persist();
      await store.pushBackup({ sheets: JSON.parse(JSON.stringify(workbook.sheets)), activeId: workbook.activeId });
    } catch (e) {
      console.warn('[mindmap] 卸载前兜底保存失败', e);
    }
  });

  return () => {
    clearTimeout(saveTimer);
    unwatchTheme?.();
    bridge?.destroy();
  };
});
