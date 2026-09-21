import test from 'node:test';
import assert from 'node:assert/strict';
import { planHistoryRetry, emptyHistory, type HistoryFile } from '../engine/history';
import { readSrc } from './srcScan';

function mk(n: number): HistoryFile {
  const f = emptyHistory();
  f.entries = Array.from({ length: n }, (_, i) => ({ id: `h${i}` }) as never);
  return f;
}

/* ================= 配额裁剪 ================= */

test('写不下时裁一半最旧的', () => {
  const r = planHistoryRetry(mk(8));
  assert.ok(r);
  assert.equal(r!.entries.length, 4);
  assert.equal((r!.entries[0] as { id: string }).id, 'h0', '保留的是新的那一半吗 —— 反过来就是丢最新的');
});

test('只剩一条时返回 null —— 否则会陷进裁了再写的死循环', () => {
  assert.equal(planHistoryRetry(mk(1)), null);
});

test('空表返回 null', () => {
  assert.equal(planHistoryRetry(mk(0)), null);
});

test('版本号不被改动', () => {
  const f = mk(6);
  assert.equal(planHistoryRetry(f)!.v, f.v);
});

/* ================= 源码守卫 ================= */

/*
 * 任务与历史已抽到 hooks/useTaskStore。
 * 两处都扫 —— 只盯 App.tsx 的话，代码搬走后守卫会**假通过**
 * （失效的样子是绿的，比红了更危险）。
 */
const TASK_SRC = () => readSrc('App.tsx', 'hooks/useTaskStore.ts');

test('归档写失败要提示，不能静默', () => {
  const src = TASK_SRC();
  assert.ok(
    /setHistWarn\(/.test(src),
    '写盘失败必须给用户一句提示 —— 静默的话他会以为归档好了，下次打开却是空的',
  );
  assert.ok(
    /存储空间不足/.test(src),
    '最后那次失败要说明"没存下"，而不是只说"空间紧张"',
  );
});

test('裁剪用引擎层的 planHistoryRetry，不各写一份', () => {
  const src = TASK_SRC();
  assert.ok(/planHistoryRetry\(/.test(src), '要走引擎层那一份（可单测），而不是 hook 里内联一行 slice');
});

test('每秒刷新只在真的有任务在跑时才走', () => {
  const src = TASK_SRC();
  assert.ok(/if \(!hasRunning\) return;/.test(src), '全部空闲时每秒重渲染整个列表是白烧 CPU');
});
