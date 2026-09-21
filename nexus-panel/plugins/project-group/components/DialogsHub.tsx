import { useMemo, useRef, useState } from 'react';
import { RemoveCardDialog } from './dialogs';
import { RenameDialog } from './RenameDialog';
import { RenameContentDialog } from './RenameContentDialog';
import { CreateDialog, IconPickDialog, LockDialog, StyleDialog } from './dialogs';
import { DirDialog } from './DirDialog';
import { TabManagerDialog } from './TabManagerDialog';
import { ChainConfirmDialog } from './ChainConfirmDialog';
import {
  BackupDialog, ChainDialog, EditorDialog,
} from './ToolsPanel';
import { ConfirmDialog } from './ui';
import { Splitter } from './Splitter';
import { LinkPickDialog } from './LinkPickDialog';
import { errText } from '../api';
import { clampPanelHeight } from '../utils/layout';
import {
  effectiveCombo, formatCombo, GROUP_LABEL, hotkeysByGroup, IS_MAC,
} from '../utils/hotkeys';
/* 「本次不再提示」是**会话级**（模块级变量，关掉软件即恢复），
   刻意不写进 config：写进去等于勾一次就永久关掉，
   等哪天误发一条时根本想不起来是在这里关的。 */
import { setSkipConfirm } from '../utils/confirmOnce';
import type {
  CardInfo, CardKind, ChainAction,
} from '../types';
import type { FpxStore } from '../hooks/useFpx';

/**
 * 弹窗的**全部**形态——集中一处，App 里只留 `<Dialogs .../>` 一行。
 *
 * 为什么集中：此前这 200 行平铺在 App 的 JSX 里，而 App 已经 1599 行。
 * 每加一个弹窗就往里塞一段，于是 App 越长越难读，而弹窗本身
 * 却是**彼此无关**的一堆条件渲染 —— 它们并不共享 App 的其它逻辑，
 * 只是"都挂在根节点下"而已。
 *
 * 依赖确实多（近 20 项），但它们天然属于同一个关注点：
 * "当前打开的是哪个弹窗、点了之后做什么"。
 * 硬拆成"传 5 个 props"的多个小组件反而会变成 props 地狱，
 * 所以这里用一个 props 对象整体接住。
 */
export type Dialog =
  | { type: 'none' }
  /** 选目录加入页签；tabIndex 用于项目组栏堆叠后指定落到哪个分类 */
  | { type: 'pickDir'; kind: CardKind; tabIndex?: number }
  | { type: 'create'; kind: CardKind }
  | { type: 'lock'; card: CardInfo }
  | { type: 'style'; card: CardInfo }
  | { type: 'icons'; card: CardInfo }
  | { type: 'backup' }
  | { type: 'editor' }
  | { type: 'chain'; target: string; kind: CardKind }
  | { type: 'rename'; card: CardInfo; kind: CardKind }
  /** #83 移除卡片：三个"保留"勾选 */
  | { type: 'remove'; card: CardInfo; kind: CardKind }
  /** 搬家：选目标父目录 */
  | { type: 'move'; card: CardInfo; kind: CardKind }
  /** 内容区条目改名 */
  | { type: 'renameContent'; path: string; name: string }
  /** 页签统一管理（#23） */
  | { type: 'tabManager' };

/**
 * 是否 macOS。键位提示要按平台显示 ⌘ 还是 Ctrl。
 *
 * **必须与 App 里那份是同一个**：两份各自算的话，工具栏按钮与说明弹窗
 * 可能一个显示 ⌘ 一个显示 Ctrl —— 用户照着其中一个按却没反应。
 * 所以从 App 导出，这里引入，不抄第二份。
 */


/** 侧边栏 / 快捷键入口的待确认发送（#43） */
export interface PendingSend {
  actionId: string;
  kind: CardKind;
  path: string;
  text: string;
  skip: boolean;
}

export interface DialogsProps {
  s: FpxStore;
  dialog: Dialog;
  setDialog: (d: Dialog) => void;
  /** 执行搬家：选完目标目录后调用（含监控器抑制，见 App） */
  doMove: (card: CardInfo, kind: CardKind, dest: string) => void;
  /** 内容区条目改名 */
  doRenameContent: (path: string, name: string) => void;
  /** 连锁动作清单：确认弹窗要显示动作名 */
  chainActions: ChainAction[];
  pendingSend: PendingSend | null;
  setPendingSend: (p: PendingSend | null) => void;
  /** 建链前选名字（项目 → 项目组） */
  confirmLink: { project: string; group: string } | null;
  setConfirmLink: (v: { project: string; group: string } | null) => void;
  /** 删分类前的二次确认 */
  confirmRemoveTab: { kind: CardKind; index: number; message: string } | null;
  setConfirmRemoveTab: (v: null) => void;
  /** 使用说明浮层 */
  help: boolean;
  setHelp: (v: boolean) => void;
  /** 说明浮层的高度（布局记忆 #56）与其保存回调 */
  tipsHeight: number | null;
  saveLayout: (patch: Record<string, unknown>) => void;
  openIconPicker: (card: CardInfo) => Promise<void>;
  iconFiles: string[];
  setIconFiles: (v: string[]) => void;
}

export function Dialogs(props: DialogsProps) {
  const { s } = props;
  /*
   * **`boot` 不解构**（原写法 `const { ctx, boot } = s`）：
   * TypeScript 不会把 `s.boot` 的判空窄化传递到已解构出来的局部变量上，
   * 于是下面每一处 `boot.xxx` 都报"可能为 null"（共 19 处）。
   * 改成局部常量后，判空一次即可全程窄化。
   */
  const { ctx } = s;
  const boot = s.boot;

  /*
   * #8 图标面板的目标跟随（原版 `UpdateTarget`）。
   *
   * 默认**跟随**：这是非模态常驻的全部意义 ——
   * 开着面板点下一张卡片，图标就设到那张上，不用来回开关弹窗。
   *
   * 还要给"锁定"是因为：连续给同一张卡试几个图标时，
   * 点到别的卡片就换目标会很恼人。锁定后目标固定。
   */
  const [iconFollow, setIconFollow] = useState(true);

  const {
    dialog,
    setDialog,
    doMove,
    doRenameContent,
    chainActions,
    pendingSend,
    setPendingSend,
    confirmLink,
    setConfirmLink,
    confirmRemoveTab,
    setConfirmRemoveTab,
    help,
    setHelp,
    tipsHeight,
    saveLayout,
    openIconPicker,
    iconFiles,
    setIconFiles,
  } = props;

  const selPath = s.selProject ?? s.selGroup;
  /*
   * 找出当前选中卡片的 CardInfo。
   *
   * 跟随模式下 `dialog.card` 是**打开面板那一刻**的那张，已经过期 ——
   * setIcon 必须用选中卡片的路径，否则跟随只是"显示跟着变"，
   * 实际图标仍设到打开时的那张上。**显示与目标不一致**比不跟随更糟。
   */
  const selCard = useMemo(() => {
    /* 这里判的是 `boot` 而不是 `s.boot`：它在 hooks 区（早退之前），
       拿不到下面的窄化，所以必须自己判一次 */
    if (!selPath || !boot) return null;
    const all = [...(boot.projectTabs ?? []), ...(boot.groupTabs ?? [])];
    return all.flatMap((t) => t.items ?? []).find((c) => c.path === selPath) ?? null;
  }, [selPath, boot]);

  /* 跟随且选中已变 → 用选中的；否则用打开时那张（含锁定、以及选中为空的情况） */
  /*
   * 括号**不能省**（原写法漏了内层括号，是真崩溃，不只是类型报错）：
   *
   *   selCard?.path ?? dialog.type === 'icons' ? dialog.card.path : ''
   *
   * `??` 优先级高于 `?:`，于是被解析成
   *   (selCard?.path ?? (dialog.type === 'icons')) ? dialog.card.path : ''
   * 条件变成"路径字符串"本身：只要**选中了卡片**（不管当前开的什么弹窗），
   * 条件就为真 → 去取 `dialog.card.path` → 而 dialog 多半是 `{type:'none'}`
   * → undefined.path → 整个组件渲染就崩（白屏）。
   *
   * 也就是说：默认跟随 + 选中任意卡片 + 没开图标弹窗 = 必崩。
   * 类型检查只是把它报成了"Dialog 上没有 card"，根因在这里。
   * 下一行 iconTargetName 一直有这对括号，所以只有这一行出问题。
   */
  const iconTargetPath = iconFollow
    ? (selCard?.path ?? (dialog.type === 'icons' ? dialog.card.path : ''))
    : (dialog.type === 'icons' ? dialog.card.path : '');
  const iconTargetName = iconFollow ? (selCard?.name ?? (dialog.type === 'icons' ? dialog.card.name : '')) : (dialog.type === 'icons' ? dialog.card.name : '');

  /*
   * 放在**所有 hooks 之后**（hooks 不能在条件之后调用，否则顺序会变）：
   * boot 为 null 时这些弹窗本来也没有可渲染的内容 —— 每个弹窗都要读
   * boot.config，硬撑着渲染只会拿到 undefined 再炸在更深的地方。
   */
  if (!boot) return null;

  return (
    <>
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

      {dialog.type === 'lock' && (
        <LockDialog
          path={dialog.card.path}
          denyDelete={dialog.card.denyDelete}
          denyWrite={dialog.card.denyWrite}
          /* #21 账面固定：与 ACL 是两件事，单独传 */
          accountOnly={dialog.card.accountFixed}
          onClose={() => setDialog({ type: 'none' })}
          onApply={(dd, dw, ao) => s.setLock(dialog.card.path, dd, dw, ao)}
          /* #23 弹窗内的监控告警开关。
             用 updateConfig 而不是 setLock：后者是"保护"这一件事，
             监控是全局配置，混进去会让一次操作产生两种语义。 */
          watchEnabled={boot.config.watchEnabled}
          onWatchChange={(on) => s.updateConfig((d) => { d.watchEnabled = on; })}
        />
      )}

      {/* #83 移除卡片：先问保留什么，再真的移除 */}
      {dialog.type === 'remove' && (
        <RemoveCardDialog
          card={dialog.card}
          kind={dialog.kind}
          onClose={() => setDialog({ type: 'none' })}
          onConfirm={(keep) => {
            const idx = (dialog.kind === 'group'
              ? (s.boot?.groupTabs ?? []).findIndex(
                (t) => (t.items ?? []).some((c) => c.path === dialog.card.path),
              )
              : undefined);
            void s.removeCardFull(
              dialog.kind, dialog.card.path,
              idx === undefined || idx < 0 ? null : idx, keep,
            );
          }}
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

      {dialog.type === 'move' && (
        <DirDialog
          api={s.api}
          title={`选择「${dialog.card.name}」的新位置（搬家）`}
          allowCreate
          onClose={() => setDialog({ type: 'none' })}
          onPick={(p) => {
            setDialog({ type: 'none' });
            void doMove(dialog.card, dialog.kind, p);
          }}
        />
      )}

      {dialog.type === 'renameContent' && (
        <RenameContentDialog
          name={dialog.name}
          onClose={() => setDialog({ type: 'none' })}
          onSubmit={async (n) => {
            await doRenameContent(dialog.path, n);
            return true;
          }}
        />
      )}

      {/* 侧边栏 / 快捷键入口的发送确认（#43）。
          这两个入口比面板更顺手、也更容易误触，反而更需要确认 ——
          若只在面板里确认，从侧边栏发就完全绕过了。 */}
      {pendingSend && (
        <ChainConfirmDialog
          actionName={chainActions.find((a) => a.id === pendingSend.actionId)?.name ?? pendingSend.actionId}
          clientName={boot?.config.chainClient || 'opencode'}
          text={pendingSend.text}
          busy={false}
          onCancel={() => setPendingSend(null)}
          onConfirm={(finalText, skip) => {
            if (skip) setSkipConfirm(true);
            const { actionId, kind, path } = pendingSend;
            setPendingSend(null);
            void s.api.chainSendAction(actionId, kind, path, finalText || null).then(
              (r) => { s.pushLog(r.message, !r.ok); ctx.toast(r.message, r.ok ? 'ok' : 'err'); },
              (e) => {
                const msg = `发送失败：${errText(e)}`;
                s.pushLog(msg, true);
                ctx.toast(msg, 'err');
              },
            );
          }}
        />
      )}

      {dialog.type === 'tabManager' && (
        <TabManagerDialog
          projectTabs={boot.projectTabs}
          groupTabs={boot.groupTabs}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          onAdd={(kind, name) => s.addTab(kind, name)}
          onRename={(kind, i, n) => s.renameTab(kind, i, n)}
          onRemove={(kind, i) => s.removeTab(kind, i)}
          onMove={(kind, from, to) => s.moveTab(kind, from, to)}
          onCheck={(kind, i) => s.tabRemoveCheck(kind, i)}
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
          /* #13/#113 第三个参数透传 guiOnly */
          onApply={(icon, color, gui) => s.saveStyle(dialog.card.path, icon, color, gui)}
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
          /* 非模态常驻（#8）：开着也能点背后的卡片 */
          modeless
          target={{ path: iconTargetPath, name: iconTargetName }}
          following={iconFollow}
          onFollowChange={setIconFollow}
          /* #13 第二个参数传 guiOnly：决定写哪一套 */
          onPick={(p, g) => s.setIcon(iconTargetPath, p, undefined, g)}
          onImported={setIconFiles}
          /* #10 改名：后端返回的图标列表要替换掉本地的，
             否则界面还显示旧文件名（文件已经不在那个名字下了）。 */
          onRenamed={(icons) => setIconFiles(icons)}
          onLog={s.pushLog}
        />
      )}

      {dialog.type === 'backup' && (
        <BackupDialog
          api={s.api}
          config={boot.config}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          // 备份要遍历整棵树，好几秒。这期间磁盘上的配置可能已被改过
          // （MCP server 直接写文件，不经前端），所以存之前重读一次再改。
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch), { fresh: true })}
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

      {confirmLink && (
        <LinkPickDialog
          project={confirmLink.project}
          group={confirmLink.group}
          config={boot.config}
          allNames={boot.allNames ?? []}
          links={boot.links ?? []}
          onConfirm={(names) => {
            setConfirmLink(null);
            /* #200 走 sync 而不是 create：取消勾选的名字要真的删掉、释放名字。
               用 create 的话它们会留在磁盘上，界面仍显示已链接。 */
            void s.syncLinks(confirmLink.project, confirmLink.group, names);
          }}
          onClose={() => setConfirmLink(null)}
        />
      )}

      {confirmRemoveTab && (
        <ConfirmDialog
          title="删除分类"
          message={confirmRemoveTab.message}
          confirmText="删除"
          danger
          onConfirm={() => void s.removeTab(confirmRemoveTab.kind, confirmRemoveTab.index)}
          onClose={() => setConfirmRemoveTab(null)}
        />
      )}

      {help && (
        <HelpDialog onClose={() => setHelp(false)} platform={boot.platform}
          hotkeys={boot.config.hotkeys}
          height={tipsHeight}
          onHeightCommit={(h) => saveLayout({ tipsPanelHeight: h })} />
      )}
    </>
  );

}

/**
 * 使用说明（F1，#222 ToggleTips）。
 *
 * 键位表**从注册表动态生成**，不手抄一份：抄的那份改天就与实际键位脱节
 * —— README 里出现过「MCP 工具写 13 个、实际 24 个」这类漂移，根因就是手写。
 * 与设置面板共用同一个 HOTKEYS，用户改过键位这里也跟着变。
 */
function HelpDialog({
  onClose, platform, hotkeys, height, onHeightCommit,
}: {
  onClose: () => void;
  platform: string;
  hotkeys?: Record<string, string> | null;
  /** 高度记忆（#56 tipsPanelHeight）。null = 自适应 */
  height?: number | null;
  onHeightCommit?: (h: number) => void;
}) {
  /* 拖动中的高度 + 起点快照（相对起点算总位移，避免逐帧累加漂移） */
  const baseRef = useRef(height ?? 0);
  const [dragH, setDragH] = useState<number | null>(null);
  const shownH = dragH ?? height ?? null;

  return (
    <div className="mask" onMouseDown={onClose}>
      <div
        className="dialog p-card"
        style={{
          width: 560,
          // 拖过之后是固定高度；没拖过就保留自适应（不加 height 只加 maxHeight）
          ...(shownH ? { height: shownH, overflow: 'auto' } : { maxHeight: '86vh' }),
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>使用说明</h2>
        <ul className="fpx-help">
          <li><b>分配</b>：把「项目」卡片拖到「项目组」卡片上（或反向拖），
            会在项目目录下为每个启用的 agent 链接名建立指向项目组的链接。
            建链只有拖放这一条路，没有按钮。</li>
          <li><b>撤销链接</b>：在「项目」卡片上右键 →「撤销链接」。</li>
          <li><b>链接名 / 服务 / 基础设置</b>：都在外壳右上角的「⚙ 设置」里（重载按钮左侧）——
            链接名开关、MCP 与目录监听、备份与交互选项等。</li>
          <li><b>内容浏览</b>：选中项目组后，右栏列出其 agent / skill / rule（读 <span className="p-mono">agent(s)/ skill(s)/ rules</span> 目录），点条目看内容。</li>
          <li><b>新建</b>：直接创建文件夹并加入页签（项目组可带模板目录）。</li>
          <li><b>保护 / 图标</b>：卡片右键可设 ACL 保护、自定义图标与标签颜色。</li>
          <li><b>数据</b>：独立存于 {platform === 'windows' ? '%APPDATA%' : '应用数据目录'} 下的 <span className="p-mono">project-group/</span>，
            与原 C# 版数据目录互不干扰。</li>
          <li><b>快捷键</b>：栏目标题上标「焦点」的那栏就是键盘操作的对象（Ctrl/⌘+←/→ 切换，或点该栏卡片）。
            打字时不触发；有弹窗打开时整组让路，但开关类（使用说明 / MCP / 收起左栏）例外。</li>
        </ul>

        <div className="fpx-help-keys">
          {hotkeysByGroup().map((g) => (
            <div className="fpx-help-keygroup" key={g.group}>
              <div className="fpx-help-keytitle">{GROUP_LABEL[g.group]}</div>
              <table>
                <tbody>
                  {g.items.map((h) => (
                    <tr key={h.id}>
                      <td>{h.label}</td>
                      <td className="p-mono">
                        {formatCombo(effectiveCombo(h.id, hotkeys), IS_MAC)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-4, 8px)' }}>
          键位可在「设置 → 快捷键」里改。
        </div>
        <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-8, 16px)' }}>
          <button className="p-btn primary" onClick={onClose}>知道了</button>
        </div>

        {/* 底边拖动把手（#56）：只有记住了高度才渲染 ——
            自适应状态没有"当前高度"这个基准，拖了存什么都不对 */}
        {height != null && onHeightCommit && (
          <Splitter
            dir="vertical"
            ariaLabel="调整使用说明面板高度"
            onDelta={(d) => setDragH(clampPanelHeight(baseRef.current + d) ?? baseRef.current)}
            onEnd={() => {
              const next = dragH;
              setDragH(null);
              if (next != null) {
                baseRef.current = next;
                onHeightCommit(next);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
