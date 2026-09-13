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
  FILE_FIELD_NAMES,
} from '../engine/files';
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
