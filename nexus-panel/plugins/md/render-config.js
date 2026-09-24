/**
 * md 插件 —— 渲染核心配置
 * ============================================================
 * 这里集中放 react-markdown 的插件数组与 urlTransform。
 *
 * 为什么单独抽一个模块
 * ------------------------------------------------------------
 * 四种入口（粘贴 / 拖入 / service / 宿主传路径）共用同一份渲染配置。
 * 配置分散到各入口就会各自漂移：某个入口忘了 singleTilde，
 * 表现是"那一个入口里单个 ~ 变成删除线"，很难联想到是配置没同步。
 *
 * 本文件里的每一条都有"错了不报错"的性质，所以每条都写了后果，
 * 并且由 md-render-test.mjs 钉住 —— 不能靠人记。
 */

import { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';

/**
 * remark 层插件
 *
 * `singleTilde: false` 是刻意的：
 *   GFM 默认把 `~text~` 也算删除线，关掉之后只有 `~~text~~` 才是。
 *   实测三态（remark-gfm 4.0.1）：默认 `~x~` → <del>；false → 原样；true → <del>。
 *   不关的话，"约 ~200ms"这类成对单波浪会被误判成删除线。
 *
 * 为什么加 JSDoc 类型注解：
 *   不加的话 TS 把 `[remarkGfm, { singleTilde: false }]` 推断成
 *   `(函数 | 对象)[]` 的联合数组，而不是**元组**，
 *   传给 remarkPlugins 时报 TS2322「is not assignable to PluggableList」。
 *   这是类型层面的问题，运行时完全正常 —— 所以很容易被当作噪音忽略，
 *   但它会让每次类型检查都多一条红，把真问题稀释掉。
 *
 * @type {import('react-markdown').Options['remarkPlugins']}
 */
export const REMARK_PLUGINS = [[remarkGfm, { singleTilde: false }]];

/**
 * rehype 层插件 —— 顺序有讲究
 *
 * 当前只有 slug 和 highlight 两个，但**顺序仍按完整管线的位置排**：
 *
 *   rehypeRaw → rehypeSanitize → rehypeSlug → rehypeKatex
 *
 * `rehype-slug` 必须排在 `rehype-sanitize` 之后：
 *   slug 给标题生成的 id，若排在 sanitize 之前，会被当成"未放行属性"清洗掉，
 *   TOC 全部失效 —— 且不报错，只是点了不跳转。
 *
 * 现在我们不装 raw / sanitize（react-markdown 默认转义原始 HTML，
 * 不需要白名单），但 slug 仍留在"sanitize 之后"这个位置，
 * 将来谁补装 sanitize 也不会因为顺序踩坑。
 */
/**
 * 同 REMARK_PLUGINS 的原因加类型注解：避免 TS2322（联合数组 vs 元组）。
 *
 * @type {import('react-markdown').Options['rehypePlugins']}
 */
export const REHYPE_PLUGINS = [rehypeSlug, rehypeHighlight];

/**
 * urlTransform —— 与 sanitize 无关的**第二道独立关卡**
 *
 * react-markdown 自带的 defaultUrlTransform 不放行 `data:`：
 *   内嵌 base64 图片（`![x](data:image/png;base64,...)`）的 src 会被剥成空串。
 *
 * 坑中之坑：这个转换发生在 **rehype 插件之后、渲染之前**，
 * 所以就算（将来装了 sanitize 并）在 sanitize 里放行 `src: data`，
 * urlTransform 这一关照样把你剥掉。放行 data 图片必须**两处都改**：
 *   · 这里放行 data:image/
 *   · sanitize schema 的 protocols.src 加 data
 * 只改一处 = 图变空白 + 无报错。
 *
 * 其余沿用 defaultUrlTransform 的白名单
 * （http / https / mailto / irc / xmpp 与相对 URL）；
 * `javascript:` 仍被拦截 —— 这一条正是自研渲染器那个洞的答案：
 * 自研版把 `[x](javascript:alert(1))` 原样输出成了 href。
 */
export function urlTransform(url) {
  if (typeof url === 'string' && url.startsWith('data:image/')) return url;
  return defaultUrlTransform(url);
}
