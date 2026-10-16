/**
 * 扫描类测试的 Node 侧便捷读文件
 * ============================================================
 * 为什么单独一个文件：本目录的 test-scan-utils.mjs 会被**浏览器侧共享模块**
 * 引用（js/style-audit.js 引 stripCommentsKeep、js/dead-class-scan.js 引
 * stripComments），它必须保持零 Node 依赖 —— 顶层 import node:fs 会让
 * Vite 浏览器构建直接失败：
 *   "readFileSync" is not exported by "__vite-browser-external"
 * （settings 插件的独立构建实测踩到，报错指向本文件被 import 的链条）。
 *
 * 所以读文件的活儿都在这里，只在 Node 测试进程里被 import。
 */

import { readFileSync } from 'node:fs';

import { stripComments } from './test-scan-utils.mjs';

/** 读文件并直接剥块注释 —— 覆盖 `stripComments(readFileSync(p,'utf8'))` 这个高频组合 */
export function readStripped(path) {
  return stripComments(readFileSync(path, 'utf8'));
}
