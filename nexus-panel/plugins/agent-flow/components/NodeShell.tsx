import { Handle, Position } from '@xyflow/react';
import type { ReactNode } from 'react';
import { getDef } from '../nodes/registry';
import { validateNode, LEVEL_COLOR, LEVEL_TEXT, type IssueLevel } from '../engine/nodeValidate';
import { normalizeSize, type NodeSize } from '../types';
import { stackParentOf } from '../engine/stack';

/**
 * 节点卡片外壳 —— 10 种画布卡片共用的骨架。
 *
 * 抽它的直接原因：每个卡片组件都各自抄了一遍
 * `Handle + node-head（圆点/标题/状态徽章）+ node-cli + node-foot`，
 * 而且**颜色写了两份** —— 节点定义里声明了 meta.color，卡片里又硬编码了一遍：
 *
 *   nodes/defs/ocr.tsx        color: '#f472b6'
 *   components/OcrNode.tsx    <span style={{ background: '#f472b6' }} />
 *
 * 这两份必须手动同步。改一处忘另一处，侧栏色和卡片圆点色就对不上，
 * 而这种不一致不报错、测试也抓不到 —— 属于最难发现的那一类。
 * 现在卡片默认从注册表取色（getDef(type).meta.color），只剩一份真相。
 *
 * 为什么不从 '../nodes'（index 桶文件）导入 getDef：
 * 那个文件会 import 全部 defs/*，而 defs/* 里的 Canvas 字段指向本目录下的
 * 卡片组件 —— 一旦某个卡片 import 它，就形成 卡片 → nodes/index → defs → 卡片 的环。
 * 必须走 nodes/registry（它只依赖纯类型模块）。这条不变量详见
 * components/inspectors/inspectorOf.tsx 的注释。
 */

/** 状态文案。各卡片默认用这套，需要更贴切措辞的可按状态覆盖 */
export const NODE_STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '执行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

export type NodeShellProps = {
  id: string;
  /** 节点类型（'ocr' / 'task' …），用于取 meta.color */
  type: string;
  data: { label?: string; status?: string };
  selected?: boolean;
  /** 附加在 node-card 上的类名（如 'ocr'、'parallel'），用于各卡片自己的样式钩子 */
  className?: string;
  /** node-cli 里的一行说明 */
  tag?: ReactNode;
  /** 覆盖状态文案（如 OCR 的「识别中 / 已识别」比「执行中 / 已完成」更贴切） */
  statusText?: Record<string, string>;
  /**
   * 覆盖左边条颜色（节点类型色）。
   * 默认取 def.meta.color；只有"同类型不同变体用不同色"才需要传，
   * 例如任务节点按所选 CLI 变色、更新检测节点按数据源变色。
   */
  typeColor?: string;
  hasTarget?: boolean;
  hasSource?: boolean;
  /** node-foot 里 id 右侧的补充信息（模型名、字数等） */
  footExtra?: ReactNode;
  /** 卡片主体，各卡片自己填 */
  children?: ReactNode;
};

export function NodeShell({
  id, type, data, selected, className, tag, statusText, typeColor,
  hasTarget = true, hasSource = true, footExtra, children,
}: NodeShellProps) {
  const status = data.status ?? 'idle';
  const size: NodeSize = normalizeSize((data as { size?: unknown }).size);
  const text = statusText?.[status] ?? NODE_STATUS_TEXT[status] ?? status;
  // 节点类型色的唯一来源：注册表里那份。未注册的类型走兜底定义（灰色），不会崩
  const color = typeColor ?? getDef(type).meta.color;

  /*
   * 圆点是**配置预警**，不是运行状态（运行状态由右侧徽章呈现）。
   *
   * 以前圆点用类型色、左边条被 status 覆盖，结果"哪种节点"和"跑得怎么样"
   * 混在一起：节点一跑起来，左边条就变色，类型反而认不出了。
   * 现在分开 —— 左边条恒为类型色（认种类），圆点报配置完整度（认能不能跑）。
   */
  const issue = validateNode({ data });
  const dot: IssueLevel = issue.level;
  const stacked = stackParentOf({ data: data as Record<string, unknown> }) !== null;

  return (
    <div
      className={`node-card size-${size} ${stacked ? 'is-stacked' : ''} ${className ?? ''} status-${status} ${selected ? 'is-selected' : ''}`}
      style={{ borderLeftColor: color }}
    >
      {hasTarget ? <Handle type="target" position={Position.Left} /> : null}
      {hasSource ? <Handle type="source" position={Position.Right} /> : null}

      <div className="node-head">
        <span
          className={`node-dot level-${dot}`}
          style={{ background: LEVEL_COLOR[dot] }}
          title={issue.messages.length ? issue.messages.join('；') : LEVEL_TEXT[dot]}
        />
        <span className="node-title">{data.label}</span>
        <span className={`node-badge badge-${status}`}>{text}</span>
      </div>

      {/* 红色时把原因写出来 —— 只靠一个小红点，用户不知道缺什么 */}
      {dot === 'error' && issue.messages.length ? (
        <div className="node-line--alert">{issue.messages[0]}</div>
      ) : null}

      {/* 矮卡片隐去说明行与主体，只留"这是什么 + 跑得怎么样" */}
      {size !== 'sm' && tag ? <div className="node-line--lead">{tag}</div> : null}

      {size !== 'sm' ? children : null}

      {/*
       * 底部 id 行在矮卡片上保留。
       * 隐掉它虽然更干净，但排查日志时找不到节点对应关系 ——
       * 而矮卡片正是给模块内部的一堆节点用的，那里最容易需要对照日志。
       */}
      <div className="node-foot">
        <span className="node-id">{id}</span>
        {size === 'sm' ? null : footExtra}
      </div>
    </div>
  );
}
