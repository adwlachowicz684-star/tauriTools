import test from 'node:test';
import assert from 'node:assert/strict';
import { argTypeIssues, valueKindOf, argTypedKinds } from '../engine/argTypes';
import { validateNode, badgeTextOf } from '../engine/nodeValidate';
import { readSrc } from './srcScan';

/**
 * 参数类型校验。
 *
 * 核心场景（用户实测）：
 *   比较节点选「包含」→ 填「苹果」「果」 → 绿灯
 *   把运算改成「大于」            → **仍然绿灯，但结果是错的**
 *
 * 运行时不会报错：`compareOp` 里两边不是数字就退化成文本比较，
 * 「苹果」>「果」按字典序成立，输出 true。
 * 这是"有合法降级行为"的错误，运行时校验抓不到，只能静态判定。
 */

const cmp = (op: string, a: unknown, b: unknown) =>
  argTypeIssues('compare', { kind: 'compare', op, a, b });

test('包含 → 大于：改成数字运算后立刻报出类型错', () => {
  // 第一步：包含 + 文本，没问题
  assert.deepEqual(cmp('contains', '苹果', '果'), []);
  // 第二步：只改运算，值没动 —— 必须报出来
  const bad = cmp('gt', '苹果', '果');
  assert.equal(bad.length, 2, '两边都要报');
  assert.equal(bad[0].expect, 'num');
  assert.equal(bad[0].actual, 'text');
  assert.match(bad[0].message, /数字/);
  assert.match(bad[0].message, /文本/);
});

test('报错要说清是哪个参数（只说"类型不对"等于没报）', () => {
  const bad = cmp('gt', '苹果', '果');
  assert.match(bad[0].message, /左边/);
  assert.match(bad[1].message, /右边/);
});

test('改回数字绿灯就恢复 —— 不能一直红着', () => {
  assert.deepEqual(cmp('gt', '10', '5'), []);
});

/* ---------------- 等价比大小：什么都能比 ---------------- */

test('等于 / 不等于：文本与数字都放行', () => {
  assert.deepEqual(cmp('eq', '苹果', '果'), []);
  assert.deepEqual(cmp('eq', '10', '5'), []);
  assert.deepEqual(cmp('neq', 'abc', '1'), []);
});

/* ---------------- 模板引用一律放行 ---------------- */

test('模板引用不校验 —— 编辑时看不到值，猜错比漏报更糟', () => {
  assert.deepEqual(cmp('gt', '{{上游.output}}', '5'), []);
  assert.deepEqual(cmp('gt', '{{a.output}}', '{{b.output}}'), []);
  assert.deepEqual(cmp('contains', '{{x.output}}', '果'), []);
});

test('空值不校验 —— 那是"没填"，归缺参管，不重复报', () => {
  assert.deepEqual(cmp('gt', '', ''), []);
  assert.deepEqual(cmp('gt', '   ', '5'), []);
});

/* ---------------- 数学运算 ---------------- */

test('数学：四则运算两边都要数字', () => {
  const m = (op: string, a: unknown, b: unknown) =>
    argTypeIssues('math', { kind: 'math', op, a, b });
  assert.deepEqual(m('add', '1', '2'), []);
  assert.deepEqual(m('add', 'abc', '2').length, 1);
  assert.deepEqual(m('add', 'abc', 'def').length, 2);
});

test('数学：单目运算只校验第一个数', () => {
  const m = (op: string, a: unknown, b: unknown) =>
    argTypeIssues('math', { kind: 'math', op, a, b });
  // 取整是单目，b 用不到 —— 不该报 b
  assert.deepEqual(m('round', '3.7', '随便什么'), []);
  assert.deepEqual(m('round', 'abc', '随便什么').length, 1);
});

test('数学：小数与负数算数字', () => {
  const m = (op: string, a: unknown, b: unknown) =>
    argTypeIssues('math', { kind: 'math', op, a, b });
  assert.deepEqual(m('add', '-3.5', '2e3'), []);
});

/* ---------------- 带单位算文本 ---------------- */

test('「100元」「50%」算文本 —— 它们进 num() 会变 0', () => {
  assert.equal(valueKindOf('100元'), 'text');
  assert.equal(valueKindOf('50%'), 'text');
  assert.equal(valueKindOf('100'), 'num');
  assert.equal(valueKindOf('-2.5'), 'num');
});

/* ---------------- 文本与随机 ---------------- */

test('文本：截取的下标要数字，源文本要文本', () => {
  const t = argTypeIssues('text', { kind: 'text', op: 'substr', a: 'abcdef', b: 'x', c: '3' });
  assert.equal(t.length, 1);
  assert.equal(t[0].key, 'b', '只有下标 b 错了');
  assert.equal(t[0].expect, 'num');
});

test('随机：上下界要数字', () => {
  assert.deepEqual(argTypeIssues('random', { kind: 'random', op: 'int', a: '1', b: '10' }), []);
  assert.equal(argTypeIssues('random', { kind: 'random', op: 'int', a: 'abc', b: '10' }).length, 1);
});

/* ---------------- 没有契约的运算一律放行 ---------------- */

test('表里没有的运算不校验 —— 宁可漏报也不误报', () => {
  assert.deepEqual(cmp('未知运算', '苹果', '果'), []);
  assert.deepEqual(argTypeIssues('math', { kind: 'math', op: 'xxx', a: 'a', b: 'b' }), []);
});

test('没有契约的节点种类不校验', () => {
  assert.deepEqual(argTypeIssues('task', { kind: 'task', a: 'x' }), []);
  assert.deepEqual(argTypeIssues(undefined, { a: 'x' }), []);
  assert.deepEqual(argTypeIssues('compare', null), []);
});

/* ---------------- 接入圆点 ---------------- */

test('类型错 → 圆点红色 + 徽章显示「错参」', () => {
  const issue = validateNode({ data: { kind: 'compare', op: 'gt', a: '苹果', b: '果' } });
  assert.equal(issue.level, 'error');
  assert.equal(issue.typeError, true);
  assert.equal(badgeTextOf(issue), '错参');
});

test('缺参仍显示「缺参」，不与错参混淆', () => {
  // 比较节点没填值 → 缺参，不是错参
  const issue = validateNode({ data: { kind: 'compare', op: 'gt', a: '', b: '' } });
  assert.equal(issue.typeError, undefined, '空值不走类型校验');
});

test('正常配置是绿灯', () => {
  const issue = validateNode({ data: { kind: 'compare', op: 'gt', a: '10', b: '5' } });
  assert.equal(issue.level, 'ok');
});

test('有契约的种类都在清单里（用于核对覆盖）', () => {
  const kinds = argTypedKinds();
  for (const k of ['math', 'compare', 'text', 'random']) {
    assert.ok(kinds.includes(k), `${k} 该有类型契约`);
  }
});

/* ------------------------------------------------------------------ */
/* 覆盖守卫：加新运算不能忘了配类型规则                                  */
/* ------------------------------------------------------------------ */

/*
 * 节点定义里列出的每个运算，类型表里都要有对应 ——
 * 或明确写着"不校验"。
 *
 * 这张表是**手写维护**的（engine/argTypes.ts 的 RULES），
 * 加一个新运算时很容易只在节点定义里加、忘了配规则。
 * 后果是"漏报"：填错了类型不标红，而漏报在界面上完全没有痕迹 ——
 * 不像报错那样会被发现，只能靠这条守卫盯。
 *
 * 所以这里直接拿节点定义文件里的选项去比对，
 * 而不是再抄一份运算清单（抄一份本身就可能抄漏）。
 */
test('节点定义里的每个运算都有类型规则或显式豁免', () => {
  const pairs: { file: string; kind: string }[] = [
    { file: 'nodes/defs/math.ts', kind: 'math' },
    { file: 'nodes/defs/compare.ts', kind: 'compare' },
    { file: 'nodes/defs/text.ts', kind: 'text' },
    { file: 'nodes/defs/random.ts', kind: 'random' },
  ];
  const rulesSrc = readSrc('engine/argTypes.ts');

  for (const { file, kind } of pairs) {
    const def = readSrc(file);
    // 节点定义里 op 这个 select 的选项
    const opts = [...def.matchAll(/\{\s*value:\s*'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]);
    assert.ok(opts.length > 0, `${file} 里没解析到运算选项 —— 守卫本身失效了`);

    // 取该 kind 的 rules 块
    /*
     * 用 [\s\S] 而不是 . —— 默认的 . 不跨行，
     * 而 `by: 'op',` 与 `rules: {` 之间是有换行的。
     * 用 . 的话正则永远匹配不上，守卫会去报"没有这一节"，
     * 那是**守卫自己错了**，比没有守卫更糟（会误导人去改对的代码）。
     */
    const block = new RegExp(`\\n  ${kind}:\\s*\\{\\s*by:[\\s\\S]*?rules:\\s*\\{([\\s\\S]*?)\\n  \\},`).exec(rulesSrc);
    assert.ok(block, `类型表里没有 ${kind} 这一节`);
    const covered = [...block[1].matchAll(/^\s{6}([a-zA-Z0-9_]+):/gm)].map((m) => m[1]);

    const missing = opts.filter((o) => !covered.includes(o));
    assert.deepEqual(missing, [], `${kind} 有运算没配类型规则：${missing.join('、')}`);
  }
});

/*
 * 「选一个」必须用逗号分隔的列表，那是文本 ——
 * 按数字校验会把 "a,b,c" 标红，那是误报，比漏报更糟。
 */
test('随机选一个 / 打乱按文本校验，不能按数字', () => {
  // "a,b,c" 是合法用法，不该报错
  assert.deepEqual(argTypeIssues('random', { kind: 'random', op: 'pick', a: 'a,b,c' }), []);
  assert.deepEqual(argTypeIssues('random', { kind: 'random', op: 'shuffle', a: 'x,y' }), []);
  // 而整数上下界仍要数字
  assert.ok(argTypeIssues('random', { kind: 'random', op: 'int', a: 'abc', b: '10' }).length > 0);
});

/*
 * 分段：三个参数，其中「第几段」必须是数字。
 *
 * 漏了它的后果很隐蔽 —— 填非数字时 num() 变 0，减 1 得 -1，
 * split 的实现里 `part < 0` 直接返回**整串**。
 * 表现为"我填了第 2 段，它却把整串原样给我"，不报错、看不出原因。
 */
test('分段：第几段按数字校验', () => {
  assert.deepEqual(argTypeIssues('text', { kind: 'text', op: 'split', a: 'x,y', b: ',', c: '2' }), []);
  const bad = argTypeIssues('text', { kind: 'text', op: 'split', a: 'x,y', b: ',', c: '第二段' });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].key, 'c');
  assert.equal(bad[0].expect, 'num');
});

/**
 * 规则表与卡片摘要必须**参数一致**。
 *
 * 两张表都是手写的，且互相独立 —— 一边列了三个参数、另一边只画两个，
 * 那个多出来的参数就在卡片上彻底看不见（用户填了也不知道填在哪）。
 * split 就是这样：摘要画了 a、c，把分隔符 b 丢了。
 *
 * 所以这里拿摘要分段（ops.ts 的 briefOf）里实际出现的参数 key，
 * 去比对规则表（argTypes.ts）里列的参数 key。
 * 只查**带参数格**的那些运算（用 V('x')），纯文字的跳过。
 */
test('规则表列出的参数与卡片摘要画出来的一致', () => {
  const opsSrc = readSrc('engine/ops.ts');
  const rulesSrc = readSrc('engine/argTypes.ts');

  const pairs: { kind: string; op: string; fn: string }[] = [
    { kind: 'text', op: 'split', fn: 'split' },
    { kind: 'text', op: 'substr', fn: 'substr' },
    { kind: 'text', op: 'replace', fn: 'replace' },
    { kind: 'math', op: 'add', fn: 'add' },
    { kind: 'compare', op: 'gt', fn: 'gt' },
  ];

  for (const { kind, op, fn } of pairs) {
    // 摘要里该运算用到的参数格
    /*
     * 结尾只认 `];`，**不要求它前面有换行**。
     *
     * 写成 `\n\s*\];` 的话，单行写完的 return（`... V('c')];`）
     * 结尾不带换行，正则就一路吃到**下一个** case 的 `];` ——
     * 于是 replace 的参数被数成 6 个（把自己的和 substr 的加起来）。
     * 那是**守卫自己错了**，比没有守卫更糟：会逼人去改对的代码。
     */
    const m = opsSrc.match(new RegExp(`case '${fn}':\\s*return \\s*\\[([\\s\\S]*?)\\];`));
    if (!m) continue; // 该运算不是 case 写法（如 math 走 sign 分支），跳过
    const briefKeys = [...m[1].matchAll(/V\('([abc])'\)/g)].map((x) => x[1]).sort();

    // 规则表里该运算列的参数
    const rm = new RegExp(`\\n\\s{6}${op}:\\s*(?:N|T|A)\\(([^)]*)\\)|\\n\\s{6}${op}:\\s*M\\(\\{([^}]*)\\}`).exec(rulesSrc);
    if (!rm) continue;
    const raw = rm[1] ?? rm[2] ?? '';
    const ruleKeys = [...raw.matchAll(/([abc]):/g)].map((x) => x[1]).concat(
      [...raw.matchAll(/'([abc])'/g)].map((x) => x[1]),
    );
    const uniq = [...new Set(ruleKeys)].sort();

    assert.deepEqual(
      briefKeys, uniq,
      `${kind}.${op}：摘要画了 [${briefKeys}]，规则列了 [${uniq}] —— 两者要一致`,
    );
  }
});
