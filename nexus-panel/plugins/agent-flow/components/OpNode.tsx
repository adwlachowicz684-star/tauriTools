import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { opBriefParts, briefArg, isArgPart, type BriefPart } from '../engine/ops';
import { argHandleId } from '../engine/paramLinks';

/**
 * role → 类名。
 *
 * 写成查表而不是 `role-${p.role}`：项目里有一条「组件用到的类名必须在
 * styles.css 里有定义」的守卫，模板拼出来的前缀它查不到，
 * 只能整条放行 —— 而那正是"类名写错却没人发现"的口子。
 */
const ARG_CLASS: Record<BriefPart['role'], string> = {
  val: 'node-arg',
  op: 'node-arg is-op',
  fn: 'node-arg is-fn',
  text: 'node-brief-text',
};

/**
 * 运算 / 变量 / 停止 / 人工输入 共用的卡片。
 *
 * 这七个节点的结构完全一样（一行摘要），各写一个会多出七份
 * 几乎相同的卡片 —— 与 ToolNode 同样的理由，合成一个。
 *
 * 摘要直接显示"在算什么"，**并且带上参数**（如 `10 ＋ 5`、`写入 总数 = 3`）。
 * 只显示运算名（"＋"）是不够的 —— 改了参数卡片上毫无变化，
 * 用户会以为没生效。带参数之后，改一个字卡片就跟着变。
 */
export function OpNode({ id, type, data, selected }: NodeProps) {
  const d = (data ?? {}) as Record<string, unknown>;
  const parts = partsOf(type, d);
  return (
    <NodeShell
      id={id}
      type={type}
      data={d}
      selected={selected}
    >
      <div className="node-line node-line--brief node-brief">
        {parts.map((p, i) => (
          /*
           * 参数格（role=val）自带一个**入口**，供参数连线接进来。
           *
           * 只有带 key 的格子才有 —— 运算符、括号、字面文字不是参数，
           * 给它们也开个口子会让人连到一个"接了也没用"的位置。
           *
           * 为什么入口在格子上而不是节点左侧那一个总入口：
           * 运算节点有 a / b / c 三个参数，共用一个入口就分不清
           * 这根线是填给谁的，而填错参数的表现是"结果不对但不报错"。
           */
          p.key ? (
            <span key={i} className={`${ARG_CLASS[p.role]} node-arg-port`}>
              <Handle
                type="target"
                position={Position.Left}
                id={argHandleId(p.key)}
                className="node-arg-handle"
              />
              {p.text}
            </span>
          ) : (
            <span key={i} className={ARG_CLASS[p.role]}>{p.text}</span>
          )
        ))}
      </div>
    </NodeShell>
  );
}

function partsOf(type: string, d: Record<string, unknown>): BriefPart[] {
  /*
   * 四个运算节点走 opBriefParts —— 摘要里带参数。
   *
   * 以前这里只显示运算名（如"＋"）：改了参数，卡片上毫无变化，
   * 用户以为没生效，只好点开面板再确认一遍。
   * 现在 `1 ＋ 2` 这样的写法，改一个字卡片就跟着变。
   */
  if (type === 'math' || type === 'text' || type === 'compare' || type === 'random') {
    return opBriefParts(type, d);
  }
  if (type === 'var') {
    const name = String(d.name ?? '').trim();
    const isGet = String(d.mode ?? 'set') === 'get';
    if (isGet) {
      return name
        ? [{ role: 'text', text: '读取：' }, { role: 'val', text: name }]
        : [{ role: 'text', text: '读取变量' }];
    }
    // 写入要把值也显示出来 —— 光看变量名不知道写进去的是什么
    const v = briefArg(d.value);
    return name
      ? [
        { role: 'text', text: '写入 ' }, { role: 'val', text: name },
        { role: 'op', text: '=' }, { role: 'val', text: v },
      ]
      : [{ role: 'text', text: '写入变量' }];
  }
  if (type === 'stop') {
    return [{
      role: 'text',
      text: String(d.mode ?? 'all') === 'all' ? '停止整个流程' : '停止这条分支',
    }];
  }
  if (type === 'ask') {
    const p = String(d.prompt ?? '').trim();
    return p
      ? [{ role: 'text', text: '等人填：' }, { role: 'val', text: briefArg(p, 20) }]
      : [{ role: 'text', text: '等人输入' }];
  }
  return [];
}
