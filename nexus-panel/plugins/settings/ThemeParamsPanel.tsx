import { useState } from 'react';
import SettingGroup from '../../src/components/SettingGroup';
import ColorField, { NumberField } from './ThemeParams';
import {
  setVarOverride, resetVarOverride, resetAllVarOverrides,
  getVarOverrides, getBaseOverride, setBaseOverride,
  getStyleOverride, setStyleOverride, exportVarsFor,
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
  const changedCount = Object.keys(overrides).length;

  const specs = paramsForStyle(style).filter((p) => {
    /* 只显示"这套主题本来就有"的变量 ——
       给扁平主题显示 --blur（它压根没定义）会得到一个空值滑块，
       拖了没任何变化，看着像坏了。 */
    const own = theme.vars?.[p.key];
    return own != null || overrides[p.key] != null;
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
                commit();
              }}
              title="把这套主题的所有自定义项恢复为自带值"
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
              const changed = overrides[p.key] != null && overrides[p.key] !== own;
              return (
                {/* 用模板串而不是字符串拼接：静态扫描只认模板串里的
                    字面量片段，写成 'tp-row' + (x ? ' changed' : '')
                    会把 changed 判成"CSS 定义了却没人用"。 */}
                <div key={p.key} className={`tp-row${changed ? ' changed' : ''}`}>
                  <div className="tp-row-main">
                    <div className="tp-row-label">
                      {p.label}
                      {changed ? <span className="tp-dot" title="已改（点右侧还原可退回主题自带值）" /> : null}
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
