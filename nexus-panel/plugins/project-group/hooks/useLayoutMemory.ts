import { useCallback, useEffect, useRef, useState } from 'react';
import { errText } from '../api';
import { clampLogHeight, clampPanelHeight, normalizeColStars, resizeColStars } from '../utils/layout';
import type { FpxStore } from './useFpx';
import type { FpxConfig } from '../types';

/**
 * 布局记忆（#54 三栏宽度 / #55 日志高度 / #56 浮层高度 / #193）。
 *
 * 三块都是"拖动 → 松手 → 写 config"，原本散在 App 里且**被别的逻辑隔开**
 * （tipsHeight 在 App 中间、与三栏相距 70 行），改一处容易漏看另一处。
 * 收进同一个钩子后，"布局有三种尺寸要记"这件事才看得出来。
 *
 * 关键设计：**拖动中只改本地 state，松手才写 config**。
 * 布局是连续变化的高频操作，拖一格写一次会反复重写整份配置
 * （还要过跨进程文件锁），拖动本身也会卡。
 * 原版用 ScheduleLayoutSave 防抖；这里更进一步，只在松手时落一次。
 */

export interface UseLayoutMemoryArgs {
  s: FpxStore;
  /** 当前配置（可能为 null：首屏还没加载完） */
  config: FpxConfig | null | undefined;
}

export function useLayoutMemory({ s, config }: UseLayoutMemoryArgs) {

  const [colStars, setColStars] = useState<number[]>(() =>
    normalizeColStars(config?.colStars));
  const [logHeight, setLogHeight] = useState<number>(() =>
    clampLogHeight(config?.logRowHeight));

  // 拖动起点快照：onDelta 给的是"相对起点的总位移"，
  // 每次都基于起点重算，避免逐帧累加的舍入漂移。
  const dragBase = useRef<{ stars: number[]; height: number }>({ stars: colStars, height: logHeight });
  const colsRef = useRef<HTMLDivElement>(null);

  /** 松手：把当前布局写回 config */
  const saveLayout = useCallback((patch: Partial<FpxConfig>) => {
    void s.updateConfig((d) => { Object.assign(d, patch); })
      .catch((e) => s.pushLog(`布局保存失败：${errText(e)}`, true));
  }, [s]);

  const onColResize = useCallback((i: number) => (delta: number) => {
    const total = colsRef.current?.getBoundingClientRect().width ?? 0;
    if (total <= 0) return;
    setColStars(resizeColStars(dragBase.current.stars, i, delta, total));
  }, []);

  /*
   * 松手时把当前布局写回 config。
   *
   * **副作用不能写进 `setXxx((cur) => ...)` 的 updater 里** ——
   * updater 必须是纯函数，React 有权重放它（StrictMode 下就一定会跑两次），
   * 于是 `saveLayout` 会被执行两次：两次跨进程文件锁、两次日志，
   * 而用户只拖了一次。将来若保存动作不再幂等（比如带计数），后果更直接。
   *
   * 这里直接读闭包里的当前值：拖动过程中 `onColResize` 每次都 setColStars，
   * 必然已重渲染过，回调拿到的就是最新值。
   */
  const onColResizeEnd = useCallback(() => {
    saveLayout({ colStars });
    dragBase.current = { ...dragBase.current, stars: colStars };
  }, [saveLayout, colStars]);

  const onLogResize = useCallback((delta: number) => {
    setLogHeight(clampLogHeight(dragBase.current.height + delta));
  }, []);

  /*
   * ⚠️ 配置字段叫 logRowHeight，本地 state 叫 logHeight —— 两个名字不同，
   * 这里必须显式写成 `logRowHeight: logHeight`。
   *
   * 曾两次被写成裸的 `saveLayout({ logRowHeight })`：本作用域根本没有
   * 这个变量，ESM 是严格模式，**拖完日志分隔条松手那一下就是 ReferenceError**，
   * 布局永远存不进去。一直没暴露是因为不拖分隔条就走不到这条路径。
   *
   * （本修复曾被上游整文件改动覆盖回来过一次，故在此写明判据，
   *   以免再被"看着像是字段名简写"而改回去。）
   */
  const onLogResizeEnd = useCallback(() => {
    saveLayout({ logRowHeight: logHeight });
    dragBase.current = { ...dragBase.current, height: logHeight };
  }, [saveLayout, logHeight]);

  /** 配置被外部改了（MCP 侧 / 设置页保存）→ 同步回来 */
  useEffect(() => {
    const next = normalizeColStars(config?.colStars);
    setColStars(next);
    dragBase.current = { ...dragBase.current, stars: next };
  }, [config?.colStars]);

  useEffect(() => {
    const next = clampLogHeight(config?.logRowHeight);
    setLogHeight(next);
    dragBase.current = { ...dragBase.current, height: next };
  }, [config?.logRowHeight]);

  /* 使用说明浮层高度（#56 tipsPanelHeight）。
     只有它真正生效 —— 清单 #438 的 settingsPanelHeight / mcpPanelHeight
     在本架构下无对应物：设置与 MCP 是外壳以**页面**形式提供的（Settings.tsx
     跑在外壳的设置 iframe 里），不是固定高度的浮层，高度记忆无从谈起。
     两个字段在类型与后端保留（与清单一致），但只有 tips 会用。
     首次打开时是 null（自适应）；拖过一次之后才有值，之后一直按记忆的高度开。 */
  const [tipsHeight, setTipsHeight] = useState<number | null>(
    () => clampPanelHeight(config?.tipsPanelHeight),
  );
  useEffect(() => {
    setTipsHeight(clampPanelHeight(config?.tipsPanelHeight));
  }, [config?.tipsPanelHeight]);
    return {
      colStars, logHeight, tipsHeight,
      colsRef, saveLayout,
      onColResize, onColResizeEnd,
      onLogResize, onLogResizeEnd,
    };
}
