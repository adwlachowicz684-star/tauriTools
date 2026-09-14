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
globalThis.Event = dom.window.Event;

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
  ok(/onclick:\s*\(e\)\s*=>\s*\{\s*const\s+r\s*=\s*onclick\?\.\(e\);\s*refocusCanvas\(\)/.test(bseg),
    '焦点归还在 onclick 执行**之后**（handler 里的 prompt 先跑完）');
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
  ok(/\.mm-tabs::-webkit-scrollbar/.test(css), '滚动条样式挂到 .mm-tabs 上');
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
  const mount = src.slice(src.indexOf('side = buildSide(app)'), src.lastIndexOf('buildRail();'));
  ok(/insertBefore\(fileList\.el,\s*canvasEl\)/.test(mount), '文件库插在画布**左**边');
  ok(/appendChild\(side\.el\)/.test(mount), '属性侧栏挂在画布**右**边（appendChild 到 body 末尾）');
  ok(mount.indexOf('insertBefore(fileList.el') < mount.indexOf('appendChild(side.el'),
    '先插文件库、再挂侧栏 —— 画布始终夹在中间');

  // 10.2 文件库默认收起（Web 版多文档，C# 没有左栏，收起更接近原版观感）
  ok(/filesOpen === undefined\)\s*settings\.filesOpen = false/.test(src), 'filesOpen 默认 false（默认收起）');

  // 10.3 图标条只留文件库开关：四个属性页入口已随侧栏搬到右侧
  const railFn = src.slice(src.indexOf('function buildRail'), src.indexOf('/* ------------------------- 页签'));
  ok(/📚/.test(railFn), '图标条保留文件库开关 📚');
  ok(!/side\.open\(/.test(railFn), '图标条不再放属性页入口（页签已移到侧栏顶部）');

  // 10.4 底部两行：画布页签条 + 独立状态条（对齐 C# 的 Grid.Row=2 / Row=3）
  ok(/const statusBar = h\('div\.mm-statusbar', \{\}, statusEl\)/.test(src), '状态条独立成行');
  ok(/toolbar,\s*body,\s*foot,\s*statusBar/.test(src), '根容器顺序：顶栏 → 主体 → 页签条 → 状态条');
}

{
  // 10.5 侧栏自身：常驻 276px + 页签在内容上方
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sideCss = css.slice(css.indexOf('.mm-side {'), css.indexOf('.mm-side h3'));
  ok(/flex:\s*0 0 276px/.test(sideCss), '侧栏固定 276px（与 C# Column 1 的 Width="276" 一致）');
  ok(/display:\s*flex/.test(sideCss), '侧栏默认显示（常驻，不靠 .open 打开）');
  ok(!/display:\s*none/.test(sideCss), '不再 display:none —— 否则一进来是空的');

  const { buildSide } = await import('./panels.js');
  const el = buildSide({ api: { status() {} } }).el;
  ok(el.classList.contains('open'), '侧栏根节点带 open 类');
  eq(el.dataset.page, 'theme', '默认停在「主题」页（对齐 C# ShowSidePage("theme")）');

  const tabs = el.querySelector('.mm-side-tabs');
  const content = el.querySelector('.mm-side-body');
  ok(!!tabs && !!content, '侧栏拆成页签条 + 内容区两块');
  eq([...tabs.children].map((b) => b.textContent).join('/'), '主题/标签/样式/文件',
    '页签顺序：主题 → 标签 → 样式 → 文件（与 C# 顶栏四个 ToggleButton 一致）');
  eq(el.children[0], tabs, '页签在内容区**上方**');

  // 10.6 点当前页不再把面板点没（常驻侧栏没有收起语义）
  const tagBtn = [...tabs.children].find((b) => b.textContent === '标签');
  tagBtn.click();
  eq(el.dataset.page, 'tag', '点「标签」切到标签页');
  [...el.querySelector('.mm-side-tabs').children].find((b) => b.textContent === '标签').click();
  eq(el.dataset.page, 'tag', '再点一次仍停在标签页（不会收起 —— 常驻侧栏）');
  ok(!/display:\s*none/.test(el.style.cssText), '重复点击后面板依然可见');
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
