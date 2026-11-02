import { bootServicePlugin } from '../../js/plugin-sdk.js';
import { PRESET_ICON_NAMES } from './iconNames.js';

/**
 * 图标选择服务（kind:'service'）
 * ------------------------------------------------------------
 * 把内置图标库（122 个 .ico）的浏览与选择抽成公共服务。
 *
 * 图标物理文件**自带**在本服务目录下（preseticons/，122 个 .ico）。
 *
 * **为什么搬进来了（翻案 N22 的结论）**
 *
 * N22 当初决定不搬，理由是「project-group 才是主用户、复制 747 KB 不划算」
 * —— 在**单仓库、一起构建**的形态下这个判断是对的：两处引用解析到同一个
 * runtime-plugins/ 路径，同 origin，本来就没有隔离问题。
 *
 * 但目标形态变了：**每个插件一个 GitHub 仓库、点安装即用、互不影响**。
 * 一旦独立安装，用户可能只装了 icon-picker 而没装 project-group，
 * 这时 `../project-group/preseticons/` 立刻 404。
 *
 * ⛔ 这条失效**构建期完全不响**：ICON_DIR 是字符串常量，Vite 不解析它，
 *    产物里原样保留该路径，构建成功、插件能打开，
 *    只有图标**一片空白** —— 与 build-plugins.mjs 里记的
 *    「插件能开、图标一片空白」是同一形状，是最难查的那一类。
 *    实测（第一百八十三轮）：构建产物 index.html 与 assets/*.js 里
 *    都保留着 `../project-group/preseticons/` 原样字符串。
 *
 * 于是代价（多一份 747 KB 二进制）换掉的是一类静默失效，划算。
 *
 * ⚠ 现在有两份 preseticons（project-group 一份、本服务一份）。
 *    两份必须保持一致 —— 由 `cross-plugin-coupling-test.mjs` 的
 *    「共享资源一致性」一节守着（比对文件清单与逐字节内容）。
 *    将来若抽成共享资源包，那个断言就是销账的凭据。
 */

const ICON_DIR = './preseticons/';
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
