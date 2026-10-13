import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadExportDir, saveExportDir, safeFilePart, joinPath,
  exportFileName, resolveExportTarget, parentOf, looksAbsolute, withinRoots,
} from '../engine/exportDir';
import { readSrc } from './srcScan';

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

/* ================= 授权范围判定 ================= */

/** Windows canonicalize 后带 \\?\ 前缀 —— 不处理就会永远判成"不在范围内" */
test('认得 \\\\?\\ 前缀', () => {
  assert.equal(
    withinRoots('\\\\?\\E:\\out\\a.md', ['\\\\?\\E:\\out']),
    true,
  );
});

test('混用正反斜杠也能判', () => {
  assert.equal(withinRoots('E:/out/a.md', ['E:\\out']), true);
});

test('大小写不敏感（Windows 路径）', () => {
  assert.equal(withinRoots('e:\\OUT\\a.md', ['E:\\out']), true);
});

/** 这条最容易错：/outx 以 /out 开头，但不能算在范围内 */
test('前缀相同但不是子目录的不算', () => {
  assert.equal(withinRoots('/outx/a.md', ['/out']), false);
});

test('正好在根目录下算', () => {
  assert.equal(withinRoots('/out', ['/out']), true);
});

test('子目录算', () => {
  assert.equal(withinRoots('/out/sub/deep/a.md', ['/out']), true);
});

test('多个根里命中一个就行', () => {
  assert.equal(withinRoots('/b/a.md', ['/a', '/b']), true);
});

test('授权列表为空时不算', () => {
  assert.equal(withinRoots('/out/a.md', []), false);
});

test('空路径不算', () => {
  assert.equal(withinRoots('', ['/out']), false);
});

/** 脏数据不能让界面崩 */
test('列表里有空串也不炸', () => {
  assert.equal(withinRoots('/out/a.md', ['', '/out']), true);
  assert.equal(withinRoots('/out/a.md', ['']), false);
});

/* ==================================================================
 * 根目录 / 相对路径 / 越权提示
 *
 * 这几条的共同点：**都不是安全洞**（Rust 侧 canonicalize + starts_with
 * 才是真正的边界），而是"成功但位置不对"或"失败但说不清原因" ——
 * 用户无从下手，只能猜。
 * ================================================================== */

/**
 * 默认导出目录设成 '/' 时，以前 joinPath 把它去尾斜杠成空串，
 * 于是返回裸文件名 'flow-x.sh' —— 而 source 仍标着 'setting'，
 * 于是走 fs_op 分支去给一个**相对路径**申请授权，
 * 报「授权目录失败」，而用户填的是一个真实存在的目录。
 */
test('根目录不能拼成裸文件名（否则去给相对路径申请授权）', () => {
  assert.equal(joinPath('/', 'flow-c.sh'), '/flow-c.sh');
  assert.equal(joinPath('//', 'flow-c.sh'), '/flow-c.sh');
  const r = resolveExportTarget('/', null, 'c', 'sh');
  assert.equal(r.path, '/flow-c.sh', '根目录设上去，导出就该落到根下');
  assert.equal(r.source, 'setting');
});

test('Windows 盘符根不受影响', () => {
  assert.equal(joinPath('C:\\', 'flow-c.sh'), 'C:/flow-c.sh');
});

/** joinPath 原有的行为不能被动 */
test('joinPath 原有语义保持', () => {
  assert.equal(joinPath('', 'a.md'), 'a.md', '没有目录时原样返回文件名');
  assert.equal(joinPath('/tmp', ''), '/tmp', '没有文件名时原样返回目录');
});

/** 父目录要在授权范围内才不用申请授权 —— 取对了才问得对 */
/**
 * 文件挂在根上时，父目录是根 —— 以前 parentOf 用 `i > 0` 把 i === 0 漏掉了，
 * 于是返回**文件路径本身**，拿去申请授权时报的是「目录 flow-c.sh 还没授权」。
 */
test('根目录设上去后，取到的父目录就是根（不是文件路径本身）', () => {
  assert.equal(parentOf('/flow-c.sh'), '/');
  assert.equal(parentOf(resolveExportTarget('/', null, 'c', 'sh').path), '/');
  /* 没有分隔符的仍然原样返回 —— 这条不能被动 */
  assert.equal(parentOf('flow-c.sh'), 'flow-c.sh');
});

/*
 * withinRoots 对含 `..` 的路径**保守判否**。
 *
 * 前缀比较看不出 `..`：'/data/work/../work-evil' 对 root '/data/work' 判 true，
 * 于是前端结论是"已授权，直接写"，而 Rust canonicalize 后落在
 * '/data/work-evil' 会被拒 —— 用户看到的是「目标目录不可写」，
 * 于是去查磁盘权限，而真正原因是越出了授权范围。
 *
 * 判否就会走申请授权那条路，用户看到的是明确的原因。
 */
test('withinRoots：含 .. 的路径判为不在范围内（提示才不会误导）', () => {
  assert.equal(withinRoots('/data/work/../work-evil', ['/data/work']), false);
  assert.equal(withinRoots('/data/work/./a', ['/data/work']), false);
  assert.equal(withinRoots('/data/work/a/../b', ['/data/work']), false);
});

/** 保守不能过头：正常路径照旧 */
test('withinRoots：正常路径不受保守判据影响', () => {
  assert.equal(withinRoots('/data/work', ['/data/work']), true, '自身');
  assert.equal(withinRoots('/data/work/a', ['/data/work']), true, '子目录');
  assert.equal(withinRoots('/data/workspace-evil', ['/data/work']), false, '兄弟目录仍要判否');
  assert.equal(withinRoots('/DATA/WORK/a', ['/data/work']), true, '大小写');
});

/*
 * looksAbsolute 以前**只有测试在用** —— 注释写着"用于给用户即时提示"，
 * 却没有任何界面引用它。于是填相对目录（'out'）时不会有任何提醒：
 * 日志报「✅ 已导出 → out/flow-c.sh」、文件确实写了，
 * 而实际位置取决于进程启动时的工作目录，用户在自己以为的地方找不到。
 */
test('源码守卫：looksAbsolute 真的被界面用上（不是死函数）', () => {
  const src = readSrc('components/inspectors/CanvasConfigPanel.tsx');
  assert.ok(
    /from '\.\.\/\.\.\/engine\/exportDir'/.test(src),
    '界面必须从 engine/exportDir 引入 —— 不引入就用不上',
  );
  assert.ok(
    /looksAbsolute\(exportDir\)/.test(src),
    '相对目录必须给提示 —— 否则是"成功但找不到文件"',
  );
});
