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
export function savePolicy(p: Policy): void;
export function onPolicyChange(fn: (p: Policy) => void): () => void;
export function decideHost(host: string, policy?: Policy): 'allow' | 'block' | 'ask';
export function setHostStatus(host: string, status: HostStatus, meta?: { pluginId?: string; kind?: string; sample?: string }): Policy;
export function removeHost(host: string): Policy;
export function recordHosts(hosts: { host: string; kind?: string; sample?: string }[], pluginId?: string): { added: number; policy: Policy };
export function listHosts(): HostEntry[];
export function pendingHosts(): HostEntry[];
export function scanText(text: string, baseUrl?: string): { host: string; kind: string; sample: string }[];
export function scanEntry(entry: string, pluginId?: string): Promise<{ ok: boolean; hosts: { host: string; kind: string; sample: string }[]; externalEntry?: boolean; error?: string }>;
export function watchViolations(fn: (v: { host: string; directive: string; sample: string; kind: string }) => void): () => void;
export function suggestCsp(policy?: Policy): string;
export const LOCAL_HOSTS: Set<string>;

/** 外壳注入的运行时扩展（原生 shell 提供） */
export declare const rescanAll: () => Promise<void>;
export declare const scanPlugin: (p: { entry: string; id: string; name?: string }) => Promise<any>;
export declare const setRefreshHandler: (fn: (() => void) | null) => void;
