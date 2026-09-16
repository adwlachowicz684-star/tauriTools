/**
 * 通用弹窗（框架无关）
 * ============================================================
 * 全工具共用一套弹窗：外壳（原生 / React）、插件（React / 原生 JS）都调这里。
 *
 * 为什么要有这么一层
 * --------------------------------------------------------------------
 * 之前散着四种弹窗，各写各的：
 *   · js/shell.js          —— 只有一个 toast，确认框直接用 window.confirm
 *   · plugins/project-group/components/ui.tsx —— 自写 Modal + ConfirmDialog
 *   · plugins/mindmap/panels.js               —— 自写 dialog() + confirmDialog()
 *   · 其余                 —— 直接 window.confirm / alert / prompt（23 处）
 *
 * 后果有三：
 *   1. 系统弹窗的**长相由浏览器决定**，深色面板上是个突兀的白框，
 *      也不跟随主题切换；
 *   2. 在沙箱 iframe 里，原生对话框的表现更割裂（有的平台直接被拦）；
 *   3. window.confirm 在 jsdom 里没有实现，**无法测试**。
 *
 * 用法
 * --------------------------------------------------------------------
 *   import { confirm, alert, prompt, open } from '../../js/dialog.js';
 *   if (await confirm({ message: '确定删除？', danger: true })) { ... }
 *
 * 全部返回 Promise：调用点大多是 async 流程，用回调会把后续逻辑缩进一层。
 *
 * 依赖
 * --------------------------------------------------------------------
 * 样式在 css/dialog.css —— 必须一并引入（本模块只管行为，不注入样式）。
 * 插件是独立文档，外壳的 CSS 传不进去，所以每个用到弹窗的插件都要
 * @import 那份文件；test:dialog 会校验这条。
 */

/* 已打开的弹窗栈：Esc 只关最上层、嵌套时抬高层级、关闭后恢复焦点 */
const stack = [];

/* ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;   // 一律走 textContent，天然免疫 XSS
  return n;
}

function btn(label, variant, onClick) {
  const b = el('button', 'nx-btn' + (variant ? ' ' + variant : ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** 取 --z-mask 作为层级基数；取不到时退回 900（与 tokens.css 一致） */
function baseZ() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--z-mask');
    const n = parseInt(String(v).trim(), 10);
    if (Number.isFinite(n)) return n;
  } catch { /* 无样式环境 */ }
  return 900;
}

/** 可聚焦元素（Tab 循环用） */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((n) => {
    if (n.disabled) return false;
    // 被隐藏的（折叠区里的）不算
    return n.offsetWidth > 0 || n.offsetHeight > 0 || n === document.activeElement;
  });
}

function trapFocus(root, e) {
  const items = focusables(root);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}

/* 全局键盘：只在栈非空时生效。挂在 document 上而不是每个 mask 上，
   这样无论焦点在哪都能收到；栈空后立刻移除，不留常驻监听。 */
function onKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    // 已经在处理别的事（比如有更内层的原生菜单）时不抢
    e.preventDefault();
    e.stopPropagation();
    top.cancel();
  } else if (e.key === 'Tab') {
    trapFocus(top.dialog, e);
  }
}

/* ------------------------------------------------------------------
   核心装配
   ------------------------------------------------------------------ */

/**
 * 装配一个弹窗。
 *
 * @param {object} o
 * @param {string} [o.title]
 * @param {Node[]} [o.body]      内容节点（已构造好，调用方负责）
 * @param {Array<{label:string,variant?:string,value:any,primary?:boolean}>} [o.actions]
 * @param {string} [o.width]     宽度，默认 420px
 * @param {boolean} [o.dismissOnMask] 点遮罩是否关闭，默认 true
 * @returns {{close:(v:any)=>void, mask:HTMLElement, dialog:HTMLElement}}
 */
function mount(o = {}) {
  const prevFocus = document.activeElement;
  const z = baseZ() + stack.length * 10;

  const mask = el('div', 'nx-mask');
  mask.style.zIndex = String(z);

  const dialog = el('div', 'nx-dlg');
  dialog.setAttribute('role', o.role || 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  if (o.width) dialog.style.width = typeof o.width === 'number' ? o.width + 'px' : o.width;

  if (o.title) {
    const head = el('div', 'nx-dlg-head');
    head.appendChild(el('h2', 'nx-dlg-title', o.title));
    dialog.appendChild(head);
  }

  const body = el('div', 'nx-dlg-body');
  for (const n of o.body || []) body.appendChild(n);
  dialog.appendChild(body);

  let settled = false;
  const entry = {
    mask, dialog,
    cancel: () => { if (o.dismissOnMask !== false) close(undefined); },
  };

  function close(value) {
    if (settled) return;
    settled = true;
    stack.splice(stack.indexOf(entry), 1);
    if (!stack.length) document.removeEventListener('keydown', onKeydown, true);
    /* 淡出后再摘，否则关闭很生硬。
       但**必须立刻**停掉 pointer-events：遮罩是 fixed + inset:0，
       淡出这 160ms 里它虽然透明，却仍然铺在整屏上 —— 不摘掉就会
       吃掉用户对背后界面的第一次点击（表现像是"点一下没反应"）。 */
    mask.classList.remove('on');
    mask.classList.add('closing');
    setTimeout(() => mask.remove(), 160);
    if (prevFocus && document.contains(prevFocus)) {
      try { prevFocus.focus(); } catch { /* 元素已销毁 */ }
    }
    o.onClose?.(value);
  }

  const foot = el('div', 'nx-dlg-foot');
  (o.actions || [{ label: '关闭', value: undefined }]).forEach((a) => {
    foot.appendChild(btn(a.label, (a.primary ? 'primary ' : '') + (a.variant || ''), () => {
      // onClick 返回 false 表示"先别关"（校验没过、异步未完等）
      if (a.onClick && a.onClick() === false) return;
      // value 允许是函数：输入框这类值在点击那一刻才确定
      close(typeof a.value === 'function' ? a.value() : a.value);
    }));
  });
  dialog.appendChild(foot);

  mask.appendChild(dialog);
  if (o.dismissOnMask !== false) {
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(undefined); });
  }
  document.body.appendChild(mask);
  // 强制回流后再加 .on，否则初始态与终态在同一帧，transition 不触发
  void mask.offsetWidth;
  mask.classList.add('on');

  stack.push(entry);
  if (stack.length === 1) document.addEventListener('keydown', onKeydown, true);

  const first = (o.focus && dialog.querySelector(o.focus))
    || dialog.querySelector('.nx-btn.primary')
    || dialog.querySelector('.nx-btn');
  if (first) first.focus();
  else { dialog.setAttribute('tabindex', '-1'); dialog.focus(); }

  return { close, mask, dialog };
}

/* ------------------------------------------------------------------
   对外 API
   ------------------------------------------------------------------ */

/**
 * 确认框。
 *
 * @param {object} o
 * @param {string} [o.title='确认']
 * @param {string} o.message    支持换行（pre-wrap）
 * @param {string} [o.okText='确定']
 * @param {string} [o.cancelText='取消']
 * @param {boolean} [o.danger]  危险操作，确认按钮用状态色
 * @returns {Promise<boolean>}
 */
export function confirm(o) {
  const msg = String(o?.message ?? '');
  return new Promise((resolve) => {
    mount({
      title: o?.title || '确认',
      body: [el('div', 'nx-dlg-msg', msg)],
      actions: [
        { label: o?.cancelText || '取消', value: false },
        { label: o?.okText || '确定', value: true, primary: true, variant: o?.danger ? 'danger' : '' },
      ],
      onClose: (v) => resolve(v === true),
      width: o?.width || 400,
    });
  });
}

/**
 * 提示框（只有一个按钮，用来替代 window.alert）。
 *
 * @param {object} o
 * @param {string} [o.title='提示']
 * @param {string} o.message
 * @param {string} [o.okText='知道了']
 * @param {'info'|'ok'|'err'|'warn'} [o.type]
 * @returns {Promise<void>}
 */
export function alert(o) {
  const msg = String(o?.message ?? o ?? '');
  const type = o?.type;
  return new Promise((resolve) => {
    mount({
      title: o?.title || '提示',
      body: [el('div', 'nx-dlg-msg' + (type ? ' nx-' + type : ''), msg)],
      actions: [{ label: o?.okText || '知道了', value: true, primary: true }],
      onClose: () => resolve(),
      width: o?.width || 400,
    });
  });
}

/**
 * 输入框（替代 window.prompt）。
 *
 * @param {object} o
 * @param {string} [o.title='输入']
 * @param {string} [o.message]
 * @param {string} [o.label]
 * @param {string} [o.defaultValue='']
 * @param {string} [o.placeholder]
 * @param {(v:string)=>string|null} [o.validate] 返回错误文案阻止提交，null 表示通过
 * @returns {Promise<string|null>} 取消为 null
 */
export function prompt(o) {
  return new Promise((resolve) => {
    const wrap = el('div', 'nx-dlg-field');
    if (o?.message) wrap.appendChild(el('div', 'nx-dlg-msg', String(o.message)));
    if (o?.label) wrap.appendChild(el('label', 'nx-dlg-label', String(o.label)));

    const input = el('input', 'nx-input');
    input.type = 'text';
    input.value = String(o?.defaultValue ?? '');
    if (o?.placeholder) input.placeholder = String(o.placeholder);
    wrap.appendChild(input);

    const err = el('div', 'nx-dlg-err');
    wrap.appendChild(err);

    /** @returns {boolean} 是否通过校验 */
    const submit = () => {
      const problem = o?.validate?.(input.value);
      if (problem) { err.textContent = problem; input.focus(); return false; }
      err.textContent = '';
      return true;
    };

    const h = mount({
      title: o?.title || '输入',
      body: [wrap],
      actions: [
        { label: o?.cancelText || '取消', value: null },
        { label: o?.okText || '确定', primary: true, value: () => input.value, onClick: submit },
      ],
      onClose: (val) => resolve(val === undefined || val === null ? null : String(val)),
      width: o?.width || 420,
      focus: '.nx-input',
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (submit()) h.close(input.value);
      } else if (e.key === 'Escape') {
        // 输入框里的 Esc 交给输入框自己处理（清空/还原），不冒泡到"关弹窗"
        e.stopPropagation();
      }
    });

    // 打开即全选：改名场景下用户多半是要整个替换
    setTimeout(() => { try { input.select(); } catch { /* 未聚焦 */ } }, 0);
  });
}

/**
 * 自定义内容弹窗（底层句柄版）。
 *
 * 与 open() 的区别：返回**同步句柄** { close, mask, dialog, settled }，
 * 适合内容里的按钮自己要关掉弹窗的场景（否则得把 close 传进子节点，
 * 拼 DOM 时会很别扭）。open() 就是它的 Promise 糖衣。
 *
 * @returns {{close:(v?:any)=>void, mask:HTMLElement, dialog:HTMLElement, settled:Promise<any>}}
 */
export function show(o) {
  let closeFn;
  const settled = new Promise((resolve) => {
    const h = mount({ ...o, onClose: (v) => resolve(v) });
    closeFn = h.close;
  });
  // mount 是同步的，这里一定能拿到
  return { close: closeFn, mask: stack[stack.length - 1].mask, dialog: stack[stack.length - 1].dialog, settled };
}

/** 自定义内容弹窗。@returns {Promise<any>} 命中的 action.value */
export function open(o) { return show(o).settled; }

/** 当前是否有弹窗打开（供快捷键等判断） */
export function isOpen() { return stack.length > 0; }

/** 关掉最上层弹窗（等价于按 Esc） */
export function closeTop() {
  const top = stack[stack.length - 1];
  if (top) top.cancel();
}
