import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFlow, exportAll, EXPORT_FORMATS } from '../engine/scriptExport';
import { readSrc } from './srcScan';
import { readSrc } from './srcScan';

const n = (id: string, kind: string, data = {}) => ({
  id, data: { kind, label: id, status: 'idle', output: '', error: '', ...data },
});
const e = (a: string, b: string) => ({ id: `${a}->${b}`, source: a, target: b });

const g = (nodes: unknown[], edges: unknown[] = []) => ({ nodes, edges }) as never;

/* ================= 四种格式 ================= */

test('四种格式都产出非空内容', () => {
  const graph = g([n('w1', 'wait', { ms: 2000 }), n('l1', 'log', { text: 'hi' })], [e('w1', 'l1')]);
  const all = exportAll(graph);
  for (const f of EXPORT_FORMATS) {
    assert.ok(all[f.id].text.length > 0, `${f.id} 导出为空`);
  }
});

test('shell：等待节点变成 sleep，毫秒换算成秒', () => {
  const r = exportFlow(g([n('w1', 'wait', { ms: 2000 })]), 'shell');
  assert.ok(r.text.includes('sleep 2.000'), `实际：${r.text}`);
});

/*
 * 第一版用单引号包字符串，于是文本里的单引号要转义成 '\''。
 * 现在整句用**双引号**包（内部双引号转义），单引号不再是问题 ——
 * 但双引号必须转义，否则引号一多就断。
 */
test('shell：log 文本里的双引号要转义', () => {
  const r = exportFlow(g([n('l1', 'log', { text: 'say "hi" now' })]), 'shell');
  assert.ok(r.text.includes('\\"hi\\"'), `双引号没转义：${r.text}`);
});

test('shell：log 文本里的单引号不需要转义（双引号包着）', () => {
  const r = exportFlow(g([n('l1', 'log', { text: "it's ok" })]), 'shell');
  assert.ok(r.text.includes("it's ok"), '单引号被弄坏了');
});

test('shell：HTTP 节点变成 curl', () => {
  const r = exportFlow(g([n('h1', 'generic-http', { url: 'https://a.b/c', method: 'POST', body: '{}' })]), 'shell');
  assert.ok(r.text.includes('curl'));
  assert.ok(r.text.includes('-X POST'));
  assert.ok(r.text.includes('--data'));
});

test('python：HTTP 变 requests，等待变 time.sleep', () => {
  const r = exportFlow(g([
    n('h1', 'generic-http', { url: 'https://a.b/c', method: 'GET' }),
    n('w1', 'wait', { ms: 1500 }),
  ]), 'python');
  assert.ok(r.text.includes('requests.get'));
  assert.ok(r.text.includes('time.sleep(1.5)'));
  assert.ok(r.text.includes('import requests'));
});

test('json：带格式标记，可导入重放', () => {
  const r = exportFlow(g([n('w1', 'wait', { ms: 1 })]), 'json');
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.format, 'agent-flow/v1');
  assert.equal(parsed.nodes.length, 1);
});

test('markdown：逐步列出，标出顺序与上游', () => {
  const r = exportFlow(g([n('w1', 'wait', { ms: 1 }), n('l1', 'log', { text: 'x' })], [e('w1', 'l1')]), 'markdown');
  assert.ok(r.text.includes('## 1.'));
  assert.ok(r.text.includes('## 2.'));
  assert.ok(r.text.includes('接 w1'));
});

/* ================= 不可翻译的必须显式 ================= */

test('翻译不了的节点要出现在 skipped 里，并在文本里留 TODO', () => {
  const r = exportFlow(g([n('c1', 'condition', { rules: [] })]), 'shell');
  assert.equal(r.skipped.length, 1, '条件节点没被标记成未翻译');
  assert.ok(r.text.includes('TODO'), '文本里没留 TODO —— 用户会以为翻完了');
});

test('skipped 要说清原因，不是笼统一句', () => {
  const r = exportFlow(g([n('c1', 'condition')]), 'python');
  assert.ok(r.skipped[0].reason.length > 0);
  assert.equal(r.skipped[0].kind, 'condition');
});

test('控制流节点在 markdown 里要提醒"看不到分支"', () => {
  const r = exportFlow(g([n('c1', 'condition')]), 'markdown');
  assert.ok(r.text.includes('控制流'), '没提醒控制流的结构丢失');
});

/**
 * 这条是这套导出的立意 ——
 * 静默跳过的后果是：用户拿到一份脚本，跑起来"少了点什么"却毫无线索。
 * 宁可生成带 TODO 的脚本，也不要生成看起来完整其实是错的。
 */
test('混合图：能翻的翻出来，翻不了的都留痕', () => {
  const r = exportFlow(g([
    n('w1', 'wait', { ms: 1000 }),
    n('c1', 'condition'),
    n('l1', 'log', { text: 'done' }),
  ], [e('w1', 'c1'), e('c1', 'l1')]), 'shell');
  assert.ok(r.text.includes('sleep 1.000'), '能翻的没翻出来');
  assert.ok(r.text.includes('done'), '能翻的没翻出来');
  assert.equal(r.skipped.length, 1, '翻不了的没记下来');
  assert.equal(r.count, 2, 'count 应只算成功翻译的');
});

/* ================= 生成的脚本必须是合法的 ================= */

/**
 * 第一版生成的是**语法错误**的脚本：URL 没引号、JSON 路径写成
 * `print(data.items.0.title)`。那比不生成更糟 —— 用户拿到一份
 * 看起来完整的脚本，一跑就报错，还不知道是导出器的毛病。
 */
test('shell：URL 必须有引号（curl 的裸 URL 会语法错误）', () => {
  const r = exportFlow(g([n('h1', 'generic-http', { url: 'https://a.b/c' })]), 'shell');
  assert.ok(/curl[^"]*"https:\/\/a\.b\/c"/.test(r.text), `实际：${r.text}`);
});

test('python：requests 的 URL 必须是字符串字面量', () => {
  const r = exportFlow(g([n('h1', 'generic-http', { url: 'https://a.b/c' })]), 'python');
  assert.ok(/requests\.get\("https:\/\/a\.b\/c"\)/.test(r.text), `实际：${r.text}`);
});

test('JSON 路径生成的是合法索引表达式，不是 d.a.0.b', () => {
  const r = exportFlow(g([n('e1', 'extract', { mode: 'json', path: 'data.items.0.title' })]), 'shell');
  assert.ok(r.text.includes('["data"]'), '路径没转成索引');
  assert.ok(r.text.includes('[0]'), '数字段没当下标');
  assert.ok(!/print\(data\./.test(r.text), '还是把路径原样塞进了 print —— 那是语法错误');
});

test('模板引用与生成的变量名必须一致', () => {
  const r = exportFlow(g([
    n('e1', 'extract', { mode: 'json', path: 'a' }),
    n('l1', 'log', { text: '结果 {{e1.output}}' }),
  ], [e('e1', 'l1')]), 'python');
  assert.ok(r.text.includes('out_e1 ='), 'extract 的变量名不对');
  assert.ok(r.text.includes('{out_e1}'), `log 里引用的变量名不一致：${r.text}`);
  assert.ok(!r.text.includes('out_e1_output'), '引用了不存在的变量 —— 运行时取到空值');
});

test('log 没有级别前缀时不该多出空串参数', () => {
  const r = exportFlow(g([n('l1', 'log', { text: 'hi' })]), 'python');
  assert.ok(!r.text.includes('print(f""'), `多了空串参数：${r.text}`);
});

test('成环的节点要被标出来，不能静默丢掉', () => {
  const r = exportFlow(g(
    [n('a1', 'wait', { ms: 1 }), n('b1', 'wait', { ms: 1 })],
    [e('a1', 'b1'), e('b1', 'a1')],
  ), 'shell');
  assert.ok(r.skipped.some((x) => x.reason.includes('环')), '成环没被标记');
});

/* ------------------------------------------------------------------ */
/* 参数连线与导出                                                      */
/* ------------------------------------------------------------------ */

/**
 * 导出的脚本必须把参数连线**计入排序**。
 *
 * 运行时（runner）是计入的，导出若不计入，
 * 生成的脚本里来源会排在目标**之后** —— 目标拿到空值，
 * 于是"画布上跑是对的，导出的脚本跑出来不对"，
 * 而脚本能生成、能执行，完全没有报错。
 */
test('导出排序计入参数连线（与运行时同一口径）', () => {

  const src = readSrc('engine/scriptExport.ts');
  assert.ok(/topoLayers\(g,\s*paramLinksOf\(g\.edges\)\)/.test(src),
    '导出必须把参数连线传给 topoLayers');
  // 不能还留着不带参数连线的旧写法
  assert.ok(!/topoLayers\(g\);/.test(src), '还有一处排序漏了参数连线');
});

/**
 * 参数连线在脚本里翻译不过去，必须**写出来**。
 *
 * 脚本里取的是节点上手填的值，而画布上跑时取的是来源节点的输出。
 * 只有少数节点（常量、时钟…）会赋给一个变量可供引用，
 * 多数（日志、等待、HTTP…）根本没有 —— 翻译不了就得标出来，
 * 否则用户拿到一份"能跑但值不对"的脚本而毫无线索。
 */
test('有参数连线的节点在脚本里要标注（不能静默取手填值）', () => {

  const src = readSrc('engine/scriptExport.ts');
  assert.ok(/paramLinkNoteOf/.test(src), '必须显式标出参数连线造成的差异');
  assert.ok(/paramLinkNoteOf\(g, id, '# '\)/.test(src), 'shell 要标');
  assert.ok(/paramLinkNoteOf\(g, id, '    # '\)/.test(src), 'python 要标');
});

/* ================= 大模型节点 ================= */

/*
 * 合并后 llmChat 一度在 describe 里没有分支，落到 default 返回空串 ——
 * 导出的说明里这个节点没有描述，且**不进 skipped**（描述为空不算"翻译不出来"），
 * 所以没有任何痕迹。只能靠对账发现。
 */
test('大模型节点在说明里有描述（合并后最容易落到 default）', () => {
  const one = (use, extra = {}) => exportFlow(g([n('a1', 'llmChat', { use, model: 'gpt-4o', ...extra })]), 'markdown');
  assert.match(one('chat').text, /调用大模型/, '自由对话要有描述');
  assert.match(one('ocr').text, /识别图片/, '图片识别要有描述');
  assert.match(one('translate', { targetLang: '英文' }).text, /英文/, '翻译要带上目标语言');
});

test('python：大模型走 _llm 辅助函数，密钥不落盘', () => {
  const r = exportFlow(g([n('a1', 'llmChat', { prompt: '写首诗', model: 'gpt-4o', system: '你是诗人' })]), 'python');
  // python 的变量名是小写的 out_a1（shVar 才是大写），别照抄 shell 的写法
  assert.ok(/out_a1 = _llm\(/.test(r.text), `应调用 _llm，实际：${r.text}`);
  assert.ok(/def _llm\(/.test(r.text), '必须带上 _llm 定义，否则调用了不存在的函数');
  assert.ok(/os\.environ/.test(r.text), '地址与密钥必须走环境变量');
  // 反过来：脚本里不许出现任何密钥字段
  assert.ok(!/apiKey|api_key/.test(r.text), '脚本里不该出现密钥');
});

test('python：本地图片的识别留 TODO，不静默退化成纯文本提问', () => {
  const r = exportFlow(g([n('a1', 'llmChat', { use: 'ocr', imageSource: 'file', path: '/x/y.png' })]), 'python');
  assert.ok(r.skipped.some((s) => s.id === 'a1'), '本地图片模式应进 skipped');
  assert.ok(!/out_a1 = _llm/.test(r.text), '不该生成一条缺了图片的调用');
});

test('shell：大模型不做，但要说清"用 python 版"而不是"没做"', () => {
  const r = exportFlow(g([n('a1', 'llmChat', { prompt: 'hi' })]), 'shell');
  const s = r.skipped.find((x) => x.id === 'a1');
  assert.ok(s, '应进 skipped');
  assert.match(s.reason, /python/, '应指向 python 版');
  assert.ok(!/没有对应的 shell 写法/.test(s.reason), '不该用 default 那句笼统的话');
});

/* ==================================================================
 * 常量多卡 + 中文卡名的导出
 *
 * ================= 这次踩到的（两个叠在一起） =================
 *
 * ① subst 的正则不含中文（`[A-Za-z0-9_.]`），而常量卡的**默认名**是
 *    「文本1」「数字2」这类中文 —— 用户不改名时引用就是中文。
 *    于是 `{{c1.价格}}` 整段匹配不上，**原样留在脚本里**。
 *    运行时用的是另一份正则（template.ts，支持中文）能取到值，
 *    于是"画布上跑是对的、导出成脚本变成字面量 {{c1.价格}}"，不报错。
 *
 * ② 就算匹配上了，subst 是按**节点**展开的 —— `{{c1.价格}}` 换成
 *    `$OUT_C1`，也就是**第一张卡**的值。
 *    不报错、脚本看着完全正常（变量名都长得一样），只是值是另一张卡的。
 *    这比 ① 难查：① 至少留下 {{}} 的痕迹，② 什么痕迹都没有。
 * ==================================================================
 */

const constCards = () => ({
  items: [
    { id: 'k1', name: '阈值', valueType: 'num', value: '10' },
    { id: 'k2', name: '价格', valueType: 'num', value: '99' },
  ],
});

test('常量多卡：每张卡各导出一个变量，不再只导第一张', () => {
  const r = exportFlow(g([n('c1', 'const', constCards())]), 'python');
  assert.ok(/out_c1_k1 = "10"/.test(r.text), `第一张卡要有自己的变量：${r.text}`);
  assert.ok(/out_c1_k2 = "99"/.test(r.text), `第二张卡也要有：${r.text}`);
  // 整节点的默认引用仍存在（{{c1}} 不带卡名时取它）
  assert.ok(/out_c1 = out_c1_k1/.test(r.text), '{{c1}} 不带卡名时取第一张');
  assert.ok(
    !r.skipped.some((s) => s.id === 'c1'),
    '不再报"导出不全" —— 现在每张卡都导出了',
  );
});

test('常量多卡：下游引用 {{id.卡名}} 要指向那一张卡，不是第一张', () => {
  const graph = g(
    [n('c1', 'const', constCards()), n('l1', 'log', { text: '{{c1.价格}}' })],
    [e('c1', 'l1')],
  );
  const r = exportFlow(graph, 'python');
  assert.ok(/out_c1_k2/.test(r.text), `应引用「价格」那张卡的变量：${r.text}`);
  assert.ok(
    !/print\((f?"?)?"?\{\{/.test(r.text),
    `模板{{}}不许原样留在脚本里（说明正则没匹配上中文卡名）：${r.text}`,
  );
  assert.ok(!/print\(.*out_c1_k1/.test(r.text), `不该取成第一张卡「阈值」：${r.text}`);
});

test('常量多卡：shell 同样按卡导出（且每行顶格）', () => {
  const graph = g(
    [n('c1', 'const', constCards()), n('l1', 'log', { text: '{{c1.价格}}' })],
    [e('c1', 'l1')],
  );
  const r = exportFlow(graph, 'shell');
  assert.ok(/OUT_C1_K2='99'/.test(r.text), `第二张卡要有变量：${r.text}`);
  assert.ok(/echo "\$OUT_C1_K2"/.test(r.text), `应引用第二张卡：${r.text}`);
  // 缩进：shell 不需要缩进，多了会看着像被包在某个块里
  assert.ok(!/\n {6}OUT_C1/.test(r.text), 'shell 的常量行不该有缩进');
});

test('中文卡名：导出与运行时必须同一套字符集（template.ts 早已放开）', () => {
  /*
   * ================= 这条守卫的来历 =================
   *
   * template.ts（运行时）早就修过一次：
   *   「原来是 `[A-Za-z0-9_.\-]`，于是 {{params.输出目录}} 这种中文名
   *     整句匹配不上，原样留下 —— 用户看到'没生效'」
   * 那次**只改了运行时，漏了导出这一份**（scriptExport.ts 的 subst）。
   *
   * 于是同一个中文名：画布上跑能取到值，导出成脚本就变成字面量
   * `{{c1.价格}}` —— 不报错，只有结果不对。
   * 这是"同一件事两份实现，改一份漏一份"的典型。
   *
   * 所以这里不去解析正则（解析别人的正则太脆，写法一变就静默失效），
   * 只钉住一件事：**两份都得放开中文**。
   */
  const tpl = readSrc('engine/template.ts');
  const exp = readSrc('engine/scriptExport.ts');
  // 只钉 u4e00 这个片段：中文字符集在源码里的转义层数随写法变，
  // "考虑了中文"才是要守的事（详见 tests/refToken.test.ts）
  assert.ok(tpl.includes('u4e00'), '运行时模板必须认中文（template.ts 的 REF_CHARS）');
  assert.ok(/tokenRe\(\)/.test(exp), '导出必须调用 tokenRe()（自带一份就会再分叉）');
});
