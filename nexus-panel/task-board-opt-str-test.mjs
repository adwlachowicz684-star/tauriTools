#!/usr/bin/env node
/**
 * 任务看板 AI 通道：可选标量字段「空串 = 没给」的判据只能存在一份。
 *
 * 上游 2ab5f2e443a5 修的是 create/patch 六个消费点：
 *   create {"priority":""}  → 原来报「非法优先级 」，AI 反复改值重试
 *   create {"status":""}    → 原来报「新建任务只允许 status=todo（收到 ）」
 *   patch  {"priority":""}  → 校验段报错；只修校验段，写盘循环照样落 ""
 *   patch  {"reporter":""}  → 已有 reporter 被清成 ""
 * 修法是把判据收成 opt_str() 一份。但这笔提交只改了 task_board.rs，
 * regression-guard 第 22 节虽然读这个文件，却只比状态清单与流转图 ——
 * 也就是说：谁把某个消费点改回 str_field()，AI 那四类症状立刻回来，
 * 而几百套测试没有一套会红。这里补的就是这道守卫。
 *
 * 判据一律先剥注释：源码注释里大量写着 opt_str / str_field 与旧写法，
 * 不剥的话「注释里的调用」会把断言喂饱（本项目已多次栽在这上面）。
 * 剥注释用共用模块 test-scan-utils.mjs，不另写内联副本。
 *
 * 用法：node task-board-opt-str-test.mjs（cwd 无关）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RS = join(HERE, 'src-tauri/src/task_board.rs');
const raw = readFileSync(RS, 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, evidence) => {
  if (ok) { pass++; console.log('  ✅ ' + name + (evidence ? '  · ' + evidence : '')); }
  else { fail++; console.log('  ❌ ' + name + (evidence ? '  · ' + evidence : '')); }
};

const LOOP_HEAD = 'for key in ["title", "detail", "summary", "priority", "reporter"]';

/** 同一套判据：既可跑真源码，也可跑合成样本做反向验证。 */
function probe(input) {
  const src = stripCommentsFlatJs(input);
  const bad = [];

  const ci = src.indexOf('fn create_task');
  const pi = src.indexOf('fn patch_task');
  if (ci < 0 || pi < 0 || pi <= ci) {
    // 定位失败绝不能当成「没找到就算通过」——那样整节空转还报绿。
    bad.push('定位失败：create_task / patch_task 段落没找到');
    return bad;
  }
  const create = src.slice(ci, pi);
  const patch = src.slice(pi);

  // ① 判据本体：opt_str 只有一份定义，函数体就是唯一那句 filter
  if ((src.match(/fn\s+opt_str\s*\(/g) || []).length !== 1) {
    bad.push('opt_str 定义不是唯一一份');
  }
  if (!/fn\s+opt_str\s*\([^)]*\)\s*->\s*Option<String>\s*\{\s*str_field\(body,\s*key\)\.filter\(\|v\|\s*!v\.is_empty\(\)\)\s*\}/.test(src)) {
    bad.push('opt_str 函数体不再是唯一的空串判据');
  }

  // ② 全文件调用点恰好六个（提交说明里的 create/patch 六个消费点）
  const all = [...src.matchAll(/opt_str\(body,\s*"([a-z]+)"\)/g)].map(m => m[1]);
  const keyCalls = (src.match(/opt_str\(body,\s*key\)/g) || []).length;
  const want = { priority: 2, status: 2, reporter: 1 };
  for (const [k, n] of Object.entries(want)) {
    if (all.filter(x => x === k).length !== n) {
      bad.push(`opt_str(body,"${k}") 应有 ${n} 处，实际 ${all.filter(x => x === k).length}`);
    }
  }
  if (keyCalls !== 1) bad.push(`opt_str(body,key) 应有 1 处，实际 ${keyCalls}`);

  // ③ create 段三个字段全部走 opt_str，且不许再出现内联 filter / 裸取值
  for (const k of ['priority', 'status', 'reporter']) {
    if (!new RegExp(`opt_str\\(body,\\s*"${k}"\\)`).test(create)) {
      bad.push(`create 的 ${k} 未走 opt_str`);
    }
  }
  if (/\.filter\(\|v\|\s*!v\.is_empty\(\)\)/.test(create)) {
    bad.push('create 段仍有内联空串 filter（第二份判据）');
  }
  if (/str_field\(body,\s*"(priority|status|reporter)"\)/.test(create)) {
    bad.push('create 段仍有裸 str_field 取枚举/身份字段');
  }

  // ④ patch 写盘循环：走同一份判据，不再手写 is_empty + 字段名单
  const li = patch.indexOf(LOOP_HEAD);
  if (li < 0) {
    bad.push('patch 写盘循环定位失败');
  } else {
    const arrAt = patch.indexOf('if let Some(arr) = body.get(key)', li);
    const loop = arrAt > li ? patch.slice(li, arrAt) : patch.slice(li, li + 1500);
    if (!/opt_str\(body,\s*key\)/.test(loop)) bad.push('写盘循环未走 opt_str 同一份判据');
    if (/next\.is_empty\(\)/.test(loop)) bad.push('写盘循环仍有内联空串判据');
    if (!/if key == "priority" \|\| key == "reporter"/.test(loop)) {
      bad.push('写盘循环未限定枚举/身份字段名单');
    }
    if (!/let v = match v_opt/.test(loop)) bad.push('写盘循环未按 Option 取值后 continue');
  }
  // patch 校验段与状态分支
  if (!/if let Some\(v\) = opt_str\(body, "priority"\)/.test(patch)) bad.push('patch 优先级校验未走 opt_str');
  if (!/if let Some\(status\) = opt_str\(body, "status"\)/.test(patch)) bad.push('patch 状态流转未走 opt_str');

  // ⑤ 允许清空的字段不能被「顺手统一」掉：detail / summary / estimate 仍是原判据
  if (!/str_field\(body, "detail"\)\.unwrap_or_default\(\)/.test(create)) bad.push('detail 的空串合法值被误改');
  if (!/str_field\(body, "summary"\)\.unwrap_or_default\(\)/.test(create)) bad.push('summary 的空串合法值被误改');
  if (!/body\.get\("estimate"\)/.test(patch)) bad.push('estimate 分支丢失');
  if (/opt_str\(body, "(detail|summary|estimate)"\)/.test(src)) bad.push('允许清空的字段被错误地当成「没给」');

  return bad;
}

console.log('=== 任务看板：可选标量字段空串判据（create/patch 六消费点共用一份）===');
const real = probe(raw);
t('真源码：六个消费点共用 opt_str 一份判据', real.length === 0,
  real.length ? real.join('；') : '判据 5 组全过');

/* ---- 反向验证：撤掉修复 / 改坏判据，必须被同一套 probe 认出来 ---- */

const cases = [
  ['撤掉 opt_str 定义里的 filter（判据被改松）',
    s => s.replace('str_field(body, key).filter(|v| !v.is_empty())', 'str_field(body, key)'),
    'opt_str 函数体不再是唯一的空串判据'],
  ['create 的 reporter 写回手写 filter（第二份判据）',
    s => s.replace('let reporter = opt_str(body, "reporter")',
      'let reporter = str_field(body, "reporter")\n        .filter(|v| !v.is_empty())'),
    'create 的 reporter 未走 opt_str'],
  ['patch 校验段改回裸 str_field',
    s => s.replace('if let Some(v) = opt_str(body, "priority")',
      'if let Some(v) = str_field(body, "priority")'),
    'patch 优先级校验未走 opt_str'],
  ['写盘循环改回内联 is_empty 判据',
    s => s.replace('let v_opt = if key == "priority" || key == "reporter" {\n                opt_str(body, key)\n            } else {\n                str_field(body, key)\n            };',
      'let v_opt = str_field(body, key);')
      .replace('let next = v.trim();\n            if obj.get(key)',
        'let next = v.trim();\n            if next.is_empty() && (key == "priority" || key == "reporter") { continue; }\n            if obj.get(key)'),
    '写盘循环仍有内联空串判据'],
  ['允许清空的 detail 被顺手改成 opt_str（过度修复）',
    s => s.replace('json!(str_field(body, "detail").unwrap_or_default())',
      'json!(opt_str(body, "detail").unwrap_or_default())'),
    '允许清空的字段被错误地当成「没给」'],
];
for (const [name, mutate, why] of cases) {
  const broken = mutate(raw);
  t('反向验证：' + name, broken !== raw && probe(broken).length > 0,
    broken === raw ? '⛔ 样本没生效（替换未命中），反向验证无效' : why);
}

/* 注释里的同名调用不能把判据喂饱：真调用全删，只在注释里留下六个。 */
const ghost = raw
  .replace(/opt_str\(body,\s*"(priority|status|reporter)"\)/g, 'str_field(body, "$1")')
  .replace(/opt_str\(body,\s*key\)/g, 'str_field(body, key)')
  + '\n/* 旧写法备查：opt_str(body, "priority") opt_str(body, "status") '
  + 'opt_str(body, "reporter") opt_str(body, key) */\n';
t('反向验证：注释里的调用不能喂饱判据（剥注释真生效）',
  probe(ghost).length > 0, '六个真实调用被替换后必须报红');

/* 元断言：probe 不是恒真 / 恒假 */
t('元断言：真源码通过、坏样本报错（probe 非恒真）',
  real.length === 0 && probe(ghost).length > 0, `${real.length} vs ${probe(ghost).length}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
