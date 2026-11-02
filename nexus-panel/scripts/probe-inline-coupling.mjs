#!/usr/bin/env node
/**
 * 静态跨插件引用「构建期真的内联了吗」——产物侧实证探针（手动跑，不进 CI）
 * ============================================================================
 *
 * 为什么单独有这个文件
 * ------------------------------------------------------------
 * cross-plugin-coupling-test.mjs 是**源码侧**守卫：它把跨插件引用分成
 * 「构建期静态导入」与「运行时动态路径」，钉住后者必须为 0。
 * 但它**看不到构建产物** —— 万一某天 vite 配置变了（比如把某个包标成
 * external），静态导入不再内联，源码侧守卫照样全绿，而独立安装后
 * 运行时会 404。这正是本项目反复栽的「看着在跑、其实没守」。
 *
 * 本探针负责另一半：拿真实产物说话。
 *
 *   2026-11-03 首次实跑（project-group，07:39 真实构建）：
 *     · index.html 只引 ./assets/*，全产物 0 个 ../ 相对引用
 *     · 色盘 249 个 fpx-* 类已合并进产物 CSS（@import 确实被内联）
 *     · 产物 JS 里的 `color-picker` 是服务名 call('color-picker',…)，不是路径
 *   → 台账里那 4 条静态账**不阻断独立安装**，只阻断拆仓库后的源码编译。
 *
 * ⛔ 不登记进 package.json 的 test:* script：它依赖 runtime-plugins/ 里有产物，
 *    CI 里通常没有构建产物，混进去会把「没构建」和「内联坏了」混在一起。
 *    文件名刻意不叫 *-test.mjs，避免被 test-registry 当成未登记的孤儿。
 *
 * ⛔ 「没验到」不假装绿：产出一个都没验到时 exit=2（不是 0）。
 *    失败 exit=1，全验过且干净 exit=0。
 *
 * 用法
 * ------------------------------------------------------------
 *   node scripts/probe-inline-coupling.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanCrossPlugin, listPluginIds } from './scan-coupling.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.map', '.svg', '.txt']);
const SKIP_DIRS = new Set(['node_modules', 'preseticons', 'editor', '.cache']);

/** 扫一个产物目录，找出所有「落到别的插件目录」的相对路径 */
function scanBundlePaths(dir, ids) {
  const out = [];
  const walk = (d, rel) => {
    let ents;
    try { ents = readdirSync(join(d, rel)); } catch { return; }
    for (const e of ents) {
      const r = join(rel, e);
      const p = join(d, r);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(e)) continue;
        walk(d, r);
        continue;
      }
      if (!TEXT_EXT.has(extname(e))) continue;
      let src;
      try { src = readFileSync(p, 'utf8'); } catch { continue; }
      const re = /(\.\.\/)+([\w.-]+)\//g;
      let m;
      while ((m = re.exec(src))) {
        if (!ids.has(m[2])) continue;
        out.push({ file: r.split('\\').join('/'), target: m[2], raw: src.slice(Math.max(0, m.index - 30), m.index + 50).replace(/\s+/g, ' ') });
      }
    }
  };
  walk(dir, '');
  return out;
}

/* ---- 自检：证明 scanBundlePaths 真的能抓到，而不是恒空 ---- */
function selfCheck(ids) {
  const d = mkdtempSync(join(tmpdir(), 'inline-probe-'));
  mkdirSync(join(d, 'assets'), { recursive: true });
  writeFileSync(join(d, 'assets', 'a.css'), "@import '../color-picker/style.css';\n");
  writeFileSync(join(d, 'index.html'), '<link href="./assets/a.css">\n');
  const hits = scanBundlePaths(d, ids);
  const ok = hits.some((h) => h.target === 'color-picker');
  console.log(`[自检] 注入一条 ../color-picker/ 到假产物 → ${ok ? '✅ 检出（判据有效）' : '❌ 没检出（判据失效，下面所有绿都不可信）'}`);
  return ok;
}

function main() {
  const ids = new Set(listPluginIds(ROOT));
  if (!selfCheck(ids)) process.exit(1);

  const staticHits = scanCrossPlugin(ROOT).filter((h) => h.blocking && !h.runtimeRisk);
  const owners = [...new Set(staticHits.map((h) => h.owner))].sort();
  console.log(`\n[产物侧] 需验证的静态耦合 owner：${owners.join(', ') || '（无）'}`);

  let verified = 0, skipped = 0, failed = 0;
  for (const owner of owners) {
    const dir = join(ROOT, 'runtime-plugins', owner);
    if (!existsSync(dir)) {
      console.log(`  ⏭  ${owner}：产物不存在，[跳过] 未验证`);
      skipped++;
      continue;
    }
    const hits = scanBundlePaths(dir, ids);
    const idx = join(dir, 'index.html');
    const html = existsSync(idx) ? readFileSync(idx, 'utf8') : '';
    const refs = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    console.log(`  ${hits.length ? '❌' : '✅'} ${owner}：产物内跨插件路径 ${hits.length} 处；index.html 外部引用 ${JSON.stringify(refs)}`);
    for (const h of hits.slice(0, 5)) console.log(`      ${h.file} → ${h.target}：${h.raw}`);
    verified++;
    if (hits.length) failed++;
  }

  console.log(`\n[产物侧] 已验 ${verified} · 跳过 ${skipped} · 失败 ${failed}`);
  if (skipped) console.log('  ⚠️ 有产物没构建到 —— 这次结论只覆盖已验的那些，不是全绿');
  if (failed) {
    console.log('  ❌ 静态引用没有被构建期内联，独立安装后会 404');
    process.exit(1);
  }
  if (verified === 0) {
    console.log('  ⚠️ 一个产物都没验到 —— 不假装绿（exit=2）；先跑一次构建再来');
    process.exit(2);
  }
  console.log('  ✅ 已验产物均自包含：静态跨插件引用确实在构建期内联了');
}

main();
