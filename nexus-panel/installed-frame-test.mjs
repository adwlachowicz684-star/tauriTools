#!/usr/bin/env node
/**
 * 已安装插件「加载 URL」守卫（第 63 轮）
 * ============================================================================
 *
 * 修的缺口：resolveFrameSrc 对 installed:true 无条件 throw 了十几轮，
 * 台账一直写「asset 协议下 ES module 只有真机能判」。第 61 轮真实
 * Chromium 四象限 + 第 62 轮构建链实证把这句拆开了：
 *
 *   · release tarball == runtime-plugins/<id>/ 的产物；
 *   · 12 份里 11 份是零外部相对资源的单文件内联 bundle；
 *   · 内联 bundle 不发跨源 module 请求，握手走 e.source，
 *     contentDocument=null 不阻断加载。
 *
 * 于是 js/installed-frame.js 复用构建期唯一的 checkSingleFile 做形态
 * 分流。本守卫钉住四件事：
 *
 *   ① 行为层真跑：三态 fail-closed 各自抛带 nextAction 的错误；
 *      成功路径真的返回 asset URL；空 HTML 绝不能被当成单文件放行。
 *   ② 形态判据只有一份：12 份真实产物逐份取证，期望值由
 *      scripts/single-file.mjs 独立反推，不硬编码 id 列表。
 *   ③ 不自查自封：台账 status 仍 wired / runtimeVerified=false，
 *      host.js 的 installed 分支确实委托新模块、不退回 resolveEntry。
 *   ④ 常量只有一份：INSTALLED_DIR 与 plugin-manifest.js 的
 *      INSTALLED_PLUGINS_DIR 独立反推相等。
 *
 * 已知边界（与第 30/31/49/53 轮同形）：纯静态守卫挡不住「把主断言
 * 整行删掉或改成 true」。元断言只验判据函数本身能识别坏输入，
 * 靠每轮破坏验证兜这一层，不假装能自证。
 *
 * 零外部依赖，按 import.meta.url 定位根，从任意 cwd 可跑。
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyInstalledHtml, installedFrameUrl, resolveInstalledFrameSrc,
  INSTALLED_DIR,
} from './js/installed-frame.js';
import { checkSingleFile } from './scripts/single-file.mjs';
import { checkSingleFile as shapeCheck } from './js/single-file-shape.mjs';
import { spawnSync } from 'node:child_process';
/* 剥注释复用公共设施，不新增内联副本（inline-strip-audit 会点名）。 */
import { stripCommentsJs } from './test-scan-utils.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const r = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');

let pass = 0;
let fail = 0;
function t(name, ok, info = '') {
  if (ok) { pass += 1; return; }
  fail += 1;
  console.log(`  ✗ ${name}${info ? ` — ${info}` : ''}`);
}

/* 行为层统一经 safe() 包装：被测模块抛错时转成点名断言 + 空结果，
 * 守卫不会崩在顶层 await 且没有汇总行（「守卫崩了不等于守卫喊了」）。 */
async function safe(label, fn) {
  try { return await fn(); }
  catch (e) {
    t(`${label} 调用不得抛异常`, false, String((e && e.message) || e));
    return null;
  }
}

/* ---------------- ① 形态判据：12 份真实产物逐份独立取证 ---------------- */
const RUNTIME_DIR = join(ROOT, 'runtime-plugins');
const productIds = existsSync(RUNTIME_DIR)
  ? readdirSync(RUNTIME_DIR).filter((d) => existsSync(join(RUNTIME_DIR, d, 'index.html')))
  : [];
t('①a runtime-plugins/ 下能读到 12 份产物入口', productIds.length === 12,
  `实际 ${productIds.length}`);

const shapeRows = [];
for (const id of productIds) {
  const html = readFileSync(join(RUNTIME_DIR, id, 'index.html'), 'utf8');
  /* 期望值由构建期判据独立反推，不复用 classifyInstalledHtml 的返回值 */
  const expected = checkSingleFile(html);
  const got = classifyInstalledHtml(html);
  shapeRows.push({ id, expectedOk: expected.ok, gotOk: got.ok, remaining: got.remaining.length });
  t(`①b ${id} 形态判定与构建期判据一致`,
    got.ok === expected.ok
    && got.remaining.length === expected.remaining.filter((x) => x.cls !== 'inline' && x.cls !== 'fragment').length,
    `expected=${expected.ok} got=${got.ok}`);
}
const okCount = shapeRows.filter((x) => x.gotOk).length;
const badRows = shapeRows.filter((x) => !x.gotOk);
t('①c 12 份里恰好 11 份是零外部相对资源的单文件形态',
  okCount === 11, `实际 ${okCount}`);
t('①d 非单文件形态恰好 1 份且 remaining 含 script 与 stylesheet',
  badRows.length === 1 && badRows[0].remaining >= 2,
  JSON.stringify(badRows));

/* ---------------- ② 行为层：三态 fail-closed 真跑 ---------------- */
const INLINE_HTML = '<html><head><script type="module">console.log(1)</script></head><body>x</body></html>';
const EXTERNAL_HTML = '<html><head>'
  + '<script type="module" src="./assets/index-AAA.js"></script>'
  + '<link rel="stylesheet" href="./assets/index-BBB.css"></head><body>x</body></html>';
const MANIFEST = { id: 'foo', installed: true, entry: 'index.html' };
const goodDeps = {
  appDataDir: '/appdata',
  convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
  readText: async () => INLINE_HTML,
};

/* 抽成判据函数，元断言验它不恒真/恒假 */
const expectsThrow = async (deps, manifest, nextAction) => {
  try {
    await resolveInstalledFrameSrc(manifest || MANIFEST, deps);
    return false;
  } catch (e) {
    return !!e && e.nextAction === nextAction && /已安装插件/.test(String(e.message));
  }
};

{
  const cases = [
    ['②a 缺 appDataDir', { ...goodDeps, appDataDir: null }, 'no-tauri-runtime'],
    ['②b 缺 convertFileSrc', { ...goodDeps, convertFileSrc: null }, 'no-tauri-runtime'],
    ['②c 缺 readText', { ...goodDeps, readText: null }, 'no-tauri-runtime'],
    ['②d readText 抛错', { ...goodDeps, readText: async () => { throw new Error('EACCES'); } }, 'backend-proxy-or-copy-to-dist'],
    ['②e readText 返回空串（绝不能被当成单文件放行）', { ...goodDeps, readText: async () => '' }, 'backend-proxy-or-copy-to-dist'],
    ['②f readText 返回 null', { ...goodDeps, readText: async () => null }, 'backend-proxy-or-copy-to-dist'],
    ['②g 非单文件形态', { ...goodDeps, readText: async () => EXTERNAL_HTML }, 'backend-proxy-or-inline-bundle'],
    ['②h convertFileSrc 抛错', { ...goodDeps, convertFileSrc: () => { throw new Error('bad'); } }, 'no-tauri-runtime'],
    ['②i convertFileSrc 返回空串', { ...goodDeps, convertFileSrc: () => '' }, 'no-tauri-runtime'],
  ];
  for (const [name, deps, action] of cases) {
    const got = (await safe(name, () => expectsThrow(deps, MANIFEST, action)));
    t(name, got === true, `nextAction 期望 ${action}`);
  }
}

/* ---------------- ③ 行为层：成功路径真返回 asset URL ---------------- */
{
  const url = (await safe('③a', () => resolveInstalledFrameSrc(MANIFEST, {
    ...goodDeps, vars: { '--bg': '#112233' }, base: 'dark',
  }))) || '';
  t('③a 单文件形态真的返回 asset URL（不再无条件 throw）',
    typeof url === 'string' && url.startsWith('asset://localhost/'), String(url).slice(0, 120));
  t('③b URL 带上首帧底色参数',
    /nexus-bg=/.test(String(url)) && /nexus-base=dark/.test(String(url)), String(url).slice(-90));
  t('③c URL 路径含 installed-plugins/<id>/index.html 的编码',
    /foo/.test(String(url)) && /index\.html/.test(String(url)), String(url));
  const custom = (await safe('③e', () => resolveInstalledFrameSrc(MANIFEST, {
    ...goodDeps, installedDir: 'custom-dir',
    convertFileSrc: (p) => p,
  }))) || '';
  t('③e installedDir 覆盖生效', String(custom).includes('/custom-dir/foo/index.html'), String(custom));
}

/* ---------------- ④ URL 拼接纯函数 ---------------- */
t('④a 无参数时原样返回', installedFrameUrl({ fileUrl: 'asset://localhost/x' }) === 'asset://localhost/x');
t('④b 已有 query 时用 & 追加而不是覆盖',
  installedFrameUrl({ fileUrl: 'asset://localhost/x?a=1', vars: { '--bg': '#fff' } })
    === 'asset://localhost/x?a=1&nexus-bg=%23fff');
t('④c 空 fileUrl 明确抛错',
  (() => { try { installedFrameUrl({ fileUrl: '' }); return false; } catch { return true; } })());

/* ---------------- ⑤ 常量只有一份（独立反推） ---------------- */
{
  const mf = r('js/plugin-manifest.js');
  const m = mf.match(/export\s+const\s+INSTALLED_PLUGINS_DIR\s*=\s*['"]([^'"]+)['"]/);
  t('⑤a plugin-manifest.js 里能独立解析出 INSTALLED_PLUGINS_DIR', !!m);
  t('⑤b 新模块常量与它相等（不出现第二份映射）',
    !!m && INSTALLED_DIR === m[1], `${INSTALLED_DIR} vs ${m && m[1]}`);
}

/* ---------------- ⑥ 不自查自封：台账与 host.js ---------------- */
{
  let debt = null;
  try { debt = JSON.parse(r('scripts/market-binding-debt.json')); } catch { /* 下面会红 */ }
  t('⑥a 台账是合法 JSON', !!debt);
  t('⑥b status 仍 wired、runtimeVerified 仍 false',
    !!debt && debt.status === 'wired' && debt.runtimeVerified === false,
    debt && `${debt.status}/${debt.runtimeVerified}`);
  const rl = debt && (debt.blockers || []).find((b) => b.id === 'runtime-load');
  t('⑥c runtime-load 仍 pending-real-device 且标了 codeLanded',
    !!rl && rl.status === 'pending-real-device' && rl.codeLanded === true);
  t('⑥d why 不再把 ES module CORS 整体写成「只有真机能判」',
    !!rl && !/CORS 行为、iframe 是否同源可读，只有真机能判/.test(rl.why),
    rl && rl.why.slice(0, 100));
  t('⑥e unblock 首条不再要求「按分支改对应一行」',
    !!debt && Array.isArray(debt.unblock) && !debt.unblock.some((u) => /按分支改对应一行/.test(u)));

  /* 剥注释：host.js 与 installed-frame.js 文件头都有历史说明，
   * 不剥注释会把注释里的字符串当成真实现（第 210 轮同款坑）。 */
  const hostCode = stripCommentsJs(r('js/host.js'));
  const frameCode = stripCommentsJs(r('js/installed-frame.js'));

  /* 只切 installed 分支的函数体：用「900 字符窗口」会把分支后面
   * 那条**正常的** return resolveEntry(manifest.entry) 也算进去，
   * 于是负向条件恒真、判据永远为假（本轮第一版实测就是这个形状）。 */
  const installedBranch = (s) => {
    const i = s.indexOf('manifest.installed === true');
    if (i < 0) return '';
    const open = s.indexOf('{', i);
    if (open < 0) return '';
    let depth = 0;
    for (let j = open; j < s.length; j += 1) {
      if (s[j] === '{') depth += 1;
      else if (s[j] === '}') {
        depth -= 1;
        if (depth === 0) return s.slice(open + 1, j);
      }
    }
    return '';
  };
  const delegates = (s) => {
    const b = installedBranch(s);
    return b.length > 0 && /resolveInstalledFrameSrc\s*\(/.test(b)
      && !/return resolveEntry\(/.test(b);
  };
  t('⑥f host.js 的 installed 分支真的委托新模块', delegates(hostCode));
  t('⑥g 形态判据来自零依赖的 js/ 模块（不再跨到 scripts/，不另写正则）',
    /from\s*['"]\.\/single-file-shape\.mjs['"]/.test(frameCode)
    && /checkSingleFile\s*\(/.test(frameCode)
    && !/from\s*['"]\.\.\/scripts\//.test(frameCode));
  t('⑥h 三态抛错都在实现里（不是只在注释里）',
    (frameCode.match(/throw fail\(/g) || []).length >= 3);

  /* ---------------- ⑦ 元断言：判据不恒真 / 不恒假 ---------------- */
  t('⑦a delegates 对空文本为假', delegates('') === false);
  t('⑦b delegates 对「退回 resolveEntry」的旧形态为假',
    delegates('if (manifest.installed === true) return resolveEntry(manifest.entry);') === false);
  t('⑦c delegates 对真 host.js 为真（不恒假）', delegates(hostCode) === true);
  const badShape = classifyInstalledHtml(EXTERNAL_HTML);
  const okShape = classifyInstalledHtml(INLINE_HTML);
  t('⑦d classifyInstalledHtml 能识别外链（不恒真）', badShape.ok === false && badShape.remaining.length >= 2);
  t('⑦e classifyInstalledHtml 能识别内联（不恒假）', okShape.ok === true);
  t('⑦f classifyInstalledHtml 对空串返回 ok=true，但成功路径不许靠它',
    classifyInstalledHtml('').ok === true);
  const shapeMatches = (s) => (s.match(/throw fail\(/g) || []).length >= 3
    && /nextAction/.test(s);
  t('⑦g 三态判据对空文本为假（不恒真）', shapeMatches('') === false);
  t('⑦h 三态判据对真模块为真（不恒假）', shapeMatches(frameCode) === true);

  /* ---------------- ⑧ 生产入口运行时边界（第 64 轮 P0） ----------------
   * 既有运行时守卫的入口都是 js/plugin-market.js，扫描集合只含 js/，
   * 从未覆盖主壳 js/host.js，也没把 scripts/ 当可达边界。第 63 轮
   * js/installed-frame.js 一句 `import ../scripts/single-file.mjs`
   * 就把 node:path 拖进了主壳闭包（BFS 实测 27 模块里恰好 1 个
   * node: 内建 import），webview 里整块加载失败，而 18 个守卫全绿。
   * 这一节从真实生产入口做 BFS，钉住「闭包内零 node: / 零 Node 全局 /
   * import 目标全存在 / js 不跨到 scripts」，再用隔离 realm 真加载。 */
  const IMPORT_RE = /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const nodeGlobalRe = /\bBuffer\.|\bprocess\.|\b__dirname\b|\brequire\s*\(/g;
  const importsOf = (rel) => {
    const p = join(ROOT, rel);
    if (!existsSync(p)) return [];
    const s = stripCommentsJs(readFileSync(p, 'utf8'));
    const out = [];
    for (const m of s.matchAll(IMPORT_RE)) out.push(m[1] || m[2] || m[3]);
    return out;
  };
  /* 从入口做闭包。只认能解析成本地真实文件的相对路径；
   * 裸包名 / node: 单列，不算进 seen。 */
  const hostClosure = (entry = 'js/host.js') => {
    const seen = new Set([entry]);
    const queue = [entry];
    const nodeImports = [];
    const missing = [];
    const crossScripts = [];
    const globals = [];
    while (queue.length) {
      const cur = queue.shift();
      const src = existsSync(join(ROOT, cur))
        ? stripCommentsJs(readFileSync(join(ROOT, cur), 'utf8')) : '';
      for (const g of src.matchAll(nodeGlobalRe)) globals.push([cur, g[0]]);
      for (const spec of importsOf(cur)) {
        if (spec.startsWith('node:')) { nodeImports.push([cur, spec]); continue; }
        if (!spec.startsWith('.')) continue;
        const tgt = join(dirname(cur), spec).replace(/\\/g, '/');
        if (cur.startsWith('js/') && tgt.startsWith('scripts/')) crossScripts.push([cur, spec]);
        if (!existsSync(join(ROOT, tgt))) { missing.push([cur, spec, tgt]); continue; }
        if (!seen.has(tgt)) { seen.add(tgt); queue.push(tgt); }
      }
    }
    return { seen, nodeImports, missing, crossScripts, globals };
  };
  const hc = hostClosure();
  t('⑧a 主壳闭包规模不是空集合（BFS 真的走了）', hc.seen.size >= 20,
    `size=${hc.seen.size}`);
  t('⑧b 主壳闭包内零 node: 内建 import', hc.nodeImports.length === 0,
    JSON.stringify(hc.nodeImports.slice(0, 3)));
  t('⑧c 主壳闭包内零 Node 专有全局', hc.globals.length === 0,
    JSON.stringify(hc.globals.slice(0, 3)));
  t('⑧d 主壳闭包内 import 目标全部存在（镜像不悬空）', hc.missing.length === 0,
    JSON.stringify(hc.missing.slice(0, 3)));
  t('⑧e js/ 下运行时模块不跨到 scripts/（构建期与运行期分层）',
    hc.crossScripts.length === 0, JSON.stringify(hc.crossScripts.slice(0, 3)));
  t('⑧f 判据只有一份：构建期重导出的 checkSingleFile 与运行时同一函数引用',
    checkSingleFile === shapeCheck && typeof shapeCheck === 'function');
  const shapeSrc = stripCommentsJs(r('js/single-file-shape.mjs'));
  t('⑧g 形态判据模块源码零 node: / 零 Node 全局',
    !/['"]node:/.test(shapeSrc) && !nodeGlobalRe.test(shapeSrc));
  /* ⑧h 隔离 realm 真加载：linker 遇到 node: 会记下来；
   * 静态 BFS 说「没有」不等于「能加载」，这一层是硬证据。 */
  const VM_SCRIPT = `
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const ROOT = process.env.PROBE_ROOT;
const context = vm.createContext(Object.create(null));
const blocked = [];
const loaded = [];
async function linker(spec, ref) {
  if (spec.startsWith('node:')) {
    blocked.push(spec + ' <- ' + String(ref.identifier).replace(ROOT + '/', ''));
    const names = ['resolve','dirname','join','basename','sep','readFileSync','createHash','gzipSync'];
    return new vm.SyntheticModule(names, function () {
      for (const n of names) this.setExport(n, () => '');
    }, { context, identifier: spec });
  }
  const abs = resolve(dirname(ref.identifier), spec);
  loaded.push(abs.replace(ROOT + '/', ''));
  return new vm.SourceTextModule(readFileSync(abs, 'utf8'), { context, identifier: abs });
}
const entry = join(ROOT, 'js/installed-frame.js');
const m = new vm.SourceTextModule(readFileSync(entry, 'utf8'), { context, identifier: entry });
await m.link(linker);
await m.evaluate();
console.log(JSON.stringify({ blocked, loaded, exports: Object.keys(m.namespace) }));
`;
  const vmRun = spawnSync(process.execPath,
    ['--experimental-vm-modules', '--input-type=module', '-e', VM_SCRIPT],
    { env: { ...process.env, PROBE_ROOT: ROOT }, encoding: 'utf8', timeout: 45000 });
  let vmJson = null;
  try {
    const line = String(vmRun.stdout || '').split('\n').filter((x) => x.trim().startsWith('{')).pop();
    vmJson = line ? JSON.parse(line) : null;
  } catch (_) { vmJson = null; }
  t('⑧h vm 隔离 realm 探针跑通（有 JSON 结果、不是崩了没汇总）',
    vmRun.status === 0 && !!vmJson,
    `status=${vmRun.status} stderr=${String(vmRun.stderr || '').slice(0, 120)}`);
  t('⑧i 真加载链零 node: 阻塞', !!vmJson && vmJson.blocked.length === 0,
    JSON.stringify(vmJson && vmJson.blocked));
  t('⑧j 真加载拿到完整导出面', !!vmJson
    && ['resolveInstalledFrameSrc', 'classifyInstalledHtml', 'installedFrameUrl', 'INSTALLED_DIR']
      .every((k) => vmJson.exports.includes(k)),
    JSON.stringify(vmJson && vmJson.exports));
  /* 元断言：BFS 判据不能恒真 / 恒假 */
  const fakeEntry = 'js/__probe_node.mjs';
  const fakePath = join(ROOT, fakeEntry);
  writeFileSync(fakePath, "import { readFileSync } from 'node:fs';\nexport const x = 1;\n");
  let injected = null;
  try { injected = hostClosure(fakeEntry); }
  finally { unlinkSync(fakePath); }
  t('⑧k 注入 node: 后 BFS 必须报出（判据不恒真）',
    !!injected && injected.nodeImports.length === 1
    && injected.nodeImports[0][1] === 'node:fs',
    JSON.stringify(injected && injected.nodeImports));
  const plain = hostClosure('js/single-file-shape.mjs');
  t('⑧l 纯模块闭包为空阻塞（判据不恒假）',
    plain.nodeImports.length === 0 && plain.globals.length === 0
    && plain.missing.length === 0);
}


console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
