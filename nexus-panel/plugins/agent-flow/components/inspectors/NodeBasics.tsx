import type { FlowNode } from '../../flowTypes';
import { NODE_SIZE_META, normalizeSize, type NodeSize } from '../../types';
import { getDef } from '../../nodes/registry';
import { stackParentOf, descendantsOf, chainTopOf, chainOf } from '../../engine/stack';
import { isNodeDisabled } from '../../engine/nodeDisabled';
import SaveAsCustom from './SaveAsCustom';

/**
 * 节点的**基础信息区**。
 *
 * ================= 为什么要单独成一块 ====================
 *
 * 名称、id、开启、显示高度、嵌合操作 —— 这些是每个节点都有的、
 * 与"这个节点干什么"无关的东西。
 *
 * 以前它们散在各处：
 *   · 名称：五个面板各写一份（条件 / 循环 / 并发 / 触发器 / 字段型面板）
 *   · id 与显示高度：分发器里两行
 *   · 开启：分发器里一个开关
 *   · 折叠 / 展开 / 解除：分发器里一行，且只在嵌合时出现
 *
 * 散着的后果是**每种节点的面板顶部长得都不一样**：
 * 有的先名称后参数，有的先参数后名称；有的能存为自定义，有的不能。
 * 挑节点时要在不同布局间重新找一遍位置。
 *
 * ================= 为什么它们不是参数 ====================
 *
 * 改这些都不影响本次执行结果（关掉除外 —— 那是"这一步算不算数"）。
 * 混进参数列表会被当成配置项的另两组，
 * 而"改了半天发现跑起来没变"正是这种混淆的典型表现。
 */

type Props = {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
  /** 给用户的即时反馈（走画布日志） */
  onNote?: (msg: string) => void;
  /** 进入模块实例的内部编辑。只有模块节点用得上 */
  onEditModule?: (nodeId: string) => void;
};

export function NodeBasics({ node, onChange, onNote, onEditModule }: Props) {
  const def = getDef(node.type);
  const d = (node.data ?? {}) as Record<string, unknown>;
  const size = normalizeSize(d.size);

  /*
   * 嵌合信息行。
   *
   * 折叠标记打在**串顶**上 —— 打在中间某块上会出现
   * "上半截显示、下半截隐藏"这种半吊子状态。
   */
  const stackParent = stackParentOf({ data: d });
  const inStack = stackParent !== null || descendantsOf([node] as never, node.id).length > 0;

  /*
   * 关闭开关。
   *
   * 左右拨动的样式（不是勾选框）：它是"这一步现在算不算数"的总开关，
   * 勾选框看着像"某个参数要不要勾"，容易和下面的参数混在一起。
   *
   * 口径走 isNodeDisabled：触发器历史上那个 `enabled` 字段也算数，
   * 否则会出现"这里说已关闭、那里说已启用"的两份真相。
   */
  const off = isNodeDisabled({ data: d });

  return (
    <section className="insp-basics">
      {/*
       * 第一行只有名称 —— 独占一行。
       *
       * 以前名称右边跟着类型标签：「条件分支」「触发器」这类词比较长，
       * 会把输入框挤短，稍长一点的名字就被截在中间看不全。
       * 名称是"我给这一步起的名字"，值得占满整行。
       */}
      <div className="insp-title">
        <input
          className="title-input"
          value={String(d.label ?? '')}
          onChange={(e) => onChange(node.id, { label: e.target.value })}
        />
      </div>

      {/*
       * 第二行：节点 id · 类型 · 超时 · 开关。
       *
       * 四项的共同点是"与这个节点干什么无关"，且都只有一两个字的宽度 ——
       * 各占一行的话，基础信息区会有五六行，参数要滚很久才看得到。
       *
       * 左半是**只读信息**（这是什么：id、类型），
       * 右半是**控制项**（怎么跑：超时、开关）。
       * 中间用 task-grow 撑开 —— 不让它们挤成一团，
       * 也让控制项始终贴右边，换节点时位置不跳。
       */}
      <div className="insp-metarow">
        <button
          className="insp-size-btn insp-id-btn"
          title="节点 id —— 点一下复制。运行日志里写的就是这个 id"
          onClick={() => {
            const t = String(node.id ?? '');
            void navigator.clipboard?.writeText(t).then(
              () => onNote?.(`已复制节点 id：${t}`),
              () => onNote?.(`复制失败，请手动选中：${t}`),
            );
          }}
        >
          {String(node.id ?? '')}
        </button>

        <span className="insp-kind">{def.meta.label}</span>

        <span className="task-grow" />

        {/*
         * 单节点执行超时。
         *
         * 放在基础信息区而不是参数区：它不属于任何一种节点自己的参数，
         * 对所有节点一视同仁（跟"开启""显示高度"是一类）。
         *
         * 留空 / 0 = 不限时。这是刻意的默认值 ——
         * 加了超时这个功能，不能让任何既有流程的行为发生变化。
         */}
        <span className="insp-timeout">
          <span className="insp-size-label">超时</span>
          <input
            className="insp-timeout-input"
            type="number"
            min="0"
            step="1"
            /*
             * 0 显示成空而不是 "0"：
             * 数字框右侧有步进箭头，显示 0 会让人以为"超时 0 秒 = 立刻失败"，
             * 而它实际是"不限时"。空串才是这个意思的直观表达。
             */
            value={d.timeoutSec ? String(d.timeoutSec) : ''}
            placeholder="不限"
            title="这一步最多跑多少秒。留空 = 不限时；到点没跑完就判失败，下游跟着跳过"
            onChange={(e) => {
              const raw = e.target.value;
              const n = Number(raw);
              onChange(node.id, { timeoutSec: raw === '' || !Number.isFinite(n) || n <= 0 ? 0 : n });
            }}
          />
          <span className="insp-size-label">秒</span>
        </span>

        <button
          type="button"
          className={'insp-switch' + (off ? ' is-off' : '')}
          title={off ? '已关闭 —— 这一步不参与执行，下游也会跟着停' : '开启 —— 这一步正常执行'}
          onClick={() => onChange(node.id, { disabled: !off, enabled: true })}
        >
          <span className="insp-switch-track">
            <span className="insp-switch-knob" />
          </span>
          <span className="insp-switch-text">{off ? '已关闭' : '开启'}</span>
        </button>
      </div>

      {/*
       * 第三行：显示高度 + 节点层面的动作。
       *
       * 显示高度是"卡片画多高"，动作是"整个节点层面"的操作，
       * 两者都不是参数，放同一行；动作贴右，与第二行右半对齐。
       */}
      <div className="insp-opsrow">
        <span className="insp-size-group">
          {(Object.keys(NODE_SIZE_META) as NodeSize[]).map((k) => (
            <button
              key={k}
              className={`insp-size-btn${size === k ? ' on' : ''}`}
              title={`显示高度：${NODE_SIZE_META[k].hint}`}
              onClick={() => onChange(node.id, { size: k })}
            >
              {NODE_SIZE_META[k].label}
            </button>
          ))}
        </span>

        <span className="task-grow" />

        {/*
         * 模块节点给「编辑内部」，其余给「存为自定义」——
         * 两个都是"整个节点层面"的动作，占同一个位置，
         * 不会同时出现也不会抢位置。
         */}
        {node.type === 'module' && onEditModule ? (
          <button
            type="button"
            className="mini"
            title="编辑这个模块实例的内部（改动只影响本实例）"
            onClick={() => onEditModule(node.id)}
          >
            编辑内部
          </button>
        ) : (
          <SaveAsCustom node={node} />
        )}
      </div>

      {inStack ? (
        <div className="insp-size insp-stack-row">
          <span className="insp-size-label">
            {stackParent
              ? `嵌合于 ${stackParent}`
              : `串顶 · 共 ${chainOf([node] as never, node.id).length} 块`}
          </span>
          <span className="insp-size-ops">
            <button
              className="insp-size-btn"
              title="折叠只隐藏显示，节点照常执行"
              onClick={() => onChange(chainTopOf([node] as never, node.id), { stackCollapsed: true })}
            >
              折叠
            </button>
            <button
              className="insp-size-btn"
              onClick={() => onChange(chainTopOf([node] as never, node.id), { stackCollapsed: false })}
            >
              展开
            </button>
            {stackParent ? (
              <button
                className="insp-size-btn"
                title="解除与上方节点的嵌合（也可以直接把它拖开）"
                onClick={() => onChange(node.id, { stackParent: null })}
              >
                解除
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </section>
  );
}
