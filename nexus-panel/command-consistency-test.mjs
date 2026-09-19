/**
 * 命令一致性扫描器（scripts/scan-commands.mjs）的自身测试。
 *
 * ⚠️ 这个扫描器要是自己不准，它就是最大的假绿源 ——
 * 会在"标了但没注册"时告诉你"一切正常"。
 * 所以这里用**构造出来的 Rust 工程**真跑，不查脚本源码字符串。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const scanner = path.join(root, 'scripts', 'scan-commands.mjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`); }
};

/** 造一个最小 Rust 工程，跑扫描器，返回输出 */
function run({ mainRs, extra = {}, policy }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmds-'));
  const rsRoot = path.join(dir, 'src-tauri', 'src');
  fs.mkdirSync(rsRoot, { recursive: true });
  fs.writeFileSync(path.join(rsRoot, 'main.rs'), mainRs);
  for (const [f, c] of Object.entries(extra)) {
    const p = path.join(rsRoot, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  }
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'js', 'invoke-policy.js'), policy);
  /* 让脚本把 dir 当成项目根 */
  const shim = path.join(dir, 'scripts');
  fs.mkdirSync(shim, { recursive: true });
  fs.copyFileSync(scanner, path.join(shim, 'scan-commands.mjs'));
  let out = '', code = 0;
  try {
    out = execFileSync('node', [path.join(shim, 'scan-commands.mjs')], { encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 1;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, code };
}

const POLICY = `
export const SAFE_COMMANDS = new Set(['app_version']);
export const PLUGIN_COMMANDS = {
  home: ['app_version'],
};
`;

/* ---------------------------------------------------------------- */
console.log('\n--- 1. 干净工程：没有问题 ---');
{
  const { out, code } = run({
    mainRs: `mod a;\nfn main(){}\n.invoke_handler(tauri::generate_handler![\n  app_version,\n])\n`,
    extra: { 'a.rs': '#[tauri::command]\npub fn app_version() -> String { "1".into() }\n' },
    policy: POLICY,
  });
  t('干净工程退出码 0', code === 0, `code=${code}`);
  t('报告"一致"', /三份清单一致/.test(out));
}

/* ---------------------------------------------------------------- */
console.log('\n--- 2. 标了但没注册（af_device_salt 的真实形态）---');
{
  const { out, code } = run({
    mainRs: `mod a; mod b;\nfn main(){}\n.invoke_handler(tauri::generate_handler![\n  app_version,\n])\n`,
    extra: {
      'a.rs': '#[tauri::command]\npub fn app_version() -> String { "1".into() }\n',
      'b.rs': '#[tauri::command]\npub fn af_device_salt() -> String { "x".into() }\n',
    },
    policy: POLICY,
  });
  t('退出码非 0', code !== 0, `code=${code}`);
  t('报出了这条', /af_device_salt/.test(out));
  t('归到 ①（标了没注册）', /①[\s\S]*af_device_salt/.test(out));
  t('说清了为什么（调不通）', /调不通/.test(out));
}

/* ---------------------------------------------------------------- */
console.log('\n--- 3. async 与带参属性必须认（否则全是假报告）---');
{
  const { out, code } = run({
    mainRs: `mod a; mod b; mod c;\nfn main(){}\n.invoke_handler(tauri::generate_handler![\n  app_version,\n  run_node,\n  fpx_scan_content,\n])\n`,
    extra: {
      'a.rs': '#[tauri::command]\npub fn app_version() -> String { "1".into() }\n',
      'b.rs': '#[tauri::command]\npub async fn run_node() -> String { "1".into() }\n',
      'c.rs': '#[tauri::command(rename_all = "snake_case")]\npub fn fpx_scan_content() -> String { "1".into() }\n',
    },
    policy: POLICY,
  });
  t('async 没被当成"没标注"', !/②[\s\S]*run_node/.test(out), out.match(/②[\s\S]{0,120}/)?.[0]);
  t('带参属性没被当成"没标注"', !/②[\s\S]*fpx_scan_content/.test(out));
  t('两者都不误报', code === 0, `code=${code}`);
}

/* ---------------------------------------------------------------- */
console.log('\n--- 4. 白名单里有、Rust 侧没注册（有权限却调不通）---');
{
  const { out, code } = run({
    mainRs: `fn main(){}\n.invoke_handler(tauri::generate_handler![\n  app_version,\n])\n`,
    extra: { 'a.rs': '#[tauri::command]\npub fn app_version() -> String { "1".into() }\n' },
    policy: `export const PLUGIN_COMMANDS = { home: ['app_version', 'ghost_cmd'] };\n`,
  });
  t('报出 ghost_cmd', /ghost_cmd/.test(out));
  t('归到 ③', /③[\s\S]*ghost_cmd/.test(out));
  t('退出码非 0', code !== 0);
}

/* ---------------------------------------------------------------- */
console.log('\n--- 5. 同名定义多份 ---');
{
  const { out } = run({
    mainRs: `mod a; mod b;\nfn main(){}\n.invoke_handler(tauri::generate_handler![\n  dup_cmd,\n])\n`,
    extra: {
      'a.rs': '#[tauri::command]\npub fn dup_cmd() -> String { "1".into() }\n',
      'b.rs': '#[tauri::command]\npub fn dup_cmd() -> String { "2".into() }\n',
    },
    policy: POLICY,
  });
  t('报出重复', /⑤[\s\S]*dup_cmd/.test(out));
  t('两个文件都列出来了', /a\.rs/.test(out) && /b\.rs/.test(out));
}

/* ---------------------------------------------------------------- */
console.log('\n--- 6. 解析失败必须报错，不能当"没问题" ---');
{
  const { out, code } = run({
    mainRs: `fn main(){} // 根本没有 generate_handler\n`,
    extra: {},
    policy: POLICY,
  });
  t('退出码 2（扫描器失效）', code === 2, `code=${code}`);
  t('明确说"扫描器失效"', /扫描器失效/.test(out), out.slice(0, 120));
  t('没有输出"一致"', !/三份清单一致/.test(out));
}

/* ---------------------------------------------------------------- */
console.log('\n--- 7. 真实仓库自检 ---');
{
  /*
   * ⚠️ 这节钉的是**当前契约**。远端把 af_device_salt / af_fs_tail
   * 补进了 generate_handler!、并删掉重复的 af.rs 之后，这里应当是 0 问题。
   * 若哪天又冒出来，①⑤⑥ 必须报 —— 所以下面同时断言"数量对得上"。
   */
  let out = '', code = 0;
  try {
    out = execFileSync('node', [path.join(root, 'scripts', 'scan-commands.mjs')], { encoding: 'utf8' });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 1; }
  t('真实仓库能跑完（不是崩溃）', /合计问题|三份清单一致/.test(out), out.slice(0, 100));
  t('当前 0 问题（远端已修掉注册的缺口）', code === 0, `code=${code}\n${out.slice(0, 300)}`);
  t('① 为空：没有"标了却没注册"的', !/① /.test(out), out.match(/①[^\n]*/)?.[0]);
  t('⑤ 为空：没有同名定义', !/⑤ /.test(out), out.match(/⑤[^\n]*/)?.[0]);
  t('⑥ 为空：没有不参与编译的 .rs', !/⑥ /.test(out), out.match(/⑥[^\n]*/)?.[0]);
  /*
   * 标注数 == 注册数，这是最强的不变量：
   * 任何一边多出来都说明有人标了没注册，或注册了没标。
   */
  const a = Number((out.match(/#\[tauri::command\] 标注 (\d+) 条/) || [])[1]);
  const r = Number((out.match(/generate_handler! 注册 (\d+) 条/) || [])[1]);
  t('标注数 == 注册数', a === r && a > 0, `标注 ${a} / 注册 ${r}`);
}

/* ---------------------------------------------------------------- */
console.log('\n--- 8. 白名单解析不出来必须报错（不能静默当 0 条）---');
{
  const { out, code } = run({
    mainRs: `mod a;\nfn main(){}\n.invoke_handler(tauri::generate_handler![\n  app_version,\n])\n`,
    extra: { 'a.rs': '#[tauri::command]\npub fn app_version() -> String { "1".into() }\n' },
    /* 故意不给 PLUGIN_COMMANDS：静默返回空集的话，③ 会永远报 0 条 */
    policy: 'export const SAFE_COMMANDS = new Set([]);\n',
  });
  t('退出码 2', code === 2, `code=${code}`);
  t('说清了是扫描器失效', /扫描器失效/.test(out), out.slice(0, 100));
  t('没输出"一致"', !/三份清单一致/.test(out));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
