/**
 * 服务插件（kind:'service'）回归测试
 * ------------------------------------------------------------
 * 服务插件：不显示在侧边栏，被挂到隐藏的常宿容器里，
 * 由任意插件通过 ctx.services.call(id, method, args) 调用。
 *
 * 纯前端，但**没有浏览器可跑**，做的是源码级接线检查。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const has = (p) => fs.existsSync(path.join(HERE, p));

const hostSrc = src('js/host.js');
const sdkSrc = src('js/plugin-sdk.js');
const regSrc = src('plugins/registry.js');
const shellSrc = src('js/shell.js');
const appSrc = src('src/App.tsx');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

console.log('\n=== 1. 注册表：服务有独立 kind ===');
t('registry 声明了 kind 字段', /\*\s*kind\s+'app'（默认/.test(regSrc) || /kind\s+'app'/.test(regSrc));
t('有 demo-service 服务插件', /id: 'demo-service'/.test(regSrc));
t('demo-service 标记 kind:service', /kind: 'service'/.test(regSrc));

console.log('\n=== 2. 服务必须真实挂载（不能 display:none）===');
/* iframe 只有在文档里才会加载运行。用 display:none 的话，
   部分浏览器会延迟甚至跳过加载 → 服务永远握不上手。
   所以要"移出视口"而不是"不显示"。 */
t('宿主创建了服务容器并插入 DOM', /serviceHost.*appendChild|appendChild\(serviceHost\)/.test(hostSrc));
t('容器用移出视口而非 display:none',
  /position:absolute;left:-99999px/.test(hostSrc) && !/display:\s*none/.test(hostSrc.slice(
    hostSrc.indexOf("serviceHost.style.cssText"), hostSrc.indexOf("serviceHost.style.cssText") + 200)));

console.log('\n=== 3. 懒加载 + 并发去重 ===');
/* 服务可能有十几个，启动全挂会很慢。谁被调才挂谁。
   首次调用常是并发到达（多个插件同时要色盘），
   所以挂载中的 Promise 要入表供后来者复用，否则会重复挂载。 */
t('有 ensureService（懒加载入口）', /async function ensureService\(/.test(hostSrc));
t('挂载中的 Promise 先入表再 await',
  /services\.set\(id, entry\)/.test(hostSrc));
t('已有实例直接复用（不重复挂载）',
  /const existing = services\.get\(id\);\s*\n\s*if \(existing\) return existing;/.test(hostSrc));

console.log('\n=== 4. 两种挂载形态都要能调 ===');
/* iframe 服务走 service.call 消息；module 服务直接调 def.methods。
   调用方写法必须完全一致 —— 否则换挂载方式就得改调用方。 */
t('有 callService 统一入口', /async function callService\(/.test(hostSrc));
t('iframe 通路：发 service.call 并等 res',
  /send\(iframe, \{ type: 'service\.call'/.test(hostSrc));
t('module 通路：直接调 def.methods',
  /inst\.def\?\.methods\?\.\[method\]/.test(hostSrc));
t('方法不存在时明确报错', /未提供方法/.test(hostSrc));

console.log('\n=== 5. 超时必须清理（否则永远悬着）===');
/* 调用方 await 一个永不 settle 的 Promise，界面就是"点了没反应"，
   而且没有任何错误提示 —— 比报错难查得多。 */
t('服务调用有超时', /服务调用超时/.test(hostSrc));
t('超时后从等待表删除', /serviceCalls\.delete\(id\)/.test(hostSrc));

console.log('\n=== 6. 服务调用必须回包（无论成败）===');
/* 漏回一条 = 调用方挂到超时。SDK 侧那个 reply 必须覆盖成功与失败两条路。 */
const svcSeg = sdkSrc.slice(sdkSrc.indexOf("if (d.type === 'service.call')"));
const svcBody = svcSeg.slice(0, svcSeg.indexOf('\n    }\n'));
t('SDK 处理 service.call', /d\.type === 'service\.call'/.test(sdkSrc));
/* 必须钉住"方法找不到"这条具体的回包。
   此前我写的是 `reply\(false` —— 但 catch 分支里也有一条 reply(false,...)，
   所以把"找不到方法"那条删掉，断言照样绿（**假绿**）。
   这与 B1（测试复刻模板）、theme-bridge（窗口扫描）是同一类坑：
   宽泛匹配会被"另一处仍有"蒙混。 */
t('方法找不到时回包（不是静默忽略）',
  /typeof fn !== 'function'/.test(svcBody) && /服务未提供方法/.test(svcBody));
t('成功回包', /reply\(true, data, null\)/.test(svcBody));
t('异常回包', /reply\(false, null, String/.test(svcBody));
t('把 ctx 交给服务方法', /fn\(d\.args, ctxReady\)/.test(svcBody));

console.log('\n=== 7. SDK 有 bootServicePlugin ===');
t('导出 bootServicePlugin', /export function bootServicePlugin/.test(sdkSrc));
t('它复用 bootIframePlugin（握手/主题/ctx 不重造）',
  /return bootIframePlugin\(/.test(sdkSrc.slice(sdkSrc.indexOf('export function bootServicePlugin'))));

console.log('\n=== 8. 调用方两侧都能拿到 ctx.services ===');
t('iframe ctx 有 services.call', /call: \(id, method, args\) =>\s*\n\s*transport\.request\('service\.call'/.test(sdkSrc));
t('module ctx 接受注入的 services',
  /services = null,/.test(sdkSrc) && /services, {2,}\/\/ 同页插件/.test(sdkSrc));
/* buildCtx 要**优先用注入的** services —— 只加参数不生效的话，
   module 插件仍会走桥接，而 module 的 transport 没有 service.call 分支，
   表现为"调用服务报未知请求"。 */
t('buildCtx 优先用注入的 services', /services: base\.services \|\|/.test(sdkSrc));
t('宿主给 module ctx 注入了 services',
  /services: \{\s*\n\s*call: \(id, method, args\) => callService/.test(hostSrc));
t('宿主桥接转发 service.call（沙箱插件才能调）',
  /case 'service\.call': \{\s*\n\s*const data = await callService/.test(hostSrc));

console.log('\n=== 9. 服务不显示在侧边栏 ===');
t('有 visiblePlugins 过滤', /export function visiblePlugins/.test(hostSrc));
t('过滤条件是 kind !== service', /p\.kind !== 'service'/.test(hostSrc));
t('原生外壳用它渲染侧边栏', /visiblePlugins\(host\.getPlugins\(\)\)/.test(shellSrc));
t('React 外壳用它设置列表', /setPlugins\(visiblePlugins\(/.test(appSrc));
/* 只过滤渲染是不够的：快捷键、恢复上次插件等路径都会绕过侧边栏 */
t('mount 本身拒绝服务插件（不只靠侧边栏）',
  /manifest\?\.kind === 'service'/.test(hostSrc));

console.log('\n=== 10. 插件商店面板 ===');
t('store 插件已注册', /id: 'store'/.test(regSrc));
t('store 是内置应用插件（非服务）',
  /id: 'store'[\s\S]{0,300}builtin: true/.test(regSrc));
t('store 有入口文件', has('plugins/store/index.js') && has('plugins/store/index.html'));
const storeSrc = src('plugins/store/index.js');
t('store 分应用/服务两区展示',
  /kind !== 'service'/.test(storeSrc) && /kind === 'service'/.test(storeSrc));
t('store 说明服务插件的用途', /ctx\.services\.call/.test(storeSrc));
t('store 有添加自定义插件入口', /添加自定义插件/.test(storeSrc));
t('store 注明未来接联网商店', /联网商店|联网安装/.test(storeSrc));

console.log('\n=== 11. demo 服务可调用 ===');
t('demo-service 有 index.js', has('plugins/demo-service/index.js'));
const demoSrc = src('plugins/demo-service/index.js');
t('用 bootServicePlugin 声明', /bootServicePlugin\(\{/.test(demoSrc));
t('提供了方法', /async pick\(|async describe\(|async shade\(/.test(demoSrc));

console.log('\n=== 12. 语法（node --check，权威）===');
for (const f of ['js/host.js', 'js/plugin-sdk.js', 'plugins/registry.js',
  'js/shell.js', 'plugins/store/index.js', 'plugins/demo-service/index.js']) {
  let ok = true;
  try { execSync(`node --check ${JSON.stringify(f)}`, { cwd: HERE, stdio: 'pipe' }); }
  catch { ok = false; }
  t(`${f} 语法正确`, ok);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：只检查接线，**不能**替代浏览器里的真实调用验证。');
process.exit(fail ? 1 : 0);
