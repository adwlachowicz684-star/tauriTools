import { createRoot } from 'react-dom/client';
import App from './App';
import '../css/neumorphism.css';
/*
 * tokens.css 是**设计令牌的权威来源**（间距、时长、层级 z-*、阴影、字体）。
 *
 * 它此前从未被加载 —— 只有 neumorphism.css 被引。于是凡是引用令牌的
 * `var()` 全部按 CSS 规范失效、属性退化为初始值：不报错、不告警，
 * 表现为"样式看着不对但查不出哪错了"。
 *
 * 这类失效已经出现过两轮：
 *   ① agent-flow 的 styles.css 里 94 处字号、36 处圆角、22 处按钮凸起全废
 *   ② neumorphism 自己引用的 --z-* / --dur-* / --font-sans 等 19 个同样失效
 *
 * 补变量名到各文件是打地鼠 —— 补完一批，上游再引一批新的又失效。
 * 加载令牌文件才是根治。
 *
 * 顺序必须在 neumorphism.css **之后**：后者带一整套同名兜底值，
 * 先加载它、再让令牌覆盖，主题缺失时仍有值可用。
 */
import '../css/tokens.css';
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
 *
 * 注意：这段曾在 53013446 的全量覆盖推送中被打回模板版本而丢失，
 * 现补回。删除前请确认 host.js 的初始化时机确实可靠。
 */
initTheme();

// 注意：这里不使用 StrictMode —— 它在开发环境会重复执行 effect，
// 导致插件 iframe 被挂载两次。宿主引擎本身已具备竞态保护。
createRoot(document.getElementById('root')!).render(<App />);
