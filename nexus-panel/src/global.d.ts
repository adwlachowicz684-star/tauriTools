import type { PluginManifest } from '../js/host.js';

declare global {
  interface Window {
    /** 外壳暴露给插件的运行时接口 */
    __NEXUS__?: {
      getPlugins: () => PluginManifest[];
      navigate: (id: string) => void;
      toast: (msg: string, type?: 'info' | 'ok' | 'err') => void;
      removePlugin?: (id: string) => void;
      state?: any;
      bus?: any;
    };
    /** 无构建（原生 ESM）模式标记 */
    __NEXUS_NO_BUILD__?: boolean;
  }
}

export {};
