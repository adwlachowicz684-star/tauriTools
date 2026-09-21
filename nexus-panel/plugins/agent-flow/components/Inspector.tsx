import type { FlowEdge, FlowNode } from '../flowTypes';
import type { Credential } from '../engine/credentials';
import { getDef } from '../nodes/registry';
import { inspectorOf } from './inspectors/inspectorOf';
import { NODE_SIZE_META, normalizeSize, type NodeSize } from '../types';
import { stackParentOf, descendantsOf, chainTopOf, chainOf } from '../engine/stack';
import { ErrorBoundary } from './ErrorBoundary';
/*
 * 「设为默认」不再有整体按钮 —— 每个参数各自带一个小按钮。
 *
 * 整体按钮的问题是顺带定死别的字段：只想改一个字段的默认，
 * 得先把整个节点配成想要的样子再整份存，
 * 而其它字段当前的值（哪怕只是路过改了一下）会一起被存进去。
 */
import type { CanvasConfig } from '../engine/canvasConfig';
import CanvasConfigPanel from './inspectors/CanvasConfigPanel';

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
  /** 全部画布；「调用画布」节点靠它渲染下拉框 */
  canvases?: { id: string; name: string }[];
  activeCanvasId?: string;
  /**
   * 画布级配置（MCP 服务 / 环境变量）。
   * 没选中节点时面板显示它 —— 配置属于整张画布，不属于某个节点。
   */
  canvasConfig?: CanvasConfig;
  onCanvasConfigChange?: (next: CanvasConfig) => void;
  /** 导出整张画布为脚本 */
  onExportFlow?: (fmt: string) => void;
  /* ---- 导出目录 ---- */
  /** 当前默认导出目录；空串表示没设 */
  exportDir?: string;
  onChangeExportDir?: (dir: string) => void;
  /** 弹目录选择器 */
  onBrowseExportDir?: () => void;
  /** 能不能真正写文件（浏览器模式为 false） */
  canExportToFile?: boolean;
};

export default function Inspector({
  node, edges, onChange, credentials, onOpenCredentials, webhookTokens,
  onEditModule, onNote,
  canvasConfig, onCanvasConfigChange, onExportFlow,
  exportDir = '', onChangeExportDir, onBrowseExportDir, canExportToFile = false,
  canvases, activeCanvasId,
}: Props) {
  const pushNote = onNote;
  if (!node) {
    /*
     * 没选中节点时显示画布设置 ——
     * 空面板除了提示"去选一个"什么都不给，浪费了这块地方，
     * 而画布级的东西（MCP、环境变量、导出）恰好没有别的入口。
     */
    if (canvasConfig && onCanvasConfigChange && onExportFlow) {
      return (
        <aside className="inspector">
          <CanvasConfigPanel
            config={canvasConfig}
            onChange={onCanvasConfigChange}
            onExport={onExportFlow}
            onNote={onNote}
            exportDir={exportDir}
            onChangeExportDir={onChangeExportDir ?? (() => {})}
            onBrowseExportDir={onBrowseExportDir ?? (() => {})}
            canExportToFile={canExportToFile}
          />
        </aside>
      );
    }
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
    <div className="insp-size" style={{ marginBottom: 'var(--sp-3, 6px)', paddingBottom: 6 }}>
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
   * 顶部一条工具条：显示高度 + 节点 id。
   *
   * ================= 为什么不各占一个功能区 ====================
   *
   * 以前是两行，各带一个标签（"显示高度" / "节点 id"）。
   * 它们都不是**参数** —— 改了不影响本次执行，
   * 却和真正的参数列表排在一起，看着像两组配置项。
   *
   * 现在合成面板最上面一行，右边对齐 id。
   * 高度那三个按钮仍带 title，鼠标停一下就知道各档是干什么的。
   */
  /*
   * 关闭开关。
   *
   * 左右拨动的样式（不是勾选框）：它是"这一步现在算不算数"的总开关，
   * 勾选框看着像"某个参数要不要勾"，容易和下面的参数混在一起。
   */
  const off = (node.data as Record<string, unknown>)?.disabled === true;
  const offRow = (
    <button
      type="button"
      className={'insp-switch' + (off ? ' is-off' : '')}
      title={off ? '已关闭 —— 这一步不参与执行，下游也会跟着停' : '开启 —— 这一步正常执行'}
      onClick={() => onChange(node.id, { disabled: !off })}
    >
      <span className="insp-switch-track">
        <span className="insp-switch-knob" />
      </span>
      <span className="insp-switch-text">{off ? '已关闭' : '开启'}</span>
    </button>
  );

  const sizeRow = (
    <div className="insp-topbar">
      <span className="insp-topbar-group">
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
      <button
        className="insp-size-btn insp-id-btn"
        title="节点 id —— 点一下复制。运行日志里写的就是这个 id"
        onClick={() => {
          const t = String(node.id ?? '');
          void navigator.clipboard?.writeText(t).then(
            () => pushNote?.(`已复制节点 id：${t}`),
            () => pushNote?.(`复制失败，请手动选中：${t}`),
          );
        }}
      >
        {String(node.id ?? '')}
      </button>
    </div>
  );

  return (
    <>
      {sizeRow}
      {stackRow}
      {offRow}
      {/*
        面板也要兜住。
        曾经触发器的数据不合法 → 面板渲染抛错 → 整棵树崩，
        表现为"画布消失"（其实崩的是右栏面板，但整棵树一起没了）。
        兜住之后只损失这一块面板，画布还在。
      */}
      <ErrorBoundary label={`属性面板 ${node.type ?? '?'}`}>
      <Panel
        onEditModule={onEditModule}
        onNote={onNote}
      node={node}
      edges={edges}
      onChange={onChange}
      credentials={credentials}
      onOpenCredentials={onOpenCredentials}
        webhookTokens={webhookTokens}
        canvases={canvases}
        activeCanvasId={activeCanvasId}
      />
      </ErrorBoundary>
    </>
  );
}
