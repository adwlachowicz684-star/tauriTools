import type { PluginManifest } from '../js/host.js';
import type * as extPolicy from '../js/external-policy.js';
import type * as pluginCfg from '../js/plugin-config.js';
import type * as themeApi from '../js/theme-manager.js';

declare global {
  interface Window {
    /**
     * 外壳暴露给插件与调试用的运行时接口。
     * React 外壳（src/App.tsx）与原生外壳（js/shell.js）必须提供同一套字段 ——
     * 之前 React 版只挂了其中一半，这里却按全量声明，类型等于在撒谎。
     *
     * ⚠️ 下面标 optional 有**两种**原因，别混为一谈：
     *   1. 取值时机可能早于宿主初始化（绝大多数字段）—— 等一等就有了；
     *   2. **某一侧外壳压根不挂**（目前只有 pluginCfg，见其自己的注释）
     *      —— 那是"这个壳永远没有"，不是时机问题。
     * 早先这里只写了第 1 种，于是照它理解的人会以为 pluginCfg 在原生壳里
     * 也迟早会有，写出只读一次就用的代码 —— 实际拿到的是 undefined。
     *
     * 两边的键集合由 regression-guard-test.mjs 第 1.11 节守着：
     * 谁往一侧加字段而忘了另一侧，立刻报红。
     */
    __NEXUS__?: {
      state?: any;
      bus?: any;
      toast?: (msg: string, type?: 'info' | 'ok' | 'err') => void;
      navigate?: (id: string) => void;
      removePlugin?: (id: string) => void;
      getPlugins?: () => PluginManifest[];
      /**
       * 已注册的**全局**快捷键（accel → { pluginId, event, label }）。
       * 设置页「快捷键」页靠它列出插件注册的键并做撞车判断；
       * 两个外壳都要提供（设置页不该为其中一个分叉处理）。
       */
      getShortcuts?: () => Record<string, {
        pluginId: string; event: string; label?: string;
      }>;
      /** 按 id 挂载（= 切换到）插件 */
      mountPlugin?: (id: string) => Promise<void>;
      /** 当前插件实例，未挂载时为 null；仅调试观测用，勿依赖内部结构 */
      getInstance?: () => unknown;
      /** 打开当前插件的设置面板（插件没声明 settings 时无动作） */
      openPluginSettings?: () => void;
      closePluginSettings?: () => void;
      /** 外链管理：三档策略 + 逐域名决策 */
      external?: typeof extPolicy & {
        rescanAll: () => Promise<void>;
        scanPlugin: (p: { entry: string; id: string; name?: string }) => Promise<any>;
        setRefreshHandler: (fn: (() => void) | null) => void;
      };
      /** 每插件沙箱配置读写（原生外壳未暴露，故可选） */
      pluginCfg?: typeof pluginCfg;
      /** 主题 API 整套：applyTheme / setAccent / getCurrent / exportVars / getBase … */
      theme?: typeof themeApi;
    };
    /** 无构建（原生 ESM）模式标记 */
    __NEXUS_NO_BUILD__?: boolean;
  }
}

export {};
