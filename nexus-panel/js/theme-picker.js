/**
 * 标题栏上的主题选择器（弹出层）。
 *
 * 用原生 DOM 实现，而不是 React 组件 —— 因为无构建模式（index.html + shell.js）
 * 和 Vite/React 模式都要用它，只写一份才能避免两套逻辑各自漂移。
 * React 侧只需在 onClick 里调 openThemePicker({ anchor })。
 *
 * 与设置页里的「主题」分页是两回事：
 *   这里是快速切换（缩略图 → 点一下就换）
 *   设置页里是全量管理（还能调强调色 / 色相 / 存自定义主题）
 */
import { listThemes, applyTheme, getThemeId, onChange, deleteCustomTheme } from './theme-manager.js';

let current = null;   // { root, mask, offChange, onPick }

/**
 * @param {object}  o
 * @param {Element} o.anchor    锚点元素（通常就是标题栏那个按钮），弹出层右对齐到它
 * @param {(t) => void} [o.onPick] 选中后的回调（外壳用它来弹 toast / 同步标题栏）
 */
export function openThemePicker({ anchor, onPick } = {}) {
  // 已打开时再点一次 → 关闭（toggle 语义）
  if (current) { closeThemePicker(); return null; }
  if (!anchor) return null;

  const mask = document.createElement('div');
  mask.className = 'theme-pop-mask';

  const root = document.createElement('div');
  root.className = 'theme-pop';
  root.setAttribute('role', 'dialog');

  const body = document.createElement('div');
  body.className = 'theme-pop-body';
  root.appendChild(body);

  /** 渲染（切换主题后要重绘，以更新选中态与自定义主题的增删） */
  const render = () => {
    const all = listThemes();
    body.textContent = '';

    const head = document.createElement('div');
    head.className = 'theme-pop-head';
    const t1 = document.createElement('span');
    t1.textContent = '主题';
    const t2 = document.createElement('span');
    t2.className = 'p-muted';
    t2.style.fontSize = '11px';
    t2.textContent = `${all.length} 套`;
    head.append(t1, t2);
    body.appendChild(head);

    const groups = [
      ['深色', all.filter((t) => t.base === 'dark')],
      ['浅色', all.filter((t) => t.base === 'light')],
    ].filter(([, items]) => items.length);

    for (const [label, items] of groups) {
      const title = document.createElement('div');
      title.className = 'theme-group-title';
      title.textContent = `${label} · ${items.length}`;
      body.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'theme-grid compact';
      for (const t of items) grid.appendChild(card(t));
      body.appendChild(grid);
    }
  };

  /** 一张主题卡片。全部用 DOM 构造器 + textContent，主题名不会变成 HTML */
  const card = (t) => {
    const v = t.vars || {};
    const btn = document.createElement('button');
    btn.className = 'theme-card' + (t.id === getThemeId() ? ' active' : '');
    btn.dataset.themeId = t.id;
    btn.title = t.desc || t.name;

    const prev = document.createElement('div');
    prev.className = 'theme-prev';
    prev.style.background = v['--bg'] || v['--surface'] || 'transparent';
    if (v['--bg-image'] && v['--bg-image'] !== 'none') {
      prev.style.backgroundImage = v['--bg-image'];
    }

    // 新拟态示例块：用主题自己的双向阴影渲染，所见即所得
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.background = v['--surface'];
    sw.style.boxShadow = `2px 2px 5px ${v['--sh-dark']}, -2px -2px 5px ${v['--sh-light']}`;
    if (v['--border']) sw.style.border = `1px solid ${v['--border']}`;
    if (v['--blur'] && v['--blur'] !== '0px') sw.style.backdropFilter = `blur(${v['--blur']})`;

    // 这两条是主题的装饰配色，不是状态色
    const bar1 = document.createElement('i');
    bar1.className = 'bar';
    bar1.style.background = v['--accent'];
    const bar2 = document.createElement('i');
    bar2.className = 'bar s';
    bar2.style.background = v['--env-color'];

    prev.append(sw, bar1, bar2);

    const name = document.createElement('div');
    name.className = 'theme-name';
    name.style.color = v['--text'];
    name.textContent = t.name;

    const desc = document.createElement('div');
    desc.className = 'theme-desc';
    desc.textContent = t.desc || (t.base === 'dark' ? '深色' : '浅色');

    btn.append(prev, name, desc);

    // 自定义主题可直接在这里删除
    if (t.custom) {
      const del = document.createElement('button');
      del.className = 'theme-del';
      del.title = '删除该自定义主题';
      del.textContent = '✕';
      del.onclick = (e) => {
        e.stopPropagation();
        deleteCustomTheme(t.id);
        if (getThemeId() === t.id) applyTheme(listThemes()[0].id);
        render();
        onPick?.(null);
      };
      btn.appendChild(del);
    }

    btn.onclick = () => {
      applyTheme(t.id);
      render();            // 立刻更新选中态，不等 onChange 回调
      onPick?.(t);
      closeThemePicker();
    };
    return btn;
  };

  render();

  // 在别处（比如设置页）切了主题，这里开着的话要跟着刷新
  const offChange = onChange(() => { if (current) render(); });

  current = { root, mask, offChange, onPick, anchorRect: anchor.getBoundingClientRect() };

  mask.onclick = closeThemePicker;
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', reposition, true);

  document.body.append(mask, root);
  reposition();
  // 聚焦弹出层，ESC 与 Tab 才好用
  root.tabIndex = -1;
  root.focus?.();
  return { close: closeThemePicker };
}

function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeThemePicker(); }
}

function reposition() {
  if (!current) return;
  const { root } = current;
  const a = current.anchorRect;
  if (!a) return;
  const W = root.offsetWidth || 340;
  // 右对齐到锚点，左边不够就往右挪，右边超出则贴边
  let left = a.right - W;
  left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
  root.style.top = `${a.bottom + 8}px`;
  root.style.left = `${left}px`;
}

export function closeThemePicker() {
  if (!current) return;
  const { root, mask, offChange } = current;
  offChange?.();
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', reposition, true);
  root.remove();
  mask.remove();
  current = null;
}

export function isThemePickerOpen() {
  return !!current;
}
