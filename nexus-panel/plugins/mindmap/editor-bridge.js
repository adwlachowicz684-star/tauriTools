/**
 * 思维导图插件 · 编辑器桥接
 * ============================================================
 * 本插件采用「嵌套 iframe」结构：
 *     nexus 外壳 → 插件层（本目录 index.html）→ 编辑器层（editor/index.html）
 *
 * 两层同源，因此命令调用可以直接 `win.__minder.xxx()` 同步取返回值，
 * 而不用像 C# 版那样把 JS 拼成字符串交给 ExecuteScriptAsync 再反序列化 ——
 * 原实现注释里记的三个坑（U+2028/2029 破坏 JS 语法、async IIFE 返回 {}、
 * Promise 不被等待需轮询）在这里全部不存在。
 *
 * 事件回传则沿用编辑器页面既有的宿主通知契约（hostPost → postMessage），
 * 与 WPF 宿主（junction_link）保持同一套消息格式，方便两侧同步升级。
 */

import { DEFAULT_THEME, DEFAULT_LAYOUT } from './themes.js';

/** 编辑器页面里 KM_HOST_CHANNEL 的取值，必须与 editor/index.html 一致 */
export const HOST_CHANNEL = 'kityminder-host-v1';

const READY_TIMEOUT = 20000;   // 编辑器初始化较慢（要等 DOMContentLoaded + kity 就绪）
const READY_INTERVAL = 120;

export class EditorBridge {
  /**
   * @param {HTMLElement} host 承载内层 iframe 的容器
   * @param {{ onStatus?:Function, onDirty?:Function, onNodeStyle?:Function,
   *           onOpenFile?:Function, onHostRequest?:Function }} handlers
   */
  constructor(host, handlers = {}) {
    this.host = host;
    this.handlers = handlers;
    this.iframe = null;
    this.ready = false;
    this.loading = false;
    this._gen = 0;
    this._listeners = [];
    this._onMessage = this._onMessage.bind(this);
    window.addEventListener('message', this._onMessage);
  }

  /** 编辑器内核实例（window.__km）；未就绪返回 null */
  get km() {
    const w = this.iframe?.contentWindow;
    return w && w.__km ? w.__km : null;
  }

  /** 编辑器门面（window.__minder）；未就绪返回 null */
  get minder() {
    const w = this.iframe?.contentWindow;
    return w && w.__minder ? w.__minder : null;
  }

  /* ---------------------- 生命周期 ---------------------- */

  /** 首次加载：创建 iframe 并等就绪 */
  async load() {
    if (this.iframe) return this.ready;
    this.loading = true;
    const gen = ++this._gen;
    this._createIframe();
    return this._waitReady(gen);
  }

  /** 建一个新的编辑器 iframe 挂到宿主容器上（复用同一 URL） */
  _createIframe() {
    const iframe = document.createElement('iframe');
    iframe.src = new URL('./editor/index.html', location.href).href;
    iframe.style.cssText =
      'width:100%;height:100%;border:0;background:#1E1E1E;display:block;border-radius:8px;';
    iframe.title = 'kityminder 编辑器';
    this.host.appendChild(iframe);
    this.iframe = iframe;
    return iframe;
  }

  /** 轮询等待内核挂载（对应 C# 版 PollReadyAsync，但直接读 window 变量，代价极低） */
  async _waitReady(gen) {
    const deadline = Date.now() + READY_TIMEOUT;
    while (Date.now() < deadline) {
      if (gen !== this._gen) return false;          // 已被新的加载/重载取代
      if (this.km && this.minder) {
        this.ready = true;
        this.loading = false;
        this.handlers.onStatus?.('已就绪，可编辑');
        return true;
      }
      await sleep(READY_INTERVAL);
    }
    if (gen === this._gen) {
      this.loading = false;
      this.handlers.onStatus?.('编辑器未就绪（加载超时）', true);
    }
    return false;
  }

  /**
   * 重载编辑器页面（重置就绪态）。
   *
   * 实现选择：销毁旧 iframe 再新建一个，而不是 `contentWindow.location.reload()`。
   *
   * 两个原因 ——
   * 1. reload() 之后旧文档不会立刻消失，contentWindow 短时间内仍指向它，
   *    `__km` 可能还是**旧实例**；此时若判定就绪，导航一到它就失效了，
   *    表现为「重载后第一次操作报错」。
   * 2. 同 URL 重载依赖导航行为，某些宿主环境（含无头测试环境）不实现导航，
   *    reload() 会抛错或静默不生效；重建 iframe 只依赖 DOM 操作，行为一致。
   *
   * 代价是旧 iframe 的 message 监听要一并摘掉，避免新旧两份监听器同时响应。
   */
  async reload() {
    const gen = ++this._gen;
    this.ready = false;
    this.loading = true;
    this.handlers.onStatus?.('正在重新加载编辑器…');

    // 摘掉旧监听 + 移除旧节点，避免旧文档继续 postMessage 干扰新实例
    window.removeEventListener('message', this._onMessage);
    try { this.iframe?.remove(); } catch { /* ignore */ }
    this.iframe = null;

    this._createIframe();
    window.addEventListener('message', this._onMessage);
    return this._waitReady(gen);
  }

  destroy() {
    this._gen++;
    window.removeEventListener('message', this._onMessage);
    for (const off of this._listeners) {
      try { off(); } catch { /* ignore */ }
    }
    this._listeners = [];
    this.iframe?.remove();
    this.iframe = null;
    this.ready = false;
  }

  /* ---------------------- 事件回传 ---------------------- */

  _onMessage(e) {
    const d = e?.data;
    if (!d || d.channel !== HOST_CHANNEL) return;
    // 只接收来自本插件编辑器层的消息
    if (this.iframe && e.source !== this.iframe.contentWindow) return;

    switch (d.type) {
      case 'contentchange':
        this.handlers.onDirty?.();
        break;
      case 'nodestyle':
        this.handlers.onNodeStyle?.(d.style || {});
        break;
      // 选中节点变了（含「变成没选中」）。文件面板要跟着换节点，
      // 否则显示的还是上一个节点的附件 —— 得手动切页签再切回来才更新。
      case 'selchange':
        this.handlers.onSelectionChange?.(d.nodeId || '');
        break;
      case 'openfile':
        if (d.path) this.handlers.onOpenFile?.(d.path);
        break;
      // 点击画布上的附件（多附件：带 kind + index + 原始引用 + 所在节点 id）
      case 'openattach':
        this.handlers.onOpenAttach?.(d.kind, d.index, d.raw, d.nodeId || '', d.list || null);
        break;
      // 附件在节点间拖拽移动
      case 'moveattach':
        this.handlers.onMoveAttach?.(d.kind, d.index, d.fromId, d.toId);
        break;
      // 附件拖到了空白处（不是另一个节点）
      case 'attachmiss':
        this.handlers.onAttachMiss?.();
        break;
      // 拖放附加：File 对象可被结构化克隆，能直接跨 iframe 传过来，
      // 不必在两边各读一次字节
      case 'dropfiles':
        if (d.files?.length) this.handlers.onDropFiles?.(d.files, d.nodeId || '');
        break;
      // 拖到了空白处 —— 按约定不建节点，但要说出来，否则用户以为坏了
      case 'dropmiss':
        this.handlers.onDropMiss?.();
        break;
      // A71：内层 iframe 的错误/警告推给插件层收集。
      // 注意这里**不** return —— 诊断只是旁路记录，不影响其它消息的处理。
      case 'diagnostic':
        this.handlers.onDiagnostic?.(d);
        break;
      case 'request':
        this._handleRequest(d);
        break;
      default:
        break;
    }
  }

  /**
   * 发往编辑器 iframe 的 postMessage 目标 origin。
   *
   * 编辑器页与本层同源（iframe.src 由 './editor/index.html' 相对 location.href 解析而来），
   * 所以取该 URL 的 origin 即可，不必再用 '*' 广播给所有窗口。
   *
   * 两种回退：
   *   · iframe 还停在 about:blank 时 src 为空 → 用 location.origin。同源 about:blank
   *     继承父文档 origin，两者一致（setCanvasTheme 就可能在此时被调用）；
   *   · file:// 下 origin 是字符串 'null'（opaque origin），postMessage 接受该值，
   *     与编辑器页自身的 origin 匹配。
   */
  _targetOrigin() {
    const src = this.iframe?.src;
    if (src) {
      try {
        const o = new URL(src, location.href).origin;
        if (o) return o;
      } catch { /* URL 解析失败，走下面 */ }
    }
    return location.origin || '*';
  }

  /** 编辑器用 callHost 发起的异步请求（saveAs / log 等），在此应答 */
  async _handleRequest(d) {
    const reply = (result) => {
      this.iframe?.contentWindow?.postMessage(
        { channel: HOST_CHANNEL, type: 'response', id: d.id, result }, this._targetOrigin());
    };
    if (typeof this.handlers.onHostRequest === 'function') {
      try {
        reply(await this.handlers.onHostRequest(d.action, d.payload));
      } catch (err) {
        reply({ error: String(err?.message || err) });
      }
      return;
    }
    reply(null);
  }

  /* ---------------------- 命令封装 ---------------------- */

  /** 在未就绪时静默跳过；fn 抛错时上报状态而不中断调用方 */
  _safe(name, fn) {
    if (!this.ready || !this.minder) return null;
    try {
      return fn(this.minder, this.km);
    } catch (e) {
      this.handlers.onStatus?.(`${name} 失败：${e?.message || e}`, true);
      return null;
    }
  }

  /** 导入 kityminder JSON（对象或文本） */
  importJson(data) {
    return this._safe('导入', (m) => {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      m.importJson(obj);
      return true;
    });
  }

  /** 导入 Markdown 文本（走 core 内置 markdown 协议） */
  importMarkdown(md) {
    return this._safe('导入 Markdown', (m) => m.importText(md));
  }

  /** 导出 JSON 文本 */
  exportJson() {
    return this._safe('导出', (m) => m.exportJson());
  }

  /** 导出 Markdown 文本（Promise） */
  async exportMarkdown() {
    if (!this.ready || !this.km) return null;
    try {
      return await this.km.exportData('markdown');
    } catch (e) {
      this.handlers.onStatus?.(`导出 Markdown 失败：${e?.message || e}`, true);
      return null;
    }
  }

  /** 导出 SVG 文本（Promise） */
  async exportSvg() {
    if (!this.ready || !this.km) return null;
    try {
      return await this.km.exportData('svg');
    } catch (e) {
      this.handlers.onStatus?.(`导出 SVG 失败：${e?.message || e}`, true);
      return null;
    }
  }

  /**
   * 导出整幅 PNG 的 base64 dataUrl。
   * C# 版因 ExecuteScriptAsync 不等 Promise 只能"触发 + 轮询 window.__mindmapPng"；
   * 同源下直接 await core 的 Promise 即可，省掉轮询。
   */
  async exportPng() {
    if (!this.ready || !this.km) return null;
    try {
      return await this.km.exportData('png');
    } catch (e) {
      this.handlers.onStatus?.(`导出 PNG 失败：${e?.message || e}`, true);
      return null;
    }
  }

  /** 执行内核命令 */
  exec(name, value) {
    return this._safe('命令 ' + name, (m) =>
      value === undefined ? m.execCommand(name) : m.execCommand(name, value));
  }

  /**
   * 撤销 / 重做：不在内核命令表，走编辑器自维护的历史栈（window.editor.history）。
   * 上游 dist/index.html 已补齐该实现（基线快照模型，100 步上限，导入即重置基线），
   * 故这里优先用它；拿不到时返回 null，由调用方回退到自己的快照栈。
   *
   * 注意：编辑器执行 undo/redo 时会 importJson，进而触发 contentchange →
   * 宿主收到通知 → 自动保存，所以调用方无需额外触发落盘。
   *
   * @returns {boolean|null} true=已执行 / false=栈空 / null=编辑器无历史栈
   */
  history(name) {
    if (!this.ready) return null;
    const w = this.iframe?.contentWindow;
    const h = w?.editor?.history;
    if (!h || typeof h[name] !== 'function') return null;
    try {
      return !!h[name]();
    } catch (e) {
      this.handlers.onStatus?.(`${name} 失败：${e?.message || e}`, true);
      return null;
    }
  }

  /**
   * 把画布配色下发到内层编辑器页面。
   * 内层是独立文档，拿不到外壳注入的 CSS 变量，只能靠 postMessage 传过去。
   * 传 null 表示恢复编辑器自带的默认深色。
   */
  setCanvasTheme(vars) {
    const w = this.iframe?.contentWindow;
    if (!w) return false;
    // 页面可能还没执行到门面定义，先存一份；编辑器页自己会在门面就绪后补套
    try { w.__kmCanvasVars = vars || null; } catch { /* ignore */ }
    w.postMessage({ channel: HOST_CHANNEL, type: 'theme', vars: vars || null }, this._targetOrigin());
    return true;
  }

  /** 历史栈可用性探测：供调用方决定用编辑器的栈还是自己的栈 */
  hasHistory() {
    const h = this.iframe?.contentWindow?.editor?.history;
    return !!(h && typeof h.undo === 'function' && typeof h.redo === 'function');
  }

  /** 导入后重置历史基线（切换画布时用，避免把上一张的编辑带过来） */
  historyClear() {
    try { this.iframe?.contentWindow?.editor?.history?.clear?.(); } catch { /* ignore */ }
  }

  editSelected() { return this._safe('编辑文字', (m) => m.editSelected()); }

  /**
   * 把焦点交回画布。
   *
   * kityminder 的键盘输入全靠一个隐藏 <input class="km-receiver">，
   * 焦点不在它上面时，Tab / Enter / 方向键 / Delete 全部失效 ——
   * 表现为「点了工具栏按钮之后，快捷键就不灵了」。
   *
   * 先给 iframe 的 window 焦点，再让内层把焦点交给 receiver：
   * 只做前者的话，焦点停留在 iframe 的 document 上，receiver 仍没拿到。
   */
  focusCanvas() {
    try {
      const w = this.iframe?.contentWindow;
      if (!w) return false;
      w.focus();
      w.__minderFocusCanvas?.();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 插入下级节点（等价于画布上按 Tab）。
   * 供插件层在拦下 Tab 后转送 —— 见 index.js 的 bindTabForward。
   */
  insertChild() {
    try {
      const w = this.iframe?.contentWindow;
      if (!w) return false;
      w.focus();
      w.__minderInsertChild?.();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 插入同级节点（等价于画布上按 Enter）。
   *
   * 为什么要单独一个门面：焦点停在工具栏 <button> 上时按 Enter，浏览器会把它
   * 当成「激活当前按钮」，于是用户看到的是**又执行了一遍刚点的那个按钮**，
   * 而画布收不到 —— 表现就是「Enter 插入同级没反应」。
   * 由插件层在捕获阶段拦下 Enter 后转送到这里（见 index.js 的 bindKeyForward）。
   */
  insertSibling() {
    try {
      const w = this.iframe?.contentWindow;
      if (!w) return false;
      w.focus();
      w.__minderInsertSibling?.();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 选中指定 data.id 的节点（拖放用）。
   * @returns {boolean} 找到了并选中为 true
   */
  selectNodeById(uid) {
    try {
      const w = this.iframe?.contentWindow;
      if (!w || !uid) return false;
      return !!w.__minderSelectNode?.(uid);
    } catch {
      return false;
    }
  }

  /**
   * 在当前选中节点下插入一个带文字的子节点并选中它（拖放放多个文件时用）。
   * 与 insertChild() 的差别是不进入文字编辑态。
   */
  insertChildNamed(text) {
    try {
      const w = this.iframe?.contentWindow;
      if (!w) return false;
      return !!w.__minderInsertChildNamed?.(text);
    } catch {
      return false;
    }
  }

  /** 读取选中节点上的图片（dataURL，与 image 命令同源） */
  getSelectedImage() {
    return this._safe('读取图片', (_m, km) => {
      const n = km.getSelectedNode?.();
      return n?.getData?.('image') || null;
    });
  }

  /** 搜索：返回 {total,index,text}，无匹配为 0 */
  /**
   * 搜索（A29）。
   *
   * 早先写成 `_safe(...) || { total: 0, index: 0, text: '' }` ——
   * 这个兜底把「编辑器未就绪」和「搜了但没结果」**压成了同一种结果**，
   * 两者都返回 `total: 0`。UI 只能统一显示「无匹配」，
   * 用户在编辑器还没加载完时搜索，看到的也是「无匹配」，
   * 会以为自己的脑图里真的没有那个词。
   *
   * @returns {object} `{ ok:false, reason:'notready'|'error' }` 或
   *   `{ ok:true, total, index, text }`
   */
  search(keyword) {
    if (!this.ready || !this.minder) return { ok: false, reason: 'notready', total: 0, index: 0 };
    const r = this._safe('搜索', (m) => m.search(keyword));
    // _safe 异常时已经通过 onStatus 提示过了，这里只负责把状态传出去
    if (!r) return { ok: false, reason: 'error', total: 0, index: 0 };
    return { ok: true, total: r.total || 0, index: r.index || 0, text: r.text || '' };
  }

  /**
   * 取当前搜索结果列表，供外壳左侧面板渲染。
   *
   * 与 search() 分开是有意的：search() 每调一次就**推进到下一个匹配**，
   * 若顺带返回列表，外壳每次想刷新列表都会让画布上的定位多跳一格。
   * 两者职责分开后，"刷新列表"和"下一个"互不干扰。
   *
   * @returns {{kw:string, total:number, active:number, items:string[]}}
   *   未搜索 / 关键字为空时 items 为空数组
   */
  getSearchResults() {
    const r = this._safe('读取搜索结果', (m) => m.getSearchResults());
    // 空结果不是错误：关键字为空、编辑器未就绪、真没匹配，都是"没有可显示的"
    if (!r || !Array.isArray(r.items)) return { kw: '', total: 0, active: 0, items: [] };
    return {
      kw: String(r.kw || ''),
      total: Number(r.total) || 0,
      active: Number(r.active) || 0,
      items: r.items.map((t) => String(t ?? '')),
    };
  }

  /**
   * 定位到第 idx 个搜索结果（0 起）。
   *
   * 返回 false 表示**没定位成**（索引越界 / 未搜索 / 编辑器未就绪）。
   * 这个区分很重要：内容变化后列表会重建，外壳手里的旧索引可能已失效，
   * 此时宁可失败并提示"请重新搜索"，也不能跳到一个不相干的节点。
   */
  gotoSearchResult(idx) {
    return this._safe('定位搜索结果', (m) => m.gotoSearchResult(idx)) === true;
  }

  /** 按选中节点展开到第 N 层（0/负数=全部） */
  /**
   * 中央主题中心的屏幕 x。
   *
   * 用于"展开文件库前后测一下、差多少补多少" —— 不去推算内核补了几成，
   * 直接以**用户实际看到的位置**为准。
   *
   * @returns {number|null} 取不到时返回 null（调用方据此跳过补偿，
   *   不能当成 0 —— 那会补出一个反向位移）
   */
  rootScreenX() {
    const v = this._safe('读取中心位置', (m) => m.rootScreenX());
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /**
   * 告知编辑器：画布容器在屏幕上横向移动了 dLeft px（文件库展开/收起挤窄所致）。
   *
   * 容器位移**只能由父页面测**：编辑器侧在 iframe 内，取 #minder-container
   * 的 getBoundingClientRect().left 得到的是相对 iframe 视口的坐标，父页面把
   * iframe 挤到右边时它恒定不变 —— 测不出来。
   *
   * 编辑器在自己那次 resize 里把「容器位移 + 内核自动居中的位移」一并补掉。
   * 这里只传容器位移、不传补偿量 —— 内核到底补了几成只有编辑器量得准。
   *
   * 编辑器侧没有这个能力时静默跳过 —— 补偿是锦上添花，
   * 不该因此弹出「XX 失败」去打扰用户。
   */
  notifyLayoutShift(dLeft) {
    if (!this.ready || !this.minder) return false;
    const fn = this.minder.notifyLayoutShift;
    if (typeof fn !== 'function') return false;
    try { return fn.call(this.minder, dLeft) === true; } catch { return false; }
  }

  /**
   * 相对平移视图。
   *
   * 用于补内核 resize 补偿**漏掉的那一半**：内核只补 (新宽-旧宽)/2，
   * 画布左边缘却移动了整整一个 Δ，于是内容净位移 Δ/2。
   * 调用方再补一个 Δ/2 即可让内容回到原处。
   *
   * @param {number} dx 正 = 内容右移
   */
  panBy(dx, dy) {
    return this._safe('平移视图', (m) => m.panBy(dx, dy));
  }

  /**
   * 聚焦中心主题：视图移到根节点并选中它。
   *
   * 为什么单独做一个方法而不是 `exec('camera', root)`：
   * 跨 iframe **传不了节点对象**，根节点只能让编辑器自己取。
   */
  focusRoot() {
    return this._safe('聚焦中心主题', (m) => m.focusRoot());
  }

  /** 展开：以**当前选中节点**为基准 */
  expandToLevel(levels) {
    return this._safe('展开', (m) => m.expandSelectedToLevel(levels));
  }

  /** 层级：以**中心主题**为基准（与选中谁无关） */
  expandRootToLevel(levels) {
    return this._safe('展开层级', (m) => m.expandRootToLevel(levels));
  }

  setTheme(theme) {
    return this._safe('切换主题', (m) => m.setTheme(theme || DEFAULT_THEME));
  }

  setLayout(layout) {
    return this._safe('切换布局', (m) => m.setLayout(layout || DEFAULT_LAYOUT));
  }

  setTemplate(tpl) {
    return this._safe('切换模板', (m) => m.setTemplate(tpl || DEFAULT_LAYOUT));
  }

  /** 注册自定义主题（对象或 JSON 文本），返回是否成功 */
  registerTheme(theme) {
    return this._safe('注册主题', (m) => m.registerCustomTheme(theme)) || false;
  }

  /** 节点级样式：fill/stroke/strokeWidth/radius/lineColor/lineWidth，值 null 表示清除 */
  setNodeStyle(style) { return this.exec('setnodestyle', style); }

  /** 清除节点样式：text / node / border / line */
  clearNodeStyle(scope) { return this.exec('clearnodestyle', scope); }

  copyNodeStyle() { return this.exec('copynodestyle'); }
  pasteNodeStyle() { return this.exec('pastenodestyle'); }

  /** 视图选择：all / revert / siblings / level / path / tree */
  select(mode) { return this._safe('选择', (m) => m.select(mode)); }

  /** 附件：null 表示移除 */
  setHyperlink(url) { return this.exec('hyperlink', url ?? null); }
  /**
   * 设置单张图片 / 节点图标。
   *
   * **必须同时清掉 `images`（多图横幅）**：两者互斥，同时有值会让
   * 同一个节点既显示框内图标又显示框外横幅。
   * 不清的话，「清除图标」按钮点不掉多图（只清了 image，横幅还在）。
   */
  setImage(url) {
    const r = this.exec('image', url ?? null);
    this.exec('images', null);
    return r;
  }
  setNote(text) { return this.exec('note', text ?? null); }
  setFile(path) { return this.exec('file', path ?? null); }
  setVideo(path) { return this.exec('video', path ?? null); }

  /**
   * 设置图片列表（dataURL 数组）。
   *
   * `image`（单张 / 节点图标，内核画在框内）与 `images`（多图横幅，框外）
   * **互斥** —— 两个字段同时有值，同一个节点会画出两张图。
   * 互斥规则统一在这里处理，images 命令本身只写 images 字段。
   *
   * | 传入 | image | images |
   * |---|---|---|
   * | 0 张 | 清 | 清 |
   * | 1 张 | 该张 | 清（交给内核画在框内） |
   * | ≥2 张 | 清 | 全部（横幅） |
   */
  setImages(list) {
    const arr = (Array.isArray(list) ? list : []).filter(Boolean);
    if (!arr.length) {
      this.exec('image', null);
      this.exec('images', null);
      return true;
    }
    if (arr.length === 1) {
      this.exec('image', arr[0]);
      this.exec('images', null);
      return true;
    }
    this.exec('images', JSON.stringify(arr));
    this.exec('image', null);
    return true;
  }

  /** 读取选中节点的图片 dataURL 列表（合并 images 与老 image 字段） */
  /**
   * 当前选中节点的 id（没有选中则返回 ''）。
   *
   * 用途：宿主侧凡是**先弹文件选择框、再写回**的操作（附加文件/视频/图片），
   * 都要在异步之前记住它、写回之前切回来。
   * 选择框期间焦点离开 iframe，选中态可能丢 —— 丢了的后果是写回被静默丢弃
   * （命令作用于「当前选中节点」，没有选中就什么都不做），
   * 表现为「点了没反应，而且面板读不到任何附件」。
   */
  getSelectedNodeId() {
    return this._safe('读取节点 id', (_m, km) => {
      const n = km.getSelectedNode?.();
      return (n && n.data && n.data.id) || '';
    }) || '';
  }

  getSelectedImages() {
    return this._safe('读取图片', (_m, km) => {
      const n = km.getSelectedNode?.();
      if (!n) return [];
      const many = n.getData?.('images');
      if (many) {
        /*
         * 可能是**真数组**（导入的 JSON 里 images 就是数组），不总是字符串。
         * 只做 JSON.parse 的话，数组会被 String() 化再解析：
         *   ['a','b'] → "a,b" → 解析失败 → 退回单图 image → []
         *
         * 后果是**画布画得出、侧栏读不到**：编辑器侧的 imageListOf（画横幅）
         * 早就能处理真数组，这里没有 → 侧栏「图片」栏显示「当前节点没有
         * 图片附件」，但画布上明明有两张图。用户只会以为面板坏了。
         * 又是「同一件事两条路径、只修了一条」。
         *
         * 实测：images 为 ['...AAA','...BBB'] 真数组时，本函数返回 []。
         */
        if (Object.prototype.toString.call(many) === '[object Array]') {
          return many.filter(Boolean);
        }
        try {
          const a = JSON.parse(many);
          if (Array.isArray(a)) return a.filter(Boolean);   // 空数组照实返回 []
        } catch { /* 坏数据退回单图 */ }
      }
      const one = n.getData?.('image');
      return one ? [one] : [];
    }) || [];
  }

  /**
   * 读取选中节点的优先级 / 进度（A1/A2 徽章回显用）。
   *
   * 走 `getData` 而不是 `queryCommandValue('priority')`：
   * 后者在**多选或未选中**时返回 -1 之类的哨兵值，与「真的设了 -1」
   * 分不开；直接读 data 拿到什么就是什么，未设置则是 undefined。
   */
  getSelectedPriority() {
    return this._safe('读取优先级', (_m, km) => {
      const v = km.getSelectedNode?.()?.getData?.('priority');
      return v == null || v === '' ? null : Number(v) || null;
    });
  }

  getSelectedProgress() {
    return this._safe('读取进度', (_m, km) => {
      const v = km.getSelectedNode?.()?.getData?.('progress');
      return v == null || v === '' ? null : Number(v) || null;
    });
  }

  /** 读取选中节点的文件/视频附件路径 */
  getSelectedFile() {
    return this._safe('读取附件', (_m, km) => {
      const n = km.getSelectedNode?.();
      return n?.getData?.('file') || null;
    });
  }

  getSelectedVideo() {
    return this._safe('读取视频', (_m, km) => {
      const n = km.getSelectedNode?.();
      return n?.getData?.('video') || null;
    });
  }

  /** 选中节点文本（用于附件面板标题等） */
  getSelectedText() {
    return this._safe('读取节点', (_m, km) => km.getSelectedNode?.()?.getText?.() || '');
  }

  /** 直接执行任意 JS（调试用） */
  evalInEditor(fn) {
    if (!this.ready) return null;
    try {
      return fn(this.iframe.contentWindow, this.km, this.minder);
    } catch (e) {
      this.handlers.onStatus?.(`执行失败：${e?.message || e}`, true);
      return null;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
