/**
 * 目录选择器「列不出来」时的界面一致性 测试
 * ============================================================
 * 场景：用户在地址栏敲了一个打不开的路径（盘符不存在 / 没权限 /
 *       不在授权根里），点进去失败。
 *
 * 修复前的界面是一组互相矛盾的东西：
 *   · 地址栏显示用户刚敲的那条（input 是他自己 onChange 敲进去的）
 *   · 列表却还是**上一个目录**的内容
 *   · 底下只有一行红字
 * 此时点「选择此文件夹」，交出去的是**上一个目录** —— 搬家会搬到他
 * 根本没打算去的地方、添加卡片会添加错目录，而界面从头到尾没有任何
 * 一处说明"你选的不是地址栏那个"。
 *
 * 四类断言：
 *   ① 失败必须清空 path 与 entries（行为，真跑 catch 段）
 *   ② 刻意保留 input（清空等于把用户刚敲的路径也抹了，他改一下就能重试）
 *   ③ 「选择此文件夹」的禁用判据是 !path —— 这是清空能真正挡住误选的
 *      唯一依据，光清空而按钮仍可点等于没修
 *   ④ 对照：agent-flow/DirPicker 与本插件同判据（cwd/picked 分离，本轮同步）
 *
 * 运行：node dir-dialog-fail-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripCommentsJs } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok, why) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${why ? ` —— ${why}` : ''}`); }
}

const dlg = read('plugins/project-group/components/DirDialog.tsx');
const picker = read('plugins/agent-flow/components/DirPicker.tsx');

/**
 * 从 `start` 处开始按花括号配平切出一段。
 *
 * 【为什么不能按行数或按 `}` 就近切】
 * catch 段里含模板字符串与箭头函数，就近切会切在嵌套的 `}` 上，
 * 拿到半截代码 —— 而半截代码 new Function 要么崩（吃掉后面所有断言），
 * 要么恰好是合法的一段别的代码，于是**验的是别的函数**。
 */
function sliceBalanced(src, startIdx, openCh = '{') {
  const closeCh = openCh === '{' ? '}' : ')';
  let depth = 0;
  for (let k = startIdx; k < src.length; k++) {
    if (src[k] === openCh) depth++;
    else if (src[k] === closeCh) {
      depth--;
      if (depth === 0) return src.slice(startIdx + 1, k);
    }
  }
  return '';
}

/* ================================================================ */
/* 一、切出 load 的 catch 段（真身）                                 */
/* ================================================================ */
console.log('\n【一】切片自检（切不出来就直接报红，不允许静默空跑）');

const loadIdx = dlg.indexOf('const load = useCallback(async (p: string) => {');
t('找得到 load 的定义', loadIdx >= 0, '锚点变了就要改这里，否则后面全是空跑');

const catchAnchor = '} catch (e: any) {';
const catchIdx = dlg.indexOf(catchAnchor, loadIdx);
/*
 * `loadIdx` 是这条断言的**空跑端**：它取 -1 时 `catchIdx > -1` 恒真
 * （indexOf 的起点参数传 -1 等于从头找），断言照样绿、次序根本没验。
 * 所以这里**自己**判一次存在，不靠上面那条 `找得到 load 的定义` 兜 ——
 * 上面那条哪天被删了，这里就退化成恒真。
 */
t('找得到 load 的 catch', loadIdx >= 0 && catchIdx > loadIdx, 'catch 段必须存在');

const catchBody = catchIdx > 0 ? sliceBalanced(dlg, dlg.indexOf('{', catchIdx)) : '';
t('catch 段切出来了（非空）', catchBody.length > 0, '切片失败会让后面全部空跑');
t('catch 段自检：确实含 err/path/entries 三处赋值',
  /setErr\(/.test(catchBody) && /setPath\(/.test(catchBody) && /setEntries\(/.test(catchBody),
  '切到别处去了会在这里暴露');

/* ================================================================ */
/* 二、行为：失败后的最终状态（真跑）                                */
/* ================================================================ */
console.log('\n【二】失败后的状态（catch 段原样执行）');

/*
 * 用 recorder 代替 setState。
 * 注意：React 的 setState 是**合并**语义，这里只关心"最后被设成了什么"，
 * 所以直接记最后一次调用值即可 —— 与 useFpx 那套替身是同一个口径。
 */
function runCatch(body, { seqCurrent = 7, seq = 7, msg = '打不开' } = {}) {
  const calls = { err: [], path: [], entries: [], input: [] };
  const mk = (k) => (v) => calls[k].push(v);
  const loadSeq = { current: seqCurrent };
  const fn = new Function(
    'loadSeq', 'seq', 'e', 'setErr', 'setPath', 'setEntries', 'setInput',
    `const String_ = String;\n${body}`,
  );
  fn(loadSeq, seq, { message: msg }, mk('err'), mk('path'), mk('entries'), mk('input'));
  return { calls, last: (k) => (calls[k].length ? calls[k][calls[k].length - 1] : undefined) };
}

const r = runCatch(catchBody);

t('失败时 setPath 被调到（这是挡住误选的关键）', r.calls.path.length > 0);
t('失败后 path 为空串（不再是上一个目录）', r.last('path') === '',
  `实际 ${JSON.stringify(r.last('path'))}`);
t('失败后 entries 为空数组（列表不再显示上一个目录）',
  Array.isArray(r.last('entries')) && r.last('entries').length === 0,
  `实际 ${JSON.stringify(r.last('entries'))}`);
t('失败时 setErr 被调到（红字仍在）', r.calls.err.length > 0);
t('错误文案带上了后端原因', JSON.stringify(r.last('err') ?? '').includes('打不开'),
  `实际 ${JSON.stringify(r.last('err'))}`);

/*
 * 刻意保留 input：清掉的话，用户刚敲的那条路径也没了，
 * 他只能从头再敲一遍（长路径尤其恼人）。留着改一个字符就能重试。
 */
t('刻意保留 input（未被清空，方便改一下重试）', r.calls.input.length === 0,
  `setInput 被调用了 ${r.calls.input.length} 次`);

/*
 * seq 对不上（用户已经点了别的目录）时必须整体放弃，
 * 不能把一个过期失败写进当前界面。
 */
const stale = runCatch(catchBody, { seqCurrent: 9, seq: 7 });
t('过期响应不写任何状态（seq 对不上直接 return）',
  stale.calls.path.length === 0 && stale.calls.entries.length === 0 && stale.calls.err.length === 0,
  '过期失败写进去会覆盖掉正确的当前目录');

/* ================================================================ */
/* 三、禁用判据：清空 path 必须真的挡住「选择此文件夹」              */
/* ================================================================ */
console.log('\n【三】按钮禁用判据（清空能不能挡住，取决于这一条）');

t('确认按钮 disabled={!path}（path 空即不可点）', /disabled=\{!path\}/.test(dlg),
  '少了它，清空 path 只是让界面看起来空，照样能点出旧目录');
t('新建文件夹按钮同样受 !path 约束', /disabled=\{!newName\.trim\(\) \|\| !path\}/.test(dlg),
  '否则失败后还能在旧目录里建出新文件夹');

/* ================================================================ */
/* 四、成功路径的对照（成功才三者同步）                              */
/* ================================================================ */
console.log('\n【四】成功路径（path / input / entries 三者同步）');

const tryIdx = dlg.indexOf('try {', loadIdx);
const tryBody = tryIdx > 0 ? sliceBalanced(dlg, dlg.indexOf('{', tryIdx)) : '';
t('try 段切出来了（非空）', tryBody.length > 0);
t('成功时 path 与 input 同步为同一个 p',
  /setPath\(p\)/.test(tryBody) && /setInput\(p\)/.test(tryBody),
  '失败清 path、成功同步两者，界面才不会出现"显示的≠要交出去的"');
t('成功时写入 entries', /setEntries\(list\)/.test(tryBody));

/* ================================================================ */
/* 五、快速起点失败（另一条路同样不能假装成功）                      */
/* ================================================================ */
console.log('\n【五】快速起点失败');

const rootIdx = dlg.indexOf('api.quickRoots()');
const rootSeg = rootIdx > 0 ? dlg.slice(rootIdx, rootIdx + 600) : '';
t('quickRoots 失败时清空 roots', /setRoots\(\[\]\)/.test(rootSeg));
t('quickRoots 失败时写 err（否则弹窗一片空白，像是打不开目录）',
  /setErr\(`无法列出快速起点/.test(rootSeg));
t('quickRoots 失败时不调用 load（path 保持空 → 按钮禁用）',
  !/catch[\s\S]{0,200}load\(/.test(rootSeg.slice(rootSeg.indexOf('.catch('))));

/* ================================================================ */
/* 六、对照：agent-flow/DirPicker（本轮已同步修复）                   */
/* ================================================================ */
console.log('\n【六】对照：agent-flow/DirPicker');

/*
 * 这一节原本钉的是「已知偏差·待修」：DirPicker 的 cwd 同时充当输入框的值
 * 与要交出去的路径，失败时只清 entries、cwd 原样保留 → 按钮仍可点，交出去
 * 的是一个**列不出来**的目录。
 *
 * 现已把 cwd 拆成两个状态（cwd = 输入值 / picked = 已打开、要交出去的），
 * 判据与本插件的 DirDialog 一致。跑真身的断言在
 * plugins/agent-flow/dirpicker-picked-test.mjs，这里只做对照，确保两边
 * 不会再次各走各的。
 *
 * 剥注释是必须的：catch 段上方那段说明里写着 setCwd / setPicked 的字样，
 * 不剥会把"注释里提到"当成"代码里做了"。
 */
const pickerC = stripCommentsJs(picker);
const pLoadIdx = pickerC.indexOf('const load = useCallback(async (p: string) => {');
t('找得到 DirPicker 的 load', pLoadIdx >= 0);
/*
 * 空跑端自查：pLoadIdx 取 -1 时 `pCatchIdx > 0` 仍可能为真（等于从头找），
 * 断言看着在跑、次序根本没验。所以这里自己先判一次存在。
 */
const pCatchIdx = pLoadIdx >= 0 ? pickerC.indexOf('} catch (e) {', pLoadIdx) : -1;
t('找得到 DirPicker 的 catch（在 load 之后）', pLoadIdx >= 0 && pCatchIdx > pLoadIdx);
const pCatchBody = pCatchIdx > 0 ? sliceBalanced(pickerC, pickerC.indexOf('{', pCatchIdx)) : '';
t('DirPicker catch 段切出来了', pCatchBody.length > 0);
t('DirPicker 失败时清空 entries', /setEntries\(\[\]\)/.test(pCatchBody));
t('DirPicker 失败时也说清原因（不是静默空列表）', /setErr\(/.test(pCatchBody));
t('DirPicker 失败时清空 picked（与本插件清 path 同一判据）',
  /setPicked\(''\)/.test(pCatchBody),
  '两处判据必须一致：一侧清一侧不清，用户会在两个插件里得到不同结果');
t('DirPicker 保留输入框的值（catch 段不出现 setCwd）',
  !/setCwd\s*\(/.test(pCatchBody));
t('DirPicker 的「选这里」禁用判 !picked（清空才真能挡住误选）',
  /disabled=\{!picked\}/.test(pickerC));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
