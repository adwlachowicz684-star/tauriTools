/**
 * 参数连线的**写入位置**必须与卡片上的编辑位置是同一个。
 *
 * ================= 为什么单独一份 =================
 *
 * 卡片上改一个格子走 `edit.path`（点分路径，可能嵌在数组里），
 * 参数连线却只有 `targetArg`（端口 key）一个坐标，运行时按它平铺写
 * `data[key]`。两者是同一件事的**两份实现**，于是必然漂移：
 *
 *   条件规则  → 值在 rules[0].value，连线写 data.value      → 连了没效果
 *   触发器方式 → 值在 entries[0].kind，连线写 data.kind      → 节点不再是触发器
 *
 * 两种都**不报错**。第二种最糟：data.kind 是 getRunner 选执行器的钥匙，
 * 一改它 RUNNERS 查不到，节点退化成「直通成功、什么都没做」——
 * 节点是绿的、流程照跑，只是触发再也没发生过。
 *
 * ================= 怎么测 =================
 *
 * 一部分断言跑纯函数（linkableArgKey / applyParamLinks 都是纯的），
 * 一部分跑源码扫描 —— 「卡片按判据画端口」这件事跑不出红，
 * 只能盯住它真的用了同一份判据（与 classNames / uiConsistency 同套路）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkableArgKey, type BriefPart } from '../engine/ops';
import { applyParamLinks, argHandleId } from '../engine/paramLinks';
import { getRunner } from '../engine/runnerRegistry';
import { readSrc } from './srcScan';

const part = (p: Partial<BriefPart> & { role: BriefPart['role']; text: string }): BriefPart =>
  p as BriefPart;

/* ================= 端口：值不在 data[key] 上的格子不给画 ================= */

test('平铺参数能接连线', () => {
  assert.equal(linkableArgKey(part({ role: 'val', text: '梨子', key: 'b' })), 'b');
  // path 与 key 相同 = 写了等于没写，仍然是平铺
  assert.equal(
    linkableArgKey(part({
      role: 'val', text: '梨子', key: 'b', edit: { key: 'b', kind: 'text', path: 'b' },
    })),
    'b',
  );
});

test('条件规则的值 / 运算符不给画端口 —— 它们在 rules[i].x 上', () => {
  assert.equal(
    linkableArgKey(part({
      role: 'val', text: '梨子', key: 'value', edit: { key: 'value', kind: 'text', path: 'rules.0.value' },
    })),
    null,
    '连线只会写 data.value，写不进 rules[0].value —— 连了跟没连一样',
  );
  assert.equal(
    linkableArgKey(part({
      role: 'op', text: '包含', key: 'op', edit: { key: 'op', kind: 'select', path: 'rules.0.op' },
    })),
    null,
  );
});

test('触发器的触发方式不给画端口 —— data.kind 是分发依据', () => {
  assert.equal(
    linkableArgKey(part({
      role: 'val', text: 'Webhook', key: 'kind', edit: { key: 'kind', kind: 'select', path: 'entries.0.kind' },
    })),
    null,
    '写进 data.kind 会让节点不再是触发器',
  );
});

test('不是参数的格子（运算符 / 纯文字）本来就没有端口', () => {
  assert.equal(linkableArgKey(part({ role: 'op', text: '＋' })), null);
  assert.equal(linkableArgKey(part({ role: 'text', text: '「' })), null);
});

/* ================= 兜底：分发依据写不掉 ================= */

test('参数连线写不到 data.kind', () => {
  assert.deepEqual(applyParamLinks({ kind: 'trigger' } as Record<string, unknown>, { kind: 'webhook' }), {
    kind: 'trigger',
  });
});

test('兜住之后，触发器仍然查得到执行器 —— 不会退化成直通', () => {
  const merged = applyParamLinks({ kind: 'trigger' } as Record<string, unknown>, { kind: 'webhook' });
  assert.ok(getRunner(merged), 'data.kind 被连线改掉的话这里会查不到，节点当场不再是触发器');
});

test('正常参数照常写进去 —— 兜底不能写宽', () => {
  assert.deepEqual(applyParamLinks({ a: 'X', b: '梨子' }, { b: '香蕉' }), { a: 'X', b: '香蕉' });
});

/* ================= 卡片真的用了同一份判据 ================= */

test('ArgCell 的端口 id 走 linkableArgKey，不是直接用 part.key', () => {
  const src = readSrc('components/ArgCell.tsx');
  assert.ok(/linkableArgKey\(/.test(src), '不接住判据的话，edit.path 那批格子照样画端口');
  assert.ok(!/id=\{argHandleId\(part\.key\)\}/.test(src), '端口 id 不能用 part.key');
  assert.ok(/argHandleId\(/.test(src), '仍然要用 argHandleId 生成端口 id');
  assert.ok(!/part\.key \? ' node-arg-port'/.test(src), '端口类名也要跟着判据走');
});

test('端口名与连线读取用的是同一个拼法', () => {
  // 端口 id 必须还是 `arg:key`，否则连线那侧读不出来
  assert.equal(argHandleId('b'), 'arg:b');
});
