import { bootIframeReactPlugin } from '../../src/nexus-react';
import './styles.css';
import App from './App';

/**
 * Agent Flow —— 作为 nexus-panel 插件的启动入口
 * ------------------------------------------------------------
 * 采用 iframe（沙箱）模式：
 *   · CSS/JS 与主面板完全隔离，agent_flow 的观感不受面板主题影响
 *   · 仍可直接使用 @tauri-apps/api 调 Rust（同一 webview，IPC 可用）
 *
 * 注意：这里**不**引入 css/neumorphism.css。
 * agent_flow 自带 styles.css，两套样式混用会互相污染。
 */
bootIframeReactPlugin(() => <App />);
