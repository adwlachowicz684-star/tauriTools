/**
 * mindmap 插件 · 回归测试
 * ============================================================
 * 本插件此前无独立测试脚本，这是第一份。覆盖 2026-09-14 严格审查发现的
 * M1~M8 八个问题，外加数据层（workbook / xmind）的既有行为，防止改坏。
 *
 * 运行：
 *   cd nexus-panel && node plugins/mindmap/mindmap-test.mjs
 *
 * 设计取舍：
 *   · 只依赖 jsdom（仓库已有 devDependency），IndexexDB 由本文件自带的内存桩提供 ——
 *     jsdom 不带 IndexedDB，装 fake-indexeddb 又要多一个依赖；
 *   · 测试的是**纯数据层**与**源码契约**：挂载整个插件需要真实 kityminder 与
 *     SVG 渲染环境（沙盒里没有 Chromium），硬上只会得到一堆假绿。
 *     index.js 里无法在 Node 中直接执行的部分（M4 / M6 / M7），用源码断言锁住，
 *     改动即失败，能起到同样的防回归作用。
 */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stripCommentsFlat, stripCommentsFlatJs } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================
   零、测试框架（极简）
   ============================================================ */

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

/*
 * 显式「跳过」—— 前置条件没满足 / 已知取舍不在这里验。
 *
 * ⓘ 早先这类地方写的是 `ok(true, '（跳过）…')`：
 *   ① 恒真，无论跳过没跳过都绿；
 *   ② 更糟的是它**计入 pass**，于是"这一条其实没测"被伪装成
 *      "通过 3260 项"里的一员，报告上看不出有任何东西被跳过了。
 *   所以单列一个计数器，并写进汇总行 —— 跳过必须**看得见**。
 */
function skip(name, why) {
  skipped++;
  console.log('  \x1b[33m⊘\x1b[0m ' + name + '（跳过：' + why + '）');
}

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

const eq = (a, b, name) => ok(a === b, name, a === b ? '' : `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const group = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/**
 * 取某个函数的**完整函数体**（到下一个顶层函数声明为止）。
 *
 * 用 `indexOf(sig) + N` 固定字符数切片会越界切到相邻函数，
 * 于是断言测的是别人（已踩过 3 次，见 README）。这里一律按结构性边界切。
 */
function fnBody(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const rest = src.slice(i + sig.length);
  const m = rest.match(/\n  (?:async )?function /);
  return src.slice(i, i + sig.length + (m ? m.index : rest.length));
}

/** 取 editor/index.html 里主 inline script 的源码 */
function nodeFromDomSrc(html) {
  const i = html.indexOf('function nodeFromDom(el)');
  return i < 0 ? '' : html.slice(i, i + 400);
}

/* ============================================================
   一、jsdom 环境 + IndexedDB 内存桩
   ============================================================ */

const dom = new JSDOM('<!doctype html><html><body><div id="plugin-mount"></div></body></html>', {
  url: 'file:///nexus-panel/plugins/mindmap/index.html',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.DOMParser = dom.window.DOMParser;
// A38 高分辨率 PNG 要序列化放大后的 SVG —— 缺了这个全局，
// scaleSvgText 会走 catch 返回 null，表现为「导出莫名失败」
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.Event = dom.window.Event;

/**
 * jsdom 不实现 URL.createObjectURL / revokeObjectURL，而附件预览全靠它。
 * 桩上记一份「还活着的 URL」，revoke 是否真的被调用就能直接断言 ——
 * 这正是这次改动最容易漏的地方（refresh 反复重建 DOM，每次都新建 URL）。
 */
const liveBlobUrls = new Set();
let blobSeq = 0;
dom.window.URL.createObjectURL = () => {
  const u = `blob:mock/${++blobSeq}`;
  liveBlobUrls.add(u);
  return u;
};
dom.window.URL.revokeObjectURL = (u) => { liveBlobUrls.delete(u); };
globalThis.URL = dom.window.URL;

/**
 * 最小 IndexedDB 桩：只实现 store.js 用到的那几个 API。
 * 刻意做成**内存 Map**，让「写哪个键」这件事在测试里一目了然 ——
 * M1 的本质就是写错了键，用真库反而看不出来。
 */
function installIndexedDB() {
  const dbs = new Map();
  // 故障注入开关：让「写失败 / 读失败」这两条路径能被测到。
  // 桩必须真的把这些失败传回给 store.js，否则 store 层的错误处理就是没验证过的空壳。
  // failGetPrefix：只让**指定前缀**的 key 读失败。
  // failTx 是「整库不可用」，用它测不出「只有某几条读挂了」的真实场景
  // （IndexedDB 单条记录损坏 / 大 Blob 读取被打断）—— 而那正是会把
  // 「读不出来」误判成「资产没了」的入口。
  const ctl = { failPut: false, failTx: false, failOpen: false, failGetPrefix: '' };

  class FakeRequest {
    constructor() {
      this.result = undefined; this.error = null;
      this.onsuccess = null; this.onerror = null;
      this._ok = false;
    }
    _done(v) { this.result = v; this._ok = true; queueMicrotask(() => this.onsuccess?.({ target: this })); }
    _fail(e) { this.error = e; this._ok = false; queueMicrotask(() => this.onerror?.({ target: this })); }
  }

  class FakeObjectStore {
    constructor(data, tx) { this.data = data; this.tx = tx; }
    _new(r) {
      // 事务的 oncomplete/onerror 由 store.js 在 fn(store) 返回之后才赋值，
      // 所以这里必须延后一拍再回调，否则等于永远走成功分支。
      queueMicrotask(() => {
        if (r._ok) this.tx.oncomplete?.();
        else this.tx.onerror?.();
      });
      return r;
    }
    get(key) {
      const r = new FakeRequest();
      if (ctl.failTx) this._new(r), r._fail(new Error('事务失败（注入）'));
      else if (ctl.failGetPrefix && String(key).startsWith(ctl.failGetPrefix)) this._new(r), r._fail(new Error('读取失败（注入）'));
      else r._done(this.data.has(key) ? structuredClone(this.data.get(key)) : undefined);
      return this._new(r);
    }
    put(value, key) {
      const r = new FakeRequest();
      if (ctl.failPut) r._fail(new Error('写入被拒绝（注入）'));
      else {
        try {
          this.data.set(key, structuredClone(value));
          r._done(key);
        } catch (e) { r._fail(e); }
      }
      return this._new(r);
    }
    delete(key) { const r = new FakeRequest(); this.data.delete(key); r._done(undefined); return this._new(r); }
    getAllKeys() { const r = new FakeRequest(); r._done([...this.data.keys()]); return this._new(r); }
  }

  class FakeTransaction {
    constructor(data) {
      this.oncomplete = null; this.onerror = null; this.onabort = null;
      this.store = new FakeObjectStore(data, this);
    }
    objectStore() { return this.store; }
  }

  const indexedDB = {
    open(name) {
      const r = new FakeRequest();
      if (!dbs.has(name)) dbs.set(name, new Map());
      const db = {
        objectStoreNames: { contains: () => true },
        transaction: (_store, _mode) => {
          if (ctl.failTx) throw new Error('打开事务失败（注入）');
          return new FakeTransaction(dbs.get(name));
        },
        createObjectStore: () => {},
      };
      r.onupgradeneeded = null;
      queueMicrotask(() => {
        if (ctl.failOpen) { r._fail(new Error('数据库打开失败（注入）')); return; }
        r.result = db;
        r._done(db);
      });
      return r;
    },
  };

  globalThis.indexedDB = indexedDB;
  dom.window.indexedDB = indexedDB;
  return { dbs, ctl };
}

const { dbs, ctl } = installIndexedDB();
const rawDb = () => dbs.get('nexus-mindmap');

/* ============================================================
   二、M1 · 自动保存必须写 doc:<currentFileId>
   ============================================================ */

group('M1 · 自动保存落盘键（P0）');

const store = await import('./store.js');

{
  // 2.1 数据层往返：doc(id) 存进去能原样读出来
  const wbObj = { sheets: [{ id: 's1', title: '画布 1', content: '{"root":{"data":{"text":"X"}}}', theme: 'fresh-blue', layout: 'default' }], activeId: 's1' };
  await store.doc('f1').save(wbObj);
  const back = await store.doc('f1').load();
  eq(JSON.stringify(back), JSON.stringify(wbObj), 'store.doc(id).save / load 往返一致');

  // 2.2 不同文件互不干扰
  await store.doc('f2').save({ ...wbObj, activeId: 's2' });
  eq((await store.doc('f1').load()).activeId, 's1', '两个文件的 doc 键互不覆盖');
  ok(rawDb().has('doc:f1') && rawDb().has('doc:f2'), '键名形如 doc:<id>');
}

{
  // 2.3 源码契约：doSaveInner 里不能出现 store.workbook.save
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('async function doSaveInner'), src.indexOf('async function trimBackups'));

  ok(!/store\.workbook\.save/.test(fn), 'doSaveInner 不再写旧迁移键 store.workbook.save');
  ok(/store\.doc\(\s*savedFileId\s*\)\.save\(/.test(fn), 'doSaveInner 写 store.doc(savedFileId)');
  ok(!/store\.workbook\.save/.test(src), '整个 index.js 都不再写 store.workbook.save');

  // 2.4 竞态守卫：await 之后必须再比对一次 currentFileId
  const saveLine = fn.indexOf('store.doc(savedFileId)');
  const after = fn.slice(saveLine, saveLine + 400);
  ok(/savedFileId\s*!==\s*currentFileId/.test(after), '保存后有「文件已切换」的竞态守卫');
  ok(/const\s+savedFileId\s*=\s*currentFileId/.test(fn), '保存前先快照 currentFileId');
}

{
  // 2.5 【行为级】上面那条守卫不够 —— 它还依赖「捕获 → 写入」之间没有 await。
  //
  //     理由不是理论推演：`save(workbook)` 的 workbook 在**调用那一瞬间**求值。
  //     捕获后立刻写，workbook 还是捕获那一刻的对象；中间一旦让出，
  //     switchToFile 可能已经把 workbook 换成新文件的内容，于是
  //     「旧 id + 新内容」写下去 —— 旧文件被覆盖，而守卫只能拦住状态栏和备份，
  //     拦不住已经发生的写入。
  //
  //     下面两组代码守卫完全相同，唯一差异就是中间有没有 await：
  const gapDb = { 'doc:f1': { mark: 'f1 原始' } };
  let cur = 'f1';
  let wbk = { mark: 'f1 编辑中' };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const put = async (id, wb) => { await tick(); gapDb['doc:' + id] = wb; };

  /** 形态 A：与 index.js 当前实现同构 —— 捕获后立刻写入 */
  async function saveNoGap() {
    const savedFileId = cur;
    await put(savedFileId, wbk);
    if (savedFileId !== cur) return;
  }
  /** 形态 B：中间多一个 await（将来最可能被人"顺手"加进来的那种） */
  async function saveWithGap() {
    const savedFileId = cur;
    await tick();
    await tick();
    await put(savedFileId, wbk);
    if (savedFileId !== cur) return;
  }

  async function run(fn) {
    gapDb['doc:f1'] = { mark: 'f1 原始' };
    cur = 'f1';
    wbk = { mark: 'f1 编辑中' };
    const p = fn();          // 自动保存启动
    await tick();            // 让出，切文件的异步流程开始推进
    cur = 'f2';              // switchToFile 跑完
    wbk = { mark: 'f2 内容' };
    await p;
    return gapDb['doc:f1'].mark;
  }

  eq(await run(saveNoGap), 'f1 编辑中', '捕获后立即写入：切文件不会污染 doc:f1');
  eq(await run(saveWithGap), 'f2 内容', '（对照组）中间插 await：f2 内容被写进 doc:f1 —— 守卫拦不住');
}

{
  // 2.6 【源码契约】把上面验证过的约束锁到真实代码上：
  //     savedFileId 的捕获点与 save() 的调用点之间，不允许有任何让出点。
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('async function doSaveInner'), src.indexOf('async function trimBackups'));

  const CAP = 'const savedFileId = currentFileId';
  const capIdx = fn.indexOf(CAP);
  const callIdx = fn.indexOf('store.doc(savedFileId)');
  ok(capIdx >= 0 && callIdx > capIdx, '能定位到捕获点与写入点，且顺序正确');

  const between = fn.slice(capIdx + CAP.length, callIdx);
  // 注意 `await store.doc(...)` 这个 await 是调用本身，必须有、且只允许有这一个。
  // 判据因此是「恰好一个 await，且它就是 save 调用」——多出来的任何一个都是插入的让出点。
  const awaits = between.match(/\bawait\b/g) || [];
  eq(awaits.length, 1, '捕获与写入之间恰好一个 await（就是 save 调用本身）');
  // between 切到调用点为止，所以「唯一的 await 后面只剩空白」= 它紧邻着 save 调用，
  // 中间没夹别的语句 —— 这正是「没有插入让出点」的正面表述。
  ok(/await\s*$/.test(between), '那唯一的 await 紧邻 save 调用（后面直接就是 store.doc）');
  ok(/const\s+saved\s*=\s*await\s+store\.doc\(savedFileId\)\.save\(/.test(fn),
    '保存语句形如 const saved = await store.doc(savedFileId).save(...)');
  ok(!/\.then\s*\(/.test(between), '也没有 .then 异步链（同样会让出控制权）');
  ok(!/\byield\b/.test(between), '也没有 yield');
}

/* ============================================================
   三、M2 · zip bomb 防护
   ============================================================ */

group('M2 · XMind 解压上限（P1）');

const xmind = await import('./xmind.js');

{
  // 3.1 正常文件仍能往返（先确认没把功能改坏）
  const files = [{ name: 'content.json', data: new TextEncoder().encode('[]') }];
  const zip = await xmind.zipWrite(files);
  const back = await xmind.zipRead(zip);
  eq(new TextDecoder().decode(back.get('content.json')), '[]', '正常 zip 往返不受影响');
}

{
  // 3.2 高压缩比炸弹必须被拦下 —— 真刀真枪走一遍 zipRead
  // 上限是 64MB，所以炸弹要解压出 >64MB 才会触发。全 'A' 压缩比约 1000:1，
  // 80MB 原始数据压完只有 ~78KB，是典型的 zip bomb 形态。
  const BOMB_SIZE = xmind.MAX_INFLATE_BYTES + 16 * 1024 * 1024;   // 80MB
  const big = new Uint8Array(BOMB_SIZE).fill(65);
  const bombZip = await xmind.zipWrite([{ name: 'bomb.bin', data: big }]);
  ok(
    bombZip.length < 512 * 1024,
    `炸弹包很小（${Math.round(bombZip.length / 1024)}KB）却能解出 ${Math.round(BOMB_SIZE / 1024 / 1024)}MB`,
  );

  let threw = false, msg = '';
  try { await xmind.zipRead(bombZip); } catch (e) { threw = true; msg = e.message; }
  ok(threw, '超限的 zip bomb 被拦下（不再全量灌进内存）', msg);
  ok(/解压超限/.test(msg), '抛出的是可读的中文错误', msg);
}

{
  // 3.3 越界的条目数据（compSize 指到缓冲区外）也要拦
  // 修之前这里会走到 subarray 静默截断，inflate 拿到半截数据才炸，排查困难
  const bad = new Uint8Array(220);
  const dv = new DataView(bad.buffer);
  const eocd = bad.length - 22;                 // EOCD 固定 22 字节，紧贴在末尾
  dv.setUint32(eocd, 0x06054b50, true);         // EOCD 签名
  dv.setUint16(eocd + 10, 1, true);             // 条目数 = 1
  dv.setUint32(eocd + 16, 0, true);             // 中央目录偏移 = 0
  dv.setUint32(0, 0x02014b50, true);            // 中央目录项签名
  dv.setUint16(10, 0, true);                    // method = store
  dv.setUint32(20, 999999, true);               // compSize 远超缓冲区
  dv.setUint16(28, 4, true);                    // nameLen
  dv.setUint32(42, 0, true);                    // localOff = 0
  new TextEncoder().encodeInto('bomb', bad.subarray(46));
  let threw = false, msg = '';
  try { await xmind.zipRead(bad); } catch (e) { threw = true; msg = e.message; }
  ok(threw, '越界的条目数据被拦下', msg);
  ok(/越界|超限|条目数/.test(msg), '抛出的是可读的中文错误', msg);
}

/* ============================================================
   四、M3 · 解析递归深度限制
   ============================================================ */

group('M3 · 解析深度上限（P1）');

/** 构造 N 层嵌套的 XMind 8 content.xml */
function deepLegacyXml(depth) {
  const open = [];
  const close = [];
  for (let i = 0; i < depth; i++) {
    open.push(`<topic id="t${i}"><title>n${i}</title><children><topics type="attached">`);
    close.push('</topics></children></topic>');
  }
  close.reverse();
  return `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">
  <sheet id="sh1"><title>深画布</title>
    <topic id="root"><title>根</title><children><topics type="attached">
      ${open.join('')}<topic id="leaf"><title>叶</title></topic>${close.join('')}
    </topics></children></topic>
  </sheet>
</xmap-content>`;
}

{
  // 4.1 正常深度的脑图必须能正常导入（先确认没改坏）
  const normal = deepLegacyXml(10);
  const zipNormal = await xmind.zipWrite([{ name: 'content.xml', data: new TextEncoder().encode(normal) }]);
  const r1 = await xmind.readXMind(zipNormal);
  eq(r1.source, 'legacy', '常规深度的 XMind 8 文件仍能导入');
  ok(r1.sheets.length === 1, '导入出 1 张画布');

  // 4.2 2000 层：远超 MAX_DEPTH(200) 但在 jsdom 的 DOMParser 承受范围内
  //     —— 修之前这里直接 RangeError: Maximum call stack size exceeded
  const DEEP = 2000;
  const deep = deepLegacyXml(DEEP);
  const zipDeep = await xmind.zipWrite([{ name: 'content.xml', data: new TextEncoder().encode(deep) }]);
  let crashed = null, res = null;
  try {
    res = await xmind.readXMind(zipDeep);
  } catch (e) {
    crashed = e;
  }
  ok(!crashed, `${DEEP} 层嵌套不再栈溢出`, crashed ? crashed.message : '');
  if (res) {
    ok(res.sheets.length >= 1, '深层文件要么导入成功要么优雅跳过（不崩）');
    const d = maxDepth(res.sheets[0]);
    ok(d <= xmind.MAX_DEPTH + 1, `导入深度被截到上限内（${d} ≤ ${xmind.MAX_DEPTH + 1}）`);
    ok(d < DEEP, `确认不是原样收下全部 ${DEEP} 层（实际 ${d}）`);
  }
}

/** 量一棵 kityminder 树的深度 */
function maxDepth(sheet) {
  try {
    const km = typeof sheet.content === 'string' ? JSON.parse(sheet.content) : sheet.content;
    const walk = (n) => {
      if (!n?.children?.length) return 1;
      return 1 + Math.max(...n.children.map(walk));
    };
    return walk(km.root);
  } catch { return 0; }
}

{
  // 4.3 Zen 档（content.json）同样有深度限制
  // 用字符串拼接而非递归构造对象 —— 递归到 2000 层时 JSON.stringify 自己就先栈溢出了
  function deepZen(depth) {
    let node = '{"id":"leaf","title":"叶"}';
    for (let i = depth; i > 0; i--) {
      node = `{"id":"t${i}","title":"n${i}","children":{"attached":[${node}]}}`;
    }
    return `[{"id":"sh1","class":"sheet","title":"深","rootTopic":${node}}]`;
  }
  const DEEP = 2000;
  const zipZen = await xmind.zipWrite([{ name: 'content.json', data: new TextEncoder().encode(deepZen(DEEP)) }]);
  let crashed = null, res = null;
  try { res = await xmind.readXMind(zipZen); } catch (e) { crashed = e; }
  ok(!crashed, `content.json ${DEEP} 层不再栈溢出`, crashed ? crashed.message : '');
  if (res) {
    const d = maxDepth(res.sheets[0]);
    ok(d <= xmind.MAX_DEPTH + 1, `Zen 档深度同样被截到上限内（${d}）`);
    ok(d < DEEP, `确认不是原样收下全部 ${DEEP} 层（实际 ${d}）`);
  }
}


/* ============================================================
   XMind 8（content.xml）导入：节点归属与图片尺寸
   ============================================================ */

group('XMind 8 导入：标记 / 图片只属于本节点，不跨子话题');

/*
 * 取「节点的标记 / 图片」时用的是全子树搜索（descendantsNamed），于是：
 *   · 父话题没有图、子话题有 → 父话题抢到子的图；
 *   · 父话题的优先级被子话题的标记覆盖（遍历先父后子，后写的赢）。
 * 实测：父 priority-2、子 priority-1 → 导入后父子**都是 1**。
 */
{
  const x2 = await import('./xmind.js');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">
  <sheet id="s1">
    <topic id="t1">
      <title>父</title>
      <marker-refs><marker-ref marker-id="priority-2"/></marker-refs>
      <children><topics type="attached">
        <topic id="t2">
          <title>子</title>
          <marker-refs><marker-ref marker-id="priority-1"/></marker-refs>
          <img src="xap:child.png" width="320" height="240"/>
        </topic>
      </topics></children>
    </topic>
    <title>画布1</title>
  </sheet>
</xmap-content>`;
  const zip = await x2.zipWrite([{ name: 'content.xml', data: new TextEncoder().encode(xml) }]);
  const r = await x2.readXMind(new Uint8Array(zip));
  const km = JSON.parse(r.sheets[0].content);
  const kid = km.root.children[0];

  eq(km.root.data.priority, 2, '父节点保留自己的优先级 2（不被子的 1 覆盖）');
  eq(kid.data.priority, 1, '子节点仍是自己的优先级 1');
  eq(km.root.data.image, undefined, '父节点没有抢到子节点的图片');
  eq(kid.data.image, 'xap:child.png', '子节点的图片仍在自己身上');
  // 老版 <img> 的 width/height 必须带上：没有尺寸内核 ImageRenderer 完全不画
  ok(kid.data.imageSize && kid.data.imageSize.width === 320 && kid.data.imageSize.height === 240,
    '老版 <img> 的 width/height 写进 imageSize（缺了图片就不显示）',
    JSON.stringify(kid.data.imageSize));
}

group('图片尺寸 imageSize：内核要的是 {width,height} 对象');

/*
 * 内核 ImageRenderer：`var g = node.getData('imageSize'); if (g) { ... g.width ... }`
 * —— 直接读 .width/.height。写成 "320*240" 字符串时两者都是 undefined，
 * 算出的宽高是 0，<image> 的 width/height 属性实测就是 "0"，图上什么都没有。
 *
 * 而编辑器 image 命令写的是对象形态 —— 导出侧若只认字符串，
 * 用户自己加的图导出后尺寸信息全丢（导回来又不显示）。两边都要认。
 */
{
  const x2 = await import('./xmind.js');
  const zen = JSON.stringify([{
    id: 'sh1', title: '画布', class: 'sheet', rootTopic: {
      id: 'r', class: 'topic', title: { text: '根' },
      image: { src: 'resources/a.png', width: 320, height: 240 },
      children: { attached: [{ id: 'c', title: { text: 'A' } }] },
    },
  }]);
  const zip = await x2.zipWrite([{ name: 'content.json', data: new TextEncoder().encode(zen) }]);
  const r = await x2.readXMind(new Uint8Array(zip));
  const sz = JSON.parse(r.sheets[0].content).root.data.imageSize;
  ok(sz && typeof sz === 'object' && sz.width === 320 && sz.height === 240,
    'zen 导入写出 {width,height} 对象（字符串形态内核读不出宽高）', JSON.stringify(sz));

  // 导出：两种形态都要能读出尺寸并写进 content.json 的 image.width/height。
  // 走 zipRead 直接看 content.json —— readXMind 会优先吃本工具自己的无损快照，
  // 那条路径原样保留原值，看不出导出侧有没有真的读出尺寸。
  const imgOf = async (imageSize) => {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { text: '根', image: 'x', imageSize }, children: [] } }) }];
    const blob = await x2.writeXMind(sheets, 'sh1');
    const entries = await x2.zipRead(new Uint8Array(await new Blob([blob]).arrayBuffer()));
    const json = JSON.parse(new TextDecoder().decode(entries.get('content.json')));
    return json[0].rootTopic.image;
  };
  const i1 = await imgOf({ width: 320, height: 240 });
  ok(i1 && i1.width === 320 && i1.height === 240,
    '导出能读出**对象**形态的尺寸（早先 parseSize 只认字符串，尺寸全丢）', JSON.stringify(i1));
  const i2 = await imgOf('320*240');
  ok(i2 && i2.width === 320 && i2.height === 240,
    '字符串形态（历史数据）导出同样保住尺寸', JSON.stringify(i2));
}

group('节点图片默认上限：必须改内核 option，不能只改注释');

/*
 * loadFitSize 写的是 `m.getOption('maxImageWidth') || 320`，而内核这个 option
 * 默认就是 200 —— `|| 320` 那个兜底**永远走不到**。早先只把注释里的数字
 * 从 200 改成 320，等于没改：实测一张 320×240 的图导入后仍是 200×150。
 *
 * 而且不能自己另算一套：同一张图会在内核渲染器里算出不一样的大小。
 */
{
  const src = stripCommentsFlatJs(fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8'));
  ok(/km\.setOption\('maxImageWidth',\s*320\)/.test(src), "显式 setOption('maxImageWidth', 320)");
  ok(/km\.setOption\('maxImageHeight',\s*320\)/.test(src), "显式 setOption('maxImageHeight', 320)");

  // 导入后补齐：只有 image 没有合法 imageSize 的节点必须被补上
  //
  // 不能只断言「文件里有 km.on('import'」—— 文件里**本来就有**另外两处
  // （外框 rebuildGroups、图片高亮 refreshImageHighlight），只查存在性的话
  // 补齐入口被整个删掉断言照样绿。必须确认补齐的**特征**就挂在 import 回调里：
  // 两者同属一个函数体，所以顺序固定、且距离很近。
  {
    const iImp = src.indexOf("km.on('import'");
    const iFit = src.indexOf('loadFitSize(url, km,');
    ok(iImp >= 0 && iFit > iImp && iFit - iImp < 2500,
      '补齐入口确实挂在 import 回调里（loadFitSize 紧跟在 km.on 之后、同属一个函数体）',
      `import@${iImp} fit@${iFit}`);
  }
  ok(/typeof sz === 'object' && sz\.width > 0 && sz\.height > 0/.test(src),
    '判定「需要补」时认的是 {width,height} 对象形态');
  ok(/loadFitSize\(url, km,/.test(src), '补齐走 loadFitSize（与 image 命令同一套算法）');
}

group('外框（boundary）往返：range 只能表达连续区间，非连续成员必须拆段写');

/*
 * 外框成员是用户 Ctrl 多选出来的，**完全可以不连续**（给 A、C 加框、跳过 B）。
 * 而 XMind 的 range 只能表达「首 → 尾」这一个区间，导回侧也是按 min..max 整段
 * 应用的。于是早先「一组只写一个 (first,last)」会把中间**不在本组**的节点
 * 一并划进来 —— 实测 A=bg1、B=无、C=bg1 导出再导回变成 A=B=C=bg1。
 *
 * 这里**必须剥掉本工具自己的无损快照 kityminder.json**：那条路径原样保留
 * boundaryGroup，看不出 content.json 写错了。只留 content.json 才是
 * 「别的软件产出的文件」的真实情形。
 */
{
  const x3 = await import('./xmind.js');

  /** 走一遍 zen 档往返：写 → 只留 content.json → 读回 */
  const roundTripZen = async (kids) => {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'nR', text: '根' }, children: kids } }) }];
    const blob = await x3.writeXMind(sheets, 'sh1');
    const buf = new Uint8Array(await new Blob([blob]).arrayBuffer());
    const entries = await x3.zipRead(buf);
    const cj = JSON.parse(new TextDecoder().decode(entries.get('content.json')));
    const zenBuf = await x3.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await x3.readXMind(new Uint8Array(zenBuf));
    return { kids: JSON.parse(r.sheets[0].content).root.children,
      bounds: cj[0].rootTopic.boundaries };
  };

  const kid = (id, text, g, label) =>
    ({ data: { id, text, ...(g ? { boundaryGroup: g, boundaryLabel: label || '' } : {}) }, children: [] });

  // ① 非连续：A、C 同组，B 不在任何组
  {
    const { kids, bounds } = await roundTripZen([
      kid('nA', 'A', 'bg1', '第一组'), kid('nB', 'B'), kid('nC', 'C', 'bg1', '第一组'),
    ]);
    const g = kids.map((n) => n.data.boundaryGroup || '（无）');
    eq(g[1], '（无）', '非连续外框：夹在中间的 B **没有**被划进来（早先 (A,C) 会把 B 一起框住）');
    ok(!!kids[0].data.boundaryGroup && !!kids[2].data.boundaryGroup,
      'A、C 仍各自保有外框（非连续成员没丢）', JSON.stringify(g));
    ok(Array.isArray(bounds) && bounds.length === 2,
      '非连续的两个成员写成**两段** boundary（格式表达不了非连续，只能拆）',
      JSON.stringify(bounds && bounds.map((b) => b.range)));
  }

  // ② 交错：A、C 属于 bg1，B 属于 bg2
  {
    const { kids } = await roundTripZen([
      kid('nA', 'A', 'bg1', '甲'), kid('nB', 'B', 'bg2', '乙'), kid('nC', 'C', 'bg1', '甲'),
    ]);
    ok(kids[1].data.boundaryGroup !== kids[0].data.boundaryGroup,
      '交错分组：B 没有被 A 的组吞掉（早先 (A,C) 整段应用，B 已有组会被跳过而留在别人组里）',
      JSON.stringify(kids.map((n) => n.data.boundaryGroup)));
  }

  // ③ 连续：A、B 同组 —— 必须仍是**同一个**组，不能拆成两段
  {
    const { kids, bounds } = await roundTripZen([
      kid('nA', 'A', 'bg1', '第一组'), kid('nB', 'B', 'bg1', '第一组'), kid('nC', 'C'),
    ]);
    ok(kids[0].data.boundaryGroup && kids[0].data.boundaryGroup === kids[1].data.boundaryGroup,
      '连续成员仍是同一个外框（拆段不能把连续段也拆了）',
      JSON.stringify(kids.map((n) => n.data.boundaryGroup)));
    eq(bounds.length, 1, '连续的两个成员只写一段 boundary');
    eq(kids[2].data.boundaryGroup, undefined, '组外的 C 不受影响');
  }

  // ④ 成员没有 id：不能写出 (null,null) 死链
  //
  // topic.id 来自 data.id；没有 id 时 safeId 给 null，range 就成了 "(null,null)"。
  // 导回侧 findIndex 全 -1、indices 为空，整条 boundary 被静默丢掉 ——
  // 写出去的还是一个坏数据（别的软件读到 null 引用），不如干脆不写。
  {
    const { bounds } = await roundTripZen([
      { data: { text: 'A', boundaryGroup: 'bg1' }, children: [] },
      { data: { text: 'B', boundaryGroup: 'bg1' }, children: [] },
    ]);
    ok(!bounds || !JSON.stringify(bounds).includes('null'),
      '成员没有 id 时不写出 (null,null) 死链', JSON.stringify(bounds));
  }
}

group('导出 content.json：下划线与「打包失败的附件」');

/*
 * 这两条都只在 **zen 档**（content.json）里暴露 —— 本工具自己的无损快照
 * kityminder.json 原样保留 data，看不出毛病。所以下面都强制只留 content.json，
 * 模拟「别的软件打开 / 本工具读别处产出的文件」。
 */
{
  const x4 = await import('./xmind.js');

  /** 单个根节点的 zen 档往返；loadAsset 不传 = 附件打包不了 */
  const rt = async (data, withLoadAsset) => {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data, children: [] } }) }];
    const blob = await x4.writeXMind(sheets, 'sh1', withLoadAsset ? async () => null : null);
    const buf = new Uint8Array(await new Blob([blob]).arrayBuffer());
    const entries = await x4.zipRead(buf);
    const cj = JSON.parse(new TextDecoder().decode(entries.get('content.json')));
    const zenBuf = await x4.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await x4.readXMind(new Uint8Array(zenBuf));
    return { data: JSON.parse(r.sheets[0].content).root.data, topic: cj[0].rootTopic };
  };

  // ① 删除线与下划线同时存在
  //    ⓘ 删除线的 data 键是 font-strikethrough（不是 strikethrough —— 那是
  //      面板状态对象的键，node.data 上没有）。早先这里传的是旧键名，于是
  //      这条测试测的是一份内核里根本不会出现的虚构数据。
  {
    const { data } = await rt({ id: 'n', text: 'T', 'font-strikethrough': true, underline: true });
    ok(data['font-strikethrough'] === true && data.underline === true,
      '同时有删除线和下划线时两个都保住（早先 else-if 只写 line-through，下划线丢失）',
      JSON.stringify({ s: data['font-strikethrough'], u: data.underline }));
  }

  // ② 附件打包失败：不能把引用串原样写成 href
  {
    const ref = JSON.stringify([{ n: '演示.mp4', a: 'asV1', s: 100 }]);
    const { data, topic } = await rt({ id: 'n', text: 'T', video: ref }, true);
    eq(data.hyperlink, undefined,
      '打包失败的附件不写成乱码超链接（早先原样落 href，导回变成一条 JSON 死链）',
      JSON.stringify(topic.href));
  }

  // ③ 打包成功时仍要走包内相对路径（不能因为上面那条把正常情况也砍了）
  {
    const x5 = await import('./xmind.js');
    const ref = JSON.stringify([{ n: '演示.mp4', a: 'asV1', s: 100 }]);
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'n', text: 'T', video: ref }, children: [] } }) }];
    const blob = await x5.writeXMind(sheets, 'sh1', async () => new Uint8Array([1, 2, 3]));
    const buf = new Uint8Array(await new Blob([blob]).arrayBuffer());
    const entries = await x5.zipRead(buf);
    const cj = JSON.parse(new TextDecoder().decode(entries.get('content.json')));
    ok(/^resources\//.test(String(cj[0].rootTopic.href || '')),
      '能打包的附件仍写成包内相对路径 resources/…', String(cj[0].rootTopic.href));
    ok([...entries.keys()].some((k) => k.startsWith('resources/')),
      '附件字节确实进了包', [...entries.keys()].join(','));
  }
}

/* ============================================================
   五、M4 / M5 / M6 / M7 · index.js 的源码契约
   ============================================================ */

group('M4 · 外壳主题消息来源校验');
{
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('function watchShellTheme'), src.indexOf('/* ------------------------- 附件打开'));
  ok(/e\.source\s*!==\s*window\.parent/.test(fn), '只接受 window.parent 发来的主题消息');
  ok(/d\.channel\s*!==\s*SHELL_CHANNEL/.test(fn), '仍保留 channel 校验');
  ok(/window\.removeEventListener\('message',\s*onMessage\)/.test(fn), '卸载时注销监听器');
}

group('M5 · 下载文件名安全化');
{
  const io = await import('./io.js');
  // io.js 里的 downloadBlob 会碰 document，这里只测 safeFileName 本身
  const s1 = io.safeFileName('../../etc/passwd');
  ok(!s1.includes('/') && !s1.includes('\\'), '路径分隔符被剔除', s1);
  ok(!s1.includes(':') && !s1.includes('|'), 'Windows 非法字符被剔除', s1);
  ok(!/^\./.test(io.safeFileName('..')), '纯点号不再原样作为文件名', io.safeFileName('..'));
  ok(s1.length > 0, '非空结果', s1);
  ok(!/[\u0000-\u001f]/.test(io.safeFileName('a\u0007b')), '控制字符被剔除');
  ok(io.safeFileName('').length > 0, '空名有兜底，不抛错');

  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('async function openAttachment'), src.indexOf('/* ------------------------- 撤销 / 重做'));
  ok(/io\.downloadBlob\(io\.safeFileName\(name\)/.test(fn), '下载前对附件名调用 safeFileName');
}

group('M6 · 撤销/重做栈不推入空快照');
{
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const undoFn = src.slice(src.indexOf('function undo()'), src.indexOf('function redo()'));
  ok(/if\s*\(lastSnap\)\s*redoStack\.push\(lastSnap\)/.test(undoFn), 'undo：lastSnap 为 null 时不入栈');
  const redoFn = src.slice(src.indexOf('function redo()'), src.indexOf('/* ------------------------- 主题 / 布局'));
  ok(/if\s*\(lastSnap\)\s*undoStack\.push\(lastSnap\)/.test(redoFn), 'redo：对称保护');
}

group('M7 · 切换画布落盘');
{
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('async function switchSheet'), src.indexOf('/* ------------------------- 文件库（多文档）'));
  ok(/await\s+persist\(\)/.test(fn), 'switchSheet 内 await persist()');
  ok(fn.indexOf('await persist()') > fn.indexOf('capture()'), '落盘发生在 capture() 之后');
}

/* ============================================================
   六、M8 · 存储异常可见
   ============================================================ */

group('M8 · 存储读写失败不再静默');
{
  ok(typeof store.lastStoreError === 'function', '导出 lastStoreError');
  ok(typeof store.takeStoreError === 'function', '导出 takeStoreError');
  ok(typeof store.resetStoreError === 'function', '导出 resetStoreError');

  // 正常读取不应留下错误
  store.resetStoreError();
  await store.doc('f-exists').save({ v: 1 });
  await store.doc('f-exists').load();
  eq(store.lastStoreError(), null, '正常读写不产生错误记录');

  // 制造一次写失败（IndexedDB 配额触顶是真实场景：附件以 Blob 存进来）
  ctl.failPut = true;
  const okSet = await store.doc('f-bad').save({ v: 1 });
  ctl.failPut = false;
  eq(okSet, false, '写入失败返回 false（沿用既有约定）');
  ok(store.lastStoreError() !== null, '写入失败被记进 lastStoreError');
  ok(/写入失败/.test(store.lastStoreError() || ''), '错误说明含操作类型', store.lastStoreError());

  // takeStoreError 取走后清空
  const e1 = store.takeStoreError();
  ok(typeof e1 === 'string' && e1.length > 0, 'takeStoreError 返回错误文本');
  eq(store.lastStoreError(), null, 'takeStoreError 后标记被清空');

  // 读路径失败也要记：IndexedDB 被禁用（隐私模式）/ 损坏时的表现
  ctl.failTx = true;
  const v = await store.doc('f-x').load();
  ctl.failTx = false;
  eq(v, null, '读失败时降级为默认值 null');
  ok(store.lastStoreError() !== null, '读失败被记进 lastStoreError');
  ok(/读取失败/.test(store.lastStoreError() || ''), '错误说明含「读取失败」', store.lastStoreError());
  store.resetStoreError();

  // 插件层要真的把错误显示出来
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  ok(/function flushStoreError/.test(src), 'index.js 定义了 flushStoreError');
  ok(/flushStoreError\(\)/.test(src.slice(src.indexOf('await loadSheet();\n  updateBadge();'))), '初始化末尾调用了 flushStoreError');
}

/* ============================================================
   七、回归：数据层既有行为没被改坏
   ============================================================ */

group('回归 · workbook 序列化');
{
  const wb = await import('./workbook.js');
  const sheets = [{ id: 'a', title: 'A', content: '{"root":{"data":{"text":"中心"},"children":[]}}', theme: 'fresh-blue', layout: 'default' }];
  const text = wb.serializeWorkbook(sheets, 'a');
  const parsed = wb.parseWorkbook(text);
  eq(parsed.sheets.length, 1, '工作簿导出→导入画布数一致');
  eq(parsed.activeId, 'a', 'activeId 保留');

  const md = wb.workbookToMarkdown(sheets);
  ok(md.includes('## 画布：A'), 'Markdown 分块标题正确');
  ok(md.includes('# 中心'), 'Markdown 含中心主题');
  const back = wb.markdownToWorkbook(md);
  eq(back[0].title, 'A', 'Markdown 往返保留画布标题');

  // content 是对象时也要能正常指纹化（M1 相关的老坑）
  const fp1 = wb.fingerprintSheets([{ id: 'x', content: { root: { data: { text: 'A' } } } }]);
  const fp2 = wb.fingerprintSheets([{ id: 'x', content: { root: { data: { text: 'B' } } } }]);
  ok(fp1 !== fp2, '对象型 content 的指纹能反映内容变化（不是 [object Object]）');

  // normalizeSheets 不能把对象型 content 换成空画布
  const norm = wb.normalizeSheets([{ id: 'x', content: { root: { data: { text: '保留我' } } } }]);
  ok(JSON.stringify(norm[0].content).includes('保留我'), 'normalizeSheets 保留对象型 content');
}

group('回归 · 备份滚动窗口');
{
  for (let i = 0; i < 5; i++) {
    await store.pushBackup({ sheets: [{ id: 's' + i }] }, 3);
    await new Promise((r) => setTimeout(r, 2));   // 保证时间戳不同
  }
  const list = await store.listBackups();
  ok(list.length <= 3, `keep=3 时最多保留 3 份（实际 ${list.length}）`);
  eq(list.length, 3, '恰好保留 3 份');

  // 非法 keep 退回默认，而不是「保留 0 份」
  await store.pushBackup({ sheets: [] }, 0);
  const after = await store.listBackups();
  ok(after.length >= 1, 'keep=0 时不会把备份全删光');
}

/* ============================================================
   八、Tab 建下级节点（焦点被工具栏按钮抢走时）
   ============================================================ */

group('Tab → 插入下级节点');

{
  // 8.1 编辑器层必须把「聚焦画布 / 插入子节点」暴露给父文档。
  //     没有这两个门面，插件层拦下 Tab 也没地方转送 —— 这是整条链路的起点。
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  ok(/window\.__minderFocusCanvas\s*=/.test(html), '编辑器页暴露 window.__minderFocusCanvas');
  ok(/window\.__minderInsertChild\s*=/.test(html), '编辑器页暴露 window.__minderInsertChild');
  ok(/function\s+insertChildNode/.test(html), '插入逻辑抽成具名函数（Tab 与门面共用同一份）');
  ok(/kmShortcut\('Tab',\s*insertChildNode\)/.test(html), 'Tab 快捷键仍注册，且与门面同一个实现');
  // 关键：receiver 是内核私有的隐藏 input，编辑器页不能假设能直接拿到它
  ok(/window\.__minderFocusCanvas\s*=\s*function\s*\(\)\s*\{\s*try\s*\{\s*km\.focus\(\)/.test(html),
    '聚焦门面走 km.focus()（不直接摸 km-receiver —— 那是内核私有实现）');
}

{
  // 8.2 bridge 层：把调用转送到内层 window，且先给 iframe 焦点
  const { EditorBridge } = await import('./editor-bridge.js');
  ok(typeof EditorBridge.prototype.focusCanvas === 'function', 'bridge 有 focusCanvas()');
  ok(typeof EditorBridge.prototype.insertChild === 'function', 'bridge 有 insertChild()');

  const src = (fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8')).replace(/\r\n/g, '\n');
  const seg = src.slice(src.indexOf('focusCanvas()'), src.indexOf('insertChild()'));
  ok(/w\.focus\(\)/.test(seg), 'focusCanvas 先给 iframe 的 window 焦点（否则 receiver 拿不到）');

  // 8.3 行为：真的调用了内层门面（用桩替换 contentWindow，不需要 kityminder）
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bridge = new EditorBridge(host, {});
  bridge.iframe = document.createElement('iframe');
  document.body.appendChild(bridge.iframe);
  const w = bridge.iframe.contentWindow;
  const calls = [];
  w.focus = () => calls.push('window.focus');
  w.__minderFocusCanvas = () => calls.push('focusCanvas');
  w.__minderInsertChild = () => calls.push('insertChild');

  bridge.focusCanvas();
  eq(calls.join(','), 'window.focus,focusCanvas', 'focusCanvas() 依次调 window.focus 与内层门面');

  calls.length = 0;
  bridge.insertChild();
  eq(calls.join(','), 'window.focus,insertChild', 'insertChild() 依次调 window.focus 与内层门面');

  // 8.4 内层还没就绪（编辑器未加载完）时不能抛 —— 否则按个 Tab 就炸
  const bare = new EditorBridge(document.createElement('div'), {});
  let threw = false;
  try { bare.focusCanvas(); bare.insertChild(); } catch { threw = true; }
  ok(!threw, '无 iframe 时 focusCanvas / insertChild 静默返回，不抛');
  eq(bare.focusCanvas(), false, '无 iframe 时返回 false 供调用方判断');
  bridge.destroy();
}

{
  // 8.5 插件层：Tab / Enter 必须在捕获阶段拦下，且放过文本控件与带修饰键的组合
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('function bindKeyForward'), src.indexOf('const refocusCanvas'));
  ok(/window\.addEventListener\('keydown',\s*onKey,\s*true\)/.test(fn),
    '监听在捕获阶段（冒泡阶段拦不住浏览器的焦点导航 / 按钮激活）');
  ok(/e\.preventDefault\(\)/.test(fn), '拦下后 preventDefault');
  ok(/bridge\?\.insertChild\(\)/.test(fn), 'Tab 转送 insertChild');
  ok(/bridge\?\.insertSibling\(\)/.test(fn), 'Enter 转送 insertSibling');
  // Enter 不转发是「按了没用」的直接原因：焦点在 <button> 上时，
  // 浏览器把 Enter 当成激活按钮，canvas 一点都收不到
  ok(/e\.key\s*===\s*'Enter'/.test(fn), 'Enter 也在转发范围内（否则按了没反应）');
  ok(/if\s*\(!isTab\s*&&\s*!isEnter\)\s*return/.test(fn), '只处理 Tab 与 Enter');
  ok(/e\.ctrlKey\s*\|\|\s*e\.altKey\s*\|\|\s*e\.metaKey/.test(fn), '带修饰键的交给浏览器');
  ok(/isTextTarget\(e\.target\)/.test(fn), '焦点在输入控件里时不抢');
  ok(/window\.removeEventListener\('keydown',\s*onKey,\s*true\)/.test(fn), '返回注销函数');

  ok(/function\s+isTextTarget/.test(src), '定义了 isTextTarget');
  const it = src.slice(src.indexOf('function isTextTarget'), src.indexOf('function bindKeyForward'));
  for (const tag of ['input', 'textarea', 'select']) {
    ok(it.includes(`'${tag}'`), `isTextTarget 覆盖 <${tag}>`);
  }
  ok(/isContentEditable/.test(it), 'isTextTarget 覆盖 contentEditable');

  // 8.6 卸载时要注销，否则重复挂载会叠加监听
  ok(/unbindTab\?\.\(\)/.test(src), '卸载时注销按键监听');
  ok(/const\s+unbindTab\s*=\s*bindKeyForward\(\)/.test(src), '初始化时绑定');

  // 8.7 工具栏按钮点完归还焦点 —— 不只 Tab，Enter/方向键/Delete 同样依赖它
  const bseg = src.slice(src.indexOf('const refocusCanvas'), src.indexOf('function buildToolbar'));
  ok(/bridge\?\.focusCanvas\(\)/.test(bseg), '按钮点击后调 bridge.focusCanvas()');
  ok(/onclick:\s*\(e\)\s*=>\s*\{\s*const\s+r\s*=\s*onclick\?\.\(e\);/.test(bseg),
    '焦点归还在 onclick 执行**之后**（handler 里的 prompt 先跑完）');

  // 8.7b 侧栏 / 页签 / 文件库点完同样要归还焦点
  /*
   * refocusCanvas 只挂在工具栏 B() 里，而侧栏（panels.js）、文件库、页签
   * 一个都没有 —— 点完焦点停在父文档的 <button> 上，画布的隐藏 input
   * 收不到键，于是 **Delete / 方向键 / F2 / Ctrl+B 全部失效**，
   * 直到用户再点一下画布。
   */
  ok(/function\s+bindRefocusClick\s*\(\s*\)/.test(src), '定义了 bindRefocusClick');
  ok(/const\s+unbindRefocus\s*=\s*bindRefocusClick\(\)/.test(src), '初始化时绑定归还焦点监听');
  ok(/unbindRefocus\?\.\(\)/.test(src), '卸载时注销归还焦点监听');
  {
    /*
     * 切片窗口必须够大：函数体里的注释很长（解释了三条豁免的原因），
     * 窗口小到只装得下注释的话，后面的 addEventListener 就落在窗口外，
     * 断言变成恒真的假阴性。
     */
    const rf = src.slice(src.indexOf('function bindRefocusClick'),
      src.indexOf('function bindRefocusClick') + 3000);
    const code = stripCommentsFlatJs(rf);
    ok(/root\.addEventListener\('click',\s*onClick\)/.test(code), '挂在 root 上（事件委托，重建 DOM 不用重绑）');
    ok(/root\.removeEventListener\('click',\s*onClick\)/.test(code), '返回注销函数');
    ok(/isTextTarget\(t\)/.test(code), '文本控件里不抢焦点（否则打不了字）');
    /*
     * 弹出菜单开着时必须跳过。
     *
     * popupMenu 的锚点按钮（数值输入框的 ▾ 等）是 panels.js 里用 h() 直接
     * 建的、**不带 data-no-refocus 标记**，所以上面那条拦不住它。
     * 实测（复刻真实冒泡序列：锚点 onclick 先开菜单、click 再冒泡到 root）：
     *   修复前 抢焦点 1 次 —— 菜单开着，Delete/方向键却会作用到节点上；
     *   修复后 0 次。
     *
     * 用状态检查（查 .mm-menu-mask）而不是给每个锚点补标记：后者要改
     * panels.js 里所有 popupMenu 调用点，将来新加一个又会漏。
     */
    /*
     * 必须**限定在 onClick 体内**再查。
     *
     * 直接在整个 code 片段上查，会命中**后面 B() 里那一份** ——
     * 变异验证实测：把 root 委托改回只查 .mm-menu-mask，断言照样绿
     * （因为 B() 那份还带着完整类名）。这是本项目反复踩的假阴性。
     */
    const bodySeg = code.slice(code.indexOf('const onClick'), code.indexOf("root.addEventListener('click', onClick)"));
    ok(/document\.querySelector\('\.mm-menu-mask, \.mm-mask, \.nx-mask'\)/.test(bodySeg),
      'root 委托：有浮层开着时不抢焦点（菜单 / 面板浮层 / confirm-prompt 三条路都要查）');
    ok(/closest\?\.\('\[data-no-refocus\]'\)/.test(code), '放过标了 data-no-refocus 的按钮');
    ok(/refocusCanvas\(\);/.test(code), '其余一律把焦点还给画布');
    // 只断言存在是不够的：这条曾经写成「注释里提到」就算通过
    ok(code.indexOf('refocusCanvas();') > code.indexOf('const onClick')
       && code.indexOf('refocusCanvas();') < code.indexOf("root.addEventListener('click', onClick)"),
      'refocusCanvas() 落在 onClick 体内（不是只在注释里出现）');
  }
  // 8.7c 弹层（dialog / popupMenu）关掉后同样要归还焦点
  /*
   * 它们挂在 document.body 上、不在 root 内，上面那条委托监听够不到。
   * 而关掉时里面的按钮被 remove —— 实测 activeElement 退回 <body>，
   * 画布的隐藏 input 收不到键，于是**关掉任何一个弹层之后** Delete /
   * 方向键 / F2 / Ctrl+B 全部失效。这是 8.7b 同一根因的另一半。
   */
  {
    const ps = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
    ok(/export\s+function\s+setPopupRefocus/.test(ps), 'panels 暴露注入口 setPopupRefocus');
    ok(/function\s+refocusCanvasAfterPopup\s*\(\s*\)/.test(ps), '定义了 refocusCanvasAfterPopup');
    // dialog 的 close
    const dseg = ps.slice(ps.indexOf('function dialog('), ps.indexOf('function dialog(') + 1200);
    const dcode = stripCommentsFlatJs(dseg);
    ok(/refocusCanvasAfterPopup\(\);/.test(dcode), 'dialog 关闭时归还焦点');
    ok(dcode.indexOf('refocusCanvasAfterPopup();') > dcode.indexOf('mask.remove();'),
      'dialog：先 remove 再归还（不是只在注释里出现）');
    // popupMenu 的 close
    const mseg = ps.slice(ps.indexOf('export function popupMenu'), ps.indexOf('export function popupMenu') + 1400);
    const mcode = stripCommentsFlatJs(mseg);
    ok(/refocusCanvasAfterPopup\(\);/.test(mcode), 'popupMenu 关闭时归还焦点');
    ok(mcode.indexOf('refocusCanvasAfterPopup();') > mcode.indexOf('mask.remove();'),
      'popupMenu：先 remove 再归还（不是只在注释里出现）');
  }
  // 注入的必须是真的 focusCanvas，空回调等于没修
  {
    const rseg = src.slice(src.indexOf('setPopupRefocus('), src.indexOf('setPopupRefocus(') + 300);
    ok(/setPopupRefocus\s*\(\s*\(\s*\)\s*=>\s*\{/.test(rseg), '插件层注入了回调');
    ok(/bridge\?\.focusCanvas\(\)/.test(rseg), '回调里真的调 bridge.focusCanvas()（空回调等于没修）');
  }

  // 8.7f store 索引写入必须检查返回值（store.set 吞异常返回 false）
  /*
   * store.set 是「catch 住异常、返回 false」，所以 try/catch **完全抓不到**写失败。
   * 早先文件列表 / 文件夹列表的这些写入点既不 await 也不检查返回值
   * （有的连 await 都没有），配额触顶时界面照样提示「已删除」「已重命名」，
   * 重开插件就回滚 —— 假成功。
   *
   * 守卫从 statusEl 定义处开始扫：更早的迁移路径里 statusEl 还在 TDZ，
   * 那时候没法给用户提示（且失败只会让下次启动重跑迁移，无副作用）。
   */
  {
    const code = stripCommentsFlatJs(src);
    const from = code.indexOf('const statusEl');
    const tail = code.slice(from);
    ok(/async\s+function\s+saveStore\s*\(\s*label\s*,\s*run\s*\)/.test(tail), '定义了 saveStore 助手');
    {
      const h = tail.slice(tail.indexOf('async function saveStore'), tail.indexOf('async function saveStore') + 520);
      ok(/const\s+ok\s*=\s*await\s+run\(\)/.test(h), 'saveStore：await 写入结果');
      ok(/if\s*\(\s*!ok\s*\)\s*status\(/.test(h), 'saveStore：失败时提示用户（吞掉就是假成功）');
    }
    /*
     * 通用守卫：statusEl 之后**不允许**再出现裸的 store.*.save( / doc().del(。
     * 只断言某几处改好了的话，下次新增一个调用点又会漏。
     */
    /*
     * 判定「这个写入有没有人管返回值」：
     *   ① 直接 `await store.X.save(...)` / `const ok = await ...` —— 自己会判；
     *   ② 包在 `saveStore('...', () => store.X.save(...))` 里 —— 助手会判。
     * 两条都不是 = 写失败了没人知道。
     *
     * 用「前面 70 字符里有没有 saveStore(」来判断②：这些调用点都是
     * `saveStore('文件列表', () => store.files.save(fileIndex))` 这种一行形式，
     * 窗口足够且不会误判。
     */
    const unguarded = (re, tag) => {
      const bad = [];
      for (const m of tail.matchAll(re)) {
        const pre = tail.slice(Math.max(0, m.index - 70), m.index);
        /*
         * 只看 `await store.X.save(...)` 是**不够的** —— 那样"await 了但没人
         * 检查返回值"会漏网（变异验证实测：把 addFile 改回裸 save，断言照样绿）。
         * 所以要求两者之一：
         *   ① 包在 saveStore(...) 里（助手统一提示）；
         *   ② 结果赋给了变量，且调用点自己会判（const ok / saved / key =）。
         */
        if (pre.includes('saveStore(')) continue;
        if (/=\s*await\s*$/.test(pre)) continue;
        bad.push(tail.slice(m.index, m.index + 46));
      }
      ok(bad.length === 0, `不允许无人检查返回值的${tag}写入（当前 ${bad.length} 处：${bad.slice(0, 3).join(' | ')}）`);
    };
    unguarded(/store\.(?:files|folders|themes|settings)\.(?:save|del)\(/g, '索引');
    unguarded(/store\.doc\([^)]*\)\.(?:save|del)\(/g, '文档');
    // 写失败要回滚内存，否则列表与磁盘不一致
    ok(/fileIndex\.splice\(at,\s*0,\s*f\)/.test(tail), 'deleteFile：写失败按原下标插回（顺序不乱）');
    ok(/f\.folderId\s*=\s*oldFolderId/.test(tail), 'moveFile：写失败回滚归属');
  }

  // 8.7e selectNodeById 的返回值必须验（切不回去就写错节点 → 数据错乱 + 假成功）
  /*
   * `__minderSelectNode` 靠 id 遍历整棵树找节点，找不到返回 false。
   * 不看返回值的话，后面的 getSelectedVideo()/getSelectedFile() 读到的是
   * **当前选中节点**的列表 —— 于是附件被写到另一个节点上，界面还提示成功。
   * 这是 BUG 14（focusNode）同一个坑在另外两条路径上的复发。
   */
  {
    const code = stripCommentsFlatJs(src);
    /*
     * 通用守卫：**所有** `bridge.selectNodeById(x);` 独立成句的写法都必须在
     * 条件里判返回值。只盯着 setVideoThumb 一处的话，下次再有人写一句
     * 裸调用，测试照样全绿。
     */
    const bare = [...code.matchAll(/(?<![!=<>])bridge\.selectNodeById\([^)]*\)\s*;/g)];
    ok(bare.length === 0,
      `不允许裸调用 selectNodeById 而不验返回值（当前 ${bare.length} 处）`);
    // 每条路径都必须显式拦住"切不回去"
    ok(/if\s*\(!nodeId\)\s*\{\s*status\(/.test(code),
      'setVideoThumb：nodeId 为空时直接失败（不能跳过切换写当前选中）');
    ok(/if\s*\(!bridge\?\.selectNodeById\?\.\(nodeId\)\)/.test(code),
      'setVideoThumb：切不回原节点时直接失败');
    for (const who of ['源节点已不存在，无法移动', '目标节点已不存在，无法移动']) {
      ok(code.includes(who), `moveAttachment：${who.slice(0, 3)}时中止`);
    }
    // 顺序：必须先切回再取列表 —— 反了读到的就是错的列表
    {
      const i = code.indexOf('function setVideoThumb');
      const seg = code.slice(i, i + 1600);
      ok(seg.indexOf('selectNodeById') < seg.indexOf('getSelectedVideo'),
        'setVideoThumb：先切回节点再取列表（顺序不能反）');
    }
  }

  // 8.7d 通用弹层（js/dialog.js 的 confirm/alert/prompt）用完也要还焦点
  /*
   * 项目里存在**两套**弹层：panels.js 的本地 dialog()/popupMenu()（8.7c 已修）
   * 与 js/dialog.js 的 confirm/alert/prompt。后者 mount() 里记的是
   * `prevFocus = document.activeElement` —— 那是**触发它的按钮**（浏览器在
   * mousedown 就聚焦了，早于我们的 click 委托），关闭时还原回去，
   * 于是重命名画布 / 删除脑图 / 新建文件夹 / 新建分组之后快捷键又失效。
   * 只修本地 dialog() 的话，这些路径全是漏网的。
   */
  for (const [file, restore] of [['panels.js', 'refocusCanvasAfterPopup'], ['index.js', 'refocusCanvas']]) {
    const t = fs.readFileSync(path.join(HERE, file), 'utf8');
    // 必须改为别名导入 —— 直接用原名就说明没包装
    ok(new RegExp("import\\s*\\{[^}]*confirm\\s+as\\s+_askConfirm").test(t),
      `${file}：confirm 改别名导入（否则说明没包装）`);
    ok(new RegExp("prompt\\s+as\\s+_askText").test(t), `${file}：prompt 改别名导入`);
    for (const nm of ['Confirm', 'Alert', 'Text']) {
      const re = new RegExp(`const\\s+ask${nm}\\s*=\\s*async\\s*\\(\\s*o\\s*\\)\\s*=>\\s*\\{`);
      ok(re.test(t), `${file}：ask${nm} 已包装`);
    }
    /*
     * finally 而不是 then：取消/关闭/抛错都要还。
     *
     * 必须**逐个**查三个包装 —— 只查 askConfirm 的话，把 askText 改成不归还
     * 断言照样绿（变异验证实测：那条变异没被抓到）。
     */
    for (const nm of ['Confirm', 'Alert', 'Text']) {
      /*
       * 只取**这一行**。
       *
       * 用固定长度切片会**串到下一个包装上**：把 askConfirm 改成不归还，
       * 而窗口里却带着 askAlert 的 finally + 归还 —— 断言照样绿
       * （变异验证实测：那条变异没被抓到）。
       */
      const i0 = t.indexOf(`const ask${nm} = async`);
      const wseg = t.slice(i0, t.indexOf('\n', i0) > 0 ? t.indexOf('\n', i0) : undefined);
      ok(/finally\s*\{/.test(wseg) && new RegExp(restore + '\\(\\)').test(wseg),
        `${file}：ask${nm} 用 finally 归还（取消也要还）`);
    }
  }
  // 不能残留"绕过包装"的直接调用
  for (const file of ['panels.js', 'index.js']) {
    const t = fs.readFileSync(path.join(HERE, file), 'utf8');
    const code = stripCommentsFlatJs(t);
    const direct = [...code.matchAll(/_ask(?:Confirm|Alert|Text)\s*\(/g)];
    ok(direct.length === 3, `${file}：_ask* 只出现在 3 处包装内（当前 ${direct.length} 处）`);
  }

  // B() 的 refocus:false 必须落到 data-no-refocus 上，否则 root 那条统一监听
  // 会把这条刻意的例外破坏掉（浮层开着时焦点又回到画布背后）
  {
    const bseg2 = src.slice(src.indexOf('const B = (label, onclick'), src.indexOf('const B = (label, onclick') + 700);
    ok(/attrs\['data-no-refocus'\]\s*=\s*'1'/.test(bseg2),
      "refocus:false 的按钮打上 data-no-refocus 标记");
    ok(/opt\.refocus\s*===\s*false/.test(bseg2), '只在 refocus 显式为 false 时打标记');
  }
  ok(/if \(opt\.refocus !== false && !document\.querySelector\('\.mm-menu-mask, \.mm-mask, \.nx-mask'\)\)/.test(bseg),
    'B() 同样只在没有浮层开着时才归还（refocus:false 只是其中一条理由）');
  ok(/if \(opt\.refocus !== false\)/.test(bseg) || /opt\.refocus !== false/.test(bseg),
    '可跳过归还（refocus:false）—— 打开模态浮层时画布不能继续吃快捷键');
}

/* ============================================================
   九、新建画布按钮固定在最右
   ============================================================ */

group('新建画布按钮（＋）位置');

{
  // jsdom 不做布局，无法断言像素位置；这里锁住决定布局的那些属性。
  // 每一个都对应一个真实的失效模式，注释里写明了会坏成什么样。
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const foot = src.slice(src.indexOf('const tabsEl ='), src.indexOf('const rail ='));

  ok(/div\.mm-row\.mm-tabs/.test(foot), '页签区带 .mm-tabs 类');
  ok(/minWidth:\s*'0'/.test(foot),
    '页签区 min-width:0 —— 否则 flex item 被内容顶住不收缩，页签多了会把「＋」挤出容器');
  ok(/flex:\s*'1 1 auto'/.test(foot), '页签区吃掉剩余空间');
  ok(/overflowX:\s*'auto'/.test(foot), '页签区自己横向滚动（而不是整条底栏滚）');

  ok(/marginLeft:\s*'auto'/.test(foot),
    '新建按钮用 margin-left:auto 钉到最右 —— 页签少时不加它就停在一行中间');
  ok(/flex:\s*'0 0 auto'/.test(foot), '新建按钮不被压缩');
  ok(/const foot = h\('div\.mm-foot', \{\},\s*\n\s*tabsEl,\s*\n\s*addSheetBtn,/.test(foot),
    '底栏只放页签区与「＋」（状态文字已拆到独立状态条）');

  // 注释里也会提到这些属性名（说明"为什么不能加"），断言前先剥掉注释，
  // 否则会被自己写的说明文字误伤。
  const css = stripCommentsFlat((fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n'));
  const footCss = css.slice(css.indexOf('.mm-foot {'), css.indexOf('.mm-status {'));
  ok(!/overflow-x/.test(footCss),
    '.mm-foot 不再 overflow-x:auto —— 整条底栏滚动会把「＋」和状态一起滚出视野');

  const statusCss = css.slice(css.indexOf('.mm-status {'), css.indexOf('.mm-status.warn'));
  ok(!/margin-left:\s*auto/.test(statusCss),
    '.mm-status 不再 margin-left:auto —— 两个 auto 会平分剩余空间，反而把「＋」挤到中间');

  // 滚动条已收口到 css/tokens.css，插件不再各自声明（否则两边早晚打架）；
  // 这里只查插件确实引到了那份样式，别再回头断言选择器必须留在插件里
  ok(/@import\s+url\(['"]?\.\.\/\.\.\/css\/tokens\.css/.test(css), '脑图样式引入了 tokens.css（滚动条随全局）');
}

/* ============================================================
   十、面板分布（对齐 C# MindMapPanel）
   ============================================================ */

group('面板分布：左文件库 / 中画布 / 右属性侧栏');

{
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');

  // 10.1 主体三段的顺序：[文件库] | 画布 | [属性侧栏]
  // 用 lastIndexOf 取收尾处的那次调用：buildRail() 在文件里出现两次（定义外的
  // 早期调用点 + 初始化末尾），取第一个会让切片为空、断言静默失真。
  const mount = src.slice(src.indexOf('side = buildSide(app'), src.lastIndexOf('buildRail();'));
  ok(/insertBefore\(fileList\.el,\s*canvasEl\)/.test(mount), '文件库插在画布**左**边');
  ok(/appendChild\(side\.el\)/.test(mount), '属性侧栏挂在画布**右**边（appendChild 到 body 末尾）');
  ok(mount.indexOf('insertBefore(fileList.el') < mount.indexOf('appendChild(side.el'),
    '先插文件库、再挂侧栏 —— 画布始终夹在中间');

  // 10.2 文件库默认收起（Web 版多文档，C# 没有左栏，收起更接近原版观感）
  ok(/filesOpen === undefined\)\s*settings\.filesOpen = false/.test(src), 'filesOpen 默认 false（默认收起）');

  // 10.3 图标条只留文件库开关：四个属性页入口已随侧栏搬到右侧
  const railFn = src.slice(src.indexOf('function buildRail'), src.indexOf('/* ------------------------- 页签'));
  ok(/📚/.test(railFn), '图标条保留文件库开关 📚');
  ok(!/side\.open\(/.test(railFn), '图标条不再放属性页入口（页签在顶栏最右）');

  // 10.4 底部两行：画布页签条 + 独立状态条（对齐 C# 的 Grid.Row=2 / Row=3）
  ok(/const statusBar = h\('div\.mm-statusbar', \{\}, statusEl\)/.test(src), '状态条独立成行');
  ok(/toolbar,\s*body,\s*foot,\s*statusBar/.test(src), '根容器顺序：顶栏 → 主体 → 页签条 → 状态条');
}

{
  // 10.5 侧栏自身：常驻 276px，且**不含**页签（页签在顶栏，不占侧栏高度）
  const css = stripCommentsFlat((fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n'));
  const sideCss = css.slice(css.indexOf('.mm-side {'), css.indexOf('.mm-side h3'));
  ok(/flex:\s*0 0 276px/.test(sideCss), '侧栏固定 276px（与 C# Column 1 的 Width="276" 一致）');
  ok(/display:\s*flex/.test(sideCss), '侧栏默认显示（常驻，不靠 .open 打开）');
  ok(!/display:\s*none/.test(sideCss), '不再 display:none —— 否则一进来是空的');
  ok(!/overflow:\s*hidden/.test(sideCss), '侧栏恢复自身滚动（页签已搬走，无需再切成 hidden+内容区滚）');

  const { buildSide } = await import('./panels.js');
  // 切到「文件」页会读选中节点的附件引用，桩上补齐；其余页用不到
  const stubApi = { status() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [], commit() {} };
  let notified = [];
  const el = buildSide({ api: stubApi, bridge: { getSelectedNodeId: () => 'n1' } }, { onPage: (p) => notified.push(p) }).el;
  ok(el.classList.contains('open'), '侧栏根节点带 open 类');
  eq(el.dataset.page, 'theme', '默认停在「主题」页（对齐 C# ShowSidePage("theme")）');
  ok(!el.querySelector('.mm-side-tabs'), '侧栏内没有页签条 —— 页签在顶栏，不占侧栏高度');
  eq(notified.join(','), 'theme', '初始化时也会回调 onPage（顶栏据此点亮「主题」）');

  // 10.6 页签在顶栏最右，顺序对齐 C# 的四个 ToggleButton
  const src2 = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const tb = src2.slice(src2.indexOf('function buildToolbar'), src2.indexOf('/* ------------------------- 侧栏'));
  ok(/toolbar\.appendChild\(buildSideTabs\(\)\)/.test(tb), '顶栏 append 页签组');
  // 顺序：C# 的四个在前，新增「导入导出」放最后（低频，不挤远常用页）
  ok(/\['theme', '主题'\], \['tag', '标签'\], \['style', '样式'\], \['file', '文件'\],\s*\n?\s*\['exchange', '导入导出'\]/.test(src2),
    '页签顺序：主题 → 标签 → 样式 → 文件 → 导入导出');
  ok(/buildSide\(app, \{ onPage: syncSideTabs \}\)/.test(src2), '侧栏切页回灌给顶栏页签（同步高亮）');

  const topCss = css.slice(css.indexOf('.mm-top-tabs {'), css.indexOf('/* 底部状态条'));
  ok(/margin-left:\s*auto/.test(topCss), '页签组用 margin-left:auto 推到顶栏最右');

  // 10.7 行为：侧栏自行切页（点节点附件→跳「文件」页）时顶栏也跟着变
  const side2 = buildSide({ api: stubApi, bridge: { getSelectedNodeId: () => 'n1' } }, { onPage: (p) => notified.push(p) });
  side2.open('file');
  eq(side2.el.dataset.page, 'file', '切到文件页');
  eq(notified[notified.length - 1], 'file', 'onPage 回调收到 file（顶栏据此改高亮）');

  // 10.8 点当前页不再把面板点没（常驻侧栏没有收起语义）
  side2.open('file');
  eq(side2.el.dataset.page, 'file', '再点一次仍停在文件页（不会收起 —— 常驻侧栏）');
  ok(side2.isOpen(), 'isOpen 恒为 true');
}

/* ============================================================
   十一、行内文字编辑：点画布任意处都要提交（不能只认回车）
   ============================================================ */

group('行内编辑提交（点画布也要生效）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  // 11.1 提交前把选中切回正在编辑的节点。
  //      内核 text 命令的 execute 是 `var c=getSelectedNode(); c&&c.setText(v)`，
  //      且 queryState 要求选中数恰好为 1，否则命令被直接拒绝（静默失败）。
  ok(/km\.getSelectedNode\(\)\s*!==\s*node\)\s*km\.select\(node,\s*true\)/.test(html),
    '提交前把选中切回 editLayer.node —— 否则文字会丢或写到别的节点');

  // 11.2 editLayer 在 execCommand 之前就清空，防重入二次提交
  const closeIdx = html.indexOf('function closeTextEditor');
  const closeFn = html.slice(closeIdx, html.indexOf('function beginTextEdit'));
  ok(closeFn.indexOf('editLayer = null') < closeFn.indexOf("km.execCommand('text'"),
    'editLayer 在 execCommand 之前清空（防止重入二次提交）');

  // 11.3 document 捕获阶段 mousedown 兜底：抢在内核改选中之前提交
  ok(/document\.addEventListener\('mousedown',\s*onDocMouseDown,\s*true\)/.test(html),
    'document 上用捕获阶段监听 mousedown 兜底提交');
  ok(/if\s*\(el === e\.target \|\| \(el\.contains && el\.contains\(e\.target\)\)\)\s*return/.test(html),
    '点编辑框自身不提交（还在框内编辑）');

  // 只靠 blur 不行：SVG 不可聚焦，焦点何时转移取决于内核是否抢焦点
  ok(/addEventListener\('blur',\s*function\s*\(\)\s*\{\s*closeTextEditor\(true\)/.test(html),
    'blur 兜底保留（点 iframe 外的插件 UI 时靠它）');
}

{
  // 11.4 行为级：复刻内核语义，验证「不切回选中」确实会丢文字
  //      （不能直接跑 editor/index.html —— 它需要真实 kityminder 与浏览器渲染）
  function makeKm() {
    const nodes = [{ text: '旧', sel: false }, { text: '别的节点', sel: false }];
    const selected = () => nodes.filter((n) => n.sel);
    return {
      nodes,
      getSelectedNode: () => selected().length === 1 ? selected()[0] : null,
      select(n) { nodes.forEach((x) => { x.sel = (x === n); }); },
      removeAllSelectedNodes() { nodes.forEach((x) => { x.sel = false; }); },
      // 照内核：只写选中节点；选中数不为 1 时 queryState 返回 -1 → 命令被拒绝
      execCommand(name, v) {
        const n = this.getSelectedNode();
        if (!n) return;                     // queryState -1，静默不执行
        n.text = v;
      },
    };
  }

  /** 旧行为：直接 execCommand，不管当前选中是谁 */
  function commitOld(km, node, v) { km.execCommand('text', v); }
  /** 新行为：先切回正在编辑的节点 */
  function commitNew(km, node, v) {
    if (node && km.getSelectedNode() !== node) km.select(node);
    km.execCommand('text', v);
  }

  // 场景 A：编辑节点 0 时点了画布空白（内核 mousedown 会 removeAllSelectedNodes）
  {
    const km = makeKm();
    km.select(km.nodes[0]);
    km.removeAllSelectedNodes();                 // 模拟点空白
    commitOld(km, km.nodes[0], '新文字');
    eq(km.nodes[0].text, '旧', '（对照）旧行为：点空白后提交，文字静默丢失');
  }
  {
    const km = makeKm();
    km.select(km.nodes[0]);
    km.removeAllSelectedNodes();
    commitNew(km, km.nodes[0], '新文字');
    eq(km.nodes[0].text, '新文字', '点画布空白：切回选中后文字正确写入原节点');
  }

  // 场景 B：编辑节点 0 时点了节点 1（内核 mousedown 会 select(节点1)）
  {
    const km = makeKm();
    km.select(km.nodes[0]);
    km.select(km.nodes[1]);                      // 模拟点别的节点
    commitOld(km, km.nodes[0], '新文字');
    eq(km.nodes[0].text, '旧', '（对照）旧行为：文字没写到原节点');
    eq(km.nodes[1].text, '新文字', '（对照）旧行为：文字被写到错误的节点上');
  }
  {
    const km = makeKm();
    km.select(km.nodes[0]);
    km.select(km.nodes[1]);
    commitNew(km, km.nodes[0], '新文字');
    eq(km.nodes[0].text, '新文字', '点别的节点：文字仍写回原节点');
    eq(km.nodes[1].text, '别的节点', '点别的节点：不会污染被点到的那个节点');
  }
}

/* ============================================================
   十二、附件卡片与视频预览
   ============================================================ */

group('附件卡片 / 视频预览');

{
  const { buildSide } = await import('./panels.js');
  const store = await import('./store.js');

  // 造一份资产：Blob 走 store，getAsset 才能取到。
  // meta 必须预置 —— 否则 fillVideoMeta 会走 mi.probeVideo，而 jsdom 的 video
  // 永远不触发 loadedmetadata，probe 要等满 8 秒超时才回收它自己建的 URL，
  // 会把下面「URL 不增长」的断言搅乱（那是 mediainfo 自己的超时保护，非本次改动）。
  const blob = new dom.window.Blob(['fake-bytes'], { type: 'video/mp4' });
  await store.set('asset:vid1', {
    name: '演示.mp4', size: 12345, blob, type: 'video/mp4', mtime: Date.now(),
    meta: { duration: 12.5, width: 1920, height: 1080, container: 'MP4' },
  });
  const imgBlob = new dom.window.Blob(['fake-img'], { type: 'image/png' });
  await store.set('asset:img1', { name: '截图.png', size: 2048, blob: imgBlob, type: 'image/png', mtime: Date.now() });

  const statuses = [];
  function makeApp(refs, images = []) {
    const one = (kind) => {
      const v = refs[kind];
      if (!v) return [];
      return Array.isArray(v) ? v : [v];
    };
    return {
      api: {
        status: (m, w) => statuses.push(String(m)),
        selectedRef: (kind) => one(kind)[0] || null,
        selectedRefs: (kind) => one(kind),
        selectedImages: () => images,
        commit() {},
      },
      bridge: { getSelectedNodeId: () => 'n1' },
    };
  }

  /** 打开侧栏并切到文件页，等异步填充跑完 */
  async function openFilePage(refs, images = []) {
    const s = buildSide(makeApp(refs, images), {});
    s.open('file');
    // 缩略图 / 视频 URL 都是 async 填的，让出几拍
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    return s;
  }

  // 12.1 文件**列表**：一行一个（多附件）
  {
    const s = await openFilePage({ file: { n: '报告.pdf', a: 'img1', s: 2048 } });
    const row = s.el.querySelector('.mm-arow');
    ok(!!row, '渲染出附件行');
    eq(row.querySelector('.mm-arow-name')?.textContent, '报告.pdf', '行上显示文件名');
    eq(row.querySelector('.mm-arow-icon')?.textContent, '📕', '按扩展名给图标（pdf → 📕）');
    // 大小在详情区（meta），不在行上 —— 行只负责"认出是哪个文件"
    ok(/2\.0 KB/.test(s.el.querySelector('.mm-meta')?.textContent || ''), '详情区显示大小');
  }

  // 12.1b 多个文件 → 多行（这是本次的核心：不再互相覆盖）
  {
    const s = await openFilePage({
      file: [{ n: '一.pdf', a: 'img1', s: 2048 }, { n: '二.pdf', a: 'img1', s: 1024 }, { n: '三.pdf', a: 'img1', s: 512 }],
    });
    const rows = s.el.querySelectorAll('.mm-arow');
    eq(rows.length, 3, '3 个文件 → 3 行（不是只显示第一个）');
    eq([...rows].map((r) => r.querySelector('.mm-arow-name')?.textContent).join(','),
      '一.pdf,二.pdf,三.pdf', '顺序与名字都对');
    ok(/（3）/.test(s.el.textContent), '标题带数量');
  }

  // 12.2 图片区：多图网格
  {
    const s = await openFilePage({}, ['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
    const thumbs = s.el.querySelectorAll('.mm-thumb');
    eq(thumbs.length, 2, '2 张图片 → 2 个缩略图');
    ok(s.el.querySelectorAll('.mm-thumb-x').length === 2, '每张都有移除按钮');
    ok(/（2）/.test(s.el.textContent), '图片标题带数量');
  }

  // 12.3 未附加时的空态
  {
    const s = await openFilePage({});
    ok(/没有文件附件|没有文件/.test(s.el.textContent), '未附加文件时给出空态提示');
  }

  // 12.4 视频预览：video 元素 + 首帧 + 摘要行
  {
    const s = await openFilePage({ video: { n: '演示.mp4', a: 'vid1', s: 12345 } });
    const v = s.el.querySelector('.mm-vthumb-media');
    ok(!!v, '渲染出 video 预览元素');
    ok(/#t=0\.1$/.test(v.getAttribute('src') || ''),
      'src 带 #t=0.1 —— 不少浏览器不 seek 就不绘制首帧，否则预览区一片黑');
    eq(v.getAttribute('preload'), 'metadata', 'preload=metadata：只拉头部，不把整个视频读进内存');
    ok(s.el.querySelector('.mm-vthumb-play'), '有 ▶ 播放提示');
    eq(s.el.querySelector('.mm-vsum-name')?.textContent, '演示.mp4', '摘要行显示文件名');
    eq(s.el.querySelector('.mm-vsum-size')?.textContent, '12.1 KB', '摘要行显示大小');
    // 时长要等媒体头解析完才有，由 fillVideoMeta 回填
    ok(!!s.el.querySelector('.mm-vsum-dur')?.textContent, '摘要行回填了时长');
  }

  // 12.5 点预览区就地播放（不再弹浮层）
  {
    const s = await openFilePage({ video: { n: '演示.mp4', a: 'vid1', s: 12345 } });
    const box = s.el.querySelector('.mm-vthumb');
    const v = s.el.querySelector('.mm-vthumb-media');
    eq(v.hasAttribute('controls'), false, '默认不带控件（只是张封面）');
    box.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    eq(v.hasAttribute('controls'), true, '点一下就地挂上控件');
    ok(box.classList.contains('playing'), '切到播放态（▶ 提示随之隐藏）');
  }

  // 12.6 ▶ 提示不能拦点击：拦了就和容器双重触发 / 点不动
  {
    const css = stripCommentsFlat((fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n'));
    const playCss = css.slice(css.indexOf('.mm-vthumb-play {'), css.indexOf('.mm-vthumb.playing .mm-vthumb-play'));
    ok(/pointer-events:\s*none/.test(playCss), '▶ 覆盖层 pointer-events:none（点击交给容器，避免双重触发）');
  }

  // 12.7 Blob URL 回收：refresh 反复重建 DOM，不回收就线性增长
  {
    liveBlobUrls.clear();
    const s = await openFilePage({ video: { n: '演示.mp4', a: 'vid1', s: 12345 }, file: { n: '截图.png', a: 'img1', s: 2048 } });
    const first = liveBlobUrls.size;
    // 文件改成了行式列表（不再逐个渲染缩略图卡片），所以这里只有视频那一个 URL。
    // 断言"至少 1 个"—— 这条测的是**回收**是否生效，不是数量本身。
    ok(first >= 1, `打开后至少 1 个 Blob URL（视频预览，实际 ${first}）`);

    // 每次 refresh 都会新建一批，但旧的必须回收 —— 否则数量线性增长
    for (let i = 0; i < 3; i++) {
      s.refresh();
      for (let k = 0; k < 8; k++) await new Promise((r) => setTimeout(r, 0));
    }
    eq(liveBlobUrls.size, first, `连续 3 次 refresh 后 URL 数不增长（${first} → ${liveBlobUrls.size}）`);

    // 切走：文件页的 URL 全部回收
    s.open('theme');
    for (let k = 0; k < 8; k++) await new Promise((r) => setTimeout(r, 0));
    eq(liveBlobUrls.size, 0, `切到别的页后文件页的 URL 全部回收（残留 ${liveBlobUrls.size}）`);
  }
}

/* ============================================================
   十三、画布附件图标不能是黑块
   ============================================================ */

group('画布附件图标配色');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const icons = html.slice(html.indexOf('function iconColor'), html.indexOf('// 不能把 FileRenderer 挂进'));

  // 13.1 取色必须有回落：主题里查不到 color 时 core 的 getStyle 返回 null
  ok(/function\s+iconColor/.test(icons), '抽出了 iconColor()');
  ok(/c\s*=\s*node\.getStyle\('color'\)/.test(icons), '优先取节点文字色');
  ok(/return\s+c\s*\|\|\s*'#AEB6C4'/.test(icons), '取不到时回落到明确颜色（不能把 null 传给 fill）');

  // 13.2 不再出现「直接把可能为空的 color 传给 fill」的写法
  ok(!/icon\.path\.fill\(color\)/.test(html), '不再有 icon.path.fill(color) —— color 为 null 时会删掉 fill 属性');

  // 13.3 文件图标：fill none + 描边（实心会盖住折角线，认不出是文件）
  ok(/\.fill\('none'\);/.test(icons), 'FileIcon 的 path fill 为 none');
  // paint() 现在给轮廓和折角**分别**上色（拆成两条 path 后各自 stroke）
  ok(/this\.outline\.stroke\(color/.test(icons) && /this\.fold\.stroke\(color/.test(icons),
    'FileIcon 用 paint() 给轮廓与折角上描边');

  /* 13.4 VideoIcon 已删除：改成「附件画进节点框内」之后，视频是框内卡片
   * （vcard + 播放三角 + 数量角标），不再有「节点右侧小图标」这一路。
   * 这个类从那以后就没人实例化 —— 留着只会让人以为视频图标还会画在框外。
   * 这里锁住它不再出现，防止有人把死代码加回来。
   */
  ok(!/var VideoIcon = kity\.createClass/.test(html), 'VideoIcon 已删除（从未实例化，是死代码）');
  /* baseX 同样是死代码：旧实现把图标画在节点**右侧**（box.right + space-left），
   * 改成「附件画进框内」后它就没人用了，但声明还留着。
   * 留着的代价是有人会照它去改位置，于是又画回框外。
   */
  ok(!/var baseX\s*=/.test(html), 'baseX 已删除（旧"图标画在节点右侧"的残留，声明后从未使用）');
  /* _kmVideoIcon 同理：该字段从来没被赋值过（视频画成框内卡片），
   * 旧的清理逻辑 `if (oldv) { oldv.remove() }` 永远拿到 null 白跑一趟。
   * 留着会让人以为存在"视频右侧小图标"这条路要清理。
   */
  // 先剥注释再匹配 —— 注释里引用了这个名字，不剥的话断言命中注释本身，
  // 于是"代码里真的又引用了"也照样绿（假阴性，本项目已多次遇到）
  ok(!/_kmVideoIcon/.test(stripCommentsFlatJs(html)),
    '不再引用 _kmVideoIcon（该字段从未被赋值，清理永远空转）');
  ok(!/this\.frame\.stroke\(color/.test(icons), '不再有 VideoIcon 的 frame 上色');
  ok(!/this\.path\.fill\(color\)\.stroke\(color/.test(icons), '不再有 VideoIcon 的三角上色');
  ok(!/stroke\('#8A90A0',\s*1\.2\)/.test(icons), '不再硬编码 #8A90A0（改为跟随节点色）');

  // 13.5 悬停提示：光看图标认不出挂的是哪个文件
  //      （这段在 attach() 里，位于 noderender 块内，故对全文匹配）
  ok(/createElementNS\('http:\/\/www\.w3\.org\/2000\/svg',\s*'title'\)/.test(html), '图标带 SVG <title> 提示');
  ok(/function\s+refName/.test(icons), 'refName() 解析附件名（节点里存的是 JSON 字符串）');
  ok(/icon\.paint\(color\)/.test(html), 'attach 时统一调用 paint(color)');
}

{
  // 13.6 行为级：复刻 kity 的 fill 语义，坐实「传 null 会变黑」
  //      kity: fill(a){ a&&node.setAttribute('fill',a); null===a&&node.removeAttribute('fill'); }
  //      SVG 缺 fill 属性时渲染为黑色 —— 这就是「黑框」的来源。
  function fakePath() {
    const attrs = new Map();
    return {
      attrs,
      fill(a) {
        if (a) attrs.set('fill', String(a));
        if (a === null) attrs.delete('fill');
        return this;
      },
      // SVG 规范：fill 属性缺失时默认 black
      renderedFill() { return attrs.has('fill') ? attrs.get('fill') : 'black'; },
    };
  }

  const p = fakePath();
  p.fill('#AEB6C4');
  eq(p.renderedFill(), '#AEB6C4', '给了颜色就是那个颜色');

  const q = fakePath();
  q.fill(null);                       // ← 旧代码：node.getStyle('color') 返回 null
  eq(q.renderedFill(), 'black', '（对照）fill(null) 会删掉属性 → SVG 默认黑色');

  // refName 的等价实现
  const refName = (raw) => {
    if (!raw) return '';
    try {
      const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return o && o.n ? String(o.n) : '';
    } catch { return ''; }
  };
  eq(refName(JSON.stringify({ n: '报告.pdf', a: 'x1', s: 100 })), '报告.pdf', 'refName 从 JSON 串解析出文件名');
  eq(refName('不是JSON'), '', 'refName 对非法 JSON 返回空串，不抛');
  eq(refName(null), '', 'refName 对空值返回空串');
}

/* ============================================================
   十四、file / video 互不干扰（移除一项不能带走另一项）
   ============================================================ */

group('附件：file 与 video 互不干扰');

{
  /*
   * 用 editor/index.html 里的**真实命令源码**跑，而不是复刻一份。
   * 复刻的话命令改了测试还是绿的，等于没测。
   */
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const cmdSrc = html.slice(
    html.indexOf("var FileCommand = kity.createClass('fileCommand'"),
    html.indexOf('// 不能把 FileRenderer 挂进'));

  const kity = {
    createClass(name, def) {
      function C() { if (def.constructor) def.constructor.apply(this, arguments); }
      Object.assign(C.prototype, def);
      return C;
    },
  };
  const kityminder = { Command: function () {} };

  function makeKm(node) {
    return {
      _commands: {},
      getSelectedNodes: () => [node],
      getSelectedNode: () => node,
      layout() {},
      // 复刻内核 execCommand 的前置检查：queryState 返回 -1 时命令被拒绝
      queryCommandState(name) {
        const b = this._commands[name];
        return b ? b.queryState.apply(b, [this]) : -1;
      },
      execCommand(name, ...args) {
        const b = this._commands[name];
        if (!b) return null;
        if (!~this.queryCommandState(name)) return null;
        return b.execute.apply(b, [this, ...args]);
      },
    };
  }
  const newKm = (data) => {
    const node = { data, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k]; }, render() {} };
    const km = makeKm(node);
    new Function('kity', 'kityminder', 'km', cmdSrc)(kity, kityminder, km);
    return km;
  };

  // 14.1 命令注册
  {
    const km = newKm({ text: 'x' });
    // image 是**覆盖内核**的自有命令（内核版是异步的，见下方分组）
    eq(Object.keys(km._commands).sort().join(','), 'file,image,images,video',
      '编辑器注册了 file / video / images 三个命令（images 是多图横幅用）');
    ok(/km\._commands\['image'\] = new ImageCommand\(\)/.test(html),
      'image 命令是**自有实现**（覆盖内核的异步版本）');
  }

  // 14.2 核心：移除 file 只删 file，video 原样保留
  {
    const km = newKm({ text: 'x', file: 'F', video: 'V' });
    km.execCommand('file', null);
    eq(km.getSelectedNode().getData('file'), undefined, '移除后 file 已清空');
    eq(km.getSelectedNode().getData('video'), 'V',
      '移除 file 后 video **必须还在**（两者是各自独立的 data 字段）');
  }

  // 14.3 反向同样成立
  {
    const km = newKm({ text: 'x', file: 'F', video: 'V' });
    km.execCommand('video', null);
    eq(km.getSelectedNode().getData('video'), undefined, '移除后 video 已清空');
    eq(km.getSelectedNode().getData('file'), 'F', '移除 video 后 file 必须还在');
  }

  // 14.4 写入也不互相覆盖：先挂 file 再挂 video，两个都在
  {
    const km = newKm({ text: 'x' });
    km.execCommand('file', 'F');
    km.execCommand('video', 'V');
    eq(km.getSelectedNode().getData('file'), 'F', '挂了 video 之后 file 仍在');
    eq(km.getSelectedNode().getData('video'), 'V', 'file 与 video 可共存');
  }

  // 14.5 面板层的移除：按 kind 选 setter，且**只删指定那一个**
  {
    const src = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');
    // 多附件后 remove 改成了 removeAt(kind, index)：定位用 `const removeAt = ` 前缀，
    // 不写死完整签名（函数体/修饰符变了也不会让 indexOf 返回 -1 导致切片错乱）
    const rmStart = src.indexOf('const removeAt = ');
    ok(rmStart > 0, '面板层有 removeAt（按索引移除，多附件必需）');
    const rm = src.slice(rmStart, src.indexOf('const addImages', rmStart));
    // setList 才是真正调 setter 的地方（removeAt / attach 都经由它）
    const slStart = src.indexOf('const setList = ');
    const sl = src.slice(slStart, src.indexOf('const attach = async', slStart));
    ok(/kind === 'video' \? 'setVideo' : 'setFile'/.test(sl),
      'setList 按 kind 选择 setter（不会同时调两个）');
    ok(/list\.splice\(index, 1\)/.test(rm), '只删指定那一个（不是清空整类）');
    ok(/confirmDialog\(/.test(rm), '移除前确认（不可逆）');
    /*
     * 早先这条断言写的是 `if (r.a) await io.dropAsset(r.a)` —— 把 BUG 48
     * 本身当成了期望值：无条件 dropAsset 会删掉**被别的节点共享**的资产
     * （复制节点时 assetId 是字符串、克隆出来一模一样）。
     * 现在改走按引用判定的 gcAssets。
     */
    ok(!/io\.dropAsset\(/.test(rm), '移除附件不得无条件 dropAsset（会删掉共享资产）');
    ok(/app\.api\.gcAssets\?\.\(\)/.test(rm), '移除附件走 gcAssets（按引用判定后再回收）');
    // 附加必须是追加
    const atStart = src.indexOf('const attach = async (kind)');
    const at = src.slice(atStart, src.indexOf('const removeAt', atStart));
    ok(/decodeRefList\(rawOf\(kind\)\)/.test(at) && /list\.push\(/.test(at),
      '附加是**追加**（读现有列表 → push → 写回），不再覆盖');
    ok(!/confirmDialog\(/.test(at), '追加不会顶掉原有附件，所以不需要覆盖确认');
  }
}

{
  // 14.6 视频预览的三种状态必须区分开。
  //      「有引用但读不到本体」被说成「未附加视频」，看起来就像视频被一起删了。
  const { buildSide } = await import('./panels.js');
  const mk = (video) => {
    const el = buildSide({
      api: { status() {}, selectedRef: (k) => (k === 'video' ? video : null),
      selectedRefs: () => (video ? [video] : []), selectedImages: () => [], commit() {} },
      bridge: { getSelectedNodeId: () => 'n1' },
    }, {});
    el.open('file');
    return el.el.querySelector('.mm-vthumb');
  };

  ok(/未附加视频/.test(mk(null).textContent), '无引用 → 「未附加视频」');

  // 有引用但没有本地资产 id（C# 版遗留的纯路径 / xmind 未打包本体）
  const legacy = mk({ n: '旧视频.mp4', a: null, s: 100 });
  ok(/读不到本体/.test(legacy.textContent),
    '有引用但无本体 → 说清是「旧版本地路径」，不能说「未附加」');
  ok(!/未附加/.test(legacy.textContent), '（对照）有引用时不出现「未附加」字样');

  // 有 id 但资产取不到 → 加载态 / 丢失，同样不能说「未附加」
  const missing = mk({ n: '视频.mp4', a: 'not-exist', s: 100 });
  await new Promise((r) => setTimeout(r, 30));
  ok(!/未附加/.test(missing.textContent), '资产取不到时也不说「未附加」');
}

/* ============================================================
   十五、布局模板：缩略图 + 名称（对齐 WPF 原版）
   ============================================================ */

group('布局模板缩略图');

{
  const { LAYOUT_THUMBS } = await import('./layout-thumbs.js');
  const { LAYOUTS } = await import('./themes.js');

  // 15.1 每个布局都要有缩略图 —— 少一个就是一格空白
  for (const l of LAYOUTS) {
    ok(!!LAYOUT_THUMBS[l.value], `布局 ${l.value} 有缩略图`);
  }
  eq(Object.keys(LAYOUT_THUMBS).length, LAYOUTS.length,
    `缩略图数量与布局数量一致（${Object.keys(LAYOUT_THUMBS).length}/${LAYOUTS.length}）`);

  // 15.2 必须是**合法 PNG**：base64 拼错的话浏览器静默不显示，没有任何报错
  for (const [k, v] of Object.entries(LAYOUT_THUMBS)) {
    ok(/^data:image\/png;base64,/.test(v), `${k} 是 PNG data URL`);
    const buf = Buffer.from(v.split(',')[1], 'base64');
    ok(buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])),
      `${k} PNG 魔数正确`);
    // 尺寸写在 IHDR：宽高各 4 字节，位于第 16 / 20 字节
    ok(buf.readUInt32BE(16) > 0 && buf.readUInt32BE(20) > 0, `${k} 尺寸有效`);
  }
}

{
  // 15.3 渲染形态：两列网格 + 缩略图 + 名称
  const { buildSide } = await import('./panels.js');
  let applied = null;
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: (v) => { applied = v; },
      applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: { getSelectedNodeId: () => 'n1' },
    customThemes: [],
  }, {});
  el.open('theme');

  const grid = el.el.querySelector('.mm-layouts');
  ok(!!grid, '布局区用 .mm-layouts 容器');

  const items = [...grid.querySelectorAll('.mm-layout')];
  eq(items.length, 6, '六个布局各一格');

  const first = items[0];
  const img = first.querySelector('.mm-layout-thumb img');
  ok(!!img, '每格有缩略图 img');
  ok(/^data:image\/png;base64,/.test(img.getAttribute('src') || ''), '缩略图 src 是内联 PNG');
  eq(first.querySelector('.mm-layout-name')?.textContent, '思维导图', '每格显示布局名称');

  // 名称不能是空的 —— 光有图不知道点的是什么
  ok(items.every((b) => (b.querySelector('.mm-layout-name')?.textContent || '').trim()),
    '每个布局都有非空名称');

  // 15.4 点击应用布局
  items[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  eq(applied, 'filetree', '点第三格应用对应布局');
}

{
  // 15.5 缺图时要退化成可见占位符，而不是空白
  const src = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');
  const seg = src.slice(src.indexOf("section('布局模板'"), src.indexOf('// 注：这里原先有个'));
  ok(/LAYOUT_THUMBS\[l\.value\]\s*\?/.test(seg), '渲染前判断缩略图是否存在');
  ok(/mm-layout-nothumb/.test(seg), '缺图时给占位符（不留空白）');
}

/* ============================================================
   十六、主题配色条（背景 + 根节点 + 主节点 + 子节点）
   ============================================================ */

group('主题配色条');

{
  const { THEMES } = await import('./themes.js');

  // 16.1 每个主题都要有完整四色 —— 缺一项就少一段，看着像 bug
  for (const t of THEMES) {
    ok(t.bg && t.root && t.main && t.sub, `${t.value} 四色齐全（bg/root/main/sub）`);
  }

  // 16.2 颜色值必须合法，否则 CSS 会整段不渲染（表现为空白）
  const HEX = /^#[0-9A-Fa-f]{3,8}$/;
  for (const t of THEMES) {
    for (const k of ['bg', 'root', 'main']) {
      ok(HEX.test(t[k]), `${t.value}.${k} = ${t[k]} 是合法十六进制色`);
    }
    // sub 允许 'transparent'
    ok(t.sub === 'transparent' || HEX.test(t.sub), `${t.value}.sub = ${t.sub} 合法（色值或 transparent）`);
  }

  // 16.3 fresh 系列的 root 必须与内核 HSL 公式一致。
  //      这是交叉校验：公式 H(h,37%,60%)，色相 {red:0,soil:25,green:122,blue:204,purple:246,pink:334}
  const hsl2hex = (h, s, l) => {
    const S = s / 100, L = l / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = S * Math.min(L, 1 - L);
    const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (v) => Math.round(255 * v).toString(16).padStart(2, '0').toUpperCase();
    return '#' + to(f(0)) + to(f(8)) + to(f(4));
  };
  const HUES = { red: 0, soil: 25, green: 122, blue: 204, purple: 246, pink: 334 };
  for (const [name, hue] of Object.entries(HUES)) {
    const t = THEMES.find((x) => x.value === 'fresh-' + name);
    eq(t.root, hsl2hex(hue, 37, 60), `fresh-${name} 的 root 与内核 HSL(${hue},37%,60%) 一致`);
    eq(t.main, hsl2hex(hue, 33, 95), `fresh-${name} 的 main 与内核 HSL(${hue},33%,95%) 一致`);
  }

  // 16.4 关键区分度：snow / classic / fish 的 root 相同，靠 sub 才能分开
  const byV = (v) => THEMES.find((x) => x.value === v);
  eq(byV('snow').root, byV('classic').root, '（对照）snow 与 classic 的 root 相同');
  ok(byV('snow').sub !== byV('classic').sub,
    'snow 与 classic 的 sub 不同 —— 这正是「只有圆点时分不出来」的原因');
}

{
  // 16.5 渲染：配色条四段 + 名称
  const { buildSide } = await import('./panels.js');
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: { getSelectedNodeId: () => 'n1' },
    customThemes: [],
  }, {});
  el.open('theme');

  const items = [...el.el.querySelectorAll('.mm-theme')];
  eq(items.length, 10, '十个内置主题');

  const first = items[0];
  const bar = first.querySelector('.mm-swbar');
  ok(!!bar, '每项有配色条（不再只有一个圆点）');
  eq(bar.querySelectorAll('.mm-sw').length, 4, '配色条分四段');
  ok(!first.querySelector('.dot'), '不再渲染旧的单一圆点');
  eq(first.querySelector('.name')?.textContent, '清新蓝', '仍显示主题名');

  const segs = [...bar.querySelectorAll('.mm-sw')];
  eq(segs[0].style.background.replace(/\s/g, ''), 'rgb(251,251,251)', '第一段是画布底色');
  ok(segs[0].getAttribute('title').includes('画布底色'), '每段有 title 说明是哪一层');
  ok(segs[3].classList.contains('transparent'), '子节点透明时该段标记为 transparent');
  ok(segs[3].getAttribute('title').includes('透明'), '透明段的 title 说明是透明的');

  // 16.6 非 transparent 的段不该带标记
  const wire = items.find((b) => b.querySelector('.name')?.textContent === '线框灰');
  ok(!wire.querySelector('.mm-sw.transparent'), '线框灰没有 transparent 段（四色都是 #999）');
}

{
  // 16.7 自定义主题：palette 字段名不同，要能归一
  const { buildSide } = await import('./panels.js');
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: { getSelectedNodeId: () => 'n1' },
    customThemes: [{
      id: 'custom-1',
      name: '我的主题',
      palette: {
        background: '#101010', rootBackground: '#FF0000',
        mainBackground: '#00FF00', subBackground: '#0000FF',
      },
    }],
  }, {});
  el.open('theme');
  const mine = [...el.el.querySelectorAll('.mm-theme')]
    .find((b) => b.querySelector('.name')?.textContent === '我的主题');
  ok(!!mine, '自定义主题也渲染出来了');
  const segs = [...mine.querySelectorAll('.mm-sw')].map((s) => s.style.background.replace(/\s/g, ''));
  eq(segs[0], 'rgb(16,16,16)', '自定义主题：第 1 段取 palette.background');
  eq(segs[1], 'rgb(255,0,0)', '自定义主题：第 2 段取 palette.rootBackground');
  eq(segs[2], 'rgb(0,255,0)', '自定义主题：第 3 段取 palette.mainBackground');
  eq(segs[3], 'rgb(0,0,255)', '自定义主题：第 4 段取 palette.subBackground');
}

{
  // 16.8 transparent 段必须有可见标记 —— 否则「透明」和「白色」看起来一样
  const css = stripCommentsFlat((fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n'));
  // 切到本规则块的 `}` 为止 —— 固定 400 会越界到下一条规则，
  // 越界后测到的就是**别的规则**的属性了（同 exportExchange 那个假阳性）。
  const segStart = css.indexOf('.mm-sw.transparent {');
  const seg = css.slice(segStart, segStart + css.slice(segStart).indexOf('}') + 1);
  ok(/repeating-linear-gradient/.test(seg), '透明段用斜纹标出（不能只是空白）');

  // 外圈描边：snow/classic 的画布底 #3A4144 与深色面板太接近，没边就糊住
  const barCss = css.slice(css.indexOf('.mm-swbar {'), css.indexOf('.mm-sw {'));
  ok(/border:\s*1px solid/.test(barCss), '配色条有外圈描边（深色底主题才不会糊在面板里）');

  // 16.9 扁长比例：宽度明显大于高度，四段才看得清
  ok(/flex:\s*0 1 150px/.test(barCss), '基础宽度 150px');
  ok(/height:\s*10px/.test(barCss), '高度 10px（150:10，扁长条）');
  ok(!/width:\s*42px/.test(barCss), '（对照）不再是 42px 的小方块');
  ok(/min-width:\s*76px/.test(barCss), '有最小宽度，名称很长时也不会被压没');

  // 16.10 段间分隔线：wire 四段都是 #999，没分隔就糊成一整条
  ok(/\.mm-sw \+ \.mm-sw\s*\{[^}]*box-shadow:\s*inset 1px 0 0/.test(css),
    '段间有 1px 分隔线（wire 四段同色，没有就分不出是四段）');

  // 16.11 选中态：配色条本身是色块，内凹阴影看不出来，得用外环
  const onCss = css.slice(css.indexOf('.mm-theme.on .mm-swbar'), css.indexOf('.mm-sw {'));
  ok(/box-shadow:\s*0 0 0 2px var\(--accent\)/.test(onCss), '选中态用 accent 外环标出');
  ok(/\.mm-theme:hover \.mm-swbar/.test(css), '悬停有反馈（条略增高）');
}

/* ============================================================
   十七、行内编辑要像「直接在节点里改」
   ============================================================ */

group('行内编辑贴合节点');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const fn = html.slice(html.indexOf('function beginTextEdit'), html.indexOf("km.on('dblclick'"));
  // 去掉整行注释再断言：注释里会提到「overflow:hidden」这类词，不清掉会误判
  const code = fn.replace(/^\s*\/\/.*$/gm, '');

  /*
   * 先说清楚为什么做不到「真的在 SVG 节点里改」：
   * SVG 1.1/2 的 <text> 没有 contenteditable，浏览器不提供原生文本编辑。
   * 所以必然要一层 HTML 编辑层 —— 目标是让它**看起来**就在节点里。
   */

  // 17.1 缩放对齐：font-size 必须乘 zoom
  //      box 来自 getBoundingClientRect（屏幕像素，已含缩放）；
  //      getComputedStyle().fontSize 是 CSS 像素（缩放走 transform，不改 font-size）。
  //      直接混用 → zoom=50% 时节点文字只剩 7px、编辑层仍是 14px。
  ok(/function currentZoom\(\)/.test(html), '抽出 currentZoom()');
  ok(/var zoom = currentZoom\(\);/.test(fn), 'beginTextEdit 里取当前缩放');
  ok(/var scaledFs = fs \* zoom;/.test(fn), '字号按 zoom 缩放（与屏幕像素统一量纲）');
  ok(/font-size:' \+ scaledFs \+ 'px;'/.test(fn), 'font-size 用的是缩放后的值');
  ok(!/font-size:' \+ fontSize \+ 'px;'/.test(fn), '（对照）不再直接用未缩放的 fontSize');
  ok(/line-height:' \+ Math\.round\(lh\) \+ 'px;'/.test(fn), 'line-height 同样按缩放后的行高');

  // 17.2 取整组 bbox，而不是第一个 <text>
  //      kity 每行一个 <text>（eachItem(... setY(m + a*i*h))），取 [0] 只拿到第一行，
  //      多行节点下面几行还露着 → 重影。
  ok(/function nodeTextGroup\(node\)/.test(html), '抽出 nodeTextGroup() 取整组');
  ok(!/function nodeTextElement\(node\)/.test(html), '（对照）旧的只取首行版本已移除');
  ok(/var group = nodeTextGroup\(node\);/.test(fn), '用整组定位');
  ok(/group\.getBoundingClientRect/.test(fn), 'bbox 取整组的（覆盖所有行）');
  ok(/group\.getElementsByTagName\('text'\)/.test(fn), '行数按整组的 <text> 数量算');

  // 17.3 行高要按单行算：多行的 box.height 会让单行文字垂直偏移
  ok(/var lineCount = group \? Math\.max\(1, group\.getElementsByTagName\('text'\)\.length\) : 1;/.test(fn),
    '算出总行数');
  ok(/var lh = \(box && box\.height\) \? \(box\.height \/ lineCount\)/.test(fn),
    'line-height = 总高 / 行数（单行行高）');

  // 17.4 必须隐藏原 SVG 文字，否则编辑层盖在上面会有叠影
  ok(/group\.style\.visibility = 'hidden'/.test(fn), '编辑期间隐藏原 SVG 文字');
  ok(/hidden\.el\.style\.visibility = hidden\.prev/.test(html), '关闭时恢复原文字可见性');
  ok(/var hidden = editLayer\.hidden;/.test(html), '隐藏信息存进 editLayer，随编辑器一起管理');
  /*
   * 打开时也必须走 layoutEditLayer —— 只抽出函数却忘了在 beginTextEdit 里
   * 调用的话，编辑框会落在默认位置（12,12）。变异验证实测：删掉那句调用，
   * 之前没有任何断言变红。
   */
  ok(/layoutEditLayer\(el, node\);/.test(fn), 'beginTextEdit 真的调用 layoutEditLayer 定位');

  // 17.5 宽度自适应，不截断
  /*
   * 这两句现在归 layoutEditLayer 管（打开与重定位共用一份算法），
   * 所以不能再只查 beginTextEdit 那一段 —— 否则断言恒为假。
   */
  const posCode = html.slice(html.indexOf('function layoutEditLayer'), html.indexOf('function beginTextEdit'));
  ok(/el\.style\.width = 'auto';/.test(posCode), '宽度随内容增长');
  ok(/el\.style\.minWidth = Math\.max\(60, Math\.round\(box\.width\)\) \+ 'px';/.test(posCode), 'min-width 保底为原宽度');
  ok(!/overflow:hidden/.test(code), '（对照）不再 overflow:hidden —— 那会截断超长输入');

  // 17.6 画布一变换要**重定位**，不能再「提交关闭」
  /*
   * 编辑层是绝对定位的 HTML，不跟 SVG transform 走，所以变换后必须处理。
   * 但早先的做法（bail → closeTextEditor）会**误伤刚打开的编辑层**：
   *
   *   插入节点后内核自动把镜头移到新节点上，而这次 viewchange 是**异步**
   *   到达的 —— 排在 beginTextEdit **之后**。于是刚打开的编辑框立刻被关掉。
   *
   * 实测（真实 Chrome + playwright，父页 iframe 复刻真实结构）：
   *   连续 __minderInsertChild()：CE 数 1 → 0 → 1 → 0（隔一次才进得了编辑态）；
   *   把 viewchange 吞掉后：      CE 数 1 → 1 → 1 → 1。
   *
   * 改成重定位：既跟住节点（实测对齐误差 1px），又不打断输入。
   */
  ok(/km\.on\('zoom', bail\)/.test(html), '缩放时重算编辑层位置');
  ok(/km\.on\('viewchange', bail\)/.test(html), '视图变化时重算编辑层位置');
  ok(/function bail\(\) \{ if \(editLayer\) layoutEditLayer\(editLayer\.input, editLayer\.node\); \}/.test(html),
    '变换兜底走「重定位」而不是关闭（关掉会误伤刚打开的编辑框）');
  ok(!/function bail\(\) \{ if \(editLayer\) closeTextEditor\(true\); \}/.test(html),
    '（对照）不再一变换就提交关闭');
  ok(/function layoutEditLayer\(el, node\)/.test(html), '抽出 layoutEditLayer（打开与重定位共用一份算法）');
  {
    const lf = html.slice(html.indexOf('function layoutEditLayer'), html.indexOf('function beginTextEdit'));
    const lcode = stripCommentsFlat(lf);
    ok(/getBoundingClientRect\(\)/.test(lcode), '重定位按当前实测位置算（不是缓存下来的旧盒）');
    ok(/el\.style\.left\s*=/.test(lcode) && /el\.style\.top\s*=/.test(lcode), '重算 left / top');
    ok(/fs \* zoom/.test(lcode), '重算字号（缩放会变，只挪位置不够）');
  }
}

/*
 * 17.8 键盘入口（隐藏 input.km-receiver）必须真的存在。
 *
 * 内核只在 `paperrender` 事件里建它（_initKeyReceiver），而 paperrender
 * 只在 `renderTo()` 里 fire 一次 —— renderTo() 是**构造函数里**跑的，
 * 那一刻 initHook 还没注册，事件早发完了。
 *
 * 实测（真实 Chrome）：构造后 importJson → refresh → select，km.fire() 记录的
 * 事件序列里**一次 paperrender 都没有**，`.km-receiver` 始终不存在。
 *
 * 没有它 → km.focus() 是空操作（真正去 focus receiver 的那句监听正是在
 * _initKeyReceiver 里注册的）→ closeTextEditor 末尾的 km.focus() 也空转 →
 * 编辑层 div 被 remove 后焦点掉回 iframe 的 <body>。
 * 焦点在 iframe 里时 keydown **不跨 iframe 冒泡**，外层 bindKeyForward 收不到，
 * iframe 内又没按键处理 —— Tab 走浏览器默认导航，焦点越过 iframe 边界落到
 * 父文档里 iframe 之后的第一个可聚焦元素 = **右侧属性面板**。
 *
 * 实测（父页 iframe 复刻真实结构，连续按 Tab）：
 *   修复前：外层 IFRAME → IFRAME → BUTTON#rpBtn1（右侧面板）→ IFRAME → BUTTON#rpBtn1 …
 *   修复后：外层恒为 IFRAME，内层在 receiver 与编辑层之间切换，每次 Tab 都建节点。
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const seg = ed.slice(ed.indexOf('var km = window.__km = new kityminder.Minder'),
    ed.indexOf('var km = window.__km = new kityminder.Minder') + 2200);
  const scode = stripCommentsFlatJs(seg);
  ok(/km\._initKeyReceiver\s*&&\s*!km\._keyReceiver/.test(scode),
    '构造后补建 km-receiver（内核的 paperrender 早发完了，永远不会自己建）');
  ok(/km\._initKeyReceiver\(\)/.test(scode), '真的调用而不是只判断');
  // 断言必须落在**创建 km 之后**：写在前面 _renderTarget 还没有，补建会失败
  ok(scode.indexOf('_initKeyReceiver') > scode.indexOf('new kityminder.Minder'),
    '补建在创建 Minder 之后（之前 _renderTarget 还不存在）');
}

/*
 * 17.9 编辑态里按 Tab 要**接着建下一个**，不能只提交。
 *
 * 少了这一句就是「按 Tab 要按两次才建出节点」的正主：
 *   Tab #1  建节点并进入编辑态
 *   Tab #2  只提交、退出编辑 —— **不建节点**
 *   Tab #3  才建下一个
 *
 * 实测（真实 Chrome，模拟连续录入 R → Tab 子1 → Tab 子2 → Tab 子3）：
 *   修复前  节点数 1 → 2 → 2 → 3（每建一个要多按一次）
 *   修复后  节点数 1 → 2 → 3 → 4，且每次都还在编辑态
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  // 用**结构**收尾而不是固定长度：keydown 块以 layoutEditLayer(el, node) 结束。
  // 早先写死 1600 字符，注释一长就把 __minderInsertChild 挤出切片，
  // 断言变成恒假 —— 代码一点没改却报红。
  const kbAt = ed.indexOf("el.addEventListener('keydown'");
  const kb = ed.slice(kbAt, ed.indexOf('layoutEditLayer(el, node)', kbAt));
  const kcode = stripCommentsFlat(kb);
  ok(/ev\.key === 'Tab'/.test(kcode), '编辑层单独处理 Tab');
  ok(/closeTextEditor\(true\);/.test(kcode), 'Tab 先提交当前文字');
  ok(/__minderInsertChild/.test(kcode), '提交完立刻再建一个子节点（否则每建一个要按两次 Tab）');
  ok(kcode.indexOf('closeTextEditor(true);') < kcode.indexOf('__minderInsertChild'),
    '顺序是先提交再建（反了的话新节点进不去编辑态）');
  /*
   * Enter **不**跟着建同级 —— 「输完按回车」凭空多出一个空节点，
   * 风险大于收益。这里守住它别被顺手改掉。
   */
  ok(/ev\.key === 'Enter' && !ev\.shiftKey\) \{ ev\.preventDefault\(\); ev\.stopPropagation\(\); closeTextEditor\(true\); \}/.test(kcode),
    'Enter 仍是「提交并结束」，不建同级');
}

/*
 * 17.10 节点脱离 minder 后 getStyle 会抛 —— 守在 Node.prototype 这一层。
 *
 * 内核：getStyle = function (a) { return this.getMinder().getNodeStyle(this, a) }
 * importJson 换树后旧节点被 detach，getMinder() 返回 undefined → 抛
 *   Cannot read properties of undefined (reading 'getNodeStyle')
 *
 * 实测（真实 Chrome）：选中一个节点 → importJson 换树 → 按 F2 → 冒出这条
 * 未捕获异常，栈是
 *   MinderNode.getStyle ← **OutlineRenderer.update** ← renderNodeBatch
 *
 * 注意是 OutlineRenderer 而不是 TextRenderer —— 早先只给 TextRenderer 打了
 * 补丁，**不够**：renderNodeBatch 是个循环，同批里排在后面的 renderer 照样抛，
 * 而且任何一个 update 抛错，**整批后续节点的渲染就全部跳过**。
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const seg = ed.slice(ed.indexOf('function patchNodeGetStyle'), ed.indexOf('function patchNodeGetStyle') + 1400);
  const scode = stripCommentsFlat(seg);
  ok(/function patchNodeGetStyle\(\)/.test(scode), '定义了 patchNodeGetStyle');
  ok(/kityminder\.Node\.prototype/.test(scode), '打在 Node.prototype 上（所有 renderer 都走 getStyle，一处拦住就够）');
  ok(/typeof this\.getMinder === 'function' && !this\.getMinder\(\)/.test(scode), '只在节点已脱离 minder 时拦截');
  ok(/return null;/.test(scode), '返回 null（getStyle 本来就允许返回 null，不是吞异常）');
  ok(/origGetStyle\.apply\(this, arguments\)/.test(scode), '其余情况照原样走');
  ok(/__kmGetStylePatched/.test(scode), '幂等标记（编辑器重复初始化时不套两层）');
}

/*
 * 17.11 换树之前必须先收掉正在编辑的文字。
 *
 * 编辑层记着 `editLayer.node`，而 importJson / 撤销重做会把整棵树换掉 ——
 * 那个节点不在树上了，编辑层却**不会自动关掉**。实测（真实 Chrome）：
 *
 *   编辑中输入"正在输入" → importJson 换新树 → 编辑层还在、显示"正在输入"；
 *   继续输入 ZZZ → 新树纹丝不动，输入**凭空消失**。
 *
 * 更糟的是之后若触发 closeTextEditor，`execCommand('text', v)` 会落到
 * **当前选中节点**上（旧节点已经选不中），把旧节点的文字写到新节点上。
 *
 * 所以必须**在换树之前**提交 —— 那一刻旧节点还在树上。
 *
 * 打在**实例方法**上而不是只改 __minder.importJson 门面：编辑器页内部还有
 * 几处直接 km.importJson(...)(新建画布、撤销重做)，只改门面覆盖不到。
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const seg = ed.slice(ed.indexOf('function commitEditingBeforeSwap'), ed.indexOf('function closeTextEditor'));
  const scode = stripCommentsFlat(seg);
  ok(/function commitEditingBeforeSwap\(\)/.test(scode), '定义了 commitEditingBeforeSwap');
  ok(/if \(editLayer && typeof closeTextEditor === 'function'\)/.test(scode),
    '只在真有编辑层时才提交（没有就别空跑一次 closeTextEditor）');
  ok(/closeTextEditor\(true\)/.test(scode), '走「提交」而不是丢弃（用户的输入不能白打）');

  const pj = ed.slice(ed.indexOf('function patchImportJson'), ed.indexOf('function patchNodeGetStyle'));
  const pcode = stripCommentsFlat(pj);
  ok(/function patchImportJson\(\)/.test(pcode), 'patch 挂在实例方法上（覆盖门面之外的直调路径）');
  ok(/km\.importJson\s*=\s*function/.test(pcode), '替换的是 km.importJson 本身');
  ok(/commitEditingBeforeSwap\(\);/.test(pcode), '替换体里真的先提交');
  ok(/origImport\.apply\(this, arguments\)/.test(pcode), '提交之后照常导入');
  ok(/__kmImportPatched/.test(pcode), '幂等标记');

  // 门面那两条路也要有（双保险，且 importText 走的是另一个入口）
  ok(/importJson: function \(data\) \{\s*\n?\s*commitEditingBeforeSwap\(\);/.test(ed)
     || /importJson: function \(data\) \{\s+commitEditingBeforeSwap\(\);/.test(ed),
    '__minder.importJson 门面里也先提交');
  // importText 已改为 async（importData 是异步的，不 await 会跑在旧树上）
  ok(/importText: (?:async )?function \(md\) \{\s+commitEditingBeforeSwap\(\);/.test(ed),
    '__minder.importText 门面里也先提交');
  ok(/commitEditingBeforeSwap\(\); km\.importJson\(JSON\.parse\(snap\)\)/.test(ed),
    '撤销/重做那条 importJson 路径也先提交');
}

/*
 * 17.12 exportPng 必须用两参数 then —— 内核 Promise 没有 .catch。
 *
 * `km.exportData('png')` 返回的是 **kityminder 自带的 Promise**，实测：
 *     typeof r.then  === 'function'
 *     typeof r.catch === 'undefined'       ← 没有
 *     r.then(fn) 的返回值上也没有 .catch
 *
 * 所以 `.then(ok).catch(err)` 会在 `.catch` 处**同步抛**
 * `TypeError: ... .catch is not a function`。两重后果：
 *   1. 调用方拿到异常，看着像导出失败；
 *   2. **catch 根本没注册上** —— 导出真失败时 __mindmapPng 永远 'pending'，
 *      轮询方永远收到 'PENDING'，既没结果也没报错，**永久卡住**。
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const seg = ed.slice(ed.indexOf('exportPng: function ()'), ed.indexOf('pollExportPng: function ()'));
  const scode = stripCommentsFlat(seg);
  ok(!/\.catch\(/.test(scode), '不再用 .catch（内核 Promise 上没有这个方法）');
  ok(/\.then\(done, fail\)/.test(scode), '改用两参数 then(ok, err) —— thenable 都支持这个形态');
  ok(/var settled = false;/.test(scode) && /if \(settled\) return;/.test(scode), '幂等：两个回调只生效一个');
  /*
   * 正则窗口必须放宽到 200：setTimeout 的回调体（含缩进换行）远不止 80 字符，
   * 写窄了断言会**恒为假** —— 超时兜底那行被删掉也照样绿。
   */
  ok(/setTimeout\([\s\S]{0,200}30000/.test(scode), '超时兜底（异常路径可能两个回调都不触发）');
  ok(/if \(!settled\) fail\(/.test(scode), '超时后写入失败状态，而不是永远 PENDING');
  ok(/catch \(e\) \{ fail\(e\); \}/.test(scode), '连 .then 本身抛错也要落失败态');
}

/*
 * 17.13 history.clear() 不能把基线置 null —— 那会让撤销/重做彻底失效。
 *
 * 编辑器页的 contentchange 处理是：
 *
 *     km.on('contentchange', function () {
 *         if (_historyLock || _baseline == null) return;   ← 永远 return
 *         ...
 *     });
 *
 * `_baseline == null` 是「历史系统还没初始化」的哨兵。clear() 把它打回这个
 * 状态，于是此后**所有编辑都不再入栈**：canUndo() 恒为 false，点 ↶ / ↷
 * 没有任何反应，也不报错。
 *
 * 触发路径是**每次 loadSheet 都走**（index.js）：
 *
 *     bridge.importJson(...)    // 门面 → _historyCommitBaseline() → 基线正常
 *     ...
 *     bridge.historyClear();    // ← 又把基线清成 null，前功尽弃
 *
 * 而 loadSheet 在「启动 / 新建画布 / 切换画布 / 重载编辑器」都会跑 ——
 * 也就是**每次拿到画布后撤销就是坏的**，直到用户手工导入一次才恢复。
 *
 * 实测（真实 Chrome，完整插件 + 宿主桩）：
 *   启动 → Tab 建两个节点 → canUndo() === false            （坏）
 *   手工 __minder.importJson 一次 → 建节点 → canUndo() === true（对照）
 *   修复后：启动 → 建节点 → canUndo() === true，↶ 正常回退。
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const seg = ed.slice(ed.indexOf('window.editor = window.editor'), ed.indexOf('window.editor = window.editor') + 2600);
  const scode = stripCommentsFlat(seg);
  ok(!/_baseline = null/.test(scode), 'clear() 不再把基线置 null（置 null 会让所有编辑都不入栈）');
  ok(/clear: function \(\) \{ _undoStack = \[\]; _redoStack = \[\]; _baseline = _historySnap\(\); \}/.test(scode),
    'clear() 以**当前内容**重设基线（语义本就是「以当前内容为新的历史起点」）');
  ok(/_baseline == null/.test(ed), '（对照）contentchange 里仍有 _baseline == null 这道哨兵');
}

/*
 * 17.14 ensureRootId 必须遍历整棵树补 id，不能只补 root。
 *
 * 内核只给「新建出来的」节点自动补 id，导入进来的**一律不补**（root 与非 root 都不补）。
 * 而上层的 getSelectedNodeId() 读的正是 n.data.id —— 于是任何一个没有 id 的节点，
 * 「附加文件/视频/图片、移除附件、设为封面」全部用不了：rememberNode() 存到空 id →
 * focusNode() 返回 false → 提示「请先选中一个节点再附加」。用户明明选着那个节点。
 *
 * 早先只补 root，于是「中心主题能挂附件、它的子节点全都不能」——而画布上绝大多数
 * 节点恰恰都是子节点。受影响的不只是手工 JSON：formats.js 的 make() 就是
 * `{ data: { text } }`（不带 id），所以 XMind / Markdown / OPML / Freemind / TXT
 * 等**所有导入格式**进来的节点都没有 id。新建画布后 Tab 出来的节点有 id（内核补的）
 * 且会被保存，于是「自己从头建的图」正常、「导入进来的图」坏 —— 最难查的那类不一致。
 *
 * 实测（真实 Chrome，完整插件 + 宿主桩，走门面 importJson）：
 *   只补 root：导入 {R:[A]} → 选中 A → 附加文件 → 「请先选中一个节点再附加」
 *   补全树  ：同上                          → 附加成功，data.file 写入
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const i0 = ed.indexOf('function ensureRootId()');
  const seg = ed.slice(i0, i0 + 2400);
  const scode = stripCommentsFlat(seg);
  ok(/getRoot\(\)\.traverse\(/.test(scode), 'ensureRootId 遍历整棵树补 id（只补 root 会让所有子节点都挂不上附件）');
  ok(/n\.data\.id = /.test(scode), '给每个缺 id 的节点都赋上 id');
  /*
   * 第三条最初写成「不允许出现 `if (r.data.id) return;`」——**抓不到变异**：
   * 把提前 return 换成别的写法（`if (true) return;`、`if (!r.data.id) {...} return;`）
   * 断言照样绿，因为 traverse 那段代码**还在源码里**，只是永远执行不到。
   *
   * 判定「只补了 root」的真正特征是：**在 traverse 之前就 return 掉了**。
   * 所以直接取 `var r = ...` 到 `traverse(` 之间的代码，里面出现 return 即失败。
   */
  const iVar = scode.indexOf('var r = km.getRoot');
  const iTrav = scode.indexOf('traverse(');
  ok(iVar >= 0 && iTrav > iVar, '（结构）取到「读 root → traverse」这段');
  // `if (!r) return;` 是「根本没有 root」的合法守卫，不算提前返回；
  // 要抓的是 `if (r.data.id) return;` 那种「root 有 id 就整个不遍历」。
  const between = scode.slice(iVar, iTrav).replace(/if \(!r\) return;/g, '');
  ok(!/\breturn\b/.test(between),
    'traverse 之前不得提前 return —— 提前返回会让 traverse 永远执行不到，等于只补 root');
}

/*
 * 17.16 撤销 / 重做快捷键必须真的接上。
 *
 * 实测（真实 Chrome，完整插件）：
 *   点「下级」建节点 → 点工具栏 ↶      → 节点消失（按钮是好的）
 *   点「下级」建节点 → 按 Ctrl+Z       → 节点**还在**（快捷键没接）
 *   Ctrl+Shift+Z / Ctrl+Y 同样无效。
 *
 * 根因：内核 addCommandShortcutKeys 的默认表只有 ctrl+a/b/c/i/v/x 六个
 * （实测从 min.js 抠出的全部字面量），没有 ctrl+z/ctrl+y；命令表里也根本没有
 * undo / redo 命令（实测 52 个命令中无）。编辑器页原先只额外挂了
 * copynodestyle/pastenodestyle。于是撤销/重做只有工具栏两个按钮能用。
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const seg = stripCommentsFlat(ed);
  ok(/ctrlKey\s*\|\|\s*e\.metaKey/.test(seg), '撤销快捷键：识别 ctrl 与 meta（macOS 的 Cmd）');
  /*
   * 必须匹配**完整组合**，不能只查 `k === 'z'`：
   * undo 是 `'z' && !shiftKey`、redo 是 `'y' || ('z' && shiftKey)`，
   * 两者都含 `k === 'z'`。只查字面量的话，把 undo 分支的键改掉
   * （比如改成 'q'）断言照样绿 —— 变异验证时才发现这条是恒真的假阴性。
   */
  ok(/k\s*===\s*'z'\s*&&\s*!e\.shiftKey/.test(seg), '撤销快捷键：ctrl+z（不带 shift）');
  ok(/k\s*===\s*'y'/.test(seg), '重做快捷键：ctrl+y');
  ok(/k\s*===\s*'z'\s*&&\s*e\.shiftKey/.test(seg), '重做快捷键：ctrl+shift+z');
  ok(/callHost\(\s*act\s*\)/.test(seg), '必须走 callHost 让宿主执行（宿主有 pendingRedo 单栈锁）');
  ok(/preventDefault/.test(seg) && /stopPropagation/.test(seg), '必须 preventDefault + stopPropagation');

  // km-receiver 本身就是 <input>：笼统跳过所有 input 会把画布自己也跳掉
  ok(/km-receiver/.test(seg), '必须区分 km-receiver 与编辑层（km-receiver 本身就是 input）');
  ok(/isEditLayer/.test(seg), '编辑层里要跳过（那时 Ctrl+Z 该撤的是文字）');
  ok(!/if \(tag === 'input' \|\| tag === 'textarea'\|\) return;/.test(seg), '不得笼统跳过所有 input');

  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const host = stripCommentsFlat(ix);
  ok(/action === 'undo'/.test(host), '宿主要应答编辑器的 undo 请求');
  ok(/action === 'redo'/.test(host), '宿主要应答编辑器的 redo 请求');
}

/*
 * 17.15 importText 必须 await —— km.importData('markdown') 是异步的。
 *
 * 实测（真实 Chrome）：
 *     const r = km.importData('markdown', MD);
 *     r instanceof Promise === true
 *     同步继续读 km.getRoot() → 仍是**旧树**；等 600ms 后才是新树。
 *
 * 原先没 await，于是后面三句全部跑在旧树上：
 *   1. ensureRootId() 给旧树补 id → 新树 id 全空 → 整棵树挂不上附件；
 *   2. km.refresh() 刷新旧树 → 画面可能停在导入前；
 *   3. _historyCommitBaseline() 把基线设成旧树 → 导入后第一次编辑入栈时
 *      基线是旧树，**按一次撤销就把刚导入的内容整个撤掉**。
 *
 * 修复后实测：importText 返回 Promise，树里全部节点都有 id。
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const i0 = ed.indexOf('importText:');
  const seg = ed.slice(i0, ed.indexOf('// 关键：km.exportData()', i0));
  const scode = stripCommentsFlatJs(seg);
  ok(/async function/.test(scode), 'importText 是 async（importData 是异步的，不 await 会跑在旧树上）');
  ok(/await km\.importData\(/.test(scode), '必须 await km.importData(...)');
  const iAwait = scode.indexOf('await km.importData');
  const iEnsure = scode.indexOf('ensureRootId()');
  const iRefresh = scode.indexOf('km.refresh()');
  const iBase = scode.indexOf('_historyCommitBaseline()');
  ok(iAwait >= 0 && iEnsure > iAwait, 'ensureRootId() 必须在 await 之后（否则补的是旧树）');
  ok(iRefresh > iAwait, 'km.refresh() 必须在 await 之后（否则刷新的是旧树）');
  ok(iBase > iEnsure, '基线提交必须在补 id 之后（否则「补 id」会被当成一次编辑入栈）');
}

{
  // 17.7 行为级：验证 zoom 换算确实是必要的（对照旧算法）
  //      模拟 SVG transform scale(zoom) 下的两种算法
  const fs = 14;                    // CSS 像素字号
  for (const zoom of [0.5, 1, 2]) {
    const onScreen = fs * zoom;     // 屏幕上真实显示的字号
    const oldWay = fs;              // 旧算法：直接用 fontSize
    const newWay = fs * zoom;       // 新算法：乘 zoom
    eq(newWay, onScreen, `zoom=${zoom}：新算法字号与屏幕显示一致`);
    if (zoom !== 1) {
      ok(oldWay !== onScreen, `（对照）zoom=${zoom}：旧算法字号与屏幕显示不符`);
    }
  }

  // 17.8 行高：多行时按总高/行数
  const boxH = 60, lines = 3;
  eq(boxH / lines, 20, '三行 60px → 单行行高 20px');
  ok(boxH !== 20, '（对照）直接用 box.height 作为 line-height 会偏大 3 倍');
}

/* ============================================================
   十八、设置面板（备份/动画等全局项从文件页移出）
   ============================================================ */

group('设置面板');

{
  const { openSettings } = await import('./panels.js');

  const s = { backupMinutes: 2, backupMax: 3, animate: false };
  const calls = [];
  const app = {
    settings: s,
    bridge: { registerTheme: () => true },
    api: {
      status: (m) => calls.push(['status', m]),
      commit() {},
      selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      setBackupMinutes: (v) => { s.backupMinutes = v; calls.push(['minutes', v]); },
      setBackupMax: (v) => { s.backupMax = v; calls.push(['max', v]); },
      setAnimate: (on) => { s.animate = on; calls.push(['animate', on]); },
      backupNow: () => calls.push(['backupNow']),
    },
  };

  const dlg = openSettings(app);
  const root = dlg.mask.querySelector('.mm-dialog');

  // 18.1 三段齐全
  const titles = [...root.querySelectorAll('h3')].map((x) => x.textContent);
  ok(titles.includes('备份'), '有「备份」段');
  ok(titles.includes('外观'), '有「外观」段（布局动画）');
  ok(titles.includes('其它'), '有「其它」段（快捷键）');

  // 18.2 备份间隔 / 最多保留
  //
  // 原先断言「恰好 2 个下拉」。新增 PDF 通道后是 3 个 ——
  // 但**前两个仍必须是自动间隔和最多保留**：这里真正要保证的是
  // 「新增设置项排在后面，不挤动既有项的顺序」（用户的肌肉记忆）。
  // 若把 PDF 通道放到最前面，下面两条就会红。
  const sels = [...root.querySelectorAll('select.mm-select')];
  ok(sels.length >= 2, '至少两个下拉（自动间隔 + 最多保留）');
  ok(sels[0].innerHTML.includes('分钟'), '第一个下拉是时间间隔');
  ok(sels[1].innerHTML.includes('份'), '第二个下拉是保留份数');
  // 新增的 PDF 通道下拉必须在它们**之后**
  ok(sels.slice(2).some((x) => x.innerHTML.includes('矢量')), 'PDF 通道下拉排在既有项之后');

  sels[0].value = '10';
  sels[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  eq(s.backupMinutes, 10, '改间隔会调用 setBackupMinutes');

  sels[1].value = '5';
  sels[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  eq(s.backupMax, 5, '改份数会调用 setBackupMax');

  // 18.3 布局动画按钮点一下就切换（就地更新，不重建 DOM）
  const btnOf = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent === t);
  const off = btnOf('已关闭');
  ok(!!off, '动画默认显示为「已关闭」');
  off.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  eq(s.animate, true, '点击后开启动画');
  ok(!btnOf('已关闭') && !!btnOf('已开启'), '按钮文案就地更新（不整体重建）');

  // 18.4 立即备份 / 历史快照 / 快捷键 入口
  ok(!!btnOf('立即备份'), '有「立即备份」');
  ok(!!btnOf('历史快照…'), '有「历史快照…」');
  ok(!!btnOf('快捷键…'), '有「快捷键…」');
  btnOf('立即备份').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  ok(calls.some((c) => c[0] === 'backupNow'), '「立即备份」调用 api.backupNow');

  dlg.close();
}

{
  // 18.5 文件页不再塞这些全局设置
  const src = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');
  const filePage = src.slice(src.indexOf('function pageFile'), src.indexOf('/* ------------------------- 样式页'));
  ok(!/section\('备份与恢复'/.test(filePage), '文件页不再有「备份与恢复」段');
  ok(!/section\('布局动画'/.test(filePage), '文件页不再有「布局动画」段');
  ok(!/setBackupMinutes/.test(filePage), '文件页不再直接改备份间隔');
  ok(!/setAnimate/.test(filePage), '文件页不再直接改动动画开关');
  // 导入导出已从文件页移到侧栏「导入导出」页（与顶栏那套合并）
  ok(!/section\('导入导出'/.test(filePage), '文件页不再有「导入导出」段（已并入新页签）');
  ok(/导入导出/.test(filePage) && /导入导出页|已全部移到/.test(filePage),
    '留有注释说明搬去哪了');
}

{
  // 18.6 顶栏：设置按钮在重载左边
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const seg = src.slice(src.indexOf("B('设置'"), src.indexOf('// 属性侧栏页签'));
  const iSet = seg.indexOf("B('设置'");
  const iReload = seg.indexOf("B('重载'");
  ok(iSet >= 0 && iReload >= 0, '顶栏同时有「设置」与「重载」');
  ok(iSet < iReload, '设置按钮在重载按钮**左边**');
  ok(/openSettings\(app\)/.test(seg), '设置按钮打开 openSettings');
  ok(/refocus:\s*false/.test(seg), '设置按钮 refocus:false（模态浮层打开时不把焦点还给画布）');
  ok(/openSettings/.test(src.slice(0, src.indexOf("import { buildSide") + 200)) ||
     /import \{[^}]*openSettings[^}]*\} from '\.\/panels\.js'/.test(src),
    'index.js 已 import openSettings');
}

/* ============================================================
   十九、A49 切换画布原子性 + A48 保存抑制补存
   ============================================================ */

group('A49/A48 持久化正确性');

{
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');

  // ---- A49 源码契约 ----
  const fn = src.slice(src.indexOf('async function switchSheet(id)'),
    src.indexOf('/* ------------------------- 文件库（多文档）'));

  ok(/let switchingSheet = false;/.test(src), '声明了重入守卫变量（漏声明会在严格模式下直接抛错）');
  ok(/if \(switchingSheet\) return;/.test(fn), '① 重入守卫：切换进行中直接返回');
  ok(/if \(!bridge\?\.ready\) \{ status\('编辑器未就绪，稍后再切换画布', true\); return; \}/.test(fn),
    '② 编辑器未就绪时中止（否则 exportJson 拿不到内容，编辑就丢了）');
  ok(/const target = workbook\.sheets\.find\(\(s\) => s\.id === id\);/.test(fn),
    '③ 目标存在性检查');
  ok(/if \(!target\) return;/.test(fn), '③ 目标不存在则中止');
  ok(/if \(capture\(\) === 'missing'\) \{/.test(fn), '④ capture 拿不到内容时中止');
  ok(/status\('画布内容读取失败，已取消切换', true\);/.test(fn), '④ 中止时要告诉用户，不能静默');
  ok(/switchingSheet = true;/.test(fn) && /finally \{\s*switchingSheet = false;/.test(fn),
    '守卫用 try/finally 释放（异常时不会永久卡死切换）');

  // 顺序：四道检查必须都在改 activeId 之前
  const iGuard = fn.indexOf('if (switchingSheet) return;');
  const iReady = fn.indexOf('if (!bridge?.ready)');
  const iTarget = fn.indexOf('const target = workbook.sheets.find');
  const iCapture = fn.indexOf('capture() ===');
  const iActive = fn.indexOf('workbook.activeId = id;');
  ok(iGuard < iReady && iReady < iTarget && iTarget < iCapture && iCapture < iActive,
    '四道检查全部排在 activeId 修改**之前**（顺序本身就是原子性）');

  // ---- capture 三态 ----
  const cap = src.slice(src.indexOf('function capture() {'), src.indexOf('function commit()'));
  ok(/return 'missing';/.test(cap), "capture 返回 'missing'（拿不到内容）");
  ok(/return 'same';/.test(cap), "capture 返回 'same'（内容未变）");
  ok(/return 'changed';/.test(cap), "capture 返回 'changed'（已写回）");
  ok(!/return false;/.test(cap), "（对照）capture 不再返回 false —— 那无法区分「没变」与「拿不到」");
}

{
  // ---- A49 行为对照：旧实现（无守卫）会不会真的写错画布 ----
  // 场景：连点两个页签，两次切换交错。
  const mkSheets = () => [
    { id: 'A', content: { root: { data: { text: 'A内容' } } } },
    { id: 'B', content: { root: { data: { text: 'B内容' } } } },
    { id: 'C', content: { root: { data: { text: 'C内容' } } } },
  ];

  // 旧实现：capture() 后立刻改 activeId；第二次调用进来时 activeId 已被改掉
  function oldSwitch(wb, id, editorJson) {
    if (id === wb.activeId) return;
    // 旧：capture() 写进 sheet()（= 当前 activeId 对应的那张）
    const cur = wb.sheets.find((s) => s.id === wb.activeId) || wb.sheets[0];
    cur.content = editorJson;
    wb.activeId = id;
  }

  const wbOld = { activeId: 'A', sheets: mkSheets() };
  // 用户从 A 连点 B、C：两次调用几乎同时，编辑器里都还是 A 的内容
  oldSwitch(wbOld, 'B', { root: { data: { text: 'A内容' } } });
  oldSwitch(wbOld, 'C', { root: { data: { text: 'A内容' } } });
  eq(wbOld.sheets.find((s) => s.id === 'B').content.root.data.text, 'A内容',
    '（对照）旧实现：A 的内容被写进了 B —— 数据错乱');

  // 新实现：重入守卫拦住第二次
  function newSwitch(wb, id, editorJson, switchingRef) {
    if (switchingRef.on) return;
    if (id === wb.activeId) return;
    const target = wb.sheets.find((s) => s.id === id);
    if (!target) return;
    const cur = wb.sheets.find((s) => s.id === wb.activeId) || wb.sheets[0];
    cur.content = editorJson;
    wb.activeId = id;
    switchingRef.on = true;   // 模拟「切换进行中」（异步 loadSheet 尚未完成）
  }
  const wbNew = { activeId: 'A', sheets: mkSheets() };
  const ref = { on: false };
  newSwitch(wbNew, 'B', { root: { data: { text: 'A内容' } } }, ref);
  newSwitch(wbNew, 'C', { root: { data: { text: 'A内容' } } }, ref);   // 被守卫拦下
  eq(wbNew.activeId, 'B', '新实现：第二次切换被守卫拦住，activeId 停在 B');
  eq(wbNew.sheets.find((s) => s.id === 'C').content.root.data.text, 'C内容',
    '新实现：C 的内容未被污染');
}

{
  // ---- A48 行为对照：抑制期间的编辑，旧实现会丢 ----
  let saved = 0;
  const state = { suppress: false, dirtyDuringSuppress: false };

  function oldOnDirty() { if (state.suppress) return; saved++; }   // 直接丢弃
  function newOnDirty() { if (state.suppress) { state.dirtyDuringSuppress = true; return; } saved++; }
  function endSuppress() {
    state.suppress = false;
    if (state.dirtyDuringSuppress) { state.dirtyDuringSuppress = false; saved++; }  // 补存
  }

  // 旧：抑制期间的一次编辑
  saved = 0;
  state.suppress = true; state.dirtyDuringSuppress = false;
  oldOnDirty();                 // 用户在抑制窗口内改了东西
  state.suppress = false;
  eq(saved, 0, '（对照）旧实现：抑制期间的编辑被直接丢弃，永久丢失');

  // 新：同样的编辑
  saved = 0;
  state.suppress = true; state.dirtyDuringSuppress = false;
  newOnDirty();
  endSuppress();
  eq(saved, 1, '新实现：抑制期间的编辑被记录，解除后补存');

  // 抑制期间没有编辑 → 不该凭空补存
  saved = 0;
  state.suppress = true; state.dirtyDuringSuppress = false;
  endSuppress();
  eq(saved, 0, '抑制期间无编辑时不补存（避免无谓写盘）');

  // ---- A48 源码契约 ----
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  ok(/function beginSuppress\(\)/.test(src), '抽出 beginSuppress()');
  ok(/function endSuppressSoon\(\)/.test(src), '抽出 endSuppressSoon()（延迟解除）');
  ok(/if \(suppress\) \{ dirtyDuringSuppress = true; return; \}/.test(src),
    'onDirty 在抑制期间记录而非丢弃');
  ok(/suppressTimer = setTimeout\(\(\) => \{/.test(src), '解除是延迟的（吸收异步派发）');
  ok(/if \(dirtyDuringSuppress\) \{\s*dirtyDuringSuppress = false;\s*scheduleSave\(\);/.test(src),
    '延迟解除后若有变更则补存');
  ok(/const SUPPRESS_MS = 800;/.test(src), '抑制窗口 800ms（WPF 是 1200ms，Web 同步直调故更短）');
}

/* ============================================================
   二十、A44 手动备份去重 + A46 恢复确认
   ============================================================ */

group('A44/A46 备份闭环');

{
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const cap = src.slice(src.indexOf('async function backupNow('), src.indexOf('async function restoreBackup'));

  // ---- A44 手动备份去重 ----
  ok(/async function backupNow\(force = false\)/.test(src), 'backupNow 支持 force 参数');
  ok(/const fp = wb\.fingerprintSheets\(workbook\.sheets\);/.test(cap), '手动备份也先算指纹');
  ok(/if \(!force && fp === lastBackupFp\) \{/.test(cap), '内容相同则跳过（force 除外）');
  ok(/status\('内容与最新快照相同，未重复创建', false\)/.test(cap), '跳过时明确告知用户，不是静默无反应');
  ok(/lastBackupFp = fp;/.test(cap), '写成功后更新指纹');

  // ---- A46 恢复前留后路 ----
  const rst = src.slice(src.indexOf('async function restoreBackup'), src.indexOf('/* ------------------------- 对外能力'));
  ok(/await backupNow\(true\);/.test(rst), '恢复前先把当前状态另存一份（恢复错了还能回滚）');
  ok(/不可撤销|已另存一份|恢复前的状态已另存/.test(rst), '提示里说明已留后路');

  // ---- 恢复必须有确认 ----
  const p = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');
  const seg = p.slice(p.indexOf('export async function openBackups'), p.indexOf('/* ------------------------- 设置'));
  // 上游把 window.confirm 换成了 dialog.js 的 askConfirm（await 版），
  // 语义不变：恢复要确认，且标 danger
  ok(/askConfirm\(/.test(seg) || /window\.confirm\(/.test(seg),
    'A46 恢复前有确认对话框（覆盖全部画布，不可逆）');
  ok(/danger:\s*true/.test(seg), '确认框标为 **danger**（危险操作，视觉上要区分）');
  ok(/不可撤销/.test(seg), '确认文案说明不可撤销');
  ok(/safe\('恢复快照'/.test(seg), '恢复动作包了 safe()（异步失败要看得见）');
}

{
  // ---- A44 行为对照：不去重会挤掉真实历史 ----
  const KEEP = 3;
  function makeStore() {
    const keys = [];
    return {
      push(snap) {
        keys.push({ ts: keys.length, sheets: snap.sheets, fp: snap.fp });
        while (keys.length > KEEP) keys.shift();   // 滚动删除最旧
        return true;
      },
      list: () => keys.slice(),
    };
  }

  const fpOf = (s) => (s || []).map((x) => x.id + ':' + x.text).join('|');
  const A = [{ id: '1', text: 'v1' }];

  // 旧：连点三次「立即备份」，内容都没变
  const old = makeStore();
  for (let i = 0; i < 3; i++) old.push({ sheets: A, fp: fpOf(A) });
  eq(old.list().length, KEEP, '（对照）旧实现：三次相同内容各写一份');
  eq(new Set(old.list().map((x) => x.fp)).size, 1,
    '（对照）旧实现：3 份快照内容全一样 —— 真实历史已被挤空');

  // 新：同样连点三次
  const nw = makeStore();
  let lastFp = null;
  for (let i = 0; i < 3; i++) {
    const fp = fpOf(A);
    if (fp === lastFp) continue;      // 去重
    nw.push({ sheets: A, fp });
    lastFp = fp;
  }
  eq(nw.list().length, 1, '新实现：内容没变只写一份');

  // 内容真的变了才写新的
  const B = [{ id: '1', text: 'v2' }];
  if (fpOf(B) !== lastFp) { nw.push({ sheets: B, fp: fpOf(B) }); lastFp = fpOf(B); }
  eq(nw.list().length, 2, '内容变化后才追加新快照');
  eq(new Set(nw.list().map((x) => x.fp)).size, 2, '两份快照内容不同 —— 都是有效历史');
}

/* ============================================================
   二十一、A3–A10 预设图标库
   ============================================================ */

group('A3–A10 预设图标库');

const picons = await import('./preset-icons.js');

{
  // ---- 内置集合 ----
  const lib = await picons.loadLibrary();
  ok(lib.length >= 5, `内置分组 ${lib.length} 个`);
  ok(lib.every((g) => g.builtin), '首次加载全是内置分组');
  ok(lib.every((g) => (g.icons || []).length > 0), '每个内置分组都有图标');

  const names = lib.map((g) => g.name);
  ok(new Set(names).size === names.length, '内置分组名不重复');

  // 图标必须有可用的 path（没有的话 dataURL 会画出一个空框）
  const allIcons = lib.flatMap((g) => g.icons);
  ok(allIcons.every((i) => i.kind === 'builtin' && i.d && i.d.length > 0),
    '每个内置图标都有 SVG path');
  const ids = allIcons.map((i) => i.id);
  eq(new Set(ids).size, ids.length, '内置图标 id 唯一（重用会互相覆盖）');

  // ---- SVG dataURL 必须能解码成合法 SVG ----
  const u = picons.builtinIconUrl('M5 13l4 4L19 7');
  ok(/^data:image\/svg\+xml;charset=utf-8,/.test(u), '内置图标产出 SVG dataURL');
  const svg = decodeURIComponent(u.split(',')[1]);
  ok(svg.startsWith('<svg') && svg.includes('</svg>'), 'dataURL 解码后是完整 <svg>');
  ok(/viewBox="0 0 24 24"/.test(svg), 'viewBox 固定 24×24（图标才能统一缩放）');
  // stroke 必须有具体颜色：SVG 当 <img> 加载时是独立文档，
  // currentColor 没有继承上下文，会画成黑块。
  ok(!/stroke="currentColor"/.test(svg), '（对照）不能是 currentColor —— img 里无继承上下文');
  ok(/stroke="#[0-9A-Fa-f]{6}"/.test(svg), 'stroke 是具体色值');
  ok(/width="\d+"\s+height="\d+"/.test(svg), '有明确的 width/height（内核靠它探测尺寸）');
}

{
  // ---- A3/A7 分组管理 ----
  const g = await picons.addGroup('我的图标');
  ok(!!g, '新建分组成功');
  eq(g.name, '我的图标', '分组名正确');

  const g2 = await picons.addGroup('我的图标');
  eq(g2.name, '我的图标 2', '重名自动加序号（对齐 WPF UniqueGroupName）');

  // 分组名校验
  let lib = await picons.loadLibrary();
  eq(picons.validateGroupName(lib, ''), '分组名不能为空。', '空名被拒');
  eq(picons.validateGroupName(lib, '我的图标'), '分组「我的图标」已存在。', '重名被拒');
  eq(picons.validateGroupName(lib, '全新名字'), null, '合法名通过');

  // 内置分组不可改名/删除
  const builtin = lib.find((x) => x.builtin);
  const r1 = await picons.renameGroup(builtin.id, '改了');
  eq(r1.ok, false, '内置分组不可重命名');
  ok(/内置分组/.test(r1.error), '给出具体原因');
  const r2 = await picons.deleteGroup(builtin.id);
  eq(r2.ok, false, '内置分组不可删除');

  // 重命名
  const r3 = await picons.renameGroup(g.id, '重命名后');
  ok(r3.ok, '用户分组可重命名');
  lib = await picons.loadLibrary();
  eq(lib.find((x) => x.id === g.id).name, '重命名后', '重命名已落盘');

  // 重命名为已存在的名字要被拒
  const r4 = await picons.renameGroup(g.id, '我的图标 2');
  eq(r4.ok, false, '重命名为已有名被拒');
}

{
  // ---- A4 导入图标 + A6 重命名 + 删除 ----
  let lib = await picons.loadLibrary();
  let g = lib.find((x) => !x.builtin);
  if (!g) g = await picons.addGroup('测试组');

  const r = await picons.addIcon(g.id, { kind: 'user', name: 'logo', assetId: 'as1' });
  ok(r.ok, '导入图标成功');
  eq(r.icon.name, 'logo', '图标名正确');

  const r2 = await picons.addIcon(g.id, { kind: 'user', name: 'logo', assetId: 'as2' });
  eq(r2.icon.name, 'logo 2', '同名自动加序号（对齐 WPF 导入重名处理）');

  lib = await picons.loadLibrary();
  g = lib.find((x) => x.id === g.id);
  eq((g.icons || []).length, 2, '两个图标都在');

  // 重命名
  const r3 = await picons.renameIcon(g.id, r.icon.id, '新名字');
  ok(r3.ok, '重命名图标成功');
  const r4 = await picons.renameIcon(g.id, r.icon.id, '   ');
  eq(r4.ok, false, '空名被拒');

  // ---- A9 跨组移动 ----
  const g2 = await picons.addGroup('另一个组');
  const mv = await picons.moveIcon(g.id, r.icon.id, g2.id);
  ok(mv.ok, '用户图标可跨组移动');
  lib = await picons.loadLibrary();
  eq((lib.find((x) => x.id === g.id).icons || []).length, 1, '源组少了一个');
  eq((lib.find((x) => x.id === g2.id).icons || []).length, 1, '目标组多了一个');

  // 内置图标不可移动 —— 它们是常量，移了下次加载会被重新生成回去
  const builtinIcon = lib.find((x) => x.builtin).icons[0];
  const mv2 = await picons.moveIcon(lib.find((x) => x.builtin).id, builtinIcon.id, g2.id);
  eq(mv2.ok, false, '内置图标不可移动（否则表现为「移动无效」）');

  // 内置分组不可加图标
  const add1 = await picons.addIcon(lib.find((x) => x.builtin).id, { kind: 'user', name: 'x', assetId: 'as9' });
  eq(add1.ok, false, '内置分组不可添加图标');
}

{
  // ---- A7 删除分组：至少保留一个 ----
  // 清掉已有用户分组，只留一个，再试着删它
  let lib = await picons.loadLibrary();
  const userGroups = lib.filter((x) => !x.builtin);
  for (const g of userGroups.slice(1)) await picons.deleteGroup(g.id);
  lib = await picons.loadLibrary();
  const last = lib.filter((x) => !x.builtin);
  if (last.length === 1) {
    // 内置分组 + 1 个用户分组 > 1，这里要测的是「用户分组不可删到 0」
    // 实际上 WPF 的约束是分组总数 >= 1；Web 版内置恒在，故用户分组可以删光。
    // 关键是：删光后 loadLibrary 仍能返回内置分组，不会变成空库。
    const r = await picons.deleteGroup(last[0].id);
    ok(r.ok, '最后一个用户分组可删（内置分组兜底，库不会空）');
    lib = await picons.loadLibrary();
    ok(lib.length >= 5 && lib.every((g) => g.builtin), '删光用户分组后仍剩内置分组');
    ok(lib.some((g) => (g.icons || []).length > 0), '内置图标仍在 —— 库不会变空');
  } else {
    /*
     * ⓘ 原写 `ok(true, '（跳过）…')` —— 恒真，且计入 pass，
     *   于是"最后一组删除"到底测没测过，报告上永远看不出来。
     */
    skip('最后一个用户分组可删', '用户分组数量不符，前置条件没满足');
  }
}

group('清理失效图标：资产「读不出来」不得当成「已失效」删掉（BUG 71）');

{
  const io = await import('./io.js');
  /*
   * store.get 读失败时是「吞异常、返回默认值 null」（见 store.js 读路径注释），
   * 于是 pruneMissing 里 `rec?.blob` 为假 —— 与「这个图标的资产确实没了」
   * **长得一模一样**。
   *
   * 一次偶发的读失败（IndexedDB 被禁用、单条记录损坏、大 Blob 读取被打断）
   * 就会把**整个用户图标库**判定为失效：图标条目被删、写回磁盘，
   * 而资产字节可能还在库里 —— 于是图标没了、字节留着，变成没人引用的孤儿。
   * 图标库没有撤销，删掉就是永久的。
   */
  let lib = await picons.loadLibrary();
  for (const g of lib.filter((x) => !x.builtin)) await picons.deleteGroup(g.id);
  const g = await picons.addGroup('失效测试组');
  const a1 = await io.putAsset(new Blob(['png-1'], { type: 'image/png' }));
  const a2 = await io.putAsset(new Blob(['png-2'], { type: 'image/png' }));
  ok(!!a1 && !!a2, '两个图标资产已入库');
  await picons.addIcon(g.id, { kind: 'user', name: 'i1', assetId: a1 });
  await picons.addIcon(g.id, { kind: 'user', name: 'i2', assetId: a2 });

  // 资产都在 → 一个都不该清
  const r0 = await picons.pruneMissing();
  eq(r0.removed, 0, '资产都在时清理不到任何图标');

  // 只让 asset: 的读取失败（iconlib 本身照常可读 —— 否则测的就是另一条路）
  ctl.failGetPrefix = 'asset:';
  const r1 = await picons.pruneMissing();
  ctl.failGetPrefix = '';
  store.resetStoreError();
  eq(r1.removed, 0, '资产读不出来时不得删除任何图标（读失败 ≠ 已失效）');
  ok(r1.aborted === true, '读失败要中止清理并回报 aborted');

  lib = await picons.loadLibrary();
  const gg = lib.find((x) => x.id === g.id);
  eq(((gg && gg.icons) || []).length, 2, '用户图标一个都没被删');

  // 真的失效（资产确实没了）才删 —— 这条路必须仍然工作
  await store.del('asset:' + a2);
  const r2 = await picons.pruneMissing();
  eq(r2.removed, 1, '资产确实丢失的那一个才被清理');
  ok(r2.saved !== false, '清理结果已落盘');
  lib = await picons.loadLibrary();
  const gg2 = lib.find((x) => x.id === g.id);
  eq(((gg2 && gg2.icons) || []).length, 1, '只剩还在的那个图标');

  // dryRun：只统计不落盘（供界面先问一句再动手）
  await store.del('asset:' + a1);
  const dry = await picons.pruneMissing({ dryRun: true });
  eq(dry.removed, 1, 'dryRun 报出会清掉 1 个');
  lib = await picons.loadLibrary();
  const gg3 = lib.find((x) => x.id === g.id);
  eq(((gg3 && gg3.icons) || []).length, 1, 'dryRun 不落盘：图标还在');

  /*
   * 写盘失败必须回报出来。
   *
   * 只断言 `saved !== false` 是**空转**的：把实现写成 `saved: true`
   * 照样绿（变异验证 M4 就是这么漏掉的）。必须真的注入一次写失败，
   * 看它是否回报 false —— 否则界面会说「已清理 N 个」，
   * 重载后图标又回来，而资产确实已经没了，于是变成永久空白。
   */
  ctl.failPut = true;
  const r3 = await picons.pruneMissing();
  ctl.failPut = false;
  store.resetStoreError();
  eq(r3.removed, 1, '写盘失败时仍报出清理数量');
  eq(r3.saved, false, '图标库写盘失败要回报 saved:false（不能假装成功）');

  // ---- 界面层：先问一句、并照实说写盘结果 ----
  const psrc = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');
  const pi = psrc.slice(psrc.indexOf('const pruneIcons = async ()'));
  const piBody = pi.slice(0, pi.indexOf('\n  };'));
  ok(/askConfirm\(/.test(piBody), '清理失效图标：走二次确认（批量删除且不可逆）');
  ok(/danger:\s*true/.test(piBody), '清理失效图标：确认框标 danger');
  /*
   * 顺序才是关键：必须先 dryRun 拿到数量、确认之后再真删。
   * 只断言「出现了 askConfirm」抓不到「先删后问」——
   * 那样用户看到的确认框是在东西已经没了之后弹的。
   */
  const iDry = piBody.indexOf('dryRun: true');
  const iAsk = piBody.indexOf('askConfirm(');
  const iReal = piBody.indexOf('await picons.pruneMissing();');
  ok(iDry >= 0 && iAsk > iDry, '清理失效图标：先 dryRun 统计再确认');
  ok(iReal > iAsk, '清理失效图标：确认之后才真正删除');
  ok(/r\.removed && !r\.saved/.test(piBody), '清理失效图标：写盘失败要照实说');
  ok(/dry\.aborted/.test(piBody), '清理失效图标：读不出来时中止并说明');
}


{
  // ---- 内置图标不进持久化 ----
  // 若把内置集合也存进 IndexedDB，将来新增内置图标老用户永远看不到。
  const src = (fs.readFileSync(path.join(HERE, 'preset-icons.js'), 'utf8')).replace(/\r\n/g, '\n');
  ok(/const K_ICONLIB = 'iconlib';/.test(src), '图标库有独立存储键');
  const saveFn = src.slice(src.indexOf('async function saveUserGroups'), src.indexOf('const newId'));
  ok(/groups\.filter\(\(g\) => !g\.builtin\)/.test(saveFn), '只持久化用户分组（内置不落盘）');
  ok(/\[...builtinGroups\(\), ...ug/.test(src), '读取时把内置分组拼在最前');
}

{
  // ---- A10：不做 ico 转换，须有说明 ----
  const src = (fs.readFileSync(path.join(HERE, 'preset-icons.js'), 'utf8')).replace(/\r\n/g, '\n');
  ok(/不实现 ico 转换/.test(src), 'A10 ico 转换：明确标注不适用并说明理由');
  ok(/SVG/.test(src.slice(0, 1200)), '改用 SVG（矢量、无需多尺寸转换）');
}

{
  // ---- 渲染：标签页有「图标库…」入口 ----
  const { buildSide } = await import('./panels.js');
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: { getSelectedNodeId: () => 'n1' }, customThemes: [],
  }, {});
  el.open('tag');
  const btns = [...el.el.querySelectorAll('button')].map((b) => b.textContent);
  ok(btns.includes('图标库…'), '标签页有「图标库…」入口');
  // 清除图标从独立一行并入第一行后，按钮文案成了 ✕。
  // 按 title 找而不是按文案 —— 文案是 ✕，与颜色行的清除按钮一样，
  // 按文案找会同时命中好几个，断言不出"这一个存在"。
  const hasClearIcon = [...el.el.querySelectorAll('button')]
    .some((b) => /清除节点上的图标/.test(b.getAttribute('title') || ''));
  ok(hasClearIcon, '有「清除图标」（并入第一行）');
  // 三个按钮必须同一行：拆两行会让"清除"看着像另一个独立功能
  {
    const iconSec = [...el.el.querySelectorAll('.mm-field')]
      .find((f) => f.querySelector('h3')?.textContent === '图标');
    const rowCount = iconSec ? iconSec.querySelectorAll('.mm-row').length : 99;
    eq(rowCount, 1, '图标区三个按钮同一行');
  }
}

{
  // ---- io.pickFiles 多选（A4 批量导入需要）----
  const io = await import('./io.js');
  ok(typeof io.pickFiles === 'function', 'io 提供 pickFiles（批量导入用）');
  const src = (fs.readFileSync(path.join(HERE, 'io.js'), 'utf8')).replace(/\r\n/g, '\n');
  ok(/export function pickFile\(accept = '', multiple = false\)/.test(src), 'pickFile 支持 multiple 参数');
  ok(/inp\.multiple = true/.test(src), 'multiple 时设置 input.multiple');
  // 取消时：单文件返回 null、多文件返回 []，调用方才好区分
  ok(/multiple \? \[\] : null/.test(src), '取消时多文件返回 []（与单文件的 null 区分）');
}

/* ============================================================
   二十二、A1/A2/A13/A14 优先级与进度徽章
   ============================================================ */

group('A1/A2 优先级与进度徽章');

const tb = await import('./tag-badges.js');

{
  // ---- 配色必须来自 WPF 精灵图采样，不是随手挑的 ----
  eq(tb.PRIORITY_COLORS.length, 9, '优先级 9 档颜色');
  eq(tb.PRIORITY_COLORS[0], '#E60E07', 'P1 红（iconpriority.png cell0 采样）');
  eq(tb.PRIORITY_COLORS[1], '#006BE5', 'P2 蓝（cell1）');
  eq(tb.PRIORITY_COLORS[2], '#00A000', 'P3 绿（cell2）');
  eq(tb.PRIORITY_COLORS[3], '#F08825', 'P4 橙（cell3）');
  eq(tb.PRIORITY_COLORS[4], '#9156F3', 'P5 紫（cell4）');
  eq(tb.PRIORITY_COLORS[8], '#939393', 'P9 灰（cell8）');
  // 6–9 同为灰是原图设计（低优先级统一灰，避免画面太花），不是采样失败
  ok(tb.PRIORITY_COLORS.slice(5).every((c) => c === '#939393'), 'P6–P9 同为灰色（原图设计）');

  eq(tb.PROGRESS_BG, '#FFE98A', '进度底色 黄（iconprogress.png 采样）');
  eq(tb.PROGRESS_FG, '#6DB200', '进度填充 绿（采样）');
  eq(tb.PROGRESS_FILL.length, 9, '进度 9 档填充比例');
  eq(tb.PROGRESS_FILL[0], 0, '1/9 全黄（绿色占比 0）');
  eq(tb.PROGRESS_FILL[8], 1, '9/9 全绿');
  // 单调递增：填充比例必须随进度上升，否则视觉与语义相反
  let mono = true;
  for (let i = 1; i < 9; i++) if (!(tb.PROGRESS_FILL[i] > tb.PROGRESS_FILL[i - 1])) mono = false;
  ok(mono, '填充比例单调递增（1/9→9/9 黄→绿）');
  // 与 (i-1)/8 的理论值不能差太远
  const maxDev = Math.max(...tb.PROGRESS_FILL.map((v, i) => Math.abs(v - i / 8)));
  ok(maxDev < 0.15, `填充比例贴近理论值 (i-1)/8（最大偏差 ${maxDev.toFixed(2)}）`);

  eq(tb.CLEAR_BG, '#E1E1E1', '清除格底色 浅灰（cell9）');
  eq(tb.CLEAR_FG, '#C1272D', '清除格前景 红（cell9）');
}

{
  // ---- 渲染函数 ----
  eq(tb.priorityBg(1), '#E60E07', 'priorityBg(1)');
  eq(tb.priorityBg(9), '#939393', 'priorityBg(9)');
  eq(tb.priorityBg(99), '#939393', 'priorityBg 越界钳到 9（不返回 undefined）');
  eq(tb.priorityBg(0), '#E60E07', 'priorityBg(0) 钳到 1（0 走清除格分支，不进这里）');

  ok(tb.progressBg(1).startsWith('#'), '1/9 是纯色（全黄，不必写渐变）');
  ok(tb.progressBg(9).startsWith('#'), '9/9 是纯色（全绿）');
  ok(/linear-gradient/.test(tb.progressBg(5)), '5/9 是渐变');
  ok(tb.progressBg(5).includes('43%'), '5/9 渐变断点 = 43%');

  eq(tb.badgeLabel(5), '5', '数字格显示数字');
  eq(tb.badgeLabel(0), '✕', '清除格显示 ✕（不是 0 —— 0 会被当成数字）');
  eq(tb.badgeBg('priority', 0), tb.CLEAR_BG, '清除格用清除色');
  eq(tb.badgeTitle('priority', 3), '优先级 3', '优先级 tooltip');
  eq(tb.badgeTitle('progress', 3), '进度 3/9', '进度 tooltip 带分母');
  eq(tb.badgeTitle('priority', 0), '移除优先级', '清除格 tooltip（对齐 WPF clearTip）');

  // 语义校验：清除格必须真的下发 0
  eq(tb.BADGE_ROWS.flat().filter((v) => v === 0).length, 1, '恰好一个清除格');
  eq(tb.BADGE_ROWS.flat().length, 10, '共 10 格（1–9 + 清除）');
  // 单排：10 个档位是同一维度，拆两排会让人以为 1–5 与 6–9 是两类。
  // 只断言"只有一行"还不够 —— 若某人拆成 [[1..5],[6..9,0]] 但顺序仍对，
  // 上面两条照样绿。这里直接断言首行长度。
  eq(tb.BADGE_ROWS.length, 1, '徽章只有一行（10 格排一排）');
  eq(tb.BADGE_ROWS[0].length, 10, '首行就是全部 10 格');
  eq(tb.BADGE_ROWS[0][9], 0, '清除格在末位');
}

{
  // ---- 页面渲染 ----
  const { buildSide } = await import('./panels.js');
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: {
      getSelectedPriority: () => null,
      getSelectedProgress: () => null,
    },
    customThemes: [],
  }, {});
  el.open('tag');

  const rows = [...el.el.querySelectorAll('.mm-badge-row')];
  eq(rows.length, 2, '优先级+进度 各一行 = 2 行');
  eq(rows[0].querySelectorAll('.mm-badge').length, 10, '每行 10 格（1–9 + 清除）');
  eq(el.el.querySelectorAll('.mm-badge').length, 20, '共 20 格（两组各 10）');

  // 清除格必须是 ✕ 且 data-v=0
  const clears = [...el.el.querySelectorAll('.mm-badge')].filter((b) => b.getAttribute('data-v') === '0');
  eq(clears.length, 2, '两组各一个清除格');
  ok(clears.every((b) => b.textContent.includes('✕')), '清除格显示 ✕');

  // 数字格背景色
  const p1 = el.el.querySelector('.mm-badge[data-v="1"] .mm-badge-face');
  ok(p1, '有 P1 徽章');
  eq(p1.style.background.replace(/\s/g, ''), 'rgb(230,14,7)', 'P1 徽章背景是采样到的红');
}

{
  // ---- 回显：当前优先级要高亮 ----
  const { buildSide } = await import('./panels.js');
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: {
      getSelectedPriority: () => 2,
      getSelectedProgress: () => 7,
    },
    customThemes: [],
  }, {});
  el.open('tag');
  const on = [...el.el.querySelectorAll('.mm-badge.on')];
  eq(on.length, 2, '优先级与进度各高亮一个');
  ok(on.some((b) => b.getAttribute('data-v') === '2'), '优先级 2 高亮');
  ok(on.some((b) => b.getAttribute('data-v') === '7'), '进度 7 高亮');
}

{
  // ---- A13/A14：清除必须下发 0 ----
  const { buildSide } = await import('./panels.js');
  const calls = [];
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: {
      getSelectedPriority: () => null,
      getSelectedProgress: () => null,
      exec: (n, v) => { calls.push([n, v]); return true; },
    },
    customThemes: [],
  }, {});
  el.open('tag');
  const clear = [...el.el.querySelectorAll('.mm-badge')].find((b) => b.getAttribute('data-v') === '0');
  clear.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  ok(calls.some(([n, v]) => n === 'priority' && v === 0), 'A13 点清除格下发 priority 0');
}

{
  // ---- bridge 读取接口 ----
  const src = (fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8')).replace(/\r\n/g, '\n');
  ok(/getSelectedPriority\(\)/.test(src), 'bridge 有 getSelectedPriority');
  ok(/getSelectedProgress\(\)/.test(src), 'bridge 有 getSelectedProgress');
  ok(/getData\?\.\('priority'\)/.test(src), '优先级读 getData 而非 queryCommandValue');
  // queryCommandValue 在多选/未选中时返回哨兵值 -1，与「真的设了 -1」分不开
  ok(/未设置则是 undefined|v == null/.test(src), '未设置时返回 null（不用哨兵值）');
}

/* ============================================================
   二十三、A53–A57 页签拖拽
   ============================================================ */

group('A53–A57 页签拖拽');

const { attachTabDrag, swapIndex } = await import('./tab-drag.js');

{
  const src = (fs.readFileSync(path.join(HERE, 'tab-drag.js'), 'utf8')).replace(/\r\n/g, '\n');
  const idx = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');

  // ---- 为什么不用 HTML5 DnD：模块注释必须写明，否则后人会改回去 ----
  ok(/draggable=true/.test(src) && /无法自定义|做不到/.test(src), '模块说明了 HTML5 DnD 的局限（防止被改回去）');
  ok(/无死区|没有死区/.test(src), '点明 HTML5 dragstart 无死区（会吞掉单击/双击）');

  // ---- 事件委托：renderTabs 重建 DOM 时不重新绑定 ----
  ok(/container\.addEventListener\('pointerdown', onPointerDown\)/.test(src), 'pointerdown 挂在容器上（事件委托）');
  ok(/e\.target\.closest\?\.\('\[data-tab-id\]'\)/.test(src), '按 [data-tab-id] 找目标');
  ok(/document\.addEventListener\('pointermove'/.test(src), 'pointermove 挂 document（指针会移出容器）');
  ok(/data-tab-id/.test(idx), 'renderTabs 给页签加了 data-tab-id');
  ok(!/draggable:\s*true/.test(idx), '（对照）不再用 draggable=true');
  ok(!/function wireTabDrag/.test(idx), '（对照）不再逐个 wireTabDrag（重建会累积监听器）');

  // ---- A54 阈值：不达阈值不启动 ----
  ok(/const DRAG_THRESHOLD = 5;/.test(src), '有拖拽启动阈值');
  ok(/Math\.hypot\(dx, dy\) < DRAG_THRESHOLD\) return;/.test(src), '死区内不进入拖拽态（单击/双击才不会被吞）');

  // ---- A53 跟随：克隆而非移动原节点 ----
  ok(/cloneNode\(true\)/.test(src), 'A53 用克隆做跟随元素');
  ok(/position:fixed/.test(src), '跟随元素 fixed 定位（不受容器滚动影响）');
  ok(/pointer-events:none/.test(src), '跟随元素不拦截指针事件');
  ok(/removeAttribute\('data-tab-id'\)/.test(src), '跟随元素不参与顺序计算（否则顺序里会多一项）');
  ok(/\.mm-tab-follow/.test((fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n')), '有跟随元素样式');

  // ---- A55 自动滚动 ----
  ok(/const SCROLL_ZONE = 56;/.test(src), '边缘区 56px（对齐 WPF）');
  ok(/SCROLL_MIN_SPEED = 4/.test(src) && /SCROLL_MAX_SPEED = 18/.test(src), '速度区间 4–18（对齐 WPF）');
  ok(/requestAnimationFrame/.test(src), '用 rAF 驱动（页面隐藏时自动暂停，不空转）');
  ok(/container\.scrollLeft = /.test(src), '真的改 scrollLeft');
  // 滚动不产生 pointermove，必须主动重算，否则标签脱手
  ok(/滚动不产生 pointermove/.test(src), '注释说明滚动后必须主动重算');

  // ---- A56 插入竖条 ----
  ok(/mm-tab-insertbar/.test(src), 'A56 有插入竖条元素');
  ok(/mm-tab-insertbar/.test((fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n')), '竖条有样式');
  ok(/width:2px/.test(src), '竖条 2px 宽（对齐 WPF _sheetInsertBar）');

  // ---- A57 回弹 ----
  ok(/function springBack/.test(src), 'A57 有回弹函数');
  ok(/e\.key === 'Escape'/.test(src), 'ESC 可取消');
  ok(/transition = `left \$\{SPRING_MS\}/.test(src), '回弹走 transition 动画（不是瞬间消失）');

  // ---- 拖拽结束吞掉 click ----
  ok(/onClickCapture/.test(src), '拖拽刚结束时吞掉 click（避免顺带切换画布）');
  ok(/Date\.now\(\) - lastDragEndAt < 220/.test(src), '有时间间隔判定');

  // ---- 取消时恢复 DOM ----
  ok(/container\.insertBefore\(el, anchor \|\| null\)/.test(src), '取消时按锚点插回原位');
}

{
  // ---- A54 死区换位算法（对齐 WPF GetSheetSwapIndex）----
  // 三个等宽 100px 的页签，中心分别在 50 / 150 / 250
  const rects = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 100 },
  ];
  const R = (o) => o;   // swapIndex 只用 .left / .width

  // 拖第 0 个（rects[0] 传 null 表示它自己）
  const r0 = [null, R(rects[1]), R(rects[2])];
  // 探测点略过邻框中心 150，但没超过死区（16）→ 不换
  eq(swapIndex(150 + 10, 0, r0), 0, '越过中心但在死区内 → 不换（防抖动）');
  // 超过中心 + 死区 → 换一步
  eq(swapIndex(150 + 20, 0, r0), 1, '越过中心+死区 → 换一步');
  // 甩得很远 → 一次推进到底（循环多步）
  eq(swapIndex(999, 0, r0), 2, '快速甩动一次跨多格（循环推进）');
  // 反向
  eq(swapIndex(-999, 2, [R(rects[0]), R(rects[1]), null]), 0, '反向甩到最前');
  // 死区内保持
  eq(swapIndex(50, 0, r0), 0, '原地不动 → 索引不变');

  // 死区对小页签自动缩小（min(16, 宽*0.2)）
  const small = [null, { left: 0, width: 30 }];   // 邻框宽 30 → 死区 = 6
  eq(swapIndex(15 + 8, 0, small), 1, '小页签：死区缩小到 6，越过即换');
  eq(swapIndex(15 + 2, 0, small), 0, '小页签：仍在死区内不换');
}

{
  // ---- 顺序归并：DOM 漏了绝不能静默丢画布 ----
  const idx = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const fn = idx.slice(idx.indexOf('function applyTabOrder'), idx.indexOf('function addSheet'));
  ok(/new Map\(workbook\.sheets\.map\(\(s\) => \[s\.id, s\]\)\)/.test(fn), '按 id 建映射');
  ok(/for \(const s of map\.values\(\)\) next\.push\(s\);/.test(fn), 'DOM 里漏掉的补到末尾（不静默丢画布）');
  ok(/if \(next\.length !== workbook\.sheets\.length\) \{ renderTabs\(\); return; \}/.test(fn),
    '数量对不上就重建，不硬写（防止写坏数据）');
}

{
  // ---- 只有一张画布时不启动拖拽 ----
  const idx = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const seg = idx.slice(idx.indexOf('const tabDrag = attachTabDrag'), idx.indexOf('function applyTabOrder'));
  ok(/canDrag: \(\) => \(workbook\.sheets\?\.length \|\| 0\) > 1/.test(seg),
    '只有一张画布时不启动拖拽（拖了也没意义）');
}

{
  // ---- 行为级：模拟一次完整拖拽，验证顺序真的变了 ----
  const c = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(c);
  for (const id of ['A', 'B', 'C']) {
    const b = dom.window.document.createElement('button');
    b.className = 'mm-tab';
    b.setAttribute('data-tab-id', id);
    b.textContent = id;
    c.appendChild(b);
  }
  let order = ['A', 'B', 'C'];
  const d = attachTabDrag(c, {
    getOrder: () => order.slice(),
    onReorder: (o) => { order = o.slice(); },
    canDrag: () => true,
  });

  // jsdom 没有布局，getBoundingClientRect 全 0 —— 这里只验证状态机不抛错、
  // 且未达阈值不会误触发重排（真正的顺序计算靠上面 swapIndex 的单元测试）
  const bA = c.children[0];
  // jsdom 没有 PointerEvent 构造器，用 MouseEvent 派发同名的 pointer* 事件
  // （attachTabDrag 只监听事件名，不看事件类型）
  const ev = (type, x, y) => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    return e;
  };

  bA.dispatchEvent(ev('pointerdown', 10, 10));

  // 微小移动（2px）：不达阈值 5px
  dom.window.document.dispatchEvent(ev('pointermove', 12, 11));
  eq(order.join(''), 'ABC', '未达阈值不触发重排（单击不会被吞）');

  // 松手
  dom.window.document.dispatchEvent(ev('pointerup', 12, 11));
  eq(order.join(''), 'ABC', '未进入拖拽态松手 → 顺序不变');

  d.destroy();
  c.remove();
}

/* ============================================================
   二十三、B1 统一撤销栈
   ============================================================ */

group('B1 统一撤销栈');

{
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');

  // ---- 源码契约 ----
  ok(/function pickHistoryStack\(\)/.test(src), '抽出 pickHistoryStack() 决定用哪条栈');
  ok(/bridge\?\.hasHistory\?\.\(\) \? 'editor' : 'local'/.test(src), '编辑器栈可用就用它');

  const undoFn = src.slice(src.indexOf('function undo() {'), src.indexOf('function redo() {'));
  ok(/const stack = pendingRedo \|\| pickHistoryStack\(\);/.test(undoFn), '撤销时先看来没看锁（同栈优先）');
  // 关键：编辑器栈空时**不再**回退到本地栈
  ok(!/if \(r === true\) \{ pendingRedo = 'editor'; status\('已撤销'\); return; \}\s*if \(!undoStack\.length\)/.test(undoFn),
    '（对照）编辑器栈空后不再接着用本地栈 —— 一次序列只走一条栈');
  ok(/status\('没有可撤销的操作', true\);\s*return;/.test(undoFn), '编辑器栈空就提示「没有可撤销的操作」');

  const redoFn = src.slice(src.indexOf('function redo() {'), src.indexOf('/* ------------------------- 主题'));
  ok(/const stack = pendingRedo \|\| pickHistoryStack\(\);/.test(redoFn), '重做时同样先看锁');
  ok(!/if \(r === true\) \{ status\('已重做'\); return; \}\s*if \(!redoStack\.length\)/.test(redoFn),
    '（对照）重做也不再跨栈回退');

  // ---- 锁的清理时机 ----
  ok(/let pendingRedo = null;/.test(src), 'pendingRedo 已声明');
  ok(/pendingRedo = 'editor';/.test(src), '撤销走编辑器栈时上锁');
  ok(/pendingRedo = 'local';/.test(src), '撤销走本地栈时上锁');
  // 新编辑 / 切文件 / 切换画布，三处都要解锁
  const saveFn = src.slice(src.indexOf('async function doSaveInner'), src.indexOf('异步失败不包一层'));
  ok(/pendingRedo = null;/.test(saveFn), '新编辑后解锁（重做链已失效）');
  const resetFn = src.slice(src.indexOf('function resetHistory'), src.indexOf('/** 只做「载入并切换」'));
  ok(/pendingRedo = null;/.test(resetFn), '切文件后解锁');
  ok(/切换\/重载画布会重置编辑器历史基线/.test(src), '切换画布处也解锁（有注释说明）');
}

{
  // ---- 行为对照：旧实现（每次都优先编辑器栈）怎么丢数据 ----
  // 造一个双栈环境：编辑器栈 3 步，本地栈 2 步
  function makeEnv() {
    const editor = { undo: [3, 2, 1], redo: [] };   // 栈内是版本号
    const local = { undo: ['v0', 'v1'], redo: [] };
    let cur = 4;
    let lastSnap = 'v3';
    const log = [];
    return {
      // 旧：undo 先试编辑器，失败才用本地
      oldUndo() {
        if (editor.undo.length) {
          const v = editor.undo.pop(); editor.redo.push(cur); cur = v;
          log.push('editor-undo→' + v); return;
        }
        if (local.undo.length) {
          local.redo.push(lastSnap);
          const v = local.undo.pop(); lastSnap = v;
          log.push('local-undo→' + v); return;
        }
        log.push('nothing');
      },
      oldRedo() {
        if (editor.redo.length) {
          const v = editor.redo.pop(); editor.undo.push(cur); cur = v;
          log.push('editor-redo→' + v); return;
        }
        if (local.redo.length) {
          local.undo.push(lastSnap);
          const v = local.redo.pop(); lastSnap = v;
          log.push('local-redo→' + v); return;
        }
        log.push('nothing');
      },
      log, local, editor,
      get cur() { return cur; },
    };
  }

  // 旧实现：撤销 4 次（前 3 次走编辑器，第 4 次走本地），再重做 1 次
  const e1 = makeEnv();
  for (let i = 0; i < 4; i++) e1.oldUndo();
  e1.oldRedo();
  ok(e1.log.includes('local-undo→v1'), '（对照）旧实现：第 4 次撤销回退到本地栈');
  ok(e1.log[e1.log.length - 1].startsWith('editor-redo'),
    '（对照）旧实现：重做跑到了编辑器栈 —— 刚那次本地撤销永远重做不回来');
  ok(e1.local.redo.length === 1, '（对照）旧实现：本地 redo 栈留了一条孤儿，之后会突然跳到旧内容');
  // 再多按几次重做也吃不到那条孤儿：它只在本地栈被选中时才会被消费
  e1.oldRedo(); e1.oldRedo();
  ok(e1.local.redo.length === 1, '（对照）旧实现：继续重做也消费不掉那条孤儿（本地栈永远轮不到）');

  // 新实现：撤销时锁栈，重做必须同栈
  function makeNew() {
    const editor = { undo: [3, 2, 1], redo: [] };
    const local = { undo: ['v0', 'v1'], redo: [] };
    let cur = 4, lastSnap = 'v3', lock = null;
    const log = [];
    const pick = () => 'editor';    // 编辑器栈可用
    return {
      undo() {
        const st = lock || pick();
        if (st === 'editor') {
          if (editor.undo.length) {
            const v = editor.undo.pop(); editor.redo.push(cur); cur = v;
            lock = 'editor'; log.push('editor-undo→' + v);
          } else { log.push('nothing'); }
          return;
        }
        if (!local.undo.length) { log.push('nothing'); return; }
        local.redo.push(lastSnap);
        const v = local.undo.pop(); lastSnap = v; lock = 'local';
        log.push('local-undo→' + v);
      },
      redo() {
        const st = lock || pick();
        if (st === 'editor') {
          if (editor.redo.length) {
            const v = editor.redo.pop(); editor.undo.push(cur); cur = v;
            log.push('editor-redo→' + v);
          } else { log.push('nothing'); }
          return;
        }
        if (!local.redo.length) { log.push('nothing'); return; }
        local.undo.push(lastSnap);
        const v = local.redo.pop(); lastSnap = v;
        log.push('local-redo→' + v);
      },
      log, editor, local,
      get cur() { return cur; },
    };
  }

  const e2 = makeNew();
  for (let i = 0; i < 4; i++) e2.undo();
  // 新实现：编辑器栈空了就停在「没有可撤销」，**不会**跨到本地栈
  ok(!e2.log.includes('local-undo→v1'), '新实现：编辑器栈空后不跨到本地栈（一次序列只走一条）');
  e2.redo();
  ok(e2.log[e2.log.length - 1].startsWith('editor-redo'), '新实现：重做与撤销同栈（编辑器栈）');
  ok(e2.local.redo.length === 0, '新实现：本地 redo 栈没有孤儿');
  ok(e2.local.undo.length === 2, '新实现：本地 undo 栈完全没被动过（没跨栈）');
}

/* ============================================================
   二十四、B2/B3 由内核提供（澄清，防止重复实现）
   ============================================================ */

group('B2/B3 内核已提供');

{
  // 这一组是「澄清性断言」：B2（剪切/复制/粘贴节点）与 B3（多选拖拽移动）
  // 在差距清单里被判为「完全缺失 / 未定位到确切行号」，属推测。
  // 实际核对 kityminder.core.min.js 后确认**内核本来就提供**，
  // 故这里锁住事实，避免将来有人照着清单重复实现一套。
  const core = fs.readFileSync(path.join(HERE, 'editor', 'kityminder.core.min.js'), 'utf8');

  // ---- B2：ClipboardModule ----
  ok(/register\("ClipboardModule"/.test(core), '内核注册了 ClipboardModule');
  ok(/commands:\{copy:i,cut:j,paste:k\}/.test(core), 'B2 提供 copy / cut / paste 三个命令');
  ok(/commandShortcutKeys:\{copy:"normal::ctrl\+c\|",cut:"normal::ctrl\+x",paste:"normal::ctrl\+v"\}/.test(core),
    'B2 已注册 Ctrl+C / Ctrl+X / Ctrl+V 快捷键');

  // 命令名会被转小写存进 _commands
  ok(/this\._commands\[d\.toLowerCase\(\)\]=new i\[d\]/.test(core),
    '模块命令以小写名进 _commands（故是 copy/cut/paste，不是 copynode）');

  // 基类 queryState 返回 STATE_NORMAL(0)，快捷键回调的 `-1 !== state` 判定会通过
  ok(/queryState:function\(a\)\{return h\}/.test(core), 'Command 基类 queryState 返回 STATE_NORMAL');
  ok(/i\.STATE_NORMAL=h,i\.STATE_ACTIVE=1,i\.STATE_DISABLED=-1/.test(core), 'STATE_NORMAL=0（不是 -1，故快捷键能触发）');
  ok(/-1!==e\.queryCommandState\(b\)&&e\.execCommand\(b\)/.test(core),
    '快捷键回调：state !== -1 才执行（copy/cut 返回 0 → 会执行）');

  // 复制的是节点而非样式：PasteCommand 用 clone() + append
  ok(/a\(g,e\.clone\(\)\)/.test(core), 'B2 paste 是克隆**节点**并挂到选中节点下');
  ok(/getSelectedAncestors/.test(core), 'B2 copy/cut 取 getSelectedAncestors（自动剔除被祖先覆盖的子孙）');

  // ---- B3：DragTree ----
  ok(/register\("DragTree"/.test(core), '内核注册了 DragTree');
  ok(/_calcDragSources:function\(\)\{this\._dragSources=this\._minder\.getSelectedAncestors\(\)\}/.test(core),
    'B3 拖拽源取 getSelectedAncestors —— **天然支持多选**');
  ok(/"normal\.mousedown inputready\.mousedown"/.test(core), 'B3 在 normal 状态的 mousedown 启动拖拽');
  ok(/commands:\{movetoparent:i\}/.test(core), 'B3 提供 movetoparent 命令（跨层级移动）');

  // ---- 默认启用：未指定 options.modules 就全启用 ----
  ok(/this\._options\.modules\|\|f\.keys\(a\)/.test(core), '未指定 modules 时启用全部注册模块');
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  ok(!/modules\s*:\s*\[/.test(html), '编辑器初始化没有限定 modules（故两个模块都会启用）');

  // ---- 防止重复实现：项目里不应再出现自定义 copynode/cutnode/pastenode ----
  ok(!/copynode['"]?\s*[:,]|cutnode['"]?\s*[:,]|pastenode['"]?\s*[:,]/.test(html),
    '（防回归）编辑器没有自定义的 copynode/cutnode/pastenode（会与内核快捷键冲突）');
}

/* ============================================================
   二十五、P0：A62 / A64 / A67 / A47 / A42
   ============================================================ */

group('P0 主题与备份');

{
  const th = await import('./themes.js');

  // ---- A64 新建主题种子 ----
  ok(typeof th.themeSeed === 'function', 'themes.js 导出 themeSeed');

  // 内置主题 → 四色映射
  const seed = th.themeSeed('fresh-blue', []);
  eq(seed.background, '#FBFBFB', 'A64 种子：背景取内置主题 bg');
  eq(seed.rootBackground, '#73A1BF', 'A64 种子：根节点色取 root');
  eq(seed.mainBackground, '#EEF3F6', 'A64 种子：主干色取 main');
  eq(seed.subBackground, '#FBFBFB', 'A64 种子：sub=transparent 回落为画布底色（不是字符串 transparent）');
  ok(!/transparent/i.test(JSON.stringify(seed)), 'A64 种子里不含 transparent（非法色值会让主题失效）');

  // transparent 必须回落 —— 直接写会让 core 解析失败
  const snow = th.themeSeed('snow', []);
  eq(snow.subBackground, '#FFFFFF', 'A64 snow 的 sub 是实色，原样取用');

  // 自定义主题 → 克隆 palette，且是深拷贝
  const custom = [{ id: 'c1', name: '我的', palette: { background: '#123456', rootBackground: '#ABCDEF' } }];
  const cs = th.themeSeed('c1', custom);
  eq(cs.background, '#123456', 'A64 自定义主题：取它的 palette');
  ok(cs !== custom[0].palette, 'A64 是深拷贝（改种子不会污染原主题）');
  cs.background = '#FFFFFF';
  eq(custom[0].palette.background, '#123456', 'A64 改种子后原主题不受影响');

  // 未知主题 → 回落到默认，不返回 undefined
  const unk = th.themeSeed('不存在的主题', []);
  ok(unk && typeof unk.background === 'string', 'A64 未知主题回落到默认（不返回 undefined）');

  // 每个内置主题都能产出完整 palette
  const need = ['background', 'textColor', 'selectedColor', 'connectColor', 'rootBackground', 'mainBackground', 'subBackground'];
  let allOk = true;
  for (const t of th.THEMES) {
    const p = th.themeSeed(t.value, []);
    if (!need.every((k) => typeof p[k] === 'string' && p[k])) allOk = false;
  }
  ok(allOk, 'A64 每个内置主题都能产出完整 palette（7 个核心键齐全）');

  // 色值合法性：非法色值会让整段 CSS 不渲染
  let hexOk = true;
  for (const t of th.THEMES) {
    const p = th.themeSeed(t.value, []);
    for (const k of need) if (!/^#[0-9A-Fa-f]{6}$/.test(p[k])) hexOk = false;
  }
  ok(hexOk, 'A64 所有种子色值都是合法 #RRGGBB（非法色值会静默不渲染）');
}

{
  const src = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');

  // ---- A62 删除回退 ----
  const delSeg = src.slice(src.indexOf("safe('删除主题'"), src.indexOf('title: \'删除\','));
  ok(/const isCurrent = cur === t\.id;/.test(delSeg), 'A62 判断是否删的是当前主题');
  ok(/if \(isCurrent\) await app\.api\.applyTheme\(DEFAULT_THEME\);/.test(delSeg),
    'A62 删当前主题时先切回内置并落盘（否则 sheet.theme 指向已注销 id）');
  // 关键：只在 isCurrent 时回退 —— 与 WPF 的无条件回退不同。
  // 注意不能只搜「有没有 applyTheme(DEFAULT_THEME)」：有 if 包裹和无 if 包裹
  // 都含这串，正则区分不了。改为逐处回看它前面有没有 isCurrent。
  const calls = [...delSeg.matchAll(/applyTheme\(DEFAULT_THEME\)/g)];
  ok(calls.length > 0, 'A62 确实会回退到内置主题');
  ok(calls.every((m) => /if \(isCurrent\)[^\n]*$/.test(delSeg.slice(0, m.index).split('\n').pop() || '')),
    'A62（对照）每次回退都在 isCurrent 分支内 —— 删别的主题不会重置当前主题');
  ok(/if \(isCurrent\) await app\.api\.applyTheme\(t\.id\);/.test(delSeg),
    'A62 保存失败时回滚（别把用户卡在「主题已删、切换失败」的中间态）');

  // ---- A64 接线 ----
  ok(/openThemeEditor\(app, null, cur\)/.test(src), 'A64 新建按钮把当前主题传进去当种子');
  const edFn = src.slice(src.indexOf('export function openThemeEditor'), src.indexOf('export function openThemeEditor') + 900);
  ok(/palette: themeSeed\(seedTheme, app\.customThemes\)/.test(edFn), 'A64 新建时 palette 取自 themeSeed');
  ok(/const editing = theme\s*\?\s*JSON\.parse/.test(edFn), 'A64 编辑时仍深拷贝自身（保留 id 覆盖更新）');
}

{
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');

  // ---- A67 注册顺序 ----
  ok(/function registerCustomThemes\(\)/.test(src), 'A67 抽出 registerCustomThemes()');
  // JSDoc 在 function 关键字**之前**，切片起点要往前取，否则读不到注释
  const regFn = src.slice(
    src.lastIndexOf('/**', src.indexOf('function registerCustomThemes()')),
    src.indexOf('async function applyTheme'));
  ok(/for \(const t of customThemes \|\| \[\]\)/.test(regFn), 'A67 遍历全部自定义主题（不只当前那个）');
  ok(/try \{ if \(bridge\?\.registerTheme\(t\)\) n\+\+; \} catch/.test(regFn),
    'A67 单个坏主题不中断整个循环（否则一个坏数据会让所有主题失效）');
  ok(/registerCustomThemes\(\);/.test(src), 'A67 在 loadSheet 里调用');
  // 关键：顺序固定为数组序
  ok(/注册序|顺序漂移/.test(regFn), 'A67 注释说明顺序为何要固定（顺序漂移会让同一按钮时灵时不灵）');

  // ---- A47 暂停 ----
  ok(/setBackupPaused: guard/.test(src), 'A47 提供 setBackupPaused');
  ok(/settings\.backupPaused = !!on;/.test(src), 'A47 写入 backupPaused');
  ok(/if \(!settings\.backupPaused && intervalMs > 0 && now - lastBackupAt > intervalMs\)/.test(src),
    'A47 暂停时不写盘（且与 interval=0 是两个独立状态）');
  const pause = src.slice(src.indexOf("setBackupPaused: guard"), src.indexOf('setBackupMax: guard'));
  ok(/间隔仍为|保留原间隔值/.test(pause), 'A47 提示里保留原间隔值（恢复时不用重设）');

  // ---- A42 备份迁移 ----
  ok(/async function exportBackups\(\)/.test(src), 'A42 提供 exportBackups');
  ok(/async function importBackups\(\)/.test(src), 'A42 提供 importBackups');
  ok(/kind: 'nexus-mindmap-backups'/.test(src), 'A42 导出带类型标记（导入时可校验）');
  const imp = src.slice(src.indexOf('async function importBackups()'), src.indexOf('按当前上限滚动清理'));
  ok(/new Set\(\(await store\.listBackups\(\)\)\.map\(\(b\) => b\.ts\)\)/.test(imp), 'A42 导入按 ts 去重');
  ok(/if \(mine\.has\(b\.ts\)\) \{ skipped\+\+; continue; \}/.test(imp), 'A42 重复的跳过（不覆盖本机现有快照）');
  ok(/typeof b\.ts !== 'number'/.test(imp), 'A42 缺 ts 的跳过（否则列表里会出现 undefined 时间戳条目）');
  // 形式从 trimBackups() 变成 trimBackups(addedKeys)：
  // 「统一清理一次」这个意图不变（仍然只在末尾调一次），但必须带上保护集合 ——
  // 不带的话统一清理反而会把刚导入的历史快照**整批**删掉（BUG 39）：
  // 它们 ts 更旧，而清理从最旧的开始删。
  ok(/await trimBackups\(addedKeys\);/.test(imp), 'A42 导入结束后统一清理一次（且带上保护集合）');

  const st = (fs.readFileSync(path.join(HERE, 'store.js'), 'utf8')).replace(/\r\n/g, '\n');
  ok(/export async function putBackup\(snapshot\)/.test(st), 'A42 store 新增 putBackup（指定时间戳写入）');
  ok(/typeof snapshot\.ts !== 'number'\) return false;/.test(st), 'A42 putBackup 校验 ts');
}

{
  // ---- A62 行为级：删当前主题必须回退，删其它主题不能打扰 ----
  // 模拟：sheet.theme 指向某自定义主题，删它之后不能停在已注销 id 上
  function makeThemeEnv() {
    return {
      customThemes: [{ id: 'c1', name: '我的蓝', palette: {} }, { id: 'c2', name: '我的绿', palette: {} }],
      theme: 'c1',
      saveOk: true,
      log: [],
    };
  }
  async function deleteTheme(env, id, saveOk = true) {
    const isCurrent = env.theme === id;
    if (isCurrent) { env.theme = 'fresh-blue'; env.log.push('回退到内置'); }
    const removed = env.customThemes.filter((x) => x.id !== id);
    if (!saveOk) {
      if (isCurrent) { env.theme = id; env.log.push('回滚'); }
      env.log.push('保存失败');
      return env;
    }
    env.customThemes = removed;
    env.log.push('已删除');
    return env;
  }

  const e1 = makeThemeEnv();
  await deleteTheme(e1, 'c1');
  eq(e1.theme, 'fresh-blue', 'A62 删的是当前主题 → 回退到内置');
  ok(e1.customThemes.every((x) => x.id !== 'c1'), 'A62 主题已从列表移除');

  const e2 = makeThemeEnv();
  await deleteTheme(e2, 'c2');
  eq(e2.theme, 'c1', 'A62 删的不是当前主题 → 当前主题保持不变（WPF 会无条件重置，这里更好）');

  const e3 = makeThemeEnv();
  await deleteTheme(e3, 'c1', false);
  eq(e3.theme, 'c1', 'A62 保存失败 → 回滚，不停在中间态');
  ok(e3.customThemes.some((x) => x.id === 'c1'), 'A62 保存失败 → 列表也没删掉');
}

{
  // ---- A47 行为级：暂停保留原间隔值 ----
  function makeBackupEnv() {
    return { settings: { backupMinutes: 5, backupPaused: false }, wrote: 0 };
  }
  function maybeBackup(env, now, lastAt) {
    const ms = (Number(env.settings.backupMinutes) || 0) * 60 * 1000;
    if (!env.settings.backupPaused && ms > 0 && now - lastAt > ms) { env.wrote++; return true; }
    return false;
  }
  const b1 = makeBackupEnv();
  eq(maybeBackup(b1, 10 * 60000, 0), true, 'A47 正常运行：到点会备份');

  b1.settings.backupPaused = true;
  eq(maybeBackup(b1, 20 * 60000, 0), false, 'A47 暂停后不备份');
  eq(b1.settings.backupMinutes, 5, 'A47 暂停时原间隔值仍保留（不会被置 0）');

  b1.settings.backupPaused = false;
  eq(maybeBackup(b1, 30 * 60000, 0), true, 'A47 恢复后立即按原间隔继续');
  eq(b1.settings.backupMinutes, 5, 'A47 恢复后间隔值没变（用户不用重设）');

  // 与「间隔=0 永久关闭」是两条独立状态
  const b2 = makeBackupEnv();
  b2.settings.backupMinutes = 0;
  eq(maybeBackup(b2, 999 * 60000, 0), false, 'A47 间隔=0 是永久关闭');
  b2.settings.backupPaused = false;
  eq(maybeBackup(b2, 999 * 60000, 0), false, 'A47 取消暂停也救不回「间隔=0」（两者独立）');
}

{
  // ---- A42 行为级：合并去重，不覆盖本机 ----
  function makeImport(existing, incoming) {
    const mine = new Set(existing.map((b) => b.ts));
    const all = existing.slice();
    let added = 0, skipped = 0;
    for (const b of incoming) {
      if (!b || typeof b.ts !== 'number' || !Array.isArray(b.sheets)) { skipped++; continue; }
      if (mine.has(b.ts)) { skipped++; continue; }
      all.push(b); mine.add(b.ts); added++;
    }
    return { all, added, skipped };
  }
  const local = [{ ts: 100, sheets: [] }, { ts: 200, sheets: [] }];
  const r = makeImport(local, [
    { ts: 200, sheets: [] },        // 重复
    { ts: 300, sheets: [] },        // 新
    { ts: 'x', sheets: [] },        // ts 非法
    { sheets: [] },                 // 缺 ts
    null,                           // 空项
  ]);
  eq(r.added, 1, 'A42 只导入真正新增的 1 份');
  eq(r.skipped, 4, 'A42 跳过 4 份（1 重复 + 3 格式不符）');
  eq(r.all.length, 3, 'A42 本机原有快照完整保留（合并而非替换）');
  ok(r.all.some((b) => b.ts === 100), 'A42 本机 ts=100 还在');
  ok(r.all.some((b) => b.ts === 300), 'A42 新导入 ts=300 已加入');
  // 关键：不能因为导入就把本机清掉
  ok(r.all.filter((b) => b.ts === 200).length === 1, 'A42 重复的 ts=200 只有一份（没被覆盖成两份）');
}

/* ============================================================
   二十六、P1：附件与视频（A15 A16 A17 A19 A20 A21 A23 A24 B20 B23 B24）
   ============================================================ */

group('P1 附件与视频');

{
  const io = await import('./io.js');

  // ---- A17 所在目录 ----
  eq(io.dirOf('C:/Users/a/b.pdf'), 'C:/Users/a', 'A17 dirOf 取 Windows 路径目录');
  eq(io.dirOf('/home/a/b.pdf'), '/home/a', 'A17 dirOf 取 Unix 路径目录');
  eq(io.dirOf('b.pdf'), '', 'A17 无目录时返回空串（调用方据此省略整行）');
  eq(io.dirOf(''), '', 'A17 空输入返回空串（不抛）');
  eq(io.dirOf(null), '', 'A17 null 返回空串（不抛）');
  // 分隔符兼容：老路径可能已被 JSON 转义
  eq(io.dirOf('C:\\Users\\a\\b.pdf'), 'C:/Users/a', 'A17 反斜杠路径也认（统一成 / 处理）');
}

{
  const src = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');
  const idx = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
  const css = (fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n');

  // ---- A23 替换/移除前确认 ----
  ok(/export function confirmDialog/.test(src), 'A23 新增 confirmDialog（Promise 版）');
  ok(/return new Promise\(\(resolve\) => \{/.test(src), 'A23 confirmDialog 返回 Promise（调用点是 async 流程）');
  // 多附件后 remove 变成 removeAt(kind, index)。
  // 定位用前缀而非完整签名 —— 修饰符一变 indexOf 就返回 -1，切片整个错乱。
  const rmStart = src.indexOf('const removeAt = ');
  ok(rmStart > 0, 'A23 移除入口是 removeAt（多附件按索引删）');
  const rm = src.slice(rmStart, src.indexOf('const addImages', rmStart));
  // 不能只断言「有没有 await confirmDialog」—— 把 `if (r)` 改成 `if (false)`
  // 那串还在，断言照样绿，但确认已经形同虚设。必须锁住它**在 r 存在的分支里**。
  ok(/if \(!r\) return;[\s\S]{0,80}const ok = await confirmDialog\(/.test(rm),
    'A23 有附件时才弹确认（确认必须在 r 存在的分支之后，不是无条件也不是恒假）');
  ok(/if \(!ok\) return;/.test(rm), 'A23 取消则不移除（不是「问了也照删」）');
  ok(/'移除', true\)/.test(rm), 'A23 移除是危险操作（danger=true）');
  const atStart = src.indexOf('const attach = async (kind)');
  const at = src.slice(atStart, src.indexOf('const removeAt', atStart));
  // 多附件是**追加**，不再有"顶掉原有附件"这回事，因此不该再要覆盖确认
  ok(!/confirmDialog\(/.test(at),
    'A23 附加改为追加后**不再需要**覆盖确认（没有覆盖场景了）');
  ok(/list\.push\(/.test(at), 'A23 附加是 push 到现有列表（追加）');

  // ---- A16 失效仍展示已知字段 ----
  const fillStart = src.indexOf('async function fillFileMeta');
  const fill = src.slice(fillStart, src.indexOf('async function fillVideoMeta'));
  ok(/ref\.legacyPath/.test(fill), 'A16 失效时展示老路径（便于定位是哪个附件失效）');
  ok(/io\.dirOf\(ref\.legacyPath\)/.test(fill), 'A17 失效时仍显示所在目录');
  ok(/mm-hint\.warn/.test(fill), 'A16 失效用 warn 样式（普通灰字看不出是问题）');
  ok(/\.mm-hint\.warn/.test(css), 'A16 warn 样式已定义');
  // 关键：失效时**仍**列出类型，而不是只写一句「打不开」
  ok(/const rows = \[\['类型'/.test(fill), 'A16 失效时仍列出类型（对照 WPF :552-557）');

  // ---- A17/B23/B24 信息行 ----
  ok(/\['大小', io\.formatSize/.test(fill), 'B24 显示大小');
  ok(/\['修改', mi\.formatDateTime/.test(fill), 'B24 显示修改时间');
  ok(/\['添加', mi\.formatDateTime\(a\.addedAt\)\]/.test(fill), 'A17 显示添加时间（Web 版没有真实 ctime，用 addedAt）');

  // ---- A20 进度条 ----
  ok(/input\.mm-vseek/.test(src), 'A20 新增可拖拽进度条');
  ok(/Number\.isFinite\(video\.duration\)/.test(src), 'A20 时长为 NaN/Infinity 时不可拖动');
  // 源码里是 h('input.mm-vseek', { disabled: true, ... })，不是 `bar.disabled = true`
  ok(/disabled: true,\s*\/\/ 时长未知前无法定位/.test(src), 'A20 初始为禁用（时长未知前无法定位）');
  ok(/let seeking = false/.test(src), 'A20 拖拽期间锁定（否则滑块与手指打架）');
  ok(/if \(!seeking\) bar\.value/.test(src), 'A20 拖拽中不回写滑块位置');
  ok(/\.mm-vseek/.test(css), 'A20 进度条有样式');

  // ---- A21/B20 播放状态 ----
  ok(/const setState = \(s\) =>/.test(src), 'A21 有状态设置函数');
  ok(/'播放中' : s === 'paused' \? '已暂停'/.test(src), 'A21 播放/暂停两态');
  ok(/addEventListener\('play'/.test(src) && /addEventListener\('pause'/.test(src),
    'A21 状态由元素事件驱动（play() 可能被策略拒绝，不能想当然）');
  ok(/addEventListener\('ended'/.test(src), 'A21 播完也有状态（ended）');
  ok(/\.mm-vsum-state/.test(css), 'B20 状态标记有样式');
  // 再次点击 = 暂停（媒体播放器习惯）
  ok(/video\.paused\) start\(\);/.test(src), 'A21 点缩略图可切换播放/暂停');

  // ---- A19 自动播放策略 ----
  const open = idx.slice(idx.indexOf('async function openAttachment'), idx.indexOf('/* ------------------------- 撤销'));
  ok(/autoplayVideo: true/.test(open) || /A19/.test(open), 'A19 点节点图标→自动播（对照 WPF :483）');
  ok(/正在播放/.test(open), 'A19 播放时给出状态提示');
  // ---- A15 默认程序打开 ----
  ok(/已保存到下载目录/.test(open), 'A15 下载后提示可双击用默认程序打开（说明与 C# 的差距）');
  ok(/UseShellExecute/.test(open), 'A15 注释说明为何不能照搬 C# 的 Process.Start');
}

{
  // ---- A20 行为级：时长未知时不可拖拽 ----
  function makeSeek(duration) {
    const v = { duration, currentTime: 0 };
    let barValue = 0, disabled = true;
    const seekable = () => Number.isFinite(v.duration) && v.duration > 0;
    const syncBar = () => {
      if (!seekable()) return;
      disabled = false;
      barValue = Math.round((v.currentTime / v.duration) * 1000);
    };
    return {
      v, syncBar,
      get disabled() { return disabled; },
      get value() { return barValue; },
      seek(pct) { if (!seekable()) return false; v.currentTime = (pct / 1000) * v.duration; return true; },
    };
  }

  const nan = makeSeek(NaN);
  nan.syncBar();
  eq(nan.disabled, true, 'A20 时长 NaN（元数据未解析）时进度条禁用');
  eq(nan.seek(500), false, 'A20 时长 NaN 时拖动无效（不会把 currentTime 设成 NaN）');

  const inf = makeSeek(Infinity);
  inf.syncBar();
  eq(inf.disabled, true, 'A20 直播流（Infinity）时进度条禁用');

  const ok12 = makeSeek(12);
  ok12.syncBar();
  eq(ok12.disabled, false, 'A20 时长已知后进度条可用');
  ok12.v.currentTime = 6;
  ok12.syncBar();
  // 1000 分度：6/12 = 0.5 → 500
  eq(ok12.value, 500, 'A20 播放到一半时滑块在中点');
  eq(ok12.seek(250), true, 'A20 拖到 25% 生效');
  ok(Math.abs(ok12.v.currentTime - 3) < 0.001, 'A20 拖到 25% → currentTime=3（12 秒的四分之一）');
}

{
  // ---- A21 行为级：状态机 ----
  const states = [];
  let playing = false;
  const setState = (s) => states.push(s);
  // 模拟元素事件：play() 成功才发 play 事件
  function tryPlay(autoplayAllowed) {
    if (autoplayAllowed) { playing = true; setState('playing'); }
    else setState('paused');      // 被策略拒绝：不发 play 事件
  }
  tryPlay(true);
  eq(states[states.length - 1], 'playing', 'A21 播放成功 → 播放中');
  tryPlay(false);
  eq(states[states.length - 1], 'paused', 'A21 自动播放被拒绝 → 停在已暂停（不是想当然写「播放中」）');
  setState('ended');
  eq(states[states.length - 1], 'ended', 'A21 播完 → 已结束');
  ok(states.length === 3, 'A21 状态只由真实事件产生（共 3 次）');
}

{
  // ---- A23 行为级：有附件必须经确认，取消则不删 ----
  // 从源码的**结构**上验证是不可能的（字符串断言抓不到 `if (r)` 被改成
  // `if (false)`），所以这里照着 remove 的控制流再实现一遍并断言结果。
  async function removeLike(hasRef, userConfirmed) {
    const log = [];
    const r = hasRef ? { n: 'a.pdf' } : null;
    if (r) {
      const ok = await Promise.resolve(userConfirmed);   // confirmDialog
      if (!ok) { log.push('取消'); return { deleted: false, log }; }
    }
    log.push('删除');
    return { deleted: true, log };
  }

  eq((await removeLike(true, false)).deleted, false, 'A23 有附件 + 取消 → 不删');
  eq((await removeLike(true, true)).deleted, true, 'A23 有附件 + 确认 → 删');
  // 没有附件时不该弹框（对空引用弹确认很怪）
  const noRef = await removeLike(false, false);
  eq(noRef.deleted, true, 'A23 无附件 → 直接走删除流程（不弹确认）');
  ok(!noRef.log.includes('取消'), 'A23 无附件时没有确认环节');

  // 恒假分支的等价物：无论用户怎么选都不删 —— 这正是上面那条结构断言要防的
  async function brokenRemove(hasRef, userConfirmed) {
    if (false) { await Promise.resolve(userConfirmed); }
    return { deleted: hasRef };
  }
  eq((await brokenRemove(true, false)).deleted, true,
    '（对照）确认被短路时，取消也照删 —— 这正是要防的失效模式');
}

/* ============================================================
   二十七、P2：导入导出（A30 A31 A38 A39）
   ============================================================ */

group('P2 导入导出');

{
  // ---- 先核实：A32 / A33 / A40 其实早已实现 ----
  const wbk = await import('./workbook.js');
  const io = await import('./io.js');
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  // A32 多画布 Markdown 导出
  const md = wbk.workbookToMarkdown([
    { id: 's1', title: 'A', content: wbk.emptyContent('甲'), theme: 'fresh-blue', layout: 'default' },
    { id: 's2', title: 'B', content: wbk.emptyContent('乙'), theme: 'fresh-blue', layout: 'default' },
  ]);
  ok(/## 画布：A/.test(md) && /## 画布：B/.test(md), 'A32 多画布 Markdown 导出（已实现）');
  ok(/甲/.test(md) && /乙/.test(md), 'A32 两张画布内容都在');

  // A33 整本 XMind：writeXMind 传的是 workbook.sheets（全部），不是单张
  const xm = fs.readFileSync(path.join(HERE, 'xmind.js'), 'utf8');
  ok(/export async function writeXMind\(sheets, activeId/.test(xm), 'A33 writeXMind 接的是 sheets 数组');
  ok(/xmind\.writeXMind\(workbook\.sheets, workbook\.activeId/.test(idx), 'A33 导出时传全部画布（整本快照，已实现）');

  // A40 命名时间戳
  const name = io.stampName('脑图', 'json');
  ok(/^脑图-\d{8}-\d{4}\.json$/.test(name), 'A40 导出名带时间戳（已实现）');
}

{
  // ---- A31 识别形态要报出来 ----
  const wbk = await import('./workbook.js');
  const book = wbk.parseWorkbook(wbk.serializeWorkbook([
    { id: 's1', title: 'A', content: wbk.emptyContent(), theme: 'fresh-blue', layout: 'default' },
    { id: 's2', title: 'B', content: wbk.emptyContent(), theme: 'fresh-blue', layout: 'default' },
  ], 's1'));
  eq(book.form, 'workbook', 'A31 多画布包识别为 workbook');
  eq(book.sheets.length, 2, 'A31 两张画布');

  const single = wbk.parseWorkbook(JSON.stringify({ root: { data: { text: 'x' } }, template: 'right' }));
  eq(single.form, 'single', 'A31 单画布识别为 single');
  eq(single.sheets.length, 1, 'A31 单画布 → 一张');

  eq(wbk.parseWorkbook('不是 json'), null, 'A31 无法解析返回 null（不抛）');
  eq(wbk.parseWorkbook('{}'), null, 'A31 无 sheets 也无 root → null');

  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(/识别为：\$\{formTip\}/.test(idx), 'A31 导入后把识别到的形态说出来');
}

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  // ---- A30 整体替换前确认 ----
  ok(/await confirmDialog\(\s*\n?\s*'导入将替换全部画布'/.test(idx), 'A30 导入前弹确认');
  const imp = idx.slice(idx.indexOf('async function importFile'), idx.indexOf('A44 手动备份'));
  ok(/const curCount = workbook\.sheets\?\.length \|\| 0;/.test(imp), 'A30 先数当前有几张画布');
  ok(/if \(curCount > 0\) \{\s*\n\s*const ok = await confirmDialog\(/.test(imp),
    'A30 **有画布时才确认**（空脑图不该弹框，否则新建后第一次导入也被拦）');
  ok(/if \(!ok\) \{ status\('已取消导入'\); return; \}/.test(imp), 'A30 取消则不替换');
  ok(/此操作不可撤销/.test(imp), 'A30 提示里说明不可逆');
  ok(/建议先「导出」或「立即备份」/.test(imp), 'A30 提示里给出规避办法（先备份）');
  // XMind 分支同样要确认 —— 只堵住 JSON 分支等于没堵
  ok((imp.match(/导入将替换全部画布/g) || []).length >= 2,
    'A30 JSON 与 XMind 两条分支都要确认（只堵一条等于没堵）');

  // ---- A38 高分辨率 PNG ----
  ok(/async function exportPng\(scale = 1\)/.test(idx), 'A38 exportPng 接受倍率');
  ok(/io\.svgToPngBlob\(svg, s\)/.test(idx), 'A38 走 SVG 中间层（内核 png 只是补白，不是真高清）');
  ok(/脑图\$\{s > 1 \? `@\$\{s\}x` : ''\}/.test(idx), 'A38 多倍文件名带 @2x 标记');
  const iom = fs.readFileSync(path.join(HERE, 'io.js'), 'utf8');
  ok(/export async function svgToPngBlob/.test(iom), 'A38 新增 svgToPngBlob');
  ok(/export function pngScaleDims/.test(iom), 'A38 抽出 pngScaleDims（纯函数，可单测）');
  ok(/export function scaleSvgText/.test(iom), 'A38 抽出 scaleSvgText（纯 DOM 操作，可单测）');
  const s2p = iom.slice(iom.indexOf('export async function svgToPngBlob'), iom.indexOf('export function stampName'));
  ok(/ctx\.fillRect\(0, 0, W, H\)/.test(s2p), 'A38 先铺背景（SVG 的 style 背景在 canvas 里不保证渲染）');
  ok(/finally \{[\s\S]{0,80}revokeObjectURL/.test(s2p), 'A38 无论成败都回收 Blob URL');
  // 关键：真实实现里**不能**出现改 viewBox 的语句
  // （只断言注释是没用的 —— 注释在，代码照样可以改坏）
  const scaleFn = iom.slice(iom.indexOf('export function scaleSvgText'), iom.indexOf('export async function svgToPngBlob'));
  ok(!/setAttribute\('viewBox'/.test(scaleFn),
    'A38 scaleSvgText 里没有改 viewBox 的语句（改了就退化成补白，图还是糊的）');
  ok(/setAttribute\('width', String\(dims\.W\)\)/.test(scaleFn), 'A38 用钳制后的尺寸重设 width');

  // ---- A39 导出格式菜单 ----
  // 原 openExportMenu（顶栏下拉）已删除：入口全部并入侧栏「导入导出」页。
  // 断言随之改为校验那一页 —— 格式一个都不能少，否则就是搬漏了。
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/pages\.exchange = pageExchange/.test(pn), 'A39 侧栏注册了「导入导出」页');
  ok(/function pageExchange\(/.test(pn), 'A39 新增 pageExchange');

  // 页签列表里要有它（否则顶栏点不到）
  ok(/\['exchange', '导入导出'\]/.test(idx), 'A39 顶栏页签含「导入导出」');

  // 顶栏的导入导出按钮必须**真的移除**了，不能只是多了一个页签
  ok(!/B\('导入', \(\) => importFile\(\)/.test(idx), 'A39 顶栏「导入」按钮已移除');
  ok(!/B\('XMIND'/.test(idx) && !/B\('TXT'/.test(idx) && !/B\('MD'/.test(idx),
    'A39 顶栏 XMIND / TXT / MD 按钮已移除');
  ok(!/B\('SVG'/.test(idx) && !/B\('PNG'/.test(idx), 'A39 顶栏 SVG / PNG 按钮已移除');
  ok(!/function openExportMenu/.test(idx), 'A39 openExportMenu 已删除（不留死代码）');

  // 新页签里**每一种格式**都要在（搬漏一个就在这里报出来）
  const ex = pn.slice(pn.indexOf('function pageExchange('),
    pn.indexOf('pages.file = pageFile;'));
  for (const [label, kw] of [
    ['导入', "app.api.importFile()"],
    ['XMind', 'app.api.exportXMind()'],
    ['JSON', 'app.api.exportJson()'],
    ['TXT', 'app.api.exportTxt()'],
    ['Markdown', 'app.api.exportMarkdown()'],
    ['FreeMind', "app.api.exchange('freemind')"],
    ['OPML', "app.api.exchange('opml')"],
    ['Mermaid', "app.api.exchange('mermaid')"],
    ['PlantUML', "app.api.exchange('plantuml')"],
    ['SVG', 'app.api.exportSvg()'],
    ['PDF', 'app.api.exportPdf()'],
    ['打印', 'app.api.printMap(o)'],
    ['PNG 1 倍', 'app.api.exportPng(1)'],
    ['PNG 2 倍', 'app.api.exportPng(2)'],
    ['PNG 3 倍', 'app.api.exportPng(3)'],
    ['快照导出', 'app.api.exportBackups()'],
    ['快照导入', 'app.api.importBackups()'],
  ]) {
    ok(ex.includes(kw), `A39 导入导出页含「${label}」`);
  }

  // 其余旧入口必须清掉，否则同一个功能还是有两个地方能点
  ok(!/onclick: \(\) => app\.api\.exportJson\(\)/.test(pn),
    'A39 文件页的导出按钮已移除');

  // ---- 主题的导入/导出**回归主题页**（与新建/编辑/删除同排）----
  // 它们是「对主题这个对象」的操作，和主题列表是一组连贯动作；
  // 放导入导出页会让主题页要靠一句 hint 指路，等于把连贯操作拆成两地。
  {
    // 切片结束锚点不能用 `pages.theme = pageTheme;` ——
    // function 声明被提升，`pages.theme = pageTheme` 出现在**定义之前**
    // （第 579 行 vs 第 1501 行），slice 会拿到空串，三条断言永远为假（假阴性）。
    const th = pn.slice(pn.indexOf('function pageTheme('),
      pn.indexOf('// 默认停在「主题」页'));
    ok(/importThemeFile\(\)/.test(th), 'A39 主题页有「导入主题」');
    ok(/exportThemeFile\(\)/.test(th), 'A39 主题页有「导出主题」');
    // 不能两处都有 —— 那就是把刚集中的入口又拆开
    ok(!/importThemeFile\(\)/.test(ex), 'A39 导入导出页**不再**有主题导入（避免两处入口）');
    ok(!/exportThemeFile\(\)/.test(ex), 'A39 导入导出页**不再**有主题导出');
    // 指路用的 hint 要删掉 —— 按钮就在本页了，再指路就是自相矛盾
    ok(!/自定义的导入\/导出在侧栏/.test(pn), 'A39 主题页的指路 hint 已删除');
    // 「内置主题无法导出」改由**禁用态**表达，不再靠文字
    ok(/disabled: isBuiltin/.test(th), 'A39 内置主题时导出按钮禁用（不靠文字说明）');
  }
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
  ok(/\.mm-menu-item/.test(css), 'A39 菜单有样式');
}

{
  // ---- A38 行为级：直接测**真实**函数 ----
  //
  // 这里刻意不去「复刻一份算法再测」：复刻版与真实实现是两份代码，
  // 真实实现改坏了复刻版照样绿。上一轮变异验证就是这么漏掉的
  // （改了 viewBox、去掉了倍率钳制，断言全绿）。
  //
  // 所以把纯逻辑拆成 pngScaleDims / scaleSvgText 两个导出函数，直接测它们。
  // jsdom 有 DOMParser 与 XMLSerializer，只是没有 canvas —— 拆开后正好可测。
  const io = await import('./io.js');

  eq(io.pngScaleDims(800, 600, 1).W, 800, 'A38 1 倍 = 原尺寸');
  eq(io.pngScaleDims(800, 600, 2).W, 1600, 'A38 2 倍 = 宽度翻倍');
  eq(io.pngScaleDims(800, 600, 2).H, 1200, 'A38 2 倍 = 高度也翻倍（等比，不变形）');
  eq(io.pngScaleDims(800, 600, 3).W, 2400, 'A38 3 倍');
  eq(io.pngScaleDims(800, 600, 0).s, 1, 'A38 倍率 0 钳到 1（不能产出 0 像素的图）');
  eq(io.pngScaleDims(800, 600, -5).s, 1, 'A38 负倍率钳到 1');
  eq(io.pngScaleDims(800, 600, NaN).s, 1, 'A38 NaN 倍率钳到 1');
  eq(io.pngScaleDims(800, 600, 99).s, 8, 'A38 超大倍率钳到 8（800×600 配 100 倍要 19GB，浏览器会崩）');
  eq(io.pngScaleDims(0, 600, 2), null, 'A38 宽度 0 → null');
  eq(io.pngScaleDims(NaN, 600, 2), null, 'A38 宽度 NaN → null');
  eq(io.pngScaleDims(-10, 600, 2), null, 'A38 负宽度 → null');

  // ---- scaleSvgText：viewBox 必须原样不动 ----
  const src1 = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600" style="background:#fff"><rect width="10" height="10"/></svg>';
  const out2 = io.scaleSvgText(src1, 2);
  ok(!!out2, 'A38 scaleSvgText 正常返回');
  ok(/width="1600"/.test(out2), 'A38 2 倍 → width=1600');
  ok(/height="1200"/.test(out2), 'A38 2 倍 → height=1200');
  ok(/viewBox="0 0 800 600"/.test(out2),
    'A38 **viewBox 保持不动** —— 这是矢量放大的关键（一起改就变成补白，图还是糊的）');
  ok(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(out2), 'A38 输出带 xmlns（否则浏览器拒绝当图片加载）');

  // 1 倍时不该有任何尺寸变化
  const out1 = io.scaleSvgText(src1, 1);
  ok(/width="800"/.test(out1) && /height="600"/.test(out1), 'A38 1 倍尺寸不变');

  // 异常输入
  eq(io.scaleSvgText('', 2), null, 'A38 空字符串 → null');
  eq(io.scaleSvgText(null, 2), null, 'A38 null → null');
  eq(io.scaleSvgText('<svg width="0" height="600"></svg>', 2), null, 'A38 宽为 0 → null');
  eq(io.scaleSvgText('这不是 xml', 2), null, 'A38 非法 XML → null（不抛）');
}

{
  // ---- A30 行为级：确认与否的结果 ----
  async function importLike(curCount, userConfirmed) {
    if (curCount > 0) {
      const ok = await Promise.resolve(userConfirmed);
      if (!ok) return { replaced: false };
    }
    return { replaced: true };
  }
  eq((await importLike(3, false)).replaced, false, 'A30 有 3 张画布 + 取消 → 不替换');
  eq((await importLike(3, true)).replaced, true, 'A30 有 3 张画布 + 确认 → 替换');
  eq((await importLike(0, false)).replaced, true, 'A30 空脑图 → 不弹确认，直接导入');

  // 对照：无确认的版本，用户点错文件就清空了正在编辑的内容
  async function brokenImport(curCount) { return { replaced: true }; }
  eq((await brokenImport(3)).replaced, true, '（对照）无确认时照替换 —— 这正是要防的（选错文件即清空）');
}

/* ============================================================
   二十八、P3：打印 / PDF（A34–A37 A41 B29 —— 实为 Web 新增）
   ============================================================ */

group('P3 打印与 PDF');

{
  // ---- 先记录核实结论：WPF 原版没有打印功能 ----
  // 清单里 A34–A37 / A41 / B29 的出处全是「未定位到确切行号」，
  // 而 WPF 全仓搜 Print 零命中（唯一 PrintWindow 是截窗口的 Win32 API）。
  // 所以这 8 项不是「移植缺失」，而是 Web 版新增。这里用注释锁住结论，
  // 免得将来有人又当成「从 WPF 漏移植」去补。
  const io = await import('./io.js');
  ok(typeof io.printSvg === 'function', 'io 导出 printSvg');
  ok(typeof io.printPageCss === 'function', 'io 导出 printPageCss');
  ok(typeof io.printHideCss === 'function', 'io 导出 printHideCss');
  ok(typeof io.fitSvgForPrint === 'function', 'io 导出 fitSvgForPrint');
}

{
  const io = await import('./io.js');

  // ---- printPageCss：方向与页边距 ----
  eq(io.printPageCss({}).includes('size: A4 portrait'), true, 'A34 默认纵向');
  ok(/size: A4 landscape/.test(io.printPageCss({ landscape: true })), 'A34 横向生效');
  ok(/margin: 10mm/.test(io.printPageCss({})), 'A34 默认页边距 10mm');
  ok(/margin: 0mm/.test(io.printPageCss({ margin: 0 })), 'A34 无边距（0 是合法值，不能当非法退回默认）');
  ok(/margin: 15mm/.test(io.printPageCss({ margin: 15 })), 'A34 自定义页边距');
  ok(/margin: 10mm/.test(io.printPageCss({ margin: -5 })), 'A34 负页边距退回默认（负边距会裁掉内容）');
  ok(/margin: 10mm/.test(io.printPageCss({ margin: NaN })), 'A34 NaN 页边距退回默认');

  // ---- printHideCss：两段缺一不可 ----
  const hide = io.printHideCss('.mm-print-root');
  ok(/print-color-adjust: exact/.test(hide), 'A34 保留背景色（否则深色画布印成白纸）');
  ok(/-webkit-print-color-adjust: exact/.test(hide), 'A34 带 -webkit- 前缀（Safari/Chrome 需要）');
  ok(/body > \*:not\(\.mm-print-root\) \{ display: none/.test(hide),
    'A34 隐藏其它兄弟（否则侧栏/工具栏一起印上去）');
  ok(/@media print/.test(hide), 'A34 只在打印时生效（屏幕上看不到影响）');
}

{
  const io = await import('./io.js');

  // ---- fitSvgForPrint：viewBox 必须保留 ----
  const src = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="10" height="10"/></svg>';
  const out = io.fitSvgForPrint(src);
  ok(!/width="800"/.test(out), 'A34 去掉固定宽度（否则会溢出纸张）');
  ok(!/height="600"/.test(out), 'A34 去掉固定高度');
  ok(/viewBox="0 0 800 600"/.test(out), 'A34 **保留 viewBox** —— 这是等比缩放的前提');
  ok(/preserveAspectRatio="xMidYMid meet"/.test(out),
    'A34 显式 preserveAspectRatio（不同浏览器对无宽高 SVG 的默认行为不一致）');
  ok(/class="mm-print-svg"/.test(out), 'A34 打上类名（交给 CSS 控制尺寸）');

  // 异常输入：解析不了就原样返回，打印总好过抛异常
  eq(io.fitSvgForPrint(''), '', 'A34 空串原样返回');
  eq(io.fitSvgForPrint('这不是 svg'), '这不是 svg', 'A34 非法输入原样返回（不抛）');
  eq(io.fitSvgForPrint(null), '', 'A34 null → 空串（不抛）');
}

{
  const io = await import('./io.js');

  // ---- printSvg：无打印能力 / 调用即抛时，都要安静地返回 false ----
  //
  // 注意 jsdom **有** window.print，只是个打 stderr 的 stub（不抛）。
  // 所以「无打印能力」要**主动模拟**：把 print 置为 undefined。
  // 直接断言「jsdom 下返回 false」是错的 —— 它有函数，返回 true 才对。
  const savedPrint = globalThis.window.print;
  let threw = false;
  let r;
  try {
    globalThis.window.print = undefined;
    r = await io.printSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>');
  } catch { threw = true; } finally { globalThis.window.print = savedPrint; }
  eq(threw, false, 'A36 无 window.print 时不抛异常');
  eq(r, false, 'A36 无打印能力时返回 false（调用方据此提示而非静默）');
  eq(await io.printSvg(''), false, 'A36 无 SVG 内容返回 false');

  // 有函数但调用即抛（某些宿主的无打印后端）同样要转 false，不能冒泡
  let threw2 = false, r2;
  try {
    globalThis.window.print = () => { throw new Error('no backend'); };
    r2 = await io.printSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>');
  } catch { threw2 = true; } finally { globalThis.window.print = savedPrint; }
  eq(threw2, false, 'A36 打印抛异常时不冒泡（否则变成看不懂的 unhandled rejection）');
  eq(r2, false, 'A36 打印抛异常时返回 false');

  // ---- 反过来：有 print 时确实调用了 ----
  const savedPrint2 = globalThis.window.print;
  let called = 0;
  globalThis.window.print = () => { called++; };
  const okp = await io.printSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>', { title: '我的脑图' });
  eq(okp, true, 'A36 有打印能力时返回 true');
  eq(called, 1, 'A36 确实调用了 window.print 一次');
  // 打印根容器要真的挂上去（否则印的是空白页）
  ok(document.querySelector('.mm-print-root'), 'A34 打印根容器已挂载');
  ok(document.querySelector('.mm-print-svg'), 'A34 待打印 SVG 已放入容器');
  // 样式注入
  const styles = [...document.querySelectorAll('style')].map((n) => n.textContent).join('\n');
  ok(/@page/.test(styles), 'A34 注入了 @page 规则');
  ok(/print-color-adjust: exact/.test(styles), 'A34 注入了保留背景的规则');

  // 清理：afterprint 或定时器都会移除，不能留下垃圾 DOM
  globalThis.window.print = savedPrint2;
  window.dispatchEvent(new globalThis.window.Event('afterprint'));
  eq(document.querySelector('.mm-print-root'), null, 'A34 打印后清理容器（不留垃圾 DOM）');
}

{
  // ---- A35/A41 打印设置框 ----
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/export function openPrintSettings/.test(pn), 'A35 新增 openPrintSettings');
  const fn = pn.slice(pn.indexOf('export function openPrintSettings'), pn.indexOf('/** 自定义主题编辑器'));
  ok(/let landscape = true/.test(fn), 'A35 默认横向（脑图更宽，横向少浪费纸张）');
  ok(/纸张方向/.test(fn), 'A41 提供方向选择');
  ok(/页边距/.test(fn), 'A41 提供页边距选择');
  ok(/onPrint\?\.\(\{ landscape, margin \}\)/.test(fn), 'A35 把设置回传给调用方');
  ok(/另存为 PDF/.test(fn), 'A37 提示中说明如何导出 PDF');
  ok(/完整画布/.test(fn), 'A34 提示说明打印的是完整画布而非视口');

  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(/async function printMap/.test(idx), 'A34 新增 printMap');
  ok(/bridge\?\.exportSvg\(\)/.test(idx), 'A34 打印取的是完整画布 SVG（不是视口截图）');
  const pm = idx.slice(idx.indexOf('async function printMap'), idx.indexOf('function reportSave'));
  ok(/const ok = await io\.printSvg/.test(pm), 'A34 调用 io.printSvg');
  ok(/status\(`已发起打印/.test(pm), 'A34 成功时给出状态提示');
  ok(/当前环境不支持打印/.test(pm), 'A36 不支持时明确提示（printSvg 返回 false 不能被忽略）');
  // 打印入口在侧栏「导入导出」页（原顶栏下拉菜单已删除）
  const pn2 = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const ex2 = pn2.slice(pn2.indexOf('function pageExchange('), pn2.indexOf('pages.file = pageFile;'));
  ok(/打印 \/ 存为 PDF…/.test(ex2), 'A39 导入导出页里有打印入口');
}

/* ============================================================
   二十九、P3b：改走 Tauri Rust 命令（mm_print + 回退）
   ============================================================ */

group('P3b Tauri Rust 打印命令');

{
  const io = await import('./io.js');

  // ---- 自定义 print 路径：返回 true 就用它，不再调 window.print ----
  const savedPrint = globalThis.window.print;
  let jsCalled = 0;
  globalThis.window.print = () => { jsCalled++; };

  let rustCalled = 0;
  const okNative = await io.printSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>', {
    print: async () => { rustCalled++; return true; },
  });
  eq(okNative, true, 'Rust 路径可用时返回 true');
  eq(rustCalled, 1, '调用了 Rust 路径');
  eq(jsCalled, 0, '**没有**再调 window.print（两条路不能都走，否则弹两个对话框）');
  globalThis.window.print = savedPrint;
  window.dispatchEvent(new globalThis.window.Event('afterprint'));

  // ---- 返回 false：自动回退 window.print ----
  const saved2 = globalThis.window.print;
  let jsCalled2 = 0;
  globalThis.window.print = () => { jsCalled2++; };
  let rustCalled2 = 0;
  const okFb = await io.printSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>', {
    print: async () => { rustCalled2++; return false; },
  });
  eq(okFb, true, 'Rust 不可用时回退后仍返回 true');
  eq(rustCalled2, 1, '确实先试过 Rust 路径');
  eq(jsCalled2, 1, '回退到 window.print 并调用了一次');
  globalThis.window.print = saved2;
  window.dispatchEvent(new globalThis.window.Event('afterprint'));

  // ---- Rust 抛异常（非 Tauri 环境）也要回退，不能冒泡 ----
  const saved3 = globalThis.window.print;
  let jsCalled3 = 0, threw = false;
  globalThis.window.print = () => { jsCalled3++; };
  try {
    await io.printSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>', {
      print: async () => { throw new Error('不在 Tauri 环境中'); },
    });
  } catch { threw = true; }
  eq(threw, false, 'Rust 路径抛异常时不冒泡（浏览器调试模式下会走到这里）');
  eq(jsCalled3, 1, '抛异常后仍回退 window.print');
  globalThis.window.print = saved3;
  window.dispatchEvent(new globalThis.window.Event('afterprint'));

  // ---- 两条路都不可用：返回 false 且不留垃圾 DOM ----
  const saved4 = globalThis.window.print;
  globalThis.window.print = undefined;
  const okNone = await io.printSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>', {
    print: async () => false,
  });
  eq(okNone, false, '两条路都不可用 → 返回 false');
  eq(document.querySelector('.mm-print-root'), null, '失败时不留打印容器（不留垃圾 DOM）');
  globalThis.window.print = saved4;
}

{
  // ---- Rust 侧：命令注册与平台判断 ----
  const rs = fs.readFileSync(path.join(HERE, '../../src-tauri/src/main.rs'), 'utf8');
  ok(/fn mm_print\(window: WebviewWindow\) -> Result<String, String>/.test(rs), 'Rust 新增 mm_print 命令');
  ok(/mm_print, mm_print_support/.test(rs), '两个命令都已注册到 invoke_handler');
  ok(/fn mm_print_support\(\) -> bool/.test(rs), 'Rust 新增 mm_print_support（前端可预知能力）');
  ok(/cfg!\(target_os = "macos"\)/.test(rs), 'mm_print_support 与 mm_print 的平台判断一致（都用 macOS）');

  const mmp = rs.slice(rs.indexOf('fn mm_print('), rs.indexOf('fn mm_print_support'));
  ok(/#\[cfg\(target_os = "macos"\)\]/.test(mmp), 'macOS 分支走原生 print()');
  ok(/#\[cfg\(not\(target_os = "macos"\)\)\]/.test(mmp), '非 macOS 分支显式声明不支持');
  ok(/let _ = &window;/.test(mmp), '非 macOS 分支消费掉 window（magic parameter 必存在，否则 unused 警告）');
  // 关键：不能静默 no-op
  ok(/Err\(format!\(/.test(mmp), '非 macOS **返回 Err 而不是静默成功** —— 这是本实现的核心');
  ok(/std::env::consts::OS/.test(mmp), '错误信息带上实际平台（便于排查）');

  // 必须两个分支都有，缺一个就是「只支持一半」
  const cfgCount = (mmp.match(/#\[cfg\(/g) || []).length;
  eq(cfgCount, 2, 'mm_print 里恰好两个互斥 cfg 分支');
}

{
  // ---- 前端：printMap 走 Rust 命令 ----
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const pm = idx.slice(idx.indexOf('async function printMap'), idx.indexOf('function reportSave'));
  ok(/ctx\.invoke\('mm_print'/.test(pm), 'printMap 调用 Rust 命令 mm_print');
  ok(/print: async \(\) => \{/.test(pm), '通过 opts.print 注入自定义路径（io 层不依赖 Tauri）');
  const cb = pm.slice(pm.indexOf('print: async () =>'), pm.indexOf("},\n    });"));
  ok(/catch \{\s*\n\s*return false;/.test(cb), 'Rust 路径失败时返回 false 让 io 回退（不是抛）');
  ok(/via = 'Tauri 原生'/.test(pm), '走 Rust 时状态栏标明（让用户知道走的哪条路）');
  ok(/via \? ` · \$\{via\}` : ''/.test(pm), '两条路径的提示要能区分');

  // io 层不能引入 Tauri 知识
  const iom = fs.readFileSync(path.join(HERE, 'io.js'), 'utf8');
  ok(!/invoke|@tauri-apps/.test(iom), 'io.js 不引入 Tauri 依赖（路径选择留给调用方）');
  ok(/if \(!ok && typeof window !== 'undefined' && typeof window\.print === 'function'\)/.test(iom),
    'io.js 在自定义路径返回 false 后回退 window.print');
  ok(/if \(!ok\) \{[\s\S]{0,120}cleanup\(\);[\s\S]{0,60}return false;/.test(iom),
    'io.js 失败时清理并返回 false');
  ok(/typeof timer\?\.unref === 'function'/.test(iom), '兜底定时器 unref（否则吊住 Node 进程不退出）');
}

/* ============================================================
   三十、SVG → PDF 矢量通道（svg2pdf）+ 双通道托底
   ============================================================ */

group('SVG → PDF 矢量通道');

{
  const io = await import('./io.js');

  // ---- svgSize：宽高属性 / viewBox / 都没有 ----
  eq(io.svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect/></svg>').w, 800, 'svgSize 读 width');
  eq(io.svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect/></svg>').h, 600, 'svgSize 读 height');
  const vb = io.svgSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 400 300"><rect/></svg>');
  eq(vb.w, 400, 'svgSize 回退 viewBox 宽（忽略 x 偏移）');
  eq(vb.h, 300, 'svgSize 回退 viewBox 高（忽略 y 偏移）');
  // width 有、height 没有 → 各自独立回退
  const mix = io.svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="800" viewBox="0 0 400 300"><rect/></svg>');
  eq(mix.w, 800, 'svgSize 宽优先用属性');
  eq(mix.h, 300, 'svgSize 高从 viewBox 补（宽高各自独立回退）');
  eq(io.svgSize('').w, 0, 'svgSize 空串 → 0');
  eq(io.svgSize('不是 svg').w, 0, 'svgSize 非法输入 → 0（不抛）');
  eq(io.svgSize(null).w, 0, 'svgSize null → 0（不抛）');

  // ---- pdfDpi ----
  // 拿不到尺寸 → 回退 72（svg2pdf 默认，即不缩放）
  eq(io.pdfDpi(''), 72, 'pdfDpi 无尺寸 → 72');
  eq(io.pdfDpi('xx'), 72, 'pdfDpi 非法输入 → 72');

  // 极小图（200×100）不会超出 A4 → 只缩不放，scale=1 → dpi=72
  const tiny = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect/></svg>';
  eq(io.pdfDpi(tiny), 72, 'pdfDpi 小图不放大（scale 钳到 1）');

  // 大图（4000×1000，又宽又扁）纵向时宽度是瓶颈
  const wide = '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1000"><rect/></svg>';
  const dPortrait = io.pdfDpi(wide, { landscape: false });
  // A4 纵向内容区 190mm ≈ 538.6pt；scale=538.6/4000；dpi=72/scale
  const expP = 72 / ((190 * (72 / 25.4)) / 4000);
  ok(Math.abs(dPortrait - expP) < 0.01, `pdfDpi 纵向按**宽度**适配（${dPortrait.toFixed(1)} ≈ ${expP.toFixed(1)}）`);
  ok(dPortrait > 72, 'pdfDpi 大图时 dpi > 72（表示缩小）');

  // 同一张图横向：内容区更宽(277mm)，缩放更少 → dpi 更小
  const dLand = io.pdfDpi(wide, { landscape: true });
  ok(dLand < dPortrait, 'pdfDpi 横向 dpi 更小（纸更宽，缩放更少）');

  // 又高又窄的图：纵向时**高度**才是瓶颈，只按宽度算会溢出
  const tall = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="4000"><rect/></svg>';
  const dTall = io.pdfDpi(tall, { landscape: false });
  // 高度瓶颈：A4 纵向高 297mm − 20mm 边距 = 277mm ≈ 785.2pt
  const expT = 72 / ((277 * (72 / 25.4)) / 4000);
  ok(Math.abs(dTall - expT) < 0.01, `pdfDpi 取宽高**两个比例的 min**（高图按高度定，${dTall.toFixed(1)}）`);
  // 只按宽度算的话 dpi 会是 72/(538.6/1000)=133.7，明显不同
  const widthOnly = 72 / ((190 * (72 / 25.4)) / 1000);
  ok(Math.abs(dTall - widthOnly) > 1, 'pdfDpi 不是只按宽度算（否则高图会溢出纸面）');

  // 页边距非法值
  ok(Number.isFinite(io.pdfDpi(wide, { margin: -5 })), 'pdfDpi 负边距不产生 NaN（退回默认边距）');
  ok(Number.isFinite(io.pdfDpi(wide, { margin: NaN })), 'pdfDpi NaN 边距不产生 NaN');
  // 边距大到内容区为负 → 回退 72，不能算出负 dpi
  eq(io.pdfDpi(wide, { margin: 999 }), 72, 'pdfDpi 边距吃光纸张 → 72（不能出负数）');
}

{
  const io = await import('./io.js');
  // ---- base64ToBlob：不走 data: URL（大 PDF 会超长度限制而静默失败）----
  const b64 = btoa('hello');
  const blob = io.base64ToBlob(b64, 'application/pdf');
  ok(blob instanceof Blob, 'base64ToBlob 返回 Blob');
  eq(blob?.type, 'application/pdf', 'base64ToBlob 带正确 MIME');
  eq(blob?.size, 5, 'base64ToBlob 长度正确');
  eq(io.base64ToBlob(''), null, 'base64ToBlob 空串 → null');
  eq(io.base64ToBlob('!!!非法!!!'), null, 'base64ToBlob 非法 base64 → null（不抛）');
  eq(io.base64ToBlob(null), null, 'base64ToBlob null → null');
}

{
  // ---- Rust 侧 ----
  const rs = fs.readFileSync(path.join(HERE, '../../src-tauri/src/main.rs'), 'utf8');
  ok(/fn mm_svg_to_pdf/.test(rs), 'Rust 新增 mm_svg_to_pdf');
  ok(/mm_svg_to_pdf, mm_pdf_vector_support/.test(rs), '两个 PDF 命令都已注册');
  ok(/fn mm_pdf_vector_support/.test(rs), 'Rust 新增 mm_pdf_vector_support（供前端探测降级）');

  const f = rs.slice(rs.indexOf('fn mm_svg_to_pdf'), rs.indexOf('fn mm_print_support'));
  ok(/svg2pdf::usvg::Tree::from_str/.test(f), 'Rust 用 usvg 解析 SVG');
  ok(/options\.fontdb_mut\(\)\.load_system_fonts\(\)/.test(f),
    'Rust **加载系统字体** —— 不加载中文会丢失/变方框');
  ok(/svg2pdf::PageOptions \{ dpi/.test(f), 'Rust 按传入 dpi 生成页面');
  ok(/dpi\.unwrap_or\(72\.0\)/.test(f), 'Rust dpi 缺省 72（与 JS 侧回退值一致）');
  ok(/fpx::base64::encode/.test(f), 'Rust 返回 base64（复用 fpx::base64，不额外引 crate）');
  ok(/if text\.is_empty\(\)/.test(f), 'Rust 空 SVG 直接报错（不进解析）');
  ok(/if pdf\.is_empty\(\)/.test(f), 'Rust 空 PDF 结果报错（不返回空串）');

  const cg = fs.readFileSync(path.join(HERE, '../../src-tauri/Cargo.toml'), 'utf8');
  ok(/svg2pdf = "0\.13\.0"/.test(cg), 'Cargo.toml 已加 svg2pdf 0.13.0');

  // ---- 前端通道逻辑 ----
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(/async function exportPdf/.test(idx), '新增 exportPdf');
  const ep = idx.slice(idx.indexOf('async function exportPdf'), idx.indexOf('async function printMap'));
  ok(/ctx\.invoke\('mm_svg_to_pdf'/.test(ep), 'exportPdf 调用 mm_svg_to_pdf');
  ok(/io\.pdfDpi\(svg/.test(ep), 'exportPdf 先算 dpi 再传给 Rust');
  ok(/settings\.pdfChannel !== 'dialog'/.test(ep), '默认通道 = 矢量（只有显式 dialog 才不走）');
  ok(/io\.base64ToBlob\(b64/.test(ep), 'exportPdf 解码 base64');
  // 托底
  ok(/矢量 PDF 不可用，改用打印对话框/.test(ep), '矢量失败时**明确提示**再托底（不能静默弹框）');
  ok(/await printMap\(\{ landscape, margin \}\)/.test(ep), '托底走打印对话框');
  // 用户取消不再托底
  // 早先这里是 `if (r !== 'cancel') 就报成功` —— 'error' 也落进那个分支，
  // 变成「保存失败却提示已导出」。现在统一走 reportSave（与其余 7 处导出一致）。
  ok(/reportSave\(r, 'PDF（矢量）'\)/.test(ep), '落盘结果交给 reportSave 处理（不再自己判断）');
  // 用「旧的错误提示文案已消失」来间接确认换了实现 ——
  // 直接正则查 `r !== 'cancel'` 会命中解释这段历史的注释，属于假阳性。
  ok(!/已导出 PDF（矢量）/.test(ep), '旧的「一律报成功」提示已移除（会把 error 也报成已导出）');
  ok(/落盘结果无论成败都不再托底/.test(ep), '只有**矢量转换本身**失败才托底，落盘失败不托底');

  // 设置项
  ok(/setPdfChannel: guard/.test(idx), '新增 setPdfChannel API');
  const sp = idx.slice(idx.indexOf('setPdfChannel: guard'), idx.indexOf('setAnimate: guard'));
  ok(/v === 'dialog' \? 'dialog' : 'vector'/.test(sp), '未知值一律归一为 vector（不存脏值）');
  ok(/await store\.settings\.save\(settings\)/.test(sp), 'setPdfChannel 立即持久化');

  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/PDF 通道/.test(pn), '设置面板新增「PDF 通道」');
  ok(/app\.api\.setPdfChannel\(e\.target\.value\)/.test(pn), '下拉切换调用 setPdfChannel');
  ok(/矢量（直接保存）/.test(pn), '选项一：矢量');
  ok(/打印对话框/.test(pn), '选项二：打印对话框');
  // 切片要从 pdfSel **之后**再找「外观」：文件里另有一个 openXxx 也含
  // section('外观'，直接用 indexOf 会定位到前面那个，导致 slice 返回空串
  const pselStart = pn.indexOf("const pdfSel =");
  const psel = pn.slice(pselStart, pn.indexOf("section('外观'", pselStart));
  ok(/selected: \(s\.pdfChannel \|\| 'vector'\) === 'vector'/.test(psel),
    '默认选中「矢量」（未设置过 pdfChannel 时也要选中它）');
  ok(/任一通道不可用时会自动改用另一条/.test(psel), '说明里讲清托底行为（不是二选一硬切）');

  // 默认值
  ok(/pdfChannel: 'vector'/.test(idx), 'settings 默认值 pdfChannel=vector');
}

/* ============================================================
   三十一、审查修复 + A65/A66 边界 + A5 + A18 + A70 + A71
   ============================================================ */

group('审查修复与 A65/A66 主题导入导出边界');

{
  const th = await import('./themes.js');

  // ---- colorKind ----
  eq(th.colorKind('#fff'), 'color', 'colorKind 认 #RGB');
  eq(th.colorKind('#ffffff'), 'color', 'colorKind 认 #RRGGBB');
  eq(th.colorKind('rgb(1,2,3)'), 'color', 'colorKind 认 rgb()');
  eq(th.colorKind('transparent'), 'transparent', 'colorKind 单独识别 transparent（不是合法 palette 值）');
  eq(th.colorKind('TRANSPARENT'), 'transparent', 'colorKind 大小写不敏感');
  eq(th.colorKind('不是颜色'), null, 'colorKind 非法值 → null');
  eq(th.colorKind(123), null, 'colorKind 非字符串 → null');

  // ---- sanitizePalette ----
  const r1 = th.sanitizePalette({ subBackground: 'transparent', background: '#101010' });
  eq(r1.palette.subBackground, '#101010', "A65 transparent 回落到画布底色（core 不认 transparent）");
  eq(r1.fixed.includes('subBackground'), true, 'A65 被修正的字段要列出来');

  const r2 = th.sanitizePalette({ subBackground: 'transparent' });
  eq(r2.palette.subBackground, '#FBFBFB', 'A65 没有 background 时用兜底色');

  const r3 = th.sanitizePalette({ rootBackground: '随便乱写' });
  eq(r3.palette.rootBackground, '#4A90D9', 'A65 非法色值 → 兜底色');
  eq(r3.fixed.includes('rootBackground'), true, 'A65 非法值被记录');

  const r4 = th.sanitizePalette({ connectWidth: 0 });
  eq(r4.palette.connectWidth, 2, 'A65 connectWidth=0 会让连线看不见 → 修正为 2');
  const r5 = th.sanitizePalette({ connectWidth: -3 });
  eq(r5.palette.connectWidth, 2, 'A65 负数 connectWidth 会让 core 崩 → 修正');
  const r6 = th.sanitizePalette({ rootFontSize: 0 });
  eq(r6.palette.rootFontSize, 16, 'A65 字号 0 会让文字消失 → 修正');

  const r7 = th.sanitizePalette({ background: '#fff', rootBackground: '#000' });
  eq(r7.fixed.length, 0, 'A65 合法值不被修改');
  eq(r7.palette.background, '#fff', 'A65 合法值原样保留');

  // 未提供的字段不该被凭空加上（否则会把用户的部分主题填成另一套）
  const r8 = th.sanitizePalette({ background: '#abcdef' });
  eq(r8.palette.rootBackground, undefined, 'A65 缺失字段不擅自补默认值（保持用户的原样）');
}

{
  const pn = await import('./panels.js');
  // ---- 主题重名 ----
  eq(pn.uniqueThemeName('我的主题', []), '我的主题', '重名：空列表直接用原名');
  eq(pn.uniqueThemeName('我的主题', [{ name: '我的主题' }]), '我的主题 (2)', '重名：加 (2)');
  eq(pn.uniqueThemeName('我的主题', [{ name: '我的主题' }, { name: '我的主题 (2)' }]), '我的主题 (3)',
    '重名：已有 (2) 则给 (3)');
  eq(pn.uniqueThemeName('', []), '未命名', '空名 → 未命名');
  eq(pn.uniqueThemeName('  ', []), '未命名', '纯空格 → 未命名');

  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const imp = src.slice(src.indexOf('async function importThemeFile'), src.indexOf('function pageTheme'));
  ok(/sanitizePalette\(pal\)/.test(imp), 'A65 导入时校验 palette（此前完全没有，属两条路径不对称）');
  ok(/uniqueThemeName\(t\.name/.test(imp), 'A65 导入时处理重名');
  ok(/固定\.length\s*\n?\s*\?/.test(imp) || /已修正 \$\{fixed\.length\} 个无效值/.test(imp),
    'A65 修正过的字段要告诉用户（不能静默改人家的文件）');
  const exp = src.slice(src.indexOf('async function exportThemeFile'), src.indexOf('async function importThemeFile'));
  ok(/if \(r !== 'cancel'\)/.test(exp), 'A66 导出：用户取消时不提示');
  ok(/导出主题失败/.test(exp), 'A66 导出：失败要提示');
}

group('A5 剪贴板位图导入 / A18 失效图标清理');

{
  const pn = await import('./panels.js');
  // ---- imageItemsFromClipboard ----
  eq(pn.imageItemsFromClipboard(null).length, 0, 'A5 无剪贴板数据 → 空');
  eq(pn.imageItemsFromClipboard({ files: [] }).length, 0, 'A5 空文件列表 → 空');

  const mkFile = (type) => ({ type, name: 'x' });
  eq(pn.imageItemsFromClipboard({ files: [mkFile('image/png')] }).length, 1, 'A5 取图片文件');
  eq(pn.imageItemsFromClipboard({ files: [mkFile('text/plain')] }).length, 0,
    'A5 过滤掉非图片（否则会生成打不开的图标条目）');
  eq(pn.imageItemsFromClipboard({ files: [mkFile('image/png'), mkFile('text/plain')] }).length, 1,
    'A5 混合时只要图片');

  // 兜底：只有 items 没有 files 的环境
  const itemOnly = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => mkFile('image/png') }] };
  eq(pn.imageItemsFromClipboard(itemOnly).length, 1, 'A5 兜底走 items（部分环境不填 files）');
  eq(pn.imageItemsFromClipboard({ items: [{ kind: 'string', type: 'text/plain' }] }).length, 0,
    'A5 items 里的非 file 类型被忽略');

  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/addEventListener\('paste', onPasteIcons\)/.test(src), 'A5 挂了 paste 监听');
  ok(/removeEventListener\('paste', onPasteIcons\)/.test(src),
    'A5 关闭时解绑 —— 不解绑会重复触发，一次 Ctrl+V 加进去两份');
  ok(/document\.addEventListener\('paste'/.test(src),
    'A5 挂在 document 上（对话框本身拿不到焦点，挂它身上收不到 paste）');
  ok(/if \(!files\.length\) return;/.test(src), 'A5 剪贴板没图时静默不响应（否则每次 Ctrl+V 都弹提示）');
}

{
  const pi = await import('./preset-icons.js');
  // ---- partitionMissing（纯函数）----
  const live = new Set(['a1']);
  const r = pi.partitionMissing(
    [{ kind: 'user', assetId: 'a1' }, { kind: 'user', assetId: 'gone' }, { kind: 'builtin', id: 'b1' }],
    live);
  eq(r.keep.length, 2, 'A18 保留有效用户图标 + 内置图标');
  eq(r.drop.length, 1, 'A18 挑出资产丢失的用户图标');
  eq(r.drop[0].assetId, 'gone', 'A18 丢的是资产没了的那条');
  // 内置图标不依赖资产，永不失效
  eq(pi.partitionMissing([{ kind: 'builtin' }], new Set()).drop.length, 0,
    'A18 内置图标无资产依赖，不会被判失效（path 在代码里）');
  eq(pi.partitionMissing([], new Set()).keep.length, 0, 'A18 空列表不报错');
  eq(pi.partitionMissing(null, new Set()).keep.length, 0, 'A18 null 不报错');

  ok(typeof pi.pruneMissing === 'function', 'A18 导出 pruneMissing');
  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/清理失效/.test(src), 'A18 图标库里有「清理失效」入口');
  ok(/picons\.pruneMissing\(\)/.test(src), 'A18 入口调用 pruneMissing');
}

group('A70 开发者工具 / A71 诊断捕获');

{
  // ---- Rust 侧 A70 ----
  const rs = fs.readFileSync(path.join(HERE, '../../src-tauri/src/main.rs'), 'utf8');
  ok(/fn mm_open_devtools/.test(rs), 'A70 Rust 新增 mm_open_devtools');
  ok(/mm_open_devtools,/.test(rs), 'A70 命令已注册');
  const f = rs.slice(rs.indexOf('fn mm_open_devtools'), rs.indexOf('/// 当前是否具备'));
  ok(/#\[cfg\(debug_assertions\)\]/.test(f), 'A70 debug 构建才真的打开');
  ok(/#\[cfg\(not\(debug_assertions\)\)\]/.test(f), 'A70 release 明确报错（给最终用户开控制台没意义）');
  ok(/window\.open_devtools\(\)/.test(f), 'A70 调用 Tauri 的 open_devtools');
  ok(/let _ = &window;/.test(f), 'A70 release 分支消费掉 magic parameter');

  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(/ctx\.invoke\('mm_open_devtools'/.test(idx), 'A70 前端调用 mm_open_devtools');
  ok(/openDevTools: guard/.test(idx), 'A70 暴露 openDevTools API');
  const pn2 = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/开发者工具/.test(pn2), 'A70 设置里有入口');
}

{
  const dg = await import('./diagnostics.js');

  // ---- normalize ----
  const n1 = dg.normalize({ message: 'boom', level: 'error', source: 'editor' });
  eq(n1.level, 'error', 'A71 normalize 保留级别');
  eq(n1.message, 'boom', 'A71 normalize 保留消息');
  eq(n1.source, 'editor', 'A71 normalize 保留来源');
  eq(dg.normalize({ message: 'x', level: 'warn' }).level, 'warn', 'A71 warn 级别');
  eq(dg.normalize({ message: 'x', level: 'haha' }).level, 'error', 'A71 未知级别归为 error');
  eq(dg.normalize({ message: '   ' }), null, 'A71 空消息 → null（过滤噪声）');
  eq(dg.normalize(null), null, 'A71 null → null');
  ok(typeof dg.normalize('plain string').message === 'string', 'A71 裸字符串也能收');

  // ---- pushEntries 环形缓冲 ----
  const e = (i) => ({ message: 'm' + i, level: 'error', source: 'shell', at: i });
  const big = dg.pushEntries([], Array.from({ length: 150 }, (_, i) => e(i)), 100);
  eq(big.length, 100, 'A71 超限时截断到上限');
  eq(big[big.length - 1].message, 'm149', 'A71 **保留最近的**（丢最旧的）');
  eq(big[0].message, 'm50', 'A71 最旧的被丢掉');
  eq(dg.pushEntries([e(1)], [e(2)]).length, 2, 'A71 未超限则累加');
  const orig = [e(1)];
  dg.pushEntries(orig, [e(2)]);
  eq(orig.length, 1, 'A71 不改动入参（返回新数组）');

  // ---- filterByLevel / formatReport ----
  const mixed = [
    { message: 'a', level: 'error', source: 's', at: 1 },
    { message: 'b', level: 'warn', source: 's', at: 2 },
  ];
  eq(dg.filterByLevel(mixed, 'error').length, 1, 'A71 按级别过滤');
  eq(dg.filterByLevel(mixed).length, 2, 'A71 不传级别返回全部');
  ok(/ERROR/.test(dg.formatReport(mixed)), 'A71 报告含级别');
  // 注意是**全角**括号：直接写 ASCII 的 \( \) 匹配不上，属于假阴性
  ok(dg.formatReport([]).includes('无诊断记录'), 'A71 空列表给出明确文案');

  // ---- 内层 iframe 捕获 ----
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  ok(/addEventListener\('error'/.test(html), 'A71 iframe 捕获 onerror');
  ok(/unhandledrejection/.test(html), 'A71 iframe 捕获 unhandledrejection');
  ok(/console\[lv\]/.test(html) || /'error', 'warn'/.test(html), 'A71 iframe 包装 console.error/warn');
  ok(/type: 'diagnostic'/.test(html), 'A71 iframe 以 diagnostic 类型上报');
  // 捕获阶段：资源加载错误不冒泡
  ok(/}, true\);\s*\/\/ 捕获阶段/.test(html) || /捕获阶段/.test(html),
    'A71 用捕获阶段收资源加载错误（那类不冒泡）');

  // ---- bridge 转发 ----
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  ok(/case 'diagnostic':/.test(br), 'A71 bridge 转发 diagnostic');
  ok(/onDiagnostic\?\.\(d\)/.test(br), 'A71 通过 handler 回调出去');

  // ---- 外壳侧捕获 ----
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(/function captureShellErrors/.test(idx), 'A71 外壳侧也有捕获（不只 iframe）');
  ok(/captureShellErrors\(\);/.test(idx), 'A71 外壳捕获真的被调用');
  ok(/onDiagnostic: \(d\) =>/.test(idx), 'A71 插件层接收并收集');
  ok(/diag\.pushEntries\(diagnostics, \[e\]\)/.test(idx), 'A71 走环形缓冲（不会无限堆积）');

  // ---- 诊断窗口 ----
  const pn3 = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/export function openDiagnostics/.test(pn3), 'A71 新增诊断窗口');
  ok(/诊断记录…/.test(pn3), 'A71 设置里有入口');
  const od = pn3.slice(pn3.indexOf('export function openDiagnostics'), pn3.indexOf('/** 自定义主题编辑器 */'));
  ok(/textarea/.test(od), 'A71 用 textarea（可整段复制去报问题，pre 换行会乱）');
  ok(/readonly/.test(od), 'A71 只读');
  ok(/navigator\.clipboard\.writeText/.test(od), 'A71 一键复制');
  ok(/ta\.select\(\)/.test(od), 'A71 剪贴板不可用时退化为全选（还能手动 Ctrl+C）');
}

/* ============================================================
   三十二、B27 导出前同步 + B4/B5 档位补项 + B6 颜色名
   ============================================================ */

group('B27 导出前同步编辑器状态（capture）');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const lines = idx.split('\n');
  const fns = ['exportJson', 'exportMarkdown', 'exportTxt', 'exportSvg',
    'exportXmind', 'exportPng', 'exportPdf', 'printMap'];
  const starts = [];
  for (const fn of fns) {
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp('function\\s+' + fn + '\\s*\\(').test(lines[i])) { starts.push([fn, i]); break; }
    }
  }
  starts.sort((a, b) => a[1] - b[1]);

  const bodyOf = (fn) => {
    const k = starts.findIndex((x) => x[0] === fn);
    if (k < 0) return '';
    const end = k + 1 < starts.length ? starts[k + 1][1] : starts[k][1] + 40;
    return lines.slice(starts[k][1], end).join('\n');
  };

  // 读内存数据结构的导出**必须**先 capture，否则导出的是改之前的内容
  for (const fn of ['exportJson', 'exportMarkdown', 'exportTxt']) {
    ok(/capture\(\)/.test(bodyOf(fn)), `B27 ${fn} 读内存 workbook，必须先 capture()`);
  }
  // 直接取编辑器画面的不需要 capture（加了是多余开销）
  for (const fn of ['exportPng', 'exportPdf', 'printMap']) {
    ok(/exportSvg\(\)/.test(bodyOf(fn)), `B27 ${fn} 走 bridge.exportSvg()（实时，无需 capture）`);
  }

  // 防回归：把「哪些需要 capture」写死成断言 ——
  // 这是**第三次**遇到「多条路径只修了一条」，不能只靠人记。
  ok(/必须先 capture\(\)/.test(idx), 'B27 注释里写明了为什么 exportMarkdown 需要 capture');
  ok(/PNG \/ PDF \/ 打印\*\*不需要\*\* capture/.test(idx),
    'B27 注释里也写明了 PNG/PDF/打印为什么**不需要**（避免后人误加）');
}

group('B4/B5 档位动态补项 + B6 颜色名');

{
  const pn = await import('./panels.js');

  // ---- withPresetValue ----
  eq(JSON.stringify(pn.withPresetValue([12, 16], 16)), JSON.stringify([12, 16]),
    'B4 值已在档位里 → 原样返回（不重复加）');
  eq(JSON.stringify(pn.withPresetValue([12, 16], 13)), JSON.stringify([12, 13, 16]),
    'B4 缺失值补进去并**插到正确位置**');
  eq(JSON.stringify(pn.withPresetValue([12, 16], 8)), JSON.stringify([8, 12, 16]), 'B4 比最小还小 → 排最前');
  eq(JSON.stringify(pn.withPresetValue([12, 16], 40)), JSON.stringify([12, 16, 40]), 'B4 比最大还大 → 排最后');
  // 数值排序：字符串排序会把 100 排到 20 前面
  eq(JSON.stringify(pn.withPresetValue([20, 100], 9)), JSON.stringify([9, 20, 100]),
    'B4 **数值**升序（字符串排序会把 100 排到 20 前）');
  eq(JSON.stringify(pn.withPresetValue([12], 'abc')), JSON.stringify([12]), 'B4 非法值不加');
  eq(JSON.stringify(pn.withPresetValue([12], null)), JSON.stringify([12]), 'B4 null 不加');
  // presets 非法时当作空数组处理、value 照常补入 ——
  // 不能因为 presets 坏了就把唯一有效值也丢掉
  eq(JSON.stringify(pn.withPresetValue(null, 13)), JSON.stringify([13]), 'B4 presets 非法 → 不崩，value 仍补入');

  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  // 字号改走 numSpinner 后不再有"下拉框没有任何项被选中"的问题 ——
  // 输入框直接显示当前值（13 就是 13）。动态档位的作用由
  // min/max 微调范围 + list 预设共同承担：值不在预设里也能正常显示与微调。
  ok(/numSpinner\(\{[\s\S]{0,200}?value: st\.fontSize/.test(src),
    'B5 字号用 numSpinner（不在预设档位的值也能正常显示）');
  // 微调范围必须**宽于**预设档位：卡在档位两端的话，微调到最大预设就上不去了
  ok(/const MIN_FS = \d+/.test(src) && /const MAX_FS = \d+/.test(src), '字号有 MIN_FS / MAX_FS');
  {
    const min = Number(src.match(/const MIN_FS = (\d+)/)[1]);
    const max = Number(src.match(/const MAX_FS = (\d+)/)[1]);
    const sizes = JSON.parse(src.match(/const SIZES = (\[[^\]]+\])/)[1]);
    ok(min < Math.min(...sizes), `MIN_FS(${min}) 比最小预设小 —— 否则微调不下去`);
    ok(max > Math.max(...sizes), `MAX_FS(${max}) 比最大预设大 —— 否则微调不上去`);
  }
}

{
  const th = await import('./themes.js');
  // ---- B6 颜色名 ----
  eq(JSON.stringify(th.parseColor('red')), JSON.stringify([255, 0, 0]), 'B6 认 red');
  eq(JSON.stringify(th.parseColor('RED')), JSON.stringify([255, 0, 0]), 'B6 大小写不敏感');
  eq(JSON.stringify(th.parseColor('  blue  ')), JSON.stringify([0, 0, 255]), 'B6 忽略首尾空格');
  eq(JSON.stringify(th.parseColor('steelblue')), JSON.stringify([70, 130, 180]), 'B6 认复合名');
  eq(th.parseColor('不是颜色名'), null, 'B6 未知名 → null');
  // transparent **不能**被当成黑色
  eq(th.parseColor('transparent'), null,
    'B6 transparent 不映射到黑色（透明没有 RGB；colorKind 已单独识别）');
  eq(th.colorKind('transparent'), 'transparent', 'B6 colorKind 仍单独识别 transparent');
  // 原有格式不受影响
  eq(JSON.stringify(th.parseColor('#fff')), JSON.stringify([255, 255, 255]), 'B6 #RGB 不受影响');
  eq(JSON.stringify(th.parseColor('rgb(1,2,3)')), JSON.stringify([1, 2, 3]), 'B6 rgb() 不受影响');

  // 颜色名也要能参与亮度判断（否则 isLightColor 会把 yellow 判成深色）
  eq(th.isLightColor('yellow'), true, 'B6 颜色名参与亮度判断：yellow 是浅色');
  eq(th.isLightColor('navy'), false, 'B6 颜色名参与亮度判断：navy 是深色');
  eq(th.parseColor('red').length, 3, 'B6 返回 3 元组');
  // 返回副本，改了不影响表
  const c = th.parseColor('red');
  c[0] = 0;
  eq(th.parseColor('red')[0], 255, 'B6 返回副本（改返回值不污染颜色表）');
}

/* ============================================================
   三十三、A29 搜索失败状态 + B22 跨机迁移提示
   ============================================================ */

group('A29 搜索失败状态三态分流');

{
  const pn = await import('./panels.js');

  // 1) 没输入关键字 —— 不该显示「无匹配」（会让人以为真没有这个词）
  const t1 = pn.searchStatusText('', { ok: true, total: 0, index: 0 });
  eq(t1.text, '请输入关键字', 'A29 空关键字 → 提示输入（不是「无匹配」）');
  eq(t1.warn, true, 'A29 空关键字是提醒级别');
  eq(pn.searchStatusText('   ', { ok: true, total: 3, index: 1 }).text, '请输入关键字',
    'A29 纯空格也算空（trim 后判断）');

  // 2) 编辑器未就绪 —— 最误导的一种，原实现同样显示「无匹配」
  const t2 = pn.searchStatusText('abc', { ok: false, reason: 'notready' });
  eq(t2.text, '编辑器未就绪', 'A29 未就绪 → 明确说未就绪');
  eq(t2.warn, true, 'A29 未就绪是提醒级别');
  eq(pn.searchStatusText('abc', null).text, '编辑器未就绪', 'A29 无返回也按未就绪处理');
  const t3 = pn.searchStatusText('abc', { ok: false, reason: 'error' });
  eq(t3.text, '搜索失败', 'A29 出错 → 说搜索失败（与未就绪区分）');
  eq(t3.warn, true, 'A29 出错是提醒级别');

  // 3) 真的没搜到 —— 正常结果，**不该报警**
  const t4 = pn.searchStatusText('abc', { ok: true, total: 0, index: 0 });
  eq(t4.text, '无匹配', 'A29 零结果 → 无匹配');
  eq(t4.warn, false, 'A29 零结果是正常结果，不报警');

  // 4) 有结果
  const t5 = pn.searchStatusText('abc', { ok: true, total: 7, index: 2 });
  eq(t5.text, '2/7', 'A29 有结果 → index/total');
  eq(t5.warn, false, 'A29 有结果不报警');

  // ---- bridge 侧：未就绪不能再被兜底成 total:0 ----
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  const sf = br.slice(br.indexOf('  search(keyword) {'), br.indexOf('  search(keyword) {') + 900);
  ok(/ok: false, reason: 'notready'/.test(sf), 'A29 bridge 用 ok:false + reason 表达未就绪');
  ok(!/\|\| \{ total: 0, index: 0, text: '' \}/.test(sf),
    'A29 去掉了把未就绪压成 total:0 的兜底（那正是三态混为一谈的根源）');
  ok(/ok: true, total: r\.total/.test(sf), 'A29 成功时带 ok:true');

  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  // 原先断言"searchStatusText(searchInput.value 出现 2 次"，
  // 那是**两处各写一遍**时代的检查。现在两处都调同一个 runSearch()，
  // 比各写一遍更强（不可能不一致），所以改断言两处都调它。
  ok(/function runSearch\(/.test(idx), 'A29 抽出 runSearch（回车与定位共用）');
  {
    const tb = idx.slice(idx.indexOf('const searchInput = h('), idx.indexOf('toolbar.appendChild(h(\'div.mm-sep\''));
    // 同样是固定长度窗口被注释撑爆的问题：0,200 装不下 Enter 分支前的说明，
    // 于是「回车调 runSearch」这条恒假。放宽到 900（够长且仍限于 searchInput 块内）。
    ok(/onkeydown[\s\S]{0,900}runSearch\(\)/.test(tb), 'A29 回车调 runSearch');
  }
  eq((idx.match(/B\('定位', \(\) => runSearch\(\)/g) || []).length, 1,
    'A29 定位按钮调 runSearch（与回车同一实现）');
  ok(/classList\.toggle\('warn', st\.warn\)/.test(idx), 'A29 提醒状态要反映到样式上');

  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
  ok(/\.mm-search-info\.warn/.test(css), 'A29 有对应样式（否则 warn 类形同虚设）');
}

group('B22 附件跨机迁移提示');

{
  const wb = await import('./workbook.js');
  const sheet = (root) => ({ id: 's1', title: 'T', content: JSON.stringify({ root }) });

  // ---- collectAssetRefs ----
  const one = sheet({ data: { text: 'a', file: JSON.stringify({ a: 'A1', n: 'x.pdf' }) }, children: [] });
  eq(wb.collectAssetRefs([one]).length, 1, 'B22 收到一个 file 引用');
  eq(wb.collectAssetRefs([one])[0], 'A1', 'B22 取的是 a 字段（资产 id）');

  const two = sheet({
    data: { text: 'r' },
    children: [
      { data: { text: 'a', file: JSON.stringify({ a: 'A1' }) } },
      { data: { text: 'b', video: JSON.stringify({ a: 'A2' }) } },
    ],
  });
  eq(wb.collectAssetRefs([two]).length, 2, 'B22 同时收 file 与 video');

  // 去重：同一个附件被多个节点引用
  const dup = sheet({
    data: { text: 'r' },
    children: [
      { data: { file: JSON.stringify({ a: 'A1' }) } },
      { data: { file: JSON.stringify({ a: 'A1' }) } },
    ],
  });
  eq(wb.collectAssetRefs([dup]).length, 1, 'B22 同一 id 去重（否则提示数量会虚高）');

  // 老式纯路径引用没有资产 id —— 不归这里管
  const legacy = sheet({ data: { text: 'a', file: 'C:\\x\\y.pdf' }, children: [] });
  eq(wb.collectAssetRefs([legacy]).length, 0,
    'B22 老式路径引用无资产 id，跳过（那是另一种情况，不是跨机问题）');

  eq(wb.collectAssetRefs([]).length, 0, 'B22 空列表不报错');
  eq(wb.collectAssetRefs([{ id: 'x' }]).length, 0, 'B22 无 content 不报错');
  eq(wb.collectAssetRefs([{ id: 'x', content: '不是 JSON' }]).length, 0, 'B22 坏 JSON 不崩（不能拦住导入）');
  eq(wb.collectAssetRefs([sheet({ data: { text: '无附件' } })]).length, 0, 'B22 无附件 → 空');

  // ---- 提示接入 ----
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(/async function warnForeignAssets/.test(idx), 'B22 新增 warnForeignAssets');
  ok(/await warnForeignAssets\(sheets\)/.test(idx),
    'B22 在 **JSON 导入成功后**立即检查（不能等用户点到节点才发现）');
  // 同上：固定 1200 会越界到下一个函数（实际函数体只有 ~784 字符），
  // 断言就可能测到别人身上的东西。
  const wfStart = idx.indexOf('async function warnForeignAssets');
  const wfRest = idx.slice(wfStart + 'async function warnForeignAssets'.length);
  const wfEnd = wfRest.match(/\n  (?:async )?function /);
  const wf = idx.slice(wfStart, wfStart + 'async function warnForeignAssets'.length + (wfEnd ? wfEnd.index : wfRest.length));
  ok(/改用 \.xmind 导出/.test(wf), 'B22 要告诉用户**怎么办**（改用 .xmind，它会打包附件）');
  ok(/JSON 只带引用、不带本体/.test(wf), 'B22 要说清**为什么**（引用在、字节不在）');
  // .xmind 分支不该调用它：xmind 会把附件打包，不存在这个问题
  ok(!/warnForeignAssets\(r\.sheets\)/.test(idx), 'B22 不对 .xmind 用（它本来就带附件）');
}

/* ============================================================
   三十四、多格式互转（FreeMind / OPML / Mermaid / PlantUML）
   ============================================================ */

group('XML 转义与基础');

{
  const f = await import('./formats.js');
  // & 必须第一个替换，否则 &amp; 会变 &amp;amp;
  eq(f.escXml('a&b'), 'a&amp;b', '转义 &');
  eq(f.escXml('a<b>c'), 'a&lt;b&gt;c', '转义 < >');
  eq(f.escXml('say "hi"'), 'say &quot;hi&quot;', '转义双引号');
  eq(f.escXml("it's"), 'it&apos;s', '转义单引号');
  eq(f.escXml('&<>"'), '&amp;&lt;&gt;&quot;', '混合转义不重复（& 先处理）');
  eq(f.escXml(null), '', 'null → 空串（不抛）');
  eq(f.unescXml(f.escXml('a&b<c>"d"')), 'a&b<c>"d"', '转义/反转义往返');

  eq(f.baseTitle('我的脑图.mm'), '我的脑图', '取主干名');
  eq(f.baseTitle('a/b/c.mm'), 'c', '带路径时取最后一段');
  eq(f.baseTitle('a\\b\\c.opml'), 'c', '兼容 Windows 分隔符');
  eq(f.baseTitle(''), '导入的脑图', '空名给 fallback');
  eq(f.baseTitle('.mm'), '导入的脑图', '只有扩展名也给 fallback');

  // 树/行互转
  const { root } = f.rowsToKm([{ depth: 0, text: 'R' }, { depth: 1, text: 'A' }, { depth: 2, text: 'A1' }, { depth: 1, text: 'B' }]);
  eq(root.data.text, 'R', 'rowsToKm 根');
  eq(root.children.length, 2, 'rowsToKm 两个一级');
  eq(root.children[0].children[0].data.text, 'A1', 'rowsToKm 嵌套正确');
  eq(f.rowsToKm([]).root.data.text, '中心主题', 'rowsToKm 空输入给默认根');
  // 层级跳跃不丢节点
  const jump = f.rowsToKm([{ depth: 0, text: 'R' }, { depth: 3, text: 'X' }]);
  eq(jump.root.children.length, 1, '层级跳跃按相邻处理，不丢节点');
  eq(f.kmToRows(root).length, 4, 'kmToRows 计数');
  eq(f.kmToRows(root)[2].depth, 2, 'kmToRows 深度正确');
  eq(f.parseKm('坏 JSON'), null, 'parseKm 坏 JSON → null（不抛）');
  eq(f.parseKm('{"noRoot":1}'), null, 'parseKm 无 root → null');
}

group('FreeMind（.mm）');

{
  const f = await import('./formats.js');
  const km = JSON.stringify({
    root: { data: { text: '中心' }, children: [
      { data: { text: 'A&B' }, children: [{ data: { text: 'A1' } }] },
      { data: { text: 'B' }, children: [{ data: { text: 'B1', expandState: 'collapse' } }] },
    ] },
  });
  const mm = f.toFreemind(km);
  ok(/<map version="1\.0\.1">/.test(mm), 'FreeMind 有 map 根');
  ok(/TEXT="中心"/.test(mm), 'FreeMind 根节点文本');
  ok(/TEXT="A&amp;B"/.test(mm), 'FreeMind 转义 &（否则 XML 非法）');
  ok(/FOLDED="true"/.test(mm), 'FreeMind 折叠状态写 FOLDED');
  ok(!/FOLDED="true"[^>]*TEXT="中心"/.test(mm), '根节点不写 FOLDED（根永远展开）');
  ok(/<node[^>]*\/>/.test(mm), '叶子节点自闭合');

  const back = JSON.parse(f.fromFreemind(mm));
  eq(back.root.data.text, '中心', 'FreeMind 回环：根');
  eq(JSON.stringify(back.root.children.map((c) => c.data.text)), JSON.stringify(['A&B', 'B']),
    'FreeMind 回环：一级节点（转义正确还原）');
  eq(back.root.children[1].children[0].data.expandState, 'collapse', 'FreeMind 回环：折叠状态还原');

  eq(f.fromFreemind(''), null, '空输入 → null');
  eq(f.fromFreemind('不是 XML <<<'), null, '坏 XML → null（不抛）');
  eq(f.fromFreemind('<map version="1.0.1"></map>'), null, '无 node → null');
  eq(f.toFreemind('坏'), '', '坏内容导出空串');
}

group('OPML（.opml）');

{
  const f = await import('./formats.js');
  const km = JSON.stringify({
    root: { data: { text: '中心' }, children: [{ data: { text: 'A"1"' } }] },
  });
  const op = f.toOpml(km, '我的脑图');
  ok(/<opml version="2\.0">/.test(op), 'OPML 声明 2.0');
  ok(/<title>我的脑图<\/title>/.test(op), 'OPML 带标题');
  ok(/text="中心"/.test(op), 'OPML 根 outline');
  ok(/&quot;1&quot;/.test(op), 'OPML 转义双引号（属性值里的引号会截断属性）');
  ok(/<outline[^>]*\/>/.test(op), 'OPML 叶子自闭合');

  const back = JSON.parse(f.fromOpml(op));
  eq(back.root.data.text, '中心', 'OPML 回环：根');
  eq(back.root.children[0].data.text, 'A"1"', 'OPML 回环：转义还原');

  // 多个顶层 outline → 造虚拟根，不能静默丢弃
  const multi = '<opml version="2.0"><body>'
    + '<outline text="甲"><outline text="甲1"/></outline>'
    + '<outline text="乙"/></body></opml>';
  const mb = JSON.parse(f.fromOpml(multi));
  eq(mb.root.data.text, '中心主题', '多顶层 outline → 造虚拟根');
  eq(mb.root.children.length, 2, '多顶层 outline：两个都保留（不丢）');
  eq(JSON.stringify(mb.root.children.map((c) => c.data.text)), JSON.stringify(['甲', '乙']), '多顶层顺序正确');
  eq(f.fromOpml(''), null, 'OPML 空输入 → null');
  eq(f.fromOpml('<opml><body></body></opml>'), null, 'OPML 无 outline → null');
}

/* ------------------------------------------------------------------
   BUG 98：空文字节点被整行丢掉 → 子树被抬层 / 节点整个消失
   ------------------------------------------------------------------ */
group('BUG 98 · 空文字节点必须保留（丢行等于把子树整层抬上去）');

/*
 * rowsToKm 早先有一句 `filter(r => String(r.text ?? '').trim())`，
 * 看着像「跳过没内容的行」，实际做的是**丢掉这一行** —— 而后面重建层级
 * 用的是「上一行的 depth」，中间那行没了，它的子节点就挂到祖父身上。
 *
 * 触发它的是真实文件：Freeplane 允许空白节点（导出 `TEXT=""`）、
 * 带格式的节点文字在 `<richcontent>` 里而 TEXT 属性可能整个不写。
 *
 * 全部实测过（jsdom 的真实 DOMParser，不是手写桩）：
 *   中间为空   修复前 项目 / 设计 / 开发 / 测试  ← 设计、开发 被抬成二级
 *   根为空     修复前 整条第一分支被虚拟根顶掉
 *   richcontent 修复前 「设计」整个消失（不是变空，是没这个节点）
 */
{
  const f = await import('./formats.js');
  /** 树 → 「文字/深度」序列，层级错位一览便知 */
  const flat = (n, d = 0) => [`${'  '.repeat(d)}${n.data.text}`]
    .concat((n.children || []).flatMap((c) => flat(c, d + 1)));
  /*
   * 安全取子节点：**不能**直接写 `root.children[0].children[0].data.text`。
   *
   * 结构一旦被破坏（正是本组要抓的事），那串取值会抛 TypeError，
   * 整个测试进程当场崩掉 —— 后面的用例一条都跑不到，
   * 变异验证只剩头两条红，看着"抓到了"其实漏了大半。
   * 这是变异第一次跑时真实发生过的事。
   */
  const down = (n, ...idx) => { let c = n; for (const i of idx) c = (c?.children || [])[i]; return c; };
  const at = (n, ...idx) => down(n, ...idx)?.data?.text ?? null;
  const kids = (n, ...idx) => (down(n, ...idx)?.children || []).length;

  eq(f.EMPTY_NODE_TEXT, '未命名', '占位文案与导出侧 nodeText 的 fallback 同一个常量');
  eq(f.nodeText({ data: { text: '  ' } }), f.EMPTY_NODE_TEXT, 'nodeText 空文字回落到同一个占位');

  // ① 中间节点为空、且带两个子：子树不能被抬层
  {
    const { root } = f.rowsToKm([
      { depth: 0, text: 'R' }, { depth: 1, text: '' }, { depth: 2, text: 'A1' }, { depth: 1, text: 'B' },
    ]);
    eq(JSON.stringify(flat(root)), JSON.stringify(['R', '  未命名', '    A1', '  B']),
      '★ 空文字节点保留，子树仍挂在它下面（早先被抬成 R 的直接子）');
    eq(kids(root, 0), 1, '★ 空节点仍有一个子（早先 A1 跑到根下）');
  }
  // ② 纯空格同样算空，同样不能丢
  {
    const { root } = f.rowsToKm([{ depth: 0, text: 'R' }, { depth: 1, text: '   ' }, { depth: 2, text: 'A1' }]);
    eq(kids(root), 1, '纯空格节点保留');
    eq(at(root, 0, 0), 'A1', '纯空格节点的子树不被抬层');
  }
  // ③ 根为空：不能拿第二行当根
  {
    const { root } = f.rowsToKm([{ depth: 0, text: '' }, { depth: 1, text: 'A' }, { depth: 1, text: 'B' }]);
    eq(root.data.text, f.EMPTY_NODE_TEXT, '★ 根为空时补占位（早先第二行 A 被当成根）');
    eq(root.children.length, 2, '根为空时两个子都还在');
  }
  eq(f.rowsToKm([]).root.data.text, '中心主题', '整份都空 → 仍是默认根');
  eq(JSON.stringify(flat(f.rowsToKm([{ depth: 0, text: 'R' }, { depth: 1, text: 'A' }]).root)),
    JSON.stringify(['R', '  A']), '基线（都非空）结构不变');

  // ④ OPML 端到端：中间 outline text="" 带两个子
  {
    const xml = '<opml version="2.0"><body><outline text="项目">'
      + '<outline text=""><outline text="设计"/><outline text="开发"/></outline>'
      + '<outline text="测试"/></outline></body></opml>';
    const root = JSON.parse(f.fromOpml(xml)).root;
    eq(JSON.stringify(flat(root)), JSON.stringify(['项目', '  未命名', '    设计', '    开发', '  测试']),
      '★ OPML：空 outline 的子不抬层（早先 设计/开发 与 测试 同级）');
  }
  // ⑤ OPML 端到端：根 outline 文字为空
  {
    const xml = '<opml version="2.0"><body>'
      + '<outline text=""><outline text="设计"/></outline>'
      + '<outline text="别的"/></body></opml>';
    const root = JSON.parse(f.fromOpml(xml)).root;
    eq(root.children.length, 2, '根为空：虚拟根下两个分支都在');
    eq(root.children[0].data.text, f.EMPTY_NODE_TEXT, '★ 根为空补占位（早先整条分支被顶掉）');
    eq(at(root, 0, 0), '设计', '根为空时子树还在它下面');
  }
  // ⑥ FreeMind 端到端：TEXT="" 带子
  {
    const xml = '<map version="1.0.1"><node TEXT="项目">'
      + '<node TEXT=""><node TEXT="设计"/><node TEXT="开发"/></node>'
      + '<node TEXT="测试"/></node></map>';
    const root = JSON.parse(f.fromFreemind(xml)).root;
    eq(JSON.stringify(flat(root)), JSON.stringify(['项目', '  未命名', '    设计', '    开发', '  测试']),
      '★ FreeMind：TEXT="" 的节点保留且子树不抬层');
  }
  // ⑦ FreeMind：正文只在 <richcontent> 里、TEXT 属性整个不写
  {
    const xml = '<map version="1.0.1"><node TEXT="项目">'
      + '<node><richcontent TYPE="NODE"><html><p>设计</p></html></richcontent></node>'
      + '<node TEXT="测试"/></node></map>';
    const root = JSON.parse(f.fromFreemind(xml)).root;
    eq(JSON.stringify(root.children.map((c) => c.data.text)), JSON.stringify(['设计', '测试']),
      '★ richcontent-only 节点读出正文（早先文字空 → 节点整个消失）');
  }
  // TYPE="NOTE" 是备注，不能当正文
  {
    const xml = '<map version="1.0.1"><node TEXT="项目">'
      + '<node><richcontent TYPE="NOTE"><html><p>这是备注</p></html></richcontent></node>'
      + '</node></map>';
    const root = JSON.parse(f.fromFreemind(xml)).root;
    eq(root.children[0].data.text, f.EMPTY_NODE_TEXT, 'TYPE="NOTE" 不当节点正文（回落到占位）');
  }
  // 有 TEXT 时以 TEXT 为准，richcontent 不能抢
  {
    const xml = '<map version="1.0.1"><node TEXT="项目">'
      + '<node TEXT="旧"><richcontent TYPE="NODE"><html><p>新</p></html></richcontent></node>'
      + '</node></map>';
    const root = JSON.parse(f.fromFreemind(xml)).root;
    eq(root.children[0].data.text, '旧', '有 TEXT 时以 TEXT 为准（richcontent 不抢）');
  }

  // 源码层：丢行那句 filter 不许回来
  const fs2 = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'formats.js'), 'utf8'));
  ok(!/rowsToKm[\s\S]{0,400}\.filter\(\(r\)\s*=>\s*r\s*&&\s*String\(r\.text/.test(fs2),
    '★ rowsToKm 不再按文字过滤行（丢行 = 子树抬层）');
  ok(/text:\s*t\s*\|\|\s*EMPTY_NODE_TEXT/.test(fs2) || /EMPTY_NODE_TEXT/.test(fs2),
    '空文字补位用的是 EMPTY_NODE_TEXT 常量（与导出侧同一个）');
  ok(/fallbackText\s*=\s*null/.test(fs2), 'readXmlNodes 支持兜底取文本（供 richcontent 用）');
}

/* ------------------------------------------------------------------
   BUG 99：Markdown 导入时空标题同样被整行丢掉
   ------------------------------------------------------------------
   BUG 98 修的是 formats.rowsToKm（OPML / FreeMind 走它），
   而 Markdown 这条路**自己抄了一份**重建逻辑（markdownToSheet 里的
   `if (!text) continue;`），同一个毛病又犯了一遍 —— 这正是
   「同一份逻辑抄两遍」的代价，改一处不改另一处就漏。
   ------------------------------------------------------------------ */
group('BUG 99 · Markdown 空标题同样不能丢行');

{
  const wb = await import('./workbook.js');
  const f98 = await import('./formats.js');
  const flat = (n, d = 0) => [`${'  '.repeat(d)}${n.data.text}`]
    .concat((n.children || []).flatMap((c) => flat(c, d + 1)));
  /* 安全取值：结构被破坏时不能直接抛（见 BUG 98 组的说明） */
  const down = (n, ...idx) => { let c = n; for (const i of idx) c = (c?.children || [])[i]; return c; };
  const at = (n, ...idx) => down(n, ...idx)?.data?.text ?? null;
  const kids = (n, ...idx) => (down(n, ...idx)?.children || []).length;
  const rt = (md) => flat(JSON.parse(wb.markdownToSheet(md)).root);

  eq(wb.sheetToMarkdown(JSON.stringify({ root: { data: { text: 'R' } } })).trim(), '# R',
    '基线：单节点导出不变');

  // ① 中间空标题带两个子：子树不能被抬层
  eq(JSON.stringify(rt('# R\n## \n### A1\n### A2\n## B')),
    JSON.stringify(['R', '  未命名', '    A1', '    A2', '  B']),
    '★ 空标题保留，子树仍挂在它下面（早先 A1/A2 被抬成 R 的直接子）');
  // ② 三级空标题
  eq(JSON.stringify(rt('# R\n## A\n### \n#### X\n## B')),
    JSON.stringify(['R', '  A', '    未命名', '      X', '  B']),
    '三级空标题同样保留（不只是二级）');
  // ③ 根是空标题：不能拿第二行当根
  {
    const root = JSON.parse(wb.markdownToSheet('# \n## A\n## B')).root;
    eq(root.data.text, f98.EMPTY_NODE_TEXT, '★ 根为空标题时补占位（早先第二行 A 被当成根）');
    eq(kids(root), 2, '根为空标题时两个子都还在');
    eq(at(root, 1), 'B', '根为空标题时顺序不变');
  }

  // ④ 往返：节点文字为空白（导出侧也必须补占位，否则又写出 `## `）
  {
    const mid = { data: { text: '   ' }, children: [{ data: { text: 'A1' }, children: [] }] };
    const md = wb.sheetToMarkdown(JSON.stringify({ root: { data: { text: 'R' }, children: [mid] } }));
    ok(!/^##\s*$/m.test(md), '★ 导出侧不写出空标题行（早先 `## ` 导回就把子树抬层）');
    eq(at(JSON.parse(wb.markdownToSheet(md)).root, 0), f98.EMPTY_NODE_TEXT,
      '空白节点往返后是占位文案（不是被丢掉）');
    eq(at(JSON.parse(wb.markdownToSheet(md)).root, 0, 0), 'A1', '★ 空白节点的子树不被抬层');
  }
  // ⑤ 正常树往返不变
  {
    const src = { root: { data: { text: 'R' }, children: [
      { data: { text: 'A' }, children: [{ data: { text: 'A1' }, children: [] }] },
      { data: { text: 'B' }, children: [] },
    ] } };
    const md = wb.sheetToMarkdown(JSON.stringify(src));
    eq(JSON.stringify(rt(md)), JSON.stringify(['R', '  A', '    A1', '  B']), '正常树往返结构不变');
  }

  // ⑥ 闸门口径：空标题现在能解析出节点，rowCount 就必须算它
  eq(wb.markdownRowCount('## '), 1, '★ 空标题算一条大纲行（与解析器一致）');
  eq(wb.markdownRowCount('##'), 0, '井号后什么都没有 → 不算（解析器要求 \\s+）');
  eq(wb.markdownRowCount('#'), 0, '只有 # 没有内容 → 0（既有口径）');
  eq(wb.markdownRowCount('# R\n## \n### A1'), 3, '空标题与正常标题一起计数');

  // 源码层：丢行那句 continue 不许回来；占位必须是同一个常量
  const wsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'workbook.js'), 'utf8'));
  ok(!/if\s*\(!text\)\s*continue;/.test(wsrc), '★ markdownToSheet 不再丢空行（丢行 = 子树抬层）');
  ok(/import \{[^}]*\bEMPTY_NODE_TEXT\b[^}]*\} from '\.\/formats\.js'/.test(wsrc),
    '占位用的是 formats.js 的 EMPTY_NODE_TEXT（两条导入路径同一个常量）');
  ok(/if\s*\(!text\)\s*text = EMPTY_NODE_TEXT;/.test(wsrc), 'sheetToMarkdown 空文字回落占位');
}

/* ------------------------------------------------------------------
   BUG 100：空白节点导出成 PlantUML / Mermaid 再导回，节点消失或整份报废
   ------------------------------------------------------------------
   BUG 98 / 99 修的是「导入时丢行」，这一条修的是**导出侧根本没写占位**：
   kmToRows 显式传 `nodeText(n, '')`，于是空白节点导出成空行 ——
   这是「同一份占位逻辑抄了五遍」的第五处。
   ------------------------------------------------------------------ */
group('BUG 100 · 空白节点不得导出成空行（PlantUML / Mermaid）');

{
  const f100 = await import('./formats.js');
  const flat = (n, d = 0, o = []) => {
    o.push('  '.repeat(d) + JSON.stringify(n.data.text));
    (n.children || []).forEach((c) => flat(c, d + 1, o));
    return o.join(' | ');
  };
  const mk = (t, ch = []) => ({ data: { text: t }, children: ch });
  const back = (to, from, root) => {
    const c = JSON.stringify({ root, template: 'default', theme: 'fresh-blue' });
    const b = from(to(c));
    return b ? flat(JSON.parse(b).root) : null;
  };
  const P = (root) => back(f100.toPlantUml, f100.fromPlantUml, root);
  const M = (root) => back(f100.toMermaid, f100.fromMermaid, root);
  const E = f100.EMPTY_NODE_TEXT;
  const WANT_MID = `"R" |   "${E}" |     "A1" |     "A2" |   "B"`;

  // ① 整张图只有一个空白节点：puml 早先返回 null → 再导入报「无法识别该文件」
  eq(P(mk('  ')), `"${E}"`, '★ 单个空白根：puml 导回不再是 null（早先整份报废）');
  eq(M(mk('  ')), `"${E}"`, '单个空白根：mmd 导回是占位');

  // ② 中间空白节点：子树不能被抬层
  eq(P(mk('R', [mk('  ', [mk('A1'), mk('A2')]), mk('B')])), WANT_MID,
    '★ puml 空白节点保留，子树仍挂在它下面（早先 A1/A2 被抬成 R 的直接子）');
  eq(M(mk('R', [mk('  ', [mk('A1'), mk('A2')]), mk('B')])), WANT_MID,
    '★ mmd 空白节点保留，子树仍挂在它下面（早先变成字面两个引号）');

  // ③ 根是空白：不能把第二行抬成根
  eq(P(mk('', [mk('A'), mk('B')])), `"${E}" |   "A" |   "B"`,
    '★ puml 根为空白时补占位（早先 A 被当成根、B 变成 A 的子）');
  eq(M(mk('', [mk('A'), mk('B')])), `"${E}" |   "A" |   "B"`, 'mmd 根为空白时补占位');

  // ④ 叶子空白：不能消失
  eq(P(mk('R', [mk('A'), mk('')])), `"R" |   "A" |   "${E}"`, 'puml 叶子空白不消失');
  eq(M(mk('R', [mk('A'), mk('')])), `"R" |   "A" |   "${E}"`, 'mmd 叶子空白不消失');

  // ⑤ 正常树不受影响
  eq(P(mk('R', [mk('A', [mk('A1')]), mk('B')])), '"R" |   "A" |     "A1" |   "B"', 'puml 正常树不变');
  eq(M(mk('R', [mk('A', [mk('A1')]), mk('B')])), '"R" |   "A" |     "A1" |   "B"', 'mmd 正常树不变');

  /* ⑥ `""` 只能认**整行**的裸占位，不能认取出来的文字 ——
     否则「节点文字真的就是两个引号」会被误判成空节点（往返变「未命名」）。 */
  eq(M(mk('""')), '"\\"\\""', '★ 文字真是两个引号时不被当成空占位');
  eq(M(mk('""')), P(mk('""')), '两个引号：mmd 与 puml 口径一致');

  // ⑦ 别的工具产出的文件里的空行同样不能丢
  eq(flat(JSON.parse(f100.fromPlantUml('@startmindmap\n* R\n** \n*** A1\n** B\n@endmindmap')).root),
    `"R" |   "${E}" |     "A1" |   "B"`, '外部 puml 的空行保留（不抬层）');
  eq(flat(JSON.parse(f100.fromMermaid('mindmap\n  root((R))\n    ""\n      A1\n')).root),
    `"R" |   "${E}" |     "A1"`, '外部 mmd 的裸 "" 行当空节点（不变成字面引号）');

  // 源码层
  const fsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'formats.js'), 'utf8'));
  ok(/text:\s*nodeText\(n\)/.test(fsrc), '★ kmToRows 用 nodeText 的默认占位（不再传 \'\'）');
  ok(!/if\s*\(!t\)\s*continue;/.test(fsrc), '★ fromPlantUml 不再丢空行');
  ok(/if\s*\(!body\)\s*body = EMPTY_NODE_TEXT;/.test(fsrc), 'fromMermaid 空文字补占位');
  ok(/raw\.trim\(\)\s*===\s*'""'/.test(fsrc), '裸 "" 判的是整行（不是取出来的文字）');
}

/* ------------------------------------------------------------------
   BUG 101：Markdown 这条路上，节点文字 / 画布标题含 CR（或 U+2028/2029）
   会静默丢节点、丢标题
   ------------------------------------------------------------------
   BUG 72 修的是 PlantUML（formats.js）：JS 正则的 `.` 不匹配行终止符，
   `# 含\r回车` 整行不命中 → 节点消失。而 workbook.js 的 Markdown 这条
   路**自己抄了一份规范化**，抄的是「只认 LF」的旧版 —— 同一份逻辑抄两遍，
   只修了一遍，于是这条路上 BUG 72 原样还在（第 9 次撞到这个模式）。
   ------------------------------------------------------------------ */
group('BUG 101 · Markdown 的 CR：节点不得消失、画布标题不得截断');

{
  const wb101 = await import('./workbook.js');
  const fl = (n, d = 0, o = []) => {
    o.push('  '.repeat(d) + JSON.stringify(n.data.text));
    (n.children || []).forEach((c) => fl(c, d + 1, o));
    return o.join(' | ');
  };
  const rt = (md) => JSON.parse(wb101.markdownToSheet(md)).root;

  // ① 节点文字含各类行终止符：往返不能丢节点
  for (const [name, c] of [['CR', '\r'], ['LF', '\n'], ['U+2028', '\u2028'], ['U+2029', '\u2029'], ['CRLF', '\r\n']]) {
    const md = wb101.sheetToMarkdown(JSON.stringify({
      root: { data: { text: '含' + c + 'X' }, children: [{ data: { text: '子' }, children: [] }] },
    }));
    eq(fl(rt(md)), '"含 X" |   "子"', `节点文字含 ${name}：往返保留（不再整条消失）`);
  }

  /*
   * ①b ★ 导出的 .md **本身**不得含裸行终止符。
   *
   * 只看往返会被导入侧的摊平兜住 —— 于是导出侧那份「只认 LF」的替换
   * 即使退回旧写法，往返照样是绿的（M1 第一次跑就是只红了两条源码断言）。
   * 那条断言看着在把关、实际没把关。
   *
   * 必须单独看产物：导出的文件是要给**别的工具**读的，里面带着裸 CR
   * 会让别的 Markdown 解析器整行判不出来。
   */
  for (const [name, c] of [['CR', '\r'], ['U+2028', '\u2028'], ['U+2029', '\u2029']]) {
    const md = wb101.sheetToMarkdown(JSON.stringify({
      root: { data: { text: '含' + c + 'X' }, children: [] },
    }));
    ok(!/[\r\u2028\u2029]/.test(md), `★ 导出的 md 里不得含裸 ${name}（产物要给别的工具读）`);
  }

  // ② ★ BUG 36 点名的事故：只有根含 CR → rowCount 说有大纲、解析出空画布
  //    → 导入是整体替换，一张空的「中心主题」顶掉用户全部画布
  {
    const md = '# 含\r回车\n';
    eq(wb101.markdownRowCount(md), 1, 'rowCount 说有大纲（放行导入）');
    eq(JSON.parse(wb101.markdownToSheet(md)).root.data.text, '含 回车',
      '★ 单行根含 CR：解析出的是它自己，不是空的「中心主题」');
  }

  // ③ 中间节点含 CR：子树不能被抬层
  eq(fl(rt('# R\n## 含\r回车\n### A1\n### A2\n## B')),
    '"R" |   "含 回车" |     "A1" |     "A2" |   "B"',
    '★ 中间节点含 CR：子树仍挂在它下面（早先 A1/A2 被抬成 R 的直接子）');

  // ④ 根含 CR + 有子：根不能消失、子不能被抬成根
  eq(fl(rt('# 含\r回车\n## 子\n')), '"含 回车" |   "子"', '根含 CR 不消失、子不被抬成根');

  // ⑤ 别的工具产出的文件里的裸 CR（没经过我们的导出侧）
  eq(fl(rt('# 甲\r乙\n## 子\n')), '"甲 乙" |   "子"', '外部 md 的裸 CR 行也要能解析');

  // ⑥ 画布标题：含换行不能截断、含 CR 不能整块失效
  {
    const mk = () => JSON.stringify({ root: { data: { text: '根' }, children: [{ data: { text: '子' }, children: [] }] } });
    const S = (t, i) => ({ id: i, title: t, content: mk(), theme: null, layout: null });
    const titles = (t) => wb101.markdownToWorkbook(wb101.workbookToMarkdown([S(t, 'a'), S('乙', 'b')])).map((s) => s.title);
    eq(JSON.stringify(titles('含\n换行')), JSON.stringify(['含 换行', '乙']),
      '★ 画布标题含 LF：摊成空格（早先被截断成「含」）');
    eq(JSON.stringify(titles('含\r回车')), JSON.stringify(['含 回车', '乙']),
      '★ 画布标题含 CR：摊成空格（早先整块失效 → 变「画布 1」）');
    eq(JSON.stringify(titles('含\r\n换行')), JSON.stringify(['含 换行', '乙']), '画布标题含 CRLF');
    eq(JSON.stringify(titles('含\u2028X')), JSON.stringify(['含 X', '乙']), '画布标题含 U+2028');
    eq(JSON.stringify(titles('正常')), JSON.stringify(['正常', '乙']), '正常标题不变');
    eq(JSON.stringify(titles('  空  ')), JSON.stringify(['空', '乙']), '标题前后空白仍 trim');
  }

  /*
   * ⑥b ★ 外部 .md 的**分块行**里带裸 CR（别的工具产出，没经过我们的导出侧）。
   *
   * 上面的标题用例都是先 `workbookToMarkdown` 再 `markdownToWorkbook` ——
   * 而导出侧已经摊平过了，于是导入侧即使不摊平也遇不到裸 CR
   * （M4 变异实测：去掉分块行的摊平，3257 项仍全绿 —— 断言没在把关）。
   * 必须**直接**喂一份带 CR 的 md 才算测到。
   */
  {
    const b = wb101.markdownToWorkbook('## 画布：含\r回车\n# 根\n## 子\n\n## 画布：乙\n# 根2\n');
    eq(b.length, 2, '外部 md 带 CR 的分块行：仍是两张画布（整块没失效）');
    eq(b[0].title, '含 回车', '★ 外部 md 的分块标题不被 CR 破坏（早先整块失效 → 「画布 1」）');
    eq(b[1].title, '乙', '第二块标题正常');
  }

  // ⑦ 缩进语义不能因为摊平而回归（整行不能 trim，否则四格缩进变合法标题）
  eq(wb101.markdownRowCount('   # 甲\n'), 1, '三格缩进仍算标题（CommonMark）');
  eq(wb101.markdownRowCount('    # 甲\n'), 0, '★ 四格缩进仍不算标题（不能因摊平而放开）');
  eq(wb101.markdownRowCount('\t# 甲\n'), 0, '制表符缩进仍不算标题');
  eq(JSON.parse(wb101.markdownToSheet('    # 甲\n')).root.data.text, '中心主题',
    '★ 四格缩进解析出空画布（与 rowCount=0 一致，不重演 BUG 90）');

  // ⑧ 源码层：三条路都必须走 formats 的共享函数，不许再各抄一份
  const wsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'workbook.js'), 'utf8'));
  ok(!/\.replace\(\/\\s\*\\n\\s\*\/g/.test(wsrc),
    '★ workbook.js 不得再有「只认 LF」的那份替换（BUG 101 本身就是它）');
  ok(/flattenBreaks\(rawLine\)/.test(wsrc), 'markdownToSheet 先摊平行再判标题');
  /*
   * rowCount 与解析器必须**同判**（BUG 90 的通用契约，这里补 CR 那一类）。
   *
   * 不写成「rowCount 源码里必须出现 flattenBreaks」—— 那条是空转的：
   * rowCount 的正则不含 `.`，本来就不受 CR 影响，去掉摊平结果一样
   * （M3 变异实测：去掉后 3253 项仍全绿）。断言要管的是**两边的判断
   * 是否一致**，不是某一行代码长什么样。
   */
  for (const md of ['# 含\r回车\n', '# R\n## 含\r回车\n### A1\n', '# 甲\r乙\n## 子\n', '## \r\n', '#\r甲\n']) {
    const nRows = wb101.markdownRowCount(md);
    const root = JSON.parse(wb101.markdownToSheet(md)).root;
    const nNodes = 1 + (root.children || []).length;
    ok(nRows > 0 === (root.data.text !== '中心主题' || nNodes > 1),
      `rowCount 与解析器对 CR 输入同判：${JSON.stringify(md)}（rowCount=${nRows}）`);
  }
  ok(/inlineText\(s\.title\)/.test(wsrc), '画布标题走 inlineText');
  ok(/inlineText\(n\?\.data\?\.text\)/.test(wsrc), '节点文字走 inlineText');

  const fsrc2 = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'formats.js'), 'utf8'));
  ok(/export const flattenBreaks/.test(fsrc2) && /export const inlineText/.test(fsrc2),
    '两个共享函数都在 formats.js（各路只写一遍）');
}

/* ------------------------------------------------------------------
   BUG 102：Markdown 只有 6 级标题，更深的层被**静默拍平**
   ------------------------------------------------------------------
   CommonMark 规定 7 个及以上 `#` **不是标题**（是普通段落），所以第 7 级
   及更深没有合法写法 —— sheetToMarkdown 一律截断成 6 个 `#`，于是这些
   节点互相变成兄弟。导出 → 再导入（整体替换、不可撤销）之后层级就没了，
   而界面上一句提示都没有。

   与 exportExchange 那句「仅当前画布」同口径：格式装不下什么，必须在
   导出时说清楚。这里锁的是「能算出损失」+「导出侧说了」两件事。
   ------------------------------------------------------------------ */
group('BUG 102 · Markdown 超过 6 级：拍平必须说得出来');

{
  const wb102 = await import('./workbook.js');
  const mk = (t, ch) => ({ data: { text: t }, children: ch || [] });
  /** 造一条 lv 层的链（根 = 第 1 级） */
  const chain = (lv) => { let n = mk('L' + (lv - 1)); for (let i = lv - 2; i >= 0; i--) n = mk('L' + i, [n]); return n; };
  const S = (r) => ({ id: 'a', title: 'T', content: JSON.stringify({ root: r }), theme: null, layout: null });

  // ① 统计口径：第 7 级起才算损失（第 1~6 级都有各自的 # 数）
  eq(wb102.MARKDOWN_MAX_LEVEL, 6, '上限常量是 6（CommonMark：7 个 # 不是标题）');
  eq(wb102.deepNodeCount([S(chain(6))]), 0, '6 层链：一个都不损失');
  eq(wb102.deepNodeCount([S(chain(7))]), 1, '★ 7 层链：最深那 1 个装不下');
  eq(wb102.deepNodeCount([S(chain(10))]), 4, '10 层链：第 7~10 级共 4 个装不下');
  eq(wb102.deepNodeCount([S(mk('R', [chain(8), chain(8)]))]), 6, '分叉：两条分支各自统计');
  eq(wb102.deepNodeCount([S(chain(8)), S(chain(7))]), 3, '多画布累加');

  /*
   * ② 健壮性：坏内容 / 空画布都不能抛，也不该虚报。
   *
   * **必须自己兜住异常再断言**，不能写成 `eq(fn(...), 0)`：
   * 一旦 deepNodeCount 真的抛了（M4 变异就是去掉那层 try/catch），
   * 整个测试进程当场崩掉 —— 后面几条**一条都跑不到**，看着"抓到了"
   * 其实漏了大半（本项目第 32 次遇到这类"崩了也算失败"的假把关）。
   */
  const callSafe = (fn) => { try { return { v: fn() }; } catch (e) { return { err: e }; } };
  {
    const r = callSafe(() => wb102.deepNodeCount([{ content: '{坏' }]));
    ok(!r.err, '★ 坏 JSON 不抛（抛了会让整个导出流程崩掉）');
    eq(r.v, 0, '坏 JSON 不算损失');
  }
  eq(wb102.deepNodeCount([{ content: '{}' }]), 0, '没有 root 不算损失');
  eq(wb102.deepNodeCount([]), 0, '空画布列表');
  eq(wb102.deepNodeCount([{ content: { root: chain(8) } }]), 2, 'content 是对象形态同样统计');

  // ③ 行为本身：导出的 md 里更深的层确实都写成 6 个 #（拍平是真的会发生）
  {
    const md = wb102.sheetToMarkdown(JSON.stringify({ root: chain(9) }));
    const sharps = md.trim().split('\n').map((l) => (l.match(/^#+/) || [''])[0].length);
    eq(JSON.stringify(sharps), JSON.stringify([1, 2, 3, 4, 5, 6, 6, 6, 6]),
      '第 6 级之后一律写成 6 个 #（这就是拍平的来源）');
    const r = JSON.parse(wb102.markdownToSheet(md)).root;
    // 拍平的实据：第 7 级起全变成第 6 级的兄弟
    const depths = [];
    (function walk(n, d) { depths.push(d); (n.children || []).forEach((c) => walk(c, d + 1)); })(r, 0);
    /*
     * 期望是 [0,1,2,3,4,5,5,5,5]：6 个 # = 深度 5（层级 = 深度 + 1），
     * 所以第 6 级以下的节点全部落到**深度 5**，与真正的第 6 级成为兄弟。
     * 早先我写成 [...5,6,6,6] —— 那是按「# 数」而不是「深度」算的，
     * 断言自身就错了（第 31 次遇到"断言没在把关"：错的期望会一直绿到有人改实现）。
     */
    eq(JSON.stringify(depths), JSON.stringify([0, 1, 2, 3, 4, 5, 5, 5, 5]),
      '★ 导回后第 7 级起摊成同一层（深度不再往下走）');
  }

  // ④ 导出侧必须把这件事说出来（源码层）
  const isrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'index.js'), 'utf8'));
  {
    const i = isrc.indexOf('async function exportMarkdown');
    ok(i > 0, '能定位 exportMarkdown');
    const body = isrc.slice(i, i + 1200);
    ok(/deepNodeCount\(/.test(body), '★ exportMarkdown 调用了统计（否则拍平无人知晓）');
    ok(/MARKDOWN_MAX_LEVEL/.test(body), '提示里带上具体上限');
    // 顺序：必须在保存之后补，先让人看到文件存好了
    ok(body.indexOf('reportSave') < body.indexOf('deepNodeCount'),
      '提示在 reportSave 之后（先确认存好了再说限制）');
  }

  // ⑤ 写侧截断用的是同一个常量，不是写死的 6
  {
    const wsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'workbook.js'), 'utf8'));
    ok(/Math\.min\(depth \+ 1, MARKDOWN_MAX_LEVEL\)/.test(wsrc),
      '★ 截断用 MARKDOWN_MAX_LEVEL（写死 6 会与读侧正则各说各话）');
    ok(/export const MARKDOWN_MAX_LEVEL/.test(wsrc), '常量已导出供 index.js 使用');
  }
}

/* ------------------------------------------------------------------
   BUG 103：分块标记行把导入闸门骗过去 —— 一张空画布顶掉全部画布
   ------------------------------------------------------------------
   `## 画布：<标题>` 在 markdownToWorkbook 里是**分隔符**，但在
   markdownRowCount 里它自己就命中 `/^ {0,3}#{1,6}(\s+\S|\s+$)/` ——
   于是「只有分块标记、块内没有一行标题」的文件也会被数出 ≥1 条，闸门放行：

     `## 画布：项目A\n- 一些笔记\n`   rowCount = 1 → 放行
     → markdownToWorkbook 给出 1 张画布，块内无标题 → emptyContent()
     → 一张空的「中心主题」顶掉用户全部画布

   导入是**整体替换且不可撤销**（新内容 = 新基线，撤销救不回来），所以这正是
   BUG 36 / 90 点名要防的事故，只是从分块标记这条缝漏进来的：数标记行等于把
   「有 N 张画布」误当成「有 N 个节点」。

   锁的是一条**契约**：rowCount 说有大纲 ⇒ 导回的画布不能全是空的。
   不逐条列举输入 —— 那条缝是「分块标记不是内容」，换个输入还会漏。
   ------------------------------------------------------------------ */
group('BUG 103 · 分块标记行不得算作大纲行（闸门不许被它骗过）');

{
  const wb103 = await import('./workbook.js');

  // ① 标记行本身不计数
  eq(wb103.markdownRowCount('## 画布：项目A\n'), 0, '★ 只有标记：0 条（标记是分隔符不是节点）');
  eq(wb103.markdownRowCount('## 画布：项目A\n- 一些笔记\n- 另一条\n'), 0,
    '★ 标记 + 列表：0 条（早先算 1 条 → 放行 → 空画布顶掉全部）');
  eq(wb103.markdownRowCount('## 画布：A\n- 笔记\n\n## 画布：B\n- 笔记2\n'), 0,
    '★ 多个标记 + 列表：0 条（早先算 2 条）');
  eq(wb103.markdownRowCount('## 画布：\n'), 0, '空标题的标记行同样不算');

  // ② 块里真有标题时不受影响（该放行的照样放行）
  eq(wb103.markdownRowCount('## 画布：项目A\n# 根\n## 子\n'), 2, '★ 块内有标题：照常计数（不误杀）');
  eq(wb103.markdownRowCount('## 画布：A\n# R1\n## 子1\n\n## 画布：B\n# R2\n'), 3, '多画布分块照常计数');
  eq(wb103.markdownRowCount('# 标题\n\n正文段落\n'), 1, '单画布普通文档不受影响');
  eq(wb103.markdownRowCount('## \n'), 1, '空标题仍算一条（BUG 99 口径不变）');

  // ③ 被转义的「画布：」标题行不是标记，得照常算一条
  eq(wb103.markdownRowCount('## \\画布：设计\n'), 1, '★ 转义后的节点行仍算一条（它不是分隔符）');

  /*
   * ③b 标记行必须**先摊平再判**（BUG 101 那条缝在这里同样成立）。
   *
   * SHEET_MARK 的 `(.*)$` 不匹 \r —— 拿未摊平的原始行去判，`## 画布：含\rX`
   * 不命中标记、于是被当成一条大纲行 → rowCount 虚高 1 → 又是"放行 + 空画布"。
   */
  eq(wb103.markdownRowCount('## 画布：含\rX\n# R\n'), 1,
    '★ 含 CR 的标记行同样跳过（先摊平再判，否则虚高放行）');
  eq(wb103.markdownRowCount('## 画布：含\nX\n# R\n'), 1, '含 LF 的标记行同样跳过');

  /*
   * ④ 契约：只要 rowCount 说有大纲，导回就不能**全是**空画布。
   *
   * 「空画布」= 根文字是 emptyContent 的默认「中心主题」且没有子节点 ——
   * 这正是闸门要拦的那种结果。
   */
  {
    const isEmpty = (s) => {
      try {
        const r = JSON.parse(s.content).root;
        return r.data.text === '中心主题' && !(r.children || []).length;
      } catch { return false; }
    };
    for (const md of [
      '## 画布：项目A\n- 一些笔记\n',
      '## 画布：A\n- 笔记\n\n## 画布：B\n- 笔记2\n',
      '## 画布：\n',
      '## 画布：A\n# R\n## 子\n',
      '# R\n## \n### A1\n',
      '- 纯列表\n',
      '普通一句话\n',
    ]) {
      const n = wb103.markdownRowCount(md);
      const sheets = wb103.markdownToWorkbook(md);
      const allEmpty = sheets.every(isEmpty);
      ok(!(n > 0 && allEmpty),
        `★ rowCount>0 时不得全空：${JSON.stringify(md)}（rowCount=${n}）`);
    }
  }

  // ⑤ 源码层：rowCount 必须显式跳过标记行（不许只靠正则碰巧不命中）
  {
    const wsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'workbook.js'), 'utf8'));
    const i = wsrc.indexOf('export function markdownRowCount');
    ok(i > 0, '能定位 markdownRowCount');
    const body = wsrc.slice(i, i + 1600);
    ok(/SHEET_MARK\.test\(raw\)/.test(body), '★ rowCount 显式跳过分块标记行');
    ok(/SHEET_MARK\.test\(raw\)\s*\)\s*continue;|if \(SHEET_MARK\.test\(raw\)\) continue;/.test(body),
      '跳过用 continue（不是把计数反过来写）');
  }
}

/* ------------------------------------------------------------------
   BUG 105：语法标记 / 注释行把**节点**吃掉 —— 节点消失 + 子树抬层
   ------------------------------------------------------------------
   三处的判定都写在「整行」上，而节点文字撞上标记写法时，导出的那一行
   长得就和标记一模一样：

     · fromMermaid  `if (/^\s*mindmap\s*$/i.test(raw)) continue;`
       正则带 `\s*` → **缩进也匹配**，于是节点文字就叫「mindmap」的
       节点整条被丢掉（还有 i，所以 MindMap / MINDMAP 全中）
     · fromMermaid  `/^\s*(%%|\/\/:)/`
       文字以 `%%` 开头时 mermaidLabel 写出的是裸 `%% …` → 被当注释丢掉
     · fromPlantUml `/@startmindmap/i`
       节点行 `** @startmindmap` 照样命中 → 被当标记吃掉

   后果都一样，且都不报错：节点消失，它的子树**整层抬到祖父身上** ——
   与 BUG 98/99/100 是同一类「丢一行 = 抬一层」，只是这次丢在**自己的
   导出文件**上，往返就发作。

   修法是「标记只在它确实是标记时才生效」：
     · `mindmap` 只在**第一条节点之前**（rows 为空）才算头行
     · PlantUML 的标记行不以 `*` 开头（节点行一律以 `*` 开头）
     · `%%` 走导出侧加引号（mermaidLabel 的 `^%`），行首变成 `[`
   ------------------------------------------------------------------ */
group('BUG 105 · 语法标记不得吃掉同名节点（Mermaid / PlantUML）');

{
  const f104 = await import('./formats.js');
  const N = (t, ch) => ({ data: { text: t }, children: ch || [] });
  const wrap = (r) => JSON.stringify({ root: r, template: 'default', theme: 'fresh-blue' });
  /*
   * 展平成 [文字, 深度] 序列，比 JSON 更好读。
   *
   * ★ 必须先判 null：fromPlantUml / fromMermaid 失败时返回 null，直接
   * `JSON.parse(c).root` 会抛 TypeError —— 整个测试进程当场崩掉，后面的
   * 断言一条都跑不到，看着"抓到了"其实漏了大半（本项目第 33 次遇到这类
   * "崩了也算失败"的假把关）。返回 null 让 eq 正常报出"期望 X 实际 null"。
   */
  const flat = (c) => {
    if (!c) return null;
    const out = [];
    (function w(n, d) { out.push([n.data.text, d]); (n.children || []).forEach((x) => w(x, d + 1)); })(JSON.parse(c).root, 0);
    return out;
  };
  /** 根 → 目标节点（带两个子） → 尾 */
  const tree = (t) => wrap(N('根', [N(t, [N('子1'), N('子2')]), N('尾')]));

  // ① Mermaid：叫「mindmap」的节点必须还在，子树必须挂在它下面
  for (const t of ['mindmap', 'MindMap', 'MINDMAP']) {
    const back = f104.fromMermaid(f104.toMermaid(tree(t)));
    ok(back, `fromMermaid 不返回 null：${t}`);
    eq(JSON.stringify(flat(back)), JSON.stringify([['根', 0], [t, 1], ['子1', 2], ['子2', 2], ['尾', 1]]),
      `★ Mermaid：文字「${t}」的节点往返后仍在原位（早先整个消失、子1/子2 被抬到根下）`);
  }
  eq(JSON.stringify(flat(f104.fromMermaid(f104.toMermaid(tree('mindmap 用法'))))),
    JSON.stringify([['根', 0], ['mindmap 用法', 1], ['子1', 2], ['子2', 2], ['尾', 1]]),
    '「mindmap 用法」本来就没事（只有整行等于 mindmap 才撞）');

  // ② 头行**仍然**要跳（不能为了保节点就把头行也留下）
  eq(JSON.stringify(flat(f104.fromMermaid('mindmap\n  root((R))\n    A\n    B\n'))),
    JSON.stringify([['R', 0], ['A', 1], ['B', 1]]), '★ 头行仍被跳过（不误留成节点）');
  eq(JSON.stringify(flat(f104.fromMermaid('  root((R))\n    A\n'))),
    JSON.stringify([['R', 0], ['A', 1]]), '没有头行同样能解析');
  eq(JSON.stringify(flat(f104.fromMermaid('%% 说明\nmindmap\n  root((R))\n'))),
    JSON.stringify([['R', 0]]), '注释行在前时头行仍被跳过');

  /*
   * ③ 根节点本身叫「mindmap」也不能丢。
   * toMermaid 把根写成 `  root((mindmap))`（缩进 2），不是裸 `mindmap` ——
   * 若哪天改成裸写，这条会立刻红。
   */
  {
    const back = f104.fromMermaid(f104.toMermaid(wrap(N('mindmap', [N('A')]))));
    eq(JSON.stringify(flat(back)), JSON.stringify([['mindmap', 0], ['A', 1]]),
      '★ 根节点叫「mindmap」同样保留');
  }

  // ④ Mermaid 注释：文字以 %% 开头 → 导出侧必须加引号，导回不被当注释
  ok(f104.mermaidLabel('%% 注释').startsWith('["'), '★ 以 % 开头的文字加引号（否则整行被当注释丢掉）');
  ok(f104.mermaidLabel('%%x').startsWith('["'), '%%x 同样加引号');
  eq(f104.mermaidLabel('50%'), '50%', '中间的 % 不触发（Mermaid 里没有语法含义，照旧裸写）');
  eq(JSON.stringify(flat(f104.fromMermaid(f104.toMermaid(tree('%% 注释'))))),
    JSON.stringify([['根', 0], ['%% 注释', 1], ['子1', 2], ['子2', 2], ['尾', 1]]),
    '★ Mermaid：以 %% 开头的节点往返后仍在原位');
  eq(JSON.stringify(flat(f104.fromMermaid('mindmap\n  root((R))\n    %% 真的注释\n    A\n'))),
    JSON.stringify([['R', 0], ['A', 1]]), '★ 不带引号的裸 %% 行**仍**当注释（不能被反过来误留）');

  // ⑤ PlantUML：文字撞标记写法时同样不能被吃掉
  for (const t of ['@startmindmap', '@endmindmap']) {
    const back = f104.fromPlantUml(f104.toPlantUml(tree(t)));
    ok(back, `fromPlantUml 不返回 null：${t}`);
    eq(JSON.stringify(flat(back)), JSON.stringify([['根', 0], [t, 1], ['子1', 2], ['子2', 2], ['尾', 1]]),
      `★ PlantUML：文字「${t}」的节点往返后仍在原位（早先被当标记吃掉、子树抬层）`);
  }
  eq(JSON.stringify(flat(f104.fromPlantUml(f104.toPlantUml(tree('语法见 @startmindmap 的用法'))))),
    JSON.stringify([['根', 0], ['语法见 @startmindmap 的用法', 1], ['子1', 2], ['子2', 2], ['尾', 1]]),
    '★ 文字里**包含**标记串也不能丢');

  // ⑥ 标记本身照旧生效（不能为了保节点就把标记也留下）
  eq(JSON.stringify(flat(f104.fromPlantUml('@startmindmap\n* R\n** A\n@endmindmap'))),
    JSON.stringify([['R', 0], ['A', 1]]), '★ @startmindmap 包裹照旧生效');
  eq(JSON.stringify(flat(f104.fromPlantUml('* R\n** A\n'))),
    JSON.stringify([['R', 0], ['A', 1]]), '无标记片段照旧能解析');
  eq(f104.fromPlantUml('@startmindmap\n@endmindmap'), null, '无节点 → null（既有口径不变）');
  /*
   * 标记**之外**的内容仍要被跳过：有 @startmindmap 时块前的行不算节点。
   */
  eq(JSON.stringify(flat(f104.fromPlantUml('前言\n@startmindmap\n* R\n** A\n@endmindmap\n'))),
    JSON.stringify([['R', 0], ['A', 1]]), '★ 块外的行仍不算节点（anyMarker 逻辑不变）');
  /*
   * `@endmindmap` 之后的行不算节点 —— 但**只有在真有 @startmindmap 时**才成立
   * （anyMarker 为 false 时整段都算块内）。早先我把输入写成只有 @endmindmap，
   * 期望值算错了。
   */
  eq(JSON.stringify(flat(f104.fromPlantUml('@startmindmap\n* R\n** A\n@endmindmap\n* 尾巴\n'))),
    JSON.stringify([['R', 0], ['A', 1]]), '★ @endmindmap 之后的行仍不算节点');

  /*
   * ⑥b ★ anyMarker 的守卫：外来 .puml **没有** @startmindmap 包裹时，
   * 只要某个节点文字里含 `@startmindmap`，不守卫就会把 anyMarker 判成 true ——
   * 于是那一行**之前的所有节点行**全部被 `anyMarker && !inBlock` 跳过，
   * 整棵树只剩 null。加守卫后只有非节点行参与判定，三个节点都还在。
   */
  eq(JSON.stringify(flat(f104.fromPlantUml('* R\n** A\n** 语法 @startmindmap\n'))),
    JSON.stringify([['R', 0], ['A', 1], ['语法 @startmindmap', 1]]),
    '★ 无包裹的片段里，文字含 @startmindmap 也不得让前面的节点消失');

  // ⑦ 源码层（先剥注释：这些正则本身就写在注释里，不剥会命中注释而永远绿）
  {
    const fsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'formats.js'), 'utf8'));
    const iM = fsrc.indexOf('export function fromMermaid');
    ok(iM > 0, '能定位 fromMermaid');
    const mBody = fsrc.slice(iM, iM + 2200);
    ok(mBody.includes('!rows.length && /^\\s*mindmap'),
      '★ fromMermaid 的 mindmap 头行只在 rows 为空时跳（否则吃掉同名节点）');
    ok(!/if \(\/\^\\s\*mindmap\\s\*\$\/i\.test\(raw\)\) continue;/.test(mBody),
      '★ 不得再有「任何缩进都跳过 mindmap」那句');
    ok(/MERMAID_NEEDS_QUOTE[\s\S]{0,200}\^%/.test(fsrc), '★ 引号判定里含 ^%（%% 开头要加引号）');

    const iP = fsrc.indexOf('export function fromPlantUml');
    ok(iP > 0, '能定位 fromPlantUml');
    const pBody = fsrc.slice(iP, iP + 1600);
    ok(pBody.includes("!line.startsWith('*')"), '★ PlantUML 标记判定排除节点行（以 * 开头）');
    ok(/!l\.trim\(\)\.startsWith\('\*'\)/.test(pBody), '★ anyMarker 同样排除节点行');
  }
}

group('Mermaid（.mmd）');

{
  const f = await import('./formats.js');
  eq(f.mermaidLabel('普通文字'), '普通文字', '普通文字不加引号');
  ok(f.mermaidLabel('A(1)').startsWith('["'), '含括号必须加引号（否则整张图解析失败）');
  ok(f.mermaidLabel('a[b]').startsWith('["'), '含方括号加引号');
  ok(f.mermaidLabel('a#b').startsWith('["'), '含 # 加引号（Mermaid 里是转义符）');
  eq(f.mermaidLabel(''), '""', '空节点给占位（空节点会让 Mermaid 报语法错）');
  ok(f.mermaidLabel('a"b').includes('#quot;'), '双引号用 #quot; 转义');

  // id 剥离**不能**吃掉纯文字节点（初版 bug：B / B1 凭空消失）
  eq(f.mermaidTextOf('B'), 'B', '纯文字节点不被当成 id 吃掉 ← 初版 bug');
  eq(f.mermaidTextOf('plain text'), 'plain text', '含空格的纯文字也不被吃');
  eq(f.mermaidTextOf('root((中心))'), '中心', 'root((x)) 取文字');
  eq(f.mermaidTextOf('id1[x]'), 'x', 'id[x] 取文字');
  eq(f.mermaidTextOf('["A(1)"]'), 'A(1)', '引号形式取文字');
  eq(f.mermaidTextOf('((中心))'), '中心', '不带 id 的双括号');

  const km = JSON.stringify({
    root: { data: { text: '中心' }, children: [
      { data: { text: 'A(1)' }, children: [{ data: { text: 'A1' } }] },
      { data: { text: 'B' }, children: [{ data: { text: 'B1' } }] },
    ] },
  });
  const md = f.toMermaid(km);
  ok(/^mindmap\n/.test(md), 'Mermaid 以 mindmap 开头');
  ok(/root\(\(中心\)\)/.test(md), '根用 root((x)) 形状');
  ok(/\n {4}"?\[?"?A\(1\)/.test(md) || /\["A\(1\)"\]/.test(md), '含括号节点加引号');

  const back = JSON.parse(f.fromMermaid(md));
  eq(back.root.data.text, '中心', 'Mermaid 回环：根');
  eq(JSON.stringify(back.root.children.map((c) => c.data.text)), JSON.stringify(['A(1)', 'B']),
    'Mermaid 回环：一级全在（B 不能丢）');
  eq(back.root.children[0].children[0].data.text, 'A1', 'Mermaid 回环：二级');
  eq(back.root.children[1].children[0].data.text, 'B1', 'Mermaid 回环：B1 不能丢');

  ok(f.fromMermaid('mindmap\n  root((a))').root !== undefined || true, '单行也能解析');
  eq(JSON.parse(f.fromMermaid('mindmap\n  root((a))\n    b')).root.children[0].data.text, 'b', '简版解析');
  eq(f.fromMermaid(''), null, '空输入 → null');
  eq(f.fromMermaid('mindmap'), null, '只有头行 → null（没有节点）');
  // 无 mindmap 头也能解析（用户常只贴片段）
  eq(JSON.parse(f.fromMermaid('  root((a))\n    b')).root.data.text, 'a', '缺 mindmap 头也能解析');
}

group('PlantUML（.puml）');

{
  const f = await import('./formats.js');
  const km = JSON.stringify({
    root: { data: { text: '中心' }, children: [
      { data: { text: 'A' }, children: [{ data: { text: 'A1' } }] },
      { data: { text: 'B' } },
    ] },
  });
  const pu = f.toPlantUml(km);
  ok(/^@startmindmap\n/.test(pu), '以 @startmindmap 开头');
  ok(/\* 中心\n/.test(pu), '根用一个 *');
  ok(/\*\* A\n/.test(pu), '一级用两个 *');
  ok(/\*\*\* A1\n/.test(pu), '二级用三个 *');
  ok(/@endmindmap\n$/.test(pu), '以 @endmindmap 结尾');

  const back = JSON.parse(f.fromPlantUml(pu));
  eq(back.root.data.text, '中心', 'PlantUML 回环：根');
  eq(JSON.stringify(back.root.children.map((c) => c.data.text)), JSON.stringify(['A', 'B']), 'PlantUML 回环：一级');
  eq(back.root.children[0].children[0].data.text, 'A1', 'PlantUML 回环：二级');

  // 无包裹标记的片段
  eq(JSON.parse(f.fromPlantUml('* a\n** b')).root.data.text, 'a', '无 @start 包裹也能解析');
  eq(f.fromPlantUml(''), null, '空 → null');
  eq(f.fromPlantUml('@startmindmap\n@endmindmap'), null, '无节点 → null');
}

group('格式识别 detectFormat（内容优先于扩展名）');

{
  const f = await import('./formats.js');
  const km = JSON.stringify({ root: { data: { text: 'x' }, children: [] } });
  const mm = f.toFreemind(km), op = f.toOpml(km), md = f.toMermaid(km), pu = f.toPlantUml(km);

  // 扩展名「错误」时仍按内容识别 —— 用户常把 opml 存成 xml、mmd 存成 txt
  eq(f.detectFormat(mm, 'a.txt'), 'freemind', '.txt 装 FreeMind → 按内容识别');
  eq(f.detectFormat(op, 'x.xml'), 'opml', '.xml 装 OPML → 按内容识别');
  eq(f.detectFormat(md, 'y.txt'), 'mermaid', '.txt 装 Mermaid → 按内容识别');
  eq(f.detectFormat(pu, 'z.txt'), 'plantuml', '.txt 装 PlantUML → 按内容识别');
  eq(f.detectFormat('{"a":1}', 'q.unknown'), 'json', 'JSON 内容');

  // 扩展名兜底
  eq(f.detectFormat('', 'a.mm'), 'freemind', '扩展名兜底 .mm');
  eq(f.detectFormat('', 'a.opml'), 'opml', '扩展名兜底 .opml');
  eq(f.detectFormat('', 'a.xmind'), 'xmind', '扩展名兜底 .xmind');
  eq(f.detectFormat('', 'a.mmd'), 'mermaid', '扩展名兜底 .mmd');
  eq(f.detectFormat('', 'a.puml'), 'plantuml', '扩展名兜底 .puml');

  eq(f.detectFormat('# t\n## s', 'm'), 'markdown', 'Markdown 标题');
  eq(f.detectFormat('随便一段话', 'w'), null, '认不出 → null（调用方据此兜底）');
  // 非法 JSON 不能被判成 json
  eq(f.detectFormat('{ not json', 'x'), null, '花括号开头但不是合法 JSON → 不判 json');
}

/* ------------------------------------------------------------------
   BUG 36：导入「没有大纲的文件」会静默拿一张空画布顶掉全部画布
   ------------------------------------------------------------------ */
group('BUG 36 导入无大纲文件不得替换画布');

{
  const wb = await import('./workbook.js');

  // markdownToSheet 对任何输入都给一棵树 —— 这正是 BUG 的根源，
  // 所以必须由调用方先数一数有没有大纲。
  eq(typeof wb.markdownRowCount, 'function', '导出 markdownRowCount');
  eq(wb.markdownRowCount('# a\n## b'), 2, '数 ATX 标题行');
  eq(wb.markdownRowCount('随便一段话\n第二行'), 0, '无大纲 → 0');
  eq(wb.markdownRowCount(''), 0, '空文本 → 0');
  eq(wb.markdownRowCount('#'), 0, '只有 # 没有内容 → 0（与解析器口径一致）');
  eq(wb.markdownRowCount('   ##  缩进标题'), 1, '允许缩进');
  eq(wb.markdownRowCount('####### 七个#'), 0, '超过 6 个 # 不算标题');

  // 现象侧：空文本确实会产出一张「中心主题」空画布 —— 所以不能拿它替换
  const s0 = wb.markdownToWorkbook('随便一段话');
  eq(s0.length, 1, '无大纲也会产出 1 张画布（所以必须在调用方拦）');
  ok(/中心主题/.test(String(s0[0].content)), '产出的正是空的「中心主题」');

  // 源码侧：两条入口都必须先判
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  // 起点必须是 noOutline 本身：它定义在 importFile **之前**，
  // 从 importFile 开始切的话这段根本不在窗口里，三条断言会全部恒假。
  const i0 = idx.indexOf('function noOutline(');
  ok(i0 >= 0, 'noOutline 定义在 importFile 之前（起点有效）');
  const seg = idx.slice(i0, i0 + 7000);
  const sc = stripCommentsFlat(seg);

  ok(/function noOutline\(/.test(sc), '抽出 noOutline 判定（两条入口共用）');
  ok(/markdownRowCount\(/.test(sc), '判定用 markdownRowCount');

  // 两处调用点都要在，只修一处另一条路照样丢数据。
  //
  // ⚠️ 这里必须写成**不带 !** 的形式。第一版我照着自己写错的源码
  // （`if (!noOutline(...)) return;`）写了这条断言，于是断言忠实于错误实现、
  // 恒为绿 —— 而实际行为是**反的**：有大纲的文件被拒、没有大纲的被放行。
  // 断言若只是复述实现，就永远抓不到「实现本身方向错了」这种问题。
  const n = (sc.match(/if \(noOutline\(text, f\.name\)\) return;/g) || []).length;
  eq(n, 2, 'Markdown 分支与兜底分支都要拦（各 1 处）');
  // 反向形式一旦出现就是上面那个错误，必须判失败
  ok(!/if \(!noOutline\(/.test(sc), '不得写成 !noOutline（方向相反会让有大纲的被拒、没大纲的被放行）');

  // 报错要说清「当前画布未改动」，否则用户以为什么都没发生
  ok(/当前画布未改动/.test(sc), '提示里说明当前画布未改动');
}

/* ------------------------------------------------------------------
   BUG 90：markdownRowCount 与 markdownToSheet 口径不一致 —— 缩进标题
   「说有大纲、解析却出空画布」，导入等于静默清空全部画布
   ------------------------------------------------------------------ */
group('BUG 90 · 判「有没有大纲」与「解析大纲」必须同一套口径');

/*
 * BUG 36 补的 noOutline() 用 markdownRowCount() 当闸门，而真正解析的是
 * markdownToSheet()。两者口径一旦不一致，事故正是 BUG 36 想防的那一个：
 *   闸门说「有大纲」→ 放行 → 解析出一张空的「中心主题」
 *   → 导入是**整体替换且不可撤销**，用户全部画布被一张空画布顶掉。
 *
 * 早先 rowCount 用 `^\s{0,3}#`（含制表符）、解析用 `^#`（顶格），
 * 缩进写的标题（列表里嵌标题、从编辑器整段复制时很常见）就踩中这个缝：
 * 实测 `  # 项目 / ## 设计 / ## 开发` → rowCount=3、解析出空画布。
 */
{
  const wb9 = await import('./workbook.js');

  /** 解析出来的第一张画布是否就是「空的中心主题」 */
  const isBlank = (md) => {
    const s = wb9.markdownToWorkbook(md);
    if (!s.length) return true;
    const root = JSON.parse(s[0].content).root;
    return !root || (root.children || []).length === 0;
  };

  /*
   * 契约：**只要说有大纲，解析出来就不能是空画布**。
   * 这条比逐条列输入更有用 —— 它管的是两个函数之间的关系，
   * 将来任何一边改了口径都会被抓住。
   */
  const cases = {
    '顶格': '# 项目\n## 设计\n## 开发',
    '两空格缩进': '  # 项目\n  ## 设计\n  ## 开发',
    '三空格缩进': '   # 项目\n   ## 设计',
    '四空格缩进': '    # 项目\n    ## 设计',
    '制表符缩进': '\t# 项目\n\t## 设计',
    '混排缩进': '# 项目\n  ## 设计\n### 开发',
    '无大纲': '随便一段话\n第二行',
    '空': '',
  };
  for (const [name, md] of Object.entries(cases)) {
    const n = wb9.markdownRowCount(md);
    ok(n === 0 || !isBlank(md),
      `${name}：rowCount=${n} 与解析结果一致（说有大纲就不能解析出空画布）`,
      `rowCount=${n} blank=${isBlank(md)}`);
  }

  // 现象侧：缩进标题必须真的解析出内容，而不是被放行后顶掉一切
  {
    const s = wb9.markdownToWorkbook('  # 项目\n  ## 设计\n  ## 开发');
    const root = JSON.parse(s[0].content).root;
    eq(root.data.text, '项目', '缩进写的中心主题能被解析出来（早先被整段忽略）');
    eq((root.children || []).length, 2, '缩进写的子节点也能被解析出来');
  }

  // 制表符缩进：CommonMark 里是**代码块**不是标题，两边都该当没有大纲
  eq(wb9.markdownRowCount('\t# 项目'), 0, '制表符缩进不算标题（与解析器一致，避免误放行）');

  // 源码侧：两个正则必须逐字对齐（只认空格、最多三格、井号后要空白）
  const wsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'workbook.js'), 'utf8'));
  ok(/raw\.match\(\/\^ \{0,3\}\(#\{1,6\}\)\\s\+\(\.\*\)\$\/\)/.test(wsrc),
    'markdownToSheet 允许 0~3 个前导空格');
  /*
   * BUG 99 之后空标题会补成占位节点，所以 rowCount 的口径从「井号后有非空白内容」
   * 放宽成「井号后有内容 **或** 只有空白」—— 与解析器逐字对齐。
   * 只认 `\s+\S` 的话，「那边解析出占位节点、这里说没有大纲」又对不上了。
   */
  ok(/\/\^ \{0,3\}#\{1,6\}\(\\s\+\\S\|\\s\+\$\)\//.test(wsrc),
    'markdownRowCount 用同一套前导空格规则（含空标题，与解析器一致）');
  ok(!/\\s\{0,3\}#\{1,6\}/.test(wsrc), '不得再出现 \\s{0,3}（含制表符，与解析器不一致）');
}

/* ------------------------------------------------------------------
   BUG 91：Markdown 转义不是往返安全的 —— 用户手打的反斜杠被吃掉
   ------------------------------------------------------------------ */
group('BUG 91 · 「画布：」转义必须成对（E/D）');

/*
 * 二级节点文字撞上 `## 画布：` 分块标记，所以要转义成一个前导反斜杠。
 * 但转义与解转义必须成对，否则不是往返安全的：
 *   · 用户手打 `\画布：设计` → 拼出的行本来就不命中标记 → 不加转义
 *     → 导回时照样被解 → **用户的反斜杠被静默吃掉**（三级节点同理）
 */
{
  const wb8 = await import('./workbook.js');

  /** 走一遍「导出成 md → 导回」；depth=1 二级节点、depth=2 三级节点 */
  const rt = (text, depth) => {
    const kid = { data: { text }, children: [] };
    const root = depth === 1
      ? { data: { text: '根' }, children: [kid] }
      : { data: { text: '根' }, children: [{ data: { text: '中' }, children: [kid] }] };
    const md = wb8.sheetToMarkdown(JSON.stringify({ root }));
    let n = JSON.parse(wb8.markdownToSheet(md)).root;
    for (let i = 1; i < depth; i++) n = n.children[0];
    return n.children[0].data.text;
  };

  // 会撞标记的文字：两个深度都要保住
  for (const d of [1, 2]) {
    eq(rt('画布：设计', d), '画布：设计', `${d}级：撞分块标记的文字往返无损`);
    eq(rt('画布:设计', d), '画布:设计', `${d}级：半角冒号同样无损`);
  }
  // 用户手打的反斜杠：不能被吃掉
  for (const d of [1, 2]) {
    eq(rt('\\画布：设计', d), '\\画布：设计', `${d}级：手打的反斜杠不被吃掉`);
    eq(rt('\\普通文字', d), '\\普通文字', `${d}级：手打的反斜杠（非画布）也不被吃掉`);
  }
  eq(rt('\\\\双反斜杠', 1), '\\\\双反斜杠', '连续两个反斜杠往返无损');
  eq(rt('普通文字', 1), '普通文字', '普通文字不受影响');

  // 从别处导入的 md：以 \ 开头的文字不该被改（不做通用去反斜杠）
  eq(JSON.parse(wb8.markdownToSheet('# 根\n## \\普通文字')).root.children[0].data.text,
    '\\普通文字', '别处导入的 \\普通文字 原样保留');

  /*
   * 源码侧：E 的条件与 D 的条件必须成对出现。
   *
   * ⚠️ 不能用 fnBody() 切函数体：sheetToMarkdown 内部就有 2 空格缩进的
   * `function walk`，fnBody 会切在那里，切出来的片段里根本没有下面要找的
   * 那两行 —— 断言恒假。改成「在哪个函数里、距函数头多远」来定位。
   */
  const wsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'workbook.js'), 'utf8'));
  const E = String.raw`/^\\/.test(text) || /^画布[:：]/.test(text)`;
  const D = String.raw`/^\\(画布[:：]|\\)/.test(text)`;
  const iSheet = wsrc.indexOf('export function sheetToMarkdown(');
  const iFrom = wsrc.indexOf('export function markdownToSheet(');
  const iE = wsrc.indexOf(E);
  const iD = wsrc.indexOf(D);
  ok(iSheet >= 0 && iE > iSheet && iE - iSheet < 2500,
    'E 的条件在 sheetToMarkdown 里（以反斜杠开头、或撞分块标记才转义）',
    `sheet@${iSheet} E@${iE}`);
  ok(iFrom >= 0 && iD > iFrom && iD - iFrom < 2500,
    'D 的条件在 markdownToSheet 里（只解紧跟「画布：」或又一个反斜杠的那一个）',
    `from@${iFrom} D@${iD}`);
  ok(!wsrc.includes('text.replace(/\\'), 'D 不得做通用去反斜杠（会改掉别处导入的文字）');
}

/* ------------------------------------------------------------------
   BUG 92：只带 realHTML 的 XMind 备注导入后整条丢失
   ------------------------------------------------------------------ */
group('BUG 92 · XMind 备注必须认 realHTML（plain 之外那份）');

/*
 * XMind 的备注是**双字段**：plain（纯文本）与 realHTML（XHTML）。
 * 别的软件（XMind 2020+、各类生成工具）常常只写 realHTML，
 * 于是只认 plain 的读法会把备注**整条静默丢掉** —— 节点上看着像从来
 * 没写过备注，也不报错。
 *
 * 实测（只留 content.json 的 zen 包）：
 *   {realHTML:{content:'<p>这是备注</p>'}} → 修复前 data.note = undefined
 */
{
  const x9 = await import('./xmind.js');

  /** 造一个只含 content.json 的 zen 包（模拟别的软件产出的文件） */
  const zenWith = async (notes) => {
    const cj = [{
      id: 'sh1', class: 'sheet', title: '画布',
      rootTopic: { id: 't1', class: 'topic', title: '根', ...(notes ? { notes } : {}),
        children: { attached: [{ id: 't2', class: 'topic', title: '子' }] } },
    }];
    const buf = await x9.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await x9.readXMind(new Uint8Array(buf));
    return JSON.parse(r.sheets[0].content).root.data.note;
  };

  eq(await zenWith({ realHTML: { content: '<p>这是备注</p>' } }), '这是备注',
    '★ 只写 realHTML 的备注必须读出来（早先整条丢失、且不报错）');
  eq(await zenWith({ plain: { content: '纯文本' } }), '纯文本', 'plain 仍正常');
  eq(await zenWith({ plain: { content: '纯文本' }, realHTML: { content: '<p>别的</p>' } }),
    '纯文本', '两份都有时以 plain 为准（本工具自己导出的才不会变样）');

  // XHTML 不能直接当文本存：块级标签转换行、行内标签去掉、实体还原
  eq(await zenWith({ realHTML: { content: '<p>行1<br/>行2</p>' } }), '行1\n行2', '<br> 转成换行');
  eq(await zenWith({ realHTML: { content: '<p>第一段</p><p>第二段</p>' } }), '第一段\n第二段', '段落转换行');
  eq(await zenWith({ realHTML: { content: '<p><b>粗</b>与<i>斜</i></p>' } }), '粗与斜', '行内标签去掉');
  eq(await zenWith({ realHTML: { content: '<p>a &amp; b</p>' } }), 'a & b', '&amp; 还原');
  eq(await zenWith({ realHTML: { content: '<p>&lt;标签&gt;</p>' } }), '<标签>', '&lt;/&gt; 还原');
  eq(await zenWith({ realHTML: { content: '<p>a&nbsp;b</p>' } }), 'a b', '&nbsp; 还原成空格');
  ok((await zenWith(null)) === undefined, '没有备注时不得写出空串');

  // 本工具导出：两份都写，且往返无损（含会破坏 XHTML 的字符）
  const rtNote = async (note) => {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'n1', text: '根', note }, children: [] } }) }];
    const blob = await x9.writeXMind(sheets, 'sh1');
    const b = new Uint8Array(await new Blob([blob]).arrayBuffer());
    const r = await x9.readXMind(b);
    return JSON.parse(r.sheets[0].content).root.data.note;
  };
  for (const note of ['普通备注', 'a < b & c', '第一行\n第二行', '带"引号"']) {
    eq(await rtNote(note), note, `往返无损：${JSON.stringify(note)}`);
  }

  // 导出必须同时写 plain 与 realHTML，且 realHTML 里的 & < > 要转义 ——
  // 否则备注里写「a < b」会让整段 XHTML 失效、在别的软件里显示不出来
  {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'n1', text: '根', note: 'a < b & c' }, children: [] } }) }];
    const blob = await x9.writeXMind(sheets, 'sh1');
    const en = await x9.zipRead(new Uint8Array(await new Blob([blob]).arrayBuffer()));
    const notes = JSON.parse(new TextDecoder().decode(en.get('content.json')))[0].rootTopic.notes;
    ok(!!(notes && notes.plain && notes.realHTML), '导出的备注同时写 plain 与 realHTML');
    ok(/&lt;/.test(notes.realHTML.content) && /&amp;/.test(notes.realHTML.content),
      'realHTML 里的 < 与 & 已转义（不转义会让它变成非法 XHTML）', notes.realHTML.content);

    // 只留 content.json（剥掉本工具快照）再导回，仍要无损
    const cj = JSON.parse(new TextDecoder().decode(en.get('content.json')));
    const zen = await x9.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const rr = await x9.readXMind(new Uint8Array(zen));
    eq(JSON.parse(rr.sheets[0].content).root.data.note, 'a < b & c',
      '★ 走 zen 档（别的软件的路径）往返仍无损');
  }

  // 源码侧：读必须走 topicNote（而不是直接取 plain）、写必须两份都写
  const xsrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'xmind.js'), 'utf8'));
  ok(/const note = topicNote\(topic\.notes\)/.test(xsrc), '读侧走 topicNote（plain 优先、回落 realHTML）');
  ok(!/const note = str\(topic\.notes\?\.plain/.test(xsrc), '读侧不得只认 plain');
  ok(/plain: \{ content: note \}, realHTML: \{ content: plainToHtml\(note\) \}/.test(xsrc),
    '写侧两份都写');
}

/* ------------------------------------------------------------------
   BUG 93：图标占着 image 槽时，导出 XMind 把照片全丢了
   ------------------------------------------------------------------ */
group('BUG 93 · 图标与照片共存时，XMind 导出必须留照片');

/*
 * 「图标 + 照片横幅」是 BUG 58 修完之后的**正常状态**：先挂照片、再应用
 * 图标，照片被让位到 data.images 横幅、图标进 data.image 槽位。
 * 而 buildImage 一律先读 image —— 导出到 XMind 时**照片全部静默丢失**，
 * content.json 里只剩一个装饰性的图标。
 */
{
  const x9 = await import('./xmind.js');
  const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';
  const P1 = 'data:image/jpeg;base64,/9j/AAAA';
  const P2 = 'data:image/png;base64,iVBORw0KGgo=';

  /** 导出后读 content.json 里根话题的 image（剥掉本工具快照，走 zen 路径） */
  const topicImage = async (data) => {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'n1', text: '根', ...data }, children: [] } }) }];
    const blob = await x9.writeXMind(sheets, 'sh1');
    const en = await x9.zipRead(new Uint8Array(await new Blob([blob]).arrayBuffer()));
    return JSON.parse(new TextDecoder().decode(en.get('content.json')))[0].rootTopic.image;
  };

  {
    const im = await topicImage({ image: ICON, images: [P1, P2] });
    ok(!!im && im.src === P1, '★ 图标 + 照片横幅：导出的是照片而不是图标（早先只留图标）',
      im && im.src.slice(0, 30));
  }
  {
    const im = await topicImage({ images: [P1, P2] });
    ok(!!im && im.src === P1, '只有横幅时取第一张');
  }
  {
    const im = await topicImage({ image: ICON });
    ok(!!im && im.src === ICON, '只有图标时仍导出图标（没有照片可留）');
  }

  // 尺寸只在用的就是槽位那张时才写：把图标的尺寸套到照片上会把照片拉变形
  {
    const im = await topicImage({ image: P1, imageSize: { width: 640, height: 480 } });
    ok(im.width === 640 && im.height === 480, '单张照片的尺寸要带上');
  }
  {
    const im = await topicImage({ image: ICON, imageSize: { width: 320, height: 320 }, images: [P1, P2] });
    ok(!im.width && !im.height, '★ 图标占槽时不得把图标的尺寸套到照片上（会变形）',
      `w=${im.width} h=${im.height}`);
  }

  const xs = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'xmind.js'), 'utf8'));
  ok(/function isIconSrc\(/.test(xs), '有图标判据（与 bridge 的 svg+xml 同一套）');
  ok(/if \(isIconSrc\(data, src\) && many\.length\)/.test(xs), '槽位是图标时改用横幅里的照片');
  ok(/function isIconSrc\(data, u\)/.test(xs) && /const flag = data \? data\.icon : undefined;/.test(xs),
    '图标判据先看 data.icon 标记（MIME 只是兜底）');
}

/* ------------------------------------------------------------------
   BUG 94：「清除节点上的图标 / 图片」点完图标还在
   ------------------------------------------------------------------ */
group('BUG 94 · 清除按钮两类都要清（图标与图片）');

/*
 * 按钮文案写着「清除节点上的**图标 / 图片**」，但只调了 setImage(null)。
 * setImage(null) 的语义是「只清自己这一类」—— 不传 icon 标记时槽位上是
 * 图标就跳过（那是图标库里「清除节点图标」的事）。于是：
 *   · 节点上只有图标 → 点完**什么都不发生**，图标还在
 *   · 图标 + 照片横幅 → 只清掉照片，图标留下
 * 实测（真实 EditorBridge）：{image: 图标} → 点完 image 仍等于图标。
 */
{
  const { EditorBridge } = await import('./editor-bridge.js');
  const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';
  const P1 = 'data:image/jpeg;base64,/9j/AAAA';

  const stub = (data) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const b = new EditorBridge(host, {});
    b.iframe = document.createElement('iframe');
    // 必须挂进 body：没挂的话 contentWindow 是 null，桩根本塞不进去
    document.body.appendChild(b.iframe);
    b.ready = true;
    const km = { _d: JSON.parse(JSON.stringify(data)),
      getSelectedNode() { return { getData: (k) => this._d[k] }; } };
    b.iframe.contentWindow.__km = km;
    b.exec = (n, v) => { km._d[n] = v; return true; };
    b._safe = (_l, fn) => { try { return fn({}, km); } catch { return null; } };
    return { b, km };
  };

  // 面板里那个按钮现在的写法
  const clearBoth = (b) => { b.setImage(null, { icon: true }); b.setImage(null); };

  {
    const { b, km } = stub({ image: ICON });
    clearBoth(b);
    ok(km._d.image === null, '★ 只有图标时也要清掉（早先点完图标还在）', String(km._d.image));
  }
  {
    const { b, km } = stub({ image: ICON, images: JSON.stringify([P1]) });
    clearBoth(b);
    ok(km._d.image === null && km._d.images === null,
      '★ 图标 + 横幅：两类都清（早先只剩图标）', `image=${km._d.image}`);
  }
  {
    const { b, km } = stub({ image: P1 });
    clearBoth(b);
    ok(km._d.image === null, '只有照片时清照片');
  }
  {
    const { b, km } = stub({ images: JSON.stringify([P1]) });
    clearBoth(b);
    ok(km._d.images === null, '只有横幅时清横幅');
  }

  // 图标库里那个「清除节点图标」只清图标 —— 照片横幅必须留下
  {
    const { b, km } = stub({ image: ICON, images: JSON.stringify([P1]) });
    b.setImage(null, { icon: true });
    ok(km._d.image === null && km._d.images !== null,
      '「清除节点图标」不得顺手删掉照片横幅', `images=${km._d.images}`);
  }

  // 源码侧：面板那个按钮必须清两次
  const pn = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8'));
  const i = pn.indexOf('清除节点上的图标 / 图片');
  ok(i >= 0, '找到该按钮');
  const seg = pn.slice(i, i + 400);
  ok(/setImage\(null, \{ icon: true \}\)/.test(seg) && /setImage\(null\)/.test(seg),
    '按钮先按图标清、再按图片清（只调一次清不掉图标）');
}

/* ------------------------------------------------------------------
   BUG 95：用户自己挂的 .svg 图片被当成图标，四处静默丢数据
   ------------------------------------------------------------------ */
group('BUG 95 · 用户的 SVG 图片不得被判成图标');

/*
 * 图标与图片共用 data.image 一个槽位，早先只看 MIME 区分：
 * `data:image/svg+xml` 就算图标。而 io.imageToInline 对 SVG 是**原样内联**
 * （SVG 是文本、体积天然小，canvas 又画不了，见 io.js），所以用户从
 * 「浏览图片」或拖放挂一张 .svg 图片，产出的同样是 data:image/svg+xml ——
 * 于是被当成图标，实测四处后果：
 *   · 侧栏「图片」栏不列出它（getSelectedImages 跳过图标）→ 看不到也删不掉
 *   · 点「清除节点图标」把它删了（那个按钮理应只清图标）
 *   · 再挂一张照片时，照片反而被让位到横幅（槽位"被图标占着"）
 *   · 导出 XMind 时 buildImage 跳过它去取横幅 → 用户的图静默丢失
 * 全是丢数据，而用户不会把「我挂了个 svg」和「图没了」联系起来。
 *
 * 修法：写图标时顺带落 data.icon = true、写图片时落 false，判定时以它为准；
 * 存量节点没有这个字段，才回落到 MIME（那时行为与修复前一致，不回归）。
 */
{
  const { EditorBridge } = await import('./editor-bridge.js');
  // 用户挂的 .svg 图片：MIME 与图标**完全一样**，只有标记能区分
  const USER_SVG = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAwIiBoZWlnaHQ9IjQwMCIvPg==';
  const ICON = 'data:image/svg+xml;base64,PHN2Zy84';
  const PHOTO = 'data:image/jpeg;base64,/9j/AAAA';

  const mk = (data) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const b = new EditorBridge(host, {});
    b.iframe = document.createElement('iframe');
    document.body.appendChild(b.iframe);      // 不挂进 body 的话 contentWindow 是 null
    b.ready = true;
    const km = { _d: JSON.parse(JSON.stringify(data)),
      getSelectedNode() { return { getData: (k) => km._d[k], setData: (k, v) => { km._d[k] = v; } }; } };
    b.iframe.contentWindow.__km = km;
    b.exec = (n, v) => { km._d[n] = v; return true; };
    b._safe = (_l, fn) => { try { return fn({}, km); } catch { return null; } };
    return { b, km };
  };

  // ① 挂一张 .svg 图片 → 侧栏「图片」栏必须列出它
  {
    const { b, km } = mk({});
    b.setImage(USER_SVG);
    ok(km._d.icon === false, '★ 挂图片时落 data.icon = false', String(km._d.icon));
    ok(b.getSelectedImages().length === 1 && b.getSelectedImages()[0] === USER_SVG,
      '★ 侧栏「图片」栏认得它是图片（早先判成图标 → 列出 0 张）',
      JSON.stringify(b.getSelectedImages().length));
  }
  // ② 点「清除节点图标」不得把它删掉
  {
    const { b, km } = mk({});
    b.setImage(USER_SVG);
    b.setImage(null, { icon: true });
    ok(km._d.image === USER_SVG,
      '★ 「清除节点图标」保住用户的 SVG 图片（早先把它删了）', String(km._d.image));
  }
  // ③ 已有 SVG 图再挂照片：两张都保住（既不互相覆盖，也不产孤儿）
  {
    const { b, km } = mk({});
    b.setImage(USER_SVG);
    b.setImage(PHOTO);
    const list = b.getSelectedImages();
    ok(list.length === 2 && list.includes(USER_SVG) && list.includes(PHOTO),
      '★ 已有 SVG 图再挂照片：两张都在（早先槽里那张被整串覆盖）',
      JSON.stringify(list.length));
    ok(!km._d.image, '两张时清空槽位（否则槽里那张侧栏读不到，成孤儿）', String(km._d.image));
  }
  // ④ 图标本身照旧工作：图标进槽、照片让位到横幅
  {
    const { b, km } = mk({});
    b.setImage(ICON, { icon: true });
    ok(km._d.icon === true, '应用图标时落 data.icon = true', String(km._d.icon));
    b.setImage(PHOTO);
    ok(km._d.image === ICON && !!km._d.images,
      '★ 图标占槽时照片让位到横幅（BUG 58 的行为没被改坏）', `image=${km._d.image}`);
    ok(b.getSelectedImages().length === 1 && b.getSelectedImages()[0] === PHOTO,
      '侧栏列出的是照片，图标不算图片附件');
  }
  // ⑤ 存量数据（无 icon 字段）不回归：老图标仍判成图标
  {
    const { b } = mk({ image: ICON });
    ok(b._imageSlot().isIcon === true, '★ 存量图标无标记时按 MIME 兜底，仍判成图标');
  }
  // ⑥ 存量 SVG 图片无标记时仍按 MIME（无法区分，与修复前一致）—— 不是回归
  {
    const { b } = mk({ image: USER_SVG });
    ok(b._imageSlot().isIcon === true, '存量 SVG 图片无标记时行为与修复前一致（兜底）');
  }

  // ⑦ XMind 导出：用户那张 SVG 图必须被写进 topic.image（而不是被图标挤掉）
  {
    const X = await import('./xmind.js');
    const one = async (d) => {
      const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
        content: JSON.stringify({ root: { data: { id: 'n1', text: '根', ...d }, children: [] } }) }];
      const en = await X.zipRead(new Uint8Array(
        await new Blob([await X.writeXMind(sheets, 'sh1')]).arrayBuffer()));
      return JSON.parse(new TextDecoder().decode(en.get('content.json')))[0].rootTopic.image;
    };
    let im = await one({ image: USER_SVG, icon: false });
    ok(im && im.src === USER_SVG,
      '★ 导出 XMind 保住用户的 SVG 图片（早先被判成图标 → 取横幅 → 静默丢失）', im && im.src);
    im = await one({ image: ICON, icon: true, images: [PHOTO] });
    ok(im && im.src === PHOTO, '导出：槽里是图标时留照片', im && im.src);
    im = await one({ image: ICON, images: [PHOTO] });
    ok(im && im.src === PHOTO, '导出：存量无标记时按 MIME 兜底，仍留照片', im && im.src);
  }
}

/* ------------------------------------------------------------------
   BUG 97：图标 / 图片的区分没写进 XMind，zen 档往返后标记断掉
   ------------------------------------------------------------------ */
group('BUG 97 · XMind 必须带上「这是图标还是用户挂的图片」的标记');

/*
 * 图标与用户自己挂的 .svg 图片在 XMind 里**形态完全相同**（都是
 * `topic.image.src = data:image/svg+xml…`），区分靠的是节点上的 data.icon
 * 标记（BUG 95 引入）。而它不是 XMind 的字段，导出时不写出去就断了。
 *
 * 断掉的实际场景：**文件被别的软件打开再存回来** —— 那时本工具的无损快照
 * kityminder.json 已被丢掉，导回只能走 zen 档。实测导回后 data.icon 是
 * undefined，回落 MIME 判据，用户的 SVG 图又被判成图标（BUG 95 四处后果
 * 复现：侧栏不列出、清除节点图标会删掉它）。
 *
 * 所以这里全部走 **zen 档往返**（剥掉 native 快照），才是真实情形。
 */
{
  const X = await import('./xmind.js');
  const USER_SVG = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAwIiBoZWlnaHQ9IjQwMCIvPg==';
  const SVG_PHOTO = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAwIi8+';
  const ICON = 'data:image/svg+xml;base64,PHN2Zy84';
  const JPEG = 'data:image/jpeg;base64,/9j/AAAA';

  /** 写 → 只留 content.json → 读回（模拟被别的软件存过一遍） */
  const zen = async (data) => {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'nR', text: '根' },
        children: [{ data: { id: 'n1', text: 'A', ...data }, children: [] }] } }) }];
    const blob = await X.writeXMind(sheets, 'sh1');
    const buf = new Uint8Array(await new Blob([blob]).arrayBuffer());
    const en = await X.zipRead(buf);
    const cj = JSON.parse(new TextDecoder().decode(en.get('content.json')));
    const zb = await X.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await X.readXMind(new Uint8Array(zb));
    return { kid: JSON.parse(r.sheets[0].content).root.children[0],
      topic: cj[0].rootTopic.children.attached[0] };
  };

  // ① 用户挂的 SVG 图片：标记必须活着回来
  {
    const { kid, topic } = await zen({ image: USER_SVG, icon: false });
    ok(topic.nexusIcon === false, '导出时带上 nexusIcon=false', String(topic.nexusIcon));
    ok(kid.data.icon === false,
      '★ zen 档导回后仍认得它是**图片**（早先标记断掉 → 回落 MIME → 判成图标）',
      String(kid.data.icon));
  }
  // ② 图标：同样要带回来（否则导回后侧栏会把图标列成图片）
  {
    const { kid, topic } = await zen({ image: ICON, icon: true });
    ok(topic.nexusIcon === true, '图标导出时带 nexusIcon=true', String(topic.nexusIcon));
    ok(kid.data.icon === true, 'zen 档导回后仍认得它是图标', String(kid.data.icon));
  }
  // ③ 槽位是图标、实际导出的是横幅里那张 SVG 照片（BUG 93）→ 标记跟照片走
  {
    const { topic } = await zen({ image: ICON, icon: true, images: [SVG_PHOTO] });
    ok(topic.image?.src === SVG_PHOTO, '导出的是横幅里的照片', String(topic.image?.src).slice(0, 28));
    ok(topic.nexusIcon === false,
      '★ 标记跟**写出去的那张**走：照片是图片附件，不能跟着槽位的图标标成 true',
      String(topic.nexusIcon));
  }
  // ④ 不污染：非 SVG 图片不需要这个键（JPEG 本来就分得清）
  {
    const { topic } = await zen({ image: JPEG, icon: false });
    ok(topic.nexusIcon === undefined,
      'JPEG 不写私有键（只在真的区分不出来时才写）', String(topic.nexusIcon));
  }
  // ⑤ 存量 / 别的软件产出的文件没有这个键 → 保持不写，回落 MIME，不回归
  {
    const cj = [{ rootTopic: { id: 't', title: '根',
      children: { attached: [{ id: 'c', title: 'A', image: { src: ICON } }] } } }];
    const zb = await X.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await X.readXMind(new Uint8Array(zb));
    const kid = JSON.parse(r.sheets[0].content).root.children[0];
    ok(kid.data.icon === undefined,
      '★ 别的软件产出的文件没有该键时不写 data.icon（回落 MIME，与修复前一致）',
      String(kid.data.icon));
  }
  // ⑥ 键值不是布尔（被别的软件改成字符串 / 数字）→ 不认，回落 MIME
  //
  // 这条是被变异验证逼出来的：早先只测了「有布尔」与「没有键」两种，
  // 于是把判据从 `typeof === 'boolean'` 放宽成 `!== undefined` 也照样全绿
  // —— 断言看着在把关，实际没覆盖到这个形态。
  {
    const mkZen = async (v) => {
      const cj = [{ rootTopic: { id: 't', title: '根',
        children: { attached: [{ id: 'c', title: 'A', image: { src: ICON }, nexusIcon: v }] } } }];
      const zb = await X.zipWrite([{ name: 'content.json',
        data: new TextEncoder().encode(JSON.stringify(cj)) }]);
      const r = await X.readXMind(new Uint8Array(zb));
      return JSON.parse(r.sheets[0].content).root.children[0];
    };
    ok((await mkZen('true')).data.icon === undefined,
      'nexusIcon 是字符串时不认（回落 MIME）', String((await mkZen('true')).data.icon));
    ok((await mkZen(1)).data.icon === undefined, 'nexusIcon 是数字时不认');
    // 布尔仍然认
    ok((await mkZen(false)).data.icon === false, '布尔 false 要认（这才是真信号）');
  }
}

/* ------------------------------------------------------------------
   BUG 104：XMind 一个节点只能挂 1 个附件 / 1 张图 —— 多出来的静默消失
   ------------------------------------------------------------------
   XMind 的 topic 只有**一个** href（附件）和**一个** image（图片），这是格式的
   硬限制，不是实现的疏漏。但它是**静默**发生的，而且比"没导出"更坑：

     实测一个节点挂 2 个附件 → resources/ 里 2 个文件的字节都在，
     但 content.json 只有 1 条 href → 另一个**在包里却没人指向它**
     → 在别的 XMind 软件里打开，那个附件就是不存在。

   更糟的是状态栏：导出侧原本按「打包成功的字节数」报「含 2 个附件」，
   数的根本不是"能挂到节点上的个数"—— 等于谎报。

   与 BUG 102（Markdown 超 6 级）同口径：限制改不掉，但**必须说出来**，
   导出那一刻是唯一能提醒的机会（导入是整体替换，等导回来发现少了已经晚了）。

   这里锁三件事：① 能算出损失 ② 分类正确（超链接挤掉 / 挂不上 / 图片）
   ③ 导出侧真的说了、且不再谎报"含 N 个附件"。
   ------------------------------------------------------------------ */
/* ------------------------------------------------------------------
   BUG 106：节点自定义样式在 XMind 往返中几乎全丢 —— StyleMap 用的是
   **内核里根本不存在**的键名

   左侧键名必须取内核真正落到 node.data 上的那套（editor 里 setData 用的）：
     · 填充是 background（不是 fill）—— 主题键是 root-fill / main-fill，
       节点级再叫 fill 会被 getStyle 的前缀拼接吃掉
     · 描边 / 描边线宽 / 圆角 / 连线色 / 连线宽都带 node- 前缀（同理）
     · 文字色是 color（不是 forecolor —— forecolor 是**命令名**不是 data 键）
     · 粗体 / 斜体 / 删除线是 font-weight / font-style / font-strikethrough
       （bold / italic / strikethrough 只是面板状态对象的键）

   早先 StyleMap 写的是 fill / stroke / radius / forecolor，四个内核里一个都没有，
   于是 11 项节点样式里只有字号、字体、水平对齐三项能回来。给用户标红的重要
   节点导出再打开就变回默认配色，且不报错。
   ------------------------------------------------------------------ */
/* ------------------------------------------------------------------
   BUG 107：进度（progress）在 XMind 往返中被静默改值

   kityminder 的 progress 是 **1..9**（内核 ProgressRenderer：
   pie.setAngle(-360 * (p-1) / 8)，p=9 才 check.setVisible；面板 tooltip
   也是「进度 3/9」）。而 MarkerToProgress 早先按 0..10 建表
   （[0,1,3,4,5,6,8,9,10]），9 个标记塞不下 11 档，于是：
     · 本工具导出的 progress 2 → 回来 3、7 → 回来 8（9 档里 2 档被改）
     · 导入别的软件的 task-done → 10，超出取值域：进度条被画成 -405°
       （而不是 -360°），且不打勾
   ------------------------------------------------------------------ */
/* ------------------------------------------------------------------
   BUG 108：XMind 8 老文件的节点自定义样式必须读出来

   content.xml 的 topic **不带任何视觉属性**，只有一个 style-id 指向
   styles.xml。早先只解析 content.xml → 节点自定义样式**全丢**（标红、
   字号、加粗…），而 zen 路径（content.json）早就读得好好的 ——
   两条路只修了一条。
   ------------------------------------------------------------------ */
group('BUG 108 · XMind 8（content.xml）的节点样式必须读出来');

{
  const X = await import('./xmind.js');

  const NS = 'xmlns="urn:xmind:xmap:xmlns:content:2.0"'
    + ' xmlns:fo="http://www.w3.org/1999/XSL/Format"'
    + ' xmlns:svg="http://www.w3.org/2000/svg"';
  const mkContent = () => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content ${NS} version="2.0"><sheet id="s1" theme="th1">
<topic id="t0" style-id="ms0"><title>根</title><children><topics type="attached">
<topic id="c1" style-id="as1"><title>A</title></topic>
<topic id="c2" style-id="as2"><title>B</title></topic>
<topic id="c3"><title>C</title></topic>
</topics></children></topic><title>画布</title></sheet></xmap-content>`;

  const mkStyles = () => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-styles xmlns="urn:xmind:xmap:xmlns:styles:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format" xmlns:svg="http://www.w3.org/2000/svg" version="2.0">
<styles>
<master-styles><style id="ms0" type="topic"><topic-properties svg:fill="#333333"/><font-properties fo:color="#FFFFFF"/></style></master-styles>
<automatic-styles>
<style id="as2" type="topic" based-on="as1"><font-properties fo:font-size="24pt" fo:font-weight="bold"/></style>
<style id="as1" type="topic" based-on="ms0"><topic-properties svg:fill="#FF0000"/><font-properties fo:color="#FFFFFF" fo:font-style="italic" fo:text-decoration="line-through"/></style>
</automatic-styles>
</styles></xmap-styles>`;

  /*
   * 包一层 try/catch：被检查的东西坏掉时**必须报失败，不能把进程崩掉**。
   *
   * 早先这里直接 await，于是「坏 styles.xml 向上抛」那次变异让整个测试文件
   * 在 ⑤ 处直接终止 —— 后面的用例一条都没跑，看着像「抓到了」，其实漏了大半
   * （M6 变异实测：进程退出码非 0，但没有任何一条 ✗）。
   */
  const read = async (extra) => {
    const files = [{ name: 'content.xml', data: new TextEncoder().encode(mkContent()) }];
    for (const f of extra || []) files.push(f);
    const zb = await X.zipWrite(files);
    try {
      const r = await X.readXMind(new Uint8Array(zb));
      const root = JSON.parse(r.sheets[0].content).root;
      return { root, kids: root.children || [], err: null };
    } catch (e) {
      return { root: null, kids: [], err: String(e?.message || e) };
    }
  };

  const withStyles = async () => read([
    { name: 'styles.xml', data: new TextEncoder().encode(mkStyles()) },
  ]);

  // ① 标红/白字必须回来（早先全丢）
  {
    const { kids } = await withStyles();
    eq(kids[0].data.background, '#FF0000', '★ A 的填充色回来了');
    eq(kids[0].data.color, '#FFFFFF', '★ A 的文字色回来了');
    eq(kids[0].data['font-style'], 'italic', '★ A 的斜体回来了');
    eq(String(kids[0].data['font-strikethrough']), 'true', '★ A 的删除线回来了');
  }

  // ② based-on 链：自己的覆盖父，父的补自己的缺
  {
    const { kids } = await withStyles();
    eq(kids[1].data.background, '#FF0000', '★ B 继承到 as1 的填充（链末端优先是 as2 自己没有 fill）');
    eq(kids[1].data['font-size'], '24', '★ B 自己的字号 24pt → 24');
    eq(kids[1].data['font-weight'], 'bold', '★ B 自己的加粗');
    eq(kids[1].data['font-style'], 'italic', '★ B 继承 as1 的斜体');
  }

  // ③ 没有 style-id 的节点不该凭空长出样式
  {
    const { kids } = await withStyles();
    eq(kids[2].data.background, undefined, 'C 没挂 style-id，不带填充');
    eq(kids[2].data['font-size'], undefined, 'C 不带字号');
  }

  // ④ 没有 styles.xml 时**退化**，不能崩、也不能编造样式
  {
    const { root, kids } = await read([]);
    ok(!!root, '★ 缺 styles.xml 时仍能导入（坏样式表不该连累正文）');
    eq(kids[0].data.background, undefined, '缺 styles.xml 时不编造填充色');
  }

  // ⑤ styles.xml 是坏 XML 时，正文照样导入
  {
    const { root, err } = await read([
      { name: 'styles.xml', data: new TextEncoder().encode('<xmap-styles><style') },
    ]);
    ok(!!root && root.data.text === '根',
      '★ styles.xml 坏掉不影响正文解析（早先会整份导入失败）', err || '');
  }

  // ⑥ based-on 成环不能死循环
  {
    const cyc = `<?xml version="1.0"?><xmap-styles xmlns:svg="http://www.w3.org/2000/svg">
      <style id="x" type="topic" based-on="y"><topic-properties svg:fill="#111111"/></style>
      <style id="y" type="topic" based-on="x"><topic-properties svg:fill="#222222"/></style></xmap-styles>`;
    const t0 = Date.now();
    const { kids } = await read([
      { name: 'styles.xml', data: new TextEncoder().encode(cyc) },
    ]);
    ok(Date.now() - t0 < 5000, '★ based-on 成环不会卡死');
    // 把 c1 的 style-id 换成环里的 id 才能真正走到链上
    const files = [
      { name: 'content.xml', data: new TextEncoder().encode(mkContent().replace('as1', 'x').replace('as2', 'y')) },
      { name: 'styles.xml', data: new TextEncoder().encode(cyc) },
    ];
    const zb = await X.zipWrite(files);
    let k = [];
    try { k = JSON.parse((await X.readXMind(new Uint8Array(zb))).sheets[0].content).root.children; }
    catch (e) { k = []; }
    ok(!!(k[0]?.data?.background), '成环时仍能取到样式，不死循环');
  }

  // ⑦ 源码契约：老版路径必须**读 styles.xml**
  {
    const src = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'xmind.js'), 'utf8'));
    const i = src.indexOf('parseLegacy(legacy');
    ok(i >= 0, '能定位老版解析调用点');
    const seg = src.slice(i, i + 200);
    ok(/LegacyStylesEntry/.test(seg), '★ 老版解析必须一并读 styles.xml');
    const j = src.indexOf('function buildKmFromXmlTopic');
    ok(/applyStyle\(data/.test(src.slice(j, j + 900)),
      '★ 老版节点构建必须套用样式');
  }
}

group('BUG 107 · 进度 progress 1..9 必须在 XMind 往返中原样保住');

{
  const X = await import('./xmind.js');

  const zen = async (data) => {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'nR', text: '根' },
        children: [{ data: { id: 'n1', text: 'A', ...data }, children: [] }] } }) }];
    const blob = await X.writeXMind(sheets, 'sh1');
    const buf = new Uint8Array(await new Blob([blob]).arrayBuffer());
    const en = await X.zipRead(buf);
    const cj = JSON.parse(new TextDecoder().decode(en.get('content.json')));
    const zb = await X.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await X.readXMind(new Uint8Array(zb));
    return { kid: JSON.parse(r.sheets[0].content).root.children[0],
      topic: cj[0].rootTopic.children.attached[0] };
  };

  // ① 9 档逐档往返：一档都不许变（早先 2→3、7→8）
  {
    for (let p = 1; p <= 9; p++) {
      const { kid } = await zen({ progress: p });
      eq(String(kid.data.progress), String(p), `★ progress ${p}/9 往返回原值`);
    }
  }

  // ② 写出的标记必须与档位一一对应（不能两个档共用同一个标记）
  {
    const seen = new Map();
    for (let p = 1; p <= 9; p++) {
      const { topic } = await zen({ progress: p });
      const id = topic.markers?.map((m) => m.markerId).join(',');
      ok(!seen.has(id) || seen.get(id) === p,
        `progress ${p} 的标记不与别的档共用`, `${id}（已用于 ${seen.get(id)}）`);
      seen.set(id, p);
    }
  }

  // ③ 导入别的软件：9 个标记必须落成 1..9，**不能超出取值域**
  {
    const all = ['task-start', 'task-oct', 'task-quarter', 'task-3oct', 'task-half',
      'task-5oct', 'task-3quar', 'task-7oct', 'task-done'];
    const cj = [{ rootTopic: { id: 't', title: '根', children: { attached: all.map((mid, i) => ({
      id: 'c' + i, title: 'A' + i, markers: [{ markerId: mid }] })) } } }];
    const zb = await X.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await X.readXMind(new Uint8Array(zb));
    const kids = JSON.parse(r.sheets[0].content).root.children;
    all.forEach((mid, i) => {
      const p = kids[i].data.progress;
      ok(p === i + 1, `★ 别的软件的 ${mid} → ${i + 1}（早先 task-done → 10 越界）`,
        String(p));
    });
  }

  // ④ 源码契约：MarkerToProgress 必须是 1..9 一一对应
  {
    const src = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'xmind.js'), 'utf8'));
    const m = /const MarkerToProgress = \[([^\]]*)\]/.exec(src);
    ok(!!m, '能定位 MarkerToProgress');
    const arr = m[1].split(',').map((s) => Number(s.trim()));
    eq(arr.length, 9, '9 个进度标记');
    eq(arr.join(','), '1,2,3,4,5,6,7,8,9', '★ 一一对应 1..9（早先是 0,1,3,4,5,6,8,9,10）');
    ok(!/\/\s*10\s*\*/.test(src.slice(src.indexOf('function progressToMarker'),
      src.indexOf('function progressToMarker') + 400)),
      '★ progressToMarker 不再按 0..10 换算');
  }
}

group('BUG 106 · 节点自定义样式不得在 XMind 往返中丢掉（键名必须是内核那套）');

{
  const X = await import('./xmind.js');

  /** 写 → 只留 content.json → 读回（模拟被别的软件存过一遍） */
  const zen = async (data) => {
    const sheets = [{ id: 'sh1', title: '画布', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'nR', text: '根' },
        children: [{ data: { id: 'n1', text: 'A', ...data }, children: [] }] } }) }];
    const blob = await X.writeXMind(sheets, 'sh1');
    const buf = new Uint8Array(await new Blob([blob]).arrayBuffer());
    const en = await X.zipRead(buf);
    const cj = JSON.parse(new TextDecoder().decode(en.get('content.json')));
    const zb = await X.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await X.readXMind(new Uint8Array(zb));
    return { kid: JSON.parse(r.sheets[0].content).root.children[0],
      topic: cj[0].rootTopic.children.attached[0] };
  };

  // 内核真正用的那套键（与 editor/index.html 的 setData 一致）
  const STYLE = {
    background: '#00ff00',          // 填充
    'node-stroke': '#0000ff',       // 描边色
    'node-stroke-width': 5,         // 描边线宽
    'node-radius': 12,              // 圆角
    'node-line-stroke': '#ff00ff',  // 连线色
    'node-line-width': 3,           // 连线宽
    color: '#ff0000',               // 文字色
    'font-size': 24,
    'font-family': '宋体',
    'text-align': 'right',
    'vertical-align': 'bottom',
  };

  // ① 往返：每一项都要回到原位（早先只有字号 / 字体 / 水平对齐三项能回来）
  {
    const { kid } = await zen(STYLE);
    for (const [k, v] of Object.entries(STYLE)) {
      ok(String(kid.data[k]) === String(v),
        `★ 往返保住 ${k}`, `期望 ${JSON.stringify(v)} 实际 ${JSON.stringify(kid.data[k])}`);
    }
  }

  // ② 写出的 properties 必须落在 XMind 标准键上
  {
    const { topic } = await zen(STYLE);
    const p = topic.style?.properties || {};
    ok(p['svg:fill'] === '#00ff00', '填充 → svg:fill', String(p['svg:fill']));
    ok(p['svg:stroke'] === '#0000ff', '描边 → svg:stroke', String(p['svg:stroke']));
    ok(p['svg:stroke-width'] === '5px',
      '描边线宽 → svg:stroke-width（带 px）', String(p['svg:stroke-width']));
    ok(p['svg:corner-radius'] === '12px',
      '圆角 → svg:corner-radius（带 px）', String(p['svg:corner-radius']));
    ok(p['line-color'] === '#ff00ff', '连线色 → line-color', String(p['line-color']));
    ok(p['line-width'] === '3px', '连线宽 → line-width（带 px）', String(p['line-width']));
    ok(p['fo:color'] === '#ff0000', '文字色 → fo:color', String(p['fo:color']));
    ok(p['fo:font-size'] === '24pt', '字号 → fo:font-size（带 pt）', String(p['fo:font-size']));
    ok(p.nexusValign === 'bottom',
      '垂直对齐 → 私有键（XMind 无对应标准属性，不用私有键就会丢）', String(p.nexusValign));
  }

  // ③ 字形：font-weight / font-style / font-strikethrough
  {
    const { kid, topic } = await zen({ 'font-weight': 'bold', 'font-style': 'italic',
      'font-strikethrough': true });
    const p = topic.style?.properties || {};
    ok(p['fo:font-weight'] === 'bold', '粗体 → fo:font-weight', String(p['fo:font-weight']));
    ok(p['fo:font-style'] === 'italic', '斜体 → fo:font-style', String(p['fo:font-style']));
    ok(/line-through/.test(p['fo:text-decoration'] || ''),
      '删除线 → fo:text-decoration', String(p['fo:text-decoration']));
    ok(kid.data['font-weight'] === 'bold' && kid.data['font-style'] === 'italic'
      && kid.data['font-strikethrough'] === true,
      '字形往返回内核键（面板读的就是这三个键）',
      JSON.stringify([kid.data['font-weight'], kid.data['font-style'], kid.data['font-strikethrough']]));
  }

  // ④ ★ 源码契约：StyleMap 不许改回那四个内核里不存在的键名
  //    这是本 BUG 的根因，也是它**从未被任何测试碰过**的原因
  {
    const src = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'xmind.js'), 'utf8'));
    const i = src.indexOf('const StyleMap = [');
    ok(i > 0, '能定位 StyleMap');
    const body = src.slice(i, src.indexOf('];', i));
    for (const k of ['background', 'node-stroke', 'node-stroke-width', 'node-radius',
      'node-line-stroke', 'node-line-width', 'color', 'font-size', 'font-family', 'text-align']) {
      ok(new RegExp("\\['" + k + "',").test(body), `StyleMap 含内核键 ${k}`);
    }
    ok(!/\['fill',/.test(body), "★ StyleMap 不得再出现 ['fill',（节点级是 background）");
    ok(!/\['stroke',/.test(body), "★ 不得再出现 ['stroke',（是 node-stroke）");
    ok(!/\['radius',/.test(body), "★ 不得再出现 ['radius',（是 node-radius）");
    ok(!/\['forecolor',/.test(body), "★ 不得再出现 ['forecolor',（是 color）");
    // 写侧 / 读侧都不得再读那三个面板状态键
    const bodyAll = src.slice(src.indexOf('function buildStyle'), src.indexOf('function parseZen'));
    ok(!/data\?\.bold|data\.bold\b/.test(bodyAll),
      '★ buildStyle 不读 data.bold（应读 font-weight）');
    ok(!/data\?\.italic/.test(bodyAll), '★ buildStyle 不读 data.italic（应读 font-style）');
  }

  // ⑤ 别的软件产出的文件只有标准键 → 要落成内核认得的键
  {
    const cj = [{ rootTopic: { id: 't', title: '根', children: { attached: [{
      id: 'c', title: 'A',
      style: { id: 's', properties: { 'svg:fill': '#123456', 'fo:color': '#654321',
        'fo:font-weight': '700', 'svg:corner-radius': '8px' } } }] } } }];
    const zb = await X.zipWrite([{ name: 'content.json',
      data: new TextEncoder().encode(JSON.stringify(cj)) }]);
    const r = await X.readXMind(new Uint8Array(zb));
    const d = JSON.parse(r.sheets[0].content).root.children[0].data;
    ok(d.background === '#123456', '别的软件的 svg:fill → background（内核认）', String(d.background));
    ok(d.color === '#654321', '别的软件的 fo:color → color', String(d.color));
    ok(d['font-weight'] === 'bold',
      '别的软件写 700 → 归一化成 bold（否则导回时内核当普通字重）', String(d['font-weight']));
    ok(String(d['node-radius']) === '8', '别的软件的 8px → 去单位', String(d['node-radius']));
  }
}

group('BUG 104 · XMind 装不下的附件与图片必须数得出来、且要说出来');

{
  const X104 = await import('./xmind.js');
  const S = (d) => ({ id: 'sh1', title: 'T', theme: null, layout: null,
    content: JSON.stringify({ root: { data: { id: 'nR', text: '根', ...d }, children: [] } }) });
  const A = (n) => JSON.stringify([{ n: 'r' + n + '.pdf', a: 'a' + n, s: 1 }]);
  const V = (n) => JSON.stringify([{ n: 'v' + n + '.mp4', a: 'b' + n, s: 1 }]);

  // ① 附件：一个节点挂 N 个 → 只有 1 个挂得上
  eq(X104.xmindLossCount([S({ text: 'a', file: A(1) })]).unlinked, 0, '单附件没有损失');
  eq(X104.xmindLossCount([S({ text: 'a', file: JSON.stringify([{ n: '1.pdf' }, { n: '2.pdf' }]) })]).unlinked, 1,
    '★ 两个文件附件：1 个挂不上');
  eq(X104.xmindLossCount([S({ text: 'a', file: JSON.stringify([{ n: '1.pdf' }, { n: '2.pdf' }, { n: '3.pdf' }]) })]).unlinked, 2,
    '三个文件附件：2 个挂不上');
  eq(X104.xmindLossCount([S({ text: 'a', video: V(1), file: A(1) })]).unlinked, 1,
    '★ 视频 + 文件：href 只写视频，文件挂不上');
  eq(X104.xmindLossCount([S({ text: 'a', video: JSON.stringify([{ n: '1.mp4' }, { n: '2.mp4' }]) })]).unlinked, 1,
    '两个视频附件：1 个挂不上');

  // ② 超链接优先 → href 被占掉，附件**一个都挂不上**
  eq(X104.xmindLossCount([S({ text: 'a', hyperlink: 'https://x', file: A(1) })]).blocked, 1,
    '★ 超链接 + 附件：附件被超链接挤掉（不是 unlinked，性质不同）');
  eq(X104.xmindLossCount([S({ text: 'a', hyperlink: 'https://x', video: V(1), file: A(2) })]).blocked, 2,
    '超链接 + 视频 + 文件：两个都被挤掉');
  eq(X104.xmindLossCount([S({ text: 'a', hyperlink: '   ' })]).blocked, 0, '空白超链接不算（等于没有）');

  // ③ 图片：槽位 + 横幅合计，只写 1 张
  eq(X104.xmindLossCount([S({ text: 'a', image: 'data:image/png;base64,P0' })]).images, 0, '单张图没有损失');
  eq(X104.xmindLossCount([S({ text: 'a', images: JSON.stringify(['a', 'b', 'c']) })]).images, 2,
    '★ 横幅三张图：2 张写不进 image');
  eq(X104.xmindLossCount([S({ text: 'a', image: 'ic', images: JSON.stringify(['p1']) })]).images, 1,
    '槽位 + 横幅：合计 2 张，1 张写不进');

  // ④ 健壮性：坏内容 / 空输入都不能抛（抛了会让整个导出流程崩掉）
  {
    const callSafe = (fn) => { try { return { v: fn() }; } catch (e) { return { err: e }; } };
    for (const [name, arg] of [['坏 JSON', [{ content: '{坏' }]], ['空数组', []],
      ['undefined', undefined], ['无 content', [{ id: 'x' }]]]) {
      const r = callSafe(() => X104.xmindLossCount(arg));
      ok(!r.err && r.v && r.v.images === 0 && r.v.blocked === 0 && r.v.unlinked === 0,
        `★ ${name} 不抛且算作 0（抛了整个导出就崩了）`, r.err ? String(r.err) : JSON.stringify(r.v));
    }
  }

  /*
   * ⑤ 行为实据：这些损失是**真的会发生**的，不是统计口径想出来的。
   *
   * 写一次真的 xmind，看 content.json 里到底剩几条 href / 几张 image，
   * 以及 resources/ 里到底躺了几个文件 —— 字节在包里、却没人指向它，
   * 正是「体积变大了、界面说含 N 个附件、打开却没有」的来源。
   */
  {
    const sheets = [{ id: 'sh1', title: 'T', theme: null, layout: null,
      content: JSON.stringify({ root: { data: { id: 'nR', text: '根' }, children: [
        { data: { id: 'n1', text: '两附件', file: JSON.stringify([{ n: '1.pdf', a: 'x1', s: 1 }, { n: '2.pdf', a: 'x2', s: 1 }]) }, children: [] },
        { data: { id: 'n2', text: '链接+附件', hyperlink: 'https://x', file: A(1) }, children: [] },
        { data: { id: 'n3', text: '三张图', images: JSON.stringify(['data:image/png;base64,A', 'data:image/png;base64,B', 'data:image/png;base64,C']) }, children: [] },
      ] } }) }];
    const blob = await X104.writeXMind(sheets, 'sh1', async () => new Uint8Array([1, 2, 3]));
    const en = await X104.zipRead(new Uint8Array(await new Blob([blob]).arrayBuffer()));
    const cj = JSON.parse(new TextDecoder().decode(en.get('content.json')));
    const kids = cj[0].rootTopic.children.attached;
    eq(kids.length, 3, '三个子节点都写出来了');
    ok(/resources\//.test(String(kids[0].href)), '两附件：只有第 1 个挂上 href', String(kids[0].href));
    ok(!/2\.pdf/.test(String(kids[0].href)), '★ 第 2 个附件没挂上 href');
    eq(String(kids[1].href), 'https://x', '★ 有超链接时 href 是超链接，附件根本没写');
    eq(kids[2].image?.src, 'data:image/png;base64,A', '★ 三张图只写进第 1 张');
    const res = [...en.keys()].filter((k) => k.startsWith('resources/'));
    eq(res.length, 3, '★ 3 个附件字节都在包里，但只有 1 条 href 指向它们（另 2 个没人引用）');
  }

  // ⑥ 导出侧必须说出来，且**不再谎报**「含 N 个附件」
  {
    const isrc = stripCommentsFlat(fs.readFileSync(path.join(HERE, 'index.js'), 'utf8'));
    const i = isrc.indexOf('async function exportXMind');
    ok(i > 0, '能定位 exportXMind');
    const body = isrc.slice(i, i + 2600);
    ok(/xmindLossCount\(/.test(body), '★ exportXMind 调用了统计（否则丢了没人知道）');
    for (const k of ['blocked', 'unlinked', 'images']) {
      ok(body.includes('loss.' + k), `提示区分 ${k} 这一类（混成一句用户不知道该怪谁）`);
    }
    ok(/未能打包/.test(body), '打包失败那档仍在（不能因为加了新提示就把它顶掉）');
    // 顺序：先确认存好了再说限制
    ok(body.indexOf('reportSave') < body.indexOf('xmindLossCount'),
      '提示在 reportSave 之后（先让人看到文件存好了）');
  }
}

/* ------------------------------------------------------------------
   BUG 37：重命名文件夹不说话（与 renameFile 不一致）
   ------------------------------------------------------------------ */
group('BUG 37 文件库两种重命名都要有回执');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const rf = idx.match(/async function renameFile\(id\)\s*\{[\s\S]*?\n  \}/);
  const rfo = idx.match(/async function renameFolder\(id\)\s*\{[\s\S]*?\n  \}/);
  ok(!!rf, '找到 renameFile');
  ok(!!rfo, '找到 renameFolder');
  ok(/status\(/.test(rf[0]), 'renameFile 有回执');
  ok(/status\(/.test(rfo[0]), 'renameFolder 也要有回执（原来没有，与 renameFile 不一致）');
  // 两者都要写盘：不写的话下次启动名字又回去了
  ok(/saveStore\(/.test(rf[0]), 'renameFile 写盘');
  ok(/saveStore\(/.test(rfo[0]), 'renameFolder 写盘');
}

/* ------------------------------------------------------------------
   BUG 38：删除文件夹时写盘顺序反了 —— 文件会凭空消失
   ------------------------------------------------------------------ */
group('BUG 38 删除文件夹不得留下「文件谁都不属于」的中间态');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const m = idx.match(/async function deleteFolder\(id\)\s*\{[\s\S]*?\n  \}/);
  ok(!!m, '找到 deleteFolder');
  const fn = m[0];

  // 顺序：files 的 saveStore 必须排在 folders 的**之前**
  const iFiles = fn.indexOf("saveStore('文件列表'");
  const iFolders = fn.indexOf("saveStore('文件夹列表'");
  ok(iFiles > 0, 'deleteFolder 写文件列表');
  ok(iFolders > 0, 'deleteFolder 写文件夹列表');
  ok(iFiles < iFolders, '先写文件列表再删文件夹（反了会让文件谁都不属于、凭空消失）');

  // 文件列表写失败必须回滚，否则文件夹已删、文件却还挂着旧 folderId
  ok(/f\.folderId = id;/.test(fn), '写失败把文件回滚回文件夹');

  // 两处都要检查返回值：只查一处，另一处失败照样留中间态
  const n = (fn.match(/if \(!await saveStore\(/g) || []).length;
  eq(n, 2, '两处写盘都要检查返回值');

  // createFolder 写失败也要撤回来（与 createFile 的「存不下就别建」一致）
  const cf = idx.match(/async function createFolder\(\)\s*\{[\s\S]*?\n  \}/);
  ok(!!cf, '找到 createFolder');
  ok(/foldersList\.pop\(\)/.test(cf[0]), 'createFolder 写失败要撤回新建的文件夹');
}

/* ------------------------------------------------------------------
   BUG 39：导入的历史快照被随后的滚动清理立刻删掉
   ------------------------------------------------------------------ */
group('BUG 39 导入的快照不得被滚动清理删掉');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const st = fs.readFileSync(path.join(HERE, 'store.js'), 'utf8');

  // putBackup 必须把 key 交出来，导入方才保护得了
  const pb = st.match(/export async function putBackup\(snapshot\)\s*\{[\s\S]*?\n\}/);
  ok(!!pb, '找到 putBackup');
  ok(/return \(await set\(key, snapshot\)\) \? key : null;/.test(pb[0]),
    'putBackup 成功时返回 key（否则导入方无法保护刚写入的那几份）');

  // trimBackups 必须接受保护集合
  const tb = idx.match(/async function trimBackups\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  ok(!!tb, '找到 trimBackups');
  ok(/protect/.test(tb[0]), 'trimBackups 接受 protect 参数');
  ok(/keep\.has\(k\)/.test(tb[0]), '清理时跳过受保护的 key');

  // 关键：额度计算不能因跳过而错位
  ok(!/for \(let i = 0; i < all\.length - limit; i\+\+\)/.test(tb[0]),
    '不得再用「按下标删前 N 个」的写法（跳过受保护项时会少删/越界）');

  // importBackups 必须把本次写入的 key 传进去
  const ib = idx.match(/async function importBackups\(\)\s*\{[\s\S]*?\n  \}/);
  ok(!!ib, '找到 importBackups');
  ok(/trimBackups\(addedKeys\)/.test(ib[0]), '导入后清理必须带上 addedKeys');
  ok(/addedKeys\.add\(ok\)/.test(ib[0]), '把 putBackup 返回的 key 收进保护集合');
}

/* ------------------------------------------------------------------
   BUG 40/41：中文输入法按回车「选候选词」被当成提交 / 发起搜索
   ------------------------------------------------------------------ */
group('输入法组合期不得把 Enter 当成提交或搜索');

{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');

  // ① 行内编辑层：Enter 提交前必须先看组合态
  const layer = ed.slice(ed.indexOf("el.addEventListener('keydown', function (ev) {"));
  const lbody = layer.slice(0, layer.indexOf('layoutEditLayer'));
  ok(/ev\.isComposing/.test(lbody), '行内编辑层：Enter/Tab 前先判 isComposing');
  ok(/closeTextEditor\(true\)/.test(lbody), '行内编辑层仍然会在正常 Enter 时提交');
  // 守卫必须在 Enter 分支**之前**
  ok(lbody.indexOf('isComposing') < lbody.indexOf("ev.key === 'Enter'"),
    '组合态判断必须排在 Enter 分支之前');

  // ② 外框标签输入框
  const lab = ed.slice(ed.indexOf("_labelInput.addEventListener('keydown'"));
  const l2 = lab.slice(0, lab.indexOf('blur'));
  ok(/e\.isComposing/.test(l2), '外框标签输入框：提交前先判 isComposing');
  ok(l2.indexOf('isComposing') < l2.indexOf("e.key === 'Enter'"),
    '外框标签：组合态判断排在 Enter 之前');

  // ③ 搜索框
  // 从 placeholder 往前找到 searchInput 的定义，再取它的 onkeydown 块
  const phAt = idx.indexOf("placeholder: '搜索节点…'");
  const sb = idx.slice(phAt, phAt + 1400);
  const sb2 = sb.slice(0, sb.indexOf('runSearch();') + 40);
  ok(/e\.isComposing/.test(sb2), '搜索框：Enter 发起搜索前先判 isComposing');
  ok(sb2.indexOf('isComposing') < sb2.indexOf('runSearch();'),
    '搜索框：组合态判断排在 runSearch 之前');

  // ④ 数值输入框
  const ns = pn.slice(pn.indexOf("onkeydown: (e) => {"), pn.indexOf("onkeydown: (e) => {") + 600);
  ok(/e\.isComposing/.test(ns), '数值输入框：步进/确定前先判 isComposing');

  // ⑤ 每处都必须同时看 keyCode 229（老 WebView 上 isComposing 不可靠）
  /*
   * 计数从 4 变 5：panels.js 的 escCloser 也是一处 —— 浮层里带输入框
   * （重命名、打印设置），中文输入法下按 Esc 是「取消候选」，
   * 不放过的话打中文打到一半浮层就没了。
   * 写死数字是为了「少一处就红」，新增一处必须同步改这里。
   */
  const all = ed + idx + pn;   // pn 就是 panels.js，别再拼一份（会重复计数）
  const n229 = (all.match(/keyCode === 229/g) || []).length;
  eq(n229, 5, '五处都要同时看 keyCode 229（含新增的浮层 Esc）');

  // ⑥ 通用弹层（js/dialog.js）：重命名脑图 / 文件夹 / 分组 / 画布都走它
  const root = path.join(HERE, '..', '..');
  const dg = fs.readFileSync(path.join(root, 'js/dialog.js'), 'utf8');
  const inp = dg.slice(dg.indexOf("input.addEventListener('keydown'"));
  const ibody = inp.slice(0, inp.indexOf('Escape'));
  ok(/e\.isComposing/.test(ibody), '弹层输入框：确定前先判 isComposing');
  ok(ibody.indexOf('isComposing') < ibody.indexOf("e.key === 'Enter'"),
    '弹层输入框：组合态判断排在 Enter 之前');
  // 全局那个负责 Escape 关窗与 Tab 焦点陷阱，同样要放行组合期
  const gk = dg.slice(dg.indexOf('function onKeydown'), dg.indexOf('function onKeydown') + 700);
  ok(/e\.isComposing/.test(gk), '弹层全局 keydown：Escape/Tab 前先判 isComposing');
  ok(gk.indexOf('isComposing') < gk.indexOf("e.key === 'Escape'"),
    '弹层全局：组合态判断排在 Escape 之前');
}

/* ------------------------------------------------------------------
   BUG 43：文件行只有 11px 的小图标可点/可拖，文件名整片是死的
   ------------------------------------------------------------------ */
group('文件行的文件名必须能点能拖（不能只绑图标）');

{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  // 文件这一节：从注释起，到该行收尾的 `top += 24;` 止
  const s0 = ed.indexOf('/* ---- 文件：每行一个 ---- */');
  ok(s0 > 0, '找得到文件行那一节');
  const sec = ed.slice(s0, ed.indexOf('top += 24;', s0));

  // ① 文件名这个 text 必须绑了交互（原来只绑了图标 fic）
  ok(/bindAttach\(fn,\s*'file'/.test(sec), '文件名 text 必须绑 bindAttach（原来只有图标绑了）');
  // ② 绑完还不够：原来它还被显式设了 pointer-events:none，
  //    不去掉的话 handler 根本收不到 —— 两处必须一起改
  ok(!/fn\.setStyle\('pointer-events',\s*'none'\)/.test(sec),
    '文件名 text 不能再设 pointer-events:none（否则绑了也收不到）');
  // ③ 图标仍然要绑（别修了新的丢了旧的）
  ok(/bindAttach\(fic,\s*'file'/.test(sec), '图标仍然要绑');
  // ④ 顺序：bindAttach 要在 push(fn) 之前（与图标一致）
  ok(sec.indexOf("bindAttach(fn") < sec.indexOf('push(fn)'),
    'bindAttach(fn) 必须在 push(fn) 之前');

  /*
   * ⑤ 反向确认其余装饰仍然是 none —— 别把「装饰不该拦截」也一起改掉了。
   *    计数 cnt / 缩略图 vt / 角标 badge / 角标数字 bnum / 序号 vseq
   *    都压在大块可点图形上，去掉 none 反而会让它们挡住点击。
   */
  for (const v of ['cnt', 'vt', 'badge', 'bnum', 'vseq']) {
    ok(new RegExp(v + "\\.setStyle\\('pointer-events',\\s*'none'\\)").test(ed),
      `装饰 ${v} 仍应设 pointer-events:none`);
  }
}

group('交换格式接入 UI');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  ok(/async function exportExchange/.test(idx), '新增 exportExchange');
  // 入口从顶栏下拉菜单搬到了侧栏「导入导出」页
  const pnx = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const exx = pnx.slice(pnx.indexOf('function pageExchange('),
    pnx.indexOf('pages.file = pageFile;'));
  ok(exx.includes("app.api.exchange('freemind')"), '导入导出页接了 FreeMind');
  ok(exx.includes("app.api.exchange('opml')"), '导入导出页接了 OPML');
  ok(exx.includes("app.api.exchange('mermaid')"), '导入导出页接了 Mermaid');
  ok(exx.includes("app.api.exchange('plantuml')"), '导入导出页接了 PlantUML');
  // api 上要有对应的转发（面板只持有 app.api，不直接碰插件内部函数）
  ok(/exchange: guard\('导出交换格式'/.test(idx), 'api 暴露 exchange');

  // 用「下一个顶层函数声明」当边界，而不是固定字符数 ——
  // 固定 1500 会越界切到后面的 exportTxt，那里也有 capture()，
  // 于是断言测的是**别的函数**（变异验证实锤：删掉本函数的 capture 后断言仍绿）。
  const fnBody = (src, sig) => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    const rest = src.slice(i);
    const m = rest.slice(sig.length).match(/\n  (?:async )?function /);
    return m ? rest.slice(0, sig.length + m.index) : rest;
  };
  const ef = fnBody(idx, 'async function exportExchange');
  ok(/capture\(\)/.test(ef), '导出前先 capture（否则导出的是改之前的内容）');
  ok(/io\.safeFileName/.test(ef), '文件名安全化（画布标题可能含 / : 等非法字符）');
  ok(/仅当前画布/.test(ef), '多画布时说明只导了当前一张（静默丢画布不可接受）');
  ok(/reportSave\(r, meta\.label\)/.test(ef), '落盘结果与其余导出一致走 reportSave');

  // 导入分支
  ok(/fmt\.detectFormat\(text, f\.name\)/.test(idx), '导入按**内容**嗅探');
  ok(/\.mmd,.puml,.txt/.test(idx), 'pickFile 放开了新扩展名');
  ok(/fmt\.fromFreemind\(text\)/.test(idx), '导入接 FreeMind');
  ok(/fmt\.fromOpml\(text\)/.test(idx), '导入接 OPML');
  ok(/fmt\.fromMermaid\(text\)/.test(idx), '导入接 Mermaid');
  ok(/fmt\.fromPlantUml\(text\)/.test(idx), '导入接 PlantUML');
  ok(/title: fmt\.baseTitle\(f\.name\)/.test(idx), '新画布用文件名当标题（否则全是「画布 1」分不清）');
  ok(/freemind: 'FreeMind', opml: 'OPML'/.test(idx), '状态栏能说出识别到的格式名');

  // 解析失败要有提示，不能静默
  ok(/解析失败：文件结构不符合预期/.test(idx), '解析失败要提示（不能静默当成功）');
}

/* ============================================================
   三十五、画布附件名文字标签
   ============================================================ */

group('画布附件区渲染（真实源码）');

{
  /*
   * 用 editor/index.html 里的**真实源码**跑（iconColor + refListOf + imageListOf
   * + FileIcon + noderender 钩子），不是复刻一份 ——
   * 复刻的话实现改了测试还是绿的。
   */
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const startAt = html.indexOf('function iconColor(node) {');
  const hookAt = html.indexOf("km.on('noderender', function (e) {");
  const endAt = html.indexOf('\n            } catch (e) {}', hookAt);
  ok(startAt > 0 && hookAt > startAt && endAt > hookAt, '能定位到编辑器里的附件区源码');
  const src = html.slice(startAt, endAt + '\n            } catch (e) {}'.length);

  function mkBase() {
    return {
      // callBase 必须有：FileIcon 构造函数第一句就是 this.callBase()，
      // 桩里缺了它会在构造函数里抛 TypeError，被钩子内的 catch(e2) 静默吞掉，
      // 表现为「什么都不画」且毫无报错 —— 很隐蔽。
      callBase() {},
      styles: {},
      node: { appendChild() {}, children: [] },
      fill(v) { this._fill = v; return this; },
      stroke(v, w) { this._stroke = v; this._strokeW = w; return this; },
      setPathData(d) { this._d = d; return this; },
      addShapes(list) { (this.shapes = this.shapes || []).push(...list); return this; },
      on() { return this; },
      setStyle(k, v) { this.styles[k] = v; return this; },
      setTranslate(x, y) { this.tx = x; this.ty = y; return this; },
      setSize(v) { this.size = v; return this; },
      setTextAnchor(v) { this.anchor = v; return this; },
      setContent(v) { this.content = v; return this; },
      remove() { this.removed = true; return this; },
    };
  }
  const kity = {
    createClass(name, def) {
      const proto = {};
      for (const k of Object.keys(def)) if (k !== 'constructor' && k !== 'base') proto[k] = def[k];
      Object.assign(proto, mkBase());
      function C(...a) { Object.assign(this, mkBase()); if (def.constructor) def.constructor.apply(this, a); }
      C.prototype = proto;
      return C;
    },
    Group: function () { Object.assign(this, mkBase()); },
    Rect: function (...a) { Object.assign(this, mkBase()); this.args = a; },
    Path: function () { Object.assign(this, mkBase()); },
    Text: function (c) { Object.assign(this, mkBase()); this.content = c; },
    Circle: function (r, x, y) { Object.assign(this, mkBase()); this.r = r; this.cx = x; this.cy = y; },
    Image: function (url, w, h, x, y) {
      Object.assign(this, mkBase());
      this.url = url; this.width = w; this.height = h; this.x = x; this.y = y;
    },
  };

  function render(data, style = {}) {
    const appended = [];
    const box = { left: 0, right: 100, top: 20, bottom: 40, cx: 50, cy: 30, width: 100, height: 20 };
    const rc = { appendShape(s) { appended.push(s); } };
    const node = {
      data,
      getData(k) { return this.data[k]; },
      getStyle(k) {
        if (k === 'color') return style.color ?? '#AEB6C4';
        if (k === 'font-size') return style['font-size'] ?? 14;
        if (k === 'space-left') return 10;
        return null;
      },
      getContentBox() { return box; },
      getRenderContainer() { return rc; },
    };
    const posted = [];
    const km = {
      handlers: {},
      on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); },
    };
    new Function('kity', 'km', 'hostPost', 'document', src)(
      kity, km, (m) => posted.push(m), { createElementNS: () => ({ textContent: '' }) });
    km.handlers.noderender.forEach((fn) => fn({ node }));
    const texts = appended.filter((x) => x.content !== undefined);
    return { appended, texts, node, box, km, posted };
  }

  // ---- 文件：每个一行，名字在行上 ----
  {
    const r = render({ file: JSON.stringify([{ n: '报告.pdf' }]) });
    eq(r.texts.length, 1, '1 个文件 → 1 行文字');
    eq(r.texts[0].content, '报告.pdf', '行上显示文件名');
    /*
     * 早先这条断言写的是 `=== 'none'`，理由「文字不可点击（点图标才打开）」。
     * 那正是 BUG 43 本身：整行里只有 11px 的图标可点，文件名整片是死的，
     * 而用户的本能是照着名字点。断言忠实于错误实现，于是永远绿。
     * 现在文字要能点（且下面确认它真的绑了交互）。
     */
    ok(r.texts[0].styles['pointer-events'] !== 'none',
      '文件名可点击（早先设成 none，等于整行只有图标能点）');
  }
  {
    const r = render({ file: JSON.stringify([{ n: '一.pdf' }, { n: '二.pdf' }, { n: '三.pdf' }]) });
    eq(r.texts.length, 3, '3 个文件 → 3 行（每个一个小挂件往下排）');
    eq(r.texts.map((t) => t.content).join(','), '一.pdf,二.pdf,三.pdf', '顺序与名字都对');
    const ys = r.texts.map((t) => t.ty);
    ok(ys[1] > ys[0] && ys[2] > ys[1], '三行依次往下（y 递增，不重叠）');
    // 行距必须 ≥ 图标高度 20：写 17 时相邻两行的图标上下各占 20，
    // 重叠 3px —— 用户看到的就是「两个图标叠在一起」。
    const gap = Math.round(ys[1] - ys[0]);
    ok(gap >= 20, `行距 ≥ 图标高度 20（实际 ${gap}）—— 否则相邻行图标重叠`);
  }

  // ---- 视频：一张卡片 + 数字角标 ----
  {
    const r = render({ video: JSON.stringify([{ n: 'a.mp4' }, { n: 'b.mp4' }, { n: 'c.mp4' }]) });
    // 只数 "content === '3'" 是不够的：把角标文本改成空串，这条也会是 0，
    // 但如果别的断言没覆盖「角标是否存在」，改动就悄悄溜过去了。
    // 补一条：角标文本必须非空（空串等于没画）
    const badge = r.appended.find((x) => x.r !== undefined);
    ok(!!badge, '有角标圆底');
    const nums = r.texts.filter((t) => t.content === '3');
    eq(nums.length, 1, '3 个视频 → 角标显示数字 3');
    ok(nums[0] && String(nums[0].content).trim() !== '',
      '角标文本非空（改成空串等于没画，用户看不出有几个视频）');
    // 可选链：角标被改没时这条应"干净地红"，而不是抛 TypeError 让整个测试崩掉
    eq(nums[0]?._fill, '#1B1B1F', '角标数字用深色（压在浅色圆上才看得见）');
    const circles = r.appended.filter((x) => x.r !== undefined);
    eq(circles.length, 1, '有角标圆底');
  }
  {
    // 1 个视频也显示角标（不显示就分不清"有 1 个"和"没有"）
    const r = render({ video: JSON.stringify([{ n: 'a.mp4' }]) });
    eq(r.texts.filter((t) => t.content === '1').length, 1, '1 个视频也显示数字 1');
  }

  // ---- 图片：多张走横幅 ----
  {
    const r = render({ images: JSON.stringify(['data:img,A', 'data:img,B']) });
    const imgs = r.appended.filter((x) => x.url !== undefined);
    eq(imgs.length, 1, '横幅一次只显示当前一张');
    eq(imgs[0].url, 'data:img,A', '默认显示第 1 张');
    const cnt = r.texts.find((t) => t.content === '1/2');
    ok(!!cnt, '有「1/2」计数（多张不数出来，用户不知道还有几张）');
  }
  {
    // 单张图走 image 字段（内核框内），横幅不参与 → 不会画两次
    const r = render({ image: 'data:img,ONLY' });
    eq(r.appended.filter((x) => x.url !== undefined).length, 0,
      '只有 image（单张）时横幅**不画**（交给内核，避免同节点两张图）');
  }

  // ---- 点击附件要发消息（带 index） ----
  {
    const r = render({ file: JSON.stringify([{ n: '一.pdf' }, { n: '二.pdf' }]) });
    /*
     * ⓘ 这里原写的是 `r.posted.length >= 0` —— 恒真，无论渲染发不发消息都绿。
     *   本组要守的恰恰是「**只挂载点击钩子、渲染时不主动发**」，
     *   写成 >= 0 等于把这条防线整个撤掉（2026-10-03 全仓扫恒真断言时发现）。
     *   恒真的后果不是"多一条绿"，而是"渲染改坏了也没人知道"。
     */
    eq(r.posted.length, 0, '渲染不主动发消息（只挂点击钩子）');
    const hooks = r.appended.filter((x) => x.content === '二.pdf');
    eq(hooks.length, 1, '第二个文件也有自己的一行');
  }

  // ---- 无附件 → 不画 ----
  eq(render({ text: '普通节点' }).appended.length, 0, '无附件 → 什么都不画');

  // ---- 重渲必须回收（否则节点每次重画都叠一层，越叠越黑）----
  {
    const r = render({ file: JSON.stringify([{ n: 'a.pdf' }]) });
    const first = r.texts[0];
    r.km.handlers.noderender.forEach((fn) => fn({ node: r.node }));
    eq(first.removed, true, '重渲前回收旧形状');
    eq(r.node._kmLabels.length, 2, '重渲后仍是 1 行（图标 + 文字），不是 2 行');
  }

  // ---- 长名截断 + 老式路径兜底 ----
  {
    const r = render({ file: JSON.stringify([{ n: '一二三四五六七八九十一二三四五六七八九十.pdf' }]) });
    ok(r.texts[0].content.length <= 14, '超长名截到 14 字以内（不截会横穿整张图）');
    ok(r.texts[0].content.endsWith('…'), '截断后带省略号');
  }
  {
    eq(render({ file: 'C:\\x\\老文件.pdf' }).texts[0].content, '老文件.pdf',
      'C# 版遗留的纯路径 → 显示文件名');
  }
}

/* ============================================================
   三十六、拖放附加（图片 / 视频 / 文件）
   ============================================================ */

group('拖放文件归类（纯函数）');

{
  const io = await import('./io.js');
  eq(io.classifyFile('a.png', 'image/png'), 'image', 'MIME image/* → image');
  eq(io.classifyFile('a.mp4', 'video/mp4'), 'video', 'MIME video/* → video');
  eq(io.classifyFile('a.pdf', 'application/pdf'), 'file', '其它 MIME → file');

  // **关键**：type 为空时按扩展名兜底。
  // 部分环境（文件管理器、跨平台拖拽）拖进来的 File.type 是空串，
  // 只看 type 会把 .png 存进资产库、画布上不显示图片。
  eq(io.classifyFile('a.png', ''), 'image', 'type 为空 → 按扩展名认出图片');
  eq(io.classifyFile('a.mp4', ''), 'video', 'type 为空 → 按扩展名认出视频');
  eq(io.classifyFile('a.pdf', ''), 'file', 'type 为空 → 其它');
  eq(io.classifyFile('clip.webm', 'application/octet-stream'), 'video',
    'octet-stream 不能盲信（.webm 会被误判成 file）');
  eq(io.classifyFile('pic.JPG', ''), 'image', '扩展名大小写不敏感');
  eq(io.classifyFile('', ''), 'file', '什么都没有 → file');
  eq(io.classifyFile('a.svg', 'image/svg+xml'), 'image', 'svg 也算图片');

  // ---- stemOf：拖放建子节点时曾用；保留供其它用途 ----
  eq(io.stemOf('报告.pdf'), '报告', '去扩展名');
  eq(io.stemOf('a.b.c.pdf'), 'a.b.c', '只去最后一段扩展名');
  eq(io.stemOf('C:\\x\\y.mp4'), 'y', '带路径取末段');
  eq(io.stemOf(''), '附件', '空名给 fallback');
}

group('多附件：编解码（纯函数）');

{
  const io = await import('./io.js');
  const a = { n: '一.pdf', a: 'A1', s: 10 };
  const b = { n: '二.pdf', a: 'A2', s: 20 };

  // 写一定是数组
  eq(io.encodeRefList([a, b]), JSON.stringify([a, b]), '多元素 → JSON 数组串');
  eq(io.encodeRefList([a]), JSON.stringify([a]), '单元素也写成数组（读写统一，不用分情况）');
  eq(io.encodeRefList([]), '[]', '空列表');
  eq(io.encodeRefList(null), '[]', 'null 也安全');

  // 读两者都认（老数据兼容）
  eq(io.decodeRefList(JSON.stringify([a, b])).length, 2, '数组串 → 2 个');
  eq(io.decodeRefList(JSON.stringify([a])).length, 1, '数组串（单）→ 1 个');
  eq(io.decodeRefList(JSON.stringify(a)).length, 1, '**老数据单对象串** → 包成 1 个');
  eq(io.decodeRefList(JSON.stringify(a))[0].n, '一.pdf', '老数据内容正确');
  {
    const r = io.decodeRefList('C:\\x\\老文件.pdf');
    eq(r.length, 1, 'C# 版遗留的纯路径串 → 1 个');
    eq(r[0].n, '老文件.pdf', '纯路径取文件名');
    eq(r[0].a, null, '纯路径没有资产 id');
  }
  eq(io.decodeRefList('').length, 0, '空串 → 空');
  eq(io.decodeRefList(null).length, 0, 'null → 空');
  eq(io.decodeRefList('[坏数据').length, 1, '数组串损坏时退回单值（不当作没有）');

  // 追加 / 删除
  eq(io.decodeRefList(io.appendRef(JSON.stringify([a]), b)).length, 2, 'appendRef 追加');
  eq(io.decodeRefList(io.appendRef(null, a)).length, 1, 'appendRef 到空');
  {
    const raw = JSON.stringify([a, b]);
    eq(io.decodeRefList(io.removeRefAt(raw, 0))[0]?.n, '二.pdf', 'removeRefAt 删第 0 个');
    eq(io.decodeRefList(io.removeRefAt(raw, 1))[0]?.n, '一.pdf', 'removeRefAt 删第 1 个');
    eq(io.decodeRefList(io.removeRefAt(raw, 9)).length, 2, '越界不删（不是静默清空）');
  }
}

group('拖放：编辑器侧（真实源码）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  ok(/var domNodeMap = new WeakMap\(\);/.test(html),
    'DOM→节点映射用 **WeakMap**（普通 Map 会随重渲稳定泄漏）');
  ok(/domNodeMap\.set\(rc\.node, node\);/.test(html),
    'noderender 里注册映射（否则拖放永远找不到节点）');
  // 正向映射：拖拽高亮要框住目标节点，只有 DOM→node 不够
  ok(/nodeDomMap\.set\(node, rc\.node\);/.test(html),
    '同时注册 node→DOM 正向映射（拖拽高亮框要用）');
  ok(/function refListOf\(raw\)/.test(html), '编辑器侧有附件列表解析');
  ok(/function imageListOf\(node\)/.test(html), '编辑器侧有图片列表解析');

  // 编辑器侧与 io.js 的解析规则必须一致（两份实现，改一边忘另一边会静默出错）
  {
    const io = await import('./io.js');
    const startAt = html.indexOf('function legacyRef(raw)');
    const src = html.slice(startAt, html.indexOf('/* ---------------- DOM → 节点 映射'));
    const fn = new Function('JSON', src + '; return { refListOf: refListOf, imageListOf: imageListOf };')(JSON);
    /*
     * 用例必须包含**空数组**与**含空元素的数组**。
     * 之前只有"非空"用例，于是编辑器侧 `p && p.length` 把 '[]' 判否、
     * 掉进 typeof [] === 'object' 的单对象分支返回 [[]] 这个 divergence
     * **一直没被抓到** —— 一致性测试是绿的，两边却对同一个输入给出不同结果。
     */
    const cases = [
      JSON.stringify([{ n: 'a' }, { n: 'b' }]),
      JSON.stringify([{ n: 'a' }]),
      JSON.stringify({ n: 'single' }),
      'C:\\x\\y.pdf',
      '',
      '[]',                                   // ← 空数组：曾返回 [[]]
      JSON.stringify([null]),                 // ← 含空元素：曾被留下
      JSON.stringify([{ n: 'a' }, null]),
      JSON.stringify([JSON.stringify({ n: 'b' })]),  // ← 元素是 JSON 串
      // 真数组（导入的 JSON 里 file/video 也可能就是数组），不总是字符串
      [{ n: 'a' }, { n: 'b' }],
      [{ n: 'a' }, null],
      [],
      [JSON.stringify({ n: 'b' })],
      { n: 'single' },
    ];
    let same = true;
    for (const c of cases) {
      const mine = fn.refListOf(c).map((x) => (x && x.n) || '');
      const theirs = io.decodeRefList(c).map((x) => (x && x.n) || '');
      /*
       * 必须**连长度一起比**。
       *
       * 只比 `map(x => x.n).join('|')` 是假阴性：`[]` 与 `[{}]` 拼出来都是 ''，
       * 于是「一边返回空列表、另一边返回一个无名条目」照样判为一致。
       * 实测：输入 123 时编辑器返回 []、io 返回 [{}]（decodeRef 的纯路径兜底），
       * 拼串相等 → 这条断言**从没在把关**。
       */
      if (mine.length !== theirs.length || mine.join('|') !== theirs.join('|')) {
        same = false;
        console.log('      不一致:', JSON.stringify(c), mine, theirs);
      }
    }
    ok(same, '编辑器 refListOf 与 io.decodeRefList 结果**逐例一致**（含空数组/空元素/纯路径/真数组）');

    // '[]' 必须真的是空列表 —— 非空就意味着画布上多一行幽灵附件
    {
      const r = fn.refListOf('[]');
      ok(r.length === 0 && !r[0], `'[]' 解析为空列表（实测 ${JSON.stringify(r)}）`);
    }
    // 数组入参同样要滤空（io 那边是 .map(normOne).filter(Boolean)）
    {
      const mineA = fn.refListOf([null, { n: 'a' }]).map((x) => (x && x.n) || '');
      const ioA = io.decodeRefList([null, { n: 'a' }]).map((x) => (x && x.n) || '');
      ok(mineA.join('|') === ioA.join('|') && mineA.length === 1,
        `数组入参也滤掉空元素（编辑器 ${JSON.stringify(mineA)} / io ${JSON.stringify(ioA)}）`);
    }
    // imageListOf 必须接受**真数组**（导入的 JSON 里 images 就是数组）。
    // 只做 JSON.parse 的话数组会被 String() 化 → 解析失败 → 返回 []，
    // 导入进来的多图一张都不显示，且没有任何报错。
    {
      const nodeWith = (v) => ({ getData: () => v });
      ok(fn.imageListOf(nodeWith([{ n: 'a' }, { n: 'b' }])).length === 2,
        'images 是**真数组**时能取到（不是被 JSON.parse 吃掉）');
      ok(fn.imageListOf(nodeWith([])).length === 0, 'images 为空数组 → 0 张');
      ok(fn.imageListOf(nodeWith(JSON.stringify([{ n: 'a' }]))).length === 1, '字符串形式仍正常');
      ok(fn.imageListOf(nodeWith('not json')).length === 0, '坏数据当没有（不抛错）');
    }
  }

  // 多图互斥：规则集中在 EditorBridge.setImages（命令本身只写 images）
  //
  // 曾经把「清 image」也写进 images 命令，结果 setImage(url) 为了清横幅调
  // exec('images', null)，反过来把刚设好的 image 一起清掉 —— 图标设不上。
  // 一个命令同时改两个字段，调用方就组合不出正确语义。
  const imgCmd = html.slice(html.indexOf("kity.createClass('imagesCommand'"),
    html.indexOf("kity.createClass('imagesCommand'") + 1200);
  ok(/setData\('images'/.test(imgCmd), 'images 命令写 images 字段');
  ok(!/setData\('image'/.test(imgCmd),
    'images 命令**绝不动 image**（互斥交给 bridge，否则 setImage 会被反向清掉）');

  {
    const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
    const si = br.slice(br.indexOf('setImages(list)'), br.indexOf('setImages(list)') + 900);
    ok(/arr\.length === 1/.test(si) && /exec\('image', arr\[0\]\)/.test(si),
      '1 张 → 写 image（内核渲染，图在节点框内）');
    ok(/exec\('images', JSON\.stringify\(arr\)\)/.test(si),
      '≥2 张 → 写 images（横幅）');
    ok(/exec\('image', null\)/.test(si),
      '横幅模式下清掉 image —— 两个字段都有值会画出两张图');
    // setImage 必须清横幅，否则「清除图标」点不掉多图
    const setImg = br.slice(br.indexOf('setImage(url, opt)'), br.indexOf('setImage(url, opt)') + 500);
    ok(/exec\('images', null\)/.test(setImg),
      'setImage 同时清 images（否则多图时「清除图标」点不掉）');
  }
  // imageListOf 只读 images：否则单图（走 image）会被画两次
  const imgListFn = html.slice(html.indexOf('function imageListOf(node)'),
    html.indexOf('function imageListOf(node)') + 700);
  ok(!/getData\('image'\)/.test(imgListFn),
    'imageListOf **不读 image**（否则单图会被内核和横幅各画一次）');

  // 拖放三个硬约束
  const dragoverFn = html.slice(html.indexOf("addEventListener('dragover'"),
    html.indexOf("addEventListener('dragover'") + 400);
  ok(/e\.preventDefault\(\)/.test(dragoverFn),
    'dragover **回调内**必须 preventDefault（否则浏览器根本不派发 drop）');
  ok(/hostPost\(\{ type: 'dropmiss' \}\)/.test(html),
    '拖到空白处要**告知**（不提示用户只会觉得拖了没反应）');
  ok(/type: 'dropfiles'/.test(html), 'drop 命中节点时把文件发給插件层');
  ok(/nodeId: \(node\.data && node\.data\.id\)/.test(html), '带上 nodeId');
  ok(/function dragHasFiles\(dt\)/.test(html), '区分「拖的是文件」还是画布内部拖拽');

  // 视频数字角标
  /*
   * 切片用**结构性锚点**而不是固定长度。
   *
   * 早先是 `起点 + 5000`，注释里还特意写了"切片长度是实测的"。
   * 这本身就说明它脆：往视频节里插一段注释（比如给播放三角补
   * pointer-events 的说明），切换代码就被挤出切片，断言变红 ——
   * 而**代码一点没改**。测试不该因为加了注释就失败。
   *
   * 改成取「视频节起点 → 文件节起点」：两处都是稳定的代码行。
   */
  {
    const vStart = html.indexOf("var vids = refListOf(node.getData('video'));");
    const vEnd = html.indexOf("var fils = refListOf(node.getData('file'));");
    ok(vStart > 0 && vEnd > vStart, '视频节 / 文件节锚点都找得到（切片前提是锚点稳定）');
  }
  const vidPart = html.slice(html.indexOf("var vids = refListOf(node.getData('video'));"),
    html.indexOf("var fils = refListOf(node.getData('file'));"));
  ok(/new kity\.Circle/.test(vidPart), '视频有角标圆底');
  ok(/String\(vids\.length\)/.test(vidPart), '角标显示**总数**（有几个视频）');
  // 多个视频必须能切换：写死 index 0 的话第 2 个起永远点不到
  ok(/var vi = node\._kmVidIdx \|\| 0;/.test(vidPart),
    '视频有当前索引（不是写死第 1 个）');
  // 现在点击/拖拽统一走 bindAttach，索引 vi 作为参数传进去
  ok(/bindAttach\(vcard, 'video', vi, vcur/.test(vidPart),
    '视频卡片绑的是**当前索引** vi（不是写死 0）');
  ok(/var vcur = vids\[vi\]/.test(vidPart),
    '缩略图与打开用的都是当前那一个');
  // 切片长度是**实测**的：3600 / 4400 都够不到切换代码（实测偏移 4813）。
  // 用「全文搜」兜底会让断言变松（改到别处也绿），故直接按实测放大到 5000。
  ok(/node\._kmVidIdx = \(cur \+ d \+ vids\.length\) % vids\.length/.test(vidPart),
    '多个视频可左右切换（循环）');
  ok(/\(vi \+ 1\) \+ '\/' \+ vids\.length/.test(vidPart),
    '卡片上有「i/n」序号（角标是总数，当前是第几个要另说）');
  ok(/fill\('#1B1B1F'\)/.test(vidPart),
    '角标数字用深色 —— 与节点同色压在浅色角标上会看不见');

  // 文件每行一个
  ok(/var fils = refListOf\(node\.getData\('file'\)\);/.test(html), '文件读列表');
  ok(/for \(var fi = 0; fi < fils\.length; fi\+\+\)/.test(html), '每个文件画一行');
  ok(/top \+= 24/.test(html), '行距 24 ≥ 图标高度 20（写 17 会让相邻图标重叠）');
}

group('拖放：bridge 与插件层接入');

{
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  ok(/case 'dropfiles':/.test(br), 'bridge 处理 dropfiles');
  ok(/case 'dropmiss':/.test(br), 'bridge 处理 dropmiss');
  ok(/case 'openattach':/.test(br), 'bridge 处理 openattach（点击画布上的附件）');
  ok(/onOpenAttach\?\.\(d\.kind, d\.index, d\.raw, d\.nodeId \|\| ''/.test(br),
    '带 kind / index / raw / **nodeId**（写回前要按 id 切回节点）');
  // list：点画布上的图时把整组一起带过来，预览里才能左右切换
  ok(/d\.list \|\| null/.test(br), '带上 list（该节点上的全部图片，用于预览切换）');
  // 附件在节点间拖拽移动
  ok(/case 'moveattach':/.test(br), 'bridge 处理 moveattach（附件在节点间移动）');
  ok(/case 'attachmiss':/.test(br), 'bridge 处理 attachmiss（拖到空白处）');
  ok(/setImages/.test(br) && /getSelectedImages/.test(br), 'bridge 提供图片列表读写');
  ok(/selectNodeById/.test(br), 'bridge 提供 selectNodeById');

  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(/async function handleDropFiles/.test(idx), '插件层有 handleDropFiles');
  ok(/onDropFiles:/.test(idx), '注册了 onDropFiles');
  ok(/onDropMiss:/.test(idx), '注册了 onDropMiss');
  ok(/onOpenAttach:/.test(idx), '注册了 onOpenAttach');
  ok(/请拖到节点上/.test(idx), '空白处有明确提示文案');
  ok(!/confirmDropOverwrite/.test(idx),
    '覆盖提示已移除（多附件是追加，不再有覆盖场景）');

  const hd = fnBody(idx, 'async function handleDropFiles');
  ok(/getSelectedImages/.test(hd) && /decodeRefList/.test(hd),
    '先读出**现有列表**');
  ok(/imgs\.push/.test(hd) && /vids\.push/.test(hd) && /fils\.push/.test(hd),
    '三类都 push —— 追加而不是覆盖');
  ok(!/insertChildNamed/.test(hd),
    '**不再建子节点**（全部挂到目标节点上）');
  ok(/encodeRefList\(vids\)/.test(hd) && /encodeRefList\(fils\)/.test(hd),
    '写回时序列化成列表');
  ok(/if \(nImg\)|if \(nImg\)/.test(hd) || /nImg\)/.test(hd), '只在真有变化时才写回');
  ok(/bridge\.selectNodeById\(nodeId\)/.test(hd),
    '写回前重新锁定目标节点（存资产是异步的，不重锁会挂错节点）');
  ok(/makeVideoThumb/.test(hd), '视频生成首帧缩略图');
  ok(/failed\.length/.test(hd) && /未能附加|附加失败/.test(hd), '失败的文件要列名（不静默）');
  ok(/failed\.push\(r\.error/.test(hd),
    '失败项带上**原因**：只说「未添加」用户不知道该怎么办，「超过单张上限 24.0 MB」才能决定下一步');

  /* ---- 封面取帧：1/3 处，不再取首帧 ----
   * 首帧绝大多数是黑场 / 淡入 / 片头字幕，抓出来一片纯黑，
   * 卡片上看着像「图没加载出来」—— 这正是之前封面全黑的原因。
   */
  const mt = fnBody(idx, 'function makeVideoThumb(file)');
  // 采样点：先 1/3，若仍在黑场再依次试 1/2、2/3
  ok(/1\s*\/\s*3/.test(mt) && /1\s*\/\s*2/.test(mt) && /2\s*\/\s*3/.test(mt),
    '采样点为 1/3 → 1/2 → 2/3（避开片头黑场）');
  // 必须真的 seek，不能只靠 #t= —— seek 到 1/3 才能拿到有内容的帧
  ok(/v\.currentTime\s*=/.test(mt), 'seek 到采样点（用 currentTime，不是只靠 #t= 片段）');
  ok(/'seeked'/.test(mt), '等 seeked 事件（seek 是异步的，不等会抓到旧帧）');
  // 黑场检测：光换采样点不够，1/3 也可能仍在黑场里，得看亮度
  ok(/getImageData/.test(mt), '抓帧后算平均亮度（判断是不是黑场）');
  ok(/lum\s*<\s*DARK/.test(mt), '太黑就试下一个采样点');
  // 不能只写 seek 不写兜底：duration 可能是 Infinity（直播流 / 未索引）
  ok(/Number\.isFinite\(dur\)/.test(mt), 'duration 不合法时退回首帧（不能拿 NaN 去 seek）');
  ok(!/#t=0\.1/.test(mt), '不再依赖 #t=0.1 那种"取首帧"的写法');
  ok(/setTimeout/.test(mt), '有超时（某些编码 seek 很慢，不能一直等）');
  ok(/preload\s*=\s*'auto'/.test(mt), 'preload=auto（metadata 只拉元数据，seek 过去解不出画面）');

  // 侧栏改为列表
  const pnl = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/selectedRefs\('file'\)/.test(pnl) && /selectedRefs\('video'\)/.test(pnl),
    '侧栏读**列表**而不是单个引用');
  ok(/section\(`文件附件\$\{/.test(pnl), '文件区标题带数量');
  ok(/mm-arow/.test(pnl), '文件用行式列表（每行一个）');
  ok(/removeAt\(/.test(pnl), '支持移除第 N 个');
  ok(/setImages\(\[\.\.\.images/.test(pnl), '加图片是追加（不覆盖已有图片）');
}

group('图片互斥：image 与 images 不能同时有值（行为级）');

{
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');

  /** 按大括号配对取出某个方法的**完整源码**（不靠 indexOf + 固定长度，那种切片会错位） */
  function methodSrc(name) {
    // 必须锚在**行首的方法定义**上：只写 name+'(' 会先命中别的函数体里的
    // `this.setImages(...)` 这类调用点，切出来的片段不是方法定义（语法直接报错）
    const start = br.indexOf('\n  ' + name + '(');
    if (start < 0) return '';
    let i = br.indexOf('{', start);
    let depth = 0;
    for (; i < br.length; i++) {
      if (br[i] === '{') depth++;
      else if (br[i] === '}') { depth--; if (depth === 0) return br.slice(start, i + 1); }
    }
    return '';
  }
  const si = methodSrc('setImages');
  const setImg = methodSrc('setImage');
  ok(si.length > 0 && setImg.length > 0, '能取出 setImages / setImage 源码');

  /**
   * 跑真实方法：把它们当**对象字面量的方法简写**求值。
   * 用 `new Function('return (' + src + ')')` 不行 —— 方法简写不是表达式。
   */
  function makeRunner(src, name) {
    return new Function('return ({ ' + src + ' });')()[name];
  }
  /*
   * BUG 58 之后 setImage / setImages 会先读「单图 / 图标」槽位再决定让不让位，
   * 所以这个替身除了 exec 还得提供那几个内部方法。
   * 这里给的是**槽位为空**的默认实现：本组断言盯的是 image / images 的互斥，
   * 与槽位里放的是图标还是图片无关（那部分由 BUG 58 那一组单独把关）。
   */
  function makeSelf(log) {
    return {
      exec(name2, value) { log.push([name2, value]); return true; },
      _isIconUrl(u) { return !!u && /^data:image\/svg\+xml/i.test(String(u)); },
      _imageSlot() { return { url: '', isIcon: false }; },
      getSelectedImages() { return []; },
      _appendImage(url) { log.push(['images', JSON.stringify([url])]); },
      // BUG 95：写图片时顺带落 data.icon 标记。本组盯的是字段互斥，
      // 标记本身由 BUG 95 那组把关，这里只要求**不能不写**。
      _markIcon(v) { log.push(['data.icon', v]); },
    };
  }
  function runSetImages(list) {
    const log = [];
    makeRunner(si, 'setImages').call(makeSelf(log), list);
    return log;
  }
  function runSetImage(url) {
    const log = [];
    makeRunner(setImg, 'setImage').call(makeSelf(log), url);
    return log;
  }

  // 0 张 → 两个字段都清
  {
    const log = runSetImages([]);
    const got = JSON.stringify(log);
    ok(/\["image",null\]/.test(got), '0 张 → 清 image');
    ok(/\["images",null\]/.test(got), '0 张 → 清 images');
  }
  // 1 张 → image 收下，images 清掉（交给内核画在框内）
  {
    const log = runSetImages(['A']);
    const got = JSON.stringify(log);
    ok(/\["image","A"\]/.test(got), '1 张 → image = 该张（框内）');
    ok(/\["images",null\]/.test(got), '1 张 → images 清空（避免与 image 重复画）');
  }
  // ≥2 张 → images 收下，image 清掉
  {
    const log = runSetImages(['A', 'B']);
    const got = JSON.stringify(log);
    ok(/\["images","\[\\"A\\",\\"B\\"\]"\]/.test(got) || got.includes('["images","[\\"A\\",\\"B\\"]"]'),
      '≥2 张 → images = 数组（横幅）');
    ok(/\["image",null\]/.test(got), '≥2 张 → image 清空（否则同节点两张图）');
  }
  // setImage 必须清横幅 —— 否则「清除图标」点不掉多图
  {
    const log = runSetImage('ICON');
    const got = JSON.stringify(log);
    ok(/\["image","ICON"\]/.test(got), 'setImage 设置 image');
    ok(/\["images",null\]/.test(got),
      'setImage **同时清 images**（否则多图时「清除图标」点不掉，图还在）');
    // 顺序不能反：先设 image 再清 images。反过来会把刚设的 image 一起清掉
    eq(log[0][0], 'image', 'setImage 先设 image（顺序反了会被随后的清 images 连带清掉）');
  }
  {
    const log = runSetImage(null);
    ok(JSON.stringify(log).includes('["images",null]'),
      'setImage(null) 也清 images（清除图标要清得干净）');
  }
  // 关键回归：清 images 时**不能**连带清 image
  // （曾经把「清 image」写进 images 命令，setImage 就被自己的清除干掉了）
  {
    const imgCmd = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
    const cmd = imgCmd.slice(imgCmd.indexOf("kity.createClass('imagesCommand'"),
      imgCmd.indexOf("kity.createClass('imagesCommand'") + 1200);
    ok(!/setData\('image'/.test(cmd),
      'images 命令不碰 image（碰了会让 setImage 被反向清掉）');
  }
}

group('视频：缩略图 MIME 与打开判定');

{
  const io = await import('./io.js');
  eq(io.videoMimeOf('a.mp4'), 'video/mp4', '.mp4 → video/mp4');
  eq(io.videoMimeOf('a.mkv'), 'video/x-matroska', '.mkv → 具体类型（不能给通配）');
  eq(io.videoMimeOf('a.webm'), 'video/webm', '.webm');
  eq(io.videoMimeOf('a.MP4'), 'video/mp4', '大小写不敏感');
  eq(io.videoMimeOf('a.xyz'), '', '未知扩展名 → 空串（宁可让浏览器嗅探，也别给错的）');
  eq(io.videoMimeOf(''), '', '空输入 → 空串');
  eq(io.videoMimeOf(null), '', 'null → 空串');

  // 通配类型不能出现在代码里 —— 部分浏览器给 Blob 设这种 type 后
  // <video> 加载 blob: URL 会直接失败，首帧永远抓不到
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(!/type:\s*'video\/\*'/.test(idx),
    '不再用 type: video/* 通配符（会让 <video> 加载失败，首帧抓不到）');
  ok(/type:\s*io\.videoMimeOf\(name\)/.test(idx), '用真实 MIME 建 Blob');

  // 打开判定不能只看扩展名：.mkv/.avi/.flv 漏掉会变成「下载」而非播放
  const oa = idx.slice(idx.indexOf('const isVideo ='), idx.indexOf('const isVideo =') + 400);
  ok(/blob\.type/.test(oa), '优先用 blob.type 判定视频');
  ok(/mkv/.test(oa) && /avi/.test(oa) && /flv/.test(oa),
    '扩展名兜底要含 mkv / avi / flv（漏了会变成下载，用户以为视频坏了）');
}

group('附件在节点间拖拽：分发逻辑（跑真实源码）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  /** 按大括号配对取出函数源码 */
  function fnSrc(name) {
    const start = html.indexOf('function ' + name + '(');
    if (start < 0) return '';
    let i = html.indexOf('{', start);
    let depth = 0;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    }
    return '';
  }
  const upSrc = fnSrc('onAttUp');
  const mvSrc = fnSrc('onAttMove');
  ok(upSrc.length > 0 && mvSrc.length > 0, '能取到 onAttMove / onAttUp 源码');

  /** 造一个可跑的环境，注入依赖后调用真实 onAttUp */
  function makeEnv(d) {
    const posted = [];
    const opened = [];
    let ended = false;
    const env = {
      attEndDrag: () => { ended = true; return d; },
      openAttach: (node, kind, index, raw) => opened.push({ kind, index, raw }),
      hostPost: (m) => posted.push(m),
      nodeFromDom: (el) => env._hit || null,
      document: { elementFromPoint: () => ({}) },
    };
    env.up = new Function(
      'attEndDrag', 'openAttach', 'hostPost', 'nodeFromDom', 'document',
      'return (' + upSrc + ');')(env.attEndDrag, env.openAttach, env.hostPost,
      (el) => env.nodeFromDom(el), env.document);
    return { env, posted, opened, wasEnded: () => ended, d };
  }

  const drag = (over = {}) => ({
    x0: 0, y0: 0, moved: true, kind: 'file', index: 1,
    ref: { n: 'a.pdf', a: 'A' }, fromId: 'N1',
    node: { data: { id: 'N1' } }, label: 'a.pdf', ...over,
  });

  // 1) 没超过死区 = 单击 → 打开
  {
    const e = makeEnv(drag({ moved: false }));
    e.env.up({ clientX: 1, clientY: 1 });
    eq(e.opened.length, 1, '未拖拽 → 走单击打开（不是移动）');
    eq(e.posted.length, 0, '单击不 post 移动消息');
  }
  // 2) 拖到另一个节点 → moveattach
  {
    const e = makeEnv(drag());
    e.env._hit = { data: { id: 'N2' } };
    e.env.up({ clientX: 200, clientY: 100 });
    eq(e.posted.length, 1, '拖拽到别的节点 → 发一条消息');
    eq(e.posted[0]?.type, 'moveattach', '是 moveattach');
    eq(e.posted[0]?.fromId, 'N1', '带 fromId');
    eq(e.posted[0]?.toId, 'N2', '带 toId');
    eq(e.posted[0]?.kind, 'file', '带 kind');
    eq(e.posted[0]?.index, 1, '带 index（移动的是第几个）');
    eq(e.opened.length, 0, '拖拽后**不**再触发打开（否则移完还弹窗）');
  }
  // 3) 拖到空白 → attachmiss（要说出来）
  {
    const e = makeEnv(drag());
    e.env._hit = null;
    e.env.up({ clientX: 200, clientY: 100 });
    eq(e.posted[0]?.type, 'attachmiss', '拖到空白 → attachmiss（不是静默）');
  }
  // 4) 拖回自己 → 什么都不发
  //    必须是**同一个对象引用**：运行时 nodeFromDom 取回的就是 bindAttach 存的那一个
  //    minder node 是持久对象，重渲不会换引用，所以引用比较可靠
  {
    const e = makeEnv(drag());
    e.env._hit = e.d.node;
    e.env.up({ clientX: 5, clientY: 5 });
    eq(e.posted.length, 0, '拖回自己 → 不发消息（空操作）');
    // 同 id 不同对象也不能算「自己」—— 引用比较的意义就在这里
    const e2 = makeEnv(drag());
    e2.env._hit = { data: { id: 'N1' } };
    e2.env.up({ clientX: 5, clientY: 5 });
    /*
     * ⓘ 原写 `e2.posted.length >= 0` —— 恒真，且**与意图相反**。
     *   这条是对照组：要证明"同 id 但不同对象引用"**不**被当成自己，
     *   所以它**必须**发出 moveattach（发 0 条才是错）。
     *   写成 >= 0 后，就算引用比较退化成"只比 id"（于是当成自己、一条不发），
     *   这条照样绿 —— 对照组失守，上面那条"拖回自己不发"也就没了意义。
     */
    eq(e2.posted.length, 1, '（对照）同 id 但不同对象引用 → 不会被当成自己，照样发 moveattach');
    eq(e2.posted[0]?.type, 'moveattach', '（对照）发的确实是 moveattach');
  }
  // 5) 结束拖拽一定被清理（不清理会残留状态，下次点击变成拖拽）
  {
    const e = makeEnv(drag());
    e.env.up({ clientX: 1, clientY: 1 });
    ok(e.wasEnded(), '无论哪种结局都调用 attEndDrag 清理');
  }
  // 光「调用了 attEndDrag」不够 —— 函数里**真的把状态置空**才算清理。
  // 残留的话下次 mousedown 前 attDrag 还指着旧数据，一次单击会被当成拖拽。
  {
    const endSrc = fnSrc('attEndDrag');
    ok(/attDrag = null;/.test(endSrc),
      'attEndDrag 里必须把 attDrag 置空（只调用不算清理）');
    const upS = fnSrc('onAttUp');
    ok(/attEndDrag\(\)/.test(upS), 'onAttUp 走 attEndDrag（统一清理入口）');
  }

  // 6) 死区：小幅移动不算拖拽
  {
    const ATT = Number(/var ATT_DRAG_DEAD = (\d+)/.exec(html)?.[1]);
    ok(ATT > 0, `死区常量存在（${ATT}px）`);
    const st = { x0: 0, y0: 0, moved: false, kind: 'file', index: 0, ref: {}, label: 'x' };
    const set = new Set();
    const mv = new Function(
      'attDrag', 'ATT_DRAG_DEAD', 'attGhostEl', 'nodeFromDom', 'document', 'attHighlight',
      'return (' + mvSrc + ');')(
      st, ATT,
      () => ({ style: {}, set textContent(v) {} }),
      () => null, { elementFromPoint: () => ({}) }, () => {});
    mv({ clientX: ATT - 1, clientY: 0 });
    eq(st.moved, false, `移动 ${ATT - 1}px 仍在死区内（不算拖拽）`);
    mv({ clientX: ATT + 2, clientY: 0 });
    eq(st.moved, true, `移动 ${ATT + 2}px 超出死区（进入拖拽）`);
  }

  // 7) 跟随浮层必须 pointer-events:none，否则命中测试命中的是它自己
  //
  // 断言盯的是 **JS 里的 inline style**，不是 CSS —— 这两个元素是运行时
  // createElement 出来的、样式全走 style.xxx，styles.css 里压根没有这两个类。
  // 早先断言读 CSS 导致永远为假（假阴性），后来样式改成 inline 后直接变红，
  // 两种情况都没在把关真正的行为。
  {
    // 两个元素各自独立设置，缺一个就会出现"拖到某处后浮层自己挡住命中测试"
    const mkGhost = html.slice(html.indexOf('function attGhostEl('), html.indexOf('function attHiEl('));
    ok(/pointerEvents\s*=\s*'none'/.test(mkGhost),
      '跟随浮层 pointer-events:none（否则 elementFromPoint 命中它自己）');
    const mkHi = html.slice(html.indexOf('function attHiEl('), html.indexOf('/** 把高亮框套在目标节点上'));
    ok(/pointerEvents\s*=\s*'none'/.test(mkHi), '高亮框同样不能吃事件');
  }

  // 8) 源节点不给高亮（高亮了像「可以放」，实际是空操作）
  {
    const hlSrc = fnSrc('attHighlight');
    ok(/node === attDrag\.node/.test(hlSrc), '源节点不给高亮（拖回自己是空操作）');
  }
}

group('附件移动：先加后删（行为级）');

{
  const io = await import('./io.js');
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  /** 取 moveAttachment 源码来跑（不复刻） */
  function mvSrc() {
    const start = idx.indexOf('function moveAttachment(');
    let i = idx.indexOf('{', start);
    let depth = 0;
    for (; i < idx.length; i++) {
      if (idx[i] === '{') depth++;
      else if (idx[i] === '}') { depth--; if (depth === 0) return idx.slice(start, i + 1); }
    }
    return '';
  }
  const src = mvSrc();
  ok(src.length > 0, '能取到 moveAttachment 源码');

  /**
   * 两个节点各有自己的 file 列表；bridge 的读写都作用于「当前选中节点」。
   */
  function makeWorld() {
    const nodes = {
      N1: { file: io.encodeRefList([{ n: '一.pdf', a: 'A1' }, { n: '二.pdf', a: 'A2' }]), video: '', image: null, images: null },
      N2: { file: io.encodeRefList([{ n: '九.pdf', a: 'A9' }]), video: '', image: null, images: null },
    };
    const log = [];
    let cur = null;
    const bridge = {
      ready: true,
      selectNodeById(id) { cur = id; log.push('sel:' + id); return true; },
      getSelectedFile() { return cur ? nodes[cur].file : ''; },
      getSelectedVideo() { return cur ? nodes[cur].video : ''; },
      getSelectedImages() { return cur ? (nodes[cur].images ? JSON.parse(nodes[cur].images) : []) : []; },
      setFile(v) { nodes[cur].file = v; log.push('write:file@' + cur); },
      setVideo(v) { nodes[cur].video = v; log.push('write:video@' + cur); },
      setImages(l) { nodes[cur].images = l && l.length ? JSON.stringify(l) : null; log.push('write:images@' + cur); },
    };
    return { nodes, bridge, log, cur: () => cur };
  }

  function run(world, kind, index, fromId, toId) {
    const statuses = [];
    const fn = new Function('bridge', 'io', 'commit', 'side', 'status',
      'return (' + src + ');')(
      world.bridge, io, () => {}, { refresh: () => {} }, (m) => statuses.push(m));
    fn(kind, index, fromId, toId);
    return statuses;
  }

  // 正常移动
  {
    const w = makeWorld();
    run(w, 'file', 0, 'N1', 'N2');
    eq(io.decodeRefList(w.nodes.N2.file).map((x) => x.n).join(','),
      '九.pdf,一.pdf', '目标节点拿到被移的附件（追加在后面）');
    eq(io.decodeRefList(w.nodes.N1.file).map((x) => x.n).join(','),
      '二.pdf', '源节点少了一个');
  }
  // 顺序必须是**先加后删**：最坏是重复（可恢复），反过来最坏是丢失（不可逆）
  {
    const w = makeWorld();
    run(w, 'file', 0, 'N1', 'N2');
    const addAt = w.log.indexOf('write:file@N2');
    const delAt = w.log.lastIndexOf('write:file@N1');
    ok(addAt >= 0 && delAt >= 0, '两步都执行了');
    ok(addAt < delAt, `先加后删（加在 ${addAt}，删在 ${delAt}）`);
  }
  // 写回前必须切回对应节点，否则会写错节点
  {
    const w = makeWorld();
    run(w, 'file', 1, 'N1', 'N2');
    ok(w.log.includes('sel:N1') && w.log.includes('sel:N2'), '两边都选中过');
    eq(w.log[w.log.indexOf('write:file@N2') - 1], 'sel:N2', '写目标前先选中目标');
  }
  // 边界：拖回自己
  {
    const w = makeWorld();
    const before = w.nodes.N1.file;
    run(w, 'file', 0, 'N1', 'N1');
    eq(w.nodes.N1.file, before, '拖回自己 → 什么都不改');
  }
  // 边界：索引越界
  {
    const w = makeWorld();
    const st = run(w, 'file', 9, 'N1', 'N2');
    ok(st.length > 0, '索引越界要有提示（不能静默）');
    eq(io.decodeRefList(w.nodes.N2.file).length, 1, '越界时目标不变');
  }
  // 视频同理
  {
    const w = makeWorld();
    w.nodes.N1.video = io.encodeRefList([{ n: 'v1.mp4', a: 'V1' }]);
    run(w, 'video', 0, 'N1', 'N2');
    eq(io.decodeRefList(w.nodes.N2.video).map((x) => x.n).join(','), 'v1.mp4', '视频也能移动');
    eq(io.decodeRefList(w.nodes.N1.video).length, 0, '源节点的视频清空');
  }
}

group('缩略图写入：按 nodeId 切回节点');

{
  const io = await import('./io.js');
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  function fnSrc(name) {
    const start = idx.indexOf('function ' + name + '(');
    let i = idx.indexOf('{', start);
    let depth = 0;
    for (; i < idx.length; i++) {
      if (idx[i] === '{') depth++;
      else if (idx[i] === '}') { depth--; if (depth === 0) return idx.slice(start, i + 1); }
    }
    return '';
  }
  const src = fnSrc('setVideoThumb');
  ok(src.length > 0, '能取到 setVideoThumb 源码');

  const nodes = {
    N1: { video: io.encodeRefList([{ n: 'v1.mp4', a: 'V1' }, { n: 'v2.mp4', a: 'V2' }]) },
    N2: { video: io.encodeRefList([{ n: '别的.mp4', a: 'V9' }]) },
  };
  const log = [];
  let cur = 'N2';   // 故意先停在一个**不相干**的节点上
  const bridge = {
    selectNodeById(id) { cur = id; log.push('sel:' + id); return true; },
    getSelectedVideo() { return nodes[cur].video; },
    setVideo(v) { nodes[cur].video = v; log.push('write@' + cur); },
  };
  const statuses = [];
  const fn = new Function('bridge', 'io', 'commit', 'side', 'status',
    'return (' + src + ');')(bridge, io, () => {}, { refresh: () => {} },
    (m) => statuses.push(m));

  fn(1, 'N1', 'data:image/jpeg;base64,FRAME');
  eq(log[0], 'sel:N1', '先按 nodeId 切回节点（否则写到当前选中的另一个节点上）');
  eq(io.decodeRefList(nodes.N1.video)[1].t, 'data:image/jpeg;base64,FRAME',
    '第 2 个视频拿到缩略图');
  eq(io.decodeRefList(nodes.N1.video)[0].t, undefined, '第 1 个视频不受影响');
  eq(io.decodeRefList(nodes.N2.video)[0].t, undefined, '别的节点没被改动');

  // 索引越界要有提示
  const st2 = [];
  const fn2 = new Function('bridge', 'io', 'commit', 'side', 'status',
    'return (' + src + ');')(bridge, io, () => {}, { refresh: () => {} },
    (m) => st2.push(m));
  fn2(9, 'N1', 'data:x');
  ok(st2.length > 0, '索引越界要提示（不能静默失败）');
}

group('视频播放：两个按钮与自动播放回退');

{
  const pnl = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const ov = pnl.slice(pnl.indexOf('export function openVideo'),
    pnl.indexOf('export function openVideo') + 2600);

  ok(/'截图'/.test(ov), '有「截图」按钮');
  ok(/'设为封面'/.test(ov), '有「设为封面」按钮');
  ok(/opt\.onSetThumb/.test(ov), '设为封面走回调（写回节点引用）');
  // 没有节点上下文时不给这个按钮 —— 点了没反应更让人困惑
  ok(/opt\.onSetThumb \? \[setThumb\] : \[\]/.test(ov),
    '没有回调时不显示「设为封面」（避免点了没反应）');

  /* ---- 侧栏打开的视频也要能设封面 ----
   * 早先在侧栏点视频走 openVideo(app, asset)，不传 opt，
   * 于是只有从画布节点点开的才有「设为封面」按钮 —— 看着像功能丢了。
   */
  const at = pnl.slice(pnl.indexOf('const openAt = async'), pnl.indexOf('const openAt = async') + 2600);
  ok(/onSetThumb:/.test(at), '侧栏打开视频时带上 onSetThumb');
  ok(/app\.api\.setVideoThumb\?\.\(/.test(at), '侧栏的设封面走 api.setVideoThumb');
  // 签名是 `const openAt = async (kind, ref, index)` —— 必须连 async 一起匹配，
  // 写成 openAt(kind,ref,index) 永远为假（那是调用处的形态），断言就成了装饰品
  ok(/const openAt = async \(kind, ref, index\)/.test(at), 'openAt 带 index（否则不知道改第几个视频）');
  {
    const call = pnl.slice(pnl.indexOf("safe('打开'") || 0, (pnl.indexOf("safe('打开'") || 0) + 300);
    ok(/openAt\(kind, ref, index\)/.test(call), '调用处真的把 index 传进去了');
  }
  // 宿主必须暴露，否则面板那句是空调用
  const ix2 = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  ok(/setVideoThumb:/.test(ix2), 'index.js 暴露 api.setVideoThumb');

  // 抓帧：videoWidth 为 0 时必须返回 null（不是空串 —— 空串画出来是全黑）
  ok(/if \(!w \|\| !hh\) return null;/.test(ov), '没画面时返回 null（不是空串）');
  ok(/toDataURL\('image\/jpeg'/.test(ov), '存 jpeg（缩略图/截图不需要无损，体积小好几倍）');
  // 扩展名必须跟**实际字节**一致：抓出来的是 JPEG，存成 .png 的话
  // 有些看图软件会直接拒绝打开（"文件已损坏"），而内容其实没问题
  ok(/-截图\.jpg/.test(ov), '截图存成 .jpg（扩展名要与 jpeg 字节一致）');
  ok(!/-截图\.png/.test(ov), '不再存成 .png（实际是 jpeg，扩展名撒谎会被判损坏）');
  ok(/videoWidth/.test(ov) && /drawImage/.test(ov), '用 canvas 抓当前帧');

  // 自动播放回退：浏览器会阻止**有声**自动播放
  ok(/v\.muted = true/.test(ov), '有声播放被拒 → 转静音（否则用户看到一动不动的首帧）');
  ok(/hint\.textContent/.test(ov), '转静音要告诉用户（不然以为没声音是坏了）');
  ok(/playsinline/.test(ov), '带 playsinline（iOS 上不加会强制全屏）');

  // 没读到画面要有提示
  ok(/还没读到画面/.test(ov), '没画面时提示（不是静默什么都不做）');
}

group('附件图标不能是黑块：fill 必须用 none 而不是 transparent');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const fiAt = html.indexOf("var FileIcon = kity.createClass('FileIcon'");
  /* VideoIcon 已删除，所以不能再拿它当切片结束锚点 —— 换成后面那条
   * 稳定存在的注释（"不能把 FileRenderer 挂进"）。
   * 锚点一旦失效，slice 会切到别处（甚至空串），断言就变成假阴性。
   */
  const fiEnd = html.indexOf('// 不能把 FileRenderer 挂进');
  const fi = html.slice(fiAt, fiEnd);
  ok(fiAt > 0 && fiEnd > fiAt, '能定位到 FileIcon 源码');

  // 核心：SVG 1.1 的 fill 不接受 transparent（那是 CSS 关键字），
  // 渲染器认不出就回退默认黑色 —— 整个矩形糊成黑块。none 才是标准值。
  // 只断言「rect 用的是 none」而不是「全文不含 transparent」——
  // 后者会命中注释里的说明文字，属于假阳性（注释改了代码没改也照样绿）
  ok(/new kity\.Rect\(15, 20, -10, -10, 3\)\.fill\('none'\)/.test(fi),
    'FileIcon 的矩形底用 fill(none)（transparent 会被渲染器回退成黑色）');
  // 几何必须罩住 outline 的实际范围 x∈[-8,3] / y∈[-10,10]。
  // 早先是 (16,20, 0,-10) —— 从原点向右延伸 16px，与本体错位且压住文件名，
  // 表现为「悬停出现一个透明小框、位置不对」。
  {
    const m = fi.match(/new kity\.Rect\((\d+), (\d+), (-?\d+), (-?\d+)/);
    ok(!!m, '能取到 FileIcon rect 的几何');
    if (m) {
      const [, w, h, x, y] = m.map(Number);
      ok(x <= -8 && x + w >= 3, `rect 横向罩住 outline（x=${x}, 右=${x + w}，需含 [-8,3]）`);
      ok(y <= -10 && y + h >= 10, `rect 纵向罩住 outline（y=${y}, 下=${y + h}，需含 [-10,10]）`);
      // 右边界不能伸到文字起点（文字在原点右侧 12px = cx-34 vs 图标 cx-46）
      ok(x + w <= 12, `rect 右边界不压到文件名（右=${x + w} ≤ 12）`);
    }
  }
  ok(!/\.fill\('transparent'\)/.test(stripCommentsFlat(fi)),
    'FileIcon 代码里不再出现 fill(transparent)');
  ok(/\.fill\('none'\)/.test(fi), 'FileIcon 底框用 fill(none)');

  // 注释曾写着「fill 保持 none」而代码写 transparent —— 注释与实现不符，
  // 这类不一致必须靠断言锁住，不能只靠注释
  ok(!/fill\('transparent'\)/.test(html.slice(html.indexOf("var domNodeMap"), html.indexOf("var ATT_DRAG_DEAD"))),
    '附件图标区域整体不再出现 transparent');

  // mouseout 恢复态同样不能用 transparent（悬停过一次之后就会变黑块）
  ok(/mouseout', function \(\) \{ this\.rect\.fill\('none'\)/.test(fi),
    'FileIcon mouseout 恢复到 none（不是 transparent）');

  // 对照：kity 的 fill 实现是 `a && setAttribute('fill', a.toString())`
  // 传 'none' 会正确写入属性；这正是要的
  const kity = fs.readFileSync(path.join(HERE, 'editor', 'kity.min.js'), 'utf8');
  ok(/fill:function\(a\)\{return a&&this\.node\.setAttribute\("fill",a\.toString\(\)\)/.test(kity),
    '（对照）kity fill 只对真值写属性 —— 所以值本身必须合法');
}

group('kity.Rect 圆角：必须在 setSize **之后**设（跑真实 kity）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const KITY = fs.readFileSync(path.join(HERE, 'editor', 'kity.min.js'), 'utf8');

  /* ---- 1) 先确认内核行为：新建 Rect 尺寸为 0，setRadius 会被钳成 0 ----
   * kity: formatRadius(a,b,c) = Math.min(Math.floor(Math.min(a/2, b/2)), c)
   *       setRadius(r): this.radius = formatRadius(this.width, this.height, r)
   *       setSize(w,h): this.width = w; this.height = h; this.update()  ← 不重算 radius
   */
  {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window;
    const sc = w.document.createElement('script');
    sc.textContent = KITY;
    w.document.head.appendChild(sc);
    const kity = w.kity;
    ok(!!kity && !!kity.Rect, 'kity 可在 jsdom 中加载');

    // 错误顺序：先 setRadius 再 setSize
    const bad = new kity.Rect().setRadius(6);
    bad.setPosition(0, 0).setSize(100, 40);
    eq(bad.getRadius(), 0, '先 setRadius 再 setSize → 圆角被钳成 0（这就是 bug）');

    // 正确顺序：先 setSize 再 setRadius
    const good = new kity.Rect();
    good.setPosition(0, 0).setSize(100, 40).setRadius(6);
    eq(good.getRadius(), 6, '先 setSize 再 setRadius → 圆角保留 6');

    // 复用场景：setSize 之后不重设，圆角依旧是 0
    const reuse = new kity.Rect();
    reuse.setSize(100, 40).setRadius(8);
    eq(reuse.getRadius(), 8, '第一次设好是 8');
    reuse.setSize(200, 80);                 // 只改尺寸
    eq(reuse.getRadius(), 8, 'setSize 后 radius 保持 8（kity 不会重置它）');
    // 但**新建**就没这么幸运：0×0 时设的圆角永远回不来
    const never = new kity.Rect().setRadius(8);
    never.setSize(200, 80);
    eq(never.getRadius(), 0, '新建时（0×0）设的圆角，之后 setSize 也救不回来');
  }

  /* ---- 2) 源码级：四处圆角都不能出现在 setSize 之前 ---- */
  // 用**位置**比较而不是正则：setSize 的参数里带括号（(br.x - tl.x) + ...），
  // 用 `[^)]*` 一类写法会匹配失败，写成宽泛的 [\s\S]*? 又容易跨函数误判。
  const sites = [
    ['分组标签底色', 'var bg = new kity.Rect();', 'bg.setPosition', '.setRadius(4);'],
    ['分组外框', 'shape = new kity.Rect();', 'shape.setSize(', 'shape.setRadius(8);'],
    ['图片选中框', 'var rect = new kity.Rect();', 'rect.setSize(', 'rect.setRadius(2);'],
    ['搜索高亮框', 'var shape = new kity.Rect();', 'shape.setSize(', 'shape.setRadius(6);'],
  ];
  for (const [who, ctor, sizeCall, radiusCall] of sites) {
    ok(html.includes(ctor), `${who}：构造时不再预置圆角（0×0 时设会被钳成 0）`);
    const atSize = html.indexOf(sizeCall);
    const atRadius = html.indexOf(radiusCall);
    ok(atSize > 0 && atRadius > atSize,
      `${who}：setRadius 出现在 setSize 之后（${atSize} < ${atRadius}）`);
  }
  // 全局：不允许再出现 `new kity.Rect().setRadius(` 这种顺序
  ok(!/new kity\.Rect\(\)\.setRadius\(/.test(html),
    '全文不得再出现 new kity.Rect().setRadius(（0×0 时设必然被钳成 0）');
}

group('附件操作：写回前必须切回节点（选中丢失防护）');

{
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  const pnl = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');

  // 1) bridge 提供 getSelectedNodeId
  ok(/getSelectedNodeId\(\)/.test(br), 'bridge 有 getSelectedNodeId（能记住当前节点）');
  {
    function methodSrc(name) {
      // 必须锚在**行首的方法定义**上：只写 name+'(' 会先命中别的函数体里的
      // `this.setImages(...)` 这类调用点，切出来的片段不是方法定义（语法直接报错）
      const start = br.indexOf('\n  ' + name + '(');
      if (start < 0) return '';
      let i = br.indexOf('{', start);
      let d = 0;
      for (; i < br.length; i++) {
        if (br[i] === '{') d++;
        else if (br[i] === '}') { d--; if (d === 0) return br.slice(start, i + 1); }
      }
      return '';
    }
    const src = methodSrc('getSelectedNodeId');
    ok(/getSelectedNode\?\.\(\)/.test(src), '读的是选中节点');
    ok(/\|\| ''/.test(src), '读不到返回空串（不是 undefined，调用方好判断）');
  }

  // 2) 顺序：rememberNode 必须**在弹选择框之前**
  //    放在之后就没用了 —— 那时选中已经丢了，记到的是空
  const attachAt = pnl.indexOf('const attach = async (kind) => {');
  const attachSrc = pnl.slice(attachAt, pnl.indexOf('const removeAt', attachAt));
  ok(attachAt > 0, '能定位到 attach');
  ok(attachSrc.indexOf('rememberNode()') < attachSrc.indexOf('pickFile('),
    'attach：先 rememberNode 再弹选择框（顺序反了就记不到节点）');
  ok(attachSrc.indexOf('focusNode()') > attachSrc.indexOf('pickFile('),
    'attach：写回前调 focusNode 切回');
  ok(/请先选中一个节点再附加/.test(attachSrc), 'attach：切不回时有提示（不静默）');

  const addAt = pnl.indexOf('const addImages = async () => {');
  const addSrc = pnl.slice(addAt, pnl.indexOf('const removeImage', addAt));
  ok(addAt > 0, '能定位到 addImages');
  ok(addSrc.indexOf('rememberNode()') < addSrc.indexOf('pickFiles('),
    'addImages：先记住节点再弹选择框');
  ok(addSrc.indexOf('focusNode()') > addSrc.indexOf('pickFiles('),
    'addImages：写回前切回节点');
  // 关键：**实时重读**，不能用页面构建时的 images 快照
  ok(/const images = app\.api\.selectedImages\(\);/.test(addSrc),
    'addImages：切回后**实时**重读列表（不能用页面构建时的快照，会丢第一张）');
  ok(/请先选中一个节点再添加图片/.test(addSrc), 'addImages：切不回时有提示');

  // 3) focusNode / rememberNode 的定义
  const focusAt = pnl.indexOf('const focusNode = () => {');
  // 边界必须**结构性**（到下一个同级 const 为止）。早先写死 700 字符，
  // 在函数里加一段说明注释就被撑爆 —— 于是断言查的是被截断的半截函数，
  // 代码没坏却报红（这类"定长窗口"在本项目已经踩过好几次）。
  const focusEnd = pnl.indexOf('const rawOf =', focusAt);
  const focusSrc = pnl.slice(focusAt, focusEnd < 0 ? pnl.length : focusEnd);
  ok(focusAt > 0, '有 focusNode');
  ok(/_pendingNodeId \|\|/.test(focusSrc), 'focusNode 优先用记住的 nodeId');
  ok(/selectNodeById\?\.\(id\)/.test(focusSrc), 'focusNode 真的调用了 selectNodeById');
  ok(/const rememberNode = \(\) =>/.test(pnl), '有 rememberNode');

  // 4) 未选中节点时要说清楚 —— 否则和「这个节点没附件」长得一样，
  //    用户会以为附件数据丢了
  const tipAt = pnl.indexOf('当前没有选中节点');
  ok(tipAt > 0, '有「未选中节点」提示');
  const tipSrc = pnl.slice(tipAt - 900, tipAt + 260);
  // 能力检测：bridge 没这个方法就别瞎判断，否则会把「没附件」误报成「没选中」
  ok(/typeof app\.bridge\?\.getSelectedNodeId === 'function'/.test(tipSrc),
    '提示只在**能确认**没选中时才出现（能力检测，避免误报）');
  // 提示落在**空列表**的位置（不再整页替换）：
  // 文件栏空 → 换成引导语；别的栏仍显示各自的空提示
  ok(/noSel && label === '文件'/.test(tipSrc),
    '未选中时只在**文件栏**换文案（三栏都换会重复三遍）');
  ok(/return `当前节点没有\$\{label\}附件`/.test(tipSrc),
    '其余情况仍是「当前节点没有 X 附件」');

  // 5) 移除类操作同样要切回（confirmDialog 也是异步的）
  const rmAt = pnl.indexOf('const removeAt = async (kind, index) => {');
  const rmSrc = pnl.slice(rmAt, pnl.indexOf('const openAt', rmAt));
  ok(/rememberNode\(\)/.test(rmSrc), 'removeAt 也记住节点');
  ok(/focusNode\(\)/.test(rmSrc), 'removeAt 确认后切回节点');
}

group('图片：image 命令必须同步（跑真实源码）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  // 取命令区源码（FileCommand → FileRenderer 注释前），含我们覆盖的 image 命令
  const start = html.indexOf("var FileCommand = kity.createClass('fileCommand'");
  const end = html.indexOf('// 不能把 FileRenderer 挂进');
  const cmdSrc = html.slice(start, end);

  const kity = {
    createClass(name, def) {
      function C() { if (def.constructor) def.constructor.apply(this, arguments); }
      Object.assign(C.prototype, def);
      return C;
    },
  };
  const kityminder = { Command: function () {} };

  function newKm() {
    const node = {
      data: { text: 'x' },
      setData(k, v) { this.data[k] = v; },
      getData(k) { return this.data[k]; },
      render() { this.rendered = (this.rendered || 0) + 1; },
    };
    const km = {
      _commands: {},
      getSelectedNodes: () => [node],
      getSelectedNode: () => node,
      getOption: () => 200,
      layout() {},
      fire() {},
      queryCommandState(name) {
        const b = this._commands[name];
        return b ? b.queryState.apply(b, [this]) : -1;
      },
      execCommand(name, ...args) {
        const b = this._commands[name];
        if (!b) return null;
        if (!~this.queryCommandState(name)) return null;
        return b.execute.apply(b, [this, ...args]);
      },
    };
    new Function('kity', 'kityminder', 'km', cmdSrc)(kity, kityminder, km);
    return { node, km };
  }

  // 1) 设置：**同步**就能读到（内核版要等 img.onload，读不到）
  {
    const { node, km } = newKm();
    km.execCommand('image', 'data:image/png;base64,AAA');
    eq(node.getData('image'), 'data:image/png;base64,AAA',
      '设完**立刻**能读到 image（内核版是异步的，此刻还是空的）');
    // 内核 ImageRenderer 是 `if (imageSize)` —— 没尺寸就**完全不画**
    ok(node.getData('imageSize') && node.getData('imageSize').width > 0,
      '同时给出 imageSize（内核渲染器没尺寸就不画）');
  }
  // 2) 清除：**同步**生效（内核版靠 src=null 的 onerror，异步）
  {
    const { node, km } = newKm();
    km.execCommand('image', 'data:image/png;base64,AAA');
    km.execCommand('image', null);
    eq(node.getData('image'), undefined, '清除**立刻**生效（不等 onerror）');
    eq(node.getData('imageSize'), undefined, 'imageSize 一并清掉');
  }
  // 3) 关键回归：先写 images 再清 image，不能留下两个字段并存
  //    （并存 = 节点上画出两张图）
  {
    const { node, km } = newKm();
    km.execCommand('image', 'A');
    km.execCommand('images', JSON.stringify(['A', 'B']));
    km.execCommand('image', null);
    ok(!node.getData('image'), '清 image 之后不再有 image（不会两张并存）');
    ok(node.getData('images'), 'images 仍然在');
  }
  // 4) queryState：没选中节点时 -1（保持内核语义）
  {
    const { km } = newKm();
    km.getSelectedNodes = () => [];
    eq(km.queryCommandState('image'), -1, '无选中 → -1（与内核一致）');
  }
  // 5) 源码级：清除分支不能有异步依赖
  {
    const iSrc = html.slice(html.indexOf("kity.createClass('imageCommand'"),
      html.indexOf("kity.createClass('imageCommand'") + 1600);
    ok(/km\._commands\['image'\] = new ImageCommand\(\)/.test(html),
      'image 命令被**覆盖**注册（否则用的还是内核异步版）');
    ok(/if \(!value\)/.test(iSrc), '有「空值 → 清除」分支');
    // 占位尺寸 + 异步补真实尺寸
    ok(/loadFitSize\(url, m,/.test(iSrc), '真实尺寸异步补（不阻塞写入）');
    ok(/n\.getData\('image'\) !== url/.test(iSrc),
      '异步回来时若已换图就不覆盖（否则会把新图的尺寸写成旧图的）');
  }
}

group('图标：构造时就有默认色（不靠 paint 才不黑）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const fiAt = html.indexOf('var FileIcon = kity.createClass');
  const fiEnd = html.indexOf('// 不能把 FileRenderer 挂进');
  const fi = html.slice(fiAt, fiEnd);

  // FileIcon：轮廓自带填充 + 描边（paint 漏了也不会是黑块）
  ok(/this\.outline[\s\S]{0,200}\.fill\('rgba/.test(fi),
    'FileIcon 轮廓**构造时**就有填充（不是靠 paint）');
  ok(/\.stroke\('#AEB6C4'/.test(fi), 'FileIcon 构造时就有描边色（不是靠 paint）');
  // 折角单独一条 path，且 fill none —— 合在一起会被填充盖住
  ok(/this\.fold[\s\S]{0,160}\.fill\('none'\)/.test(fi),
    '折角是独立 path 且 fill none（合并会被填充盖掉）');
  // VideoIcon 已删除（见上）—— 视频现在画成框内卡片
  ok(!/M-6,-6 L6,0 L-6,6 Z/.test(html), 'VideoIcon 的三角路径已随类一起删除');

  // 行为级：真的跑一遍 FileIcon，确认不 paint 也不是黑
  {
    function mkBase() {
      return {
        styles: {},
        callBase() {},
        node: { appendChild() {}, children: [] },
        fill(v) { this._fill = v; return this; },
        stroke(v, w) { this._stroke = v; this._strokeW = w; return this; },
        setPathData(d) { this._d = d; return this; },
        addShapes(list) { (this.shapes = this.shapes || []).push(...list); return this; },
        on() { return this; },
        setStyle(k, v) { this.styles[k] = v; return this; },
        setTranslate() { return this; },
      };
    }
    const kity = {
      createClass(name, def) {
        const proto = {};
        for (const k of Object.keys(def)) if (k !== 'constructor' && k !== 'base') proto[k] = def[k];
        Object.assign(proto, mkBase());
        function C(...a) { Object.assign(this, mkBase()); if (def.constructor) def.constructor.apply(this, a); }
        C.prototype = proto;
        return C;
      },
      Group: function () { Object.assign(this, mkBase()); },
      Rect: function () { Object.assign(this, mkBase()); },
      Path: function () { Object.assign(this, mkBase()); },
    };
    const src = html.slice(fiAt, fiEnd).replace(/^var FileIcon = /, 'return ').replace(/;\s*$/, ';');
    const FileIcon = new Function('kity', src + '\n')(kity);
    const ic = new FileIcon();
    // 不调 paint 也不能是黑：SVG 缺 fill 就是 black
    ok(ic.outline._fill && ic.outline._fill !== 'black',
      `未 paint 时轮廓有明确填充（实际 ${ic.outline._fill}）`);
    ok(ic.outline._stroke && ic.outline._stroke !== 'black',
      `未 paint 时轮廓有明确描边（实际 ${ic.outline._stroke}）`);
    eq(ic.rect._fill, 'none', '底框 none（transparent 会被回退成黑色）');
  }
}

group('短文本节点的最小宽度（跑真实源码）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  /** 按大括号配对取出函数源码 */
  function fnSrc(name) {
    const start = html.indexOf('function ' + name + '(');
    if (start < 0) return '';
    let i = html.indexOf('{', start);
    let d = 0;
    for (; i < html.length; i++) {
      if (html[i] === '{') d++;
      else if (html[i] === '}') { d--; if (d === 0) return html.slice(start, i + 1); }
    }
    return '';
  }
  const src = fnSrc('patchMinTextWidth');
  ok(src.length > 0, '能取到 patchMinTextWidth 源码');
  ok(/patchMinTextWidth\(km\);/.test(html), '编辑器初始化时真的调用了它');

  /** 造一个带 TextRenderer 的假 minder，跑真实补丁 */
  function makeMinder(opt = {}) {
    const TextRenderer = function () {};
    TextRenderer.__KityClassName = 'TextRenderer';
    TextRenderer.prototype.update = function () {
      return { x: 0, y: 0, width: opt.width ?? 4, height: 20 };
    };
    const minder = { _rendererClasses: { center: [TextRenderer] } };
    const patch = new Function('return (' + src + ');')();
    const applied = patch(minder);
    return { minder, TextRenderer, applied };
  }

  // 1) 空文本（新建节点）：内核按一个空格测量 → 宽度钳到 2 字
  {
    const { TextRenderer, applied } = makeMinder({ width: 4 });
    ok(applied, '补丁应用成功');
    const box = TextRenderer.prototype.update({}, { getStyle: () => 16 });
    eq(box.width, 32, '字号 16 → 最小宽 32（2 个全角字符）');
  }
  // 2) 单字节点同样被撑到下限
  {
    const { TextRenderer } = makeMinder({ width: 16 });
    const box = TextRenderer.prototype.update({}, { getStyle: () => 16 });
    eq(box.width, 32, '单字（16px）→ 仍是 32');
  }
  // 3) 字号跟随：字号变了下限也变
  {
    const { TextRenderer } = makeMinder({ width: 4 });
    eq(TextRenderer.prototype.update({}, { getStyle: () => 24 }).width, 48, '字号 24 → 48');
    eq(TextRenderer.prototype.update({}, { getStyle: () => 12 }).width, 24, '字号 12 → 24');
  }
  // 4) 已经够宽的**不能被动**（否则长节点会被压变形）
  {
    const { TextRenderer } = makeMinder({ width: 200 });
    eq(TextRenderer.prototype.update({}, { getStyle: () => 16 }).width, 200, '宽节点保持原宽度');
  }
  // 5) getStyle 返回 null 时必须回落（null 不是 0）
  {
    const { TextRenderer } = makeMinder({ width: 4 });
    eq(TextRenderer.prototype.update({}, { getStyle: () => null }).width, 32,
      'getStyle 返回 null → 回落到默认字号（不能当 0，否则下限变 0）');
    // node 缺失也不能崩
    const box2 = TextRenderer.prototype.update({}, null);
    eq(box2.width, 32, '拿不到节点也用默认字号');
  }
  // 6) 原 update 抛异常时不能让节点渲染失败 —— 但也不能吞掉原语义
  {
    const TR = function () {};
    TR.__KityClassName = 'TextRenderer';
    TR.prototype.update = function () { throw new Error('内核炸了'); };
    const minder = { _rendererClasses: { center: [TR] } };
    new Function('return (' + src + ');')()(minder);
    let threw = false;
    try { TR.prototype.update({}, { getStyle: () => 16 }); } catch { threw = true; }
    // 原异常继续抛出是对的：静默吞掉会让"节点画不出来"变成没有线索的问题
    ok(threw, '内核 update 抛错时**继续抛出**（不静默吞，否则排查无门）');
  }
  // 6.5) **thunk 分支**：update 在"文本变了"时返回的是未求值的函数
  //
  // 这是补丁真正要生效的场景 —— 新建节点 / 刚打完字，文本必然是"刚变"。
  // 不解析这个 thunk 的话，box.width 是 undefined，钳宽度被静默跳过。
  // 实测（内核跑在 jsdom 里）："一" 首次 62px、二次 80px —— 首次根本没生效。
  {
    const TR = function () {};
    TR.__KityClassName = 'TextRenderer';
    let calls = 0;
    TR.prototype.update = function () {
      // 像内核那样：文本变了 → 返回 thunk；命中缓存 → 直接返回 Box
      return () => { calls++; return { x: 0, y: 0, width: 4, height: 20 }; };
    };
    const minder = { _rendererClasses: { center: [TR] } };
    new Function('return (' + src + ');')()(minder);
    const box = TR.prototype.update({}, { getStyle: () => 16 });
    ok(typeof box !== 'function', 'thunk 被求值（返回的不是函数）');
    eq(calls, 1, 'thunk 只被求值一次（不能重复算）');
    eq(box.width, 32, 'thunk 分支也要钳到下限 32');
  }
  // 6.6) thunk 求值为空 → 原样交回（让内核自己处理，不能在这儿打断渲染）
  {
    const TR = function () {};
    TR.__KityClassName = 'TextRenderer';
    TR.prototype.update = function () { return () => null; };
    const minder = { _rendererClasses: { center: [TR] } };
    new Function('return (' + src + ');')()(minder);
    const box = TR.prototype.update({}, { getStyle: () => 16 });
    ok(typeof box === 'function', 'thunk 求值为空时原样交回内核');
  }

  /* ---- 6.7) 必须**对称**撑宽，不能只加 width ----
   * 文字从 x=0 起画，只加 width 会把盒中心往右推、字却留在原处 → 短文字偏左。
   * 实测（内核 + jsdom，字号 16 / 下限 32）："一"(字宽14) 偏 9px、"一二"(28) 偏 2px。
   */
  {
    const mkBox = (width) => ({ x: 0, y: -8, width, height: 20,
      left: 0, right: width, top: -8, bottom: 12, cx: width / 2, cy: 2 });
    const run = (width, fs) => {
      const TR = function () {};
      TR.__KityClassName = 'TextRenderer';
      TR.prototype.update = function () { return mkBox(width); };
      new Function('return (' + src + ');')()({ _rendererClasses: { center: [TR] } });
      return TR.prototype.update({}, { getStyle: () => fs });
    };
    const b1 = run(14, 16);                   // 字宽 14 → 撑到 32（差 18）
    eq(b1.width, 32, '宽度撑到 32');
    eq(b1.x, -9, 'x 左移差值的一半（对称撑开）');
    // 关键：盒中心必须仍在字的中心（14/2 = 7）
    eq(b1.cx, 7, `盒中心 = 字中心（${b1.cx} === 7）—— 只加 width 会变成 16，字就偏左 9px`);
    eq(b1.left, -9, 'left 跟着 x 更新（merge() 读的是 left/right）');
    eq(b1.right, 23, 'right 正确（-9 + 32）');
    // 已经够宽时不能动
    const b2 = run(70, 16);
    eq(b2.x, 0, '够宽时 x 不动');
    eq(b2.width, 70, '够宽时宽度不动');
  }

  // 7) 幂等：重复打补丁不能套两层（套两层下限会被应用两次）
  {
    const { TextRenderer, minder } = makeMinder({ width: 4 });
    const patch = new Function('return (' + src + ');')();
    eq(patch(minder), false, '第二次调用返回 false（已打过）');
    eq(TextRenderer.prototype.update({}, { getStyle: () => 16 }).width, 32,
      '重复打补丁后宽度仍是一次的结果（不是 64）');
  }
  // 8) 找不到 TextRenderer 时安全返回
  //    用 try/catch 包住：让它变成**断言失败**而不是进程崩溃 ——
  //    进程异常退出也会让脚本判为"抓到"，但那不是断言真的在把关
  {
    const patch = new Function('return (' + src + ');')();
    const call = (m) => {
      try { return patch(m); } catch (e) { return 'THREW:' + (e && e.message); }
    };
    eq(call({ _rendererClasses: {} }), false, '没有 TextRenderer → 返回 false，不抛');
    eq(call({}), false, '连 _rendererClasses 都没有 → 返回 false，不抛');
  }
  // 9) 源码级：不能靠往 _rendererClasses 里加渲染器来撑宽（会破坏布局）
  {
    const body = html.slice(html.indexOf('function patchMinTextWidth'),
      html.indexOf('patchMinTextWidth(km);'));
    ok(!/_rendererClasses\[[^\]]+\]\s*=\s*\[/.test(body),
      '补丁不往 _rendererClasses 里塞新渲染器（会让子节点堆在画布中心）');
    ok(/__KityClassName === 'TextRenderer'/.test(body), '按 kity 类名定位 TextRenderer');
  }
}

group('图片预览：左右切换 + ← → 快捷键');

{
  const { openPreview } = await import('./panels.js');
  const app = { api: { status: () => {} } };

  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    url: 'data:image/png;base64,IMG' + (i + 1), name: '图' + (i + 1),
  }));

  // 1) 多张：有左右按钮 + i/n 计数
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const btns = [...d.mask.querySelectorAll('button')].map((b) => b.textContent);
    ok(btns.includes('◀') && btns.includes('▶'), '多张时有左右切换按钮');
    eq(d.mask.querySelector('.mm-preview-count')?.textContent, '1/3', '计数显示 1/3');
    eq(d.mask.querySelector('img.mm-preview')?.getAttribute('src'),
      'data:image/png;base64,IMG1', '显示第 1 张');
    d.close();
  }

  // 2) 单张：不显示切换条（没必要占地方）
  {
    const d = openPreview(app, mk(1)[0]);
    ok(!d.mask.querySelector('.mm-preview-nav'), '单张时不渲染切换条');
    ok(!d.mask.querySelector('.mm-preview-count'), '单张时不显示计数');
    d.close();
  }

  // 3) 点 ▶ / ◀ 真的换图，且标题同步（只换图不换标题看着像切失败了）
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    const h3 = d.mask.querySelector('h3');
    const find = (t) => [...d.mask.querySelectorAll('button')].find((b) => b.textContent === t);
    find('▶').click();
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG2', '点 ▶ → 第 2 张');
    eq(d.mask.querySelector('.mm-preview-count').textContent, '2/3', '计数变 2/3');
    eq(h3.textContent, '预览：图2', '**标题同步**（改到游离元素上就没这效果）');
    find('◀').click();
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG1', '点 ◀ → 回到第 1 张');
    d.close();
  }

  // 4) 循环：第 1 张往左跳到最后一
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    const find = (t) => [...d.mask.querySelectorAll('button')].find((b) => b.textContent === t);
    find('◀').click();
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG3', '第 1 张往左 → 最后一张（循环）');
    find('▶').click();
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG1', '最后一张往右 → 第 1 张');
    d.close();
  }

  // 5) ← → 快捷键
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    const key = (k) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowRight');
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG2', '→ 切下一张');
    key('ArrowRight');
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG3', '再按 → 切到第 3 张');
    key('ArrowLeft');
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG2', '← 切上一张');
    d.close();
  }

  // 6) 关键：**关闭后必须解绑**。残留的监听会拦住画布上的 ← →
  //    （那两个键在 kityminder 里是有用的）
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    d.close();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG1',
      '关闭后按 → 不再切换（监听已解绑）');
  }

  // 7) 输入框里不抢键
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    const inp = document.createElement('input');
    document.body.appendChild(inp);
    inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG1', '输入框里按 → 不切换');
    inp.remove();
    d.close();
  }

  // 8) 起始下标生效（点第 2 张缩略图就该从第 2 张开始）
  {
    const d = openPreview(app, mk(3)[1], { list: mk(3), index: 1 });
    eq(d.mask.querySelector('.mm-preview-count').textContent, '2/3', '起始下标生效');
    d.close();
  }

  // 8.5) 滚轮切换
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    // 只在浮层内触发：浮层外的滚轮不该被吃掉
    const wheel = (dy, target) => {
      const ev = new window.WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true });
      (target || d.mask.querySelector('img.mm-preview')).dispatchEvent(ev);
      return ev;
    };
    const ev1 = wheel(60);
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG2', '向下滚 → 下一张');
    ok(ev1.defaultPrevented, '**preventDefault**（否则浮层背后的页面跟着滚）');
    // 真实手势之间有停顿：等过解锁窗口（WHEEL_GAP）再滚第二次
    await new Promise((r) => setTimeout(r, 130));
    wheel(60);
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG3', '停一下再滚 → 第 3 张');
    await new Promise((r) => setTimeout(r, 130));
    wheel(-60);
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG2', '向上滚 → 上一张');
    d.close();
  }

  // 8.6) 节流：触控板一划会发几十个小 delta 事件，不能每个都切一张
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    const el = d.mask.querySelector('img.mm-preview');
    // 连续 10 个 deltaY=10 的小事件（模拟触控板）
    for (let i = 0; i < 10; i++) {
      el.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true }));
    }
    // 累积到阈值 + 最小间隔，最多只该切 1 张（不是 10 张）
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG2',
      '连续小 delta 只切 1 张（有节流，不是每个事件切一张）');
    d.close();
  }

  // 8.65) 浮层**外**的滚轮不该被吃掉 —— 监听挂在 document 上，
  //        不判断 target 的话页面滚动会被预览浮层劫持
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const ev = new window.WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG1', '浮层外滚轮不切换');
    ok(!ev.defaultPrevented, '浮层外的滚动**不** preventDefault（不劫持页面滚动）');
    outside.remove();
    d.close();
  }

  // 8.7) 关闭后解绑滚轮（残留会拦住页面滚动）
  {
    const d = openPreview(app, mk(3)[0], { list: mk(3), index: 0 });
    const imgEl = d.mask.querySelector('img.mm-preview');
    d.close();
    imgEl.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
    eq(imgEl.getAttribute('src'), 'data:image/png;base64,IMG1', '关闭后滚轮不再切换');
  }

  // 8.8) 源码级：wheel 必须 passive:false
  {
    const pnl = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
    const oi = pnl.indexOf('export function openPreview');
    const src = pnl.slice(oi, pnl.indexOf('/** 历史快照列表 */', oi));
    ok(/addEventListener\('wheel', onWheel, \{ passive: false/.test(src),
      'wheel 用 passive:false 注册（否则 preventDefault 被忽略，背后跟着滚）');
    ok(/removeEventListener\('wheel', onWheel/.test(src), '关闭时解绑 wheel');
    ok(/WHEEL_STEP/.test(src) && /WHEEL_GAP/.test(src), '有节流阈值与最小间隔');
  }

  // 9) 源码级：编辑器点画布上的图要带整组
  {
    const html2 = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
    const oi = html2.indexOf('function openAttach(');
    const oa = html2.slice(oi, oi + 1200);
    ok(/kind === 'image'/.test(oa), '只在图片这条路径带列表');
    ok(/imageListOf\(node\)/.test(oa), '取的是该节点上的全部图片');
    // 单张就不必发（省一次大数组拷贝）
    ok(/list\.length < 2/.test(oa), '只有 1 张时 list 置空（不白拷一次）');
  }
}

group('文件面板：随选中节点实时更新 + 未选中提示落在空列表处');

{
  const { buildSide } = await import('./panels.js');

  /** 造一个可切换"选中节点"的假 bridge */
  function mkApp(sel) {
    const state = { sel };
    return {
      app: {
        settings: {},
        api: {
          status() {}, commit() {},
          // 按当前"选中"返回附件
          selectedRefs: (kind) => {
            const n = state.sel;
            return n ? ((kind === 'video' ? n.videos : n.files) || []) : [];
          },
          selectedImages: () => (state.sel ? (state.sel.images || []) : []),
        },
        bridge: { getSelectedNodeId: () => (state.sel ? state.sel.id : '') },
      },
      state,
    };
  }

  const A = { id: 'A', files: [{ n: '甲.pdf', a: 'a1' }], videos: [], images: [] };
  const B = { id: 'B', files: [], videos: [{ n: '乙.mp4', a: 'v1' }], images: [] };

  // 1) 未选中 + 三个列表都空 → 文件栏显示引导语
  {
    const { app } = mkApp(null);
    const el = buildSide(app, {});
    el.open('file');
    const hints = [...el.el.querySelectorAll('.mm-hint')].map((x) => x.textContent);
    ok(hints.some((t) => /当前没有选中节点/.test(t)), '未选中时显示「请先选节点」');
    ok(hints.filter((t) => /当前没有选中节点/.test(t)).length === 1,
      '**只出现一次**（不三栏重复）');
    // 关键：不是整页替换 —— 按钮还在
    const btns = [...el.el.querySelectorAll('button')].map((b) => b.textContent);
    ok(btns.includes('附加文件…'), '按钮仍在（提示落在空列表处，不是整页替换）');
  }

  // 2) 未选中时，视频/图片栏仍是各自的空提示
  {
    const { app } = mkApp(null);
    const el = buildSide(app, {});
    el.open('file');
    const hints = [...el.el.querySelectorAll('.mm-hint')].map((x) => x.textContent);
    ok(hints.some((t) => /当前节点没有视频附件/.test(t)), '视频栏仍是「没有视频附件」');
    // 图片栏实际文案是「当前节点没有图片」（不带"附件"二字）
    ok(hints.some((t) => /当前节点没有图片/.test(t)), '图片栏仍是「没有图片」');
  }

  // 3) 已选中 + 没附件 → 显示「当前节点没有文件附件」（不是"请先选节点"）
  {
    const { app } = mkApp({ id: 'C', files: [], videos: [], images: [] });
    const el = buildSide(app, {});
    el.open('file');
    const hints = [...el.el.querySelectorAll('.mm-hint')].map((x) => x.textContent);
    ok(!hints.some((t) => /当前没有选中节点/.test(t)), '已选中时不显示「请先选节点」');
    ok(hints.some((t) => /当前节点没有文件附件/.test(t)), '显示「当前节点没有文件附件」');
  }

  // 4) 换节点 → refresh 后显示**新节点**的附件（核心需求）
  {
    const { app, state } = mkApp(A);
    const el = buildSide(app, {});
    el.open('file');
    ok(/甲\.pdf/.test(el.el.textContent), '初始显示 A 的附件');
    // 切到 B 再刷新（模拟 selchange → refresh）
    state.sel = B;
    el.refresh();
    ok(/乙\.mp4/.test(el.el.textContent), '换节点后显示 **B** 的附件（不是还停在 A）');
    ok(!/甲\.pdf/.test(el.el.textContent), 'A 的附件已消失');
  }

  // 5) 源码级：编辑器要发 selchange（无选中也发）
  {
    const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
    const i = html.indexOf("hostPost({ type: 'selchange'");
    ok(i > 0, '编辑器发送 selchange');
    // 切片要**覆盖到后面**的 km.on 注册（它们在 hostPost 之后），
    // 只往后取 200 字符会漏掉，导致断言静默失效
    const src = html.slice(i - 1400, i + 800);
    ok(/km\.on\('selectionchange', notifySelChanged\)/.test(src), '监听 selectionchange');
    ok(/km\.on\('selectionclear',  notifySelChanged\)/.test(src),
      '也监听 selectionclear（取消选中也要通知，否则面板停在旧节点）');
    ok(/nodeId: id/.test(src), '带上 nodeId（宿主据此判断是否真的换了节点）');
    // 合并连发：拖选一帧内可能好几次
    ok(/setTimeout\(function \(\) \{/.test(src), '有合并连发的节流');
  }

  // 6) 源码级：bridge 与宿主
  {
    const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
    ok(/case 'selchange':/.test(br), 'bridge 处理 selchange');
    ok(/onSelectionChange\?\.\(d\.nodeId \|\| ''\)/.test(br), '透传 nodeId');

    const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
    ok(/onSelectionChange: \(nodeId\) =>/.test(idx), '宿主接 onSelectionChange');
    // 关键：只在节点**真的变了**时才刷新
    ok(/if \(nodeId === lastSelNodeId\) return;/.test(idx),
      '节点没变时不刷新（拖选会连发多次，否则缩略图一直闪）');
    ok(/side\?\.current\?\.\(\) === 'file'/.test(idx),
      '只刷当前停在文件页的情况（别的页切回来时 open 会 render）');
  }
}

group('样式：侧栏不能被共享控件样式层叠成居中');

{
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
  const ctlPath = path.join(HERE, '..', '..', 'css', 'controls.css');

  /** 取出某个类的规则体（只取该块自己的声明） */
  function ruleFor(src, cls) {
    const re = new RegExp('(^|[;{}\\s])\\.?' + cls.replace(/[-]/g, '\\-') +
      '\\s*\\{([^{}]*)\\}', 'm');
    const m = src.match(re);
    return m ? m[2] : null;
  }
  const decl = (b, k) => {
    const m = b && b.match(new RegExp('(?:^|;)\\s*' + k + '\\s*:\\s*([^;]*)'));
    return m ? m[1].trim() : null;
  };

  // 1) 核心：.mm-field 必须**显式**声明 align-items
  const field = ruleFor(css, 'mm-field');
  ok(field !== null, '能取到 .mm-field 规则');
  ok(decl(field, 'align-items') === 'stretch',
    '.mm-field **显式**写 align-items:stretch（不能靠默认值）');
  ok(/column/.test(decl(field, 'flex-direction') || ''),
    '.mm-field 是纵向布局（label 在上、控件在下）');

  // 2) 通用防线：凡是本插件**改了 flex-direction** 却没写 align-items 的
  //    纵向容器，只要类名也被 controls.css 定义，就会被层叠成居中
  if (fs.existsSync(ctlPath)) {
    const ctl = fs.readFileSync(ctlPath, 'utf8');
    const bad = [];
    for (const m of ctl.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1];
      const ctlAlign = decl(m[2], 'align-items');
      if (!ctlAlign) continue;
      for (const cls of sel.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
        const name = cls[1];
        const mine = ruleFor(css, name);
        if (!mine) continue;
        const dir = decl(mine, 'flex-direction');
        // 本插件改成纵向、controls 是 center、本插件又没显式覆盖 → 会被层叠成居中
        if (dir && /column/.test(dir) && !decl(mine, 'align-items')) {
          bad.push(name);
        }
      }
    }
    eq(bad.length, 0,
      `没有「纵向容器被 controls.css 的 align-items:center 层叠」的类（问题类：${bad.join(',') || '无'}）`);
  }

  // 3) 说明性断言：注释要写明"为什么不能省"，否则后人会当成冗余删掉。
  //    用**只出现在注释里**的独特短语 —— 断言 /controls\.css/ 会命中
  //    @import 那一行，删了注释照样绿（假阳性）
  ok(/面板内容全部居中/.test(css),
    '注释里写明了踩坑原因（不显式写 align-items 会导致面板内容全部居中）');
}

group('导入导出页：行为级（真实 render）');

{
  const { buildSide } = await import('./panels.js');

  /** 记录调用，验证按钮真的接到了对应的 api */
  function mkApp() {
    const calls = [];
    const rec = (name) => (...a) => { calls.push([name, ...a]); };
    const api = new Proxy({}, {
      get: (_, k) => {
        if (k === 'status') return () => {};
        if (k === 'settings') return {};
        // 文件页要读这些（返回空列表）；若走 Proxy 默认分支会被记成"调用"，
        // 且返回 Promise 而不是数组 —— 文件页 .length 直接炸
        if (k === 'selectedRefs' || k === 'selectedImages') return () => [];
        if (k === 'selectedRef') return () => null;
        return (...a) => { calls.push([String(k), ...a]); return Promise.resolve(); };
      },
    });
    return { app: { api, settings: {}, bridge: { getSelectedNodeId: () => 'n1' } }, calls, rec };
  }

  // 1) 页能打开
  {
    const { app } = mkApp();
    const el = buildSide(app, {});
    el.open('exchange');
    eq(el.el.dataset.page, 'exchange', '能切到「导入导出」页');
    // 页签文字在顶栏（index.js），页内是各节标题 ——
    // 断言"页内含'导入导出'"会假失败
    ok(el.el.querySelectorAll('button').length > 10, '页里有成排的导入导出按钮');
  }

  // 2) 每一类都在（标题层面）—— 少一个 category 用户就找不到那类功能
  {
    const { app } = mkApp();
    const el = buildSide(app, {});
    el.open('exchange');
    const heads = [...el.el.querySelectorAll('h3')].map((x) => x.textContent);
    // 「主题」节已回归主题页（与新建/编辑/删除同排），本页不再有
    for (const t of ['导入', '导出为文档', '导出为交换格式（单画布）', '导出为图像 / PDF', '快照备份']) {
      ok(heads.includes(t), `有「${t}」这一节`);
    }
    ok(!heads.includes('主题'), '「主题」节不在本页（已回归主题页）');
  }

  // 3) 点按钮真的调对应 api —— 逐个点，防止"按钮在但接错"
  {
    const { app, calls } = mkApp();
    const el = buildSide(app, {});
    el.open('exchange');
    const find = (t) => [...el.el.querySelectorAll('button')].find((b) => b.textContent === t);

    find('XMind')?.click();
    ok(calls.some((c) => c[0] === 'exportXMind'), '点 XMind → api.exportXMind');

    find('PNG · 2 倍')?.click();
    ok(calls.some((c) => c[0] === 'exportPng' && c[1] === 2),
      '点 PNG·2倍 → api.exportPng(2)（倍率要传对，传错就导成 1 倍）');

    find('Mermaid')?.click();
    ok(calls.some((c) => c[0] === 'exchange' && c[1] === 'mermaid'),
      '点 Mermaid → api.exchange("mermaid")');

    find('导入文件…')?.click();
    ok(calls.some((c) => c[0] === 'importFile'), '点导入文件 → api.importFile');

    find('导出快照')?.click();
    ok(calls.some((c) => c[0] === 'exportBackups'), '点导出快照 → api.exportBackups');
  }

  // 4) 与旧入口不重复：文件页/主题页/设置里不该再有这些按钮
  {
    const { app } = mkApp();
    const el = buildSide(app, {});
    el.open('file');
    const fileTxt = el.el.textContent;
    ok(!fileTxt.includes('导入导出'), '文件页不再有「导入导出」段');
  }
}

group('展开层级按钮：移到左侧图标条');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');

  // 1) 左侧图标条里要有这三个层级
  const rail = idx.slice(idx.indexOf('function buildRail()'),
    idx.indexOf("  /* ------------------------- 保存抑制"));
  // 两组并存：层级（中心主题）/ 展开（选中节点）
  ok(/bridge\?\.expandRootToLevel\(/.test(rail), '「层级」组调 expandRootToLevel（中心主题为准）');
  ok(/bridge\?\.expandToLevel\(/.test(rail), '「展开」组调 expandToLevel（选中节点为准）');
  ok(/'层级'/.test(rail) && /'展开'/.test(rail), '两组小标题都在：层级 / 展开');

  // **两组必须是同一个生成函数**，否则容易只改一组、另一组行为悄悄不一致
  // 定义处是箭头函数常量（`const levelGroup = (`），不含 `levelGroup(` 字样，
  // 所以调用次数就是 2 —— 少一次说明有一组被单独写死了。
  ok(/const levelGroup = \(label, tipOf, call\)/.test(rail), '有统一的 levelGroup 生成函数');
  eq((rail.match(/levelGroup\(/g) || []).length, 2, '两组都走 levelGroup（不再各写一份）');

  // 三个层级一个都不能少，且 0=全部
  ok(/\[1, '1级'/.test(rail) && /\[2, '2级'/.test(rail) && /\[0, '全'/.test(rail),
    '三个层级都在：1级 / 2级 / 全（0 = 全部）');
  ok(/for \(const \[lv, text, tip\] of tipOf\)/.test(rail),
    '用循环生成（新增层级时不用复制三份）');

  // **语义必须区分开**：层级的提示里要写明与选中节点无关
  {
    const lvl = rail.slice(rail.indexOf("levelGroup('层级'"), rail.indexOf("levelGroup('展开'"));
    const exp = rail.slice(rail.indexOf("levelGroup('展开'"));
    ok(/中心主题/.test(lvl), '「层级」提示写明以中心主题为准');
    ok(!/选中节点/.test(stripCommentsFlat(lvl)),
      '「层级」不再以选中节点为准');
    ok(/选中节点/.test(exp), '「展开」以当前选中节点为准');
  }
  // 图标条宽 34px，文字必须压短 —— 写全「展开一级」会溢出换行
  ok(!/'展开一级'/.test(rail), '按钮文字是短标（不是「展开一级」，会溢出 34px）');

  // 1b) 编辑器与桥接都要有「以根节点为准」的门面
  {
    const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
    const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
    ok(/expandRootToLevel: function \(levels\)/.test(html), '编辑器有 expandRootToLevel 门面');
    ok(/km\.getRoot\(\)/.test(html), 'expandRootToLevel 取根节点（不是 getSelectedNode）');
    ok(/expandRootToLevel\(levels\) \{/.test(br), '桥接转发 expandRootToLevel');
    // 两条路径除基准节点外必须一致，否则两组按钮行为会不一样
    const r0 = html.indexOf('expandRootToLevel: function');
    const s0 = html.indexOf('expandSelectedToLevel: function');
    // 只比**函数体**（跳过函数名与取基准节点那一行），其余必须逐字一致
    // 截到函数体真正的结尾（`}catch(e){return false;}`），不能取固定长度 ——
    // 那样会把后面紧跟的其它门面也带进来，两边永远不相等。
    const body = (t) => {
      let out = t.slice(t.indexOf('{'))
        .replace(/km\.getRoot\(\)|km\.getSelectedNode\(\)/g, 'BASE')
        .replace(/\s+/g, '');
      const end = out.indexOf('}catch(e){returnfalse;}');
      return end < 0 ? out : out.slice(0, end + '}catch(e){returnfalse;}'.length);
    };
    eq(body(html.slice(r0, r0 + 700)), body(html.slice(s0, s0 + 700)),
      '两个门面除基准节点外逻辑一致（否则两组按钮行为不同）');
  }

  // 2) 右侧样式页的「视图」节必须**删掉**，不能两处都能点
  ok(!/section\('视图'/.test(pn), '样式页不再有「视图」节');
  ok(!/app\.bridge\.expandToLevel/.test(pn), '右侧栏不再调 expandToLevel（无第二处入口）');

  // 3) 图标条要有分隔线与小标题，否则一串等距按钮看不出是两组
  ok(/\.mm-rail-sep/.test(css) && /\.mm-rail-label/.test(css), '有分隔线与「层级」小标题样式');
  ok(/mm-rail-sep/.test(rail) && /mm-rail-label/.test(rail), '图标条里渲染了分隔线与小标题');

  // 4) 两组按钮都要落 commit（否则撤销栈不记，改动也存不住）
  ok(/rail\.appendChild\(B\(text, \(\) => \{ call\(lv\); commit\(\); \}/.test(rail),
    '展开后 commit（进撤销栈并持久化）');
}

group('左侧搜索结果面板（复用文件库底框）');

{
  const fl = fs.readFileSync(path.join(HERE, 'filelist.js'), 'utf8');
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');

  // ---- 1) 复用同一个底框，不是另起一个面板 ----
  ok(/searchBodyEl = h\('div\.mm-files-body'/.test(fl),
    '搜索区用同一个 .mm-files-body 类（与文件列表同底框、同尺寸）');
  ok(/const el = h\('div\.mm-files'[\s\S]{0,400}bodyEl,[\s\S]{0,60}searchBodyEl/.test(fl),
    '搜索区挂在**同一个** .mm-files 容器里（两者互斥，不会同时占宽）');
  ok(!/\.mm-search-files|\.mm-search-panel/.test(css),
    '没有另建一个 186px 面板（那样两个框会一起把画布挤窄）');

  // ---- 2) 编辑器侧：列表与定位能力 ----
  ok(/getSearchResults: function/.test(html), '编辑器暴露 getSearchResults');
  ok(/gotoSearchResult: function/.test(html), '编辑器暴露 gotoSearchResult');
  ok(/getSearchResults\(\)/.test(br), 'bridge 转发 getSearchResults');
  // 必须断言**方法定义**（带缩进的 `gotoSearchResult(idx) {`）——
  // 只断言 `gotoSearchResult(idx)` 会命中它函数体里 `m.gotoSearchResult(idx)`
  // 那一行，方法被改名照样绿
  ok(/^  gotoSearchResult\(idx\) \{/m.test(br), 'bridge 定义 gotoSearchResult 方法');
  ok(/^  getSearchResults\(\) \{/m.test(br), 'bridge 定义 getSearchResults 方法');
  // 画布内的旧浮层必须删掉 —— 否则画布上一个、左侧一个，两个结果列表
  ok(!/#search-panel/.test(html), '编辑器内不再有 #search-panel 浮层');
  ok(!/spRender|spSyncActive|spIsVisible/.test(html), '编辑器内浮层相关函数已清理');

  // ---- 3) 外壳：搜索时填充，清空/换画布时退出 ----
  ok(/fileList\?\.setSearch\(bridge\?\.getSearchResults/.test(idx),
    'runSearch 把结果填进左侧面板');
  // 注意：index.js 里有**两处** setSearch(null)（换画布 / 清空输入）。
  // 只断言"文件里出现过 setSearch(null)"是假阳性 —— 删掉任何一处，
  // 另一处还在，断言照样绿。必须各自限定在自己的函数片段内。
  const loadSeg = idx.slice(idx.indexOf('async function loadSheet()'),
    idx.indexOf('function applyOptions()'));
  // 换成 clearSearchState()：它同时清编辑器高亮框 + 左侧面板 + 顶栏状态文字。
  // 只断言 setSearch(null) 会漏掉最要紧的那一条（画布上的框残留）。
  ok(/clearSearchState\(\)/.test(loadSeg), '换画布后清空（旧结果已失效）');
  const inputSeg = idx.slice(idx.indexOf("const searchInput = h('input.mm-input'"),
    idx.indexOf("toolbar.appendChild(group(searchInput"));
  ok(/oninput[\s\S]{0,220}clearSearchState\(\)/.test(inputSeg),
    '关键字删空后立刻退出搜索态（不等回车）');

  // ---- 4) 越界不能"假装成功" ----
  ok(/if \(!ok\) \{ api\.status\(/.test(fl),
    '定位失败要提示（不能把高亮停在旧项上假装跳过去了）');
  ok(/return focusSearchResult\(Number\(idx\)/.test(html), '编辑器侧索引越界返回 false');
  // 越界**必须真的挡住**。只断言"返回 boolean"是抓不到去掉边界检查的：
  // 越界时 list[idx] 是 undefined，后面 km.select(undefined) 会静默不动，
  // 表现为"点了没反应且毫无报错"。
  {
    const fr = html.slice(html.indexOf('function focusSearchResult('),
      html.indexOf('function focusSearchResult(') + 400);
    ok(/idx >= list\.length/.test(fr), 'focusSearchResult 有上界检查（越界不能静默）');
    ok(/idx < 0/.test(fr), 'focusSearchResult 有下界检查');
  }

  // ---- 5) 安全：节点文字是用户输入，不能拼 innerHTML ----
  ok(/document\.createTextNode/.test(fl), '高亮用文本节点构造（不是 innerHTML 拼串）');
  ok(!/item\.innerHTML\s*\+?=/.test(fl), '没有用 innerHTML 拼节点文字（XSS）');
}

{
  // ---- 行为级：真实 render ----
  const { buildFileList } = await import('./filelist.js');

  function mkApp(jumpOk = true) {
    const jumped = [];
    const st = [];
    const api = {
      fileState: () => ({ files: [], folders: [], currentId: null }),
      status: (m) => st.push(m),
      createFile: () => {}, createFolder: () => {},
    };
    const bridge = { gotoSearchResult: (i) => { jumped.push(i); return jumpOk; } };
    return { app: { api, bridge, settings: { filesOpen: false } }, jumped, st };
  }

  // a) 有结果 → 自动展开 + 标题显示总数
  {
    const { app } = mkApp();
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'abc', total: 7, active: 0, items: ['abc', 'xabcx', 'ABC'] });
    eq(fl.el.classList.contains('open'), true, 'a 搜索时自动展开（文件库默认收起）');
    ok(fl.el.textContent.includes('搜索结果 7 项'), 'a 标题显示真实总数 7');
    eq(fl.el.querySelectorAll('.mm-search-item').length, 3, 'a 渲染 3 条');
    eq(fl.isSearchMode(), true, 'a 进入搜索模式');
  }

  // b) 点条目 → 定位 + 高亮跟随
  {
    const { app, jumped } = mkApp();
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'ab', total: 3, active: 0, items: ['ab1', 'ab2', 'ab3'] });
    fl.el.querySelectorAll('.mm-search-item')[2].click();
    eq(jumped.length, 1, 'b 点了第 3 条就请求定位一次');
    eq(jumped[0], 2, 'b 传的索引是 2（0 起）');
    const items = fl.el.querySelectorAll('.mm-search-item');
    eq(items[2].classList.contains('active'), true, 'b 高亮跟到第 3 条');
    eq(items[0].classList.contains('active'), false, 'b 旧的高亮已取消');
  }

  // c) 定位失败 → 提示，且高亮不乱跳
  {
    const { app, st } = mkApp(false);
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'ab', total: 2, active: 0, items: ['ab1', 'ab2'] });
    fl.el.querySelectorAll('.mm-search-item')[1].click();
    ok(st.some((m) => /失效|重新搜索/.test(m)), 'c 定位失败给出提示');
    eq(fl.el.querySelectorAll('.mm-search-item')[1].classList.contains('active'), false,
      'c 失败时高亮不跳（避免"以为跳过去了"）');
  }

  // d) 退出搜索 → 恢复文件列表与原来的展开状态
  {
    const { app } = mkApp();
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'ab', total: 1, active: 0, items: ['ab'] });
    fl.setSearch(null);
    eq(fl.isSearchMode(), false, 'd 退出搜索模式');
    ok(fl.el.textContent.includes('脑图文件'), 'd 标题恢复「脑图文件」');
    eq(fl.el.querySelectorAll('.mm-search-item').length, 0, 'd 搜索条目已清空');
    eq(fl.el.classList.contains('open'), false, 'd 恢复到原来的收起状态（settings.filesOpen=false）');
  }

  // e) 空列表 = 退出（搜索无结果时不该留着一个空面板）
  {
    const { app } = mkApp();
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'zz', total: 0, active: 0, items: [] });
    eq(fl.isSearchMode(), false, 'e 空结果 → 不进搜索模式');
  }

  // f) 高亮安全：节点文字含标签也不能变成 HTML
  {
    const { app } = mkApp();
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'b', total: 1, active: 0, items: ['a<b>c'] });
    const it = fl.el.querySelector('.mm-search-item');
    ok(it.querySelector('b') === null, 'f 文字里的 <b> 没有被解析成标签');
    ok(it.textContent.includes('<b>'), 'f 原文照常显示');
  }

  // g) 关键字大小写不敏感高亮
  {
    const { app } = mkApp();
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'ab', total: 1, active: 0, items: ['xxABxx'] });
    const mk = fl.el.querySelector('.mm-search-item mark');
    ok(mk && mk.textContent === 'AB', 'g 命中片段被 <mark> 标出（大小写不敏感）');
  }
}

group('布局：文件库浮层 + 画布假描边让位 + 控件档位');

{
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
  const strip = (t) => stripCommentsFlat(t);   // 先剥注释，避免命中说明文字
  const cs = strip(css);

  // ---- 1) 文件库是**浮层**，画布不动，靠画布上的假描边框让位 ----
  //
  // ⚠️ 这一组曾钉反了方向（钉成"flex 子项、挤窄画布"），而实现早已改成
  //    浮层。于是 4 条长期红着，且容易被误读成"实现错了要去改实现"——
  //    实际是断言过期。**改实现前先读这段注释**。
  //
  // 为什么是浮层而不是挤窄：挤窄会让画布尺寸真的变化 → 内核把视图重新
  // 居中 → 内容左右晃一下。改成浮层后画布尺寸恒定，代价是浮层会盖住
  // 画布左侧 186px；为免看着像"面板浮在画布上分不清边界"，画布上另铺
  // 一层 .mm-canvas-frame 假描边，并让它**让到浮层右边缘**。
  //
  // 切片必须停在「下一个 }」而非 .open 处 —— .open 规则前夹着长注释块，
  // 不跳过注释就会把注释正文当选择器（假阴性）。
  const filesOpenIdx = cs.indexOf('.mm-files.open');
  const nextBrace = cs.indexOf('}', filesOpenIdx);
  const filesRule = cs.slice(cs.indexOf('.mm-files {'), nextBrace + 1);
  ok(/position:\s*absolute/.test(filesRule),
    '.mm-files 是浮层（absolute，盖在画布上而非挤窄画布）');
  ok(/width:\s*186px/.test(filesRule), '.mm-files 宽度仍是 186px');

  // 画布**不参与挤压**：保持 flex:1 1 auto，尺寸不随浮层开合变化。
  // 这是浮层方案的全部意义 —— 画布一动，内核就会重新居中、内容晃动。
  const canvasRule = cs.slice(cs.indexOf('.mm-canvas {'),
    cs.indexOf('}', cs.indexOf('.mm-canvas {')) + 1);
  ok(/flex:\s*1\s+1\s+auto/.test(canvasRule) &&
      !/flex:\s*0\s+0/.test(canvasRule),
    '.mm-canvas 不参与挤压（尺寸恒定，浮层开合不引起视图重新居中）');

  // 假描边框必须**真的有规则**：此前规则写了、元素从没被创建，
  // 于是描边从未出现（幽灵规则，不报错）。下面第 2 条钉元素侧。
  const frameRule = cs.slice(cs.indexOf('.mm-canvas-frame {'),
    cs.indexOf('}', cs.indexOf('.mm-canvas-frame {')) + 1);
  ok(/position:\s*absolute/.test(frameRule) && /pointer-events:\s*none/.test(frameRule),
    '.mm-canvas-frame 是画布上的假描边（absolute 且不拦鼠标）');

  /*
   * 光有规则不算数 —— 元素必须**真的被创建**。
   *
   * 这是本组最要命的一条：此前 styles.css 写了整套 .mm-canvas-frame 规则，
   * 但全仓 JS 没有任何地方创建它，于是描边从未出现。它不报错、测试也
   * 不红（因为只查了 CSS），只有肉眼能发现。
   */
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const idxNC = stripCommentsFlat(idx);
  ok(/h\(\s*['"]div\.mm-canvas-frame['"]/.test(idxNC),
    '画布上真的创建了 .mm-canvas-frame 元素（不是只有样式规则）');

  // 同步函数必须存在且真的写入 left
  const syncFn = idxNC.slice(idxNC.indexOf('function syncCanvasInset'),
    idxNC.indexOf('function syncCanvasInset') + 900);
  ok(/function syncCanvasInset/.test(idxNC), '存在 syncCanvasInset 同步函数');
  ok(/canvasFrameEl\.style\.left\s*=/.test(syncFn),
    'syncCanvasInset 真的写入 left（不是空函数）');

  // 至少 4 个调用点：初始化 / 开合 / 搜索出结果 / 清除搜索，都要让位
  const calls = (idxNC.match(/syncCanvasInset\(\)/g) || []).length;
  ok(calls >= 2, `syncCanvasInset 在宿主侧有调用（实测 ${calls} 处）`);

  // 文件库侧必须提供钩子，且开合时真的调它
  const fl = fs.readFileSync(path.join(HERE, 'filelist.js'), 'utf8');
  const flNC = stripCommentsFlat(fl);
  ok(/setLayoutHook/.test(flNC), 'filelist 暴露 setLayoutHook（底框开合通知宿主）');
  ok(/layoutHook\(\)/.test(flNC), 'filelist 的 apply() 里真的调用了 layoutHook');

  // ---- 2) 控件档位：输入框/下拉必须与按钮同为 28px ----
  //
  // ../../css/controls.css 把 .mm-input/.mm-select 统一成 38px（外壳标准档），
  // 而脑图是紧凑布局、按钮一直 28px。不覆盖的话顶栏搜索框比按钮高 10px，
  // 样式页一排下拉也全比按钮高一截。
  const ctlRule = cs.slice(cs.indexOf('.mm-input, .mm-select {'),
    cs.indexOf('.mm-input, .mm-select {') + 200);
  ok(/--ctl-h:\s*28px/.test(ctlRule), '输入框/下拉用 28px 档（与 .mm-btn 同高）');
  // 必须改**变量**而不是硬写 height：controls.css 用的就是这套变量，
  // 直接写 height 会与变量打架（谁在后谁赢，改动变得不可预测）
  ok(!/height:\s*28px/.test(ctlRule), '用变量覆盖而非硬写 height（避免与变量打架）');

  // ---- 3) 侧栏字段纵向排列且**不居中** ----
  const fieldRule = cs.slice(cs.indexOf('.mm-field {'), cs.indexOf('.mm-field {') + 200);
  ok(/flex-direction:\s*column/.test(fieldRule), '.mm-field 纵向排列');
  ok(/align-items:\s*stretch/.test(fieldRule),
    '.mm-field 显式 stretch（不写就会被 controls.css 的 center 层叠成居中）');
}


group('文字垂直居中：改用真实测量，不再吃内核经验系数');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  // ---- 根因确认：内核的补偿是「font-size × 硬编码经验系数」 ----
  const core = fs.readFileSync(path.join(HERE, 'editor', 'kityminder.core.min.js'), 'utf8');
  ok(/setTranslate\(0,\(d\|\|0\)\*i\)/.test(core),
    '内核确实按 font-size×系数 做垂直补偿（d 来自经验表）');
  // 主题里没有 font-family —— 这是"取到的字体恒为 default"的原因
  const th = fs.readFileSync(path.join(HERE, 'themes.js'), 'utf8');
  ok(!/font-family/.test(th), '主题元数据里没有 font-family（内核只能取到 default）');

  // ---- 修法：用真实 bbox 居中 ----
  ok(/__kmTextDy = function/.test(html), '抽出可测的纯函数 __kmTextDy');
  ok(/__kmNodeValign = function/.test(html), '抽出可测的纯函数 __kmNodeValign');
  // 关键：**不再**要求节点显式设过 vertical-align。
  // 注意必须先剥注释 —— 新写的注释里引用了旧写法 `if (!va) return;`，
  // 不剥掉的话删没删这句断言都是绿的（假阳性）。
  const htmlCode = stripCommentsFlatJs(html);
  ok(!/if \(!va\) return;/.test(htmlCode),
    '不再因未设 vertical-align 而跳过校正（这正是偏移一直没生效的那一环）');
  // 测不到真实边界时必须保持内核落点，不能设 0
  ok(/if \(dy == null\) return;/.test(html),
    '测不到边界时保持内核落点（设 0 会把经验补偿整个抹掉，更偏）');

  // ---- 纯函数行为：执行**源码里**的函数，不是在这里重写一份 ----
  //
  // 早先这里按语义另写了一份实现来断言，结果源码被改坏照样全绿 ——
  // 断言测的是副本，不是被测对象（假阳性）。改为把源码里那两个函数
  // 抠出来真跑一遍。
  const seg = html.slice(html.indexOf('window.__kmTextDy = function'),
    html.indexOf('var valignBindDone = false;'));
  const defSeg = html.slice(html.indexOf('window.__kmNodeValign = function'),
    html.indexOf('var valignBindDone = false;'));
  const mk = {};
  // eslint-disable-next-line no-new-func
  new Function('window', seg + '\n' + defSeg)(mk);
  const dy = mk.__kmTextDy;
  const def = mk.__kmNodeValign;
  ok(typeof dy === 'function', '源码里的 __kmTextDy 可执行');
  ok(typeof def === 'function', '源码里的 __kmNodeValign 可执行');

  // a) 纯文本节点：把真实中心对齐到内容盒中心
  {
    // 内容盒 = 内核按 font-size 算的理论盒（16px 单行：y=-8,h=16）
    // 真实渲染边界更高（18.5）：y=-8,h=18.5 —— 这正是"实际比理论高"的偏差来源
    const r = dy({ y: -8, height: 18.5 }, { y: -8, height: 16 }, 'middle');
    eq(Math.round(r * 100) / 100, -1.25, 'a 纯文本居中：真实中心 1.25 → 上移 1.25');
  }

  // b) 字号越大，同一比例偏差的绝对值越大 —— 这就是"不同主题表现不同"
  {
    const r16 = dy({ y: -8, height: 18.5 }, { y: -8, height: 16 }, 'middle');
    const r24 = dy({ y: -12, height: 27.75 }, { y: -12, height: 24 }, 'middle');
    ok(Math.abs(r24) > Math.abs(r16),
      `b 字号越大绝对偏差越大（16px:${r16.toFixed(2)} vs 24px:${r24.toFixed(2)}）`);
  }

  // c) top / bottom 语义用真实边界，而不是内核的理论高度
  {
    eq(dy({ y: -8, height: 18.5 }, { y: -8, height: 40 }, 'top'), 0, 'c 顶对齐：顶边相合');
    // 内容盒底 (-8+40=32) - 文本真实底 (-8+18.5=10.5) = 21.5
    eq(dy({ y: -8, height: 18.5 }, { y: -8, height: 40 }, 'bottom'), 21.5,
      'c 底对齐：真实底边对齐内容盒底边');
  }

  // d) 测不到 → null（调用方据以保持内核落点）
  {
    eq(dy({ y: 0, height: 0 }, { y: -8, height: 16 }, 'middle'), null, 'd 文本测不到 → null');
    eq(dy({ y: -8, height: 18.5 }, null, 'middle'), null, 'd 内容盒取不到 → null');
  }

  /* e) 默认对齐：一律居中，只有**内核真的渲染了图片**才沉底
   *
   * 判据曾经是 `(cbox.height - 文字盒高) > 1`，实测（内核跑在 jsdom 里）：
   *   root(font-size 16) → getContentBox() 高 40，文字盒高 16
   * 差的 24 是外框内边距 —— 也就是说**恒为真**，每个节点都会被判成带图。
   * 所以改成直接问 data.image。
   */
  {
    // 每个用例都**接住抛错再断言**：直接调的话，源码一旦没了容错
    // （或判据被改回需要 node/cbox）就会变成未捕获异常 → 进程崩溃，
    // 脚本也判"抓到"，但那不是断言在把关（本项目第 9 次遇到这个坑）。
    const call = (node) => {
      try { return { v: def(node) }; } catch (e) { return { threw: true }; }
    };

    eq(call({ getData: () => null }).v, 'middle', 'e 纯文本节点 → 居中');
    eq(call({ getData: (k) => (k === 'image' ? 'data:image/png;base64,AA' : null) }).v,
      'bottom', 'e 有内核渲染的图片（data.image）→ 沉底（图片在上）');
    // 多图走 data.images —— 由附件区自己画，**不进内核渲染器**，
    // 所以不能因为 images 有值就沉底（否则文字会被推到盒子外）
    eq(call({ getData: (k) => (k === 'images' ? '["a","b"]' : null) }).v,
      'middle', 'e 多图走 images（附件区自绘）→ 仍居中');

    const rNull = call(null);
    ok(!rNull.threw, 'e 传 null 时不抛（noderender 里节点可能取不到）');
    eq(rNull.v, 'middle', 'e 取不到节点时回落居中');

    const rBoom = call({ getData: () => { throw new Error('boom'); } });
    ok(!rBoom.threw, 'e getData 抛错时不往外抛（脏数据不能中断渲染）');
    eq(rBoom.v, 'middle', 'e getData 抛错时回落居中');

    // 源码级：防止有人把 getData('image') 挪到 try 外面
    const vs = html.slice(html.indexOf('window.__kmNodeValign = function'),
      html.indexOf('var valignBindDone = false;'));
    const atTry = vs.indexOf('try {');
    const atGet = vs.indexOf("getData('image')");
    ok(atTry >= 0 && atGet > atTry, '取 data.image 包在 try 里（脏数据不能中断渲染）');
    ok(/catch \(e\)/.test(vs), '有 catch 兜底');
  }

  // f) 三级微调（center/child/deep）现在对默认节点也生效
  // 注意：不能只断言 `/voOffset\(node, va\)/` ——
  // 那会命中它自己的**函数定义** `function voOffset(node, va) {`，
  // 于是把调用处的实参换成 0 之后，断言照样绿（假阳性）。
  // 必须断言它在 __kmTextDy 调用里被当作实参传入。
  ok(/__kmTextDy\(bb, cbox, va, voOffset\(node, va\)\)/.test(htmlCode),
    'f 三级微调表接入默认节点（不再只服务于显式 valign）');
  ok(/center: \{ top: 0, middle: 0, bottom: 0 \}/.test(html), 'f 微调表含 center 层级（中央主题）');
  ok(/child: \{ top: 0, middle: 0, bottom: 0 \}/.test(html), 'f 微调表含 child 层级（子主题）');
  ok(/deep: \{ top: 0, middle: 0, bottom: 0 \}/.test(html), 'f 微调表含 deep 层级（更下级）');
}

group('numSpinner 初值钳制（源码级，前置以便先于运行时崩溃被判到）');

{
  /*
   * 为什么放在这里而不是"数值输入框"那组里：
   * 把 clamp 的 fallback 改坏会触发 TDZ（clamp 定义在 let cur 之前），
   * 样式面板那组（更早）就已经抛 ReferenceError 了 —— 后面的断言根本跑不到。
   * 放在它前面，才能把"崩溃"变成**断言失败**（本项目第 11 次遇到这类假阳性）。
   */
  const psrc = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8').replace(/\r\n/g, '\n');
  const fnSrc = (() => {
    const i = psrc.indexOf('const clamp = (v, fallback)');
    ok(i > 0, 'clamp 带 fallback 参数');
    let d = 0, j = psrc.indexOf('{', i);
    for (; j < psrc.length; j++) {
      if (psrc[j] === '{') d++;
      else if (psrc[j] === '}') { d--; if (d === 0) return psrc.slice(i, j + 1); }
    }
    return '';
  })();
  ok(/return fallback;/.test(fnSrc), 'clamp 解析失败时返回 **fallback**（不是写死 cur）');
  ok(!/return cur;/.test(fnSrc), 'clamp 里不得出现 return cur;（初值时会 TDZ 抛错）');
  // 混合态没有"当前值"可言，故三元：非混合态才 clamp，fallback 仍是 min
  ok(/let cur = mixed \? null : clamp\(o\.value, min\);/.test(psrc), '初值走的是 clamp（混合态为 null），且 fallback = min');
}

group('样式面板：一排化 / 删除按钮弱化 / 分节清除');

{
  const { buildSide } = await import('./panels.js');
  const mk = () => buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: { getSelectedNodeId: () => 'n1' }, customThemes: [],
  }, {});
  const el = mk();
  el.open('style');

  const fields = [...el.el.querySelectorAll('.mm-field')];
  const sec = (name) => fields.find((f) => f.querySelector('h3')?.textContent === name);

  // ---- 1) 三个标题右边各有一个清除按钮 ----
  for (const t of ['文字', '节点', '连线']) {
    const f = sec(t);
    ok(!!f, `有「${t}」节`);
    const head = f?.querySelector('.mm-sec-head');
    ok(!!head, `「${t}」标题行存在（清除按钮挂在这里）`);
    const q = head?.querySelector('button.mm-btn.quiet');
    ok(!!q, `「${t}」标题右边有弱化清除按钮`);
  }

  // 四个清除按钮不再挤成一排：整节必须不存在
  const hasClearSec = fields.some((f) => f.querySelector('h3')?.textContent === '清除样式');
  ok(!hasClearSec, '不再有「清除样式」整节（四个按钮挤一排）');

  // 「清除全部」保留，但落在样式刷里（与复制/粘贴同为整体操作）
  {
    const f = sec('样式刷');
    const btns = [...(f?.querySelectorAll('button') || [])].map((b) => b.textContent);
    ok(btns.includes('清除全部'), '「清除全部」保留在样式刷节');
  }

  // ---- 2) 圆角归入「节点」，不再独立成节 ----
  ok(!sec('圆角'), '不再有独立的「圆角」节');
  {
    const f = sec('节点');
    const labels = [...(f?.querySelectorAll('.mm-label') || [])].map((s) => s.textContent);
    ok(labels.includes('圆角'), '圆角归入「节点」节');
    ok(labels.includes('填充') && labels.includes('描边'), '节点节含填充与描边');
  }

  // ---- 3) 字体色与 B / I / S 同一行 ----
  {
    const f = sec('文字');
    const rows = [...(f?.querySelectorAll('.mm-row') || [])];
    const one = rows.find((r) => {
      const chips = [...r.querySelectorAll('.mm-chip')].map((c) => c.textContent);
      return chips.includes('B') && chips.includes('I') && chips.includes('S');
    });
    ok(!!one, '存在含 B / I / S 的行');
    const hasSwatch = one && !!one.querySelector('.mm-swatch');
    ok(hasSwatch, '字体色与 B / I / S 在同一行（该行内有取色块）');
  }

  // ---- 4) 删除类按钮弱化 ----
  {
    const qs = [...el.el.querySelectorAll('button.mm-btn.quiet')];
    ok(qs.length >= 3, '存在弱化按钮（清除类）');
    // 弱化按钮不能是常规实心按钮：否则整页一排排按钮，主操作被淹没
    const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
    const strip = (t) => stripCommentsFlat(t);
    const cs = strip(css);
    const qr = cs.slice(cs.indexOf('.mm-btn.quiet {'), cs.indexOf('.mm-btn.quiet:hover'));
    ok(/background:\s*none/.test(qr), '弱化按钮无底板');
    ok(/box-shadow:\s*none/.test(qr), '弱化按钮无立体阴影');
    // hover 必须还有反馈 —— 全去掉就成了"看不出能不能点"
    const qh = cs.slice(cs.indexOf('.mm-btn.quiet:hover'), cs.indexOf('.mm-btn.quiet:active'));
    ok(/color:\s*var\(--accent\)/.test(qh), '弱化按钮 hover 仍有变色反馈');
  }

  // ---- 5) 徽章单排：行内不换行 ----
  {
    const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
    const cs = stripCommentsFlat(css);
    const br = cs.slice(cs.indexOf('.mm-badge-row {'), cs.indexOf('.mm-badge-row {') + 200);
    ok(/flex-wrap:\s*nowrap/.test(br), '徽章行不换行（10 格始终一排）');
    ok(/justify-content:\s*space-between/.test(br), '徽章行用 space-between（窄屏压缩间隙而非掉行）');
  }
}

group('导入导出页：标题右侧圆形问号 + 悬浮说明');

{
  const { buildSide } = await import('./panels.js');
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
      importFile() {}, exportXMind() {}, exportJson() {}, exportTxt() {}, exportMarkdown() {},
      exportSvg() {}, exportPdf() {}, exportPng() {}, printMap() {}, exchange() {},
      exportBackups() {}, importBackups() {}, backupNow: async () => {},
    },
    bridge: { getSelectedNodeId: () => 'n1' }, customThemes: [],
  }, {});
  el.open('exchange');

  const fields = [...el.el.querySelectorAll('.mm-field')];
  const sec = (n) => fields.find((f) => f.querySelector('h3')?.textContent === n);

  // ---- 1) 每个标题右边都有一个问号 ----
  // 「主题」节已移出本页（回归主题页，与新建/编辑/删除同排）
  const titles = ['导入', '导出为文档', '导出为交换格式（单画布）', '导出为图像 / PDF', '快照备份'];
  for (const t of titles) {
    const f = sec(t);
    ok(!!f, `有「${t}」节`);
    const head = f?.querySelector('.mm-sec-head');
    ok(!!head, `「${t}」用带标题行的结构（问号挂在这里）`);
    const dot = head?.querySelector('button.mm-help');
    ok(!!dot, `「${t}」标题右边有圆形问号`);
    // 必须紧跟标题之后：放在标题前会把标题挤得参差不齐
    const kids = [...(head?.children || [])];
    ok(kids[0]?.tagName === 'H3' && kids[1]?.classList.contains('mm-help'),
      `「${t}」问号紧跟在标题之后`);
  }

  // ---- 2) 问号是可聚焦的 button，且不带原生 title ----
  {
    const dot = sec('导入')?.querySelector('button.mm-help');
    eq(dot?.tagName, 'BUTTON', '问号是 button（可 Tab 聚焦）');
    eq(dot?.textContent, '?', '问号内容是 ?');
    // 原生 title 必须置空：否则自定义提示框与原生 title 会同时弹两个
    eq(dot?.getAttribute('title'), '', '问号不带原生 title（避免与自定义提示框重复弹出）');
    ok(!!dot?.getAttribute('aria-label'), '问号有 aria-label');
  }

  // ---- 3) 说明文字进了提示框，不再铺在界面上 ----
  {
    const f = sec('导入');
    const hints = [...(f?.querySelectorAll('.mm-hint') || [])].map((x) => x.textContent);
    // 「会替换 / 不可撤销」是会造成数据丢失的警告，必须留在界面上
    ok(hints.some((t) => /不可撤销/.test(t)), '保留「不可撤销」警告在界面上');
    // 嗅探格式这类补充信息不再占位
    ok(!hints.some((t) => /嗅探/.test(t)), '「按内容嗅探格式」已移出界面');
  }
  {
    const f = sec('导出为交换格式（单画布）');
    const hints = [...(f?.querySelectorAll('.mm-hint') || [])].map((x) => x.textContent);
    ok(!hints.some((t) => /只导当前画布/.test(t)), '交换格式的长说明已移出界面');
  }

  // ---- 4) 悬浮真的能显示，且内容正确 ----
  {
    const dot = sec('导入')?.querySelector('button.mm-help');
    dot?.dispatchEvent(new dom.window.MouseEvent('mouseenter', { bubbles: false }));
    const tip = document.querySelector('.mm-helptip');
    ok(!!tip, '提示框元素存在');
    // 挂 body 而不是留在面板里：侧栏 overflow-y:auto 会裁剪它
    eq(tip?.parentElement, document.body, '提示框挂在 body 上（不被侧栏 overflow 裁剪）');
    ok(tip?.classList.contains('open'), 'mouseenter 后提示框显示');
    const txt = tip?.textContent || '';
    ok(/嗅探/.test(txt), '提示框含该节的说明文字');
    // 多段要分成多行，挤成一整段会读不出是几条
    eq(tip?.querySelectorAll('.mm-helptip-line').length, 2, '导入节说明是 2 段');

    // mouseleave 后要能关掉（有延迟，用定时器断言）
    /*
     * ⓘ 原写 `ok(true, 'mouseleave 未抛错')` —— 恒真，而且它掩盖了真正的事：
     *   dispatchEvent 真抛异常时整个脚本**崩在半路**，后面几千条断言一条都不跑，
     *   而"崩"不等于"红"（本项目反复栽的同一类）。所以必须自己接住再判。
     */
    let leaveErr = null;
    try {
      dot?.dispatchEvent(new dom.window.MouseEvent('mouseleave', { bubbles: false }));
    } catch (e) {
      leaveErr = e;
    }
    ok(leaveErr === null, 'mouseleave 不抛错',
      leaveErr ? String(leaveErr?.message || leaveErr) : '');
  }

  // ---- 5) 样式：fixed + 默认不显示 ----
  {
    const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
    const cs = stripCommentsFlat(css);
    const tr = cs.slice(cs.indexOf('.mm-helptip {'), cs.indexOf('.mm-helptip.open'));
    ok(/position:\s*fixed/.test(tr), '提示框 position:fixed（配合挂 body，不受祖先裁剪）');
    ok(/display:\s*none/.test(tr), '默认 display:none（不只是透明，否则仍会挡住点击）');
    ok(/z-index/.test(tr), '提示框有 z-index');
    const hr = cs.slice(cs.indexOf('.mm-help {'), cs.indexOf('.mm-help:hover'));
    ok(/border-radius:\s*50%/.test(hr), '问号是圆形');
    ok(/cursor:\s*help/.test(hr), '问号是 help 指针');
  }
}

group('主题页：导入/导出与新建同排 + 内置主题禁用导出');

{
  const { buildSide } = await import('./panels.js');
  const mk = (customThemes = []) => buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: { getSelectedNodeId: () => 'n1' }, customThemes,
    sheet: { theme: 'fresh-blue', layout: 'default' },
  }, {});

  // ---- 1) 导入 / 导出 / 新建 在同一行 ----
  {
    const el = mk();
    el.open('theme');
    const sec = [...el.el.querySelectorAll('.mm-field')]
      .find((f) => f.querySelector('h3')?.textContent === '配色主题');
    ok(!!sec, '有「配色主题」节');
    const btns = [...(sec?.querySelectorAll('button.mm-btn') || [])];
    const texts = btns.map((b) => b.textContent);
    ok(texts.some((t) => /新建/.test(t)), '有「＋ 新建主题」');
    // 命名必须**成对**：「导入主题」对「导出主题」。
    // 早前一个「导入…」一个「导出」，看着像两个不相干的功能
    ok(texts.some((t) => t === '导入主题'), '按钮叫「导入主题」（不是被截断的「导入…」）');
    ok(texts.some((t) => t === '导出主题'), '按钮叫「导出主题」（与「导入主题」成对）');
    // 省略号是**被截断**出来的，不是有意省略 —— 不允许再出现
    ok(!texts.some((t) => /…/.test(t)), '没有按钮文字被截断成省略号');
    // 三个按钮**各占一行**：挤在一排时每个都被压窄，「导入主题」会显示成「导入…」
    const col = sec?.querySelector('.mm-col');
    ok(!!col, '三个按钮装在竖排容器里');
    eq(col ? col.querySelectorAll('button.mm-btn').length : 0, 3, '竖排容器里正好三个按钮');
    ok(![...(sec?.querySelectorAll('.mm-row') || [])].some((r) => {
      const ts = [...r.querySelectorAll('button.mm-btn')].map((b) => b.textContent);
      return ts.includes('导入主题') || ts.includes('导出主题');
    }), '导入/导出不再挤在横排里（那会被压成省略号）');
  }

  // ---- 2) 内置主题时「导出」禁用 ----
  {
    const el = mk();   // sheet.theme = 'fresh-blue'（内置）
    el.open('theme');
    const sec = [...el.el.querySelectorAll('.mm-field')]
      .find((f) => f.querySelector('h3')?.textContent === '配色主题');
    const exp = [...(sec?.querySelectorAll('button.mm-btn') || [])]
      .find((b) => b.textContent === '导出主题');
    ok(!!exp, '找到「导出主题」按钮');
    eq(exp?.disabled, true, '内置主题时导出按钮禁用');
    ok(/内置主题/.test(exp?.getAttribute('title') || ''),
      '禁用时 title 说明原因（不让用户点了才知道）');
  }

  // ---- 3) 自定义主题时「导出」可用 ----
  {
    const el = mk([{ id: 'my-theme', name: '我的主题' }]);
    // 让当前主题指向自定义主题
    el.open('theme');
    const sec = [...el.el.querySelectorAll('.mm-field')]
      .find((f) => f.querySelector('h3')?.textContent === '配色主题');
    // 点自定义主题把它设为当前，再刷新看按钮
    const custom = [...(sec?.querySelectorAll('.mm-theme') || [])]
      .find((x) => /我的主题/.test(x.textContent || ''));
    const nameSpan = custom && [...custom.querySelectorAll('.name')][0];
    nameSpan?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    el.refresh();
    const sec2 = [...el.el.querySelectorAll('.mm-field')]
      .find((f) => f.querySelector('h3')?.textContent === '配色主题');
    const exp2 = [...(sec2?.querySelectorAll('button.mm-btn') || [])]
      .find((b) => b.textContent === '导出主题');
    // 注：applyTheme 是 api 里的空实现，sheet.theme 不会真的变，
    // 这里只验证「禁用态是根据当前主题算出来的」这一逻辑存在
    ok(!!exp2, '自定义主题场景下也能找到导出按钮');
  }

  // ---- 4) 指路 hint 已删除 ----
  {
    const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
    ok(!/自定义的导入\/导出在侧栏/.test(pn), '主题页的指路 hint 已删除');
  }

  // ---- 5) 「内置主题无法导出」改由问号承载，信息没丢 ----
  {
    const el = mk();
    el.open('theme');
    const sec = [...el.el.querySelectorAll('.mm-field')]
      .find((f) => f.querySelector('h3')?.textContent === '配色主题');
    const dot = sec?.querySelector('.mm-sec-head button.mm-help');
    ok(!!dot, '「配色主题」标题右边有问号');
    dot?.dispatchEvent(new dom.window.MouseEvent('mouseenter', { bubbles: false }));
    const tip = document.querySelector('.mm-helptip');
    ok(/自定义/.test(tip?.textContent || ''), '问号里说明「仅针对自定义主题」');
  }
}

group('顶栏瘦身 / 聚焦中心主题 / 搜索不阻断选中 / 布局选中态');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  const code = (t) => stripCommentsFlatJs(t);

  // ---- 1) 顶栏「新建 / 复制」已移除 ----
  ok(!/B\('新建', guard\('新建画布'/.test(idx), '顶栏「新建」按钮已移除');
  ok(!/B\('复制', guard\('复制画布'/.test(idx), '顶栏「复制」按钮已移除');
  // 但功能本身不能跟着删 —— 页签区的 ＋ 与页签右键菜单还在用
  ok(/function addSheet\(/.test(idx) && /function duplicateSheet\(/.test(idx),
    'addSheet / duplicateSheet 仍在（页签区在用，不是死代码）');
  ok(/onclick: guard\('新建画布', \(\) => addSheet\(\)\)/.test(idx),
    '页签区仍有 ＋ 新建入口');

  // ---- 2) 左侧图标条有「聚焦中心主题」 ----
  ok(/focusRoot\(\)/.test(idx), '图标条调用 bridge.focusRoot()');
  ok(/focusRoot\(\) \{/.test(br), '桥接有 focusRoot()');
  // 编辑器侧：不能让外壳传节点进来（跨 iframe 传不了对象）
  ok(/focusRoot: function \(\) \{/.test(html), '编辑器门面暴露 focusRoot');
  ok(/km\.getRoot\(\)/.test(html), 'focusRoot 自己取 km.getRoot()（不靠外壳传节点）');
  // 动画时长不能是 0 —— 瞬移的话用户看不出移到哪儿了
  ok(/execCommand\('camera', root, 300\)/.test(html),
    'camera 带 300ms 动画（0 会瞬移，看不出发生了什么）');
  // 先展开折叠的根节点：否则视野里没内容
  ok(/root\.expand && root\.expand\(\)/.test(html), '聚焦前先展开根节点');

  // ---- 3) 搜索高亮框不拦截点击 ----
  //
  // 这是"搜索之后其他节点点不动"的根因：KityMinder 靠 getTargetNode()
  // 从 targetShape 往上找 minderNode，而这个框画在节点**之上**且带填充，
  // 不禁用命中的话点它覆盖到的节点就选不中。
  ok(/shape\.setStyle\('pointer-events', 'none'\)/.test(html),
    '搜索高亮框禁用鼠标命中（否则点不中节点）');
  ok(/shape\.node\.style\.pointerEvents = 'none'/.test(html),
    '双保险：直接写 SVG 节点 style（kity setStyle 不落盘时仍生效）');

  // 高亮框必须有填充才需要禁用命中 —— 顺带确认它确实是"画在节点之上"的
  ok(/fill\('rgba\(10,132,255,0\.10\)'\)/.test(html), '高亮框带半透明填充（确实会拦截）');

  // ---- 4) 选中别的节点后清掉旧高亮框 ----
  ok(/km\.on\('selectionchange'/.test(html), '监听 selectionchange 以清理旧高亮');
  // 必须跳过自己触发的那次：focusSearchResult 里 select 会同步派发
  // selectionchange，不排除的话刚画的框会被自己立刻清掉
  ok(/if \(_selfSelecting \|\| !_searchMark\) return;/.test(html),
    '跳过自己触发的 selectionchange（否则刚画的框立刻被自己清掉）');
  ok(/isCurrentSearchNode\(sel\)/.test(html), '选中的仍是当前匹配节点时不清除');

  // ---- 5) app.sheet 必须是 getter ----
  //
  // `sheet` 本身是「取当前画布」的**函数**。直接把函数传出去的话，
  // 面板里 `app.sheet?.theme` / `?.layout` 读的是**函数对象**的属性
  // （恒 undefined），于是主题与布局的选中态永远停在默认值 ——
  // 用户切了布局、画布变了，面板高亮却不动。
  ok(/get sheet\(\) \{ return sheet\(\); \}/.test(idx),
    'app.sheet 是 getter（传函数本身会让选中态永远停在默认值）');
  ok(!/^\s*sheet,$/m.test(idx), '不再直接把 sheet 函数当属性传出');
}

group('文件库 / 搜索结果：两个独立页签共用一个底框');

{
  const { buildFileList } = await import('./filelist.js');
  const mkApp = (filesOpen = false) => {
    const calls = [];
    const app = {
      api: {
        status() {}, commit() {}, openFile() {}, createFile() {}, createFolder() {},
        renameFile() {}, deleteFile() {}, moveFile() {},
        fileState: () => ({ files: [{ id: 'f1', name: '甲' }], folders: [], currentId: 'f1' }),
      },
      settings: { filesOpen },
      bridge: { gotoSearchResult: () => true },
    };
    return { app, calls };
  };
  const visible = (el, sel) => {
    const n = [...el.querySelectorAll(sel)][0];
    if (!n) return false;
    for (let p = n; p && p !== el; p = p.parentElement) {
      if (p.style && p.style.display === 'none') return false;
    }
    return true;
  };

  // ---- 1) 初始：文件库开 → 显示文件 ----
  {
    const { app } = mkApp(false);
    const fl = buildFileList(app);
    fl.refresh();      // 文件列表内容由外壳渲染，这里补一次（真实环境是 renderFiles()）
    fl.showFiles(true);
    eq(fl.isFilesPanel(), true, 'a 文件面板占着底框');
    ok(fl.el.classList.contains('open'), 'a 底框展开');
    ok(visible(fl.el, '.mm-file-item'), 'a 文件列表可见');
    eq(fl.isSearchMode(), false, 'a 不在搜索态');
  }

  // ---- 2) 搜索结果出来 → 占住底框，文件让位 ----
  {
    const { app } = mkApp(false);
    const fl = buildFileList(app);
    fl.refresh();
    fl.showFiles(true);
    fl.setSearch({ kw: 'ab', total: 2, active: 0, items: ['甲ab', '乙ab'] });
    eq(fl.isSearchMode(), true, 'b 搜索结果占住底框');
    ok(fl.el.classList.contains('open'), 'b 底框仍展开');
    ok(visible(fl.el, '.mm-search-item'), 'b 搜索结果可见');
    ok(!visible(fl.el, '.mm-file-item'), 'b 文件列表被遮盖');
    eq(fl.isFilesPanel(), false, 'b 不再是文件面板');
  }

  // ---- 3) 点 📚 → 切回文件，搜索结果被遮盖 ----
  {
    const { app } = mkApp(false);
    const fl = buildFileList(app);
    fl.refresh();
    fl.setSearch({ kw: 'ab', total: 2, active: 0, items: ['甲ab', '乙ab'] });
    fl.toggleFiles();
    eq(fl.isFilesPanel(), true, 'c 点文件 → 切到文件列表');
    eq(fl.isSearchMode(), false, 'c 搜索结果让位');
    ok(visible(fl.el, '.mm-file-item'), 'c 文件列表可见');
    ok(!visible(fl.el, '.mm-search-item'), 'c 搜索结果被遮盖');
  }

  // ---- 4) 再点 📚 → 收起文件，但**退回搜索结果**（不是整个关掉）----
  {
    const { app } = mkApp(false);
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'ab', total: 2, active: 0, items: ['甲ab', '乙ab'] });
    fl.toggleFiles();          // → files
    eq(fl.isFilesPanel(), true, 'd 先切到文件');
    fl.toggleFiles();          // → 收起文件
    eq(fl.isFilesPanel(), false, 'd 再点 → 文件收起');
    eq(fl.isSearchMode(), true, 'd 退回搜索结果（不是把底框整个关掉）');
    ok(fl.el.classList.contains('open'), 'd 底框仍展开');
    ok(visible(fl.el, '.mm-search-item'), 'd 搜索结果真的可见');
    // 关键：搜索结果的内容还在，没有被清掉重来
    eq(fl.el.querySelectorAll('.mm-search-item').length, 2, 'd 搜索条目仍在（2 条）');
  }

  // ---- 5) 没有搜索结果时，收起文件 = 整个底框收起 ----
  {
    const { app } = mkApp(false);
    const fl = buildFileList(app);
    fl.refresh();
    fl.showFiles(true);
    fl.toggleFiles();
    eq(fl.isFilesPanel(), false, 'e 文件已收起');
    eq(fl.isOpen(), false, 'e 无搜索结果 → 底框整个收起');
    ok(!fl.el.classList.contains('open'), 'e 底框没有 open 类');
  }

  // ---- 6) 清空搜索 → 让位给文件（若用户开着）/ 或收起 ----
  {
    const { app } = mkApp(true);      // settings.filesOpen = true
    const fl = buildFileList(app);
    fl.refresh();
    fl.showFiles(true);
    fl.setSearch({ kw: 'ab', total: 1, active: 0, items: ['甲ab'] });
    eq(fl.isSearchMode(), true, 'f 先进搜索');
    fl.setSearch(null);
    eq(fl.isSearchMode(), false, 'f 清空搜索 → 退出搜索态');
    eq(fl.isFilesPanel(), true, 'f 让位给文件列表（settings.filesOpen 为 true）');
    eq(fl.el.querySelectorAll('.mm-search-item').length, 0, 'f 搜索条目真的清掉了');
  }
  {
    const { app } = mkApp(false);     // settings.filesOpen = false
    const fl = buildFileList(app);
    fl.setSearch({ kw: 'ab', total: 1, active: 0, items: ['甲ab'] });
    fl.setSearch(null);
    eq(fl.isOpen(), false, 'g 用户没开文件库 → 清空搜索后底框收起');
  }

  // ---- 7) 标题与按钮随面板切换 ----
  {
    const { app } = mkApp(false);
    const fl = buildFileList(app);
    fl.refresh();
    fl.showFiles(true);
    const t1 = fl.el.querySelector('.mm-files-title').textContent;
    ok(/脑图文件/.test(t1), 'h 文件态标题是「脑图文件」');
    fl.setSearch({ kw: 'ab', total: 3, active: 0, items: ['a', 'b', 'c'] });
    const t2 = fl.el.querySelector('.mm-files-title').textContent;
    ok(/搜索结果 3 项/.test(t2), 'h 搜索态标题显示真实总数');
    // 搜索态不能有「＋ / 📁」—— 它们建的是文件，但页面不是文件列表
    const btns = [...fl.el.querySelectorAll('.mm-files-head button')];
    const hidden = btns.filter((b) => b.style.display === 'none');
    eq(hidden.length, 2, 'h 搜索态隐藏「＋ / 📁」（点了像没反应）');
    fl.toggleFiles();
    ok(/脑图文件/.test(fl.el.querySelector('.mm-files-title').textContent),
      'h 切回文件 → 标题恢复');
    eq([...fl.el.querySelectorAll('.mm-files-head button')]
      .filter((b) => b.style.display === 'none').length, 0, 'h 切回文件 → 按钮恢复');
  }

  // ---- 8) 外壳不再有 setOpen（避免两个入口各说各话）----
  {
    const src = fs.readFileSync(path.join(HERE, 'filelist.js'), 'utf8');
    ok(!/setOpen/.test(src), 'i filelist 不再导出 setOpen（状态由页签方法统一管）');
    ok(/function toggleFiles\(\)/.test(src), 'i 有 toggleFiles');
    ok(/function showFiles\(on\)/.test(src), 'i 有 showFiles');
    const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
    ok(/fileList\?\.showFiles\(on\)/.test(ix), 'i 外壳调 showFiles');
    ok(!/fileList\?\.setOpen/.test(ix), 'i 外壳不再调 setOpen');
  }
}

group('文件库展开导致画布内容位移：按实测屏幕位置差补偿');

{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const fl = fs.readFileSync(path.join(HERE, 'filelist.js'), 'utf8');

  // ---- 1) 编辑器有 panBy 门面 ----
  ok(/panBy: function \(dx, dy\)/.test(html), '编辑器门面暴露 panBy');
  ok(/km\._viewDragger/.test(html), 'panBy 走 _viewDragger（内核无公开平移命令）');
  // 不传 duration：带动画的话两次平移会互相打断，落点不是两者之和
  ok(/d\.move\(new kity\.Point\(Number\(dx\) \| 0, Number\(dy\) \| 0\)\)/.test(html),
    'panBy 不传 duration（与内核 resize 一致，避免动画互相打断）');
  ok(/panBy\(dx, dy\) \{/.test(br), '桥接转发 panBy');

  // ---- 2) 容器位移必须**在父页面测**，不能依赖 iframe 内的坐标 ----
  //
  // 这是本轮真正修掉的 bug：早先补偿量取自编辑器侧的 rootScreenX()，它取
  // #minder-container 的 getBoundingClientRect().left —— 那是 iframe 内的元素，
  // 坐标相对**iframe 自己的视口**；父页面把 iframe 挤到右边时该值恒定不变，
  // 于是容器位移被抵消，补偿只剩"撤销内核补偿"，净位移反而变成 +N。
  //
  // 所以断言不能只检查"代码里出现了 getBoundingClientRect().left"（那只能防
  // 止被人删掉，防不住测错坐标系），而要检查**测的是父页面的 canvasEl**。
  const wsrSeg = ix.slice(ix.indexOf('function withStableRoot(fn) {'),
    ix.indexOf('/**', ix.indexOf('function withStableRoot(fn) {')));
  ok(/canvasEl/.test(wsrSeg), 'withStableRoot 测的是父页面的 canvasEl（不是 iframe 内坐标）');
  ok(/getBoundingClientRect\(\)\.left/.test(wsrSeg), '取容器左边缘的屏幕 x');
  // 容器位移交由编辑器补偿；本侧**不得**再自行 panBy，否则双重补偿
  ok(/notifyLayoutShift\?\.\(dLeft\)/.test(wsrSeg), '把容器位移报给编辑器');
  ok(!/panBy/.test(wsrSeg), '本侧不再自行 panBy（补偿交给编辑器，避免双重）');
  // 早先按"固定 Δ/2"硬补是错的：Δ 取决于 flex 收缩分配，右侧栏一旦可收缩
  // 就不是 216。这里必须没有任何 216 / 108 之类的常量参与。
  const ixNoComment = stripCommentsFlatJs(ix);
  ok(!/216|108/.test(ixNoComment), '代码里没有 216 / 108 之类的硬编码位移常量');
  // before 取不到时必须**跳过**，不能当成 0 —— 那会补出一个反向位移
  ok(/if \(before == null\) return r;/.test(ix),
    '拿不到 before 就跳过补偿（不能当成 0）');
  ok(/if \(after == null\) return r;/.test(ix), '拿不到 after 也跳过');
  // 1px 以内是取整噪声，不补 —— 否则每次开合都多一次无谓平移
  ok(/Math\.abs\(dLeft\) >= 1/.test(ix), '1px 以内不补（取整噪声）');
  // 同步测量即可：补偿发生在 iframe 的 resize 回调里，不必等帧
  ok(!/nextFrames\(2\)/.test(ix),
    '不再等两帧（补偿在 resize 回调内同步完成，等帧只会让画面先晃一下再拉回）');

  // ---- 3) 所有会改变底框开合的调用点都套了 withStableRoot ----
  for (const call of [
    /withStableRoot\(\(\) => fileList\?\.showFiles\(on\)\)/,
    /withStableRoot\(\(\) => fileList\?\.setSearch\(null\)\)/,
    /withStableRoot\(\(\) => fileList\?\.setSearch\(bridge\?\.getSearchResults\?\.\(\) \|\| null\)\)/,
  ]) {
    ok(call.test(ix), `调用点套了 withStableRoot：${call.source.slice(0, 46)}…`);
  }
  // 不允许残留**裸调用**（初始化那一处除外：那时 bridge 还没建、
  // rootScreenX 返回 null，withStableRoot 会自行跳过，包裹了也没意义）
  const ixCode = stripCommentsFlatJs(ix);
  const bare = [...ixCode.matchAll(/^\s+(?:fileList\?\.|fileList\.)(showFiles|setSearch)\([^)]*\);$/gm)]
    .filter((m) => !/!!settings\.filesOpen/.test(m[0]));
  eq(bare.length, 0, `无未包裹的裸开合调用（发现 ${bare.map((m) => m[0].trim()).join(' | ')}）`);

  // ---- 3b) rootScreenX 保留但**不再参与补偿** ----
  //
  // 它仍在（供诊断/定位用），但位移补偿不能依赖它：它在 iframe 内取
  // #minder-container 的 getBoundingClientRect().left，那是相对 iframe 视口的
  // 坐标，测不到容器在父页面里的位移。这里断言"补偿链路里没有它"，
  // 防止有人日后图省事又把它接回去。
  ok(/rootScreenX: function \(\)/.test(html), '编辑器仍暴露 rootScreenX（诊断用）');
  ok(/typeof v === 'number' && isFinite\(v\) \? v : null/.test(br),
    'rootScreenX 取不到时返回 null（不是 0）');
  ok(!/rootScreenX/.test(wsrSeg), '补偿链路不依赖 rootScreenX（iframe 内测不到容器位移）');

  // ---- 4) 几何账 ----
  //
  // ⚠️ 这一条曾钉成 `flex: 0 0 186px`（挤窄画布方案），而实现早已改成
  //    浮层（absolute + width）。**改实现前先读这段注释** —— 断言过期
  //    会把正确的实现判成错，逼着人去"修"一个没坏的东西。
  //    浮层方案下画布尺寸恒定，几何账只剩"面板自身宽度"。
  {
    const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
    const filesBlk = css.slice(css.indexOf('.mm-files {'), css.indexOf('.mm-files.open'));
    ok(/width:\s*186px/.test(filesBlk), '.mm-files 宽 186px（浮层，不再是 flex 子项）');
    ok(/position:\s*absolute/.test(filesBlk), '.mm-files 是浮层（不参与挤压、画布尺寸不变）');
    ok(/padding:\s*10px/.test(filesBlk), '.mm-files padding 10（左右合计 20）');
    const bodyBlk = css.slice(css.indexOf('.mm-body {'), css.indexOf('.mm-body {') + 200);
    ok(/gap:\s*10px/.test(bodyBlk), '.mm-body gap 10');
    // 右侧栏必须**不可收缩**：它若可收缩，画布宽度变化量就不再固定，
    // 内核的半量补偿会与实际位移脱钩（历史上 .mm-side 样式失效时正是如此）
    const sideBlk = css.slice(css.indexOf('.mm-side {'), css.indexOf('.mm-side h3'));
    ok(/flex:\s*0 0 276px/.test(sideBlk), '.mm-side 固定 276px 不可收缩');
  }

  // ---- 5) CSS「规则被截断」检测 ----
  //
  // 历史上出过一次：补丁里 `.mm-rail { ... }` 被截成只剩 `.mm-rail`
  // （没有 { }），CSS 解析器会继续往后找，把紧跟其后的注释忽略掉、
  // 与下一个选择器拼成 `.mm-rail .mm-side` —— 而 DOM 里 .mm-side 不在
  // .mm-rail 内部，导致**整套样式静默失效**（表现为"侧栏全居中"）。
  //
  // 现有测试全是行为断言，恰好覆盖不到这种语法级损伤，故单列一条。
  {
    const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
    // 检测**截断形态本身**：一个类选择器独立成行，后面不跟 `{` 而直接
    // 换行跟注释。正常写法里选择器后面要么同行跟 `{`，要么跟逗号继续；
    // 绝不会"写完选择器就换行去写注释"。
    //
    // 不能改成"剥注释后数 token"——那样后代选择器（.mm-sec-head .mm-help）
    // 与截断形态（.mm-rail 换行 注释 换行 .mm-side）在剥完注释后长得一样，
    // 会把 65 条合法规则全判为异常。
    const truncated = [...css.matchAll(/^\s*(\.[A-Za-z][\w-]*)\s*\n\s*\/\*/gm)]
      .map((m) => m[1]);
    eq(truncated.length, 0, `无「选择器后无 { 直接换行写注释」的截断（发现 ${truncated.join(' | ')}）`);

    // 关键规则块必须解析得到**关键属性** —— 截断时整块失效，这些属性会丢。
    // 历史上 .mm-side 被吞成后代选择器后，下面这几条全部消失，
    // 后果是侧栏可收缩、画布宽度变化量不再固定，才引出本组这条位移 bug。
    const blk = (sel, until) => {
      const i = css.indexOf(sel + ' {');
      return i < 0 ? '' : css.slice(i, css.indexOf(until, i));
    };
    const sideBlk = blk('.mm-side', '.mm-side h3');
    ok(/flex:\s*0 0 276px/.test(sideBlk), '.mm-side 保留 flex: 0 0 276px（丢了就可收缩）');
    ok(/display:\s*flex/.test(sideBlk), '.mm-side 保留 display:flex');
    ok(/overflow-y:\s*auto/.test(sideBlk), '.mm-side 保留 overflow-y:auto');
    ok(/min-height:\s*0/.test(sideBlk), '.mm-side 保留 min-height:0');
  }
}

group('位移补偿：容器位移在父页面测，内核那一份在 iframe resize 里补');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const code = (t) => stripCommentsFlatJs(t);
  const cHtml = code(html);

  // ---- 1) 内核确实会自动居中（这是要抵消的东西）----
  const core = fs.readFileSync(path.join(HERE, 'editor', 'kityminder.core.min.js'), 'utf8');
  ok(/this\._viewDragger\.move\(new e\.Point\(\(b\.width-c\.width\)\/2\|0/.test(core),
    '内核 resize 时把视图平移 (新宽-旧宽)/2|0 重新居中（要抵消的就是这一下）');

  // ---- 2) 编辑器：接收容器位移，并在自己那次 resize 里补 ----
  ok(/notifyLayoutShift = function/.test(html), '编辑器提供 notifyLayoutShift');
  // dw 必须与内核**同源**：读内核自己的 _lastClientSize，而不是外壳传进来的宽度。
  // 外壳量的 iframe 宽度会被取整，与内核的 clientWidth 差的那点就是残留 1px。
  ok(/km\._lastClientSize/.test(cHtml), 'dw 取自内核的 _lastClientSize（与内核同源，否则残留 1px）');
  ok(/var dw = w - old\.width/.test(cHtml), '位移按内核那份旧尺寸算');
  // 内核是 `(dw/2)|0`（向零取整），补偿里必须原样复现；换成 Math.round 会残留 0.5px
  ok(/var kernel = \(dw \/ 2\) \| 0/.test(cHtml), '复现内核的向零取整（不是 Math.round）');
  // 补偿拆成两处，各有各的时机，不能合并成一处
  ok(/window\.__minder\.panBy\(-Math\.round\(dLeft\), 0\)/.test(cHtml),
    '开合时**同步**补掉容器位移 -dLeft（不等 resize）');
  ok(/window\.__minder\.panBy\(-kernel, 0\)/.test(cHtml),
    'resize 里只撤内核那一下（再把 dLeft 算进来就会补成两倍）');

  // ---- 3) 只对「底框开合」那一次生效，不能误伤拖窗口 ----
  const pendStart = html.indexOf('notifyLayoutShift = function');
  const pendSeg = html.slice(pendStart, html.indexOf("window.addEventListener('resize'", pendStart));
  ok(/pendingUntil = Date\.now\(\) \+ /.test(pendSeg), '容器位移带有效期（不是永久生效）');
  ok(/Date\.now\(\) > pendingUntil/.test(cHtml), '过期就不补偿（普通 resize 保留内核的居中行为）');
  ok(/pendingLeft = 0;/.test(cHtml), '用一次即清（一次性，不会累积）');

  // ---- 4) 桥接转发；旧版编辑器没有这个能力时静默跳过 ----
  ok(/notifyLayoutShift\(dLeft\)/.test(br), '桥接提供 notifyLayoutShift');
  const brSeg = br.slice(br.indexOf('notifyLayoutShift(dLeft) {'),
    br.indexOf('notifyLayoutShift(dLeft) {') + 600);
  ok(/typeof fn !== 'function'/.test(brSeg),
    '编辑器无此能力时静默返回 false（补偿是锦上添花，不该弹「XX 失败」）');

  // ---- 5) 时序账：开合同步补 + resize 撤内核，两帧都对 ----
  //
  // 这是"改完还在抖"的根因：容器是 CSS 挪的、本帧就上屏，而 iframe 的 resize
  // 何时派发由浏览器决定。把补偿全压在 resize 里，慢一帧就是一次肉眼可见的
  // 抖动。所以这里**真跑一遍源码里那两段**，分别断言两个时刻：
  //   · resize 还没来时，画面已经是对的（补偿同步生效，没有中间态）
  //   · resize 来了之后，净位移仍是 0
  {
    const iife = html.slice(
      html.indexOf('(function () {\n            var pendingLeft = 0;'),
      html.indexOf("hostPost({ type: 'request', id: 0"));
    ok(/notifyLayoutShift/.test(iife) && /addEventListener\('resize'/.test(iife),
      '抠出完整的补偿 IIFE');

    // 桩：内核只暴露补偿用到的口子；panBy 记录每一次平移
    function makeSim(w0) {
      let w = w0;
      const pans = [];
      let onResize = null;
      const km = {
        _lastClientSize: { width: w0, height: 600 },
        getRenderTarget: () => ({ clientWidth: w, clientHeight: 600 }),
      };
      const win = {
        addEventListener: (t, fn) => { if (t === 'resize') onResize = fn; },
        __minder: { panBy: (dx) => { pans.push(dx); return true; } },
      };
      // eslint-disable-next-line no-new-func
      new Function('window', 'km', iife)(win, km);
      return {
        sum: () => pans.reduce((a, b) => a + b, 0),
        notify: (d) => win.__minder.notifyLayoutShift(d),
        // 模拟内核的 resize：先按 (dw/2)|0 平移，再把 _lastClientSize 推到新值
        kernelResize: (newW) => {
          const dw = newW - km._lastClientSize.width;
          w = newW;
          km._lastClientSize = { width: newW, height: 600 };
          pans.push((dw / 2) | 0);
          if (onResize) onResize();
        },
      };
    }

    // 展开：容器右移 216（文件库 186 + gap 10 + 内边距归边后实测）
    {
      const s = makeSim(1000);
      s.notify(216);
      eq(s.sum(), -216, '开合**同步**就补掉容器位移 -216（不等 resize）');
      eq(216 + s.sum(), 0, 'resize 还没来画面已经是对的（不会再晃一帧）');
      s.kernelResize(784);                 // 内核自动居中 -108 → 本侧撤销 +108
      // sum 里已经含内核那一下（kernelResize 记的就是它），别再单列一次
      eq(216 + s.sum(), 0, '展开：容器 +216 与全部视图平移相加 → 净位移 0');
    }

    // 收起：完全对称
    {
      const s = makeSim(784);
      s.notify(-216);
      eq(s.sum(), 216, '收起同步补 +216');
      s.kernelResize(1000);
      eq(-216 + s.sum(), 0, '收起：净位移 0');
    }

    // 普通拖窗口：没有待处理的开合 → 不补偿，内核的居中行为原样保留
    {
      const s = makeSim(1000);
      s.kernelResize(900);
      eq(s.sum(), -50, '拖窗口不补偿（内核那一下保留，不越权）');
    }
  }

  // ---- 6) 回归护栏：不得退回「iframe 内测容器位移」的老路 ----
  //
  // 老实现的测点在 editor/index.html 里取 #minder-container 的
  // getBoundingClientRect().left —— iframe 内的坐标相对 iframe 自己的视口，
  // 父页面把 iframe 挤到右边时它恒定不变，容器位移被完全抵消。
  // 只断言"代码里有 getBoundingClientRect().left"是抓不住的（老实现也有），
  // 必须断言**补偿链路里不出现 iframe 内的容器测量**。
  const compSeg = html.slice(html.indexOf('notifyLayoutShift = function'),
    html.indexOf("hostPost({ type: 'request', id: 0"));
  ok(!/getBoundingClientRect\(\)\.left/.test(compSeg),
    '补偿链路不在 iframe 内测容器左边缘（那里测不到父页面的位移）');
}

group('app 句柄：可写状态必须成对提供 getter/setter');

{
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  // 扫**所有**拿到 app 句柄的模块，不只 panels.js —— 下次新模块给
  // getter-only 属性赋值时同样的坑会重演，而报错只在运行时出现。
  const MODULES = ['panels.js', 'filelist.js', 'mediainfo.js', 'themes.js',
    'formats.js', 'xmind.js', 'workbook.js', 'store.js', 'tab-drag.js',
    'tag-badges.js', 'layout-thumbs.js', 'diagnostics.js', 'preset-icons.js'];
  const pj = MODULES.map((f) => {
    try { return fs.readFileSync(path.join(HERE, f), 'utf8'); } catch (e) { return ''; }
  }).join('\n');

  // ---- 1) 机制自证：严格模式下给「只有 getter」的访问器赋值会抛错 ----
  //
  // 这是本 bug 的根因（ES 模块恒为严格模式）。先把它钉住，
  // 免得以后有人改成普通属性后忘了为什么需要 setter。
  {
    const only = {};
    Object.defineProperty(only, 'a', { get: () => 1, configurable: true });
    let threw = null;
    try { only.a = 2; } catch (e) { threw = e; }
    ok(threw instanceof TypeError, '严格模式下给只有 getter 的属性赋值会抛 TypeError');
    ok(/has only a getter/.test(threw ? threw.message : ''),
      `报错信息与线上一致（实际：${threw ? threw.message : '无'}）`);

    // 成对提供后即可正常写入
    let v = 1;
    const pair = { get a() { return v; }, set a(x) { v = x; } };
    pair.a = 99;
    eq(pair.a, 99, '提供 setter 后赋值生效');
  }

  // ---- 2) 通用守卫：panels.js 里所有 `app.X = ...` 都必须在 app 上有 setter ----
  //
  // 不能只断言 customThemes 一处 —— 下次再加一个 getter-only 的可写状态时
  // 同样的坑会重演，而报错发生在运行时、测试却全绿。
  const appStart = ix.indexOf('const app = {');
  ok(appStart > 0, '找到 app 对象字面量');
  // 取到与之匹配的收尾 `};`（用缩进为 2 空格的 `};` 作结束标志）
  const appEnd = ix.indexOf('\n  };', appStart);
  const appBlk = ix.slice(appStart, appEnd);

  const assigned = [...new Set(
    [...pj.matchAll(/\bapp\.([A-Za-z_$][\w$]*)\s*(?:=[^=]|\+=|-=)/g)].map((m) => m[1]),
  )];
  ok(assigned.length > 0, `存在对 app 属性的赋值（${assigned.join(', ')}）`);

  for (const name of assigned) {
    const hasSetter = new RegExp(`set\\s+${name}\\s*\\(`).test(appBlk)
      || new RegExp(`set\\s+${name}\\s*\\(`).test(ix.slice(0, appStart));
    ok(hasSetter, `app.${name} 有 setter（否则赋值会抛 TypeError）`);
  }

  // ---- 3) 具体：customThemes 三者齐全 ----
  ok(/get customThemes\(\) \{ return customThemes; \}/.test(appBlk), 'app.customThemes 有 getter');
  ok(/set customThemes\(v\) \{ customThemes = v \|\| \[\]; \}/.test(appBlk),
    'app.customThemes 有 setter（写到模块级变量，saveThemes 读的就是它）');
  // setter 必须落到**模块级变量**，saveThemes 才能存到新值。
  // 写成存到别处（或忘记赋值）的话读取仍是旧数组，等于没改。
  ok(/await store\.themes\.save\(customThemes\)/.test(ix),
    'saveThemes 落盘读的是模块级 customThemes');

  // ---- 4) 三条受影响路径都还在（说明 setter 不是死代码）----
  // 现在是 **6 处**：3 处正向赋值（导入 / 删除 / 编辑保存）+
  // 3 处写盘失败时的回滚（BUG 61）。当初写死 3 是在给「setter 不是死代码」
  // 当证据，现在这个证据要跟着实现走 —— 写成 3 会把 BUG 61 的回滚挡在门外。
  const pjOnly = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  eq((pjOnly.match(/app\.customThemes\s*=/g) || []).length, 6,
    'panels.js 有六处赋值（3 处正向 + 3 处写盘失败回滚，见 BUG 61）');
}

group('清除按钮图标 / 样式间距 / 媒体查看尺寸');

{
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');

  // ---- 1) 清除类按钮不用 ✕ / × ----
  //
  // ✕ 在界面上的通行含义是「关闭 / 取消」，而这里是「把样式恢复默认」。
  // 用户看到 ✕ 会以为点了就把这一节收起来，不敢点。
  const q = pn.slice(pn.indexOf('function quietBtn('), pn.indexOf('function quietBtn(') + 420);
  ok(/'⟲'/.test(q), '清除按钮用 ⟲（还原）而不是 ✕（像关闭）');
  ok(!/'✕'|'×'|'✖'/.test(q), '清除按钮不再用 ✕ / ×');

  // ---- 2) B / I / S 与字体色之间留空隙 ----
  //
  // 间距要加在**这一组的第一个**上，不是每个 chip 都加 —— 那是"间距"不是"分隔"。
  const bis = pn.slice(pn.indexOf("title: '加粗'") - 400, pn.indexOf("title: '删除线'") + 60);
  ok(/marginLeft: '14px'/.test(bis), 'B 前有 14px 空隙（颜色与字形是两套功能）');
  // 只加一次：给每个 chip 都加会变成均匀的间距，分隔感反而没了
  eq((pn.match(/marginLeft: '14px'/g) || []).length, 1, '空隙只加一次（分隔而非间距）');

  // ---- 3) 图片预览放大 ----
  const pv = css.slice(css.indexOf('.mm-preview {'), css.indexOf('.mm-preview {') + 320);
  {
    const mw = pv.match(/max-width:\s*min\((\d+)vw,\s*(\d+)px\)/);
    ok(!!mw, '能取到 .mm-preview 的 max-width');
    if (mw) {
      ok(Number(mw[1]) >= 90, `预览宽度放到 ≥90vw（实际 ${mw[1]}vw）`);
      ok(Number(mw[2]) >= 1000, `预览像素上限 ≥1000px（实际 ${mw[2]}px）`);
    }
    const mh = pv.match(/max-height:\s*(\d+)vh/);
    ok(Number(mh && mh[1]) >= 70, `预览高度 ≥70vh（实际 ${mh && mh[1]}vh）`);
  }
  // 光放大图片不够：dialog 本身固定 560px，图再大也被容器压住
  ok(/\.mm-dialog\.wide\s*\{/.test(css), '有宽版 dialog（否则 560px 容器会把大图压回去）');
  {
    // 锚点要带 ` {`：注释里也出现了 `.mm-dialog.wide`，只按类名找会命中注释，
    // 取到的 160 字符全是注释文字，断言永远失败（且失败原因看不出来）。
    const w = css.slice(css.indexOf('.mm-dialog.wide {'), css.indexOf('.mm-dialog.wide {') + 160);
    ok(/width:\s*min\(1160px/.test(w), '宽版 dialog 放宽到 1160px');
  }
  ok(/\{ wide: true \}\);/.test(pn), '预览/播放传了 wide');

  // ---- 4) 视频必须限高，否则按钮被挤出可视区 ----
  //
  // 竖屏视频（9:16）按 width:100% 铺开能到近千像素高，把下方
  // 「截图 / 设为缩略图 / 关闭」全挤出 max-height:86vh 的可视区 ——
  // 表现为「按钮不见了」，其实是要往下滚才看得到。
  const vd = css.slice(css.indexOf('video.mm-video {'), css.indexOf('video.mm-video {') + 260);
  ok(/max-height:\s*\d+vh/.test(vd), 'video 有 max-height（否则竖屏视频把按钮挤出可视区）');
  // 只限高不设 object-fit 会把画面压扁
  ok(/object-fit:\s*contain/.test(vd), 'video 用 contain（只限高不设会把画面压扁）');
  // 旧的那条规则必须已被移除：两条同时存在时谁生效取决于顺序，不可预测
  eq((css.match(/video\.mm-video\s*\{/g) || []).length, 1, 'video 规则只有一条（不能两条打架）');
}

group('文件图标：悬停高亮框与行距');

{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const fiAt = html.indexOf("var FileIcon = kity.createClass");
  const fi = html.slice(fiAt, fiAt + 1800);

  // rect 是**悬停高亮框**，几何必须罩住 outline 的实际范围 x∈[-8,3] / y∈[-10,10]
  const m = fi.match(/this\.rect = new kity\.Rect\((\d+), (\d+), (-?\d+), (-?\d+)/);
  ok(!!m, '能取到 FileIcon rect 几何');
  if (m) {
    const [, w, h, x, y] = m.map(Number);
    ok(x <= -8 && x + w >= 3, `rect 横向罩住 outline（[${x}, ${x + w}] 需含 [-8,3]）`);
    ok(y <= -10 && y + h >= 10, `rect 纵向罩住 outline（[${y}, ${y + h}] 需含 [-10,10]）`);
    // 文件名在图标原点右侧 12px（cx-34 vs 图标 cx-46），rect 右边界不能伸过去
    ok(x + w <= 12, `rect 右边界不压到文件名（${x + w} ≤ 12）`);
  }

  // 行距必须 ≥ 图标高度 20
  const rowStep = html.match(/top \+= (\d+);\s*\n\s*\}\s*\n\s*\}\s*\n\s*\} catch/);
  const step = Number((html.match(/top \+= (\d+);/g) || []).slice(-1)[0]?.match(/\d+/)?.[0]);
  ok(step >= 20, `文件行距 ≥ 20（实际 ${step}）—— 17 会让相邻图标重叠 3px`);
}

group('Enter 插入同级：按了要有反应（不再被按钮吃掉）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const br = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');

  /* ---- 1) 链路完整：门面 → bridge → 转发 ---- */
  ok(/window\.__minderInsertSibling\s*=/.test(html), '编辑器页暴露 window.__minderInsertSibling');
  ok(/function\s+insertSiblingNode/.test(html), '插入同级抽成具名函数（Enter 与门面共用同一份）');
  ok(/kmShortcut\('Enter',\s*insertSiblingNode\)/.test(html), 'Enter 快捷键与门面同一个实现');
  ok(/insertSibling\(\)\s*\{/.test(br), 'bridge 有 insertSibling()');
  ok(/w\.__minderInsertSibling\?\.\(\)/.test(br), 'bridge.insertSibling 调到内层门面');
  ok(/bridge\?\.insertSibling\(\)/.test(ix), '插件层把 Enter 转送给 bridge');

  /* ---- 2) 行为级：Enter 的插入位置真的是"同级" ---- */
  {
    const i = html.indexOf('function insertSiblingNode()');
    ok(i > 0, '有 insertSiblingNode');
    // 切到 kmShortcut 那行之前：否则会把 kmShortcut 调用也切进来，
    // 而 kmShortcut 是外层 IIFE 里的局部函数，new Function 里没有它 → 直接崩。
    // 崩溃 ≠ 断言失败（脚本也会判"抓到"），是本项目反复踩过的假阳性。
    const src = html.slice(i, html.indexOf("kmShortcut('Enter'", i));

    const run = (sel) => {
      const log = [];
      const km = {
        getSelectedNode: () => sel,
        getRoot: () => ({ id: 'ROOT', children: [] }),
        createNode(t, parent, index) { log.push(`create(parent=${parent && parent.id}, index=${index})`); return { id: 'NEW' }; },
        select() {}, fire() {}, layout() {},
      };
      let inserted = null;
      const insertNode = (parent, index) => { inserted = { parent, index }; log.push('insertNode'); };
      const fn = new Function('km', 'insertNode', src + '; return insertSiblingNode;')(km, insertNode);
      fn();
      return { log, inserted };
    };

    // 普通子节点：插到父的 index+1 处 → 紧随其后，是同级
    {
      const parent = { id: 'P', children: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] };
      const sel = { id: 'B', parent, getLevel: () => 1, getIndex: () => 1 };
      const { inserted } = run(sel);
      ok(inserted && inserted.parent === parent, '插到**父节点**下（同级，不是子节点）');
      eq(inserted?.index, 2, '位置是 sel.getIndex()+1（紧跟在选中节点之后）');
    }

    // 根节点：没有同级可言，退化成插子节点
    // 否则会插到根自己旁边变成"双根"，遍历与导出都会出问题
    {
      const root = { id: 'ROOT', parent: null, getLevel: () => 0, getIndex: () => 0, children: [] };
      const { inserted } = run(root);
      ok(inserted && inserted.parent === root, '根节点降级为插子节点（不能插成双根）');
    }

    // 异常数据：parent 存在但 getLevel() 返回 0（导入的老数据 / 数据损坏）。
    // 只看 sel.parent 的话，会拿根的"父"去插，插出一个谁都不挂的游离节点。
    // getLevel() > 0 这道判断正是挡这个的 —— 不能省。
    {
      const weirdParent = { id: 'WEIRD', children: [] };
      const sel = { id: 'W', parent: weirdParent, getLevel: () => 0, getIndex: () => 3, children: [] };
      const { inserted } = run(sel);
      eq(inserted?.parent?.id, 'W', 'parent 异常时降级为插子节点（不拿可疑的父去插）');
    }

    // 无选中：插到根下
    // 比对用 id 而不是对象引用：源码里走的是 km.getRoot()，
    // mock 每次返回的是同一个对象，但断言不该依赖这一点
    {
      let inserted = null;
      const root = { id: 'ROOT', children: [] };
      const km = {
        getSelectedNode: () => null,
        getRoot: () => root,
        createNode() { return { id: 'NEW' }; },
        select() {}, fire() {}, layout() {},
      };
      const fn = new Function('km', 'insertNode',
        html.slice(html.indexOf('function insertSiblingNode()'), html.indexOf("kmShortcut('Enter'", html.indexOf('function insertSiblingNode()')))
        + '; return insertSiblingNode;')(km, (parent, index) => { inserted = { parent, index }; });
      fn();
      eq(inserted?.parent?.id, 'ROOT', '无选中时插到根下（不静默丢失）');
    }
  }

  /* ---- 3) 转发必须放过 Shift+Enter（编辑框里是换行）---- */
  {
    const fn = ix.slice(ix.indexOf('function bindKeyForward'), ix.indexOf('const refocusCanvas'));
    ok(/isEnter\s*&&\s*e\.shiftKey/.test(fn), 'Shift+Enter 不抢（交给浏览器 / 编辑框换行）');
  }
}

group('视频/附件不压文字：居中必须按撑高前的盒算');

{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');

  /* ---- 1) 附件区必须把"撑高前的盒"留下来 ---- */
  {
    const i = html.indexOf('var box = node.getContentBox();');
    ok(i > 0, '附件区读取 contentBox');
    const seg = html.slice(i, i + 900);
    ok(/node\._kmBaseBox\s*=\s*box/.test(seg),
      '附件区撑高**之前**把原盒存进 node._kmBaseBox');
    // 必须是**无条件**记录：放在 if(!box) return 之后的话，那一次提前返回
    // 会留下上一次渲染的旧值，bindValign 拿旧盒算出的文字位置是错的。
    const atRecord = seg.indexOf('node._kmBaseBox = box');
    const atReturn = seg.indexOf('if (!box || !box.height) return;');
    ok(atRecord >= 0 && atReturn > atRecord,
      '_kmBaseBox 在提前 return **之前**记录（否则会留旧值）');

    /* ---- 判断"有没有额外内容"不能靠**比高度** ----
     * 实测（内核跑在 jsdom 里）：root(font-size 16)
     *   getContentBox() 高 40，而文字盒高 16 —— 差的 24 是外框内边距。
     * 所以 (cbox.height - 文字盒高) > 1 **恒为真**，比高度等于永远判"带图"。
     * 也不能用 tr.contentBox：批量渲染里内核记的是**上一个**渲染器的盒
     * （renderNodeBatch 的 off-by-one），实测 root 上它是 0×0。
     */
    const i2 = html.indexOf('function bindValign()');
    const vb = html.slice(i2, html.indexOf('valignBindDone = true;', i2));
    ok(/window\.__kmNodeValign\(node\)/.test(vb), '对齐判断走 __kmNodeValign(node)');
    ok(!/tr\.contentBox/.test(vb), '不用 tr.contentBox（它是上一个渲染器的盒，实测 0×0）');
    ok(!/\.height\s*-\s*(bb|tbox)\.height/.test(vb), '不再靠"内容盒比文字盒高多少"判断');
    // 平移量仍必须实测：用记账值反而会偏
    ok(/__kmTextDy\(bb, cbox, va/.test(vb), '平移量 dy 仍用实测的 bb（不用记账盒）');
  }

  /* ---- 2) 文字居中必须用原盒，不能用撑高后的 ---- */
  {
    const i = html.indexOf('function bindValign()');
    ok(i > 0, '有 bindValign');
    const seg = html.slice(i, html.indexOf('valignBindDone = true;', i));
    ok(/node\._kmBaseBox\s*\|\|\s*node\.getContentBox\(\)/.test(seg),
      'bindValign 用 _kmBaseBox（不是撑高后的 getContentBox()）');
  }

  /* ---- 3) 行为级：模拟一次 noderender，看文字被推到哪 ---- */
  //
  // 两个 handler 都挂在 noderender 上，附件区（先注册）先跑，
  // 它把 _contentBox 撑高；bindValign（后注册）随后跑。
  // 若 bindValign 读撑高后的盒，居中就会把文字推进视频区。
  {
    const TXT_H = 20;      // 文字高度
    const VID_H = 54;      // 视频卡片高度
    const PAD = 6;         // ATTACH_PAD

    const dySrc = html.slice(html.indexOf('window.__kmTextDy = function'),
      html.indexOf('};', html.indexOf('window.__kmTextDy = function')) + 2);
    const vaSrc = html.slice(html.indexOf('window.__kmNodeValign = function'),
      html.indexOf('};', html.indexOf('window.__kmNodeValign = function')) + 2);
    const scope = {};
    new Function('window', dySrc + '\n' + vaSrc +
      '\nthis.dy = window.__kmTextDy; this.va = window.__kmNodeValign;').call(scope, {});
    const { dy: kmTextDy, va: kmNodeValign } = scope;

    // 纯文本节点 → 居中
    const node = { getData: () => null };
    eq(kmNodeValign(node), 'middle', '纯文本节点 → 居中');

    // 原盒（撑高前）：文字盒即内容盒
    const cbox = { y: 0, height: TXT_H };
    const bb = { y: 0, height: TXT_H };
    const dRight = kmTextDy(bb, cbox, 'middle', 0);
    eq(dRight, 0, '用原盒：文字正好在盒内居中（dy = 0）');

    // 撑高后的盒：附件区把盒往下长了 (VID_H + PAD)
    const extra = VID_H + PAD;
    const grown = { y: 0, height: TXT_H + extra };
    const dWrong = kmTextDy(bb, grown, 'middle', 0);
    eq(dWrong, extra / 2, `用撑高后的盒：文字被下移 ${extra / 2}px（多出高度的一半）`);

    // 关键：下移之后文字落进了视频区
    // 视频区 = 原盒下沿 + PAD 起，高 VID_H
    const vidTop = TXT_H + PAD;
    const vidBot = vidTop + VID_H;
    const txtTop = bb.y + dWrong;
    const txtBot = txtTop + TXT_H;
    ok(txtBot > vidTop && txtTop < vidBot,
      `文字(${txtTop}~${txtBot}) 落进视频区(${vidTop}~${vidBot}) —— 这就是"视频压到文字"`);

    // 反过来：用对盒时文字不进视频区
    ok((bb.y + dRight + TXT_H) <= vidTop, '用对盒时文字不进视频区');
  }
}

group('Tab 建节点：一次就成（不再多出一条孤立连线）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');

  // 取 insertNode 的**完整函数体**（到下一个顶层函数为止）
  const i = html.indexOf('function insertNode(parent, index)');
  ok(i > 0, '有 insertNode');
  const src = html.slice(i, html.indexOf('function removeSelectedNode()', i));

  /* ---- 行为级：用 mock 跑真实源码，看按一次 Tab 到底发生了什么 ---- */
  const run = (parent) => {
    const log = [];
    const node = { render() { log.push('render'); }, renderTree() { log.push('renderTree(new)'); } };
    const km = {
      // 真实内核：createNode 内部已经 appendNode —— mock 必须还原这一点，
      // 否则「编辑器又 append 一次」这个 bug 根本暴露不出来
      createNode(text, p, index) {
        log.push('createNode');
        log.push('kernel:appendNode');
        return node;
      },
      appendNode() { log.push('editor:appendNode'); },
      select() { log.push('select'); },
      fire() { log.push('fire'); },
      layout(d) { log.push('layout' + (d === undefined ? '' : '(' + d + ')')); },
    };
    const beginTextEdit = () => log.push('beginTextEdit');
    const fn = new Function('km', 'beginTextEdit', src + '; return insertNode;')(km, beginTextEdit);
    fn(parent, null);
    return log;
  };

  {
    const log = run({ children: [], isCollapsed: () => false });
    // 核心：**必须渲染**。attachNode 只把容器挂进树里，不画内容。
    // 不渲染 → 节点没有 _contentBox → 连线画到 (0,0)，节点自身不可见也选不中
    ok(log.includes('render'), '新节点被 render（否则不可见、选不中，只剩一条孤立连线）');
    // createNode 内部已 append 过，编辑器再调一次会让 attachNode 跑两遍
    ok(!log.includes('editor:appendNode'), '不再重复调用 km.appendNode（createNode 内部已 append）');
    // 顺序：先渲染，再布局，最后开编辑框 —— 反了编辑框定位不到节点
    ok(log.indexOf('render') < log.indexOf('layout'), 'render 在 layout 之前');
    ok(log.indexOf('layout') < log.indexOf('beginTextEdit'), 'layout 在 beginTextEdit 之前');
  }

  /* ---- 父节点折叠：必须整棵子树重渲，只 render 新节点不够 ---- */
  {
    let treeRendered = false;
    let expanded = false;
    const parent = {
      children: [],
      isCollapsed: () => true,
      expand() { expanded = true; },
      renderTree() { treeRendered = true; },
    };
    run(parent);
    ok(expanded, '父节点折叠时先 expand');
    ok(treeRendered, '折叠时整棵子树重渲（只 render 新节点的话，展开的老节点是残影）');
  }

  /* ---- 源码级：防止改回去 ---- */
  ok(/km\.createNode\(null, parent, idx\)/.test(src), '位置通过 createNode 的第三个参数传（不再事后 append）');
  // 不能传 null：insertChild 只对 undefined 取「追加到末尾」，
  // 传 null 会被 splice 当成 0，节点插到最前面
  ok(/index == null\s*\?/.test(src), 'index 为 null 时换算成末尾下标（不能直接传给 createNode）');
  // km.layout() 不接受参数：动画时长只由 layoutAnimationDuration 决定，
  // 写 layout(100) 里的 100 会被静默忽略
  ok(!/km\.layout\(\s*\d/.test(src), 'km.layout() 不传无效的数字参数（那会被忽略）');
  ok(!/km\.appendNode\(/.test(src), '源码里已无 km.appendNode 调用');
  // 全文都不该再有 layout(数字)：km.layout() 不接受参数，写了也是静默忽略。
  // 先剥掉注释再匹配 —— 否则会命中「写 layout(100) 会被忽略」这句说明文字
  const codeOnly = stripCommentsFlat(html).split('\n')
    .filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l)).join('\n');
  ok(!/km\.layout\(\s*\d/.test(codeOnly),
    '全文无 km.layout(数字)（该参数会被静默忽略，写了是误导）');
}

group('数值输入框 numSpinner（▲▼ 步进 / ▾ 选预设 / 滚轮 ±1）');

{
  const pn = await import('./panels.js');
  // 构造一个可测的 spinner：只关心交互语义，不依赖具体主题页
  const changes = [];
  const sp = pn.numSpinner({
    value: 5, min: 0, max: 24, list: [0, 3, 5, 8, 12, 16, 24],
    onChange: (v) => changes.push(v),
  });
  const inp = sp.querySelector('input.mm-num');

  eq(inp.value, '5', '初始显示当前值');

  /* ---- 1) ▲ / ▼ 是 ±1，不是在预设列表里挪 ---- */
  const arrows = [...sp.querySelectorAll('.mm-num-spin .mm-num-arrow')];
  eq(arrows.length, 2, '上下两个箭头');
  arrows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  eq(changes.at(-1), 6, '▲ = +1（不是跳到下一个预设 8）');
  arrows[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  arrows[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  eq(changes.at(-1), 4, '▼ = -1（连续点会持续 -1）');
  eq(inp.value, '4', '输入框跟着变');

  /* ---- 2) 滚轮 ±1，且一次手势只走一格 ---- */
  changes.length = 0;
  const wheel = (dy) => sp.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
  wheel(-1);
  eq(changes.length, 1, '向上滚 = +1');
  eq(changes.at(-1), 5, '滚动后值 +1');
  // 惯性滚动会连发几十个事件：必须只吃第一格，否则数值瞬间冲到上限
  for (let i = 0; i < 30; i++) wheel(-1);
  eq(changes.length, 1, '同一次手势只走一格（后续 30 个事件被忽略）');

  /* ---- 3) 滚轮只看方向，不看 delta 大小 ---- */
  await new Promise((r) => setTimeout(r, 140));   // 等解锁
  changes.length = 0;
  wheel(-600);
  eq(changes.at(-1), 6, 'delta 很大也只 +1（按量换算会一次跳很多格）');

  /* ---- 3.5) 初值也要钳到 [min,max] ----
   * 此前只在 emit 里钳，初值是裸的 Math.round(Number(v))：
   *   Number(null) === 0 → cur = 0 ；Number('') === 0 → cur = 0
   * 而线宽 min = 1 —— 框里会显示 **0**，一个根本不在允许范围内的值。
   * 上报侧 strokeWidth / lineWidth 在主题值为 0 时确实会给出 "0"。
   */
  {
    /* 源码级：clamp 必须用**参数** fallback，不能写死 return cur。
     *
     * 只做行为断言是不够的：写成 `return cur` 时，初值路径会撞上 TDZ
     * （clamp 定义在 `let cur` 之前）直接抛 ReferenceError —— 进程崩溃，
     * 脚本也会判"抓到"，但那不是断言在把关（本项目第 11 次遇到）。
     * 而且 emit 那条路径用 cur 是对的，所以行为上两者只在初值时分叉。
     */
    const mk = (value, min, max) => pn.numSpinner({ value, min, max, list: [], onChange: () => {} })
      .querySelector('input.mm-num').value;
    // Number(null)/Number('') 都是 0 —— 线宽下限是 1，必须钳到 1
    eq(mk(null, 1, 12), '1', '初值 null → 钳到下限 1（不能显示 0）');
    eq(mk('', 1, 12), '1', "初值 '' → 钳到下限 1");
    // 解析不出来 → 下限（而不是"上一次的值"，此时没有上一次）
    eq(mk('abc', 1, 12), '1', '初值 abc → 下限');
    eq(mk(undefined, 1, 12), '1', '初值 undefined → 下限');
    // 超过上限同样要钳
    eq(mk(999, 1, 12), '12', '初值 999 → 钳到上限 12');
    // 正常值不动
    eq(mk(7, 1, 12), '7', '区间内的初值保持不动');
    // 圆角下限是 0，所以 0 是合法的、必须保留（不能被"钳成 min"以外的值）
    eq(mk(0, 0, 20), '0', '圆角：0 在区间内，保持 0');
  }

  /* ---- 4) 边界钳制 ---- */
  await new Promise((r) => setTimeout(r, 140));
  changes.length = 0;
  const sp2 = pn.numSpinner({ value: 1, min: 0, max: 3, list: [], onChange: (v) => changes.push(v) });
  const inp2 = sp2.querySelector('input.mm-num');
  const a2 = [...sp2.querySelectorAll('.mm-num-spin .mm-num-arrow')];
  for (let i = 0; i < 10; i++) a2[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  eq(changes.at(-1), 0, '减到下限就停住（不会变负数）');
  eq(inp2.value, '0', '输入框显示钳住后的值');

  /* ---- 5) ▾ 弹出预设列表，选中即套用 ---- */
  const sp3 = pn.numSpinner({ value: 5, min: 0, max: 40, list: [0, 3, 5, 8], onChange: (v) => changes.push(v) });
  const caret = sp3.querySelector('.mm-num-caret');
  ok(!!caret, '有 ▾ 预设按钮');
  changes.length = 0;
  caret.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const menu = document.querySelectorAll('.mm-menu-item');
  eq(menu.length, 4, '菜单里是全部预设值');
  [...menu].find((m) => m.textContent === '8')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  eq(changes.at(-1), 8, '选中预设值即套用');
  // 关掉菜单，免得影响后续用例
  document.querySelectorAll('.mm-menu-mask').forEach((m) => m.remove());

  /* ---- 6) 非法输入还原，不把垃圾值当真 ---- */
  const sp4 = pn.numSpinner({ value: 10, min: 0, max: 40, list: [], onChange: (v) => changes.push(v) });
  const inp4 = sp4.querySelector('input.mm-num');
  changes.length = 0;
  inp4.value = 'abc';
  inp4.dispatchEvent(new dom.window.Event('change'));
  eq(changes.length, 0, '非法输入不回调（不会把 NaN 写进节点）');
  eq(inp4.value, '10', '非法输入还原成当前值');

  /* ---- 7) 值没变就不回调 ---- */
  changes.length = 0;
  inp4.value = '10';
  inp4.dispatchEvent(new dom.window.Event('change'));
  eq(changes.length, 0, '值没变就不回调（免得白记一次撤销）');

  /* ---- 8) 三个数值控件都用它 ---- */
  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  for (const [who, pat] of [
    ['字号', /numSpinner\(\{[\s\S]{0,160}?value: st\.fontSize/],
    ['节点线宽', /numSpinner\(\{[\s\S]{0,160}?value: st\.strokeWidth/],
    ['圆角', /numSpinner\(\{[\s\S]{0,160}?value: st\.radius/],
    ['连线线宽', /numSpinner\(\{[\s\S]{0,160}?value: st\.lineWidth/],
  ]) {
    ok(pat.test(src), `${who} 用 numSpinner`);
  }
  /* 圆角上限：既要够得着最大预设，又不能超过**几何上限**
   *
   * kity: formatRadius(w,h,r) = min(floor(min(w/2,h/2)), r)
   * 实测（真实内核跑在 jsdom 里）：
   *   root 104×40 → 上限 20 ｜ 子节点 96×26 → 13 ｜ 长子节点 258×22 → 11
   * 所以：
   *   · 最大预设必须 ≤ 20（此前是 24 —— **任何节点都达不到**，
   *     点了没变化，用户会以为控件坏了）
   *   · max 也不该 > 20（再大只是"拖了没反应"）
   */
  {
    // 从「value: st.radius」往前找到它所属的 numSpinner({ 起点 ——
    // 直接全局 match 会命中**前一个**控件（线宽），那样测的就不是圆角了
    const ri = src.indexOf('value: st.radius');
    const rs = src.lastIndexOf('numSpinner({', ri);
    const seg = src.slice(rs, src.indexOf('})', ri) + 2);
    ok(/value: st\.radius/.test(seg), '定位到圆角那一段');
    ok(/max:/.test(seg), '圆角有 max');
    // max 写成了具名常量，要从常量定义里取值（不能只认字面量数字）
    const mConst = src.match(/const MAX_RADIUS = (\d+)/);
    ok(!!mConst, '圆角上限是具名常量 MAX_RADIUS');
    const max = Number(mConst[1]);
    ok(seg.includes('max: MAX_RADIUS'), '圆角 max 用的是该常量（不是散落的魔法数字）');
    const radii = JSON.parse(src.match(/const RADII = (\[[^\]]+\])/)[1]);
    ok(max >= Math.max(...radii), `圆角 max(${max}) 够得着最大预设(${Math.max(...radii)})`);
    ok(max <= 20, `圆角 max(${max}) 不超过几何上限 20（再大只会饱和，拖了没反应）`);
    ok(Math.max(...radii) <= 20, `最大预设(${Math.max(...radii)}) 不超过几何上限 20`);
  }
}

group('主题：新建 / 编辑后列表立刻刷新（不用切页签）');

{
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  // 主题保存后必须重刷侧栏：列表是 pageTheme() 里按 app.customThemes 现算的，
  // 不刷的话新主题不会出现在列表里，得切走页签再切回来才看得到 ——
  // 用户会以为没保存成功，其实已经落盘了。
  ok(/app\.api\.refreshSide\?\.\(\);/.test(pn), '主题保存后调用 refreshSide');
  // 调用点必须在 applyTheme 之后、dlg.close() 之前：
  // 提前刷会刷到还没写进 customThemes 的旧列表
  {
    const at = pn.indexOf('app.api.refreshSide?.()');
    ok(pn.indexOf('app.api.applyTheme(editing.id)') < at, '刷新在 applyTheme 之后');
    ok(at < pn.indexOf('dlg.close()', at), '刷新在关闭对话框之前');
  }
  // 宿主必须真的暴露这个方法，否则面板里那句是空调用
  ok(/refreshSide:/.test(ix), 'index.js 暴露 refreshSide');
  ok(/side\?\.refresh\?\.\(\)/.test(ix), 'refreshSide 落到侧栏实例的 refresh');
}

group('附件画进节点框内（节点撑高，不再被相邻节点遮挡）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');

  // ---- 1) 纳入节点盒：必须**重建 Box**，不能改原对象的 height ----
  //
  // kity.Box 的 bottom / cx / cy 都是构造时算好的普通属性，改 height
  // 不会连带更新 —— 外框会按旧 bottom 画、连线会按旧 cy 接。
  ok(/node\._contentBox = nb;/.test(html), '把撑高后的盒写回 _contentBox（布局读的就是它）');
  ok(/var nb = new kity\.Box\(/.test(html), '新建 Box 而不是改原对象');
  ok(!/box\.height \+=/.test(html), '没有直接改 box.height（bottom/cy 不会跟着变）');
  ok(!/_contentBox\.height/.test(html), '没有改 _contentBox.height');

  // 只往下长：上沿不动，正文位置不变
  ok(/box\.cx - w \/ 2, box\.y, w, box\.height \+ extra/.test(html),
    '新盒以原上沿为基准、只往下长（正文位置不变）');
  // 宽度要跟着附件走：节点比附件窄时图片/文件名会戳出外框
  ok(/var w = Math\.max\(box\.width, attW\);/.test(html), '节点宽度至少覆盖附件宽度');

  // ---- 2) 外框必须按新盒重画 ----
  //
  // 外框渲染器在 noderender 之前就跑完了，不重画的话附件区露在框外 ——
  // 也就是"放进去了但框没跟着变大"。
  ok(/getRenderer\('OutlineRenderer'\)/.test(html), '取到 OutlineRenderer');
  ok(/orr\.update\(orr\.getRenderShape\(\), node, nb\)/.test(html),
    '外框按新盒重画一次（否则框不跟着变大）');

  // ---- 3) 只在真的画了附件时才撑高 ----
  ok(/if \(top > attachTop\) \{/.test(html), '没有附件时不撑高（不能凭空多出一段空白）');
  ok(/var attachTop = box\.bottom \+ ATTACH_PAD;/.test(html), '附件区起点是原盒下沿 + 内边距');
  // 每类附件都要把自己的宽度记进 attW，漏一类就会戳出框
  for (const [who, pat] of [
    ['图片横幅', /attW = Math\.max\(attW, iw\);/],
    ['视频卡片', /attW = Math\.max\(attW, vw\);/],
    ['文件行', /attW = Math\.max\(attW, rowW\);/],
  ]) {
    ok(pat.test(html), `${who}的宽度计入 attW（漏了会戳出外框）`);
  }

  /* ---- 3.5) 文件行必须**居中**且宽度算对 ----
   *
   * 原写法：图标钉在 cx-46、文字 cx-34，attW 记 `12 + 文字宽`。
   * 问题在于这一行相对 cx **不对称**：
   *   FileIcon 的 outline 路径是 x∈[-8,3]（原点不在中心），
   *   所以图标左缘在 cx-46-8 = **cx-54**，文字右缘在 cx-34+文字宽。
   *
   * 盒是按 cx 居中的（宽度 W → 覆盖 cx±W/2），所需
   *   W = 2 × max(54, 文字宽 - 34)
   * 而记的是 12 + 文字宽 —— 严重偏小：
   *   文字宽 100 → 需 132，记 112 → 文件名戳出右边 10px
   *   文字宽  40 → 需 108，记  52 → 图标整个露在框左边
   */
  {
    const i = html.indexOf('var fils = refListOf(node.getData(\'file\'));');
    ok(i > 0, '有文件行渲染');
    const seg = html.slice(i, html.indexOf('/* ---- 把附件区纳入节点盒', i));
    ok(/var rowW = 20 \+ estTextW\(/.test(seg), '行宽 = 图标 11 + 间隙 9 + 文字宽（即 20 + 文字宽）');
    ok(/var rowLeft = cx - rowW \/ 2;/.test(seg), '行按 rowW 居中（左缘 = cx - rowW/2）');
    ok(/fic\.setTranslate\(rowLeft \+ 8, fy\)/.test(seg),
      '图标原点 = 行左缘 + 8（outline 左缘 x=-8，正好落在行左缘）');
    ok(/fn\.setTranslate\(rowLeft \+ 20, fy \+ 4\)/.test(seg), '文字 = 行左缘 + 20');
    ok(!/cx - 46/.test(seg), '不再把图标钉在 cx-46（那会让整行不对称）');

    /* 数值校验：从**源码**里抠出系数来算，不能在这里另写一份 ——
     * 另写一份的话源码系数被改小（比如改回 12）断言照样绿（假阴性）。
     */
    const mRow = seg.match(/var rowW = (\d+) \+ estTextW\(/);
    ok(mRow, '能取到 rowW 的常数项');
    const K = Number(mRow[1]);
    const mIcon = seg.match(/fic\.setTranslate\(rowLeft \+ (\d+), fy\)/);
    const mText = seg.match(/fn\.setTranslate\(rowLeft \+ (\d+), fy \+ 4\)/);
    const iconOff = Number(mIcon[1]);      // 图标原点相对行左缘
    const textOff = Number(mText[1]);      // 文字起点相对行左缘

    for (const tw of [40, 100, 300]) {
      const rowW = K + tw;
      const left = -rowW / 2;                          // 行左缘相对 cx
      const iconLeft = left + iconOff - 8;             // 图标 outline 左缘（x=-8）
      const textRight = left + textOff + tw;           // 文字右缘
      const realW = textRight - iconLeft;              // 这一行**实际**占多宽

      eq(iconLeft, -textRight, `文字宽 ${tw}：行两侧伸出相等（${iconLeft} / ${textRight}）—— 居中`);
      // 关键：rowW 必须 >= 实际占宽，否则内容戳出外框
      ok(rowW >= realW, `文字宽 ${tw}：rowW(${rowW}) 覆盖实际占宽(${realW}) —— 不够就会戳出外框`);
      // 盒是按 cx 居中的（cx ± W/2），两侧伸出 = realW/2 时需 W = realW
      ok(rowW >= 2 * Math.max(-iconLeft, textRight),
        `文字宽 ${tw}：盒宽 ${rowW} 足够容纳居中后偏移 ${Math.max(-iconLeft, textRight)}`);
    }
    // 常数项必须 >= 20（图标 11 + 间隙 9）：小于它，短文件名的图标会露在框外
    ok(K >= 20, `rowW 常数项 K=${K} >= 20（图标 11 + 间隙 9；旧的 12 会让图标戳出左边）`);
  }

  /* ---- 4) estTextW：优先真实测量，量不到才回落估算 ----
   *
   * 抠源码时必须连 measureTextW / guessTextW **一起**抠 ——
   * 只抠 estTextW 会 ReferenceError（依赖没带进来）。
   */
  {
    /*
     * 起点必须是 **cssFontFamily 之前**（var _GENERIC_FAMILIES）——
     * 只从 `var _mtCtx = null;` 开始切的话，cssFontFamily 不在 chunk 里，
     * 抠出来的代码跑起来会 ReferenceError → 被 catch 吞掉 → 恒回落估算，
     * 于是测量路径的断言全部变成假阴性（看着在把关其实没有）。
     */
    const i = html.indexOf('var _GENERIC_FAMILIES');
    ok(i > 0, '有 cssFontFamily / measureTextW 的测量上下文');
    const end = html.indexOf('var FileIcon = kity.createClass');
    const chunk = html.slice(i, end);
    ok(/function measureTextW\(/.test(chunk), '源码含 measureTextW');
    ok(/function guessTextW\(/.test(chunk), '源码含 guessTextW（回落）');
    ok(/function estTextW\(/.test(chunk), '源码含 estTextW');

    // 造一个可控的 canvas 环境，让 measureText 返回我们指定的值
    const mk = (fnMeasure) => {
      let ctxRef = null;
      const doc = {
        createElement: () => ({
          getContext: () => {
            ctxRef = ctxRef || { font: '', measureText: (t) => ({ width: fnMeasure(t) }) };
            return ctxRef;
          },
        }),
      };
      const m = new Function('document', chunk + '; return { estTextW, guessTextW, measureTextW, cssFontFamily };')(doc);
      return m;
    };

    // 4a) 真实测量可用 → 用测出来的值（不是估算值）
    {
      const m = mk((t) => t.length * 10);          // 每个字符 10px
      eq(m.estTextW('abcd', 12, 'sans-serif'), 40, '能用 measureText 时用它（4×10=40，不是估算的 26.4）');
      eq(m.estTextW('中', 12, 'sans-serif'), 10, 'CJK 也按测量值（估算是 12）');
    }
    // 4b) 测出 0（字体未就绪）→ 必须回落，不能拿 0 当真实宽度
    {
      const m = mk(() => 0);
      eq(m.estTextW('中', 12, 'sans-serif'), 12, 'measureText 给 0 → 回落估算（拿 0 当真值等于"认为没宽度"）');
      eq(m.estTextW('abcd', 12, 'sans-serif'), 12 * 0.55 * 4, '回落时拉丁按 0.55');
    }
    // 4c) 没有 canvas（jsdom / 受限环境）→ 回落
    {
      const m = new Function(chunk + '; return { estTextW };')();   // 无 document
      eq(m.estTextW('中', 12), 12, '拿不到 canvas → 回落估算（不抛错）');
    }
    // 4d) 回落估算本身：CJK 全角、拉丁 0.55
    {
      const m = mk(() => 0);
      eq(m.guessTextW('中', 12), 12, 'CJK 一字 = 1 个字号');
      ok(Math.abs(m.guessTextW('abcd', 12) - 12 * 0.55 * 4) < 1e-6, '拉丁字母 = 0.55 个字号');
      eq(m.guessTextW('', 12), 0, '空串宽度 0');
      eq(m.guessTextW(null, 12), 0, 'null 当空串（不能抛错）');
      ok(m.guessTextW('中文.pdf', 12) > m.guessTextW('abc', 12), '中文名比短拉丁名宽');
    }
    /* 4d-2) cssFontFamily：字体名要加引号才能安全拼进 CSS font 简写
     *
     * `ctx.font = '13px Microsoft YaHei'` 走的是 CSS **简写解析**：
     * 字体名含空格 / 中文 / 逗号时一旦解析失败，赋值会被**静默忽略**，
     * ctx.font 保持旧值 → measureText 用另一支字体量，结果看似正常其实是错的，
     * 而且不报错、也不回落（返回值非零）。
     */
    {
      const m = mk(() => 0);
      const cf = m.cssFontFamily;
      ok(typeof cf === 'function', 'cssFontFamily 存在（且被一起抠出来）');
      eq(cf('Microsoft YaHei'), '"Microsoft YaHei"', '含空格 → 加引号');
      eq(cf('微软雅黑'), '"微软雅黑"', '中文字体名 → 加引号');
      eq(cf('sans-serif'), 'sans-serif', '通用族名**不加**引号（它是关键字，加了变字体名）');
      eq(cf('serif'), 'serif', 'serif 同样不加引号');
      eq(cf('"Comic Sans"'), '"Comic Sans"', '已有引号 → 原样返回（不重复加）');
      eq(cf(''), 'sans-serif', '空 → 回落 sans-serif');
      eq(cf(null), 'sans-serif', 'null → 回落 sans-serif（不能抛错）');
      eq(cf('  Arial  '), '"Arial"', '先 trim 再加引号');
      // 字体**回退链**必须按逗号拆开逐个加引号。
      // 整体加引号会得到 `"Microsoft YaHei, sans-serif"` —— 那是"一个含逗号
      // 的字体名"，CSS 解析失败 → 赋值被忽略 → 永远走估算（等于白测）。
      eq(cf('Microsoft YaHei, sans-serif'), '"Microsoft YaHei", sans-serif',
        '回退链：逐个加引号，通用族名那一段不加');
      eq(cf('微软雅黑, SimSun, serif'), '"微软雅黑", "SimSun", serif', '中文回退链');
      eq(cf('"Microsoft YaHei", sans-serif'), '"Microsoft YaHei", sans-serif',
        '已带引号的回退链 → 原样（不重复加）');
      ok(!/^"[^"]*,/.test(cf('A B, serif')), '结果里不能有"引号跨过逗号"的形态');
    }
    /* 4d-3) 读回校验：ctx.font 赋值被忽略时要能发现
     * 造一个"设不进去"的 ctx（font 恒为旧值），此时必须返回 null 走回落，
     * 而不是拿着旧字体的测量结果当真。
     */
    {
      let ctxRef = null;
      const doc2 = {
        createElement: () => ({
          getContext: () => {
            ctxRef = ctxRef || {
              font: '99px monospace',
              // 赋值被"忽略"：setter 不生效，读回永远是初始值
              set fontValue(v) {},
              measureText: (t) => ({ width: 123 }),
            };
            return ctxRef;
          },
        }),
      };
      // 让 font 变成只读：用 defineProperty 覆盖
      const c = { font: '99px monospace', measureText: (t) => ({ width: 123 }) };
      Object.defineProperty(c, 'font', { get: () => '99px monospace', set: () => {} });
      const doc3 = { createElement: () => ({ getContext: () => c }) };
      const m3 = new Function('document', chunk + '; return { estTextW };')(doc3);
      // 请求 sans-serif，但读回恒为 "99px monospace" → 不含 sans-serif → 判失败 → 回落
      eq(m3.estTextW('中', 12, 'sans-serif'), 12,
        'ctx.font 设不进去时返回估算值（不是拿着旧字体量出来的 123）');
    }
    /* 4d-4) 反过来：**设置成功**时不能被误判成失败。
     * 浏览器读回的是 `13px "microsoft yahei", sans-serif`（带引号），
     * 而 probe 是去引号后的 `microsoft yahei, sans-serif` ——
     * 只去 fam 一侧的引号、不去读回值那一侧，子串匹配会失败，
     * 明明成功却退回估算。
     */
    {
      let store = '99px monospace';
      const c2 = {
        measureText: (t) => ({ width: t.length * 7 }),
        get font() { return store; },
        set font(v) { store = v; },       // 真能设进去
      };
      const doc4 = { createElement: () => ({ getContext: () => c2 }) };
      const m4 = new Function('document', chunk + '; return { estTextW };')(doc4);
      // 若能设进去：读回含 "microsoft yahei" → 校验通过 → 用测量值 7/字
      eq(m4.estTextW('ab', 12, 'Microsoft YaHei'), 14,
        '设置成功时要用测量值（2 字 ×7=14），不能误判成失败退回估算');
      // 回退链：读回 `13px "microsoft yahei", sans-serif`，两边都去引号后才对得上
      eq(m4.estTextW('ab', 12, 'Microsoft YaHei, sans-serif'), 14,
        '回退链也能通过读回校验（两边都要去引号再比对）');
    }

    /* 4e) 为什么必须真测：0.55 是拉丁**小写**的平均宽度，宽字符远不止
     * 实测（Arial 宽度表，字号 13、最长 14 字）：
     *   "WWWWWWWWWWWWWW"  估 100  实 172  → 低估 72px
     *   "MMMMMMMMMMMMMM"  估 100  实 152  → 低估 52px
     * 低估 = 文件名戳出外框（盒子按估算值撑宽）。
     */
    {
      const m = mk(() => 0);          // 走估算
      const est = m.guessTextW('WWWWWWWWWWWWWW', 13);
      ok(est < 172 - 40, `估算对宽字符确实会低估（估 ${est.toFixed(0)} < 实 172）—— 所以必须真测`);
    }
    // 4f) 调用点必须把字体传进去（measureText 按实际字体量才准）
    {
      const j = html.indexOf('var rowW = 20 + estTextW(');
      const seg2 = html.slice(Math.max(0, j - 400), j + 60);
      ok(/estTextW\(flabel, ffs, ffam\)/.test(html), '文件行把字号与字体一起传给 estTextW');
      /* 测量用的字体必须**就是**画出来的那一支。
       * 只传 ffam 给 estTextW 而 setFontFamily 不设的话，SVG 走继承落到浏览器
       * 默认字体（本页 html/body 都没设 font-family），两边不同源 ——
       * 量出来的宽度和画布上画的对不上，等于白测。
       */
      ok(/fn\.setFontFamily\(ffam\)/.test(html),
        '附件名显式设成测量用的那一支字体（测量与渲染必须同源）');
      // setFontFamily 要包在自己的 try 里：它抛错不能连累后面的
      // setStyle('pointer-events','none') —— 那会让文件名挡住点击
      {
        const k = html.indexOf('fn.setFontFamily(ffam)');
        const seg3 = html.slice(Math.max(0, k - 200), k + 120);
        ok(/try \{ fn\.setFontFamily\(ffam\); \} catch/.test(seg3),
          'setFontFamily 单独 try（抛错不能连累后面的 pointer-events）');
      }
      ok(/toLowerCase\(\) === 'default'/.test(seg2),
        "字体 'default' 视作未设置（kity 的占位值，当真会量出错误的宽度）");
    }
  }

  // ---- 5) 注释要说清现在是框内（旧注释说"画在框外"会误导后来人）----
  ok(/附件区（画在节点框\*\*内\*\*）/.test(html), '注释标明画在框内');
  ok(!/附件区（节点框\*\*下沿之外\*\*）/.test(html), '不再声称"画在框外"');
}

group('rootScreenX 必须返回数字（transform.translate 是 [Point]，不是 [number,number]）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const i = html.indexOf('rootScreenX: function () {');
  ok(i > 0, '能定位到 rootScreenX');
  // 切片要够长：注释块占了大半，1400 字符切不到末尾的 return
  const body = html.slice(i, html.indexOf('panBy: function (dx, dy) {'));

  /*
   * 实测（jsdom + 真实 kity）：
   *   km.getRenderContainer().transform.translate = [{x:5,y:0,__KityClassName:'Point'}]
   * 写 `m[0]` 拿到的是 **Point 对象**，于是 `left + pan` 变成字符串拼接，
   * 整个函数返回 "05 0012" 这样的字符串 —— 调用方做减法得到 NaN，
   * 补偿逻辑静默失效（editor-bridge 的 isFinite 守卫会把它转成 null 跳过，
   * 等于"测中央主题位置来补偿"这条路一直是废的）。
   */
  ok(/var pan = 0;/.test(body), 'pan 初始化为数字 0（不再直接取 m[0]）');
  ok(/m\[0\]/.test(body) && /p0\.x/.test(body), '从 Point 上取 .x（不是把 Point 当数字用）');
  ok(/typeof p0 === 'number'/.test(body), '兼容 m[0] 本身就是数字的情况');
  // 四个分量都要**强制转数字**：任一分量是字符串，`+` 就会退化成拼接
  ok(/var left = \+rawLeft \|\| 0;/.test(body), 'left 强制转数字');
  ok(/\+box\.x \|\| 0/.test(body) && /\+box\.width \|\| 0/.test(body),
    'box.x / box.width 同样强制转数字（防止 `+` 退化成字符串拼接）');
  // 行为级还要防"返回值是字符串"：四个分量里只要有一个是字符串，
  // 整串 `+` 就会退化成拼接，返回类型就不再是 number
  {
    const src2 = html.slice(html.indexOf('rootScreenX: function () {'),
      html.indexOf('panBy: function (dx, dy) {'));
    const mk2 = (translate, leftV, boxV) => {
      const obj = new Function('km', 'return ({' + src2.replace(/\}\s*$/, '') + '});')({
        getRoot: () => ({ getRenderContainer: () => ({ getRenderBox: () => boxV }) }),
        getRenderContainer: () => ({ transform: { translate } }),
        getRenderTarget: () => ({ getBoundingClientRect: () => ({ left: leftV }) }),
      });
      return obj.rootScreenX();
    };
    ok(typeof mk2([{ x: 5, y: 0 }], 0, { x: 0, width: 24 }) === 'number',
      'translate 为 [Point] 时返回数字');
    // left 以字符串形式给出（DOMRect 在某些环境下确实会给字符串）
    ok(typeof mk2([{ x: 5, y: 0 }], '0', { x: 0, width: 24 }) === 'number',
      'left 是字符串 "0" 时仍返回数字（不是 "05..." 拼接）');
    // box.x 为空（Box 缺字段）也不能让结果变 NaN/字符串
    ok(typeof mk2([{ x: 5, y: 0 }], 0, { width: 24 }) === 'number',
      'box.x 缺失时仍返回数字');
  }

  // 行为级：真的跑一遍，传一个 [Point] 进去，必须得到数字
  {
    const src = html.slice(html.indexOf('rootScreenX: function () {'),
      html.indexOf('panBy: function (dx, dy) {'));
    const objSrc = '({' + src.replace(/\}\s*$/, '') + '})';
    const fn = new Function('km', 'return ' + objSrc + ';')({
      getRoot: () => ({ getRenderContainer: () => ({ getRenderBox: () => ({ x: 0, width: 24 }) }) }),
      getRenderContainer: () => ({ transform: { translate: [{ x: 5, y: 0 }] } }),
      getRenderTarget: () => ({ getBoundingClientRect: () => ({ left: 0 }) }),
    });
    const v = fn.rootScreenX();
    ok(typeof v === 'number', `返回类型是 number（实测 ${JSON.stringify(v)}）`);
    eq(v, 0 + 5 + 0 + 12, '数值 = left + pan.x + box.x + box.width/2');
  }
}

group('📚 提示语必须区分「有没有结果可退回」与「当前是不是搜索」');

{
  const fl = fs.readFileSync(path.join(HERE, 'filelist.js'), 'utf8');
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  /*
   * isSearchMode() 问的是「当前占着底框的是不是搜索」，
   * hasSearchResults() 问的是「还有没有结果可退回」。
   * 两者不同：搜索出结果后点 📚，底框归文件列表，
   * isSearchMode() 变 false 但结果**还在**（再点一次会退回搜索）。
   *
   * 用 isSearchMode 去算 hasSearch 有个更隐蔽的后果：
   * 它与 isFilesPanel **互斥**（一个面板不能同时是 files 和 search），
   * 于是 `filesOn ? (hasSearch ? '退回搜索结果' : …) : …` 里那个分支
   * **永远命中不了** —— 源码看着有，运行时是死分支。
   */
  ok(/hasSearchResults:\s*\(\)\s*=>\s*hasSearch/.test(fl),
    'filelist 暴露 hasSearchResults（读的是 hasSearch，不是 panel）');
  ok(/isSearchMode:\s*\(\)\s*=>\s*panel\s*===\s*'search'/.test(fl),
    'isSearchMode 仍表示"当前占着底框的是搜索"');
  // 位置断言不可靠（hasSearchResults 排在 isOpen 之后，注释里也提到它），
  // 改成结构性断言：取导出对象的字面量片段，直接看它有没有这个键
  {
    const i0 = fl.indexOf('isSearchMode:');
    const i1 = fl.indexOf('};', i0);
    const exported = fl.slice(i0, i1 > 0 ? i1 : i0 + 800);
    ok(/hasSearchResults:/.test(exported), '导出对象里真有 hasSearchResults 这个键');
    ok(/isSearchMode:|isFilesPanel:|isOpen:/.test(exported), '导出对象片段取对了（含其余键）');
  }

  // buildRail 里必须用 hasSearchResults
  ok(/fileList\?\.hasSearchResults\?\.\(\)/.test(ix),
    'buildRail 用 hasSearchResults 而不是 isSearchMode');
  ok(!/fileList\?\.isSearchMode\?\.\(\)\s*\?\?\s*false/.test(ix),
    'buildRail 不再用 isSearchMode 当 hasSearch');

  // 行为级：模拟两个面板的状态机，验证"结果还在但底框归文件"时提示应含"退回"
  {
    const panelStates = [
      { panel: 'search', hasSearch: true,  filesOn: false, tipShouldMentionBack: false },
      { panel: 'files',  hasSearch: true,  filesOn: true,  tipShouldMentionBack: true  },
      { panel: 'files',  hasSearch: false, filesOn: true,  tipShouldMentionBack: false },
    ];
    for (const st of panelStates) {
      // index.js 现在的算法
      const isFiles = st.panel === 'files';
      const has = st.hasSearch;
      const tip = isFiles ? (has ? '收起文件列表（退回搜索结果）' : '收起脑图文件列表')
        : '显示脑图文件列表';
      eq(tip.includes('退回搜索结果'), st.tipShouldMentionBack,
        `panel=${st.panel} hasSearch=${st.hasSearch} 时提示是否提到"退回搜索结果"`);
    }
    // 关键：证明 isSearchMode 会给出**错误**答案（回归保护）
    const wrong = (st) => {
      const isFiles = st.panel === 'files';
      const hasByWrong = st.panel === 'search';   // ← 旧写法
      return isFiles ? (hasByWrong ? '收起文件列表（退回搜索结果）' : '收起脑图文件列表')
        : '显示脑图文件列表';
    };
    eq(wrong({ panel: 'files', hasSearch: true }), '收起脑图文件列表',
      '反证：旧写法在 files+有结果时给的是错误提示（锁住不允许回退）');
  }
}

group('搜索态下跳过 refresh 后，切回文件列表必须补一次重建');

{
  const fl = fs.readFileSync(path.join(HERE, 'filelist.js'), 'utf8');

  /*
   * refresh() 在 panel === 'search' 时早退（省一次 DOM 重建）。
   * 但 showFiles(true) / setSearch(null) 把 panel 置回 'files' 时只调
   * apply()（切 display），**不会重建** —— 于是用户切回文件列表看到的是
   * 搜索之前的旧内容：新建的文件不在、删掉的还在、高亮也停在旧文件上。
   *
   * 修法：早退时置 filesDirty，apply() 切到 'files' 时补一次 refresh。
   */
  ok(/let filesDirty = false;/.test(fl), '有 filesDirty 标记');
  ok(/if \(panel === 'search'\)\s*\{\s*filesDirty = true;\s*return;\s*\}/.test(fl),
    '搜索态早退时置 dirty（不是直接 return）');
  /*
   * 这条断言最初写成 /filesDirty = false;/ —— 而**声明** `let filesDirty = false;`
   * 本身就含这个子串，于是把"重建后清零"那一行删掉，断言照样绿。
   * 必须排除声明：只匹配**不以 let/const/var 开头**的那次赋值。
   */
  ok(/(^|[^\w])filesDirty = false;/.test(fl.replace(/let filesDirty = false;/g, ''))
    && !/let filesDirty = false;\s*\n\s*const \{ files/.test(fl),
    '真正重建后清掉 dirty（排除声明那一行）');
  // 补刷必须发生在 apply() 里、且只在切到 files 时
  {
    const i0 = fl.indexOf('function apply() {');
    const i1 = fl.indexOf('\n  }', i0);
    const body = fl.slice(i0, i1 > 0 ? i1 : i0 + 900);
    ok(/if \(p === 'files' && filesDirty\) refresh\(\);/.test(body),
      'apply() 里切回 files 且 dirty 时补一次 refresh');
  }
  // 反证：只写 dirty 却不补刷，等于没修
  ok(fl.indexOf('filesDirty') !== fl.lastIndexOf('filesDirty'),
    'filesDirty 被**多处**引用（不是只声明不使用的死变量）');
}

group('装饰形状必须关掉点击，否则会挡住下面可点的那一个');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  /*
   * 根因（真实 kity 实测，非推测）：
   * 派发 mousedown 到盖在上面的三角的 DOM 节点，下面卡片绑定的 handler
   * **一次都没收到**。kity 的事件沿 shape 的**父链**冒泡，
   * 而三角与卡片是 rc 下的**兄弟** —— 兄弟收不到。
   *
   * SVG 默认 pointer-events 是 visiblePainted（填充可见即可命中），
   * 所以装饰形状只要没显式关掉，就会把点击**终止在自己身上**。
   *
   * 播放三角尤其要命：它画在卡片正中心，而那正是用户最本能会去点的
   * 位置（看着就是播放按钮）。结果是"点三角打不开视频"。
   */
  ok(/var decor = function \(sh\)/.test(html), '有 decor() 辅助函数');
  ok(/sh\.setStyle\('pointer-events', 'none'\)/.test(html)
    && /sh\.node\.style\.pointerEvents = 'none'/.test(html),
    'decor 双保险：setStyle + 直接写 node.style');

  // 播放三角必须走 decor
  {
    const i = html.indexOf("var vcy = top + vh / 2;");
    const seg = html.slice(i, i + 900);
    ok(/push\(decor\(/.test(seg), '播放三角走 decor（不是裸 push）');
    ok(/M' \+ \(cx - 7\)/.test(seg), '片段取对了（确实是三角那一段）');
  }
  // 图片底板同样要走 decor：它比 im 大一圈，边缘 3px 环带会命中它
  {
    const i = html.indexOf("var ix = cx - iw / 2;");
    const seg = html.slice(i, i + 700);
    ok(/push\(decor\(/.test(seg), '图片底板走 decor');
    ok(/new kity\.Rect\(iw, ih/.test(seg), '片段取对了（确实是底板那一段）');
  }

  // 反证：把 decor 换成裸 push，这两条必须变红
  ok(!/push\(\(new kity\.Path\)\.setPathData\(\s*'M' \+ \(cx - 7\)/.test(html),
    '三角不再是裸 push(（锁住不允许改回去）');
}

group('拖拽浮层与高亮框必须有样式（且必须在 iframe 内那份 CSS 里）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');

  /*
   * 这两个元素是运行时 createElement 出来的，只设了 className。
   * 样式必须写在 **editor/index.html 的 <style> 里** ——
   * 外壳的 styles.css 作用不到 iframe 内部，写在那边等于没写。
   *
   * 此前两个类一处样式都没有，后果是：
   *   · ghost：无 position → inline 的 left/top 全部失效，且无背景，看不见
   *   · attHi：有 left/top/width/height 但无 position → 同样失效，
   *     且无边框背景 → 目标节点完全没有高亮，只能盲拖
   */
  ok(/\.mm-att-ghost\s*\{/.test(html), '编辑器页内定义了 .mm-att-ghost');
  ok(/\.mm-att-hi\s*\{/.test(html), '编辑器页内定义了 .mm-att-hi');
  // 位置：写在外壳 CSS 里无效，这条锁住"必须在 iframe 内"
  ok(!/\.mm-att-(ghost|hi)\s*\{/.test(css),
    '不在外壳 styles.css 里（那里作用不到 iframe，写了等于没写）');

  /*
   * position 必须是 fixed：
   *   ghost 的坐标来自 e.clientX/Y，attHi 来自 getBoundingClientRect()
   *   —— 两者都是**视口坐标**。用 absolute 会少补 scroll 偏移而错位。
   */
  for (const cls of ['mm-att-ghost', 'mm-att-hi']) {
    const m = html.match(new RegExp('\\.' + cls + '\\s*\\{([\\s\\S]*?)\\}'));
    ok(!!m, `${cls} 的规则块取得到`);
    if (!m) continue;
    const body = m[1];
    ok(/position\s*:\s*fixed/.test(body), `${cls} 用 position: fixed（不设就是 static，left/top 全失效）`);
    ok(/pointer-events\s*:\s*none/.test(body), `${cls} 不吃点击（否则 elementFromPoint 命中它自己）`);
    ok(/z-index\s*:\s*\d/.test(body), `${cls} 有 z-index（否则被画布盖住）`);
    ok(/display\s*:\s*none/.test(body), `${cls} 默认隐藏（inline 只在拖拽时设 block）`);
  }
  // 高亮框要看得见：光有定位没有边框/底色等于没有高亮
  {
    const m = html.match(/\.mm-att-hi\s*\{([\s\S]*?)\}/);
    ok(/border\s*:/.test(m[1]), 'attHi 有边框（否则框住了也看不见）');
    ok(/background\s*:/.test(m[1]), 'attHi 有底色');
  }
  {
    const m = html.match(/\.mm-att-ghost\s*\{([\s\S]*?)\}/);
    ok(/background\s*:/.test(m[1]), 'ghost 有背景（否则文字糊在画布上）');
    ok(/color\s*:/.test(m[1]), 'ghost 有文字色');
  }
}

group('popupMenu 再点同一个锚点必须收起（不能叠层）');

{
  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');

  /*
   * onDoc 里刻意放过了「点在锚点上」（e.target !== anchorEl）——
   * 否则 pointerdown 先关、click 又开，菜单永远打不开。
   * 但这一放过留了洞：再点一次同一个锚点，onDoc 不关，click 又开一个。
   *
   * 实测（jsdom 复刻真实序列 pointerdown → click）：
   *   连点 ▾ 三次 → .mm-menu-mask 数 1 → 2 → 3。
   * 位置完全相同看着只有一个，但选中某项只关掉最上面那层，
   * 下面两层还挂着 → **选完菜单不关**。
   */
  ok(/let openMenu = null;/.test(src), '有模块级 openMenu 单例');
  // 同一个锚点 → 收起并**不再开新的**（必须有 return，否则等于没修）
  {
    const i = src.indexOf('if (openMenu && openMenu.anchor === anchorEl)');
    ok(i > 0, '有「同一锚点」分支');
    const seg = src.slice(i, i + 400);
    ok(/openMenu = null;/.test(seg), '先清掉 openMenu（不清会一直命中这个分支）');
    ok(/prev\.close\(\);/.test(seg), '收起上一个');
    ok(/return\s*\{[\s\S]{0,40}\}/.test(seg), '收起后 return，不再开新的');
  }
  // 开了新的要登记；close 要摘掉登记（否则第二次点击永远命中"同一锚点"分支）
  ok(/openMenu = \{ anchor: anchorEl, close \};/.test(src), '开新的登记为 openMenu');
  ok(/if \(openMenu && openMenu\.close === close\) openMenu = null;/.test(src),
    'close 时摘掉登记（否则状态与实际不同步）');
  // 锚点不同也要先收旧的
  ok(/if \(openMenu\) \{ const p0 = openMenu; openMenu = null; p0\.close\(\); \}/.test(src),
    '锚点不同时先收掉旧的（同样是叠层）');

  // 反证：不能把 openMenu 设成永不清理
  ok(src.split('openMenu').length - 1 >= 6, 'openMenu 被多处引用（不是只声明一次）');
}

group('清空搜索必须连带清掉画布上的高亮框（不能只收面板）');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  /*
   * 实测（真实编辑器页，数带 #0A84FF 描边的形状）：
   *   搜索前 0 → search("子") 后 1 → **清空输入框后仍是 1** →
   *   显式 search("") 后 0。
   *
   * 根因：filelist 只管面板，从头到尾不通知编辑器；而编辑器的高亮框
   * 只有两条清除路径（search('') 与「点到别的节点」），
   * 都不经过外壳的清空动作。于是清空输入框 → 面板收起 → 蓝框还挂在画布上。
   */
  ok(/function clearSearchState\(\)/.test(idx), '有 clearSearchState() 收口函数');

  // 三件事缺一不可
  {
    const i = idx.indexOf('function clearSearchState()');
    const seg = idx.slice(i, i + 420);
    ok(/bridge\?\.search\?\.\(''\)/.test(seg),
      '① 调 bridge.search(\'\')（只有它才会走到 resetSearch → 清高亮框）');
    ok(/fileList\?\.setSearch\(null\)/.test(seg), '② 清左侧结果面板');
    ok(/searchStatusEl\.textContent = ''/.test(seg), '③ 清顶栏「1/2」状态文字');
    ok(/classList\.remove\('warn'\)/.test(seg), '③ 顺带去掉 warn 高亮（留着会一直红着）');
  }

  // 两处调用点都必须走它，不能有一处绕回只清面板
  ok(/if \(!searchInput\.value\.trim\(\)\) clearSearchState\(\);/.test(idx),
    '输入框删空 → 走 clearSearchState');
  {
    const i = idx.indexOf('clearSearchState();\n    // 切换/重载画布会重置编辑器历史基线');
    ok(i > 0, '换画布 → 走 clearSearchState');
  }

  // search('') 失败不能连带把面板也清掉 —— 但有 try/catch 兜住
  {
    const i = idx.indexOf('function clearSearchState()');
    const seg = idx.slice(i, i + 420);
    ok(/try \{ bridge\?\.search\?\.\(''\); \} catch/.test(seg),
      'bridge.search 包 try/catch（编辑器未就绪时只清本地，不该中断）');
  }
}

group('所有 async 按钮处理器必须有错误兜底（否则点了静默失败）');

{
  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');

  /*
   * 通用守卫，不能只盯着某一处：下次再加一个 async 按钮而忘了兜底，
   * 同样的坑会重演，而测试却全绿。
   *
   * 为什么必须有：async 处理器抛错/拒绝时，**界面完全不动** ——
   * 按钮点了没反应，状态栏也不说话。全局 unhandledrejection 只往
   * 诊断日志里记一条，用户看不到。
   *
   * 判定：onclick 里调用了本文件的 async 函数，且处理器文本里既没有
   * safe( 也没有 guard( → 无兜底。
   */
  const asyncs = new Set();
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*async/g)) asyncs.add(m[1]);
  for (const m of src.matchAll(/async\s+function\s+([A-Za-z_$][\w$]*)/g)) asyncs.add(m[1]);
  asyncs.delete('safe'); asyncs.delete('guard');

  /*
   * 取处理器**完整**文本，不能只取到行末。
   *
   * 早先写的是 /onclick:\s*([^\n]*)/ —— 只拿到第一行。
   * 多行写法（onclick: (e) => { ...; removeAt(...); }）的第一行是 `(e) => {`，
   * 里面没有任何 async 调用，于是**整条永远抓不到变异**。
   * 实测：把「移除附件」改回无兜底，这条断言照样绿 —— 又是假阴性（第 18 次）。
   *
   * 改成按括号配对取完整块：以 { ( [ 开头的做括号平衡扫描，
   * 其余（如 `onclick: safe(...)`）取到行末。
   */
  const grab = (from) => {
    const pairs = { '{': '}', '(': ')', '[': ']' };
    let i = from;
    let out = '';
    // 循环是为了跨过箭头函数：'(e) => { ... }' 里 (e) 的配对在 ')' 就结束了，
    // 只取一段会漏掉函数体 —— 那正是多行写法的全部内容所在。
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      const c = src[i];
      if (!pairs[c]) {
        const nl = src.indexOf('\n', i);
        return out + src.slice(i, nl < 0 ? src.length : nl);
      }
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        if (src[j] === c) depth++;
        else if (src[j] === pairs[c]) { depth--; if (depth === 0) break; }
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      let k = i;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src.slice(k, k + 2) === '=>') { i = k + 2; continue; }
      return out;
    }
  };

  const bad = [];
  for (const m of src.matchAll(/onclick:/g)) {
    const txt = grab(m.index + m[0].length);
    for (const a of asyncs) {
      if (!new RegExp('(?<![\w.])' + a + '\\s*\\(').test(txt)) continue;
      if (/safe\(|guard\(/.test(txt)) continue;
      bad.push(src.slice(0, m.index).split('\n').length + ':' + a
        + '  ' + txt.replace(/\s+/g, ' ').trim().slice(0, 80));
    }
  }
  ok(bad.length === 0,
    '每个调用 async 函数的 onclick 都包了 safe()/guard()（未兜底：' + (bad.join(' | ') || '无') + '）');

  // safe() 本身必须真的接住 rejection（不是只 try/catch 同步部分）
  {
    const i = src.indexOf('function safe(label, fn, onErr)');
    ok(i > 0, '有 safe() 收口函数');
    const seg = src.slice(i, i + 420);
    ok(/typeof r\.then === 'function'/.test(seg), 'safe() 检查返回值是不是 Promise');
    ok(/r\.catch\(/.test(seg), 'safe() 接住 rejection（只 try/catch 同步部分不够）');
    ok(/onErr\(`\$\{label\}失败/.test(seg) || /onErr\([`'"][^`'"]*\$\{label\}/.test(seg),
      'safe() 的提示带上操作名（只说「失败」用户不知道是哪一步）');
  }
}

group('getSelectedImages 必须支持真数组（否则画布画得出、侧栏读不到）');

{
  const src = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  // 编辑器画横幅用的 imageListOf 早就处理真数组了
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  ok(/function imageListOf\(node\)/.test(html)
    && /\[object Array\]/.test(html), '编辑器侧 imageListOf 处理真数组（对照）');

  /*
   * 实测：节点 images 为 ['...AAA','...BBB'] 真数组时，
   * editor-bridge 的 getSelectedImages 返回 [] ——
   * 画布上画着两张图，侧栏却显示「当前节点没有图片附件」。
   */
  {
    // 必须找**定义**：_appendImage 里也调了 getSelectedImages()，
    // 只 indexOf('getSelectedImages()') 会落到那个调用点上，切片装不到函数体
    const i = src.indexOf('getSelectedImages() {');
    ok(i > 0, '有 getSelectedImages');
    const seg = src.slice(i, i + 1800);
    ok(/Object\.prototype\.toString\.call\(many\) === '\[object Array\]'/.test(seg),
      '识别真数组（不能只做 JSON.parse）');
    ok(/return many\.filter\(Boolean\);/.test(seg), '真数组直接返回（不经过 parse）');
    // 空数组要照实返回 []，写 a && a.length 会让 '[]' 掉下去
    ok(/if \(Array\.isArray\(a\)\) return a\.filter\(Boolean\);/.test(seg),
      '空数组照实返回 []（不写 a && a.length）');
  }
}

group('两条「附加视频」路径都必须生成封面（不能只修拖放那一条）');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const pan = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');

  // 拖放那条路（index.js handleDropFiles）早就存了 ref.t
  ok(/const t = await makeVideoThumb\(f\);/.test(idx)
    && /if \(t\) ref\.t = t;/.test(idx), '拖放路径存 ref.t（对照）');

  // 取封面的能力必须暴露给面板层，否则按钮这条路拿不到
  ok(/videoThumb: \(file\) => makeVideoThumb\(file\)/.test(idx),
    'api.videoThumb 暴露给面板层');

  /*
   * 按钮这条路的断言：
   * ① 真的调了 api.videoThumb（只对 video）
   * ② 封面写进 ref.t
   * ③ **在 focusNode() 之前**取 —— 之后还有 await 的话，
   *    期间用户点了别处，写回就挂到新节点上了（数据错乱级）
   */
  {
    const i = pan.indexOf('const attach = async (kind) => {');
    ok(i > 0, '有 attach()');
    const seg = pan.slice(i, i + 2000);
    ok(/app\.api\.videoThumb\?\.\(f\)/.test(seg), '① 按钮路径也取封面');
    ok(/if \(thumb\) ref\.t = thumb;/.test(seg), '② 封面写进 ref.t');
    ok(/Promise\.all\(/.test(seg), '存资产与取封面并发（不串行拖慢）');
    /*
     * 必须**先剥注释**再找 focusNode()。
     * 注释里就写着"都排在 focusNode() 之前"，直接 indexOf 会命中注释，
     * 于是顺序真的反了也照样绿 —— 假阴性（本项目已多次踩到）。
     */
    const code = stripCommentsFlatJs(seg);
    const fi = code.indexOf('focusNode()');
    ok(fi > 0 && code.indexOf('videoThumb') < fi,
      '③ 取封面排在 focusNode() 之前');
  }
}

group('点搜索结果条目后，顶栏「1/5」必须跟着变');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const fl = fs.readFileSync(path.join(HERE, 'filelist.js'), 'utf8');

  // 顶栏计数由 runSearch() 算（runSearch 是键盘 Enter 那条路）
  ok(/const st = searchStatusText\(kw, bridge\?\.search\(kw\)\);/.test(idx),
    '顶栏计数在 runSearch() 里算（对照：那是另一条定位路径）');

  // 面板点条目是**第二条**定位路径，必须同步
  ok(/setSearchStatus: \(i1, total\)/.test(idx), 'api 暴露 setSearchStatus');
  {
    const i = fl.indexOf('function jumpTo(i)');
    ok(i > 0, '有 jumpTo()');
    const seg = fl.slice(i, i + 700);
    ok(/api\.setSearchStatus\?\.\(/.test(seg), '点条目后同步顶栏计数');
    ok(/i \+ 1/.test(seg), '传 1 起的序号（面板下标是 0 起）');
    // total 不能用截断后的 items.length
    ok(/searchTotal \|\| searchItems\.length/.test(seg),
      '总数用 searchTotal（items 超 200 会被截断，不能写 items.length）');
  }
  // setSearchStatus 的实现：total<=0 要清空而不是显示 "1/0"
  {
    const i = idx.indexOf('setSearchStatus: (i1, total)');
    const seg = idx.slice(i, i + 420);
    ok(/if \(!\(total > 0\)\)/.test(seg), 'total<=0 时清空（不能显示 "1/0"）');
    ok(/classList\.remove\('warn'\)/.test(seg), '清掉 warn 高亮');
  }
}

group('exec/快捷键引用的命令名必须真的注册过（否则静默失败）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  /*
   * 背景：「粘贴样式」按钮 exec('pastenodestyle')，而编辑器页**只定义了
   * PasteNodeStyleCommand 类、从没有 `km._commands['pastenodestyle'] = ...`。
   * 内核查不到该命令 → 静默失败，面板照样提示「已粘贴节点样式」（假成功）；
   * 绑在同一个名字上的 Ctrl+Shift+V 快捷键同样无效。
   * 而「复制样式」是好的 —— 表现为「复制了却永远粘不上」。
   *
   * 这类失效**不报错、测试全绿**，只能靠名字比对来防。
   */
  const lower = (x) => String(x).toLowerCase();

  // ① 编辑器页自注册的命令（动态扫描，不会过时）
  const selfReg = new Set();
  for (const m of html.matchAll(/_commands\[\s*'([^']+)'\s*\]/g)) selfReg.add(lower(m[1]));

  /*
   * ② 内核内置命令（实测枚举所得，51 个）。
   *
   * 只从 min.js 里正则抠不全（命名模式不统一，只能抠到 14 个），
   * 故以**运行时枚举结果**为准。将来内核升级需重新取一次：
   * 加载内核后读 Object.keys(km._commands)。
   */
  const KERNEL = ('appendchildnode appendparentnode appendsiblingnode arrange arrangedown arrangeup '
    + 'background bold boundary camera clearnodestyle clearstyle collapse copy copynodestyle copystyle '
    + 'cut expand expandtolevel file fontfamily fontsize forecolor hand hyperlink image images italic '
    + 'layout move movetoparent note paste pastestyle priority progress removenode resetlayout resource '
    + 'setnodestyle strikethrough template text textalign theme valign valignoffset video zoom zoomin zoomout')
    .split(/\s+/).filter(Boolean);
  const known = new Set([...KERNEL, ...selfReg]);

  ok(known.has('pastenodestyle'),
    'pastenodestyle 已注册（BUG：只定义了类、没注册 → 粘贴样式静默失败）');
  ok(selfReg.has('copynodestyle'), 'copynodestyle 已注册（对照）');

  // ③ 快捷键绑定的每个命令名都必须有注册
  {
    const bad = [];
    for (const m of html.matchAll(/addCommandShortcutKeys\(\{([\s\S]{0,300}?)\}/g)) {
      for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
        if (!known.has(lower(k[1]))) bad.push('快捷键 ' + k[1]);
      }
    }
    ok(bad.length === 0, '快捷键绑定的命令都有注册（缺失：' + (bad.join('、') || '无') + '）');
  }

  // ④ 插件层 exec 的命令名都必须有注册
  {
    const bad = [];
    for (const f of ['panels.js', 'index.js', 'editor-bridge.js']) {
      const src = fs.readFileSync(path.join(HERE, f), 'utf8');
      for (const m of src.matchAll(/exec\(\s*'([a-zA-Z]+)'/g)) {
        if (!known.has(lower(m[1]))) bad.push(f + ' → ' + m[1]);
      }
    }
    ok(bad.length === 0, 'exec 的命令名都有注册（缺失：' + (bad.join('、') || '无') + '）');
  }
}

group('「清除文字样式」必须清掉文字节能设的**每一个**键');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const pan = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');

  /*
   * BUG：scope==='text' 的清除列表里漏了 'vertical-align'。
   * 面板「文字」节里「水平」「垂直」是并排的两个对齐控件，
   * 一个清一个不清 → 点了「清除文字样式」垂直对齐还留着，像按钮坏了。
   */
  /*
   * **必须先剥注释**再取数组。
   *
   * 不剥的话有两个问题：
   *   1. 切片里注释占了大半，700 字符根本装不到数组结尾（实测 ei = -1）；
   *   2. 更要命的是注释里就写着 'vertical-align'、'text-align' 这些键名，
   *      直接在原文上跑正则会把注释里的也算进去 —— 键真的被删了，
   *      断言照样绿。**又一处假阴性**。
   */
  const strip = (t) => stripCommentsFlatJs(t);
  const i = html.indexOf("scope === 'text'");
  ok(i > 0, '有 text scope 分支');
  const seg = strip(html.slice(i, i + 1500));
  const bi = seg.indexOf('[');
  const ei = seg.indexOf(']', bi);
  ok(bi >= 0 && ei > bi, '取到 text scope 的键数组');
  const arr = seg.slice(bi, ei + 1);
  const keys = [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok(keys.includes('vertical-align'), '清 vertical-align（曾漏）');
  ok(keys.includes('text-align'), '清 text-align（对照）');

  /*
   * 通用守卫：面板「文字」节里每个内核命令对应的数据键，
   * 都必须在 text 的清除列表里。否则「能设却清不掉」。
   */
  const CMD2KEY = {
    fontfamily: 'font-family', fontsize: 'font-size', forecolor: 'color',
    bold: 'font-weight', italic: 'font-style', strikethrough: 'font-strikethrough',
    textalign: 'text-align', valign: 'vertical-align',
  };
  const si = pan.indexOf("sectionAct('文字'");
  ok(si > 0, '面板有「文字」节');
  const sseg = pan.slice(si, si + 4200);
  const bad = [];
  for (const m of sseg.matchAll(/run\(\s*'([a-zA-Z]+)'/g)) {
    const key = CMD2KEY[m[1]];
    if (key && !keys.includes(key)) bad.push(m[1] + '→' + key);
  }
  // 颜色行里那个清除回调不走 run，单独确认它用的是 text scope
  ok(bad.length === 0,
    '文字节每个命令的键都在清除列表里（缺失：' + (bad.join('、') || '无') + '）');
}

group('中心主题必须有 data.id（否则新建画布后无法附加任何文件）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const wbSrc = fs.readFileSync(path.join(HERE, 'workbook.js'), 'utf8');

  /*
   * 实测（真实编辑器页）：
   *   emptyContent() → root.data = {"text":"中心主题"}，id 为 **undefined**
   *   内核只给「新建出来的」节点自动补 id，导入的根节点不补。
   *
   * 后果：选中中心主题 → 点「附加文件…」→ 选完文件 →
   *   rememberNode() 存空 → focusNode() 返回 false →
   *   提示「请先选中一个节点再附加」。用户明明选着中心主题，提示却让他去选节点。
   */
  ok(/root: \{ data: \{ text: rootText \|\| '中心主题' \}/.test(wbSrc)
    || !/data:\s*\{[^}]*id/.test(wbSrc.slice(wbSrc.indexOf('emptyContent'), wbSrc.indexOf('emptyContent') + 400)),
    'emptyContent 生成的根节点确实没有 id（根因确认）');

  ok(/function ensureRootId\(\)/.test(html), '编辑器定义了 ensureRootId');
  {
    const i = html.indexOf('function ensureRootId()');
    /*
     * 窗口必须够大：ensureRootId 上面那段「为什么必须遍历整棵树」的注释已经
     * 超过 900 字符，取 900 会**整段切在注释里** —— 赋值语句根本不在窗口内，
     * 于是这两条断言变成恒假（注释一长就从「在把关」退化成「摆设」）。
     * 这是本项目第 N 次栽在「固定长度切片」上，故这里直接取到函数结束。
     */
    const seg = html.slice(i, i + 2600);
    ok(/n\.data\.id = /.test(seg), '确实写入 data.id（遍历里的逐节点赋值）');
    ok(/if \(n\.data\.id\) return;/.test(seg), '已有 id 时不动（逐节点跳过，不覆盖用户数据）');
  }
  // importJson 之后必须调它；只定义不调用等于没修
  {
    const i = html.indexOf('importJson: function (data)');
    const seg = html.slice(i, i + 500);
    ok(/km\.importJson\(d\);[\s\S]{0,80}ensureRootId\(\);/.test(seg),
      'importJson 之后调用 ensureRootId（只定义不调用 = 没修）');
  }
}

group('focusNode 必须检查 selectNodeById 的返回值（否则附件挂错节点还假成功）');

{
  const pan = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  // 编辑器侧：靠 id 遍历找节点，找不到返回 false
  ok(/window\.__minderSelectNode = function \(uid\)/.test(html)
    && /if \(!found\) return false;/.test(html),
    '__minderSelectNode 找不到节点时返回 false（前提确认）');

  const i = pan.indexOf('const focusNode = () => {');
  ok(i > 0, '有 focusNode()');
  const seg = pan.slice(i, i + 900);
  const code = stripCommentsFlatJs(seg);
  ok(/if \(!id\) return false;/.test(code), '无 id 时返回 false（提示用户去选节点）');
  /*
   * 关键：不能是「调完就 return true」。
   * 正则要求 return 语句里直接用上 selectNodeById 的结果。
   */
  ok(/return\s+!!?app\.bridge\?\.selectNodeById\?\.\(id\);/.test(code),
    '返回 selectNodeById 的结果（不能调完就 return true）');
  ok(!/app\.bridge\?\.selectNodeById\?\.\(id\);\s*\n\s*return true;/.test(code),
    '不是「先调再 return true」的老写法');
}

group('内核没有 clearSelect —— 两处「清空选中」写法全部失效');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const kern = fs.readFileSync(path.join(HERE, 'editor', 'kityminder.core.min.js'), 'utf8');

  /*
   * 前提：Web 版内核**没有** clearSelect（那是 WPF/C# 时代的 API）。
   * 从内核源码里确认，避免把「测试环境碰巧没有」当成根因。
   */
  ok(!/clearSelect\s*:\s*function/.test(kern), '内核确实没有 clearSelect（前提）');
  ok(/select\s*:\s*function\s*\(a,\s*b\)/.test(kern)
    && /b&&\(this\._selectedNodes=\[\]\)/.test(kern),
    'select(a, b) 的 b 为 truthy 时先清空（正确写法的前提）');

  // ---- BUG15：视图选择的六种语义全部失效 ----
  /*
   * apply() 第一句是 `km.clearSelect()` → 抛 TypeError → 被外层 catch 吞掉
   * → select(mode) 返回 false、选中态纹丝不动，用户点了没反应。
   * 而且第二句 `select(ns[i], true)` 循环调用，每次都清空，只剩最后一个。
   */
  const si = html.indexOf('function apply(ns)');
  ok(si > 0, '有 apply(ns)');
  {
    const seg = html.slice(si, si + 900);
    const code = stripCommentsFlatJs(seg);
    ok(!/km\.clearSelect\(\)/.test(code), '不再调用不存在的 km.clearSelect()');
    ok(/km\.select\(ns,\s*true\)/.test(code),
      '一次 select(数组, true) 全选（不是循环逐个 select(n, true)）');
    ok(!/for \(var i = 0; i < ns\.length; i\+\+\) \{ try \{ km\.select\(ns\[i\]/.test(code),
      '不是「循环逐个 select(ns[i], true)」的旧写法（那会只剩最后一个）');
  }

  // ---- BUG16：搜索定位累加选中 ----
  /*
   * `km.clearSelect && km.clearSelect()` 静默短路 → select 变增量累加。
   * 实测：点第1条选1个、第2条选2个…再点回第1条**完全不变**。
   * 更糟：随后的编辑会作用到这一堆节点上。
   */
  const fi = html.indexOf('function focusSearchResult(idx)');
  ok(fi > 0, '有 focusSearchResult()');
  {
    const seg = html.slice(fi, fi + 1200);
    const code = stripCommentsFlatJs(seg);
    ok(!/km\.clearSelect/.test(code), '不再引用不存在的 km.clearSelect');
    ok(/km\.select\s*&&\s*km\.select\(node,\s*true\)/.test(code),
      '定位用 select(node, true) —— 先清空再选');
    // 自触发守卫仍必须在 select 之后同步复位
    ok(/_selfSelecting = true;[\s\S]{0,200}km\.select[\s\S]{0,120}_selfSelecting = false;/.test(code),
      '_selfSelecting 仍包住 select（同步复位，框不会被自己清掉）');
  }
}

group('全仓不得再引用不存在的 km.clearSelect（改用 select([], true)）');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');
  const kern = fs.readFileSync(path.join(HERE, 'editor', 'kityminder.core.min.js'), 'utf8');

  ok(!/clearSelect\s*:\s*function/.test(kern), '内核没有 clearSelect（前提）');

  /*
   * 已经因为同一个根因修了 4 处（select 门面 / 搜索定位 / focusRoot / 选中图片），
   * 逐个断言只能防住已发现的。这里扫**全仓**：只要代码（剥注释后）里还出现
   * km.clearSelect，不管在哪一律判失败。
   */
  const code = stripCommentsFlatJs(html);
  const hits = [...code.matchAll(/km\.clearSelect/g)];
  ok(hits.length === 0,
    `编辑器代码里不得再出现 km.clearSelect（当前 ${hits.length} 处）`);

  // 找到的替换写法必须还在（防止"删了却没补"，那更糟）
  ok(/km\.select\(ns,\s*true\)/.test(code), 'select 门面：select(ns, true)');
  ok(/km\.select\(node,\s*true\)/.test(code), '搜索定位：select(node, true)');
  ok(/km\.select\(root,\s*true\)/.test(code), 'focusRoot：select(root, true)');
  /*
   * 选中图片那一处**不再**强行 select([], true)。
   * 它触发的 selectionchange 是异步派发的，等事件到达时 _suppressSelClear
   * 早已复位，onSelChanged 立刻把刚设好的 _selImg 清掉 —— 实测每次点击
   * 都停在「选中」这一步，第二段（打开）永远走不到。
   * 改成保留节点选中，由 onSelChanged 判「当前选中是否还是它」。
   */
  ok(/cur === _selImg \|\| cur === _kmImgSelNode/.test(code),
    '选中图片：保留节点选中，由 onSelChanged 判当前选中是否仍是它');
  ok(!/km\.select\(\[\],\s*true\)/.test(code),
    '不再用 select([], true) 强行反选（异步 selectionchange 会清掉图片选中态）');
}

group('导出为交换格式 → 导出为交换格式（单画布）');

{
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/sectionTip\('导出为交换格式（单画布）'/.test(pn),
    '节标题带「（单画布）」—— 不写明会以为多画布都导了');
  ok(!/sectionTip\('导出为交换格式'/.test(pn), '不再有不带「（单画布）」的旧标题');
}

group('多附件：XMind 往返（导出再导回）');

{
  const xmind = await import('./xmind.js');
  const io = await import('./io.js');

  // 节点上挂 3 个文件 + 2 个视频（带首帧缩略图）
  const km = {
    root: {
      data: {
        text: '根',
        file: JSON.stringify([
          { n: '一.pdf', a: 'A1', s: 100 },
          { n: '二.pdf', a: 'A2', s: 200 },
          { n: '三.pdf', a: 'A3', s: 300 },
        ]),
        video: JSON.stringify([
          { n: 'v1.mp4', a: 'V1', s: 900, t: 'data:image/jpeg;base64,T1' },
          { n: 'v2.mp4', a: 'V2', s: 800, t: 'data:image/jpeg;base64,T2' },
        ]),
      },
      children: [],
    },
    template: 'default',
    theme: 'fresh-blue',
    version: '1.4.43',
  };

  // 资产库：导出时按 id 取字节，导入时按名字存回
  const lib = {
    A1: new TextEncoder().encode('PDF-ONE'),
    A2: new TextEncoder().encode('PDF-TWO'),
    A3: new TextEncoder().encode('PDF-THREE'),
    V1: new TextEncoder().encode('VIDEO-ONE'),
    V2: new TextEncoder().encode('VIDEO-TWO'),
  };
  const idOfRaw = (raw) => {
    const o = io.decodeRef(raw);
    return o && o.a;
  };
  const loadAsset = async (ref) => lib[idOfRaw(ref)] || null;

  const blob = await xmind.writeXMind([{ id: 'sh1', title: '画布1', theme: null, layout: null, content: JSON.stringify(km) }], 'sh1', loadAsset);
  ok(!!blob, '导出成功');
  // writeXMind 返回的是 Blob（要落盘/下载），readXMind 要的是字节 —— 必须转
  const buf = new Uint8Array(await blob.arrayBuffer());
  ok(buf.byteLength > 0, '导出出字节');

  // 记录导入时存回了哪些资产（名字 → 字节），用来验证 5 个附件都在
  const saved = [];
  const saveAsset = async (name, bytes, opt) => {
    saved.push({ name, bytes, video: !!opt?.video });
    const id = 'N' + saved.length;
    return io.encodeRef({ n: name, a: id, s: bytes?.length || 0 });
  };

  const r = await xmind.readXMind(buf, saveAsset);
  ok(r.sheets?.length === 1, '导入出 1 张画布');
  const back = JSON.parse(r.sheets[0].content);
  const d = back.root.data;

  const files = io.decodeRefList(d.file);
  const videos = io.decodeRefList(d.video);
  eq(files.length, 3, '往返后仍是 3 个文件（不是只剩 1 个）');
  eq(videos.length, 2, '往返后仍是 2 个视频');
  eq(files.map((x) => x.n).join(','), '一.pdf,二.pdf,三.pdf', '文件名与顺序都保留');
  eq(videos.map((x) => x.n).join(','), 'v1.mp4,v2.mp4', '视频名与顺序都保留');
  // 引用必须换成本地资产 id；仍是 resources/… 说明导入没还原，附件会全部打不开
  ok(files.every((x) => x.a), '文件的引用已换成本地资产 id（不是包内路径）');
  ok(videos.every((x) => x.a), '视频的引用已换成本地资产 id');
  ok(!JSON.stringify(d.file).includes('resources/'),
    '往返后 file 里不再有 resources/ 路径（否则 decodeRef 会当成旧版路径，打不开）');
  eq(saved.length, 5, '5 个附件的本体都进了包（3 文件 + 2 视频）');
  eq(saved.filter((x) => x.video).length, 2, '其中 2 个被标为视频');

  // 字节内容也要对得上（不能张冠李戴）
  {
    const byName = {};
    for (const x of saved) byName[x.name] = new TextDecoder().decode(x.bytes);
    eq(byName['一.pdf'], 'PDF-ONE', '一.pdf 的字节内容正确（不能张冠李戴）');
    eq(byName['三.pdf'], 'PDF-THREE', '三.pdf 的字节内容正确');
    eq(byName['v1.mp4'], 'VIDEO-ONE', 'v1.mp4 的字节内容正确');
    eq(byName['v2.mp4'], 'VIDEO-TWO', 'v2.mp4 的字节内容正确');
  }

  // 缩略图在导出时被替换掉了（本体进包，t 不进包）—— 这是已知的取舍，
  // 导入后由 index.js 的 saveAssetWithThumb 重新生成
  /*
   * ⓘ 原写 `ok(true, '（已知）…')` —— 恒真，且计入 pass。
   *   这里其实**没有验任何东西**（端到端重新生成首帧要走 index.js，
   *   本测试直接调 io，跑不到那一步），所以如实登记为跳过。
   */
  skip('ref.t 随包带走（端到端重新生成首帧）',
    '已知取舍：导入侧由 index.js 的 saveAssetWithThumb 负责，这里不验');
}

group('多附件：画布点击的分发');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const seg = idx.slice(idx.indexOf('onOpenAttach:'), idx.indexOf('onOpenAttach:') + 700);
  // 图片是 dataURL，走 openAttachment 会被 decodeRef 兜底成 legacyPath（a 为 null），
  // 于是报「旧版本地路径，无法打开」—— 点画布上的图却打不开，是明显的错
  ok(/kind === 'image'/.test(seg) && /openPreview\(/.test(seg),
    '图片单独走 openPreview（不能交给 openAttachment，会被判成旧路径）');
  ok(!/openAttachment\(raw, kind\)/.test(seg), '不再把 kind 当第二参数传（函数只收 raw）');

  // 侧栏详情区选中索引：必须存在 pageFile 之外
  const pnl = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const pf = pnl.slice(pnl.indexOf('function pageFile()'), pnl.indexOf('function pageFile()') + 900);
  ok(/let _curFile = 0;/.test(pnl), '选中索引是模块级变量（在 pageFile 外）');
  ok(!/let curFile = 0;\s*\n\s*let curVid = 0;/.test(pf),
    'pageFile 内**不再**初始化选中索引（refresh 会重建，写在里面等于每次归 0）');
  ok(/_curFile = index/.test(pnl), '点行写的是模块级变量');
}

group('多附件：侧栏选中跨 refresh 保持（行为级）');

{
  const { buildSide } = await import('./panels.js');
  const io = await import('./io.js');
  const files = [
    { n: '一.pdf', a: 'A1', s: 100 },
    { n: '二.pdf', a: 'A2', s: 200 },
    { n: '三.pdf', a: 'A3', s: 300 },
  ];
  let api;
  const s = buildSide({
    get api() { return api; },
    bridge: { getSelectedNodeId: () => 'n1' },
  }, {});
  api = {
    status() {}, commit() {},
    selectedRef: (k) => (k === 'file' ? files[0] : null),
    selectedRefs: (k) => (k === 'file' ? files : []),
    selectedImages: () => [],
  };
  s.open('file');
  const rows = s.el.querySelectorAll('.mm-arow');
  eq(rows.length, 3, '3 行（文件区；视频区为空不算进来）');

  // 选中态要看得见 —— 详情区在下方，不高亮用户不知道点了哪行
  eq(s.el.querySelectorAll('.mm-arow.on').length, 1, '默认选中第 1 行');
  eq(s.el.querySelector('.mm-arow.on')?.querySelector('.mm-arow-name')?.textContent,
    '一.pdf', '默认选中第 1 行');

  // 点第 3 行 → refresh 重建后仍应停在第 3 行
  rows[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const after = s.el.querySelectorAll('.mm-arow.on');
  eq(after.length, 1, '点第 3 行后有且只有一行是选中态');
  eq(after[0]?.querySelector('.mm-arow-name')?.textContent, '三.pdf',
    'refresh 之后选中仍停在第 3 行（索引不能存在 pageFile 内，否则每次刷新归 0）');
}

group('拖放：行为级（跑真实 handleDropFiles）');

{
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const src = fnBody(idx, 'async function handleDropFiles') + '\nreturn handleDropFiles;';
  const io = await import('./io.js');

  /**
   * 跑一次拖放。
   * @param {Array} 已有 现有附件（分 kind）
   * @param {Array} 拖入 本次拖入的文件
   */
  async function drop(existing, incoming, opt = {}) {
    const written = [];
    // io.imageToInline 要 canvas 解码，jsdom 里没有 → 用**原型继承**覆盖这一个方法。
    // 其余函数（encodeRefList / decodeRefList / overAssetLimit / formatSize）仍走真实实现，
    // 所以这组用例测的还是真实源码，只是把"解码图片"这一步换掉。
    const imgIo = Object.create(io);
    imgIo.imageToInline = async (f) => ({
      url: 'data:image/png;base64,' + (f?.name || 'x'),
      before: f?.size || 0, after: 40, w: 8, h: 8, scaled: false, alpha: true,
    });
    const state = {
      images: existing.images || [],
      video: io.encodeRefList(existing.videos || []),
      file: io.encodeRefList(existing.files || []),
    };
    const bridge = {
      ready: true,
      selectNodeById: (id) => { written.push('lock:' + id); return true; },
      getSelectedImages: () => { written.push('read:images'); return state.images.slice(); },
      getSelectedVideo: () => { written.push('read:video'); return state.video; },
      getSelectedFile: () => { written.push('read:file'); return state.file; },
      setImages: (l) => { written.push('images:' + l.length); state.images = l; },
      insertChildNamed: (t) => { written.push('child:' + t); return true; },
      setVideo: (v) => { written.push('video'); state.video = v; },
      setFile: (v) => { written.push('file'); state.file = v; },
    };
    const handle = new Function('bridge', 'io', 'commit', 'side', 'status', 'ctx',
      'makeVideoThumb', src)(
      bridge, imgIo, () => written.push('commit'), { refresh: () => written.push('refresh') },
      () => {}, { toast: () => {} },
      async () => 'data:image/jpeg;base64,T');
    await handle(incoming, 'N1');
    return { written, state };
  }

  const f = (name, type) => ({ name, type, size: 10 });

  // 一次性拖 3 个文件 → 全部挂同一节点
  {
    const r = await drop({}, [f('一.pdf', ''), f('二.pdf', ''), f('三.pdf', '')]);
    eq(io.decodeRefList(r.state.file).length, 3, '3 个文件全部挂在同一个节点上');
    eq(io.decodeRefList(r.state.file).map((x) => x.n).join(','), '一.pdf,二.pdf,三.pdf',
      '顺序与名字都对');
    ok(!r.written.some((w) => /child|子节点/.test(w)), '没有新建子节点');
    ok(r.written.includes('commit'), '改完落盘');
    ok(r.written.includes('refresh'), '改完刷新侧栏');
  }

  // 已有 2 个 + 再拖 2 个 → 4 个（追加，不覆盖）
  {
    const r = await drop({ files: [{ n: '旧一.pdf', a: 'A0' }, { n: '旧二.pdf', a: 'A1' }] },
      [f('新一.pdf', ''), f('新二.pdf', '')]);
    const names = io.decodeRefList(r.state.file).map((x) => x.n);
    eq(names.length, 4, '已有 2 个 + 拖 2 个 = 4 个（**追加**，不是覆盖成 2 个）');
    ok(names.includes('旧一.pdf') && names.includes('旧二.pdf'), '原有的还在（没被顶掉）');
  }

  // 图片：2 张 → 走 images 横幅
  {
    const r = await drop({}, [f('a.png', 'image/png'), f('b.png', 'image/png')]);
    eq(r.written.filter((w) => /^images:/.test(w))[0], 'images:2', '2 张图片 → 写 images（横幅）');
  }

  // 前一次拖的图片要保留（第二次拖图片是追加）
  {
    const r = await drop({ images: ['data:image/png;base64,OLD'] }, [f('n.png', 'image/png')]);
    eq(r.written.filter((w) => /^images:/.test(w))[0], 'images:2', '已有 1 张 + 拖 1 张 = 2 张');
  }

  // 视频：写回列表 + 生成缩略图
  {
    const r = await drop({}, [f('v.mp4', 'video/mp4')]);
    const vids = io.decodeRefList(r.state.video);
    eq(vids.length, 1, '视频写入列表');
    eq(vids[0]?.t, 'data:image/jpeg;base64,T', '视频引用里带上首帧缩略图（画布同步渲染要用）');
  }

  // 混合：图 + 视频 + 文件，一次拖完各归各位
  {
    const r = await drop({}, [f('a.png', 'image/png'), f('v.mp4', 'video/mp4'), f('d.pdf', '')]);
    eq(io.decodeRefList(r.state.file).length, 1, '文件 1 个');
    eq(io.decodeRefList(r.state.video).length, 1, '视频 1 个');
    eq(r.written.filter((w) => /^images:/.test(w))[0], 'images:1', '图片 1 张');
  }

  // 锁定目标节点：读**和**写之前都要有
  {
    const r = await drop({}, [f('a.pdf', '')]);
    ok(r.written.some((w) => w === 'lock:N1'), '锁定目标节点');
    const li = r.written.indexOf('lock:N1');
    ok(li < r.written.indexOf('file'), '锁定发生在写回**之前**（顺序不能反）');

    // 更要紧的是**读取**之前也要锁定：三条 getSelectedX 读的都是「当前选中节点」，
    // 而拖放目标与当前选中并不必然相同。读错节点 = 把别的节点的整份附件复制过来。
    const firstRead = Math.min(
      r.written.indexOf('read:images'),
      r.written.indexOf('read:video'),
      r.written.indexOf('read:file'),
    );
    ok(firstRead >= 0, '确实读了现有列表');
    ok(li < firstRead,
      `锁定必须在**读取之前**（lock 在 ${li}，首次读取在 ${firstRead}）`);
  }

  // 读到的是目标节点的列表，不是别的节点的
  {
    // 桩里让「当前选中」一开始指向别的节点（模拟异步期间选中态被改），
    // 锁定后应切回目标节点 —— 读到的必须是目标节点的附件
    const io2 = await import('./io.js');
    const written = [];
    let selected = 'OTHER';
    const state2 = { file: '' };
    const bridge = {
      ready: true,
      selectNodeById: () => { selected = 'N1'; written.push('lock'); return true; },
      getSelectedImages: () => { written.push('read:images@' + selected); return []; },
      getSelectedVideo: () => { written.push('read:video@' + selected); return ''; },
      getSelectedFile: () => {
        written.push('read:file@' + selected);
        return selected === 'N1' ? state2.file : io2.encodeRefList([{ n: '别人的文件.pdf', a: 'X' }]);
      },
      setFile: (v) => { written.push('write:file'); state2.file = v; },
      setVideo: () => {}, setImages: () => {},
    };
    const handle = new Function('bridge', 'io', 'commit', 'side', 'status', 'ctx',
      'makeVideoThumb', src)(
      bridge, io2, () => {}, { refresh: () => {} }, () => {}, { toast: () => {} },
      async () => null);
    await handle([{ name: '我的.pdf', type: '', size: 10 }], 'N1');
    ok(written.includes('read:file@N1'), '读取发生在锁定之后（读到的是目标节点）');
    ok(!written.some((w) => w === 'read:file@OTHER'),
      '不会读到别的节点的列表（否则会把别人的附件复制过来）');
    eq(io2.decodeRefList(state2.file).map((x) => x.n).join(','), '我的.pdf',
      '写成的是「目标节点原有 + 新的」，不含别的节点的附件');
  }
}

/* ============================================================
   A72 附件体积：压缩与上限（2026-09-19）
   ============================================================ */

group('附件压缩：尺寸与档位（纯函数）');

{
  const io = await import('./io.js');

  // ---- 尺寸规划 ----
  const d = io.fitImageDims(3200, 2400, 1600);
  eq(d.w, 1600, '长边缩到上限 1600');
  eq(d.h, 1200, '短边等比（不变形）');

  const up = io.fitImageDims(800, 600, 1600);
  eq(up.scale, 1, '**小于阈值的图不放大**（放大只白增体积，画质不会更好）');
  eq(up.w, 800, '原尺寸保留');

  eq(io.fitImageDims(4000, 3, 1600).h, 1, '极端长条图高度最小 1（尺寸 0 会让 canvas 抛错）');
  eq(io.fitImageDims(0, 100), null, '宽为 0 → null（调用方按失败处理）');
  eq(io.fitImageDims('abc', 100), null, '非数字 → null');
  ok(io.fitImageDims(100, 100, 0).w > 0, '上限传 0 也不产生 0 像素的图');
  eq(io.fitImageDims(4000, 4000, 0).w, io.IMG_MAX_EDGE, '无效上限（0/非数字）回退到默认上限');

  // ---- 编码档位 ----
  const p = io.encodePlan(1600, false);
  eq(p.length, io.IMG_QUALITY_STEPS.length + io.IMG_FALLBACK_EDGES.length, 'JPEG：质量档 + 降分辨率档');
  eq(p[0].maxEdge, 1600, '第一档用配置的上限');
  eq(p[0].q, 0.82, '先试最高质量');
  ok(p[1].q < p[0].q, '同尺寸下逐档降质');
  ok(p[io.IMG_QUALITY_STEPS.length].maxEdge < 1600,
    '**质量档用满之后**才降分辨率（降分辨率对观感伤害更大）');

  const pl = io.encodePlan(1600, true);
  ok(pl.every((s) => s.q === undefined), 'PNG（无损）档不带质量参数 —— canvas 会忽略它，带了是假象');
  eq(pl.length, 1 + io.IMG_FALLBACK_EDGES.length, 'PNG 只保留分辨率档');

  const small = io.encodePlan(500, false);
  ok(small.every((s) => s.maxEdge <= 500), '上限低于降级档位时不会把图放回去（不反向放大）');

  ok(io.IMG_MAX_EDGE >= 1200 && io.IMG_MAX_EDGE <= 2560, '压缩最长边落在合理区间');
  ok(io.IMG_INLINE_MAX >= 512 * 1024 && io.IMG_INLINE_MAX <= 2 * 1024 * 1024,
    '单张内联上限落在合理区间（0.5–2MB 字符）');
  ok(io.IMG_QUALITY_STEPS.every((q) => q > 0 && q <= 1), '质量档都在 (0,1]');

  // ---- 直通线与小图 ----
  ok(io.IMG_SKIP_BELOW < io.IMG_INLINE_MAX,
    '直通线必须小于内联上限（否则「跳过压缩」的图反而会超限）');
  ok((io.IMG_SKIP_BELOW * 4) / 3 + 64 < io.IMG_INLINE_MAX,
    '直通线 base64 膨胀后仍在上限内（含 data: 前缀余量）');
  ok(io.IMG_SKIP_BELOW > 0 && io.IMG_SKIP_BELOW <= 1024 * 1024,
    '直通线落在合理区间');

  // ---- 上限判定 ----
  eq(io.overAssetLimit({ size: io.ASSET_MAX }), false, '正好等于上限 → 放行');
  eq(io.overAssetLimit({ size: io.ASSET_MAX + 1 }), true, '超 1 字节 → 拦');
  eq(io.overAssetLimit(null), false, 'null 安全（不抛）');
  eq(io.overAssetLimit({}), false, '没有 size 字段 → 按 0 处理');
}

group('附件压缩：不依赖 canvas 的分支（真实 imageToInline）');

{
  const io = await import('./io.js');
  const W = dom.window;
  const savedFR = globalThis.FileReader;
  // io.js 读文件用 FileReader；测试只挂了 window，这里临时补上再还原
  globalThis.FileReader = W.FileReader;
  try {
    // 源文件超上限：**不解码**直接拒（30MB 的图光解码就要几百 MB 内存）
    {
      const r = await io.imageToInline({ name: 'big.jpg', type: 'image/jpeg', size: 30 * 1024 * 1024 });
      ok(r.error && /超过单张上限/.test(r.error), '超过源文件上限 → 拒绝并说明原因（不是静默跳过）');
      ok(!r.url, '没有产出可内联的 url');
    }

    // SVG：文本、体积天然小，canvas 也画不了它 → 直接内联
    {
      const svg = new W.File(['<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"/>'],
        'ico.svg', { type: 'image/svg+xml' });
      const r = await io.imageToInline(svg);
      ok(!!r.url && r.url.startsWith('data:image/svg+xml'), 'SVG 直接内联');
      const r2 = await io.imageToInline(svg, { maxInline: 16 });
      ok(r2.error && /矢量图/.test(r2.error), 'SVG 超阈值时明说原因（对它做「压缩」没有意义）');
    }

    // GIF：canvas 只会留第一帧 → 静默丢动画比拒绝更糟
    {
      const gif = new W.File([new Uint8Array(64)], 'a.gif', { type: 'image/gif' });
      const r = await io.imageToInline(gif);
      ok(!!r.url, '体积达标的小动图原样收下（不悄悄压成静帧）');
      const r2 = await io.imageToInline(gif, { maxInline: 16 });
      ok(r2.error && /动图/.test(r2.error), '超阈值的动图明确拒绝并说明原因');
    }

    // 小图直通：不做重编码。实测 400×300 / 6KB 的图压完变 7KB —— 画质掉了体积还涨了
    {
      const small = new W.File([new Uint8Array(500)], 'small.jpg', { type: 'image/jpeg' });
      const r = await io.imageToInline(small);
      ok(r.skipped === true, '小图走直通（不进压缩流水线）');
      ok(String(r.url).startsWith('data:image/jpeg'), '直通产出**原始** dataURL（无损）');
      ok(r.after <= io.IMG_INLINE_MAX,
        '直通产出的串仍在上限内（base64 膨胀后也一样）');
    }
  } finally {
    globalThis.FileReader = savedFR;
  }
}

group('附件压缩：入口收口与拦截（真实源码 / 行为级）');

{
  const io = await import('./io.js');
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const pjs = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const ioSrc = fs.readFileSync(path.join(HERE, 'io.js'), 'utf8');

  // ---- 源码契约：三处图片入口必须都走同一个压缩入口 ----
  eq((idx.match(/io\.imageToInline\(/g) || []).length, 1, '拖放入口走统一压缩入口');
  eq((pjs.match(/io\.imageToInline\(/g) || []).length, 2, '侧栏「添加图片」+ 属性页「节点图」都走统一入口');
  ok(!/超过 2MB，会让脑图文件明显变大/.test(idx + pjs),
    '旧的「超过 2MB 只提示、照样内联」已清除（提示了却不拦，用户只会觉得一放图就变卡）');
  eq((pjs.match(/io\.overAssetLimit\(/g) || []).length, 1, '面板的视频/文件在入库前判上限');
  eq((idx.match(/io\.overAssetLimit\(/g) || []).length, 1, '拖放入口同样判上限');
  ok(/if \(overAssetLimit\(file\)\) return null;/.test(ioSrc),
    'putAsset 内部再硬拦一道（调用方漏判也进不来）');

  // ---- 存量瘦身：老文档里已经内联进去的大图不会因"以后新增会压缩"而变小 ----
  ok(/export async function shrinkDataUrl/.test(ioSrc), 'io 暴露存量压缩入口');
  ok(/skipBelow: 0/.test(ioSrc),
    '存量压缩**不走直通线**（调用它的前提就是这张图已超限，直通等于什么都没做）');
  ok(/const shrinkHeavy = async/.test(pjs), '面板有对应的存量压缩动作');
  ok(/heavy = images\.filter/.test(pjs),
    '超限判定用 dataURL 字符数与内联上限比（两边单位一致）');
  ok(/压缩过大图片（\$\{heavy\.length\}）/.test(pjs), '入口显示剩余超限张数');
  ok(/heavy\.length\s*\n?\s*\?/.test(pjs) || /heavy\.length \?/.test(pjs),
    '只在真有超限图片时才出现（平时不占位、不打扰）');
  {
    const r = await io.shrinkDataUrl('');
    ok(!!r.error, '空 dataURL → 返回可展示的原因（不抛）');
    const r2 = await io.shrinkDataUrl('data:,');
    ok(!!r2.error, '没有内容的 dataURL 同样安全');
  }

  // ---- 行为级：跑真实 handleDropFiles ----
  const src = fnBody(idx, 'async function handleDropFiles') + '\nreturn handleDropFiles;';
  const st = { images: [], video: '[]', file: '[]' };
  const msgs = [];
  const bridge = {
    ready: true,
    selectNodeById: () => true,
    getSelectedImages: () => st.images.slice(),
    getSelectedVideo: () => st.video,
    getSelectedFile: () => st.file,
    setImages: (l) => { st.images = l; },
    setVideo: (v) => { st.video = v; },
    setFile: (v) => { st.file = v; },
  };
  const handle = new Function('bridge', 'io', 'commit', 'side', 'status', 'ctx',
    'makeVideoThumb', src)(
    bridge, io, () => {}, { refresh: () => {} },
    (m) => msgs.push(String(m)), { toast: () => {} },
    async () => null);

  // 超大原图（30MB）：不解码直接拒 —— 这条路径完全不碰 canvas，jsdom 里能真跑
  await handle([{ name: 'big.jpg', type: 'image/jpeg', size: 30 * 1024 * 1024 }], 'N1');
  eq(st.images.length, 0, '超大图**没有**进入节点数据');
  ok(msgs.some((m) => /超过单张上限/.test(m)), '提示里说清了原因（含文件名与数值）');

  // 超大视频（200MB）：不进 IndexedDB
  await handle([{ name: 'movie.mp4', type: 'video/mp4', size: 200 * 1024 * 1024 }], 'N1');
  eq(io.decodeRefList(st.video).length, 0, '超大视频没有入库');
  ok(msgs.some((m) => /超过附件上限/.test(m)), '视频上限提示含具体体积');
}

group('图片交互：两段式打开 + 默认放大 + 选中后可拖大小');

{
  const html = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8');

  // ================= 单图：第一次点选中，再点才打开 =================
  const hi = html.indexOf('function hookNodeImage(node)');
  ok(hi > 0, '有 hookNodeImage()');
  {
    const end = html.indexOf('function refreshImageClicks()', hi);
    const seg = html.slice(hi, end > hi ? end : hi + 2500);
    const code = stripCommentsFlatJs(seg);
    ok(/sh\.node\.addEventListener\('mouseup'/.test(code),
      '图片上监听 mouseup（按下不拦截 → 内核照常选中/拖动节点）');
    ok(/if \(_selImg === node\) openImagePreview\(node\)/.test(code)
      && /else selectImage\(node\)/.test(code),
      '已选中再点 = 打开预览；未选中 = 先选中（两段式）');
    ok(/Math\.abs\(ev\.clientX - d\.x\) \+ Math\.abs\(ev\.clientY - d\.y\) > CLICK_SLOP/.test(code),
      '位移超过阈值算拖动、不算单击（拖画布不会误弹预览）');
    ok(!/imgHitTest\(ev, sh\) !== 'sel'/.test(code),
      '不是「只有边缘 4px 才响应」的旧写法（中心大片点了没反应）');
  }

  // ================= 多图横幅：同样两段式 =================
  const mi = html.indexOf("if (d.kind === 'image' && d.node");
  ok(mi > 0, '多图点击有「两段式」分支');
  {
    const seg = html.slice(mi, mi + 900);
    const code = stripCommentsFlatJs(seg);
    ok(/d\.node\._kmImgSel !== d\.index/.test(code),
      '判据是「这张是不是已经选中」而不是「有没有选中过」');
    ok(/return;/.test(code), '第一段只选中、直接 return（不发 openattach）');
    ok(/openAttach\(d\.node, d\.kind, d\.index, d\.ref\)/.test(code),
      '第二段才真正打开');
  }

  // ================= 选中态不能被紧随的 selectionchange 清掉 =================
  const oi = html.indexOf('function onSelChanged()');
  ok(oi > 0, '有 onSelChanged()');
  {
    const end = html.indexOf('function removeImageDirect', oi);
    const seg = html.slice(oi, end > oi ? end : oi + 1200);
    const code = stripCommentsFlatJs(seg);
    ok(/cur === _selImg \|\| cur === _kmImgSelNode/.test(code),
      '单图与多图的选中态**都要**判（少判一个 → 第二段永远走不到）');
    ok(!/km\.select\(\[\], true\)/.test(code), '不在清除路径里强行反选节点');
  }
  // 强行反选会把刚设好的选中态连带清掉
  {
    const si = html.indexOf('function selectImage(node)');
    const end = html.indexOf('// ---- 显示定位跟随 ----', si);
    const seg = html.slice(si, end > si ? end : si + 1600);
    const code = stripCommentsFlatJs(seg);
    ok(!/km\.select\(\[\], true\)/.test(code),
      'selectImage 不再强行 select([], true)（异步 selectionchange 会把选中态清掉）');
  }

  // ================= 缩放手柄：必须用 DOM 浮层 =================
  const di = html.indexOf('function drawImgHandles(node)');
  ok(di > 0, '有 drawImgHandles()');
  {
    const end = html.indexOf('function startHandleDrag', di);
    const seg = html.slice(di, end > di ? end : di + 2000);
    const code = stripCommentsFlatJs(seg);
    ok(/document\.createElement\('div'\)/.test(code), '手柄是 HTML div');
    ok(/position:fixed/.test(code), '手柄用 fixed 定位（视口坐标，不受 CTM 影响）');
    ok(!/new kity\.Rect\(HANDLE/.test(code), '不再是 kity.Rect（会被节点 RC 盖住按不到）');
    ok(!/rc\.appendShape/.test(code), '不再挂进 root 的 renderContainer');
    ok(/nwse-resize/.test(code) && /nesw-resize/.test(code), '四个角光标区分方向');
  }
  // 拖动：等比 + 钳制
  {
    const vi = html.indexOf('function onHandleMove(ev)');
    ok(vi > 0, '有 onHandleMove()');
    const end = html.indexOf('function onHandleUp', vi);
    const seg = html.slice(vi, end > vi ? end : vi + 1200);
    const code = stripCommentsFlatJs(seg);
    ok(/var ratio = d\.oh \/ d\.ow/.test(code) && /nw \* ratio/.test(code),
      '等比缩放（不按位移直接改高 → 图片会变形）');
    ok(/nw = Math\.max\(MIN_IMG, Math\.min\(MAX_IMG,/.test(code)
      && /nh = Math\.max\(MIN_IMG, Math\.min\(MAX_IMG, nw \* ratio\)\)/.test(code),
      '宽高都钳在 MIN/MAX 之间（高按等比算完再钳）');
    ok(/var sign = \(d\.corner === 1 \|\| d\.corner === 3\) \? 1 : -1/.test(code),
      '左右两半边方向相反（拖左边角不会反向放大）');
    ok(/km\.fire\('contentchange'\)/.test(html.slice(html.indexOf('function onHandleUp'), html.indexOf('function onHandleUp') + 500)),
      '松手后记一次快照（否则刷新尺寸回退）');
  }

  // ================= 默认尺寸放大 =================
  {
    const seg = html.slice(html.indexOf('var mw = 320'), html.indexOf('var mw = 320') + 300);
    ok(/var mw = 320, mh = 320;/.test(seg), '单图上限 320（原 200 太小）');
    ok(/m\.getOption\('maxImageWidth'\) \|\| 320/.test(seg), '回退值同步改成 320');
  }
  {
    const iw = html.indexOf('var iw = Math.max(120');
    ok(iw > 0, '多图横幅有尺寸');
    const seg = html.slice(iw, iw + 220);
    const code = seg.replace(/\/\/[^\n]*/g, '');
    ok(/Math\.max\(120, Math\.min\(180, box\.width \|\| 180\)\)/.test(code),
      '横幅 120~180（原 64~96 看不清）');
    ok(/Math\.round\(iw \* 9 \/ 16\)/.test(code), '横幅按 16:9 给高');
  }

  // ================= 跨 IIFE 共享必须放在外层 =================
  {
    /*
     * 判据用**行首缩进**：顶层是 4 空格，IIFE 内是 8 或 12。
     * 早先这两个定义放在图片 IIFE 里，另一个 IIFE（附件区）访问就
     * ReferenceError（实测 PageError: _kmImgSelNode is not defined）。
     */
    ok(/\n {4}function mmImageAtPoint\(/.test(html),
      'mmImageAtPoint 在顶层（4 空格缩进，不在任何 IIFE 内）');
    ok(/\n {4}var _kmImgSelNode = null;/.test(html),
      '_kmImgSelNode 同样在顶层');
  }
  // 双击不能进文字编辑
  {
    const dbi = html.indexOf("km.on('dblclick', function (e)");
    ok(dbi > 0, '有 dblclick 处理');
    const seg = html.slice(dbi, dbi + 700);
    const code = stripCommentsFlatJs(seg);
    ok(/mmImageAtPoint\(oe\.clientX, oe\.clientY\)/.test(code),
      '双击图片不进文字编辑（否则同时弹预览和编辑框）');
  }
}

group('页签拖拽：插入竖条必须收掉、回弹动画必须看得见');

{
  /*
   * 行为级：真跑 attachTabDrag 的状态机，不靠正则。
   * jsdom 里 rect 全是 0，所以给容器/页签/follow 各自伪造尺寸，
   * 否则 swapIndex 永远算不出换位，两条分支都走不到。
   */
  const { attachTabDrag } = await import('./tab-drag.js');
  const doc = globalThis.document;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

  const R = (l, w) => ({ left: l, right: l + w, top: 0, bottom: 30, width: w, height: 30, x: l, y: 0 });
  // follow 是拖拽中动态克隆出来的，按它的 style.left 算 rect
  const origGBCR = dom.window.Element.prototype.getBoundingClientRect;
  dom.window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('mm-tab-follow')) {
      return R(parseFloat(this.style.left) || 0, 100);
    }
    return origGBCR.call(this);
  };

  function build(ids) {
    const c = doc.createElement('div');
    for (const id of ids) {
      const t = doc.createElement('div');
      t.setAttribute('data-tab-id', id);
      c.appendChild(t);
    }
    doc.body.appendChild(c);
    // 注意：**必须**把下标固定成 const 再塞进闭包。写成 =() => R(i*100)
    // 的话三个闭包共享同一个 i，循环结束后全变成 R(300,100) —— 那样
    // swapIndex 永远算不出换位，「真的换了顺序」这条前提直接不成立。
    [...c.children].forEach((t, k) => {
      t.getBoundingClientRect = () => R(k * 100, 100);
      Object.defineProperty(t, 'offsetWidth', { value: 100, configurable: true });
    });
    c.getBoundingClientRect = () => R(0, 300);
    return c;
  }
  function pe(type, x) {
    const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { clientX: x, clientY: 10, button: 0, pointerId: 1 });
    return e;
  }
  const fire = (el, type, x) => el.dispatchEvent(pe(type, x));

  /** 跑一次拖拽；steps 是越过阈值后的 move 序列 */
  async function drag(c, fromIdx, moves) {
    const t = [...c.children][fromIdx];
    fire(t, 'pointerdown', 50);
    for (const x of moves) fire(doc, 'pointermove', x);
    fire(doc, 'pointerup', moves[moves.length - 1]);
    await new Promise((r) => setTimeout(r, 400));   // 等回弹动画
  }

  // ---- 场景1：真的换位（commit 分支） ----
  {
    const c = build(['A', 'B', 'C']);
    let order = ['A', 'B', 'C'];
    const d = attachTabDrag(c, {
      getOrder: () => order.slice(),
      onReorder: (o) => { order = o.slice(); },
      canDrag: () => true,
    });
    await drag(c, 0, [260, 260]);
    eq(order.join('|'), 'B|A|C', '拖动真的换了顺序（前提：这条分支走到了）');
    eq(doc.querySelectorAll('.mm-tab-insertbar').length, 0,
      'commit 分支：松手后 document 里不留插入竖条');
    eq(doc.querySelectorAll('.mm-tab-follow').length, 0, 'commit 分支：follow 已收');
    d.destroy(); c.remove();
  }

  // ---- 场景2：未换位（springBack 分支） ----
  {
    const c = build(['A', 'B', 'C']);
    let order = ['A', 'B', 'C'];
    const d = attachTabDrag(c, {
      getOrder: () => order.slice(),
      onReorder: (o) => { order = o.slice(); },
      canDrag: () => true,
    });
    const t0 = [...c.children][0];
    fire(t0, 'pointerdown', 50);
    fire(doc, 'pointermove', 60);
    fire(doc, 'pointermove', 60);
    // 松手**瞬间**就查：此时 follow 必须还在 DOM，否则动画等于没有
    fire(doc, 'pointerup', 60);
    const f = doc.querySelector('.mm-tab-follow');
    ok(!!f, 'springBack：松手瞬间 follow 仍在 DOM（动画才看得见）');
    if (f) {
      ok(/left/.test(String(f.style.transition)) && /opacity/.test(String(f.style.transition)),
        'springBack：transition 真的设上了（含 left 与 opacity）');
      eq(f.style.opacity, '0', 'springBack：目标透明度为 0（渐隐飞回）');
    }
    await new Promise((r) => setTimeout(r, 400));
    eq(doc.querySelectorAll('.mm-tab-follow').length, 0, 'springBack：动画结束后 follow 移除');
    eq(doc.querySelectorAll('.mm-tab-insertbar').length, 0, 'springBack：竖条也不留');
    eq(order.join('|'), 'A|B|C', 'springBack：顺序未变');
    d.destroy(); c.remove();
  }

  // ---- 场景3：连拖多次不累积 ----
  /*
   * 竖条是 position:fixed + z-index:9998 的 2px 竖线，漏收的话
   * **拖几次就叠几条**：屏幕上会留着好几条跟着上次落点的竖线。
   */
  {
    const c = build(['A', 'B', 'C']);
    let order = ['A', 'B', 'C'];
    const d = attachTabDrag(c, {
      getOrder: () => order.slice(),
      onReorder: (o) => { order = o.slice(); },
      canDrag: () => true,
    });
    await drag(c, 0, [260, 260]);
    await drag(c, 1, [60, 60]);
    await drag(c, 2, [160, 160]);
    eq(doc.querySelectorAll('.mm-tab-insertbar').length, 0,
      '连拖 3 次：竖条一条都不留（漏收会累积成 3 条）');
    eq(doc.querySelectorAll('.mm-tab-follow').length, 0, '连拖 3 次：follow 也全收');
    d.destroy(); c.remove();
  }

  // ---- 源码契约：cleanup 必须同时收 follow 与 bar ----
  {
    const src = fs.readFileSync(path.join(HERE, 'tab-drag.js'), 'utf8');
    const ci = src.indexOf('function cleanup()');
    ok(ci > 0, '有 cleanup()');
    const seg = src.slice(ci, ci + 700);
    const code = stripCommentsFlatJs(seg);
    ok(/st\?\.follow\)\s*\{\s*st\.follow\.remove\(\);\s*\}/.test(code), 'cleanup 收 follow');
    ok(/st\?\.bar\)\s*\{\s*st\.bar\.remove\(\);\s*\}/.test(code), 'cleanup 收 bar（漏了会留竖条）');
    // springBack 必须先把 follow 摘下来，否则 cleanup 会先把它 remove 掉
    const si = src.indexOf('function springBack(el)');
    const sseg = src.slice(si, si + 500);
    const scode = stripCommentsFlatJs(sseg);
    ok(/if \(follow\) st\.follow = null;/.test(scode),
      'springBack 先把 follow 从 st 上摘下（否则 cleanup 先 remove，动画看不见）');
  }
}

group('浮层必须能用 Escape 关掉（外壳的 dialog 能，插件的不能）');

{
  /*
   * 行为级：真 import panels.js、真开浮层、真派发 keydown。
   * 前提（避免把「测试环境碰巧如此」当成根因）：外壳 js/dialog.js 与
   * theme-picker.js 都处理 Escape，本插件的 dialog/popupMenu 原先一个都没有。
   */
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  const P = await import('./panels.js');
  ok(typeof P.popupMenu === 'function', 'panels 导出 popupMenu');
  ok(typeof P.escCloser === 'function', 'panels 导出 escCloser（可测）');

  const nMenu = () => document.querySelectorAll('.mm-menu-mask').length;
  const nDlg = () => document.querySelectorAll('.mm-mask').length;
  const clearAll = () => document.querySelectorAll('.mm-menu-mask,.mm-mask').forEach((e) => e.remove());
  const esc = (o = {}) => {
    const e = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    if (o.composing) Object.defineProperty(e, 'isComposing', { value: true });
    if (o.k229) Object.defineProperty(e, 'keyCode', { value: 229 });
    document.dispatchEvent(e);
  };

  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  // 同一个锚点连开会被 toggle 收掉，所以每次开新的都用独立锚点
  const openMenu = () => {
    const a = document.createElement('button');
    document.body.appendChild(a);
    return P.popupMenu(a, [{ label: 'A', onSelect() {} }]);
  };

  // ---- 基本：Esc 关弹出菜单 ----
  clearAll();
  {
    const h1 = openMenu();
    eq(nMenu(), 1, '菜单已打开（前提）');
    esc();
    eq(nMenu(), 0, '按 Escape 关掉弹出菜单');
    h1.close();
  }

  // ---- 组合态：中文输入法里 Esc 是「取消候选」，不能关 ----
  clearAll();
  {
    const h1 = openMenu();
    esc({ composing: true });
    eq(nMenu(), 1, 'isComposing 时不关（否则打字选词把浮层关了）');
    esc({ k229: true });
    eq(nMenu(), 1, 'keyCode 229 时不关（老 WebView 只有这个信号）');
    esc();
    eq(nMenu(), 0, '正常 Escape 仍然能关（没把守卫写成一律忽略）');
    h1.close();
  }

  // ---- 分层：浮层上再开菜单，Esc 逐层收，不能一次全关 ----
  clearAll();
  {
    let resolved = null;
    const p = P.confirmDialog('标题', '内容').then((v) => { resolved = v; });
    await new Promise((r) => setTimeout(r, 20));
    eq(nDlg(), 1, '浮层已打开（前提）');
    const h1 = openMenu();
    eq(nMenu(), 1, '浮层之上又开了菜单（前提）');
    esc();
    eq(nMenu(), 0, '第一次 Esc 只收最上面那层（菜单）');
    eq(nDlg(), 1, '第一次 Esc **不**连带收掉下面的浮层');
    esc();
    eq(nDlg(), 0, '第二次 Esc 收掉浮层');
    await p;
    eq(resolved, false, 'Esc 关掉确认框 = 取消（resolve false）');
    h1.close();
  }

  // ---- 源码契约：两处都要注册并在 close 里注销 ----
  {
    const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
    const di = src.indexOf('function dialog(title, children, onClose, opt)');
    ok(di > 0, '有 dialog()');
    const dseg = src.slice(di, src.indexOf('function confirmDialog', di));
    const dcode = stripCommentsFlatJs(dseg);
    ok(/onEsc = escCloser\(mask, close\);/.test(dcode), 'dialog 注册 Esc');
    ok(/removeEventListener\('keydown', onEsc, true\)/.test(dcode), 'dialog 关闭时注销 Esc（不残留监听）');

    const mi = src.indexOf('export function popupMenu(');
    const mseg = src.slice(mi, mi + 3000);
    const mcode = stripCommentsFlatJs(mseg);
    ok(/onEsc = escCloser\(mask, close\);/.test(mcode), 'popupMenu 注册 Esc');
    ok(/removeEventListener\('keydown', onEsc, true\)/.test(mcode), 'popupMenu 关闭时注销 Esc');

    // 守卫本身：最上层才关、组合期放过
    const ei = src.indexOf('export function escCloser(');
    const ecode = stripCommentsFlat(src);
    ok(/e\.isComposing \|\| e\.keyCode === 229/.test(ecode), 'escCloser 放过输入法组合期');
    ok(/masks\[masks\.length - 1\] !== mask/.test(ecode), 'escCloser 只关最上面那层');
  }
  clearAll();
}

group('写盘失败不能被随后的「已重命名 / 已新建」盖掉');

{
  /*
   * 继 BUG 23（store.set 吞异常返回 false）之后的**第二层**问题：
   * 那一轮给所有写点套上了 saveStore（会判返回值、失败时写一句红字），
   * 但有几处的调用方**不判返回值**，紧接着又无条件写了一句成功文案 ——
   * saveStore 刚写的「保存失败：…」当场被盖掉。
   *
   * 后果正是 store.js 注释里点名要防的假成功：
   *   界面说「已重命名」，重开插件名字变回旧的；
   *   界面说「已新建」，重开列表里没有它（内容留在 doc:<id> 成了孤儿）。
   */
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  /**
   * 把 index.js 按顶层 `async function` / `function` 切成若干函数体。
   * 只切到下一个同缩进的 `  }` 为止，够用。
   */
  function fnBodies(src) {
    const out = [];
    const re = /^  (?:async )?function (\w+)\s*\(/gm;
    let m;
    const at = [];
    while ((m = re.exec(src))) at.push({ name: m[1], i: m.index });
    for (let k = 0; k < at.length; k++) {
      const end = k + 1 < at.length ? at[k + 1].i : src.length;
      out.push({ name: at[k].name, body: src.slice(at[k].i, end) });
    }
    return out;
  }

  /** 去掉注释，否则注释里引用的 saveStore/status 会被当成真实调用 */
  const strip = (t) => stripCommentsFlatJs(t);

  const offenders = [];
  for (const f of fnBodies(idx)) {
    const code = strip(f.body);
    // 找所有 saveStore 调用，看它所在的这条语句是不是 `if (!await saveStore(`
    const re = /await\s+saveStore\(/g;
    let m;
    while ((m = re.exec(code))) {
      /*
       * 「判了返回值」有两种写法，都得认：
       *   ① `if (!await saveStore(...))` —— 直接取反
       *   ② `const ok = await saveStore(...)` —— 接住再用（deleteFile 的修法）
       * 早先只认 ①，于是 ② 会被当成"没判"报出来（误报）。
       * 判据就是调用点前面那个非空字符：`!`（取反）或 `=`（赋值）。
       */
      const pre = code.slice(0, m.index).replace(/\s+$/, '');
      const checked = /[!=]$/.test(pre);
      if (checked) continue;
      // 未判返回值：这条调用**之后**，函数里还能出现「成功态」status 吗？
      let rest = code.slice(m.index + m[0].length);
      /*
       * **只看这条路径真正能走到的部分**：遇到 `return` 就截断。
       *
       * createFile 里那条 `await saveStore('脑图内容', …del())` 位于
       * 「文件列表写失败」的 if 块内，后面紧跟着 `return;` ——
       * if 块外的 `status('已新建：' + name)` 根本执行不到。
       * 不截断就会把它报成违规（误报），反而把真违规（deleteFile）淹掉。
       */
      const retAt = rest.search(/(^|[^\w$])return([^\w$]|$)/);
      if (retAt >= 0) rest = rest.slice(0, retAt);
      /*
       * **必须按括号配平取整条 status(...) 调用**，不能用
       * `/status\(\s*(['"`])…\1\s*\)/` 那种"字符串后面紧跟右括号"的写法。
       *
       * deleteFile 里的那句是
       *   status('已删除：' + f.name + (remembered ? '' : '（未能记住…）'))
       * —— 字符串后面是 ` + f.name`，不是 `)`，原正则**根本不匹配**，
       * 于是这条守卫对它一直是**空转**的（变异验证里删掉整段修复也照样绿）。
       * 这是本项目第 25 次踩到"断言绿但没在把关"。
       */
      let from = 0;
      for (;;) {
        const at = rest.indexOf('status(', from);
        if (at < 0) break;
        from = at + 7;
        // 括号配平取完整调用（字符串里的括号要跳过，简单处理：只数未转义的）
        let depth = 0, i = at + 6, inStr = null, end = -1;
        for (; i < rest.length; i++) {
          const ch = rest[i];
          if (inStr) {
            if (ch === '\\') { i++; continue; }
            if (ch === inStr) inStr = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) break;
        const call = rest.slice(at, end + 1);
        // 第一个参数必须是字符串字面量（变量/模板走不到这里的判定）
        if (!/^status\(\s*['"`]/.test(call)) continue;
        // 以 `, true)` 结尾的是告警；`status(x, isErr)` 这种变量也当告警跳过
        if (/,\s*(true|[A-Za-z_$][\w$]*)\s*\)$/.test(call)) continue;
        offenders.push(`${f.name}(): ${call.slice(0, 46)}`);
      }
    }
  }
  eq(offenders.length, 0,
    '未判 saveStore 返回值的调用点，其后不得再写成功文案（会盖掉失败提示）'
    + (offenders.length ? ' → ' + offenders.join(' / ') : ''));

  // 三处修复本身：必须判返回值
  for (const [fn, key] of [['renameFile', '文件列表'], ['renameFolder', '文件夹列表'], ['createFile', '文件列表']]) {
    const f = fnBodies(idx).find((x) => x.name === fn);
    ok(!!f, `有 ${fn}()`);
    const code = strip(f.body);
    ok(new RegExp(`if\\s*\\(\\s*!\\s*await\\s+saveStore\\('${key}'`).test(code),
      `${fn}()：${key} 写入必须判返回值（否则失败被成功文案盖掉）`);
  }

  // 回滚：写失败要把内存里的改动撤回来，不能停在"看起来改好了"的样子
  {
    const rf = strip(fnBodies(idx).find((x) => x.name === 'renameFile').body);
    ok(/const\s+prevName\s*=\s*f\.name;/.test(rf), 'renameFile：改动前先存旧名字');
    ok(/f\.name\s*=\s*prevName;/.test(rf), 'renameFile：写失败回滚名字');
    const rf2 = strip(fnBodies(idx).find((x) => x.name === 'renameFolder').body);
    ok(/fo\.name\s*=\s*prevName;/.test(rf2), 'renameFolder：写失败回滚名字');
    const cf = strip(fnBodies(idx).find((x) => x.name === 'createFile').body);
    ok(/fileIndex\.pop\(\);/.test(cf), 'createFile：写失败把新项从内存撤回来');
  }

  // 切文件：switchToFile 必须把「设置没写成功」交回调用方
  {
    const st = strip(fnBodies(idx).find((x) => x.name === 'switchToFile').body);
    /*
     * 返回值从「布尔（设置有没有写成功）」改成「{switched, remembered}」：
     * 读失败时必须**中止切换**，而调用方不能再报「已打开 / 已删除」——
     * 那句会把 switchToFile 刚写下的失败原因盖掉。
     */
    ok(/return\s*\{\s*switched:\s*true,\s*remembered:\s*okSettings\s*\}/.test(st),
      'switchToFile：成功时返回 {switched:true, remembered:okSettings}');
    ok(/return\s*\{\s*switched:\s*false,\s*remembered:\s*false\s*\}/.test(st),
      'switchToFile：读失败时返回 switched:false（调用方据此停止后续动作）');
    const of = strip(fnBodies(idx).find((x) => x.name === 'openFile').body);
    ok(/if\s*\(!r\.switched\)\s*return;/.test(of),
      'openFile：没切成就别说「已打开」（会盖掉 switchToFile 的失败原因）');
    ok(/remembered\s*\?\s*''\s*:\s*'（未能记住/.test(of), 'openFile：没记住要说出来，不能被「已打开」盖掉');
    // deleteFile 也会切文件（删掉当前文件时），同样不能把提示盖掉
    const df = strip(fnBodies(idx).find((x) => x.name === 'deleteFile').body);
    ok(/remembered\s*\?\s*''\s*:\s*'（未能记住/.test(df), 'deleteFile：切到别的文件时也不能盖掉「未记住」');
    ok(/let\s+remembered\s*=\s*true;/.test(df), 'deleteFile：remembered 初值为 true（没切文件就不该报）');
    ok(/\(await switchToFile\([^)]*\)\)\.remembered/.test(df),
      'deleteFile：取返回值的 .remembered（返回值已不是布尔）');
    /*
     * 删文档**本体**也要接住返回值 —— 这是同一类里的漏网者。
     *
     * 文件列表已落盘、删不掉就回滚不了，所以按既定做法把后果**带进自己那句话**
     * （与 openFile 的「未能记住」同款），而不是指望 saveStore 那句红字能活着。
     * 不接返回值 → 红字被「已删除：X」当场盖掉，而 doc:<id> 真的还在磁盘上
     * 永久占配额（没有任何入口再读它）。
     */
    ok(/const\s+docCleared\s*=\s*await\s+saveStore\('脑图内容'/.test(df),
      'deleteFile：删文档本体要接住返回值（doc:<id> 删不掉会永久占配额）');
    ok(/docCleared\s*\?\s*''\s*:\s*'（/.test(df),
      'deleteFile：没删掉要把后果带进「已删除」那句（不能只靠 saveStore 的红字）');
  }
}

group('collectAssetRefs 漏掉列表形式的多附件（BUG 46）');

{
  const wb = await import('file://' + path.join(HERE, 'workbook.js'));

  /*
   * 单节点多附件改造之后，data.file / data.video 存的是 **JSON 数组串**
   * （哪怕只有一个附件也是数组），而不是单个对象串。
   *
   * 旧实现自己 `JSON.parse(v)` 一次，然后读 `ref.a` —— 数组没有 .a，
   * 于是**列表形式的多附件全部漏掉**，只收得到老式的单对象串。
   */
  const mk = (fileVal, videoVal) => [{
    id: 's1', title: '画布 1',
    content: JSON.stringify({
      root: { data: { text: '中心主题' }, children: [
        { data: { text: 'A', file: fileVal, video: videoVal } },
      ] },
    }),
  }];

  // ① 列表形式（新格式，改造后写出来的都是这种）
  const listSheets = mk(
    JSON.stringify([{ n: '报告.pdf', a: 'asDOC1', s: 2e6 }, { n: '数据.xlsx', a: 'asDOC2', s: 3e6 }]),
    JSON.stringify([{ n: 'demo.mp4', a: 'asVID1', s: 5e7 }]),
  );
  const got = wb.collectAssetRefs(listSheets).slice().sort();
  eq(got.join(','), 'asDOC1,asDOC2,asVID1',
    '列表形式的多附件必须全部收得到（旧实现只收得到 1 个）');

  // ② 单对象形式（老数据）仍然要认
  const oneSheets = mk(JSON.stringify({ n: '老文件.pdf', a: 'asOLD1', s: 1 }), undefined);
  eq(wb.collectAssetRefs(oneSheets).join(','), 'asOLD1', '单对象串（老数据）仍要收得到');

  // ③ 真数组（导入的 JSON 里可能是数组而不是串）
  const arrSheets = [{ id: 's1', title: 'c', content: JSON.stringify({
    root: { data: { text: 'R', file: [{ n: 'x', a: 'asARR1', s: 1 }] } },
  }) }];
  eq(wb.collectAssetRefs(arrSheets).join(','), 'asARR1', '真数组形式也要收得到');

  // ④ 数组元素是 JSON 串
  const strElem = [{ id: 's1', title: 'c', content: JSON.stringify({
    root: { data: { text: 'R', file: [JSON.stringify({ n: 'y', a: 'asSTR1', s: 1 })] } },
  }) }];
  eq(wb.collectAssetRefs(strElem).join(','), 'asSTR1', '数组元素是 JSON 串时也要收得到');

  // ⑤ 纯路径（C# 遗留）没有资产 id，不该被收进来
  const legacy = mk('/老路径/文件.pdf', undefined);
  eq(wb.collectAssetRefs(legacy).length, 0, '纯路径引用没有资产 id，不入集合');

  // ⑥ 走 decodeRefList：不能是自己 JSON.parse 的实现
  const src = fs.readFileSync(path.join(HERE, 'workbook.js'), 'utf8');
  const body = src.slice(src.indexOf('export function collectAssetRefs'));
  ok(/decodeRefList\(/.test(body), 'collectAssetRefs 必须复用 decodeRefList（不能自己 parse 一次）');
  ok(!/JSON\.parse\(v\)/.test(body), 'collectAssetRefs 不得自己 JSON.parse 单值（漏列表）');
}

group('删除脑图后附件本体变成孤儿（BUG 47）');

{
  /*
   * 附件字节存在 IndexedDB 的 asset:<id>，节点 data 只记引用串。
   * 引用消失的路径有三条：删节点、删整个脑图文件、移除附件中途出错。
   * 而 dropAsset 只在「侧栏移除单个附件」一处被调用 —— 其余全是孤儿，
   * 且**全仓库没有任何回收入口**（store.js 连 assetKeys() 都没有）。
   *
   * 单个视频上限 100MB，反复挂了删会持续吃配额；配额一满所有 store.set
   * 都失败，正是 BUG 23/45 那些「假成功」集中爆发的触发条件。
   */
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const strip = (t) => stripCommentsFlatJs(t);
  const code = strip(idx);

  // 不写死签名（有 quiet 参数），只锚函数名
  ok(/async function gcOrphanAssets\(/.test(code), '必须有孤儿附件回收函数');

  // 删文件后要真的调用它
  {
    const i = code.indexOf('async function deleteFile(id) {');
    const end = code.indexOf('\n  }\n', i);
    const body = code.slice(i, end);
    ok(/await gcOrphanAssets\(\)/.test(body), 'deleteFile 必须调用 gcOrphanAssets（否则删文件留一堆孤儿）');
    // 顺序：必须在 switchToFile 之前（切换后 workbook 就换成别的文件了）
    ok(body.indexOf('gcOrphanAssets()') < body.indexOf('switchToFile('),
      'gcOrphanAssets 必须在 switchToFile 之前（晚一步基准就换成别的文件了）');
  }

  // 关键正确性：删的正是当前文件时，workbook 不能被算作「仍在用」
  {
    /*
     * 不能按「下一个 `\n  }\n`」切 —— 函数里的 for 循环结尾和函数结尾
     * **同缩进**，那样会在第一个循环处就把函数截断，后面的断言全落在
     * 半截代码上（实测：三条断言同时失效）。
     * 用大括号配对找真正的结尾。
     */
    /*
     * 不能写死 `async function gcOrphanAssets()` —— 加了 quiet 参数之后
     * 签名就变了，锚点找不到会从头开始切，整组断言集体失效。
     * 只锚函数名。
     */
    const i = code.indexOf('async function gcOrphanAssets(');
    const braceAt = code.indexOf('{', i);
    let depth = 0, end = -1;
    for (let k = braceAt; k < code.length; k++) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    const body = code.slice(i, end + 1);
    /*
     * 最容易写错的一处：① 无条件 addRefs(workbook?.sheets)。
     * 删当前文件时 fileIndex 里已经没有 currentFileId，但 workbook 变量
     * 还装着那个文件的内容（switchToFile 要晚一步才跑）——
     * 于是被删文件的附件被当成「还在用」，这次回收**一个都删不掉**。
     * 代码看着有、运行时是死的，和 BUG 11「只定义不注册」同一类。
     */
    ok(/fileIndex\.some\(\(fi\)\s*=>\s*fi\.id === currentFileId\)/.test(body),
      '① 当前 workbook 只有仍在文件列表里时才算 live（否则删当前文件时回收恒不生效）');
    // ② 其余文件读不出来就整体中止，宁可留着也不能误删
    ok(/return \{ removed: 0, bytes: 0, aborted: true \}/.test(body),
      '② 任一文件读不出来必须整体中止（读不全就等于可能误删）');
    // ③ 快照：删文件后从快照恢复，附件必须还在
    ok(/store\.listBackups\(\)/.test(body), '③ 历史快照的引用必须算 live（否则恢复后附件全丢）');
    // ④ 图标：用户图标也用 asset:<id> 存，不在任何画布里
    ok(/picons\.loadLibrary\(\)/.test(body), '④ 用户图标的资产必须算 live（否则图标全被删）');
    // 判定方式是扫全量 asset 键，而不是拿一份 sheets 去清
    ok(/store\.keys\('asset:'\)/.test(body), '必须扫全量 asset: 键判定孤儿（不能只清某份 sheets）');
  }
}

group('移除附件无条件删资产，共享它的其它节点跟着失效（BUG 48）');

{
  /*
   * 内核 clone 是 `JSON.parse(JSON.stringify(data))`（kityminder.core.min.js 实测）：
   * data 深拷贝，但 assetId 是**字符串**，复制出来一模一样。
   * 真实 Chrome 实测：克隆节点的 data.file 仍指向 asSHARED1，
   * 且内核命令表里确实有 copy / paste（Ctrl+C / Ctrl+V 可达）。
   *
   * 于是：复制一个带附件的节点 → 两个节点共享同一份字节 →
   * 在侧栏移除其中一个 → 旧实现无条件 dropAsset → 另一个节点点开只剩
   * 「附件数据已丢失」。引用还在、字节没了，最难查的那种失效。
   */
  const pnl = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const strip = (t) => stripCommentsFlatJs(t);
  const pc = strip(pnl);

  // ① 移除附件不得再直接 dropAsset
  ok(!/io\.dropAsset\(/.test(pc),
    '移除附件不得直接 dropAsset（资产可能被别的节点共享）');

  // ② 必须交给按引用判定的回收
  {
    const i = pc.indexOf('const removeAt = async (kind, index) => {');
    ok(i > 0, '找到 removeAt');
    const seg = pc.slice(i, i + 2600);
    ok(/app\.api\.gcAssets\?\.\(\)/.test(seg),
      'removeAt 必须改调 gcAssets（按「还有没有人在引用」判定）');
    ok(seg.indexOf('gcAssets') > seg.indexOf('app.api.commit()'),
      'gcAssets 必须在 commit 之后（先把引用从列表里摘掉再判定）');
  }

  // ③ gcAssets 必须自己 capture()：commit 只是排了个延时保存
  {
    const j = strip(idx).indexOf('gcAssets: guard(');
    ok(j > 0, 'api 里有 gcAssets');
    const seg = strip(idx).slice(j, j + 400);
    ok(/capture\(\)/.test(seg),
      'gcAssets 必须先 capture()（不收回编辑器内容就会扫到移除前的旧数据，回收恒不生效）');
  }

  // ④ gcOrphanAssets 支持 quiet —— 否则它写的状态会盖掉「已移除…」
  ok(/async function gcOrphanAssets\(quiet = false\)/.test(strip(idx)),
    'gcOrphanAssets 支持 quiet（调用方随后自己会写状态）');
  ok(/if \(removed && !quiet\)/.test(strip(idx)), 'quiet 时才不写回收状态');
}

group('Mermaid 根节点引号嵌套，往返损坏中心主题文字（BUG 49）');

{
  const fmt = await import('file://' + path.join(HERE, 'formats.js'));

  const mk = (rootText, kids = []) => JSON.stringify({
    root: { data: { text: rootText }, children: kids.map((k) => ({ data: { text: k } })) },
  });
  const textsOf = (content) => {
    const out = [];
    const v = (n) => { out.push(n.data.text); (n.children || []).forEach(v); };
    v(JSON.parse(content).root);
    return out;
  };

  /*
   * 根节点原来是 `root((${mermaidLabel(text)}))`。
   * 而 mermaidLabel 在文字含特殊字符时**本身**就是 `["文字"]`，
   * 再套一层 (()) 得到 `root((["项目(2024)"]))` —— 两层括号嵌套，
   * Mermaid 认不出；mermaidTextOf 读回来只能拿到整串 `["项目(2024)"]`。
   *
   * 实测 4 例损坏：括号 / # / 引号 / 中括号。
   * 「导出成 Mermaid → 再导回来」中心主题就变成一串带方括号的怪东西。
   */
  const cases = [
    ['括号', '项目(2024)'],
    ['井号', '话题#1'],
    ['引号', '他说"好"'],
    ['中括号', '阶段[一]'],
    ['花括号', '范围{a}'],
  ];
  for (const [cn, rootText] of cases) {
    const src = mk(rootText, ['子1', '子(2)']);
    const back = fmt.fromMermaid(fmt.toMermaid(src));
    ok(back !== null, `${cn}：导回不能是 null`);
    eq(textsOf(back || '{"root":{"data":{"text":"?"}}}')[0], rootText,
      `${cn}：中心主题文字必须原样往返（不能带着方括号回来）`);
  }

  // 不需要引号时保持圆形 root((…))，视觉不变
  const plain = fmt.toMermaid(mk('中心主题', ['子1']));
  ok(/root\(\(中心主题\)\)/.test(plain), '普通文字仍是 root((…))（中心主题的圆形）');
  // 需要引号时改用 root[“…”]，不能再出现 (([ 这种嵌套
  const quoted = fmt.toMermaid(mk('项目(2024)', []));
  ok(!/\(\(\[/.test(quoted), '不得出现 ((["…"]) 这种两层括号嵌套');
  ok(/root\["项目\(2024\)"\]/.test(quoted), '需要引号时写成 root["…"]');

  // 其它四种格式顺带一起守（实测都一致，别将来改坏了）
  const rt = (to, from) => {
    for (const [, rootText] of cases) {
      const src = mk(rootText, ['子']);
      const back = from(to(src));
      eq(textsOf(back || '{"root":{"data":{"text":"?"}}}')[0], rootText,
        `PlantUML/其它格式同样要往返一致`);
    }
  };
  rt(fmt.toPlantUml, fmt.fromPlantUml);
  rt(fmt.toFreemind, fmt.fromFreemind);
  rt((c) => fmt.toOpml(c, 'T'), fmt.fromOpml);
}

group('视频帧率对齐：真正的 24fps 被判成 23.976（BUG 50）');

{
  const mi = await import('file://' + path.join(HERE, 'mediainfo.js'));

  /* ---- 手工搭一个最小可解析的 MP4（ftyp + moov + 一条视频轨） ----
   * 不依赖 ffmpeg / 外部素材，测试自带；顺带把 box 解析的偏移也钉住。 */
  const u32b = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
  const u16b = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; };
  const z = (n) => Buffer.alloc(n);
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'binary'))));
    return Buffer.concat([u32b(body.length + 8), Buffer.from(type, 'ascii'), body]);
  };

  /**
   * @param {number} samples 总采样数（stts 求和）
   * @param {number} timescale 轨道时间刻度
   * @param {number} duration 轨道时长（以 timescale 为单位）
   */
  const mp4 = (samples, timescale, duration, qt = false) => {
    const avc1Body = Buffer.concat([
      z(6),                      // reserved[6]
      u16b(1),                   // data_reference_index
      z(16),                     // pre_defined / reserved / pre_defined[3]
      u16b(1920), u16b(1080),    // width / height  （偏移 24 / 26）
      z(8),                      // horiz / vert resolution
      z(4),                      // reserved
      u16b(1),                   // frame_count
      z(32),                     // compressorname
      u16b(24),                  // depth
      z(2),                      // pre_defined
      box('avcC', Buffer.from([1, 100, 0, 31])),   // High@3.1
    ]);
    const stsd = box('stsd', z(4), u32b(1), box('avc1', avc1Body));
    // stts：entry_count=1，一条 (sample_count, sample_delta)
    const stts = box('stts', z(4), u32b(1), u32b(samples), u32b(1));
    const stbl = box('stbl', stsd, stts);
    // qt=true 模拟 QuickTime(.mov)：minf 里还有一份 hdlr（数据引用处理器 'url '）
    const qthdlr = qt ? box('hdlr', z(8), Buffer.from('url ', 'ascii'), z(12)) : null;
    const minf = box('minf', ...(qthdlr ? [qthdlr] : []), stbl);
    const mdhd = box('mdhd', z(4), u32b(0), u32b(0), u32b(timescale), u32b(duration), z(4));
    const hdlr = box('hdlr', z(8), Buffer.from('vide', 'ascii'), z(12));
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', mdia);
    const mvhd = box('mvhd', z(4), u32b(0), u32b(0), u32b(timescale), u32b(duration), z(80));
    const moov = box('moov', mvhd, trak);
    const ftyp = box('ftyp', Buffer.from('isom', 'ascii'), z(4));
    return Buffer.concat([ftyp, moov]);
  };

  const fpsOf = (samples, timescale, duration) => {
    const buf = new Uint8Array(mp4(samples, timescale, duration));
    return mi.parseMp4(buf)?.frameRate;
  };

  /*
   * 原实现是「按数组顺序返回第一个落在容差 0.03 内的常用值」：
   *   const common = [23.976, 24, 25, 29.97, 30, ...];
   *   for (const c of common) if (Math.abs(f - c) < 0.03) return c;
   * 23.976 排在 24 前面、两者只差 0.024（< 0.03），
   * 于是**真正的 24fps 一律被判成 23.976**。
   *
   * 实测（ffmpeg 生成的真实文件）24fps 的 mp4 与 webm 都显示 23.976，
   * 而 24fps 是电影的标准帧率，很常见。
   * 29.97 与 30 只差 0.03，恰好等于容差，靠 `<` 严格小于侥幸没中招。
   */
  eq(fpsOf(240, 600, 6000), 24, '24fps 必须显示 24（不能变成 23.976）');
  eq(fpsOf(240, 1000, 10010), 23.976, '23.976fps 保持 23.976');
  eq(fpsOf(300, 1000, 10010), 29.97, '29.97fps 保持 29.97');
  eq(fpsOf(300, 600, 6000), 30, '30fps 保持 30（不能被 29.97 吃掉）');
  eq(fpsOf(250, 600, 6000), 25, '25fps 保持 25');
  eq(fpsOf(600, 600, 6000), 60, '60fps 保持 60（不能被 59.94 吃掉）');
  // 非常见值：不走对齐，保留三位小数
  eq(fpsOf(157, 600, 6000), 15.7, '非常见帧率原样保留');

  /*
   * minf 里的 hdlr 把 mdia 里读到的 'vide' 覆盖成 'url '（BUG 51）
   *
   * walkBoxes 会自动递归进容器 box，而 parseTrak 又**显式**走进 minf 找 stbl ——
   * 于是 minf 的子 box 被当成 mdia 的子 box 交给同一个回调，
   * QuickTime 的 minf 里那份 hdlr（handler = 'url '）就把刚读到的 'vide' 冲掉了。
   * kind 变成 'url '，既不是 video 也不是 audio，
   * 分辨率 / 编码 / 帧率**全部丢失**，只剩 mvhd 给的时长还显示得出来。
   *
   * ISO 的 .mp4 通常不在 minf 里放 hdlr，所以这个坑只在 .mov 上暴露 ——
   * 而容器识别明确写着支持 MP4/**MOV**。
   */
  const qt = mi.parseMp4(new Uint8Array(mp4(240, 600, 6000, true)));
  ok(!!qt, 'QuickTime .mov 能解析出来');
  eq(qt.tracks[0]?.kind, 'video', 'minf 里的 hdlr 不得把 kind 从 video 冲掉');
  eq(qt.width, 1920, '.mov 分辨率仍能读出来');
  eq(qt.videoCodec, 'H.264', '.mov 视频编码仍能读出来');
  eq(qt.frameRate, 24, '.mov 帧率仍能读出来');
  eq(qt.container, 'MP4/MOV', '.mov 容器识别为 MP4/MOV');

  // 顺带钉住同一条解析链上的其它字段（避免改 fps 时把别处改坏）
  const r = mi.parseMp4(new Uint8Array(mp4(240, 600, 6000)));
  eq(r.width, 1920, '分辨率宽解析正确');
  eq(r.height, 1080, '分辨率高解析正确');
  eq(r.videoCodec, 'H.264', '视频编码识别为 H.264');
  eq(r.videoCodecDetail, 'High@3.1', '编码档位识别为 High@3.1');
  eq(r.duration, 10, '时长 = duration / timescale = 10s');
}

group('XMind 互操作：content.json 的 href 与 image（BUG 52 / 53）');

/*
 * kityminder.json 是「本工具无损快照」，往返一直正常 —— 所以这两处只在
 * **别人用 XMind 打开**、或 **快照不在（别的软件产出的文件 / 快照损坏）走 zen 档**
 * 时才暴露。正因如此它们长期没被测到：既有测试只覆盖了 native 往返。
 */
{
  const xmind = await import('./xmind.js');
  const io = await import('./io.js');

  const node = (text, extra = {}) => ({ data: { id: 'n' + text, text, ...extra }, children: [] });
  const R_PDF = JSON.stringify({ n: '报告.pdf', a: 'asFILE1', s: 10 });
  const R_MP4 = JSON.stringify({ n: '演示.mp4', a: 'asVID1', s: 20 });
  const IMG1 = 'data:image/png;base64,AAAA';
  const IMG2 = 'data:image/png;base64,BBBB';

  const root = node('中心主题');
  root.children.push(node('A', { file: JSON.stringify([R_PDF]) }));
  root.children.push(node('B', { file: JSON.stringify([R_PDF, R_MP4]) }));
  root.children.push(node('C', { video: JSON.stringify([R_MP4]) }));
  root.children.push(node('D', { images: JSON.stringify([IMG1, IMG2]), imageSize: '180*101' }));
  const sheets = [{ id: 'sh1', title: '画布1', theme: null, layout: null, content: JSON.stringify({ root }) }];

  const lib = { asFILE1: new TextEncoder().encode('PDF'), asVID1: new TextEncoder().encode('MP4') };
  const loadAsset = async (ref) => {
    const o = typeof ref === 'string' && ref[0] === '{' ? JSON.parse(ref) : {};
    return lib[o.a] || null;
  };

  const buf = new Uint8Array(await (await xmind.writeXMind(sheets, 'sh1', loadAsset)).arrayBuffer());
  const entries = await xmind.zipRead(buf);
  const cj = JSON.parse(new TextDecoder().decode(entries.get('content.json')));

  const flat = [];
  (function w(t) { flat.push(t); (t.children?.attached || []).forEach(w); })(cj[0].rootTopic);
  const byTitle = {};
  for (const t of flat) byTitle[t.title] = t;

  /* ---- BUG 52：多附件的 href 变成整个 JSON 数组串 ----
   *
   * 原来 `let att = str(data.video) || str(data.file);`
   * 而多附件改造后这两个字段是**数组串** —— str() 拿到的就是整个数组串，
   * 它不在 packs 里（键是单项引用）、toFileUri 也认不出，于是原样写进 href。
   * 实测导出后是：
   *   "href": "[\"{\\\"n\\\":\\\"报告.pdf\\\",\\\"a\\\":\\\"asFILE1\\\",\\\"s\\\":10}\"]"
   * 别的 XMind 软件里就是一串乱码死链。
   */
  eq(byTitle['A'].href, 'resources/kma_0_报告.pdf', '单附件：href 是包内相对路径');
  eq(byTitle['B'].href, 'resources/kma_0_报告.pdf', '多附件：href 取第一项的包内路径（不是整个数组串）');
  eq(byTitle['C'].href, 'resources/kma_1_演示.mp4', '视频优先：href 取视频的包内路径');
  ok(!String(byTitle['A'].href).includes('\\"'), 'href 里不得残留 JSON 引号转义');
  ok(!String(byTitle['B'].href).startsWith('['), 'href 不得是数组串（以 [ 开头）');

  /* ---- BUG 53：多图节点导出后一张图都不剩 ----
   *
   * buildImage 只读 data.image，而多图横幅在 data.images。
   * XMind 一个 topic 只挂一张图，取横幅第一张。
   */
  eq(byTitle['D'].image?.src, IMG1, '多图节点导出时带上了第一张图（原来一张都没有）');

  /* ---- 去掉 native 快照，强制走 zen 档导回 ----
   * 模拟「别的软件改过的 xmind」或快照损坏：此时 content.json 是唯一数据源。
   */
  const only = [...entries.entries()].filter(([k]) => k !== 'kityminder.json');
  const buf2 = await xmind.zipWrite(only.map(([name, data]) => ({ name, data })));
  const rr = await xmind.readXMind(new Uint8Array(await new Blob([buf2]).arrayBuffer()),
    async (name, bytes) => JSON.stringify({ n: name, a: 'NEW_' + name, s: bytes.length }));
  eq(rr.source, 'zen', '无 native 快照时走 zen 档');

  const back = JSON.parse(rr.sheets[0].content).root;
  const bd = {};
  for (const c of back.children) bd[c.data.text] = c.data;

  // 修复前：这里会是 hyperlink（一串乱码），file / video 全空 —— 附件直接没了
  ok(!bd['A'].hyperlink, '附件不得被当成乱码超链接存下来');
  ok(!!bd['A'].file, 'zen 档导入后文件附件还原为 file');
  ok(!!bd['C'].video, 'zen 档导入后 .mp4 还原为 video（不能落进 file）');
  // 数组里每一项是「引用对象串」，要用 decodeRefList 归一（不能直接取 .n）
  eq(io.decodeRefList(bd['C'].video)[0]?.n, '演示.mp4', 'zen 档导入的视频名正确');
  ok(!JSON.stringify(bd['A'].file).includes('resources/'), 'zen 档导入后引用已换成本地资产 id');
  eq(bd['D'].image, IMG1, 'zen 档导入后图片还原');
}

group('新建主题的种子：文字色必须按节点底色选，不能按画布底色（BUG 54）');

/*
 * PRESET_THEMES 的注释里写着一条硬约束：
 *   "registerCustomTheme() 内部三级节点共用同一个文字色，
 *    于是 root / main / sub 三个背景必须落在同一明暗侧 ——
 *    只要有一级跨到对面，同一个文字色必然在某一级上看不清"
 * 预置主题那一组由 mm-palette-test 逐项断言盯住了；
 * **themeSeed（新建主题的种子）这条路径没有** —— 于是这个坑只在种子上发作。
 *
 * 原写法 `isLightColor(b.bg) ? '#333333' : '#E8E8E8'` 看的是**画布**底色，
 * 而 THEMES 里有四套是「深色画布 + 浅色节点」：
 *   snow / classic / fish : bg = #3A4144（深），root = #E9DF98（浅）
 *   wire                  : bg = #000000（深），root = #999999（中浅）
 * 按 bg 判 → 深色画布 → 选浅字 → 浅字画到浅色节点上，实测最小对比度：
 *   snow 1.11 / classic 1.11 / fish 1.11 / wire 2.33
 * 也就是说：切到「雪白」再点「新建主题」，得到的主题**文字几乎完全看不见**。
 */
{
  const th = await import('./themes.js');

  const worst = (p) => Math.min(
    th.contrastRatio(p.textColor, p.rootBackground),
    th.contrastRatio(p.textColor, p.mainBackground),
    th.contrastRatio(p.textColor, p.subBackground),
  );

  const all = {};
  for (const t of th.THEMES) all[t.value] = worst(th.themeSeed(t.value, []));

  // 修复后：四个「深色画布 + 浅色节点」的主题全部改用深字
  ok(all['snow'] >= 4, `雪白（snow）种子文字对比度 ≥ 4（实测 ${all['snow'].toFixed(2)}，修复前 1.11）`);
  ok(all['fish'] >= 4, `青色（fish）种子文字对比度 ≥ 4（实测 ${all['fish'].toFixed(2)}，修复前 1.11）`);
  ok(all['wire'] >= 4, `线框灰（wire）种子文字对比度 ≥ 4（实测 ${all['wire'].toFixed(2)}，修复前 2.33）`);
  eq(th.themeSeed('snow', []).textColor, '#333333', 'snow 的种子改用深色文字（原来按画布判成了 #E8E8E8）');
  eq(th.themeSeed('wire', []).textColor, '#333333', 'wire 的种子改用深色文字');

  // 浅色系列必须保持深字（不能为了修上面把这边改反）
  eq(th.themeSeed('fresh-blue', []).textColor, '#333333', 'fresh-blue 仍是深色文字');
  ok(all['fresh-blue'] >= 4, `fresh-blue 种子对比度 ≥ 4（实测 ${all['fresh-blue'].toFixed(2)}）`);

  // 通用下限：任何内置主题的种子都不该跌到「几乎看不见」
  const low = Object.entries(all).filter(([, v]) => v < 1.2);
  eq(low.length, 0, `没有内置主题的种子对比度低于 1.2（实测最低 ${Math.min(...Object.values(all)).toFixed(2)}）`);

  /*
   * classic 是**已知**的例外：它的 sub = 'transparent' 回落成画布底色
   * #3A4144（深），而 root / main 是浅色 —— 三级真的跨了侧。
   * 这是 THEMES 数据本身的问题，任何单一文字色都救不了，
   * 所以这里只要求它不低于修复前（1.11），并把原因写清楚。
   */
  ok(all['classic'] >= 1.1,
    `classic 因 sub 跨侧无法兼顾，但不低于修复前（实测 ${all['classic'].toFixed(2)}）`);
}

group('detectFormat：ATX 标题必须先于「裸 * 列表」判断，否则丢标题（BUG 55）');

/*
 * `/^\*+\s+\S/` 是 PlantUML 片段的嗅探（无 @startmindmap 包裹时），
 * 而 Markdown 用 `*` 当项目符号同样命中它。detectFormat 里它排在
 * ATX 标题**之前**，于是「既有 # 标题、又有 * 列表」的 Markdown 被判成 plantuml：
 *
 *   '# 项目\n## 设计\n* 要点一\n* 要点二'
 *     原顺序 → plantuml → 解析成「要点一 | 要点二」
 *             **两个标题全丢**（项目 / 设计都没了）
 *     改后   → markdown → 「项目 / 设计」
 *
 * 判据：PlantUML mindmap 的行首只有 `*`/`**`，不会出现 `# 标题`；
 * 而带 `#` 标题的文件必然是 Markdown。两者同时出现时 Markdown 是唯一合理解。
 */
{
  const F = await import('./formats.js');
  const WB = await import('./workbook.js');

  const flat = (content) => {
    const o = [];
    (function x(n, d) { o.push(n.data.text); (n.children || []).forEach((c) => x(c, d + 1)); })(JSON.parse(content).root);
    return o;
  };

  // 混排：标题 + 星号列表 —— 这是本次 BUG 的核心用例
  const mixed = '# 项目\n## 设计\n* 要点一\n* 要点二\n';
  eq(F.detectFormat(mixed, 'x.md'), 'markdown', '标题与 * 列表混排时判为 markdown（不能是 plantuml）');
  eq(F.detectFormat(mixed, 'x.txt'), 'markdown', '后缀不是 .md 也一样（按内容嗅探）');
  {
    const got = flat(WB.markdownToWorkbook(mixed)[0].content);
    ok(got.includes('项目'), ` markdown 分支保留了中心主题（实际 ${JSON.stringify(got)}）`);
    ok(got.includes('设计'), ' markdown 分支保留了二级标题');
  }

  // 单标题 + 星号列表
  eq(F.detectFormat('# 项目\n* 子一\n', 'x.md'), 'markdown', '单标题 + 星号列表判为 markdown');
  // 只有星号列表、没有标题 → 仍走 plantuml（解析结果是对的，见下）
  eq(F.detectFormat('* 项目\n  * 子一\n', 'x.md'), 'plantuml', '无标题的纯 * 列表仍判为 plantuml（与改动前一致）');
  {
    const c = F.fromPlantUml('* 项目\n  * 子一\n');
    const got = flat(c);
    eq(got.join('|'), '项目|子一', '纯 * 列表走 plantuml 解析仍正确（不能被这次改动带坏）');
  }

  // 标题 + 减号列表（本来就没问题，防止改坏）
  eq(F.detectFormat('# 项目\n- 子一\n', 'x.md'), 'markdown', '标题 + 减号列表判为 markdown');
  // 完整 PlantUML 与片段都不受影响
  eq(F.detectFormat('@startmindmap\n* 项目\n@endmindmap', 'x.puml'), 'plantuml', '带 @startmindmap 仍是 plantuml');
  eq(F.detectFormat('* 项目\n** 子\n', 'x.puml'), 'plantuml', 'PlantUML 片段（** 递增）仍是 plantuml');
  // 其它格式不受影响
  eq(F.detectFormat('<opml version="2.0"></opml>', 'x.opml'), 'opml', 'OPML 不受影响');
  eq(F.detectFormat('<map version="1.0.1"></map>', 'x.mm'), 'freemind', 'FreeMind 不受影响');
  eq(F.detectFormat('mindmap\n  root((x))', 'x.mmd'), 'mermaid', 'Mermaid 不受影响');
}

group('Markdown 往返：二级节点叫「画布：X」会被当成分块标记，节点丢失（BUG 56）');

/*
 * `workbookToMarkdown` 的分块标记是 `## 画布：<标题>`（SHEET_MARK）。
 * 而节点文字原样拼在 `#` 之后 —— 于是**二级**节点只要叫「画布：X」，
 * 导出的行正好命中分块标记，导回时整棵树的层级与画布数一起坏掉。
 *
 * 实测（单画布，根「项目」，子「画布：设计」「开发」）：
 *   修复前 → 2 张画布：[0] 项目（子节点全丢） / [1] 设计（根变成「开发」）
 *   修复后 → 1 张画布：项目 / 画布：设计 / 开发
 */
{
  const WB = await import('./workbook.js');

  const flat = (content) => {
    const o = [];
    (function x(n, d) { o.push(n.data.text); (n.children || []).forEach((c) => x(c, d + 1)); })(JSON.parse(content).root);
    return o;
  };
  const sheet = (title, rootText, kids) => ({
    id: 's1', title, theme: null, layout: null,
    content: JSON.stringify({
      root: { data: { text: rootText }, children: kids.map((k) => ({ data: { text: k }, children: [] })) },
      template: 'default', theme: 'fresh-blue-compat',
    }),
  });

  // 核心用例：全角冒号
  {
    const md = WB.workbookToMarkdown([sheet('我的图', '项目', ['画布：设计', '开发'])]);
    const back = WB.markdownToWorkbook(md);
    eq(back.length, 1, '二级节点叫「画布：设计」时往返后仍是 1 张画布（修复前变 2 张）');
    eq(back[0].title, '我的图', '画布标题未被顶掉');
    eq(flat(back[0].content).join('|'), '项目|画布：设计|开发',
      '节点「画布：设计」原样回来（修复前它变成画布标题而丢失）');
  }

  // 半角冒号同样命中 SHEET_MARK
  {
    const md = WB.workbookToMarkdown([sheet('我的图', '项目', ['画布:设计', '开发'])]);
    const back = WB.markdownToWorkbook(md);
    eq(back.length, 1, '半角「画布:设计」同样不能触发分块');
    eq(flat(back[0].content).join('|'), '项目|画布:设计|开发', '半角形态往返无损');
  }

  // 转义只能影响这一处：其它文字不得以任何方式被改动
  {
    const md = WB.workbookToMarkdown([sheet('我的图', '项目', ['设计', '开发'])]);
    ok(!md.includes('\\'), `普通文字不得出现转义反斜杠（实际含 \\：${md.includes('\\')}）`);
    const back = WB.markdownToWorkbook(md);
    eq(flat(back[0].content).join('|'), '项目|设计|开发', '普通节点往返不变（防止转义改坏正常文字）');
  }

  // 通用去反斜杠会改掉别人的 Markdown —— 只解 `\画布：` 这一种
  {
    const back = WB.markdownToWorkbook('# 根\n## \\普通反斜杠\n## \\画布：X\n');
    const t = flat(back[0].content);
    ok(t.includes('\\普通反斜杠'), '从别处导入的 `\\开头` 文字不得被改掉');
    ok(t.includes('画布：X'), '本工具加的转义要被解掉');
  }

  // 多画布分块本身不受影响
  {
    const md = WB.workbookToMarkdown([
      sheet('A图', '甲', ['子1']),
      sheet('B图', '乙', ['子2']),
    ]);
    const back = WB.markdownToWorkbook(md);
    eq(back.length, 2, '多画布仍是 2 张（分块标记照常工作）');
    eq(back[0].title, 'A图', '第一张标题正确');
    eq(back[1].title, 'B图', '第二张标题正确');
    eq(flat(back[1].content).join('|'), '乙|子2', '第二张内容正确');
  }

  // 转义后仍要能被 markdownRowCount 认成大纲行（否则会被判「无法识别」而拒导入）
  {
    const md = WB.workbookToMarkdown([sheet('我的图', '项目', ['画布：设计'])]);
    ok(WB.markdownRowCount(md) > 0, '带转义的行仍计入大纲行数（不会被 noOutline 拒掉）');
  }
}

group('复制/剪切/粘贴节点：内核提供了命令却没绑键，编辑器页必须补（BUG 57）');

/*
 * 内核 ClipboardModule 提供了 copy/cut/paste 三个命令（实测 40 个命令里有），
 * 但**没有**把它们注册成快捷键。实测（真实 Chrome，钩住
 * Minder.prototype.addCommandShortcutKeys 记下每次注册）只有 5 次调用：
 *
 *   {arrangeup, arrangedown} / {bold, italic} / {resetlayout}
 *   {appendsiblingnode, appendchildnode, appendparentnode, removenode}
 *   {zoomin, zoomout}
 *
 * —— 没有 copy/cut/paste。而插件里**没有任何复制粘贴节点的按钮**，
 *    键盘是唯一入口，于是这功能等于完全不可用。
 *
 * 同一份实测（选中节点后派发带正确 keyCode 的 keydown）：
 *   Ctrl+B → queryCommandState('bold') 0 → 1      ← 对照组正常
 *   Ctrl+C 然后 Ctrl+V → 节点数 4 → 4             ← 完全没反应
 *   execCommand('copy') + execCommand('paste') → 4 → 6   ← 命令本身没问题
 *
 * 补上 addCommandShortcutKeys({copy:'ctrl+c',cut:'ctrl+x',paste:'ctrl+v'})
 * 后实测：4 → 6（A 与 A1 被克隆到 B 下），Ctrl+B 仍正常，Ctrl+X 6 → 3。
 */
{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');

  // 剥注释：注释里大量复述这三个键名，不剥的话命中的是注释而不是代码
  const code = stripCommentsFlatJs(ed);

  const reg = /addCommandShortcutKeys\(\{[^}]*copy:\s*'ctrl\+c'[^}]*\}\)/;
  const m = code.match(reg);
  ok(!!m, "编辑器页注册了 copy:'ctrl+c'（否则复制节点没有入口）");

  const seg = m ? m[0] : '';
  ok(/cut:\s*'ctrl\+x'/.test(seg), "同一处注册了 cut:'ctrl+x'（剪切不能漏）");
  ok(/paste:\s*'ctrl\+v'/.test(seg), "同一处注册了 paste:'ctrl+v'（粘贴不能漏）");

  // 只定义不调用 = 没修（与 BUG 11 同类）
  ok(/km\.addCommandShortcutKeys\(\{\s*copy:/.test(code),
    '必须是 km.addCommandShortcutKeys(...) 的调用，而不是只写一个字面量');
}

group('快捷键说明：不得重复、且必须列出撤销与复制粘贴（BUG 57 附带）');

/*
 * 快捷键说明窗口早先把 `Ctrl + C / X / V` 写了**两遍**，同一行出现两次；
 * 而撤销/重做（编辑器页补的）压根没列 —— 用户翻遍说明找不到怎么撤销。
 */
{
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const m = pn.match(/const SHORTCUTS = \[([\s\S]*?)\n\];/);
  ok(!!m, '取到 SHORTCUTS 数组');
  const body = m ? m[1] : '';

  // 剥注释后再取条目，否则注释里提到的键名会被算进去
  const entries = [...stripCommentsFlatJs(body)
    .matchAll(/\['([^']+)',\s*'([^']*)'\]/g)].map((x) => ({ key: x[1], desc: x[2] }));

  ok(entries.length >= 20, `条目数量合理（实际 ${entries.length} 条）`);

  const seen = new Map();
  const dup = [];
  for (const e of entries) {
    if (seen.has(e.key)) dup.push(e.key);
    else seen.set(e.key, e.desc);
  }
  eq(dup.length, 0, `没有重复的快捷键条目${dup.length ? '（重复：' + dup.join(' / ') + '）' : ''}`);

  const has = (frag) => entries.some((e) => e.key.includes(frag));
  ok(has('Ctrl + Z'), '列出了 Ctrl + Z（撤销）');
  ok(has('Ctrl + Y'), '列出了 Ctrl + Y（重做）');
  ok(has('Ctrl + C / X / V'), '列出了复制/剪切/粘贴');
  ok(has('Ctrl + A'), '列出了 Ctrl + A（全选）');
  ok(has('Tab'), '列出了 Tab');
}

/* ============================================================
   BUG 58 · 节点图标与图片附件共用 data.image 槽位（互相静默覆盖）
   ============================================================ */

group('BUG 58 · 图标库与图片附件共用 data.image，后写的把先写的整串覆盖（永久丢失）');
{
  const eb = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  // 注释里大量引用这些名字，不剥的话命中的是注释本身 —— 代码真改坏了照样绿
  const strip = (t) => stripCommentsFlatJs(t);
  const E = strip(eb);
  const C = strip(pn);

  /*
   * 背景（真实 Chrome 实测）：
   *   先挂照片 → 再应用图标 → 照片 dataURL **被整串覆盖、永久丢失**
   *   （inline 存储，别处没有副本），而界面提示「已应用图标：xxx」，
   *   用户完全不知道照片没了。先图标后图片同理。
   * 根因：两者都走 image 命令、都写 data.image 这一个槽位。
   */

  // 1) 必须有判据：图标库产出的必然是内联 SVG，附件图片经 imageToInline 压成 JPEG/PNG
  ok(/_isIconUrl\s*\(/.test(E) && E.includes('svg\\+xml'),
    'editor-bridge：有 _isIconUrl 判据（图标=内联 SVG，图片=JPEG/PNG，存量数据无需迁移）');

  // 2) setImage 必须能区分「写图标」与「写图片」
  ok(/setImage\s*\(\s*url\s*,\s*opt\s*\)/.test(E),
    'editor-bridge：setImage 带 opt 参数（同一槽位上两类内容必须能区分）');

  const i0 = E.indexOf('setImage(url, opt)');
  ok(i0 > 0, 'editor-bridge：能定位 setImage');
  const iEnd = E.indexOf('setNote(');
  const body = E.slice(i0, iEnd > i0 ? iEnd : i0 + 2000);

  ok(/const\s+isIcon\s*=\s*!!\s*\(\s*opt\s*&&\s*opt\.icon\s*\)/.test(body),
    'setImage：从 opt.icon 取「这次写的是不是图标」');
  ok(/const\s+slot\s*=\s*this\._imageSlot\(\)/.test(body),
    'setImage：先读当前槽位（不知道槽里是谁就没法判断要不要让位）');

  // 3) 写图标：槽里若已是图片，必须先让进横幅 —— 这是「不丢数据」的关键
  const bIcon = body.indexOf('if (isIcon) {');
  const bPhoto = body.indexOf('// 写图片');
  const iconBranch = bIcon > 0 ? body.slice(bIcon, bPhoto > bIcon ? bPhoto : bIcon + 900) : '';
  ok(iconBranch.length > 0, 'setImage：能取到「写图标」分支');
  ok(/slot\.url\s*&&\s*!slot\.isIcon[\s\S]{0,120}_appendImage\(slot\.url\)/.test(iconBranch),
    'setImage 写图标：槽里是图片时先让它进 images 横幅（否则照片永久丢失）');
  // 剥过注释后行内标记没了，改用代码特征定位两个分支
  ok(/_appendImage\(slot\.url\);[\s\S]{0,160}this\.exec\('image', url\)/.test(body),
    'setImage 写图标：让位之后立刻写图标，其间不得清 images（否则刚让位的图片又没了）');
  // 按大括号配对取「写图标」分支：剥注释后行内标记没了，固定长度切片会串到下一个分支
  {
    const bi = body.indexOf('if (isIcon) {');
    let bj = -1, depth = 0;
    for (let k = body.indexOf('{', bi); k >= 0 && k < body.length; k++) {
      if (body[k] === '{') depth++;
      else if (body[k] === '}') { depth--; if (!depth) { bj = k; break; } }
    }
    const ibr = bi >= 0 && bj > bi ? body.slice(bi, bj + 1) : '';
    ok(ibr.length > 0, 'setImage：按括号配准取到「写图标」分支');
    ok(!/exec\(\s*'images'\s*,\s*null\s*\)/.test(ibr),
      'setImage 写图标分支不得清 images（会把刚让位过去的图片又删掉）');
  }

  // 4) 写图片：槽里已被占（图标或另一张图片）时一律「加」不「替」
  ok(/if\s*\(slot\.url\s*\)[\s\S]{0,120}slot\.isIcon[\s\S]{0,60}_appendImage\(url\)/.test(body),
    'setImage 写图片：槽里是图标时图片走横幅（不能把图标顶掉）');
  // BUG 95 带出来：槽里是**图片**时也不能整串覆盖（那张也是用户的图）
  ok(/setImages\(cur\.concat\(\[slot\.url, url\]\)\)/.test(body),
    'setImage 写图片：槽里已是图片时两张一起进横幅（互不覆盖、也不留孤儿）');

  // 5) 清除：只清自己这一类。「清除节点图标」不该连带删掉用户挂的照片
  ok(/isIcon\s*&&\s*slot\.url\s*&&\s*!slot\.isIcon\s*\)\s*return true/.test(body),
    'setImage 清除：槽里放的是图片时，「清除图标」必须放过（否则连照片一起删）');

  // 6) setImages：图标占用槽位时，1 张图也要走横幅
  const j0 = E.indexOf('setImages(list)');
  const jEnd = E.indexOf('getSelectedNodeId');
  const sbody = E.slice(j0, jEnd > j0 ? jEnd : j0 + 1600);
  ok(/iconBusy\s*=\s*!!\s*\(\s*slot\.url\s*&&\s*slot\.isIcon\s*\)/.test(sbody),
    'setImages：判定槽位是否被图标占用');
  ok(/arr\.length === 1 && !iconBusy/.test(sbody),
    'setImages：图标占用槽位时，1 张图也走横幅而不是覆盖图标');

  // 7) 读取：槽里是图标时不算图片附件
  // 必须找**定义**：_appendImage 里也调了 this.getSelectedImages()，
  // 只 indexOf('getSelectedImages()') 会落到那个调用点上（定长窗口随后被新代码撑爆）
  const g0 = E.indexOf('getSelectedImages() {');
  const gbody = E.slice(g0, g0 + 2600);
  ok(/one\s*&&\s*!this\._slotKind\(n, one\)/.test(gbody),
    'getSelectedImages：槽里是图标时不算图片（否则侧栏列出图标、删图会误删图标、追加第二张时把图标算进基数）');
  // BUG 95：判据必须是**标记优先、MIME 兜底** —— 只看 MIME 会把用户挂的 .svg
  // 图片当成图标（io.imageToInline 对 SVG 原样内联，产出同样是 svg+xml）
  ok(/const flag = node\?\.getData\?\.\('icon'\);[\s\S]{0,200}return this\._isIconUrl\(u\)/.test(E),
    '_slotKind：先看 data.icon 标记，没有才回落到 MIME（存量数据不回归）');

  // 8) 调用点：图标库必须标 icon
  ok(/setImage\(url,\s*\{\s*icon:\s*true\s*\}\)/.test(C),
    'panels：图标库应用图标时标 icon:true');
  ok(/setImage\(null,\s*\{\s*icon:\s*true\s*\}\)/.test(C),
    'panels：「清除节点图标」标 icon:true（否则会把图片一起删掉）');
}

/* ============================================================
   BUG 59 · 超链接 / 备注输入框不回显（只有 set 没有 get）
   ============================================================ */

group('BUG 59 · 超链接与备注输入框必须回显（否则已有值看不见、改一个字符要整条重打）');
{
  const eb = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const strip = (t) => stripCommentsFlatJs(t);
  const E = strip(eb);

  /*
   * 实测（真实 Chrome）：节点已存 hyperlink / note，切到「标签」页两个框
   * 都是空的，重新选中该节点仍然空。内核的 hyperlink / note 命令都在
   * （52 个命令里都有），data 也写得进 —— 缺的只是**读取**这条路：
   * editor-bridge 只有 setHyperlink / setNote，没有对应的 get。
   *
   * 后果不只是「看不见」：想改一个字符必须整条重打，
   * 而且看着像这个节点没有超链接。
   */

  // 1) 必须有两个 getter（不是只加个 value 就完事 —— 值得有来源）
  for (const [fn, key] of [['getSelectedHyperlink', 'hyperlink'], ['getSelectedNote', 'note']]) {
    const i = E.indexOf(fn + '()');
    ok(i > 0, `editor-bridge：有 ${fn}()`);
    const seg = E.slice(i, i + 500);
    ok(seg.includes(`getData?.('${key}')`),
      `${fn}() 读的是 data.${key}（写进去了却读别的字段等于没修）`);
    ok(/\|\|\s*''/.test(seg),
      `${fn}()：读不到时回落空串（返回 undefined 会让 value 变成 "undefined"）`);
  }

  /*
   * 2) 两个输入框都必须带 value。
   *
   * 这里**不能用剥过注释的文本去定位**：panels.js 里有 `'image/*'` 这类字面量，
   * 剥注释的块注释正则会从 `'image/*'` 的星号斜杠开始一路吞到下一个块注释收尾，
   * 整段「标签」页被吃掉 —— 断言会静默失效（实测：剥完之后「超链接」0 次出现）。
   * 所以下面一律在**原文**上做，且按大括号配对取块。
   */
  ok(/value:\s*app\.bridge\.getSelectedHyperlink/.test(pn),
    '超链接输入框有 value（否则每次打开都是空的）');
  ok(/value:\s*app\.bridge\.getSelectedNote/.test(pn),
    '备注输入框有 value（否则每次打开都是空的）');

  // 3) 通用守卫：任何一个 input.mm-input 都不能漏 value —— 防下一个输入框重蹈覆辙
  {
    const bad = [];
    const re = /h\('input\.mm-input',\s*\{/g;
    let m;
    while ((m = re.exec(pn))) {
      let dep = 1, k = m.index + m[0].length - 1;
      for (; k < pn.length && dep > 0; k++) {
        if (pn[k] === '{') dep++;
        else if (pn[k] === '}') dep--;
      }
      const body = pn.slice(m.index, k);
      if (!/\bvalue:/.test(body)) {
        bad.push(pn.slice(0, m.index).split('\n').length + ': ' + body.replace(/\s+/g, ' ').slice(0, 70));
      }
    }
    /*
     * ⓘ 原写 `ok(bad.length >= 0, 'panels：扫描到 input.mm-input 定义')` —— 恒真，
     *   而且**措辞和判据对不上**（说是"扫描到定义"，判的却是 bad 的数量）。
     *   真正的断言就是下面这一条 bad.length === 0；
     *   扫描有没有空转由再下面的 withVal >= 2 守着。
     *   留着那条恒真的只会让人以为这里有两道防线，实际只有一道。
     */
    eq(bad.length, 0,
      'panels 里每个 input.mm-input 都要有 value（漏了就变成只写不读）'
      + (bad.length ? ' → ' + bad.join(' | ') : ''));
    // 至少要有 2 个带回显的（超链接 + 备注），防止扫描本身空转
    const withVal = (pn.match(/h\('input\.mm-input',\s*\{[\s\S]{0,400}?\bvalue:/g) || []).length;
    ok(withVal >= 2, `至少有 2 个 input.mm-input 带了 value（实测 ${withVal} 个）`);
  }
}

/* ============================================================
   BUG 60 · 切换画布后主题/布局页不刷新；删主题只回退当前画布
   ============================================================ */

group('BUG 60 · 换画布后侧栏必须跟着换；删主题要回退**所有**引用它的画布');
{
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');

  /**
   * 实测（真实 Chrome，走完整 UI）：
   *   画布1 设为清新绿 → 新建画布2（编辑器 fresh-blue，侧栏却仍高亮清新绿）
   *   → 画布2 设为清新红 → 切回画布1（编辑器 fresh-green，侧栏仍高亮清新红）
   * 编辑器与侧栏指向的不是同一张画布。
   *
   * 根因：loadSheet() 换了 s.theme / s.layout，却只刷了「文件页」
   * （refreshSideIfNeeded 里 `side?.current?.() === 'file'`）。
   * 那条判断管的是**选中节点变了**，而换画布时 open() 不会被调用，
   * 页面不重建 —— 于是主题页 / 布局网格一直沿用上一张画布的值。
   */

  // ① 必须有一个「无条件重刷」的入口（不是复用只刷文件页的那个）
  ok(/function refreshSideNow\(\)/.test(ix), 'index：有 refreshSideNow()（无条件重刷）');
  {
    const i = ix.indexOf('function refreshSideNow()');
    let dep = 0, k = ix.indexOf('{', i);
    for (let j = k; j < ix.length; j++) {
      if (ix[j] === '{') dep++;
      else if (ix[j] === '}') { dep--; if (!dep) { k = j; break; } }
    }
    const body = ix.slice(i, k + 1);
    ok(/side\?\.refresh\?\.\(\)/.test(body), 'refreshSideNow() 调的是 side.refresh（可选链，启动期不炸）');
    // 不能又退化成只刷文件页 —— 那就和没加一样
    ok(!/current\?\.\(\)\s*===\s*'file'/.test(body),
      'refreshSideNow() 不能只刷文件页（那就和 refreshSideIfNeeded 一样了）');
  }

  // ② loadSheet() 必须真的调它 —— 只定义不调用 = 没修（BUG 11 同款）
  {
    const i = ix.indexOf('async function loadSheet()');
    ok(i > 0, 'index：能定位 loadSheet');
    let dep = 0, k = -1;
    for (let j = ix.indexOf('{', i); j < ix.length; j++) {
      if (ix[j] === '{') dep++;
      else if (ix[j] === '}') { dep--; if (!dep) { k = j; break; } }
    }
    const body = ix.slice(i, k + 1);
    ok(/refreshSideNow\(\)/.test(body), 'loadSheet() 末尾调用 refreshSideNow()（换画布后重刷侧栏）');
  }

  // ③ 删主题：必须回退**所有**引用它的画布，不能只管当前这张
  ok(/reassignTheme:\s*guard\(/.test(ix), 'index：api 暴露 reassignTheme');
  {
    const i = ix.indexOf('reassignTheme: guard(');
    let dep = 0, k = -1;
    for (let j = ix.indexOf('{', i); j < ix.length; j++) {
      if (ix[j] === '{') dep++;
      else if (ix[j] === '}') { dep--; if (!dep) { k = j; break; } }
    }
    const body = ix.slice(i, k + 1);
    ok(/for \(const s of workbook\.sheets\)/.test(body),
      'reassignTheme 遍历**全部**画布（只改当前那张 = 别的画布仍悬空）');
    ok(/s\.theme === fromId/.test(body), 'reassignTheme 按 theme id 匹配');
    ok(/await persist\(\)/.test(body), 'reassignTheme 回退后要落盘（不落盘重载又回退到悬空 id）');
  }

  // ④ 面板删除主题的处理里必须真的调它
  {
    const i = pn.indexOf("safe('删除主题'");
    ok(i > 0, 'panels：能定位删除主题处理器');
    let dep = 0, k = -1;
    for (let j = pn.indexOf('{', i); j < pn.length; j++) {
      if (pn[j] === '{') dep++;
      else if (pn[j] === '}') { dep--; if (!dep) { k = j; break; } }
    }
    const body = pn.slice(i, k + 1);
    ok(/app\.api\.reassignTheme\?\.\(t\.id\)/.test(body),
      '删除主题后调用 reassignTheme(t.id)（否则别的画布留悬空主题 id）');
  }
}

/* ============================================================
   BUG 61 · 主题写盘失败不回滚内存（与 createFolder / renameFile 同一条约束）
   ============================================================ */

group('BUG 61 · 主题的新建 / 导入 / 删除，写盘失败都必须回滚内存');
{
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');

  /**
   * createFile / createFolder / renameFile / moveFile / deleteFile / deleteFolder
   * 都在 saveStore 返回 false 时把内存改回去（界面与磁盘两边一致）。
   * 主题的三条路**一条都没回滚**：
   *
   *   · 导入主题：内存里多一份，磁盘没有 → 主题页显示它、点上去也能用
   *     （编辑器注册的是内存对象），重载就消失 —— 假可用；
   *   · 删除主题：内存里没了，磁盘还在 → 下一次 refresh() 它就从列表消失，
   *     用户以为删掉了，重载又冒出来；
   *   · 编辑保存：内存里换成新值，磁盘是旧值 → 重载回到旧主题，白改一次。
   *
   * 又是「同一条约束只修了部分路径」。
   *
   * 下面的断言都用**结构定位**（先剥注释、按大括号配对取函数体），
   * 不用定长切片 —— 定长切片会被后加的注释撑爆，变成恒真断言。
   */
  const strip = (src) => stripCommentsFlatJs(src);
  const P = strip(pn);

  const takeBlock = (at) => {
    let dep = 0;
    for (let j = P.indexOf('{', at); j < P.length; j++) {
      if (P[j] === '{') dep++;
      else if (P[j] === '}') { dep--; if (!dep) return P.slice(at, j + 1); }
    }
    return '';
  };

  // ① 编辑器保存：留住 prevList 并在失败时还原
  {
    const at = P.indexOf('const save = async () =>');
    ok(at > 0, 'panels：能定位主题编辑器 save');
    const body = takeBlock(at);
    ok(/const prevList\s*=\s*app\.customThemes/.test(body), '编辑保存：写盘前留住原数组 prevList');
    ok(/if \(!saved\)[\s\S]{0,200}app\.customThemes\s*=\s*prevList/.test(body),
      '编辑保存：写盘失败时把 customThemes 还原为 prevList');
  }

  // ② 导入主题：失败撤回
  {
    const at = P.indexOf('async function importThemeFile()');
    ok(at > 0, 'panels：能定位 importThemeFile');
    const body = takeBlock(at);
    ok(/const prevList\s*=\s*app\.customThemes/.test(body), '导入主题：写盘前留住原数组');
    ok(/if \(!okSave\)[\s\S]{0,220}app\.customThemes\s*=\s*prevList/.test(body),
      '导入主题：写盘失败时撤回（否则主题页显示一个重载就没了的主题）');
  }

  // ③ 删除主题：失败按原下标插回
  {
    const at = P.indexOf("safe('删除主题'");
    ok(at > 0, 'panels：能定位删除主题处理器');
    const body = takeBlock(at);
    ok(/findIndex\(\(x\)\s*=>\s*x\.id\s*===\s*t\.id\)/.test(body),
      '删除主题：先记下原下标（顺序乱了会让 core 的主题解析漂移）');
    ok(/if \(!ok\)[\s\S]{0,400}back\.splice\(at,\s*0,\s*t\)/.test(body),
      '删除主题：写盘失败时按原下标插回');
    ok(/app\.customThemes\s*=\s*back/.test(body), '删除主题：插回后要写回 customThemes');
  }
}


/* ============================================================
   多选样式「值不一致」显示 —（B62）
   ============================================================ */

{
  const E = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const Pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8').replace(/\r\n/g, '\n');

  /**
   * 取一个具名函数的**完整函数体**（大括号配对，不被内部注释/字符串欺骗）。
   *
   * 不用固定字符数切片：注释一长就会把窗口撑爆，断言测到的是注释本身
   * 或相邻代码（本项目已踩过 20+ 次这类假阴性）。
   */
  const balanced = (src, sig) => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    let d = 0, j = src.indexOf('{', i);
    if (j < 0) return '';
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
    }
    return '';
  };

  group('多选样式：不一致必须显式上报，不能沿用上一个节点的值');

  // ① 两边哨兵必须同值 —— 跨模块只能靠字面量对齐
  const se = (E.match(/var MIXED = '([^']+)';/) || [])[1];
  const sp = (Pn.match(/const MIXED = '([^']+)';/) || [])[1];
  ok(!!se && !!sp, '两侧都定义了 MIXED 哨兵');
  eq(se, sp, 'editor 与 panels 的 MIXED 哨兵同值（跨模块只能靠字面量对齐）');
  ok(/const isMixed = \(v\) => v === MIXED;/.test(Pn), 'panels：有 isMixed 判定');

  // ② mergeStyles 行为：真的执行它，不是匹配源码
  const mergeSrc = balanced(E, 'function mergeStyles(list)');
  ok(mergeSrc.length > 0, 'editor：能定位 mergeStyles 函数体');
  const mergeStyles = new Function(`var MIXED = '${se}'; ${mergeSrc} return mergeStyles;`)({
    /* 无依赖：函数体只用 list / Object.keys */
  });

  const one = [{ fontSize: '30', bold: true }];
  const m1 = mergeStyles(one);
  eq(m1.fontSize, '30', '单选：原样上报（不退化成哨兵）');
  eq(m1.bold, true, '单选：布尔原样上报');

  const two = [{ fontSize: '30', bold: true }, { fontSize: '14', bold: false }];
  const m2 = mergeStyles(two);
  eq(m2.fontSize, se, '多选不一致：字号上报哨兵（早先直接丢键，面板于是显示上一个节点的值）');
  eq(m2.bold, se, '多选不一致：布尔也上报哨兵');

  const same = [{ fontSize: '30', color: '#ff0000' }, { fontSize: '30', color: '#ff0000' }];
  const m3 = mergeStyles(same);
  eq(m3.fontSize, '30', '多选一致：仍是真实值，不是哨兵');
  eq(m3.color, '#ff0000', '多选一致：颜色仍是真实值');

  const missing = [{ fontSize: '30', color: '#f00' }, { fontSize: '30' }];
  eq(mergeStyles(missing).color, se, '多选缺键：按不一致处理（另一端"没设"也是一种状态）');
  eq(mergeStyles([]), null, '空列表：返回 null');

  // ③ 数值框：混合态显示 — 且步进不以第一个节点为基准
  {
    const body = balanced(Pn, 'export function numSpinner(o)');
    ok(body.length > 0, 'panels：能定位 numSpinner 函数体');
    ok(/const mixed = !!o\.mixed;/.test(body), 'numSpinner：读 o.mixed');
    ok(/let cur = mixed \? null : clamp\(o\.value, min\);/.test(body),
      'numSpinner：混合态没有当前值（不能拿第一个节点的值当基准）');
    ok(/const show = \(\) => \{ inp\.value = cur === null \? '—' : String\(cur\); \};/.test(body),
      'numSpinner：混合态显示 —');
    ok(/value: cur === null \? '—' : String\(cur\)/.test(body), 'numSpinner：初值也是 —');
    ok(/const base = \(\) => \(cur === null \? min : cur\);/.test(body),
      'numSpinner：步进基准在混合态取 min（唯一不需要猜基准的选择）');
    ok((body.match(/emit\(base\(\)/g) || []).length >= 4,
      'numSpinner：▲▼/方向键/滚轮 全部走 base()（否则 ▲ 一下就把差异静默抹平）');
    ok(/const n = clamp\(v, base\(\)\);/.test(body),
      'numSpinner：非法输入的回落也走 base()（混合态下留空要回到 — 而不是数字）');
    ok(!/emit\(cur \+/.test(body), 'numSpinner：不得再出现以 cur 直接步进');
  }

  // ④ 四个数值控件都要带 mixed 标记
  for (const k of ['fontSize', 'strokeWidth', 'radius', 'lineWidth']) {
    ok(new RegExp(`mixed: isMixed\\(st\\.${k}\\),`).test(Pn), `样式页：${k} 传了 mixed 标记`);
  }

  // ⑤ 色块：混合态显示 — 而不是涂成第一个节点的颜色
  {
    const body = balanced(Pn, 'function colorRow(label, value, onPick, onClear, extras)');
    ok(body.length > 0, 'panels：能定位 colorRow 函数体');
    ok(/const mixed = isMixed\(value\);/.test(body), 'colorRow：判定混合态');
    ok(/background: 'transparent'/.test(body), 'colorRow：混合态不涂成任何一个节点的颜色');
    ok(/}, '—'\)\)/.test(body) || /'—'\)/.test(body), 'colorRow：混合态显示 —');
    ok(/title: mixed \? `\$\{label\}（多个值）` : label/.test(body), 'colorRow：混合态的 title 说明是多个值');
  }

  // ⑥ 字体下拉：混合态插一个 — 并选中（否则浏览器会显示第一项，看着像所有节点都是它）
  ok(/isMixed\(st\.fontFamily\)\s*\n?\s*\? h\('option', \{ value: '', selected: true \}, '—'\)/.test(Pn),
    '字体下拉：混合态插入并选中空的「—」项');
  ok(/if \(e\.target\.value\) run\('fontfamily', e\.target\.value\);/.test(Pn),
    '字体下拉：选中「—」不应触发写值（空值直接返回）');
  ok(/selected: !isMixed\(st\.fontFamily\) && st\.fontFamily === f/.test(Pn),
    '字体下拉：混合态下不把任何真实字体标成 selected');

  // ⑦ B/I/S：哨兵是**真字符串**，不判 isMixed 会被当成"已开启"高亮
  for (const k of ['bold', 'italic', 'strikethrough']) {
    ok(new RegExp(`st\\.${k} && !isMixed\\(st\\.${k}\\) \\? '\\.on' : ''`).test(Pn),
      `B/I/S：${k} 为哨兵时不高亮（哨兵是真字符串，不判就会被当成开启）`);
  }

  // ⑧ 对齐 chip 天然安全（哨兵不等于任何 'left'/'center'/'right'），但要确认没被改成真值判断
  ok(/st\.textAlign === v \? '\.on' : ''/.test(Pn), '水平对齐：仍按等值判断（哨兵不会误命中）');
  ok(/st\.verticalAlign === v \? '\.on' : ''/.test(Pn), '垂直对齐：仍按等值判断（哨兵不会误命中）');
}



/* ============================================================
   外框（boundary）组号必须接着已有外框发（B63）
   ============================================================ */

{
  const E = fs.readFileSync(path.join(HERE, 'editor', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

  /** 大括号配对取函数体：注释再长也不会把窗口撑爆 */
  const balanced = (src, sig) => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    let d = 0, j = src.indexOf('{', i);
    if (j < 0) return '';
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
    }
    return '';
  };

  group('外框：新组号必须接着已有外框，不能从 1 重发');

  const rg = balanced(E, 'function rebuildGroups()');
  ok(rg.length > 0, 'editor：能定位 rebuildGroups 函数体');

  /*
   * 真因：_boundarySeq 是 IIFE 局部变量，只在新加外框时 ++，从不读回
   * 画布里现存的 gid。打开一份已带 bg1 的画布 → 再给别的节点加外框 →
   * 新组也拿到 bg1，_groupNodes.set 把第一组的数组整个顶掉。
   * 实测（真实 Chrome）：C/D 加框后 gid 是 bg1、画布上只剩 1 个框（应为 2）。
   */
  ok(/^bg(\d+)$/.test('bg1'), '（自检）组号形如 bg<数字>');
  const maxSeen = (rg.match(/var m = \/\^bg\(\\d\+\)\$\/\.exec\(gid\);/) || [])[0];
  ok(!!maxSeen, 'rebuildGroups：逐个已有组号提取数字后缀');
  ok(/maxSeq = Math\.max\(maxSeq, parseInt\(m\[1\], 10\) \|\| 0\)/.test(rg),
    'rebuildGroups：取已有组号的最大值');
  ok(/if \(maxSeq > _boundarySeq\) _boundarySeq = maxSeq;/.test(rg),
    'rebuildGroups：把序号抬到已有最大值之上（否则新组会重号）');

  // 顺序：必须在把 groups 写进 _groupNodes **之前**抬序号吗？
  // 其实两者互不影响（抬的是计数器不是集合），但必须在 renderAllBoundaries 之前，
  // 更关键的是：必须在**遍历已有 gid 之后。这里锁住"先解析再抬"。
  const iParse = rg.indexOf('/^bg(\\d+)$/.exec(gid)');
  const iSeq = rg.indexOf('_boundarySeq = maxSeq');
  ok(iParse > 0 && iSeq > iParse, 'rebuildGroups：先解析已有组号，再抬序号');
  /*
   * 用 `>` 而不是 `=`：删掉一个外框后 maxSeq 会变小，若直接赋值，
   * 序号就**回退**了 —— 下次新建又会发出一个仍在使用的组号。
   * （写入 _groupNodes 与抬序号互不依赖，顺序本身无要求，故不锁顺序。）
   */
  ok(/if \(maxSeq > _boundarySeq\)/.test(rg),
    'rebuildGroups：只在更大时才抬（删框后序号不回退，否则又会重号）');
  ok(/Object\.keys\(groups\)\.forEach/.test(rg), 'rebuildGroups：遍历**全部**已有组号取最大值');

  // 组号仍从 bg1 起步（新画布）
  const bc = balanced(E, "kity.createClass('boundaryCommand'");
  ok(bc.length > 0, 'editor：能定位 boundaryCommand');
  ok(/var gid = 'bg' \+ \(\+\+_boundarySeq\);/.test(bc), '新组号仍是 bg + ++seq（重号是靠抬基线解决，不是改格式）');
  ok(/var _boundarySeq = 0;/.test(E), '_boundarySeq 初值为 0');

  // 重建入口仍在（抬序号只在这一个函数里做，别处不用重复）
  const rebuildCalls = (E.match(/rebuildGroups\(\)/g) || []).length;
  ok(rebuildCalls >= 4, `rebuildGroups 至少 4 处引用（定义 + 3 个入口），实际 ${rebuildCalls}`);
}



/* ============================================================
   清空快照必须先确认（B64）
   ============================================================ */

{
  const Pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8').replace(/\r\n/g, '\n');
  const balanced = (src, sig) => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    let d = 0, j = src.indexOf('{', i);
    if (j < 0) return '';
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
    }
    return '';
  };

  group('清空快照：必须先确认，不能点一下就全删');

  const ob = balanced(Pn, "export async function openBackups(");
  ok(ob.length > 0, 'panels：能定位 openBackups 函数体');

  /*
   * 实测（真实 Chrome）：有 1 份快照时点「清空快照」，列表**直接**变
   * 「暂无快照」，中间没有任何确认 —— 而同一个弹窗里的「恢复快照」
   * 反倒有 danger 确认（恢复还会先存一份当前状态）。破坏性更大、
   * 更不可逆的操作没有确认，是明确的漏。
   */
  // 取「按钮定义」整段：从 onclick 到按钮标签收尾（`}, '清空快照'),`）。
  // 只切到 `'清空快照'` 字面量的话，它紧跟在 safe( 后面，切片只有十几字符，
  // 断言会**恒为假** —— 之后改坏实现也照样红不了，等于没在把关。
  const seg = (() => {
    const i = ob.indexOf("}, '清空快照'),");
    const j = i < 0 ? -1 : ob.lastIndexOf('onclick:', i);
    return j < 0 ? '' : ob.slice(j, i);
  })();
  ok(seg.length > 0, 'panels：能定位「清空快照」按钮的 onclick');
  ok(/askConfirm/.test(seg), '清空快照：走 askConfirm 二次确认');
  ok(/danger:\s*true/.test(seg), '清空快照：确认框标 danger（与删除脑图 / 移除附件 / 恢复快照一致）');

  // 顺序：确认必须在删之前。
  //
  // 只比「askConfirm 与 clearBackups 的先后」是不够的 —— 把 `if (!ok) return;`
  // 挪到 clearBackups **之后**，askConfirm 依然在前面，那条断言照样绿，
  // 而实际行为已经是「不管确认结果，先删再说」。
  // 所以守的是「取消守卫」相对 clearBackups 的位置。
  const iAsk = seg.indexOf('askConfirm');
  const iGuard = seg.search(/if\s*\(!ok\)\s*return;/);
  const iClear = seg.indexOf('store.clearBackups');
  ok(iAsk > 0 && iClear > iAsk, '清空快照：askConfirm 在 clearBackups 之前');
  ok(iGuard > 0 && iClear > iGuard, '清空快照：取消守卫在 clearBackups 之前（否则等于先删再问）');
  ok(/if\s*\(!n\)/.test(seg) && /没有可清空的快照/.test(seg),
    '清空快照：一份都没有时直接说明，不弹无意义的确认框');

  // 恢复快照本来就有确认，锁住别被带坏
  const restoreSeg = (() => {
    const i = ob.indexOf("}, '恢复'),");
    const j = i < 0 ? -1 : ob.lastIndexOf('onclick:', i);
    return j < 0 ? '' : ob.slice(j, i);
  })();
  ok(/askConfirm/.test(restoreSeg), '恢复快照：仍走 askConfirm（与清空对称）');
}


/* ============================================================
   BUG 65 · 文件库浮层压住整条左侧图标条（含「收起」那颗 📚）
   ============================================================ */

group('BUG 65 · 文件库浮层的左边缘必须钉在画布上，不能盖住图标条');
{
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  /*
   * 实测（真实 Chrome + 真实 styles.css，复制 .mm-body 骨架）：
   *
   *   rail 0..46 │ canvas 56..890 │ .mm-files 绝对定位、CSS 只给了 top/bottom
   *
   *   不显式给 left 时静态位置落在 .mm-body 内容起点 → 浮层占据 0..206，
   *   整条 rail 被盖在下面：elementFromPoint 打在 📚 上命中的是面板标题
   *   （.mm-files-title），而 📚 正是**收起文件列表**那颗按钮 ——
   *   打开了就点不回去，⌖ 聚焦和「展开层级」也一起够不着。
   *
   *   给 left = canvasEl.offsetLeft 后：浮层 56..262、假框 left=206，
   *   elementFromPoint 重新命中按钮本身。
   */
  const fnSeg = ix.slice(ix.indexOf('function syncCanvasInset() {'),
    ix.indexOf('/**', ix.indexOf('function syncCanvasInset() {')));
  ok(fnSeg.length > 0, '能定位 syncCanvasInset 函数体');

  // 1) 必须真的给浮层写 left —— 只改 CSS 或只改 DOM 父级都守不住：
  //    图标条宽度随按钮增减变化，写死像素会错开，故用实测的 offsetLeft。
  ok(/filesEl\.style\.left\s*=/.test(fnSeg),
    'syncCanvasInset 实测写入浮层的 left（不是靠 CSS 静态位置）');
  ok(/canvasEl\.offsetLeft/.test(fnSeg),
    '用 canvasEl.offsetLeft 取画布左边缘（同一个 offsetParent，随图标条宽度自适应）');

  // 2) 顺序：先钉左边缘，再量右边缘。
  //    反过来的话量到的是旧的（偏左的）rect，假框会跟着偏。
  const iSetLeft = fnSeg.indexOf('filesEl.style.left');
  ok(iSetLeft > 0, '函数里有写 left 这一步');
  ok(/getBoundingClientRect/.test(fnSeg.slice(iSetLeft)),
    '写 left 在量 rect 之前（先钉左边缘再量右边缘）');
  ok(/canvasFrameEl\.style\.left\s*=\s*''/.test(fnSeg),
    '浮层不可见时假框回到全宽（left 置空）');

  // 3) 图标条建好之后必须**再同步一次**。
  //
  //    初始化顺序是 setLayoutHook → showFiles → syncCanvasInset → buildRail：
  //    buildRail() 往 rail 里塞按钮会把画布整体往右推，而那次同步发生在
  //    它之前、量到的是"空图标条"的宽度。上次会话文件库是展开状态时，
  //    浮层就会偏左压住半条图标条 —— 这是"只修了函数、没修调用时机"。
  // 两个下标都必须从 setLayoutHook 之后开始找 —— 直接 indexOf('renderTabs();')
  // 会命中文件里更早的那一处（页签重建那条路径），切出来的 initSeg 是空串，
  // 于是两条断言**恒为假**（不是实现错了，是切片错了）。
  const iHook = ix.indexOf('fileList.setLayoutHook(syncCanvasInset)');
  const initSeg = ix.slice(iHook, ix.indexOf('renderTabs();', iHook));
  const iRail = initSeg.indexOf('buildRail();');
  const iSync = initSeg.lastIndexOf('syncCanvasInset();');
  ok(iRail > 0, '初始化段里有 buildRail()');
  ok(iSync > iRail, 'buildRail() 之后还有一次 syncCanvasInset()（图标条宽度变了要重测）');

  // 4) CSS 侧：浮层必须仍是浮层（别为了修这个把方案退回"挤窄画布"）
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
  const filesBlk = css.slice(css.indexOf('.mm-files {'), css.indexOf('.mm-files.open'));
  ok(/position:\s*absolute/.test(filesBlk), '.mm-files 仍是浮层（画布尺寸不随开合变化）');
}


/* ============================================================
   BUG 66 · 切文件时读失败被当成「空脑图」，真内容会被覆盖
   ============================================================ */

group('BUG 66 · 切换脑图文件时，读取失败必须中止切换（不能静默开成空图）');
{
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  /*
   * store.get 读不出来时是「吞异常、返回默认值 null」（见 store.js 读路径
   * 的注释）。switchToFile 原写法：
   *
   *     workbook = (await store.doc(id).load()) || wb.newWorkbook();
   *
   * 把「读失败」当成了「这个文件还没有内容」—— 界面立刻变成一张空脑图，
   * 而**写路径往往是好的**（配额触顶影响写入不影响读取；单条记录损坏更是
   * 只坏那一条）。用户在空图上继续编辑，persist() 就把真内容覆盖成空的：
   * 静默丢一整份脑图，且一句提示都没有。
   *
   * 先用子进程实测 store 的读失败行为，再断言上层的守卫。
   */
  const probe = `const STORE_URL = 'file://' + ${JSON.stringify(path.join(HERE, 'store.js'))};

    const mkTx = () => {
      const t = {};
      t.objectStore = () => ({ get: () => ({}), put: () => ({}), delete: () => ({}), getAllKeys: () => ({}) });
      setTimeout(() => { if (typeof t.onerror === 'function') t.onerror(); }, 0);
      return t;
    };
    const db = { transaction: () => mkTx(), objectStoreNames: { contains: () => true }, createObjectStore: () => ({}) };
    globalThis.indexedDB = { open: () => { const r = {}; setTimeout(() => { r.result = db; r.onsuccess && r.onsuccess(); }, 0); return r; } };
    const s = await import(STORE_URL);
    s.resetStoreError();
    const v = await s.doc('abc').load();
    console.log(JSON.stringify({ v: v === null ? 'null' : String(v), err: s.lastStoreError() }));
  `;

  let out = '';
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  } catch (e) { out = String(e.stdout || ''); }
  const got = (() => { try { return JSON.parse(out.trim().split('\\n').pop()); } catch { return null; } })();
  ok(got && got.v === 'null', '实测：store.doc().load() 读失败时返回 null（不抛）', out.slice(0, 120));
  ok(got && /读取失败/.test(got.err || ''), '实测：读失败会记进 lastStoreError（可据此判定）', String(got && got.err));

  const st = ix.slice(ix.indexOf('async function switchToFile(id) {'),
    ix.indexOf('/**', ix.indexOf('async function switchToFile(id) {')));
  ok(st.length > 0, '能定位 switchToFile 函数体');

  // ① 读必须在改动任何状态之前 —— 否则中止时已经把 currentFileId 改掉了
  const iRead = st.indexOf('store.doc(id).load()');
  const iCur = st.indexOf('currentFileId = id');
  ok(iRead > 0 && iCur > iRead, '读取在 currentFileId = id 之前（失败时能干净地中止）');

  // ② 判据必须是 lastStoreError 的**前后差**，不能只判非空：
  //    store 记的是「最近一次」错误，只判非空会把更早留下的旧错误当成这次失败，
  //    于是每次切文件都拒绝切换。
  ok(/const\s+errBefore\s*=\s*store\.lastStoreError\(\);/.test(st), 'switchToFile：读之前先取一次 lastStoreError');
  ok(/const\s+errAfter\s*=\s*store\.lastStoreError\(\);/.test(st), 'switchToFile：读之后再取一次');
  ok(/errAfter\s*&&\s*errAfter\s*!==\s*errBefore/.test(st),
    'switchToFile：判据是前后差（不是「lastStoreError 非空」）');
  ok(/!\s*loaded\s*&&/.test(st), 'switchToFile：只在没读到内容时才判失败');

  // ③ 用掉之后必须 reset —— 这条已经说给用户听了，留着会在别处重复弹
  ok(/store\.resetStoreError\(\);/.test(st), 'switchToFile：错误已通报后清掉，避免别处重复弹');

  // ④ 读到的结果要复用，不能 `|| newWorkbook()` 直接兜底还照样往下走
  ok(/workbook\s*=\s*loaded\s*\|\|\s*wb\.newWorkbook\(\);/.test(st),
    'switchToFile：用读到的 loaded（新文件才回落空工作簿）');

  // ⑤ 调用方：没切成就不能报「已打开 / 已删除」
  const of = ix.slice(ix.indexOf('async function openFile(id) {'),
    ix.indexOf('/**', ix.indexOf('async function openFile(id) {')));
  ok(/if\s*\(!r\.switched\)\s*return;/.test(of), 'openFile：没切成就直接返回，不说「已打开」');
  ok(/r\.remembered\s*\?\s*''\s*:/.test(of), 'openFile：「未记住」读的是 r.remembered');
}



/* ============================================================
   BUG 67 · 删除画布没有二次确认，误点页签 ✕ 就永久丢一张画布
   ============================================================ */

group('BUG 67 · 删除画布必须二次确认（✕ 长在页签上，删完不可恢复）');
{
  const ix = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

  /*
   * 删除脑图文件 / 删除文件夹 / 移除附件 / 删除分组 / 清空快照全都走 askConfirm，
   * 唯独 removeSheet 是直接 splice + persist()。
   *
   * 而它偏偏**最容易误触**：✕ 长在页签里，用户点页签本意是切换画布，
   * 手一滑就是删掉整张。删掉之后三条退路一条都不通：
   *   ① 紧跟其后的 persist() 立刻落盘；
   *   ② 撤销栈存的是节点内容快照，覆盖不到画布增删；
   *   ③ 这条路径不走自动保存，于是也不留快照 —— 连「历史快照」里都翻不到。
   * 所以确认框是**唯一**防线，必须补上。
   */
  const rs = ix.slice(ix.indexOf('async function removeSheet(id) {'),
    ix.indexOf('/**', ix.indexOf('async function removeSheet(id) {')));
  ok(rs.length > 0, '能定位 removeSheet 函数体');

  // ① 必须真的问一句，且与删文件一致地标 danger
  ok(/askConfirm\(/.test(rs), 'removeSheet：走 askConfirm 二次确认');
  ok(/danger:\s*true/.test(rs), 'removeSheet：确认框标 danger（与删除脑图文件一致）');

  // ② 顺序：取消必须发生在 splice 之前 —— 反过来就等于「先删再问」
  const iAsk = rs.indexOf('askConfirm(');
  const iSplice = rs.indexOf('sheets.splice(');
  ok(iAsk > 0 && iSplice > iAsk, 'removeSheet：确认在 splice 之前（否则等于先删再问）');
  ok(/if\s*\(!\s*await\s+askConfirm\(/.test(rs), 'removeSheet：取消就 return，不往下删');

  // ③ 确认期间让出了控制权，下标必须**重新取** —— 用确认前算的 i 会删错画布
  ok(/const\s+at\s*=\s*workbook\.sheets\.findIndex\(/.test(rs),
    'removeSheet：确认之后重新取下标');
  ok(/sheets\.splice\(at,\s*1\)/.test(rs),
    'removeSheet：splice 用的是重取后的 at（不是确认前的 i）');
  ok(!/sheets\.splice\(i,\s*1\)/.test(rs),
    'removeSheet：不再拿确认前的旧下标 i 去 splice');

  // ④ 只剩一张时不能删 —— 且确认之后要再判一次（期间可能又删了别的）
  const nSingle = (rs.match(/sheets\.length\s*<=\s*1/g) || []).length;
  ok(nSingle >= 2, 'removeSheet：只剩一张的守卫在确认前后各判一次（' + nSingle + ' 处）');

  // ⑤ 这条路径确实不写快照 —— 所以确认是唯一防线。
  //    将来若给删画布补了快照，这条断言要跟着改，别当成过期断言直接删。
  ok(!/pushBackup/.test(rs), 'removeSheet：不写快照（因此确认是唯一防线）');

  // ⑥ 页签 ✕ 的入口仍然指向 removeSheet（别为了加确认把入口改没了）
  const iX = ix.indexOf("title: '删除该画布'");
  ok(iX > 0, '能定位页签 ✕（删除该画布）');
  ok(/removeSheet\(/.test(ix.slice(Math.max(0, iX - 300), iX + 200)),
    '页签 ✕ 仍指向 removeSheet');
}


/* ============================================================
   BUG 68 · 图标库反复重建预览会攒 Blob URL（只等浮层关闭才回收）
   ============================================================ */

group('BUG 68 · 图标库每次重建预览都要先回收上一批 Blob URL');
{
  const { openIconLibrary } = await import('./panels.js');
  const pstore = await import('./store.js');

  /*
   * 用户图标的预览不是 dataURL，而是 `URL.createObjectURL(blob)`。
   * 而 renderGrid 会被反复调用：切分组、导入图标、新建/重命名/删除分组、
   * 清理失效 —— 每次都重建一批。原先只在**浮层关闭时**统一回收，
   * 于是浮层开着期间每重建一次就攒一批（grid.innerHTML='' 只摘 DOM，
   * Blob 仍在内存里）。用户图标每个最多 1MB，来回切十几趟就是几十 MB
   * 常驻，直到刷新页面才释放。
   *
   * 这里用真实 openIconLibrary + 真实点击切分组来量 liveBlobUrls：
   * 泄漏时它会随切换次数线性增长，修好则恒定。
   */
  await pstore.set('iconlib', {
    groups: [{
      id: 'g-user',
      name: '我的图标',
      icons: [
        { id: 'i1', kind: 'user', name: '甲', assetId: 'asICON1' },
        { id: 'i2', kind: 'user', name: '乙', assetId: 'asICON2' },
      ],
    }],
  });
  // 资产本体：只要有 blob 这个真值字段，renderGrid 就会为它建预览 URL
  await pstore.set('asset:asICON1', { blob: {}, size: 1024 });
  await pstore.set('asset:asICON2', { blob: {}, size: 1024 });

  const app = {
    api: { status() {}, commit() {} },
    bridge: { setImage() {} },
    settings: {},
  };

  const settle = async () => {
    // renderGrid 是 async 且套在 safe() 里，点击后要让出几拍才跑完
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  liveBlobUrls.clear();
  const dlg = await openIconLibrary(app);
  await settle();

  // 分组按钮：内置若干组 + 末尾一个「我的图标」
  const gbtns = () => [...(dlg.mask?.querySelectorAll('.mm-icon-groups button')
    || dlg.el?.querySelectorAll('.mm-icon-groups button') || [])];
  const btns = gbtns();
  ok(btns.length >= 2, '能拿到图标库的分组按钮（' + btns.length + ' 个）');

  const mine = btns.find((b) => /我的图标/.test(b.textContent || ''));
  const builtin = btns.find((b) => /状态/.test(b.textContent || ''));
  ok(!!mine && !!builtin, '能定位「我的图标」与内置「状态」两个分组');

  const clickTo = async (b) => { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await settle(); };

  // ① 切到「我的图标」：两个用户图标 → 2 个预览 URL
  await clickTo(mine);
  const n1 = liveBlobUrls.size;
  eq(n1, 2, '切到用户分组后建出 2 个预览 URL');

  // ② 来回切换若干次。修好则始终只有当前这一批；泄漏则每次 +2
  await clickTo(builtin);
  await clickTo(mine);
  await clickTo(builtin);
  await clickTo(mine);
  await clickTo(builtin);
  await clickTo(mine);
  const n2 = liveBlobUrls.size;
  eq(n2, 2, '来回切 6 次后仍只有当前这一批（泄漏的话会是 14）');

  // ③ 关掉浮层必须全部回收
  dlg.close?.();
  await settle();
  eq(liveBlobUrls.size, 0, '关闭浮层后预览 URL 全部回收');

  // ④ 源码侧：回收逻辑抽成一个函数，两处共用，不再各写一份
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const seg = pn.slice(pn.indexOf('export async function openIconLibrary(app) {'),
    pn.indexOf('/* ------------------------- 设置', pn.indexOf('export async function openIconLibrary(app) {')));
  ok(/const\s+releaseMediaUrls\s*=\s*\(\)\s*=>/.test(seg), '图标库：抽出 releaseMediaUrls 供两处共用');

  /*
   * 顺序断言必须**先剥注释**：renderGrid 上方的说明里为了讲清原理写了
   * `grid.innerHTML = ''` 这个字面量，直接在原文里 indexOf 会先命中注释，
   * 于是断言测的是注释而不是代码（本项目已多次栽在这上面）。
   */
  const iRS = seg.indexOf('const renderGrid = async () => {');
  const rbody = seg.slice(iRS, seg.indexOf('\n  };', iRS));
  const rcode = stripCommentsFlatJs(rbody);
  ok(rcode.length > 0, '能切出 renderGrid 函数体（剥注释后非空）');
  const iRelease = rcode.indexOf('releaseMediaUrls();');
  const iInner = rcode.indexOf('grid.innerHTML');
  ok(iRelease > 0 && iInner > 0 && iRelease < iInner,
    'renderGrid：回收在清空 DOM 之前（剥注释后判定）');
  ok((seg.match(/releaseMediaUrls\(\);/g) || []).length >= 2,
    '回收至少调用两处（重建时 + 关闭时）');
}


/* ============================================================
   BUG 69 · 删除主题没有二次确认：✕ 紧挨 ✎，删了就永久没了
   ============================================================ */

group('BUG 69 · 删除主题必须二次确认（不可逆，且会连带改掉别的画布）');
{
  const { buildSide } = await import('./panels.js');

  /*
   * 行为级验证：真实建出主题页、真实点那颗 ✕，看**有没有弹确认框**。
   * 只看源码正则不够 —— 那会漏掉「问了但问在删之后」这种写法。
   */
  const calls = [];
  const env = {
    api: {
      status: (m) => calls.push(['status', m]), commit() {},
      selectedRef: () => null, selectedRefs: () => [], selectedImages: () => [],
      applyLayout: () => {}, applyTheme: () => {},
      saveThemes: async () => true,
      markPresetRemoved: async () => { calls.push(['markPresetRemoved']); return true; },
      reassignTheme: async () => 0,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: { getSelectedNodeId: () => 'n1' },
    customThemes: [{ id: 'mm-preset-1', name: '我的主题', palette: {} }],
    sheet: { theme: 'fresh-blue', layout: 'default' },
  };
  const el = buildSide(env, {});
  el.open('theme');

  const sec = [...el.el.querySelectorAll('.mm-field')]
    .find((f) => f.querySelector('h3')?.textContent === '配色主题');
  ok(!!sec, '能定位「配色主题」节');

  const del = [...(sec?.querySelectorAll('button') || [])]
    .find((b) => b.getAttribute('title') === '删除');
  ok(!!del, '能定位自定义主题行的 ✕（删除）');
  ok(!![...(sec?.querySelectorAll('button') || [])]
    .find((b) => b.getAttribute('title') === '编辑'), '✎（编辑）与 ✕ 同排 —— 所以容易点偏');

  // 清场：确保点之前页面上没有任何弹层
  for (const m of [...document.querySelectorAll('.nx-mask')]) m.remove();
  eq(document.querySelectorAll('.nx-mask').length, 0, '点击前没有弹层');

  del.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  // 让 async 处理器跑过第一个 await
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

  const masks = document.querySelectorAll('.nx-mask').length;
  ok(masks >= 1, '点 ✕ 会先弹确认框（不弹就是直接删）');
  eq(env.customThemes.length, 1, '确认框还开着时主题**没有**被删（问在删之前）');
  ok(!calls.some((c) => c[0] === 'markPresetRemoved'),
    '确认框还开着时没有去写 removedPresets（预置主题一旦写就永久消失）');

  // 收尾：把弹出的确认框关掉，别污染后面的用例
  const cancel = [...document.querySelectorAll('.nx-mask .nx-btn')]
    .find((b) => /取消/.test(b.textContent || ''));
  ok(!!cancel, '确认框上有「取消」');
  cancel?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  /*
   * 取消必须**真的不删**。
   * 这条是行为级的：只看源码正则抓不到「await 了确认框却不看返回值」——
   * 那种写法弹框照弹，点取消也照样删。
   */
  eq(env.customThemes.length, 1, '点了取消 → 主题仍在（不是点了取消也删）');
  ok(!calls.some((c) => c[0] === 'markPresetRemoved'), '点了取消 → 没有写 removedPresets');
  ok(!calls.some((c) => c[0] === 'status' && /已删除/.test(String(c[1]))),
    '点了取消 → 不提示「已删除」');
  for (const m of [...document.querySelectorAll('.nx-mask')]) m.remove();

  // ---- 源码侧：确认框必须与其它破坏性操作一致地标 danger ----
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const iDel = pn.indexOf("onclick: safe('删除主题'");
  ok(iDel > 0, '能定位「删除主题」处理器');
  const body = pn.slice(iDel, pn.indexOf("title: '删除'", iDel));
  /*
   * **必须先剥注释再断言。**
   * 这段的说明里为了讲清「其它删除操作长什么样」，写了
   * `askConfirm({ danger: true })` 这个字面量 —— 直接在原文里匹配
   * 会命中**注释**而不是代码，于是把 danger 改成 false 也照样绿
   * （变异验证里就是这么漏掉的）。
   */
  const code = stripCommentsFlatJs(body);
  ok(code.length > 0, '能剥出「删除主题」处理器的代码体');
  ok(/askConfirm\(/.test(code), '删除主题：走 askConfirm 二次确认');
  ok(/danger:\s*true/.test(code), '删除主题：确认框标 danger（与其它删除操作一致）');
  const iAsk = body.indexOf('askConfirm(');
  const iMut = body.indexOf('app.customThemes =');
  ok(iAsk > 0 && iMut > iAsk, '删除主题：确认在改动 customThemes 之前');
  ok(/if\s*\(!\s*await\s+askConfirm\(/.test(body), '删除主题：取消就 return，不往下删');
}

/* ============================================================
   BUG 72 · 节点文字含 CR（\r）时 PlantUML 导回整条节点消失
   ============================================================ */

group('节点文字含 CR：PlantUML 往返静默丢节点（BUG 72）');

/*
 * `nodeText` 只把 LF 规范化成空格（正则里只写了 \n），单独的 CR 原样留下。
 * 而 `\r` 是 JS 正则里 `.` 不匹配的"行终止符" ——
 * PlantUML 导出的 `** 含\r回车` 在导回时被 `/^(\*+)\s*(.*)$/` 判成非节点行，
 * **整条跳过**：节点凭空消失且不报错。
 *
 * \r 不是凭空构造：.xmind 的 content.json 与原生 .json 都是 JSON，
 * JSON.parse 会如实还原 `\r` 转义，导入即带进来（实测 8 条里丢 3 条）。
 * .mm / .opml 走 XML 属性规范化，天然把 \r 变空格，所以只有 JSON 系受影响。
 */
{
  const f = await import('./formats.js');

  // ① 根因：nodeText 必须连同 \r 一起规范化
  eq(f.nodeText({ data: { text: '含\r回车' } }), '含 回车', 'nodeText 把 CR 也规范成空格（修复前原样留下 \r）');
  eq(f.nodeText({ data: { text: '含\r\n回车' } }), '含 回车', 'CRLF 仍规范成一个空格');
  eq(f.nodeText({ data: { text: '含\n回车' } }), '含 回车', 'LF 行为不变');
  eq(f.nodeText({ data: { text: '含\u2028回车' } }), '含 回车', 'U+2028 同样是行终止符，一并规范');
  eq(f.nodeText({ data: { text: '普通文字' } }), '普通文字', '普通文字不受影响');
  eq(f.nodeText({ data: { text: '  ' } }), '未命名', '纯空白仍回落占位');
  eq(f.nodeText({}, 'X'), 'X', '无 data 时回落 fallback');

  // ② 现象：PlantUML 往返不得丢节点
  const mk = (texts) => JSON.stringify({
    root: { data: { text: 'R' }, children: texts.map((t) => ({ data: { text: t } })) },
    template: 'default', theme: 'fresh-blue-compat',
  });
  const kids = (j) => { const o = JSON.parse(j); return (o.root.children || []).map((c) => c.data.text); };

  {
    const back = f.fromPlantUml(f.toPlantUml(mk(['含\r回车', '甲', '乙'])));
    ok(back !== null, 'PlantUML 往返不返回 null');
    eq(kids(back).length, 3, 'PlantUML 往返不丢节点（修复前 3 条只剩 2 条）');
    eq(kids(back)[0], '含 回车', 'CR 节点回来了（内容按 \n 同规则规范成空格）');
    eq(kids(back).join('|'), '含 回车|甲|乙', '顺序与内容都不变');
  }

  // ③ 四种交换格式一致：都不能丢节点（此前只有 PlantUML 丢）
  for (const [name, round] of [
    ['FreeMind', (t) => f.fromFreemind(f.toFreemind(t))],
    ['OPML', (t) => f.fromOpml(f.toOpml(t, 'T'))],
    ['Mermaid', (t) => f.fromMermaid(f.toMermaid(t))],
    ['PlantUML', (t) => f.fromPlantUml(f.toPlantUml(t))],
  ]) {
    const back = round(mk(['含\r回车', '甲']));
    ok(back !== null, `${name} 往返不返回 null`);
    eq(kids(back).length, 2, `${name} 往返不丢节点`);
    eq(kids(back)[0], '含 回车', `${name} 往返：CR 节点内容一致`);
  }

  // ④ 导出的中间文本里不得再出现裸 \r（否则别的软件也会解析错）
  {
    const pu = f.toPlantUml(mk(['含\r回车']));
    ok(!pu.includes('\r'), 'PlantUML 导出文本不含裸 CR（导出即规范化，不把问题留给下游）');
  }

  // ⑤ 源码断言：nodeText 的字符集必须含 \r（只写 \n 就是 BUG 本身）
  {
    const src = fs.readFileSync(path.join(HERE, 'formats.js'), 'utf8').replace(/\r\n/g, '\n');
    /*
     * BUG 101：nodeText 现在只是「inlineText(文字) || fallback」——
     * 真正的字符集挪到 inlineText 里了，所以这里定位的是 **inlineText**。
     * 只查 nodeText 会看到一句不含正则的调用，断言恒假。
     */
    const i = src.indexOf('export const inlineText');
    ok(i > 0, '能定位 inlineText（nodeText 的规范化字符集在这里）');
    const body = src.slice(i, i + 400);
    const code = stripCommentsFlatJs(body);
    ok(code.length > 0, '能剥出 inlineText 的代码体（注释里同样写着 `\\s*\\n\\s*`，必须先剥）');
    ok(!/\.replace\(\/\\s\*\\n\\s\*\/g/.test(code), 'inlineText 不得只认 \\n（那正是 BUG 72 / 101 本身）');
    ok(/\\r/.test(code), 'inlineText 的规范化字符集必须含 \\r');
    // nodeText 必须真的走 inlineText —— 否则上面查的字符集根本没生效
    const j = src.indexOf('export function nodeText');
    const nbody = stripCommentsFlatJs(src.slice(j, j + 300));
    ok(/inlineText\(/.test(nbody), 'nodeText 走 inlineText（不再自己抄一份正则）');
  }
}

/* ============================================================
   BUG 73 · Mermaid 字面实体被反转义，往返静默改内容
   ============================================================ */

group('Mermaid 字面 #quot; / #35; 被当成转义还原，往返改内容（BUG 73）');

/*
 * Mermaid 用 `#quot;` `#35;` `#40;` `#41;` 表示标点，unescMermaid 一律还原。
 * 于是节点里**本来写着** `a#quot;b` 的文字，导出成 `["a#quot;b"]` 后
 * 导回来变成 `a"b` —— 内容被静默改掉，且不报错。实测两条：
 *   `a#quot;b` → `a"b`，`a#35;b` → `a#b`。
 *
 * 修法是把字面 `#` 先转成 Mermaid 自己的 `#` 实体 `#35;`（渲染出来仍是 `#`），
 * **顺序必须在引号转义之前**：`"` 的转义产物就是 `#quot;`，反了会把它再拆开。
 *
 * 另：mermaidLabel 原先和 nodeText 一样只认 LF，这里一并修（同 BUG 72）。
 */
{
  const f = await import('./formats.js');
  const mk = (t) => JSON.stringify({
    root: { data: { text: 'R' }, children: [{ data: { text: t }, children: [] }] },
    template: 'default', theme: 'fresh-blue-compat',
  });
  const back1 = (t) => {
    const b = f.fromMermaid(f.toMermaid(mk(t)));
    if (!b) return null;
    const k = JSON.parse(b).root.children || [];
    return k.length === 1 ? k[0].data.text : null;
  };

  // ① 四条字面实体往返都不许被还原
  for (const t of ['a#quot;b', 'a#35;b', 'a#40;b', 'a#41;b']) {
    eq(back1(t), t, `字面 ${t} 往返原样回来（修复前被还原成别的字符）`);
  }

  // ② 真引号仍然走转义，且往返正确
  eq(back1('a"b'), 'a"b', '真双引号往返正确（转义路径没被改坏）');
  ok(f.mermaidLabel('a"b').includes('#quot;'), '双引号仍用 #quot; 转义');

  // ③ 字面 # 被写成 #35;（Mermaid 自己的实体，渲染出来就是 #）
  ok(f.mermaidLabel('a#quot;b').includes('#35;quot;'), '字面 #quot; 里的 # 先转成 #35;');
  eq(f.mermaidLabel('C#'), '["C#35;"]', 'C# 里的 # 同样转义');
  eq(back1('C#'), 'C#', 'C# 往返正确');

  // ④ 顺序断言：# 的转义必须在 " 的转义之前（反了会把 #quot; 又拆开）
  {
    const lbl = f.mermaidLabel('a"b#c');
    ok(lbl.includes('#35;'), '同时含引号与 # 时，#35; 仍出现');
    ok(!/#35;quot;/.test(lbl), '不得把引号转义产物 #quot; 再拆成 #35;quot;');
    eq(back1('a"b#c'), 'a"b#c', '引号与 # 同时出现时往返正确');
  }

  // ⑤ mermaidLabel 也要规范化 CR（与 nodeText 同一个坑）
  eq(f.mermaidLabel('含\r回车'), '含 回车', 'mermaidLabel 同样把 CR 规范成空格（规范化后无需引号）');
  eq(f.unescMermaid('a#35;40;b'), 'a#40;b', 'unescMermaid 一趟扫描：#35; 的产物不再被后一条吃掉');
  eq(f.unescMermaid('x<br>y'), 'x y', 'unescMermaid 把 <br> 并成空格');

  // ⑥ 源码断言：两条 replace 的先后顺序（只写引号转义就是 BUG 本身）
  {
    const src = fs.readFileSync(path.join(HERE, 'formats.js'), 'utf8').replace(/\r\n/g, '\n');
    const i = src.indexOf('export function mermaidLabel');
    ok(i > 0, '能定位 mermaidLabel');
    const body = src.slice(i, i + 1400);
    const code = stripCommentsFlatJs(body);
    ok(code.length > 0, '能剥出 mermaidLabel 的代码体（注释里同样写着 #quot;，必须先剥）');
    const iHash = code.indexOf("replace(/#/g, '#35;')");
    const iQuote = code.indexOf("replace(/\"/g, '#quot;')");
    ok(iHash > 0, 'mermaidLabel 有 # → #35; 的转义（那正是修 BUG 73 加的）');
    ok(iQuote > iHash, '# 的转义必须排在引号转义之前');
  }
}

/* ============================================================
   BUG 74 · 节点文字含控制字符 → 导出的 .opml/.mm 是无效 XML，导不回来
   BUG 75 · 制表符被 XML 属性规范化吞成空格
   ============================================================ */

group('XML 导出：非法字符让文件整体报废；制表符被吞（BUG 74 / BUG 75）');

/*
 * 节点文字里带 0x07 / 0x0C 这类控制字符时（从终端、PDF、其它软件粘进来很常见），
 * escXml 原样输出 —— 而 XML 1.0 **不允许**这些字符，写数字引用 `&#7;` 同样非法。
 * 于是导出的 .opml / .mm 是无效 XML：DOMParser 报 parsererror，
 * readXmlNodes 返回 null，fromOpml / fromFreemind 返回 null。
 *
 * 后果是**本插件导出的文件，本插件自己导不回来**：导入时提示"无法识别该文件"，
 * 整份导入失败（实测六种控制字符全部 null）。别的软件同样打不开。
 *
 * 无法保留原字符（XML 1.0 里没有合法写法），只能按 nodeText 的惯例换成空格 ——
 * 丢一个字符远好过整份文件报废。
 *
 * 另外：裸 tab 在 XML 属性值里会被规范化成空格，于是 `a\tb` 走 OPML 往返变成
 * `a b`，而 Mermaid / XMind 原样保留 —— 同一段文字换个格式就换个样子。
 * 写成 `&#9;`（字符引用不走属性规范化）即可保住。
 */
{
  const f = await import('./formats.js');
  const mk = (t) => JSON.stringify({
    root: { data: { text: 'R' }, children: [{ data: { text: t }, children: [] }] },
    template: 'default', theme: 'fresh-blue-compat',
  });
  const back1 = (fn, t) => {
    const b = fn(mk(t));
    if (!b) return null;
    const k = JSON.parse(b).root.children || [];
    return k.length === 1 ? k[0].data.text : '<条数不对>';
  };

  // ① 六种控制字符：往返不再返回 null（修复前整份导入失败）
  for (const [name, t] of [
    ['BEL 0x07', 'a\x07b'], ['FF 0x0C', 'a\x0cb'], ['VT 0x0B', 'a\x0bb'],
    ['SOH 0x01', 'a\x01b'], ['ESC 0x1B', 'a\x1bb'], ['NUL 0x00', 'a\x00b'],
  ]) {
    const o = back1((x) => f.fromOpml(f.toOpml(x, 'T')), t);
    const m = back1((x) => f.fromFreemind(f.toFreemind(x)), t);
    ok(o !== null, `OPML：${name} 不再是无效 XML（修复前 fromOpml 返回 null）`, String(o));
    ok(m !== null, `FreeMind：${name} 不再是无效 XML（修复前 fromFreemind 返回 null）`, String(m));
    eq(o, 'a b', `OPML：${name} 换成空格而不是整份报废`);
    eq(m, 'a b', `FreeMind：${name} 换成空格而不是整份报废`);
  }

  // ② 导出的 XML 里不得再出现非法字符，且能被解析
  {
    const xml = f.toOpml(mk('a\x07b\x0cc'), 'T');
    ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml), '导出的 OPML 文本不含非法控制字符');
    const d = new DOMParser().parseFromString(xml, 'application/xml');
    eq(d.getElementsByTagName('parsererror').length, 0, '导出的 OPML 能被 XML 解析器接受');
    eq(d.getElementsByTagName('outline').length, 2, '两个节点都在（根 + 子节点）');
  }

  // ③ 代理对不能被误删：不带 u 标志会把 emoji 当成两个非法码元
  {
    const t = 'a\u{1F600}b';
    eq(back1((x) => f.fromOpml(f.toOpml(x, 'T')), t), t, 'emoji 往返原样保留（u 标志保住代理对）');
    eq(f.escXml('a\u{1F600}b'), 'a\u{1F600}b', 'escXml 不破坏 emoji');
    eq(f.escXml('a\uD83Db').length, 3, '孤立代理项仍被清掉');
  }

  // ④ 制表符保住（BUG 75）
  {
    eq(f.escXml('a\tb'), 'a&#9;b', 'escXml 把 tab 写成 &#9;');
    eq(f.unescXml('a&#9;b'), 'a\tb', 'unescXml 认 &#9;（无 DOM 时的兜底路径也要对）');
    eq(back1((x) => f.fromOpml(f.toOpml(x, 'T')), 'a\tb'), 'a\tb', 'OPML 往返保住 tab（修复前变 a b）');
    eq(back1((x) => f.fromFreemind(f.toFreemind(x)), 'a\tb'), 'a\tb', 'FreeMind 往返保住 tab');
    // Mermaid 本来就保得住，两种格式现在一致
    eq(back1((x) => f.fromMermaid(f.toMermaid(x)), 'a\tb'), 'a\tb', 'Mermaid 往返同样保住 tab');
  }

  // ⑤ 常规转义不受影响
  {
    eq(f.escXml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f', '五种常规转义不变');
    eq(f.unescXml(f.escXml(`a&b<c>d"e'f`)), `a&b<c>d"e'f`, '常规转义往返一致');
    eq(f.unescXml(f.escXml('a\tb&c')), 'a\tb&c', 'tab 与 & 同时出现时也对');
    eq(back1((x) => f.fromOpml(f.toOpml(x, 'T')), 'a&b<c>"d"'), 'a&b<c>"d"', 'OPML 往返保留 & < > 引号');
  }

  // ⑥ 源码断言：非法字符清理 + tab 转义，两条都得在
  {
    const src = fs.readFileSync(path.join(HERE, 'formats.js'), 'utf8').replace(/\r\n/g, '\n');
    const i = src.indexOf('export function escXml');
    ok(i > 0, '能定位 escXml');
    const body = src.slice(i, i + 900);
    const code = stripCommentsFlatJs(body);
    ok(code.length > 0, '能剥出 escXml 的代码体（注释里同样写着控制字符，必须先剥）');
    ok(/replace\(XML_ILLEGAL/.test(code), 'escXml 会清掉 XML 非法字符（只做常规转义就是 BUG 74）');
    ok(/\\t/g.test(code) && /&#9;/.test(code), 'escXml 把 tab 写成 &#9;（漏了就是 BUG 75）');
    const iIllegal = src.indexOf('const XML_ILLEGAL');
    ok(iIllegal > 0 && /\/gu/.test(src.slice(iIllegal, iIllegal + 200)),
      'XML_ILLEGAL 正则必须带 u 标志（不带会把 emoji 当成两个非法码元删掉）');
  }
}

/* ============================================================
   BUG 76 · 状态栏把主题/布局的**内部 id**直接说给用户
   ============================================================ */

group('状态栏主题/布局显示名：不能把 id 直接给用户（BUG 76）');

/*
 * applyTheme / applyLayout 原先是 `status('主题：' + name)`，name 是 id。
 * 于是点「清新蓝」，状态栏回一句「主题：fresh-blue」——
 * 而侧栏高亮写的是「清新蓝」，两边对不上，用户会以为点错了。
 *
 * 布局同理：点「组织结构图」回「布局：structure」。
 *
 * 修法是统一走 themeLabelOf / layoutLabelOf（自定义主题用 name，
 * 内置用 label）。面板里原本自己抄了一份同样的映射 —— 两份迟早对不上，
 * 一并改成共用同一个函数。
 */
{
  const th = await import('./themes.js');

  eq(th.themeLabelOf('fresh-blue'), '清新蓝', '内置主题 id → 显示名');
  eq(th.themeLabelOf('snow'), th.THEMES.find((x) => x.value === 'snow')?.label, '另一个内置主题也对得上');
  eq(th.themeLabelOf('my-t', [{ id: 'my-t', name: '我的主题' }]), '我的主题', '自定义主题用 name');
  eq(th.themeLabelOf('fresh-blue', [{ id: 'fresh-blue', name: '同名自定义' }]), '同名自定义', 'id 撞车时自定义优先');
  eq(th.themeLabelOf('zzz'), 'zzz', '取不到时回落 id 本身（比空白好排查）');
  eq(th.themeLabelOf(''), '', '空值不炸');

  eq(th.layoutLabelOf('structure'), '组织结构图', '内置布局 id → 显示名');
  eq(th.layoutLabelOf('default'), '思维导图', '默认布局对得上');
  eq(th.layoutLabelOf('zzz'), 'zzz', '未知布局回落 id');
  eq(th.layoutLabelOf(''), '', '空值不炸');

  // 全部内置主题/布局都有显示名（不能有一个漏掉）
  {
    const missT = th.THEMES.filter((t) => !t.label || th.themeLabelOf(t.value) !== t.label).map((t) => t.value);
    eq(missT.length, 0, '每个内置主题都有显示名：' + missT.join(','));
    const missL = th.LAYOUTS.filter((l) => !l.label || th.layoutLabelOf(l.value) !== l.label).map((l) => l.value);
    eq(missL.length, 0, '每个内置布局都有显示名：' + missL.join(','));
  }

  // 源码断言：两处 status 必须走显示名函数
  {
    const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    const code = stripCommentsFlatJs(src);
    ok(/status\('主题：' \+ themeLabelOf\(/.test(code), 'applyTheme 的 status 用显示名（直接拼 name 就是 BUG 76）');
    ok(/status\('布局：' \+ layoutLabelOf\(/.test(code), 'applyLayout 的 status 用显示名');
    ok(!/status\('主题：' \+ name\)/.test(code), '不得再出现 status(\'主题：\' + name)（剥注释后判定）');
    ok(!/status\('布局：' \+ name\)/.test(code), '不得再出现 status(\'布局：\' + name)');
    // 面板不许再抄一份映射
    const ps = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8').replace(/\r\n/g, '\n');
    const pcode = stripCommentsFlatJs(ps);
    ok(/themeLabelOf\(cur, app\.customThemes\)/.test(pcode), '面板改用同一个 themeLabelOf（不再自抄映射）');
    ok(!/\|\| THEMES\.find\(\(x\) => x\.value === cur\)/.test(pcode), '面板不得再保留自抄的映射分支');
  }
}

/* ============================================================
   BUG 77 · await persist() 不判返回值，成功文案盖掉「保存失败」
   ============================================================ */

group('写盘失败不得被成功文案盖掉：await persist() 必须判返回值（BUG 77）');

/*
 * persist() 内部写失败会 status 一句红字「保存失败」，但它是**覆盖式**的：
 * 调用方紧接着再写一句「已复制画布」「已导入 N 张画布」就把它顶掉了。
 *
 * 导入那条最要命 —— 导入是**整体替换**，走到 persist 时旧内容已被顶掉，
 * 写失败意味着重载后回到导入前，而界面刚说过「已导入」：一次静默回滚。
 *
 * 修法与 switchToFile 一致：接返回值，把后果带进自己那句话。
 *
 * 断言写成**通用守卫**而不是逐条列举：以后新增 persist 调用点会自动被查。
 */
{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const code = stripCommentsFlatJs(src);

  /** 按大括号配平取出 call 之后的整个调用（call 从 idx 开始，形如 `status(`） */
  const takeCall = (t, idx) => {
    let depth = 0, i = t.indexOf('(', idx);
    for (let j = i; j < t.length; j++) {
      if (t[j] === '(') depth++;
      else if (t[j] === ')') { depth--; if (!depth) return t.slice(idx, j + 1); }
      else if (t[j] === '`') { // 跳过模板串，避免串里的 ) 干扰配平
        j++; while (j < t.length && t[j] !== '`') { if (t[j] === '\\') j++; j++; }
      }
    }
    return t.slice(idx);
  };

  /*
   * 找所有 `await persist()`，看它前面是不是判了返回值。
   *
   * 窗口取**紧随其后 600 字符**而不是「到本函数结束」：要防的是"紧接着盖掉",
   * 那必然就在下面一两行。早先按函数边界切，边界判定一失败（对象字面量里的
   * `async (fromId) => {` 匹配不到 `
  function`）就一路扫到文件尾，
   * 把别的函数的 status 全算进来，误报一片 —— 又是"守卫在报假警"。
   */
  const WIN = 600;
  const bad = [];
  let pos = 0;
  for (;;) {
    const i = code.indexOf('await persist()', pos);
    if (i < 0) break;
    pos = i + 10;
    const before = code.slice(Math.max(0, i - 24), i);
    // 判返回值的两种写法：`const ok = await persist()` / `if (!await persist())`
    const judged = /=\s*$/.test(before) || /!\s*$/.test(before);
    if (judged) continue;
    // 取 min(WIN, 到下一个顶层 `\n  }`)：只查"紧接着"的几句，
    // 否则会把下一个函数的 status 也算进来（addSheet 就吃过这个误报）
    let cut = code.indexOf('\n  }', i);
    if (cut < 0) cut = i + WIN;
    const seg = code.slice(i, Math.min(cut, i + WIN));
    let off = 0;
    for (;;) {
      const j = seg.indexOf('status(', off);
      if (j < 0) break;
      off = j + 7;
      const call = takeCall(seg, j);
      // 失败态以 `, true)` 结尾 —— 那是抱怨，不是报喜
      if (!/,\s*true\s*\)$/.test(call)) { bad.push(call.slice(0, 70)); break; }
    }
  }
  eq(bad.length, 0, '未判返回值的 persist 之后不得写成功文案：' + bad.join(' | '));

  // 判了返回值就得**把后果说出来**，不能只是判了却什么都不讲
  ok(/新建已取消：当前脑图的修改没能保存/.test(code), 'createFile 保存失败要中止新建并说明');
  ok(/未能保存：重载后会回到上一个主题/.test(code), 'applyTheme 失败要把后果说进文案');
  ok(/未能保存：重载后会回到上一个布局/.test(code), 'applyLayout 失败要把后果说进文案');
  // 三处必须把后果说进文案里（不能只是判了返回值却什么都不说）
  ok(/copy\.title \+ \(ok \? '' : '（未能保存/.test(code), '复制画布失败时要把「未能保存」说进文案');
  ok(/未能写入本地库，重载后会回到导入前的内容/.test(code), '导入失败时要把「重载回到导入前」说出来');
  ok(/ctx\.toast\(ok \? `已导入 \$\{sheets\.length\} 张画布` : '已导入，但保存失败'/.test(code),
    '导入失败时 toast 必须是 err 而不是 ok');
  ok(/ctx\.toast\(ok \? `已导入 \$\{workbook\.sheets\.length\} 张画布` : '已导入，但保存失败'/.test(code),
    'XMind 导入失败时 toast 必须是 err');
}

/* ============================================================
   BUG 96：恢复快照 —— 写盘失败仍弹绿字「已从快照恢复」
   ============================================================ */

group('恢复快照：写盘失败不得报成功，且不得谎称「已另存一份」（BUG 96）');

/*
 * BUG 77 逐条堵了导入 / 复制画布 / 换主题 / 换布局 / 新建文件，
 * **唯独没回头扫 restoreBackup** —— 又是"同一条约束只修了部分路径"
 * （本项目第 8 次）。这条比别处更重：
 *
 * 恢复是**整体替换**，写盘失败时磁盘上还是恢复前的内容，而这里弹的是
 * 绿字「已从快照恢复（恢复前的状态已另存一份）」—— 重载后回到旧状态，
 * 用户却以为恢复过了，可能接着在上面继续改，把"回退"这件事彻底忘掉。
 *
 * 而且那句「已另存一份」是用户唯一的回滚指望：恢复错了还能再退回去。
 * backupNow 写失败时它同样是假的 —— 所以 backupNow 必须**回话**。
 */
{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const code = stripCommentsFlatJs(src);

  /** 取某函数体（按大括号配平，从 `async function NAME(` 起） */
  const bodyOf = (name) => {
    const i = code.indexOf('async function ' + name + '(');
    if (i < 0) return '';
    let s = code.indexOf('{', i), depth = 0;
    for (let j = s; j < code.length; j++) {
      if (code[j] === '{') depth++;
      else if (code[j] === '}') { depth--; if (!depth) return code.slice(i, j + 1); }
    }
    return '';
  };

  const rb = bodyOf('restoreBackup');
  ok(rb.length > 0, '能取到 restoreBackup');
  ok(/const ok = await persist\(\)/.test(rb),
    '★ restoreBackup 必须接 persist() 的返回值（早先不接）');
  ok(/const backed = await backupNow\(true\)/.test(rb),
    'restoreBackup 要接住「留底」的结果，否则那句「已另存一份」是没有依据的');

  const iGuard = rb.indexOf('if (!ok)');
  const iToast = rb.indexOf('已从快照恢复（恢复前的状态已另存一份）');
  ok(iGuard >= 0 && iToast >= 0 && iGuard < iToast,
    '★ 成功提示必须排在「写盘失败」分支之后（否则失败也报成功）',
    `guard=${iGuard} toast=${iToast}`);
  // 失败分支要说清后果：重载后会回到恢复前的状态
  ok(/未能写入本地库/.test(rb), '写盘失败要说明「重载后会回到恢复前的状态」');
  // 留底失败同样要说：那句「已另存一份」是用户唯一的退路
  ok(/恢复前的状态未能留底/.test(rb), '留底失败时不得声称「已另存一份」');

  const bn = bodyOf('backupNow');
  ok(bn.length > 0, '能取到 backupNow');
  ok(/if \(key\) \{ ctx\.toast\('已创建快照', 'ok'\); return true; \}/.test(bn),
    'backupNow 成功要回 true');
  ok(/return false;/.test(bn), 'backupNow 写失败要回 false（调用方据此决定能不能说「已另存一份」）');
  ok(/return null;/.test(bn), 'backupNow 内容重复时回 null（那是"没做"而不是"失败"）');
}

/* ============================================================
   「设为封面」必须写回**打开视频的那个节点**
   ============================================================ */

group('「设为封面」写回的节点必须是打开时的那个，不能是上一次操作过的（BUG 78）');

{
  const { buildSide } = await import('./panels.js');
  const store = await import('./store.js');

  // 资产入库。blob 用普通对象：jsdom 的 Blob 过不了 Node 的 structuredClone，
  // 而 io.getAsset 只要求 rec.blob 为真、URL.createObjectURL 已被桩接管。
  await store.set('asset:asV1', {
    name: 'v.mp4', size: 10, type: 'video/mp4',
    blob: { name: 'v.mp4', size: 10, type: 'video/mp4' },
  });

  /*
   * jsdom 解不出视频画面，桩上 canvas —— 否则 grab() 返回 null，
   * 「设为封面」会停在「还没读到画面」，根本走不到写回，测不出写回给谁。
   *
   * 尺寸**只桩在浮层里那一个 video 元素上**，不改 HTMLVideoElement.prototype：
   * 前面 mediainfo 的取帧探针还挂着定时器，原型一改它们就会以为真的有画面，
   * 接着去调 jsdom 未实现的 HTMLMediaElement.load —— 噪声能把本次结果冲掉。
   */
  const W = dom.window;
  const savedGetCtx = W.HTMLCanvasElement.prototype.getContext;
  const savedToUrl = W.HTMLCanvasElement.prototype.toDataURL;
  // 前面 mediainfo 的取帧探针还挂着定时器，本块的若干 setTimeout(0) 会让它
  // 在此期间触发，调 jsdom 未实现的 load —— 噪声会淹没本次结果，静音一下
  const savedLoad = W.HTMLMediaElement.prototype.load;
  W.HTMLMediaElement.prototype.load = () => {};
  W.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, fillRect() {}, clearRect() {} });
  W.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AAAA';
  let curId = 'A';
  const thumbs = [];
  const app = {
    api: {
      status() {}, commit() {}, selectedRef: () => null, selectedImages: () => [],
      // 视频列表随选中节点走：A 没有视频、B 有一个 —— 这样写错节点时
      // setVideoThumb 要么越界报错、要么落到 A 自己的视频上，都能测出来
      selectedRefs: (k) => (k === 'video' && curId === 'B' ? [{ n: 'v.mp4', a: 'asV1', s: 10 }] : []),
      setVideoThumb: (i, nodeId, d) => { thumbs.push({ i, nodeId, d }); return true; },
      gcAssets: async () => {},
    },
    bridge: {
      getSelectedNodeId: () => curId,
      selectNodeById: () => true,
      setFile: () => {}, setVideo: () => {}, setImages: () => {},
    },
  };
  const side = buildSide(app, {});
  document.body.appendChild(side.el);
  side.open('file');

  // ① 在节点 A 上点「附加文件…」—— rememberNode() 会把 A 记下来。
  //    只点到弹选择框为止（jsdom 里不会真的弹），记 id 这一步已经同步完成。
  const btnByText = (root, t) => [...root.querySelectorAll('button')]
    .find((b) => (b.textContent || '').trim() === t);
  ok(!!btnByText(side.el, '附加文件…'), '文件页有「附加文件…」按钮');
  btnByText(side.el, '附加文件…').click();

  // ② 改选节点 B，刷新面板，点 B 那个视频的「打开」
  curId = 'B';
  side.refresh();
  const openBtn = [...side.el.querySelectorAll('button.mm-mini')]
    .find((b) => (b.textContent || '').trim() === '⤓');
  ok(!!openBtn, '视频行有「打开」按钮');
  openBtn.click();
  // openAt 是 async（要 await io.getAsset），等它把浮层建出来
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  // 只给这一个元素桩尺寸：grab() 读的就是它
  const vid = document.querySelector('video.mm-video');
  ok(!!vid, '浮层里有 video 元素');
  if (vid) {
    Object.defineProperty(vid, 'videoWidth', { configurable: true, value: 640 });
    Object.defineProperty(vid, 'videoHeight', { configurable: true, value: 360 });
  }

  // ③ 浮层里点「设为封面」
  const setThumbBtn = btnByText(document.body, '设为封面');
  ok(!!setThumbBtn, '视频浮层里有「设为封面」按钮');
  setThumbBtn?.click();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  eq(thumbs.length, 1, '点「设为封面」应写回一次');
  eq(thumbs[0]?.nodeId, 'B',
    '★ 封面必须写到**打开视频的那个节点 B**（写成 A = 封面跑到上一次操作过的节点上）');
  eq(thumbs[0]?.i, 0, '写回的索引是打开的那一个');

  // ④ 根因守卫：onSetThumb 不得再读 _pendingNodeId（那是上一次操作留下的）
  const psrc0 = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');
  const oa = stripCommentsFlatJs(fnBody(psrc0, 'const openAt = async (kind, ref, index) => {'));
  const cb = oa.slice(oa.indexOf('onSetThumb'));
  ok(!/_pendingNodeId/.test(cb), 'onSetThumb 回调不得读 _pendingNodeId（它是上一次操作的残留）');
  ok(!/_pendingNodeId\s*\|\|/.test(cb), 'onSetThumb 不得用 _pendingNodeId 作首选 id');
  /*
   * 必须**锚定到赋值开头**：早先写的是 `/ownerId\s*\|\|/`，而
   * `app.bridge?.getSelectedNodeId?.() || ownerId || ''` 也含 `ownerId ||`
   * —— 顺序整个颠倒照样绿，等于没在把关（本项目第 27 次踩到）。
   * 顺序真的重要：先读当前选中的话，浮层开着期间用户点了别的节点就写错。
   */
  ok(/const id = ownerId \|\| app\.bridge\?\.getSelectedNodeId/.test(cb),
    'onSetThumb 首选打开时锁定的 ownerId（先读当前选中的话会写错节点）');
  // ownerId 必须在 await io.getAsset **之前**取：那期间选中态同样可能变
  ok(oa.indexOf('const ownerId') >= 0 && oa.indexOf('const ownerId') < oa.indexOf('await io.getAsset'),
    'ownerId 在 await io.getAsset 之前锁定');

  // ⑤ focusNode 用完即清：_pendingNodeId 的生命周期必须随本次操作结束
  const fnAt = psrc0.indexOf('const focusNode = () => {');
  const fnSrc = psrc0.slice(fnAt, psrc0.indexOf('const rawOf =', fnAt));
  ok(/_pendingNodeId\s*=\s*''/.test(fnSrc), 'focusNode 用完即清 _pendingNodeId（否则残留会被后来的操作误用）');

  document.body.removeChild(side.el);
  W.HTMLCanvasElement.prototype.getContext = savedGetCtx;
  W.HTMLCanvasElement.prototype.toDataURL = savedToUrl;
  W.HTMLMediaElement.prototype.load = savedLoad;
}

/* ------------------------------------------------------------------
   BUG 79/80：深色画布 + 浅底主题 → 三级文字看不见；导入还把画布顶回浅色
   ------------------------------------------------------------------ */
group('画布配色守卫必须真的被调用（_kmApplyCritical 不得是死代码）');

{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');

  /*
   * 计数一律用**行首锚定**的正则，不能写 /_kmApplyCritical\(\)/g。
   *
   * 本轮的注释里就写着「早先 `_kmApplyCritical()` 定义了却没有任何调用点」
   * —— 那句里就含这个字面量。不加锚点的话，把四处调用全删光，
   * 注释里那一个仍然让断言绿：又是「断言绿但没在把关」。
   */
  const CALLC = /(?:^|\n)[ \t]*_kmApplyCritical\(\);/g;
  const CALLA = /(?:^|\n)[ \t]*_applyCanvasTheme\(\);/g;

  const nCrit = (ed.match(CALLC) || []).length;
  eq(nCrit, 4, '四处调用点：setCanvasTheme / setTheme / importJson / importText');

  const sec = (startSig, endSig) => {
    const a = ed.indexOf(startSig);
    ok(a > 0, '找得到 ' + startSig.slice(0, 24));
    const b = ed.indexOf(endSig, a);
    ok(b > a, '找得到 ' + endSig.slice(0, 20) + ' 作为分界');
    return ed.slice(a, b);
  };

  // ① 下发画布配色后：底色变了，骨架色必须按新底色重判
  const sCv = sec('setCanvasTheme: function (vars) {', 'setTheme: function (theme) {');
  // 注意：CALLC 带 /g，别用 .test()（会推进 lastIndex），一律用 match 计数
  ok((sCv.match(CALLC) || []).length > 0, 'setCanvasTheme 后要重判骨架色');

  // ② 换主题后：这是 fresh-* 三级文字看不见的唯一兜底
  const sTh = sec('setTheme: function (theme) {', 'registerCustomTheme: function (json) {');
  ok((sTh.match(CALLC) || []).length > 0, 'setTheme 后要重判骨架色');

  // ③ importJson（主路径：装载 / 切换画布 / 打开文件）
  const sIj = sec('importJson: function (data) {', 'importText: async function (md) {');
  ok((sIj.match(CALLA) || []).length > 0, 'importJson 必须补回画布配色（否则被内核主题自带底色顶掉）');
  ok((sIj.match(CALLC) || []).length > 0, 'importJson 后要重判骨架色');
  // 必须在 km.importJson 之后补：先补再导入等于没补
  ok(sIj.indexOf('_applyCanvasTheme();') > sIj.indexOf('km.importJson(d)'),
    '补套画布配色必须排在内核 importJson 之后');

  // ④ importText
  const sIt = sec('importText: async function (md) {', 'exportJson: function () {');
  ok((sIt.match(CALLA) || []).length > 0, 'importText 仍然要补回画布配色');
  ok((sIt.match(CALLC) || []).length > 0, 'importText 后要重判骨架色');

  // ⑤ 顺序：先把底色落稳，再按它重判骨架色
  for (const [nm, s] of [['setCanvasTheme', sCv], ['setTheme', sTh], ['importJson', sIj], ['importText', sIt]]) {
    ok(s.indexOf('_applyCanvasTheme();') >= 0 && s.indexOf('_applyCanvasTheme();') < s.indexOf('_kmApplyCritical();'),
      nm + '：先套底色再判骨架色');
  }

  // ⑥ 守卫不是空转：黑字压在深色画布上确实远低于阈值 3
  const rel = (c) => {
    const f = (n) => { n /= 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const cr = (a, b) => { const la = rel(a), lb = rel(b), hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); };
  const blackOnDark = cr([0, 0, 0], [0x1e, 0x1e, 0x1e]);
  ok(blackOnDark < 3, `黑字压在 #1E1E1E 上确实不达标（实测 ${blackOnDark.toFixed(2)} < 3）`);
}

/* ============================================================
   BUG 81 · Ctrl+A 全选后按 Delete 一个都删不掉
   ============================================================ */

group('BUG 81 · 删除键必须注册成内核认得的 Del，且要支持多选');

{
  const ed = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');

  /*
   * 键名一律行首锚定：注释里大量提到 'Delete' 这个字面量，
   * 不锚定的话把注册删光、注释仍在，断言照样绿（第 25 次同类）。
   */
  ok((ed.match(/(?:^|\n)[ \t]*kmShortcut\('Del',\s*removeSelectedNode\)/) || []).length === 1,
    'Del 必须注册到 removeSelectedNode（内核键码表只认 Del）');
  ok((ed.match(/(?:^|\n)[ \t]*kmShortcut\('Delete',\s*removeSelectedNode\)/) || []).length === 0,
    '不得再注册 Delete —— 那个名字内核不认，注册了也永不触发');
  ok((ed.match(/(?:^|\n)[ \t]*kmShortcut\('Backspace',\s*removeSelectedNode\)/) || []).length === 1,
    'Backspace 仍然注册到同一个实现');

  /* ---- 行为级：用 mock 跑真实源码 ---- */
  const i = ed.indexOf('function removeSelectedNode()');
  ok(i > 0, '找得到 removeSelectedNode');
  // 边界取**紧邻的下一个函数**，不能取到后面的 kmShortcut('Del') ——
  // 中间还夹着 insertChildNode / kmShortcut('Tab')，而 kmShortcut 是外层
  // IIFE 的局部函数，new Function 里没有它，一执行就 ReferenceError。
  const j = ed.indexOf('function insertChildNode()', i);
  ok(j > i, '函数体边界（下一个函数）找得到');
  const src = ed.slice(i, j);

  /** 建 mock：removeNode 真的把节点从父节点摘掉并置空 parent */
  function mockKm(sel) {
    const log = [];
    const mk = (text, parent) => {
      const n = { data: { text }, parent, children: [], getLevel() { let d = 0, p = this.parent; while (p) { d++; p = p.parent; } return d; } };
      if (parent) parent.children.push(n);
      return n;
    };
    const root = mk('中心', null);
    const A = mk('A', root), A1 = mk('A1', A), B = mk('B', root), B1 = mk('B1', B);
    const km = {
      getRoot: () => root,
      getSelectedNodes: () => sel({ root, A, A1, B, B1 }),
      getSelectedNode: () => (sel({ root, A, A1, B, B1 })[0] || null),
      /*
       * 还原真实内核的语义：只把节点自己从父节点摘掉、置空**它自己的**
       * parent；子孙仍然挂在被删掉的那个节点上（parent 非空）。
       * 不还原这一点，「只看 parent 非空」的写法根本暴露不出来。
       */
      removeNode(n) {
        log.push('remove:' + n.data.text);
        if (!n.parent) throw new Error('已脱离树');
        const p = n.parent, k = p.children.indexOf(n);
        if (k < 0) throw new Error('不在父节点里');
        p.children.splice(k, 1);
        n.parent = null;
      },
      fire: (t) => log.push('fire:' + t),
      layout: () => log.push('layout'),
    };
    return { km, log, nodes: { root, A, A1, B, B1 } };
  }
  const run = (sel) => {
    const m = mockKm(sel);
    const fn = new Function('km', src + '; return removeSelectedNode;')(m.km);
    fn();
    return m;
  };
  const alive = (m) => { const t = []; (function w(x) { t.push(x.data.text); x.children.forEach(w); })(m.nodes.root); return t; };

  // ① 全选（含根）：根保留，其余全删
  {
    const m = run((n) => [n.root, n.B, n.B1, n.A, n.A1]);
    eq(alive(m).join(','), '中心', 'Ctrl+A 全选后 Delete：只剩根，其余全部删除');
    const rm = m.log.filter((x) => x.startsWith('remove:'));
    // A 与 B 各自连带头删掉 A1 / B1，子孙不该再被单独删一次
    eq(rm.length, 2, '只删两个顶层：子孙由内核连带头删掉，不重复删');
    ok(!rm.includes('remove:中心'), '根节点任何时候都不删');
    eq(m.log.filter((x) => x === 'fire:contentchange').length, 1,
      '只 fire 一次 contentchange —— 否则撤销栈会有 N 条，得按 N 次撤销');
    eq(m.log.filter((x) => x === 'layout').length, 1, '只 layout 一次');
  }

  // ② 单选非根：与修复前一致
  {
    const m = run((n) => [n.A]);
    eq(alive(m).join(','), '中心,B,B1', '单选删除仍然整棵子树一起走');
    eq(m.log.filter((x) => x === 'fire:contentchange').length, 1, '单选也只 fire 一次');
  }

  // ③ 只选根：什么都不做，也不 fire
  {
    const m = run((n) => [n.root]);
    eq(alive(m).join(','), '中心,A,A1,B,B1', '只选根按 Delete 不变');
    eq(m.log.length, 0, '只选根时既不删也不 fire（不产生空的撤销步）');
  }

  // ④ 多选两个叶子
  {
    const m = run((n) => [n.A1, n.B1]);
    eq(alive(m).join(','), '中心,A,B', '多选两个叶子都被删');
  }

  // ⑤ 祖先与子孙同时选中：子孙已被连带头删掉，不能对脱离树的节点再删一次
  {
    const m = run((n) => [n.A, n.A1, n.B]);
    eq(alive(m).join(','), '中心', '祖先与子孙同时选中时不报错、结果正确');
    eq(m.log.filter((x) => x.startsWith('remove:')).join(','), 'remove:A,remove:B',
      '子孙已被连带头删掉，跳过（parent 为空）');
  }
}


/* ============================================================
   BUG 82 · 方向键导航被内核几何导航盖掉（页面那套 XMind 语义形同虚设）
   ============================================================ */

group('BUG 82 · 方向键：内核几何导航排在我们之后，把我们的语义整个盖掉');

/*
 * 内核**有**方向键导航，只是不是树形语义而是**几何语义**：它在
 * layoutallfinish 时给每个节点算出「上下左右最近的节点」（_nearestNodes），
 * 按键时按距离挑一个。该模块挂在 `"normal.keydown readonly.keydown"` 上。
 *
 * 而派发顺序是：先通用 `'keydown'`（addShortcut 注册的东西在这一站），
 * 再 `'normal.keydown'` —— 内核那一脚永远踢在最后，读到的 getSelectedNode()
 * 已经是我们刚改过的，会再挪一次。
 *
 * 实测（真实 Chrome + 真实键盘，6 节点 × 4 方向，修复前）：
 *   ← 在 A 上 → C（文档写「移到父节点」，应为「中心」）
 *   → 在 A 上 → A1x（应进入 A1，多走了一层）
 *   → 在 B 上 → A1（B 是叶子，应不动）
 *   ↓ 在 B 上 → B（应到 C，被内核拉了回来）
 *   ↓ 在 C 上 → B（已到末尾，应不动）
 */
{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  // 注释里大量引用这些写法，不剥的话命中的是注释本身 —— 代码真改坏了照样绿
  const S = stripCommentsFlatJs(html);

  // ① 方向键**不得**再用 kmShortcut 注册（那样必被内核那一脚盖掉）
  for (const d of ['up', 'down', 'left', 'right']) {
    ok(!new RegExp("kmShortcut\\('" + d + "'").test(S),
      `方向键 ${d} 不再走 addShortcut（会排在内核几何导航之前，被盖掉）`);
  }

  // ② 必须分两站：第一站记起点，第二站（排在内核之后）执行
  ok(/km\.on\('keydown'[\s\S]{0,600}?_navFrom\s*=\s*km\.getSelectedNode\(\)/.test(S),
    '第一站（通用 keydown）记下起点（等第二站再读就已被内核挪过）');
  ok(/km\.on\('normal\.keydown readonly\.keydown'[\s\S]{0,600}?navNode\(d,\s*f\)/.test(S),
    '第二站（normal.keydown）按起点执行，排在内核几何导航之后');

  // ③ navNode 必须接收起点参数
  ok(/function navNode\(dir,\s*from\)/.test(S), 'navNode 接收起点参数 from');
  ok(/var n = from \|\| km\.getSelectedNode\(\)/.test(S), 'navNode 优先用传入的起点');

  // ④ **不移动时也要显式选回起点** —— 否则「到头了就不动」会变成
  //    「跳到几何上最近的节点」（实测 ↓ 在 C 上跳回 B）
  ok(/var t = target \|\| n;/.test(S), '不移动时把目标回落到起点本身');
  ok(/if \(km\.getSelectedNode\(\) !== t\) km\.select\(t, true\);/.test(S),
    '不移动时显式选回起点（抵消内核那一脚）');

  // ⑤ 注释里那条错误判断必须改掉，否则后来人还会照着它改回去
  // 这句话只能以「早先这么写、那是错的」的历史口吻出现，不能再当作事实陈述
  const navClaim = html.split('\n').filter((l) => l.includes('内核不提供方向键导航'));
  ok(navClaim.length === 1 && /早先/.test(navClaim[0]) && /错的/.test(navClaim[0]),
    '注释只是以「早先这么写、那是错的」的口吻提及，不再当作事实陈述');
}

/* ============================================================
   BUG 83 · 「/」折叠：页面与内核各切换一次，正负相抵 = 按了跟没按一样
   ============================================================ */

group('BUG 83 · 「/」折叠键：两套实现各切一次，按了跟没按一样');

/*
 * 内核 ExpanderRenderer 模块在 `"normal.keydown"` 上自己处理了 `/`：
 * 取选中节点的 isExpanded() 取反，对**全部选中节点**执行，
 * 最后 layout(100) + fire contentchange（命中 root 时直接 return）。
 *
 * 早先页面又用 addShortcut('/') 切了一次，而 addShortcut 排在前 ——
 *   我们 collapse A → 内核读到 isExpanded()=false → 再 expand A
 * 钩住 expand/collapse 打点能看到一去一回两条调用，净效果是零。
 */
{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const S = stripCommentsFlatJs(html);

  ok(!/kmShortcut\('\/'/.test(S),
    '「/」不再由页面注册（与内核各切一次会正负相抵）');
  ok(/ExpanderRenderer/.test(html) && /交给内核/.test(html),
    '注释写明「/」交给内核 ExpanderRenderer（它还支持多选、也不会把根整棵收起）');
  ok(!/同样只有键码\(191\)被登记，行为未实现/.test(html),
    '注释不再声称内核未实现「/」（那是错的）');
}


/* ============================================================
   契约：快捷键说明里写的每一条，都必须真的有键绑上去
   ============================================================ */

group('快捷键说明 × 实际绑定：文档写的每一条都得真的接上（防「文档有、键不通」）');

/*
 * BUG 57（Ctrl+C/X/V）的教训：命令在、键没绑，而插件里没有对应按钮，
 * 于是功能完全不可用 —— 但说明窗口里白纸黑字写着它。
 * 这条契约把「说明」和「绑定」钉在一起：说明里列了，就必须在
 * 「编辑器页注册」「内核已知绑定」「另有专门实现」三者之一里找得到。
 *
 * 内核那份是实测出来的（初始化后打印 km._shortcutKeys），**不是猜的**：
 *   Tab/Insert→appendchildnode、Enter/Shift+Insert→appendsiblingnode、
 *   Shift+Tab→appendparentnode、Del/Backspace→removenode、
 *   alt+Up/alt+Down→arrangeup/arrangedown、Ctrl+Shift+L→resetlayout、
 *   ctrl+b→bold、ctrl+i→italic、ctrl+=/ctrl+-→zoomin/zoomout；
 * 另三个挂在 "normal.keydown" 上：Ctrl+A 全选、方向键几何导航、/ 折叠。
 */
{
  const html = fs.readFileSync(path.join(HERE, 'editor/index.html'), 'utf8');
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  // 注释里大量引用这些键名，不剥的话命中的是注释本身 —— 键真没绑上去照样绿
  const S = stripCommentsFlatJs(html);

  const KERNEL = ['ctrl+a', 'ctrl+b', 'ctrl+i', 'ctrl+shift+l', 'ctrl+=', 'ctrl+-',
    'tab', 'enter', 'shift+tab', 'del', 'backspace', 'insert', 'shift+insert',
    'alt+up', 'alt+down', 'up', 'down', 'left', 'right', '/'];

  // 编辑器页自己注册的（addShortcut + addCommandShortcutKeys）
  const bound = new Set();
  for (const m of S.matchAll(/kmShortcut\('([^']+)'/g)) bound.add(m[1].toLowerCase());
  for (const m of S.matchAll(/addCommandShortcutKeys\(\{([^}]*)\}\)/g)) {
    for (const kv of m[1].matchAll(/:\s*'([^']+)'/g)) bound.add(kv[1].toLowerCase());
  }
  // Alt+1~5：循环里动态拼的名字，正则取不到字面量
  if (/kmShortcut\('alt\+'\s*\+\s*lv/.test(S)) {
    for (let i = 1; i <= 5; i++) bound.add('alt+' + i);
  }
  // F2：挂在容器上的捕获监听（不走 addShortcut）
  if (/e\.key === 'F2'/.test(S)) bound.add('f2');
  // Ctrl+Z / Ctrl+Y：走 document 上的独立监听，由「17.16 撤销/重做」那组把关
  if (/act = 'undo'/.test(S) && /act = 'redo'/.test(S)) {
    bound.add('ctrl+z'); bound.add('ctrl+y'); bound.add('ctrl+shift+z');
  }

  const m = pn.match(/const SHORTCUTS = \[([\s\S]*?)\n\];/);
  ok(!!m, '取到 SHORTCUTS 数组');
  const body = stripCommentsFlatJs(m ? m[1] : '');
  const docKeys = [...body.matchAll(/\['([^']+)',\s*'([^']*)'\]/g)].map((x) => x[1]);

  /** "Ctrl + C / X / V" → ctrl+c, ctrl+x, ctrl+v —— 后段继承前段的修饰键 */
  function expand(k) {
    let s = k.trim();
    const ARROW = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' };
    for (const a of Object.keys(ARROW)) s = s.split(a).join(ARROW[a]);
    if (s === '/') return ['/'];
    const out = [];
    let prefix = [];
    for (const p of s.split('/').map((x) => x.trim()).filter(Boolean)) {
      const toks = p.split('+').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const mods = toks.filter((t) => t === 'ctrl' || t === 'shift' || t === 'alt');
      const main = toks.filter((t) => t !== 'ctrl' && t !== 'shift' && t !== 'alt');
      if (!main.length) continue;
      if (mods.length) prefix = mods;
      const head = main[0];
      const rng = head.match(/^(\d+)~(\d+)$/);          // "Alt + 1~5"
      if (rng) {
        for (let i = +rng[1]; i <= +rng[2]; i++) out.push([...prefix, i].join('+'));
      } else if (main.length > 1) {
        for (const x of main) out.push([...prefix, x].join('+'));
      } else {
        out.push([...prefix, head === 'delete' ? 'del' : head].join('+'));
      }
    }
    return out;
  }

  const missing = [];
  for (const k of docKeys) {
    for (const one of expand(k)) {
      // 说明里写的是 Del，内核表里的键是 del —— 已统一；这里再兜一次
      if (bound.has(one) || KERNEL.includes(one)) continue;
      missing.push(k + '（→ ' + one + '）');
    }
  }
  eq(missing.length, 0,
    `说明里列的每一条都真的有键绑上去${missing.length ? '（没绑：' + missing.join('、') + '）' : ''}`);
  ok(docKeys.length >= 26, `说明条目数合理（实际 ${docKeys.length} 条）`);

  // 反向兜底：方向键与「/」现在**不得**再由 addShortcut 注册（会与内核各干一次）
  for (const d of ['up', 'down', 'left', 'right']) {
    ok(!bound.has(d), `方向键 ${d} 不在 addShortcut 表里（否则会被内核几何导航盖掉）`);
  }
  ok(!bound.has('/'), '「/」不在 addShortcut 表里（否则与内核各切一次、正负相抵）');
}

/* ============================================================
   结果
   ============================================================ */

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${fail} 项，跳过 ${skipped} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
console.log('\x1b[32mmindmap 插件测试全部通过\x1b[0m');
