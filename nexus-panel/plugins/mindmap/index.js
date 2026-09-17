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
import * as diag from './diagnostics.js';
import * as store from './store.js';
import * as io from './io.js';
import { buildSide, openVideo, openPreview, openSettings, confirmDialog, popupMenu,
  openPrintSettings, openDiagnostics, searchStatusText } from './panels.js';
import { attachTabDrag } from './tab-drag.js';
import * as fmt from './formats.js';
import { buildFileList } from './filelist.js';
import * as xmind from './xmind.js';

/** 外壳桥接频道（plugin-sdk 的 BRIDGE_CHANNEL），用于捕获运行时主题切换 */
const SHELL_CHANNEL = 'nexus-bridge-v1';
const AUTOSAVE_MS = 800;        // 停止编辑多久后写入本地库
const BACKUP_MS = 2 * 60 * 1000; // 两次快照的最小间隔
const HISTORY_MAX = 50;

bootIframePlugin(async (ctx) => {
  ctx.setTitle('思维导图');

  /* ------------------------- 状态 ------------------------- */

  // confirmDropOverwrite：拖放附加时，若目标节点已有同类附件是否先确认。
  // 默认开 —— 图片/视频/文件都是单值字段，挂上去会静默顶掉原来的，不可逆。
  let settings = (await store.settings.load())
    || { animate: false, backupMinutes: 2, backupMax: 3, pdfChannel: 'vector', confirmDropOverwrite: true };
  // filesOpen 默认关：文件库是 Web 版多文档功能，C# 原版没有左栏。
  // 收起时画布左右只剩「属性侧栏」一侧占位，更接近原版观感；需要切换脑图时
  // 点 📚 展开。老配置里没有这个字段时 undefined 会走 falsy 分支，正是想要的默认收起。
  if (settings.filesOpen === undefined) settings.filesOpen = false;

  /* --------------------- 文件库（多文档） ---------------------
   * 旧版本整个插件只有一份工作簿（存在 workbook 键下）。
   * 有了左侧文件列表后改为「一个文件 = 一份工作簿」，各存 doc:<id>。
   * 首次进入把旧数据迁移成第一个文件，老用户不会丢内容。 */
  let foldersList = (await store.folders.load()) || [];
  let fileIndex = await store.files.load();
  if (!Array.isArray(fileIndex) || !fileIndex.length) {
    const id = newFileId();
    const legacy = await store.workbook.load();
    await store.doc(id).save(legacy || wb.newWorkbook());
    fileIndex = [{ id, name: '我的脑图', folderId: null }];
    await store.files.save(fileIndex);
  }
  let currentFileId = fileIndex.some((f) => f.id === settings.lastFileId)
    ? settings.lastFileId
    : fileIndex[0].id;

  let workbook = (await store.doc(currentFileId).load()) || wb.newWorkbook();
  workbook.sheets = wb.normalizeSheets(workbook.sheets);
  let customThemes = (await store.themes.load()) || [];

  let bridge = null;
  let side = null;
  let fileList = null;      // 左侧文件库面板
  // A71 诊断环形缓冲：只留最近若干条，避免长时间运行无限堆积
  let diagnostics = [];

  /**
   * A71 外壳侧捕获。
   *
   * 内层 iframe 的报错由 editor-bridge 转发（见 handlers.onDiagnostic）；
   * 这里补的是**外壳自身**的错误 ——
   * 少了这一半，插件层抛的异常同样没有线索。
   */
  function captureShellErrors() {
    const push = (level, message, stack) => {
      const e = diag.normalize({ level, message, stack, source: 'shell' });
      if (e) diagnostics = diag.pushEntries(diagnostics, [e]);
    };
    window.addEventListener('error', (ev) => {
      // 资源加载失败不冒泡，只有捕获阶段收得到；且这类没有 ev.error
      if (ev?.target && ev.target !== window && ev.target.tagName) {
        push('error', `资源加载失败: ${ev.target.src || ev.target.href || ev.target.tagName}`, '');
        return;
      }
      push('error', ev?.message || '未知错误', ev?.error?.stack || '');
    }, true);
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev?.reason;
      push('error', r?.message || String(r || '未处理的 Promise 拒绝'), r?.stack || '');
    });
  }
  let nodeStyleCache = {};
  let saveTimer = null;
  let lastBackupAt = 0;
  let lastBackupFp = null;      // 最新快照的指纹，用于「内容没变就不重复备份」
  let lastCanvasTheme = null;   // 最近一次下发的画布配色（编辑器重载后用来补套）
  let dirty = false;

  // 撤销/重做：内容快照栈
  let undoStack = [];
  let redoStack = [];
  let lastSnap = null;
  let suppress = false;
  /** A49 切换画布的重入守卫（WPF `_switchingSheet`） */
  let switchingSheet = false;
  /** B1 上一次撤销走的是哪条栈（'editor' | 'local' | null）。
   *  重做必须走同一条，否则会重做到另一条栈上，那次撤销就永久回不来了。 */
  let pendingRedo = null;
  /** 抑制期间发生过的变更（WPF `_dirtyDuringSuppress`）。抑制解除后补存。 */
  let dirtyDuringSuppress = false;
  let suppressTimer = null;
  /**
   * 抑制窗口时长。WPF 用 1200ms（`DelayThenClearSuppressAsync`），因为它走
   * WebView2 的异步 postMessage；Web 版是同源同步直调，异步派发少得多，
   * 800ms 足够吸收 layoutallfinish / selectionchange 等尾部事件，
   * 又不至于让用户的编辑长时间不落盘。
   */
  const SUPPRESS_MS = 800;

  const sheet = () => workbook.sheets.find((s) => s.id === workbook.activeId) || workbook.sheets[0];

  // 用函数声明而非 const 箭头函数：上面的文件库迁移在初始化阶段就要用 newFileId，
  // const 存在暂时性死区，此时访问会抛 ReferenceError（整个插件挂不上）。
  function newFileId() {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function newFolderId() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

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

  /**
   * 页签区：吃掉所有剩余空间，页签多到放不下时**自己**横向滚动。
   * min-width:0 必须显式给 —— flex item 默认 min-width:auto，宽度会被内容顶住不收缩，
   * 结果是页签一多就把下面的「＋」和状态栏一起挤出容器（.mm-foot 自身带 overflow-x:auto，
   * 于是整条底栏开始滚动，「＋」被滚出视野）。
   */
  const tabsEl = h('div.mm-row.mm-tabs', {
    style: { flex: '1 1 auto', minWidth: '0', flexWrap: 'nowrap', overflowX: 'auto' },
  });

  /**
   * 新建画布按钮。
   * margin-left:auto 是钉住位置的关键：页签少的时候页签区吃不满一行，
   * 若不给这个 auto，「＋」就紧跟在最后一个页签后面停在一行中间。
   *
   * 注意它必须和 .mm-status 的 margin-left:auto **二选一** ——
   * 两个 auto 会平分剩余空间，「＋」反而停在中间、状态文字跑到最右。
   * 现在统一由「＋」负责推，状态文字紧跟其后，两者一起贴在最右。
   */
  const addSheetBtn = h('button.mm-btn.icon', {
    onclick: guard('新建画布', () => addSheet()),
    title: '新建画布',
    style: { flex: '0 0 auto', marginLeft: 'auto' },
  }, '＋');

  const foot = h('div.mm-foot', {},
    tabsEl,
    addSheetBtn,
  );

  /**
   * 状态条单独一行（对齐 C# MindMapPanel 的 Grid.Row=3）。
   * 之前它跟页签挤在同一条里，页签一多就把状态文字顶得忽长忽短；
   * 拆出来后各自独立，也让底部成为「画布页签 / 状态」两行，与 C# 一致。
   */
  const statusBar = h('div.mm-statusbar', {}, statusEl);

  const rail = h('div.mm-rail', {});
  const toolbar = h('div.mm-toolbar', {});
  const body = h('div.mm-body', {}, rail, canvasEl);

  const root = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', gap: '10px' } },
    toolbar, body, foot, statusBar);

  ctx.root.appendChild(root);

  /* ------------------------- 状态栏 ------------------------- */

  function status(msg, warn = false) {
    statusEl.textContent = msg;
    statusEl.className = 'mm-status' + (warn ? ' warn' : '');
  }

  /**
   * 把「存储读失败」摆到状态栏上。
   * store 的读路径降级成默认值但会记下 lastError —— 不提示的话用户看到的是
   * 「脑图变空了」，很可能继续编辑然后真丢数据（M8）。
   */
  function flushStoreError() {
    const e = store.takeStoreError();
    if (e) status(e + '（当前显示的可能不是最新内容）', true);
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

  /**
   * 判断焦点是否落在「正在输入文字」的控件里。
   * 这类控件里 Tab 应当保持浏览器默认行为（跳到下一个控件），不能被画布抢走。
   */
  function isTextTarget(el) {
    if (!el || !el.tagName) return false;
    const t = el.tagName.toLowerCase();
    return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable === true;
  }

  /**
   * Tab → 插入下级节点（XMind 语义）。
   * ============================================================
   * 问题：kityminder 的键盘输入全靠编辑器页里一个隐藏的 `input.km-receiver`，
   * 焦点不在它上面时画布收不到任何键。而本层有一整排工具栏按钮 ——
   * 用户点过任意一个之后焦点就停在 <button> 上，此时按 Tab，
   * 浏览器拿它做焦点导航（在按钮之间跳），永远到不了画布。
   *
   * 点一下画布能恢复（内核在 beforemousedown 里 focus + preventDefault），
   * 但用户通常不会先点画布再按 Tab，于是就变成「Tab 建不出下级节点」。
   *
   * 处理：在本层 window 上用**捕获阶段**监听 Tab，若焦点不在文本控件里就
   * preventDefault 掉（阻止按钮间导航），再把动作转送给编辑器。
   *
   * 为什么用捕获阶段：要在浏览器执行「Tab → 移动焦点」这个默认行为之前拦下来，
   * 冒泡阶段已经晚了。
   *
   * 为什么不会重复触发：keydown 不跨 iframe 冒泡。焦点在编辑器里时，
   * 事件在内层文档就处理完了，本层收不到。
   */
  function bindTabForward() {
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;   // 带修饰键的交给浏览器
      if (isTextTarget(e.target)) return;               // 输入框里保持默认
      e.preventDefault();
      bridge?.insertChild();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }

  /**
   * 工具栏按钮点完把焦点交还画布。
   * 不只是 Tab —— Enter / 方向键 / Delete / Ctrl+B 等同样依赖 receiver 的焦点，
   * 点过按钮后它们会一起失效。统一在这里兜住，省得每个 handler 各写一遍。
   *
   * 放在 onclick 的**末尾**而非 setTimeout：handler 里若调了 window.prompt
   * 这类同步模态，焦点会在用户关掉对话框之后才移动，顺序正好。
   */
  const refocusCanvas = () => { try { bridge?.focusCanvas(); } catch { /* ignore */ } };

  /**
   * opt.refocus:false 用于「点击后焦点不该回画布」的按钮 ——
   * 典型是打开模态浮层：焦点还留在画布的话，画布会在浮层背后继续吃快捷键。
   */
  /**
   * A39 导出格式菜单。
   *
   * PNG 单独列出 1/2/3 倍 —— 高分辨率是要用户主动选的：
   * 默认 3 倍的话，一个普通脑图会导出几十 MB，多数人并不需要。
   */
  function openExportMenu(anchorEl) {
    const hint = {
      xmind: '与 XMind 官方互通，多画布 + 主题 + 外框 + 附件一并打包，换机器可还原',
      json: '保留全部私有字段，本工具无损往返',
      txt: '与 JSON 同内容，仅扩展名不同（对齐 C# 版）',
      md: '多画布按「## 画布：」分块，便于人读与 diff',
      svg: '矢量图，可无损放大',
      png: '位图，1 倍=画布原尺寸',
      pdf: '矢量图，不经浏览器、不弹对话框，直接保存；失败时自动改用打印对话框',
    };
    popupMenu(anchorEl, [
      { label: 'XMind（.xmind）', hint: hint.xmind, onSelect: () => exportXMind() },
      { label: 'JSON（.json）', hint: hint.json, onSelect: () => exportJson() },
      { label: 'TXT（.txt）', hint: hint.txt, onSelect: () => exportTxt() },
      { label: 'Markdown（.md）', hint: hint.md, onSelect: () => exportMarkdown() },
      '-',
      // 交换格式：给别的软件用。都是**单画布**，只导当前这张。
      { label: 'FreeMind（.mm）', hint: 'FreeMind / Freeplane / XMind 可导入', onSelect: () => exportExchange('freemind') },
      { label: 'OPML（.opml）', hint: 'OmniOutliner / Workflowy / 幕布 等大纲工具', onSelect: () => exportExchange('opml') },
      { label: 'Mermaid（.mmd）', hint: 'GitHub / GitLab / Notion / Obsidian 原生渲染', onSelect: () => exportExchange('mermaid') },
      { label: 'PlantUML（.puml）', hint: 'PlantUML / Confluence / 多数 Wiki', onSelect: () => exportExchange('plantuml') },
      '-',
      { label: 'SVG（.svg）', hint: hint.svg, onSelect: () => exportSvg() },
      '-',
      { label: 'PDF（矢量，直接保存）', hint: hint.pdf, onSelect: () => exportPdf() },
      { label: '打印 / 存为 PDF…', hint: '用系统打印对话框，可在其中选「另存为 PDF」', onSelect: () => openPrintSettings(app, (o) => printMap(o)) },
      '-',
      { label: 'PNG · 1 倍', hint: hint.png, onSelect: () => exportPng(1) },
      { label: 'PNG · 2 倍（高清）', hint: '像素密度翻倍，文字与连线不糊', onSelect: () => exportPng(2) },
      { label: 'PNG · 3 倍（超清）', hint: '体积较大，适合打印或大屏', onSelect: () => exportPng(3) },
    ]);
  }

  const B = (label, onclick, opt = {}) =>
    h('button.mm-btn' + (opt.icon ? '.icon' : ''), {
      onclick: (e) => {
        const r = onclick?.(e);
        if (opt.refocus !== false) refocusCanvas();
        return r;
      },
      title: opt.title || '',
    }, label);

  const group = (...els) => h('div.mm-row', {}, ...els);

  /**
   * 属性侧栏的四个页签，位置对齐 C# MindMapPanel 的顶栏最右（Grid.Column=14）：
   * SideBtnTheme → SideBtnTag → SideBtnStyle → SideBtnFile。
   *
   * 放在顶栏而不是侧栏顶部有两个理由：
   *   1. 与原版一致；
   *   2. 不占侧栏高度 —— 侧栏只有 276px 宽、纵向空间本就紧张，
   *      顶部再压一条页签条等于凭空少一屏内容的 1/10。
   */
  const SIDE_TABS = [['theme', '主题'], ['tag', '标签'], ['style', '样式'], ['file', '文件']];
  let sideTabsEl = null;

  function buildSideTabs() {
    sideTabsEl = h('div.mm-top-tabs', {});
    for (const [key, label] of SIDE_TABS) {
      sideTabsEl.appendChild(B(label, () => side?.open(key), { title: `切换到${label}页` }));
    }
    return sideTabsEl;
  }

  /** 高亮当前页签。侧栏也会自行切页（例如点节点附件会跳到「文件」页），
   *  所以这里由 side 的 onPage 回调驱动，而不是只在点击时更新。 */
  function syncSideTabs(page) {
    if (!sideTabsEl) return;
    [...sideTabsEl.children].forEach((b, i) => {
      b.classList.toggle('on', SIDE_TABS[i][0] === page);
    });
  }

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
        const st = searchStatusText(searchInput.value, bridge?.search(searchInput.value));
        searchInfo.textContent = st.text;
        searchInfo.classList.toggle('warn', st.warn);
      },
    });

    toolbar.appendChild(group(
      B('导入', () => importFile(), { title: '导入 XMind / JSON / Markdown' }),
      // A39 导出格式菜单：原先「导出」直接导出 JSON，
      // 但按钮上写的是「导出」而不是「导出 JSON」—— 点了才知道出来的是什么格式。
      // 里出全部格式（含 PNG 倍率），左键点开、右键也出。
      (() => {
        const btn = h('button.mm-btn', {
          title: '导出为……（左键或右键都能打开格式菜单）',
          onclick: (e) => { e.preventDefault(); openExportMenu(btn); },
          oncontextmenu: (e) => { e.preventDefault(); openExportMenu(btn); },
        }, '导出 ▾');
        return btn;
      })(),
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
      const st = searchStatusText(searchInput.value, bridge?.search(searchInput.value));
      searchInfo.textContent = st.text;
      searchInfo.classList.toggle('warn', st.warn);
    }), searchInfo));

    toolbar.appendChild(group(
      // 设置放在重载左边。
      // refocus:false 是必要的 —— 打开的是模态浮层，若按默认把焦点还给画布，
      // 画布会在浮层**背后**继续响应快捷键（Tab 会插节点、Delete 会删节点）。
      B('设置', () => openSettings(app), {
        title: '备份间隔、保留份数、布局动画等全局设置',
        refocus: false,
      }),
      B('重载', () => reloadEditor(), { title: '重新加载编辑器内核' }),
    ));

    // 属性侧栏页签：顶栏最右（对齐 C# 的 Grid.Column=14）
    toolbar.appendChild(buildSideTabs());
    syncSideTabs(side?.current());
  }

  /* ------------------------- 侧栏 ------------------------- */

  function buildRail() {
    rail.innerHTML = '';
    // 图标条只留「文件库」开关：四个属性页入口在顶栏最右（对齐 C#）。
    rail.appendChild(h('button.mm-btn' + (settings.filesOpen ? '.on' : ''), {
      title: settings.filesOpen ? '隐藏脑图文件列表' : '显示脑图文件列表',
      onclick: () => toggleFiles(),
    }, '📚'));
  }

  /* ------------------------- 页签 ------------------------- */

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const s of workbook.sheets) {
      const active = s.id === workbook.activeId;
      // data-tab-id：拖拽用事件委托按它找目标，故 renderTabs 重建后无需重新绑定
      const btn = h('button.mm-tab' + (active ? '.active' : ''), {
        ondblclick: guard('重命名', () => renameSheet(s.id)),
        'data-tab-id': s.id,
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
      tabsEl.appendChild(btn);
    }
  }

  /**
   * A53–A57 页签拖拽：改用 Pointer Events 自建状态机（见 tab-drag.js）。
   *
   * 事件委托挂在容器上，所以上面 renderTabs() 每次重建 DOM 都不会累积监听器。
   */
  const tabDrag = attachTabDrag(tabsEl, {
    // 只有一张画布时拖了也没意义，直接不启动
    canDrag: () => (workbook.sheets?.length || 0) > 1,
    getOrder: () => workbook.sheets.map((s) => s.id),
    onReorder: guard('调整顺序', (order) => applyTabOrder(order)),
  });

  /** 按新顺序重排画布。order 来自 DOM，故以 DOM 为准做一次归并 */
  function applyTabOrder(order) {
    const map = new Map(workbook.sheets.map((s) => [s.id, s]));
    const next = [];
    for (const id of order) {
      const s = map.get(id);
      if (s) { next.push(s); map.delete(id); }
    }
    // 兜底：DOM 里漏掉的（理论上不会）补到末尾，绝不能静默丢画布
    for (const s of map.values()) next.push(s);
    if (next.length !== workbook.sheets.length) { renderTabs(); return; }
    workbook.sheets = next;
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
  /**
   * A49 切换画布的原子性（对照 WPF `SwitchSheetAsync`，
   * `MindMapPanel.xaml.cs:1239-1273`）。
   *
   * WPF 的做法是：重入守卫 → 就绪检查 → 目标存在性检查 → 切换期间抑制保存
   * → finally 里保证补存。Web 版原先只有 `capture()` + `persist()`，缺前四项。
   */
  async function switchSheet(id) {
    // ① 重入守卫（WPF `_switchingSheet`）。
    //    连点两个页签会让两次切换交错：第二次进来时 activeId 已被第一次改掉，
    //    它的 capture() 会把当前编辑器内容写到**第一张**画布上。
    if (switchingSheet) return;
    if (id === workbook.activeId) return;

    // ② 编辑器未就绪时 exportJson 拿不到内容，继续切换就丢当前画布的编辑
    if (!bridge?.ready) { status('编辑器未就绪，稍后再切换画布', true); return; }

    // ③ 目标必须存在。sheet() 的 fallback 是 sheets[0] ——
    //    少了这道检查，切到不存在的 id 会把当前内容盖到第一张画布上。
    const target = workbook.sheets.find((s) => s.id === id);
    if (!target) return;

    // ④ 原子性核心：拿不到当前内容就**不切换**。
    //    activeId 一旦改掉，当前画布的编辑就再也回不来了。
    if (capture() === 'missing') {
      status('画布内容读取失败，已取消切换', true);
      return;
    }

    switchingSheet = true;
    try {
      workbook.activeId = id;
      renderTabs();
      await loadSheet();
      // 必须 await 且必须落盘：切换画布不触发 onDirty（loadSheet 抑制期间），
      // 自动保存不会被唤起，切完就崩的话刚才的编辑全丢。
      await persist();
    } finally {
      switchingSheet = false;
    }
  }

  /* ------------------------- 文件库（多文档） ------------------------- */

  function renderFiles() {
    fileList?.refresh();
  }

  /**
   * 清空撤销/重做栈。
   * 切换文件时必须清 —— 栈里存的是上一个文件的快照，
   * 跨文件撤销会把别的内容倒进当前画布。
   */
  function resetHistory() {
    undoStack = [];
    redoStack = [];
    lastSnap = null;
    lastBackupFp = null;
    lastBackupAt = 0;
    // 切文件后编辑器历史也会重置，锁必须跟着解 ——
    // 否则会拿着上一个文件的栈标记去操作新文件。
    pendingRedo = null;
  }

  /** 只做「载入并切换」，不保存当前文件（保存由 openFile 负责） */
  async function switchToFile(id) {
    currentFileId = id;
    settings.lastFileId = id;
    await store.settings.save(settings);
    workbook = (await store.doc(id).load()) || wb.newWorkbook();
    workbook.sheets = wb.normalizeSheets(workbook.sheets);
    resetHistory();
    renderTabs();
    renderFiles();
    await loadSheet();
    updateBadge();
  }

  /** 打开另一个脑图文件：先收当前编辑并落盘，失败则拒绝切换（避免丢内容） */
  async function openFile(id) {
    if (id === currentFileId) return;
    if (!fileIndex.some((f) => f.id === id)) { status('文件不存在', true); return; }
    capture();
    const saved = await persist();
    if (!saved) { status('切换失败：当前脑图没能保存', true); return; }
    await switchToFile(id);
    status('已打开：' + (fileIndex.find((f) => f.id === id)?.name || ''));
  }

  async function createFile(folderId = null) {
    // 当前文件还在列表里才保存 —— 删掉最后一个文件后 currentFileId 已成孤儿，
    // 此时 persist 会把内容写回刚删掉的 doc 键，留下一份没人引用的垃圾数据。
    if (fileIndex.some((f) => f.id === currentFileId)) {
      capture();
      await persist();
    }
    const id = newFileId();
    await store.doc(id).save(wb.newWorkbook());
    const base = '未命名脑图';
    let name = base;
    let n = 1;
    while (fileIndex.some((f) => f.name === name)) name = `${base} ${++n}`;
    fileIndex.push({ id, name, folderId });
    await store.files.save(fileIndex);
    renderFiles();
    status('已新建：' + name);
    await openFile(id);
  }

  function renameFile(id) {
    const f = fileIndex.find((x) => x.id === id);
    if (!f) return;
    const name = window.prompt('脑图名称', f.name);
    if (name == null) return;
    f.name = name.trim() || f.name;
    store.files.save(fileIndex);
    renderFiles();
    status('已重命名');
  }

  /**
   * 删除文件。删的是当前文件时直接切到另一个（不能走 openFile，
   * 它会先 persist 到刚删掉的 doc 上，等于把内容写回去）。
   */
  async function deleteFile(id) {
    const f = fileIndex.find((x) => x.id === id);
    if (!f) return;
    if (!window.confirm(`删除「${f.name}」？该脑图下的所有画布都会一并删除。`)) return;
    fileIndex = fileIndex.filter((x) => x.id !== id);
    await store.files.save(fileIndex);
    await store.doc(id).del();
    if (id === currentFileId) {
      if (fileIndex.length) await switchToFile(fileIndex[0].id);
      else await createFile(null);        // 删光了也要能继续用
    }
    renderFiles();
    status('已删除：' + f.name);
  }

  async function createFolder() {
    const name = window.prompt('文件夹名称', '新建文件夹');
    if (name == null) return;
    foldersList.push({ id: newFolderId(), name: name.trim() || '新建文件夹', collapsed: false });
    await store.folders.save(foldersList);
    renderFiles();
    status('已新建文件夹');
  }

  function renameFolder(id) {
    const fo = foldersList.find((x) => x.id === id);
    if (!fo) return;
    const name = window.prompt('文件夹名称', fo.name);
    if (name == null) return;
    fo.name = name.trim() || fo.name;
    store.folders.save(foldersList);
    renderFiles();
  }

  /** 只删文件夹，里面的文件移到根目录（不连带删除，避免误删内容） */
  async function deleteFolder(id) {
    const fo = foldersList.find((x) => x.id === id);
    if (!fo) return;
    const n = fileIndex.filter((f) => f.folderId === id).length;
    if (!window.confirm(`删除文件夹「${fo.name}」？里面 ${n} 个脑图会移到根目录，不会被删除。`)) return;
    for (const f of fileIndex) if (f.folderId === id) f.folderId = null;
    foldersList = foldersList.filter((x) => x.id !== id);
    await store.files.save(fileIndex);
    await store.folders.save(foldersList);
    renderFiles();
    status('已删除文件夹');
  }

  function toggleFolder(id) {
    const fo = foldersList.find((x) => x.id === id);
    if (!fo) return;
    fo.collapsed = !fo.collapsed;
    store.folders.save(foldersList);
    renderFiles();
  }

  async function moveFile(fileId, folderId) {
    const f = fileIndex.find((x) => x.id === fileId);
    if (!f || f.folderId === folderId) return;
    if (folderId && !foldersList.some((x) => x.id === folderId)) return;
    f.folderId = folderId;
    await store.files.save(fileIndex);
    renderFiles();
    const to = folderId ? (foldersList.find((x) => x.id === folderId)?.name || '文件夹') : '根目录';
    status(`已把「${f.name}」移到 ${to}`);
  }

  function fileState() {
    return { files: fileIndex, folders: foldersList, currentId: currentFileId };
  }

  /** 文件库面板展开/隐藏，状态记在设置里，下次进来保持 */
  function toggleFiles(force) {
    const on = force == null ? !settings.filesOpen : !!force;
    settings.filesOpen = on;
    store.settings.save(settings);
    fileList?.setOpen(on);
    buildRail();
  }

  /* ------------------------- 保存抑制（A48） ------------------------- */

  /**
   * A48 自动保存抑制与补存，对照 WPF `DelayThenClearSuppressAsync`
   * （`MindMapPanel.xaml.cs:1850-1861`）：import 期间抑制保存，延迟解除，
   * **期间有变更则补存一次**。
   *
   * 为什么不能只用一个同步开关：importJson 之后内核还会派发
   * `layoutallfinish` / `selectionchange` 等异步事件，其中任何一个触发
   * contentchange 都会被当成用户编辑 → 自动保存 → 无谓地重排历史栈。
   *
   * 为什么必须补存：抑制窗口内若真有用户编辑，只吞不补就永久丢失。
   */
  function beginSuppress() {
    suppress = true;
    dirtyDuringSuppress = false;
    clearTimeout(suppressTimer);
    suppressTimer = null;
  }

  /** 延迟解除：吸收异步派发；期间若有变更则补存 */
  function endSuppressSoon() {
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      suppressTimer = null;
      suppress = false;
      if (dirtyDuringSuppress) {
        dirtyDuringSuppress = false;
        scheduleSave();
      }
    }, SUPPRESS_MS);
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
    endSuppressSoon();   // 继续吸收异步派发（详见 beginSuppress 的注释）

    // A67 注册顺序：切换/重载画布后**按 customThemes 的既有顺序**注册全部。
    //
    // 原先只注册当前画布用的那一个，于是切到另一张画布后，之前注册过的自定义
    // 主题全丢了 —— 在主题面板里看得见（列表读的是 customThemes）、点上去却
    // 报「注册失败」，因为编辑器侧根本没这个主题。重载编辑器后表现又不一样
    // （注册状态被清空），同一个操作两种结果。
    //
    // 顺序必须固定为 customThemes 的数组序：core 用「注册序」做主题回退链，
    // 顺序不定会让同名/近名主题的解析结果漂移。
    registerCustomThemes();
    bridge.setTheme(s.theme || DEFAULT_THEME);
    bridge.setTemplate(s.layout || DEFAULT_LAYOUT);

    // 切换 / 重新装载画布后重置历史：编辑器侧的 importJson 已自动 commit 新基线
    // （每次导入都是新的历史起点，不会把上一张画布的编辑带过来），这里再显式清一次双保险；
    // 插件层回退栈也要清空，避免跨画布混用。
    lastSnap = bridge.exportJson() || s.content;
    bridge?.historyClear();
    undoStack = [];
    redoStack = [];
    // 切换/重载画布会重置编辑器历史基线，锁必须解 ——
    // 否则会拿旧栈标记去操作新画布（与 resetHistory 同理）
    pendingRedo = null;
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
  /**
   * 从编辑器取回 JSON 写进当前画布。
   *
   * @returns {'missing'|'same'|'changed'}
   *   - missing：拿不到内容（编辑器未就绪 / 导出失败）。
   *     **调用方必须据此中止写操作** —— 否则会把「空」当成当前内容，
   *     或（更糟）在切换画布时把 activeId 改掉后丢掉当前编辑。
   *   - same：内容与已存的一致，无需写回。
   *   - changed：已写回 s.content。
   */
  function capture() {
    if (!bridge?.ready) return 'missing';
    const json = bridge.exportJson();
    if (!json) return 'missing';
    const s = sheet();
    // 按内容比较：exportJson() 每次返回新对象，用 === 永远不等，
    // 「内容没变就不必写回」的判断会永远失效。
    if (sameSnap(s.content, json)) return 'same';
    s.content = json;
    return 'changed';
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
      // 新编辑使重做链失效 —— 编辑器栈自己会清，本地栈在这里清。
      // 锁也一并解掉：新编辑之后的重做该重新选栈（可能编辑器刚就绪）。
      pendingRedo = null;
    }
    lastSnap = json;

    s.content = json;
    dirty = false;

    // 竞态保护：本函数由 setTimeout 触发且全程异步。若保存进行中用户切了文件，
    // 迟到的这次会把「旧 workbook」盖到新文件的 doc 键上 —— 直接丢内容。
    //
    // ⚠️ 下面这两行之间**不要插任何 await**。
    //    `save(workbook)` 的 workbook 是在调用那一瞬间求值的闭包变量。
    //    捕获后立刻写入，workbook 就还是「捕获那一刻」的对象，安全；
    //    中间一旦让出控制权，switchToFile 可能已经跑完 —— 于是
    //    savedFileId 还是旧 id，workbook 却已换成新文件的内容，
    //    结果是**用新文件的内容覆盖旧文件**，而下面的守卫只能拦住状态栏
    //    和备份，拦不住已经发生的这次写入。
    //    （mindmap-test.mjs 的 M1 分组里锁了这条约束。）
    const savedFileId = currentFileId;
    // store.set 失败是返回 false 而不是抛出，不检查就会在「根本没存进去」的
    // 情况下继续往下走、最后提示「已保存」——比不提示更糟。
    // 键必须用 doc:<currentFileId>，与 persist()/加载路径保持一致；
    // 写 'workbook'（旧版迁移键，只用于首次迁移读取）等于内容永远读不回来。
    const saved = await store.doc(savedFileId).save(workbook);
    if (savedFileId !== currentFileId) return;   // 期间切了文件，丢弃
    if (!saved) {
      status('自动保存失败：本地存储写入被拒绝（可能是空间不足）', true);
      return;
    }

    // 滚动快照：间隔可配（0=关闭），且与最新快照逐张比对，内容没变就只重置计时不写盘。
    // 对齐 C# 版 MaybeBackupAsync 的行为，避免每次到点都白写一份。
    // A47 暂停：pause 是**临时**停、保留原间隔值；interval=0 是**永久关闭**。
    // 两者必须分开 —— 若用「置 0」来暂停，恢复时用户得重新想起原来设的几分钟。
    const now = Date.now();
    const intervalMs = (Number(settings.backupMinutes) || 0) * 60 * 1000;
    if (!settings.backupPaused && intervalMs > 0 && now - lastBackupAt > intervalMs) {
      lastBackupAt = now;
      const fp = wb.fingerprintSheets(workbook.sheets);
      if (fp !== lastBackupFp) {
        lastBackupFp = fp;
        await store.pushBackup({ sheets: JSON.parse(JSON.stringify(workbook.sheets)), activeId: workbook.activeId }, settings.backupMax);
      }
    }
    status('已保存 · ' + new Date().toLocaleTimeString());
  }



  /**
   * A42 备份迁移：导出全部快照 / 从文件导入合并。
   *
   * 【为什么不是「备份目录」】C# 版 `MoveMindMapBackupDir` 改的是**文件系统
   * 目录**（MainViewModel.MindMap.cs:75-98），Web 版用 IndexedDB，用户根本
   * 看不到文件，做个「虚拟目录名」既不可见也没人用。
   *
   * 真正等价的诉求是**换机器时能把备份带走** —— 所以落地成导出 / 导入文件，
   * 这也是 WPF 那个目录的实际用途（拷到别的盘 / 别的机器）。
   *
   * 导入用**合并**而非「整体替换」：C# 的 Move 是移动（旧的没了），但那是
   * 同一个盘的目录搬迁；跨机导入若是替换，一旦选错文件就把本机现有快照
   * 全清了 —— 不可逆。合并按 ts 去重，重复的跳过，本机原有的保留。
   */
  async function exportBackups() {
    const all = await store.listBackups();
    if (!all.length) { status('没有可导出的快照', true); return; }
    const payload = {
      kind: 'nexus-mindmap-backups',
      version: 1,
      exportedAt: Date.now(),
      backups: all.map((b) => ({ ts: b.ts, sheets: b.sheets, activeId: b.activeId })),
    };
    io.downloadBlob(
      io.stampName('脑图快照', 'json'),
      new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    );
    status(`已导出 ${all.length} 份快照`);
  }

  async function importBackups() {
    const f = await io.pickFile('application/json,.json');
    if (!f) return;
    let data;
    try { data = JSON.parse(await io.readText(f)); } catch { status('快照文件无法解析（不是合法 JSON）', true); return; }
    const list = data?.backups;
    if (!Array.isArray(list) || !list.length) { status('文件里没有快照数据', true); return; }

    const mine = new Set((await store.listBackups()).map((b) => b.ts));
    let added = 0, skipped = 0;
    for (const b of list) {
      // ts 缺失的快照无法排序，也无法去重 —— 宁可跳过也不要塞进库里
      // 造成「列表里出现一个时间戳为 undefined 的条目」
      if (!b || typeof b.ts !== 'number' || !Array.isArray(b.sheets)) { skipped++; continue; }
      if (mine.has(b.ts)) { skipped++; continue; }
      const ok = await store.putBackup({ ts: b.ts, sheets: b.sheets, activeId: b.activeId });
      if (ok) { added++; mine.add(b.ts); } else skipped++;
    }
    await trimBackups();
    status(`已导入 ${added} 份快照${skipped ? `，跳过 ${skipped} 份（重复或格式不符）` : ''}`);
  }

  /**
   * 按当前上限滚动清理旧快照。
   * 份数调小后必须立刻收敛，否则要等到下次备份才生效 —— 期间快照数一直超上限。
   */
  async function trimBackups() {
    try {
      const n = Number(settings.backupMax);
      const limit = Number.isFinite(n) && n >= 1 ? Math.floor(n) : store.BACKUP_KEEP;
      const all = (await store.keys('backup:')).sort();
      for (let i = 0; i < all.length - limit; i++) await store.del(all[i]);
    } catch (e) {
      status('清理旧快照失败：' + (e?.message || e), true);
    }
  }

  async function persist() {
    // 内部兜底：调用方基本都是 fire-and-forget，写失败（配额触顶等）必须看得见。
    // 注意 store.set 是「吞异常返回 false」而不是抛出，所以必须检查返回值，
    // 只写 try/catch 的话写失败会被静默吞掉。
    try {
      const ok = await store.doc(currentFileId).save(workbook);
      if (!ok) status('保存失败：本地存储写入被拒绝（可能是空间不足）', true);
      return ok;
    } catch (e) {
      status('保存失败：' + (e?.message || e), true);
      return false;
    }
  }

  /** 编辑器侧 contentchange 回调 */
  function onDirty() {
    // 抑制期间**不能只是丢弃**：这期间也可能有真实的用户编辑
    // （例如切换画布后立刻打字），吞掉就等于永久丢失。
    // 记下来，等抑制解除后补存 —— 对应 WPF 的 _dirtyDuringSuppress。
    if (suppress) { dirtyDuringSuppress = true; return; }
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
      // SHELL_CHANNEL 是 plugin-sdk 的公开常量，同页面里任何脚本都能伪造。
      // 用 e.source 锁定只有父窗口（外壳）发的才算数 —— 与 editor-bridge.js
      // 校验内层 iframe 的做法保持一致。
      if (e.source !== window.parent) return;
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
  /**
   * 拖放附加。
   *
   * 设计取舍（都已与用户确认）：
   * - **拖到空白处忽略**，不新建节点 —— 拖放容错差，误建的空白节点清理起来很烦。
   *   但要明确提示，否则用户只会觉得"拖了没反应"
   * - **多个文件**：第一个挂到目标节点，其余各建一个子节点（名字取文件名主干）
   * - **覆盖前提示**：图片/视频/文件各自是单值字段，挂第二个会顶掉第一个。
   *   提示开关放在设置里（`settings.confirmDropOverwrite`，默认开）
   *
   * 为什么每轮都要重新 selectNodeById：存资产要写 IndexedDB，是**异步**的，
   * 期间用户可能点了别处、选中态就变了。不重锁的话第二个文件会挂到错误节点上。
   */
  async function handleDropFiles(files, nodeId) {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (!bridge?.ready) { status('编辑器未就绪，无法附加', true); return; }

    const items = list.map((f) => ({ file: f, kind: io.classifyFile(f.name, f.type) }));
    let done = 0;
    const failed = [];
    let skipped = 0;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const label = { image: '图片', video: '视频', file: '文件' }[it.kind];

      // 每轮重新锁定目标节点（见上方注释）
      if (nodeId) bridge.selectNodeById(nodeId);

      if (i > 0) {
        // 其余各建子节点。名字用文件主干，否则一堆「新建节点」分不清谁是谁
        if (!bridge.insertChildNamed(io.stemOf(it.file.name))) {
          failed.push(it.file.name);
          continue;
        }
      } else if (hasAttachment(it.kind)) {
        // 第一个挂到目标节点：字段是单值，挂上去会顶掉原有的
        if (settings.confirmDropOverwrite !== false) {
          const ok = await confirmDialog(
            `替换${label}`,
            `该节点已有${label}。\n\n继续将用「${it.file.name}」替换它，原${label}不可恢复。`,
            '继续替换', true);
          if (!ok) { skipped++; continue; }
        }
      }

      const ok = await attachDropped(it);
      if (ok) done++; else failed.push(it.file.name);
    }

    commit();
    side.refresh();

    if (done) {
      const extra = items.length > 1 ? `（${done} 个，其余建为子节点）` : '';
      status(`已附加：${items[0].file.name}${extra}`);
      ctx.toast(`已附加 ${done} 个`, 'ok');
    }
    if (skipped) status(`已跳过 ${skipped} 个（未替换已有附件）`);
    if (failed.length) status(`以下文件附加失败：${failed.join('、')}`, true);
  }

  /** 当前选中节点上是否已有该类附件 */
  function hasAttachment(kind) {
    if (kind === 'image') return !!bridge?.getSelectedImage?.();
    return !!api?.selectedRef?.(kind);
  }

  /** 把单个拖放文件附加到当前选中节点 */
  async function attachDropped(it) {
    try {
      if (it.kind === 'image') {
        // 与侧栏「浏览图片」一致：内联成 dataURL，随 .xmind 一起导出
        if (it.file.size > 2 * 1024 * 1024) {
          status(`「${it.file.name}」超过 2MB，会让脑图文件明显变大`, true);
        }
        const url = await new Promise((res) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => res(null);
          fr.readAsDataURL(it.file);
        });
        if (!url) return false;
        bridge.setImage(url);
        return true;
      }
      const id = await io.putAsset(it.file);
      if (!id) return false;
      const payload = io.encodeRef({ n: it.file.name, a: id, s: it.file.size });
      if (it.kind === 'video') bridge.setVideo(payload); else bridge.setFile(payload);
      return true;
    } catch {
      return false;
    }
  }

  async function openAttachment(raw) {
    const ref = io.decodeRef(raw);
    if (!ref) { status('附件引用无法识别', true); return; }

    // 侧栏切到文件页（已是该页就保持展开，不做 toggle 收起）
    if (side.current() !== 'file') side.open('file');

    if (!ref.a) {
      status('该附件是旧版本地路径，沙箱内无法打开（请重新附加一次）', true);
      return;
    }
    // 先只取记录（不建 URL）判断走向：要预览/播放才建，纯下载不必建，
    // 少一次创建就少一处可能忘记 revoke 的泄漏点。
    const rec = await io.getAsset(ref.a);
    if (!rec?.blob) { status('附件数据已丢失', true); return; }
    const name = rec.name || ref.n || '附件';

    // A19 自动播放策略（对照 WPF OnOpenFileRequested，:483-491）。
    //
    // 原版在这里传 `autoplayVideo: true`，而**附加**文件后传的是 `false`
    // （:446 / :477）——即：点了节点图标才自动播，刚选完文件不播，先看首帧。
    // 这条区分是有道理的：附加时用户还在整理素材，突然出声很干扰；
    // 主动点开才是明确的播放意图。Web 版沿用同一套。
    if (/\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(name)) {
      const asset = await io.getAsset(ref.a, true);
      if (!asset?.url) { status('视频数据已丢失', true); return; }
      openVideo(app, { ...asset, name });
      status('正在播放：' + name);
      return;
    }
    if (/^image\//.test(rec.blob.type || '')) {
      const asset = await io.getAsset(ref.a, true);
      if (!asset?.url) { status('图片数据已丢失', true); return; }
      openPreview(app, { ...asset, name });
      return;
    }
    // A15 「用默认程序打开」在 Web 版没有对应能力 —— 浏览器拿不到系统
    // 关联程序，也不能对沙箱内的 Blob 调 ShellExecute（WPF 那句
    // `Process.Start(UseShellExecute=true)` 在此处不成立）。
    //
    // 落地成「导出到下载目录」：文件确实到了本地，用户双击即可用默认程序
    // 打开。与 C# 版的差距只在最后一步需要手动双击，且必须**说出来** ——
    // 不提示的话用户看到「已导出」会以为是在别的地方又存了一份。
    // rec.name 来自导入的 .xmind，是不可信输入 —— 交给 safeFileName 剥掉
    // 路径分隔符与控制字符，不依赖浏览器对 <a download> 的自发处理。
    io.downloadBlob(io.safeFileName(name), rec.blob);
    status(`已保存到下载目录：${name}（可双击用默认程序打开）`);
  }

  /* ------------------------- 撤销 / 重做 ------------------------- */

  function applySnapshot(json) {
    if (!json) return;
    beginSuppress();
    bridge.importJson(json);
    endSuppressSoon();
    sheet().content = json;
    lastSnap = json;
    scheduleSave();
  }

  /**
   * B1 统一撤销栈（对照 WPF `Undo`/`Redo`，`MindMapPanel.xaml.cs:2194-2208`）。
   *
   * WPF 只有一个栈：无条件 `ExecCommandAsync("undo"/"redo")`。
   * Web 版原先是「优先编辑器栈，拿不到就回退本地快照栈」，**两条路径会在
   * 一次撤销序列里混用** —— 这是真实的丢数据路径：
   *
   *   1. 连按撤销：编辑器栈有 3 步 → 走编辑器栈，撤销 3 次；
   *   2. 编辑器栈空了 → `history('undo')` 返回 false → 回退到**本地栈**；
   *   3. 此时按重做：`redo()` 先试编辑器栈 —— 它有 3 条待重做！
   *      → 重做的是编辑器的第 3 次撤销，**本地那次撤销永远重做不回来**，
   *        且本地 `redoStack` 里留了一条孤儿，之后会突然跳到旧内容。
   *
   * 修法：**一次撤销序列只用一条栈**。
   *   - `pickHistoryStack()` 决定用哪条（编辑器可用就用它）；
   *   - `pendingRedo` 锁住「这次撤销用的哪条栈」，重做必须走同一条；
   *   - 产生新编辑时清掉这把锁（新编辑本来就使重做链失效）。
   */
  function pickHistoryStack() {
    return bridge?.hasHistory?.() ? 'editor' : 'local';
  }

  function undo() {
    const stack = pendingRedo || pickHistoryStack();
    if (stack === 'editor') {
      const r = bridge?.history('undo');
      // 编辑器栈空就到此为止 —— **不再回退到本地栈**，否则一次序列里混用两条栈
      if (r === true) { pendingRedo = 'editor'; status('已撤销'); return; }
      status('没有可撤销的操作', true);
      return;
    }
    if (!undoStack.length) { status('没有可撤销的操作', true); return; }
    // lastSnap 为 null 时不能压栈：redo 那边 applySnapshot(null) 会静默返回，
    // 而 undoStack 已经弹出 —— 这次撤销就永久不可恢复了。
    if (lastSnap) redoStack.push(lastSnap);
    applySnapshot(undoStack.pop());
    pendingRedo = 'local';
    status('已撤销（本地栈）');
  }

  function redo() {
    // 与上一次撤销**必须同栈**，否则会重做到另一条栈上去
    const stack = pendingRedo || pickHistoryStack();
    if (stack === 'editor') {
      const r = bridge?.history('redo');
      if (r === true) { status('已重做'); return; }
      status('没有可重做的操作', true);
      return;
    }
    if (!redoStack.length) { status('没有可重做的操作', true); return; }
    // 与 undo 对称：null 不入栈，避免 redo 之后无法再撤销
    if (lastSnap) undoStack.push(lastSnap);
    applySnapshot(redoStack.pop());
    status('已重做（本地栈）');
  }

  /* ------------------------- 主题 / 布局 ------------------------- */

  /**
   * A67 按既有序注册**全部**自定义主题。
   *
   * 只注册当前用的那一个是不够的：core 的主题表在编辑器实例内存活，
   * 切换画布不会清空它，但**重载编辑器会** —— 于是「切换」和「重载」
   * 两种操作后主题可用性不一致，同一个按钮时灵时不灵。
   *
   * 逐个注册且**不因单个失败中断**：一个主题数据坏了不该连累其它主题，
   * 否则用户会看到「所有自定义主题都失效」这种放大了的故障。
   *
   * 顺序必须固定为 `customThemes` 的数组序：core 用注册序做主题解析，
   * 顺序漂移会让「切换画布」与「重载编辑器」得到不同的解析结果，
   * 表现为同一个主题按钮时灵时不灵。
   *
   * @returns {number} 成功注册的数量
   */
  function registerCustomThemes() {
    let n = 0;
    for (const t of customThemes || []) {
      try { if (bridge?.registerTheme(t)) n++; } catch { /* 单个坏主题不连累其它 */ }
    }
    return n;
  }

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

  /**
   * Markdown 导出（B27）。
   *
   * **必须先 capture()**：这里读的是 `workbook.sheets`（内存里的数据结构），
   * 不是编辑器实时状态。少了这一句，用户改完节点立刻导出会拿到**改之前**的内容。
   *
   * exportJson / exportTxt 早就有这一句，只有这里漏了 ——
   * 又是「同一件事多条路径、只修了一条」（已第三次遇到，见 README）。
   *
   * 注：PNG / PDF / 打印**不需要** capture —— 它们走 `bridge.exportSvg()`
   * 直接从编辑器取当前画面，本来就是实时的。给它们加反而是多余的序列化开销。
   */
  async function exportMarkdown() {
    capture();
    const text = wb.workbookToMarkdown(workbook.sheets);
    const r = await io.saveText(io.stampName('脑图', 'md'), text, 'text/markdown');
    reportSave(r, 'Markdown');
  }

  /**
   * 交换格式导出（FreeMind / OPML / Mermaid / PlantUML）。
   *
   * **这些都是单画布格式** —— 顶层只有一个根，装不下多画布工作簿。
   * 所以只导出当前画布，并且**必须明确说出来**：
   * 用户有 3 张画布时静默只导 1 张，会以为另外 2 张丢了。
   *
   * 另一处诚实点：这些格式只带「文字 + 层级 + 折叠状态」，
   * 图标/优先级/进度/附件一概不带。塞进自定义属性只会在别的软件里变乱码。
   */
  async function exportExchange(kind) {
    const meta = fmt.FORMAT_META[kind];
    if (!meta) { status('未知导出格式', true); return; }
    const s = sheet();
    if (!s) { status('没有可导出的画布', true); return; }
    capture();

    let text = '';
    if (kind === 'freemind') text = fmt.toFreemind(s.content);
    else if (kind === 'opml') text = fmt.toOpml(s.content, s.title || '脑图');
    else if (kind === 'mermaid') text = fmt.toMermaid(s.content);
    else if (kind === 'plantuml') text = fmt.toPlantUml(s.content);

    if (!text) { status(`${meta.label} 导出失败：画布内容无法解析`, true); return; }

    // 画布标题是用户随手起的，可能含 / : 等文件名非法字符 —— 必须安全化
    const r = await io.saveText(
      io.stampName(io.safeFileName(s.title || '脑图'), meta.ext),
      text,
      `${meta.mime};charset=utf-8`,
    );
    reportSave(r, meta.label);

    // 多画布时补一句说明，放在保存之后 —— 先让人看到文件存好了
    const extra = workbook.sheets?.length > 1
      ? `（仅当前画布；${meta.label} 是单画布格式，其余 ${workbook.sheets.length - 1} 张请用 .xmind 或 .json 导出）`
      : '';
    if (extra) status(extra);
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

  /**
   * A38 高分辨率整图 PNG。
   *
   * 走 SVG 中间层而不是内核的 `exportData('png')` —— 后者传更大的尺寸只是
   * 在四周补白（见 io.svgToPngBlob 的注释），出不来真正的高分辨率。
   *
   * @param {number} [scale=1] 倍数
   */
  async function exportPng(scale = 1) {
    const s = Math.max(1, Number(scale) || 1);
    let blob = null;
    try {
      const svg = await bridge?.exportSvg();
      if (!svg) { status('PNG 导出失败：无法取得矢量图（编辑器未就绪？）', true); return; }
      blob = await io.svgToPngBlob(svg, s);
    } catch (e) {
      status('PNG 导出失败：' + (e?.message || e), true);
      return;
    }
    if (!blob) { status('PNG 导出失败：矢量图无法光栅化', true); return; }
    const r = await io.saveBlob(io.stampName(`脑图${s > 1 ? `@${s}x` : ''}`, 'png'), blob);
    reportSave(r, s > 1 ? `PNG（${s} 倍）` : 'PNG');
  }

  /**
   * A34–A37 打印 / PDF（Web 版新增能力，非 WPF 移植 —— WPF 原版没有打印）。
   *
   * 走浏览器打印对话框：它自带预览，且目标里通常有「另存为 PDF」，
   * 一次实现覆盖打印、预览、PDF 三件事，且不需要写 Rust。
   *
   * 必须先确认能拿到**完整画布**的 SVG：可视视口截图印出来只有一角。
   */
  /**
   * PDF 导出：默认走 **svg2pdf（矢量、静默）**，失败才托底到打印对话框。
   *
   * 通道由 settings.pdfChannel 决定，但**两条路互为托底**，用户不必每次选：
   *
   *   pdfChannel='vector'（默认）
   *      先试 svg2pdf → 成功即静默落盘；
   *      失败则**自动**转打印对话框（并提示），不把失败抛给用户。
   *
   *   pdfChannel='dialog'
   *      直接用打印对话框。（svg2pdf 若失败也无更好选择，本身就需人工确认）
   *
   * 为什么不干脆只保留一条：矢量通道在**字体缺失**等边缘情况下可能失败，
   * 而打印对话框几乎总能出结果 —— 留一条兜底，用户不会卡在「导不出来」。
   */
  async function exportPdf(opts = {}) {
    const wantVector = settings.pdfChannel !== 'dialog';
    const landscape = opts.landscape !== false;
    const margin = opts.margin;

    let svg = null;
    try {
      svg = await bridge?.exportSvg();
    } catch { /* 下面统一处理 */ }

    if (wantVector && svg) {
      try {
        const b64 = await ctx.invoke('mm_svg_to_pdf', {
          svg,
          dpi: io.pdfDpi(svg, { landscape, margin }),
        });
        const blob = io.base64ToBlob(b64, 'application/pdf');
        if (blob) {
          // 必须用 reportSave：saveBlob 有四种返回（ok/cancel/fallback/error），
          // 早先这里写成 `if (r !== 'cancel') 就报成功` —— 'error' 也会落进
          // 那个分支，于是**保存失败却提示「已导出」**。其余 7 处导出函数
          // 都用 reportSave 正确处理了，只有这里漏了。
          const r = await io.saveBlob(
            io.stampName(sheet()?.title || '脑图', 'pdf'), blob);
          reportSave(r, 'PDF（矢量）');
          // 落盘结果无论成败都不再托底：PDF 已经生成好了，
          // 保存失败换打印对话框未必更好（它也要用户自己选位置）。
          // 只有**矢量转换本身**失败才值得托底。
          return;
        }
        throw new Error('返回内容不是合法 PDF');
      } catch (e) {
        // 矢量通道不可用：不弹错误，改为托底。
        // 但要**明确告知**——静默导出突然弹出打印对话框会让人困惑。
        status(`矢量 PDF 不可用，改用打印对话框：${e?.message || e}`, true);
      }
    }

    // 托底（或本来就选了 dialog）：走打印对话框
    if (!svg) { status('PDF 导出失败：无法取得画布矢量图（编辑器未就绪？）', true); return; }
    await printMap({ landscape, margin });
  }

  async function printMap(opts = {}) {
    const svg = await bridge?.exportSvg();
    if (!svg) { status('打印失败：无法取得画布矢量图（编辑器未就绪？）', true); return; }
    const landscape = opts.landscape !== false;   // 脑图通常更宽，默认横向
    let via = '';
    const ok = await io.printSvg(svg, {
      landscape,
      margin: opts.margin,
      title: sheet()?.title || '脑图',
      /**
       * 优先走 Tauri Rust 命令 mm_print。
       *
       * 它在**非 macOS 平台会 reject**（wry 只实现了 macOS 的原生打印），
       * 在浏览器调试模式下 ctx.invoke 也会 reject（不在 Tauri 环境）。
       * 两种情况都返回 false，让 io 层回退到 window.print()。
       *
       * 返回 false 而非抛：这是「路线不可用」而不是「出错」，
       * 不该被当成失败冒泡上去。
       */
      print: async () => {
        try {
          await ctx.invoke('mm_print', {});
          via = 'Tauri 原生';
          return true;
        } catch {
          return false;
        }
      },
    });
    if (ok) status(`已发起打印（A4 ${landscape ? '横向' : '纵向'}${via ? ` · ${via}` : ''}）：${sheet()?.title || '当前画布'}`);
    else status('当前环境不支持打印（需要浏览器窗口）', true);
  }

  function reportSave(r, what) {
    if (r === 'cancel') return;
    if (r === 'error') { ctx.toast(`${what} 保存失败`, 'err'); return; }
    ctx.toast(r === 'fallback' ? `${what} 已导出（由浏览器选择保存位置）` : `${what} 已保存`, 'ok');
  }

  async function importFile() {
    // 交换格式一并收进来：用户常把 .opml 存成 .xml、把 .mmd 存成 .txt，
    // 所以后缀放宽，真正的判断交给 detectFormat 按**内容**嗅探（见下）。
    const f = await io.pickFile('.xmind,.json,.md,.markdown,.mm,.opml,.xml,.mmd,.puml,.txt,application/json,text/markdown,application/xml,text/xml,text/plain');
    if (!f) return;

    // .xmind：二进制 zip，走独立分支（附件会解包进 IndexedDB）
    if (xmind.isXMindName(f.name)) {
      try {
        status('正在解析 XMind…');
        const buf = await io.readBytes(f);
        const r = await xmind.readXMind(buf, io.saveAssetBytes);
        if (!r.sheets?.length) { ctx.toast('文件里没有可用画布', 'err'); return; }
        // A30 同上：XMind 导入同样是整体替换，先确认
        const hadSheets = workbook.sheets?.length || 0;
        if (hadSheets > 0) {
          const ok = await confirmDialog(
            '导入将替换全部画布',
            `当前共有 ${hadSheets} 张画布，导入 .xmind 后会全部被替换。\n\n`
            + `待导入：${r.sheets.length} 张画布\n\n`
            + '此操作不可撤销，建议先「导出」或「立即备份」保存当前内容。',
            '替换', true);
          if (!ok) { status('已取消导入'); return; }
        }
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
    let form = '';

    // 先嗅探**内容**再决定走哪条路。
    // 只按扩展名判断会大面积误判：.opml 常被存成 .xml、.mmd 常被存成 .txt，
    // 而 .mm 既是 FreeMind 也可能是别人导出的 Markdown。
    const kind = fmt.detectFormat(text, f.name);

    if (kind === 'freemind' || kind === 'opml' || kind === 'mermaid' || kind === 'plantuml') {
      const content = kind === 'freemind' ? fmt.fromFreemind(text)
        : kind === 'opml' ? fmt.fromOpml(text)
          : kind === 'mermaid' ? fmt.fromMermaid(text)
            : fmt.fromPlantUml(text);
      if (!content) {
        ctx.toast(`无法解析为 ${fmt.FORMAT_META[kind].label}`, 'err');
        status(`${fmt.FORMAT_META[kind].label} 解析失败：文件结构不符合预期`, true);
        return;
      }
      // 交换格式只带一张画布 —— 用文件名做标题，用户才认得出是哪张
      sheets = [{ id: wb.newSheetId(), title: fmt.baseTitle(f.name), content, theme: null, layout: null }];
      form = kind;
    } else if (kind === 'markdown' || /\.(md|markdown|txt)$/i.test(f.name)) {
      sheets = wb.markdownToWorkbook(text);
      form = 'markdown';
    } else {
      const parsed = wb.parseWorkbook(text);
      if (parsed) { sheets = parsed.sheets; form = parsed.form; }
      else { sheets = wb.markdownToWorkbook(text); form = 'markdown(兜底)'; }   // 兜底：当 Markdown 试一次
    }
    if (!sheets || !sheets.length) { ctx.toast('无法识别该文件', 'err'); return; }

    // A30 整体替换是不可逆的 —— 导入包会**顶掉当前所有画布**。
    // 不确认的话，用户点「导入」选错文件就等于清空了正在编辑的脑图。
    // C# 版 ApplyWorkbookAsync 同样是无条件替换，但它至少有撤销栈兜底；
    // 这里导入后会重置历史（新内容=新基线），撤销救不回来。
    const curCount = workbook.sheets?.length || 0;
    if (curCount > 0) {
      const ok = await confirmDialog(
        '导入将替换全部画布',
        `当前共有 ${curCount} 张画布，导入后会全部被替换。\n\n`
        + `待导入：${sheets.length} 张画布（识别为 ${form}）\n\n`
        + '此操作不可撤销，建议先「导出」或「立即备份」保存当前内容。',
        '替换', true);
      if (!ok) { status('已取消导入'); return; }
    }

    workbook.sheets = sheets;
    workbook.activeId = sheets[0].id;
    renderTabs();
    await loadSheet();
    await persist();
    // A31 把识别到的形态说出来
    const formTip = { workbook: '多画布包', single: '单画布', markdown: 'Markdown',
      'markdown(兜底)': 'Markdown（未按 JSON 解析，走了兜底）',
      freemind: 'FreeMind', opml: 'OPML', mermaid: 'Mermaid', plantuml: 'PlantUML' }[form] || form;
    status(`已导入 ${sheets.length} 张画布（识别为：${formTip}）`);
    ctx.toast(`已导入 ${sheets.length} 张画布`, 'ok');

    // B22 跨机迁移提示：必须**在导入成功后立刻**说，
    // 不能等用户点到那个节点才发现 —— 那时他已经以为文件坏了。
    await warnForeignAssets(sheets);
  }

  /**
   * B22：检查刚导入的画布里有没有「本机读不到」的附件。
   *
   * 本插件的 .json 只存引用，本体在 IndexedDB。换机器导入后，
   * 引用看着正常、附件图标也在，但**字节没跟过来** —— 点开才发现打不开。
   *
   * 只针对 .json 有意义：.xmind 会把附件打包进去，不存在这个问题。
   */
  async function warnForeignAssets(sheets) {
    let ids = [];
    try { ids = wb.collectAssetRefs(sheets); } catch { return; }
    if (!ids.length) return;

    let missing = 0;
    for (const id of ids) {
      try {
        const rec = await store.get('asset:' + id, null);
        if (!rec?.blob) missing++;
      } catch { missing++; }
    }
    if (!missing) return;

    status(
      `⚠ ${missing} 个附件在本机找不到数据（JSON 只带引用、不带本体）。`
      + '如需跨机器迁移，请改用 .xmind 导出（会把附件一起打包）。',
      true,
    );
  }

  /**
   * A44 手动备份也要去重（WPF `BackupNowAsync` 同样先比对再写，
   * `MindMapPanel.xaml.cs:1903-1912` 的 `SameWorkbook` 检查）。
   *
   * 不去重的后果：连点几次「立即备份」就产生一堆内容相同的快照。保留份数是
   * 有限的（默认 10），这些空快照会把**真实的历史版本挤出去** ——
   * 恰好在最需要回滚的时候找不到可用版本。
   *
   * @param {boolean} force true=即使内容相同也强制写一份
   */
  async function backupNow(force = false) {
    capture();
    const fp = wb.fingerprintSheets(workbook.sheets);
    if (!force && fp === lastBackupFp) {
      status('内容与最新快照相同，未重复创建', false);
      return;
    }
    // pushBackup 写失败返回 null（不抛），不判断就会提示「已创建」但实际没写进去
    const key = await store.pushBackup({ sheets: JSON.parse(JSON.stringify(workbook.sheets)), activeId: workbook.activeId }, settings.backupMax);
    lastBackupAt = Date.now();
    lastBackupFp = fp;
    if (key) ctx.toast('已创建快照', 'ok');
    else status('快照创建失败（本地存储写入被拒绝）', true);
  }

  /**
   * A46 从快照恢复：会**覆盖当前所有画布**，不可逆。
   *
   * 两道保护：
   *   1. 调用前由 UI 弹确认（见 panels.js 的 openBackups）；
   *   2. 恢复前先把当前状态存成一份快照 —— 万一恢复错了（比如选错时间点）
   *      还能再回滚回来。成本几乎为零：这份快照是最新的，不会被滚动删除。
   */
  async function restoreBackup(b) {
    // 先给当前状态留一份，再覆盖
    await backupNow(true);
    workbook.sheets = wb.normalizeSheets(b.sheets);
    workbook.activeId = b.activeId || workbook.sheets[0].id;
    renderTabs();
    await loadSheet();
    await persist();
    lastBackupFp = wb.fingerprintSheets(workbook.sheets);
    ctx.toast('已从快照恢复（恢复前的状态已另存一份）', 'ok');
  }

  /* ------------------------- 对外能力（供 panels 用） ------------------------- */

  // api 层统一兜底：面板和工具栏都是 onclick 直接调用，拿不到 Promise，
  // 异步失败不包一层就只会在控制台留 unhandled rejection，界面上毫无反应。
  const api = {
    status,
    commit,
    // —— 文件库（左侧面板）——
    fileState,
    openFile: guard('打开文件', openFile),
    createFile: guard('新建文件', (folderId) => createFile(folderId)),
    renameFile: guard('重命名', renameFile),
    deleteFile: guard('删除文件', deleteFile),
    createFolder: guard('新建文件夹', createFolder),
    renameFolder: guard('重命名文件夹', renameFolder),
    deleteFolder: guard('删除文件夹', deleteFolder),
    toggleFolder: guard('折叠文件夹', toggleFolder),
    moveFile: guard('移动文件', moveFile),
    backupNow: guard('备份', backupNow),
    exportBackups: guard('导出快照', exportBackups),
    importBackups: guard('导入快照', importBackups),
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
    /** 拖放附加时，目标节点已有同类附件是否先确认 */
    setConfirmDropOverwrite: guard('设置覆盖提示', async (on) => {
      settings.confirmDropOverwrite = !!on;
      const ok = await store.settings.save(settings);
      if (!ok) { status('设置保存失败', true); return; }
      status(settings.confirmDropOverwrite ? '拖放覆盖前会提示' : '拖放覆盖前不再提示');
    }),
    /** 修改设置项（自动快照间隔 / 布局动画），改完立即持久化并生效 */
    setBackupMinutes: guard('设置快照间隔', async (m) => {
      settings.backupMinutes = Number(m) || 0;
      const ok = await store.settings.save(settings);
      if (!ok) { status('设置保存失败', true); return; }
      status(settings.backupMinutes === 0 ? '自动快照已关闭' : `自动快照间隔：${settings.backupMinutes} 分钟`);
    }),
    /**
     * 最多保留备份份数（对应 C# MindMapBackupMax，默认 3）。
     * 改完立即按新上限滚动清理，否则旧快照会一直堆到下次备份才收敛。
     */
    /**
     * A47 暂停 / 恢复自动快照。
     * 与「间隔=0（永久关闭）」是两条独立的状态：暂停只加一个布尔位，
     * 原间隔值原样留着，恢复时立刻回到原来的节奏。
     */
    setBackupPaused: guard('暂停快照', async (on) => {
      settings.backupPaused = !!on;
      const ok = await store.settings.save(settings);
      if (!ok) { status('设置保存失败', true); return; }
      status(settings.backupPaused
        ? `自动快照已暂停（间隔仍为 ${settings.backupMinutes || 0} 分钟，恢复后继续）`
        : `自动快照已恢复（每 ${settings.backupMinutes || 0} 分钟）`);
    }),
    setBackupMax: guard('设置保留份数', async (n) => {
      settings.backupMax = Number(n) || store.BACKUP_KEEP;
      const ok = await store.settings.save(settings);
      if (!ok) { status('设置保存失败', true); return; }
      await trimBackups();
      status(`最多保留 ${settings.backupMax} 份快照`);
    }),
    /**
     * PDF 导出通道（settings.pdfChannel）。
     *
     * 只决定「先试哪条」——任一通道不可用都会自动托底到另一条，
     * 所以这里选错也不会导不出来，最多是少弹/多弹一次对话框。
     *
     * 'vector'（默认）：svg2pdf 矢量转换，不弹对话框直接保存。
     * 'dialog'        ：走系统打印对话框，在其中选「另存为 PDF」。
     */
    /** A71 打开诊断记录窗口 */
    openDiagnostics: () => openDiagnostics({
      entries: diagnostics,
      onClear: () => { diagnostics = []; },
    }),
    /**
     * A70 开发者工具（对齐 WPF OpenDevTools）。
     * release 构建下 Rust 侧会直接报错 —— 那不是异常，是预期行为
     * （给最终用户开控制台没有意义），原样把提示透出即可。
     */
    openDevTools: guard('打开开发者工具', async () => {
      try {
        await ctx.invoke('mm_open_devtools', {});
        status('已打开开发者工具');
      } catch (e) {
        status(e?.message || String(e), true);
      }
    }),
    setPdfChannel: guard('设置 PDF 通道', async (v) => {
      const next = v === 'dialog' ? 'dialog' : 'vector';
      if (settings.pdfChannel === next) return;
      settings.pdfChannel = next;
      const ok = await store.settings.save(settings);
      if (!ok) { status('设置保存失败', true); return; }
      status(next === 'vector'
        ? 'PDF 默认走矢量通道（不弹对话框，直接保存）'
        : 'PDF 默认走打印对话框（可在其中选「另存为 PDF」）');
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
  side = buildSide(app, { onPage: syncSideTabs });
  fileList = buildFileList(app);
  // 顺序对齐 C# MindMapPanel 的主体两列：[文件库] | 画布 | [属性侧栏 276px]
  //   左侧：文件库（Web 版多文档功能，C# 没有；默认收起，点 📚 展开）
  //   右侧：属性侧栏（样式/标签/主题/文件），C# 里固定 276px 常驻
  body.insertBefore(fileList.el, canvasEl);
  body.appendChild(side.el);
  fileList.setOpen(!!settings.filesOpen);
  captureShellErrors();
  buildRail();
  renderTabs();
  renderFiles();

  bridge = new EditorBridge(canvasEl, {
    onStatus: status,
    onDirty,
    onNodeStyle: (st) => { nodeStyleCache = st || {}; side.refresh(); },
    // A71：内层 iframe 的错误/警告。kityminder 跑在 iframe 里，那边的报错
    // 不进外壳控制台 —— 不收集的话，用户侧「点了没反应」就查不到任何线索。
    onDiagnostic: (d) => {
      const e = diag.normalize({ ...d, source: 'editor' });
      if (e) diagnostics = diag.pushEntries(diagnostics, [e]);
    },
    // 点击画布上节点的附件图标。（C# 版这里是：自动切到「文件」页签展示该文件信息，
    // 视频直接在页签内播放。沙箱里拿不到真实路径、也无法调用系统默认程序打开，
    // 所以退化为「视频播浮层 / 文件另存为」，并把侧栏切到文件页以便查看信息。）
    onOpenFile: guard('打开附件', (path) => openAttachment(path)),
    // 拖放附加（图片 / 视频 / 任意文件）
    onDropFiles: (files, nodeId) => { guard('拖放附加', () => handleDropFiles(files, nodeId))(); },
    onDropMiss: () => status('请拖到节点上（拖到空白处不会新建节点）'),
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

  // Tab 转发：焦点停在工具栏按钮上时，浏览器会拿 Tab 做焦点导航，
  // 画布收不到键。这里拦下来转给画布（详见 bindTabForward 的注释）。
  const unbindTab = bindTabForward();

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
  // 初始化期间所有的 store 读都跑完了：若中途有失败（IndexedDB 被禁用 / 损坏），
  // 在这里一次性摆到状态栏 —— 否则用户只看到「脑图是空的」。
  flushStoreError();

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
      await store.pushBackup({ sheets: JSON.parse(JSON.stringify(workbook.sheets)), activeId: workbook.activeId }, settings.backupMax);
    } catch (e) {
      console.warn('[mindmap] 卸载前兜底保存失败', e);
    }
  });

  return () => {
    clearTimeout(saveTimer);
    unbindTab?.();
    unwatchTheme?.();
    bridge?.destroy();
  };
});
