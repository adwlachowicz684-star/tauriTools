import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadExportDir, saveExportDir, safeFilePart, joinPath,
  exportFileName, resolveExportTarget, parentOf, looksAbsolute,
} from '../engine/exportDir';

/** 内存版 KV —— 引擎模块不依赖真实 localStorage */
function memKV() {
  const m = new Map<string, unknown>();
  return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => { m.set(k, v); }, m };
}

/* ================= 设置存取 ================= */

test('没设过就是空串', () => {
  assert.equal(loadExportDir(memKV()), '');
});

test('存了能读回来', () => {
  const kv = memKV();
  saveExportDir('/tmp/out', kv);
  assert.equal(loadExportDir(kv), '/tmp/out');
});

test('存取时去首尾空格', () => {
  const kv = memKV();
  saveExportDir('  /tmp/out  ', kv);
  assert.equal(loadExportDir(kv), '/tmp/out');
});

/** 脏数据不能让界面炸 —— 这是从存档读出来的，形状不保证 */
test('存储里是非字符串时退回空串', () => {
  const kv = memKV();
  kv.set('agent-flow.exportDir.v1', { a: 1 });
  assert.equal(loadExportDir(kv), '');
});

/* ================= 文件名净化 ================= */

/** 不做净化时写盘会直接失败，而报错是 Rust 的 IO 错误，用户看不懂是自己起的名字有问题 */
test('画布名里的斜杠被换掉', () => {
  assert.equal(safeFilePart('A/B 测试'), 'A_B 测试');
});

test('Windows 非法字符全被换掉', () => {
  const out = safeFilePart('a:b*c?d"e<f>g|h');
  for (const c of [':', '*', '?', '"', '<', '>', '|']) {
    assert.ok(!out.includes(c), `不该含 ${c}`);
  }
});

test('空名字有兜底', () => {
  assert.equal(safeFilePart(''), 'canvas');
  assert.equal(safeFilePart('   '), 'canvas');
});

/** 以点开头会变成隐藏文件，可能被用户忽略 */
test('开头的点被去掉', () => {
  assert.equal(safeFilePart('.hidden'), 'hidden');
});

test('超长名字被截断', () => {
  assert.ok(safeFilePart('x'.repeat(300)).length <= 80);
});

test('连续空白压缩成一个', () => {
  assert.equal(safeFilePart('a   b'), 'a b');
});

/* ================= 路径拼接 ================= */

test('拼路径不留重复斜杠', () => {
  assert.equal(joinPath('/tmp/out/', 'a.md'), '/tmp/out/a.md');
  assert.equal(joinPath('/tmp/out', '/a.md'), '/tmp/out/a.md');
});

test('目录为空时只给文件名', () => {
  assert.equal(joinPath('', 'a.md'), 'a.md');
});

test('文件名为空时只给目录', () => {
  assert.equal(joinPath('/tmp', ''), '/tmp');
});

test('文件名带扩展名', () => {
  assert.equal(exportFileName('工作流 1', 'md'), 'flow-工作流 1.md');
});

test('扩展名带点也能处理', () => {
  assert.equal(exportFileName('c', '.py'), 'flow-c.py');
});

/* ================= 目标解析 ================= */

/** 临时选的优先于默认设置 —— 用户这次的意图最大 */
test('临时选的目录优先', () => {
  const r = resolveExportTarget('/setting', '/picked', 'c', 'md');
  assert.equal(r.source, 'picked');
  assert.equal(r.path, '/picked/flow-c.md');
});

test('没临时选就用默认设置', () => {
  const r = resolveExportTarget('/setting', null, 'c', 'md');
  assert.equal(r.source, 'setting');
  assert.equal(r.path, '/setting/flow-c.md');
});

/** 都没有时退回下载 —— 至少文件能出来，但必须标记为 download */
test('都没有则退回下载', () => {
  const r = resolveExportTarget('', null, 'c', 'md');
  assert.equal(r.source, 'download');
  assert.equal(r.path, 'flow-c.md');
});

test('空串的临时选择不算选了', () => {
  const r = resolveExportTarget('/setting', '   ', 'c', 'md');
  assert.equal(r.source, 'setting');
});

/* ================= 父目录 ================= */

/** fs_op 的 write 不自动建目录，目录不存在时是 IO 错误 */
test('取父目录', () => {
  assert.equal(parentOf('/a/b/c.md'), '/a/b');
});

/**
 * 我一开始把这条写成 parentOf('/a/b/') === '/a/b' —— 那是**测试自己错了**：
 * parentOf 是给文件路径取所在目录，'/a/b/' 去尾斜杠后是 '/a/b'，
 * 它的目录就是 '/a'。为错误预期写的测试比没写更糟。
 */
test('路径末尾的斜杠先去掉再取父目录', () => {
  assert.equal(parentOf('/a/b/'), '/a');
});

test('Windows 反斜杠也能取父目录', () => {
  assert.equal(parentOf('C:\\a\\b.md'), 'C:\\a');
});

test('没有父目录时原样返回', () => {
  assert.equal(parentOf('c.md'), 'c.md');
});

/* ================= 绝对路径判断 ================= */

test('认得出 Unix 绝对路径', () => {
  assert.equal(looksAbsolute('/tmp/a'), true);
});

test('认得出 Windows 盘符', () => {
  assert.equal(looksAbsolute('C:\\Users\\a'), true);
  assert.equal(looksAbsolute('D:/out'), true);
});

test('相对路径不算绝对', () => {
  assert.equal(looksAbsolute('out/a'), false);
  assert.equal(looksAbsolute(''), false);
});
