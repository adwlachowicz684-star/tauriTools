import test from 'node:test';
import assert from 'node:assert/strict';
import { isNodeDisabled, nodeDisabledOf } from '../engine/nodeDisabled';

/**
 * 节点的关闭开关。
 *
 * 调试时常要临时停掉某一步：删掉就得重连上下游，
 * 而"先关掉、待会儿再开"才是真实用法。
 */

test('缺省 = 开着（老存档没有这个字段）', () => {
  assert.equal(isNodeDisabled(undefined), false);
  assert.equal(isNodeDisabled({ data: {} }), false);
});

test('只有 true 才算关 —— 不做推断', () => {
  /*
   * 写成 `!!d.disabled` 的话，"disabled": "false" 也会被当成关，
   * 而界面上明明显示的是开着。
   */
  assert.equal(isNodeDisabled({ data: { disabled: true } }), true);
  assert.equal(isNodeDisabled({ data: { disabled: false } }), false);
  assert.equal(isNodeDisabled({ data: { disabled: 'false' } }), false);
  assert.equal(isNodeDisabled({ data: { disabled: 1 } }), false);
});

test('两种读法一致（卡片用前者，面板用后者）', () => {
  assert.equal(nodeDisabledOf({ disabled: true }), true);
  assert.equal(nodeDisabledOf(undefined), false);
});
