/**
 * config/nexus.config.mjs 的类型声明。
 *
 * 共享配置故意写成 .mjs（vite.config.ts 与 scripts/*.mjs 都要 import），
 * TS 检查 vite.config.ts 时需要这份声明才能拿到类型。
 * 内容与 nexus.config.mjs 的导出一一对应，改了实现记得同步这里。
 */

export declare const CONFIG_DIR: string;
export declare const PROJECT_ROOT: string;

export declare const ENTRIES: {
  vanilla: string;
  react: string;
};

export declare const DEV_SERVER: {
  host: string;
  port: number;
};

export declare const TAURI_CONFIGS: {
  main: string;
  vite: string;
};

export type CspDirectives = Record<string, string[]>;

export declare const BASE_CSP: CspDirectives;

export declare function viteDevCsp(port?: number, host?: string): CspDirectives;
export declare function mergeCsp(...directiveSets: CspDirectives[]): CspDirectives;
export declare function renderCsp(directives: CspDirectives): string;
export declare function cspPolicies(): { base: string; dev: string };
export declare function buildInputs(root?: string): Record<string, string>;

export declare const PLAIN_PLUGINS: string[];

export declare const PATHS: {
  root: string;
  indexHtml: string;
  indexReactHtml: string;
  dist: string;
  plugins: string;
  registry: string;
  srcTauri: string;
};
