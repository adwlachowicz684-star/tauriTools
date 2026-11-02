/**
 * 单文件口径守卫 —— "完全自包含"不许撒谎
 * ============================================================================
 *
 * 起因（第一百八十五轮的更正）：
 *
 *   上一轮用 `checkSingleFile('runtime-plugins/icon-picker/index.html')`
 *   得到 ok:true，就宣布"检查器看不见动态拼的资源路径"。
 *   ⛔ 那次调用是错的 —— checkSingleFile 收的是 **HTML 内容**，传进去的却是
 *      **文件路径字符串**。它检查的是一个不含任何标签的字符串，当然 ok。
 *      方向碰巧对，依据完全是假的。
 *
 *   用正确方式复核（传 readFileSync 的内容、且产物确由 --single-file 构建）：
 *      checkSingleFile(html) → {ok:true, remaining:[], warnings:[]}
 *      而同一份 html 里 `./preseticons/` 出现 1 次，产物目录另有 122 个 .ico。
 *
 *   所以盲区是真的，但形态要说准：
 *     · checkSingleFile 只看 **index.html 里静态写着的** 引用（src/href/url()）
 *     · 运行时 `ICON_DIR + name + '.ico'` 拼出来的请求，HTML 里只是个字符串
 *       常量，检查器分析不了，Vite 也不解析
 *     · 构建脚本的汇总却把这种情况打印成「完全自包含 1/1」—— **报告在撒谎**
 *
 * 这道守卫钉两件事：
 *   ① 带运行时资源目录的插件，绝不能判成"真·单文件可独立安装"
 *   ② 判据不能恒真也不能恒假（两个方向都配反例）
 *
 * 为什么值得单独一个测试而不是塞进 plugin-singlefile-test.mjs：
 *   那边测的是 single-file.mjs 的内联/复查逻辑；这里测的是**构建脚本的报告口径**，
 *   是两个不同的模块，混在一起会让"哪一层失效"看不出来。
 */

import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstallableSingleFile, runtimeDirsOf } from './scripts/build-plugins.mjs';
import { checkSingleFile } from './scripts/single-file.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
function t(name, ok, detail) {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
}

/* ---- ① 判据三个方向 ---- */
t('① 无运行时目录 + HTML 干净 → 真·单文件',
  isInstallableSingleFile({ htmlOk: true, runtimeDirs: [] }) === true);
t('① HTML 干净但另有资源目录 → 不算单文件（icon-picker 真实情形）',
  isInstallableSingleFile({ htmlOk: true, runtimeDirs: ['preseticons'] }) === false);
t('① HTML 本身残留引用 → 不算单文件',
  isInstallableSingleFile({ htmlOk: false, runtimeDirs: [] }) === false);
t('① 两个条件都坏 → 不算单文件',
  isInstallableSingleFile({ htmlOk: false, runtimeDirs: ['editor'] }) === false);

/* 元断言：判据不是恒真，也不是恒假。
   恒假会让所有插件都被判"要整目录拷"，报告看着谨慎实则没用；
   恒真正是上一轮那个撒谎的 bug。 */
t('① 元断言：判据非恒假（存在为 true 的输入）',
  isInstallableSingleFile({ htmlOk: true, runtimeDirs: [] }) === true);
t('① 元断言：判据非恒真（存在为 false 的输入）',
  isInstallableSingleFile({ htmlOk: true, runtimeDirs: ['preseticons'] }) === false);

/* ---- ② runtimeDirsOf：按 id 过滤，且目录必须真的产出 ---- */
const tmp = mkdtempSync(join(tmpdir(), 'sf-report-'));
mkdirSync(join(tmp, 'preseticons'));
mkdirSync(join(tmp, 'editor'));

t('② icon-picker 有 preseticons 目录 → 报出它',
  JSON.stringify(runtimeDirsOf('icon-picker', tmp)) === '["preseticons"]',
  JSON.stringify(runtimeDirsOf('icon-picker', tmp)));
t('② mindmap 有 editor 目录 → 报出它且不含 preseticons',
  JSON.stringify(runtimeDirsOf('mindmap', tmp)) === '["editor"]',
  JSON.stringify(runtimeDirsOf('mindmap', tmp)));
t('② 清单里没有该插件 → 即使目录存在也不报（按 id 过滤生效）',
  runtimeDirsOf('color-picker', tmp).length === 0);

const empty = mkdtempSync(join(tmpdir(), 'sf-report-empty-'));
t('② 清单写了但目录没产出 → 报空（不凭清单谎称有资源）',
  runtimeDirsOf('icon-picker', empty).length === 0);

/* ---- ③ 把"检查器的盲区"这个事实钉住 ----
 * 现网单文件产物存在时，用【内容】而不是路径去查。
 * 若有人哪天让 checkSingleFile 变得能看见动态路径，这条会红，
 * 那时应回来更新注释与口径，而不是悄悄留着过时的说明。 */
const realHtml = resolve(ROOT, 'runtime-plugins/icon-picker/index.html');
if (!existsSync(realHtml)) {
  console.log('  · 现网 icon-picker 单文件产物不存在，跳过 ③（不影响其余断言）');
} else {
  const html = readFileSync(realHtml, 'utf8');
  const chk = checkSingleFile(html);
  t('③ 现网产物：checkSingleFile(内容) 确实说 ok', chk.ok === true,
    JSON.stringify(chk).slice(0, 200));
  t('③ 现网产物：但 html 里确实留着动态资源基址 ./preseticons/',
    html.includes('./preseticons/'));
  t('③ 于是"HTML ok"不能推出"真·单文件"',
    isInstallableSingleFile({ htmlOk: chk.ok, runtimeDirs: ['preseticons'] }) === false);
  /* 反向：如果产物里根本没有那个字符串，说明插件形态变了，这条会红，
     提醒重新核对口径，而不是让断言静默失去意义 */
  t('③ 元断言：盲区样本不是恒空（html 里能找到字符串）',
    /preseticons/.test(html));
}

console.log(`\n[单文件口径] 通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.log(`  ❌ ${f}`);
process.exit(fails.length ? 1 : 0);
