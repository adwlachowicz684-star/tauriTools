/**
 * 常用文件夹（工具级）—— 所有目录选择器共用的纯函数
 * ============================================================
 * 收藏一份目录、给它起个昵称，之后任何「选择文件夹」的界面都能一步到达。
 *
 * 【为什么单独抽一个文件】
 * 这份数据有三个使用者：
 *   · folder-picker 服务（选择器里显示 / 收藏 / 取消收藏）
 *   · 设置页的「常用文件夹」页签（改名、删除、浏览添加）
 *   · 将来任何直接调 fpx_list_fav_dirs 的界面
 * 三处各写一份归一化，迟早会在某处漏掉"去尾部斜杠"，
 * 于是同一个目录被判成两条收藏 —— 用户看到两个一模一样的条目，
 * 删掉一个另一个还在，且不会报错。
 *
 * 【为什么是纯函数、不碰 DOM】
 * 这样能在 node 里直接测（folder-picker-test.mjs 就是这么验的），
 * 不用为了"测一下去重对不对"去开浏览器拖文件夹。
 */

/** 上限：与 Rust 侧 FAV_DIR_MAX 一致。 */
export const FAV_MAX = 40;

/**
 * 路径归一化：去首尾空白、统一斜杠、去尾部斜杠。
 *
 * 不去尾部斜杠的话，同一个目录 `D:\work` 与 `D:\work\` 会被判成两条收藏。
 */
export function normPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/');
  if (!s) return '';
  // 根目录要保留那根斜杠："/" 去尾会变成空串，Unix 下就回不到根了
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/** 去重 + 去空 + 截断，保持顺序。收藏列表写回前必须先过一遍。 */
export function normalizeFavs(list) {
  const seen = new Set();
  const out = [];
  for (const d of Array.isArray(list) ? list : []) {
    const path = normPath(d?.path);
    if (!path || out.length >= FAV_MAX) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = String(d?.label ?? '').trim();
    out.push({ path, label: label || '' });
  }
  return out;
}

/** 显示名：有昵称用昵称，否则取路径最后一段。 */
export function favLabel(fav) {
  if (fav?.label) return fav.label;
  const p = normPath(fav?.path);
  if (!p) return '';
  const seg = p.split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1] : p;
}

/** 路径是否已收藏（决定「收藏」按钮显示成收藏还是已收藏）。 */
export function isFav(favs, path) {
  const p = normPath(path).toLowerCase();
  return (Array.isArray(favs) ? favs : []).some(
    (f) => normPath(f?.path).toLowerCase() === p,
  );
}

/** 按路径找一条收藏（改名 / 删除要用，返回下标）。 */
export function favIndexOf(favs, path) {
  const p = normPath(path).toLowerCase();
  return (Array.isArray(favs) ? favs : []).findIndex(
    (f) => normPath(f?.path).toLowerCase() === p,
  );
}

/**
 * 面包屑。
 *
 * 统一用 `/` 拼接：normPath 已经把 `\` 归一成 `/`，
 * 而 Rust 侧 PathBuf 在 Windows 上同样接受正斜杠。
 * 反过来（保留原分隔符）会拼出 `C:\Users/foo` 这种混血路径。
 */
export function crumbsOf(path) {
  const p = normPath(path);
  if (!p) return [];
  const parts = p.split('/').filter(Boolean);
  const out = [];
  let cur = '';
  for (const part of parts) {
    if (!cur) {
      cur = p.startsWith('/') ? `/${part}` : part;
      // Windows 盘符：C: 不是根目录，必须补成 C:/
      if (/^[A-Za-z]:$/.test(cur)) cur = `${cur}/`;
    } else {
      /*
       * 盘符那段收尾是 `C:/`（带斜杠），这里再拼一个就成 `C://Users`。
       * Windows 上这种双斜杠路径点击回退会失败，
       * 而且不报错 —— 只是"点了没反应"，很难想到是拼错了。
       */
      cur = cur.endsWith('/') ? `${cur}${part}` : `${cur}/${part}`;
    }
    out.push({ label: part, path: cur });
  }
  return out;
}
