import { useEffect, useMemo, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import { PRESET_ICON_NAMES, presetIconUrl } from '../presetIcons';
import type { IconGroup } from '../types';
import { confirm, prompt } from '../../../js/dialog.js';
/* 图标排序（#72）与卡片/页签排序用的是同一套"先移除再插入"的索引纠偏，
   走 utils/dragSort 的 resolveMoveIndex，不另写一份 ——
   另写一份的话，改了那边的边界处理这里就会悄悄不一致。 */
import { resolveMoveIndex, clampIndex, gapIndexAtX } from '../utils/dragSort';
/* #12 清理失效项：判定与清理都是纯函数，放在 utils 里好测 */
import { pruneGroups, staleByList, staleByProbe, totalRemoved } from '../utils/iconGroups';

/** 内置图标默认归入的组名（与原版一致）。 */
const DEFAULT_GROUP = '默认';

/** 二进制 → base64（图标只有几 KB，直接拼字符串即可，无需分块优化）。 */
async function toBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读取图标失败: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * 内置图标库（随插件发布的 122 个 .ico）按分组浏览并选用。
 *
 * 图标文件在插件同目录 preseticons/ 下，iframe 内用相对 URL 直接 <img> 显示，
 * 不必经后端转 base64；但「同步到资源管理器」要写 desktop.ini，必须有真实文件，
 * 所以选用时会把内容交给后端固化到数据目录 icons/，之后统一当普通图标路径处理。
 */
export function PresetIconGrid({
  api, groups, onGroupsChange, onPick, onLog,
}: {
  api: Api;
  groups: IconGroup[];
  onGroupsChange: (next: IconGroup[]) => void;
  onPick: (path: string) => void;
  onLog: (m: string, isError?: boolean) => void;
}) {
  const [active, setActive] = useState<string>(DEFAULT_GROUP);
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState('');

  /** 保证至少有一个默认分组；默认组初始收录全部内置图标。 */
  const effective = useMemo<IconGroup[]>(() => {
    if (groups.length > 0) return groups;
    return [{ name: DEFAULT_GROUP, icons: [...PRESET_ICON_NAMES] }];
  }, [groups]);

  // 当前激活分组若被删掉，回退到第一个
  useEffect(() => {
    if (!effective.some((g) => g.name === active)) {
      setActive(effective[0]?.name ?? DEFAULT_GROUP);
    }
  }, [effective, active]);

  const current = effective.find((g) => g.name === active) ?? effective[0];
  const shown = addMode
    ? PRESET_ICON_NAMES.filter((n) => !current?.icons.includes(n))
    : (current?.icons ?? []);

  const commit = (next: IconGroup[]) => {
    onGroupsChange(next);
  };

  const renameGroup = async () => {
    if (!current) return;
    const raw = await prompt({ title: '重命名分组', label: '分组名', defaultValue: current.name });
    const name = (raw ?? '').trim();
    if (!name || name === current.name) return;
    if (effective.some((g) => g.name === name)) {
      onLog(`分组「${name}」已存在`, true);
      return;
    }
    commit(effective.map((g) => (g.name === current.name ? { ...g, name } : g)));
    setActive(name);
  };

  const addGroup = async () => {
    const raw = await prompt({ title: '新建分组', label: '新分组名', defaultValue: `分组${effective.length + 1}` });
    const name = (raw ?? '').trim();
    if (!name) return;
    if (effective.some((g) => g.name === name)) {
      onLog(`分组「${name}」已存在`, true);
      return;
    }
    commit([...effective, { name, icons: [] }]);
    setActive(name);
  };

  /**
   * #12 清理失效项。
   *
   * 两路判据都要走：
   *   · 清单里已经没有这个名字（插件更新删了图标）
   *   · 名字在清单里、但物理文件没发出来（两种表现都是破图，用户分不清）
   *
   * **默认组不适用**：config 还没分组时用的是动态生成的默认组，
   * 它就是"全部有效名"，不存在失效概念。硬要清会清出 0 项，
   * 用户会以为功能坏了。
   */
  const hasStoredGroups = groups.length > 0;

  const cleanStale = async () => {
    if (!hasStoredGroups) return;
    const byList = staleByList(effective, PRESET_ICON_NAMES);
    /* 只对"清单里有"的名字做文件探测 —— 清单里没有的已经确定失效，不必再探。 */
    const probeTargets: string[] = [];
    for (const g of effective) {
      for (const n of g.icons) {
        if (PRESET_ICON_NAMES.includes(n) && !probeTargets.includes(n)) probeTargets.push(n);
      }
    }
    const byProbe = await staleByProbe(probeTargets, (n) => new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = presetIconUrl(n);
    }));

    const all = [...byList, ...byProbe];
    if (all.length === 0) {
      /* **明确说"没有"，而不是静默** —— 点了没反应用户会以为功能坏了 */
      onLog('没有失效项');
      return;
    }
    const { groups: next, removed } = pruneGroups(effective, all);
    const detail = effective
      .map((g, i) => (removed[i] > 0 ? `${g.name} ${removed[i]} 个` : ''))
      .filter(Boolean).join('、');
    const ok = await confirm({
      title: '清理失效项',
      message: `以下 ${all.length} 个图标已失效（文件不存在）：${all.slice(0, 8).join('、')}`
        + `${all.length > 8 ? ' 等' : ''}\n\n将清理：${detail}\n\n确认清理？`,
      danger: true,
    });
    if (!ok) return;
    commit(next);
    onLog(`已清理 ${totalRemoved(removed)} 个失效项（${detail}）`);
  };

  const deleteGroup = async () => {
    if (!current) return;
    if (effective.length <= 1) { onLog('至少保留一个分组', true); return; }
    const ok = await confirm({
      title: '删除分组',
      message: `删除分组「${current.name}」？组内图标不会被删除，只是取消归类。`,
      danger: true,
    });
    if (!ok) return;
    commit(effective.filter((g) => g.name !== current.name));
  };

  /**
   * 图标拖到某个位置（#72）。
   *
   * 走 `resolveMoveIndex`：从 from 移到 k 时，因为"先移除再插入"，
   * 插入下标与原始缝隙下标错开一位 —— 不纠偏就会落到隔壁。
   * 这个坑在卡片和页签那里都踩过，这里直接复用同一个函数。
   */
  const [iconDrag, setIconDrag] = useState<string | null>(null);
  const [iconOver, setIconOver] = useState<number | null>(null);

  /* ---------------- 分组重排（#73）---------------- */
  const [groupDrag, setGroupDrag] = useState<string | null>(null);
  const [groupGap, setGroupGap] = useState<number | null>(null);

  /**
   * 分组拖到第 k 个缝隙。
   *
   * **拖完必须把被拖的组设为 active**：否则当前查看的组会跳成落点处的那个，
   * 下面显示的图标全变了 —— 用户会以为"刚才那组的东西丢了"。
   * 他拖的是**顺序**，不是想切换正在看哪一组。
   */
  const moveGroup = (name: string, k: number) => {
    const from = effective.findIndex((g) => g.name === name);
    if (from < 0) return;
    const to = clampIndex(resolveMoveIndex(from, k, effective.length), effective.length - 1);
    if (to === from) return;
    const next = [...effective];
    const [g] = next.splice(from, 1);
    next.splice(to, 0, g);
    commit(next);
    setActive(name);
  };

  /** 键盘可达：Alt+←/→ 挪动整个分组（纯鼠标才能用的功能对键盘用户等于没有） */
  const nudgeGroup = (name: string, dir: -1 | 1) => {
    const from = effective.findIndex((g) => g.name === name);
    if (from < 0) return;
    const to = from + dir;
    if (to < 0 || to >= effective.length) return;
    const next = [...effective];
    const [g] = next.splice(from, 1);
    next.splice(to, 0, g);
    commit(next);
    setActive(name);
  };

  const moveIcon = (icon: string, k: number) => {
    if (!current) return;
    const from = current.icons.indexOf(icon);
    if (from < 0) return;
    const to = clampIndex(resolveMoveIndex(from, k, current.icons.length), current.icons.length - 1);
    if (to === from) return;
    const next = [...current.icons];
    next.splice(from, 1);
    next.splice(to, 0, icon);
    commit(effective.map((g) => (g.name === current.name ? { ...g, icons: next } : g)));
  };

  /** 键盘可达的排序：← → 微调整个位置（纯鼠标才能用的功能对键盘用户等于没有） */
  const nudgeIcon = (icon: string, dir: -1 | 1) => {
    if (!current) return;
    const from = current.icons.indexOf(icon);
    if (from < 0) return;
    const to = from + dir;
    if (to < 0 || to >= current.icons.length) return;
    const next = [...current.icons];
    next.splice(from, 1);
    next.splice(to, 0, icon);
    commit(effective.map((g) => (g.name === current.name ? { ...g, icons: next } : g)));
  };

  const removeFromGroup = (icon: string) => {
    if (!current) return;
    commit(effective.map((g) =>
      g.name === current.name ? { ...g, icons: g.icons.filter((x) => x !== icon) } : g));
  };

  const addToGroup = (icon: string) => {
    if (!current) return;
    commit(effective.map((g) =>
      g.name === current.name && !g.icons.includes(icon)
        ? { ...g, icons: [...g.icons, icon] }
        : g));
  };

  /** 选用：先把内置图标固化到数据目录，再把落盘路径交给上层。 */
  const use = async (name: string) => {
    setBusy(name);
    try {
      const b64 = await toBase64(presetIconUrl(name));
      const path = await api.saveIconData(name, b64);
      onPick(path);
    } catch (e) {
      onLog(`选用图标「${name}」失败：${errText(e)}`, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="fpx-preset">
      <div className="fpx-groupbar">
        {effective.map((g, i) => (
          <button
            key={g.name}
            className={[
              'fpx-grouptab',
              g.name === active ? 'active' : '',
              groupDrag === g.name ? 'dragging' : '',
              groupGap === i && groupDrag ? 'gap-before' : '',
              groupGap === effective.length && groupDrag && i === effective.length - 1
                ? 'gap-after' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => { setActive(g.name); setAddMode(false); }}
            onDoubleClick={renameGroup}
            onKeyDown={(e) => {
              /* 重排也要能靠键盘，否则纯键盘用户根本调不了顺序 */
              if (!e.altKey) return;
              if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeGroup(g.name, -1); }
              if (e.key === 'ArrowRight') { e.preventDefault(); nudgeGroup(g.name, 1); }
            }}
            /* #73 分组可拖动重排。只有多于一个组时才可拖 ——
               一个组拖不出任何结果，却会让人以为是坏了。 */
            draggable={effective.length > 1}
            onDragStart={() => setGroupDrag(g.name)}
            onDragOver={(e) => {
              if (!groupDrag) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setGroupGap(gapIndexAtX({ left: r.left, width: r.width }, e.clientX, i));
            }}
            onDragLeave={() => { if (groupGap !== null) setGroupGap(null); }}
            onDrop={(e) => {
              e.preventDefault();
              const src = groupDrag;
              const k = groupGap ?? i;
              setGroupGap(null);
              setGroupDrag(null);
              if (!src || src === g.name) return;
              moveGroup(src, k);
            }}
            onDragEnd={() => { setGroupDrag(null); setGroupGap(null); }}
            title="双击可重命名 · 拖动可排序 · Alt+←/→ 移动位置"
          >
            {g.name}
            <span className="fpx-groupcount">{g.icons.length}</span>
          </button>
        ))}
        <button className="fpx-grouptab add" onClick={addGroup} title="新建分组">＋</button>
        <span style={{ flex: 1 }} />
        {current && effective.length > 1 && (
          <button className="p-btn mini" onClick={deleteGroup}>删除分组</button>
        )}
        {/* #12 只在真的存了分组时才显示 —— 默认组是动态生成的、没有失效项，
            给一个永远清出 0 项的按钮只会让人以为功能坏了 */}
        {hasStoredGroups && (
          <button className="p-btn mini" onClick={() => void cleanStale()} title="移除各分组中文件已不存在的图标">
            清理失效
          </button>
        )}
        <button
          className={`p-btn mini${addMode ? ' primary' : ''}`}
          onClick={() => setAddMode((v) => !v)}
          disabled={!current}
        >
          {addMode ? '完成' : '加入图标'}
        </button>
      </div>

      {addMode && (
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-3, 6px)' }}>
          点图标即可加入「{current?.name}」
        </div>
      )}

      {shown.length === 0 ? (
        <div className="p-muted">
          {addMode ? '全部内置图标都已在本组中。' : '本组还没有图标，点「加入图标」从内置库里挑。'}
        </div>
      ) : (
        <div className="fpx-icongrid">
          {shown.map((n, i) => (
            <div
              key={n}
              className={`fpx-icongrid-item${iconOver === i && iconDrag && iconDrag !== n ? ' over' : ''}`}
              /* 加入模式下不排序：那时这格是"待加入的候选"，
                 拖它排序会让人误以为已经在本组里了。 */
              draggable={!addMode}
              onDragStart={(e) => {
                if (addMode) return;
                setIconDrag(n);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => { if (iconDrag) { e.preventDefault(); setIconOver(i); } }}
              onDragLeave={() => { if (iconOver === i) setIconOver(null); }}
              onDrop={(e) => {
                e.preventDefault();
                const src = iconDrag;
                setIconOver(null);
                setIconDrag(null);
                if (!src || src === n) return;
                moveIcon(src, i);
              }}
              onDragEnd={() => { setIconDrag(null); setIconOver(null); }}
            >
              <button
                className="fpx-icontile"
                title={n}
                disabled={busy !== ''}
                onClick={() => (addMode ? addToGroup(n) : void use(n))}
                onKeyDown={(e) => {
                  /* 排序也要能靠键盘：否则纯键盘用户根本没法调顺序 */
                  if (addMode || e.altKey === false) return;
                  if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeIcon(n, -1); }
                  if (e.key === 'ArrowRight') { e.preventDefault(); nudgeIcon(n, 1); }
                }}
              >
                <img src={presetIconUrl(n)} alt={n} loading="lazy" />
                <span className="fpx-iconcap">{n}</span>
                {busy === n && <span className="fpx-icontile-busy">…</span>}
              </button>
              {!addMode && (
                <button
                  className="fpx-icon-del"
                  title="从本组移除"
                  onClick={() => removeFromGroup(n)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
