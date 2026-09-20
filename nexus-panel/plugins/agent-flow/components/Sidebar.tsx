import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import NodeDesc from './NodeDesc';
import { presetsByCategory, getDef, allPresets } from '../nodes';
import { hasDef } from '../nodes/registry';
import { confirm, alert, prompt } from '../../../js/dialog.js';
import {
  presetIdOf, removeCustomPreset, renameCustomPreset,
  exportCustomPresets, importCustomPresets,
} from '../engine/customPresets';
import { pickBrief, producesDescOf } from '../engine/blockApi';
import NodeTip, { type TipAnchor } from './NodeTip';

/**
 * 从边栏拖到画布上时携带的数据。
 * 用 dataTransfer 传字符串，drop 时再解析——这是 HTML5 拖放的标准做法。
 *
 * kind 存的是**预设 key**（'task' / 'task:codebuddy' / 'condition' …），
 * 不再是枚举出来的联合类型 —— 预设由注册表生成，写死联合会立刻过期
 * （以后用户自定义节点注册进来，这里不可能预先知道）。
 */
export type DragPayload = { kind: string };

export const DRAG_MIME = 'application/x-agent-flow-node';

export function encodeDrag(p: DragPayload): string {
  return JSON.stringify(p);
}

/**
 * 解析拖拽数据。
 *
 * 只校验「是个带 kind 字符串的对象」——不再维护一份类型白名单。
 * 白名单的问题是新注册的类型忘了加进来就会被静默丢弃，
 * 而真正的合法性判断在 App 那边：查不到预设就忽略，行为一致。
 */
/** 取元素在**视口**里的矩形，给浮层当锚点 */
function rectOf(el: HTMLElement): TipAnchor {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

export function decodeDrag(raw: string | null | undefined): DragPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as DragPayload;
    if (!p || typeof p.kind !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

type Props = {
  onAdd: (p: DragPayload) => void;
  disabled?: boolean;
  /**
   * MCP 节点按 server 折叠后的分组。由 App 传入 ——
   * 这一层要读注册表与存储，Sidebar 自己 import 会多一份状态。
   */
  mcpGroups?: { server: string; color: string; items: { key: string; label: string; hint?: string }[] }[];
  /** 刷新 MCP 工具清单 */
  onRefreshMcp?: () => void;
  /** 正在刷新 */
  mcpRefreshing?: boolean;
};

/**
 * 一个 MCP 服务下的所有工具。
 *
 * 默认**收起** —— 展开状态下，一个 40 工具的 server 会把侧栏撑爆，
 * 用户反而找不到别的分组。
 */
function McpServerSection({
  group, disabled, onDragStart, onItemClick, tipKey, hoverDesc,
  onHover, onHoverOut,
}: {
  group: { server: string; color: string; items: { key: string; label: string; hint?: string }[] };
  disabled?: boolean;
  onDragStart: (e: DragEvent, p: DragPayload) => void;
  onItemClick: (e: MouseEvent, p: { key: string }) => void;
  /** 当前浮层指向的条目（用它是为了给条目加高亮） */
  tipKey: string | null;
  /** 悬停说明开关（关着时不弹浮层，靠原生 title 兜底） */
  hoverDesc: boolean;
  onHover: (key: string, anchor: TipAnchor) => void;
  onHoverOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mcp-sec">
      <button
        className="mcp-sec-title"
        /*
         * 左边条用服务色 —— 与这个服务的工具在画布上的卡片同色
         * （都由 mcpColorOf(server) 得出），侧栏与画布因此能对上。
         */
        style={{ borderLeftColor: group.color }}
        onClick={() => setOpen(!open)}
        title="展开/收起这个服务的工具"
      >
        <span className="mcp-sec-name">{group.server}</span>
        <span className="mcp-sec-count">{group.items.length}</span>
        <span className="mcp-sec-arrow">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="mcp-sec-body">
          {group.items.map((it) => {
            const isOpen = tipKey === it.key;
            return (
              <div key={it.key}>
                <div
                  className={`side-item${isOpen ? ' is-open' : ''}`}
                  /* 同一 server 的工具同色，与它们在画布上的卡片一致 */
                  style={{ borderLeftColor: group.color }}
                  draggable={!disabled}
                  onDragStart={(e) => onDragStart(e, { kind: it.key })}
                  onClick={(e) => onItemClick(e, { key: it.key })}
                  onMouseEnter={(e) => onHover(it.key, rectOf(e.currentTarget))}
                  onMouseLeave={onHoverOut}
                  title={
                    hoverDesc && !disabled
                      ? undefined
                      : disabled
                        ? '运行中不可添加'
                        : `${it.hint || '这个工具没有额外说明'}｜点击查看；按住 Ctrl / ⌘ 点击添加`
                  }
                >
                  <span className="side-label">{it.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default function Sidebar({
  onAdd, disabled, mcpGroups, onRefreshMcp, mcpRefreshing,
}: Props) {
  const onDragStart = (e: DragEvent, p: DragPayload) => {
    e.dataTransfer.setData(DRAG_MIME, encodeDrag(p));
    // 同时放一份 text/plain，某些环境下自定义 MIME 会被过滤
    e.dataTransfer.setData('text/plain', encodeDrag(p));
    e.dataTransfer.effectAllowed = 'copy';
  };

  /*
   * 点击行为改了：普通点击展开说明，按住 Ctrl / ⌘ 点击才添加。
   *
   * 起因是误触 —— 侧栏条目排得很密，扫列表时随手一点就往画布里塞个节点，
   * 而画布上新增的节点往往落在视口外或压住别的节点，得手动找、再删。
   * 添加是「重操作」，不该由一个没有确认的单击触发。
   *
   * 普通点击给个有用的反馈（展开说明）而不是静默无反应：
   * 静默会让人以为界面坏了，进而反复点击，反而更容易触发误添加。
   */
  /*
   * 说明浮层的状态。
   *
   * ================= 为什么钉住态与悬停态要分开 =================
   *
   * 悬停出现的浮层，鼠标一移开就该消失 —— 否则扫列表时浮层会一直挡着。
   * 但点击打开的浮层是"我要读它"，鼠标移到浮层上去滚内容时不能消失。
   *
   * 合成一个开关的话，两者必居其一：
   * 要么悬停后浮层赖着不走，要么点开的浮层一移鼠标就没了。
   */
  const [tip, setTip] = useState<{ key: string; anchor: TipAnchor; pinned: boolean } | null>(null);

  /* 悬停延迟出现 / 移开延迟关闭。直接跟手的话扫列表会一路刷浮层 */
  const hoverTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelTimers = () => {
    if (hoverTimer.current !== null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  // 卸载时清干净：setTimeout 会活得比组件久，回调里 setTip 会打到已卸载的组件上
  useEffect(() => cancelTimers, []);

  const closeTip = () => { cancelTimers(); setTip(null); };

  const onHover = (key: string, anchor: TipAnchor) => {
    cancelTimers();
    // 开关关着时只有点击能打开 —— 掠过即弹正是扫列表时最容易被误触发的方式
    if (!hoverDesc) return;
    // 已经钉住某一条时，悬停不抢 —— 否则鼠标扫过会把在读的那条换掉
    if (tip?.pinned) return;
    hoverTimer.current = window.setTimeout(
      () => setTip({ key, anchor, pinned: false }),
      380,
    );
  };

  const onHoverOut = () => {
    cancelTimers();
    if (tip && !tip.pinned) {
      // 留一点缓冲：鼠标从条目移到浮层上的途中会短暂离开两者
      closeTimer.current = window.setTimeout(() => setTip(null), 150);
    }
  };

  const onItemClick = (e: MouseEvent, p: { key: string }) => {
    if (disabled) return;
    if (e.ctrlKey || e.metaKey) {
      onAdd({ kind: p.key });
      return;
    }
    const anchor = rectOf(e.currentTarget as HTMLElement);
    // 再点一次收起
    if (tip?.key === p.key && tip.pinned) { closeTip(); return; }
    cancelTimers();
    setTip({ key: p.key, anchor, pinned: true });
  };

  /*
   * 自定义节点是存在 localStorage 里的，增删改之后要让它重新读一次。
   * 用本地计数触发重渲染即可 —— 预设列表本来就是每次渲染时从存储现读的，
   * 不必再往上抛给 App 管一份状态。
   */
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  /*
   * 「悬停说明」开关。
   *
   * ================= 为什么不再是"在列表里铺一行" =================
   *
   * 以前点它会在**每个节点下面各铺一行**简版说明。那有两个问题：
   *   ① 列表整体变长、条目错位 —— 铺开前找到的位置全变了
   *   ② 一行 260px 放不下，说明被截断成半句，反而更想点开看
   *
   * 说明已经能悬浮显示了（见 NodeTip），所以这个开关改成：
   *   开 → 鼠标掠过条目即弹说明浮层（预览）
   *   关 → 只有点击才打开（钉住）
   *
   * 列表里因此彻底不再有内联说明 —— 位置稳定，宽度也不受侧栏限制。
   *
   * ================= 点击不受这个开关影响 =================
   *
   * 点击是明确的主动操作，"我要看这个"，不该被一个开关挡住。
   * 受它控制的只有"掠过即弹"这种**被动**触发 ——
   * 那正是扫列表时最容易被误触发的方式。
   */
  const [hoverDesc, setHoverDesc] = useState(true);

  const fileRef = useRef<HTMLInputElement | null>(null);

  const askRename = async (key: string, label: string) => {
    const id = presetIdOf(key);
    if (!id) return;
    const next = await prompt({
      title: '重命名',
      message: '只改侧栏里的显示名，画布上已放好的节点不受影响。',
      placeholder: '节点名称',
      defaultValue: label,
      validate: (v: string) => (v && v.trim() ? null : '请填个名字'),
    });
    if (!next) return;
    renameCustomPreset(id, next);
    refresh();
  };

  const askRemove = async (key: string, label: string) => {
    const id = presetIdOf(key);
    if (!id) return;
    const ok = await confirm({
      title: `删除「${label}」？`,
      message: '只删这个自定义节点。画布上已经放好的节点不受影响。',
    });
    if (!ok) return;
    removeCustomPreset(id);
    refresh();
  };

  const doExport = () => {
    const json = exportCustomPresets();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agent-flow-custom-nodes.json';
    a.click();
    // 不立刻回收：部分浏览器在 revoke 之后才真正开始下载
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const r = importCustomPresets(text, { isKnownType: (t) => hasDef(t) });
      refresh();
      const note = r.skipped.length ? `\n跳过 ${r.skipped.length} 条：${r.skipped.join('、')}` : '';
      await alert({
        title: '导入完成',
        message: `新增 ${r.added} 条，更新 ${r.updated} 条。${note}`,
      });
    } catch (err) {
      await alert({
        title: '导入失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** MCP 组：按 server 折叠，默认收起 */
  const renderMcpGroup = (label: string) => {
    const groups = mcpGroups ?? [];
    return (
      <div className="side-group" key="mcp">
        <div className="side-title">
          {label}
          <span className="side-title-ops">
            <button
              className="link-btn"
              title="重新拉取各服务的工具清单"
              onClick={() => onRefreshMcp?.()}
              disabled={mcpRefreshing}
            >
              {mcpRefreshing ? '刷新中…' : '刷新'}
            </button>
          </span>
        </div>

        {groups.length === 0 ? (
          <div className="side-empty">
            还没有节点 —— 在凭据中心配一个 MCP 服务，再点刷新
          </div>
        ) : null}

        {groups.map((sg) => (
          <McpServerSection
            key={sg.server}
            group={sg}
            disabled={disabled}
            onDragStart={onDragStart}
            onItemClick={onItemClick}
            tipKey={tip?.key ?? null}
            hoverDesc={hoverDesc}
            onHover={onHover}
            onHoverOut={onHoverOut}
          />
        ))}
      </div>
    );
  };

  /*
   * 侧栏条目、分组、配色、提示语全部来自注册表里各节点自己声明的 meta。
   *
   * 以前这里的每个条目都是手写的一段 JSX：加一种节点要在 DragPayload 联合、
   * decodeDrag 白名单、以及下面这片 UI 里各加一处，三处不同步就会出现
   * "侧栏点得出来、但拖放被 decodeDrag 判为非法而静默丢弃"。
   * 现在只有一处真相，这类不同步不可能再发生。
   */
  const groups = presetsByCategory();

  return (
    /*
     * 外壳用 .side-pane —— 模块库、画布库用同一套底板，
     * 切标签时左栏的标题、内边距、滚动方式不再变。
     */
    <aside className="side-pane" key={tick}>
      {/*
        节点库**只管节点**。
        模块库原先嵌在这里用二级 tab 切，现在提到左栏顶层与它并列 ——
        两处都能切同一件事会造成割裂：在一处切了，另一处状态不动，
        看起来像点了没反应。
      */}
      <div className="side-head">
        节点库
        <span className="side-head-spacer" />
        <button
          type="button"
          className={'side-head-btn' + (hoverDesc ? ' is-on' : '')}
          title={
            hoverDesc
              ? '关掉后，鼠标掠过不再弹说明，只有点击才打开'
              : '打开后，鼠标掠过节点即弹说明浮层'
          }
          onClick={() => setHoverDesc((v) => !v)}
        >
          {hoverDesc ? '悬停说明 开' : '悬停说明 关'}
        </button>
      </div>

      <div className="side-body">
      <div className="side-hint">
        拖到画布添加；悬停或点击看说明，按住 Ctrl / ⌘ 点击直接添加
      </div>

        {groups.map((g) => {
        const isCustom = g.category === 'custom';
        /*
         * MCP 组单独渲染：一工具一节点会让条目数直接等于工具总数，
         * 平铺的话连一个 40 工具的 server 就能把侧栏撑爆。
         * 所以按 server 再折一层，默认收起。
         */
        if (g.category === 'mcp') return renderMcpGroup(g.label);
        return (
          <div className="side-group" key={g.category}>
            <div className="side-title">
              {g.label}
              {isCustom ? (
                <span className="side-title-ops">
                  <button
                    className="link-btn"
                    title="导出全部自定义节点为 JSON，可分享给别人"
                    onClick={doExport}
                  >
                    导出
                  </button>
                  <button
                    className="link-btn"
                    title="从 JSON 导入自定义节点"
                    onClick={() => fileRef.current?.click()}
                  >
                    导入
                  </button>
                </span>
              ) : null}
            </div>

            {g.presets.map((p) => {
              const open = tip?.key === p.key;
              /*
               * 说明优先用预设自带的 hint，没有则退回节点定义里的 sub。
               *
               * 这里必须用 **p.type 自己** 的 def：
               * 以前写的是 def（= g.presets[0].type，分组第一条的），
               * 于是同组里没有 hint 的预设会显示**别的节点**的说明 ——
               * 说明张冠李戴，而它看起来完全正常，是最难发现的那一类。
               */
              const pSub = getDef(p.type).meta.sub;
              /*
               * 与展开块顶行**同一个函数**（pickBrief）——
               * 两处各排各的序会出现"点开与不点开看到两句话"。
               *
               * produces 兜底：少数节点没写 sub，那时总比整行空白好。
               */
              const desc = pickBrief({
                hint: p.hint,
                sub: pSub,
                produces: producesDescOf(p.type),
              });
              return (
                <div key={p.key}>
                  <div
                    className={`side-item${open ? ' is-open' : ''}`}
                    /*
                     * 类型色走左边条，与画布上的节点卡片同一套视觉语言。
                     * 以前这里是一个彩色圆球（.side-dot）——
                     * 圆球与边条指同一件事，两套语言并存会让人
                     * "看颜色认类型"的本能失效，得先在脑子里换算一次。
                     */
                    style={{ borderLeftColor: p.color }}
                    draggable={!disabled}
                    onDragStart={(e) => onDragStart(e, { kind: p.key })}
                    onClick={(e) => onItemClick(e, p)}
                    onMouseEnter={(e) => onHover(p.key, rectOf(e.currentTarget))}
                    onMouseLeave={onHoverOut}
                    /*
                     * 原生 title **只在浮层不会弹出时才挂**。
                     *
                     * 两者都给的话，悬停一处会同时冒两个提示：
                     * 浏览器的原生 tooltip + 我们的浮层，互相挡、还错位。
                     *
                     * 所以：
                     *   浮层会弹（开关开 且 未禁用）→ 不挂 title，一切交给浮层
                     *   否则                        → 挂 title 兜底（含那一句说明）
                     *
                     * 兜底不能省：关掉开关后浮层不弹，若 title 也没有，
                     * 说明就彻底看不见了 —— 用户会以为功能坏了。
                     */
                    title={
                      hoverDesc && !disabled
                        ? undefined
                        : disabled
                          ? '运行中不可添加'
                          : `${desc}｜点击查看完整说明；按住 Ctrl / ⌘ 点击直接添加`
                    }
                  >
                    <span className="side-label">{p.label}</span>
                    {isCustom ? (
                      <span className="side-ops">
                        <button
                          className="side-op"
                          title="重命名"
                          onClick={(e) => {
                            // 不阻止冒泡的话会顺带展开说明
                            e.stopPropagation();
                            void askRename(p.key, p.label);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="side-op side-del"
                          title="删除这个自定义节点"
                          onClick={(e) => {
                            e.stopPropagation();
                            void askRemove(p.key, p.label);
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {/*
                   * 说明不再撑在列表里 —— 改成浮层（见文件末尾的 NodeTip）。
                   *
                   * 原先点开一条会把下面所有条目往下推，收起又跳回来，
                   * 扫列表时很烦；而且侧栏只有 260px，结构化说明挤在里面
                   * 要折好几行。
                   *
                   * 内容还是 NodeDesc 那套：能不能用取决于产出/接受、
                   * 需要的外部能力、哪些参数必填 —— 这三样数据契约里都有，
                   * 只是以前没接到界面上。
                   */}

                </div>
              );
            })}
          </div>
        );
      })}

          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              // 清空 value，否则连选同一个文件不会再触发 change
              e.target.value = '';
              if (f) void doImport(f);
            }}
          />
      </div>

      {/*
       * 说明浮层。
       *
       * 放在 .side-pane 之外（NodeTip 内部用 portal 挂到 body）——
       * 侧栏滚动区有 overflow-y:auto，浮层渲染在里面会被裁掉。
       */}
      {tip ? (() => {
        const t = tipBodyOf(tip.key, mcpGroups);
        if (!t) return null;
        return (
          <NodeTip
            key={tip.key}
            anchor={tip.anchor}
            title={t.title}
            pinned={tip.pinned}
            onClose={closeTip}
            onEnter={cancelTimers}
            onLeave={onHoverOut}
          >
            {t.body}
            {/*
             * 操作引导统一在这里收尾。
             *
             * 以前它写在条目的原生 title 里 —— 但浮层弹出时 title 不挂了
             * （避免双重提示），引导就跟着没了。所以搬进浮层。
             */}
            <span className="side-desc-add">
              {disabled ? '运行中不可添加' : '按住 Ctrl / ⌘ 点击添加；也可拖到画布'}
            </span>
          </NodeTip>
        );
      })() : null}
    </aside>
  );
}

/**
 * 按 key 取浮层内容。
 *
 * 先在预设里找（普通节点 / 自定义节点），再在 MCP 工具里找。
 * 查不到就不渲染 —— 宁可没浮层，也不要弹一个空框。
 */
function tipBodyOf(
  key: string,
  mcpGroups?: { server: string; items: { key: string; label: string; hint?: string }[] }[],
): { title: string; body: React.ReactNode } | null {
  const preset = allPresets().find((p) => p.key === key);
  if (preset) {
    return {
      title: preset.label,
      body: (
        <NodeDesc
          presetKey={preset.key}
          type={preset.type}
          hint={preset.hint}
          sub={getDef(preset.type).meta.sub}
        />
      ),
    };
  }
  for (const g of mcpGroups ?? []) {
    const it = g.items.find((i) => i.key === key);
    if (it) {
      return {
        title: it.label,
        body: (
          <div className="side-desc">{it.hint || '这个工具没有额外说明'}</div>
        ),
      };
    }
  }
  return null;
}
