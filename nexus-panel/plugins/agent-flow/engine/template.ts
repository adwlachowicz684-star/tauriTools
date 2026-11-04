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

/**
 * 名字（参数名 / 卡名）能用的字符 —— 与"引用能取到的名字"同源。
 *
 * 注意：这**不是**「改节点 id 时扫引用」用的字符集了。那份职责已由
 * rewriteRefHeads 走 tokenRe()（完整引用）承担，因为节点 id 本身可以
 * 带 `-`，而参数名不许带（避免与减号、路径分隔混淆）。
 * 两件事以前被同一个常量捆着，正是两边字符集分叉的来源。
 */
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
 * 改节点 id 时，把文本里的引用**头一段**跟着改掉。
 *
 * ================= 为什么必须走 tokenRe()，不能自己写 head 正则 =================
 *
 * 以前模块展开与跨画布展开各写了一份「只认 `{{id.`」的正则：
 *
 *   · modules.ts   `[A-Za-z0-9_-]+` —— 认 `-`，不认中文
 *   · canvasRef.ts `refHeadRe()`     —— 认中文，不认 `-`
 *
 * 两份都**只认带点**的 `{{id.xxx}}`，而 `{{id}}` 是 output 的简写
 * （engine.test.ts 里有专门用例），两边都不重写它。
 * 渲染器认的却是 tokenRe()：简写、`-`、中文全都认。
 *
 * 于是同一句引用，展开后是三种不同结果，且全是**静默空串**：
 *
 *   {{A}}           → 两种展开都原样留着，指向展开图里不存在的 A
 *   {{a-b.output}}  → 模块改对了，跨画布没改
 *   {{价格.output}} → 跨画布改对了，模块没改
 *
 * 界面上都是「下游没数据」，排查会去查下游节点，想不到是展开那一步。
 * 判据与渲染同源后，三种一起消失；也不再需要 refHeadRe 那份
 * 「只取带点头」的第二字符集。
 *
 * ================= 只换第一段，其余原样保留 =================
 *
 * 用匹配文本里的位置替换，不重建整句：`{{ A.output }}` 的空白、
 * 多级后缀、以及没命中的引用（{{input}} / {{params.名字}} / {{loop.item}}）
 * 都原封不动。
 */
/**
 * 渲染器保留的引用头 —— 这六个名字在 renderTemplate 里有专门分支，
 * **不是节点 id**。
 *
 * 展开时 idMap 的键是模块/子画布内部的节点 id。若某个内部节点恰好叫
 * input / params，文本里的 {{input}}（全局输入）、{{params.价格}}
 * （画布参数）被改成 {{inst__input}} 之后，就从「全局输入」反转成
 * 「引用一个常量节点」—— 不报错，界面上只是值不对。
 *
 * 清单与 renderTemplate 的分支由 refHeadRewrite.test.ts 里的守卫
 * 逐项比对（从函数体提取 nodeId === 'xxx'），不另抄一份。
 */
const RESERVED_REF_HEADS = new Set(['input', 'chain', 'loop', 'var', 'params', 'env']);

export function rewriteRefHeads(text: string, map: Map<string, string>): string {
  if (!text.includes('{{')) return text;
  return text.replace(tokenRe(), (m, raw: string) => {
    const key = raw.trim();
    const head = key.split('.')[0];
    if (RESERVED_REF_HEADS.has(head)) return m;
    const to = map.get(head);
    if (!to) return m;
    const at = m.indexOf(head);
    if (at < 0) return m;
    return m.slice(0, at) + to + m.slice(at + head.length);
  });
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

/**
 * 「有没渲染出来的变量」这件事的失败文案 —— 全仓唯一一处。
 *
 * ================= 为什么要收在这里 =================
 *
 * 未渲染的后果取决于它落在哪个参数上：
 *
 *   路径   → 磁盘上多出一个叫 `{{x}}` 的东西
 *   命令   → 真的执行了一条带字面量的命令
 *   推送   → 字面量被提交到远端仓库
 *
 * 三者后果不同，所以 consequence 由调用方给；但"怎么措辞、列出哪些变量"
 * 只有一份 —— 各写一份的话，出现第四处时又会漏，而且措辞会漂成四种说法。
 *
 * ================= 为什么断言里要带上变量名 =================
 *
 * 只说"有变量没渲染"用户还得去找是哪一处；把名字列出来，
 * 一眼就能看出是引用了哪个节点。
 */
export function unresolvedIssue(what: string, missing: string[], consequence: string): string {
  return `${what}里有没渲染出来的模板变量（${missing.join('、')}）—— ${consequence}`;
}
