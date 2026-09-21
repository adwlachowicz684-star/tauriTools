import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api } from '../api';
import type { DirEntryLite } from '../types';
import { Modal } from './ui';

/**
 * 内嵌目录选择器：不依赖系统文件对话框（Tauri 未装 dialog 插件时也能用），
 * 支持面包屑回退、快速起点、手工粘贴路径。
 */
export function DirDialog({
  api, title = '选择文件夹', onClose, onPick, allowCreate, hint,
}: {
  api: Api;
  title?: string;
  onClose: () => void;
  onPick: (path: string) => void;
  allowCreate?: boolean;
  /**
   * #14 顶部提示。拖进来的文件夹**拿不到绝对路径**，
   * 所以要把"为什么还要再选一次"说清楚 ——
   * 不说的话用户会以为刚才那一下拖失败了，或者以为这个软件很笨。
   */
  hint?: string;
}) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<DirEntryLite[]>([]);
  const [roots, setRoots] = useState<DirEntryLite[]>([]);
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setErr('');
    try {
      const list = await api.listDirs(p);
      // path 为空时后端返回的是盘符 / 根目录列表，同样是可选条目，不能丢弃
      // （否则点面包屑 ⌂ 只能看到「请选择一个起点」，实际拿得到数据却不用）
      setEntries(list);
      setPath(p);
      setInput(p);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    api.quickRoots().then((r) => {
      setRoots(r);
      if (r[0]) load(r[0].path);
    }).catch(() => {});
  }, [api, load]);

  const crumbs = useMemo(() => {
    if (!path) return [];
    // 分隔符要跟着原路径走：Unix 用 /，Windows 用 \。
    // 统一写死 \ 会让 /home/user 这类路径的面包屑拼成 /home\user，点回退直接失败。
    const sep = path.includes('\\') && !path.startsWith('/') ? '\\' : '/';
    const parts = path.split(/[\\/]/).filter(Boolean);
    const out: { label: string; path: string }[] = [];
    // 拼接时不要重复分隔符：首段在 Windows 上会被补成 "C:\"（带尾部分隔符），
    // 若下一段再无脑拼 sep，就会得到 "C:\\Users" 这种双分隔符路径。
    const joinSeg = (a: string, b: string) =>
      (a.endsWith('\\') || a.endsWith('/')) ? a + b : `${a}${sep}${b}`;
    let cur = '';
    for (const part of parts) {
      if (!cur) {
        cur = path.startsWith('/') ? `/${part}` : part;
        // Windows 盘符：C: 单独不是根目录，必须补成 C:\
        if (/^[A-Za-z]:$/.test(cur)) cur = `${cur}\\`;
      } else {
        cur = joinSeg(cur, part);
      }
      out.push({ label: part, path: cur });
    }
    return out;
  }, [path]);

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="p-btn" onClick={() => load(path)}>刷新</button>
          <button
            className="p-btn primary"
            disabled={!path}
            onClick={() => { onPick(path); onClose(); }}
          >
            选择此文件夹
          </button>
        </>
      }
    >
      {hint && (
        <div className="fpx-dirhint">
          {hint}
        </div>
      )}
      <div className="p-row" style={{ marginBottom: 'var(--sp-5, 10px)' }}>
        {roots.map((r) => (
          <button key={r.path} className="p-btn" onClick={() => load(r.path)}>{r.name}</button>
        ))}
      </div>

      <div className="p-row" style={{ marginBottom: 'var(--sp-5, 10px)' }}>
        <input
          className="p-input"
          value={input}
          placeholder="粘贴完整路径后回车"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(input.trim()); }}
        />
        <button className="p-btn" onClick={() => load(input.trim())}>前往</button>
      </div>

      <div className="fpx-crumbs">
        <button className="fpx-crumb" onClick={() => load('')}>⌂</button>
        {crumbs.map((c, i) => (
          <span key={`${c.path}-${i}`}>
            <span className="fpx-crumb-sep">›</span>
            <button className="fpx-crumb" onClick={() => load(c.path)}>{c.label}</button>
          </span>
        ))}
      </div>

      {err && <div className="p-muted" style={{ color: 'var(--danger)' }}>{err}</div>}

      <div className="fpx-dirlist">
        {loading && <div className="p-muted">加载中…</div>}
        {!loading && !path && entries.length === 0 && (
          <div className="p-muted">请从上方选择一个起点</div>
        )}
        {!loading && path && entries.length === 0 && (
          <div className="p-muted">（该目录下没有子文件夹）</div>
        )}
        {entries.map((e) => (
          <div key={e.path} className="fpx-dirrow">
            <button
              className="fpx-dirname"
              onClick={() => load(e.path)}
              onDoubleClick={() => { onPick(e.path); onClose(); }}
            >
              📁 {e.name}
            </button>
            <button className="p-btn" onClick={() => { onPick(e.path); onClose(); }}>选它</button>
          </div>
        ))}
      </div>

      {allowCreate && (
        <div className="p-row" style={{ marginTop: 'var(--sp-6, 12px)' }}>
          <input
            className="p-input"
            value={newName}
            placeholder="在此目录下新建子文件夹"
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            className="p-btn"
            disabled={!newName.trim() || !path}
            onClick={async () => {
              try {
                const p = await api.createFolder(path, newName.trim());
                setNewName('');
                await load(p);
              } catch (e: any) {
                setErr(e?.message ?? String(e));
              }
            }}
          >
            新建并进入
          </button>
        </div>
      )}
    </Modal>
  );
}
