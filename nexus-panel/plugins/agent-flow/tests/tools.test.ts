import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime } from '../engine/clock';

/**
 * 工具节点里可测的部分。
 *
 * 执行器本身大多依赖运行时能力（AudioContext、Web Audio、执行器注入），
 * 但时间格式化是纯函数，值得盯住 —— 尤其是占位符替换的边界。
 */

test('常用格式：YYYY-MM-DD HH:mm:ss', () => {
  const d = new Date(2026, 8, 17, 9, 5, 3);
  assert.equal(formatTime('YYYY-MM-DD HH:mm:ss', d), '2026-09-17 09:05:03');
});

test('两位补零', () => {
  // 1 月 2 日 3 时 4 分 5 秒
  const d = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(formatTime('MM/DD HH:mm', d), '01/02 03:04');
});

test('毫秒 SSS', () => {
  const d = new Date(2026, 0, 1, 0, 0, 0, 7);
  assert.equal(formatTime('ss.SSS', d), '00.007');
});

test('非占位符字符原样保留', () => {
  const d = new Date(2026, 8, 17);
  assert.equal(formatTime('备份_YYYYMMDD.txt', d), '备份_20260917.txt');
});

test('只有年：YYYY', () => {
  assert.equal(formatTime('YYYY', new Date(2026, 0, 1)), '2026');
});

test('空格式返回空串', () => {
  assert.equal(formatTime('', new Date()), '');
});

test('没有任何占位符时原样返回（执行器会据此提示用户）', () => {
  assert.equal(formatTime('hello', new Date()), 'hello');
});

/**
 * 这条守一个真实的解析坑：从长到短匹配。
 * 若按 'MM' 先匹配，'SSS' 的首字符 S 不会被吃掉；
 * 但 'ss' 与 'SSS' 若顺序写反，或漏了长度降序，
 * 就会出现 "SS" 被当普通字符、多出一个 'S' 的问题。
 */
test('毫秒与秒共存时不串行', () => {
  const d = new Date(2026, 0, 1, 0, 0, 12, 345);
  assert.equal(formatTime('ss.SSS', d), '12.345');
  assert.equal(formatTime('SSS', d), '345');
});

test('同一占位符可重复出现', () => {
  const d = new Date(2026, 8, 17);
  assert.equal(formatTime('YYYY年MM月DD日 (MM)', d), '2026年09月17日 (09)');
});
