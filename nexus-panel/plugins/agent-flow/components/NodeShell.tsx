import { Handle, Position } from '@xyflow/react';
import type { ReactNode } from 'react';
import { getDef } from '../nodes/registry';
import { validateNode, LEVEL_COLOR, LEVEL_TEXT, LEVEL_SHORT, type IssueLevel } from '../engine/nodeValidate';
import { isNodeDisabled } from '../engine/nodeDisabled';
/** 关闭态的圆点色。中性灰，不与"缺项/缺参"的黄红撞色 */
const OFF_DOT_COLOR = '#6b7280';
import { normalizeSize, type NodeSize } from '../types';
import { resolveVars } from '../engine/variables';
import { resolveNodeColor } from '../engine/nodeColors';
import { stackParentOf } from '../engine/stack';

/**
 * 节点卡片外壳 —— 10 种画布卡片共用的骨架。
 *
 * 抽它的直接原因：每个卡片组件都各自抄了一遍
 * `Handle + node-head（状态徽章/标题）+ node-line--lead + node-foot`，
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

export type NodeShellProps = {
  id: string;
  /** 节点类型（'ocr' / 'task' …），用于取 meta.color */
  type: string;
  data: { label?: string; status?: string };
  selected?: boolean;
  /** 附加在 node-card 上的类名（如 'ocr'、'parallel'），用于各卡片自己的样式钩子 */
  className?: string;
  /** node-line--lead 里的一行说明 */
  tag?: ReactNode;
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
  id, type, data, selected, className, tag, typeColor,
  hasTarget = true, hasSource = true, footExtra, children,
}: NodeShellProps) {
  const status = data.status ?? 'idle';
  const size: NodeSize = normalizeSize((data as { size?: unknown }).size);
  // 节点类型色的唯一来源：注册表里那份。未注册的类型走兜底定义（灰色），不会崩
  /*
   * 用户在节点库改过的类型色，画布上要跟着变 ——
   * 侧栏与画布是同一套视觉语言，改一处只生效一边会让人以为没改成功。
   */
  const color = resolveNodeColor(type, typeColor ?? getDef(type).meta.color, typeColor);

  /*
   * 圆点是**配置预警**，它在徽章里（徽章写的是配置状态，不是运行状态）。
   *
   * 以前圆点用类型色、左边条被 status 覆盖，结果"哪种节点"和"跑得怎么样"
   * 混在一起：节点一跑起来，左边条就变色，类型反而认不出了。
   * 现在分开 —— 左边条恒为类型色（认种类），徽章报配置完整度（认能不能跑），
   * 运行状态一律看任务窗口。
   */
  /*
   * 引用变量时，节点上不存那组字段的值 —— 直接校验会报"缺参"。
   * 先把变量的值解析进来再校验，否则"引用了变量"看起来像"参数没填"。
   */
  const issue = validateNode({ data: resolveVars(data) });
  const dot: IssueLevel = issue.level;
  /*
   * 关掉的节点：徽章**照常显示缺参 / 缺项**，只有圆点变灰。
   *
   * 整个徽章去掉的话，重新打开时才发现它其实一直没配好 ——
   * 关掉不等于修好。变灰的圆点是唯一能一眼区分"关着的 / 配好的"的地方。
   */
  const off = isNodeDisabled({ data: data as Record<string, unknown> });
  const stacked = stackParentOf({ data: data as Record<string, unknown> }) !== null;
  /*
   * "下面挂着块"要压掉下圆角与下边框 —— 与 stacked 一起才能拼成直筒。
   *
   * 这个值由 App 在渲染时算好塞进 data（不落盘，见 VIEW_KEYS 的说明）：
   * NodeShell 只拿到自己这一个节点，扫不到全图，而"下面有没有块"
   * 光看自己看不出来。
   */
  const hasChild = Boolean((data as Record<string, unknown>).hasStackChild);

  return (
    <div
      className={`node-card size-${size} ${stacked ? 'is-stacked' : ''} ${hasChild ? 'is-stack-top' : ''} ${className ?? ''} status-${status}${off ? ' is-off' : ''} ${selected ? 'is-selected' : ''}`}
      style={{ borderLeftColor: color }}
    >
      {hasTarget ? <Handle type="target" position={Position.Left} /> : null}
      {hasSource ? <Handle type="source" position={Position.Right} /> : null}

      {/*
       * 标题行：**配置状态在左、标题在右**。
       *
       * 两处改动都是为了把"能不能跑"和"跑得怎么样"分开：
       *
       *   · 徽章里写的是**配置状态**（就绪 / 缺项 / 缺参数），
       *     不再写"待运行 / 执行中 / 已完成" —— 运行状态一律看任务窗口，
       *     画布上刷那些字只会每跑一次整片抖一遍。
       *
       *   · 圆点**放进徽章里**：它俩说的是同一件事（配置完整度），
       *     分开摆会让圆点像第二个状态、不知道跟徽章是一回事。
       *
       * 徽章放左边而不是右边：它是"看这个节点之前先看它"的信息，
       * 而且标题长短不一时，靠右的徽章会被挤得左右跳。
       */}
      <div className="node-head">
        <span
          className={`node-badge level-${dot}${off ? ' is-off' : ''}`}
          title={
            (off ? '已关闭（不参与执行）· ' : '')
            + (issue.messages.length ? issue.messages.join('；') : LEVEL_TEXT[dot])
          }
        >
          <span
            className={`node-dot${off ? ' is-off' : ''}`}
            /* 关掉时用内联样式盖掉 level 的颜色 —— 不能用 level-ok 之类，
               那会把"缺参"也说成绿的 */
            style={{ background: off ? OFF_DOT_COLOR : LEVEL_COLOR[dot] }}
          />
          {LEVEL_SHORT[dot]}
          {off ? ' · 关' : ''}
        </span>
        <span className="node-title">{data.label}</span>
      </div>

      {/* 红色时把原因写出来 —— 只靠一个小红点，用户不知道缺什么 */}
      {dot === 'error' && issue.messages.length ? (
        <div className="node-line--alert">{issue.messages[0]}</div>
      ) : null}

      {/* 矮卡片隐去说明行与主体，只留"这是什么 + 跑得怎么样" */}
      {size !== 'sm' && tag ? <div className="node-line--lead">{tag}</div> : null}

      {size !== 'sm' ? children : null}

      {/*
       * 底部只在**有补充信息**时才渲染。
       *
       * 以前这里恒显示节点 id（`ma` + 时间戳乱码，如 mamu7obyv93）。
       * 那串字符对用户没有任何意义 —— 看不出是哪个节点，还像出错信息，
       * 而它占了每一张卡片的一行。
       *
       * 去掉后"日志里的 id 对应画布上哪个节点"靠属性面板那行
       * 「节点 id」（可点复制）。那里才是排查的位置 ——
       * 选中节点就能看，不用在画布上找一小行灰字。
       */}
      {size === 'sm' ? null : footExtra ? (
        <div className="node-foot">{footExtra}</div>
      ) : null}
    </div>
  );
}
