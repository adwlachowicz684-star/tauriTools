/**
 * 截图 / 窗口列举（`fpx/screen.rs`）的守卫测试。
 * ------------------------------------------------------------------
 * 这个文件此前**零测试覆盖**（全仓扫描：没有任何 *-test.mjs 提到 screen.rs），
 * 而它整段都走 `powershell -Command` 拼脚本 —— 是本项目"外部命令注入"面的
 * 另一半（另一半是 `sys.rs` 的取色）。
 *
 * 核心是一段**传递式污点扫描**：函数里拼进 PowerShell 脚本的每个字符串，
 * 必须能沿赋值链回溯到一个被 `safe_ps_literal` 校验过的源头。
 * 只断言"源码里有 safe_ps_literal 这几个字"证明不了这一点 ——
 * 它可以在别处被调用，而真正拼进脚本的那个串没人管。
 *
 * 沙箱没有 cargo，Rust 侧无法编译执行；除污点扫描外的断言是对源码结构的
 * 判定，注释里写清了每条守的是什么本意。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const RS = join(here, '..', '..', 'src-tauri', 'src', 'fpx', 'screen.rs');
const src = readFileSync(RS, 'utf8');

/** 剥块注释与行注释：注释里出现代码字样会让结构断言假绿。 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) pass += 1;
  else fails.push(name + (extra ? ` — ${extra}` : ''));
}

/** 按列首的 `fn` / `pub fn` 切出函数体（Rust 里嵌套函数极少，够用）。 */
function splitFns(s) {
  const lines = s.split('\n');
  const out = [];
  let cur = null;
  for (const ln of lines) {
    if (/^(?:pub )?fn \w+/.test(ln)) {
      if (cur) out.push(cur);
      cur = { head: ln, body: ln };
    } else if (cur) {
      cur.body += '\n' + ln;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const fns = splitFns(code);
const psFns = fns.filter((f) => f.body.includes('Command::new("powershell")'));

/* ---------------- ① 传递式污点扫描 ---------------- */

/** 被 `safe_ps_literal(&X)` 校验过的标识。 */
function guardedSet(body) {
  const g = new Set();
  for (const m of body.matchAll(/safe_ps_literal\(&(\w+)\)/g)) g.add(m[1]);
  return g;
}

/** 沿 `let a = …b…` 传播：源头被校验过，则派生出来的也算已校验。 */
function propagate(body, seeds) {
  const ok = new Set(seeds);
  // 多轮传播，处理 a → b → c 的链（赋值顺序在源码里不一定自上而下）
  for (let round = 0; round < 4; round += 1) {
    for (const m of body.matchAll(/let\s+(?:mut\s+)?(\w+)\s*=\s*([^;]+);/g)) {
      const [, name, rhs] = m;
      for (const s of ok) {
        // 只认**标识符**出现，不认子串（否则 `pat` 会被 `kw_pat` 之类喂饱）
        if (new RegExp(`\\b${s}\\b`).test(rhs)) { ok.add(name); break; }
      }
    }
  }
  return ok;
}

/**
 * 沿赋值链做污点传播：形参是源头，`let a = …b…` 把污染传下去。
 * 多轮迭代，因为赋值顺序在源码里不一定自上而下（filter 用到 pat，pat 用到 kw）。
 */
function tainted(body, seeds) {
  const set = new Set(seeds);
  for (let round = 0; round < 4; round += 1) {
    for (const m of body.matchAll(/let\s+(?:mut\s+)?(\w+)\s*=\s*([^;]+);/g)) {
      const [, name, rhs] = m;
      for (const s of set) {
        if (new RegExp(`\\b${s}\\b`).test(rhs)) { set.add(name); break; }
      }
    }
  }
  return set;
}

/**
 * 用户串：函数签名里的形参（不只是 &str），加上由它派生的局部变量。
 *
 * **必须把 `&Path` 也算进来**：`capture(dir: &Path)` 里拼进脚本的是 `path_str`，
 * 源头是 `dir` —— 而 `dir` 是 MCP 传进来的截图目录，同样是外部可控输入
 * （`capture` 自己也写了"截图目录可由 MCP 传入"，并为此挡了换行与反引号）。
 *
 * 只认 `&str` 的后果：`capture` 的 users 恒为空，于是「确实有用户串被拼进脚本」
 * 那条**恒假** —— 界面/报告上看着像"这个站点没有外部输入"，其实是扫描器自己
 * 没把源头认全。这类"扫描器漏了源头"比漏校验更隐蔽：它让一整段校验看起来
 * 无事可做，而真正的入参正在被拼进脚本。
 */
function userIdents(fn) {
  const params = [...fn.head.matchAll(/(\w+):\s*&(?:str|String|Path|PathBuf)/g)].map((m) => m[1]);
  return tainted(fn.body, params);
}

/**
 * 只看**脚本字面量**里的插值。
 * 直接扫全函数会把错误文案里的 `{kw}` / `{msg}` 也算进来（那是给调用方看的
 * 提示，不进 PowerShell），从而报出假阳性。
 */
function scriptInterps(body) {
  const a = body.indexOf('let script');
  const b = body.indexOf('Command::new("powershell")');
  if (a === -1 || b === -1 || b < a) return [];
  return [...body.slice(a, b).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

t('存在 PowerShell 调用点（扫描基线，不是空跑）', psFns.length >= 3, `实际 ${psFns.length}`);

for (const fn of psFns) {
  const fname = (fn.head.match(/fn (\w+)/) || [])[1] || '?';
  const seeds = guardedSet(fn.body);
  const ok = propagate(fn.body, seeds);
  const users = userIdents(fn);
  const interp = scriptInterps(fn.body);
  const bad = [...new Set(interp)].filter(
    (id) => users.has(id) && !ok.has(id),
  );
  t(
    `powershell 站点 ${fname}：拼进脚本的用户串都已校验`,
    bad.length === 0,
    bad.length ? `未校验：${bad.join('、')}` : '',
  );
  t(
    `powershell 站点 ${fname}：确实有用户串被拼进脚本（扫描非空跑）`,
    [...new Set(interp)].some((id) => users.has(id)),
  );
}

/** 反向验证用：把 list_windows 的守卫去掉后应报出未校验项。 */
export function auditSource(text) {
  const c = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const list = [];
  for (const fn of splitFns(c).filter((f) => f.body.includes('Command::new("powershell")'))) {
    const fname = (fn.head.match(/fn (\w+)/) || [])[1] || '?';
    const ok = propagate(fn.body, guardedSet(fn.body));
    const users = userIdents(fn);
    const interp = scriptInterps(fn.body);
    const bad = [...new Set(interp)].filter((id) => users.has(id) && !ok.has(id));
    if (bad.length) list.push({ fn: fname, bad });
  }
  return list;
}

/* ---------------- ② like 通配符转义 ---------------- */

const likeFn = code.match(/fn like_literal[\s\S]*?\n\}/);
t('存在 like_literal 转义函数', !!likeFn);
t(
  'like_literal 覆盖了 -like 的四个通配符 * ? [ ]',
  !!likeFn && /matches!\(c,\s*'\*'\s*\|\s*'\?'\s*\|\s*'\['\s*\|\s*'\]'\)/.test(likeFn[0]),
);
t('转义符是反引号（单引号串里反引号是字面量）', !!likeFn && /out\.push\('`'\)/.test(likeFn[0]));
t(
  'like_literal 只在 Windows 构建（Linux 用不到，留着会 dead_code）',
  /#\[cfg\(windows\)\]\s*\nfn like_literal/.test(code),
);

// 两个 -like 站点必须用转义后的变量，不能用原始输入
t('list_windows 用转义后的 pat 做 -like', /-like '\*\{pat\}\*'/.test(code));
t('capture_window 用转义后的 kw_pat 做 -like', /-like '\*\{kw_pat\}\*'/.test(code));
t('list_windows 不再把原始 kw 直接拼进 -like', !/-like '\*\{kw\}\*'/.test(code));
t('capture_window 不再把 kw_esc 直接拼进 -like', !/-like '\*\{kw_esc\}\*'/.test(code));

/* ---------------- ③ 顺序：先校验，后转义 ---------------- */

const lwBody = (code.match(/fn list_windows[\s\S]*?\n\}/) || [''])[0];
const cwBody = (code.match(/fn capture_window[\s\S]*?\n\}/) || [''])[0];
for (const [nm, body, guardVar, escVar] of [
  ['list_windows', lwBody, 'kw', 'pat'],
  ['capture_window', cwBody, 'kw_esc', 'kw_pat'],
]) {
  const gi = body.indexOf(`safe_ps_literal(&${guardVar})`);
  const ei = body.indexOf(`like_literal(&${guardVar})`);
  t(`${nm}：守卫存在`, gi !== -1);
  t(`${nm}：转义存在`, ei !== -1);
  // 顺序反了会把转义补的反引号当成不安全字符，合法标题全被拒
  t(`${nm}：先校验再转义`, gi !== -1 && ei !== -1 && gi < ei, `guard=${gi} esc=${ei}`);
  t(`${nm}：转义结果被使用`, body.includes(`let ${escVar}`) || body.includes(`{${escVar}}`));
}

/* ---------------- ④ 截图文件名不再互相覆盖 ---------------- */

const tp = (code.match(/fn target_path[\s\S]*?\n\}/) || [''])[0];
t('target_path 带进程内自增序号', /SHOT_SEQ\.fetch_add\(1/.test(tp));
t('文件名带序号后缀', /shot_\{secs\}_\{n\}\.png/.test(tp));
t('不再只按秒命名（同秒两张会静默覆盖）', !/shot_\{secs\}\.png/.test(tp));
t('序号用 AtomicU64 声明', /static SHOT_SEQ: AtomicU64/.test(code));
t(
  '序号已 import（否则编译不过）',
  /use std::sync::atomic::\{AtomicU64, Ordering\}/.test(code),
);

/* ---------------- ⑤ 非 Windows 分支仍是明确报错（未被顺手改坏） ---------------- */

const nw = code.match(/#\[cfg\(not\(windows\)\)\]\s*\npub fn list_windows[\s\S]*?\n\}/);
t('非 Windows 的 list_windows 仍返回 Err', !!nw && /Err\(/.test(nw[0]));
const nwc = code.match(/#\[cfg\(not\(windows\)\)\]\s*\npub fn capture_window[\s\S]*?\n\}/);
t('非 Windows 的 capture_window 仍返回 Err', !!nwc && /Err\(/.test(nwc[0]));

/* ---------------- 汇总 ---------------- */

const total = pass + fails.length;
console.log(fails.length ? `\n失败项：\n - ${fails.join('\n - ')}\n` : '');
console.log(`截图与窗口列举守卫：通过 ${pass} 项，失败 ${fails.length} 项（共 ${total} 项）`);
if (fails.length) process.exitCode = 1;
