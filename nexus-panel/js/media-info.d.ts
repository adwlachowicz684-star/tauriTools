/**
 * js/media-info.js 的类型声明。
 *
 * 共享层是 .js（mindmap 那边也在用，它是纯 JS 插件），TS 侧要靠这份
 * 声明才能拿到类型 —— 缺了它就是 any，字段名拼错也不会报错，
 * 而"分辨率显示成 0"这种问题跑起来才发现。
 */

/** 解析出的媒体信息。任何一步失败对应字段保持缺省值，绝不抛错 */
export type MediaInfo = {
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  videoCodec: string | null;
  videoCodecDetail: string | null;
  audioCodec: string | null;
  audioChannels: number;
  audioSampleRate: number;
  container: string | null;
};

/**
 * 完整视频元信息：容器解析 + video 元素，两者互补。
 *
 * @param blob 视频文件。只读头尾各 2MB，不会整个读进内存
 */
export function probeVideo(blob: Blob): Promise<MediaInfo>;

/** 只解析容器（不碰 DOM，Node 里可单测） */
export function parseContainer(blob: Blob): Promise<Record<string, unknown> | null>;

export function parseMp4(buf: Uint8Array): Record<string, unknown> | null;
export function parseWebm(buf: Uint8Array): Record<string, unknown> | null;
export function probeByElement(blob: Blob, timeoutMs?: number): Promise<{
  duration: number; width: number; height: number;
} | null>;

export function formatDuration(sec: number | undefined): string;
export function formatBitrate(bps: number | undefined): string;
export function formatFps(f: number | undefined): string;
export function formatDateTime(ts: number | undefined): string;
export function formatChannels(n: number | undefined): string;
export function shortType(type: string, name: string): string;
