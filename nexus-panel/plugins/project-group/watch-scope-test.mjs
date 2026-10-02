/**
 * 「受保护目录监听」的监控范围回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/watch-scope-test.mjs
 *
 * 后端 `locks` 清单里装着**两类**条目，而只有一类是真的受保护：
 *   · 防删除 / 防写入 / 完全保护 —— 真落了 ACL
 *   · 「账面固定」（#21 account_only）—— 承诺就是**不落任何系统权限**，
 *     档位说明写着"只登记在案做标记，不改系统权限"
 *
 * 原先监听拿的是 `cfg.locks` 全量，于是：
 *   1. 弹出来的告警写「**受保护**目录发生改动：X」，而 X 根本没有保护 ——
 *      用户会据此以为自己的目录是受保护的。这类"界面主动给出与事实相反的
 *      判断"比什么都不显示更糟，用户会照着它下结论；
 *   2. 用户选「账面固定」的理由恰恰是"不想动系统、不必管理员权限"，
 *      结果被拉进一个每轮遍历他整棵目录树（上限 20 万条目）的后台线程；
 *   3. 解除保护（设为「无保护」）会摘掉条目、不再监控，而设为「账面固定」
 *      条目留着、照样监控 —— 这个差别界面上完全看不出来。
 *
 * 而同一份 `locks` 在 mod.rs 启动自愈那处是**明确排除** account_only 的
 * （`.filter(|l| !l.account_only)`，注释写明"自愈若给它落 ACL，等于替用户
 * 取消了这个选择"）。同一份清单、两处消费、两套判据 —— 这正是本项目
 * 反复出事的形状。
 *
 * 这里守：
 *   · 判据只看"是否真落了 ACL"（deny_delete || deny_write）
 *   · 三处消费点全部走同一个函数，不许各写一份
 *   · 手改配置 ao 与 dd 同时为真时**仍要纳入**（漏报比多监控严重）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const watch = read('../../src-tauri/src/fpx/watch.rs');
const mod = read('../../src-tauri/src/fpx/mod.rs');
const app = read('App.tsx');

/* 剥注释：下面多条断言的字面量都写在说明里，不剥会空跑（第 27 次同类） */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');
const watchCode = strip(watch);
const modCode = strip(mod);
const appCode = strip(app);

/** 取一段代码：从锚点起按大括号配平切出函数体（避免 `}` 提前截断） */
function blockAfter(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open, k + 1); }
  }
  return '';
}

console.log('\n=== 1. 判据跑真身：哪些条目该被监控 ===');
{
  const fn = blockAfter(watchCode, 'pub(crate) fn monitored_paths');
  /* 锚点自检：切片必须真的落在 monitored_paths 上，
     否则后面每条断言都是"恒真/恒假"的空跑 */
  t('锚点命中 monitored_paths（切片自检）', fn.includes('cfg.locks') && fn.includes('.filter('));

  /* 从源码里取出 filter 的判据表达式，原样求值 —— 不是看源码里有没有那几个字 */
  const m = fn.match(/\.filter\(\s*\|l\|\s*([\s\S]*?)\)\s*\n?\s*\.map/);
  t('取到 filter 判据', !!m, m ? m[1] : '(未取到)');
  const pred = m ? new Function('l', `return (${m[1]});`) : () => true;

  const item = (dd, dw, ao) => ({ path: '/x', deny_delete: dd, deny_write: dw, account_only: ao });
  /* 五个档位与 lockPresets.ts 一一对应 */
  t('无保护（全 false）不纳入', pred(item(false, false, false)) === false);
  t('防删除 纳入', pred(item(true, false, false)) === true);
  t('防写入 纳入', pred(item(false, true, false)) === true);
  t('完全保护 纳入', pred(item(true, true, false)) === true);
  t('账面固定 不纳入 ★', pred(item(false, false, true)) === false);
  /*
   * 手改过的配置可能 ao 与 dd 同时为真。那时 ACL 是真落了的
   * （mod.rs set_lock 里 `want_acl = deny_delete || deny_write` 会调 apply_lock），
   * 所以必须纳入。若判据写成 `!account_only`，这里会**漏监控** ——
   * 而漏报（该响的警报不响）比多监控严重得多，见 push_event 关于截断的说明。
   */
  t('手改配置 ao+防删除 同时为真 → 仍纳入（不漏报）★', pred(item(true, false, true)) === true);

  t('取的是 path（不是整条记录）', /\.map\(\s*\|l\|\s*l\.path\.clone\(\)\s*\)/.test(fn), fn.slice(0, 200));
}

console.log('\n=== 2. 三处消费点全部走同一个函数 ===');
{
  /*
   * 兜底按**出现次数**钉，不按"存在"钉：
   * 只判存在的话，撤掉其中一处照样通过（这是本套件最容易写错的一条）。
   */
  const inWatch = (watchCode.match(/monitored_paths\(/g) || []).length;
  const inMod = (modCode.match(/monitored_paths\(/g) || []).length;

  /* watch.rs 里：1 处定义 + 2 处调用（线程 / watched_paths） */
  t('watch.rs 内调用 2 处', inWatch - 1 === 2, `实际 ${inWatch - 1}`);
  /* mod.rs 里：启动那处 1 处 */
  t('mod.rs 内调用 1 处', inMod === 1, `实际 ${inMod}`);

  t('线程内走 monitored_paths', /let cfg_paths: Vec<String> = monitored_paths\(/.test(watchCode));
  t('watched_paths 也走它', blockAfter(watchCode, 'pub fn watched_paths').includes('monitored_paths('));
  t('watch_start 也走它', /let paths: Vec<String> = watch::monitored_paths\(&cfg\)/.test(modCode));

  /* 不许再有"为监听直接取 locks"的写法残留 */
  t('watch.rs 内不再直接 map locks 取路径',
    !/\.locks\.iter\(\)[\s\S]{0,80}?\.path\.clone\(\)/.test(watchCode));
}

console.log('\n=== 3. 与启动自愈那处同源（同一份 locks，两处都排除账面固定）===');
{
  /*
   * 这里**不能**用 blockAfter：该语句里第一个 `{` 在后面的
   * `if !desired.is_empty() {` 上，按大括号配平会切到别的块，
   * 于是"命中自检"恒假、后面两条也跟着空跑（本轮新踩的一次）。
   * 取锚点后的一段窗口即可，并自检窗口里确实带着 cfg.locks。
   */
  const si = modCode.indexOf('let desired: Vec<(String, bool, bool)>');
  const sweep = si < 0 ? '' : modCode.slice(si, si + 320);
  t('切片命中自愈那处（自检）', sweep.includes('cfg.locks') && sweep.includes('.filter('), sweep.slice(0, 160));
  t('自愈只看不落 ACL 的那批', /\.filter\(\s*\|l\|\s*!l\.account_only\s*\)/.test(sweep), sweep.slice(0, 160));
  t('自愈排除了账面固定 → 监听也必须排除（同源）',
    /\.filter\(\s*\|l\|\s*!l\.account_only\s*\)/.test(sweep)
    && /\.filter\(\s*\|l\|\s*l\.deny_delete \|\| l\.deny_write\s*\)/.test(watchCode));
}

console.log('\n=== 4. 前端文案：告警说的是「受保护目录」，所以后端只能给真受保护的 ===');
{
  t('告警文案写着「受保护目录」', /受保护目录\$\{what\}/.test(appCode));
  t('删除告警用的是 removed 这一档', /ev\.kind === 'removed'/.test(appCode));
  /* 若哪天后端改回全量 locks，这条会红 —— 它把"为什么必须过滤"钉在前端理由上 */
  t('App 侧没有把 accountOnly 当作受保护来展示', !/accountOnly[\s\S]{0,60}受保护/.test(appCode));
}

done();
