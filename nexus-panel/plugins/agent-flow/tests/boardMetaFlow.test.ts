import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import {
  emptyMeta, parseMeta, serializeMeta, removeStatus, setNext,
  canFlow, nextStatuses, updateStatus, DEFAULT_STATUSES,
  type BoardMeta, type StatusDef,
} from '../engine/boardMeta';

/*
 * 状态流程里的**死局**。
 *
 * 一个非终态却没有"能走到"的目标 = 这条任务再也推不动 ——
 * 连"已完成 / 已取消"都到不了。界面上的表现是流转下拉空的、点了没反应，
 * 而看不出是刚才哪一下操作造成的。
 *
 * 这条规则本来只在**读盘归一**（parseMeta）里有：
 * 删状态那条路（removeStatus）清完悬空引用就收工，不检查有没有把谁钉死。
 * 于是"删掉中间那个状态"这一个动作就能造出一个死局。
 */

function mk(list: { id: string; next?: string[]; final?: boolean }[]): BoardMeta {
  const m = emptyMeta('p', '项目甲');
  m.statuses = list.map((s) => ({
    id: s.id, name: s.id, color: '#8b93a7',
    final: !!s.final, next: s.next ? [...s.next] : [],
  }));
  return m;
}

const idsOf = (m: BoardMeta, id: string): string[] =>
  (m.statuses.find((s) => s.id === id)?.next ?? []).slice();

/** 死局：非终态且没有任何去处 */
function deadEnds(m: BoardMeta): StatusDef[] {
  return m.statuses.filter((s) => !s.final && s.next.length === 0);
}

test('删掉中间那个状态后，剩下的状态不能被钉死', () => {
  // 待办 → 评审 → 完成。删掉「评审」
  const m = mk([
    { id: 'todo', next: ['review'] },
    { id: 'review', next: ['done'] },
    { id: 'done', final: true },
  ]);
  const r = removeStatus(m, 'review');
  assert.deepEqual(deadEnds(r), [], '删完不该留下非终态却无处可去的状态');
  assert.ok(canFlow(r, 'todo', 'done'), '待办必须还能走到完成');
});

test('只剩自己一个非终态时，要退一步允许走到终态', () => {
  // 这一步是关键：只按"其它非终态"算的话结果仍是空，任务就永远推不动
  const m = mk([
    { id: 'todo', next: ['doing'] },
    { id: 'doing', next: ['todo'] },
    { id: 'done', final: true },
    { id: 'cancelled', final: true },
  ]);
  const r = removeStatus(m, 'doing');
  const todo = r.statuses.find((s) => s.id === 'todo');
  assert.ok(todo && todo.next.length > 0, '待办必须还有去处');
  assert.ok(
    todo!.next.every((x) => ['done', 'cancelled'].indexOf(x) >= 0),
    `没有别的非终态可去时应退到终态，实际：${JSON.stringify(todo!.next)}`,
  );
});

/* ---- 反向：只盯"别留死局"的话，把 next 一律填满也算通过 ---- */

test('终态的 next 必须保持为空（不能被顺手填上）', () => {
  const m = mk([
    { id: 'todo', next: ['done'] },
    { id: 'done', final: true },
  ]);
  const r = removeStatus(m, 'todo');
  const done = r.statuses.find((s) => s.id === 'done');
  assert.deepEqual(done?.next, [], '终态不能再流出');
});

test('本来有去处的状态不该被改写', () => {
  const m = emptyMeta('p', '项目甲');
  const before = idsOf(m, 'todo');
  // 删「已挂起」：待办的 next 是 [doing, held, cancelled]，删完还剩两个
  const r = removeStatus(m, 'held');
  assert.deepEqual(idsOf(r, 'todo'), before.filter((x) => x !== 'held'));
  assert.ok(
    idsOf(r, 'todo').indexOf('done') < 0,
    '不该把没勾过的「已完成」塞进来 —— 那会让人以为自己记错了',
  );
});

test('只剩一个状态时不动（没有可去的地方是事实，不是配置坏了）', () => {
  const m = mk([{ id: 'todo', next: [] }]);
  const r = removeStatus(m, 'todo');
  assert.deepEqual(r.statuses, []);
});

/* ---- 同一条规则，读盘与删除必须一致 ---- */

test('删完存盘再读回，结论要一致', () => {
  const m = mk([
    { id: 'todo', next: ['review'] },
    { id: 'review', next: ['done'] },
    { id: 'done', final: true },
  ]);
  const r = removeStatus(m, 'review');
  const back = parseMeta(serializeMeta(r), 'p', '项目甲');
  assert.deepEqual(idsOf(back, 'todo'), idsOf(r, 'todo'));
  assert.equal(canFlow(back, 'todo', 'done'), canFlow(r, 'todo', 'done'));
});

test('读盘归一：手改的文件里被钉死的状态也要能救回来', () => {
  const raw = JSON.stringify({
    v: 1, project: 'p', projectName: '项目甲', updatedAt: 1,
    statuses: [
      { id: 'todo', name: '待办', color: '#8b93a7', final: false, next: [] },
      { id: 'done', name: '已完成', color: '#22c55e', final: true, next: [] },
    ],
    tags: [],
  });
  const m = parseMeta(raw, 'p', '项目甲');
  assert.deepEqual(deadEnds(m), [], '读盘后不该有死局');
  assert.ok(nextStatuses(m, 'todo').length > 0);
});

/*
 * setNext 是**显式**勾选的结果，勾空是用户在表达"这个状态不该流出" ——
 * 替他填回去等于跟他抢控件，所以那里刻意不归一。
 * 这条把"刻意"钉住：将来有人顺手补上，这里的意图就被抹掉了。
 */
/*
 * 勾掉「终态」也会把状态放回流程里 —— 那一步以前自己算"其它非终态"，
 * 只剩自己一个非终态时算出来是空，于是刚放回来的状态又是个死局。
 */
test('把终态勾回非终态时，不能放回一个死局', () => {
  const m = mk([
    { id: 'todo', next: ['done'] },
    { id: 'done', final: true },
  ]);
  const on = updateStatus(m, 'todo', { final: true });
  assert.deepEqual(idsOf(on, 'todo'), [], '变成终态就不能再流出');
  const off = updateStatus(on, 'todo', { final: false });
  assert.ok(
    idsOf(off, 'todo').length > 0,
    '勾回非终态必须给回去处，否则这条任务哪儿都去不了',
  );
});

test('setNext 尊重显式勾空（不替用户填回）', () => {
  const m = mk([
    { id: 'todo', next: ['doing'] },
    { id: 'doing', next: [] },
    { id: 'done', final: true },
  ]);
  const r = setNext(m, 'todo', []);
  assert.deepEqual(idsOf(r, 'todo'), []);
});

/* ------------------------------------------------------------------ */
/* 判据只有一份，不另写                                                */
/* ------------------------------------------------------------------ */

/*
 * 源码不在测试目录里，靠 AF_SRC 指过去；没设就跳过 ——
 * 否则在没带源码的环境里跑，每条都因"读不到文件"而红，那是假失败。
 */
const ROOT = process.env.AF_SRC || '';

test('「有没有被钉死」的判据只有一份，读盘与删除都用它', () => {
  if (!ROOT) return;
  const src = fs.readFileSync(ROOT + '/engine/boardMeta.ts', 'utf8');
  assert.ok(/function ensureReachable/.test(src), '应有一处共享的归一函数');

  const parse = src.slice(src.indexOf('export function parseMeta'), src.indexOf('导出'));
  const parseBody = src.slice(
    src.indexOf('export function parseMeta'),
    src.indexOf('/* ---- 标签 ---- */'),
  );
  assert.ok(
    /ensureReachable\(/.test(parseBody),
    'parseMeta 必须调 ensureReachable，不能自己写一段归一',
  );

  const rm = src.slice(src.indexOf('export function removeStatus'));
  const rmBody = rm.slice(0, rm.indexOf('export function updateStatus'));
  assert.ok(
    /ensureReachable\(/.test(rmBody),
    'removeStatus 必须调 ensureReachable —— 清完悬空引用就收工会留下死局',
  );

  /*
   * 归一那段旧的"非终态给回全部非终态"写法不该再单独存在。
   *
   * ⛔ 但检查要**排除 ensureReachable 自身**：它里面就有这句 ——
   *    不排除的话守卫会先命中自己，于是"判据已经收成一份"这个事实
   *    反而被判成两份。这是守卫自指的又一处（此前已踩过多次）。
   */
  const at = src.indexOf('function ensureReachable');
  const end = src.indexOf('export function parseMeta');
  const outside = src.slice(0, at) + src.slice(end);
  /*
   * 判据的**形状**是"next 空了就补" —— 这句只该出现在 ensureReachable 里。
   * 用 next.length 而不是 nonFinal 当特征：后者在 addStatus 里另有正当用途
   * （新建状态默认能走到所有非终态），拿它当特征会误伤。
   */
  assert.ok(
    !/\.next\.length\s*===\s*0/.test(outside),
    'ensureReachable 之外仍有"next 空了就补"的写法 —— 那是第二份判据',
  );
  void parse;
});

test('默认状态流本身没有死局', () => {
  const m = emptyMeta('p', '项目甲');
  assert.equal(m.statuses.length, DEFAULT_STATUSES.length);
  assert.deepEqual(deadEnds(m), []);
});
