/**
 * Mermaid 图表块 —— 渲染部分
 * ============================================================
 * 逻辑（排队 / 主题 / 判定）在 mermaid.js，这里只负责调 mermaid 画。
 *
 * 三个必须遵守的约束，前两个错了都不报错：
 *
 *   ① 串行 —— 见 mermaid.js createRenderQueue 的注释。
 *      mermaid 的 themeVariables 是模块级全局，并发会串色，
 *      且不可复现（取决于谁先画完）。
 *
 *   ② 不二次消毒 —— strict 下 mermaid 已用 DOMPurify 消过毒，
 *      再消会剥掉 foreignObject 里的 htmlLabels 文字，
 *      **图还在、字没了**。见 needsExtraSanitize。
 *
 *   ③ 主题从宿主变量映射 —— 写死色板则切主题时图不变。
 */

import { useEffect, useRef, useState } from 'react';
import {
  createRenderQueue,
  themeVarsOf,
  isMermaid,
  cacheKeyOf,
} from './mermaid';
import { reactTextOf } from './text-of';

/*
 * 队列必须是**模块级单例**。
 *
 * 放在组件里（或每个块一个）就完全没有串行效果了：
 * 一篇文档里有 5 张图就有 5 个队列，各自并发，串色照旧发生，
 * 而且因为每张图的时机不同，还会变成偶发 —— 更难查。
 */
const queue = createRenderQueue();

/*
 * 渲染结果缓存：同一段源码 + 同一主题只画一次。
 * 键带 themeTag（见 cacheKeyOf），否则切主题后图不重画。
 */
const htmlCache = new Map();

/** 主题标记：宿主 <html> 上的 data-theme 之类，用于判断要不要重画 */
function themeTagOf() {
  try {
    return (
      document.documentElement.getAttribute('data-theme') ||
      document.documentElement.className ||
      ''
    );
  } catch {
    return '';
  }
}

function readVar(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name) || '';
  } catch {
    return '';
  }
}

export default function MermaidBlock({ ctx, children, className, ...rest }: any) {
  const code = String(reactTextOf((children as any)?.props?.children ?? children) || '');
  const [html, setHtml] = useState<string>(() => {
    const hit = htmlCache.get(cacheKeyOf(code, themeTagOf()));
    return typeof hit === 'string' ? hit : '';
  });
  const [err, setErr] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!code.trim()) return;
    const tag = themeTagOf();
    const key = cacheKeyOf(code, tag);

    const hit = htmlCache.get(key);
    if (typeof hit === 'string') { setHtml(hit); setErr(''); return; }

    let cancelled = false;
    setErr('');

    queue.run(async () => {
      /*
       * 动态 import —— mermaid 体积远大于常规告警阈值，
       * 不能进首屏。文档里没有 mermaid 块时根本不会加载它。
       */
      const mod: any = await import('mermaid');
      const mermaid = mod?.default || mod;

      const vars = themeVarsOf(readVar);
      /*
       * securityLevel 必须 strict：
       *   更低级别允许图里写 HTML/点击跳转，那是把 md 文件
       *   变成可执行内容的口子。strict 下 mermaid 自己用 DOMPurify 消毒。
       */
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: Object.keys(vars).length ? vars : undefined,
      });

      const { svg } = await mermaid.render(`md-mm-${Math.random().toString(36).slice(2)}`, code);
      return svg;
    }).then((svg: string) => {
      if (cancelled || !alive.current) return;
      htmlCache.set(key, svg);
      setHtml(svg);
    }).catch((e: any) => {
      if (cancelled || !alive.current) return;
      /*
       * 语法错误的图**必须显示出来**：静默失败的话用户只看到空白，
       * 不知道是图写错了还是插件坏了。
       */
      setErr(`图表渲染失败：${e?.message || e}`);
    });

    return () => { cancelled = true; };
  }, [code]);

  /* 不是 mermaid 的代码块不该走到这里 —— 兜底渲染成 pre，不丢内容 */
  if (!isMermaid(className)) {
    return <pre {...rest}><code className={className}>{code}</code></pre>;
  }

  if (err) {
    return (
      <div className="md-mm md-mm-err">
        <div className="md-mm-msg">{err}</div>
        <pre className="md-mm-src"><code>{code}</code></pre>
      </div>
    );
  }

  if (!html) {
    /* 占位高度：不给的话图画出来会把下面的内容顶下去，滚动位置跳一下 */
    return <div className="md-mm md-mm-loading">图表渲染中…</div>;
  }

  /*
   * dangerouslySetInnerHTML 是**被迫**的：
   *   mermaid 只输出 SVG 字符串，没有别的插入方式。
   *   安全性由 securityLevel:'strict' 承担（mermaid 内部用 DOMPurify）。
   *   这里**不要**再套一层消毒 —— 见 needsExtraSanitize()。
   */
  return <div className="md-mm" dangerouslySetInnerHTML={{ __html: html }} />;
}
