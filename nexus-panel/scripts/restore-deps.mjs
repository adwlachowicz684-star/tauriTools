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
 * 清掉空包目录 —— 它们会让下一轮 install 也认为「已装」而跳过。
 * 判空不只看空目录：只有 .package-lock.json 之类残骸的同样算。
 */
function pruneEmptyPkgDirs() {
  const nm = join(ROOT, 'node_modules');
  if (!existsSync(nm)) return;
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
  for (const dir of dead) {
    console.log(`清掉空包目录 ${dir.replace(ROOT + '/', '')}（会让 npm 误判已装）`);
    rmSync(dir, { recursive: true, force: true });
  }
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
pruneEmptyPkgDirs();
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
  for (const dir of nested) {
    console.log(`清掉嵌套副本 ${dir.replace(ROOT + '/', '')}（混用会让 md 三套崩）`);
    rmSync(dir, { recursive: true, force: true });
  }
}

const installed = Object.keys(all).length - missing.length;

if (!missing.length) {
  console.log(`依赖齐备：${installed}/${Object.keys(all).length} 个声明包均在位`);
  cleanNestedReact(); // ⛔ 齐了不等于能用：嵌套副本照样让 md 三套崩
  process.exit(0);
}
console.log(`缺失 ${missing.length} 个：` + missing.join(' '));

if (process.argv.includes('--check')) process.exit(1);

// ⛔ 必须**一次性**装：分批会互相剪掉（npm 会把前一批当多余依赖移除）
const specs = missing.map((k) => `${k}@${all[k]}`);
console.log('一次性安装中…');
execFileSync('npm', ['install', ...NPM_FLAGS, '--no-save', ...specs],
  { cwd: ROOT, stdio: 'inherit' });

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
cleanNestedReact();

console.log(still.length ? `仍缺失：${still.join(' ')}` : '✅ 全部就位');
process.exit(still.length ? 1 : 0);
