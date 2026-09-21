import { useEffect, useRef, useState } from 'react';
import {
  toolbarEntriesOf, wantsEntry, hiddenIds, extraIds,
  toggleHidden, addExtra, removeExtra,
} from '../../js/toolbar-plugin.js';
import { useNexus } from '../../src/nexus-react';
import type { PluginManifest } from '../../js/host.js';
import { setPluginOrder } from '../../js/host.js';
import { useDragReorder } from '../../js/drag-reorder-react.js';
import {
  listThemes, applyTheme, setAccent, setEnvColor, resetColors,
  getThemeId, getAccent, getEnvColor, getBase,
  getHueShift, getLightShift, setThemeShift,
  /* 单项复位：把「恢复默认」做成每个调节项各自的小按钮，
     而不是一个"恢复主题自带配色"大按钮 ——
     用户只想把色相调回 0 时，不该连强调色一起丢掉。 */
  resetAccent, resetEnvColor, resetHueShift, resetLightShift,
  /* 背景图 */
  supportsBgImage, getBgImage, setBgImage, resetBgImage,
  saveAsCustom, deleteCustomTheme,
  // getCurrent：色相/明暗改为按主题各记一份后，提示文案要显示当前主题名
  getCurrent,
  getCustomColors, saveCustomColors,
  onChange as onThemeChange,
} from '../../js/theme-manager.js';
import { swatchFor, styleLabel } from '../../js/themes.js';
import {
  ADAPT_POLICIES, PLUGIN_THEMES,
  getPolicy, setPolicy, getPluginOverride, setPluginOverride,
} from '../../js/theme-normalizer.js';
import { auditPlugin, summarize, LEVEL_ORDER } from '../../js/style-audit.js';
import ExternalCard from './ExternalCard';
import FilesCard from './FilesCard';
import WindowCard from './WindowCard';
import { prompt } from '../../js/dialog.js';
import { SHELL_SHORTCUT_SPECS, shellComboSet, normCombo } from '../../js/shell-shortcuts.js';

type TabKey = 'theme' | 'plugins' | 'external' | 'files' | 'shortcuts' | 'window' | 'about';

/**
 * 取外壳全局单例：本设置页是 iframe 插件，开启严格沙箱后 window.__NEXUS__
 * 取不到，要降级读宿主的 parent（同文件外链管理、ExternalCard.tsx 都是这个写法）。
 * 隔离态（opaque origin）下连 parent 也访问不了，会抛 SecurityError，必须 try/catch。
 */
function shellGlobal(): any {
  try {
    return (window as any).__NEXUS__
      ?? (window.parent !== window ? (window.parent as any)?.__NEXUS__ : null)
      ?? null;
  } catch {
    return null; // 跨源 / 隔离态下访问 parent 抛 SecurityError
  }
}

const TABS: [TabKey, string][] = [
  ['theme', '主题'],
  ['plugins', '插件'],
  ['external', '外链'],
  ['files', '文件'],
  ['shortcuts', '快捷键'],
  ['window', '窗口'],
  ['about', '关于'],
];

/**
 * 样式审计徽标。
 *
 * 三种状态：
 *   · 未检测（module 插件 / 隔离态读不到 CSS）—— 灰字，点开说明原因
 *   · 无冲突 —— 一个 ✓，不抢眼
 *   · 有冲突 —— 按 error / warn 显示数量，点击展开逐条列出
 *
 * 冲突文案直接来自 style-audit.js 的规则，那里写了**为什么错**和**实际后果**，
 * 所以这里不用再解释一遍。
 */
function StyleAuditBadge({ audit, open, onToggle }: {
  audit: any; open: boolean; onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);

  /* 还没跑到（异步）或拿不到样式 */
  const undetected = audit === undefined || audit === null;
  const issues = (audit?.issues || []).slice().sort(
    (a: any, b: any) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9));
  const c = summarize(issues);
  const bad = c.error + c.warn;

  const color = undetected ? 'var(--text-mute)'
    : c.error ? 'var(--danger)'
    : c.warn ? 'var(--warn)' : 'var(--ok)';

  const label = undetected ? '样式 —'
    : bad === 0 ? '样式 ✓'
    : `样式 ${bad}`;

  return (
    /* p-slot-audit：定宽格。徽标文案在「样式 ✓」「样式 12」「样式 —」之间变化，
       不锁宽的话右侧的主题下拉框会跟着左右跳 —— 详见 neumorphism.css。 */
    <div className="p-slot-audit" style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={undetected
          ? '未检测：同页插件没有独立样式文件，或沙箱隔离态下读不到'
          : `${c.error} 处错误 / ${c.warn} 处警告 / ${c.info} 条提示`}
        style={{
          height: 30, padding: '0 10px', fontSize: 'var(--fs-12, 12px)',
          borderRadius: 'var(--r-xs)', cursor: 'pointer',
          border: `1px solid ${hover ? color : 'var(--divider)'}`,
          background: 'transparent', color,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </button>

      {open ? (
        <div style={{
          position: 'absolute', right: 0, top: 34, zIndex: 'var(--z-menu)' as any,
          width: 400, maxHeight: 320, overflow: 'auto',
          padding: '10px 12px', borderRadius: 'var(--r-sm)',
          background: 'var(--surface-overlay)',
          border: '1px solid var(--divider)',
          boxShadow: 'var(--sh-cast-md)',
          fontSize: 'var(--fs-11, 11px)', lineHeight: 1.65,
        }}>
          {undetected ? (
            <div style={{ color: 'var(--text-dim)' }}>
              未检测。同页插件（module）没有独立的样式文档，
              或当前处于沙箱隔离态、读不到插件的 CSS 文件。
            </div>
          ) : issues.length === 0 ? (
            <div style={{ color: 'var(--ok)' }}>
              ✓ 未发现样式冲突（已扫描 {audit.files.join('、')}）
            </div>
          ) : (
            <>
              <div style={{ color: 'var(--text-dim)', marginBottom: 'var(--sp-3, 6px)' }}>
                扫描 {audit.files.join('、')} ·
                {' '}{c.error} 错误 / {c.warn} 警告 / {c.info} 提示
              </div>
              {issues.map((x: any, i: number) => (
                <div key={i} style={{
                  padding: '5px 0',
                  borderTop: i ? '1px solid var(--divider)' : 'none',
                }}>
                  <span style={{
                    color: x.level === 'error' ? 'var(--danger)'
                      : x.level === 'warn' ? 'var(--warn)' : 'var(--text-mute)',
                    marginRight: 'var(--sp-3, 6px)',
                  }}>
                    {x.level === 'error' ? '✕' : x.level === 'warn' ? '⚠' : 'ⓘ'}
                  </span>
                  <span style={{ color: 'var(--text)' }}>{x.msg}</span>
                  {x.line ? (
                    <span className="p-mono" style={{ color: 'var(--text-mute)', marginLeft: 'var(--sp-3, 6px)' }}>
                      L{x.line}
                    </span>
                  ) : null}
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 插件管理里的一行。
 *
 * 抽成组件是因为插件管理要**按 app / service 分两区渲染**，
 * 两区用的是同一套行渲染逻辑 —— 复制两份的话，
 * 将来给行加一个按钮就只会加在一处，另一区悄悄少一个。
 */
/**
 * 「恢复默认」小按钮。
 *
 * **始终渲染**，不是「改过了才显示」：按钮凭空出现会把同一行的滑块、
 * 数值、其它按钮一起挤开 —— 这就是刚修过的布局跳动，这里不能再犯一次。
 * 未偏离默认时 disabled —— 弱化但仍占位，布局纹丝不动。
 */
/**
 * 用户自选背景图的大小上限。
 *
 * 图片以 dataURL 存进 localStorage，而 localStorage 通常只有 ~5MB
 * 且是**整个应用共用**的 —— 一张 4MB 的壁纸 base64 后约 5.5MB，
 * 会把插件顺序、主题偏移等一并挤掉（写入静默失败，现象很难查）。
 * 1.5MB 足以放下压缩后的壁纸，又留得出余量。
 */
const MAX_BG_BYTES = 1.5 * 1024 * 1024;

function ResetDefaultBtn({ disabled, onClick, title }: {
  disabled: boolean; onClick: () => void; title?: string;
}) {
  return (
    <button
      className="p-btn"
      disabled={disabled}
      onClick={onClick}
      title={title || '恢复为当前主题的默认值'}
      style={{ flex: 'none', fontSize: 'var(--fs-11, 11px)', padding: '2px 8px' }}
    >
      ↺
    </button>
  );
}

function PluginRow({ p, audit, auditOpen, onToggleAudit, onOverride, onRemove, dragProps, dragging }: {
  p: PluginManifest;
  audit: any;
  auditOpen: boolean;
  onToggleAudit: () => void;
  onOverride: (v: string) => void;
  onRemove: () => void;
  /** 拖拽排序属性。服务插件区**不传** —— 它不在侧边栏，排了也没处生效 */
  dragProps?: Record<string, any>;
  dragging?: boolean;
}) {
  return (
    <div
      {...dragProps}
      /* className 放在 spread **之后**：内核也会返回 className（拖拽态），
         写在前面会被它覆盖，整行会丢掉 p-row 的样式。 */
      className={'p-row' + (dragging ? ' nx-drag-dragging' : '')}
      style={{
        padding: '12px 14px', marginTop: 'var(--sp-5, 10px)', borderRadius: 'var(--r)',
        background: 'var(--surface-sunk)',
        boxShadow: 'inset 3px 3px 6px var(--sh-dark), inset -3px -3px 6px var(--sh-light)',
      }}
    >
      {dragProps ? (
        <span className="nx-drag-handle" title="按住这里上下拖动可调整顺序">⠿</span>
      ) : null}
      <span style={{ fontSize: 'var(--fs-15, 15px)', width: 24, textAlign: 'center' }}>{p.icon ?? '◌'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-13, 13px)' }}>{p.name}</div>
        <div className="p-mono p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>{p.entry}</div>
      </div>
      <span className="p-tag">{p.type === 'iframe' ? '沙箱' : '同页'}</span>
      <StyleAuditBadge audit={audit} open={auditOpen} onToggle={onToggleAudit} />
      {/* 空串就是「跟随全局」：onOverride 的签名是 (v: string) => void，
          两处调用点再用 `v || null` 把它转成 null —— 这里补 `|| null` 是多余的，
          且会让 tsc 报「string | null 不能赋给 string」（上游 56f2607b 带进来的） */}
      <select
        className="p-input"
        style={{ width: 130, height: 30, fontSize: 'var(--fs-12, 12px)', padding: '0 8px' }}
        value={getPluginOverride(p.id) ?? ''}
        onChange={(e) => onOverride(e.target.value)}
      >
        <option value="">跟随全局</option>
        {PLUGIN_THEMES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
      {/*
        p-slot-act：定宽格。
        「内置」是 .p-tag、「移除」是 .p-btn.danger，两种形态宽度不同；
        而左侧名称列是 flex:1，会把这点宽度差全部转成右侧各格的位移 ——
        表现就是同一列的下拉框在内置行与非内置行之间左右错位。
      */}
      <span className="p-slot-act">
        {p.builtin ? (
          <span className="p-tag">内置</span>
        ) : (
          <button
            className="p-btn danger"
            style={{ height: 30, padding: '0 10px', fontSize: 'var(--fs-12, 12px)' }}
            onClick={onRemove}
          >
            移除
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * 右上角按钮（工具栏入口）管理。
 *
 * 之前这一区只是把 kind:'toolbar' 的插件列出来，**没有任何开关**：
 * 想隐藏某个按钮没地方点、想排序没地方拖、想把某个应用插件
 * 放到右上角更是没入口 —— 也就是"找不到地方添加按钮入口"。
 *
 * 这里提供三件事：显示/隐藏、上移/下移、把应用插件添加为入口。
 * 改完立刻生效（toolbar-plugin.js 派发事件，标题栏重新渲染）。
 *
 * ⚠️ 入口列表用 toolbarEntriesOf() 推导，与加载器**共用同一份判断** ——
 * 两边各写一遍必然漂移，表现是"设置里关掉了、右上角还在"。
 */
/**
 * 右上角按钮（工具栏入口）管理 —— 商店式卡片矩阵。
 *
 * 这里改过两版：
 *
 *   v1 只把 kind:'toolbar' 的列出来，**没有任何开关**；
 *   v2 补了开关，但"把应用插件加进来"是一个 <select> 下拉框。
 *
 * 下拉框的问题不是不好看，是**信息被切成两半**：
 *   · 下拉里只有"还没加入"的候选 —— 想确认某个插件加没加，
 *     得先去上面那排入口里找；两边各看一半才完整。
 *   · 一次只能看见一项，插件多了要逐个展开才知道有什么。
 *
 * v3（现在）：**所有插件各出一张卡**，像商店货架一样铺开。
 * 一张卡同时表达"它是什么"和"它现在处于什么状态"，
 * 卡片上两个按钮把两件事分开：
 *
 *   展示 / 隐藏   —— 已经在右上角了，要不要暂时不显示（保留位置与顺序）
 *   加入 / 取消   —— 要不要占一个右上角入口（取消不等于卸载插件）
 *
 * 这两个是**不同层次**，不是同一个开关的两种说法：
 * 隐藏保留配置（再点回来还在原位），取消加入则彻底没有这个入口。
 *
 * ⚠️ 入口列表用 toolbarEntriesOf() 推导，与加载器**共用同一份判断** ——
 * 两边各写一遍必然漂移，表现是"设置里关掉了、右上角还在"。
 */
function ToolbarSection({ plugins, ctx }: { plugins: any[]; ctx: any }) {
  const [, force] = useState(0);
  const rerender = () => force((v) => v + 1);

  const hidden = new Set(hiddenIds());
  const extra = new Set(extraIds());
  const entries = toolbarEntriesOf(plugins);
  const byId = new Map(entries.map((e) => [e.pluginId, e]));
  const rank = new Map(entries.map((e, i) => [e.pluginId, i]));

  /*
   * 已加入的按现有入口顺序排在最前，未加入的保持原序跟在后面。
   * Array.sort 是稳定排序，所以未加入那批不会互相打乱。
   *
   * 这样卡片矩阵本身就**体现了当前右上角按钮的顺序**
   * （第 1 位、第 2 位……写在卡片上），不需要另开一个列表去解释。
   */
  const cards = (plugins || []).slice().sort((a, b) => {
    const ia = rank.has(a.id) ? (rank.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
    const ib = rank.has(b.id) ? (rank.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });

  type CardBtn = { label: string; title: string; act?: () => void; disabled?: boolean };

  const cardBtn = (b: CardBtn) => (
    <button
      className="p-btn"
      title={b.title}
      disabled={b.disabled}
      onClick={() => {
        if (!b.act) return;
        b.act();
        rerender();
      }}
      style={{
        flex: 1, minWidth: 0, height: 28, padding: '0 6px',
        fontSize: 'var(--fs-11, 11px)',
        cursor: b.disabled ? 'not-allowed' : 'pointer',
        opacity: b.disabled ? 0.45 : 1,
      }}
    >
      {b.label}
    </button>
  );

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 'var(--sp-4, 8px)',
        marginTop: 'var(--sp-6, 12px)',
      }}>
        <span style={{ fontSize: 'var(--fs-12, 12px)', fontWeight: 600 }}>
          {`右上角按钮 · ${entries.length}`}
        </span>
        <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
          显示在标题栏右侧；从下方卡片加入或移除
        </span>
      </div>

      <div className="tb-shop">
        {cards.map((p) => {
          const isTb = p.kind === 'toolbar';
          const isSvc = p.kind === 'service';
          const joined = wantsEntry(p, extra);
          const e = byId.get(p.id);
          const hid = e ? hidden.has(e.id) : false;
          const pos = rank.get(p.id);

          /*
           * 「展示 / 隐藏」只对**已经加入**的入口有意义。
           * 未加入时**禁用而不是不画** —— 按钮凭空消失，
           * 用户只会以为是漏了，不会想到"要先加入"。
           */
          const show: CardBtn = (!joined || !e)
            ? { label: '展示', title: '先加入右上角，才能控制是否显示', disabled: true }
            : hid
              ? {
                label: '展示', title: '重新显示到右上角',
                act: () => toggleHidden(e.id),
              }
              : {
                label: '隐藏', title: '从右上角隐藏（保留位置与顺序，可再显示）',
                act: () => toggleHidden(e.id),
              };

          /*
           * 「加入 / 取消加入」。
           * 两种情况禁用，但**都要写明原因**：
           *   服务插件 —— 不进界面，加了也是点开一片空白
           *   工具栏插件 —— 自己就声明了要占右上角，不是"加"上去的
           * 禁用的按钮不给 title 就是"点了没反应且不知道为什么"。
           */
          const join: CardBtn = isSvc
            ? { label: '加入', title: '服务插件在后台运行，不进界面', disabled: true }
            : !joined
              ? {
                label: '加入',
                title: '在右上角加一个按钮，点了切到这个插件',
                act: () => {
                  addExtra(p.id);
                  ctx?.toast?.(`已把「${p.name ?? p.id}」加到右上角`, 'ok');
                },
              }
              : isTb
                ? { label: '取消加入', title: '工具栏插件内置在右上角，不可移除', disabled: true }
                : {
                  label: '取消加入',
                  title: '从右上角移除这个按钮（不会卸载插件）',
                  act: () => {
                    removeExtra(p.id);
                    ctx?.toast?.(`已把「${p.name ?? p.id}」移出右上角`, 'ok');
                  },
                };

          return (
            <div
              key={p.id}
              className={'tb-card' + (joined ? ' joined' : '') + (hid ? ' is-hidden' : '')}
            >
              <div className="tb-card-top">
                <span className="tb-card-icon">{p.icon ?? '◌'}</span>
                <span className="tb-card-name" title={p.name ?? p.id}>{p.name ?? p.id}</span>
              </div>
              <div className="tb-card-meta">
                {isSvc ? '服务插件' : isTb ? '工具栏插件' : '应用插件'}
                {joined ? ` · 第 ${(pos ?? 0) + 1} 位` : ''}
                {hid ? ' · 已隐藏' : ''}
              </div>
              <div className="tb-card-btns">
                {cardBtn(show)}
                {cardBtn(join)}
              </div>
            </div>
          );
        })}
      </div>

      {entries.length ? null : (
        <div className="p-muted" style={{ marginTop: 'var(--sp-4, 8px)', fontSize: 'var(--fs-11, 11px)' }}>
          右上角还没有任何按钮。在上面任意一张卡片点「加入」即可。
        </div>
      )}
      <div className="p-muted" style={{ marginTop: 'var(--sp-4, 8px)', fontSize: 'var(--fs-11, 11px)' }}>
        加入的入口点了会切到对应插件；取消加入只是去掉右上角按钮，不会卸载插件。
        「隐藏」是暂时不显示，再点「展示」会回到原来的位置。
      </div>
    </>
  );
}

/**
 * 快捷键总览。
 *
 * 分成两类的理由：**来源不同，生效范围也不同**。
 *   · 外壳快捷键 —— 外壳自己装，任何界面下都生效
 *   · 全局快捷键 —— 插件通过 ctx.registerShortcut 注册，插件未挂载也可能生效
 *
 * 第三类（插件**内部**快捷键，如 project-group 那 20 条）这里**列不出来**：
 * 它们由插件自己在激活时绑定、只在插件内生效，外壳无从得知。
 * 必须在页面上说明这件事 —— 否则用户配了快捷键却在这里看不到，
 * 只会以为页面漏了，不会想到要去插件自己的设置里找。
 *
 * 撞车是这页真正有价值的部分：插件注册的 accel 若与外壳键相同，
 * 两边都会 window.addEventListener('keydown')，谁先注册谁先跑，
 * 而插件那侧会 preventDefault + stopPropagation —— 外壳的键就**静默失效**。
 * 用户只会觉得"这个快捷键有时候不管用"，很难联想到是撞车。
 */
function ShortcutsCard({ unknown }: { unknown: boolean }) {
  const shell = shellGlobal();
  const raw = (typeof shell?.getShortcuts === 'function')
    ? (shell.getShortcuts() as Record<string, any>) : null;
  const entries = raw ? Object.entries(raw) : [];
  const taken = shellComboSet();

  const clashes = entries.filter(([accel]) => taken.has(normCombo(accel)));
  /* 撞车集合**只在这里算一次**：行内再各判一遍的话，
     两处判据迟早写得不一样（一处展开 mod、一处不展开），
     于是列表里标红了而计数说 0 处 —— 这种自相矛盾比漏判更难发现。 */
  const clashSet = new Set(clashes.map(([accel]) => accel));
  /* 插件之间撞车：同一个 accel 出现多次（Map 已按 pluginId+accel 去重，
     所以这里指的是**不同插件**用了同一个键） */
  const byNorm = new Map<string, string[]>();
  for (const [accel, v] of entries) {
    const n = normCombo(accel);
    byNorm.set(n, [...(byNorm.get(n) ?? []), v?.pluginId ?? '?']);
  }
  const interClash = [...byNorm.entries()].filter(([, ids]) => ids.length > 1);

  return (
    <div className="p-card">
      <h2>快捷键</h2>

      <div style={{ fontSize: 'var(--fs-12, 12px)', fontWeight: 600, marginTop: 'var(--sp-5, 10px)' }}>
        外壳快捷键 · {SHELL_SHORTCUT_SPECS.length}
      </div>
      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: '2px' }}>
        由外壳提供，任何界面下都生效
      </div>
      <div style={{ marginTop: 'var(--sp-4, 8px)' }}>
        {SHELL_SHORTCUT_SPECS.map((s) => (
          <div key={s.combo} className="p-row" style={{ padding: '6px 0' }}>
            <kbd className="p-mono" style={{
              minWidth: 132, flex: 'none', padding: '2px 8px', fontSize: 'var(--fs-11, 11px)',
              borderRadius: 'var(--r-xs)', background: 'var(--surface-sunk)',
              border: '1px solid var(--divider)', color: 'var(--text)',
            }}>{s.keys}</kbd>
            <span style={{ fontSize: 'var(--fs-12, 12px)' }}>{s.desc}</span>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 'var(--fs-12, 12px)', fontWeight: 600, marginTop: 'var(--sp-8, 16px)' }}>
        全局快捷键（插件注册） · {entries.length}
      </div>
      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: '2px' }}>
        由插件通过 ctx.registerShortcut 注册；插件未挂载时也可能生效
      </div>
      {unknown ? (
        <div className="p-muted" style={{ marginTop: 'var(--sp-4, 8px)' }}>
          未连接到外壳（沙箱隔离态），读不到插件注册的快捷键
        </div>
      ) : entries.length === 0 ? (
        <div className="p-muted" style={{ marginTop: 'var(--sp-4, 8px)' }}>
          暂无插件注册全局快捷键
        </div>
      ) : (
        <div style={{ marginTop: 'var(--sp-4, 8px)' }}>
          {entries.map(([accel, v]) => {
            const clash = clashSet.has(accel);
            return (
              <div key={accel} className="p-row" style={{ padding: '6px 0' }}>
                <kbd className="p-mono" style={{
                  minWidth: 132, flex: 'none', padding: '2px 8px', fontSize: 'var(--fs-11, 11px)',
                  borderRadius: 'var(--r-xs)', background: 'var(--surface-sunk)',
                  border: `1px solid ${clash ? 'var(--danger)' : 'var(--divider)'}`,
                  color: clash ? 'var(--danger)' : 'var(--text)',
                }}>{accel}</kbd>
                <span style={{ fontSize: 'var(--fs-12, 12px)' }}>
                  {v?.label || v?.event || '（未命名）'}
                </span>
                <span className="p-mono p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
                  {v?.pluginId}
                </span>
                {clash ? (
                  <span style={{ fontSize: 'var(--fs-11, 11px)', color: 'var(--danger)' }}>
                    ⚠ 与外壳快捷键撞车，外壳那个会失效
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {interClash.length ? (
        <div style={{
          marginTop: 'var(--sp-5, 10px)', padding: '8px 10px', borderRadius: 'var(--r-sm)',
          background: 'var(--surface-sunk)', fontSize: 'var(--fs-11, 11px)', color: 'var(--warn)',
        }}>
          {interClash.map(([n, ids]) => (
            <div key={n}>⚠ {n} 被多个插件注册（{ids.join('、')}），只有先注册的那个会响应</div>
          ))}
        </div>
      ) : null}

      {/*
        第三类必须说明，不然用户在这里找不到自己配的键会以为页面漏了。
        project-group 那 20 条就是这一类 —— 它们有自己的快捷键设置页。
      */}
      <div className="p-muted" style={{ marginTop: 'var(--sp-8, 16px)', fontSize: 'var(--fs-11, 11px)', lineHeight: 1.7 }}>
        插件内部的快捷键（只在插件激活时生效，例如 project-group 的项目操作键）
        由插件自己管理，请在对应插件的设置里配置 —— 外壳看不到，这里也列不出来。
      </div>
      <div className="p-muted" style={{ marginTop: 'var(--sp-3, 6px)', fontSize: 'var(--fs-11, 11px)', color: 'var(--text-dim)' }}>
        撞车共 {clashes.length + interClash.length} 处
      </div>
    </div>
  );
}

export default function Settings() {
  const ctx = useNexus();
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [pluginsUnknown, setPluginsUnknown] = useState(false);
  const [version, setVersion] = useState('…');
  const [, force] = useState(0);          // 主题切换后重渲染预览
  const [policy, setPolicyState] = useState(getPolicy());
  const [tab, setTab] = useState<TabKey>('theme');
  /* 样式审计结果：id → { issues, files }；拿不到样式（隔离态 / module 插件）为 null */
  const [audits, setAudits] = useState<Record<string, any>>({});
  const [auditOpen, setAuditOpen] = useState<string | null>(null);

  /*
   * 应用插件（侧边栏里那些）—— 拖动排序**只作用于这一类**。
   * 服务插件不在侧边栏，给它们排序没有意义，还会让用户以为排了能用。
   *
   * 分成 appPlugins / svcPlugins 两个数组放在组件顶层，
   * 是因为拖拽的 hook **不能写在 JSX 里的 IIFE 中** ——
   * hook 必须在组件顶层无条件调用，写在条件分支里会报顺序错误。
   */
  const appPlugins = (plugins || []).filter((p) => !p.kind || p.kind === 'app');
  const svcPlugins = (plugins || []).filter((p) => p.kind === 'service');

  /* 背景图选择的隐藏 input：按钮只是替它触发点击，
     这样"选择图片…"能保持与其它按钮一致的观感，而不是一个裸 file 控件 */
  const bgFileRef = useRef<HTMLInputElement>(null);

  const appsRef = useRef<HTMLDivElement>(null);
  const appsDrag = useDragReorder({
    count: appPlugins.length,
    containerRef: appsRef,
    mimeKey: 'plugin-app',
    onMove: (from: number, to: number) => {
      /*
       * 实时让位：只改本地数组让视觉立刻跟上，
       * **存储与通知留到 dragend**（onDrop）才做 ——
       * 每跨一项就写一次 localStorage + 派发事件，
       * 拖到底要写十几次，既没必要也会让通知刷屏。
       */
      setPlugins((cur) => {
        const isApp = (p: PluginManifest) => !p.kind || p.kind === 'app';
        const mask = cur.map(isApp);
        const apps = cur.filter(isApp);
        const item = apps[from];
        if (!item) return cur;
        const nextApps = [...apps];
        nextApps.splice(from, 1);
        nextApps.splice(Math.max(0, Math.min(nextApps.length, to)), 0, item);
        /* 按原数组的「是否 app」掩码填回，非 app 项的相对位置不变 */
        let ai = 0;
        return cur.map((p, idx) => (mask[idx] ? nextApps[ai++] : p));
      });
    },
    onDrop: () => {
      const ids = (plugins || []).filter((p) => !p.kind || p.kind === 'app').map((p) => p.id);
      setPluginOrder(ids);
      ctx.toast('已保存插件顺序', 'ok');
    },
  });

  useEffect(() => {
    const list = shellGlobal()?.getPlugins?.();
    setPlugins(Array.isArray(list) ? list : []);
    // 拿不到外壳时不要静默显示成「0 个插件」，后面会渲染一条显式提示
    setPluginsUnknown(!Array.isArray(list));
    ctx.invoke<string>('app_version').then(setVersion).catch(() => setVersion('浏览器模式'));
  }, [ctx]);

  /* 订阅主题变更：从标题栏的主题按钮切换时，
     本页面当前主题的高亮与色板选中态要跟着刷新。
     不订阅的话，只有用户点了本页某个元素触发重渲染才会更新，
     看起来就像"切了但没生效"。
     （这段曾在 53013446 的全量覆盖中丢失，现补回） */
  useEffect(() => {
    // 包一层：force() 返回 boolean，而 useEffect 的清理函数要求返回 void，
    // 直接透传会被 TS 判为类型不匹配（Destructor 不接受 boolean）。
    const off = onThemeChange(() => { force((n) => n + 1); });
    return () => { off(); };
  }, []);

  const rerender = () => force((n) => n + 1);

  /* ---------------- 自定义色（强调色 / 环境色共用一套） ----------------
   *
   * 预设色板只有固定 9 个色，用户想用自己的品牌色就只能走色盘。
   * 两个槽位共用这段逻辑，靠 slot 区分存储键与提示文案。
   *
   * 降级：无构建模式下 color-picker（React + requiresBuild）会被
   * filterByRuntime 过滤掉（N28），此时退回原生 <input type="color">
   * —— 没有 SV 面板和吸管，但至少能选任意色，
   * 不至于"点了自定义却毫无反应"。 */
  const accentInput = useRef<HTMLInputElement>(null);
  const envInput = useRef<HTMLInputElement>(null);

  const applyColor = (slot: 'accent' | 'env', hex: string) => {
    if (slot === 'env') setEnvColor(hex); else setAccent(hex);
    ctx.toast(`${slot === 'env' ? '环境色' : '强调色'}：${hex}`, 'ok');
    rerender();
    void syncThemeToShell();
  };

  const pickCustomColor = async (slot: 'accent' | 'env') => {
    const cur = slot === 'env' ? getEnvColor() : getAccent();
    const isHex = (v: string | null): v is string => !!v && /^#[0-9a-fA-F]{6}$/.test(v);

    /* 先问一句能不能用，不能用就降级 —— 直接 pick() 会 throw（N28） */
    let usable = false;
    try { usable = !!(await ctx.services.color.available()); } catch { usable = false; }

    if (!usable) {
      const el = slot === 'env' ? envInput.current : accentInput.current;
      if (!el) { ctx.toast('当前环境无法打开色盘', 'err'); return; }
      el.value = isHex(cur) ? cur : '#5b8cff';
      el.click();
      return;
    }

    try {
      /*
       * **刻意不传 preset**。
       *
       * preset 是"覆盖色盘自带的 24 个预设色"。早先为了"跟上面那排
       * 保持一致"传了 swatchFor()（只有 9 个），结果把 24 色砍成 9 色 ——
       * 本想打开更多选择，实际反而更少。
       *
       * 上面那排是快捷推荐，色盘里是完整调色板，两者不必一致：
       * 从色盘选出的任意色都能直接应用。
       */
      const r = await ctx.services.color.pick(
        isHex(cur) ? cur : null,
        { custom: getCustomColors(slot) },
      );
      /* 取消了也要存：用户可能刚收藏完就点取消 */
      saveCustomColors(slot, r?.custom);
      if (r?.hex) applyColor(slot, r.hex);
    } catch (e) {
      ctx.toast(`打开色盘失败：${String((e as Error)?.message || e)}`, 'err');
    }
  };

  /* 预设色板之外的当前色：不在预设里就单独显示出来，
     否则用户选了个自定义色却看不到"我选的是什么"。 */
  const customColorButton = (slot: 'accent' | 'env') => {
    const cur = slot === 'env' ? getEnvColor() : getAccent();
    const isPreset = !!cur
      && swatchFor(getBase()).some(([c]) => c.toLowerCase() === cur.toLowerCase());
    return (
      <>
        <button
          className="p-btn"
          onClick={() => { void pickCustomColor(slot); }}
          title={slot === 'env' ? '从色盘里选一个环境色' : '从色盘里选一个强调色'}
          style={{ flex: 'none', fontSize: 'var(--fs-11, 11px)', padding: '2px 8px' }}
        >
          🎨 自定义
        </button>
        {cur && !isPreset ? (
          <button
            className="p-btn"
            onClick={() => { void pickCustomColor(slot); }}
            title={`当前自定义色 ${cur}（点击重选）`}
            style={{
              color: cur,
              boxShadow: '3px 3px 7px var(--sh-dark), -3px -3px 7px var(--sh-light)',
            }}
          >
            ● {cur}
          </button>
        ) : null}
      </>
    );
  };

  /*
   * 收藏色：在设置页直接摆出来。
   *
   * 为什么要显示：色盘的收藏是"调用方传进去、返回时再带出来"的，
   * 持久化全靠设置页。存了却不在设置页显示的话，用户完全看不到成果 ——
   * 收藏了几个色，回到设置页面板毫无变化，只会以为没生效。
   *
   * 删除走右键：色点是 22px，上面再叠一个 × 会挤得看不清，
   * 而这是桌面应用（Tauri），右键是自然的交互。title 里写明。
   */
  const customSwatchRow = (slot: 'accent' | 'env') => {
    const list = getCustomColors(slot);
    if (!list.length) return null;
    return (
      <div className="p-row" style={{ marginTop: 'var(--sp-3, 6px)', alignItems: 'center' }}>
        <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', flex: 'none' }}>
          收藏
        </span>
        {list.map((c) => (
          <button
            key={c}
            className="p-btn"
            title={`${c} · 点击应用，右键从收藏中删除`}
            onClick={() => { applyColor(slot, c); }}
            onContextMenu={(e) => {
              e.preventDefault();
              saveCustomColors(slot, getCustomColors(slot).filter((x) => x !== c));
              rerender();
            }}
            style={{
              background: c,
              width: '22px', height: '22px', minWidth: '22px',
              padding: 0, flex: 'none', borderRadius: 'var(--r-xs, 6px)',
            }}
          />
        ))}
      </div>
    );
  };

  /* 样式审计：拉每个插件的 CSS，跑一遍与外壳变量契约的规则。
     插件是独立文档，外壳的 CSS 到不了那边，只能靠"引入 + 变量映射"保持一致；
     这条链上任何一环错位，表现都是某个主题下突然看不清，很难联想到是接错了。
     这里直接把冲突报在插件卡片上，而不是等用户撞见。

     只在「插件」标签页打开时才跑 —— 每个插件要 fetch HTML + CSS，
     没必要在用户看主题页时就发出一堆请求。 */
  useEffect(() => {
    if (tab !== 'plugins') return;
    let alive = true;
    (async () => {
      for (const p of plugins) {
        if (!alive) return;
        // 已审过就跳过（切标签来回切不会重复请求）
        if (Object.prototype.hasOwnProperty.call(audits, p.id)) continue;
        const res = await auditPlugin(p).catch(() => null);
        if (!alive) return;
        setAudits((prev) => ({ ...prev, [p.id]: res }));
      }
    })();
    return () => { alive = false; };
  }, [tab, plugins]);

  /**
   * 移除插件。
   *
   * 原来直接 `window.__NEXUS__?.removePlugin?.(p.id)`：沙箱下取不到方法，
   * `?.` 静默跳过 —— 用户点了「移除」却什么都没发生、也没有任何提示。
   * 这里改成：先降级到 parent 找外壳；确实拿不到就显式报错，不再静默。
   */
  const removePlugin = (p: PluginManifest) => {
    const shell = shellGlobal();
    if (typeof shell?.removePlugin !== 'function') {
      ctx.toast('移除失败：未连接到外壳，请用侧栏的插件管理操作', 'err');
      return;
    }
    try {
      shell.removePlugin(p.id);
      const list = shell.getPlugins?.();
      setPlugins(Array.isArray(list) ? list : []);
      setPluginsUnknown(!Array.isArray(list));
      ctx.toast(`已移除「${p.name}」`, 'ok');
    } catch (e: any) {
      ctx.toast('移除失败：' + String(e?.message ?? e), 'err');
    }
  };

  /**
   * 把当前主题状态同步给主平台侧（外壳）。
   *
   * 为什么需要：本设置页是 iframe 插件，有自己的 document。本地这份
   * theme-manager 的 applyTheme 只改 iframe 内的 :root —— 结果是"设置页
   * 自己变了、主面板没变"。而标题栏右上角的切换跑在主平台侧，改主文档
   * :root，主面板变、再经 pushTheme 推给 iframe，所以两边都变。
   *
   * 这里把写操作经 ctx.shell.theme 桥接给主平台侧再执行一次：
   * 主面板立刻变 → 它的 onChange 触发 pushTheme → 把新变量推回 iframe。
   * 单向流动不会来回触发 —— iframe 收到的是"应用变量"，不会再回写。
   *
   * 本地已经先执行过了，所以本函数失败也不影响设置页自身；
   * 桥接拿不到时（module 模式、旧版外壳）只是主面板不联动，属降级。
   */
  const syncThemeToShell = async () => {
    const shellTheme = (ctx as any)?.shell?.theme;
    if (!shellTheme) return;
    try {
      // 色相 / 明暗是独立存储的两档，先同步再应用主题，否则会被覆盖回去
      await shellTheme.setThemeShift?.(getHueShift(), getLightShift());
      await shellTheme.applyTheme?.(getThemeId(), getAccent(), getEnvColor());
    } catch { /* 桥接不可用：保持本地结果 */ }
  };

  /**
   * 把适配策略同步给主平台侧并**触发重算**。
   *
   * 与主题同一类问题：策略存 localStorage，iframe 隔离态下本地写不进
   * 主平台侧。更关键的是——适配滤镜是 installAdapter 时按策略算一次就
   * 固化的，策略改了不重算，当前插件看起来就是"改了没反应"。
   * 宿主侧的写方法会在写完后重跑 reAdapt，所以这一步不只是"存对"。
   */
  const syncPolicyToShell = async (fn: (() => Promise<unknown>) | undefined) => {
    if (!fn) return;
    try { await fn(); } catch { /* 桥接不可用：保持本地结果 */ }
  };

  return (
    <>
      {/* 竖排导航放在 .set-wrap 里与内容区并排。
          原来标签横排在顶部：7 个标签挤一行，且占掉内容区顶部一条；
          竖排后内容区能占满宽度（主题缩略图因此能排更多列）。 */}
      <div className="set-wrap">
      {/* ---------------- 分页导航 ---------------- */}
      <div className="set-tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            className={'set-tab' + (tab === key ? ' active' : '')}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 内容区单独滚动：分页条留在滚动容器外，切页不必先滚回顶部。
          详见 settings.css 的说明。 */}
      <div className="set-body">
      {tab === 'theme' ? (
        /* ---------------- 主题 ---------------- */
        <div className="p-card">
          <h2>主题</h2>
          <div className="p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', fontSize: 'var(--fs-12, 12px)' }}>
            点缩略图即切换。标题栏右上角的 ◐ 按钮也能快速切换，两处是同一套数据。
          </div>
          {/* 降级通路：无构建模式下色盘服务不可用，用原生取色器兜底。
              刻意常驻渲染而不是按需创建 —— input 必须由用户手势触发，
              临时 createElement + click 在部分浏览器上会被拦掉。 */}
          <input
            ref={accentInput}
            type="color"
            style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
            tabIndex={-1}
            aria-hidden
            onChange={(e) => { applyColor('accent', e.target.value); }}
          />
          <input
            ref={envInput}
            type="color"
            style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
            tabIndex={-1}
            aria-hidden
            onChange={(e) => { applyColor('env', e.target.value); }}
          />
          {(() => {
            const all = listThemes();
            const groups: [string, typeof all][] = [
              ['深色', all.filter((t) => t.base === 'dark')],
              ['浅色', all.filter((t) => t.base === 'light')],
            ];
            return groups.filter(([, items]) => items.length).map(([label, items]) => (
              <div className="theme-group" key={label}>
                <div className="theme-group-title">{label} · {items.length}</div>
                <div className="theme-grid">
                  {items.map((t) => {
                    const v = t.vars;
                    return (
                      <button
                        key={t.id}
                        className={'theme-card' + (t.id === getThemeId() ? ' active' : '')}
                        title={t.desc || t.name}
                        onClick={() => { applyTheme(t.id); ctx.toast(`已切换到「${t.name}」`, 'ok'); rerender(); void syncThemeToShell(); }}
                      >
                        <div
                          className="theme-prev"
                          style={{
                            background: v['--bg'] || v['--surface'],
                            backgroundImage: v['--bg-image'] && v['--bg-image'] !== 'none' ? v['--bg-image'] : undefined,
                          }}
                        >
                          <i
                            className="sw"
                            style={{
                              background: v['--surface'],
                              boxShadow: `2px 2px 5px ${v['--sh-dark']}, -2px -2px 5px ${v['--sh-light']}`,
                              border: `1px solid ${v['--border'] || 'transparent'}`,
                              backdropFilter: v['--blur'] && v['--blur'] !== '0px'
                                ? `blur(${v['--blur']})` : undefined,
                            }}
                          />
                          {/* 右半做成一小块「界面」：两条正文线 + 一条强调色条，
                              与标题栏弹出层里的缩略图共用 .tp-* 样式。
                              这两条是主题的装饰配色，不是状态色 ——
                              状态色（成功/错误/运行中）语义固定，不随环境色变化，
                              故不在此预览中展示，避免误导。 */}
                          <div className="tp-mid">
                            <i className="tp-line" style={{ background: v['--text'] }} />
                            <i
                              className="tp-line dim"
                              style={{ background: v['--text-dim'] || v['--text'] }}
                            />
                            <div className="tp-row">
                              <i
                                className="bar"
                                title="强调色：按钮 / 选中态"
                                style={{ background: v['--accent'] }}
                              />
                              <i
                                className="bar s"
                                title="环境色：次要点缀（非状态色）"
                                style={{ background: v['--env-color'] }}
                              />
                            </div>
                          </div>
                          {/* 当前主题打勾：缩略图很小，光靠描边看不出来 */}
                          {t.id === getThemeId() ? <span className="theme-check">✓</span> : null}
                        </div>
                        <div className="theme-foot">
                          {/* 名字用当前主题的正文色（.theme-name 已定义），
                              不能取 v['--text'] —— 那是被预览主题的颜色，
                              深色面板下预览浅色主题会变成深色字压深色底 */}
                          <div className="theme-name">{t.name}</div>
                          <span className="theme-badge">{styleLabel(t.style)}</span>
                        </div>
                        <div className="theme-desc">{t.desc || (t.base === 'dark' ? '深色' : '浅色')}</div>
                        {t.custom ? (
                          <button
                            className="theme-del"
                            title="删除该自定义主题"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteCustomTheme(t.id);
                              if (getThemeId() === t.id) applyTheme(listThemes()[0].id);
                              void syncThemeToShell();
                              ctx.toast('已删除自定义主题', 'ok');
                              rerender();
                            }}
                          >
                            ✕
                          </button>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ));
          })()}

          <div className="p-muted" style={{ marginTop: 'var(--sp-8, 16px)' }}>
            强调色（叠加在当前主题之上 · 按钮 / 选中态 / 链接）
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)' }}>
            {swatchFor(getBase()).map(([c, label]) => {
              const cur = getAccent();
              return (
                <button
                  key={c}
                  className="p-btn"
                  style={{
                    color: c,
                    boxShadow: '3px 3px 7px var(--sh-dark), -3px -3px 7px var(--sh-light)',
                    opacity: !cur || cur.toLowerCase() === c.toLowerCase() ? '1' : '.8',
                  }}
                  onClick={() => { setAccent(c); ctx.toast('强调色：' + label, 'ok'); rerender(); void syncThemeToShell(); }}
                >
                  ● {label}
                </button>
              );
            })}
            {customColorButton('accent')}
            <ResetDefaultBtn
              disabled={!getAccent()}
              onClick={() => { resetAccent(); ctx.toast('已恢复主题自带强调色', 'ok'); rerender(); void syncThemeToShell(); }}
              title="恢复为当前主题自带的强调色"
            />
          </div>
          {customSwatchRow('accent')}

          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>
            环境色（第二个主色 · 仅用于次要点缀）
          </div>
          <div className="p-muted" style={{ fontSize: 'var(--fs-12, 12px)', marginTop: 'var(--sp-1, 2px)' }}>
            成功 / 错误 / 运行中 / 警告 为固定语义色，不随这里变化
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)' }}>
            {swatchFor(getBase()).map(([c, label]) => {
              const cur = getEnvColor();
              return (
                <button
                  key={c}
                  className="p-btn"
                  style={{
                    color: c,
                    boxShadow: '3px 3px 7px var(--sh-dark), -3px -3px 7px var(--sh-light)',
                    opacity: !cur || cur.toLowerCase() === c.toLowerCase() ? '1' : '.8',
                  }}
                  onClick={() => { setEnvColor(c); ctx.toast('环境色：' + label, 'ok'); rerender(); void syncThemeToShell(); }}
                >
                  ● {label}
                </button>
              );
            })}
            {customColorButton('env')}
            <ResetDefaultBtn
              disabled={!getEnvColor()}
              onClick={() => { resetEnvColor(); ctx.toast('已恢复主题自带环境色', 'ok'); rerender(); void syncThemeToShell(); }}
              title="恢复为当前主题自带的环境色"
            />
          </div>
          {customSwatchRow('env')}

          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>
            主题色调整（在主题自身配色上做整体偏移）
          </div>
          <div className="p-muted" style={{ fontSize: 'var(--fs-12, 12px)', marginTop: 'var(--sp-1, 2px)' }}>
            {`每套主题各记一份（当前：${getCurrent().name}）；只偏移主题配色，强调色、环境色与状态色不参与`}
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)', gap: 'var(--sp-4, 8px)' }}>
            <span className="p-muted" style={{ width: 30, flex: 'none' }}>色相</span>
            <input
              className="p-range"
              type="range" min={-180} max={180} step={1}
              value={getHueShift()}
              onChange={(e) => { setThemeShift(Number(e.target.value), getLightShift()); rerender(); void syncThemeToShell(); }}
            />
            <span className="p-mono p-muted" style={{ width: 46, flex: 'none', textAlign: 'right' }}>
              {getHueShift() > 0 ? '+' : ''}{getHueShift()}°
            </span>
            <ResetDefaultBtn
              disabled={!getHueShift()}
              onClick={() => { resetHueShift(); ctx.toast('色相已归零', 'ok'); rerender(); void syncThemeToShell(); }}
              title="把色相偏移归零（明暗保留）"
            />
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-3, 6px)', gap: 'var(--sp-4, 8px)' }}>
            <span className="p-muted" style={{ width: 30, flex: 'none' }}>明暗</span>
            <input
              className="p-range"
              type="range" min={-50} max={50} step={1}
              value={getLightShift()}
              onChange={(e) => { setThemeShift(getHueShift(), Number(e.target.value)); rerender(); void syncThemeToShell(); }}
            />
            <span className="p-mono p-muted" style={{ width: 46, flex: 'none', textAlign: 'right' }}>
              {getLightShift() > 0 ? '+' : ''}{getLightShift()}%
            </span>
            <ResetDefaultBtn
              disabled={!getLightShift()}
              onClick={() => { resetLightShift(); ctx.toast('明暗已归零', 'ok'); rerender(); void syncThemeToShell(); }}
              title="把明暗偏移归零（色相保留）"
            />
          </div>

          {/* ---------- 背景图 ----------
              只有主题本来就带 --bg-image 的才能换图；
              纯色主题给一个带边框的占位并画禁止图标，
              让用户一眼知道"不是坏了，是这套主题没有"。 */}
          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>
            背景图
          </div>
          {(() => {
            const supported = supportsBgImage();
            const cur = getBgImage();
            if (!supported) {
              return (
                <div className="nx-bgslot nx-bgslot-off" title="当前主题为纯色底，不支持背景图">
                  <span className="nx-bgslot-ban" aria-hidden="true">🚫</span>
                  <span className="p-muted nx-bgslot-off-text">
                    此主题不带背景图
                  </span>
                </div>
              );
            }
            return (
              <div className="p-row wrap" style={{ marginTop: 'var(--sp-4, 8px)', gap: 'var(--sp-4, 8px)' }}>
                <div
                  className="nx-bgslot"
                  style={cur ? { backgroundImage: 'url("' + cur + '")' } : undefined}
                  title={cur ? '当前背景图' : '主题自带背景'}
                >
                  {!cur ? (
                    <span className="p-muted nx-bgslot-off-text">主题自带</span>
                  ) : null}
                </div>
                <button className="p-btn" onClick={() => bgFileRef.current?.click()}>
                  选择图片…
                </button>
                <input
                  ref={bgFileRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    /* 先清空 value：否则连选同一个文件不会再触发 change */
                    e.target.value = '';
                    if (!f) return;
                    if (f.size > MAX_BG_BYTES) {
                      ctx.toast(`图片太大（${(f.size / 1048576).toFixed(1)}MB），请换一张小图或先压缩`, 'err');
                      return;
                    }
                    const r = new FileReader();
                    r.onload = () => {
                      if (!setBgImage(String(r.result || ''))) {
                        ctx.toast('当前主题不支持背景图', 'err');
                        return;
                      }
                      ctx.toast('背景图已应用', 'ok');
                      rerender();
                      void syncThemeToShell();
                    };
                    r.onerror = () => ctx.toast('读取图片失败', 'err');
                    r.readAsDataURL(f);
                  }}
                />
                <ResetDefaultBtn
                  disabled={!cur}
                  onClick={() => { resetBgImage(); ctx.toast('已恢复主题自带背景', 'ok'); rerender(); void syncThemeToShell(); }}
                  title="恢复为当前主题自带的背景"
                />
              </div>
            );
          })()}

          <div className="p-row" style={{ marginTop: 'var(--sp-7, 14px)' }}>
            <button
              className="p-btn"
              onClick={async () => {
                const name = await prompt({
                  title: '保存配色',
                  label: '给当前配色起个名字',
                  defaultValue: '我的主题',
                });
                if (name === null) return;
                const t = saveAsCustom(name.trim() || '我的主题');
                applyTheme(t.id);
                ctx.toast('已保存并应用：' + t.name, 'ok');
                rerender();
                void syncThemeToShell();
              }}
            >
              ＋ 保存为自定义主题
            </button>
          </div>
        </div>
      ) : null}

      {tab === 'plugins' ? (
        <>
          {/* ---------------- 插件主题适配 ---------------- */}
          <div className="p-card">
            <h2>插件主题适配</h2>
            <div className="p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', lineHeight: 1.9 }}>
              基调不一致的插件会自动反转并与面板统一：深色面板暗化浅色插件，浅色面板亮化深色插件。
              <br />
              图片/图表会二次反转还原，不会被误伤。
            </div>
            <div className="p-row">
              <span style={{ minWidth: 72 }}>全局策略</span>
              <select
                className="p-input"
                style={{ width: 220 }}
                value={policy}
                onChange={(e) => {
                  setPolicy(e.target.value);
                  setPolicyState(e.target.value);
                  void syncPolicyToShell(() => (ctx as any)?.shell?.normalizer?.setPolicy(e.target.value));
                }}
              >
                {ADAPT_POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="p-muted" style={{ marginTop: 'var(--sp-4, 8px)' }}>
              {ADAPT_POLICIES.find((p) => p.value === policy)?.desc}
            </div>
          </div>

          {/* ---------------- 插件管理 ---------------- */}
          <div className="p-card">
            <h2>插件管理</h2>
            <div className="p-muted" style={{ marginBottom: 'var(--sp-3, 6px)' }}>
              侧栏「＋」可安装新插件；右侧下拉为单个插件指定基调判定方式
            </div>
            {/*
              按 app / service / toolbar 分区：
              · 服务插件不显示在侧边栏，由其它插件 ctx.services.call 调用
              · 工具栏插件显示在标题栏右上角，也不在侧边栏

              两者混进"应用插件"里都会误导 —— 用户装了却在侧边栏找不到，
              「同页/沙箱」那个标签完全不足以说明原因。

              ⚠️ 用 kind 精确分类，不要写 `kind !== 'service'`：
              那会把 toolbar 也算成 app（实测过）。
            */}
            {(() => {
              /* apps / svcs 提到组件顶层定义（appPlugins / svcPlugins），
                 因为拖拽 hook 必须在顶层调用，不能写在这个 IIFE 里 */
              const sub = (label: string, hint?: string) => (
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 'var(--sp-4, 8px)',
                  marginTop: 'var(--sp-6, 12px)',
                }}>
                  <span style={{ fontSize: 'var(--fs-12, 12px)', fontWeight: 600 }}>{label}</span>
                  {hint ? (
                    <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>{hint}</span>
                  ) : null}
                </div>
              );
              return (
                <>
                  {appPlugins.length
                    ? sub(`应用插件 · ${appPlugins.length}`, '显示在侧边栏 · 可上下拖动排序')
                    : null}
                  {/* 同工具栏入口：onDragOver 挂容器，漏了就是「能拖起来但没反应」 */}
                  <div
                    ref={appsRef}
                    onDragOver={appsDrag.onDragOver}
                    onDrop={(e) => e.preventDefault()}
                  >
                  {appPlugins.map((p, i) => (
                    <PluginRow
                      key={p.id}
                      p={p}
                      dragProps={appsDrag.getItemProps(i)}
                      dragging={appsDrag.dragFrom === i}
                      audit={audits[p.id]}
                      auditOpen={auditOpen === p.id}
                      onToggleAudit={() => setAuditOpen((cur) => (cur === p.id ? null : p.id))}
                      onOverride={(v) => {
                        setPluginOverride(p.id, v || null);
                        void syncPolicyToShell(() => (ctx as any)?.shell?.normalizer
                          ?.setPluginOverride(p.id, v || null));
                        ctx.toast(`「${p.name}」适配策略已更新`, 'ok');
                      }}
                      onRemove={() => removePlugin(p)}
                    />
                  ))}
                  </div>
                  {svcPlugins.length
                    ? sub(`服务插件 · ${svcPlugins.length}`, '不显示在侧边栏，由其它插件通过 ctx.services.call 调用')
                    : null}
                  {svcPlugins.map((p) => (
                    <PluginRow
                      key={p.id}
                      p={p}
                      audit={audits[p.id]}
                      auditOpen={auditOpen === p.id}
                      onToggleAudit={() => setAuditOpen((cur) => (cur === p.id ? null : p.id))}
                      onOverride={(v) => {
                        setPluginOverride(p.id, v || null);
                        void syncPolicyToShell(() => (ctx as any)?.shell?.normalizer
                          ?.setPluginOverride(p.id, v || null));
                        ctx.toast(`「${p.name}」适配策略已更新`, 'ok');
                      }}
                      onRemove={() => removePlugin(p)}
                    />
                  ))}
                  <ToolbarSection plugins={plugins} ctx={ctx} />
                </>
              );
            })()}
            {plugins.length ? null : (
              <div className="p-muted" style={{ marginTop: 'var(--sp-5, 10px)' }}>
                {pluginsUnknown
                  ? '未连接到外壳（沙箱隔离态），读不到插件列表，移除功能不可用'
                  : '暂无可管理的插件'}
              </div>
            )}
          </div>
        </>
      ) : null}


      {/* ---------------- 外链 ---------------- */}
      {tab === 'external' ? <ExternalCard /> : null}
      {tab === 'files' ? <FilesCard /> : null}
      {tab === 'shortcuts' ? <ShortcutsCard unknown={pluginsUnknown} /> : null}
      {tab === 'window' ? <WindowCard /> : null}

      {/* ---------------- 关于 ---------------- */}
      {tab === 'about' ? (
        <div className="p-card">
          <h2>关于</h2>
          <div className="p-grid">
            <div className="p-stat">
              <div className="k">应用</div>
              <div className="v" style={{ fontSize: 'var(--fs-15, 15px)' }}>Nexus Panel</div>
            </div>
            <div className="p-stat">
              <div className="k">版本</div>
              <div className="v" style={{ fontSize: 'var(--fs-15, 15px)' }}>{version}</div>
            </div>
            <div className="p-stat">
              <div className="k">外壳</div>
              <div className="v" style={{ fontSize: 'var(--fs-15, 15px)' }}>React + Vite + TS</div>
            </div>
            <div className="p-stat">
              <div className="k">框架</div>
              <div className="v" style={{ fontSize: 'var(--fs-15, 15px)' }}>Tauri 2.x</div>
            </div>
          </div>
          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)', lineHeight: 1.9 }}>
            快捷键：⌘/Ctrl + B 收起侧边栏 · ⌘/Ctrl + R 重载当前插件。
            完整列表见「快捷键」标签页。
          </div>
        </div>
      ) : null}
      </div>
      </div>
    </>
  );
}
