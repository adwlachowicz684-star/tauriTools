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
