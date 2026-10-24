import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type BoardMeta, emptyMeta } from '../engine/boardMeta';
import { metaPathOf, loadMeta, commitMeta } from '../engine/boardMetaFile';
import { canExportToFile } from '../lib/tauri';

/**
 * 项目元数据（自定义状态 + 标签）的持有者。
 *
 * 与 useTaskBoard / useAttachments 同构：base / 同步副本 / 串行写队列。
 * 三份 hook 刻意保持同样形状 —— 读这份代码的人（包括 AI）
 * 学会一个就懂另外两个，不会在三处遇到不同的规则。
 */

export type MetaState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  | { kind: 'overwritten' };

export function useBoardMeta(opts: {
  dir: string;
  project: string;
  projectName: string;
  enabled: boolean;
}) {
  const { dir, project, projectName, enabled } = opts;

  const path = useMemo(
    () => (dir ? metaPathOf(dir, project, projectName) : ''),
    [dir, project, projectName],
  );

  const [meta, setMeta] = useState<BoardMeta>(() => emptyMeta(project, projectName));
  const [state, setState] = useState<MetaState>({ kind: 'idle' });

  const metaRef = useRef<BoardMeta>(meta);
  const baseRef = useRef<BoardMeta>(emptyMeta(project, projectName));
  const setBoth = useCallback((m: BoardMeta) => {
    metaRef.current = m;
    setMeta(m);
  }, []);

  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const canWrite = enabled && !!dir && canExportToFile();

  useEffect(() => {
    if (!canWrite || !path) return;
    let alive = true;
    setState({ kind: 'loading' });
    void loadMeta(path, project, projectName)
      .then((m) => {
        if (!alive) return;
        baseRef.current = m;
        setBoth(m);
        setState({ kind: 'idle' });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const m = emptyMeta(project, projectName);
        baseRef.current = m;
        setBoth(m);
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => { alive = false; };
  }, [path, project, projectName, canWrite, setBoth]);

  const apply = useCallback((next: (m: BoardMeta) => BoardMeta) => {
    if (!canWrite || !path) return;
    const target = next(metaRef.current);
    setBoth(target);
    const run = queueRef.current.then(async () => {
      setState({ kind: 'saving' });
      try {
        const out = await commitMeta(path, baseRef.current, target);
        baseRef.current = out.meta;
        setBoth(out.meta);
        setState(out.overwritten
          ? { kind: 'overwritten' }
          : { kind: 'saved', at: Date.now() });
      } catch (e: unknown) {
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    });
    queueRef.current = run.catch(() => undefined);
  }, [canWrite, path, setBoth]);

  return { path, meta, state, canWrite, apply };
}
