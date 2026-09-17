/**
 * 积木描述 API —— 把「契约 + 参数」合成一份可查询的描述。
 *
 * ================= 为什么要有这个文件 =================
 *
 * `engine/nodeSpec.ts` 只回答"产出什么、能吃下什么"，参数那一半
 * 在 `nodes/defs/*.tsx` 的 `fields` 里 —— 那是 JSX，纯 Node 环境读不了。
 *
 * 此前缺的就是这一环：AI（或任何调用方）拿到契约却拿不到参数，
 * 拼装时只能手工猜字段名。
 *
 * 这里把两半合起来。**刻意不 import 任何 tsx**：
 *   - `deriveParams` 接受一个**普通的字段数组**（调用方从哪来都行），
 *     所以它能在纯 Node 下跑、能被单测
 *   - React 侧（能 import tsx）把真实的 `FieldDef[]` 传进来即可
 *
 * ================= 与 docs/ 的关系 =================
 *
 * docs/ 是这套 API 的**离线快照**（生成给人和 AI 翻的）；
 * 这里是**运行时接口**（永远最新）。
 *
 * 两者共用 deriveParams 的聚合逻辑 —— 生成器 import 这个函数，
 * 所以"文档里的参数表"和"运行时查到的参数表"不可能对不上。
 */

import {
  SPECS, specOf, TEMPLATE_VARS, CAPABILITY_SIGNATURES,
  EDGE_SHAPE, BRANCH_EDGE_EXAMPLE, type NodeSpec,
} from './nodeSpec';

/**
 * 字段的最小形状。
 *
 * 只取描述参数用得到的那些 —— 刻意**不**定义成 FieldDef 的子集类型，
 * 因为那样会要求 import tsx（JSX 在纯 Node 下加载不了）。
 */
export type FieldLike = {
  type: string;
  key?: string | null;
  label?: string | null;
  placeholder?: string | null;
  hint?: string | null;
  /** 显示条件的**文本**描述（函数本身序列化不了） */
  when?: string | null;
  /** custom 块用 spec.keys 声明的额外字段 */
  extraKeys?: string[];
  options?: { value: string; label: string; hint?: string }[];
  /** note 块：面板上写给用户的提示 */
  content?: string | null;
};

export type ParamRow = {
  key: string;
  type: string;
  label: string | null;
  hint: string | null;
  placeholder: string | null;
  when: string | null;
  options: string[];
  required: boolean;
};

export type BlockDesc = {
  kind: string;
  /** 产出什么 */
  produces: string;
  /** 能吃下什么 */
  accepts: string | string[];
  /** 一句话说明 */
  desc: string;
  /** 需要的外部能力（RunOptions 的键） */
  requires: string[];
  /** 各能力的调用签名 */
  signatures: Record<string, string>;
  /** 不在 fields 里、因此派生不出来的参数 */
  hiddenParams: { key: string; desc: string; options?: string[] }[];
  /** 从 fields 派生的参数；没给 fields 时为空 */
  params: ParamRow[];
  /** 面板上的提示（note 块） */
  notes: string[];
  /**
   * 参数是否来自 fields。
   * false 表示这份描述**不完整** —— 调用方应去读源文件。
   */
  paramsFromFields: boolean;
};

/**
 * 把字段摊平成参数表。
 *
 * **按 key 聚合**而不是"见到就记"：custom 块只有 spec.keys、没有 label，
 * 而同一个 key 常在后面的块里才有真正的 label / hint
 * （translate 的 sourceLang 就是）。先到先得会让整张表退化成一列光秃秃的 key。
 */
export type DerivedParams = {
  rows: ParamRow[];
  /** 面板上的提示（note 块）；常含"这个节点做不到什么"这类关键信息 */
  notes: string[];
};

export function deriveParams(fields: FieldLike[]): DerivedParams {
  const agg = new Map<string, ParamRow>();
  const notes: string[] = [];

  for (const f of fields ?? []) {
    if (f.type === 'note') {
      if (f.content) notes.push(f.content);
      else if (f.hint) notes.push(f.hint);
      continue;
    }
    /*
     * 不用类型谓词 `(k): k is string` —— strip-ts.py 处理不了，
     * 会把后半段截掉，生成的 .mjs 直接语法错误。
     */
    const raw: (string | null | undefined)[] = [f.key, ...(f.extraKeys ?? [])];
    const keys: string[] = [];
    for (const r of raw) {
      if (typeof r === 'string' && r.length > 0) keys.push(r);
    }
    for (const k of keys) {
      const cur = agg.get(k) ?? {
        key: k,
        type: f.type,
        label: null,
        hint: null,
        placeholder: null,
        when: f.when ?? null,
        options: [],
        required: false,
      };
      /*
       * 优先用非 custom 的块：custom 是"手写面板"的逃生口，
       * 它说不出字段语义（只有 spec.keys）。
       */
      if (cur.type === 'custom' && f.type !== 'custom') cur.type = f.type;
      cur.label ??= f.label ?? null;
      cur.hint ??= f.hint ?? null;
      cur.placeholder ??= f.placeholder ?? null;
      cur.when ??= f.when ?? null;
      if (f.options?.length && cur.options.length === 0) {
        cur.options = f.options.map((o) => o.value);
      }
      agg.set(k, cur);
    }
  }

  const rows = [...agg.values()];
  for (const r of rows) {
    // custom 说不出语义，给个兜底说明，免得参数表里出现一片空白
    if (r.type === 'custom' && !r.hint && !r.label) {
      r.hint = '由手写面板渲染（通常带上游变量插入按钮）';
    }
  }
  return { rows, notes };
}

/**
 * 描述一个积木。
 *
 * `fields` 可选 —— 传了就带上完整参数表，不传只给契约侧的信息。
 * 纯 Node 环境下读不到 tsx，所以那时只能给后者；
 * React 侧能拿到真实的 FieldDef[]，喂进来就是完整版。
 */
export function describeBlock(kind: string, fields?: FieldLike[]): BlockDesc | null {
  const spec: NodeSpec | undefined = specOf(kind) ?? SPECS[kind];
  if (!spec) return null;

  const requires = spec.requires ?? [];
  const signatures: Record<string, string> = {};
  for (const r of requires) {
    const sig = CAPABILITY_SIGNATURES[r];
    if (sig) signatures[r] = sig;
  }

  const derived = fields ? deriveParams(fields) : { rows: [], notes: [] };
  /*
   * 这里用手写的 params（契约里声明的）而不是派生的 ——
   * manualParams 表示"这个节点的参数读不出来，只能手写"。
   */
  let params: ParamRow[] = derived.rows;
  if (spec.manualParams) {
    params = [];
    for (const p of spec.params ?? []) {
      params.push({
        key: p.key,
        type: '—',
        label: null,
        hint: p.desc ?? null,
        placeholder: null,
        when: null,
        options: p.options ?? [],
        required: !!p.required,
      });
    }
  }

  return {
    kind,
    produces: spec.produces,
    accepts: spec.accepts,
    desc: spec.producesDesc ?? '',
    requires,
    signatures,
    hiddenParams: (spec.hiddenParams ?? []).map((p) => ({
      key: p.key,
      desc: p.desc ?? '',
      options: p.options,
    })),
    params,
    notes: derived.notes,
    paramsFromFields: !spec.manualParams,
  };
}

/** 全部积木的契约（不含参数 —— 参数要传 fields 才有） */
export function describeAll(): { kind: string; produces: string; accepts: string | string[]; desc: string }[] {
  return Object.entries(SPECS).map(([kind, s]) => ({
    kind,
    produces: s.produces,
    accepts: s.accepts,
    desc: s.producesDesc ?? '',
  }));
}

/**
 * 拼装时容易踩的几条全局约定。
 *
 * 刻意**不写返回类型注解**：多行的对象类型注解 strip-ts.py 处理不了
 * （会把 `{` 后面的内容截断，生成的 .mjs 直接语法错误）。
 * 靠 TS 推断，调用方拿到的形状是一样的。
 */
export function conventions() {
  return {
    templateVars: TEMPLATE_VARS,
    edgeShape: EDGE_SHAPE,
    branchEdgeExample: BRANCH_EDGE_EXAMPLE,
    capabilitySignatures: CAPABILITY_SIGNATURES,
  };
}
