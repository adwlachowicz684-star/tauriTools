/**
 * 思维导图插件 · 持久化层（IndexedDB）
 * ============================================================
 * 为什么不用插件自带的 ctx.store：
 *   ctx.store 底层是 localStorage，单插件 5MB 配额。脑图是"多画布 + 自动备份 + 自定义主题"，
 *   一份 JSON 几百 KB 起步，加上 10 份滚动备份很快触顶。IndexedDB 配额按磁盘算，够用。
 *
 * 设计要点：
 *   · 单个 object store 'docs'，key 为字符串 id，值任意结构化对象 —— 一把钥匙开所有门；
 *   · 所有写入走 put（幂等），读取失败一律回退默认值，绝不因存储异常卡住 UI；
 *   · 备份用 'backup:<毫秒时间戳>' 作 key，靠 key 的字典序天然实现"最新在前"。
 */

const DB_NAME = 'nexus-mindmap';
const DB_VERSION = 1;
const STORE = 'docs';

/**
 * 备份滚动窗口：保留最近 N 份快照。
 * 默认 10；实际份数由设置项 settings.backupMax 决定（C# 的 MindMapBackupMax，默认 3）。
 * 这里保留常量作为兜底默认值，pushBackup 接受 keep 参数。
 */
export const BACKUP_KEEP = 10;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  }).catch((e) => {
    // 打开失败时清掉缓存 promise，下次调用可重试（例如隐私模式退出后重进）
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let out;
        try {
          out = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => {
          // 注意：IDBRequest 的 result 为 undefined 是合法结果（key 不存在 / put 无返回值），
          // 不能写成 `out.result !== undefined ? out.result : out` —— 那样会把 request 对象
          // 当成值交出去，首次读取就拿到脏数据（themes.load() 会拿到 request 而非 []）。
          const val = out && typeof out === 'object' && 'result' in out ? out.result : out;
          resolve(val);
        };
        t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
        t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
      }),
  );
}

/**
 * 读路径的错误可见性。
 * ============================================================
 * 早前 store.get 把所有异常都吞成默认值：IndexedDB 损坏 / 被禁用（隐私模式）时，
 * 用户看到的是「脑图变空了」而不是明确错误 —— 很可能继续编辑然后真丢数据。
 *
 * 写路径已经做得很好（set 返回 false，调用方全部判返回值）。读路径同样要能区分
 * 「这个键本来就没数据」和「读失败」。这里做的两件事：
 *   1. 首次读失败时 console.warn + 记录到 lastError，供插件层弹一次提示；
 *   2. 导出 lastStoreError / takeStoreError / resetStoreError，
 *      让 UI 有机会把「读失败」摆到状态栏上。
 *
 * 不改成抛异常：get 的调用点遍布初始化流程，抛出去会让整个插件挂不上，
 * 而「降级成默认值 + 明确提示」才是这里想要的行为。
 */
let lastError = null;

/** 最近一次读写失败的说明（null 表示一切正常） */
export function lastStoreError() {
  return lastError;
}

/** 取走并清空错误标记（插件层弹过提示后调用，避免重复提示） */
export function takeStoreError() {
  const e = lastError;
  lastError = null;
  return e;
}

/** 清空错误标记（测试用） */
export function resetStoreError() {
  lastError = null;
}

function noteError(op, key, e) {
  lastError = `本地存储${op}失败（${key}）：${e?.message || e}`;
  // 保留控制台痕迹：这是排查「为什么脑图变空了」的第一现场
  try { console.warn('[mindmap/store]', lastError); } catch { /* ignore */ }
}

/** 读取；不存在或异常时返回 def（异常会记进 lastError，供 UI 提示） */
export async function get(key, def = null) {
  try {
    const v = await tx('readonly', (s) => s.get(key));
    return v === undefined || v === null ? def : v;
  } catch (e) {
    noteError('读取', key, e);
    return def;
  }
}

/** 写入（结构化克隆，支持任意 JSON 对象）；失败返回 false 并记错误 */
export async function set(key, value) {
  try {
    await tx('readwrite', (s) => s.put(value, key));
    return true;
  } catch (e) {
    noteError('写入', key, e);
    return false;
  }
}

export async function del(key) {
  try {
    await tx('readwrite', (s) => s.delete(key));
    return true;
  } catch (e) {
    noteError('删除', key, e);
    return false;
  }
}

/** 列出带前缀的 key（用于清理备份）；失败返回空数组并记错误 */
export async function keys(prefix = '') {
  const all = await keysRaw(prefix);
  return all || [];
}

/**
 * 列出带前缀的 key（**严格版**）：失败返回 **null**，不是空数组。
 *
 * ⓘ 空数组有两个含义（"本来就没有" 与 "列举失败了"），调用方分不开 ——
 *   而这两种情况的处理方式往往**必须不同**。备份列表就是典型：
 *   列举失败时"没有快照"是假的，照着它去回收孤儿附件会把快照里
 *   仍在使用的资产当成没人引用删掉（BUG 164）。需要区分的调用方用这个版本。
 */
async function keysRaw(prefix = '') {
  try {
    const all = await tx('readonly', (s) => s.getAllKeys());
    return (all || []).filter((k) => typeof k === 'string' && k.startsWith(prefix));
  } catch (e) {
    noteError('列举', prefix + '*', e);
    return null;
  }
}

/**
 * 读取（**严格版**）：不把失败降级成"没数据"。
 *
 * ⓘ `get` 失败时返回默认值 —— "没有" 与 "读不出来" **长得一模一样**。
 *   对图标库这类数据，后者意味着用户自定义图标凭空消失：条目还在、
 *   字节还在，只是这一刻没读出来（BUG 165）。需要区分的调用方用这个版本。
 *
 * @returns {Promise<{ok:boolean, value:*}>} ok=false 表示**读失败**（不是"没有"）
 */
export async function getStrict(key) {
  try {
    const v = await tx('readonly', (s) => s.get(key));
    return { ok: true, value: v === undefined ? null : v };
  } catch (e) {
    noteError('读取', key, e);
    return { ok: false, value: null };
  }
}

/* --------------------------- 语义化封装 --------------------------- */

const K_WORKBOOK = 'workbook';   // 旧版单工作簿键，仅用于迁移
const K_FILES = 'fileindex';
const K_FOLDERS = 'folders';
const K_DOC = 'doc:';
const K_THEMES = 'themes';
const K_SETTINGS = 'settings';
const K_BACKUP = 'backup:';

/**
 * 旧版单工作簿键 —— **只读，不要往这里写**。
 * 多文档改造后每个脑图各存 doc:<id>，写 'workbook' 等于内容永远读不回来
 * （加载路径读的是 doc:<id>），还白占一份 IndexedDB 配额。
 * save 保留仅为兼容历史代码，请一律改用 doc(id).save()。
 */
export const workbook = {
  load: () => get(K_WORKBOOK, null),
  /** @deprecated 仅迁移期兼容；新代码请用 doc(id).save() */
  save: (wb) => set(K_WORKBOOK, wb),
};

/**
 * 文件库（多文档）。
 * ============================================================
 * 旧模型是「一个工作簿 + 多张画布」，整份数据存在 workbook 键下。
 * 加入左侧文件列表后改为「一个文件 = 一份工作簿」，各自存 doc:<id>，
 * 列表本身只存轻量索引（名称 / 归属文件夹），不存画布内容 ——
 * 否则每次打开文件都要把所有脑图读进内存。
 *
 * fileIndex: [{ id, name, folderId }]   folderId 为 null 表示在根目录
 * folders:   [{ id, name, collapsed }]
 */
export const files = {
  load: () => get(K_FILES, null),
  /**
   * 严格版：区分「没有索引」与「读不出来」。
   *
   * ⓘ BUG 175：启动时 `files.load()` 读失败返回 null，与「本来就没有索引」
   *   **长得一模一样** —— 于是首次迁移那段立刻跑起来，`files.save` 把真索引
   *   **覆盖**成一个新文件，用户所有的脑图变成没人引用的孤儿 doc 键。
   *   而写路径往往是好的（单条记录损坏只坏那一条），所以两次写入都成功、
   *   bootWarn 为空 —— 一句提示都没有。
   */
  loadStrict: () => getStrict(K_FILES),
  save: (v) => set(K_FILES, v),
};

export const folders = {
  load: () => get(K_FOLDERS, []),
  /** 严格版（同上）：读失败不能当成「没有文件夹」 */
  loadStrict: () => getStrict(K_FOLDERS),
  save: (v) => set(K_FOLDERS, v),
};

/** 单个脑图文件的内容（一份工作簿） */
export function doc(id) {
  return {
    load: () => get(K_DOC + id, null),
    /** 严格版（同上）：读失败不能当成「这份脑图是空的」 */
    loadStrict: () => getStrict(K_DOC + id),
    save: (v) => set(K_DOC + id, v),
    del: () => del(K_DOC + id),
  };
}

/** 列出所有文档 key（用于清理孤儿数据） */
export function docKeys() {
  return keys(K_DOC);
}

/** 自定义主题数组 */
export const themes = {
  load: () => get(K_THEMES, []),
  save: (list) => set(K_THEMES, list),
};

/** 设置项：{ animate, autoBackup, ... } */
export const settings = {
  load: () => get(K_SETTINGS, {}),
  save: (v) => set(K_SETTINGS, v),
};

/**
 * 写一份备份快照，并滚动删除超出窗口的旧备份。
 *
 * ⓘ **滚动清理必须回话**（BUG 160）。早先这里写的是 `await del(all[i])` ——
 *   不接返回值，于是 `del` 吞异常返回 false 时**完全看不出来**：
 *
 *   · 设置面板明写「超出自动删除最旧的一份」，面板上还标着「最多保留 N 份」，
 *     这是**承诺式**文案，删不掉就等于没兑现；
 *   · 快照会一路堆积占着配额，堆到写不进去时**连新快照都会失败**——
 *     而那次失败用户看到的只是「快照创建失败」，不会知道是堆积造成的；
 *   · 调用方拿到的仍是 key，于是说「已创建快照」，窗口其实已经破了。
 *
 *   这与 trimBackups（设置收敛 / 导入后清理）是**同一条规矩的两条路径**：
 *   那边已经回话（BUG 159），这边漏掉就还是「只修一半」。
 *
 * ⚠️ 循环变量 i 无论 del 成不成功都递增 ——「打算删几份」的额度是固定的，
 *    失败就不往下补删（补删会超额删掉用户的退路，见 BUG 159 的 M6）。
 *
 * @returns {Promise<{key:string|null, trimFailed:number}>}
 *   key —— 新快照的键；写入失败为 null（备份失败不应影响主流程）。
 *   ⚠️ **不是裸 key**：`if (key)` 那种写法会把「清理失败」当成「一切正常」。
 *   trimFailed —— 滚动清理里 del 返回 false 的份数。
 *
 * ⓘ 与 putBackup 的区别：那个只写不清理、返回 key（成功）/ null（写失败）/
 *    false（ts 非法）；这个**一定返回对象**，两者不要混用。
 */
export async function pushBackup(snapshot, keep = BACKUP_KEEP) {
  const ts = Date.now();
  const key = K_BACKUP + String(ts).padStart(14, '0');
  const ok = await set(key, { ts, ...snapshot });
  if (!ok) return { key: null, trimFailed: 0 };
  // 份数上限可配置（C# MindMapBackupMax）。非法值（0 / 负数 / NaN）退回默认，
  // 否则会算出「保留 0 份」—— 每次备份都会被立刻删掉。
  const n = Number(keep);
  const limit = Number.isFinite(n) && n >= 1 ? Math.floor(n) : BACKUP_KEEP;
  const all = (await keys(K_BACKUP)).sort();
  let trimFailed = 0;
  // 字典序 = 时间序，从最旧开始删
  for (let i = 0; i < all.length - limit; i++) {
    if (!(await del(all[i]))) trimFailed++;
  }
  return { key, trimFailed };
}

/**
 * 写入**指定时间戳**的备份（A42 导入用）。
 *
 * 与 pushBackup 的区别：不自动生成 ts、不做滚动清理。导入场景要保留对方
 * 的原始时间（否则所有导入快照都挤成同一秒、排序失去意义），且清理统一
 * 由调用方在导入结束后做一次（逐份清理会在导入中途删掉刚写进去的）。
 *
 * @returns {boolean} 是否写入成功
 */
export async function putBackup(snapshot) {
  if (!snapshot || typeof snapshot.ts !== 'number') return false;
  const key = K_BACKUP + String(snapshot.ts).padStart(14, '0');
  // 成功时返回 key 而不是 true —— 导入方要拿它去保护刚写入的快照
  // （见 index.js 的 importBackups：不保护的话会被随后的滚动清理立刻删掉）。
  // 写入失败返回 null；ts 非法返回 false。三者都是 falsy，`if (ok)` 兼容。
  return (await set(key, snapshot)) ? key : null;
}

/** 备份列表（新→旧）。读不到的个别快照会**静默缺席**，需要保证"读全了"的调用方请用 listBackupsStrict */
export async function listBackups() {
  const { list } = await listBackupsStrict();
  return list || [];
}

/**
 * 备份列表（**严格版**，新→旧）。
 *
 * ⓘ 早先只有 listBackups：它内部 `get(k, null)` 失败（或值为空）时 `if (v)`
 *   直接跳过 —— 那份快照从列表里**凭空消失**，而调用方拿到的仍是"一个数组"，
 *   看不出少了。列举失败（keys 返回 []）同样是空数组，分不开。
 *
 *   这对「回收孤儿附件」是致命的：那份快照引用的资产不在 live 里，
 *   于是被当成没人引用删掉 —— 用户"删文件 → 从快照恢复"后发现附件全没了，
 *   而且字节已经不可恢复（BUG 164）。
 *
 * @returns {Promise<{list:Array|null, failed:number, enumFailed:boolean}>}
 *   list —— 快照列表；**列举失败时为 null**（不是空数组，空数组 = 真的没有）。
 *   failed —— 读不出来 / 值为空的份数。>0 表示这份列表**不完整**。
 *   enumFailed —— 连 key 都没列举出来。
 */
export async function listBackupsStrict() {
  const all = await keysRaw(K_BACKUP);
  if (!all) return { list: null, failed: 0, enumFailed: true };
  const out = [];
  let failed = 0;
  for (const k of all.slice().sort().reverse()) {
    const r = await getStrict(k);
    // 读失败与"值为空"都算不完整：那份快照引用的资产无从得知，只能保守处理
    if (!r.ok || !r.value) { failed++; continue; }
    out.push({ key: k, ...r.value });
  }
  return { list: out, failed, enumFailed: false };
}

/**
 * 清空全部快照。
 *
 * 必须**回话**（返回删掉了几份、几份没删成），不能像早先那样
 * `for (const k of await keys(...)) await del(k)` 就完事：
 *
 *   · `del` 是「吞异常返回 false」而不是抛出，不接返回值就**完全不知道**
 *     有没有删掉；
 *   · `keys` 列举失败时返回**空数组**（见上面它的注释），那时**一份都没删**，
 *     而调用方拿到的还是「删之前数出来的份数」。
 *
 * 清空是破坏性且**不可逆**的操作（快照就是为了"误操作后可回滚"而存在的），
 * 调用方按删之前的数报「已清空 N 份」，等于给了一句无法核对的假成功。
 *
 * @returns {Promise<{cleared:number, failed:number}>}
 *   cleared —— 真正删掉的份数；failed —— del 返回 false 的份数。
 *   ⚠️ 两者都为 0 时**不代表成功**：那是 `keys` 列举失败（一份都没轮到）。
 */
export async function clearBackups() {
  let cleared = 0;
  let failed = 0;
  for (const k of await keys(K_BACKUP)) {
    if (await del(k)) cleared++;
    else failed++;
  }
  return { cleared, failed };
}
