/**
 * 已安装插件目录扫描（Node 侧）
 * ============================================================
 * 与 js/plugin-manifest.js 的分工
 * ------------------------------------------------------------
 *   plugin-manifest.js  —— **纯函数**（校验 / 合并），浏览器与 Node 都能跑
 *   本文件               —— 碰文件系统，只给 Node 侧用
 *                          （宿主运行时要扫目录得走后端 IPC 命令，
 *                            webview 里没有 fs）
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
 *   scanInstalledPlugins('/path/to/installed-plugins', { reservedIds: [...] })
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest, mergeInstalled, MANIFEST_FILE } from './plugin-manifest.js';

/**
 * 扫描已安装插件目录。
 *
 * @param {string} dir  已安装插件根目录
 * @param {object} [opts]
 * @param {string[]} [opts.reservedIds]  内置插件 id（冲突即拒绝）
 * @returns {{
 *   found: number,            扫到的**子目录**数（不管有没有 manifest）
 *   manifests: object[],      校验通过的 manifest
 *   skipped: Array<{id:string, reason:string}>,  被跳过的（含原因）
 *   errors: string[],         目录级错误（不存在 / 读不了）
 * }}
 *
 * ⚠️ 契约：**目录不存在不抛异常**，返回 found=0 + errors 一条。
 *   首次启动时目录根本还没建，抛异常会让外壳起不来。
 *   「没装任何插件」与「目录坏了」必须能区分 —— 前者是正常态。
 */
export function scanInstalledPlugins(dir, opts = {}) {
  const manifests = [];
  const skipped = [];
  const errors = [];

  if (!dir || typeof dir !== 'string') {
    errors.push('未指定扫描目录');
    return { found: 0, manifests, skipped, errors };
  }
  if (!existsSync(dir)) {
    errors.push(`目录不存在（尚未安装任何插件，属正常态）: ${dir}`);
    return { found: 0, manifests, skipped, errors };
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push(`读目录失败: ${String((e && e.message) || e)}`);
    return { found: 0, manifests, skipped, errors };
  }

  const dirs = entries.filter((d) => {
    if (!d.isDirectory()) return false;
    /* 点开头的目录一律跳过：.git / .DS_Store / 编辑器临时目录。
     * 不跳过的话，一个 .DS_Store 目录就会让每次启动多一条噪声。 */
    if (d.name.startsWith('.')) return false;
    return true;
  });

  for (const d of dirs) {
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
     * 绝不让异常往外冒。
     *
     * 与下面 entry 检查的分工（文案刻意不同，别合并）：
     *   那条是**主判据** —— 给出人能读懂的原因「entry 文件不存在」
     *   这里是**兜底** —— 只防崩溃，文案是「扫描异常」
     *   合并成一个文案的话，主判据失效时会被兜底掩盖，测试就看不出来了。
     */
    try {
      scanOne(dir, d.name, opts, manifests, skipped);
    } catch (e) {
      skipped.push({
        id: d.name,
        reason: `扫描异常（已跳过，不影响其它插件）: ${String((e && e.message) || e)}`,
      });
    }
  }

  return { found: dirs.length, manifests, skipped, errors };
}

/**
 * 处理单个插件目录（被 scanInstalledPlugins 循环调用，异常由调用方兜底）。
 *
 * @param {string} dir      已安装插件根目录
 * @param {string} name     插件目录名
 * @param {object} opts     { reservedIds }
 * @param {object[]} manifests  输出：校验通过的 manifest
 * @param {Array} skipped       输出：被跳过的项（含原因）
 */
function scanOne(dir, name, opts, manifests, skipped) {
  const full = join(dir, name);
  const mfPath = join(full, MANIFEST_FILE);

  if (!existsSync(mfPath)) {
    /* 目录里没有 manifest —— 不是插件（可能是残留、或解压失败的一半）。
     * 列进 skipped 而不是静默跳过：静默的后果是「装了但没出现」且无从查。 */
    skipped.push({ id: name, reason: `缺少 ${MANIFEST_FILE}` });
    return;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(mfPath, 'utf8'));
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
  const entryPath = join(full, r.manifest.entry);
  if (!existsSync(entryPath)) {
    skipped.push({ id: name, reason: `entry 文件不存在: ${r.manifest.entry}` });
    return;
  }
  if (!statSync(entryPath).isFile()) {
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
 * @param {object} [opts]
 * @returns {{plugins: object[], skipped: Array, errors: string[], found: number}}
 */
export function pluginsWithInstalled(staticPlugins, dir, opts = {}) {
  const scan = scanInstalledPlugins(dir, opts);
  const merged = mergeInstalled(staticPlugins, scan.manifests);
  return {
    plugins: merged.plugins,
    /* 扫描阶段跳过的 + 合并阶段冲突的，都要带出来（都属「装了但没生效」） */
    skipped: [...scan.skipped, ...merged.skipped],
    errors: scan.errors,
    found: scan.found,
  };
}
