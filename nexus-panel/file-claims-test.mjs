/**
 * 文件清单制（D3）测试
 * ============================================================
 * 核心命题：**文件残留发现不了，只能事前声明**。
 *
 * DOM 残留能靠快照差分（S2）自动发现；文件不行 —— 文件名不带来源
 * 信息，无法从磁盘现状反推归属。所以只能让插件在写之前声明。
 */
import { JSDOM } from 'jsdom';

/* 必须给 url，否则 jsdom 是 opaque origin，localStorage 直接抛 SecurityError */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const fs = await import('./js/plugin-fs.js');
const { normalizePath, claimPath, readClaims, releasePath, clearClaims, allClaims } = fs;

let pass = 0;
let fail = 0;
const t = (name, cond, hint = '') => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${hint ? `  —— ${hint}` : ''}`); }
};

console.log('=== 1. 路径归一（去重的最小集合）===');
t('结尾斜杠归一', normalizePath('/a/b/') === '/a/b');
t('反斜杠转正斜杠', normalizePath('C:\\x\\y') === 'C:/x/y');
t('根 "/" 不被吃成空', normalizePath('/') === '/');
t('空串返回空', normalizePath('') === '');
t('非字符串返回空（不抛）', normalizePath(null) === '' && normalizePath(undefined) === '');
/*
 * **刻意不去 .. / .** —— 那是路径解析的事，由 Rust 侧 canonicalize 做
 * （那里有授权根校验）。这里只做记账去重需要的归一。
 */
t('保留 .. （解析交给 Rust 侧 canonicalize）', normalizePath('/a/../b') === '/a/../b');

console.log('\n=== 2. 记账与去重 ===');
clearClaims('p1');
t('初始为空', readClaims('p1').length === 0);
t('claim 成功', claimPath('p1', '/data/cache', { kind: 'dir' }).ok);
t('账本有 1 条', readClaims('p1').length === 1);
t('kind 被记录', readClaims('p1')[0].kind === 'dir');
t('带时间戳', typeof readClaims('p1')[0].at === 'number');
/*
 * 去重是**关键设计**：插件可能每次写文件都 claim 一次。
 * 不去重的话账本会随使用时长无限增长。
 */
t('重复 claim 不新增条目', claimPath('p1', '/data/cache').ok
  && readClaims('p1').length === 1);
t('重复 claim 标记为 deduped', claimPath('p1', '/data/cache').deduped === true);
t('不同路径会新增', claimPath('p1', '/data/other').ok && readClaims('p1').length === 2);
t('结尾斜杠视为同一条（归一生效）',
  claimPath('p1', '/data/cache/').deduped === true && readClaims('p1').length === 2);

console.log('\n=== 3. 隔离：不同插件互不干扰 ===');
claimPath('p2', '/shared/x');
t('p1 看不到 p2 的声明', readClaims('p1').every((x) => x.path !== '/shared/x'));
t('p2 有自己的声明', readClaims('p2').some((x) => x.path === '/shared/x'));
t('allClaims 含两个插件', Object.keys(allClaims()).sort().join(',') === 'p1,p2');

console.log('\n=== 4. 失败一律不抛（声明失败不该阻断写文件）===');
let threw = false;
try {
  claimPath('p3', '');            // 空路径
  claimPath('', '/x');            // 无 id
  claimPath('p3', null);          // 非字符串
} catch { threw = true; }
t('异常参数不抛', !threw);
t('空路径返回 ok:false 并带原因', claimPath('p3', '').ok === false
  && typeof claimPath('p3', '').reason === 'string');
t('坏参数不进账本', readClaims('p3').length === 0);

console.log('\n=== 5. 撤销与清空 ===');
t('release 移除一条', releasePath('p1', '/data/other').removed === 1);
t('release 后账本少一条', readClaims('p1').length === 1);
t('release 不存在的路径不报错', releasePath('p1', '/nope').ok === true);
clearClaims('p1');
t('clearClaims 清空', readClaims('p1').length === 0);

console.log('\n=== 6. 坏数据不拖垮卸载流程 ===');
localStorage.setItem('nexus:fsclaim:broken', '{不是JSON');
t('账本损坏时读为空数组（不抛）', readClaims('broken').length === 0);
localStorage.setItem('nexus:fsclaim:broken2', '{"不是数组":1}');
t('非数组也按空处理', readClaims('broken2').length === 0);
localStorage.setItem('nexus:fsclaim:broken3', '[{"noPath":1},"/ok/path"]');
t('条目缺 path 字段被过滤', readClaims('broken3').length === 0);
localStorage.removeItem('nexus:fsclaim:broken');
localStorage.removeItem('nexus:fsclaim:broken2');
localStorage.removeItem('nexus:fsclaim:broken3');

console.log('\n=== 7. 宿主接线：两种模式都要有 fs.* 分支 ===');
{
  const { readFileSync } = await import('node:fs');
  const host = readFileSync('./js/host.js', 'utf8');
  const sdk = readFileSync('./js/plugin-sdk.js', 'utf8');
  t('宿主（iframe 侧）处理 fs.claim', /case 'fs\.claim':/.test(host));
  t('宿主处理 fs.claims', /case 'fs\.claims':/.test(host));
  t('宿主处理 fs.release', /case 'fs\.release':/.test(host));
  /*
   * 这一条是**本轮最容易漏的**：同页模式的 transport 是个 switch，
   * 且**没有 default 兜底**（未命中直接抛"未知请求"）。
   * 不加分支的话，同页插件调 ctx.fs.claim 会抛错而 iframe 插件正常 ——
   * 同一个 API 两种模式行为不同。
   */
  t('同页模式也有 fs.* 分支（否则同页插件会抛"未知请求"）',
    /case 'fs\.claim':/.test(sdk) && /case 'fs\.claims':/.test(sdk)
    && /case 'fs\.release':/.test(sdk));
  t('两边共用同一份记账实现（语义一致）',
    /from '\.\/plugin-fs\.js'/.test(host) && /from '\.\/plugin-fs\.js'/.test(sdk));
  t('ctx.fs 挂在 ctx 上', /fs:\s*\{[\s\S]{0,200}claim:/.test(sdk));
}

console.log('\n=== 8. 卸载只报告，不自动删（N42）===');
{
  const { readFileSync } = await import('node:fs');
  const host = readFileSync('./js/host.js', 'utf8');
  t('卸载时读取账本并报告', /readClaims\(inst\.manifest\?\.id\)/.test(host));
  t('报告用 info 级（不是 error）', /console\.info\(\[file-claims\]|console\.info\(`\[file-claims\]/.test(host));
  /*
   * 关键断言：**卸载路径里不出现自动删除**。
   * 自动删会误删用户文件，且无法撤销。
   */
  /*
   * 切片范围**必须止于 purgePluginFiles 之前**。
   *
   * 第一版切到 `async function reAdapt` —— 结果把 purge 函数本身也切进来了，
   * 于是"卸载路径里不出现 fs_op delete"这条**恒假**（purge 里当然有 delete）。
   * 这是"被检查的范围错了"，不是代码有问题。
   */
  const teardown = host.slice(host.indexOf('async function safeTeardown'),
    host.indexOf('async function purgePluginFiles'));
  t('切片范围有效（确实切到了 safeTeardown 且不含 purge）',
    teardown.includes('auditUnmount') && !teardown.includes('async function purgePluginFiles'));
  /*
   * **必须剔注释再匹配** —— 第一版直接匹配整段，命中了 purge 上方
   * 注释里的"逐条走 fs_op delete"，于是这条**恒假**（假红）。
   *
   * "注释里提到某个字符串"和"代码真的做了"是两回事，
   * 这个坑在本仓库已出现过多次。
   */
  const teardownCode = teardown.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/*')
      && !l.trim().startsWith('//'))
    .join('\n');
  t('safeTeardown 内不自动调 fs_op delete（只报告）',
    !/fs_op[\s\S]{0,80}delete/.test(teardownCode));
  /*
   * 光查 fs_op delete **不够**：破坏5（卸载时加一句 purgePluginFiles 调用）
   * 红了 0 项 —— 它不含那个字面量。所以还要直接钉"不调用 purge"。
   *
   * 这是破坏验证倒逼出来的第二条（第一版漏了）。
   */
  t('safeTeardown 内不调用 purgePluginFiles（删不删由 UI 决定）',
    !/purgePluginFiles\s*\(/.test(teardownCode));
  t('提供显式 purge 函数供 UI 调用（不自动调）',
    /async function purgePluginFiles/.test(host));
  t('purge 逐条失败不中断（记下来继续）',
    /failed\.push/.test(host) && /for \(const c of claims\)/.test(host));
  t('purge 只清成功的账（失败留着可重试）',
    /for \(const p of deleted\) releasePath/.test(host));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log(`
注意：第 7 节的"同页模式也有 fs.* 分支"若红了，说明两种模式的
ctx 形状不一致 —— 那是最难排查的一类 bug（同一个 API 一边能用一边抛错）。`);
}
process.exit(fail ? 1 : 0);
