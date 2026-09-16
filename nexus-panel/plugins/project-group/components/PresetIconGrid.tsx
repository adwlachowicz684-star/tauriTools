import { useEffect, useMemo, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import { PRESET_ICON_NAMES, presetIconUrl } from '../presetIcons';
import type { IconGroup } from '../types';
import { confirm, prompt } from '../../../js/dialog.js';

/** 内置图标默认归入的组名（与原版一致）。 */
const DEFAULT_GROUP = '默认';

/** 二进制 → base64（图标只有几 KB，直接拼字符串即可，无需分块优化）。 */
async function toBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读取图标失败: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * 内置图标库（随插件发布的 122 个 .ico）按分组浏览并选用。
 *
 * 图标文件在插件同目录 preseticons/ 下，iframe 内用相对 URL 直接 <img> 显示，
 * 不必经后端转 base64；但「同步到资源管理器」要写 desktop.ini，必须有真实文件，
 * 所以选用时会把内容交给后端固化到数据目录 icons/，之后统一当普通图标路径处理。
 */
export function PresetIconGrid({
  api, groups, onGroupsChange, onPick, onLog,
}: {
  api: Api;
  groups: IconGroup[];
  onGroupsChange: (next: IconGroup[]) => void;
  onPick: (path: string) => void;
  onLog: (m: string, isError?: boolean) => void;
}) {
  const [active, setActive] = useState<string>(DEFAULT_GROUP);
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState('');

  /** 保证至少有一个默认分组；默认组初始收录全部内置图标。 */
  const effective = useMemo<IconGroup[]>(() => {
    if (groups.length > 0) return groups;
    return [{ name: DEFAULT_GROUP, icons: [...PRESET_ICON_NAMES] }];
  }, [groups]);

  // 当前激活分组若被删掉，回退到第一个
  useEffect(() => {
    if (!effective.some((g) => g.name === active)) {
      setActive(effective[0]?.name ?? DEFAULT_GROUP);
    }
  }, [effective, active]);

  const current = effective.find((g) => g.name === active) ?? effective[0];
  const shown = addMode
    ? PRESET_ICON_NAMES.filter((n) => !current?.icons.includes(n))
    : (current?.icons ?? []);

  const commit = (next: IconGroup[]) => {
    onGroupsChange(next);
  };

  const renameGroup = async () => {
    if (!current) return;
    const raw = await prompt({ title: '重命名分组', label: '分组名', defaultValue: current.name });
    const name = (raw ?? '').trim();
    if (!name || name === current.name) return;
    if (effective.some((g) => g.name === name)) {
      onLog(`分组「${name}」已存在`, true);
      return;
    }
    commit(effective.map((g) => (g.name === current.name ? { ...g, name } : g)));
    setActive(name);
  };

  const addGroup = async () => {
    const raw = await prompt({ title: '新建分组', label: '新分组名', defaultValue: `分组${effective.length + 1}` });
    const name = (raw ?? '').trim();
    if (!name) return;
    if (effective.some((g) => g.name === name)) {
      onLog(`分组「${name}」已存在`, true);
      return;
    }
    commit([...effective, { name, icons: [] }]);
    setActive(name);
  };

  const deleteGroup = async () => {
    if (!current) return;
    if (effective.length <= 1) { onLog('至少保留一个分组', true); return; }
    const ok = await confirm({
      title: '删除分组',
      message: `删除分组「${current.name}」？组内图标不会被删除，只是取消归类。`,
      danger: true,
    });
    if (!ok) return;
    commit(effective.filter((g) => g.name !== current.name));
  };

  const removeFromGroup = (icon: string) => {
    if (!current) return;
    commit(effective.map((g) =>
      g.name === current.name ? { ...g, icons: g.icons.filter((x) => x !== icon) } : g));
  };

  const addToGroup = (icon: string) => {
    if (!current) return;
    commit(effective.map((g) =>
      g.name === current.name && !g.icons.includes(icon)
        ? { ...g, icons: [...g.icons, icon] }
        : g));
  };

  /** 选用：先把内置图标固化到数据目录，再把落盘路径交给上层。 */
  const use = async (name: string) => {
    setBusy(name);
    try {
      const b64 = await toBase64(presetIconUrl(name));
      const path = await api.saveIconData(name, b64);
      onPick(path);
    } catch (e) {
      onLog(`选用图标「${name}」失败：${errText(e)}`, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="fpx-preset">
      <div className="fpx-groupbar">
        {effective.map((g) => (
          <button
            key={g.name}
            className={`fpx-grouptab${g.name === active ? ' active' : ''}`}
            onClick={() => { setActive(g.name); setAddMode(false); }}
            onDoubleClick={renameGroup}
            title="双击可重命名"
          >
            {g.name}
            <span className="fpx-groupcount">{g.icons.length}</span>
          </button>
        ))}
        <button className="fpx-grouptab add" onClick={addGroup} title="新建分组">＋</button>
        <span style={{ flex: 1 }} />
        {current && effective.length > 1 && (
          <button className="p-btn mini" onClick={deleteGroup}>删除分组</button>
        )}
        <button
          className={`p-btn mini${addMode ? ' primary' : ''}`}
          onClick={() => setAddMode((v) => !v)}
          disabled={!current}
        >
          {addMode ? '完成' : '加入图标'}
        </button>
      </div>

      {addMode && (
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-3, 6px)' }}>
          点图标即可加入「{current?.name}」
        </div>
      )}

      {shown.length === 0 ? (
        <div className="p-muted">
          {addMode ? '全部内置图标都已在本组中。' : '本组还没有图标，点「加入图标」从内置库里挑。'}
        </div>
      ) : (
        <div className="fpx-icongrid">
          {shown.map((n) => (
            <div key={n} className="fpx-icongrid-item">
              <button
                className="fpx-icontile"
                title={n}
                disabled={busy !== ''}
                onClick={() => (addMode ? addToGroup(n) : void use(n))}
              >
                <img src={presetIconUrl(n)} alt={n} loading="lazy" />
                <span className="fpx-iconcap">{n}</span>
                {busy === n && <span className="fpx-icontile-busy">…</span>}
              </button>
              {!addMode && (
                <button
                  className="fpx-icon-del"
                  title="从本组移除"
                  onClick={() => removeFromGroup(n)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
