#!/usr/bin/env node
/**
 * 阶段 0 加载侧 · 真机自检探针（不进 CI、不登记 npm script）
 * ============================================================================
 *
 * 为什么需要它
 * ------------------------------------------------------------
 * 第 50 轮把「CSP 资产 302」和「installed-plugins/ → 侧边栏」一起标成
 * pending-real-device，含糊了 50 轮。实测拆开后两者性质完全不同：
 *
 *   · CSP 域名是**确定性配置缺口**，不用真机也能查：资产 302 的真实落点是
 *     https://release-assets.githubusercontent.com/...（curl 实取），
 *     不是台账沿用至今的 objects.githubusercontent.com。照旧台账补会补错域名，
 *     真机上照样「查得到版本、下载失败」。配置已在 tauri.conf.json 修好。
 *   · asset 协议能否把 $APPDATA/installed-plugins/<id>/index.html 里的
 *     ES module 跑起来、iframe 是否同源可读 —— 这三项**只有真机能判**
 *     （runtimeFrameUrl 的文件头记过 asset 协议三个历史坑）。
 *
 * 本探针只负责把真机那三项变成「一次采集、结构化输出、按结果分支」，
 * 不替真机下结论，也不改任何产品行为。
 *
 * 判据只有一份
 * ------------------------------------------------------------
 * evaluate() 是唯一的结论判据，DEVTOOLS_SNIPPET 只采集证据并打印 JSON，
 * **不含任何判定逻辑**（守卫 ④b/④c 钉住）。用法：
 *   1) 在 Tauri 窗口 devtools 里粘贴 DEVTOOLS_SNIPPET 并回车
 *   2) 把打印出的 checks 数组贴回来
 *   3) node -e "import(...).then(m=>console.log(m.evaluate(checks)))" 得到 nextAction
 * 这样不会出现「devtools 里一份、模块里一份」的第二判据漂移。
 *
 * 采集项里 ok:null 表示这一跳真机没测出来，evaluate() 一律判未测出，
 * 绝不当成通过 —— 空集合恒真是本项目反复栽的假绿。
 *
 * 第 210 轮补的一处（同一类形状的漏网）
 * ------------------------------------------------------------
 *   · 全通过指令的臆想概念修好了，但 moduleScript 失败那条仍指向
 *     js/host.js 的 srcdoc —— 实测它只出现在 resolveFrameSrc 的方案
 *     注释里，实现 0 命中；落点实证 ⑦g 又用全文 includes，被同一份
 *     注释喂饱，85 项全绿看不出来。现 reason 改指 resolveFrameSrc()
 *     的真实 throw 分支，⑦g 改剥注释后判定并配注释喂饱反例自检。
 *
 * 第 58 轮修的三处（都是「真机跑完仍不知道改哪一行」的形状）
 * ------------------------------------------------------------
 *   · 全通过那条指令原指向一个生产代码里 0 命中的概念；实测 js/ 下
 *     没有任何实现，只有探针/守卫/台账自己写过它。真机五项全通过照它
 *     去搜会一无所获。现指向 js/host.js 的 resolveFrameSrc() 中
 *     manifest.installed === true 那个 throw 分支 —— 那才是真实落点。
 *   · BRANCH 把元前提 tauri 排在第四：若有人在普通浏览器 devtools 跑
 *     片段，tauri=false 会先被 appDataHtml 抢走，给出「改后端代下」这种
 *     让人去改产品代码的错误指令。现提到最前。
 *   · 多项失败只返回第一条，其余失败项被静默丢弃，改完再跑才冒下一处。
 *     现 reasons 一并列全，并注明按优先级一次只改一处、改完重跑。
 *
 * 第 57 轮修的两处（都是「真机白跑一次」的形状）
 * ------------------------------------------------------------
 *   · evaluate() 原来只认 ok === false。贴回来的 JSON 若把 ok 写成
 *     undefined / "false" / 0 / "true"，它既不进 unknown 也不进 failed，
 *     会落进 !failed.length 被当成五项全通过并 canMarkBound=true ——
 *     这是唯一能让自查自封蒙混过去的口子。现改为严格三态校验 + 重复 id 校验。
 *   · 第 59 轮：⑦ 的 32 组合穷举只覆盖 true/false，而采集链在跨源时把
 *     moduleScript 正常化成 null（第三态）；unknown fail-closed 会把整局
 *     降级成 collect-more，bridge-fallback 这条真实落点永远不可达。现在
 *     跨源结构性结论单独接管，moduleScript 的 null 只标「因此未测出」。
 *   · DEVTOOLS_SNIPPET 的 moduleScript 原来查
 *     documentElement.dataset.probeReady。实测 12/12 产物 0 命中该标记，
 *     这一项恒 false，真机再好也转不了 bound，还会给出错误分支。
 *     产物真实自带的信号是桥接框架的 parent.postMessage
 *     {channel:'nexus-bridge-v1', type:'ready'}（12/12 命中，
 *     project-group 在外链 assets/index-*.js 里）。判据改锚这个信号，
 *     并由守卫对真实产物逐份实证，防止再长出臆想约定。
 */

/** 采集项 id 集合。守卫验它与 devtools snippet 的采集项严格一致。 */
export const REQUIRED_CHECKS = [
  'tauri',            // Tauri 运行时与 convertFileSrc 可用
  'appDataHtml',      // asset 协议能取到 installed-plugins/<id>/index.html
  'moduleScript',     // 该页里的 ES module script 真的执行了（桥接 ready 信号）
  'contentDocument',  // iframe 的 contentDocument 可读（同源）
  'csp302',           // 带 PAT 的 release asset 302 实际返回 gzip 字节流
];

/**
 * 纯函数：把采集到的证据映射成「下一步改哪一行」。
 *
 * @param {Array<{id:string, ok:boolean|null, evidence?:string}>} checks
 * @returns {{ conclusion:string, nextAction:string, canMarkBound:boolean,
 *             reasons:string[] }}
 */
export function evaluate(checks) {
  const arr = Array.isArray(checks) ? checks : [];
  const entries = arr.filter((c) => c && typeof c.id === 'string');
  const by = new Map(entries.map((c) => [c.id, c]));
  const reasons = [];

  /* fail-closed：缺项 / 未测出 / 值域非法 / 重复项，一律不许标 bound。
     值域这条是第 57 轮补的：旧判据只认 ok === false，非三态值会被
     !failed.length 当成「五项全通过」，是自查自封转 bound 的唯一口子。 */
  /* 第 59 轮：采集链是三态（true/false/null），⑦ 的 32 组合穷举只覆盖两态。
     真实 devtools 片段在 iframe 跨源（contentDocument=false）时把
     moduleScript 正常化成 null ——「DOM 不可读」是确定结论，不是「没测出来」。
     若 unknown 直接把它拦成 collect-more，BRANCH 里 bridge-fallback 这条
     真实落点永远不可达，用户拿到的是「再采一次」而不是「改哪一行」。
     豁免只对这一形态生效，三条红线不动：
       · moduleScript=false 仍按 BRANCH 给 srcdoc-or-inline-bundle
       · 元前提 tauri / appDataHtml 非 true 时不豁免
       · canMarkBound 恒 false，不借它转 bound */
  const cdFail = by.get('contentDocument')?.ok === false;
  const upstreamOk = by.get('tauri')?.ok === true && by.get('appDataHtml')?.ok === true;
  const msUnmeasured = by.get('moduleScript')?.ok === null;
  const structuralCrossOrigin = cdFail && upstreamOk && msUnmeasured;

  const missing = REQUIRED_CHECKS.filter((id) => !by.has(id));
  if (missing.length) reasons.push(`缺采集项：${missing.join(', ')}`);
  const unknown = REQUIRED_CHECKS.filter((id) => by.has(id) && by.get(id).ok === null
    && !(structuralCrossOrigin && id === 'moduleScript'));
  if (unknown.length) reasons.push(`真机未测出：${unknown.join(', ')}`);
  const malformed = REQUIRED_CHECKS.filter((id) => {
    if (!by.has(id)) return false;
    const v = by.get(id).ok;
    return !(v === true || v === false || v === null);
  });
  if (malformed.length) reasons.push(`ok 值域非法（须 true/false/null）：${malformed.join(', ')}`);
  const ids = entries.map((c) => c.id);
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dup.length) reasons.push(`重复采集项（后写会把 false 洗成 true）：${dup.join(', ')}`);
  if (missing.length || unknown.length || malformed.length || dup.length) {
    return { conclusion: 'inconclusive', nextAction: 'collect-more', canMarkBound: false, reasons };
  }

  /* 跨源是结构性结论，优先于 BRANCH 里排在它前面的 moduleScript 空值。
     reason 明说 module 只是「因此未测出」，不冒充通过、也不让人去改 srcdoc。 */
  if (structuralCrossOrigin) {
    const rest = REQUIRED_CHECKS.filter((id) => id !== 'contentDocument' && by.get(id).ok === false);
    const rr = [
      'iframe 跨源：contentDocument 不可读，桥接层要改 js/host.js 里的 e.source 跨源语义',
      'moduleScript 因 DOM 不可读未测出（不是 module 被挡），改完同源后重跑本项，不冒充通过',
    ];
    if (rest.length) rr.push(`其余失败项（按优先级先只改上面这一处，改完重跑探针）：${rest.join(', ')}`);
    return { conclusion: 'contentDocument-failed', nextAction: 'bridge-fallback', canMarkBound: false, reasons: rr };
  }

  const failed = REQUIRED_CHECKS.filter((id) => by.get(id).ok === false);
  if (!failed.length) {
    return {
      conclusion: 'asset-protocol-works',
      nextAction: 'wire-installed-frame-src',
      canMarkBound: true,
      reasons: ['五项全通过：在 js/host.js 的 resolveFrameSrc() 里，把 manifest.installed === true 的 throw 分支换成真机选定的加载 URL（同源投影 / srcdoc / 后端代理）；同步销 scripts/market-binding-debt.json 的 load-url，再转 bound'],
    };
  }

  /* 优先级按「越靠前越底层」。tauri 是元前提，必须第一：不在 Tauri 里
     采集的其余四项都在错误环境里，不能据此去改产品代码。 */
  const BRANCH = [
    ['tauri', 'no-tauri-runtime', '当前不是 Tauri 运行时：其余四项在错误环境采集，结论无效；请用 scripts/probe-real-device-runtime.mjs 的 DEVTOOLS_SNIPPET 在 Tauri 窗口重跑，不要按其它分支改产品代码'],
    ['appDataHtml', 'backend-proxy-or-copy-to-dist', 'asset 协议取不到 $APPDATA 的 index.html：改后端代下，或在 js/installed-registry.js 的 installedEntry 投影里把产物拷进 dist 的 runtime-plugins/'],
    ['moduleScript', 'srcdoc-or-inline-bundle', '取到了文件但 ES module 跨源被挡：在 js/host.js 的 resolveFrameSrc() 里、manifest.installed === true 的 throw 分支处接 srcdoc / 内联 bundle —— srcdoc 目前只是注释里的方案名，生产实现 0 命中，照它去搜会一无所获'],
    ['contentDocument', 'bridge-fallback', 'iframe 跨源、contentDocument 恒 null：桥接层要改 js/host.js 里的 e.source 跨源语义'],
    ['csp302', 'fix-csp', '资产 302 没过 CSP：按实测 Location 补 src-tauri/tauri.conf.json 的 connect-src'],
  ];
  for (const [id, action, why] of BRANCH) {
    if (by.get(id).ok === false) {
      reasons.push(why);
      const rest = failed.filter((x) => x !== id);
      if (rest.length) reasons.push(`其余失败项（按优先级先只改上面这一处，改完重跑探针）：${rest.join(', ')}`);
      return { conclusion: `${id}-failed`, nextAction: action, canMarkBound: false, reasons };
    }
  }
  return { conclusion: 'inconclusive', nextAction: 'collect-more', canMarkBound: false, reasons };
}

/**
 * 采集器。env 由调用方注入：真机是 devtools glue，Node 测试是 mock。
 * 缺环境时返回结构化 cannot-run，**不抛异常、不恒真**。
 */
export async function runDeviceProbe(env = {}) {
  const e = env || {};
  const checks = [];
  const push = (id, ok, evidence) => checks.push({ id, ok: ok === true ? true : ok === false ? false : null, evidence: String(evidence || '').slice(0, 300) });
  const has = (x) => typeof x === 'function' || (x && typeof x === 'object');
  if (!has(e.tauri) || typeof e.convertFileSrc !== 'function') {
    return { canRun: false, reason: 'no-tauri-runtime', checks: [] };
  }
  push('tauri', true, 'invoke + convertFileSrc 可用');

  /* appDataHtml：把 appDataDir 下已安装插件的 index.html 转成 asset URL 再取。 */
  const probeId = e.probeId || 'demo-iframe';
  const htmlPath = typeof e.joinPath === 'function'
    ? e.joinPath(e.appDataDir || '', 'installed-plugins', probeId, 'index.html')
    : `${e.appDataDir || ''}/installed-plugins/${probeId}/index.html`;
  let assetUrl = null;
  try { assetUrl = e.convertFileSrc(htmlPath); } catch (err) { push('appDataHtml', false, `convertFileSrc 失败：${err.message}`); }
  if (assetUrl && typeof e.fetch === 'function') {
    try {
      const r = await e.fetch(assetUrl);
      const body = r && typeof r.text === 'function' ? await r.text() : '';
      push('appDataHtml', !!(r && r.status === 200 && /<html/i.test(body)), `status=${r && r.status} html=${/<html/i.test(body)}`);
    } catch (err) { push('appDataHtml', false, `fetch 失败：${err.message}`); }
  } else if (!byId(checks, 'appDataHtml')) {
    push('appDataHtml', null, '没有可注入的 fetch，真机需在 devtools 里跑');
  }

  /* moduleScript / contentDocument：必须有真 DOM，Node 里一律 null，不冒充通过。
     真机侧由 devtools 片段采集 nexus-bridge-v1/ready 信号（见片段内注释）。 */
  if (typeof e.probeIframe === 'function') {
    const r = await e.probeIframe(assetUrl);
    push('moduleScript', r?.moduleScript === true ? true : r?.moduleScript === false ? false : null, r?.note || '');
    push('contentDocument', r?.contentDocument === true ? true : r?.contentDocument === false ? false : null, r?.note || '');
  } else {
    push('moduleScript', null, '需真机 DOM：devtools snippet 采集');
    push('contentDocument', null, '需真机 DOM：devtools snippet 采集');
  }

  /* csp302：带 PAT 走 api.github.com 的 asset.url，看 302 后的字节流。 */
  if (typeof e.fetch === 'function' && typeof e.assetApiUrl === 'string' && e.assetApiUrl) {
    try {
      const r = await e.fetch(e.assetApiUrl, { headers: e.headers || {} });
      let bytes = null;
      if (r && typeof r.arrayBuffer === 'function') bytes = new Uint8Array(await r.arrayBuffer());
      const gzip = !!(bytes && bytes[0] === 0x1f && bytes[1] === 0x8b);
      push('csp302', !!(r && r.status === 200 && gzip), `status=${r && r.status} gzip=${gzip}`);
    } catch (err) { push('csp302', false, `302 下载失败：${err.message}`); }
  } else {
    push('csp302', null, '需真机 PAT 与 asset.url：devtools snippet 采集');
  }

  return { canRun: true, checks, evaluated: evaluate(checks) };
}

function byId(checks, id) { return checks.some((c) => c.id === id); }

/**
 * 复制到 Tauri 窗口 devtools 的采集片段。
 * 只采集、只打印，**不含任何判定字样**。把输出贴回来再交给 evaluate() ——
 * 判据保持唯一一份。
 */
export const DEVTOOLS_SNIPPET = `(async () => {
  const T = window.__TAURI__;
  const out = [];
  /* 三态归一化，与 Node 侧采集一致：非 true/false 一律 null，不会当成通过。 */
  const push = (id, ok, evidence) => out.push({ id, ok: ok === true ? true : ok === false ? false : null, evidence: String(evidence).slice(0, 300) });
  const cfs = T?.core?.convertFileSrc || T?.path?.convertFileSrc;
  push('tauri', !!(T?.core?.invoke || T?.invoke) && typeof cfs === 'function', 'invoke + convertFileSrc');
  const appData = await (T?.path?.appDataDir?.() || Promise.resolve(''));
  const html = appData.replace(/[\\\\/]$/, '') + '/installed-plugins/demo-iframe/index.html';
  let url = null;
  try { url = cfs(html); } catch (e) { push('appDataHtml', false, 'convertFileSrc: ' + e.message); }
  if (url) {
    try { const r = await fetch(url); const b = await r.text(); push('appDataHtml', r.status === 200 && /<html/i.test(b), 'status=' + r.status); }
    catch (e) { push('appDataHtml', false, 'fetch: ' + e.message); }
    /* moduleScript 锚产物自带的桥接信号：内联 module 一执行，桥接框架
       立即向 parent 发 {channel:'nexus-bridge-v1', type:'ready'}。
       12/12 产物实测含该信号（project-group 在外链 bundle 里）。
       旧判据查一个臆想的 dataset 执行标记，12/12 产物 0 命中，
       会让这一项恒 false、真机白跑一次。 */
    let readySeen = false;
    const onMsg = ev => { const d = ev && ev.data; if (d && d.channel === 'nexus-bridge-v1' && d.type === 'ready') readySeen = true; };
    window.addEventListener('message', onMsg);
    const f = document.createElement('iframe');
    f.src = url; f.style.display = 'none'; document.body.appendChild(f);
    await new Promise(res => { f.onload = () => setTimeout(res, 400); setTimeout(res, 4000); });
    let cd = null; try { cd = f.contentDocument; } catch (_) {}
    push('contentDocument', !!cd, cd ? 'same-origin' : 'cross-origin / null');
    push('moduleScript', cd ? (!!cd.querySelector('script[type=module]') && readySeen) : null,
      cd ? 'module 标签 + nexus-bridge-v1/ready 消息' : 'iframe 跨源：DOM 不可读，module 执行未测出（不是 module 被挡）');
    window.removeEventListener('message', onMsg);
    f.remove();
  } else if (!out.some(x => x.id === 'appDataHtml')) push('appDataHtml', null, 'no asset url');
  /* csp302 必须由 webview 自己的 fetch 测（Node 侧不受 CSP 约束，测不出拦截）。
     PAT 与 asset.url 只在本次 devtools 会话内经 prompt 输入，不落盘、不进文件。 */
  const aurl = prompt('release asset 的 api url（留空则本项标 null）') || '';
  const pat = prompt('GitHub PAT（仅本次 devtools 会话，不保存）') || '';
  if (aurl && pat) {
    try {
      const r = await fetch(aurl, { headers: { Authorization: 'Bearer ' + pat, Accept: 'application/octet-stream' } });
      const b = new Uint8Array(await r.arrayBuffer());
      push('csp302', r.status === 200 && b[0] === 0x1f && b[1] === 0x8b, 'status=' + r.status);
    } catch (e) { push('csp302', false, 'CSP/网络拦截: ' + e.message); }
  } else push('csp302', null, '未提供 asset url / PAT；请在面板点一次「从仓库安装」后补齐本项');
  console.log('NEXUS_DEVICE_PROBE_CHECKS=' + JSON.stringify(out));
  return out;
})();`;
