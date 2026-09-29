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

/*
 * ⚠️ 这一条原先写的是 `mermaid@^12.0.0/+esm` —— 等于把 bug 固化成期望。
 * 实测（curl）：
 *   https://cdn.jsdelivr.net/npm/mermaid@^12.0.0/+esm → 502（取不到）
 *   https://cdn.jsdelivr.net/npm/mermaid@12.0.0/+esm  → 200
 * 而 manifest 里绝大多数声明都是 `^x.y.z`，于是"一键安装"对绝大多数包
 * 都是点了就失败。断言改成"URL 里不得出现范围符号"。
 */
t('entryUrlOf 走 +esm 端点', rt.entryUrlOf('mermaid', '12.0.0') === 'https://cdn.jsdelivr.net/npm/mermaid@12.0.0/+esm',
  rt.entryUrlOf('mermaid', '12.0.0'));
t('entryUrlOf 剥掉 ^ 等范围符号（带 ^ 的 URL 实测 502）',
  rt.entryUrlOf('mermaid', '^12.0.0') === 'https://cdn.jsdelivr.net/npm/mermaid@12.0.0/+esm',
  rt.entryUrlOf('mermaid', '^12.0.0'));
t('entryUrlOf 剥掉 ~', rt.entryUrlOf('mermaid', '~12.0.0') === 'https://cdn.jsdelivr.net/npm/mermaid@12.0.0/+esm');
t('entryUrlOf 无版本时不写 @', rt.entryUrlOf('mermaid', '') === 'https://cdn.jsdelivr.net/npm/mermaid/+esm');
t('URL 里不带任何范围符号（^ ~ > < 空格 || *）',
  !/[\^~>< ]|\|\||\*/.test(rt.entryUrlOf('mermaid', '^12.0.0').replace('https://cdn.jsdelivr.net/npm/', '')),
  rt.entryUrlOf('mermaid', '^12.0.0'));

/* ---------- 1b. 版本归一化：URL / 文件名 / 显示 三者必须指同一版本 ---------- */

t('pinnedVersionOf 剥 ^', rt.pinnedVersionOf('^12.0.0').version === '12.0.0' && rt.pinnedVersionOf('^12.0.0').ok === true,
  JSON.stringify(rt.pinnedVersionOf('^12.0.0')));
t('pinnedVersionOf 剥 ~', rt.pinnedVersionOf('~1.2.3').version === '1.2.3');
t('pinnedVersionOf 保留精确版本', rt.pinnedVersionOf('12.0.0').version === '12.0.0');
t('pinnedVersionOf 留空 = 最新版', rt.pinnedVersionOf('').ok === true && rt.pinnedVersionOf('').latest === true);
t('pinnedVersionOf 拒绝复合范围（>=1.0.0 <2）', rt.pinnedVersionOf('>=1.0.0 <2').ok === false);
t('pinnedVersionOf 拒绝 || 与 *', rt.pinnedVersionOf('1.x || 2.x').ok === false && rt.pinnedVersionOf('*').ok === false);
t('URL 的版本 == 文件名的版本（否则显示与实际不符）', (() => {
  const u = rt.entryUrlOf('mermaid', '^12.0.0');
  const f = rt.safeFileOf('mermaid', rt.pinnedVersionOf('^12.0.0').version);
  return u.includes('@12.0.0/') && f === 'mermaid@12.0.0.mjs';
})());

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
  /*
   * 版本框里填复合范围，必须在发命令之前就拒绝 ——
   * 不能等 CDN 报 404 再说"下载失败"（那时用户会去查网络）。
   */
  let called = 0;
  const r = await rt.installRuntimeDep(stubCtx(async () => { called++; return { ok: true }; }), {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  }, { version: '>=12.0.0 <13' });
  t('复合范围明确拒绝（不说"下载失败"）',
    r.ok === false && /范围/.test(r.error || '') && /写死一个版本号/.test(r.error || ''), r.error);
  t('复合范围不发请求（避免拿归一化出的假版本去下载）', called === 0);
}

{
  /* 填了不像版本号的东西同理：拼出来是 404，而报错会指向网络 */
  let called = 0;
  const r = await rt.installRuntimeDep(stubCtx(async () => { called++; return { ok: true }; }), {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  }, { version: 'abc' });
  t('不像版本号时明确拒绝', r.ok === false && /版本号看着不对/.test(r.error || ''), r.error);
  t('不像版本号时不发请求', called === 0);
  const r2 = await rt.installRuntimeDep(stubCtx(async () => ({ ok: true })), {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  }, { version: '12' });
  t('允许写不完整的版本（12 → 取 12.x 最新）', r2.ok === true && r2.version === '12', r2.error || r2.version);
}

{
  /* 界面手填的版本必须真的被用上：URL、文件名、返回的版本一致 */
  let args = null;
  const ctx = stubCtx(async (_cmd, a) => { args = a; return { ok: true }; });
  const r = await rt.installRuntimeDep(ctx, {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  }, { version: '13.1.0' });
  t('手填版本进 URL', !!args && args.url === 'https://cdn.jsdelivr.net/npm/mermaid@13.1.0/+esm', args && args.url);
  t('手填版本进文件名', !!args && args.file === 'mermaid@13.1.0.mjs', args && args.file);
  t('手填版本回传给界面（显示的就是装的）', r.ok === true && r.version === '13.1.0', r.version);
}

{
  /* 声明带 ^ 时，装下来的版本是剥掉 ^ 的那个，与文件名、显示一致 */
  let args = null;
  const ctx = stubCtx(async (_cmd, a) => { args = a; return { ok: true }; });
  const r = await rt.installRuntimeDep(ctx, {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  });
  t('声明带 ^ 时按具体版本装（不是原样带 ^）', !!args && args.url.includes('@12.0.0/') && !/[\^]/.test(args.url),
    args && args.url);
  t('返回的版本与文件名同源', r.ok === true && r.version === '12.0.0' && r.file === 'mermaid@12.0.0.mjs',
    `${r.version} / ${r.file}`);
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

/* ---------- 3b. 多版本共存：删的必须是显示的那一行的版本 ---------- */
/*
 * 换过声明版本后旧文件仍在 deps 目录里，同一个包就装着多份。
 * 只取第一个的下场：显示 12.0.0、点移除删掉 13.0.0，刷新后 12.0.0 还在
 * —— 界面上看就是"移除失效"，而 13.0.0 从此没有任何入口能删。
 */
{
  t('normVersion 剥掉 ^ 等范围符号', rt.normVersion('^12.0.0') === '12.0.0', rt.normVersion('^12.0.0'));
  t('normVersion 对精确版本不动', rt.normVersion('12.0.0') === '12.0.0');

  const installed = [
    { name: 'mermaid', version: '12.0.0', file: 'mermaid@12.0.0.mjs' },
    { name: 'mermaid', version: '13.0.0', file: 'mermaid@13.0.0.mjs' },
    { name: 'rehype-slug', version: '6.0.0', file: 'rehype-slug@6.0.0.mjs' },
  ];
  const item13 = { kind: 'runtime', dev: false, install: 'npm i mermaid@^13.0.0' };
  const got = rt.installedVersionsOf(installed, item13);
  t('installedVersionsOf 返回该包的全部版本（不是只取第一个）', got.length === 2, `实际 ${got.length}`);

  const stale = rt.staleVersionsOf(installed, item13);
  t('staleVersionsOf 只标与声明不符的那份',
    stale.length === 1 && stale[0].version === '12.0.0', stale.map((x) => x.version).join(','));
  t('范围声明能认出精确版本那份是当前的',
    rt.staleVersionsOf(installed, { install: 'npm i mermaid@^12.0.0' }).every((x) => x.version === '13.0.0'));
  t('声明里没写版本时不硬标 stale（无法判定就不标）',
    rt.staleVersionsOf(installed, { install: 'npm i mermaid' }).length === 0);

  /* 移除必须拿 list 给的真实文件名，不能按声明版本重拼 */
  let seen = null;
  const ctx = stubCtx(async (cmd, a) => {
    if (cmd === 'fpx_rt_dep_remove') { seen = a; return { ok: true }; }
    return { ok: true };
  });
  /*
   * 关键在于**传入的 file 与按声明版本拼出来的不同**：
   * 这正是"显示 12.0.0、声明是 ^13.0.0"的场景 —— 若按声明版本重拼就会
   * 去删 mermaid@13.0.0.mjs（没显示的那个），而这一条删不掉。
   * 用同版本的例子测，两种实现结果恰好相同，断言就成了摆设。
   */
  await rt.removeRuntimeDep(ctx, 'mermaid', '^13.0.0', 'mermaid@12.0.0.mjs');
  t('移除用传入的真实文件名（不用声明版本重拼）',
    seen && seen.file === 'mermaid@12.0.0.mjs', seen && seen.file);

  seen = null;
  await rt.removeRuntimeDep(ctx, 'mermaid', '^12.0.0');
  t('没给文件名时退回 safeFileOf（不静默不删）',
    seen && seen.file === 'mermaid@12.0.0.mjs', seen && seen.file);
}

/* ---------- 3c. 装新不清旧：多版本并存留不留由用户决定 ---------- */
/*
 * 装新版本时**不许**替用户删旧版本。旧版本可能是他特意留的（回滚 / 对比 /
 * 有插件钉住旧行为），后台删掉等于替他做决定，而界面上他看不出少了什么。
 * 契约：装 = 只写目标文件；删 = 用户逐条点「移除」。
 */
{
  t('cmpVersion 自然序：9 在 10 前面（字符串比会反过来）', rt.cmpVersion('9.0.0', '10.0.0') < 0);
  t('cmpVersion 逐段比数字', rt.cmpVersion('12.0.0', '12.10.0') < 0 && rt.cmpVersion('12.10.0', '12.9.0') > 0);
  t('cmpVersion 相同返回 0', rt.cmpVersion('12.0.0', '12.0.0') === 0);

  const installed = [
    { name: 'mermaid', version: '13.0.0', file: 'c.mjs' },
    { name: 'mermaid', version: '9.0.0', file: 'a.mjs' },
    { name: 'mermaid', version: '12.0.0', file: 'b.mjs' },
  ];
  const got = rt.installedVersionsOf(installed, { install: 'npm i mermaid@^13.0.0' });
  t('多版本按自然序展示（顺序会被当成有含义）',
    got.map((x) => x.version).join(',') === '9.0.0,12.0.0,13.0.0', got.map((x) => x.version).join(','));
  t('排序不改原数组（避免污染调用方状态）', installed[0].version === '13.0.0');

  /*
   * 行为级：**真跑** install，断言它一条 remove 都不发。
   * 只看注释里写没写"不清旧"是不够的 —— 注释和实现漂移过太多次了。
   */
  const calls = [];
  const ctx = stubCtx(async (cmd, a) => {
    calls.push(cmd);
    if (cmd === 'fpx_rt_dep_list') return [{ name: 'mermaid', version: '12.0.0', file: 'mermaid@12.0.0.mjs' }];
    if (cmd === 'fpx_rt_dep_install') return { ok: true, file: 'mermaid@13.0.0.mjs' };
    return { ok: true };
  });
  await rt.installRuntimeDep(ctx, { kind: 'runtime', dev: false, install: 'npm i mermaid@^13.0.0' });
  t('装新版本时一条 remove 都不发（不清旧）',
    !calls.includes('fpx_rt_dep_remove'), calls.join(','));
  t('装新版本只写目标那一个文件',
    calls.filter((c) => c === 'fpx_rt_dep_install').length === 1, calls.join(','));

  /*
   * 后端同理：install 里不许出现删除动作。
   * 切片仍截止到下一个函数 —— 一路切到末尾会被 remove 那份兜住（假绿）。
   */
  const iI = rsText.indexOf('pub async fn fpx_rt_dep_install');
  const iR = rsText.indexOf('pub fn fpx_rt_dep_remove');
  const rsI = rsText.slice(iI, iR > iI ? iR : rsText.length);
  t('后端 install 不含任何删除动作（清旧只能在用户点移除时发生）',
    !/remove_file|remove_dir|fs::remove/.test(rsI));
}

/* ---------- 4. 接线：少一处都是"点了没反应" ---------- */

const mainText = read('src-tauri/src/main.rs');
/*
 * 措辞改过：原来写"缺了整个文件不参与编译"，跟 updater / dupview 那两条
 * 一模一样。但后果不同 —— 下面注册写的是 `rt_dep::fpx_rt_dep_xxx`，
 * 模块没声明就是 unresolved module（E0433），**cargo build 直接红**；
 * 而 updater 缺了是编译照过、运行时才 command not found。
 * 措辞不分开，这条就会被当成"回头再说"，实际是项目构建不出来。
 */
t('main.rs 有 mod rt_dep（缺了 cargo build 直接失败 E0433）', /^mod rt_dep;/m.test(mainText));
t('注册 fpx_rt_dep_list', /rt_dep::fpx_rt_dep_list/.test(mainText));
t('注册 fpx_rt_dep_install', /rt_dep::fpx_rt_dep_install/.test(mainText));
t('注册 fpx_rt_dep_remove', /rt_dep::fpx_rt_dep_remove/.test(mainText));
t('注册 fpx_rt_dep_versions', /rt_dep::fpx_rt_dep_versions/.test(mainText));
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
/*
 * 主体必须是 .mjs。
 * 断言写结构（`!file.ends_with(".mjs")`）而不是写死提示文案 ——
 * 文案改了就假红，而"拒了没有"这件事跟文案没关系。
 */
t('后端只接受 .mjs 作为主体落盘', /!file\.ends_with\("\.mjs"\)/.test(rsInstall));
t('后端 remove 只认运行时依赖自己的文件后缀',
  /is_rt_file\(&file\)/.test(rsRemove), rsRemove.match(/is_rt_file[^\n]*/g));
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

/*
 * 版本输入框：装哪个版本由用户说了算。
 * 只断言"有输入框"是假绿 —— 输入框存在但没接到 doInstall，
 * 表现是"填了版本、装的还是旧的"，且不报错。所以两条一起钉。
 */
t('DepsCard 有版本输入框', /className="p-input dep-ver"/.test(cardText));
t('版本框默认值来自 pinnedVersionOf（不是原样带 ^）',
  /value=\{ver\[k\] \?\? \(spec \? pinnedVersionOf\(spec\.version\)\.version : ''\)\}/.test(cardText));
t('填的版本真的传进 doInstall',
  /onClick=\{\(\) => doInstall\(d, ver\[k\]\)\}/.test(cardText) &&
  /async \(item: Item, override\?: string\)/.test(cardText));
t('doInstall 把 override 交给 installRuntimeDep',
  /installRuntimeDep\(ctx, item, \{ version: override \}\)/.test(cardText));
t('装完提示里带实际版本（不是笼统说"已安装"）', /已安装 \$\{r\.version/.test(cardText));
t('.dep-ver 有样式（等宽，版本号要能分清 l/1/I）',
  /\.dep-ver\s*\{[^}]*font-family/.test(read('css/neumorphism.css')));

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

/* ---------- 5. 界面：多版本时删的必须是那一行 ---------- */

const card = read('plugins/settings/DepsCard.tsx');
t('界面按"已装记录"移除（传 hit.file，不是按声明版本重拼）',
  /removeRuntimeDep\(ctx, name, hit\.version \|\| '', hit\.file\)/.test(card));
t('界面不再把整个 item 交给移除（那只猜得出声明版本）',
  !/doRemove\(d\)/.test(card));
t('界面列出该包的全部已装版本', /installedVersionsOf\(installed, item\)/.test(card));
t('界面标出与声明不符的版本', /staleVersionsOf\(installed, d\)/.test(card) && /与声明不符/.test(card));
t('多版本时标题不谎称只有一个', /已装 \{hits\.length\} 个版本/.test(card));
t('已有与声明一致的那份时不显示「安装」', /can && !hasExact \? \(/.test(card));
/*
 * 多版本时必须**把"不会替你删旧版本"写出来**。
 * 不说明的话，用户看到两份会以为"安装没覆盖干净"，于是反复重装 ——
 * 而重装同名同版本只覆盖同一份，旧的那份永远清不掉，问题看起来"修不好"。
 */
t('多版本时界面写明不会替你删旧版本', /不会<\/strong>替你删旧版本/.test(card));
t('界面每一份都有独立的移除按钮（不是整包一个）',
  /onClick=\{\(\) => doRemove\(h\)\}/.test(card));

/* ---------- 6. 版本列表（界面上的版本下拉） ---------- */
/*
 * 这一节守的是：版本下拉只是一条**辅助信息**，它一旦出问题不能连累
 * "安装"本身。两者是独立的网络请求、独立的失败域。
 */

const rtSrc = read('js/runtime-deps.js');
const rsSrc = read('src-tauri/src/rt_dep.rs');

/** 只关心 versions 这一条命令的假 ctx。 */
function vCtx(impl) {
  let n = 0;
  return {
    n: () => n,
    invoke: async (cmd, args) => {
      n++;
      return impl(cmd, args);
    },
  };
}

{
  const ctx = vCtx(async () => ({
    versions: ['12.0.0', '12.1.0', '11.9.0', '13.0.0-beta.1', '9.0.0', '10.0.0'],
  }));
  const r = await rt.fetchRuntimeDepVersions(ctx, 'mermaid');
  t('版本列表过滤掉预发布版本', !r.list.some((v) => v.includes('-')), r.list.join(','));
  t('版本列表按自然序倒序（10 排在 9 后面，而不是前面）',
    r.list.join(',') === '12.1.0,12.0.0,11.9.0,10.0.0,9.0.0', r.list.join(','));
}

{
  const ctx = vCtx(async () => ({ versions: Array.from({ length: 40 }, (_, i) => `${i}.0.0`) }));
  const r = await rt.fetchRuntimeDepVersions(ctx, 'mermaid');
  t('版本列表截断（不把几百个版本塞进下拉）', r.list.length === 30, `len=${r.list.length}`);
}

{
  const ctx = vCtx(async () => {
    throw new Error('command fpx_rt_dep_versions not found');
  });
  const r = await rt.fetchRuntimeDepVersions(ctx, 'mermaid');
  t('后端未接入版本列表时不抛（界面照样能装）', r.missing === true && r.list.length === 0);
}

{
  const ctx = vCtx(async () => {
    throw new Error('下载失败 HTTP 502');
  });
  const r = await rt.fetchRuntimeDepVersions(ctx, 'mermaid');
  t('取版本列表失败时返回 error 而不是抛', !!r.error && r.list.length === 0, String(r.error));
  t('失败原因带得上后端给的原文', /502/.test(String(r.error)), String(r.error));
}

{
  const ctx = vCtx(async () => ({ versions: [] }));
  const r = await rt.fetchRuntimeDepVersions(ctx, 'mermaid');
  t('后端给空列表时当成失败（否则界面会显示"没有版本可选"）', !!r.error && r.list.length === 0);
}

{
  const ctx = vCtx(async () => ({}));
  await rt.fetchRuntimeDepVersions(ctx, '');
  t('包名为空时一个请求都不发', ctx.n() === 0, `n=${ctx.n()}`);
}

/* 装包这条路径**不能**依赖版本列表 —— 拿不到列表就该还能手填装 */
t('installRuntimeDep 不依赖版本列表（两者是独立失败域）',
  !/fetchRuntimeDepVersions/.test(rtSrc.split('export async function installRuntimeDep')[1] || ''));

/* 后端：拼 URL 之前必须校验包名，否则能拼出任意路径段 */
t('后端取版本列表前校验包名（不能直接拼进 URL）',
  /fn is_npm_name/.test(rsSrc) && /if !is_npm_name\(&name\)/.test(rsSrc));
t('包名校验挡得住 .. 与多级路径',
  /name\.contains\("\.\."\)/.test(rsSrc) && /matches!\(c, '\.' \| '_' \| '-' \| '@' \| '\/'\)/.test(rsSrc));
t('版本列表走 https（与下载同一条路，CSP 不用改）',
  /https:\/\/data\.jsdelivr\.com\/v1\/package\/npm\//.test(rsSrc));
t('后端过滤预发布版本', /!s\.contains\('-'\)/.test(rsSrc));
/*
 * 顺序只有一个地方说了算（前端 cmpVersion）。后端再排一次就会变成两份
 * 排序规则，而漂移的表现只是"列表顺序怪怪的"，没人会去查。
 */
t('后端不另排一次序（排序规则只在 cmpVersion 一处）',
  !/out\.sort\(\)/.test(rsSrc) && /排序规则/.test(rsSrc));

/* 界面 */
t('版本框绑定了 datalist（能挑）', /list=\{depListId\(spec, nameKey\)\}/.test(card));
t('datalist 渲染出选项', /<datalist id=\{depListId\(spec, nameKey\)\}>/.test(card));
t('只在点开版本框时才去拉列表（不是打开设置页就发一堆请求）',
  /onFocus=\{\(\) => loadVers\(spec\?\.name \|\| nameKey\)\}/.test(card));
t('datalist 的 id 做了字符清洗（scope 包名里的 @ 和 / 会毁掉选择器）',
  /function depListId/.test(card) && /replace\(\/\[\^A-Za-z0-9\]\/g, '_'\)/.test(card));
t('取不到版本列表时给出提示', /取不到版本列表，可手填/.test(card));
t('取不到版本列表时把原因留在 title 上（不是只留一句"失败"）',
  /title=\{versErr\[spec\?\.name \|\| nameKey\]\}/.test(card));
t('版本列表失败不禁用「安装」按钮（还能手填装）',
  /disabled=\{running \|\| rtMissing\}/.test(card) && !/disabled=\{[^}]*versErr/.test(card));


/* ---------- 8. 整包卸载（purge）—— 残留必须看得见、删得掉 ---------- */

/*
 * 这一组守的是"清理"这一侧。
 *
 * 缺口从哪来：DepsCard 按 js/deps-manifest.js **逐行**渲染，而运行时依赖
 * 是装进工具目录的、与清单无关。于是一个包装过之后又被从 package.json
 * 删掉，它就再也不会出现在任何一行里 —— **看不见，就删不掉**，
 * 只能在磁盘上越堆越多。整包卸载按包名走，与清单里还有没有这一项无关。
 */

t('CMD_PURGE 常量存在（前端与后端对同一个命令名）', rt.CMD_PURGE === 'fpx_rt_dep_purge');

/* ① 归属判定：必须用「安全名 + @」前缀，不能 startsWith(name) */
t('safeNameOf 把 scope 包的 @ 和 / 换掉', rt.safeNameOf('@plantuml/core') === '_plantuml_core',
  rt.safeNameOf('@plantuml/core'));
t('depPrefixOf 是 安全名 + @', rt.depPrefixOf('@plantuml/core') === '_plantuml_core@', rt.depPrefixOf('@plantuml/core'));
/*
 * 跨包删除是这条链路上最坏的一类错：被删的那个包在界面上从没出现过，
 * 用户根本无从察觉，只会觉得"磁盘上的东西莫名其妙少了"。
 */
t('前缀判据不会跨包误伤（md 不会删掉 md-viewer）',
  !'md-viewer@1.0.0.mjs'.startsWith(rt.depPrefixOf('md')) &&
    'md@1.0.0.mjs'.startsWith(rt.depPrefixOf('md')));
t('前缀判据不会把无版本的杂文件算进来', !'md.mjs'.startsWith(rt.depPrefixOf('md')));

/* ② 真跑：返回删掉的份数 */
{
  const ctx = stubCtx(async (cmd, args) => {
    if (cmd === rt.CMD_PURGE) return { removed: 3, files: ['mermaid@11.mjs', 'mermaid@12.mjs', 'mermaid@13.mjs'] };
    return {};
  });
  const r = await rt.purgeRuntimeDep(ctx, 'mermaid');
  t('整包卸载返回删掉的份数', r.ok === true && r.removed === 3 && r.files.length === 3, JSON.stringify(r));
}

/* ③ removed === 0 不算失败 —— 目标是"不再存在"，它此前在不在没意义 */
{
  const ctx = stubCtx(async () => ({ removed: 0, files: [] }));
  const r = await rt.purgeRuntimeDep(ctx, 'mermaid');
  t('没装过时整包卸载算成功（removed=0）', r.ok === true && r.removed === 0);
}

/* ④ 命令不存在要明说，不能静默、也不能把进程崩掉 */
{
  let r = null; let threw = false;
  try { r = await rt.purgeRuntimeDep(missingCtx(), 'mermaid'); } catch (e) { threw = true; }
  t('整包卸载命令不存在时给出明确原因且不抛', !threw && r && r.ok === false && r.missing === true);
}

/* ⑤ 包名为空时一个请求都不发 */
{
  let n = 0;
  const ctx = { invoke: async () => { n++; return {}; }, convertFileSrc: (x) => `asset://${x}` };
  const r = await rt.purgeRuntimeDep(ctx, '   ');
  t('整包卸载包名为空时直接返回（不发请求）', r.ok === false && n === 0, `n=${n}`);
}

/* ⑥ 残留识别：按安全名比对，不能把 scope 包全误判成残留 */
{
  const installed = [
    { name: '_plantuml_core', version: '1.2026.8' },
    { name: 'mermaid', version: '12.0.0' },
    { name: 'gone-pkg', version: '1.0.0' },
  ];
  const o = rt.orphanDepsOf(installed, ['@plantuml/core', 'mermaid']);
  t('残留只挑清单里没有的', o.length === 1 && o[0].name === 'gone-pkg', JSON.stringify(o.map((x) => x.name)));
  /*
   * 后端从文件名还原出的 name 是安全化过的（`_plantuml_core`），
   * 清单里写的是 `@plantuml/core`。直接比字符串会把它判成残留 ——
   * 界面上凭空多出一堆"清单里没有"，而真相只是命名口径不同。
   */
  t('scope 包不因命名口径被误判成残留',
    !rt.orphanDepsOf(installed, ['@plantuml/core', 'mermaid', 'gone-pkg']).some((x) => x.name === '_plantuml_core'));
  t('清单为空时全部算残留（不是全不算）', rt.orphanDepsOf(installed, []).length === 3);
  t('已装为空时不报错', rt.orphanDepsOf(null, ['mermaid']).length === 0);
}

/* ⑦ 接线：少一处就是"点了没反应" */
t('注册 fpx_rt_dep_purge', /rt_dep::fpx_rt_dep_purge/.test(mainText));
t('purge 定 W（与 remove 同级，不是 M）', /fpx_rt_dep_purge:\s*'W'/.test(capsText));
/*
 * 白名单断言必须**先剥注释**：注释里写着命令名，不剥的话把真项删掉
 * 断言照样匹配注释里的字样 → 假绿（本项目已多次踩到）。
 */
t('settings 白名单含 purge', /fpx_rt_dep_purge/.test(policyCode));

/* ⑧ 后端：整包卸载自身的收口 */
const rsPurge = rsText.slice(rsText.indexOf('pub fn fpx_rt_dep_purge'));
t('后端 purge 用 safe_name_of 算前缀（不另写一份命名规则）',
  /let prefix = format!\("\{\}@", safe_name_of\(&name\)\)/.test(rsPurge));
t('后端 purge 按前缀 + 后缀双重判据', /starts_with\(&prefix\)/.test(rsPurge) && /is_rt_file\(&f\)/.test(rsPurge));
/*
 * is_rt_file 必须同时认 .mjs 与 .classic.js。
 * 只认 .mjs 的话，伴生文件会**永远留在磁盘上**：那个包已经显示"已卸载"，
 * 却还躺着它的 Graphviz 运行时，而且没有任何入口能再删它 ——
 * 正是整包卸载这条要修的失效形态，不能在这里又开一个口子。
 */
{
  const iFn = rsText.indexOf('fn is_rt_file');
  const rsFn = rsText.slice(iFn, iFn > 0 ? rsText.indexOf(String.fromCharCode(10) + '}', iFn) : 0);
  t('is_rt_file 同时认 .mjs 与 .classic.js',
    /ends_with\("\.mjs"\)/.test(rsFn) && /ends_with\("\.classic\.js"\)/.test(rsFn), rsFn);
}
t('后端 purge 拒绝空包名', /包名为空/.test(rsPurge));
/*
 * 删除失败必须往外报，不能跳过继续。
 * 跳过的话返回成功，用户刷新后看到"还有一份"，那时已无从区分
 * 是没删掉还是又装回来了。
 */
t('后端 purge 删除失败要报错（不静默跳过）', !/let _ =/.test(rsPurge) && /\?;/m.test(rsPurge));
t('后端 safe_file_of 复用 safe_name_of（命名规则只有一份）',
  /fn safe_file_of[\s\S]{0,200}safe_name_of\(name\)/.test(rsText));

/* ⑨ 界面：整包卸载与残留区都要有入口 */
/*
 * 整包卸载的入口必须**按调用点**断言，不能只查文案出现过。
 * 文件里的注释和说明文字都写着"整包卸载"，只查 `整包卸载` 的话，
 * 把按钮删掉断言照样全绿 —— 假绿，而且是最难发现的那种。
 */
t('每个已装的包都有整包卸载入口（按调用点断言，不是查文案）',
  /onClick=\{\(\) => doPurge\(nameKey\)\}/.test(cardText));
t('残留区每行都有整包卸载入口', /onClick=\{\(\) => doPurge\(on\)\}/.test(cardText));
t('界面有残留区（已装但清单里没有）', /dep-orphans/.test(cardText) && /orphanDepsOf/.test(cardText));
/*
 * 「移除」只删那一行、「整包卸载」按包名删全部 —— 两种动作的区别必须
 * 在界面上说得出来，否则用户会以为「移除」点了没清干净而反复点。
 */
t('界面说明了整包卸载与逐条移除的区别', /整包卸载 = 删掉/.test(cardText));
t('残留区有样式（否则与清单行没有视觉区分）', /\.dep-orphans\s*\{/.test(read('css/neumorphism.css')));

/* ---------- ⑨ 伴生文件：ESM 主体 + 经典脚本 ---------- */
/*
 * 有些包不是一个 ESM 单文件就够的：@plantuml/core 的 Graphviz 布局
 * 由 viz-global.js 提供，而它是经典脚本（实测无顶层 export{}），
 * 必须以 <script> 加载、且**先于** ESM import。
 *
 * 这一组守三件事：地址要取原始文件、伴生要一起装、加载顺序不能反。
 * 任一条错了的表现都是"装成功但没效果"，不报错。
 */
{
  t('伴生包取原始 ESM 文件，不走 +esm（重打包是多余的一次失败面）',
    rt.entryUrlOf('@plantuml/core', '1.2026.8').endsWith('/plantuml.js'),
    rt.entryUrlOf('@plantuml/core', '1.2026.8'));
  t('伴生包的主地址不含 +esm', !rt.entryUrlOf('@plantuml/core', '1.2026.8').includes('+esm'));
  t('伴生地址指向原始经典脚本（转成 ESM 就不挂全局了）',
    rt.classicUrlOf('@plantuml/core', '1.2026.8').endsWith('/viz-global.js') &&
      !rt.classicUrlOf('@plantuml/core', '1.2026.8').includes('+esm'),
    rt.classicUrlOf('@plantuml/core', '1.2026.8'));
  t('不需要伴生的包返回 null', rt.classicUrlOf('mermaid', '12.0.0') === null);
  t('普通包仍是 +esm', rt.entryUrlOf('mermaid', '^12.0.0').includes('+esm'));

  /*
   * @plantuml/core 已从禁用名单移除 —— 但只有在伴生机制真的存在时才成立。
   * 这两条一起钉住：少任何一条，它就会变成"装了却缺零件"。
   */
  t('@plantuml/core 已解禁（伴生机制在，不再是单文件装不了的形态）',
    !Object.prototype.hasOwnProperty.call(rt.RT_BLOCKED || {}, '@plantuml/core'));
  t('解禁的伴生包确实在 RT_CLASSIC 里（防止解禁了却没人下载伴生）',
    !!rt.classicSpecOf('@plantuml/core'));

  /* 命名规则：前端与后端必须一致（与 safeFileOf 那条同构） */
  /*
   * 只断言结构（用了 safe_name_of + safe_ver_of、后缀是 .classic.js），
   * 不把 `&name` / 参数顺序也钉死 —— 那些改了不影响契约，
   * 钉太死只会让"改了个写法"变成假红。
   */
  t('classicFileOf 与 Rust classic_file_of 同构',
    /format!\("\{\}@\{\}\.classic\.js", safe_name_of\(/i.test(rsText) &&
      /safe_ver_of\(/.test(rsText.slice(rsText.indexOf('fn classic_file_of'), rsText.indexOf('fn classic_file_of') + 300)));
  t('后端版本归一化只有一份（ESM 与伴生共用 safe_ver_of）',
    (rsText.match(/fn safe_ver_of/g) || []).length === 1);

  /* 行为：真跑 install，伴生地址必须显式带上（null 也不许省略） */
  {
    let args = null;
    const ctx = stubCtx(async (cmd, a) => {
      if (cmd === 'fpx_rt_dep_install') { args = a; return { ok: true, file: 'x.mjs' }; }
      if (cmd === 'fpx_rt_dep_list') return [];
      return { ok: true };
    });
    await rt.installRuntimeDep(ctx, { kind: 'runtime', dev: false, install: 'npm i @plantuml/core@1.2026.8' });
    t('装伴生包时带上了 classicUrl', !!(args && typeof args.classicUrl === 'string' && args.classicUrl.includes('viz-global.js')),
      JSON.stringify(args));

    args = null;
    await rt.installRuntimeDep(ctx, { kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0' });
    /*
     * 不需要伴生时必须显式 null，不能是 undefined。
     * 有些桥接层会把 undefined 当成"没传"，于是伴生不下载也不报错。
     */
    t('不需要伴生时 classicUrl 显式为 null（不是 undefined）',
      !!args && args.classicUrl === null, JSON.stringify(args));
  }

  /* 行为：真跑 requireDep，伴生必须**先于** ESM 注入 */
  {
    const order = [];
    const ctx = stubCtx(async (cmd) => {
      if (cmd === 'fpx_rt_dep_list') {
        return [{
          name: '@plantuml/core', version: '1.2026.8',
          file: '_plantuml_core@1.2026.8.mjs', path: '/deps/_plantuml_core@1.2026.8.mjs',
          classicFile: '_plantuml_core@1.2026.8.classic.js', size: 10,
        }];
      }
      return { ok: true };
    });
    rt.__clearDepDecisions();
    const r = await rt.requireDep(ctx, '@plantuml/core', {
      fallback: async () => ({ tag: 'bundle' }),
      importModule: async () => { order.push('esm'); return { renderToString() {} }; },
      loadClassic: async () => { order.push('classic'); return true; },
    });
    t('伴生先于 ESM 加载（顺序反了 = 引擎缺零件，报错离这步很远）',
      order.join(',') === 'classic,esm', order.join(','));
    t('伴生在的时候用运行时那份', r.source === 'runtime', r.source);

    /* 伴生注入失败必须回退，不能带着缺零件的引擎继续 */
    rt.__clearDepDecisions();
    const r2 = await rt.requireDep(ctx, '@plantuml/core', {
      fallback: async () => ({ tag: 'bundle' }),
      importModule: async () => ({ renderToString() {} }),
      loadClassic: async () => { throw new Error('viz 404'); },
    });
    t('伴生加载失败回退打包版（不带缺零件的引擎继续）',
      r2.source === 'bundle' && /伴生/.test(r2.error), r2.source + ' | ' + r2.error);
  }

  /*
   * 原子性：所有下载都完成后才允许落盘。
   * 边下边写的话，伴生下载失败会留下"主体在、伴生不在"的半装状态 ——
   * 界面显示已安装，插件加载才发现缺零件，而且用户没法重试（重装先看到已安装）。
   */
  {
    const lastFetch = rsInstall.lastIndexOf('fetch_text(');
    const firstWrite = rsInstall.indexOf('fs::write(');
    t('后端先下完所有文件再落盘（不留半装状态）',
      lastFetch >= 0 && firstWrite > lastFetch, `fetch@${lastFetch} write@${firstWrite}`);
    t('后端伴生下载失败时明说未落盘、可重试', /未落盘，可重试/.test(rsInstall));
  }

  /* 重试：CDN 会偶发 502（实测同一个地址时好时坏） */
  {
    /*
     * 必须断言**循环真的用了**这个常量。
     * 只查 `const FETCH_ATTEMPTS` 存在不够：把循环改成 `0..1` 常量照样在，
     * 于是"取消重试"这种改动一点不红（本轮 D1 实测就是这么 MISS 的）。
     */
    t('后端真的按重试次数循环（不是只定义了个常量）',
      /for _ in 0\.\.FETCH_ATTEMPTS/.test(rsText));
    t('后端区分瞬时失败与永久失败', /fn is_transient/.test(rsText));
    t('只对 5xx 与连接失败重试（4xx 重试多少次都一样）',
      /starts_with\("HTTP 5"\)/.test(rsText) && !/starts_with\("HTTP 4"\)/.test(rsText));
    t('非瞬时失败直接返回，不空跑重试', /if !is_transient\(&e\)/.test(rsText));
  }
}

/* ---------- ⑩ CSP：运行时依赖靠 asset 协议加载 ---------- */

/*
 * 装在工具内部的包落在应用数据目录 deps/ 下，js/runtime-deps.js 用
 * convertFileSrc 转成 asset 协议后**动态 import()**。
 * 按 CSP 规范动态 import 受 script-src 管辖，而 'self' 只等于页面自己的源
 * （tauri.localhost），**不匹配** asset.localhost。
 *
 * 少了这两项的表现极其隐蔽：requireDep 的设计是"运行时那份 import 失败就
 * 回退到打包版"，于是装完界面显示「已安装」、渲染也正常，但用的始终旧的
 * 那份 —— 不报错、不降级，只是「一键换版本」从头到尾没生效。
 */
const CSP_ASSET = ['asset:', 'http://asset.localhost'];

/**
 * 从 `script-src 'self' ...;` 整串里切出**某一条**指令。
 *
 * ⚠️ 必须按指令切段，不能用 `csp.includes('asset:')`：
 * img-src 与 media-src **一直**带着 asset，那样写恒为真 ——
 * 把 script-src 里的 asset 删干净照样全绿。这是本项目反复出现的
 * "查存在性、不查那一处"的假绿（command-consistency / md-service 都栽过）。
 */
function directiveOf(csp, name) {
  const seg = String(csp).split(';').map((s) => s.trim())
    .find((s) => s === name || s.startsWith(`${name} `));
  return seg || '';
}

/** 从 BASE_CSP 的 JS 字面量里切出某条指令的数组内容 */
function baseDirectiveOf(src, name) {
  const m = src.match(new RegExp(`['"]?${name}['"]?:\\s*\\[([^\\]]*)\\]`));
  return m ? m[1] : '';
}

const cfgSrc = read('config/nexus.config.mjs');
const baseScript = baseDirectiveOf(cfgSrc, 'script-src');
t('BASE_CSP 的 script-src 放行 asset 协议',
  baseScript.length > 0 && CSP_ASSET.every((a) => baseScript.includes(a)),
  `script-src = [${baseScript}]`);
/*
 * 反向自测：判据本身不能是恒真的。
 * 直接查整个文件里有没有 asset: —— img-src/media-src 一直有，恒真。
 * 断言"这个恒真写法确实存在"没意义；要紧的是上面那条用的是切段后的结果，
 * 所以这里钉住"切出来的 script-src 段里没有 asset 就是红"（见破坏验证）。
 */
t('script-src 段的判据不是恒真（img-src 段确实不含 unsafe-eval 可证切段有效）',
  baseDirectiveOf(cfgSrc, 'img-src').includes('data:') &&
  !baseDirectiveOf(cfgSrc, 'img-src').includes('unsafe-eval'));

/* 两份 tauri 配置 + 两个入口 HTML：改一处忘一处，CSP 只在一侧生效 */
for (const f of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.vite.conf.json']) {
  const txt = read(f);
  const csps = [...txt.matchAll(/"(?:dev)?csp":\s*"([^"]+)"/g)].map((m) => m[1]);
  t(`${f} 的 csp/devCsp 至少有一条`, csps.length > 0);
  for (const csp of csps) {
    const seg = directiveOf(csp, 'script-src');
    t(`${f} 的 script-src 放行 asset 协议`,
      seg.length > 0 && CSP_ASSET.every((a) => seg.includes(a)), seg);
  }
}
for (const f of ['index.html', 'index.react.html']) {
  const txt = read(f);
  const m = txt.match(/content="([^"]*script-src[^"]*)"/);
  const seg = m ? directiveOf(m[1], 'script-src') : '';
  t(`${f} 的 CSP meta 放行 asset 协议`,
    seg.length > 0 && CSP_ASSET.every((a) => seg.includes(a)), seg);
}

/*
 * 反向边界：js/external-policy.js 那套是**外部**插件的 CSP，
 * 刻意**不给** asset —— 外部插件不该读应用数据目录。
 * 有人为了"两边统一"把它补上，就等于把 deps/ 暴露给外部插件。
 */
const extSrc = read('js/external-policy.js');
const extSeg = (extSrc.match(/script-src\s+([^;`]+)/) || [, ''])[1];
t('外部插件的 CSP 不放行 asset（有意的安全边界，不要照 BASE_CSP 补）',
  extSeg.length > 0 && CSP_ASSET.every((a) => !extSeg.includes(a)), extSeg);


/* ---------- 7c. 取用台账：装了到底用上没有，必须看得见 ---------- */
/*
 * 这一组守的是"装成功却没效果"的**最后一种形态**：
 *
 * 安装那一步是真成功的（装完会真 import 一次验证），但插件真正渲染时
 * 那份坏了 → 静默回退打包版。于是"已安装并验证可加载"与"实际在用打包版"
 * 可以同时成立、都不报错 —— 用户在设置页上完全看不出来。
 * requireDep 的 source 只有调用它的那个插件看得见，所以必须落到模块级
 * 台账，由设置页读出来。
 */

/* ① 用上装的那份 */
{
  rt.__clearDepDecisions();
  rt.__clearDepUsage();
  const ctx = makeCtx([{ name: 'mermaid', version: '12.0.0', path: 'C:/deps/mermaid@12.0.0.mjs' }]);
  await rt.requireDep(ctx, 'mermaid', { fallback: fb, importModule: async () => RUNTIME });
  const u = rt.depUsageOf('mermaid');
  t('用上装的那份 → 台账记 runtime', u.length === 1 && u[0].source === 'runtime', JSON.stringify(u));
  t('台账带**实际版本**（空或 * 等于没说）', !!u[0] && u[0].version === '12.0.0', JSON.stringify(u[0] || null));
}

/* ② 装的那份坏了 → 回退，台账必须记成 bundle + 原因 */
{
  rt.__clearDepDecisions();
  rt.__clearDepUsage();
  const ctx = makeCtx([{ name: 'mermaid', version: '12.0.0', path: 'C:/deps/bad.mjs' }]);
  await rt.requireDep(ctx, 'mermaid', {
    fallback: fb,
    importModule: async () => { throw new Error('Unexpected token'); },
  });
  const u = rt.depUsageOf('mermaid');
  t('回退到打包版 → 台账记 bundle（这才是"装了没效果"）',
    u.length === 1 && u[0].source === 'bundle', JSON.stringify(u));
  t('回退时台账带原因（否则用户无从排查）',
    /Unexpected token/.test((u[0] || {}).error || ''), (u[0] || {}).error);
}

/* ③ 没取用过 → 空。这一档必须**区别于**上面的回退 */
{
  rt.__clearDepDecisions();
  rt.__clearDepUsage();
  t('没取用过 → 台账为空（不能当成"装了没效果"）', rt.depUsageOf('mermaid').length === 0);
}

/* ④ 快照与清空 */
{
  rt.__clearDepDecisions();
  rt.__clearDepUsage();
  const ctx = makeCtx([{ name: 'mermaid', version: '12.0.0', path: 'C:/deps/m12.mjs' }]);
  await rt.requireDep(ctx, 'mermaid', { fallback: fb, importModule: async () => RUNTIME });
  const snap = rt.depUsageSnapshot();
  t('depUsageSnapshot 能取到全部记录（设置页按包名建索引）',
    snap.some((x) => x && x.name === 'mermaid' && x.source === 'runtime'), JSON.stringify(snap));
  rt.__clearDepUsage();
  t('__clearDepUsage 清得掉', rt.depUsageOf('mermaid').length === 0);
}

/* ④b 按包名过滤：多个包都有记录时不能串台 */
{
  rt.__clearDepDecisions();
  rt.__clearDepUsage();
  const c1 = makeCtx([{ name: 'mermaid', version: '12.0.0', path: 'C:/deps/m12.mjs' }]);
  await rt.requireDep(c1, 'mermaid', { fallback: fb, importModule: async () => RUNTIME });
  const c2 = makeCtx([{ name: 'rehype-slug', version: '6.0.0', path: 'C:/deps/slug.mjs' }]);
  await rt.requireDep(c2, 'rehype-slug', { fallback: fb, importModule: async () => RUNTIME });
  const u = rt.depUsageOf('mermaid');
  t('depUsageOf 只返回该包的记录（多包并存不串台）',
    u.length === 1 && u.every((x) => x && x.name === 'mermaid'), JSON.stringify(u));
  t('另一个包也有自己的记录', rt.depUsageOf('rehype-slug').length === 1);
  rt.__clearDepUsage();
}

/* ⑤ 界面：三态必须都渲染出来，且判据用**剥注释后**的代码 */
{
  const cardCodeRt = cardText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  t('DepsCard 读取用台账', /depUsageSnapshot\(\)/.test(cardCodeRt));
  t('refresh 里一并刷新台账（台账是内存事实，不与 list 一起刷就不会变）',
    /depUsageSnapshot\(\)/.test(cardCodeRt) && /setUsage\(/.test(cardCodeRt));
  t('界面有"实际在用这份"这一态', /实际在用这份/.test(cardCodeRt));
  t('界面有"装了但实际在用打包版"这一态', /装了，但实际在用打包版/.test(cardCodeRt));
  t('界面有"本次会话还没被取用"这一态（不能并进"没效果"）',
    /本次会话还没被取用/.test(cardCodeRt));
  t('回退原因要显示出来', /回退原因/.test(cardCodeRt));
  t('有刷新入口（台账是运行时事实，不手动刷不会变）',
    /刷新状态/.test(cardCodeRt) && /onClick=\{\(\) => refresh\(\)\}/.test(cardCodeRt));
}

console.log(`\n运行时依赖：${pass} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
