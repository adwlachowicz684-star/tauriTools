import { useEffect, useRef, useState } from 'react';

/**
 * 全局「进行中」提示（右下角胶囊）。
 * ------------------------------------------------------------------
 * `useFpx` 里的 `busy` 本来**没人读**——所有卡片级操作（改名、搬家、上锁、
 * 设图标、保存配置）跑起来时界面上没有任何表现，按钮也不禁用。
 * 于是长操作（备份整树遍历、枚举编辑器）期间用户看到的是一个
 * **完全没反应**的界面：他不知道是慢还是卡死，只能再点一次。
 *
 * 再点一次的后果要看操作是什么：多数是幂等的（重跑一遍），
 * 但"再点一次"本身说明界面给的信息不够 —— 这正是要补的东西。
 *
 * ------------------------------------------------------------------
 * 为什么**必须延迟显示**，不能 busy 一变 true 就显示：
 *
 * 绝大多数操作只要几十毫秒。立刻显示的话，每保存一次配置就闪一下
 * 「进行中」，界面像在抽搐 —— 比不显示更糟。
 * 延迟 250ms 之后才显示，短操作根本不会出现，只留真正慢的那些。
 *
 * 为什么显示之后还要**至少显示一会儿**（minShow）：
 *
 * 只做延迟、不做最短时长的话，一个 300ms 的操作会出现 50ms 然后消失
 * —— 那一下闪现比一直不显示更晃眼。既然显示了，就让它待够。
 *
 * ------------------------------------------------------------------
 * 为什么用 `shownRef` 镜像 `shown` 而不是把 shown 放进依赖数组：
 *
 * 放进去的话，`setShown(true)` 会让 effect 重跑；此时 busy 仍是 true，
 * 于是 `startRef` 被重置、又排一个 delay 的定时器 ——
 * 表现为"明明在忙，提示却迟迟不出现"。
 */
/**
 * 忙碌结束后还要停留多久才隐藏（毫秒）。
 *
 * 抽成纯函数是因为这是**最容易写错的一处**：
 * 写错了的表现是"提示闪一下就没了"或"该消失了还杵在那儿"，
 * 而这两者在界面上都只在特定时长下才复现，手测很难撞准。
 * 纯函数可以穷举（见 busy-indicator-test 第 6 节）。
 *
 * @param shown     这次**有没有真的显示过**（短操作没到延迟就结束了，没显示过）
 * @param elapsedMs 从忙碌开始到现在过了多久
 */
export function busyHideDelay(shown: boolean, elapsedMs: number, minShow: number): number {
  if (!shown) return 0;
  return Math.max(0, Math.min(minShow, minShow - elapsedMs));
}

/** 播报/显示的文案。隐藏时必须为空，否则屏幕阅读器会念出没有宾语的「进行中」。 */
export function busyText(shown: boolean, label: string): string {
  return shown ? `正在${label}…` : '';
}

export interface BusyIndicatorProps {
  busy: boolean;
  /** 在做什么（来自 useFpx.run 的 label），例如「备份」→「正在备份…」 */
  label: string;
  /** 忙碌多久后才显示（毫秒） */
  delay?: number;
  /** 一旦显示，至少停留多久（毫秒） */
  minShow?: number;
}

export function BusyIndicator({
  busy, label, delay = 250, minShow = 600,
}: BusyIndicatorProps) {
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  const startRef = useRef(0);

  useEffect(() => {
    if (busy) {
      startRef.current = Date.now();
      const timer = window.setTimeout(() => {
        shownRef.current = true;
        setShown(true);
      }, delay);
      return () => window.clearTimeout(timer);
    }
    // 从没显示过（短操作）→ 直接结束，不必再走一次隐藏
    if (!shownRef.current) return;
    const left = busyHideDelay(shownRef.current, Date.now() - startRef.current, minShow);
    const timer = window.setTimeout(() => {
      shownRef.current = false;
      setShown(false);
    }, left);
    return () => window.clearTimeout(timer);
  }, [busy, delay, minShow]);

  /*
   * 容器**始终挂在 DOM 上**，只由 data-on 控制显隐。
   *
   * 不能 busy 结束就整块不渲染：aria-live 区域必须是「先存在、后变化」
   * 才会被屏幕阅读器播报；临时挂载的节点往往读不到，等于没有无障碍提示。
   *
   * 文本在隐藏时为空：避免出现「进行中」这种没有宾语的占位被播报出去。
   */
  return (
    <div
      className="fpx-busy"
      role="status"
      aria-live="polite"
      data-on={shown ? '1' : '0'}
    >
      <span className="fpx-busy-dot" aria-hidden="true" />
      <span className="fpx-busy-text">{busyText(shown, label)}</span>
    </div>
  );
}
