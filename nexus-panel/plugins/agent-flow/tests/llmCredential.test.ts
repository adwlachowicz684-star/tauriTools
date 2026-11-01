import test from 'node:test';
import assert from 'node:assert/strict';
import type { Credential } from '../engine/credentials';
import {
  LLM_META, llmBaseUrlOf, llmModelsOf, llmProviderOf, parseModelsText, modelsTextOf,
  visionHintOf, knownVisionModel, resolveLlmFromCredential,
  canMigrateLlm, findReusableLlmCredential, llmMigrationPatch,
  modelsEndpointOf, mergeModels, extractModelIds,
  migrateLlmToCredentials, missingLlmReason, missingLlmMessage, type MigratableCanvas,
} from '../engine/llmCredential';
import { makeCredential, findCredential } from '../engine/credentials';
import { readSrc } from './srcScan';

/**
 * 大模型凭据。
 *
 * ================= 要什么 ====================
 *
 * 用到大模型的节点只存两样：**哪个凭据** + **哪个模型**。
 * API 地址、API Key、服务商全在凭据里 —— 改一处，引用它的节点同时生效。
 *
 * ================= 守卫什么 ====================
 *
 * ① meta 键名统一（一处写 'base_url'、另一处读 'baseUrl' 是静默失效）
 * ② 模型列表去重、去空行、去行内注释
 * ③ 视觉提示**只对确认不支持的说话**，认不出来就闭嘴
 * ④ 选中的模型不在列表里也照用（列表只是快照）
 * ⑤ 迁移：同地址+同密钥才复用；迁移后节点上不留地址与密钥
 */

function llmCred(meta: Record<string, string>, secret = 'sk-test'): Credential {
  return makeCredential({ kind: 'llm', name: '测试凭据', secret, meta, capabilities: ['llm:chat'] });
}

/* ------------------------------------------------------------------ */

test('meta 键名统一走 LLM_META', () => {
  /*
   * 三处键名散着写的话，一处写 'base_url'、另一处读 'baseUrl'
   * 会永远读出空 —— 界面上只表现为"地址没生效"。
   */
  assert.equal(LLM_META.baseUrl, 'llm.baseUrl');
  assert.equal(LLM_META.models, 'llm.models');
  assert.equal(LLM_META.provider, 'llm.provider');
});

test('地址：凭据自己填的最优先', () => {
  const c = llmCred({ [LLM_META.baseUrl]: 'https://my-gateway/v1/chat/completions' });
  assert.equal(llmBaseUrlOf(c), 'https://my-gateway/v1/chat/completions');
});

test('地址：没填时按服务商预设兜底', () => {
  /*
   * 多数用户就是直接用官方地址。
   * 不兜底的话"只填了服务商"的凭据地址为空，请求必然失败，
   * 而界面上看不出到底是没填还是填错了。
   */
  const c = llmCred({ [LLM_META.provider]: 'deepseek' });
  assert.match(llmBaseUrlOf(c), /api\.deepseek\.com/);
});

test('服务商取不到时返回 null 而不是 custom', () => {
  /*
   * 返回 'custom' 的话会被当成"真的选了自定义"，
   * 于是预设地址兜底失效（custom 的预设地址是空串）。
   */
  assert.equal(llmProviderOf(llmCred({})), null);
  assert.equal(llmProviderOf(llmCred({ [LLM_META.provider]: '不存在的服务商' })), null);
  assert.equal(llmProviderOf(llmCred({ [LLM_META.provider]: 'openai' })), 'openai');
});

/* ------------------------------------------------------------------ */

test('模型列表：去空行、去重复、去行内注释', () => {
  const list = parseModelsText('gpt-4o\n\n  deepseek-chat  # 不支持图\ngpt-4o\n');
  assert.deepEqual(list, ['gpt-4o', 'deepseek-chat']);
});

test('模型列表：写回文本后再读，结果一致', () => {
  /*
   * 手填框 → meta → 手填框 这一圈不能越走越脏。
   * 不去重的话每编辑一次就多一份重复项。
   */
  const once = modelsTextOf(['a', 'b', 'a']);
  assert.deepEqual(parseModelsText(once), ['a', 'b']);
  assert.deepEqual(modelsTextOf(parseModelsText(once)), once);
});

test('模型列表：空凭据返回空数组（不是 undefined）', () => {
  assert.deepEqual(llmModelsOf(null), []);
  assert.deepEqual(llmModelsOf(undefined), []);
});

/* ------------------------------------------------------------------ */

test('视觉提示：只对**确认不支持**的说话', () => {
  assert.match(visionHintOf('deepseek-chat'), /不支持视觉/);
  assert.match(visionHintOf('moonshot-v1-8k'), /不支持视觉/);
  assert.match(visionHintOf('glm-4-flash'), /不支持视觉/);
});

test('视觉提示：认不出来就闭嘴（不误报）', () => {
  /*
   * 靠名字判断能不能接图没有可靠规则，硬判的代价是误报：
   * 把一个能接图的模型标成"不支持"，用户就不选它了 ——
   * 比漏报更糟（漏报最多跑到一半报错）。
   */
  assert.equal(visionHintOf('某家新出的模型-x'), '');
  assert.equal(visionHintOf(''), '');
});

test('视觉提示：已确认支持的不给提示', () => {
  /*
   * 名字里带 vl / vision / 4o 这类特征的不该被标成不支持。
   */
  assert.equal(visionHintOf('qwen-vl-max'), '');
  assert.equal(visionHintOf('gpt-4o'), '');
  assert.ok(knownVisionModel('qwen-vl-max'));
  assert.ok(!knownVisionModel('deepseek-chat'));
});

/* ------------------------------------------------------------------ */

test('凭据 + 模型 → 请求配置（密钥来自凭据，不是节点）', () => {
  const c = llmCred({
    [LLM_META.baseUrl]: 'https://gw/v1/chat/completions',
    [LLM_META.models]: 'gpt-4o\nmy-model',
  }, 'sk-from-credential');
  const r = resolveLlmFromCredential(c, 'my-model');
  assert.equal(r.apiKey, 'sk-from-credential');
  assert.equal(r.url, 'https://gw/v1/chat/completions');
  assert.equal(r.model, 'my-model');
});

test('选中的模型不在列表里也照用（列表只是快照）', () => {
  /*
   * 列表是"上次拉到的快照"，服务商随时上新模型。
   * 卡住不让用会逼用户每上一个新模型都回来编辑一次凭据。
   */
  const c = llmCred({ [LLM_META.models]: 'gpt-4o' });
  assert.equal(resolveLlmFromCredential(c, 'brand-new-model').model, 'brand-new-model');
});

test('没选模型时用列表第一个，列表空时用服务商默认', () => {
  const c = llmCred({ [LLM_META.models]: 'b\na' });
  assert.equal(resolveLlmFromCredential(c, '').model, 'b');

  const c2 = llmCred({ [LLM_META.provider]: 'moonshot' });
  assert.equal(resolveLlmFromCredential(c2, '').model, 'moonshot-v1-8k');
});

test('没凭据时退回节点上那份旧配置（老画布迁移前）', () => {
  /*
   * 直接返回空的话，老节点会突然跑不起来而看不出原因。
   */
  const r = resolveLlmFromCredential(null, 'x', {
    fallback: { provider: 'custom', baseUrl: 'https://old', model: 'old-model', apiKey: 'k', timeoutSec: 30 },
  });
  assert.equal(r.url, 'https://old');
  assert.equal(r.model, 'old-model');
  assert.equal(r.timeoutSec, 30);
});

/* ------------------------------------------------------------------ */

test('迁移判据只有一条：有没有密钥', () => {
  /*
   * 没密钥的话收进去也是一条跑不通的凭据，
   * 还不如不动 —— 节点上那份留着继续用。
   */
  assert.equal(canMigrateLlm({ llm: { apiKey: 'sk-1' } }), true);
  assert.equal(canMigrateLlm({ llm: { apiKey: '   ' } }), false);
  assert.equal(canMigrateLlm({ llm: { model: 'gpt-4o' } }), false);
  assert.equal(canMigrateLlm({}), false);
});

test('复用凭据要看地址+密钥两者（只比密钥会连错地方）', () => {
  const a = llmCred({ [LLM_META.baseUrl]: 'https://a' }, 'sk-same');
  const b = llmCred({ [LLM_META.baseUrl]: 'https://b' }, 'sk-same');
  const input = { llm: { apiKey: 'sk-same', baseUrl: 'https://a' } };

  assert.equal(findReusableLlmCredential([a, b], input)?.id, a.id);
  // 同密钥但不同地址 → 不能复用，否则节点会突然连到别处
  const onlyB = { llm: { apiKey: 'sk-same', baseUrl: 'https://b' } };
  assert.equal(findReusableLlmCredential([a], onlyB), null);
});

test('复用时不比较 llm 类型的凭据之外的凭据', () => {
  const github = makeCredential({ kind: 'github', secret: 'sk-same' });
  const input = { llm: { apiKey: 'sk-same', baseUrl: '' } };
  assert.equal(findReusableLlmCredential([github], input), null);
});

test('迁移后节点上不留地址与密钥', () => {
  /*
   * 两处都有地址的话，改凭据的地址不生效 ——
   * 表现为"改了没反应"，且看不出是节点上那份还在起作用。
   */
  const c = llmCred({ [LLM_META.models]: 'gpt-4o' }, 'sk-new');
  const patch = llmMigrationPatch(c, {
    llm: { apiKey: 'sk-old', baseUrl: 'https://old', model: 'my-model', provider: 'openai' },
  });
  assert.equal(patch.credentialId, c.id);
  assert.equal(patch.llmModel, 'my-model');

  const llm = patch.llm as Record<string, unknown>;
  assert.equal(llm.apiKey, '');
  assert.equal(llm.baseUrl, '');
  assert.equal(llm.model, '');
});

test('迁移时模型为空则取列表第一个（不能迁完就没模型）', () => {
  const c = llmCred({ [LLM_META.models]: 'first\nsecond' });
  const patch = llmMigrationPatch(c, { llm: { apiKey: 'k' } });
  assert.equal(patch.llmModel, 'first');
});

/* ------------------------------------------------------------------ */

test('chat 地址 → models 地址', () => {
  assert.equal(
    modelsEndpointOf('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/models',
  );
  // 带尾斜杠也能认
  assert.equal(
    modelsEndpointOf('https://gw/v1/chat/completions/'),
    'https://gw/v1/models',
  );
});

test('认不出结尾时返回 null（不拼必然 404 的地址）', () => {
  /*
   * 自定义网关路径很怪时，硬拼会得到一个必然 404 的地址，
   * 而报错信息看着像"密钥不对"，排查方向完全是错的。
   */
  assert.equal(modelsEndpointOf('https://gw/some/weird/path'), null);
  assert.equal(modelsEndpointOf(''), null);
});

test('合并模型：手填的保持在前', () => {
  /*
   * 手写的顺序是刻意的（常用的排前面）。
   * 自动拉取的结果冲掉人排的顺序，等于每次拉取都打乱一次。
   */
  const out = mergeModels(['常用模型', 'b'], ['c', '常用模型']);
  assert.deepEqual(out, ['常用模型', 'b', 'c']);
});

test('从 /v1/models 响应里取模型名', () => {
  const ids = extractModelIds({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] });
  assert.deepEqual(ids, ['gpt-4o', 'gpt-4o-mini']);
});

test('响应形状不认识时返回空数组（不塞乱数据进下拉框）', () => {
  assert.deepEqual(extractModelIds({}), []);
  assert.deepEqual(extractModelIds({ data: 'not-an-array' }), []);
  assert.deepEqual(extractModelIds(null), []);
});

/* ------------------------------------------------------------------ */

function canvas(id: string, nodes: { id: string; data: Record<string, unknown> }[], name?: string)
  : MigratableCanvas {
  return { id, name, nodes };
}

const OLD_NODE = (apiKey: string, baseUrl: string, model: string, provider = 'custom') => ({
  llm: { provider, baseUrl, model, apiKey, timeoutSec: 60 },
});

test('迁移：节点上的配置收进凭据，节点只留 credentialId 与模型', () => {
  const cvs = [canvas('cv1', [{ id: 'n1', data: OLD_NODE('sk-a', 'https://a/v1', 'model-a', 'openai') }], '画布甲')];
  const r = migrateLlmToCredentials(cvs, [], (p) => makeCredential(p));

  assert.equal(r.migrated, 1);
  assert.equal(r.credentials.length, 1);
  assert.equal(r.credentials[0].secret, 'sk-a');
  assert.equal(r.credentials[0].meta?.[LLM_META.models], 'model-a');

  const patch = r.patches.cv1.n1;
  assert.equal(patch.credentialId, r.credentials[0].id);
  assert.equal((patch.llm as Record<string, unknown>).apiKey, '');
});

test('迁移：凭据名带服务商与画布名（多条凭据能分清）', () => {
  /*
   * 都叫「大模型 API Key」的话，列表里有三四条时分不清哪条是哪条。
   */
  const cvs = [canvas('cv1', [{ id: 'n1', data: OLD_NODE('sk-a', '', 'm', 'deepseek') }], '掉落表')];
  const r = migrateLlmToCredentials(cvs, [], (p) => makeCredential(p));
  assert.match(r.credentials[0].name, /DeepSeek/);
  assert.match(r.credentials[0].name, /掉落表/);
});

test('迁移：**幂等** —— 跑第二遍不再新增', () => {
  /*
   * 它在每次加载时跑。不幂等的话每开一次就多一条凭据，
   * 表现为凭据列表越来越长，而用户不知道哪条是真的。
   */
  const cvs = [canvas('cv1', [{ id: 'n1', data: OLD_NODE('sk-a', 'https://a/v1', 'm') }])];
  const r1 = migrateLlmToCredentials(cvs, [], (p) => makeCredential(p));

  // 把 patch 应用到节点上（模拟界面写回）
  const applied = [canvas('cv1', [{
    id: 'n1',
    data: { ...cvs[0].nodes[0].data, ...r1.patches.cv1.n1 } as Record<string, unknown>,
  }])];
  const r2 = migrateLlmToCredentials(applied, r1.credentials, (p) => makeCredential(p));

  assert.equal(r2.migrated, 0, '第二遍不该再迁');
  assert.equal(r2.credentials.length, 1, '不该多出凭据');
});

test('迁移：同地址同密钥的多个节点复用一条凭据', () => {
  const cvs = [canvas('cv1', [
    { id: 'n1', data: OLD_NODE('sk-same', 'https://a/v1', 'm1') },
    { id: 'n2', data: OLD_NODE('sk-same', 'https://a/v1', 'm2') },
  ])];
  const r = migrateLlmToCredentials(cvs, [], (p) => makeCredential(p));
  assert.equal(r.credentials.length, 1);
  // 两个模型都要在清单里，否则下拉框里少了第二个
  assert.deepEqual(llmModelsOf(r.credentials[0]), ['m1', 'm2']);
  assert.equal(r.patches.cv1.n1.credentialId, r.patches.cv1.n2.credentialId);
});

test('迁移：同密钥不同地址 → 两条凭据（不能混用）', () => {
  const cvs = [canvas('cv1', [
    { id: 'n1', data: OLD_NODE('sk-same', 'https://a/v1', 'm1') },
    { id: 'n2', data: OLD_NODE('sk-same', 'https://b/v1', 'm2') },
  ])];
  const r = migrateLlmToCredentials(cvs, [], (p) => makeCredential(p));
  assert.equal(r.credentials.length, 2);
});

test('迁移：节点上没密钥的不动（收进去也是跑不通的凭据）', () => {
  const cvs = [canvas('cv1', [{ id: 'n1', data: { llm: { model: 'm', baseUrl: 'https://a' } } }])];
  const r = migrateLlmToCredentials(cvs, [], (p) => makeCredential(p));
  assert.equal(r.migrated, 0);
  assert.equal(r.credentials.length, 0);
});

/* ---------- 明文连接与迁移的配合 ---------- */

/*
 * ⛔ 这条是**连带效应**，值得钉住：
 * decryptStore 曾把磁盘上的明文 secret 抹成空串，于是
 * findReusableLlmCredential 比密钥时永远对不上（'' !== 'sk-legacy'），
 * 老存档 + 老节点会**新建出一条重复连接** ——
 * 连接列表越来越长，而用户不知道哪条是真的（正是迁移要防的那件事）。
 */
test('迁移: 已有一条明文连接的，要复用而不是再建一条', () => {
  const existing = makeCredential({
    kind: 'llm', name: 'OpenAI · 画布一', secret: 'sk-legacy',
    meta: { [LLM_META.provider]: 'openai', [LLM_META.baseUrl]: '', [LLM_META.models]: 'gpt-4o' },
    capabilities: ['llm:chat'],
  });
  const cvs = [canvas('cv1', [{ id: 'n1', data: OLD_NODE('sk-legacy', '', 'gpt-4o', 'openai') }])];
  const r = migrateLlmToCredentials(cvs, [existing], (p) => makeCredential(p));
  assert.equal(r.credentials.length, 1, '明文还在就该复用，不能重复建');
  assert.equal(r.migrated, 1);
});

test('迁移: 解不开的（secret 空）不会被误复用（反例）', () => {
  const broken = makeCredential({
    kind: 'llm', name: 'x', secret: '',
    meta: { [LLM_META.provider]: 'openai', [LLM_META.baseUrl]: '', [LLM_META.models]: '' },
    capabilities: ['llm:chat'],
  });
  const cvs = [canvas('cv1', [{ id: 'n1', data: OLD_NODE('sk-legacy', '', 'm', 'openai') }])];
  assert.equal(
    findReusableLlmCredential([broken], { llm: cvs[0].nodes[0].data!.llm as never }),
    null, '空密钥不能被当成"同一个 key"复用',
  );
});

/* ---------- 源码守卫 ---------- */

test('源码守卫: lockVault 必须重置迁移闸门（否则"每次加载时跑"是假话）', () => {
  const src = readSrc('hooks/useCredentialVault.ts');
  const at = src.indexOf('const lockVault');
  assert.ok(at >= 0, '要能找到 lockVault');
  const body = src.slice(at, src.indexOf('const unlock'));
  assert.ok(/ranLlmMigrationRef\.current\s*=\s*false/.test(body),
    '锁定后不重置闸门 → 整个会话只迁移一次，'
    + '中途导入的老画布上的内联密钥永远不进连接库，导出时会跟着文件走');
});

test('源码守卫: 迁移闸门要在跑完之后才关（抛异常不该永久关死）', () => {
  const src = readSrc('hooks/useCredentialVault.ts');
  const at = src.indexOf('const migrateLlmNow');
  assert.ok(at >= 0, '要能找到 migrateLlmNow');
  const body = src.slice(at, src.indexOf('const lockVault'));
  const callAt = body.indexOf('migrateLlmToCredentials(');
  const setAt = body.indexOf('ranLlmMigrationRef.current = true');
  assert.ok(callAt >= 0 && setAt >= 0, '调用与关闸门都要在');
  assert.ok(setAt > callAt, '闸门设在调用之前：一旦抛异常就永久关死，那些密钥再也不会被收进来');
});

/* ---------- 连接没了：该说什么 ---------- */

/*
 * ⛔ 关键在**方向**：
 * 填过 id 却找不到连接（迁移过的节点 + 那条被删了），
 * 得到的是空地址，但用户的处境和"从没配过"完全相反 ——
 * 说"没配"他会去新建一条，而真正的问题是他选的那条没了。
 */
test('连接没了: 填过 id 却找不到 → 说"选的连接不存在"，不是"没配"', () => {
  const cvs = [canvas('cv1', [{ id: 'n1', data: OLD_NODE('sk-a', '', 'm', 'openai') }])];
  const cred = migrateLlmToCredentials(cvs, [], (p2) => makeCredential(p2)).credentials[0];
  const patch = llmMigrationPatch(cred, { llm: cvs[0].nodes[0].data!.llm as never });
  // 迁移过的节点：llm 已被清空，只留 credentialId
  const cfg = resolveLlmFromCredential(findCredential([], cred.id), 'gpt-4o', { fallback: patch.llm as never });
  assert.equal(cfg.url, '', '连接没了 → 地址是空的（fallback 也已被迁移清空）');
  assert.equal(missingLlmReason(cred.id, findCredential([], cred.id), cfg), 'connection-gone');
  assert.ok(/不存在/.test(missingLlmMessage('connection-gone')), '要说"那条没了"，不能说"没配"');
});

test('连接没了: 没填过 id → 说"没配"（别把没配的说成没了）', () => {
  const cfg = resolveLlmFromCredential(undefined, 'm', { fallback: undefined });
  assert.equal(cfg.url, '');
  assert.equal(missingLlmReason(undefined, undefined, cfg), 'no-connection');
  assert.ok(/加一条/.test(missingLlmMessage('no-connection')));
});

test('连接没了: 地址在就不报（反例——别误伤正常节点）', () => {
  const c = makeCredential({
    kind: 'llm', name: 'x', secret: 'sk',
    meta: { [LLM_META.provider]: 'openai', [LLM_META.baseUrl]: '', [LLM_META.models]: 'gpt-4o' },
    capabilities: ['llm:chat'],
  });
  const cfg = resolveLlmFromCredential(c, 'gpt-4o');
  assert.ok(cfg.url, '地址在');
  assert.equal(missingLlmReason(c.id, c, cfg), null, '地址在就不该报');
});

test('连接没了: 未迁移的老节点有兜底地址 → 不报（反例）', () => {
  const cfg = resolveLlmFromCredential(findCredential([], 'gone'), 'gpt-4o', {
    fallback: { provider: 'openai', baseUrl: 'https://proxy/v1/chat/completions', model: 'gpt-4o', apiKey: 'sk', timeoutSec: 60 } as never,
  });
  assert.equal(cfg.url, 'https://proxy/v1/chat/completions');
  assert.equal(missingLlmReason('gone', findCredential([], 'gone'), cfg), null, '有地址就不报');
});

/* ---------- 源码守卫 ---------- */

/*
 * 三个 runner 都发大模型请求，空地址的检查**必须三个都有**。
 * llmChat 一直有，OCR / 翻译没有过 —— 而测试跑的是 transpile-only，
 * 不解析模块也不跑请求，所以那两个的静默没有任何信号。
 */
for (const f of ['engine/runners/llmChat.ts', 'engine/runners/ocr.ts', 'engine/runners/translate.ts']) {
  test(`源码守卫: ${f.split('/').pop()} 必须拦空地址并走共用判据`, () => {
    const src = readSrc(f);
    assert.ok(/missingLlmReason\s*\(/.test(src), `${f} 没有拦空地址 —— 会拿着 '' 去发请求，报错指向"解析响应失败"`);
    assert.ok(/missingLlmMessage\s*\(/.test(src), `${f} 用了判据却没说共用文案 —— 三个节点各写一份必然各改各的`);
  });
}

/* ---------- 密钥只该有一个来源 ---------- */

/*
 * ⛔ resolveLlmFromCredential 的意义就是"算成真正能发的配置"，
 * 它的 apiKey 已走完"连接优先 + 老节点内联兜底"。
 * 再绕 resolveSecret(list, id, cfg.apiKey) 取第二遍，
 * 拿到的是**未 trim** 的原值 —— 两处各说各的。
 */
test('密钥: cfg.apiKey 是 trim 过的（从文件粘贴带了换行也不会带进 header）', () => {
  const c = makeCredential({
    kind: 'llm', name: 'x', secret: '  sk-real\n',
    meta: { [LLM_META.provider]: 'openai', [LLM_META.baseUrl]: '', [LLM_META.models]: 'gpt-4o' },
    capabilities: ['llm:chat'],
  });
  const cfg = resolveLlmFromCredential(c, 'gpt-4o');
  assert.equal(cfg.apiKey, 'sk-real', '必须 trim —— 带换行的 Authorization 头会让请求直接失败');
  assert.ok(!/[\r\n]/.test(cfg.apiKey));
});

test('密钥: 全空白的 secret 算"没填"（不能发出三个空格）', () => {
  const c = makeCredential({
    kind: 'llm', name: 'x', secret: '   ',
    meta: { [LLM_META.provider]: 'openai', [LLM_META.baseUrl]: '', [LLM_META.models]: '' },
    capabilities: ['llm:chat'],
  });
  assert.equal(resolveLlmFromCredential(c, 'gpt-4o').apiKey, '');
});

test('密钥: 连接悬空 + 老节点有内联 → 用内联（反例，别把兜底弄丢）', () => {
  const cfg = resolveLlmFromCredential(undefined, 'm', {
    fallback: { provider: 'openai', baseUrl: 'https://p/v1', model: 'm', apiKey: 'sk-old', timeoutSec: 60 } as never,
  });
  assert.equal(cfg.apiKey, 'sk-old');
});

test('密钥: 连接在 → 用连接的，不是内联的（反例，别退回旧值）', () => {
  const c = makeCredential({
    kind: 'llm', name: 'x', secret: 'sk-new',
    meta: { [LLM_META.provider]: 'openai', [LLM_META.baseUrl]: '', [LLM_META.models]: 'm' },
    capabilities: ['llm:chat'],
  });
  const cfg = resolveLlmFromCredential(c, 'm', {
    fallback: { provider: 'openai', baseUrl: 'https://p/v1', model: 'm', apiKey: 'sk-old', timeoutSec: 60 } as never,
  });
  assert.equal(cfg.apiKey, 'sk-new', 'cfg 里算的就得是发出去的那个');
});

/* ---------- 源码守卫 ---------- */

for (const f of ['engine/runners/llmChat.ts', 'engine/runners/ocr.ts', 'engine/runners/translate.ts']) {
  test(`源码守卫: ${f.split('/').pop()} 的密钥只走 cfg.apiKey（不再取第二遍）`, () => {
    const src = readSrc(f);
    assert.ok(/buildHeaders\(\s*cfg\.apiKey\s*\)/.test(src),
      `${f} 没有直接用 cfg.apiKey —— 两处取值必然分叉（一份 trim 过、一份没有）`);
    assert.ok(!/buildHeaders\(\s*resolveSecret/.test(src),
      `${f} 又在 buildHeaders 里取了一遍 —— 那一份是未 trim 的原值`);
  });
}
