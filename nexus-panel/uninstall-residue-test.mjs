/**
 * 卸载残留：收口函数的**真实行为**
 * ====================================================================
 * 背景（2026-10-17 架构审查发现）：卸载一条链上曾有五处残留——
 *   ① ctx.store 的 KV（nexus:<id>:*）与每插件配置（nexus:plugin-cfg:<id>）
 *      从未被清，无限期躺在 localStorage 里；
 *   ② 外链信任决策按 host 记账但带插件归属，卸载不撤销 →
 *      新插件继承上一个插件的 allow；
 *   ③ 工具栏三张表（隐藏/排序/额外入口）留着失效 id（惰性垃圾 +
 *      同名复 id 时继承旧状态）；
 *   ④ 服务实例缓存（services Map）不拆 → 卸载后重启前仍可调用；
 *   ⑤ MCP 网关代理服务不注销 → 插件没了工具还挂着，AI 每次都调必失败的工具。
 *
 * 修法：全部收口到 host.removePlugin 一处（结构性保证，不依赖每个 UI 记得）。
 * 本测试盯**可独立单测的两个导出函数**（forgetPlugin / revokePluginHosts）
 * 的真实行为 + 存储前缀的跨文件一致（purge 的匹配式若与写入方漂移，
 * 清理就会静默漏一片 —— 而"没清干净"本身不报错）。
 *
 * 为什么用 jsdom + import 真实模块：手抄一份实现迟早与源文件漂移，
 * 于是"测试绿、线上照样残留"。判据必须跑在真代码上。
 *
 * 运行：node uninstall-residue-test.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* jsdom 提供 window / document / localStorage（Node 22 无全局 localStorage）。
   external-policy 的广播走 globalThis.addEventListener，一并给上。 */
const dom = new JSDOM('', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.CustomEvent = dom.window.CustomEvent;

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const tb = await import('./js/toolbar-plugin.js');
const ext = await import('./js/external-policy.js');

const readLs = (k) => JSON.parse(localStorage.getItem(k) || '[]');
const seedLs = (k, v) => localStorage.setItem(k, JSON.stringify(v));

/* ================================================================
   1. forgetPlugin：工具栏三表除名（两种 id 形态都要覆盖）
   ================================================================ */
console.log('\n=== 1. forgetPlugin（工具栏三表除名）===');
{
  /* 两种形态：kind:'toolbar' 插件记裸 id；应用插件入口记 tb-entry:<id> */
  seedLs('nexus:toolbar-hidden', ['custom-abc', 'tb-entry:custom-abc', 'tb-entry:keep']);
  seedLs('nexus:toolbar-order', ['tb-entry:custom-abc', 'keep-plugin']);
  seedLs('nexus:toolbar-extra', ['custom-abc']);

  const ok = tb.forgetPlugin('custom-abc');

  t('除名后隐藏表只剩别人的（裸 id 与 tb-entry: 两种形态都删）',
    JSON.stringify(readLs('nexus:toolbar-hidden')) === JSON.stringify(['tb-entry:keep']),
    JSON.stringify(readLs('nexus:toolbar-hidden')));
  t('排序表除名', readLs('nexus:toolbar-order').join() === 'keep-plugin');
  t('额外入口表除名', readLs('nexus:toolbar-extra').length === 0);
  t('落盘可复读（hiddenIds/orderIds/extraIds 读到的就是除名后的）',
    tb.hiddenIds().join() === 'tb-entry:keep' && tb.extraIds().length === 0);
  t('全部写成功时返回 true', ok === true);
  t('不存在的 id：不动任何表、也不报错',
    tb.forgetPlugin('no-such-plugin') === true
    && readLs('nexus:toolbar-hidden').join() === 'tb-entry:keep');
  t('空 id 直接放行（卸载主流程不该被附属表卡住）', tb.forgetPlugin('') === true);
}

/* ================================================================
   2. revokePluginHosts：外链信任决策打回待决策
   ================================================================ */
console.log('\n=== 2. revokePluginHosts（外链信任撤销）===');
{
  seedLs('nexus:external-policy', {
    mode: 'smart',
    hosts: {
      'evil.com': { status: 'allow', decidedAt: 123, pluginId: 'custom-abc' },
      'good.com': { status: 'allow', decidedAt: 456, pluginId: 'custom-other' },
      'seen.com': { status: 'pending', pluginId: 'custom-abc' },
    },
  });

  const n = ext.revokePluginHosts('custom-abc');

  t('归属它的 allow 被打回 pending', n === 1, `n=${n}`);
  const hosts = ext.listHosts();
  const evil = hosts.find((h) => h.host === 'evil.com');
  const good = hosts.find((h) => h.host === 'good.com');
  t('打回时清掉 decidedAt（否则"待决策"带着旧时间戳， UI 显示混乱）',
    evil && evil.status === 'pending' && evil.decidedAt === undefined,
    JSON.stringify(evil));
  t('别人的 allow 不动（按 host 记账，一条记录只有一个归属）',
    good && good.status === 'allow' && good.decidedAt === 456);
  t('本来就是 pending 的不重复计数', hosts.find((h) => h.host === 'seen.com').status === 'pending');
  t('落盘可复读（不是只改内存）', ext.listHosts().find((h) => h.host === 'evil.com').status === 'pending');
  t('空 id 返回 0', ext.revokePluginHosts('') === 0);
  t('不认识插件不炸不误伤', ext.revokePluginHosts('who') === 0
    && ext.listHosts().find((h) => h.host === 'good.com').status === 'allow');
}

/* ================================================================
   3. 存储前缀跨文件一致（purge 的匹配式不能与写入方漂移）
   ================================================================ */
console.log('\n=== 3. 清理目标的前缀与写入方一致 ===');
{
  const hostSrc = fs.readFileSync(path.join(HERE, 'js/host.js'), 'utf8');
  const sdkSrc = fs.readFileSync(path.join(HERE, 'js/plugin-sdk.js'), 'utf8');
  const cfgSrc = fs.readFileSync(path.join(HERE, 'js/plugin-config.js'), 'utf8');
  const fsSrc = fs.readFileSync(path.join(HERE, 'js/plugin-fs.js'), 'utf8');

  /* purgePluginStorage 清的两个前缀 */
  const purgeFn = hostSrc.match(/function purgePluginStorage[\s\S]*?\n}/)?.[0] || '';
  t('purge 覆盖 store 写入方的前缀（nexus:<id>:）',
    purgeFn.includes('nexus:${pid}:')
    && sdkSrc.includes('`nexus:${manifest.id}:${payload.k}`')
    && hostSrc.includes('`nexus:${manifest.id}:${payload.k}`'));
  t('purge 覆盖每插件配置的前缀（nexus:plugin-cfg:<id>，与 plugin-config.js 的 KEY 同源）',
    purgeFn.includes('nexus:plugin-cfg:${pid}') && cfgSrc.includes('`nexus:plugin-cfg:${id}`'));
  t('purge 刻意不清 fs 账本（nexus:fsclaim: 前缀不同，文件不自动删，账本是手工清理的依据）',
    !purgeFn.includes('fsclaim') && fsSrc.includes("'nexus:fsclaim:'"));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
