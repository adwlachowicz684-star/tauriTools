import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TaskBoard, emptyBoard, defaultExpanded } from '../engine/taskBoard';
import { boardPathOf, loadBoard, commitBoard } from '../engine/taskBoardFile';
import { canExportToFile } from '../lib/tauri';

/**
 * 任务板的持有者：文件路径、当前内容、base、保存状态。
 *
 * ================= base 为什么必须留着 =================
 *
 * base = 上次读到的文件内容。三方合并要靠它才能分清
 * 「我改了」和「别人改了」—— 两者都表现为"当前内容 ≠ 磁盘内容"。
 *
 * 不留 base 就只能二选一：整份覆盖（吞掉 AI 刚写的），
 * 或整份放弃（吞掉自己刚做的操作）。两种都不可接受。
 *
 * ================= 为什么每次改动立刻写盘 =================
 *
 * AI 是**读文件**的，界面只是它的一个视图。
 * 攒着不写的话，界面显示"已领取"而文件里还是"待办" ——
 * AI 读到的就是假的。所以改一条写一条，不做防抖。
 *
 * 代价是打字类操作（改标题）会频繁写盘，所以那类操作由组件
 * 在**失焦 / 回车**时才提交，不是每个按键一次。
 */

export type BoardSaveState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  /** 写盘时发现有节点被文件里的新版本盖掉 */
  | { kind: 'overwritten'; ids: string[] };

export function useTaskBoard(opts: {
  dir: string;
  project: string;
  projectName: string;
  /** 没用到任务视图时先不读盘；没有导出目录则始终不启用 */
  enabled: boolean;
}) {
  const { dir, project, projectName, enabled } = opts;

  const path = useMemo(
    () => (dir ? boardPathOf(dir, project, projectName) : ''),
    [dir, project, projectName],
  );

  const [board, setBoard] = useState<TaskBoard>(() => emptyBoard(project, projectName));
  const [state, setState] = useState<BoardSaveState>({ kind: 'idle' });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  /*
    当前板的**同步副本**。

    不能用 setBoard 的更新函数去拿"下一个值"：React 在批处理下会延迟调用它，
    于是紧接着要拿去写盘的 mine 还是旧值；而退回对 base 计算更糟 ——
    那会把改动应用在上一次的内容上，等于把中间几次操作全丢了。
    所以显式维护一份 ref，改一次同步一次。
  */
  const boardRef = useRef<TaskBoard>(board);
  const baseRef = useRef<TaskBoard>(emptyBoard(project, projectName));
  const setBoardBoth = useCallback((b: TaskBoard) => {
    boardRef.current = b;
    setBoard(b);
  }, []);

  /*
    连续保存串行执行：两次 save 交错会让 base 停在中间态，
    后一次合并就拿错了基准（表现为"我的改动被盖掉"）。
  */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const canWrite = enabled && !!dir && canExportToFile();

  /* ---------- 载入 ---------- */
  useEffect(() => {
    if (!canWrite || !path) return;
    let alive = true;
    setState({ kind: 'loading' });
    void loadBoard(path, project, projectName)
      .then((b) => {
        if (!alive) return;
        baseRef.current = b;
        setBoardBoth(b);
        setExpanded(defaultExpanded(b));
        setState({ kind: 'idle' });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const b = emptyBoard(project, projectName);
        baseRef.current = b;
        setBoardBoth(b);
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => { alive = false; };
  }, [path, project, projectName, canWrite, setBoardBoth]);

  /* ---------- 改并落地 ---------- */
  /**
   * 应用一个纯操作，然后立刻写盘。
   *
   * next 是**纯函数**（engine 里的那些都返回新板），
   * 这样"改了什么"是可回放的，副作用只集中在这一处。
   */
  const apply = useCallback((next: (b: TaskBoard) => TaskBoard) => {
    if (!canWrite || !path) return;
    // 从同步副本算：写盘与界面用的是同一个值，不会差一次操作
    const target = next(boardRef.current);
    setBoardBoth(target);
    const run = queueRef.current.then(async () => {
      setState({ kind: 'saving' });
      try {
        const out = await commitBoard(path, baseRef.current, target);
        baseRef.current = out.board;
        setBoardBoth(out.board);
        setExpanded((prev) => {
          /*
            外部新加的组默认展开：不展开的话 AI 加进去的东西"看不见"，
            而它只是被折叠在一个组里 —— 那和没加上看不出区别。
          */
          if (out.added.length === 0) return prev;
          const s = new Set(prev);
          for (const id of out.added) if (out.board.nodes[id]?.kind === 'group') s.add(id);
          return s;
        });
        setState(out.overwritten.length > 0
          ? { kind: 'overwritten', ids: out.overwritten }
          : { kind: 'saved', at: Date.now() });
      } catch (e: unknown) {
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    });
    queueRef.current = run.catch(() => undefined);
  }, [canWrite, path, setBoardBoth]);

  /* ---------- 重新读一次文件 ---------- */
  const reload = useCallback(() => {
    if (!canWrite || !path) return;
    setState({ kind: 'loading' });
    void loadBoard(path, project, projectName)
      .then((b) => {
        baseRef.current = b;
        setBoardBoth(b);
        setExpanded(defaultExpanded(b));
        setState({ kind: 'idle' });
      })
      .catch((e: unknown) => {
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
  }, [canWrite, path, project, projectName, setBoardBoth]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }, []);

  return {
    path, board, state, expanded, canWrite,
    apply, reload, toggle, setExpanded,
  };
}
