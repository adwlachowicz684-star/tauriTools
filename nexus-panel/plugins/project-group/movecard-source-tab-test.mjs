/**
 * 移动卡片只从**源页签**摘（对齐原版 MoveCardToTabFor 的注释）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/movecard-source-tab-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const hook = R('hooks/useFpx.ts');
const app = R('App.tsx');

console.log('\n=== 1. 只从源页签摘，不从所有页签删 ===');
{
  /*
   * 同一个路径**可以登记在多个页签里**（添加时只查当前页签有没有重复）。
   * 原来 `for (const t of tabs) t.items = t.items.filter(p => p !== path)`
   * 会把它在其它页签里的登记一并抹掉 —— 用户只是在这一页里挪个位置。
   *
   * 原版注释点明：同路径多页签时按路径 RemoveAll 会误删其他页签的同路径卡。
   */
  t('不再有全页签 filter', !/for \(const t of tabs\) t\.items = t\.items\.filter/.test(hook));
  t('改成按源页签 splice', /tabs\[src\]\.items\.splice\(at, 1\);/.test(hook));
  /* 只删找到的第一条：同一页签里也可能有重复登记（历史数据） */
  t('只删一条', /const at = tabs\[src\]\.items\.indexOf\(path\);/.test(hook));
  t('找不到就放弃', /if \(at < 0\) return;/.test(hook));
}

console.log('\n=== 2. 源页签怎么定 ===');
{
  /* 显式传的优先 */
  t('接受 fromTabIndex 参数', /fromTabIndex\?: number,/.test(hook));
  t('显式值优先', /let src = fromTabIndex \?\? tabs\.findIndex/.test(hook));
  /*
   * 显式值越界时退回"找第一个含它的页签" ——
   * 直接用越界值会 splice 到 undefined 上，那是一次崩溃而不是"没生效"。
   */
  t('越界则退回查找', /if \(src < 0 \|\| src >= tabs\.length\) src = tabs\.findIndex/.test(hook));
  /* 真的一个都没有 → 什么都不做，不凭空插入 */
  t('找不到源则放弃', /if \(src < 0\) return;/.test(hook));
}

console.log('\n=== 3. 三个调用点都要显式传源 ===');
{
  /*
   * 都传了才算对齐：靠"退回查找"虽然也能工作，
   * 但同路径多页签时找到的第一个未必是用户拖的那一张所在的页签。
   */
  t('项目栏同页签重排传源',
    /s\.moveCard\('project', path, activeTabRef\.current\.project, i,\s*\n\s*activeTabRef\.current\.project\)/.test(app));
  t('拖到别的页签传源',
    /s\.moveCard\('project', path, tabIndex, n, activeTabRef\.current\.project\)/.test(app));
  t('项目组堆叠传源',
    /s\.moveCard\('group', path, tabIndex, index, tabIndex\)/.test(app));
  /* 不能还有只传四个参数的调用 */
  const four = (app.match(/moveCard\([^)]*\)/g) || []).filter((c) => c.split(',').length === 4);
  t('没有遗留四参数调用', four.length === 0, four.join(' | '));
}

console.log('\n=== 4. 索引语义没被顺手改坏 ===');
{
  /* 落点仍夹在 [0, 长度] —— 调用方传的是 resolveMoveIndex 算好的最终位置 */
  t('目标位置仍夹取', /const i = Math\.max\(0, Math\.min\(toIndex, target\.items\.length\)\);/.test(hook));
  t('目标页签仍夹取', /const tab = Math\.max\(0, Math\.min\(toTabIndex, maxTab\)\);/.test(hook));
  t('空页签列表直接返回', /if \(tabs\.length === 0\) return;/.test(hook));
}

done();
