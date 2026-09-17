import { bootServicePlugin } from '../../js/plugin-sdk.js';
import { PRESET_ICON_NAMES } from './iconNames.js';

/**
 * 图标选择服务（kind:'service'）
 * ------------------------------------------------------------
 * 把内置图标库（122 个 .ico）的浏览与选择抽成公共服务。
 *
 * 图标物理文件仍放在 project-group/preseticons/ 下 ——
 * 这里用相对路径 ../project-group/preseticons/ 引用，
 * 与宿主同 origin 的 iframe 可以直接访问。
 *
 * **这是一个已知的设计妥协**（见 README）：服务本该自带资源、不依赖别的插件，
 * 但 122 个 .ico 复制一份会让仓库凭空多出一堆二进制。
 * 等后续真的要把图标服务独立分发时，再把资源搬进来。
 */

const ICON_DIR = '../project-group/preseticons/';
const iconUrl = (name) => `${ICON_DIR}${encodeURIComponent(name)}.ico`;

/** 打开图标浏览面板，返回 { name, url }；取消则 reject */
async function browse({ keyword = '' } = {}) {
  const ui = document.getElementById('ui');
  if (!ui) throw new Error('图标服务：找不到挂载点');

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

    let cur = null;
    const grid = el('div', { className: 'grid' });

    const paint = (kw) => {
      grid.innerHTML = '';
      const k = (kw || '').trim().toLowerCase();
      const list = k
        ? PRESET_ICON_NAMES.filter((n) => n.toLowerCase().includes(k))
        : PRESET_ICON_NAMES;
      if (!list.length) {
        grid.append(el('div', { className: 'hint' }, '没有匹配的图标'));
        return;
      }
      for (const name of list) {
        const img = el('img', { src: iconUrl(name), alt: name });
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        grid.append(el('div', {
          className: 'cell' + (cur === name ? ' sel' : ''),
          onclick: () => { cur = name; paint(search.value); },
        }, img, el('span', {}, name)));
      }
    };

    const search = el('input', {
      className: 'search', placeholder: '搜索图标名…', value: keyword,
      oninput: (e) => paint(e.target.value),
    });

    const okBtn = el('button', {
      className: 'primary',
      onclick: () => {
        if (!cur) { reject(new Error('未选择图标')); return; }
        ui.innerHTML = '';
        resolve({ name: cur, url: iconUrl(cur) });
      },
    }, '确定');

    const cancelBtn = el('button', {
      onclick: () => { ui.innerHTML = ''; reject(new Error('已取消')); },
    }, '取消');

    ui.innerHTML = '';
    ui.append(
      el('div', {}, '选择图标（共 ' + PRESET_ICON_NAMES.length + ' 个）'),
      search,
      grid,
      el('div', { className: 'row' }, okBtn, cancelBtn),
    );
    paint(keyword);
  });
}

bootServicePlugin({
  async describe() {
    return {
      name: '图标选择服务', version: '1.0.0',
      methods: ['describe', 'browse', 'list', 'url'],
      count: PRESET_ICON_NAMES.length,
    };
  },

  /** 打开浏览面板选择图标 */
  async browse(args = {}) { return browse(args); },

  /** 只要清单（调用方自己画格子时用） */
  async list() { return [...PRESET_ICON_NAMES]; },

  /** 名字 → URL */
  async url({ name } = {}) { return iconUrl(name); },
});
