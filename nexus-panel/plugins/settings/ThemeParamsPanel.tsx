import { useState } from 'react';
import SettingGroup from '../../src/components/SettingGroup';
import ColorField, { NumberField } from './ThemeParams';
import {
  setVarOverride, resetVarOverride, resetAllVarOverrides,
  getVarOverrides, getBaseOverride, setBaseOverride,
  getStyleOverride, setStyleOverride, exportVarsFor,
  getStyleParam, resetStyleParam, STYLE_PARAMS,
} from '../../js/theme-manager.js';
import { paramsForStyle, PARAM_GROUPS, STYLE_LABELS } from '../../js/themes.js';

/**
 * 主题完整参数编辑区。
 *
 * 目标是"用户能调出任意一套内置主题"：只要主题数据里写过的变量，
 * 这里都能改到（派生量除外 —— 它们由底色算出，改了只会自伤）。
 *
 * 三项设计要说明：
 *
 * 1. **按主题 id 存储**（theme-manager 的 varMapKey），与色相/明暗/风格参数
 *    同款。在 A 主题调的不该串到 B —— 每套主题是独立设计，
 *    串了就等于"调一个坏一堆"，用户再也不敢碰。
 *
 * 2. **只列当前风格用得上的项**。磨砂四层只有玻璃有意义，
 *    给新拟态显示"颗粒强度"，调了没反应，用户只会以为坏了。
 *
 * 3. **每项都有还原**。改崩了能一项一项退回来，
 *    而不必"重置整套主题"（那会连辛苦调好的其它项一起丢掉）。
 */
export default function ThemeParams({
  theme, onChanged,
}: {
  theme: any;
  /** 改完通知外层：重渲染 + 同步给主面板 */
  onChanged: () => void;
}) {
  const [, force] = useState(0);
  const rerender = () => force((v) => v + 1);

  const commit = () => { rerender(); onChanged(); };

  if (!theme) return null;

  const style = getStyleOverride(theme.id) || theme.style || 'neumorph';
  const base = getBaseOverride(theme.id) || theme.base;
  const finalVars = exportVarsFor(theme);
  const overrides = getVarOverrides(theme.id);
  /*
   * 「已改」计数必须把三类覆盖都算上，只数 varMap 会严重低估：
   *   · 基调 / 风格覆盖（存在另一组 key）
   *   · 风格参数（玻璃透明度 / 磨砂颗粒 / 模糊 / 立体度 / 描边强度）
   * 只数 varMap 时，用户明明把风格改成了玻璃、透明度也调了，
   * 这里却显示"已改 0 项" —— 与"全部还原"按钮的语义直接冲突：
   * 看起来没东西可还原，点了却会清掉一堆。
   */
  const styleParamChanged = Object.values(STYLE_PARAMS)
    .flat()
    .filter((p: any) => getStyleParam(p.key, theme.id) != null).length;
  const changedCount = Object.keys(overrides).length
    + (getBaseOverride(theme.id) ? 1 : 0)
    + (getStyleOverride(theme.id) ? 1 : 0)
    + styleParamChanged;

  /*
   * 过滤规则只有两条，不要用"主题有没有自带这个变量"去过滤。
   *
   * 曾经按"主题自带"过滤，结果把"从 A 主题调到 B 主题"这条路堵死了：
   * 新拟态主题不自带 --surface-overlay / --saturate / --frost-* / --r-*，
   * 用户把风格改成玻璃后，这些项全被隐藏 —— 磨砂质感调不出来，
   * 弹窗还会退回"没有底板"（deriveVars 没有 overlay 可算）。
   * 缺值应当显示出来让用户填，而不是藏起来。
   */
  const specs = paramsForStyle(style).filter((p) => {
    /* 由色板 UI 管理的（accent / env）不在这里重复 —— 两套存储会打架 */
    if (p.managedBy) return false;
    return true;
  });

  const setVar = (key: string, v: string) => {
    setVarOverride(key, v, theme.id);
    commit();
  };

  return (
    <div className="tp-params">
      <div className="tp-meta">
        {/* 深浅与风格也是参数：想"把这套深色新拟态改成浅色版"，
            只改颜色不够 —— base 决定分隔线方向、插件基调、表单控件配色。 */}
        <div className="tp-meta-row">
          <span className="tp-meta-k">基调</span>
          <div className="tp-meta-seg">
            {(['dark', 'light'] as const).map((b) => (
              <button
                key={b}
                className={'p-btn sm' + (base === b ? ' primary' : '')}
                onClick={() => {
                  /* 点当前值 = 取消覆盖，回到主题自带基调 */
                  setBaseOverride(b === theme.base ? null : b, theme.id);
                  commit();
                }}
                title={b === theme.base
                  ? `主题自带（${b === 'dark' ? '深色' : '浅色'}），再点一次取消修改`
                  : b === 'dark' ? '改为深色' : '改为浅色'}
              >
                {b === 'dark' ? '深色' : '浅色'}
              </button>
            ))}
          </div>
        </div>
        <div className="tp-meta-row">
          <span className="tp-meta-k">风格</span>
          <div className="tp-meta-seg">
            {Object.entries(STYLE_LABELS).map(([k, label]) => (
              <button
                key={k}
                className={'p-btn sm' + (style === k ? ' primary' : '')}
                onClick={() => {
                  setStyleOverride(k === theme.style ? null : k, theme.id);
                  commit();
                }}
                title={k === theme.style
                  ? `主题自带（${label}），再点一次取消修改`
                  : `改为${label}风格`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {changedCount ? (
          <div className="tp-meta-row">
            <span className="tp-meta-k">已改</span>
            <span className="p-muted tp-changed">{changedCount} 项</span>
            <button
              className="p-btn sm"
              onClick={() => {
                resetAllVarOverrides(theme.id);
                setBaseOverride(null, theme.id);
                setStyleOverride(null, theme.id);
                /*
                 * 风格参数存在**另一组 key**，resetAllVarOverrides 清不到。
                 * 漏了它，点完"全部还原"滑块仍停在用户设的值上，
                 * 而上面的计数已经变 0 —— 用户以为还原干净了，并没有。
                 *
                 * 清**所有三种风格**而不只是当前风格：
                 * 用户可能先调了玻璃的透明度再切回新拟态，
                 * 那些残留值此刻不生效（styleParams 按风格取），
                 * 但一切回玻璃就会冒出来，属于"还原了却没完全还原"。
                 */
                for (const list of Object.values(STYLE_PARAMS)) {
                  for (const p of list as any[]) resetStyleParam(p.key, theme.id);
                }
                commit();
              }}
              title="把这套主题的所有自定义项恢复为自带值（含基调、风格与风格参数）"
            >
              全部还原
            </button>
          </div>
        ) : null}
      </div>

      <div className="p-muted tp-hint">
        改完点下方「保存为自定义主题」可固化成一套新主题；
        不保存也会一直生效（按主题分别记住）。
      </div>

      {PARAM_GROUPS.map((g) => {
        const items = specs.filter((p) => p.group === g.key);
        if (!items.length) return null;
        return (
          <SettingGroup
            key={g.key}
            title={g.label}
            badge={`${items.length} 项`}
            defaultOpen={g.key === 'base'}
            hint={g.desc}
          >
            {items.map((p) => {
              const own = String(theme.vars?.[p.key] ?? '');
              const cur = String(finalVars[p.key] ?? own);
              /* 主题没自带该变量 —— 显示出来但要说清，
                 否则用户看到空白会以为是加载失败。
                 实际生效值由 CSS 兜底（neumorphism.css 的 :root）。 */
              const undef = own === '' && overrides[p.key] == null;
              const changed = overrides[p.key] != null && overrides[p.key] !== own;
              /* 用模板串而不是字符串拼接：静态扫描只认模板串里的
                 字面量片段，写成 'tp-row' + (x ? ' changed' : '')
                 会把 changed 判成"CSS 定义了却没人用"。 */
              return (
                <div key={p.key} className={`tp-row${changed ? ' changed' : ''}`}>
                  <div className="tp-row-main">
                    <div className="tp-row-label">
                      {p.label}
                      {changed ? <span className="tp-dot" title="已改（点右侧还原可退回主题自带值）" /> : null}
                      {undef ? <span className="p-muted tp-undef" title="这套主题没有定义该变量，当前值来自 CSS 默认值">未定义</span> : null}
                    </div>
                    <div className="p-mono tp-row-key">{p.key}</div>
                    {p.desc ? <div className="p-muted tp-row-desc">{p.desc}</div> : null}
                  </div>
                  <div className="tp-row-ctl">
                    {p.type === 'color' ? (
                      <ColorField
                        value={cur}
                        original={own}
                        onChange={(v) => setVar(p.key, v)}
                      />
                    ) : p.type === 'enum' ? (
                      <select
                        className="p-input sm"
                        value={cur}
                        onChange={(e) => setVar(p.key, e.target.value)}
                      >
                        {(p.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : p.type === 'text' ? (
                      <input
                        className="p-input sm tp-text"
                        value={cur}
                        spellCheck={false}
                        placeholder="留空为纯色底"
                        onChange={(e) => setVar(p.key, e.target.value)}
                      />
                    ) : (
                      <NumberField
                        value={cur}
                        unit={p.unit || ''}
                        min={p.min ?? 0}
                        max={p.max ?? 100}
                        step={p.step ?? 1}
                        onChange={(v) => setVar(p.key, v)}
                      />
                    )}
                    {changed ? (
                      <button
                        className="p-btn sm"
                        title={`还原为「${theme.name}」自带值：${own}`}
                        onClick={() => { resetVarOverride(p.key, theme.id); commit(); }}
                      >
                        还原
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </SettingGroup>
        );
      })}
    </div>
  );
}
