/**
 * PlantUML 图表块 —— 渲染部分
 * ============================================================
 * 逻辑（判定 / 排队 / 回调转 Promise / 加载）在 plantuml.js，
 * 这里只负责调引擎画。与 MermaidBlock 同一套结构。
 *
 * 四个必须遵守的约束，错了都不报错：
 *
 *   ① 串行 —— 引擎是 TeaVM 单实例，内部持有 WASM 布局器全局状态。
 *      并发会让图的布局互相踩（偶发空白/串图）。
 *
 *   ② viz-global.js 必须先于 plantuml.js 加载，且是 **classic script**。
 *      当 ES module 导入时它对全局变量的赋值不落到全局作用域，
 *      plantuml.js 就找不到布局器 —— 报的错指不到"加载顺序"上。
 *
 *   ③ 回调转 Promise 必须带超时 —— 引擎没起来时 onSuccess/onError
 *      **可能都不调用**，Promise 永远 pending，界面永远转圈且无报错。
 *
 *   ④ 引擎要 string[]，不是整块文本。传整块文本画不出来且不报错。
 */

import { useEffect, useRef, useState } from 'react';
import { isPlantUML, pumlQueue, renderToStringP, toLines, PUML_BOX_CLASS } from './plantuml';
import { reactTextOf } from './text-of';

/*
 * ?url 只拿到一个 **URL 字符串**，不会下载脚本本体。
 * 所以这里可以静态导入：不打 plantuml 块的用户不会付出 1.4MB 的代价，
 * 真正的文件要等 loadPlantUML 注入 <script> 时才下载。
 */
// @ts-ignore —— Vite 的 ?url 后缀，TS 默认不认识
import vizUrl from '@plantuml/core/viz-global.js?url';

/*
 * 引擎模块缓存：ES module 本身只 import 一次，这里存的是
 * "已经 resolve 的 Promise"，避免多张图同时触发多次 dynamic import。
 */
let enginePromise: Promise<any> | null = null;

function getEngine(): Promise<any> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const { loadPlantUML } = await import('./plantuml');
    return loadPlantUML({
      vizUrl,
      importModule: () => import('@plantuml/core/plantuml.js'),
    });
  })();
  /*
   * 失败了要把缓存清掉，否则**一次失败就永久失败** ——
   * 网络抖了一下，之后所有图都画不出来，且不重试。
   */
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

/** 渲染结果缓存：同一段源码只画一次 */
const htmlCache = new Map<string, string>();

export default function PlantUMLBlock({ ctx, children, className, ...rest }: any) {
  const code = String(reactTextOf((children as any)?.props?.children ?? children) || '');
  const [html, setHtml] = useState<string>(() => htmlCache.get(code) || '');
  const [err, setErr] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!code.trim()) return;

    const hit = htmlCache.get(code);
    if (typeof hit === 'string') { setHtml(hit); setErr(''); return; }

    let cancelled = false;
    setErr('');

    pumlQueue.run(async () => {
      const engine = await getEngine();
      return renderToStringP(engine, toLines(code));
    }).then((svg: string) => {
      if (cancelled || !alive.current) return;
      htmlCache.set(code, svg);
      setHtml(svg);
    }).catch((e: any) => {
      if (cancelled || !alive.current) return;
      /*
       * 语法错误的图**必须显示出来**：静默失败的话用户只看到空白，
       * 分不清是图写错了还是插件坏了。
       */
      setErr(`图表渲染失败：${e?.message || e}`);
    });

    return () => { cancelled = true; };
  }, [code]);

  /* 不是 plantuml 的代码块不该走到这里 —— 兜底渲染成 pre，不丢内容 */
  if (!isPlantUML(className)) {
    return <pre {...rest}><code className={className}>{code}</code></pre>;
  }

  if (err) {
    return (
      <div className={`${PUML_BOX_CLASS} md-puml-err`}>
        <div className="md-puml-msg">{err}</div>
        <pre className="md-puml-src"><code>{code}</code></pre>
      </div>
    );
  }

  if (!html) {
    /* 占位高度：不给的话图画出来会把下面的内容顶下去，滚动位置跳一下 */
    return <div className={`${PUML_BOX_CLASS} md-puml-loading`}>图表渲染中…</div>;
  }

  /*
   * dangerouslySetInnerHTML 是**被迫**的：引擎只输出 SVG 字符串。
   * PlantUML 的 SVG 由引擎生成，用户源码里的文字进 <text> 会被转义，
   * 不像 mermaid 那样有 htmlLabels 的注入面。
   * 这里**不要**再套一层消毒 —— 剥属性会破坏 SVG 结构。
   */
  return (
    <div
      className={PUML_BOX_CLASS}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
