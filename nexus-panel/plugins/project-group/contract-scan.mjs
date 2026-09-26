/**
 * 契约扫描：Rust struct 字段 ↔ TS interface 字段对照
 * ------------------------------------------------------------------
 * 用法：node contract-scan.mjs
 *
 * 为什么要有它：字段名只改一边不会报错、也不会崩，只是**静默对不上** ——
 * 前端存的键后端不认（数据悄悄丢），或后端给的字段前端没声明（值永远是
 * undefined，界面上表现为"功能没生效"）。这类问题只能靠对照两边发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/model.rs'), 'utf8');
const TS = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** 解析 Rust：struct 名 → 字段列表（跳过注释行） */
function rustStructs(src) {
  const lines = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\/\*/.test(l));
  const out = {};
  let cur = null;
  let depth = 0;
  for (const raw of lines) {
    const l = raw.trim();
    const st = /^pub struct (\w+)/.exec(l);
    if (st && depth === 0) { cur = st[1]; out[cur] = []; continue; }
    if (!cur) continue;
    if (l === '{' || l.endsWith('{')) { depth++; continue; }
    if (l.startsWith('}')) { cur = null; depth = 0; continue; }
    const f = /^pub (\w+)\s*:\s*(.+?),?$/.exec(l);
    if (f) out[cur].push({ name: camel(f[1]), ty: f[2].replace(/,$/, '') });
  }
  return out;
}

/** 解析 TS：interface 名 → 字段列表 */
function tsInterfaces(src) {
  const lines = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\/\*/.test(l));
  const out = {};
  let cur = null;
  for (const raw of lines) {
    const l = raw.trim();
    const it = /^(?:export )?interface (\w+)/.exec(l);
    if (it) { cur = it[1]; out[cur] = []; continue; }
    if (!cur) continue;
    if (l.startsWith('}')) { cur = null; continue; }
    const f = /^(\w+)(\?)?\s*:\s*(.+?);?$/.exec(l);
    if (f) out[cur].push({ name: f[1], opt: !!f[2], ty: f[3].replace(/;$/, '') });
  }
  return out;
}

const rs = rustStructs(RS);
const ts = tsInterfaces(TS);

/** 手工配对：Rust 名 → TS 名（两边命名不同时在此登记）。
 *  LinkRecord 不在此列：它是 link-record.json 的**存储**结构，只在本插件
 *  内部读写，从不发给前端，前端不需要同名类型（硬加一个反而会漂移）。 */
const PAIRS = [
  ['TabItem', 'TabItem'],
  ['LockItem', 'LockItem'],
  ['FpxConfig', 'FpxConfig'],
  ['IconGroup', 'IconGroup'],
  ['ChainActionItem', 'ChainAction'],
  ['CustomChainClient', 'CustomChainClient'],
  ['EditorPickCacheItem', 'EditorPickCacheItem'],
  ['McpToolRow', 'McpToolRow'],
  ['CardInfo', 'CardInfo'],
  ['LinkDetail', 'LinkDetail'],
  ['TabInfo', 'TabInfo'],
  ['LinkRow', 'LinkRow'],
  ['RenameIconResult', 'RenameIconResult'],
  ['Snapshot', 'Snapshot'],
  ['Bootstrap', 'Bootstrap'],
  ['PresetAgent', 'PresetAgent'],
  ['ContentItem', 'ContentItem'],
  ['ContentRenameResult', 'ContentRenameResult'],
  ['SegmentRenameResult', 'SegmentRenameResult'],
  ['DirEntryLite', 'DirEntryLite'],
];

let problems = 0;
for (const [rn, tn] of PAIRS) {
  const R = rs[rn];
  const T = ts[tn];
  if (!R || !T) {
    console.log(`⚠️  缺一边：Rust ${rn}=${R ? '有' : '无'}  TS ${tn}=${T ? '有' : '无'}`);
    continue;
  }
  const rn2 = new Set(R.map((f) => f.name));
  const tn2 = new Set(T.map((f) => f.name));
  const onlyR = R.filter((f) => !tn2.has(f.name));
  const onlyT = T.filter((f) => !rn2.has(f.name));
  if (onlyR.length || onlyT.length) {
    problems++;
    console.log(`\n### ${rn} ↔ ${tn}`);
    for (const f of onlyR) console.log(`  仅 Rust：${f.name}: ${f.ty}`);
    for (const f of onlyT) console.log(`  仅 TS  ：${f.name}${f.opt ? '?' : ''}: ${f.ty}`);
  }
}
console.log(`\n配对 ${PAIRS.length} 组，字段不一致 ${problems} 组`);

/* ---------- 可空性对照 ----------
   Rust 的 Option<T> 会序列化成 null；TS 侧若声明成**非空**，
   前端拿到 null 时不会报错（TS 只在编译期管），而是走进 `x.length`、
   `x.map()` 这类调用 —— 表现是"点了没反应"或白屏，日志里什么都没有。 */
console.log('\n=== 可空性 ===');
let nullable = 0;
for (const [rn, tn] of PAIRS) {
  const R = rs[rn], T = ts[tn];
  if (!R || !T) continue;
  const map = new Map(T.map((f) => [f.name, f]));
  for (const f of R) {
    const g = map.get(f.name);
    if (!g) continue;
    const rustOpt = /^Option</.test(f.ty);
    const tsOpt = g.opt || /\|\s*null/.test(g.ty);
    if (rustOpt && !tsOpt) {
      nullable++;
      console.log(`  ⚠️  ${rn}.${f.name}：Rust ${f.ty} 可为 null，TS 却声明 ${g.ty}（非空）`);
    }
    if (!rustOpt && tsOpt && !/\|\s*undefined/.test(g.ty)) {
      /* 反向：Rust 必给，TS 却判空。多数是"防御性多判一层"，不算错，只提示 */
      console.log(`  ·   ${rn}.${f.name}：Rust ${f.ty} 必给，TS 声明 ${g.ty}（多判一层）`);
    }
  }
}
console.log(`可空性不一致：${nullable} 处`);
