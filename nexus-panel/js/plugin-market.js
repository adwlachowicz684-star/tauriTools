/**
 * 插件市场 · 宿主侧编排层
 * ============================================================================
 *
 * 定位：把阶段 1–4 做的六个逻辑模块串成**一条能验收的生命周期链路**。
 * 运行位置目标：webview（产品运行时只有它，不存在「Node 侧 / IPC 桥」）。
 *
 * ⚠️ 运行时归属实测更正（清单第 41 节）：Tauri 的 invoke 只能调 Rust 命令，
 *    Rust 里跑不了 JS 编排层。所以"等接线方案定了把它接进产品"从一开始
 *    就不成立：**不是缺一个 IPC 命令**，是逻辑层带着 Node 专有依赖。
 *
 * ✅ 第 43 轮进度：**本文件与 plugin-tarball.js 已销账**。
 *    · 本文件的 node:path 换成 data-store 的 joinSegments（同一份实现）；
 *    · tarball 的 node:zlib 换 DecompressionStream、Buffer 全局换 Uint8Array，
 *      并切断「为一个纯函数 import 整个 installer」的静态链；
 *      代价是 unpackTarGz 变 async，本文件已随之 await。
 *
 * 🔴 同轮查出台账原先漏掉的两类盲区（见 market-runtime-debt.json 的 blindSpots）：
 *    · **Buffer 全局**：不写 import node: 也照样跑不进 webview；
 *    · **静态 import 链**：自己零 node: 的模块会被被依赖方的 node: 拖死。
 *    只扫 import 行的守卫看不见这两类，已一并升级。
 *
 * ✅ 第 44 轮：store-client 已销账（node:crypto → WebCrypto、Buffer → Uint8Array，
 *    verifyAssetDigest 变 async，本文件与联网探针已随之 await）。
 *
 * ⛔ 剩余 installer / ledger / installed-plugin-scan 三个模块
 *    仍带同步 node:fs，逐文件 unblock 记在
 *    scripts/market-runtime-debt.json；判定见 scripts/scan-market-runtime.mjs
 *    与 market-runtime-gap-test.mjs / webview-runtime-test.mjs。
 *    在那之前"300+ 项测试全绿但产品里没有装插件能力"仍是结构性的，
 *    不是待办排期问题。
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

import {
  parseRepoInput, fetchRelease, downloadAsset, pickAsset,
  assetNameFor, ASSET_PREFIX, ASSET_SUFFIX,
  verifyAssetDigest, isUploadedAsset,
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
import { DATA_DIR_NAME, joinSegments } from './plugin-data-store.js';
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
    /* entry.content 现在可能是 Uint8Array（webview 解包器不给 Buffer），
       也可能是字符串（测试里手工构造的 entries）。
       ⛔ 不能用 content.toString('utf8')：那是 Buffer 专有语义，
          Uint8Array 调它会得到 "123,34,..."，JSON.parse 必然失败，
          界面只报「包内 nexus.plugin.json 不是合法 JSON」——
          指向一个根本不存在的问题。 */
    const c = hits[0].content;
    const text = typeof c === 'string' ? c : new TextDecoder('utf-8').decode(c);
    return { ok: true, manifest: JSON.parse(text), error: null };
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
 * @param {object} [p.headers]      附加 GitHub 请求头（私有仓的 Authorization）。
 *                                  后端持有 token 后整条链路透传：
 *                                  release 查询 / 产物下载 / 查更新 / commit sha 一个都不能漏，
 *                                  漏哪一处就表现为「装上了但永远查不到更新」。
 *                                  本层不读环境变量、不落盘、不回显凭据。
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
  const ghOptsHeaders = o.headers && typeof o.headers === 'object' ? o.headers : null;
  const reservedIds = o.reservedIds || [];
  /* 用户数据目录必须复用 DATA_DIR_NAME：另写一份 'plugin-data' 会让
     data-store 写 A、uninstall 删 B，表现为"卸载保留了数据"却永远读不回。 */
  const userDataRoot = dataRoot ? joinSegments(dataRoot, DATA_DIR_NAME) : null;

  if (!ledgerFile) throw new Error('plugin-market: 缺少 ledgerFile');

  /*
   * ⛔ 不能只取 `.ledger`：readLedger 解析失败时会把损坏文件改名备份、
   * 返回**空台账** + corrupted:true。丢掉这个标记，下一步 recordInstall 就会
   * 拿"空台账"当"磁盘上没有记录"合并写回 —— 装一个新插件，其余插件的
   * 更新记录全没了，全程不报错（原文件只在 .corrupt-* 备份里，用户不知道）。
   *
   * 逐条跳过坏条目同理：内存里的台账已经比磁盘上少了几条，此时写回
   * 就是把那几条真的删掉。所以只要 readLedger 报了任何异常，一律
   * **不写回**，明确让人去核对。这与快照/清单那条"读不全就不写"同判据。
   */
  const readLedgerState = () => readLedger(ledgerFile);
  const ledgerFault = (st) => (st.corrupted || st.errors.length
    ? `台账不可安全写入（${st.errors.join('; ') || '文件已损坏'}）`
      + `${st.backup ? `，原文件已备份到 ${st.backup}` : ''}`
      + '；为避免覆盖其它插件的记录，本次操作已中止，请人工核对后再试'
    : null);
  /* 不再 throw：任何阶段的失败都要按文件头契约返回 {ok:false, stage, error}，
     否则调用方按 `if (!r.ok)` 写就会撞上一个穿透的异常，界面上只剩"点了没反应"。 */
  const saveLedger = (l) => writeLedger(ledgerFile, l);

  return {
    paths: { installedDir: root, ledgerFile, dataRoot, userDataRoot },

    /** 静态注册表 + 已安装插件（扫描目录即发现，不需要改任何清单） */
    list() {
      return pluginsWithInstalled(staticPlugins, root);
    },

    /** 只报告不下载（D6）。台账没记录 = 查不到，正是契约①要防的失效。 */
    async checkUpdates() {
      const st = readLedgerState();
      const out = await ledgerCheckUpdates(st.ledger, { fetch: fetchFn, headers: ghOptsHeaders });
      const why = ledgerFault(st);
      return { ...out, errors: [...(why ? [why] : []), ...(out.errors || [])] };
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
      /* 写前预检：损坏/有跳过条目的台账一律不拿来做合并，也不再重读一次
         （重读会撞上"原文件已被改名备份 → 看起来是干净空台账"而放行）。 */
      const stLedger = readLedgerState();
      const fault = ledgerFault(stLedger);
      if (fault) return { ok: false, stage: 'ledger', error: fault };
      const digestWarnings = [];
      const parsed = parseRepoInput(input);
      if (!parsed) return { ok: false, stage: 'parse', error: '仓库地址无法解析' };
      const repo = { owner: parsed.owner, repo: parsed.repo };
      const ref = opts.ref || parsed.ref || null;

      const rel = await fetchRelease(repo, { fetch: fetchFn, ref, headers: ghOptsHeaders });
      if (!rel.ok) return { ok: false, stage: 'release', error: rel.error };
      const version = String(rel.release.tag_name || rel.release.name || '').replace(/^v/i, '');
      const assets = (Array.isArray(rel.release.assets) ? rel.release.assets : [])
        .filter((a) => a && typeof a.name === 'string' && isUploadedAsset(a)
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

      const dl = await downloadAsset(asset, { fetch: fetchFn, headers: ghOptsHeaders });
      if (!dl.ok) return { ok: false, stage: 'download', error: dl.error };

      /* 下载完先校验产物完整性，再交给解包器。
         校验放在解包之前：坏字节流若直接进 unpackTarGz，用户看到的是
         一句「gzip 解压失败 / tar 头校验和不匹配」，指向一个不存在的问题，
         真因其实是这一趟下载没下全。 */
      const dv = await verifyAssetDigest(dl.buffer, asset);
      if (!dv.ok) return { ok: false, stage: 'digest', error: dv.reason };
      if (!dv.checked) digestWarnings.push('该 release 产物没有 digest，跳过完整性校验（老 release 常见）');

      const unpacked = await unpackTarGz(dl.buffer);
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
      const warnings = [...r.warnings, ...unpacked.warnings, ...digestWarnings];
      for (const s of unpacked.skipped) warnings.push(`解包跳过条目 ${s.name}: ${s.reason}`);
      let sha = null;
      if (ref || version) {
        const s = await fetchRefSha(repo, ref || `v${version}`, { fetch: fetchFn, headers: ghOptsHeaders });
        if (s.ok) sha = s.sha;
        else warnings.push(`commit sha 未取到（${s.error}），更新指纹比对会退化`);
      }
      const rec = recordInstall(stLedger.ledger, {
        id, version: mf.manifest.version, repo, ref, sha, asset,
      });
      if (rec.errors.length) {
        return { ok: false, stage: 'ledger', error: `安装已落盘但台账记录失败: ${rec.errors.join('; ')}`, id };
      }
      const wr = saveLedger(rec.ledger);
      if (!wr.ok) {
        return { ok: false, stage: 'ledger', id,
          error: `安装已落盘但台账写入失败: ${wr.error}（旧版本可能已被替换，请人工核对）`,
          warnings };
      }
      warnings.push(...rec.warnings);
      return { ok: true, id, version: mf.manifest.version, replaced: r.replaced,
        dir: r.dir, sha, digestChecked: dv.checked, warnings, errors: [] };
    },

    /**
     * 卸载。默认保留用户数据（D3）；显式 removeUserData 才删。
     * 去留结论只来自 policy，且 source 取台账里的记录，不靠 id 前缀猜。
     */
    async uninstall(id, opts = {}) {
      const stLedger = readLedgerState();
      const fault = ledgerFault(stLedger);
      if (fault) return { ok: false, id, stage: 'ledger', error: fault, removed: [], kept: [] };
      const plan = uninstallPlan({ root, id, userDataRoot });
      if (!plan.ok) return { ok: false, id, error: plan.reason, removed: [], kept: [] };
      if (!plan.exists) return { ok: false, id, error: '插件未安装', removed: [], kept: [] };

      const entry = getEntry(stLedger.ledger, id);
      const source = normalizeSource(entry && entry.source);
      const purge = shouldPurgeDataOnUninstall({
        id, source, removeUserData: opts.removeUserData === true,
      });

      const r = uninstallPlugin({ root, id, userDataRoot, removeUserData: purge });
      if (!r.ok) return { ok: false, id, error: r.errors.join('; '), removed: r.removed, kept: r.kept };

      const rec = recordUninstall(stLedger.ledger, id);   // 契约②
      const wr = saveLedger(rec.ledger);
      if (!wr.ok) {
        return { ok: false, id, stage: 'ledger',
          error: `卸载已完成但台账写入失败: ${wr.error}`,
          removed: r.removed, kept: r.kept };
      }
      return { ok: true, id, source, purgeUserData: purge,
        removed: r.removed, kept: r.kept,
        plan: { fileCount: plan.fileCount, bytes: plan.bytes },
        errors: [] };
    },
  };
}
