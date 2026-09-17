/**
 * 节点契约 —— 「这个积木产出什么、能吃下什么」。
 *
 * ================= 为什么要有这份东西 =================
 *
 * 注册表已经能回答"有哪些积木、每个积木填什么参数、哪些参数必填"，
 * 但回答不了**决定一条链能不能成立**的那件事：
 *
 *   A 产出什么？B 能吃下什么？
 *
 * 此前这层只存在于注释和人的脑子里。于是 AI（或人）拼装时最容易犯的
 * 一类错误完全没被拦住：
 *
 *   上游 →「等待 2 秒」→ 提取
 *
 * 看着天经地义，但「等待」的输出是 `已等待 2000ms` 这样一句状态标记，
 * **不是**上游传下来的数据。提取节点吃到的是那句标记，取不到任何东西，
 * 而且**不报错**（取不到默认给空串）。
 *
 * ================= 端口种类 =================
 *
 * 区分 'mark' 与 'any' 是本文件的核心价值：
 *
 *   'any'  透传上游 —— 插在链中间不破坏数据（日志标记）
 *   'mark' 输出状态描述 —— 插在链中间会**截断**上游数据（等待/提示音）
 *
 * 这两者外观上都是"有个输出"，语义却相反。
 */

/** 输出端口的数据种类 */
export type PortKind =
  /** 普通文本，可直接被下游消费 */
  | 'text'
  /** JSON 文本，适合接「数据提取」 */
  | 'json'
  /** 是/否，主要给条件节点判断 */
  | 'bool'
  /** 文件引用列表（文件操作节点的产出） */
  | 'files'
  /**
   * 状态标记 —— 如「已等待 2000ms」「已播放提示音」。
   * 它是**描述动作完成**，不是承载上游数据。
   * 插在链中间会截断数据流，是最容易踩的坑。
   */
  | 'mark'
  /** 透传上游（日志标记）。上游没数据时等于空 */
  | 'any'
  /** 不产出任何内容 */
  | 'none';

/** 能吃下什么。'any' = 都行；'none' = 不需要输入 */
export type Accepts = 'any' | 'none' | PortKind[];

export type NodeSpec = {
  /** 产出什么 */
  produces: PortKind;
  /**
   * 能吃下什么。
   *
   * 注意这里描述的是**语义上能不能用**，不是"物理上能不能连" ——
   * 本文件只做提示，不硬阻止（理由见 canConnect）。
   */
  accepts: Accepts;
  /** 一句话说明产出什么，给 AI 与提示文案用 */
  producesDesc?: string;
  /**
   * 参数无法从 fields 派生（该节点用整体自定义面板）。
   * 为 true 时 params 需手写。
   */
  manualParams?: boolean;
  /** manualParams 时手写的参数说明 */
  params?: ParamSpec[];
};

export type ParamSpec = {
  key: string;
  /** 给 AI 看的说明 */
  desc: string;
  /** 是否必填 */
  required?: boolean;
  /** 枚举取值 */
  options?: string[];
};

export const PORT_LABEL: Record<PortKind, string> = {
  text: '文本',
  json: 'JSON',
  bool: '是/否',
  files: '文件',
  mark: '状态标记（非数据）',
  any: '透传上游',
  none: '无输出',
};

/* ------------------------------------------------------------------ */
/* 各节点契约                                                          */
/* ------------------------------------------------------------------ */

const S = (
  produces: PortKind,
  accepts: Accepts,
  producesDesc?: string,
  extra?: { manualParams?: boolean; params?: ParamSpec[] },
): NodeSpec => ({ produces, accepts, producesDesc, ...extra });

/**
 * 按 dataKind 索引（与 nodeValidate 同一套键，便于核对覆盖）。
 *
 * 放在这里而不是节点定义文件里：那些文件是 tsx，import 了 React 组件，
 * 而这份契约要能被纯 Node 环境消费（测试、以及将来喂给 AI 的接口）。
 *
 * 代价是"节点定义在 A、契约在 B" —— 用 tests/nodeSpec.test.ts 盯着
 * 两者覆盖一致，不会漏。
 */
export const SPECS: Record<string, NodeSpec> = {
  // 起点：产出流程输入
  trigger: S('text', 'none', '流程的初始输入（手动文本 / 触发带来的内容）', {
    manualParams: true,
    params: [
      { key: 'mode', desc: '触发方式', required: true, options: ['manual', 'interval', 'cron', 'watch', 'webhook', 'conversation'] },
      { key: 'enabled', desc: '是否启用' },
    ],
  }),

  // 任务：CLI 的输出
  task: S('text', 'any', 'CLI 的执行输出'),

  // 流程控制
  condition: S('mark', 'any', '分支标记文本（如「[条件] 走「是」」）—— 作用是分流，不转换数据', {
    manualParams: true,
    params: [{ key: 'rules', desc: '规则列表，每条含算子与比较值' }],
  }),
  loop: S('any', 'any', '透传（循环体每轮一次，done 出口汇总一次）', {
    manualParams: true,
    params: [{ key: 'mode', desc: '循环方式' }, { key: 'maxIterations', desc: '最大轮数' }],
  }),
  parallel: S('any', 'any', '透传', {
    manualParams: true,
    params: [{ key: 'mode', desc: '并发模式' }, { key: 'concurrency', desc: '并发度' }],
  }),

  // 文件与数据
  fs: S('files', 'any', '文件引用列表（下游按文件处理）'),
  extract: S('text', ['text', 'json'], '从上游文本里提取出的值'),

  // AI
  ocr: S('text', ['text', 'files', 'any'], '图片识别出的文字'),
  translate: S('text', ['text'], '翻译后的文本'),

  // 外部服务
  update: S('bool', 'none', '是否有更新（true / false）—— 给条件节点判断', {
    manualParams: true,
    params: [{ key: 'source', desc: '数据源', options: ['bili', 'wechat'] }],
  }),
  'github-update': S('json', 'none', '仓库最新信息（JSON）'),
  'github-push': S('text', 'any', '推送结果说明'),
  'generic-http': S('json', 'any', 'HTTP 响应正文'),

  // 工具
  wait: S('mark', 'any', '「已等待 Nms」—— 状态标记，会截断上游数据'),
  beep: S('mark', 'any', '「已播放提示音」—— 状态标记，会截断上游数据'),
  'play-audio': S('mark', 'any', '「已播放 xxx」—— 状态标记，会截断上游数据'),
  clock: S('text', 'none', '格式化后的当前时间'),
  const: S('text', 'none', '常量值（支持模板）'),
  log: S('any', 'any', '原样透传上游 —— 插在链中间不破坏数据'),

  // 组合
  module: S('any', 'any', '模块内部最后一个节点的输出'),
};

/** 取契约。没声明的类型按"都能接"处理，不因此报错 */
export function specOf(dataKind: string | undefined | null): NodeSpec | null {
  if (!dataKind) return null;
  return SPECS[dataKind] ?? null;
}

/* ------------------------------------------------------------------ */
/* 连接判据                                                            */
/* ------------------------------------------------------------------ */

export type ConnectVerdict = {
  /** ok=正常；warn=能连但语义上可疑；block=不应连 */
  level: 'ok' | 'warn' | 'block';
  /** 给用户的说明。ok 时为 null */
  reason: string | null;
};

const OK: ConnectVerdict = { level: 'ok', reason: null };

function warn(reason: string): ConnectVerdict {
  return { level: 'warn', reason };
}

function block(reason: string): ConnectVerdict {
  return { level: 'block', reason };
}

/**
 * 能不能从 src 连到 dst。
 *
 * 只判断 src / dst 自身的契约（不知道已有边），
 * 所以"多个上游"这类问题不在这里处理。
 */
export function canConnect(src: NodeSpec | null, dst: NodeSpec | null): ConnectVerdict {
  // 有一方没有契约声明 → 不猜，放行
  if (!src || !dst) return OK;

  // 目标明确不需要输入：连上去也不会被用到
  if (dst.accepts === 'none') {
    return warn('这个节点不需要输入，连上去的内容不会被使用');
  }

  // 源不产出任何东西
  if (src.produces === 'none') {
    return warn('上游节点不产出内容，下游拿不到数据');
  }

  // 目标什么都吃
  if (dst.accepts === 'any') return OK;

  /*
   * 源是透传型（日志标记）：它输出什么取决于它的上游，
   * 这里拿不到那条信息，不能断言不匹配 —— 放行。
   * 少了这一步，日志标记会被误判成"类型不符"，而它恰恰是安全的。
   */
  if (src.produces === 'any') return OK;

  // 目标吃透传型 —— mark 会截断数据，值得提醒
  if (dst.accepts.includes('any') && src.produces === 'mark') {
    return warn(
      `上游输出的是状态标记（${src.producesDesc ?? '如「已等待 2000ms」'}），`
      + '不是传下来的数据。下游会拿到这句标记而不是你想处理的内容',
    );
  }

  if (dst.accepts.includes(src.produces)) return OK;

  // 明确不在可接受列表里
  return warn(
    `这个节点需要${dst.accepts.map((k) => PORT_LABEL[k]).join(' / ')}，`
    + `而上游产出的是${PORT_LABEL[src.produces]}`,
  );
}

/**
 * 嵌合（Scratch 式上下吸附）用同一套判据。
 *
 * 嵌合等价于一条隐式边，连接判据当然也该一致 ——
 * 否则会出现"拉线有提示、吸附上去没提示"的割裂。
 */
export function canStack(above: NodeSpec | null, below: NodeSpec | null): ConnectVerdict {
  return canConnect(above, below);
}

/* ------------------------------------------------------------------ */
/* 给 AI 消费的清单                                                    */
/* ------------------------------------------------------------------ */

export type BlockInfo = {
  kind: string;
  produces: PortKind;
  producesDesc: string;
  accepts: Accepts;
  /** true 表示参数需从 fields 派生（本文件不重复写） */
  paramsFromFields: boolean;
};

/**
 * 导出全部积木的契约，供 AI 拼装时参考。
 *
 * 刻意**不**在这里塞参数表：参数已经在各节点的 fields 里声明过一份，
 * 再抄一份就是"同一件事写两遍"，改一处忘另一处必然漂移。
 * 参数由调用方用 fields 派生（deriveParams），这里只标出去哪儿取。
 */
export function blockCatalog(): BlockInfo[] {
  return Object.keys(SPECS).sort().map((k) => {
    const s = SPECS[k];
    return {
      kind: k,
      produces: s.produces,
      producesDesc: s.producesDesc ?? PORT_LABEL[s.produces],
      accepts: s.accepts,
      paramsFromFields: !s.manualParams,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 参数表派生（在能 import fields 的地方调用）                          */
/* ------------------------------------------------------------------ */

/**
 * 从字段清单派生参数表。
 *
 * 这是**唯一**的参数来源 —— 本文件刻意不抄一份参数表，
 * 否则就是"同一件事写两遍"，改一处忘另一处必然漂移。
 *
 * custom 字段靠 FieldDef.spec 补齐（那段手写 JSX 读写的 key 从外面看不出来），
 * 没声明 spec 的 custom 会标成 unknown，提醒补声明。
 *
 * @param keyOf 从字段取参数名
 */
/*
 * 刻意不写 `readonly X[]`：strip-ts.py 处理不了 readonly 修饰符，
 * 会原样留下导致生成的 .mjs 语法错误。
 */
export function deriveParams(fields: unknown[]): ParamRow[] {
  const out: ParamRow[] = [];
  for (const raw of fields) {
    const f = (raw ?? {}) as Record<string, unknown>;
    const type = String(f.type ?? '');
    if (type === 'note') continue; // 纯说明，不是参数

    if (type === 'custom') {
      const spec = f.spec as { keys?: string[]; kind?: string } | undefined;
      if (spec?.keys?.length) {
        for (const k of spec.keys) out.push({ key: k, type: spec.kind ?? 'custom' });
      } else {
        out.push({ key: String(f.key ?? '(未命名)'), type: 'custom', unknown: true });
      }
      continue;
    }

    const key = f.key;
    if (typeof key === 'string' && key) out.push({ key, type });
  }
  return out;
}

export type ParamRow = { key: string; type: string; unknown?: boolean };

/** 派生结果里有多少参数没被声明清楚（用于测试盯住） */
export function unknownParams(params: ParamRow[]): number {
  return params.filter((p) => p.unknown).length;
}
