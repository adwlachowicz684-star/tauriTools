import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addVariable, loadVariables, saveVariables, removeVariable, renameVariable,
  varsOfGroup, findVar, varIdOf, applyVarTo, detachVar, shouldDetach,
  exportVariables, importVariables, duplicateVar, checkVarForNode, patchForVar,
  registerVariableGroup, getVariableGroup, resolveVars, redirectVarPatch,
  varSnapshotOf,
  patchVariableValues, setVariableGlobal, saveVariables, LEGACY_CARDS_KEY,
  type Variable, type VariableGroupDef, type KV,
} from '../engine/variables';

function memKV() {
  const map = new Map<string, string>();
  return { map, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
}

const REPO_VALUES = { owner: 'acme', repo: 'web', branch: 'main' };

/* ---- 基础 CRUD ---- */

test('新增后能读回来', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  assert.equal(c.group, 'github-repo');
  assert.equal(c.name, '主仓库');
  assert.deepEqual(c.values, REPO_VALUES);
  assert.equal(loadVariables(kv).length, 1);
});

test('按组取卡片：只返回同组的', () => {
  const kv = memKV();
  addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  addVariable({ group: 'github-repo', name: '备用', values: { owner: 'b' } }, kv);
  addVariable({ group: 'github-cred', name: '机器人', values: { credentialId: 'c1' } }, kv);

  assert.equal(varsOfGroup('github-repo', undefined, kv).length, 2);
  assert.equal(varsOfGroup('github-cred', undefined, kv).length, 1);
  assert.equal(varsOfGroup('不存在的组', undefined, kv).length, 0);
});

test('删除只删指定那条', () => {
  const kv = memKV();
  const a = addVariable({ group: 'g', name: 'A', values: {} }, kv);
  addVariable({ group: 'g', name: 'B', values: {} }, kv);
  removeVariable(a.id, kv);
  const list = loadVariables(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'B');
});

test('改名：空名不生效', () => {
  const kv = memKV();
  const a = addVariable({ group: 'g', name: 'A', values: {} }, kv);
  renameVariable(a.id, '   ', kv);
  assert.equal(loadVariables(kv)[0].name, 'A');
  renameVariable(a.id, '  B  ', kv);
  assert.equal(loadVariables(kv)[0].name, 'B');
});

test('findVar 按 id 找；找不到返回 null', () => {
  const kv = memKV();
  const a = addVariable({ group: 'g', name: 'A', values: {} }, kv);
  assert.equal(findVar(a.id, kv)?.name, 'A');
  assert.equal(findVar('不存在', kv), null);
  assert.equal(findVar(null, kv), null);
});

/* ---- 坏数据容错 ---- */

test('坏 JSON 读出空列表，不抛异常', () => {
  const kv = memKV();
  kv.map.set(LEGACY_CARDS_KEY, '{坏掉的');
  assert.deepEqual(loadVariables(kv), []);
});

test('残缺条目被过滤，正常的保留', () => {
  const kv = memKV();
  saveVariables([
    { id: 'x', group: 'g', name: 'X', values: { a: 1 }, createdAt: 1 },
    { id: '', group: 'g', name: '缺 id', values: {} } as unknown as Variable,
    { id: 'y', group: '', name: '缺组名', values: {} } as unknown as Variable,
  ], kv);
  const list = loadVariables(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'X');
});

test('没有 localStorage 的环境（Node）也不崩', () => {
  assert.doesNotThrow(() => loadVariables());
  assert.doesNotThrow(() => addVariable({ group: 'g', name: 'x', values: {} }));
});

/* ---- 引用 ---- */

test('引用变量：记下引用，节点上不再存值', () => {
  const kv = memKV();
  const card = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  const patch = applyVarTo({ label: 'A' }, card);

  assert.deepEqual(patch.varRefs, { 'github-repo': card.id });
  /*
   * 值必须被撤掉。留着就变成"第二份值"：
   * 改了变量，一部分地方读到新值、一部分读到节点上的旧值，
   * 表现为"改了有时候生效有时候不生效" —— 最难查的那一类。
   */
  assert.equal('owner' in patch, true);
  assert.equal(patch.owner, undefined);
});

test('解析时只覆盖组里列出的字段（变量多余字段不塞进节点）', () => {
  const kv = memKV();
  registerVariableGroup({
    group: 'g-only', label: '只取两项', keys: ['owner', 'repo'],
    summary: () => '', validate: () => null,
  });
  const card = addVariable({
    group: 'g-only', name: 'C', values: { owner: 'a', repo: 'b', branch: 'c', extra: 'x' },
  }, kv);
  const data = { ...applyVarTo({}, card), label: 'A' };
  const r = resolveVars(data, kv);
  assert.equal(r.owner, 'a');
  assert.equal(r.repo, 'b');
  assert.equal(r.branch, undefined, '未列出的字段不该写进去');
  assert.equal(r.extra, undefined);
});

test('引用第二个不同组的变量时，保留第一张的引用', () => {
  const kv = memKV();
  const repo = addVariable({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  const cred = addVariable({ group: 'github-cred', name: 'C', values: { credentialId: 'c1' } }, kv);

  let data: Record<string, unknown> = { label: 'A' };
  data = { ...data, ...applyVarTo(data, repo) };
  data = { ...data, ...applyVarTo(data, cred) };

  assert.equal(varIdOf(data, 'github-repo'), repo.id);
  assert.equal(varIdOf(data, 'github-cred'), cred.id, '第一个的引用不该被覆盖掉');
});

/**
 * 这条守的是共享引用：
 * 若套用时是浅拷贝，两个节点套用同一张卡片会共享嵌套对象，
 * 改一个节点的配置，另一个跟着变 —— 不报错，极难定位。
 */
test('解析是深拷贝：两个节点引用同一变量互不干扰', () => {
  const kv = memKV();
  registerVariableGroup({
    group: 'g-nest', label: '嵌套', keys: ['cfg'],
    summary: () => '', validate: () => null,
  });
  const card = addVariable({
    group: 'g-nest', name: 'C', values: { cfg: { host: 'a.com' } },
  }, kv);

  const n1 = resolveVars({ ...applyVarTo({}, card) }, kv);
  const n2 = resolveVars({ ...applyVarTo({}, card) }, kv);

  (n1.cfg as Record<string, unknown>).host = 'b.com';
  assert.equal((n2.cfg as Record<string, unknown>).host, 'a.com', '第二个节点不该受影响');
  assert.equal((card.values.cfg as Record<string, unknown>).host, 'a.com', '变量本身也不该被改');
});

/* ---- 改变量，引用它的节点一起变 ---- */

test('改变量的值：解析后引用节点拿到新值', () => {
  const kv = memKV();
  const v = addVariable({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  const data = { ...applyVarTo({ label: 'A' }, v) };

  assert.equal(resolveVars(data, kv).repo, 'web');
  patchVariableValues(v.id, { repo: 'api' }, kv);
  assert.equal(resolveVars(data, kv).repo, 'api', '改了变量，引用的节点要跟着变');
});

test('redirectVarPatch：改命中变量组的字段 → 转投到变量，不写节点', () => {
  const kv = memKV();
  const v = addVariable({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  const data = { ...applyVarTo({ label: 'A' }, v) };

  const { nodePatch, varUpdates } = redirectVarPatch(data, { repo: 'api' });
  assert.deepEqual(nodePatch, {}, '本组字段不该再写进节点');
  assert.equal(varUpdates.length, 1);
  assert.equal(varUpdates[0].id, v.id);
  assert.deepEqual(varUpdates[0].patch, { repo: 'api' });
});

test('redirectVarPatch：改无关字段照旧写节点', () => {
  const kv = memKV();
  const v = addVariable({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  const data = { ...applyVarTo({ label: 'A' }, v) };

  const { nodePatch, varUpdates } = redirectVarPatch(data, { label: 'B', repo: 'api' });
  assert.deepEqual(nodePatch, { label: 'B' });
  assert.equal(varUpdates.length, 1);
});

/*
 * 挡住自我改写：引用 / 切换变量时 patch 里同时含 varRefs 与"置空"，
 * 若不挡，那些置空会被当成"用户把值删了"反向写进变量 ——
 * 于是点一下切换，变量内容就被清空了。
 */
test('redirectVarPatch：自带 varRefs 时不转投（切换变量不会清空它）', () => {
  const v = addVariable({ group: 'github-repo', name: 'R', values: REPO_VALUES }, memKV());
  const { varUpdates } = redirectVarPatch({}, { repo: undefined, varRefs: { 'github-repo': v.id } });
  assert.equal(varUpdates.length, 0);
});

/* ---- 作用域 ---- */

test('画布级变量只在自己的画布里可见', () => {
  const kv = memKV();
  addVariable({ group: 'g', name: 'A画布的', values: {}, canvasId: 'cA' }, kv);
  addVariable({ group: 'g', name: 'B画布的', values: {}, canvasId: 'cB' }, kv);

  assert.equal(varsOfGroup('g', 'cA', kv).length, 1);
  assert.equal(varsOfGroup('g', 'cA', kv)[0].name, 'A画布的');
  assert.equal(varsOfGroup('g', 'cB', kv).length, 1);
  assert.equal(varsOfGroup('g', undefined, kv).length, 0, '拿不到画布上下文时不该把别张画布的混进来');
});

test('全局变量在任何画布都可见', () => {
  const kv = memKV();
  const v = addVariable({ group: 'g', name: '全局的', values: {}, global: true }, kv);
  assert.equal(varsOfGroup('g', 'cA', kv).length, 1);
  assert.equal(varsOfGroup('g', 'cB', kv).length, 1);

  setVariableGlobal(v.id, false, 'cA', kv);
  assert.equal(varsOfGroup('g', 'cA', kv).length, 1, '改回画布级后仍在本画布可见');
  assert.equal(varsOfGroup('g', 'cB', kv).length, 0);
});

test('老数据（没有 global / canvasId）按全局处理，引用不断', () => {
  const kv = memKV();
  kv.map.set(LEGACY_CARDS_KEY, JSON.stringify({
    version: 1,
    cards: [{ id: 'old1', group: 'g', name: '老变量', values: { a: 1 }, createdAt: 1 }],
  }));
  const list = loadVariables(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].global, true, '老数据当初就是全局可见的，不能因为改名就看不见');
  assert.equal(varsOfGroup('g', '任意画布', kv).length, 1);
});

test('迁移只做一次：删空之后旧数据不会复活', () => {
  const kv = memKV();
  kv.map.set(LEGACY_CARDS_KEY, JSON.stringify({
    version: 1,
    cards: [{ id: 'old1', group: 'g', name: '老变量', values: {}, createdAt: 1 }],
  }));
  assert.equal(loadVariables(kv).length, 1);
  saveVariables([], kv);
  assert.equal(loadVariables(kv).length, 0, '删空就是删空，不该被旧存储复活');
});

/* ---- 脱离 ---- */

test('脱离：把当前值拷到节点上，引用移除', () => {
  const kv = memKV();
  const card = addVariable({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  let data: Record<string, unknown> = { ...applyVarTo({}, card) };

  assert.equal(varIdOf(data, 'github-repo'), card.id);
  data = { ...data, ...detachVar(data, 'github-repo', kv) };

  assert.equal(varIdOf(data, 'github-repo'), null);
  /*
   * 脱离必须**带着值**走：拷 undefined 等于把填好的内容清空，
   * 而用户点脱离是想"保留现在的值、只是不再跟随"。
   */
  assert.equal(data.owner, 'acme');
  assert.equal(data.repo, 'web');
  // 之后改变量，这个节点不再跟着变
  patchVariableValues(card.id, { repo: 'api' }, kv);
  assert.equal(data.repo, 'web');
});

test('脱离不影响其它组的引用', () => {
  const kv = memKV();
  const repo = addVariable({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  const cred = addVariable({ group: 'github-cred', name: 'C', values: { credentialId: 'c1' } }, kv);

  let data: Record<string, unknown> = {};
  data = { ...data, ...applyVarTo(data, repo) };
  data = { ...data, ...applyVarTo(data, cred) };
  data = { ...data, ...detachVar(data, 'github-repo', kv) };

  assert.equal(varIdOf(data, 'github-repo'), null);
  assert.equal(varIdOf(data, 'github-cred'), cred.id, '脱离一组不该连带脱离另一组');
});

test('脱离一个本就没引用的组：返回空 patch（不制造无谓更新）', () => {
  assert.deepEqual(detachVar({ label: 'A' }, 'g'), {});
});

test('varIdOf 对从未引用的节点返回 null', () => {
  assert.equal(varIdOf({ owner: 'a' }, 'github-repo'), null);
  assert.equal(varIdOf(undefined, 'g'), null);
  assert.equal(varIdOf({ varRefs: {} }, 'g'), null);
  assert.equal(varIdOf({ varRefs: { g: '' } }, 'g'), null, '空串视为未引用');
});

/* ---- shouldDetach：判断改了某个字段要不要脱离 ---- */

test('改的字段属于该组 → 需要脱离', () => {
  assert.equal(shouldDetach({ branch: 'dev' }, ['owner', 'repo', 'branch']), true);
});

test('改的字段不属于该组 → 不脱离', () => {
  assert.equal(shouldDetach({ message: '新提交' }, ['owner', 'repo', 'branch']), false);
});

/*
 * 这几条守一个很隐蔽的 bug：套用 / 切换卡片时 patch 里既含字段值又含 varRefs，
 * 若被判为"改了字段要脱钩"，脱钩会用旧 refs 覆盖掉刚设好的新引用。
 * 后果：首次套用正常，第二次切换失效（引用被清空）。
 */
test('引用变量本身不该触发脱离（patch 自带 varRefs）', () => {
  assert.equal(shouldDetach({ owner: 'a', varRefs: { g: 'pc1' } }, ['owner']), false);
});

test('切换变量：第二次切换仍能正确挂上新引用', () => {
  const kv = memKV();
  const c1 = addVariable({ group: 'g', name: '第一张', values: { owner: 'a' } }, kv);
  const c2 = addVariable({ group: 'g', name: '第二张', values: { owner: 'b' } }, kv);

  let data: Record<string, unknown> = {};
  data = { ...data, ...applyVarTo(data, c1) };
  assert.equal(varIdOf(data, 'g'), c1.id);

  // 关键：第二次切换。若误脱离，varRefs 会被清空
  const patch = applyVarTo(data, c2);
  const detached = shouldDetach(patch, ['owner']) ? detachVar(data, 'g', kv) : {};
  data = { ...data, ...patch, ...detached };

  assert.equal(varIdOf(data, 'g'), c2.id, '切换后应指向第二个变量');
  assert.equal(resolveVars(data, kv).owner, 'b');
});

test('改 label 这类通用字段也不该脱离', () => {
  assert.equal(shouldDetach({ label: '改名' }, ['owner', 'repo']), false);
});

/* ---- 导入导出 ---- */

test('导出再导入能还原', () => {
  const from = memKV();
  addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv0(from));
  function kv0(k: KV) { return k; }

  const to = memKV();
  const r = importVariables(exportVariables(from), undefined, to);
  assert.equal(r.added, 1);
  assert.equal(loadVariables(to)[0].name, '主仓库');
  assert.deepEqual(loadVariables(to)[0].values, REPO_VALUES);
});

test('重复导入按 id 更新，不堆副本', () => {
  const from = memKV();
  const c = addVariable({ group: 'g', name: 'v1', values: { a: 1 } }, from);
  const json = exportVariables(from);

  const to = memKV();
  importVariables(json, undefined, to);
  // 改一版再导一次
  saveVariables([{ ...findVar(c.id, from)!, name: 'v2' }], from);
  const r2 = importVariables(exportVariables(from), undefined, to);

  assert.equal(r2.updated, 1);
  assert.equal(r2.added, 0);
  assert.equal(loadVariables(to).length, 1);
  assert.equal(loadVariables(to)[0].name, 'v2');
});

test('replace 模式清掉本机原有的', () => {
  const to = memKV();
  addVariable({ group: 'g', name: '本机旧的', values: {} }, to);
  const from = memKV();
  addVariable({ group: 'g', name: '导入的', values: {} }, from);

  importVariables(exportVariables(from), { mode: 'replace' }, to);
  assert.equal(loadVariables(to).length, 1);
  assert.equal(loadVariables(to)[0].name, '导入的');
});

test('导入非 JSON / 没有变量列表都要给出可读错误', () => {
  assert.throws(() => importVariables('不是JSON', undefined, memKV()), /JSON/);
  assert.throws(() => importVariables('{"foo":1}', undefined, memKV()), /变量列表/);
});

/* ================= 变量组定义（通用化的基础） ================= */

const REPO_GROUP: VariableGroupDef = {
  group: 'github-repo',
  label: '地址变量',
  keys: ['owner', 'repo', 'branch'],
  summary: (v) => `${String(v.owner ?? '')}/${String(v.repo ?? '')}`,
  validate: (v) => (String(v.repo ?? '').trim() ? null : '没填仓库名'),
};
const HTTP_GROUP: VariableGroupDef = {
  group: 'http-endpoint',
  label: '接口变量',
  keys: ['url', 'method'],
  summary: (v) => String(v.url ?? ''),
  validate: (v) => (String(v.url ?? '').trim() ? null : '没填地址'),
};

registerVariableGroup(REPO_GROUP);
registerVariableGroup(HTTP_GROUP);

test('组注册后能查到；未注册的组返回 null', () => {
  assert.equal(getVariableGroup('github-repo')?.label, '地址变量');
  assert.equal(getVariableGroup('不存在的组'), null);
});

/* ================= 复制变量（Ctrl + 拖动） ================= */

test('复制变量：新 id、名字带副本后缀', () => {
  const kv = memKV();
  const a = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  const copy = duplicateVar(a.id, kv);

  assert.ok(copy);
  assert.notEqual(copy!.id, a.id);
  assert.equal(copy!.name, '主仓库 副本');
  assert.deepEqual(copy!.values, REPO_VALUES);
});

test('复制出来的卡片紧挨着原件（好找，不是丢到末尾）', () => {
  const kv = memKV();
  const a = addVariable({ group: 'g', name: 'A', values: {} }, kv);
  addVariable({ group: 'g', name: 'B', values: {} }, kv);
  const copy = duplicateVar(a.id, kv);

  const list = loadVariables(kv);
  assert.equal(list.length, 3);
  assert.equal(list[1].id, copy!.id, '副本应插在原件之后');
});

test('复制的卡片是深拷贝：改副本不动原件', () => {
  const kv = memKV();
  const a = addVariable({ group: 'g', name: 'A', values: { cfg: { host: 'a' } } }, kv);
  const copy = duplicateVar(a.id, kv);

  (copy!.values.cfg as Record<string, unknown>).host = 'b';
  const orig = findVar(a.id, kv)!;
  assert.equal((orig.values.cfg as Record<string, unknown>).host, 'a');
});

test('复制不存在的卡片返回 null，不抛异常', () => {
  assert.equal(duplicateVar('不存在', memKV()), null);
});

/* ================= 类型验证：卡片能否套到某类节点 ================= */

test('节点声明支持该组 → 通过', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  assert.equal(checkVarForNode(c, ['github-repo'], kv).ok, true);
});

test('节点不声明该组 → 拒绝，并说明是哪一类变量用不上', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  const r = checkVarForNode(c, ['http-endpoint'], kv);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /地址变量/, '要说出是哪一类变量');
});

test('节点完全不声明卡片组 → 拒绝', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: 'R', values: REPO_VALUES }, kv);
  assert.equal(checkVarForNode(c, undefined, kv).ok, false);
});

test('组未注册 → 拒绝（没有 keys 无从套用）', () => {
  const kv = memKV();
  const c = addVariable({ group: '野组', name: 'X', values: { a: 1 } }, kv);
  const r = checkVarForNode(c, ['野组'], kv);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /未注册/);
});

test('值不合法 → 拒绝（挡住"看着能拖、套上去是空的"）', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: '空仓库', values: { owner: 'a', repo: '' } }, kv);
  const r = checkVarForNode(c, ['github-repo'], kv);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /仓库名/);
});

test('patchForVar 记下引用，并把本组字段清空（值不再存节点上）', () => {
  const kv = memKV();
  const c = addVariable({
    group: 'github-repo', name: 'C', values: { owner: 'a', repo: 'b', extra: 'x' },
  }, kv);
  const patch = patchForVar(c);
  assert.deepEqual(patch.varRefs, { 'github-repo': c.id });
  assert.equal(patch.owner, undefined, '引用期间节点上不存值');
  assert.equal(patch.extra, undefined, '变量里多余的字段也不该冒出来');
});

test('patchForVar 对未注册的组返回空（不制造脏数据）', () => {
  const kv = memKV();
  const c = addVariable({ group: '野组', name: 'X', values: { a: 1 } }, kv);
  assert.deepEqual(patchForVar(c), {});
});


/* ================= 老字段 cardRefs ================= */
/*
 * "参数卡片"时期引用存在 data.cardRefs 里，改名后写的是 varRefs。
 * 老画布里那些**升级之前就套好**的节点只有 cardRefs ——
 * 读不到它们的后果不是"显示少一点"，而是参数全空：
 * 引用期间值根本不在节点上，引用再读不到就两边都没有。
 *
 * 这里踩过一次真 bug：改名时把 `d.varRefs ?? d.cardRefs` 一起改成了
 * `d.varRefs ?? d.varRefs`（两边同名，等价于只认新名）。
 * 测试没抓到是因为测试数据都是当场新建的，没有老字段的样本。
 */
test('老画布的 cardRefs 引用照样认（改名不该让已有引用断掉）', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  assert.equal(varIdOf({ cardRefs: { 'github-repo': c.id } }, 'github-repo'), c.id);
});

test('老字段引用照样能解析出值', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  const d = resolveVars({ cardRefs: { 'github-repo': c.id } }, kv);
  assert.equal(d.owner, 'acme');
  assert.equal(d.repo, 'web');
});

test('redirectVarPatch：patch 里带 cardRefs 也算调用方在管引用（不转投）', () => {
  const { varUpdates } = redirectVarPatch({}, { repo: undefined, cardRefs: { 'github-repo': 'pc1' } });
  assert.deepEqual(varUpdates, [], '自带引用标记时改字段不该写进变量');
});

test('shouldDetach：patch 里带 cardRefs 不算手改字段', () => {
  assert.equal(shouldDetach({ owner: 'a', cardRefs: { g: 'pc1' } }, ['owner']), false);
});

/* ================= 变量快照（给流程图用） ================= */

test('varSnapshotOf：摊成名字 + 摘要', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  const snap = varSnapshotOf({ varRefs: { 'github-repo': c.id } }, kv);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].name, '主仓库');
  assert.ok(snap[0].summary.length > 0, '摘要不该是空的');
});

test('varSnapshotOf：没引用的节点返回空数组（不制造 undefined）', () => {
  assert.deepEqual(varSnapshotOf({}), []);
  assert.deepEqual(varSnapshotOf({ varRefs: {} }), []);
});

test('varSnapshotOf：变量被删了就跳过，不留空壳', () => {
  const kv = memKV();
  const c = addVariable({ group: 'github-repo', name: '主仓库', values: REPO_VALUES }, kv);
  const data = { varRefs: { 'github-repo': c.id } };
  removeVariable(c.id, kv);
  assert.deepEqual(varSnapshotOf(data, kv), []);
});
