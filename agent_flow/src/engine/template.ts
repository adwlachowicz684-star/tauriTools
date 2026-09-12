export type RenderResult = {
  text: string;
  /** 引用了但上游还没产出的变量，调用方可据此标黄提示 */
  missing: string[];
};

const TOKEN = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

/**
 * 渲染节点提示词。
 * 支持的写法：
 *   {{nodeId.output}}  上游节点输出
 *   {{nodeId}}         output 的简写
 *   {{input}}          工作流全局输入
 */
export function renderTemplate(
  tpl: string,
  ctx: { outputs: Record<string, string>; input?: string },
): RenderResult {
  const missing: string[] = [];
  const text = tpl.replace(TOKEN, (_m, rawKey: string) => {
    const key = rawKey.trim();
    const path = key.includes('.') ? key : `${key}.output`;
    const [nodeId, field] = path.split('.');

    let value: string | undefined;
    if (nodeId === 'input') value = ctx.input ?? '';
    else if (field === 'output') value = ctx.outputs[nodeId];

    if (value === undefined) {
      missing.push(key);
      return `{{${key}}}`; // 保留原样，便于用户一眼看出哪里没接上
    }
    return value;
  });
  return { text, missing: [...new Set(missing)] };
}
