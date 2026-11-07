/**
 * 已安装插件 → 宿主注册表 的唯一合并入口（第 54 轮）
 * ============================================================================
 *
 * 背景：第 50 轮接线后，install() 能把插件落到
 * `${appDataDir}/installed-plugins/<id>/`，ledger 能记、market.list() 能列，
 * 但外壳的 `loadRegistry()` 只读静态 registry.js + 自定义插件 ——
 * 装完的插件**不进 state.plugins**，于是侧边栏不出现、也打不开。
 *
 * plugin-manifest.js 的 mergeInstalled 与 installed-plugin-scan.js 的
 * pluginsWithInstalled 早就写好并在 market.list() 里用着，缺的只是让宿主
 * 也走同一份判据。
 *
 * ⚠️ 判据只有一份
 * ------------------------------------------------------------
 * 这里不重写「静态优先 / id 合法性 / entry 是否文件」任何一条。
 * 合并完全委托 pluginsWithInstalled，本模块只负责：
 *   · 取运行时依赖（Tauri / appDataDir / fs）
 *   · 降级契约
 *   · 把合并结果投影成外壳能识别的形态
 * 另写一份 merge 就会出现「商店面板列得出、侧边栏看不见」的分叉，
 * 且不报错 —— 这正是本轮要修的形状。
 *
 * 降级契约（三条，任何一条失守都会让面板整个打不开）
 * ------------------------------------------------------------
 *   ① 不在 Tauri / 取不到 appDataDir → 原样返回静态清单，不抛错
 *   ② 目录不存在（尚未装过任何插件）→ 干净正常态，不产生 errors
 *   ③ 扫描抛错 → 记进 report.errors，plugins 仍是静态清单
 * 「扫描失败」绝不许把静态清单弄丢：否则一次后端异常 = 面板空白。
 *
 * 加载 URL（第 63 轮：分支已落，真机只验 asset URL 可达性）
 * ------------------------------------------------------------
 * 装进来的插件在 appDataDir，**不在 dist/ 内**，同源相对路径取不到。
 * 第 61 轮真实浏览器四象限 + 第 62 轮构建链实证把「asset 协议下 ES
 * module 的 CORS 行为只有真机能判」拆开了：release tarball 就是
 * runtime-plugins/<id>/ 那份产物，12 份里 11 份是零外部相对资源的
 * 单文件内联 bundle。所以 resolveFrameSrc() 现在走 js/installed-frame.js
 * 的形态分流（复用构建期同一份 checkSingleFile），单文件形态给 asset
 * URL，其余形态明确 fail-closed 走错误框。
 *
 * 本模块仍只负责「进注册表、出现在侧边栏」，不参与 URL 拼装。
 * ⚠️ convertFileSrc 对 $APPDATA 路径生成的编码 URL 能否被 Tauri asset
 * 协议服务，沙盒验不了；台账 status 保持 wired / runtimeVerified=false，
 * 真机 checks 回来才转 bound。别在这里偷偷下结论。
 */

import { pluginsWithInstalled } from './installed-plugin-scan.js';
import { createFs, resolveDataDir } from './plugin-fs-bridge.js';
import { joinSegments } from './plugin-data-store.js';
import { INSTALLED_PLUGINS_DIR } from './plugin-manifest.js';
import { getTauri } from './tauri-core.js';

/** 已安装插件的加载状态标记；resolveFrameSrc 靠它 fail-closed。 */
export const LOAD_STATE = 'awaiting-real-device-verification';

const EMPTY_REPORT = { found: 0, skipped: [], errors: [], degraded: null };

/**
 * 把合并结果投影成外壳可用的清单（纯函数，便于守卫真跑）。
 *
 * 不改 mergeInstalled 的任何字段语义，只补两项：
 *   · loadState      —— 让 resolveFrameSrc 走形态分流，而不是退回 resolveEntry
 *   · installedEntry —— 保留包内相对入口，供真机方案选分支时使用
 * 静态插件一个字段都不动：给它们打标记会让 12 个 runtime 插件一起被拦。
 */
export function projectInstalled(plugins) {
  return (Array.isArray(plugins) ? plugins : []).map((p) => (
    p && p.installed === true
      ? { ...p, loadState: LOAD_STATE, installedEntry: p.entry }
      : p
  ));
}

/**
 * 扫描 installed-plugins/ 并合并进静态清单。
 *
 * @param {object[]} staticPlugins  registry.js + 自定义插件之后的全量静态清单
 * @param {object} [p] 仅供测试注入
 * @param {object} [p.tauri]         覆盖 getTauri() 的结果
 * @param {string|null} [p.dataRoot] 覆盖 resolveDataDir() 的结果
 * @param {object} [p.fs]           覆盖 createFs(invoke) 的文件能力
 * @returns {Promise<{plugins: object[], report: {found:number, skipped:Array,
 *                    errors:Array, degraded:string|null}}>}
 */
export async function loadInstalledRegistry(staticPlugins, p = {}) {
  const o = p || {};
  const base = Array.isArray(staticPlugins) ? staticPlugins : [];

  let tauri = o.tauri;
  if (tauri === undefined) tauri = await getTauri();
  if (!tauri || typeof tauri.invoke !== 'function') {
    return { plugins: base, report: { ...EMPTY_REPORT, degraded: 'not-in-tauri' } };
  }

  let dataRoot = o.dataRoot;
  if (dataRoot === undefined) dataRoot = await resolveDataDir();
  if (!dataRoot || typeof dataRoot !== 'string') {
    return { plugins: base, report: { ...EMPTY_REPORT, degraded: 'no-data-dir' } };
  }

  const fs = o.fs || createFs((cmd, args) => tauri.invoke(cmd, args));
  const dir = joinSegments(dataRoot, INSTALLED_PLUGINS_DIR);

  /* 目录不存在不是错误，是「还没装过」的正常态。
   * 直接丢给扫描器会拿到一条 errors（见 scanInstalledPlugins:93），
   * 界面上就会把「干净」报成「扫描出错」。 */
  let exists = false;
  try {
    exists = await fs.exists(dir);
  } catch (e) {
    return {
      plugins: base,
      report: { ...EMPTY_REPORT, errors: [`检查已安装插件目录失败: ${String((e && e.message) || e)}`] },
    };
  }
  if (!exists) return { plugins: base, report: { ...EMPTY_REPORT } };

  try {
    const scan = await pluginsWithInstalled(base, dir, { fs });
    return {
      plugins: projectInstalled(scan.plugins),
      report: {
        found: scan.found,
        skipped: scan.skipped,
        errors: scan.errors,
        degraded: null,
      },
    };
  } catch (e) {
    return {
      plugins: base,
      report: { ...EMPTY_REPORT, errors: [`已安装插件扫描失败: ${String((e && e.message) || e)}`] },
    };
  }
}

/**
 * 把扫描报告折成一条界面提示（纯函数，守卫真跑）。
 *
 * 为什么需要它：报告此前只写进 console.warn，而 installedScanReport()
 * 虽导出却没有任何调用点 —— 「装了却没出现在侧边栏」在界面上一点线索
 * 都没有，用户只会重复安装或以为安装坏了。这与外链扫描失败那轮同形。
 *
 * 三种「不许当成干净」的形状，缺一个就把异常报成成功：
 *   · errors 非空 —— 目录读不了 / 扫描抛错，静态清单照常但装好的插件没了
 *   · skipped 非空 —— 坏清单 / 缺入口 / 与内置 id 冲突，插件不会进注册表
 *   · report 结构异常 —— 不是对象或字段不是数组，绝不能静默当空报告
 *
 * degraded 为 not-in-tauri / no-data-dir 是浏览器调试态与首次运行的正常
 * 降级，不弹提示；否则每次启动都报红，反而会把真提示淹掉。
 *
 * @returns {{tone: string, text: string}|null}
 */
export function formatInstalledScanAlert(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { tone: 'err', text: '已安装插件扫描报告不可读；侧边栏可能缺少刚装好的插件' };
  }
  const errors = Array.isArray(report.errors) ? report.errors : null;
  const skipped = Array.isArray(report.skipped) ? report.skipped : null;
  if (!errors || !skipped) {
    return { tone: 'err', text: '已安装插件扫描报告字段缺失；侧边栏可能缺少刚装好的插件' };
  }
  if (report.degraded === 'not-in-tauri' || report.degraded === 'no-data-dir') return null;
  if (errors.length) {
    return {
      tone: 'err',
      text: `已安装插件扫描没查成（${errors.length} 项：${String(errors[0]).slice(0, 120)}）；静态清单照常，但刚装好的插件可能不出现在侧边栏`,
    };
  }
  if (skipped.length) {
    const ids = skipped.slice(0, 3)
      .map((s) => (s && s.id) || '未知').join('、');
    return {
      tone: 'err',
      text: `已安装插件有 ${skipped.length} 项没生效（${ids}${skipped.length > 3 ? ' 等' : ''}）；这些插件不会出现在侧边栏`,
    };
  }
  return null;
}
