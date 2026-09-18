/**
 * 文件清单制（D3）—— 插件产出的文件归属记账
 * ============================================================
 * 为什么需要它
 * ------------------------------------------------------------
 * DOM 残留可以靠**快照差分**发现（S2）：拍 window keys / head / body
 * 子节点 / styleSheets 数量，卸载后多出来的就是嫌疑。
 *
 * **磁盘不行。** 没有任何办法从"文件系统现在的状态"反推出
 * "哪些文件是哪个插件写的" —— 文件名不带来源信息，修改时间也不带。
 *
 * 而卸载时如果要清理，就**必须**先回答这个问题。答错了后果很严重：
 * 删掉用户自己的文件、或删掉另一个插件正在用的缓存 ——
 * **删错比不删更糟**。
 *
 * 所以只能走清单制：**插件写之前先声明归属**，宿主记账，
 * 卸载时按账本给出"这个插件产生过这些路径"。
 *
 * 为什么不自动删
 * ------------------------------------------------------------
 * 与 S2 同一条原则（N42）：**只读报告，不做自动清理**。
 *
 * 自动删除有几个躲不掉的问题：
 *   · 声明的是目录时，里面可能混着用户自己放的文件
 *   · 插件可能声明了但文件其实是共享的（多个插件共用的缓存）
 *   · 删错了无法撤销
 *
 * 所以这里只提供**清单**与**显式 purge**，删不删由用户/UI 决定。
 *
 * 记账放在宿主侧
 * ------------------------------------------------------------
 * 插件只发"我声明这个路径"，**账本在宿主**。插件不可信：
 * 不能让它自报"我已经删干净了"就信以为真。
 */
/* 不用外部 warn 模块：本文件要保持**零运行时依赖**，
   以便 jsdom 里直接 import 测试（N59：沙盒依赖会被 npm install 裁剪）。 */
const warn = (...a) => { try { console.warn(...a); } catch { /* 忽略 */ } };

/** 记账的 localStorage 前缀（与 store 的 `nexus:<id>:` 区分开） */
const PREFIX = 'nexus:fsclaim:';

/**
 * 规范化路径：去首尾空白、统一反斜杠为正斜杠、去掉结尾斜杠。
 *
 * 不去 `..` / `.` —— 那是**路径解析**的事，该由 fs_op 在 Rust 侧做
 * （那里有 canonicalize 与授权根校验）。这里只做**记账去重**需要的
 * 最小归一：让 `/a/b/` 与 `/a/b` 算同一条，否则账本会越来越长。
 */
export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim().replace(/\\/g, '/');
  /* 保留根 "/"：不能把 "/" 变成 "" */
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

const keyOf = (pluginId) => `${PREFIX}${pluginId}`;

/** 读某插件的账本。坏数据返回空数组 —— 一个插件的账坏了不该影响卸载流程。 */
export function readClaims(pluginId) {
  if (!pluginId) return [];
  try {
    const raw = localStorage.getItem(keyOf(pluginId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => typeof x?.path === 'string' && x.path);
  } catch (e) {
    warn(`[plugin-fs] 账本损坏（${pluginId}），按空处理:`, e);
    return [];
  }
}

function writeClaims(pluginId, list) {
  try {
    localStorage.setItem(keyOf(pluginId), JSON.stringify(list));
    return true;
  } catch (e) {
    /* 配额满 / 隐私模式禁用 localStorage —— 记账失败不该阻断插件运行 */
    warn(`[plugin-fs] 账本写入失败（${pluginId}）:`, e);
    return false;
  }
}

/**
 * 声明一条归属。
 *
 * @returns {{ok: boolean, deduped?: boolean, reason?: string}}
 *   失败时**不抛** —— 声明失败不该让插件写不了文件，只是不再被记账。
 */
export function claimPath(pluginId, rawPath, meta = {}) {
  const path = normalizePath(rawPath);
  if (!path) return { ok: false, reason: '路径为空' };
  if (!pluginId) return { ok: false, reason: '缺少 pluginId' };

  const list = readClaims(pluginId);
  const hit = list.find((x) => x.path === path);
  if (hit) {
    /* 重复声明：更新时间戳与备注，但**不新增条目** —— 否则插件每次
       写文件都 claim 一次，账本会爆炸。 */
    hit.at = Date.now();
    if (meta.kind) hit.kind = meta.kind;
    if (meta.note) hit.note = meta.note;
    writeClaims(pluginId, list);
    return { ok: true, deduped: true };
  }
  list.push({
    path,
    kind: meta.kind || 'file',
    note: meta.note || '',
    at: Date.now(),
  });
  writeClaims(pluginId, list);
  return { ok: true };
}

/** 撤销一条声明（插件自己删了文件后调用）。 */
export function releasePath(pluginId, rawPath) {
  const path = normalizePath(rawPath);
  if (!path || !pluginId) return { ok: false, reason: '参数不完整' };
  const list = readClaims(pluginId);
  const next = list.filter((x) => x.path !== path);
  if (next.length === list.length) return { ok: true, removed: 0 };
  writeClaims(pluginId, next);
  return { ok: true, removed: list.length - next.length };
}

/** 清空某插件的全部声明。purge 后调用，避免留下幽灵条目。 */
export function clearClaims(pluginId) {
  if (!pluginId) return { ok: false };
  try {
    localStorage.removeItem(keyOf(pluginId));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** 全量账本（供 UI 展示"哪些插件占了多少文件"）。 */
export function allClaims() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const id = k.slice(PREFIX.length);
      const list = readClaims(id);
      if (list.length) out[id] = list;
    }
  } catch { /* localStorage 不可用：返回空 */ }
  return out;
}
