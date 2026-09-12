import { definePlugin, h } from '../../js/plugin-sdk.js';
import { isInsideTauri, getTauri } from '../../js/tauri-core.js';
import {
  listThemes, applyTheme, setAccent, getThemeId, getCurrent,
  getAccent, saveAsCustom, deleteCustomTheme, ACCENT_SWATCHES,
} from '../../js/theme-manager.js';
import {
  ADAPT_POLICIES, PLUGIN_THEMES,
  getPolicy, setPolicy, getPluginOverride, setPluginOverride,
} from '../../js/theme-normalizer.js';

export default definePlugin({
  name: '设置',
  async mount(ctx) {
    /* ============ 1. 主题 ============ */
    const themeSection = h('div.p-card', {}, h('h2', {}, '主题'));
    const grid = h('div.theme-grid', { style: { marginTop: '4px' } });
    themeSection.appendChild(grid);

    const renderThemes = () => {
      grid.innerHTML = '';
      const activeId = getThemeId();
      for (const t of listThemes()) {
        const v = t.vars;
        const card = h('button.theme-card', {
          class: t.id === activeId ? 'active' : '',
          title: t.desc || t.name,
          onclick: () => {
            applyTheme(t.id);
            ctx.toast(`已切换到「${t.name}」`, 'ok');
            renderThemes();
            renderAccents();
          },
        },
          h('div.theme-prev', { style: { background: v['--bg'] || v['--surface'] } },
            h('i.sw', {
              style: {
                background: v['--surface'],
                boxShadow: `2px 2px 5px ${v['--sh-dark']}, -2px -2px 5px ${v['--sh-light']}`,
                border: `1px solid ${v['--border'] || 'transparent'}`,
              },
            }),
            h('i.bar', { style: { background: v['--accent'] } }),
            h('i.bar.s', { style: { background: v['--accent-2'] } }),
          ),
          h('div.theme-name', { style: { color: v['--text'] } }, t.name),
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
        grid.appendChild(card);
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
              opacity: String(c).toLowerCase() === String(cur).toLowerCase() ? '1' : '.7',
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
          onclick: () => {
            const name = prompt('给当前配色起个名字：', '我的主题');
            if (name === null) return;
            const t = saveAsCustom(name.trim() || '我的主题');
            applyTheme(t.id);
            ctx.toast('已保存并应用：' + t.name, 'ok');
            renderThemes();
          },
        }, '＋ 保存为自定义主题'),
      ),
    );
    ctx.root.appendChild(themeSection);

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

    ctx.root.appendChild(
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
    const rows = (window.__NEXUS__?.getPlugins() || []).map((p) => {
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
        p.builtin
          ? h('span.p-tag', {}, '内置')
          : h('button.p-btn.danger', {
              style: { height: '30px', padding: '0 10px', fontSize: '12px' },
              onclick: () => window.__nexusRemovePlugin(p.id),
            }, '移除'),
      );
    });

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '插件管理'),
        h('div.p-muted', { style: { marginBottom: '6px' } },
          '侧栏「＋」可安装新插件；右侧下拉为单个插件指定主题判定方式'),
        ...rows,
      ),
    );

    /* ============ 4. 关于 ============ */
    let version = '浏览器模式';
    if (isInsideTauri()) {
      try { version = await (await getTauri()).invoke('app_version'); } catch { version = '获取失败'; }
    }
    ctx.root.appendChild(
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
