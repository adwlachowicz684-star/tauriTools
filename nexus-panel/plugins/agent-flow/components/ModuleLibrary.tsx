import { useState, type DragEvent } from 'react';
import { prompt, confirm, alert } from '../../../js/dialog.js';
import {
  loadModules, addModule, removeModule, renameModule,
  exportModules, importModules, modulePorts, type ModuleDef,
} from '../engine/modules';

/**
 * 模块库 —— 与节点库并列的一栏。
 *
 * 行为与节点库的预设一致（可拖拽、hover 出重命名/删除），
 * 但多一件事：这里的模块改了，**画布上所有引用它的实例跟着变**。
 * 所以在删除与重命名的确认文案里必须说清这一点。
 */

export const MODULE_DRAG_MIME = 'application/x-agent-flow-module';

export type ModuleDragPayload = { moduleId: string };

export function encodeModuleDrag(p: ModuleDragPayload): string {
  return JSON.stringify(p);
}

/** 只校验形状；模块是否真的存在在 drop 时判断（那时才能给出具体原因） */
export function decodeModuleDrag(raw: string | null | undefined): ModuleDragPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as ModuleDragPayload;
    if (!p || typeof p.moduleId !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

type Props = {
  /** 把当前选中的节点们存成新模块 */
  onCreateFromSelection: () => void;
  /** 打开模块的内部结构进行编辑 */
  onEdit: (id: string) => void;
  disabled?: boolean;
};

export default function ModuleLibrary({ onCreateFromSelection, onEdit, disabled }: Props) {
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const [openId, setOpenId] = useState<string | null>(null);

  const mods = loadModules();

  const askRename = async (m: ModuleDef) => {
    const next = await prompt({
      title: '重命名模块',
      message: '改的是模块库里的名字，画布上所有引用它的实例都会跟着改。',
      placeholder: '模块名称',
      defaultValue: m.name,
      validate: (v: string) => (v && v.trim() ? null : '请填个名字'),
    });
    if (!next) return;
    renameModule(m.id, next);
    refresh();
  };

  const askRemove = async (m: ModuleDef) => {
    const ok = await confirm({
      title: `删除模块「${m.name}」？`,
      message:
        '画布上引用它的实例会变成「模块已删除」。\n' +
        '已经脱钩过的实例不受影响（它们自带结构副本）。',
    });
    if (!ok) return;
    removeModule(m.id);
    refresh();
  };

  const doExport = () => {
    const json = exportModules();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agent-flow-modules.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const doImport = (text: string) => {
    try {
      const r = importModules(text);
      refresh();
      const note = r.skipped.length ? `\n跳过 ${r.skipped.length} 条：${r.skipped.join('、')}` : '';
      void alert({ title: '导入完成', message: `新增 ${r.added} 条，更新 ${r.updated} 条。${note}` });
    } catch (err) {
      void alert({ title: '导入失败', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="side-group" key={tick}>
      <div className="side-title">
        模块库
        <span className="side-title-ops">
          <button className="link-btn" title="把画布上选中的节点存成一个模块" onClick={onCreateFromSelection} disabled={disabled}>
            ＋选中
          </button>
          <button className="link-btn" title="导出全部模块为 JSON" onClick={doExport}>
            导出
          </button>
          <label className="link-btn" title="从 JSON 导入模块" style={{ cursor: 'pointer' }}>
            导入
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void f.text().then(doImport);
              }}
            />
          </label>
        </span>
      </div>

      {mods.length === 0 ? (
        <div className="side-sub">还没有模块。选中几个节点后点「＋选中」。</div>
      ) : null}

      {mods.map((m) => {
        const ports = modulePorts(m);
        const open = openId === m.id;
        return (
          <div key={m.id}>
            <div
              className={`side-item${open ? ' is-open' : ''}`}
              draggable={!disabled}
              onDragStart={(e: DragEvent) => {
                const payload = encodeModuleDrag({ moduleId: m.id });
                e.dataTransfer.setData(MODULE_DRAG_MIME, payload);
                e.dataTransfer.setData('text/plain', payload);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => setOpenId((k) => (k === m.id ? null : m.id))}
              title="拖到画布上使用；点击展开说明"
            >
              <span className="side-dot" style={{ background: m.color }} />
              <span className="side-label">{m.name}</span>
              <span className="side-ops">
                <button
                  className="side-op"
                  title="编辑内部结构（改了所有实例跟着变）"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(m.id);
                  }}
                >
                  ✎
                </button>
                <button
                  className="side-op side-del"
                  title="删除模块"
                  onClick={(e) => {
                    e.stopPropagation();
                    void askRemove(m);
                  }}
                >
                  ×
                </button>
              </span>
            </div>
            {open ? (
              <div className="side-desc">
                {m.nodes.length} 个节点 · 入口 {ports.entries.length} 个 · 出口 {ports.exits.length} 个
                <span className="side-desc-add">拖到画布使用；改这里所有实例跟着变</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 供 App 调用：把选中的节点存成模块 */
export async function askCreateModule(
  picked: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] },
): Promise<ModuleDef | null> {
  if (picked.nodes.length === 0) return null;
  const name = await prompt({
    title: '存成模块',
    message: `把选中的 ${picked.nodes.length} 个节点存成一个模块，之后可从模块库反复拖出来用。`,
    placeholder: '模块名称',
    defaultValue: '新模块',
    validate: (v: string) => (v && v.trim() ? null : '请填个名字'),
  });
  if (!name) return null;
  return addModule({
    name,
    nodes: picked.nodes,
    edges: picked.edges as never,
  });
}
