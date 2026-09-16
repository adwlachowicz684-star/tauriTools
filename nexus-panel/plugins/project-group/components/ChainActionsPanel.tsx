import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import type { ChainAction, ChainClient } from '../types';
import { Modal } from './ui';

/** 自定义动作的候选图标（内置四个动作的图标不在此列，避免重复观感）。 */
const ICONS = ['💬', '🔍', '🗜', '🚀', '🧪', '📦', '🧹', '📝', '🔧', '🧭', '⚡', '🧩'];

const uid = () => `c${Math.random().toString(16).slice(2, 10)}`;

/**
 * 连锁动作管理：内置四项 + 自定义，增删改排序，每个动作可分别设项目/项目组两份模板。
 *
 * 内置项不提供删除——后端会在读取时自动补齐被删掉的内置项，
 * 与其给一个"删了又冒出来"的按钮，不如直接不给这个入口。
 * 自定义动作可以改模板后保留、也可删除。
 */
export function ChainActionsPanel({
  api, onClose, onLog, onChanged,
}: {
  api: Api;
  onClose: () => void;
  onLog: (m: string, isError?: boolean) => void;
  /** 保存成功后通知外层重新拉清单（右键菜单 / 侧边栏用的是外层的那份） */
  onChanged?: () => void;
}) {
  const [list, setList] = useState<ChainAction[]>([]);
  const [clients, setClients] = useState<ChainClient[]>([]);
  const [active, setActive] = useState<string>('chain');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.chainActions()
      .then((l) => {
        setList(l);
        if (l.length > 0) setActive(l[0].id);
      })
      .catch((e) => onLog(errText(e), true));
    api.chainClients().then(setClients).catch(() => { /* 客户端列表拿不到也能编辑 */ });
  }, [api, onLog]);

  const cur = list.find((a) => a.id === active) ?? null;

  const patch = (id: string, p: Partial<ChainAction>) => {
    setList((l) => l.map((a) => (a.id === id ? { ...a, ...p } : a)));
    setDirty(true);
  };

  const addCustom = () => {
    const id = uid();
    setList((l) => [...l, {
      id,
      name: `自定义${l.filter((x) => !x.builtin).length + 1}`,
      builtin: '',
      icon: '🧩',
      showContextMenu: true,
      showSidebar: false,
      shortcut: null,
      project: null,
      group: null,
      client: null,
    }]);
    setActive(id);
    setDirty(true);
  };

  const remove = (id: string) => {
    const t = list.find((a) => a.id === id);
    if (!t || t.builtin) return;
    setList((l) => l.filter((a) => a.id !== id));
    if (active === id) setActive(list.find((a) => a.id !== id)?.id ?? '');
    setDirty(true);
  };

  /** 上移 / 下移：列表顺序即展示与右键菜单顺序 */
  const move = (id: string, delta: number) => {
    setList((l) => {
      const i = l.findIndex((a) => a.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= l.length) return l;
      const n = [...l];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.saveChainActions(list);
      setList(saved);
      setDirty(false);
      onLog('连锁动作已保存');
      onChanged?.();
    } catch (e) {
      onLog(`保存失败：${errText(e)}`, true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="连锁动作"
      onClose={onClose}
      width={720}
      guardClose={dirty && !saving}
      footer={
        <>
          <button className="p-btn" onClick={addCustom}>＋ 自定义动作</button>
          <span style={{ flex: 1 }} />
          <button className="p-btn" onClick={onClose}>关闭</button>
          <button className="p-btn primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="p-muted" style={{ marginBottom: 'var(--sp-5, 10px)' }}>
        每个动作分别有「项目」和「项目组」两份指令模板，发送时按对象类型取用。
        留空表示使用内置默认模板；自定义动作若两份都空，发送时会提示先补写。
      </div>

      <div className="fpx-ca-wrap">
        <div className="fpx-ca-list">
          {list.map((a, i) => (
            <div
              key={a.id}
              className={`fpx-ca-item${a.id === active ? ' on' : ''}`}
              onClick={() => setActive(a.id)}
            >
              <span className="fpx-ca-icon">{a.icon}</span>
              <span className="fpx-ca-name">
                {a.name}
                {!a.builtin && <span className="fpx-badge dim" style={{ marginLeft: 'var(--sp-3, 6px)' }}>自定义</span>}
              </span>
              <span className="fpx-ca-ops">
                <button title="上移" disabled={i === 0} onClick={(e) => { e.stopPropagation(); move(a.id, -1); }}>↑</button>
                <button title="下移" disabled={i === list.length - 1} onClick={(e) => { e.stopPropagation(); move(a.id, 1); }}>↓</button>
              </span>
            </div>
          ))}
        </div>

        <div className="fpx-ca-detail">
          {!cur ? (
            <div className="p-muted">左侧选一个动作</div>
          ) : (
            <>
              <div className="fpx-field">
                <label>名称</label>
                <input className="p-input" value={cur.name}
                  onChange={(e) => patch(cur.id, { name: e.target.value })} />
              </div>

              <div className="fpx-field">
                <label>图标</label>
                <div className="fpx-emojis">
                  {ICONS.map((em) => (
                    <button
                      key={em}
                      className={`fpx-emoji${cur.icon === em ? ' on' : ''}`}
                      onClick={() => patch(cur.id, { icon: em })}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>

              <div className="fpx-field">
                <label>专属客户端（留空 = 跟随全局默认）</label>
                <select
                  className="p-input"
                  value={cur.client ?? ''}
                  onChange={(e) => patch(cur.id, { client: e.target.value || null })}
                >
                  <option value="">（跟随全局默认）</option>
                  {/* 已存的值可能不在当前检测列表里（客户端被卸载、或手动改过配置），
                      补一个同名选项，否则下拉会显示成空、像是没设置 */}
                  {cur.client && !clients.some((c) => c.id === cur.client) && (
                    <option value={cur.client}>{cur.client}（已不再检测到）</option>
                  )}
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.installed ? '' : '（未检测到）'}
                    </option>
                  ))}
                </select>
              </div>

              <label className="fpx-check">
                <input type="checkbox" checked={cur.showContextMenu}
                  onChange={(e) => patch(cur.id, { showContextMenu: e.target.checked })} />
                <span className="fpx-check-box">{cur.showContextMenu ? '✓' : ''}</span>
                <span>
                  <span className="fpx-check-title">加入卡片右键菜单</span>
                  <span className="fpx-check-sub">取消后只在「发送到 AI」面板里出现</span>
                </span>
              </label>

              <label className="fpx-check">
                <input type="checkbox" checked={cur.showSidebar}
                  onChange={(e) => patch(cur.id, { showSidebar: e.target.checked })} />
                <span className="fpx-check-box">{cur.showSidebar ? '✓' : ''}</span>
                <span>
                  <span className="fpx-check-title">挂到左侧栏</span>
                  <span className="fpx-check-sub">点它对当前选中的卡片执行该动作</span>
                </span>
              </label>

              <div className="fpx-field" style={{ marginTop: 'var(--sp-4, 8px)' }}>
                <label>快捷键（形如 Ctrl+Shift+1）</label>
                <div className="p-row">
                  <input
                    className="p-input"
                    placeholder="留空 = 不注册"
                    value={cur.shortcut ?? ''}
                    onChange={(e) => patch(cur.id, { shortcut: e.target.value || null })}
                    onKeyDown={(e) => {
                      // 直接按出来的组合键填进去，免得手打出拼写错误
                      if (e.key === 'Tab' || e.key === 'Enter') return;
                      e.preventDefault();
                      const parts: string[] = [];
                      if (e.ctrlKey) parts.push('Ctrl');
                      if (e.altKey) parts.push('Alt');
                      if (e.shiftKey) parts.push('Shift');
                      if (e.metaKey) parts.push('Meta');
                      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(k)) parts.push(k);
                      if (parts.length) patch(cur.id, { shortcut: parts.join('+') });
                    }}
                  />
                  <button
                    className="p-btn"
                    disabled={!cur.shortcut}
                    onClick={() => patch(cur.id, { shortcut: null })}
                  >
                    清除
                  </button>
                </div>
                <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-2, 4px)' }}>
                  在此框内直接按下组合键即可录入。属于「应用级」快捷键：
                  窗口在前台时生效，不是操作系统全局热键。
                </div>
              </div>

              <div className="fpx-field" style={{ marginTop: 'var(--sp-5, 10px)' }}>
                <label>项目模板</label>
                <textarea
                  className="p-input fpx-textarea"
                  rows={6}
                  placeholder="留空使用内置默认模板"
                  value={cur.project ?? ''}
                  onChange={(e) => patch(cur.id, { project: e.target.value || null })}
                />
              </div>

              <div className="fpx-field">
                <label>项目组模板</label>
                <textarea
                  className="p-input fpx-textarea"
                  rows={6}
                  placeholder="留空使用内置默认模板"
                  value={cur.group ?? ''}
                  onChange={(e) => patch(cur.id, { group: e.target.value || null })}
                />
              </div>

              <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
                占位符：{ '{path}' } 路径、{ '{name}' } 文件夹名。
                也兼容原版写法 { '{项目路径}' } / { '{项目名称}' }。
              </div>

              {!cur.builtin && (
                <button className="p-btn danger" style={{ marginTop: 'var(--sp-6, 12px)' }}
                  onClick={() => remove(cur.id)}>
                  删除该自定义动作
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
