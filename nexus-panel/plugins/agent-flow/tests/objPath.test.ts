import test from 'node:test';
import assert from 'node:assert/strict';
import { setInPath, getInPath, pathSegs } from '../engine/objPath';

/*
 * 点号路径读写。
 *
 * 卡片上要改的不全是顶层字段 —— 触发器的每个条件卡在 entries 数组里。
 * 通道不认路径的话，`{'entries.0.kind':'cron'}` 会建出一个叫这个名字的
 * **顶层字段**：不报错、界面毫无变化，因为没有任何地方读它。
 */

test('顶层字段照旧', () => {
  const r = setInPath({ a: 1, b: 2 }, 'b', 9) as Record<string, unknown>;
  assert.equal(r.b, 9);
  assert.equal(r.a, 1);
});

test('写进数组里的某一项', () => {
  const root = { entries: [{ id: 'x', kind: 'manual' }, { id: 'y', kind: 'cron' }] };
  const r = setInPath(root, 'entries.1.kind', 'interval') as typeof root;
  assert.equal(r.entries[1].kind, 'interval');
  // 另一项不能被牵动 —— 下标算错就是写进别人那里
  assert.equal(r.entries[0].kind, 'manual');
});

test('逐层建出缺失的容器', () => {
  const r = setInPath({}, 'entries.0.config.intervalSec', 30) as {
    entries: { config: { intervalSec: number } }[];
  };
  assert.equal(r.entries[0].config.intervalSec, 30);
});

test('不改原对象（否则 React 认为没变，卡片不重渲染）', () => {
  const root = { entries: [{ kind: 'manual' }] };
  const r = setInPath(root, 'entries.0.kind', 'cron') as typeof root;
  assert.notEqual(r, root);
  assert.notEqual(r.entries, root.entries);
  assert.equal(root.entries[0].kind, 'manual', '原对象必须还是原值');
});

test('没经过的分支保持同一引用', () => {
  const keep = { deep: { x: 1 } };
  const root = { a: keep, entries: [{ kind: 'manual' }] };
  const r = setInPath(root, 'entries.0.kind', 'cron') as typeof root;
  assert.equal(r.a, keep, '没动的分支不该被复制');
});

/* -------- 读 -------- */

test('按路径读，取不到是 undefined', () => {
  assert.equal(getInPath({ a: { b: 7 } }, 'a.b'), 7);
  assert.equal(getInPath({ a: {} }, 'a.b'), undefined);
  assert.equal(getInPath(null, 'a.b'), undefined, '空值不能抛');
});

test('数字段在数组里当下标用', () => {
  const segs = pathSegs('entries.0.config.x');
  assert.deepEqual(segs, ['entries', 0, 'config', 'x']);
});
