export type PolicyMode = 'smart' | 'allow-all' | 'deny-all';
export type HostStatus = 'pending' | 'trusted' | 'blocked';

export interface HostRecord {
  status: HostStatus;
  kind: string;
  pluginId?: string;
  sample?: string;
  decidedAt?: number;
  firstSeen?: number;
}
export interface HostEntry extends HostRecord { host: string }

export interface Policy { mode: PolicyMode; hosts: Record<string, HostRecord> }

export const POLICY_MODES: { value: PolicyMode; label: string; desc: string }[];
export const KIND_LABELS: Record<string, string>;

export function hostOf(url: string): string | null;
export function isExternal(url: string): boolean;
export function isAllowedEntry(entry: string): boolean;
export function loadPolicy(): Policy;
export function savePolicy(p: Policy): boolean;
export function onPolicyChange(fn: (p: Policy) => void): () => void;
export function decideHost(host: string, policy?: Policy): 'allow' | 'block' | 'ask';
export function setHostStatus(host: string, status: HostStatus, meta?: { pluginId?: string; kind?: string; sample?: string }): { policy: Policy; saved: boolean };
export function removeHost(host: string): { policy: Policy; saved: boolean };
export function recordHosts(hosts: { host: string; kind?: string; sample?: string }[], pluginId?: string): { added: number; policy: Policy };
export function listHosts(): HostEntry[];
export function pendingHosts(): HostEntry[];
export function scanText(text: string, baseUrl?: string): { host: string; kind: string; sample: string }[];
export function scanEntry(entry: string, pluginId?: string): Promise<{ ok: boolean; hosts: { host: string; kind: string; sample: string }[]; externalEntry?: boolean; error?: string }>;
export function watchViolations(fn: (v: { host: string; directive: string; sample: string; kind: string }) => void): () => void;
/**
 * 处理一次被 CSP 拦下的外链（登记 + 提示）—— **全仓唯一一份**。
 *
 * 两个壳（js/shell.js / src/App.tsx）都改为调它，不要在任何一侧再抄一份：
 * 抄了就会漂成"同一条外链在一个壳里提醒、另一个壳里静默丢掉"。
 * 违规上报有两种形状（带 blockedURI 的 / 只有 host+sample 的），**都要认**。
 *
 * @returns 登记了才返回非 null（调用方据此决定要不要刷新 UI）
 */
export function handleViolation(
  d: { blockedURI?: string; sample?: string; host?: string; directive?: string; kind?: string },
  opts?: { pluginId?: string; pluginName?: string; notify?: (msg: string, kind: string) => void },
): { host: string; decision: string; policy: Policy } | null;
/**
 * 从 CSP 指令反推外链用途。**全仓唯一一份** ——
 * js/shell.js（原生壳）与 src/App.tsx（React 壳）都改用本函数，
 * 不要在任何一侧再抄一份（抄了就会漂成"同一条外链两个壳标不同用途"）。
 */
export function kindOfDirective(d?: string): 'script' | 'frame' | 'media' | 'image' | 'style' | 'fetch' | 'unknown';
export function suggestCsp(policy?: Policy): string;
export const LOCAL_HOSTS: Set<string>;

/*
 * ⚠️ 下面三个**刻意不声明为本模块的导出**。
 *
 * 它们不是 `js/external-policy.js` 导出的东西 —— 该文件里查无此名，
 * 实际是外壳在挂 `window.__NEXUS__.external` 时**注入**进去的
 * （原生壳见 js/shell.js 的 `external: { ...extPolicy, rescanAll, … }`，
 *   React 壳见 src/App.tsx 的同名字段）。
 *
 * 早先这里写着三条 `export declare const`，后果是那类最难的漂移：
 *   · `import { rescanAll } from '../js/external-policy.js'` —— **类型检查通过**
 *     （d.ts 白纸黑字声明了），运行时却是 `undefined`，调用即崩；
 *   · 而它比"两边都没有"更难查：代码提示里有、自动补全给得出来，
 *     只有真跑起来才发现是空的。
 *
 * 真正的声明在 **src/global.d.ts**，那里用
 * `typeof extPolicy & { rescanAll: …; scanPlugin: …; setRefreshHandler: … }`
 * 表达"模块导出的 + 外壳注入的"这两层 —— 形状与注入的来源一致，
 * 谁新增注入项就去那里补，不要回到本文件。
 */
