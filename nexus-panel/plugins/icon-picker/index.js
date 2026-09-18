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
 * **为什么最终决定不把资源搬进本服务（N22 的处理结论）**
 *
 * 直觉上服务该自带资源、不依赖别的插件。但核实后不改，三个理由：
 *
 *   1. **project-group 才是主用户**。它的 PresetIconGrid 用
 *      `./preseticons/x.ico` 显示同一批图标。搬走要么断它的引用，
 *      要么复制 122 个二进制（747 KB）—— 都不划算。
 *   2. **搬走解决不了真问题**。真正的风险是「Vite 构建后图标全部 404」
 *      （动态拼路径 Vite 分析不了，见 native-assets-test.mjs），
 *      而这与资源放在哪个插件目录下**无关**，靠 vite.config 的
 *      NATIVE_SUBDIRS 拷贝规则解决（已修，两条引用同一份拷贝）。
 *   3. 两处引用解析到**同一个** dist 路径，同 origin，本来就没有隔离问题。
 *
 * 结论：资源归属保持不变，等真的要独立分发（比如图标服务单独提供给
 * 第三方）时再搬 —— 那时应该连 project-group 的引用一起改成走服务。
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
        /* 点确定但没选：按未选处理，与取消一致（返回 null） */
        if (!cur) { resolve(null); return; }
        ui.innerHTML = '';
        resolve({ name: cur, url: iconUrl(cur) });
      },
    }, '确定');

    const cancelBtn = el('button', {
      onclick: () => { ui.innerHTML = ''; resolve(null); },
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
