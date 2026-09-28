import type { LoopCtx } from '../types';
export type RenderResult = {
  text: string;
  /** 引用了但上游还没产出的变量，调用方可据此标黄提示 */
  missing: string[];
};


/* ==================================================================
 * 引用路径的字符集 —— 全仓库**唯一**定义处。
 *
 * ================= 为什么不能再抄第二份 =================
 *
 * 这份字符集以前在 template.ts（运行时渲染）和 scriptExport.ts
 * （导出脚本）里各写了一份。template.ts 那次为修中文参数名放开了
 * \u4e00-\u9fa5，**scriptExport.ts 没跟着改** ——
 *
 *   同一个 {{c1.价格}}：画布上跑能取到值，导出成脚本变成字面量。
 *   不报错，只有结果不对（而且留下来的 {{}} 看着像"用户自己写的正文"）。
 *
 * 这是"同一件事两份实现，改一份漏一份"的典型，
 * 所以这里只留一处定义，其余全部来取。
 *
 * 支持中文（见上）。边界仍由 {{ }} 限定，放宽内部字符集不会误吞正文。
 * ==================================================================
 */
const REF_CHARS = 'A-Za-z0-9_.\\-\\u4e00-\\u9fa5';

/** 引用的**第一段**是节点 id / params 这类名字，不含 `.` 与 `-`（后面紧跟 `.`） */
const REF_HEAD_CHARS = 'A-Za-z0-9_\\u4e00-\\u9fa5';

/** 名字（参数名 / 卡名）能用的字符 —— 与"引用能取到的名字"同源 */
export const REF_NAME_CHARS = REF_HEAD_CHARS;
/** 名字的**首字符**：不许是数字（否则 {{1a}} 会被当成数字解析） */
export const REF_NAME_FIRST = 'A-Za-z_\\u4e00-\\u9fa5';

/**
 * 完整引用 `{{a.b.c}}`。
 *
 * 每次返回**新实例**：`/g` 正则带 lastIndex 状态，
 * 两个调用方共用一个实例会互相踩（一个 replace 跑到一半，
 * 另一个进来把 lastIndex 抹了，表现是"偶尔漏替换"）。
 */
export function tokenRe(): RegExp {
  return new RegExp(`\\{\\{\\s*([${REF_CHARS}]+)\\s*\\}\\}`, 'g');
}

/**
 * 只取引用的头一段 `{{id.` —— 改节点 id 时要顺带改写引用。
 * 字符集与 tokenRe 同源（否则 id 含中文时扫不到，引用就断在原地）。
 */
export function refHeadRe(): RegExp {
  return new RegExp(`\\{\\{\\s*([${REF_HEAD_CHARS}]+)\\s*\\.`, 'g');
}

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
  /**
   * 工作流变量表，支持 {{var.名字}}。
   *
   * 与 outputs 的区别见 runner.ts 里的同名注释：
   * 这里存的是"流程自己记下来的值"，名字由用户起，
   * 因此比 {{节点id.output}} 稳定。
   */
  vars?: Record<string, string>;
  /**
   * 画布参数，支持 {{params.名字}}。
   *
   * 与 vars 的区别：
   *   vars  流程运行中由「变量」节点写进去的 —— 每次运行从空开始
   *   params 画布上预先填好的 —— 每张画布各一套，模块靠它跨画布复用
   *
   * 两者语义完全不同，合成一个会出现"这次运行改了、下次还在"这种
   * 说不清的行为。
   */
  params?: Record<string, string>;
  /**
   * 嵌合（Scratch 式上下吸附）带来的两个变量。
   *
   *   {{input}}        直接上方的输出（未嵌合时仍是工作流全局输入）
   *   {{chain.output}} 整条串上、本节点之前所有输出的拼接
   *
   * 由调用方算好传进来 —— 模板层是纯字符串处理，
   * 不该知道节点图长什么样（测试要在 Node 下单跑它）。
   */
  stackInput?: string;
  chainOutput?: string;
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
 *   {{params.名字}}    画布参数（画布范围局部变量，模块跨画布复用靠它）
 *   {{env.名字}}       {{params.名字}} 的旧称，仍然认
 */
export function renderTemplate(tpl: string, ctx: RenderCtx): RenderResult {
  const missing: string[] = [];
  const text = tpl.replace(tokenRe(), (_m, rawKey: string) => {
    const key = rawKey.trim();
    const path = key.includes('.') ? key : `${key}.output`;
    const [nodeId, field] = path.split('.');

    let value: string | undefined;
    if (nodeId === 'input') {
      value = ctx.stackInput !== undefined ? ctx.stackInput : (ctx.input ?? '');
    } else if (nodeId === 'chain') {
      // 只在嵌合时可用；没嵌合就当未解析，保留原样提示用户
      if (ctx.chainOutput === undefined) {
        missing.push(key);
        return `{{${key}}}`;
      }
      value = ctx.chainOutput;
    }
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
    } else if (nodeId === 'var') {
      const v = ctx.vars?.[field];
      /*
       * 变量没设过时当未解析（保留原样提示），
       * 而不是给空串 —— 空串会让"还没赋值"和"赋了空值"看起来一样，
       * 而这两者要修的方式完全不同。
       */
      if (v === undefined) {
        missing.push(key);
        return `{{${key}}}`;
      }
      value = v;
    } else if (nodeId === 'params' || nodeId === 'env') {
      /*
       * env 是旧称 —— 早期注释里承诺过 {{env.NAME}} 可用，
       * 只是从来没实现过。认它，免得老画布一升级就全变成未解析。
       */
      const v = ctx.params?.[field];
      /*
       * 没定义时保留原样提示，而不是给空串。
       *
       * 空串的危害在这里特别大：路径类参数取到空串会变成
       * "写到当前目录"，文件真被写了、位置却不对 ——
       * 比直接报错难查得多。
       */
      if (v === undefined) {
        missing.push(key);
        return `{{${key}}}`;
      }
      value = v;
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

/*
 * 「扫文本里引用了哪些参数名」的那份实现在 engine/canvasParams.ts 的
 * scanParamRefs —— 它分词用上面的 tokenRe()，前缀规则自己管。
 *
 * 这里**不再**放第二份：以前本文件有一个 paramRefsIn，但没人调用它，
 * 而 canvasParams 那边自带了一份正则。于是"扫到的名字"和"渲染时认的名字"
 * 是两套字符类在决定 —— 这正是本项目反复踩的"两份实现改一份漏一份"。
 *
 * 现在只有一处：canvasParams.scanParamRefs，且它从 tokenRe() 取分词。
 */
