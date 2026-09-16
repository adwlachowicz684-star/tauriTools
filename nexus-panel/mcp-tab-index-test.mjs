/**
 * add_card 的 tab_index 回归测试（开发用，可删）
 * ------------------------------------------------------------
 * 纯 Rust 侧改动，沙盒装不上 cargo，无法编译验证。
 * 本测试只做源码级接线检查，**不能**替代 cargo build。
 *
 * 行为验证：起服务后，在两个以上页签时调 add_card 并传 tab_index: 1，
 * 确认卡片进了第二个页签。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUST = path.join(HERE, 'src-tauri/src/fpx/mcp.rs');
const rs = fs.readFileSync(RUST, 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/** 取 add_card 分支源码 */
const iStart = rs.indexOf('"add_card" => {');
const iEnd = rs.indexOf('"set_lock" => {');
const seg = rs.slice(iStart, iEnd);

console.log('\n=== 1. 参数声明 ===');
t('add_card schema 里有 tab_index', /"tab_index":\s*\{\s*"type":\s*"integer"/.test(rs));
t('tab_index 不在必填里（可选，缺省兼容旧行为）',
  /tool\("add_card"[\s\S]*?vec!\["kind",\s*"path"\]\)/.test(rs));
t('说明里点明了"省略时加到第一个页签"',
  /tab_index 省略时加到第一个页签/.test(rs));

console.log('\n=== 2. 解析 ===');
t('用 as_u64 解析（挡掉负数，as_i64 会收下再溢出）',
  /args\.get\("tab_index"\)\.and_then\(\|v\| v\.as_u64\(\)\)/.test(seg));
t('转成 usize 后是 Option（缺省走旧路径）',
  /\.map\(\|v\| v as usize\)/.test(seg));

console.log('\n=== 3. 越界处理（关键）===');
/* 越界必须报清楚：只说"越界"不够，AI 得知道有几个页签才能重试。
   且判断必须在 with_config 闭包内 —— 长度只有那里拿得到。 */
t('越界时 return Err 而不是 panic 式索引', /i >= tabs\.len\(\)/.test(seg));
t('错误信息带上 kind（project/group 页签数不同）', /tab_index \{i\} 越界：\{kind\} 类/.test(seg));
t('错误信息带上有效范围', /有效范围 0\.\.\{\}/.test(seg));
t('用 saturating_sub 算上界（空 tabs 时不会下溢）', /tabs\.len\(\)\.saturating_sub\(1\)/.test(seg));
const iErr = seg.indexOf('i >= tabs.len()');
const iWith = seg.indexOf('with_config');
t('越界判断在 with_config 闭包内', iErr > iWith, `err=${iErr} with=${iWith}`);

console.log('\n=== 4. 写入 ===');
t('取页签名用 tabs[idx]', /tabs\[idx\]\.name\.clone\(\)/.test(seg));
t('查重与写入都用 tabs[idx]', /tabs\[idx\]\.items\.iter\(\)/.test(seg) && /tabs\[idx\]\.items\.push/.test(seg));
t('缺省回落到 0（保持旧行为）', /None => 0,/.test(seg));
t('闭包返回值未变（tab_name, already）', /Ok\(\(tab_name, already\)\)/.test(seg));

console.log('\n=== 5. 顺序：kind 决定 tabs，idx 在其后 ===');
const iKind = seg.indexOf('if kind == "group"');
const iIdx = seg.indexOf('let idx = match tab_index');
t('先选 tabs 再算 idx', iKind > 0 && iIdx > iKind, `kind=${iKind} idx=${iIdx}`);

console.log('\n=== 6. 结构 ===');
const lines = rs.split('\n');
let depth = 0, inBlock = false, minD = 0;
for (const ln of lines) {
  let j = 0;
  while (j < ln.length) {
    const c = ln[j];
    if (inBlock) {
      if (ln.substr(j, 2) === '*/') { inBlock = false; j += 2; continue; }
      j++; continue;
    }
    if (ln.substr(j, 2) === '//') break;
    if (ln.substr(j, 2) === '/*') { inBlock = true; j += 2; continue; }
    if (c === '"') {
      j++;
      while (j < ln.length) {
        if (ln[j] === '\\') { j += 2; continue; }
        if (ln[j] === '"') { j++; break; }
        j++;
      }
      continue;
    }
    if (c === "'") {
      const nxt = ln[j + 1] || '';
      if (nxt === '\\') { j += 4; continue; }
      if (ln[j + 2] === "'") { j += 3; continue; }
      j++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth < minD) minD = depth;
    j++;
  }
}
t('mcp.rs 花括号平衡', depth === 0 && minD === 0, `depth=${depth}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：只检查接线，**不能**替代 cargo build + 实调用验证。');
process.exit(fail ? 1 : 0);
