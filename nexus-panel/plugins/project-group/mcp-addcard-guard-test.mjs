/**
 * MCP add_card 的路径白名单（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/mcp-addcard-guard-test.mjs
 *
 * 一条完整的提权链，两处单看都"合规"：
 *
 *   1. `content_roots` 的第一项就是**页签登记的路径**（mod.rs），
 *      所以"登记进页签"等于"把该路径加进白名单"；
 *   2. `read_file` 走 `core_read_file`，它按 `content_roots` 做 `must_be_under`；
 *   3. 而 MCP 的 `add_card` 此前**只判 path 非空**就调 register_card ——
 *      于是 `add_card(任意路径)` → `read_file(同一路径)` = 任意文件读取。
 *
 * 单看 read_file 是有校验的；单看 add_card 只是"多登记一条"。
 * 两头都合规，合起来是 P0。这正是 guard.rs 模块头写明的教训：
 * "每个命令各写一套（或干脆不写）路径校验，迟早漏一个"。
 *
 * `register_card` 里的 `reject_forbidden_raw` 兜不住：它按"家目录根 /
 * 盘符根 / 系统目录"比对，`~/.ssh`、`~/Documents` 这类**具体子目录**
 * 不在表里（guard.rs 自己的测试就有 `C:\Users\me\projects\brand-new → Ok`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');
const { t, done } = makeT();

const read = (f) => fs.readFileSync(path.join(RS, f), 'utf8');
/** 剥块注释：断言必须只看真代码，否则会被注释里的同名字样喂饱（踩过多次）。 */
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');

const MCP = read('mcp.rs');
const MCPC = strip(MCP); // 剥注释后的代码
const MOD = strip(read('mod.rs'));

/**
 * 按大括号配平切出 `"工具名" => { ... }` 的分支体。
 * 不配平的话会切到下一个分支里去（本文件踩过多次）。
 */
function branch(src, name) {
  const a = src.indexOf(`"${name}" =>`);
  if (a < 0) return '';
  let i = src.indexOf('{', a);
  if (i < 0) return '';
  let d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(a, i + 1);
    }
  }
  return '';
}

console.log('\n=== 1. add_card 必须先过白名单 ===');
{
  const b = branch(MCPC, 'add_card');
  t('分支体定位成功', b.length > 0 && b.includes('register_card'));
  t('调了 within_raw(&path)', /within_raw\(&path\)/.test(b));

  /*
   * 顺序必须在 register_card **之前**。
   * 放后面等于没拦：register_card 已经把路径写进页签、写进磁盘了。
   */
  const atGuard = b.indexOf('within_raw(&path)');
  const atReg = b.indexOf('register_card(');
  t('顺序：守卫在 register_card 之前（两端都存在才比）',
    atGuard >= 0 && atReg >= 0 && atGuard < atReg);
}

console.log('\n=== 2. kind 必须二选一（否则静默落进项目页签）===');
{
  const b = branch(MCPC, 'add_card');
  /*
   * register_card 里写的是 `if kind == "group" {…} else {…}`，
   * 传 "Group" / "项目组" 之类会**静默加到项目页签**，
   * 回包还写着"已加入页签「X」"，看着完全成功。
   */
  t('判 kind != project 且 != group', /kind\s*!=\s*"project"/.test(b) && /kind\s*!=\s*"group"/.test(b));
  const atK = b.indexOf('kind != "project"');
  const atReg = b.indexOf('register_card(');
  t('顺序：kind 校验也在 register_card 之前', atK >= 0 && atReg >= 0 && atK < atReg);
}

console.log('\n=== 3. 漏洞链的另一端：登记 = 进白名单 ===');
{
  const b = MOD.slice(MOD.indexOf('fn content_roots'), MOD.indexOf('fn content_roots') + 1200);
  t('content_roots 把页签 items 收进白名单',
    /project_tabs[\s\S]{0,200}group_tabs[\s\S]{0,300}push\(item\)/.test(b)
    || /for item in &t\.items[\s\S]{0,120}push\(item\)/.test(b));
}

console.log('\n=== 4. register_card 自己不过白名单（所以必须在调用方补）===');
{
  const a = MCPC.indexOf('fn register_card');
  const b = MCPC.slice(a, a + 900);
  t('函数体定位成功', a >= 0);
  t('只调 reject_forbidden_raw', /reject_forbidden_raw/.test(b));
  /* 反面证据：它自己没有 must_be_under。
     若哪天有人"顺手"在这里补了，本条会红 —— 那是好事，说明判据变了，
     第 1 节的调用方守卫就可重新评估（而不是两处都以为对方在管）。 */
  t('不含 must_be_under（反面证据）', !/must_be_under/.test(b));
}

console.log('\n=== 5. read_file 端确实有收口（证明单看它合规）===');
{
  const a = MOD.indexOf('fn core_read_file');
  const b = MOD.slice(a, a + 900);
  t('core_read_file 定位成功', a >= 0);
  t('内含 must_be_under', /must_be_under/.test(b));
  const m = MCPC.indexOf('"read_file" =>');
  /*
   * 这里必须再剥**行注释**。该分支正上方就有一行
   * `// 走 core_read_file（…），不直接读 content::read_preview`，
   * 里面恰好含要判为"不得出现"的字样 —— 不剥掉的话这条断言恒假，
   * 看着像"直连了"其实没有。剥块注释的 strip() 管不到行注释。
   */
  const rb = MCPC.slice(m, m + 400)
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  t('MCP read_file 走 core_read_file 而非直连 read_preview',
    /core_read_file/.test(rb) && !/content::read_preview/.test(rb));
}

console.log('\n=== 6. 兜底：收路径的 MCP 工具都要有收口 ===');
{
  /*
   * 这份清单是"会接收外部路径"的工具。以后新增工具若忘了收口，
   * 这里会红 —— 而漏掉的表现正是第 1 节那种：单看每个工具都合规。
   *
   * read_file 是唯一的例外：它走 core_read_file（内含 must_be_under），
   * 所以按"含 core_read_file"判定而不是 within_raw。
   */
  const TOOLS = [
    'create_link', 'remove_link', 'scan_content', 'read_file', 'create_folder',
    'add_card', 'set_lock', 'set_tag_color', 'select_folder',
    'folder_icon_set', 'folder_icon_get', 'folder_icon_restore',
    'capture_screen', 'capture_window', 'deploy_skill',
  ];
  const missing = [];
  for (const name of TOOLS) {
    const b = branch(MCPC, name);
    if (!b) { missing.push(`${name}(分支没找到)`); continue; }
    if (!/within_raw\(/.test(b) && !/core_read_file/.test(b)) missing.push(name);
  }
  t(`收路径工具全部有收口（共 ${TOOLS.length} 个）`, missing.length === 0,
    missing.length ? `漏收口：${missing.join('、')}` : '');
  t('工具清单本身没被改短', TOOLS.length >= 15);
}

done();
