/**
 * 图的最小结构类型。
 *
 * 单独抽出来的原因：modules.ts 与 canvasRef.ts 都需要这两个类型，
 * 但它们各自的内部类型定义（AnyNode / AnyEdge）是**不导出的**。
 *
 * 在两个文件里各写一份的话，改一处忘另一处就会出现
 * "模块那边能接受的边、跨画布这边接不上"，而这种不一致不报错。
 */
export type AnyNode = { id: string; data?: Record<string, unknown> };
export type AnyEdge = {
  id: string;
  source: string;
  target: string;
  branch?: string;
  loopRole?: string;
};
