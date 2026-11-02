/**
 * 插件市场客户端 —— 从 GitHub Release 取插件
 * ============================================================
 * 只做三件事：把用户输入的地址解析成仓库、找到该下的产物、判断有没有新版。
 *
 * ⚠️ 设计前提（别搞错方向）
 * ------------------------------------------------------------
 * 我们**不下载源码在用户机器上构建**（那是方案 1，已否决）：
 * 插件仓库里有源码，但**发布的是 GitHub Release 里的构建产物**。
 * 宿主只下载现成的 .tar.gz 解压即用 ——
 *   · 用户不需要装 node（桌面应用的使用者不是开发者）
 *   · 不在用户机器上跑陌生仓库的 `npm install`（postinstall 是真实攻击面）
 *   · 安装从「几分钟且可能失败」变成「秒装必成功」
 *
 * ⚠️ 本模块不含任何网络实现细节之外的业务逻辑：
 * 下载到的东西**一律交给 js/plugin-installer.js 校验落盘**，
 * 这里不替它做信任判断。
 *
 * 网络可注入（opts.fetch）是刻意的：
 * 单元测试不能依赖 GitHub 活着，也不该真的发出请求。
 *
 * ⚠️ 本模块属**宿主 Node 侧逻辑层**（与 plugin-installer 同侧，后者要 fs）。
 *    webview 里跑不了 node:crypto；接线走后端 IPC 时不要把它塞进前端 bundle。
 */

import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 产物命名：`<id>-<version>.tar.gz`，前缀固定便于在 release 里认出来 */
export const ASSET_PREFIX = 'nexus-plugin-';
/** 只接受这种产物后缀 —— 别的格式一律不认（不猜格式，避免把源码包当产物） */
export const ASSET_SUFFIX = '.tar.gz';

export const API_BASE = 'https://api.github.com';

/* ------------------------------------------------------------------ *
 * 1. 地址解析
 * ------------------------------------------------------------------ */

/**
 * 把用户输入解析成 {owner, repo, ref}。
 *
 * 接受（都是用户可能顺手粘进来的形态）：
 *   owner/repo
 *   owner/repo#v1.2.0          （钉到 tag）
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   github.com/owner/repo/tree/main
 *
 * @returns {{owner:string, repo:string, ref:string|null}|null}
 *
 * 为什么 ref 默认 null 而不是 'main'：
 *   null = 取 latest release；不追分支。追 main 意味着
 *   「上游 push 一下，用户本地跑的代码静默变了」，
 *   这正是要固定版本指纹防的那类事。
 */
export function parseRepoInput(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  /* 去掉 ref 部分再单独解析 */
  let ref = null;
  const hash = s.indexOf('#');
  if (hash >= 0) { ref = s.slice(hash + 1).trim() || null; s = s.slice(0, hash); }
  s = s.trim().replace(/\/+$/, '');
  /* 去协议与主机 */
  s = s.replace(/^https?:\/\//i, '').replace(/^github\.com\//i, '');
  /* 去 .git */
  s = s.replace(/\.git$/i, '');
  /* 去掉 /tree/xxx /blob/xxx 之类的尾巴 —— 用户常从浏览器地址栏直接粘 */
  const segs = s.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0], repo = segs[1];
  /* 仓库名与 owner 的字符集限制（GitHub 规则，顺手挡掉奇怪输入） */
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo, ref };
}

/* ------------------------------------------------------------------ *
 * 2. 版本比较
 * ------------------------------------------------------------------ */

/**
 * semver 比较（只认 x.y.z，可带 -pre 后缀）。
 *
 * @returns {number|null} -1/0/1；**解析不出返回 null**
 *
 * 为什么返回 null 而不是硬比：
 *   判不了就不要宣称「有更新」。宁可漏报（用户手动看一眼），
 *   也不能拿字符串比较乱报 —— 报了「有新版」却装不上，
 *   比不报更糟。
 */
export function compareVersion(a, b) {
  const pa = splitVer(a), pb = splitVer(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  /* 主版本相同：有预发布的 < 正式版 */
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : (pa.pre > pb.pre ? 1 : 0);
  return 0;
}

function splitVer(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
}

/* ------------------------------------------------------------------ *
 * 3. 产物挑选
 * ------------------------------------------------------------------ */

/** 产物应有名字（构建侧与这里必须一致） */
export function assetNameFor(id, version) {
  return `${ASSET_PREFIX}${id}-${version}${ASSET_SUFFIX}`;
}

/**
 * 从 release 的 assets 里挑出要下载的那个。
 *
 * 优先级：
 *   1. 完全匹配 `<prefix><id>-<version>.tar.gz`
 *   2. `<prefix><id>-*.tar.gz`（版本对不上也认，版本以 manifest 为准）
 *   3. 只有一个 .tar.gz 产物时取它（构建侧命名不规范的兜底）
 *
 * @returns {object|null}
 *
 * 为什么第 2 档认「版本对不上」：
 *   release tag 与产物名里的版本可能不同步（人工发布时很常见），
 *   真正权威的版本号在包内的 manifest 里 —— 落盘时由 installer 校验。
 *   这里只负责「挑对文件」，不负责「相信它的版本号」。
 */
/**
 * 产物是否已上传完成。真实 GitHub asset 带 `state: "uploaded"`，
 * 上传中会是别的值；老 release / 测试夹具没有这个字段，按已上传处理。
 *
 * 单独导出而不是各写一份：install 里还有一处独立的 assets 过滤，
 * 两边各判一次迟早只改一边（本仓库反复栽的"同一语义只做对一处"）。
 */
export function isUploadedAsset(a) {
  return !a || a.state === undefined || a.state === null || a.state === 'uploaded';
}

export function pickAsset(assets, id, version) {
  if (!Array.isArray(assets) || !id) return null;
  const list = assets.filter((a) => a && typeof a.name === 'string' && isUploadedAsset(a));
  const exact = version
    ? list.find((a) => a.name === assetNameFor(id, version))
    : null;
  if (exact) return exact;
  const byId = list.filter(
    (a) => a.name.startsWith(`${ASSET_PREFIX}${id}-`) && a.name.endsWith(ASSET_SUFFIX),
  );
  if (byId.length) return byId[0];

  /* 兜底：**只有**在「一个命名规范的产物都没有」时才启用。
   *
   * 为什么要加这个前提（实跑撞出来的）：
   *   一个仓库可能托管多个插件，release 里躺着
   *   `nexus-plugin-other-1.2.0.tar.gz` 而我们要装的是 demo ——
   *   不加前提的「只有一个 tar.gz 就取它」会把**别的插件**装进来。
   *   那是装错包，而且装完 manifest.id 对不上才报错，排查成本很高。 */
  const prefixed = list.filter((a) => a.name.startsWith(ASSET_PREFIX));
  if (prefixed.length) return null;

  const tars = list.filter((a) => a.name.endsWith(ASSET_SUFFIX));
  if (tars.length === 1) return tars[0];
  return null;
}

/* ------------------------------------------------------------------ *
 * 4. 取 release
 * ------------------------------------------------------------------ */

/**
 * 取某个 ref（或 latest）的 release。
 *
 * @param {{owner:string, repo:string}} repo
 * @param {object} [opts]
 * @param {string} [opts.ref]  钉到某个 tag；不给则取 latest
 * @param {function} [opts.fetch] 可注入（默认 globalThis.fetch）
 * @returns {Promise<{ok:boolean, release:object|null, error:string|null}>}
 *
 * 失败一律返回 {ok:false, error} 而不抛：
 * 网络失败是**常态**（用户断网、GitHub 挂了、仓库私有），
 * 抛出去会让调用方整个安装流程崩掉，而它本该只是「装不上，告诉你原因」。
 */
export async function fetchRelease(repo, opts = {}) {
  const f = opts.fetch || globalThis.fetch;
  if (typeof f !== 'function') return { ok: false, release: null, error: '环境没有 fetch' };
  if (!repo || !repo.owner || !repo.repo) return { ok: false, release: null, error: '仓库地址不完整' };
  const base = `${API_BASE}/repos/${repo.owner}/${repo.repo}/releases`;
  const url = opts.ref ? `${base}/tags/${encodeURIComponent(opts.ref)}` : `${base}/latest`;
  try {
    const res = await f(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res || res.status === 404) return { ok: false, release: null, error: `找不到 release: ${opts.ref || 'latest'}` };
    if (res.status >= 400) return { ok: false, release: null, error: `GitHub 返回 ${res.status}` };
    const j = await res.json();
    return { ok: true, release: j, error: null };
  } catch (err) {
    return { ok: false, release: null, error: String(err && err.message) };
  }
}

/**
 * 判断有没有更新。
 *
 * @param {string|null} installedVersion 已装版本（没装传 null）
 * @param {object} latest fetchRelease 的 release
 * @param {string} id
 * @returns {{hasUpdate:boolean, from:string|null, to:string|null, asset:object|null, reason:string}}
 *
 * 版本号判不了（返回 null）时 **hasUpdate 一律 false** ——
 * 「不确定」不能当「有更新」推给用户。
 */
export function resolveUpdate(installedVersion, latest, id) {
  if (!latest) return { hasUpdate: false, from: installedVersion || null, to: null, asset: null, reason: '没有 release 信息' };
  const to = String(latest.tag_name || latest.name || '').replace(/^v/i, '');
  const asset = pickAsset(latest.assets, id, to);
  if (!asset) return { hasUpdate: false, from: installedVersion || null, to, asset: null, reason: 'release 里没有可用产物' };
  if (!installedVersion) return { hasUpdate: true, from: null, to, asset, reason: '未安装' };
  const c = compareVersion(installedVersion, to);
  if (c === null) return { hasUpdate: false, from: installedVersion, to, asset, reason: '版本号无法比较，不宣称有更新' };
  return { hasUpdate: c < 0, from: installedVersion, to, asset, reason: c < 0 ? '版本更新' : '已是最新' };
}

/* ------------------------------------------------------------------ *
 * 5. 下载
 * ------------------------------------------------------------------ */

/**
 * 下载产物。
 *
 * @param {object} asset pickAsset 的结果（用 browser_download_url）
 * @param {object} [opts] { fetch }
 * @returns {Promise<{ok:boolean, buffer:Buffer|null, error:string|null, bytes:number}>}
 *
 * 只走 asset.browser_download_url：那是 GitHub 给的、指向产物本身的地址。
 * 不接受调用方另传 url —— 否则「下载 A 却装 B」这类错配无从防起。
 */
export async function downloadAsset(asset, opts = {}) {
  const f = opts.fetch || globalThis.fetch;
  if (!asset || typeof asset.browser_download_url !== 'string') {
    return { ok: false, buffer: null, error: '产物没有下载链接', bytes: 0 };
  }
  if (typeof f !== 'function') return { ok: false, buffer: null, error: '环境没有 fetch', bytes: 0 };
  try {
    const res = await f(asset.browser_download_url);
    if (!res || res.status >= 400) return { ok: false, buffer: null, error: `下载失败 ${res && res.status}`, bytes: 0 };
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    return { ok: true, buffer: buf, error: null, bytes: buf.length };
  } catch (err) {
    return { ok: false, buffer: null, error: String(err && err.message), bytes: 0 };
  }
}

/* ------------------------------------------------------------------ *
 * 5. 产物完整性（真实 GitHub API 联调后补的）
 * ------------------------------------------------------------------ */

/**
 * 用 release asset 自带的 digest 校验下载到的字节流。
 *
 * 为什么需要它（2026-11-03 真实联调查出来的）：
 *   真实 GitHub release 的 asset 带 `digest: "sha256:<64hex>"` 和
 *   `state: "uploaded"`。此前链路只记 `id+size+updated_at` 做指纹，
 *   能发现「同版本产物被换过」，但**发现不了下载途中字节流损坏**——
 *   gzip 魔数可能还在，解包器却会报「坏包」，用户看到的是一句
 *   莫名其妙的解析错误，而不是「下载不完整，重试一次」。
 *
 * @returns {{ok:boolean, checked:boolean, reason:string}}
 *
 * 三条口径（别改反）：
 *   · digest 字段**完全没有** → checked:false, ok:true。老 release /
 *     第三方 mock 常常没有，不能因此让插件装不上。
 *   · 字段存在但格式不认识 → **拒绝放行**（checked:true, ok:false）。
 *     若当成「没有 digest」跳过，等于给「塞个假 digest 绕过校验」
 *     开了一道门。
 *   · checked 单独返回，是为了让上层和测试能看见「这次到底验没验」。
 *     只有一个 ok 的话，判据整条失效时依旧全绿 —— 本项目反复栽的形状。
 */
export function verifyAssetDigest(buf, asset) {
  const raw = asset && asset.digest;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, checked: false, reason: '产物没有 digest（老 release 常见），跳过完整性校验' };
  }
  if (typeof raw !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(raw)) {
    return { ok: false, checked: true,
      reason: `digest 格式不可识别，拒绝放行: ${String(raw).slice(0, 80)}` };
  }
  if (!Buffer.isBuffer(buf)) {
    return { ok: false, checked: true, reason: '下载内容不是 Buffer，无法校验 digest' };
  }
  const actual = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
  if (actual !== raw.toLowerCase()) {
    return { ok: false, checked: true,
      reason: `产物 sha256 不匹配（期望 ${raw.slice(7, 19)}… 实际 ${actual.slice(7, 19)}…），可能下载不完整或被替换` };
  }
  return { ok: true, checked: true, reason: 'digest 校验通过' };
}
