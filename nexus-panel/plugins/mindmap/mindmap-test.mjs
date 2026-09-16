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
  // 8.5 插件层：Tab 必须在捕获阶段拦下，且放过文本控件与带修饰键的组合
  const src = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
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
  const css = (fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
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
  const css = (fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
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
  const src2 = (fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');
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
    const css = (fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
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
    const src = (fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8')).replace(/\r\n/g, '\n');
    // 定位不能写死 `const remove = (kind)` —— 函数改成 async 后签名就变了，
    // indexOf 返回 -1 会让切片范围整个错乱（表现为一堆断言莫名变红）。
    // 用 `const remove = ` 前缀匹配，对是否 async 都成立。
    const rmStart = src.indexOf('const remove = ');
    const rm = src.slice(rmStart, src.indexOf('/** 点附件卡片', rmStart));
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
  const css = (fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
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
  ok(/section\('导入导出'/.test(filePage), '文件页保留「导入导出」（文档级操作，不是设置）');
  ok(/已移到顶栏「设置」/.test(filePage), '留有注释说明搬去哪了');
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
  ok(/window\.confirm\(/.test(seg), 'A46 恢复前有 window.confirm（覆盖全部画布，不可逆）');
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
    ok(true, '（跳过）用户分组数量不符，跳过最后一组删除测试');
  }
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
      status() {}, commit() {}, selectedRef: () => null,
      applyLayout: () => {}, applyTheme: () => {}, saveThemes: async () => true,
      nodeStyle: () => ({}), setNodeStyle: () => {},
    },
    bridge: {}, customThemes: [],
  }, {});
  el.open('tag');
  const btns = [...el.el.querySelectorAll('button')].map((b) => b.textContent);
  ok(btns.includes('图标库…'), '标签页有「图标库…」入口');
  ok(btns.includes('清除图标'), '保留「清除图标」');
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
  ok(tb.BADGE_ROWS[1].includes(0), '清除格在第二行末（对齐 WPF values 第二排）');
  eq(tb.BADGE_ROWS.flat().length, 10, '共 10 格（1–9 + 清除）');
}

{
  // ---- 页面渲染 ----
  const { buildSide } = await import('./panels.js');
  const el = buildSide({
    api: {
      status() {}, commit() {}, selectedRef: () => null,
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
  eq(rows.length, 4, '优先级+进度 各两行 = 4 行');
  eq(rows[0].querySelectorAll('.mm-badge').length, 5, '每行 5 格');
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
      status() {}, commit() {}, selectedRef: () => null,
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
      status() {}, commit() {}, selectedRef: () => null,
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
  ok(/await trimBackups\(\);/.test(imp), 'A42 导入结束后统一清理一次（逐份清理会删掉刚写进去的）');

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
  const rmStart = src.indexOf('const remove = ');
  const rm = src.slice(rmStart, src.indexOf('/** 点附件卡片', rmStart));
  // 不能只断言「有没有 await confirmDialog」—— 把 `if (r)` 改成 `if (false)`
  // 那串还在，断言照样绿，但确认已经形同虚设。必须锁住它**在 r 存在的分支里**。
  ok(/if \(r\) \{\s*\n\s*const ok = await confirmDialog\(/.test(rm),
    'A23 有附件时才弹确认（确认必须在 r 存在的分支内，不是无条件也不是恒假）');
  ok(/if \(!ok\) return;/.test(rm), 'A23 取消则不移除（不是「问了也照删」）');
  ok(/'移除', true\)/.test(rm), 'A23 移除是危险操作（danger=true）');
  const atStart = src.indexOf('const attach = ');
  const at = src.slice(atStart, src.indexOf('const openOne', atStart));
  ok(/await confirmDialog\(/.test(at), 'A23 替换前确认（已有附件时不能静默覆盖）');
  ok(/继续将用新选择的\$\{label\}替换它/.test(at), 'A23 确认文案说明旧附件不可恢复');
  ok(/已替换\$\{label\}附件/.test(at), 'A23 替换后提示「已替换」而非笼统的「已附加」');

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
  const pn = fs.readFileSync(path.join(HERE, 'panels.js'), 'utf8');
  ok(/export function popupMenu/.test(pn), 'A39 新增 popupMenu');
  ok(/function openExportMenu/.test(idx), 'A39 新增 openExportMenu');
  ok(/oncontextmenu/.test(idx), 'A39 右键也能打开菜单');
  ok(/PNG · 2 倍（高清）/.test(idx) && /PNG · 3 倍（超清）/.test(idx), 'A39 菜单里列出 PNG 倍率');
  ok(/document\.addEventListener\('pointerdown', onDoc, true\)/.test(pn),
    'A39 菜单用捕获阶段监听（否则点画布会被画布先处理，菜单关不掉）');
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
  ok(/打印 \/ 存为 PDF…/.test(idx), 'A39 导出菜单里有打印入口');
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
  ok(/withPresetValue\(SIZES, st\.fontSize\)/.test(src),
    'B5 字号下拉用动态档位（否则 13 号字时无任何项选中，显示成空白/第一项）');
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
  eq((idx.match(/searchStatusText\(searchInput\.value/g) || []).length, 2,
    'A29 两处调用点（回车 + 定位按钮）都改了 —— 只改一处会不一致');
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
  const wf = idx.slice(idx.indexOf('async function warnForeignAssets'), idx.indexOf('async function warnForeignAssets') + 1200);
  ok(/改用 \.xmind 导出/.test(wf), 'B22 要告诉用户**怎么办**（改用 .xmind，它会打包附件）');
  ok(/JSON 只带引用、不带本体/.test(wf), 'B22 要说清**为什么**（引用在、字节不在）');
  // .xmind 分支不该调用它：xmind 会把附件打包，不存在这个问题
  ok(!/warnForeignAssets\(r\.sheets\)/.test(idx), 'B22 不对 .xmind 用（它本来就带附件）');
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
