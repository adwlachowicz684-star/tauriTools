import { createRoot } from 'react-dom/client';
import App from './App';
import '../css/neumorphism.css';

// 注意：这里不使用 StrictMode —— 它在开发环境会重复执行 effect，
// 导致插件 iframe 被挂载两次。宿主引擎本身已具备竞态保护。
createRoot(document.getElementById('root')!).render(<App />);
