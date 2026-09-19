import { useEffect, useRef, useState } from 'react';
import { loadRegistry } from '../../js/host.js';
import { loadModuleEntry } from '../../js/plugin-entries.js';
import { loadToolbarPlugins, mountToolbar } from '../../js/toolbar-plugin.js';

export type WinAction = 'minimize' | 'maximize' | 'close' | 'topmost' | 'hide';

export default function Titlebar({
  title,
  onWin,
  onToast,
  onNavigate,
  onEmit,
  closeAction = 'hide',
}: {
  title: string;
  onWin: (a: WinAction) => void;
  /** 切换主题后弹提示（可选） */
  onToast?: (msg: string, type?: string) => void;
  /** 切到某个插件：MCP 状态插件用它打开凭据中心 */
  onNavigate?: (id: string) => void;
  /** 往宿主总线发事件：让 agent-flow 把凭据中心弹出来 */
  onEmit?: (ev: string, payload?: unknown) => void;
  /** ✕ 的行为：'hide' 藏到托盘 / 'close' 真正退出。由设置决定，默认藏 */
  closeAction?: 'hide' | 'close';
}) {
  /*
   * 右上角那排（主题 / 置顶 / 托盘 / MCP 状态）已抽成工具栏插件
   * （kind:'toolbar'），由这里统一加载渲染。
   *
   * 之前它们是硬编码的 <button>，与原生外壳各写一份 ——
   * 加一个按钮要改两处，漏一处就是"这个外壳有、那个没有"。
   */
  const slotRef = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        /*
         * loadRegistry 是 async —— 必须 await。
         * 不 await 拿到的是 Promise，.filter 不存在，会抛 TypeError。
         */
        const all = (await loadRegistry()) || [];
        await loadToolbarPlugins(
          all.filter((p) => (p as { kind?: string }).kind === 'toolbar'),
          {
            loadModule: (m) => loadModuleEntry(m as never),
            onError: (id, e) => {
              console.warn('[toolbar] 加载失败', id, e);
              onToast?.(`工具栏插件「${id}」加载失败：${(e as Error)?.message || e}`, 'err');
            },
          },
        );
        if (alive) setReady((r) => r + 1);
      } catch (e) {
        onToast?.(`工具栏加载失败：${(e as Error)?.message || e}`, 'err');
      }
    })();
    return () => { alive = false; };
  }, [onToast]);

  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    mountToolbar(el, {
      toast: (msg, type) => onToast?.(msg, type),
      win: (a) => onWin(a as WinAction),
      navigate: (id) => onNavigate?.(id),
      emit: (ev, payload) => onEmit?.(ev, payload),
    });
  }, [ready, onWin, onToast, onNavigate, onEmit]);

  /*
   * 标题栏拖拽 —— 与 index.html（原生外壳）**必须保持一致**。
   *
   * ="deep"：整个子树都能拖。裸属性只有点击目标本身才拖，
   * 点在 logo / 品牌文字 / 标题这些子元素上会失效。
   * 按钮不用额外标 ="false"：drag.js 自动跳过可点击元素。
   *
   * 两个外壳同一套写法，改一处就要改另一处 —— 否则会出现
   * "这个外壳能拖、那个不能"，很难往这方面想。
   */
  return (
    <header id="titlebar" data-tauri-drag-region="deep">
      <div className="tb-brand">
        <div className="tb-logo">◈</div>
        <span>Nexus Panel</span>
      </div>
      <span className="tb-title">{title}</span>
      <div className="tb-spacer" />
      <div className="tb-btns">
        {/* 工具栏插件的显示口。放在窗口控制按钮左侧：
            后者属于窗口不属于插件，✕ 单独留最右 ——
            它是"可能退出"的那个，不该和常规操作混在一起。 */}
        <span className="tb-toolbar" ref={slotRef} />
        <button className="tb-btn" title="最小化" onClick={() => onWin('minimize')}>─</button>
        <button className="tb-btn" title="最大化" onClick={() => onWin('maximize')}>□</button>
        {/* ✕ 的文案跟着设置走：用户得能从按钮本身看出点下去会发生什么，
            不能让"关闭"既可能是隐藏也可能是退出。 */}
        <button
          className="tb-btn danger"
          title={closeAction === 'hide' ? '隐藏到托盘' : '退出'}
          onClick={() => onWin(closeAction === 'hide' ? 'hide' : 'close')}
        >✕</button>
      </div>
    </header>
  );
}
