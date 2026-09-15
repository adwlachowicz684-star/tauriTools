import { useEffect, useMemo, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import type { ContentItem } from '../types';

interface TreeNode {
  name: string;
  path: string;
  relPath: string;
  /** 所属类别（agent/skill/rule）。同名条目在不同类别下是不同节点，必须一起参与匹配。 */
  kind: string;
  item?: ContentItem;
  children: TreeNode[];
}

function buildTree(items: ContentItem[]): TreeNode[] {
  const roots: TreeNode[] = [];

  for (const it of items) {
    const parts = it.relPath.split('\\').filter(Boolean);
    let level = roots;
    let prefix = '';

    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      prefix = prefix ? `${prefix}\\${part}` : part;
      // 关键：按 kind + name 匹配。否则 agent\foo.md 与 rule\foo.md 会撞成同一个节点，
      // 后遍历到的 item 覆盖先遍历到的，界面上直接少一个条目。
      let node = level.find((n) => n.name === part && n.kind === it.kind);
      if (!node) {
        node = { name: part, path: '', relPath: prefix, kind: it.kind, children: [] };
        level.push(node);
      }
      if (isLeaf) {
        node.item = it;
        node.path = it.path;
      }
      level = node.children;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const ad = a.children.length > 0 && !a.item;
      const bd = b.children.length > 0 && !b.item;
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

const KIND_LABEL: Record<string, string> = { agent: 'Agent', skill: 'Skill', rule: 'Rule' };

export function ContentPanel({
  api, root, items, kind, onKind, onLog, onRename, onRefresh,
}: {
  api: Api;
  root: string;
  items: ContentItem[];
  kind: 'all' | 'agent' | 'skill' | 'rule';
  onKind: (k: 'all' | 'agent' | 'skill' | 'rule') => void;
  onLog: (msg: string, isError?: boolean) => void;
  /** 条目改名（WPF AgentSkill 面板的 RenameCommand 对应入口） */
  onRename: (item: ContentItem) => void;
  /** 重新扫描当前目录 */
  onRefresh: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ContentItem | null>(null);
  const [text, setText] = useState('');

  const tree = useMemo(() => buildTree(items), [items]);
  const counts = useMemo(() => ({
    agent: items.filter((i) => i.kind === 'agent').length,
    skill: items.filter((i) => i.kind === 'skill').length,
    rule: items.filter((i) => i.kind === 'rule').length,
  }), [items]);

  useEffect(() => { setSelected(null); setText(''); }, [root, kind]);

  const read = async (item: ContentItem) => {
    setSelected(item);
    setText('');
    try {
      // 目录型 skill 传的是目录，后端会自动改读其下的 SKILL.md
      const t = await api.readFile(item.path);
      setText(t);
    } catch (e) {
      setText('');
      onLog(`读取失败：${errText(e)}`, true);
    }
  };

  const renderNodes = (nodes: TreeNode[], depth: number): JSX.Element[] =>
    nodes.flatMap((n) => {
      const isDir = n.item ? n.item.isDir : true;
      // 折叠状态按 kind+relPath 记：不同类别下的同名目录要能各自独立展开
      const key = `${n.kind}\\${n.relPath}`;
      const open = !collapsed.has(key);
      const row = (
        <div
          key={key}
          className={`fpx-node${selected?.path === n.item?.path ? ' selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            if (n.item) {
              // 叶子（含「目录型 skill」——它整体就是一个 skill），点开读内容
              read(n.item);
            } else {
              setCollapsed((s) => {
                const next = new Set(s);
                if (next.has(key)) next.delete(key); else next.add(key);
                return next;
              });
            }
          }}
          onDoubleClick={() => n.item && api.openPath(n.item.path, 'auto').catch((e) => onLog(errText(e), true))}
        >
          <span className="fpx-node-arrow">{n.item ? '' : (open ? '▾' : '▸')}</span>
          <span className="fpx-node-icon">{isDir ? '📂' : '📄'}</span>
          <span className="fpx-node-name">{n.name}</span>
          <span className="fpx-node-kind">{n.item ? KIND_LABEL[n.item.kind] : ''}</span>
        </div>
      );
      return !n.item && open ? [row, ...renderNodes(n.children, depth + 1)] : [row];
    });

  return (
    <div className="fpx-content">
      <div className="p-row fpx-content-head">
        {(['all', 'agent', 'skill', 'rule'] as const).map((k) => (
          <button
            key={k}
            className={`p-btn${kind === k ? ' primary' : ''}`}
            style={{ height: 30, padding: '0 12px' }}
            onClick={() => onKind(k)}
          >
            {k === 'all' ? `全部 ${items.length}` : `${KIND_LABEL[k]} ${counts[k]}`}
          </button>
        ))}
        <button
          className="p-btn"
          style={{ height: 30, padding: '0 12px' }}
          disabled={!root}
          onClick={() => api.openPath(root, 'dir').catch((e) => onLog(errText(e), true))}
        >
          打开目录
        </button>
        <button
          className="p-btn"
          style={{ height: 30, padding: '0 12px' }}
          disabled={!root}
          title="重新扫描当前目录"
          onClick={onRefresh}
        >
          刷新
        </button>
      </div>

      <div className="p-muted fpx-content-root">{root || '未选择项目组'}</div>

      <div className="fpx-tree">
        {items.length === 0 && <div className="p-muted">（该目录下没有 agent / skill / rule）</div>}
        {renderNodes(tree, 0)}
      </div>

      <div className="fpx-preview">
        <div className="p-row" style={{ justifyContent: 'space-between' }}>
          <div className="p-mono p-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected ? selected.path : '预览'}
          </div>
          {selected && (
            <div className="p-row">
              <button className="p-btn" style={{ height: 28, padding: '0 10px' }}
                onClick={() => api.openPath(selected.path, 'containing').catch((e) => onLog(errText(e), true))}>
                所在目录
              </button>
              <button className="p-btn" style={{ height: 28, padding: '0 10px' }}
                onClick={() => api.editFile(selected.path).catch((e) => onLog(errText(e), true))}>
                外部编辑
              </button>
              <button className="p-btn" style={{ height: 28, padding: '0 10px' }}
                title="重命名该条目（文件保留扩展名）"
                onClick={() => onRename(selected)}>
                改名
              </button>
              {/* 沙箱内 navigator.clipboard 会被静默拒绝，走后端复制命令 */}
              <button className="p-btn" style={{ height: 28, padding: '0 10px' }}
                title="复制条目名称"
                onClick={() =>
                  api.copyText(selected.name).then(
                    (ok) => onLog(ok ? `已复制名称：${selected.name}` : '复制失败', !ok),
                    (e) => onLog(errText(e), true),
                  )
                }>
                复制名
              </button>
              <button className="p-btn" style={{ height: 28, padding: '0 10px' }}
                title="复制完整路径"
                onClick={() =>
                  api.copyText(selected.path).then(
                    (ok) => onLog(ok ? `已复制路径：${selected.path}` : '复制失败', !ok),
                    (e) => onLog(errText(e), true),
                  )
                }>
                复制路径
              </button>
            </div>
          )}
        </div>
        <pre className="fpx-pre">{text || (selected ? '（空文件）' : '左侧点选一个条目查看内容')}</pre>
      </div>
    </div>
  );
}
