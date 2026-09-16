import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, useReactFlow,
  type Connection, type Edge, type NodeTypes, type ReactFlowInstance,
  type NodeChange,
} from '@xyflow/react';
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
import {
  type Credential, type CredentialKind,
  pickFor, needsOf, kindForNeed, missingCapabilities, resolveSecret,
} from './engine/credentials';
import {
  verifyToken, fetchUpdate, pushFiles, type Fetcher as GithubFetcher,
} from './engine/github';
import {
  parseStore, serializeStore, encryptStore, decryptStore, newDeviceSalt,
  collectDeviceSignals, defaultBackend, type StoredFile,
} from './engine/credentialStore';
import { SECRET_POLICY_KEY, type SecretPolicy } from './types';
import { checkChannel, type ChannelStatus } from './lib/channel';
import { deviceSeed, clearKeyCache } from './engine/crypto';
import Sidebar, { DRAG_MIME, decodeDrag, type DragPayload } from './components/Sidebar';
import CanvasTabs from './components/CanvasTabs';
import { TaskPanel } from './components/TaskPanel';
import { HistoryPanel } from './components/HistoryPanel';
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
import {
  makeCanvas, nextCanvasName, renameCanvas, removeCanvas, nextActiveId,
  updateCanvasContent, sortForDisplay, toMeta,
  loadFromStorage, saveToStorage, clearSecrets,
  collectSecrets, applySecrets, STORAGE_KEYS,
  type Canvas,
  redactNodes,
} from './engine/canvasStore';
import {
  sealSecrets, unsealSecrets, type SecretMap,
} from './engine/secretVault';
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
  /** 保险箱自己的盐。与凭据库分开：两者解锁方式不同，混在一起分不清是谁解不开 */
  const SECRETS_SALT_KEY = 'agent-flow.secrets-salt.v1';
  const beRef = useRef(defaultBackend());
  const [store, setStore] = useState<StoredFile>(() => parseStore(localStorage.getItem(CRED_KEY)));
  const [credentials, setCredentials] = useState<Credential[]>([]);
  /** 解锁用的口令；null 表示锁着 */
  const [vaultKey, setVaultKey] = useState<string | null>(null);
  const [credOpen, setCredOpen] = useState(false);
  const [credFocus, setCredFocus] = useState<string>('');
  const [unlockErr, setUnlockErr] = useState('');
  const [cryptoWarn, setCryptoWarn] = useState('');

  /*
   * 首次运行：定下设备盐；auto 模式用本机特征直接解锁。
   *
   * 盐的存放位置（审查项 A-02）：
   *   旧行为是生成后存进 localStorage —— 同一页面上的任何脚本都能读走它，
   *   配合公开的本机特征就能算出凭据密钥。现在改为优先用 Rust 侧的盐
   *   （存在应用数据目录，要调 af_device_salt 才拿得到）。
   *
   * 但**已有数据的老用户必须继续用原来那个盐** ——
   * 换盐等于把已存的凭据全部锁死，那比"盐可被读到"严重得多。
   * 所以只有"存盘里还没有盐"（新安装）这一条路径才走 Rust。
   */
  useEffect(() => {
    const be = beRef.current;
    if (!be) {
      setCryptoWarn('当前环境不支持 WebCrypto，凭据将以明文保存。请避免在公用设备上使用。');
      return;
    }
    setCryptoWarn('');
    const file = store;

    let alive = true;
    const useSalt = (salt: string, persist: boolean) => {
      if (!alive) return;
      if (persist) setStore({ ...file, deviceSalt: salt });
      if (file.mode === 'auto') {
        setVaultKey(deviceSeed(collectDeviceSignals(salt)));
      }
    };

    if (file.deviceSalt) {
      // 老数据：沿用存盘的盐，绝不重新生成
      useSalt(file.deviceSalt, false);
      return () => { alive = false; };
    }

    // 新安装：先问 Rust 要；拿不到（浏览器模式 / 隔离态 / 命令未注册）
    // 才退回本地生成并落盘 —— 功能不能因为拿不到盐就坏掉。
    fetchDeviceSalt()
      .then((rust) => {
        if (!alive) return;
        if (rust) { useSalt(rust, false); return; }
        useSalt(newDeviceSalt(be), true);
      })
      .catch(() => { if (alive) useSalt(newDeviceSalt(be), true); });
    return () => { alive = false; };
    // 只运行一次：mode 与凭据由下面两个 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 刚从磁盘解出来的凭据，快照一份。
   *
   * 用来让下面那个"凭据变化 → 加密落盘"跳过无谓的一轮：
   * 解密完 setCredentials 会触发它，于是又把同样的内容重新加密一遍 ——
   * 每条凭据一次 PBKDF2（约 50ms），纯属白跑，磁盘上本来就已是这个状态。
   */
  const loadedCredsRef = useRef<{ list: Credential[]; key: string } | null>(null);

  // 解锁状态变化（或换模式后）→ 解密出运行时凭据
  useEffect(() => {
    const be = beRef.current;
    if (!be || vaultKey === null) return;
    let alive = true;
    decryptStore(be, store, vaultKey).then((r) => {
      if (!alive) return;
      setCredentials(r.credentials);
      loadedCredsRef.current = { list: r.credentials, key: vaultKey };
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

    // 内容和刚解出来的一模一样，且口令没换 → 磁盘上已经是这个状态，不必重写
    const loaded = loadedCredsRef.current;
    if (loaded && loaded.list === credentials && loaded.key === vaultKey) return;

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
  /** 锁定：清掉内存里的派生钥匙 */
  const lockVault = useCallback(() => {
    clearKeyCache();
    loadedCredsRef.current = null;
    setVaultKey(null);
    setCredentials([]);
  }, []);

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

  const openCredentials = useCallback((kind: string) => {
    setCredFocus(kind);
    setCredOpen(true);
  }, []);


  const [concurrency, setConcurrency] = useState(1);
  const [globalInput, setGlobalInput] = useState('');
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [log, setLog] = useState<string[]>([]);
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

  /* ---------------------------------------------------------------- */
  /* 内联密钥的落盘（加密）                                            */
  /*                                                                  */
  /* 节点里手填的 apiKey 不在画布存档里（serialize 已脱敏），           */
  /* 但要"刷新后还在"，所以单独存一份 —— 这一份必须是密文。            */
  /* ---------------------------------------------------------------- */

  const [secretPolicy, setSecretPolicy] = useState<SecretPolicy>(() => {
    try {
      return localStorage.getItem(SECRET_POLICY_KEY) === 'session' ? 'session' : 'device';
    } catch { return 'device'; }
  });

  const secretsSaltRef = useRef<string | null>(null);
  const secretSaltInflight = useRef<Promise<string> | null>(null);

  /**
   * 定下保险箱用的盐。
   *
   * 与凭据库同理（见上面那段注释）：优先取 Rust 侧的盐，
   * 但**已经存过盐的必须继续用旧的** —— 换盐等于把已存的密钥全锁死。
   */
  const resolveSecretSalt = useCallback(async (): Promise<string> => {
    let legacy = '';
    try { legacy = localStorage.getItem(SECRETS_SALT_KEY) ?? ''; } catch { legacy = ''; }
    if (legacy) return legacy;              // 老用户：沿用，不换

    const rust = await fetchDeviceSalt();
    if (rust) return rust;                  // 新安装：盐不落 localStorage

    // 拿不到 Rust 的盐：退回本地生成 + 落盘（与旧行为一致）
    const be = defaultBackend();
    const local = be ? newDeviceSalt(be) : 'no-crypto';
    try { localStorage.setItem(SECRETS_SALT_KEY, local); } catch { /* 忽略 */ }
    return local;
  }, []);

  /** 保险箱钥匙：本机特征派生，与凭据库的口令互不牵连 */
  const secretPass = useCallback(async (): Promise<string> => {
    if (secretsSaltRef.current === null) {
      // 同一会话里并发调用只问一次
      if (!secretSaltInflight.current) {
        secretSaltInflight.current = resolveSecretSalt()
          .then((s) => { secretsSaltRef.current = s; return s; })
          .finally(() => { secretSaltInflight.current = null; });
      }
      await secretSaltInflight.current;
    }
    return deviceSeed(collectDeviceSignals(secretsSaltRef.current ?? ''));
  }, [resolveSecretSalt]);

  // 策略变化时落盘；选"仅本次会话"就把已存的密文一起清掉
  const policyFirstRun = useRef(true);
  useEffect(() => {
    try { localStorage.setItem(SECRET_POLICY_KEY, secretPolicy); } catch { /* 忽略 */ }
    if (secretPolicy === 'session') {
      try { clearSecrets((k) => localStorage.removeItem(k)); } catch { /* 忽略 */ }
      if (!policyFirstRun.current) pushLog('密钥不再保存到本机，仅本次会话有效');
    }
    policyFirstRun.current = false;
  }, [secretPolicy, pushLog]);

  /*
   * 读取完成前不许写。
   *
   * 少了这道闸会出事：启动时画布里的密钥还是空的，
   * 保存副作用会算出"没有密钥"→ 清掉保险箱 —— 用户存的密钥就这么没了，
   * 而那正是它正要读出来的东西。
   */
  const [secretsReady, setSecretsReady] = useState(false);

  // 启动时把密钥解回节点。只跑一次 —— 解不开要提示，不能反复重试刷屏
  const secretsLoaded = useRef(false);
  useEffect(() => {
    if (secretsLoaded.current) return;
    secretsLoaded.current = true;
    const done = () => setSecretsReady(true);

    if (secretPolicy === 'session') { done(); return; }
    const be = beRef.current;
    if (!be) { done(); return; }
    let raw = '';
    try { raw = localStorage.getItem(STORAGE_KEYS.secrets) ?? ''; } catch { done(); return; }
    if (!raw) { done(); return; }

    let alive = true;
    // 盐要异步取（可能要问 Rust），所以包一层 async IIFE
    void (async () => {
      const pass = await secretPass();
      if (!alive) return;
      try {
        const r = await unsealSecrets(be, raw, pass);
        if (!alive) return;
        if (r.failed) {
          pushLog('⚠ 本机保存的密钥解不开（设备特征变了或数据损坏），请重新填写');
          return;
        }
        if (Object.keys(r.keys).length === 0) return;
        setCanvases((cs) => applySecrets({ canvases: cs, activeId: activeId ?? '' }, r.keys).canvases);
        if (r.legacyPlaintext) pushLog('⚠ 检测到旧版本明文保存的密钥，已读入，保存后自动加密');
      } catch {
        if (alive) pushLog('⚠ 读取本机密钥失败');
      } finally {
        if (alive) setSecretsReady(true);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretPolicy, secretPass]);

  /*
   * 画布变化 → 重新加密落盘。
   *
   * 这个 effect 依赖 canvases，而**拖一下节点**就会触发它（防抖 400ms 后）。
   * 若不加判断地每次都加密，等于每拖一下就白跑一次 PBKDF2（约 50ms），
   * 界面会明显发涩 —— 而密钥其实一个字都没变。
   * 所以先比对：密钥集合与上次一致就整段跳过。
   */
  const saveSeq = useRef(0);
  const lastSealedRef = useRef<string | null>(null);
  /** 序列化成与键顺序无关的形式：节点重排不该被误判成"变了" */
  const sealSig = (keys: SecretMap) =>
    Object.keys(keys).sort().map((k) => `${k}=${keys[k]}`).join('\u0000');

  useEffect(() => {
    if (secretPolicy !== 'device') return;
    if (!secretsReady) return;   // 还没读完就写，会把保险箱清掉
    const be = beRef.current;
    if (!be) return;
    const keys: SecretMap = collectSecrets({ canvases, activeId });
    const sig = sealSig(keys);
    if (sig === lastSealedRef.current) return;

    const seq = saveSeq.current + 1;
    saveSeq.current = seq;
    let alive = true;
    void (async () => {
      try {
        const raw = await sealSecrets(be, keys, await secretPass());
        if (!alive || seq !== saveSeq.current) return;
        if (raw) localStorage.setItem(STORAGE_KEYS.secrets, raw);
        else clearSecrets((k) => localStorage.removeItem(k));
        // 写成功才记账：写失败的话下次得重试，不能假装已经存过
        lastSealedRef.current = sig;
      } catch { /* 忽略：下次画布变化会再试 */ }
    })();
    return () => { alive = false; };
  }, [canvases, activeId, secretPolicy, secretPass, secretsReady]);

  /* ---------------- 节点编辑 ---------------- */

  const patchNode = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) =>
      // 断言放在整体而非 data 上：若把 data 单独断言成联合类型 NodeData，
      // 展开后就无法落回 FlowNode 的任何一个具体分支（task/condition/…）。
      (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as FlowNode) : n)));
  }, [setNodes]);

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
         */
        data: { ...def.create(id), ...preset.init() },
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
      githubFetch, githubPush, httpRequester, credentials, playAudioReader,
      input: effectiveInput, onEvent, signal: controller.signal,
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

  const triggersRef = useRef(triggers);
  useEffect(() => { triggersRef.current = triggers; }, [triggers]);

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
        节点库只在流程视图出现。
        任务 / 历史是查看态，画布都藏起来了，节点拖不出去 —— 留着它
        就是一条死栏。隐藏之后，任务 / 历史的列表正好顶上这条栏的位置。
      */}
      {view === 'flow' ? (
        <Sidebar onAdd={(p) => spawnNode(p)} disabled={running} />
      ) : null}
      <div className="app">
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

      <div className="body">
        {view === 'history' ? (
          <HistoryPanel
            entries={history}
            now={tick}
            onDelete={(id) => saveHistory(removeFromHistory(historyFile, id))}
            onClearAll={() => saveHistory(emptyHistory())}
            onClearCanvas={(canvasId) => saveHistory(clearCanvasHistory(historyFile, canvasId))}
            onJumpToCanvas={(canvasId) => {
              if (canvasId && canvases.some((c) => c.id === canvasId)) {
                setActiveId(canvasId);
                setView('flow');
              }
            }}
          />
        ) : null}
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
        <div className="canvas" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver} style={view === 'flow' ? undefined : { display: 'none' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onInit={(inst) => { rfInstance.current = inst; }}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            /* 按住 Ctrl / ⌘ 拖动 = 复制一份跟着鼠标走，原件留在原地 */
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
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

        {/*
          任务 / 历史视图下属性面板保留，但只读 —— 保留是为了看完整信息。

          用 fieldset[disabled] 而不是逐个控件加 disabled：面板里有几十个
          input / select / button，分散在一堆子组件里，逐个改既漏又啰嗦。
          fieldset 的 disabled 会原生禁用所有后代控件，连键盘 Tab 进去改
          也一并挡住 —— 这是 CSS 的 pointer-events 做不到的。
        */}
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
              secretPolicy={secretPolicy}
              onChangeSecretPolicy={setSecretPolicy}
              webhookTokens={webhookTokens}
            />
          </fieldset>
        </div>


        {credOpen ? (
          <CredentialPanel
            credentials={credentials}
            onChange={(next) => setCredentials(next)}
            onClose={() => { setCredOpen(false); setCredFocus(''); }}
            verify={verifyCredential}
            locked={vaultKey === null}
            mode={store.mode}
            onUnlock={(pass) => {
              if (pass === '') { lockVault(); return; }
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
