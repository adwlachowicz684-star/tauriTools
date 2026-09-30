/**
 * Windows 保留设备名（CON / NUL / COM1…）—— 零依赖
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/reserved-name-test.mjs
 *
 * 这些名字在**任何目录、带任何扩展名**都建不出文件/链接：
 * `D:\proj\CON` 会被解析到控制台设备而不是目录。
 * 新建时 CreateDirectory 报"拒绝访问"、建链时只说"mklink 失败"，
 * 两者都不提"这个名字不能用" —— 用户只会以为磁盘或权限出了问题。
 *
 * 判据必须**真跑**：只断言"源码里有 CON 这几个字"证明不了
 * `config` / `console` 这类常用名不会被误拒，而误拒比漏判更糟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';
import { stripCommentsJs as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
/* 剥注释走全仓共用实现（test-scan-utils.mjs） */
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const la = R('utils/linkAgents.ts');
const sys = R('../../src-tauri/src/fpx/sys.rs');
const junc = R('../../src-tauri/src/fpx/junction.rs');

console.log('\n=== 1. 判据真跑（不是"源码里有这几个字"）===');
const mod = await loadTs(path.join(HERE, 'utils/linkAgents.ts'));
{
  const f = mod.isReservedWinName;
  t('判据可加载真身', typeof f === 'function');

  t('CON 判保留', f('CON') === true);
  t('小写 con 同样判保留（Windows 不区分大小写）', f('con') === true);
  t('混合大小写 CoN 判保留', f('CoN') === true);
  t('NUL 判保留', f('NUL') === true);
  t('COM1 判保留', f('COM1') === true);
  t('LPT9 判保留', f('LPT9') === true);

  /* 扩展名不算数：CON.txt 同样是保留的，只比对"第一个点之前"才抓得到 */
  t('CON.txt 判保留（扩展名不算数）', f('CON.txt') === true);
  t('con.md 判保留', f('con.md') === true);

  /* 误伤比漏判更糟：这些是极常用的名字，不能以保留名做前缀判定 */
  t('config 不判保留', f('config') === false);
  t('console 不判保留', f('console') === false);
  t('CONSOLE 不判保留', f('CONSOLE') === false);
  t('content 不判保留', f('content') === false);
  t('command 不判保留', f('command') === false);
  t('auxiliary 不判保留', f('auxiliary') === false);
  t('printer 不判保留', f('printer') === false);

  /* COM0 / LPT0 在现代 Windows 上合法（NT 起不再是保留名） */
  t('COM0 不判保留（现代 Windows 合法）', f('COM0') === false);
  t('LPT0 不判保留', f('LPT0') === false);

  /* `.CON` 的主名为空，与 Windows 实际行为一致（等同 .gitignore） */
  t('.CON 不判保留（主名为空，同 .gitignore）', f('.CON') === false);

  t('空串不判保留', f('') === false);
  t('只有空格不判保留', f('   ') === false);
  t('尾空格的 CON 判保留', f('CON ') === true);
}

console.log('\n=== 2. 链接名入口联动 ===');
{
  const u = mod.usableLinkName;
  t('CON 链接名不可用', u('CON') === false);
  t('NUL 链接名不可用', u('NUL') === false);
  t('COM1 链接名不可用', u('COM1') === false);
  /* 不能因为加了保留名就把正常链接名一起拒了 —— 这才是主要使用场景 */
  t('.cursor 仍可用', u('.cursor') === true);
  t('.opencode 仍可用', u('.opencode') === true);
  t('.claude 仍可用', u('.claude') === true);
  t('agents 仍可用', u('agents') === true);
  t('config 仍可用', u('config') === true);
  /* 原有判据不能被动摇 */
  t('.. 仍不可用', u('..') === false);
  t('含冒号仍不可用', u('a:b') === false);
}

console.log('\n=== 3. 前后端清单逐项一致 ===');
{
  const m = sys.match(/const RESERVED: \[&str; \d+\] = \[([\s\S]*?)\];/);
  t('后端清单能取到', !!m);
  const rust = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const ts = mod.WIN_RESERVED_NAMES;
  t('后端清单非空', rust.length > 0);
  t('数量一致', rust.length === ts.length, `rust=${rust.length} ts=${ts.length}`);
  t('逐项一致（改一处不改另一处会红）', rust.join(',') === ts.join(','));
  /* 核心项必须都在 —— 清单被改短时上面那条也会红，这里给出更直白的定位 */
  for (const n of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
    t(`含 ${n}`, ts.includes(n));
  }
  t('不含 COM0（现代 Windows 合法，误拒等于砍掉可用名）', !ts.includes('COM0'));
}

console.log('\n=== 4. 两处后端入口都真的接上 ===');
{
  /* 剥注释后再判：这些说明里就写着 is_reserved_name 几个字，
     照原文判的话把真实调用删掉、注释留着照样通过（老毛病）。 */
  const vn = sys.slice(sys.indexOf('pub fn validate_name'));
  t('validate_name 真的调用判据', /is_reserved_name\(name\)/.test(vn));
  t('validate_name 里是判保留后 return Err', /if is_reserved_name\(name\) \{\s*return Err/.test(vn));

  const nn = junc.slice(junc.indexOf('pub fn normalize_name'));
  const end = nn.indexOf('\n}');
  const body = nn.slice(0, end);
  t('normalize_name 真的调用判据', /is_reserved_name\(&name\)/.test(body));
  t('normalize_name 里是判保留后返回 None', /is_reserved_name\(&name\) \{ return None; \}/.test(body));
  t('junction 复用 sys 的判据，不另抄一份', /crate::fpx::sys::is_reserved_name/.test(body));

  t('新建名走 validate_name（改名两条入口也共用）',
    sys.includes('pub fn validate_name') && /validate_name\(name\)\?/.test(sys));
}

console.log('\n=== 5. 判据形状：必须完全相等，不能是前缀 ===');
{
  /* 切片必须**到函数体结束**：直接切到文件末尾会带上后面函数里的
     starts_with（`name.starts_with('.')` 之类），于是这条永远为假、
     看着像"用了前缀判定"其实没用 —— 断言也就跟着空跑了。 */
  const bodyOf = (src, anchor) => {
    const s = src.slice(src.indexOf(anchor));
    return s.slice(0, s.indexOf('\n}'));
  };
  const irn = bodyOf(sys, 'pub fn is_reserved_name');
  const irnTs = bodyOf(la, 'export function isReservedWinName');

  t('前端不用 startsWith（会误拒 config/console）', !/startsWith/.test(irnTs));
  t('后端不用 starts_with', !/starts_with/.test(irn));
  t('后端取主名用 split(\'.\')', /name\.split\('\.'\)\.next\(\)/.test(irn));
  t('前端取主名用 split(\'.\')', /name\.split\('\.'\)\[0\]/.test(irnTs));
  t('后端大小写不敏感（to_uppercase）', /to_uppercase\(\)/.test(irn));
  t('前端大小写不敏感（toUpperCase）', /toUpperCase\(\)/.test(la.slice(la.indexOf('isReservedWinName'))));
}

done();
