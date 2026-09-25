/**
 * 延时。
 *
 * 单独成文件是为了可测：等待节点若直接内联 setTimeout，
 * 测试就只能真的干等，断言"等了多久"要几百毫秒起步。
 * 抽出来后可由执行器注入一个记录用的替代实现。
 */

/** 造一个标准的取消错误。带 name 是为了让调用方能认出"这是取消，不是失败" */
export function abortError(message = '已取消'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** 这是取消吗？取消不该被当成节点失败去上报（超时那一侧已经判过了） */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * 延时，可选地可被中断。
 *
 * 为什么要有 signal
 * ------------------
 * 节点超时原本是**软超时**：到点判失败，但底层的等待并没有停 ——
 * 「等待 10 分钟」的节点即使设了 5 秒超时，那个 10 分钟的定时器
 * 仍然挂在事件循环里，进程想退出都退不掉。
 *
 * 给了 signal 之后，等待是**真的提前结束**：定时器被清掉，
 * promise 以取消错误结束。这是"软超时"向"真中断"迈出的第一步，
 * 至少纯等待这一类节点不再留下悬着的定时器。
 *
 * 已经取消过的 signal 立即结束，不会傻等 ——
 * 否则"先取消、后 await"的节点会再睡满一整段。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
