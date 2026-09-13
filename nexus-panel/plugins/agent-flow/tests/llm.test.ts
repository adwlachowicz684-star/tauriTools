/**
 * 大模型调用层的单元测试。
 *
 * 运行：npm i -D tsx && npx tsx --test tests/llm.test.ts
 *
 * 这里测的是"请求体与结果算得对不对"，不发真实请求 ——
 * 真实网络调用由 runner 注入的 llmCaller 执行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_META, resolveConfig, validateConfig, buildHeaders,
  extractContent, extractError, parseResponse, describeHttpError,
  buildTranslateSystem, isHttpUrl, isUsableImageUrl, TARGET_LANGS,
  type LlmConfig,
} from '../engine/llm';

const cfg = (o: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: 'openai', baseUrl: '', model: '', apiKey: 'sk-test', timeoutSec: 60, ...o,
});

/* ---------- 配置补全 ---------- */

test('配置: 预设地址与模型被补全', () => {
  const r = resolveConfig(cfg());
  assert.equal(r.url, PROVIDER_META.openai.baseUrl);
  assert.equal(r.model, PROVIDER_META.openai.model);
});

test('配置: 用户填的地址与模型优先', () => {
  const r = resolveConfig(cfg({ baseUrl: 'https://my.api/v1/chat/completions', model: 'my-model' }));
  assert.equal(r.url, 'https://my.api/v1/chat/completions');
  assert.equal(r.model, 'my-model');
});

test('配置: 自定义服务商地址留空时不报错（由校验处理）', () => {
  const r = resolveConfig(cfg({ provider: 'custom' }));
  assert.equal(r.url, '');
});

test('配置: 非法超时回退到默认 60', () => {
  assert.equal(resolveConfig(cfg({ timeoutSec: 0 })).timeoutSec, 60);
  assert.equal(resolveConfig(cfg({ timeoutSec: -5 })).timeoutSec, 60);
});

test('配置: 各家预设地址都带 /chat/completions', () => {
  // 少这一段是最常见的填错方式，提前兜住
  for (const k of Object.keys(PROVIDER_META)) {
    if (k === 'custom') continue;
    const url = PROVIDER_META[k as 'openai'].baseUrl;
    assert.ok(url.includes('chat/completions'), `${k} 的地址应是 chat completions`);
  }
});

/* ---------- 校验 ---------- */

test('校验: 正常配置无提示', () => {
  assert.equal(validateConfig(cfg()).length, 0);
});

test('校验: 未填 Key 报错', () => {
  assert.ok(validateConfig(cfg({ apiKey: '' })).some((i) => i.level === 'error'));
});

test('校验: 自定义且地址为空报错', () => {
  const issues = validateConfig(cfg({ provider: 'custom', baseUrl: '' }));
  assert.ok(issues.some((i) => i.message.includes('地址为空')));
});

test('校验: 地址协议不对报错', () => {
  assert.ok(validateConfig(cfg({ baseUrl: 'ftp://x.com' })).some((i) => i.level === 'error'));
});

test('校验: 模型名为空报错', () => {
  const issues = validateConfig(cfg({ provider: 'custom', baseUrl: 'https://x.com/v1', model: '' }));
  assert.ok(issues.some((i) => i.message.includes('模型名为空')));
});

test('校验: OCR 场景选不支持图片的服务商会报错', () => {
  const issues = validateConfig(cfg({ provider: 'deepseek' }), true);
  assert.ok(issues.some((i) => i.level === 'error' && i.message.includes('不支持图片')));
});

test('校验: 翻译场景不检查视觉能力', () => {
  // 翻译不需要图片，不该因为 DeepSeek 不支持视觉而报错
  assert.equal(validateConfig(cfg({ provider: 'deepseek' }), false).length, 0);
});

test('校验: 自定义服务商不臆断视觉能力', () => {
  const issues = validateConfig(cfg({ provider: 'custom', baseUrl: 'https://x.com/v1', model: 'm' }), true);
  assert.equal(issues.filter((i) => i.message.includes('不支持图片')).length, 0);
});

/* ---------- 请求头 ---------- */

test('请求头: 带 Bearer', () => {
  assert.equal(buildHeaders('sk-1').Authorization, 'Bearer sk-1');
  assert.equal(buildHeaders('sk-1')['Content-Type'], 'application/json');
});

test('请求头: Key 为空时不带 Authorization（本地服务）', () => {
  // Ollama 等本地服务不需要鉴权，带了反而可能被拒
  assert.equal('Authorization' in buildHeaders(''), false);
});

/* ---------- 响应解析 ---------- */

test('解析: OpenAI 标准格式', () => {
  const body = { choices: [{ message: { content: '你好' } }] };
  assert.equal(extractContent(body), '你好');
});

test('解析: content 为数组（多模态网关）', () => {
  const body = { choices: [{ message: { content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] } }] };
  assert.equal(extractContent(body), '第一行第二行');
});

test('解析: choices[].text 格式', () => {
  assert.equal(extractContent({ choices: [{ text: '老格式' }] }), '老格式');
});

test('解析: Claude 风格 content 数组', () => {
  assert.equal(extractContent({ content: [{ text: '克劳德' }] }), '克劳德');
});

test('解析: 没有内容时返回空串', () => {
  assert.equal(extractContent({ choices: [] }), '');
  assert.equal(extractContent({}), '');
  assert.equal(extractContent(null), '');
});

test('解析: 错误体取 message', () => {
  assert.equal(extractError({ error: { message: '额度不足' } }), '额度不足');
});

test('解析: 错误体为字符串', () => {
  assert.equal(extractError({ error: 'bad key' }), 'bad key');
});

test('解析: 200 且能取到内容', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: '译文' } }] });
  const r = parseResponse(200, raw);
  assert.equal(r.ok, true);
  assert.equal(r.text, '译文');
  assert.equal(r.error, '');
});

test('解析: 200 但取不到内容算失败', () => {
  const r = parseResponse(200, JSON.stringify({ choices: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('没有取到内容'));
});

test('解析: 401 给出 Key 相关提示', () => {
  const raw = JSON.stringify({ error: { message: 'invalid api key' } });
  const r = parseResponse(401, raw);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('API Key'), `实际: ${r.error}`);
});

test('解析: 429 提示限流或额度', () => {
  const r = parseResponse(429, JSON.stringify({ error: { message: 'rate limit' } }));
  assert.ok(r.error.includes('限流') || r.error.includes('额度'), `实际: ${r.error}`);
});

test('解析: 404 提示检查地址', () => {
  const r = parseResponse(404, '{}');
  assert.ok(r.error.includes('地址'), `实际: ${r.error}`);
});

test('解析: 返回 HTML 错误页不算成功', () => {
  const r = parseResponse(200, '<html>502 Bad Gateway</html>');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('不是 JSON'));
});

test('解析: 原始响应被截断（避免日志爆炸）', () => {
  const big = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5000) } }] });
  assert.ok(parseResponse(200, big).raw.length <= 2000);
});

test('错误描述: 各状态码都有中文说明', () => {
  for (const s of [400, 401, 403, 404, 429, 500]) {
    assert.ok(describeHttpError(s, '').length > 0, `${s} 应有说明`);
  }
});

/* ---------- URL 判定 ---------- */

test('URL: http 与 https 都合法', () => {
  assert.equal(isHttpUrl('https://a.com'), true);
  assert.equal(isHttpUrl('http://a.com'), true);
  assert.equal(isHttpUrl('HTTPS://A.COM'), true);
});

test('URL: 非 http 协议不合法', () => {
  assert.equal(isHttpUrl('ftp://a.com'), false);
  assert.equal(isHttpUrl('/local/path.png'), false);
  assert.equal(isHttpUrl(''), false);
});

test('图片地址: data URL 也算合法', () => {
  assert.equal(isUsableImageUrl('data:image/png;base64,AAAA'), true);
  assert.equal(isUsableImageUrl('https://a.com/x.png'), true);
  assert.equal(isUsableImageUrl('data:text/plain;base64,AAAA'), false, '非图片类型应拒绝');
  assert.equal(isUsableImageUrl('/etc/passwd'), false);
});

/* ---------- 翻译提示词 ---------- */

test('翻译: system 提示要求只输出译文', () => {
  const s = buildTranslateSystem('中文', '');
  assert.ok(s.includes('中文'));
  assert.ok(s.includes('只输出译文'), '必须约束输出格式，否则会混进客套话');
});

test('翻译: 指定源语言会出现在提示里', () => {
  assert.ok(buildTranslateSystem('中文', '日语').includes('日语'));
});

test('翻译: 自动检测时不写死源语言', () => {
  assert.ok(buildTranslateSystem('中文', '').includes('自动识别'));
});

test('翻译: 术语表被写入', () => {
  const s = buildTranslateSystem('中文', '', 'GPU=图形处理器');
  assert.ok(s.includes('GPU=图形处理器'));
  assert.ok(s.includes('术语表'));
});

test('翻译: 无术语表时不出现术语表段落', () => {
  assert.equal(buildTranslateSystem('中文', '', '').includes('术语表'), false);
});

test('语言预设: 都有 code 与 label', () => {
  for (const l of TARGET_LANGS) {
    assert.ok(l.code && l.label, `${JSON.stringify(l)} 不完整`);
  }
});
