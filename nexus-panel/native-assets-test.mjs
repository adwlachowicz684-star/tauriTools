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
 * vite.config.ts 的 `NATIVE_SUBDIRS` 就是为这种"不能交给 Vite 处理的
 * 原生子目录"准备的（原本只有 mindmap/editor）。加一条
 * `project-group/preseticons` 即可 —— 复用现成机制，
 * 不改任何引用路径，也不用新建 public 目录。
 *
 * 本测试钉住这条规则，防止将来有人删掉它而没人发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); }
};

const viteCfg = src('vite.config.ts');
const iconPicker = src('plugins/icon-picker/index.js');
const presetIcons = src('plugins/project-group/presetIcons.ts');

console.log('=== 1. 事实：两处引用都是动态拼接（Vite 分析不了）===');
t('project-group 用模板字符串拼图标 URL',
  /`\.\/preseticons\/\$\{encodeURIComponent\(name\)\}\.ico`/.test(presetIcons));
t('icon-picker 同样用模板字符串',
  /`\$\{ICON_DIR\}\$\{encodeURIComponent\(name\)\}\.ico`/.test(iconPicker));
t('icon-picker 指向 project-group 的目录',
  /const ICON_DIR = '\.\.\/project-group\/preseticons\/'/.test(iconPicker));
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
  /plugin: 'mindmap', dir: 'editor'/.test(viteCfg));
t('NATIVE_SUBDIRS 含 project-group/preseticons（本轮新增）',
  /plugin: 'project-group', dir: 'preseticons'/.test(viteCfg));
t('两条都在同一个数组里（不是各写一份拷贝逻辑）',
  /const NATIVE_SUBDIRS = \[[\s\S]{0,200}mindmap[\s\S]{0,120}project-group/.test(viteCfg));

console.log('\n=== 3. 拷贝机制本身（复用，不是新造）===');
t('遍历 NATIVE_SUBDIRS 做拷贝',
  /for \(const \{ plugin, dir \} of NATIVE_SUBDIRS\)/.test(viteCfg));
t('拷到 dist/plugins/<plugin>/<dir>',
  /copyInto\(src, resolve\(out, plugin, dir\)\)/.test(viteCfg));
t('在 closeBundle（打包之后，不会被覆盖）',
  /apply: 'build'[\s\S]{0,120}closeBundle/.test(viteCfg));
t('存在性判断（源目录没了也不报错）',
  /if \(fsSync\.existsSync\(src\)\)/.test(viteCfg));

console.log('\n=== 4. 源码目录确实存在（否则拷贝规则是空转）===');
const iconDir = path.join(HERE, 'plugins/project-group/preseticons');
t('plugins/project-group/preseticons/ 存在', fs.existsSync(iconDir));
const icos = fs.existsSync(iconDir)
  ? fs.readdirSync(iconDir).filter((f) => f.endsWith('.ico'))
  : [];
t('里面有 .ico 文件（122 个左右）', icos.length > 100);
t('mindmap/editor 目录也在', fs.existsSync(path.join(HERE, 'plugins/mindmap/editor')));

console.log('\n=== 5. 一处拷贝覆盖两处引用（路径推算）===');
/*
 * dist 结构：
 *   dist/plugins/project-group/index.html   → ./preseticons/x.ico
 *                                           = dist/plugins/project-group/preseticons/x.ico
 *   dist/plugins/icon-picker/index.html     → ../project-group/preseticons/x.ico
 *                                           = dist/plugins/project-group/preseticons/x.ico
 * 两者解析到**同一个** dist 路径 —— 所以一条拷贝规则同时解决。
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
const fromPG = resolveFrom('dist/plugins/project-group/index.html', './preseticons/x.ico');
const fromIP = resolveFrom('dist/plugins/icon-picker/index.html', '../project-group/preseticons/x.ico');
t('project-group 自己解析到 dist/plugins/project-group/preseticons/x.ico',
  fromPG === 'dist/plugins/project-group/preseticons/x.ico');
t('icon-picker 解析到同一路径（所以一条规则就够）', fromIP === fromPG);
t('该路径正是拷贝规则写入的位置',
  fromPG.startsWith('dist/plugins/project-group/preseticons/'));

console.log('\n=== 6. 已知未覆盖的情况（不夸大）===');
t('README/注释里说明了为什么 Vite 处理不了',
  /动态|decodeURI|encodeURIComponent|处理不了|分析不了/.test(viteCfg));
/*
 * 这一条记的是**决定**：N22（服务该自带资源）经核实后**不改**，
 * 理由写在 icon-picker 的注释里（project-group 才是主用户、
 * 搬走解决不了构建丢失、两处引用同一份拷贝）。
 *
 * 钉住"注释里写了结论"而不是钉"仍引用 project-group" ——
 * 后者会在将来真要搬时被误当成失败，而那时它是**预期变化**。
 */
t('N22 的处理结论写进了注释（不是默默不改）',
  /为什么最终决定不把资源搬进本服务/.test(iconPicker));
t('结论里说明了 project-group 才是主用户',
  /project-group 才是主用户/.test(iconPicker));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);

if (fail) {
  console.log(`
修复要点：dist 里应有 plugins/project-group/preseticons/*.ico。
若构建后仍然没有，检查：
  1. vite.config.ts 的 NATIVE_SUBDIRS 是否含 { plugin: 'project-group', dir: 'preseticons' }
  2. copyInto 是否在 closeBundle 阶段执行（打包之后才不会被覆盖）
  3. 源目录 plugins/project-group/preseticons/ 是否真实存在`);
}
process.exit(fail ? 1 : 0);
