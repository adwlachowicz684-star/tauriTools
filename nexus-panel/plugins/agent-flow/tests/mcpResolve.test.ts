import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveServer, type GlobalMcpServer } from '../engine/mcpServers';
import { readSrc } from './srcScan';

type R = ReturnType<typeof resolveServer>;
const S = (name: string, o: Partial<GlobalMcpServer> = {}): GlobalMcpServer =>
  ({ id: name, name, url: `http://${name}`, ...o });

/** 窄化：断言失败并取出 reason / names */
const bad = (r: R): { reason: string; names: string[] } => {
  assert.equal(r.ok, false);
  return r as Extract<R, { ok: false }>;
};

/* ================================================================== */
/* 「都停用了」≠「没配」                                                */
/* ================================================================== */

/*
 * 本轮要修的那件事。
 *
 * 统一说"全局没配任何 MCP 服务"的话，用户去全局库一看服务明明在那
 * —— 于是以为解析坏了，去查一个不存在的问题。
 */
test('配了但全部停用：要说"停用"，不能说"没配任何"', () => {
  const r = bad(resolveServer([S('fs', { disabled: true })], 'fs'));
  assert.ok(r.reason.includes('停用'), `实际：${r.reason}`);
  assert.ok(!r.reason.includes('没配任何'), `不能说没配：${r.reason}`);
});

test('真没配：才说"没配任何"（对照组）', () => {
  const r = bad(resolveServer([], 'fs'));
  assert.ok(r.reason.includes('没配任何'), `实际：${r.reason}`);
});

test('全部停用时，reason 里要带服务数（让用户知道不是空的）', () => {
  const r = bad(resolveServer([S('a', { disabled: true }), S('b', { disabled: true })], 'a'));
  assert.ok(r.reason.includes('2'), `实际：${r.reason}`);
});

/* ================================================================== */
/* 「有但停用了」≠「没有这个名字」                                      */
/* ================================================================== */

test('选中了但被停用：要说"已停用"，不能说"没有这个名字"', () => {
  const r = bad(resolveServer([S('fs', { disabled: true }), S('gh')], 'fs'));
  assert.ok(r.reason.includes('停用'), `实际：${r.reason}`);
  assert.ok(!r.reason.includes('没有这个名字'), `不能说没有：${r.reason}`);
});

test('选了真不存在的名字：才说"没有这个名字"（对照组）', () => {
  const r = bad(resolveServer([S('gh')], 'zzz'));
  assert.ok(r.reason.includes('没有这个名字'), `实际：${r.reason}`);
});

test('停用且是唯一服务、又没填名字 → 视为没得用（不是报错）', () => {
  const r = resolveServer([S('fs', { disabled: true })], '');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server, null);
});

/* ================================================================== */
/* 同名服务是歧义，不能靠顺序挑                                        */
/* ================================================================== */

/*
 * 名字是节点里引用的依据。同名的两个服务根本无法区分引用，
 * find 取第一个的话选中哪个取决于配置顺序 ——
 * 两个服务提供同名工具时结果看着还挺合理，但连的是另一个服务。
 */
test('两个同名服务：报歧义，不静默挑第一个', () => {
  const r = bad(resolveServer([S('fs', { url: 'http://one' }), S('fs', { url: 'http://two' })], 'fs'));
  assert.ok(r.reason.includes('分不清'), `实际：${r.reason}`);
});

test('同名但都停用：走"没有可用服务"，不是歧义', () => {
  const r = bad(resolveServer(
    [S('fs', { disabled: true }), S('fs', { disabled: true })], 'fs'));
  assert.ok(r.reason.includes('停用'), `实际：${r.reason}`);
});

/* ================================================================== */
/* 既有行为，钉住别改坏                                                */
/* ================================================================== */

test('唯一服务、没填名字 → 直接用它（"唯一时可省略"）', () => {
  const r = resolveServer([S('fs')], '');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server?.name, 'fs');
});

test('多个服务、没填名字 → 必须指定', () => {
  const r = bad(resolveServer([S('a'), S('b')], ''));
  assert.ok(r.reason.includes('必须指定'), `实际：${r.reason}`);
});

test('选中了且启用 → 正常解析', () => {
  const r = resolveServer([S('fs', { disabled: true }), S('gh')], 'gh');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server?.name, 'gh');
});

test('名字前后空格不影响匹配', () => {
  const r = resolveServer([S('fs')], '  fs  ');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server?.name, 'fs');
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

test('源码守卫：要区分"没配"与"都停用"', () => {
  const src = readSrc('engine/mcpServers.ts');
  const i = src.indexOf('export function resolveServer');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/停用了/.test(body), '不区分的话，用户会去查一个不存在的问题');
});

test('源码守卫：要区分"没有这个名字"与"有但停用"', () => {
  const src = readSrc('engine/mcpServers.ts');
  const i = src.indexOf('export function resolveServer');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/已停用/.test(body));
  assert.ok(/s\.disabled && nameOf\(s\) === picked/.test(body), '要真的去停用里找一遍');
});

test('源码守卫：同名用 filter 数个数，不是 find 取第一个', () => {
  const src = readSrc('engine/mcpServers.ts');
  const i = src.indexOf('export function resolveServer');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/hits\.length > 1/.test(body), 'find 取第一个的话，同名服务靠配置顺序决定');
  assert.ok(!/usable\.find\(/.test(body));
});
