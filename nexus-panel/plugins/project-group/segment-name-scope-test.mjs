/**
 * 页签名（层级名）的两套判据 —— 零依赖
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/segment-name-scope-test.mjs
 *
 * 同一个字段（**页签名**）被两条路各校验一次，而判据不是同一份：
 *
 *   新建（sys::resolve_new_target）  → sys::validate_name
 *   迁移（cli::safe_segment）        → 自己写的四行（空白 / `.` `..` / 控制符 / 分隔符）
 *
 * 两套规则对不上，后果在两个方向都有：
 *
 *   ① 页签名 `CON` / `NUL`
 *      迁移**放行** → 真去建 `root\CON` → Windows 上 CreateDirectory 失败，
 *      报「失败：无法创建目标目录 拒绝访问」—— 一个看着很正常的页签名
 *      配上一句指向不明的错，用户只会以为磁盘或权限出了问题。
 *
 *   ② 页签名带控制符 / 末位是句点 / 超长
 *      新建被拒、迁移却放行，同一个页签两条路结论相反：
 *      "能建不能迁"，或者迁过去之后配置里的名字与磁盘上的不一致。
 *
 * 更麻烦的是**报错指向不了真正的原因**（本套件主要守的一条）：
 * `resolve_new_target` 里项目名与页签名走同一套校验、都报「名称不能包含 …」，
 * 而用户在新建框里敲的是**项目名**。页签名里带 `/` 是很自然的写法
 * （「前端/后端」「2024/Q1」），于是他反复改自己刚敲的项目名，
 * 改十次还是同一句报错 —— 而页签名从来没被怀疑过。
 *
 * 这里守：
 *   · 判据只有**一份**（safe_segment 不再自己写规则）
 *   · 页签名那条报错写明**是页签名**并带上它的值
 *   · 项目名那条仍报"名称"（两条要能区分，不能都写成"页签名"）
 *   · 长度按**字符**判（不是字节），保留设备名清单与 utils 侧同源
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';
import { stripCommentsJs as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const read = (p) => strip(fs.readFileSync(path.join(HERE, p), 'utf8'));
const sys = read('../../src-tauri/src/fpx/sys.rs');
const cli = read('../../src-tauri/src/fpx/cli.rs');

/** 取一段代码：从锚点起按大括号配平切出函数体 */
function blockAfter(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open, k + 1); }
  }
  return '';
}

/* ---------------- 1. 判据只有一份 ---------------- */
console.log('\n=== 1. 页签名判据收敛到唯一实现 ===');
const segFn = blockAfter(cli, 'pub fn safe_segment');
{
  /*
   * 切片自检：锚点必须真的落在 safe_segment 上，否则后面全是空跑。
   * 不能拿"含 validate_name_as"当自检 —— 那条正是要验的断言本身，
   * 恒真就等于没自检。改成"没越过下一个函数"，切飞了一定不成立。
   */
  t('锚点命中 safe_segment（切片自检）',
    segFn.includes('.ok()') && !segFn.includes('fn ') && segFn.length < 400, segFn.slice(0, 120));

  t('safe_segment 走 sys::validate_name_as', /super::sys::validate_name_as\(/.test(segFn));
  /*
   * 关键的一条：不再自己写规则。
   * 只判"有调 validate_name_as"是不够的 —— 完全可以调了又自己再判一遍。
   */
  t('safe_segment 内不再自带 matches! 字符表 ★', !/matches!\(/.test(segFn), segFn.slice(0, 200));
  t('safe_segment 内不再自带 is_control 判定', !/is_control\(\)/.test(segFn));
  t('safe_segment 内不再自带 "." / ".." 判定', !/==\s*"\.\."/.test(segFn));
}

/* ---------------- 2. 报错要能区分是哪一个名字 ---------------- */
console.log('\n=== 2. 报错指向真正的拦路者（项目名 / 页签名）===');
const rnt = blockAfter(sys, 'pub fn resolve_new_target');
{
  t('锚点命中 resolve_new_target（切片自检）',
    rnt.includes('hierarchy') && rnt.includes('quick_roots'), rnt.slice(0, 80));

  /* 项目名仍用"名称"，页签名用带值的"页签名「X」" —— 两条必须不同 */
  t('项目名走 validate_name（报"名称"）', /let name = validate_name\(name\)\?;/.test(rnt));
  t('页签名走 validate_name_as 且带上页签名本身 ★',
    /validate_name_as\(h,\s*&format!\("页签名「\{h\}」"\)\)\?/.test(rnt), rnt.slice(0, 400));
  /* 页签名仍要真的拼进路径（不能因为改了校验方式就忘了拼） */
  t('页签名拼进目标路径', /target = target\.join\(h\);/.test(rnt));
  t('项目名拼在页签名之后', /target = target\.join\(&name\);/.test(rnt));
}

/* ---------------- 3. 判据跑真身：字符集与保留名清单取自源码 ---------------- */
console.log('\n=== 3. 判据跑真身（字符集 / 保留名清单从源码取出后执行）===');
const vfn = blockAfter(sys, 'pub fn validate_name_as');
{
  t('锚点命中 validate_name_as（切片自检）',
    vfn.includes('what') && vfn.includes('is_empty()'), vfn.slice(0, 120));

  /* 非法字符集：从源码里的 matches!(c, ...) 原样取出，不手写 */
  const mm = vfn.match(/matches!\(c,\s*([\s\S]*?)\)\)/);
  t('取到非法字符表', !!mm, mm ? mm[1] : '(未取到)');
  /*
   * 不能按 `|` 切：`'|'` 本身就是分隔符之一，一切就碎成空串（本轮踩到）。
   * 按「单引号包起来的一个字符（可带反斜杠转义）」逐个取。
   */
  const bad = mm ? [...mm[1].matchAll(/'(\\?.)'/g)].map((m) => m[1].replace('\\\\', '\\')) : [];
  t('字符表含 9 个（\\ / : * ? " < > |）', bad.length === 9, `实际 ${bad.length}: ${JSON.stringify(bad)}`);
  t('字符表含 /', bad.includes('/'));
  t('字符表含 \\', bad.includes('\\'));
  t('字符表不含 _（skill 层级靠 _ 拆分，另有独立校验）', !bad.includes('_'));

  /* 保留名清单：同样从源码取，不手写（手写会与后端漂移） */
  const rm = sys.match(/const RESERVED:\s*\[&str;\s*\d+\]\s*=\s*\[([\s\S]*?)\];/);
  t('取到 RESERVED 清单', !!rm);
  const reserved = rm ? [...rm[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  t('RESERVED 与声明条数一致', reserved.length === 24, `实际 ${reserved.length}`);
  t('含 CON / NUL / COM1 / LPT9',
    ['CON', 'NUL', 'COM1', 'LPT9'].every((x) => reserved.includes(x)));
  /* COM0 / LPT0 不在表内：现代 Windows 上合法，加进去等于砍掉可用名 */
  t('不含 COM0 / LPT0（现代 Windows 合法）',
    !reserved.includes('COM0') && !reserved.includes('LPT0'));

  /* 用取出来的字符集与清单，跑一遍 is_reserved_name 的判据形状 */
  const isReserved = (name) => {
    const stem = name.split('.')[0].trim();
    if (stem === '') return false;
    return reserved.includes(stem.toUpperCase());
  };
  t('CON 判保留', isReserved('CON') === true);
  t('con 判保留（大小写不敏感）', isReserved('con') === true);
  t('CON.txt 判保留（扩展名不算数）', isReserved('CON.txt') === true);
  /* 误伤比漏判更糟：这些是极常用名，绝不能按前缀判 */
  t('config 不判保留', isReserved('config') === false);
  t('console 不判保留', isReserved('console') === false);
  t('auxiliary 不判保留', isReserved('auxiliary') === false);
  t('.CON 不判保留（主名为空，同 .gitignore）', isReserved('.CON') === false);

  /* 页签名里带 / 是最自然的写法，必须拒（这是本轮的主要场景） */
  const hits = (s) => [...s].some((c) => bad.includes(c));
  t('「前端/后端」命中非法字符 ★', hits('前端/后端') === true);
  t('「2024\\Q1」命中非法字符', hits('2024\\Q1') === true);
  t('「A:B」命中非法字符', hits('A:B') === true);
  t('普通中文页签名不命中', hits('进行中') === false);
  t('「前端-后端」不命中', hits('前端-后端') === false);
}

/* ---------------- 4. 规则项齐全（不是只留了字符表） ---------------- */
console.log('\n=== 4. 七条规则齐全，且都按字符判 ===');
{
  t('空 / 纯空白', /name\.is_empty\(\)/.test(vfn));
  t('控制符 ★（原先只有迁移那条路查）', /name\.chars\(\)\.any\(\|c\|\s*c\.is_control\(\)\)/.test(vfn));
  t('非法字符', /name\.chars\(\)\.any\(\|c\|\s*matches!\(/.test(vfn));
  t('"." / ".." / 纯点串', /name == "\." \|\| name == "\.\." \|\| name\.trim_matches\('\.'\)\.is_empty\(\)/.test(vfn));
  t('末位句点', /name\.ends_with\('\.'\)/.test(vfn));
  t('长度按**字符**数（不是 .len() 字节数）★',
    /name\.chars\(\)\.count\(\) > 120/.test(vfn) && !/\.len\(\) > 120/.test(vfn));
  t('保留设备名', /is_reserved_name\(name\)/.test(vfn));

  /* 每条报错都必须带上 what —— 否则又变回"不知是哪个名字" */
  const msgs = (vfn.match(/\{what\}/g) || []).length;
  t('七条报错全部带 {what}', msgs >= 7, `实际 ${msgs}`);
  /* 注释里也写着 {what}，所以必须**剥注释后**才数得准（本套件已剥） */
}

/* ---------------- 5. 迁移那处的跳过原因带页签名本身 ---------------- */
console.log('\n=== 5. 迁移跳过原因带页签名本身（不是干巴巴一句"不合法"）===');
{
  const mig = cli;
  t('跳过原因里带页签名', /跳过：页签名「\{\}」含非法字符/.test(mig), '(看 cli.rs migrate)');
  /* 页签名不合法时该页签**整体**不搬，且要说明，不能静默 continue */
  t('该页签整体不搬有说明（不是静默略过）',
    /该页签整体不搬/.test(mig));
}

/* ---------------- 6. 前端侧：与后端同源的那份仍一致 ---------------- */
console.log('\n=== 6. 前端保留名清单与后端同源 ===');
{
  const la = await loadTs(path.join(HERE, 'utils/linkAgents.ts'));
  const f = la.isReservedWinName;
  t('前端 isReservedWinName 可加载真身', typeof f === 'function');
  t('CON 判保留', f('CON') === true);
  t('config 不判保留（不许按前缀判）', f('config') === false);
  t('COM0 不判保留', f('COM0') === false);
}

done();
