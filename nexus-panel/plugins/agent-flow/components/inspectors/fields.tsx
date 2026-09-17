import type { ReactNode } from 'react';
import { getDef } from '../../nodes';
import type { FlowNode, FlowEdge } from '../../flowTypes';
import type { Credential } from '../../engine/credentials';
import type { SecretPolicy } from '../../types';
// 从 engine/files 直接拿，不绕 shared：shared 只是转手 import 进来用，
// 并没有再导出，硬要从它拿就得让它多导出一次，平白加一层耦合
import { FILE_FIELD_HINT } from '../../engine/files';
import { shouldDetach, detachGroup } from '../../engine/paramCards';
// 从 registry 拿 getCardGroup，不能走 nodes/index（会与 defs 成环）
import { getCardGroup } from '../../nodes/registry';
import { CredentialPicker } from './shared';
import SaveAsCustom from './SaveAsCustom';
import { ParamCardPicker } from './ParamCardPicker';

/**
 * 属性面板的**字段描述层**。
 *
 * 这是"新增节点更省事"的主力：节点不需要写 JSX，只要声明自己有哪些字段、
 * 每个字段是什么类型、有哪些选项，基础面板（BasicInspector）就会渲染出来。
 *
 * 为什么做成描述而不是全手写 JSX：
 *  仓库里 12 个节点的面板有大量完全一样的样板 —— 标题行、label+input 的
 *  字段容器、onChange 里取 e.target.value、hint 小字、条件显隐。
 *  逐字抄写时，任何一个字段的 onChange 写错 key（比如写成 d.branch 却 patch
 *  了 branchName）编译器都发现不了，因为两边都是字符串。
 *  描述化之后，渲染只认 `key` 一处，这类错位从根上不会发生。
 *
 * 为什么**不**把条件/循环/触发器这类复杂面板也描述化：
 *  它们有大量"不是字段"的交互（规则拖拽排序、实时校验、算子切换改变后续
 *  字段）。硬塞进描述会让描述格式膨胀到与手写 JSX 同等的复杂度，
 *  却失去类型检查和调试能力。这类节点用 type:'custom' 的 render 逃生口，
 *  内部再用本文件的 <Field> 控件拼 —— 即"主 A 副 B"。
 */

export type FieldOption = { value: string; label: string; hint?: string; color?: string };

export type FieldType =
  | 'text' // 单行输入
  | 'textarea' // 多行
  | 'number'
  | 'select' // 下拉
  | 'switch' // 勾选
  | 'chips' // 按钮组（如目标语言）
  | 'credential' // 凭据选择（同时写 token 与 credentialId）
  | 'paramCard' // 参数卡片：一组字段存成卡片，点一下整套套用
  | 'note' // 纯提示文本，不占字段
  | 'custom'; // 逃生口：完全自己渲染

/** 渲染单个字段时拿到的一切 */
export type FieldRenderProps = {
  /** 整个节点 data */
  d: Record<string, unknown>;
  value: unknown;
  /** 改本字段（key 由描述提供，调用方不会写错） */
  onChange: (v: unknown) => void;
  /** 改多个字段。凭据选择器要同时写 token 与 credentialId，故需要这个 */
  patch: (p: Record<string, unknown>) => void;
  node: FlowNode;
  edges: FlowEdge[];
  /** 上游节点 id 列表，用于拼 {{xxx.output}} 之类的插入按钮 */
  upstream: string[];
  credentials?: Credential[];
  onOpenCredentials?: (kind: string) => void;
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
};

export type FieldDef = {
  /** 存储用的字段名。note 类型不需要 */
  key?: string;
  /**
   * 标签文字。给函数是为了让它随其它字段变化 ——
   * 数据提取节点的第二个参数在不同模式下叫"路径"/"正则"/"行规则"，
   * 写死一个名字会让另外几种模式看不懂。
   */
  label?: string | ((d: Record<string, unknown>) => string);
  type: FieldType;
  /** 占位提示。同样支持随数据变化 */
  placeholder?: string | ((d: Record<string, unknown>) => string);
  /** 字段下方的小字说明。给函数是为了让说明随其它字段变化 */
  hint?: ReactNode | ((d: Record<string, unknown>) => ReactNode);
  /** select/chips 的选项；给函数是为了让选项随其他字段动态变化 */
  options?: FieldOption[] | ((d: Record<string, unknown>) => FieldOption[]);
  /** 条件显隐：返回 false 时该字段不渲染 */
  when?: (d: Record<string, unknown>) => boolean;
  /** 显示值 ↔ 存储值的转换。例：'auto' 在界面上显示为空 */
  toUI?: (v: unknown) => unknown;
  fromUI?: (v: unknown) => unknown;
  rows?: number;
  min?: number;
  max?: number;
  step?: number;
  /** 标签在左、控件在右。默认标签在上（.field 列式） */
  inline?: boolean;
  /** credential 类型用：决定需要哪些能力的凭据 */
  credentialKind?: string;

  /* ---- paramCard 类型用 ---- */
  /** 卡片组名。同组卡片跨节点类型共享，如 'github-repo' */
  cardGroup?: string;
  /** 这张卡片管辖的字段名。改这些字段会自动脱钩 */
  cardKeys?: string[];
  /** 卡片上显示的摘要文字，如 "acme/web" */
  cardSummary?: (values: Record<string, unknown>) => string;
  /** 新建卡片时的默认名字 */
  cardName?: string;
  /** note 的内容 / custom 的渲染函数 */
  render?: (p: FieldRenderProps) => ReactNode;
  content?: ReactNode;
  /**
   * custom 字段管着哪些参数。
   *
   * custom 是一段手写 JSX，从 FieldDef 上**看不出**它读写了哪些 key ——
   * AI 扫 fields 时这些参数就是黑洞。所以在这里补一句声明。
   *
   * 例：HTTP 节点的地址行是个 custom（方法下拉 + 地址输入挤在一行），
   * 它实际管着 method 与 url 两个参数。
   */
  spec?: {
    keys: string[];
    /** 参数类型，给 AI 看 */
    kind?: 'text' | 'textarea' | 'number' | 'select' | 'switch';
    /** 枚举取值 */
    options?: string[];
  };
};

/** 字段清单。给函数是为了支持 when 这类依赖当前数据的逻辑 */
export type FieldFactory = (d: Record<string, unknown>) => FieldDef[];

function optsOf(
  o: FieldDef['options'],
  d: Record<string, unknown>,
): FieldOption[] {
  return typeof o === 'function' ? o(d) : o ?? [];
}

/**
 * 取一个"可以是值也可以是函数"的字符串属性。
 *
 * 与 optsOf 同一套路：调用方不必关心拿到的是常量还是随数据变化的函数。
 * 加这个函数是因为 label / placeholder 原先只支持常量，
 * 遇到"标签要随模式变"就只能退回手写 custom 字段，白丢声明式的收益。
 */
function strOf(
  v: string | ((d: Record<string, unknown>) => string) | undefined,
  d: Record<string, unknown>,
): string | undefined {
  return typeof v === 'function' ? v(d) : v;
}

/* ------------------------------------------------------------------ */
/* 控件（副 B：复杂面板手写时也可直接取用）                              */
/* ------------------------------------------------------------------ */

/**
 * 字段外壳。
 *
 * 统一了此前并存的两套写法：老的 `.field`（标签在上）和 `.p-row` + `.p-input`
 * （标签在左）。现在一律走这里，新增节点不必再挑。
 *
 * `error` 是字段级错误说明。传了就给容器加 `.has-error`，内部输入框
 * 一起变色（见 controls.css 的"容器级错误态"）—— 校验结果往往来自
 * 汇总函数、定位不到具体 input，所以走容器级而不是逐个设 aria-invalid。
 */
export function Field({
  label, hint, inline, error, children,
}: {
  label?: string;
  hint?: ReactNode;
  inline?: boolean;
  /** 字段级错误说明；传了即进入错误态 */
  error?: string;
  children: ReactNode;
}) {
  if (inline) {
    return (
      <label className={'p-row' + (error ? ' has-error' : '')}>
        {label ? <span className="p-muted" style={{ width: 64, flex: 'none' }}>{label}</span> : null}
        {children}
        {hint ? <small className="dim" style={{ flexBasis: '100%' }}>{hint}</small> : null}
        {error ? <small className="nx-field-error" style={{ flexBasis: '100%' }}>{error}</small> : null}
      </label>
    );
  }
  return (
    <label className={'field' + (error ? ' has-error' : '')}>
      {label ? <span>{label}</span> : null}
      {children}
      {hint ? <small className="dim">{hint}</small> : null}
      {error ? <small className="nx-field-error">{error}</small> : null}
    </label>
  );
}

/** VarBar 里一个可插入按钮 */
export type VarToken = { text: string; title?: string; file?: boolean };

/**
 * 生成"上游输出"的可插入 token：{{上游id.output}}。
 *
 * 抽出来是因为这段逻辑此前在任务 / OCR / 翻译三处各写了一遍，
 * 只是字段名不同。抄写时最容易出的错是：改了模板语法（比如加前缀）
 * 却漏掉其中一处，于是某个节点的插入按钮变废按钮 —— 点了插进去不生效。
 * 统一生成后，这类改动只需动这一个函数。
 *
 * @param upstream 上游节点 id 列表
 * @param extra    追加的固定 token，如 '{{input}}'
 */
export function upstreamTokens(upstream: string[], extra: string[] = []): VarToken[] {
  return [
    ...upstream.map((u) => ({ text: `{{${u}.output}}` })),
    ...extra.map((text) => ({ text })),
  ];
}

/**
 * 生成"上游改动文件"的 token：{{id.file}} / {{id.fileName}}。
 *
 * 与 upstreamTokens 分开：只有任务节点会产出文件改动，
 * 给所有节点都挂这两个按钮是噪声。
 */
export function upstreamFileTokens(upstream: string[]): VarToken[] {
  return [
    ...upstream.map((u) => ({
      text: `{{${u}.file}}`,
      file: true,
      title: FILE_FIELD_HINT.file,
    })),
    ...upstream.map((u) => ({
      text: `{{${u}.fileName}}`,
      file: true,
      title: FILE_FIELD_HINT.fileName,
    })),
  ];
}

/** 一行"可引用"插入按钮。复杂面板手写时也能用 */
export function VarBar({ title, tokens, onInsert }: {
  title?: string;
  tokens: Array<{ text: string; title?: string; file?: boolean }>;
  onInsert: (token: string) => void;
}) {
  if (tokens.length === 0) return null;
  return (
    <div className="var-bar">
      {title ? <small>{title}</small> : null}
      {tokens.map((t) => (
        <button
          key={t.text}
          className={'chip' + (t.file ? ' file' : '')}
          title={t.title}
          onClick={() => onInsert(t.text)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 渲染器（主 A）                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param i 字段在清单里的原始下标，用作 key 的兜底。
 *
 * 这里原先写的是 `key={f.key ?? Math.random()}` —— 每次渲染生成一个新的
 * 随机数，React 于是认为这是个全新元素，当场卸载重建。custom 字段里若套了
 * <input>/<select>（任务节点的 FileParamsPanel 就有），输一个字失焦一次。
 * 没有 key 的自定义字段只能拿下标兜底：字段顺序在该节点内是固定的，
 * 下标因此在重渲染之间稳定。
 */
function renderField(
  f: FieldDef,
  p: FieldRenderProps & { id: string; onChangeNode: (patch: Record<string, unknown>) => void },
  i = 0,
) {
  const { type } = f;

  if (type === 'note') {
    return <div className="tip" key={f.key ?? `note-${i}`}>{f.content ?? f.render?.(p)}</div>;
  }
  if (type === 'custom') {
    return <div key={f.key ?? `custom-${i}`}>{f.render?.(p)}</div>;
  }
  if (type === 'credential') {
    return (
      <CredentialPicker
        key={f.key}
        nodeKind={f.credentialKind ?? ''}
        value={String(p.d.token ?? '')}
        credentialId={String(p.d.credentialId ?? '')}
        credentials={p.credentials ?? []}
        onOpenCredentials={p.onOpenCredentials}
        onChange={p.onChangeNode}
      />
    );
  }

  if (type === 'paramCard') {
    /*
     * 保留作为逃生口：绝大多数节点走 meta.cardGroups 自动渲染即可，
     * 需要特殊布局时才在 fields 里手写这一段。
     * 组的 keys / summary 一律从卡片组定义取，不再由字段重复声明 ——
     * 两处都能声明的话，改一处忘另一处就会出现"面板显示的卡片名
     * 与拖上去套用的字段不是一回事"。
     */
    const group = f.cardGroup ?? '';
    const gd = getCardGroup(group);
    const cardHint = typeof f.hint === 'function' ? f.hint(p.d) : f.hint;
    return (
      <div className="field" key={`pc-${group}`}>
        <span>{strOf(f.label, p.d) || gd?.label || '参数卡片'}</span>
        <ParamCardPicker
          group={group}
          d={p.d}
          patch={p.onChangeNode}
          defaultName={f.cardName ?? gd?.name}
        />
        {cardHint ? <small className="dim">{cardHint}</small> : null}
      </div>
    );
  }

  const value = f.toUI ? f.toUI(p.value) : p.value;
  const set = (raw: unknown) => p.onChange(f.fromUI ? f.fromUI(raw) : raw);
  const body = () => {
    switch (type) {
      case 'textarea':
        return (
          <textarea
            className="p-input"
            rows={f.rows ?? 4}
            value={String(value ?? '')}
            placeholder={strOf(f.placeholder, p.d)}
            onChange={(e) => set(e.target.value)}
          />
        );
      case 'number':
        return (
          <input
            className="p-input"
            type="number"
            value={value === undefined || value === null ? '' : String(value)}
            min={f.min}
            max={f.max}
            step={f.step}
            placeholder={strOf(f.placeholder, p.d)}
            onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        );
      case 'select':
        return (
          <select
            className="p-input"
            value={String(value ?? '')}
            onChange={(e) => set(e.target.value)}
          >
            {optsOf(f.options, p.d).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        );
      case 'switch':
        return (
          <span className="check">
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />
            <span>{strOf(f.placeholder, p.d) ?? ''}</span>
          </span>
        );
      case 'chips':
        return (
          <div className="var-bar">
            {optsOf(f.options, p.d).map((o) => (
              <button
                key={o.value}
                className={'chip' + (value === o.value ? ' file' : '')}
                title={o.hint}
                onClick={() => set(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        );
      default:
        return (
          <input
            className="p-input"
            value={String(value ?? '')}
            placeholder={strOf(f.placeholder, p.d)}
            onChange={(e) => set(e.target.value)}
          />
        );
    }
  };

  const hint = typeof f.hint === 'function' ? f.hint(p.d) : f.hint;
  return (
    <Field key={f.key} label={strOf(f.label, p.d)} hint={hint} inline={f.inline}>
      {body()}
    </Field>
  );
}

/**
 * 基础属性面板。
 *
 * 标题行（可改名 + 节点类型标签）是每个节点都有的，这里统一渲染，
 * 节点定义只需要给 fields。
 */
export function BasicInspector({
  node, edges, onChange, credentials, onOpenCredentials,
  secretPolicy, onChangeSecretPolicy, fields, footer, onEditModule,
}: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  credentials?: Credential[];
  onOpenCredentials?: (kind: string) => void;
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
  fields: FieldFactory;
  /** 追加在字段之后的自定义内容（如 OCR 的"测试"按钮） */
  footer?: (p: FieldRenderProps) => ReactNode;
  /** 进入模块实例的内部编辑 */
  onEditModule?: (nodeId: string) => void;
}) {
  const d = node.data as unknown as Record<string, unknown>;
  const def = getDef(node.type);
  const upstream = edges.filter((e) => e.target === node.id).map((e) => e.source);

  /*
   * 参数卡片是**通用能力**：节点只需在 meta.cardGroups 里声明"我支持哪些组"，
   * 这里就自动渲染出对应的选择器，不必在 fields 里写任何东西。
   *
   * 与拖放校验共用同一份 meta.cardGroups —— 面板上有选择器的组，
   * 才接受把该组卡片拖到节点上。反过来若两边各写一份，
   * 就会出现"面板有选择器但拖放被拒"这类不一致。
   */
  const cardGroups = (def.meta.cardGroups ?? [])
    .map((g) => getCardGroup(g))
    .filter((g): g is NonNullable<typeof g> => g !== null);

  const patchObj = (p: Record<string, unknown>) => {
    let merged = p;
    for (const g of cardGroups) {
      if (shouldDetach(p, g.keys)) merged = { ...merged, ...detachGroup(d, g.group) };
    }
    onChange(node.id, merged);
  };

  const base: FieldRenderProps = {
    d,
    value: undefined,
    onChange: () => {},
    patch: patchObj,
    node,
    edges,
    upstream,
    credentials,
    onOpenCredentials,
    secretPolicy,
    onChangeSecretPolicy,
  };

  /*
   * 带上过滤前的原始下标：when 条件隐藏某个字段时，后面字段的下标不该平移。
   * 平移会让 React 把 key 对到另一个字段上，造成"输到一半的内容跳到别的框"。
   */
  const list = fields(d)
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => (f.when ? f.when(d) : true));

  return (
    <aside className="inspector">
      <div className="insp-title">
        <input
          className="title-input"
          value={String(d.label ?? '')}
          onChange={(e) => onChange(node.id, { label: e.target.value })}
        />
        <span className="insp-kind">{def.meta.label}</span>
        {/*
         * 模块节点的编辑入口。
         * 放在标题行而不是字段区：进内部编辑是"整个节点层面"的动作，
         * 混在字段里会被当成一个普通参数。
         */}
        {node.type === 'module' && onEditModule ? (
          <button
            className="link-btn"
            title="编辑这个模块的内部结构（改完会脱钩成独立副本）"
            onClick={() => onEditModule(node.id)}
          >
            编辑内部
          </button>
        ) : (
          <SaveAsCustom node={node} />
        )}
      </div>

      {list.map(({ f, i }) =>
        renderField(
          f,
          {
            ...base,
            value: f.key ? d[f.key] : undefined,
            onChange: (v) => f.key && onChange(node.id, { [f.key]: v }),
            // renderField 的凭据分支要用 onChangeNode（type:'credential' 的字段），
            // custom 渲染的作者也可能读 id。少了这两个，点凭据选择器会撞 undefined。
            id: node.id,
            onChangeNode: patchObj,
          },
          i,
        ),
      )}

      {cardGroups.map((g) => (
        <div className="field" key={`pc-${g.group}`}>
          <span>{g.label}</span>
          <ParamCardPicker group={g.group} d={d} patch={patchObj} defaultName={g.name} />
          <small className="dim">
            存成卡片后可一键套用，也能直接拖到画布上的节点；改上面的字段会自动脱钩
          </small>
        </div>
      ))}

      {footer ? footer(base) : null}
    </aside>
  );
}

/**
 * 缓存表：同一份 (fields, footer) 只造一次组件。
 *
 * 不缓存会怎样（这是个真实的坑，别删掉缓存）：
 * inspectorOf() 在 Inspector.tsx 的**每次渲染**里被调用，它转手调本函数。
 * 本函数若每次 return 一个新的函数组件，React 协调时看到
 * <Panel /> 的 type 引用变了 —— 它比较元素类型用的是 `===` —— 于是判定
 * 这是另一种组件：把整棵子树卸载再重新挂载。
 *
 * 后果是每次重渲染（哪怕只是父组件 setState）都：
 *   - <input> 被销毁重建 → 光标丢失，打一个字失焦一次
 *   - <select> 被销毁重建 → 下拉刚展开就被关掉，选不了值
 *   - 子树里的 useState 全部重置
 * 用户看到的就是"下拉框一出来就消失""点了光标就没"，很像失焦，
 * 其实是组件在反复重挂载。
 *
 * 只有走 fields 自动生成面板的节点会中招 —— 写了自定义 Inspector 的节点
 * 返回的是节点定义模块顶层的稳定引用，不会变。
 *
 * 外层用 WeakMap（键是节点定义里的 fields 函数）：节点若将来支持动态
 * 卸载，函数对象被回收时缓存条目也跟着走，不会泄漏。
 */
type InspectorComponent = (props: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  credentials?: Credential[];
  onOpenCredentials?: (kind: string) => void;
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
}) => JSX.Element;

const inspectorCache = new WeakMap<FieldFactory, Map<unknown, InspectorComponent>>();

/** 把字段清单包成一个面板组件，供节点定义直接用 */
export function makeInspector(
  fields: FieldFactory,
  footer?: (p: FieldRenderProps) => ReactNode,
): InspectorComponent {
  let byFooter = inspectorCache.get(fields);
  if (!byFooter) {
    byFooter = new Map();
    inspectorCache.set(fields, byFooter);
  }
  const cached = byFooter.get(footer);
  if (cached) return cached;

  const Inspector: InspectorComponent = (props) => (
    <BasicInspector {...props} fields={fields} footer={footer} />
  );
  byFooter.set(footer, Inspector);
  return Inspector;
}
