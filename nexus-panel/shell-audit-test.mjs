/**
 * 主窗口外壳审查项回归测试（开发用，可删）
 *
 * 对应《主窗口 · Vanilla 外壳 问题清单》里能用 jsdom / 源码断言覆盖的条目。
 * 每条都能被"故意破坏"验证 —— 否则断言只是装饰。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const hostSrc = src('js/host.js');
const sdkSrc = src('js/plugin-sdk.js');
const tmSrc = src('js/theme-manager.js');
const coreSrc = src('js/tauri-core.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ============ P0-1 · message 监听的来源校验 ============ */
console.log('\n=== P0-1 消息来源校验 ===');
/* host.js：bridgeHandler 内校验 e.source === iframe.contentWindow。
   注意要**先切出 bridgeHandler 块**再判断，否则会命中别处的相似代码。 */
const bhStart = hostSrc.indexOf('bridgeHandler = (e) => {');
const bhBlock = bhStart < 0 ? '' : hostSrc.slice(bhStart, hostSrc.indexOf('switch (d.type)', bhStart));
t('host: bridgeHandler 定位成功', bhStart >= 0);
t('host: 校验 e.source === iframe.contentWindow',
  /e\.source\s*!==\s*iframe\.contentWindow/.test(bhBlock), bhBlock ? '已含' : '未定位');

/* plugin-sdk：window.parent 是唯一合法来源 */
const sdkStart = sdkSrc.indexOf("window.addEventListener('message', (e) => {");
const sdkBlock = sdkStart < 0 ? '' : sdkSrc.slice(sdkStart, sdkStart + 900);
t('sdk: 校验 e.source === window.parent',
  /e\.source\s*!==\s*window\.parent/.test(sdkBlock), sdkBlock ? '已含' : '未定位');

/* ============ P0-2 · postMessage 目标 origin ============ */
console.log('\n=== P0-2 postMessage 目标 origin ===');
t('host: send 不再硬编码 "*"',
  !/postMessage\(\s*\{[^}]*\}\s*,\s*'\*'\s*\)/.test(hostSrc));
t('host: 按隔离与否取 targetOrigin', /function targetOriginFor/.test(hostSrc));
t('host: 非隔离用精确 origin',
  /dataset\.isolated === '1' \? '\*' : \(window\.location\.origin/.test(hostSrc));
t('sdk: post 用 hostOrigin 变量而非字面量',
  /window\.parent\.postMessage\(\{\s*channel,\s*\.\.\.msg\s*\},\s*hostOrigin\s*\)/.test(sdkSrc));
t('host: init 消息下发 hostOrigin', /hostOrigin:\s*window\.location\.origin/.test(hostSrc));
t('sdk: init 时接收 hostOrigin', /if \(d\.hostOrigin\) hostOrigin = d\.hostOrigin;/.test(sdkSrc));

/* ============ P0-3 · webhook 空口令防护 ============ */
console.log('\n=== P0-3 webhook 浏览器防护 ===');
const rsSrc = src('src-tauri/src/af_flow.rs');
t('Rust: 定义了浏览器防护头常量', /const BROWSER_GUARD_HEADER/.test(rsSrc));
t('Rust: 空 token 时不再无条件放行',
  !/if expected\.is_empty\(\) \{\s*return true;/.test(rsSrc));
/* 先切出 token_ok 函数体再判断，**不要**用「N 个字符窗口」在整份源码上匹配。

   原写法是 `expected\.is_empty\(\)[\s\S]{0,800}?BROWSER_GUARD_HEADER`，
   在整份 af_flow.rs 上搜：两者之间隔了一段中文注释，实际 319 字符，
   超出 200 窗口 → 恒红。于是出现最糟的一类假红：**代码是对的，测试是错的**，
   而且它会被当成"防护缺失"去追 —— 我正是据此误报过一次。

   把窗口放宽到 800 也能解决当下，但注释再长一点就又红了 ——
   守的是注释长度，不是结论。切函数体则与注释长度无关。 */
const tokStart = rsSrc.indexOf('fn token_ok');
const tokBody = tokStart < 0 ? '' : rsSrc.slice(tokStart, rsSrc.indexOf('\n}', tokStart));
t('Rust: 空 token 时要求防护头',
  /expected\.is_empty\(\)[\s\S]*?BROWSER_GUARD_HEADER/.test(tokBody));
t('Rust: 防护头常量值小写（HTTP 头名大小写不敏感，但别写成别的名字）',
  /const BROWSER_GUARD_HEADER:\s*&str\s*=\s*"x-nexus-webhook"/.test(rsSrc));
/* 扫整个 components 树：上游把各节点的检查器拆进了 components/inspectors/，
   写死 Inspector.tsx 会在重构后误报"防护头提示没了"，其实只是搬了家。 */
const afCompText = (function walk(dir) {
  return fs.readdirSync(path.join(HERE, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    return d.isDirectory() ? walk(rel) : [src(rel)];
  }).join('\n');
})('plugins/agent-flow/components');
t('前端: 提示调用需带防护头', /X-Nexus-Webhook/.test(afCompText));

/* ============ P1-4 · findTheme 不自递归 ============ */
console.log('\n=== P1-4 findTheme 兜底 ===');
const ftStart = tmSrc.indexOf('export function findTheme');
const ftBody = ftStart < 0 ? '' : tmSrc.slice(ftStart, tmSrc.indexOf('\n}', ftStart));
t('findTheme 函数体内无自递归调用', !/findTheme\s*\(/.test(ftBody.replace(/export function findTheme/, '')));
t('findTheme 有三级兜底（含 PRESET_THEMES[0]）', /PRESET_THEMES\[0\]/.test(ftBody));

const tm = await import('./js/theme-manager.js');
t('对不存在的 id 仍能返回有效主题', !!tm.findTheme('__definitely_missing__')?.id,
  tm.findTheme('__definitely_missing__')?.id);

/* ============ P1-5 · 存储反序列化兜底 ============ */
console.log('\n=== P1-5 存储反序列化 ===');
// host 与 sdk 的 store.get / store.all 都要能吞掉坏数据
const storeGetHost = hostSrc.slice(hostSrc.indexOf("case 'store.get':"), hostSrc.indexOf("case 'store.set':"));
t('host store.get 有 try/catch', /catch/.test(storeGetHost));
const storeAllHost = hostSrc.slice(hostSrc.indexOf("case 'store.all':"), hostSrc.indexOf('case \'shell.call\''));
t('host store.all 有 try/catch', /catch/.test(storeAllHost));
const storeAllSdk = sdkSrc.slice(sdkSrc.indexOf("case 'store.all':"), sdkSrc.indexOf('default:', sdkSrc.indexOf("case 'store.all':")));
t('sdk store.all 有 try/catch', /catch/.test(storeAllSdk));

// 行为级：坏 JSON 不炸
localStorage.setItem('nexus:probe-plugin:good', '{"a":1}');
localStorage.setItem('nexus:probe-plugin:bad', '{坏了');
function safeParse(raw, def) {
  if (raw == null) return def;
  try { return JSON.parse(raw); } catch { return def; }
}
t('坏 JSON 退默认值而非抛错', safeParse(localStorage.getItem('nexus:probe-plugin:bad'), 'FALLBACK') === 'FALLBACK');
t('好 JSON 正常解析', safeParse(localStorage.getItem('nexus:probe-plugin:good'), null)?.a === 1);
localStorage.removeItem('nexus:probe-plugin:good');
localStorage.removeItem('nexus:probe-plugin:bad');

/* ============ P1-6 · 侧边栏监听器（经实证不成立，钉住行为） ============ */
console.log('\n=== P1-6 侧边栏监听器（实证：不成立） ===');
t('renderSidebar 用 innerHTML="" 清空（节点连监听器一起丢弃）',
  /list\.innerHTML = '';/.test(src('js/shell.js')));

/* ============ 附加 · .p-card 的 backdrop-filter 层叠陷阱 ============ */
console.log('\n=== backdrop-filter 与 fixed 浮层 ===');
const css = src('css/neumorphism.css');

/* 定位那条 backdrop-filter 规则（含 -webkit- 前缀的声明） */
const bfIdx = css.indexOf('-webkit-backdrop-filter: blur(var(--blur))');
t('定位到 backdrop-filter 规则', bfIdx >= 0);

/* 取规则的选择器：往前找上一个右花括号或块注释结束标记，再剥掉注释。
   直接 slice 会把规则上方的说明注释一起当成选择器（它就在两者之间）；
   而块注释结束标记是两个字符，只跳一个会把斜杠留在选择器开头。 */
const braceAt = css.lastIndexOf('}', bfIdx);
const commentAt = css.lastIndexOf('*/', bfIdx);
const selStart = braceAt > commentAt ? braceAt + 1 : commentAt + 2;
const ruleOpen = css.indexOf('{', selStart);
const rawSel = bfIdx < 0 ? '' : css.slice(selStart, ruleOpen);
const selector = rawSel.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();

t('.p-card 不再带 backdrop-filter', !/\.p-card\b/.test(selector), selector.slice(0, 80) || '(空)');
/* .dialog 同 .p-card 的理由：它里面会再开一层弹窗（IconPickDialog /
   BackupDialog 就是嵌套的），而嵌套弹窗的遮罩 .mask 是 position:fixed。
   一旦 .dialog 带 backdrop-filter，它就成为 fixed 后代的包含块，
   遮罩只盖住父弹窗那一块而不是整个视口。

   而模糊在 .dialog 上根本看不见 —— 底板是 --surface-overlay（注释写明
   "必须比普通卡片更实"），背景已被完全遮住。收益为零，代价是困住遮罩。 */
t('.dialog 不再带 backdrop-filter', !/\.dialog\b/.test(selector), selector.slice(0, 80) || '(空)');

/* 逐段检查：只看"选择器里有 glass"是不够的 —— 破坏掉其中一段时，
   其余段仍带 glass，断言会照样通过。所以按逗号切分后要求每段都带限定。 */
const parts = selector.split(',').map((x) => x.trim()).filter(Boolean);
/* 不写死段数（原先是 >=5，移除 .dialog 后合法地变成 4 段就红了）。
   这条断言要防的是"切分失败"—— 只切出 0/1 段说明解析逻辑坏了，
   于是下面的逐段检查会全绿却什么都没查。数量增减是正常的。

   注：这与 mcp-alias-test 里「解析出 6 条映射」是**同一类坑** ——
   把当下的数量写进断言，合法变化后测试就红。 */
t('选择器按逗号切分成功', parts.length >= 2, parts.length + ' 段');
const unguardedSel = parts.filter((x) => !x.includes("data-theme-style='glass'"));
t('每一段选择器都带 glass 限定', unguardedSel.length === 0,
  unguardedSel.join(' | ').slice(0, 80) || (parts.length + ' 段均已限定'));

/* 只允许上面那一条规则使用 blur(var(--blur))（带前缀共 2 行）。
   若有人在别处新加一条不受限的，上面按段检查也覆盖不到 ——
   它只检查了第一条规则的选择器。
   注：.mask 那条 blur(2px) 是固定装饰值，且 .mask 自身就是 fixed 元素、
   内部不会再有 fixed 后代，不属于本问题，故只匹配 var(--blur)。 */
const themed = css.match(/-?w?e?b?k?i?t?-?backdrop-filter\s*:\s*blur\(var\(--blur\)\)/g) || [];
t('全文件只有一条规则使用 blur(var(--blur))', themed.length === 2, themed.length + ' 处声明');

/* ============ 附加 · iframe 设置页的滚动链 ============ */
console.log('\n=== 设置页滚动链（窗口小时内容被裁） ===');
/* 主面板 html/body 是 overflow:hidden（滚动交给 #stage-scroll），
   iframe 内没有 #stage-scroll，照搬就会把超出内容直接裁掉。 */
t('主面板 html/body 确为 overflow:hidden',
  /html,\s*body\s*\{[^}]*overflow:\s*hidden/.test(css));
t('#stage-scroll 才是主面板的滚动容器',
  /#stage-scroll\s*\{[^}]*overflow:\s*auto/.test(css));

const setCssPath = 'plugins/settings/settings.css';
const setCss = fs.existsSync(path.join(HERE, setCssPath)) ? src(setCssPath) : '';
t('settings.css 存在', !!setCss);
t('settings.css 让 #root 成为不滚的 flex 列',
  /#root\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(setCss));
t('settings.css 让 .set-body 承担滚动',
  /\.set-body\s*\{[^}]*overflow-y:\s*auto/.test(setCss));
t('.set-body 有 min-height:0（否则 flex 子项撑破容器、滚动失效）',
  /\.set-body\s*\{[^}]*min-height:\s*0/.test(setCss));

const setMain = src('plugins/settings/main.tsx');
t('main.tsx 引入了 settings.css', /import\s+'\.\/settings\.css'/.test(setMain));
t('settings.css 在 neumorphism.css 之后引入',
  setMain.indexOf('neumorphism.css') < setMain.indexOf('./settings.css'));

const setApp = src('plugins/settings/App.tsx');
t('App.tsx 用 .set-body 包裹内容（分页条留在滚动区外）',
  /className="set-body"/.test(setApp));
t('.set-body 的包裹位于分页条之后',
  setApp.indexOf('set-tabs') < setApp.indexOf('set-body'));

/* ============ P2-8 · 能力探测只缓存成功 ============ */
console.log('\n=== P2-8 探测缓存 ===');
t('getTauri 失败不再写入缓存', !/_cache = null;\s*return _cache;/.test(coreSrc));
t('getTauri 命中判断用真值（null 会继续重探）', /if \(_cache\) return _cache;/.test(coreSrc));

const core = await import('./js/tauri-core.js');
/* 反复调用应得到**一致**的结果。
   ------------------------------------------------------------------
   这里刻意不断言 `a === null`。

   `@tauri-apps/api` 是本项目的**正式依赖**（package.json dependencies），
   所以只要装过依赖（npm ci，CI 就是这样），getTauri() 的 ② npm 包分支
   就会命中，返回 { mode: 'npm', ... } 而不是 null。
   原断言只在"恰好没装依赖"的环境里成立 —— 一旦 CI 加上这条测试就会红，
   而这会被误读成 P2-8 回退了。

   P2-8 真正在意的性质是「失败不被缓存，重复探测结果稳定」，
   稳定才是可断言的那一条；具体是 null 还是 npm 模式取决于环境。 */
const a = await core.getTauri();
const b = await core.getTauri();
t('反复探测结果稳定（同一对象/同为 null）', a === b,
  a === null ? 'a=b=null（未装 @tauri-apps/api）' : `a=b=已解析（mode=${a?.mode ?? '?'}，装了依赖时的正常表现）`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
