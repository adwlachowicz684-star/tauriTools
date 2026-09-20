/**
 * 拖拽排序的 **React 层**（配套 js/drag-reorder.js）
 * ------------------------------------------------------------------
 * 为什么要和纯逻辑分开两个文件：
 *
 * 纯逻辑那一层必须 **零依赖**，才能被真正复用 —— 原生 JS 插件、
 * 纯逻辑测试、以及将来任何非 React 的宿主都能 import 它。
 * 若把 hook 写进同一个文件，文件顶部就得 import react，
 * 于是**连只想用 swapIndexWithDeadZone 的调用方也被迫装上 React**，
 * 纯逻辑测试跑不起来（实测：ERR_MODULE_NOT_FOUND: react）。
 *
 * 分层：
 *   js/drag-reorder.js        纯逻辑（阈值 / 死区 / 贴边速度 / 索引纠偏）— 零依赖
 *   js/drag-reorder-react.js  本文件：把这些判定接到 React 的拖拽事件上
 *
 * 数值与判定依据都写在纯逻辑那一层，这里只管接线。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  movedEnough, swapIndexWithDeadZone, edgeScrollSpeed,
  dragMime as mimeOf,
} from './drag-reorder.js';

/* ============================ React hook ============================ */

/**
 * 列表拖拽排序。
 *
 * 实时让位：拖过时其余项让开空位，指针越过邻项中心 + 死区即换位。
 *
 * @param {object}   opt
 * @param {number}   opt.count     列表长度
 * @param {Function} opt.onMove    (from, to) => void，换位时调用（**立即生效**）
 * @param {Function} [opt.onDrop]  落点完成 (from, to) => void，用于持久化/通知
 * @param {object}   [opt.containerRef] 可滚动容器；给了才启用贴边自动滚动
 * @param {'y'|'x'}  [opt.axis]    主轴，默认纵向
 * @param {string}   [opt.mimeKey] 专用 MIME 的 key，默认 'reorder'
 * @param {string}   [opt.itemSelector] 子项选择器，默认 '[data-drag-index]'
 * @param {boolean}  [opt.disabled]
 */
export function useDragReorder(opt) {
  const {
    count, onMove, onDrop, containerRef,
    axis = 'y', mimeKey = 'reorder',
    itemSelector = '[data-drag-index]',
    disabled = false,
  } = opt || {};

  const [dragFrom, setDragFrom] = useState(-1);
  const pressAt = useRef(null);
  const pointer = useRef(null);
  const raf = useRef(null);
  const startIndex = useRef(-1);

  const MIME = mimeOf(mimeKey);

  /** 停止自动滚动：拖拽结束 / 取消 / 卸载都要调，漏了容器会一直自己滚。 */
  const stopScroll = useCallback(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, []);

  /** 清掉一次拖拽的全部状态。 */
  const reset = useCallback(() => {
    stopScroll();
    pointer.current = null;
    pressAt.current = null;
    startIndex.current = -1;
    setDragFrom(-1);
  }, [stopScroll]);

  useEffect(() => () => stopScroll(), [stopScroll]);

  /**
   * 贴边自动滚动。
   *
   * 为什么必须自己起 rAF 循环，而不是在 `dragover` 里滚：
   * **`dragover` 只在指针移动时触发**。用户拖到底边后停住不动等它滚，
   * 恰恰是那时 `dragover` 不再来了 —— 滚动立刻停住，
   * 用户以为功能坏了而松手，前功尽弃。
   * 这正是「最需要它的时候它不动」，是这类功能最容易做错的一处。
   */
  useEffect(() => {
    if (dragFrom < 0 || !containerRef?.current) return;
    const el = containerRef.current;
    let alive = true;

    const step = () => {
      if (!alive) return;
      raf.current = requestAnimationFrame(step);
      const p = pointer.current;
      if (p == null) return;   // 指针还没进来；继续轮询，等重新贴边

      const r = el.getBoundingClientRect();
      const d = axis === 'x'
        ? edgeScrollSpeed(p, r.left, r.right)
        : edgeScrollSpeed(p, r.top, r.bottom);
      if (d === 0) return;

      /* 用 scrollTop/scrollLeft 直接加，而不是 scrollBy：
         scrollBy 带平滑滚动时会被连续调用打断，表现为「越滚越慢」。 */
      const prop = axis === 'x' ? 'scrollLeft' : 'scrollTop';
      const before = el[prop];
      el[prop] = before + d;
      if (el[prop] === before) return;   // 已到尽头，别白耗电
    };
    raf.current = requestAnimationFrame(step);

    return () => { alive = false; stopScroll(); };
  }, [dragFrom, containerRef, axis, stopScroll]);

  /** 测量子项中心与尺寸——每次 dragover 重新量，因为让位后布局已变。 */
  const measure = useCallback(() => {
    const host = containerRef?.current;
    if (!host) return { centers: [], sizes: [] };
    const nodes = host.querySelectorAll(itemSelector);
    const centers = [];
    const sizes = [];
    nodes.forEach((n) => {
      const r = n.getBoundingClientRect();
      if (axis === 'x') { centers.push(r.left + r.width / 2); sizes.push(r.width); }
      else { centers.push(r.top + r.height / 2); sizes.push(r.height); }
    });
    return { centers, sizes };
  }, [containerRef, itemSelector, axis]);

  /** 单次换位判定（dragover 与自动滚动跳帧共用）。 */
  const trySwap = useCallback((pos) => {
    if (dragFrom < 0) return;
    const { centers, sizes } = measure();
    if (!centers.length) return;
    const to = swapIndexWithDeadZone(pos, centers, sizes, dragFrom);
    if (to !== dragFrom) {
      onMove?.(dragFrom, to);
      setDragFrom(to);   // 被拖项已在新位置，后续判定以它为基准
    }
  }, [dragFrom, measure, onMove]);

  /** 容器级 dragover：记指针 + 贴边滚动 + 换位。 */
  const onDragOver = useCallback((e) => {
    if (dragFrom < 0 || disabled) return;
    // 只认自己的 MIME —— 别去抢浏览器对其它拖拽的默认处理
    if (!e.dataTransfer?.types?.includes?.(MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    pointer.current = axis === 'x' ? e.clientX : e.clientY;
    trySwap(pointer.current);
  }, [dragFrom, disabled, MIME, axis, trySwap]);

  /** 每一项的 props。 */
  const getItemProps = useCallback((index) => ({
    'data-drag-index': index,
    draggable: !disabled,
    className: dragFrom === index ? 'dragging' : undefined,
    onMouseDown: (e) => { pressAt.current = { x: e.clientX, y: e.clientY }; },
    onDragStart: (e) => {
      if (disabled) return;
      /*
       * 阈值判定：位移不够就取消这次拖拽。
       * 不取消的话，点击（含手抖）会被吞掉 —— 用户「点了没反应」。
       */
      if (!movedEnough(pressAt.current, e.clientX, e.clientY)) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData(MIME, JSON.stringify({ index }));
      e.dataTransfer.effectAllowed = 'move';
      startIndex.current = index;
      setDragFrom(index);
    },
    onDragEnd: () => {
      const from = startIndex.current;
      const to = dragFrom;
      if (from >= 0 && to >= 0 && from !== to) onDrop?.(from, to);
      reset();
    },
  }), [dragFrom, disabled, MIME, onDrop, reset]);

  return { dragFrom, getItemProps, onDragOver, reset };
}
