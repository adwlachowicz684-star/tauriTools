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

/** 剥掉注释，只留代码。
 * 为什么需要：源码里"提到某个字符串"（比如注释里写"此前是 #3E63DD"）
 * 与"代码里真的用了它"是两回事。断言必须只匹配后者，
 * 否则会出现"改了代码但注释还在 → 断言仍红"或反过来"注释蒙混过关"。
 * 逐行正则治不了块注释跨行，所以用状态机。 */
const stripComments = (t) => {
  let out = '', i = 0;
  while (i < t.length) {
    if (t[i] === '/' && t[i + 1] === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i += 1; i += 2; continue; }
    if (t[i] === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i += 1; continue; }
    out += t[i]; i += 1;
  }
  return out;
};
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

/* kind 写错（如 'services'）不会报任何错 ——
   判定是 `kind !== 'service'`，写错就静默当成 app 显示在侧边栏。
   这种"改了没反应、也不知道哪错了"的情况必须有测试挡住。 */
const KIND_VALUES = [...regSrc.matchAll(/^\s*kind:\s*'([^']+)'/gm)].map((m) => m[1]);
t('registry 里所有 kind 都是合法值',
  KIND_VALUES.length > 0 && KIND_VALUES.every((v) => v === 'app' || v === 'service'),
  KIND_VALUES.join(','));
t('至少有一个 service', KIND_VALUES.includes('service'));

/* interative / interactve 这类拼写错误同样静默失效：
   宿主读 inst.manifest?.interactive，拼错就是 undefined → 服务永不显示，
   用户看到"点了没反应"而代码毫无异常。

   写法说明：先抠出 registry 里所有形如 `xxx:` 的键名，
   再挑出"以 inter 开头但拼得不对 interactive"的那些。
   不要试图用一条大正则同时表达"排除正确的 + 匹配错误的" ——
   我上一版就是这么写的，结果破坏时它没红（被另一条断言红的掩盖了），
   属于典型的"断言没真正生效"。 */
const KEYS = [...regSrc.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*):/gm)].map((m) => m[1]);
const TYPOS = KEYS.filter((k) => k.toLowerCase().startsWith('inter') && k !== 'interactive');
t('registry 没有 interactive 的拼写错误', TYPOS.length === 0, TYPOS.join(',') || '无');
/* 反向确认：抠键名这条正则本身是有效的（registry 里本就有 interactive） */
t('抠键名的正则有效（能取到 interactive）', KEYS.includes('interactive'),
  `共 ${KEYS.length} 个键`);

console.log('\n=== 2. 服务必须真实挂载（不能 display:none）===');
/* iframe 只有在文档里才会加载运行。用 display:none 的话，
   部分浏览器会延迟甚至跳过加载 → 服务永远握不上手。
   所以要"移出视口"而不是"不显示"。 */
t('宿主创建了服务容器并插入 DOM', /serviceHost.*appendChild|appendChild\(serviceHost\)/.test(hostSrc));
t('容器用移出视口而非 display:none',
  /position:absolute;left:-99999px/.test(hostSrc) && !/display:\s*none/.test(hostSrc.slice(
    hostSrc.indexOf("serviceHost.style.cssText"), hostSrc.indexOf("serviceHost.style.cssText") + 200)));

/* 类型定义要跟上 —— 不然 TS 侧写 p.kind 会报错，
   或者更糟：有人用 any 绕过去，分类就又变成口头约定了。 */
const dtsSrc = src('js/host.d.ts');
t('PluginManifest 有 kind 类型', /kind\?: 'app' \| 'service';/.test(dtsSrc));
t('PluginManifest 有 interactive 类型', /interactive\?: boolean;/.test(dtsSrc));
/* 注释里要写明"不看目录位置" —— 这是本轮定的口径，
   不写下来下次有人又会想按目录分。 */
t('类型注释说明分类不看目录', /不看目录位置/.test(dtsSrc));

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
t('buildCtx 优先用注入的 services',
  /services: withBuiltinShortcuts\(base\.services \|\|/.test(sdkSrc));
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

console.log('\n=== 10. 插件面板（替换原「添加插件」对话框）===');
/* 用户选定：不新增侧边栏项，而是把「＋ 添加插件」对话框扩成完整面板。 */
const dlgSrc = src('src/components/AddPluginDialog.tsx');
t('registry 里不再有 store 侧边栏项', !/id: 'store'/.test(regSrc));
t('对话框接收完整插件列表（含服务）', /plugins: PluginManifest\[\]/.test(dlgSrc));
t('对话框支持移除插件', /onRemove: \(id: string\) => void/.test(dlgSrc));
t('对话框分应用/服务两区',
  /kind !== 'service'/.test(dlgSrc) && /kind === 'service'/.test(dlgSrc));
t('对话框说明服务插件用途', /ctx\.services\.call/.test(dlgSrc));
t('对话框预留联网商店', /在线目录|联网安装|在线插件目录/.test(dlgSrc));
t('App 传入完整列表而非过滤后的',
  /plugins=\{hostRef\.current\?\.state\.plugins/.test(appSrc));
t('原生版也扩成了面板', /插件面板（商店）/.test(shellSrc));
t('原生版也分两区', /应用插件/.test(shellSrc) && /服务插件/.test(shellSrc));

console.log('\n=== 10b. 交互服务必须能露面 ===');
/* 色盘/图标/md 这类服务**必须用户看得见才用得了**，
   而服务平时挂在移出视口的容器里 —— 不临时显示就是"点了没反应"。 */
t('宿主有 showServiceUi', /function showServiceUi/.test(hostSrc));
t('按 interactive 标记决定是否显示',
  /const interactive = !!inst\.manifest\?\.interactive;/.test(hostSrc));
/* 必须钉住"真的调用了 showServiceUi(true)"这一行。
   上面那条只钉 const interactive 的声明 —— 我破坏时只改了调用行、
   没改声明行，结果那条**没红**（是另一条红的），说明这里有覆盖盲区。
   两条都要有：声明决定"要不要显示"，调用决定"真的显示了没"。 */
t('真的调用了 showServiceUi(true)',
  /if \(interactive\) showServiceUi\(true\);/.test(hostSrc));
t('用 finally 保证收回浮层（漏收会永远盖住界面）',
  /if \(interactive\) showServiceUi\(true\);[\s\S]{0,200}finally[\s\S]{0,120}showServiceUi\(false\)/.test(hostSrc));
t('有遮罩元素', /nexus-service-mask/.test(hostSrc));
t('点遮罩可退出（给服务没放取消按钮时留退路）',
  /serviceMask\.addEventListener\('click'/.test(hostSrc));
t('registry 里三个交互服务都标了 interactive',
  /id: 'color-picker'[\s\S]{0,240}interactive: true/.test(regSrc)
  && /id: 'icon-picker'[\s\S]{0,240}interactive: true/.test(regSrc)
  && /id: 'md-editor'[\s\S]{0,240}interactive: true/.test(regSrc));

console.log('\n=== 10c. 薄封装（用户选定：通用 call + 内置快捷方式）===');
t('SDK 有 withBuiltinShortcuts', /function withBuiltinShortcuts/.test(sdkSrc));
t('薄封装应用到了 services',
  /services: withBuiltinShortcuts\(/.test(sdkSrc));
for (const [ns, m] of [['color', 'pick'], ['icon', 'browse'], ['md', 'edit']]) {
  t(`${ns}.${m} 快捷方式存在`,
    new RegExp(`${ns}: \\{[\\s\\S]{0,400}${m}:`).test(sdkSrc));
}
/* 底层 call 必须**保留** —— 第三方服务靠它接入，
   薄封装只是便利层，不能把通用入口盖掉。 */
t('底层通用 call 未被薄封装取代',
  /call: \(id, method, args\)/.test(sdkSrc) && /\.\.\.services/.test(sdkSrc));

console.log('\n=== 10d. 色盘：共享组件，不是两份实现 ===');
/*
 * 关键改动：完整色盘从 project-group 搬到 color-picker，
 * 内联用法与服务用法**共用同一个组件**。
 *
 * 为什么不是"内联改成调服务"：内联的价值是实时预览（拖动时外面卡片跟着变），
 * 模态弹窗拿不到中间态，改过去就是降级。
 */
t('色盘组件已搬到 color-picker', has('plugins/color-picker/ColorPicker.tsx'));
t('SV 面板/色相条也已搬过去', has('plugins/color-picker/SvPanel.tsx'));
t('project-group 不再自带色盘组件',
  !has('plugins/project-group/components/ColorPicker.tsx')
  && !has('plugins/project-group/components/SvPanel.tsx'));
t('project-group 改为引用共享组件',
  /from '\.\.\/\.\.\/color-picker\/ColorPicker'/.test(src('plugins/project-group/components/dialogs.tsx')));

/* 颜色定义只应有一份：在 color-picker/color.ts */
const sharedColor = src('plugins/color-picker/color.ts');
t('共享 color.ts 导出 PRESET_COLORS', /export const PRESET_COLORS/.test(sharedColor));
t('project-group/utils/color 改为转发（不再自带定义）',
  /export \* from/.test(src('plugins/project-group/utils/color.ts'))
  && !/export const PRESET_COLORS = \[/.test(src('plugins/project-group/utils/color.ts')));

/* 依赖方向必须单向：project-group → color-picker，不能有反向。
   反向会让"服务"反过来依赖业务插件，将来独立分发时拆不开。

   只查代码、不查注释（注释里提到 project-group 说明从哪搬来，正常）。
   剥注释用逐字符状态机 —— 逐行正则治不了块注释跨行，我前两版都栽在这。 */
const cpCode = (() => {
  const t = src('plugins/color-picker/ColorPicker.tsx');
  let out = '', i = 0;
  while (i < t.length) {
    if (t[i] === '/' && t[i + 1] === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i += 1; i += 2; continue; }
    if (t[i] === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i += 1; continue; }
    out += t[i]; i += 1;
  }
  return out;
})();
t('色盘服务不依赖 project-group（代码里）', !/project-group/.test(cpCode));

console.log('\n=== 10e. 服务弹窗用共享组件（不是弱化版）===');
const mainTsx = src('plugins/color-picker/main.tsx');
t('服务入口是 React 版', /bootServiceReactPlugin/.test(mainTsx));
t('服务渲染共享的 ColorPicker', /from '\.\/ColorPicker'/.test(mainTsx)
  && /<ColorPicker/.test(mainTsx));
t('服务引了共享样式', /import '\.\/style\.css'/.test(mainTsx));
/* 纯计算不该走跨 iframe —— 直接 import 本地函数，零异步开销 */
t('normalize 是本地计算不走消息', /normalizeHex\(color\)/.test(mainTsx));
/* 吸管能力对齐：两段式待命在共享组件里，服务自然也有 */
t('共享色盘有吸管待命态（不是一点就取）',
  /armed/.test(src('plugins/color-picker/ColorPicker.tsx'))
  && /fpx_pick_color/.test(src('plugins/color-picker/ColorPicker.tsx')));
/* JSX 属性是 type="number"（双引号），不是 JS 对象的 type: 'number'。
   我第一版写错了写法 → 恒假。 */
t('共享色盘有 RGB 数字输入',
  /type="number"/.test(src('plugins/color-picker/ColorPicker.tsx')));

console.log('\n=== 10g. 服务模态也能实时预览 ===');
/*
 * 此前有个误解要澄清：组件抽出来后，**内联用法本来就能实时预览**。
 * 真正的限制只在"服务模态"这个用法 —— pick() 只在点确定时 resolve 一次，
 * 中间的 onChange 没往外传。
 *
 * 但这不是架构死限制：服务 ctx.emit → 宿主 publish → 广播给调用方，
 * 链路是通的。所以补了 previewEvent —— 给了就每次变化喊一声。
 *
 * 结论：**模态也能实时预览**，只要调用方订阅。
 */
t('pick 支持 previewEvent', /previewEvent/.test(mainTsx));
t('onChange 里真的 emit 了',
  /emitFn\(current\.previewEvent, hex\)/.test(mainTsx));
t('pick 把 ctx.emit 与 ctx.store 传进会话',
  /openSession\(args, ctx\?\.emit, ctx\?\.store\)/.test(mainTsx));
/* 不给就不发 —— 避免每个服务调用都往总线上广播 */
t('未给 previewEvent 时不广播',
  /if \(current\?\.previewEvent && current\?\.emitFn\)/.test(mainTsx));

/* 链路两端都要在：服务侧 emit、调用侧 on。
   只钉一边的话，另一边漏了照样没用。 */
t('SDK 的 emit 会转发给宿主（publish）',
  /type: 'publish'/.test(src('js/plugin-sdk.js')));
t('宿主收到 publish 会广播',
  /case 'publish':[\s\S]{0,120}bus\.emit/.test(src('js/host.js')));
t('宿主会把订阅的事件发回 iframe',
  /type: 'event', event: d\.event, payload/.test(src('js/host.js')));

console.log('\n=== 10h. 服务与内联「体感一致」===');
/*
 * 目标：别的插件调服务，跟 project-group 内联用，看到的东西要一样。
 * 下面每一条都是一个"不一样就会被用户察觉"的点。
 */
const cpMain = src('plugins/color-picker/main.tsx');

/* ① 起始色：两边必须同一个常量。
    此前内联 #7C8CFF、服务 #3E63DD —— 同一个"默认"两个颜色。 */
t('DEFAULT_COLOR 在共享模块里', /export const DEFAULT_COLOR/.test(sharedColor));
/* 注释里提到 '#3E63DD' 是说明历史，不算 —— 必须剥注释后看代码 */
t('服务不再硬编码别的起始色',
  !/'#3E63DD'/.test(stripComments(cpMain)) && /DEFAULT_COLOR/.test(cpMain));
t('内联色盘也不再自带起始色定义',
  !/const DEFAULT_COLOR = /.test(src('plugins/color-picker/ColorPicker.tsx')));

/* ② 自定义常用色要持久化。React 化时丢过一次 ——
    不存的话收藏的色关掉面板就没了，而内联是存进配置里的。 */
t('服务会持久化自定义色', /storeSlot\?\.set\('custom'/.test(cpMain));
t('服务会读取已存的自定义色', /store\.get\('custom'/.test(cpMain));

/* ③ "未设置颜色"要显示「默认」标记，不能被归一化成一个具体色。
   必须钉**两处具体的赋值/渲染**，只钉 /showDefaultTag/ 是不行的：
   类型定义、useState 里也会出现这个词（我第一版就是这么写的，
   破坏时删掉赋值那行，断言仍被别处的出现蒙混 → 假绿）。 */
t('服务保留未设置态：把 isUnset 传进 view',
  /showDefaultTag: isUnset/.test(cpMain));
t('服务保留未设置态：真正影响 ColorPicker 的 value',
  /value=\{view\.showDefaultTag \? null : view\.initial\}/.test(cpMain));

/* ④ 吸管、RGB 输入框这些能力（已在 10e 验证共享组件自带）——
    这里只钉"服务没有把它们关掉" */
t('服务没有传 compact 关掉功能', !/compact/.test(cpMain));

console.log('\n=== 10i. 搬迁没留下悬空引用 ===');
/* dialogs.tsx 曾残留 api={api} —— 组件已不接受这个 prop，
   传了是 TS 错（也是"以为传了其实没用"的错觉来源）。 */
const dlgSrc2 = src('plugins/project-group/components/dialogs.tsx');
const pickerUse = dlgSrc2.slice(dlgSrc2.indexOf('<ColorPicker'));
t('dialogs 不再传 api（组件已不接受）', !/api=\{api\}/.test(pickerUse));
/* bootIframePlugin 的 d.ts 曾只有 2 个参数，而 JS 实现有 3 个 ——
   声明落后于实现会让"其实能跑"的代码看起来是错的。 */
t('bootIframePlugin 声明含第三个参数',
  /serviceMethods\?:/.test(src('js/plugin-sdk.d.ts')));

console.log('\n=== 10j. 调用约定：取消返回 null，不抛异常 ===');
/*
 * 目标：调用方能"一行调起"，不写 try/catch。
 *
 * 取消是正常流程（用户点了取消），用异常表达会逼得每个调用方都
 * try/catch，漏了就是 unhandled rejection。所以统一为 resolve(null)。
 * 真出错（服务没装/超时/崩溃）才 reject。
 */
const strip = (t) => {
  let out = '', i = 0;
  while (i < t.length) {
    if (t[i] === '/' && t[i + 1] === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i += 1; i += 2; continue; }
    if (t[i] === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i += 1; continue; }
    out += t[i]; i += 1;
  }
  return out;
};
const cpMainCode = strip(src('plugins/color-picker/main.tsx'));
t('取色服务取消不 reject', !/reject\(new Error\('已取消'\)\)/.test(cpMainCode));
t('取色服务取消 resolve(null)', /resolve\(null\)/.test(cpMainCode));
/* 另两个服务同样要遵守 —— 只改一个的话，调用方换个服务就又得 try/catch */
for (const [f, label] of [['plugins/icon-picker/index.js', '图标'], ['plugins/md-editor/index.js', 'md']]) {
  const c = strip(src(f));
  t(`${label} 服务取消不 reject`, !/reject\(new Error\('已取消'\)\)/.test(c));
  t(`${label} 服务取消 resolve(null)`, /resolve\(null\)/.test(c));
}

console.log('\n=== 10k. 薄封装：调用方不用做额外工作 ===');
const sdk = strip(src('js/plugin-sdk.js'));
/* 懒加载：谁被调才挂谁 —— 调用方不需要先 ensure/list */
t('宿主侧服务懒加载（ensureService 自动挂载）',
  /async function ensureService/.test(src('js/host.js')));
/* 交互浮层的显示/收回由宿主按 interactive 自动处理，调用方不用管 */
t('交互浮层由宿主自动显示/收回',
  /const interactive = !!inst\.manifest\?\.interactive/.test(src('js/host.js'))
  && /showServiceUi\(true\)/.test(src('js/host.js')));
t('浮层收回在 finally 里（异常也不漏）',
  /finally \{[\s\S]{0,120}showServiceUi\(false\)/.test(src('js/host.js')));
/* 薄封装要能传 previewEvent，否则实时预览这个能力在薄封装下用不了 */
t('pick 薄封装支持第二参（previewEvent 等）',
  /pick: \(initial, opts\) => call\('color-picker', 'pick', \{ initial, \.\.\./.test(sdk));
t('color 薄封装补齐 hsv', /hsv: \(color\) => call/.test(sdk));
/* 类型必须同步 —— 不同步的话 TS 侧拿到的是旧的 Promise<string>，
   写 if (hex) 会被告知"永远为真"，取消判断就被静默忽略了 */
const sdkDts2 = src('js/plugin-sdk.d.ts');
t('pick 类型返回 string | null', /pick\(initial\?: string \| null[\s\S]{0,400}Promise<string \| null>/.test(sdkDts2));
t('browse 类型返回可空', /Promise<\{ name: string; url: string \} \| null>/.test(sdkDts2));
t('edit 类型返回可空', /edit\(text\?: string, title\?: string\): Promise<string \| null>/.test(sdkDts2));

console.log('\n=== 10f. SDK 类型覆盖 services ===');
const sdkDts = src('js/plugin-sdk.d.ts');
t('PluginContext 有 services', /services: \{/.test(sdkDts));
t('services 有通用 call', /call\(id: string, method: string/.test(sdkDts));
for (const ns of ['color', 'icon', 'md']) {
  t(`services 有 ${ns} 薄封装类型`, new RegExp(`${ns}: \\{`).test(sdkDts));
}

console.log('\n=== 11. 三个真实服务已就位 ===');
t('demo-service 有 index.js', has('plugins/demo-service/index.js'));
const demoSrc = src('plugins/demo-service/index.js');
t('用 bootServicePlugin 声明', /bootServicePlugin\(\{/.test(demoSrc));
t('提供了方法', /async pick\(|async describe\(|async shade\(/.test(demoSrc));

console.log('\n=== 12. 语法（node --check，权威）===');
for (const f of ['js/host.js', 'js/plugin-sdk.js', 'plugins/registry.js',
  'js/shell.js', 'plugins/demo-service/index.js',
  'plugins/icon-picker/index.js',
  'plugins/md-editor/index.js',]) {
  let ok = true;
  try { execSync(`node --check ${JSON.stringify(f)}`, { cwd: HERE, stdio: 'pipe' }); }
  catch { ok = false; }
  t(`${f} 语法正确`, ok);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：只检查接线，**不能**替代浏览器里的真实调用验证。');
process.exit(fail ? 1 : 0);
