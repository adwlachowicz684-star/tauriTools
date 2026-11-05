/**
 * 已安装插件目录扫描（webview 侧 · 注入式异步 fs）
 * ============================================================
 * 与 js/plugin-manifest.js 的分工
 * ------------------------------------------------------------
 *   plugin-manifest.js  —— **纯函数**（校验 / 合并），浏览器与 Node 都能跑
 *   本文件               —— 碰文件系统，但**不自带文件系统**：由调用方注入
 *
 * 🔴 第 46 轮改造（销 market-runtime-debt 的 node:fs / node:path 账）
 * ------------------------------------------------------------
 * 原先本文件直接 `import node:fs` + `import node:path`，产品运行时只有
 * webview，那里没有 fs —— 编排层整条静态链因此进不了 bundle。这不是
 * 「接线没排期」，是运行时归属错了。
 * 现在：
 *   · fs 由调用方注入（`opts.fs`），生产里是 createFs(invoke)，
 *     测试里是 scripts/node-fs-adapter.mjs 的 createNodeFs()；
 *   · 路径拼接复用 plugin-data-store.js 的 joinSegments（同一份实现，
 *     不另写一套；它只做拼接，安全边界在后端 resolve_within）；
 *   · scanInstalledPlugins / pluginsWithInstalled 变 async ——
 *     **所有调用点必须 await**，漏一处就变成对 Promise 取 .plugins，
 *     表现为「一个插件都没出现」且不报错。
 *
 * ⛔ 缺 fs 时明确 throw，不返回空列表
 * ------------------------------------------------------------
 * 返回 found=0 + errors 一条看着温和，实际把「没接文件能力」伪装成
 * 「用户没装插件」——界面上一个插件都不出现，不崩不红，无从查起。
 * 所以这是 fail-closed，与 plugin-fs-bridge 的「失败一律 throw」同判据。
 *
 * 为什么目录做成**参数**而不是内部常量
 * ------------------------------------------------------------
 * 插件最终装到哪，取决于「阶段 0 · 加载路径」的结论：
 *   · 装到 appDataDir（配合 asset 协议）
 *   · 装到 dist 内（同源相对路径，但要确认生产环境可写）
 *   · 其它方案
 * 这个结论还没实测出来（见插件市场任务清单 阶段 0.1）。
 * 把目录写死在这里，等于用一个未验证的假设去绑死后面的实现 ——
 * 所以只接受调用方传入的路径，本文件不预设。
 *
 * 使用方式：
 *   await scanInstalledPlugins('/path/to/installed-plugins',
 *                              { fs, reservedIds: [...] })
 */

import { validateManifest, mergeInstalled, MANIFEST_FILE } from './plugin-manifest.js';
import { joinSegments } from './plugin-data-store.js';

/** fs 接口：exists / readdir / readText / isFile（都与 createFs 同形状）。 */
function requireFs(opts) {
  const fs = opts && opts.fs;
  if (!fs || typeof fs.exists !== 'function' || typeof fs.readdir !== 'function'
      || typeof fs.readText !== 'function' || typeof fs.isFile !== 'function') {
    throw new Error(
      'installed-plugin-scan: 未注入 fs（需 exists/readdir/readText/isFile）；'
      + '生产用 createFs(invoke)，Node 测试用 createNodeFs()',
    );
  }
  return fs;
}

/**
 * 扫描已安装插件目录。
 *
 * @param {string} dir  已安装插件根目录
 * @param {object} [opts]
 * @param {object} opts.fs  注入的文件能力（必填，见 requireFs）
 * @param {string[]} [opts.reservedIds]  内置插件 id（冲突即拒绝）
 * @returns {Promise<{
 *   found: number,            扫到的**子目录**数（不管有没有 manifest）
 *   manifests: object[],      校验通过的 manifest
 *   skipped: Array<{id:string, reason:string}>,  被跳过的（含原因）
 *   errors: string[],         目录级错误（不存在 / 读不了）
 * }>}
 *
 * ⚠️ 契约：**目录不存在不抛异常**，返回 found=0 + errors 一条。
 *   首次启动时目录根本还没建，抛异常会让外壳起不来。
 *   「没装任何插件」与「目录坏了」必须能区分 —— 前者是正常态。
 */
export async function scanInstalledPlugins(dir, opts = {}) {
  const manifests = [];
  const skipped = [];
  const errors = [];

  if (!dir || typeof dir !== 'string') {
    errors.push('未指定扫描目录');
    return { found: 0, manifests, skipped, errors };
  }

  /* fs 检查排在「目录无效」之后：上面那条契约不能因为没注入 fs 就变成抛错。
     排在这里之后，任何真正要走文件的路径都必定带着有效 fs。 */
  const fs = requireFs(opts);

  if (!await fs.exists(dir)) {
    errors.push(`目录不存在（尚未安装任何插件，属正常态）: ${dir}`);
    return { found: 0, manifests, skipped, errors };
  }

  let names;
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    errors.push(`读目录失败: ${String((e && e.message) || e)}`);
    return { found: 0, manifests, skipped, errors };
  }

  /*
   * readdir 只给名字，不区分文件/目录（后端 list 回执同样不区分）。
   * 逐项用 isFile 确认：true=散落文件（不计入 found），false=目录。
   *
   * 原实现是 readdirSync(dir,{withFileTypes:true}).filter(d => d.isDirectory())，
   * 那是同步 Dirent 专有能力，注入式 fs 没有。isFile() 是第 45 轮给
   * createFs 补的唯一 stat 判据，正是为这里的一比一替换铺路 ——
   * **不能因为改造就删掉「entry 是不是文件」那条主判据**。
   *
   * 单项判不了时不静默：记进 skipped，且不让一个坏条目拖垮整批。
   */
  const dirs = [];
  for (const rawName of Array.isArray(names) ? names : []) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.startsWith('.')) continue;  /* .git / .DS_Store / 临时目录 */
    try {
      if (await fs.isFile(joinSegments(dir, name))) continue;
      dirs.push(name);
    } catch (e) {
      skipped.push({
        id: name,
        reason: `目录类型判定失败（已跳过，不影响其它插件）: ${String((e && e.message) || e)}`,
      });
    }
  }

  for (const name of dirs) {
    /*
     * ⚠️ 单个插件的处理整段包在 try/catch 里 —— **一个坏插件不能拖垮整批扫描**。
     *
     * 这条是一次破坏验证挖出来的真实缺陷：原本下面 statSync(entryPath)
     * 紧跟在 existsSync 检查之后，把那条检查去掉（模拟判据失效）后，
     * statSync 直接抛 ENOENT，**整个 scanInstalledPlugins 崩掉**。
     *
     * 现实对应的场景是：某个插件目录被误删了一半 / 解压中断 / 权限异常
     *   → 启动时扫描整体失败 → **连其它正常插件一个都扫不出来**。
     * 界面表现是「插件一个都没有」，而真因只是其中一个坏了 —— 无从查起。
     *
     * 所以这里的原则：单个插件的任何异常都降级为「跳过并记原因」，
     * 绝不让异常往外冒。改成 async 后 await 仍在 try 内，边界不变。
     *
     * 与下面 entry 检查的分工（文案刻意不同，别合并）：
     *   那条是**主判据** —— 给出人能读懂的原因「entry 文件不存在」
     *   这里是**兜底** —— 只防崩溃，文案是「扫描异常」
     *   合并成一个文案的话，主判据失效时会被兜底掩盖，测试就看不出来了。
     */
    try {
      await scanOne(fs, dir, name, opts, manifests, skipped);
    } catch (e) {
      skipped.push({
        id: name,
        reason: `扫描异常（已跳过，不影响其它插件）: ${String((e && e.message) || e)}`,
      });
    }
  }

  return { found: dirs.length, manifests, skipped, errors };
}

/**
 * 处理单个插件目录（被 scanInstalledPlugins 循环调用，异常由调用方兜底）。
 *
 * @param {object} fs      注入的文件能力
 * @param {string} dir     已安装插件根目录
 * @param {string} name    插件目录名
 * @param {object} opts    { reservedIds }
 * @param {object[]} manifests  输出：校验通过的 manifest
 * @param {Array} skipped       输出：被跳过的项（含原因）
 */
async function scanOne(fs, dir, name, opts, manifests, skipped) {
  const full = joinSegments(dir, name);
  const mfPath = joinSegments(full, MANIFEST_FILE);

  if (!await fs.exists(mfPath)) {
    /* 目录里没有 manifest —— 不是插件（可能是残留、或解压失败的一半）。
     * 列进 skipped 而不是静默跳过：静默的后果是「装了但没出现」且无从查。 */
    skipped.push({ id: name, reason: `缺少 ${MANIFEST_FILE}` });
    return;
  }

  let raw;
  try {
    raw = JSON.parse(await fs.readText(mfPath));
  } catch (e) {
    /* JSON 坏了必须报出**具体目录名**。
     * 「装了但用不了」最卡的排查点就是不知道是哪个插件坏了。 */
    skipped.push({ id: name, reason: `${MANIFEST_FILE} 解析失败: ${String((e && e.message) || e)}` });
    return;
  }

  const r = validateManifest(raw, { dirName: name, reservedIds: opts.reservedIds });
  if (!r.ok) {
    skipped.push({ id: name, reason: r.errors.join('; ') });
    return;
  }

  /* entry 指向的文件必须真的存在 ——
   * manifest 说自己有 index.html，实际没有，装完打开就是白屏，
   * 而这种失败在界面上表现为「插件加载中…」一直转，极难定位。 */
  const entryPath = joinSegments(full, r.manifest.entry);
  if (!await fs.exists(entryPath)) {
    skipped.push({ id: name, reason: `entry 文件不存在: ${r.manifest.entry}` });
    return;
  }
  /* 主判据：entry 必须**是文件**而不是目录。
     第 45 轮 createFs.isFile() 的一比一替换就落在这里 —— 改造不许删。
     它是目录时跳过并说明，否则装完白屏且只转圈。 */
  if (!await fs.isFile(entryPath)) {
    skipped.push({ id: name, reason: `entry 不是文件: ${r.manifest.entry}` });
    return;
  }

  if (r.warnings.length) {
    /* 警告不阻断，但要能查得到 —— 记进 manifest 供界面展示 */
    r.manifest._warnings = r.warnings;
  }
  manifests.push(r.manifest);
}

/**
 * 扫描 + 合并的一步到位封装。
 *
 * @param {object[]} staticPlugins  静态注册表
 * @param {string} dir              已安装插件目录
 * @param {object} [opts]           必须含 opts.fs（透传给扫描器）
 * @returns {Promise<{plugins: object[], skipped: Array, errors: string[], found: number}>}
 */
export async function pluginsWithInstalled(staticPlugins, dir, opts = {}) {
  const scan = await scanInstalledPlugins(dir, opts);
  const merged = mergeInstalled(staticPlugins, scan.manifests);
  return {
    plugins: merged.plugins,
    /* 扫描阶段跳过的 + 合并阶段冲突的，都要带出来（都属「装了但没生效」） */
    skipped: [...scan.skipped, ...merged.skipped],
    errors: scan.errors,
    found: scan.found,
  };
}
