import { BaseEdge, EdgeLabelRenderer, getStraightPath, type EdgeProps } from '@xyflow/react';

/**
 * 参数连线 —— 「把我的输出，接给它当参数」。
 *
 * ================= 为什么必须跟流程连线长得不一样 =================
 *
 * 两种线说的是完全不同的事：
 *
 *   流程连线  A 跑完接着跑 B（执行顺序）
 *   参数连线  我的输出填进你的某个参数（只取值，不走流程）
 *
 * 长得一样的话，看到一根线得先猜它是哪种。
 * 而猜错的后果很具体：以为"它跑完就轮到我"，
 * 实际只是"它给我供了个值" —— 表现为某个节点一直不执行，看不出为什么。
 *
 * ================= 为什么虚线 + 箭头 + 不同颜色 =================
 *
 * 三个信号叠加，而不是只靠颜色：
 *
 *   · 颜色（紫）：与流程线的绿区分开
 *   · 虚线：扫一眼就能分辨，不用去比色
 *   · 箭头：参数连线**有方向**且方向有含义（从产出方流向使用方），
 *           没有箭头的话"谁给谁"全靠猜
 *
 * 只靠颜色的代价是色弱用户完全分不出，
 * 而虚线是**形状**差异，不依赖辨色能力。
 */
export function ParamEdge({
  sourceX, sourceY, targetX, targetY, markerEnd, label,
}: EdgeProps) {
  const [path, labelX, labelY] = getStraightPath({
    sourceX, sourceY, targetX, targetY,
  });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} className="af-param-edge" />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className="af-param-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
