export interface PluginSandboxConfig {
  /** 功能隔离：去掉 allow-same-origin，插件碰不到外壳，全走桥接 */
  isolated: boolean;
  /*
   * ⚠️ 这里原先声明过 adaptTheme（主题适配开关）。
   * 它控制的是"外壳判定插件基调、不一致就罩滤镜反转"的机制，该机制已整套删除，
   * 实现侧（js/plugin-config.js 的 DEFAULTS）也早已没有这个字段。
   * 类型里留着它的后果是：谁写了 cfg.adaptTheme 能通过类型检查，
   * 运行时却是 undefined —— 类型说有、实际没有，比两边都没有更难查。
   */
  /**
   * 整体主题为深色时，本插件用哪套主题；null = 跟随全局。
   * 注意语义不是"锁定成深色"，而是"深色时用这套"。
   */
  themeDark: string | null;
  /** 整体主题为浅色时，本插件用哪套主题；null = 跟随全局 */
  themeLight: string | null;
}
export const DEFAULTS: PluginSandboxConfig;
export function getPluginConfig(id: string): PluginSandboxConfig;
export function setPluginConfig(id: string, patch: Partial<PluginSandboxConfig>): PluginSandboxConfig;
export function onPluginConfigChange(fn: (id: string, config: PluginSandboxConfig) => void): () => void;
export function isIsolated(id: string): boolean;
export function shouldAdaptTheme(id: string): boolean;
