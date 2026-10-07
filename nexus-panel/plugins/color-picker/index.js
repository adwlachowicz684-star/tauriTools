/* ⚠️ 本文件当前**没有任何地方加载它** —— 是休眠的死入口。
 * ------------------------------------------------------------
 * 引用链实测：registry 的 entry 是 ./plugins/color-picker/index.html，
 * 而 index.html 只 script src 了 ./main.tsx。全仓（源码 / 测试 / 脚本 /
 * index.html / registry）扫不到任何一处 import 本文件。
 *
 * 于是这里写的是**色盘的第二份完整实现**（原生 JS 版），而真正在跑的是
 * main.tsx（React 版，走共享组件 ColorPicker）。两份做同一件事，
 * 已经漂移 —— 对照如下（2026-10 核对）：
 *
 *   · version      本文件 1.0.0            main.tsx 3.0.0
 *   · methods      声明里漏了 presets      五项齐全，另有 implementation
 *   · 起始色       硬编码 #3E63DD          共享常量 DEFAULT_COLOR #7C8CFF
 *   · pick 返回    **颜色字符串**          **{ hex, custom } 对象**
 *   · 取消         reject(已取消)          resolve({ hex: null, custom })
 *   · 自定义色     存进 ctx.store          交给调用方存（取消也要带回）
 *
 * 最危险的是 pick 的返回类型：调用方按现行契约写 `r.hex`（见 main.tsx
 * 的注释），接到本文件会拿到字符串，`r.hex` 是 undefined —— 不报错，
 * 静默拿错值。取消那条更糟：契约是 resolve，这里是 reject。
 *
 * 结论：**别直接把它接上无构建**（registry 加 noBuild 分支之类）。
 * 要启用就得先把上面六项与 main.tsx 对齐，尤其是 pick 的返回形态。
 * 在此之前它只有"参考实现"的价值，改动不会体现在界面上、也不会报错。
 *
 * 同理，本文件也**不该再新增功能** —— 加在这里等于加进一个没人走的分叉。
 *
 * 守卫：regression-guard-test.mjs 第 1.6 节盯着"孤儿入口文件"清单，
 * 新增一个会立刻报红（本文件已登记为已知）。
 */
import { bootServicePlugin } from '../../js/plugin-sdk.js';
import { alert as showAlert } from '../../js/dialog.js';
/*
 * ⚠️ 这里**不能**写 import '../../css/dialog.css' —— 原生 ESM 不能 import CSS。
 *
 * 浏览器按 text/css 收到它，会判成"不是 JS 模块" → **整个 index.js 加载失败**。
 * 症状是插件一片空白、功能全无，控制台只有一条 MIME 报错，不看控制台根本
 * 不知道是这一行造成的。
 *
 * 这个错在 mindmap 上**复发过 3 次**（修好又被整份覆盖回去），所以本文件
 * 也顺手清了同一行。css/dialog.css 顶部写着规则：插件一律在自己的 CSS 里
 *   @import url('../../css/dialog.css');
 * 本插件的无构建入口一旦启用，把这一行加进 style.css 即可 —— 走 CSS 的
 * @import 才对，走 JS 的 import 永远是错的。
 *
 * 全仓扫描守卫：regression-guard-test.mjs 第 1 节（任何插件 JS 都不许
 * import CSS，包括这一行注释里写的路径——那条断言读的是剥注释后的源码）。
 */
import {
  PRESET_COLORS, normalizeHex, hexToRgb, rgbToHex, hexToHsv, hsvToRgb, hsvToHex,
} from './color';

/**
 * 取色服务（kind:'service'）
 * ------------------------------------------------------------
 * 把 project-group 里那套色盘抽成公共服务，供**所有**插件调用。
 *
 * 价值：色盘原本只在 project-group 里有一份，别的插件要用就得各拷一份；
 * 现在一份实现共用，升级也不用改调用方。
 *
 * 颜色工具从**本目录的 ./color** 取，这是唯一实现处。
 *
 * 此前写的是 '../project-group/utils/color'，两个问题：
 *   ① 方向反了 —— 那份文件顶部明写"依赖方向：project-group → color-picker
 *      （单向，无循环）"，它只是 `export *` 转发回本目录。这里反向去取，
 *      等于 color-picker → project-group → color-picker，绕成一个环。
 *   ② 绕远了 —— 转发文件本身不含实现，取到的还是同一份，只多一次跳转。
 *
 * 与 project-group 的内联色盘共用同一份 PRESET_COLORS，避免两边各存一份
 * 然后慢慢漂移（同一个"常用色"在两个界面显示成不同颜色）。
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
        } catch (e) { void showAlert({ title: '取色失败', message: '屏幕取色失败：' + (e?.message || e) }); }
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
