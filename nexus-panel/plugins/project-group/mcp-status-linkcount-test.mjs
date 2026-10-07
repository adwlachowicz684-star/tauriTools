/**
 * MCP 链接条数口径回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/mcp-status-linkcount-test.mjs
 *
 * 背景：get_status 的 linkCount 此前取 `snap.links.len()`，那是**记录条数**
 * （一条 LinkRow = 一个「项目→项目组」的建链记录），不是链接条数。
 *
 * 一个项目建了 3 个链接名（.claude / .cursor / .opencode）时：
 *   · 卡片徽章 link_count = 3（store.rs 取 details.len()）
 *   · get_status 报 linkCount = 1（links.len()）
 * 同一份数据、两个通道互相矛盾的数字。AI 靠 get_status 判断"现在连着几条"，
 * 拿到 1 会以为另外两条没建成 → 重复去建、或告诉用户"只连了 1 条"。
 * 全程不报错，只是数字不对。
 *
 * 这里守四件事：
 *   · linkCount 走 link_total（各项目 names 之和），**不是** links.len()
 *   · linkedProjects 仍给记录数，两个数字各自写清口径
 *   · 工具描述里两个数字都点出来（只写"链接数"调用方分不清是哪种）
 *   · remove_link 那句「剩余 N 条」必须是**记录**口径（它写的是记录）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripComments as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx/mcp.rs');
const STORE = path.join(HERE, '../../src-tauri/src/fpx/store.rs');
const { t, done } = makeT();

if (!fs.existsSync(RS)) {
  console.log('（跳过：未找到 mcp.rs）');
  done();
}
const rs = fs.readFileSync(RS, 'utf8');
const rss = strip(rs);

/* get_status 分支：用稳定的命名锚点，两端都判 >= 0 */
const gsStart = rss.indexOf('"get_status" => {');
const gsEnd = rss.indexOf('"select_folder" => {');
const status = gsStart >= 0 && gsEnd > gsStart ? rss.slice(gsStart, gsEnd) : '';
t('取到 get_status 分支（锚点命中）', status.length > 0 && status.includes('linkCount'),
  `len=${status.length}`);

console.log('\n=== 1. link_total 存在且口径为 names 之和 ===');
t('link_total 已定义', /fn link_total\(/.test(rss));
{
  /* 取函数体：从 `fn link_total(` 起按大括号配平切，避免切到别的块 */
  const at = rss.indexOf('fn link_total(');
  let i = rss.indexOf('{', at), depth = 0, end = -1;
  for (let k = i; k < rss.length; k++) {
    if (rss[k] === '{') depth++;
    else if (rss[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  const body = rss.slice(at, end);
  t('取到 link_total 函数体（配平成功）', end > 0 && body.includes('sum()'), `end=${end}`);
  t('按 names.len() 求和', /r\.names\.len\(\)/.test(body) && /\.sum\(\)/.test(body));
  t('不按 links.len() 求和', !/snap\.links\.len\(\)/.test(body));
}

console.log('\n=== 2. link_total 跑真身（行为证据，不是看源码形态）===');
{
  const at = rss.indexOf('fn link_total(');
  let i = rss.indexOf('{', at), depth = 0, end = -1;
  for (let k = i; k < rss.length; k++) {
    if (rss[k] === '{') depth++;
    else if (rss[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  /*
   * 只做**语义等价**的机械改写，不改判据形状：
   *   fn 签名 → function；.iter() → 去掉（JS 数组自带 .map）；
   *   |r| x → (r) => x；.len() → .length；.sum() → reduce 求和
   * 如果哪天这里加载失败，说明函数形状变了，测试必须跟着看，不能靠 try 吞掉。
   */
  /*
   * Rust 的**末尾表达式即返回值**，JS 没有这回事 —— 必须显式 return，
   * 否则函数恒返回 undefined，所有行为断言都变成"undefined !== 3"，
   * 看着在跑、其实一条都没验到（比直接崩掉更难发现）。
   */
  const inner = rss.slice(i + 1, end - 1);
  const src = `function link_total(snap) {\n    return (${inner});\n}`
    .replace(/\.iter\(\)/g, '')
    .replace(/\|([A-Za-z_]\w*)\|/g, '($1) =>')
    .replace(/\.len\(\)/g, '.length')
    .replace(/\.sum\(\)/g, '.reduce((a, b) => a + b, 0)');
  let fn = null;
  try {
    /* 注意末尾的 ()：new Function 返回的是外层壳，不调用拿到的是壳本身
       （上一版就漏了这对括号，于是"跑真身"实际在比对函数源码字符串） */
    fn = new Function(`${src}; return link_total;`)();   // eslint-disable-line no-new-func
  } catch (e) {
    t('link_total 可加载（剥类型后语法合法）', false, String(e.message || e));
  }
  if (fn) {
    t('link_total 跑真身（函数可调用）', typeof fn === 'function', typeof fn);
    /* 核心场景：1 个项目建 3 个链接名 —— 记录 1 条、链接 3 条 */
    const snap1 = { links: [{ project: 'P', names: ['.claude', '.cursor', '.opencode'] }] };
    t('1 个项目 3 个链接名 → link_total = 3', fn(snap1) === 3, `得到 ${fn(snap1)}`);
    t('同一份数据 links.len() 只有 1（证明两个口径确实不同）',
      snap1.links.length === 1, `得到 ${snap1.links.length}`);
    /* 多个项目相加 */
    const snap2 = { links: [{ project: 'A', names: ['x'] }, { project: 'B', names: ['y', 'z'] }] };
    t('多项目相加（1 + 2 = 3）', fn(snap2) === 3, `得到 ${fn(snap2)}`);
    /* 空账本 */
    t('空账本 → 0', fn({ links: [] }) === 0, `得到 ${fn({ links: [] })}`);
    /* 有记录但该项目还没分配任何链接名 */
    t('有记录但 names 为空 → 0', fn({ links: [{ project: 'A', names: [] }] }) === 0);
  }
}

console.log('\n=== 3. get_status 回包：两个数字各自写清口径 ===');
t('linkCount 走 link_total', /"linkCount":\s*link_total\(&snap\)/.test(status));
t('linkCount 不再用 links.len()', !/"linkCount":\s*snap\.links\.len\(\)/.test(status));
t('linkedProjects 仍给记录数', /"linkedProjects":\s*snap\.links\.len\(\)/.test(status));
{
  const a = status.indexOf('linkCount');
  const b = status.indexOf('linkedProjects');
  t('两个字段都在回包里', a >= 0 && b >= 0, `linkCount@${a} linkedProjects@${b}`);
}

console.log('\n=== 4. 工具描述里点明两个数字（调用方不必猜）===');
{
  const descAt = rss.indexOf('tool("get_status"');
  const desc = descAt >= 0 ? rss.slice(descAt, descAt + 400) : '';
  t('取到 get_status 的 schema 声明', desc.includes('get_status'), `len=${desc.length}`);
  t('描述里写了 linkCount', /linkCount/.test(desc));
  t('描述里写了 linkedProjects', /linkedProjects/.test(desc));
  t('描述里点明是链接条数', /链接条数/.test(desc));
  t('描述里点明是已建链的项目数', /已建链的项目数/.test(desc));
}

console.log('\n=== 5. 徽章口径（证明矛盾确实存在过）===');
if (fs.existsSync(STORE)) {
  const st = strip(fs.readFileSync(STORE, 'utf8'));
  t('store.rs 的 link_count 取 details.len()（徽章口径）',
    /link_count:\s*details\.len\(\)/.test(st));
} else {
  /* 用真实条件而不是字面 true：字面 true 会被断言卫生护栏判成占位断言，
     而且它掩盖"少了一个文件"这件事（该报的是缺文件，不是通过） */
  t('store.rs 存在（否则第 5 节无法核对徽章口径）', fs.existsSync(STORE), STORE);
}

console.log('\n=== 6. remove_link 的「剩余」必须是记录口径 ===');
{
  const rmStart = rss.indexOf('"remove_link" => {');
  const rmEnd = rss.indexOf('"scan_content" => {');
  const rm = rmStart >= 0 && rmEnd > rmStart ? rss.slice(rmStart, rmEnd) : '';
  t('取到 remove_link 分支（锚点命中）', rm.length > 0 && rm.includes('已撤销'), `len=${rm.length}`);
  t('文案写的是「记录」不是「链接」', /账本剩余 .* 条记录/.test(rm));
  /* 反向：若写成"剩余 N 条链接"就与 link_names_of 那处口径冲突 */
  t('没有出现「剩余 .. 条链接」这种含糊写法', !/剩余 .* 条链接/.test(rm));
}

console.log('\n=== 7. 兜底：全仓不得再有用 links.len() 报「链接条数」的地方 ===');
{
  /*
   * 逐个 `snap.links.len()` 取它前面最近的那个格式化字符串（真正在报数的那句），
   * 而不是"前后 N 个字符"——`.` 不跨行，窗口会停在换行上只拿到缩进，
   * 于是既看不见「记录」也看不见「链接」，过滤条件必然落空（上一版就栽在这）。
   */
  const hits = [...rss.matchAll(/snap\.links\.len\(\)/g)];
  const suspicious = [];
  for (const m of hits) {
    const before = rss.slice(Math.max(0, m.index - 400), m.index);
    const strs = [...before.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    const msg = strs[strs.length - 1] || '';
    /* 报数那句只要提到「链接」，就必须同时写清是「记录」口径 */
    if (/链接|linkCount|link/i.test(msg) && !/记录|linkedProjects/.test(msg)) {
      suspicious.push(msg.slice(0, 60));
    }
  }
  t('每个 links.len() 的报数文案都写清是记录口径',
    suspicious.length === 0, suspicious.join(' | ') || `0 处（共 ${hits.length} 个调用点）`);
  t('links.len() 调用点数量可预期（新增须过上面那道判据）',
    hits.length >= 2 && hits.length <= 4, `${hits.length} 处`);
}

done();
