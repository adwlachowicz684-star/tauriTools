import test from 'node:test';
import assert from 'node:assert/strict';
import type { Credential } from '../engine/credentials';
import {
  LLM_META, llmBaseUrlOf, llmModelsOf, llmProviderOf, parseModelsText, modelsTextOf,
  visionHintOf, knownVisionModel, resolveLlmFromCredential,
  canMigrateLlm, findReusableLlmCredential, llmMigrationPatch,
  modelsEndpointOf, mergeModels, extractModelIds,
  migrateLlmToCredentials, type MigratableCanvas,
} from '../engine/llmCredential';
import { makeCredential } from '../engine/credentials';

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
