import type { RunContext } from '../runContext';
import { withNodeRun } from '../runnerKit';
import {
  constItemKey, constsOf, normBoolText,
  type ConstNodeData, type ConstItem,
} from '../../types';

/**
 * 常量节点：每张卡产出一个值。
 *
 * 名字叫"常量"，但值支持模板，所以实际是"拼一段固定文本"。
 * 典型用途：给文件写入节点提供一段固定的头部、给 HTTP 请求提供
 * 一个固定 body、给条件节点提供一个比较基准。
 *
 * ================= 多张卡 =================
 *
 * 一个节点可以放多张卡（价格 / 阈值 / 开关），每张卡：
 *   · 具名输出 —— fields[卡id]，参数连线按 id 取
 *   · 模板引用 —— fields[卡名]，{{节点id.价格}} 这样读
 * 两条路都要写：只写 id 的话模板读不到人能读懂的名字，
 * 只写 name 的话改名会让已连好的线断掉。
 *
 * ================= 三种卡输出什么 =================
 *
 *   text  原样（模板渲染后的结果）
 *   num   原样。填了非数字的下游会按 0 算 —— 这个错由参数类型校验报
 *         （见 argTypes 的 const 规则），运行时不猜用户的意思
 *   bool  规范化成 'true' / 'false'（与卡片显示共用同一份规范化）
 *
 * ================= 主输出是第一张卡 =================
 *
 * 多卡时主输出取第一张 —— {{节点id.output}} 只有一个值可给。
 * 具体某张卡用 {{节点id.卡名}} 或参数连线（按卡 id）。
 *
 * 一张卡都没有时输出空串 —— 那不是"节点没跑"，而是"没得输出"，
 * 由面板拦住删空（见 ConstInspector 的删除按钮只在多于一张时出现）。
 */
export async function runConst(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as ConstNodeData;
  const items = constsOf(d);

  await withNodeRun(ctx, async () => {
    const fields: Record<string, string> = {};
    const values = items.map((it, i) => {
      const v = bake(it, ctx.tpl(String(it.value ?? '')));
      fields[constItemKey(it, i)] = v;
      /* 模板引用要人能读懂的名字；空名不写（避免写出一个空键） */
      const nm = (it.name ?? '').trim();
      if (nm) fields[nm] = v;
      return v;
    });
    return { output: values[0] ?? '', fields };
  });
}

function bake(it: ConstItem, raw: string): string {
  return (it.valueType ?? 'text') === 'bool' ? normBoolText(raw) : raw;
}
