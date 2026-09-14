import { useCallback, useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';

/**
 * 文件访问授权
 * ------------------------------------------------------------
 * agent-flow 的「文件」节点经 Rust 的 fs_op 读写磁盘，而 fs_op 只接受
 * 落在授权根目录内的路径（canonicalize 后 starts_with），默认范围仅
 * 应用数据目录。没有这个界面，用户把工作流目录指到别处就会直接撞上
 * 「路径越权」却无从下手 —— 命令在，入口不在，等于没做完。
 *
 * 走 ctx.invoke 调 Rust 命令：module 与 iframe 两种挂载模式都可用
 * （沙箱里是经宿主桥接转发的，能力不因隔离而丢失）。
 * 因此这里不需要 ExternalCard 那套 bridge/direct 双通道适配。
 *
 * 只做文本输入：项目没引 tauri-plugin-dialog，为选个目录加一个插件
 * 不划算。失败时把 Rust 侧的报错原样显示 —— 它已经写清了原因
 * （不是目录 / 范围过大 / 系统目录），比另写一套提示更准。
 *
 * 与原生设置页（plugins/settings/index.js 的「文件」分栏）行为一致。
 */
export default function FilesCard() {
  const ctx = useNexus();
  const [roots, setRoots] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await ctx.invoke<string[]>('af_fs_list_roots');
      setRoots(list ?? []);
      setErr(null);
    } catch (e: any) {
      setRoots(null);
      setErr(String(e?.message ?? e));
    }
  }, [ctx]);

  useEffect(() => { refresh(); }, [refresh]);

  const add = async () => {
    const p = draft.trim();
    if (!p || busy) return;
    setBusy(true);
    try {
      await ctx.invoke<string[]>('af_fs_allow_root', { path: p });
      setDraft('');
      ctx.toast('已加入授权范围', 'ok');
    } catch (e: any) {
      ctx.toast(String(e?.message ?? e), 'err');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const remove = async (p: string) => {
    setBusy(true);
    try {
      await ctx.invoke<string[]>('af_fs_disallow_root', { path: p });
      ctx.toast('已撤销授权', 'ok');
    } catch (e: any) {
      ctx.toast(String(e?.message ?? e), 'err');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className="p-card">
      <h2>文件访问</h2>
      <div className="p-muted" style={{ marginBottom: 12, lineHeight: 1.9 }}>
        agent-flow 的文件节点只能读写这里列出的目录（含子目录）。
        <br />
        超出范围的操作会被拒绝 —— 这样插件就没法「读本地文件再发到网上」。
        <br />
        应用数据目录是默认范围，不能撤销。
      </div>

      {err ? (
        <div className="p-muted" style={{ padding: '12px 0' }}>读取授权目录失败：{err}</div>
      ) : roots === null ? (
        <div className="p-muted" style={{ padding: '12px 0' }}>载入中…</div>
      ) : !roots.length ? (
        <div className="p-muted" style={{ padding: '12px 0' }}>
          还没有授权任何目录，文件节点将无法读写。
        </div>
      ) : roots.map((r) => (
        <div
          key={r}
          className="p-row"
          style={{
            padding: '10px 12px', marginTop: 8, borderRadius: 'var(--r-sm)',
            background: 'var(--surface-sunk)',
            boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
          }}
        >
          <div
            className="p-mono"
            style={{ flex: 1, minWidth: 0, fontSize: 12, wordBreak: 'break-all' }}
          >
            {r}
          </div>
          <button
            className="p-btn"
            style={{ height: 26, padding: '0 9px', fontSize: 11 }}
            title="撤销授权（应用数据目录不可撤销）"
            disabled={busy}
            onClick={() => remove(r)}
          >
            ✕
          </button>
        </div>
      ))}

      <div className="p-row" style={{ marginTop: 12 }}>
        <input
          className="p-input"
          type="text"
          placeholder="粘贴要授权的目录完整路径，如 /Users/me/projects"
          style={{ flex: 1, height: 30, fontSize: 12, padding: '0 10px', minWidth: 0 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <button
          className="p-btn primary"
          style={{ height: 30, padding: '0 14px', fontSize: 12 }}
          disabled={busy}
          onClick={add}
        >
          添加目录
        </button>
      </div>
    </div>
  );
}
