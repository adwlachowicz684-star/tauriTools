/**
 * MCP「字符串参数」类型不符必须报错，不能静默当"没传"（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/mcp-string-args-test.mjs
 *
 * 与 `mcp-typed-args-test`（boolean / integer）是同一条线的收尾：
 * `s()` 是 `and_then(v.as_str).unwrap_or("")` —— **类型不符与"没传"都得到 ""**。
 *
 * 多数参数的 "" 随后会被必填校验拦住（只是报错指向了错的原因），
 * 但下面几处的 "" **是有语义的默认值**，静默走下去就成了"调用方明说了、
 * 却被当成没说"，而方向恰好是破坏性的：
 *
 *   · `set_tag_color` 的 color："" → None → **清除该卡片的标签颜色**，
 *     回包仍写「标签颜色已保存」。schema 里就写着"空串=恢复默认"，
 *     所以"传了但类型不对"与"显式要恢复默认"在这里完全无法区分。
 *
 *   · `scan_content` 的 root："" → 回退当前选中 → 扫的是**另一个目录**，
 *     而回包不写扫的哪个目录，AI 会当成它指定的那个报给用户。
 *     同工具的 kind："" → all → 返回的是全类别，不是要的那类。
 *
 *   · `deploy_skill` 的 agentCmd："" → 用配置里的默认客户端 → 提示词被
 *     发给**另一个 AI 客户端**，进程都拉起来了才发现不对。
 *     同工具的 target："" → 用当前选择 → 生成到别的目录。
 *
 * 判据：没传（或显式 null）才用默认值；传了但不是字符串一律报错。
 * 且判据取自 `tools()` 的 schema，不手抄一份参数表 —— 抄两份必然漂移，
 * 漂移的表现正是"新增参数忘了纳入，于是又静默一次"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_PATH = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx', 'mcp.rs');
const { t, done } = makeT();

const MCP = fs.readFileSync(MCP_PATH, 'utf8');
/** 只看真代码：本文件的修复注释里就写着 `s("color")` 之类字样，不剥会误报。 */
const CODE = MCP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 按大括号配平切出一段（避免切到别处 / 切到文件末尾） */
function sliceBlock(src, anchor, open = '{') {
  const i = src.indexOf(anchor);
  if (i === -1) return '';
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === open) { depth++; started = true; }
    else if (c === (open === '{' ? '}' : ')')) {
      depth--;
      if (started && depth === 0) return src.slice(i, j + 1);
    }
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 从 tools() 解析出每个工具的字符串参数（真 schema，不是手抄清单）
 * ------------------------------------------------------------------ */
function parseTools(src) {
  const out = [];
  const starts = [];
  const re = /\btool\(\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => {
    const from = s.at;
    const to = i + 1 < starts.length ? starts[i + 1].at : src.length;
    const block = src.slice(from, to);
    const props = {};
    for (const p of block.matchAll(/"(\w+)":\s*\{\s*"type":\s*"(\w+)"/g)) {
      props[p[1]] = p[2];
    }
    out.push({ name: s.name, props });
  });
  return out;
}
const TOOLS = parseTools(CODE);

/** check_string_args 的 JS 镜像（判据与 Rust 一致，用它跑行为断言） */
function checkStringArgs(toolName, args) {
  const tool = TOOLS.find((x) => x.name === toolName);
  if (!tool) return null;
  for (const [k, type] of Object.entries(tool.props)) {
    if (type !== 'string') continue;
    if (!(k in args)) continue;
    const v = args[k];
    if (v === null) continue;
    if (typeof v === 'string') continue;
    return `${k} 需要字符串，收到 ${JSON.stringify(v)}`;
  }
  return null;
}

console.log('=== 1. check_string_args 确实存在，且三分支缺一不可 ===');
const CHK = sliceBlock(CODE, 'fn check_string_args');
{
  t('切到的确实是 check_string_args（不是别处）',
    CHK.startsWith('fn check_string_args'), CHK.slice(0, 90));
  t('函数存在', CHK.length > 0);

  /* 三分支：缺"其余一律 Err"就等于没修（回到静默当空串） */
  t('没传 / 显式 null / 是字符串 → 放行',
    /None \| Some\(Value::Null\) \| Some\(Value::String\(_\)\) => \{\}/.test(CHK));
  t('其余类型 → Err（不是静默当空串）',
    /Some\(v\) =>\s*return Err\(err\(/.test(CHK));
  t('Err 文案带上参数名（调用方知道改哪个）',
    /format!\("\{k\} 需要字符串/.test(CHK));
}

console.log('\n=== 2. 判据取自 schema，不手抄参数表 ===');
{
  t('从 tools() 取（唯一来源）', /tools\(\)/.test(CHK));
  t('读 inputSchema.properties', /get\("properties"\)/.test(CHK));
  t('按 "type" == "string" 过滤', /"type"/.test(CHK) && /"string"/.test(CHK));
  /* 手抄一份表的话，新增参数必然忘记同步 —— 钉住"没有硬编码参数名" */
  t('函数体里没有硬编码的参数名（否则就是抄表）',
    !/"(color|agentCmd|hierarchy)"\s*=>/.test(CHK) && !/\["color"/.test(CHK));
}

console.log('\n=== 3. 调用点在 call_tool 内、带 ?、且在 s() 之前 ===');
{
  const callAt = CODE.indexOf('check_string_args(name, &args)?;');
  const sAt = CODE.indexOf('let s = |k: &str|');
  const fnAt = CODE.indexOf('fn call_tool');
  t('调用点存在且带 ?（漏了 ? 等于没调用）', callAt !== -1);
  t('在 call_tool 之内', fnAt !== -1 && callAt > fnAt);
  /* 顺序不能反：s() 的定义与使用都在后面的 match 里，
     校验必须排在它们之前，否则读到的仍是"类型不符 → 空串" */
  t('在 s() 之前（否则读到的是空串）',
    sAt !== -1 && callAt !== -1 && callAt < sAt, `check=${callAt} s=${sAt}`);
  t('用的是 name（别名归一化之后的实名）',
    /check_string_args\(name, &args\)/.test(CODE));
}

console.log('\n=== 4. 行为：JS 镜像跑真 schema ===');
{
  /* 破坏性最强的那个：color 传数字 → 修复前静默清除颜色 */
  t('set_tag_color color 传数字 → 报错（不再静默清除）',
    /color/.test(checkStringArgs('set_tag_color', { path: '/a', color: 16711680 }) || ''),
    checkStringArgs('set_tag_color', { path: '/a', color: 16711680 }));
  t('set_tag_color color 传布尔 → 报错',
    /color/.test(checkStringArgs('set_tag_color', { path: '/a', color: true }) || ''));
  t('set_tag_color color 正常字符串 → 放行',
    checkStringArgs('set_tag_color', { path: '/a', color: '#ff0000' }) === null);
  t('set_tag_color color 显式 null → 放行（等同没给，走默认值）',
    checkStringArgs('set_tag_color', { path: '/a', color: null }) === null);
  t('set_tag_color 没传 color → 放行',
    checkStringArgs('set_tag_color', { path: '/a' }) === null);

  t('scan_content root 传数字 → 报错（不再静默扫当前选中）',
    /root/.test(checkStringArgs('scan_content', { root: 42, kind: 'all' }) || ''));
  t('scan_content kind 传数组 → 报错（不再静默当 all）',
    /kind/.test(checkStringArgs('scan_content', { root: '/g', kind: ['agent'] }) || ''));
  t('scan_content 正常 → 放行',
    checkStringArgs('scan_content', { root: '/g', kind: 'skill' }) === null);

  t('deploy_skill agentCmd 传布尔 → 报错（不再发给默认客户端）',
    /agentCmd/.test(checkStringArgs('deploy_skill', { prompt: 'x', agentCmd: true }) || ''));
  t('deploy_skill target 传数字 → 报错（不再生成到当前选中）',
    /target/.test(checkStringArgs('deploy_skill', { prompt: 'x', target: 7 }) || ''));

  /* 反面证据：不能误伤 */
  t('未声明的多余参数不误报（只校验 schema 声明过的）',
    checkStringArgs('read_file', { path: '/a', whatever: 123 }) === null);
  t('未知工具名 → 放行（schema 里没有就不管）',
    checkStringArgs('no_such_tool', { x: 1 }) === null);
  t('无参数工具的空 arguments → 放行',
    checkStringArgs('list_projects', {}) === null);
}

console.log('\n=== 5. 兜底：所有「空串=默认值」的参数都被 schema 声明为 string ===');
{
  /* 通用校验只覆盖 schema 声明过的参数。若哪天某个"空串有语义"的参数
     忘了在 schema 里声明（或声明成了别的类型），它就会漏出去静默 ——
     所以这里逐个钉住它们在 schema 里的类型。 */
  const risky = [
    ['set_tag_color', 'color', '空串 = 恢复默认（清除颜色）'],
    ['scan_content', 'root', '空串 = 回退当前选中'],
    ['scan_content', 'kind', '空串 = all'],
    ['deploy_skill', 'agentCmd', '空串 = 用配置的默认客户端'],
    ['deploy_skill', 'target', '空串 = 用当前选择'],
    ['create_folder', 'kind', '空串 = 只建目录、不登记（孤儿目录）'],
    ['create_folder', 'hierarchy', '空串 = 不拼层级（建到错位置）'],
  ];
  for (const [tool, key, why] of risky) {
    const found = TOOLS.find((x) => x.name === tool);
    t(`${tool}.${key} 声明为 string（${why}）`,
      !!found && found.props[key] === 'string',
      found ? `实际 ${found.props[key] ?? '未声明'}` : '工具不存在');
  }

  t('解析到的工具不少于 20 个（解析器没坏）', TOOLS.length >= 20, `${TOOLS.length} 个`);
  const strCount = TOOLS.reduce(
    (n, x) => n + Object.values(x.props).filter((v) => v === 'string').length, 0);
  t('解析到的字符串参数不少于 15 个', strCount >= 15, `${strCount} 个`);
}

done();
