/**
 * 与内置默认逐字一致的模板存成 null（对齐原版 SetChainTemplate 防膨胀）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/chain-template-normalize-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const rs = (n) => strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx', n), 'utf8'));
const mod = rs('mod.rs');

console.log('\n=== 1. 保存时归一化 ===');
{
  /*
   * 断言**不绑具体路径前缀**：`chain::` 与 `super::chain::` 都合法，
   * 取决于 mod.rs 里是否 use 过。此前钉死了 `super::chain::`，
   * 上游改用 `chain::` 后**误报**"归一化没了"——
   * 误报报多了就会被当噪音忽略，比漏报更伤。
   * 真正要钉的是"比对默认后把字段置 None"这个**语义**。
   */
  const normRe = (fn, field) => new RegExp(
    `if v\\.trim\\(\\) == (?:super::)?chain::${fn}\\(&a\\.builtin\\)\\.trim\\(\\) \\{\\s*\\n\\s*a\\.${field} = None;`);
  t('项目模板比对默认', normRe('default_project', 'project').test(mod));
  t('项目组模板比对默认', normRe('default_group', 'group').test(mod));
  /* 两侧都做 —— 只做一侧的话另一侧的副本照样被冻结 */
  t('两侧都处理', (mod.match(/= None;/g) || []).length >= 2);
}

console.log('\n=== 2. 只对内置动作做 ===');
{
  /*
   * 自定义动作没有内置默认，清空就是真清空。
   * 对它做比对（default_* 会回落到 DEFAULT_CHAIN）会把用户
   * 恰好写了那句话的模板误删 —— 那是丢数据。
   */
  t('跳过自定义动作', /if a\.builtin\.trim\(\)\.is_empty\(\) \{ continue; \}/.test(mod));
  const iSkip = mod.indexOf('if a.builtin.trim().is_empty() { continue; }');
  const iProj = mod.indexOf('default_project(&a.builtin)');
  t('跳过语句在比对之前', iSkip > 0 && iProj > iSkip, `skip=${iSkip} proj=${iProj}`);
}

console.log('\n=== 3. 位置：清洗之后、落盘之前 ===');
{
  const iNorm = mod.indexOf('default_project(&a.builtin)');
  const iDedup = mod.indexOf('list.retain(|a| seen.insert');
  const iSave = mod.indexOf('cfg.chain_actions = Some(list.clone());');
  t('在 id 去重之后', iDedup > 0 && iNorm > iDedup, `dedup=${iDedup} norm=${iNorm}`);
  t('在落盘之前', iSave > 0 && iNorm < iSave, `norm=${iNorm} save=${iSave}`);
}

console.log('\n=== 4. 前端语义一致（留空 = 用内置默认）===');
{
  const panel = strip(fs.readFileSync(path.join(HERE, 'components/ChainActionsPanel.tsx'), 'utf8'));
  /* 空白必须存 null，不能存空串 —— 空串会让后端以为"用户自定义为空模板" */
  t('项目模板空转 null', /onChange=\{\(e\) => patch\(cur\.id, \{ project: e\.target\.value \|\| null \}\)\}/.test(panel));
  t('项目组模板空转 null', /onChange=\{\(e\) => patch\(cur\.id, \{ group: e\.target\.value \|\| null \}\)\}/.test(panel));
  t('占位符说明留空语义', /placeholder="留空使用内置默认模板"/.test(panel));
  /* 面板顶部也要写清楚，否则用户不知道留空意味着什么 */
  t('面板说明里写清', /留空表示使用内置默认模板/.test(panel));
}

done();
