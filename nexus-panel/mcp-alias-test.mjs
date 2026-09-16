/**
 * MCP 工具名兼容层回归测试（开发用，可删）
 * ------------------------------------------------------------
 * 这是**纯 Rust 侧**改动，沙盒装不上 cargo，无法编译验证。
 * 本测试只做源码级接线检查，能保证的是"这行还在、写法没被改坏"，
 * **不能**替代 cargo build。
 *
 * 真正的行为验证：起服务后用旧名字（backup_now / list_agents …）
 * 调一次，确认能落到对应实名工具。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const RUST = 'src-tauri/src/fpx/mcp.rs';
const rs = src(RUST);

/** 按括号匹配取出某个函数体的源码（从 `fn xxx` 起）
 *  取不到返回空串而不是 null —— 源码被破坏时应该让断言干净变红，
 *  而不是让测试脚本自己崩掉（那也算"检测到"，但分不清是代码错还是脚本错）。 */
function fnBody(source, header) {
  const i = source.indexOf(header);
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < source.length; j++) {
    const c = source[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return source.slice(i, j + 1); }
  }
  return '';
}

/* ---------- 1. 别名表 ---------- */
console.log('\n=== 1. 别名表 ===');
t('存在 ALIASES 常量', /const ALIASES:/.test(rs));

const aliasBlock = rs.slice(rs.indexOf('const ALIASES'), rs.indexOf('/// 把可能是原版名字'));
const pairs = [...aliasBlock.matchAll(/\("([a-z_]+)",\s*"([a-z_]+)",\s*(None|Some\(\("(\w+)",\s*"(\w+)"\)\))/g)]
  .map((m) => ({ old: m[1], neu: m[2], patch: m[3] === 'None' ? null : { k: m[4], v: m[5] } }));
/* 不写死条数 —— 加别名是正常的，写成常量会变成"每次加都要改测试"，
   而真正要守的是下面的「每条的目标都是已声明的实名」。
   只要求至少能解析出若干条，防的是解析逻辑失效（解析出 0 条）。 */
t('解析出别名映射', pairs.length >= 6, String(pairs.length));

const byOld = Object.fromEntries(pairs.map((p) => [p.old, p]));
const need = [
  ['backup_now', 'backup'],
  ['lock_set', 'set_lock'],
  ['list_agents', 'scan_content'],
  ['list_skills', 'scan_content'],
  ['list_rules', 'scan_content'],
  ['create_project', 'create_folder'],
  ['create_group', 'create_folder'],
  ['folder_icon_set_dll', 'folder_icon_set'],
];
for (const [o, n] of need) {
  t(`  ${o} → ${n}`, byOld[o]?.neu === n, byOld[o]?.neu);
}

/* ---------- 2. 合并类必须补参数 ---------- */
console.log('\n=== 2. 合并类的参数注入 ===');
/* 这是本改动最容易做错、也最不容易被发现的地方：
   原版按类型拆工具，现在合成一个靠 kind 区分。
   只改名不补 kind 的话，list_agents 会返回 all（含 rule）——
   语义错误但不报错，比直接失败更难排查。 */
t('list_agents 自动补 kind=agent',
  byOld.list_agents?.patch?.k === 'kind' && byOld.list_agents?.patch?.v === 'agent');
t('list_skills 自动补 kind=skill',
  byOld.list_skills?.patch?.k === 'kind' && byOld.list_skills?.patch?.v === 'skill');
t('list_rules 自动补 kind=rule',
  byOld.list_rules?.patch?.k === 'kind' && byOld.list_rules?.patch?.v === 'rule');

/* ---------- 2b. 拆分型别名必须成套 ---------- */
/* 原版把 scan_content 按 kind 拆成三个独立工具，合成一个后**三个旧名都要有别名**。
   此前只补了 agent / skill，漏了 rule —— 缺的那一个会落到「未知工具」，
   而且更隐蔽：若被当成 scan_content 处理又不带 kind，会返回 all（含另两类），
   **语义错误但不报错**。

   这条断言的价值在于：将来有人往 enum 里加第四个 kind，
   而忘了补对应别名时，这里会红 —— 守的是"成套"这个约束，不是这一条记录。 */
const enumLine = rs.match(/"kind":\s*\{\s*"type":\s*"string",\s*"enum":\s*\[([^\]]+)\]/);
const kinds = (enumLine?.[1] ?? '')
  .split(',')
  .map((x) => x.trim().replace(/"/g, ''))
  .filter((x) => x && x !== 'all');
t('能解析出 scan_content 的 kind 枚举', kinds.length > 0, kinds.join('/'));
for (const k of kinds) {
  t(`  kind=${k} 有对应旧名别名`, byOld[`list_${k}s`]?.neu === 'scan_content',
    byOld[`list_${k}s`]?.neu);
}
t('纯改名类不补参数（backup_now）', byOld.backup_now?.patch === null);
t('纯改名类不补参数（lock_set）', byOld.lock_set?.patch === null);

/* ---------- 3. 归一化与开关的顺序 ---------- */
console.log('\n=== 3. 顺序（关键设计）===');
const callBody = fnBody(rs, 'fn call_tool');
t('call_tool 里调用了归一化', /let \(name, patch\) = canonical_tool\(raw\);/.test(callBody));
const iNorm = callBody.indexOf('canonical_tool(raw)');
const iGate = callBody.indexOf('tool_enabled(&cfg, name)');
t('归一化在查开关**之前**（否则关掉实名后别名能绕过去）',
  iNorm > 0 && iGate > 0 && iNorm < iGate, `norm=${iNorm} gate=${iGate}`);
t('开关查的是实名 name 而非 raw', /tool_enabled\(&cfg, name\)/.test(callBody));
t('args 声明为 mut（要注入参数）', /let mut args = params\.get\("arguments"\)/.test(callBody));

/* 注入只在未提供时才补 —— 无条件覆盖会把调用方显式传的 kind 冲掉 */
t('注入前判断了参数是否缺失', /let missing = args\.get\(k\)/.test(callBody));
t('缺失才写入', /if missing \{/.test(callBody));
t('写入走 as_object_mut（不依赖 IndexMut，稳妥）', /args\.as_object_mut\(\)/.test(callBody));

/* ---------- 4. 别名不进 tools/list ---------- */
console.log('\n=== 4. 不污染清单 ===');
const toolsBody = fnBody(rs, 'fn tools()');
t('tools() 函数体里没有 ALIASES', !/ALIASES/.test(toolsBody));
t('tools() 里不含 backup_now 等旧名',
  !/backup_now|lock_set|list_agents|create_project/.test(toolsBody));
t('清单仍以实名列出', /tool\("scan_content"/.test(toolsBody) && /tool\("backup"/.test(toolsBody));

/* ---------- 5. 说明自动同步 ---------- */
console.log('\n=== 5. get_manual ===');
const manualBody = fnBody(rs, 'fn manual_text');
t('手动说明里遍历 ALIASES 生成兼容段', /for \(old, new, patch\) in ALIASES/.test(manualBody));
t('不是手写死列表（否则加别名会遗忘同步）',
  !/- `backup_now`/.test(manualBody) && /format!\("- `\{old\}`/.test(manualBody));
t('补参数的别名在说明里标注了',
  /Some\(\(k, v\)\) => format!\("等价于 `\{new\}`，并自动补/.test(manualBody));

/* ---------- 6. 兜底提示 ---------- */
console.log('\n=== 6. 错误提示 ===');
t('未知工具且来自别名时，报出映射可能失效',
  /由 \{raw\} 映射而来，该映射可能已失效/.test(callBody));
t('工具被关时提示等价关系（用户看到旧名、配置里是实名）',
  /\{raw\} 即 \{name\}/.test(callBody));

/* ---------- 7. 结构自检 ---------- */
console.log('\n=== 7. 结构 ===');
/* 与 rust_depth 同一套逻辑：正确处理字符串 / 注释 / char 字面量。
   （第一版脚本把 `'"'` 当成字符串起始，误报不平衡 —— 脚本也要自检） */
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
    if (c === "'") {                       // char 字面量 或 lifetime
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
t('mcp.rs 花括号平衡', depth === 0 && minD === 0, `收尾 depth=${depth}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：本测试只检查接线，**不能**替代 cargo build + 实调用验证。');
process.exit(fail ? 1 : 0);
