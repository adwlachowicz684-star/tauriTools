/**
 * 凭据保险箱落盘 ——「说了保存其实没保存」+ 换保管方式时的不可逆丢失
 * ====================================================================
 * localStorage 是这里的**唯一落盘点**（读只从
 * `parseStore(localStorage.getItem(CRED_KEY))` 来，没有第二条路），
 * 所以"没存下"= 这次改动根本不存在。
 *
 * 早先两处都是 try + 空 catch，然后无条件往下走：
 *
 *   ① 连接变化（useEffect）        —— 什么都不说，重启后退回旧凭据
 *   ② changeVaultMode（换保管方式）—— 紧接着 onLog('✓ 连接存储方式已改为…')
 *
 * ② 比别处更严重：它在落盘**之前**先 `osKeyringDelete()` 删掉 OS 里那条旧
 * 钥匙。一旦落盘失败，磁盘上还是用旧钥匙加密的旧密文，而旧钥匙已经没了 ——
 * 凭据**永久解不开**，界面上却打了个 ✓。所以删钥匙必须等落盘成功之后。
 *
 * 判据（persistVaultStore / takeVaultWriteError / vaultWriteFailMsg）
 * **跑真身**：从源码切出来、注入会抛错的 localStorage 桩实跑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
/* 剥注释走共用模块：内联副本的行注释判据是 `(^|[^:])\/\/`，会把 `a//b`
   整行后半截吞掉，断言其实在检查一段被截断的文本。共用模块用 `(^|\s)`。 */
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.join(HERE, 'plugins/agent-flow/hooks/useCredentialVault.ts');

const src = fs.readFileSync(VAULT, 'utf8');
function factoryKeyIfKnown(s) {
  const m = /export const CRED_KEY\s*=\s*'([^']+)'/.exec(s);
  return m ? m[1] : null;
}

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('✅ %s%s', name, extra === undefined ? '' : ` → ${extra}`); }
  else { fail += 1; fails.push(name); console.log('❌ %s%s', name, extra === undefined ? '' : ` → ${extra}`); }
}

/* 去掉注释再判：注释里会原样举出反例（"早先是空 catch"），
   不剥掉的话"已改掉"会被判成"还在"。 */
const stripComments = stripCommentsFlatJs;
const code = stripComments(src);

/* 取 changeVaultMode 整段：从函数头到它结尾（下一个顶层 export/注释块之前） */
function sliceFn(s, header) {
  const i = s.indexOf(header);
  if (i < 0) return '';
  /* 括号配平取整段，避免切到别的函数 */
  let depth = 0;
  let started = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '{') { depth += 1; started = true; }
    else if (c === '}') {
      depth -= 1;
      if (started && depth === 0) return s.slice(i, k + 1);
    }
  }
  return '';
}
const changeVaultMode = sliceFn(src, 'const changeVaultMode = useCallback(');
const changeCode = stripComments(changeVaultMode);

/* ================================================================== *
 * ① 判据跑真身
 * ================================================================== */
const persistSeg = (() => {
  const m = /let lastVaultWriteError[\s\S]*?export function vaultWriteFailMsg[\s\S]*?\n}/.exec(src);
  return m ? m[0] : '';
})();

ok(persistSeg.length > 0, '（前置）判据段切到了', persistSeg.length);
ok(!!factoryKeyIfKnown(src), '（前置）CRED_KEY 提得到', factoryKeyIfKnown(src));

let P = null;
let factoryKey = null;
if (persistSeg) {
  try {
    /* 切片带 TS 类型注解（`: StoredFile` / `: boolean`），直接 new Function 会
       `Unexpected token ':'` —— 必须先转译。剥掉行首 export 再转译，
       这样产物是纯函数声明，没有 exports 语句。 */
    const body = persistSeg.replace(/^export function/gm, 'function');
    const js = ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      fileName: 'persist-seg.ts',
    }).outputText;
    /* CRED_KEY 定义在切片之外，得跟着注入 —— 少了它判据会抛
       ReferenceError，而它自己又带 try/catch，于是"没定义常量"被当成
       "写不进去"报出来，症状和真失败一模一样、极难分辨。 */
    const keyM = /export const CRED_KEY\s*=\s*'([^']+)'/.exec(src);
    const CRED_KEY = keyM ? keyM[1] : null;
    factoryKey = CRED_KEY;
    const factory = new Function(
      'localStorage', 'serializeStore', 'CRED_KEY',
      `${js}\n return { persistVaultStore, takeVaultWriteError, vaultWriteFailMsg };`,
    );
    const store = new Map();
    const ls = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        if (ls.__boom) throw new Error('QuotaExceededError');
        store.set(k, v);
      },
      __boom: false,
    };
    P = factory(ls, (x) => JSON.stringify(x), CRED_KEY);
    P.__ls = ls;
  } catch (e) {
    ok(false, '（前置）判据能跑起来', String(e && e.message));
  }
}

if (P) {
  const { persistVaultStore, takeVaultWriteError, vaultWriteFailMsg } = P;
  P.__ls.__boom = false;
  ok(persistVaultStore({ mode: 'auto' }) === true, '判据：写进去了 → true');
  ok(takeVaultWriteError() === null, '判据：成功时不留失败原因');

  P.__ls.__boom = true;
  ok(persistVaultStore({ mode: 'passphrase' }) === false, '判据：写不进去 → false（不再静默吞掉）');
  const reason = takeVaultWriteError();
  ok(!!reason, '判据：失败原因能取出来', reason);
  ok(takeVaultWriteError() === null, '判据：原因取一次就清掉');

  const msg = vaultWriteFailMsg('新的保管方式', 'QuotaExceededError');
  ok(msg.startsWith('✗'), '判据：失败说的是 ✗（不是 ✓）', msg);
  ok(msg.includes('QuotaExceededError'), '判据：把真原因说出来');
  ok(msg.includes('重启后会回到原来的样子'), '判据：说清后果（重启后退回原样）');
}

/* ================================================================== *
 * ② 两处调用点都改用判据，不再有裸 setItem + 空 catch
 * ================================================================== */
const bare = /localStorage\.setItem\(CRED_KEY[^)]*\)\s*;?\s*\}\s*catch\s*\{[^}]*\}/.exec(code);
ok(!bare, '全文件没有「裸 setItem + 空 catch」了');
ok(code.includes('persistVaultStore'), '调用点改用 persistVaultStore');

/* ① 连接变化那处 */
const effectSeg = (() => {
  const i = src.indexOf('encryptStore(be, store, credentials, vaultKey).then(');
  return i < 0 ? '' : src.slice(i, i + 600);
})();
const effectCode = stripComments(effectSeg);
ok(effectSeg.length > 0, '（前置）连接变化那处切到了');
ok(effectCode.includes('persistVaultStore(next)'), '连接变化：走判据');
ok(/if\s*\(\s*!\s*persistVaultStore\(next\)\s*\)/.test(effectCode), '连接变化：先看落盘结果');
ok(effectCode.includes('onLog('), '连接变化：没存下要说出来（界面上已经显示改过了）');
ok(effectCode.includes('vaultWriteFailMsg'), '连接变化：用共用文案，不是自己拼一句');

/* ② changeVaultMode */
ok(changeVaultMode.length > 0, '（前置）changeVaultMode 段切到了', changeVaultMode.length);
ok(changeCode.includes('persistVaultStore(next)'), '换保管方式：走判据');
ok(/if\s*\(\s*!\s*persistVaultStore\(next\)\s*\)/.test(changeCode), '换保管方式：先看落盘结果');
ok(changeCode.includes('return;'), '换保管方式：没存下就停（不删钥匙、不打 ✓）');

/* ================================================================== *
 * ③ 删 OS 钥匙必须在落盘**之后**（本轮最关键的一处）
 * ================================================================== */
const iDel = changeCode.indexOf('osKeyringDelete()');
const iSave = changeCode.indexOf('persistVaultStore(next)');
const iTick = changeCode.indexOf('✓ 连接存储方式已改为');

/* 顺序断言必须先判两端存在：indexOf 取不到时是 -1，而 -1 恒小于任何数，
   于是"断言恒真、什么都没验"—— 这是本项目栽过好几次的坑。 */
ok(iDel > 0, '（前置）changeVaultMode 里找得到 osKeyringDelete', iDel);
ok(iSave > 0, '（前置）changeVaultMode 里找得到 persistVaultStore', iSave);
ok(iTick > 0, '（前置）changeVaultMode 里找得到成功提示', iTick);
ok(iDel > iSave, '删 OS 钥匙在落盘**之后**（先删再存失败 = 凭据永久解不开）',
  `delete@${iDel} save@${iSave}`);
ok(iSave < iTick, '成功提示在落盘之后（存下了才说改好了）', `save@${iSave} tick@${iTick}`);

/* 失败分支里不能有 ✓ */
const failBranch = (() => {
  const m = /if\s*\(\s*!\s*persistVaultStore\(next\)\s*\)\s*\{([\s\S]*?)\n\s{4}\}/.exec(changeCode);
  return m ? m[1] : '';
})();
ok(failBranch.length > 0, '（前置）失败分支切到了');
ok(failBranch.length > 0 && !failBranch.includes('✓'), '失败分支里不打 ✓（存不下就不能说改好了）');
ok(failBranch.includes('vaultWriteFailMsg') || failBranch.includes('onLog'), '失败分支有可见输出');

/* ================================================================== *
 * ④ 语法自检
 * ================================================================== */
const d = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
  fileName: VAULT,
}).diagnostics || [];
ok(d.length === 0, '改完语法仍然合法', d.length ? ts.flattenDiagnosticMessageText(d[0].messageText, ' ') : 0);

console.log('\n通过 %d / 失败 %d', pass, fail);
if (fail) { console.log('失败项：'); fails.forEach((f) => console.log('  -', f)); process.exitCode = 1; }
