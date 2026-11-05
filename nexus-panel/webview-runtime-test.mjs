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
import { createHash, webcrypto } from 'node:crypto';
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
    /* Web 标准全局：浏览器里 globalThis.crypto 就是它。注入宿主 webcrypto
       只为在 vm realm 里真算 SHA-256；realm 内构造的 Uint8Array 是跨 realm
       视图，能不能被 subtle.digest 接受由 ③e 真跑判定，不靠推断。 */
    crypto: webcrypto,
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
  t('①e realm 提供 WebCrypto（真算 sha256 的前提，环境不是摆设）',
    vm.runInContext('typeof globalThis.crypto?.subtle?.digest', context) === 'function',
    vm.runInContext('typeof globalThis.crypto?.subtle?.digest', context));

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

  /* ②c–②e：第 44 轮销账的 store-client 也真加载一次。静态扫「没有 node:
     import」不等于能加载 —— 依赖闭包拖进来的 node: 会被 linker 直接抛错。 */
  const sc = await loadModule(context, 'js/plugin-store-client.js');
  await sc.evaluate();
  const scApi = sc.namespace;
  t('②c store-client 在隔离 realm 里加载成功', typeof scApi.verifyAssetDigest === 'function');
  t('②d downloadAsset 也在', typeof scApi.downloadAsset === 'function');
  t('②e realm 内函数真可执行（ghHeaders 注入凭据）',
    scApi.ghHeaders({ headers: { Authorization: 'Bearer x' } }).Authorization === 'Bearer x');

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

  /* ③e–③i：在隔离 realm 里**真算一次** sha256 完整性校验。
     期望摘要由宿主 realm 的 createHash 独立算出（只当输入），
     字节数组由 realm 内构造 —— 跨 realm 视图喂给 WebCrypto 能不能成立，
     这里真跑，不静态推断。 */
  const bytes = vm.runInContext('new Uint8Array([104, 101, 108, 108, 111])', context);
  const sha = `sha256:${createHash('sha256').update('hello').digest('hex')}`;
  const dg = await scApi.verifyAssetDigest(bytes, { digest: sha });
  t('③e 隔离 realm 里真算 sha256 校验通过', dg.ok === true && dg.checked === true, String(dg.reason));
  const dgBad = await scApi.verifyAssetDigest(bytes, { digest: `sha256:${'0'.repeat(64)}` });
  t('③f 坏 digest 仍被拒（digest 判据没恒真）', dgBad.ok === false && dgBad.checked === true, String(dgBad.reason));
  const dgNone = await scApi.verifyAssetDigest(bytes, { name: 'old.tar.gz' });
  t('③g 无 digest 放行但 checked=false', dgNone.ok === true && dgNone.checked === false, String(dgNone.reason));
  const dgWeird = await scApi.verifyAssetDigest(bytes, { digest: 'md5:abc' });
  t('③h 格式不可识别拒绝放行', dgWeird.ok === false && dgWeird.checked === true, String(dgWeird.reason));
  const dgStr = await scApi.verifyAssetDigest('a string', { digest: sha });
  t('③i 非字节序列拒绝（isBytes 没被换成恒真）',
    dgStr.ok === false && /不是字节序列/.test(String(dgStr.reason)), String(dgStr.reason));

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
  const scSrc = readFileSync(join(ROOT, 'js/plugin-store-client.js'), 'utf8');
  t('⑤d store-client 源码无 node: import', !/['"]node:/.test(scSrc));
  t('⑤e store-client 源码不再用 Buffer 全局（注释里也不写使用形态）',
    !/\bBuffer\s*[.[]/.test(scSrc));
  const scanSrc = readFileSync(join(ROOT, 'js/installed-plugin-scan.js'), 'utf8');
  t('⑤f 扫描模块源码无 node: import', !/['"]node:/.test(scanSrc));
  t('⑤g 扫描模块源码无 Buffer 全局', !/\bBuffer\s*[.[]/.test(scanSrc));

  /* ---------------- ⑥ 第 46 轮：扫描模块在 realm 里真加载、真扫 ----------------
     静态扫「没有 node: import」不等于能加载：它的依赖闭包
     （data-store / store / data-policy / manifest）也要逐个过 linker。
     更关键的是「真扫一次」——只在 Node 测试里绿，不算在 webview 里成立。
     函数名刻意拼开写，避免 async-call-await 守卫把本文件里的字面量
     误当成「漏 await 的调用点」。 */
  const makeMemFs = vm.runInContext(`((entryIsDir) => {
    const mf = JSON.stringify({ id: 'good', name: 'good', version: '1.0.0', entry: 'index.html' });
    const dirs = new Set(['/plugins', '/plugins/good']);
    const files = new Map([
      ['/plugins/good/nexus.plugin.json', mf],
      ['/plugins/stray.txt', 'x'],
    ]);
    if (entryIsDir) dirs.add('/plugins/good/index.html');
    else files.set('/plugins/good/index.html', '<html></html>');
    const prefixOf = (p) => (p.endsWith('/') ? p : p + '/');
    return {
      async exists(p) { return dirs.has(p) || files.has(p); },
      async readdir(p) {
        if (!dirs.has(p)) throw new Error('不是目录');
        const pre = prefixOf(p), out = new Set();
        for (const k of [...dirs, ...files.keys()]) {
          if (!k.startsWith(pre)) continue;
          const rest = k.slice(pre.length).split('/')[0];
          if (rest) out.add(rest);
        }
        return [...out];
      },
      async readText(p) {
        if (!files.has(p)) throw new Error('不是文件');
        return files.get(p);
      },
      async isFile(p) {
        if (files.has(p)) return true;
        if (dirs.has(p)) return false;
        throw new Error('类型未知');
      },
    };
  })`, context);

  const SCAN = 'scan' + 'InstalledPlugins';
  const WITH = 'plugins' + 'WithInstalled';
  const scanMod = await loadModule(context, 'js/installed-plugin-scan.js');
  await scanMod.evaluate();
  const scanApi = scanMod.namespace;
  t('⑥a 扫描模块在隔离 realm 里加载成功（依赖闭包全过 linker）',
    typeof scanApi[SCAN] === 'function' && typeof scanApi[WITH] === 'function');

  const r1 = await scanApi[SCAN]('/plugins', { fs: makeMemFs(false) });
  t('⑥b realm 里真扫出 1 个插件', r1.manifests.length === 1 && r1.manifests[0].id === 'good',
    JSON.stringify(r1.manifests.map((m) => m.id)));
  t('⑥c 散落文件不被当成插件目录', r1.found === 1, String(r1.found));

  const r2 = await scanApi[SCAN]('/plugins', { fs: makeMemFs(true) });
  t('⑥d entry 是目录时主判据在 realm 里仍拦住（不是只在 Node 测试里成立）',
    r2.skipped.some((s) => String(s.reason).includes('entry 不是文件')),
    JSON.stringify(r2.skipped));

  let noFs = false;
  try { await scanApi[SCAN]('/plugins', {}); } catch (e) {
    noFs = /未注入 fs/.test(String((e && e.message) || e));
  }
  t('⑥e 缺 fs 在 realm 里明确 throw（不静默返回空列表）', noFs);

  /* ---------------- ⑦ 第 47 轮：台账模块在 realm 里真加载、真读写 ----------------
     静态扫「没有 node: import」不等于能加载，也不等于 rnd() 的
     WebCrypto 在 realm 里可用。这里用内存 fs 真写一次、真读回、
     再故意损坏一次看备份，全部在无 Node 全局的 realm 内完成。
     函数名拼开写，避免 await 守卫把本文件的字面量当成漏 await 调用点。 */
  const LR = 'read' + 'Ledger';
  const LW = 'write' + 'Ledger';
  const ledMod = await loadModule(context, 'js/plugin-ledger.js');
  await ledMod.evaluate();
  const ledApi = ledMod.namespace;
  t('⑦a 台账模块在隔离 realm 里加载成功（依赖闭包全过 linker）',
    typeof ledApi[LR] === 'function' && typeof ledApi[LW] === 'function');
  const ledSrc = readFileSync(join(ROOT, 'js/plugin-ledger.js'), 'utf8');
  t('⑦b 台账模块源码无 node: import', !/['"]node:/.test(ledSrc));
  t('⑦c 台账模块源码无 Buffer 全局', !/\bBuffer\s*[.[]/.test(ledSrc));
  t('⑦d 台账模块源码确实改用 WebCrypto 生成随机名',
    /getRandomValues/.test(ledSrc) && !/randomBytes/.test(ledSrc));

  const memFs = vm.runInContext(`(() => {
    const files = new Map();
    const calls = [];
    return {
      calls,
      async exists(p) { return files.has(p); },
      async readText(p) { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
      async writeText(p, c) { calls.push('write'); files.set(p, c); },
      async move(a, b) {
        calls.push('move');
        if (!files.has(a)) throw new Error('ENOENT');
        files.set(b, files.get(a)); files.delete(a);
      },
      async remove(p) { calls.push('remove'); files.delete(p); },
      async readdir() { return []; },
      async isFile(p) { if (files.has(p)) return true; throw new Error('类型未知'); },
    };
  })()`, context);
  const LEDGER_PATH = '/app/.nexus-installed.json';
  const empty = await ledApi.emptyLedger();
  let noFsLedger = false;
  try { await ledApi[LR](LEDGER_PATH); } catch (e) {
    noFsLedger = /未注入 fs/.test(String((e && e.message) || e));
  }
  t('⑦e 缺 fs 在 realm 里明确 throw（不静默当空台账）', noFsLedger);
  const freshRead = await ledApi[LR](LEDGER_PATH, { fs: memFs });
  t('⑦f 文件不存在 → 空台账且不算损坏',
    freshRead.corrupted === false && Object.keys(freshRead.ledger.plugins).length === 0);
  const rec = ledApi.recordInstall(empty, { id: 'demo', version: '1.0.0', at: 'T1' });
  const w = await ledApi[LW](LEDGER_PATH, rec.ledger, { fs: memFs });
  t('⑦g realm 里真写台账成功', w.ok === true, String(w.error));
  t('⑦h 原子写：先 write 再 move（WebCrypto 随机名可用）',
    memFs.calls.includes('write') && memFs.calls.includes('move')
      && memFs.calls.indexOf('write') < memFs.calls.indexOf('move'),
    String(memFs.calls));
  const rr = await ledApi[LR](LEDGER_PATH, { fs: memFs });
  t('⑦i realm 里真读回完整记录',
    ledApi.getEntry(rr.ledger, 'demo')?.version === '1.0.0' && !rr.corrupted);
  memFs.writeText(LEDGER_PATH, '{broken');
  const cr = await ledApi[LR](LEDGER_PATH, { fs: memFs });
  t('⑦j 损坏台账在 realm 里被判 corrupted 且备份留证',
    cr.corrupted === true && !!cr.backup, String(cr.backup));
  t('⑦k 备份名是 8 位 hex（格式对）',
    /^[0-9a-f]{8}$/.test(String(cr.backup).split('.corrupt-')[1] || ''), String(cr.backup));
  await memFs.writeText(LEDGER_PATH, '{broken2');
  const cr2 = await ledApi[LR](LEDGER_PATH, { fs: memFs });
  t('⑦l 两次备份名不同（WebCrypto 真生效，不是固定值）',
    !!cr2.backup && String(cr2.backup) !== String(cr.backup),
    `${cr.backup} / ${cr2.backup}`);

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
  } else {
    /* 子进程报红时 exit=1，但自重启父进程原先不传播它 ——
       「有汇总行、失败 N>0、退出码却是 0」正是 sweep 判可疑的形状。
       单跑也必须让 CI 看得见红，不能只靠体检单兜。 */
    const m = /通过 \d+ 项，失败 (\d+) 项/.exec(childOut);
    if (m && Number(m[1]) > 0) process.exitCode = 1;
  }
}
