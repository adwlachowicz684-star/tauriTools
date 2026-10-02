/**
 * FieldDef → FieldLike 的转换 + 契约里"接受侧"的可读化。
 *
 * ================= 为什么抽出来 =================
 *
 * 这两件都是**纯逻辑**，但原先写在 NodeDesc.tsx 里。
 * 那个文件有 JSX，测试环境跑不了，于是这两段就完全没有测试覆盖。
 *
 * 而它们恰恰是最容易出错的地方：FieldDef 的 label / hint / options
 * 都允许是函数，漏处理一种就会显示 `[object Object]` ——
 * **不报错，只是界面上出现一串垃圾**。
 */

import type { FieldLike } from './blockApi';
import { PORT_LABEL, type PortKind } from './nodeSpec';

/*
 * 断言用的函数类型**必须写成类型别名**，不能内联在表达式里。
 *
 * 写成先取到变量再调用，而不是内联断言后直接调用
 * 时会把箭头函数的返回类型当成函数体边界，剥出
 * `(v ) => unknown)(data)` —— 生成的 .mjs 直接语法错误。
 * 这是这个脚本的第九个坑。
 */
type EvalFn = (d: Record<string, unknown>) => unknown;

/*
 * 同理，内联的**对象**类型注解也剥不干净：
 * `let options: { value: string; label: string }[] | undefined;`
 * 会被剥成 `let options; label: string }[] | undefined;` ——
 * 分号让脚本误判语句边界，留下的残片直接让后面语法错乱。
 * 这是这个脚本的第十个坑。
 */
type OptLike = { value: string; label: string };

/**
 * 把可能是函数的值就地求值成字符串。
 *
 * 求不出来（比如 hint 直接写的是 JSX 元素）返回 null ——
 * 显示 `[object Object]` 比什么都不显示糟糕得多。
 */
function pickText(v: unknown, data: Record<string, unknown>): string | null {
  if (typeof v === 'function') {
    try {
      const r = (v as EvalFn)(data);
      return typeof r === 'string' ? r : null;
    } catch {
      /*
       * 某些 label 函数会读 data 里的深层字段，探针数据造不全时可能抛。
       * 这里吞掉：少一条说明好过整个说明块崩掉。
       */
      return null;
    }
  }
  return typeof v === 'string' ? v : null;
}

/*
 * spec 的形状。**必须写成类型别名**：内联的对象类型注解会被本仓的
 * TS→mjs 脚本剥坏（见本文件顶部那两处同类坑）。
 */
type SpecLike = { keys?: unknown };

/**
 * custom 块声明的额外键。
 *
 * ================= 来源只有一个：FieldDef 上的 spec.keys =================
 *
 * custom 是"手写一段 JSX"的逃生口，它读写哪些键从外面看不出来，
 * 只能靠 spec.keys 声明（engine/nodeSpec.ts 的 deriveParams 就是这么取的）。
 *
 * 本函数以前读的是 `f.extraKeys` —— 而**全仓库没有任何一个节点定义写过
 * extraKeys**（只有测试里手写过）。于是契约侧的参数表把 custom 块声明的
 * 键**全丢了**：侧栏说明里 HTTP 节点不显示 url / method，
 * 而 url 是它唯一真正的必填参数 ——
 * "挑节点时看到的说明"里偏偏没有最该填的那一项，且全程不报错。
 *
 * 更麻烦的是测试喂的是 extraKeys 这个真实代码里不存在的字段，
 * 于是两千多条测试一路全绿 —— 测试与实现各说一份，
 * 谁也没发现另一边是空的。
 */
function specKeysOf(f: Record<string, unknown>): string[] | undefined {
  const spec = f.spec as SpecLike | undefined;
  const keys = spec ? spec.keys : undefined;
  if (!Array.isArray(keys)) return undefined;
  const out: string[] = [];
  for (const k of keys) {
    if (typeof k === 'string' && k.length > 0) out.push(k);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 转成 deriveParams 认的形状。
 *
 * @param list 节点的 fields(data) 结果
 * @param data 当前数据 —— label/hint/options 的函数要喂它才知道现在叫什么
 */
export function fieldLikeOf(
  list: unknown[],
  data: Record<string, unknown>,
): FieldLike[] {
  const out: FieldLike[] = [];
  for (const raw of list ?? []) {
    const f = raw as Record<string, unknown>;
    if (!f || typeof f !== 'object') continue;

    let options: OptLike[] | undefined;
    const rawOpts = f.options;
    const resolved = typeof rawOpts === 'function'
      ? (rawOpts as EvalFn)(data)
      : rawOpts;
    if (Array.isArray(resolved)) {
      options = [];
      for (const o of resolved) {
        const oo = o as Record<string, unknown>;
        const value = String(oo?.value ?? '');
        // 没 value 的选项在列表里点了没反应，直接丢掉
        if (!value) continue;
        options.push({ value, label: String(oo?.label ?? value) });
      }
    }

    out.push({
      type: String(f.type ?? ''),
      key: typeof f.key === 'string' ? f.key : null,
      label: pickText(f.label, data),
      placeholder: pickText(f.placeholder, data),
      hint: pickText(f.hint, data),
      /*
       * when 是函数，文本描述推导不出来 —— 给 null。
       * 不猜：猜错的显示条件比不显示更误导。
       */
      when: null,
      /*
       * spec.keys 优先 —— 它是唯一真实来源。
       * 退回 f.extraKeys 只为兼容直接喂 FieldLike 的调用方（测试就是）。
       */
      extraKeys: specKeysOf(f)
        ?? (Array.isArray(f.extraKeys)
          ? (f.extraKeys as unknown[]).map((k) => String(k))
          : undefined),
      options,
      content: typeof f.content === 'string' ? f.content : null,
    });
  }
  return out;
}

/**
 * "接受什么"的可读文本。
 *
 * 'any' / 'none' 与数组是三种不同形状，直接 String() 会把
 * 数组渲染成 `text,json` 这种原始值。
 */
/*
 * 入参故意放宽到 string | string[]：BlockDesc.accepts 的类型是
 * `string | string[]`（契约里 'any' / 'none' 与 Accepts 混在一起），
 * 而这里是**只读**用途，不需要区分。
 */
export function acceptsTextOf(a: string | string[] | undefined | null): string {
  if (a === 'any') return '任何';
  if (a === 'none') return '（无需输入）';
  if (!Array.isArray(a)) return String(a ?? '');
  if (a.length === 0) return '（无需输入）';
  return a.map((k) => PORT_LABEL[k as PortKind] ?? String(k)).join(' / ');
}
