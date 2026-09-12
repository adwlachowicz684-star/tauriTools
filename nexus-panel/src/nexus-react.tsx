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
  mountPoint: string | HTMLElement = 'root',
) {
  return bootIframePlugin(async (ctx) => {
    const el = typeof mountPoint === 'string'
      ? document.getElementById(mountPoint) ?? document.body
      : mountPoint;
    const root = createRoot(el);
    root.render(<NexusProvider ctx={ctx}>{render(ctx)}</NexusProvider>);
    return () => root.unmount();
  });
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

/** 同页插件的便捷定义方式 */
export function defineReactPlugin(
  meta: { name?: string; version?: string },
  render: (ctx: PluginContext) => ReactNode,
) {
  return {
    name: meta.name,
    version: meta.version,
    mount(ctx: PluginContext) {
      return renderReact(ctx, render(ctx));
    },
  };
}
