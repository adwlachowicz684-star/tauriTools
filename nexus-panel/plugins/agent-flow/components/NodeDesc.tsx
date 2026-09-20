import { useMemo } from 'react';
import { getDef } from '../nodes';
import { describeBlock, pickBrief, type FieldLike, type BlockDesc } from '../engine/blockApi';
import { fieldLikeOf, acceptsTextOf } from '../engine/fieldLike';
import { PORT_LABEL, type PortKind } from '../engine/nodeSpec';

/**
 * 侧栏里点开节点的**结构化说明**。
 *
 * ================= 为什么不再只用一句话 =================
 *
 * 以前展开只有 `def.meta.sub`（一句副标题）+ "按住 Ctrl 点击添加"。
 * 而节点能不能用，取决于三件那句话里没有的事：
 *   1. 产出 / 接受什么 —— 决定它能跟谁连
 *   2. 需要哪些外部能力 —— 浏览器模式下缺了会直接失败
 *   3. 参数里哪些是必填 —— 漏一个就跑不起来
 *
 * 这三样数据源**都已经有了**（契约 SPECS + 各节点的 fields），
 * 之前只是没接到界面上。这里负责接。
 *
 * ================= 与文档 / 运行时 API 共用一份逻辑 =================
 *
 * 参数表走 engine/blockApi 的 deriveParams，与
 * `docs/nodes/<kind>.params.md`（生成脚本）和 `describeBlock`（运行时 API）
 * **同一个函数** —— 否则界面上看到的和 AI 查到的会不一样。
 */

type Props = {
  /** 预设 key（拖拽载荷里传的那个） */
  presetKey: string;
  /** 节点类型 */
  type: string;
  /** 预设自带的说明；有则优先于契约里的 */
  hint?: string;
  /** 一句话副标题（兜底） */
  sub?: string;
  /** 折叠时也要显示的那行短说明由调用方处理，这里只管展开区 */
};

/**
 * 取这个预设的说明。
 *
 * 两步才拿得到完整信息：
 *   1. `def.create()` 造一份默认数据 —— 很多 fields 的 label/hint 是函数，
 *      要喂数据才知道它现在叫什么（提取节点在不同模式下第二个参数
 *      分别叫"路径"/"正则"/"行规则"）
 *   2. `def.fields(data)` 拿到字段清单
 */
function usePresetDesc(type: string): { desc: BlockDesc | null; dataKind: string } {
  return useMemo(() => {
    const def = getDef(type);
    let data: Record<string, unknown> = {};
    try {
      data = (def.create?.('__probe__') ?? {}) as Record<string, unknown>;
    } catch {
      /*
       * 少数节点的 create 需要额外上下文（如模块节点要 moduleId）。
       * 造不出来就用空对象 —— 字段的 label/hint 会退化，
       * 但总比整个说明块崩掉好。
       */
      data = {};
    }

    const dataKind = String((data as { kind?: unknown }).kind ?? type);

    let fields: FieldLike[] | undefined;
    if (typeof def.fields === 'function') {
      try {
        fields = fieldLikeOf(def.fields(data), data);
      } catch {
        fields = undefined;
      }
    }

    // dataKind 优先，退回 type（少数节点两者不一致）
    const desc = describeBlock(dataKind, fields) ?? describeBlock(type, fields);
    return { desc, dataKind };
  }, [type]);
}

export default function NodeDesc({ presetKey, type, hint, sub }: Props) {
  const { desc } = usePresetDesc(type);

  if (!desc) {
    /*
     * 没有契约的节点（模块、MCP 生成节点等）仍要显示点什么 ——
     * 展开后一片空白会让人以为界面坏了。
     */
    return (
      <div className="side-desc">
        <div className="nd-line">{hint || sub || '这个节点没有额外说明'}</div>
        <span className="side-desc-add">按住 Ctrl / ⌘ 点击添加</span>
      </div>
    );
  }

  /*
   * 与侧栏那行短说明**同一个函数、同一套来源** ——
   * 各排各的序会出现"点开与不点开看到两句话"。
   */
  const one = pickBrief({ hint, sub, produces: desc.desc });

  // 必填优先，其次按声明顺序；最多列 8 条，多了侧栏放不下
  const rows = [...desc.params].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return 0;
  });
  const shown = rows.slice(0, 8);
  const rest = rows.length - shown.length;

  return (
    <div className="side-desc nd">
      {one ? <div className="nd-line">{one}</div> : null}

      <div className="nd-ports">
        <span className="nd-port">
          <span className="nd-port-k">产出</span>
          {PORT_LABEL[desc.produces as PortKind] ?? desc.produces}
        </span>
        <span className="nd-port">
          <span className="nd-port-k">接受</span>
          {acceptsTextOf(desc.accepts)}
        </span>
      </div>

      {/*
       * 产出说明有它自己的位置。
       *
       * 以前它顶在第一行当"节点说明"用（因为 desc.desc 排得比 sub 前），
       * 于是"循环"的说明写着"透传（循环体每轮一次…）"——
       * 那是产出，不是用途，挑节点时看这句只会更糊涂。
       */}
      {desc.desc ? <div className="nd-out">{desc.desc}</div> : null}

      {desc.requires.length > 0 ? (
        <div className="nd-req">
          <span className="nd-port-k">需要</span>
          {desc.requires.map((r) => (
            <span key={r} className="nd-cap" title={desc.signatures[r] || undefined}>
              {r}
            </span>
          ))}
          <span className="nd-req-note">浏览器模式下缺这些会直接失败</span>
        </div>
      ) : (
        <div className="nd-req">
          <span className="nd-cap ok">纯本地</span>
          <span className="nd-req-note">不需要外部能力，浏览器模式也能跑</span>
        </div>
      )}

      {shown.length > 0 ? (
        <div className="nd-params">
          {shown.map((r) => (
            <div key={r.key} className="nd-param">
              <span className="nd-key">{r.label || r.key}</span>
              {r.key !== r.label && r.label ? <span className="nd-raw">{r.key}</span> : null}
              {r.required ? <span className="nd-reqdot" title="必填">必填</span> : null}
              {r.hint ? <span className="nd-hint">{r.hint}</span> : null}
            </div>
          ))}
          {rest > 0 ? <div className="nd-more">…还有 {rest} 项</div> : null}
        </div>
      ) : null}

      {desc.hiddenParams.length > 0 ? (
        <div className="nd-hidden">
          <span className="nd-port-k">面板上另有</span>
          {desc.hiddenParams.map((p) => (
            <span key={p.key} className="nd-cap" title={p.desc}>
              {p.key}
            </span>
          ))}
        </div>
      ) : null}

      {/*
       * note 块常写着"这个节点做不到什么"这类关键信息
       * （如等待上限 10 分钟）。不显示的话用户会踩。
       */}
      {desc.notes.length > 0 ? (
        <div className="nd-notes">
          {desc.notes.map((n, i) => (
            <div key={i} className="nd-note">{n}</div>
          ))}
        </div>
      ) : null}

      <span className="side-desc-add">按住 Ctrl / ⌘ 点击添加 · {presetKey}</span>
    </div>
  );
}
