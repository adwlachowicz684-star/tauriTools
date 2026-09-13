import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api } from '../api';
import type { DirEntryLite } from '../types';
import { Modal } from './ui';

/**
 * 内嵌目录选择器：不依赖系统文件对话框（Tauri 未装 dialog 插件时也能用），
 * 支持面包屑回退、快速起点、手工粘贴路径。
 */
export function DirDialog({
  api, title = '选择文件夹', onClose, onPick, allowCreate,
}: {
  api: Api;
  title?: string;
  onClose: () => void;
  onPick: (path: string) => void;
  allowCreate?: boolean;
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
    let cur = '';
    for (const part of parts) {
      if (!cur) {
        cur = path.startsWith('/') ? `/${part}` : `${part}${sep}`;
      } else {
        cur = `${cur}${sep}${part}`;
      }
      out.push({ label: part, path: cur });
    }
    // Windows 盘符路径补全：C: → C:\
    if (/^[A-Za-z]:$/.test(parts[0] ?? '')) out[0].path = `${parts[0]}\\`;
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
      <div className="p-row" style={{ marginBottom: 10 }}>
        {roots.map((r) => (
          <button key={r.path} className="p-btn" onClick={() => load(r.path)}>{r.name}</button>
        ))}
      </div>

      <div className="p-row" style={{ marginBottom: 10 }}>
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
        <div className="p-row" style={{ marginTop: 12 }}>
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
