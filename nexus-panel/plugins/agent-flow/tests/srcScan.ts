/**
 * 源码守卫用的读取工具。
 *
 * 这些守卫查的是**源码本身**，而测试跑在编译产物目录里 ——
 * 所以要靠 AF_SRC 指回仓库（run-tests.sh 已经设了它）。
 *
 * ================= 为什么要支持多个文件 ====================
 *
 * App.tsx 正在往下拆 hook，代码会搬到 hooks/ 下。
 * 守卫只盯 App.tsx 的话，一搬走它就**静默失效** ——
 * 而且失效的样子是"通过"，比报错更危险。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const AF_SRC: string = process.env.AF_SRC ?? path.resolve(__dirname, '..');

/** 剥掉块注释与整行注释 —— 说明文字里的旧写法不该被当成真代码 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 读若干源文件并拼成一份。
 *
 * 传多个文件是常态：同一段逻辑可能在 App.tsx 或某个 hook 里，
 * 两边都要扫 —— 只扫一处会在代码搬走后假通过。
 */
export function readSrc(...rels: string[]): string {
  const parts: string[] = [];
  for (const rel of rels) {
    const abs = path.join(AF_SRC, rel);
    if (!fs.existsSync(abs)) continue;
    parts.push(fs.readFileSync(abs, 'utf-8'));
  }
  return stripComments(parts.join('\n'));
}
