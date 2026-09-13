import { bootIframeReactPlugin } from '../../src/nexus-react';
import '../../css/neumorphism.css';
import Demo from './App';
import PluginSettings from './Settings';

// 第二个参数 = 插件自己的设置面板（省略则外壳不显示「⚙ 设置」按钮）
bootIframeReactPlugin(() => <Demo />, () => <PluginSettings />);
