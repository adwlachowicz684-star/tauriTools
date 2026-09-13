export interface PluginSandboxConfig {
  /** 功能隔离：去掉 allow-same-origin，插件碰不到外壳，全走桥接 */
  isolated: boolean;
  /** 主题适配：基调与面板不一致时自动反转统一 */
  adaptTheme: boolean;
}
export const DEFAULTS: PluginSandboxConfig;
export function getPluginConfig(id: string): PluginSandboxConfig;
export function setPluginConfig(id: string, patch: Partial<PluginSandboxConfig>): PluginSandboxConfig;
export function onPluginConfigChange(fn: (id: string, config: PluginSandboxConfig) => void): () => void;
export function isIsolated(id: string): boolean;
export function shouldAdaptTheme(id: string): boolean;
