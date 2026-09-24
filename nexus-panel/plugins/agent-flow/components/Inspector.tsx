import type { FlowEdge, FlowNode } from '../flowTypes';
import type { Credential } from '../engine/credentials';
import { getDef } from '../nodes/registry';
import { inspectorOf } from './inspectors/inspectorOf';
import { NodeBasics } from './inspectors/NodeBasics';
import { resolveVars, redirectVarPatch, patchVariableValues } from '../engine/variables';
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
  /** 连接列表；不传则连接选择区不显示 */
  credentials?: Credential[];
  /** 打开连接管理器，并聚焦到指定类型 */
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
  /* ---- 外观（插件级偏好，只在"没选中节点"的设置页里出现） ---- */
  themeMode?: 'native' | 'follow';
  onThemeModeChange?: (mode: 'native' | 'follow') => void;
  /* ---- MCP：连接管理器里的服务库 ---- */
  /**
   * 服务库（全局）。画布设置里挑「这张画布用哪几个」时用它做下拉选项。
   * 不传的话下拉框是空的 —— 那时必须还有"去连接管理器添加"的入口。
   */
  mcpLibrary?: { id: string; name?: string; command?: string; url?: string;
    env?: Record<string, string>; note?: string; disabled?: boolean }[];
  /** 打开连接管理器并停在「服务」页 */
  onOpenMcpLibrary?: () => void;
};

export default function Inspector({
  node, edges, onChange, credentials, onOpenCredentials, webhookTokens,
  onEditModule, onNote,
  canvasConfig, onCanvasConfigChange, onExportFlow,
  exportDir = '', onChangeExportDir, onBrowseExportDir, canExportToFile = false,
  canvases, activeCanvasId,
  themeMode, onThemeModeChange,
  mcpLibrary, onOpenMcpLibrary,
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
            themeMode={themeMode}
            onThemeModeChange={onThemeModeChange}
            /*
             * 这两个必须透传 ——
             * 画布设置页若拿不到服务库，MCP 那一节就只剩手填框，
             * 于是"改连接管理器，这张画布还是旧地址"，且不报错。
             */
            mcpLibrary={mcpLibrary}
            onOpenMcpLibrary={onOpenMcpLibrary}
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

  /*
   * 变量解析：引用期间节点上**不存**那组字段的值。
   *
   * 不解析的话输入框是空的 —— 用户会以为"引用了变量，值却丢了"。
   * 解析在这里做一次，下面所有面板拿到的都是完整数据。
   */
  const shown = { ...node, data: resolveVars(node.data) } as FlowNode;

  /*
   * 改字段时，把命中变量组的部分转投到变量本身。
   *
   * 语义：改一处，所有引用这个变量的节点一起变。
   * 想让某个节点独立，点选择器上的「脱离」。
   *
   * 转投放在这里（分发器）而不是各节点的面板里：
   * 字段型面板与整体自定义面板都走同一个 onChange，
   * 放在这里一处覆盖全部节点类型；放进面板就得改十几个文件。
   */
  const onChangeWithVars: typeof onChange = (id, patch) => {
    const { nodePatch, varUpdates } = redirectVarPatch(node.data, patch);
    for (const u of varUpdates) patchVariableValues(u.id, u.patch);
    if (Object.keys(nodePatch).length > 0) onChange(id, nodePatch);
  };

  return (
    <>
      <NodeBasics
        node={shown}
        onChange={onChangeWithVars}
        onNote={onNote}
        onEditModule={onEditModule}
      />
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
        canvasId={activeCanvasId}
      node={shown}
      edges={edges}
      onChange={onChangeWithVars}
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
