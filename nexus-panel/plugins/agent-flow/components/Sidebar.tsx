import { useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
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
   * 模块库面板。由 App 传入而不是这里直接 import ——
   * 它需要读写画布选中项与模块内部结构，依赖 App 的状态；
   * 若 Sidebar 直接 import 它，两边的画布状态会各存一份。
   */
  modulePanel?: ReactNode;
};

export default function Sidebar({ onAdd, disabled, modulePanel }: Props) {
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
  const [tab, setTab] = useState<'node' | 'module'>('node');

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
      <div className="side-head">
        {/*
         * 两个库共用这一栏，用一个 tab 切。
         * 并排放两条栏会把画布挤窄 —— 280px 变 560px，中等屏幕上没法用。
         */}
        {modulePanel ? (
          <span className="side-tabs">
            <button
              className={`side-tab${tab === 'node' ? ' on' : ''}`}
              onClick={() => setTab('node')}
            >
              节点库
            </button>
            <button
              className={`side-tab${tab === 'module' ? ' on' : ''}`}
              onClick={() => setTab('module')}
            >
              模块库
            </button>
          </span>
        ) : (
          '节点库'
        )}
      </div>
      <div className="side-hint">
        {tab === 'node'
          ? '拖到画布添加；点击展开说明，按住 Ctrl / ⌘ 点击直接添加'
          : '拖到画布使用；改模块库里的内容，所有实例跟着变'}
      </div>

      {tab === 'module' ? modulePanel : (
        <>
          {groups.map((g) => {
        const def = getDef(g.presets[0].type);
        const isCustom = g.category === 'custom';
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
                    draggable={!disabled}
                    onDragStart={(e) => onDragStart(e, { kind: p.key })}
                    onClick={(e) => onItemClick(e, p)}
                    title={disabled ? '运行中不可添加' : '点击展开说明；按住 Ctrl / ⌘ 点击直接添加；也可拖到画布'}
                  >
                    <span className="side-dot" style={{ background: p.color }} />
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
                  {/* 展开的说明块；没内容时给个兜底文案，避免点了像没反应 */}
                  {open ? (
                    <div className="side-desc">
                      {desc || '这个节点没有额外说明'}
                      <span className="side-desc-add">按住 Ctrl / ⌘ 点击添加</span>
                    </div>
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
        </> )}
    </aside>
  );
}
