import { bootIframeReactPlugin } from '../../src/nexus-react';
import { setTauriBridge } from './lib/tauri';
import './styles.css';
import App from './App';

/**
 * Agent Flow —— 作为 nexus-panel 插件的启动入口
 * ------------------------------------------------------------
 * 采用 iframe（沙箱）模式：
 *   · CSS/JS 与主面板完全隔离，agent_flow 的观感不受面板主题影响
 *   · 调 Rust 以桥接为主、直连兜底（详见 lib/tauri.ts）：
 *     默认 iframe 与外壳同属一个 webview，直连 @tauri-apps/api 仍可用；
 *     一旦被设为隔离态，直连就静默失效，只剩桥接还通
 *
 * 注意：这里**不**引入 css/neumorphism.css。
 * agent_flow 自带 styles.css，两套样式混用会互相污染。
 */
bootIframeReactPlugin((ctx) => {
  // ctx 到这里才第一次拿到，转交 lib/tauri.ts 统一持有。
  // 那里是普通模块，不在 React 树里，拿不到 useNexus()
  setTauriBridge(ctx);
  return <App />;
});
