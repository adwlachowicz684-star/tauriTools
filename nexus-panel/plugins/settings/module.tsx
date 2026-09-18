/**
 * 设置插件 —— Vite 构建模式下的**同页（module）入口**
 * ============================================================
 * 与 main.tsx（iframe 入口）是同一个 App 的两种挂载方式：
 *   · main.tsx   → index.html + bootIframeReactPlugin（沙箱）
 *   · module.tsx → defineReactPlugin（同页，本文件）
 * registry 里 type 改为常量 'module' 后，Vite 模式走这里。
 *
 * 为什么迁设置页（D1）
 * ------------------------------------------------------------
 * home 是首个完成嵌合的插件（S7）。设置页是第二个，选它的理由：
 *
 *   · **内置插件**（builtin: true），与宿主同文档不引入不可信代码，
 *     正好是分级模型 L1（受信任、构建期扫过）的适用场景
 *   · **本来就是双模**（noBuild ? 'module' : 'iframe'）—— 同页这条路
 *     对它**不是新东西**，无构建模式下一直在跑，风险比 home 更低
 *   · 它是设置面板，用户会频繁打开，嵌合收益（主题变量自然继承、
 *     CSS 只解析一份、无桥接往返）能被直接感知
 *
 * 刻意保留 main.tsx / index.html
 * ------------------------------------------------------------
 * 删掉它们会让"想用沙箱隔离设置页"这件事变成不可能。两种入口并存，
 * registry 决定走哪一份 —— 这与 home 的处理一致。
 *
 * 文件名必须是 `module.*`
 * ------------------------------------------------------------
 * js/plugin-entries.js 的 import.meta.glob **只匹配这个命名**
 * （`../plugins/*&ast;/module.{js,mjs,ts,tsx}`）。换成 main.tsx /
 * index.tsx 会在 Vite 构建下不被收录，表现为运行时 404。
 */

/*
 * **这里刻意不引入 settings.css** —— 这是同页嵌合最容易踩的坑。
 *
 * settings.css 是给 **iframe** 写的补丁：iframe 内部没有 #stage-scroll，
 * neumorphism.css 的 `html,body{overflow:hidden}` 会让内容无处可滚，
 * 所以它在 `#root` 上重建滚动链。
 *
 * 但同页插件与宿主**同文档、共享全局样式表**，而 React 外壳的根容器
 * **就叫 #root**（src/main.tsx: `getElementById('root')`）。
 * 于是那条 `#root { display:flex; flex-direction:column }`
 * 会命中**宿主自己**，把整个外壳改成 flex 列 —— 布局直接坏掉。
 *
 * 这不是理论风险：iframe 里的样式搬到同页时，任何全局选择器
 * （#root / body / html）都会从"局部"变成"打全局"。
 *
 * 同页下**本来就不需要**这份补丁：设置页挂在 .plugin-root 里，
 * 滚动由宿主的 #stage-scroll 负责（settings.css 自己的注释也写明
 * "无构建 module 模式不受影响，本文件也不会被加载"）。
 *
 * 代价要说清：分页条（.set-tabs）在同页下会随内容一起滚，
 * 不像 iframe 里那样固定在顶部。**未实测**，请本机确认能否接受。
 */
import { defineReactPlugin } from '../../src/nexus-react';
import Settings from './App';

export default defineReactPlugin({ name: '设置' }, () => <Settings />);
