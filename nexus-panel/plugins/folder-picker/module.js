/**
 * folder-picker 服务 —— 全工具统一的「选择文件夹」对话框
 * ============================================================
 * 任何插件需要用户选一个目录，都调它：
 *
 *   const path = await ctx.services.call('folder-picker', 'pick', {
 *     title: '选择项目根目录', startPath: '', allowCreate: true,
 *   });
 *   // 取消 / 关闭 → null
 *
 * 为什么做成服务而不是各插件各写一份
 * ------------------------------------------------------------
 * 改造前项目里有两套：project-group 的 DirDialog、agent-flow 的 DirPicker。
 * 两套各自维护"快速起点 / 面包屑 / 路径输入 / 新建子目录"，
 * 于是同一个 bug 要修两遍，而常用文件夹若各存一份，
 * 用户在项目组里收藏的目录到了 agent-flow 就看不见 ——
 * 那正是"点了没反应又查不到原因"的那类问题。
 *
 * 为什么是 module（同页）而不是 iframe
 * ------------------------------------------------------------
 * 与宿主同文档，neumorphism.css 的 .fp-* 规则天然生效。
 * 做成 iframe 的话得自己引样式，否则弹出来"只有文字"
 * （demo-iframe 踩过的那个坑）。它是内置插件，同页不引入不可信代码。
 *
 * 为什么是纯 JS 而不是 React（module.tsx）
 * ------------------------------------------------------------
 * 服务要能被**任何**插件调用，包括无构建模式下跑的那些。
 * React/TSX 入口需要 Vite，无构建时整个服务会调不到；
 * 纯 JS 两种模式都能跑，且不依赖 node_modules 里装了什么。
 *
 * 【这条若被覆盖掉，不会报错】
 * 表现是所有「浏览」按钮点了没反应（services.call 找不到该 id）。
 * folder-picker-test.mjs 里钉住了 registry 条目。
 */

/*
 * 纯函数全部住在 js/fav-dirs.js —— 设置页的「常用文件夹」页签也用同一份。
 *
 * 【为什么不在这里各写一份】
 * 两处各写一份归一化，迟早在某处漏掉"去尾部斜杠"，
 * 于是同一个目录被判成两条收藏：用户看到两个一模一样的条目，
 * 删掉一个另一个还在，且不报错 —— 这类问题只能靠肉眼撞见。
 *
 * 这里 re-export 是为了让既有的 import 路径（含测试）不用改。
 */
import {
  FAV_MAX, normPath, normalizeFavs, favLabel, isFav, favIndexOf, crumbsOf,
} from '../../js/fav-dirs.js';

export { FAV_MAX, normPath, normalizeFavs, favLabel, isFav, crumbsOf };

const VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

function el(tag, props = {}, ...kids) {
  const [head, ...rest] = String(tag).split('.');
  const node = document.createElement(head || 'div');
  if (rest.length) node.className = rest.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else if (k === 'text') {
      node.textContent = v;
    } else {
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(9)) {
    if (kid == null || kid === false) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export default {
  name: '目录选择',
  version: VERSION,
  /*
   * ⚠️ interactive: true 不能省。
   *
   * 宿主只在标了 interactive 的服务上调用 showServiceUi（把服务容器
   * 弹成浮层）。不标的话 pick() 会建好 DOM 但容器**不可见** ——
   * 于是 Promise 永远等不到用户点确定，
   * 界面上表现为"点了浏览，然后什么都没发生"，且不报错。
   *
   * 反过来，md-render 那种纯计算服务**不能**标这个：
   * 标了会"调一下闪一下空白浮层"。
   */
  interactive: true,

  /**
   * 渲染面板。
   *
   * 服务是**懒加载**的：谁被调才挂谁，且挂载与调用分离 ——
   * mount 一次，之后每次 pick 只是显隐（宿主 showServiceUi 负责）。
   * 所以这里建好 DOM 就完事，状态全靠 panel 对象持有。
   */
  mount(ctx) {
    const panel = createPanel(ctx);
    const host = ctx.root || ctx.container || document.body;
    host.appendChild(panel.root);
    ctx.__fp = panel;
    return () => {
      try { panel.root.remove(); } catch { /* 已移除 */ }
      ctx.__fp = null;
    };
  },

  methods: {
    async describe() {
      return { name: '目录选择', version: VERSION, methods: ['describe', 'pick', 'listFavs', 'addFav', 'removeFav'] };
    },

    /** 打开选择器，返回选中的路径；取消返回 null。 */
    pick(args = {}, ctx) {
      const panel = ctx?.__fp;
      if (!panel) {
        /*
         * 不能静默返回 null：调用方拿到 null 只会当成"用户取消了"，
         * 于是界面什么都不做，而真相是服务没挂上。
         * 抛出去，调用方的 await 会 reject，错误信息是唯一线索。
         */
        throw new Error('folder-picker 服务尚未挂载（面板未创建）');
      }
      return panel.open(args);
    },

    /** 列出常用文件夹（设置页的管理卡片用）。 */
    async listFavs(_args = {}, ctx) {
      return ctx.__fp ? ctx.__fp.favs.slice() : [];
    },

    /** 追加一条收藏。已存在则忽略（返回当前表）。 */
    async addFav(args = {}, ctx) {
      if (!ctx?.__fp) throw new Error('folder-picker 服务尚未挂载');
      return ctx.__fp.addFav(args?.path, args?.label);
    },

    /** 移除一条收藏。 */
    async removeFav(args = {}, ctx) {
      if (!ctx?.__fp) throw new Error('folder-picker 服务尚未挂载');
      return ctx.__fp.removeFav(args?.path);
    },
  },
};

/**
 * 建面板。所有状态闭包持有 —— 服务只挂一次，不能用模块级变量，
 * 否则两个调用方并发 pick 会互相覆盖 resolve（一个拿到另一个的结果）。
 */
function createPanel(ctx) {
  const favs = [];
  let quick = [];
  let session = null;   // { resolve, reject, args }
  let path = '';
  let entries = [];
  let err = '';
  let loading = false;
  let naming = false;   // 正在输入昵称

  /* ---------- DOM ---------- */
  const titleEl = el('div.fp-title', { text: '选择文件夹' });
  const hintEl = el('div.fp-hint');
  const favsEl = el('div.fp-chips');
  const inputEl = el('input.p-input', { type: 'text', placeholder: '粘贴完整路径后回车' });
  const crumbsEl = el('div.fp-crumbs');
  const listEl = el('div.fp-list');
  const errEl = el('div.fp-err');
  const favBtn = el('button.p-btn', { type: 'button' });
  const nameInput = el('input.p-input.fp-name', { type: 'text', placeholder: '给它起个名字（可留空）' });
  const newNameEl = el('input.p-input.fp-newname', { type: 'text', placeholder: '在此目录下新建子文件夹' });
  const footEl = el('div.fp-foot');

  const root = el(
    'div.fp-panel',
    {},
    el('div.fp-head', {}, titleEl, el('button.fp-x', { type: 'button', title: '取消', onClick: () => cancel() }, '✕')),
    hintEl,
    favsEl,
    el('div.fp-bar', {},
      inputEl,
      el('button.p-btn', { type: 'button', onClick: () => go(inputEl.value.trim()) }, '前往'),
      favBtn,
    ),
    crumbsEl,
    errEl,
    listEl,
    footEl,
  );

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(inputEl.value.trim());
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commitName(nameInput.value); }
    if (e.key === 'Escape') { naming = false; render(); }
  });
  newNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createChild(newNameEl.value);
  });

  /* ---------- 数据 ---------- */

  async function loadFavs() {
    try {
      const r = await ctx.invoke('fpx_list_fav_dirs');
      favs.length = 0;
      for (const f of normalizeFavs(r)) favs.push(f);
    } catch (e) {
      /*
       * 读不到收藏**不能让整个选择器打不开**：
       * 快速起点还在，用户照样能一层层点进去。
       * 只把它显示成一行提示，而不是弹错误或空白。
       */
      setErr(`常用文件夹读取失败（${e?.message ?? e}），可从快速起点进入`);
    }
  }

  async function saveFavs() {
    try {
      await ctx.invoke('fpx_save_fav_dirs', { dirs: normalizeFavs(favs) });
      return true;
    } catch (e) {
      setErr(`常用文件夹保存失败：${e?.message ?? e}`);
      return false;
    }
  }

  async function go(p) {
    const target = normPath(p);
    setErr('');
    loading = true;
    render();
    try {
      const list = await ctx.invoke('fpx_list_dirs', { path: target });
      entries = Array.isArray(list) ? list : [];
      path = target;
      inputEl.value = target;
      err = '';
    } catch (e) {
      err = String(e?.message ?? e);
      /*
       * 失败时**不清空 path**：用户可能只是打错一个字，
       * 清空后连刚浏览到的位置都丢了，得从头再点一遍。
       */
    } finally {
      loading = false;
      render();
    }
  }

  function setErr(msg) { err = msg; render(); }

  function commitName(label) {
    if (!session) return;
    addFav(path, label);
    naming = false;
    render();
  }

  async function addFav(p, label) {
    const np = normPath(p);
    if (!np) { setErr('当前没有可收藏的目录'); return favs.slice(); }
    if (isFav(favs, np)) return favs.slice();
    favs.push({ path: np, label: String(label ?? '').trim() });
    const ok = await saveFavs();
    if (!ok) favs.pop();   // 保存失败就回滚，别让界面显示一个存不下的条目
    render();
    return favs.slice();
  }

  async function removeFav(p) {
    const np = normPath(p);
    const i = favIndexOf(favs, np);
    if (i < 0) return favs.slice();
    const [gone] = favs.splice(i, 1);
    const ok = await saveFavs();
    if (!ok) favs.splice(i, 0, gone);
    render();
    return favs.slice();
  }

  /**
   * 确认选择。
   *
   * 【返回契约：固定 `{ path, action }`，不随参数变化】
   * 曾经考虑过"没传 extraAction 就返回字符串"，那更省事，
   * 但**返回类型随入参变化**是最难查的一类接口：
   * 调用方今天按字符串写，明天谁加了个 extraAction，
   * 它拿到的就变成对象 —— 不报错，只是 `if (r)` 永远为真、
   * 路径变成 "[object Object]"，一路静默错到写盘才发现。
   * 所以固定返回对象：path 为 null 即取消。
   */
  function commitPick(action = 'pick') {
    if (!session) return;
    const res = session.resolve;
    const stop = session.stop;
    session = null;
    try { stop?.(); } catch { /* 解除失败不影响结果 */ }
    res({ path: path || null, action: path ? action : null });
  }

  function cancel() {
    if (!session) return;
    const res = session.resolve;
    const stop = session.stop;
    session = null;
    /*
     * 取消**不 reject**：取消是正常操作，不是错误。
     * reject 会让每个调用方都得写 try/catch，
     * 漏写的那个就变成 unhandled rejection，界面上表现为"点了没反应"。
     */
    try { stop?.(); } catch { /* 同上 */ }
    res({ path: null, action: null });
  }

  /* ---------- 渲染 ---------- */

  function render() {
    titleEl.textContent = session?.args?.title || '选择文件夹';
    const hint = session?.args?.hint || '';
    hintEl.textContent = hint;
    hintEl.style.display = hint ? '' : 'none';

    /* 常用文件夹 */
    favsEl.textContent = '';
    for (const f of favs) {
      const chip = el('button.fp-chip', {
        type: 'button',
        title: f.path,
        onClick: () => { commitFav(f); },
      }, `★ ${favLabel(f)}`);
      const del = el('button.fp-chip-x', {
        type: 'button',
        title: '取消收藏',
        onClick: (e) => { e.stopPropagation(); removeFav(f.path); },
      }, '✕');
      chip.appendChild(del);
      favsEl.appendChild(chip);
    }
    /* 快速起点：放在常用之后 —— 它是兜底，收藏再多也得能回到盘符 */
    for (const q of quick) {
      favsEl.appendChild(el('button.fp-chip.plain', {
        type: 'button', title: q.path, onClick: () => go(q.path),
      }, q.name));
    }

    /* 收藏按钮 */
    const has = isFav(favs, path);
    favBtn.textContent = has ? '★ 已收藏' : '☆ 收藏此目录';
    favBtn.disabled = !path || has;
    favBtn.onclick = () => {
      if (naming) { naming = false; render(); return; }
      naming = true;
      render();
      nameInput.focus();
    };

    errEl.textContent = err || '';
    errEl.style.display = err ? '' : 'none';

    /* 面包屑 */
    crumbsEl.textContent = '';
    crumbsEl.appendChild(el('button.fp-crumb', { type: 'button', onClick: () => go('') }, '⌂'));
    for (const c of crumbsOf(path)) {
      crumbsEl.appendChild(el('span.fp-crumb-sep', { text: '›' }));
      crumbsEl.appendChild(el('button.fp-crumb', {
        type: 'button', onClick: () => go(c.path),
      }, c.label));
    }

    /* 昵称输入 */
    const oldName = root.querySelector('.fp-namerow');
    if (oldName) oldName.remove();
    if (naming) {
      const row = el('div.fp-namerow', {},
        nameInput,
        el('button.p-btn', { type: 'button', onClick: () => commitName(nameInput.value) }, '保存'),
        el('button.p-btn', { type: 'button', onClick: () => { naming = false; render(); } }, '取消'),
      );
      crumbsEl.after(row);
    }

    /* 列表 */
    listEl.textContent = '';
    if (loading) {
      listEl.appendChild(el('div.p-muted', { text: '加载中…' }));
    } else if (err) {
      // 出错时不覆盖上面的错误行，这里只给个空态
    } else if (!path && entries.length === 0) {
      listEl.appendChild(el('div.p-muted', { text: '请从上方选择一个起点' }));
    } else if (path && entries.length === 0) {
      listEl.appendChild(el('div.p-muted', { text: '（该目录下没有子文件夹）' }));
    } else {
      for (const e of entries) {
        listEl.appendChild(el('div.fp-dirrow', {},
          el('button.fp-dirname', {
            type: 'button', onClick: () => go(e.path),
            onDblclick: () => { path = e.path; commitPick(); },
          }, `📁 ${e.name}`, marked(e.path) ? el('small.fp-ok-tag', { text: markLabel() }) : null),
          el('button.p-btn', { type: 'button', onClick: () => { path = e.path; commitPick(); } }, '选它'),
        ));
      }
    }

    /* 新建子文件夹 —— 仅调用方要 allowCreate 时才出现 */
    const oldNew = root.querySelector('.fp-newrow');
    if (oldNew) oldNew.remove();
    if (session?.args?.allowCreate) {
      const row = el('div.fp-newrow', {},
        newNameEl,
        el('button.p-btn', {
          type: 'button',
          onClick: () => createChild(newNameEl.value),
        }, '新建并进入'),
      );
      listEl.after(row);
    }

    /* ---------- 底部 ---------- */
    footEl.textContent = '';
    const marks = session?.args?.marks;
    if (path) {
      /*
       * 当前目录的授权/标记状态**必须在选之前就显示出来**：
       * agent-flow 里选了未授权目录会写失败，
       * 而"选的时候看不出来、写完才报错"比失败本身更让人困惑。
       */
      const state = marks
        ? (marked(path) ? ` · ${markLabel()}` : ` · ${marks.hint ?? '未标记'}`)
        : '';
      footEl.appendChild(el('span.fp-cur', { title: path }, `当前：${path}${state}`));
    }
    const extra = session?.args?.extraAction;
    if (extra?.label) {
      footEl.appendChild(el('button.p-btn', {
        type: 'button', disabled: !path,
        onClick: () => commitPick(String(extra.id ?? 'extra')),
      }, extra.label));
    }
    footEl.appendChild(el('button.p-btn', { type: 'button', onClick: () => cancel() }, '取消'));
    footEl.appendChild(el('button.p-btn.primary', {
      type: 'button', disabled: !path,
      onClick: () => commitPick('pick'),
    }, '选择此文件夹'));
  }

  /**
   * 监视"宿主把浮层收起来了"。
   *
   * ⚠️ 为什么必须有这个：宿主在遮罩上挂了 `click → showServiceUi(false)`，
   * 它**只收起浮层，不通知服务**。服务自己的取消按钮管不到这条路径，
   * 于是用户点一下遮罩 → 浮层消失了 → 但 pick 的 Promise 永远悬着。
   * 调用方的 await 再也不返回，界面表现为"点了浏览，然后什么都没发生"，
   * 而且不报错 —— 这正是最难查的那一类。
   *
   * 收起是"移到 -99999px"而不是 display:none，所以只能量位置，
   * 不能查 offsetParent。
   */
  function watchHidden(onHidden) {
    const host = root.parentElement;
    if (!host || typeof MutationObserver === 'undefined') return () => {};
    const mo = new MutationObserver(() => {
      const r = root.getBoundingClientRect();
      if (r.left < -10000) onHidden();
    });
    mo.observe(host, { attributes: true, attributeFilter: ['style'] });
    return () => mo.disconnect();
  }

  /** 该路径是否在调用方给的标记列表里（如 agent-flow 的"已授权目录"）。 */
  function marked(p) {
    const marks = session?.args?.marks;
    if (!marks || !Array.isArray(marks.list)) return false;
    const np = normPath(p).toLowerCase();
    return marks.list.some((m) => {
      const mp = normPath(m).toLowerCase();
      // 目录命中：相等，或落在某个已标记根之内
      return np === mp || np.startsWith(mp.endsWith('/') ? mp : `${mp}/`);
    });
  }

  function markLabel() {
    return String(session?.args?.marks?.label ?? '已授权');
  }

  function commitFav(f) {
    // 常用项一步到位：点它就是选它（"常用"的意义就是不用再浏览）
    path = normPath(f.path);
    commitPick();
  }

  /* ---------- 对外 ---------- */

  /** 打开前的准备：定起点、拉常用、列目录。抛错由调用方转成 reject。 */
  async function prepare(args) {
    const startPath = normPath(args?.startPath ?? '');

    // 起点：调用方给了就用，没给就落到快速起点第一个
    let start = startPath;
    if (!quick.length) {
      try { quick = (await ctx.invoke('fpx_quick_roots')) || []; } catch { quick = []; }
    }
    if (!start) start = normPath(quick[0]?.path ?? '');

    await loadFavs();

    path = start;
    inputEl.value = start;
    if (start) await go(start); else render();
  }

  /**
   * 新建子文件夹并进入。
   *
   * 只在 allowCreate 时显示：项目组里"选个地方建项目"这类场景需要，
   * 而"选个已有目录"的场景给了反而是干扰（多一个用不到的输入框）。
   */
  async function createChild(name) {
    const nm = String(name ?? '').trim();
    if (!nm || !path) return;
    loading = true;
    render();
    try {
      const p = await ctx.invoke('fpx_create_folder', {
        parent: path, name: nm, hierarchy: null, template: null,
      });
      newNameEl.value = '';
      await go(normPath(p));
    } catch (e) {
      setErr(String(e?.message ?? e));
      loading = false;
      render();
    }
  }

  return {
    root,
    favs,
    addFav,
    removeFav,
    open(args) {
      return new Promise((resolve, reject) => {
        session = { resolve, reject, args: args || {}, stop: null };
        /*
         * 两条"用户不点按钮就走掉"的退路：Esc 与点遮罩。
         * 没有它们，用户用这两种方式关掉浮层后 Promise 永远悬着 ——
         * 浮层消失了，调用方的 await 却再也不返回。
         */
        const onEsc = (e) => { if (e.key === 'Escape') cancel(); };
        document.addEventListener('keydown', onEsc);
        const stopWatch = watchHidden(() => cancel());
        session.stop = () => {
          document.removeEventListener('keydown', onEsc);
          stopWatch();
        };
        prepare(args).catch((e) => {
          /*
           * 打开就失败（比如起点全拉不到）也要结束会话 ——
           * 否则 Promise 永远悬着，界面上表现为"点了没反应"，
           * 而调用方连个错误都看不到。
           */
          try { session?.stop?.(); } catch { /* ignore */ }
          session = null;
          reject(e);
        });
      });
    },
    _render: render,
  };
}
