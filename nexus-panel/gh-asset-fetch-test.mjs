/**
 * gh_asset_fetch 守卫（下载阶段 CORS 实证后补）
 * ============================================================================
 * 钉住三件事：
 *   1. Rust 命令**只在** api.github.com 的 release asset 端点代下，
 *      绝不接受任意 URL（否则这条命令就是 SSRF 代理）；
 *   2. 命令真的注册了、能力按 R 登记、token 不落日志；
 *   3. 前端**只有** octet-stream 的资产下载走后端，
 *      其它 GitHub API 仍直连、测试注入 fetchFn 时不碰 invoke。
 *
 * 反例来源：私有仓 asset.url 302 到 release-assets.githubusercontent.com，
 * 那个 200 响应没有 Access-Control-Allow-Origin，webview fetch 抛
 * "Failed to fetch（阶段：download）"。CSP 与 PAT 都拦不住、也救不了。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isAssetDownload } from './js/market-binding.js';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) pass += 1;
  else { fail += 1; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

const rs = readFileSync(join(HERE, 'src-tauri/src/af_flow.rs'), 'utf8');
const mainRs = readFileSync(join(HERE, 'src-tauri/src/main.rs'), 'utf8');
const caps = readFileSync(join(HERE, 'js/command-caps.js'), 'utf8');
const mbRaw = readFileSync(join(HERE, 'js/market-binding.js'), 'utf8');
const mb = stripCommentsFlatJs(mbRaw);

console.log('— gh-asset-fetch —');

/* ---------------- 1. Rust 命令与安全边界 ---------------- */

t('命令签名是 (url, token) 两个标量（避免 {req} 形状坑）',
  /pub async fn gh_asset_fetch\(url: String, token: String\) -> Result<Vec<u8>, String>/.test(rs));
t('带 #[tauri::command]',
  /#\[tauri::command\]\s*pub async fn gh_asset_fetch/.test(rs));
t('命令第一步就调 is_gh_asset_url',
  /pub async fn gh_asset_fetch[\s\S]{0,200}?if !is_gh_asset_url\(&url\)/.test(rs));
t('白名单函数存在且写死 api.github.com/repos 前缀',
  /fn is_gh_asset_url\([\s\S]{0,600}?const PREFIX: &str = "https:\/\/api\.github\.com\/repos\/";/.test(rs));
t('拒绝 query / fragment / 反斜杠',
  /s\.contains\('\?'\) \|\| s\.contains\('#'\) \|\| s\.contains\('\\\\'\)/.test(rs));
t('asset id 必须全数字',
  /id\.chars\(\)\.all\(\|c\| c\.is_ascii_digit\(\)\)/.test(rs));
t('路径段固定 releases/assets 且无多余段',
  /releases == "releases"/.test(rs) && /assets == "assets"/.test(rs) && /if parts\.next\(\)\.is_some\(\)/.test(rs));
t('用已注册的 tauri_plugin_http::reqwest，不是自造 HTTP',
  /tauri_plugin_http::reqwest::Client::new\(\)/.test(rs));
t('带 Accept: application/octet-stream（触发 302 到二进制）',
  /\.header\("Accept", "application\/octet-stream"\)/.test(rs));
t('Authorization 只在 token 非空时加',
  /if !token\.trim\(\)\.is_empty\(\)[\s\S]{0,160}?Authorization/.test(rs));
/* 只禁「日志 / 错误信息里带 token」。`format!("Bearer {}", token.trim())`
 * 是构造请求头的正常用法，不是泄露 —— 旧判据把它也误伤了。 */
const cmdBody = rs.slice(rs.indexOf('pub async fn gh_asset_fetch'));
t('token 不进任何日志/错误串',
  !/println!|eprintln!|dbg!|log::/.test(cmdBody) &&
  !/Err\((?:format!)?\([^)]*token/.test(cmdBody));
t('不禁用重定向（reqwest 默认跟随 302）',
  !/redirect::Policy::none/.test(rs.slice(rs.indexOf('pub async fn gh_asset_fetch'))));
t('HTTP 非 2xx 明确报错，不返回空字节假装成功',
  /if !status\.is_success\(\)[\s\S]{0,160}?return Err/.test(rs));
t('Rust 侧自带白名单单测（含反向用例）',
  /mod gh_asset_tests/.test(rs) && /fn rejects_everything_else/.test(rs));
t('main.rs 的 generate_handler 注册了命令',
  /af_flow::gh_asset_fetch/.test(mainRs));
t('command-caps.js 按只读 R 登记',
  /gh_asset_fetch:\s*'R'/.test(caps));

/* ---------------- 2. 前端分流判据（真跑纯函数） ---------------- */

t('Accept: application/octet-stream → true',
  isAssetDownload({ headers: { Accept: 'application/octet-stream' } }) === true);
t('小写 accept 也认（大小写不敏感判据）',
  isAssetDownload({ headers: { accept: 'application/octet-stream' } }) === true);
t('普通 GitHub API 的 vnd.github+json → false',
  isAssetDownload({ headers: { Accept: 'application/vnd.github+json' } }) === false);
t('无 headers / 空 opts → false',
  isAssetDownload({}) === false && isAssetDownload(undefined) === false);

/* ---------------- 3. 装配层接线 ---------------- */

t('导出唯一判据 isAssetDownload',
  /export function isAssetDownload\(/.test(mb));
t('octet 分支用它，不另写一份正则',
  /!fetchFn && isAssetDownload\(opts\)/.test(mb));
t('测试注入 fetchFn 时不走后端（守卫 ⑥k/⑥l 契约不破）',
  /!fetchFn && isAssetDownload\(opts\)/.test(mb) && /return \(fetchFn \|\| fetch\)\(url, opts\);/.test(mb));
t('octet 分支调 gh_asset_fetch 且参数是 { url, token } 平铺',
  /invoke\('gh_asset_fetch', \{ url, token: getToken\(\) \|\| '' \}\)/.test(mb));
t('token 只经 IPC 参数，不拼进 URL',
  !/url\s*\+\s*.*token/.test(mb) && !/\$\{.*token.*\}/.test(mb.slice(mb.indexOf("invoke('gh_asset_fetch'"))));
t('包装成 downloadAsset 认得的 Response 形态',
  /status: 200/.test(mb) && /arrayBuffer: async \(\) => new Uint8Array\(bytes\)\.buffer/.test(mb));

/* ---------------- 4. 反向自检（判据失效必须喊） ---------------- */

const mbBroken = mb.replace("invoke('gh_asset_fetch'", "invoke('some_other_cmd'");
t('反向：命令名被改掉会被抓到', !/invoke\('gh_asset_fetch'/.test(mbBroken));
const rsBroken = rs.replace(/if !is_gh_asset_url\(&url\) \{[\s\S]{0,120}?\n    \}/, '');
t('反向：删掉白名单调用后「第一步就校验」判据会红',
  !/pub async fn gh_asset_fetch[\s\S]{0,200}?if !is_gh_asset_url/.test(rsBroken));
t('反向：判据不恒真（json 请求确实不会被判成资产下载）',
  isAssetDownload({ headers: { Accept: 'application/vnd.github+json' } }) === false);
t('元断言：本节判据数量足够（防空集合恒绿）', pass + fail >= 25);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
