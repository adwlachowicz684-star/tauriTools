import { definePlugin, h } from '../../js/plugin-sdk.js';
import { isInsideTauri, getTauri } from '../../js/tauri-core.js';
import {
  listThemes, applyTheme, setAccent, getThemeId, getCurrent,
  getAccent, saveAsCustom, deleteCustomTheme, ACCENT_SWATCHES,
} from '../../js/theme-manager.js';
import { styleLabel } from '../../js/themes.js';
import { prompt as askPrompt } from '../../js/dialog.js';
import {
  ADAPT_POLICIES, PLUGIN_THEMES,
  getPolicy, setPolicy, getPluginOverride, setPluginOverride,
} from '../../js/theme-normalizer.js';
import { SHELL_SHORTCUT_SPECS, shellComboSet, normCombo } from '../../js/shell-shortcuts.js';

/**
 * 取外壳全局单例：同页模式挂在 window 上，沙箱（iframe）模式挂在宿主窗口上。
 * 隔离态（opaque origin）下访问 parent 会抛 SecurityError，必须 try/catch。
 * 与外链管理（下文的 ext）同一套写法，读插件列表不该例外。
 */
function shellGlobal() {
  try {
    return window.__NEXUS__
      || (window.parent !== window ? window.parent?.__NEXUS__ : null)
      || null;
  } catch {
    return null;
  }
}

/** 取插件列表；拿不到返回 null（区别于「有外壳但没有插件」的空数组）。 */
function readPlugins() {
  const list = shellGlobal()?.getPlugins?.();
  return Array.isArray(list) ? list : null;
}

export default definePlugin({
  name: '设置',
  async mount(ctx) {
    /* ============ 0. 分页容器 ============ */
    // 主题单独一页：内容多（缩略图 + 强调色 + 色相/明暗 + 自定义），
    // 跟插件管理、外链挤在一起会很长，找不到想改的项。
    const pages = {
      theme: h('div', {}),
      plugins: h('div', {}),
      external: h('div', {}),
      files: h('div', {}),
      shortcuts: h('div', {}),
      window: h('div', {}),
      about: h('div', {}),
    };
    const TABS = [
      ['theme', '主题'],
      ['plugins', '插件'],
      ['external', '外链'],
      ['files', '文件'],
      ['shortcuts', '快捷键'],
      ['window', '窗口'],
      ['about', '关于'],
    ];
    let curTab = 'theme';
    const tabBar = h('div.set-tabs', {});
    const syncTabs = () => {
      for (const b of tabBar.children) {
        b.className = 'set-tab' + (b.dataset.key === curTab ? ' active' : '');
      }
      for (const [k, el] of Object.entries(pages)) el.style.display = k === curTab ? '' : 'none';
    };
    for (const [key, label] of TABS) {
      // 注意：h() 不支持 dataset 对象（会走到 setAttribute 变成 [object Object]），
      // 必须写 data-* 属性，浏览器才会把它映射进 element.dataset。
      tabBar.appendChild(h('button.set-tab', {
        'data-key': key,
        onclick: () => { curTab = key; syncTabs(); },
      }, label));
    }
    /*
     * 与 React 版（App.tsx）同一套结构：.set-wrap > [.set-tabs, .set-body]。
     *
     * 之前这里把 tabBar 和各页**平铺**进 root，于是 CSS 里那条
     * `flex-direction: column` 生效、而 `.set-wrap` 的横向并排完全没用上 ——
     * 表现是 7 个按钮竖着堆在内容**上方**（不是左侧）。
     * 两个模式长得不一样，正是本项目一直要避免的漂移。
     */
    const wrap = h('div.set-wrap', {});
    wrap.appendChild(tabBar);
    const body = h('div.set-body', {});
    for (const el of Object.values(pages)) body.appendChild(el);
    wrap.appendChild(body);
    ctx.root.appendChild(wrap);
    syncTabs();

    /* ============ 1. 主题 ============ */
    const themeSection = h('div.p-card', {}, h('h2', {}, '主题'));
    const grid = h('div', { style: { marginTop: '4px' } });
    themeSection.appendChild(grid);

    const renderThemes = () => {
      grid.innerHTML = '';
      const activeId = getThemeId();

      /** 一张主题卡片：预览区直接用主题自己的配色渲染，所见即所得 */
      const card = (t) => {
        const v = t.vars;
        return h('button.theme-card', {
          class: t.id === activeId ? 'active' : '',
          title: t.desc || t.name,
          onclick: () => {
            applyTheme(t.id);
            ctx.toast(`已切换到「${t.name}」`, 'ok');
            renderThemes();
            renderAccents();
          },
        },
          h('div.theme-prev', {
            style: {
              // 玻璃主题把渐变底一起画出来，预览才对得上
              background: v['--bg'] || v['--surface'],
              backgroundImage: v['--bg-image'] && v['--bg-image'] !== 'none' ? v['--bg-image'] : '',
            },
          },
            h('i.sw', {
              style: {
                background: v['--surface'],
                boxShadow: `2px 2px 5px ${v['--sh-dark']}, -2px -2px 5px ${v['--sh-light']}`,
                border: `1px solid ${v['--border'] || 'transparent'}`,
                backdropFilter: v['--blur'] && v['--blur'] !== '0px' ? `blur(${v['--blur']})` : '',
              },
            }),
            /* 右半的「迷你界面」与标题栏弹出层共用 .tp-* 样式：
               两条正文线 + 一条强调色条，一眼看出这套主题的明暗层次。 */
            h('div.tp-mid', {},
              h('i.tp-line', { style: { background: v['--text'] } }),
              h('i.tp-line.dim', { style: { background: v['--text-dim'] || v['--text'] } }),
              h('div.tp-row', {},
                h('i.bar', { title: '强调色：按钮 / 选中态', style: { background: v['--accent'] } }),
                // 变量名是 --env-color（旧名 --accent-2 已废弃，取到 undefined 会画出空条）
                h('i.bar.s', { title: '环境色：次要点缀（非状态色）', style: { background: v['--env-color'] } }),
              ),
            ),
            // 当前主题打勾：缩略图很小，光靠描边看不出来
            t.id === activeId ? h('span.theme-check', {}, '\u2713') : null,
          ),
          h('div.theme-foot', {},
            // 名字用当前主题的正文色（.theme-name 定义），不能取 v['--text'] ——
            // 那是被预览主题的颜色，深色面板下预览浅色主题会变成深色字压深色底
            h('div.theme-name', {}, t.name),
            h('span.theme-badge', {}, styleLabel(t.style)),
          ),
          h('div.theme-desc', {}, t.desc || (t.base === 'dark' ? '深色' : '浅色')),
          t.custom
            ? h('button.theme-del', {
                title: '删除该自定义主题',
                onclick: (e) => {
                  e.stopPropagation();
                  deleteCustomTheme(t.id);
                  if (activeId === t.id) applyTheme(listThemes()[0].id);
                  ctx.toast('已删除自定义主题', 'ok');
                  renderThemes();
                },
              }, '✕')
            : null,
        );
      };

      // 按基调分组，主题多了才好找
      const all = listThemes();
      const groups = [
        ['深色', all.filter((t) => t.base === 'dark')],
        ['浅色', all.filter((t) => t.base === 'light')],
      ];
      for (const [label, items] of groups) {
        if (!items.length) continue;
        const g = h('div.theme-group', {},
          h('div.theme-group-title', {}, `${label} · ${items.length}`));
        const inner = h('div.theme-grid', {});
        items.forEach((t) => inner.appendChild(card(t)));
        g.appendChild(inner);
        grid.appendChild(g);
      }
    };

    // 强调色微调（任何主题下都能单独改）
    const accentRow = h('div.p-row', { style: { marginTop: '16px' } });
    const renderAccents = () => {
      accentRow.innerHTML = '';
      const cur = getAccent() || getCurrent().vars['--accent'];
      for (const [c, label] of ACCENT_SWATCHES) {
        accentRow.appendChild(
          h('button.p-btn', {
            style: {
              color: c,
              boxShadow: '3px 3px 7px var(--sh-dark), -3px -3px 7px var(--sh-light)',
              opacity: String(c).toLowerCase() === String(cur).toLowerCase() ? '1' : '.8',
            },
            onclick: () => {
              setAccent(c);
              ctx.toast('强调色：' + label, 'ok');
              renderAccents();
            },
          }, '● ' + label),
        );
      }
    };

    renderThemes();
    renderAccents();

    themeSection.appendChild(
      h('div.p-muted', { style: { marginTop: '14px' } }, '强调色（叠加在当前主题之上）'),
      accentRow,
      h('div.p-row', { style: { marginTop: '14px' } },
        h('button.p-btn', {
          onclick: async () => {
            const name = await askPrompt({
              title: '保存配色',
              label: '给当前配色起个名字',
              defaultValue: '我的主题',
            });
            if (name === null) return;
            const t = saveAsCustom(name.trim() || '我的主题');
            applyTheme(t.id);
            ctx.toast('已保存并应用：' + t.name, 'ok');
            renderThemes();
          },
        }, '＋ 保存为自定义主题'),
      ),
    );
    pages.theme.appendChild(themeSection);

    /* ============ 2. 插件主题适配 ============ */
    const policySel = h('select.p-input', { style: { width: '220px' } },
      ...ADAPT_POLICIES.map((p) =>
        h('option', { value: p.value, selected: p.value === getPolicy() }, p.label)),
    );
    const desc = h('div.p-muted', { style: { marginTop: '8px' } },
      ADAPT_POLICIES.find((p) => p.value === getPolicy()).desc);
    policySel.onchange = () => {
      setPolicy(policySel.value);
      ctx.toast('已保存，切换插件时生效', 'ok');
      desc.textContent = ADAPT_POLICIES.find((p) => p.value === policySel.value).desc;
    };

    pages.plugins.appendChild(
      h('div.p-card', {},
        h('h2', {}, '插件主题适配'),
        h('div.p-muted', { style: { marginBottom: '12px', lineHeight: '1.9' } },
          '基调不一致的插件会自动反转并与面板统一：深色面板暗化浅色插件，浅色面板亮化深色插件。',
          h('br'), '图片/图表会二次反转还原，不会被误伤。'),
        h('div.p-row', {}, h('span', { style: { minWidth: '72px' } }, '全局策略'), policySel),
        desc,
      ),
    );

    /* ============ 3. 插件管理 ============ */
    const plugins = readPlugins();
    const rows = (plugins || []).map((p) => {
      const sel = h('select.p-input', {
        style: { height: '30px', width: '130px', fontSize: '12px', padding: '0 8px' },
      },
        h('option', { value: '', selected: !getPluginOverride(p.id) }, '跟随全局'),
        ...PLUGIN_THEMES.map((t) =>
          h('option', { value: t.value, selected: getPluginOverride(p.id) === t.value }, t.label)),
      );
      sel.onchange = () => {
        setPluginOverride(p.id, sel.value || null);
        ctx.toast(`「${p.name}」适配策略已更新`, 'ok');
      };

      return h('div.p-row', {
        style: {
          padding: '12px 14px', marginTop: '10px', borderRadius: 'var(--r)',
          background: 'var(--surface-sunk)',
          boxShadow: 'inset 3px 3px 6px var(--sh-dark), inset -3px -3px 6px var(--sh-light)',
        },
      },
        h('span', { style: { fontSize: '16px', width: '24px', textAlign: 'center' } }, p.icon || '◌'),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { fontSize: '13px' } }, p.name),
          h('div.p-mono.p-muted', { style: { fontSize: '11px' } }, p.entry),
        ),
        h('span.p-tag', {}, p.type === 'iframe' ? '沙箱' : '同页'),
        sel,
        /*
         * p-slot-act：定宽格（与 React 版 App.tsx 同一条规则）。
         * 「内置」是 .p-tag、「移除」是 .p-btn.danger，两种形态宽度不同，
         * 而左侧名称列是 flex:1 —— 宽度差会全部转成右侧各格的位移，
         * 表现为「跟随全局」下拉框在内置行与非内置行之间左右错位。
         */
        h('span.p-slot-act', {},
          p.builtin
            ? h('span.p-tag', {}, '内置')
            : h('button.p-btn.danger', {
                style: { height: '30px', padding: '0 10px', fontSize: '12px' },
                onclick: () => {
                  // 原来直接 window.__nexusRemovePlugin(p.id)：沙箱下该全局不存在，
                  // 点了「移除」要么抛 ReferenceError、要么毫无反应。这里走外壳降级，
                  // 取不到就显式提示，不静默。
                  const shell = shellGlobal();
                  if (typeof shell?.removePlugin !== 'function') {
                    ctx.toast('移除失败：未连接到外壳，请用侧栏的插件管理操作', 'err');
                    return;
                  }
                  shell.removePlugin(p.id);
                  ctx.toast(`已移除「${p.name}」`, 'ok');
                },
              }, '移除')),
      );
    });

    /*
      按 app / service / toolbar 分区。
      服务插件和工具栏插件都**不显示在侧边栏**，混进"应用插件"里会误导 ——
      用户装了却在侧边栏找不到，而「同页/沙箱」那个标签说明不了原因。

      ⚠️ 不要写 `kind !== 'service'`：那会把 kind:'toolbar' 也算成 app
      （实测过：工具栏插件因此被列在"应用插件 · 显示在侧边栏"下面）。
      与 React 版（App.tsx）保持一致 —— 两个设置页行为不同会很难解释。
    */
    const sub = (label, hint) => h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '12px' } },
      h('span', { style: { fontSize: '12px', fontWeight: '600' } }, label),
      h('span.p-muted', { style: { fontSize: '11px' } }, hint));

    const idx = (p) => rows[(plugins || []).indexOf(p)];
    const appRows = (plugins || []).filter((p) => !p.kind || p.kind === 'app').map(idx);
    const svcRows = (plugins || []).filter((p) => p.kind === 'service').map(idx);
    const tbRows = (plugins || []).filter((p) => p.kind === 'toolbar').map(idx);

    pages.plugins.appendChild(
      h('div.p-card', {},
        h('h2', {}, '插件管理'),
        h('div.p-muted', { style: { marginBottom: '6px' } },
          '侧栏「＋」可安装新插件；右侧下拉为单个插件指定主题判定方式'),
        appRows.length ? sub(`应用插件 · ${appRows.length}`, '显示在侧边栏') : null,
        ...appRows,
        svcRows.length ? sub(`服务插件 · ${svcRows.length}`, '不显示在侧边栏，由其它插件通过 ctx.services.call 调用') : null,
        ...svcRows,
        tbRows.length ? sub(`工具栏插件 · ${tbRows.length}`, '显示在标题栏右上角，不在侧边栏') : null,
        ...tbRows,
        plugins && plugins.length ? null : h('div.p-muted', { style: { marginTop: '8px' } },
          plugins ? '暂无可管理的插件' : '未连接到外壳（沙箱隔离态），读不到插件列表，移除功能不可用'),
      ),
    );

    /* ============ 3.2 快捷键总览 ============ */
    /*
      分两类：外壳快捷键（外壳自己装，任何界面生效）与
      全局快捷键（插件 ctx.registerShortcut 注册）。
      第三类——插件**内部**快捷键——外壳看不到，必须在这里说明，
      否则用户配了键却在这里找不到，只会以为页面漏了。

      撞车是这页真正的价值：插件的 accel 若与外壳键相同，
      两边都 addEventListener，插件那侧会 stopPropagation ——
      外壳的键**静默失效**，用户只会觉得"有时候不管用"。
    */
    {
      const shell = shellGlobal();
      const raw = (typeof shell?.getShortcuts === 'function') ? shell.getShortcuts() : null;
      const entries = raw ? Object.entries(raw) : [];
      const taken = shellComboSet();

      const kbd = (text, danger) => h('kbd.p-mono', {
        style: {
          minWidth: '132px', flex: 'none', padding: '2px 8px', fontSize: '11px',
          borderRadius: 'var(--r-xs)', background: 'var(--surface-sunk)',
          border: `1px solid ${danger ? 'var(--danger)' : 'var(--divider)'}`,
          color: danger ? 'var(--danger)' : 'var(--text)',
        },
      }, text);

      const byNorm = new Map();
      for (const [accel, v] of entries) {
        const n = normCombo(accel);
        byNorm.set(n, [...(byNorm.get(n) || []), v?.pluginId || '?']);
      }
      const interClash = [...byNorm.entries()].filter(([, ids]) => ids.length > 1);

      const card = h('div.p-card', {},
        h('h2', {}, '快捷键'),
        h('div', { style: { fontSize: '12px', fontWeight: '600', marginTop: '10px' } },
          `外壳快捷键 · ${SHELL_SHORTCUT_SPECS.length}`),
        h('div.p-muted', { style: { fontSize: '11px', marginTop: '2px' } },
          '由外壳提供，任何界面下都生效'),
        ...SHELL_SHORTCUT_SPECS.map((sc) => h('div.p-row', { style: { padding: '6px 0' } },
          kbd(sc.keys, false),
          h('span', { style: { fontSize: '12px' } }, sc.desc))),
        h('div', { style: { fontSize: '12px', fontWeight: '600', marginTop: '16px' } },
          `全局快捷键（插件注册） · ${entries.length}`),
        h('div.p-muted', { style: { fontSize: '11px', marginTop: '2px' } },
          '由插件通过 ctx.registerShortcut 注册；插件未挂载时也可能生效'),
      );

      if (!shell) {
        card.appendChild(h('div.p-muted', { style: { marginTop: '8px' } },
          '未连接到外壳（沙箱隔离态），读不到插件注册的快捷键'));
      } else if (!entries.length) {
        card.appendChild(h('div.p-muted', { style: { marginTop: '8px' } }, '暂无插件注册全局快捷键'));
      } else {
        for (const [accel, v] of entries) {
          const clash = taken.has(normCombo(accel));
          card.appendChild(h('div.p-row', { style: { padding: '6px 0' } },
            kbd(accel, clash),
            h('span', { style: { fontSize: '12px' } }, v?.label || v?.event || '（未命名）'),
            h('span.p-mono.p-muted', { style: { fontSize: '11px' } }, v?.pluginId),
            clash ? h('span', { style: { fontSize: '11px', color: 'var(--danger)' } },
              '⚠ 与外壳快捷键撞车，外壳那个会失效') : null));
        }
      }

      for (const [n, ids] of interClash) {
        card.appendChild(h('div', {
          style: {
            marginTop: '10px', padding: '8px 10px', borderRadius: 'var(--r-sm)',
            background: 'var(--surface-sunk)', fontSize: '11px', color: 'var(--warn)',
          },
        }, `⚠ ${n} 被多个插件注册（${ids.join('、')}），只有先注册的那个会响应`));
      }

      card.appendChild(h('div.p-muted', {
        style: { marginTop: '16px', fontSize: '11px', lineHeight: '1.7' },
      }, '插件内部的快捷键（只在插件激活时生效，例如 project-group 的项目操作键）由插件自己管理，请在对应插件的设置里配置 —— 外壳看不到，这里也列不出来。'));

      pages.shortcuts.appendChild(card);
    }

    /* ============ 3.5 外链管理 ============ */
    // 同页模式用 window.__NEXUS__；沙箱模式取 parent（设置页默认不隔离）
    const ext = window.__NEXUS__?.external
      || (() => { try { return window.parent?.__NEXUS__?.external; } catch { return null; } })();

    if (ext) {
      const renderExternal = () => {
        box.innerHTML = '';
        const policy = ext.loadPolicy();

        // 全局策略
        const sel = h('select.p-input', {
          style: { width: '160px', height: '30px', fontSize: '12px', padding: '0 8px' },
          onchange: (e) => {
            ext.savePolicy({ ...policy, mode: e.target.value });
            ctx.toast('外链策略已更新', 'ok');
            renderExternal();
          },
        }, ext.POLICY_MODES.map((m) =>
          h('option', { value: m.value, selected: policy.mode === m.value }, m.label)));

        const hosts = ext.listHosts();
        const pending = hosts.filter((x) => x.status === 'pending').length;

        box.appendChild(
          h('div.p-row', { style: { marginBottom: '10px' } },
            h('span', { style: { minWidth: '60px', fontSize: '13px' } }, '全局策略'),
            sel,
            h('span.p-muted', { style: { fontSize: '11px', flex: '1' } },
              ext.POLICY_MODES.find((m) => m.value === policy.mode)?.desc || ''),
            h('button.p-btn', {
              style: { height: '30px', padding: '0 12px', fontSize: '12px' },
              onclick: () => { ext.rescanAll(); setTimeout(renderExternal, 600); },
            }, '重新检查'),
          ),
        );

        if (pending) {
          box.appendChild(
            h('div.p-row', { style: { marginBottom: '12px' } },
              h('span.p-tag', { class: 'danger', style: { margin: '0' } }, `${pending} 个待决定`),
              h('span.p-muted', { style: { fontSize: '11px' } },
                '智能提醒模式下，这些域名会被拦下并提示'),
            ),
          );
        }

        if (!hosts.length) {
          box.appendChild(h('div.p-muted', { style: { padding: '14px 0' } },
            '还没有登记任何外链。安装插件时会扫描入口文件，运行时被 CSP 拦下的也会记到这里。'));
        } else {
          for (const x of hosts) {
            const mk = (label, status, cls) => h('button.p-btn', {
              class: x.status === status ? cls : '',
              style: { height: '26px', padding: '0 9px', fontSize: '11px' },
              onclick: () => { ext.setHostStatus(x.host, status); renderExternal(); },
            }, label);
            box.appendChild(
              h('div.p-row', {
                style: {
                  padding: '10px 12px', marginTop: '8px', borderRadius: 'var(--r-sm)',
                  background: 'var(--surface-sunk)',
                  boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
                },
              },
                h('div', { style: { flex: '1', minWidth: '0' } },
                  h('div.p-mono', { style: { fontSize: '12px' } }, x.host),
                  h('div.p-muted', { style: { fontSize: '10.5px', marginTop: '2px' } },
                    `${ext.KIND_LABELS[x.kind] || x.kind}`
                    + `${x.pluginId ? ' · ' + x.pluginId : ''}`
                    + (x.sample ? '' : '')),
                ),
                mk('信任', 'trusted', 'primary'),
                mk('禁止', 'blocked', 'danger'),
                h('button.p-btn', {
                  style: { height: '26px', padding: '0 8px', fontSize: '11px' },
                  title: '从清单移除',
                  onclick: () => { ext.removeHost(x.host); renderExternal(); },
                }, '✕'),
              ),
            );
            if (x.sample) {
              box.appendChild(h('div.p-mono.p-muted', {
                style: { fontSize: '10px', marginTop: '2px', marginLeft: '12px',
                         overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: x.sample,
              }, x.sample));
            }
          }
        }

        // 建议 CSP：让用户知道"放行"要落到 CSP 上才真正生效
        const csp = ext.suggestCsp(policy);
        if (csp) {
          box.appendChild(h('div.p-muted', { style: { marginTop: '14px', fontSize: '11px' } },
            '已信任的域名需要写进 CSP 才真正放行：'));
          box.appendChild(h('pre.p-mono', {
            style: {
              marginTop: '6px', padding: '10px', fontSize: '10.5px', whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', borderRadius: 'var(--r-sm)', background: 'var(--surface-sunk)',
              boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
            },
          }, csp));
        }
      };

      const box = h('div', {});
      pages.external.appendChild(
        h('div.p-card', {},
          h('h2', {}, '外链'),
          h('div.p-muted', { style: { marginBottom: '12px', lineHeight: '1.9' } },
            '插件访问外部网络的分级管控。安装与更新时会自动扫描入口文件，',
            h('br'),
            '运行时被 CSP 拦下的请求也会登记到这里，可逐条放行或禁止。'),
          box,
        ),
      );
      renderExternal();
      ext.setRefreshHandler?.(renderExternal);
    }

    /* ============ 4. 文件访问授权 ============ */
    /*
     * agent-flow 的「文件」节点经 Rust 的 fs_op 读写磁盘。fs_op 只接受落在
     * 授权根目录内的路径（canonicalize 后 starts_with），默认范围仅应用
     * 数据目录 —— 没有这个界面，用户改了工作流目录就会直接撞上"路径越权"
     * 却无从下手。
     *
     * 只做文本输入：项目没引 tauri-plugin-dialog，加一个插件只为选目录
     * 不划算。输入框里说明要填完整路径，失败时把 Rust 侧的报错原样显示
     * （里面含允许范围与原因，比自己另写一套提示更准）。
     */
    {
      const list = h('div', {});
      const input = h('input.p-input', {
        type: 'text',
        placeholder: '粘贴要授权的目录完整路径，如 /Users/me/projects',
        style: {
          flex: '1', height: '30px', fontSize: '12px', padding: '0 10px', minWidth: '0',
        },
        onkeydown: (e) => { if (e.key === 'Enter') add(); },
      });

      const render = async () => {
        list.innerHTML = '';
        let roots = [];
        try {
          roots = await ctx.invoke('af_fs_list_roots');
        } catch (e) {
          list.appendChild(h('div.p-muted', { style: { padding: '12px 0' } },
            `读取授权目录失败：${e?.message || e}`));
          return;
        }
        if (!roots.length) {
          list.appendChild(h('div.p-muted', { style: { padding: '12px 0' } },
            '还没有授权任何目录，文件节点将无法读写。'));
          return;
        }
        for (const r of roots) {
          list.appendChild(
            h('div.p-row', {
              style: {
                padding: '10px 12px', marginTop: '8px', borderRadius: 'var(--r-sm)',
                background: 'var(--surface-sunk)',
                boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
              },
            },
              h('div.p-mono', {
                style: { flex: '1', minWidth: '0', fontSize: '12px', wordBreak: 'break-all' },
              }, r),
              h('button.p-btn', {
                style: { height: '26px', padding: '0 9px', fontSize: '11px' },
                title: '撤销授权（应用数据目录不可撤销）',
                onclick: async () => {
                  try {
                    await ctx.invoke('af_fs_disallow_root', { path: r });
                    ctx.toast('已撤销授权', 'ok');
                  } catch (e) {
                    ctx.toast(String(e?.message || e), 'err');
                  }
                  render();
                },
              }, '✕'),
            ),
          );
        }
      };

      async function add() {
        const p = (input.value || '').trim();
        if (!p) return;
        try {
          await ctx.invoke('af_fs_allow_root', { path: p });
          input.value = '';
          ctx.toast('已加入授权范围', 'ok');
        } catch (e) {
          // Rust 侧的报错已经写清了原因（不是目录 / 范围过大 / 系统目录）
          ctx.toast(String(e?.message || e), 'err');
        }
        render();
      }

      pages.files.appendChild(
        h('div.p-card', {},
          h('h2', {}, '文件访问'),
          h('div.p-muted', { style: { marginBottom: '12px', lineHeight: '1.9' } },
            'agent-flow 的文件节点只能读写这里列出的目录（含子目录）。',
            h('br'),
            '超出范围的操作会被拒绝 —— 这样插件就没法「读本地文件再发到网上」。',
            h('br'),
            '应用数据目录是默认范围，不能撤销。'),
          list,
          h('div.p-row', { style: { marginTop: '12px' } },
            input,
            h('button.p-btn.primary', {
              style: { height: '30px', padding: '0 14px', fontSize: '12px' },
              onclick: add,
            }, '添加目录'),
          ),
        ),
      );
      // 不 await：挂载不该被一次列表读取卡住。挂 catch 是为了避免
      // ctx.invoke 在浏览器模式下抛错时变成 unhandled rejection。
      render().catch(() => {});
    }

    /* ============ 窗口行为 ============ */
    /*
     * 点标题栏 ✕ 是"藏到托盘"还是"真正退出"。
     *
     * 走 ctx.shell.window 而不是直接写 localStorage：
     * 本页在 Vite 模式下是 iframe，隔离态（opaque origin）下 localStorage
     * 不可用，本地读写都会落空 —— 与主题、适配策略同一类问题。
     */
    {
      const card = h('div.p-card', {}, h('h2', {}, '关闭窗口时'));
      const wrap = h('div', { style: { marginTop: '6px' } });

      const OPT = [
        ['hide', '隐藏到托盘', '窗口消失但程序还在，点托盘图标即可唤回。适合常驻使用。'],
        ['close', '退出程序', '真正结束进程。下次启动要从头加载。'],
      ];
      let cur = 'hide';
      const rows = {};

      const paint = () => {
        for (const [v] of OPT) {
          const el = rows[v];
          if (!el) continue;
          el.style.boxShadow = v === cur
            ? 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)'
            : '';
          el.style.background = v === cur ? 'var(--surface-sunk)' : 'transparent';
        }
      };

      const pick = async (v) => {
        cur = v;
        paint();
        try {
          await ctx.shell.window.setCloseAction(v);
        } catch (e) {
          ctx.toast?.('保存失败：' + (e?.message || e), 'err');
        }
      };

      for (const [v, label, desc] of OPT) {
        const row = h('div', {
          style: {
            padding: '10px 12px', marginTop: '8px', borderRadius: 'var(--r-sm)',
            cursor: 'pointer',
          },
          onclick: () => pick(v),
        },
          h('div', { style: { fontSize: '13px', fontWeight: '600' } }, label),
          h('div.p-muted', { style: { marginTop: '3px', fontSize: '11px', lineHeight: '1.5' } }, desc),
        );
        rows[v] = row;
        wrap.appendChild(row);
      }
      card.appendChild(wrap);
      card.appendChild(h('div.p-muted', {
        style: { marginTop: '10px', fontSize: '11px', lineHeight: '1.6' },
      }, '标题栏 ⇲ 按钮随时可以直接藏到托盘，与这里的选择无关。'));
      pages.window.appendChild(card);

      // 初值：走桥接读（iframe 隔离态下本地读不到用户的实际选择）
      ctx.shell.window.getCloseAction()
        .then((v) => { cur = v === 'close' ? 'close' : 'hide'; paint(); })
        .catch(() => { /* 读不到就保持默认 */ });
    }

    /* ============ 关于 ============ */
    let version = '浏览器模式';
    if (isInsideTauri()) {
      try { version = await (await getTauri()).invoke('app_version'); } catch { version = '获取失败'; }
    }
    pages.about.appendChild(
      h('div.p-card', {},
        h('h2', {}, '关于'),
        h('div.p-grid', {},
          h('div.p-stat', {}, h('div.k', {}, '应用'), h('div.v', { style: { fontSize: '15px' } }, 'Nexus Panel')),
          h('div.p-stat', {}, h('div.k', {}, '版本'), h('div.v', { style: { fontSize: '15px' } }, version)),
          h('div.p-stat', {}, h('div.k', {}, '当前主题'), h('div.v', { style: { fontSize: '15px' } }, getCurrent().name)),
          h('div.p-stat', {}, h('div.k', {}, '基调'), h('div.v', { style: { fontSize: '15px' } }, getCurrent().base === 'dark' ? '深色' : '浅色')),
        ),
        h('div.p-muted', { style: { marginTop: '14px', lineHeight: '1.9' } },
          '快捷键：⌘/Ctrl + B 收起侧边栏 · ⌘/Ctrl + R 重载当前插件'),
      ),
    );
  },
});
