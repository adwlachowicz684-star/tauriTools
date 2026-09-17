import { bootServicePlugin } from '../../js/plugin-sdk.js';

/**
 * 取色服务（kind:'service'）
 * ------------------------------------------------------------
 * 把 project-group 里那套色盘抽成公共服务，供**所有**插件调用。
 *
 * 价值：色盘原本只在 project-group 里有一份，别的插件要用就得各拷一份；
 * 现在一份实现共用，升级也不用改调用方。
 *
 * 预设 24 色取自原 C# 版 ColorPickDialog 的 PresetColors，不可删改。
 * 颜色工具（normalize / hexToRgb / rgbToHex）与 project-group 的实现同源。
 */

/** 预设常用色 24 个（取自原 C# 版 ColorPickDialog 的 PresetColors，不可删） */
export const PRESET_COLORS = [
  '#E5484D', '#D9A441', '#F5A623', '#B7C94A',
  '#46A758', '#2FAE9B', '#12A594', '#0091FF',
  '#3E63DD', '#6E56CF', '#8E4EC6', '#BF4AC8',
  '#D6409F', '#E93D82', '#FF6B35', '#FFD23F',
  '#8FD14F', '#00C2A8', '#4098D7', '#5B5BD6',
  '#9D34DA', '#F472B6', '#B4B9C2', '#7C8698',
];

const MAX_CUSTOM = 24;

function normalize(hex) {
  const s = (hex || '').trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  let t = m[1];
  if (t.length === 3) t = t.split('').map((c) => c + c).join('');
  return `#${t.toUpperCase()}`;
}

function hexToRgb(hex) {
  const h = normalize(hex) ?? '#000000';
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function rgbToHex(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n) || 0))
    .toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/**
 * 打开取色面板并等待用户选择。
 *
 * 返回 '#RRGGBB'，用户取消则 reject。
 *
 * 为什么要真的等用户操作：色盘是**交互式**服务 —— 调用方要的是"用户选的那个色"，
 * 所以这里返回一个在用户点确定/取消时才 settle 的 Promise。
 * 这也正是服务插件比"各插件各拷一份 UI"更值得的地方：交互 UI 只有一份。
 */
async function open({ initial = '#3E63DD' } = {}, ctx) {
  const ui = document.getElementById('ui');
  if (!ui) throw new Error('取色服务：找不到挂载点');

  let cur = normalize(initial) || '#3E63DD';
  let custom = [];
  try { custom = (await ctx.store.get('custom')) || []; } catch { custom = []; }

  return new Promise((resolve, reject) => {
    const el = (tag, attrs = {}, ...kids) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style') Object.assign(n.style, v);
        else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
        else n[k] = v;
      }
      for (const k of kids) n.append(k);
      return n;
    };

    const preview = el('div', { className: 'preview', style: { background: cur } });
    const hexInput = el('input', { value: cur, style: { width: '90px' } });
    const sliders = ['r', 'g', 'b'].map((k, i) =>
      el('input', { type: 'range', min: 0, max: 255, className: 'sl',
        value: hexToRgb(cur)[i],
        oninput: (e) => {
          const rgb = hexToRgb(cur); rgb[i] = +e.target.value;
          cur = rgbToHex(...rgb); paint();
        } }));

    const grid = el('div', { className: 'grid' });
    const paintSwatches = () => {
      grid.innerHTML = '';
      for (const c of [...PRESET_COLORS, ...custom]) {
        grid.append(el('button', {
          className: 'sw' + (c === cur ? ' sel' : ''),
          style: { background: c },
          title: c,
          onclick: () => { cur = c; paint(); },
        }));
      }
    };

    const paint = () => {
      preview.style.background = cur;
      hexInput.value = cur;
      const rgb = hexToRgb(cur);
      sliders.forEach((s, i) => { s.value = rgb[i]; });
      paintSwatches();
    };

    hexInput.addEventListener('change', () => {
      const v = normalize(hexInput.value);
      if (v) { cur = v; paint(); } else { hexInput.value = cur; }
    });

    /* 吸管：调系统的屏幕取色（Rust 侧 pick_screen_color，仅 Windows）。
       失败要给出明确原因，不能静默 —— 否则用户点了没反应还以为是坏了。 */
    const eyedropper = el('button', {
      onclick: async () => {
        try {
          const hex = await ctx.invoke('fpx_pick_color', {});
          const v = normalize(hex);
          if (v) { cur = v; paint(); }
        } catch (e) {
          alert('屏幕取色失败：' + (e?.message || e));
        }
      },
    }, '吸管');

    const okBtn = el('button', { className: 'primary', onclick: () => {
      // 记住自定义色（用户调过的不在预设里就记下来，上限 MAX_CUSTOM）
      if (!PRESET_COLORS.includes(cur) && !custom.includes(cur)) {
        custom = [cur, ...custom].slice(0, MAX_CUSTOM);
        ctx.store.set('custom', custom).catch(() => {});
      }
      cleanup();
      resolve(cur);
    } }, '确定');

    const cancelBtn = el('button', { onclick: () => { cleanup(); reject(new Error('已取消')); } }, '取消');

    const wrap = el('div', {},
      el('div', {}, '取色'),
      grid,
      el('div', { className: 'row' }, preview, hexInput, eyedropper),
      el('div', {}, el('label', {}, 'R'), sliders[0]),
      el('div', {}, el('label', {}, 'G'), sliders[1]),
      el('div', {}, el('label', {}, 'B'), sliders[2]),
      el('div', { className: 'row' }, okBtn, cancelBtn),
      el('div', { className: 'hint' }, '自定义色会自动记住（最多 ' + MAX_CUSTOM + ' 个）'),
    );

    function cleanup() { ui.innerHTML = ''; }
    ui.innerHTML = '';
    ui.append(wrap);
    paint();
  });
}

bootServicePlugin({
  /** 服务自述，供插件面板与调用方自检 */
  async describe() {
    return { name: '取色服务', version: '1.0.0', methods: ['describe', 'pick', 'normalize'] };
  },

  /** 打开取色面板，返回用户选中的颜色 */
  async pick(args = {}, ctx) { return open(args, ctx); },

  /** 纯计算：把任意输入归一化成 #RRGGBB，非法返回 null */
  async normalize({ color } = {}) { return normalize(color); },

  /** 列出预设色（调用方想自己画格子时用） */
  async presets() { return [...PRESET_COLORS]; },
});
