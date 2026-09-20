import { useRef, useState, type DragEvent, type MouseEvent } from 'react';
import NodeDesc from './NodeDesc';
import { presetsByCategory, getDef } from '../nodes';
import { hasDef } from '../nodes/registry';
import { confirm, alert, prompt } from '../../../js/dialog.js';
import {
  presetIdOf, removeCustomPreset, renameCustomPreset,
  exportCustomPresets, importCustomPresets,
} from '../engine/customPresets';

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
  group, disabled, onDragStart, onItemClick, openKey,
}: {
  group: { server: string; color: string; items: { key: string; label: string; hint?: string }[] };
  disabled?: boolean;
  onDragStart: (e: DragEvent, p: DragPayload) => void;
  onItemClick: (e: MouseEvent, p: { key: string }) => void;
  openKey: string | null;
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
            const isOpen = openKey === it.key;
            return (
              <div key={it.key}>
                <div
                  className={`side-item${isOpen ? ' is-open' : ''}`}
                  /* 同一 server 的工具同色，与它们在画布上的卡片一致 */
                  style={{ borderLeftColor: group.color }}
                  draggable={!disabled}
                  onDragStart={(e) => onDragStart(e, { kind: it.key })}
                  onClick={(e) => onItemClick(e, { key: it.key })}
                  title="点击展开说明；按住 Ctrl / ⌘ 点击直接添加；也可拖到画布"
                >
                  <span className="side-label">{it.label}</span>
                </div>
                {isOpen ? (
                  <div className="side-desc">
                    {it.hint || '这个工具没有额外说明'}
                    <span className="side-desc-add">按住 Ctrl / ⌘ 点击添加</span>
                  </div>
                ) : null}
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
  const [openKey, setOpenKey] = useState<string | null>(null);

  const onItemClick = (e: MouseEvent, p: { key: string }) => {
    if (disabled) return;
    if (e.ctrlKey || e.metaKey) {
      onAdd({ kind: p.key });
      return;
    }
    // 再点一次收起
    setOpenKey((k) => (k === p.key ? null : p.key));
  };

  /*
   * 自定义节点是存在 localStorage 里的，增删改之后要让它重新读一次。
   * 用本地计数触发重渲染即可 —— 预设列表本来就是每次渲染时从存储现读的，
   * 不必再往上抛给 App 管一份状态。
   */
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

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
          <div className="side-sub">
            还没有节点 —— 在画布设置里配一个 MCP 服务，再点刷新
          </div>
        ) : null}

        {groups.map((sg) => (
          <McpServerSection
            key={sg.server}
            group={sg}
            disabled={disabled}
            onDragStart={onDragStart}
            onItemClick={onItemClick}
            openKey={openKey}
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
    <aside className="sidebar" key={tick}>
      {/*
        节点库**只管节点**。
        模块库原先嵌在这里用二级 tab 切，现在提到左栏顶层与它并列 ——
        两处都能切同一件事会造成割裂：在一处切了，另一处状态不动，
        看起来像点了没反应。
      */}
      <div className="side-head">节点库</div>
      <div className="side-hint">
        拖到画布添加；点击展开说明，按住 Ctrl / ⌘ 点击直接添加
      </div>

        {groups.map((g) => {
        const def = getDef(g.presets[0].type);
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
              const open = openKey === p.key;
              // 说明优先用预设自带的 hint，没有则退回节点定义里的 sub
              const desc = p.hint ?? def.meta.sub ?? '';
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
                    title={disabled ? '运行中不可添加' : '点击展开说明；按住 Ctrl / ⌘ 点击直接添加；也可拖到画布'}
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
                   * 展开的说明块。
                   *
                   * 以前只有一句话（def.meta.sub），而"能不能用"取决于
                   * 三件那句话里没有的事：产出/接受（能跟谁连）、
                   * 需要的外部能力（浏览器模式下缺了直接失败）、哪些参数必填。
                   * 这三样数据契约里都有，只是没接到界面上 —— NodeDesc 负责接。
                   */}
                  {open ? (
                    <NodeDesc presetKey={p.key} type={p.type} hint={desc} sub={def.meta.sub} />
                  ) : null}
                </div>
              );
            })}

            {def.meta.sub && !isCustom ? <div className="side-sub">{def.meta.sub}</div> : null}
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
    </aside>
  );
}
