import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveParallel, clampConcurrency, effectiveConcurrency, MAX_CONCURRENCY,
} from '../engine/parallel';
import type { ParallelNodeData } from '../types';

const P = (over: Partial<ParallelNodeData>): ParallelNodeData => ({
  kind: 'parallel', label: 'p', mode: 'fixed', concurrency: 2,
  rules: [], fallbackConcurrency: 1, status: 'idle', output: '', error: '',
  ...over,
});

/* ---------- 钳制 ---------- */

test('钳制: 小于 1 归 1', () => {
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(-5), 1);
  assert.equal(clampConcurrency(0.4), 1);
});

test('钳制: 超过上限归上限', () => {
  assert.equal(clampConcurrency(9999), MAX_CONCURRENCY);
});

test('钳制: 小数取整', () => {
  assert.equal(clampConcurrency(3.7), 3);
});

test('钳制: 非法值统一归 1（保守）', () => {
  assert.equal(clampConcurrency(Number.NaN), 1);
  // Infinity 也归 1 而不是上限：配置里出现非法值时，
  // 串行跑比"悄悄全速并发"安全得多（后者可能瞬间打满限频）
  assert.equal(clampConcurrency(Number.POSITIVE_INFINITY), 1);
});

/* ---------- fixed ---------- */

test('fixed: 返回固定并发', () => {
  const r = resolveParallel(P({ mode: 'fixed', concurrency: 4 }), '任意');
  assert.equal(r.concurrency, 4);
  assert.equal(r.ruleIndex, -1);
});

test('fixed: 会被钳制', () => {
  assert.equal(resolveParallel(P({ mode: 'fixed', concurrency: 999 }), '').concurrency, MAX_CONCURRENCY);
  assert.equal(resolveParallel(P({ mode: 'fixed', concurrency: 0 }), '').concurrency, 1);
});

/* ---------- all ---------- */

test('all: 返回 Infinity（不受固定值影响）', () => {
  const r = resolveParallel(P({ mode: 'all', concurrency: 3 }), '');
  assert.equal(r.concurrency, Infinity);
});

test('all: 实际并发受任务数限制', () => {
  assert.equal(effectiveConcurrency(Infinity, 5), 5);
  assert.equal(effectiveConcurrency(Infinity, 100), MAX_CONCURRENCY);
});

test('fixed: 实际并发不超过任务数', () => {
  assert.equal(effectiveConcurrency(4, 2), 2, '只有 2 个任务就开 2 个');
  assert.equal(effectiveConcurrency(4, 10), 4);
});

test('effectiveConcurrency: 至少 1', () => {
  assert.equal(effectiveConcurrency(0, 0), 1);
});

/* ---------- byRule ---------- */

const R = (op: string, value: string, concurrency: number) => ({
  id: `r${Math.random()}`, op: op as never, value, concurrency,
});

test('byRule: 命中第一条', () => {
  const r = resolveParallel(P({
    mode: 'byRule',
    rules: [R('contains', 'error', 1), R('contains', 'error', 5)],
  }), 'an error occurred');
  assert.equal(r.concurrency, 1);
  assert.equal(r.ruleIndex, 0);
});

test('byRule: 按顺序取第一命中', () => {
  const r = resolveParallel(P({
    mode: 'byRule',
    rules: [R('contains', 'zzz', 3), R('contains', 'ok', 7)],
  }), 'status ok');
  assert.equal(r.concurrency, 7);
  assert.equal(r.ruleIndex, 1);
});

test('byRule: 无命中走兜底', () => {
  const r = resolveParallel(P({
    mode: 'byRule', rules: [R('contains', 'zzz', 3)], fallbackConcurrency: 2,
  }), 'hello');
  assert.equal(r.concurrency, 2);
  assert.equal(r.ruleIndex, -1);
});

test('byRule: 正则规则', () => {
  const r = resolveParallel(P({
    mode: 'byRule', rules: [R('regex', '^PROD', 8)], fallbackConcurrency: 1,
  }), 'PROD-env');
  assert.equal(r.concurrency, 8);
});

test('byRule: 非法正则跳过，继续匹配后续规则', () => {
  const r = resolveParallel(P({
    mode: 'byRule',
    rules: [R('regex', '[', 5), R('contains', 'ok', 6)],
    fallbackConcurrency: 1,
  }), 'status ok');
  assert.equal(r.concurrency, 6, '坏规则应被跳过');
  assert.equal(r.errors.length, 1);
});

test('byRule: 非法正则且无其他命中 → 兜底并报错', () => {
  const r = resolveParallel(P({
    mode: 'byRule', rules: [R('regex', '(', 5)], fallbackConcurrency: 3,
  }), 'hello');
  assert.equal(r.concurrency, 3);
  assert.equal(r.errors.length, 1);
});

test('byRule: 空规则列表直接用兜底', () => {
  const r = resolveParallel(P({ mode: 'byRule', rules: [], fallbackConcurrency: 4 }), 'x');
  assert.equal(r.concurrency, 4);
});

test('byRule: 并发值会被钳制', () => {
  const r = resolveParallel(P({
    mode: 'byRule', rules: [R('contains', 'ok', 0)], fallbackConcurrency: 1,
  }), 'ok');
  assert.equal(r.concurrency, 1);
});

test('reason: 说明文案可读', () => {
  assert.match(resolveParallel(P({ mode: 'fixed', concurrency: 3 }), '').reason, /固定 3/);
  assert.match(resolveParallel(P({ mode: 'all' }), '').reason, /不限/);
  assert.match(resolveParallel(P({ mode: 'byRule', rules: [], fallbackConcurrency: 2 }), '').reason, /2/);
});
