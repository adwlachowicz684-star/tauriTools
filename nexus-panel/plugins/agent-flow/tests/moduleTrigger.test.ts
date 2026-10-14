import test from 'node:test';
import assert from 'node:assert/strict';
import { canPack, packSelection } from '../engine/modules';
import { readSrc } from './srcScan';

const PN = (id: string, data: Record<string, unknown> = {}) => ({
  id, position: { x: 0, y: 0 }, data,
});

test('打包：选中集合里有触发器就不许打包', () => {
  const r = canPack([PN('a'), PN('t', { kind: 'trigger', enabled: true, triggers: ['webhook'] })] as never);
  assert.equal(r.ok, false);
});

test('打包：拒绝理由要说清"自动触发不会发生"（只说不能打包等于没说）', () => {
  const r = canPack([PN('t', { kind: 'trigger' })] as never);
  assert.ok(r.reason, '拒绝必须带理由');
  assert.ok(r.reason!.includes('自动触发'), `理由要讲清后果，实际是：${r.reason}`);
  assert.ok(r.reason!.includes('模块'), `理由要说明是模块导致的，实际是：${r.reason}`);
});

test('打包：没有触发器的集合照常放行（别把正常用法一起拦掉）', () => {
  assert.equal(canPack([PN('a', { kind: 'const' }), PN('b', { kind: 'text' })] as never).ok, true);
});

test('打包：packSelection 本身仍然能把触发器收进去（证明 canPack 是唯一的挡）', () => {
  const picked = [PN('t', { kind: 'trigger', enabled: true }), PN('a', { kind: 'const' })] as never[];
  const r = packSelection(picked, [] as never[], picked);
  assert.ok(r.nodes.length >= 2, 'packSelection 不挑节点——所以拦截必须在 canPack 上');
});

test('源码守卫：界面打包处真的调了 canPack（不然又是一个"写了没接上"的对策）', () => {
  const src = readSrc('App.tsx');
  const i = src.indexOf('const picked = nodes.filter((n) => n.selected);');
  assert.ok(i >= 0, '找不到打包的选中集合');
  const seg = src.slice(i, i + 3000);
  assert.ok(/canPack\s*\(/.test(seg), '打包路径必须调 canPack');
  assert.ok(
    /verdict\.reason|canPack\([\s\S]{0,200}\.reason/.test(seg),
    '拦下来必须把原因打出来，光 return 不给理由等于让人以为功能坏了',
  );
});

test('源码守卫：canPack 的触发器判据取自 triggerRegistry，不另写一份', () => {
  const src = readSrc('engine/modules.ts');
  const i = src.indexOf('export function canPack');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/isTriggerNode/.test(body), '必须复用 triggerRegistry 的判据');
  assert.ok(
    !/kind\s*===\s*['"]trigger['"]/.test(body),
    '不要在这里手写 kind === "trigger"——两份判据必然漂移',
  );
});
