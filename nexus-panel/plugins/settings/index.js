import { definePlugin, h } from '../../js/plugin-sdk.js';
import { isInsideTauri, getTauri } from '../../js/tauri-core.js';
import {
  listThemes, applyTheme, setAccent, getThemeId, getCurrent,
  /* resolved 版：带深浅/风格覆盖。用户改了基调后 getCurrent().base 仍是旧值，
     统计区会显示错的深浅（与 App.tsx 同款修复）。 */
  getResolvedBase,
  /* 按 id 解析单个主题的元数据（基调/风格已套覆盖）。
     主题列表里每张卡片都要显示自己**实际**的风格与深浅。 */
  resolveThemeMeta,
  /* 卡片缩略图要按实际生效值渲染（含用户改动），不能只读 t.vars */
  exportVarsFor,
  getAccent, saveAsCustom, deleteCustomTheme, ACCENT_SWATCHES,
  /* 逐项变量覆盖：主题参数面板要用（无构建版此前完全没有这块 UI） */
  setVarOverride, resetVarOverride, resetAllVarOverrides, getVarOverrides,
  getResolvedStyle,
} from '../../js/theme-manager.js';
import {
  styleLabel, STYLE_LABELS as THEME_STYLE_LABELS,
  /* 参数总表与分组 —— 面板按它渲染，不硬编码 28 项 */
  PARAM_GROUPS, paramsForStyle,
} from '../../js/themes.js';
/* 颜色拆分/合并与 React 版共用同一份（js/theme-color.js） */
import { splitColor, joinColor } from '../../js/theme-color.js';
import { prompt as askPrompt } from '../../js/dialog.js';
import { SHELL_SHORTCUT_SPECS, shellComboSet, normCombo } from '../../js/shell-shortcuts.js';
import {
  toolbarEntriesOf, wantsEntry, hiddenIds, extraIds,
  toggleHidden, addExtra, removeExtra,
} from '../../js/toolbar-plugin.js';

/**
 * 右上角按钮（工具栏入口）管理 —— 与 React 版 ToolbarSection 同能力。
 *
 * 两版必须**同一套形态**，否则同页模式与 iframe 模式下
 * 同一个设置页长得不一样，用户只会以为其中一个是坏的。
 *
 * 商店式卡片矩阵：**所有**插件各出一张卡，取代原来的下拉框。
 * 下拉框一次只显示一项，且只有"还没加入"的候选 —— 想确认加没加
 * 得再去上面那排入口里找，两边各看一半才完整。
 * 矩阵把"它是什么"和"它现在什么状态"合到一张卡上，
 * 卡片上两个按钮分别是两个层次：
 *   展示 / 隐藏 —— 已在右上角，要不要暂时不显示（保留位置与顺序）
 *   加入 / 取消 —— 要不要占一个入口（取消不等于卸载插件）
 *
 * @param {object} ctx
 * @param {object[]|null} plugins
 * @param {(label:string, hint?:string)=>object} sub 小节标题渲染器
 */
function buildToolbarSection(ctx, plugins, sub) {
  const list = plugins || [];
  const render = () => {
    const entries = toolbarEntriesOf(list);
    const hidden = new Set(hiddenIds());
    const extra = new Set(extraIds());
    const byId = new Map(entries.map((e) => [e.pluginId, e]));
    const rank = new Map(entries.map((e, i) => [e.pluginId, i]));

    /* 已加入的按入口顺序排前面，未加入的保持原序（sort 稳定）。
       于是矩阵本身就体现了右上角按钮的当前顺序。 */
    const cards = list.slice().sort((a, b) => {
      const ia = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const ib = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ia - ib;
    });

    const cardBtn = (b) => h('button', {
      class: 'p-btn',
      title: b.title,
      disabled: b.disabled ? 'disabled' : null,
      onclick: (b.disabled || !b.act) ? null : () => { b.act(); rerender(); },
      style: {
        flex: '1', minWidth: '0', height: '28px', padding: '0 6px', fontSize: '11px',
        cursor: b.disabled ? 'not-allowed' : 'pointer',
        opacity: b.disabled ? '0.45' : '1',
      },
    }, b.label);

    const cardNodes = cards.map((p) => {
      const isTb = p.kind === 'toolbar';
      const isSvc = p.kind === 'service';
      const joined = wantsEntry(p, extra);
      const e = byId.get(p.id);
      const hid = e ? hidden.has(e.id) : false;
      const pos = rank.get(p.id);

      /* 未加入时**禁用而不是不画**：按钮凭空消失，
         用户只会以为漏了，不会想到"要先加入"。 */
      const show = (!joined || !e)
        ? { label: '展示', title: '先加入右上角，才能控制是否显示', disabled: true }
        : hid
          ? { label: '展示', title: '重新显示到右上角', act: () => toggleHidden(e.id) }
          : {
            label: '隐藏', title: '从右上角隐藏（保留位置与顺序，可再显示）',
            act: () => toggleHidden(e.id),
          };

      /* 两种禁用都要写明原因；不给 title 就是"点了没反应且不知道为什么"。 */
      const join = isSvc
        ? { label: '加入', title: '服务插件在后台运行，不进界面', disabled: true }
        : !joined
          ? {
            label: '加入', title: '在右上角加一个按钮，点了切到这个插件',
            act: () => {
              addExtra(p.id);
              ctx.toast(`已把「${p.name || p.id}」加到右上角`, 'ok');
            },
          }
          : isTb
            ? { label: '取消加入', title: '工具栏插件内置在右上角，不可移除', disabled: true }
            : {
              label: '取消加入', title: '从右上角移除这个按钮（不会卸载插件）',
              act: () => {
                removeExtra(p.id);
                ctx.toast(`已把「${p.name || p.id}」移出右上角`, 'ok');
              },
            };

      return h('div', {
        class: 'tb-card' + (joined ? ' joined' : '') + (hid ? ' is-hidden' : ''),
      },
        h('div.tb-card-top', {},
          h('span.tb-card-icon', {}, p.icon || '◌'),
          h('span.tb-card-name', { title: p.name || p.id }, p.name || p.id)),
        h('div.tb-card-meta', {},
          (isSvc ? '服务插件' : isTb ? '工具栏插件' : '应用插件')
          + (joined ? ` · 第 ${(pos ?? 0) + 1} 位` : '')
          + (hid ? ' · 已隐藏' : '')),
        h('div.tb-card-btns', {}, cardBtn(show), cardBtn(join)));
    });

    return [
      sub(`右上角按钮 · ${entries.length}`, '显示在标题栏右侧；从下方卡片加入或移除'),
      h('div.tb-shop', {}, ...cardNodes),
      entries.length ? null : h('div.p-muted', {
        style: { marginTop: '8px', fontSize: '11px' },
      }, '右上角还没有任何按钮。在上面任意一张卡片点「加入」即可。'),
      h('div.p-muted', { style: { marginTop: '8px', fontSize: '11px' } },
        '加入的入口点了会切到对应插件；取消加入只是去掉右上角按钮，不会卸载插件。'
        + '「隐藏」是暂时不显示，再点「展示」会回到原来的位置。'),
    ].filter(Boolean);
  };

  /* 用一个容器承载，改动后就地重画 */
  const box = h('div', {});
  const rerender = () => {
    box.textContent = '';
    for (const node of render()) box.appendChild(node);
  };
  rerender();
  return box;
}

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

      /** 一张主题卡片：预览区按**实际生效**的配色渲染（含用户改动），所见即所得 */
      const card = (t) => {
        /*
         * 用 exportVarsFor(t) 而非 t.vars ——
         * t.vars 不含基调/风格覆盖、逐项变量、风格参数、强调色，
         * 用户改完之后卡片缩略图仍是旧样子，列表与实际对不上。
         * 与 App.tsx 同款修复（两套实现必须同步，否则无构建模式下又不一致）。
         */
        const v = exportVarsFor(t);
        return h('button.theme-card', {
          class: t.id === activeId ? 'active' : '',
          title: t.desc || t.name,
          onclick: () => {
            applyTheme(t.id);
            ctx.toast(`已切换到「${t.name}」`, 'ok');
            renderThemes();
            renderAccents();
            /* 参数面板必须跟着换：它渲染的是**当前**主题的值，
               不重渲染的话切了主题还显示上一套的参数。 */
            renderParams();
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
            /* 同上：角标要写实际风格（用户改过的显示改后的值） */
            h('span.theme-badge', {}, styleLabel(resolveThemeMeta(t).style)),
          ),
          /* 深浅同理：基调也是参数（可只改基调不动颜色），读解析后的值 */
          h('div.theme-desc', {}, t.desc || (resolveThemeMeta(t).base === 'dark' ? '深色' : '浅色')),
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

      /*
       * 按**风格**分组，不按深浅 —— 与 App.tsx 保持一致。
       *
       * 两套实现必须同步：registry 按 noBuild 选择走 index.js 还是 module.tsx，
       * 用户用无构建模式打开时看到的就是这份。各写一份迟早漂移
       * （一边按风格分、一边还按深浅分，改了的人以为改全了）。
       *
       * 为什么按风格：
       *   深浅只是同一套设计的两个取值，用户真正要挑的是"哪种质感"。
       *   按深浅分时，想找玻璃要在两堆里各翻一遍，
       *   而这两堆里的玻璃本就是同一套设计的深浅两版，该挨在一起。
       *   深浅信息没丢 —— 卡片角标仍显示风格，缩略图本身就是深浅的直观呈现。
       *
       * 没写 style 的老自定义主题单列"其它"：
       *   混进任何一组都是错的，它们的观感不属于那个风格。
       */
      const all = listThemes();
      const groups = Object.entries(THEME_STYLE_LABELS)
        /* 按**实际**风格分组：用户把某套改成玻璃后它现在就是玻璃。
           用原始 t.style 会让它留在原组，而缩略图已是玻璃观感。 */
        .map(([k, label]) => [label, all.filter((t) => resolveThemeMeta(t).style === k)])
        .concat([['其它', all.filter((t) => {
          const st = resolveThemeMeta(t).style;
          return !st || !THEME_STYLE_LABELS[st];
        })]]);
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
    /* ============ 2.5 主题参数（规格驱动） ============ */
    /*
     * 为什么无构建版必须有这一段：
     *   「主题的所有参数都外放给用户」是硬要求，而它此前**只在 React 版**
     *   （ThemeParamsPanel.tsx）实现 —— 无构建模式下打开设置页，
     *   主题页只有缩略图 / 强调色 / 保存，28 个参数一项都改不了。
     *   两套实现漏一半，正是这个项目反复踩的坑。
     *
     * 为什么是"遍历规格"而不是照抄 React 版那个 442 行组件：
     *   THEME_PARAM_SPEC 已经是数据（类型 / 区间 / 单位 / 说明 / 适用风格），
     *   照抄等于再养一套必然漂移的实现。
     *   这里只写渲染器，控件形式由 type 决定 —— 将来加变量改 themes.js 一处，
     *   两套 UI 同时生效。
     */
    const paramsBox = h('div.tp-params', {});
    const renderParams = () => {
      paramsBox.innerHTML = '';
      const tid = getThemeId();
      const t = getCurrent();
      const style = getResolvedStyle();
      const eff = exportVarsFor(t) || {};
      const list = paramsForStyle(style);
      const ov = getVarOverrides(tid) || {};

      const field = (p) => {
        const cur = eff[p.key] != null ? eff[p.key] : ((t.vars && t.vars[p.key]) || '');
        const changed = Object.prototype.hasOwnProperty.call(ov, p.key);
        const resetAttrs = {
          type: 'button',
          title: changed ? '清除我改的值' : '该项未改动',
          onclick: () => { resetVarOverride(p.key, tid); renderParams(); renderThemes(); },
        };
        /* disabled 不能传 undefined —— h() 会把它写成字符串 "undefined"，
           浏览器眼里那就是"存在即禁用"。未改动时才真的加这个属性。 */
        if (!changed) resetAttrs.disabled = 'disabled';
        const reset = h('button.p-btn.sm', resetAttrs, '还原');

        let ctl;
        if (p.type === 'color') {
          const c = splitColor(cur);
          if (!c) {
            /*
             * 解析不了的值（transparent / none / 渐变）不硬塞进取色器 ——
             * 那会显示成黑色，用户点一下就把"透明"改成了黑，与意图相反。
             * 只给文本框，让用户自己决定写什么。
             */
            ctl = h('div.tp-color', {},
              h('span.tp-chip.tp-chip-none', { title: '当前值：' + (cur || '（空）') }),
              h('input.p-input.sm.tp-hex', {
                value: cur, spellcheck: 'false',
                onchange: (e) => { setVarOverride(p.key, e.target.value, tid); renderParams(); },
              }),
            );
          } else {
            const num = h('span.tp-alpha-num', {}, c.alpha.toFixed(2));
            ctl = h('div.tp-color', {},
              h('span.tp-chip', { style: { background: cur }, title: cur }),
              h('input.tp-picker', {
                type: 'color', value: c.hex,
                /* 拖动过程中只应用、不重渲染 —— 重渲染会销毁这个 input，
                   取色面板当场被关掉。 */
                oninput: (e) => setVarOverride(p.key, joinColor(e.target.value, c.alpha), tid),
              }),
              h('input.p-input.sm.tp-hex', {
                value: cur, spellcheck: 'false',
                onchange: (e) => { setVarOverride(p.key, e.target.value, tid); renderParams(); },
              }),
              h('input.tp-alpha', {
                type: 'range', min: '0', max: '1', step: '0.01', value: String(c.alpha),
                oninput: (e) => {
                  const a = Number(e.target.value);
                  num.textContent = a.toFixed(2);
                  setVarOverride(p.key, joinColor(c.hex, a), tid);
                },
              }),
              num,
            );
          }
        } else if (p.type === 'enum') {
          ctl = h('select.p-input.sm', {
            onchange: (e) => { setVarOverride(p.key, e.target.value, tid); renderParams(); },
          }, ...(p.options || []).map((o) => h('option', { value: o, selected: cur === o }, o)));
        } else if (p.type === 'text') {
          ctl = h('input.p-input.sm', {
            value: cur, spellcheck: 'false',
            onchange: (e) => { setVarOverride(p.key, e.target.value, tid); renderParams(); },
          });
        } else {
          const val = parseFloat(cur) || 0;
          const out = h('span.tp-num-val', {}, String(cur));
          ctl = h('div.tp-num', {},
            h('input', {
              type: 'range', min: String(p.min), max: String(p.max),
              step: String(p.step), value: String(val),
              oninput: (e) => {
                const v = e.target.value + (p.unit || '');
                out.textContent = v;
                setVarOverride(p.key, v, tid);
              },
            }),
            out,
          );
        }

        return h('div.tp-row', { class: changed ? 'tp-changed' : '' },
          h('div.tp-meta', {},
            h('div.tp-meta-row', {},
              h('span.tp-dot', {}),
              h('span.tp-meta-k', {}, p.label),
              h('code.p-mono', {}, p.key),
            ),
            p.desc ? h('div.p-muted.tp-hint', {}, p.desc) : null,
          ),
          h('div.tp-row-ctl', {}, ctl, reset),
        );
      };

      for (const g of PARAM_GROUPS) {
        const items = list.filter((p) => p.group === g.key);
        if (!items.length) continue;
        const body = h('div.set-group-body', {},
          h('div.p-muted.tp-group-desc', {}, g.desc),
          ...items.map(field));
        const head = h('button.set-group-head', { type: 'button', 'aria-expanded': 'false' },
          h('span.set-group-caret', { 'aria-hidden': 'true' }, '▸'),
          h('span.set-group-title', {}, g.label),
          h('span.set-group-badge', {}, String(items.length)));
        const sec = h('section.set-group', {}, head, body);
        /* 收起时必须真的移出可访问树：只加 display:none 的话
           Ctrl+F 还能搜到里面的字，用户"找到了"却看不见。 */
        body.hidden = true;
        head.onclick = () => {
          const open = sec.classList.toggle('open');
          head.setAttribute('aria-expanded', String(open));
          body.hidden = !open;
        };
        paramsBox.appendChild(sec);
      }
    };
    renderParams();

    themeSection.appendChild(
      h('div.p-card', { style: { marginTop: '16px' } },
        h('h3', {}, '主题参数'),
        h('div.p-muted', {},
          '逐项调整当前主题。改完可用上面的「保存为自定义主题」固化成一套新主题。'),
        h('div.p-row', { style: { marginTop: '10px' } },
          h('button.p-btn', {
            onclick: () => {
              resetAllVarOverrides(getThemeId());
              ctx.toast('已全部还原为当前主题自带值', 'ok');
              renderParams();
              renderThemes();
            },
          }, '全部还原'),
        ),
        paramsBox,
      ),
    );

    pages.theme.appendChild(themeSection);

    /* ============ 3. 插件管理 ============ */
    const plugins = readPlugins();
    const rows = (plugins || []).map((p) => {
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
        /*
         * p-slot-act：定宽格（与 React 版 App.tsx 同一条规则）。
         * 「内置」是 .p-tag、「移除」是 .p-btn.danger，两种形态宽度不同，
         * 而左侧名称列是 flex:1 —— 宽度差会全部转成右侧各格的位移，
         * 表现为右侧各格在内置行与非内置行之间左右错位。
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


    pages.plugins.appendChild(
      h('div.p-card', {},
        h('h2', {}, '插件管理'),
        h('div.p-muted', { style: { marginBottom: '6px' } },
          '侧栏「＋」可安装新插件；右侧下拉为单个插件指定主题判定方式'),
        appRows.length ? sub(`应用插件 · ${appRows.length}`, '显示在侧边栏') : null,
        ...appRows,
        svcRows.length ? sub(`服务插件 · ${svcRows.length}`, '不显示在侧边栏，由其它插件通过 ctx.services.call 调用') : null,
        ...svcRows,
        /*
         * 右上角按钮管理：显示/隐藏、排序、把应用插件添加为入口。
         * 与 React 版（App.tsx 的 ToolbarSection）同一套能力 ——
         * 两个设置页行为不同会很难解释。
         * 入口列表用 toolbarEntriesOf() 推导，与加载器共用判断。
         */
        buildToolbarSection(ctx, plugins, sub),
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
          h('div.p-stat', {}, h('div.k', {}, '基调'), h('div.v', { style: { fontSize: '15px' } }, getResolvedBase() === 'dark' ? '深色' : '浅色')),
        ),
        h('div.p-muted', { style: { marginTop: '14px', lineHeight: '1.9' } },
          '快捷键：⌘/Ctrl + B 收起侧边栏 · ⌘/Ctrl + R 重载当前插件'),
      ),
    );
  },
});
