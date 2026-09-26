import { useCallback, useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import { favLabel, normPath, favIndexOf, FAV_MAX } from '../../js/fav-dirs.js';

/**
 * 工具常用文件夹
 * ------------------------------------------------------------
 * 收藏一份目录、给它起个昵称，之后**任何**「选择文件夹」的界面
 * （项目组的浏览、agent-flow 的导出目录）都能一步到达。
 *
 * 这是工具级设置，不是某个插件的私有配置：
 * 收藏存在 Config.fav_dirs 里，由 Rust 侧统一读写，
 * 所以在哪个界面收藏的，在另一个界面同样看得见。
 *
 * 【为什么在这里也能改，而不只在选择器里改】
 * 选择器里的「★ 收藏」只能收藏**当前正看着的那个**目录；
 * 批量改名、清理失效条目（盘拔了、目录删了）在那里做不了。
 * 少了这个页签，用户想删一条收藏就得先找到那个目录再进去 ——
 * 而恰恰是"找不到了"才想删它。
 *
 * 【改名走整表替换】
 * 后端 fpx_save_fav_dirs 是整表替换，不是单条增删改。
 * 前端先改本地数组再整表写回，写完重新拉一次 ——
 * 不重拉的话界面显示的是"我以为存成了的样子"，
 * 一旦后端因为去重 / 上限截断了某条，界面就和磁盘不一致，
 * 而这种不一致不会报错，要等下次打开才发现。
 */
type Fav = { path: string; label: string };

export default function FavDirsCard() {
  const ctx = useNexus();
  const [favs, setFavs] = useState<Fav[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      const list = await ctx.invoke<any[]>('fpx_list_fav_dirs');
      setFavs(
        (list ?? []).map((f: any) => ({
          path: normPath(f?.path),
          label: String(f?.label ?? '').trim(),
        })).filter((f: Fav) => !!f.path),
      );
      setErr(null);
    } catch (e: any) {
      setFavs(null);
      setErr(String(e?.message ?? e));
    }
  }, [ctx]);

  useEffect(() => { refresh(); }, [refresh]);

  const save = useCallback(async (next: Fav[]) => {
    setBusy(true);
    try {
      await ctx.invoke('fpx_save_fav_dirs', {
        dirs: next.map((f) => ({ path: f.path, label: f.label || null })),
      });
      await refresh();
      return true;
    } catch (e: any) {
      ctx.toast(String(e?.message ?? e), 'err');
      return false;
    } finally {
      setBusy(false);
    }
  }, [ctx, refresh]);

  const add = useCallback(async (raw: string) => {
    const p = normPath(raw);
    if (!p) return;
    const cur = favs ?? [];
    if (favIndexOf(cur, p) >= 0) {
      ctx.toast('这个目录已经在常用里了', 'err');
      return;
    }
    if (cur.length >= FAV_MAX) {
      ctx.toast(`常用文件夹最多 ${FAV_MAX} 个`, 'err');
      return;
    }
    if (await save([...cur, { path: p, label: '' }])) setDraft('');
  }, [favs, save, ctx]);

  /**
   * 「浏览…」—— 直接调统一的目录选择服务，而不是在设置页里再写一套选择器。
   * 少了这一步，用户得手工粘贴完整路径；
   * 而"手工粘贴"恰恰是收藏这件事最劝退的地方。
   */
  const browse = useCallback(async () => {
    try {
      const r: any = await ctx.services.call('folder-picker', 'pick', {
        title: '选择要收藏的文件夹',
        startPath: draft || '',
        allowCreate: false,
      });
      const p = normPath(r?.path);
      if (p) await add(p);
    } catch (e: any) {
      /*
       * 服务调不通**必须明确说**，不能静默什么都不做：
       * 用户点了「浏览…」却毫无反应，只会认为是按钮坏了。
       * 说明里带上原因，也指明还有"手工粘贴"这条路可走。
       */
      ctx.toast(`打开目录选择器失败：${String(e?.message ?? e)}（也可以直接粘贴路径）`, 'err');
    }
  }, [ctx, draft, add]);

  const remove = useCallback(async (p: string) => {
    const cur = favs ?? [];
    const i = favIndexOf(cur, p);
    if (i < 0) return;
    await save(cur.filter((_, k) => k !== i));
  }, [favs, save]);

  const commitName = useCallback(async () => {
    const target = editing;
    if (!target) return;
    const cur = favs ?? [];
    const i = favIndexOf(cur, target);
    setEditing(null);
    if (i < 0) return;
    const next = cur.slice();
    next[i] = { ...next[i], label: nameDraft.trim() };
    await save(next);
  }, [editing, favs, nameDraft, save]);

  return (
    <div className="p-card">
      <h2>常用文件夹</h2>
      <div className="p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', lineHeight: 1.9 }}>
        在这里收藏的目录，会出现在所有「选择文件夹」的界面顶部（项目组、agent-flow 共用同一份）。
        <br />
        可以只填路径 —— 不填昵称时显示文件夹本身的名称。
        <br />
        收藏时不检查目录是否存在：临时拔掉的 U 盘、还没连上的网络盘也能先存着。
      </div>

      {err ? (
        <div className="p-muted" style={{ padding: '12px 0', color: 'var(--danger)' }}>
          读取常用文件夹失败：{err}
        </div>
      ) : favs === null ? (
        <div className="p-muted" style={{ padding: '12px 0' }}>载入中…</div>
      ) : !favs.length ? (
        <div className="p-muted" style={{ padding: '12px 0' }}>
          还没有常用文件夹。收藏之后，选目录就不用一层层点了。
        </div>
      ) : favs.map((f) => (
        <div
          key={f.path}
          className="p-row"
          style={{
            padding: '10px 12px', marginTop: 'var(--sp-4, 8px)', borderRadius: 'var(--r-sm)',
            background: 'var(--surface-sunk)',
            boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
          }}
        >
          {editing === f.path ? (
            <>
              <input
                className="p-input sm"
                type="text"
                autoFocus
                placeholder="昵称（留空则显示文件夹名）"
                style={{ flex: 1, fontSize: 'var(--fs-12, 12px)', padding: '0 10px', minWidth: 0 }}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName();
                  if (e.key === 'Escape') { setEditing(null); }
                }}
              />
              <button
                className="p-btn sm"
                style={{ padding: '0 9px', fontSize: 'var(--fs-11, 11px)' }}
                disabled={busy}
                onClick={commitName}
              >
                保存
              </button>
              <button
                className="p-btn sm"
                style={{ padding: '0 9px', fontSize: 'var(--fs-11, 11px)' }}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
            </>
          ) : (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--fs-13, 13px)', color: 'var(--text)' }}>
                  ★ {favLabel(f)}
                </div>
                <div
                  className="p-mono"
                  style={{ fontSize: 'var(--fs-11, 11px)', color: 'var(--text-mute)', wordBreak: 'break-all' }}
                >
                  {f.path}
                </div>
              </div>
              <button
                className="p-btn sm"
                style={{ padding: '0 9px', fontSize: 'var(--fs-11, 11px)' }}
                title="改昵称"
                disabled={busy}
                onClick={() => { setEditing(f.path); setNameDraft(f.label ?? ''); }}
              >
                改名
              </button>
              <button
                className="p-btn sm"
                style={{ padding: '0 9px', fontSize: 'var(--fs-11, 11px)' }}
                title="取消收藏"
                disabled={busy}
                onClick={() => remove(f.path)}
              >
                ✕
              </button>
            </>
          )}
        </div>
      ))}

      <div className="p-row" style={{ marginTop: 'var(--sp-6, 12px)' }}>
        <input
          className="p-input sm"
          type="text"
          placeholder="粘贴要收藏的目录完整路径，如 /Users/me/projects"
          style={{ flex: 1, fontSize: 'var(--fs-12, 12px)', padding: '0 10px', minWidth: 0 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(draft); }}
        />
        <button
          className="p-btn"
          style={{ padding: '0 14px', fontSize: 'var(--fs-12, 12px)' }}
          disabled={busy}
          onClick={browse}
        >
          浏览…
        </button>
        <button
          className="p-btn primary"
          style={{ padding: '0 14px', fontSize: 'var(--fs-12, 12px)' }}
          disabled={busy || !normPath(draft)}
          onClick={() => add(draft)}
        >
          收藏
        </button>
      </div>
    </div>
  );
}
