/**
 * 取得到内置默认模板 + 打开备份目录先建目录（对齐原版 SettingsPanel）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/chain-default-fill-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));
const rs = (n) => strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx', n), 'utf8'));

const mod = rs('mod.rs');
const main = strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/main.rs'), 'utf8'));
const api = R('api.ts');
const panel = R('components/ChainActionsPanel.tsx');
const css = R('style.css');

console.log('\n=== 1. 后端要给出内置默认模板 ===');
{
  /*
   * 界面里"留空 = 用内置默认"，于是默认到底是什么用户看不见，
   * 想在默认基础上改一点点都无从下手 —— 只能凭空把整段重打一遍。
   */
  t('有 fpx_chain_defaults 命令', /pub fn fpx_chain_defaults\(\) -> std::collections::HashMap<String, \[String; 2\]>/.test(mod));
  /* 值必须来自 chain::default_* —— 另抄一份会和实际发送时用的漂移 */
  t('项目侧取 chain::default_project', /chain::default_project\(id\)\.to_string\(\)/.test(mod));
  t('项目组侧取 chain::default_group', /chain::default_group\(id\)\.to_string\(\)/.test(mod));
  /* 遍历 BUILTIN 而不是写死 id 列表：以后加内置动作不用改这里 */
  t('遍历 BUILTIN', /for \(id, _, _\) in chain::BUILTIN/.test(mod));
  /* 命令必须注册，否则前端调了个不存在的命令 */
  t('已在 main.rs 注册', /fpx::fpx_chain_defaults/.test(main));
  t('前端有对应方法', /chainDefaults: \(\) => call<Record<string, \[string, string\]>>\('fpx_chain_defaults'\)/.test(api));
}

console.log('\n=== 2. 「填入默认模板」按钮 ===');
{
  t('有装入按钮', /填入默认模板/.test(panel));
  /* 只在内置动作上出现：自定义动作没有默认 */
  t('自定义动作不显示', /if \(!cur \|\| !cur\.builtin \|\| !text\) return null;/.test(panel));
  /*
   * 已经填了内容就不再显示 —— 那是"覆盖用户已写的东西"，
   * 一次误点把整段模板换掉，代价太大。
   */
  t('已有内容则不显示', /if \(curText\.trim\(\)\) return null;/.test(panel));
  t('两个模板各一个按钮', (panel.match(/\{tplFillButton\('(project|group)'\)\}/g) || []).length === 2);
  /* 取不到默认就静默不可用，不能让整个面板打不开 */
  t('拉取失败不致命', /api\.chainDefaults\(\)\.then\(setDefaults\)\.catch/.test(panel));
}

console.log('\n=== 3. 按钮样式不能盖住 label ===');
{
  t('有样式', /\.fpx-ca-fill-default \{/.test(css));
  /* 不能用 absolute：窄面板里会盖住 label 文字 */
  t('不用 absolute', !/\.fpx-ca-fill-default \{[^}]*position: absolute/.test(css));
  t('用 align-self 靠右', /\.fpx-ca-fill-default \{[^}]*align-self: flex-end/.test(css));
}

console.log('\n=== 4. 打开备份目录：目录还不存在就先建 ===');
{
  /*
   * 原版：目录不存在则先创建（备份目录尚未执行过备份时可能为空）。
   *
   * 不建的话，用户在执行过备份之前点这个按钮会拿到「路径不存在」，
   * 而这个报错完全指向不了原因 —— 他只会以为功能坏了，
   * 或者以为备份目录设置有误（其实设置是对的，只是还没备份过）。
   */
  t('不存在则建目录', /if !target\.exists\(\) \{\s*\n\s*let _ = std::fs::create_dir_all\(&target\);\s*\n\s*\}/.test(mod));
  /*
   * 建失败不该拦住打开：让它照原样去 open_path，
   * 由 open_path 给出"路径不存在"这个真实原因 ——
   * 换成"创建目录失败"反而掩盖了真正的问题。
   */
  t('建失败不阻断', /let _ = std::fs::create_dir_all\(&target\);/.test(mod));
  const iCreate = mod.indexOf('create_dir_all(&target)');
  const iOpen = mod.indexOf('sys::open_path(&target.to_string_lossy(), "dir", "")');
  t('建目录在打开之前', iCreate > 0 && iOpen > iCreate, `create=${iCreate} open=${iOpen}`);
}

done();
