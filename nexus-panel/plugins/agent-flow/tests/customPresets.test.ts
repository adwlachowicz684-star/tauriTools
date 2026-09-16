import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeForPreset, hadInlineSecret, addCustomPreset, removeCustomPreset, renameCustomPreset,
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

/* ---- 内联密钥脱敏 ---- */
/*
 * 预设存在明文 localStorage 里，而画布的密钥走的是加密保险箱。
 * 不脱敏等于新开一处比既有保护更弱的明文密钥存放地，
 * 导出成 JSON 分享时更是直接把令牌交出去。
 */

test('剥掉 GitHub 节点的内联令牌', () => {
  const s = sanitizeForPreset({ label: 'A', owner: 'o', repo: 'r', token: 'ghp_xxx' });
  assert.equal(s.token, '');
  assert.equal(s.owner, 'o', '非密钥字段要保留');
});

test('剥掉大模型密钥（llm.apiKey 嵌套字段）', () => {
  const s = sanitizeForPreset({ label: 'OCR', llm: { provider: 'openai', apiKey: 'sk-xxx' } });
  const llm = s.llm as Record<string, unknown>;
  assert.equal(llm.apiKey, '');
  assert.equal(llm.provider, 'openai', '同层的其它字段要保留');
});

test('剥掉 webhook 校验令牌（config.token）', () => {
  const s = sanitizeForPreset({ label: 'T', config: { port: 9000, token: 'abc' } });
  const cfg = s.config as Record<string, unknown>;
  assert.equal(cfg.token, '');
  assert.equal(cfg.port, 9000);
});

test('凭据引用要保留（这是推荐的用法，必须能随预设复用）', () => {
  const s = sanitizeForPreset({ label: 'A', credentialId: 'cred-1', token: '' });
  assert.equal(s.credentialId, 'cred-1');
});

test('hadInlineSecret 能识别出各类内联密钥', () => {
  assert.equal(hadInlineSecret({ token: 'ghp_x' }), true);
  assert.equal(hadInlineSecret({ llm: { apiKey: 'sk-x' } }), true);
  assert.equal(hadInlineSecret({ config: { token: 'x' } }), true);
  assert.equal(hadInlineSecret({ token: '' }), false, '空串不算');
  assert.equal(hadInlineSecret({ credentialId: 'c1' }), false, '凭据引用不算');
  assert.equal(hadInlineSecret(null), false);
  assert.equal(hadInlineSecret({ llm: null }), false, '嵌套为 null 不该崩');
});

test('导出时再脱一道敏（老数据可能还带着令牌）', () => {
  const kv = memKV();
  // 模拟本次改动之前存下的老数据：直接写进去，绕过保存时的剥除
  saveCustomPresets([{
    id: 'old', name: '旧的', baseType: 'github-push',
    data: { label: '旧', owner: 'o', token: 'ghp_leak' }, createdAt: 1,
  }], kv);

  const exported = JSON.parse(exportCustomPresets(kv));
  assert.equal(exported.presets[0].data.token, '', '导出是交给别人的动作，必须兜住');
  assert.equal(exported.presets[0].data.owner, 'o');
});

test('存成预设后不再含内联令牌', () => {
  const kv = memKV();
  const p = addCustomPreset({
    name: '推送', baseType: 'github-push',
    data: { label: 'P', owner: 'o', token: 'ghp_xxx' },
  }, kv);
  assert.equal(p.data.token, '');
  assert.equal(p.data.owner, 'o');
});

/**
 * 这条守的是一个隐蔽 bug：dataOf 若只展开一层（浅拷贝），
 * 从同一预设拖出的所有节点会共享 llm / config / rules 等嵌套对象。
 * 表现为"改了一个节点的配置，其它节点也跟着变"，且不报任何错。
 * 与 duplicate 的 cloneData 必须是同一套口径。
 */
test('dataOf 是深拷贝：改一个实例不改到预设本身', () => {
  const p: CustomPreset = {
    id: 'a', name: 'A', baseType: 'ocr',
    data: { label: 'A', llm: { provider: 'openai', apiKey: '' } },
    createdAt: 1,
  };
  const one = dataOf(p) as unknown as Record<string, unknown>;
  (one.llm as Record<string, unknown>).provider = 'deepseek';
  assert.equal(
    (p.data.llm as Record<string, unknown>).provider,
    'openai',
    '预设本身不该被实例改动污染',
  );
});

test('dataOf 是深拷贝：两个实例互不干扰', () => {
  const p: CustomPreset = {
    id: 'a', name: 'A', baseType: 'ocr',
    data: { label: 'A', llm: { provider: 'openai' } },
    createdAt: 1,
  };
  const one = dataOf(p) as unknown as Record<string, unknown>;
  const two = dataOf(p) as unknown as Record<string, unknown>;
  (one.llm as Record<string, unknown>).provider = 'deepseek';
  assert.equal(
    (two.llm as Record<string, unknown>).provider,
    'openai',
    '拖出的第二个实例不该受第一个影响',
  );
});

test('dataOf 是深拷贝：数组类配置（如条件规则）同样独立', () => {
  const p: CustomPreset = {
    id: 'a', name: 'A', baseType: 'condition',
    data: { label: 'A', rules: [{ id: 'r1', op: 'eq' }] },
    createdAt: 1,
  };
  const one = dataOf(p) as unknown as Record<string, unknown>;
  (one.rules as Array<Record<string, unknown>>).push({ id: 'r2' });
  const two = dataOf(p) as unknown as Record<string, unknown>;
  assert.equal((two.rules as unknown[]).length, 1);
});
