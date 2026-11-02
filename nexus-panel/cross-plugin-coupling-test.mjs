/**
 * 跨插件耦合守卫 —— 拆独立仓库前必须清零的清单
 * ============================================================================
 *
 * 为什么在拆仓库**之前**先立这道守卫：
 *
 *   跨插件相对引用（`../<别的插件>/...`）在当前形态下**完全正常**：
 *   它们解析到构建产物里同一个 `runtime-plugins/` 树、同一个 origin，
 *   构建不报错、界面不空白、现有任何守卫都不喊。所以"现在没坏"，
 *   没人会去动它 —— 直到拆成独立仓库、独立安装，
 *   A 装了 B 没装时 `../B/xxx` 立刻 404，而表现为**功能区一片空白**，
 *   不出错、不崩溃。
 *
 *   这正是本项目反复栽的形状：**失效不报错**。所以先把它变成
 *   一份**会被 CI 盯着**的清单，而不是记在文档里等人想起。
 *
 * ⛔ 白名单不是"允许豁免"，是"已知欠账台账"：
 *    本测试断言的是**白名单与实际命中完全一致** ——
 *      · 修好一处 → 实际少一条 → 这里红，逼你把白名单条目删掉（销账）
 *      · 新增一处 → 实际多一条 → 这里红，逼你先想清楚再拆
 *    两边一起对不上就红，任何一方单方面改动都会被抓。
 */

import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scanCrossPlugin, keyOf } from './scripts/scan-coupling.mjs';
import { SUMMARY } from './test-scan-utils.mjs';

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/*
 * ⛔ ROOT 必须按**脚本自身位置**算，不能用 process.cwd()。
 *    实测：从上级目录跑本测试，cwd 是 /data/workspace，
 *    scanCrossPlugin 去找 /data/workspace/plugins —— 不存在，直接抛错，
 *    9 项断言一条都不跑。本项目有 cwd-invariant 体检项专盯这类问题：
 *    换目录跑结果必须一致，否则体检单上"绿"只在你恰好站在某个目录下才成立。
 */
const ROOT = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
function t(name, ok, detail) {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
}

/** 已知欠账台账。每条必须写清 why（为什么现在这样）与 unblock（怎么销账）。 */
const KNOWN = {
  'plugins/project-group/components/dialogCards.tsx:5->color-picker': {
    blocking: true,
    why: '内嵌色盘组件直接引 color-picker 的 React 组件。',
    unblock: '抽成共享包（构建期内联进各自单文件产物），或由宿主提供色盘能力。',
  },
  'plugins/project-group/components/dialogCards.tsx:15->color-picker': {
    blocking: true,
    why: '色盘样式只在 color-picker/style.css 里；本插件是另一个 iframe 文档，'
       + '只加载自己的 style.css，不显式引则色盘渲染成一坨没布局的裸文字'
       + '（不报错、不崩溃 —— 源码注释已点名这个坑）。',
    unblock: '同上，随共享包一并解决；或把色盘样式并入本插件样式。',
  },
  'plugins/project-group/style.css:2->color-picker': {
    blocking: true,
    why: 'CSS @import 跨插件引色盘样式（本轮扫描新查出的一处，'
       + '前几轮只按 import 语句查过，漏了 @import 这条路径）。',
    unblock: '同上。',
  },
  'plugins/project-group/utils/color.ts:18->color-picker': {
    blocking: true,
    why: '颜色工具的唯一实现在 color-picker/color.ts，这里只做转发。'
       + '源码注释明确禁止在此再写一份实现（历史上有过抄本漂移的教训）。',
    unblock: '抽成共享包后两边都从包里 import —— 绝不能改成各写一份。',
  },
  'plugins/md-render/module.js:41->md': {
    blocking: false,
    why: 'md / md-render 都是 module 插件（编译期随主程序构建），不进市场，不受拆分影响。',
    unblock: '若将来把 module 插件也改成可热装，此处才会变成阻断项。',
  },
  'plugins/md-render/module.js:42->md': {
    blocking: false,
    why: '同上。',
    unblock: '同上。',
  },
};

const hits = scanCrossPlugin(ROOT);
const actual = new Map(hits.map((h) => [keyOf(h), h]));
const known = new Set(Object.keys(KNOWN));

/* ① 白名单与实际完全一致 —— 销账要删条目，新增要先想清楚 */
const missing = hits.filter((h) => !known.has(keyOf(h)));
t('①a 没有白名单外的跨插件引用', missing.length === 0,
  missing.map((h) => `${keyOf(h)}（blocking=${h.blocking}）`).join('; '));
const stale = [...known].filter((k) => !actual.has(k));
t('①b 白名单没有已失效的条目', stale.length === 0, stale.join('; '));

/* ② 每条台账的 blocking 标记必须与扫描器独立算出的结论一致。
      分开算是为了防止"改台账就能让红灯变绿"—— 两边各自判，对不上就红。 */
const mismatch = [...actual.entries()]
  .filter(([k, h]) => known.has(k) && KNOWN[k].blocking !== h.blocking)
  .map(([k, h]) => `${k}（台账=${KNOWN[k].blocking} 实测=${h.blocking}）`);
t('② blocking 标记与实测一致', mismatch.length === 0, mismatch.join('; '));

/* ③ 台账字段完整性：缺 why/unblock 的条目等于没记账 */
const badEntry = Object.entries(KNOWN)
  .filter(([, v]) => !v.why || !v.unblock || typeof v.blocking !== 'boolean')
  .map(([k]) => k);
t('③ 每条台账都有 why / unblock / blocking', badEntry.length === 0, badEntry.join('; '));

/* ④ 真阻断项数量 —— 这是"拆仓库还剩几处要解"的可读数 */
const blockingNow = hits.filter((h) => h.blocking).length;
t('④ 阻断项数量与台账一致',
  blockingNow === Object.values(KNOWN).filter((v) => v.blocking).length,
  `实测 ${blockingNow}`);

/* ⑤ 共享资源一致性 —— 已销账那条的**后续风险**必须有人盯着
 *
 * 背景：icon-picker 原先跨插件引 project-group/preseticons/。
 * 为了能独立安装，改成自带一份（122 个 .ico）。于是同一个逻辑资源
 * 有了**两份物理拷贝** —— 这正是"解耦"的代价。
 *
 * ⛔ 两份拷贝的失效形状：改了 A 份忘了 B 份 → 同一个图标名在两个界面
 *    显示不同的图，或者一边 404。不报错、不崩溃，只表现为"图标不对"。
 *    与 utils/color.ts 历史上抄本漂移是同一形状（那份注释明确禁止再犯）。
 *
 * 所以"销账"不是终点：销掉跨插件引用之后，这里必须接管防漂移。
 */
const SHARED_RESOURCES = [
  { a: 'plugins/project-group/preseticons', b: 'plugins/icon-picker/preseticons', what: '内置预设图标库' },
];

function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    let ents;
    try { ents = readdirSync(join(d, rel)); } catch { return; }
    for (const e of ents) {
      const p = join(d, rel, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(d, join(rel, e));
      else out.push({ rel: join(rel, e), size: st.size });
    }
  };
  walk(dir, '');
  return out.sort((x, y) => (x.rel < y.rel ? -1 : 1));
}

for (const { a, b, what } of SHARED_RESOURCES) {
  const da = resolve(ROOT, a);
  const db = resolve(ROOT, b);
  t(`⑤ ${what}：两份拷贝都存在`, isDir(da) && isDir(db), `${a} / ${b}`);
  if (!isDir(da) || !isDir(db)) continue;

  const fa = listFiles(da);
  const fb = listFiles(db);
  t(`⑤ ${what}：文件数量一致`, fa.length === fb.length && fa.length > 0,
    `${a}=${fa.length} ${b}=${fb.length}`);

  const na = fa.map((f) => f.rel);
  const nb = fb.map((f) => f.rel);
  const onlyA = na.filter((x) => !nb.includes(x));
  const onlyB = nb.filter((x) => !na.includes(x));
  t(`⑤ ${what}：文件清单一致`, onlyA.length === 0 && onlyB.length === 0,
    `仅A有 ${onlyA.slice(0, 3).join(',')}；仅B有 ${onlyB.slice(0, 3).join(',')}`);

  /* 逐字节比对：只比同名文件，避免清单不一致时刷屏 */
  const diff = [];
  for (const f of fa) {
    if (!nb.includes(f.rel)) continue;
    const ha = createHash('md5').update(readFileSync(join(da, f.rel))).digest('hex');
    const hb = createHash('md5').update(readFileSync(join(db, f.rel))).digest('hex');
    if (ha !== hb) diff.push(f.rel);
  }
  t(`⑤ ${what}：逐字节内容一致`, diff.length === 0, `不一致 ${diff.length} 个：${diff.slice(0, 3).join(',')}`);
}

/* ---- 元断言：证明扫描器真的在扫，而不是恒空 ---- */

/**
 * 造一棵假插件树，同时放入三种情形：
 *   a) 真跨插件引用      → 必须检出
 *   b) 注释里的历史引用  → 必须**不**检出（剥注释在起作用）
 *   c) 指向宿主 js/ 的引用 → 必须**不**检出（不是插件）
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coupling-'));
  mkdirSync(join(root, 'plugins', 'aaa'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'bbb'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'aaa', 'nexus.plugin.json'), '{}');
  writeFileSync(join(root, 'plugins', 'bbb', 'nexus.plugin.json'), '{}');
  writeFileSync(
    join(root, 'plugins', 'aaa', 'a.js'),
    [
      "import { x } from '../bbb/thing';",        // (a) 真引用
      "/* 此前写的是 '../bbb/utils/color' */",     // (b) 注释里的历史引用
      "import { y } from '../../js/dialog.js';",  // (c) 宿主 SDK
      "const u = 'https://x.dev/../bbb/';",       // (d) URL 里带 ../bbb/
    ].join('\n'),
  );
  return root;
}
const fh = scanCrossPlugin(fixture());
t('元断言 A：真跨插件引用被检出',
  fh.some((h) => h.file.endsWith('aaa/a.js') && h.target === 'bbb'),
  `实际 ${fh.length} 处`);
t('元断言 B：注释里的历史引用不算（剥注释真的生效）',
  !fh.some((h) => h.line === 2),
  `第 2 行被算进了？${JSON.stringify(fh.map((h) => h.line))}`);
t('元断言 C：指向宿主 js/ 的不算跨插件',
  !fh.some((h) => h.target === 'js'),
  JSON.stringify(fh.map((h) => h.target)));
t('元断言 D：URL 里的 ../bbb/ 不算（行注释判据没吞 URL 后半截）',
  !fh.some((h) => h.line === 4),
  `第 4 行被算进了？${JSON.stringify(fh.map((h) => h.line))}`);

const fail = fails.length;
console.log(`\n[跨插件耦合] 通过 ${pass} 项，失败 ${fail} 项`);
for (const f of fails) console.log(`  ❌ ${f}`);
console.log(`\n[跨插件耦合] 阻断拆分的引用 ${blockingNow} 处（清单见 KNOWN 台账）`);
process.exit(fail ? 1 : 0);
