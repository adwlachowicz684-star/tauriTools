import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS, urlTransform } from './render-config';
import {
  classifyDrop,
  multiFileNote,
  looksBinary,
  titleOf,
} from './drop-file';
import { reactTextOf } from './text-of';
import { copyText } from './clipboard';
import { headingsOf, activeIdOf } from './toc';
import { targetOf, menuItemsFor } from './ctx-menu';

/**
 * md 插件主界面
 * ============================================================
 * 入口按清单顺序推进：
 *   E4 粘贴/输入  —— 批次 1，零权限
 *   E3 service    —— 已完成（另开 md-render 服务）
 *   E1 拖入       —— 本轮
 *   E2 宿主传路径 —— 需要宿主先有传参机制，尚未设计
 *
 * 四种入口共用同一份渲染配置，见 render-config.js。
 *
 * 【E1 的关键事实】本插件拖入**不需要文件路径**
 * ------------------------------------------------------------
 * project-group 拖入要路径（要把目录登记进配置），所以被
 * `dragDropEnabled` 卡住：true 拿得到路径但 HTML5 拖放失效，
 * false 反过来。而 md 阅读要的是**内容** ——
 * `File.text()` 直接读全文，路径根本用不上。
 *
 * 于是本插件在宿主现值（false）下**照样能拖入**，
 * 既不用动那个配置，也不卷入 project-group 那边的取舍。
 */

const SAMPLE = [
  '# md 插件 · 自检',
  '',
  '把 Markdown 粘到左边，或**直接把 .md 文件拖进来**。',
  '',
  '## 表格',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 粘贴入口 | 可用 |',
  '| service 入口 | 可用 |',
  '| 拖入入口 | 可用（不依赖文件路径） |',
  '',
  '## 任务列表',
  '',
  '- [x] 渲染管线',
  '- [x] service 入口',
  '- [x] 拖入入口',
  '- [ ] 宿主传路径（E2）',
  '',
  '## 删除线与单波浪',
  '',
  '这是 ~~双波浪删除线~~，应显示为删除线。',
  '',
  '这是 ~单波浪~ —— 关了 singleTilde 后**不该**变成删除线（防止"约 ~200ms"这类行文被误判）。',
  '',
  '## 代码',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '## 安全',
  '',
  '原始 HTML 与 javascript: 协议应被拦下，不会真的执行。',
].join('\n');

/**
 * 读取上限（字符）。
 *
 * Rust 侧 fpx_read_file 的默认值是 20000 —— 那是给"预览 skill"用的，
 * 对阅读器太小：一篇长文档读到一半就断，且**只加一句"已截断"**，
 * 不报错。所以必须显式传大值。
 *
 * 给 8M 而不是无限：真出现超大文件时不至于把内存吃干，
 * 且这种情况下"读不动"比"界面卡死"要好。
 */
const MAX_READ_CHARS = 8 * 1024 * 1024;

/**
 * 代码块：顶栏 + 复制按钮（F2/F3）。
 * ============================================================
 * 覆盖的是 `pre` 而不是 `code`：
 *   块级代码渲染成 pre > code.language-xxx，内联代码只有 code。
 *   覆盖 code 的话要把两种形态分开判断，而 pre 天然只命中块级，
 *   不用判也不会误伤行内代码。
 *
 * 语言标记从子元素 code 的 className 上取 ——
 * rehype-highlight 把原始 ```js 的 "js" 放在那里。
 */
function CodeBlock({ ctx, children, ...rest }: any) {
  const [state, setState] = useState('idle');   // idle | ok | fail
  const codeEl = Array.isArray(children) ? children[0] : children;
  const raw = useMemo(() => reactTextOf(codeEl?.props?.children), [codeEl]);
  const lang = String(codeEl?.props?.className || '')
    .match(/language-([\w+#.-]+)/)?.[1] || '';

  const onCopy = useCallback(async () => {
    const ok = await copyText(ctx, raw);
    setState(ok ? 'ok' : 'fail');
    /* 复位：不复位的话复制第二个块时，第一个块的"已复制"还挂着，
       看起来像新那次没生效 */
    setTimeout(() => setState('idle'), 1500);
  }, [ctx, raw]);

  return (
    <pre {...rest}>
      <div className="md-code-bar" contentEditable={false}>
        <span className="md-code-lang">{lang || 'text'}</span>
        <button
          type="button"
          className={`md-code-copy is-${state}`}
          onClick={onCopy}
          title="复制代码"
        >
          {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : '复制'}
        </button>
      </div>
      {children}
    </pre>
  );
}

export default function MdApp({ ctx }: { ctx?: any } = {}) {
  const [src, setSrc] = useState(SAMPLE);
  /* 当前文件名。空串 = 内容是粘贴/默认的，不是从文件来的。 */
  const [fileName, setFileName] = useState('');
  const [hint, setHint] = useState('');
  const [dragging, setDragging] = useState(false);

  /* 渲染区容器。TOC 与右键菜单都要它，见下面各自说明。 */
  const outRef = useRef<any>(null);

  /*
   * F4 目录。
   *
   * 在**渲染之后**从 DOM 里读，而不是先解析源码算锚点：
   * id 由 rehype-slug（github-slugger）生成，带去重与 emoji 处理，
   * 自己照抄一份必然漂移，表现是"点了 TOC 没反应"且不报错。
   * 直接问 DOM 就没有重复逻辑。
   *
   * 依赖里必须带 body：body 换了 DOM 才重建，
   * 只依赖 src 的话在极端情况下会读到上一帧的 DOM。
   */
  const [toc, setToc] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  /* 滚动高亮：挂在**容器**上而不是 window ——
     滚动的是 .md-out 自己，window 根本不滚，挂上去永远不触发。 */
  const onOutScroll = useCallback(() => {
    setActiveId(activeIdOf(toc, outRef.current));
  }, [toc]);

  const onTocClick = useCallback((id: string) => {
    const el = outRef.current?.querySelector(`[id="${id.replace(/["\\]/g, '\\$&')}"]`);
    /* 用 scrollIntoView 而不是算 offsetTop：
       后者在嵌套滚动容器里要逐级累加，漏一级就滚错位置。 */
    el?.scrollIntoView({ block: 'start' });
    setActiveId(id);
  }, []);

  /*
   * F5 右键菜单。
   * 菜单项由 ctx-menu 生成，复制走 clipboard.copyText。
   */
  const [menu, setMenu] = useState<any>(null);

  const onContextMenu = useCallback((e: any) => {
    const t = targetOf(e.target);
    /* 不是链接/图片就不接管：让浏览器原生菜单出来。
       一律接管会让"想复制正文"变得做不到。 */
    if (!t) { setMenu(null); return; }
    const items = menuItemsFor(t);
    if (!items.length) { setMenu(null); return; }
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items, kind: t.kind });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (ev: any) => { if (ev.key === 'Escape') setMenu(null); };
    /* 捕获阶段：菜单自己内部也监听的话，点菜单项会先关菜单再点不到按钮。
       用捕获 + 判断来源更稳，这里直接监听 document 的 click（含菜单内），
       菜单项的 onClick 会先跑（冒泡到 document 之前），所以顺序是对的。 */
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  /*
   * 渲染结果按 src 记忆化。
   * 不 memo 的话，输入框每敲一个字符都整篇重新解析 ——
   * 小文档无感，批次 4 要上大文档虚拟滚动，那时每键全量重解析会直接卡死。
   * 位置先定在这里，批次 4 只需换掉 ReactMarkdown，不用改调用点。
   */
  const components = useMemo(
    () => ({ pre: (props: any) => <CodeBlock ctx={ctx} {...props} /> }),
    [ctx],
  );

  const body = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={urlTransform}
        components={components}
      >
        {src}
      </ReactMarkdown>
    ),
    [src, components],
  );

  /*
   * 目录在**渲染之后**从 DOM 读，所以依赖 body 而不是 src：
   * body 换了 DOM 才重建，依赖 src 会读到上一帧。
   */
  useEffect(() => {
    const items = headingsOf(outRef.current);
    setToc(items);
    setActiveId(null);
  }, [body]);

  const onDrop = useCallback(async (e) => {
    /*
     * 两处 preventDefault 一个都不能少：
     *   · onDrop  —— 否则浏览器把文件"打开"（整个界面导航走）
     *   · onDragOver —— 少了它 drop 事件根本不触发（HTML5 的硬性要求）
     * 宿主有文档级守卫兜底，但那是另一层：插件自己必须拦，
     * 不能依赖宿主 —— 顺序和存在性都不该假设。
     */
    e.preventDefault();
    setDragging(false);

    const { kind, file, message, extra } = classifyDrop(e.dataTransfer);
    const note = multiFileNote(extra);

    if (kind === 'empty' || kind === 'folder' || kind === 'too-large') {
      setHint(message);
      return;
    }

    let text;
    try {
      text = await file.text();
    } catch (err) {
      setHint(`读取失败：${err?.message || err}`);
      return;
    }

    /* 二进制兜底：扩展名可以骗人，读完之后看有没有 NUL 才准 */
    if (looksBinary(text)) {
      setHint(`「${file.name}」看起来不是文本文件，已跳过`);
      return;
    }

    setSrc(text);
    setFileName(file.name || '');
    /* 正常打开时也要显示多文件说明：静默丢弃容易让人误以为打开的是想要那个 */
    setHint(note);
  }, []);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setDragging(false), []);

  /*
   * E2：宿主传路径。
   *
   * 两条通道都要，缺一不可（这也是宿主 openWithArgs 分两种情况的原因）：
   *   · ctx.openArgs      —— 挂载**之前**就带进来的，同步可读
   *   · ctx.onOpenArgs    —— 已挂载后再次打开新文件，走事件总线
   *
   * 只接前者：第二次"用 md 打开另一个文件"没反应；
   * 只接后者：第一次收不到（那时还没订阅）。
   */
  const openPath = useCallback(async (path: string) => {
    if (!path) return;
    try {
      const text = await ctx.invoke('fpx_read_file', {
        path,
        max: MAX_READ_CHARS,
      });
      if (typeof text !== 'string') {
        setHint('读取失败：返回内容不是文本');
        return;
      }
      setSrc(text);
      const nm = String(path).replace(/\\/g, '/').split('/').pop() || path;
      setFileName(nm);
      setHint('');
    } catch (err) {
      setHint(`读取失败：${err?.message || err}`);
    }
  }, [ctx]);

  useEffect(() => {
    if (!ctx) return;
    const first = ctx.openArgs?.path;
    if (first) openPath(first);
    const off = ctx.onOpenArgs?.((args: any) => {
      if (args?.path) openPath(args.path);
    });
    return () => off?.();
  }, [ctx, openPath]);

  return (
    <div
      className={`md-wrap${dragging ? ' is-drag' : ''}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="md-bar">
        <span className="md-file">
          {fileName ? titleOf(fileName) : '未命名（粘贴/默认）'}
        </span>
        {hint ? <span className="md-hint">{hint}</span> : null}
      </div>
      {/*
        目录栏：没有标题时不渲染整栏。
        渲染空栏会留一条永远空白的窄条，看着像布局坏了。
      */}
      {toc.length ? (
        <nav className="md-toc">
          <div className="md-pane-t">目录 · {toc.length}</div>
          <ul className="md-toc-list">
            {toc.map((it, i) => (
              <li key={`${it.id}-${i}`} className={`md-toc-lv${it.level}`}>
                <button
                  type="button"
                  className={`md-toc-item${activeId === it.id ? ' is-on' : ''}`}
                  onClick={() => onTocClick(it.id)}
                  title={it.text}
                >
                  {it.text}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <div className="md-panes">
        <div className="md-pane">
          <div className="md-pane-t">Markdown 源</div>
          <textarea
            className="md-src"
            value={src}
            onChange={(e) => {
              setSrc(e.target.value);
              /*
               * 手改内容后文件名就不再是内容的来源了。
               * 不清的话会出现"标题写着 a.md，内容其实是 b.md 改过的"，
               * 而这正是用户会拿去判断"我打开的是哪个文件"的信息。
               */
              setFileName('');
              setHint('');
            }}
            spellCheck={false}
          />
        </div>
        <div className="md-pane">
          <div className="md-pane-t">渲染结果</div>
          <div
            className="md-out markdown-body"
            ref={outRef}
            onScroll={onOutScroll}
            onContextMenu={onContextMenu}
          >
            {body}
          </div>
        </div>
      </div>
      {/*
        右键菜单：定位于 clientX/clientY（视口坐标），
        父级是 position:relative 的 md-wrap，直接减它的矩形即可。
        不用 pageX：那在有滚动时会算出屏幕外。
      */}
      {menu ? (
        <div
          className="md-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.items.map((it: any) => (
            <button
              type="button"
              key={it.key}
              className="md-menu-item"
              onClick={async () => {
                const ok = await copyText(ctx, it.value);
                setMenu(null);
                if (!ok) setHint('复制失败：剪贴板不可用');
                else setHint(`已${it.label}`);
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
