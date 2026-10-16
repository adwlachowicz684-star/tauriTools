import test from 'node:test';
import assert from 'node:assert/strict';
import { toServerRefs, serverRefSkips, type GlobalMcpServer } from '../engine/mcpServers';
import { readSrc } from './srcScan';

const S = (name: string, o: Partial<GlobalMcpServer> = {}): GlobalMcpServer =>
  ({ id: name || 'x', name, url: `http://${name}`, ...o });

/* ================================================================== */
/* 行为：丢了的要说一声                                                */
/* ================================================================== */

test('没填名字的服务：丢弃是对的，但要说', () => {
  assert.deepEqual(toServerRefs([S('')]), [], '没名字没法引用，丢弃本身正确');
  const skips = serverRefSkips([S('')]);
  assert.equal(skips.length, 1);
  assert.ok(skips[0].includes('没填名字'), `实际：${skips[0]}`);
});

/*
 * 重名：`toServerRefs` 只留第一个。而名字是引用的依据，
 * 两个同名服务根本无法区分 —— 所以丢弃是对的，但**丢了不说**，
 * 用户会以为第二个服务连上了。
 */
test('重名的服务：只连第一个，但要说', () => {
  const refs = toServerRefs([S('fs', { url: 'http://1' }), S('fs', { url: 'http://2' })]);
  assert.equal(refs.length, 1);
  const skips = serverRefSkips([S('fs', { url: 'http://1' }), S('fs', { url: 'http://2' })]);
  assert.equal(skips.length, 1);
  assert.ok(skips[0].includes('fs'), `要说是哪个名字：${skips[0]}`);
});

test('停用的服务不算被丢（那是用户主动关的，不该提示）', () => {
  const list = [S('fs', { disabled: true })];
  assert.deepEqual(toServerRefs(list), []);
  assert.deepEqual(serverRefSkips(list), [],
    '停用不算"丢了" —— 用户自己关的，提示他反而变成噪音');
});

test('都正常 → 不报任何', () => {
  assert.deepEqual(serverRefSkips([S('a'), S('b')]), []);
});

test('多个问题 → 每个都报（不合并、不取第一条）', () => {
  const skips = serverRefSkips([S(''), S('fs'), S('fs')]);
  assert.equal(skips.length, 2, '没名字 + 重名，两条都要说');
});

test('空列表 / 坏输入不炸', () => {
  assert.deepEqual(serverRefSkips([]), []);
  assert.deepEqual(serverRefSkips([null, undefined] as unknown as GlobalMcpServer[]), []);
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

/*
 * 判定写好没人调 —— 这个系列已经出过五次（runPlaceholder / looksAbsolute /
 * FS_FORBIDDEN / canPack / 埋藏触发器）。所以这次必须有守卫钉住。
 */
test('源码守卫：hook 要真的把 skips 说出来', () => {
  const src = readSrc('hooks/useMcpRegistry.ts');
  assert.ok(/serverRefSkips\(/.test(src), '算了但不说，等于没算');
  /*
   * 不能只查"文件里有 onLog"和"文件里有 skips" ——
   * 那两样各自成立时，日志里可能根本没提 skips（注入已验证：全绿）。
   * 要的是**同一句**里把 skips 说出去。
   */
  assert.ok(/onLog\([^)]*skips/.test(src), '算了但不说，等于没算');
});

test('源码守卫：上报要去重（否则每敲一个字符刷一次日志）', () => {
  const src = readSrc('hooks/useMcpRegistry.ts');
  const i = src.indexOf('serverRefSkips(');
  assert.ok(i >= 0);
  const body = src.slice(i - 400, i + 700);
  /*
   * 不能只查"出现了 skipKeyRef" —— 赋值那行也算出现（注入已验证：全绿）。
   * 要的是**在打日志之前**用它比过一次，也就是它在 onLog 之前出现。
   */
  const atRef = body.indexOf('skipKeyRef');
  const atLog = body.indexOf('onLog(');
  assert.ok(atRef >= 0 && atRef < atLog,
    '去重必须在打日志之前 —— 这个 effect 每敲一个字符都跑，不去重会刷屏');
});

test('源码守卫：toServerRefs 仍是纯的（返回 refs，不带诊断）', () => {
  const src = readSrc('engine/mcpServers.ts');
  const i = src.indexOf('export function toServerRefs');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/ServerRefLike\[\]/.test(body), '返回类型不变 —— 调用方不用改');
});
