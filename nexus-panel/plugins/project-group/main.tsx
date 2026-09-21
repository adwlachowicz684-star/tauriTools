import { bootIframeReactPlugin } from '../../src/nexus-react';
import '../../css/neumorphism.css';
import './style.css';
import App from './App';
import PluginSettings from './Settings';
/* #195 兜底：渲染抛错时给出错误与出口，而不是白屏 */
import { ErrorBoundary } from './components/ErrorBoundary';

// 第二个参数 = 插件自己的设置面板；省略则外壳不显示「⚙ 设置」按钮。
// 设置页与主视图是两个 iframe（init 消息 view='settings'），
// 共享同一批后端命令与同一份磁盘配置，保存后靠事件通知主视图刷新。
/*
 * 主视图与设置页**各包一层**：它们是独立的两个 iframe，
 * 只包外层的话设置页崩了照样白屏。
 * 分开包还能让错误信息指明是哪一边出的问题。
 */
bootIframeReactPlugin(
  () => (
    <ErrorBoundary label="主视图">
      <App />
    </ErrorBoundary>
  ),
  () => (
    <ErrorBoundary label="设置页">
      <PluginSettings />
    </ErrorBoundary>
  ),
);
