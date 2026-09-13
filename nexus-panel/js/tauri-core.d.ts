export interface TauriHandle {
  mode: 'global' | 'npm';
  invoke<T = any>(cmd: string, args?: Record<string, any>): Promise<T>;
  convertFileSrc?: (path: string, protocol?: string) => string;
}

/** 获取 Tauri 句柄；浏览器调试模式下返回 null */
export function getTauri(): Promise<TauriHandle | null>;

/** 获取事件 API；不可用时返回 null（此时请用插件 SDK 的 ctx.on / ctx.emit） */
export function getTauriEvent(): Promise<{
  mode: string;
  listen: (event: string, handler: (e: any) => void) => Promise<() => void>;
  emit: (event: string, payload?: any) => Promise<void>;
} | null>;

export function isInsideTauri(): boolean;
