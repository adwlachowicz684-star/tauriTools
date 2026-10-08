/**
 * 改名框按 Esc = 取消这次编辑（不该提交改名）。
 *
 * 为什么单独立一个文件：LinkPanel 里那个改名 input 是**常驻**的
 * （不是"进入编辑态才挂载"），所以「Esc → 退出编辑」是靠显式 blur() 做的；
 * 而 blur 会同步触发 onBlur，onBlur 里就是提交改名的那个调用。
 *
 * 于是这一条链上藏着一个静默错误：Esc 分支先 setRenameDraft（清草稿），
 * 但 React 的 setState 是批处理的 —— 同一个事件处理函数里紧接着调用的
 * blur()，派发 onBlur 时 **DOM 里的 value 还是用户刚编辑的文本**
 * （React 尚未重渲染）。onBlur 拿 `e.target.value` 去 rename，
 * 于是「取消」变成「照改不误」：目录名被改掉，而界面上草稿已清、
 * 显示回原名，用户以为自己取消了。
 *
 * 其余三处改名框（CardGrid / TabManagerDialog / StackedGroups）不受影响：
 * 它们是**条件挂载**的，Esc 走的是"卸载 input"，卸载不触发 onBlur。
 * 所以这个 BUG 只在常驻 input + 显式 blur 这一处出现——第 3 节把这条
 * 边界钉住，免得将来有人照着这里的写法去改别处。
 *
 * 测试跑的是**从源码切出来的真身**（配平大括号后 new Function 注入依赖），
 * 不是"源码里有这几行"的文本断言 —— 文本断言证明不了事件派发时
 * DOM value 到底是新值还是旧值，而那正是这个 BUG 的全部。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments as strip } from '../../test-scan-utils.mjs';
/*
 * ⓘ 剥注释改用全仓共用实现（test-scan-utils.mjs）。
 *   此前本文件内联一份，判据与共用版语义不同（行首起判注释、整行丢弃），
 *   两份并存必然漂移；且"只减不增"的守卫会因新增副本报红。
 *   这里别名成 stripComments，调用点无需改动。
 */
import { stripCommentsJs as stripComments } from '../../test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');

let pass = 0;
const fails = [];
function ok(cond, name) {
  if (cond) { pass++; } else { fails.push(name); }
}

/** 剥注释：断言只能看代码，否则注释里的字样会把断言喂饱（已踩过多次） */

/**
 * 从 `anchor` 之后切出一段配平的 `{ ... }`。
 * 配平要同时算引号与模板串，否则字符串里的 `{` 会让切片提前收尾。
 *
 * **锚点后若紧跟 `=>`，要从箭头**之后**找左括号**：JSX 里写的是
 * `onKeyDown={(e) => { ... }}`，anchor 之后的第一个 `{` 是 JSX 属性值
 * 那层，不是函数体 —— 切到它的话 body 变成 `{ (e) => {...} }`，
 * 编译出来是个啥也不做的箭头函数，所有行为断言都会"通过"（假绿）。
 */
function sliceBraced(src, anchor, from = 0) {
  const at = src.indexOf(anchor, from);
  if (at < 0) return null;
  let searchFrom = at;
  const arrowAt = src.indexOf('=>', at);
  if (arrowAt >= 0 && arrowAt - at < 60) searchFrom = arrowAt + 2;
  const start = src.indexOf('{', searchFrom);
  if (start < 0) return null;
  let depth = 0;
  let q = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { body: src.slice(start, i + 1), end: i + 1 }; }
  }
  return null;
}

/** 把切出来的块编译成可执行函数（注入闭包里的自由变量） */
function compile(body, params, exprArgs) {
  const names = Object.keys(params);
  const vals = names.map((n) => params[n]);
  // eslint-disable-next-line no-new-func
  const f = new Function(...names, `const fn = ${exprArgs} => ${body}; return fn;`);
  return (...args) => f(...vals)(...args);
}

/* ------------------------------------------------------------------ */
/* 第 1 节：Esc 的行为（跑真身）                                        */
/* ------------------------------------------------------------------ */
{
  const src = read('components/LinkPanel.tsx');
  const anchor = 'className="p-input fpx-rename"';
  const at = src.indexOf(anchor);
  ok(at > 0, '能定位到改名输入框（锚点 fpx-rename 存在）');

  const kd = sliceBraced(src, 'onKeyDown={(e) =>', at);
  const bl = sliceBraced(src, 'onBlur={(e) =>', at);
  ok(!!kd && !!bl, '改名输入框的 onKeyDown / onBlur 都能切出来');

  if (kd && bl) {
    /** 造一次"用户编辑到一半按 Esc"的场景 */
    function scenario(key) {
      const calls = { rename: [], draft: 0, err: 0, stop: 0, blur: 0 };
      const p = { original: '.claude', shown: '我的助手' };
      // 用户已经把框里改成了 'abc'（DOM 里的真实值）
      const el = {
        value: 'abc',
        blur() { calls.blur++; onBlur({ target: el }); },
      };

      const setRenameDraft = () => { calls.draft++; };
      /* 关键：模拟 React 批处理 —— setState 只在 handler 结束后才刷新 DOM。
         所以这里**不能**改 el.value，改了就等于假装 React 是同步的，
         那个 BUG 就永远测不出来。 */
      const clearRenameErr = () => { calls.err++; };
      const rename = (o, s, to) => { calls.rename.push([o, s, to]); };

      const onBlur = compile(bl.body, { rename, setRenameDraft, p }, 'e');
      const onKeyDown = compile(kd.body, {
        isComposing: (n) => n && (n.isComposing === true || n.keyCode === 229),
        rename, setRenameDraft, clearRenameErr, p,
      }, 'e');

      onKeyDown({
        key,
        currentTarget: el,
        nativeEvent: {},
        preventDefault() {},
        stopPropagation() { calls.stop++; },
      });
      return calls;
    }

    const esc = scenario('Escape');
    ok(esc.rename.length === 0,
      '按 Esc 不得提交改名（此前 blur 同步派发 onBlur，DOM 里还是编辑值 → 照改不误）');
    ok(esc.draft > 0, '按 Esc 要清掉这一行的草稿（界面回到当前名）');
    ok(esc.err > 0, '按 Esc 要清掉这一行的就地错误');
    ok(esc.stop > 0, '按 Esc 要 stopPropagation（否则会连上面压着的浮层一起退）');

    const ent = scenario('Enter');
    ok(ent.rename.length === 1,
      '按 Enter 仍要提交改名（不能为了修 Esc 把正常路径一起关掉）');
    ok(ent.rename[0] && ent.rename[0][2] === 'abc',
      '按 Enter 提交的应是框里的新值');
    ok(ent.blur > 0, '按 Enter 仍走 blur → onBlur 这一条路（两条路径不能各写一份提交）');

    /* 组合期：这一下 Esc 是"取消候选词"，不是"退出这次编辑" */
    {
      const calls = { rename: [], stop: 0, blur: 0 };
      const p = { original: '.claude', shown: '我的助手' };
      const el = { value: 'abc', blur() { calls.blur++; } };
      const onKeyDown = compile(kd.body, {
        isComposing: (n) => n && (n.isComposing === true || n.keyCode === 229),
        rename: () => { calls.rename.push(1); },
        setRenameDraft: () => {},
        clearRenameErr: () => {},
        p,
      }, 'e');
      onKeyDown({
        key: 'Escape',
        currentTarget: el,
        nativeEvent: { isComposing: true },
        preventDefault() {},
        stopPropagation() { calls.stop++; },
      });
      ok(calls.rename.length === 0 && calls.blur === 0 && calls.stop === 0,
        '组合期的 Esc 归输入法：不提交、不 blur、不拦事件');
    }
  }
}

/* ------------------------------------------------------------------ */
/* 第 2 节：Esc 分支的形态（剥注释后判）                                */
/* ------------------------------------------------------------------ */
{
  const src = read('components/LinkPanel.tsx');
  const at = src.indexOf('className="p-input fpx-rename"');
  const kd = sliceBraced(src, 'onKeyDown={(e) =>', at);
  ok(!!kd, '第 2 节能切出 onKeyDown');
  if (kd) {
    const code = stripComments(kd.body);
    const escAt = code.indexOf("e.key === 'Escape'");
    ok(escAt > 0, 'onKeyDown 里有 Escape 分支');
    if (escAt > 0) {
      const blk = sliceBraced(code, "e.key === 'Escape'");
      ok(!!blk, 'Escape 分支能整段切出来');
      if (blk) {
        ok(!blk.body.includes('blur()'),
          'Escape 分支内不得再调 blur() —— blur 会触发 onBlur 提交改名，取消就变成照改');
        ok(blk.body.includes('setRenameDraft'),
          'Escape 分支仍要清草稿（界面回到当前名）');
        ok(blk.body.includes('clearRenameErr'),
          'Escape 分支仍要清就地错误');
        ok(blk.body.includes('stopPropagation'),
          'Escape 分支仍要 stopPropagation（#250）');
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 第 3 节：其余三处改名框（条件挂载，靠卸载退出）                       */
/* ------------------------------------------------------------------ */
{
  const files = [
    ['components/StackedGroups.tsx', 'fpx-stack-edit'],
    ['components/TabManagerDialog.tsx', 'fpx-tabmgr-input'],
    ['components/CardGrid.tsx', 'fpx-tab-input'],
  ];
  for (const [rel, cls] of files) {
    const src = read(rel);
    const at = src.indexOf(`className="p-input ${cls}"`) >= 0
      ? src.indexOf(`className="p-input ${cls}"`)
      : src.indexOf(cls);
    ok(at > 0, `第 3 节能定位 ${rel} 的改名框（${cls}）`);
    const kd = sliceBraced(src, 'onKeyDown={(e) =>', at);
    ok(!!kd, `${rel} 的 onKeyDown 能切出来`);
    if (kd) {
      const code = stripComments(kd.body);
      const escAt = code.indexOf("e.key === 'Escape'");
      ok(escAt > 0, `${rel} 有 Escape 分支`);
      if (escAt > 0) {
        const blk = sliceBraced(code, "e.key === 'Escape'");
        ok(!!blk && !blk.body.includes('blur()'),
          `${rel} 的 Esc 也不得靠 blur 退出（它是条件挂载，卸载即可；加 blur 会走 onBlur 提交）`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
const total = pass + fails.length;
if (fails.length) {
  console.log(`❌ 改名 Esc 取消：通过 ${pass} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log(`   ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✅ 改名 Esc 取消：通过 ${pass} 项，失败 0 项`);
}
void total;
