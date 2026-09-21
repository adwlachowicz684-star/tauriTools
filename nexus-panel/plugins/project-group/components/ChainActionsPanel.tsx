import { useEffect, useRef, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import { canRemove, defaultIconOf, defaultNameOf } from '../utils/chainBuiltins';
import type { ChainAction, ChainClient } from '../types';
import { PlaceholderBar } from './PlaceholderBar';
/* #147 模板框高度自适应：与 #146 图标网格共用同一个测量 hook */
import { useAvailableHeight } from '../hooks/useAvailableHeight';
/* #148 连锁动作重排：与卡片/页签/图标共用同一套索引纠偏与半区判定，
   不另写一份 —— 各写一份的话改了那边的边界处理这里就会悄悄不一致。 */
import {
  ACTION_DRAG_MIME, parseActionDrag, resolveMoveIndex,
  gapIndexAtDeadZone, clampAcrossFixedWall,
} from '../utils/dragSort';
import { Modal } from './ui';

/** 自定义动作的候选图标（内置四个动作的图标不在此列，避免重复观感）。 */
const ICONS = ['💬', '🔍', '🗜', '🚀', '🧪', '📦', '🧹', '📝', '🔧', '🧭', '⚡', '🧩'];

const uid = () => `c${Math.random().toString(16).slice(2, 10)}`;

/**
 * 连锁动作换位死区基准（原版 `AcSwapDeadZone = 14.0`）。
 *
 * 与分类框那个（默认 8）不同：连锁动作是纵向列表、项更矮，
 * 死区太小起不到"防手抖"的作用。
 */
const AC_SWAP_DEAD_ZONE = 14;

/**
 * 连锁动作管理：内置四项 + 自定义，增删改排序，每个动作可分别设项目/项目组两份模板。
 *
 * 内置项不提供删除——后端会在读取时自动补齐被删掉的内置项，
 * 与其给一个"删了又冒出来"的按钮，不如直接不给这个入口。
 * 自定义动作可以改模板后保留、也可删除。
 */
export function ChainActionsPanel({
  api, onClose, onLog, onChanged, devMode = false,
}: {
  api: Api;
  onClose: () => void;
  onLog: (m: string, isError?: boolean) => void;
  /** 保存成功后通知外层重新拉清单（右键菜单 / 侧边栏用的是外层的那份） */
  onChanged?: () => void;
  /** 开发者模式（#46）：开启后才允许删除内置动作 */
  devMode?: boolean;
}) {
  const [list, setList] = useState<ChainAction[]>([]);
  const [clients, setClients] = useState<ChainClient[]>([]);
  const [active, setActive] = useState<string>('chain');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  /* 两个模板编辑框的 ref：占位符要插到光标处，必须拿到元素读 selectionStart。
     各自一份，否则在项目模板里点按钮会插到项目组模板的光标位置。 */
  const projectTplRef = useRef<HTMLTextAreaElement>(null);
  /*
   * #147 两个模板框：面板拉高时跟着拉高，最扁不低于 140。
   *
   * 必须在 ref 声明**之后**调用 —— hook 里要读 projectTplRef 这个 const，
   * 写在它之前会撞 TDZ（Cannot access 'projectTplRef' before initialization），
   * 而且这是运行时报错、不是编译错误，tsc 也未必抓得到。
   */
  const projectTplH = useAvailableHeight(projectTplRef, { minHeight: 140, bottomGap: 16 });
  const groupTplRef = useRef<HTMLTextAreaElement>(null);
  const groupTplH = useAvailableHeight(groupTplRef, { minHeight: 140, bottomGap: 16 });

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

  /**
   * 删除（#46）。
   *
   * 内置动作默认拦住：`ensure_actions` 只在清单**为空**时才重建内置四项，
   * 所以删掉一个之后它不会自己回来 —— 用户只会看到常用入口少了，
   * 且无从恢复（除非开开发者模式再手工建一个同 id 的）。
   * 开发者模式是那道"我知道我在做什么"的闸门。
   */
  const remove = (id: string) => {
    const t = list.find((a) => a.id === id);
    if (!t) return;
    if (!canRemove(t.builtin, devMode)) return;
    setList((l) => l.filter((a) => a.id !== id));
    if (active === id) setActive(list.find((a) => a.id !== id)?.id ?? '');
    setDirty(true);
  };

  /** 上移 / 下移：列表顺序即展示与右键菜单顺序 */
  /* #148 / #149 拖拽重排：拖起的是哪个、当前落点缝隙（-1 为无） */
  const [dragId, setDragId] = useState<string | null>(null);
  const [actGap, setActGap] = useState(-1);

  /*
   * 固定墙的下界：最后一个内置项之后。
   *
   * 用"最后一个内置项 + 1"而不是"内置项个数"——
   * 万一顺序被打乱（开发者模式删过内置项），按个数算会把自定义项
   * 硬挤到错误的位置。
   */
  const minGap = (l: ChainAction[]): number => {
    let last = -1;
    for (let k = 0; k < l.length; k++) if (l[k].builtin) last = k;
    return last + 1;
  };

  /** 把某个 id 移到落点缝隙 k（复用卡片/页签那套"先移除再插入"的纠偏） */
  const dropActionAt = (id: string, k: number) => {
    setList((l) => {
      const from = l.findIndex((a) => a.id === id);
      if (from < 0 || k < 0 || k > l.length) return l;
      const to = resolveMoveIndex(from, k, l.length);
      const fixed = l.map((a) => !!a.builtin);
      const to2 = clampAcrossFixedWall(from, to, fixed);
      if (to2 === from) return l;   // 原地放下：什么都不做（#103 同源）
      const n = [...l];
      const [it] = n.splice(from, 1);
      n.splice(to2, 0, it);
      return n;
    });
    setDirty(true);
  };

  /*
   * ↑↓ 按钮也受固定墙约束。
   *
   * 两条路（按钮 / 拖拽）规则必须一致：若按钮能把自定义项挪到内置项之间
   * 而拖拽不能，用户会用按钮做到一个"刷新就弹回"的状态，
   * 且永远不会知道为什么 —— 那比两条路都不能更糟。
   *
   * 越界的方向由 delta 决定：上移越过 i-1，下移越过 i+1。
   */
  const crossedIsFixed = (l: ChainAction[], i: number, delta: number): boolean => {
    const c = delta < 0 ? i - 1 : i + 1;
    return c >= 0 && c < l.length && !!l[c].builtin;
  };

  const move = (id: string, delta: number) => {
    const i = list.findIndex((a) => a.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    if (crossedIsFixed(list, i, delta)) return;
    const n = [...list];
    [n[i], n[j]] = [n[j], n[i]];
    setList(n);
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
            /* #149 插入条：画在**缝隙**上（每项之前），落点在哪儿一目了然。
               只在拖拽中渲染 —— 平时显示一条横线会让人以为哪里错了。 */
            <div key={a.id}>
              {dragId && actGap === i && dragId !== a.id && (
                <div className="fpx-ca-gap" />
              )}
              <div
                className={`fpx-ca-item${a.id === active ? ' on' : ''}${
                  dragId === a.id ? ' dragging' : ''}`}
                /* #148 除了 ↑↓ 按钮，还可以直接拖 —— 按钮调一次动一格，
                   跨好几格要点很多次。
                   内置项不可拖：后端按固定顺序重建它们，拖了也会弹回去。 */
                draggable={!a.builtin}
                title={a.builtin ? '内置动作位置固定，不可拖动' : '拖动可调整顺序'}
                onDragStart={(e) => {
                  if (a.builtin) return;
                  e.dataTransfer.setData(ACTION_DRAG_MIME, JSON.stringify({ id: a.id }));
                  /* 拖影用默认即可，但必须设 effect，否则部分浏览器不触发 drop */
                  e.dataTransfer.effectAllowed = 'move';
                  setDragId(a.id);
                }}
                onDragEnd={() => { setDragId(null); setActGap(-1); }}
                onDragOver={(e) => {
                  const id = parseActionDrag(e.dataTransfer.getData(ACTION_DRAG_MIME))
                    ?? dragId;
                  if (!id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  /* 用 rect 判定前后半区，不用 offsetY —— 项里有 <span>，
                     指针落在它上面时 offsetY 会跳变（与 #115 同一个坑） */
                  const r = e.currentTarget.getBoundingClientRect();
                  /*
                   * 死区（原版 AcSwapDeadZone）：**返回 null 就不更新**。
                   * 直接 setActGap(null) 会把插入条清掉，
                   * 表现是"拖着不动时插入条一闪一闪"，反而更晃眼。
                   */
                  const g = gapIndexAtDeadZone(
                    { top: r.top, height: r.height }, e.clientY, i, AC_SWAP_DEAD_ZONE,
                  );
                  if (g === null) return;
                  /* 夹紧到固定墙之后：插入条也不该出现在内置区域的缝隙上 */
                  setActGap(Math.max(minGap(list), g));
                }}
                onDrop={(e) => {
                  const id = parseActionDrag(e.dataTransfer.getData(ACTION_DRAG_MIME));
                  /* #103 同源：先解析、确认有效才 preventDefault。
                     否则无效放置也走"被接受"路径，浏览器不给回弹动画 ——
                     拖影直接消失、界面毫无变化，用户以为放下去了。 */
                  if (!id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  const g = gapIndexAtDeadZone(
                    { top: r.top, height: r.height }, e.clientY, i, AC_SWAP_DEAD_ZONE,
                  );
                  /* 死区内没算出新落点 → 用保持着的那个；一个都没有就是原地 */
                  const k = g === null ? actGap : Math.max(minGap(list), g);
                  if (k < 0) return;
                  dropActionAt(id, k);
                  setDragId(null);
                  setActGap(-1);
                }}
                onClick={() => setActive(a.id)}
              >
                <span className="fpx-ca-icon">{a.icon}</span>
                <span className="fpx-ca-name">
                  {a.name}
                  {!a.builtin && <span className="fpx-badge dim" style={{ marginLeft: 'var(--sp-3, 6px)' }}>自定义</span>}
                </span>
                <span className="fpx-ca-ops">
                  {/* 到边、或那一侧是内置项 → 直接灰掉。
                      灰掉比"点了没反应"好：后者用户会以为界面坏了。 */}
                  <button
                    title={i > 0 && list[i - 1].builtin ? '上一位是内置动作，位置固定' : '上移'}
                    disabled={i === 0 || (i > 0 && !!list[i - 1].builtin)}
                    onClick={(e) => { e.stopPropagation(); move(a.id, -1); }}
                  >↑</button>
                  <button
                    title={i < list.length - 1 && list[i + 1].builtin ? '下一位是内置动作，位置固定' : '下移'}
                    disabled={i === list.length - 1 || (i < list.length - 1 && !!list[i + 1].builtin)}
                    onClick={(e) => { e.stopPropagation(); move(a.id, 1); }}
                  >↓</button>
                </span>
              </div>
            </div>
          ))}
          {/* 末尾那条缝隙：拖到最后一项下半区时落点在列表末尾 */}
          {dragId && actGap === list.length && <div className="fpx-ca-gap" />}
        </div>

        <div className="fpx-ca-detail">
          {!cur ? (
            <div className="p-muted">左侧选一个动作</div>
          ) : (
            <>
              <div className="fpx-field">
                <label>名称</label>
                <div className="p-row">
                  <input className="p-input" value={cur.name}
                    onChange={(e) => patch(cur.id, { name: e.target.value })} />
                  {/* 只有内置动作有"默认名"可回退；自定义动作的名字就是用户自己起的 */}
                  {defaultNameOf(cur.builtin) && (
                    <button
                      className="p-btn"
                      style={{ height: 32, padding: '0 10px' }}
                      title={`恢复为默认名称「${defaultNameOf(cur.builtin)}」`}
                      onClick={() => patch(cur.id, { name: defaultNameOf(cur.builtin) })}
                    >
                      恢复默认
                    </button>
                  )}
                </div>
              </div>

              <div className="fpx-field">
                {/* 图标 + 恢复默认（#47）。
                    网格直接铺在这里而不是再开一层弹窗：动作不多、图标就十来个，
                    多一次点击只会更烦。真正的缺口是"改乱了没法回退"，所以补恢复默认。 */}
                <div className="p-row" style={{ justifyContent: 'space-between' }}>
                  <label style={{ margin: 0 }}>图标</label>
                  <button
                    className="p-btn"
                    style={{ height: 26, padding: '0 8px' }}
                    title="把图标恢复为默认值（内置动作回到出厂图标，自定义动作回到 🧩）"
                    onClick={() => patch(cur.id, { icon: defaultIconOf(cur.builtin) })}
                  >
                    恢复默认
                  </button>
                </div>
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
                  ref={projectTplRef}
                  className="p-input fpx-textarea"
                  rows={6}
                  /* #147 面板拉高时跟着拉高；量不到时 rows=6 仍是兜底。
                     最扁不低于 140 —— 再矮就看不清"这是一个模板框"了。 */
                  style={projectTplH ? { height: projectTplH } : undefined}
                  placeholder="留空使用内置默认模板"
                  value={cur.project ?? ''}
                  onChange={(e) => patch(cur.id, { project: e.target.value || null })}
                />
                <PlaceholderBar
                  targetRef={projectTplRef}
                  value={cur.project ?? ''}
                  onChange={(v) => patch(cur.id, { project: v || null })}
                />
              </div>

              <div className="fpx-field">
                <label>项目组模板</label>
                <textarea
                  ref={groupTplRef}
                  className="p-input fpx-textarea"
                  rows={6}
                  style={groupTplH ? { height: groupTplH } : undefined}
                  placeholder="留空使用内置默认模板"
                  value={cur.group ?? ''}
                  onChange={(e) => patch(cur.id, { group: e.target.value || null })}
                />
                <PlaceholderBar
                  targetRef={groupTplRef}
                  value={cur.group ?? ''}
                  onChange={(v) => patch(cur.id, { group: v || null })}
                />
              </div>

              <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
                点上面的按钮可在光标处插入占位符（有选中时替换选中部分）。
                <code>{ '{path}' }</code> / <code>{ '{name}' }</code> 是本插件写法，
                原版写法 <code>{ '{项目路径}' }</code> / <code>{ '{项目名称}' }</code> 同样支持，
                可直接粘贴旧模板过来。未识别的 <code>{ '{\u2026}' }</code> 原样保留。
              </div>

              {canRemove(cur.builtin, devMode) && (
                <button className="p-btn danger" style={{ marginTop: 'var(--sp-6, 12px)' }}
                  onClick={() => remove(cur.id)}>
                  {cur.builtin ? '删除该内置动作（开发者模式）' : '删除该自定义动作'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
