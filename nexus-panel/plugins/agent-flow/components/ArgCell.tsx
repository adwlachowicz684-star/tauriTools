import { createContext, useContext, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Handle, Position } from '@xyflow/react';
import { getDef } from '../nodes/registry';
import { argHandleId } from '../engine/paramLinks';
import type { BriefPart } from '../engine/ops';

/**
 * 卡片上的**可编辑参数格**。
 *
 * ================= 为什么要在卡片上直接改 =================
 *
 * 参数画成下凹的输入格之后，它长得就跟"能填东西的框"一样，
 * 点一下却没反应 —— 比不画成框更让人困惑。
 * 而打开右侧面板改一个值要：选中 → 找字段 → 改 → 回画布看效果，
 * 调一个运算要来回好几趟。
 *
 * ================= 两种方式 =================
 *
 *   · kind='text'   点一下变输入框，回车/失焦生效，Esc 撤销
 *   · kind='select' 点一下弹下拉（运算符、模式这类"只能选"的）
 *
 * 运算符为什么必须是下拉而不是继续手填：
 * 可选的是固定的那几个（加减乘除 / 大于小于包含），手填的话
 * 填错一个字不报错，只是运行时走到 default 分支给出"未知运算"。
 */
export type NodePatchFn = (id: string, patch: Record<string, unknown>) => void;

/**
 * 改节点数据的通道。
 *
 * 卡片拿不到 App 的 setNodes —— 它不是 App 的直接子组件，
 * 而是经 nodeTypes 交给 xyflow 渲染的。只能在 App 上挂一层 Context。
 *
 * 默认值给 null 而不是抛错：卡片在没有 Provider 的环境里（单测、单独预览）
 * 仍能渲染，只是**点不动** —— 这比整片白屏好。
 */
const NodePatchCtx = createContext<NodePatchFn | null>(null);

export const NodePatchProvider = NodePatchCtx.Provider;

export function useNodePatch(): NodePatchFn | null {
  return useContext(NodePatchCtx);
}

export type ArgCellProps = {
  nodeId: string;
  /** 节点类型（math / compare / stop …），用来查这一格有哪些可选项 */
  type: string;
  part: BriefPart;
  /** 格子的类名：参数格 / 运算符格 / 普通文字 */
  className: string;
  /** 整个节点 data —— 可选项若随数据变化（函数形式）要用它算 */
  data: Record<string, unknown>;
};

type Opt = { value: string; label: string };

/**
 * 这一格有哪些可选项 —— **从节点定义里取**，不在卡片上另写一份。
 *
 * 两处各写一份列表的话，加一个运算符就要改两个地方；
 * 漏改的表现是"面板里能选，卡片上下拉里没有"，
 * 而下拉里少了那一项不会报错，只是永远选不到。
 */
export function selectOptionsOf(type: string, key: string, d: Record<string, unknown>): Opt[] {
  const def = getDef(type);
  // fields 的第一个参数是节点 data —— 选项可能随数据变（如按模式给不同列表）
  const fields = def.fields?.(d) ?? [];
  const f = fields.find((x) => x.key === key);
  if (!f || f.type !== 'select') return [];
  const o = f.options;
  return (typeof o === 'function' ? o(d) : o ?? []).map((x) => ({ value: x.value, label: x.label }));
}

export function ArgCell({ nodeId, type, part, className, data }: ArgCellProps) {
  const patch = useNodePatch();
  /** null = 非编辑态；字符串 = 编辑中的草稿 */
  const [draft, setDraft] = useState<string | null>(null);

  const edit = part.edit;
  const options = edit?.kind === 'select' ? selectOptionsOf(type, edit.key, data) : [];
  const canSelect = Boolean(patch && edit && options.length > 0);
  const canText = Boolean(patch && edit?.kind === 'text');

  /*
   * 入口必须始终在 —— 编辑时也不例外。
   *
   * 编辑态若把 Handle 换成 input 而丢掉它，已连上去的那根参数线
   * 会短暂找不到端口：线还在（按 id 记的），但这一端没了落点，
   * 表现为"改完参数，连线飘在半空"。
   */
  const handle = part.key ? (
    <Handle
      type="target"
      position={Position.Left}
      id={argHandleId(part.key)}
      className="node-arg-handle"
    />
  ) : null;

  const cls = `${className}${edit ? ' is-editable' : ''}${part.key ? ' node-arg-port' : ''}`;

  /* ---------------- 下拉：运算符 / 模式 ---------------- */

  if (canSelect && edit) {
    return (
      <span className={cls} title={`改${edit.key === 'op' ? '运算' : '这一项'}`}>
        {handle}
        <span className="node-arg-txt">{part.text}</span>
        {/*
         * 透明的原生 <select> 铺在格子上。
         *
         * 为什么不自己写一个浮层下拉：节点卡片在 xyflow 的变换层里，
         * 自绘浮层会被后面的节点盖住（层级由 transform 决定，改不了），
         * 而原生下拉是浏览器画的，永远在最上层。
         *
         * 透明是为了看得见我们的格子而不是系统控件；
         * 点击落在格子的任何位置都能展开 —— 铺满整格。
         */}
        <select
          className="node-arg-sel nodrag nopan"
          value={part.raw ?? ''}
          onChange={(e) => patch?.(nodeId, { [edit.key]: e.target.value })}
          onMouseDown={(e: MouseEvent) => e.stopPropagation()}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </span>
    );
  }

  /* ---------------- 输入框 ---------------- */

  if (draft !== null && edit) {
    const commit = () => {
      patch?.(nodeId, { [edit.key]: draft });
      setDraft(null);
    };
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
      /*
       * 拦住冒泡：画布上按 Delete 是删除节点、按空格是平移。
       * 不拦的话，在参数框里按一次退格就把整个节点删了 ——
       * 而那时焦点在输入框里，用户根本想不到自己在操作画布。
       */
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDraft(null);
      }
    };
    return (
      <span className={cls}>
        {handle}
        <input
          className="node-arg-in nodrag nopan"
          /* 自动聚焦 + 全选：点进来就是要替换掉原来那串 */
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          onMouseDown={(e: MouseEvent) => e.stopPropagation()}
        />
      </span>
    );
  }

  /* ---------------- 静态显示 ---------------- */

  return (
    <span
      className={cls}
      title={canText ? '点一下直接改' : undefined}
      onClick={canText ? (e: MouseEvent) => {
        e.stopPropagation();
        // 初值用 raw（未截断），不能用显示用的 text —— 见 BriefPart.raw 的说明
        setDraft(part.raw ?? '');
      } : undefined}
    >
      {handle}
      <span className="node-arg-txt">{part.text}</span>
    </span>
  );
}
