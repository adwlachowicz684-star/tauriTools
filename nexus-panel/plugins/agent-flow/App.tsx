import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, useReactFlow,
  type Connection, type Edge, type NodeTypes, type ReactFlowInstance,
  type NodeChange, SelectionMode } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Inspector from './components/Inspector';
// 副作用导入：把 nodes/defs/ 下的节点定义注册进表。
// 放在这里是刻意的 —— 注册表必须先被填充，下面的 buildNodeTypes() 才有内容。
import { buildNodeTypes, getDef, allPresets, type NodeDef } from './nodes';
import { getCardGroup } from './nodes/registry';
import {
  applyCardTo, findCard, checkCardForNode, duplicateCard,
} from './engine/paramCards';
import {
  CARD_DRAG_MIME, decodeCardDrag,
} from './components/inspectors/ParamCardPicker';
import {
  duplicateElements, stripRuntime, type DupNode, type DupEdge,
} from './engine/duplicate';
import { CredentialPanel, canUse } from './components/CredentialPanel';
import { useCredentialVault, VAULT_MODE_META, CRED_KEY } from './hooks/useCredentialVault';
import {
  loadServers as loadMcpServers, saveServers as saveMcpServers,
  migrateFromCanvases, toServerRefs, type GlobalMcpServer,
} from './engine/mcpServers';
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
  normalizeLeftTab, normalizeLogHeight, coerceForView,
} from './engine/layout';
import type { LeftTab } from './engine/layout';
import { defaultKV as kvStore } from './engine/kv';
import {
  writeTextFile, fsAllowRoot, listFsRoots, canExportToFile,
} from './lib/tauri';
import { withinRoots } from './engine/exportDir';
import ModuleLibrary, {
  MODULE_DRAG_MIME, decodeModuleDrag, askCreateModule,
} from './components/ModuleLibrary';
import { expandCanvasRefs } from './engine/canvasRef';
import { syncCanvasesRefNames, snapshotCanvasName } from './engine/canvasRefName';
import {
  collectGlobalTriggers, activeTriggers, dedupeWatchDirs,
  type GlobalTrigger,
} from './engine/triggerRegistry';
import {
  loadGroups, saveGroups, pruneGroupsIfChanged, dropEmptyGroups,
  nextGroupName, addToGroup, removeFromGroup,
  type CanvasGroup,
} from './engine/canvasGroups';
import CanvasLibrary from './components/CanvasLibrary';
import {
  expandModules, findModule, addModule, saveModules, loadModules,
  stripRuntimeNodes, packSelection, type ModuleDef,
} from './engine/modules';
import {
  stackEdges, descendantsOf, chainTopOf, chainOf,
  parentIdOf, movedEnough, heightOf, STACK_GAP, stackParentIds,
  planStackDrop, planStackReflow, measureHeights,
} from './engine/stack';
import { withDefault } from './engine/nodeDefaults';
import { specOf, canConnect } from './engine/nodeSpec';
import { getDefByDataKind } from './nodes/registry';
import CanvasTabs from './components/CanvasTabs';
import { TaskList } from './components/TaskPanel';
import { TaskDetail } from './components/TaskDetail';
import { HistoryList } from './components/HistoryPanel';
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
import { type CanvasParam, migrateEnvVars, paramRefsOfNodes } from './engine/canvasParams';
import { exportFlow, EXPORT_FORMATS } from './engine/scriptExport';
import {
  loadExportDir as loadExportDirSetting, saveExportDir as persistExportDir,
  resolveExportTarget, parentOf,
} from './engine/exportDir';
import {
  hydrateMcpNodes, mcpSidebarGroups, bootRefresh,
} from './engine/mcpRegistry';
import {
  collectServers, serversChanged, serversToDrop, type ServerRef,
  type McpToolFetcher,
} from './engine/mcpStore';
import { listTools, transportOf, stdioSupported } from './engine/mcpClient';
import {
  makeCanvas, nextCanvasName, renameCanvas, removeCanvas, nextActiveId,
  updateCanvasContent, updateCanvasConfig, canvasConfigOf, sortForDisplay, toMeta,
  loadFromStorage, saveToStorage, STORAGE_KEYS,
  type Canvas,
  redactNodes,
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
  fetchDeviceSalt, tailFile, type DonePayload, type FsArgs } from './lib/tauri';
import {
  deleteElements, nextSelection, hasAnythingToDelete,
  makeSnapshot, describeDelete,
  type UndoSnapshot,
} from './engine/canvasOps';

/**
 * 画布的节点组件映射。
 *
 * 以前这里手工列一张表，加一种节点要同时改这里 —— 漏改的话该节点
 * 会退化成 xyflow 的默认节点（能拖动但内容全空），且不报错。
 * 现在从注册表构建，与侧栏、属性面板、执行引擎共用同一份声明。
 */
const nodeTypes: NodeTypes = buildNodeTypes();

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

/**
 * MCP 协议实现：把 engine/mcpClient 的 HTTP 传输接到刷新流程上。
 *
 * 放在**模块级**而不是组件里 —— 它不依赖任何 state，
 * 放组件里会因为每次渲染重建而让 useCallback 的依赖数组被迫带上它。
 *
 * 用 postJson 是因为它已经处理了 Tauri 与浏览器两条路径，
 * 不必为 MCP 再开一条通道。
 *
 * 只支持 HTTP 传输：stdio 要起子进程 + 双向管道，那是 Rust 侧的活。
 * 目前 stdioSupported() 为 false，只填 command 的服务会拿到一条
 * 明确的"还没接上"，而不是静默失败。
 */
const mcpFetcher: McpToolFetcher = async (server) => {
  if (transportOf(server) === 'stdio' && !stdioSupported()) {
    throw new Error(
      `MCP 服务「${server.name}」用的是 stdio 传输（command 方式），还没接上 —— 请改用 HTTP 地址`,
    );
  }
  const tools = await listTools(
    { name: server.name, url: server.url, command: server.command },
    async (url, body, headers, timeoutSec) => await postJson(url, body, headers, timeoutSec),
    20,
  );
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
};

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

  /*
   * MCP 服务改由**全局库**管（一处配置，全图可用）。
   *
   * 以前每张画布各存一份，同一服务在五张画布上要用就配五遍 ——
   * 改个地址要改五处，漏一处表现为"这张画布连的是旧地址"，且不报错。
   */
  const [mcpServers, setMcpServers] = useState<GlobalMcpServer[]>(
    () => migrateFromCanvases(init.canvases).list,
  );

  /*
   * 刷新管线要的服务形状。用 ref 而不是 state：
   * doRefreshMcp 是个 useCallback，依赖里放数组会让它每次配置改动都重建，
   * 进而让用它做依赖的防抖 effect 反复重新注册。
   */
  const mcpRefsRef = useRef<ServerRef[]>(toServerRefs(mcpServers) as ServerRef[]);
  mcpRefsRef.current = toServerRefs(mcpServers) as ServerRef[];

  const commitMcp = useCallback((next: GlobalMcpServer[]) => {
    setMcpServers(next);
    saveMcpServers(next);
  }, []);


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
    setUndoSnap(null);
    setDeleteNotice(null);
  }, [activeId, canvases, setNodes, setEdges]);

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

  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const [view, setView] = useState<'flow' | 'tasks' | 'history'>('flow');
  /*
   * 任务 / 历史的选中项要**提升到这里**。
   *
   * 列表在左栏、详情在中间，是两个组件 ——
   * 各自 useState 的话点左栏不会让中间跟着变，看着就是"点了没反应"。
   */
  const [taskSel, setTaskSel] = useState<string | null>(null);
  const [histSel, setHistSel] = useState<string | null>(null);

  /* ---------------- 历史（跨会话归档）---------------- */
  const [historyFile, setHistoryFile] = useState(() => parseHistory(localStorage.getItem(HISTORY_STORE_KEY)));
  const history: HistoryEntry[] = historyFile.entries;

  /*
    写盘可能触发 QuotaExceededError（localStorage 通常只有 5MB）。
    失败时不能静默吞掉 —— 否则用户以为归档了，下次打开却是空的。
    这里裁掉一半最旧的再试一次；仍失败就提示，让人知道要清理。
  */
  const [histWarn, setHistWarn] = useState('');
  const saveHistory = useCallback((file: { v: number; entries: HistoryEntry[] }) => {
    setHistoryFile(file);
    for (const attempt of [0, 1]) {
      try {
        localStorage.setItem(HISTORY_STORE_KEY, serializeHistory(file));
        if (attempt > 0) setHistWarn('存储空间紧张，已自动清理较旧的记录。');
        else setHistWarn('');
        return;
      } catch {
        // 装不下就丢掉最旧的一半再试
        const keep = file.entries.slice(0, Math.max(1, Math.floor(file.entries.length / 2)));
        file = { v: file.v, entries: keep };
        setHistoryFile(file);
      }
    }
    setHistWarn('存储空间不足，归档未能全部保存。建议清空部分历史。');
  }, []);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  /** 当前正在跑的任务 id。用 ref 避免 onEvent 因依赖变化而重建 */
  const currentTaskRef = useRef<string | null>(null);
  /*
    让任务耗时与进度实时刷新。
    两个约束：
      1. 只在真的有任务在跑时才走 —— 全部空闲时每秒重渲染整个列表是白烧 CPU
      2. 依赖用布尔值而非 tasks 数组 —— 否则每来一个运行事件都会重建定时器
    已完成的任务显示固定耗时，不需要跟着刷新。
  */
  const [tick, setTick] = useState(() => Date.now());
  const hasRunning = useMemo(
    () => tasks.some((t) => t.status === 'running'),
    [tasks],
  );
  useEffect(() => {
    if (!hasRunning) return;
    const h = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [hasRunning]);




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
  /** 最近一次删除的快照，用于撤销；null 表示无可撤销 */
  const [undoSnap, setUndoSnap] = useState<UndoSnapshot<FlowNode, FlowEdge> | null>(null);
  /** 删除后可能出现的"下游还在引用被删节点"提示 */
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  const seq = useRef(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRuns = useRef<Map<string, string>>(new Map());

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

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
  const [logH, setLogH] = useState<number>(() => normalizeLogHeight(kvStore().get('agent-flow.logH.v1')));

  useEffect(() => { kvStore().set('agent-flow.leftTab.v1', leftTabRaw); }, [leftTabRaw]);
  useEffect(() => { kvStore().set('agent-flow.logH.v1', String(logH)); }, [logH]);

  /*
   * 节点高度变了就把下方的串重新贴回去。
   *
   * ================= 为什么必须事后做 ====================
   *
   * 嵌合位置是**落位那一刻**按当时的高度算的绝对值。
   * 之后改「显示高度」（矮 / 中 / 高），被改的那块长高了，
   * 下面挂着的还停在原来的 y —— 串在显示上裂开，关系却还在。
   *
   * 而新高度取决于内容（标题、参数行、字号），改完的**当下**还不知道，
   * 要等浏览器渲染完才拿得到 measured —— 所以只能在渲染后比对。
   *
   * ================= 为什么不逐个重算贴合位置 =================
   *
   * 那样会把用户故意留的小缝隙一并抹平。
   * 这里只补偿"高度差"（见 planStackReflow），其余相对关系原样保留。
   *
   * ================= 不会死循环 =================
   *
   * 挪动位置不改变高度，所以下一轮 deltas 必为空，effect 直接返回。
   */
  const heightsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const next = measureHeights(nodes as never);
    const deltas = new Map<string, number>();
    for (const [id, h] of next) {
      const old = heightsRef.current.get(id);
      // 1px 以内的抖动不算 —— 频繁整串位移会让画布看着在抖
      if (old !== undefined && Math.abs(h - old) >= 1) deltas.set(id, h - old);
    }
    heightsRef.current = next;
    if (deltas.size === 0) return;

    const moves = planStackReflow(nodes as never, deltas);
    if (moves.length === 0) return;
    const at = new Map(moves.map((m) => [m.id, m.position]));
    setNodes((ns) => ns.map((n) => {
      const p = at.get(n.id);
      return p ? ({ ...n, position: p } as FlowNode) : n;
    }));
  }, [nodes, setNodes]);

  /*
   * 切到任务 / 历史时左边栏要隐藏 ——
   * 那些视图下画布都藏起来了，节点拖不出去，留着就是死栏。
   */
  /*
   * 列表顶替节点库后，详情要能自己挑一条 ——
   * 没选过就取第一条，否则右侧一进来是空的，得先点一下才有东西看。
   */
  const activeTask = tasks.find((t) => t.id === taskSel) || tasks[0] || null;
  const activeHist = history.find((e) => e.id === histSel) || history[0] || null;

  const coerced = coerceForView(view, leftTabRaw);
  const leftTab = coerced.left;


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

  /* ---------------- MCP 节点 ---------------- */

  /*
   * 启动时先把存下来的蓝图注册进注册表 —— **同步**完成。
   * 这是"先用快照立刻可用"的关键：不等网络，界面一上来就有这些节点。
   */
  const [mcpBlueprints] = useState(() => hydrateMcpNodes());

  const [mcpGroups, setMcpGroups] = useState(() => mcpSidebarGroups(mcpBlueprints));
  const [mcpRefreshing, setMcpRefreshing] = useState(false);
  const mcpBootedRef = useRef(false);

  const rebuildMcpGroups = useCallback((list: ReturnType<typeof mcpSidebarGroups>) => {
    setMcpGroups(list);
  }, []);

  /** 每个服务已生成的工具节点数，按服务名索引 */
  const mcpToolCount = useMemo(() => {
    const out: Record<string, number> = {};
    for (const b of mcpBlueprints) {
      const k = String(b?.server ?? '').trim();
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }, [mcpBlueprints]);


  /*
   * 刷新。
   *
   * fetcher 暂时不传 —— MCP 协议还没接上，所以这次刷新会退化成用快照，
   * 并把"协议没接上"这句话报出来。
   * 不假装成功：假装成功会让用户以为工具已经是新的了。
   */
  /*
   * 刷新代号。
   *
   * 刷新是**异步**的（要连 MCP server 拉工具清单），而触发它的时机有三个：
   * 启动后一次、侧栏手动点、服务配置变了防抖一次。
   *
   * 没有代号的话，两次并发刷新可能"后发的先返回"：
   * 用户改了服务 → 新刷新发出；上一次旧刷新这时才返回 →
   * 用**旧的服务列表**覆盖掉刚算好的结果，侧栏显示回一批过期工具。
   * 而且不报错，只表现为"我明明改了，怎么还是老的"。
   *
   * 与存档那边的 saveSeq 是同一套做法。
   */
  const mcpRefreshSeq = useRef(0);

  const doRefreshMcp = useCallback(async (overrideServers?: ServerRef[]) => {
    const seq = mcpRefreshSeq.current + 1;
    mcpRefreshSeq.current = seq;
    setMcpRefreshing(true);
    try {
      /*
       * 允许外部传服务列表 ——
       * 配置刚改时 canvases 还没更新完，用传进来的这份才准。
       */
      /*
       * 服务取自**全局库**，不再扫各张画布的配置 ——
       * 见上面 mcpServers 的说明。
       */
      const servers = overrideServers ?? mcpRefsRef.current;
      const r = await bootRefresh(servers, mcpBlueprints, mcpFetcher);
      // 被更新的刷新取代了就丢弃结果 —— 它反映的是过期的服务列表
      if (seq !== mcpRefreshSeq.current) return;
      if (r.outcome.ok) rebuildMcpGroups(mcpSidebarGroups(r.outcome.list));
      pushLog(r.message);
    } finally {
      // 只有仍是最新那次才收起"刷新中" ——
      // 否则旧刷新返回时会把新刷新还在跑的状态提前清掉
      if (seq === mcpRefreshSeq.current) setMcpRefreshing(false);
    }
  }, [canvases, mcpBlueprints, rebuildMcpGroups, pushLog]);

  /*
   * 配了 MCP 服务就自动刷新一次。
   *
   * **带防抖**：服务名与命令都是输入框，onChange 每敲一个字符就触发。
   * 不防抖的话，等接上协议后就是"每敲一个键起一次子进程"。
   * 800ms 够用户停下笔，又不会让他等太久。
   */
  const mcpTimerRef = useRef<number | null>(null);
  const mcpServersRef = useRef<ServerRef[]>(toServerRefs(mcpServers) as ServerRef[]);

  const scheduleMcpRefresh = useCallback((servers: ServerRef[]) => {
    if (mcpTimerRef.current !== null) window.clearTimeout(mcpTimerRef.current);
    mcpTimerRef.current = window.setTimeout(() => {
      mcpTimerRef.current = null;
      void doRefreshMcp(servers);
    }, 800);
  }, [doRefreshMcp]);

  // 组件卸载时清掉定时器，避免在已卸载的组件上 setState
  useEffect(() => () => {
    if (mcpTimerRef.current !== null) window.clearTimeout(mcpTimerRef.current);
  }, []);

  /*
   * 全局 MCP 服务库变了 → 防抖刷新一次。
   *
   * 比对只认 name / command / url（顺序无关）：
   *  · 改环境变量不触发重连 —— 那跟工具清单无关
   *  · 改命令要算变化 —— 那是换了个服务，只比名字的话改了命令不会重新拉
   */
  useEffect(() => {
    const after = toServerRefs(mcpServers) as ServerRef[];
    const before = mcpServersRef.current;
    if (!serversChanged(before, after)) return;

    mcpServersRef.current = after;
    /*
     * 服务被删时**立刻**把它的工具标 stale ——
     * 不等刷新，免得侧栏还挂着已经不存在的服务。
     */
    const dropped = serversToDrop(before, after);
    if (dropped.length > 0) {
      setMcpGroups((gs) => gs.filter((g) => !dropped.includes(g.server)));
    }
    scheduleMcpRefresh(after);
  }, [mcpServers, scheduleMcpRefresh]);

  /*
   * 启动后自动刷新一次。
   *
   * 用 ref 守一次 —— 不然每次重渲染都会刷，
   * 而刷新是要连外部进程的（将来接上协议后更是如此）。
   */
  useEffect(() => {
    if (mcpBootedRef.current) return;
    mcpBootedRef.current = true;
    void doRefreshMcp();
  }, [doRefreshMcp]);


  /* ---------------- 导出目录 ---------------- */

  /*
   * 默认导出目录 —— **全局偏好**，不是画布级配置。
   * 导出到哪跟"这是哪张画布"无关，是用户习惯。
   */
  const [exportDir, setExportDirState] = useState<string>(() => loadExportDirSetting());
  /** 待导出的格式：等用户选完目录再真正写 */
  const [pendingExport, setPendingExport] = useState<string | null>(null);

  const setExportDir = useCallback((d: string) => {
    setExportDirState(d);
    persistExportDir(d);
  }, []);

  /* ---------------- 画布级配置与导出 ---------------- */

  /*
   * 当前画布对象。派生值，不是 state ——
   * 设成 state 就得跟着 canvases 同步，多一处可能忘更新的地方。
   */
  const activeCanvas = canvases.find((c) => c.id === activeId) ?? null;

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
   * 把整张画布导出成脚本 / 说明。
   *
   * ================= 为什么不走浏览器下载了 =================
   *
   * 以前用 <a download>：文件落到系统默认下载目录，
   * **插件自己也不知道在哪**，日志里只有文件名没有目录 ——
   * 用户找不到文件，也不知道该去哪找。
   *
   * 更糟的是 try/catch 的 catch 是空的（注释说"退回剪贴板"但没实现），
   * 下载被拦时日志照样打印"✅ 已导出"，**失败伪装成成功**。
   *
   * 现在改走 fs_op 写文件：路径由我们决定，结果能确认，
   * 失败就明确报失败。
   */
  const writeExport = useCallback(
    async (fmt: string, dir: string | null) => {
      const meta = EXPORT_FORMATS.find((f) => f.id === fmt);
      if (!meta) return;
      const graph = { nodes, edges };
      const r = exportFlow(graph, meta.id as never);
      const target = resolveExportTarget(exportDir, dir, activeCanvas?.name ?? 'canvas', meta.ext);

      /*
       * 没有目录可用（浏览器模式，或未设目录也没选）→ 退回下载。
       * 这时**必须**明说路径不受控，不能让用户以为写到了某处。
       */
      if (target.source === 'download') {
        try {
          const blob = new Blob([r.text], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = target.path;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          pushLog(`✅ 已导出${meta.label}（${r.count} 个节点）→ ${target.path}（浏览器下载目录，非软件目录）`);
        } catch (e) {
          /* 这里**不能**再静默 —— 失败就要说失败 */
          pushLog(`✗ 导出失败：${String((e as Error)?.message ?? e)}`);
        }
        reportSkipped(r, meta.label, pushLog);
        return;
      }

      try {
        /*
         * fs_op 只写**授权根目录内**的路径 —— 这是"读任意文件 + 外传"
         * 这条风险链的收敛点，不能绕。
         *
         * 所以写之前先看目录在不在授权列表里，不在就申请。
         *
         * 为什么不能像第一版那样"失败了偷偷授权再试一次"：
         *   · 用户完全不知道发生过授权
         *   · 授权失败时看到的是笼统的"路径越权"，
         *     而不是真正的原因（目录不存在 / 不允许授权 / 加进去没生效），
         *     排查只能靠猜
         */
        const dir = parentOf(target.path);
        let roots = await listFsRoots().catch(() => [] as string[]);
        if (!withinRoots(dir, roots)) {
          pushLog(`· 目录还没授权，正在申请：${dir}`);
          try {
            await fsAllowRoot(dir);
          } catch (e) {
            /*
             * 授权失败**必须**说清原因 ——
             * 最常见的是"目录不存在"或"不允许把这么大的范围加进来"，
             * 笼统报"路径越权"会让人以为是路径写错了。
             */
            pushLog(`✗ 授权目录失败：${String((e as Error)?.message ?? e)}`);
            return;
          }
          /* 回读一次：确认真的加进去了，别把"调用了但没生效"当成成功 */
          roots = await listFsRoots().catch(() => [] as string[]);
          if (!withinRoots(dir, roots)) {
            pushLog(`✗ 授权已提交但目录仍不在授权列表里：${dir} —— 请换一个目录，或到设置里检查授权列表`);
            return;
          }
        }

        const out = await writeTextFile(target.path, r.text);
        if (!out.ok) {
          pushLog(`✗ 导出失败：${out.text || '目标目录不可写'}`);
          return;
        }
        const how = target.source === 'picked' ? '（本次选的目录）' : '（默认导出目录）';
        pushLog(`✅ 已导出${meta.label}（${r.count} 个节点）→ ${target.path} ${how}`);
      } catch (e) {
        pushLog(`✗ 导出失败：${String((e as Error)?.message ?? e)}`);
        return;
      }
      reportSkipped(r, meta.label, pushLog);
    },
    [nodes, edges, activeCanvas, exportDir, pushLog],
  );

  /** 导出入口：没设默认目录就先让用户选一个 */
  const exportFlowAs = useCallback((fmt: string) => {
    /* 浏览器模式写不了文件，直接走下载，弹选择器也没意义 */
    if (!canExportToFile()) {
      void writeExport(fmt, null);
      return;
    }
    if (exportDir) {
      void writeExport(fmt, null);
      return;
    }
    setPendingExport(fmt);
  }, [exportDir, writeExport]);

  /** 目录选择器选完之后 */
  const onPickExportDir = useCallback((dir: string, asDefault: boolean) => {
    const fmt = pendingExport;
    setPendingExport(null);
    /*
     * '__browse__' 表示"只是从设置里点浏览来填目录"，不是要导出 ——
     * 这时只把目录填进设置框，不写文件。
     * 不区分的话，用户在设置里选个目录会莫名导出一份文件。
     */
    const browsing = fmt === BROWSE_ONLY;
    if (asDefault || browsing) setExportDir(dir);
    if (fmt && !browsing) void writeExport(fmt, dir);
  }, [pendingExport, writeExport, setExportDir]);


/** 目录选择器只用于"填设置"，不代表要导出 */
const BROWSE_ONLY = '__browse__';

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
      const next = { ...n.data, ...patch } as Record<string, unknown>;
      if (patch.canvasId !== undefined && !patch.canvasName) {
        const snap = snapshotCanvasName(patch.canvasId, canvases);
        if (snap) next.canvasName = snap;
      }
      // 断言放在整体而非 data 上：若把 data 单独断言成联合类型 NodeData，
      // 展开后就无法落回 FlowNode 的任何一个具体分支（task/condition/…）。
      return { ...n, data: next } as FlowNode;
    }));
  }, [setNodes, canvases]);

  /** 工具栏「+ 任务」。走注册表，与从侧栏添加走同一条路径 */
  const addTask = () => {
    seq.current += 1;
    const id = `task${Date.now().toString(36)}${seq.current}`;
    setNodes((ns) => [
      ...ns,
      {
        id, type: 'task',
        position: { x: 80 + (ns.length % 4) * 300, y: 80 + Math.floor(ns.length / 4) * 220 },
        data: getDef('task').create(id, { label: `任务 ${ns.length + 1}` }),
      } as FlowNode,
    ]);
    setSelectedId(id);
  };

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

  /** 记录删除前快照，并算出删除后是否留下悬空引用 */
  const beforeDelete = useCallback(
    (req: { nodeIds?: string[]; edgeIds?: string[] }) => {
      if (!hasAnythingToDelete(nodes, edges, req)) return true;

      setUndoSnap(makeSnapshot(nodes, edges, selectedId, describeDelete(req.nodeIds ?? [], req.edgeIds ?? [])));

      // 提前算出悬空引用：删除后节点已消失，就查不到了
      const res = deleteElements(nodes, edges, req);
      if (res.danglingRefs.length > 0) {
        const detail = res.danglingRefs
          .map((d) => `${d.ref} 仍被 ${d.usedBy.join('、')} 引用`)
          .join('；');
        setDeleteNotice(`已删除，但 ${detail}。这些变量运行时会原样传给 CLI，记得改掉。`);
      } else {
        setDeleteNotice(null);
      }
      return true; // 允许删除
    },
    [nodes, edges, selectedId],
  );

  const handleNodesDelete = useCallback((deleted: { id: string }[]) => {
    setSelectedId((cur) => nextSelection(cur, deleted.map((n) => n.id)));
  }, []);

  /** 工具栏「删除」：删掉当前选中项（React Flow 选中标记 + 属性面板选中态兜底） */
  const deleteSelected = useCallback(() => {
    const nodeIds = nodes.filter((n) => n.selected).map((n) => n.id);
    const edgeIds = edges.filter((e) => (e as { selected?: boolean }).selected).map((e) => e.id);
    // 属性面板选中的节点可能没走 React Flow 的选中态，补上
    if (nodeIds.length === 0 && edgeIds.length === 0 && selectedId) nodeIds.push(selectedId);

    if (!hasAnythingToDelete(nodes, edges, { nodeIds, edgeIds })) return;

    beforeDelete({ nodeIds, edgeIds });
    const res = deleteElements(nodes, edges, { nodeIds, edgeIds });
    setNodes(res.nodes);
    setEdges(res.edges);
    setSelectedId((cur) => nextSelection(cur, res.removedNodeIds));
  }, [nodes, edges, selectedId, beforeDelete, setNodes, setEdges]);

  /** 撤销：恢复最近一次删除 */
  const undoDelete = useCallback(() => {
    if (!undoSnap) return;
    setNodes(undoSnap.nodes);
    setEdges(undoSnap.edges);
    setSelectedId(undoSnap.selectedId);
    setUndoSnap(null);
    setDeleteNotice(null);
  }, [undoSnap, setNodes, setEdges]);

  // Ctrl/Cmd+Z 撤销删除（在输入框里打字时不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (t?.isContentEditable) return;
      if (!undoSnap) return;
      e.preventDefault();
      undoDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoSnap, undoDelete]);

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
      if (!preset) return;                       // 拖拽载荷已损坏，静默忽略
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
    [nodes.length, setNodes],
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
   */
  const [editingModule, setEditingModule] = useState<string | null>(null);
  /** 拖拽开始时的位置快照，用于整体拖动与"拖开即解嵌"的判定 */
  const dragStartRef = useRef<Record<string, { x: number; y: number }> | null>(null);
  const moduleBackup = useRef<{ nodes: FlowNode[]; edges: FlowEdge[] } | null>(null);

  const enterModuleEdit = useCallback(
    (id: string) => {
      const m = findModule(id);
      if (!m) return;
      // 已经在编辑别的模块了，先退出，否则备份会被覆盖
      if (editingModule) return;
      moduleBackup.current = { nodes, edges };
      setNodes(m.nodes.map((n) => ({ ...n })) as unknown as FlowNode[]);
      setEdges(m.edges.map((e) => ({ ...e })) as unknown as FlowEdge[]);
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
        setEdges((own.edges ?? []).map((x) => ({ ...(x as object) })) as unknown as FlowEdge[]);
      } else {
        const m = findModule(String(d.moduleId ?? ''));
        if (!m) {
          pushLog('✗ 模块已删除，无法编辑（可先在属性面板脱钩）');
          return;
        }
        setNodes(m.nodes.map((x) => ({ ...x })) as unknown as FlowNode[]);
        setEdges(m.edges.map((x) => ({ ...x })) as unknown as FlowEdge[]);
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
        const newEdges = edges.map((e) => ({
          id: e.id, source: e.source, target: e.target,
          branch: e.data?.branch,
          loopRole: e.data?.loopRole,
        }));

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
    const packed = packSelection(
      picked as never,
      edges.map((e) => ({
        id: e.id, source: e.source, target: e.target,
        branch: e.data?.branch, loopRole: e.data?.loopRole,
      })) as never,
      nodes as never,
    );

    const def = await askCreateModule({
      nodes: packed.nodes as Record<string, unknown>[],
      edges: packed.edges as unknown as Record<string, unknown>[],
    });
    if (def) pushLog(`✓ 已存成模块「${def.name}」，可从模块库拖出来复用`);
  }, [nodes, edges, pushLog]);

  const onNodeDragStart = useCallback(
    (e: unknown, node: unknown, dragged: unknown) => {
      const ev = e as { ctrlKey?: boolean; metaKey?: boolean };
      // 没按修饰键就是普通拖动。Mac 上 metaKey 才是习惯键位，一并认。
      if (!ev?.ctrlKey && !ev?.metaKey) return;

      const list = (dragged as FlowNode[]) ?? [];
      const src = list.length > 0 ? list : [node as FlowNode];
      const map = duplicateByIds(src.filter((n) => n?.id).map((n) => n.id));
      if (map) dupMapRef.current = map;
    },
    [duplicateByIds],
  );

  /** 位移作用在副本上，原件不动 */
  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const map = dupMapRef.current;
      if (!map) {
        onNodesChange(changes);
        return;
      }
      onNodesChange(
        changes.map((c) =>
          c.type === 'position' && c.id && map[c.id] ? { ...c, id: map[c.id] } : c,
        ),
      );
    },
    [onNodesChange],
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

  /*
   * 拖动开始时记下"被拖节点 + 它下方整串"的起始位置。
   *
   * Scratch 的手感：拖动一块，它下面挂着的整串一起走。
   * 所以快照要包含后代，不然下方节点会被落下、串就散了。
   */
  const onStackDragStart = useCallback(
    (_e: unknown, node: { id: string }) => {
      const kids = descendantsOf(nodes as never, node.id);
      const snap: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) {
        if (n.id === node.id || kids.includes(n.id)) {
          snap[n.id] = { x: n.position.x, y: n.position.y };
        }
      }
      dragStartRef.current = snap;
    },
    [nodes],
  );

  /** 拖动中：整串跟着走（用起始位置 + 被拖节点的位移量） */
  const onStackDrag = useCallback(
    (_e: unknown, node: { id: string; position: { x: number; y: number } }) => {
      const start = dragStartRef.current;
      if (!start || !start[node.id]) return;
      const dx = node.position.x - start[node.id].x;
      const dy = node.position.y - start[node.id].y;
      if (dx === 0 && dy === 0) return;
      setNodes((ns) => ns.map((n) => (
        start[n.id] && n.id !== node.id
          ? { ...n, position: { x: start[n.id].x + dx, y: start[n.id].y + dy } }
          : n
      )));
    },
    [setNodes],
  );

  /** 拖动结束：判定吸附 / 脱开 */
  const onStackDragStop = useCallback(
    (_e: unknown, node: { id: string; position: { x: number; y: number } }) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      if (!start) return;
      /*
       * 复制拖动时不处理嵌合：
       * 移动的是副本，原件关系没变，此时改 stackParent 会把原件改坏。
       */
      if (dupMapRef.current) return;

      const self = nodes.find((n) => n.id === node.id);
      if (!self) return;

      /*
       * 落位决定交给 engine/stack 的 planStackDrop ——
       *
       * 以前这里写的是 `if (hit && hit.parentId !== oldParent)`，
       * 于是**已经是嵌合态、只挪动了一点点**（不到脱开阈值）时：
       *   · 没到脱开距离 → 不解除
       *   · 命中的还是原来那个父，条件不成立 → 不吸附
       * 节点就停在偏移后的位置：关系还在，看着却是歪的。
       * 用户挪一点点显然不是想解开，而是想让它归位。
       */
      const oldParent = parentIdOf(self as never);
      const moved = start[node.id] ? movedEnough(start[node.id], node.position) : false;
      const exclude = new Set<string>([node.id, ...descendantsOf(nodes as never, node.id)]);

      const plan = planStackDrop(
        nodes.map((n) => ({
          id: n.id,
          position: { x: n.position.x, y: n.position.y },
          measured: n.measured as { width?: number; height?: number } | undefined,
          data: n.data as Record<string, unknown>,
        })) as never,
        {
          id: node.id,
          position: { x: node.position.x, y: node.position.y },
          measured: self.measured as { width?: number; height?: number } | undefined,
          data: self.data as Record<string, unknown>,
        } as never,
        { oldParent, moved, exclude },
      );

      if (!plan.position && plan.stackParent === undefined && !plan.attach) return;

      setNodes((ns) => {
        /*
         * 反向吸附：动的是**被拖节点自己**（往上靠到对方上边缘），
         * 对方原地不动，只改 stackParent —— 所以 moves 恒为空。
         */
        const moves = plan.attach?.moves?.length
          ? new Map(plan.attach.moves.map((m) => [m.id, m.position]))
          : null;
        /** 反向吸附时要改 stackParent 的那个节点（对方） */
        const attachChild = plan.attach?.childId ?? null;
        /** 它挂在谁下面 —— 被拖节点有串时是串尾 */
        const attachParent = plan.attach?.parentId ?? null;
        /*
         * 位移类落位（吸附 / 归位）时下级跟随的新位置。
         * 少了它：挪动串中间的一环，只有它自己归位，
         * 下级停在偏移处 —— 两块裂开而关系还在。
         */
        const follow = plan.followers?.length
          ? new Map(plan.followers.map((m) => [m.id, m.position]))
          : null;

        return ns.map((n) => {
          const isDragged = n.id === node.id;
          const at = moves?.get(n.id) ?? follow?.get(n.id);
          const isAttachChild = attachChild === n.id;
          if (!isDragged && !at && !isAttachChild) return n;

          const data = { ...(n.data as object) } as Record<string, unknown>;
          /*
           * 覆盖式写入，不会出现"一个节点有两个上级"。
           * 反向吸附时被拖节点（或它的串尾）是**父**，自己不动 stackParent，
           * 只把对方改成指向自己。
           */
          if (isDragged && plan.stackParent !== undefined) data.stackParent = plan.stackParent;
          // 对方不动位置，所以不能挂靠在 `at` 上 —— 它恒为空
          if (isAttachChild && attachParent) data.stackParent = attachParent;

          return {
            ...n,
            ...(at ? { position: at } : null),
            ...(isDragged && plan.position ? { position: plan.position } : null),
            data,
          } as FlowNode;
        });
      });

      /*
       * 嵌合 = 一条隐式边，连接判据与拉线一致。
       * 只在**换了上级**时才打日志 —— 归位与解除都是"维持现状"，
       * 每次都报一句会淹没真正的警告。
       */
      const nextParent = plan.stackParent !== undefined ? plan.stackParent : oldParent;
      if (plan.stackParent && plan.stackParent !== oldParent) {
        const verdict = canConnect(
          specOf(kindOfNode(nodes, plan.stackParent)),
          specOf(kindOfNode(nodes, node.id)),
        );
        if (verdict.reason) pushLog(`⚠ ${verdict.reason}`);
        else pushLog(`⇲ 已嵌合到 ${plan.stackParent} 下方（可整体拖动，输出自动向下传递）`);
      } else if (nextParent === null && oldParent) {
        pushLog(`⇱ 已解除与 ${oldParent} 的嵌合`);
      } else if (plan.attach) {
        /*
         * 反向吸附也要报一句 ——
         * 它是"我把别人接到了自己下面"，画面变化在**对方**身上，
         * 没有提示的话用户会以为只是自己挪了个位置。
         */
        const verdict = canConnect(
          specOf(kindOfNode(nodes, plan.attach.parentId)),
          specOf(kindOfNode(nodes, plan.attach.childId)),
        );
        if (verdict.reason) pushLog(`⚠ ${verdict.reason}`);
        else pushLog(`⇲ 已嵌合到 ${plan.attach.childId} 上方（拖动它会带着整串走）`);
      }
    },
    [nodes, setNodes, pushLog, kindOfNode],
  );

  /*
   * 折叠后的隐藏：派生一份渲染用的节点数组，而不是改 nodes。
   * 直接写 hidden 进 nodes 会被保存 effect 落盘，
   * 于是"折叠状态"变成了画布数据的一部分 —— 那是显示状态，不该进存档。
   */
  const displayNodes = useMemo(() => {
    const tops = nodes.filter((n) => Boolean((n.data as Record<string, unknown>)?.stackCollapsed));
    /*
     * 下面挂着块的节点：直筒观感要给它们压掉下圆角与下边框。
     * 这个标记塞进 data 而不是另开一条通道 —— NodeShell 只拿得到自己
     * 这一个节点，扫不到全图。不落盘（见 engine/sanitize 的 VIEW_KEYS）。
     */
    const withChild = new Set(stackParentIds(nodes as never));

    // 既没嵌合也没折叠：原样返回，不重建数组（xyflow 会因此全量重渲染）
    if (tops.length === 0 && withChild.size === 0) return nodes;

    const hidden = new Set<string>();
    for (const t of tops) {
      for (const d of descendantsOf(nodes as never, t.id)) hidden.add(d);
    }
    return nodes.map((n) => {
      let out = n;
      if (withChild.has(n.id)) {
        const merged = { ...(out.data as Record<string, unknown>), hasStackChild: true };
        // 双重断言：FlowNode 是联合类型，各成员的 data 形状不同，
        // 展开后加字段没法直接对上任何一个成员
        out = { ...out, data: merged } as unknown as typeof n;
      }
      if (tops.length > 0) {
        out = { ...out, hidden: hidden.has(n.id) } as typeof n;
      }
      return out;
    });
  }, [nodes]);

  /** 折叠 / 展开整条串（只影响显示，不影响执行） */
  const toggleStackCollapse = useCallback(
    (nodeId: string) => {
      const top = chainTopOf(nodes as never, nodeId);
      const collapsed = Boolean((nodes.find((n) => n.id === top)?.data as Record<string, unknown>)?.stackCollapsed);
      setNodes((ns) => ns.map((n) => (
        n.id === top
          ? { ...n, data: { ...(n.data as object), stackCollapsed: !collapsed } } as FlowNode
          : n
      )));
    },
    [nodes, setNodes],
  );

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
   * 把卡片套到画布上的某个节点。
   *
   * 与面板里的点选走的是同一套校验（checkCardForNode），
   * 且校验依据都是 def.meta.cardGroups —— 一处声明、两处共用，
   * 不会出现"面板能选、拖放却被拒"的不一致。
   */
  const applyCardToNode = useCallback(
    (nodeId: string, cardId: string) => {
      const target = nodes.find((n) => n.id === nodeId);
      const card = findCard(cardId);
      if (!target || !card) return;

      const def = getDef(target.type);
      const check = checkCardForNode(card, def.meta.cardGroups);
      if (!check.ok) {
        // 明确拒绝并说明原因。静默忽略会让用户以为卡片坏了。
        pushLog(`✗ ${check.reason}（${def.meta.label}）`);
        void alert({ title: '这张卡片套不上', message: check.reason });
        return;
      }

      const groupDef = getCardGroup(card.group);
      if (!groupDef) return;
      patchNode(nodeId, applyCardTo(target.data as Record<string, unknown>, card, groupDef.keys));
      pushLog(`✓ ${def.meta.label}「${target.id}」已套用卡片「${card.name}」`);
    },
    [nodes, patchNode, pushLog],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();

      /* ---- 先判是不是参数卡片 ---- */
      const cardPayload = decodeCardDrag(e.dataTransfer.getData(CARD_DRAG_MIME))
        ?? decodeCardDrag(e.dataTransfer.getData('text/plain'));
      if (cardPayload) {
        // Ctrl / ⌘ 拖动 = 复制一张新卡片（与节点复制同一套手感）
        if (e.ctrlKey || e.metaKey) {
          const copy = duplicateCard(cardPayload.cardId);
          if (copy) pushLog(`✓ 已复制卡片「${copy.name}」`);
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
          pushLog('✗ 请把卡片拖到具体的节点上');
          return;
        }
        applyCardToNode(nodeId, cardPayload.cardId);
        return;
      }

      /* ---- 模块 ---- */
      const modPayload = decodeModuleDrag(e.dataTransfer.getData(MODULE_DRAG_MIME))
        ?? decodeModuleDrag(e.dataTransfer.getData('text/plain'));
      if (modPayload) {
        const bounds2 = wrapperRef.current?.getBoundingClientRect();
        const pos2 = bounds2
          ? rfInstance.current?.screenToFlowPosition({
              x: e.clientX - bounds2.left,
              y: e.clientY - bounds2.top,
            })
          : undefined;
        spawnModule(modPayload.moduleId, pos2);
        return;
      }

      const payload = decodeDrag(e.dataTransfer.getData(DRAG_MIME))
        ?? decodeDrag(e.dataTransfer.getData('text/plain'));
      if (!payload) return;
      const bounds = wrapperRef.current?.getBoundingClientRect();
      const pos = bounds
        ? rfInstance.current?.screenToFlowPosition({
            x: e.clientX - bounds.left,
            y: e.clientY - bounds.top,
          })
        : undefined;
      spawnNode(payload, pos);
    },
    [spawnNode],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  /** 工具栏「+ 条件」。同上，走注册表 */
  const addCondition = () => {
    seq.current += 1;
    const id = `cond${Date.now().toString(36)}${seq.current}`;
    setNodes((ns) => [
      ...ns,
      {
        id, type: 'condition',
        position: { x: 220 + (ns.length % 4) * 300, y: 300 },
        data: getDef('condition').create(id, { label: '条件判断' }),
      } as FlowNode,
    ]);
    setSelectedId(id);
  };

  /* ---------------- 持久化 ---------------- */

  const save = () => {
    // 触发器是画布上的节点，随 canvases 一起持久化，不再单独落盘
    saveToStorage((k, v) => localStorage.setItem(k, v), { canvases, activeId });
    pushLog('已保存到本地');
  };

  const exportJson = () => {
    // 导出前脱敏：LLM 的 apiKey 不能跟着文件走。
    // 这个文件是要发给别人 / 传上仓库的，里面带密钥等于直接交出去，
    // 而填过密钥的人往往不会意识到它存在。
    const blob = new Blob(
      [JSON.stringify({ nodes: redactNodes(nodes), edges, triggers }, null, 2)],
      { type: 'application/json' },
    );
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = 'agent-flow.json';
    a.click();
    // click() 是同步派发的，走到这里下载已经接管了这个 URL。
    // 不 revoke 的话，URL 会连同它引用的整个 blob 一直挂在内存里 ——
    // 每次导出漏一份，反复导出内存就一直涨。
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(String(reader.result));
        setNodes(p.nodes ?? []);
        setEdges(p.edges ?? []);
        // 触发器现在是画布上的节点，随 nodes 一起导入，不再单独存储
        pushLog(`已导入 ${p.nodes?.length ?? 0} 个节点、${p.edges?.length ?? 0} 条连线`);
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
      setNodes((ns) => ns.map((n) =>
        (n.id === e.id ? { ...n, data: { ...n.data, lastFiles: e.files } } as FlowNode : n)));
      if (e.files.length > 0) {
        pushLog(`📎 ${e.id} 识别到 ${e.files.length} 个文件：${e.files.slice(0, 3).join(', ')}${e.files.length > 3 ? ' …' : ''}`);
      }
    } else if (e.type === 'layer-start') {
      pushLog(`第 ${e.layer + 1}/${e.total} 层开始：${e.ids.join(', ')}`);
    } else if (e.type === 'update-checked') {
      pushLog(`🔍 ${e.id} ${e.reason}`);
      // 把新基线写回节点并持久化：否则下次运行又当成"首次"，永远检测不到更新
      setNodes((ns) => ns.map((n) =>
        (n.id === e.id ? { ...n, data: { ...n.data, ...e.patch } } as FlowNode : n)));
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
    const runNodes = tgtCanvas && tgtCanvas.id !== activeId
      ? (tgtCanvas.nodes as FlowNode[])
      : nodes;
    const runEdges = tgtCanvas && tgtCanvas.id !== activeId
      ? (tgtCanvas.edges as Edge[])
      : edges;

    /*
     * 嵌合 = 一条隐式边（上方 → 下方）。这里先算出来：
     * 任务记录要抄一份连线去画流程图，下面拼执行图也要用 ——
     * 两处各算一次会不一致（图上连着、跑起来却没这条边）。
     */
    const stackE = stackEdges(runNodes as never);

    // 建一条任务记录。total 先按节点数估，运行时以实际出现的节点为准
    const task = makeTask({
      canvasId: tgtId ?? '',
      canvasName: tgtCanvas?.name ?? canvases.find((c) => c.id === activeId)?.name ?? '未命名流程',
      source,
      total: runNodes.length,
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
    });
    currentTaskRef.current = task.id;
    setTasks((list) => [task, ...list]);
    // 自动切到任务窗口，让人立刻看到进度 ——
    // 触发器半夜跑起来时，停留在画布上看不出发生了什么
    setView('tasks');
    setSummary(null);
    activeRuns.current.clear();
    const controller = new AbortController();
    abortRef.current = controller;
    const stamp = String(Date.now());

    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, output: '', error: '', status: 'idle' } } as FlowNode)));

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
      // 用 ref 而非 let：闭包里赋值时，TS 的流分析看不到赋值点，
      // 会把 `if (!done) throw` 之后的 done 收窄成 never。
      const doneRef: { current: DonePayload | null } = { current: null };
      // 执行器只会被任务节点调用：条件/触发器/并发节点在执行器内部处理并 continue
      const d = node.data as TaskNodeData;
      await runCli(
        { runId, cli: d.cli, cmd: DEFAULT_CMD[d.cli], prompt: rendered,
          workdir: d.workdir, model: d.model, yolo: d.yolo },
        {
          onStdout: (c) => onChunk(c),
          onStderr: (c) => onChunk(c),
          onDone: (p) => { doneRef.current = p; },
        },
      );
      activeRuns.current.delete(node.id);
      const done = doneRef.current;
      if (!done) throw new Error('未收到进程结束事件');
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
      paramsForRun[n] = String(p.value ?? '');
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
      });
      return { status: r.status, ok: r.ok, text: r.text, headers: r.headers };
    };

    const result = await runGraph(graph, {
      concurrency, executor, fsExecutor, fetcher, llmCaller, imageReader,
      githubFetch, githubPush, httpRequester, credentials, playAudioReader, tableReader,
      input: effectiveInput, onEvent, signal: controller.signal,
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
    setRunning(false);
    abortRef.current = null;
    return result.ok;
  }, [running, nodes, edges, concurrency, globalInput, onEvent, setNodes, pushLog, activeId, canvases, saveHistory, credentials]);

  // 调度器通过 ref 调用 run，避免闭包捕获旧状态
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  // run 里要读最新的历史文件，但把 history 放进依赖会让 run 频繁重建
  const historyRef = useRef(historyFile);
  useEffect(() => { historyRef.current = historyFile; }, [historyFile]);

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
        const ok = await runRef.current(injected, src, gt?.canvasId);
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
  useEffect(() => {
    if (!watchSupported) return;
    const wanted = new Map<string, Trigger>(
      triggers
        .filter((t) => t.kind === 'watch' && t.enabled && t.config.watchDir)
        .map((t) => [t.id, t] as const),
    );

    // 关掉不再需要或配置变了的
    for (const [id, cleanup] of watchCleanups.current) {
      const t = wanted.get(id);
      if (!t) {
        cleanup();
        watchCleanups.current.delete(id);
      }
    }

    // 新开缺失的
    for (const [id, t] of wanted) {
      if (watchCleanups.current.has(id)) continue;
      /*
       * 必须 catch。
       *
       * 以前这里只有 .then 没有 .catch ——
       * 目录不存在、没授权、后端不支持时 startWatch 会 reject，
       * 于是产生一个 unhandled rejection：**错误被静默吞掉**。
       *
       * 后果是用户配了一个监听，界面上看起来在跑（开关是开的），
       * 实际上根本没起来，而且没有任何提示 ——
       * 他会一直等一个永远不会来的触发。
       */
      void startWatch(id, t.config.watchDir, t.config.watchRecursive, (path) => {
        scheduler.notifyWatch(path);
      }).then((cleanup) => {
        if (cleanup) watchCleanups.current.set(id, cleanup);
      }).catch((err: unknown) => {
        pushLog(`✗ 目录监听启动失败（${t.config.watchDir || '未填目录'}）：${describeErr(err)}`);
      });
    }
  }, [triggers, watchSupported, scheduler]);

  useEffect(() => () => {
    watchCleanups.current.forEach((c) => c());
    watchCleanups.current.clear();
  }, []);

  // 为启用的 webhook 触发器启动本地 HTTP 服务
  const webhookCleanups = useRef<Map<string, () => void>>(new Map());
  // 触发器没填校验 Token 时，后端会生成一个；按触发器 id 存下来给界面提示
  const [webhookTokens, setWebhookTokens] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!webhookSupported) return;
    const wanted = new Map<string, Trigger>(
      triggers.filter((t) => t.kind === 'webhook' && t.enabled).map((t) => [t.id, t] as const),
    );

    for (const [id, cleanup] of webhookCleanups.current) {
      if (!wanted.has(id)) {
        cleanup();
        webhookCleanups.current.delete(id);
        setWebhookTokens((m) => {
          if (!(id in m)) return m;
          const next = { ...m };
          delete next[id];
          return next;
        });
      }
    }

    for (const [id, t] of wanted) {
      if (webhookCleanups.current.has(id)) continue;
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
        if (cleanup) webhookCleanups.current.set(id, cleanup);
      });
    }
  }, [triggers, webhookSupported, scheduler]);

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
        onSelect={setActiveId}
        onAdd={handleAddCanvas}
        onRename={handleRenameCanvas}
        onDelete={handleDeleteCanvas}
        disabled={running}
      />
      <div className="toolbar">
        <div className="view-switch">
          <button className={view === 'flow' ? 'on' : ''} onClick={() => setView('flow')}>
            流程
          </button>
          <button className={view === 'tasks' ? 'on' : ''} onClick={() => setView('tasks')}>
            任务
            {tasks.filter((t) => t.status === 'running').length > 0 ? (
              <span className="view-badge">
                {tasks.filter((t) => t.status === 'running').length}
              </span>
            ) : null}
          </button>
          <button className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}>
            历史
          </button>
        </div>
        {histWarn ? (
          <span className="hist-warn-inline" title={histWarn}>⚠ 归档存储</span>
        ) : null}
        <strong className="brand">Agent Flow</strong>
        {/*
          这几个是**画布编辑**按钮。任务 / 历史视图里画布是藏起来的，
          留着就是点了没反应 —— 和别处的"静默失效"是同一类问题，所以一并隐藏。
          运行 / 保存 / 导入导出 不受影响：那些在查看态下依然有意义。
        */}
        {view === 'flow' ? (
          <>
            <button onClick={addTask} disabled={running}>+ 任务</button>
            <button onClick={addCondition} disabled={running}>+ 条件</button>
            <button onClick={() => spawnNode({ kind: 'parallel' })} disabled={running}>+ 并发</button>
            <button onClick={() => spawnNode({ kind: 'trigger' })} disabled={running}>
              + 触发器
            </button>
            <button
              onClick={deleteSelected}
              disabled={running || nodes.length === 0}
              title="删除选中的节点或连线（Delete / Backspace）"
            >
              删除
            </button>
            <button
              onClick={undoDelete}
              disabled={running || !undoSnap}
              title={undoSnap ? `撤销删除：${undoSnap.label}` : '没有可撤销的删除'}
            >
              ↩ 撤销
            </button>
          </>
        ) : null}
        <button className="primary" onClick={() => void run(undefined, 'manual')} disabled={running || nodes.length === 0}>
          {running ? '运行中…' : '运行工作流'}
        </button>
        <button onClick={stop} disabled={!running}>停止</button>

        <span className="trg-btn-static" title="触发器已作为节点放在画布上">
          ⏱ 触发器{triggers.length > 0 && <span className="dot">{enabledCount}/{triggers.length}</span>}
        </span>

        <label className="inline" title="原生＝固定 Agent Flow 自己的样式；跟随＝用面板主题">
          外观
          <select value={themeMode} onChange={(e) => setThemeMode(e.target.value as ThemeMode)}>
            <option value="follow">跟随面板</option>
            <option value="native">原生样式</option>
          </select>
        </label>
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
            左栏内容随视图换：
              流程   → 节点库 / 模块库 / 画布库（三个标签）
              任务   → 任务列表
              历史   → 历史列表

            任务 / 历史下画布是隐藏的，节点库拖不出东西 ——
            留着它是一条"点了没反应"的死栏。所以列表顶上同一条栏，
            位置、宽度、底板（.side-pane）全都与节点库一致。
          */}
          {view !== 'flow' ? null : (
            <div className="pane-tabs">
              {LEFT_TABS.map((t) => (
                <button
                  key={t}
                  className={leftTab === t ? 'on' : ''}
                  onClick={() => setLeftTabRaw(t)}
                >
                  {LEFT_TAB_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          <div className="pane-body">
            {view === 'tasks' ? (
              <TaskList
                tasks={tasks}
                now={tick}
                onClear={() => setTasks((list) => list.filter((t) => t.status === 'running'))}
                selectedId={taskSel}
                onSelect={setTaskSel}
              />
            ) : view === 'history' ? (
              <HistoryList
                entries={history}
                now={tick}
                onDelete={(id) => saveHistory(removeFromHistory(historyFile, id))}
                onClearAll={() => saveHistory(emptyHistory())}
                onClearCanvas={(canvasId) => saveHistory(clearCanvasHistory(historyFile, canvasId))}
                selectedId={histSel}
                onSelect={setHistSel}
              />
            ) : leftTab === 'node' ? (
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
                onSelect={setActiveId}
                onAdd={handleAddCanvas}
                onAddGroup={handleAddGroup}
                onRenameGroup={handleRenameGroup}
                onDeleteGroup={handleDeleteGroup}
                onDropToGroup={handleDropToGroup}
                onRemoveFromGroup={handleRemoveFromGroup}
                onToggleCollapse={handleToggleCollapse}
                disabled={running}
              />
            )}
          </div>
        </div>
        <div className="af-body-main">


      <div className="body">
        {/*
          列表已移到左栏（与节点库共用底板），这里只放**详情**。
        */}
        {view === 'history' ? (
          <div className="task-detail">
            {!activeHist ? (
              <div className="nx-empty task-empty">选一条记录看细节。</div>
            ) : (
              <TaskDetail
                task={activeHist}
                now={tick}
                showDate
                archived
                onJumpToCanvas={(canvasId) => {
                  if (canvasId && canvases.some((c) => c.id === canvasId)) {
                    setActiveId(canvasId);
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
                  setActiveId(canvasId);
                  pendingLocate.current = { canvasId, nodeId };
                }}
              />
            )}
          </div>
        ) : null}
        {view === 'tasks' ? (
          <div className="task-detail">
            {!activeTask ? (
              <div className="nx-empty task-empty">选一条任务看细节。</div>
            ) : (
              <TaskDetail
                task={activeTask}
                now={tick}
                onCancel={(id) => {
                  // 只允许停当前那条；历史记录没有可停的东西
                  if (id === currentTaskRef.current) stop();
                }}
                onJumpToCanvas={(canvasId) => {
                  if (canvasId && canvases.some((c) => c.id === canvasId)) {
                    setActiveId(canvasId);
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
                  setActiveId(canvasId);
                  pendingLocate.current = { canvasId, nodeId };
                }}
              />
            )}
          </div>
        ) : null}
        <div className="canvas" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver} style={view === 'flow' ? undefined : { display: 'none' }}>
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onInit={(inst) => { rfInstance.current = inst; }}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            /* 按住 Ctrl / ⌘ 拖动 = 复制一份跟着鼠标走，原件留在原地 */
            /*
             * 拖拽开始有两个用途，必须都挂在同一个回调上：
             *  · Ctrl / ⌘ 拖动 → 复制（onNodeDragStart）
             *  · 嵌合整串跟随 + 位置快照（onStackDragStart）
             * 分开挂两个同名属性是语法错误，合成一个。
             */
            onNodeDragStart={(e, n, ns) => { onNodeDragStart(e, n, ns); onStackDragStart(e, n); }}
            onNodeDragStop={(e, n, ns) => { onNodeDragStop(); onStackDragStop(e, n); }}
            onNodeDrag={onStackDrag}
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
            onCancel={() => setPendingExport(null)}
          />
        ) : null}

        {deleteNotice && (
          <div className="delete-notice">
            <span>⚠ {deleteNotice}</span>
            <button className="mini" onClick={() => setDeleteNotice(null)}>知道了</button>
          </div>
        )}

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
        <div className="af-right-pane">
          <div className="af-right-insp">
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
              onChange={patchNode}
              credentials={credentials}
              onOpenCredentials={openCredentials}
              webhookTokens={webhookTokens}
              onEditModule={(id) => enterInstanceEdit(id)}
              onNote={pushLog}
              exportDir={exportDir}
              onChangeExportDir={setExportDir}
              onBrowseExportDir={() => setPendingExport(BROWSE_ONLY)}
              canExportToFile={canExportToFile()}
              canvasConfig={canvasConfigOf(activeCanvas)}
              onCanvasConfigChange={saveCanvasConfig}
              onExportFlow={exportFlowAs}
              canvases={canvases}
              activeCanvasId={activeId ?? undefined}
            />
          </fieldset>
        </div>


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
          />
        ) : null}

          </div>

          {/*
            分隔条：按住上下拖改日志区高度。
            向上拖 = 日志变高（鼠标往上、日志在下方，所以取反）。
          */}
          <div
            className="af-right-split"
            role="separator"
            aria-orientation="horizontal"
            title="拖动调整日志区高度"
            onMouseDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = logH;
              const move = (ev: MouseEvent) => {
                setLogH(normalizeLogHeight(startH - (ev.clientY - startY)));
              };
              const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
              };
              window.addEventListener('mousemove', move);
              window.addEventListener('mouseup', up);
            }}
          />

          <div className="af-right-log" style={{ height: logH }}>
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
          </div>
        </div>
      </div>
      </div>
      </div>
    </div>
  );
}


