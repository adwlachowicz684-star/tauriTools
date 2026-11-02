#!/usr/bin/env node
// restore-deps.mjs —— 一次性复建声明依赖（含按声明版本回钉）
//
// 为什么需要：node_modules 是指向 /usr/local/lib/node_modules 的**软链**，
// npm 的树计算会认为已满足，于是 `npm install` 常常「只加 1 个包就报成功」，
// 而实际有 23 个声明包缺失。判断装没装只能逐个查路径（本脚本就是这么做的）。
// 环境被清在本项目里反复发生，每次手工列包名既慢又容易漏。
//
// 用法：node scripts/restore-deps.mjs [--check]
//   --check  只核对并打印缺失，不安装（CI / 体检用）

import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

/**
 * 一个包「在位」= 它的 package.json 真的读得到。
 *
 * ⛔ 不能只判 `existsSync(node_modules/<pkg>)`：
 * 实测（2026-11-02）npm 在慢盘上被中断时会留下**空目录** ——
 * `node_modules/react` 存在、里面一个文件都没有。
 * 于是脚本永远报「依赖齐备」，npm 也认为已装、不会再补，
 * 结果是**永远装不上而没有任何报错**。
 * 而真正暴露它的只有后面 readFileSync(package.json) 那一行的 ENOENT ——
 * 本脚本第一版正是崩在那里，连「仍缺失」都没打印出来。
 */
const pkgJson = (k) => join(ROOT, 'node_modules', k, 'package.json');
const inPlace = (k) => existsSync(pkgJson(k));

/**
 * 删一个目录，失败**不崩**，只记下来。
 *
 * ⛔ 为什么不能让异常往外冒：实测（2026-11-02）`rmSync` 在慢盘上抛
 * `ENOTEMPTY: rmdir .../@chevrotain/cst-dts-gen/lib/src`。
 * 当时脚本直接崩在堆栈里 —— 后果有两层：
 *   1. 后面的 `npm install` **根本没执行**，而屏幕上只有一堆栈，看不出"依赖没装"
 *   2. 那个包被删成残骸（目录在、package.json 没了），下一轮又被判成"已装"
 * 崩溃把这个脚本变成了"看着在跑、其实什么都没做"。删不掉要**说出来**，
 * 让下一轮有机会重试；一声不吭地崩掉才是真正的失效。
 */
function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return existsSync(dir) ? '删不掉' : null;
  } catch (e) {
    return e.code || e.message;
  }
}

/**
 * 把「删不掉的残骸」汇总喊出来，并让退出码非 0。
 * ⛔ 静默吞掉 = 下一轮继续误判「已装」，然后构建崩在一个看起来毫不相干的包上
 *    （实测：rollup 目录被删空 → vite 报 Cannot find module 'rollup/parseAst'，
 *     而屏幕上看不出这两件事有任何关系）。
 */
function reportStuck(list) {
  if (!list.length) return;
  console.log(`\n⚠️ ${list.length} 处残骸没能清掉，需重跑本脚本：`);
  for (const s of list) console.log('   - ' + s);
}

/**
 * 清掉 npm 自己留下的临时目录：`node_modules/.<包名>-<8位随机>`。
 *
 * ⛔ 为什么单独写一条：`pruneEmptyPkgDirs()` 按约定跳过 `.` 开头的条目
 * （要避开 `.bin` / `.package-lock.json`），所以这些残留**永远清不到**。
 * 而它们会挡住下一次安装 —— 实测（2026-11-02）npm 直接崩：
 *   npm error ENOTEMPTY: rename 'node_modules/entities'
 *                     -> 'node_modules/.entities-ntRrCgLY'
 * 屏幕上看是「npm 装不上」，真因是上一轮被杀时留下的临时目录还杵在那儿。
 * 清掉这四个残留后同一条 `npm install` 立刻能跑。
 */
function pruneNpmTemp() {
  const nm = join(ROOT, 'node_modules');
  if (!existsSync(nm)) return 0;
  /*
   * ⛔ 不能只扫顶层：残骸也会长在**作用域包内部**。
   * 实测（2026-11-02）npm 崩的是
   *   npm error ENOTEMPTY: rename 'node_modules/@chevrotain/cst-dts-gen'
   *                     -> 'node_modules/@chevrotain/.cst-dts-gen-DI70if6P'
   * 而这一版当时只在顶层 readdir，所以**一个都没扫到** —— 屏幕上是
   * 「清掉 npm 残留 ×0」紧接着「npm error ENOTEMPTY」，看着像两个无关现象。
   * 同一组目录下躺着 5 个 `.xxx-8位随机`（cst-dts-gen / gast / regexp-to-ast /
   * types / utils），手动清掉 16 个（含其他作用域包）后同一条命令立刻能跑。
   * 注意 pruneEmptyPkgDirs() 早就知道要展开 `@` 前缀（见其 roots 处理），
   * 两处写法不一致就是这次漏掉的根因。
   */
  const dirs = [nm];
  for (const name of readdirSync(nm)) {
    if (name.startsWith('@')) dirs.push(join(nm, name));
  }
  let n = 0;
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const d of entries.filter((x) => /^\..+-[A-Za-z0-9]{8}$/.test(x))) {
      const full = join(dir, d);
      const why = safeRm(full);
      const shown = full.replace(ROOT + '/', '');
      if (why) console.log(`⚠️ npm 残留删不掉 ${shown}（${why}）`);
      else { console.log(`清掉 npm 残留 ${shown}（会挡住下一次 rename）`); n++; }
    }
  }
  return n;
}

/**
 * 清掉空包目录 —— 它们会让下一轮 install 也认为「已装」而跳过。
 * 判空不只看空目录：只有 .package-lock.json 之类残骸的同样算。
 */
function pruneEmptyPkgDirs() {
  const nm = join(ROOT, 'node_modules');
  if (!existsSync(nm)) return { stuck: [], removed: 0 };
  const roots = readdirSync(nm).filter((n) => !n.startsWith('.'));
  const dead = [];
  for (const name of roots) {
    const dirs = name.startsWith('@')
      ? readdirSync(join(nm, name)).map((s) => join(name, s))
      : [name];
    for (const d of dirs) {
      if (!existsSync(join(nm, d, 'package.json'))) dead.push(join(nm, d));
    }
  }
  const stuck = [];
  for (const dir of dead) {
    const why = safeRm(dir);
    if (why) {
      stuck.push(`${dir.replace(ROOT + '/', '')}（${why}）`);
      console.log(`⚠️ 残骸删不掉 ${dir.replace(ROOT + '/', '')}（${why}）—— 需重跑本脚本`);
    } else {
      console.log(`清掉空包目录 ${dir.replace(ROOT + '/', '')}（会让 npm 误判已装）`);
    }
  }
  return { stuck, removed: dead.length - stuck.length };
}

/**
 * ⛔ npm 调用必须带 `--global=false` —— 这是「环境反复被清」的真正根因。
 *
 * 实测（2026-11-02）：`/root/.npmrc` 里有 `global=true`，于是**任何**
 * `npm install` 都以全局模式运行 → 装到 `/usr/local/lib/node_modules`
 * （`npm prefix` 实测 = `/usr/local`，`npm root` = `/usr/local/lib/node_modules`）。
 * 后果有两层：
 *   1. 项目自己的 `node_modules` **永远是空的**（装多少轮都不进项目）
 *   2. `/usr/local/lib` 在容器盘上，502 重启即被清 → 依赖反复消失
 * `npm install` 只打印 notice、不报缺失，所以两层都看不出来。
 */
const NPM_FLAGS = ['--global=false', '--no-audit', '--no-fund'];

const missing = Object.keys(all).filter((k) => !inPlace(k));
/*
 * ⛔ `--check` 必须是**只读**的：本脚本注释里写着「只核对并打印缺失，不安装」，
 * 但清空包目录这一步有副作用 —— 实测（2026-11-02）跑一次 `--check`
 * 就把 delaunator / dompurify / elkjs 等一批间接依赖目录删掉了。
 * 在 CI 里跑只读检查却把依赖删掉，等于「检查」本身制造了故障，
 * 而下一个人只会看到构建崩在一个毫不相干的包上。只读分支跳过这一步。
 */
const CHECK_ONLY = process.argv.includes('--check');
const pruned = CHECK_ONLY
  ? { stuck: [], removed: 0 }
  : (pruneNpmTemp(), pruneEmptyPkgDirs());
const stuck1 = pruned.stuck;
function cleanNestedReact() {
  /*
   * ⛔ 光"装齐"不够：还要清掉 npm 顺手装出来的**嵌套 react 副本**。
   * 实测因果链（这轮完整复现过一次）：
   *   补依赖 → 装出 node_modules/react-markdown/node_modules/react@19.3.1
   *   → 顶层仍是 18.3.1（所以 deps 守卫绿、dup-react 第 1 节也绿）
   *   → 但 md 三套直接崩：
   *     Objects are not valid as a React child (found: object with keys {$$typeof,…})
   *     两份 react 的元素符号不同族，渲染器认不出对方造的元素。
   *   删掉那个嵌套副本 → dup-react 13/0、md-render 30/0 立刻恢复。
   * 也就是说：**依赖"齐了"和"能用"是两回事**，这里必须做掉收尾。
   */
  const nm = join(ROOT, 'node_modules');
  const nested = [];
  for (const scope of readdirSync(nm)) {
    if (scope.startsWith('.')) continue;
    const inner = join(nm, scope, 'node_modules');
    if (!existsSync(inner)) continue;
    for (const name of ['react', 'react-dom']) {
      if (existsSync(join(inner, name))) nested.push(join(nm, scope, 'node_modules', name));
    }
  }
  const stuck = [];
  for (const dir of nested) {
    const why = safeRm(dir);
    if (why) {
      stuck.push(`${dir.replace(ROOT + '/', '')}（${why}）`);
      console.log(`⚠️ 嵌套副本删不掉 ${dir.replace(ROOT + '/', '')}（${why}）—— 需重跑本脚本`);
    } else {
      console.log(`清掉嵌套副本 ${dir.replace(ROOT + '/', '')}（混用会让 md 三套崩）`);
    }
  }
  return stuck;
}

const installed = Object.keys(all).length - missing.length;

if (!missing.length) console.log(`依赖齐备：${installed}/${Object.keys(all).length} 个声明包均在位`);
else console.log(`缺失 ${missing.length} 个：` + missing.join(' '));

if (CHECK_ONLY) process.exit(missing.length || stuck1.length ? 1 : 0);

/*
 * ⛔ 只要清过残骸，就必须走**整树重装**，不能只补 missing 那几个。
 *
 * 实测（2026-11-02）：`node_modules/rollup` 被 npm 中断留成空目录，
 * 于是 vite 报 `Cannot find module 'rollup/parseAst'` —— 而 rollup 是
 * **vite 的间接依赖**，不在 package.json 里，本脚本的 `missing` 列表
 * 根本看不见它：`--check` 报「缺失 4 个」里没有 rollup，屏幕上一片正常，
 * 只有真去构建才会崩，且崩在一个和「依赖没装」毫无字面关系的地方。
 * 只按 specs 装时 npm 会认为 vite 已在位、整棵树已满足 → 不补 rollup。
 * 带 package.json 完整解析的 `npm install` 才会把整棵树补齐。
 */
const needFullInstall = pruned.removed > 0;

if (needFullInstall) {
  console.log(`清掉 ${pruned.removed} 个残骸目录 → 整树重装（间接依赖也要补齐）…`);
  execFileSync('npm', ['install', ...NPM_FLAGS, '--no-save'],
    { cwd: ROOT, stdio: 'inherit' });
} else if (missing.length) {
  // ⛔ 必须**一次性**装：分批会互相剪掉（npm 会把前一批当多余依赖移除）
  const specs = missing.map((k) => `${k}@${all[k]}`);
  console.log('一次性安装中…');
  execFileSync('npm', ['install', ...NPM_FLAGS, '--no-save', ...specs],
    { cwd: ROOT, stdio: 'inherit' });
}

// 回钉 react：npm 会按 ^ 顶到最新大版本，而项目锁的是 18
// （版本漂移守卫会点名，这里先发制人）
for (const [p, want] of Object.entries({ react: pkg.dependencies?.react, 'react-dom': pkg.dependencies?.['react-dom'] })) {
  if (!want) continue;
  // ⛔ 装完仍可能不在（npm 静默跳过 / 留下空目录）；这时报出来，别崩在 readFileSync
  if (!existsSync(pkgJson(p))) {
    console.log(`⚠️ ${p} 安装后仍不在位，跳过回钉（版本号读不到）`);
    continue;
  }
  const got = JSON.parse(readFileSync(pkgJson(p), 'utf8')).version;
  const major = want.replace(/[^\d.]/g, '').split('.')[0];
  if (got.split('.')[0] !== major) {
    console.log(`${p} 被顶到 ${got}，按声明 ${want} 回钉…`);
    execFileSync('npm', ['install', ...NPM_FLAGS, '--no-save', `${p}@${want}`],
      { cwd: ROOT, stdio: 'inherit' });
  }
}
const still = Object.keys(all).filter((k) => !inPlace(k));

// ⛔ 必须放在安装**之后**：npm 装完会顺手在 react-markdown 下再放一份 react，
//    那份副本混进来 md 三套必崩（两份 react 的元素符号不同族）。
//    齐备分支里的那次调用只覆盖「本来就齐」的情况，装过包的情况靠这里。
const stuck2 = cleanNestedReact();

console.log(still.length ? `仍缺失：${still.join(' ')}` : '✅ 全部就位');
reportStuck([...stuck1, ...stuck2]);
process.exit(still.length || stuck1.length + stuck2.length ? 1 : 0);
