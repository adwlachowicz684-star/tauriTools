import { createRoot } from 'react-dom/client';
import App from './App';
import '../css/neumorphism.css';
import { initTheme } from '../js/theme-manager.js';

/**
 * 主面板自己在渲染前应用主题。
 *
 * 此前只有 js/host.js 在 createHost() 里顺带调用 initTheme() ——
 * 主面板外壳因此是"搭便车"拿到主题的：一旦宿主初始化延迟或顺序变化，
 * 外壳就会退回 neumorphism.css 里的默认变量（新拟态深色），
 * 表现为"切了主题但外壳不变"。
 *
 * 这里显式调用后，外壳与插件各走各的初始化，互不影响。
 * initTheme() 幂等，晚于它的 host.js 调用不会再改动已应用的主题。
 */
initTheme();

// 注意：这里不使用 StrictMode —— 它在开发环境会重复执行 effect，
// 导致插件 iframe 被挂载两次。宿主引擎本身已具备竞态保护。
createRoot(document.getElementById('root')!).render(<App />);
