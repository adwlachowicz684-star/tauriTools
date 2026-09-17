/**
 * 概览插件 —— Vite 构建模式下的**同页（module）入口**
 * ============================================================
 * 与本目录的 index.js（无构建模式的同页入口）是同一个插件的两种实现，
 * 与 iframe 入口 index.html 并存。registry 按 noBuild 选择走哪一份。
 *
 * 为什么这里能同页而不用 iframe
 * ------------------------------------------------------------
 * 同页嵌合的收益（主题变量自然继承、CSS 只解析一份、ctx.services 变
 * 普通函数调用、owned 通道生效）只有同文档才拿得到。
 * 前提是构建期能把这个入口打进产物 —— 靠 js/plugin-entries.js 里的
 * import.meta.glob（方案 B）实现。
 *
 * 文件名必须是 `module.*`：**glob 只匹配这个命名**，
 * 换成别的名字会在 Vite 构建下不被收录，表现为运行时 404。
 */
import { defineReactPlugin } from '../../src/nexus-react';
import Overview from './App';

export default defineReactPlugin({ name: '概览' }, () => <Overview />);
