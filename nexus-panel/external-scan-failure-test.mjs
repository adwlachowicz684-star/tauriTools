#!/usr/bin/env node
/**
 * 外链扫描「没扫成 ≠ 没有外链」守卫
 * ------------------------------------------------------------
 * 背景：js/external-policy.js 的 scanEntry 读不到入口时返回
 *   { ok:false, error, hosts:[] } —— 含义是「这次根本没查成」。
 * 而 js/shell.js 两条消费路径都把它当成「查过且干净」：
 *   · 导入插件时只看 externalEntry / hosts.length，一声不吭；
 *   · 设置页「重新检查」把异常 .catch 成空清单，全部失败也报
 *     「已检查 N 个插件，登记 0 个外链」+ 成功样式。
 * 结果：外链清单空着、smart 模式不询问，用户看到的是一个干净的
 * 外链页签 —— 漏报还报绿，而这是安全扫描。
 *
 * 判据一律跑**抽取出来的真实函数**，不手抄：手抄版本与源码漂移时
 * 会出现「测试绿、线上照样漏报」。剥注释用共用模块，不新增内联副本
 * （注释里原样写着 ok:false 与旧 .catch 写法，不剥会被注释喂饱）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(HERE, 'js', 'shell.js');
const src = fs.readFileSync(SHELL, 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------------- ① 抽取真实代码 ---------------- */
const START = '/**\n * 把一次扫描的异常也收成';
const END = '/* ---------------------------- 插件设置抽屉';
const i = src.indexOf(START);
const j = i < 0 ? -1 : src.indexOf(END, i + START.length);
if (i < 0 || j < 0) {
  console.log('⛔ 抽取失败：js/shell.js 的扫描段落标记不在预期位置（源码结构变了）');
  process.exit(1);
}
const block = src.slice(i, j);
t('抽到 scanFailure / scanPluginExternal / rescanAllPlugins 三个真实函数',
  /function scanFailure\(/.test(block)
  && /async function scanPluginExternal\(/.test(block)
  && /async function rescanAllPlugins\(/.test(block));
t('抽取段落不含函数定义之外的代码', !/function toast\(|function openPluginSettings\(/.test(block));

/* ---------------- ② 行为层 runner ---------------- */
/*
 * 真实 scanEntry 是 async，永远返回 Promise；替身也包一层 Promise，
 * 否则同步 throw 会绕过 .catch(scanFailure) 直接把函数打崩 ——
 * 那样测出来的「红」是脚本崩了，不是判据抓到（本项目栽过多次）。
 */
function run(blockSrc, { scan, plugins = [], mode = 'smart' } = {}) {
  const toasts = [];
  let refreshed = 0;
  const extPolicy = {
    scanEntry: (...a) => Promise.resolve().then(() => scan(...a)),
    loadPolicy: () => ({ mode, hosts: {} }),
  };
  const toast = (msg, type = 'info') => toasts.push({ msg, type });
  const refreshExternalUI = () => { refreshed++; };
  const host = { getPlugins: () => plugins };
  const make = new Function('extPolicy', 'toast', 'refreshExternalUI', 'host',
    blockSrc + '\nreturn { scanPluginExternal, rescanAllPlugins };');
  return {
    api: make(extPolicy, toast, refreshExternalUI, host),
    toasts,
    get refreshed() { return refreshed; },
  };
}

const HOSTS = [
  { host: 'a.example.com', kind: 'script', sample: 'https://a.example.com/x.js' },
  { host: 'b.example.com', kind: 'fetch', sample: 'https://b.example.com/api' },
];
const OK2 = () => ({ ok: true, hosts: HOSTS, externalEntry: false });
const BAD = (code = 404) => ({ ok: false, hosts: [], error: `读取失败 HTTP ${code}` });
const PLUGINS = [
  { id: 'p1', name: '一', entry: './plugins/one/index.html' },
  { id: 'p2', name: '二', entry: './plugins/two/index.html' },
  { id: 'p3', name: '三', entry: './plugins/three/index.html' },
];

/* A 组：导入 / 更新时的单次扫描 */
{
  /* runner 的 refreshed 是 getter，必须留着对象在调用后再读；
     解构会当场取到 0，把一条真通过的断言写成假红。 */
  const r1 = run(block, { scan: () => BAD() });
  const { api, toasts } = r1;
  const r = await api.scanPluginExternal(PLUGINS[0]);
  t('A1 读失败：返回 ok:false，不伪装成成功', r.ok === false);
  t('A1 读失败：必须弹 err 并说「没查成」',
    toasts.some((x) => x.type === 'err' && x.msg.includes('没查成')));
  t('A1 读失败：不许出现「检测到 N 个外链」',
    !toasts.some((x) => x.msg.includes('检测到')));
  t('A1 读失败：仍刷新外链 UI（别把页签留在旧状态）', r1.refreshed === 1);
}
{
  const { api, toasts } = run(block, {
    scan: () => ({ ok: true, hosts: [{ host: 'evil.example.com', kind: 'script' }], externalEntry: true }),
  });
  await api.scanPluginExternal(PLUGINS[0]);
  t('A2 外域入口：原有警告没被修复破坏',
    toasts.some((x) => x.type === 'err' && x.msg.includes('入口是外域地址')));
}
{
  const { api, toasts } = run(block, { scan: OK2 });
  await api.scanPluginExternal(PLUGINS[0]);
  t('A3 smart 模式扫到外链：原有提示没被修复破坏',
    toasts.some((x) => x.type === 'err' && x.msg.includes('检测到 2 个外链')));
}
{
  const { api, toasts } = run(block, { scan: () => { throw new Error('fetch 抛了'); } });
  const r = await api.scanPluginExternal(PLUGINS[0]);
  t('A4 scanEntry 抛异常：不崩、如实报「没查成」',
    r.ok === false && toasts.some((x) => x.type === 'err' && x.msg.includes('没查成')));
}
{
  const { api, toasts } = run(block, { scan: OK2 });
  const r = await api.scanPluginExternal({ id: 'x', name: '无入口' });
  t('A5 没有入口地址：也如实说没查成',
    r.ok === false && toasts.some((x) => x.type === 'err' && x.msg.includes('没查成')));
}

/* B 组：设置页「重新检查」全量重扫 */
{
  let n = 0;
  const { api, toasts } = run(block, {
    plugins: PLUGINS,
    scan: () => { n++; return n === 1 ? OK2() : BAD(500); },
  });
  await api.rescanAllPlugins();
  t('B1 混合（1 成功 2 失败）：必须 err 并点名 2 个没扫成',
    toasts.some((x) => x.type === 'err' && x.msg.includes('2 个插件没扫成')));
  t('B1 混合：total 只统计成功项（登记 2 个外链）',
    toasts.some((x) => x.msg.includes('登记 2 个外链')));
  t('B1 混合：不许再报成功样式',
    !toasts.some((x) => x.type === 'ok'));
}
{
  const { api, toasts } = run(block, { plugins: PLUGINS, scan: OK2 });
  await api.rescanAllPlugins();
  t('B2 全部成功：维持原有「已检查 3 个插件，登记 6 个外链」+ ok',
    toasts.some((x) => x.type === 'ok' && x.msg.includes('已检查 3 个插件') && x.msg.includes('登记 6 个外链')));
}
{
  const { api, toasts } = run(block, { plugins: PLUGINS, scan: () => BAD(403) });
  await api.rescanAllPlugins();
  t('B3 全部失败：err 且不许谎报「已检查」',
    toasts.some((x) => x.type === 'err' && x.msg.includes('3 个插件没扫成'))
    && !toasts.some((x) => x.type === 'ok' && x.msg.includes('已检查')));
}
{
  const { api, toasts } = run(block, {
    plugins: PLUGINS,
    scan: () => { throw new Error('网络断'); },
  });
  await api.rescanAllPlugins();
  t('B4 scanEntry 抛异常：计入失败，不许吞成 0 个外链',
    toasts.some((x) => x.type === 'err' && x.msg.includes('3 个插件没扫成')));
}

/* ---------------- ③ 源码接线判据（剥注释） ---------------- */
/*
 * 注释里原样写着 ok:false 与旧 .catch 写法；不剥注释时
 * 「不许再吞成空清单」会被注释喂饱而恒绿。
 */
const flat = stripCommentsFlatJs(block);
t('接线：scanPluginExternal 判 r.ok === false', /if \(r\.ok === false\)/.test(flat));
t('接线：单次扫描有「没查成」文案', flat.includes('没查成'));
t('接线：rescan 累计 failed 并分支报 err', /failed\+\+/.test(flat) && /if \(failed\)/.test(flat));
t('接线：rescan 不再把异常 .catch 成空清单',
  !/\.catch\(\(\) => \(\{ hosts: \[\] \}\)\)/.test(flat));
t('接线：两条路径都走 scanFailure 统一收口',
  (flat.match(/\.catch\(scanFailure\)/g) || []).length === 2);

/* ---------------- ④ 反向变体：撤掉修复必须让判据失效 ---------------- */
/* V1：撤掉单次扫描的失败处理（还原成旧版） */
const V1 = block
  .replace(/  if \(!p\?\.entry\) \{[\s\S]*?\n  \}\n/, '  if (!p?.entry) return { ok: false, hosts: [] };\n')
  .replace(/  if \(r\.ok === false\) \{[\s\S]*?\n  \}\n  if \(r\.externalEntry\)/, '  if (r.externalEntry)');
t('V1 样本确实构造出旧形态', V1 !== block && !/if \(r\.ok === false\)/.test(V1.split('全量重扫')[0]));
{
  const { api, toasts } = run(V1, { scan: () => BAD() });
  await api.scanPluginExternal(PLUGINS[0]);
  t('V1 撤修复后：A1 的「必须说没查成」应失效（证明判据不恒真）',
    !toasts.some((x) => x.type === 'err' && x.msg.includes('没查成')));
}

/* V2：撤掉全量重扫的失败处理（还原成旧版 .catch 吞异常 + 无条件报成功） */
const V2 = block
  .replace('    const r = await extPolicy.scanEntry(p.entry, p.id).catch(scanFailure);\n    if (r.ok === false) { failed++; continue; }',
    '    const r = await extPolicy.scanEntry(p.entry, p.id).catch(() => ({ hosts: [] }));')
  .replace(/  if \(failed\) \{[\s\S]*?\n  \} else \{[\s\S]*?\n  \}\n/,
    "  toast(`已检查 ${list.length} 个插件，登记 ${total} 个外链`, 'ok');\n");
t('V2 样本确实构造出旧形态',
  V2 !== block && !/failed\+\+/.test(V2) && /\.catch\(\(\) => \(\{ hosts: \[\] \}\)\)/.test(V2));
{
  let n = 0;
  const { api, toasts } = run(V2, {
    plugins: PLUGINS,
    scan: () => { n++; return n === 1 ? OK2() : BAD(500); },
  });
  await api.rescanAllPlugins();
  t('V2 撤修复后：B1 的「err 且点名没扫成」应失效（证明判据不恒真）',
    !toasts.some((x) => x.type === 'err' && x.msg.includes('2 个插件没扫成'))
    && toasts.some((x) => x.type === 'ok'));
}

console.log(`\n结果：${pass}/${fail}`);
process.exit(fail ? 1 : 0);
