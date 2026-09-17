/**
 * 颜色工具 —— 已搬到 plugins/color-picker/color.ts
 * ------------------------------------------------------------
 * 这里只保留转发，避免改动一堆 import 路径。
 *
 * 为什么搬走：内联色盘与取色服务要共用同一份定义。
 * 此前两份各存一份 PRESET_COLORS，改一处忘一处就会漂移 ——
 * 同一个"常用色"在两个界面显示成不同颜色。
 *
 * 依赖方向：project-group → color-picker（单向，无循环）。
 */

export * from '../../color-picker/color';
