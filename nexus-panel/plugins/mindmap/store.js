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
  try {
    const all = await tx('readonly', (s) => s.getAllKeys());
    return (all || []).filter((k) => typeof k === 'string' && k.startsWith(prefix));
  } catch (e) {
    noteError('列举', prefix + '*', e);
    return [];
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
  save: (v) => set(K_FILES, v),
};

export const folders = {
  load: () => get(K_FOLDERS, []),
  save: (v) => set(K_FOLDERS, v),
};

/** 单个脑图文件的内容（一份工作簿） */
export function doc(id) {
  return {
    load: () => get(K_DOC + id, null),
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
 * 返回新备份的 key；写入失败返回 null（备份失败不应影响主流程）。
 */
export async function pushBackup(snapshot, keep = BACKUP_KEEP) {
  const ts = Date.now();
  const key = K_BACKUP + String(ts).padStart(14, '0');
  const ok = await set(key, { ts, ...snapshot });
  if (!ok) return null;
  // 份数上限可配置（C# MindMapBackupMax）。非法值（0 / 负数 / NaN）退回默认，
  // 否则会算出「保留 0 份」—— 每次备份都会被立刻删掉。
  const n = Number(keep);
  const limit = Number.isFinite(n) && n >= 1 ? Math.floor(n) : BACKUP_KEEP;
  const all = (await keys(K_BACKUP)).sort();
  // 字典序 = 时间序，从最旧开始删
  for (let i = 0; i < all.length - limit; i++) await del(all[i]);
  return key;
}

/** 备份列表（新→旧） */
export async function listBackups() {
  const all = (await keys(K_BACKUP)).sort().reverse();
  const out = [];
  for (const k of all) {
    const v = await get(k, null);
    if (v) out.push({ key: k, ...v });
  }
  return out;
}

export async function clearBackups() {
  for (const k of await keys(K_BACKUP)) await del(k);
}
