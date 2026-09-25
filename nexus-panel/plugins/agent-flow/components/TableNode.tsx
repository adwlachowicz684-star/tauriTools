import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { ArgLine } from './ArgCell';
import type { BriefPart } from '../engine/ops';

/**
 * 表格节点共用的卡片。
 *
 * 四个节点结构一样（一行摘要），合成一个。
 * 摘要显示"几行 × 几列"和公式 —— 扫一眼知道这张表多大、在算什么。
 *
 * ================= 摘要为什么画成参数格 =================
 *
 * 以前 `briefOf` 返回一整串字符串，卡片上只能当纯文本渲染：
 * 看着是一行说明，看不出哪部分是你填的公式/列名，也点不动 ——
 * 而这个节点**总共就一两样参数**（`伤害 = 攻击*2`、`保留：血量>100`），
 * 调它们要开右侧面板，卡片上却明明写着。
 *
 * 公式类（expr / cond）走 `kind: 'area'`：一行写不下，且回车要能换行 ——
 * 用单行 input 的话一按回车就退出编辑，内容还被原样存下去，
 * 不报错，只是那段公式永远只有第一行。
 */

/** 一个可就地编辑的文本格 */
function val(key: string, raw: string, fallback: string, area = false): BriefPart {
  const v = String(raw ?? '').trim();
  return {
    role: 'val',
    text: v || fallback,
    key,
    raw: v,
    edit: { key, kind: area ? 'area' : 'text' },
  };
}

/** 只能选的（聚合方式）：画成运算符格，点一下弹下拉 */
function pick(key: string, raw: string, fallback: string): BriefPart {
  const v = String(raw ?? '').trim();
  return {
    role: 'op',
    text: v || fallback,
    key,
    raw: v,
    edit: { key, kind: 'select' },
  };
}

export function TableNode({ id, type, data, selected }: NodeProps) {
  const d = (data ?? {}) as Record<string, unknown>;
  return (
    <NodeShell
      id={id}
      type={type}
      data={d}
      selected={selected}
    >
      <ArgLine nodeId={id} type={type} data={d} parts={partsOf(type, d)} />
    </NodeShell>
  );
}

function partsOf(type: string, d: Record<string, unknown>): BriefPart[] {
  if (type === 'tableRead') {
    const p = String(d.path ?? '').trim();
    /*
     * 显示文件名、编辑完整路径 ——
     * 与文件节点同理：拿 `…/两级` 当初值会把完整路径改坏，且不报错。
     */
    const name = p ? p.split(/[\\/]/).pop() ?? p : '';
    return [
      p
        ? { role: 'val', text: name, key: 'path', raw: p, edit: { key: 'path', kind: 'text' } }
        : { role: 'text', text: '还没选文件' },
    ];
  }
  if (type === 'derive') {
    return [
      val('newCol', String(d.newCol ?? ''), '新列名'),
      { role: 'text', text: '=' },
      val('expr', String(d.expr ?? ''), '还没填公式', true),
    ];
  }
  if (type === 'filter') {
    return [
      { role: 'text', text: '保留：' },
      val('cond', String(d.cond ?? ''), '还没填条件', true),
    ];
  }
  if (type === 'agg') {
    /*
     * 聚合方式的选项取自节点定义（agg.ts 的 fields），
     * 不在这里另写一份 —— 漏改的表现是"面板里能选，卡片上下拉里没有"。
     */
    return [
      pick('op', String(d.op ?? 'sum'), 'sum'),
      val('col', String(d.col ?? ''), '还没填列名'),
    ];
  }
  return [];
}
