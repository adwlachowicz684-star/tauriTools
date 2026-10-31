import { useEffect, useState } from 'react';
import type { PluginManifest } from '../../js/host.js';
import { getPluginConfig, savePluginConfig } from '../../js/plugin-config.js';
import { listThemes } from '../../js/theme-manager.js';
import * as extPolicy from '../../js/external-policy.js';
import SettingGroup from './SettingGroup';

/**
 * 抽屉里的外壳固定区块：沙箱隔离 / 插件主题 / 本插件外链。
 * 对应 shell.js 里的 renderShellSection()，两边行为保持一致。
 *
 * 三个区块都改用 SettingGroup 折叠：
 * 设置项一多（尤其外链，一个插件能扫出十几条）整页就变成一条无限长的带，
 * 用户要一直往下滚才知道下面还有什么。折叠后每组收起态只占一行。
 *
 * 「主题适配」开关**已移除** —— 它控制的是那套"基调不一致就反转"的滤镜，
 * 滤镜机制整套删掉了，留着开关就是一个"拨了没反应"的假控件。
 */
export default function SandboxSection({ manifest }: { manifest: PluginManifest }) {
  const [cfg, setCfg] = useState(() => getPluginConfig(manifest.id));
  const [err, setErr] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => { setCfg(getPluginConfig(manifest.id)); }, [manifest.id]);

  /*
   * 写失败就**停在原值**，不能停在没落盘的那个上。
   *
   * 存储不可用（配额满 / 隐私模式 / 严格沙箱下 localStorage 被拒）时
   * `localStorage.setItem` 会抛，一个字节都没写进去。照旧写法的后果：
   * 开关画成"已开启"、组标题上的徽章跟着变"严格"，而磁盘上还是"宽松" ——
   * 重载插件后打回原样，用户记得的只有顶上那句「改动在下次加载时生效」。
   * **界面说 A、实际是 B，且不报错**，与无构建版（shell.js）同一套判据。
   */
  const write = (patch: Record<string, unknown>) => {
    const { config: next, saved } = savePluginConfig(manifest.id, patch);
    if (saved) { setCfg(next); setErr(null); }
    else setErr('插件配置写不进本地存储（配额或隐私模式），这次改动没有生效');
    bump((n) => n + 1);
  };

  const toggle = (key: 'isolated') => write({ [key]: !cfg[key] });

  const mine = extPolicy.listHosts().filter((x) => x.pluginId === manifest.id);

  /**
   * 插件自选主题的一行：为某个基调挑一套。
   *
   * 不是"锁定成深色/浅色"，而是"整体深色时用哪套、浅色时用哪套"。
   * 留空（跟随全局）表示该基调下不覆盖。
   */
  const themeRow = (label: string, key: 'themeDark' | 'themeLight', base: 'dark' | 'light') => {
    const all = listThemes().filter((t) => t.base === base);
    /*
     * 纵向排布（.cfg-row.col），不用默认的"左文右控件"。
     *
     * 下拉框宽度由最长选项决定，而深色 / 浅色两套里最长的主题名不同 ——
     * 横排时两个下拉一宽一窄、右端对不齐，同组里开关那行又是对齐的，
     * 整组看着就没排好。纵向下两个下拉都铺满，自然等宽。
     * 长名字也不会把左列文字挤扁。
     */
    return (
      <div key={key} className="cfg-row col">
        <div className="cfg-row-head">
          <div className="cfg-row-label">{label}</div>
          <div className="p-muted cfg-row-desc">
            {base === 'dark' ? '整体主题为深色时，本插件用这套' : '整体主题为浅色时，本插件用这套'}
          </div>
        </div>
        <select
          className="p-input sm"
          value={cfg[key] ?? ''}
          onChange={(e) => write({ [key]: e.target.value || null })}
        >
          <option value="">跟随全局</option>
          {all.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
    );
  };

  /*
   * 外层必须是 .dw-shell，不能省。
   *
   * css/neumorphism.css 里那两条内边距规则此前写的是 #dw-shell（id 选择器），
   * 而无构建版（js/shell.js）确实给了这个 id、React 版这里是 Fragment ——
   * 于是同一份样式只有无构建版生效，Vite 版的外壳区一直贴着抽屉边，
   * 与上方插件区错开一截。两版共用同一个类名才不会再各修一次。
   */
  return (
    <div className="dw-shell">
      {/*
       * 保存失败的说明放在**所有分组之上**：失败可能来自沙箱开关，也可能来自
       * 插件主题那两个下拉，放在某一组里面的话，另一组出问题时这句在折叠状态下
       * 根本看不见 —— 而那两个下拉自己不会发声（成功时也不需要发声）。
       */}
      {err ? (
        <div className="dw-err">保存失败：{err}</div>
      ) : null}
      <SettingGroup
        title="沙箱"
        badge={cfg.isolated ? '严格' : '宽松'}
        defaultOpen
        hint="改动在下次加载该插件时生效。"
      >
        <div className="cfg-row">
          <div className="cfg-row-main">
            <div className="cfg-row-label">严格沙箱</div>
            <div className="p-muted cfg-row-desc">
              {cfg.isolated
                ? '切断插件直连主平台的通道，同时彻底阻断插件之间互访；ctx.invoke / store / 事件 / 主题 等能力通过桥接完整保留。'
                : '插件与主平台同源，可直连访问（parent / localStorage / Tauri IPC）；代价是插件之间理论上也能互访。'}
            </div>
          </div>
          {/*
            胶囊开关 + 状态点，而不是一个写着"已开启/已关闭"的按钮。
            后者在凹陷底板的行里既像按钮又像标签，点不点得动全凭猜。
            与无构建版（js/shell.js 的 renderShellSection）同一个类名，
            两版共用 css/controls.css 里的那份定义。
          */}
          <button
            type="button"
            className={'dw-switch' + (cfg.isolated ? ' on' : '')}
            aria-pressed={cfg.isolated}
            onClick={() => toggle('isolated')}
          >
            <span className="dw-dot" />
            {cfg.isolated ? '已开启' : '已关闭'}
          </button>
        </div>

        {manifest.type !== 'iframe' ? (
          <div className="p-muted cfg-row-note">
            同页插件不受影响 —— 它本来就跑在主页面里。
          </div>
        ) : null}

        <div className="p-muted cfg-row-note cfg-row-note-sep">
          注意：「严格沙箱」切断的是直连通道，不是能力。以下能力<b>无论开关如何都照常可用</b>
          （它们在主平台侧执行）：ctx.invoke 调 Rust、ctx.store 持久化、ctx.on/emit 跨插件事件、
          ctx.setTitle/setBadge/toast、主题同步。
        </div>
      </SettingGroup>

      {/* 插件自选主题：深色一套、浅色一套。
          语义不是"锁定深浅"，而是按整体的深浅在自己这两套之间切，
          不再跟随用户在同基调里换哪套主题。 */}
      <SettingGroup
        title="插件主题"
        badge={cfg.themeDark || cfg.themeLight ? '已指定' : '跟随全局'}
        hint={<>分别为深色 / 浅色各挑一套。选好后，本插件只跟随整体主题的<b>深浅</b>在自己这两套之间切换，不再跟随你在同基调里换哪套主题。留空则跟随全局。修改<b>立即生效</b>，无需重载。</>}
      >
        {themeRow('深色时用', 'themeDark', 'dark')}
        {themeRow('浅色时用', 'themeLight', 'light')}
      </SettingGroup>

      <SettingGroup
        title="外链"
        badge={String(mine.length)}
        hint="扫描插件入口得到。全局策略与逐条放行在「设置 → 外链」里改。"
      >
        {mine.length ? mine.map((x) => (
          <div key={x.host} className="cfg-row">
            <div className="cfg-row-main">
              <div className="p-mono cfg-row-label">{x.host}</div>
              <div className="p-muted cfg-row-desc">
                {(extPolicy.KIND_LABELS as Record<string, string>)[x.kind] || x.kind} · {
                  x.status === 'trusted' ? '已信任' : x.status === 'blocked' ? '已禁止' : '待决定'
                }
              </div>
            </div>
            <span className={'p-tag' + (x.status === 'trusted' ? ' ok' : x.status === 'blocked' ? ' danger' : '')}>
              {x.status === 'trusted' ? '已信任' : x.status === 'blocked' ? '已禁止' : '待决定'}
            </span>
          </div>
        )) : (
          <div className="p-muted cfg-row-note">这个插件没有发起外部请求。</div>
        )}
      </SettingGroup>
    </div>
  );
}
