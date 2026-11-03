import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AF_SRC, readSrc } from './srcScan';

/**
 * types.ts 分卷守卫。
 *
 * 3273 行的主类型文件按域切成十卷、types.ts 只留 re-export 之后，
 * 最危险的不是编译错，而是**守卫静默读空**：
 *   · 只读桶 → 拿到 10 行 re-export，所有「types.ts 里必须有 X」全绿；
 *   · 有人图省事直接 import 分卷 → 入口变成两个，加一种节点要改两处；
 *   · 桶漏一条 export * → 一个域整个消失，而 175 处 import 一行没改、看着正常。
 *
 * 所以这里钉的是「入口仍然只有一个」和「逻辑视图仍然是全文」，
 * 而不是某段代码长什么样。
 */
const ORDER = ['core', 'condition', 'flow', 'io', 'update', 'llm', 'tools', 'canvas', 'ops', 'trigger'];
const ROOT = AF_SRC;
const DIR = path.join(ROOT, 'types');
const SELF = 'tests/typesBarrel.test.ts';

function barrel(): string {
  return fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf-8');
}

/** 分卷之外的全部源文件（分卷之间互相 import 是设计允许的） */
function outside(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (['node_modules', 'afts', 'dist', '.git', '__pycache__', 'types'].includes(e.name)) continue;
        walk(abs);
      } else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && rel !== SELF && rel !== 'types.ts') {
        out.push({ rel, src: fs.readFileSync(abs, 'utf-8') });
      }
    }
  };
  walk(ROOT);
  return out;
}

test('（前置）十卷文件都在，且每卷都有真实声明', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts')).sort();
  assert.deepEqual(files.map((f) => f.slice(0, -3)).sort(), [...ORDER].sort(),
    'types/ 下的分卷清单变了 —— 桶与 srcScan 的 TYPES_ORDER 都要同步改');
  let total = 0;
  for (const n of ORDER) {
    const s = fs.readFileSync(path.join(DIR, n + '.ts'), 'utf-8');
    assert.ok(s.length > 2000, `${n} 卷只有 ${s.length} 字节 —— 多半是切分边界算错了`);
    assert.ok(s.includes(`第 ${ORDER.indexOf(n) + 1} 卷`), `${n} 卷的卷号说明不见了`);
    total += (s.match(/^export\s/gm) ?? []).length;
  }
  assert.ok(total >= 180, `只解析出 ${total} 个导出（原来 184 个）—— 分卷丢了声明`);
});

test('桶的 re-export 与十卷一一对应，一个都不能漏', () => {
  const s = barrel();
  const got = [...s.matchAll(/export \* from '\.\/types\/([a-z]+)';/g)].map((m) => m[1]);
  assert.deepEqual(got, ORDER, '桶的 export * 清单与分卷顺序不一致');
  assert.equal((s.match(/export \*/g) ?? []).length, ORDER.length);
});

test('types.ts 之外没人直接 import 分卷（入口只有一个）', () => {
  const bad: string[] = [];
  for (const f of outside()) {
    for (const m of f.src.matchAll(/from\s+['"](?:\.{1,2}\/)+types\/[a-z]+['"]/g)) {
      bad.push(`${f.rel} → ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [],
    `有人绕过桶直接引分卷：\n  ${bad.join('\n  ')}\n加一种节点要同时改两处入口，正是分叉的起点。`);
});

test('readSrc(types.ts) 是全文聚合视图，不是那 10 行桶', () => {
  const s = readSrc('types.ts');
  // 剥掉注释后约 59k（原文件 111728 字节里中文注释占了一半）；
  // 只读那 10 行桶的话是几百字符，阈值挡得住，又不会误伤正常缩水。
  assert.ok(s.length > 45000, `聚合视图只有 ${s.length} 字符 —— readSrc 多半没展开分卷`);
  for (const needle of [
    'export type NodeData', 'export function makeNode', 'export const FS_FORBIDDEN',
    'export function constsOf', 'export const TRIGGER_META',
  ]) {
    assert.ok(s.includes(needle), `聚合视图里没有 ${needle} —— 守卫会静默失效`);
  }
});

test('聚合视图保持原卷序（不是文件名字母序）', () => {
  const s = readSrc('types.ts');
  const a = s.indexOf('export function constsOf');
  const b = s.indexOf('export function makeNode');
  assert.ok(a > 0 && b > 0, '两个锚点都没抓到 —— 顺序守卫失去前提');
  assert.ok(a < b,
    'constsOf 排到了 makeNode 后面 —— 分卷按字母序拼了，'
    + '那些用 slice(indexOf(...)) 取「之后的部分」的守卫会凭空造出假红');
});
