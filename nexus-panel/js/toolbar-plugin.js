/**
 * 工具栏插件（kind: 'toolbar'）
 * ============================================================
 *
 * 这类插件显示在**标题栏右上角**（窗口控制按钮左侧那一排），
 * 不进侧边栏、也没有自己的页面。
 *
 * 与另两类 kind 的区别
 * ------------------------------------------------------------
 *   app     侧边栏可见，有完整页面（挂载到内容区）
 *   service 不显示，被其它插件 ctx.services.call 调用
 *   toolbar 显示为一个小按钮，点了执行一个动作
 *
 * 为什么只支持 module（同页）、不支持 iframe
 * ------------------------------------------------------------
 * 三个内置按钮（主题 / 置顶 / 托盘）**必须**直接调 Tauri：
 *
 *   · 置顶  getCurrentWindow().setAlwaysOnTop() —— iframe 里拿不到
 *   · 托盘  host.win('hide')                    —— 同上
 *   · 快捷键注入宿主文档，而 iframe 内按键不跨文档冒泡
 *
 * 所以 kind:'toolbar' 配 type:'iframe' 是**自相矛盾**的配置：
 * 配置了却永远没反应，而代码不报错。注册表校验里直接拒绝这种组合，
 * 不给"静默失效"留余地。
 *
 * 插件写法
 * ------------------------------------------------------------
 *   export default {
 *     id: 'toolbar-pin',
 *     label: '⇱',
 *     tip: '窗口置顶',
 *     order: 20,
 *     async onClick(api) { api.setActive(true); },
 *   };
 *
 * 用 `export default` 而不是 boot*Plugin 的副作用注册，是因为
 * 工具栏插件只是一份**描述**，不需要模块级副作用；
 * 宿主 import 完直接读 default，不必维护"当前正在加载谁"的全局状态。
 *
 * api 提供
 * ------------------------------------------------------------
 *   setActive(b) / setLabel(s) / setTip(s)   更新按钮外观
 *   toast(msg, type)                         右下角提示
 *   win(a)                                   minimize|maximize|topmost|hide|close
 *   invoke(cmd, args)                        调后端（受 invoke 白名单约束）
 *   navigate(pluginId)                       切到某个插件
 *   inspector.isOn() / .toggle()             检查器（宿主注入，勿自行 import）
 *   menu(items)                              弹菜单，返回选中项的 value
 *
 * menu 的取消语义
 * ------------------------------------------------------------
 * 用户取消 → **resolve(null)**，不抛异常。
 * 若用 throw 表达取消，每个插件都得写 try/catch 包着；
 * 取消是正常流程，不该占用异常通道。真出错才 reject。
 */

/** 已加载的工具栏定义：id -> def */
const defs = new Map();

/* ------------------------------------------------------------------
 * 可见性 / 顺序 / 额外入口 —— 都存在 localStorage
 * ------------------------------------------------------------------
 *
 * ⚠️ 为什么用 localStorage 而不是模块内变量
 * 设置页与标题栏是**两个不同的模块实例**（设置页是同页插件、
 * 标题栏是宿主组件，各自 import 本文件 → 可能被打进不同 chunk）。
 * 模块级变量在这种结构下会有第二份副本，改了这边那边不知道。
 * localStorage 是同源共享的，天然只有一份。
 *
 * 顺序与可见性的读写都走下面这几个函数，别直接碰 key。
 */

const HIDDEN_KEY = 'nexus:toolbar-hidden';
const ORDER_KEY = 'nexus:toolbar-order';
const EXTRA_KEY = 'nexus:toolbar-extra';
/** 顺序/可见性变化后派发，让标题栏重新渲染 */
export const TOOLBAR_EVENT = 'nexus:toolbar-changed';

function readArr(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [];
  } catch {
    /* 坏了就当没配过，不要让整排按钮加载失败 */
    return [];
  }
}

function writeArr(key, arr) {
  try { localStorage.setItem(key, JSON.stringify(arr)); } catch { /* ignore */ }
}

/** 被隐藏的入口 id */
export function hiddenIds() {
  return readArr(HIDDEN_KEY);
}

/** 用户自定义顺序（排在前面的先显示；没列到的按 def.order 排后面） */
export function orderIds() {
  return readArr(ORDER_KEY);
}

/** 用户在设置里手动加进来的插件 id（"添加按钮入口"） */
export function extraIds() {
  return readArr(EXTRA_KEY);
}

export function isHidden(id) {
  return hiddenIds().includes(id);
}

/** @param {string} id @param {boolean} hidden */
export function setHidden(id, hidden) {
  const cur = new Set(hiddenIds());
  if (hidden) cur.add(id); else cur.delete(id);
  writeArr(HIDDEN_KEY, [...cur]);
  notifyToolbarChanged();
}

export function toggleHidden(id) {
  setHidden(id, !isHidden(id));
}

/** 往右上角添加一个入口（用户手动添加的插件 id） */
export function addExtra(pluginId) {
  const cur = new Set(extraIds());
  cur.add(pluginId);
  writeArr(EXTRA_KEY, [...cur]);
  /* 加进来时若在隐藏列表里，顺手取消隐藏 —— 否则"添加了却看不见" */
  setHidden(entryIdOf(pluginId), false);
}

export function removeExtra(pluginId) {
  const cur = new Set(extraIds());
  cur.delete(pluginId);
  writeArr(EXTRA_KEY, [...cur]);
  notifyToolbarChanged();
}

/** 手动入口的 id 前缀（与 kind:'toolbar' 插件的 id 区分开） */
export const EXTRA_PREFIX = 'tb-entry:';
export function entryIdOf(pluginId) {
  return EXTRA_PREFIX + pluginId;
}

/** 该插件是否要占一个右上角入口（自己声明的，或用户手动加的） */
export function wantsEntry(m, extra) {
  if (!m) return false;
  if (m.kind === 'toolbar') return true;
  const set = extra || new Set(extraIds());
  return !!m.toolbar || set.has(m.id);
}

/**
 * 从插件清单推导出**全部**右上角入口（含被隐藏的）。
 *
 * 设置页和加载器都用它 —— 两边各写一遍判断必然漂移，
 * 表现就是"设置里关掉了、右上角还在"或反之。
 *
 * @param {object[]} manifests 全部插件清单
 * @returns {{id:string,label:string,name:string,source:'toolbar'|'entry',pluginId:string,builtin:boolean}[]}
 */
export function toolbarEntriesOf(manifests) {
  const extra = new Set(extraIds());
  const out = [];
  for (const m of manifests || []) {
    if (!wantsEntry(m, extra)) continue;
    const isTb = m.kind === 'toolbar';
    out.push({
      id: isTb ? m.id : entryIdOf(m.id),
      label: (isTb ? null : m.toolbar?.label) || m.icon || '◌',
      name: m.name || m.id,
      source: isTb ? 'toolbar' : 'entry',
      pluginId: m.id,
      builtin: !!m.builtin,
    });
  }
  const order = sortIds(out.map((e) => e.id));
  return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/**
 * 把某个入口上移/下移一位。
 * @param {string} id
 * @param {-1|1} dir  -1 上移，1 下移
 */
export function moveEntry(id, dir) {
  const all = orderedIds();
  const i = all.indexOf(id);
  if (i < 0) return false;
  const j = i + dir;
  if (j < 0 || j >= all.length) return false;
  [all[i], all[j]] = [all[j], all[i]];
  writeArr(ORDER_KEY, all);
  notifyToolbarChanged();
  return true;
}

/**
 * 把一组 id 按保存的顺序排好（没记录的排最后）。
 *
 * ⚠️ 刻意**不依赖 defs**：设置页 import 到的是本模块的另一份实例，
 * 那份 defs 是空的（它没加载过插件）。若这里读 defs.keys()，
 * 设置页拿到的顺序永远是空 —— 表现为"排了序不生效"。
 * 所以把 id 集合作为参数传进来。
 *
 * @param {string[]} ids
 */
export function sortIds(ids) {
  const saved = orderIds();
  const out = saved.filter((x) => ids.includes(x));
  for (const k of ids) if (!out.includes(k)) out.push(k);
  return out;
}

/** 当前所有入口 id（含隐藏的），按最终显示顺序 */
export function orderedIds(known) {
  /*
   * 没传 known 时，按 def.order 排好再交给 sortIds ——
   * sortIds 只认保存过的顺序，没保存过的保持**传入顺序**。
   * 若这里直接给 defs.keys()（插入顺序），插件自己写的 order 就被忽略了，
   * 表现是"order:10 的排到了 order:50 后面"。
   */
  const ids = known
    || [...defs.values()]
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .map((d) => d.id);
  return sortIds(ids);
}

/** 通知标题栏重渲染 */
export function notifyToolbarChanged() {
  try {
    document.dispatchEvent(new CustomEvent(TOOLBAR_EVENT));
  } catch { /* ignore */ }
}

/** 仅供测试：清空登记表与持久化状态 */
export function resetToolbar() {
  defs.clear();
  try {
    localStorage.removeItem(HIDDEN_KEY);
    localStorage.removeItem(ORDER_KEY);
    localStorage.removeItem(EXTRA_KEY);
  } catch { /* ignore */ }
}

/**
 * 已注册的定义，**按最终显示顺序**、且排除被隐藏的。
 * 测试与渲染共用 —— 渲染不该自己再过滤一遍，否则两处口径会分叉。
 */
export function toolbarDefs() {
  const hidden = new Set(hiddenIds());
  const order = orderedIds();
  return [...defs.values()]
    .filter((d) => !hidden.has(d.id))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** 全部定义（含隐藏的），供设置页列出开关用 */
export function allToolbarDefs() {
  const order = orderedIds();
  return [...defs.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/**
 * 校验一份工具栏定义。
 * @returns {string[]} 问题列表，空数组表示可用
 */
export function validateToolbarDef(def) {
  const errs = [];
  if (!def || typeof def !== 'object') return ['定义不是对象'];
  if (!def.id) errs.push('缺少 id');
  if (!def.label) errs.push('缺少 label（按钮上显示的字符）');
  if (typeof def.onClick !== 'function') errs.push('缺少 onClick');
  return errs;
}

/**
 * 加载工具栏入口。
 *
 * 三种来源，统一在这里收口（调用方直接传**全部**插件清单即可）：
 *
 *   1. kind:'toolbar' 的插件  —— 真正的工具栏插件，有自己的 module.js
 *   2. 插件在清单里声明 `toolbar: { label, tip, order }` —— 应用插件也要
 *      一个右上角入口（这就是"插件入口可以定义在此处"）
 *   3. 用户在设置里手动"添加"的插件 —— 存在 localStorage，按钮点了切过去
 *
 * 2 和 3 都不需要插件写代码：宿主生成一个"点了就切到该插件"的入口。
 *
 * @param {object[]} manifests  全部插件清单（内部自己筛，传全量最省心）
 * @param {object}   opts
 * @param {(m: object) => Promise<any>} opts.loadModule 加载 module 入口（传的是 manifest 本身，入口路径在 m.entry）
 *        注意：实现方要自己取 m.entry 再交给 loadModuleEntry —— 后者要的是
 *        路径字符串，直接透传 manifest 会得到 "[object Object]" 匹配失败。
 * @param {(id: string, err: any) => void} [opts.onError]
 * @returns {Promise<number>} 成功加载的个数
 */
export async function loadToolbarPlugins(manifests, opts) {
  const load = opts?.loadModule;
  if (typeof load !== 'function') return 0;
  const all = manifests || [];
  const extra = new Set(extraIds());
  let ok = 0;

  for (const m of all) {
    if (m?.kind !== 'toolbar') continue;
    /*
     * 配置自相矛盾时**明确报错**，而不是让按钮静默消失。
     * iframe 下这些按钮永远点不动（拿不到 Tauri），
     * 用户只会觉得"这版怎么少了个按钮"。
     */
    if (m.type && m.type !== 'module') {
      opts?.onError?.(m.id, new Error(`工具栏插件只支持 module 模式，当前是 ${m.type}`));
      continue;
    }
    try {
      /*
       * 传的是**整个 manifest**（下面的 JSDoc 契约），加载器自己取 .entry。
       * 之前两个调用点直接把参数转给了 loadModuleEntry（它要的是 entry
       * 路径字符串），于是路径归一化时 String(manifest) 变成 "[object
       * Object]"，永远匹配不上 glob 表 —— 5 个内置工具栏按钮全部
       * "加载失败"，报错还写着"未被构建期 glob 收录：[object Object]"，
       * 看着像构建配置问题。调用点已改为传 m.entry。
       */
      const mod = await load(m);
      const def = mod?.default || mod?.toolbar;
      const errs = validateToolbarDef(def);
      if (errs.length) {
        opts?.onError?.(m.id, new Error(errs.join('；')));
        continue;
      }
      defs.set(def.id, def);
      ok += 1;
    } catch (e) {
      opts?.onError?.(m.id, e);
    }
  }

  /* 2 + 3：插件声明的入口 / 用户手动添加的入口 */
  /*
   * 先清掉上一轮生成的动态入口。
   * 不清的话：用户在设置里"移除"某个入口，只是改了 localStorage，
   * 而这里重建时不会删旧 def —— 按钮**还在**，要重启才消失。
   * 那就是"点了移除没反应"。
   */
  for (const k of [...defs.keys()]) {
    if (k.startsWith(EXTRA_PREFIX)) defs.delete(k);
  }
  for (const m of all) {
    if (!m || m.kind === 'toolbar') continue;
    const declared = !!m.toolbar;
    if (!declared && !extra.has(m.id)) continue;
    const t = m.toolbar || {};
    const id = entryIdOf(m.id);
    defs.set(id, {
      id,
      /* label 是按钮上那一个字符：优先声明的，其次插件图标 */
      label: t.label || m.icon || '◌',
      tip: t.tip || m.name || m.id,
      order: t.order ?? 100,
      /*
       * 点击 = 切到该插件。
       * 这是"入口"而不是"动作"：它做的是导航，跟 kind:'toolbar'
       * 那类执行动作的插件不同，但对外长得一样（都是一个按钮）。
       */
      onClick: (api) => api.navigate?.(m.id),
    });
    ok += 1;
  }
  return ok;
}

/**
 * 渲染工具栏按钮到容器。
 *
 * 两个外壳（原生 index.html / React Titlebar）都调这一个函数，
 * 避免"这边有这个功能、那边没有"的漂移。
 *
 * @param {HTMLElement} el 容器
 * @param {object} opts 宿主能力：toast / win / invoke / navigate
 */
export function mountToolbar(el, opts = {}) {
  if (!el) return [];
  el.textContent = '';
  const cleanups = [];

  for (const def of toolbarDefs()) {
    const btn = document.createElement('button');
    btn.className = 'tb-btn tb-toolbar-btn';
    btn.dataset.toolbarId = def.id;
    btn.textContent = def.label ?? '';
    if (def.tip) btn.title = def.tip;
    if (def.active) btn.classList.add('on');

    const api = {
      /** 按钮元素本身。主题选择器这类要挂在按钮下方，需要锚点 */
      el: btn,
      setActive: (b) => btn.classList.toggle('on', !!b),
      setLabel: (s) => { btn.textContent = String(s ?? ''); },
      setTip: (s) => { btn.title = String(s ?? ''); },
      toast: (msg, type) => opts.toast?.(msg, type),
      win: (a) => opts.win?.(a),
      /*
       * 目前四个内置工具栏插件都不需要 invoke（只用到 win / navigate / emit），
       * 但第三方插件会用。宿主没提供时**明确报错**而不是 undefined 调用 ——
       * 后者是 TypeError，看不出是"宿主没接"还是"插件写错了"。
       */
      invoke: (cmd, args) => {
        if (typeof opts.invoke !== 'function') {
          throw new Error('宿主未提供 invoke 能力');
        }
        return opts.invoke(cmd, args);
      },
      navigate: (id) => opts.navigate?.(id),
      emit: (ev, payload) => opts.emit?.(ev, payload),
      /*
       * 检查器能力：**必须由宿主注入，插件不要自己 import inspector.js**。
       *
       * 原因（这是嵌合架构里很容易踩的一个坑）：
       *   · inspector.js 的状态（on / locked）是**模块级单例**；
       *   · 工具栏插件由 import.meta.glob 动态 import，会生成**独立 chunk**；
       *   · 一旦 inspector.js 被内联/复制进那个 chunk，
       *     插件读到的就是**另一份 on** —— 按钮高亮永远同步不上，
       *     而代码不报错、类型检查也看不出来。
       *
       * 走 api 注入则天然只有宿主这一份状态。
       * 宿主没提供时明确报错，而不是 undefined 调用（那只会是个
       * TypeError，看不出是"宿主没接"还是"插件写错了"）。
       */
      inspector: opts.inspector ?? {
        isOn: () => { throw new Error('宿主未提供 inspector 能力'); },
        toggle: () => { throw new Error('宿主未提供 inspector 能力'); },
      },
      menu: (items) => openMenu(btn, items, opts),
    };

    btn.addEventListener('click', () => {
      /*
       * 插件自己的异常不能冒到宿主的事件循环里：
       * 冒上去就是一条控制台报错，按钮看起来"点了没反应"。
       * 这里统一转成提示 —— 至少要让人知道插件炸了。
       *
       * **同步调用** onClick（不要包 Promise.resolve().then）：
       * 包进微任务会让"点了之后"和"真正执行"之间隔一帧，
       * 快速连点两次时顺序可能与用户预期不符。
       * 同步抛和异步 reject 两头都要接住 —— 只接一边的话，
       * 另一半仍会变成静默失败。
       */
      const fail = (e) => opts.toast?.(`「${def.label}」执行失败：${e?.message || e}`, 'err');
      try {
        const r = def.onClick(api);
        if (r && typeof r.catch === 'function') r.catch(fail);
      } catch (e) {
        fail(e);
      }
    });

    el.appendChild(btn);

    /*
     * 可选的初始化钩子：MCP 状态这类插件要在挂载后更新一次显示
     * （读当前有几个服务启用），没有这个钩子就只能等用户点开才知道。
     * 同样包进 catch —— 初始化炸了不该连累整排按钮。
     *
     * **可以返回一个清理函数**（同步返回，不接 Promise）：
     * 需要监听宿主事件的插件（如检查器要跟着快捷键/ESC 改高亮态）用它注销。
     *
     * 为什么必须有：按钮本身随 `el.textContent=''` 一起被回收，
     * 但挂在 document / window 上的监听器**不会**。
     * React 外壳的 mountToolbar 在依赖变化时会重跑 ——
     * 不注销就是每重跑一次多一个监听器，事件处理跟着跑 N 遍。
     */
    if (typeof def.onInit === 'function') {
      try {
        const c = def.onInit(api);
        if (typeof c === 'function') cleanups.push(c);
      } catch (e) {
        opts.toast?.(`「${def.label}」初始化失败：${e?.message || e}`, 'err');
      }
    }
  }
  return cleanups;
}

/**
 * 在按钮下方弹一个小菜单。
 *
 * @returns {Promise<string|null>} 选中项的 value；取消 / 点外部 → null
 */
function openMenu(anchor, items, opts) {
  return new Promise((resolve) => {
    const list = (items || []).filter(Boolean);
    if (!list.length) { resolve(null); return; }

    const layer = document.createElement('div');
    layer.className = 'tb-menu-layer';
    const box = document.createElement('div');
    box.className = 'tb-menu';

    /*
     * 菜单要 portal 到 body：**不能**挂在锚点里面。
     * 标题栏有 data-tauri-drag-region，且可能是 overflow 受限的容器，
     * 挂进去会被裁掉；更要紧的是外壳 .dialog 的 backdrop-filter
     * 会成为 fixed 后代的包含块（同款坑见 N18）。
     */
    document.body.appendChild(layer);
    layer.appendChild(box);

    const r = anchor.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.top = `${r.bottom + 4}px`;
    box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 160))}px`;

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', finish0, true);
      layer.remove();
      resolve(v);
    };
    const finish0 = () => finish(null);

    for (const it of list) {
      if (it.separator) {
        const hr = document.createElement('div');
        hr.className = 'tb-menu-sep';
        box.appendChild(hr);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'tb-menu-item';
      b.textContent = it.label ?? '';
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => finish(it.value ?? it.label));
      box.appendChild(b);
    }

    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', finish0, true);
    /*
     * 点外部关闭：用 setTimeout(0) 挂监听，否则本次点击
     * （就是打开菜单的那一下）会立刻把菜单关掉。
     */
    setTimeout(() => {
      layer.addEventListener('click', (e) => {
        if (e.target === layer) finish(null);
      });
    }, 0);
    void opts;
  });
}
