/**
 * MCP 服务「保存」必须拦住"命令和地址都空"
 * ============================================================
 *
 * 为什么单独立一个测试：
 *   在「云端」页签点「+ 添加」，只填名字就保存 —— 命令和地址都是空的，
 *   而 transportOf 在两者都空时**兜底判成 local**，于是这条服务不在
 *   「云端」页签的列表里：保存完**凭空消失**。
 *   用户只会以为没存上（或以为面板坏了），然后一遍遍重新添加。
 *
 *   这样的服务存进去也起不来：isRunnable 为 false，列表里同样会标
 *   「这个服务起不来」。所以不该让它存进去。
 *
 * 判据同源：按钮的 disabled、saveEdit 的守卫、列表里的「起不来」标记，
 * 三处都应该是 engine 侧 isRunnable / transportOf 那一套。
 * 各写一份的话，按钮放行了、列表却按另一套判据把它划走，就是"保存完消失"。
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
// 剥注释一律走共用实现：全仓只此一份，避免各写一份再漂移。
// 原先内联的那份把块注释替换成**空串**（会把 `a/*x*/b` 粘成 `ab`），
// 共用实现替换成空格，语义更安全；行注释规则同为「不吃 https:// 里的 //」。
import { stripCommentsJs } from './test-scan-utils.mjs';

/* npm script 从仓库根跑，process.cwd() 不可靠 —— 一律以本文件位置为基准 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENG = path.join(HERE, 'plugins/agent-flow/engine/mcpServers.ts');
const PANEL = path.join(HERE, 'plugins/agent-flow/components/McpServersPanel.tsx');

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
/* 把 engine 侧的真代码跑起来（不是看源码里有没有那几个字）            */
/* ------------------------------------------------------------------ */
function loadMcp() {
  const src = fs.readFileSync(ENG, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const body =
    js
      .replace(/^\s*import[\s\S]*?;\s*$/gm, '') // 掉 kv / sanitize 两个依赖
      .replace(/^(\s*)export\s+/gm, '$1') + // export 在 new Function 里是语法错
    '\nreturn { transportOf, isRunnable, validateServers, newServer };';
  const pre = 'let defaultKV=()=>({}), loadList=()=>[], saveWrapped=()=>{}, looksLikeSecretName=()=>false;\n';
  return new Function(pre + body)();
}

const M = loadMcp();

section('1. 真代码：只填名字的服务会落到哪个页签');
t('（前置）真代码加载成功', typeof M.transportOf === 'function' && typeof M.isRunnable === 'function');

/* 「云端」页签点「+ 添加」→ startNew 给的是 { ...newServer(''), command: undefined }，
   用户只改名字，地址从未填。 */
const cloudDraft = { ...M.newServer(''), name: 'xmind', command: undefined };
t('只填名字：既没有命令也没有地址 → isRunnable 为 false', M.isRunnable(cloudDraft) === false);
t(
  '只填名字：transportOf 兜底判成 local（不是 remote）',
  M.transportOf(cloudDraft) === 'local',
  `实际 ${M.transportOf(cloudDraft)}`,
);
t(
  '→ 在「云端」页签的列表里被过滤掉，保存完凭空消失',
  M.transportOf(cloudDraft) !== 'remote',
);
t(
  '（自检）判据没失明：填了地址就判成 remote',
  M.transportOf({ id: 'a', name: 'x', url: 'http://x' }) === 'remote',
);

const issues = M.validateServers([{ ...cloudDraft }]);
t(
  'engine 侧本来就判"这个服务起不来" → 说明存进去也没用',
  issues.some((i) => String(i.message).includes('起不来')),
  JSON.stringify(issues.map((i) => i.message)),
);

section('2. 面板：保存按钮与守卫都用同一份判据');
const src = fs.readFileSync(PANEL, 'utf8');
const stripped = stripCommentsJs(src);

t('（前置）源码读到了', src.length > 3000);
t(
  'disabled 不再只判名称（用了 saveBlocker）',
  /disabled\s*=\s*\{[^}]*saveBlocker/.test(stripped),
);
t(
  'saveBlocker 的判据里含 isRunnable（与 engine 同源）',
  /isRunnable\(editing\)/.test(stripped),
);
t(
  'saveEdit 里也有同一条守卫（按钮之外再兜一层）',
  /if\s*\(!isRunnable\(editing\)\)\s*return/.test(stripped),
);
t(
  '缺什么会写出来（置灰不给原因 = 用户知道点不动却不知道填哪个）',
  /还差/.test(src) && /saveBlocker/.test(src.slice(src.indexOf('还差') - 400, src.indexOf('还差') + 200)),
);
t(
  '按页签说清缺的是启动命令还是地址',
  /tab === 'local' \? '启动命令' : '地址'/.test(stripped),
);
t(
  'isRunnable 是从 engine 导入的（不是面板里另写一份）',
  /import\s*\{[^}]*\bisRunnable/s.test(src),
);

section('3. 破坏验证：换掉的写法确实抓不住');
/* 旧写法：disabled={!String(editing.name ?? '').trim()} */
const oldShape = /disabled\s*=\s*\{!String\(editing\.name \?\? ''\)\.trim\(\)\}/.test(stripped);
t('（自检）旧写法会被判成"不合格" → 断言没失明', oldShape === false);

const noGuard = /const saveEdit = \(\) => \{[\s\S]{0,300}?if \(!name\) return;[\s\S]{0,200}?commit\(next\)/.test(stripped);
t('（自检）撤掉 isRunnable 守卫就能被抓出来 → 断言没失明', noGuard === false);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败清单：');
  for (const f of fails) console.log('  · ' + f);
  process.exitCode = 1;
}
