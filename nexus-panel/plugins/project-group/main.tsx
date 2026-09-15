import { bootIframeReactPlugin } from '../../src/nexus-react';
import '../../css/neumorphism.css';
import './style.css';
import App from './App';
import PluginSettings from './Settings';

// 第二个参数 = 插件自己的设置面板；省略则外壳不显示「⚙ 设置」按钮。
// 设置页与主视图是两个 iframe（init 消息 view='settings'），
// 共享同一批后端命令与同一份磁盘配置，保存后靠事件通知主视图刷新。
bootIframeReactPlugin(() => <App />, () => <PluginSettings />);
