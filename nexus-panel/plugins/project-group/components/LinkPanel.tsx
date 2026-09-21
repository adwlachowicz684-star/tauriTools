import { useMemo, useState } from 'react';
import type { PresetAgent, FpxConfig } from '../types';
import {
  allEnabled, hasNameCI, invertEnabled, resetToPreset, setAllEnabled,
} from '../utils/linkAgents';
import { CheckLine } from './ui';

/** 链接名开关主体（不带 Modal）：预设 + 自定义，缺失视为开启；支持改名 / 厂商标注 / 备注 */
export function LinkAgentBody({
  config, presetAgents, onSave, onLog,
}: {
  config: FpxConfig;
  presetAgents: PresetAgent[];
  onSave: (next: {
    linkAgents: Record<string, boolean>;
    custom: string[];
    remarks: Record<string, string>;
    vendors: Record<string, string>;
    renames: Record<string, string>;
    pinned: string[];
  }) => void;
  /** 保存后提示用；设置面板里没有日志区，走 toast 由外层决定 */
  onLog?: (m: string) => void;
}) {
  const [map, setMap] = useState<Record<string, boolean>>({ ...config.linkAgents });
  const [custom, setCustom] = useState<string[]>([...config.customLinkAgents]);
  const [remarks, setRemarks] = useState<Record<string, string>>({ ...config.linkAgentRemarks });
  const [vendors, setVendors] = useState<Record<string, string>>({ ...config.linkAgentVendors });
  const [renames, setRenames] = useState<Record<string, string>>({ ...config.linkAgentRenames });
  const [pinned, setPinned] = useState<string[]>([...config.linkAgentsPinned]);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  /*
   * #63 改名输入改成**每行独立**的草稿与就地错误。
   *
   * 此前用 `defaultValue`（不受控）+ 一个全局 err：
   * 校验失败时函数直接 return，但**输入框里的非法值不会回滚** ——
   * 界面显示"名称含有非法字符"，框里却还留着那个非法值，
   * 而实际生效的仍是原名。**显示与实际不一致**，用户以为改成功了。
   *
   * 而且全局只有一个 err，多行同时出错时定位不到是哪一行。
   * 所以改成受控 + 每行各自的错误。
   */
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
  const [renameErr, setRenameErr] = useState<Record<string, string>>({});

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
  /** 是否已全启用：决定"全选"还是"全不选"该置灰 */
  const everyOn = allEnabled(allNames, map);

  const toggle = (n: string) => setMap((m) => ({ ...m, [n]: !(m[n] ?? true) }));

  /**
   * 恢复预设（#64）：清空改名与厂商标注，名字回到预设原名。
   *
   * 置顶与备注**保持不变**，但它们的键是"显示名" ——
   * 名字变回原名后键必须跟着迁，否则置顶会静默失效、备注会被 submit() 当成
   * 幽灵项丢掉。这段迁移规则在 utils/linkAgents.ts 里，有测试钉着。
   */
  const restorePreset = () => {
    const rows = presetRows.map((p) => ({ original: p.original, shown: p.shown }));
    const next = resetToPreset(rows, { renames, vendors, remarks, pinned, map });
    setRenames(next.renames);
    setVendors(next.vendors);
    setRemarks(next.remarks);
    setPinned(next.pinned);
    setMap(next.map);
    setErr('');
    onLog?.('已恢复预设名称与厂商标注（置顶与备注保持不变）');
  };

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
  const clearRenameErr = (original: string) => {
    setRenameErr((x) => {
      if (!(original in x)) return x;
      const n = { ...x };
      delete n[original];
      return n;
    });
  };

  /** 改名。**返回是否成功** —— 调用方据此决定草稿是回落还是回滚 */
  const rename = (original: string, currentShown: string, to: string): boolean => {
    const name = to.trim();
    // 清空 = 恢复预设原名
    const next = name || original;
    if (next === currentShown) {
      clearRenameErr(original);
      return true;
    }
    /* 就地报错：定位到具体哪一行 */
    if (allNames.includes(next)) {
      setRenameErr((x) => ({ ...x, [original]: `「${next}」已被占用` }));
      return false;
    }
    if (/[\\/:*?"<>|]/.test(next)) {
      setRenameErr((x) => ({ ...x, [original]: '名称含有非法字符' }));
      return false;
    }
    /* #91 与"添加自定义"同一判据，避免绕过 */
    if (hasNameCI(allNames, next)) {
      setRenameErr((x) => ({ ...x, [original]: '已存在（不区分大小写）' }));
      return false;
    }
    clearRenameErr(original);
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
    return true;
  };

  const addCustom = () => {
    const raw = draft.trim();
    if (!raw) return;
    const name = raw.startsWith('.') ? raw : `.${raw}`;
    if (!name.slice(1).trim()) { setErr('名称不能只有点号'); return; }
    if (/[\\/:*?"<>|]/.test(name)) { setErr('名称含有非法字符'); return; }
    /* #91 大小写不敏感：Windows 下 `.OpenCode` 与 `.opencode` 是同一个目录，
       精确比较拦不住，会建出两个指向同一 junction 的链接名。 */
    if (hasNameCI(allNames, name)) { setErr('该链接名已存在（不区分大小写）'); return; }
    setCustom((c) => [...c, name]);
    setDraft('');
    setErr('');
  };

  const submit = () => {
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
    onLog?.('链接名设置已保存');
  };

  return (
    <>
      <div className="p-muted" style={{ marginBottom: 'var(--sp-5, 10px)' }}>
        分配项目组时，会在项目目录下为每个启用的名字创建一个指向项目组的链接（junction），
        各家 agent 打开项目时即可读到该项目组的 agent / skill。
      </div>
      <div className="p-muted" style={{ marginBottom: 'var(--sp-5, 10px)', fontSize: 'var(--fs-11, 11px)' }}>
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
                /* 受控：**不再用 key 重新挂载**。
                   值直接由 `shown` 派生，改名成功后自然显示新名；
                   校验失败时草稿被清掉，于是**回滚到旧值** ——
                   这正是"显示与实际一致"的关键。 */
                value={renameDraft[p.original] ?? p.shown}
                title="改名：实际建链目录名随之改变（清空恢复原名，Esc 取消）"
                placeholder={p.original}
                onChange={(e) => setRenameDraft(
                  (d) => ({ ...d, [p.original]: e.target.value }),
                )}
                onBlur={(e) => {
                  rename(p.original, p.shown, e.target.value);
                  /* 无论成败都清掉这一行的草稿：
                     成功 → 回落到新的 shown；失败 → 回滚到当前 shown。 */
                  setRenameDraft((d) => {
                    const n = { ...d };
                    delete n[p.original];
                    return n;
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.currentTarget.blur(); return; }
                  if (e.key === 'Escape') {
                    /* 取消这次编辑：清掉草稿即回到当前值 */
                    setRenameDraft((d) => {
                      const n = { ...d };
                      delete n[p.original];
                      return n;
                    });
                    clearRenameErr(p.original);
                    e.currentTarget.blur();
                    /* #250 同上：只退出这次编辑，别让事件冒到上面的浮层 */
                    e.stopPropagation();
                  }
                }}
              />
              {renameErr[p.original] && (
                <span className="fpx-rename-err" title={renameErr[p.original]}>
                  {renameErr[p.original]}
                </span>
              )}
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

      <div className="p-row" style={{ marginTop: 'var(--sp-6, 12px)' }}>
        <input className="p-input" value={draft} placeholder="自定义链接名，如 .myagent"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
        <button className="p-btn" onClick={addCustom}>添加</button>
      </div>
      {err && <div className="p-muted" style={{ color: 'var(--danger)' }}>{err}</div>}

      {custom.length > 0 && (
        <div className="fpx-agent-grid" style={{ marginTop: 'var(--sp-5, 10px)' }}>
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

      {/* 批量操作（#65 全选/全不选、#64 恢复预设）。
          放在保存按钮同一行：它们改的都是同一批草稿，分开摆反而像两件事。 */}
      <div className="p-row" style={{ marginTop: 'var(--sp-6, 12px)' }}>
        <button
          className="p-btn"
          title={`把所有链接名设为启用（共 ${allNames.length} 个）`}
          disabled={everyOn}
          onClick={() => setMap(setAllEnabled(allNames, map, true))}
        >
          全选
        </button>
        <button
          className="p-btn"
          title="把所有链接名设为停用"
          disabled={enabledCount === 0}
          onClick={() => setMap(setAllEnabled(allNames, map, false))}
        >
          全不选
        </button>
        {/* 反选（#96）：链接名往往一开就是几十个，
            想"只留某几个"时全不选再一个个勾更慢，
            反选是这种场景最短的路径。 */}
        <button
          className="p-btn"
          title={`启用的关掉、关掉的启用（当前已启用 ${enabledCount} 个）`}
          disabled={allNames.length === 0}
          onClick={() => setMap(invertEnabled(allNames, map))}
        >
          反选
        </button>
        <button
          className="p-btn"
          title="清空改名与厂商标注，名字回到预设原名；置顶与备注保持不变"
          onClick={restorePreset}
        >
          恢复预设
        </button>
        <button className="p-btn primary" onClick={submit}>
          保存（已启用 {enabledCount}/{allNames.length}）
        </button>
      </div>
    </>
  );
}
