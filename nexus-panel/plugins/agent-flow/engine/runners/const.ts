import type { RunContext } from '../runContext';
import { withNodeRun } from '../runnerKit';
import { normBoolText, type ConstNodeData, type ConstValueType } from '../../types';

/**
 * 常量节点：输出一个固定值给下游。
 *
 * 名字叫"常量"，但值支持模板，所以实际是"拼一段固定文本"。
 * 典型用途：给文件写入节点提供一段固定的头部、给 HTTP 请求提供
 * 一个固定 body、给条件节点提供一个比较基准。
 *
 * ================= 三种常量输出什么 =================
 *
 *   text  原样（模板渲染后的结果）
 *   num   原样。填了非数字的下游会按 0 算 —— 这个错由参数类型校验报
 *         （见 argTypes 的 const 规则），运行时不猜用户的意思
 *   bool  规范化成 'true' / 'false'
 *
 * 布尔要规范化是因为老存档里可能是 'True' / '1' / 'yes' 等写法，
 * 下游条件节点只认小写 'true' —— 不规范的写法会被判成不成立，
 * 而用户看着面板上写着"真"却拿到不成立，是最难查的一类。
 */
export async function runConst(ctx: RunContext): Promise<void> {
  const d = ctx.node.data as ConstNodeData;
  const vt: ConstValueType = d.valueType ?? 'text';

  await withNodeRun(ctx, async () => {
    const raw = ctx.tpl(String(d.value ?? ''));
    return { output: vt === 'bool' ? normBoolText(raw) : raw };
  });
}

