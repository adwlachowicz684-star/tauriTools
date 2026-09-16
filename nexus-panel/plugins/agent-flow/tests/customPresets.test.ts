import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeForPreset, addCustomPreset, removeCustomPreset, renameCustomPreset,
  loadCustomPresets, saveCustomPresets, exportCustomPresets, importCustomPresets,
  presetKey, presetIdOf, dataOf, type CustomPreset, type KV,
} from '../engine/customPresets';

/** 内存版存储，避免测试依赖 localStorage（Node 里没有） */
function memKV() {
  const map = new Map<string, string>();
  return {
    map,
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
  };
}

const HTTP_DATA = {
  label: '查天气',
  status: 'success',
  output: '{"temp":26}',
  error: '上一次的报错',
  url: 'https://api.test/weather',
  method: 'GET',
  lastFiredAt: 123456,
  lastResult: 'success' as const,
};

/* ---- 剥离运行时状态 ---- */

test('存为预设时剥掉 status / output / error', () => {
  const s = sanitizeForPreset(HTTP_DATA);
  assert.equal(s.status, undefined);
  assert.equal(s.output, undefined);
  assert.equal(s.error, undefined);
});

test('存为预设时剥掉所有 last* 字段', () => {
  const s = sanitizeForPreset(HTTP_DATA);
  assert.equal(s.lastFiredAt, undefined);
  assert.equal(s.lastResult, undefined);
});

test('配置字段要完整保留', () => {
  const s = sanitizeForPreset(HTTP_DATA);
  assert.equal(s.url, 'https://api.test/weather');
  assert.equal(s.method, 'GET');
  assert.equal(s.label, '查天气');
});

test('剥掉运行时状态后不再带 status（否则新节点一拖出来就是"已成功"）', () => {
  const kv = memKV();
  const p = addCustomPreset({ name: '天气', baseType: 'generic-http', data: HTTP_DATA }, kv);
  assert.equal(p.data.status, undefined, '存进去的 status 会让每个新实例都显示已跑完');
  assert.equal(p.data.url, 'https://api.test/weather');
});

/* ---- 增删改 ---- */

test('新增后能读回来', () => {
  const kv = memKV();
  addCustomPreset({ name: '天气', baseType: 'generic-http', data: { url: 'https://a' } }, kv);
  const list = loadCustomPresets(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '天气');
  assert.equal(list[0].baseType, 'generic-http');
});

test('删除只删指定的那条', () => {
  const kv = memKV();
  const a = addCustomPreset({ name: 'A', baseType: 'generic-http', data: {} }, kv);
  addCustomPreset({ name: 'B', baseType: 'extract', data: {} }, kv);
  removeCustomPreset(a.id, kv);
  const list = loadCustomPresets(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'B');
});

test('改名：空名不生效（否则侧栏出现无法辨认的空白条目）', () => {
  const kv = memKV();
  const a = addCustomPreset({ name: 'A', baseType: 'generic-http', data: {} }, kv);
  renameCustomPreset(a.id, '   ', kv);
  assert.equal(loadCustomPresets(kv)[0].name, 'A');
  renameCustomPreset(a.id, '  B  ', kv);
  assert.equal(loadCustomPresets(kv)[0].name, 'B', '应去掉首尾空格');
});

test('没填名字时回退成「未命名节点」', () => {
  const kv = memKV();
  const p = addCustomPreset({ name: '  ', baseType: 'generic-http', data: {} }, kv);
  assert.equal(p.name, '未命名节点');
});

/* ---- 坏数据容错 ---- */

test('存储里是坏 JSON 时读出空列表，不抛异常', () => {
  const kv = memKV();
  kv.map.set('agent-flow.customPresets.v1', '{不是 JSON');
  assert.deepEqual(loadCustomPresets(kv), []);
});

test('列表里混有残缺条目时过滤掉，保留正常的', () => {
  const kv = memKV();
  saveCustomPresets([
    { id: 'x', name: 'X', baseType: 'generic-http', data: { url: 'u' }, createdAt: 1 },
    { id: '', name: '缺 id', baseType: 'generic-http', data: {} } as unknown as CustomPreset,
    { name: '缺 id 字段', baseType: 'generic-http', data: {} } as unknown as CustomPreset,
  ], kv);
  const list = loadCustomPresets(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'X');
});

test('没有 localStorage 的环境（如 Node）也不崩', () => {
  // 不给 kv，走默认的 localStorage 分支；Node 里 typeof localStorage === 'undefined'
  assert.doesNotThrow(() => loadCustomPresets());
  assert.doesNotThrow(() => addCustomPreset({ name: 'x', baseType: 'generic-http', data: {} }));
});

/* ---- key 与数据 ---- */

test('presetKey / presetIdOf 互为逆运算', () => {
  assert.equal(presetKey('abc'), 'custom:abc');
  assert.equal(presetIdOf('custom:abc'), 'abc');
});

test('presetIdOf 对内置预设返回 null', () => {
  assert.equal(presetIdOf('task'), null);
  assert.equal(presetIdOf('task:codebuddy'), null);
});

test('dataOf 每次返回新对象（多个实例不能共享同一份）', () => {
  const p: CustomPreset = {
    id: 'a', name: 'A', baseType: 'generic-http', data: { url: 'u' }, createdAt: 1,
  };
  const one = dataOf(p) as unknown as Record<string, unknown>;
  const two = dataOf(p) as unknown as Record<string, unknown>;
  assert.notEqual(one, two);
  one.url = '改过了';
  assert.equal(p.data.url, 'u', '改实例不该污染预设本身');
});

/* ---- 跨环境分享 ---- */

test('导出再导入能还原（新增模式）', () => {
  const from = memKV();
  addCustomPreset({ name: '天气', baseType: 'generic-http', data: { url: 'https://a' } }, from);
  addCustomPreset({ name: '取标题', baseType: 'extract', data: { mode: 'json' } }, from);

  const to = memKV();
  const r = importCustomPresets(exportCustomPresets(from), {
    isKnownType: (t) => t === 'generic-http' || t === 'extract',
  }, to);

  assert.equal(r.added, 2);
  assert.equal(r.updated, 0);
  const list = loadCustomPresets(to);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, '天气');
  assert.equal(list[1].data.mode, 'json');
});

test('导入时基础节点不存在则跳过并说明原因（不是静默丢掉）', () => {
  const from = memKV();
  addCustomPreset({ name: '天气', baseType: 'generic-http', data: {} }, from);
  addCustomPreset({ name: '外星接口', baseType: 'alien-node', data: {} }, from);

  const to = memKV();
  const r = importCustomPresets(exportCustomPresets(from), {
    // 本机只认 generic-http
    isKnownType: (t) => t === 'generic-http',
  }, to);

  assert.equal(r.added, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /外星接口/);
  assert.match(r.skipped[0], /alien-node/, '要写明缺的是哪种基础节点');
  assert.equal(loadCustomPresets(to).length, 1);
});

test('重复导入同一份按 id 更新，不堆副本', () => {
  const from = memKV();
  addCustomPreset({ name: '天气', baseType: 'generic-http', data: { url: 'v1' } }, from);
  const json = exportCustomPresets(from);

  const to = memKV();
  const first = importCustomPresets(json, { isKnownType: () => true }, to);
  assert.equal(first.added, 1);

  // 改一版再导一次
  const from2 = memKV();
  const p = loadCustomPresets(from)[0];
  saveCustomPresets([{ ...p, data: { url: 'v2' } }], from2);
  const second = importCustomPresets(exportCustomPresets(from2), { isKnownType: () => true }, to);

  assert.equal(second.updated, 1);
  assert.equal(second.added, 0);
  assert.equal(loadCustomPresets(to).length, 1, '不该变成两条');
  assert.equal(loadCustomPresets(to)[0].data.url, 'v2');
});

test('replace 模式会清掉本机原有的', () => {
  const to = memKV();
  addCustomPreset({ name: '本机旧的', baseType: 'generic-http', data: {} }, to);

  const from = memKV();
  addCustomPreset({ name: '导入的', baseType: 'generic-http', data: {} }, from);

  importCustomPresets(exportCustomPresets(from), { isKnownType: () => true, mode: 'replace' }, to);
  const list = loadCustomPresets(to);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '导入的');
});

test('导入非 JSON 要给出可读的错误', () => {
  assert.throws(() => importCustomPresets('不是 JSON', { isKnownType: () => true }, memKV()),
    /JSON/);
});

test('导入没有预设列表的文件要报错，而不是当空处理', () => {
  assert.throws(
    () => importCustomPresets('{"foo":1}', { isKnownType: () => true }, memKV()),
    /预设列表/,
  );
});
