import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expandCanvasRefs, rewriteDataTemplates, KIND_CANVAS_REF,
} from '../engine/canvasRef';
import { expandModules } from '../engine/modules';
import { readSrc } from './srcScan';

/*
 * 同一份数据形状，两份展开实现，只有一份是对的 ——
 *
 * 常量卡的 items、条件卡的 rules 都是**对象数组**，模板引用藏在元素的
 * .value / .expr 里。expandModules 的 rewriteData 一直是完全递归的，
 * 且 modules.test.ts 里早有断言；expandCanvasRefs 的
 * rewriteDataTemplates 注释写着「模块那一轮踩过的坑，这里直接复用
 * 同一套处理」，实际是另写的一份，数组分支只改字符串元素、对象元素
 * 原样放过。
 *
 * 后果是静默的：跨画布子画布里一张常量卡引用了同画布节点，展开后
 * 引用仍指向没有前缀的旧 id，renderTemplate 取不到值 → 空串，
 * 不报错、测试也不红，界面上就是「下游没数据」。
 */

const N = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ id, data: { kind, label: id, ...extra } });
const E = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });

type Data = Record<string, unknown>;
const d = (n: { id: string; data?: unknown }): Data => (n.data ?? {}) as Data;

/* ================= 行为 ================= */

test('对象数组元素里的模板也要重写（本轮修的那一层）', () => {
  const m = new Map([['A', 'r__A']]);
  const out = rewriteDataTemplates({
    items: [{ id: 'c1', name: '价格', value: '{{A.output}}', valueType: 'text' }],
  }, m) as Data;
  assert.equal((out.items as Data[])[0].value, '{{r__A.output}}');
});

test('数组套对象再套数组，逐层都要到（不能只补一层）', () => {
  const m = new Map([['A', 'r__A']]);
  const out = rewriteDataTemplates({
    groups: [{ rules: [{ expr: '{{A.output}}' }, { list: ['{{A.name}}'] }] }],
  }, m) as Data;
  const g = (out.groups as Data[])[0];
  assert.equal((g.rules as Data[])[0].expr, '{{r__A.output}}');
  assert.equal(((g.rules as Data[])[1].list as string[])[0], '{{r__A.name}}');
});

test('端到端：跨画布展开后，子画布常量卡的引用带上实例前缀', () => {
  const inner = {
    id: 'B', name: '子画布',
    nodes: [
      N('A', 'task'),
      N('C', 'const', {
        items: [{ id: 'c1', name: '价格', value: '{{A.output}}', valueType: 'text' }],
      }),
    ],
    edges: [E('A', 'C')],
  };
  const outer = {
    nodes: [N('r1', KIND_CANVAS_REF, { canvasId: 'B' })],
    edges: [],
  };
  const out = expandCanvasRefs(
    outer as never,
    (id) => (id === 'B' ? (inner as never) : null),
  );
  const c = out.nodes.find((n) => String(n.id) === 'r1__C');
  assert.ok(c, '子画布节点应被加前缀并入');
  assert.equal((d(c!).items as Data[])[0].value, '{{r1__A.output}}');
});

test('反例：非引用文本、数字、布尔、null 一律原样（防过度修复）', () => {
  const m = new Map([['A', 'r__A']]);
  const src = {
    label: '价格表', maxTokens: 4096, enabled: true, empty: null,
    items: [{ id: 'c1', name: '不是引用', value: '固定值' }],
  };
  assert.deepEqual(rewriteDataTemplates(src, m), src);
});

test('对照：模块展开的同样形状本来就是对的', () => {
  /*
   * 这条故意留着。它证明的不是「模块侧也要改」，而是
   * 「两份实现里只有跨画布那份漏了」—— 将来有人把模块侧也
   * 改成只改字符串元素，这条会立刻红。
   */
  const def = {
    id: 'md1', name: 'M',
    nodes: [
      N('A', 'task'),
      N('C', 'const', { items: [{ id: 'c1', value: '{{A.output}}' }] }),
    ],
    edges: [E('A', 'C')],
  };
  const g = expandModules(
    { nodes: [N('inst', 'module', { moduleId: 'md1' })], edges: [] } as never,
    () => def as never,
  );
  const c = g.nodes.find((n) => String(n.id) === 'inst__C');
  assert.ok(c, '模块内部节点应被加前缀并入');
  assert.deepEqual(d(c!).items, [{ id: 'c1', value: '{{inst__A.output}}' }]);
});

/* ================= 源码守卫 ================= */

test('源码守卫：数组分支不许退回「只改字符串元素」', () => {
  const src = readSrc('engine/canvasRef.ts');
  assert.ok(src.includes('function rewriteDataTemplates'), '守卫自身要读到定义');
  assert.ok(
    !/typeof x === 'string'\s*\?\s*rewriteRefsInText/.test(src),
    '数组里的对象元素必须递归重写，不能原样放过',
  );
});

test('源码守卫：重写走统一入口，不许为省事自带正则', () => {
  /*
   * 与 refToken.test.ts 同源约束呼应：那份钉的是「两处展开都要调
   * rewriteRefHeads()」，这里补一条「补递归时别顺手把字符集换成自己写的」。
   */
  const src = readSrc('engine/canvasRef.ts');
  assert.ok(/rewriteRefHeads\(/.test(src), '引用头重写必须与渲染同源');
  assert.ok(
    !/replace\(\s*\/\\[{]/.test(src),
    'canvasRef.ts 里不该再出现硬写的 {{ 正则',
  );
});
