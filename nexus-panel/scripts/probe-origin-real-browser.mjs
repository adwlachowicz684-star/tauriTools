/**
 * 真实浏览器四象限实证：已安装插件「加载入口」到底被什么卡住。
 *
 * 这是联网/浏览器依赖的诊断探针，**不进 npm script、不进 CI**。
 * 运行：node scripts/probe-origin-real-browser.mjs   （需 playwright + chromium）
 *
 * 它不冒充 Tauri asset: 协议本身，只复现生产代码注释里实机记录过的两个机制：
 *   ① 同源相对路径：module 执行、桥接 ready 可达、contentDocument 可读；
 *   ② 跨源 iframe 里的**内联** <script type="module"> 随 HTML 自执行，不发 CORS
 *      请求，ready 经 postMessage + e.source 仍到外壳，contentDocument 恒 null；
 *   ③ 跨源 + ACAO 写死另一个 origin 时，**外链** module 下载 200 但被 CORS
 *      拒绝执行（host.js runtimeFrameUrl 注释②的形状）。
 *
 * 被验证对象是仓库 runtime-plugins/ 下的真实构建产物，不是手写夹具。
 * 证据写入 scripts/origin-evidence.json（与脚本同目录）。
 *
 * 第 213 轮：evidence 的字段契约与那份证据文件**逐键一致**（重跑不会把
 * 「contentDocumentReadable/readyReceived」改成另一套名字，否则任何按证据
 * 字段读结论的复核工具会拿到满屏 undefined 并把 PASS 抹成 INCONCLUSIVE）。
 * 外链 bundle 的插件 id 由 runtime-plugins/ 的真实 HTML 形态统计得出，
 * 不写死任何插件 id；形态变了宁可显式报错，也不静默跑出 PASS。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('../runtime-plugins/', import.meta.url));
if (!fs.existsSync(ROOT)) throw new Error(`找不到产物目录：${ROOT}（探针必须在仓库副本里跑）`);

// playwright 可能本地装、全局装（NODE_PATH）；三种解析都试，全失败明确抛错
let chromium = null;
for (const base of [import.meta.url, process.cwd() + '/package.json', `${process.env.NODE_PATH || ''}/package.json`]) {
  try { ({ chromium } = createRequire(base)('playwright')); break; } catch { /* 下一种 */ }
}
if (!chromium) throw new Error('playwright 不可用：npm i playwright 或正确设置 NODE_PATH');

const PORT_SHELL = 8801, PORT_ASSET = 8802, PORT_XJS = 8804;
const FIXED_ACAO = 'http://127.0.0.1:8803'; // 故意 != 8802，模拟「写死外壳 origin」
const EXE = process.env.CHROMIUM_PATH || undefined;

const mime = (p) => p.endsWith('.html') ? 'text/html; charset=utf-8'
  : /\.(js|mjs)$/.test(p) ? 'text/javascript; charset=utf-8'
    : p.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';

const ids = fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory()).sort();
const assetRequests = [], xjsRequests = [];

/* 产物形态由真实 index.html 的 script 标签决定，不写死插件 id。
   谁把某个插件改成外链 bundle，第四象限自动跟着换样本；反过来若 12 份
   全变成内联，下面这道闸门会明确报错，而不是让 verdict 静默保持 PASS。 */
const shape = {};
for (const id of ids) {
  const html = fs.readFileSync(path.join(ROOT, id, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  shape[id] = { scripts: tags.length, external: tags.filter((t) => /\bsrc\s*=/.test(t)).length };
}
const EXTERNAL_IDS = Object.keys(shape).filter((id) => shape[id].external > 0);
const EXTERNAL_ID = EXTERNAL_IDS[0] || null;
if (!EXTERNAL_ID) throw new Error('产物里没有外链 bundle：第四象限无从复现，不许静默跑出 PASS');

function pluginFile(id, rel) {
  const base = path.join(ROOT, id);
  const p = path.resolve(base, rel.replace(/^\/+/, ''));
  if (!p.startsWith(base)) throw new Error('path escape');
  return fs.readFileSync(p);
}

const assetSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  assetRequests.push({ path: u.pathname, origin: req.headers.origin || null });
  res.setHeader('Access-Control-Allow-Origin', FIXED_ACAO);
  res.setHeader('Content-Type', mime(u.pathname));
  const m = u.pathname.match(/^\/p\/([^/]+)\/(.*)$/);
  if (!m) { res.statusCode = 404; res.end('missing'); return; }
  try {
    let body = pluginFile(m[1], m[2]);
    // 唯一外链 bundle：把 ./assets/ 改指真正跨源的 8804，其余字节不动
    if (m[1] === EXTERNAL_ID && m[2] === 'index.html') {
      body = Buffer.from(body.toString('utf8').replace(/(["'])\.\/assets\//g, `$1http://127.0.0.1:${PORT_XJS}/assets/`));
    }
    res.end(body);
  } catch { res.statusCode = 404; res.end('missing'); }
});

const xjsSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  xjsRequests.push({ path: u.pathname, origin: req.headers.origin || null });
  res.setHeader('Access-Control-Allow-Origin', FIXED_ACAO);
  res.setHeader('Content-Type', mime(u.pathname));
  try { res.end(pluginFile(EXTERNAL_ID, u.pathname)); }
  catch { res.statusCode = 404; res.end('missing'); }
});

/* 结论判据只有这一份：既给探针自己用，也被守卫切真身喂落盘证据实跑。
   字段名必须跟 origin-evidence.json 一致 —— 写成旧的 docReadable/ready
   会让四个场景全 undefined，PASS 被静默抹成 INCONCLUSIVE。 */
function verdictOf(evidence) {
  const s = evidence && evidence.scenario;
  if (!s) return false;
  return !!(s.sameOriginRuntime.readyReceived
    && s.installedSameOriginProjection.readyReceived
    && s.crossOriginInlineBundle.readyReceived
    && s.crossOriginInlineBundle.contentDocumentReadable === false
    && s.crossOriginExternalBundle.externalModuleDownloaded > 0
    && s.crossOriginExternalBundle.readyReceived === false);
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>origin probe shell</title></head><body>
<iframe id="same" src="/same/index.html"></iframe>
<iframe id="installed" src="/installed-plugins/index.html"></iframe>
<iframe id="assetInline" src="http://127.0.0.1:${PORT_ASSET}/p/demo-light/index.html"></iframe>
<iframe id="assetExternal" src="http://127.0.0.1:${PORT_ASSET}/p/${EXTERNAL_ID}/index.html"></iframe>
<script>
window.__msgs=[];window.__errs=[];
window.addEventListener('error',e=>window.__errs.push(String(e.message)));
window.addEventListener('message',e=>{const d=e.data;if(d&&d.channel==='nexus-bridge-v1'){
 let who='?';for(const id of ['same','installed','assetInline','assetExternal']){
  if(e.source===document.getElementById(id).contentWindow)who=id;}
 window.__msgs.push({who:who,type:d.type,origin:e.origin});}});
</script></body></html>`;

const shellSrv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(HOST); return; }
  res.setHeader('Content-Type', mime(p));
  const m = p.match(/^\/(same|installed-plugins)\/(.*)$/);
  if (m) { try { res.end(pluginFile('demo-light', m[2])); } catch { res.statusCode = 404; res.end('missing'); } return; }
  res.statusCode = 404; res.end('missing');
});

const listen = (s, port) => new Promise((r) => s.listen(port, '127.0.0.1', r));

async function run() {
  await listen(shellSrv, PORT_SHELL); await listen(assetSrv, PORT_ASSET); await listen(xjsSrv, PORT_XJS);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'], ...(EXE ? { executablePath: EXE } : {}) });
    const page = await (await browser.newContext()).newPage();
    const consoleErrs = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 240)); });
    await page.goto(`http://127.0.0.1:${PORT_SHELL}/`, { waitUntil: 'load' });
    await page.waitForTimeout(4000);
    const out = await page.evaluate(() => {
      const read = (id) => {
        const f = document.getElementById(id); let doc = null;
        try { doc = f.contentDocument; } catch { /* 跨源 */ }
        return { docReadable: !!doc };
      };
      return { msgs: window.__msgs, errs: window.__errs,
        same: read('same'), installed: read('installed'),
        assetInline: read('assetInline'), assetExternal: read('assetExternal') };
    });
    const by = (w) => out.msgs.filter((m) => m.who === w);
    const extJs = xjsRequests.filter((r) => /\.(js|mjs)$/.test(r.path));
    const inline = Object.values(shape).filter((s) => s.external === 0).length;
    const readyOf = (who) => by(who).some((m) => m.type === 'ready');
    const readyOrigins = (who) => [...new Set(by(who).filter((m) => m.type === 'ready').map((m) => m.origin))];
    const evidence = {
      pluginCount: ids.length,
      productShape: {
        inlineBundle: inline, externalBundle: ids.length - inline,
        externalBundleId: EXTERNAL_ID, shape,
      },
      scenario: {
        sameOriginRuntime: {
          contentDocumentReadable: out.same.docReadable, readyReceived: readyOf('same'),
        },
        installedSameOriginProjection: {
          contentDocumentReadable: out.installed.docReadable, readyReceived: readyOf('installed'),
        },
        crossOriginInlineBundle: {
          contentDocumentReadable: out.assetInline.docReadable,
          readyReceived: readyOf('assetInline'),
          readyOrigin: readyOrigins('assetInline'),
        },
        crossOriginExternalBundle: {
          contentDocumentReadable: out.assetExternal.docReadable,
          readyReceived: readyOf('assetExternal'),
          externalModuleDownloaded: extJs.length,
          downloadedPaths: [...new Set(extJs.map((r) => r.path))],
          requestOrigins: [...new Set(xjsRequests.map((r) => r.origin))],
          fixedACAO: FIXED_ACAO,
        },
      },
      consoleErrors: consoleErrs, windowErrors: out.errs, rawMessages: out.msgs,
    };
    const outPath = fileURLToPath(new URL('./origin-evidence.json', import.meta.url));
    fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    const ok = verdictOf(evidence);
    console.log(ok ? 'VERDICT: PASS (mechanism reproduced)' : 'VERDICT: INCONCLUSIVE');
    process.exitCode = ok ? 0 : 2;
  } finally {
    if (browser) await browser.close();
    shellSrv.close(); assetSrv.close(); xjsSrv.close();
  }
}
run().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
