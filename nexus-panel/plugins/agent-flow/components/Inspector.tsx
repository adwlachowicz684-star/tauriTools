import type { FlowEdge, FlowNode } from '../flowTypes';
import type { Credential } from '../engine/credentials';
import type { SecretPolicy } from '../types';
import { getDef } from '../nodes/registry';
import { inspectorOf } from './inspectors/inspectorOf';
import { NODE_SIZE_META, normalizeSize, type NodeSize } from '../types';
import { stackParentOf, descendantsOf, chainTopOf, chainOf } from '../engine/stack';
import {
  setDefault, clearDefault, hasDefault, matchPresetKey,
} from '../engine/nodeDefaults';
import { allPresets } from '../nodes/registry';

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
  /** 给用户的即时反馈（走画布日志）。不传则静默但仍生效 */
  onNote?: (msg: string) => void;
};

export default function Inspector({
  node, edges, onChange, credentials, onOpenCredentials, webhookTokens,
  secretPolicy, onChangeSecretPolicy, onEditModule, onNote,
}: Props) {
  const pushNote = onNote;
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
  /*
   * 嵌合信息行。
   *
   * 放在这里而不是 NodeShell 里：折叠按钮要调 onChange，
   * 卡片组件拿不到（它只收 data）。面板本来就有 onChange，顺理成章。
   *
   * 折叠标记打在**串顶**上 —— 打在中间某块上会出现
   * "上半截显示、下半截隐藏"这种半吊子状态。
   */
  const stackParent = stackParentOf({ data: node.data as Record<string, unknown> });
  const inStack = stackParent !== null || descendantsOf([node] as never, node.id).length > 0;
  const stackRow = inStack ? (
    <div className="insp-size" style={{ marginBottom: 6, paddingBottom: 6 }}>
      <span className="insp-size-label">
        {stackParent ? `嵌合于 ${stackParent}` : `串顶 · 共 ${chainOf([node] as never, node.id).length} 块`}
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
  ) : null;

  /*
   * 「设为默认」行。
   *
   * 同样放在分发器里 —— 条件 / 循环 / 并发 / 触发器用的是整体自定义面板，
   * 塞进各面板要改 4 处；这里一次覆盖全部类型。
   *
   * 它也不属于"节点参数"（不影响本次执行），而是影响**以后新建的节点**，
   * 所以没混进字段列表。
   */
  const presets = allPresets();
  const presetKey = matchPresetKey(
    presets as never, node.type, node.data as Record<string, unknown>,
  ) ?? node.type;
  const hasOwn = hasDefault(presetKey);

  const onSetDefault = () => {
    const r = setDefault(presetKey, node.data);
    const label = presets.find((p) => p.key === presetKey)?.label ?? presetKey;
    if (r.strippedSecrets) {
      pushNote?.(
        `已把当前参数设为「${label}」的默认。节点里直接填写的令牌不会被保存`
        + '（默认值是明文存储），请改用凭据中心的凭据。',
      );
      return;
    }
    pushNote?.(`已把当前参数设为「${label}」的默认，之后新建的同类节点都用这套值。`);
  };

  const onClearDefault = () => {
    clearDefault(presetKey);
    const label = presets.find((p) => p.key === presetKey)?.label ?? presetKey;
    pushNote?.(`已清除「${label}」的默认参数，恢复为出厂值。`);
  };

  const defaultRow = (
    <div className="insp-size" style={{ marginBottom: 6, paddingBottom: 6 }}>
      <span className="insp-size-label">
        {hasOwn ? '已设默认' : '默认参数'}
      </span>
      <span className="insp-size-ops">
        <button
          className={`insp-size-btn${hasOwn ? ' on' : ''}`}
          title="把当前参数存成这类节点的默认值，之后新建的同类节点都用这套值"
          onClick={onSetDefault}
        >
          设为默认
        </button>
        {hasOwn ? (
          <button
            className="insp-size-btn"
            title="恢复为出厂默认值"
            onClick={onClearDefault}
          >
            清除
          </button>
        ) : null}
      </span>
    </div>
  );

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
      {stackRow}
      {sizeRow}
      {defaultRow}
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
