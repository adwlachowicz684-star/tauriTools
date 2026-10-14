/**
 * 常用文件夹：整表替换的三处写入守卫 测试
 * ============================================================
 * 后端 `fpx_save_fav_dirs` 是**整表替换**，不是单条增删改。于是：
 *
 *   ① 整表没读出来时写一条 → 写回去的只有这一条 → 其余收藏全部消失，
 *      而写入本身成功，界面显示成"加好了"，一句报错都没有。
 *   ② 已有 40 条（FAV_MAX）时再收藏一条 → normalizeFavs 静默截到第 40 条，
 *      新那条没落盘，界面立刻显示「★ 已收藏」，重开一次就没了。
 *
 * 加收藏有三个入口（选择器「☆ 收藏此目录」、设置页无构建版「＋ 加入」、
 * 设置页 React 版「收藏」），判据必须同一份 —— 各写一份时，
 * folder-picker 那处漏了上限，就是上面 ② 那个样子。
 *
 * 运行：node fav-dirs-guard-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripCommentsJs } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const SRC = {
  fav: read('js/fav-dirs.js'),
  picker: read('plugins/folder-picker/module.js'),
  setApp: read('plugins/settings/index.js'),
  card: read('plugins/settings/FavDirsCard.tsx'),
};

/*
 * 剥注释改用共用模块（test-scan-utils.mjs 的 stripCommentsJs）。
 *
 * 本文件原先内联了一份：它用**裸的 `//` 判据**（两个斜杠直到行尾），
 * 遇到 `https://`、`file://` 会把整行后半截吞掉 ——
 * 那时断言其实在检查一段被截断的文本，可能假绿。
 * 共用模块用的是 `(^|\s)//`，行首 / 行尾 / 缩进后三种真注释形态都覆盖，
 * 同时不吃 URL。语义与原来一致，且更安全。
 */
const code = (k) => stripCommentsJs(SRC[k]);

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

/** 从锚点起按大括号配平切出函数源码。 */
function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const start = src.indexOf('{', i + anchor.length - 1);
  if (start < 0) return '';
  let d = 0;
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return '';
}

/* ============================================================
 * 第 1 节：判据跑真身（加载 js/fav-dirs.js）
 * ============================================================ */
const F = await import(join(ROOT, 'js/fav-dirs.js'));

t('判据：空路径被拦（有原因）', F.favAddBlocker([], '') === '没有可收藏的目录');
t('判据：已收藏（原样）被拦', F.favAddBlocker([{ path: '/a' }], '/a') === '这个目录已经在常用里了');
t('判据：已收藏（尾部斜杠）也算同一条 ★', F.favAddBlocker([{ path: '/a' }], '/a/') === '这个目录已经在常用里了');
t('判据：已收藏（大小写不同）也算同一条 ★', F.favAddBlocker([{ path: '/Work' }], '/work') === '这个目录已经在常用里了');

const at40 = Array.from({ length: 40 }, (_, i) => ({ path: `/d${i}` }));
const at39 = Array.from({ length: 39 }, (_, i) => ({ path: `/d${i}` }));
t('判据：满 40 条被拦（上限）★★', F.favAddBlocker(at40, '/new') === '常用文件夹最多 40 个');
t('判据：39 条可加', F.favAddBlocker(at39, '/new') === '');
t('判据：FAV_MAX 与常量同源', String(F.FAV_MAX) === '40' && F.favAddBlocker(at40, '/x').includes(String(F.FAV_MAX)));

/*
 * 行为证据：满 40 条时把新那条 push 进去再 normalizeFavs，
 * 结果仍是 40 条且**不含**新的那条 —— 这正是修复前 folder-picker
 * "界面显示已收藏、磁盘上没有"的成因。
 */
const dropped = F.normalizeFavs([...at40, { path: '/new' }]);
t('行为证据：第 41 条被静默截掉 ★★',
  dropped.length === 40 && !dropped.some((f) => f.path === '/new'));

t('归一化：尾部斜杠去重', F.normalizeFavs([{ path: '/a' }, { path: '/a/' }]).length === 1);
t('归一化：大小写去重', F.normalizeFavs([{ path: '/A' }, { path: '/a' }]).length === 1);
t('归一化：超过上限截断', F.normalizeFavs(Array.from({ length: 45 }, (_, i) => ({ path: `/d${i}` }))).length === F.FAV_MAX);

/* ============================================================
 * 第 2 节：folder-picker 的 addFav 跑真身
 * ============================================================ */
const pickerSrc = code('picker');
const addFavSrc = sliceFn(pickerSrc, 'async function addFav(');
t('（前置）addFav 段切得到', addFavSrc.includes('async function addFav(') && addFavSrc.includes('favs.push'));

let addFav = null;
/*
 * addFav 内部读的 favsLoaded 是闭包变量，这里换成 st.favsLoaded 才能让它
 * 在"先读一次"之后真的变成 true —— 否则 loadFavs 的成功与否观察不到，
 * 而"写入前先补读整表"恰恰是这一节最想验的东西。
 */
const addFavJs = addFavSrc.replace(/\bfavsLoaded\b/g, 'st.favsLoaded');
try {
  addFav = new Function(
    'normPath', 'favAddBlocker', 'FAV_NOT_LOADED', 'favIndexOf',
    'favs', 'st', 'loadFavs', 'saveFavs', 'setErr', 'render',
    `return ${addFavJs};`,
  )(F.normPath, F.favAddBlocker, F.FAV_NOT_LOADED, F.favIndexOf,
    [], { favsLoaded: false }, async () => {}, async () => true, () => {}, () => {});
} catch (e) {
  t(`（前置）addFav 可执行：${e?.message ?? e}`, false);
}

if (addFav) {
  /** loadOk=null 表示不从这里补读；remote 是"磁盘上已有的收藏"。 */
  const mk = (favs, loaded, opts = {}) => {
    const errs = [];
    const list = favs.slice();
    const st = { favsLoaded: loaded };
    const fn = new Function(
      'normPath', 'favAddBlocker', 'FAV_NOT_LOADED', 'favIndexOf',
      'favs', 'st', 'loadFavs', 'saveFavs', 'setErr', 'render',
      `return ${addFavJs};`,
    )(F.normPath, F.favAddBlocker, F.FAV_NOT_LOADED, F.favIndexOf,
      list, st,
      async () => {
        if (!opts.loadOk) return;               // 读失败：favsLoaded 保持 false
        list.length = 0;
        for (const f of (opts.remote ?? [])) list.push(f);
        st.favsLoaded = true;
      },
      async () => opts.ok !== false,
      (m) => errs.push(String(m)), () => {});
    return { fn, list, errs, st };
  };

  const a = mk([], false, { loadOk: false });
  await a.fn('/x', '');
  t('folder-picker：整表读不出来时不写 ★★', a.list.length === 0);
  t('folder-picker：整表读不出来时说了原因 ★★', a.errs.some((m) => m.includes('还没读出来')));

  /*
   * 写入前先补读整表：磁盘上原有 2 条，补读后新那条是**追加**而不是替换。
   * 少了补读（或补读失败仍继续写）就是拿 1 条替换掉全部 —— list 会只剩新那条。
   */
  const e2 = mk([], false, { loadOk: true, remote: [{ path: '/r1' }, { path: '/r2' }] });
  await e2.fn('/x', '');
  t('folder-picker：整表没读过就先补读，不拿新那条替换全部 ★★',
    e2.list.length === 3 && e2.list.some((f) => f.path === '/r1'),
    `实际 ${JSON.stringify(e2.list.map((f) => f.path))}`);

  const b = mk(at40, true);
  await b.fn('/new', '');
  t('folder-picker：满 40 条时不写 ★★', b.list.length === 40 && !b.list.some((f) => f.path === '/new'));
  t('folder-picker：满 40 条时说了上限 ★', b.errs.some((m) => m.includes('最多')));

  const c = mk([{ path: '/a' }], true);
  await c.fn('/a', '');
  t('folder-picker：重复收藏不写', c.list.length === 1);
  t('folder-picker：重复收藏不报红（按钮本就是禁用态）', !c.errs.length);

  const d = mk([], true, { ok: false });
  await d.fn('/x', '');
  t('folder-picker：保存失败仍回滚（不留没落盘的条目）', d.list.length === 0);
}

/* ============================================================
 * 第 3 节：设置页无构建版的 add 跑真身
 * ============================================================ */
const setSrc = code('setApp');
const addSrc = sliceFn(setSrc, 'const add = async (raw) => {');
t('（前置）设置页 add 段切得到', addSrc.includes('const add = async (raw)') && addSrc.includes('favs.concat'));

if (addSrc) {
  const mk = (favs, loaded, ok = true) => {
    const toasts = [];
    const saved = [];
    const list = favs.slice();
    const draftInput = { value: 'dirty' };
    const fn = new Function(
      'normPath', 'favAddBlocker', 'FAV_NOT_LOADED', 'favs', 'favsLoaded', 'busy',
      'save', 'ctx', 'draftInput',
      `return ${addSrc.replace('const add = async', 'async')};`,
    )(F.normPath, F.favAddBlocker, F.FAV_NOT_LOADED, list, loaded, false,
      async (next) => { saved.push(next.slice()); return ok; },
      { toast: (m, k) => toasts.push(`${k}:${m}`) }, draftInput);
    return { fn, saved, toasts, draftInput };
  };

  const a = mk([], false);
  await a.fn('/x');
  t('设置页：整表没读出来时不写 ★★', a.saved.length === 0);
  t('设置页：整表没读出来时说了原因 ★★', a.toasts.some((m) => m.includes('还没读出来')));

  const b = mk(at40, true);
  await b.fn('/new');
  t('设置页：满 40 条时不写 ★★', b.saved.length === 0);
  t('设置页：满 40 条时说了上限', b.toasts.some((m) => m.includes('最多')));

  const c = mk([{ path: '/a' }], true);
  await c.fn('/a');
  t('设置页：重复收藏不写且提示', c.saved.length === 0 && c.toasts.some((m) => m.includes('已经在常用里了')));

  const d = mk([{ path: '/a' }], true);
  await d.fn('/b');
  t('设置页：正常加入仍写整表（含原有那条）★', d.saved.length === 1 && d.saved[0].length === 2);
  t('设置页：成功后清空输入框', d.draftInput.value === '');
}

/* ============================================================
 * 第 4 节：React 版设置页（同一套判据 + 按钮禁用）
 * ============================================================ */
const cardCode = code('card');
const cardAdd = sliceFn(cardCode, 'const add = useCallback(async (raw: string) => {');
t('（前置）React 版 add 段切得到', cardAdd.includes('const add = useCallback'));
t('React 版：整表没读出来（favs === null）时不写 ★★',
  cardAdd.includes('if (!favs)') && cardAdd.includes('FAV_NOT_LOADED'));
t('React 版：走同一份 favAddBlocker', cardAdd.includes('favAddBlocker'));
t('React 版：「收藏」「浏览…」在整表未知时禁用 ★',
  cardCode.includes('disabled={busy || favs === null || !normPath(draft)}')
  && cardCode.includes('disabled={busy || favs === null}'));

const bothUseBlocker = code('setApp').includes('favAddBlocker') && cardCode.includes('favAddBlocker');
const pickerUsesBlocker = pickerSrc.includes('favAddBlocker');
t('统一性：三个入口都用同一份判据 ★', bothUseBlocker && pickerUsesBlocker);
t('统一性：三处都判"整表有没有读出来" ★',
  pickerSrc.includes('favsLoaded') && code('setApp').includes('favsLoaded') && cardCode.includes('favs === null'));

/* 两版设置页 refresh 都必须走 normalizeFavs，否则同一份配置条数不同 */
t('统一性：无构建版 refresh 走 normalizeFavs（去重）★', code('setApp').includes('favs = normalizeFavs(list)'));
t('统一性：React 版 refresh 走 normalizeFavs（去重）★', cardCode.includes('setFavs(normalizeFavs(list))'));

/* ============================================================
 * 第 5 节：守卫本身没被写成恒真
 * ============================================================ */
const cnt = (src, re) => (src.match(re) || []).length;
t('自检：folder-picker 的 favsLoaded 成功处置 true、失败处置 false',
  cnt(pickerSrc, /favsLoaded = true/g) === 1 && cnt(pickerSrc, /favsLoaded = false/g) === 2);
t('自检：设置页的 favsLoaded 成功处置 true、失败处置 false',
  cnt(code('setApp'), /favsLoaded = true/g) === 1 && cnt(code('setApp'), /favsLoaded = false/g) === 2);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
