import { bootServicePlugin } from '../../js/plugin-sdk.js';
import {
  PRESET_COLORS, normalizeHex, hexToRgb, rgbToHex, hexToHsv, hsvToRgb, hsvToHex,
} from '../project-group/utils/color';

/**
 * 取色服务（kind:'service'）
 * ------------------------------------------------------------
 * 把 project-group 里那套色盘抽成公共服务，供**所有**插件调用。
 *
 * 价值：色盘原本只在 project-group 里有一份，别的插件要用就得各拷一份；
 * 现在一份实现共用，升级也不用改调用方。
 *
 * 预设色与颜色工具都从 ../project-group/utils/color 来 ——
 * 与 project-group 的内联色盘共用同一份，避免两边各存一份 PRESET_COLORS
 * 然后慢慢漂移（同一个"常用色"在两个界面显示成不同颜色）。
 *
 * 依赖别的插件的目录并不理想（将来独立分发时要搬走），
 * 但比复制一份定义要好：复制出来的是**会漂移的重复**，
 * 而路径依赖至少只有一处真相。
 */

const MAX_CUSTOM = 24;

/**
 * 打开取色面板并等待用户选择。
 *
 * 返回 '#RRGGBB'，用户取消则 reject。
 *
 * 为什么要真的等用户操作：色盘是**交互式**服务 —— 调用方要的是"用户选的那个色"，
 * 所以这里返回一个在用户点确定/取消时才 settle 的 Promise。
 */
async function open({ initial = '#3E63DD' } = {}, ctx) {
  const ui = document.getElementById('ui');
  if (!ui) throw new Error('取色服务：找不到挂载点');

  let hsv = hexToHsv(normalizeHex(initial) || '#3E63DD');
  const cur = () => hsvToHex(hsv);
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

    const preview = el('div', { className: 'preview' });
    const hexInput = el('input', { value: cur(), style: { width: '90px' } });

    /* SV 面板：白→色相（横）叠加 透明→黑（纵）。
       用 CSS 双层渐变实现，不需要 canvas —— 纯 CSS 就够精确，
       也省掉一段画布绘制与坐标换算的代码。 */
    const svPanel = el('div', { className: 'sv' });
    const svDot = el('div', { className: 'sv-dot' });
    svPanel.append(svDot);

    /* 色相条：标准七段彩虹 */
    const hueBar = el('div', { className: 'hue' });
    const hueDot = el('div', { className: 'hue-dot' });
    hueBar.append(hueDot);

    /** 按住拖动的通用处理（面板与色相条共用同一套逻辑） */
    const drag = (node, onMove) => {
      const pos = (e) => {
        const r = node.getBoundingClientRect();
        return {
          x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
          y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
        };
      };
      let moving = false;
      node.addEventListener('pointerdown', (e) => {
        moving = true; node.setPointerCapture?.(e.pointerId);
        onMove(pos(e));
      });
      node.addEventListener('pointermove', (e) => { if (moving) onMove(pos(e)); });
      const stop = () => { moving = false; };
      node.addEventListener('pointerup', stop);
      node.addEventListener('pointercancel', stop);
    };

    drag(svPanel, ({ x, y }) => { hsv = { h: hsv.h, s: x, v: 1 - y }; paint(); });
    drag(hueBar, ({ x }) => { hsv = { ...hsv, h: x * 360 }; paint(); });

    const grid = el('div', { className: 'grid' });
    const paintSwatches = () => {
      grid.innerHTML = '';
      const c = cur();
      for (const col of [...PRESET_COLORS, ...custom]) {
        grid.append(el('button', {
          className: 'sw' + (col === c ? ' sel' : ''),
          style: { background: col }, title: col,
          onclick: () => { hsv = hexToHsv(col); paint(); },
        }));
      }
    };

    const paint = () => {
      const c = cur();
      preview.style.background = c;
      hexInput.value = c;
      /* 面板底色 = 当前色相的纯色，两层渐变叠上去就是标准 SV 平面 */
      svPanel.style.background =
        `linear-gradient(to top, #000, transparent),` +
        `linear-gradient(to right, #fff, transparent),` +
        hsvToHex({ h: hsv.h, s: 1, v: 1 });
      svDot.style.left = `${hsv.s * 100}%`;
      svDot.style.top = `${(1 - hsv.v) * 100}%`;
      svDot.style.background = c;
      hueDot.style.left = `${(hsv.h / 360) * 100}%`;
      paintSwatches();
    };

    hexInput.addEventListener('change', () => {
      const v = normalizeHex(hexInput.value);
      if (v) { hsv = hexToHsv(v); paint(); } else { hexInput.value = cur(); }
    });

    /* 吸管：调系统的屏幕取色（Rust 侧 pick_screen_color，仅 Windows）。
       失败要给出明确原因，不能静默 —— 否则用户点了没反应还以为是坏了。 */
    const eyedropper = el('button', {
      onclick: async () => {
        try {
          const hex = await ctx.invoke('fpx_pick_color', {});
          const v = normalizeHex(hex);
          if (v) { hsv = hexToHsv(v); paint(); }
        } catch (e) { alert('屏幕取色失败：' + (e?.message || e)); }
      },
    }, '吸管');

    const okBtn = el('button', { className: 'primary', onclick: () => {
      const c = cur();
      if (!PRESET_COLORS.includes(c) && !custom.includes(c)) {
        custom = [c, ...custom].slice(0, MAX_CUSTOM);
        ctx.store.set('custom', custom).catch(() => {});
      }
      ui.innerHTML = '';
      resolve(c);
    } }, '确定');

    const cancelBtn = el('button', {
      onclick: () => { ui.innerHTML = ''; reject(new Error('已取消')); },
    }, '取消');

    ui.innerHTML = '';
    ui.append(
      el('div', {}, '取色'),
      el('div', { className: 'svwrap' }, svPanel),
      hueBar,
      grid,
      el('div', { className: 'row' }, preview, hexInput, eyedropper),
      el('div', { className: 'row' }, okBtn, cancelBtn),
      el('div', { className: 'hint' }, '自定义色会自动记住（最多 ' + MAX_CUSTOM + ' 个）'),
    );
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
  async normalizeHex({ color } = {}) { return normalizeHex(color); },

  /** 列出预设色（调用方想自己画格子时用） */
  async presets() { return [...PRESET_COLORS]; },
});
