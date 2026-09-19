/*
 * 同页入口（Vite 构建期由 import.meta.glob 收录）
 * ============================================================
 * 命名约定 `plugins/<id>/module.{js,mjs,ts,tsx}` —— 见 js/plugin-entries.js。
 * 构建期 import.meta.glob 静态展开它、生成独立 chunk 并重写路径；
 * entry 若写成 index.js，产物里不会生成 chunk，运行时表现为 404。
 *
 * 实现**只有一份**，放在同目录的 index.js：
 *   · 无构建模式：registry 的 noBuild 分支用 './plugins/demo-module/index.js'
 *     （源码直出，相对路径 ../../js/plugin-sdk.js 真实有效）
 *   · Vite 构建  ：走本文件，被 glob 收录成 chunk
 * 两份入口共用同一实现，避免将来只改一份导致行为漂移。
 */
export { default } from './index.js';
