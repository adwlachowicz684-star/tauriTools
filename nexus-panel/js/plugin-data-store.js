/**
 * 市场插件的用户数据存储（按 plugin id 分目录，落在 appDataDir）
 * ============================================================================
 *
 * 它兑现的是决策 D3：**卸载删代码、保留用户数据；重装同一个 id 可恢复**。
 *
 * ---------------------------------------------------------------------------
 * 为什么要新增文件存储，而不是继续用 localStorage
 * ---------------------------------------------------------------------------
 * 现状（js/plugin-config.js / js/plugin-store.js）：所有插件数据都在一份
 * localStorage 里，键形如 `nexus:<id>:<k>`，卸载时 purgePluginStorage 按前缀清。
 * 三个问题：
 *   1. 数据跟着 **origin** 走，不跟着"插件安装"走 —— 清理浏览器数据、
 *      换壳、重装应用就没了，而插件代码还在（或反之）。
 *   2. iframe 与同页插件共用同一份 localStorage（plugin-store.js 文件头
 *      已写明），隔离只能靠键名前缀，一旦哪处拼错就串数据且不报错。
 *   3. 卸载要"保留"，就得让保留的东西有个明确、可枚举、可备份的家。
 *
 * 落点：`${appDataRoot}/plugin-data/<id>/store.json`，一个插件一个目录。
 * 后端 fs_op 的授权根白名单本来就**默认包含 appDataDir**
 * （af_flow.rs 的注释：「刚装好、还没配过任何目录时 fs_op 仍可用于自己的
 * 数据区」），所以不需要新增 Rust 命令，也不需要用户先授权。
 *
 * ---------------------------------------------------------------------------
 * 四条硬约束（改代码前先看）
 * ---------------------------------------------------------------------------
 *
 * 1. **键名必须复用 js/plugin-store.js，不许另起一套。**
 *    迁移就是把 localStorage 里 `nexus:<id>:<k>` 的 k 搬过来；
 *    另起一套的结果是"旧数据搬过来但读不到"，且不报错。
 *
 * 2. **文件损坏必须抛错，不许静默返回默认值。**
 *    半个 JSON（写入被中断、磁盘满了）若被 catch 成 {}，表现为
 *    「插件设置全丢」且没有任何报错 —— 本项目反复栽的静默失效。
 *    文件**不存在**才返回空对象，这两件事必须分开。
 *
 * 3. **写入必须原子：先写 .tmp，再 move 成 store.json。**
 *    本项目已经真实发生过两次「写到一半被中断，留下非法 JSON」
 *    （package.json 三方合并、.push-sync 基线）。直接覆盖写的话，
 *    中断时**旧数据也被毁了**，不可逆。
 *    tmp 写一半 → 只有 tmp 是坏的，store.json 仍是上一份完整数据；
 *    后端 fs_op 的 move 走 rename_with_fallback，目标已存在时覆盖
 *    （源码里另有 replace_file() 专为「临时文件落盘最后一跳」设计）。
 *    残留 tmp 永远不参与读取，下次写入用新随机名 —— 垃圾但不影响正确性。
 *
 * 4. **去留只问 js/plugin-data-policy.js，不在这里自己判断。**
 *    host.removePlugin 与 installer.uninstallPlugin 已经共用那一个结论；
 *    这里再写一份就是第三份，而"三份里有一份说该删"的代价是不可逆的。
 *
 * ---------------------------------------------------------------------------
 * 刻意不做的事
 * ---------------------------------------------------------------------------
 * · **不做路径校验**（也不 import node:path —— 本模块要在 webview 里跑）。
 *   id 通过 isValidPluginId() 保证不含 / 与 ..，其余路径安全交给后端
 *   resolve_within。这里的 joinSegments 只做拼接，不是安全边界。
 * · **不自动迁移**：migrate() 要显式调用，且幂等。后台偷偷搬数据，
 *   出错时用户无从知道哪份才是准的。
 * · **迁移后不清 localStorage**：旧数据留着是兜底，删了不可逆。
 * · **不碰代码目录**：删代码是 plugin-installer.js 的事，本模块只管数据。
 */

import { storePrefix } from './plugin-store.js';
import { shouldPurgeDataOnUninstall } from './plugin-data-policy.js';
import { isValidPluginId } from './plugin-manifest.js';

/** appDataDir 下的子目录名。与 installed-plugins/ 分开：代码与数据不同生命周期。 */
export const DATA_DIR_NAME = 'plugin-data';
export const STORE_FILE = 'store.json';
export const STORE_VERSION = 1;

/** 拼接路径段。只做拼接/去重复分隔符，**不**承担任何安全校验。 */
export function joinSegments(base, ...parts) {
  let s = String(base || '').replace(/\\/g, '/').replace(/\/+$/, '');
  for (const p of parts) {
    s += '/' + String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }
  return s;
}

function assertId(id) {
  if (!isValidPluginId(id)) {
    throw new Error(`plugin-data-store: 非法插件 id: ${String(id)}`);
  }
}

function emptyRecord() {
  return { v: STORE_VERSION, data: {} };
}

/**
 * 造一个数据存储。
 *
 * 做成工厂而不是写死 invoke / node:fs，理由与 plugin-fs-bridge 一致：
 * 逻辑层要能在 webview（注入 createFs(invoke)）与 Node 测试（注入内存 fs）
 * 两种环境跑。写死就只剩一种。
 *
 * @param {object} p
 * @param {object} p.fs            需 readText/writeText/exists/move/remove
 * @param {string} p.dataRoot      appDataDir 绝对路径（**由调用方给**，
 *                                 本模块不预设 —— 阶段 0 的加载侧结论未实测，
 *                                 写死等于用未验证假设绑死实现）
 * @param {object} [p.legacyStorage]  旧 localStorage（仅供 migrate 读）
 * @param {() => number} [p.now]      时间戳注入，测试可固定
 * @param {() => string} [p.rand]     临时文件名随机段注入
 * @param {(p:object)=>boolean} [p.policy]  去留策略注入，**仅供测试**；
 *                                 产品侧不给，永远走 plugin-data-policy.js
 * @returns {object}
 */
export function createPluginDataStore(p) {
  const o = p || {};
  const fs = o.fs;
  const dataRoot = o.dataRoot;

  for (const m of ['readText', 'writeText', 'exists', 'move', 'remove']) {
    if (!fs || typeof fs[m] !== 'function') {
      throw new Error(`plugin-data-store: fs 缺少 ${m}()`);
    }
  }
  if (typeof dataRoot !== 'string' || !dataRoot.trim()) {
    throw new Error('plugin-data-store: 缺少 dataRoot（appDataDir 由调用方传入）');
  }

  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const rand = typeof o.rand === 'function' ? o.rand
    : () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const policy = typeof o.policy === 'function' ? o.policy : shouldPurgeDataOnUninstall;

  const dataDir = (id) => {
    assertId(id);
    return joinSegments(dataRoot, DATA_DIR_NAME, id);
  };
  const dataFile = (id) => joinSegments(dataDir(id), STORE_FILE);

  /** 读整份 record。文件不存在 → 空 record；文件损坏 → **抛错**。 */
  async function readRecord(id) {
    const file = dataFile(id);
    if (!(await fs.exists(file))) return emptyRecord();
    const raw = await fs.readText(file);
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      throw new Error(`插件数据文件损坏（不是合法 JSON）: ${file}；未自动重置，请人工核对`);
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)
        || rec.v !== STORE_VERSION
        || !rec.data || typeof rec.data !== 'object' || Array.isArray(rec.data)) {
      throw new Error(`插件数据文件格式不对: ${file}；未自动重置，请人工核对`);
    }
    return rec;
  }

  /** 原子写一整份 record。中途失败时 store.json 保持上一份完整内容。 */
  async function writeRecord(id, rec) {
    const dir = dataDir(id);
    const file = dataFile(id);
    const tmp = joinSegments(dir, `.store-${rand()}.tmp`);
    const payload = JSON.stringify(rec, null, 2);
    await fs.writeText(tmp, payload);
    await fs.move(tmp, file);
    return { saved: true };
  }

  return {
    dataDir,
    dataFile,

    /** 该插件的全部 KV（键是 k，不含 nexus:<id>: 前缀） */
    async readAll(id) {
      return { ...(await readRecord(id)).data };
    },

    async get(id, k, def = null) {
      const data = (await readRecord(id)).data;
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : def;
    },

    async set(id, k, value) {
      const rec = await readRecord(id);
      rec.data[String(k)] = value;
      rec.updatedAt = now();
      await writeRecord(id, rec);
      return { saved: true };
    },

    async patch(id, obj) {
      const rec = await readRecord(id);
      if (obj && typeof obj === 'object') Object.assign(rec.data, obj);
      rec.updatedAt = now();
      await writeRecord(id, rec);
      return { saved: true };
    },

    async removeKey(id, k) {
      const rec = await readRecord(id);
      const key = String(k);
      if (!Object.prototype.hasOwnProperty.call(rec.data, key)) return { removed: false };
      delete rec.data[key];
      rec.updatedAt = now();
      await writeRecord(id, rec);
      return { removed: true };
    },

    /**
     * 把 localStorage 里本插件的键搬进文件。
     *
     * 幂等且**不覆盖新数据**：文件里已有的 k 一律保留（用户在升级后
     * 改过的设置不能被旧快照盖掉），只补文件里没有的键。
     * 已迁移过就直接跳过。旧的 localStorage 数据不删（兜底，删了不可逆）。
     *
     * @returns {{imported:number, skipped:boolean, keys:string[]}}
     */
    async migrate(id) {
      const rec = await readRecord(id);
      if (rec.migrated === true) return { imported: 0, skipped: true, keys: [] };

      const storage = o.legacyStorage;
      if (!storage || typeof storage.key !== 'function' || typeof storage.getItem !== 'function') {
        return { imported: 0, skipped: true, keys: [] };
      }
      const prefix = storePrefix(id);
      const keys = [];
      let imported = 0;
      const len = Number(storage.length) || 0;
      for (let i = 0; i < len; i++) {
        const full = storage.key(i);
        if (typeof full !== 'string' || !full.startsWith(prefix)) continue;
        const k = full.slice(prefix.length);
        if (!k || Object.prototype.hasOwnProperty.call(rec.data, k)) continue;
        const raw = storage.getItem(full);
        if (raw == null) continue;
        try {
          rec.data[k] = JSON.parse(raw);
        } catch {
          /* 旧值不是 JSON（历史上有直接写裸字符串的）：按字符串保留原样 */
          rec.data[k] = raw;
        }
        keys.push(k);
        imported++;
      }
      rec.migrated = true;
      rec.migratedAt = now();
      await writeRecord(id, rec);
      return { imported, skipped: false, keys };
    },

    /** 只读报告：卸载/设置页展示用，不改任何东西。 */
    async report(id) {
      const file = dataFile(id);
      const exists = await fs.exists(file);
      return {
        id,
        dataDir: dataDir(id),
        exists,
        keys: exists ? Object.keys((await readRecord(id)).data) : [],
      };
    },

    /** 显式删除该插件的数据目录。只有策略说该删时才由 uninstall 调用。 */
    async purge(id) {
      const dir = dataDir(id);
      if (!(await fs.exists(dir))) return { removed: false };
      await fs.remove(dir, { force: true });
      return { removed: true };
    },

    /**
     * 卸载时的**数据侧**动作。代码目录由 plugin-installer.js 管。
     * 去留结论来自 plugin-data-policy.js，与 host.removePlugin 共用同一份。
     */
    async uninstall(id, opts = {}) {
      const decision = !!policy({
        id,
        source: opts.source,
        removeUserData: opts.removeUserData === true,
      });
      if (decision) await this.purge(id);
      return { id, purged: decision, kept: !decision };
    },
  };
}
