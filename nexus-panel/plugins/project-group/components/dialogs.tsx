import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import type { CardKind, IconGroup } from '../types';
import { ColorPicker } from './ColorPicker';
import { DirDialog } from './DirDialog';
import { PresetIconGrid } from './PresetIconGrid';
import { CheckLine, Modal } from './ui';

const EMOJIS = ['📁', '🤖', '🧠', '⚙', '🎨', '📦', '🧩', '🚀', '🧪', '📚', '🔧', '💡', '🛠', '🧭', '🏷', '🗂'];

/** 新建项目 / 项目组 */
export function CreateDialog({
  api, kind, defaultParent, defaultTemplate, tabName, hierarchyOn,
  onClose, onCreated, onLog,
}: {
  api: Api;
  kind: CardKind;
  defaultParent: string | null;
  defaultTemplate: string | null;
  tabName: string;
  /** 全局「路径携带页签层级」开关的当前值（后端据此决定是否拼层级） */
  hierarchyOn: boolean;
  onClose: () => void;
  onCreated: (path: string) => void;
  onLog: (msg: string, isError?: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState(defaultParent ?? '');
  const [template, setTemplate] = useState(defaultTemplate ?? '');
  const [picking, setPicking] = useState<'parent' | 'template' | null>(null);
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    try {
      const p = await api.createFolder(parent, name.trim(), tabName || undefined,
        kind === 'group' ? (template.trim() || undefined) : undefined);
      onLog(`已创建：${p}`);
      onCreated(p);
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <>
      <Modal
        title={kind === 'project' ? '新建项目' : '新建项目组'}
        onClose={onClose}
        footer={
          <>
            <button className="p-btn" onClick={onClose}>取消</button>
            <button className="p-btn primary" disabled={!name.trim()} onClick={submit}>创建</button>
          </>
        }
      >
        <div className="fpx-field">
          <label>名称</label>
          <input className="p-input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) submit(); }} />
        </div>

        <div className="fpx-field">
          <label>父目录</label>
          <div className="p-row">
            <input className="p-input" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="留空则使用用户目录" />
            <button className="p-btn" onClick={() => setPicking('parent')}>浏览…</button>
          </div>
        </div>

        {/*
          路径是否带页签层级由「设置」里的全局开关决定，这里不再放局部勾选：
          两处都控制会变成"都勾上才生效"的隐性双闸门，用户很难理解为什么勾了没反应。
          这里只做现状说明 + 去设置页的提示。
        */}
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-6, 12px)' }}>
          {hierarchyOn
            ? `将建在 父目录\\${tabName}\\ 下（「路径携带页签层级」已在设置中开启）`
            : `将直接建在父目录下。如需按页签分层，请到「设置」开启「新建时路径携带页签层级」`}
        </div>

        {kind === 'group' && (
          <div className="fpx-field">
            <label>模板目录（可选，创建后自动拷贝内容）</label>
            <div className="p-row">
              <input className="p-input" value={template} onChange={(e) => setTemplate(e.target.value)} />
              <button className="p-btn" onClick={() => setPicking('template')}>浏览…</button>
            </div>
          </div>
        )}

        {err && <div className="p-muted" style={{ color: 'var(--danger)', marginTop: 'var(--sp-4, 8px)' }}>{err}</div>}
      </Modal>

      {picking && (
        <DirDialog
          api={api}
          title={picking === 'parent' ? '选择父目录' : '选择模板目录'}
          allowCreate
          onClose={() => setPicking(null)}
          onPick={(p) => { if (picking === 'parent') setParent(p); else setTemplate(p); }}
        />
      )}
    </>
  );
}

/** ACL 文件夹保护 */
export function LockDialog({
  path, denyDelete, denyWrite, onClose, onApply,
}: {
  path: string;
  denyDelete: boolean;
  denyWrite: boolean;
  onClose: () => void;
  onApply: (denyDelete: boolean, denyWrite: boolean) => void;
}) {
  const [dd, setDd] = useState(denyDelete);
  const [dw, setDw] = useState(denyWrite);

  return (
    <Modal
      title="文件夹保护（ACL）"
      onClose={onClose}
      footer={
        <>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button className="p-btn primary" onClick={() => { onApply(dd, dw); onClose(); }}>应用</button>
        </>
      }
    >
      <div className="p-mono p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', wordBreak: 'break-all' }}>{path}</div>
      <CheckLine checked={dd} onChange={setDd} title="防删除" subtitle="禁止删除该文件夹（重命名也会被拦）" />
      <CheckLine checked={dw} onChange={setDw} title="防写入" subtitle="禁止写入，目录变为只读" />
      <div className="p-muted" style={{ marginTop: 'var(--sp-5, 10px)' }}>
        Windows 走系统 icacls，非 Windows 平台退化为只读权限。受保护的目录在建链/删链时会自动临时摘锁。
      </div>
    </Modal>
  );
}

/**
 * 图标选择：内置图标库（随插件发布的 122 个）/ 我的图标（数据目录 icons/）。
 * DirDialog 只能选目录，不能用来选图标文件，所以自定义图标仍在这里列。
 */
export function IconPickDialog({
  api, files, groups, onGroupsChange, onClose, onPick, onImported, onLog,
}: {
  api: Api;
  files: string[];
  groups: IconGroup[];
  onGroupsChange: (next: IconGroup[]) => void;
  onClose: () => void;
  onPick: (path: string) => void;
  onImported: (files: string[]) => void;
  onLog: (m: string, isError?: boolean) => void;
}) {
  const [tab, setTab] = useState<'preset' | 'mine'>('preset');
  const [picking, setPicking] = useState(false);
  // 自定义图标是本地路径，沙箱里显示不了，逐个问后端要 data URI
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (tab !== 'mine') return;
    let alive = true;
    (async () => {
      for (const f of files) {
        if (!alive || thumbs[f]) continue;
        try {
          const uri = await api.iconData(f);
          if (!alive) return;
          setThumbs((m) => ({ ...m, [f]: uri }));
        } catch {
          /* 单个图标读不出来就留占位，不刷屏报错 */
        }
      }
    })();
    return () => { alive = false; };
  }, [tab, files, api, thumbs]);

  const importFrom = async (dir: string) => {
    setPicking(false);
    try {
      const list = await api.importIcons(dir);
      onImported(list);
      onLog(`已导入 ${list.length} 个图标`);
      setTab('mine');
    } catch (e) {
      onLog(errText(e), true);
    }
  };

  return (
    <Modal title="选择图标" onClose={onClose} width={620}>
      <div className="fpx-groupbar" style={{ marginBottom: 'var(--sp-6, 12px)' }}>
        <button
          className={`fpx-grouptab${tab === 'preset' ? ' active' : ''}`}
          onClick={() => setTab('preset')}
        >
          内置图标
        </button>
        <button
          className={`fpx-grouptab${tab === 'mine' ? ' active' : ''}`}
          onClick={() => setTab('mine')}
        >
          我的图标{files.length > 0 ? `（${files.length}）` : ''}
        </button>
      </div>

      {tab === 'preset' && (
        <PresetIconGrid
          api={api}
          groups={groups}
          onGroupsChange={onGroupsChange}
          onPick={(p) => { onPick(p); onClose(); }}
          onLog={onLog}
        />
      )}

      {tab === 'mine' && (files.length === 0 ? (
        <div className="p-muted">
          数据目录 <span className="p-mono">icons/</span> 下还没有图标。
          点「从目录导入」把任意文件夹里的 .ico/.png 搬过来；
          选用内置图标时也会自动在这里留一份。
        </div>
      ) : (
        <div className="fpx-icongrid">
          {files.map((f) => {
            const name = f.split(/[\\/]/).pop() ?? f;
            return (
              <button
                key={f}
                className="fpx-icontile"
                title={f}
                onClick={() => { onPick(f); onClose(); }}
              >
                {thumbs[f]
                  ? <img src={thumbs[f]} alt={name} />
                  : <span className="fpx-icontile-ph">{(name.slice(0, 1)).toUpperCase()}</span>}
                <span className="fpx-iconcap">{name.replace(/\.(ico|png|jpe?g|bmp)$/i, '')}</span>
              </button>
            );
          })}
        </div>
      ))}

      <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-8, 16px)' }}>
        <button className="p-btn" onClick={() => setPicking(true)}>从目录导入…</button>
        <button className="p-btn" onClick={onClose}>取消</button>
      </div>

      {picking && (
        <DirDialog
          api={api}
          title="选择含图标的目录"
          onClose={() => setPicking(false)}
          onPick={importFrom}
        />
      )}
    </Modal>
  );
}

/** 图标 + 标签颜色（色盘为完整版：预设 24 色 / 自定义常用色 / RGB / HEX / 吸管） */
export function StyleDialog({
  api, path, icon, color, inherited, customColors,
  onClose, onApply, onSaveCustom, onPickIconFile, onLog,
}: {
  api: Api;
  path: string;
  icon: string | null;
  color: string | null;
  inherited: boolean;
  customColors: string[];
  onClose: () => void;
  onApply: (icon: string | null, color: string | null) => void;
  onSaveCustom: (colors: string[]) => void;
  onPickIconFile: () => void;
  onLog: (msg: string, isError?: boolean) => void;
}) {
  const [ic, setIc] = useState(icon ?? '');
  const [cl, setCl] = useState<string | null>(color);
  // 与进入时相比有变化才算"未保存"，避免只是打开看一眼也弹确认
  const dirty = (ic.trim() || null) !== (icon ?? null) || cl !== color;

  return (
    <Modal
      title="图标与标签"
      onClose={onClose}
      width={520}
      guardClose={dirty}
      footer={
        <>
          <button className="p-btn" onClick={() => { onApply(null, null); onClose(); }}>清除</button>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button className="p-btn primary" onClick={() => { onApply(ic.trim() || null, cl); onClose(); }}>
            应用
          </button>
        </>
      }
    >
      <div className="p-mono p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', wordBreak: 'break-all' }}>{path}</div>

      <div className="fpx-field">
        <label>图标</label>
        <div className="fpx-emoji-grid">
          {EMOJIS.map((e) => (
            <button key={e} className={`fpx-emoji${ic === e ? ' active' : ''}`} onClick={() => setIc(e)}>{e}</button>
          ))}
        </div>
        <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)' }}>
          <input className="p-input" value={ic} placeholder="图标文件路径（.ico / 可留空用 emoji）"
            onChange={(e) => setIc(e.target.value)} />
          <button className="p-btn" onClick={onPickIconFile}>数据目录图标…</button>
        </div>
      </div>

      <div className="fpx-field">
        <label>
          标签颜色
          {inherited && <span className="p-muted">（当前继承自所链接的项目组，改后即为自有颜色）</span>}
        </label>
        <ColorPicker
          api={api}
          value={cl}
          customColors={customColors}
          onChange={setCl}
          onSaveCustom={onSaveCustom}
          onLog={onLog}
        />
      </div>
    </Modal>
  );
}
