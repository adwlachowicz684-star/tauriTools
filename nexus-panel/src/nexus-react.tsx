/**
 * Nexus Panel · React 适配器
 * ------------------------------------------------------------
 * 让插件用 React + TSX 编写，同时仍享受 SDK 的两种挂载模式。
 *
 *   · iframe（默认）：bootIframeReactPlugin((ctx) => <App />)
 *   · module（同页）：definePlugin({ mount: (ctx) => renderReact(ctx, <App />) })
 */

import { createContext, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bootIframePlugin, type PluginContext } from '../js/plugin-sdk.js';

const NexusCtx = createContext<PluginContext | null>(null);

/** 在插件组件里拿到 ctx */
export function useNexus(): PluginContext {
  const ctx = useContext(NexusCtx);
  if (!ctx) throw new Error('useNexus() 必须在 Nexus 插件组件内部使用');
  return ctx;
}

export function NexusProvider({ ctx, children }: { ctx: PluginContext; children: ReactNode }) {
  return <NexusCtx.Provider value={ctx}>{children}</NexusCtx.Provider>;
}

/**
 * iframe（沙箱）插件入口 —— 默认推荐
 * 用法：bootIframeReactPlugin((ctx) => <MyApp />)
 */
export function bootIframeReactPlugin(
  render: (ctx: PluginContext) => ReactNode,
  settingsRender?: (ctx: PluginContext) => ReactNode,
  mountPoint: string | HTMLElement = 'root',
) {
  const mountTo = (node: ReactNode, ctx: PluginContext) => {
    const el = typeof mountPoint === 'string'
      ? document.getElementById(mountPoint) ?? document.body
      : mountPoint;
    const root = createRoot(el);
    root.render(<NexusProvider ctx={ctx}>{node}</NexusProvider>);
    return () => root.unmount();
  };

  return bootIframePlugin(
    async (ctx) => mountTo(render(ctx), ctx),
    // 传了第二个参数，外壳才会显示「⚙ 设置」按钮
    settingsRender ? async (ctx) => mountTo(settingsRender(ctx), ctx) : undefined,
  );
}

/**
 * 同页（module）插件里渲染 React —— 返回卸载函数，直接作为 mount 的返回值
 * 用法：export default definePlugin({ mount: (ctx) => renderReact(ctx, <App />) })
 */
export function renderReact(ctx: PluginContext, node: ReactNode): () => void {
  const container = document.createElement('div');
  container.style.height = '100%';
  (ctx.root as HTMLElement).appendChild(container);
  const root: Root = createRoot(container);
  root.render(<NexusProvider ctx={ctx}>{node}</NexusProvider>);
  return () => root.unmount();
}

/**
 * 服务插件的 React 入口（kind:'service'）
 * ------------------------------------------------------------
 * 普通 React 插件用 bootIframeReactPlugin；服务要**额外注册方法表**，
 * 让宿主能通过 ctx.services.call 调进来。
 *
 * 用法：
 *   · 纯计算服务：render 返回 null，只传 methods
 *   · 交互服务（色盘这类）：render 渲染面板，methods 里的方法通过
 *     模块级回调把 Promise 交给 React 组件 —— 用户点确定 resolve，取消 reject。
 *
 * 为什么不能直接用 bootServicePlugin：那是给原生 JS 写的，
 * 内部 mount 什么都不渲染；React 组件需要 createRoot + Provider。
 */
export function bootServiceReactPlugin(
  render: (ctx: PluginContext) => ReactNode,
  methods: Record<string, (args: any, ctx: PluginContext) => Promise<any> | any>,
  mountPoint: string | HTMLElement = 'root',
) {
  const mountTo = (node: ReactNode, ctx: PluginContext) => {
    const el = typeof mountPoint === 'string'
      ? document.getElementById(mountPoint) ?? document.body
      : mountPoint;
    const root = createRoot(el);
    root.render(<NexusProvider ctx={ctx}>{node}</NexusProvider>);
    return () => root.unmount();
  };
  return bootIframePlugin(
    async (ctx: PluginContext) => mountTo(render(ctx), ctx),
    undefined,
    methods,
  );
}

/** 同页插件的便捷定义方式（可选提供设置面板） */
export function defineReactPlugin(
  meta: { name?: string; version?: string },
  render: (ctx: PluginContext) => ReactNode,
  settingsRender?: (ctx: PluginContext) => ReactNode,
) {
  const def: {
    name?: string;
    version?: string;
    mount: (ctx: PluginContext) => () => void;
    settings?: (ctx: PluginContext) => () => void;
  } = {
    name: meta.name,
    version: meta.version,
    mount(ctx: PluginContext) {
      return renderReact(ctx, render(ctx));
    },
  };
  if (settingsRender) {
    def.settings = (ctx: PluginContext) => renderReact(ctx, settingsRender!(ctx));
  }
  return def;
}
