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
  const r = await rt.installRuntimeDep(missingCtx(), {
    kind: 'runtime', dev: false, install: 'npm i mermaid@^12.0.0',
  });
  t('命令不存在时给出明确原因（不是静默失败）', r.ok === false && /尚未接入/.test(r.error || ''), r.error);
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
  const r = await rt.removeRuntimeDep(missingCtx(), 'mermaid', '12.0.0');
  t('移除时命令不存在也明说', r.ok === false && /尚未接入/.test(r.error || ''));
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

const cardText = read('plugins/settings/DepsCard.tsx');
t('DepsCard 接入 runtime-deps', /js\/runtime-deps\.js/.test(cardText));
t('DepsCard 用 canInstall 决定按钮显隐', /canInstall\(/.test(cardText));
t('装完真 import 一次（验可加载）', /loadRuntimeDep\(/.test(cardText));
t('后端未接入时禁用按钮并提示', /rtMissing/.test(cardText) && /disabled=\{running \|\| rtMissing\}/.test(cardText));

console.log(`\n运行时依赖：${pass} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
