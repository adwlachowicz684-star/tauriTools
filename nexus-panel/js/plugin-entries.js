/**
 * 同页（module）插件入口的加载器
 * ============================================================
 * 为什么要有这个文件
 * ------------------------------------------------------------
 * 同页插件原先靠运行时动态 import 加载：
 *
 *   await import(/* @vite-ignore *\/ resolveEntry(manifest.entry))
 *
 * `@vite-ignore` 让 Vite **跳过静态分析**，于是：
 *   · 不生成对应 chunk
 *   · 产物里的 import 路径不被重写
 *   · 构建后 dist 里根本没有那个入口文件 → **运行时 404**
 *
 * 这就是"Vite 模式下只能 iframe"的根因（见 build-entry-test.mjs）。
 *
 * 解法（方案 B）：`import.meta.glob`
 * ------------------------------------------------------------
 * Vite 会在构建时**静态展开** glob：
 *   · 为每个匹配文件生成独立 chunk
 *   · 把这里拿到的路径重写成产物路径
 *   · 运行时只是一句动态 import，动态性保留
 * 于是同页插件在 Vite 生产构建下也能加载，且新增插件只要符合命名约定
 * 就自动被纳入 —— 不需要维护显式入口表。
 *
 * 命名约定
 * ------------------------------------------------------------
 *   plugins/<id>/module.{js,ts,tsx}
 *
 * 用 `module.*` 而不是 `index.*`，是为了和 iframe 入口 `index.html`
 * 明确区分开：同一个插件目录里两种入口可以并存（各模式走各的）。
 *
 * 无构建模式怎么办
 * ------------------------------------------------------------
 * 那时没有 Vite，`import.meta.glob` 不存在，调用会 TypeError。
 * 所以整段包 try/catch，失败就退回原来的动态 import ——
 * **无构建模式的行为一字不改**。
 *
 * 回退不是兜底偷懒：无构建模式下源码直出，
 * `../../js/plugin-sdk.js` 这类相对路径真实有效，动态 import 本就能跑。
 */

/*
 * Vite 在构建期静态展开这个调用。
 *
 * 包在 try 里是为了无构建模式（import.meta.glob 未定义）不至于让整个
 * 模块加载失败 —— Vite 的 glob 转换不受 try 影响，照常展开。
 *
 * eager:false —— 生成懒加载 chunk，插件不被打开就不下载。
 */
let globbed = {};
try {
  globbed = import.meta.glob('../plugins/*/module.{js,mjs,ts,tsx}', { eager: false });
} catch {
  globbed = {};
}

/**
 * 把各种相对写法归一化成 `plugins/<id>/module.xxx`
 * 用于让 manifest.entry 与 glob 的 key 对上。
 */
function normalize(p) {
  return String(p || '')
    .replace(/^\.\//, '')
    .replace(/^\.\.\//, '')
    .replace(/^\//, '');
}

/** 入口路径 → glob 里的加载器 */
function findLoader(entry) {
  const want = normalize(entry);
  for (const [key, loader] of Object.entries(globbed)) {
    if (normalize(key) === want) return loader;
  }
  return null;
}

/**
 * 加载一个同页插件入口。
 *
 * @param {string} entry  manifest.entry（如 './plugins/home/module.tsx'）
 * @returns {Promise<object>} 模块对象
 */
export async function loadModuleEntry(entry) {
  const loader = findLoader(entry);
  if (typeof loader === 'function') {
    /* Vite 构建模式：glob 展开出的懒加载器 */
    return await loader();
  }

  /*
   * 回退：无构建模式（源码直出）。
   *
   * 注意 —— 这里是**有意为之**的两条路，不是"兜底"：
   *   · 无构建：源码直出，相对路径有效，动态 import 能跑
   *   · Vite  ：走上面的 glob 分支
   * 两条路都覆盖不到时（Vite 下 entry 没被 glob 匹配），
   * 错误信息必须说清原因，否则只会看到一句费解的 404。
   */
  if (Object.keys(globbed).length > 0) {
    throw new Error(
      `同页入口未被构建期 glob 收录：${entry}\n`
      + 'Vite 构建下同页插件入口必须放在 plugins/<id>/module.{js,mjs,ts,tsx}，'
      + '否则产物里不会生成对应 chunk（表现为运行时 404）。',
    );
  }
  return await import(/* @vite-ignore */ new URL(entry, location.href).href);
}

/** 供测试与诊断：当前 glob 收录了哪些入口（无构建模式下为空） */
export function globbedEntries() {
  return Object.keys(globbed).map(normalize).sort();
}
