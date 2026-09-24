/**
 * md · 最近阅读列表
 * ============================================================
 * 为什么需要它：宿主目前**没有**选文件对话框（G4），所以拖入之外
 * 只有"从项目组点「阅读」"一条路。用户关掉面板后想再看刚才那份，
 * 得回到项目组重新找。这份列表让插件自己能重开最近读过的文件，
 * 不需要新增任何 Rust 能力或权限。
 *
 * 存的是**路径**，不是内容：内容可能有几 MB，塞 localStorage 会撑爆配额，
 * 而且文件在磁盘上可能已经被改过，存内容等于存了一份过期副本。
 *
 * 【三条不显然的约束】
 * ------------------------------------------------------------
 * ① 上限必须写在**写入侧**（addRecent），读侧 slice 只是兜底。
 *    只在读时 slice 的话，localStorage 里会一直堆到几十上百条，
 *    而界面上永远只显示 12 条 —— 不报错、看不出来，
 *    但配额被慢慢吃光（这类"静默增长"后面很难查）。
 *
 * ② 解析必须包 try/catch 且逐条校验。
 *    localStorage 是用户可手工改的（手改主题色那次已经证明会有人改），
 *    塞进一个非法 JSON 会让 JSON.parse 抛错 —— 不接住就是插件白屏。
 *    逐条校验同理：`[{path:null}]`、`"abc"`、`{}` 都要当空列表处理。
 *
 * ③ storage 不可用时要降级成"没有最近列表"，不能崩。
 *    某些环境（隐私模式、配额满）下 localStorage 存取会抛。
 *    所有读写都过 store() 与 try/catch，取不到就当空。
 */

/** 命名空间前缀：不带前缀会和别的插件的 key 撞车。 */
const KEY = 'nexus:md:recent';

/** 上限。12 条够回溯，再多列表就变成要滚动的第二屏了。 */
export const MAX_RECENT = 12;

/**
 * 取 storage。
 * 访问 localStorage 本身在某些环境就会抛（跨域 iframe、被策略禁用），
 * 所以连"取这个对象"都要包起来。
 */
function store() {
  try {
    const s = globalThis.localStorage;
    return s || null;
  } catch (err) {
    return null;
  }
}

/** 取文件名部分（路径 → basename）。Windows 的反斜杠要一并认。 */
export function baseNameOf(p) {
  return String(p || '').replace(/\\/g, '/').split('/').pop() || String(p || '');
}

/**
 * 读列表。
 * 返回已去重、已过滤脏数据、已按上限收好的数组。
 */
export function readRecent() {
  const ls = store();
  if (!ls) return [];
  let raw = null;
  try {
    raw = ls.getItem(KEY);
  } catch (err) {
    return [];
  }
  if (!raw) return [];
  let arr = null;
  try {
    arr = JSON.parse(raw);
  } catch (err) {
    // 手工改坏了：当空列表，不要崩
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    if (!it || typeof it.path !== 'string' || !it.path) continue;
    // 去重按**完整路径**而不是文件名：不同目录下的同名文件是两份
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    out.push({
      path: it.path,
      title: typeof it.title === 'string' && it.title ? it.title : baseNameOf(it.path),
      at: Number(it.at) || 0,
    });
  }
  return out.slice(0, MAX_RECENT);
}

/** 写列表。写失败（配额满等）返回 false，调用方据此决定要不要提示。 */
export function writeRecent(list) {
  const ls = store();
  if (!ls) return false;
  try {
    ls.setItem(KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    return false;
  }
}

/** 新增/提到最前。返回写入后的列表。 */
export function addRecent(path, title) {
  const p = String(path || '');
  if (!p) return readRecent();
  const rest = readRecent().filter((it) => it.path !== p);
  const next = [{ path: p, title: title || baseNameOf(p), at: Date.now() }, ...rest];
  // ① 写入侧收上限
  const capped = next.slice(0, MAX_RECENT);
  writeRecent(capped);
  return capped;
}

/** 移除单条。文件被删/移走后调用，避免留一条永远打不开的记录。 */
export function removeRecent(path) {
  const p = String(path || '');
  const next = readRecent().filter((it) => it.path !== p);
  writeRecent(next);
  return next;
}

/** 清空。 */
export function clearRecent() {
  writeRecent([]);
  return [];
}
