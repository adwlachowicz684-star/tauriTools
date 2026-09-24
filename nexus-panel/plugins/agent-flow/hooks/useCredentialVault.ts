import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Credential, makeCredential,
} from '../engine/credentials';
import { migrateLlmToCredentials } from '../engine/llmCredential';
import {
  parseStore, serializeStore, decryptStore, encryptStore,
  newDeviceSalt, collectDeviceSignals,
  defaultBackend, type StoredFile, type VaultMode,
} from '../engine/credentialStore';
import { deviceSeed, clearKeyCache } from '../engine/crypto';
import {
  newOsKeyringKey, planOsKeyringStart, judgeOsKeyringWrite,
} from '../engine/osKeyring';
import { type Canvas } from '../engine/canvasStore';
import { fetchDeviceSalt } from '../lib/tauri';
import { osKeyringGet, osKeyringSet, osKeyringDelete } from '../lib/tauri';

/**
 * 三种保管方式在界面上的叫法。
 *
 * 与 credentialStore 的 VaultMode 一一对应。放在这里而不是塞进 engine ——
 * engine 是纯逻辑层，不该知道界面上怎么称呼它。
 */
export const VAULT_MODE_META: Record<VaultMode, { label: string }> = {
  auto: { label: '本机加密' },
  oskeyring: { label: 'OS 连接管理器' },
  passphrase: { label: '口令加密' },
};

export const CRED_KEY = 'agent-flow.credentials.v1';

/**
 * 连接库（加密存储 + 解锁 + 换保管方式）。
 *
 * ================= 为什么第一个拆它 ====================
 *
 * App.tsx 曾三千七百多行、四十多个 useState。
 * 连接这块是全应用**最独立**的一块：只依赖"画布列表"（迁移老节点上的
 * 内联密钥）和一个写日志的回调，与画布交互、执行流程没有牵扯。
 * 从最独立的拆起，一次一块。
 *
 * ================= 边界 ====================
 *
 * 内存里是明文，磁盘上是密文。加解密只在 load / save 两个出入口做，
 * 组件照常读写 credential.secret，不需要知道加密的存在 ——
 * 加密一旦散落到各处，总会有人忘了调。
 */
/**
 * 把迁移结果写回画布：每个节点合上自己的 patch。
 *
 * 不改节点 id、不动坐标、不动边 ——
 * 只补 credentialId / llmModel 并清空节点上那份旧配置。
 */
function applyLlmPatches(
  canvases: Canvas[],
  patches: Record<string, Record<string, Record<string, unknown>>>,
): Canvas[] {
  return canvases.map((cv) => {
    const forCanvas = patches[cv.id];
    if (!forCanvas) return cv;
    return {
      ...cv,
      nodes: (cv.nodes as unknown[]).map((raw) => {
        const n = raw as { id: string; data: Record<string, unknown> };
        const patch = forCanvas[n.id];
        return patch ? { ...n, data: { ...n.data, ...patch } } : n;
      }) as Canvas['nodes'],
    };
  });
}

export function useCredentialVault({
  canvasesRef, setCanvases, onLog,
}: {
  /** 迁移老节点上的内联密钥时要读当前画布。用 ref 是为了让依赖保持为空 */
  canvasesRef: { current: Canvas[] };
  setCanvases: React.Dispatch<React.SetStateAction<Canvas[]>>;
  onLog: (msg: string) => void;
}) {

  /*
   * 老节点上的内联密钥 → 收进连接管理器。
   *
   * 迁移要读"当前画布"，但把它放进 useCallback 的依赖会让回调每次改画布就重建，
   * 进而让所有依赖它的 effect 反复重注册。用 ref 读最新值，依赖保持为空。
   */
  const ranLlmMigrationRef = useRef(false);
  const migrateLlmNow = useCallback((creds: Credential[]) => {
    if (ranLlmMigrationRef.current) return creds;
    ranLlmMigrationRef.current = true;
    const r = migrateLlmToCredentials(
      canvasesRef.current as never, creds, (partial) => makeCredential(partial),
    );
    if (r.migrated === 0) return creds;
    setCanvases((cvs) => applyLlmPatches(cvs, r.patches));
    return r.credentials;
  }, [canvasesRef, setCanvases]);

  /**
   * 连接单独存一个 key，不混进画布存档。
   * 画布会被导出分享，密钥一旦进去就等于交出去了；
   * 分开存之后，导出的文件里只有 credentialId，没有密钥本身。
   */
  /* ---------------------------------------------------------------- *
   * 连接库（加密）                                                    *
   *                                                                   *
   * 内存里是明文，磁盘上是密文。加解密只在 load / save 两个出入口做，  *
   * 组件照常读写 credential.secret，不需要知道加密的存在 ——             *
   * 加密一旦散落到各处，总会有人忘了调。                               *
   * ---------------------------------------------------------------- */
  const beRef = useRef(defaultBackend());
  const [store, setStore] = useState<StoredFile>(() => parseStore(localStorage.getItem(CRED_KEY)));
  const [credentials, setCredentials] = useState<Credential[]>([]);
  /** 解锁用的口令；null 表示锁着 */
  const [vaultKey, setVaultKey] = useState<string | null>(null);
  const [credOpen, setCredOpen] = useState(false);
  const [credFocus, setCredFocus] = useState<string>('');
  /** 连接管理器打开时停在哪一页（'mcp' = 从工具栏 MCP 状态插件进来） */
  const [credPage, setCredPage] = useState<'cred' | 'mcp'>('cred');
  const [unlockErr, setUnlockErr] = useState('');
  const [cryptoWarn, setCryptoWarn] = useState('');

  /*
   * 首次运行：定下设备盐；auto 模式用本机特征直接解锁。
   *
   * 盐的存放位置（审查项 A-02）：
   *   旧行为是生成后存进 localStorage —— 同一页面上的任何脚本都能读走它，
   *   配合公开的本机特征就能算出连接密钥。现在改为优先用 Rust 侧的盐
   *   （存在应用数据目录，要调 af_device_salt 才拿得到）。
   *
   * 但**已有数据的老用户必须继续用原来那个盐** ——
   * 换盐等于把已存的连接全部锁死，那比"盐可被读到"严重得多。
   * 所以只有"存盘里还没有盐"（新安装）这一条路径才走 Rust。
   */
  useEffect(() => {
    const be = beRef.current;
    if (!be) {
      setCryptoWarn('当前环境不支持 WebCrypto，连接将以明文保存。请避免在公用设备上使用。');
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

    /*
     * oskeyring 模式：主密钥不在数据目录里，去 OS 连接管理器取。
     *
     * 与 auto 完全无关，所以**不走盐那条路** —— 混着走的话，
     * 一旦拿了设备盐派生出的密钥去解 OS 密钥加密的数据，
     * 一条都解不开，而界面只会显示"口令不对"（其实根本没有口令）。
     */
    if (file.mode === 'oskeyring') {
      void (async () => {
        const read = await osKeyringGet();
        if (!alive) return;
        const plan = planOsKeyringStart(read);

        if (plan.action === 'use') {
          setVaultKey(plan.key);
          return;
        }

        if (plan.action === 'unavailable') {
          /*
           * 不静默退回 auto。
           *
           * 静默降级会让人以为密钥受 OS 保护，实际还是本机特征派生 ——
           * 假的安全感比没有更糟。明确说出来，让他自己决定换哪种。
           */
          setCryptoWarn(
            `OS 连接管理器不可用（${plan.reason}）。当前**没有**启用任何主密钥，`
            + '请在连接管理器改用「本机加密」或「口令加密」。',
          );
          return;
        }

        // create：生成 → 写入 → **回读验证** → 才用它加密
        const key = newOsKeyringKey((n) => be.randomBytes(n));
        const wrote = await osKeyringSet(key);
        if (!alive) return;
        if (!wrote.ok) {
          setCryptoWarn(`无法把主密钥写进 OS 连接管理器（${wrote.reason}）。`
            + '为了避免连接永久解不开，本次**没有**启用加密。'
            + '请在连接管理器改用「本机加密」或「口令加密」。');
          return;
        }
        const back = await osKeyringGet();
        if (!alive) return;
        const check = judgeOsKeyringWrite(back, key);
        if (!check.ok) {
          /*
           * 存进去却读不回来（Linux 钥匙串锁着时很常见）。
           * 此时若拿它加密，下次再也解不开 —— 那是数据丢失，不是报错能挽回的。
           * 所以宁可不加密，也要把话说清楚。
           */
          setCryptoWarn(`${check.reason}。为避免连接永久解不开，本次**没有**启用加密。`
            + '请在连接管理器改用「本机加密」或「口令加密」。');
          return;
        }
        setVaultKey(key);
      })();
      return () => { alive = false; };
    }

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
    // 只运行一次：mode 与连接由下面两个 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 刚从磁盘解出来的连接，快照一份。
   *
   * 用来让下面那个"连接变化 → 加密落盘"跳过无谓的一轮：
   * 解密完 setCredentials 会触发它，于是又把同样的内容重新加密一遍 ——
   * 每条连接一次 PBKDF2（约 50ms），纯属白跑，磁盘上本来就已是这个状态。
   */
  const loadedCredsRef = useRef<{ list: Credential[]; key: string } | null>(null);

  // 解锁状态变化（或换模式后）→ 解密出运行时连接
  useEffect(() => {
    const be = beRef.current;
    if (!be || vaultKey === null) return;
    let alive = true;
    decryptStore(be, store, vaultKey).then((r) => {
      if (!alive) return;
      /*
       * 迁移可能**新增**连接（老节点上的 key 收进来）。
       * 只 setCredentials 不落盘的话，刷新后新连接消失，
       * 而节点上已经指向它 —— 表现为"配好了，重启就没了"。
       */
      const creds = migrateLlmNow(r.credentials);
      setCredentials(creds);
      loadedCredsRef.current = { list: creds, key: vaultKey };
      if (creds.length !== r.credentials.length) {
        void encryptStore(beRef.current!, store, creds, vaultKey);
      }
      if (r.failed.length > 0) {
        setUnlockErr(`有 ${r.failed.length} 条连接解不开，可能是口令不对或数据损坏。`);
      }
    });
    return () => { alive = false; };
    // store 变化时不重跑：否则保存后又立刻解密，会和用户输入打架
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultKey]);

  // 连接变化 → 加密落盘
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

  /**
   * 切换加密方式：用新的主密钥重新加密全部连接。
   *
   * 三种模式的主密钥来源完全不同，所以这里必须**分别取**：
   *   auto        设备特征派生（要盐）
   *   oskeyring   OS 连接管理器（要写进去并回读验证）
   *   passphrase  用户口令
   * 拿错一种去加密，结果是下次一条都解不开 —— 且界面上只会显示"口令不对"。
   */
  const changeVaultMode = useCallback(async (mode: VaultMode, pass: string) => {
    const be = beRef.current;
    if (!be) return;

    let newKey: string;
    if (mode === 'oskeyring') {
      const key = newOsKeyringKey((n) => be.randomBytes(n));
      const wrote = await osKeyringSet(key);
      if (!wrote.ok) { onLog(`✗ 无法写入 OS 连接管理器：${wrote.reason}`); return; }
      const back = await osKeyringGet();
      const check = judgeOsKeyringWrite(back, key);
      if (!check.ok) { onLog(`✗ ${check.reason}。为避免连接永久解不开，未切换。`); return; }
      newKey = key;
    } else if (mode === 'auto') {
      let salt = store.deviceSalt;
      if (!salt) { salt = newDeviceSalt(be); }
      newKey = deviceSeed(collectDeviceSignals(salt));
    } else {
      newKey = pass;
    }

    /*
     * 离开 oskeyring 时把 OS 里那条删掉 ——
     * 留着等于在数据目录之外又留了一把能解开旧密文的钥匙，
     * 而用户以为已经换掉了。
     */
    if (store.mode === 'oskeyring' && mode !== 'oskeyring') {
      await osKeyringDelete();
    }

    const base: StoredFile = {
      ...store,
      mode,
      deviceSalt: store.deviceSalt || newDeviceSalt(be),
    };
    const next = await encryptStore(be, base, credentials, newKey);
    setStore(next);
    setVaultKey(newKey);
    try { localStorage.setItem(CRED_KEY, serializeStore(next)); } catch { /* 忽略 */ }
    onLog(`✓ 连接存储方式已改为${VAULT_MODE_META[mode].label}`);
  }, [store, credentials, onLog]);
  const openCredentials = useCallback((kind: string) => {
    setCredFocus(kind);
    setCredOpen(true);
  }, []);

  /*
   * 外部（工具栏 MCP 状态插件）要打开连接管理器时走这里。
   *
   * 状态在组件内部，外面调不到，所以由 main.tsx 把插件总线上的事件
   * 转成一个 window 事件，这里再接住。多绕一层是因为
   * ctx 只在 bootIframeReactPlugin 的回调里拿得到，
   * 而 App 是普通 React 组件树，拿不到那个 ctx。
   */
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ page?: string }>).detail || {};
      setCredPage(d.page === 'mcp' ? 'mcp' : 'cred');
      setCredFocus('');
      setCredOpen(true);
    };
    window.addEventListener('nexus:open-credentials', h);
    return () => window.removeEventListener('nexus:open-credentials', h);
  }, []);
  return {
    store, setStore, credentials, setCredentials,
    vaultKey, unlockErr, setUnlockErr, cryptoWarn,
    credOpen, setCredOpen, credFocus, setCredFocus, credPage, setCredPage,
    lockVault, unlock, changeVaultMode, openCredentials,
  };
}
