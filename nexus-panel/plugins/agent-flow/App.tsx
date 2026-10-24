import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, useReactFlow,
  type Connection, type Edge, type NodeTypes, type EdgeTypes, type ReactFlowInstance,
  type NodeChange, SelectionMode } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Inspector from './components/Inspector';
// 副作用导入：把 nodes/defs/ 下的节点定义注册进表。
// 放在这里是刻意的 —— 注册表必须先被填充，下面的 buildNodeTypes() 才有内容。
import { buildNodeTypes, getDef, allPresets, type NodeDef } from './nodes';
import { ParamEdge } from './components/ParamEdge';
import {
  parseArgHandle, parseOutHandle, makeParamEdge, isParamEdge,
  linkHintOf, paramLinksOf, paramLinkIssues, normalizeParamEdges,
} from './engine/paramLinks';
import { getVariableGroup } from './nodes/registry';
import {
  applyVarTo, findVar, checkVarForNode, duplicateVar, varSnapshotOf,
} from './engine/variables';
import {
  VAR_DRAG_MIME, decodeVarDrag,
} from './components/inspectors/VariablePicker';
import {
  duplicateElements, stripRuntime, type DupNode, type DupEdge,
} from './engine/duplicate';
import { CredentialPanel, canUse } from './components/CredentialPanel';
import { BoardMetaPanel } from './components/BoardMetaPanel';
// 卡片上的参数格要能就地改，得拿到 App 的 patchNode ——
// 卡片是经 nodeTypes 交给 xyflow 渲染的，不是 App 的直接子组件，只能走 Context
import { NodePatchProvider } from './components/ArgCell';
import { useCredentialVault, VAULT_MODE_META, CRED_KEY } from './hooks/useCredentialVault';
import { useStackLayout } from './hooks/useStackLayout';
import { useTaskStore } from './hooks/useTaskStore';
import { useMcpRegistry } from './hooks/useMcpRegistry';
import { useDeleteUndo } from './hooks/useDeleteUndo';
import { useExportFlow } from './hooks/useExportFlow';
import {
  type Credential, type CredentialKind, makeCredential,
  pickFor, needsOf, kindForNeed, missingCapabilities, resolveSecret,
} from './engine/credentials';
import { migrateLlmToCredentials } from './engine/llmCredential';
import {
  verifyToken, fetchUpdate, pushFiles, type Fetcher as GithubFetcher,
} from './engine/github';
import {
  parseStore, serializeStore, encryptStore, decryptStore, newDeviceSalt,
  collectDeviceSignals, defaultBackend, type StoredFile, type VaultMode,
} from './engine/credentialStore';
import { checkChannel, type ChannelStatus } from './lib/channel';
import { deviceSeed, clearKeyCache } from './engine/crypto';
import {
  newOsKeyringKey, planOsKeyringStart, judgeOsKeyringWrite,
} from './engine/osKeyring';
import { osKeyringGet, osKeyringSet, osKeyringDelete } from './lib/tauri';
import Sidebar, { DRAG_MIME, decodeDrag, type DragPayload } from './components/Sidebar';
import { prompt } from '../../js/dialog.js';
import DirPicker from './components/DirPicker';
import {
  LEFT_TABS, LEFT_TAB_LABEL,
  TASK_TABS, TASK_TAB_LABEL, TASK_VIEWS, TASK_VIEW_LABEL,
  RIGHT_TABS, RIGHT_TAB_LABEL,
  normalizeLeftTab, normalizeTaskTab, normalizeTaskView, normalizeRightTab, leftTabsFor,
} from './engine/layout';
import type { LeftTab, TaskTab, TaskView, RightTab } from './engine/layout';
import { defaultKV as kvStore } from './engine/kv';
import {
  writeTextFile, fsAllowRoot, listFsRoots, canExportToFile,
} from './lib/tauri';
import ModuleLibrary, {
  MODULE_DRAG_MIME, decodeModuleDrag, askCreateModule,
} from './components/ModuleLibrary';
import { expandCanvasRefs } from './engine/canvasRef';
import { syncCanvasesRefNames, snapshotCanvasName } from './engine/canvasRefName';
import {
  collectGlobalTriggers, activeTriggers, dedupeWatchDirs, isActiveTrigger,
  collectBuriedTriggers, type GlobalTrigger, type BuriedTrigger,
} from './engine/triggerRegistry';
import { ERR_NO_TRIGGER, reachableFrom } from './engine/triggerScope';
import {
  loadGroups, saveGroups, pruneGroupsIfChanged, dropEmptyGroups,
  nextGroupName, addToGroup, removeFromGroup,
  type CanvasGroup,
} from './engine/canvasGroups';
import CanvasLibrary from './components/CanvasLibrary';
import {
  expandModules, findModule, addModule, saveModules, loadModules,
  stripRuntimeNodes, packSelection, canPack, type ModuleDef,
  moduleEdgesToFlow, flowEdgesToModule,
} from './engine/modules';
import {
  stackEdges, descendantsOf, chainTopOf, chainOf,
  parentIdOf, movedEnough, heightOf, STACK_GAP, stackParentIds,
  planStackDrop, planStackReflow, measureHeights,
} from './engine/stack';
import {
  fitFrames, isFrameNode, frameMemberIds, selectionWithFrames,
  frameDelta, makeFrame,
} from './engine/frames';
import { withDefault } from './engine/nodeDefaults';
import { isPaneNode, paneMembersOf, findPane, resolveTaskPane } from './engine/pane';
import { specOf, canConnect } from './engine/nodeSpec';
import { getDefByDataKind } from './nodes/registry';
import CanvasTabs from './components/CanvasTabs';
import { TaskList } from './components/TaskPanel';
import { TaskDetail } from './components/TaskDetail';
import { HistoryList } from './components/HistoryPanel';
import { TaskTable } from './components/TaskTable';
import { BoardTree } from './components/TaskBoard';
import { AttachPanel } from './components/AttachPanel';
import { useAttachments } from './hooks/useAttachments';
import { useBoardMeta } from './hooks/useBoardMeta';
import { addAttachment, removeAttachment } from './engine/attachmentStore';
// 别名：下面有个同名的交互回调 toggleTag(taskId, tagId)，直接导入会自己调自己
import { toggleTag as toggleBoardTag } from './engine/taskBoard';
import { addTag } from './engine/boardMeta';
import { TaskBoardDetail } from './components/TaskBoardDetail';
import { useTaskBoard } from './hooks/useTaskBoard';
import {
  addNode, removeNode, mergeIntoGroup, splitTask,
} from './engine/taskBoard';
import { parseRowKey, type TableRow } from './engine/taskTable';
import {
  parseScopeKey, scopeKeyOf, normalizeScope, scopeOptions, scopeLabel,
  buildProjectIndex, filterByScope, scopeMatches, type ProjectScope,
} from './engine/projectScope';
import {
  parseHistory, serializeHistory, addToHistory, removeFromHistory,
  clearCanvasHistory, emptyHistory, HISTORY_STORE_KEY, type HistoryEntry,
} from './engine/history';
import {
  makeTask, applyEvent, finishTask, cancelTask, clampOutput,
  type TaskRecord, type TaskSource,
} from './engine/tasks';
import {
  runGraph,
  type Executor, type FsExecutor, type Fetcher, type LlmCaller, type ImageReader,
  type GithubUpdateRunner, type GithubPushRunner, type HttpRequester,
  type RunEvent, type RunSummary,
} from './engine/runner';
import { TriggerScheduler } from './engine/triggers';
import type { CanvasConfig } from './engine/canvasConfig';
import { type CanvasParam, migrateEnvVars, paramRefsOfNodes, paramRunValue } from './engine/canvasParams';
import {
  makeCanvas, nextCanvasName, renameCanvas, removeCanvas, nextActiveId,
  updateCanvasContent, updateCanvasConfig, canvasConfigOf, sortForDisplay, toMeta,
  loadFromStorage, saveToStorage, STORAGE_KEYS,
  type Canvas,
  redactNodes, redactCanvasConfig, normalizeCanvasConfig,
} from './engine/canvasStore';
import {
  parseKeywords, parseMessages, matchKeywords, takeNew, newSeenState,
  type SeenState, type KeywordHit,
} from './engine/conversations';
import { CLI_META, DEFAULT_TRIGGER_CONFIG, DEFAULT_BRANCH, type TaskNodeData, makeNode, makeConditionNode, makeParallelNode, makeTriggerNode,
  makeLoopNode, makeFsNode, makeUpdateNode, makeOcrNode, makeTranslateNode,
  makeGithubUpdateNode, makeGithubPushNode,
  isTrigger, isLoop, isOcr, isTranslate, triggerKindsOf, type CliKind, type FsNodeData,
  type Graph, type NodeData, type Trigger, type TriggerKind, type TriggerConfig } from './types';
import type { FlowEdge, FlowNode } from './flowTypes';
import { killCli, runCli, canWatch, startWatch, canWebhook, startWebhook,
  fileOp, fsArgsOf, fetchText, httpRequest, postJson, readImageDataUrl, readAudioDataUrl,
  fetchDeviceSalt, tailFile, type FsArgs } from './lib/tauri';

/**
 * 画布的节点组件映射。
 *
 * 以前这里手工列一张表，加一种节点要同时改这里 —— 漏改的话该节点
 * 会退化成 xyflow 的默认节点（能拖动但内容全空），且不报错。
 * 现在从注册表构建，与侧栏、属性面板、执行引擎共用同一份声明。
 */
const nodeTypes: NodeTypes = buildNodeTypes();

/**
 * 边的组件映射。
 *
 * 参数连线必须注册自己的组件 —— 它要画成虚线 + 紫 + 箭头，
 * 与流程连线的绿实线区分开。不注册的话 xyflow 走默认边，
 * 两种线长得一样，"这根是供参数还是走流程"就得靠猜。
 */
const edgeTypes: EdgeTypes = { param: ParamEdge };

const STORAGE_KEY = 'agent-flow:v1';
const TRG_KEY = 'agent-flow:triggers:v1';

const DEFAULT_CMD: Record<CliKind, string> = { traecli: 'traecli', codebuddy: 'codebuddy' };


/** 把条件节点的出口 handle id 转成边上显示的分支名 */
function branchLabel(nodes: FlowNode[], sourceId: string, branch?: string | null): string | undefined {
  if (!branch) return undefined;
  const src = nodes.find((n) => n.id === sourceId);
  if (!src) return branch;
  const data = src.data as { rules?: { id: string; label: string }[] };
  if (branch === DEFAULT_BRANCH) return '兜底';
  return data.rules?.find((r) => r.id === branch)?.label ?? branch;
}

/**
 * 把未知类型的异常变成一句能看的话。
 *
 * 各处 catch 拿到的可能是 Error、字符串、或 Rust 侧透传的对象
 * （形如 { error: 'xxx' }）。直接 `${err}` 会打出 [object Object]，
 * 用户看了也不知道哪里错了。
 */
function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = (err as Record<string, unknown>).error;
    if (typeof e === 'string' && e) return e;
    const m = (err as Record<string, unknown>).message;
    if (typeof m === 'string' && m) return m;
  }
  return String(err);
}

/** 首次使用时的示例画布 */
function makeSeedCanvas(): Canvas {
  return makeCanvas('工作流 1', {
    nodes: [
      { id: 'write', position: { x: 60, y: 140 }, type: 'task',
        data: makeNode('write', { label: '写脚本', cli: 'codebuddy',
          prompt: '写一个备份 PostgreSQL 的 bash 脚本，带日期后缀和错误处理' }).data } as FlowNode,
      { id: 'review', position: { x: 420, y: 140 }, type: 'task',
        data: makeNode('review', { label: '审查脚本', cli: 'traecli',
          prompt: '审查下面这段脚本的安全性与健壮性，逐条给出行号和问题:\n{{write.output}}' }).data } as FlowNode,
    ],
    edges: [{ id: 'write->review', source: 'write', target: 'review' }],
  });
}

/** 载入：优先读多画布格式，没有则把旧版单画布数据迁进来 */
function loadCanvases(): { canvases: Canvas[]; activeId: string | null } {
  const st = loadFromStorage((k) => localStorage.getItem(k));
  if (st.canvases.length > 0) return { canvases: st.canvases, activeId: st.activeId };

  // 兼容旧版：把以前保存的单一画布迁成第一个工作流
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p.nodes) && p.nodes.length > 0) {
        const migrated = makeCanvas('工作流 1', { nodes: p.nodes, edges: p.edges ?? [] });
        return { canvases: [migrated], activeId: migrated.id };
      }
    }
  } catch { /* 旧数据损坏则忽略 */ }

  const seed = makeSeedCanvas();
  return { canvases: [seed], activeId: seed.id };
}


/**
 * 外观模式：原生（固定 Agent Flow 自己的样式） / 跟随（用面板主题）
 * 默认跟随 —— 而"Agent Flow 深色"主题的变量值与原生逐像素相同，
 * 所以默认观感 = 原生，同时切到别的主题会自动变色。
 */
const THEME_MODE_KEY = 'af:theme-mode';
type ThemeMode = 'native' | 'follow';

function readThemeMode(): ThemeMode {
  try {
    return localStorage.getItem(THEME_MODE_KEY) === 'native' ? 'native' : 'follow';
  } catch { return 'follow'; }
}

function applyThemeMode(mode: ThemeMode) {
  document.documentElement.dataset.afMode = mode;
  try { localStorage.setItem(THEME_MODE_KEY, mode); } catch { /* 忽略 */ }
}



export default function App() {
  const init = useMemo(loadCanvases, []);
  /*
   * 老画布迁移：把节点上内联的大模型配置收进凭据。
   *
   * ------------------------------------------------------------------
   * 为什么放在这里而不是 effect
   * ------------------------------------------------------------------
   *
   * 凭据是异步解密的（可能要等口令），effect 里跑会与解密竞态 ——
   * 解密完成前跑，凭据列表是空的，于是每个节点各建一条重复凭据。
   *
   * 放在凭据落地的那一刻（switchMode / 解锁 之后）跑，凭据必然已就位。
   * 且它幂等，多跑一次也不会多出凭据。
   */
  const [canvases, setCanvases] = useState<Canvas[]>(init.canvases);
  /*
   * canvases 的只读镜像。
   *
   * 迁移要读"当前画布"，但把它放进 useCallback 的依赖会让回调每次改画布就重建，
   * 进而让所有依赖它的 effect 反复重注册。用 ref 读最新值，依赖保持为空。
   */
  const canvasesRef = useRef<Canvas[]>(init.canvases);
  canvasesRef.current = canvases;
  const [activeId, setActiveId] = useState<string | null>(init.activeId);




  const active = canvases.find((c) => c.id === activeId) ?? null;

  /*
   * 当前画布的参数表（{{params.名字}} 的取值来源）。
   *
   * env.vars 是旧称 —— 界面上承诺过 {{env.NAME}} 可用但从未实现，
   * 这里一并搬进 params，老存档里填过的值不会丢。
   */
  const activeParams: CanvasParam[] = useMemo(
    () => migrateEnvVars(active?.config?.params, active?.config?.env?.vars),
    [active?.config?.params, active?.config?.env?.vars],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(
    (active?.nodes ?? []) as FlowNode[],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    (active?.edges ?? []) as FlowEdge[],
  );

  /*
   * 画布上模块节点引用到的参数名。
   *
   * 必须单独算：模块内部节点平时不在 nodes 里（只有运行时才展开），
   * 画布侧扫不到 —— 而"刚把模块拖进来、还没填参数"恰恰最该提醒。
   */
  const moduleParamRefs = useMemo(() => {
    const out = new Set<string>();
    for (const n of nodes) {
      const d = (n.data ?? {}) as Record<string, unknown>;
      if (String(d.kind ?? d.type ?? '') !== 'module') continue;
      const def = findModule(String(d.moduleId ?? ''));
      for (const name of def?.paramRefs ?? []) out.add(name);
    }
    return [...out].sort();
  }, [nodes]);


  const [selectedId, setSelectedId] = useState<string | null>(null);

  /*
   * 删除 + 撤销删除。
   *
   * App.tsx 往下拆的第五块。放在 nodes / edges / selectedId 与三个 setter
   * **都就位之后** —— 少一个都拿不到，而提前调用会撞 TDZ。
   */
  const {
    undoSnap, deleteNotice, setDeleteNotice,
    beforeDelete, undoDelete, handleNodesDelete, clearUndo,
  } = useDeleteUndo({
    nodes, edges, selectedId, setNodes, setEdges, setSelectedId,
  });

  /**
   * 切换画布时同步 React Flow 的内容。
   *
   * 用 ref 记录"已同步到哪个画布"，只在 activeId 真正变化时才同步。
   * 不能直接依赖 active 对象：每次内容保存都会产生新的 canvas 对象，
   * 那样会 setNodes → 触发保存 → 又产生新对象 → 无限循环。
   */
  const lastSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId) return;
    if (lastSyncedRef.current === activeId) return;
    lastSyncedRef.current = activeId;
    const c = canvases.find((x) => x.id === activeId);
    setNodes((c?.nodes ?? []) as FlowNode[]);
    setEdges((c?.edges ?? []) as FlowEdge[]);
    setSelectedId(null);
    // 撤销快照属于上一张画布，带过去会把别处的内容恢复过来
    clearUndo();
  }, [activeId, canvases, setNodes, setEdges, clearUndo]);

  /** 画布内容变化后写回（防抖，避免拖动时每帧都存） */
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    // 刚切换、还没同步完时不落盘，否则会把上一个画布的内容写进新画布
    if (!activeId || lastSyncedRef.current !== activeId) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      setCanvases((cs) => updateCanvasContent(cs, activeId!, { nodes, edges }));
    }, 400);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    /*
     * 依赖里**不能**放 canvases。
     *
     * 放了的后果：本 effect 写回内容 → canvases 变新引用 → 依赖变化 →
     * 本 effect 重跑 → 400ms 后再写回 → ……
     * 无限循环，表现为空闲时每 400ms 全量序列化并写一次 localStorage。
     *
     * 不放也不影响正确性：写回用的是函数式更新 (cs) => ...，
     * 读的是 setCanvases 内部的最新值，用不着外层的 canvases。
     * （updateCanvasContent 现在是幂等的，内容没变就返回原数组，
     *  双重保险 —— 即便将来谁把 canvases 加回来，循环也不会起来。）
     */
  }, [nodes, edges, activeId]);

  /** 持久化整个多画布状态 */
  useEffect(() => {
    saveToStorage((k, v) => localStorage.setItem(k, v), { canvases, activeId });
  }, [canvases, activeId]);


  /*
   * 跨画布定位：先切画布，等节点就位再滚过去。
   *
   * 不缓一帧的话，`nodes` 还是**旧画布**的那一份 ——
   * 拿旧节点的位置去 setCenter，会滚到一个根本不存在的坐标上，
   * 表现为"点了定位但画布没动"。
   */
  const pendingLocate = useRef<{ canvasId: string; nodeId: string } | null>(null);
  const [running, setRunning] = useState(false);

  /* ---------------- 任务窗口 ---------------- */
  /**
   * 只保留本次会话的记录，不落盘 ——
   * 跨会话的历史归"历史窗口"管，那个后面单独做。
   */
  /*
    条数不设上限 —— 数百个任务并发时要能全部看到。
    渲染压力交给任务窗口的虚拟滚动（只画视口内的行），
    这里不做人为截断，否则"刚跑完的被挤掉了"会让人以为任务丢了。
  */
  /*
   * 只剩「流程 / 任务」两个顶层视图。
   *
   * 历史改成任务视图下的一个子标签（「已完成」）—— 它与任务的区别
   * 只是"跑完没跑完"，却占了一个与流程平级的位置，
   * 于是找一条刚跑完的记录要先想"它现在算任务还是算历史"。
   */
  const [view, setView] = useState<'flow' | 'tasks'>('flow');
  /*
   * 任务列表 + 跨会话历史归档。
   *
   * App.tsx 往下拆的第三块。选中项必须同源 ——
   * 列表在左栏、详情在中间，是两个组件，各自记住就会"点了没反应"。
   */
  const ts = useTaskStore();
  const {
    tasks, setTasks, currentTaskRef, tick,
    history, historyFile, histWarn, saveHistory, historyRef,
    taskSel, setTaskSel, histSel, setHistSel,
  } = ts;





  const [log, setLog] = useState<string[]>([]);

  /*
   * 日志区现在**一直可见**（右栏下半部分），
   * 所以不再需要"出错时自动切过去"—— 报错藏不起来，也就没有切的动作。
   */
  const pushLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLog((l) => [`${ts} ${msg}`, ...l].slice(0, 100));
  }, []);

  /*
   * MCP 服务库 + 工具节点刷新。
   *
   * App.tsx 往下拆的第四块。放在 pushLog **之后** ——
   * 刷新要用它把结果报进日志，而那是 const，提前调用撞 TDZ。
   */
  const {
    mcpServers, commitMcp, mcpGroups, mcpToolCount, mcpRefreshing,
    refreshMcp: doRefreshMcp,
  } = useMcpRegistry({
    initCanvases: init.canvases,
    onLog: pushLog,
    // 刷新后要拿全部画布算"有没有节点用着变化的工具"（见 hook 里的说明）
    canvasesRef,
  });
  /*
   * 凭据库（加密存储 / 解锁 / 换保管方式）。
   *
   * 抽成 hook 是因为它是全应用最独立的一块：只依赖画布列表（迁移老节点上的
   * 内联密钥）和写日志的回调，与画布交互、执行流程都不相干。
   * App.tsx 曾三千七百多行，从最独立的这块拆起。
   */
  const vault = useCredentialVault({
    canvasesRef,
    setCanvases,
    onLog: pushLog,
  });
  const {
    store, credentials, setCredentials, vaultKey,
    unlockErr, setUnlockErr, cryptoWarn,
    credOpen, setCredOpen, credFocus, setCredFocus, credPage, setCredPage,
    lockVault, unlock, changeVaultMode, openCredentials,
  } = vault;

  /*
   * 打开连接管理器并停在「服务」页。
   *
   * 与 openCredentials 的区别：那个走的是"聚焦到某一种密钥"，
   * 而 MCP 服务不在密钥里（它是库里独立的一页），
   * 所以要单独设 credPage —— 只设 credFocus 的话打开后停在「密钥」页，
   * 用户点「去连接管理器添加」看到的还是密钥列表，找不到加服务的地方。
   *
   * 缺了它，画布设置里那个按钮点了会打开面板却停在错的页 ——
   * 不报错，只是"找不到在哪加"。
   */
  const openMcpLibrary = useCallback(() => {
    setCredPage('mcp');
    setCredFocus('');
    setCredOpen(true);
  }, [setCredPage, setCredFocus, setCredOpen]);

  /*
   * 接住「打开凭据中心」。
   *
   * 链路三段，缺任一段都是**点了没反应、且不报错**：
   *   ① 右上角 MCP 按钮 → 宿主 emit('nexus:open-credentials')
   *   ② main.tsx 把总线事件转成 window 事件（总线到不了 React 树内部）
   *   ③ **这里**接住并真正打开面板
   *
   * ③ 曾在远端一次覆盖中丢失（①②都还在，所以表现为"静默失效"）。
   */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ page?: string }>)?.detail || {};
      /*
       * 只认这两个页面名。
       *
       * 原写法 `if (d.page) setCredPage(d.page)` 把任意字符串塞进
       * `"mcp" | "cred"`（TS2345）。更要紧的是：真来了一个别的名字，
       * 面板会打开，但两个子标签都不是选中态 —— 用户看到的是个空面板，
       * 且没有任何报错（静默出错）。不认识就不改，保持上次那个页。
       */
      if (d.page === 'mcp' || d.page === 'cred') setCredPage(d.page);
      setCredOpen(true);
    };
    window.addEventListener('nexus:open-credentials', onOpen);
    return () => window.removeEventListener('nexus:open-credentials', onOpen);
  }, [setCredOpen, setCredPage]);




  /**
   * 保存凭据前的校验。
   *
   * GitHub 令牌真的去打一次 /user：既能确认令牌有效，
   * 又能从 X-OAuth-Scopes 读出读写权限（面板据此填 capabilities）。
   * 其它类型各家接口不统一，没法通用校验 —— 如实返回"未校验"，
   * 而不是假装成功。
   */
  const verifyCredential = useCallback(async (kind: CredentialKind, secret: string) => {
    if (kind === 'github') {
      const f: GithubFetcher = async (url, init) => {
        const r = await httpRequest(url, {
          headers: init?.headers,
          timeoutSec: 15,
          // GitHub API 要自己的 UA，别用抓取订阅源那个浏览器 UA
          withDefaultUa: false,
        });
        return { status: r.status, ok: r.ok, text: r.text, headers: r.headers };
      };
      const r = await verifyToken(f, secret);
      return {
        ok: r.ok,
        identity: r.login || undefined,
        scopes: r.scopes,
        message: r.message,
      };
    }
    // 大模型 / 通用密钥：只有真跑一次才知道对不对
    return {
      ok: true,
      identity: undefined,
      scopes: null,
      message: '已保存（未验证：各家接口不统一，运行节点时才能确认可用）',
    };
  }, []);

  /*
   * 拉取模型清单：GET /v1/models。
   *
   * 交给外部注入而不是写死在凭据面板里 —— 面板因此保持可在测试里验证、不碰网络。
   *
   * 401 / 403 单独说一句：那种情况多半是密钥不对，
   * 而通用的"拉取失败"会让人以为是地址填错了，排查方向就偏了。
   */
  const fetchModels = useCallback(async (url: string, apiKey: string) => {
    const r = await httpRequest(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutSec: 15,
    });
    if (!r.ok) {
      throw new Error(
        r.status === 401 || r.status === 403
          ? `密钥不对或没权限（HTTP ${r.status}）`
          : `HTTP ${r.status} ${r.text.slice(0, 120)}`,
      );
    }
    try {
      return JSON.parse(r.text);
    } catch {
      throw new Error('返回的不是 JSON');
    }
  }, [httpRequest]);




  const [concurrency, setConcurrency] = useState(1);
  const [globalInput, setGlobalInput] = useState('');
  const [summary, setSummary] = useState<RunSummary | null>(null);
  /** 后端通道体检结果；null 表示还没探完 */
  const [channel, setChannel] = useState<ChannelStatus | null>(null);

  // 触发器
  /**
   * 触发器现在来自画布上的触发器节点。
   * 这样"哪个触发器驱动哪条流水线"在画布上一眼可见，
   * 不用再去另一个面板里对名字。
   */
  /**
   * 一个触发器节点可挂多种方式，这里展开成多条 Trigger 交给调度器。
   *
   * id 用 `${nodeId}:${kind}` —— 调度器内部按 id 记录"上次触发时刻"
   * "cron 下次时刻""防抖定时器"，展开后天然互不覆盖。
   * 同时带上 nodeId，触发完才能把状态写回画布上那一个节点。
   */
  /*
   * 触发器**扫描所有画布**，不只是当前这张。
   *
   * 原来只从当前画布收集，于是切走一张画布，它的目录监听、
   * webhook、周期任务就全停了 —— 而且没有任何提示，
   * 用户会以为监听还在。
   *
   * 后台开关（默认开）决定要不要由全局代管；关掉的只在
   * 它的画布处于激活态时才接管（见 triggerRegistry.splitByScope）。
   */
  const allGlobalTriggers = useMemo<GlobalTrigger[]>(
    () => collectGlobalTriggers(
      canvases.map((c) => ({
        id: c.id,
        name: c.name,
        nodes: (c.nodes ?? []) as { id: string; data?: Record<string, unknown> }[],
      })),
      DEFAULT_TRIGGER_CONFIG,
    ),
    [canvases],
  );

  const triggers = useMemo<Trigger[]>(
    () => {
      const act = activeTriggers(allGlobalTriggers, activeId);
      // 同目录重复监听会改一次文件触发两遍，在数值推导里代价很大
      return dedupeWatchDirs(act) as unknown as Trigger[];
    },
    [allGlobalTriggers, activeId],
  );

  /** 触发器面板要能看出"哪些是别的画布的"，所以保留完整信息 */
  const triggersWithCanvas = allGlobalTriggers;

  /*
   * 正在编辑的模块（null = 不在编辑）。模块编辑的完整设计见下方
   * "模块：编辑模式"一节；声明必须放在这里，是因为下面的 buried
   * 依赖数组要引用它 —— 放声明在使用点之后就是 TDZ，渲染到
   * buried 时直接 ReferenceError，页面整个白屏。
   */
  const [editingModule, setEditingModule] = useState<string | null>(null);

  /*
   * 埋在模块里的触发器：扫出来并明确说出来。
   *
   * canPack 只挡住**新建**的。判定加上之前就已经存进模块库的、
   * 以及脱钩副本里自带的那些，一个都拦不到 ——
   * 而它们既不出现在触发器面板上，也永远不会自动触发。
   *
   * 不报出来的话，用户面对的是"我明明配了 webhook，面板上没有、
   * 也不触发"，而没有任何东西指出原因在哪 ——
   * 这正是 canPack 那条注释里说的"极难排查的那一种"。
   */
  const buried = useMemo<BuriedTrigger[]>(
    () => collectBuriedTriggers(
      canvases.map((c) => ({
        id: c.id,
        name: c.name,
        nodes: (c.nodes ?? []) as { id: string; data?: Record<string, unknown> }[],
      })),
      (d) => {
        const own = (d.inner as { nodes?: unknown[] } | null)?.nodes;
        if (own) return { nodes: own as { id: string; data?: Record<string, unknown> }[] };
        const def = findModule(String(d.moduleId ?? ''));
        return def ? { nodes: (def.nodes ?? []) as { id: string; data?: Record<string, unknown> }[] } : null;
      },
    ),
    /*
     * 依赖里必须有 editingModule。
     *
     * findModule 读的是 localStorage 的模块库，而**模块库变化不触发任何
     * state 更新** —— 只依赖 canvases / nodes 的话，用户照提示进模块
     * 把触发器删掉、点「完成」，这个列表**根本不会重算**，警告照旧挂着。
     * 用户会以为"我删了它却还说埋着"，于是反过来怀疑这条提示是错的。
     *
     * 进出编辑模块 editingModule 一定变（有值 → null），是天然的重算信号。
     */
    [canvases, nodes, editingModule],
  );

  /*
   * 只在"埋着的那一批"真的变了时说一次。
   * 放在渲染里直接 pushLog 的话，每次 canvases 变化都会刷一行，
   * 日志很快被同一句话淹没，真正的问题反而看不见。
   */
  const buriedKeyRef = useRef('');
  useEffect(() => {
    if (buried.length === 0) {
      buriedKeyRef.current = '';
      return;
    }
    const key = buried.map((b) => `${b.canvasId}/${b.hostId}/${b.triggerId}`).sort().join('|');
    if (key === buriedKeyRef.current) return;
    buriedKeyRef.current = key;
    /*
     * 有多张画布时**必须**带上画布名。
     *
     * 徽章（buriedHere）刻意只显示当前画布那张，所以别的画布上的埋藏
     * 触发器在界面上**完全没有痕迹**，只剩日志这一行。而这一行不带画布名
     * 的话，用户就在当前这张画布上找「发版」这个模块 —— 找不到，
     * 于是以为提示说的是一个不存在的东西（与"删了还挂着"同一种失信）。
     *
     * 只有一张画布时不带：那种情况下"哪张画布"没有歧义，写出来是噪音。
     *
     * 判据用 canvases.length 而不是"是不是当前画布"—— 后者会随切换画布
     * 变化，而这条日志只在埋藏集合变化时说一次（见上），说出去了就改不了，
     * 用会变的值写一句不会再说的话，必然有对不上的时候。
     */
    const nameCanvas = canvases.length > 1;
    const where = buried.slice(0, 3)
      .map((b) => `${nameCanvas ? `画布「${b.canvasName ?? b.canvasId}」的 ` : ''}`
        + `模块「${b.hostLabel}」的 ${b.kind || '触发器'}`)
      .join('、');
    pushLog(
      `⚠ 有 ${buried.length} 个触发器埋在模块里（${where}${buried.length > 3 ? ' 等' : ''}）：`
      + '全局扫描只看画布顶层，模块内部的不会被扫描，自动触发永远不会发生。'
      + '请把触发器建在画布上，模块里只放它后面的节点'
      + '（在「编辑内部」里删掉模块内那个即可）',
    );
  }, [buried, pushLog]);

  /*
   * 工具栏那个计数只统计"真在监听的"，埋着的**一个都不算** ——
   * 于是用户看到「触发器 1/1」会以为配的都在生效。
   * 这里把埋着的数量并排放出来，hover 能看到是哪个模块。
   *
   * 只算当前激活画布那张：别的画布的问题出现在这张的计数旁边，
   * 只会让人去找一张他没打开过的画布。
   */
  const buriedHere = buried.filter((b) => b.canvasId === activeId);


  /*
   * 画布组。
   *
   * 存 localStorage，与画布同一套口径（见 engine/kv.ts）。
   * 删除画布时必须 pruneGroups —— 不然组里会留着孤儿 id，
   * 界面上显示一个空条目，点它什么也不会发生。
   */
  /*
   * 加载时清一次空组（dropEmptyGroups）。
   *
   * 平时**不能**删空组 —— 会连刚新建的空组一起删掉，
   * 表现为"点新建组没反应"（见 canvasGroups.pruneGroups 的说明）。
   */
  const [canvasGroups, setCanvasGroups] = useState<CanvasGroup[]>(
    () => dropEmptyGroups(loadGroups()),
  );

  useEffect(() => { saveGroups(canvasGroups); }, [canvasGroups]);

  useEffect(() => {
    /*
     * 用 IfChanged 版本：canvases 是高频变化的（编辑一下就变），
     * 而这个 effect 依赖它 —— 不加守卫的话每次都会 setState，
     * 进而每次都写一遍 localStorage。
     */
    setCanvasGroups((gs) => pruneGroupsIfChanged(gs, canvases.map((c) => c.id)));
  }, [canvases]);

  const handleAddGroup = useCallback(() => {
    setCanvasGroups((gs) => [
      ...gs,
      { id: `g_${Date.now().toString(36)}`, name: nextGroupName(gs), members: [], collapsed: false },
    ]);
  }, []);

  const handleRenameGroup = useCallback((id: string, name: string) => {
    setCanvasGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)));
  }, []);

  const handleDeleteGroup = useCallback((id: string) => {
    setCanvasGroups((gs) => gs.filter((g) => g.id !== id));
  }, []);

  const handleDropToGroup = useCallback((groupId: string, canvasId: string) => {
    setCanvasGroups((gs) => addToGroup(gs, groupId, canvasId));
  }, []);

  const handleRemoveFromGroup = useCallback((canvasId: string) => {
    setCanvasGroups((gs) => removeFromGroup(gs, canvasId));
  }, []);

  const handleToggleCollapse = useCallback((groupId: string) => {
    setCanvasGroups((gs) => gs.map((g) =>
      (g.id === groupId ? { ...g, collapsed: !(g.collapsed === true) } : g)));
  }, []);

  const [watchSupported] = useState(() => canWatch());
  const [webhookSupported] = useState(() => canWebhook());
  // 外观：跟随面板主题 / 固定 Agent Flow 原生样式
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  useEffect(() => applyThemeMode(themeMode), [themeMode]);

  const seq = useRef(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRuns = useRef<Map<string, string>>(new Map());
  /*
   * 本次运行里"已经开过会话"的窗格 id。
   *
   * 会话衔接只对窗格里**第二个及以后**的节点生效 —— 第一个没有"上一次"可接，
   * 带上 `-c` 接的是 CLI 全局记的那一次，可能是用户在自己终端里跑的那次。
   *
   * 每次开跑前清空：留着的话第二次跑的第一个节点也会去接上一次跑的会话，
   * 表现为"每次重跑，第一个节点的回答里都带着上一轮的上下文"。
   */
  const paneSessions = useRef<Set<string>>(new Set());

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  /*
   * 组合 / 解散的浮动条只在用得着时出现：
   * 选了 2 个以上节点（能组合）或选到了组合框（能解散）。
   * 一直显示的话它挡着画布，而"组合"不是每时每刻都要做。
   */
  const selCount = nodes.filter((n) => n.selected).length;
  const selHasFrame = nodes.some((n) => n.selected && isFrameNode(n));

  /* ---------------- 布局：左中右三栏的标签 ---------------- */

  /*
   * 左右两栏都用可切标签而不是上下平分 ——
   * 分栏的话每栏都偏窄：属性面板挤到看不全，日志只看得到几行。
   * 切换的代价是"看日志时看不到属性"，但这两件事本来就不会同时做。
   */
  const [leftTabRaw, setLeftTabRaw] = useState<LeftTab>(() => normalizeLeftTab(kvStore().get('agent-flow.leftTab.v1')));
  /*
   * 右栏日志区高度（可拖）。
   *
   * 右栏是"设置在上、日志在下"的上下分栏而不是可切标签：
   * 跑流程时盯着日志还得能改参数，切成标签就得来回切。
   */

  /*
   * 任务视图下的子标签：进行中 / 已完成。
   *
   * 与 leftTab 分开存 —— 它是任务视图自己的状态，
   * 混进 leftTab 的话，流程视图切到「画布库」会把任务视图
   * 也带到一个它不认识的标签上。
   */
  const [taskTabRaw, setTaskTabRaw] = useState<TaskTab>(
    () => normalizeTaskTab(kvStore().get('agent-flow.taskTab.v1')),
  );

  useEffect(() => { kvStore().set('agent-flow.leftTab.v1', leftTabRaw); }, [leftTabRaw]);
  useEffect(() => { kvStore().set('agent-flow.taskTab.v1', taskTabRaw); }, [taskTabRaw]);

  const leftTab = normalizeLeftTab(leftTabRaw);
  const taskTab = normalizeTaskTab(taskTabRaw);

  /*
   * 任务视图的呈现方式（列表 / 表格）。
   *
   * 与 taskTab 分开存：子标签决定"看哪一段数据"，呈现方式决定"怎么看"。
   * 混成一个状态的话，切到表格会把「进行中/已完成」的选择也重置掉，
   * 而表格本就覆盖全部数据 —— 那个选择对它毫无意义。
   */
  const [taskViewRaw, setTaskViewRaw] = useState<TaskView>(
    () => normalizeTaskView(kvStore().get('agent-flow.taskView.v1')),
  );
  useEffect(() => { kvStore().set('agent-flow.taskView.v1', taskViewRaw); }, [taskViewRaw]);
  const taskView = normalizeTaskView(taskViewRaw);

  /*
   * 当前项目（= 画布分组）。
   *
   * 只框定**任务面板看到哪些记录**，不动画布区在编辑哪张图 ——
   * 切换的语义是"我现在盯哪个项目"，不是"我现在改哪张图"。
   * 混在一起的话，想看另一个项目的任务就得先切走正在编辑的画布，
   * 而那张图的位置、选中状态全被换掉。
   */
  const [projectRaw, setProjectRaw] = useState<string>(
    () => scopeKeyOf(normalizeScope(parseScopeKey(kvStore().get('agent-flow.project.v1')), canvasGroups)),
  );
  useEffect(() => { kvStore().set('agent-flow.project.v1', projectRaw); }, [projectRaw]);
  /*
    存的是 key，用时再归到**当前还存在的分组**上：
    上次选的分组可能已经被删了，不修的话切过去一条记录都没有，
    而界面上看不出是"这个项目没了"还是"任务真的全空了"。
  */
  const project = useMemo<ProjectScope>(
    () => normalizeScope(parseScopeKey(projectRaw), canvasGroups),
    [projectRaw, canvasGroups],
  );
  const projectIndex = useMemo(
    () => buildProjectIndex(canvasGroups, canvases.map((c) => c.id)),
    [canvasGroups, canvases],
  );

  /*
    两路记录都按项目过滤，列表与表格共用同一份结果 ——
    各滤一遍的话，一处漏了就是"表格里没有、列表里还有"。
  */
  const scopedTasks = useMemo(
    () => filterByScope(tasks, project, projectIndex),
    [tasks, project, projectIndex],
  );
  const scopedHistory = useMemo(
    () => filterByScope(history, project, projectIndex),
    [history, project, projectIndex],
  );

  /*
   * 表格里选中的那一行。
   *
   * 存 **key**（`live:xxx` / `archived:xxx`）而不是 id：
   * 两路数据的 id 会撞（跑完的任务既在 live 也在归档里），
   * 只存 id 的话点归档那条会选中同 id 的进行中那条，详情对不上。
   */
  const [tableSel, setTableSel] = useState<string | null>(null);

  const selectTableRow = useCallback((row: TableRow) => {
    setTableSel(row.key);
    // 详情面板按 origin 走各自的分支（可取消 / 已归档），选中要同源
    const parsed = parseRowKey(row.key);
    if (!parsed) return;
    if (parsed.origin === 'live') setTaskSel(parsed.id);
    else setHistSel(parsed.id);
  }, [setTaskSel, setHistSel]);

  /*
   * 表格选中行对应的记录。
   *
   * 选中的记录**可能已经不在列表里**（清空调走了、归档被删了）——
   * 那时退回 null 让详情显示空态，而不是留着一条已经消失的记录
   * 在那里显示（那是"详情显示的是一个不存在的东西"）。
   */
  const activeTable = useMemo<{ row: TableRow; record: HistoryEntry } | null>(() => {
    if (!tableSel) return null;
    const parsed = parseRowKey(tableSel);
    if (!parsed) return null;
    // 池子用**过滤后**的：切了项目还拿全量池去查，详情就会显示别的项目那条
    //
    // board 行不在这里查 —— 它是任务条目而不是运行记录，
    // 没有 HistoryEntry 可给；它的详情走下方另一条分支（任务条目详情）。
    const pool = parsed.origin === 'live' ? scopedTasks
      : parsed.origin === 'archived' ? scopedHistory
      : null;
    if (!pool) return null;
    const rec = pool.find((t) => t.id === parsed.id);
    if (!rec) return null;
    return {
      row: { key: tableSel, origin: parsed.origin, record: rec, task: null, ownerId: parsed.id },
      record: rec,
    };
  }, [tableSel, scopedTasks, scopedHistory]);

  /*
   * 列表视图的选中项，同样要落在当前项目里。
   *
   * 直接用 taskSel / histSel 的话，切到另一个项目后：
   * 左栏没有任何一行高亮（选中的那条不在这个项目里），
   * 而右栏详情显示的却是**第一条** —— 两边指着不同的记录，
   * 看着就是"点了没反应"。所以这里算出真正生效的那个 id，
   * 高亮与详情共用它。
   */
  const scopedTaskSel = useMemo(() => (
    scopedTasks.some((t) => t.id === taskSel) ? taskSel : (scopedTasks[0]?.id ?? null)
  ), [taskSel, scopedTasks]);
  const scopedHistSel = useMemo(() => (
    scopedHistory.some((e) => e.id === histSel) ? histSel : (scopedHistory[0]?.id ?? null)
  ), [histSel, scopedHistory]);
  const scopedActiveTask = useMemo(
    () => scopedTasks.find((t) => t.id === scopedTaskSel) ?? null,
    [scopedTasks, scopedTaskSel],
  );
  const scopedActiveHist = useMemo(
    () => scopedHistory.find((e) => e.id === scopedHistSel) ?? null,
    [scopedHistory, scopedHistSel],
  );

  const projectOpts = useMemo(
    () => scopeOptions(canvasGroups, canvases.map((c) => c.id)),
    [canvasGroups, canvases],
  );


  const scopedRunning = useMemo(
    () => scopedTasks.filter((t) => t.status === 'running').length,
    [scopedTasks],
  );

  /*
    「清空」也只作用于当前项目。

    不改的话，切到项目甲点「清空」会把**所有**项目的记录一起清掉 ——
    按钮就在项目甲的列表头上，没人会想到它动的是别的项目的东西。
    这种"看着是局部、实际是全局"的操作一旦发生无从挽回。
  */
  const clearScopedTasks = useCallback(() => {
    setTasks((list) => list.filter(
      (t) => t.status === 'running' || !scopeMatches(project, t.canvasId, projectIndex),
    ));
  }, [project, projectIndex, setTasks]);

  const clearScopedHistory = useCallback(() => {
    saveHistory({
      v: historyFile.v,
      entries: historyFile.entries.filter((e) => !scopeMatches(project, e.canvasId, projectIndex)),
    });
  }, [project, projectIndex, historyFile, saveHistory]);


  /*
   * 启动时探一次后端通道（审查项 A-01）。
   *
   * 本插件直接 import 了 @tauri-apps/api 的 invoke，隔离态下会全部失效。
   * 全量改走 ctx.invoke 是根治办法，但要先重做事件转发；
   * 在此之前先把"通道不通"变成看得见的横幅，
   * 而不是等用户点某个功能才发现它一直是坏的。
   */
  useEffect(() => {
    let alive = true;
    checkChannel().then((r) => {
      if (!alive) return;
      setChannel(r);
      if (!r.ok) pushLog(`⚠ ${r.reason}`);
    });
    return () => { alive = false; };
  }, [pushLog]);




  /* ---------------- 画布级配置与导出 ---------------- */

  /*
   * 当前画布对象。派生值，不是 state ——
   * 设成 state 就得跟着 canvases 同步，多一处可能忘更新的地方。
   */
  const activeCanvas = canvases.find((c) => c.id === activeId) ?? null;

  /*
   * 默认导出目录 + 导出成脚本 / 说明。
   *
   * App.tsx 往下拆的第六块。放在 activeCanvas **之后** ——
   * 文件名要用到画布名，而那是派生值，得先算出来。
   */
  const {
    exportDir, setExportDir, pendingExport, exportFlowAs, exportText, onPickExportDir,
    cancelPendingExport, browseExportDir,
  } = useExportFlow({
    nodes, edges, canvasName: activeCanvas?.name ?? null, onLog: pushLog,
  });

  /*
   * 任务板（计划态任务）。
   *
   * 按项目一个文件 —— AI 只读自己项目那份，不同项目的任务不会
   * 互相占用上下文。文件落在导出目录里，AI 不打开界面也能直接改。
   */
  const boardKey = project.kind === 'group' ? project.groupId
    : project.kind === 'ungrouped' ? 'ungrouped' : 'all';
  const boardName = scopeLabel(project, canvasGroups);
  const board = useTaskBoard({
    dir: exportDir,
    project: boardKey,
    projectName: boardName,
    enabled: view === 'tasks',
  });
  const [boardSel, setBoardSel] = useState<string | null>(null);
  const [boardChecked, setBoardChecked] = useState<Set<string>>(() => new Set());
  const [boardKw, setBoardKw] = useState('');
  /** 状态流程与标签的设置面板 */
  const [metaOpen, setMetaOpen] = useState(false);

  /*
    换项目 = 换一个文件，旧的选中项与勾选在这个文件里不存在。
    不清理的话：选中项指着一个不存在的 id（详情空着），
    勾选集合里留着别项目的 id（下次点"合并"会静默少合几项）。
  */
  useEffect(() => {
    setBoardSel(null);
    setBoardChecked(new Set());
  }, [board.path]);

  /*
    右栏页签：属性 / 日志 / 文件。
    存 kv 记住上次的选择 —— 右栏是长时间停留的地方，
    每次打开都跳回「属性」的话，盯着日志的人要每次手动切一次。
  */
  const [rightTabRaw, setRightTabRaw] = useState<RightTab>(
    () => normalizeRightTab(kvStore().get('agent-flow.rightTab.v1')),
  );
  useEffect(() => { kvStore().set('agent-flow.rightTab.v1', rightTabRaw); }, [rightTabRaw]);
  const rightTab = normalizeRightTab(rightTabRaw);

  /*
    附属文件清单 —— 与任务板同一个项目、同一套落盘规则，
    只是另一个文件（attachments-<项目>.json）。
  */
  const attach = useAttachments({
    dir: exportDir,
    project: boardKey,
    projectName: boardName,
    enabled: view === 'tasks',
  });

  /*
    项目元数据：自定义状态流程 + 标签定义。
    与任务板、附件清单同一个项目、同一套落盘规则，第三个文件。
  */
  const meta = useBoardMeta({
    dir: exportDir,
    project: boardKey,
    projectName: boardName,
    enabled: view === 'tasks',
  });

  /*
    每个条目挂了几个附件 —— 表格的附件列要显示它。
    按 ownerId 建索引而不是每次遍历清单：表格有几百行时，
    每行都扫一遍清单是 O(行 × 附件)，滚动起来会卡。
  */
  const attachCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of attach.file.order) {
      const it = attach.file.items[id];
      if (!it) continue;
      out[it.owner] = (out[it.owner] ?? 0) + 1;
    }
    return out;
  }, [attach.file]);

  const toggleTag = useCallback((taskId: string, tagId: string) => {
    board.apply((b) => toggleBoardTag(b, taskId, tagId).board);
  }, [board]);

  /** 新建标签。返回新 id，让调用方能立刻把它挂到刚点的那一行上 */
  const createTag = useCallback((name: string, color: string): string | null => {
    let newId: string | null = null;
    meta.apply((m) => {
      const r = addTag(m, name, color);
      newId = r.id;
      return r.meta;
    });
    return newId;
  }, [meta]);

  /*
    元数据的写入提示。
    被覆盖是**整份**的（配置不像任务那样逐条合并），
    所以提示要说得比任务板那边更重 —— 用户刚改完几个状态名被盖掉，
    是最难解释的那种丢失。
  */
  const metaNotice = useMemo(() => {
    const s = meta.state;
    if (s.kind === 'error') return `⛔ ${s.message}`;
    if (s.kind === 'overwritten') return '⚠ 磁盘上有一份更新的配置，你的改动没写入 —— 刷新后再改一次';
    if (s.kind === 'loading') return '读取中…';
    if (s.kind === 'saving') return '写入中…';
    return '';
  }, [meta.state]);

  const attachNotice = useMemo(() => {
    const s = attach.state;
    if (s.kind === 'error') return `⛔ ${s.message}`;
    if (s.kind === 'overwritten') return `⚠ 有 ${s.ids.length} 条被文件里的新版本盖掉了`;
    if (s.kind === 'loading') return '读取中…';
    if (s.kind === 'saving') return '写入中…';
    return '';
  }, [attach.state]);

  const boardNotice = useMemo(() => {
    const s = board.state;
    if (s.kind === 'error') return `⛔ ${s.message}`;
    if (s.kind === 'overwritten') {
      return `⚠ 有 ${s.ids.length} 项被文件里的新版本盖掉了（AI 或别处刚改过同一条）`;
    }
    if (s.kind === 'loading') return '读取中…';
    if (s.kind === 'saving') return '写入中…';
    return '';
  }, [board.state]);

  /**
   * 存画布配置（MCP 服务 / 环境变量）。
   *
   * **只有服务列表真的变了才刷新** ——
   * 环境变量改动不该触发重连；而且这里是每次按键都进来的。
   */
  const saveCanvasConfig = useCallback((next: CanvasConfig) => {
    if (!activeId) return;
    setCanvases((cs) => updateCanvasConfig(cs, activeId, next));

    /*
     * MCP 服务已经**不再存在画布配置里**了 —— 它由全局库管
     * （见上面 mcpServers 的说明）。所以这里不再为它触发刷新，
     * 改由下面那个监听全局库的 effect 负责。
     *
     * 留着这段代码的话：改画布上的环境变量也会触发一次 MCP 刷新，
     * 而服务根本没变。
     */
  }, [activeId]);


/**
 * 未翻译的节点**必须**告出来 ——
 * 用户拿到一份"少了点什么"的脚本而毫无线索，是最坏的结果。
 */
function reportSkipped(
  r: { skipped: Array<{ id: string; kind?: string }> },
  label: string,
  pushLog: (m: string) => void,
): void {
  if (r.skipped.length === 0) return;
  const names = r.skipped.map((x) => `${x.id}(${x.kind || '?'})`).join('、');
  pushLog(`⚠ ${label}已导出，但 ${r.skipped.length} 个节点没能翻译：${names} —— 它们在结果里以 TODO 标出`);
}

  /* ---------------- 节点编辑 ---------------- */

  /*
   * 按**点分路径**写入（如 `entries.0.kind`），逐层克隆、不改原对象。
   *
   * 为什么需要：触发器是"一个节点下挂多张卡"（data.entries[i]），
   * 卡片上的就地编辑要写进数组里的某一项，而 patchNode 原本只做顶层
   * 浅合并。若把 `entries.0.kind` 当成**一整个键名**浅合并进去，
   * 会凭空多出一个字面名叫 "entries.0.kind" 的字段 ——
   * 真正的 entries 一项没动，界面上看不出变化，值却永远存不进去。
   *
   * 数组下标用字符串也能索引到（JS 里 a['0'] === a[0]），
   * 但克隆时必须按数组展开，否则 {...arr} 会把数组变成对象。
   */
  const setByPath = (target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
    const segs = path.split('.');
    const root: Record<string, unknown> = { ...target };
    let cur = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i];
      const next = cur[seg];
      const cloned = Array.isArray(next)
        ? ([...next] as unknown as Record<string, unknown>)
        : next && typeof next === 'object'
          ? { ...(next as Record<string, unknown>) }
          : {};
      cur[seg] = cloned;
      cur = cloned;
    }
    cur[segs[segs.length - 1]] = value;
    return root;
  };

  const patchNode = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== id) return n;
      /*
       * 选了画布就顺带落一份名字快照。
       *
       * 卡片显示只能读 data（拿不到画布列表），没有快照的话
       * 刚选完一张有名字的画布，卡片上却显示"未命名画布"——
       * 明明选了，看着像没生效。
       */
      /*
       * 键名里带 '.' 的走嵌套写入，其余照旧浅合并 ——
       * 这样不传 path 的调用方（绝大多数）完全不受影响。
       */
      let next = { ...n.data } as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        next = k.includes('.') ? setByPath(next, k, v) : { ...next, [k]: v };
      }
      if (patch.canvasId !== undefined && !patch.canvasName) {
        const snap = snapshotCanvasName(patch.canvasId, canvases);
        if (snap) next.canvasName = snap;
      }
      // 断言放在整体而非 data 上：若把 data 单独断言成联合类型 NodeData，
      // 展开后就无法落回 FlowNode 的任何一个具体分支（task/condition/…）。
      return { ...n, data: next } as FlowNode;
    }));
  }, [setNodes, canvases]);

  /*
   * 定位到画布上的某个节点：选中 + 滚到视口中心。
   *
   * 只选中不滚的话，节点可能在视口外 ——
   * 用户会以为按钮没生效（"我点了，什么都没发生"）。
   */
  const locateNode = useCallback((nodeId: string, ns: FlowNode[]) => {
    const n = ns.find((x) => x.id === nodeId);
    setSelectedId(nodeId);
    setNodes((prev) => prev.map((x) => ({ ...x, selected: x.id === nodeId }) as FlowNode));
    if (!n) return;
    // measured 是 xyflow 量出来的实际尺寸；没量过就用默认卡片大小
    const w = (n as { measured?: { width?: number } }).measured?.width ?? 240;
    const h = (n as { measured?: { height?: number } }).measured?.height ?? 90;
    rfInstance.current?.setCenter(n.position.x + w / 2, n.position.y + h / 2, {
      zoom: rfInstance.current?.getZoom() ?? 1,
      duration: 300,
    });
  }, [setNodes]);

  /*
   * 切完画布再定位。
   *
   * 依赖里带 nodes：切画布后 nodes 会换一批，那时才找得到目标节点。
   */
  useEffect(() => {
    const pend = pendingLocate.current;
    if (!pend) return;
    if (pend.canvasId !== activeId) return;
    pendingLocate.current = null;
    locateNode(pend.nodeId, nodes);
  }, [activeId, nodes, locateNode]);

  const onConnect = useCallback(
    (params: Connection) => {
      /*
       * 先判是不是**参数连线**。
       *
       * 判据是目标那端：目标是 `arg:xxx`（某个参数格的入口）
       * 就说明用户想"把我的输出填进这个参数"，而不是"我跑完接着跑你"。
       *
       * 必须走这条分支而不是落进下面的流程连线逻辑 ——
       * 混进去会让它带上 branch / loopRole，
       * 于是"取个值"变成"多一条执行路径"。
       */
      /*
       * 源端也要认：必须是某个**输出端口**（out:xxx）。
       *
       * 只判目标端的话，从节点右侧那个流程出口拖到参数格也会被当成参数连线 ——
       * 而那个出口的本意是"我跑完接着跑你"。
       * 两种出口混用的表现是：一根流程线被画成了紫虚线，
       * 用户以为只是取个值，实际下游多了一条执行路径。
       */
      const argKey = parseArgHandle(params.targetHandle);
      const outKey = parseOutHandle(params.sourceHandle);
      if (argKey && outKey) {
        setEdges((eds) => {
          const one = makeParamEdge(params.source!, params.target!, argKey, outKey);
          /*
           * 同一个参数只保留一条线。
           *
           * 两条线连同一个参数时，"取谁的值"取决于存档里边的顺序，
           * 而那个顺序不保证 —— 表现为"偶尔取到另一个值"，
           * 是那种复现不了、只能靠运气撞见的问题。
           */
          const rest = eds.filter(
            (e) => !(isParamEdge(e) && e.target === params.target && e.data?.targetArg === argKey),
          );
          return addEdge(one, rest);
        });
        const hint = linkHintOf(
          (nodes.find((n) => n.id === params.source)?.data as { kind?: string } | undefined)?.kind,
          argKey,
        );
        if (hint) pushLog(`⚠ ${hint}`);
        return;
      }

      // handleId 即出口标识：
      //  · 条件节点 → 分支 id 或 __default__
      //  · 循环节点 → 'body'（循环体）/ 'done'（循环结束）
      //  · 其它节点 → 缺省（普通边）
      const hid = params.sourceHandle ?? undefined;
      const srcNode = nodes.find((n) => n.id === params.source);
      const srcData = srcNode?.data;

      const isLoopSrc = srcData ? isLoop(srcData) : false;
      // 条件节点的出口才当分支；循环节点的 body/done 不能混进 branch 字段
      const branch = !isLoopSrc && hid && hid !== 'body' && hid !== 'done' ? hid : undefined;
      const loopRole = isLoopSrc ? (hid === 'done' ? 'done' : 'body') : undefined;

      const suffix = hid ? `:${hid}` : '';
      const newEdge: FlowEdge = {
        id: `${params.source}->${params.target}${suffix}`,
        source: params.source,
        target: params.target,
        data: branch || loopRole ? { branch, loopRole } : undefined,
        label: isLoopSrc
          ? (loopRole === 'done' ? '结束' : '循环体')
          : branchLabel(nodes, params.source, branch),
      };
      /*
       * 不加 `as Edge`：newEdge 已经是 FlowEdge，断言反而把它降级成基础 Edge，
       * 与 setEdges 期望的 FlowEdge[] 对不上（此前依赖不全时被 any 掩盖了）。
       */
      setEdges((eds) => addEdge(newEdge, eds));

      /*
       * 连完按契约校验一次。
       *
       * 刻意**不阻止** —— 契约描述的是"语义上能不能用"，
       * 而用户可能有我没想到的用法。硬阻止会让"明明能连却连不上"，
       * 比给一条提示更让人困惑。
       *
       * 例外是 block 级（比如连给自己），那种本来就不该成立。
       */
      const verdict = canConnect(
        specOf(kindOfNode(nodes, params.source)),
        specOf(kindOfNode(nodes, params.target)),
      );
      if (verdict.reason) pushLog(`⚠ ${verdict.reason}`);
    },
    [setEdges, nodes, pushLog],
  );

  /** 取节点的 dataKind（契约按 dataKind 索引） */
  const kindOfNode = useCallback((ns: FlowNode[], id: string | null): string | null => {
    if (!id) return null;
    const n = ns.find((x) => x.id === id);
    if (!n) return null;
    return getDefByDataKind(n.data)?.dataKind ?? null;
  }, []);

  /*
   * 当前是不是"按住 Ctrl / ⌘ 拖动 = 复制"。
   *
   * 嵌合要据此跳过：复制时移动的是副本，原件关系没变，
   * 此时改 stackParent 会把**原件**改坏。
   */
  const isDuplicating = useCallback(() => dupMapRef.current !== null, []);

  /*
   * 嵌合（竖串联结）+ 折叠 + 高度自适配.
   *
   * App.tsx 往下拆的第二块。位置计算全在 engine/stack（纯函数），
   * 这里只接事件与渲染派生。
   *
   * 放在 kindOfNode **之后**：它用 kindOfNode 判断两端能不能接，
   * 而那是 const，提前调用会撞 TDZ。
   */
  const stack = useStackLayout({
    nodes, setNodes, kindOfNode, onLog: pushLog, isDuplicating,
  });
  const displayNodes = stack.displayNodes;
  /*
   * 组合框自适应 —— 分两步：派生 + 回填。
   *
   * 框的位置与大小**每帧按成员的实际位置重算**，所以不会"框和里面的
   * 东西对不上"。但只派生、不回填会有第二个问题：
   *
   *   fitFrames 每次都返回**新数组**（存档里的框永远是建框时的 180×110，
   *   与目标几何比必然不相等）→ framedNodes 每帧都是新引用 →
   *   canvasNodes 每帧重建 → xyflow 每帧重测量、重渲染。
   *
   * 拖一个节点时这就表现为框跟不上手、一卡一卡的，
   * 而每一帧单独看都是对的 —— 最难自查的那类问题。
   *
   * 所以把算出来的几何**回写进 nodes**（下面那个 effect）：
   * 回填后下一帧 sameGeom 成立，fitFrames 直接返回原引用，
   * canvasNodes 稳定下来；成员再变动时又重新触发一轮。
   *
   * 回填只改框自己的 position / width / height，不碰任何成员，
   * 也不会无限循环（写进去之后比较就相等了）。
   */
  const framedNodes = useMemo(() => fitFrames(displayNodes), [displayNodes]);

  /*
   * 把算好的框几何回填进 state（理由见上）。
   *
   * 只回填**框**，成员一律不动 ——
   * 顺手动成员的话，拖动时就会出现两个写入源，
   * 表现为节点位置来回跳。
   */
  useEffect(() => {
    const moved = displayNodes.filter((n) => isFrameNode(n));
    if (moved.length === 0) return;
    const want = new Map(moved.map((n) => [n.id, n]));
    let dirty = false;
    for (const n of nodes) {
      if (!isFrameNode(n)) continue;
      const g = want.get(n.id);
      if (!g) continue;
      if (
        Math.abs((n.position?.x ?? 0) - (g.position?.x ?? 0)) < 0.5 &&
        Math.abs((n.position?.y ?? 0) - (g.position?.y ?? 0)) < 0.5 &&
        Math.abs((n.width ?? 0) - (g.width ?? 0)) < 0.5 &&
        Math.abs((n.height ?? 0) - (g.height ?? 0)) < 0.5
      ) continue;
      dirty = true;
      break;
    }
    if (!dirty) return;
    setNodes((ns) => ns.map((n) => {
      const g = want.get(n.id);
      if (!isFrameNode(n) || !g) return n;
      return { ...n, position: g.position, width: g.width, height: g.height } as FlowNode;
    }));
  }, [framedNodes, displayNodes, nodes, setNodes]);
  const {
    toggleStackCollapse, onStackDragStart, onStackDrag, onStackDragStop,
  } = stack;



  /* ---------------- 多画布操作 ---------------- */

  const handleAddCanvas = useCallback(() => {
    const c = makeCanvas(nextCanvasName(canvases));
    setCanvases((cs) => [...cs, c]);
    setActiveId(c.id);
  }, [canvases]);

  const handleRenameCanvas = useCallback((id: string, name: string) => {
    setCanvases((cs) => {
      const renamed = renameCanvas(cs, id, name).list;
      /*
       * 改名要回写到**引用了这张画布的节点**。
       *
       * 那些节点显示的是名字快照（卡片只收 data，拿不到画布列表），
       * 不回写的话改名后卡片还显示旧名 ——
       * 表现为"我明明改了名，这个节点还叫旧的"，且没有任何提示。
       *
       * 要扫全部画布：引用节点可能在别的画布上。
       */
      return syncCanvasesRefNames(renamed as never) as typeof renamed;
    });
  }, []);

  const handleDeleteCanvas = useCallback((id: string) => {
    setCanvases((cs) => {
      const idx = cs.findIndex((c) => c.id === id);
      const r = removeCanvas(cs, id);
      const nextId = nextActiveId(r.list, id, idx);
      setActiveId(nextId);
      return r.list;
    });
  }, []);

  /** 至少保留一个画布，避免界面变成无法操作的空态 */
  useEffect(() => {
    if (canvases.length === 0) {
      const c = makeCanvas(nextCanvasName(canvases));
      setCanvases([c]);
      setActiveId(c.id);
    }
  }, [canvases]);

  /* ---------------- 从边栏添加节点 ---------------- */

  const spawnNode = useCallback(
    (p: DragPayload, at?: { x: number; y: number }) => {
      seq.current += 1;
      const suffix = `${Date.now().toString(36)}${seq.current}`;
      const pos = at ?? { x: 120 + (nodes.length % 5) * 60, y: 120 + (nodes.length % 5) * 40 };

      /*
       * 以前这里是一条 12 个分支的 if-else 链，每加一种节点都要来插一段，
       * 并且要记住"这个类型该用哪个 make 函数、id 前缀是什么"。
       * 现在这些都写在节点定义里，这里只按预设取用。
       *
       * preset.key 形如 'task' 或 'task:codebuddy'（带变体的类型）。
       */
      const preset = allPresets().find((x) => x.key === p.kind)
        ?? allPresets().find((x) => x.type === p.kind);
      /*
       * 找不到就**说出来**，不能静默 return。
       *
       * 静默的代价：用户拖了、松手、什么都没发生 ——
       * 他会以为自己没拖对（再拖几次），或者以为界面坏了。
       * 而"没反应"和"拖放被环境吞掉"在界面上长得一模一样，
       * 不写这一行就永远分不清是数据问题还是环境问题。
       */
      if (!preset) {
        pushLog(`✗ 这个节点类型已不存在（${String(p.kind)}），可能来自旧存档`);
        return;
      }
      const def = getDef(preset.type);
      const id = `${def.meta.idPrefix}${suffix}`;
      const node = {
        id,
        type: preset.type,
        position: pos,
        /*
         * 顺序有讲究：create 先铺全字段默认值，再用 preset.init() 覆盖
         * 变体差异（cli / source / label）。反过来写，init 里精心设的
         * 「WorkBuddy CLI任务」会被 create 的默认值盖掉。
         *
         * 用户设的默认放最后盖 —— 见 withDefault：按 preset.key 存，
         * 所以 WorkBuddy 变体设的默认不会串到 TraeCode 变体上。
         */
        data: withDefault(preset.key, {
          ...def.create(id),
          ...preset.init(),
        } as Record<string, unknown>),
      } as FlowNode;
      setNodes((ns) => [...ns, node]);
      setSelectedId(node.id);
    },
    [nodes.length, setNodes, pushLog],
  );

  /* ---------------- 按住 Ctrl 拖动 = 复制 ---------------- */

  /**
   * 拖动复制期间的「原 id → 副本 id」映射。
   *
   * 为什么需要它：xyflow 的拖拽是按 dragStart 那一刻的节点 id 发位移的，
   * 而我们要的是「副本跟着鼠标走、原件留在原地」。
   * 所以复制完成后，把后续 position change 的 id 改写成副本 id。
   */
  const dupMapRef = useRef<Record<string, string> | null>(null);

  const duplicateByIds = useCallback(
    (ids: string[]): Record<string, string> | null => {
      if (ids.length === 0) return null;

      // 按原节点查定义：id 前缀与 create 都写在各自的定义里
      const defOf: Record<string, NodeDef> = {};
      for (const id of ids) {
        const n = nodes.find((x) => x.id === id);
        if (n) defOf[id] = getDef(n.type);
      }

      const result = duplicateElements({
        nodes: nodes as unknown as DupNode[],
        edges: edges as unknown as DupEdge[],
        ids,
        makeNodeId: (oldId) => {
          seq.current += 1;
          const s = `${Date.now().toString(36)}${seq.current}`;
          return `${defOf[oldId]?.meta.idPrefix ?? 'n'}${s}`;
        },
        makeEdgeId: () => {
          seq.current += 1;
          return `e${Date.now().toString(36)}${seq.current}`;
        },
        /*
         * 顺序与从侧栏新建时一致：create 先铺全字段默认值
         * （status='idle'、output='' …），再用原件配置覆盖。
         * 反过来写，stripRuntime 挖掉的运行时字段就没人补了，
         * 副本会缺 status 而只能靠渲染处的 ?? 'idle' 兜底。
         */
        makeData: (newId, oldData, oldId) => ({
          ...(defOf[oldId]?.create(newId) ?? {}),
          ...stripRuntime(oldData),
        }),
      });

      if (result.nodes.length === 0) return null;

      setEdges((es) => [...es, ...(result.edges as unknown as FlowEdge[])]);
      setNodes((ns) => [...ns, ...(result.nodes as unknown as FlowNode[])]);
      return result.map;
    },
    [nodes, edges, setNodes, setEdges],
  );

  /**
   * 落一个模块实例到画布。
   *
   * 实例只记 moduleId，结构仍住在模块库里 —— 改库则所有实例跟着变。
   * 想让某个实例独善其身，就在属性面板里「脱钩」。
   */
  const spawnModule = useCallback(
    (moduleId: string, at?: { x: number; y: number }) => {
      const m = findModule(moduleId);
      if (!m) {
        pushLog('✗ 这个模块已经不存在了（可能刚被删掉）');
        return;
      }
      seq.current += 1;
      const id = `m${Date.now().toString(36)}${seq.current}`;
      const pos = at ?? { x: 120 + (nodes.length % 5) * 60, y: 120 + (nodes.length % 5) * 40 };
      const def = getDef('module');
      const node = {
        id,
        type: 'module',
        position: pos,
        // label 用模块名：新建时就该显示得像模像样，而不是"新模块"
        data: { ...def.create(id), moduleId, label: m.name },
      } as unknown as FlowNode;
      setNodes((ns) => [...ns, node]);
      setSelectedId(node.id);
    },
    [nodes.length, setNodes, setSelectedId, pushLog],
  );

  /* ---------------------------------------------------------------- */
  /* 模块：编辑模式                                                     */
  /* ---------------------------------------------------------------- */

  /*
   * 编辑模块内部时，借用主画布：把模块内容载入画布，改完存回模块库。
   *
   * 为什么不做独立的模块编辑弹窗：
   * 那要重新实现一遍画布交互（连线、框选、缩放、撤销），
   * 而这些逻辑已经写在主画布上了。复用主画布只多了"进入/退出"两个动作。
   *
   * 代价是进入编辑期间必须锁住画布切换 —— 否则切换会把模块内容
   * 当成另一个画布的内容存走，模块库里的东西就丢了。
   *
   * （editingModule 的 useState 声明已上移至 buried 之前 ——
   * buried 的依赖数组要引用它，放这里就是 TDZ。）
   */
  /** 拖拽开始时的位置快照，用于整体拖动与"拖开即解嵌"的判定 */
  const moduleBackup = useRef<{ nodes: FlowNode[]; edges: FlowEdge[] } | null>(null);

  /*
   * 切换画布的唯一入口。
   *
   * 编辑模块内部时借用主画布，画布上此刻装的是**模块的内容**，
   * 不是任何一张画布的内容。这时切换画布 = 用那张画布的内容覆盖
   * 画布区，而模块编辑条还挂着 —— 再点「完成」，写回模块库的就是
   * **另一张画布**，模块里原来的东西彻底没了，且没有任何提示。
   *
   * 上面那段注释（进入编辑必须锁住画布切换）说的就是这件事，
   * 而此前只有模块库那一栏加了锁：顶部画布页签、左栏画布列表、
   * 任务详情里的"跳到画布"三条路都开着。
   *
   * 锁在这一处而不是三个按钮上各写一遍 —— 各写一遍必然漏一条，
   * 而现在就是漏了三条才有的这个洞。
   */
  const switchCanvas = useCallback((id: string) => {
    if (editingModule) {
      pushLog('✗ 正在编辑模块：先点「完成」或「放弃」，再切换画布（否则模块会被这张画布的内容覆盖）');
      return;
    }
    setActiveId(id);
  }, [editingModule, pushLog]);

  const enterModuleEdit = useCallback(
    (id: string) => {
      const m = findModule(id);
      if (!m) return;
      // 已经在编辑别的模块了，先退出，否则备份会被覆盖
      if (editingModule) return;
      moduleBackup.current = { nodes, edges };
      setNodes(m.nodes.map((n) => ({ ...n })) as unknown as FlowNode[]);
      /*
       * 走 moduleEdgesToFlow，不再 `{...e}` 原样搬。
       *
       * 模块边把 branch / loopRole / targetArg 存在**顶层**，
       * 画布边存在 data 里。原样搬的结果：条件分支的「是/否」、
       * 循环出口的「每轮/结束」、参数连线标记全部到了顶层，
       * 画布上按 data 读，一律读到空 ——
       * 表现为"打开模块编辑，里面的分支线和参数线都变成了普通流程线"，
       * 而保存时又按 data 读回，这些字段就彻底丢了。
       */
      setEdges(moduleEdgesToFlow(m.edges) as unknown as FlowEdge[]);
      setSelectedId(null);
      setEditingModule(id);
      pushLog(`✎ 正在编辑模块「${m.name}」—— 改完点「完成」保存，所有实例跟着变`);
    },
    [nodes, edges, editingModule, setNodes, setEdges, setSelectedId, pushLog],
  );

  /** 编辑某个模块实例的内部 —— 会顺带脱钩（见下） */
  const enterInstanceEdit = useCallback(
    (nodeId: string) => {
      const n = nodes.find((x) => x.id === nodeId);
      if (!n) return;
      const d = n.data as unknown as Record<string, unknown>;
      if (d?.kind !== 'module') return;
      if (editingModule) return;

      moduleBackup.current = { nodes, edges };
      const own = d.inner as { nodes?: unknown[]; edges?: unknown[] } | null;
      if (own?.nodes) {
        // 已脱钩：直接编辑自带副本
        setNodes(own.nodes.map((x) => ({ ...(x as object) })) as unknown as FlowNode[]);
        setEdges(moduleEdgesToFlow((own.edges ?? []) as never) as unknown as FlowEdge[]);
      } else {
        const m = findModule(String(d.moduleId ?? ''));
        if (!m) {
          pushLog('✗ 模块已删除，无法编辑（可先在属性面板脱钩）');
          return;
        }
        setNodes(m.nodes.map((x) => ({ ...x })) as unknown as FlowNode[]);
        setEdges(moduleEdgesToFlow(m.edges) as unknown as FlowEdge[]);
      }
      setSelectedId(null);
      // 存一个特殊标记：退出时写回这个实例而不是模块库
      setEditingModule(`@instance:${nodeId}`);
      pushLog('✎ 正在编辑这个模块实例 —— 改完会脱钩成独立副本');
    },
    [nodes, edges, editingModule, setNodes, setEdges, setSelectedId, pushLog],
  );

  /** 退出编辑并保存 */
  const exitModuleEdit = useCallback(
    (save: boolean) => {
      const target = editingModule;
      if (!target) return;
      const backup = moduleBackup.current;

      if (save) {
        const clean = stripRuntimeNodes(
          nodes.map((n) => ({ ...n })) as unknown as Record<string, unknown>[],
        );
        /*
         * 走 flowEdgesToModule。
         *
         * 以前这里手写一份，只搬 branch / loopRole，
         * 于是**参数连线（targetArg）在保存模块时被整条丢掉** ——
         * 模块里"取个值"的线，编辑保存后消失，界面上只是少一根线。
         */
        const newEdges = flowEdgesToModule(edges);

        if (target.startsWith('@instance:')) {
          /*
           * 写回实例并脱钩。
           *
           * 为什么进入实例编辑就必须脱钩：画布上的编辑是"整体替换"，
           * 无法表达"只改这一处但模块库里同步更新" ——
           * 后者是个合并问题，会让用户困惑于"我改的到底生效在哪"。
           * 干脆让实例编辑 = 脱钩，语义干净。
           */
          const nodeId = target.slice('@instance:'.length);
          setNodes((ns) => ns.map((n) => (
            n.id === nodeId
              ? ({
                  ...n,
                  data: {
                    ...(n.data as object),
                    inner: { nodes: clean, edges: newEdges },
                    moduleId: '',
                  },
                } as unknown as FlowNode)
              : n
          )));
          pushLog('✓ 已脱钩为独立副本，模块库与其它实例不受影响');
        } else {
          const list = loadModules().map((m) => (
            m.id === target
              ? { ...m, nodes: clean, edges: newEdges as never }
              : m
          ));
          saveModules(list);
          pushLog('✓ 模块已保存，所有引用它的实例都会跟着变');
        }
      }

      setEditingModule(null);
      moduleBackup.current = null;
      if (backup) {
        setNodes(backup.nodes);
        setEdges(backup.edges);
      }
    },
    [editingModule, nodes, edges, setNodes, setEdges, pushLog],
  );

  /** 把画布上选中的节点存成新模块 */
  const createModuleFromSelection = useCallback(async () => {
    const picked = nodes.filter((n) => n.selected);
    if (picked.length === 0) {
      pushLog('✗ 还没选节点：先在画布上框选或点选要打包的节点');
      return;
    }
    /*
     * 走 packSelection，不再自己拼。
     *
     * 以前这里手写了一份，比 packSelection 少干三件事：
     *   · 不归一化坐标 → 拖出来的模块内部布局跑到了画布左上角
     *   · 不剥运行时（status / output / error）→ 存进去的模块带着
     *     "已经跑完"的状态，拖出来看起来像是执行过了
     *   · 不补嵌合的隐式边 → 嵌合成串的节点存进去后彼此不再相连，
     *     拖出来的模块"莫名其妙跑不起来"，而存的时候没有任何提示
     *
     * 同一件事两处写，必然有一处残缺 —— 所以统一到 engine 那一份。
     *
     * 第三参数传全图节点：嵌合的跨边界连接（父选中、子没选中）
     * 要靠它才算得出来。
     */
    /*
     * 打包前先过 canPack —— 它除了"选了没"之外还挡着一类静默失效
     * （触发器进模块后不再被全局扫描）。
     *
     * 这个判据以前**根本没有被调用过**（全仓只有测试在用），
     * 属于"对策写了但没接上"：canPack 里加了什么，界面一概不知道。
     * 现在接上，并且失败时把原因原样打进日志 ——
     * 拦下来不给理由，用户只会以为打包功能坏了。
     */
    const verdict = canPack(picked as never);
    if (!verdict.ok) {
      pushLog(`✗ ${verdict.reason ?? '这些节点不能打包成模块'}`);
      return;
    }

    const packed = packSelection(
      picked as never,
      edges.map((e) => ({
        id: e.id, source: e.source, target: e.target,
        branch: e.data?.branch, loopRole: e.data?.loopRole,
        /*
         * data 必须一起传。**参数连线的信息全在 data 里**
         * （isParamEdge 判的是 data.kind，取哪个输出看 data.sourceArg）。
         *
         * 只搬 branch / loopRole 的话，参数连线会被当成普通流程边：
         * 存进模块后 targetArg 没了，展开时那条线退化成一条执行路径 ——
         * 本该"取个值"变成"目标节点多跑一次"，而界面上这根线看起来
         * 和普通流程线一模一样，用户无从分辨。
         */
        data: e.data,
      })) as never,
      nodes as never,
    );

    const def = await askCreateModule({
      nodes: packed.nodes as Record<string, unknown>[],
      edges: packed.edges as unknown as Record<string, unknown>[],
    });
    if (def) pushLog(`✓ 已存成模块「${def.name}」，可从模块库拖出来复用`);
  }, [nodes, edges, pushLog]);

  /* ---------------------------------------------------------------- */
  /* 组合框（把若干节点框成一组）                                      */
  /* ---------------------------------------------------------------- */

  /** 把选中的节点框成一个组合 */
  const groupSelection = useCallback(() => {
    const picked = nodes.filter((n) => n.selected && !isFrameNode(n));
    if (picked.length < 2) {
      pushLog('✗ 组合要先选中 2 个以上节点：在画布上框选，或按住 Ctrl / ⌘ 点选');
      return;
    }
    const ids = picked.map((n) => n.id);
    const seq = nodes.filter((n) => isFrameNode(n)).length + 1;
    setNodes((ns) => [
      /*
       * 一个节点只属于一个框 —— 先让它从原来的框里退出。
       * 允许同时属于多个框的话，拖其中一个框会挪动这个节点，
       * 另一个框跟着变形，而界面上分不清它到底属于哪个。
       */
      ...ns.map((n) => {
        if (!isFrameNode(n)) return n;
        const before = frameMemberIds(n);
        const after = before.filter((m) => ids.indexOf(m) < 0);
        if (after.length === before.length) return n;
        return { ...n, data: { ...(n.data as Record<string, unknown>), members: after } } as FlowNode;
      }),
      makeFrame<FlowNode>(`fr${Date.now().toString(36)}`, ids, `组合 ${seq}`),
    ]);
    pushLog(`✓ 已把 ${ids.length} 个节点组合起来 —— 点框即选中整组，Ctrl / ⌘+Shift+G 解散`);
  }, [nodes, setNodes, pushLog]);

  /** 解散组合：只删框，里面的节点保留 */
  const ungroupSelection = useCallback(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const frames = nodes.filter((n) => (
      isFrameNode(n) && (n.selected || frameMemberIds(n).some((m) => byId.get(m)?.selected))
    ));
    if (frames.length === 0) {
      pushLog('✗ 没选中组合框（选中框里的任一节点也算）');
      return;
    }
    const dead = new Set(frames.map((f) => f.id));
    setNodes((ns) => ns.filter((n) => !dead.has(n.id)));
    pushLog(`✓ 已解散 ${frames.length} 个组合 —— 节点都保留着`);
  }, [nodes, setNodes, pushLog]);

  /*
   * 快捷键 Ctrl / ⌘ + G 组合，加 Shift 解散。
   *
   * 工具栏上没有按钮了，而"选中若干节点 → 组合"是个高频动作，
   * 只在面板里放按钮的话没人找得到。键位与 Figma / Sketch 一致。
   *
   * 输入框里要放行：属性面板正在改名时按 Ctrl+G 不该触发组合。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if ((e.key || '').toLowerCase() !== 'g') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (view !== 'flow' || running) return;
      e.preventDefault();
      if (e.shiftKey) ungroupSelection();
      else groupSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, running, groupSelection, ungroupSelection]);

  const onNodeDragStart = useCallback(
    (e: unknown, node: unknown, dragged: unknown) => {
      const ev = e as { ctrlKey?: boolean; metaKey?: boolean };
      // 没按修饰键就是普通拖动。Mac 上 metaKey 才是习惯键位，一并认。
      if (!ev?.ctrlKey && !ev?.metaKey) return;

      const list = (dragged as FlowNode[]) ?? [];
      const src = list.length > 0 ? list : [node as FlowNode];
      /*
       * 复制组合框 / 任务窗格 = 连里面的节点一起复制。
       *
       * 只复制容器的话，副本的成员指向的还是原件 ——
       * 两个容器圈着同一批节点，拖哪个都会挪动同一批，
       * 而界面上看不出两个容器有什么关系。
       *
       * 窗格尤其明显：它自己不存成员名单（见 engine/pane.ts），
       * 复制出来就是个空窗格，卡片上写着「0 个节点」——
       * 用户复制了窗格，却得到一个空的，而原件好端端在那儿。
       */
      const ids: string[] = [];
      for (const n of src) {
        if (!n?.id) continue;
        ids.push(n.id);
        // 组合框：成员名单存在框上
        if (isFrameNode(n)) {
          for (const m of frameMemberIds(n)) ids.push(m);
        }
        // 窗格：成员是各节点的 paneId 反向指过来的，要现场数
        if (isPaneNode(n)) {
          for (const m of paneMembersOf(nodes, n.id)) ids.push(m);
        }
      }
      const map = duplicateByIds(ids);
      if (!map) return;
      dupMapRef.current = map;
      /*
       * 把新框的成员改指副本。
       * 不改的话新框的成员是原件 id，等于"两个框圈同一批节点"（同上）。
       */
      setNodes((ns) => ns.map((n) => {
        if (!isFrameNode(n)) return n;
        const oldId = Object.keys(map).find((k) => map[k] === n.id);
        if (!oldId) return n;
        const d = { ...(n.data as Record<string, unknown>) };
        d.members = frameMemberIds({ data: d }).map((m) => map[m] ?? m);
        return { ...n, data: d } as FlowNode;
      }));
    },
    [duplicateByIds, nodes, setNodes],
  );

  /** 位移作用在副本上，原件不动 */
  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const map = dupMapRef.current;
      const byId = new Map(nodes.map((n) => [n.id, n]));

      /*
       * 组合框自己不挪 —— 它的位置是算出来的（fitFrames）。
       *
       * 直接改框的位置，下一帧就被重算覆盖，表现为"框拖不动"。
       * 所以把位移转给里面的节点，框再自己跟着长过去。
       * 展开时带上嵌合下级：只挪成员会把串拆断（下级留在原地）。
       */
      const moved: NodeChange<FlowNode>[] = [];
      const rest: NodeChange<FlowNode>[] = [];
      for (const c of changes) {
        /*
         * NodeChange 是六种变更的联合，其中 add 那一条**没有 id**（只有 item）。
         * 所以不能直接写 c.id —— 严格模式下编译不过。
         *
         * 而宽松模式下它不报错、值是 undefined，
         * 于是"新增节点"那条变更会被当成"id 为空的变更"静默跳过，
         * 表现为偶尔某个节点不响应，而且看不出规律。
         * 用 'id' in c 窄化，两种模式都成立。
         */
        const cid = 'id' in c ? c.id : null;
        const hit = cid ? byId.get(cid) : undefined;
        if (c.type === 'position' && hit && isFrameNode(hit)) {
          const dx = (c.position?.x ?? 0) - (hit.position?.x ?? 0);
          const dy = (c.position?.y ?? 0) - (hit.position?.y ?? 0);
          if (dx !== 0 || dy !== 0) {
            const delta = frameDelta(
              nodes, cid as string, dx, dy,
              (id) => descendantsOf(nodes as never, id),
            );
            for (const [id, pos] of Object.entries(delta)) {
              moved.push({ id, type: 'position', position: pos } as NodeChange<FlowNode>);
            }
          }
          continue; // 框自己的那条位移丢掉
        }
        rest.push(c);
      }

      /*
       * 选中扩散：点中框 = 选中它里面所有节点（见 engine/frames 的说明）。
       *
       * 反向不成立 —— 点里面的节点只选中它自己，
       * 否则"改一个节点的参数"会变成"每次都选中一整组"。
       */
      /*
       * 写成 filter().map() 的话，TS 不会把谓词的判定带到 map 里 ——
       * map 收到的仍是完整的联合类型，取 c.id 就又是那个 add 没有 id 的问题。
       * 所以直接在 if 里收：进了分支 c 就被窄化成"选中变更"，一定有 id。
       */
      const picked: string[] = [];
      for (const c of rest) {
        if (c.type === 'select' && c.selected) picked.push(c.id);
      }
      const extra: NodeChange<FlowNode>[] = [];
      if (picked.length > 0) {
        for (const id of selectionWithFrames(nodes, picked)) {
          if (picked.indexOf(id) < 0) {
            extra.push({ id, type: 'select', selected: true } as NodeChange<FlowNode>);
          }
        }
      }

      const final: NodeChange<FlowNode>[] = [...rest, ...extra, ...moved];
      onNodesChange(
        map
          ? final.map((c) =>
              c.type === 'position' && c.id && map[c.id] ? { ...c, id: map[c.id] } : c)
          : final,
      );
    },
    [onNodesChange, nodes],
  );

  /**
   * 收尾：选中副本、取消原件选中。
   *
   * 拖动期间原件一直是 selected（xyflow 拖动即选中），
   * 这里才改，避免拖动过程中高亮来回跳。
   */
  /* ---------------------------------------------------------------- */
  /* 嵌合（Scratch 式上下吸附）                                        */
  /* ---------------------------------------------------------------- */







  const onNodeDragStop = useCallback(() => {
    const map = dupMapRef.current;
    dupMapRef.current = null;
    if (!map) return;

    const newIds: Record<string, boolean> = {};
    for (const oldId of Object.keys(map)) newIds[map[oldId]] = true;

    setNodes((ns) =>
      ns.map((n) => {
        if (newIds[n.id]) return { ...n, selected: true, dragging: false };
        if (map[n.id]) return { ...n, selected: false, dragging: false };
        return n;
      }),
    );
    // 面板一次只显示一个节点，取第一个副本即可
    const first = Object.keys(map).map((k) => map[k])[0];
    if (first) setSelectedId(first);
  }, [setNodes]);

  /** 拖放到画布：需要把屏幕坐标换算成画布坐标 */
  /**
   * 把变量套到画布上的某个节点。
   *
   * 与面板里的点选走的是同一套校验（checkVarForNode），
   * 且校验依据都是 def.meta.varGroups —— 一处声明、两处共用，
   * 不会出现"面板能选、拖放却被拒"的不一致。
   */
  const applyVarToNode = useCallback(
    (nodeId: string, cardId: string) => {
      const target = nodes.find((n) => n.id === nodeId);
      const card = findVar(cardId);
      if (!target || !card) return;

      const def = getDef(target.type);
      const check = checkVarForNode(card, def.meta.varGroups);
      if (!check.ok) {
        // 明确拒绝并说明原因。静默忽略会让用户以为变量坏了。
        pushLog(`✗ ${check.reason}（${def.meta.label}）`);
        void alert({ title: '这个变量用不上', message: check.reason });
        return;
      }

      const groupDef = getVariableGroup(card.group);
      if (!groupDef) return;
      patchNode(nodeId, applyVarTo(target.data as Record<string, unknown>, card));
      pushLog(`✓ ${def.meta.label}「${target.id}」已引用变量「${card.name}」`);
    },
    [nodes, patchNode, pushLog],
  );

  /*
   * 拖放落点 → 画布坐标。
   *
   * 必须直接把**屏幕坐标**（clientX/clientY）交给 screenToFlowPosition：
   * 它内部自己减掉容器偏移（见 xyflow 源码：
   * `const { x: domX, y: domY } = domNode.getBoundingClientRect()`）。
   *
   * 以前这里额外减了一层 wrapperRef 的 bounds，等于**减了两次** ——
   * 落点整体往左上偏一个容器宽度（侧栏约 340px），
   * 拖到画布左侧时算出来是负坐标，节点被放到视口外。
   * 表现是「拖进画布没反应」，而 Ctrl 单击添加走默认位置（120,120）看得见，
   * 于是看起来像「拖放坏了、只能单击添加」。
   */
  const flowPosOf = useCallback((e: DragEvent) => {
    const inst = rfInstance.current;
    if (!inst) return undefined;
    const raw = inst.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined;

    /*
     * 落点夹进可见区域。
     *
     * 为什么必须夹：坐标换算一旦有偏差（多减/少减一层偏移、缩放没除、
     * 容器 rect 取错），算出来的流坐标会落在**视口之外**。
     * 节点其实被创建成功了，只是看不见 —— 用户的观感是"拖了没反应"，
     * 而 Ctrl 单击走默认位置（一定在视口内）却能用，
     * 于是看起来像"拖放坏了"，实际是"拖放到看不见的地方去了"。
     *
     * 夹进视口后，最坏情况只是落点偏一点，不会消失。
     * 而"是否真的被夹过"会写进日志 —— 那一行就是坐标链路出问题的证据。
     */
    const host = wrapperRef.current;
    const w = host?.clientWidth ?? 0;
    const h = host?.clientHeight ?? 0;
    const vp = inst.getViewport();
    if (!w || !h || !vp.zoom) return raw;

    const minX = -vp.x / vp.zoom;
    const maxX = (w - vp.x) / vp.zoom;
    const minY = -vp.y / vp.zoom;
    const maxY = (h - vp.y) / vp.zoom;
    /* 卡片约 240×90，往内收一点，避免贴边时只露一半 */
    const padX = 20;
    const padY = 20;
    const cx = Math.min(Math.max(raw.x, minX + padX), Math.max(minX + padX, maxX - padX));
    const cy = Math.min(Math.max(raw.y, minY + padY), Math.max(minY + padY, maxY - padY));

    if (cx !== raw.x || cy !== raw.y) {
      /*
       * 这一行是**诊断**，不是给用户看的提示。
       * 它出现即说明坐标换算有系统性偏差 —— 两组数的差值就是偏移量，
       * 拿它对一遍侧栏宽度（260）或右栏宽度（340）就能定位多减了哪一层。
       */
      pushLog(
        `⚠ 落点在视口外，已拉回（诊断：算得 ${Math.round(raw.x)},${Math.round(raw.y)}`
        + ` → 实落 ${Math.round(cx)},${Math.round(cy)}；偏移 ${Math.round(cx - raw.x)},${Math.round(cy - raw.y)}）`,
      );
    }
    return { x: cx, y: cy };
  }, [pushLog]);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();

      /* ---- 先判是不是变量 ---- */
      const cardPayload = decodeVarDrag(e.dataTransfer.getData(VAR_DRAG_MIME))
        ?? decodeVarDrag(e.dataTransfer.getData('text/plain'));
      if (cardPayload) {
        // Ctrl / ⌘ 拖动 = 复制一个新变量（与节点复制同一套手感）
        if (e.ctrlKey || e.metaKey) {
          const copy = duplicateVar(cardPayload.cardId);
          if (copy) pushLog(`✓ 已复制变量「${copy.name}」`);
          return;
        }
        /*
         * 找落点下的节点。xyflow 给每个节点渲染的 div 带 data-id，
         * 从事件目标往上找第一个即可 —— 比用坐标反算（要考虑缩放平移）可靠得多。
         */
        let el = e.target as HTMLElement | null;
        let nodeId: string | null = null;
        while (el) {
          const id = el.getAttribute?.('data-id');
          if (id) { nodeId = id; break; }
          el = el.parentElement;
        }
        if (!nodeId) {
          pushLog('✗ 请把变量拖到具体的节点上');
          return;
        }
        applyVarToNode(nodeId, cardPayload.cardId);
        return;
      }

      /* ---- 模块 ---- */
      const modPayload = decodeModuleDrag(e.dataTransfer.getData(MODULE_DRAG_MIME))
        ?? decodeModuleDrag(e.dataTransfer.getData('text/plain'));
      if (modPayload) {
        spawnModule(modPayload.moduleId, flowPosOf(e));
        return;
      }

      const payload = decodeDrag(e.dataTransfer.getData(DRAG_MIME))
        ?? decodeDrag(e.dataTransfer.getData('text/plain'));
      /*
       * 同上：不静默。
       *
       * 走到这里说明 drop 事件确实到了，但 dataTransfer 里没有可用的载荷。
       * 常见原因是 order 被别的 drop 处理器先吃掉并 stopPropagation，
       * 或者拖的来源不是侧栏（比如从别的窗口拖了文字进来）。
       * 给一句提示，用户至少知道"事件到了、数据没到"。
       */
      if (!payload) {
        pushLog('✗ 没能读出拖动的内容 —— 请从左侧节点库里拖');
        return;
      }
      spawnNode(payload, flowPosOf(e));
    },
    [spawnNode, spawnModule, flowPosOf, applyVarToNode, duplicateVar, pushLog],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  /* ---------------- 持久化 ---------------- */

  const save = () => {
    // 触发器是画布上的节点，随 canvases 一起持久化，不再单独落盘
    saveToStorage((k, v) => localStorage.setItem(k, v), { canvases, activeId });
    pushLog('已保存到本地');
  };

  /*
   * 工具栏「导出」：导出整张画布的 JSON。
   *
   * 以前这里自己拼 <a download> 下载，有两个毛病：
   *   · Tauri 的 webview 不接管下载，点了常常什么都没发生
   *   · 导出成功与否**完全不打日志** —— 失败和成功在界面上都一样安静，
   *     用户只能说"导出无效"，而根本无从判断是没跑还是跑到哪一步
   *
   * 现在与脚本 / 说明导出走同一条路（exportText）：
   * 路径我们定、结果能确认、失败明确报出来，日志里还有完整路径。
   */
  const exportJson = () => {
    // 导出前脱敏：LLM 的 apiKey 不能跟着文件走。
    // 这个文件是要发给别人 / 传上仓库的，里面带密钥等于直接交出去，
    // 而填过密钥的人往往不会意识到它存在。
    /*
     * config 必须一起走 —— 以前只导出 nodes/edges/triggers，
     * 于是「导出画布、在另一台机器上导入」会**静默丢掉画布级配置**
     * （MCP 服务与画布参数）。节点里 {{params.路径}} 全部取空，且不报错。
     *
     * 走 redactCanvasConfig：配置里有服务 env 与参数卡，
     * 不脱敏就等于把密钥写进要发给别人的文件。
     */
    /*
     * 运行时状态也要剥（status / output / error / last*），判据走
     * engine/runtimeKeys 那一份，与存模块、设为默认、存预设、复制节点同一套。
     *
     * 这条是**导出独有的**：上面那四个出口都已剥过，只有导出以前没剥。
     * 不剥的话导出的文件里每个节点都带着「上次跑完了」和那次的实际输出 ——
     * 而这个文件是要发给别人的（见本函数开头），output 里可能是脚本执行
     * 结果、接口响应、乃至令牌。收到的人打开就看到一堆绿节点，
     * 会以为这就是流程自带的结果。
     *
     * 存档（localStorage）**不剥**：那是本人本机的，刷新后还想看得见
     * 上次跑的结果 —— 与"要交出去的文件"是两回事。
     */
    /*
     * 顶层**不再带 triggers**。它曾经是独立存储的遗留，现在是纯冗余 ——
     * 与 nodes 里那份完全重复，而导入侧根本不读它（见下面 importJson），
     * 只读 nodes。
     *
     * 冗余副本正是这里出过事的根因：同一份 webhook 校验令牌在两处，
     * nodes 那份走了 redactNodes 被挖空，triggers 这份是裸的 ——
     * 于是导出的文件里明文躺着令牌，而用户看 nodes 是空的，以为剥干净了。
     *
     * 留着它的代价不是这一次，而是"将来 Trigger 再加字段，还得记得剥第二次"。
     * 所以删掉，而不是补一次脱敏。
     *
     * 另：triggers 派生自 canvases（保存后的快照），而 nodes 是正在编辑的
     * 当前状态 —— 两者还可能不同步，导出去的是过期的触发器。又一条删的理由。
     */
    const text = JSON.stringify(
      {
        nodes: stripRuntimeNodes(redactNodes(nodes) as Record<string, unknown>[]),
        edges,
        config: redactCanvasConfig(canvasConfigOf(activeCanvas)),
      },
      null,
      2,
    );
    exportText(
      text,
      'json',
      '流程',
      `（${nodes.length} 个节点、${edges.length} 条连线）`,
    );
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(String(reader.result));
        /*
         * 没有 nodes 数组就**不能**继续 —— 下面两行是整体替换，
         * 拿 undefined 去 setNodes 会把当前画布清空。
         * 而"导入了一个别的文件"是极常见的手误（比如拿了整份备份），
         * 静默清空的代价远大于一句报错。
         */
        if (!Array.isArray(p?.nodes)) {
          pushLog('导入失败：文件里没有节点数组（nodes）—— 当前画布未改动');
          return;
        }
        /*
         * 运行时状态也剥一层 —— 与导出同一份判据。
         *
         * 导出已经剥过了，所以自家文件进来是干净的；这条防的是**别处来的**
         * 文件：手改过的、或剥之前那份老版本导出的。那种文件里每个节点都
         * 带着 status:'success' 和上次的输出，导入后表现为"还没跑就显示
         * 跑完了、点开还看得见上一次的结果"，而用户以为那是这次的。
         *
         * status 剥掉后卡片按 idle 渲染（NodeShell 有 `?? 'idle'` 兜底），
         * output 各处也都有 `?? ''` —— 不会显示成 undefined。
         */
        setNodes(stripRuntimeNodes(p.nodes as Record<string, unknown>[]) as FlowNode[]);
        setEdges(Array.isArray(p.edges) ? p.edges : []);
        /*
         * 配置随画布一起导入，否则导出去再导回来就丢一半。
         * 走 normalizeCanvasConfig：文件可能手改过，字段不一定是数组。
         */
        if (p.config && activeId) {
          setCanvases((cs) => updateCanvasConfig(cs, activeId, normalizeCanvasConfig(p.config)));
        }
        // 触发器现在是画布上的节点，随 nodes 一起导入，不再单独存储
        pushLog(`已导入 ${p.nodes.length} 个节点、${p.edges?.length ?? 0} 条连线`);
      } catch { pushLog('导入失败：不是合法 JSON'); }
    };
    reader.readAsText(file);
  };

  /* ---------------- 执行 ---------------- */

  const onEvent = useCallback((e: RunEvent) => {
    // 同步到任务窗口。用 id 定位当前任务，避免依赖 tasks 数组
    const tid = currentTaskRef.current;
    if (tid) {
      setTasks((list) => list.map((t) => (t.id === tid ? applyEvent(t, e) : t)));
    }
    if (e.type === 'node-status') {
      setNodes((ns) => ns.map((n) => (n.id === e.id ? { ...n, data: { ...n.data, status: e.status } } as FlowNode : n)));
    } else if (e.type === 'node-chunk') {
      /*
        原实现把 output 设成了原值 —— chunk 根本没被追加，
        流式输出在界面上等于失效。这里改成真正的追加。
        任务窗口能实时看到输出，靠的就是这一行。
      */
      setNodes((ns) => ns.map((n) => (n.id === e.id ? { ...n, data: { ...n.data, output: clampOutput(((n.data as { output?: string }).output ?? '') + e.chunk) } as TaskNodeData } as FlowNode : n)));
    } else if (e.type === 'node-done') {
      setNodes((ns) => ns.map((n) =>
        n.id === e.id
          ? ({
              ...n,
              data: {
                ...n.data,
                status: e.ok ? 'success' : 'failed',
                output: e.output,
                error: e.error ?? '',
                // OCR / 翻译节点显示字数，方便一眼看出有没有拿到内容
                lastChars: isOcr(n.data) || isTranslate(n.data) ? (e.output ?? '').length : undefined,
              },
            } as FlowNode)
          : n));
    } else if (e.type === 'node-fields') {
      /*
        把识别到的文件写回节点并持久化。
        这样即使不运行，打开面板也能看到"上次改了哪些文件"，
        排查问题时不必重跑一遍。
      */
      /*
        具名输出（标题 / 链接 / 字数 …）也一起写回节点。
        它同时是输出卡片上那几行要显示的内容 —— 不写的话
        多输出节点除了主输出那一行全是空白，看着像"没产出东西"。
      */
      /*
       * 这两个是**运行时回写**字段（上次跑出来的结果），不是配置，
       * 所以没写进各个节点数据类型 —— 写了就得在每个类型上重复一遍，
       * 漏一个就是类型错误。字面量检查会把它们判成多余属性，
       * 因此这里绕开字面量检查（本文件已有先例）。
       */
      setNodes((ns) => ns.map((n) =>
        (n.id === e.id ? { ...n, data: { ...(n.data as Record<string, unknown>), lastFiles: e.files, lastFields: e.fields } } as unknown as FlowNode : n)));
      if (e.files.length > 0) {
        pushLog(`📎 ${e.id} 识别到 ${e.files.length} 个文件：${e.files.slice(0, 3).join(', ')}${e.files.length > 3 ? ' …' : ''}`);
      }
    } else if (e.type === 'layer-start') {
      pushLog(`第 ${e.layer + 1}/${e.total} 层开始：${e.ids.join(', ')}`);
    } else if (e.type === 'update-checked') {
      pushLog(`🔍 ${e.id} ${e.reason}`);
      // 把新基线写回节点并持久化：否则下次运行又当成"首次"，永远检测不到更新
      setNodes((ns) => ns.map((n) =>
        (n.id === e.id ? { ...n, data: { ...n.data, ...(e.patch ?? {}) } } as FlowNode : n)));
    } else if (e.type === 'loop-resolved') {
      const w = e.warnings.length ? ` ⚠ ${e.warnings.join('；')}` : '';
      pushLog(`⟲ ${e.id} 循环开始：${e.reason}（${e.count} 轮）${w}`);
    } else if (e.type === 'loop-iteration') {
      pushLog(`  ⟲ 第 ${e.index + 1}/${e.count} 轮：${e.item.slice(0, 60)}`);
    } else if (e.type === 'loop-done') {
      pushLog(e.failed > 0
        ? `⟲ ${e.id} 循环结束：${e.rounds} 轮，其中 ${e.failed} 轮失败`
        : `⟲ ${e.id} 循环结束：${e.rounds} 轮全部成功`);
    } else if (e.type === 'run-error') {
      pushLog(`✗ ${e.message}`);
    } else if (e.type === 'node-error') {
      // 前置失败（缺执行器 / 参数不合法）不会走 node-done，
      // 不在这里接住的话，节点只会变红而没有任何原因可看
      pushLog(`✗ ${e.id} ${e.error}`);
      setNodes((ns) => ns.map((n) =>
        (n.id === e.id ? { ...n, data: { ...n.data, status: 'failed', error: e.error } } as FlowNode : n)));
    } else if (e.type === 'run-done') {
      pushLog(e.ok ? '运行结束：全部成功' : '运行结束：存在失败或跳过');
    }
  }, [setNodes, pushLog]);

  /**
   * 跑一轮工作流。
   * @param inputOverride 触发器注入的全局输入，优先级高于工具栏里的输入框
   */
  /**
   * @param targetCanvasId 跑哪张画布。
   *
   * 不传 = 跑当前激活的画布（手动点运行时是这种）。
   * 传了 = 跑指定画布 —— **全局触发器靠这个**：
   * 后台触发器可能属于一张根本没打开的画布，
   * 不指定就变成"跑当前这张"，于是半夜自己跑起来的其实是错的流程。
   */
  const run = useCallback(async (
    inputOverride?: string,
    source: TaskSource = 'unknown',
    targetCanvasId?: string,
    entryNodeId?: string,
  ): Promise<boolean> => {
    if (running) {
      pushLog('已有任务在运行，本次触发被跳过');
      return false;
    }
    setRunning(true);

    /* 目标画布 ≠ 当前画布时，用那张画布的内容跑 */
    const tgtId = targetCanvasId && targetCanvasId !== activeId ? targetCanvasId : activeId;
    const tgtCanvas = canvases.find((c) => c.id === tgtId);
    if (targetCanvasId && !tgtCanvas) {
      pushLog(`⚠ 触发的画布「${targetCanvasId}」找不到，本次跳过`);
      setRunning(false);
      return false;
    }
    /*
     * 组合框与任务窗格都不进执行图。
     *
     * 它们没有任何执行器，进去后会是一个"永远直通"的孤立节点；
     * 而孤立节点在按触发器定范围时会被排除，于是"有时报错有时不报"，
     * 取决于这张画布上有没有触发器 —— 最难自查的那类问题。
     *
     * 窗格尤其要排除：它是"一批节点的共享配置"，本身不代表一个步骤。
     * 进图后它会占一个节点位、出现在任务记录里，
     * 而用户数节点数时不会把它算进去 —— 表现为"任务记录里多出一个看不懂的节点"。
     */
    const runNodes = (tgtCanvas && tgtCanvas.id !== activeId
      ? (tgtCanvas.nodes as FlowNode[])
      : nodes).filter((n) => !isFrameNode(n) && !isPaneNode(n));
    const runEdges = tgtCanvas && tgtCanvas.id !== activeId
      ? (tgtCanvas.edges as Edge[])
      : edges;

    /*
     * 嵌合 = 一条隐式边（上方 → 下方）。这里先算出来：
     * 任务记录要抄一份连线去画流程图，下面拼执行图也要用 ——
     * 两处各算一次会不一致（图上连着、跑起来却没这条边）。
     */
    const stackE = stackEdges(runNodes as never);

    /*
     * 入口判定 —— 所有流程都从触发器开始。
     *
     * 以前这里不判：画布上所有节点一律排个序全跑。于是角落里那个
     * 从没接过东西的调试节点也照跑，夜间定时任务还会把它一起带起来；
     * 它连不上任何输入，失败时把整条流程标红，日志里混进一堆
     * 与本次触发毫无关系的记录。
     *
     * 放在**建任务记录之前**：判掉的话不该留下一条空任务，
     * 否则任务窗口里会出现一条 0 条记录的条目，看着像跑崩了。
     */
    const entryIds = runNodes
      .filter((n) => isActiveTrigger(n.data as Record<string, unknown>))
      .map((n) => n.id);
    if (entryIds.length === 0) {
      pushLog(`✗ ${ERR_NO_TRIGGER}（先在画布上放一个触发器并启用）`);
      setRunning(false);
      return false;
    }

    /*
     * 自动触发必须指定入口，只跑被触发的那一条链路。
     *
     * 不指定会退化成"从全部触发器出发" —— 于是某个周期任务到期
     * 会把整张画布所有触发链路全带起来，等于一次触发、全部重跑。
     */
    let entryId: string | undefined;
    if (entryNodeId !== undefined) {
      if (!runNodes.some((n) => n.id === entryNodeId)) {
        pushLog(`✗ 入口触发器 ${entryNodeId} 不在画布上，本次不执行`);
        setRunning(false);
        return false;
      }
      if (!entryIds.includes(entryNodeId)) {
        pushLog('✗ 入口触发器未启用（节点已关闭，或没有启用的触发条件），本次不执行');
        setRunning(false);
        return false;
      }
      entryId = entryNodeId;
    }

    /*
     * 从这里往下全是可能抛的（建任务记录、跑图、归档）。
     * 整段包 try/finally：**无论多意外的路径，running 都必须放行** ——
     * 没有保底的话，一次 reject 就让 running 永久为 true：按钮全灰、
     * 所有触发器被「已有任务在运行」跳过，用户只能重载插件。
     * 这是本项目最防的「点了没反应」的终极形态。
     */
    try {
    /*
     * 任务总数按**这一条链路**估，而不是全画布节点数。
     *
     * progressOf 取 max(task.total, 实际出现数)：分母若含范围外节点，
     * 百分比永远到不了 100%，表现为"跑完了却卡在 70%"。
     */
    const scopeTotal = entryId === undefined
      ? runNodes.length
      : reachableFrom(
        [entryId],
        [
          ...runEdges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
          ...stackE.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        ] as never,
      ).size;

    // 建一条任务记录。total 先按节点数估，运行时以实际出现的节点为准
    const task = makeTask({
      canvasId: tgtId ?? '',
      canvasName: tgtCanvas?.name ?? canvases.find((c) => c.id === activeId)?.name ?? '未命名流程',
      source,
      total: scopeTotal,
      /*
       * 标题与连线一起抄进任务记录 —— 任务窗口与历史要画流程图。
       * 只存 id 的话图上写的就是 mamu7obyv93 这种乱码，看不出这一步干什么；
       * 只存顺序不存连线的话，那是一列而不是图，分不出"等待"和"阻断"。
       */
      labels: Object.fromEntries(
        runNodes.map((n) => [n.id, String((n.data as { label?: string }).label ?? n.id)]),
      ),
      edges: [
        ...runEdges.map((e) => ({ source: e.source, target: e.target })),
        ...stackE.map((e) => ({ source: e.source, target: e.target })),
      ],
      /*
       * 坐标快照 —— 流程图要画成画布当时那个样子。
       * 嵌合展开出来的节点没有坐标（它们不在画布 nodes 里），
       * 缺的那些会退回分层网格，不会画到 (0,0) 叠成一团。
       */
      positions: Object.fromEntries(
        runNodes.map((n) => [n.id, { x: n.position?.x ?? 0, y: n.position?.y ?? 0 }]),
      ),
      /*
       * 变量快照（名字 + 摘要）—— 流程图上要标"这一步用的哪个变量"。
       * 只收引用了的节点：绝大多数节点没用变量，全存一遍是白占空间。
       */
      vars: Object.fromEntries(
        runNodes
          .map((n) => [n.id, varSnapshotOf(n.data)] as const)
          .filter(([, vs]) => vs.length > 0),
      ),
    });
    currentTaskRef.current = task.id;
    setTasks((list) => [task, ...list]);
    // 自动切到任务窗口，让人立刻看到进度 ——
    // 触发器半夜跑起来时，停留在画布上看不出发生了什么
    setView('tasks');
    /*
      顺带把右栏切到「日志」。

      右栏改成页签之后，属性与日志不再同时可见 ——
      停在属性页跑一个流程，进度一条都看不到，
      看起来就像这一跑根本没开始。
    */
    setRightTabRaw('log');
    setSummary(null);
    activeRuns.current.clear();
    paneSessions.current.clear();
    const controller = new AbortController();
    abortRef.current = controller;
    const stamp = String(Date.now());

    /*
     * lastFields 也要清。
     * 留着的话"这次没跑到"与"上次的值"分不开 ——
     * 卡片上仍显示着上一次的标题，而这次其实没产出。
     */
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...(n.data as Record<string, unknown>), output: '', error: '', status: 'idle', lastFields: {} } } as unknown as FlowNode)));

    /*
     * 先展开模块，再执行。
     *
     * 展开在这里做而不是塞进 runner：runner 是纯逻辑层、
     * 拿不到 localStorage 里的模块库（测试在 Node 下跑它）。
     * 所以由调用方注入 resolve —— 这是 App 才有的能力。
     */
    /*
     * 嵌合 = 一条隐式边（上方 → 下方）。拼进 edges 后，
     * 拓扑排序、失败传播、跳过全部自动成立 ——
     * 引擎里不需要为"嵌合"写任何专门逻辑。
     */
    const rawGraph: Graph = {
      nodes: runNodes.map((n) => ({ id: n.id, data: n.data })),
      edges: [
        ...runEdges.map((e) => ({
          id: e.id, source: e.source, target: e.target,
          // 条件分支用 branch，循环出口用 loopRole——两者语义不同，不能混
          branch: e.data?.branch,
          loopRole: e.data?.loopRole,
        })),
        ...stackE.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      ],
    };

    /*
     * 先展开模块，再展开跨画布引用 —— 顺序不能反。
     *
     * 模块展开后才会出现内部的画布引用节点；反过来先把画布展开了，
     * 模块内部那些引用节点就漏掉了。
     */
    const afterModules = expandModules(rawGraph as never, (moduleId) => findModule(moduleId));

    const canvasExpanded = expandCanvasRefs(afterModules as never, (canvasId) => {
      const c = canvases.find((x) => x.id === canvasId);
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        nodes: (c.nodes ?? []) as never,
        edges: (c.edges ?? []) as never,
      };
    });
    /*
     * 跨画布展开的问题**必须说出来** ——
     * 找不到画布或成环时，被跳过的是一个整块，
     * 静默跳过会让用户看到"下游没输出"却毫无线索。
     */
    for (const p of canvasExpanded.problems) {
      pushLog(`⚠ 跨画布调用「${p.instanceId}」被跳过：${p.reason}`);
    }
    const graph = canvasExpanded as unknown as Graph;

    /*
     * 模块被删了但画布上还留着实例 —— 展开时会退化成一个空壳节点，
     * 执行时"什么都不做"却也不报错，用户只会看到下游没输出。
     * 这里显式查一遍并提示。脱钩过的实例（自带 inner）不算。
     */
    const brokenModules = rawGraph.nodes
      .filter((n) => {
        const d = n.data as unknown as Record<string, unknown>;
        return d?.kind === 'module' && !d?.inner && !findModule(String(d?.moduleId ?? ''));
      })
      .map((n) => n.id);
    if (brokenModules.length > 0) {
      pushLog(`✗ 模块已删除：${brokenModules.join('、')}（可在属性面板里脱钩后自行编辑）`);
    }

    const executor: Executor = async (node, rendered, onChunk) => {
      const runId = `${stamp}:${node.id}`;
      activeRuns.current.set(node.id, runId);
      // 执行器只会被任务节点调用：条件/触发器/并发节点在执行器内部处理并 continue
      const d = node.data as TaskNodeData;
      /*
       * 工作目录 / 模型 / 自动批准一律走窗格解析后的生效值。
       *
       * 直接读 d 的话，窗格上填的目录永远轮不上 ——
       * 节点上没填目录时传下去的是空串，CLI 就跑在默认目录里，
       * 而窗格卡片上明明写着那个目录：界面说一套、跑的是另一套，且不报错。
       */
      const eff = resolveTaskPane(d, findPane(graph?.nodes ?? [], d.paneId));
      /*
       * 会话衔接：这个窗格本次已经开过会话，就带上 `-c` 接着那一次跑。
       *
       * 第一个成员不带 —— 它没有"上一次"，带上去接的是 CLI 全局记的那一次，
       * 可能是用户在自己终端里跑的，表现为"节点读到了一段没见过的历史"。
       */
      const cont = eff.canRelay && eff.paneId !== '' && paneSessions.current.has(eff.paneId);
      if (eff.canRelay && eff.paneId !== '') paneSessions.current.add(eff.paneId);
      /*
       * runCli 进程真正结束才 resolve（DonePayload 就是结局）。
       * 此前它在 invoke('run_node') 一返回就 resolve —— 那条 invoke
       * 只负责启动进程。于是这里 await 完去读 doneRef 必然是 null：
       * 桌面端每个 CLI 节点「启动即失败」，且 runId 已从 activeRuns
       * 删掉，进程成孤儿（停止按钮杀不到）。
       */
      const done = await runCli(
        { runId, cli: eff.cli, cmd: DEFAULT_CMD[eff.cli], prompt: rendered,
          workdir: eff.workdir, model: eff.model, yolo: eff.yolo, cont },
        {
          onStdout: (c) => onChunk(c),
          onStderr: (c) => onChunk(c),
          onDone: () => { /* 结局经返回值拿，不走 ref 中转 */ },
        },
      );
      activeRuns.current.delete(node.id);
      if (!done.success) throw new Error(`CLI 退出码 ${done.code ?? '未知'}`);
      return '';
    };

    /* 文件操作执行器：真正干活的是 Rust 的 fs_op 命令 */
    const fsExecutor: FsExecutor = async (node, args) => {
      const d = node.data as FsNodeData;
      const res = await fileOp(fsArgsOf(d, args));
      return res.text;
    };

    /*
     * 读表格执行器：走 Rust 的 fs_op（浏览器里没有磁盘权限）。
     *
     * 用 read 操作读文本，不复用 fsExecutor ——
     * 后者要 node.data 是 FsNodeData（带 op 字段），
     * 而表格节点的 data 形状不同，硬套会拿到 undefined 的 op。
     */
    const tableReader = async (path: string): Promise<string> => {
      const res = await fileOp({
        op: 'read', path, target: '', content: '',
        recursive: false, force: false, dryRun: false,
        maxBytes: 20 * 1024 * 1024, exts: [],
      });
      if (!res.ok) throw new Error(res.text || `读不到文件：${path}`);
      return res.text;
    };

    /* 网络抓取执行器：更新检测节点用，经 Tauri 的 http 插件发出 */
    const fetcher: Fetcher = async (_node, url, o) => {
      const res = await fetchText(url, {
        headers: o.headers,
        timeoutSec: o.timeoutSec,
        /* 节点超时 / 停止：浏览器模式能真的断开，桌面端至少不再傻等 */
        signal: o.signal,
      });
      if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}`);
      return res.text;
    };

    const effectiveInput = inputOverride !== undefined && inputOverride !== '' ? inputOverride : globalInput;

    /*
     * 画布参数 → 模板里的 {{params.名字}}。
     *
     * 用 Record 而不是数组：渲染时每个变量都查一次表，
     * 数组 find 是线性扫描，长流程里会白跑很多次。
     */
    const paramsForRun: Record<string, string> = {};
    for (const p of activeParams) {
      const n = String(p?.name ?? '').trim();
      if (!n) continue;
      // 走 paramRunValue：布尔卡要收敛成 true/false，不能把「真」这个字填进模板
      paramsForRun[n] = paramRunValue(p);
    }

    /*
     * 运行前先查一遍：有没有引用了却没定义的画布参数。
     *
     * 不查的话，缺失的参数在模板里**原样保留** ——
     * 于是路径变成字面量 "{{params.输出目录}}/a.md"，
     * 文件真被写到了一个奇怪的地方，而日志里没有任何提示。
     * 这类"跑了但结果是错的"比直接失败难查得多。
     */
    const paramUsed = new Set<string>([
      ...paramRefsOfNodes(nodes),
      ...moduleParamRefs,
    ]);
    const paramMissing = [...paramUsed].filter((n) => !(n in paramsForRun)).sort();
    if (paramMissing.length > 0) {
      pushLog(`⚠ 这些画布参数被引用了但没定义：${paramMissing.join('、')} —— 会原样留在文本里`);
    }
    /* 大模型调用：走 Tauri http 插件（若启用），否则退回浏览器 fetch */
    const llmCaller: LlmCaller = async (req) =>
      postJson(req.url, req.body, req.headers, req.timeoutSec);

    /* 本地图片读取：桌面端才有，浏览器模式会抛错并由节点转成提示 */
    const imageReader: ImageReader = (path) => readImageDataUrl(path);

    /* 本地音频读取（播放音频节点用）。经 Rust 命令，格式校验在那边做 */
    const playAudioReader = async (path: string): Promise<string> =>
      readAudioDataUrl(path);

    /*
     * GitHub 执行器。
     *
     * 这里只补"发请求"这一环（github.ts 里的策略与解析是纯函数，已有单测）。
     * 令牌优先取凭据库里的，没有才用节点内联值 —— 与 OCR / 翻译节点一致。
     * cli 方案不接线：run_node 是给 AI CLI 用的，跑不了 git，
     * 硬塞一个会让它"看起来能用"然后在真机上失败，不如明确报"未提供 git 执行器"。
     */
    const ghFetcher: GithubFetcher = async (url, init) => {
      const r = await httpRequest(url, {
        headers: init?.headers,
        timeoutSec: 20,
        withDefaultUa: false,   // GitHub API 要自己的 UA
      });
      return { status: r.status, ok: r.ok, text: r.text, headers: r.headers };
    };

    const githubFetch: GithubUpdateRunner = async (req) => {
      const token = resolveSecret(credentials, req.credentialId, req.token);
      const r = await fetchUpdate(
        ghFetcher,
        { owner: req.owner, repo: req.repo, branch: req.branch },
        { token, base: req.base, order: req.order },
      );
      if (!r.ok) return { ok: false, error: r.error };
      const i = r.value;
      return {
        ok: true,
        via: r.via,
        info: {
          branch: i.branch, sha: i.sha, message: i.message,
          author: i.author, date: i.date, updated: i.updated,
        },
      };
    };

    const githubPush: GithubPushRunner = async (req) => {
      const token = resolveSecret(credentials, req.credentialId, req.token);
      const r = await pushFiles(
        ghFetcher,
        { owner: req.owner, repo: req.repo, branch: req.branch },
        {
          token,
          branch: req.branch,
          message: req.message,
          files: req.files,
          workdir: req.workdir,
          order: req.order,
        },
      );
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, via: r.via, commit: r.value.commit };
    };

    /*
     * 通用 HTTP 执行器：给「HTTP 请求」节点用。
     *
     * 与 fetcher 的区别 —— fetcher 只会 GET 且只回文本，而这里要能指定方法、
     * 请求体，并把状态码与响应头一并带回来（节点靠 status 判 4xx 是否算失败）。
     * 两者共用 httpRequest 这条通道：先 Tauri 插件，不通再降级浏览器。
     */
    const httpRequester: HttpRequester = async (url, o) => {
      const r = await httpRequest(url, {
        method: o.method,
        headers: o.headers,
        body: o.body,
        timeoutSec: o.timeoutSec,
        maxBytes: o.maxBytes,
        /* 节点超时 / 停止：浏览器模式真的断开连接，桌面端不再傻等 */
        signal: o.signal,
      });
      return { status: r.status, ok: r.ok, text: r.text, headers: r.headers };
    };

    const result = await runGraph(graph, {
      concurrency, executor, fsExecutor, fetcher, llmCaller, imageReader,
      githubFetch, githubPush, httpRequester, credentials, playAudioReader, tableReader,
      input: effectiveInput, onEvent, signal: controller.signal,
      /*
       * 入口触发器 —— 只跑从它出发的那一条链路。
       *
       * 不传的话引擎会以图上全部触发器为起点，那等于
       * "一次自动触发，整张画布所有链路全跑一遍"。
       */
      entry: entryId,
      /*
       * 人工输入：跑到该节点时弹框等人填。
       *
       * 用 dialog 的 prompt —— 它是外壳提供的模态输入，
       * 与插件里其它确认框同一套外观。返回 null 表示取消。
       */
      askHuman: async (promptText, defaultValue) => {
        /* dialog.prompt 收**对象**不是位置参数（写成位置参数时 message 是 undefined，
           弹框会没有提示语，而且 tsc 查不出来 —— dialog.js 是 js 不查参）。 */
        const answer = await prompt({ message: promptText, defaultValue: defaultValue ?? '' });
        // 取消时 dialog 给 undefined / null，统一成 null
        return answer === undefined || answer === null ? null : String(answer);
      },
      // 嵌合的输出传递要用到带位置的节点（含 stackParent 关系）
      stackNodes: nodes.map((n) => ({
        id: n.id,
        position: { x: n.position.x, y: n.position.y },
        data: n.data as Record<string, unknown>,
      })),
      /*
       * 画布参数（{{params.名字}}）。
       *
       * 传的是**当前画布**的那一份 —— 模块展开后内部节点也在这张图上，
       * 于是自动取到本画布的值：同一个模块在 A、B 两张画布上
       * 用同一句 {{params.输出目录}}，各取各的。
       */
      params: paramsForRun,
    });
    setSummary(result);
    const finishedId = currentTaskRef.current;
    if (finishedId) {
      setTasks((list) => list.map((t) => {
        if (t.id !== finishedId) return t;
        const done = finishTask(t, result.ok);
        // 归档：任务窗口是当前会话的实时态，历史面板是跨会话的归档
        saveHistory(addToHistory(historyRef.current, done).file);
        return done;
      }));
      currentTaskRef.current = null;
    }
    return result.ok;
    } catch (e) {
      /*
       * 崩溃也要留得下证据：任务记录标失败（别让任务窗口挂着一条
       * 永不完案的记录），错误进日志。返回 false 而不是再抛 ——
       * 调用方（调度器 / 手动触发）拿不到结果就会当成失败处理，
       * 而再抛一次只会变成 unhandled rejection，照样静默。
       */
      pushLog(`✗ 流程执行崩溃：${describeErr(e)}`);
      const crashedId = currentTaskRef.current;
      if (crashedId) {
        setTasks((list) => list.map((t) => (t.id === crashedId ? finishTask(t, false) : t)));
        currentTaskRef.current = null;
      }
      return false;
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running, nodes, edges, concurrency, globalInput, onEvent, setNodes, pushLog, activeId, canvases, saveHistory, credentials]);

  // 调度器通过 ref 调用 run，避免闭包捕获旧状态
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  const runningRef = useRef(running);
  useEffect(() => { runningRef.current = running; }, [running]);

  /*
   * 卡片上的「手动触发」。
   *
   * 以前只有工具栏那个「运行」按钮能手动跑 —— 触发器节点上写着
   * 「点「运行」时立即执行一次」，却**没有任何可点的东西**，
   * 得先去别处找一个按钮。而多触发器时用户不知道点「运行」跑的是哪个。
   *
   * 依赖只放稳定引用（runRef / runningRef / setNodes），
   * 于是这个函数本身是稳定的 —— 被塞进节点 data 后不会让整批节点
   * 每次渲染都重建（xyflow 会据此全量重渲染）。
   */
  const fireManualTrigger = useCallback((nodeId: string) => {
    if (runningRef.current) {
      pushLog('已有任务在运行，本次触发被跳过');
      return;
    }
    /*
     * 带上入口 id：只跑这张卡所在的那条链路。
     *
     * 不传的话等于"从全部触发器出发"，点一张卡会把别的触发器
     * 的链路也一起跑起来 —— 而卡片上写的是"触发"，用户只会以为跑了一个。
     */
    void runRef.current?.(undefined, 'manual', undefined, nodeId).then((ok) => {
      // 与调度器触发同一套落款：卡片上就能看到"上次触发"的时间与方式
      setNodes((ns) => ns.map((n) => (
        n.id === nodeId && isTrigger(n.data)
          ? ({
            ...n,
            data: {
              ...n.data,
              lastFiredAt: Date.now(),
              lastFiredKind: 'manual',
              status: ok ? 'success' : 'failed',
            },
          } as FlowNode)
          : n
      )));
    }).catch((err: unknown) => {
      // run 内部已有保底（catch + finally），正常到不了这里；
      // 但漏 catch 的 .then 会把意外 reject 变成 unhandled rejection ——
      // 界面上什么都不显示，与「点了没反应」同形。
      pushLog(`✗ 手动触发失败：${describeErr(err)}`);
      setNodes((ns) => ns.map((n) => (
        n.id === nodeId && isTrigger(n.data)
          ? ({ ...n, data: { ...n.data, status: 'failed' } } as FlowNode)
          : n
      )));
    });
  }, [pushLog, setNodes]);

  /*
   * 给触发器节点塞一个「手动触发」回调。
   *
   * 走 data 而不是别的通道：卡片组件只拿得到自己这一个节点，
   * 而它是按 node.type 从注册表里取的，没有别的入口能传 props。
   *
   * 放在 fireManualTrigger **之后**：那是 const，提前用会撞 TDZ。
   *
   * 函数是非可序列化的，落盘时 JSON.stringify 会直接丢掉它；
   * 另外也进了 VIEW_KEYS，复制 / 存模块时会被剥掉。
   */
  /*
   * 参数连线带来的**类型错**，按节点分组。
   *
   * 这里是唯一能算它的位置：要看"上游产出什么"，
   * 而卡片组件只拿得到自己那一个节点。
   *
   * 挂在 useMemo 上而不是每次渲染重算：它要遍历全部连线，
   * 而画布每拖一下就会重渲染一次。
   */
  const argLinkIssues = useMemo(
    () => paramLinkIssues(nodes, paramLinksOf(edges)),
    [nodes, edges],
  );

  const canvasNodes = useMemo(
    () => framedNodes.map((n): typeof n => {
      const issues = argLinkIssues[n.id];
      if (!issues && !isTrigger(n.data)) return n;
      /*
       * 先落到 Record 再交回去。
       *
       * 直接写字面量会撞多余属性检查（TS2353）——
       * onFireManual / argLinkIssues 是**运行时临时挂上**的，
       * 不属于任何节点自己的 data 类型（它们不是配置，
       * 落盘时会被丢掉、复制时会被剥掉）。
       * 交给一个 Record 变量中转就没有"字面量新鲜度"了，检查自然放过。
       */
      const data: Record<string, unknown> = { ...(n.data as Record<string, unknown>) };
      if (issues) data.argLinkIssues = issues;
      if (isTrigger(n.data)) data.onFireManual = fireManualTrigger;
      return { ...n, data } as typeof n;
    }),
    [framedNodes, fireManualTrigger, argLinkIssues],
  );

  /*
   * 画线前把**老参数连线**的 handle 补成输出端口写法。
   *
   * 升级前连好的线 sourceHandle 是裸 'out'（那时它兼作参数出口）。
   * 现在输出端口叫 'out:xxx'，不补的话 xyflow 找不到对应的口子，
   * 线会画不出来或落到节点中心 —— 而 data.kind 仍是 'param'，
   * 值还照常取。于是"线看不见、值却是对的"，最难联想的一种。
   *
   * 只在渲染时补，不改存档：要的只是线画在正确的口子上。
   */
  const canvasEdges = useMemo(() => normalizeParamEdges(edges), [edges]);



const globalTriggersRef = useRef<GlobalTrigger[]>([]);
  const triggersRef = useRef(triggers);
  useEffect(() => { triggersRef.current = triggers; }, [triggers]);
  useEffect(() => { globalTriggersRef.current = allGlobalTriggers; }, [allGlobalTriggers]);

  /* ---------------- 触发器调度 ---------------- */

  const scheduler = useMemo(
    () => new TriggerScheduler({
      getTriggers: () => triggersRef.current,
      onFire: async (t, _reason, payload) => {
        // webhook 与对话触发都会带 payload（请求体 / 命中的对话内容），
        // 它们优先于触发器的固定输入 —— 用户要的正是"把当时的内容传进去"
        const injected = payload ? payload : t.input;
        // 把触发方式带进任务记录：任务窗口里要能分清
        // 「我手动点的」和「半夜自己跑起来的」
        const src: TaskSource =
          t.kind === 'interval' ? 'interval'
            : t.kind === 'cron' ? 'cron'
              : t.kind === 'watch' ? 'watch'
                : t.kind === 'webhook' ? 'webhook'
                  : t.kind === 'chat' ? 'chat'
                    : 'manual';
        /*
         * 带上触发器所属画布 —— 后台触发器可能属于一张没打开的画布，
         * 不指定就变成"跑当前这张"，半夜自己跑起来的会是错的流程。
         */
        const gt = globalTriggersRef.current.find((x) => x.id === t.id);
        const ok = await runRef.current(injected, src, gt?.canvasId, t.nodeId);
        // 触发记录写回画布上的触发器节点，直接在节点卡片上就能看到"上次触发时间"
        const targetId = t.nodeId ?? t.id;
        setNodes((ns) => ns.map((n) =>
          (n.id === targetId && isTrigger(n.data)
            ? ({ ...n, data: { ...n.data, lastFiredAt: Date.now(),
                lastFiredKind: t.kind,
                status: ok ? 'success' : 'failed' } } as FlowNode)
            : n)));
        return ok;
      },
      log: pushLog,
    }),
    [pushLog],
  );

  useEffect(() => {
    scheduler.start();
    return () => scheduler.stop();
  }, [scheduler]);

  // 为启用的 watch 触发器注册/注销目录监听
  const watchCleanups = useRef<Map<string, () => void>>(new Map());
  /* 每个监听启动时用的配置指纹（目录 + 递归开关）。
     启用中改这两个字段必须**停旧起新**：后端同 id 直接跳过不更新路由，
     只按 id 去重的话，界面显示新目录、实际监听旧目录 —— 用户改了没生效
     且不报错，只会以为这个功能坏了。 */
  const watchCfg = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!watchSupported) return;
    const wanted = new Map<string, Trigger>(
      triggers
        .filter((t) => t.kind === 'watch' && t.enabled && t.config.watchDir)
        .map((t) => [t.id, t] as const),
    );
    const keyOf = (t: Trigger) => JSON.stringify([t.config.watchDir, !!t.config.watchRecursive]);

    // 关掉不再需要的 + 配置变了的
    for (const [id, cleanup] of watchCleanups.current) {
      const t = wanted.get(id);
      if (!t || watchCfg.current.get(id) !== keyOf(t)) {
        cleanup();
        watchCleanups.current.delete(id);
        watchCfg.current.delete(id);
      }
    }

    // 新开缺失的（含配置变了重起的）
    for (const [id, t] of wanted) {
      if (watchCleanups.current.has(id)) continue;
      const key = keyOf(t);
      watchCfg.current.set(id, key);
      /*
       * tracked start：cleanup 先占位再等 promise 落地。
       * 直接 .then 里 set 的话，"起到之前就被要求停"（改配置紧接着又改）
       * 会漏停 —— 监听还是起来了，只是没人记得它。这里起到时若已标停，
       * 起到即停。
       */
      let stopped = false;
      let landed: (() => void) | null = null;
      const mine = () => { stopped = true; landed?.(); };
      watchCleanups.current.set(id, mine);
      void startWatch(id, t.config.watchDir, t.config.watchRecursive, (path) => {
        scheduler.notifyWatch(path);
      }).then((cleanup) => {
        if (cleanup) landed = cleanup;
        // 起到之前就被要求停（改配置紧接着又改）：起到即停，不留没人记得的监听
        if (stopped) landed?.();
      }).catch((err: unknown) => {
        // 起失败：只摘自己的占位（可能已被新配置接管），清指纹让下次重试
        if (watchCleanups.current.get(id) === mine) {
          watchCleanups.current.delete(id);
          watchCfg.current.delete(id);
        }
        pushLog(`✗ 目录监听启动失败（${t.config.watchDir || '未填目录'}）：${describeErr(err)}`);
      });
    }
  }, [triggers, watchSupported, scheduler, pushLog, describeErr]);

  useEffect(() => () => {
    watchCleanups.current.forEach((c) => c());
    watchCleanups.current.clear();
  }, []);

  // 为启用的 webhook 触发器启动本地 HTTP 服务
  const webhookCleanups = useRef<Map<string, () => void>>(new Map());
  /* 启动时用的配置指纹（端口/路径/令牌）。
     启用中改这三项必须停旧起新：Rust 侧同 id 直接跳过不更新路由，
     只按 id 去重的话，界面显示新 URL（TriggerInspector 读的是新配置）、
     实际监听旧路由 —— 调新地址 404、带新令牌 401，全程无提示。 */
  const webhookCfg = useRef<Map<string, string>>(new Map());
  // 触发器没填校验 Token 时，后端会生成一个；按触发器 id 存下来给界面提示
  const [webhookTokens, setWebhookTokens] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!webhookSupported) return;
    const wanted = new Map<string, Trigger>(
      triggers.filter((t) => t.kind === 'webhook' && t.enabled).map((t) => [t.id, t] as const),
    );
    const keyOf = (t: Trigger) => JSON.stringify([t.config.port, t.config.path, t.config.token]);

    // 关掉不再需要的 + 配置变了的
    for (const [id, cleanup] of webhookCleanups.current) {
      const t = wanted.get(id);
      if (!t || webhookCfg.current.get(id) !== keyOf(t)) {
        cleanup();
        webhookCleanups.current.delete(id);
        webhookCfg.current.delete(id);
        setWebhookTokens((m) => {
          if (!(id in m)) return m;
          const next = { ...m };
          delete next[id];
          return next;
        });
      }
    }

    // 新开缺失的（含配置变了重起的）
    for (const [id, t] of wanted) {
      if (webhookCleanups.current.has(id)) continue;
      const key = keyOf(t);
      webhookCfg.current.set(id, key);
      /* tracked start：cleanup 先占位再等 promise 落地（同 watch 分支） */
      let stopped = false;
      let landed: (() => void) | null = null;
      const mine = () => { stopped = true; landed?.(); };
      webhookCleanups.current.set(id, mine);
      void startWebhook(
        id,
        t.config.port,
        t.config.path,
        t.config.token,
        (body) => {
          void scheduler.notifyWebhook(id, body);
        },
        (tok) => setWebhookTokens((m) => ({ ...m, [id]: tok })),
      ).then((cleanup) => {
        if (cleanup) landed = cleanup;
        if (stopped) landed?.();
      }).catch((err: unknown) => {
        /*
         * 必须 catch：端口被占用 / 路径非法时 startWebhook 会 reject，
         * 没有 catch 就是 unhandled rejection —— 错误被静默吞掉，
         * 开关开着、服务没起、用户零提示（生产环境还看不到控制台）。
         * 与 watch 分支同一条规矩。
         */
        if (webhookCleanups.current.get(id) === mine) {
          webhookCleanups.current.delete(id);
          webhookCfg.current.delete(id);
        }
        pushLog(`✗ Webhook 启动失败（${t.config.port || '未填端口'}${t.config.path ? ' ' + t.config.path : ''}）：${describeErr(err)}`);
      });
    }
  }, [triggers, webhookSupported, scheduler, pushLog, describeErr]);

  useEffect(() => () => {
    webhookCleanups.current.forEach((c) => c());
    webhookCleanups.current.clear();
  }, []);

  /* ---------------------------------------------------------------- */
  /* 对话监听（chat 触发器）                                            */
  /* ---------------------------------------------------------------- */

  /** 渲染命中内容模板。认得的占位符才替换，其余原样保留 */
  const renderChatHit = useCallback((tpl: string, hit: KeywordHit, file: string): string => {
    const roleText = hit.message.role === 'user' ? '用户' : 'AI';
    const time = hit.message.ts !== null
      ? new Date(hit.message.ts).toLocaleString('zh-CN', { hour12: false })
      : '';
    return (tpl || DEFAULT_TRIGGER_CONFIG.chatTemplate)
      .replace(/\{\{keyword\}\}/g, hit.keyword)
      .replace(/\{\{role\}\}/g, roleText)
      .replace(/\{\{text\}\}/g, hit.message.text)
      .replace(/\{\{excerpt\}\}/g, hit.excerpt)
      .replace(/\{\{file\}\}/g, file)
      .replace(/\{\{time\}\}/g, time);
  }, []);

  /*
   * 轮询对话文件。
   *
   * 为什么是轮询而不是监听：
   *   项目已有目录监听（watch），可以复用。但对话文件是**追加写**，
   *   一次 AI 回复会触发多次 write —— 用它拿不到"消息"这个粒度，
   *   只能在事件里再读一遍文件，等于绕一圈还是轮询。
   *   而且监听要在目录里常驻 watcher，对话目录往往有成百上千个会话文件，
   *   全监听代价太大。直接按固定间隔读末尾反而更简单可控。
   *
   * 只读**末尾**（af_fs_tail），不是整读：几十 MB 的 jsonl 每几秒整读
   * 一次，磁盘和内存都扛不住。
   */
  const chatSeen = useRef<Map<string, SeenState>>(new Map());
  const chatBusy = useRef(false);

  useEffect(() => {
    const active = triggers.filter(
      (t) => t.kind === 'chat' && t.enabled && t.config.chatDir
        && parseKeywords(t.config.chatKeywords).length > 0,
    );
    if (active.length === 0) return;

    let stopped = false;
    // 多个触发器取最小间隔：一个定时器覆盖全部，不必各起一个
    const gap = Math.max(2, Math.min(...active.map((t) => t.config.chatPollSec || 3))) * 1000;

    const tick = async () => {
      if (stopped || chatBusy.current) return;
      chatBusy.current = true;
      try {
        for (const t of active) {
          if (stopped) break;
          const dir = t.config.chatDir;
          const exts = t.config.chatExts.length > 0 ? t.config.chatExts : ['jsonl'];

          let listing = '';
          try {
            listing = (await fileOp({
              op: 'list', path: dir, recursive: false, exts,
            } as FsArgs)).text;
          } catch (e) {
            pushLog(`对话监听「${t.name}」列目录失败：${String(e)}`);
            continue;
          }
          const files = listing.split('\n').map((s) => s.trim()).filter(Boolean);
          if (files.length === 0) continue;

          const kws = parseKeywords(t.config.chatKeywords);
          const seenMap = chatSeen.current;

          for (const f of files) {
            if (stopped) break;
            const content = await tailFile(f);
            if (content === null) continue;

            const key = `${t.id}:${f}`;
            let st = seenMap.get(key);
            const prime = st === undefined;
            if (!st) { st = newSeenState(); seenMap.set(key, st); }

            const fresh = takeNew(parseMessages(content, f), st, prime);
            if (fresh.length === 0) continue;

            const hits = matchKeywords(fresh, kws, t.config.chatScope);
            if (hits.length === 0) continue;

            // 多条命中合并成一次触发：AI 常连续输出多行，
            // 一次回复触发三遍流程没有意义
            const first = hits[0];
            pushLog(`对话触发「${t.name}」：${f.split(/[\\/]/).pop()} 中出现「${first.keyword}」`
              + (hits.length > 1 ? `（本轮共 ${hits.length} 处）` : ''));
            void scheduler.notifyChat(t.id, renderChatHit(t.config.chatTemplate, first, f));
            break;
          }
        }
      } finally {
        chatBusy.current = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), gap);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [triggers, scheduler, pushLog, renderChatHit]);

  const stop = () => {
    abortRef.current?.abort();
    activeRuns.current.forEach((runId) => { void killCli(runId); });
    activeRuns.current.clear();
    setRunning(false);
    // 先标记任务为"已取消"：用户主动停的不该显示成失败
    const cancelling = currentTaskRef.current;
    if (cancelling) {
      setTasks((list) => list.map((t) => (t.id === cancelling ? cancelTask(t) : t)));
    }
    pushLog('已请求停止');
  };

  const enabledCount = triggers.filter((t) => t.enabled).length;

  /*
   * 详情区要显示哪一条。
   *
   * 三个来源（表格选中行 / 已归档列表 / 进行中列表）此前各写了一遍
   * <TaskDetail>，差别只在两个开关上。抄三份的后果是：给详情加一个
   * 能力（比如"跳到画布"）要改三处，漏一处就是"这个入口看得到、那个看不到"。
   * 所以在这里先算出一个目标，详情只写一份。
   */
  const detail: {
    task: HistoryEntry;
    /** 归档记录：显示日期、标注"内容被裁剪过" */
    archived: boolean;
    empty: string;
  } | null = view !== 'tasks' ? null
    : taskView === 'table'
      ? (activeTable
        ? { task: activeTable.record, archived: activeTable.row.origin === 'archived', empty: '在左侧表格里选一条记录看细节。' }
        : null)
      : taskTab === 'done'
        ? (scopedActiveHist ? { task: scopedActiveHist, archived: true, empty: '选一条记录看细节。' } : null)
        : (scopedActiveTask ? { task: scopedActiveTask, archived: false, empty: '选一条任务看细节。' } : null);

  /*
    附属文件挂在哪条任务上。

    任务板视图用**计划态**那条（boardSel，稳定 id，AI 能在文件里写）；
    列表 / 表格视图用运行记录那条。两者不会同时有 —— 一个视图只选一种。

    都没选时 owner 是空串，面板显示"未挂在任何任务上"的那批。
    刻意不隐藏面板：AI 可能先写了附件、任务还没建，
    那时什么都不显示会让人以为写入失败了。
  */
  const attachOwner = taskView === 'board'
    ? (boardSel ?? '')
    : (detail?.task.id ?? '');
  const attachOwnerTitle = taskView === 'board'
    ? (boardSel ? (board.board.nodes[boardSel]?.title ?? '') : '')
    : (detail?.task.canvasName ?? '');
  const attachCount = useMemo(
    () => attach.file.order.filter((id) => attach.file.items[id]?.owner === attachOwner).length,
    [attach.file, attachOwner],
  );

  return (
    <div className="app-shell">
      {/*
       * 模块编辑条。
       * 编辑模块内部时借用主画布，所以必须明确告诉用户"你现在不在流程画布上" ——
       * 否则改了半天以为在改流程，其实是改模块。
       */}
      {editingModule ? (
        <div className="mod-bar" role="status">
          <span className="mod-bar-tag">
            {editingModule.startsWith('@instance:') ? '编辑模块实例' : '编辑模块库'}
          </span>
          <span>
            {editingModule.startsWith('@instance:')
              ? '改完点「完成」会脱钩成独立副本，模块库不受影响'
              : '改完点「完成」保存，所有引用它的实例都会跟着变'}
          </span>
          <span className="mod-bar-ops">
            <button className="mod-btn primary" onClick={() => exitModuleEdit(true)}>
              完成
            </button>
            <button className="mod-btn" onClick={() => exitModuleEdit(false)}>
              放弃
            </button>
          </span>
        </div>
      ) : null}

      <div className="app">
      <div className="app-inner">
      {channel && !channel.ok ? (
        <div className="chan-banner" role="alert">
          <span>⚠ {channel.reason}</span>
          {channel.isolated ? (
            <button className="mini" onClick={() => window.location.reload()}>
              重载插件
            </button>
          ) : null}
        </div>
      ) : null}
      {/*
        上边栏：画布页签 + 工具栏，横跨全宽。

        工具栏原本在中间栏内，于是它只从节点库右边开始，看起来像
        "画布的工具栏" —— 而里面大半按钮（运行 / 保存 / 导入导出 / 外观）
        作用的都是全局，不是画布。
      */}
      <div className="af-topbar">
      <CanvasTabs
        canvases={canvases.map(toMeta)}
        activeId={activeId}
        onSelect={switchCanvas}
        onAdd={handleAddCanvas}
        onRename={handleRenameCanvas}
        onDelete={handleDeleteCanvas}
        disabled={running || editingModule !== null}
      />
      <div className="toolbar">
        <div className="view-switch">
          <button className={view === 'flow' ? 'on' : ''} onClick={() => setView('flow')}>
            流程
          </button>
          <button className={view === 'tasks' ? 'on' : ''} onClick={() => setView('tasks')}>
            任务
            {/*
              徽标跟**当前项目**走。
              用全局数的话，切到项目甲会显示"8 个运行中"而列表里一条没有 ——
              数字与眼前看到的东西对不上，比没有这个数字更让人怀疑是不是坏了。
            */}
            {scopedRunning > 0 ? (
              <span className="view-badge">{scopedRunning}</span>
            ) : null}
          </button>
        </div>
        {histWarn ? (
          <span className="hist-warn-inline" title={histWarn}>⚠ 归档存储</span>
        ) : null}
        {/*
          流程设置的入口只在**任务视图**出现。
          状态与标签都是任务板的东西，在流程视图里放这个按钮，
          点了会打开一个跟画布毫无关系的面板 —— 看着像按错了。
        */}
        {view === 'tasks' ? (
          <button
            className="mini"
            onClick={() => setMetaOpen(true)}
            title="自定义状态流程（含挂起、取消）与标签"
          >
            流程设置
          </button>
        ) : null}
        <strong className="brand">Agent Flow</strong>
        {/*
          工具栏不再放「+ 任务 / + 条件 / + 并发 / + 触发器 / 删除 / 撤销 / 停止」
          这一排按钮 —— 它们全都与别处重复，而重复入口会互相打架：

            · 添加节点：左侧节点库拖拽（或 Ctrl+单击侧栏条目）
            · 删除：选中后按 Delete / Backspace
            · 撤销删除：Ctrl / Cmd + Z
            · 组合：选中多个节点后 Ctrl / Cmd + G；解散：Ctrl / Cmd + Shift + G
            · 停止：切到「任务」页签，在任务详情里停

          另外「运行工作流」也已移除：所有流程都从触发器开始，
          留着它就是留了一个绕过入口的口子 —— 点它跑的是"图上所有节点"，
          与触发器卡片上的「▶ 触发」不是同一条路径，
          表现为"同一个流程，手动跑和自动跑结果不一样"。
        */}

        <span className="trg-btn-static" title="触发器已作为节点放在画布上">
          ⏱ 触发器{triggers.length > 0 && <span className="dot">{enabledCount}/{triggers.length}</span>}
        </span>
        {buriedHere.length > 0 && (
          <span
            className="trg-btn-static trg-buried"
            title={`${buriedHere.map((b) => `模块「${b.hostLabel}」里的 ${b.kind || '触发器'}（${b.triggerId}）`).join('；')}`
              + ' —— 全局扫描只看画布顶层，模块内部的不会被扫描，自动触发永远不会发生。'
              + '请在「编辑内部」里删掉模块内那个，把触发器建在画布上'}
          >
            ⚠ 埋在模块里 {buriedHere.length}
          </span>
        )}

        {/*
          外观已挪到右侧「画布设置」里的「外观」一节。

          它属于整个插件、不属于这张画布，跟工具栏上这些"本次运行怎么跑"
          的东西不是一类；更重要的是默认主题下两个选项**观感完全相同**
          （配色与原生层是同一套值），摆在工具栏里看着就像个坏掉的开关。
          设置页里写了说明，讲清"要换面板主题才看得出差别"。
        */}
        <label className="inline">
          并发
          <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} disabled={running}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <input className="grow" placeholder="全局输入 {{input}}" value={globalInput}
          onChange={(e) => setGlobalInput(e.target.value)} />
        <button onClick={save}>保存</button>
        <button onClick={exportJson}>导出</button>
        <label className="btn-like">
          导入
          <input type="file" accept="application/json" hidden
            onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
        </label>
      </div>
      </div>


      {/*
        左中右三栏（在横跨全宽的上边栏之下）。

        左＝节点库·模块库 / 画布库（可切标签）
        中＝画布
        右＝设置 / 日志（可切标签）

        左栏与画布**同高**：节点库是"从这儿拖东西到画布"的入口，
        比画布矮一截的话，往画布下半部分拖就得先滚节点库。

        左右两栏都做成**可切标签**而不是上下平分：
        分栏的话每栏都偏窄 —— 属性面板挤到看不全，日志只看得到几行。
        切换的代价是"看日志时看不到属性"，但这两件事本来就不会同时做。
      */}
      <div className="af-body-row">
        <div className="af-left-pane">
          {/*
            左栏**两个视图都有**，只是标签组不同：
              流程 → 节点库 / 模块库 / 画布库
              任务 → 进行中 / 已完成

            底板（.side-pane）、宽度、位置完全一致 ——
            切视图时只是同一条栏换了内容和标签，布局不跳。

            以前任务 / 历史下这条栏被整条隐去（画布藏了、节点拖不动），
            于是同一条栏时有时无，切过去整个界面宽度变一次。
          */}
          {/*
            项目切换 —— 只在任务视图、且**确实有分组**时出现。

            放在左栏最上方（标签行之上）：列表与表格都在它下面，
            于是两个视图天然共用同一个范围，不需要各接一次。

            一个分组都没有时不显示：那时下拉里只有「全部项目」一项，
            摆一个点不动的控件，比没有这个控件更让人困惑 ——
            看着像"项目功能还没配好"。
          */}
          {view === 'tasks' && projectOpts.length > 0 ? (
            <div className="prj-bar">
              <span className="prj-label">项目</span>
              <select
                className="p-input prj-sel"
                value={scopeKeyOf(project)}
                onChange={(e) => setProjectRaw(e.target.value)}
                title="只看这个项目的任务记录"
              >
                {projectOpts.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}（{o.count}）</option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="pane-tabs">
            {leftTabsFor(view).map((t) => (
              <button
                key={t}
                className={
                  view === 'tasks'
                    ? (taskTab === t ? 'on' : '')
                    : (leftTab === t ? 'on' : '')
                }
                /*
                  表格视图下这两个子标签**没有意义**（表格本就覆盖全部数据），
                  必须显式禁用而不是留着能点 —— 能点却没反应是最难自查的一类问题：
                  用户会以为切换坏了，实际是那个选择对表格不存在。
                */
                disabled={view === 'tasks' && taskView !== 'list'}
                title={view === 'tasks' && taskView !== 'list'
                  ? '表格视图包含进行中与已归档；任务板是计划态任务，与运行记录不是同一批数据'
                  : undefined}
                onClick={() => {
                  if (view === 'tasks') setTaskTabRaw(t as TaskTab);
                  else setLeftTabRaw(t as LeftTab);
                }}
              >
                {view === 'tasks'
                  ? TASK_TAB_LABEL[t as TaskTab]
                  : LEFT_TAB_LABEL[t as LeftTab]}
              </button>
            ))}
            {/*
              列表 / 表格切换只挂在任务视图上。

              放在标签行里而不是各自面板的头部：切换后两个视图的头部
              内容不同（一个是"任务"+清空，一个是"全部记录"+重置），
              各自画一个切换器就要保证两处文案与状态一致 ——
              那种一致迟早会漏。放标签行只有一处，且与子标签同排，
              位置固定，切过去不会因为头部高度变化而跳。
            */}
            {view === 'tasks' ? (
              <div className="ttb-switch">
                {TASK_VIEWS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={taskView === v ? 'on' : ''}
                    onClick={() => setTaskViewRaw(v)}
                    title={v === 'table' ? '一行一条，每列可筛选与排序' : '按流程分组，盯正在跑的'}
                  >
                    {TASK_VIEW_LABEL[v]}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="pane-body">
            {view === 'tasks' && taskView === 'board' ? (
              <BoardTree
                board={board.board}
                expanded={board.expanded}
                onToggle={board.toggle}
                selectedId={boardSel}
                onSelect={setBoardSel}
                checked={boardChecked}
                onCheck={(id, on) => setBoardChecked((prev) => {
                  const s = new Set(prev);
                  if (on) s.add(id); else s.delete(id);
                  return s;
                })}
                kw={boardKw}
                onKw={setBoardKw}
                onAddTask={() => {
                  const parent = boardSel && board.board.nodes[boardSel]?.kind === 'group' ? boardSel : null;
                  const now = Date.now();
                  board.apply((b) => addNode(b, parent, {
                    kind: 'task', title: '新任务', status: 'todo', deps: [], assignee: '', note: '',
                    desc: '', tags: [], createdAt: now, updatedAt: now, due: 0, priority: 0,
                  }).board);
                }}
                onAddGroup={() => {
                  const parent = boardSel && board.board.nodes[boardSel]?.kind === 'group' ? boardSel : null;
                  board.apply((b) => addNode(b, parent, { kind: 'group', title: '新任务组', children: [] }).board);
                }}
                onMerge={(ids, title) => {
                  board.apply((b) => mergeIntoGroup(b, ids, title).board);
                  setBoardChecked(new Set());
                }}
                onSplit={(id, titles) => board.apply((b) => splitTask(b, id, titles).board)}
                onRemove={(id) => {
                  board.apply((b) => removeNode(b, id));
                  if (boardSel === id) setBoardSel(null);
                }}
                onReload={board.reload}
                canWrite={board.canWrite}
              />
            ) : view === 'tasks' && taskView === 'table' ? (
              /*
                表格视图**不看子标签**：它本就覆盖全部数据
                （进行中 + 已归档），"看哪一段"由筛选决定。
                若在表格里也认 taskTab，就会出现"切到已完成、
                但表格里还有进行中的行"这种自相矛盾的状态。
              */
              <TaskTable
                live={scopedTasks}
                archived={scopedHistory}
                board={board.board}
                meta={meta.meta}
                attachCounts={attachCounts}
                now={tick}
                selectedKey={tableSel}
                onSelect={selectTableRow}
                onToggleTag={toggleTag}
                onCreateTag={createTag}
              />
            ) : view === 'tasks' ? (taskTab === 'done' ? (
              <HistoryList
                entries={scopedHistory}
                now={tick}
                onDelete={(id) => saveHistory(removeFromHistory(historyFile, id))}
                onClearAll={clearScopedHistory}
                clearAllLabel={project.kind === 'all' ? '清空全部' : '清空本项目'}
                onClearCanvas={(canvasId) => saveHistory(clearCanvasHistory(historyFile, canvasId))}
                selectedId={scopedHistSel}
                onSelect={setHistSel}
              />
            ) : (
              <TaskList
                tasks={scopedTasks}
                now={tick}
                onClear={clearScopedTasks}
                clearLabel={project.kind === 'all' ? '清空' : '清空本项目'}
                selectedId={scopedTaskSel}
                onSelect={setTaskSel}
              />
            )) : leftTab === 'node' ? (
              <Sidebar
                onAdd={(p) => spawnNode(p)}
                disabled={running}
                mcpGroups={mcpGroups}
                onRefreshMcp={() => void doRefreshMcp()}
                mcpRefreshing={mcpRefreshing}
              />
            ) : leftTab === 'module' ? (
              <ModuleLibrary
                onCreateFromSelection={() => void createModuleFromSelection()}
                onEdit={(id) => enterModuleEdit(id)}
                disabled={running || editingModule !== null}
              />
            ) : (
              <CanvasLibrary
                canvases={canvases.map(toMeta)}
                groups={canvasGroups}
                activeId={activeId}
                triggers={allGlobalTriggers}
                onSelect={switchCanvas}
                onAdd={handleAddCanvas}
                onAddGroup={handleAddGroup}
                onRenameGroup={handleRenameGroup}
                onDeleteGroup={handleDeleteGroup}
                onDropToGroup={handleDropToGroup}
                onRemoveFromGroup={handleRemoveFromGroup}
                onToggleCollapse={handleToggleCollapse}
                disabled={running || editingModule !== null}
              />
            )}
          </div>
        </div>
        <div className="af-body-main">


      <div className="body">
        {/*
          列表已移到左栏（与节点库共用底板），这里只放**详情**。
        */}
        {/*
          详情跟随左栏的选择 —— 列表视图与表格视图共用这一处，
          「已完成」就是原来的历史详情（带日期、可归档），
          「进行中」可取消。

          三条来源（表格选中行 / 已归档 / 进行中）在 return 前已归一成 detail，
          这里只写一份 —— 三个入口的详情能力必须完全一致，
          否则"从表格点进去看不到取消按钮"这类差别无从排查。
        */}
        {view === 'tasks' && taskView === 'board' ? (
          <div className="bdd-wrap">
            {boardNotice ? <div className="bdd-notice">{boardNotice}</div> : null}
            <div className="bdd-path" title={board.path}>{board.path || '（未设置导出目录）'}</div>
            <TaskBoardDetail
              board={board.board}
              selectedId={boardSel}
              onApply={board.apply}
              canWrite={board.canWrite}
            />
          </div>
        ) : view === 'tasks' ? (
          <div className="task-detail">
            {!detail ? (
              <div className="nx-empty task-empty">
                {taskView === 'table' ? '在左侧表格里选一条记录看细节。' : '选一条记录看细节。'}
              </div>
            ) : (
              <TaskDetail
                task={detail.task}
                now={tick}
                showDate={detail.archived}
                archived={detail.archived}
                onCancel={(id) => {
                  // 只允许停当前那条；归档记录没有可停的东西
                  if (!detail.archived && id === currentTaskRef.current) stop();
                }}
                onJumpToCanvas={(canvasId) => {
                  if (canvasId && canvases.some((c) => c.id === canvasId)) {
                    switchCanvas(canvasId);
                    setView('flow');
                  }
                }}
                onLocateNode={(canvasId, nodeId) => {
                  if (!canvasId || !canvases.some((c) => c.id === canvasId)) return;
                  setView('flow');
                  if (canvasId === activeId) {
                    // 已经在这张画布上：直接滚过去，不用等
                    locateNode(nodeId, nodes);
                    return;
                  }
                  switchCanvas(canvasId);
                  pendingLocate.current = { canvasId, nodeId };
                }}
              />
            )}
          </div>
        ) : null}
        {/*
          卡片上改参数的通道。
          值就是下面的 patchNode —— 与右侧面板走**同一个**函数：
          两处各写一份更新逻辑的话，一处漏了画布参数快照之类的附带处理，
          就会变成"在卡片上改的没存住"。
        */}
        <NodePatchProvider value={patchNode}>
        <div className="canvas" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver} style={view === 'flow' ? undefined : { display: 'none' }}>
          <ReactFlow
            nodes={canvasNodes}
            edges={canvasEdges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(inst) => { rfInstance.current = inst; }}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            /* 按住 Ctrl / ⌘ 拖动 = 复制一份跟着鼠标走，原件留在原地 */
            /*
             * 拖拽开始有两个用途，必须都挂在同一个回调上：
             *  · Ctrl / ⌘ 拖动 → 复制（onNodeDragStart）
             *  · 嵌合整串跟随 + 位置快照（onStackDragStart）
             * 分开挂两个同名属性是语法错误，合成一个。
             */
            /*
             * 嵌合那套不作用在组合框上：框不是积木，
             * 让它去吸附只会把"框"变成串里的一环（见 engine/stack 里的说明）。
             */
            onNodeDragStart={(e, n, ns) => { onNodeDragStart(e, n, ns); if (!isFrameNode(n)) onStackDragStart(e, n); }}
            onNodeDragStop={(e, n, ns) => { onNodeDragStop(); if (!isFrameNode(n)) onStackDragStop(e, n); }}
            onNodeDrag={(e, n) => { if (!isFrameNode(n)) onStackDrag(e, n); }}
            /* xyflow v12 的 onBeforeDelete 传的是节点/边对象（内部按 id 处理，需转换），
               且签名要求返回 Promise，所以要 async */
            onBeforeDelete={async ({ nodes: dn, edges: de }) =>
              beforeDelete({ nodeIds: dn.map((n) => n.id), edgeIds: de.map((e) => e.id) })}
            onNodesDelete={handleNodesDelete}
            deleteKeyCode={running ? null : ['Delete', 'Backspace']}
            /*
             * 拖画布空白处 = 框选（不用按 Shift）。
             *
             * 原来要 Shift+拖，但**没人知道** —— 而"打包成模块"必须框选
             * 多个节点，等于这个功能一直在被这条隐藏操作卡住。
             * 现在与 Figma / Sketch 一致：拖空白就是框选。
             *
             * 代价是平移要换键：空格+拖，或中键拖。
             * 这是有意的取舍 —— 框选是高频操作（打包、批量删、批量移动），
             * 平移有滚轮和右下角导航图兜底。首次进入时在日志里说一声。
             */
            panOnDrag={[1, 2]}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            /* 多选仍可用 Ctrl / ⌘ 点选，与框选互补 */
            multiSelectionKeyCode={['Control', 'Meta']}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        </NodePatchProvider>

        {/*
           目录选择器 —— 没设默认导出目录时弹出来。
           选完直接落盘，并把来源标成"本次选的"（与默认目录区分开）。
         */}
        {pendingExport ? (
          <DirPicker
            initial={exportDir}
            title="导出到哪个目录？"
            onPick={(d) => onPickExportDir(d, false)}
            onPickAsDefault={(d) => onPickExportDir(d, true)}
            onCancel={cancelPendingExport}
          />
        ) : null}

        {deleteNotice && (
          <div className="delete-notice">
            <span>⚠ {deleteNotice}</span>
            {/*
              撤销在工具栏上没有按钮了，这里补一个可见入口 ——
              否则删掉之后唯一的回头路是 Ctrl+Z，不提示的话没人知道。
            */}
            {undoSnap ? (
              <button className="mini" onClick={undoDelete}>撤销</button>
            ) : null}
            <button className="mini" onClick={() => setDeleteNotice(null)}>知道了</button>
          </div>
        )}

        {/*
          组合条 —— 工具栏上没有按钮了，而"选中若干节点 → 组合"是高频动作。
          快捷键 Ctrl / ⌘ + G 是主入口，这里补一个看得见的：
          没人会猜到有这个键位（与撤销删除那条提示同理）。
        */}
        {!running && view === 'flow' && (selCount >= 2 || selHasFrame) ? (
          <div className="sel-bar">
            <span>已选 {selCount} 个{selHasFrame ? '（含组合框）' : ''}</span>
            {selCount >= 2 ? (
              <button className="mini" onClick={groupSelection}>组合成模块</button>
            ) : null}
            {selHasFrame ? (
              <button className="mini" onClick={ungroupSelection}>解散组合</button>
            ) : null}
          </div>
        ) : null}

        {/*
          任务 / 历史视图下属性面板保留，但只读 —— 保留是为了看完整信息。

          用 fieldset[disabled] 而不是逐个控件加 disabled：面板里有几十个
          input / select / button，分散在一堆子组件里，逐个改既漏又啰嗦。
          fieldset 的 disabled 会原生禁用所有后代控件，连键盘 Tab 进去改
          也一并挡住 —— 这是 CSS 的 pointer-events 做不到的。
        */}
      </div>
      </div>
        {/*
          右栏：设置在上、日志在下，中间一条可拖的分隔条。

          不做成可切标签：跑流程时盯着日志还得能改参数，
          切成标签就得来回切 —— 那两件事恰恰经常同时发生。
        */}
        {/*
           任务 / 历史视图下**不渲染右栏**。

           它原本恒显示（只读 + 一句"改节点请回流程"），
           于是详情区被一条 340px 的栏挤掉三分之一 ——
           任务列表在左栏、详情在中间，中间本来就不宽，
           挤完只剩半屏，流程图与节点输出都要横向滚。

           属性面板在这两个视图下没有可读的东西（它自己都在说
           "改节点请回流程"）；日志在任务详情里已经有了。
        */}
        {view === 'flow' ? (
        <div className="af-right-pane">
          {/*
            右栏三个页签：属性 / 日志 / 文件。

            以前是「检查器在上、日志在下」中间一条可拖动分隔条；
            加了附属文件之后三块叠在一栏里每块都被挤成一条，
            而日志恰恰是运行时最需要看的东西 —— 所以改成页签。

            ⛔ 代价：检查器与日志不再同时可见。故运行开始时会自动
            切回「日志」（见下面那个 effect），否则跑起来了还停在
            属性页，一条进度都看不到。
          */}
          <div className="af-right-tabs">
            {RIGHT_TABS.map((t) => (
              <button
                key={t}
                type="button"
                className={rightTab === t ? 'on' : ''}
                onClick={() => setRightTabRaw(t)}
                title={
                  t === 'insp' ? '编辑选中节点的参数'
                  : t === 'log' ? '运行日志'
                  : '挂在任务上的 md / 图片 / 视频'
                }
              >
                {RIGHT_TAB_LABEL[t]}
                {t === 'files' && attachCount > 0 ? (
                  <span className="att-badge">{attachCount}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="af-right-body">
            {rightTab === 'files' ? (
              <AttachPanel
                file={attach.file}
                owner={attachOwner}
                ownerTitle={attachOwnerTitle}
                dir={exportDir}
                canWrite={attach.canWrite}
                onAdd={(item) => attach.apply((f) => addAttachment(f, item).file)}
                onRemove={(id) => attach.apply((f) => removeAttachment(f, id))}
                onReload={attach.reload}
                notice={attachNotice}
              />
            ) : rightTab === 'log' ? (
              <div className="logpane">
                <div className="log-head">
                  运行日志
                  {summary && (
                    <span className={summary.ok ? 'ok' : 'bad'}>
                      {summary.ok ? '全部成功' : `失败 ${summary.failed.length} · 跳过 ${summary.skipped.length}`}
                    </span>
                  )}
                </div>
                <div className="log-body">
                  {log.length === 0 && <small>还没有运行记录</small>}
                  {log.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </div>
            ) : (
              <div className="insp-slot">
                {view !== 'flow' ? (
                  <div className="insp-ro-bar">
                    <span className="insp-ro-tag">只读</span>
                    <span className="insp-ro-hint">
                      {selected ? '改节点请回流程' : '未选中节点'}
                    </span>
                    <button
                      className="mini"
                      onClick={() => setView('flow')}
                      disabled={!selected}
                      title={selected ? '回到流程视图编辑这个节点' : '先在流程视图里选中一个节点'}
                    >
                      前往流程编辑
                    </button>
                  </div>
                ) : null}
                <fieldset className="insp-lock" disabled={view !== 'flow'}>
                  <Inspector
                    node={selected}
                    edges={edges}
                    nodes={nodes}
                    onChange={patchNode}
                    credentials={credentials}
                    onOpenCredentials={openCredentials}
                    mcpLibrary={mcpServers}
                    onOpenMcpLibrary={openMcpLibrary}
                    webhookTokens={webhookTokens}
                    onEditModule={(id) => enterInstanceEdit(id)}
                    onNote={pushLog}
                    exportDir={exportDir}
                    onChangeExportDir={setExportDir}
                    onBrowseExportDir={browseExportDir}
                    canExportToFile={canExportToFile()}
                    canvasConfig={canvasConfigOf(activeCanvas)}
                    onCanvasConfigChange={saveCanvasConfig}
                    onExportFlow={exportFlowAs}
                    canvases={canvases}
                    activeCanvasId={activeId ?? undefined}
                    themeMode={themeMode}
                    onThemeModeChange={setThemeMode}
                  />
                </fieldset>
              </div>
            )}
          </div>
        </div>
        ) : null}
      </div>
      </div>
      </div>

      {/*
        流程设置（状态 + 标签）同凭据中心一样挂在这层：
        它是全屏遮罩（position:fixed），放哪一层都显示，
        不依赖右栏或任务视图的布局 —— 从顶栏按钮点进来一定能看到。
      */}
      {metaOpen ? (
        <BoardMetaPanel
          meta={meta.meta}
          canWrite={meta.canWrite}
          notice={metaNotice}
          onChange={meta.apply}
          onClose={() => setMetaOpen(false)}
        />
      ) : null}

      {/*
        凭据中心挂在这里（af-body-row 之外），不跟着右栏走。

        以前它写在右栏里，而任务 / 历史视图下右栏不渲染 ——
        于是从"填写凭据"按钮点进来会毫无反应：面板根本没被渲染，
        连报错都没有。

        它本来就是全屏遮罩（.cred-mask 是 position:fixed），
        放在哪一层都一样显示，不依赖右栏的布局。
      */}
      {credOpen ? (
        <CredentialPanel
          credentials={credentials}
          onChange={(next) => setCredentials(next)}
          onClose={() => { setCredOpen(false); setCredFocus(''); setCredPage('cred'); }}
          initialPage={credPage}
          verify={verifyCredential}
          fetchModels={fetchModels}
          locked={vaultKey === null}
          mode={store.mode}
          onUnlock={(pass) => {
            if (pass === '') { lockVault(); return; }
            unlock(pass);
          }}
          onChangeMode={changeVaultMode}
          cryptoWarn={cryptoWarn}
          unlockError={unlockErr}
          mcpServers={mcpServers}
          onMcpChange={commitMcp}
          mcpToolCount={mcpToolCount}
          onMcpRefresh={() => { void doRefreshMcp(); }}
          mcpRefreshing={mcpRefreshing}
        />
      ) : null}
    </div>
  );
}


