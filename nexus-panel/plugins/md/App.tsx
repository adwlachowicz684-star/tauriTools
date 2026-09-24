import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS, urlTransform } from './render-config';

/**
 * md 插件主界面
 * ============================================================
 * 批次 1 只做一件入口：**粘贴/输入**（E4，零权限）。
 * 拖入（E1）、service（E3）、宿主传路径（E2）在批次 2 补，
 * 但四种入口共用这里的同一份渲染配置 —— 见 render-config.js。
 *
 * 为什么先用粘贴入口打头
 * ------------------------------------------------------------
 * 它不需要任何文件权限，也不依赖宿主传参机制（E2 那条目前还不存在）。
 * 先让它跑起来，可以在"有没有权限/有没有机制"之外，
 * 单独验证渲染管线本身对不对 —— 问题不会混在一起。
 */

const SAMPLE = [
  '# md 插件 · 批次 1 自检',
  '',
  '把 Markdown 粘到左边，右边实时渲染。',
  '',
  '## 表格',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 入口 | 粘贴 |',
  '| 权限 | 无 |',
  '',
  '## 任务列表',
  '',
  '- [x] 渲染管线',
  '- [ ] 拖入入口',
  '- [ ] service 入口',
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

export default function MdApp() {
  const [src, setSrc] = useState(SAMPLE);

  /*
   * 渲染结果按 src 记忆化。
   * 不 memo 的话，每次输入框敲一个字符都会整篇重新解析 ——
   * 小文档无感，但批次 4 要上大文档虚拟滚动，那时每键全量重解析会直接卡死。
   * 这里先把记忆化的位置定下来，批次 4 只需把 ReactMarkdown 换成
   * 分块后的组件，不用回头改调用点。
   */
  const body = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={urlTransform}
      >
        {src}
      </ReactMarkdown>
    ),
    [src],
  );

  return (
    <div className="md-wrap">
      <div className="md-panes">
        <div className="md-pane">
          <div className="md-pane-t">Markdown 源</div>
          <textarea
            className="md-src"
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="md-pane">
          <div className="md-pane-t">渲染结果</div>
          <div className="md-out markdown-body">{body}</div>
        </div>
      </div>
    </div>
  );
}
