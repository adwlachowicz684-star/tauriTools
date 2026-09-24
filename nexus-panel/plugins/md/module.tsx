/**
 * md 插件 —— Vite 构建模式下的**同页（module）入口**
 * ============================================================
 * 文件名必须是 `module.*`：js/plugin-entries.js 的 import.meta.glob
 * **只匹配这个命名**。换成别的名字在 Vite 构建下不被收录，
 * 表现为运行时 404（插件打不开，却查不到哪错了）。
 *
 * 为什么走同页而不是 iframe
 * ------------------------------------------------------------
 * 同页才能自然继承宿主的 CSS 变量与主题 —— 本插件的 F6「主题跟随」
 * 要求颜色全部读宿主变量（--bg / --surface / --text / --accent），
 * iframe 是独立文档，宿主样式进不来，得自己引一份
 * （demo-iframe 就是因为漏引，打开后"只有文字"）。
 *
 * 它是内置插件（registry 里 builtin: true），与宿主同文档不会引入
 * 不可信代码 —— 这正是分级模型里 L1（受信任、构建期扫过）的适用场景。
 */
import { defineReactPlugin } from '../../src/nexus-react';
import MdApp from './App';

/*
 * 把 ctx 传给 App：E2（宿主传路径）要用 ctx.openArgs / ctx.onOpenArgs /
 * ctx.invoke。不给的话 App 里 ctx 是 undefined，路径入口**静默不生效** ——
 * 不报错，只是"传了路径没反应"，正是最难排查的那类。
 */
export default defineReactPlugin({ name: 'Markdown' }, (ctx) => <MdApp ctx={ctx} />);
