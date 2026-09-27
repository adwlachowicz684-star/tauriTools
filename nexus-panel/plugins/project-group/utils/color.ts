/**
 * 颜色工具 —— 唯一实现在 plugins/color-picker/color.ts，这里只做转发。
 * ------------------------------------------------------------
 * 保留转发文件是为了不改一堆 import 路径，但**不允许在这里再写一份实现**。
 *
 * 原因：此前 normalizeHex / hexToRgb / rgbToHex / shade 在这里各存了一份
 * 与上游逐字节相同的抄本。抄本与 `export *` 并存时，**本地优先** ——
 * 改了共享那份，这里纹丝不动。两份迟早漂移（比如一处支持三位简写、
 * 另一处不支持），而漂移不报错，只表现为"同一个颜色在两个界面显示不同"。
 *
 * 已核对四个函数与上游逐字节一致后删除本地抄本。新增颜色工具请把实现
 * 写进 plugins/color-picker/color.ts（那里不碰 DOM、不依赖插件运行时，
 * React 组件与 iframe 服务都能直接 import）。
 *
 * 依赖方向：project-group → color-picker（单向，无循环）。
 */

export * from '../../color-picker/color';
