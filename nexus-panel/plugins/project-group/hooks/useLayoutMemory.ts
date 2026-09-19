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

  const onColResizeEnd = useCallback(() => {
    setColStars((cur) => {
      saveLayout({ colStars: cur });
      dragBase.current = { ...dragBase.current, stars: cur };
      return cur;
    });
  }, [saveLayout]);

  const onLogResize = useCallback((delta: number) => {
    setLogHeight(clampLogHeight(dragBase.current.height + delta));
  }, []);

  const onLogResizeEnd = useCallback(() => {
    setLogHeight((cur) => {
      saveLayout({ logRowHeight: cur });
      dragBase.current = { ...dragBase.current, height: cur };
      return cur;
    });
  }, [saveLayout]);

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
