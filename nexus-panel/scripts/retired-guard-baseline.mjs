#!/usr/bin/env node
/**
 * 退场态守卫基线（零第三方依赖，供多个守卫共用）
 * ============================================================
 * 为什么要有这一份
 * ------------------------------------------------------------
 * 12 个 iframe 插件源码迁出主仓后，一批守卫仍按「主仓持有源码 / manifest /
 * .test.ts / run-tests.sh / testkit」的旧形态写判据。它们不是判错，而是
 * **判据的对象整体消失了**：集合恒空，`length > 0` 类断言一路报红，
 * 或者更糟——`every` 在空集合上恒真，报告全绿却一条都没验。
 *
 * 直接把 `length > 0` 删掉是最省事的写法，但那正好撤掉了防线：
 * 判据漏扫时同样是空集合，同样「干净」。所以这里给每个判据配一棵
 * **合成 fixture**，主判据与元断言共用同一份实现，退场态下仍要证明
 * 「判据真的能认出它该认的东西」。
 *
 * 名单不在这里另存一份：唯一来源是 scripts/plugin-repo-map.mjs 的 CAMEL。
 * 再抄一份就是无守卫的第二映射表（本项目已收过一次）。
 *
 * ⚠️ 本文件不写剥注释正则字面量，避免被 inline-strip-audit 当成
 *    第 3 份内联实现收进欠账。清理临时目录用系统 tmpdir，不落工作树。
 */
import {
  existsSync, readdirSync, statSync, readFileSync,
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAMEL } from './plugin-repo-map.mjs';

/** 12 个可安装插件 id（唯一来源） */
export const IDS = Object.keys(CAMEL).sort();

/** 与 test-registry-test.mjs / cross-plugin-coupling-test.mjs 原口径一致 */
export const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'runtime-plugins', 'build', 'target', '.vite',
]);

/** 主仓里仍残留插件源码的 id（退场态应为 []） */
export function sourceResidue(root) {
  return IDS.filter((id) => existsSync(join(root, 'plugins', id, 'index.html')));
}

export function isRetired(root) {
  return sourceResidue(root).length === 0;
}

/**
 * 测试文件收集判据。主判据与元断言必须共用这一份 ——
 * 另写一份「验判据的判据」，主判据被清空时那份照样绿。
 * @returns {{tests:string[], tsOnDisk:string[]}} 均为绝对路径
 */
export function collectTestFiles(root) {
  const tests = [];
  const tsOnDisk = [];
  (function walk(dir) {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (/^.*-test\.mjs$/.test(e.name)) {
        tests.push(join(dir, e.name));
      } else if (/\.test\.tsx?$/.test(e.name)) {
        tests.push(join(dir, e.name));
        tsOnDisk.push(join(dir, e.name));
      }
    }
  })(root);
  return { tests, tsOnDisk };
}

/** 目录级运行器收集判据，返回绝对路径 */
export function collectRunners(root, names = ['run-tests.sh']) {
  const found = [];
  (function walk(dir) {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (names.includes(e.name)) {
        found.push(join(dir, e.name));
      }
    }
  })(root);
  return found;
}

/**
 * 运行时产物入口：退场态下主仓改由 runtime-plugins/<id>/index.html 供给。
 * 少了任何一个图标/面板就是「装了却打不开」，且不报错。
 */
export function runtimeEntries(root) {
  const present = IDS.filter((id) => existsSync(join(root, 'runtime-plugins', id, 'index.html')));
  return { present, missing: IDS.filter((id) => !present.includes(id)) };
}

const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * ★真红线★：扫运行时产物里指向「另一个插件目录」的动态路径。
 * 源码里的静态 import 在构建期已内联，产物里若还留着 `../<id>/`，
 * 独立安装后就是 404，而界面只表现为一片空白。
 *
 * @returns {{files:number, hits:{file:string, raw:string}[]}}
 *   files 是**真扫过的文件数**，判据必须要求它 > 0 —— 空集合 every 恒真
 *   会让整条红线在路径写错时照样全绿。
 */
export function scanRuntimeCrossPaths(root, ids = IDS) {
  const base = join(root, 'runtime-plugins');
  const others = new Set(ids);
  const hits = [];
  let files = 0;
  const re = /\.\.\/([A-Za-z0-9_-]+)\//g;
  (function walk(dir) {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!TEXT_EXT.has(e.name.slice(e.name.lastIndexOf('.')))) continue;
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isFile() || st.size > MAX_TEXT_BYTES) continue;
      let text;
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      files++;
      let m;
      while ((m = re.exec(text))) {
        if (!others.has(m[1])) continue;
        hits.push({ file: p, raw: m[0] });
      }
      re.lastIndex = 0;
    }
  })(base);
  return { files, hits };
}

/**
 * 合成一棵「旧形态」小树，供各守卫在退场态下做元断言。
 * 用真实 id 里的两个名字，这样 scanRuntimeCrossPaths 的默认 IDS 能命中。
 * 调用方必须在 finally 里 cleanup()。
 */
export function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'retired-guard-'));
  const a = IDS[0];
  const b = IDS[IDS.length - 1];
  const put = (rel, text) => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  put(`plugins/${a}/index.html`, '<html></html>\n');
  put(`plugins/${a}/nexus.plugin.json`, JSON.stringify({
    id: a, name: 'Fixture A', version: '1.0.0', entry: 'index.html', kind: 'app',
  }, null, 2) + '\n');
  put(`plugins/${b}/index.html`, '<html></html>\n');
  put(`plugins/${a}/tests/x.test.ts`, "import { test } from 'node:test';\ntest('x', () => {});\n");
  put(`plugins/${a}/scripts/run-tests.sh`, '#!/bin/sh\nnode --test tests/\n');
  put(`plugins/${a}/testkit.mjs`, 'export function done(fail) { process.exit(fail ? 1 : 0); }\n');
  put(`plugins/${a}/y-test.mjs`, "import { done } from './testkit.mjs';\ndone(0);\n");
  put(`runtime-plugins/${a}/index.html`, `<script>const P = '../${b}/icons/';</script>\n`);
  put(`runtime-plugins/${b}/index.html`, '<html></html>\n');
  return { root, a, b, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
