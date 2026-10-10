/**
 * 脑图落盘名一致性测试
 * ============================================================
 * 要防的形状：**界面报的文件名，和真落到磁盘上的不是同一个**。
 *
 * 这类不是"少一条样式"，而是用户会**照着去做**：提示说「已保存到下载目录：X」，
 * 他就去下载目录找 X。而 X 是安全化**之前**的名字 —— 在 Windows 上那个名字
 * 根本不可能存在（含 `:` `/`），于是找不着，界面上却没有任何失败迹象，
 * 只能得出"导出失败了"这个错误结论。
 *
 * 同一条线上还有两个"两处两套判据"：
 *   · PDF 导出用的是原始画布标题，相邻那一路（交换格式）却做了安全化；
 *   · safeFileName 缺 Windows 保留设备名，而 project-group 的 sys.rs 有。
 *
 * 判据一律**跑真身**（safeFileName 真实调用、提示那一段从源码抽出执行），
 * 不靠"源码里有没有这几个字" —— 后者证明不了提示里到底是哪个名字。
 */
import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import * as io from './io.js';

const HERE = process.cwd();
const read = (p) => readFileSync(pjoin(HERE, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
const fails = [];
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
};

/* ============================================================
   1. safeFileName：保留设备名
   ============================================================ */
t('保留名 CON.pdf 被改写（带扩展名同样保留）',
  io.safeFileName('CON.pdf') !== 'CON.pdf', io.safeFileName('CON.pdf'));
t('小写 con.PDF 同样处理（判据大小写不敏感）',
  io.safeFileName('con.PDF') !== 'con.PDF', io.safeFileName('con.PDF'));
t('NUL 无扩展名也被处理', io.safeFileName('NUL') !== 'NUL', io.safeFileName('NUL'));
t('改写后不再是保留名（主名不再相等）',
  !/^CON\b/.test(io.safeFileName('CON.pdf')), io.safeFileName('CON.pdf'));

t('config.txt 不被误改（不能用前缀判据）',
  io.safeFileName('config.txt') === 'config.txt', io.safeFileName('config.txt'));
t('console.log 不被误改', io.safeFileName('console.log') === 'console.log');
t('auxiliary.md 不被误改', io.safeFileName('auxiliary.md') === 'auxiliary.md');
t('COM0 / LPT0 不在清单内（现代 Windows 上是合法名）',
  io.safeFileName('COM0.txt') === 'COM0.txt' && io.safeFileName('LPT0.txt') === 'LPT0.txt');
t('.CON 主名为空不判（与 Windows 实际行为一致）',
  io.safeFileName('.CON') === '.CON', io.safeFileName('.CON'));

/* 原有行为不能被动过 */
t('路径分隔符仍被剔除', !/[/\\]/.test(io.safeFileName('../../etc/passwd')));
t('Windows 非法字符仍被剔除', !/[:|]/.test(io.safeFileName('a:b|c')));
t('纯点号不再原样作为文件名', !/^\./.test(io.safeFileName('..')), io.safeFileName('..'));
t('空名仍有兜底', io.safeFileName('').length > 0, io.safeFileName(''));

/* ============================================================
   2. 落盘提示用的是安全化之后的名字（跑真身）
   ============================================================ */
{
  const src = read('index.js');
  const a = src.indexOf('async function openAttachment');
  const b = src.indexOf('/* ------------------------- 撤销 / 重做');
  t('抽取锚点都命中（否则本节整体空跑）', a >= 0 && b > a, `a=${a} b=${b}`);

  const fn = src.slice(a, b);
  /* 只取「安全化 → 落盘 → 提示」这一小段真实代码 */
  const i = fn.indexOf('const savedName');
  const j = fn.indexOf('（可双击用默认程序打开）');
  t('片段定位命中（改了变量名这里会先红）', i >= 0 && j > i, `i=${i} j=${j}`);

  const body = strip(fn.slice(i, fn.indexOf('\n', j))).trim();
  t('片段剥注释后仍有内容', body.length > 0, body.slice(0, 60));

  const RAW = '草稿/图 v2:终.png';
  const calls = { downloaded: null, said: '' };
  const stubIo = {
    safeFileName: io.safeFileName,
    downloadBlob: (n) => { calls.downloaded = n; },
  };
  const stubStatus = (s) => { calls.said = String(s); };
  // eslint-disable-next-line no-new-func
  const run = new Function('io', 'status', 'name', 'rec', body);
  run(stubIo, stubStatus, RAW, { blob: {} });

  const safe = io.safeFileName(RAW);
  t('下载用的是安全化后的名字', calls.downloaded === safe, String(calls.downloaded));
  t('提示里出现的就是落盘那个名字', calls.said.includes(safe), calls.said.slice(0, 60));
  t('提示里不再出现原始名（磁盘上不存在它）',
    !calls.said.includes(RAW), calls.said.slice(0, 60));
  t('提示里不含 Windows 不可能存在的字符 / 与 :',
    !calls.said.includes('/') || !calls.said.includes(':'), calls.said.slice(0, 60));
  t('落盘与提示取的是同一个变量（不是各算一次）',
    /savedName/.test(body) && (body.match(/savedName/g) || []).length >= 2,
    String((body.match(/savedName/g) || []).length));
}

/* ============================================================
   3. 兜底扫描：用户可控的落盘名必须过 safeFileName
   ============================================================ */
{
  const files = ['index.js', 'panels.js'];
  const CALLS = ['io.saveText(', 'io.saveBlob(', 'io.downloadBlob(', 'io.stampName('];
  const USER_SRC = /\btitle\b|\bname\b|\bn\b/;

  const firstArg = (s, start) => {
    let depth = 0, buf = '', q = null;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '\\') { buf += c + (s[i + 1] || ''); i++; continue; }
        if (c === q) q = null;
        buf += c; continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; buf += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) return buf;
      } else if (c === ',' && depth === 1) return buf;
      buf += c;
    }
    return buf;
  };

  let total = 0, userSites = 0;
  const bad = [];
  for (const f of files) {
    const src = strip(read(f));
    for (const call of CALLS) {
      let i = 0;
      while ((i = src.indexOf(call, i)) >= 0) {
        const arg = firstArg(src, i + call.length - 1);
        total++;
        i += call.length;
        if (!USER_SRC.test(arg)) continue;
        userSites++;
        if (!arg.includes('io.safeFileName(')) bad.push(`${f}:${call}${arg.slice(0, 48)}`);
      }
    }
  }
  t('扫描器确实扫到了调用点（否则判据空转）', total > 0, `共 ${total} 处`);
  t('扫描器确实分出了用户可控那批（否则漏对象）', userSites >= 3, `${userSites} 处`);
  t('用户可控的落盘名全部过 safeFileName（PDF 那一路曾漏掉）',
    bad.length === 0, bad.join(' | '));
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
