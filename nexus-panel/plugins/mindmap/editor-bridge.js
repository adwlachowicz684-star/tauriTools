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
      case 'openfile':
        if (d.path) this.handlers.onOpenFile?.(d.path);
        break;
      case 'request':
        this._handleRequest(d);
        break;
      default:
        break;
    }
  }

  /** 编辑器用 callHost 发起的异步请求（saveAs / log 等），在此应答 */
  async _handleRequest(d) {
    const reply = (result) => {
      this.iframe?.contentWindow?.postMessage(
        { channel: HOST_CHANNEL, type: 'response', id: d.id, result }, '*');
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
    w.postMessage({ channel: HOST_CHANNEL, type: 'theme', vars: vars || null }, '*');
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

  /** 搜索：返回 {total,index,text}，无匹配为 0 */
  search(keyword) {
    return this._safe('搜索', (m) => m.search(keyword)) || { total: 0, index: 0, text: '' };
  }

  /** 按选中节点展开到第 N 层（0/负数=全部） */
  expandToLevel(levels) {
    return this._safe('展开', (m) => m.expandSelectedToLevel(levels));
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
  setImage(url) { return this.exec('image', url ?? null); }
  setNote(text) { return this.exec('note', text ?? null); }
  setFile(path) { return this.exec('file', path ?? null); }
  setVideo(path) { return this.exec('video', path ?? null); }

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
