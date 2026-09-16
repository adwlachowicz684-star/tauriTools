/**
 * 延时。
 *
 * 单独成文件是为了可测：等待节点若直接内联 setTimeout，
 * 测试就只能真的干等，断言"等了多久"要几百毫秒起步。
 * 抽出来后可由执行器注入一个记录用的替代实现。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
