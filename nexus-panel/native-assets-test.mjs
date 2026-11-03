/**
 * 原生静态资源必须在构建产物里存在（N62）
 * ============================================================
 * 起因：一个**实测发现的真 bug**
 *
 *   dist 里 .ico 数量 = 0
 *   而产物 JS 里仍保留着 `./preseticons/${encodeURIComponent(t)}.ico`
 *
 * 也就是说：Vite 生产构建后，122 个预设图标**全部 404**。
 * 表现为界面上图标位一片空白（<img> 走了 error 分支被隐藏），
 * 不报错、不崩溃 —— 正是最难发现的那一类问题。
 *
 * 为什么 Vite 不会自动处理
 * ------------------------------------------------------------
 * Vite 只处理**静态可分析**的 asset 引用：
 *
 *   import url from './a.png'        ✅ 会被处理
 *   <img src="./a.png">              ✅ 会被处理（模板编译期可分析）
 *   <img :src="`./x/${n}.ico`">      ❌ **动态拼接，分析不了**
 *
 * preseticons 正是第三种：`presetIconUrl(name)` 用模板字符串拼路径，
 * 122 个图标也不可能逐个静态列举。于是 Vite 什么都不会做。
 *
 * 无构建模式下**不受影响** —— 那时源码直出，preseticons 就在原位。
 * 所以这个 bug 只在 Vite 生产构建（也就是 Tauri 打包后的正式版）出现。
 *
 * 解法
 * ------------------------------------------------------------
 * `NATIVE_SUBDIRS` 就是为这种"不能交给 Vite 处理的原生子目录"准备的
 * （原本只有 mindmap/editor，加 project-group/preseticons）——
 * 复用现成机制，不用新建 public 目录。
 *
 * 运行时加载改造后它的家在 **scripts/build-plugins.mjs**（iframe 插件
 * 独立构建到 runtime-plugins/<id>/），拷贝目标从 dist/plugins/ 变成
 * runtime-plugins/，机制与判据不变。
 *
 * ⚠ 形态已变（第一百八十四轮）：目标是**每个插件一个独立仓库、独立安装**。
 *   原先 icon-picker 以 `../project-group/preseticons/` 跨插件引用，
 *   一份拷贝同时服务两个插件；只装 icon-picker 时立刻 404，
 *   且构建期不响（字符串常量 Vite 不解析），只表现为图标空白。
 *   现在 icon-picker **自带一份**，NATIVE_SUBDIRS 因此有两条 preseticons。
 *
 *   两份必须一致 —— 由 cross-plugin-coupling-test.mjs 第 ⑤ 节逐字节守着。
 *   本测试则钉住"各自解析到自己的目录"这个独立安装的前提。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsFlat } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); }
};

/* NATIVE_SUBDIRS 已随插件独立构建迁到 build-plugins.mjs */
const buildPlugins = src('scripts/build-plugins.mjs');
const iconPicker = src('plugins/icon-picker/index.js');
const presetIcons = src('plugins/project-group/presetIcons.ts');

console.log('=== 1. 事实：两处引用都是动态拼接（Vite 分析不了）===');
t('project-group 用模板字符串拼图标 URL',
  /`\.\/preseticons\/\$\{encodeURIComponent\(name\)\}\.ico`/.test(presetIcons));
t('icon-picker 同样用模板字符串',
  /`\$\{ICON_DIR\}\$\{encodeURIComponent\(name\)\}\.ico`/.test(iconPicker));
t('icon-picker 自带 preseticons 目录（不再跨插件引用）',
  /const ICON_DIR = '\.\/preseticons\/'/.test(iconPicker));
/* ⛔ 反向断言：旧写法绝不能回来。
   少了这条，把 ICON_DIR 改回 ../project-group/ 只会让上面那条红，
   但红得含糊（可能被误读成"正则写错了"）；这里明确点名禁用的旧路径。 */
t('icon-picker 源码里不再出现 ../project-group/preseticons/',
  !/\.\.\/project-group\/preseticons\//.test(stripCommentsFlat(iconPicker)));
/*
 * 动态拼接是根因 —— 只要它是动态的，Vite 就永远处理不了，
 * 也就意味着**将来改这个 URL 的写法时，拷贝规则不能删**。
 * 钉住这一点，是因为有人可能"优化"成静态写法后顺手删掉拷贝规则，
 * 而那时还有别的地方在动态引用。
 */
t('两处都确认是动态（不是可静态分析的常量）',
  /\$\{/.test(presetIcons.match(/export const presetIconUrl[\s\S]{0,120}/)?.[0] || ''));

console.log('\n=== 2. 解法：NATIVE_SUBDIRS 里必须有 preseticons ===');
t('NATIVE_SUBDIRS 含 mindmap/editor（原有）',
  /plugin: 'mindmap', dir: 'editor'/.test(buildPlugins));
t('NATIVE_SUBDIRS 含 project-group/preseticons',
  /plugin: 'project-group', dir: 'preseticons'/.test(buildPlugins));
t('NATIVE_SUBDIRS 含 icon-picker/preseticons（独立安装用）',
  /plugin: 'icon-picker', dir: 'preseticons'/.test(buildPlugins));
t('三条都在同一个数组里（不是各写一份拷贝逻辑）',
  /const NATIVE_SUBDIRS = \[[\s\S]{0,300}mindmap[\s\S]{0,200}project-group[\s\S]{0,200}icon-picker/.test(buildPlugins));

console.log('\n=== 3. 拷贝机制本身（复用，不是新造）===');
t('遍历 NATIVE_SUBDIRS 做拷贝',
  /for \(const \{ plugin, dir \} of NATIVE_SUBDIRS\)/.test(buildPlugins));
/* 目标从 dist/plugins/<plugin>/<dir> 变为 runtime-plugins/<plugin>/<dir>
   （插件独立构建的产物目录，见 scripts/build-plugins.mjs 头部说明）。 */
t('拷到 runtime-plugins/<plugin>/<dir>',
  /copyInto\(src, resolve\(outDir, dir\)\)/.test(buildPlugins));
/* 判据用**行号顺序**而不是字符距离：buildOne 里 await build({...}) 的
   配置块有三十多行，任何固定字符窗口都会随配置增删而漂移；
   "拷贝在打包之后"这件事的本质是调用顺序，行号比较才是稳的判据。 */
t('拷贝发生在 vite build() 之后（打包之后，不会被覆盖）', (() => {
  const lines = buildPlugins.split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  const buildAt = at(/await build\(\{/);
  const copyAt = at(/for \(const \{ plugin, dir \} of NATIVE_SUBDIRS\)/);
  return buildAt >= 0 && copyAt > buildAt;
})());
t('存在性判断（源目录没了也不报错）',
  /if \(existsSync\(src\)\)/.test(buildPlugins));

console.log('\n=== 4. 源码目录确实存在（否则拷贝规则是空转）===');
const iconDir = path.join(HERE, 'plugins/project-group/preseticons');
t('plugins/project-group/preseticons/ 存在', fs.existsSync(iconDir));
const icos = fs.existsSync(iconDir)
  ? fs.readdirSync(iconDir).filter((f) => f.endsWith('.ico'))
  : [];
t('里面有 .ico 文件（122 个左右）', icos.length > 100);
t('mindmap/editor 目录也在', fs.existsSync(path.join(HERE, 'plugins/mindmap/editor')));
const iconDir2 = path.join(HERE, 'plugins/icon-picker/preseticons');
t('plugins/icon-picker/preseticons/ 也存在（第二份拷贝）', fs.existsSync(iconDir2));
t('第二份同样有 .ico（不是空目录占位）',
  fs.existsSync(iconDir2) && fs.readdirSync(iconDir2).filter((f) => f.endsWith('.ico')).length > 100);

console.log('\n=== 5. 两处各自解析到自己的目录（独立安装的前提）===');
/*
 * 产物结构（独立仓库形态）：
 *   runtime-plugins/project-group/index.html → ./preseticons/x.ico
 *                                            = runtime-plugins/project-group/preseticons/x.ico
 *   runtime-plugins/icon-picker/index.html   → ./preseticons/x.ico
 *                                            = runtime-plugins/icon-picker/preseticons/x.ico
 * ⛔ 两者**不再**是同一个路径 —— 这正是"只装 icon-picker 也能用"的前提。
 *    旧形态下它们指向同一份，于是谁删了 project-group 谁就白屏。
 *    代价是两份物理拷贝，由 cross-plugin-coupling-test.mjs 第 ⑤ 节盯漂移。
 */
const resolveFrom = (base, rel) => {
  const parts = base.split('/').slice(0, -1).concat(rel.split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
};
/* ⛔ ICON_DIR 必须**从源码取**，不能在这里硬编码 './preseticons/'。
   硬编码等于"拿期望值验期望值"：把 index.js 改回 ../project-group/ 时，
   本节照样全绿，只有第 1 节的文本断言会红 —— 而那时"独立安装前提"
   这条最要紧的结论已经不成立了，却没有任何断言喊。 */
const iconDirValue = iconPicker.match(/const ICON_DIR\s*=\s*['"]([^'"]+)['"]/)?.[1] || '';
t('能从 icon-picker 源码取到 ICON_DIR（不是拿硬编码推测）', iconDirValue.length > 0);
const fromPG = resolveFrom('runtime-plugins/project-group/index.html', './preseticons/x.ico');
const fromIP = resolveFrom('runtime-plugins/icon-picker/index.html', `${iconDirValue}x.ico`);
t('project-group 解析到自己目录下的 preseticons',
  fromPG === 'runtime-plugins/project-group/preseticons/x.ico');
t('icon-picker 解析到自己目录下的 preseticons',
  fromIP === 'runtime-plugins/icon-picker/preseticons/x.ico');
/* 关键反向断言：两者**必须不同**。
   若有人把 ICON_DIR 改回 ../project-group/，fromIP 会变回 fromPG，
   这条立刻红并点名"独立安装前提被破坏"。 */
t('两处解析结果不同（独立安装前提，不许退回共一份）', fromIP !== fromPG);
t('两条路径都落在各自插件的拷贝规则写入位置',
  fromPG.startsWith('runtime-plugins/project-group/preseticons/')
  && fromIP.startsWith('runtime-plugins/icon-picker/preseticons/'));

console.log('\n=== 6. 已知未覆盖的情况（不夸大）===');
t('注释里说明了为什么 Vite 处理不了',
  /动态|decodeURI|encodeURIComponent|处理不了|分析不了/.test(buildPlugins));
/*
 * N22 当初的决定是**不搬**（project-group 才是主用户、两处引用同一份拷贝）。
 * 第一百八十四轮翻案：目标形态变成独立仓库独立安装，不搬就必然静默 404。
 *
 * ⛔ 只验注释文本是本项目反复抓的"名字验行为、实际只验注释"。
 *    所以这里两条都只作**说明性**断言；真正钉住行为的是上面第 1/4/5 节
 *    （ICON_DIR 值、两份目录存在、两处解析结果不同）。
 *    注释改了但实现没跟上，那几节会红 —— 反过来注释没改而实现改了，
 *    这里红，提醒把"当初为什么不搬"的错误结论一并更正（注释撒谎）。
 */
t('翻案结论写进了 icon-picker 注释（不是默默改掉）',
  /翻案 N22|为什么搬进来了/.test(iconPicker));
t('注释里点明了独立安装时的 404 风险',
  /独立安装|404/.test(iconPicker));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);

if (fail) {
  console.log(`
修复要点：runtime-plugins/ 下两个插件各自都要有 preseticons/*.ico。
若构建后仍然没有，检查：
  1. scripts/build-plugins.mjs 的 NATIVE_SUBDIRS 是否含
     { plugin: 'project-group', dir: 'preseticons' } 与
     { plugin: 'icon-picker',   dir: 'preseticons' }
  2. copyInto 是否在 vite build() 之后执行（打包之后才不会被覆盖）
  3. 两个源目录 plugins/<id>/preseticons/ 是否真实存在且内容一致
  4. 该插件是否真的被构建过（npm run plugins:build -- --only <id>）
  5. icon-picker 的 ICON_DIR 是否仍是 './preseticons/'（旧值是
     '../project-group/preseticons/'，改回去会破坏独立安装）`);
}
process.exit(fail ? 1 : 0);
