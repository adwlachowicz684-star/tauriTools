/**
 * 文件参数与输出参数的单元测试。
 *
 * 运行：npm i -D tsx && npx tsx --test tests/files.test.ts
 *
 * 路径识别是"尽力而为"的文本匹配，没有标准答案，
 * 所以这里重点覆盖两类：常见写法必须识别、常见噪声必须挡掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFileRefs, parseManualPaths, buildFileFields, normalizePath,
  fsRenderIssue, fsNeedsTarget,
  FILE_FIELD_NAMES,
} from '../engine/files';
import { tokenRe } from '../engine/template';
import { FS_OP_META } from '../types';
import { makeFsNode } from '../types';
import { runGraph, type RunEvent } from '../engine/runner';
import { readSrc } from './srcScan';
import {
  resolveParam, resolveParams, validateParam, validateParams, makeParam,
  PARAM_SOURCE_META,
  type NodeParam,
} from '../engine/params';

const paths = (refs: { abs: string }[]) => refs.map((r) => r.abs);

/* ================================================================== */
/* 路径识别：应该识别出来的                                            */
/* ================================================================== */

test('识别: 绝对路径', () => {
  assert.deepEqual(paths(extractFileRefs('Wrote to /home/u/proj/src/index.ts')), [
    '/home/u/proj/src/index.ts',
  ]);
});

test('识别: 相对路径（多级）', () => {
  assert.deepEqual(paths(extractFileRefs('已修改 src/utils/helper.py')), ['src/utils/helper.py']);
});

test('识别: 反引号包裹的路径', () => {
  // CLI 输出里最常见的形式：Created `app/components/Button.tsx`
  const r = extractFileRefs('Created `app/components/Button.tsx`');
  assert.deepEqual(paths(r), ['app/components/Button.tsx']);
});

test('识别: Windows 路径', () => {
  assert.deepEqual(paths(extractFileRefs('修改了 C:\\Users\\me\\code\\main.go')), [
    'C:\\Users\\me\\code\\main.go',
  ]);
});

test('识别: 中文直接粘连（不做 CJK 切分就会漏）', () => {
  // agent 常见输出风格，没有任何分隔符
  assert.deepEqual(paths(extractFileRefs('修改文件src/foo.ts成功')), ['src/foo.ts']);
});

test('识别: 无扩展名的常见文件名', () => {
  const r = extractFileRefs('Dockerfile 已更新，同时改了 Makefile');
  assert.deepEqual(paths(r), ['Dockerfile', 'Makefile']);
});

test('识别: 隐藏文件（点开头）', () => {
  // 开头点号不能被 trim 掉，否则 .gitignore → gitignore
  const r = extractFileRefs('已更新 .gitignore 和 .env');
  assert.deepEqual(paths(r), ['.gitignore', '.env']);
});

test('识别: 一行里的多个路径', () => {
  const r = extractFileRefs('改了 src/a.ts、src/b.ts 还有 docs/readme.md');
  assert.equal(r.length, 3);
  assert.deepEqual(paths(r), ['src/a.ts', 'src/b.ts', 'docs/readme.md']);
});

test('识别: 去重（同一文件被反复提及）', () => {
  const r = extractFileRefs('创建 src/a.ts，然后写入 src/a.ts，最后保存 src/a.ts');
  assert.equal(r.length, 1, '同一路径只应出现一次');
});

test('识别: 大小写不同的同一路径也去重', () => {
  const r = extractFileRefs('src/A.ts 与 src/a.ts');
  assert.equal(r.length, 1);
});

/* ================================================================== */
/* 路径识别：应该挡掉的噪声                                            */
/* ================================================================== */

test('挡掉: URL', () => {
  assert.equal(extractFileRefs('参考 https://example.com/docs/api.md 这个链接').length, 0);
});

test('挡掉: 协议相对 URL', () => {
  assert.equal(extractFileRefs('见 //cdn.example.com/a.js').length, 0);
});

test('挡掉: 版本号与时间', () => {
  assert.equal(extractFileRefs('版本升级到 1.2.3，时间 12:30:45').length, 0);
});

test('挡掉: 普通英文句子', () => {
  assert.equal(extractFileRefs('The task has been completed successfully').length, 0);
});

test('挡掉: 单个无扩展名单词', () => {
  assert.equal(extractFileRefs('修改了 config').length, 0);
});

test('挡掉: 空文本', () => {
  assert.deepEqual(extractFileRefs(''), []);
});

/* ================================================================== */
/* workdir 拼接与规范化                                                */
/* ================================================================== */

test('workdir: 相对路径拼到工作目录', () => {
  assert.deepEqual(paths(extractFileRefs('改了 src/a.ts', '/work/proj')), ['/work/proj/src/a.ts']);
});

test('workdir: 绝对路径不受影响', () => {
  assert.deepEqual(paths(extractFileRefs('改了 /abs/a.ts', '/work/proj')), ['/abs/a.ts']);
});

test('workdir: 末尾多余斜杠被清理', () => {
  assert.deepEqual(paths(extractFileRefs('改了 src/a.ts', '/work/proj/')), ['/work/proj/src/a.ts']);
});

test('规范化: ./ 被折叠', () => {
  assert.equal(normalizePath('/work/proj/./a.ts'), '/work/proj/a.ts');
});

test('规范化: ../ 回退一级', () => {
  assert.equal(normalizePath('/work/proj/../shared/a.rs'), '/work/shared/a.rs');
});

test('规范化: 相对路径开头的 .. 保留', () => {
  assert.equal(normalizePath('../../a.ts'), '../../a.ts');
});

test('规范化: 绝对路径的 .. 到根后丢弃', () => {
  assert.equal(normalizePath('/../../a.ts'), '/a.ts');
});

test('规范化: Windows 盘符保持反斜杠', () => {
  assert.equal(normalizePath('C:\\a\\..\\b.go'), 'C:\\b.go');
});

test('workdir: ./ 开头的相对路径不会被误判成绝对路径', () => {
  // 回归：早期版本把 ./config.yml 的开头点号 trim 掉，
  // 变成 /config.yml 被当成绝对路径，workdir 拼接失效
  assert.deepEqual(paths(extractFileRefs('Updated ./config.yml', '/work/proj')), [
    '/work/proj/config.yml',
  ]);
});

/* ================================================================== */
/* 字段展开                                                            */
/* ================================================================== */

test('字段: 单文件展开出全部字段', () => {
  const refs = extractFileRefs('改了 src/utils/a.ts', '/w');
  const f = buildFileFields(refs);
  assert.equal(f.file, '/w/src/utils/a.ts');
  assert.equal(f.fileName, 'a.ts');
  assert.equal(f.fileDir, 'src/utils');
  assert.equal(f.fileExt, 'ts');
  assert.equal(f.fileCount, '1');
  assert.equal(f.fileRel, 'src/utils/a.ts');
});

test('字段: 多文件时 files 换行分隔', () => {
  const refs = extractFileRefs('改了 src/a.ts 和 src/b.ts', '/w');
  const f = buildFileFields(refs);
  assert.equal(f.files, '/w/src/a.ts\n/w/src/b.ts');
  assert.equal(f.fileNames, 'a.ts\nb.ts');
  assert.equal(f.fileCount, '2');
  assert.equal(f.file, '/w/src/a.ts', 'file 取第一个');
});

test('字段: 无文件时字段为空串而非 undefined', () => {
  // 下游渲染时 undefined 会被当成"未解析"保留原样，
  // 空串才是"确实没有文件"，两者语义不同
  const f = buildFileFields([]);
  for (const k of FILE_FIELD_NAMES) {
    assert.equal(f[k], k === 'fileCount' ? '0' : '', `${k} 应为空串`);
  }
});

/* ================================================================== */
/* 手动模式                                                            */
/* ================================================================== */

test('手动: 按行解析路径', () => {
  const r = parseManualPaths('src/a.ts\nsrc/b.ts', '/w');
  assert.deepEqual(paths(r), ['/w/src/a.ts', '/w/src/b.ts']);
});

test('手动: 跳过空行并去重', () => {
  const r = parseManualPaths('src/a.ts\n\n  \nsrc/a.ts', '/w');
  assert.equal(r.length, 1);
});

test('手动: 绝对路径不拼 workdir', () => {
  assert.deepEqual(paths(parseManualPaths('/abs/a.ts', '/w')), ['/abs/a.ts']);
});

/* ================================================================== */
/* 参数解析                                                            */
/* ================================================================== */

const P = (o: Partial<NodeParam> = {}): NodeParam => ({
  id: 'p1', name: 'arg', source: 'files', enabled: true, index: 0, ...o,
});

test('参数: files 默认取全部', () => {
  const refs = parseManualPaths('a.ts\nb.ts', '/w');
  assert.equal(resolveParam(P({ source: 'files' }), { output: '', refs }), '/w/a.ts\n/w/b.ts');
});

test('参数: files 指定序号取单个', () => {
  const refs = parseManualPaths('a.ts\nb.ts', '/w');
  assert.equal(resolveParam(P({ source: 'files', index: 2 }), { output: '', refs }), '/w/b.ts');
});

test('参数: files 序号越界返回空串', () => {
  const refs = parseManualPaths('a.ts', '/w');
  assert.equal(resolveParam(P({ source: 'files', index: 9 }), { output: '', refs }), '');
});

test('参数: manual 返回固定值', () => {
  assert.equal(resolveParam(P({ source: 'manual', value: 'hello' }), { output: '', refs: [] }), 'hello');
});

test('参数: regex 取第一个捕获组', () => {
  const p = P({ source: 'regex', pattern: '版本[:：]\\s*(\\S+)' });
  assert.equal(resolveParam(p, { output: '当前版本: 1.2.3', refs: [] }), '1.2.3');
});

test('参数: regex 无捕获组取整段', () => {
  const p = P({ source: 'regex', pattern: 'ERR-\\d+' });
  assert.equal(resolveParam(p, { output: '发生 ERR-42 错误', refs: [] }), 'ERR-42');
});

test('参数: regex 多个匹配默认全部', () => {
  const p = P({ source: 'regex', pattern: '(?:file=)(\\S+)' });
  const out = resolveParam(p, { output: 'file=a.ts file=b.ts', refs: [] });
  assert.equal(out, 'a.ts\nb.ts');
});

test('参数: regex 非法时不抛异常', () => {
  // 非法正则若抛出，整条流水线会挂掉；参数只是附加信息，取空更合适
  const p = P({ source: 'regex', pattern: '[' });
  assert.doesNotThrow(() => resolveParam(p, { output: 'x', refs: [] }));
  assert.equal(resolveParam(p, { output: 'x', refs: [] }), '');
});

test('参数: regex 能匹配空串时不死循环', () => {
  const p = P({ source: 'regex', pattern: 'x*' });
  const out = resolveParam(p, { output: 'abc', refs: [] });
  assert.ok(typeof out === 'string');
});

test('参数: 停用返回空串', () => {
  assert.equal(resolveParam(P({ enabled: false, source: 'manual', value: 'v' }), { output: '', refs: [] }), '');
});

test('参数: 批量解析按名字建表', () => {
  const refs = parseManualPaths('a.ts', '/w');
  const out = resolveParams(
    [P({ id: '1', name: 'target', source: 'files' }), P({ id: '2', name: 'note', source: 'manual', value: 'hi' })],
    { output: '', refs },
  );
  assert.equal(out.target, '/w/a.ts');
  assert.equal(out.note, 'hi');
});

test('参数: 停用项不出现在结果里', () => {
  const out = resolveParams([P({ name: 'x', enabled: false })], { output: '', refs: [] });
  assert.equal('x' in out, false);
});

test('参数: 空名字被跳过', () => {
  const out = resolveParams([P({ name: '  ' })], { output: '', refs: [] });
  assert.deepEqual(Object.keys(out), []);
});

/* ================================================================== */
/* 参数校验                                                            */
/* ================================================================== */

test('校验: 正常参数无提示', () => {
  assert.equal(validateParam(P({ name: 'target' })).length, 0);
});

test('校验: 名字为空报错', () => {
  assert.ok(validateParam(P({ name: '' })).some((i) => i.level === 'error'));
});

test('校验: 名字含非法字符报错', () => {
  // 模板变量只认 [A-Za-z0-9_]，别的写法会被解析成别的节点 id
  assert.ok(validateParam(P({ name: 'my-file' })).some((i) => i.level === 'error'));
  assert.ok(validateParam(P({ name: '1abc' })).some((i) => i.level === 'error'));
});

test('校验: 下划线开头的合法名字通过', () => {
  assert.equal(validateParam(P({ name: '_target1' })).length, 0);
});

test('校验: 用 output 作名字报错（保留名）', () => {
  assert.ok(validateParam(P({ name: 'output' })).some((i) => i.message.includes('保留')));
});

test('校验: 与内置文件字段同名时警告', () => {
  assert.ok(validateParam(P({ name: 'file' })).some((i) => i.level === 'warn' && i.message.includes('覆盖')));
});

test('校验: 正则为空警告', () => {
  assert.ok(validateParam(P({ source: 'regex', pattern: '' })).some((i) => i.level === 'warn'));
});

test('校验: 非法正则报错', () => {
  assert.ok(validateParam(P({ source: 'regex', pattern: '[' })).some((i) => i.level === 'error'));
});

test('校验: 固定值为空警告', () => {
  assert.ok(validateParam(P({ source: 'manual', value: '' })).some((i) => i.level === 'warn'));
});

test('校验: 重名提示', () => {
  const issues = validateParams([P({ id: '1', name: 'x' }), P({ id: '2', name: 'x' })]);
  assert.ok(issues.some((i) => i.message.includes('重复')));
});

test('校验: 不同名字不报重名', () => {
  assert.equal(validateParams([P({ id: '1', name: 'x' }), P({ id: '2', name: 'y' })]).length, 0);
});

test('工厂: makeParam 默认可用', () => {
  const p = makeParam();
  assert.ok(p.id);
  assert.ok(p.name);
  assert.equal(p.enabled, true);
  assert.equal(validateParam(p).length, 0);
});

test('元信息: 三种来源都有说明', () => {
  // 不用 keyof typeof：类型剥离器不支持该语法
  const keys: string[] = ['files', 'regex', 'manual'];
  for (const k of keys) {
    const m = PARAM_SOURCE_META[k];
    assert.ok(m, `${k} 缺元信息`);
    assert.ok(m.label, `${k} 缺 label`);
    assert.ok(m.hint, `${k} 缺 hint`);
  }
});

/* ==================================================================
 * 文件操作节点的路径校验
 *
 * ================= 为什么运行时还要校验 =================
 *
 * 编辑期的校验（nodeValidate 的 vFs）只看**填了没填**，而路径支持模板：
 * `{{n1.output}}` 在编辑期是合法的非空值，圆点是绿的。运行时 n1 没产出，
 * 模板原样保留，于是 fs_op 收到字面量 `{{n1.output}}` ——
 * 磁盘上真的会多出一个叫这名字的东西，且不报错、日志干净。
 * ================================================================== */

/*
 * 模拟 render 交出来的结论：文本里还是 {{}} 形状，就是这次没取到值。
 *
 * 真实的 missing 由 renderTemplate 算（见 engine/template），
 * 这里只是把"文本 → 结论"这一步在测试里近似出来 —— **判据本身不在这里**，
 * fsRenderIssue 只收结论，不做判断。
 */
const miss = (s: string): string[] =>
  (String(s ?? '').match(tokenRe()) ?? []).map((m) => m.slice(2, -2).trim());

const issue = (op: string, path: string, target = ''): string =>
  fsRenderIssue(op, path, target, miss(path), miss(target));

test('空路径必须拦住（上游没产出时最常见）', () => {
  assert.match(issue('read', ''), /路径是空的/);
  assert.match(issue('delete', '   '), /路径是空的/);
});

/*
 * 未渲染的模板变量 —— 这是编辑期抓不到、只有运行时才看得出的一类。
 * 不拦的话 write/mkdir 会在磁盘上建一个叫 `{{n1.output}}` 的东西。
 */
test('路径里有未渲染的模板变量必须拦住', () => {
  assert.match(issue('delete', '{{n1.output}}'), /没渲染出来的模板变量/);
  assert.match(issue('write', '/data/{{loop.item}}.md'), /没渲染出来的模板变量/);
});

/** 渲染成功的模板必须放行 —— 否则等于禁用模板 */
test('渲染成功的模板要放行', () => {
  assert.equal(issue('read', '/data/a.md'), '');
  assert.equal(issue('write', '/data/{{x}}.md'.replace('{{x}}', 'a')), '');
});

/** 需目标的操作：target 空 / 含未渲染变量都要拦 */
test('copy/move 的目标路径', () => {
  assert.match(issue('copy', '/a.md', ''), /需要目标路径/);
  assert.match(issue('move', '/a.md', '   '), /需要目标路径/);
  assert.match(issue('copy', '/a.md', '{{n1.output}}'), /目标路径里有没渲染出来的/);
  assert.equal(issue('copy', '/a.md', '/b.md'), '', '正常目标要放行');
});

/** 不需要目标的操作不能要 target —— 否则用户会去填一个用不上的框 */
test('不需要目标的操作不校验 target', () => {
  assert.equal(issue('read', '/a.md', ''), '');
  assert.equal(issue('delete', '/a.md', ''), '');
});

/*
 * FS_FORBIDDEN 此前**全仓没有任何消费点** ——
 * types.ts 里写着「这些路径绝不允许被删除」，而那句注释从未生效。
 */
test('不允许改动的位置：改动类操作拦住', () => {
  for (const p of ['/', '/etc', '/usr', '/bin', '/system', '/windows']) {
    assert.match(issue('delete', p), /不允许改动/, `delete ${p} 要拦住`);
  }
  assert.match(issue('mkdir', 'C:\\Windows'), /不允许改动/);
  assert.match(issue('write', '/etc/passwd'), /不允许改动/);
});

/** `..` 要规范化后再比对 —— 否则换个写法就绕过去了 */
test('绕道写法也拦（先规范化再比对）', () => {
  assert.match(issue('delete', '/data/../etc'), /不允许改动/);
  assert.match(issue('delete', '/etc/'), /不允许改动/, '尾斜杠');
  assert.match(issue('delete', '/ETC'), /不允许改动/, '大小写');
});

/*
 * 反向：只读操作**必须放行**。
 *
 * 读 /etc/hosts、列 / 都是正常需求 —— 判掉属于误报，
 * 而误报比漏报更糟：用户会去改一个本来能跑的节点。
 */
test('只读操作不受禁用名单限制（否则是误报）', () => {
  for (const op of ['read', 'list', 'exists', 'stat']) {
    assert.equal(issue(op, '/etc'), '', `${op} /etc 要放行`);
  }
  assert.equal(issue('list', '/'), '', 'list / 要放行');
});

/** 普通路径一律放行 —— 判据不能扩到"只许改某个目录" */
test('普通路径放行', () => {
  assert.equal(issue('delete', '/data/tmp/x.md'), '');
  assert.equal(issue('write', '/data/a.md'), '');
  assert.equal(issue('move', '/data/a.md', '/data/b.md'), '');
});

/** 空内容合法（建空文件 / 追加空串）—— fsRenderIssue 不接 content，就是为此 */
test('不校验内容：空内容是合法用法', () => {
  assert.equal(issue('write', '/data/a.md'), '', 'write 空内容不该报缺参');
});

/* ==================================================================
 * 两份清单必须是一份
 *
 * 以前 nodeValidate 里手写了一份 `new Set(['copy','move','rename'])`，
 * 与 FS_OP_META.needsTarget 是两张表（且 'rename' 在 FsOp 里根本不存在）。
 * ================================================================== */

test('fsNeedsTarget 与 FS_OP_META.needsTarget 同一口径', () => {
  for (const op of Object.keys(FS_OP_META)) {
    assert.equal(
      fsNeedsTarget(op),
      Boolean(FS_OP_META[op].needsTarget),
      `${op} 两处口径不一致`,
    );
  }
});

/*
 * 守卫盯的是**语义**（vFs 用的是不是共享判据），不是写法。
 *
 * 第一版我写的是"不许出现 new Set(['copy','move']" ——
 * 而换成 `['copy','move'].includes(...)` 它照样通过：
 * 判据又变成手抄的了，测试却全绿。守卫盯写法，换个写法就绕过去。
 */
test('源码守卫：vFs 的需求判据必须调 fsNeedsTarget（不许手抄）', () => {
  const src = readSrc('engine/nodeValidate.ts');
  const m = src.match(/function vFs\([\s\S]*?\n}/);
  assert.ok(m, '没找到 vFs');
  assert.ok(
    /fsNeedsTarget/.test(m![0]),
    'vFs 必须调 fsNeedsTarget —— 手抄一份清单，加新操作时它不会跟上',
  );
});

/** runFs 的校验必须真的接上（截函数体，而不是看文件里有没有这个词） */
test('源码守卫：runFs 里调用了渲染后的路径校验', () => {
  const src = readSrc('engine/runners/fs.ts');
  const m = src.match(/export async function runFs[\s\S]*?\n}/);
  assert.ok(m, '没找到 runFs');
  assert.ok(
    /fsRenderIssue/.test(m![0]),
    'runFs 必须在调 fs_op 之前校验渲染后的路径',
  );
});

test('源码守卫：FsOp 里没有、清单里也不许有的死项', () => {
  const src = readSrc('engine/nodeValidate.ts');
  assert.ok(
    !/'rename'/.test(src),
    "出现 'rename' —— FsOp 里没有这个取值，是死项",
  );
});

/** 界面输入框的可见性（when）也走同一份判据，否则"填了却不显示" */
test('源码守卫：面板的 target 显示条件也走 FS_OP_META', () => {
  const src = readSrc('nodes/defs/fs.ts');
  assert.ok(
    /FS_OP_META\[d\.op as FsOp\]\?\.needsTarget/.test(src),
    '面板的 when 必须读 FS_OP_META —— 另写一份会出现"要填但输入框不显示"',
  );
});

/* ==================================================================
 * 行为测试：跑一遍真的拦住
 *
 * ================= 为什么不能只测 fsRenderIssue 这个纯函数 =================
 *
 * 上面那些测的是"判据对不对"，而真正决定用户看到什么的是
 * **runFs 有没有真的调用它**。把 runFs 里那句 `if (issue) throw`
 * 改成 `if (false && issue) throw`（调用还在、就是不生效），
 * 上面 13 条**一条都不会红** —— 源码守卫也抓不住，因为那行代码本身没毛病。
 *
 * 所以这里真的跑一遍 runGraph：确认 fsExecutor 没被调用、节点明确失败。
 * ================================================================== */

/** 跑一个 fs 节点，返回「有没有真的调到 fs_op」与失败原因 */
async function runFsNode(data: Record<string, unknown>): Promise<{
  called: boolean; ok: boolean; error: string;
}> {
  const events: RunEvent[] = [];
  let called = false;
  const g = { nodes: [makeFsNode('f1', data as never)], edges: [] } as never;
  await runGraph(g, {
    concurrency: 1,
    executor: async () => 'x',
    fsExecutor: async () => { called = true; return 'ok'; },
    onEvent: (e) => events.push(e),
  });
  const done = events.filter((e) => e.type === 'node-done');
  const last = done[done.length - 1] as { ok?: boolean; error?: string } | undefined;
  return { called, ok: last?.ok !== false, error: String(last?.error ?? '') };
}

test('行为：空路径时不去碰磁盘，且明确失败', async () => {
  const r = await runFsNode({ op: 'delete', path: '' });
  assert.equal(r.called, false, '不该调用 fs_op');
  assert.equal(r.ok, false, '要判失败，不能让节点绿着');
  assert.match(r.error, /路径是空的/);
});

test('行为：未渲染的模板路径不去碰磁盘（否则建出字面量文件）', async () => {
  const r = await runFsNode({ op: 'write', path: '{{n1.output}}', content: 'x' });
  assert.equal(r.called, false, '不该调用 fs_op');
  assert.match(r.error, /没渲染出来的模板变量/);
});

test('行为：禁用位置不去碰磁盘', async () => {
  const r = await runFsNode({ op: 'delete', path: '/etc/passwd' });
  assert.equal(r.called, false, '不该调用 fs_op');
  assert.match(r.error, /不允许改动/);
});

/** 反向：正常路径必须真的跑到 —— 只盯"有没有拦"的话，全拦也算通过 */
test('行为：正常路径照常执行', async () => {
  const r = await runFsNode({ op: 'write', path: '/data/a.md', content: 'x' });
  assert.equal(r.called, true, '正常路径要真的执行');
  assert.equal(r.ok, true);
});

test('行为：只读操作读 /etc 放行（不是误报）', async () => {
  const r = await runFsNode({ op: 'read', path: '/etc/hosts' });
  assert.equal(r.called, true, '只读不该被禁用名单拦住');
  assert.equal(r.ok, true);
});
