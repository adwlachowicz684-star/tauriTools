import { useEffect, useMemo, useRef, useState } from 'react';
import { ContentPanel } from './components/ContentPanel';
import { RenameDialog } from './components/RenameDialog';
import { CardGrid, TabBar, type DragPayload } from './components/CardGrid';
import { CreateDialog, IconPickDialog, LockDialog, StyleDialog } from './components/dialogs';
import { DirDialog } from './components/DirDialog';
import { LinkAgentDialog, LinkTable } from './components/LinkPanel';
import { SettingsDialog } from './components/SettingsDialog';
import {
  BackupDialog, ChainDialog, EditorDialog, ServiceDialog,
} from './components/ToolsPanel';
import { ConfirmDialog, ContextMenu, type MenuItem } from './components/ui';
import { useFpx } from './hooks/useFpx';
import { useIconThumbs } from './hooks/useIconThumbs';
import type { CardInfo, CardKind, ChainAction, LinkRow } from './types';

type Dialog =
  | { type: 'none' }
  | { type: 'pickDir'; kind: CardKind }
  | { type: 'create'; kind: CardKind }
  | { type: 'agents' }
  | { type: 'lock'; card: CardInfo }
  | { type: 'style'; card: CardInfo }
  | { type: 'icons'; card: CardInfo }
  | { type: 'backup' }
  | { type: 'editor' }
  | { type: 'chain'; target: string; kind: CardKind }
  | { type: 'settings' }
  | { type: 'service' }
  | { type: 'rename'; card: CardInfo; kind: CardKind };

export default function App() {
  const s = useFpx();
  const { ctx, boot } = s;
  const [dialog, setDialog] = useState<Dialog>({ type: 'none' });
  const [iconFiles, setIconFiles] = useState<string[]>([]);

  useEffect(() => { ctx.setTitle('项目组分配'); }, [ctx]);
  useEffect(() => { ctx.setBadge(boot?.links.length ?? 0); }, [ctx, boot?.links.length]);

  /**
   * 监听告警只能轮询拉取。
   * 本插件跑在 iframe 沙箱，宿主明确禁用了 listenTauri（见 js/host.js），
   * Rust 侧 app.emit 的事件到不了这里，所以后端把变化堆在队列里，前端定时取。
   */
  const [watchOn, setWatchOn] = useState(false);

  useEffect(() => {
    if (!watchOn) return;
    const secs = Math.max(5, boot?.config.watchIntervalSecs || 30);
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const evs = await s.api.watchPoll();
        for (const ev of evs) {
          const what = ev.kind === 'added' ? '新增' : ev.kind === 'removed' ? '被删除' : '发生改动';
          s.pushLog(`受保护目录${what}：${ev.path}`, ev.kind === 'removed');
        }
      } catch {
        /* 后端未启动监听时会失败，静默跳过，避免刷屏 */
      }
    };
    void tick();
    const timer = window.setInterval(tick, secs * 1000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [watchOn, boot?.config.watchIntervalSecs, s]);

  // 上次勾选过监听则进插件时自动恢复
  const watchBooted = useRef(false);
  useEffect(() => {
    if (watchBooted.current || !boot?.config.watchEnabled) return;
    watchBooted.current = true;
    s.api.watchStart(boot.config.watchIntervalSecs)
      .then((ok) => {
        setWatchOn(ok);
        s.pushLog('已按上次设置恢复受保护目录监听');
      })
      .catch((e) => s.pushLog(`恢复监听失败：${String(e)}`, true));
  }, [boot?.config.watchEnabled, boot?.config.watchIntervalSecs, s]);

  const [help, setHelp] = useState(false);

  const projectCards = useMemo(
    () => boot?.projectTabs[s.activeTab.project]?.items ?? [],
    [boot, s.activeTab.project],
  );
  const groupCards = useMemo(
    () => boot?.groupTabs[s.activeTab.group]?.items ?? [],
    [boot, s.activeTab.group],
  );

  // 卡片图标是本地路径，沙箱内需后端转 data URI 才能显示
  const iconPaths = useMemo(
    () => [...projectCards, ...groupCards]
      .map((c) => c.icon)
      .filter((v): v is string => !!v),
    [projectCards, groupCards],
  );
  const iconThumbs = useIconThumbs(s.api, iconPaths);

  const openPath = (p: string, mode: 'auto' | 'dir' | 'containing' | 'editor' = 'auto') =>
    s.api.openPath(p, mode).catch((e) => s.pushLog(String((e as Error)?.message ?? e), true));

  /* ---------------- 卡片右键菜单 ---------------- */
  const menus = (kind: CardKind) => (card: CardInfo): MenuItem[] => {
    const base: MenuItem[] = [
      { label: '打开文件夹', onClick: () => openPath(card.path, 'dir') },
      {
        label: '复制完整路径',
        onClick: () => navigator.clipboard?.writeText(card.path).then(
          () => ctx.toast('已复制路径', 'ok'),
          () => ctx.toast('复制失败', 'err'),
        ),
      },
      { label: '改名…（F2）', onClick: () => setDialog({ type: 'rename', card, kind }) },
      { label: '保护（ACL）…', onClick: () => setDialog({ type: 'lock', card }) },
      { label: '图标与标签…', onClick: () => setDialog({ type: 'style', card }) },
      { label: '发送到 AI…', onClick: () => setDialog({ type: 'chain', target: card.path, kind }) },
    ];
    // 勾选了「加入右键菜单」的动作直接列出来，省一次进面板再选的点击
    for (const a of chainActions) {
      if (!a.showContextMenu) continue;
      base.push({
        label: `${a.icon} ${a.name}`,
        onClick: () => void sendAction(a.id, kind, card.path),
      });
    }
    if (kind === 'project') {
      base.push({
        label: card.hasLink ? '撤销链接' : '（未建链接）',
        disabled: !card.hasLink,
        onClick: () => s.removeLink(card.path),
      });
    }
    base.push({
      label: kind === 'project' ? '转为项目组（换栏）' : '转为项目（换栏）',
      // 落到目标栏当前正在看的页签，而不是默认第一个
      onClick: () => void s.moveCardAcross(
        kind, card.path, kind === 'project' ? s.activeTab.group : s.activeTab.project,
      ),
    });
    base.push({
      label: '从页签移除',
      danger: true,
      onClick: () => s.removeCard(kind, card.path),
    });
    return base;
  };

  /** 「快速链接」关闭时，跨栏拖放先弹确认：待建链的项目 / 项目组 */
  const [confirmLink, setConfirmLink] = useState<{ project: string; group: string } | null>(null);

  /** 连锁动作清单：右键菜单按需渲染，工具栏「发送到 AI」也用同一份 */
  const [chainActions, setChainActions] = useState<ChainAction[]>([]);
  useEffect(() => {
    if (!boot) return;
    s.api.chainActions().then(setChainActions).catch(() => setChainActions([]));
  }, [boot, s.api]);

  /* ---------------- 快捷键 + 侧边栏 ----------------
   * 快捷键走外壳的 ctx.shortcut（插件激活时生效、卸载自动注销）；
   * 侧边栏条目由插件登记、外壳渲染，点击后外壳把事件发回总线，这里用 ctx.on 接。
   *
   * 分两类：
   *   · 连锁动作自带的键位（用户自定义，存在 chainActions[].shortcut）
   *   · 固定功能键（打开/锁定/改名/搬家/改色/改图标/删除/刷新/清除无效/页签切换）
   */
  const sidebarEvent = (id: string) => `fpx:sidebar:${id}`;

  /** 当前选中项：用 ref 传，避免每点一张卡片就重建快捷键与侧边栏 */
  const selRef = useRef<{ path: string; kind: CardKind } | null>(null);
  selRef.current = s.selProject
    ? { path: s.selProject, kind: 'project' }
    : s.selGroup ? { path: s.selGroup, kind: 'group' } : null;

  /** 取当前选中的卡片对象（选中项可能已被清除 / 数据未就绪） */
  const selectedCard = (): { card: CardInfo; kind: CardKind } | null => {
    const sel = selRef.current;
    if (!sel || !boot) return null;
    const list = sel.kind === 'project'
      ? boot.projectTabs.flatMap((t) => t.items)
      : boot.groupTabs.flatMap((t) => t.items);
    const card = list.find((c) => c.path === sel.path);
    return card ? { card, kind: sel.kind } : null;
  };

  const runActionOnSelection = (a: ChainAction) => {
    const sel = selRef.current;
    if (!sel) {
      ctx.toast(`「${a.name}」需要选中一个项目或项目组`, 'err');
      return;
    }
    void sendAction(a.id, sel.kind, sel.path);
  };

  useEffect(() => {
    if (!boot) return;
    const offs: Array<() => void> = [];
    const sidebarIds: string[] = [];

    // ---- 连锁动作：用户自定义键位 + 可选挂侧边栏 ----
    for (const a of chainActions) {
      if (a.shortcut && a.shortcut.trim()) {
        offs.push(ctx.shortcut(a.shortcut.trim(), () => runActionOnSelection(a)));
      }
      if (a.showSidebar) {
        ctx.addSidebarItem({
          id: a.id, label: a.name, icon: a.icon || '▶', event: sidebarEvent(a.id),
        });
        sidebarIds.push(a.id);
        offs.push(ctx.on(sidebarEvent(a.id), () => runActionOnSelection(a)));
      }
    }

    // ---- 固定功能键（对齐原版 ShortcutCatalog 组2 / 组3）----
    // 需要选中项的动作统一走 needSel：没选中就提示，不静默失败
    const needSel = (label: string, fn: (card: CardInfo, kind: CardKind) => void) =>
      ctx.shortcut(label, () => {
        const hit = selectedCard();
        if (!hit) { ctx.toast('请先选中一个项目或项目组', 'err'); return; }
        fn(hit.card, hit.kind);
      });

    offs.push(needSel('mod+o', (c) => openPath(c.path, 'dir')));
    offs.push(needSel('mod+l', (c) => setDialog({ type: 'lock', card: c })));
    offs.push(needSel('F2', (c, k) => setDialog({ type: 'rename', card: c, kind: k })));
    offs.push(needSel('F4', (c) => setDialog({ type: 'style', card: c })));
    offs.push(needSel('F6', (c) => setDialog({ type: 'icons', card: c })));
    offs.push(needSel('Delete', (c, k) => s.removeCard(k, c.path)));
    // 搬家：与右键「转类别」等价，落到另一栏当前页签
    offs.push(needSel('F3', (c, k) => void s.moveCardAcross(
      k, c.path, k === 'project' ? s.activeTab.group : s.activeTab.project)));

    // 面板级：不依赖选中项
    offs.push(ctx.shortcut('F5', () => void s.refresh()));
    offs.push(ctx.shortcut('F8', () => void s.clearInvalid()));

    // 页签切换：project / group 各一组
    const tabShortcuts: Array<[string, CardKind, number]> = [
      ['ctrl+tab', 'group', 1], ['ctrl+shift+tab', 'group', -1],
      ['ctrl+pagedown', 'project', 1], ['ctrl+pageup', 'project', -1],
    ];
    for (const [combo, kind, delta] of tabShortcuts) {
      offs.push(ctx.shortcut(combo, () => {
        if (!boot) return;
        const count = (kind === 'project' ? boot.projectTabs : boot.groupTabs).length;
        if (count === 0) return;
        const cur = s.activeTab[kind];
        const next = (cur + delta + count) % count;
        s.setActiveTab((prev) => ({ ...prev, [kind]: next }));
      }));
    }
    // 左右方向键切焦点面板：这里简化为切到对应栏的第一个卡片
    offs.push(ctx.shortcut('ctrl+left', () => {
      if (!boot) return;
      const first = boot.projectTabs[s.activeTab.project]?.items[0];
      if (first) s.setSelProject(first.path);
    }));
    offs.push(ctx.shortcut('ctrl+right', () => {
      if (!boot) return;
      const first = boot.groupTabs[s.activeTab.group]?.items[0];
      if (first) s.setSelGroup(first.path);
    }));

    return () => {
      for (const off of offs) { try { off(); } catch { /* 忽略已失效的订阅 */ } }
      for (const id of sidebarIds) ctx.removeSidebarItem(id);
    };
    // 只在动作清单 / 数据变化时重建；选中项走 selRef，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, chainActions, ctx]);

  /** 直接按动作发送（右键菜单用），失败记日志 + toast */
  const sendAction = async (actionId: string, kind: CardKind, path: string) => {
    try {
      const r = await s.api.chainSendAction(actionId, kind, path);
      s.pushLog(r.message, !r.ok);
      ctx.toast(r.message, r.ok ? 'ok' : 'err');
    } catch (e) {
      const msg = `发送失败：${String((e as Error)?.message ?? e)}`;
      s.pushLog(msg, true);
      ctx.toast(msg, 'err');
    }
  };

  const onCrossDrop = (drag: DragPayload, target: CardInfo | null) => {
    if (!target) {
      ctx.toast('请拖到具体的卡片上', 'err');
      return;
    }
    // 拖放方向决定谁是项目、谁是项目组
    const project = drag.kind === 'project' ? drag.path : target.path;
    const group = drag.kind === 'project' ? target.path : drag.path;

    // 快速链接开着就直接建；关着则先确认——跨栏拖放比点点按钮更容易误触，
    // 误建链接会在项目目录里凭空多出若干 junction。
    if (boot?.config.quickLink) {
      void s.createLink(project, group);
      return;
    }
    setConfirmLink({ project, group });
  };

  const openIconPicker = async (card: CardInfo) => {
    try {
      const files = await s.api.listIcons();
      setIconFiles(files);
      setDialog({ type: 'icons', card });
    } catch (e) {
      s.pushLog(String((e as Error)?.message ?? e), true);
    }
  };

  if (s.loading) {
    return <div className="p-card"><div className="p-muted">正在加载项目组数据…</div></div>;
  }
  if (!boot) {
    return (
      <div className="p-card">
        <h2>加载失败</h2>
        <div className="p-muted">后端命令不可用。请确认在 Nexus Panel（Tauri 环境）中运行，且已重新编译 Rust 端。</div>
        <button className="p-btn primary" style={{ marginTop: 12 }} onClick={() => s.refresh()}>重试</button>
      </div>
    );
  }

  return (
    <div className="fpx-root">
      {/* ---------------- 工具栏 ---------------- */}
      <div className="p-card">
        <div className="p-row" style={{ justifyContent: 'space-between' }}>
          <div className="p-row">
            <button className="p-btn primary" onClick={() => setDialog({ type: 'create', kind: 'project' })}>＋ 新建项目</button>
            <button className="p-btn primary" onClick={() => setDialog({ type: 'create', kind: 'group' })}>＋ 新建项目组</button>
            <button className="p-btn" onClick={() => setDialog({ type: 'agents' })}>链接名</button>
            <button
              className="p-btn"
              disabled={!s.selProject && !s.selGroup}
              title={s.selProject || s.selGroup ? '把指令发给 AI 客户端' : '先选中一个项目或项目组'}
              onClick={() => setDialog({
                type: 'chain',
                target: s.selProject ?? s.selGroup ?? '',
                kind: s.selProject ? 'project' : 'group',
              })}
            >
              发送到 AI
            </button>
            <button className="p-btn" onClick={() => setDialog({ type: 'settings' })}>设置</button>
            <button className="p-btn" onClick={() => setDialog({ type: 'backup' })}>备份</button>
            <button className="p-btn" onClick={() => setDialog({ type: 'service' })}>服务</button>
            <button className="p-btn" onClick={() => s.refresh()} title="F5">刷新</button>
            <button
              className="p-btn"
              title="摘掉页签里已不存在的路径（F8）"
              onClick={() => void s.clearInvalid()}
            >
              清除无效项
            </button>
            <button className="p-btn" onClick={() => setHelp(true)}>使用说明</button>
          </div>
          <div className="p-row">
            <span className="p-mono p-muted" title={boot.dataDir}>数据：{boot.dataDir}</span>
            <button className="p-btn" onClick={() => s.api.openDataDir().catch((e) => s.pushLog(String(e), true))}>
              打开数据目录
            </button>
            {/* 备份目录分开设置后，两个入口都要能直达；未配置时后端按统一根目录兜底 */}
            <button
              className="p-btn"
              disabled={!boot.config.backupDir && !boot.config.backupProjectDir}
              title={boot.config.backupProjectDir || boot.config.backupDir || '未配置备份目录'}
              onClick={() => openPath(boot.config.backupProjectDir || boot.config.backupDir || '', 'dir')}
            >
              打开项目备份目录
            </button>
            <button
              className="p-btn"
              disabled={!boot.config.backupDir && !boot.config.backupGroupDir}
              title={boot.config.backupGroupDir || boot.config.backupDir || '未配置备份目录'}
              onClick={() => openPath(boot.config.backupGroupDir || boot.config.backupDir || '', 'dir')}
            >
              打开项目组备份目录
            </button>
          </div>
        </div>

        {(s.selProject || s.selGroup) && (
          <div className="p-row" style={{ marginTop: 12 }}>
            <span className="p-muted">已选：</span>
            <span className="p-mono">{s.selProject ?? '—'}</span>
            <span className="p-muted">→</span>
            <span className="p-mono">{s.selGroup ?? '—'}</span>
            <button
              className="p-btn primary"
              disabled={!s.selProject || !s.selGroup || s.busy}
              onClick={() => s.selProject && s.selGroup && s.createLink(s.selProject, s.selGroup)}
            >
              分配项目组（建链）
            </button>
            <button
              className="p-btn"
              disabled={!s.selProject || s.busy}
              onClick={() => s.selProject && s.removeLink(s.selProject)}
            >
              撤销链接
            </button>
          </div>
        )}
      </div>

      {/* ---------------- 三栏 ---------------- */}
      <div className="fpx-cols">
        <Column
          title="项目"
          kind="project"
          tabs={boot.projectTabs}
          cards={projectCards}
          selected={s.selProject}
          onSelect={s.setSelProject}
          onOpen={(p) => openPath(p, 'dir')}
          onMove={(path, i) => s.moveCard('project', path, s.activeTab.project, i)}
          onMoveToTab={(path, tabIndex) => {
            const n = boot.projectTabs[tabIndex]?.items.length ?? 0;
            s.moveCard('project', path, tabIndex, n);
          }}
          onCrossDrop={onCrossDrop}
          thumbs={iconThumbs}
          menus={menus('project')}
          onAdd={() => setDialog({ type: 'pickDir', kind: 'project' })}
          onAddTab={() => s.addTab('project', `页签${(boot.projectTabs.length) + 1}`)}
          onRenameTab={(i, n) => s.renameTab('project', i, n)}
          onRemoveTab={(i) => s.removeTab('project', i)}
          active={s.activeTab.project}
          onTab={(i) => s.setActiveTab((prev) => ({ ...prev, project: i }))}
        />

        <Column
          title="项目组"
          kind="group"
          tabs={boot.groupTabs}
          cards={groupCards}
          selected={s.selGroup}
          onSelect={s.setSelGroup}
          onOpen={(p) => openPath(p, 'dir')}
          onMove={(path, i) => s.moveCard('group', path, s.activeTab.group, i)}
          onMoveToTab={(path, tabIndex) => {
            const n = boot.groupTabs[tabIndex]?.items.length ?? 0;
            s.moveCard('group', path, tabIndex, n);
          }}
          onCrossDrop={onCrossDrop}
          thumbs={iconThumbs}
          menus={menus('group')}
          onAdd={() => setDialog({ type: 'pickDir', kind: 'group' })}
          onAddTab={() => s.addTab('group', `页签${(boot.groupTabs.length) + 1}`)}
          onRenameTab={(i, n) => s.renameTab('group', i, n)}
          onRemoveTab={(i) => s.removeTab('group', i)}
          active={s.activeTab.group}
          onTab={(i) => s.setActiveTab((prev) => ({ ...prev, group: i }))}
        />

        <div className="p-card fpx-col fpx-col-content">
          <h2>内容浏览</h2>
          <ContentPanel
            api={s.api}
            root={s.focusDir}
            items={s.content}
            kind={s.contentKind}
            onKind={s.setContentKind}
            onLog={s.pushLog}
          />
        </div>
      </div>

      {/* ---------------- 链接记录 ---------------- */}
      <div className="p-card">
        <h2>链接记录（{boot.links.length}）</h2>
        <LinkTable
          links={boot.links}
          busy={s.busy}
          onOpen={(row: LinkRow) => openPath(row.project, 'dir')}
          onRemove={(p) => s.removeLink(p)}
        />
      </div>

      {/* ---------------- 日志 ---------------- */}
      <div className="p-card">
        <h2>日志</h2>
        <div className="fpx-log">
          {s.log.length === 0 && <div className="p-muted">（暂无）</div>}
          {s.log.slice(0, 10).map((l, i) => (
            <div key={i} className={l.isError ? 'fpx-log-line err' : 'fpx-log-line'}>
              <span className="p-muted">[{l.at}]</span> {l.text}
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- 弹窗 ---------------- */}
      {dialog.type === 'pickDir' && (
        <DirDialog
          api={s.api}
          title={dialog.kind === 'project' ? '添加项目文件夹' : '添加项目组文件夹'}
          allowCreate
          onClose={() => setDialog({ type: 'none' })}
          onPick={(p) => s.addCard(dialog.kind, p)}
        />
      )}

      {dialog.type === 'create' && (
        <CreateDialog
          api={s.api}
          kind={dialog.kind}
          defaultParent={dialog.kind === 'project' ? boot.config.createProjectDir : boot.config.createGroupDir}
          defaultTemplate={boot.config.createGroupTemplateDir}
          tabName={dialog.kind === 'project'
            ? (boot.projectTabs[s.activeTab.project]?.name ?? '默认')
            : (boot.groupTabs[s.activeTab.group]?.name ?? '默认')}
          hierarchyOn={boot.config.createPathCarriesHierarchy}
          onClose={() => setDialog({ type: 'none' })}
          onCreated={(p) => s.addCard(dialog.kind, p)}
          onLog={s.pushLog}
        />
      )}

      {dialog.type === 'agents' && (
        <LinkAgentDialog
          config={boot.config}
          presetAgents={boot.presetAgents}
          onClose={() => setDialog({ type: 'none' })}
          onSave={(next) => {
            s.updateConfig((d) => {
              d.linkAgents = next.linkAgents;
              d.customLinkAgents = next.custom;
              d.linkAgentRemarks = next.remarks;
              d.linkAgentVendors = next.vendors;
              d.linkAgentRenames = next.renames;
              d.linkAgentsPinned = next.pinned;
            });
          }}
        />
      )}

      {dialog.type === 'lock' && (
        <LockDialog
          path={dialog.card.path}
          denyDelete={dialog.card.denyDelete}
          denyWrite={dialog.card.denyWrite}
          onClose={() => setDialog({ type: 'none' })}
          onApply={(dd, dw) => s.setLock(dialog.card.path, dd, dw)}
        />
      )}

      {dialog.type === 'rename' && (
        <RenameDialog
          card={dialog.card}
          kind={dialog.kind}
          onClose={() => setDialog({ type: 'none' })}
          onSubmit={async (newName) => {
            const r = await s.renameFolder(dialog.kind, dialog.card.path, newName);
            return !!r;
          }}
        />
      )}

      {dialog.type === 'style' && (
        <StyleDialog
          api={s.api}
          path={dialog.card.path}
          icon={dialog.card.icon}
          color={dialog.card.tagColor}
          inherited={dialog.card.tagColorInherited}
          customColors={boot.config.customColors}
          onClose={() => setDialog({ type: 'none' })}
          onApply={(icon, color) => s.saveStyle(dialog.card.path, icon, color)}
          onSaveCustom={(colors) => s.saveCustomColors(colors)}
          onPickIconFile={() => openIconPicker(dialog.card)}
          onLog={s.pushLog}
        />
      )}

      {dialog.type === 'icons' && (
        <IconPickDialog
          api={s.api}
          files={iconFiles}
          groups={boot.config.iconGroups}
          onGroupsChange={(groups) => s.updateConfig((d) => { d.iconGroups = groups; })}
          onClose={() => setDialog({ type: 'none' })}
          onPick={(p) => s.setIcon(dialog.card.path, p)}
          onImported={setIconFiles}
          onLog={s.pushLog}
        />
      )}

      {dialog.type === 'backup' && (
        <BackupDialog
          api={s.api}
          config={boot.config}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch))}
        />
      )}

      {dialog.type === 'editor' && (
        <EditorDialog
          api={s.api}
          config={boot.config}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch))}
        />
      )}

      {dialog.type === 'chain' && (
        <ChainDialog
          api={s.api}
          config={boot.config}
          target={dialog.target}
          kind={dialog.kind}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch))}
        />
      )}

      {dialog.type === 'settings' && (
        <SettingsDialog
          api={s.api}
          config={boot.config}
          dataDir={boot.dataDir}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch))}
        />
      )}

      {dialog.type === 'service' && (
        <ServiceDialog
          api={s.api}
          config={boot.config}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch))}
          onWatchToggled={setWatchOn}
        />
      )}

      {confirmLink && (
        <ConfirmDialog
          title="确认创建链接"
          message={`将为该项目建立指向项目组的链接：\n项目：${confirmLink.project}\n项目组：${confirmLink.group}\n\n可在「设置」里开启「快速链接」跳过此确认。`}
          confirmText="创建链接"
          onConfirm={() => void s.createLink(confirmLink.project, confirmLink.group)}
          onClose={() => setConfirmLink(null)}
        />
      )}

      {help && (
        <HelpDialog onClose={() => setHelp(false)} platform={boot.platform} />
      )}
    </div>
  );
}

/** 一列（项目 / 项目组） */
function Column({
  title, kind, tabs, cards, selected, onSelect, onOpen, onMove, onMoveToTab, onCrossDrop,
  thumbs, menus, onAdd, onAddTab, onRenameTab, onRemoveTab, active, onTab,
}: {
  title: string;
  kind: CardKind;
  tabs: { name: string; items: CardInfo[] }[];
  cards: CardInfo[];
  selected: string | null;
  onSelect: (p: string) => void;
  onOpen: (p: string) => void;
  onMove: (path: string, index: number) => void;
  /** 卡片拖到某个页签上：移动到该页签末尾 */
  onMoveToTab: (path: string, tabIndex: number) => void;
  onCrossDrop: (drag: DragPayload, target: CardInfo | null) => void;
  /** 图标路径 → data URI（自定义图标在沙箱里显示不了，需后端转） */
  thumbs: Record<string, string>;
  menus: (card: CardInfo) => MenuItem[];
  onAdd: () => void;
  onAddTab: () => void;
  onRenameTab: (i: number, n: string) => void;
  onRemoveTab: (i: number) => void;
  active: number;
  onTab: (i: number) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 由「⋯」菜单触发的内联重命名：-1 表示不在编辑
  const [editingTab, setEditingTab] = useState(-1);

  return (
    <div className="p-card fpx-col">
      <div className="p-row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          {title}
          <span className="p-muted" style={{ fontWeight: 400 }}>（{cards.length}）</span>
        </h2>
        <div className="p-row">
          <button className="p-btn" style={{ height: 30, padding: '0 12px' }} onClick={onAdd}>＋ 添加</button>
          <button
            className="p-btn"
            style={{ height: 30, padding: '0 12px' }}
            onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
          >
            ⋯
          </button>
        </div>
      </div>

      <TabBar
        kind={kind}
        tabs={tabs}
        active={active}
        onSelect={onTab}
        onAdd={onAddTab}
        onRename={onRenameTab}
        onRemove={onRemoveTab}
        editing={editingTab}
        onEditingDone={() => setEditingTab(-1)}
        onDropCard={(path, tabIndex) => onMoveToTab(path, tabIndex)}
      />

      <CardGrid
        kind={kind}
        cards={cards}
        selected={selected}
        onSelect={onSelect}
        onOpen={onOpen}
        onMove={onMove}
        onCrossDrop={onCrossDrop}
        menus={menus}
        emptyHint={`还没有${title}，点「＋ 添加」选一个文件夹`}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: '新增页签', onClick: onAddTab },
            // 走 TabBar 的内联输入框，不用浏览器 prompt()（沙箱里样式割裂且体验差）
            { label: '重命名当前页签', onClick: () => setEditingTab(active) },
            { label: '删除当前页签', danger: true, onClick: () => onRemoveTab(active) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function HelpDialog({ onClose, platform }: { onClose: () => void; platform: string }) {
  return (
    <div className="mask" onMouseDown={onClose}>
      <div className="dialog p-card" style={{ width: 560 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2>使用说明</h2>
        <ul className="fpx-help">
          <li><b>分配</b>：把「项目」卡片拖到「项目组」卡片上（或选中两者后点「分配项目组」），
            会在项目目录下为每个启用的 agent 链接名建立指向项目组的链接。</li>
          <li><b>链接名</b>：工具条「链接名」可开关 .opencode / .claude / .codex … 也可加自定义名字。</li>
          <li><b>内容浏览</b>：选中项目组后，右栏列出其 agent / skill / rule（读 <span className="p-mono">agent(s)/ skill(s)/ rules</span> 目录），点条目看内容。</li>
          <li><b>新建</b>：直接创建文件夹并加入页签（项目组可带模板目录）。</li>
          <li><b>保护 / 图标</b>：卡片右键可设 ACL 保护、自定义图标与标签颜色。</li>
          <li><b>数据</b>：独立存于 {platform === 'windows' ? '%APPDATA%' : '应用数据目录'} 下的 <span className="p-mono">project-group/</span>，
            与原 C# 版数据目录互不干扰。</li>
        </ul>
        <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="p-btn primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}
