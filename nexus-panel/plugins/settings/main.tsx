import { bootIframeReactPlugin } from '../../src/nexus-react';
import '../../css/neumorphism.css';
// 设置页专属布局：重建滚动链，否则窗口小时下方内容会被 overflow:hidden 裁掉。
// 必须在 neumorphism.css 之后引入（它要覆盖其中的 html/body 规则带来的后果）。
import './settings.css';
import Settings from './App';

bootIframeReactPlugin(() => <Settings />);
