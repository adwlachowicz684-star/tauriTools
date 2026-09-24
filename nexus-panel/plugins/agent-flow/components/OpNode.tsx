import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { opBriefParts, briefArg, type BriefPart } from '../engine/ops';
import { ArgLine } from './ArgCell';

/**
 * 运算 / 变量 / 停止 / 人工输入 共用的卡片。
 *
 * 这七个节点的结构完全一样（一行摘要），各写一个会多出七份
 * 几乎相同的卡片 —— 与 ToolNode 同样的理由，合成一个。
 *
 * 摘要直接显示"在算什么"，**并且带上参数**（如 `10 ＋ 5`、`写入 总数 = 3`）。
 * 只显示运算名（"＋"）是不够的 —— 改了参数卡片上毫无变化，
 * 用户会以为没生效。带参数之后，改一个字卡片就跟着变。
 *
 * 参数格**可以直接改**：点一下变输入框，运算符点一下弹下拉。
 * 画成下凹的输入格却不给改，比不画成框更让人困惑。
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
      <ArgLine nodeId={id} type={type} data={d} parts={parts} />
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
        ? [{ role: 'text', text: '读取：' }, val('name', name, name)]
        : [{ role: 'text', text: '读取变量' }];
    }
    // 写入要把值也显示出来 —— 光看变量名不知道写进去的是什么
    const v = briefArg(d.value);
    const rv = d.value === undefined || d.value === null ? '' : String(d.value);
    return name
      ? [
        { role: 'text', text: '写入 ' }, val('name', name, name),
        { role: 'op', text: '=' }, val('value', v, rv),
      ]
      : [{ role: 'text', text: '写入变量' }];
  }
  if (type === 'stop') {
    /*
     * 停到哪 —— 也做成可选。
     *
     * 它原先是纯文字（"停止整个流程"），改要去面板里翻，
     * 而这个节点**只有这一个参数**，卡片上却点不了，
     * 是"参数看不出是参数"最典型的一处。
     */
    const mode = String(d.mode ?? 'all');
    return [{
      role: 'text',
      text: mode === 'all' ? '停止整个流程' : '停止这条分支',
      raw: mode,
      edit: { key: 'mode', kind: 'select' },
    }];
  }
  if (type === 'ask') {
    const p = String(d.prompt ?? '').trim();
    return p
      ? [{ role: 'text', text: '等人填：' }, val('prompt', briefArg(p, 20), p)]
      : [{ role: 'text', text: '等人输入' }];
  }
  return [];
}

/** 一个可就地编辑的参数格 */
function val(key: string, text: string, raw: string): BriefPart {
  return { role: 'val', text, key, raw, edit: { key, kind: 'text' } };
}
