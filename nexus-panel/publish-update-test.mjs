/**
 * 发布脚本（scripts/publish-update.mjs）测试
 * ============================================================
 *
 * 为什么要给"发布脚本"写测试 —— 它坏了不会在运行时报错，只会让**用户**
 * 拿到一个查不到 / 装不上的更新：
 *
 *   ① tag 与客户端对不上  → 发布了，客户端说"没有更新"（两边代码都没错）
 *   ② 平台 key 猜错       → 只有**那一台机器**查不到更新，看着像客户端 bug
 *   ③ 传了 .dmg / .exe    → 能查到、能下载，但**装不上**，错误只说"解压失败"
 *   ④ 漏传 .sig           → 每次都能查到更新，安装必失败，错误只说"签名无效"
 *   ⑤ platforms 为空      → 同上，且更难查
 *
 * 这五条全是"发布端看起来成功了"，所以只能钉在测试里。
 *
 * 运行：node publish-update-test.mjs
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeChannel,
  parsePublishTarget,
  tagFor,
  archOf,
  collectArtifacts,
  buildLatestJson,
} from './scripts/publish-update.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

console.log('— 通道归一化 —');
t("'beta' → beta", normalizeChannel('beta') === 'beta');
t("'BETA' → beta（大小写无关）", normalizeChannel('BETA') === 'beta');
t("' beta ' → beta（去空白）", normalizeChannel(' beta ') === 'beta');
t("'stable' → stable", normalizeChannel('stable') === 'stable');
t("未知值 → stable（不许把人推到内测）", normalizeChannel('weird') === 'stable');
t('undefined → stable', normalizeChannel(undefined) === 'stable');
t('null → stable', normalizeChannel(null) === 'stable');

console.log('\n— 从 updater.rs 解析发布目标 —');
const rust = read('src-tauri/src/updater.rs');
const target = parsePublishTarget(rust);
t('解析出 owner', typeof target.owner === 'string' && target.owner.length > 0);
t('解析出 repo', typeof target.repo === 'string' && target.repo.length > 0);
t('解析出 tagStable', target.tagStable === 'updater-stable');
t('解析出 tagBeta', target.tagBeta === 'updater-beta');

/* ① 的核心：脚本解析出来的 tag，必须真的被拼进客户端请求的 URL。
   只断言"常量存在"是不够的 —— 常量可以在，但 endpoints_for 里写死别的字符串。 */
const fnBody = /fn\s+endpoints_for[\s\S]*?\n}/.exec(rust)?.[0] ?? '';
t('endpoints_for 走 tag_for(channel)，不写死字符串', /tag_for\(channel\)/.test(fnBody));
t('endpoints_for 拼的是 latest.json', /latest\.json/.test(fnBody));
const tagFn = /fn\s+tag_for[\s\S]*?\n}/.exec(rust)?.[0] ?? '';
t('tag_for 的 beta 分支返回 TAG_BETA', /CHANNEL_BETA\s*=>\s*TAG_BETA/.test(tagFn));
t('tag_for 的兜底返回 TAG_STABLE', /_\s*=>\s*TAG_STABLE/.test(tagFn));

console.log('\n— 三处发布地址必须一致 —');
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const confEp = conf?.plugins?.updater?.endpoints?.[0] ?? '';
t('tauri.conf.json 端点指向同一 owner/repo', confEp.includes(`github.com/${target.owner}/${target.repo}/`));
t('tauri.conf.json 端点用同一个 stable tag', confEp.includes(target.tagStable));
/* Rust 侧按常量拼出的 stable 端点，必须等于 tauri.conf.json 的默认端点。
   这两条路一条是"默认流程"、一条是"设置页按通道覆盖"，指向不同的话，
   用户以为配好了，实际走的另一个 —— 且不报错。 */
t(
  'Rust 拼出的 stable 端点 == tauri.conf.json 默认端点',
  `${target.ghRelease}/${target.tagStable}/latest.json` === confEp,
);

console.log('\n— 架构推断 —');
t('含 x64 → x86_64', archOf('App_0.1.0_x64-setup.nsis.zip') === 'x86_64');
t('含 aarch64 → aarch64', archOf('App_0.1.0_aarch64.app.tar.gz') === 'aarch64');
t('含 arm64 → aarch64', archOf('App_0.1.0_arm64.app.tar.gz') === 'aarch64');
let threw = false;
try { archOf('App_0.1.0.zip'); } catch { threw = true; }
t('推断不出架构时抛错（不猜）', threw);

console.log('\n— 产物配对 —');
const base = [
  { dir: 'nsis', name: 'App_0.1.0_x64-setup.nsis.zip' },
  { dir: 'nsis', name: 'App_0.1.0_x64-setup.nsis.zip.sig' },
];
{
  const r = collectArtifacts(base);
  t('nsis.zip + .sig → 命中 1 个', r.found.length === 1);
  t('平台 key 是 windows-x86_64', `${r.found[0].os}-${r.found[0].arch}` === 'windows-x86_64');
  t('无错误', r.errors.length === 0);
}
{
  /* ③：.dmg 不能进清单。传上去客户端能查到、能下载，但装不上。 */
  const r = collectArtifacts([
    ...base,
    { dir: 'dmg', name: 'App_0.1.0_aarch64.dmg' },
    { dir: 'dmg', name: 'App_0.1.0_aarch64.dmg.sig' },
  ]);
  t('.dmg 被跳过，不进清单', r.found.every((f) => !f.name.endsWith('.dmg')));
  t('.dmg 被记为 skip 并说明原因', r.skipped.some((s) => s.includes('.dmg')));
}
{
  const r = collectArtifacts([...base, { dir: 'nsis', name: 'App_0.1.0_x64-setup.exe' }]);
  t('无签名的 .exe 不进清单', r.found.every((f) => !f.name.endsWith('.exe')));
}
{
  /* ④：有签名没包。清单里会出现一个指向 404 的 url。 */
  const r = collectArtifacts([{ dir: 'nsis', name: 'App_0.1.0_x64-setup.nsis.zip.sig' }]);
  t('有 .sig 无安装包 → 报错', r.errors.length === 1 && r.found.length === 0);
}
{
  /* ④ 的另一半：有包没签名。客户端验签必失败。 */
  const r = collectArtifacts([{ dir: 'nsis', name: 'App_0.1.0_x64-setup.nsis.zip' }]);
  t('有安装包无 .sig → 报错', r.errors.length === 1 && r.found.length === 0);
}
{
  const r = collectArtifacts([
    { dir: 'macos', name: 'App_0.1.0_aarch64.app.tar.gz' },
    { dir: 'macos', name: 'App_0.1.0_aarch64.app.tar.gz.sig' },
  ]);
  t('.app.tar.gz → darwin-aarch64', `${r.found[0].os}-${r.found[0].arch}` === 'darwin-aarch64');
}
{
  const r = collectArtifacts([
    { dir: 'appimage', name: 'App_0.1.0_amd64.AppImage' },
    { dir: 'appimage', name: 'App_0.1.0_amd64.AppImage.sig' },
  ]);
  t('.AppImage → linux-x86_64', `${r.found[0].os}-${r.found[0].arch}` === 'linux-x86_64');
}
{
  /* ⑤：一个都没有。宁可停在这里，也不要传一份空 platforms 上去。 */
  const r = collectArtifacts([]);
  t('无产物 → found 为空（调用方据此拒绝生成）', r.found.length === 0);
}

console.log('\n— latest.json 结构 —');
const jsonText = buildLatestJson({
  version: '0.2.0',
  notes: '说明',
  platforms: { 'windows-x86_64': { signature: 'SIG', url: 'https://x/y.zip' } },
});
const obj = JSON.parse(jsonText);
t('version 正确', obj.version === '0.2.0');
t('notes 正确', obj.notes === '说明');
t('pub_date 是 RFC3339（UTC）', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(obj.pub_date));
t('platforms 结构正确', obj.platforms['windows-x86_64'].signature === 'SIG');
t('platforms 的 url 正确', obj.platforms['windows-x86_64'].url === 'https://x/y.zip');

console.log('\n— 端到端：真跑 --dry-run —');
const tmp = join(ROOT, '_tmp_publish_fixture');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(tmp, 'nsis'), { recursive: true });
writeFileSync(join(tmp, 'nsis/App_0.1.0_x64-setup.nsis.zip'), 'PK-fake-zip');
writeFileSync(join(tmp, 'nsis/App_0.1.0_x64-setup.nsis.zip.sig'), 'untrusted comment:\nFAKESIG\n');
mkdirSync(join(tmp, 'dmg'), { recursive: true });
writeFileSync(join(tmp, 'dmg/App_0.1.0_aarch64.dmg'), 'dmg');
writeFileSync(join(tmp, 'dmg/App_0.1.0_aarch64.dmg.sig'), 'SIG');

function run(args) {
  try {
    return { code: 0, out: execFileSync('node', ['scripts/publish-update.mjs', ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

{
  const r = run(['--channel=beta', '--notes=内测', '--dry-run', `--from-dir=${tmp}`]);
  t('dry-run 退出码 0', r.code === 0);
  t('输出 upsert 到 beta tag', r.out.includes('updater-beta'));
  t('输出含 windows-x86_64', r.out.includes('windows-x86_64'));
  t('输出不含 darwin（dmg 被排除）', !r.out.includes('darwin-aarch64'));
  t('dry-run 明确说未上传', r.out.includes('未上传'));
  const m = /\{\s*\n\s*"version"[\s\S]*\n\}/.exec(r.out);
  t('打印出的 latest.json 可解析', !!m && !!JSON.parse(m[0]).platforms['windows-x86_64']);
  t('signature 取自 .sig 文件', !!m && JSON.parse(m[0]).platforms['windows-x86_64'].signature.includes('FAKESIG'));
}
{
  const r = run(['--channel=stable', '--dry-run', `--from-dir=${tmp}`]);
  t('stable 用 updater-stable', r.out.includes('updater-stable'));
}
{
  const empty = join(ROOT, '_tmp_publish_empty');
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty, { recursive: true });
  const r = run(['--dry-run', `--from-dir=${empty}`]);
  t('产物目录为空 → 非 0 退出', r.code !== 0);
  t('空目录报错说明拒绝生成空清单', /为空|没有任何/.test(r.out));
}
{
  /* 只放 dmg：没有任何合法产物，也必须拒绝，而不是生成空 platforms */
  const onlyDmg = join(ROOT, '_tmp_publish_dmg');
  rmSync(onlyDmg, { recursive: true, force: true });
  mkdirSync(onlyDmg, { recursive: true });
  writeFileSync(join(onlyDmg, 'App_0.1.0_aarch64.dmg'), 'dmg');
  writeFileSync(join(onlyDmg, 'App_0.1.0_aarch64.dmg.sig'), 'SIG');
  const r = run(['--dry-run', `--from-dir=${onlyDmg}`]);
  t('只有 .dmg → 非 0 退出（不生成空清单）', r.code !== 0);
}
{
  const r = run(['--dry-run', '--from-dir=/definitely/not/here']);
  t('产物目录不存在 → 非 0 退出', r.code !== 0);
}

rmSync(tmp, { recursive: true, force: true });
rmSync(join(ROOT, '_tmp_publish_empty'), { recursive: true, force: true });
rmSync(join(ROOT, '_tmp_publish_dmg'), { recursive: true, force: true });

console.log(`\n— 结果：${pass} 通过 / ${fail} 失败 —`);
process.exit(fail ? 1 : 0);
