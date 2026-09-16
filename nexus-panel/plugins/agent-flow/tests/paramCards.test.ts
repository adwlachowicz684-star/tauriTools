import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addParamCard, loadParamCards, saveParamCards, removeParamCard, renameParamCard,
  cardsOfGroup, findCard, cardIdOf, applyCardTo, detachGroup, shouldDetach,
  exportParamCards, importParamCards, type ParamCard, type KV,
} from '../engine/paramCards';

function memKV() {
  const map = new Map<string, string>();
  return { map, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
}

const REPO_VALUES = { owner: 'acme', repo: 'web', branch: 'main' };

/* ---- 基础 CRUD ---- */

test('新增后能读回来', () => {
  const kv = memKV();
  const c = addParamCard({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  assert.equal(c.group, 'github-repo');
  assert.equal(c.name, '主仓库');
  assert.deepEqual(c.values, REPO_VALUES);
  assert.equal(loadParamCards(kv).length, 1);
});

test('按组取卡片：只返回同组的', () => {
  const kv = memKV();
  addParamCard({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  addParamCard({ group: 'github-repo', name: '备用', values: { owner: 'b' } }, kv);
  addParamCard({ group: 'github-cred', name: '机器人', values: { credentialId: 'c1' } }, kv);

  assert.equal(cardsOfGroup('github-repo', kv).length, 2);
  assert.equal(cardsOfGroup('github-cred', kv).length, 1);
  assert.equal(cardsOfGroup('不存在的组', kv).length, 0);
});

test('删除只删指定那条', () => {
  const kv = memKV();
  const a = addParamCard({ group: 'g', name: 'A', values: {} }, kv);
  addParamCard({ group: 'g', name: 'B', values: {} }, kv);
  removeParamCard(a.id, kv);
  const list = loadParamCards(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'B');
});

test('改名：空名不生效', () => {
  const kv = memKV();
  const a = addParamCard({ group: 'g', name: 'A', values: {} }, kv);
  renameParamCard(a.id, '   ', kv);
  assert.equal(loadParamCards(kv)[0].name, 'A');
  renameParamCard(a.id, '  B  ', kv);
  assert.equal(loadParamCards(kv)[0].name, 'B');
});

test('findCard 按 id 找；找不到返回 null', () => {
  const kv = memKV();
  const a = addParamCard({ group: 'g', name: 'A', values: {} }, kv);
  assert.equal(findCard(a.id, kv)?.name, 'A');
  assert.equal(findCard('不存在', kv), null);
  assert.equal(findCard(null, kv), null);
});

/* ---- 坏数据容错 ---- */

test('坏 JSON 读出空列表，不抛异常', () => {
  const kv = memKV();
  kv.map.set('agent-flow.paramCards.v1', '{坏掉的');
  assert.deepEqual(loadParamCards(kv), []);
});

test('残缺条目被过滤，正常的保留', () => {
  const kv = memKV();
  saveParamCards([
    { id: 'x', group: 'g', name: 'X', values: { a: 1 }, createdAt: 1 },
    { id: '', group: 'g', name: '缺 id', values: {} } as unknown as ParamCard,
    { id: 'y', group: '', name: '缺组名', values: {} } as unknown as ParamCard,
  ], kv);
  const list = loadParamCards(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'X');
});

test('没有 localStorage 的环境（Node）也不崩', () => {
  assert.doesNotThrow(() => loadParamCards());
  assert.doesNotThrow(() => addParamCard({ group: 'g', name: 'x', values: {} }));
});

/* ---- 套用 ---- */

test('套用卡片：值写进节点，并记录引用', () => {
  const kv = memKV();
  const card = addParamCard({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  const patch = applyCardTo({ label: 'A' }, card, ['owner', 'repo', 'branch']);

  assert.equal(patch.owner, 'acme');
  assert.equal(patch.repo, 'web');
  assert.equal(patch.branch, 'main');
  assert.deepEqual(patch.cardRefs, { 'github-repo': card.id });
});

test('只覆盖列出的字段（卡片多余字段不塞进节点）', () => {
  const kv = memKV();
  const card = addParamCard({
    group: 'g', name: 'C', values: { owner: 'a', repo: 'b', branch: 'c', extra: 'x' },
  }, kv);
  const patch = applyCardTo({}, card, ['owner', 'repo']);
  assert.equal(patch.owner, 'a');
  assert.equal(patch.repo, 'b');
  assert.equal(patch.branch, undefined, '未列出的字段不该写进去');
  assert.equal(patch.extra, undefined);
});

test('套用第二张不同组的卡片时，保留第一张的引用', () => {
  const kv = memKV();
  const repo = addParamCard({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  const cred = addParamCard({ group: 'github-cred', name: 'C', values: { credentialId: 'c1' } }, kv);

  let data: Record<string, unknown> = { label: 'A' };
  data = { ...data, ...applyCardTo(data, repo, ['owner', 'repo']) };
  data = { ...data, ...applyCardTo(data, cred, ['credentialId']) };

  assert.equal(cardIdOf(data, 'github-repo'), repo.id);
  assert.equal(cardIdOf(data, 'github-cred'), cred.id, '第一张的引用不该被覆盖掉');
});

/**
 * 这条守的是共享引用：
 * 若套用时是浅拷贝，两个节点套用同一张卡片会共享嵌套对象，
 * 改一个节点的配置，另一个跟着变 —— 不报错，极难定位。
 */
test('套用是深拷贝：两个节点套同一张卡片互不干扰', () => {
  const kv = memKV();
  const card = addParamCard({
    group: 'g', name: 'C', values: { cfg: { host: 'a.com' } },
  }, kv);

  const n1: Record<string, unknown> = { ...applyCardTo({}, card, ['cfg']) };
  const n2: Record<string, unknown> = { ...applyCardTo({}, card, ['cfg']) };

  (n1.cfg as Record<string, unknown>).host = 'b.com';
  assert.equal((n2.cfg as Record<string, unknown>).host, 'a.com', '第二个节点不该受影响');
  assert.equal((card.values.cfg as Record<string, unknown>).host, 'a.com', '卡片本身也不该被改');
});

/* ---- 脱钩 ---- */

test('脱钩：移除该组引用，但节点上的值保留', () => {
  const kv = memKV();
  const card = addParamCard({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  let data: Record<string, unknown> = { ...applyCardTo({}, card, ['owner', 'repo']) };

  assert.equal(cardIdOf(data, 'github-repo'), card.id);
  data = { ...data, ...detachGroup(data, 'github-repo') };

  assert.equal(cardIdOf(data, 'github-repo'), null);
  assert.equal(data.owner, 'acme', '用户改过的值要留在节点上');
  assert.equal(data.repo, 'web');
});

test('脱钩不影响其它组的引用', () => {
  const kv = memKV();
  const repo = addParamCard({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  const cred = addParamCard({ group: 'github-cred', name: 'C', values: { credentialId: 'c1' } }, kv);

  let data: Record<string, unknown> = {};
  data = { ...data, ...applyCardTo(data, repo, ['owner']) };
  data = { ...data, ...applyCardTo(data, cred, ['credentialId']) };
  data = { ...data, ...detachGroup(data, 'github-repo') };

  assert.equal(cardIdOf(data, 'github-repo'), null);
  assert.equal(cardIdOf(data, 'github-cred'), cred.id, '脱钩一组不该连带脱掉另一组');
});

test('脱钩一个本就没引用的组：返回空 patch（不制造无谓更新）', () => {
  assert.deepEqual(detachGroup({ label: 'A' }, 'g'), {});
});

test('cardIdOf 对从未套用的节点返回 null', () => {
  assert.equal(cardIdOf({ owner: 'a' }, 'github-repo'), null);
  assert.equal(cardIdOf(undefined, 'g'), null);
  assert.equal(cardIdOf({ cardRefs: {} }, 'g'), null);
  assert.equal(cardIdOf({ cardRefs: { g: '' } }, 'g'), null, '空串视为未套用');
});

/* ---- shouldDetach：判断改了某个字段要不要脱钩 ---- */

test('改的字段属于该组 → 需要脱钩', () => {
  assert.equal(shouldDetach({ branch: 'dev' }, ['owner', 'repo', 'branch']), true);
});

test('改的字段不属于该组 → 不脱钩', () => {
  assert.equal(shouldDetach({ message: '新提交' }, ['owner', 'repo', 'branch']), false);
});

/*
 * 这几条守一个很隐蔽的 bug：套用 / 切换卡片时 patch 里既含字段值又含 cardRefs，
 * 若被判为"改了字段要脱钩"，脱钩会用旧 refs 覆盖掉刚设好的新引用。
 * 后果：首次套用正常，第二次切换失效（引用被清空）。
 */
test('套用卡片本身不该触发脱钩（patch 自带 cardRefs）', () => {
  assert.equal(shouldDetach({ owner: 'a', cardRefs: { g: 'pc1' } }, ['owner']), false);
});

test('切换卡片：第二次切换仍能正确挂上新引用', () => {
  const kv = memKV();
  const c1 = addParamCard({ group: 'g', name: '第一张', values: { owner: 'a' } }, kv);
  const c2 = addParamCard({ group: 'g', name: '第二张', values: { owner: 'b' } }, kv);

  let data: Record<string, unknown> = {};
  data = { ...data, ...applyCardTo(data, c1, ['owner']) };
  assert.equal(cardIdOf(data, 'g'), c1.id);

  // 关键：第二次切换。若误脱钩，cardRefs 会被清空
  const patch = applyCardTo(data, c2, ['owner']);
  const detached = shouldDetach(patch, ['owner']) ? detachGroup(data, 'g') : {};
  data = { ...data, ...patch, ...detached };

  assert.equal(cardIdOf(data, 'g'), c2.id, '切换后应指向第二张卡片');
  assert.equal(data.owner, 'b');
});

test('改 label 这类通用字段也不该脱钩', () => {
  assert.equal(shouldDetach({ label: '改名' }, ['owner', 'repo']), false);
});

/* ---- 导入导出 ---- */

test('导出再导入能还原', () => {
  const from = memKV();
  addParamCard({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv0(from));
  function kv0(k: KV) { return k; }

  const to = memKV();
  const r = importParamCards(exportParamCards(from), undefined, to);
  assert.equal(r.added, 1);
  assert.equal(loadParamCards(to)[0].name, '主仓库');
  assert.deepEqual(loadParamCards(to)[0].values, REPO_VALUES);
});

test('重复导入按 id 更新，不堆副本', () => {
  const from = memKV();
  const c = addParamCard({ group: 'g', name: 'v1', values: { a: 1 } }, from);
  const json = exportParamCards(from);

  const to = memKV();
  importParamCards(json, undefined, to);
  // 改一版再导一次
  saveParamCards([{ ...findCard(c.id, from)!, name: 'v2' }], from);
  const r2 = importParamCards(exportParamCards(from), undefined, to);

  assert.equal(r2.updated, 1);
  assert.equal(r2.added, 0);
  assert.equal(loadParamCards(to).length, 1);
  assert.equal(loadParamCards(to)[0].name, 'v2');
});

test('replace 模式清掉本机原有的', () => {
  const to = memKV();
  addParamCard({ group: 'g', name: '本机旧的', values: {} }, to);
  const from = memKV();
  addParamCard({ group: 'g', name: '导入的', values: {} }, from);

  importParamCards(exportParamCards(from), { mode: 'replace' }, to);
  assert.equal(loadParamCards(to).length, 1);
  assert.equal(loadParamCards(to)[0].name, '导入的');
});

test('导入非 JSON / 没有卡片列表都要给出可读错误', () => {
  assert.throws(() => importParamCards('不是JSON', undefined, memKV()), /JSON/);
  assert.throws(() => importParamCards('{"foo":1}', undefined, memKV()), /卡片列表/);
});
