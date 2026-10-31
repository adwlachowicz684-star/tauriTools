/*
  task-board 扫描目录「切回原目录失败」守卫（node 直接跑）。
  登记在 package.json：test:tb-scan-restore

  背景（真实故障形状）：
    scanDir 在后端没有 tb_scan_dir 时走降级路径：临时把 dataDir 切到目标目录，
    探完**必须切回当前项目**。切不回去时旧写法是

        await ctx.invoke('tb_set_data_dir', { dir: currentDataDir }).catch(() => {});

    异常被吞 → dataDir 停在刚扫的那个目录上 → 当前项目随后的每一次读写都指向它，
    表现为「只是扫了一下别的目录，整个看板就空了」，全程一句提示都没有。
    源码自己的注释就写着「不还原的话……表现为扫一次目录、整个看板空了」，
    而代码恰好把它静默掉了 —— 注释承诺了代码没做的事。

  判据为什么不只看源码里有没有那几个字：
    光查 `.catch(() => {})` 会把「降级探不到 tasks.json」那一处正常静默也抓进来。
    这里跑的是 scanDir 真身（esbuild 转译 + 注入可控抛错的 ctx 桩），
    看它在三种情况下到底返回什么。
*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = here;  // 本文件就在 nexus-panel/ 下，plugins/ 与之同级
const STORE_TS = path.join(ROOT, 'plugins/task-board/lib/store.ts');
const APP_TSX = path.join(ROOT, 'plugins/task-board/App.tsx');

let pass = 0;
const fails = [];
function t(name, fn) {
  let ok = false;
  let detail = '';
  try {
    // 两种写法都收：传函数（惰性求值，抛错也能抓住）/ 传已求好的值
    const r = typeof fn === 'function' ? fn() : fn;
    if (r === true) ok = true;
    else detail = typeof r === 'string' ? r : `返回 ${JSON.stringify(r)}`;
  } catch (e) {
    detail = `抛错 ${String(e && e.message ? e.message : e)}`;
  }
  if (ok) {
    pass += 1;
    console.log('✅', name);
  } else {
    fails.push(`${name} → ${detail}`);
    console.log('❌', name, '→', detail);
  }
}

/* ---------- 剥注释：注释里的字会被断言当成依据（本项目踩过三次） ----------
   走 test-scan-utils 的共用实现：这里再内联一份会让 dead-class 的
   「内联副本只增不减」判据报红（本项目已踩过一次）。 */
import { stripCommentsJs as stripComments } from './test-scan-utils.mjs';

/* ---------- 把 scanDir 切成可独立跑的模块（跑真身） ---------- */

/**
 * 按唯一特征定位 + 括号配平切片。
 * ⛔ 不能按"函数到下一个函数"切 —— 那样切出来的可能是别的函数，
 *    检查于是恒绿、一条都没验到（本项目踩过）。
 */
function sliceScanDir(src) {
  const marker = 'export async function scanDir';
  const start = src.indexOf(marker);
  if (start < 0) return null;

  /*
    ⛔ 不能从 start 起直接找第一个 `{` —— 那是返回类型 `Promise<{ ... }>` 里的 `{`，
    从它开始配平会把函数体切歪（转译时报 "Expected >"）。
    先把 `Promise<...>` 的尖括号配平掉，再找函数体的 `{`。
  */
  let bodyStart = -1;
  const pIdx = src.indexOf('Promise<', start);
  if (pIdx >= 0 && pIdx < start + 400) {
    let ad = 1;
    let j = pIdx + 'Promise<'.length;
    for (; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === '<') ad += 1;
      else if (ch === '>') {
        ad -= 1;
        if (ad === 0) break;
      }
    }
    bodyStart = src.indexOf('{', j);
  }
  if (bodyStart < 0) bodyStart = src.indexOf('{', start);

  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

async function loadScanDir() {
  const src = fs.readFileSync(STORE_TS, 'utf8');
  const fnSrc = sliceScanDir(src);
  if (!fnSrc) throw new Error('没切到 scanDir（定位特征变了？）');
  const out = esbuild.transformSync(fnSrc, { loader: 'ts', format: 'esm' });
  const tmp = path.join(os.tmpdir(), `tb-scan-restore-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.code.replace('export async function', 'export async function'));
  const mod = await import('file://' + tmp);
  fs.unlinkSync(tmp);
  return { scanDir: mod.scanDir, fnSrc };
}

/** 造一个 invoke 可控抛错的 ctx 桩，并记录调用序列 */
function makeCtx({ scanOk = true, restoreThrows = false } = {}) {
  const calls = [];
  const ctx = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, dir: args && args.dir });
      if (cmd === 'tb_scan_dir') {
        if (!scanOk) throw new Error('后端没有 tb_scan_dir');
        return { dir: args.dir, tasksJson: true, mdCount: 3, dirCount: 1, otherCount: 0, sample: ['a.md'] };
      }
      if (cmd === 'tb_set_data_dir') {
        // 切回当前项目时按需抛错（模拟授权表拒绝 / 后端出错）
        if (restoreThrows && args && args.dir === '/cur/tasks') throw new Error('切回被拒');
        return null;
      }
      if (cmd === 'tb_read_store') return '{}';
      throw new Error('未预期的命令 ' + cmd);
    },
  };
  return { ctx, calls };
}

const { scanDir, fnSrc } = await loadScanDir();

/* ---------- 1. 跑真身：切回成功 ---------- */
{
  const { ctx, calls } = makeCtx({ scanOk: false, restoreThrows: false });
  const r = await scanDir(ctx, '/scan/target', '/cur/tasks');
  t('降级路径：切回成功时不报失败', r.restoreFailed === false ? true : `restoreFailed=${r.restoreFailed}`);
  t('降级路径：确实切回了当前目录', (() => {
    const back = calls.filter((c) => c.cmd === 'tb_set_data_dir' && c.dir === '/cur/tasks');
    return back.length === 1 ? true : `切回次数 ${back.length}`;
  })());
  t('降级路径：扫描结论照样返回（不因切回失败丢结果）', (() => {
    return r && r.dir === '/scan/target' && r.degraded === true ? true : JSON.stringify(r);
  })());
}

/* ---------- 2. 跑真身：切回失败（本轮修的那处） ---------- */
{
  const { ctx, calls } = makeCtx({ scanOk: false, restoreThrows: true });
  const r = await scanDir(ctx, '/scan/target', '/cur/tasks');
  t('⛔ 降级路径：切回失败必须如实报出（旧写法静默吞掉）', r.restoreFailed === true ? true : `restoreFailed=${r.restoreFailed}`);
  t('切回失败时仍然尝试过切回（不是压根没切）', (() => {
    const back = calls.filter((c) => c.cmd === 'tb_set_data_dir' && c.dir === '/cur/tasks');
    return back.length === 1 ? true : `切回次数 ${back.length}`;
  })());
  t('切回失败时扫描结论不丢（要看得到"像不像任务库"）', r && r.dir === '/scan/target' && typeof r.tasksJson === 'boolean' ? true : JSON.stringify(r));
}

/* ---------- 3. 跑真身：非降级路径不受影响 ---------- */
{
  const { ctx, calls } = makeCtx({ scanOk: true });
  const r = await scanDir(ctx, '/scan/target', '/cur/tasks');
  t('非降级路径：restoreFailed 为 false', r.restoreFailed === false ? true : `restoreFailed=${r.restoreFailed}`);
  t('非降级路径：不碰 data_dir（不临时授权）', calls.every((c) => c.cmd !== 'tb_set_data_dir') ? true : `多出 ${JSON.stringify(calls.map((c) => c.cmd))}`);
  t('非降级路径：统计值照旧透出', r.mdCount === 3 && r.tasksJson === true ? true : JSON.stringify(r));
}

/* ---------- 4. 源码侧：降级路径不再静默 ---------- */
{
  const body = stripComments(fnSrc);
  t('降级路径的切回不再用 .catch(() => {}) 静默', (() => {
    // 剥注释后，整段 scanDir 里不该再有静默吞异常的 catch
    return body.indexOf('.catch(() => {})') < 0 ? true : `仍存在静默 catch`;
  })());
  t('切回失败有独立记录变量（不是 finally 里丢掉）', (() => {
    return /restoreFailed\s*=\s*true/.test(body) ? true : '没找到 restoreFailed = true';
  })());
}

/* ---------- 5. 源码侧：界面说了出来 ---------- */
{
  const app = stripComments(fs.readFileSync(APP_TSX, 'utf8'));
  t('界面渲染了切回失败的提示（否则判据存在但用户看不见）', (() => {
    return /scan\.restoreFailed\s*\?/.test(app) ? true : 'App.tsx 没有 scan.restoreFailed 渲染分支';
  })());
  t('提示里说清了后果（数据目录停在刚扫的目录上）', (() => {
    const m = app.match(/scan\.restoreFailed[\s\S]{0,600}?<\/div>/);
    if (!m) return '没取到提示块';
    return /数据目录/.test(m[0]) ? true : '提示没说明数据目录被顶掉';
  })());
  t('scan state 类型带上了 restoreFailed（不然 TS 直接报错）', (() => {
    return /restoreFailed\?:\s*boolean/.test(app) ? true : 'state 类型缺 restoreFailed';
  })());
}

/* ---------- 6. 自检：判据确能命中反面（否则恒绿等于没验） ---------- */
{
  t('自检：切成旧写法（静默 catch）时判据应当命中', (() => {
    const bad = 'await ctx.invoke("tb_set_data_dir", { dir: currentDataDir }).catch(() => {});';
    return stripComments(bad).indexOf('.catch(() => {})') >= 0 ? true : '判据失明：旧写法也判不出来';
  })());
  t('自检：删掉渲染分支时判据应当命中', (() => {
    const bad = 'const x = 1;';
    return !/scan\.restoreFailed\s*\?/.test(stripComments(bad)) ? true : '判据失明';
  })());
  t('自检：切片确能取到 scanDir（定位特征没漂）', (() => {
    if (!fnSrc) return '切片为空';
    if (fnSrc.indexOf('scanDir') < 0) return '切片里没有 scanDir';
    // 切歪的话这两句不会同时出现（切到返回类型或从中间开始都会缺一半）
    if (fnSrc.indexOf('tb_scan_dir') < 0) return '切片缺降级分支（切歪了）';
    if (fnSrc.indexOf('tb_set_data_dir') < 0) return '切片缺切回调用（切歪了）';
    return true;
  })());
}

console.log('\n====================================================');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('\n失败明细：');
  for (const f of fails) console.log('  ·', f);
  process.exit(1);
}
