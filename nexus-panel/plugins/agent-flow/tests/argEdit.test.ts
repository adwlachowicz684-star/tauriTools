import test from 'node:test';
import assert from 'node:assert/strict';
import { opBriefParts, opBrief } from '../engine/ops';
import { readSrc } from './srcScan';

/*
 * 卡片上的参数**就地编辑**。
 *
 * ================= 为什么需要这一组测试 =================
 *
 * 参数画成下凹的输入格之后，它长得就跟"能填东西的框"一样，
 * 点一下却没反应 —— 比不画成框更让人困惑。
 *
 * 而这类问题**跑不出红**：逻辑没错，只是界面上点不动。
 * 所以一部分断言走源码扫描（与 classNames / uiConsistency 同一套路），
 * 一部分走 opBriefParts 的行为（它是纯函数，能直接跑）。
 */

/* ================= 编辑初值必须是原始值 ================= */

/**
 * 显示用的 text 走过 briefArg()：超 16 字截成"很长的一段文字…"。
 * 拿它当编辑框初值的话，点一下输入框里的字就被截掉了，
 * 一失焦等于把原始值**改写成截断后的那截** —— 不报错，只是数据悄悄少一截。
 */
test('参数格带原始值（不能用截断后的显示文本当编辑初值）', () => {
  const long = '这是一段明显超过十六个字的很长很长的参数内容';
  const parts = opBriefParts('math', { op: 'add', a: long, b: '1' });
  const a = parts.find((p) => p.key === 'a');
  assert.ok(a, 'math 的摘要里必须有 a 这个参数格');
  assert.equal(a?.raw, long, 'raw 必须是完整原始值');
  assert.notEqual(a?.raw, a?.text, 'raw 不能等于截断后的显示文本');
  assert.ok((a?.text ?? '').length <= 17, 'text 仍然要截断（卡片不能撑破）');
});

test('空参数格的初值是空串而不是 ?', () => {
  const parts = opBriefParts('math', { op: 'add' });
  const a = parts.find((p) => p.key === 'a');
  assert.equal(a?.text, '?', '显示仍写 ? —— 一眼看出缺的是哪一个');
  assert.equal(a?.raw, '', '编辑初值必须是空串，否则输入框里会先出现一个 ?');
});

/* ================= 每个参数格都能改 ================= */

test('参数值可就地改：带 edit 且 kind=text', () => {
  const parts = opBriefParts('compare', { op: 'gt', a: '3', b: '5' });
  for (const k of ['a', 'b']) {
    const p = parts.find((x) => x.key === k);
    assert.ok(p, `缺少参数格 ${k}`);
    assert.deepEqual(p?.edit, { key: k, kind: 'text' }, `${k} 必须可就地改`);
  }
});

/**
 * 运算符是**只能选**的：加减乘除、大于小于包含，就那几个。
 * 手填的话填错一个字不报错，只是运行时走到 default 分支给"未知运算"。
 */
test('运算符号格可点开下拉改运算', () => {
  const parts = opBriefParts('math', { op: 'add', a: '1', b: '2' });
  const op = parts.find((p) => p.role === 'op');
  assert.deepEqual(op?.edit, { key: 'op', kind: 'select' }, '运算符格必须能弹下拉');
  assert.equal(op?.raw, 'add', 'raw 给当前运算值，下拉靠它定位选中项');
});

/**
 * 「包含 / 开头 / 结尾」以前是纯文字段，卡片上点不了 ——
 * 旁边 > < 那些符号格却点一下就能改，同一个节点的同一个东西两种待遇，
 * 看着像有的坏了。
 */
test('包含 / 开头 / 结尾也是运算符，同样可点', () => {
  for (const op of ['contains', 'startsWith', 'endsWith']) {
    const parts = opBriefParts('compare', { op, a: '苹果', b: '果' });
    const selectable = parts.filter((p) => p.edit?.kind === 'select');
    assert.equal(selectable.length, 1, `${op} 的摘要里应当有一个可点的运算符格`);
    assert.equal(selectable[0]?.raw, op, `${op} 的下拉要能定位到当前运算`);
  }
});

test('函数名写法（取整 / 转大写 / 随机整数）也可点', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['math', { op: 'round', a: '2.6' }],
    ['text', { op: 'upper', a: 'abc' }],
    ['random', { op: 'int', a: '1', b: '9' }],
    ['random', { op: 'bool' }],
  ];
  for (const [kind, d] of cases) {
    const parts = opBriefParts(kind, d);
    const fn = parts.find((p) => p.role === 'fn');
    assert.ok(fn, `${kind}/${String(d.op)} 应当有函数名格`);
    assert.deepEqual(fn?.edit, { key: 'op', kind: 'select' }, `${kind} 的函数名格要能改运算`);
  }
});

/* ================= 改成 op 段后，导出的那句话不能变 ================= */

/**
 * 「包含」从文字段改成运算符段，partsToText 会自动在两个非文字段之间补空格，
 * 所以结果必须**逐字相同** —— 变了就是导出的说明与卡片上对不上了。
 */
test('包含改成分段后，摘要文本逐字不变', () => {
  assert.equal(opBrief('compare', { op: 'contains', a: '苹果', b: '果' }), '苹果 包含 果');
  assert.equal(opBrief('compare', { op: 'startsWith', a: '苹果', b: '果' }), '苹果 以 果 开头');
  assert.equal(opBrief('compare', { op: 'endsWith', a: '苹果', b: '果' }), '苹果 以 果 结尾');
  assert.equal(opBrief('compare', { op: 'gt', a: '3', b: '5' }), '3 > 5');
  assert.equal(opBrief('math', { op: 'add', a: '1', b: '2' }), '1 ＋ 2');
  assert.equal(opBrief('math', { op: 'min', a: '1', b: '2' }), 'min(1, 2)');
  assert.equal(opBrief('random', { op: 'int', a: '1', b: '5' }), '随机整数 1~5');
  assert.equal(opBrief('random', { op: 'pick', a: 'a,b' }), '随机选一个：a,b');
  assert.equal(opBrief('text', { op: 'replace', a: 'aba', b: 'a', c: 'x' }), 'aba：a → x');
});

/* ================= 源码守卫 ================= */

/**
 * 没有 nodrag，点参数框会变成"拖走整个节点" ——
 * 想改个数字却把节点拖跑了。而这在单测里看不出来，只能扫源码。
 */
test('参数输入框带 nodrag（点它不会变成拖节点）', () => {
  const src = readSrc('components/ArgCell.tsx');
  /*
   * 单行与多行**共用一个 editCls 常量**，所以这里盯的是那个常量而不是两处字面量 ——
   * 两处各写一份的话，新加一种编辑框很容易漏掉 nodrag，
   * 而漏掉的表现是"点这个框会把节点拖走"，在单测里看不出来。
   */
  for (const cls of ['node-arg-in', 'node-arg-area']) {
    const m = src.match(new RegExp(`'${cls} nodrag nopan'`));
    assert.ok(m, `${cls} 必须带 nodrag nopan`);
  }
});

test('下拉也带 nodrag（展开下拉时不能把节点拖走）', () => {
  const src = readSrc('components/ArgCell.tsx');
  const m = src.match(/className="node-arg-sel[^"]*"/);
  assert.ok(m, '必须有 node-arg-sel 这个下拉');
  assert.ok(m?.[0].includes('nodrag'), '下拉必须带 nodrag');
});

/**
 * 按退格删字符时，若不拦住冒泡，画布会把它当成"删除节点" ——
 * 而那时焦点在输入框里，用户根本想不到自己在操作画布。
 */
test('输入框拦住键盘冒泡（否则退格会删掉整个节点）', () => {
  const src = readSrc('components/ArgCell.tsx');
  /*
   * props 收在 shared 对象里（单行/多行共用），所以盯的是 onKeyDown: onKey
   * 而不是 JSX 属性写法 —— 见上面 nodrag 那条的理由。
   */
  assert.ok(/onKeyDown: onKey/.test(src), '输入框必须挂 onKeyDown');
  assert.ok(/e\.stopPropagation\(\)/.test(src), '必须 stopPropagation');
});

/**
 * 多行编辑框**回车不能提交** —— 想换行的人一按回车就退出编辑，
 * 内容还被原样存下去了：不报错，只是那段文本永远只有第一行。
 * 所以多行改成 ⌘/Ctrl+回车 提交。
 */
test('多行编辑框回车不提交（要能换行）', () => {
  const src = readSrc('components/ArgCell.tsx');
  assert.ok(/if \(!isArea \|\| e\.metaKey \|\| e\.ctrlKey\)/.test(src),
    '回车提交必须排除多行（多行要 ⌘/Ctrl+回车）');
  assert.ok(/'area'/.test(readSrc('engine/ops.ts')), "edit.kind 必须有 'area' 这一档");
});

/**
 * 编辑初值用 part.raw。
 * 用 part.text 的话输入框里先出现的是截断后的那截 —— 见上面第一条测试。
 */
test('进入编辑用 raw 而不是 text', () => {
  const src = readSrc('components/ArgCell.tsx');
  assert.ok(/setDraft\(part\.raw/.test(src), '编辑初值必须取 part.raw');
});

/**
 * 卡片拿不到 App 的 setNodes，只能走 Context。
 * 不挂 Provider 的后果是卡片上点了没反应 —— 不报错，最难查。
 */
test('App 挂了 patch 的 Provider（否则卡片上点了没反应）', () => {
  const src = readSrc('App.tsx');
  assert.ok(/NodePatchProvider value=\{patchNode\}/.test(src), '必须把 patchNode 传下去');
});

/**
 * 选项从节点定义里取，不在卡片上另写一份。
 * 两处各写一份列表的话，加一个运算符要改两个地方，
 * 漏改的表现是"面板里能选，卡片上下拉里没有"。
 */
test('下拉选项从节点定义取（不在卡片上另抄一份列表）', () => {
  const src = readSrc('components/ArgCell.tsx');
  assert.ok(/def\.fields\?\.\(d\)/.test(src), '必须走 getDef(...).fields()');
  // 卡片上不许出现写死的运算符清单
  assert.ok(!/'add'/.test(src), '卡片上不允许出现写死的运算值清单');
});

/**
 * 编辑态若把 Handle 换成 input 而丢掉它，已连上的那根参数线会短暂找不到端口：
 * 线还在（按 id 记的），但这一端没了落点，表现为"改完参数，连线飘在半空"。
 */
test('编辑态仍然渲染参数入口（连线不能断）', () => {
  const src = readSrc('components/ArgCell.tsx');
  assert.ok(/const handle = part\.key \? \(/.test(src), '入口必须按 part.key 判');
  // 三个分支（下拉 / 输入框 / 静态）都要带上它
  const n = (src.match(/\{handle\}/g) ?? []).length;
  assert.equal(n, 3, '三个分支都要渲染入口，少一个就会在编辑时断线');
});

/* ============ 参数格铺开到全部卡片（第二批：工具节点） ============ */

/**
 * 摘要渲染收在一处（ArgLine），卡片不各写一份 map。
 *
 * 卡片自己写 map 的话，漏掉 ArgCell 的那张卡片，它的参数就只是一行纯文字 ——
 * 看不出是参数、也点不了，而**没有任何报错**。
 */
test('卡片共用 ArgLine 渲染摘要（不各写一份 map）', () => {
  for (const f of ['components/OpNode.tsx', 'components/ToolNode.tsx']) {
    const src = readSrc(f);
    assert.ok(/<ArgLine /.test(src), `${f} 必须走 ArgLine`);
    assert.ok(!/parts\.map\(\(p, i\)/.test(src), `${f} 不许自己 map 分段`);
  }
});

/**
 * role → 类名只有一份。
 * 两张卡片各写一份的话，加一种 role 就要改两处，漏改的表现是
 * 同一段内容在两张卡片上一个像输入框、一个像正文。
 */
test('参数格的类名只有一份（不各写一份查表）', () => {
  const cell = readSrc('components/ArgCell.tsx');
  assert.ok(/export function argClassOf/.test(cell), 'ArgCell 必须导出 argClassOf');
  for (const f of ['components/OpNode.tsx', 'components/ToolNode.tsx']) {
    assert.ok(!/ARG_CLASS/.test(readSrc(f)), `${f} 不许自带 ARG_CLASS`);
  }
});

/**
 * 工具节点的摘要不许再是整串纯文字。
 *
 * 以前是 `<code className="node-line__code">{summary}</code>`：
 * 「3000 毫秒」「普通 · 你好」看着只是一行说明，看不出哪部分是你填的参数。
 */
test('工具节点摘要不再是整串 code（参数要画成下凹格）', () => {
  const src = readSrc('components/ToolNode.tsx');
  assert.ok(!/node-line__code/.test(src), 'ToolNode 不许再用 node-line__code');
  assert.ok(!/summary=\{/.test(src), 'ToolNode 不许再传整串 summary');
  // 六个节点都要给出 parts
  for (const fn of ['WaitNode', 'LogNode', 'BeepNode', 'PlayAudioNode', 'ClockNode', 'ConstNode']) {
    const body = src.slice(src.indexOf(`export function ${fn}`));
    /* JSX 里数组要包在 {} 里，所以是 parts={ —— 不是 parts=[ */
    assert.ok(/parts=\{/.test(body.slice(0, 2000)), `${fn} 必须给出 parts`);
  }
});

/**
 * 布尔常量的值走下拉 —— 三种种类共用同一个 value 字段、按 when 分流，
 * 卡片上不跟着分的话，布尔常量可以填进「是」「maybe」这类下游认不出的值。
 * 而 selectOptionsOf 不按 when 过滤就会命中第一个（textarea），取到空选项，
 * 表现为"这一格看着能点，实际点不动"。
 */
test('下拉选项先按 when 过滤（同一 key 有多个字段时取对的那一个）', () => {
  const src = readSrc('components/ArgCell.tsx');
  assert.ok(/\.filter\(\(x\) => \(x\.when \? x\.when\(d\) : true\)\)/.test(src),
    'selectOptionsOf 必须按 when 过滤后再找字段');
});

/**
 * 编辑初值必须是完整值，不能是显示用的一截。
 * 播放音频显示的是文件名，若拿文件名当初值，一失焦就把完整路径改成了文件名 ——
 * 不报错，只是运行时找不到文件。
 */
test('播放音频的编辑初值是完整路径（不是显示用的文件名）', () => {
  const src = readSrc('components/ToolNode.tsx');
  const body = src.slice(src.indexOf('export function PlayAudioNode'));
  assert.ok(/val\('path', name, p\)/.test(body.slice(0, 2000)),
    '必须把完整路径 p 作为 raw 传进去');
});

/**
 * 提示词在卡片上直接改。
 *
 * 任务节点改一次提示词要：选中 → 找那一栏 → 改 → 回画布看，
 * 而提示词恰恰是这类节点唯一真正要调的东西。
 */
test('任务节点的提示词可就地编辑（多行）', () => {
  const src = readSrc('components/TaskNode.tsx');
  assert.ok(/<ArgLine\b/.test(src), '必须走 ArgLine');
  assert.ok(/kind: 'area'/.test(src), '提示词必须是多行编辑');
  /*
   * 显示的是截断后的那截，但**编辑初值必须是完整原文** ——
   * 拿截断后的当初值，一失焦就等于把原文改成了那截。
   */
  assert.ok(/raw: prompt/.test(src), '编辑初值必须是完整原文 prompt，不是截断后的 shown');
});

/* ================= 文件 / 表格 / 循环 / 条件 ================= */

/**
 * 这四类曾经全是纯文字摘要。
 *
 * 共同的表现：卡片上写着"读哪个文件""按什么条件保留""重复几次"，
 * 看着像说明，看不出哪部分是你填的参数，也点不动 ——
 * 改一个值必须开右侧面板，而它们恰恰是各自节点唯一真正要调的东西。
 */
test('文件 / 表格 / 循环 / 条件的参数都走 ArgLine（不再是纯文字）', () => {
  for (const f of [
    'components/FsNode.tsx',
    'components/TableNode.tsx',
    'components/LoopNode.tsx',
    'components/ConditionNode.tsx',
  ]) {
    const src = readSrc(f);
    assert.ok(/<ArgLine\b/.test(src), `${f} 必须走 ArgLine（否则参数只是纯文字）`);
  }
  // 文件节点原本是 <code className="node-line__code">，整条路径不可点
  assert.ok(!/node-line__code/.test(readSrc('components/FsNode.tsx')),
    'FsNode 不许再用 node-line__code');
  /*
   * 表格节点原本是 briefOf() 返回一整串字符串。
   * 这个函数的存在就等于"参数仍是纯文字"，所以直接判它不存在。
   */
  assert.ok(!/function briefOf/.test(readSrc('components/TableNode.tsx')),
    'TableNode 不许再有 briefOf（整串摘要）');
});

/**
 * 路径类参数的编辑初值必须是完整路径。
 *
 * 显示为了放得下会压成 `…/末尾两级`，拿那一截当编辑初值的话，
 * 点一下输入框里就只剩 `…/a/b`，一失焦等于把完整路径改坏了 ——
 * 不报错，只是运行时找不到文件。
 */
test('文件与表格的路径：显示截断、编辑用完整值', () => {
  const fs = readSrc('components/FsNode.tsx');
  const i = fs.indexOf('function pathCell');
  assert.ok(i >= 0, 'FsNode 要有统一的 pathCell');
  const body = fs.slice(i, i + 600);
  assert.ok(/raw: full/.test(body), 'raw 必须是完整路径 full');
  assert.ok(/text: shortPath\(full\)/.test(body), 'text 才是截断后的显示');

  const tb = readSrc('components/TableNode.tsx');
  assert.ok(/raw: p/.test(tb), '读表格的编辑初值必须是完整路径 p');
});

/**
 * 循环的分隔符**不给**就地编辑 —— 这是刻意的。
 *
 * 它的值可能是真正的换行符（默认就是 '\n'），单行输入框装不下换行，
 * 编辑框里只剩一个空串，一失焦就把分隔符改没了 ——
 * 不报错，只是列表从此切不开。宁可让它留在面板里改。
 */
test('循环的分隔符不可就地编辑（换行符在单行输入框里会被改坏）', () => {
  const src = readSrc('components/LoopNode.tsx');
  // 分隔符仍要显示出来（只是不可改）
  assert.ok(/text: sepLabel\(d\.separator\)/.test(src), '分隔符要显示出来');
  assert.ok(!src.includes("key: 'separator'"), '分隔符不能做成可编辑的格子');

  /*
   * 反过来：次数与通配符**必须**可改 ——
   * 只钉"分隔符不可改"的话，把整张卡改成不可编辑它照样通过，
   * 而那比"分隔符能被改坏"更糟（循环节点从此一个参数都调不动）。
   */
  assert.ok(src.includes("edit: { key: 'times', kind: 'text' }"), 'times 必须可就地编辑');
  assert.ok(src.includes("edit: { key: 'pattern', kind: 'text' }"), 'pattern 必须可就地编辑');
});

/**
 * 多条件规则不给就地编辑。
 *
 * 多条件时值在 rules[i].conditions[j].value，卡片上改的是 rules[i].value ——
 * 写进去对显示毫无影响，表现为"改了一下，卡片纹丝不动"，而值确实存进去了。
 */
test('条件：多条件规则不给就地编辑（写了也没反应）', () => {
  const src = readSrc('components/ConditionNode.tsx');
  assert.ok(/const multi = \(r\.conditions \?\? \[\]\)\.length > 0/.test(src));
  assert.ok(/multi\s*\n?\s*\?\s*\[\{ role: 'text', text: describeRule\(r\) \}\]/.test(src),
    '多条件要退回 describeRule 的纯文字，且不带 edit');
  // 单条件的写入路径必须带数组下标
  assert.ok(/path: `rules\.\$\{i\}\.op`/.test(src), 'op 要写进 rules[i].op');
  assert.ok(/path: `rules\.\$\{i\}\.value`/.test(src), 'value 要写进 rules[i].value');
});

/**
 * 算子名字不许出现两遍。
 *
 * 徽章（图标 + 配色）与右边参数格若都写算子名，卡片上会出现两个「包含」。
 */
test('条件徽章只留图标（算子名交给参数格，不重复）', () => {
  const src = readSrc('components/ConditionNode.tsx');
  /*
   * 徽章的 title 里**可以**带算子名（hover 要看得到全称），
   * 所以不能简单地判"徽章里没有 label" —— 那样会误伤 title。
   * 真正要钉的是：图标 span 之后直接闭合，中间没有文本子节点。
   */
  assert.ok(
    /<span className="cond-op-icon">\{OP_META\[r\.op\]\?\.icon \?\? '\?'\}<\/span>\s*<\/span>/.test(src),
    '徽章只留图标（算子名交给参数格，不许出现两个「包含」）',
  );
  assert.ok(/className="cond-op"/.test(src), '徽章仍要在（配色与识别）');
});

/**
 * ArgLine 支持容器类名覆盖。
 *
 * 文件节点要沿用 node-line--path（等宽 + 危险色），没有这个口子就只能
 * 另写一个容器 —— 而那正是"同一段参数在两张卡片上长得不一样"的来源。
 */
test('ArgLine 可覆盖容器类名（文件节点要沿用 node-line--path）', () => {
  const cell = readSrc('components/ArgCell.tsx');
  assert.ok(/className\?: string/.test(cell), 'ArgLine 要有可选 className');
  assert.ok(/className \?\? 'node-line node-line--brief node-brief'/.test(cell));
  const fs = readSrc('components/FsNode.tsx');
  assert.ok(/className=\{`node-line node-line--path/.test(fs), 'FsNode 要沿用 path 行样式');
});
