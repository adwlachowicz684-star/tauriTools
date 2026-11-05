#!/usr/bin/env node
/**
 * 静态准入扫描的「排除判据自检」守卫（离线）
 * ============================================================
 * 守什么
 * ------------------------------------------------------------
 * `scripts/scan-admit.mjs` 按文件名排除测试脚手架，自检原本写成
 * 「skipped.length === 0 就报红」。12 个插件源码退场到独立仓之后，主仓
 * plugins/ 下一个 *-test.mjs 都没有了，skipped 恒为 0 —— 这条自检从此
 * **恒红**，默认分支带着一条永远消不掉的红；而它真正想守的
 * 「TEST_FILE 被改成永不匹配 / 什么都匹配」反而没人验了。
 *
 * 修法不是把判据调松（删掉那条红、或改成「skipped 为 0 时也放行」），
 * 而是让它不再依赖磁盘上是否存在被排除对象：用一组已知答案的合成
 * 文件名样本去考判据，正例必须被排除、负例必须留下，样本自身完整性
 * 也要验。这样两种破坏方向都抓得住，且永远不会因目录结构变化假红。
 *
 * 判据两层：
 *   · 行为层 —— 子进程真跑脚本，注入坏变体看退出码与输出；
 *   · 接线层 —— 扫描源码，确认合成样本块在、旧硬判据没回来。
 *
 * 每个变体都先断言「替换确实命中」。替换没命中时变体==原版，
 * 全绿只是没人验过 —— 本项目在别的守卫上栽过这个。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, 'scripts/scan-admit.mjs');
const PROBE = path.join(HERE, 'scripts/.__scan_admit_probe.mjs');
const src = fs.readFileSync(TARGET, 'utf8');

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? ` — ${extra}` : ''));
}

/* 变体临时文件必须落在 scripts/ 同目录：脚本按 HERE/.. 定位 ROOT，
 * 换到别处相对 import '../js/plugin-admit.js' 就断了，看起来会像
 * 「扫描器崩了」而不是「变体没生效」。 */
function run(srcText) {
  fs.writeFileSync(PROBE, srcText);
  try {
    const r = spawnSync(process.execPath, [PROBE], {
      cwd: HERE, encoding: 'utf8', timeout: 60000,
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    try { fs.unlinkSync(PROBE); } catch { /* 已清理 */ }
  }
}

/* 只替换代码行，不碰注释里提到的同名字符串 */
function withTestFile(s, expr) {
  return s.replace(/^const TEST_FILE = .*;$/m, `const TEST_FILE = ${expr};`);
}
function unchanged(a, b, tag) {
  t(`变体替换命中：${tag}`, a !== b, '替换未命中，变体等于原版，下面全是假绿');
}

/* ---------------- ① 原版：自检必须转绿 ---------------- */
const base = run(src);
t('原版退出码 0', base.code === 0, `实际 ${base.code}`);
t('原版汇总行「失败 0 项」', /失败 0 项/.test(base.out));
t('原版不打印自检失败', !/❌ 自检失败/.test(base.out));
t('原版输出说明零排除时的口径', /本仓当前无测试脚手架，判据由合成样本验证/.test(base.out));

/* ---------------- ② 钉住缺陷：旧写法必须恒红 ----------------
 * 把合成样本块整段换回旧硬判据。它不依赖 TEST_FILE 是否坏，
 * 只因为 skipped=0 就报红 —— 这正是改回去时会看到的那条红。 */
const legacyBlock = `const selfFails = [];
if (skipped.length === 0) {
  selfFails.push('没有任何测试文件被排除 —— 排除判据失效，deny 会重新被测试脚手架淹没');
}
if (files === 0) selfFails.push('没有任何文件被真正扫描 —— 排除判据过宽');`;
const legacy = src.replace(
  /const PROBE = \{[\s\S]*?if \(files === 0\) selfFails\.push\([^\n]*\);/,
  legacyBlock,
);
unchanged(src, legacy, '换回旧自检块');
const rLegacy = run(legacy);
t('旧写法确实恒红（缺陷存在）', rLegacy.code === 1, `实际 ${rLegacy.code}`);
t('旧写法报的是「没有任何测试文件被排除」', /没有任何测试文件被排除/.test(rLegacy.out));

/* ---------------- ③ 判据失效：什么都排除不了 → 必须红 ---------------- */
const dead = withTestFile(src, '/(?!)/');
unchanged(src, dead, 'TEST_FILE 改为永不匹配');
const rDead = run(dead);
t('判据永不匹配 → 退出码 1', rDead.code === 1, `实际 ${rDead.code}`);
t('判据永不匹配 → 报「漏掉测试脚手架样本」', /漏掉测试脚手架样本/.test(rDead.out));

/* ---------------- ④ 判据过宽：什么都排除 → 必须红 ---------------- */
const wide = withTestFile(src, '/.*/');
unchanged(src, wide, 'TEST_FILE 改为全部匹配');
const rWide = run(wide);
t('判据过宽 → 退出码 1', rWide.code === 1, `实际 ${rWide.code}`);
t('判据过宽 → 报「把非测试文件也排除了」', /把非测试文件也排除了/.test(rWide.out));
t('判据过宽 → 同时报「没有任何文件被真正扫描」', /没有任何文件被真正扫描/.test(rWide.out));

/* ---------------- ⑤ 样本完整性：清空正例不算通过 ---------------- */
const emptyProbe = src.replace(/positive: \[[^\]]*\]/, 'positive: []');
unchanged(src, emptyProbe, '清空合成样本正例');
const rEmpty = run(emptyProbe);
t('样本被清空 → 退出码 1', rEmpty.code === 1, `实际 ${rEmpty.code}`);
t('样本被清空 → 报「合成样本不完整」', /合成样本不完整/.test(rEmpty.out));

/* ---------------- ⑥ 撤掉两条 push，坏判据必须无人发现 ----------------
 * 这是「反向验证的反向验证」：证明 ③ 的红确实来自这两条 push，
 * 而不是来自别处恰好也在报红（否则撤了照样红，等于没守住）。 */
const noPush = dead.replace(
  /if \(missed\.length\) selfFails\.push\([^\n]*\)\;\nif \(overbroad\.length\) selfFails\.push\([^\n]*\)\;\n/,
  '',
);
unchanged(dead, noPush, '撤掉两条自检 push');
const rNoPush = run(noPush);
t('撤掉 push 后坏判据无人发现（EXIT 0）', rNoPush.code === 0, `实际 ${rNoPush.code}`);
t('撤掉 push 后不再打印自检失败', !/❌ 自检失败/.test(rNoPush.out));

/* ---------------- ⑦ 接线层：判据与注释不许漂回去 ---------------- */
/* 先剥注释：说明里原样写着这些字，不剥会被注释喂饱（本项目栽过三次） */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
t('代码里有合成正例样本', /positive: \[[^\]]+\]/.test(code));
t('代码里有合成负例样本', /negative: \[[^\]]+\]/.test(code));
t('代码里用正例考判据', /PROBE\.positive\.filter\(\(n\) => !TEST_FILE\.test\(n\)\)/.test(code));
t('代码里用负例考判据', /PROBE\.negative\.filter\(\(n\) => TEST_FILE\.test\(n\)\)/.test(code));
t('旧硬判据没有回到代码里', !/if \(skipped\.length === 0\)/.test(code));
t('自检失败仍计入汇总行与退出码', /selfFails\.length \? 1 : 0/.test(code));

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.log('  ❌ ' + f);
process.exit(fails.length ? 1 : 0);
