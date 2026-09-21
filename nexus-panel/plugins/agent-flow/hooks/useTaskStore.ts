import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseHistory, serializeHistory, HISTORY_STORE_KEY,
  type HistoryEntry, planHistoryRetry,
} from '../engine/history';
import type { TaskRecord } from '../engine/tasks';

/**
 * 任务列表 + 跨会话历史归档。
 *
 * ================= 为什么抽出来 ====================
 *
 * App.tsx 往下拆的第三块。这两样都不碰画布与执行：
 * 任务只进事件、历史只进 localStorage。
 *
 * ================= 为什么放在一起 ====================
 *
 * 历史是"跑完归档"，任务窗口是"正在跑" —— 同一个生命周期的两段，
 * 且详情面板要按同一套选中规则取当前那条。分开放反而要来回传 id。
 *
 * ================= 不抽走的东西 ====================
 *
 * applyEvent 仍由执行层调用（onEvent 里）——
 * 事件怎么变成任务状态是执行的事，不是存储的事。
 */
export function useTaskStore() {
    const [taskSel, setTaskSel] = useState<string | null>(null);
    const [histSel, setHistSel] = useState<string | null>(null);

    /* ---------------- 历史（跨会话归档）---------------- */
    const [historyFile, setHistoryFile] = useState(() => parseHistory(localStorage.getItem(HISTORY_STORE_KEY)));
    const history: HistoryEntry[] = historyFile.entries;

    /*
      写盘可能触发 QuotaExceededError（localStorage 通常只有 5MB）。
      失败时不能静默吞掉 —— 否则用户以为归档了，下次打开却是空的。
      这里裁掉一半最旧的再试一次；仍失败就提示，让人知道要清理。
    */
    const [histWarn, setHistWarn] = useState('');
    const saveHistory = useCallback((file: { v: number; entries: HistoryEntry[] }) => {
      setHistoryFile(file);
      for (const attempt of [0, 1]) {
        try {
          localStorage.setItem(HISTORY_STORE_KEY, serializeHistory(file));
          if (attempt > 0) setHistWarn('存储空间紧张，已自动清理较旧的记录。');
          else setHistWarn('');
          return;
        } catch {
          // 装不下就丢掉最旧的一半再试
          const retry = planHistoryRetry(file);
          if (!retry) break;
          file = retry;
          setHistoryFile(file);
        }
      }
      setHistWarn('存储空间不足，归档未能全部保存。建议清空部分历史。');
    }, []);
    const [tasks, setTasks] = useState<TaskRecord[]>([]);
    /** 当前正在跑的任务 id。用 ref 避免 onEvent 因依赖变化而重建 */
    const currentTaskRef = useRef<string | null>(null);
    /*
      让任务耗时与进度实时刷新。
      两个约束：
        1. 只在真的有任务在跑时才走 —— 全部空闲时每秒重渲染整个列表是白烧 CPU
        2. 依赖用布尔值而非 tasks 数组 —— 否则每来一个运行事件都会重建定时器
      已完成的任务显示固定耗时，不需要跟着刷新。
    */
    const [tick, setTick] = useState(() => Date.now());
    const hasRunning = useMemo(
      () => tasks.some((t) => t.status === 'running'),
      [tasks],
    );
    useEffect(() => {
      if (!hasRunning) return;
      const h = window.setInterval(() => setTick(Date.now()), 1000);
      return () => window.clearInterval(h);
    }, [hasRunning]);

    /*
     * 列表顶替节点库后，详情要能自己挑一条 ——
     * 没选过就取第一条，否则右侧一进来是空的，得先点一下才有东西看。
     */
    const activeTask = tasks.find((t) => t.id === taskSel) || tasks[0] || null;
    const activeHist = history.find((e) => e.id === histSel) || history[0] || null;

    // run 里要读最新的历史文件，但把 history 放进依赖会让 run 频繁重建
    const historyRef = useRef(historyFile);
    useEffect(() => { historyRef.current = historyFile; }, [historyFile]);

  return {
    // 任务
    tasks, setTasks, currentTaskRef, tick,
    // 历史
    history, historyFile, histWarn, saveHistory, historyRef,
    // 选中（列表在左栏、详情在中间，必须同源）
    taskSel, setTaskSel, histSel, setHistSel, activeTask, activeHist,
  };
}
