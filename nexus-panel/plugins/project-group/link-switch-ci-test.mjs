/**
 * 链接名「开关」的键一律大小写不敏感（#354 收尾）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/link-switch-ci-test.mjs
 *
 * #354 原本修的是**置顶**（加 / 删 / 查 / 改名迁移）四处，上一轮补了
 * **落盘**（resetToPreset / pick / keptPinned）。但**开关**这条线还有 8 处
 * 仍用精确比较：
 *   · utils/linkAgents.ts  setAllEnabled / allEnabled / invertEnabled
 *   · components/LinkPanel.tsx  toggle / migrate / rename 里的 setMap
 *   · components/LinkPickDialog.tsx  建链弹窗的默认勾选
 *   · src-tauri/src/fpx/junction.rs  enabled_names 两处 HashMap::get
 *
 * 后果（config 里存的是旧大小写时 —— 手改过 config、或老版本迁移上来）：
 *   · **改名后开关静默丢失**：用户关掉过的名字改个名就变回"启用"，
 *     建链时凭空多出一个他不想要的链接；备注 / 厂商同理消失；
 *   · **一条名字两条键并存**：toggle 精确写会新增 `.claude` 而留下 `.Claude`。
 *     后端改成不敏感查找后取的是 `find` 的第一个匹配，而 HashMap 迭代顺序
 *     不确定 —— 同一个操作每次结果可能不同，这是所有表现里最难查的一种；
 *   · **建链弹窗默认勾选**：用户关掉的名字仍默认勾着。
 *
 * 所以这里**跑真身**而不是断言"源码里有 sameName 这几个字"：
 * 后者证明不了旧大小写那份到底保不保得住、也证明不了会不会留下孤儿键。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, stripTS, makeT } from './testkit.mjs';
import { stripCommentsFlat } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PG = HERE;
const RS = path.resolve(HERE, '../../src-tauri/src/fpx');
const A = await loadTs(path.join(HERE, 'utils/linkAgents.ts'));
const {
  agentEnabled, findEnableKey, allEnabled, setAllEnabled, invertEnabled, sameName,
} = A;
const { t, done } = makeT();

/** 剥块注释：判"源码里有没有某个写法"时必须先剥，否则被注释里的字样喂饱 */
const stripDoc = (s) => stripCommentsFlat(s);

const lpRaw = fs.readFileSync(path.join(PG, 'components/LinkPanel.tsx'), 'utf8');
const lp = stripDoc(lpRaw);
const pdRaw = fs.readFileSync(path.join(PG, 'components/LinkPickDialog.tsx'), 'utf8');
const pd = stripDoc(pdRaw);

/** 按锚点配平大括号切片（在剥注释后的源码上切，避免锚点落在注释里） */
function sliceFn(s, anchor) {
  const i = s.indexOf(anchor);
  if (i === -1) throw new Error('锚点未命中: ' + anchor);
  const j = s.indexOf('{', i);
  if (j === -1) throw new Error('锚点后无 { : ' + anchor);
  let d = 0;
  for (let k = j; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) return s.slice(i, k + 1); }
  }
  throw new Error('大括号未配平: ' + anchor);
}

/**
 * 切片 → 剥类型 → new Function 跑真身。
 *
 * 切片必须一直吃到**语句结束的 `;`**：只配平大括号的话，
 * `setMap((m) => {…})` 这种以 `);` 收尾的会缺右括号，
 * 报 "missing ) after argument list" —— 而报错指向 new Function 内部，
 * 看不出是切片的问题。
 */
function sliceStmt(s, anchor, from = 0) {
  const i = s.indexOf(anchor, from);
  if (i === -1) throw new Error('锚点未命中: ' + anchor);
  const j = s.indexOf('{', i);
  if (j === -1) throw new Error('锚点后无 { : ' + anchor);
  let d = 0, end = -1;
  for (let k = j; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) { end = k; break; } }
  }
  if (end === -1) throw new Error('大括号未配平: ' + anchor);
  let tail = end + 1;
  while (tail < s.length && /[\s)]/.test(s[tail])) tail++;
  if (s[tail] === ';') tail++;
  return s.slice(i, tail);
}

/** 从 LinkPanel 里抓一个闭包函数跑真身 */
function grab(anchor, name, deps) {
  const body = stripTS(sliceStmt(lp, anchor));
  return new Function(...Object.keys(deps), `${body}; return ${name};`)(...Object.values(deps));
}

console.log('\n=== 1. agentEnabled / findEnableKey：查键不敏感（跑真身）===');
{
  // config 里存的是旧大小写，显示名是预设原名
  const map = { '.Claude': false };
  t('旧大小写的键能查到', findEnableKey(map, '.claude') === '.Claude', String(findEnableKey(map, '.claude')));
  t('读到的是用户写的那个值', agentEnabled(map, '.claude') === false, String(agentEnabled(map, '.claude')));
  t('大小写完全相同时照常命中', agentEnabled(map, '.Claude') === false);
  t('两端空白不影响判定', agentEnabled({ ' .claude ': false }, '.claude') === false);
  t('查不到的名字仍按「缺失=启用」', agentEnabled(map, '.cursor') === true);
  t('空表一律启用', agentEnabled({}, '.claude') === true);
  /* 反面证据：不能退化回精确查 —— 精确查在这里会读不到而按启用处理，
     于是"用户关掉了、界面却显示启用"，正是 #354 要治的那一类。 */
  t('不是精确查（精确查会误判为启用）', map['.claude'] === undefined && agentEnabled(map, '.claude') === false);
}

console.log('\n=== 2. setAllEnabled：更新旧键而不是新增一条 ===');
{
  const map = { '.Claude': false };
  const off = setAllEnabled(['.claude'], map, false);
  t('不新增不同大小写的键', Object.keys(off).length === 1, JSON.stringify(off));
  t('更新的是原来那条', off['.Claude'] === false, JSON.stringify(off));
  t('没有显示名那条孤儿键', off['.claude'] === undefined);

  const on = setAllEnabled(['.claude'], map, true);
  t('全选同样写回旧键', on['.Claude'] === true && Object.keys(on).length === 1, JSON.stringify(on));

  // 正常情况（键写法一致）必须照常工作，不能因为改判据就写错
  const plain = setAllEnabled(['.a', '.b'], {}, false);
  t('正常键照常写入', plain['.a'] === false && plain['.b'] === false, JSON.stringify(plain));
}

console.log('\n=== 3. allEnabled / invertEnabled ===');
{
  t('旧大小写关掉时不算全启用', allEnabled(['.claude'], { '.Claude': false }) === false);
  t('旧大小写开着时算全启用', allEnabled(['.claude'], { '.Claude': true }) === true);
  t('空名字列表不算全启用（保持原语义）', allEnabled([], {}) === false);

  const inv = invertEnabled(['.claude'], { '.Claude': false });
  t('反选翻转的是旧键那条', inv['.Claude'] === true, JSON.stringify(inv));
  t('反选不产生第二条键', Object.keys(inv).length === 1, JSON.stringify(inv));
  // 缺失=启用 → 反选后应为关闭；写成新键也必须是 false
  const inv2 = invertEnabled(['.cursor'], { '.Claude': false });
  t('缺失项反选后为关闭', inv2['.cursor'] === false, JSON.stringify(inv2));
}

console.log('\n=== 4. LinkPanel.toggle：绝不留下两条键（跑真身）===');
{
  /* 两条键并存是最危险的：后端不敏感 find 取第一个匹配，
     而 HashMap 迭代顺序不确定 → 同一个操作结果随机。 */
  /* 必须吃到语句末尾的 `);`：toggle 是 `const toggle = (n) => setMap((m) => {...});`
     只配平大括号会在内层 `}` 就收尾 → "missing ) after argument list"。 */
  const SRC = stripTS(sliceStmt(lp, 'const toggle = (n: string) => setMap('));
  const build = (out) => new Function(
    'setMap', 'findEnableKey',
    `${SRC}; return toggle;`,
  )((u) => { out.v = u(out.m); return out.v; }, findEnableKey);

  const a = { m: { '.Claude': false }, v: null };
  build(a)('.claude');
  t('点击后键仍只有一条', Object.keys(a.v).length === 1, JSON.stringify(a.v));
  t('写的是原来那条键', a.v['.Claude'] === true, JSON.stringify(a.v));
  t('没有产生显示名那条', a.v['.claude'] === undefined, JSON.stringify(a.v));

  // 正常情况（键不存在）照常新增，且「缺失=启用」→ 点一下变关闭
  const b = { m: {}, v: null };
  build(b)('.claude');
  t('键不存在时新增显示名那条', b.v['.claude'] === false, JSON.stringify(b.v));
}

console.log('\n=== 5. LinkPanel.migrate：改名时备注 / 厂商迁键（跑真身）===');
{
  const migrate = new Function('sameName',
    `${stripTS(sliceFn(lp, 'const migrate = (src: Record<string, string>, from: string, to: string) => {'))}; return migrate;`,
  )(sameName);
  t('旧大小写能迁走', migrate({ '.Claude': 'x' }, '.claude', '.my')['.my'] === 'x',
    JSON.stringify(migrate({ '.Claude': 'x' }, '.claude', '.my')));
  t('迁移后旧键被删', migrate({ '.Claude': 'x' }, '.claude', '.my')['.Claude'] === undefined);
  t('旧键不存在时不动（不能凭空造值）',
    JSON.stringify(migrate({}, '.claude', '.my')) === '{}');
  t('名字没变时不动', JSON.stringify(migrate({ '.a': '1' }, '.a', '.a')) === JSON.stringify({ '.a': '1' }),
    JSON.stringify(migrate({ '.a': '1' }, '.a', '.a')));
  // 仅大小写不同也属「名字没变」：不能把值删掉重新造
  t('仅大小写不同时不迁（值保留）',
    JSON.stringify(migrate({ '.a': '1' }, '.A', '.a')) === JSON.stringify({ '.a': '1' }),
    JSON.stringify(migrate({ '.a': '1' }, '.A', '.a')));
}

console.log('\n=== 6. rename 里的 setMap：开关随名字迁移（跑真身）===');
{
  /* 这段的锚点不能用注释里的字样 —— 上面 stripDoc 已经把注释剥掉了，
     锚点落空会让整段切片静默跑到文件末尾（本轮第一版就栽在这）。
     取的是**第二处** setMap((m)，第一处是 toggle。 */
  const i1 = lp.indexOf('setMap((m) => {');
  const anchor2 = lp.indexOf('setMap((m) => {', i1 + 1);
  if (anchor2 === -1) throw new Error('找不到第二处 setMap((m)');
  // 同样要吃到 `);`：这段是 `setMap((m) => {...});`
  const body = stripTS(sliceStmt(lp, 'setMap((m) => {', i1 + 1));
  /* currentShown / next 是闭包变量，必须一并注入；漏了的话 updater 一跑就
     ReferenceError，而它在 setMap 里被吞成"什么都没改" —— 表现为断言恒假。 */
  const fn = new Function('setMap', 'findEnableKey', 'sameName', 'currentShown', 'next', `${body};`);
  const run = (m, from, to) => {
    let got = null;
    fn((u) => { got = u(m); return got; }, findEnableKey, sameName, from, to);
    return got;
  };

  const got = run({ '.Claude': false }, '.claude', '.my');
  t('改名会迁走开关', got['.my'] === false, JSON.stringify(got));
  t('迁移后旧键被删', got['.Claude'] === undefined, JSON.stringify(got));
  t('没有留下两条键', Object.keys(got).length === 1, JSON.stringify(got));

  // 名字没变（仅大小写不同）时不能把值清掉
  const got2 = run({ '.Claude': false }, '.claude', '.Claude');
  t('仅改大小写时保留原值', got2['.Claude'] === false, JSON.stringify(got2));

  // 旧键不存在时不能凭空造一条
  const got3 = run({}, '.claude', '.my');
  t('旧键不存在时不动', JSON.stringify(got3) === '{}', JSON.stringify(got3));
}

console.log('\n=== 7. 建链弹窗：默认勾选也走不敏感判据 ===');
{
  t('不再用 config.linkAgents?.[n] 精确查', !pd.includes('config.linkAgents?.[n]'),
    pd.includes('config.linkAgents?.[n]') ? '仍在精确查' : '');
  t('改用 agentEnabled', /agentEnabled\(config\.linkAgents/.test(pd));
  t('import 了 agentEnabled', /import \{ agentEnabled \} from '\.\.\/utils\/linkAgents'/.test(pdRaw));
}

console.log('\n=== 8. 后端 junction.rs：enabled_names 不敏感 ===');
{
  const j = fs.readFileSync(path.join(RS, 'junction.rs'), 'utf8');
  const jd = stripDoc(j);
  t('新增了 agent_enabled 帮手', /fn agent_enabled\(cfg: &FpxConfig, name: &str\) -> bool/.test(jd));
  t('用 eq_ignore_ascii_case 查键', /k\.trim\(\)\.eq_ignore_ascii_case\(want\)/.test(jd));
  /* 定义那行 `fn agent_enabled(cfg…` 也会被 /agent_enabled\(cfg/ 命中，
     必须排除，否则要写成 ===3 —— 那样再加一处合法调用反而会误报。 */
  const calls = (jd.match(/(?<!fn )agent_enabled\(cfg/g) || []).length;
  t('两处都改用了它', calls >= 2, String(calls));
  t('不再有 link_agents.get( 精确查', !jd.includes('link_agents.get('),
    jd.includes('link_agents.get(') ? '仍有精确查' : '');
  t('缺失仍视为开启（unwrap_or(true)）', /unwrap_or\(true\)/.test(jd));
}

console.log('\n=== 9. 兜底扫描：全仓不得再有精确查开关的写法 ===');
{
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (/\.(ts|tsx|rs)$/.test(e.name)) files.push(p);
    }
  };
  walk(PG);
  walk(RS);
  const pats = [
    /linkAgents\s*\[\s*['"`]?\w/,      // 前端：map[name]
    /linkAgents\?\.\[/,                 // 前端：config.linkAgents?.[n]
    /link_agents\.get\(/,               // 后端：HashMap::get
  ];
  const bad = [];
  for (const f of files) {
    if (f.endsWith('link-switch-ci-test.mjs')) continue;
    const s = stripDoc(fs.readFileSync(f, 'utf8'));
    for (const p of pats) if (p.test(s)) bad.push(`${path.relative(PG, f)}  ${p}`);
  }
  t('没有残留的精确查开关写法', bad.length === 0, bad.join(' | '));
}

done();
