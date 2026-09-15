#!/usr/bin/env node
/**
 * 跨端一致性校验
 * ------------------------------------------------------------------
 * 检查 Rust 后端与前端 TS 之间的契约是否漂移：
 *
 *   1. 命令存在性    定义的命令都注册了吗？前端调用的命令都存在吗？
 *   2. 参数名一致性  前端传的参数名 == Rust 函数参数名（含 camelCase↔snake_case）
 *   3. 必填/可选     前端必传的参数，Rust 是不是 Option（可选）？
 *   4. DTO 字段      model.rs 结构体字段 == types.ts interface 字段
 *
 * 用法：node cross-end-check.mjs            # 检查并报告
 *       node cross-end-check.mjs --strict   # 有错时退出码 1（CI 用）
 *
 * 为什么需要它：这些契约散落在四个文件里（mod.rs / main.rs / api.ts / types.ts），
 * 加命令时漏改任何一处，都要到运行时才暴露，且报错信息往往指向错误的方向。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src-tauri/src');
const PLUGIN = join(ROOT, 'plugins/project-group');

/** Tauri 注入参数：不是前端传的，比对时排除 */
const INJECTED = new Set(['app', 'state']);

/** 结构体命名映射：Rust 名 -> TS 名（改名过，不是错误） */
const STRUCT_ALIAS = {
  ChainActionItem: 'ChainAction',        // TS 侧叫 ChainAction
  AutoStatus: 'BackupAutoStatus',        // backup.rs 里的 AutoStatus
};

/** Rust 内部结构体：不暴露给前端，跳过字段比对 */
const INTERNAL_ONLY = new Set(['LinkRecord']);

const snakeToCamel = (s) =>
  s.split('_').map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join('');

const problems = [];
const notes = [];

/* ---------------------- 1. 解析 Rust 命令 ---------------------- */

function parseRustCommands() {
  const cmds = {};
  const files = readdirSync(join(SRC, 'fpx'))
    .filter((f) => f.endsWith('.rs'))
    .map((f) => join(SRC, 'fpx', f));

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const re =
      /#\[tauri::command([^\]]*)\]\s*(?:(?:\/\/[^\n]*\n|#\[[^\]]*\]\n)\s*)*pub (?:async )?fn (\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const [, attr, name, params] = m;
      // rename_all = "snake_case" 时，TS 侧的 camelCase 会被转成 snake_case
      const rename = /rename_all\s*=\s*"(\w+)"/.exec(attr)?.[1] ?? null;

      const list = [];
      for (const raw of params.split(',')) {
        const p = raw.trim();
        if (!p) continue;
        const pm = /^(\w+)\s*:\s*(.+)$/.exec(p);
        if (!pm) continue;
        const [, pname, ptype] = pm;
        if (INJECTED.has(pname)) continue;
        list.push({
          name: pname,
          type: ptype.trim(),
          optional: /^Option\s*</.test(ptype.trim()),
        });
      }
      cmds[name] = {
        file: file.slice(SRC.length + 1),
        line: src.slice(0, m.index).split('\n').length,
        rename,
        params: list,
      };
    }
  }
  return cmds;
}

/* ---------------------- 2. 解析 main.rs 注册 ---------------------- */

function parseRegistered() {
  const src = readFileSync(join(SRC, 'main.rs'), 'utf8');
  const i = src.indexOf('invoke_handler');
  const seg = src.slice(i, i + 5000);
  return new Set([...seg.matchAll(/fpx::(fpx_\w+)/g)].map((m) => m[1]));
}

/* ------------------- 3. 解析前端 api.ts 调用 ------------------- */

/** 解析对象字面量的键名，支持 { a } 简写 / { a: b } / { ...x } */
function parseObjectKeys(body) {
  if (!body) return [];
  const inner = body.trim().replace(/^\{/, '').replace(/\}$/, '');
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  return parts
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      if (k.startsWith('...')) return { name: '...spread', optional: true };
      const m = /^(\w+)\s*:/.exec(k);
      return { name: m ? m[1] : k, optional: false };
    });
}

function parseApiCalls() {
  const src = readFileSync(join(PLUGIN, 'api.ts'), 'utf8');
  const calls = {};
  const re = /call\s*<[^>]*>\s*\(\s*['"]([\w_]+)['"]\s*(?:,\s*(\{[\s\S]*?\}))?\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const [, cmd, args] = m;
    calls[cmd] = parseObjectKeys(args);
  }
  return calls;
}

/* ---------------------- 4. 解析 DTO ---------------------- */

/** 按大括号配对截取结构体内容——不能用 [^}]*，遇到注释里的 } 会提前截断 */
function readBraced(src, openIdx) {
  let depth = 0;
  let j = openIdx;
  while (j < src.length) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  return src.slice(openIdx + 1, j);
}

function parseRustStructs() {
  const out = {};
  for (const file of ['fpx/model.rs', 'fpx/backup.rs', 'fpx/screen.rs',
                      'fpx/chain.rs', 'fpx/watch.rs', 'fpx/editor.rs']) {
    let src;
    try {
      src = readFileSync(join(SRC, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/pub struct (\w+)\s*\{/g)) {
      out[m[1]] = {
        file,
        fields: [...readBraced(src, src.indexOf('{', m.index)).matchAll(
          /pub\s+(\w+)\s*:/g)].map((x) => x[1]),
      };
    }
  }
  return out;
}

function parseTsInterfaces() {
  const src = readFileSync(join(PLUGIN, 'types.ts'), 'utf8');
  const out = {};
  for (const m of src.matchAll(/export interface (\w+)\s*\{/g)) {
    const body = readBraced(src, src.indexOf('{', m.index));
    const fields = [];
    for (let line of body.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('//') || line.startsWith('*') ||
          line.startsWith('/*')) continue;
      const fm = /^(\w+)\??\s*[:(]/.exec(line);
      if (fm) fields.push(fm[1]);
    }
    out[m[1]] = fields;
  }
  return out;
}

/* ---------------------- 执行检查 ---------------------- */

const rustCmds = parseRustCommands();
const registered = parseRegistered();
const apiCalls = parseApiCalls();
const rustStructs = parseRustStructs();
const tsIfaces = parseTsInterfaces();

console.log('═══ 跨端一致性校验 ═══\n');
console.log(`Rust 命令 ${Object.keys(rustCmds).length} · 注册 ${registered.size} · 前端调用 ${Object.keys(apiCalls).length}`);
console.log(`Rust DTO ${Object.keys(rustStructs).length} · TS interface ${Object.keys(tsIfaces).length}\n`);

// --- 检查 1：定义 vs 注册 ---
for (const name of Object.keys(rustCmds)) {
  if (!registered.has(name)) {
    problems.push(`[注册缺失] ${name} 已定义但没写进 main.rs invoke_handler`);
  }
}
for (const name of registered) {
  if (!rustCmds[name]) {
    problems.push(`[定义缺失] ${name} 已注册但找不到 #[tauri::command] 定义`);
  }
}

// --- 检查 2：前端调用 vs Rust 定义 ---
for (const [cmd, args] of Object.entries(apiCalls)) {
  if (!cmd.startsWith('fpx_')) continue;    // 外壳命令（如 set_window_icon）跳过
  const def = rustCmds[cmd];
  if (!def) {
    problems.push(`[孤儿调用] 前端调用了 ${cmd}，Rust 侧没有这个命令`);
    continue;
  }

  // 参数名一致性：Rust 侧按 rename_all 映射后再比
  const rustNames = new Set(def.params.map((p) =>
    def.rename === 'camelCase' ? snakeToCamel(p.name) : p.name));
  const tsNames = args.map((a) => a.name);

  for (const n of tsNames) {
    if (n === '...spread') continue;
    if (!rustNames.has(n)) {
      problems.push(
        `[参数名不符] ${cmd}: 前端传「${n}」，Rust 参数 [${[...rustNames].join(', ')}]`);
    }
  }
  for (const n of rustNames) {
    const p = def.params.find((x) =>
      (def.rename === 'camelCase' ? snakeToCamel(x.name) : x.name) === n);
    if (!p) continue;
    if (!p.optional && !tsNames.includes(n)) {
      problems.push(
        `[必传参数缺失] ${cmd}: Rust 的「${n}」不是 Option，但前端没传（${def.file}:${def.line}）`);
    }
  }
}

// --- 检查 3：DTO 字段一致性 ---
for (const [rName, rInfo] of Object.entries(rustStructs)) {
  if (INTERNAL_ONLY.has(rName)) continue;
  const tName = STRUCT_ALIAS[rName] ?? rName;
  const tFields = tsIfaces[tName];
  if (!tFields) {
    notes.push(`[DTO 未镜像] Rust ${rName} 在 types.ts 里没有对应 interface（可能不暴露给前端）`);
    continue;
  }
  const rCamel = new Set(rInfo.fields.map(snakeToCamel));
  const tSet = new Set(tFields);
  const onlyRust = [...rCamel].filter((f) => !tSet.has(f));
  const onlyTs = [...tSet].filter((f) => !rCamel.has(f));
  if (onlyRust.length) {
    problems.push(`[DTO 字段缺失] ${tName}: Rust 有但 TS 无 → ${onlyRust.join(', ')}（${rInfo.file}）`);
  }
  if (onlyTs.length) {
    problems.push(`[DTO 字段多余] ${tName}: TS 有但 Rust 无 → ${onlyTs.join(', ')}`);
  }
}

/* ---------------------- 输出 ---------------------- */

if (problems.length === 0) {
  console.log('✅ 全部一致：命令注册、参数名、必填性、DTO 字段均无漂移\n');
} else {
  console.log(`❌ 发现 ${problems.length} 处不一致：\n`);
  for (const p of problems) console.log('  ' + p);
  console.log('');
}
if (notes.length) {
  console.log('提示（非错误）：');
  for (const n of notes) console.log('  · ' + n);
  console.log('');
}

if (process.argv.includes('--strict') && problems.length) process.exit(1);
