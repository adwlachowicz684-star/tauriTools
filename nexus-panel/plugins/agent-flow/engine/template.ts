import type { LoopCtx } from '../types';
export type RenderResult = {
  text: string;
  /** 引用了但上游还没产出的变量，调用方可据此标黄提示 */
  missing: string[];
};

const TOKEN = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

export type RenderCtx = {
  outputs: Record<string, string>;
  input?: string;
  /** 循环体内的迭代上下文；不在循环中时为 null */
  loop?: LoopCtx | null;
  /**
   * 节点的附加字段，支持 {{nodeId.字段名}}。
   *
   * 更新检测节点靠它把"标题/链接/时间"交给下游：
   * 节点主输出是 true/false（给条件节点判断用），
   * 但下游任务节点往往还想知道"更新的那条叫什么"。
   */
  fields?: Record<string, Record<string, string>>;
};

/**
 * 渲染节点提示词。
 * 支持的写法：
 *   {{nodeId.output}}  上游节点输出
 *   {{nodeId}}         output 的简写
 *   {{input}}          工作流全局输入
 *   {{loop.item}}      循环：当前项
 *   {{loop.index}}     循环：当前下标（从 0 开始）
 *   {{loop.count}}     循环：总轮数
 *   {{nodeId.字段}}     节点的附加字段（如更新检测节点的 title / url / date）
 */
export function renderTemplate(tpl: string, ctx: RenderCtx): RenderResult {
  const missing: string[] = [];
  const text = tpl.replace(TOKEN, (_m, rawKey: string) => {
    const key = rawKey.trim();
    const path = key.includes('.') ? key : `${key}.output`;
    const [nodeId, field] = path.split('.');

    let value: string | undefined;
    if (nodeId === 'input') value = ctx.input ?? '';
    else if (nodeId === 'loop') {
      // 循环变量只在循环体内可用；外部引用视为未解析（保留原样提示用户）
      const lp = ctx.loop;
      if (!lp) {
        missing.push(key);
        return `{{${key}}}`;
      }
      if (field === 'output' || field === 'item') value = lp.item;
      else if (field === 'index') value = String(lp.index);
      else if (field === 'count') value = String(lp.count);
    } else if (field === 'output') value = ctx.outputs[nodeId];
    else value = ctx.fields?.[nodeId]?.[field];

    if (value === undefined) {
      missing.push(key);
      return `{{${key}}}`; // 保留原样，便于用户一眼看出哪里没接上
    }
    return value;
  });
  return { text, missing: [...new Set(missing)] };
}
