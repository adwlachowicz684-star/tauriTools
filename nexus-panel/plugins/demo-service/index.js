/**
 * 示例服务插件
 * ------------------------------------------------------------
 * 演示 kind:'service' 插件的写法：
 *   1. 用 bootServicePlugin（不是 bootIframePlugin）声明方法
 *   2. 不渲染业务 UI —— 它是"被调用"的，不是"被浏览"的
 *   3. 方法可以是 async，返回值会被传回调用方
 *
 * 调用方（任意插件）：
 *   const hex = await ctx.services.call('demo-service', 'pick', { from: '#3a7afe' });
 */

import { bootServicePlugin } from '../../js/plugin-sdk.js';

bootServicePlugin({
  /** 返回服务自述，供插件商店与调用方自检 */
  async describe() {
    return {
      name: '示例·取色服务',
      version: '1.0.0',
      methods: ['describe', 'pick', 'shade'],
      note: '这是一个 demo：pick 不真的开取色窗，只做颜色归一化演示',
    };
  },

  /**
   * 归一化一个颜色输入为 #RRGGBB。
   * 真实场景里这里会弹出色盘 UI 并等待用户选择 —— 那也正是服务插件的
   * 价值所在：取色 UI 只有一份，所有插件共用。
   */
  async pick({ from = '#3a7afe' } = {}) {
    // 服务里同样能拿到 ctx（第二个参数），可用 store / invoke / shell
    const raw = String(from).trim();
    // 支持 #abc 缩写
    if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
      const [r, g, b] = raw.slice(1).split('');
      return '#' + [r, g, b].map((c) => c + c).join('').toUpperCase();
    }
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
    throw new Error(`无法识别的颜色：${raw}（期望 #RGB 或 #RRGGBB）`);
  },

  /** 明度调整：amount > 0 变亮，< 0 变暗 */
  async shade({ color = '#3a7afe', amount = 0 } = {}) {
    const hex = String(color).replace('#', '');
    if (hex.length !== 6) throw new Error('需要 #RRGGBB 格式');
    const n = parseInt(hex, 16);
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    const [r, g, b] = [
      clamp(((n >> 16) & 255) + amount * 255),
      clamp(((n >> 8) & 255) + amount * 255),
      clamp((n & 255) + amount * 255),
    ];
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  },
});
