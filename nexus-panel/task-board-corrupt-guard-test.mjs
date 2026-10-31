/**
 * task-board 清单文件损坏守卫：tasks.json
 * ============================================================
 * 运行：node task-board-corrupt-guard-test.mjs
 *
 * 背景：tasks.json 被手改坏 / 写一半中断时，危险的不是"读不出来"，
 * 而是**读不出来却当成空清单继续走完写回**，于是原文件被整份覆盖：
 *
 *   readStore → 拿到坏 JSON
 *   parse     → 解不出来就退成空清单 ← 这里
 *   mutate    → 基于"空"改，写回 → **整份覆盖**
 *
 * 而损坏的 JSON 往往手改几行就能救回来，一盖就永远没了。
 * 更糟的是界面上会写「暂无任务」——**这是一句假话**，
 * 用户照着"空的"去添加第一条，正好触发上面那条覆盖链。
 *
 * 所以"能不能解析"必须在**读**这一层就抛错：
 *   - 抛错 → mutate 根本到不了写盘，原文件一个字节都不动
 *   - 绝不退化成空清单
 *
 * 本测试跑真身：从 lib/store.ts 切出 parseStoreText / mutate 的真函数体，
 * transpile 掉类型标注后注入桩**实跑**，不是"看源码里有没有那几个字"。
 *
 * （前身是为 agent-flow 的同名任务板写的；那套已撤，这里改测 task-board。）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const STORE_TS = path.join(here, 'plugins/task-board/lib/store.ts');

let pass = 0;
let fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

const src = fs.readFileSync(STORE_TS, 'utf8');

/* 切出一个完整的函数体（括号配平） */
function extractFn(s, sig) {
  const i = s.indexOf(sig);
  if (i < 0) return null;
  let depth = 0;
  let started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') { depth++; started = true; }
    else if (s[j] === '}') { depth--; if (started && depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}

/*
  ⛔ 必须 `module: ESNext`（或 None 之外的值）：默认 CommonJS 的话，
  transpile 产物里会带 `Object.defineProperty(exports, "__esModule", …)`，
  而下面是用 `new Function` 在 ESM 作用域里 eval 的 ——
  exports 未定义，脚本直接崩，**一条断言都跑不到**。
  另外切出来的是 `export async function mutate`，export 关键字也要去掉。
*/
const strip = (code) => ts.transpileModule(code.replace(/^export\s+/m, ''), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;

const PS_SRC = extractFn(src, 'function parseStoreText(');
const MU_SRC = extractFn(src, 'export async function mutate(');

t('（前置）切得到 parseStoreText 真身', !!PS_SRC);
t('（前置）切得到 mutate 真身', !!MU_SRC);

if (PS_SRC && MU_SRC) {
  const C = await import('./plugins/task-board/core.mjs');

  /*
    mutate 内部用的是同文件里的 parseStoreText 与 normalizeStore。
    放在同一个 Function 作用域里，让它们互为真实依赖 ——
    不是另行实现一份（另写一份就变成"测我写的替身"，没意义）。
  */
  const factory = new Function('normalizeStore', `${strip(PS_SRC)}\n${strip(MU_SRC)}\nreturn { parseStoreText, mutate };`);
  const { parseStoreText, mutate } = factory(C.normalizeStore);

  /* ---------------- 1. 判据本身 ---------------- */
  const BAD = '{"tasks":[{"id":"a",';   // 写一半被中断
  t('好 JSON 能解析', (() => { try { return !!parseStoreText('{"tasks":[]}'); } catch { return false; } })());
  t('坏 JSON 抛错（不是返回空/null）', (() => {
    try { const r = parseStoreText(BAD); return r === undefined ? '返回了 undefined' : `返回了 ${JSON.stringify(r)}`; }
    catch { return true; }
  })() === true);
  t('BOM 能剥掉', (() => { try { return !!parseStoreText('﻿{"tasks":[]}'); } catch { return false; } })());
  t('纯垃圾抛错', (() => { try { parseStoreText('不是 json'); return false; } catch { return true; } })());

  /*
    抛出的错误要带中文说明 —— 裸 SyntaxError 没人看得懂，
    而空看板会让人以为任务丢了（症状与成因对不上最难查）。
  */
  t('错误信息是中文可读的（不是裸 SyntaxError）', (() => {
    try { parseStoreText(BAD); return false; }
    catch (e) { return /解析失败/.test(String(e.message)); }
  })());

  /* ---------------- 2. 核心契约：坏了不能写盘 ---------------- */
  const mkCtx = (text, log) => ({
    invoke: async (cmd, args) => {
      log.push(cmd);
      if (cmd === 'tb_read_store') return text;
      if (cmd === 'tb_write_store') { log.push('WROTE'); return undefined; }
      return null;
    },
  });

  const good = JSON.stringify({ v: 1, nextId: 2, tasks: [{ id: 'tb-0001', title: 'x', status: 'todo' }] });

  /* 好文件：应该正常写 */
  {
    const log = [];
    await mutate(mkCtx(good, log), '/d', (st) => ({ ...st, tasks: [...st.tasks] }));
    t('好 JSON：正常写盘', log.includes('tb_write_store'));
  }

  /* 坏文件：一个字节都不能写 */
  {
    const log = [];
    let threw = false;
    try {
      await mutate(mkCtx(BAD, log), '/d', (st) => st);
    } catch { threw = true; }
    t('坏 JSON：mutate 抛错', threw);
    t('坏 JSON：**不写盘**（原文件保持不动）', !log.includes('tb_write_store'), `log=${log.join(',')}`);
  }

  /* 空文件不算损坏：第一次用本来就是空的，不该拦住首次写入 */
  {
    const log = [];
    let threw = false;
    try {
      await mutate(mkCtx('', log), '/d', (st) => st);
    } catch { threw = true; }
    t('空文件不算损坏（首次写入不被拦）', !threw && log.includes('tb_write_store'));
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
