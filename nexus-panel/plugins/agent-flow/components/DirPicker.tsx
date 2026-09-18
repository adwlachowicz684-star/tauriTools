import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listDirs, listQuickRoots, type DirEntryLite } from '../lib/tauri';

/**
 * 应用内目录选择器。
 *
 * ================= 为什么不用系统文件对话框 =================
 *
 * 原生对话框要引 tauri-plugin-dialog（改 Cargo.toml、重新编译、过打包），
 * 而这项目里 fpx 模块**已经有**目录浏览能力（fpx_quick_roots / fpx_list_dirs）。
 * 为"选个目录"去动 Rust 依赖，代价与收益不成比例。
 *
 * 而且应用内选择器还有个好处：能把"当前选中的是哪个目录"显示清楚，
 * 系统对话框关掉之后用户就不知道自己选了什么。
 */

type Props = {
  /** 初始目录（通常来自设置） */
  initial?: string;
  title?: string;
  onPick: (dir: string) => void;
  onCancel: () => void;
  /** 同时设为默认目录 */
  onPickAsDefault?: (dir: string) => void;
};

export default function DirPicker({
  initial = '', title = '选择导出目录', onPick, onCancel, onPickAsDefault,
}: Props) {
  const [cwd, setCwd] = useState(initial);
  const [entries, setEntries] = useState<DirEntryLite[]>([]);
  const [roots, setRoots] = useState<DirEntryLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    void listQuickRoots()
      .then((r) => { if (alive.current) setRoots(r); })
      .catch(() => { /* 起点列不出来不影响手动输入 */ });
  }, []);

  const load = useCallback(async (p: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await listDirs(p);
      if (!alive.current) return;
      setEntries(r);
      setCwd(p);
    } catch (e) {
      if (!alive.current) return;
      /*
       * 列不出来**必须**说清楚 ——
       * 最常见的原因是目录不在授权根里（fs_op 的安全收敛），
       * 静默显示空列表会让用户以为"这个文件夹是空的"。
       */
      setErr(`打不开这个目录：${String((e as Error)?.message ?? e)}`);
      setEntries([]);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initial) void load(initial);
    else if (roots.length > 0) void load(roots[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, roots.length]);

  const up = useMemo(() => {
    const s = String(cwd ?? '').replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : null;
  }, [cwd]);

  return (
    <div className="dirpicker-mask" onClick={onCancel}>
      <div className="dirpicker" onClick={(e) => e.stopPropagation()}>
        <div className="dirpicker-head">
          <strong>{title}</strong>
          <button className="mini" onClick={onCancel}>取消</button>
        </div>

        <div className="dirpicker-path">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void load(cwd); }}
            placeholder="也可以直接粘贴路径后回车"
          />
          <button className="mini" onClick={() => void load(cwd)} disabled={busy}>
            {busy ? '…' : '打开'}
          </button>
        </div>

        {err ? <div className="dirpicker-err">⚠ {err}</div> : null}

        {roots.length > 0 ? (
          <div className="dirpicker-roots">
            {roots.map((r) => (
              <button
                key={r.path}
                className={`chip${r.path === cwd ? ' on' : ''}`}
                onClick={() => void load(r.path)}
              >
                {r.name}
              </button>
            ))}
          </div>
        ) : null}

        <div className="dirpicker-list">
          {up ? (
            <button className="dirpicker-item up" onClick={() => void load(up)}>
              ↩ 上一级
            </button>
          ) : null}
          {entries.length === 0 && !busy && !err ? (
            <div className="dirpicker-empty">这个目录下没有子目录</div>
          ) : null}
          {entries.map((d) => (
            <button
              key={d.path}
              className="dirpicker-item"
              onClick={() => void load(d.path)}
              onDoubleClick={() => onPick(d.path)}
            >
              📁 {d.name}
              {d.has_child ? <small>▸</small> : null}
            </button>
          ))}
        </div>

        <div className="dirpicker-foot">
          <span className="dirpicker-cur">当前：{cwd || '（未选）'}</span>
          <span className="dirpicker-ops">
            {onPickAsDefault ? (
              <button
                className="mini"
                disabled={!cwd}
                onClick={() => { onPickAsDefault(cwd); onPick(cwd); }}
              >
                设为默认
              </button>
            ) : null}
            <button className="mini primary" disabled={!cwd} onClick={() => onPick(cwd)}>
              选这里
            </button>
          </span>
        </div>
        <p className="dirpicker-hint">
          双击文件夹可直接选中。目录若不在授权范围内会打不开 —— 那时点「设为默认」会自动申请授权。
        </p>
      </div>
    </div>
  );
}
