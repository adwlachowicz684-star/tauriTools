/**
 * 预设图标库（A3–A10）
 * ============================================================
 * 对应 WPF `PresetIconService`（src/Services/PresetIconService.cs），
 * 提供「点选即把图标设为节点图片」的资产体系。
 *
 * 与 C# 版的**刻意差异**：
 *
 * 1. **图标用 SVG path 而不是 .ico 文件。**
 *    C# 存的是磁盘上的 `preseticons/<显示名>.ico`，还要 `IconConversion`
 *    做多尺寸转换（A10）。Web 端没有 .ico 编码的必要：SVG 天然无损缩放，
 *    且能直接当 URL 用。故**不实现 ico 转换**，A10 按不适用处理。
 *
 * 2. **内置图标不进持久化。**
 *    只有用户自建分组与上传的图标落 IndexedDB。内置集合每次从代码生成后
 *    合并进去 —— 否则将来新增内置图标，老用户永远看不到（他们库里已经
 *    「存过」一份旧集合了）。
 *
 * 3. **用户图标存 IndexedDB，节点里存 dataURL。**
 *    图标本体在 IndexedDB（不重复占存储）；应用到节点时读出并转成 dataURL
 *    内联进脑图，与现有「浏览图片」路径一致（image 命令只认 URL）。
 *    代价是脑图文件会变大，与 README 已记录的行为口径相同。
 */

import * as store from './store.js';

const K_ICONLIB = 'iconlib';

/* ------------------------------------------------------------
   内置图标集合
   ------------------------------------------------------------
   24×24 viewBox，stroke 风格（fill:none + stroke）。
   不用 emoji：emoji 渲染依赖系统字体，换设备可能变豆腐块，
   而图标是要进导出文件的。 */
const BUILTIN_GROUPS = [
  {
    id: 'b-status',
    name: '状态',
    icons: [
      { id: 'check', name: '完成', d: 'M5 13l4 4L19 7' },
      { id: 'x', name: '取消', d: 'M6 6l12 12M18 6L6 18' },
      { id: 'alert', name: '警告', d: 'M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' },
      { id: 'question', name: '疑问', d: 'M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01' },
      { id: 'clock', name: '时间', d: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2' },
    ],
  },
  {
    id: 'b-mark',
    name: '标记',
    icons: [
      { id: 'star', name: '星标', d: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' },
      { id: 'heart', name: '心形', d: 'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l8.84 8.84 8.84-8.84a5.5 5.5 0 000-7.78z' },
      { id: 'flag', name: '旗帜', d: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7' },
      { id: 'bookmark', name: '书签', d: 'M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z' },
      { id: 'tag', name: '标签', d: 'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01' },
    ],
  },
  {
    id: 'b-dir',
    name: '方向',
    icons: [
      { id: 'up', name: '上', d: 'M12 19V5M5 12l7-7 7 7' },
      { id: 'down', name: '下', d: 'M12 5v14M19 12l-7 7-7-7' },
      { id: 'left', name: '左', d: 'M19 12H5M12 19l-7-7 7-7' },
      { id: 'right', name: '右', d: 'M5 12h14M12 5l7 7-7 7' },
    ],
  },
  {
    id: 'b-shape',
    name: '形状',
    icons: [
      { id: 'circle', name: '圆形', d: 'M12 21a9 9 0 100-18 9 9 0 000 18z' },
      { id: 'square', name: '方形', d: 'M5 5h14v14H5z' },
      { id: 'triangle', name: '三角', d: 'M12 3l9 16H3z' },
      { id: 'diamond', name: '菱形', d: 'M12 2l10 10-10 10L2 12z' },
    ],
  },
  {
    id: 'b-obj',
    name: '物件',
    icons: [
      { id: 'bulb', name: '想法', d: 'M9 21h6M10 18h4M12 3a6 6 0 00-3 11v4h6v-4a6 6 0 00-3-11z' },
      { id: 'lock', name: '锁定', d: 'M7 11V7a5 5 0 0110 0v4M5 11h14v10H5z' },
      { id: 'gear', name: '设置', d: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 003.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 008 4.6h.09A1.65 1.65 0 009.6 3.09V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 8v.09a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z' },
      { id: 'eye', name: '查看', d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 100-6 3 3 0 000 6z' },
      { id: 'pin', name: '图钉', d: 'M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z' },
    ],
  },
];

/**
 * 内置图标 → SVG dataURL（供 image 命令使用；image 只认 URL，不认 path）
 *
 * 默认色必须是**具体色值**，不能用 `currentColor`：
 * SVG 当 `<img>` 加载时是独立文档，没有继承上下文，`currentColor` 会解析成
 * 黑色 —— 在深色画布上就是一块看不见的黑块（与之前附件图标踩过的坑同类）。
 * 宁可让默认值安全，也不要考验每个调用方记不记得传色。
 */
export function builtinIconUrl(d, color = '#5A8FD6', size = 24) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* ------------------------------------------------------------
   库结构
   ------------------------------------------------------------ */

function builtinGroups() {
  return BUILTIN_GROUPS.map((g) => ({
    id: g.id,
    name: g.name,
    builtin: true,
    icons: g.icons.map((i) => ({ id: i.id, name: i.name, kind: 'builtin', d: i.d })),
  }));
}

/**
 * 读取完整图标库：内置分组 + 用户分组。
 * 内置分组**始终排在最前**，用户分组保持自己存下来的顺序。
 */
export async function loadLibrary() {
  const user = (await store.get(K_ICONLIB, null)) || { groups: [] };
  const ug = Array.isArray(user.groups) ? user.groups : [];
  return [...builtinGroups(), ...ug.map((g) => ({ ...g, builtin: false }))];
}

/** 只持久化用户分组（内置不落盘，见文件头说明） */
async function saveUserGroups(groups) {
  const user = groups.filter((g) => !g.builtin).map((g) => ({
    id: g.id, name: g.name, icons: g.icons || [],
  }));
  return store.set(K_ICONLIB, { groups: user });
}

const newId = (p) => p + Math.random().toString(36).slice(2, 10);

/* ------------------------------------------------------------
   分组管理（A3 / A7）
   ------------------------------------------------------------ */

/** 分组名唯一化：重名自动加序号（对齐 WPF `UniqueGroupName`） */
function uniqueGroupName(groups, name) {
  const base = String(name || '').trim() || '新分组';
  const exists = new Set(groups.map((g) => g.name));
  if (!exists.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`;
    if (!exists.has(n)) return n;
  }
}

/** 校验分组名。返回错误文案，合法则返回 null（对齐 WPF `ValidateGroupName`） */
export function validateGroupName(groups, name) {
  const n = String(name || '').trim();
  if (!n) return '分组名不能为空。';
  if (groups.some((g) => g.name === n)) return `分组「${n}」已存在。`;
  return null;
}

export async function addGroup(name) {
  const groups = await loadLibrary();
  const g = { id: newId('g'), name: uniqueGroupName(groups, name), icons: [] };
  groups.push(g);
  return (await saveUserGroups(groups)) ? g : null;
}

export async function renameGroup(id, name) {
  const groups = await loadLibrary();
  const i = groups.findIndex((g) => g.id === id);
  if (i < 0) return { ok: false, error: '分组不存在。' };
  if (groups[i].builtin) return { ok: false, error: '内置分组不可重命名。' };
  const err = validateGroupName(groups.filter((g) => g.id !== id), name);
  if (err) return { ok: false, error: err };
  groups[i].name = String(name).trim();
  return { ok: await saveUserGroups(groups) };
}

/**
 * 删除分组：**至少保留一个**（对齐 WPF `DeleteGroup`）。
 * 内置分组不可删。组内用户图标的资产记录一并清掉，否则会留在库里变成孤儿。
 */
export async function deleteGroup(id) {
  const groups = await loadLibrary();
  const i = groups.findIndex((g) => g.id === id);
  if (i < 0) return { ok: false, error: '分组不存在。' };
  if (groups[i].builtin) return { ok: false, error: '内置分组不可删除。' };
  if (groups.length <= 1) return { ok: false, error: '至少保留一个分组。' };
  const removed = groups.splice(i, 1)[0];
  // 清掉该组里的用户图标资产（只清自己组的；内置图标无资产）
  for (const ic of removed.icons || []) {
    if (ic.kind === 'user' && ic.assetId) {
      try { await store.del('asset:' + ic.assetId); } catch (e) { /* 清理失败不拦删除 */ }
    }
  }
  return { ok: await saveUserGroups(groups) };
}

/** 调整分组顺序（对齐 WPF `MoveGroup`） */
export async function moveGroup(fromIdx, toIdx) {
  const groups = await loadLibrary();
  const n = groups.length;
  if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n || fromIdx === toIdx) return false;
  // 内置分组恒在最前，不允许被用户分组挤到后面去
  const item = groups[fromIdx];
  if (item.builtin) return false;
  const firstUser = groups.findIndex((g) => !g.builtin);
  if (toIdx < firstUser) return false;
  groups.splice(fromIdx, 1);
  groups.splice(toIdx, 0, item);
  return saveUserGroups(groups);
}

/* ------------------------------------------------------------
   图标管理（A4 导入 / A6 重命名 / A9 跨组移动）
   ------------------------------------------------------------ */

/**
 * 往分组里加图标。
 * @param {string} groupId
 * @param {{kind:'user', name:string, assetId:string}} icon
 */
export async function addIcon(groupId, icon) {
  const groups = await loadLibrary();
  const g = groups.find((x) => x.id === groupId);
  if (!g) return { ok: false, error: '分组不存在。' };
  if (g.builtin) return { ok: false, error: '内置分组不可添加图标。' };
  g.icons = g.icons || [];
  // 同名自动加序号（对齐 WPF 导入时的重名处理）
  const exists = new Set(g.icons.map((i) => i.name));
  let name = icon.name || '图标';
  for (let i = 2; exists.has(name); i++) name = `${icon.name || '图标'} ${i}`;
  const item = { ...icon, id: newId('i'), name };
  g.icons.push(item);
  return { ok: await saveUserGroups(groups), icon: item };
}

export async function removeIcon(groupId, iconId) {
  const groups = await loadLibrary();
  const g = groups.find((x) => x.id === groupId);
  if (!g) return { ok: false, error: '分组不存在。' };
  const i = (g.icons || []).findIndex((x) => x.id === iconId);
  if (i < 0) return { ok: false, error: '图标不存在。' };
  const [rm] = g.icons.splice(i, 1);
  if (rm?.kind === 'user' && rm.assetId) {
    try { await store.del('asset:' + rm.assetId); } catch (e) { /* 同上 */ }
  }
  return { ok: await saveUserGroups(groups) };
}

/** 重命名图标：同名则加序号（对齐 WPF `RenameIcon` 的冲突处理） */
export async function renameIcon(groupId, iconId, name) {
  const groups = await loadLibrary();
  const g = groups.find((x) => x.id === groupId);
  if (!g) return { ok: false, error: '分组不存在。' };
  const ic = (g.icons || []).find((x) => x.id === iconId);
  if (!ic) return { ok: false, error: '图标不存在。' };
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: '名称不能为空。' };
  const others = new Set((g.icons || []).filter((x) => x.id !== iconId).map((x) => x.name));
  ic.name = others.has(n) ? uniqueGroupName([...others].map((x) => ({ name: x })), n) : n;
  return { ok: await saveUserGroups(groups) };
}

/**
 * 图标跨分组移动（A9）。
 * **内置图标不能移动** —— 它们是代码里的常量，移到别的组后下次加载
 * 仍会被内置集合重新生成回原组，表现为「移动无效」。
 * 要用内置图标当模板，应先复制成用户图标。
 */
export async function moveIcon(fromGroupId, iconId, toGroupId) {
  const groups = await loadLibrary();
  const from = groups.find((x) => x.id === fromGroupId);
  const to = groups.find((x) => x.id === toGroupId);
  if (!from || !to) return { ok: false, error: '分组不存在。' };
  const i = (from.icons || []).findIndex((x) => x.id === iconId);
  if (i < 0) return { ok: false, error: '图标不存在。' };
  const ic = from.icons[i];
  if (ic.kind !== 'user') return { ok: false, error: '内置图标不可移动。' };
  from.icons.splice(i, 1);
  to.icons = to.icons || [];
  to.icons.push(ic);
  return { ok: await saveUserGroups(groups) };
}

/** 把内置图标复制成用户图标（用于「以内置图标为模板」） */
export async function copyBuiltinTo(groupId, icon) {
  if (icon?.kind !== 'builtin') return { ok: false, error: '不是内置图标。' };
  return addIcon(groupId, { kind: 'builtin-copy', name: icon.name, d: icon.d });
}

/* ------------------------------------------------------------
   A18 失效图标清理（对齐 WPF `PresetIconService.PruneMissing`）
   ------------------------------------------------------------ */

/**
 * 挑出失效图标（纯函数，可测）。
 *
 * C# 版判断的是「磁盘文件还在不在」（`File.Exists`）；
 * Web 版没有磁盘文件，等价物是 **IndexedDB 里的资产记录** ——
 * 图标条目还在、但资产读不出来，就是失效。
 * 典型场景：清过浏览器数据、从别的设备导入配置、资产写入半途失败。
 *
 * @param {Array} icons 图标条目
 * @param {Set<string>} live 仍然存在的 assetId 集合
 * @returns {{keep:Array, drop:Array}}
 */
export function partitionMissing(icons = [], live = new Set()) {
  const keep = [];
  const drop = [];
  for (const ic of icons || []) {
    // 只有用户图标依赖资产；内置与内置副本的 path 在代码里，不会失效
    if (ic?.kind === 'user' && ic.assetId && !live.has(ic.assetId)) drop.push(ic);
    else keep.push(ic);
  }
  return { keep, drop };
}

/**
 * 清理各分组里资产已消失的用户图标，并落盘。
 *
 * 为什么要做：失效图标在界面上是**一块空白**（图片加载不出来），
 * 和之前踩过的「深色界面上纯黑 = 看不见」是同一类问题 ——
 * 用户只看到一堆占位，不知道是图标坏了还是加载慢。
 *
 * @returns {Promise<{removed:number, groups:number}>} 清掉了多少个、涉及几组
 */
export async function pruneMissing() {
  const groups = await loadLibrary();
  let removed = 0;
  let touched = 0;

  // 先把所有 assetId 一次性查出来再批量判定：
  // 逐个 await 判定会让「读库」与「改库」交错，逻辑更绕也更难测。
  const ids = new Set();
  for (const g of groups) {
    for (const ic of g.icons || []) {
      if (ic?.kind === 'user' && ic.assetId) ids.add(ic.assetId);
    }
  }
  const live = new Set();
  for (const id of ids) {
    const rec = await store.get('asset:' + id, null);
    if (rec?.blob) live.add(id);
  }

  for (const g of groups) {
    if (g.builtin) continue;   // 内置分组由代码生成，改了下次加载会被覆盖回去
    const { keep, drop } = partitionMissing(g.icons, live);
    if (!drop.length) continue;
    g.icons = keep;
    removed += drop.length;
    touched++;
  }

  if (removed > 0) await saveUserGroups(groups);
  return { removed, groups: touched };
}

/* ------------------------------------------------------------
   图标 → 可显示内容
   ------------------------------------------------------------ */

/**
 * 取图标的显示用 dataURL。
 * @returns {Promise<string|null>} 失败返回 null（调用方要据此提示）
 */
export async function iconToDataUrl(icon, size = 32) {
  if (!icon) return null;
  if (icon.kind === 'builtin-copy' || icon.kind === 'builtin') {
    return builtinIconUrl(icon.d, '#5A8FD6', size);
  }
  if (icon.kind === 'user' && icon.assetId) {
    const rec = await store.get('asset:' + icon.assetId, null);
    if (!rec?.blob) return null;
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => res(null);
      fr.readAsDataURL(rec.blob);
    });
  }
  return null;
}

/** 小尺寸预览用的 dataURL（网格里显示，不进节点） */
export function iconPreviewUrl(icon) {
  if (!icon) return null;
  if (icon.kind === 'builtin' || icon.kind === 'builtin-copy') {
    return builtinIconUrl(icon.d, '#AEB6C4', 24);
  }
  return null;   // 用户图标交给调用方用 assetId 异步取
}
