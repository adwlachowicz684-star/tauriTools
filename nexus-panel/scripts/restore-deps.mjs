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

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

const missing = Object.keys(all).filter(
  (k) => !existsSync(join(ROOT, 'node_modules', k)));
const installed = Object.keys(all).length - missing.length;

if (!missing.length) {
  console.log(`依赖齐备：${installed}/${Object.keys(all).length} 个声明包均在位`);
  process.exit(0);
}
console.log(`缺失 ${missing.length} 个：` + missing.join(' '));

if (process.argv.includes('--check')) process.exit(1);

// ⛔ 必须**一次性**装：分批会互相剪掉（npm 会把前一批当多余依赖移除）
const specs = missing.map((k) => `${k}@${all[k]}`);
console.log('一次性安装中…');
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--no-save', ...specs],
  { cwd: ROOT, stdio: 'inherit' });

// 回钉 react：npm 会按 ^ 顶到最新大版本，而项目锁的是 18
// （版本漂移守卫会点名，这里先发制人）
for (const [p, want] of Object.entries({ react: pkg.dependencies?.react, 'react-dom': pkg.dependencies?.['react-dom'] })) {
  if (!want) continue;
  const got = JSON.parse(readFileSync(join(ROOT, 'node_modules', p, 'package.json'), 'utf8')).version;
  const major = want.replace(/[^\d.]/g, '').split('.')[0];
  if (got.split('.')[0] !== major) {
    console.log(`${p} 被顶到 ${got}，按声明 ${want} 回钉…`);
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--no-save', `${p}@${want}`],
      { cwd: ROOT, stdio: 'inherit' });
  }
}
const still = Object.keys(all).filter((k) => !existsSync(join(ROOT, 'node_modules', k)));
console.log(still.length ? `仍缺失：${still.join(' ')}` : '✅ 全部就位');
process.exit(still.length ? 1 : 0);
