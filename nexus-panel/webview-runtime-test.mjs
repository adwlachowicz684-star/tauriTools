/**
 * webview 隔离验收：在「没有 Node 全局」的 realm 里真加载、真解包
 * ============================================================================
 *
 * 为什么不能只靠静态扫 import
 * ------------------------------------------------------------
 * 第 43 轮查明：台账原先只扫 `import node:*`，于是
 *   · Buffer / process / require 等 Node 专有全局（不写 import 也崩）
 *   · 静态 import 链（自己零 node:，被依赖方拖死）
 * 两类都看不见。29/0 全绿的那版守卫就漏了它们。
 *
 * 这个测试不静态推断，而是**真跑**：
 *   vm.SourceTextModule 造一个只注入 Web 标准全局的 realm，
 *   里面 Buffer / process / require 全是 undefined，然后加载
 *   js/plugin-tarball.js 及其唯一依赖，喂一份真 .tar.gz 进去解包。
 *
 * ⛔ 先验环境再验行为：若 context 里其实有 Buffer，下面全绿毫无意义
 *    （空集合判据恒真的老问题）。所以①②专门钉住「确实没有」。
 *
 * 自重启：SourceTextModule 需要 --experimental-vm-modules。
 *   直接 `node webview-runtime-test.mjs` 也能跑，脚本会用该 flag 重开自己；
 *   不依赖调用方记得加参数，也不依赖 npm script 里写对。
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const SELF = fileURLToPath(import.meta.url);
const INNER_FLAG = '--webview-inner';

let pass = 0;
const fails = [];
function t(name, ok, detail = '') {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

/** 造一份最小 USTAR（外部 realm 用 Buffer 造，只是输入，不进 webview） */
function makeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const content = Buffer.from(e.content, 'utf8');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.fill(32, 148, 156);
    h[156] = 0x30;                      // '0' 普通文件
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(h);
    const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
    content.copy(body);
    blocks.push(body);
  }
  blocks.push(Buffer.alloc(1024));      // 两个全零块
  return Buffer.concat(blocks);
}

async function loadModule(context, rel, cache = new Map()) {
  if (cache.has(rel)) return cache.get(rel);
  const mod = new vm.SourceTextModule(
    readFileSync(join(ROOT, rel), 'utf8'),
    { context, identifier: rel },
  );
  cache.set(rel, mod);
  const linker = async (spec, ref) => {
    /* 别把 node: 内建当相对路径去读文件：那会报 ENOENT，
       把「引入了 Node 内建」伪装成「某个文件不存在」，箭头指错方向。 */
    if (/^node:/.test(spec)) {
      throw new Error(`隔离 realm 不允许 node: 内建模块（${spec} 来自 ${ref.identifier}）—— 这正是本测试要抓的`);
    }
    return loadModule(context, join(dirname(ref.identifier), spec).replace(/\\/g, '/'), cache);
  };
  await mod.link(linker);
  return mod;
}

async function run() {
  /* 只注入 Web 标准全局；vm 自带 Uint8Array / ArrayBuffer / Promise 等内建，
     但**不会**自带 Buffer / process / require / __dirname。 */
  const sandbox = {
    TextDecoder, TextEncoder, Blob, Response, DecompressionStream, URL, console,
  };
  const context = vm.createContext(sandbox);

  t('①a realm 里没有 Buffer',
    vm.runInContext('typeof Buffer', context) === 'undefined',
    vm.runInContext('typeof Buffer', context));
  t('①b realm 里没有 process',
    vm.runInContext('typeof process', context) === 'undefined',
    vm.runInContext('typeof process', context));
  t('①c realm 里没有 require',
    vm.runInContext('typeof require', context) === 'undefined',
    vm.runInContext('typeof require', context));

  /* 元断言：环境确实会拒绝 Node 专有全局 —— 否则①②是空集合判据恒真 */
  const probe = new vm.SourceTextModule(
    'export function f(x) { return Buffer.isBuffer(x); }',
    { context, identifier: 'probe.js' },
  );
  await probe.link(() => { throw new Error('probe 不该有依赖'); });
  await probe.evaluate();
  let threw = false;
  try { probe.namespace.f(new Uint8Array(1)); } catch { threw = true; }
  t('①d 元断言：真用到 Buffer 会抛（环境不是摆设）', threw);

  /* ② 真加载解包器 */
  const entry = 'js/plugin-tarball.js';
  const top = await loadModule(context, entry);
  await top.evaluate();
  const api = top.namespace;
  t('②a 解包器在隔离 realm 里加载成功', typeof api.unpackTarGz === 'function');
  t('②b 纯函数 parseTar 也在', typeof api.parseTar === 'function');

  const manifest = JSON.stringify({ id: 'demo', name: '示例', version: '1.0.0', entry: 'index.html' });
  const tar = makeTar([{ name: 'demo-1.0.0/nexus.plugin.json', content: manifest }]);
  const gz = new Uint8Array(gzipSync(tar));

  const r = await api.unpackTarGz(gz);
  t('③a 真 .tar.gz 解包成功', r.ok === true, r.error || '');
  t('③b 恰好 1 个条目', r.entries.length === 1, String(r.entries.length));
  t('③c 文件名还原', r.entries[0]?.name === 'demo-1.0.0/nexus.plugin.json',
    String(r.entries[0]?.name));
  let text = '';
  try { text = new TextDecoder('utf-8').decode(r.entries[0].content); } catch (e) { text = `decode 失败: ${e}`; }
  t('③d 内容逐字节还原（不靠 Buffer.toString）', text === manifest, text.slice(0, 80));

  /* ④ 判据没被"换成恒真"：坏输入仍然拒绝 */
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const rz = await api.unpackTarGz(zip);
  t('④a zip 魔数明确拒绝、不降级', rz.ok === false && /zip/.test(rz.error || ''),
    rz.error || '');
  const notGzip = new Uint8Array(Buffer.from('<html>not a tar</html>'));
  const rn = await api.unpackTarGz(notGzip);
  t('④b 非 gzip 拒绝', rn.ok === false, rn.error || '');
  const broken = new Uint8Array(gzipSync(Buffer.concat([Buffer.alloc(512), Buffer.alloc(1024)])));
  const rb = await api.unpackTarGz(broken);
  t('④c 空 tar 拒绝（parseTar 判据仍在）', rb.ok === false, rb.error || '');
  const badHead = new Uint8Array(tar);
  badHead[0] ^= 0xff;
  t('④d 校验和坏头拒绝', api.parseTar(badHead).ok === false);

  /* ⑤ 静态面：解包器及其依赖一个 node: / Buffer 都不能有 */
  const src = readFileSync(join(ROOT, entry), 'utf8');
  const dep = readFileSync(join(ROOT, 'js/archive-magic.js'), 'utf8');
  t('⑤a 解包器源码无 node: import', !/['"]node:/.test(src));
  t('⑤b 依赖源码无 node: import', !/['"]node:/.test(dep));
  t('⑤c 解包器不再 import plugin-installer.js（静态链已断）',
    !/from\s*['"]\.\/plugin-installer\.js['"]/.test(src));

  if (fails.length) for (const f of fails) console.log('  ✗ ' + f);
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) process.exitCode = 1;
}

async function guardedRun() {
  try {
    await run();
  } catch (e) {
    /* 模块 link / evaluate 抛错时也要有标准汇总行：
       「崩了」不等于「守卫喊了」，体检单只认汇总行。 */
    fails.push(`隔离 realm 加载/执行异常 — ${String((e && e.message) || e)}`);
    for (const f of fails) console.log('  ✗ ' + f);
    console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
    process.exitCode = 1;
  }
}

if (process.argv.includes(INNER_FLAG) || vm.SourceTextModule) {
  await guardedRun();
} else {
  const r = spawnSync(
    process.execPath, ['--experimental-vm-modules', SELF, INNER_FLAG],
    { encoding: 'utf8', timeout: 90000 },
  );
  const childOut = r.stdout || '';
  process.stdout.write(childOut);
  const noise = (r.stderr || '').split('\n')
    .filter((l) => l && !/ExperimentalWarning|--trace-warnings|node:internal/.test(l));
  if (noise.length) process.stderr.write(noise.join('\n') + '\n');
  /* 子进程给出标准汇总行 = 正常报红也算「喊了」，不能当崩溃。
     只有连汇总行都没有（真崩 / 超时 / 被 kill）才补一条失败行。 */
  if (!/通过 \d+ 项，失败 \d+ 项/.test(childOut)) {
    console.log(`通过 0 项，失败 1 项 — 隔离 realm 子进程没有汇总行（status=${r.status}）`);
    process.exitCode = 1;
  }
}
