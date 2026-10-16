/**
 * typecheck 守卫：让 `npm run typecheck`（tsc --noEmit）真正跑起来
 * ================================================================
 * 起因（2026-10 实测）：
 *   项目里早就有 `npm run typecheck`，但它不以 `test:` 开头 ——
 *   而 sweep（全量体检）**只收 test:* 的 script**。于是这条能一次查出
 *   React 侧编译错误的现成工具，从装好那天起就没人跑过。
 *
 *   第一次真跑，报出 17 条 error TS，其中一条尤其危险：
 *
 *     plugins/project-group/App.tsx(56,15): error TS2367:
 *       This comparison appears to be unintentional because the types
 *       '"added" | "removed" | "changed"' and '"overflow"' have no overlap.
 *
 *   这条 TS2367 是**类型在撒谎**：Rust 侧 `fpx/watch.rs` 的 `pull()`
 *   确实会 push 一条 `kind: "overflow"`（#177，队列截断告警），
 *   而 `WatchEvent.kind` 的联合类型里漏了它。于是那段**正在生效**的
 *   告警分支，在 TS 眼里成了"永远进不去的死代码"。
 *
 *   照着 TS 的提示去"清理死分支"，丢掉的是一条真告警：
 *   把"我们漏报了"重新伪装成"发生了改动"，比不显示更糟。
 *   —— 这正是本项目反复撞的那种坑，只是这次撒谎的是类型，不是断言。
 *
 * 为什么用"错误数 ≤ 基线（只减不增）"而不是"必须为 0"
 * ------------------------------------------------------------
 * 剩下 15 条全在 md 插件（plugins/md/App.tsx 12 条、PlantUMLBlock 2 条、
 * MermaidBlock 1 条），是**别人正在改的插件**里的老问题，本轮不动。
 * 强行要求 0 会当场红 15 条，而红着的东西没人看；
 * 改成只减不增：存量照旧记着，**新增一条就红**，
 * 且修掉一条基线就跟着降 —— 与「内联副本只减不增」同一套做法。
 *
 * 运行：node typecheck-guard-test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readStripped } from './test-scan-fs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` → ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` → ${detail}` : ''}`); }
};

/* 基线 = 本轮实测剩下的 error TS 条数。修掉一条就把这里降一格。 */
const BASELINE = 15;

/* ------------------------------------------------------------------ *
 * 第 1 节：跑 tsc
 * ------------------------------------------------------------------ */
const tscBin = join(HERE, 'node_modules', 'typescript', 'bin', 'tsc');

if (!existsSync(tscBin)) {
  /*
   * 缺 typescript 时**不静默通过**。
   * "守卫自己跑不起来"若算绿，等于把这条从体检单上抹掉 —— 而环境被清
   * 依赖在本项目是常态，正好是最该被看见的时候。所以明确报红并说清装法。
   */
  t('tsc 可执行（缺 typescript 时本守卫无法工作，不算通过）', false,
    `找不到 ${tscBin}，请先按 package.json 的 devDependencies 装 typescript`);
  console.log(`\n❌ 通过 ${pass} / 失败 ${fail}`);
  process.exit(1);
}

const r = spawnSync(process.execPath, [tscBin, '--noEmit'], {
  cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});

/* 「真跑了」和「跑出什么」必须分开报：
 * spawn 本身失败（signal / 无输出且非 0）时，下面那条"错误数"会恒为 0，
 * 守卫反而变绿 —— 又是一个崩了不算红。 */
t('tsc 真的被执行了（拿得到退出码，不是 spawn 失败）',
  r.error == null && typeof r.status === 'number',
  r.error ? String(r.error?.message || r.error) : `exit=${r.status}`);

const out = `${r.stdout || ''}\n${r.stderr || ''}`;
const errors = out.split('\n').filter((l) => /error TS\d+:/.test(l));

/* ------------------------------------------------------------------ *
 * 第 1b 节：依赖不齐时，tsc 的结论整体不可信 —— 先把它挑出来
 * ------------------------------------------------------------------ *
 * 实测：环境被清过一次依赖后（只剩 14 个包），这里报 141 条、
 * "超出基线 126 条"，而那 126 条**全是缺 @xyflow/react 引起的连锁噪声**
 * （TS2307 找不到包 → 类型退化成 any → 一串 TS7006）。
 *
 * 这时最糟的不是红，而是**红的方向**：报告说是"你引入了 126 个新错误"，
 * 而真因是"依赖没装齐"。照着这条去查，会去翻代码，而代码一点没变。
 * —— 与本项目反复撞的「报错要指向真因」是同一条。
 *
 * 所以先判依赖齐不齐。判据只看 TS2307 的模块名：
 *   · 裸包名（不以 `.` 开头）→ 外部依赖缺失，环境噪声
 *   · 相对路径（./ ../）    → **真缺陷**：本地文件不存在或改名了，不能豁免
 * 不能用"node_modules 里有没有这个包"来判：@tauri-apps/cli、jsdom 的
 * 传递依赖（tough-cookie / ws 等）装齐了也会被报缺，噪声更大。
 */
const missingExternal = [...out.matchAll(/error TS2307:.*?Cannot find module '([^']+)'/g)]
  .map((m) => m[1])
  .filter((s) => !s.startsWith('.'));

const envOk = missingExternal.length === 0;

t('依赖齐：tsc 没报「找不到外部包」（缺包时结论含连锁噪声，下面的基线比较会跳过）',
  envOk,
  envOk ? '' : `缺 ${missingExternal.length} 处，如 ${[...new Set(missingExternal)].slice(0, 5).join(' / ')} —— 先按 package.json 装齐，否则本守卫的"超出 N 条"会把你引向代码`);

if (envOk) {
  t(`error TS 条数不超过基线（基线 ${BASELINE}，只减不增）`,
    errors.length <= BASELINE,
    errors.length <= BASELINE
      ? `${errors.length} 条`
      : `${errors.length} 条，超出 ${errors.length - BASELINE} 条：\n${errors.slice(0, 10).join('\n')}`);
} else {
  console.log('   ⚠️  跳过基线比较：依赖不齐，此时的条数里混着连锁噪声，比不出真问题');
}

/* ------------------------------------------------------------------ *
 * 第 2 节：判据没在空转
 * ------------------------------------------------------------------ */
const parse = (s) => s.split('\n').filter((l) => /error TS\d+:/.test(l));

const SAMPLE = [
  "a.tsx(1,1): error TS2367: This comparison appears to be unintentional.",
  "b.tsx(2,3): error TS2345: Argument of type 'x' is not assignable.",
  "no error here",
].join('\n');

t('判据认得出合成样本里的 error TS（不是空转）',
  parse(SAMPLE).length === 2, `解析到 ${parse(SAMPLE).length} 条`);

t('合成样本里判据不会误伤普通输出（不是"永远报错"）',
  parse(SAMPLE).every((l) => /error TS\d+:/.test(l)) && parse('').length === 0);

/* 挑"缺外部包"的判据同样要成对验：
 *   ① 认得出裸包名（否则缺依赖时照样去做基线比较，又回到 141 条的红）
 *   ② 不误伤相对路径（相对路径的 TS2307 是真缺陷：本地文件没了）
 * 少了 ②，判据写成"见 TS2307 就当环境噪声"也能过 —— 那会把
 *「import 了一个已经改名的本地模块」整类真错误静默吞掉。 */
const MISS_SAMPLE = [
  "a.tsx(6,41): error TS2307: Cannot find module '@xyflow/react' or its corresponding type declarations.",
  "b.tsx(2,3): error TS2307: Cannot find module './components/Foo' or its corresponding type declarations.",
].join('\n');

const pickMissing = (s) => [...s.matchAll(/error TS2307:.*?Cannot find module '([^']+)'/g)]
  .map((m) => m[1])
  .filter((x) => !x.startsWith('.'));

t('缺包判据认得出裸包名（合成样本）',
  pickMissing(MISS_SAMPLE).length === 1
  && pickMissing(MISS_SAMPLE)[0] === '@xyflow/react',
  JSON.stringify(pickMissing(MISS_SAMPLE)));

t('缺包判据不误伤相对路径（那是真缺陷，不是环境噪声）',
  !pickMissing(MISS_SAMPLE).includes('./components/Foo'));

/* ------------------------------------------------------------------ *
 * 第 3 节：把这一轮修掉的两处钉住（各配"样本仍在"，成对才不作废）
 * ------------------------------------------------------------------ */

/* ① overflow：类型里必须有，Rust 侧必须还在发 —— 少一头就是空守 */
const TYPES_TS = join(HERE, 'plugins/project-group/types.ts');
const WATCH_RS = join(HERE, 'src-tauri/src/fpx/watch.rs');

/*
 * 两个源码判据都走 readStripped（剥注释）—— 这不是洁癖：
 * 第一版没剥，`WatchEvent.kind` 那条在**抽掉 overflow 之后照样绿**。
 * 因为写注释时举了 `ev.kind === 'overflow'` 这个例子，正则从注释里的
 * `kind: "overflow"` 一路跨到那个单引号样本（`[^;]*` 中间没有分号挡着），
 * 断言匹配的是**我自己写的说明文字**，不是真正的类型声明。
 * 又是一次「断言查存在性、不查那一处存在」，这次栽在刚写的守卫里。
 */
const typesSrc = existsSync(TYPES_TS) ? readStripped(TYPES_TS) : '';
const watchSrc = existsSync(WATCH_RS) ? readFileSync(WATCH_RS, 'utf8') : '';

const kindBlock = typesSrc.match(
  /interface\s+WatchEvent\s*\{[\s\S]*?\}/,
)?.[0] ?? '';

t('WatchEvent.kind 含 overflow（漏了会让正在生效的截断告警分支被当成死代码）',
  /kind\s*:\s*[^;]*'overflow'/.test(kindBlock),
  kindBlock ? '' : 'plugins/project-group/types.ts 里找不到 WatchEvent');

t('样本仍在：Rust 侧确实在发 kind "overflow"（否则上一条是空守）',
  /kind:\s*"overflow"/.test(watchSrc),
  watchSrc ? '' : 'src-tauri/src/fpx/watch.rs 不见了');

/* ② 快捷键表里不许有"没人调"的动作。
 *
 * 守的是**意图**（表里每条都得真被绑走），不是"不许出现 readMarkdown"
 * —— 后者是钉写法：哪天真把「阅读」做成可绑键位的动作，它就会误报红。 */
const PG_APP = join(HERE, 'plugins/project-group/App.tsx');
const HOOK = join(HERE, 'plugins/project-group/hooks/useCardHotkeys.ts');

const appSrc = existsSync(PG_APP) ? readStripped(PG_APP) : '';
const hookSrc = existsSync(HOOK) ? readStripped(HOOK) : '';

/* hook 里真正被调用的动作名：run(...) 内部一律 `ref.current.X(` */
const invoked = new Set(
  [...hookSrc.matchAll(/ref\.current\.(\w+)\s*\(/g)].map((m) => m[1]),
);

/* App.tsx 传给 useCardHotkeys 的那张表的键：
 * 从 `}, !!boot &&` 这一截（表结束）往前取到 `useCardHotkeys(` 之后 */
const callIdx = appSrc.indexOf('useCardHotkeys(');
const tail = callIdx >= 0 ? appSrc.slice(callIdx) : '';
const tableEnd = tail.indexOf('}, !!boot');
const table = tableEnd >= 0 ? tail.slice(0, tableEnd + 1) : '';

/* 键形如 `openMarkdown,` 或 `focus: setFocus,`；跳过纯注释行 */
const keys = [...table.matchAll(/^\s{4}([A-Za-z_]\w*)\s*(?::|,)/gm)]
  .map((m) => m[1])
  .filter((k) => !['const', 'return', 'if'].includes(k));

const dead = keys.filter((k) => !invoked.has(k));

t('快捷键表里没有"没人调"的动作（有就是死条目：TS2353 会先红，这里钉住意图）',
  keys.length > 0 && dead.length === 0,
  dead.length ? `死条目：${dead.join(' / ')}` : `核对 ${keys.length} 条`);

t('样本仍在：hook 里确实解析到了被调用的动作名（不是空集导致的恒真）',
  invoked.size >= 5, `invoked=${invoked.size}`);

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
