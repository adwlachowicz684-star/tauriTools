/**
 * 统一目录选择（folder-picker）+ 工具常用文件夹 测试
 * ============================================================
 * 四类断言：
 *   ① 注册契约 —— registry 条目的四个字段一个都不能少。
 *      这类错了**不报错**：服务静默调不到，
 *      表现是所有「浏览」按钮点了没反应。
 *   ② 后端契约 —— fpx_list_fav_dirs / fpx_save_fav_dirs
 *      必须"定义了**且**注册了"。只定义不注册 = 命令不存在；
 *      只注册不定义 = **编译不过**（本项目已经踩过两次）。
 *   ③ 纯函数行为 —— 真跑 js/fav-dirs.js，验证归一化 / 去重 / 上限 /
 *      面包屑。只查"源码里写了 normalizeFavs"会放过
 *      "写了但没被调用"这类错。
 *   ④ 统一性 —— 两套选择器都必须委托到服务，且都保留降级。
 *      少了委托 = 又回到两套实现；少了降级 = 服务一丢整个功能没了。
 *
 * 运行：node folder-picker-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

const reg = read('plugins/registry.js');
const mod = read('plugins/folder-picker/module.js');
const favs = read('js/fav-dirs.js');
const modRs = read('src-tauri/src/fpx/mod.rs');
const modelRs = read('src-tauri/src/fpx/model.rs');
const mainRs = read('src-tauri/src/main.rs');
const caps = read('js/command-caps.js');
const css = read('css/neumorphism.css');
const setApp = read('plugins/settings/App.tsx');
const card = read('plugins/settings/FavDirsCard.tsx');
const dirDialog = read('plugins/project-group/components/DirDialog.tsx');
const dirPicker = read('plugins/agent-flow/components/DirPicker.tsx');

/**
 * 精确切出 registry 里 folder-picker 那一条。
 *
 * 【为什么不能直接用 /folder-picker[\s\S]*?}/ 】
 * registry 的注释里也提到 folder-picker（说明为什么内置），
 * 那条注释在真实条目**之前**，正则会先匹配到它，
 * 于是扫出一段纯注释然后报告"一切正常" ——
 * 表现是"说通过了，其实压根没检查"（本项目踩过同款假绿）。
 */
function entryOf(id) {
  const i = reg.indexOf(`id: '${id}'`);
  if (i < 0) return '';
  // 往前找该条目的起点（上一个 `},\n  {` 或数组开头）
  const head = reg.lastIndexOf('{', i);
  // 往后找到与该 `{` 配对的 `}`（registry 条目里没有嵌套对象字面量的花括号）
  let depth = 0;
  for (let k = head; k < reg.length; k++) {
    if (reg[k] === '{') depth++;
    else if (reg[k] === '}') { depth--; if (depth === 0) return reg.slice(head, k + 1); }
  }
  return '';
}
const entry = entryOf('folder-picker');

console.log('\n【一】注册契约');
t('registry 里有 folder-picker 条目', entry.length > 0);
t('kind 是 service（做成 app 会在侧边栏多一个永远不点的入口）', /kind:\s*'service'/.test(entry));
/*
 * interactive 最关键：不标的话宿主不会把容器浮出来，
 * pick 的 Promise 永远悬着 —— 既不报错也不返回，
 * 界面上就是「浏览」按钮点了没反应。
 */
t('interactive:true（不标则浮层不显示，Promise 永远悬着）', /interactive:\s*true/.test(entry));
t('type 是 module（与宿主同文档，.fp-* 样式天然生效）', /type:\s*'module'/.test(entry));
t('builtin:true（能列任意目录，不能给第三方插件）', /builtin:\s*true/.test(entry));
t('entry 指向 module.js', /entry:\s*'\.\/plugins\/folder-picker\/module\.js'/.test(entry));

console.log('\n【二】后端契约');
t('mod.rs 定义了 fpx_list_fav_dirs', /pub fn fpx_list_fav_dirs\s*\(/.test(modRs));
t('mod.rs 定义了 fpx_save_fav_dirs', /pub fn fpx_save_fav_dirs\s*\(/.test(modRs));
/*
 * 只定义不注册 = 前端调不到（command not found，且不报错）；
 * 只注册不定义 = 编译不过。两边都要钉。
 */
t('main.rs 注册了 fpx_list_fav_dirs', /fpx::fpx_list_fav_dirs/.test(mainRs));
t('main.rs 注册了 fpx_save_fav_dirs', /fpx::fpx_save_fav_dirs/.test(mainRs));
t('model.rs 有 FavDir 结构', /pub struct FavDir/.test(modelRs));
t('FavDir 有 path 字段', /pub path:\s*String/.test(modelRs));
t('FavDir 有 label 字段（昵称）', /pub label:\s*Option<String>/.test(modelRs));
t('Config 里有 fav_dirs', /pub fav_dirs:\s*Vec<FavDir>/.test(modelRs));
t('能力表登记 fpx_list_fav_dirs', /fpx_list_fav_dirs:\s*'R'/.test(caps));
t('能力表登记 fpx_save_fav_dirs（写，不是读）', /fpx_save_fav_dirs:\s*'W'/.test(caps));
t('后端有收藏上限常量', /FAV_DIR_MAX/.test(modRs));

console.log('\n【三】纯函数行为（真跑 js/fav-dirs.js）');
const F = await import('./js/fav-dirs.js');
t('导出 FAV_MAX', typeof F.FAV_MAX === 'number');
t('normPath 去尾部斜杠', F.normPath('D:/work/') === 'D:/work');
t('normPath 反斜杠归一为正斜杠', F.normPath('D:\\work\\a') === 'D:/work/a');
t('normPath 保留根斜杠（"/" 去尾会变空串，回不到根）', F.normPath('/') === '/');
t('normalizeFavs 去重（大小写不敏感）',
  F.normalizeFavs([{ path: 'D:/a' }, { path: 'd:/A' }]).length === 1);
t('normalizeFavs 去尾部斜杠后判重',
  F.normalizeFavs([{ path: 'D:/a' }, { path: 'D:/a/' }]).length === 1);
t('normalizeFavs 去空', F.normalizeFavs([{ path: '   ' }, { path: '' }]).length === 0);
t('normalizeFavs 保持顺序',
  JSON.stringify(F.normalizeFavs([{ path: '/b' }, { path: '/a' }]).map((x) => x.path)) === '["/b","/a"]');
t('normalizeFavs 截断到上限',
  F.normalizeFavs(Array.from({ length: F.FAV_MAX + 10 }, (_, i) => ({ path: `/p${i}` }))).length === F.FAV_MAX);
t('favLabel 有昵称用昵称', F.favLabel({ path: '/x/y', label: '项目' }) === '项目');
t('favLabel 无昵称取最后一段', F.favLabel({ path: '/x/y', label: '' }) === 'y');
t('favLabel 容错空对象', F.favLabel({}) === '' && F.favLabel(null) === '');
t('isFav 命中（忽略尾部斜杠与大小写）', F.isFav([{ path: '/a/b' }], '/A/B/') === true);
t('isFav 不命中', F.isFav([{ path: '/a/b' }], '/a/c') === false);
t('favIndexOf 返回正确下标', F.favIndexOf([{ path: '/a' }, { path: '/b' }], '/B') === 1);
const cr = F.crumbsOf('C:/Users/me');
t('面包屑 Windows 盘符补成 C:/', cr[0]?.path === 'C:/');
t('面包屑逐级拼接', cr[1]?.path === 'C:/Users' && cr[2]?.path === 'C:/Users/me');
t('面包屑空路径返回空', F.crumbsOf('').length === 0);
/*
 * 盘符那段收尾是 C:/，再拼一个斜杠就成 C://Users。
 * Windows 上点这种回退会失败，且不报错 —— 只是"点了没反应"。
 */
t('面包屑不出现双斜杠', !F.crumbsOf('C:/Users/me').some((c) => c.path.includes('//')));

console.log('\n【四】共用同一份实现（不是各写一份）');
/*
 * 两处各写一份归一化，迟早在某处漏掉"去尾部斜杠"，
 * 于是同一个目录被判成两条收藏：界面上两个一模一样的条目，
 * 删掉一个另一个还在，且不报错。
 */
t('folder-picker 从 js/fav-dirs.js 引入', /from '\.\.\/\.\.\/js\/fav-dirs\.js'/.test(mod));
t('folder-picker 不再自带 normPath 实现', !/export function normPath\s*\(/.test(mod));
t('设置页卡片也从同一份引入', /from '\.\.\/\.\.\/js\/fav-dirs\.js'/.test(card));
t('folder-picker re-export 既有名字（兼容老 import）',
  /export \{[^}]*normPath[^}]*normalizeFavs[^}]*favLabel/.test(mod));

console.log('\n【五】选择器统一（两套都必须委托 + 都留降级）');
for (const [label, src] of [['project-group/DirDialog', dirDialog], ['agent-flow/DirPicker', dirPicker]]) {
  t(`${label} 调 folder-picker 服务`, /services\s*\n?\s*\.call\('folder-picker',\s*'pick'/.test(src)
    || /\.call\('folder-picker',\s*'pick'/.test(src));
  t(`${label} 委托时不渲染自己的界面`, /if \(fallback === null\) return null;/.test(src));
  /*
   * 降级不是可选项：服务条目一旦被同步覆盖掉，
   * 没有兜底就是所有选目录入口同时失灵。
   */
  t(`${label} 保留降级（服务调不通退回内置实现）`, /setFallback\(/.test(src));
  t(`${label} 降级时显示原因（否则用户只看到"怎么变旧了"）`, /fallback \?/.test(src));
}

console.log('\n【六】设置页「常用文件夹」页签');
t('TabKey 含 favdirs', /'favdirs'/.test(setApp));
t('页签列表里注册了它', /\['favdirs',\s*'常用文件夹'\]/.test(setApp));
t('渲染 FavDirsCard', /tab === 'favdirs' \? <FavDirsCard/.test(setApp));
t('导入 FavDirsCard', /import FavDirsCard from '\.\/FavDirsCard'/.test(setApp));
t('卡片读 fpx_list_fav_dirs', /fpx_list_fav_dirs/.test(card));
t('卡片写 fpx_save_fav_dirs', /fpx_save_fav_dirs/.test(card));
t('卡片能改名', /commitName/.test(card) && /fpx_save_fav_dirs/.test(card));
t('卡片能删除', /remove\b/.test(card));
t('卡片有浏览（调服务，不用手工粘贴路径）', /call\('folder-picker',\s*'pick'/.test(card));
t('浏览失败明确提示（否则点了像死键）', /打开目录选择器失败/.test(card));
t('写完重新拉取（不重拉则界面与磁盘不一致且不报错）', /await refresh\(\);/.test(card));

console.log('\n【七】样式写在宿主主样式表');
/*
 * 服务是 module，但被弹成浮层显示；
 * 插件自己的 style.css 在某些加载路径下不引入，
 * 那时弹出来就是"只有文字"（demo-iframe 踩过的同款坑）。
 */
t('.fp-panel 写在 neumorphism.css', /\.fp-panel\s*\{/.test(css));
t('不在 folder-picker 插件目录里另起样式表',
  !/plugins\/folder-picker\/.*\.css/.test(mod));

console.log('\n【八】服务方法契约');
t('pick 在方法表里', /pick\(args/.test(mod));
t('listFavs / addFav / removeFav 齐备',
  /listFavs\(/.test(mod) && /addFav\(/.test(mod) && /removeFav\(/.test(mod));
/*
 * 返回类型固定为 { path, action }，不能随入参变化 ——
 * 调用方今天按字符串写，明天谁加个 extraAction 就静默错到底。
 */
t('返回值固定 { path, action }', /res\(\{ path:[^}]*action:/.test(mod));
t('取消不 reject（否则每个调用方都得写 try/catch）',
  /取消\*\*不 reject\*\*/.test(mod) && /res\(\{ path: null, action: null \}\)/.test(mod));
t('点遮罩有退路（否则 Promise 永远悬着）', /watchHidden/.test(mod));
t('Esc 有退路', /Escape'\) cancel\(\)/.test(mod));
t('未挂上时抛错而不是静默返回 null', /服务尚未挂载/.test(mod));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
