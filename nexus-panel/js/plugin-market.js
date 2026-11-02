/**
 * 插件市场 · 宿主侧编排层
 * ============================================================================
 *
 * 定位：把阶段 1–4 做的六个逻辑模块串成**一条能验收的生命周期链路**。
 * 运行位置是 Node 侧 / IPC 桥（这些模块都 import node:fs，webview 跑不了）。
 *
 * 为什么需要这一层（清单第 11 节反复点名的"逻辑层全是孤儿"）
 * ------------------------------------------------------------
 * installer / ledger / store-client / installed-plugin-scan / data-store /
 * data-policy 一共 300+ 项测试全绿，但生产代码没有任何一处调用它们。
 * 孤儿模块的风险不是"没用"，是**没人调用的模块会被后人当设计稿改坏**，
 * 且不报错。本层把调用关系固定下来，并用端到端测试钉住三条接线契约。
 *
 * ⛔ 纯编排，不重复任何判据
 * ------------------------------------------------------------
 *   manifest 合法性 → plugin-manifest.js
 *   落盘/越界/防顶替 → plugin-installer.js
 *   版本比较/产物挑选 → plugin-store-client.js
 *   台账/指纹/更新 → plugin-ledger.js
 *   发现与合并 → installed-plugin-scan.js
 *   数据去留 → plugin-data-policy.js
 * 本文件里出现第二份同类正则或比较逻辑，就是 bug。
 *
 * 三条接线契约（漏一条都是静默失效，端到端测试逐条钉住）
 * ------------------------------------------------------------
 *   ① 装成功必须**记台账**。漏了 → checkUpdates 看到空台账，
 *      表现为"装好了但永远查不到更新"，不报错、不崩、不红。
 *   ② 卸载必须**删台账条目**。漏了 → 更新检查会去查一个已卸载的插件。
 *   ③ 卸载默认**保留用户数据**，市场插件重装（id 固定）后要读得回来。
 *      去留结论只能来自 shouldPurgeDataOnUninstall，不能在这里另判。
 *
 * id 不猜
 * ------------------------------------------------------------
 * 输入只有 `owner/repo`，不知道插件 id。id 一律从**包内 manifest** 读；
 * release 产物名只用来做一致性校验（防"下载 A 装成 B"）。
 * 拿仓库名或产物名当 id 就是"把写法当意图"。
 */

import { join } from 'node:path';
import {
  parseRepoInput, fetchRelease, downloadAsset, pickAsset,
  assetNameFor, ASSET_PREFIX, ASSET_SUFFIX,
} from './plugin-store-client.js';
import { installPlugin, uninstallPlan, uninstallPlugin } from './plugin-installer.js';
import {
  readLedger, writeLedger, getEntry, recordInstall, recordUninstall,
  checkUpdates as ledgerCheckUpdates, fetchRefSha,
} from './plugin-ledger.js';
import { pluginsWithInstalled } from './installed-plugin-scan.js';
import {
  MANIFEST_FILE, isValidPluginId, INSTALLED_PLUGINS_DIR,
} from './plugin-manifest.js';
import { shouldPurgeDataOnUninstall, normalizeSource } from './plugin-data-policy.js';
import { DATA_DIR_NAME } from './plugin-data-store.js';
import { unpackTarGz } from './plugin-tarball.js';

/**
 * 从规范命名的产物名反推 id（`nexus-plugin-<id>-<ver>.tar.gz`）。
 *
 * 不另写正则：枚举 `-` 切点，用 assetNameFor 正向构造核对，
 * 并用 isValidPluginId 与"版本段以数字开头"排除不可能的切法。
 * 认不出返回 null —— 认不出就不能猜，调用方会明确报错。
 *
 * ⚠️ 从**最长 id 往回**枚举（第一次实跑撞出来的）：
 *   `nexus-plugin-plugin-2-1.2.3.tar.gz` 既能切成
 *     (id=plugin,  ver=2-1.2.3)   ← 从左往右会先命中这个
 *     (id=plugin-2, ver=1.2.3)    ← 但真实 id 是它
 *   id 允许以数字段结尾，而版本几乎总以数字开头，歧义客观存在。
 *   现实里版本是最后一段（x.y.z / x.y.z-pre），所以取最长合法 id；
 *   含点的候选会被 isValidPluginId 直接否掉，正好帮着跳过错误切法。
 */
export function inferAssetId(name) {
  if (typeof name !== 'string'
      || !name.startsWith(ASSET_PREFIX) || !name.endsWith(ASSET_SUFFIX)) return null;
  const body = name.slice(ASSET_PREFIX.length, name.length - ASSET_SUFFIX.length);
  const parts = body.split('-');
  for (let k = parts.length - 1; k >= 1; k--) {
    const id = parts.slice(0, k).join('-');
    const version = parts.slice(k).join('-');
    if (!isValidPluginId(id) || !/^\d/.test(version)) continue;
    if (assetNameFor(id, version) === name) return id;
  }
  return null;
}

/** 从条目集里读包内 manifest（顶层目录名任意，只认文件名） */
function readManifestFromEntries(entries) {
  const hits = entries.filter(
    (e) => e && !e.dir && typeof e.name === 'string'
      && e.name.split('/').pop() === MANIFEST_FILE && e.content != null,
  );
  if (hits.length !== 1) {
    return { ok: false, manifest: null,
      error: hits.length === 0 ? '包里没有 nexus.plugin.json' : '包里有多份 nexus.plugin.json，拒绝猜测用哪一份' };
  }
  try {
    return { ok: true, manifest: JSON.parse(hits[0].content.toString('utf8')), error: null };
  } catch {
    return { ok: false, manifest: null, error: '包内 nexus.plugin.json 不是合法 JSON' };
  }
}

/**
 * 创建市场实例。所有路径显式注入 —— 阶段 0 的"装到哪个目录"尚未实测，
 * 这里绝不预设一个写死的目录。
 *
 * @param {object} p
 * @param {string} p.installedDir   已安装插件根目录
 * @param {string} p.ledgerFile     台账文件路径
 * @param {string} p.dataRoot       appDataDir（用户数据根）
 * @param {object[]} [p.staticPlugins] 静态注册表
 * @param {function} [p.fetch]      可注入（测试/代理）
 * @param {object} [p.dataStore]    createPluginDataStore 的实例，读写 KV 用
 * @param {string[]} [p.reservedIds] 与内置插件冲突的 id
 */
export function createPluginMarket(p) {
  const o = p || {};
  const root = o.installedDir || INSTALLED_PLUGINS_DIR;
  const ledgerFile = o.ledgerFile;
  const dataRoot = o.dataRoot;
  const staticPlugins = Array.isArray(o.staticPlugins) ? o.staticPlugins : [];
  const fetchFn = o.fetch || globalThis.fetch;
  const reservedIds = o.reservedIds || [];
  /* 用户数据目录必须复用 DATA_DIR_NAME：另写一份 'plugin-data' 会让
     data-store 写 A、uninstall 删 B，表现为"卸载保留了数据"却永远读不回。 */
  const userDataRoot = dataRoot ? join(dataRoot, DATA_DIR_NAME) : null;

  if (!ledgerFile) throw new Error('plugin-market: 缺少 ledgerFile');

  const ledger = () => readLedger(ledgerFile).ledger;
  const saveLedger = (l) => {
    const r = writeLedger(ledgerFile, l);
    if (!r.ok) throw new Error(`台账写入失败: ${r.error}`);
  };

  return {
    paths: { installedDir: root, ledgerFile, dataRoot, userDataRoot },

    /** 静态注册表 + 已安装插件（扫描目录即发现，不需要改任何清单） */
    list() {
      return pluginsWithInstalled(staticPlugins, root);
    },

    /** 只报告不下载（D6）。台账没记录 = 查不到，正是契约①要防的失效。 */
    async checkUpdates() {
      return ledgerCheckUpdates(ledger(), { fetch: fetchFn });
    },

    /** 用户数据：委托注入的 store，不在这里另实现一套文件读写 */
    async readData(id, k, def = null) {
      if (!o.dataStore) throw new Error('plugin-market: 未注入 dataStore，无法读用户数据');
      return o.dataStore.get(id, k, def);
    },
    async writeData(id, k, value) {
      if (!o.dataStore) throw new Error('plugin-market: 未注入 dataStore，无法写用户数据');
      return o.dataStore.set(id, k, value);
    },

    /**
     * 输入 GitHub 地址 → 安装。任一阶段失败都返回 {ok:false, stage, error}，
     * 且**不产生半状态**：目录没落、台账没记、旧版本原样还在。
     */
    async install(input, opts = {}) {
      const parsed = parseRepoInput(input);
      if (!parsed) return { ok: false, stage: 'parse', error: '仓库地址无法解析' };
      const repo = { owner: parsed.owner, repo: parsed.repo };
      const ref = opts.ref || parsed.ref || null;

      const rel = await fetchRelease(repo, { fetch: fetchFn, ref });
      if (!rel.ok) return { ok: false, stage: 'release', error: rel.error };
      const version = String(rel.release.tag_name || rel.release.name || '').replace(/^v/i, '');
      const assets = (Array.isArray(rel.release.assets) ? rel.release.assets : [])
        .filter((a) => a && typeof a.name === 'string'
          && a.name.startsWith(ASSET_PREFIX) && a.name.endsWith(ASSET_SUFFIX));

      let asset = null;
      if (opts.id) {
        asset = pickAsset(assets, opts.id, version);
      } else {
        /* 不指定 id：只有恰好一个规范命名的产物才认，多个就要求调用方指明。
           一个仓库托管多个插件是常态，取第一个 = 装错包。 */
        const withId = assets.map((a) => ({ a, id: inferAssetId(a.name) })).filter((x) => x.id);
        const ids = new Set(withId.map((x) => x.id));
        if (ids.size === 1) asset = withId[0].a;
        else if (ids.size > 1) {
          return { ok: false, stage: 'asset',
            error: `该 release 含多个插件产物（${[...ids].join(', ')}），请指定 id` };
        }
      }
      if (!asset) return { ok: false, stage: 'asset', error: 'release 里没有可用的规范命名产物' };

      const dl = await downloadAsset(asset, { fetch: fetchFn });
      if (!dl.ok) return { ok: false, stage: 'download', error: dl.error };

      const unpacked = unpackTarGz(dl.buffer);
      if (!unpacked.ok) return { ok: false, stage: 'unpack', error: unpacked.error };

      const mf = readManifestFromEntries(unpacked.entries);
      if (!mf.ok) return { ok: false, stage: 'manifest', error: mf.error };
      const id = mf.manifest && mf.manifest.id;
      if (!isValidPluginId(id)) return { ok: false, stage: 'manifest', error: `包内 manifest.id 不合法: ${String(id)}` };

      /* 防顶替：产物名声明的 id 必须与包内 manifest 一致。
         不校验就会出现"下载 nexus-plugin-demo.tar.gz 装进来的是 evil"。 */
      if (!asset.name.startsWith(`${ASSET_PREFIX}${id}-`)) {
        return { ok: false, stage: 'identity',
          error: `产物名(${asset.name}) 与包内 manifest.id(${id}) 不一致，拒绝安装` };
      }
      if (opts.id && opts.id !== id) {
        return { ok: false, stage: 'identity', error: `指定的 id(${opts.id}) 与包内 manifest.id(${id}) 不一致` };
      }

      const r = installPlugin({ root, id, entries: unpacked.entries, reservedIds });
      if (!r.ok) return { ok: false, stage: 'install', error: r.errors.join('; '),
        warnings: r.warnings };

      /* 契约①：装成功就记台账。sha 取不到不阻断安装（只告警）——
         指纹比对依赖它，但缺 sha 不能让一个装好的插件变成"没装"。 */
      const warnings = [...r.warnings, ...unpacked.warnings];
      for (const s of unpacked.skipped) warnings.push(`解包跳过条目 ${s.name}: ${s.reason}`);
      let sha = null;
      if (ref || version) {
        const s = await fetchRefSha(repo, ref || `v${version}`, { fetch: fetchFn });
        if (s.ok) sha = s.sha;
        else warnings.push(`commit sha 未取到（${s.error}），更新指纹比对会退化`);
      }
      const rec = recordInstall(ledger(), {
        id, version: mf.manifest.version, repo, ref, sha, asset,
      });
      if (rec.errors.length) {
        return { ok: false, stage: 'ledger', error: `安装已落盘但台账记录失败: ${rec.errors.join('; ')}`, id };
      }
      saveLedger(rec.ledger);
      warnings.push(...rec.warnings);
      return { ok: true, id, version: mf.manifest.version, replaced: r.replaced,
        dir: r.dir, sha, warnings, errors: [] };
    },

    /**
     * 卸载。默认保留用户数据（D3）；显式 removeUserData 才删。
     * 去留结论只来自 policy，且 source 取台账里的记录，不靠 id 前缀猜。
     */
    async uninstall(id, opts = {}) {
      const plan = uninstallPlan({ root, id, userDataRoot });
      if (!plan.ok) return { ok: false, id, error: plan.reason, removed: [], kept: [] };
      if (!plan.exists) return { ok: false, id, error: '插件未安装', removed: [], kept: [] };

      const entry = getEntry(ledger(), id);
      const source = normalizeSource(entry && entry.source);
      const purge = shouldPurgeDataOnUninstall({
        id, source, removeUserData: opts.removeUserData === true,
      });

      const r = uninstallPlugin({ root, id, userDataRoot, removeUserData: purge });
      if (!r.ok) return { ok: false, id, error: r.errors.join('; '), removed: r.removed, kept: r.kept };

      const rec = recordUninstall(ledger(), id);   // 契约②
      saveLedger(rec.ledger);
      return { ok: true, id, source, purgeUserData: purge,
        removed: r.removed, kept: r.kept,
        plan: { fileCount: plan.fileCount, bytes: plan.bytes },
        errors: [] };
    },
  };
}
