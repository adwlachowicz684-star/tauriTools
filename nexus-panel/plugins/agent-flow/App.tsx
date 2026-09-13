import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, useReactFlow,
  type Connection, type Edge, type NodeTypes, type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import TaskNode from './components/TaskNode';
import ConditionNode from './components/ConditionNode';
import TriggerNode from './components/TriggerNode';
import ParallelNode from './components/ParallelNode';
import LoopNode from './components/LoopNode';
import FsNode from './components/FsNode';
import UpdateNode from './components/UpdateNode';
import OcrNode from './components/OcrNode';
import TranslateNode from './components/TranslateNode';
import Inspector from './components/Inspector';
import { GithubUpdateNode, GithubPushNode } from './components/GithubNode';
import { CredentialPanel, canUse } from './components/CredentialPanel';
import {
  type Credential, type CredentialKind,
  pickFor, needsOf, kindForNeed, missingCapabilities,
} from './engine/credentials';
import { verifyToken } from './engine/github';
import {
  parseStore, serializeStore, encryptStore, decryptStore, newDeviceSalt,
  collectDeviceSignals, defaultBackend, type StoredFile,
} from './engine/credentialStore';
import { deviceSeed } from './engine/crypto';
import Sidebar, { DRAG_MIME, decodeDrag, type DragPayload } from './components/Sidebar';
import CanvasTabs from './components/CanvasTabs';
import { TaskPanel } from './components/TaskPanel';
import {
  makeTask, applyEvent, finishTask, cancelTask, clampOutput,
  type TaskRecord, type TaskSource,
} from './engine/tasks';
import {
  runGraph,
  type Executor, type FsExecutor, type Fetcher, type LlmCaller, type ImageReader,
  type RunEvent, type RunSummary,
} from './engine/runner';
import { TriggerScheduler } from './engine/triggers';
import {
  makeCanvas, nextCanvasName, renameCanvas, removeCanvas, nextActiveId,
  updateCanvasContent, sortForDisplay, toMeta,
  loadFromStorage, saveToStorage,
  type Canvas,
} from './engine/canvasStore';
import { CLI_META, DEFAULT_TRIGGER_CONFIG, DEFAULT_BRANCH, type TaskNodeData, makeNode, makeConditionNode, makeParallelNode, makeTriggerNode,
  makeLoopNode, makeFsNode, makeUpdateNode, makeOcrNode, makeTranslateNode,
  makeGithubUpdateNode, makeGithubPushNode,
  isTrigger, isLoop, isOcr, isTranslate, triggerKindsOf, type CliKind, type FsNodeData,
  type Graph, type NodeData, type Trigger, type TriggerKind, type TriggerConfig } from './types';
import type { FlowEdge, FlowNode } from './flowTypes';
import { killCli, runCli, canWatch, startWatch, canWebhook, startWebhook,
  fileOp, fsArgsOf, fetchText, postJson, readImageDataUrl, type DonePayload } from './lib/tauri';
import {
  deleteElements, nextSelection, hasAnythingToDelete,
  makeSnapshot, describeDelete,
  type UndoSnapshot,
} from './engine/canvasOps';

const nodeTypes: NodeTypes = {
  'github-update': GithubUpdateNode,
  'github-push': GithubPushNode,
  task: TaskNode,
  condition: ConditionNode,
  trigger: TriggerNode,
  parallel: ParallelNode,
  loop: LoopNode,
  fs: FsNode,
  // B站与公众号是两种不同的源，但数据结构与展示几乎一致，
  // 注册成两个类型是为了在画布上有各自的图标与配色
  bili: UpdateNode,
  wechat: UpdateNode,
  ocr: OcrNode,
  translate: TranslateNode,
};
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
  const [canvases, setCanvases] = useState<Canvas[]>(init.canvases);
  const [activeId, setActiveId] = useState<string | null>(init.activeId);

  const active = canvases.find((c) => c.id === activeId) ?? null;
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(
    (active?.nodes ?? []) as FlowNode[],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    (active?.edges ?? []) as FlowEdge[],
  );

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
  }, [nodes, edges, activeId, canvases]);

  /** 持久化整个多画布状态 */
  useEffect(() => {
    saveToStorage((k, v) => localStorage.setItem(k, v), { canvases, activeId });
  }, [canvases, activeId]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  /* ---------------- 任务窗口 ---------------- */
  /**
   * 只保留本次会话的记录，不落盘 ——
   * 跨会话的历史归"历史窗口"管，那个后面单独做。
   */
  const MAX_TASKS = 30;
  const [view, setView] = useState<'flow' | 'tasks'>('flow');
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  /** 当前正在跑的任务 id。用 ref 避免 onEvent 因依赖变化而重建 */
  const currentTaskRef = useRef<string | null>(null);
  /** 每秒走一次，让任务耗时与进度实时刷新 */
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!running && !tasks.some((t) => t.status === 'running')) return;
    const h = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [running, tasks]);

  /* ---------------- 凭据中心 ---------------- */
  /**
   * 凭据单独存一个 key，不混进画布存档。
   * 画布会被导出分享，密钥一旦进去就等于交出去了；
   * 分开存之后，导出的文件里只有 credentialId，没有密钥本身。
   */
  /* ---------------------------------------------------------------- *
   * 凭据库（加密）                                                    *
   *                                                                   *
   * 内存里是明文，磁盘上是密文。加解密只在 load / save 两个出入口做，  *
   * 组件照常读写 credential.secret，不需要知道加密的存在 ——             *
   * 加密一旦散落到各处，总会有人忘了调。                               *
   * ---------------------------------------------------------------- */
  const CRED_KEY = 'agent-flow.credentials.v1';
  const beRef = useRef(defaultBackend());
  const [store, setStore] = useState<StoredFile>(() => parseStore(localStorage.getItem(CRED_KEY)));
  const [credentials, setCredentials] = useState<Credential[]>([]);
  /** 解锁用的口令；null 表示锁着 */
  const [vaultKey, setVaultKey] = useState<string | null>(null);
  const [credOpen, setCredOpen] = useState(false);
  const [credFocus, setCredFocus] = useState<string>('');
  const [unlockErr, setUnlockErr] = useState('');
  const [cryptoWarn, setCryptoWarn] = useState('');

  // 首次运行：生成设备盐；auto 模式用本机特征直接解锁
  useEffect(() => {
    const be = beRef.current;
    if (!be) {
      setCryptoWarn('当前环境不支持 WebCrypto，凭据将以明文保存。请避免在公用设备上使用。');
      return;
    }
    setCryptoWarn('');
    let file = store;
    if (!file.deviceSalt) {
      file = { ...file, deviceSalt: newDeviceSalt(be) };
      setStore(file);
    }
    if (file.mode === 'auto') {
      const seed = deviceSeed(collectDeviceSignals(file.deviceSalt));
      setVaultKey(seed);
    }
    // 只依赖 deviceSalt 是否为空：mode 与凭据由下面两个 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 解锁状态变化（或换模式后）→ 解密出运行时凭据
  useEffect(() => {
    const be = beRef.current;
    if (!be || vaultKey === null) return;
    let alive = true;
    decryptStore(be, store, vaultKey).then((r) => {
      if (!alive) return;
      setCredentials(r.credentials);
      if (r.failed.length > 0) {
        setUnlockErr(`有 ${r.failed.length} 条凭据解不开，可能是口令不对或数据损坏。`);
      }
    });
    return () => { alive = false; };
    // store 变化时不重跑：否则保存后又立刻解密，会和用户输入打架
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultKey]);

  // 凭据变化 → 加密落盘
  useEffect(() => {
    const be = beRef.current;
    if (!be || vaultKey === null) return;
    let alive = true;
    encryptStore(be, store, credentials, vaultKey).then((next) => {
      if (!alive) return;
      setStore(next);
      try { localStorage.setItem(CRED_KEY, serializeStore(next)); } catch { /* 忽略 */ }
    });
    return () => { alive = false; };
    // store 是上一次的产物，纳入依赖会死循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials, vaultKey]);

  /** 用口令解锁 */
  const unlock = useCallback(async (pass: string) => {
    const be = beRef.current;
    if (!be) { setUnlockErr('环境不支持加密'); return; }
    const r = await decryptStore(be, store, pass);
    if (store.credentials.length > 0 && r.failed.length === store.credentials.length) {
      setUnlockErr('口令不对，一条都没解开。');
      return;
    }
    setUnlockErr('');
    setVaultKey(pass);
    setCredentials(r.credentials);
  }, [store]);

  /** 切换加密方式：用新口令重新加密全部凭据 */
  const changeVaultMode = useCallback(async (mode: 'auto' | 'passphrase', pass: string) => {
    const be = beRef.current;
    if (!be) return;
    let salt = store.deviceSalt;
    if (!salt) { salt = newDeviceSalt(be); }
    const newKey = mode === 'auto' ? deviceSeed(collectDeviceSignals(salt)) : pass;
    const base: StoredFile = { ...store, mode, deviceSalt: salt };
    const next = await encryptStore(be, base, credentials, newKey);
    setStore(next);
    setVaultKey(newKey);
    try { localStorage.setItem(CRED_KEY, serializeStore(next)); } catch { /* 忽略 */ }
  }, [store, credentials]);

  const openCredentials = useCallback((kind: string) => {
    setCredFocus(kind);
    setCredOpen(true);
  }, []);
  const [concurrency, setConcurrency] = useState(1);
  const [globalInput, setGlobalInput] = useState('');
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [log, setLog] = useState<string[]>([]);

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
  const triggers = useMemo<Trigger[]>(
    () =>
      nodes
        .filter((n) => isTrigger(n.data))
        .flatMap((n) => {
          const d = n.data as {
            triggers?: TriggerKind[]; trigger?: TriggerKind;
            config: Record<string, unknown>; input: string;
            enabled: boolean; label: string;
          };
          const kinds = triggerKindsOf(d as never);
          const base = { ...DEFAULT_TRIGGER_CONFIG, ...(d.config ?? {}) } as TriggerConfig;
          return kinds.map((kind) => ({
            id: `${n.id}:${kind}`,
            nodeId: n.id,
            name: d.label,
            kind,
            enabled: d.enabled !== false,
            config: base,
            input: d.input ?? '',
            lastFiredAt: null,
            lastResult: null,
          } as Trigger));
        }),
    [nodes],
  );
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

  const pushLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLog((l) => [`${ts} ${msg}`, ...l].slice(0, 100));
  }, []);

  /* ---------------- 节点编辑 ---------------- */

  const patchNode = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) =>
      // 断言放在整体而非 data 上：若把 data 单独断言成联合类型 NodeData，
      // 展开后就无法落回 FlowNode 的任何一个具体分支（task/condition/…）。
      (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as FlowNode) : n)));
  }, [setNodes]);

  const addTask = () => {
    seq.current += 1;
    const id = `task${Date.now().toString(36)}${seq.current}`;
    setNodes((ns) => [
      ...ns,
      { id, type: 'task', position: { x: 80 + (ns.length % 4) * 300, y: 80 + Math.floor(ns.length / 4) * 220 },
        data: makeNode(id, { label: `任务 ${ns.length + 1}` }).data } as FlowNode,
    ]);
    setSelectedId(id);
  };

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
      setEdges((eds) => addEdge(newEdge as Edge, eds) as FlowEdge[]);
    },
    [setEdges, nodes],
  );

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
    setCanvases((cs) => renameCanvas(cs, id, name).list);
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

      let node: FlowNode;
      if (p.kind === 'task') {
        const id = `t${suffix}`;
        node = { id, type: 'task', position: pos,
          data: makeNode(id, { label: `${CLI_META[p.cli]?.label ?? '任务'}任务`, cli: p.cli }).data } as FlowNode;
      } else if (p.kind === 'condition') {
        const id = `c${suffix}`;
        node = { id, type: 'condition', position: pos,
          data: makeConditionNode(id, { label: '条件判断' }).data } as FlowNode;
      } else if (p.kind === 'parallel') {
        const id = `p${suffix}`;
        node = { id, type: 'parallel', position: pos,
          data: makeParallelNode(id, { label: '并发控制' }).data } as FlowNode;
      } else if (p.kind === 'loop') {
        const id = `lp${suffix}`;
        node = { id, type: 'loop', position: pos,
          data: makeLoopNode(id, { label: '循环' }).data } as FlowNode;
      } else if (p.kind === 'fs') {
        const id = `f${suffix}`;
        node = { id, type: 'fs', position: pos,
          data: makeFsNode(id, { label: '文件操作' }).data } as FlowNode;
      } else if (p.kind === 'bili') {
        const id = `bl${suffix}`;
        node = { id, type: 'bili', position: pos,
          data: makeUpdateNode(id, 'bilibili').data } as FlowNode;
      } else if (p.kind === 'wechat') {
        const id = `wx${suffix}`;
        node = { id, type: 'wechat', position: pos,
          data: makeUpdateNode(id, 'wechat').data } as FlowNode;
      } else if (p.kind === 'ocr') {
        const id = `ocr${suffix}`;
        node = { id, type: 'ocr', position: pos,
          data: makeOcrNode(id, { label: '图片识别' }).data } as FlowNode;
      } else if (p.kind === 'github-update') {
        const id = `gu${suffix}`;
        node = { id, type: 'github-update', position: pos,
          data: makeGithubUpdateNode(id, { label: 'GitHub 更新' }).data } as FlowNode;
      } else if (p.kind === 'github-push') {
        const id = `gp${suffix}`;
        node = { id, type: 'github-push', position: pos,
          data: makeGithubPushNode(id, { label: 'GitHub 推送' }).data } as FlowNode;
      } else if (p.kind === 'translate') {
        const id = `ty${suffix}`;
        node = { id, type: 'translate', position: pos,
          data: makeTranslateNode(id, { label: '翻译' }).data } as FlowNode;
      } else {
        // 一个节点即可挂多种方式，默认只勾「手动」——
        // 周期/定时/监听/调用都会自动跑，放上画布就生效太危险
        const id = `tr${suffix}`;
        node = { id, type: 'trigger', position: pos,
          data: makeTriggerNode(id, ['manual'], { label: '触发器' }).data } as FlowNode;
      }
      setNodes((ns) => [...ns, node]);
      setSelectedId(node.id);
    },
    [nodes.length, setNodes],
  );

  /** 拖放到画布：需要把屏幕坐标换算成画布坐标 */
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
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

  const addCondition = () => {
    seq.current += 1;
    const id = `cond${Date.now().toString(36)}${seq.current}`;
    setNodes((ns) => [
      ...ns,
      { id, type: 'condition', position: { x: 220 + (ns.length % 4) * 300, y: 300 },
        data: makeConditionNode(id, { label: '条件判断' }).data } as FlowNode,
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
    const blob = new Blob([JSON.stringify({ nodes, edges, triggers }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'agent-flow.json';
    a.click();
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
    } else if (e.type === 'run-done') {
      pushLog(e.ok ? '运行结束：全部成功' : '运行结束：存在失败或跳过');
    }
  }, [setNodes, pushLog]);

  /**
   * 跑一轮工作流。
   * @param inputOverride 触发器注入的全局输入，优先级高于工具栏里的输入框
   */
  const run = useCallback(async (inputOverride?: string, source: TaskSource = 'unknown'): Promise<boolean> => {
    if (running) {
      pushLog('已有任务在运行，本次触发被跳过');
      return false;
    }
    setRunning(true);

    // 建一条任务记录。total 先按节点数估，运行时以实际出现的节点为准
    const task = makeTask({
      canvasId: activeId ?? '',
      canvasName: canvases.find((c) => c.id === activeId)?.name ?? '未命名流程',
      source,
      total: nodes.length,
    });
    currentTaskRef.current = task.id;
    setTasks((list) => [task, ...list].slice(0, MAX_TASKS));
    // 自动切到任务窗口，让人立刻看到进度 ——
    // 触发器半夜跑起来时，停留在画布上看不出发生了什么
    setView('tasks');
    setSummary(null);
    activeRuns.current.clear();
    const controller = new AbortController();
    abortRef.current = controller;
    const stamp = String(Date.now());

    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, output: '', error: '', status: 'idle' } } as FlowNode)));

    const graph: Graph = {
      nodes: nodes.map((n) => ({ id: n.id, data: n.data })),
      edges: edges.map((e) => ({
        id: e.id, source: e.source, target: e.target,
        // 条件分支用 branch，循环出口用 loopRole——两者语义不同，不能混
        branch: e.data?.branch,
        loopRole: e.data?.loopRole,
      })),
    };

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
    /* 大模型调用：走 Tauri http 插件（若启用），否则退回浏览器 fetch */
    const llmCaller: LlmCaller = async (req) =>
      postJson(req.url, req.body, req.headers, req.timeoutSec);

    /* 本地图片读取：桌面端才有，浏览器模式会抛错并由节点转成提示 */
    const imageReader: ImageReader = (path) => readImageDataUrl(path);

    const result = await runGraph(graph, {
      concurrency, executor, fsExecutor, fetcher, llmCaller, imageReader,
      input: effectiveInput, onEvent, signal: controller.signal,
    });
    setSummary(result);
    const finishedId = currentTaskRef.current;
    if (finishedId) {
      setTasks((list) => list.map((t) => (t.id === finishedId ? finishTask(t, result.ok) : t)));
      currentTaskRef.current = null;
    }
    setRunning(false);
    abortRef.current = null;
    return result.ok;
  }, [running, nodes, edges, concurrency, globalInput, onEvent, setNodes, pushLog, activeId, canvases]);

  // 调度器通过 ref 调用 run，避免闭包捕获旧状态
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  const triggersRef = useRef(triggers);
  useEffect(() => { triggersRef.current = triggers; }, [triggers]);

  /* ---------------- 触发器调度 ---------------- */

  const scheduler = useMemo(
    () => new TriggerScheduler({
      getTriggers: () => triggersRef.current,
      onFire: async (t, _reason, payload) => {
        // webhook 且开启了"请求体注入"时，payload 优先于触发器的固定输入
        const injected = t.kind === 'webhook' && t.config.payloadToInput && payload
          ? payload
          : t.input;
        // 把触发方式带进任务记录：任务窗口里要能分清
        // 「我手动点的」和「半夜自己跑起来的」
        const src: TaskSource =
          t.kind === 'interval' ? 'interval'
            : t.kind === 'cron' ? 'cron'
              : t.kind === 'watch' ? 'watch'
                : t.kind === 'webhook' ? 'webhook'
                  : 'manual';
        const ok = await runRef.current(injected, src);
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
      void startWatch(id, t.config.watchDir, t.config.watchRecursive, (path) => {
        scheduler.notifyWatch(path);
      }).then((cleanup) => {
        if (cleanup) watchCleanups.current.set(id, cleanup);
      });
    }
  }, [triggers, watchSupported, scheduler]);

  useEffect(() => () => {
    watchCleanups.current.forEach((c) => c());
    watchCleanups.current.clear();
  }, []);

  // 为启用的 webhook 触发器启动本地 HTTP 服务
  const webhookCleanups = useRef<Map<string, () => void>>(new Map());
  useEffect(() => {
    if (!webhookSupported) return;
    const wanted = new Map<string, Trigger>(
      triggers.filter((t) => t.kind === 'webhook' && t.enabled).map((t) => [t.id, t] as const),
    );

    for (const [id, cleanup] of webhookCleanups.current) {
      if (!wanted.has(id)) {
        cleanup();
        webhookCleanups.current.delete(id);
      }
    }

    for (const [id, t] of wanted) {
      if (webhookCleanups.current.has(id)) continue;
      void startWebhook(id, t.config.port, t.config.path, t.config.token, (body) => {
        void scheduler.notifyWebhook(id, body);
      }).then((cleanup) => {
        if (cleanup) webhookCleanups.current.set(id, cleanup);
      });
    }
  }, [triggers, webhookSupported, scheduler]);

  useEffect(() => () => {
    webhookCleanups.current.forEach((c) => c());
    webhookCleanups.current.clear();
  }, []);

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
      <Sidebar onAdd={(p) => spawnNode(p)} disabled={running} />
      <div className="app">
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
        </div>
        <strong className="brand">Agent Flow</strong>
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

      <div className="body">
        {view === 'tasks' ? (
          <TaskPanel
            tasks={tasks}
            now={tick}
            onCancel={(id) => {
              // 只允许停当前那条；历史记录没有可停的东西
              if (id === currentTaskRef.current) stop();
            }}
            onClear={() => setTasks((list) => list.filter((t) => t.status === 'running'))}
            onJumpToCanvas={(canvasId) => {
              if (canvasId && canvases.some((c) => c.id === canvasId)) {
                setActiveId(canvasId);
                setView('flow');
              }
            }}
          />
        ) : null}
        <div className="canvas" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver} style={view === 'tasks' ? { display: 'none' } : undefined}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onInit={(inst) => { rfInstance.current = inst; }}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            /* xyflow v12 的 onBeforeDelete 传的是节点/边对象（内部按 id 处理，需转换），
               且签名要求返回 Promise，所以要 async */
            onBeforeDelete={async ({ nodes: dn, edges: de }) =>
              beforeDelete({ nodeIds: dn.map((n) => n.id), edgeIds: de.map((e) => e.id) })}
            onNodesDelete={handleNodesDelete}
            deleteKeyCode={running ? null : ['Delete', 'Backspace']}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {deleteNotice && (
          <div className="delete-notice">
            <span>⚠ {deleteNotice}</span>
            <button className="mini" onClick={() => setDeleteNotice(null)}>知道了</button>
          </div>
        )}
        <Inspector
          node={selected}
          edges={edges}
          onChange={patchNode}
          credentials={credentials}
          onOpenCredentials={openCredentials}
        />

        {credOpen ? (
          <CredentialPanel
            credentials={credentials}
            onChange={(next) => setCredentials(next)}
            onClose={() => { setCredOpen(false); setCredFocus(''); }}
            verify={verifyCredential}
            locked={vaultKey === null}
            mode={store.mode}
            onUnlock={(pass) => {
              if (pass === '') { setVaultKey(null); setCredentials([]); return; }
              unlock(pass);
            }}
            onChangeMode={changeVaultMode}
            cryptoWarn={cryptoWarn}
            unlockError={unlockErr}
          />
        ) : null}

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
  );
}
