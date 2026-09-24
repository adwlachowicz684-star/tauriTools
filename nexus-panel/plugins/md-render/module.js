/**
 * md-render 服务 —— 给**其它插件**调用的 Markdown 渲染
 * ============================================================
 * 它是 md 插件四种入口里的 E3（服务入口）。
 *
 * 为什么是独立目录 `md-render/` 而不是复用 `md/`
 * ------------------------------------------------------------
 * js/plugin-entries.js 的 Vite glob 只匹配
 *
 *   plugins/<id>/module.{js,mjs,ts,tsx}
 *
 * 即**一个插件目录只能有一个同页入口**，且文件名必须叫 `module.*`。
 * `plugins/md/module.tsx` 已经被 app 入口（侧边栏那个）占用了，
 * 服务入口只能另开一个目录 —— 硬塞进 `md/` 会被 glob 漏掉，
 * 表现为运行时 404（服务调不到，却查不到哪错了）。
 *
 * 为什么是纯计算服务（不带 interactive: true）
 * ------------------------------------------------------------
 * 渲染 Markdown 不需要用户看见什么。标 interactive 会让宿主
 * 把服务容器弹出成居中浮层（那是给色盘、图标选择这类
 * "必须看得见才用得了"的服务准备的），这里只会闪一下空白浮层。
 *
 * 为什么返回 HTML 字符串而不是 React 元素
 * ------------------------------------------------------------
 * 调用方可能是 iframe 沙箱插件：ctx.services.call 走 postMessage 桥接，
 * 返回值必须能结构化克隆。React 元素带函数与循环引用，**过不了桥**。
 * HTML 字符串两种调用方都能用，是唯一稳妥的返回形态。
 *
 * 调用方要注意样式（这是本服务的已知边界）
 * ------------------------------------------------------------
 * 返回的 HTML 只带 `class="markdown-body"`，样式不内联。
 *   · 同页（module）调用方：与宿主同文档，宿主那份 neumorphism.css
 *     里的 .markdown-body 规则天然生效，什么都不用做。
 *   · iframe 调用方：隔离文档，宿主样式进不来，需要自己引一份 ——
 *     否则渲染出来"只有文字"（正是 demo-iframe 踩过的那个坑）。
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import {
  REMARK_PLUGINS,
  REHYPE_PLUGINS,
  urlTransform,
} from '../md/render-config.js';

/**
 * 服务版本。调用方可以用来判断能力，宿主面板也会显示。
 */
export const VERSION = '0.1.0';

/**
 * 渲染一段 Markdown 为 HTML 字符串。
 *
 * @param {{ text?: string, className?: string }} args
 * @returns {string} HTML
 *
 * 刻意不 catch：渲染失败应该让调用方知道（throw 会被 callService 传回去），
 * 静默返回空串会让调用方以为"渲染成功但内容是空的"，排查方向全错。
 */
function renderToHtml(args) {
  const text = String(args?.text ?? '');
  const className = args?.className || 'markdown-body';
  return renderToStaticMarkup(
    React.createElement(
      'div',
      { className },
      React.createElement(
        ReactMarkdown,
        {
          remarkPlugins: REMARK_PLUGINS,
          rehypePlugins: REHYPE_PLUGINS,
          urlTransform,
          children: text,
        },
      ),
    ),
  );
}

/**
 * 把渲染配置原样交出去，供**同页**调用方自己渲染。
 *
 * 只适合同页：插件对象/函数不能结构化克隆，过不了 iframe 桥接。
 * 同页调用方拿到它可以用自己的 ReactMarkdown 渲染成元素（而不是字符串），
 * 好处是能接自己的事件、也不用 innerHTML。
 */
function renderConfig() {
  return { remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS, urlTransform };
}

function info() {
  return { version: VERSION, methods: ['renderToHtml', 'renderConfig', 'info'] };
}

export default {
  name: 'Markdown 渲染',
  version: VERSION,
  /*
   * mount 是宿主要求的（mountModule 会调 def.mount(ctx)），
   * 但本服务没有主视图 —— 服务插件不该被用户直接打开，
   * 宿主也在 mount() 里拦了这件事。
   *
   * 这里仍然返回一个 cleanup 函数：mountModule 会把非函数返回值
   * 当成"没有清理逻辑"，返回函数才是显式契约。
   */
  mount() {
    return () => {};
  },
  methods: {
    renderToHtml,
    renderConfig,
    info,
  },
};
