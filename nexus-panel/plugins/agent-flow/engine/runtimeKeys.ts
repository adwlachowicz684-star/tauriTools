/**
 * 运行时字段清单 —— 全项目**只有这一份**。
 *
 * ================= 为什么必须只有一份 =================
 *
 * 之前 duplicate.ts 与 modules.ts 各写了一份 `['status','output','error']`。
 * 这类清单复制两份的代价是：以后新增运行时字段时漏改一处，
 * 就会出现"复制节点清掉了、存模块没清掉"（或反过来）——
 * **这种不一致不报错**，只会表现为"拖出来的实例看起来已经跑完了"。
 *
 * ================= 为什么是黑名单而不是白名单 =================
 *
 * 各节点的配置字段差异太大，白名单既长又容易漏；
 * 而运行时字段的命名是收敛的（就那几个，外加 last* 前缀）。
 * 副作用：往后新增的运行时字段，只要沿用 last* 命名就自动被清掉。
 */

export const RUNTIME_KEYS = ['status', 'output', 'error'] as const;

/** last* 前缀的一律算运行时（lastSha / lastCommit / lastFiredAt …） */
export const RUNTIME_PREFIX = 'last';

export function isRuntimeKey(key: string): boolean {
  const k = String(key ?? '');
  if ((RUNTIME_KEYS as readonly string[]).indexOf(k) >= 0) return true;
  return k.indexOf(RUNTIME_PREFIX) === 0;
}

/**
 * 剥掉 data 里的运行时字段。
 *
 * 注意它**不**补 status/output/error 的默认值 ——
 * 调用方应当先用 def.create(newId) 铺一遍全字段默认值，再叠这里的结果。
 * 这样默认值只有一处（节点定义），不会在这里抄第二份。
 */
export function stripRuntime(data: unknown): Record<string, unknown> {
  const src = (data ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (isRuntimeKey(k)) continue;
    out[k] = src[k];
  }
  return out;
}

/**
 * 剥掉一批节点的运行时字段。
 *
 * 与 stripRuntime 同一套口径，只是作用在节点数组上 ——
 * 以前这两份是各自实现的，现在共用 isRuntimeKey。
 */
export function stripRuntimeNodes(
  nodes: Record<string, unknown>[],
): Record<string, unknown>[] {
  return (nodes ?? []).map((n) => ({
    ...n,
    data: stripRuntime((n?.data ?? {}) as Record<string, unknown>),
  }));
}
