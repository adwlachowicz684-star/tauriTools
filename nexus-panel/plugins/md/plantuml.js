/**
 * PlantUML 图表 —— 纯逻辑部分（不含渲染，可在 node 里真跑）
 * ============================================================
 * 与 mermaid.js 同一套做法：把「判定 / 排队 / 回调转 Promise / 加载」
 * 抽出来，只把「调引擎」留在组件里。这些逻辑错了都不报错，
 * 只表现为"图偶发画不出 / 一直转圈"，不实测根本发现不了。
 *
 * 引擎：@plantuml/core（PlantUML 官方 TeaVM 编译版）
 *   · 完全离线：不联网、不需要 Java、不需要服务器
 *   · Graphviz 布局由 viz-global.js（Viz.js 编译到 **WebAssembly**）提供
 *
 * ⚠️ 许可证地雷（必须钉住）
 *   ≥ 1.2026.6 才是 **MIT**；≤ 1.2026.5 是 **GPL-3.0-or-later**。
 *   降版本会把整个项目拖进 copyleft —— 这是当初否决 ErgeMD（AGPL）
 *   的同一个理由。所以 package.json 用精确版本，不要改成 ^ 以下。
 *
 * ⚠️ CSP 地雷
 *   viz-global 是 WASM。CSP 的 script-src 需要允许 WASM 编译：
 *   本项目原本已有 'unsafe-eval'（规范上它已覆盖 WASM），
 *   但 Chromium 的实现差异要求显式写 'wasm-unsafe-eval' 更稳，
 *   已一并加上。少了它：控制台一条 warning，界面上是"一直转圈"。
 *
 * 运行：node md-puml-test.mjs
 */

import { createRenderQueue } from './mermaid.js';

/* ============================================================
   1. 判定
   ============================================================ */

/**
 * rehype-highlight 把语言标记写成 `language-plantuml`，
 * 但也可能直接是 `plantuml` / `puml`。只认全等，不用 includes ——
 * `includes('uml')` 会把 `language-uml-anything` 也算进来。
 */
export const PUML_LANGS = ['plantuml', 'puml', 'uml'];

export function isPlantUML(codeClass) {
  const c = String(codeClass || '');
  return PUML_LANGS.some((l) => c === `language-${l}` || c === l);
}

/* ============================================================
   2. 串行队列 —— 与 mermaid 共用一个实现
   ============================================================ */

/*
 * 为什么 PlantUML 也要串行（不能并发展示多个图）
 * ------------------------------------------------------------
 * 和 mermaid 同因不同表：PlantUML 引擎是 TeaVM 编译出来的**单实例**，
 * 内部持有 WASM 布局器的全局状态。并发调用会让两张图的布局状态
 * 互相踩，表现为"偶发画错 / 偶发空白 / 偶发内容串到另一张"。
 *
 * 官方的 VS Code 插件（PlantUML Local）明确写了
 * "renders are serialised so results never mix" —— 印证了这一点。
 *
 * 这里直接复用 mermaid 那个队列：它已经处理过
 * "前一个失败不能把后面的全拖死" 这个坑。
 */
export const pumlQueue = createRenderQueue();

/* ============================================================
   3. 回调式 API 转 Promise —— 必须带超时
   ============================================================ */

/**
 * renderToString 是**回调式**（onSuccess / onError），不是 Promise。
 *
 * 为什么要超时：
 *   引擎没加载完 / WASM 被 CSP 拦掉时，onSuccess 和 onError
 *   **可能都不被调用** —— Promise 永远 pending，界面永远转圈，
 *   而且**没有任何报错**。这是回调式 API 最阴的失效形态。
 *
 * 超时后返回的 SVG 必须是"能看见的错误"，不能是空串 ——
 * 空串会让组件以为渲染成功，然后什么都不显示。
 */
export function renderToStringP(engine, lines, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`PlantUML 渲染超时（${timeoutMs}ms）。常见原因：viz-global.js 未加载，或 CSP 未允许 WebAssembly 编译。`));
    }, timeoutMs);

    const ok = (svg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof svg !== 'string' || !svg.trim()) {
        /* 引擎返回空 —— 当成失败，否则组件会显示一块空白 */
        reject(new Error('PlantUML 返回了空的 SVG'));
        return;
      }
      resolve(svg);
    };
    const bad = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      /*
       * 传进来的已经是 Error 就**原样抛出**，不要再 String() 包一层：
       *   String(err) 会得到 "Error: 引擎没初始化"，
       *   把 "Error: " 混进 message 里，界面上就成了重复的 "错误：Error: …"。
       */
      if (msg instanceof Error) { reject(msg); return; }
      reject(new Error(String(msg || 'PlantUML 渲染失败')));
    };

    try {
      engine.renderToString(lines, ok, bad);
    } catch (e) {
      /* 同步抛出（引擎没初始化）也要转成 reject，不能让它冒泡成未捕获异常 */
      bad(e);
    }
  });
}

/* ============================================================
   4. 源码行 —— 引擎要的是数组
   ============================================================ */

/**
 * 引擎的 lines 参数是 **string[]**（一行一个元素），不是整块文本。
 * 传整块文本进去会画不出来，且不报错。
 */
export function toLines(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
}

/* ============================================================
   5. 主题适配
   ============================================================ */

/*
 * renderToString 的官方签名是 (lines, onSuccess, onError) ——
 * **没有** options，所以不能像 render() 那样传 { dark: true }。
 *
 * 因此不在 SVG 内部做配色（改 SVG 内部样式属于二次加工，
 * 而且 PlantUML 的 SVG 结构没有稳定契约，改了随时会碎）。
 *
 * 采用：容器加边框 + 圆角，让白底图变成一张"图卡"。
 * 暗色主题下是一张亮色卡片，可读且边界清楚 —— 这比
 * 用 filter: invert() 把颜色也反掉要好（反色会把品牌色搞乱）。
 */
export const PUML_BOX_CLASS = 'md-puml-box';

/* ============================================================
   6. 加载器 —— viz-global 必须是 classic script
   ============================================================ */

/**
 * @plantuml/core 有两个文件：
 *   · viz-global.js —— Graphviz/Viz.js，**必须以普通 <script> 加载**
 *     （它不是 ES module，它在全局挂变量供 plantuml.js 用）
 *   · plantuml.js   —— ES module，导出 render / renderToString
 *
 * 顺序反了（先 import ES module）会报"找不到引擎"之类的错，
 * 而且错误信息指不到"加载顺序"上。
 *
 * 幂等：多个图同时渲染时只能加载一次，否则 viz-global 被重复执行，
 * 全局状态被重置两次。
 */
export async function loadPlantUML(opts = {}) {
  const {
    vizUrl,
    loadScript = defaultLoadScript,
    importModule = defaultImportModule,
  } = opts;

  /*
   * vizUrl **必须由调用方注入**（组件里用 ?url 导入拿构建后的真实地址）。
   * 在模块里写死相对路径是错的：构建后目录结构变了，
   * 相对路径指到一个不存在的文件 —— 404 且错误信息指不到这里。
   */
  if (!vizUrl) throw new Error('loadPlantUML 缺少 vizUrl');

  if (!globalThis.__nexusVizLoaded) {
    await loadScript(vizUrl);
    globalThis.__nexusVizLoaded = true;
  }
  const mod = await importModule();
  if (!mod || typeof mod.renderToString !== 'function') {
    throw new Error('PlantUML 引擎加载失败：plantuml.js 未导出 renderToString');
  }
  return mod;
}

/*
 * 为什么 vizUrl 要走参数而不是写死（见 loadPlantUML）：
 *   在构建产物里 node_modules 的相对路径已经不存在了，
 *   只有构建工具用 ?url 导入才能拿到真实地址。
 */


function defaultLoadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('viz-global.js 加载失败'));
    document.head.appendChild(s);
  });
}

function defaultImportModule() {
  return import('@plantuml/core/plantuml.js');
}
