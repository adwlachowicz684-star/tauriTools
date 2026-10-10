import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeForPreset, addCustomPreset, removeCustomPreset, renameCustomPreset,
  loadCustomPresets, saveCustomPresets, exportCustomPresets, importCustomPresets,
  presetKey, presetIdOf, dataOf, type CustomPreset, type KV,
} from '../engine/customPresets';
import { hadInlineSecret } from '../engine/sanitize';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/* ================================================================ */
/* 侧栏入口：自定义预设不得绕过 legacy 跳过                          */
/* ================================================================ */

/*
 * 为什么是源码级检查：registry.tsx 含 JSX，本项目的测试链路只做类型剥离、
 * 不转 JSX，Node 加载不了，于是没法真跑 allPresets()。
 * 退而求其次盯源码形态（与 inspectorRemount.test.ts 同一套做法）。
 *
 * allPresets() 里有两条产出预设的路，而 legacy 的规矩必须两条都守：
 *   1. 内置 def —— `if (def.meta.legacy) continue;`
 *   2. 自定义预设 —— 以前只有 `if (!hasDef(cp.baseType)) continue;`
 *
 * 漏了第 2 条的后果：基于老类型（play-audio / ocr / translate / bili /
 * wechat / github-update）存的自定义预设会绕过跳过，重新出现在侧栏里。
 * 标 legacy 的意思正是"已并入另一个节点，不再推荐拖"。
 */
test('自定义预设也要跳过 legacy 基础类型（否则老节点绕回侧栏）', () => {
  const SRC = process.env.AF_SRC;
  assert.ok(SRC, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
  const src = readFileSync(join(SRC, 'nodes/registry.tsx'), 'utf8');
  const at = src.indexOf('export function allPresets');
  assert.ok(at > 0, '没找到 allPresets');
  const body = src.slice(at, src.indexOf('export function presetsByCategory', at));

  const customAt = body.indexOf('loadCustomPresets()');
  assert.ok(customAt > 0, 'allPresets 里没看到自定义预设那段');
  const seg = body.slice(customAt);
  /*
   * 判据现在统一走 canPresetOn（导入 / 存为自定义也用它，三处同一条），
   * 所以这里认两种写法：直接查 meta.legacy，或调 canPresetOn。
   * 只认前者的话，把判据收进公共函数这种正确改法反而会被判红 ——
   * 而守卫报红时人会照着它把对的改成错的。
   */
  assert.ok(
    /meta\.legacy/.test(seg) || /canPresetOn/.test(seg),
    '自定义预设那段只查了 hasDef、没判 legacy —— ' +
      '基于老类型存的预设会绕过跳过回到侧栏，而 legacy 的意思正是"已并入别的节点，不再推荐拖"。',
  );

  /*
   * 若走的是 canPresetOn，它**自己**必须真的判 legacy ——
   * 否则"调用了一个听起来对的函数"也会让这条通过，而函数里只查了 hasDef。
   */
  if (/canPresetOn/.test(seg)) {
    const defAt = src.indexOf('export function canPresetOn');
    assert.ok(defAt > 0, '调了 canPresetOn 但找不到它的定义');
    const defBody = src.slice(defAt, defAt + 700);
    assert.match(
      defBody,
      /meta\.legacy/,
      'canPresetOn 只查了 hasDef、没判 legacy —— 三处入口共用它，' +
        '漏了这条就等于导入与「存为自定义」都放行老类型。',
    );
  }
});

/* ================================================================ */
/* 拖出来时必须铺一遍基础类型的默认值                                */
/* ================================================================ */

/*
 * 预设存的是**剥离过运行时状态的配置** —— 只有用户当时改过的键。
 * 基础类型后来新增的字段一律不在里面。
 *
 * 若 init 只用 dataOf(cp)（= 预设 data 的深拷贝），拖出来的节点 data 缺字段：
 *   · update 缺 targets —— 面板靠 targetsOf() 合成一张卡，看着有卡但没有
 *     下标可写，一改就掉
 *   · 缺 timeoutSec / outputFormat / userAgent / firstRunAsUpdate
 *   · 缺 status（undefined 而不是 'idle'）、缺 kind（isUpdate 认不出）
 *
 * 与 duplicate.ts 复制节点同一条契约：「def.create 铺默认 → 叠配置」。
 *
 * 为什么是源码级检查：registry.tsx 含 JSX，测试链路只做类型剥离、不转 JSX，
 * Node 加载不了，没法真跑 allPresets().find(...).init()。
 */
test('自定义预设的 init 必须走 def.create 铺默认值（只用 dataOf 会缺字段）', () => {
  const SRC = process.env.AF_SRC;
  assert.ok(SRC, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
  const src = readFileSync(join(SRC, 'nodes/registry.tsx'), 'utf8');
  const at = src.indexOf('export function allPresets');
  assert.ok(at > 0, '没找到 allPresets');
  const body = src.slice(at, src.indexOf('export function presetsByCategory', at));

  const m = body.match(/init:\s*\([^)]*\)\s*=>\s*([^\n]+)/g);
  assert.ok(m && m.length > 0, 'allPresets 里没找到 init');
  const customInit = m.filter((s) => s.includes('dataOf'));
  assert.equal(customInit.length, 1, '应恰好有一处自定义预设的 init 用到 dataOf');
  assert.match(
    customInit[0],
    /create\(/,
    '自定义预设的 init 只用了 dataOf —— 预设 data 是剥过运行时状态的配置，' +
      '基础类型后来新增的字段都不在里面（update 会缺 targets，面板看着有卡但没有下标可写）。' +
      '必须走 def.create(id, dataOf(cp)) 铺一遍默认值。',
  );
});

/* ================================================================ */
/* 导入也要剥：内联密钥 + 运行时状态                                  */
/* ================================================================ */

/*
 * 导入的文件不受我们控制 —— 可能是手改的，也可能是"存预设要脱敏"这条
 * 规矩立下之前导出的老数据。入库前必须剥一遍，否则留两个洞：
 *
 *   · 内联密钥：预设是明文 localStorage，而画布密钥走加密保险箱。
 *     带 token 进来 = 新开一处明文密钥存放地（比既有的保护还弱）。
 *     实测：不剥的话落库后 token 原样在，只有**再导出时**才被剥掉 ——
 *     本地那份明文一直在。
 *
 *   · 运行时状态：拖出来的实例一落地就显示"已成功"，看上去已经跑完了；
 *     而 lastSeenId 是"有无更新"的基线，带别人的基线进来基准整个错位。
 *
 * 与 exportCustomPresets 同一个 sanitizeForPreset，不另写一份。
 */
test('导入时剥掉内联密钥（否则在 localStorage 里新开一处明文存放地）', () => {
  const kv = memKV();
  const json = JSON.stringify({
    version: 1,
    presets: [{
      id: 'p1', name: '推送', baseType: 'github-push', createdAt: 0,
      data: { label: '推送', token: 'ghp_明文令牌', credentialId: '', owner: 'a', repo: 'b' },
    }],
  });
  const r = importCustomPresets(json, { isKnownType: () => true }, kv);
  assert.equal(r.added, 1);
  const stored = loadCustomPresets(kv)[0];
  /*
   * 脱敏的口径是**置空**而不是删键（sanitize.ts 的 stripSecrets）：
   * 面板上要给这个框留个位置，删了键反而要到处补默认值。
   * 所以判"值是不是空的"，不判"键在不在" ——
   * 判键在不在的话，置空这种正确实现会一直红，
   * 而人照着红去改，就会把置空改成删键、连带弄坏默认值那一套。
   */
  assert.equal(stored.data.token, '', '导入后预设里不该还留着内联令牌');
  // 连接引用（走加密保险箱的那种）不受影响，否则"配好连接再分享"就用不了了
  assert.equal(stored.data.credentialId, '');
  assert.equal(stored.data.owner, 'a', '配置字段要完整保留');
});

test('导入时剥掉运行时状态（否则拖出来就显示"已成功"）', () => {
  const kv = memKV();
  const json = JSON.stringify({
    version: 1,
    presets: [{
      id: 'p2', name: '盯B站', baseType: 'update', createdAt: 0,
      data: {
        label: '盯B站', source: 'bilibili',
        status: 'success', output: 'true', error: '',
        lastSeenId: 'BV1', lastCheckedAt: 1, lastUpdated: true,
      },
    }],
  });
  importCustomPresets(json, { isKnownType: () => true }, kv);
  const d = loadCustomPresets(kv)[0].data;
  assert.ok(!('status' in d), '不该带 status');
  assert.ok(!('output' in d), '不该带 output');
  assert.ok(!('error' in d), '不该带 error');
  assert.ok(!('lastSeenId' in d), '不该带 lastSeenId（它是"有无更新"的基线，带别人的进来基准会错位）');
  assert.ok(!('lastCheckedAt' in d), '不该带 lastCheckedAt');
  // 配置部分照旧
  assert.equal(d.label, '盯B站');
  assert.equal(d.source, 'bilibili');
});

/* ================================================================ */
/* 「能不能当预设的基础类型」必须是同一条判据                        */
/* ================================================================ */

/*
 * 三处入口在判同一件事：这个类型能不能作为自定义预设的基础类型。
 * 判据有两条 —— 类型存在（hasDef）、且不是 legacy。
 * 而 hasDef 只管第一条，于是三处各写各的就会不一致：
 *
 *   1. allPresets()  —— 跳过 legacy（拖不出来）
 *   2. 导入预设      —— 以前 isKnownType: (t) => hasDef(t)
 *   3. 存为自定义    —— 以前不判，老节点照样能存
 *
 * 2 和 3 都不报错，只是"做完了却看不见"：
 * 导入会报「新增 1 条」而侧栏里没有；存了也在侧栏里找不到。
 *
 * 为什么是源码级检查：两个文件都含 JSX，测试链路只做类型剥离、不转 JSX，
 * Node 加载不了，没法真跑 allPresets() / 渲染组件。
 */
test('导入预设的 isKnownType 必须用 canPresetOn（只用 hasDef 会放进 legacy 的）', () => {
  const SRC = process.env.AF_SRC;
  assert.ok(SRC, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
  const src = readFileSync(join(SRC, 'components/Sidebar.tsx'), 'utf8');
  const at = src.indexOf('importCustomPresets(');
  assert.ok(at > 0, 'Sidebar 里没找到导入调用');
  const seg = src.slice(at, at + 600);
  assert.match(
    seg,
    /canPresetOn/,
    '导入的 isKnownType 没走 canPresetOn —— 只查 hasDef 会把基于老类型' +
      '（ocr / translate / bili / wechat / play-audio / github-update）的预设放进来，' +
      '提示框报「新增 1 条」而侧栏不列出 legacy 的自定义预设：做完了却看不见。',
  );
});

test('存为自定义：老类型必须拦住（存完了在侧栏找不到）', () => {
  const SRC = process.env.AF_SRC;
  assert.ok(SRC, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
  const src = readFileSync(join(SRC, 'components/inspectors/SaveAsCustom.tsx'), 'utf8');
  assert.match(
    src,
    /meta\.legacy/,
    'SaveAsCustom 没判 legacy —— 老节点照样能存成预设，而侧栏不列出 legacy 的' +
      '自定义预设：存完了却找不到，不报错，用户只会以为保存失败。',
  );
});
