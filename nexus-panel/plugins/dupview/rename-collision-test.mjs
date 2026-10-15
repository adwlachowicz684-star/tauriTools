/**
 * 守卫：改名撞名时**自动退让到 `_2` `_3`**，而不是报错或跳过。
 *
 * 【它要钉住的行为】
 * 这个插件整天在处理成批的重复卷子 —— 撞名是常态，不是异常。
 * 一批里第 3 份副本本来就该叫 `xxx_3.pdf`；报一句"目标文件名已存在"让用户
 * 自己去想名字，等于把本该自动做的事推回给人。
 *
 * 【三个不能退让的点】
 *  ① 后缀加在扩展名之前（`a.pdf` → `a_2.pdf`，不是 `a.pdf_2`）；
 *  ② 已经带后缀的接着往上数（`a_3.pdf` → `a_4.pdf`，不是 `a_3_2.pdf`）；
 *  ③ **预览与执行必须同源** —— 消解放在两者共用的 `plan_actions` 里，
 *     否则会变成"预览说改成 A、执行落成了 A_2"，用户按预览核对时完全对不上。
 *
 * 断言按源码字面钉，不跑运行时。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, '../../src-tauri/src/dupview/rename.rs'), 'utf8');
const ms = readFileSync(join(here, '../../src-tauri/src/dupview/mod.rs'), 'utf8');
const html = readFileSync(join(here, 'index.html'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, why) => {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${why ? ' —— ' + why : ''}`);
  }
};

/* ---- 1. 后缀工具 ---- */
ok('存在 with_copy_suffix', /pub fn with_copy_suffix/.test(rs));
/* 用字面串而非正则：这里要匹配的是 Rust 的 `format!("{}_{}{}", …)`，
   花括号在正则里得逐个转义，写错一次就是假红（本次踩到）。 */
ok(
  '后缀加在扩展名之前',
  rs.includes('format!("{}_{}{}", stem, n, ext)'),
  '必须形如 {stem}_{n}{ext}，写成 a.pdf_2 就不是同一个文件类型了',
);
{
  const i = rs.indexOf('pub fn with_copy_suffix');
  const body = i < 0 ? '' : rs.slice(i, i + 400);
  ok(
    '先过 base_of 再编号（不叠加已有后缀）',
    body.includes('let base = base_of(name);') && body.includes('split_ext(&base)'),
    '直接拼会叠成 a_3_2.pdf',
  );
}

/* ---- 2. 单文件改名：不再硬报错 ---- */
{
  const i = ms.indexOf('pub fn dupview_rename(');
  const body = i < 0 ? '' : ms.slice(i, i + 4000);
  ok('dupview_rename 存在', body.length > 0);
  ok(
    '不再返回"目标文件名已存在"',
    !/return err\("目标文件名已存在"\)/.test(body),
    '撞名应当自动退让，而不是让用户自己改名',
  );
  ok(
    '撞名时循环找可用的 _N',
    /loop \{[\s\S]{0,300}with_copy_suffix/.test(body),
  );
  ok(
    '有后缀上限，不会无限撑大文件名',
    /n > 999/.test(body),
  );
}

/* ---- 3. 批量改名：消解必须在预览与执行共用的地方 ---- */
{
  ok('存在 dedup_targets', /fn dedup_targets/.test(ms));
  const i = ms.indexOf('fn plan_actions');
  const body = i < 0 ? '' : ms.slice(i, i + 2500);
  ok(
    'plan_actions 末尾调用 dedup_targets',
    /dedup_targets\(&mut out\)/.test(body),
    '放在执行分支里会导致预览与执行不一致',
  );
  const j = ms.indexOf('fn dedup_targets');
  const dd = j < 0 ? '' : ms.slice(j, j + 1800);
  ok(
    '既看磁盘占用，也看本轮已分配',
    /cand\.exists\(\)/.test(dd) && /used\.contains/.test(dd),
    '只看磁盘会在批内撞车；只看本轮会覆盖磁盘上已有的卷子',
  );
  ok(
    '参与本轮改名的旧名不算占用（它们会被先挪走）',
    /old_keys/.test(dd) && /!old_keys\.contains/.test(dd),
  );
}

/* ---- 4. 前端要说出实际落地的名字 ---- */
ok(
  '撞名自动改名时提示里带真实文件名',
  /j\.newname===nn[\s\S]{0,120}自动改为/.test(html),
  '不提示的话用户会以为自己输的名字生效了，然后在目录里找不到',
);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
