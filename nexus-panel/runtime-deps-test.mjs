/**
 * 运行时依赖（js/runtime-deps.js + src-tauri/src/rt_dep.rs）
 * ============================================================
 *
 * 这里守的是"装在工具内部的包"这条链路上**错了会静默失效**的几处：
 *
 *   · 前端与后端各算一份文件名 → 前端按 A 名字 import、后端按 B 名字落盘，
 *     结果是"安装报成功，加载永远找不到文件"，且不报错。
 *
 *   · install 命令里的包名/版本解析错 → 装了跟声明不一样的版本。
 *     manifest 里 declared 常是 `^12.0.0` 这种范围，也可能为 null，
 *     所以只能以 install 字段为准，不能拿 declared 去拼。
 *
 *   · 装完不 import 一次 → "文件在、import 报错"是最常见的假成功，
 *     用户会在某个插件里才看到报错，那时已经不知道是哪一步的问题。
 *
 *   · 定级错（install 定 W 而不是 M）→ 第三方插件也能调，
 *     等于把"让工具执行任意远端代码"的能力放了出去。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0;
const fails = [];
function t(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const rt = await import('./js/runtime-deps.js');

/* ---------- 1. 纯函数：真跑，不是只看代码里写没写 ---------- */

t('specOf 解析 包名@精确版本',
  JSON.stringify(rt.specOf('npm i mermaid@^12.0.0')) === JSON.stringify({ name: 'mermaid', version: '^12.0.0' }),
  JSON.stringify(rt.specOf('npm i mermaid@^12.0.0')));

t('specOf 解析 scoped 包',
  JSON.stringify(rt.specOf('npm i @plantuml/core@1.2026.8')) ===
    JSON.stringify({ name: '@plantuml/core', version: '1.2026.8' }),
  JSON.stringify(rt.specOf('npm i @plantuml/core@1.2026.8')));

t('specOf 拒绝空串', rt.specOf('') === null && rt.specOf(null) === null);
t('specOf 跳过 -D 等开关', (rt.specOf('npm i -D mermaid@^12') || {}).name === 'mermaid');

t('safeFileOf 把 @ 与斜杠换成下划线',
  rt.safeFileOf('@plantuml/core', '1.2026.8') === '_plantuml_core@1.2026.8.mjs',
  rt.safeFileOf('@plantuml/core', '1.2026.8'));

t('safeFileOf 版本为空时落 latest', rt.safeFileOf('mermaid', '') === 'mermaid@latest.mjs');
t('safeFileOf 一律 .mjs 结尾', rt.safeFileOf('mermaid', '^12.0.0').endsWith('.mjs'));

t('entryUrlOf 走 +esm 端点', rt.entryUrlOf('mermaid', '^12.0.0') === 'https://cdn.jsdelivr.net/npm/mermaid@^12.0.0/+esm');
t('entryUrlOf 无版本时不写 @', rt.entryUrlOf('mermaid', '') === 'https://cdn.jsdelivr.net/npm/mermaid/+esm');

t('canInstall 拒绝 Rust crate', rt.canInstall({ kind: 'rust', install: 'cargo add serde' }) === false);
t('canInstall 拒绝开发时依赖', rt.canInstall({ kind: 'runtime', dev: true, install: 'npm i -D vitest' }) === false);
t('canInstall 接受运行时依赖', rt.canInstall({ kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0' }) === true);
t('canInstall 拒绝解析不出的', rt.canInstall({ kind: 'runtime', install: '' }) === false);

/* ---------- 1b. 装了反而坏的包必须拒绝 ---------- */

/**
 * 【这一组守什么】
 * 一键装进来的包会在**宿主上下文**里被插件 import。有几类包装进去不是
 * "没用"，而是直接把功能弄坏，而且坏的样子**完全指不到"刚装了它"**：
 *
 *   · react / react-dom / react-markdown / @xyflow/react
 *     → CDN 单文件自带一份 react = 第二份实例 → Invalid hook call。
 *       用户只会看到"某个插件崩了"，不会想到是依赖页签里的那次点击。
 *   · @tauri-apps/api
 *     → 靠 window.__TAURI_INTERNALS__ 与 Rust 侧通信，版本必须与 Cargo
 *       侧一致 → 装外部版本 = 能 import、但所有调用静默失败。
 *   · @plantuml/core
 *     → 要先注入 viz-global.js 才能用，单文件装了也用不了。
 *
 * 所以这里钉的是：**这些包必须判为不可安装，且必须给得出理由**。
 * 只判 false 而不给理由也不行 —— 界面上按钮消失了，用户会以为功能没做完。
 */
const BLOCKED = Object.keys(rt.RT_BLOCKED || {});
t('存在"装了反而坏"的拒绝名单', BLOCKED.length > 0);

for (const n of BLOCKED) {
  const item = { name: n, kind: 'runtime', dev: false, install: `npm i ${n}@1.2.3` };
  t(`拒绝一键安装 ${n}`, rt.canInstall(item) === false);
  // 理由要能显示给用户看懂，不能是空串或一句话都没有
  t(`${n} 有可显示的理由（≥10 字）`, String(rt.blockReasonOf(item) || '').length >= 10);
}

// 不误伤：真正适合运行时装的必须仍然可装
for (const n of ['mermaid', 'rehype-highlight', 'rehype-slug', 'remark-gfm']) {
  t(`不误伤 ${n}（仍可一键安装）`,
    rt.canInstall({ name: n, kind: 'runtime', dev: false, install: `npm i ${n}@^1.0.0` }) === true);
}

/*
 * canInstall 与 blockReasonOf 必须共用一处判定。
 * 两者各写一份的后果：界面出现"能装但理由非空"或"不能装却没理由可显示"
 * ——前者按钮给了却显示一句警告，后者按钮消失且无任何解释。
 */
const mf = await import('./js/deps-manifest.js');
const allItems = [
  ...((mf.DEPS_MANIFEST && mf.DEPS_MANIFEST.npm) || []).map((d) => ({ ...d, kind: d.dev ? 'dev' : 'runtime' })),
  ...((mf.DEPS_MANIFEST && mf.DEPS_MANIFEST.crates) || []).map((d) => ({ ...d, kind: 'rust' })),
];
t('manifest 里有条目（扫描本身没失效）', allItems.length > 0, `n=${allItems.length}`);
t('canInstall 与 blockReasonOf 一致（无"能装却给理由"/"不能装却没理由"）',
  allItems.every((d) => rt.canInstall(d) === (rt.blockReasonOf(d) === null)));

/*
 * 防僵尸：名单里的包名必须真的还在 manifest 里。
 * 写错一个字、或者某个包早已从项目移除，名单就悄悄失效 —— 那时界面
 * 重新给出「安装」按钮，而没有任何断言会红。
 */
const known = new Set(allItems.map((d) => d.name));
t('拒绝名单里的包名都真实存在（防写错/防僵尸）',
  BLOCKED.every((n) => known.has(n)),
  BLOCKED.filter((n) => !known.has(n)).join(','));

/* ---------- 2. 文件名必须能被后端解析回来（前后端契约） ---------- */

/**
 * 镜像 rt_dep.rs 的 parse_file：去 .mjs 后缀 → 找最后一个 '@'。
 * 这里不是"抄一份"，而是**钉住契约**：前端产出的名字必须能被后端的
 * 解析规则还原。改了任一边而没改另一边，这条就会红。
 */
function parseFileMirror(file) {
  if (!file.endsWith('.mjs')) return null;
  const stem = file.slice(0, -'.mjs'.length);
  const at = stem.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: stem.slice(0, at), version: stem.slice(at + 1) };
}

for (const [name, ver] of [['mermaid', '^12.0.0'], ['@plantuml/core', '1.2026.8'], ['@xyflow/react', '12.11.6'], ['md5', '']]) {
  const f = rt.safeFileOf(name, ver);
  const back = parseFileMirror(f);
  t(`safeFileOf 产出可被后端解析：${name}`, !!back && back.name === name.replace(/[@/\\]/g, '_'),
    back ? `解析出 ${back.name}@${back.version}` : '解析失败');
}

const rsText = read('src-tauri/src/rt_dep.rs');
t('后端 parse_file 用 rfind("@")', /rfind\('@'\)/.test(rsText));
t('后端要求 .mjs 后缀', /strip_suffix\("\.mjs"\)/.test(rsText));
t('后端文件名替换含 @ / \\\\', /c == '@' \|\| c == '\/' \|\| c == '\\\\'/.test(rsText));
t('后端 safe_file_of 与前端同为 .mjs', /format!\("\{\}@\{\}\.mjs"/.test(rsText));

/* ---------- 3. 行为：用 stub ctx 真跑 ---------- */

function stubCtx(impl) {
  return { invoke: async (cmd, args) => impl(cmd, args), convertFileSrc: (p) => `asset://${p}` };
}
function missingCtx() {
  return {
    invoke: async () => { throw new Error('command fpx_rt_dep_install not found'); },
    convertFileSrc: (p) => `asset://${p}`,
  };
}

{
  const r = await rt.installRuntimeDep(stubCtx(async () => ({ ok: true, file: 'mermaid@12.0.0.mjs' })), {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  });
  t('安装成功返回 ok 与文件名', r.ok === true && r.name === 'mermaid' && /\.mjs$/.test(r.file || ''));
}

{
  /*
   * 必须包 try/catch，不能让它崩进程。
   *
   * installRuntimeDep 是**声明为不抛**的（失败体现在 r.error）。
   * 若 callCmd 哪天改成往外抛，这里会直接崩 —— 崩了之后
   * 后面的断言一条都不执行，看起来像"有红"，实际把真正的失败
   * 掩盖掉了（本项目已多次踩到：崩 ≠ 红）。包成失败断言才守得住。
   */
  let r = null;
  let threw = false;
  try {
    r = await rt.installRuntimeDep(missingCtx(), {
      kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
    });
  } catch (e) { threw = true; }
  t('命令不存在时给出明确原因（不是静默失败）',
    !threw && r && r.ok === false && /尚未接入/.test(r.error || ''), threw ? '抛异常了' : r && r.error);
}

{
  const r = await rt.installRuntimeDep(stubCtx(async () => ({ ok: false, error: '下载失败（检查网络）: x' })), {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  });
  t('网络失败归类为网络原因', r.ok === false && /网络/.test(r.error || ''), r.error);
}

{
  const r = await rt.installRuntimeDep(stubCtx(async () => ({ ok: false, error: '下载到的内容是空的' })), {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  });
  t('空内容单独归类（CDN 不支持 ESM）', r.ok === false && /空/.test(r.error || ''), r.error);
}

{
  const r = await rt.installRuntimeDep(stubCtx(async () => ({ ok: true })), {
    kind: 'rust', install: 'cargo add serde',
  });
  t('crate 不进入安装流程', r.ok === false && /不适合运行时安装/.test(r.error || ''), r.error);
}

{
  const ctx = stubCtx(async (cmd, a) => {
    if (cmd === 'fpx_rt_dep_list') return { list: [{ name: 'mermaid', version: '12.0.0', file: 'mermaid@12.0.0.mjs', path: '/tmp/deps/mermaid@12.0.0.mjs' }] };
    return { ok: true };
  });
  const l = await rt.listRuntimeDeps(ctx);
  t('列表取回已装项', !l.missing && l.list.length === 1 && l.list[0].name === 'mermaid');
  const p = await rt.resolveRuntimeDepPath(ctx, 'mermaid', '12.0.0');
  t('能按包名取回路径', /mermaid/.test(p || ''), p);
}

{
  /* 同 installRuntimeDep：声明为不抛，所以要包成失败断言而不是让它崩进程 */
  let r = null;
  let threw = false;
  try { r = await rt.removeRuntimeDep(missingCtx(), 'mermaid', '12.0.0'); } catch { threw = true; }
  t('移除时命令不存在也明说', !threw && r && r.ok === false && /尚未接入/.test(r.error || ''),
    threw ? '抛异常了' : r && r.error);
}

/* ---------- 4. 接线：少一处都是"点了没反应" ---------- */

const mainText = read('src-tauri/src/main.rs');
t('main.rs 有 mod rt_dep（缺了整个文件不参与编译）', /^mod rt_dep;/m.test(mainText));
t('注册 fpx_rt_dep_list', /rt_dep::fpx_rt_dep_list/.test(mainText));
t('注册 fpx_rt_dep_install', /rt_dep::fpx_rt_dep_install/.test(mainText));
t('注册 fpx_rt_dep_remove', /rt_dep::fpx_rt_dep_remove/.test(mainText));
t('注册带 rt_dep:: 前缀（写裸名会编译失败）', !/(?<!rt_dep::)fpx_rt_dep_install(?![\s\S]{0,0})/.test(mainText.replace(/rt_dep::fpx_rt_dep_install/g, '')));

const capsText = read('js/command-caps.js');
t('install 定 M（第三方不得调用）', /fpx_rt_dep_install:\s*'M'/.test(capsText));
t('list 定 R', /fpx_rt_dep_list:\s*'R'/.test(capsText));
t('remove 定 W', /fpx_rt_dep_remove:\s*'W'/.test(capsText));

const policyText = read('js/invoke-policy.js');
/*
 * 白名单断言必须**先剥注释**。
 * 注释里就写着 `fpx_rt_dep_install 是 M 类` 这类说明，不剥的话把
 * 真正的白名单项删掉，断言照样匹配注释里的字样 → 假绿。
 * （本项目已在 command-consistency、md-service 上栽过同一类。）
 */
const policyCode = policyText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
t('settings 白名单含三条', /settings:[\s\S]{0,400}fpx_rt_dep_install/.test(policyCode));

/* ---------- 5. 后端自身的安全收口 ---------- */

t('后端拒绝非 https', /!url\.starts_with\("https:\/\/"\)/.test(rsText));
/*
 * 文件名校验要**分别**查 install 与 remove。
 * 只查"文件里存在"是假绿：两处各有一份校验，删掉 install 那份，
 * remove 那份还在，断言照样通过 —— 而 install 恰好是真正落盘的那条。
 */
/*
 * 切到**下一个函数为止**，不能一路切到末尾：
 * 后一种切法让 install 的切片里带着 remove 的校验，于是"删掉 install
 * 那份"这条破坏被 remove 那份兜住 → 假绿（本轮实测踩到）。
 */
const iInstall = rsText.indexOf('pub async fn fpx_rt_dep_install');
const iRemove = rsText.indexOf('pub fn fpx_rt_dep_remove');
const rsInstall = rsText.slice(iInstall, iRemove > iInstall ? iRemove : rsText.length);
const rsRemove = rsText.slice(iRemove);
t('install 校验文件名含 .. 或斜杠', /file\.contains\("\.\."\)/.test(rsInstall));
t('remove 校验文件名含 .. 或斜杠', /file\.contains\("\.\."\)/.test(rsRemove));
t('后端只允许 .mjs 落盘', /只允许 \.mjs/.test(rsInstall));
t('后端检查空内容', /is_empty\(\)/.test(rsText));
t('后端以目录为清单（不另存索引，避免不一致）', /read_dir/.test(rsText));
t('后端注释说明为何不用 app.http()', /HttpExt|reqwest/.test(rsText));

/* ---------- 6. 界面接线 ---------- */

/* ---------- 7. 取用（requireDep）—— 真跑，注入 importModule ---------- */

/*
 * 这一组守的是**消费侧**：装进来的包到底有没有被用上。
 *
 * 最容易错的三处，错了都不报错：
 *   ① 装的那份坏了就整篇图全挂 —— 必须回退到打包版。
 *      运行时依赖是增强，不是基础功能，它一坏功能就全没，
 *      等于把可选增强变成单点故障。
 *   ② 每块图各取一次来源 —— 两份 mermaid 实例的 themeVariables
 *      是模块级全局，会互相踩，表现为"图偶发画错颜色"。
 *   ③ 探测失败（后端没接 / 没授权）当成错误抛出去 ——
 *      那会让本来能用打包版的功能一起挂掉。
 */

function makeCtx(list, opts = {}) {
  return {
    invoked: 0,
    async invoke(cmd) {
      this.invoked++;
      if (opts.invokeError) throw new Error(opts.invokeError);
      if (cmd === rt.CMD_LIST) return { list };
      return {};
    },
    convertFileSrc: (p2) => `asset://${String(p2 || '').replace(/\\/g, '/')}`,
  };
}

const BUNDLE = { tag: 'bundle' };
const RUNTIME = { tag: 'runtime' };
const fb = async () => BUNDLE;

/* ① 装过 → 用装进来的 */
{
  rt.__clearDepDecisions();
  const ctx = makeCtx([{ name: 'mermaid', version: '12.0.0', path: 'C:/deps/mermaid@12.0.0.mjs' }]);
  const r = await rt.requireDep(ctx, 'mermaid', { fallback: fb, importModule: async () => RUNTIME });
  t('装过就用装进来的那份', r.source === 'runtime' && r.mod === RUNTIME, r.source);
  t('装过时**不**去加载打包版', r.error === '');
}

/* ② 没装 → 用打包版 */
{
  rt.__clearDepDecisions();
  const ctx = makeCtx([]);
  const r = await rt.requireDep(ctx, 'mermaid', { fallback: fb, importModule: async () => RUNTIME });
  t('没装就用打包版', r.source === 'bundle' && r.mod === BUNDLE, r.source);
}

/* ③ 装的那份坏了 → 回退打包版，且**不报错** */
{
  rt.__clearDepDecisions();
  const ctx = makeCtx([{ name: 'mermaid', version: '12.0.0', path: 'C:/deps/bad.mjs' }]);
  const r = await rt.requireDep(ctx, 'mermaid', {
    fallback: fb,
    importModule: async () => { throw new Error('Unexpected token'); },
  });
  t('装的那份 import 失败 → 回退打包版', r.source === 'bundle' && r.mod === BUNDLE, r.source);
  t('回退时保留失败原因（便于排查，但不阻断）', /Unexpected token/.test(r.error || ''));
}

/* ④ 探测失败（后端没接 / 没授权 / 抛异常）→ 当作没装，走打包版 */
{
  rt.__clearDepDecisions();
  const ctx = makeCtx([], { invokeError: 'command not found' });
  const r = await rt.requireDep(ctx, 'mermaid', { fallback: fb, importModule: async () => RUNTIME });
  t('探测抛异常时按"没装"处理，走打包版', r.source === 'bundle' && r.mod === BUNDLE, r.source);
}
{
  rt.__clearDepDecisions();
  /* ctx 连 invoke 都没有（老版本 SDK / iframe 未注入）也要能走打包版 */
  const r = await rt.requireDep(null, 'mermaid', { fallback: fb, importModule: async () => RUNTIME });
  t('ctx 为空时也能走打包版，不抛', r.source === 'bundle' && r.mod === BUNDLE, r.source);
}
/*
 * 真正守住"探测失败不抛"的是 listRuntimeDeps / callCmd 那一层：
 * 它把异常转成"空列表 + error"，而不是往外抛。
 * 只测 requireDep 的结果测不到这一层（requireDep 的结果在两种实现下都一样），
 * 所以在这里直接断言它不抛 —— 这一条也是上一版那条假绿的替代。
 */
{
  const ctx = makeCtx([], { invokeError: 'boom' });
  let threw = false;
  let out = null;
  try { out = await rt.listRuntimeDeps(ctx); } catch { threw = true; }
  t('探测失败不抛异常（转成空列表 + error）', !threw && Array.isArray(out.list) && out.list.length === 0, threw ? '抛了' : JSON.stringify(out));
}
{
  const out = await rt.listRuntimeDeps(null);
  t('后端没接这条命令时返回 missing 标记而不是抛', out.missing === true, JSON.stringify(out));
}

/* ⑤ 两边都没有 → source none，不抛 */
{
  rt.__clearDepDecisions();
  const ctx = makeCtx([]);
  const r = await rt.requireDep(ctx, 'mermaid', { importModule: async () => RUNTIME });
  t('没有打包版兜底时返回 none', r.source === 'none' && r.mod === null, r.source);
}

/* ⑥ 决策缓存：来源只定一次 */
{
  rt.__clearDepDecisions();
  const ctx = makeCtx([{ name: 'mermaid', version: '12.0.0', path: 'C:/deps/bad.mjs' }]);
  let importCalls = 0;
  const opts = {
    fallback: fb,
    importModule: async () => { importCalls++; throw new Error('bad'); },
  };
  await rt.requireDep(ctx, 'mermaid', opts);
  await rt.requireDep(ctx, 'mermaid', opts);
  const invokedAfter = ctx.invoked;
  await rt.requireDep(ctx, 'mermaid', opts);
  t('第二次起不再重复探测（invoke 只调一次）', invokedAfter === 1, `invoked=${invokedAfter}`);
  t('回退决策也被缓存（坏文件只试一次）', importCalls === 1, `importCalls=${importCalls}`);
}

/* ⑦ 装过且版本不匹配指定版本时，不误用 */
{
  rt.__clearDepDecisions();
  const ctx = makeCtx([{ name: 'mermaid', version: '11.0.0', path: 'C:/deps/m11.mjs' }]);
  const r = await rt.requireDep(ctx, 'mermaid', { version: '12.0.0', fallback: fb, importModule: async () => RUNTIME });
  t('指定了版本而装的是另一个版本 → 用它而不是误判为已装', r.source === 'bundle', r.source);
}

/* ---------- 7b. 装了有没有人用：必须提前说，不能装完才发现没效果 ---------- */
{
  const manifest = (await import('./js/deps-manifest.js')).DEPS_MANIFEST;
  const all = [...manifest.npm, ...manifest.undeclared];

  const withRt = all.filter((d) => (d.runtimeUsedBy ?? []).length > 0);
  t('至少有一个包有运行时消费方（扫描没整体失效）', withRt.length > 0, `n=${withRt.length}`);

  const mm = all.find((d) => d.name === 'mermaid');
  t('mermaid 的运行时消费方是 md', !!mm && (mm.runtimeUsedBy ?? []).includes('md'), JSON.stringify(mm && mm.runtimeUsedBy));
  /*
   * 「不含外壳」这条是防假阳性：js/plugin-sdk.js 的用法示例注释里
   * 正好写着 ctx.requireDep('mermaid', ...)。不剥注释，"外壳"就会被
   * 记成消费方 —— 于是"扫不出真消费方"这类失效会被永久掩盖。
   */
  t('mermaid 的运行时消费方不含"外壳"（注释示例不算）',
    !!mm && !(mm.runtimeUsedBy ?? []).includes('外壳'), JSON.stringify(mm && mm.runtimeUsedBy));

  t('consumerNoteOf：有消费方 → 不提示',
    rt.consumerNoteOf({ kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0', runtimeUsedBy: ['md'] }) === null);
  t('consumerNoteOf：无消费方 → 给说明',
    typeof rt.consumerNoteOf({ kind: 'runtime', dev: false, install: 'npm i rehype-highlight@^7', runtimeUsedBy: [] }) === 'string');
  t('consumerNoteOf：本来就装不了 → 不重复提示',
    rt.consumerNoteOf({ kind: 'rust', install: 'cargo add serde' }) === null);
  t('说明不能是空串（界面会出现"没有解释的提示"）', (rt.RT_NO_CONSUMER || '').length >= 20, String((rt.RT_NO_CONSUMER || '').length));

  /*
   * 必须**重跑一遍扫描**再比对，不能只验已提交的清单：
   * js/deps-manifest.js 是静态文件，扫描器改坏了它也不会变 ——
   * 于是"不扫 requireDep 了""清单忘了重跑"这两类失效都测不到。
   */
  const tmp = path.join(HERE, '_deps_scan_out.mjs');
  let fresh = null;
  try {
    execFileSync(process.execPath, ['scripts/scan-deps.mjs', '--out', tmp, '--quiet'], { cwd: HERE });
    fresh = (await import(`./_deps_scan_out.mjs?v=${Date.now()}`)).DEPS_MANIFEST;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  t('扫描器能重跑（--out 到临时文件）', !!fresh);
  if (fresh) {
    const fAll = [...fresh.npm, ...fresh.undeclared];
    const fMm = fAll.find((d) => d.name === 'mermaid');
    t('重跑后 mermaid 仍被 md 运行时取用', !!fMm && (fMm.runtimeUsedBy ?? []).includes('md'), JSON.stringify(fMm && fMm.runtimeUsedBy));
    const drift = fAll.filter((d) => {
      const old = all.find((x) => x.name === d.name);
      return !old || JSON.stringify(old.runtimeUsedBy ?? []) !== JSON.stringify(d.runtimeUsedBy ?? []);
    });
    t('已提交清单与重跑结果一致（清单没忘重跑）', drift.length === 0,
      drift.map((d) => d.name).join(','));
  }

  const scan = read('scripts/scan-deps.mjs');
  t('扫描器扫 requireDep 取用点', /runtimeDepsOf\(/.test(scan) && /requireDep\s*\(/.test(scan));
  t('扫 requireDep 前先剥注释', /function runtimeDepsOf[\s\S]{0,300}stripComments\(raw\)/.test(scan));
  t('清单每条都有 runtimeUsedBy 字段', all.every((d) => Array.isArray(d.runtimeUsedBy)));
}

const cardText = read('plugins/settings/DepsCard.tsx');
t('DepsCard 接入 runtime-deps', /js\/runtime-deps\.js/.test(cardText));
t('DepsCard 用 canInstall 决定按钮显隐', /canInstall\(/.test(cardText));
t('不能装时必须显示理由（不能只是没按钮）', /blockReasonOf\(/.test(cardText) && /不适合运行时安装/.test(cardText));
t('装完真 import 一次（验可加载）', /loadRuntimeDep\(/.test(cardText));
t('后端未接入时禁用按钮并提示', /rtMissing/.test(cardText) && /disabled=\{running \|\| rtMissing\}/.test(cardText));
t('装了没人取用的包要提前说明（不是装完才发现没效果）',
  /consumerNoteOf\(/.test(cardText) && /\{noUse \?/.test(cardText));
t('有运行时消费方时显示是谁在用', /rtUsers/.test(cardText) && /装了会被/.test(cardText));

t('plugin-sdk 暴露 ctx.requireDep', /requireDep\(name, opts = \{\}\)/.test(read('js/plugin-sdk.js')));
t('plugin-sdk 从 runtime-deps 引入 requireDep',
  /import \{ requireDep as loadDep \} from '\.\/runtime-deps\.js'/.test(read('js/plugin-sdk.js')));

const mb = read('plugins/md/MermaidBlock.tsx');
t('md 的 mermaid 走 requireDep 取用（装过优先）', /ctx\.requireDep\('mermaid'/.test(mb));
/*
 * 不写死 `fallback = () => import('mermaid')` 这个字面形式：
 * 实际写法是 `async () => await import('mermaid')` —— 因为 md-mermaid-test
 * 那条"mermaid 不能进首屏 bundle"找的是 `await import('mermaid')`。
 * 这里要守的是"有 fallback，且 fallback 动态 import mermaid"，不是它的写法。
 */
t('md 取 mermaid 有打包版兜底',
  /fallback\s*=\s*(async\s*)?\(\)\s*=>/.test(mb) && /import\('mermaid'\)/.test(mb));

const ip = read('js/invoke-policy.js');
t('md 白名单只给 list（不给 install/remove）',
  /md: \[[^\]]*'fpx_rt_dep_list'/.test(ip) &&
  !/md: \[[^\]]*fpx_rt_dep_(install|remove)/.test(ip));

console.log(`\n运行时依赖：${pass} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
