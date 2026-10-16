/**
 * MCP 网关「新插件接入后直接可用」的接线测试
 * ============================================================
 *
 * 为什么单立一个测试：
 *   本功能卖点是「AI 客户端只接入一次，各插件的 MCP 工具自动聚合」。
 *   但这条链上任何一个接点断了，症状都是**静默的**：
 *
 *     · 六条命令漏进 generate_handler!  → 编译不报错，界面按钮点了没反应，
 *       运行时报 "command not found"（与 rt_dep / oskeyring 同类的漏注册）
 *     · 漏了 command-caps 定级          → 扫描器第 ⑰ 组红，且命令对所有
 *       防护隐身（unknown 不命中 THIRD_DENY_CAPS 与组合规则）
 *     · 漏了 invoke-policy 白名单       → ctx.invoke 被默认拒绝拦掉，
 *       面板表现为"点了什么都没发生"
 *     · register_builtins 没接 / .manage 漏了 → 启动即 panic 或工具表是空的
 *
 *   这些断点分散在 Rust、JS 治理表、插件 UI 三处，各自看都对、
 *   合起来才能用。所以在这里**跨文件**钉住整条接线。
 *
 * 判据同源：命令名六条在四处出现（main.rs / command-caps.js /
 * invoke-policy.js / McpGatewayCard.tsx），本测试从同一份清单出发
 * 逐个核对接点，不各写一份字面量 —— 那样加第七条命令时会漏改测试。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* npm script 从仓库根跑，process.cwd() 不可靠 —— 一律以本文件位置为基准 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_RS = path.join(HERE, 'src-tauri/src/main.rs');
const GATE_RS = path.join(HERE, 'src-tauri/src/mcp_gate.rs');
const CARD = path.join(HERE, 'plugins/settings/McpGatewayCard.tsx');
const APP = path.join(HERE, 'plugins/settings/App.tsx');

let pass = 0;
let fail = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('✅ ' + name);
  } else {
    fail++;
    fails.push(name + (extra ? ` — ${extra}` : ''));
    console.log('❌ ' + name + (extra ? ` — ${extra}` : ''));
  }
}
function section(s) {
  console.log('\n=== ' + s + ' ===');
}

/* ------------------------------------------------------------------ */
/* 唯一真相源：网关的六条命令                                            */
/* 等级是设计决策（见 command-caps.js 里的逐条注释），这里连等级一起钉住    */
/* ------------------------------------------------------------------ */
const CMDS = [
  ['mcp_gw_start', 'M'],
  ['mcp_gw_stop', 'M'],
  ['mcp_gw_status', 'R'],
  ['mcp_gw_save_config', 'W'],
  ['mcp_gw_register', 'M'],
  ['mcp_gw_unregister', 'W'],
];
const NAMES = CMDS.map(([n]) => n);

const mainSrc = fs.readFileSync(MAIN_RS, 'utf8');
const gateSrc = fs.readFileSync(GATE_RS, 'utf8');
const cardSrc = fs.readFileSync(CARD, 'utf8');
const appSrc = fs.readFileSync(APP, 'utf8');

/* ================================================================== */
section('1. Rust 侧接线：状态、模块、命令注册');
/* ================================================================== */

t('（前置）main.rs 读到了', mainSrc.length > 5000);
t('（前置）mcp_gate.rs 读到了', gateSrc.length > 5000);

t('mod mcp_gate; 已声明', /\bmod mcp_gate\s*;/.test(mainSrc));
t(
  '.manage(mcp_gate::GatewayState::new()) 已注入',
  /\.manage\(mcp_gate::GatewayState::new\(\)\)/.test(mainSrc),
  '少了这行：六条命令一被调用就 panic 整个进程（State 解析失败是 panic）',
);

/* generate_handler! 是整块宏，先把块体取出来再逐条查 ——
   在全文件里 grep 会漏掉"命令在文件里出现过但没进宏"的情况，
   而那正是本测试要抓的形态（定义≠注册）。 */
const genStart = mainSrc.indexOf('tauri::generate_handler!');
t('（前置）generate_handler! 存在', genStart >= 0);
const genBlock = genStart >= 0 ? mainSrc.slice(genStart) : '';
for (const n of NAMES) {
  t(`generate_handler! 注册了 mcp_gate::${n}`, genBlock.includes(`mcp_gate::${n}`));
}
/* 自检：没进宏的写法确实判不合格 —— 拿一条只在 mod 注释里出现的名字当探针 */
t(
  '（自检）只在注释里出现、没进宏的命令判不合格 → 断言没失明',
  genBlock.includes('mcp_gw_') && !/\bmcp_gw_bogus\b/.test(genBlock),
);

/* ================================================================== */
section('2. Rust 侧实现：六条命令、内置注册、命名空间');
/* ================================================================== */

for (const n of NAMES) {
  /* 定义处：`#[tauri::command...]\npub fn <name>(` 必须成对出现。
     少了属性 = 前端调到时才报 "command not found"。 */
  const re = new RegExp(`#\\[tauri::command[^\\]]*\\]\\s*\\npub fn ${n}\\(`);
  t(`${n} 带 #[tauri::command] 属性且为 pub fn`, re.test(gateSrc));
}

t(
  'register_builtins 同时注册 fpx 与 task-board 两个 server',
  /for t in fpx::mcp::tools\(\)/.test(gateSrc) && /for t in task_board::mcp_tools\(\)/.test(gateSrc),
);
t(
  'register_builtins 里两个 server 都调了 register_native（不是只循环）',
  /register_native\(state, SERVER_FPX/.test(gateSrc) && /register_native\(state, SERVER_TB/.test(gateSrc),
);
t(
  '内置 server 名与命令分级注释里的口径一致（project-group / task-board）',
  /SERVER_FPX: &str = "project-group"/.test(gateSrc) && /SERVER_TB: &str = "task-board"/.test(gateSrc),
);
t(
  '工具名前缀分隔符是 "__"（split_once 取第一个，防工具名自带下划线时错切）',
  /SEP: &str = "__"/.test(gateSrc) && /split_once\(SEP\)/.test(gateSrc),
);
t(
  'fpx 的 handler 调用时现取数据目录（注册时定死 = 用户改目录后读写旧库）',
  /resolve_data_dir\(&app_c\)/.test(gateSrc) && /fpx::mcp::invoke_tool/.test(gateSrc),
);
t(
  'task-board 的 handler 未授权数据目录时给指引而非兜底默认目录',
  /fn tb_data_dir/.test(gateSrc) && /授权/.test(gateSrc),
);
t(
  'task-board 的 isError 结果原样透传（网关不拆开重包）',
  /mcp_call_tool/.test(gateSrc) && /Ok\(result\)/.test(gateSrc),
);

/* ================================================================== */
section('3. 命令治理四件套：定级 + 白名单（真代码调用）');
/* ================================================================== */

const { COMMAND_CAPS, capOf } = await import('./js/command-caps.js');
const { PLUGIN_COMMANDS, checkInvoke, registerBuiltinIds, resetBuiltinIds, HARD_DENY } =
  await import('./js/invoke-policy.js');

for (const [n, lv] of CMDS) {
  t(`command-caps.js 定级 ${n} = ${lv}`, capOf(n) === lv, `实际 ${capOf(n)}`);
  t(`${n} 进了 settings 插件的 invoke 白名单`, PLUGIN_COMMANDS.settings?.includes(n) === true);
}

/* ③b：没有命令留在 unknown —— unknown 对所有防护隐身（见源码注释 ②） */
const unknown = NAMES.filter((n) => capOf(n) === 'unknown');
t('六条没有一条挂 unknown（否则扫描器第 ⑰ 组红且防护隐身）', unknown.length === 0, unknown.join(','));

/* HARD_DENY 必须保持空集（command-consistency-test.mjs 已全局钉住，
   这里只确认新命令没被顺手塞进去） */
t('六条都没被塞进 HARD_DENY', NAMES.every((n) => !HARD_DENY.has(n)));

/* 真代码跑一遍拦截：settings 是内置插件全放行；第三方连声明带授权也拿不到 M 类 */
resetBuiltinIds();
registerBuiltinIds(['settings', 'project-group', 'agent-flow', 'home']);
for (const n of NAMES) {
  t(`内置 settings 调 ${n} 放行`, checkInvoke('settings', n, null).ok === true);
}
const mCmds = CMDS.filter(([, lv]) => lv === 'M').map(([n]) => n);
const leaked = mCmds.filter((n) => checkInvoke('third-party', n, { id: 'third-party', commands: [n] }).ok);
t(
  `第三方声明+白名单也拿不到 M 类三条（${mCmds.join('/')}）`,
  leaked.length === 0,
  `漏了: ${leaked.join(',')}`,
);
/* 自检：M 类判定没失明 —— 把 R/W 类当探针，它们不该被能力层拦 */
const nonM = CMDS.filter(([, lv]) => lv !== 'M').map(([n]) => n);
t(
  '（自检）非 M 类不被能力层误伤（R/W 走声明+放行流程，与能力层无关）',
  nonM.every((n) => {
    const r = checkInvoke('third-party', n, { id: 'third-party', commands: [n] });
    return r.ok === false && !String(r.reason).includes('不给第三方');
  }),
  nonM.map((n) => `${n}:${JSON.stringify(checkInvoke('third-party', n, { id: 'third-party', commands: [n] }))}`).join(' '),
);

/* ================================================================== */
section('4. setup 接线：注册 + 自动启动');
/* ================================================================== */

t(
  'setup 里调了 mcp_gate::refresh_config（读盘落配置）',
  /mcp_gate::refresh_config\(app\.handle\(\), &gw\)/.test(mainSrc),
);
t(
  'setup 里调了 mcp_gate::register_builtins（内置工具进注册表）',
  /mcp_gate::register_builtins\(app\.handle\(\), &gw\)/.test(mainSrc),
);
t(
  'auto_start 为 true 时启动网关（免手动开启是本功能的卖点）',
  /if auto \{[\s\S]{0,200}?mcp_gate::start\(app\.handle\(\), &gw, None\)/.test(mainSrc),
);
t(
  '读 auto_start 用 lock() 且 unwrap_or(false)（中毒时保守不启动）',
  /\.cfg\s*\n?\s*\.lock\(\)/.test(mainSrc) && /unwrap_or\(false\)/.test(mainSrc),
);

/* ================================================================== */
section('5. UI 接线：设置页「MCP 网关」页签');
/* ================================================================== */

t('（前置）McpGatewayCard.tsx 读到了', cardSrc.length > 3000);
t('App.tsx import 了 McpGatewayCard', /import McpGatewayCard from '\.\/McpGatewayCard'/.test(appSrc));
t("TabKey 里有 'mcpgw'", /'mcpgw'/.test(appSrc));
t('TABS 里有「MCP 网关」页签', /\['mcpgw', 'MCP 网关'\]/.test(appSrc));
t('渲染分支接了 McpGatewayCard', /tab === 'mcpgw' \? <McpGatewayCard \/>/.test(appSrc));

for (const n of NAMES) {
  t(`McpGatewayCard 里调用了 ${n}`, new RegExp(`'${n}'`).test(cardSrc));
}
t(
  '面板读的是 mcp_gw_status（不另起一套查询通道）',
  /ctx\.invoke<GwStatus>\('mcp_gw_status'\)/.test(cardSrc),
);
t(
  '保存走 mcp_gw_save_config 并处理 needRestart（端口/令牌改了要重启生效）',
  /'mcp_gw_save_config'/.test(cardSrc) && /needRestart/.test(cardSrc),
);

/* ================================================================== */
section('6. 负向自检：断言不会永远为真');
/* ================================================================== */

t('不存在的命令判 unknown（第 3 节的定级断言不是恒真）', capOf('mcp_gw_bogus') === 'unknown');
t('不存在的命令不在 settings 白名单（白名单断言不是恒真）', PLUGIN_COMMANDS.settings?.includes('mcp_gw_bogus') !== true);
t('mcp_gate.rs 里没有 mcp_gw_bogus 定义（第 2 节的属性断言不是恒真）', !gateSrc.includes('mcp_gw_bogus'));
t('App.tsx 里没有 mcp_gw_bogus 调用（第 5 节的 UI 断言不是恒真）', !appSrc.includes('mcp_gw_bogus'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败清单：');
  for (const f of fails) console.log('  · ' + f);
  process.exitCode = 1;
}
