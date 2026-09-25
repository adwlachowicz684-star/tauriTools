/**
 * 应用自更新（updater）测试
 * ============================================================
 * 三类断言：
 *   ① 契约 —— registry 条目、白名单、能力分级。
 *      这类错了**不报错**（服务静默调不到 / 命令被策略拦掉/
 *      第三方插件悄悄拿到 M 类能力），只能靠断言钉住。
 *   ② 行为 —— 真跑 plugins/updater/module.js（注入 stub ctx），
 *      验证通道归一化与命令透传。只查源码会放过
 *      "参数传了但没生效"这类错。
 *   ③ 构建前提 —— 少了 createUpdaterArtifacts / 私钥占位符未替换，
 *      表现都是"看起来能用、实际永远失败"，必须钉在测试里。
 *
 * ⚠️ Rust 侧（src/updater.rs）**没有 cargo，无法编译验证**。
 *    这里只能做源码断言 + 与 JS 侧的常量一致性比对。
 *    真机验证需要本地 cargo build。
 *
 * 运行：node updater-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

const rust = read('src-tauri/src/updater.rs');
const mainRs = read('src-tauri/src/main.rs');
const cargo = read('src-tauri/Cargo.toml');
const confRaw = read('src-tauri/tauri.conf.json');
/** tauri.conf.json 是严格 JSON（实测无注释），直接解析 */
const conf = JSON.parse(confRaw);
const caps = read('js/command-caps.js');
const policy = read('js/invoke-policy.js');
const reg = read('plugins/registry.js');
const svc = read('plugins/updater/module.js');
const card = read('plugins/settings/UpdateCard.tsx');
const app = read('plugins/settings/App.tsx');

/* ============================================================
   1. registry 契约（丢了不会报错，只会"点了没反应"）
   ============================================================ */
console.log('\n=== 1. registry 条目 ===');

/* 精确切 updater 这一条的区块：用"前后各取 N 字符"的窗口会盖到
   相邻条目，把别人注释里的文字当成真标记（这条踩过：md-service
   那条就因为窗口盖到 color-picker 而假红）。 */
const idx = reg.indexOf("id: 'updater'");
t('registry 里有 updater 这条', idx >= 0);
const blk = idx >= 0
  ? reg.slice(reg.lastIndexOf('  {', idx), reg.indexOf('\n  },', idx))
  : '';

t("kind 是 service（否则会进侧边栏）", /kind:\s*'service'/.test(blk));
t("type 是 module（同页，ctx.invoke 不走桥接）", /type:\s*'module'/.test(blk));
t('builtin: true —— M 类命令只有内置插件能拿', /builtin:\s*true/.test(blk));

/* entry 必须真实存在：写错路径的表现是运行时 404 且查不到哪错了 */
const entry = (blk.match(/entry:\s*'([^']+)'/) || [])[1] || '';
t(`entry 指向的文件存在（${entry}）`,
  !!entry && (() => { try { read(entry.replace('./', '')); return true; } catch { return false; } })());

/* ============================================================
   2. 权限：M 类只给内置 updater
   ============================================================ */
console.log('\n=== 2. 能力分级与白名单 ===');

for (const cmd of ['updater_check', 'updater_install', 'updater_relaunch']) {
  /* 只查"表里有没有这个键"会被注释里的文字骗过去 ——
     所以先剥注释，再按 `键: '等级'` 精确匹配。 */
  const bare = caps.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = bare.match(new RegExp(`\\b${cmd}:\\s*'([A-Za-z]+)'`));
  t(`${cmd} 定级为 M`, !!m && m[1] === 'M');
}

const THIRD_DENY = /THIRD_DENY_CAPS\s*=\s*\[([^\]]*)\]/.exec(policy);
t('第三方插件禁 M（THIRD_DENY_CAPS 含 M）', !!THIRD_DENY && /'M'/.test(THIRD_DENY[1]));

const pIdx = policy.indexOf('  updater: [');
t('invoke-policy 里有 updater 白名单', pIdx >= 0);
const pLine = pIdx >= 0 ? policy.slice(pIdx, policy.indexOf('],', pIdx)) : '';
t('白名单只含这三条', ['updater_check', 'updater_install', 'updater_relaunch']
  .every((c) => pLine.includes(c)) && !/'[a-z_]+'\s*,\s*'updater_check/.test(pLine));

/*
 * 设置页**不能**直接拿到这三条命令 —— UI 在设置页，但能力必须收在
 * updater 名下。把命令给设置页等于"谁能画界面谁就能装更新"。
 */
const sIdx = policy.indexOf('  settings: [');
const sLine = sIdx >= 0 ? policy.slice(sIdx, policy.indexOf('],', sIdx)) : '';
t('设置页白名单里没有 updater_install（必须走服务调用）',
  sIdx >= 0 && !sLine.includes('updater_install'));

/* ============================================================
   3. Rust 侧接线
   ============================================================ */
console.log('\n=== 3. Rust 接线 ===');

t('Cargo.toml 有 tauri-plugin-updater', /tauri-plugin-updater\s*=/.test(cargo));
t('main.rs 声明 mod updater', /\bmod\s+updater;/.test(mainRs));
t('main.rs 注册了插件', /\.plugin\(\s*tauri_plugin_updater::Builder::new\(\)/.test(mainRs));

/* generate_handler! 里缺一条 = 运行时 "command not found"，编译不报错 ——
   这正是 command-consistency 扫描器要抓的那类缺口。 */
const handler = mainRs.slice(mainRs.indexOf('generate_handler!['), mainRs.indexOf('generate_handler![') + 4000);
for (const c of ['updater::updater_check', 'updater::updater_install', 'updater::updater_relaunch']) {
  t(`generate_handler! 里有 ${c}`, handler.includes(c));
}

t('端点按通道分支（beta / stable）', /updater-beta/.test(rust) && /updater-stable/.test(rust));
t('双端点：GitHub 在前、Gitee 在后（依次尝试）',
  (() => {
    const fn = rust.slice(rust.indexOf('fn endpoints_for'), rust.indexOf('fn pubkey_ready'));
    const gh = fn.indexOf('GH_RELEASE');
    const gt = fn.indexOf('GITEE_RELEASE');
    return gh >= 0 && gt > gh;
  })());

/* ============================================================
   4. 构建前提（错了表现为"看起来能用、实际永远失败"）
   ============================================================ */
console.log('\n=== 4. 构建前提 ===');

t('bundle.createUpdaterArtifacts 为 true（否则不生成 .sig，安装必失败）',
  conf.bundle?.createUpdaterArtifacts === true);

const up = conf.plugins?.updater;
t('tauri.conf.json 有 plugins.updater', !!up);
t('端点有两条（GitHub + Gitee）', Array.isArray(up?.endpoints) && up.endpoints.length === 2);
t('端点含 GitHub 与 Gitee',
  !!up && up.endpoints.some((u) => u.includes('github.com'))
      && up.endpoints.some((u) => u.includes('gitee.com')));
t('pubkey 存在', typeof up?.pubkey === 'string' && up.pubkey.length > 0);

/*
 * 两处公钥必须一致：配置里那份给默认流程，updater.rs 里那份给
 * 双通道流程。不一致的表现是"某个通道永远验签失败"。
 */
const rustKey = (/const UPDATER_PUBKEY:\s*&str\s*=\s*"([^"]*)"/.exec(rust) || [])[1];
t('updater.rs 里有 UPDATER_PUBKEY 常量', typeof rustKey === 'string');
t('两处公钥完全一致（配置 ↔ Rust 常量）', !!rustKey && rustKey === up?.pubkey);

const isPlaceholder = (k) => typeof k === 'string' && k.startsWith('REPLACE_WITH');
if (isPlaceholder(rustKey)) {
  console.log('⚠️  公钥仍是占位符 —— 更新功能**当前不可用**。');
  console.log('    生成：npx tauri signer generate --write-keys ~/.tauri/tauri.key');
  console.log('    填进 tauri.conf.json → plugins.updater.pubkey 与 updater.rs → UPDATER_PUBKEY');
  console.log('    详见 docs/更新与签名.md');
}
/* 占位符时必须有"明确报未配置"的分支，否则会伪装成"没有更新" */
t('未配公钥时有 unconfigured 状态（不伪装成"已是最新"）',
  /state:\s*"unconfigured"/.test(rust) && /pubkey_ready\(\)/.test(rust));

/* ============================================================
   5. 服务插件：真跑（注入 stub ctx）
   ============================================================ */
console.log('\n=== 5. 服务行为（真跑） ===');

const mod = await import('./plugins/updater/module.js');
const def = mod.default;

t('导出 mount / methods', typeof def?.mount === 'function' && !!def?.methods);
for (const m of ['check', 'install', 'relaunch', 'info']) {
  t(`methods 里有 ${m}`, typeof def?.methods?.[m] === 'function');
}

/* stub ctx：记录调用，不真的发请求 */
const calls = [];
const stubCtx = {
  invoke: (cmd, args) => {
    calls.push([cmd, args]);
    return Promise.resolve(
      cmd === 'updater_check'
        ? { state: 'available', channel: args?.channel, current: '0.1.0', latest: '0.2.0', notes: 'x', date: '', message: '' }
        : 'ok',
    );
  },
};

const cleanup = def.mount(stubCtx);
t('mount 返回 cleanup 函数', typeof cleanup === 'function');

await def.methods.check({ channel: 'beta' });
t('check 透传 beta 通道',
  calls.length === 1 && calls[0][0] === 'updater_check' && calls[0][1]?.channel === 'beta');

await def.methods.check({ channel: '随便乱写' });
t('未知通道收敛为 stable（不能把用户推到内测版）',
  calls[1][0] === 'updater_check' && calls[1][1]?.channel === 'stable');

await def.methods.check({});
t('不传通道默认 stable', calls[2][1]?.channel === 'stable');

await def.methods.install({ channel: 'beta' });
t('install 透传通道',
  calls[3][0] === 'updater_install' && calls[3][1]?.channel === 'beta');

await def.methods.relaunch();
t('relaunch 调 updater_relaunch', calls[4][0] === 'updater_relaunch');

const r = await def.methods.check({ channel: 'stable' });
t('check 原样返回结果（含 state 字段）', r?.state === 'available' && r?.latest === '0.2.0');

cleanup();

/* ============================================================
   6. 设置页 UI
   ============================================================ */
console.log('\n=== 6. 设置页 UI ===');

t('TabKey 含 update', /'update'/.test(app));
t("TABS 里有 ['update', '更新']", /\['update',\s*'更新'\]/.test(app));
t('渲染 UpdateCard', /tab === 'update' \? <UpdateCard/.test(app));
t('组件 import 了 UpdateCard', /import UpdateCard from '\.\/UpdateCard'/.test(app));
t('组件走服务调用而不是直接 invoke',
  /services\.call\('updater'/.test(card) && !/invoke\(\s*'updater_/.test(card));
for (const s of ['unconfigured', 'uptodate', 'available', 'error']) {
  t(`界面区分 ${s} 状态`, card.includes(`'${s}'`));
}
t('装完不自动重启（给「立即重启」按钮）', /立即重启/.test(card));
t('换通道后清空旧结果（否则显示上一通道的结论）', /setResult\(null\)/.test(card));
t('更新说明可选中复制（根 body 是 user-select:none）', /upd-notes/.test(card) && /\.upd-notes/.test(read('css/neumorphism.css')));
/* 上面那条只查「类名存在」——样式块在了但 user-select 被删掉照样全绿，
   而根 body 的 none 会继承下来，划选整个失效（看不出是被继承的）。
   所以单独钉住这一条属性。
   切块要精确：跨行正则会吃到后面别的规则里的 user-select，变假绿。 */
(() => {
  const css = read('css/neumorphism.css');
  const i = css.indexOf('.upd-notes');
  const blk = i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  t('upd-notes 显式声明 user-select: text', /user-select:\s*text/.test(blk));
  t('upd-notes 带 -webkit- 前缀', /-webkit-user-select:\s*text/.test(blk));
})();

/* ============================================================
   7. 反向：别把官方 JS 命令暴露给 webview
   ============================================================ */
console.log('\n=== 7. 官方 JS 命令不暴露 ===');
const capJson = read('src-tauri/capabilities/default.json');
t('capabilities 里没有 plugin:updater|* 权限（更新只走自有命令）',
  !/updater:(allow|default)/.test(capJson));
t('前端没有引 @tauri-apps/plugin-updater',
  !/@tauri-apps\/plugin-updater/.test(read('package.json')));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
