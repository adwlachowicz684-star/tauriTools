import type { FlowEdge, FlowNode } from '../flowTypes';
import type { Credential } from '../engine/credentials';
import type { SecretPolicy } from '../types';
import { getDef } from '../nodes/registry';
import { inspectorOf } from './inspectors/inspectorOf';
import { NODE_SIZE_META, normalizeSize, type NodeSize } from '../types';

/**
 * 属性面板 —— 现在只是一个分发器。
 *
 * 以前这里是一条 isXxx() 的 if 链，加一种节点就要在这条链里再插一段，
 * 并且要把新节点的面板组件写进本文件（于是本文件一度长到 2500 行）。
 * 现在按 node.type 查注册表，取出该节点自己声明的面板组件渲染。
 *
 * 各节点的面板实现在 components/inspectors/ 下，一个节点一个文件。
 */
type Props = {
  node: FlowNode | null;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  /** 凭据列表；不传则凭据选择区不显示 */
  credentials?: Credential[];
  /** 打开凭据中心，并聚焦到指定类型 */
  onOpenCredentials?: (kind: string) => void;
  /** 内联密钥的落盘策略 */
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
  /** 后端为「未填 Token」的 webhook 触发器自动生成的校验 Token，按触发器 id 索引 */
  webhookTokens?: Record<string, string>;
  /**
   * 进入模块实例的内部编辑（由 App 提供）。
   * 不提供时模块节点不显示这个入口 —— 面板组件是纯展示层，
   * 拿不到 App 的画布状态，只能由外部注入。
   */
  onEditModule?: (nodeId: string) => void;
};

export default function Inspector({
  node, edges, onChange, credentials, onOpenCredentials, webhookTokens,
  secretPolicy, onChangeSecretPolicy, onEditModule,
}: Props) {
  if (!node) {
    return (
      <aside className="inspector">
        <div className="nx-empty empty-hint">
          选中一个节点来编辑内容
          <br />
          <small>从左侧节点库拖一个节点到画布，或点击节点库直接添加</small>
        </div>
      </aside>
    );
  }

  // 未知类型会拿到兜底定义（一个"看得见但不能跑"的占位面板），
  // 所以这里不需要判空 —— 见 nodes/registry.ts 的 makeFallback
  const def = getDef(node.type);
  const Panel = inspectorOf(def);
  const size = normalizeSize((node.data as { size?: unknown }).size);

  /*
   * 尺寸选择器放在分发器里，而不是各节点的面板里 ——
   * 条件 / 循环 / 并发 / 触发器用的是整体自定义面板，
   * 塞进节点面板就得改 4 个文件；放在这里一次覆盖全部节点类型。
   *
   * 它也不属于"节点参数"（不影响执行结果），所以不该混进字段列表，
   * 单独一行放在标题下方更合适。
   */
  const sizeRow = (
    <div className="insp-size">
      <span className="insp-size-label">显示高度</span>
      <span className="insp-size-ops">
        {(Object.keys(NODE_SIZE_META) as NodeSize[]).map((k) => (
          <button
            key={k}
            className={`insp-size-btn${size === k ? ' on' : ''}`}
            title={NODE_SIZE_META[k].hint}
            onClick={() => onChange(node.id, { size: k })}
          >
            {NODE_SIZE_META[k].label}
          </button>
        ))}
      </span>
    </div>
  );

  return (
    <>
      {sizeRow}
      <Panel
        onEditModule={onEditModule}
      node={node}
      edges={edges}
      onChange={onChange}
      credentials={credentials}
      onOpenCredentials={onOpenCredentials}
      secretPolicy={secretPolicy}
      onChangeSecretPolicy={onChangeSecretPolicy}
        webhookTokens={webhookTokens}
      />
    </>
  );
}
