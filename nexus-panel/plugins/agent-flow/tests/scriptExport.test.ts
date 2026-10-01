import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFlow, exportAll, EXPORT_FORMATS } from '../engine/scriptExport';
import { readSrc } from './srcScan';

const n = (id: string, kind: string, data = {}) => ({
  id, data: { kind, label: id, status: 'idle', output: '', error: '', ...data },
});
const e = (a: string, b: string, extra: Record<string, unknown> = {}) => ({ id: `${a}->${b}`, source: a, target: b, ...extra });

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
  /*
   * python 侧不再写死 4 个空格 —— 循环体里缩进要跟着层级走，
   * 写死的话嵌套循环内的注释会顶到行首，看着像在循环外。
   * 所以这里盯"前缀由 indent 拼出"，而不是盯某串空格。
   */
  assert.ok(src.includes('paramLinkNoteOf(g, id, `${indent}# `)'), 'python 要标（且缩进跟着循环层级走）');
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

/* ================= 全局输入 / 画布参数 / 循环变量 ================= */

test('{{input}} 不能导出成 python 的内建函数名 input', () => {
  /*
   * ================= 这条守卫的来历 =================
   *
   * subst 把 {{input}} 拼成 `INPUT` → python 小写化成 **`input`**，
   * 而 input 是 python 的内建函数 —— f"{input}" 渲染出
   * `<built-in function input>`。**不报错，值永远错**，是最难查的一类。
   *
   * 顺带：{{input.output}} 被拼成 INPUT_OUTPUT（脚本里从未定义），
   * 而运行时 template.ts 里 nodeId==='input' 时**不看 field**，
   * 两种写法是同一个东西 —— 所以这里两种写法都断言。
   */
  const graph = g([
    n('a1', 'log', { text: '{{input}}' }),
    n('a2', 'log', { text: '{{input.output}}' }),
  ]);
  const py = exportFlow(graph, 'python');
  assert.ok(!/\bf"\{input\}"|\{input_output\}/.test(py.text), `实际：${py.text}`);
  assert.ok(py.text.includes('f"{input_text}"'), `实际：${py.text}`);

  const sh = exportFlow(graph, 'shell');
  assert.ok(sh.text.includes('echo "$INPUT_TEXT"'), `实际：${sh.text}`);
  // shell 侧必须真的定义这个变量，否则 set -u 下直接退出
  assert.ok(/^INPUT_TEXT=/m.test(sh.text), `shell 里没有定义 INPUT_TEXT：${sh.text}`);
});

test('画布参数与循环变量：导出时保留 {{原样}} 并记进 skipped', () => {
  /*
   * 这两类的值**不在图数据里**（Graph 只有 nodes + edges），
   * 循环结构本身也翻不成脚本。所以与运行时同一口径：保留痕迹 + 提示。
   *
   * 以前它们被拼成 INPUT_XXX / OUT_PARAMS：
   *   · shell → 未定义变量，set -u 下退出
   *   · python → NameError
   * 都不是"看得懂"的失败。
   */
  const graph = g([
    n('p1', 'log', { text: '{{params.价格}}' }),
    n('p2', 'log', { text: '{{env.NAME}}' }),
    n('p3', 'log', { text: '{{loop.item}}' }),
  ]);
  for (const fmt of ['shell', 'python'] as const) {
    const r = exportFlow(graph, fmt);
    for (const key of ['params.价格', 'env.NAME', 'loop.item']) {
      // 痕迹要能真渲染出来 —— python 的 f-string 会吃掉一层花括号，
      // 所以源码里必须是翻倍后的写法，这里断言的是**渲染结果**
      assert.ok(
        r.text.includes('{{' + key + '}}') || r.text.includes('{{{{' + key + '}}}}'),
        `${fmt} 没留下 ${key} 的痕迹：${r.text}`,
      );
    }
    assert.ok(
      r.skipped.some((s) => s.reason.includes('{{params.价格}}')),
      `${fmt} 没把 params 引用记进 skipped：${JSON.stringify(r.skipped)}`,
    );
  }
});

test('python：f-string 里的花括号要翻倍，占位符才不会被吃掉一层', () => {
  /*
   * f"{{params.X}}" 渲染出 `{params.X}` —— 少一层，
   * 与运行时留下的 `{{params.X}}` 对不上，用户照着去搜会搜不到。
   * 所以生成的是 `{{{{params.X}}}}`（渲染回两层）。
   */
  const r = exportFlow(g([n('p1', 'log', { text: '{{params.X}}' })]), 'python');
  assert.ok(r.text.includes('{{{{params.X}}}}'), `实际：${r.text}`);
  // 没有引用时输出的是普通字符串，那里的 { 是字面量，不该翻倍
  const plain = exportFlow(g([n('p2', 'log', { text: 'a{b' })]), 'python');
  assert.ok(plain.text.includes('"a{b"'), `没引用时不该翻倍：${plain.text}`);
});

/* ================================================================ */
/* 窗格继承                                                          */
/* ================================================================ */

/*
 * 模型名 / system / 温度常常**只配在窗格上** —— 那正是窗格存在的意义。
 * 而导出脚本读的是节点自己的 data，于是导出成 `model=""`：
 * 脚本看着完整、也跑得起来，只是用错了模型，且不报错。
 */
test('python：挂了 API 窗格的大模型节点，要用继承后的生效值', () => {
  const graph = g([
    n('pane1', 'apiPane', { model: 'gpt-4o', system: '你是助手', temperature: 0.9 }),
    n('c1', 'llmChat', { paneId: 'pane1', prompt: '你好' }),
  ]);
  const r = exportFlow(graph, 'python');
  const line = r.text.split('\n').find((l) => l.includes('out_c1'));
  assert.ok(line, `没有导出 c1：${r.text}`);
  assert.ok(line.includes('model="gpt-4o"'), `模型没从窗格继承：${line}`);
  assert.ok(line.includes('system="你是助手"'), `system 没从窗格继承：${line}`);
  assert.ok(line.includes('temperature=0.9'), `温度没从窗格继承：${line}`);
});

/*
 * 三级回落（节点 → 窗格 → 默认）必须只在一处实现。
 * 导出侧另写一份的话，改规则时漏改就是"画布上一个样、脚本里另一个样"。
 */
test('python：节点自己填了就不被窗格盖掉（节点优先）', () => {
  const graph = g([
    n('pane1', 'apiPane', { model: 'pane-model' }),
    n('c1', 'llmChat', { paneId: 'pane1', model: 'node-model', prompt: 'hi' }),
  ]);
  const r = exportFlow(graph, 'python');
  const line = r.text.split('\n').find((l) => l.includes('out_c1'));
  assert.ok(line?.includes('model="node-model"'), `没走节点优先：${line}`);
});

test('python：没挂窗格时温度走 pane.ts 的兜底，不另写一个默认值', () => {
  const r = exportFlow(g([n('c1', 'llmChat', { prompt: 'hi' })]), 'python');
  // 等于默认就不该出现在调用行上（免得与函数签名里那份重复）
  const line = r.text.split('\n').find((l) => l.includes('out_c1'));
  assert.ok(line && !line.includes('temperature='), `默认温度不该写进调用：${line}`);
});

/*
 * 源码守卫：继承规则必须调 pane.ts，不能在导出侧抄一遍。
 */
test('源码：导出脚本的窗格继承走 pane.ts，不自己实现', () => {
  const src = readSrc('engine/scriptExport.ts');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/from '\.\/pane'/.test(body), "scriptExport 没有 import pane");
  assert.ok(/resolveApiPane/.test(body), '没有调 resolveApiPane');
  assert.ok(/findPane/.test(body), '没有调 findPane');
  /*
   * 反过来钉：函数签名里的默认温度必须来自 DEFAULT_TEMPERATURE。
   * 写死 0.3 的话改了默认就变成"画布上跑 0.7、脚本里还是 0.3"。
   */
  assert.ok(
    /temperature=\$\{DEFAULT_TEMPERATURE\}/.test(body),
    '函数签名写死了默认温度，没用 DEFAULT_TEMPERATURE',
  );
  assert.ok(
    !/temperature=\s*0\.3/.test(body),
    '函数签名里出现了写死的 0.3',
  );
});

/* ================================================================ */
/* 具名输出                                                          */
/* ================================================================ */

/*
 * {{id.具名字段}} 以前一律塌成 $OUT_ID（整个节点的输出）。
 * 四个完全不同的引用拿到同一个值，脚本能跑、看着完整，只是全错。
 */
test('shell：HTTP 的具名输出不再塌成整个响应体', () => {
  const r = exportFlow(g([
    n('h1', 'generic-http', { url: 'http://a', method: 'GET' }),
    n('l1', 'log', { text: '状态={{h1.status}} 成功={{h1.ok}}' }),
  ]), 'shell');
  const line = r.text.split('\n').find((l) => l.includes('状态='));
  assert.ok(line, `没导出 l1：${r.text}`);
  assert.ok(line.includes('{{h1.status}}'), `status 被塌掉了：${line}`);
  assert.ok(line.includes('{{h1.ok}}'), `ok 被塌掉了：${line}`);
  assert.ok(!line.includes('$OUT_H1 }'), `仍指向整个响应体：${line}`);
});

/*
 * 主输出（{{id.out}}）该照常取整体 —— 不能因为"有具名字段"就连它也留住。
 */
test('shell：主输出 {{id.out}} 仍取整个节点输出', () => {
  const r = exportFlow(g([
    n('h1', 'generic-http', { url: 'http://a' }),
    n('l1', 'log', { text: '全部={{h1.out}}' }),
  ]), 'shell');
  const line = r.text.split('\n').find((l) => l.includes('全部='));
  assert.ok(line?.includes('$OUT_H1'), `主输出没取整体：${line}`);
});

test('shell：取不到的具名输出要记进 skipped，理由与画布参数分开', () => {
  const r = exportFlow(g([
    n('h1', 'generic-http', { url: 'http://a' }),
    n('l1', 'log', { text: '状态={{h1.status}}' }),
  ]), 'shell');
  const hit = r.skipped.find((s) => s.reason.includes('{{h1.status}}'));
  assert.ok(hit, `没记进 skipped：${JSON.stringify(r.skipped)}`);
  assert.ok(hit.reason.includes('具名输出'), `理由没说清是具名输出：${hit.reason}`);
});

test('python：具名输出同样保留字面量', () => {
  const r = exportFlow(g([
    n('h1', 'generic-http', { url: 'http://a' }),
    n('l1', 'log', { text: '长度={{h1.len}}' }),
  ]), 'python');
  assert.ok(r.text.includes('{{h1.len}}'), `python 侧被塌掉了：${r.text}`);
});

/*
 * 源码守卫：subst 必须认具名输出这张表。
 * 只测"constCardRefs 存在"的话，具名输出这一路漏了照样全绿。
 */
test('源码：导出侧的引用替换认具名输出表（namedOutRefs）', () => {
  const src = readSrc('engine/scriptExport.ts');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/namedOutRefs/.test(body), '没有 namedOutRefs');
  assert.ok(/outputsOf\(/.test(body), '具名输出没走 outputsOf（会与卡片上的出口清单漂移）');
  // 反向：reason 必须区分两种"取不到"
  assert.ok(/具名输出/.test(src), 'skipped 理由没区分具名输出与画布参数');
});

/* ================================================================ */
/* 循环                                                             */
/* ================================================================ */

/*
 * 循环体以前被**平铺**导出 —— 画布上跑 3 次，脚本里只跑 1 次。
 * 脚本能跑、看着完整，只是轮数不对，而这与"拼不出变量"不同：
 * 后者会留下 {{}} 的痕迹，轮数错了什么痕迹都没有。
 */
test('python：固定次数的循环真的生成 for', () => {
  const r = exportFlow(g([
    n('lp', 'loop', { mode: 'times', times: 3 }),
    n('b1', 'log', { text: '轮 {{loop.index}}' }),
  ], [e('lp', 'b1')]), 'python');
  assert.ok(r.text.includes('for out_lp_index in range(out_lp_count)'), `没生成 for：${r.text}`);
  // 循环体必须在 for 内部（有缩进），平铺的话就没有
  const forAt = r.text.indexOf('for out_lp_index');
  const bodyAt = r.text.indexOf('轮');
  assert.ok(bodyAt > forAt, '循环体不在循环内');
  assert.ok(/^\s+print/.test(r.text.split('\n').find((l) => l.includes('轮')) ?? ''), '循环体没缩进');
});

test('python：循环变量换成脚本变量，不再留 {{loop.x}} 字面量', () => {
  const r = exportFlow(g([
    n('lp', 'loop', { mode: 'times', times: 2 }),
    n('b1', 'log', { text: '{{loop.index}}/{{loop.item}}/{{loop.count}}' }),
  ], [e('lp', 'b1')]), 'python');
  assert.ok(!r.text.includes('{{loop.'), `仍留着字面量：${r.text}`);
  assert.ok(r.text.includes('out_lp_item'), 'item 没换成变量');
});

test('shell：固定次数的循环真的生成 while', () => {
  const r = exportFlow(g([
    n('lp', 'loop', { mode: 'times', times: 3 }),
    n('b1', 'log', { text: '轮 {{loop.item}}' }),
  ], [e('lp', 'b1')]), 'shell');
  assert.ok(r.text.includes('while [ "$OUT_LP_INDEX" -lt "$OUT_LP_COUNT" ]'), `没生成 while：${r.text}`);
  assert.ok(r.text.includes('$OUT_LP_ITEM'), `循环变量少了 $：${r.text}`);
  assert.ok(!r.text.includes('{{loop.'), '仍留着字面量');
});

/*
 * 只有 times 能翻 —— list 要按分隔符切、glob 要靠 Rust 展开，
 * 在脚本里重写一遍切分规则，结果就是"画布上 5 项、脚本里 4 项"，
 * 没有报错，只有轮数不对。那正是这里要防的，所以宁可不翻。
 */
test('list 模式不硬翻，但要明说循环体在脚本里只跑一次', () => {
  const r = exportFlow(g([
    n('lp', 'loop', { mode: 'list', separator: '\n', source: 'a1' }),
    n('b1', 'log', { text: '项={{loop.item}}' }),
  ], [e('lp', 'b1')]), 'python');
  assert.ok(!r.text.includes('for out_lp_index'), 'list 模式不该硬生成 for');
  const hit = r.skipped.find((s) => s.id === 'lp' && s.reason.includes('只跑一次'));
  assert.ok(hit, `没说明只跑一次：${JSON.stringify(r.skipped)}`);
});

/* 嵌套：内外层各用各的变量，都叫 loop_item 的话内层会盖掉外层 */
test('嵌套循环用各自的变量名', () => {
  const r = exportFlow(g([
    n('o', 'loop', { mode: 'times', times: 2 }),
    n('i', 'loop', { mode: 'times', times: 2 }),
    n('b2', 'log', { text: '内 {{loop.index}}' }),
  ], [e('o', 'i'), e('i', 'b2')]), 'python');
  assert.ok(r.text.includes('out_o_index'), '缺外层变量');
  assert.ok(r.text.includes('out_i_index'), '缺内层变量');
});

test('源码：导出侧的循环体判定复用 engine/loop.ts，不自写一套', () => {
  const src = readSrc('engine/scriptExport.ts');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/loopBodyOf/.test(body), '没复用 loopBodyOf —— 会出现两套"哪些节点算循环体"');
});

/* ================================================================ */
/* 条件分支                                                           */
/* ================================================================ */

const rule = (id: string, label: string, op: string, value: string, source: string) =>
  ({ id, label, op, value, source, enabled: true });

/*
 * 以前两个分支被平铺导出 —— 画布上走 A，脚本里 A、B 都跑。
 * B 是"推送/删除"这类动作时，脚本会做出画布上不会发生的事，
 * 且这与"拼不出变量"不同：后者留 {{}} 的痕迹，分支跑错了没有。
 */
test('python：条件真的生成 if/else，分支体在分支内', () => {
  const r = exportFlow(g([
    n('a1', 'log', { text: '甲' }),
    n('c1', 'condition', { rules: [rule('r1', '有内容', 'nonEmpty', '', 'a1')], defaultBranch: true }),
    n('y1', 'log', { text: '真分支' }),
    n('n1', 'log', { text: '假分支' }),
  ], [e('c1', 'y1', { branch: 'r1' }), e('c1', 'n1', { branch: '__default__' })]), 'python');
  assert.ok(r.text.includes('if str(') && r.text.includes('else:'), `没生成 if/else：${r.text}`);
  const elseAt = r.text.indexOf('else:');
  const trueAt = r.text.indexOf('真分支');
  const falseAt = r.text.indexOf('假分支');
  assert.ok(trueAt < elseAt && falseAt > elseAt, '两条分支没分到 if 与 else 里');
  // 分支体必须缩进在 if 之下，平铺的话就没有
  assert.ok(/^\s+print/.test(r.text.split('\n').find((l) => l.includes('真分支')) ?? ''), '分支体没缩进');
});

/*
 * 没走的那条分支，其节点在画布上 output 是空串；
 * 脚本里不初始化就是 UnboundLocalError —— 直接崩，而不是拿到空串。
 */
test('python：各分支成员先初始化成空串（汇合点引用未走的分支不崩）', () => {
  const r = exportFlow(g([
    n('a1', 'log', { text: '甲' }),
    n('c1', 'condition', { rules: [rule('r1', '有内容', 'nonEmpty', '', 'a1')], defaultBranch: true }),
    n('y1', 'log', { text: '真' }),
    n('n1', 'log', { text: '假' }),
    n('j1', 'log', { text: '汇合 {{y1.output}}' }),
  ], [
    e('c1', 'y1', { branch: 'r1' }), e('c1', 'n1', { branch: '__default__' }),
    e('y1', 'j1'), e('n1', 'j1'),
  ]), 'python');
  assert.ok(/out_y1 = ""/.test(r.text), `y1 没初始化：${r.text}`);
  assert.ok(/out_n1 = ""/.test(r.text), `n1 没初始化：${r.text}`);
  // 汇合点必须在分支之外
  const elseAt = r.text.indexOf('else:');
  assert.ok(r.text.indexOf('汇合') > elseAt, '汇合点跑到分支里了');
});

test('shell 不翻条件判定，但要明说各分支都会执行', () => {
  const r = exportFlow(g([
    n('a1', 'log', { text: '甲' }),
    n('c1', 'condition', { rules: [rule('r1', '有内容', 'nonEmpty', '', 'a1')] }),
    n('y1', 'log', { text: '真' }), n('n1', 'log', { text: '假' }),
  ], [e('c1', 'y1', { branch: 'r1' }), e('c1', 'n1', { branch: '__default__' })]), 'shell');
  assert.ok(!r.text.includes('if ['), 'shell 不该硬翻判定');
  const hit = r.skipped.find((s) => s.id === 'c1' && s.reason.includes('都会执行'));
  assert.ok(hit, `没说明分支都会执行：${JSON.stringify(r.skipped)}`);
});

/* 正则：JS 的 RegExp 与 python 的 re 语法不完全一致，翻了就是"看着对、判定错" */
test('正则条件不硬翻，但要明说分支都会执行', () => {
  const r = exportFlow(g([
    n('a1', 'log', { text: '甲' }),
    n('c1', 'condition', { rules: [rule('r1', '匹配', 'regex', '^a', 'a1')] }),
    n('y1', 'log', { text: '真' }),
  ], [e('c1', 'y1', { branch: 'r1' })]), 'python');
  assert.ok(!r.text.includes('re.search'), '不该生成正则判定');
  const hit = r.skipped.find((s) => s.id === 'c1' && s.reason.includes('都会执行'));
  assert.ok(hit, `没说明：${JSON.stringify(r.skipped)}`);
});

/*
 * log 的 output 是上游透传（runners/log.ts），而脚本以前只给 print ——
 * 下游 {{a1.output}} 就引用了一个从未定义过的变量，跑起来 NameError。
 * 条件分支必然引用上游，这条不修的话生成的脚本一运行就崩。
 */
test('log 节点在脚本里有赋值（引用它的输出不再是未定义变量）', () => {
  for (const f of ['shell', 'python'] as const) {
    const r = exportFlow(g([
      n('a1', 'log', { text: '甲' }),
      n('a2', 'log', { text: '上游是 {{a1.output}}' }),
    ], [e('a1', 'a2')]), f);
    const decl = f === 'shell' ? /OUT_A1=/ : /out_a1 =/;
    assert.match(r.text, decl, `${f} 里 a1 没有赋值行：${r.text}`);
  }
});

test('源码：条件表达式对 source 为空的情况不硬翻', () => {
  const src = readSrc('engine/scriptExport.ts');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/if \(src0 === ''\) return null/.test(body), "source 为空必须翻不了（画布上是拼全部上游）");
  assert.ok(/op === 'regex'/.test(body) && /return null/.test(body), 'regex 不该硬翻');
});

/* ================================================================ */
/* 每个节点在脚本里都得有变量（否则下游引用就是未定义变量）             */
/* ================================================================ */

/*
 * 画布上这些节点的 output 就是上游透传，而脚本里它们只有一行动作
 * （print / sleep / 播放）—— 从没给 out_xx 赋过值。
 * 下游写 {{xx.output}} 就拿到一个从未定义的变量，跑起来直接崩。
 */
const PASSTHROUGH: string[] = ['beep', 'playAudio', 'wait', 'retry', 'throttle', 'timeout', 'gate'];

for (const k of PASSTHROUGH) {
  test(`脚本里 ${k} 有赋值行（下游引用它不再是未定义变量）`, () => {
    const r = exportFlow(g([
      n('a0', 'log', { text: '上游' }),
      n('b1', k, {}),
      n('c2', 'log', { text: '下游 {{b1.output}}' }),
    ], [e('a0', 'b1'), e('b1', 'c2')]), 'python');
    assert.match(r.text, /out_b1 = /, `${k} 没有赋值行：${r.text}`);
    assert.doesNotMatch(r.text, /out_b1 = ""\s+# b1 的输出在脚本里算不出来/, `${k} 该透传却留空`);
  });
}

/*
 * 反向：不只断言"有赋值"，而是"被引用到的每个变量都有赋值"。
 * 只查某一个变量会放过"赋的是别的东西"。
 */
test('真跑：引用透传节点的输出不崩', () => {
  const r = exportFlow(g([
    n('a0', 'log', { text: '甲' }),
    n('b1', 'wait', { ms: '1' }),
    n('c2', 'log', { text: '拿到 {{b1.output}}' }),
  ], [e('a0', 'b1'), e('b1', 'c2')]), 'python');
  const body = r.text;
  const refs = [...body.matchAll(/\b(out_[a-z0-9_]+)\b/g)].map((m) => m[1]);
  for (const v of new Set(refs)) {
    assert.match(body, new RegExp(`\\b${v} = `), `${v} 被引用却从未赋值`);
  }
});

/* 数学节点的输出是算出来的，不是上游原文 —— 留空并注明，不拿上游顶替 */
test('算不出来的节点留空并注明，不拿上游顶替', () => {
  const r = exportFlow(g([
    n('a0', 'log', { text: '上游' }),
    n('b1', 'math', { op: 'add', a: '1', b: '2' }),
  ], [e('a0', 'b1')]), 'python');
  assert.match(r.text, /out_b1 = ""\s+# b1 的输出在脚本里算不出来/, `没注明：${r.text}`);
  assert.doesNotMatch(r.text, /out_b1 = out_a0/, '不该拿上游顶替');
});

/* 透传表是手抄的，必须有守卫盯住两边不漂移 */
test('源码：透传表里的每一项，其 runner 确实读上游并返回', () => {
  const src = readSrc('engine/scriptExport.ts');
  const m = src.match(/const PASSTHROUGH_KINDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, '没找到 PASSTHROUGH_KINDS');
  const kinds = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(kinds.length > 0, '透传表为空');
  for (const k of kinds) {
    let runner: string;
    try {
      runner = readSrc(`engine/runners/${k}.ts`);
    } catch {
      throw new Error(`透传表里的 ${k} 没有对应的 runner 文件`);
    }
    const body = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(body, /upstreamText\(/, `${k} 的 runner 不读上游，不该在透传表里`);
    assert.match(body, /return \{ output:/, `${k} 的 runner 没有返回值`);
  }
});

/*
 * 反向：runner 里把上游当输出返回的 kind 必须都已登记。
 * 只查正向的话，新增一个透传节点忘了登记，测试照样全绿 ——
 * 而漏登记的代价正是脚本崩。
 */
test('源码：runner 里把上游当输出返回的 kind 都已登记', () => {
  const src = readSrc('engine/scriptExport.ts');
  const m = src.match(/const PASSTHROUGH_KINDS = new Set\(\[([\s\S]*?)\]\)/);
  const listed = new Set([...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]));
  /*
   * 用到 upstreamText，但它是**输入**不是输出 —— 输出是抽取/运算结果。
   * 逐个核过（extract: 抽取命中、ops: 运算值），写白名单而不是放宽判据：
   * 放宽成"不含 upstreamText"的话，log（把上游存进变量再返回）会被放过，
   * 于是"从透传表里删掉 log"这种退化测试全绿。
   */
  const NOT_OUTPUT = new Set(['extract', 'ops']);
  const fs = require('node:fs');
  const dir = require('node:path').join(process.env.AF_SRC ?? '', 'engine/runners');
  let checked = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const body = readSrc(`engine/runners/${f}`)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    if (!/upstreamText\(/.test(body)) continue;
    if (!/return \{ output:/.test(body)) continue;
    const kind = f.replace(/\.ts$/, '');
    if (NOT_OUTPUT.has(kind)) continue;
    checked += 1;
    assert.ok(listed.has(kind), `${kind} 把上游当输出返回却没登记进 PASSTHROUGH_KINDS`);
  }
  assert.ok(checked >= 8, `只核对了 ${checked} 个 runner，判据可能失效`);
});
