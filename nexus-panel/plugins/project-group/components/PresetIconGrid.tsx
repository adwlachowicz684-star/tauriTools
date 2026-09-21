import { useEffect, useMemo, useRef, useState } from 'react';
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
/* #146 图标网格高度自适应：与 #147 模板框共用同一个测量 hook */
import { useAvailableHeight } from '../hooks/useAvailableHeight';
/* #7 剪贴板图片 → 多尺寸 ICO（与设置页「软件图标」那处共用同一份转换） */
import { imageToIcoBase64 } from '../utils/ico';

/** 内置图标默认归入的组名（与原版一致）。 */
const DEFAULT_GROUP = '默认';

/**
 * 受支持的图片格式（对齐原版 `PresetIconService.IsSupportedImage`）。
 *
 * .ico 直接入库，其余转多尺寸 .ico。收在这里而不是内联在调用处：
 * 以后加一种格式，过滤与提示两处都会跟着变，写散了就容易漏一处 ——
 * 漏了的表现是"这个文件能用却不让用"，没有任何报错。
 */
const SUPPORTED_IMAGE_EXT = ['.ico', '.png', '.jpg', '.jpeg', '.bmp', '.gif'];

function isSupportedImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_IMAGE_EXT.some((e) => lower.endsWith(e));
}

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
  /** #146 图标网格：限高容器 */
  const gridRef = useRef<HTMLDivElement>(null);
  const gridH = useAvailableHeight(gridRef, { minHeight: 120, bottomGap: 14 });

  const [active, setActive] = useState<string>(DEFAULT_GROUP);
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState('');

  /*
   * #156 剪贴板页签（原版 IconPickDialog 三个页签之一：预设 / 系统 / 剪贴板）。
   *
   * 「系统」那页依赖 Windows 图标提取（#5/#6），本版没有，故只做两个。
   */
  const [tab, setTab] = useState<'preset' | 'clip'>('preset');
  /** 剪贴板里的图：dataURL 用于预览，Blob 用于转 ICO */
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipBlob, setClipBlob] = useState<Blob | null>(null);
  const [clipMsg, setClipMsg] = useState('');
  /* 目标分组；'' 表示"仅应用、不加入任何分组"（原版 noAddText 那一项） */
  const [clipGroup, setClipGroup] = useState<string>(DEFAULT_GROUP);

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

  /**
   * #151 分组标题上的 × —— 删**指定**那一组。
   *
   * 与原来的「删除分组」按钮（作用于当前活动组）不同：
   * 用户点的是**某个标题**上的 ×，删的必须就是那一组。
   * 若仍按 active 删，实际删掉的可能是用户没打算动的那个，
   * 而且没有任何提示（这与 #82 那处是同一类错误）。
   */
  const removeGroupAt = async (i: number) => {
    const g = effective[i];
    if (!g) return;
    if (effective.length <= 1) { onLog('至少保留一个分组', true); return; }
    const ok = await confirm({
      title: '删除分组',
      message: `删除分组「${g.name}」？组内图标不会被删除，只是取消归类。`,
      danger: true,
    });
    if (!ok) return;
    commit(effective.filter((x) => x.name !== g.name));
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

  /**
   * 读剪贴板里的图片。
   *
   * 两条入口都要有：按钮（`navigator.clipboard.read`）与面板内 paste 事件。
   * 只给按钮的话，用户按 Ctrl+V 会什么都没发生 ——
   * 而"粘贴"这件事的默认操作就是 Ctrl+V，没有它最反直觉。
   */
  const takeImage = (item: Blob | null, why: string) => {
    if (!item) { setClipMsg(why); return; }
    setClipBlob(item);
    setClipUrl(URL.createObjectURL(item));
    setClipMsg('');
  };

  const pasteFromClipboard = async () => {
    try {
      /* Safari 等不支持 read() 时报的错要给出来 ——
         否则点了没反应，用户会以为剪贴板是空的。 */
      const items = await navigator.clipboard.read();
      for (const it of items) {
        for (const t of it.types) {
          if (!t.startsWith('image/')) continue;
          takeImage(await it.getType(t), '');
          return;
        }
      }
      setClipMsg('剪贴板里没有图片。');
    } catch (e) {
      setClipMsg(`读取剪贴板失败：${errText(e)}`);
    }
  };

  /*
   * #157 应用后**不清空**剪贴板图。
   *
   * 原版注释写得很直接：「不清空 _clipboardImage：非模态下可对连续选中的
   * 多张卡重复应用同一张图」。本版 #8 已经是非模态（换卡片换目标），
   * 若这里清空，用户给第二张卡贴同一张图就得重新复制一次 ——
   * 而非模态的意义本来就是"连着贴好几张"。
   */
  const applyClipboard = async () => {
    if (!clipBlob) { setClipMsg('请先粘贴图片。'); return; }
    setBusy('clip');
    try {
      const b64 = await imageToIcoBase64(clipBlob);
      /* 名字用「剪贴板」（原版 baseName），重名由后端自动加 (1) */
      const path = await api.saveIconData('剪贴板', b64);
      const nm = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.ico$/, '') ?? '剪贴板';
      if (clipGroup) {
        commit(effective.map((g) => (g.name === clipGroup && !g.icons.includes(nm)
          ? { ...g, icons: [...g.icons, nm] } : g)));
      }
      onPick(path);
      setClipMsg(`已应用${clipGroup ? `并加入「${clipGroup}」` : ''}：${nm}`);
    } catch (e) {
      setClipMsg(`应用失败：${errText(e)}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={`fpx-preset${tab === 'clip' ? ' clip' : ''}`}>
      <div className="fpx-prestab">
        <button className={tab === 'preset' ? 'on' : ''} onClick={() => setTab('preset')}>预设库</button>
        <button className={tab === 'clip' ? 'on' : ''} onClick={() => setTab('clip')}>剪贴板</button>
      </div>
      {tab === 'clip' && (
        <div
          className="fpx-clip"
          /* 粘贴要挂在这块上：window 级监听会与页面里其它输入框的粘贴打架 */
          onPaste={(e) => {
            /*
             * 两条入口都要查（对齐原版 `PasteFromClipboard`）：
             *   ① 位图本身（截图、画图软件里复制）
             *   ② **图片文件**（在资源管理器里复制一个 .png 再粘贴）
             *
             * 只查 ① 的话，第 ② 种最常见的操作会完全没反应 ——
             * 用户复制了个文件、粘贴、界面什么都不发生。
             * 原版专门写了 `ContainsFileDropList` 那条分支，正是为此。
             *
             * 只查 ② 也不行：截图时剪贴板里根本没有文件条目。
             */
            const items = Array.from(e.clipboardData?.items ?? []);
            const bitmap = items.find((it) => it.type.startsWith('image/'));
            if (bitmap) {
              e.preventDefault();
              takeImage(bitmap.getAsFile(), '');
              return;
            }
            /*
             * 文件分支要**按扩展名过滤**：剪贴板里可能同时有各种文件
             * （复制一整个文件夹里的东西过来很常见）。不过滤的话
             * 拿第一个 .txt 去解码，报出来的错完全指不到原因。
             */
            const file = Array.from(e.clipboardData?.files ?? [])
              .find((f) => isSupportedImageFile(f.name));
            if (file) {
              e.preventDefault();
              takeImage(file, '');
              return;
            }
            setClipMsg('剪贴板里没有图片。');
          }}
        >
          <div className="p-row">
            <button className="p-btn" onClick={() => void pasteFromClipboard()}>粘贴</button>
            <button className="p-btn primary" disabled={!clipBlob || !!busy}
              onClick={() => void applyClipboard()}>
              {busy ? '处理中…' : '应用'}
            </button>
          </div>
          <div className="p-muted" style={{ marginTop: 'var(--sp-4, 8px)' }}>
            {/*
              按钮那条路走的是 `clipboard.read()`，它**只给位图**，
              拿不到"复制了一个图片文件"这种情况（浏览器 API 的限制）。
              所以要写明：复制文件请按 Ctrl+V。
              不写的话用户点了按钮没反应，只会以为功能坏了。
            */}
            也可以直接按 Ctrl+V（复制图片文件时只能用它）。
          </div>
          {clipUrl ? (
            <img className="fpx-clip-preview" src={clipUrl} alt="剪贴板图片" />
          ) : (
            <div className="fpx-clip-empty">还没有图片</div>
          )}
          <div className="fpx-field">
            <label>加入分组</label>
            <select className="p-input" value={clipGroup} onChange={(e) => setClipGroup(e.target.value)}>
              <option value="">（仅应用，不加入分组）</option>
              {effective.map((g) => (
                <option key={g.name} value={g.name}>{g.name}</option>
              ))}
            </select>
          </div>
          {clipMsg && <div className="p-muted">{clipMsg}</div>}
        </div>
      )}
      <div className="fpx-groupbar">
        {effective.map((g, i) => (
          /* #151 外层 wrap 只为承载 hover 显形的删除按钮；
             标题按钮本身仍是拖拽/重命名的主体。 */
          <div className="fpx-groupwrap" key={g.name}>
          <button
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
              const src = groupDrag;
              const k = groupGap ?? i;
              setGroupGap(null);
              setGroupDrag(null);
              /* 回弹（同 CardGrid）：拖到自己身上 / 状态为空 = 这次没生效，
                 此时**不要** preventDefault —— 否则浏览器不做回弹动画，
                 拖影直接消失，看起来和成功放置一模一样。 */
              if (!src || src === g.name) return;
              e.preventDefault();
              moveGroup(src, k);
            }}
            onDragEnd={() => { setGroupDrag(null); setGroupGap(null); }}
            title="双击可重命名 · 拖动可排序 · Alt+←/→ 移动位置"
          >
            {g.name}
            <span className="fpx-groupcount">{g.icons.length}</span>
          </button>
          /* #151 删除按钮**不能嵌在标题按钮里**：button 套 button 是无效 HTML，
             浏览器会把嵌套的那个提到外面去，样式和事件都会错位。
             故做成兄弟元素，靠外层 wrap 的 hover 显形。 */
          {effective.length > 1 && (
            <button
              className="fpx-groupdel"
              title={`删除分组「${g.name}」`}
              onClick={() => void removeGroupAt(i)}
            >
              ×
            </button>
          )}
        </div>
        ))}
        <button className="fpx-grouptab add" onClick={addGroup} title="新建分组">＋</button>
        <span style={{ flex: 1 }} />
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
        /* #146 高度自适应：可用高 = 弹窗可视高 − 上方占用 − 底部留白。
           量不到时（不在弹窗里 / 首帧）传 null，CSS 里那条 340px 兜底仍在。 */
        <div className="fpx-icongrid" ref={gridRef}
          style={gridH ? { maxHeight: gridH } : undefined}>
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
                const src = iconDrag;
                setIconOver(null);
                setIconDrag(null);
                /* 同上：拖到自己 = 没生效，不 preventDefault 才有回弹 */
                if (!src || src === n) return;
                e.preventDefault();
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
