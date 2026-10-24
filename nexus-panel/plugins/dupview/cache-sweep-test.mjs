/**
 * 守卫：查重缓存的治理契约（后端 cache.rs + 前端面板 + 命令面三处一致）。
 *
 * 【它要钉住的两件事】
 *   ① 缓存只增不减 —— 索引条目消失（删文件/改名/移除根目录）后没人回收，
 *      本机实测攒到 2.3G（占全部缓存 72%）。打开插件时必须自动清孤儿。
 *   ② 清理不能误杀 —— 索引读不到就整体不删、只认 8 位十六进制形状、
 *      _work/_trash 不碰。这三条底线任何一条被"优化"掉，都会把
 *      "清理垃圾"变成"清库"，而且不报错。
 *
 * 断言按"源码字面"钉，不跑运行时 —— 这个插件的 index.html 是内联脚本，
 * 起 jsdom 的成本远高于收益；Rust 侧的真行为由 cache.rs 里的单测覆盖
 * （临时目录造活/孤儿混合场景），这里钉的是"接线与契约还在"。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const html = readFileSync(join(here, 'index.html'), 'utf8');
const cacheRs = readFileSync(join(here, '../../src-tauri/src/dupview/cache.rs'), 'utf8');
const modRs = readFileSync(join(here, '../../src-tauri/src/dupview/mod.rs'), 'utf8');
const mainRs = readFileSync(join(root, 'src-tauri/src/main.rs'), 'utf8');
const policy = readFileSync(join(root, 'js/invoke-policy.js'), 'utf8');
const caps = readFileSync(join(root, 'js/command-caps.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, why) => {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${why ? ' —— ' + why : ''}`);
  }
};

/* ---- 1. 后端：自动清理挂在打开插件时 ---- */
ok('mod.rs 声明了 cache 模块', /pub mod cache;/.test(modRs));
ok(
  'migrate_legacy 每次打开插件时清孤儿（cache::sweep Orphan）',
  /cache::sweep\(&dir, cache::SweepMode::Orphan\)/.test(modRs),
  '挂在打开时才能兜住"索引条目消失"这条所有路径',
);

/* ---- 2. 后端：三条安全底线 ---- */
ok(
  'live_idx 返回 Option：读不到索引就返回 None（不是空集）',
  /pub fn live_idx\(dir: &Path\) -> Option<HashSet<String>>/.test(cacheRs),
);
ok(
  'map.json 不存在 / 为空都返回 None',
  /if !p\.is_file\(\) \{\s*return None;/.test(cacheRs)
    && /if items\.is_empty\(\) \{\s*return None;/.test(cacheRs),
  '空索引在调用方眼里等于"全部孤儿"，一次读失败就会清光缓存',
);
ok(
  '只认 8 位十六进制形状的缓存名',
  /fn is_idx\(s: &str\) -> bool/.test(cacheRs) && /s\.len\(\) == 8/.test(cacheRs),
  '认不出来的文件不是"能证明是垃圾"，只是"没见过"',
);
ok(
  'sweep 只走 _imgs 与 _docx_pdf，不碰 _trash / _migrate_bak',
  /dir\.join\("_imgs"\)/.test(cacheRs)
    && /dir\.join\("_docx_pdf"\)/.test(cacheRs)
    && !/join\("_trash"\)/.test(cacheRs)
    && !/join\("_migrate_bak"\)/.test(cacheRs),
);
ok(
  '删之前先数（dir_files_bytes），报告与磁盘对得上',
  /fn dir_files_bytes/.test(cacheRs) && /let \(files, bytes\) = dir_files_bytes\(&d\);/.test(cacheRs),
);
ok(
  'pages 档只清逐页图目录，docx→PDF 仅孤儿/all 档动',
  /matches!\(mode, SweepMode::Pages \| SweepMode::All\)/.test(cacheRs),
  'docx 转换一份要几分钟，pages 档刻意不碰',
);

/* ---- 3. 后端：两条命令 + 档位解析 ---- */
ok('dupview_cache_stats 命令存在（只读统计）', /pub fn dupview_cache_stats/.test(modRs));
ok('dupview_cache_sweep 命令存在（分级清理）', /pub fn dupview_cache_sweep/.test(modRs));
ok(
  '档位名认不出来报错，不静默落成某一档',
  /_ => None,/.test(cacheRs) && /未知清理档位/.test(modRs),
);

/* ---- 4. 前端：面板三档 + 数字来自实时统计 ---- */
ok('cmdCacheStats / cmdCacheSweep 包装存在',
  /async function cmdCacheStats\(\)\{return beCtx\(\)\.invoke\('dupview_cache_stats',\{\}\)\}/.test(html)
  && /async function cmdCacheSweep\(mode\)\{return beCtx\(\)\.invoke\('dupview_cache_sweep',\{mode:mode\}\)\}/.test(html));
for (const m of ['orphan', 'pages', 'all']) {
  ok(`面板有 ${m} 档按钮`, html.includes(`cacheClean('${m}')`));
}
ok(
  '清理前弹确认框，且列出将删规模（不是写死文案）',
  /ask\('清理'\+labels\[mode\]/.test(html) && /将删除约 '\+fmt\(b\)\+' \/ '\+f\+' 个缓存文件/.test(html),
);
ok(
  '确认框说明三档代价差异（pages 档明说 docx 不动）',
  /docx 转换缓存不动/.test(html) && /重新过一遍转换/.test(html),
);
ok(
  '索引不可读时明说，不当"没有缓存"',
  /!j\.indexOk/.test(html) && /索引不可读/.test(html) && /已拒绝清理/.test(html),
  '拿一堆 0 充数会让用户以为已经清过了',
);
ok(
  'pages 档规模不把孤儿逐页图算两遍',
  /j\.orphanFiles\+j\.livePagesFiles/.test(html) && /j\.orphanBytes\+j\.livePagesBytes/.test(html),
  '孤儿逐页图已含在 orphanFiles 里，只能加活的那部分',
);
ok(
  '清理后报出分类数与释放量',
  /已清理 '\+r\.removedFiles\+' 个文件/.test(html) && /释放 '\+fmt\(r\.removedBytes\)/.test(html),
);

/* ---- 5. 命令面：注册 / 白名单 / 定级三处一致 ---- */
ok('main.rs 注册了 dupview::dupview_cache_stats', mainRs.includes('dupview::dupview_cache_stats'));
ok('main.rs 注册了 dupview::dupview_cache_sweep', mainRs.includes('dupview::dupview_cache_sweep'));
ok('invoke-policy 白名单收了两条', policy.includes("'dupview_cache_stats'") && policy.includes("'dupview_cache_sweep'"));
ok('command-caps 定级：stats=R（只读）、sweep=W（删文件）',
  /dupview_cache_stats: 'R'/.test(caps) && /dupview_cache_sweep: 'W'/.test(caps));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
