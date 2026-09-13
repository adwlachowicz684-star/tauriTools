import type { PluginManifest } from '../js/host.js';
import type * as extPolicy from '../js/external-policy.js';
import type * as pluginCfg from '../js/plugin-config.js';

declare global {
  interface Window {
    /** 外壳暴露给插件与调试用的运行时接口 */
    __NEXUS__?: {
      state?: any;
      bus?: any;
      toast?: (msg: string, type?: 'info' | 'ok' | 'err') => void;
      navigate?: (id: string) => void;
      removePlugin?: (id: string) => void;
      getPlugins?: () => PluginManifest[];
      openPluginSettings?: () => void;
      closePluginSettings?: () => void;
      /** 外链管理：三档策略 + 逐域名决策 */
      external?: typeof extPolicy & {
        rescanAll?: () => Promise<void>;
        scanPlugin?: (p: { entry: string; id: string; name?: string }) => Promise<any>;
        setRefreshHandler?: (fn: (() => void) | null) => void;
      };
      /** 每插件沙箱配置读写 */
      pluginCfg?: typeof pluginCfg;
      theme?: any;
    };
    /** 无构建（原生 ESM）模式标记 */
    __NEXUS_NO_BUILD__?: boolean;
  }
}

export {};
