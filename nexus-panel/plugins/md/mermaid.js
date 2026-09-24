/**
 * Mermaid 图表 —— 纯逻辑部分（不含渲染，可在 node 里真跑）
 * ============================================================
 * 刻意把「排队 / 主题映射 / 判定」抽出来，只把「调 mermaid 渲染」
 * 留在组件里：
 *   · 这些逻辑错了都不报错，只表现为"图偶发画错/颜色不对"，
 *     不实测根本发现不了
 *   · 抽成纯函数就能在 node 里跑，不用起浏览器
 *
 * 运行：node md-mermaid-test.mjs
 */

/* ============================================================
   1. 串行队列 —— 必须全局，且不能被上一次失败卡死
   ============================================================ */

/**
 * 为什么要串行（不能并发渲染多个图）
 * ------------------------------------------------------------
 * mermaid 的 themeVariables 是**模块级全局状态**：
 * `mermaid.initialize()` 设一次，之后所有 render 共用。
 *
 * 于是并发时会这样：
 *   render(A, theme=暗)  → initialize(暗) → 开始画（异步）
 *   render(B, theme=亮)  → initialize(亮) → A 还没画完，拿到的是亮色
 * 结果 A 用亮色画、B 用暗色画，**图没错、颜色错** ——
 * 而颜色错了没人会认为是并发问题，只会以为是主题没跟上。
 *
 * 而且它不可复现：取决于谁先画完，刷新一次可能就好了。
 */
export function createRenderQueue() {
  let chain = Promise.resolve();
  let running = 0;

  return {
    /**
     * @template T
     * @param {() => Promise<T>} task
     * @returns {Promise<T>}
     */
    run(task) {
      /*
       * 两处 catch 一个都不能少：
       *
       *   · chain = p.catch(noop)
       *     少了它，前一个任务 reject 会让 chain 永久处于 rejected，
       *     **后面所有图都不再渲染**，且不报错 ——
       *     一个语法错误的图会把整篇文档的图全拖死。
       *
       *   · 返回 p 而不是 chain
       *     返回 chain 的话调用方拿到的永远是被 catch 吞掉的结果，
       *     失败变成 undefined，组件的错误处理形同虚设。
       */
      const p = chain.then(task, task);
      chain = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
    get pending() { return running; },
  };
}

/* ============================================================
   2. 主题映射 —— 从宿主变量读，不写死色板
   ============================================================ */

/*
 * 写死色板（比如 '#1e1e1e'）的后果：
 *   切换主题时 md 正文变了、图没变。
 *   而图通常是文档里最显眼的部分，用户会直接认为"主题没生效"。
 *
 * 所以从宿主 CSS 变量读。readVar 由调用方注入（getComputedStyle），
 * 这样测试里可以喂假值。
 */
const VAR_MAP = {
  background: ['--bg', '--nm-bg', '--panel-bg'],
  primaryColor: ['--nm-surface', '--surface', '--card-bg'],
  primaryTextColor: ['--text', '--fg', '--nm-text'],
  primaryBorderColor: ['--border', '--nm-border'],
  lineColor: ['--text-dim', '--muted', '--nm-text-dim'],
  secondaryColor: ['--nm-surface-2', '--surface-2'],
  tertiaryColor: ['--nm-surface-3', '--surface-3'],
};

/**
 * @param {(name: string) => string} readVar
 * @returns {Record<string, string>}
 *
 * 读不到的一律**不填**：填个兜底色的后果是"主题切换时该元素不变"，
 * 比"该元素用 mermaid 自己的默认色"更糟 ——
 * 后者至少整张图会跟着 theme 走。
 */
export function themeVarsOf(readVar) {
  const out = {};
  for (const [key, names] of Object.entries(VAR_MAP)) {
    for (const n of names) {
      const v = readVar(n);
      if (v && String(v).trim()) { out[key] = String(v).trim(); break; }
    }
  }
  return out;
}

/* ============================================================
   3. 判定与键
   ============================================================ */

/**
 * 代码块是不是 mermaid。
 *
 * 只认 `language-mermaid`（rehype-highlight 加的类名），
 * 不认 ``` 后面没写语言的 —— 那可能是任何东西。
 */
export function isMermaid(className) {
  return /(?:^|\s)language-mermaid(?:\s|$)/.test(String(className || ''));
}

/**
 * 缓存键。
 *
 * 必须带上主题标记：源码没变但主题变了，
 * 图要重画（不然切换主题后图还是旧配色）。
 * 不带主题的话缓存会把"该重画的"也拦下来，
 * 表现是切主题后图不变 —— 而上面 themeVarsOf 正是为这个做的工作。
 */
export function cacheKeyOf(code, themeTag) {
  return `${themeTag || 'default'} ${code || ''}`;
}

/* ============================================================
   4. 输出后处理 —— 不能二次消毒
   ============================================================ */

/**
 * 是否需要对 mermaid 输出再做一次消毒。
 *
 * **不要。** securityLevel:'strict' 下 mermaid 自己已经用 DOMPurify
 * 消过毒了。再消一次会剥掉 `foreignObject` 里的 `htmlLabels` ——
 * 那是节点里的文字，剥掉之后**图还在、文字全没了**。
 *
 * 这类"更安全反而坏掉"的改动最容易被顺手加上，
 * 所以单独写成函数并钉住，不靠注释提醒。
 */
export function needsExtraSanitize() {
  return false;
}
