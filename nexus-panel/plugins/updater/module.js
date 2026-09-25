/**
 * updater 服务 —— 应用自更新
 * ============================================================
 *
 * 它是**内置服务插件**：不进侧边栏，由设置页的「更新」标签页通过
 * ctx.services.call('updater', 'check', {...}) 调用。
 *
 * 为什么做成服务插件，而不是让设置页直接 ctx.invoke
 * ------------------------------------------------------------
 * 三条后端命令全是 M 类（见 js/command-caps.js）：能下载并执行外部安装包、
 * 能重启本进程。把命令直接给设置页，等于"谁能画界面谁就能装更新"。
 * 走服务调用把能力收在 updater 自己名下：
 *   · 白名单里看得见它拿了什么（js/invoke-policy.js 只有 updater 一条）
 *   · 插件卡片矩阵里有它，能审计
 *   · 将来别的地方（比如托盘菜单）也能复用同一份实现
 *
 * 通道从哪来
 * ------------------------------------------------------------
 * 「正式版 / 内部测试」是**用户在设置页里选**的，存在 localStorage，
 * 每次调用时作为参数传进来。本服务不缓存通道 —— 缓存了就会出现
 * "改了选项但检查的还是旧通道"，而这类失效不报错。
 *
 * 端点为什么不在前端配
 * ------------------------------------------------------------
 * 官方文档明确：出于安全原因，updater 的 endpoints 只能在 **Rust 侧**覆盖。
 * 前端传任何 URL 都不会生效。所以这里只传通道名，URL 全在 src/updater.rs。
 */

/** 通道：正式版 / 内部测试 */
export const CHANNELS = [
  { id: 'stable', label: '正式版' },
  { id: 'beta', label: '内部测试' },
];

/** 本地记住的通道键。与设置页共用 —— 两边各写一份就会漂移。 */
export const CHANNEL_KEY = 'nexus.updater.channel';

export const VERSION = '1.0.0';

/** 宿主注入的 ctx，由 mount 拿到。清理时置空，避免悬挂引用。 */
let CTX = null;

function normalizeChannel(v) {
  return String(v || '').trim() === 'beta' ? 'beta' : 'stable';
}

/**
 * 检查更新。
 *
 * @param {{ channel?: string }} args
 * @returns {Promise<{state:string, channel:string, current:string, latest:string, notes:string, date:string, message:string}>}
 *
 * ⚠️ state 有四种：'unconfigured' | 'uptodate' | 'available' | 'error'
 * 刻意不做成 hasUpdate 布尔值 —— "没配公钥"和"已是最新"在布尔下都是 false，
 * 界面上只能显示一句"没有更新"，排查方向完全错。
 */
async function check(args) {
  const channel = normalizeChannel(args?.channel);
  const r = await CTX.invoke('updater_check', { channel });
  return r;
}

/**
 * 下载并安装。
 * 装完**不自动重启** —— 返回提示文案，由界面问用户何时重启。
 */
async function install(args) {
  const channel = normalizeChannel(args?.channel);
  return await CTX.invoke('updater_install', { channel });
}

/** 重启本进程，让已安装的更新生效。 */
async function relaunch() {
  return await CTX.invoke('updater_relaunch', {});
}

function info() {
  return { version: VERSION, methods: ['check', 'install', 'relaunch', 'info'] };
}

export default {
  name: '应用更新',
  version: VERSION,
  /*
   * mount 是宿主要求的（mountModule 会调 def.mount(ctx)）。
   * 服务插件没有主视图，但仍然返回 cleanup —— mountModule 把非函数
   * 返回值当作"没有清理逻辑"，返回函数才是显式契约。
   */
  mount(ctx) {
    CTX = ctx;
    return () => {
      CTX = null;
    };
  },
  methods: {
    check,
    install,
    relaunch,
    info,
  },
};
