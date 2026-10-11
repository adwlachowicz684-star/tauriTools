/**
 * 链接名为空时的「分配完成」谎报回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/link-empty-names-test.mjs
 *
 * 一个链接名都没启用时：后端 core_create_link 的循环一次都不跑，
 * created 为空、账本也不写，而快照照常返回 —— **没有任何失败信号**。
 * 前端因此照旧 toast「分配完成」、日志写「（0 个链接）」。
 *
 * 用户拖完卡片看到"完成"，实际项目目录里一个 junction 都没有，
 * 也不报错。他会以为分配生效了，接着去用 AI 客户端（客户端要的是
 * 项目目录下的 .claude 之类），全部落空。
 *
 * 这里守三件事：
 *   · 后端空名单必须 Err（且判据在循环**之前**）
 *   · 前端 0 个生效时不得再 toast「分配完成」
 *   · 报错文案在 Rust 侧只有一处定义（抄两份迟早漂移）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { readStripped } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(HERE, '../../src-tauri/src/fpx/mod.rs');
const HOOK = path.join(HERE, 'hooks/useFpx.ts');
const { t, done } = makeT();

const hasMod = fs.existsSync(MOD);
const rs = hasMod ? readStripped(MOD) : '';
const hook = readStripped(HOOK);

/** 从 `from` 起按大括号配平切出一段（专治"切到别的块"） */
function braceRange(src, from) {
  const start = src.indexOf('{', from);
  if (start < 0) return { text: '', start: -1, end: -1 };
  let d = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') {
      d -= 1;
      if (d === 0) return { text: src.slice(start, i + 1), start, end: i + 1 };
    }
  }
  return { text: '', start: -1, end: -1 };
}

function braceBlock(src, from) {
  return braceRange(src, from).text;
}

console.log('\n=== 1. 后端：空名单必须报错 ===');
if (!hasMod) { console.log('（跳过：未找到 mod.rs）'); } else {
  t('报错常量存在', /const NO_LINK_NAMES_ERR: &str =/.test(rs));
  t('常量定义只有一处（不抄两份）',
    (rs.match(/const NO_LINK_NAMES_ERR/g) || []).length === 1);
  t('常量说出该去哪儿开', /「Agent 链接名」/.test(rs));

  const fnAt = rs.indexOf('pub(crate) fn core_create_link(');
  t('core_create_link 存在', fnAt >= 0);
  const fn = fnAt >= 0 ? braceBlock(rs, fnAt) : '';
  t('函数体切出来了（不是空段）', fn.length > 200);

  t('取完名单就判空', /if use_names\.is_empty\(\) \{/.test(fn));
  t('返回 Err 而不是 Ok', /return Err\(NO_LINK_NAMES_ERR\.to_string\(\)\);/.test(fn));
  t('不带 use_names 时不静默走默认（判据用的是最终名单）',
    /_ => junction::enabled_names\(&cfg\),/.test(fn));

  /* 顺序必须钉住：判据放在循环**之后**的话，空名单时循环不跑、
     判据也进不去 —— 等于没写。 */
  const iGuard = fn.indexOf('if use_names.is_empty()');
  const iLoop = fn.indexOf('for n in &use_names');
  t('两端都找到了（顺序断言不是空跑）', iGuard >= 0 && iLoop >= 0);
  t('判据在循环之前', iGuard >= 0 && iLoop >= 0 && iGuard < iLoop);
}

console.log('\n=== 2. 前端：0 个生效时不得说「分配完成」 ===');
{
  const anchor = 'const n = row?.names.length ?? 0;';
  const at = hook.indexOf(anchor);
  t('找到 createLink 里的条数字段', at >= 0);

  /* 跑真身：切出 `const n = …` 到 if/else 结束，注入依赖实跑。
     只断言"源码里有 ctx.toast"证明不了 0 个时到底走哪一支。
     if 与 else **两块分别配平**：只配平第一块的话 else 那半被丢在段外，
     0 个时的行为根本没被验到（而那正是本文件要守的那一支）。 */
  const ifAt = hook.indexOf('if (n > 0) {', at);
  t('找到分支（不是空跑）', ifAt >= 0 && ifAt > at);
  let block = '';
  if (ifAt >= 0) {
    const rIf = braceRange(hook, ifAt);
    const elseAt = hook.indexOf('else', rIf.end);
    const rElse = braceRange(hook, elseAt);
    t('else 也切到了（两段都在）', rElse.end > rIf.end && rElse.text.includes('ctx.toast'));
    /* 跳过 `const n = …` 那一行：它声明了 n，而 n 是下面注入的形参，
       同名 `const` 会直接 SyntaxError 把整段断言吃掉。 */
    block = hook.slice(at + anchor.length, rElse.end);
  }
  t('整段切出来了', block.includes('if (n > 0)') && block.includes('else'));
  t('段里没有别的函数混进来', !block.includes('useCallback'));

  const run = (n) => {
    const calls = [];
    const logs = [];
    const ctx = { toast: (m, k) => calls.push({ m, k }) };
    const pushLog = (m, isErr) => logs.push({ m, isErr });
    /* eslint-disable no-new-func */
    new Function('n', 'project', 'group', 'pushLog', 'ctx', block)(
      n, 'P', 'G', pushLog, ctx,
    );
    return { calls, logs };
  };

  /* okBlock 必须参与每一条行为断言。
     段没切出来时 calls 是空的，`!calls.some(...)` 之类**恒真** ——
     于是"撤掉修复"与"修好了"都显示通过，这正是"看着在跑、其实没验到"。
     带上它：段有问题就整体报红，暴露"没验到"而不是假装通过。 */
  const okBlock = block.includes('if (n > 0)') && block.includes('else');

  const ok = run(3);
  t('建成了才说「分配完成」',
    okBlock && ok.calls.some((c) => c.m === '分配完成' && c.k === 'ok'));
  t('3 个时日志带条数', okBlock && ok.logs.some((l) => l.m.includes('（3 个链接）')));
  t('3 个时不报红', okBlock && !ok.logs.some((l) => l.isErr));

  const zero = run(0);
  t('0 个时**不**说「分配完成」（谎报）',
    okBlock && !zero.calls.some((c) => c.m === '分配完成'));
  t('0 个时报 err', okBlock && zero.calls.some((c) => c.k === 'err'));
  t('0 个时的提示说清是 0 个生效',
    okBlock && zero.calls.some((c) => c.m.includes('0 个生效')));
  t('0 个时提示指向链接名设置',
    okBlock && zero.calls.some((c) => c.m.includes('链接名')));
  t('0 个时也留一条错误日志', okBlock && zero.logs.some((l) => l.isErr));
  t('0 个时仍如实记条数（不改写数字）',
    okBlock && zero.logs.some((l) => l.m.includes('（0 个链接）')));
}

console.log('\n=== 3. 兜底：不允许无条件 toast 成功 ===');
{
  const clAt = hook.indexOf('const createLink = useCallback(');
  t('找到 createLink', clAt >= 0);
  const cl = clAt >= 0 ? hook.slice(clAt, hook.indexOf('}, [api, applySnapshot', clAt)) : '';
  t('createLink 段切出来了', cl.includes('分配完成'));

  /* 「分配完成」必须落在 n > 0 的分支里。只判"存在"的话，
     撤掉分支改成无条件调用照样通过。 */
  const iToast = cl.indexOf("ctx.toast('分配完成'");
  const iIf = cl.indexOf('if (n > 0)');
  t('两端都找到（顺序断言不是空跑）', iToast >= 0 && iIf >= 0);
  t('「分配完成」在 n > 0 之后', iToast >= 0 && iIf >= 0 && iToast > iIf);
  t('条数字段用归一化键找行（不是原文精确比）',
    /snap\.links\.find\(\(l\) => normalizeKey\(l\.project, ci\) === k\)/.test(cl));
}

console.log('\n=== 4. 断言卫生（本文件自检） ===');
{
  const self = fs.readFileSync(path.join(HERE, 'link-empty-names-test.mjs'), 'utf8');
  const body = self.slice(self.indexOf("const { t, done } = makeT();"));
  t('没有恒真断言', !/t\('[^']*',\s*true\)/.test(body));
  t('没有恒假断言', !/t\('[^']*',\s*false\)/.test(body));
}

done();
