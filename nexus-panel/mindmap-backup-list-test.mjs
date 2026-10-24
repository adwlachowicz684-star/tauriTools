/**
 * 脑图「历史快照列表」读不全必须说出来 —— 回归测试
 * ============================================================
 *
 * 背景（与 BUG 164 / BUG 165 同源，只是发生在**显示**路径上）
 * ------------------------------------------------------------
 * store.js 里同时存在宽松版 `listBackups()` 与严格版 `listBackupsStrict()`。
 * 宽松版把「列举失败」和「个别读不出来」都降级成**短一截的数组** ——
 * 调用方拿到的仍是一个数组，看不出少了。
 *
 * 回收孤儿附件那里已经改成严格版（那份快照引用的资产会被当成没人引用删掉，
 * 不可恢复）。但**列表显示**这条路径还是宽松版，于是界面直接写「暂无快照」——
 * 而快照正是「误操作后可回滚」的唯一退路，用户会以为这份退路已经没了。
 *
 * 本文件锁住两件事：
 *   ① 判据 `backupListNote` 的行为（跑真身）；
 *   ② `openBackups` 在三种存储状态下**实际显示**什么（jsdom 真挂载）。
 *
 * 运行：cd nexus-panel && node mindmap-backup-list-test.mjs
 */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsFlat } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================
   零、测试框架（极简，与仓内其它测试同形）
   ============================================================ */

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail = '') {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? ' — ' + detail : ''));
  }
}

/* ============================================================
   一、jsdom 引导 + 极简 IndexedDB 桩
   ============================================================ */

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;

/*
 * 桩是**运行时可变**的：store.js 的 dbPromise 一旦打开就缓存，
 * 换不了第二份库，所以只能让同一个 objectStore 在不同场景下表现不同。
 */
const st = { keys: [], vals: {}, badKeys: new Set(), enumThrows: false };

const idbStore = {
  get(k) {
    if (st.badKeys.has(k)) throw new Error('读取被拒');
    return { result: st.vals[k] };
  },
  put() { return {}; },
  delete() { return {}; },
  getAllKeys() {
    if (st.enumThrows) throw new Error('列举被拒');
    return { result: st.keys.slice() };
  },
};

globalThis.indexedDB = {
  open() {
    const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    setTimeout(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => ({
          objectStore: () => idbStore,
          set oncomplete(cb) { setTimeout(() => cb(), 0); },
          set onerror(cb) { /* 不用触发 */ },
          set onabort(cb) { /* 不用触发 */ },
        }),
      };
      try { req.onupgradeneeded?.(); } catch { /* ignore */ }
      try { req.onsuccess?.(); } catch { /* ignore */ }
    }, 0);
    return req;
  },
};

const { backupListNote, openBackups } = await import('./plugins/mindmap/panels.js');

/* ============================================================
   二、判据跑真身
   ============================================================ */

console.log('\n=== 1. backupListNote 判据（跑真身） ===');
{
  const a = backupListNote({ list: null, failed: 0, enumFailed: true });
  ok(!!a.note, '列举失败要有警示（note 非空）');
  ok(!/暂无快照/.test(a.empty), '列举失败时列表里不许写「暂无快照」', `实际：${a.empty}`);
  ok(/读取失败/.test(a.empty), '列举失败时列表里要说"读不出来"', `实际：${a.empty}`);

  const b = backupListNote({ list: [{ key: 'k', ts: 1 }], failed: 2, enumFailed: false });
  ok(/2\s*份/.test(b.note), '个别读不出来要带上份数', `实际：${b.note}`);
  ok(!/暂无快照/.test(b.empty), '读不全时列表里也不许写「暂无快照」', `实际：${b.empty}`);

  const c = backupListNote({ list: [], failed: 0, enumFailed: false });
  ok(c.note === '', '读全了就不该有警示', `实际：${c.note}`);
  ok(c.empty === '暂无快照', '读全了且真的没有 → 才写「暂无快照」', `实际：${c.empty}`);

  /* 元断言：判据没失明 —— 宽松版的形状（没有 enumFailed 字段）不能被当成失败 */
  const d0 = backupListNote({ list: [], failed: 0 });
  ok(d0.note === '' && d0.empty === '暂无快照',
    '判据不会把"没带 enumFailed"误判成失败（否则老调用点全变红）',
    `实际 note=${d0.note} empty=${d0.empty}`);
  ok(backupListNote(null).note !== '', '传 null 也按读不出来处理（不许显示"暂无快照"）');
}

/* ============================================================
   三、openBackups 真挂载：三种存储状态下显示什么
   ============================================================ */

console.log('\n=== 2. openBackups 实际显示了什么（jsdom 真挂载） ===');

const stubApp = { api: { status() {} }, settings: {} };

async function openOnce() {
  const d = await openBackups(stubApp);
  const text = d.mask.textContent || '';
  return { d, text, notes: [...d.mask.querySelectorAll('.mm-hint')].map((e) => e.textContent || '') };
}

{
  /* ---- 2.1 读全了、真的没有 ---- */
  st.keys = []; st.vals = {}; st.badKeys = new Set(); st.enumThrows = false;
  const a = await openOnce();
  ok(/暂无快照/.test(a.text), '读全了且没有快照 → 显示「暂无快照」');
  ok(!/读取失败/.test(a.text), '读全了就不该出现"读取失败"');
  a.d.close();

  /* ---- 2.2 列举失败 ---- */
  st.enumThrows = true;
  const b = await openOnce();
  ok(/读取失败/.test(b.text), '列举失败 → 界面要说"读不出来"', `实际：${b.text.slice(0, 120)}`);
  ok(!/暂无快照/.test(b.text),
    '列举失败 → 不许显示「暂无快照」（快照是唯一退路，说"没有"是假话）',
    `实际：${b.text.slice(0, 120)}`);
  b.d.close();

  /* ---- 2.3 个别读不出来 ---- */
  st.enumThrows = false;
  st.keys = ['backup:00000000000001', 'backup:00000000000002'];
  st.vals = { 'backup:00000000000001': { ts: 1, sheets: [{ id: 's1' }], activeId: 's1' } };
  st.badKeys = new Set(['backup:00000000000002']);
  const c = await openOnce();
  ok(/1\s*份快照没读出来/.test(c.text), '个别读不出来 → 界面要说出份数', `实际：${c.text.slice(0, 160)}`);
  const btns = [...c.d.mask.querySelectorAll('button')].map((e) => e.textContent).filter((t) => t === '恢复');
  ok(btns.length === 1, '读得出来的那一份仍要显示出来（不是整段变空）', `恢复按钮 ${btns.length} 个`);
  ok(!/暂无快照/.test(c.text), '还有内容时不许写「暂无快照」');
  c.d.close();

  /*
   * 元断言：2.3 的桩真的让"读不出来"发生了 —— 否则上面几条都是空跑。
   *
   * ⓘ 两个键都要给上值：只清 badKeys 而 vals 里没东西的话，get 返回
   *   undefined → `!r.value` 照样算"读不出来"，于是这条元断言恒假 ——
   *   那正是"元断言自己空跑"的形状，比没有更糟（它会把真失败伪装成通过）。
   */
  st.badKeys = new Set();
  st.vals = {
    'backup:00000000000001': { ts: 1, sheets: [{ id: 's1' }], activeId: 's1' },
    'backup:00000000000002': { ts: 2, sheets: [{ id: 's2' }], activeId: 's2' },
  };
  const c2 = await openOnce();
  ok(!/没读出来/.test(c2.text) && !/读取失败/.test(c2.text),
    '元断言：坏键清空、值补齐后就不再报"没读出来"（证明上一条的桩生效了）',
    `实际：${c2.text.slice(0, 160)}`);
  const btn2 = [...c2.d.mask.querySelectorAll('button')].map((e) => e.textContent).filter((t) => t === '恢复');
  ok(btn2.length === 2, '元断言：读全了就列出全部 2 份', `恢复按钮 ${btn2.length} 个`);
  c2.d.close();
}

/* ============================================================
   四、源码契约：各处不得再用宽松版
   ============================================================ */

console.log('\n=== 3. 源码契约（剥注释后判定） ===');
{
  const readStripped = (rel) =>
    stripCommentsFlat(fs.readFileSync(path.join(HERE, rel), 'utf8').replace(/\r\n/g, '\n'));

  const p = readStripped('plugins/mindmap/panels.js');
  const i = readStripped('plugins/mindmap/index.js');

  /*
   * ⓘ 必须剥注释：这些文件里"为什么改"的注释本身就会写 `store.listBackups()`
   *   这个旧写法（这是本项目第三次栽在"注释里的字被断言当成依据"上）。
   */
  const LOOSE = /store\.listBackups\(\)/;

  ok(!LOOSE.test(p), 'panels.js 不再用宽松版 listBackups()（读不全会被当成"没有"）');
  ok(!LOOSE.test(i), 'index.js 不再用宽松版 listBackups()');
  ok(/listBackupsStrict/.test(p), 'panels.js 走严格版（剥注释后仍找得到，证明没把真代码剥掉）');
  ok(/listBackupsStrict/.test(i), 'index.js 走严格版');

  /* 元断言：判据没失明 */
  ok(LOOSE.test('const n = (await store.listBackups()).length;'),
    '元断言：宽松版写法会被认出来（否则上面两条恒为真）');

  /* 列表为空那句必须是判据给的，不能再写死字面量 */
  ok(/txt\.empty/.test(p), '列表为空时的那句话来自 backupListNote，不是写死的字面量');

  /* 清空快照：读不出份数时不许报"没有可清空的快照" */
  ok(/enumFailed/.test(p) && /未清空/.test(p),
    '清空快照读不出份数时要有专门那句（不许说"没有可清空的快照"）');

  /* 导出：读不全不许说成完整导出 */
  ok(/这份文件不完整/.test(i), '导出快照读不全要在提示里说明文件不完整');
  /* 导入：去重表读不全不许混进"已导入" */
  ok(/本机快照列表读不全/.test(i), '导入快照的去重表读不全要在汇总里说明');

  /*
   * 上面两条钉的是**提示文案**，改掉取数而留着文案也能蒙混过关 ——
   * 所以再按函数体钉一遍：这两个函数自己必须真的查 enumFailed。
   *
   * ⓘ 切片终点用 `\n  }`（两空格缩进的收尾，正是这两个函数的层级），
   *   不能用 `\n}` —— 那会切到更外层，把无关代码也算进来，断言恒真。
   */
  const bodyOf = (src, name) => {
    const at = src.indexOf(name);
    if (at < 0) return '';
    return src.slice(at, src.indexOf('\n  }\n', at));
  };
  const ex = bodyOf(i, 'async function exportBackups');
  const im = bodyOf(i, 'async function importBackups');
  ok(ex !== '' && im !== '', '两个函数体都切到了（切片没落空）');
  ok(/listBackupsStrict/.test(ex) && /enumFailed/.test(ex),
    'exportBackups 自己走严格版并判 enumFailed（读不出就不导出）');
  ok(/listBackupsStrict/.test(im) && /enumFailed/.test(im),
    'importBackups 的去重表走严格版并判 enumFailed（无法去重就不导入）');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
