/**
 * 可选依赖的类型占位。
 *
 * `@tauri-apps/plugin-http` 只有在 Rust 端启用 `tauri-plugin-http` 时才有意义。
 * 当前仓库没启用（重构时删掉了），所以 npm 包也不装 ——
 * 但 lib/tauri.ts 里仍保留了"插件在就用插件"的运行时探测路径。
 *
 * 这里给个宽松声明，让 tsc 不报 "Cannot find module"。
 * 真要启用时：装包 + Cargo 加 tauri-plugin-http + capabilities 配 scope，本声明即可删除。
 */
declare module '@tauri-apps/plugin-http' {
  export function fetch(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      connectTimeout?: number;
      body?: unknown;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}
