import { Component, type ReactNode } from 'react';
import { bootIframeReactPlugin } from '../../src/nexus-react';
import '../../css/neumorphism.css';
import './styles.css';
import App from './App';
import PluginSettings from './Settings';

/**
 * 开发期错误上屏：iframe 里脚本报错如果不接住，表现就是「插件打开是空白」，
 * 用户侧完全看不到原因。这里把 window.error / unhandledrejection / render
 * 错误三类全部渲染到 #root 顶部，不用开 devtools 就能定位。
 * （定位完可以留着——只在本插件 iframe 内生效，不影响宿主。）
 */
function showFatal(tag: string, e: unknown) {
  try {
    // 挂 body 不挂 #root：React 重建容器子树时不会把错误面板抹掉
    if (document.body.dataset.fatalShown === '1') return;
    const err = e as { stack?: string; message?: string } | undefined;
    const msg = String((err && (err.stack || err.message)) || e);
    document.body.dataset.fatalShown = '1';
    const pre = document.createElement('pre');
    pre.setAttribute('style',
      'position:fixed;inset:0;z-index:99999;overflow:auto;margin:0;padding:14px;' +
      'background:#1a1214;color:#ff8a8a;font:12px/1.6 Consolas,monospace;white-space:pre-wrap;word-break:break-all;');
    pre.textContent = `[${tag}]\n${msg}`;
    document.body.appendChild(pre);
  } catch {
    /* 兜底本身不能再抛 */
  }
}

window.addEventListener('error', (e) => showFatal('window.error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) =>
  showFatal('unhandledrejection', (e as PromiseRejectionEvent).reason),
);

class FatalBoundary extends Component<{ children: ReactNode }, { err: string }> {
  state = { err: '' };
  static getDerivedStateFromError(e: unknown) {
    return { err: String((e as Error)?.message || e) };
  }
  componentDidCatch(e: unknown) {
    showFatal('react.render', e);
  }
  render() {
    if (this.state.err) {
      return (
        <pre style={{ padding: 14, color: 'var(--danger, #ff8a8a)', whiteSpace: 'pre-wrap' }}>
          {this.state.err}
        </pre>
      );
    }
    return this.props.children;
  }
}

// 第二个参数 = 插件自己的设置面板（省略则外壳不显示「⚙ 设置」按钮）
bootIframeReactPlugin(
  () => (
    <FatalBoundary>
      <App />
    </FatalBoundary>
  ),
  () => (
    <FatalBoundary>
      <PluginSettings />
    </FatalBoundary>
  ),
);
