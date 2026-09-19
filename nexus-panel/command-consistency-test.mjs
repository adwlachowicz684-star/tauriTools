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
/*
 * caps：临时工程用的能力表内容。
 * 默认复制真实那份（63 条）—— 但最小工程只注册 1~3 条命令，
 * 于是 ⑥b 会报出几十条"死条目"。那不是代码有问题，
 * 是**测试环境**与能力表不匹配。
 * 所以每个用例给一张与它注册命令相称的表。
 */
function run({ mainRs, extra = {}, policy, caps }) {
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
  /*
   * 扫描器现在会 import ../js/command-caps.js —— 临时工程里也得有，
   * 否则它一崩就什么结论都拿不到（而崩溃和"抓到问题"是两回事）。
   */
  fs.mkdirSync(path.join(shim, '..', 'js'), { recursive: true });
  if (caps === 'real') {
    fs.copyFileSync(path.join(root, 'js', 'command-caps.js'), path.join(dir, 'js', 'command-caps.js'));
  } else {
    /* 生成一张只含指定条目的表 */
    const body = Object.entries(caps || {})
      .map(([k, v]) => `  ${k}: '${v}',`)
      .join('\n');
    fs.writeFileSync(
      path.join(dir, 'js', 'command-caps.js'),
      `export const COMMAND_CAPS = {\n${body}\n};\n`
        + 'export const COMBO_RULES = ['
        + "{id:'exfil',level:'red',need:['M','S'],why:'x'},"
        + "{id:'full-control',level:'red',need:['M','W'],why:'x'},"
        + "{id:'destructive',level:'yellow',need:['W'],why:'x'},"
        + "{id:'sensitive-read',level:'yellow',need:['S'],why:'x'}];\n"
        + `export function capOf(c){return COMMAND_CAPS[c]||'unknown';}\n`
        + `export function capsOf(cmds){const counts={M:0,W:0,S:0,R:0,unknown:0};const unknown=[];`
        + `for(const c of cmds||[]){const k=capOf(c);counts[k]=(counts[k]||0)+1;if(k==='unknown')unknown.push(c);}`
        + `const levels=Object.keys(counts).filter(k=>counts[k]>0);`
        + `const combos=COMBO_RULES.filter(r=>r.need.every(n=>counts[n]>0)).map(r=>({...r}));`
        + `return {counts,levels,unknown,combos};}\n`
        + `export function worstLevel(p){const ls=(p.combos||[]).map(c=>c.level);`
        + `if(ls.includes('red'))return 'red';if(ls.includes('yellow'))return 'yellow';return 'none';}\n`,
    );
  }
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
    caps: { app_version: 'R' },
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
    caps: { app_version: 'R' },
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
    caps: { app_version: 'R', run_node: 'M', fpx_scan_content: 'S' },
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
    caps: { app_version: 'R' },
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
    caps: { dup_cmd: 'R' },
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
    caps: {},
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
    caps: { app_version: 'R' },
  });
  t('退出码 2', code === 2, `code=${code}`);
  t('说清了是扫描器失效', /扫描器失效/.test(out), out.slice(0, 100));
  t('没输出"一致"', !/三份清单一致/.test(out));
}

/* ---------------------------------------------------------------- */
console.log('\n--- 9. 能力分级：未列出必须是 unknown，不是"安全" ---');
{
  const { capOf, capsOf, worstLevel, COMBO_RULES } = await import('./js/command-caps.js');
  /*
   * 这条是本表的**核心约定**。若哪天被改成默认值 'R'，
   * 所有没归类的危险命令会一夜之间变成"安全" ——
   * 而报告会看起来比现在还干净。
   */
  t('没归类 → unknown', capOf('zzz_not_a_real_command') === 'unknown', capOf('zzz_not_a_real_command'));
  t('unknown 不等于 R', capOf('zzz_not_a_real_command') !== 'R');

  /* 已知条目 */
  t('af_fs_allow_root 是 M（提权）', capOf('af_fs_allow_root') === 'M');
  t('run_node 是 M（起进程）', capOf('run_node') === 'M');
  t('af_device_salt 是 S（凭据盐）', capOf('af_device_salt') === 'S');
  t('fpx_capture_screen 是 S（截屏）', capOf('fpx_capture_screen') === 'S');
  t('fpx_pick_color 是 S（吸管读屏幕像素）', capOf('fpx_pick_color') === 'S');
  t('fs_op 是 W', capOf('fs_op') === 'W');
  t('app_version 是 R', capOf('app_version') === 'R');

  /* 组合：单看没事，合起来才危险 */
  const onlyM = capsOf(['run_node']);
  t('只有 M 不判红', worstLevel(onlyM) !== 'red', JSON.stringify(onlyM.combos.map((c) => c.id)));
  const onlyS = capsOf(['fpx_read_file']);
  t('只有 S 不判红（判黄）', worstLevel(onlyS) === 'yellow', worstLevel(onlyS));
  const both = capsOf(['run_node', 'fpx_read_file']);
  t('M + S 判红（外传通道）', worstLevel(both) === 'red', worstLevel(both));
  t('红色组合带 id=exfil', both.combos.some((c) => c.id === 'exfil' && c.level === 'red'));
  const mw = capsOf(['run_node', 'fs_op']);
  t('M + W 判红（可远程改写）', worstLevel(mw) === 'red');
  t('红色组合带 id=full-control', mw.combos.some((c) => c.id === 'full-control'));

  /* 组合规则必须带 why —— 报告里要能看出为什么红 */
  t('每条组合规则都说明了原因', COMBO_RULES.every((r) => typeof r.why === 'string' && r.why.length > 5));

  /* unknown 要单独列出来（不能混在 R 里） */
  const mix = capsOf(['app_version', 'zzz_x']);
  t('unknown 单独计数', mix.counts.unknown === 1 && mix.counts.R === 1, JSON.stringify(mix.counts));
  t('unknown 进了队列', mix.unknown.includes('zzz_x'));
}

/* ---------------------------------------------------------------- */
console.log('\n--- 10. 真实仓库：扫描器输出的能力画像 ---');
{
  /*
   * ⚠️ 必须断言**扫描器自己的输出**，不能用测试另写一份同款正则去解析。
   * 第一版就是这样：测试自己解析得挺好，于是把扫描器的分组正则
   * 改回"只认不带引号的 key"也照样全绿 —— 而真实报告里
   * agent-flow 恰恰会消失（它带引号），最该看的那个没了。
   */
  let out = '', code = 0;
  try {
    out = execFileSync('node', [path.join(root, 'scripts', 'scan-commands.mjs')], { encoding: 'utf8' });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 1; }
  t('扫描器输出里有能力画像节', /能力画像/.test(out));
  t('agent-flow 出现在画像里（key 带引号也要解析到）', /agent-flow/.test(out), out.match(/能力画像[\s\S]{0,300}/)?.[0]);
  t('project-group 出现在画像里', /project-group/.test(out));
  t('agent-flow 被判红', /🔴 agent-flow/.test(out), out.match(/🔴[^\n]*/g)?.slice(0, 3)?.join(' | '));
  t('未归类队列有内容或明确为空', /未归类命令 \d+ 条/.test(out));
  /*
   * 解析出的插件数：真实仓库有 8~9 个。
   * 只认不带引号的 key 时只剩 3 个 —— 这个断言直接挡住那种回退。
   */
  const rows = (out.match(/🔴 |🟡 |   [a-z-]+\s+M\d/g) || []).length;
  t('画像行数 >= 6（不是只有不带引号的那 3 个）', rows >= 6, `只有 ${rows} 行`);
}

/* ---------------------------------------------------------------- */
console.log('\n--- 11. 死条目：能力表里写了不存在的命令必须报 ---');
{
  /* 直接校验扫描器那节的逻辑：拿真实注册表比对能力表 */
  const { COMMAND_CAPS } = await import('./js/command-caps.js');
  const fs2 = await import('node:fs');
  const mainRs = fs2.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
  const m = mainRs.match(/generate_handler!\s*\[([\s\S]*?)\n\s*\]/);
  const reg = new Set(m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('::').pop()));
  const dead = Object.keys(COMMAND_CAPS).filter((c) => !reg.has(c));
  t('能力表里没有死条目', dead.length === 0, dead.join(','));
  /*
   * 这条同时是回归保护：watch_start/stop 与 fpx_watch_start/stop
   * 是**两组**命令，第一版只写了前者，导致 project-group 那两条
   * 一直挂 unknown、能力被低估。
   */
  t('两组 watch 命令都定了级',
    'watch_start' in COMMAND_CAPS && 'fpx_watch_start' in COMMAND_CAPS
    && 'watch_stop' in COMMAND_CAPS && 'fpx_watch_stop' in COMMAND_CAPS);
}

/* ---------------------------------------------------------------- */
console.log('\n--- 12. 能力拦截必须**按信任等级**分别生效 ---');
{
  /*
   * 这节是整个决策的护栏。
   *
   * 同一个组合风险，对内置插件是"正常工作"，对第三方是"外传通道"。
   * 差别不在组合，在信任 —— 所以必须两头都钉住：
   *   内置 → 不拦（否则核心功能残废）
   *   第三方 → 拦（否则这层约束只是好看）
   * 只钉一头的话，另一头会悄悄倒退。
   */
  const ip = await import('./js/invoke-policy.js');
  const { CAP_ENFORCEMENT, checkInvoke, registerBuiltinIds, resetBuiltinIds, isTrusted } = ip;
  const { capsOf, worstLevel, capOf } = await import('./js/command-caps.js');
  const fs2 = await import('node:fs');

  t('内置走 report-only', CAP_ENFORCEMENT.builtin === 'report-only', JSON.stringify(CAP_ENFORCEMENT));
  t('第三方走 enforce', CAP_ENFORCEMENT.third === 'enforce');

  /* 信任判定必须宿主注入，不能插件自报 */
  resetBuiltinIds();
  t('没注入时不可信（fail-closed）', isTrusted('home') === false);
  registerBuiltinIds(['home', 'agent-flow']);
  t('注入后内置可信', isTrusted('agent-flow') === true);
  t('未注入的 id 仍不可信', isTrusted('some-third-party') === false);

  /*
   * ⚠️ 插件自报 builtin 不能拿到豁免 —— 恶意插件写一句 builtin:true
   * 就绕过整个拦截的话，这层等于没有。
   */
  /*
   * 真调一次，而不是只查 isTrusted —— 只查后者的话，
   * 万一 checkInvoke 里另外读了 manifest.builtin，这条根本发现不了。
   */
  resetBuiltinIds();
  const evilCmds = ['run_node', 'fpx_read_file'];   // M + S = 红
  const evilManifest = { id: 'evil', builtin: true, commands: evilCmds };
  const evilRes = checkInvoke('evil', 'run_node', evilManifest);
  t('manifest.builtin:true 不产生豁免（真的被拦）', evilRes.ok === false,
    `ok=${evilRes.ok} reason=${(evilRes.reason || '').slice(0, 50)}`);
  t('自报 builtin 仍被当作第三方', isTrusted('evil') === false);

  /* 取真实白名单 */
  const src = fs2.readFileSync(path.join(root, 'js', 'invoke-policy.js'), 'utf8');
  const m = src.match(/export const PLUGIN_COMMANDS\s*=\s*\{([\s\S]*?)\}\s*;/);
  const by = new Map();
  for (const blk of m[1].matchAll(/'?([\u4e00-\u9fa5a-z_0-9-]+)'?\s*:\s*\[([\s\S]*?)\]/g)) {
    const cs = [...blk[2].matchAll(/'([a-z_0-9]{3,})'/g)].map((x) => x[1]);
    if (cs.length) by.set(blk[1], cs);
  }
  const reds = [...by.entries()].filter(([, cs]) => worstLevel(capsOf(cs)) === 'red');
  t('确实存在命中红色组合的插件（否则这节测了个空）', reds.length > 0, `红色 ${reds.length} 个`);

  /* ① 内置插件：即便命中红色，白名单命令**全部放行** */
  resetBuiltinIds();
  registerBuiltinIds([...by.keys()]);   // 注册表里的都算内置
  let blockedBuiltin = [];
  for (const [id, cs] of reds) {
    for (const c of cs) {
      const r = checkInvoke(id, c, null);
      if (!r.ok) blockedBuiltin.push(`${id} → ${c}: ${r.reason}`);
    }
  }
  /*
   * 最关键的一条：**红色组合对内置插件不代表拒绝**。
   * 若哪天有人把内置也接上拦截，这里立刻红，并报出被挡的是哪条。
   */
  t('内置插件命中红色也全部放行', blockedBuiltin.length === 0, blockedBuiltin.slice(0, 2).join(' | '));

  /* ② 第三方插件：命中红色组合时，参与该组合的等级被拒 */
  resetBuiltinIds();   // 谁都不注入 → 全部按第三方
  const [redId, redCmds] = reds[0];
  const profile = capsOf(redCmds);
  const banned = new Set();
  for (const r of profile.combos.filter((c) => c.level === 'red')) for (const lv of r.need) banned.add(lv);
  t('红色组合确实圈出了要拦的等级', banned.size > 0, [...banned].join(','));

  let blockedThird = [];
  let allowedThird = [];
  for (const c of redCmds) {
    const r = checkInvoke(redId, c, { id: redId, commands: redCmds });
    if (banned.has(capOf(c))) {
      if (r.ok) blockedThird.push(`该拦却放行: ${c}`);
    } else if (!r.ok) {
      allowedThird.push(`不该拦却拦了: ${c} → ${r.reason}`);
    }
  }
  t('第三方：参与红色组合的命令被拒', blockedThird.length === 0, blockedThird.slice(0, 2).join(' | '));
  /*
   * 反向同样重要：不能一刀切全拒。
   * R 类（读版本号/查状态）必须放行，否则第三方插件连基本查询都做不了，
   * 就成了"安全对了、功能死了"。
   */
  t('第三方：未参与组合的命令仍放行（不搞一刀切）', allowedThird.length === 0, allowedThird.slice(0, 2).join(' | '));

  /* ③ 拒绝信息要能看出原因，否则无从排查 */
  const one = redCmds.find((c) => banned.has(capOf(c)));
  const rej = checkInvoke(redId, one, { id: redId, commands: redCmds });
  t('拒绝时说明了原因', !rej.ok && /红区|组合/.test(rej.reason), rej.reason?.slice(0, 60));

  /* ④ 闸门没被拆：白名单外的命令仍然拒绝 */
  t('白名单外的命令仍然拒绝', checkInvoke('agent-flow', 'zzz_not_listed', null).ok === false);
  t('空命令名仍然拒绝', checkInvoke('agent-flow', '', null).ok === false);

  /* ⑤ 没命中红色组合的第三方插件不该被误伤 */
  resetBuiltinIds();
  const safeCmds = ['app_version', 'rust_ping'];
  t('纯 R 类的第三方插件不受影响',
    safeCmds.every((c) => checkInvoke('safe-plugin', c, { id: 'safe-plugin', commands: safeCmds }).ok));

  resetBuiltinIds();
}

/* ---------------------------------------------------------------- */
console.log('\n--- 13. 宿主必须在 concat 自定义插件**之前**注入内置 id ---');
{
  /*
   * 顺序反了的话，用户后来装的第三方插件也会被当成内置，
   * 于是"只对第三方生效"的拦截形同虚设 —— 而且不报错，
   * 只是静静地不生效。这是最难发现的一类失效。
   */
  const fs2 = await import('node:fs');
  const s2 = fs2.readFileSync(path.join(root, 'js', 'host.js'), 'utf8');
  const codeOnly = s2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const iReg = codeOnly.indexOf('registerBuiltinIds(list.map');
  const iConcat = codeOnly.indexOf("localStorage.getItem('nexus:custom-plugins')");
  t('host.js 里有注入调用', iReg > 0);
  t('注入发生在读取自定义插件之前', iReg > 0 && iConcat > 0 && iReg < iConcat,
    `注入@${iReg} concat@${iConcat}`);
  t('注入的是静态清单（不是含 custom 的 list）',
    /registerBuiltinIds\(list\.map\(\(p\) => p\.id\)\)/.test(codeOnly));
}

/* ---------------------------------------------------------------- */
console.log('\n--- 14. 第三方能力硬禁止（第二道锁）---');
{
  const { checkInvoke, registerBuiltinIds, resetBuiltinIds, HARD_DENY, THIRD_DENY_CAPS } =
    await import('./js/invoke-policy.js');
  const { capOf } = await import('./js/command-caps.js');

  t('THIRD_DENY_CAPS 含 M', THIRD_DENY_CAPS.includes('M'), JSON.stringify(THIRD_DENY_CAPS));
  t('不连带禁 S 与 W（否则第三方没法干正事）',
    !THIRD_DENY_CAPS.includes('S') && !THIRD_DENY_CAPS.includes('W'));

  /* ⚠️ HARD_DENY 必须保持空集 —— 见源码注释里的逐条理由。
     有人顺手塞一条时这里会红，逼他先读那段说明。 */
  t('HARD_DENY 保持空集（当前无任何"插件绝不该有"的命令）',
    HARD_DENY.size === 0, [...HARD_DENY].join(','));
  t('af_device_salt 不在 HARD_DENY（agent-flow 凭据加密在用，且是有意提供的能力）',
    !HARD_DENY.has('af_device_salt'));

  /* ① 不阻断：内置的 M 类命令照常放行 */
  resetBuiltinIds();
  registerBuiltinIds(['agent-flow', 'settings', 'mindmap', 'home']);
  for (const [id, c] of [
    ['agent-flow', 'run_node'],
    ['agent-flow', 'af_fs_allow_root'],
    ['settings', 'af_fs_allow_root'],
    ['mindmap', 'mm_open_devtools'],
  ]) {
    const r = checkInvoke(id, c, null);
    t(`内置 ${id} 的 ${c} 仍放行（不能被第二道锁误伤）`, r.ok === true, `ok=${r.ok} ${r.reason || ''}`.slice(0, 60));
  }

  /* ② 第三方：M 类一律拒绝，即便用户显式声明 */
  resetBuiltinIds();
  const mCmds = ['run_node', 'af_fs_allow_root', 'webhook_start', 'window_action',
    'mm_open_devtools', 'fpx_mcp_start', 'kill_node', 'tray_toggle_window'];
  let leaked = [];
  for (const c of mCmds) {
    /* 显式声明也该被拒 —— 这正是"第二道锁"的意义 */
    const r = checkInvoke('third-party', c, { id: 'third-party', commands: mCmds });
    if (r.ok) leaked.push(c);
  }
  t('第三方声明 M 类也全部被拒', leaked.length === 0, `漏了: ${leaked.join(',')}`);
  t('这些命令确实都是 M 类（否则测了个空）', mCmds.every((c) => capOf(c) === 'M'),
    mCmds.filter((c) => capOf(c) !== 'M').join(','));

  /* ③ 不搞一刀切：非 M 类仍可用，否则第三方插件什么都干不了 */
  resetBuiltinIds();
  for (const c of ['app_version', 'rust_ping']) {
    t(`第三方 ${c} 放行（装了就能查）`, checkInvoke('third-party', c, null).ok === true);
  }
  for (const c of ['fpx_read_file', 'fs_op']) {
    t(`第三方 ${c}（S/W 类）放行`, checkInvoke('third-party', c, { id: 'third-party', commands: [c] }).ok === true);
  }

  /* ④ 报错要说清原因 —— "填了没用"必须有解释 */
  resetBuiltinIds();
  const rej = checkInvoke('third-party', 'run_node', { id: 'third-party', commands: ['run_node'] });
  t('拒绝信息说明了是哪类能力', /M 类/.test(rej.reason), rej.reason?.slice(0, 50));
  t('拒绝信息给了出路（作为内置插件提供）', /内置/.test(rej.reason), rej.reason?.slice(0, 60));

  /* ⑤ 用户填了也拒 —— 这条是"安全覆盖用户意图"，必须明说 */
  t('用户在安装框里填 run_node 也照样被拒（风险非用户可评估）', rej.ok === false);

  resetBuiltinIds();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
