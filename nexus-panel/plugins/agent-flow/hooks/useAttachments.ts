import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AttachmentFile, emptyAttachments,
} from '../engine/attachmentStore';
import { attachmentPathOf, loadAttachments, commitAttachments } from '../engine/attachmentFile';
import { canExportToFile } from '../lib/tauri';

/**
 * 附属文件清单的持有者。
 *
 * 结构与其它清单 hook 同构（同样的 base / 同步副本 / 串行写队列），
 * 理由也完全一样：写前要三方合并，而合并需要 base。
 * 两份 hook 刻意保持同样的形状 —— AI 改这两个文件时，
 * 学会一个就懂另一个，不会在两处遇到不同的规则。
 */

export type AttachState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  | { kind: 'overwritten'; ids: string[] };

export function useAttachments(opts: {
  dir: string;
  project: string;
  projectName: string;
  enabled: boolean;
}) {
  const { dir, project, projectName, enabled } = opts;

  const path = useMemo(
    () => (dir ? attachmentPathOf(dir, project, projectName) : ''),
    [dir, project, projectName],
  );

  const [file, setFile] = useState<AttachmentFile>(() => emptyAttachments(project, projectName));
  const [state, setState] = useState<AttachState>({ kind: 'idle' });

  /** 当前值的同步副本 —— 写盘要用"改完的那一刻"的值，不能等 React 重渲染 */
  const fileRef = useRef<AttachmentFile>(file);
  /** 上次读到的内容。三方合并靠它分清"我改了"和"别人改了" */
  const baseRef = useRef<AttachmentFile>(emptyAttachments(project, projectName));
  const setBoth = useCallback((f: AttachmentFile) => {
    fileRef.current = f;
    setFile(f);
  }, []);

  /** 串行写：两次写交错会让 base 停在中间态，后一次合并拿错基准 */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const canWrite = enabled && !!dir && canExportToFile();

  useEffect(() => {
    if (!canWrite || !path) return;
    let alive = true;
    setState({ kind: 'loading' });
    void loadAttachments(path, project, projectName)
      .then((f) => {
        if (!alive) return;
        baseRef.current = f;
        setBoth(f);
        setState({ kind: 'idle' });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const f = emptyAttachments(project, projectName);
        baseRef.current = f;
        setBoth(f);
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => { alive = false; };
  }, [path, project, projectName, canWrite, setBoth]);

  const apply = useCallback((next: (f: AttachmentFile) => AttachmentFile) => {
    if (!canWrite || !path) return;
    // 失败时要退回这个值：不退回的话界面停在"没落盘的值"上 ——
    // 报错归报错，列表里那条新附件照样在，看着像"报了错但其实加上了"。
    const prev = fileRef.current;
    const target = next(fileRef.current);
    setBoth(target);
    const run = queueRef.current.then(async () => {
      setState({ kind: 'saving' });
      try {
        const out = await commitAttachments(path, baseRef.current, target);
        baseRef.current = out.file;
        setBoth(out.file);
        setState(out.overwritten.length > 0
          ? { kind: 'overwritten', ids: out.overwritten }
          : { kind: 'saved', at: Date.now() });
      } catch (e: unknown) {
        setBoth(prev);
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    });
    queueRef.current = run.catch(() => undefined);
  }, [canWrite, path, setBoth]);

  const reload = useCallback(() => {
    if (!canWrite || !path) return;
    setState({ kind: 'loading' });
    void loadAttachments(path, project, projectName)
      .then((f) => {
        baseRef.current = f;
        setBoth(f);
        setState({ kind: 'idle' });
      })
      .catch((e: unknown) => {
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
  }, [canWrite, path, project, projectName, setBoth]);

  return { path, file, state, canWrite, apply, reload };
}
