/**
 * md 插件 —— 渲染管线的**运行时来源**解析
 * ============================================================
 *
 * 【它解决什么】
 * render-config.js 里的三个插件（remark-gfm / rehype-slug /
 * rehype-highlight）是**静态 import**，构建期就被 Vite 打进产物。
 * 于是运行时装进工具依赖目录里的同名包，从来没有任何代码去读它：
 * 界面显示"已安装并验证可加载"，而渲染行为一点没变 ——
 * 不报错、不红，是"装成功但没效果"那一类里最难自查的一种。
 *
 * 本模块把这条链路补上：装过就用装进来的，没装（或装的那份坏了）
 * 就用打包进产物那一份。
 *
 * 【为什么必须在这里收口，而不是各入口各解析一次】
 * 渲染管线被四个入口共用（粘贴 / 拖入 / service / 宿主传路径）。
 * 一旦允许"某个入口用运行时版、另一个用打包版"，同一段 md 在两处
 * 渲染出的结果就会不同 —— 那正是 F11 花一整轮修掉的失效形态
 * （md-editor 的预览用自己抄的极简版，与主视图长得不一样）。
 * 所以：解析**只做一次**，结果进程内共享，四个入口拿到的一定是同一份。
 *
 * 【为什么换的是"槽位"而不是追加】
 * rehype 管线的顺序是有含义的（slug 必须排在 sanitize 之后，
 * 见 render-config.js）。把运行时版 push 到数组末尾，等于把 slug
 * 挪到了 highlight 后面 —— 管线仍然跑得通，不报错，
 * 只有将来补装 sanitize 时才会爆出锚点全丢。占住原槽位才不会挪动顺序。
 */

import { REMARK_PLUGINS, REHYPE_PLUGINS } from './render-config.js';

/**
 * 可换版本的三个包，以及它们各自占的槽位。
 *
 * index 是**打包版数组里的下标**，不是随意编号：
 * 运行时版必须落回同一个位置，理由见文件头。
 */
export const SWAP_SLOTS = {
  'remark-gfm': { layer: 'remark', index: 0 },
  'rehype-slug': { layer: 'rehype', index: 0 },
  'rehype-highlight': { layer: 'rehype', index: 1 },
};

/**
 * 三个取用点。
 *
 * 为什么不像 mermaid 那样写成一个 `pick(ctx, name, ...)` 通用函数：
 * 依赖清单的扫描器（scan-deps.mjs 的 runtimeDepsOf）只认
 * `requireDep('字面量'` 这种写法 —— 换成变量第一参，这三个包就会被
 * 记成"没有运行时消费方"，界面又退回"装了没人用"的提示，
 * 而代码其实是有的。宁可这三行长得像重复，也不能让扫描器瞎掉。
 */
const PICKERS = {
  'remark-gfm': (ctx, fallback) => ctx.requireDep('remark-gfm', { fallback }),
  'rehype-slug': (ctx, fallback) => ctx.requireDep('rehype-slug', { fallback }),
  'rehype-highlight': (ctx, fallback) =>
    ctx.requireDep('rehype-highlight', { fallback }),
};

/**
 * 打包版插件函数 —— 按槽位从 render-config 的数组里取，
 * 不在本文件里再 import 一遍。
 *
 * 再 import 一遍就有两份"谁在第几位"的知识：render-config 调整顺序，
 * 这里不跟着动，回退时会把 highlight 塞进 slug 的槽位 ——
 * 且只在"装的那份坏了"这条罕见分支上才暴露。
 */
function bundledFnOf(name) {
  const slot = SWAP_SLOTS[name];
  if (!slot) return null;
  const arr = slot.layer === 'remark' ? REMARK_PLUGINS : REHYPE_PLUGINS;
  const cur = arr[slot.index];
  if (cur === undefined || cur === null) return null;
  return Array.isArray(cur) ? cur[0] : cur;
}

/** 打包版（没装 / 没 ctx / 装的那份坏了时用它）。 */
export const BUNDLED_PLUGINS = {
  remark: REMARK_PLUGINS,
  rehype: REHYPE_PLUGINS,
  sources: { 'remark-gfm': 'bundle', 'rehype-slug': 'bundle', 'rehype-highlight': 'bundle' },
};

/**
 * 从 CDN 单文件里取插件函数。
 *
 * 两种形态都要认：CDN 的 `+esm` 多数给 `export default fn`，
 * 但也可能是 `export function x` 的命名空间对象（没有 default）。
 * 只认 default 的话，后者被当成"取不到"而静默回退打包版 ——
 * 表现是"装成功了却没生效"，且不报错。
 */
export function pluginFnOf(mod) {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.default === 'function') return mod.default;
  return null;
}

/**
 * 把运行时版放回它原本的槽位。
 *
 * 元组形态（`[fn, { singleTilde: false }]`）**只换 fn、保留选项**：
 * 整条替换成裸 fn 会把 singleTilde 丢了，"约 ~200ms"这类成对单波浪
 * 又变成删除线 —— 这是配置层面的回退，界面上看不出是插件换了。
 */
function withSwap(base, layer, picks) {
  const out = base.slice();
  for (const p of picks) {
    const slot = SWAP_SLOTS[p.name];
    if (!slot || slot.layer !== layer) continue;
    /*
     * 下标越界 = render-config 那边改过数组而这里没跟着改。
     * 跳过而不是写死：写进去会在数组中间留空洞，react-markdown
     * 拿到 undefined 插件的行为不是报错而是整条管线静默跳过。
     */
    if (slot.index < 0 || slot.index >= out.length) continue;
    const cur = out[slot.index];
    out[slot.index] = Array.isArray(cur) ? [p.fn, cur[1]] : p.fn;
  }
  return out;
}

/*
 * 进程内只解析一次（见文件头：四个入口必须拿到同一份）。
 *
 * 缓存的是 **Promise 本身**而不是结果：并发的四个入口同时进来，
 * 拿到的是同一个 Promise，不会各自解析出两套结论。
 */
let resolved = null;

/** 仅供测试：清掉缓存，让下一次调用重新解析。 */
export function resetPluginCache() {
  resolved = null;
}

/**
 * 解析渲染管线。
 *
 * @returns {Promise<{remark: any[], rehype: any[], sources: object}>}
 *   sources 记录每个包最终用的是 'runtime' 还是 'bundle'，
 *   供界面/测试判断"到底有没有用上装的那份"。
 *
 * 不抛异常：ctx 缺失、ctx.requireDep 不存在、装的那份 import 失败，
 * 一律回退打包版 —— 运行时依赖是增强不是基础功能，
 * 它一坏就整篇渲染不出来，等于把可选增强变成单点故障。
 */
export async function resolvePlugins(ctx) {
  if (resolved) return resolved;

  const canPick = ctx && typeof ctx.requireDep === 'function';
  if (!canPick) {
    resolved = Promise.resolve(BUNDLED_PLUGINS);
    return resolved;
  }

  resolved = (async () => {
    const names = Object.keys(SWAP_SLOTS);
    const picks = [];
    const sources = {};

    for (const name of names) {
      sources[name] = 'bundle';
      try {
        /*
         * fallback 交回**打包版本身**（包成模块形态），而不是 null：
         * requireDep 的契约是"fallback 返回可用的模块"，
         * 传 null 的话万一上游改成校验 mod 非空，就会从"回退打包版"
         * 变成"这个包整体取不到" —— 差别只在坏文件那条分支上才出现。
         */
        const fallback = async () => ({ default: bundledFnOf(name) });
        const r = await PICKERS[name](ctx, fallback);
        const fn = r && r.mod ? pluginFnOf(r.mod) : null;
        if (fn) {
          picks.push({ name, fn });
          sources[name] = r.source === 'runtime' ? 'runtime' : 'bundle';
        }
      } catch {
        /* 取用失败 = 没装，用打包版。不记 error：这里没有展示位。 */
      }
    }

    return {
      remark: withSwap(REMARK_PLUGINS, 'remark', picks),
      rehype: withSwap(REHYPE_PLUGINS, 'rehype', picks),
      sources,
    };
  })();

  return resolved;
}
