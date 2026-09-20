import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import type { CardKind, IconGroup } from '../types';
import { ColorPicker } from '../../color-picker/ColorPicker';
import { DirDialog } from './DirDialog';
import { PresetIconGrid } from './PresetIconGrid';
import { CheckLine, Modal } from './ui';
import { prompt } from '../../../js/dialog.js';
import { LOCK_PRESETS, applyPreset, presetOf, CUSTOM_PRESET_ID } from '../utils/lockPresets';

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
  path, denyDelete, denyWrite, accountOnly, onClose, onApply,
  watchEnabled, onWatchChange,
}: {
  path: string;
  denyDelete: boolean;
  denyWrite: boolean;
  /** 「账面固定」（#21）：与 ACL 是两件事，可选以兼容旧调用点 */
  accountOnly?: boolean;
  onClose: () => void;
  onApply: (denyDelete: boolean, denyWrite: boolean, accountOnly: boolean) => void;
  /* #23 弹窗内的「监控告警」开关。
     设为可选：这个弹窗也可能在没有监控上下文的地方被复用。
     不传就不渲染，而不是渲染一个点了没用的开关 ——
     后者会让用户以为点了生效，实际什么也没发生。 */
  watchEnabled?: boolean;
  onWatchChange?: (on: boolean) => void;
}) {
  const [dd, setDd] = useState(denyDelete);
  const [dw, setDw] = useState(denyWrite);
  const [ao, setAo] = useState(!!accountOnly);
  /** 当前档位由开关推导，不单独存 state —— 存了就会和开关漂移 */
  const cur = presetOf(dd, dw, ao);

  /**
   * 点档位 = **整体设为这一档**（含清掉档外选项），不是叠加。
   * 若只叠加，从「防删除」切到「防写入」会变成两个都开，
   * 用户以为切了档，实际保护越来越重，而且界面上看不出来。
   */
  const pick = (id: string) => {
    const next = applyPreset(id);
    if (!next) return;
    setDd(next.denyDelete);
    setDw(next.denyWrite);
    setAo(next.accountOnly);
  };

  return (
    <Modal
      title="文件夹保护（ACL）"
      onClose={onClose}
      footer={
        <>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button className="p-btn primary" onClick={() => { onApply(dd, dw, ao); onClose(); }}>应用</button>
        </>
      }
    >
      <div className="p-mono p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', wordBreak: 'break-all' }}>{path}</div>

      {/* #22 预设档位：四个组合都有名字，比"随便勾两个框"好认。 */}
      <div className="fpx-lock-presets">
        {LOCK_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`fpx-lock-preset${cur === p.id ? ' active' : ''}`}
            title={p.hint}
            onClick={() => pick(p.id)}
          >
            <span className="fpx-lock-preset-name">{p.label}</span>
            <span className="fpx-lock-preset-flags">
              {p.accountOnly ? '仅标记' : ''}
              {!p.accountOnly && p.denyDelete ? '防删' : ''}
              {!p.accountOnly && p.denyDelete && p.denyWrite ? ' · ' : ''}
              {!p.accountOnly && p.denyWrite ? '防写' : ''}
              {!p.accountOnly && !p.denyDelete && !p.denyWrite ? '—' : ''}
            </span>
          </button>
        ))}
      </div>
      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-5, 10px)' }}>
        {cur === CUSTOM_PRESET_ID
          ? '当前是自定义组合（不在预设档位内）'
          : (LOCK_PRESETS.find((p) => p.id === cur)?.hint ?? '')}
      </div>

      {/* #23 监控告警：与保护设置放在一起才顺手 ——
          设完保护接着就会想"要不要盯着它"。
          放在弹窗里而不是只在设置页：那两件事本来就是一次决定的。 */}
      {onWatchChange && (
        <div className="fpx-lock-watch">
          <CheckLine
            checked={!!watchEnabled}
            onChange={onWatchChange}
            title="监控告警"
            subtitle="定期轮询该目录，被外部改动时告警"
          />
        </div>
      )}

      {/* #21 账面固定：与两个 ACL 档位并列但含义不同 ——
          它不改系统权限，只是登记一个"别乱动"的标记。
          两者**互不排斥**（可以既固定又上 ACL），故做成独立勾选项
          而不是一个互斥档位，避免用户以为"选了固定就不能上锁"。 */}
      <CheckLine
        checked={ao}
        onChange={setAo}
        title="账面固定（仅登记，不设系统权限）"
        subtitle="不动 ACL，也不需要管理员权限；只在界面上标出这一项已定下来"
      />
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
  api, files, groups, onGroupsChange, onClose, onPick, onImported, onLog, onRenamed,
  target, following, onFollowChange, modeless,
}: {
  api: Api;
  files: string[];
  groups: IconGroup[];
  onGroupsChange: (next: IconGroup[]) => void;
  onClose: () => void;
  /** 选中一个图标。第二个参数是 #13 的「仅界面内生效」 */
  onPick: (path: string, guiOnly: boolean) => void;
  onImported: (files: string[]) => void;
  onLog: (m: string, isError?: boolean) => void;
  /** 改名成功：回传新图标列表与同步了多少张卡片 */
  onRenamed: (icons: string[], affected: number) => void;
  /**
   * 当前作用对象（#8 `UpdateTarget`）。
   *
   * **换目标时浏览状态一律保留**：正在看哪个页签、哪个分组、滚到哪，
   * 都不该因为换了张卡片就重置 —— 否则给一批卡片连续设图标时，
   * 每点一张就要重新找一遍分组，非模态反而更累。
   *
   * 这也是为什么**宿主不能用 `key={target.path}` 渲染本组件**：
   * key 一变 React 会整个重建实例，state 全丢，上面那段就白写了。
   */
  target: { path: string; name: string } | null;
  /** 是否跟随选中卡片变化 */
  following: boolean;
  onFollowChange: (v: boolean) => void;
  /** 非模态常驻：开着也能点背后的卡片 */
  modeless?: boolean;
}) {
  const [tab, setTab] = useState<'preset' | 'mine'>('preset');
  /* #13 两套图标的选择。默认 false = 资源管理器那套（保持原有行为）。 */
  const [guiOnly, setGuiOnly] = useState(false);
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

  /**
   * #10 图标改名。
   *
   * 后端会同步 `folder_icons` 里引用了这个图标的卡片 ——
   * 所以提示里**必须报出 affected**：用户改一个图标名，
   * 可能有 N 张卡片的图标跟着改了。静默完成会让人以为只有这个文件动了。
   */
  const renameIcon = async (full: string) => {
    const cur = (full.split(/[\\/]/).pop() ?? full).replace(/\.(ico|png|jpe?g|bmp)$/i, '');
    const raw = await prompt({ title: '重命名图标', label: '图标名', defaultValue: cur });
    const name = (raw ?? '').trim();
    if (!name || name === cur) return;
    try {
      const r = await api.renameIcon(full, name);
      onRenamed(r.icons, r.affected);
      onLog(r.affected > 0
        ? `已改名为「${name}」，并同步更新 ${r.affected} 张卡片的图标引用`
        : `已改名为「${name}」`);
    } catch (e) {
      onLog(`改名失败：${errText(e)}`, true);
    }
  };

  return (
    <Modal title="选择图标" onClose={onClose} width={620} modeless={modeless}>
      {/*
        #8 目标条：**必须让用户看见当前作用于谁**。
        非模态下点背后的卡片就会换目标，看不见的话
        用户以为在给 A 设图标，实际设到了 B —— 而且没有任何提示。
      */}
      {/*
        #13 两套图标的开关。
        **必须让用户知道自己在改哪一套**：改错了表现为
        "界面变了、资源管理器没变"或反之，而用户只会以为功能没生效。
      */}
      <label className="fpx-icongui">
        <input
          type="checkbox"
          checked={guiOnly}
          onChange={(e) => setGuiOnly(e.target.checked)}
        />
        <span>
          仅界面内生效
          <span className="fpx-icongui-hint">
            （{guiOnly
              ? '只改界面这套，资源管理器图标不变'
              : '改资源管理器这套，界面同步显示'}）
          </span>
        </span>
      </label>

      <div className="fpx-icontarget">
        <span className="fpx-icontarget-label">当前目标</span>
        {target
          ? <span className="fpx-icontarget-name" title={target.path}>{target.name}</span>
          : <span className="fpx-icontarget-none">未选中卡片</span>}
        <button
          className={`p-btn mini${following ? ' primary' : ''}`}
          onClick={() => onFollowChange(!following)}
          title={following
            ? '正在跟随选中的卡片：点卡片即可换目标。点此锁定为当前卡片'
            : '已锁定：换选中卡片也不会换目标。点此恢复跟随'}
        >
          {following ? '跟随中' : '已锁定'}
        </button>
      </div>
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
          onPick={(p) => { onPick(p, guiOnly); onClose(); }}
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
              <div className="fpx-iconwrap" key={f}>
              <button
                className="fpx-icontile"
                title={f}
                onClick={() => { onPick(f, guiOnly); onClose(); }}
              >
                {thumbs[f]
                  ? <img src={thumbs[f]} alt={name} />
                  : <span className="fpx-icontile-ph">{(name.slice(0, 1)).toUpperCase()}</span>}
                <span className="fpx-iconcap">{name.replace(/\.(ico|png|jpe?g|bmp)$/i, '')}</span>
              </button>
              {/*
                #10 改名按钮。
                **平时必须 pointer-events: none** —— 只压 opacity 的话，
                看不见的按钮依然可以点（与 #116 同一个坑）：
                用户以为点的是图标（选用），实际触发了改名。
              */}
              <button
                className="fpx-icon-rename"
                title="重命名这个图标"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); void renameIcon(f); }}
              >
                ✎
              </button>
              </div>
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

/**
 * #83 移除卡片：三个"保留"勾选。
 *
 * 默认是**全保留** —— 与改造前行为一致（此前只摘页签、其它一律留着）。
 * 不这么做的话，用户升级后按老习惯移除，会连带删掉链接和图标，而界面上无从察觉。
 *
 * 「保留链接」只对项目卡显示：链接是项目→项目组的 junction，项目组卡没有。
 */
export function RemoveCardDialog({
  card, kind, onClose, onConfirm,
}: {
  card: { path: string; name: string };
  kind: 'project' | 'group';
  onClose: () => void;
  onConfirm: (keep: { link: boolean; icon: boolean; color: boolean }) => void;
}) {
  const [keepLink, setKeepLink] = useState(true);
  const [keepIcon, setKeepIcon] = useState(true);
  const [keepColor, setKeepColor] = useState(true);

  return (
    <Modal title="移除卡片" onClose={onClose} width={420}>
      <div className="p-mono p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', wordBreak: 'break-all' }}>
        {card.name}
      </div>
      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-5, 10px)' }}>
        取消勾选即同时清理对应痕迹。
      </div>
      <div className="fpx-removekeep">
        {kind === 'project' && (
          <CheckLine
            checked={keepLink}
            onChange={() => setKeepLink(!keepLink)}
            title="保留链接"
            subtitle="取消则撤销该项目到项目组的链接（删 junction）"
          />
        )}
        <CheckLine
          checked={keepIcon}
          onChange={() => setKeepIcon(!keepIcon)}
          title="保留图标"
          subtitle="取消则清除该卡片的图标登记（两套一起清）"
        />
        <CheckLine
          checked={keepColor}
          onChange={() => setKeepColor(!keepColor)}
          title="保留标签色"
          subtitle="取消则清除该卡片的标签色（两套一起清）"
        />
      </div>
      <div className="p-row" style={{ marginTop: 'var(--sp-6, 12px)', justifyContent: 'flex-end' }}>
        <button className="p-btn" onClick={onClose}>取消</button>
        <button
          className="p-btn danger"
          onClick={() => { onConfirm({ link: keepLink, icon: keepIcon, color: keepColor }); onClose(); }}
        >
          移除
        </button>
      </div>
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
  /** #13/#113 第二个参数是 guiOnly：决定改界面那套还是资源管理器那套 */
  onApply: (icon: string | null, color: string | null, guiOnly: boolean) => void;
  onSaveCustom: (colors: string[]) => void;
  onPickIconFile: () => void;
  onLog: (msg: string, isError?: boolean) => void;
}) {
  const [ic, setIc] = useState(icon ?? '');
  const [cl, setCl] = useState<string | null>(color);
  /* #13/#113 两套：默认改资源管理器那套（保持原有行为） */
  const [guiOnly, setGuiOnly] = useState(false);
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
          <button className="p-btn" onClick={() => { onApply(null, null, guiOnly); onClose(); }}>清除</button>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button className="p-btn primary" onClick={() => { onApply(ic.trim() || null, cl, guiOnly); onClose(); }}>
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
        {/* 不传 api：色盘已移到共享插件，取色走它自己的 ctx.invoke。
            继续传会是 TS 报错（组件 props 里没有这一项），
            也是"插件已交出去、调用方还按旧签名用"的残留。 */}
        <ColorPicker
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
