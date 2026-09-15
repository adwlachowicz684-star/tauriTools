import type { FlowEdge, FlowNode } from '../flowTypes';
import type { Credential } from '../engine/credentials';
import type { SecretPolicy } from '../types';
import { getDef, inspectorOf } from '../nodes/registry';

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
};

export default function Inspector({
  node, edges, onChange, credentials, onOpenCredentials, webhookTokens,
  secretPolicy, onChangeSecretPolicy,
}: Props) {
  if (!node) {
    return (
      <aside className="inspector">
        <div className="empty-hint">
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
  return (
    <Panel
      node={node}
      edges={edges}
      onChange={onChange}
      credentials={credentials}
      onOpenCredentials={onOpenCredentials}
      secretPolicy={secretPolicy}
      onChangeSecretPolicy={onChangeSecretPolicy}
      webhookTokens={webhookTokens}
    />
  );
}
