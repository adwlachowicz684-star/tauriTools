import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadColorOverrides, saveColorOverrides, setColorOverride,
  resolveNodeColor, isHexColor,
} from '../engine/nodeColors';

/**
 * 节点库里的自定义颜色。
 *
 * ================= 为什么是类型级 ====================
 *
 * 画布卡片的颜色取自 getDef(type).meta.color（类型色），
 * 侧栏条目用的也是同一份 —— 颜色的自然粒度是**类型**。
 *
 * 按预设存的话，同类型的多个预设会各有一份，
 * 而画布上的卡片只有 type 可查、不知道该用哪一份，
 * 于是侧栏与画布又显示成不同的颜色。
 */

function memKV() {
  const m = new Map<string, string>();
  return {
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string) => { m.set(k, v); },
    remove: (k: string) => { m.delete(k); },
    raw: m,
  };
}

test('改了类型色，侧栏与画布取到同一个值', () => {
  const kv = memKV();
  setColorOverride('math', '#112233', kv);
  // 侧栏走 allPresets（这里等价于按 type 解析）
  assert.equal(resolveNodeColor('math', '#f97316', undefined, loadColorOverrides(kv)), '#112233');
  // 画布走 NodeShell
  assert.equal(resolveNodeColor('math', '#f97316', undefined, loadColorOverrides(kv)), '#112233');
});

test('没覆盖时用节点定义的默认色', () => {
  assert.equal(resolveNodeColor('math', '#f97316', undefined, {}), '#f97316');
});

test('自定义预设自己的色比类型覆盖更具体', () => {
  /*
   * 自定义预设是"这一条"的设定，比"这类节点"更具体 ——
   * 让类型覆盖压过它的话，用户给某条预设单独挑的色会莫名失效。
   */
  assert.equal(resolveNodeColor('math', '#f97316', '#00ff00', { math: '#112233' }), '#00ff00');
});

test('非法色值一律不认（脏存档 / 手改过）', () => {
  assert.equal(isHexColor('#GGG'), false);
  assert.equal(isHexColor('red'), false);
  assert.equal(isHexColor('#fff'), false, '三位简写不认 —— 各家解析结果不一致');
  assert.equal(isHexColor('#AABBCC'), true);
  assert.equal(isHexColor('  #aabbcc  '), true);
});

test('恢复默认 = 删掉这一条，不留空值', () => {
  const kv = memKV();
  setColorOverride('math', '#112233', kv);
  assert.equal(loadColorOverrides(kv).math, '#112233');
  setColorOverride('math', null, kv);
  assert.equal(loadColorOverrides(kv).math, undefined, '留空值会让"恢复默认"看起来没生效');
});

test('传非法色也当恢复默认（不会存进一个坏值）', () => {
  const kv = memKV();
  setColorOverride('math', '#112233', kv);
  setColorOverride('math', 'red', kv);
  assert.equal(loadColorOverrides(kv).math, undefined);
});

test('脏存档不会让插件起不来', () => {
  const kv = memKV();
  kv.set('agent-flow.nodeColors.v1', '{ 不是 JSON');
  assert.deepEqual(loadColorOverrides(kv), {});
  kv.set('agent-flow.nodeColors.v1', '["数组但不是对象"]');
  assert.deepEqual(loadColorOverrides(kv), {});
});

test('脏存档里的坏条目被丢掉，好的留下', () => {
  const kv = memKV();
  saveColorOverrides({ math: '#112233', bad: 'nope' }, kv);
  const map = loadColorOverrides(kv);
  assert.equal(map.math, '#112233');
  assert.equal(map.bad, undefined);
});

test('不影响别的类型', () => {
  const kv = memKV();
  setColorOverride('math', '#112233', kv);
  assert.equal(resolveNodeColor('ocr', '#f472b6', undefined, loadColorOverrides(kv)), '#f472b6');
});
