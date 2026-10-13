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

/** 外壳注入的运行时扩展（原生 shell 提供） */
export declare const rescanAll: () => Promise<void>;
export declare const scanPlugin: (p: { entry: string; id: string; name?: string }) => Promise<any>;
export declare const setRefreshHandler: (fn: (() => void) | null) => void;
