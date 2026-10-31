/**
 * 故障注入残留 —— 一条跨文件的全局守卫。
 *
 * 为什么要单独立一个文件：
 *   自审查的收尾做法是「故意改坏 → 确认测试变红 → 还原」。还原那一步
 *   靠脚本在跑完注入之后把原文写回，**一旦脚本中途报错，写回就不会执行**，
 *   而后续步骤读到的"原文"已经是坏的那份 —— 于是"恢复一致"的检查
 *   也能通过（它比的是 md5，两份都是坏的）。
 *
 *   这类残留已经发生过三次，其中一次还被推上了远端：boardMeta.ts 里的
 *   `if (false && s) return s.color;` 让 statusColor 对**所有自定义状态**返回
 *   空串（默认状态因为走下面的兜底循环反而正常），而当时全量测试是绿的
 *   —— 编译产物没跟上，测的是旧的那份。
 *
 *   所以只靠"跑一遍测试看红不红"挡不住它：产物不新，红的就不出现。
 *   这里改为扫源码本身，与编译产物无关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AF_SRC, stripComments } from './srcScan';

/** 递归列出源码文件（不含测试、不含编译产物） */
function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'tests' || e.name === 'node_modules' || e.name === 'afts') continue;
        walk(abs);
      } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.test.ts')) {
        out.push(abs);
      }
    }
  };
  walk(AF_SRC);
  return out;
}

test('源码里没有故障注入残留（false && / true || 这类恒真恒假短路）', () => {
  /*
    只认 `(false &&` 与 `(true ||`：**左操作数恒定的短路**。
    正常代码里不会出现这种写法——`x.enabled === false && ...` 是不同的东西
    （左操作数是比较表达式，不是字面量），所以不会误伤。
  */
  const bad = /[(,]\s*(false\s*&&|true\s*\|\|)/;
  const hits: string[] = [];
  for (const abs of srcFiles()) {
    const src = stripComments(fs.readFileSync(abs, 'utf-8'));
    src.split(/\r?\n/).forEach((line, i) => {
      if (bad.test(line)) hits.push(`${path.relative(AF_SRC, abs)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(
    hits,
    [],
    `发现注入残留（改坏之后忘了还原）——${hits.length} 处：\n  ${hits.join('\n  ')}`,
  );
});
