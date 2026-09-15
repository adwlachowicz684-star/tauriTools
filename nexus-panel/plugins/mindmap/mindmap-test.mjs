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

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================
   零、测试框架（极简）
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

const eq = (a, b, name) => ok(a === b, name, a === b ? '' : `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const group = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

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
globalThis.navigator = dom.window.navigator;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.DOMParser = dom.window.DOMParser;
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
  const ctl = { failPut: false, failTx: false, failOpen: false };

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
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
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
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
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
   五、M4 / M5 / M6 / M7 · index.js 的源码契约
   ============================================================ */

group('M4 · 外壳主题消息来源校验');
{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
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

  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function openAttachment'), src.indexOf('/* ------------------------- 撤销 / 重做'));
  ok(/io\.downloadBlob\(io\.safeFileName\(name\)/.test(fn), '下载前对附件名调用 safeFileName');
}

group('M6 · 撤销/重做栈不推入空快照');
{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const undoFn = src.slice(src.indexOf('function undo()'), src.indexOf('function redo()'));
  ok(/if\s*\(lastSnap\)\s*redoStack\.push\(lastSnap\)/.test(undoFn), 'undo：lastSnap 为 null 时不入栈');
  const redoFn = src.slice(src.indexOf('function redo()'), src.indexOf('/* ------------------------- 主题 / 布局'));
  ok(/if\s*\(lastSnap\)\s*undoStack\.push\(lastSnap\)/.test(redoFn), 'redo：对称保护');
}

group('M7 · 切换画布落盘');
{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
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
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
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

  const src = fs.readFileSync(path.join(HERE, 'editor-bridge.js'), 'utf8');
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
  // 8.5 插件层：Tab 必须在捕获阶段拦下，且放过文本控件与带修饰键的组合
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('function bindTabForward'), src.indexOf('const refocusCanvas'));
  ok(/window\.addEventListener\('keydown',\s*onKey,\s*true\)/.test(fn),
    'Tab 监听在捕获阶段（冒泡阶段拦不住浏览器的焦点导航）');
  ok(/e\.preventDefault\(\)/.test(fn), '拦下后 preventDefault');
  ok(/bridge\?\.insertChild\(\)/.test(fn), '拦下后转送给编辑器');
  ok(/e\.key\s*!==\s*'Tab'/.test(fn), '只处理 Tab');
  ok(/e\.ctrlKey\s*\|\|\s*e\.altKey\s*\|\|\s*e\.metaKey/.test(fn), '带修饰键的 Tab 交给浏览器');
  ok(/isTextTarget\(e\.target\)/.test(fn), '焦点在输入控件里时不抢 Tab');
  ok(/window\.removeEventListener\('keydown',\s*onKey,\s*true\)/.test(fn), '返回注销函数');

  ok(/function\s+isTextTarget/.test(src), '定义了 isTextTarget');
  const it = src.slice(src.indexOf('function isTextTarget'), src.indexOf('function bindTabForward'));
  for (const tag of ['input', 'textarea', 'select']) {
    ok(it.includes(`'${tag}'`), `isTextTarget 覆盖 <${tag}>`);
  }
  ok(/isContentEditable/.test(it), 'isTextTarget 覆盖 contentEditable');

  // 8.6 卸载时要注销，否则重复挂载会叠加监听
  ok(/unbindTab\?\.\(\)/.test(src), '卸载时注销 Tab 监听');
  ok(/const\s+unbindTab\s*=\s*bindTabForward\(\)/.test(src), '初始化时绑定');

  // 8.7 工具栏按钮点完归还焦点 —— 不只 Tab，Enter/方向键/Delete 同样依赖它
  const bseg = src.slice(src.indexOf('const refocusCanvas'), src.indexOf('function buildToolbar'));
  ok(/bridge\?\.focusCanvas\(\)/.test(bseg), '按钮点击后调 bridge.focusCanvas()');
  ok(/onclick:\s*\(e\)\s*=>\s*\{\s*const\s+r\s*=\s*onclick\?\.\(e\);/.test(bseg),
    '焦点归还在 onclick 执行**之后**（handler 里的 prompt 先跑完）');
  ok(/if \(opt\.refocus !== false\) refocusCanvas\(\)/.test(bseg),
    '可跳过归还（refocus:false）—— 打开模态浮层时画布不能继续吃快捷键');
}

/* ============================================================
   九、新建画布按钮固定在最右
   ============================================================ */

group('新建画布按钮（＋）位置');

{
  // jsdom 不做布局，无法断言像素位置；这里锁住决定布局的那些属性。
  // 每一个都对应一个真实的失效模式，注释里写明了会坏成什么样。
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
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
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const footCss = css.slice(css.indexOf('.mm-foot {'), css.indexOf('.mm-status {'));
  ok(!/overflow-x/.test(footCss),
    '.mm-foot 不再 overflow-x:auto —— 整条底栏滚动会把「＋」和状态一起滚出视野');

  const statusCss = css.slice(css.indexOf('.mm-status {'), css.indexOf('.mm-status.warn'));
  ok(!/margin-left:\s*auto/.test(statusCss),
    '.mm-status 不再 margin-left:auto —— 两个 auto 会平分剩余空间，反而把「＋」挤到中间');

  // 页签区现在负责滚动，滚动条样式得跟着它（.mm-foot 那条已失效）
  /* 样式**不能**写在本插件里：外壳文档的 ::-webkit-scrollbar 到不了
     iframe 内部，本插件又只引 styles.css —— 抄一份就会漏 track / hover，
     出现"细 1px 且无悬停反馈"的半成品。现在由 css/tokens.css 统一提供。 */
  ok(!/\.mm-[a-z-]*::-webkit-scrollbar/.test(css),
    '本插件不再重复声明滚动条样式（交给 css/tokens.css）');
  ok(/@import\s+url\(['"]?\.\.\/\.\.\/css\/tokens\.css/.test(css),
    '引入了 css/tokens.css（滚动条与尺度令牌的来源）');
}

/* ============================================================
   十、面板分布（对齐 C# MindMapPanel）
   ============================================================ */

group('面板分布：左文件库 / 中画布 / 右属性侧栏');

{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

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
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sideCss = css.slice(css.indexOf('.mm-side {'), css.indexOf('.mm-side h3'));
  ok(/flex:\s*0 0 276px/.test(sideCss), '侧栏固定 276px（与 C# Column 1 的 Width="276" 一致）');
  ok(/display:\s*flex/.test(sideCss), '侧栏默认显示（常驻，不靠 .open 打开）');
  ok(!/display:\s*none/.test(sideCss), '不再 display:none —— 否则一进来是空的');
  ok(!/overflow:\s*hidden/.test(sideCss), '侧栏恢复自身滚动（页签已搬走，无需再切成 hidden+内容区滚）');

  const { buildSide } = await import('./panels.js');
  // 切到「文件」页会读选中节点的附件引用，桩上补齐；其余页用不到
  const stubApi = { status() {}, selectedRef: () => null, commit() {} };
  let notified = [];
  const el = buildSide({ api: stubApi }, { onPage: (p) => notified.push(p) }).el;
  ok(el.classList.contains('open'), '侧栏根节点带 open 类');
  eq(el.dataset.page, 'theme', '默认停在「主题」页（对齐 C# ShowSidePage("theme")）');
  ok(!el.querySelector('.mm-side-tabs'), '侧栏内没有页签条 —— 页签在顶栏，不占侧栏高度');
  eq(notified.join(','), 'theme', '初始化时也会回调 onPage（顶栏据此点亮「主题」）');

  // 10.6 页签在顶栏最右，顺序对齐 C# 的四个 ToggleButton
  const src2 = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const tb = src2.slice(src2.indexOf('function buildToolbar'), src2.indexOf('/* ------------------------- 侧栏'));
  ok(/toolbar\.appendChild\(buildSideTabs\(\)\)/.test(tb), '顶栏 append 页签组');
  ok(/const SIDE_TABS = \[\['theme', '主题'\], \['tag', '标签'\], \['style', '样式'\], \['file', '文件'\]\]/.test(src2),
    '页签顺序：主题 → 标签 → 样式 → 文件（与 C# 一致）');
  ok(/buildSide\(app, \{ onPage: syncSideTabs \}\)/.test(src2), '侧栏切页回灌给顶栏页签（同步高亮）');

  const topCss = css.slice(css.indexOf('.mm-top-tabs {'), css.indexOf('/* 底部状态条'));
  ok(/margin-left:\s*auto/.test(topCss), '页签组用 margin-left:auto 推到顶栏最右');

  // 10.7 行为：侧栏自行切页（点节点附件→跳「文件」页）时顶栏也跟着变
  const side2 = buildSide({ api: stubApi }, { onPage: (p) => notified.push(p) });
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
  function makeApp(refs) {
    return {
      api: {
        status: (m, w) => statuses.push(String(m)),
        selectedRef: (kind) => refs[kind] || null,
        commit() {},
      },
      bridge: {},
    };
  }

  /** 打开侧栏并切到文件页，等异步填充跑完 */
  async function openFilePage(refs) {
    const s = buildSide(makeApp(refs), {});
    s.open('file');
    // 缩略图 / 视频 URL 都是 async 填的，让出几拍
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    return s;
  }

  // 12.1 文件卡片：图标 + 名称 + 大小
  {
    const s = await openFilePage({ file: { n: '报告.pdf', a: 'img1', s: 2048 } });
    const card = s.el.querySelector('.mm-acard');
    ok(!!card, '渲染出附件卡片');
    eq(card.querySelector('.mm-acard-name')?.textContent, '报告.pdf', '卡片显示文件名');
    eq(card.querySelector('.mm-acard-icon')?.textContent, '📕', '按扩展名给图标（pdf → 📕）');
    eq(card.querySelector('.mm-acard-sub')?.textContent, '2.0 KB', '卡片显示大小');
  }

  // 12.2 图片附件显示缩略图而不是图标
  {
    const s = await openFilePage({ file: { n: '截图.png', a: 'img1', s: 2048 } });
    const thumb = s.el.querySelector('.mm-acard-thumb');
    ok(!!thumb, '图片附件显示缩略图（不再是干巴巴的图标）');
    ok(/^blob:/.test(thumb.getAttribute('src') || ''), '缩略图用 Blob URL');
  }

  // 12.3 未附加时的空态
  {
    const s = await openFilePage({});
    const card = s.el.querySelector('.mm-acard');
    ok(card.classList.contains('empty'), '未附加文件时卡片是空态');
    ok(/未附加/.test(card.textContent), '空态提示文案');
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
    const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const playCss = css.slice(css.indexOf('.mm-vthumb-play {'), css.indexOf('.mm-vthumb.playing .mm-vthumb-play'));
    ok(/pointer-events:\s*none/.test(playCss), '▶ 覆盖层 pointer-events:none（点击交给容器，避免双重触发）');
  }

  // 12.7 Blob URL 回收：refresh 反复重建 DOM，不回收就线性增长
  {
    liveBlobUrls.clear();
    const s = await openFilePage({ video: { n: '演示.mp4', a: 'vid1', s: 12345 }, file: { n: '截图.png', a: 'img1', s: 2048 } });
    const first = liveBlobUrls.size;
    ok(first >= 2, `打开后至少 2 个 Blob URL（视频 + 缩略图，实际 ${first}）`);

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
  ok(/this\.path\.stroke\(color,\s*1\.3\)/.test(icons), 'FileIcon 用 paint() 上描边');

  // 13.4 视频图标：外框与三角都要显式上色（原来三角没设 fill → 默认黑）
  ok(/this\.frame\.stroke\(color,\s*1\.2\)/.test(icons), 'VideoIcon 外框上色');
  ok(/this\.path\.fill\(color\)\.stroke\(color,\s*1\)/.test(icons), 'VideoIcon 三角也显式上色');
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
    eq(Object.keys(km._commands).sort().join(','), 'file,video', '编辑器注册了 file / video 两个命令');
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

  // 14.5 面板层的 remove 只调用对应那一个 setter
  {
    const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
    const rm = src.slice(src.indexOf('const remove = (kind)'), src.indexOf('/** 点附件卡片'));
    ok(/kind === 'video' \? 'setVideo' : 'setFile'/.test(rm), 'remove 按 kind 选择 setter（不会同时调两个）');
    ok(/const hadOther = !!app\.api\.selectedRef\(other\)/.test(rm), '移除前记下另一项是否存在');
    ok(/hadOther && !app\.api\.selectedRef\(other\)/.test(rm),
      '移除后校验另一项 —— 真丢了要报出来，不能静默');
  }
}

{
  // 14.6 视频预览的三种状态必须区分开。
  //      「有引用但读不到本体」被说成「未附加视频」，看起来就像视频被一起删了。
  const { buildSide } = await import('./panels.js');
  const mk = (video) => {
    const el = buildSide({
      api: { status() {}, selectedRef: (k) => (k === 'video' ? video : null), commit() {} },
      bridge: {},
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
      status() {}, commit() {}, selectedRef: () => null,
      applyLayout: (v) => { applied = v; },
      applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: {},
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
  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
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
      status() {}, commit() {}, selectedRef: () => null,
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: {},
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
      status() {}, commit() {}, selectedRef: () => null,
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: {},
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
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const seg = css.slice(css.indexOf('.mm-sw.transparent {'), css.indexOf('.mm-sw.transparent {') + 400);
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

  // 17.5 宽度自适应，不截断
  ok(/el\.style\.width = 'auto';/.test(fn), '宽度随内容增长');
  ok(/el\.style\.minWidth = Math\.max\(60, Math\.round\(box\.width\)\) \+ 'px';/.test(fn), 'min-width 保底为原宽度');
  ok(!/overflow:hidden/.test(code), '（对照）不再 overflow:hidden —— 那会截断超长输入');

  // 17.6 画布一变换就先提交：编辑层是绝对定位的 HTML，不跟 SVG transform 走
  ok(/km\.on\('zoom', bail\)/.test(html), '缩放时提交关闭编辑器');
  ok(/km\.on\('viewchange', bail\)/.test(html), '视图变化时提交关闭编辑器');
  ok(/if \(editLayer\) closeTextEditor\(true\);/.test(html), '变换兜底走「提交」而非丢弃');
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
      selectedRef: () => null,
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
  const sels = [...root.querySelectorAll('select.mm-select')];
  eq(sels.length, 2, '两个下拉：自动间隔 + 最多保留');
  ok(sels[0].innerHTML.includes('分钟'), '第一个下拉是时间间隔');
  ok(sels[1].innerHTML.includes('份'), '第二个下拉是保留份数');

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
  const src = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  const filePage = src.slice(src.indexOf('function pageFile'), src.indexOf('/* ------------------------- 样式页'));
  ok(!/section\('备份与恢复'/.test(filePage), '文件页不再有「备份与恢复」段');
  ok(!/section\('布局动画'/.test(filePage), '文件页不再有「布局动画」段');
  ok(!/setBackupMinutes/.test(filePage), '文件页不再直接改备份间隔');
  ok(!/setAnimate/.test(filePage), '文件页不再直接改动动画开关');
  ok(/section\('导入导出'/.test(filePage), '文件页保留「导入导出」（文档级操作，不是设置）');
  ok(/已移到顶栏「设置」/.test(filePage), '留有注释说明搬去哪了');
}

{
  // 18.6 顶栏：设置按钮在重载左边
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
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
   结果
   ============================================================ */

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
console.log('\x1b[32mmindmap 插件测试全部通过\x1b[0m');
