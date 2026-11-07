/**
 * 插件市场 · webview 侧装配层（第 50 轮接线）
 * ============================================================================
 *
 * 定位：把第 41–48 轮销空了运行时阻塞的编排层，第一次真正接进产品。
 * 运行位置只有 webview —— Tauri 的 invoke 只能调 Rust 命令，Rust 里跑不了
 * JS 编排层（清单第 41 节的定性，别再写「Node 侧 / IPC 桥」）。
 *
 * ⚠️ 本文件是「装配」，不是第二份编排
 * ------------------------------------------------------------
 * 生命周期判据一条都不在这里重写：install / uninstall / checkUpdates /
 * list / readData / writeData 全部转发给 createPluginMarket 的实例。
 * 这里出现第二份同类逻辑就是 bug（plugin-market.js 文件头同款红线）。
 *
 * 凭据：只存内存态，不落盘、不进日志、不内嵌
 * ------------------------------------------------------------
 * 12 个插件仓库全部 private，webview 直连 api.github.com 需要 Authorization。
 * 方案取台账 blockers[credentials].options[0]：用户在商店面板输入 PAT，
 * 只存闭包变量。token 不写进任何文件、不进 localStorage、不进 console。
 *
 * headerBox 为什么必须是同一个引用
 * ------------------------------------------------------------
 * createPluginMarket 在构造时把 p.headers 存成 ghOptsHeaders，之后每次
 * fetchRelease / downloadAsset / fetchRefSha 都把这个**引用**透给
 * plugin-store-client 的 ghHeaders()。所以运行时写入 headerBox 会立刻生效；
 * 若改成 `headers: { ...headerBox }`（拷贝）或每次构造新对象，用户后输的
 * PAT 永远用不上，症状是「输对了 token 还是 404 / 提示没发版」，不报错。
 * 这条引用契约由 market-binding-guard-test.mjs ⑥ 节钉住。
 *
 * 拿不到 Tauri / appDataDir 时返回结构化失败，不抛异常
 * ------------------------------------------------------------
 * 浏览器里调 UI 时没有 Tauri，抛错会让整个商店面板打不开（调试环境退化成
 * 不可用）。resolveDataDir() 的注释也是同一条判据。调用方按 `if (!r.ok)`
 * 显示提示即可。
 *
 * 🔴 接线 ≠ 能力完整可用（清单第 50 轮如实登记）
 * ------------------------------------------------------------
 * install() 把插件落到 `${appDataRoot}/installed-plugins/<id>/`（appDataRoot = appDataDir/project-group，见 plugin-fs-bridge.js），ledger 能
 * 记、list() 能列、checkUpdates 能查、卸载能删、用户数据能保留。
 * 但「装完的插件被外壳加载并出现在侧边栏」属于阶段 0 加载侧，至今仍待
 * 本机 Tauri 实测；CSP 对 release asset 302 到
 * objects.githubusercontent.com 的放行也待真机确认。这两条没验完之前，
 * 台账 status 只能是 wired，不能写 bound。
 */

import { createPluginMarket } from './plugin-market.js';
import { createFs, resolveDataDir } from './plugin-fs-bridge.js';
import { createPluginDataStore, joinSegments } from './plugin-data-store.js';
import { LEDGER_FILE } from './plugin-ledger.js';
import { INSTALLED_PLUGINS_DIR } from './plugin-manifest.js';
import { getTauri } from './tauri-core.js';

/**
 * 装配一个可在 webview 里用的市场实例。
 *
 * @param {object} [p]
 * @param {() => string|null} [p.getToken] 内存态 PAT getter（每次请求前调用）
 * @param {string[]} [p.reservedIds] 内置插件 id，防市场插件顶替内置
 * @param {object} [p.tauri] 仅供测试注入；生产不传，走 getTauri()
 * @param {() => Promise<string|null>} [p.resolveDataDir] 仅供测试注入
 * @returns {Promise<{ok:boolean, reason?:string, message?:string,
 *                    market?:object, setToken?:(t:string|null)=>void}>}
 */
/**
 * 是否为 release asset 下载请求 —— 唯一判据，装配层与守卫共用一份。
 * plugin-store-client.downloadAsset 用 ghHeaders({octet:true}) 发
 * `Accept: application/octet-stream`；其它 GitHub API 请求是
 * application/vnd.github+json，响应带 CORS 头，可以继续走 webview 直连。
 */
export function isAssetDownload(opts) {
  const h = (opts && opts.headers) || {};
  return String(h.Accept ?? h.accept ?? '').includes('application/octet-stream');
}

export async function createWebviewMarket(p = {}) {
  const o = p || {};
  /* sessionToken 是唯一的凭据存放处。它活在这个闭包里，不落盘、不进日志。 */
  let sessionToken = null;
  const getToken = typeof o.getToken === 'function' ? o.getToken : () => sessionToken;

  const tauri = o.tauri || await getTauri();
  if (!tauri || typeof tauri.invoke !== 'function') {
    return {
      ok: false,
      reason: 'not-in-tauri',
      message: '联网安装仅在客户端内可用（当前不是 Tauri 运行时）',
    };
  }

  const resolve = typeof o.resolveDataDir === 'function' ? o.resolveDataDir : resolveDataDir;
  const dataRoot = await resolve();
  if (!dataRoot || typeof dataRoot !== 'string') {
    return {
      ok: false,
      reason: 'no-data-dir',
      message: '取不到应用数据目录，无法安装插件',
    };
  }

  /* 生产默认：fs_op 走宿主原生 invoke（绕过 ctx.invoke 的插件级白名单）。
   * 后端 fs_op 的授权根默认包含 appDataDir（见 plugin-fs-bridge.js 文件头）。
   * p.fs / p.fetchFn 仅供隔离环境测试注入，生产一律不传，守卫 ⑥k/⑥l 钉住。 */
  const invoke = (cmd, args) => tauri.invoke(cmd, args);
  const fs = o.fs || createFs(invoke);
  const fetchFn = typeof o.fetchFn === 'function' ? o.fetchFn : null;
  const dataStore = createPluginDataStore({ fs, dataRoot, legacyStorage: null });

  /* 同一个对象引用交给编排层，运行时写入立即被后续请求读到。 */
  const headerBox = {};
  const applyToken = () => {
    const tok = getToken();
    if (tok && typeof tok === 'string' && tok.trim()) {
      headerBox.Authorization = `Bearer ${tok.trim()}`;
    } else {
      delete headerBox.Authorization;
    }
  };
  applyToken();

  const market = createPluginMarket({
    installedDir: joinSegments(dataRoot, INSTALLED_PLUGINS_DIR),
    ledgerFile: joinSegments(dataRoot, LEDGER_FILE),
    dataRoot,
    dataStore,
    fs,
    /* 每次请求前再刷一次：用户可能是在面板打开之后才输入 PAT 的。
     *
     * 🔴 只有 release asset 下载（Accept: octet-stream）走后端代下：
     * 私有仓 asset.url 会 302 到 release-assets.githubusercontent.com，
     * 那个 200 响应没有 CORS 头，webview fetch 必然 "Failed to fetch"。
     * 其它 GitHub API 响应都带 Access-Control-Allow-Origin，继续直连。
     * 测试注入 fetchFn 时整条链仍走 mock，不碰 Tauri invoke（守卫 ⑥k/⑥l）。 */
    fetch: (url, opts = {}) => {
      applyToken();
      if (!fetchFn && isAssetDownload(opts)) {
        return invoke('gh_asset_fetch', { url, token: getToken() || '' })
          .then((bytes) => ({
            status: 200,
            ok: true,
            arrayBuffer: async () => new Uint8Array(bytes).buffer,
          }));
      }
      return (fetchFn || fetch)(url, opts);
    },
    headers: headerBox,
    reservedIds: Array.isArray(o.reservedIds) ? o.reservedIds : [],
  });

  return {
    ok: true,
    market,
    /** 面板输入 PAT 后调这里；传 null / 空串即撤销凭据。 */
    setToken(t) {
      sessionToken = typeof t === 'string' && t.trim() ? t.trim() : null;
      applyToken();
    },
  };
}

/* ============================================================================
 * 面板结果汇总（第 51 轮）
 * ----------------------------------------------------------------------------
 * ⚠️ 这里只把编排层返回的字段翻成界面文案，不是第二份编排：四个纯函数
 *    都不调用市场实例的任何方法，也不重写「有没有更新 / 数据去留」判据
 *    —— 那两份判据分别在 plugin-ledger.js 与 plugin-data-policy.js 里。
 *
 * 为什么需要这一层：生产入口原来只数 hasUpdate 为真的条数，于是
 *   · 台账读不到 → 空 results 加 errors，界面报「均为最新」并带成功样式
 *   · 某个仓库查询失败 → checked 为假、hasUpdate 也为假，同样报「均为最新」
 *   · 同版本产物被重新上传 → fingerprintChanged 为真但 hasUpdate 为假，
 *     plugin-ledger.js 明写「必须让用户知道」，界面却一个字都不显示
 *   · 安装成功但产物没有 digest / 解包跳过了条目 → warnings 被整段吞掉
 *   · 卸载按来源策略真的清了用户数据，界面却写死「用户数据已保留」
 * 把「没查成」报成「查过且干净」是本项目第 203 轮已在别处修过的形状，
 * 这次是刚接线的联网商店面板重新引入了它。
 * ========================================================================== */

/** 常驻状态行：已装数量 + 装了没生效 / 扫描出错的条目，不许只报数量。 */
export function formatMarketList(r) {
  const o = r || {};
  const plugins = Array.isArray(o.plugins) ? o.plugins : [];
  const n = plugins.filter((x) => !x || !x.builtin).length;
  const skipped = Array.isArray(o.skipped) ? o.skipped : [];
  const errors = Array.isArray(o.errors) ? o.errors.filter(Boolean) : [];
  const notes = [];
  if (skipped.length) notes.push(`${skipped.length} 项装了但没生效`);
  if (errors.length) notes.push(`${errors.length} 项扫描出错：${String(errors[0])}`);
  return {
    tone: notes.length ? 'err' : 'ok',
    text: `联网安装已就绪 · 已安装 ${n} 个市场插件`
      + (notes.length ? ` · ${notes.join('；')}` : ''),
  };
}

/**
 * 查更新：失败与「没查成」必须与「已是最新」分开说，产物指纹变化单独说。
 *
 * 还有第三类漏网：**取到 release 却没比出结论**。编排层 checked=true 只表示
 * 「这次请求成功了」，resolveUpdateFor 遇到「release 里没有本插件的规范产物」
 * 或「版本号无法比较」时明写「不宣称有更新」，却不带 hasUpdate / errors /
 * checked:false 中的任何一个 —— 只数这三项的话，界面会报「所有已检查插件
 * 均为最新」并带成功色，而远端 v1.0.1、本地 v1.0.0 根本没比过。
 * 这类条目由编排层的 indeterminate 标出，这里单独成句且必须用 err 色调。
 */
export function formatCheckUpdates(r) {
  const o = r || {};
  const results = Array.isArray(o.results) ? o.results : [];
  const errors = Array.isArray(o.errors) ? o.errors.filter(Boolean) : [];
  const unchecked = results.filter((x) => x && x.checked === false);
  const indeterminate = results.filter((x) => x && x.indeterminate === true);
  const changed = results.filter((x) => x && x.fingerprintChanged === true);
  const hits = results.filter((x) => x && x.hasUpdate === true);
  const notes = [];
  if (errors.length) notes.push(`${errors.length} 项检查失败：${String(errors[0])}`);
  if (unchecked.length) notes.push(`${unchecked.length} 个插件没查成（不等于已是最新）`);
  if (indeterminate.length) notes.push(
    `${indeterminate.length} 个插件没法判定是否最新（${indeterminate.slice(0, 2).map((x) => x.reason || '原因未知').join('；')}）；不等于已是最新`);
  if (changed.length) notes.push(
    `${changed.length} 个插件同版本产物被重新上传，建议核对来源：${changed.map((x) => x.id).join('、')}`);
  if (hits.length) notes.push(`${hits.length} 个插件有更新：${hits.map((x) => x.id).join('、')}`);
  if (!notes.length) {
    return { tone: 'ok', text: results.length
      ? '所有已检查插件均为最新' : '当前没有可检查的市场插件' };
  }
  const broken = errors.length > 0 || unchecked.length > 0
    || indeterminate.length > 0 || changed.length > 0;
  return { tone: broken ? 'err' : 'ok', text: notes.join('；') };
}

/** 安装：版本缺失不拼 undefined，告警条目要出现，失败要带阶段。 */
export function formatInstall(r) {
  const o = r || {};
  if (!o.ok) {
    const stage = o.stage ? `（阶段：${o.stage}）` : '';
    return { tone: 'err', text: `安装失败：${o.error || o.stage || '未知原因'}${stage}` };
  }
  const ver = o.version ? ` v${o.version}` : '';
  const warns = Array.isArray(o.warnings) ? o.warnings.filter(Boolean) : [];
  return {
    tone: 'ok',
    text: `已安装「${o.id}」${ver}` + (warns.length ? ` · ${warns.length} 项告警：${String(warns[0])}` : ''),
  };
}

/** 卸载：成功文案必须跟着 purgeUserData 走，不能写死「已保留」。 */
export function formatUninstall(r) {
  const o = r || {};
  if (!o.ok) return { tone: 'err', text: `卸载失败：${o.error || o.stage || '未知原因'}` };
  if (o.purgeUserData === true) {
    return { tone: 'ok', text: `已卸载「${o.id}」（按来源策略清除了该插件的用户数据）` };
  }
  const kept = Array.isArray(o.kept) ? o.kept : [];
  return {
    tone: 'ok',
    text: `已卸载「${o.id}」（用户数据已保留${kept.length ? ` · ${kept.length} 项` : ''}）`,
  };
}
