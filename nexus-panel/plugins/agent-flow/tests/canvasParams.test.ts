import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  scanParamRefs, paramRefsOfNodes, paramValue, diffParamIssue,
  ensureParams, makeParamsFor, migrateEnvVars, isValidParamName,
  PARAM_PREFIX,
} from '../engine/canvasParams';

const ROOT = process.env.AF_SRC ?? path.resolve(__dirname, '..');
import { renderTemplate } from '../engine/template';

/**
 * 画布参数 —— 画布范围的局部变量。
 *
 * ================= 为什么需要 ====================
 *
 * 一个模块要在多张画布上复用，而每张画布的具体值不同
 * （输出目录、项目名、账号……）。写死在节点里，复用一次就得改一次。
 * 做成画布参数后，节点只写名字，每张画布各填各的值。
 */

test('前缀常量', () => {
  assert.equal(PARAM_PREFIX, 'params');
});

/* ------------------------------------------------------------------ */

test('只认 params / env 前缀 —— 别的 {{}} 不能误当成参数', () => {
  /*
   * 不加前缀地扫所有 {{xxx}} 的话，
   * {{input}}、{{loop.item}}、{{node1.output}} 全会被当成缺失参数，
   * 缺失清单里冒出一堆假警报，真正缺的那个反而看不见了。
   */
  const refs = scanParamRefs('{{params.输出目录}}/a {{input}} {{loop.item}} {{n1.output}} {{var.x}}');
  assert.deepEqual(refs, ['输出目录']);
});

test('中文参数名能扫出来', () => {
  /*
   * 模板的 TOKEN 原本只认 [A-Za-z0-9_.-]，
   * 中文名整句匹配不上 —— 用户看到"没生效"，
   * 而模板层连 missing 都不会记（它根本没识别出这是个变量）。
   */
  assert.deepEqual(scanParamRefs('{{params.输出目录}}'), ['输出目录']);
  assert.deepEqual(scanParamRefs('{{params.filePath}}'), ['filePath']);
});

test('不带点号的写法不算参数引用', () => {
  assert.deepEqual(scanParamRefs('{{params}}'), []);
  assert.deepEqual(scanParamRefs('{{params.}}'), []);
});

test('env 是旧称，仍然认 —— 老画布不能一升级就全变成未解析', () => {
  assert.deepEqual(scanParamRefs('{{env.PATH}}'), ['PATH']);
});

/* ------------------------------------------------------------------ */

test('渲染：取到画布参数的值', () => {
  const r = renderTemplate('{{params.输出目录}}/report.md', {
    outputs: {}, params: { 输出目录: 'D:\\项目甲' },
  });
  assert.equal(r.text, 'D:\\项目甲/report.md');
  assert.deepEqual(r.missing, []);
});

test('渲染：没定义时保留原样并记 missing —— 不给空串', () => {
  /*
   * 空串的危害在这里特别大：路径类参数取到空串会变成
   * "写到当前目录"，文件真被写了、位置却不对 ——
   * 比直接报错难查得多。
   */
  const r = renderTemplate('{{params.输出目录}}/a.md', { outputs: {}, params: {} });
  assert.equal(r.text, '{{params.输出目录}}/a.md');
  assert.deepEqual(r.missing, ['params.输出目录']);
});

test('渲染：定义了空串与没定义要能区分', () => {
  const hit = renderTemplate('[{{params.x}}]', { outputs: {}, params: { x: '' } });
  assert.equal(hit.text, '[]');
  assert.deepEqual(hit.missing, []);
});

test('渲染：env 与 params 取同一份', () => {
  const a = renderTemplate('{{env.A}}', { outputs: {}, params: { A: '1' } });
  const b = renderTemplate('{{params.A}}', { outputs: {}, params: { A: '1' } });
  assert.equal(a.text, '1');
  assert.equal(b.text, '1');
});

/* ------------------------------------------------------------------ */

test('扫描节点：从任意层级的字符串字段里找引用', () => {
  const nodes = [
    { id: 'a', data: { path: '{{params.输出目录}}/x', nested: { deep: '{{params.项目名}}' } } },
    { id: 'b', data: { list: ['{{params.账号}}'] } },
  ];
  assert.deepEqual(paramRefsOfNodes(nodes), ['输出目录', '账号', '项目名'].sort());
});

test('扫描节点：不扫运行时产物', () => {
  /*
   * output 里可能带着上一次运行的模板原文 ——
   * 扫进去的话，跑过一次之后缺失清单会冒出假警报。
   */
  const nodes = [{ id: 'a', data: { path: '{{params.真参数}}', output: '{{params.残留}}' } }];
  assert.deepEqual(paramRefsOfNodes(nodes), ['真参数']);
});

test('扫描节点：排序稳定（好对比、不因遍历顺序跳动）', () => {
  const a = paramRefsOfNodes([{ id: 'x', data: { p: '{{params.b}} {{params.a}}' } }]);
  const b = paramRefsOfNodes([{ id: 'x', data: { p: '{{params.a}} {{params.b}}' } }]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['a', 'b']);
});

/* ------------------------------------------------------------------ */

test('缺失检测：引用了但没定义的才是问题', () => {
  const r = diffParamIssue(
    [{ name: '输出目录', value: 'D:\\a' }],
    ['输出目录', '项目名'],
  );
  assert.deepEqual(r.missing, ['项目名']);
  assert.deepEqual(r.unused, []);
});

test('缺失检测：定义了但没人用只提示（可能是预留）', () => {
  const r = diffParamIssue([{ name: '备用', value: '' }], []);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unused, ['备用']);
});

/* ------------------------------------------------------------------ */

test('一键补齐：只加缺的，不动已填的', () => {
  /*
   * 覆盖已有值会让用户以为自己没填。
   */
  const out = ensureParams(
    [{ name: '输出目录', value: 'D:\\已填' }],
    ['输出目录', '项目名'],
  );
  assert.equal(out.length, 2);
  assert.equal(paramValue(out, '输出目录'), 'D:\\已填', '已填的值不能被冲掉');
  assert.equal(paramValue(out, '项目名'), '');
});

test('一键补齐：跳过不合法的名字', () => {
  const out = ensureParams([], ['ok', '2bad', 'a.b']);
  assert.deepEqual(out.map((p) => p.name), ['ok']);
});

test('makeParamsFor 只收合法名', () => {
  assert.deepEqual(makeParamsFor(['a', '1x']).map((p) => p.name), ['a']);
});

/* ------------------------------------------------------------------ */

test('名字规则：中文可以，数字开头不行，点号不行', () => {
  assert.ok(isValidParamName('输出目录'));
  assert.ok(isValidParamName('file_path'));
  assert.ok(!isValidParamName(''));
  assert.ok(!isValidParamName('2ab'));
  assert.ok(!isValidParamName('a.b'), '点号是模板里的分隔符，参数名里不能有');
});

/* ------------------------------------------------------------------ */

test('旧存档迁移：env.vars 搬进 params，已有的不覆盖', () => {
  const out = migrateEnvVars(
    [{ name: 'A', value: '新值' }],
    { A: '老值', B: '老B' },
  );
  assert.equal(paramValue(out, 'A'), '新值', '新表已有了就不覆盖');
  assert.equal(paramValue(out, 'B'), '老B', '老存档的值不能丢');
});

test('旧存档迁移：空表也能跑', () => {
  assert.deepEqual(migrateEnvVars(undefined, undefined), []);
  assert.deepEqual(migrateEnvVars([], {}), []);
});

/* ------------------------------------------------------------------ */
/* 源码守卫                                                            */
/* ------------------------------------------------------------------ */

test('模板 TOKEN 必须支持中文', () => {
  /*
   * 中文参数名是这个功能的核心卖点（{{params.输出目录}}）。
   * TOKEN 里少了 \u4e00-\u9fa5 的话，中文名**整句匹配不上** ——
   * 不报错、missing 也不记，就是静默失效。
   */
  const t = fs.readFileSync(path.join(ROOT, 'engine/template.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里会原样写出这段正则，不剥会假阴性
  const m = t.match(/const TOKEN = \/([^\n]+)\/g;/);
  assert.ok(m, '没找到 TOKEN 定义');
  assert.match(m[1], /\\u4e00-\\u9fa5/, 'TOKEN 要支持中文，否则中文参数名静默失效');
});

test('runner 要把 params 传进模板', () => {
  /*
   * engine 支持了但调用方不传 = 等于没做。
   * 这是"两处都要改、改一处"的典型，必须有守卫。
   */
  const t = fs.readFileSync(path.join(ROOT, 'engine/runner.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(t, /params:\s*opts\.params/, 'renderTemplate 要带上 opts.params');
  const rt = fs.readFileSync(path.join(ROOT, 'engine/runTypes.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(rt, /params\?:\s*Record<string,\s*string>/, 'RunOpts 要有 params 字段');
});

test('模块存 paramRefs —— 否则拖进新画布扫不到它引用了什么', () => {
  const t = fs.readFileSync(path.join(ROOT, 'engine/modules.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(t, /paramRefs:\s*paramRefsOfNodes\(/, 'addModule 要扫出模块引用的参数');
});
