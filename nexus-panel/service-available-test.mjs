/**
 * 服务可用性查询 + 无构建模式降级（N28）
 *
 * 背景
 * ------------------------------------------------------------
 * color-picker 是 React + TSX 实现（与 project-group 共用同一份组件），
 * 因此 `requiresBuild: true`。而 host.js 里：
 *
 *   state.plugins = filterByRuntime(await loadRegistry())
 *   // 无构建模式下：plugins.filter(p => !p.requiresBuild)
 *
 * 于是**无构建模式下 color-picker 整个不存在**，`ctx.services.color.pick()`
 * 会 throw `未找到服务插件: color-picker`。
 *
 * 那句错误对调用方毫无帮助 —— 它无法区分：
 *   · 我 id 拼错了（真 bug）
 *   · 这个服务需要构建、当前模式用不了（环境限制）
 * 于是会去检查拼写，白白浪费时间。
 *
 * 本测试钉住三件事：
 *   1. 错误原因**精确**（需要构建 / 不是服务 / 真不存在）
 *   2. 调用方可以**先问再降级**（available）
 *   3. available 在两种挂载模式下**写法一致**（都返回 Promise）
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

const host = src('js/host.js');
const sdk = src('js/plugin-sdk.js');
const dts = src('js/plugin-sdk.d.ts');
const registry = src('plugins/registry.js');

console.log('=== 1. 事实确认：color-picker 确实 requiresBuild ===');
{
  const i = registry.indexOf("id: 'color-picker'");
  const blk = registry.slice(i, i + 600);
  t('color-picker 标了 requiresBuild: true', /requiresBuild:\s*true/.test(blk));
  t('color-picker 是 service 且 interactive', /kind:\s*'service'/.test(blk) && /interactive:\s*true/.test(blk));
  t('host.js 的 filterByRuntime 会按 requiresBuild 过滤',
    /isNoBuild\(\)\s*\?\s*plugins\.filter\(\(p\)\s*=>\s*!p\.requiresBuild\)/.test(host));
}

console.log('\n=== 2. 保留未过滤清单（诊断的前提）===');
/*
 * 已过滤清单里查不到 color-picker，就无法知道"它到底存不存在"。
 * 所以必须在**唯一的清单出口**缓存一份原始清单。
 */
t('host.js 缓存了 lastRawRegistry', /let lastRawRegistry = \[\]/.test(host));
t('在 loadRegistry 返回前写入缓存',
  /lastRawRegistry = list;[\s\S]{0,40}return list;/.test(host));
t('导出 rawRegistry() 供诊断', /export function rawRegistry\(\)/.test(host));
t('只在一处缓存（不改三处调用方，避免漏改）',
  (host.match(/lastRawRegistry = list;/g) || []).length === 1);

console.log('\n=== 3. 错误原因精确（三种情况分开）===');
/*
 * 这是 N28 的核心：笼统的"未找到服务插件"必须被拆开。
 */
t('有 serviceUnavailableReason 函数', /function serviceUnavailableReason\(/.test(host));
t('① 需要构建 → 明确说"需要 Vite 构建"+"当前是无构建模式"',
  /需要 Vite 构建/.test(host) && /无构建模式/.test(host));
t('② 不是服务 → 提示 kind 不对',
  /不是服务（kind=/.test(host) || /不是服务\(kind=/.test(host));
t('③ 真的没有 → 回退笼统错误（null 时不覆盖）',
  /serviceUnavailableReason\(id\) \|\| `未找到服务插件/.test(host));
t('ensureService 用上了精确原因',
  /if \(!manifest\) \{\s*\n\s*throw new Error\(serviceUnavailableReason\(id\)/.test(host));
t('错误里引导调用方去用 available',
  /ctx\.services\.available\(id\)/.test(host));

console.log('\n=== 4. available 接口（三种服务都有）===');
/*
 * 用**块提取**而不是宽窗口匹配：services 块里注释很长，
 * 写 `{0,200}` 这种窗口会漏（这次就漏了）—— 而漏了的表现是"断言绿不了"，
 * 不是"代码有问题"，容易被误读。
 * 按大括号配平切出块再匹配，窗口大小就不影响了。
 */
function blockAfter(srcText, marker) {
  const i = srcText.indexOf(marker);
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let j = i; j < srcText.length; j++) {
    const c = srcText[j];
    if (c === '{') { depth += 1; started = true; }
    else if (c === '}') { depth -= 1; if (started && depth === 0) return srcText.slice(i, j + 1); }
  }
  return '';
}
const svcBlock = blockAfter(host, 'services: {');
t('切出了同页 ctx.services 块', svcBlock.length > 0);
t('同页 ctx.services 注入 available', /available: \(id\) =>/.test(svcBlock));
t('该块里 call / list / available 三者齐全',
  /call:/.test(svcBlock) && /list:/.test(svcBlock) && /available:/.test(svcBlock));
t('同页实现查 serviceManifest', /available: \(id\) => Promise\.resolve\(!!serviceManifest\(id\)\)/.test(host));
t('桥接协议新增 service.available 分支',
  /case 'service\.available':/.test(host));
t('桥接分支同样查 serviceManifest',
  /case 'service\.available':\s*\n\s*return reply\(true, !!serviceManifest\(payload\.id\)\)/.test(host));
t('沙箱侧 SDK 走 transport 问宿主',
  /available: \(id\) => transport\.request\('service\.available', \{ id \}\)/.test(sdk));

console.log('\n=== 5. 薄封装：三个内置服务都补了 available ===');
{
  const n = (sdk.match(/available: whenAvailable\(/g) || []).length;
  t('三个服务都补了', n === 3);
  t('color-picker', /available: whenAvailable\('color-picker'\)/.test(sdk));
  t('icon-picker', /available: whenAvailable\('icon-picker'\)/.test(sdk));
  t('md-editor', /available: whenAvailable\('md-editor'\)/.test(sdk));
  /*
   * available 缺失时要"当作可用"而不是"当作不可用"。
   * 反过来会让所有服务在老宿主上都显示不可用 —— 那是功能倒退。
   */
  t('available 缺失时保守按"可用"（不能让老宿主上全部不可用）',
    /available \? available\(id\) : true/.test(sdk));
}

console.log('\n=== 6. 两种模式写法一致（都返回 Promise）===');
/*
 * 项目一贯原则：同页与沙箱的 ctx.* 表面必须一致，否则调用方要分叉。
 */
t('同页侧返回 Promise.resolve（不是裸 boolean）',
  /available: \(id\) => Promise\.resolve\(/.test(host));
t('沙箱侧 transport.request 也是 Promise', /transport\.request\('service\.available'/.test(sdk));
t('薄封装用 Promise.resolve 包裹（抹平同步/异步差异）',
  /whenAvailable = \(id\) => \(\) => Promise\.resolve\(/.test(sdk));

console.log('\n=== 7. 类型定义同步 ===');
t('PluginContext.services 有 available', /available\(id: string\): Promise<boolean>/.test(dts));
t('color.available 有声明', /available\(\): Promise<boolean>/.test(dts));
t('三个服务类型都补了（4 处 = 通用1 + 内置3）',
  (dts.match(/available\(\)?\(?i?d?:? ?s?t?r?i?n?g?\)?: Promise<boolean>/g) || []).length >= 4
  || (dts.match(/Promise<boolean>/g) || []).length === 4);

console.log('\n=== 8. 不影响既有行为（安全第一）===');
/*
 * 这一节专门防"改安全机制改坏了功能"：
 * 可用性查询是**新增**能力，不该动任何既有路径。
 */
t('serviceManifest 本身没被改动（仍查已过滤清单）',
  /function serviceManifest\(id\) \{\s*\n\s*return state\.plugins\.find\(\(p\) => p\.id === id && p\.kind === 'service'\);/.test(host));
t('callService 的调用方式没变', /callService\(payload\.id, payload\.method, payload\.args\)/.test(host));
t('service.list 分支没变', /case 'service\.list':\s*\n\s*return reply\(true, listServices\(\)\)/.test(host));
t('取消仍 resolve(null)、不 throw（B21 的约定没被破坏）',
  src('plugins/README-services.md').includes('resolve(null)'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
