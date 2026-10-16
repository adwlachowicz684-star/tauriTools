/**
 * 设置页：「说了要提醒、其实没显示」与「读不出来当成什么都没装」
 * ====================================================================
 * 本轮修的三处，共同形状是**状态算出来了，界面上却看不到**：
 *
 *   ① 更新通道：localStorage 写不进去时 `setNote(...)` 确实被调到了，
 *      但 JSX 里**从来没有 `{note}`** —— 这段保护等于整个没生效。
 *      用户看到的仍是"下拉切过去了、只字未提"，下次启动悄悄回到正式版。
 *      【这是上一轮我自己推出去的半成品：文件与远端一致，说明"已改完"
 *      这个说法不成立 —— 本轮第 1/2 节专门钉它。】
 *   ② 依赖：读已装列表失败时 `r.error` 被丢掉、`setInstalled([])` 照旧执行 →
 *      已装区连同「移除」「整包卸载」整段消失，界面在暗示"你装的东西被删了"。
 *   ③ 同上：读失败**不能清空** installed —— 空列表与"没读到"在界面上
 *      完全无法区分，旧数据再旧也比空列表诚实。
 *
 * 第 5 节另加**全量守卫**：任何 `const [x, setX] = useState(...)`，只要 setX
 * 被调到过、而 x 在全文里**从未被读取**，就是死状态 —— ① 正是这个形状
 * （有 setNote、没人读 note）。让它在别处再犯一次时当场红出来。
 *
 * 为什么是"抽出来真跑"而不是查源码里有没有那几个字：
 *   源码里有 `setNote(...)` 证明不了它排在 catch 里（① 就是证明：有，但没渲染）；
 *   源码里有 `setRtErr` 证明不了读失败时它真会被调到。
 *
 * 运行：node settings-persist-note-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* 剥注释判据只留 test-scan-utils.mjs 一份：各测试内联一份会各改各的，
   一边认得出、一边认不出，体检单上就只有一半可信。 */
import { stripComments } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPDCARD = path.join(HERE, 'plugins/settings/UpdateCard.tsx');
const DEPSCARD = path.join(HERE, 'plugins/settings/DepsCard.tsx');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/*
 * 崩溃必须显式失败。脚本崩在半路会把后面的断言全吃掉，报告上看着像
 * "只红了几条"，其实后面的证据一条都没跑（本项目反复栽在这一条上）。
 */
process.on('unhandledRejection', (e) => {
  fail++;
  console.log(`❌ 出现未处理的 Promise 拒绝 → ${e?.message || e}`);
});

/* ---------------- 括号配平切片 ----------------
 * 用 indexOf('}') 或 `[\s\S]*?` 取函数体会**在内层 if 的右括号处截断** ——
 * 切片看着拿到了，其实只剩半截，后面的断言全成了"验了个空壳"。
 */
function sliceBalanced(src, startMark, label) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error(`抽取失败（找不到起点）：${label}`);
  const open = src.indexOf('{', i);
  if (open < 0) throw new Error(`抽取失败（起点后没有 {）：${label}`);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`抽取失败（括号不配平）：${label}`);
}

/** 剥掉挡着 JS 解析的类型标注（机械剥，不手抄 —— 手抄会与源文件漂移）。 */
const stripTs = (s) => s
  .replace(/\(v: string\)/g, '(v)')
  .replace(/\(e: any\)/g, '(e)')
  .replace(/useState<[^>]*>/g, 'useState')
  .replace(/as any\[\]/g, '')
  .replace(/as Record<string, any>/g, '')
  .replace(/\(u: any\)/g, '(u)')
  .replace(/: Record<string, any>/g, '')
  .replace(/: any\[\]/g, '');


const read = (p) => fs.readFileSync(p, 'utf8');

/* ============================================================
   第 1 节：saveChannel 跑真身 —— 存不下必须 setNote
   ============================================================ */
console.log('\n— 第 1 节：更新通道存不下时，note 必须被算出来 —');
{
  const src = read(UPDCARD);
  const body = stripTs(sliceBalanced(src, 'const saveChannel = (v: string) => {', 'saveChannel'));

  const run = (v, storageImpl) => {
    const calls = { note: [], channel: [], result: 0, installed: 0, err: 0 };
    const fn = new Function(
      'v', 'localStorage', 'CHANNEL_KEY', 'setNote', 'setChannel', 'setResult', 'setInstalled', 'setErr',
      `${body}\nreturn saveChannel(v);`,
    );
    fn(
      v, { setItem: storageImpl }, 'nexus.updater.channel',
      (s) => calls.note.push(s),
      (s) => calls.channel.push(s),
      () => calls.result++,
      () => calls.installed++,
      () => calls.err++,
    );
    return calls;
  };

  const ok = run('beta', () => {});
  t('存得下时不提醒', ok.note.length === 1 && ok.note[0] === '', `note=${JSON.stringify(ok.note)}`);
  t('存得下时通道照常切换', ok.channel[0] === 'beta', `channel=${JSON.stringify(ok.channel)}`);

  const bad = run('beta', () => { throw new Error('denied'); });
  t('存不下时 setNote 被调到 ★', bad.note.length === 1 && bad.note[0].length > 0, `note=${JSON.stringify(bad.note[0])}`);
  t('提醒文案说清"没能记住"', /没能记住/.test(bad.note[0] || ''), bad.note[0]);
  t('提醒文案说清下次会回到正式版', /下次启动会回到/.test(bad.note[0] || ''), bad.note[0]);
  t('存不下时**不回滚**下拉（这次是真生效了）★', bad.channel[0] === 'beta', `channel=${JSON.stringify(bad.channel)}`);
  t('存不下时也要清掉旧结果（否则显示"正式版已是最新"）', bad.result === 1 && bad.err === 1);
}

/* ============================================================
   第 2 节：note 必须在 JSX 里真的画出来（上一轮的半成品就栽在这）
   ============================================================ */
console.log('\n— 第 2 节：note 真的被渲染出来（不是只改状态）—');
{
  const code = stripComments(read(UPDCARD));
  t('JSX 里出现 {note ★', /\{note\s*\?/.test(code), code.match(/\{note[^}]{0,20}/)?.[0] || '（没有）');
  t('note 用警告色而不是危险色（这次切换当场生效了，标红会让人再点一次）',
    /\{note\s*\?[\s\S]{0,300}?var\(--warn/.test(code));
  t('setNote 与 {note} 配对存在（有设置就得有渲染）', /setNote\(/.test(code) && /\{note\b/.test(code));
}

/* ============================================================
   第 3 节：DepsCard 读失败 —— 说原因、且不清空已装列表
   ============================================================ */
console.log('\n— 第 3 节：依赖读不出来时，不能当成"什么都没装" —');
{
  const src = read(DEPSCARD);
  const sliced = sliceBalanced(src, 'const refresh = useCallback(async () => {', 'refresh');
  const arrow = stripTs(
    sliced
      .replace(/^const\s+refresh\s*=\s*useCallback\(/, '')
      .replace(/,\s*\[ctx\]\s*\)\s*;?\s*$/, ''),
  );

  const run = async (listResult) => {
    const calls = { rtErr: [], rtMissing: [], installed: [], usage: 0 };
    const make = new Function(
      'ctx', 'listRuntimeDeps', 'depUsageSnapshot', 'setRtMissing', 'setRtErr', 'setInstalled', 'setUsage',
      `return (${arrow});`,
    );
    const fn = make(
      {}, () => listResult, () => [],
      (v) => calls.rtMissing.push(v),
      (v) => calls.rtErr.push(v),
      (v) => calls.installed.push(v),
      () => calls.usage++,
    );
    await fn();
    return calls;
  };

  const ok = await run({ missing: false, list: [{ name: 'mermaid', version: '12.0.0' }] });
  t('读成功时不报错', ok.rtErr[0] === '' && ok.installed.length === 1, `rtErr=${JSON.stringify(ok.rtErr)}`);

  const bad = await run({ missing: false, list: [], error: '读取目录失败：权限不足' });
  t('读失败时 setRtErr 带上原因 ★', bad.rtErr[0] === '读取目录失败：权限不足', `rtErr=${JSON.stringify(bad.rtErr)}`);
  t('读失败时**不清空** installed（空列表与没读到无法区分）★', bad.installed.length === 0, `installed 被写 ${bad.installed.length} 次`);
  t('读失败不等同于"后端没接这个能力"', bad.rtMissing[0] === false, `rtMissing=${JSON.stringify(bad.rtMissing)}`);

  const miss = await run({ missing: true, list: [] });
  t('后端未接入时走 rtMissing 而不是 rtErr', miss.rtMissing[0] === true && miss.rtErr[0] === '');
}

/* ============================================================
   第 4 节：rtErr 必须真的画出来，且说清"没显示 ≠ 被删了"
   ============================================================ */
console.log('\n— 第 4 节：读失败的提示真的渲染出来 —');
{
  const code = stripComments(read(DEPSCARD));
  t('JSX 里出现 {rtErr ★', /\{rtErr\s*\?/.test(code), code.match(/\{rtErr[^}]{0,20}/)?.[0] || '（没有）');
  t('提示必须说清"不等于它们被删了" ★', /不等于它们被删了/.test(code));
  t('提示带上具体原因（不能只说"读取失败"）', /\{rtErr\}/.test(code));
  t('提示用警告色', /\{rtErr\s*\?[\s\S]{0,400}?var\(--warn/.test(code));
}

/* ============================================================
   第 5 节：全量守卫 —— 状态设了值却从没被读过（死状态）
   ============================================================ */
console.log('\n— 第 5 节：全量守卫（设了值却没人读的死状态）—');
{
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'runtime-plugins' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx$/.test(e.name)) files.push(p);
    }
  };
  walk(HERE);

  const bad = [];
  for (const f of files) {
    const raw = read(f);
    if (!/useState/.test(raw)) continue;
    const code = stripComments(raw);
    const re = /const\s+\[\s*([A-Za-z_$][\w$]*)\s*,\s*(set[A-Za-z_$][\w$]*)\s*\]\s*=\s*useState/g;
    let m;
    while ((m = re.exec(code))) {
      const [, name, setter] = m;
      /*
       * 只在"确实用过 setter"时才要求有人读：纯初始值不写不算问题。
       *
       * **不能只认 `setter(` 这种直接调用**：`onSubtitle: setSubtitle` 是把
       * setter 当回调传出去，宿主会在挂载时调它 —— 那正是"值被写进来"的
       * 那条路。按 `setter(` 判会让这一类整批溜走（本项目已经溜了一处）。
       * 声明那一行本身算 1 次，所以"只出现过一次"= 真没用过。
       */
      const setterUses = (code.match(new RegExp(`\\b${setter}\\b`, 'g')) || []).length;
      if (setterUses <= 1) continue;
      /*
       * 豁免**强制重渲染计数器**这类写法：`setTick((t) => t + 1)`。
       * 它的值本来就不必有人读，作用只是触发一次重渲染。
       * 不禁这一条的话，守卫会报假红，而"让红消失"最省事的做法是
       * 把 `const refresh = () => setTick(...)` 删掉 —— 那才是真把功能删了。
       */
      if (new RegExp(`\\b${setter}\\(\\s*\\(?\\s*\\w+\\s*\\)?\\s*=>`).test(code)) continue;
      /*
       * 只数"**值位置**"的出现，且**不含声明行**。
       *
       * 不能按"标识符出现次数"判：`subtitle={…}` 里的 subtitle 是 JSX 的
       * **prop 名**，不是读取 —— 宿主上报的 subtitle 正是这样被判成"有人读"
       * 而溜过去的（React 版外壳把它存进 state 后从不显示，插件栏另算一份）。
       * 所以后面紧跟 `={` / `:` / `=` 的一律不算（那是赋值位），
       * `{subtitle}`、`subtitle.trim()`、`[subtitle]` 这类才算真读取。
       */
      const decl = new RegExp(
        `const\\s*\\[\\s*${name}\\s*,[^\\]]*\\]\\s*=\\s*useState[^\\n]*`,
      );
      const body = code.replace(decl, '');
      /*
       * `=` 只排除**单独那个赋值等号**：`tabOver === i` 里的 `===` 以 `=`
       * 开头，按 `[:=]` 一律排除会把最常见的比较判成"没人读"（13 条假红）。
       */
      const uses = (
        body.match(new RegExp(`\\b${name}\\b(?!\\s*=\\s*\\{)(?!\\s*=(?!=))(?!\\s*:)`, 'g')) || []
      ).length;
      if (uses === 0) bad.push(`${path.relative(HERE, f)} → ${name}（${setter} 调过，没人读）`);
    }
  }
  t('没有"设了值却没人读"的死状态 ★', bad.length === 0, bad.length ? bad.join('；') : '全部配对');
  t('守卫确实扫到了文件（不是空跑）', files.length > 50, `扫了 ${files.length} 个 tsx`);
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
