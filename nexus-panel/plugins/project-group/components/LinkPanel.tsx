import { useMemo, useState } from 'react';
import type { PresetAgent, FpxConfig, LinkRow } from '../types';
import { CheckLine, Modal } from './ui';

const STATE_TEXT: Record<string, string> = {
  valid: '有效', broken: '失效', conflict: '冲突', partial: '部分',
};

/** 链接名开关：预设 + 自定义，缺失视为开启；支持改名 / 厂商标注 / 备注 */
export function LinkAgentDialog({
  config, presetAgents, onClose, onSave,
}: {
  config: FpxConfig;
  presetAgents: PresetAgent[];
  onClose: () => void;
  onSave: (next: {
    linkAgents: Record<string, boolean>;
    custom: string[];
    remarks: Record<string, string>;
    vendors: Record<string, string>;
    renames: Record<string, string>;
    pinned: string[];
  }) => void;
}) {
  const [map, setMap] = useState<Record<string, boolean>>({ ...config.linkAgents });
  const [custom, setCustom] = useState<string[]>([...config.customLinkAgents]);
  const [remarks, setRemarks] = useState<Record<string, string>>({ ...config.linkAgentRemarks });
  const [vendors, setVendors] = useState<Record<string, string>>({ ...config.linkAgentVendors });
  const [renames, setRenames] = useState<Record<string, string>>({ ...config.linkAgentRenames });
  const [pinned, setPinned] = useState<string[]>([...config.linkAgentsPinned]);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');

  /**
   * 预设条目：backend 给的 name 是「已应用改名后的显示名」，original 是预设固有键。
   * 改名必须写 renames[original]——后端 display_name 按 original 查，
   * 若按显示名当键，改名会在保存后被静默丢弃。
   */
  const presetRows = useMemo(
    () => presetAgents.map((p) => ({
      original: p.original || p.name,
      shown: renames[p.original || p.name] || p.name,
      vendor: p.vendor,
    })),
    [presetAgents, renames],
  );

  const allNames = useMemo(
    () => [...presetRows.map((p) => p.shown), ...custom],
    [presetRows, custom],
  );
  const enabledCount = allNames.filter((n) => map[n] ?? true).length;

  const toggle = (n: string) => setMap((m) => ({ ...m, [n]: !(m[n] ?? true) }));

  /**
   * 置顶：pin 追加到末尾（多个置顶项按点击顺序排），unpin 直接移除。
   * 排序在渲染时做，未置顶的保持原有相对顺序（稳定）。
   */
  const togglePin = (n: string) => {
    setPinned((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  };

  /** 置顶项排前（按 pinned 顺序），其余保持原序 */
  const sortByPin = <T,>(rows: T[], nameOf: (r: T) => string): T[] => {
    const withIdx = rows.map((r, i) => ({ r, i }));
    withIdx.sort((a, b) => {
      const pa = pinned.indexOf(nameOf(a.r));
      const pb = pinned.indexOf(nameOf(b.r));
      if (pa !== -1 && pb !== -1) return pa - pb;
      if (pa !== -1) return -1;
      if (pb !== -1) return 1;
      return a.i - b.i;
    });
    return withIdx.map((x) => x.r);
  };

  /** 把某个键上的值迁到新键（旧键不存在则不动） */
  const migrate = (src: Record<string, string>, from: string, to: string) => {
    if (from === to || !(from in src)) return src;
    const n = { ...src };
    n[to] = n[from];
    delete n[from];
    return n;
  };

  /**
   * 改名。
   * renames 的键 = 预设原名（original）；
   * 开关 / 备注 / 厂商 的键 = 当前显示名，所以要随显示名一起迁移。
   */
  const rename = (original: string, currentShown: string, to: string) => {
    const name = to.trim();
    // 清空 = 恢复预设原名
    const next = name || original;
    if (next === currentShown) {
      setErr('');
      return;
    }
    if (allNames.includes(next)) { setErr(`「${next}」已被占用`); return; }
    if (/[\\/:*?"<>|]/.test(next)) { setErr('名称含有非法字符'); return; }
    setErr('');
    setRenames((r) => {
      const n = { ...r };
      if (next === original) delete n[original];
      else n[original] = next;
      return n;
    });
    setMap((m) => {
      if (currentShown === next || !(currentShown in m)) return m;
      const n = { ...m };
      n[next] = n[currentShown];
      delete n[currentShown];
      return n;
    });
    setRemarks((r) => migrate(r, currentShown, next));
    setVendors((v) => migrate(v, currentShown, next));
    // 置顶列表存的是显示名，改名后要把旧名换成新名，否则置顶会失效
    setPinned((p) => {
      const i = p.indexOf(currentShown);
      if (i === -1) return p;
      const n = [...p];
      n[i] = next;
      return n;
    });
  };

  const addCustom = () => {
    const raw = draft.trim();
    if (!raw) return;
    const name = raw.startsWith('.') ? raw : `.${raw}`;
    if (!name.slice(1).trim()) { setErr('名称不能只有点号'); return; }
    if (/[\\/:*?"<>|]/.test(name)) { setErr('名称含有非法字符'); return; }
    if (allNames.includes(name)) { setErr('该链接名已存在'); return; }
    setCustom((c) => [...c, name]);
    setDraft('');
    setErr('');
  };

  return (
    <Modal
      title="Agent 链接名"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button className="p-btn primary" onClick={() => {
            // 只保留「名字仍存在且值非空」的项，避免删掉链接名后残留孤儿备注 / 厂商覆盖
            const pick = (src: Record<string, string>) => {
              const out: Record<string, string> = {};
              for (const n of allNames) {
                const v = (src[n] ?? '').trim();
                if (v) out[n] = v;
              }
              return out;
            };
            // 改名后名字已变，renames 里的键要落回「当前显示名」
            const keptRenames: Record<string, string> = {};
            for (const [from, to] of Object.entries(renames)) {
              if (!to.trim() || to === from) continue;
              keptRenames[from] = to.trim();
            }
            // 置顶只保留当前仍存在的名字，避免删掉链接名后列表里留着幽灵项
            const keptPinned = pinned.filter((n) => allNames.includes(n));
            onSave({
              linkAgents: map,
              custom,
              remarks: pick(remarks),
              vendors: pick(vendors),
              renames: keptRenames,
              pinned: keptPinned,
            });
            onClose();
          }}>
            保存（已启用 {enabledCount}/{allNames.length}）
          </button>
        </>
      }
    >
      <div className="p-muted" style={{ marginBottom: 10 }}>
        分配项目组时，会在项目目录下为每个启用的名字创建一个指向项目组的链接（junction），
        各家 agent 打开项目时即可读到该项目组的 agent / skill。
      </div>
      <div className="p-muted" style={{ marginBottom: 10, fontSize: 11.5 }}>
        改名只影响<b>之后</b>新建的链接：已经建好的链接目录不会跟着改名，
        改名后需要对相关项目<b>撤销链接再重新分配</b>才会生效。
      </div>

      <div className="fpx-agent-grid">
        {sortByPin(presetRows, (p) => p.shown).map((p) => {
          const isRenamed = p.shown !== p.original;
          const isPinned = pinned.includes(p.shown);
          return (
            <div key={p.original} className={`fpx-agent-row wrap${isPinned ? ' pinned' : ''}`}>
              <button
                className={`fpx-pin${isPinned ? ' on' : ''}`}
                title={isPinned ? '取消置顶' : '置顶'}
                onClick={() => togglePin(p.shown)}
              >
                {isPinned ? '★' : '☆'}
              </button>
              <CheckLine
                checked={map[p.shown] ?? true}
                onChange={() => toggle(p.shown)}
                title={p.shown}
                subtitle={vendors[p.shown]?.trim() || p.vendor}
              />
              <input
                className="p-input fpx-rename"
                // key 随显示名变化：改名后输入框重新挂载，拿到新的默认值
                key={`rn-${p.shown}`}
                defaultValue={p.shown}
                title="改名：实际建链目录名随之改变（清空恢复原名）"
                placeholder={p.original}
                onBlur={(e) => rename(p.original, p.shown, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <input
                className="p-input fpx-vendor"
                value={vendors[p.shown] ?? ''}
                placeholder={p.vendor}
                title="厂商标注（留空用预设默认）"
                onChange={(ev) => setVendors((v) => ({ ...v, [p.shown]: ev.target.value }))}
              />
              <input
                className="p-input fpx-remark"
                value={remarks[p.shown] ?? ''}
                placeholder="备注（可选）"
                onChange={(ev) => setRemarks((r) => ({ ...r, [p.shown]: ev.target.value }))}
              />
              {isRenamed && (
                <span className="fpx-badge dim" title={`预设名 ${p.original}`}>已改名</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-row" style={{ marginTop: 12 }}>
        <input className="p-input" value={draft} placeholder="自定义链接名，如 .myagent"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
        <button className="p-btn" onClick={addCustom}>添加</button>
      </div>
      {err && <div className="p-muted" style={{ color: 'var(--danger)' }}>{err}</div>}

      {custom.length > 0 && (
        <div className="fpx-agent-grid" style={{ marginTop: 10 }}>
          {sortByPin(custom, (n) => n).map((n) => {
            const isPinned = pinned.includes(n);
            return (
            <div key={n} className={`fpx-agent-row wrap${isPinned ? ' pinned' : ''}`}>
              <button
                className={`fpx-pin${isPinned ? ' on' : ''}`}
                title={isPinned ? '取消置顶' : '置顶'}
                onClick={() => togglePin(n)}
              >
                {isPinned ? '★' : '☆'}
              </button>
              <CheckLine
                checked={map[n] ?? true}
                onChange={() => toggle(n)}
                title={n}
                subtitle={vendors[n]?.trim() || '自定义'}
              />
              <input
                className="p-input fpx-vendor"
                value={vendors[n] ?? ''}
                placeholder="厂商"
                title="厂商标注（可选）"
                onChange={(e) => setVendors((v) => ({ ...v, [n]: e.target.value }))}
              />
              <input
                className="p-input fpx-remark"
                value={remarks[n] ?? ''}
                placeholder="备注（可选）"
                onChange={(e) => setRemarks((r) => ({ ...r, [n]: e.target.value }))}
              />
              <button className="p-btn danger" style={{ height: 28, padding: '0 10px' }}
                onClick={() => setCustom((c) => c.filter((x) => x !== n))}>删除</button>
            </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/** 链接记录表 */
export function LinkTable({
  links, onOpen, onRemove, busy,
}: {
  links: LinkRow[];
  onOpen: (row: LinkRow) => void;
  onRemove: (project: string) => void;
  busy: boolean;
}) {
  if (links.length === 0) {
    return <div className="p-muted">（暂无链接记录，把项目卡片拖到项目组卡片上即可分配）</div>;
  }
  return (
    <div className="fpx-table">
      {links.map((l) => (
        <div key={l.project} className="fpx-tr">
          <div className="fpx-td fpx-td-path" title={l.project}>{l.project}</div>
          <div className="fpx-td fpx-td-arrow">→</div>
          <div className="fpx-td fpx-td-path" title={l.group}>{l.groupName || l.group}</div>
          <div className="fpx-td fpx-td-names">
            {l.names.slice(0, 4).map((n) => <span key={n} className="p-tag">{n}</span>)}
            {l.names.length > 4 && <span className="p-tag">+{l.names.length - 4}</span>}
          </div>
          <div className="fpx-td fpx-td-time">{l.created}</div>
          <div className={`fpx-td fpx-state ${l.state}`}>{STATE_TEXT[l.state] ?? l.state}</div>
          <div className="fpx-td fpx-td-ops">
            <button className="p-btn" style={{ height: 26, padding: '0 10px' }} onClick={() => onOpen(l)}>打开项目</button>
            <button className="p-btn danger" style={{ height: 26, padding: '0 10px' }} disabled={busy}
              onClick={() => onRemove(l.project)}>撤销</button>
          </div>
        </div>
      ))}
    </div>
  );
}
