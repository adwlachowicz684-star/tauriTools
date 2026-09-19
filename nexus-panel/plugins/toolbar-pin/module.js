/**
 * 工具栏插件：窗口置顶
 *
 * 原 ⇱ 按钮。
 *
 * ⚠️ 已知局限（**沿用既有行为，不是本次引入**）
 * ------------------------------------------------------------
 * 高亮态是插件自己记的，不是从窗口读的。原因是后端
 * `window_action` 的 topmost 分支目前返回 `Result<(), String>` ——
 * 只有成功/失败，**不返回切换后的实际状态**：
 *
 *   "topmost" => { let next = !window.is_always_on_top()?;
 *                  window.set_always_on_top(next) }
 *
 * 原 shell.js 里也是 `classList.toggle('on')` 自记，行为一致。
 *
 * 要真正准确，得让 topmost 返回新状态（或新增一个读状态的命令）。
 * 那属于**跨端契约变更**，在没有 cargo build 验证的情况下先不动 ——
 * 见任务清单里的待办。
 *
 * 自记状态的可见后果：用别的方式改了置顶（如系统菜单），
 * 按钮高亮会与之相反，再点一次才对齐。
 */
export default {
  id: 'toolbar-pin',
  label: '⇱',
  tip: '窗口置顶',
  order: 20,
  active: false,
  async onClick(api) {
    const on = !api.el.classList.contains('on');
    await api.win('topmost');
    api.setActive(on);
    api.toast(on ? '窗口已置顶' : '已取消置顶', 'info');
  },
};
