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

/** 仅供测试：清空登记表 */
export function resetToolbar() {
  defs.clear();
}

/** 已注册的定义（按 order 升序）。测试与渲染共用 */
export function toolbarDefs() {
  return [...defs.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
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
 * 加载一批工具栏插件。
 *
 * @param {object[]} manifests  kind==='toolbar' 的插件清单
 * @param {object}   opts
 * @param {(m: object) => Promise<any>} opts.loadModule 加载 module 入口
 * @param {(id: string, err: any) => void} [opts.onError]
 * @returns {Promise<number>} 成功加载的个数
 */
export async function loadToolbarPlugins(manifests, opts) {
  const load = opts?.loadModule;
  if (typeof load !== 'function') return 0;
  let ok = 0;
  for (const m of manifests || []) {
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
