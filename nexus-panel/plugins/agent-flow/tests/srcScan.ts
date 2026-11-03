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
/**
 * types.ts 拆成 types/ 十卷之后，源码守卫仍按「主类型文件」这个名字读。
 * 只读桶会拿到 10 行 re-export —— 守卫静默失效，而且失效的样子是全绿，
 * 比报错更危险。与上面 App.tsx 拆 hook 那条是同一件事，只是方向反过来。
 *
 * 顺序必须是**原卷序**（不是文件名字母序）：有的守卫用
 * `src.slice(src.indexOf('export function constsOf'))` 取「之后的部分」，
 * 字母序会把别卷的内容接到后面，凭空造出假红。
 */
const TYPES_ORDER = ['core', 'condition', 'flow', 'io', 'update', 'llm', 'tools', 'canvas', 'ops', 'trigger'];
function expand(rel: string): string[] {
  if (rel !== 'types.ts') return [rel];
  const d = path.join(AF_SRC, 'types');
  if (!fs.existsSync(d)) return [rel];
  return TYPES_ORDER.map((n) => `types/${n}.ts`);
}

export function readSrc(...rels: string[]): string {
  const parts: string[] = [];
  for (const rel of rels) {
    for (const r of expand(rel)) {
      const abs = path.join(AF_SRC, r);
      if (!fs.existsSync(abs)) continue;
      parts.push(fs.readFileSync(abs, 'utf-8'));
    }
  }
  return stripComments(parts.join('\n'));
}
