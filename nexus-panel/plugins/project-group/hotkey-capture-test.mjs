/**
 * 快捷键**录入态**（点键位 → 请按键…）的按键处理。
 *
 * 为什么单独立一个文件：这处监听是 **window 级**的（`addEventListener('keydown', …, true)`），
 * 不在 ime-guard-test 扫的那 11 处 `onKeyDown` 里 —— 那一层抓不到它，
 * 所以它此前一直在组合期（IME）无条件吞键。
 *
 * 这里盯两类失效，它们都表现为"什么都不发生"：
 *
 *   1. **组合期吞键**：组合中那一帧的键归输入法。无条件 preventDefault
 *      会把键从输入法手里抢走，输入法状态错乱；而且 `e.key` 是 'Process'，
 *      录出来的组合也是错的。
 *
 *   2. **识别不出来的键 → 静默卡住**：`comboFromEvent` 返回 null 时此前
 *      什么都不做，界面仍显示「请按键…」，而监听还挂在 capture 阶段
 *      吞掉**全部**按键 —— 于是整个界面的键盘操作（上下键选卡、F5 刷新、
 *      Delete 删除）全失效。唯一的线索是那个小按钮上的四个字，
 *      用户根本不会注意到。卡在这种状态里比直接报错难查得多。
 *
 *      单按修饰键（Ctrl+A 里的那个 Ctrl）是**正常的中间态**，不是无效键：
 *      它要吞掉（否则单按 Alt 会激活菜单栏）并继续等，也不能提示 ——
 *      提示了就是每录一个组合键都闪一句"未识别"。两类必须分开。
 *
 * 第 1 节跑的是**从源码切出来的真身**，且 `comboFromEvent` 也是
 * utils/hotkeys.ts 的真身（loadTs 加载）—— 文本断言证明不了
 * "这一下到底会不会被当成无效键"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs, stripTS } from './testkit.mjs';
import { stripCommentsJs as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const rd = (p) => fs.readFileSync(p, 'utf8');
/** 剥注释：注释里写的反例会把形态断言带偏（这个项目踩过很多次） */
/* 剥注释走全仓共用实现（test-scan-utils.mjs） */
/**
 * 切出一段配平的 `{ ... }`。
 * **锚点后若紧跟 `=>`，要从箭头之后找左括号** —— 否则切到的是外层
 * （比如 `(e: KeyboardEvent) => {`）：编译出来是个啥也不做的函数，
 * 所有行为断言都会假绿。
 */
function sliceBraced(src, anchor, from = 0) {
  const at = src.indexOf(anchor, from);
  if (at < 0) return null;
  let s = at;
  const ar = src.indexOf('=>', at);
  if (ar >= 0 && ar - at < 80) s = ar + 2;
  const start = src.indexOf('{', s);
  if (start < 0) return null;
  let depth = 0, q = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** 把切出来的块编译成可执行函数（注入闭包里的自由变量） */
function compile(body, params, argName = 'e') {
  const names = Object.keys(params);
  // eslint-disable-next-line no-new-func
  const f = new Function(...names, `const fn = ${argName} => ${body}; return fn;`);
  return (...a) => f(...names.map((n) => params[n]))(...a);
}

/* ── 1. 录入态 onKey 真身行为 ────────────────────────────────── */
console.log('\n=== 1. 录入态按键处理（跑真身，comboFromEvent 亦为真身）===');
{
  const hk = await loadTs(path.join(HERE, 'utils/hotkeys.ts'));
  const src = rd(path.join(HERE, 'components/HotkeySettings.tsx'));
  const body = sliceBraced(src, 'const onKey = ');
  t('能切出录入态的 onKey', !!body);

  if (body) {
    /**
     * 造一次按键，返回这次按键干了什么。
     * 每次都重新编译一份：监听器里没有跨次状态，
     * 复用同一个闭包反而会让"上一次的调用记录"混进下一次断言。
     */
    const press = (ev) => {
      const r = { prevent: 0, stop: 0, setOne: [], setCap: [], setTip: [] };
      const fn = compile(body, {
        isComposing: (n) => !!(n && (n.isComposing === true || n.keyCode === 229)),
        MODIFIER_KEYS: hk.MODIFIER_KEYS,
        comboFromEvent: hk.comboFromEvent,
        capturing: 'refresh',
        setCapturing: (v) => r.setCap.push(v),
        setOne: (id, c) => r.setOne.push([id, c]),
        setTip: (m) => r.setTip.push(m),
      });
      fn({
        key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
        isComposing: false, keyCode: 0,
        ...ev,
        preventDefault() { r.prevent++; },
        stopPropagation() { r.stop++; },
      });
      return r;
    };

    /* 组合期：这一下归输入法 */
    {
      const r = press({ key: 'Process', isComposing: true, keyCode: 229 });
      t('组合期：不吞键（不 preventDefault）', r.prevent === 0);
      t('组合期：不拦传播', r.stop === 0);
      t('组合期：不录进键位', r.setOne.length === 0);
      t('组合期：不误报"未识别"', r.setTip.length === 0);
      t('组合期：不退出录入', r.setCap.length === 0);
    }

    /* Esc：退出录入 */
    {
      const r = press({ key: 'Escape' });
      t('Esc：退出录入（setCapturing(null)）', r.setCap.length === 1 && r.setCap[0] === null);
      t('Esc：清掉上一条提示', r.setTip.length === 1 && r.setTip[0] === null);
      t('Esc：吞掉（不冒到别处触发快捷键）', r.prevent === 1 && r.stop === 1);
      t('Esc：不录进键位', r.setOne.length === 0);
    }

    /* 单按修饰键：正常中间态，吞掉并继续等，不能提示 */
    {
      const r = press({ key: 'Control', ctrlKey: true });
      t('单按 Ctrl：吞掉（否则会惊动别处）', r.prevent === 1 && r.stop === 1);
      t('单按 Ctrl：不提示（不是无效键）', r.setTip.length === 0);
      t('单按 Ctrl：不录、不退出（还在等实键）', r.setOne.length === 0 && r.setCap.length === 0);
    }
    {
      const r = press({ key: 'Alt', altKey: true });
      t('单按 Alt：吞掉（否则会激活菜单栏）', r.prevent === 1);
      t('单按 Alt：不提示', r.setTip.length === 0);
    }

    /* Del：取消绑定 */
    {
      const r = press({ key: 'Delete' });
      t('Del：取消绑定（写入空串）', r.setOne.length === 1 && r.setOne[0][1] === '');
      t('Del：不提示', r.setTip.length === 0);
    }

    /* 正常组合键 */
    {
      const r = press({ key: 'a', ctrlKey: true });
      t('Ctrl+A：录成 mod+a', r.setOne.length === 1 && r.setOne[0][1] === 'mod+a',
        JSON.stringify(r.setOne));
    }
    {
      const r = press({ key: 'F5' });
      t('F5：录成 f5', r.setOne.length === 1 && r.setOne[0][1] === 'f5', JSON.stringify(r.setOne));
    }

    /* 识别不出来的键：必须说出来，不能静默卡住 */
    {
      const r = press({ key: 'ContextMenu' });
      t('无法识别的键：给出提示（此前静默 → 用户被锁在录入态里）', r.setTip.length === 1);
      t('提示里带上那个键名，用户才知道是哪一下没录上',
        r.setTip.length === 1 && String(r.setTip[0]).includes('ContextMenu'),
        String(r.setTip[0] || ''));
      t('无法识别的键：不 preventDefault（留默认行为，界面才不像死掉）', r.prevent === 0);
      t('无法识别的键：仍拦传播（不惊动应用内快捷键）', r.stop === 1);
      t('无法识别的键：不录、不退出（还在等）', r.setOne.length === 0 && r.setCap.length === 0);
    }
  }
}

/* ── 2. 形态：守卫在最前、修饰键清单只有一份 ──────────────────── */
console.log('\n=== 2. 形态（剥注释后判）===');
{
  const src = strip(rd(path.join(HERE, 'components/HotkeySettings.tsx')));
  const body = sliceBraced(src, 'const onKey = ');
  t('能切出 onKey（剥注释后）', !!body);
  if (body) {
    const iComp = body.indexOf('isComposing(e)');
    const iEsc = body.indexOf("e.key === 'Escape'");
    t('onKey 里有组合期判断', iComp > 0);
    t('组合期判断写在 Escape **之前**（写在后面等于先吞掉了）',
      iComp > 0 && iEsc > 0 && iComp < iEsc, `comp=${iComp} esc=${iEsc}`);
    t('组合期分支直接 return（不吞键）',
      /isComposing\(e\)\)\s*return/.test(body));
    t('用导入的 MODIFIER_KEYS，不另抄一份修饰键清单',
      body.includes('MODIFIER_KEYS.includes') && !/\[\s*'Shift'/.test(body));
  }
  const eff = src.slice(src.indexOf('window.addEventListener'), src.indexOf('window.removeEventListener'));
  t('effect 依赖里带上 draft（否则录入期间会用旧 draft 覆盖别处的改动）',
    /\}\s*,\s*\[capturing,\s*draft\]/.test(src.slice(src.indexOf('}, [capturing') - 40, src.indexOf('}, [capturing') + 40))
    || src.includes('[capturing, draft]'), '应含 [capturing, draft]');
  void eff;
  t('不再有无人使用的 allowEmpty 字段', !src.includes('allowEmpty'));
}

/* ── 3. utils/hotkeys.ts：修饰键清单唯一来源 ──────────────────── */
console.log('\n=== 3. utils/hotkeys.ts ===');
{
  const s = strip(rd(path.join(HERE, 'utils/hotkeys.ts')));
  t('导出 MODIFIER_KEYS', /export const MODIFIER_KEYS/.test(s));
  t('comboFromEvent 用的是这份清单（不是内联字面量）',
    s.includes('MODIFIER_KEYS.includes(k)'));
  /* 不能写成"全文不出现这个字面量"—— 那命中的正是清单自己的定义，
     断言恒假。要数次数：只有定义处那一份。 */
  t('修饰键字面量清单只出现一份（没有第二处抄写）',
    (s.match(/\[\s*'Shift',\s*'Control'/g) || []).length === 1,
    `实际 ${(s.match(/\[\s*'Shift',\s*'Control'/g) || []).length} 处`);
  t('已删掉无人使用的 allowEmpty', !s.includes('allowEmpty'));
  const mod = await loadTs(path.join(HERE, 'utils/hotkeys.ts'));
  t('MODIFIER_KEYS 真身含 Shift/Control/Alt/Meta',
    ['Shift', 'Control', 'Alt', 'Meta'].every((k) => mod.MODIFIER_KEYS.includes(k)));
  t('单按 Shift → comboFromEvent 返回 null',
    mod.comboFromEvent({ key: 'Shift', shiftKey: true }) === null);
}

/* ── 4. 兜底：window 级 keydown 监听都要有组合期判据 ───────────── */
console.log('\n=== 4. 兜底扫描：window 级 keydown 监听 ===');
{
  const dir = path.join(HERE, 'components');
  const files = fs.readdirSync(dir).filter((f) => /\.(tsx|ts)$/.test(f));
  const bad = [];
  let checked = 0;
  for (const f of files) {
    /* **剥注释后再扫**：注释里也写着 `addEventListener('keydown', ...)`，
       不剥会把注释当成一处监听，报出来的位置根本不是代码。 */
    const s = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
    let from = 0;
    for (;;) {
      const at = s.indexOf("addEventListener('keydown'", from);
      if (at < 0) break;
      /* 监听函数体写在 addEventListener **之前**（const onKey = …），
         所以窗口要往前取，只往后切 700 字符是什么也看不到的。 */
      const seg = s.slice(Math.max(0, at - 1600), at + 200);
      from = at + 10;
      checked++;
      const isEsc = seg.includes("'Escape'");
      const isEnter = seg.includes("'Enter'");
      /*
       * 必须钉**调用**（`isComposing(`），不能只钉名字：
       * 文件顶上那句 `import { isComposing } from '../utils/ime'` 里也有这
       * 几个字，只判名字的话，把真实判据整段删掉照样通过（假绿）。
       */
      const hasIme = /isComposing\s*\(/.test(seg);
      /* 焦点判据：Enter 那一处靠 `closest(INTERACTIVE)` —— 组合期必然
         焦点在输入元素里，命中即返回，所以不再要求它另加一条判据。 */
      const hasFocusGuard = seg.includes('closest') || seg.includes('INTERACTIVE');
      if (isEsc && !hasIme) bad.push(`${f}@${at} [Esc 无组合期判据]`);
      else if (isEnter && !hasIme && !hasFocusGuard) bad.push(`${f}@${at} [Enter 无判据]`);
      else if (!isEsc && !isEnter) bad.push(`${f}@${at} [未识别类型]`);
    }
  }
  t('扫到的 window 级 keydown 监听数 ≥ 1', checked >= 1, `实际 ${checked}`);
  t('每处都有防护（Esc 要组合期判据 / Enter 要焦点或组合期判据）',
    bad.length === 0, bad.join(', '));
}

/* ── 5. 语法卫生 ─────────────────────────────────────────────── */
console.log('\n=== 5. 语法卫生 ===');
{
  const s = rd(path.join(HERE, 'components/HotkeySettings.tsx'));
  const noStr = s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const bal = (a, b) => (noStr.split(a).length - noStr.split(b).length);
  t('HotkeySettings 大括号配平', bal('{', '}') === 0);
  t('HotkeySettings 圆括号配平', bal('(', ')') === 0);
  const h = rd(path.join(HERE, 'utils/hotkeys.ts'));
  const nh = h.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  t('hotkeys.ts 大括号配平',
    (nh.split('{').length - nh.split('}').length) === 0);
  void stripTS;
}

done();
