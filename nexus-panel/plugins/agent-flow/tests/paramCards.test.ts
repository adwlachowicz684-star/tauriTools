/*
 * ==================================================================
 * 参数卡片层的守卫
 *
 * ================= 为什么需要它 =================
 *
 * 参数卡片层（nodes/paramCards.ts）是为了治"同一个参数在几个节点上各写一遍"。
 * 抽完之后如果不盯着，很快又会有人（包括以后的我）在节点里直接写一份 ——
 * 因为**直接写最短**，只有比对两个文件才发现已经有人写过了。
 *
 * 而这类重复失效是安静的：改了卡片库，旧节点那份不跟着变，
 * 表现为"两个节点的同一个参数长得不一样"，不报错。
 *
 * ================= 这条守卫盯什么 =================
 *
 * 1. 库里的每张卡必须被**两个以上**节点真用（防止过度抽象：
 *    只在一个节点出现的参数搬进库里，只会让改它要翻两个文件）
 * 2. 同一个参数（key + label + placeholder 全同）不许在**两个以上节点文件**
 *    里各写一份字面量 —— 那正是卡片层要消灭的东西
 * 3. card() 取不存在的 id 要抛错，而不是静默返回一个空字段
 *
 * ==================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSrc, AF_SRC } from './srcScan';
import { PARAM_CARDS, card } from '../nodes/paramCards';
import {
  PASS_CHECK_OPTIONS, PASS_CHECK_LABEL, isPassCheck, passCheckLabel,
} from '../engine/passCheck';
import { OP_META } from '../types';
import { describeRule } from '../engine/condition';
import { describeRule as describeParallelRule } from '../engine/parallel';
import { describeBlock } from '../engine/blockApi';

const DEFS = path.join(AF_SRC, 'nodes', 'defs');

function defFiles(): string[] {
  return fs.readdirSync(DEFS).filter((f) => /\.tsx?$/.test(f));
}

/** 某个节点文件里用了哪些卡片 id */
function usedCards(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/card\(\s*'([^']+)'/g)) out.add(m[1]);
  return out;
}

/*
 * 剥注释再扫。
 *
 * 注释里为了说明"以前是怎么错的"，正好要把坏写法原样写出来 ——
 * **不剥的话说明本身就会让检查永远失败**。
 * 这个坑在本仓库踩过不止一次（见 tests/uiConsistency.test.ts 的同名函数）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('库里的每张卡都被两个以上节点真用（防过度抽象）', () => {
  const files = defFiles();
  const users = new Map<string, string[]>();
  for (const f of files) {
    for (const id of usedCards(stripComments(readSrc('nodes/defs/' + f)))) {
      users.set(id, [...(users.get(id) ?? []), f]);
    }
  }
  const orphan = Object.keys(PARAM_CARDS).filter(
    (id) => (users.get(id) ?? []).length < 2,
  );
  assert.deepEqual(
    orphan,
    [],
    `这些卡片只被一个节点用到，不该进库（留在节点里更清楚）：${orphan.join(', ')}`
    + `；实际使用者：${orphan.map((o) => `${o}->${(users.get(o) ?? []).join('|')}`).join(' ; ')}`,
  );
});

test('同一个参数不许在两个以上节点里各写一份字面量', () => {
  /*
   * 判据取 key + label + placeholder 三者全同 ——
   * 只比 key 会误报（`path` 在声音节点和文件节点里是两个不同的东西，
   * 各写一份是对的），加上 label/placeholder 才说明"是同一张卡"。
   */
  type Sig = { key: string; label: string; ph: string };
  const where = new Map<string, string[]>();

  for (const f of defFiles()) {
    const src = stripComments(readSrc('nodes/defs/' + f));
    const seen = new Set<string>();
    /*
     * 只看**字面量**块（type: 'xxx' 开头、带 key 的那种）。
     * `card('...')` 调用不是字面量，不会被这里匹配到 ——
     * 这正是"已经抽到库里"的情况，不该报。
     */
    for (const m of src.matchAll(/\{\s*type:\s*'(\w+)'([\s\S]{0,600}?)\n\s*\}/g)) {
      const blk = m[2];
      const km = blk.match(/key:\s*'([^']+)'/);
      if (!km) continue; // note 之类没有 key，跳过
      const lm = blk.match(/label:\s*'([^']*)'/);
      const pm = blk.match(/placeholder:\s*'([^']*)'/);
      /*
       * options 也进指纹 ——
       * 「运算」这张卡在数学节点和文本节点上都叫「运算」，
       * 但选项是两套（加减乘除 vs 拼接取长度），**不是同一张卡**，
       * 各写一份是对的。只比 label 会把它误报成重复。
       */
      const om = blk.match(/options:\s*\[([\s\S]*?)\n\s*\]/);
      const opts = om ? (om[1].match(/value:\s*'([^']+)'/g) ?? []).join(',') : '';
      const sig: Sig = {
        key: km[1],
        label: lm ? lm[1] : '',
        ph: pm ? pm[1] : '',
      };
      // 光秃秃的 { key }（label/placeholder 都没有）不成指纹，跳过
      if (!sig.label && !sig.ph && !opts) continue;
      const k = JSON.stringify([sig, opts]);
      if (seen.has(k)) continue;
      seen.add(k);
      where.set(k, [...(where.get(k) ?? []), f]);
    }
  }

  const dup = [...where.entries()]
    .filter(([, fs2]) => fs2.length > 1)
    .map(([k, fs2]) => `${k} -> ${fs2.join(', ')}`);

  /*
   * 另一半：**库里已经有这张卡，节点却自己抄了一份**。
   *
   * 只查"两个以上节点各写一份"抓不到这种 ——
   * 卡片被抽进库之后，往往只剩一个节点还留着字面量，
   * 于是"多个文件"这个条件不成立，守卫就安静了。
   * 而这恰恰是最该报的：库里改了、这份不跟着变。
   */
  const libSigs = new Set(
    Object.values(PARAM_CARDS).map((c) => {
      const opts = Array.isArray(c.options)
        ? (c.options as { value: string }[]).map((o) => `value: '${o.value}'`).join(',')
        : '';
      return JSON.stringify([{ key: c.key, label: c.label ?? '', ph: c.placeholder ?? '' }, opts]);
    }),
  );
  const shadow = [...where.entries()]
    .filter(([k]) => libSigs.has(k))
    .map(([k, fs2]) => `${k} -> ${fs2.join(', ')}`);

  assert.deepEqual(
    [...dup, ...shadow],
    [],
    `这些参数应改用 nodes/paramCards.ts 的 card()（不要各写一份字面量）：\n`
    + `  多个节点各写一份：${dup.join(' ; ') || '无'}\n`
    + `  库里已有却自己抄了一份：${shadow.join(' ; ') || '无'}`,
  );
});

test('库里导出的每个函数都要有人用（防「抽了没接上」）', () => {
  /*
   * ================= 这条守卫的来历 =================
   *
   * soundSourceHint 抽进 paramCards 之后**一个调用点都没有**，
   * 而 nodes/defs/beep.ts 里 inline 写着同一句表达式。
   *
   * 于是"声音来源的说明"有两个真源：库里那份没人读，节点里那份才是真的。
   * 两份的兜底值一旦写得不一样（这里 'preset'、那里 'file'），
   * 表现是"换了音效来源，卡片出现了、说明还是上一种的" ——
   * 不报错，只有文字不对，而且只有并排看两个文件才找得到原因。
   *
   * 这正是"抽公共层"最容易留的尾巴：**抽了、没接上**。
   * 抽的那个人以为完事了，用的人还在原地写自己的那份。
   *
   * 所以这里不做"卡片 id 被几个节点用"那种统计（那条已有），
   * 而是直接问：库里 export 出来的东西，有没有人 import 它。
   * ==================================================================
   */
  const lib = readSrc('nodes/paramCards.ts');
  const exported = [...lib.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1]);
  assert.ok(exported.length >= 3, `没扫到库里的导出函数：${exported.join(', ')}`);

  // 除 paramCards.ts 之外的全部源码（含测试）—— 谁用了它都算
  const users = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'docs' || e.name === 'node_modules') continue;
        walk(abs);
      } else if (/\.tsx?$/.test(e.name) && !abs.endsWith(path.join('nodes', 'paramCards.ts'))) {
        users.add(stripComments(fs.readFileSync(abs, 'utf-8')));
      }
    }
  };
  walk(AF_SRC);

  const all = [...users].join('\n');
  const dead = exported.filter(
    (n) => !new RegExp(`(?<![\w$.])${n}(?![\w$])`).test(all),
  );
  assert.deepEqual(
    dead,
    [],
    `paramCards.ts 里这些导出没人用 —— 要么接上，要么删掉`
    + `（留着就是第二个真源，改了不生效也不报错）：${dead.join(', ')}`,
  );
});

test('card() 取不存在的 id 要抛错（不能静默返回空字段）', () => {
  /*
   * 静默返回 {} 的话，面板上会凭空多出一个没有 type 的字段 ——
   * 而看不出是哪张卡拼错了（id 拼错是最容易犯的）。
   */
  assert.throws(() => card('sound.volume-not-exist'), /没有这张参数卡片/);
});

test('card() 返回的是拷贝，改它不会污染库里那张', () => {
  /*
   * 直接返回库里那个对象的话，某个节点上的覆盖（when / hint）
   * 会写回库，于是**其它节点上这张卡也跟着变** ——
   * 表现是"改了 A 节点，B 节点的同一个参数也变了"，且不报错。
   */
  const a = card('sound.volume', { hint: '本节点专用说明' });
  const b = card('sound.volume');
  assert.equal(a.hint, '本节点专用说明');
  assert.notEqual(
    b.hint,
    '本节点专用说明',
    '覆盖写回了库里 —— 其它节点上这张卡会被连带改掉',
  );
  assert.equal(PARAM_CARDS['sound.volume'].hint, '0 ~ 1，默认 0.6');
});

/*
 * ==================================================================
 * custom 块的 spec.keys 必须与它自己的 key 对上
 *
 * ================= 为什么要盯 =================
 *
 * `spec.keys` 是**契约与参数文档取参数名的唯一来源**：
 *   · engine/nodeSpec.ts 的 deriveParams() —— 拼装方看到的字段清单
 *   · scripts/gen-node-docs.mjs —— docs/nodes/*.params.md 的参数表
 * 而 `key` 只用于面板内部的字段身份。两个名字不一致时，
 * **契约与文档会去宣传另一个名字**，全程不报错。
 *
 * 实际踩到的一次：ocr.tsx 抄 llmChat 的两块图片字段时把 spec.keys 抄错了
 * （地址那块写成 ['path']、本地路径那块写成 ['prompt','detail']），
 * 于是 ocr 的参数文档里"图片地址"被写作 `path`，真正的 `path` 没出现，
 * 而「识别要求 / 图片细节」被挂上了"图片来源=本地文件"的显示条件。
 *
 * 这种错在 2285 条测试里安静地待着 ——
 * 因为之前的守卫只做正向对账（声明了什么就有什么），
 * 从不检查"声明的名字是不是它自己"。
 * ==================================================================
 */
test('custom 块的 spec.keys 必须包含它自己的 key', () => {
  const files = [
    ...defFiles().map((f) => 'nodes/defs/' + f),
    /* 带 JSX 的共用卡也扫：那里同样会写 spec.keys */
    'nodes/imageCards.tsx',
  ];
  const bad: string[] = [];

  for (const rel of files) {
    const src = stripComments(readSrc(rel));
    for (const m of src.matchAll(/type:\s*'custom'/g)) {
      /*
       * 只看这一块里 `render:` 之前的部分：
       * spec 与 key 都写在 render 前面，截到 render 就不会
       * 顺带把下一个字段的 key 也捞进来。
       */
      const head = src.slice(m.index, m.index + 400).split('render:')[0];
      const sm = head.match(/spec:\s*\{\s*keys:\s*\[([^\]]+)\]/);
      if (!sm) continue; // 没有 spec.keys 的走 deriveParams 的兜底分支，不管
      const km = head.match(/key:\s*'([^']+)'/);
      if (!km) continue; // 只有 spec.keys、没有 key 的块（如整组面板），不比对
      const keys = sm[1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter(Boolean);
      if (!keys.includes(km[1])) {
        bad.push(`${rel}: key='${km[1]}' 但 spec.keys=[${keys.join(', ')}]`);
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    'custom 块的 spec.keys 与 key 对不上 —— 契约与参数文档会宣传错的参数名（不报错）：\n  '
    + bad.join('\n  '),
  );
});

test('图片那两块的 render 由 llmChat 与 ocr 共用一份，不许各写一份', () => {
  /*
   * 各写一份正是 spec.keys 被抄错的那次事故的来源：
   * 抄的时候 render（二十几行 JSX）会被认真对待，
   * 而 spec.keys 这种一行的小字段最容易照抄错。
   *
   * 断言取两处：
   *   1. 两个节点都用的是 nodes/imageCards.tsx 里那一份
   *   2. JSX 的**内容**（"图片地址"这个 label）不出现在任何 def 里
   *      —— 谁把它抄回节点，第 2 条立刻红
   */
  for (const f of ['llmChat.tsx', 'ocr.tsx']) {
    const src = stripComments(readSrc('nodes/defs/' + f));
    assert.ok(
      /render:\s*renderImageUrl/.test(src) && /render:\s*renderImagePath/.test(src),
      `${f} 没有用 nodes/imageCards.tsx 里共用的 render（图片那两块又各写了一份？）`,
    );
  }

  const lib = stripComments(readSrc('nodes/imageCards.tsx'));
  assert.ok(
    /renderImageUrl/.test(lib) && /renderImagePath/.test(lib),
    'nodes/imageCards.tsx 里找不到这两份 render —— 守卫匹配不到会假通过',
  );

  const copied = defFiles().filter((f) =>
    stripComments(readSrc('nodes/defs/' + f)).includes('图片地址'),
  );
  assert.deepEqual(
    copied,
    [],
    `这些 def 里出现了「图片地址」的 JSX —— 应该改用 nodes/imageCards.tsx：${copied.join(', ')}`,
  );
});

/*
 * ==================================================================
 * 判定方式（闸门「条件」/ 重试「合格条件」）只有一处定义
 *
 * ================= 为什么盯这条 =================
 *
 * 这份取值清单以前散在五处：types.ts 的类型、passCheck.ts 的类型与
 * PASS_CHECK_LABEL、paramCards.ts 的 options、nodeValidate.ts 里**两处**
 * 硬编码数组。
 *
 * 已经付出过代价：两份标签分叉成「正则」（面板）与「匹配正则」（节点卡片），
 * 同一个取值两个中文名，用户会以为是两个不同的判定方式；
 * 校验器还把内部取值 notContains 直接拼进提示里。
 *
 * 现在唯一定义处是 passCheck.ts 的 PASS_CHECK_OPTIONS，其余全派生。
 * 下面钉住"不许再长出第二份"。
 * ==================================================================
 */
test('判定方式：取值清单只许在 passCheck.ts 定义一份', () => {
  const lib = stripComments(readSrc('engine/passCheck.ts'));
  assert.ok(
    /PASS_CHECK_OPTIONS/.test(lib),
    'engine/passCheck.ts 里找不到 PASS_CHECK_OPTIONS —— 守卫匹配不到会假通过',
  );

  /*
   * 卡片层不许再抄一份字面量：抄了之后加一种判定方式要改两处，
   * 漏一处是"面板能选、校验报取值不对"。
   */
  const cards = stripComments(readSrc('nodes/paramCards.ts'));
  assert.ok(
    !/value:\s*'nonempty'/.test(cards),
    'nodes/paramCards.ts 里又写了一份判定方式字面量 —— 应改为 options: () => PASS_CHECK_OPTIONS',
  );
  assert.ok(
    /PASS_CHECK_OPTIONS/.test(cards),
    'nodes/paramCards.ts 没有引用 PASS_CHECK_OPTIONS —— 守卫要能匹配到这条',
  );

  const v = stripComments(readSrc('engine/nodeValidate.ts'));
  assert.ok(
    !/\['nonempty'/.test(v),
    'engine/nodeValidate.ts 里又硬编码了一份取值数组 —— 应改用 isPassCheck()',
  );
  assert.ok(
    /isPassCheck/.test(v) && /passCheckLabel/.test(v),
    'engine/nodeValidate.ts 没有用 isPassCheck / passCheckLabel',
  );
});

test('判定方式：选项、标签、校验用同一份（运行时对账）', () => {
  const opts = PASS_CHECK_OPTIONS;
  assert.ok(opts.length >= 4, '判定方式至少四种');

  // 每个取值都有中文名（节点卡片上的 tag 直接读这张表）
  for (const o of opts) {
    assert.equal(
      PASS_CHECK_LABEL[o.value],
      o.label,
      `取值 ${o.value} 的中文名与选项不一致 —— 面板与卡片会显示两个名字`,
    );
    assert.ok(isPassCheck(o.value), `${o.value} 应被 isPassCheck 认下`);
  }
  assert.ok(!isPassCheck('nope'), '未收录的取值不该通过校验');
  assert.equal(passCheckLabel('notContains'), '不包含');
  assert.equal(passCheckLabel('不存在的'), '不存在的', '认不出时退回原值，不编造');
});

test('判定方式：校验报错用中文名，不吐内部取值', () => {
  const src = stripComments(readSrc('engine/nodeValidate.ts'));
  assert.ok(
    /passCheckLabel\(c\)/.test(src),
    '报错文案还在直接拼内部取值 —— 用户会看到「选了「notContains」但没填比对值」',
  );
});

/*
 * 取值那一列退化成「动态（XXX）」时**没有任何测试会红** ——
 * 我实测过：把生成器的常量展开摘掉，2303 条照样全绿，
 * 而参数表从 `nonempty / contains / notContains / regex` 变成一句占位话。
 *
 * 文档看着还在，只是"这一项有哪些取值"没了 —— 又是安静的失效。
 * 所以这里断言最终产物（跑测试前已重新生成），而不是中间函数。
 */
test('判定方式：参数文档的取值列要列出全部取值，不许退化成「动态」', () => {
  for (const f of ['gate', 'retry']) {
    const md = fs.readFileSync(path.join(AF_SRC, 'docs', 'nodes', `${f}.params.md`), 'utf-8');
    const row = md.split('\n').find((l) => l.includes('| `check` |'));
    assert.ok(row, `${f}.params.md 里没有 check 这一行`);
    for (const v of PASS_CHECK_OPTIONS.map((o) => o.value)) {
      assert.ok(row!.includes(v), `${f} 的取值列里没有 ${v} —— 生成器没展开 PASS_CHECK_OPTIONS`);
    }
    assert.ok(!row!.includes('动态'), `${f} 的取值列退化成了「动态（…）」`);
  }
});

/*
 * ==================================================================
 * 条件算子（OP_META）同样只许有一处中文名
 *
 * 与上面「判定方式」是同一类，只是规模更大：
 * 算子名以前写在三处 —— types.ts 的 OP_META、condition.ts 的
 * describeConditionCore、parallel.ts 的 describeRule。
 *
 * 已经分叉：regex 在 OP_META 里叫「正则匹配」，另两处叫「匹配正则」。
 * 于是同一条规则，面板可视化显示「正则匹配」、节点卡片显示「匹配正则」。
 *
 * 「要不要带比较值」也是两份（OP_META.needsValue vs 硬编码的三元数组），
 * 并发那处更糟：一律拼上「值」，于是选「非空」时卡片显示「非空「」」。
 * ==================================================================
 */
test('条件算子：中文名与 needsValue 只从 OP_META 取', () => {
  for (const f of ['engine/condition.ts', 'engine/parallel.ts']) {
    const src = stripComments(readSrc(f));
    assert.ok(
      !/opText\s*:\s*Record/.test(src),
      `${f} 里又自带了一张算子中文名表 —— 应改用 OP_META[op].label`,
    );
    assert.ok(
      /OP_META/.test(src),
      `${f} 没有引用 OP_META —— 守卫匹配不到会假通过`,
    );
    assert.ok(
      !/\['nonEmpty',\s*'isEmpty',\s*'always'\]/.test(src),
      `${f} 里又硬编码了一份「不需要比较值」清单 —— 应改用 OP_META[op].needsValue`,
    );
  }
});

test('条件算子：卡片摘要与面板可视化显示同一个名字（运行时对账）', () => {
  const ops = Object.keys(OP_META) as Array<keyof typeof OP_META>;
  assert.ok(ops.length >= 9, '算子至少九种');

  for (const op of ops) {
    // 节点卡片（condition）
    const card = describeRule({ op, value: 'X', source: '' } as never);
    assert.ok(
      card.includes(OP_META[op].label),
      `算子 ${op} 在条件节点卡片上没用 OP_META 的名字（得到「${card}」）`,
    );
    // 不需要比较值的算子，卡片上不该出现空的「」
    if (!OP_META[op].needsValue) {
      assert.ok(!card.includes('「'), `${op} 不需要比较值，卡片上却带了「」：${card}`);
    }
    // 并发节点卡片
    const p = describeParallelRule({ op, value: 'X', concurrency: 2 } as never);
    assert.ok(
      p.includes(OP_META[op].label),
      `算子 ${op} 在并发节点卡片上没用 OP_META 的名字（得到「${p}」）`,
    );
    if (!OP_META[op].needsValue) {
      assert.ok(!p.includes('「'), `${op} 不需要比较值，并发卡片上却带了「」：${p}`);
    }
  }
});

test('条件算子：契约里的取值清单要列全，不许只写「常用」那几个', () => {
  const src = stripComments(readSrc('engine/nodeSpec.ts'));
  assert.ok(
    !/常用/.test(src),
    '契约里还在用「常用」给不完整清单打掩护 —— 拼装方只看 options，漏掉的算子等于不存在',
  );

  /*
   * 完整契约走 describeBlock —— catalog() 只给契约侧那几列，没有 params。
   * 用 catalog() 的话 cond.params 是 undefined，守卫会出现
   * "Cannot read properties of undefined"，那不是守卫生效，是守卫自己写坏了。
   */
  const cond = describeBlock('condition');
  assert.ok(cond, '契约里找不到 condition 节点');
  const opParam = cond.params.find((p) => p.key === 'op');
  assert.ok(opParam, 'condition 契约里没有 op 这一项');
  for (const op of Object.keys(OP_META)) {
    assert.ok(
      opParam.options.includes(op),
      `condition 契约的 op 清单里没有 ${op} —— 拼装方配不出这种规则（不报错）`,
    );
  }
});
