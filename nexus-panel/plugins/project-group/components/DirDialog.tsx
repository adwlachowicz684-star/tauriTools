import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNexus } from '../../../src/nexus-react';
import type { Api } from '../api';
import type { DirEntryLite } from '../types';
import { Modal } from './ui';
import { isComposing } from '../utils/ime';

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
  /** 目录加载代号，见下方 load 的说明：连续点目录时用它丢弃过期响应 */
  const loadSeq = useRef(0);

  const load = useCallback(async (p: string) => {
    /*
     * 本次加载的代号，回来时对不上就丢弃。
     *
     * 没有它的话，先点一个慢的目录（网络盘、大目录）、再点一个快的，会出现：
     * 慢的那次回来时把 entries 和 path 一起改回去 ——
     * 用户明明点了 B，界面却跳到 A 的内容，地址栏也变成 A。
     * 没有报错，他会以为自己点错了，于是再点一次 B（又跳一次）。
     *
     * 同理，loading 也只能由**最后一次**收尾：
     * 两次在飞时先回来的那次会提前把 loading 清掉，
     * 界面于是在"还在读"时显示就绪。
     */
    const seq = ++loadSeq.current;
    setLoading(true);
    setErr('');
    try {
      const list = await api.listDirs(p);
      if (loadSeq.current !== seq) return;
      // path 为空时后端返回的是盘符 / 根目录列表，同样是可选条目，不能丢弃
      // （否则点面包屑 ⌂ 只能看到「请选择一个起点」，实际拿得到数据却不用）
      setEntries(list);
      setPath(p);
      setInput(p);
    } catch (e: any) {
      if (loadSeq.current !== seq) return;
      setErr(e?.message ?? String(e));
    } finally {
      if (loadSeq.current === seq) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    /*
     * 取不到快速起点时**不能静默**：失败后 roots 为空、load 从没被调用，
     * 整个弹窗就是一片空白 —— 用户看到的是"这个软件打不开目录"，
     * 而真相只是"起点列表拉不到"，他完全无从判断。
     *
     * 所以把错误写进 err（弹窗里本来就有这条红字），而不是吞掉。
     */
    api.quickRoots().then((r) => {
      setRoots(r);
      if (r[0]) load(r[0].path);
    }).catch((e: unknown) => {
      setRoots([]);
      setErr(`无法列出快速起点：${e instanceof Error ? e.message : String(e)}`);
    });
  }, [api, load]);

  /*
   * 委托给全工具统一的 folder-picker 服务。
   * ------------------------------------------------------------
   * 为什么委托而不继续用下面这套界面：
   * 项目组与 agent-flow 各有一套选目录 UI 时，"常用文件夹"得存两份、
   * 收藏逻辑写两遍；只要某处漏掉归一化（去尾部斜杠），同一个目录就被判成
   * 两条收藏 —— 界面上两个一模一样的条目，删掉一个另一个还在，且不报错。
   *
   * 为什么还要留着下面这套（降级）：
   * 服务条目一旦被同步覆盖掉，没有兜底就是**所有**选目录入口同时失灵。
   * 本项目已经反复出现"整块被同步抹掉"的事故，所以这里宁可多留一份。
   *
   * fallback 的含义（三态，刻意用 null 表示"还在委托中"）：
   *   null            → 尚未判定，此时**不能**渲染自己的界面，
   *                     否则两套界面会同时出现（浮层在上、这个在下）
   *   非空字符串      → 委托失败，退回内置界面，并把原因显示出来
   */
  const [fallback, setFallback] = useState<string | null>(null);
  const delegated = useRef(false);
  const ctx = useNexus();

  useEffect(() => {
    // StrictMode 下 effect 会跑两次；不挡住就会连开两个选择器，
    // 后一个把前一个的 session 顶掉，用户看到的是"闪一下就没了"。
    if (delegated.current) return;
    delegated.current = true;
    void (async () => {
      try {
        const ok = await ctx.services.available('folder-picker');
        if (!ok) throw new Error('未找到 folder-picker 服务');
        const r: any = await ctx.services.call('folder-picker', 'pick', {
          title, startPath: '', allowCreate: !!allowCreate, hint: hint || '',
        });
        // 取消（path 为空）也是正常结束：不能因为用户取消了就弹回内置界面
        if (r?.path) { onPick(String(r.path)); onClose(); return; }
        onClose();
      } catch (e: any) {
        setFallback(String(e?.message ?? e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 还在委托中：一个节点都不渲染
  if (fallback === null) return null;

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
      {/*
        降级**必须**把原因说出来：用户刚点过「浏览」，弹出来的却是另一套
        旧界面，不说原因就只会以为是"软件抽风了"。
      */}
      {fallback ? (
        <div className="fpx-dirhint">
          统一选择器不可用（{fallback}），已退回内置界面。
        </div>
      ) : null}
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
          onKeyDown={(e) => { if (isComposing(e.nativeEvent)) return; if (e.key === 'Enter') load(input.trim()); }}
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
