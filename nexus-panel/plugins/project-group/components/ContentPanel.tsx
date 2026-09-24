import { useEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import type { ContentItem } from '../types';
import {
  buildTree, fillDirPaths, skillTreeRelPath, planSkillSegmentRename,
  collectLeaves, type TreeNode,
} from '../utils/contentTree';
import { ContextMenu, type MenuItem } from './ui';

const KIND_LABEL: Record<string, string> = { agent: 'Agent', skill: 'Skill', rule: 'Rule' };

export function ContentPanel({
  api, root, items, kind, onKind, onLog, onRename, onRenameSegment, onRefresh,
  selected, onSelect,
}: {
  api: Api;
  root: string;
  items: ContentItem[];
  kind: 'all' | 'agent' | 'skill' | 'rule';
  onKind: (k: 'all' | 'agent' | 'skill' | 'rule') => void;
  onLog: (msg: string, isError?: boolean) => void;
  /** 条目改名（WPF AgentSkill 面板的 RenameCommand 对应入口） */
  onRename: (target: { path: string; name: string }) => void;
  /**
   * #213 skill 虚拟层改名：批量替换子树条目物理名里对应的 `_` 段。
   *
   * 与单条改名分开是因为**语义完全不同**：单条改的是磁盘上的一个名字，
   * 这里一次动 N 个条目，且要告诉用户"会影响几个"再让他填 ——
   * 合并成一个入口的话，用户在不知情的情况下改掉一批文件名。
   */
  onRenameSegment: (req: {
    oldSeg: string;
    count: number;
    submit: (newName: string) => Promise<boolean>;
  }) => void;
  /** 重新扫描当前目录 */
  onRefresh: () => void;
  /**
   * 当前选中的条目。**受控** —— 由 App 持有。
   *
   * 原本是这里的内部 state，但 mod+D（原版 OpenMarkdown）要编辑"当前选中的文件"，
   * 而快捷键注册在 App 层，拿不到组件内部状态。提升之后快捷键与界面共用同一份，
   * 不会出现"界面选中了 A、快捷键却说没选中"。
   */
  selected: ContentItem | null;
  onSelect: (item: ContentItem | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  /** #259 内容树右键菜单。存节点而不是 path —— 目录节点没有 ContentItem，只有 TreeNode。
   *  `depth` 一并存：skill 虚拟层改名要靠它算 `_` 段下标。 */
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode; depth: number } | null>(null);

  const tree = useMemo(() => {
    /*
     * #342 skill 名按 `_` 拆分层级：**在呈现层做**，不动后端 `rel_path`。
     * 改后端的话 `baseDirOf`（用 `path.endsWith(relPath)` 反推基目录）会失效，
     * 「打开 skill 目录」按钮从此一直置灰，而报错指不到这里。
     */
    const src = items.map((i) => (
      i.kind === 'skill' ? { ...i, relPath: skillTreeRelPath(i.relPath) } : i));
    const t = buildTree(src);
    fillDirPaths(t);
    return t;
  }, [items]);
  const counts = useMemo(() => ({
    agent: items.filter((i) => i.kind === 'agent').length,
    skill: items.filter((i) => i.kind === 'skill').length,
    rule: items.filter((i) => i.kind === 'rule').length,
  }), [items]);

  /*
   * 把"当前预览的是哪个文件"报给外面（mod+D 编辑快捷键要用）。
   *
   * **走 ref，不把 onSelect 放进依赖数组**：调用方多半传内联箭头函数
   * （`onSelect={(it) => setX(it)}`），放进依赖的话这个 effect 每次渲染都重跑，
   * 而它又会触发父组件 setState → **无限循环**。
   *
   * 为什么不用"要求调用方传稳定引用（useCallback）"：那是**靠约定的保证** ——
   * 谁都能在改调用方时顺手写成内联函数，于是界面突然卡死，
   * 而报错信息（"Maximum update depth exceeded"）指向不到这里。
   * ref 把它变成结构性保证：调用方怎么写都不会循环。
   */
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => { onSelectRef.current?.(null); setText(''); }, [root, kind]);

  /**
   * 某类资源的**实际基目录**（对应原版 OpenAgentDir / OpenSkillDir / OpenRuleDir）。
   *
   * 不能直接拼 `root/agents` —— 后端兼容单复数两种写法（`agent` / `agents`），
   * 拼错了打开的目录不存在，用户只看到一句报错却不知道为什么。
   * 从已有条目反推最可靠：`path` 以 `relPath` 结尾，掐掉剩下的就是基目录。
   * 该类一个条目都没有时返回 null（按钮置灰），比给个打不开的按钮强。
   */
  const baseDirOf = (k: 'agent' | 'skill' | 'rule'): string | null => {
    const it = items.find((i) => i.kind === k);
    if (!it?.relPath || !it.path.endsWith(it.relPath)) return null;
    const base = it.path.slice(0, it.path.length - it.relPath.length).replace(/[\\/]+$/, '');
    return base || null;
  };

  /** 取路径最后一段（带扩展名）。原版 CopyFileNameCommand 与 CopyNameCommand 是两个。 */
  const fileNameOf = (p: string): string => {
    const t = p.replace(/[\\/]+$/, '');
    return t.slice(Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')) + 1);
  };

  /** 走后端复制命令：沙箱 iframe 里 navigator.clipboard 会被静默拒绝（点了没反应也没报错）。 */
  const copy = (what: string, label: string) => {
    api.copyText(what).then(
      (ok) => onLog(ok ? `已复制${label}：${what}` : '复制失败', !ok),
      (e) => onLog(errText(e), true),
    );
  };

  /**
   * #259 / #260 内容树右键菜单（原版 AgentSkillViewModel 的七个命令）。
   *
   * **按节点类型显隐**，不是"全显示 + 点了报错"：
   *   · 打开文件 —— 仅文件叶子（目录型 skill 打开的是里面的 SKILL.md，见下一条）
   *   · 打开 SKILL.md —— 仅目录型 skill（`item.isDir`）
   *   · 重命名 —— 仅叶子。目录节点没有 ContentItem，后端改名是按条目走的，
   *     给它这一项只会是"点了报错"，不如不显示
   *
   * 原版 RightClickCommand 明确"仅高亮节点，不触发展开切换 / 预览副作用"——
   * 所以这里右键**不改选中态**：菜单直接作用于右键的那一个节点。
   * 若顺手 onSelect，会触发读文件（网络往返），右键一下就卡一下，且预览区莫名跳变。
   */
  const menuFor = (n: TreeNode, depth: number): MenuItem[] => {
    const out: MenuItem[] = [];
    const phys = n.path;
    const isDirSkill = !!n.item && n.item.isDir;
    const isFile = !!n.item && !n.item.isDir;
    /** skill 虚拟层文件夹：由名字里的 `_` 拆出来的中间节点，磁盘上不存在 */
    const isSkillFolder = !n.item && n.kind === 'skill';

    // 1 复制名称：叶子用去扩展名的显示名，目录用目录名（原版 CopyNameCommand）
    out.push({
      key: 'name',
      label: '复制名称',
      onClick: () => copy(n.item ? n.item.name : n.name, '名称'),
    });
    // 2 复制文件名（含扩展名）—— 与「复制名称」在 skill 目录下常常不一样，所以都留
    if (phys) {
      out.push({
        key: 'fn', label: '复制文件名', onClick: () => copy(fileNameOf(phys), '文件名'),
      });
    }
    // 3 复制完整路径
    if (phys) {
      out.push({ key: 'path', label: '复制路径', onClick: () => copy(phys, '路径') });
    }
    // 4 打开文件：仅文件叶子
    if (isFile && n.item) {
      out.push({
        key: 'open',
        label: '打开文件',
        onClick: () => api.openPath(n.item!.path, 'auto').catch((e) => onLog(errText(e), true)),
      });
    }
    // 5 打开 SKILL.md：仅目录型 skill。走 editFile —— 后端会做「目录 → SKILL.md」解析
    if (isDirSkill && n.item) {
      out.push({
        key: 'md',
        label: '打开 SKILL.md',
        onClick: () => api.editFile(n.item!.path).catch((e) => onLog(errText(e), true)),
      });
    }
    // 6 打开所在文件夹：目录开它自己，叶子定位到父目录并选中该文件
    if (phys) {
      out.push({
        key: 'dir',
        label: '打开所在文件夹',
        onClick: () => api.openPath(phys, isDirSkill || !n.item ? 'dir' : 'containing')
          .catch((e) => onLog(errText(e), true)),
      });
    }
    /*
     * 7 重命名（#343 分派）。
     *
     * 原版 RenameNode 四路分派：
     *   · skill 虚拟层文件夹 → 批量替换子树物理名里的 `_` 段
     *   · skill 目录型叶子   → 改目录整名
     *   · 其余叶子           → 改文件名（保留扩展名）
     *   · agent/rule 文件夹  → 改物理目录名
     *
     * **skill 虚拟层必须单独一路**：它磁盘上不存在，
     * 走"改目录名"会去改一个不存在的路径，报错还指不到原因。
     */
    if (isSkillFolder) {
      out.push({
        key: 'renameSeg',
        label: '重命名层级…',
        onClick: () => renameSegment(n, depth),
      });
    } else if (n.item) {
      out.push({
        key: 'rename',
        label: '重命名',
        onClick: () => onRename({ path: n.item!.path, name: n.item!.name }),
      });
    } else if (phys && n.kind !== 'skill') {
      // agent / rule 的文件夹：#345 回填过真实路径，可以直接改物理目录名
      out.push({ key: 'renameDir', label: '重命名', onClick: () => onRename({ path: phys, name: n.name }) });
    }
    return out;
  };

  /**
   * #213 skill 虚拟层改名（原版 RenameSkillSegment）。
   *
   * 段下标 = 节点深度（根层 0）。原版写的是 `folder.Depth - 1`，
   * 而它的 Depth 根层算 1 —— 两种记法差一个偏移，**照抄会全错一格**：
   * 点第 1 层却改了第 2 个 `_` 段，改完界面看似没变（因为层级没动对），
   * 而磁盘上已经改掉了不该改的段。
   */
  const renameSegment = (n: TreeNode, depth: number) => {
    const leaves = collectLeaves(n)
      .filter((l) => !!l.item)
      .map((l) => ({ path: l.item!.path, isDir: !!l.item!.isDir }));
    onRenameSegment({
      oldSeg: n.name,
      count: leaves.length,
      submit: async (newName: string) => {
        const { moves } = planSkillSegmentRename(leaves, depth, n.name, newName);
        if (moves.length === 0) {
          onLog('没有匹配的条目可改名（物理名里没有对应的 `_` 段）', true);
          return false;
        }
        try {
          const r = await api.renameSkillSegment(moves, newName);
          onLog(
            `已把层级「${n.name}」改为「${newName}」：${r.moved} 个条目`
            + (r.skipped > 0 ? `，跳过 ${r.skipped} 个` : ''),
          );
          onRefresh();
          return true;
        } catch (e) {
          onLog(errText(e), true);
          return false;
        }
      },
    });
  };

  const read = async (item: ContentItem) => {
    onSelect(item);
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
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: n, depth });
          }}
          /* #262 只高亮**叶子**，目录节点不高亮。

             这里的坑不是"要不要高亮目录"，而是**怎么判断**：
             原式 `selected?.path === n.item?.path` 在**还没选中任何东西时**
             两边都是 undefined —— `undefined === undefined` 为真，
             于是**所有目录节点会一起被判为选中**，整棵树刷成强调色。

             这类 bug 只在"什么都还没选"时出现，而那时用户刚打开、
             最容易以为"界面本来就这样"，根本不会意识到是错的。
             所以必须显式要求 selected 存在，再比路径。 */
          className={`fpx-node${selected && n.item && selected.path === n.item.path ? ' selected' : ''}`}
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
          onDoubleClick={() => {
            if (!n.item) return;
            /* 目录型 skill（#31）：双击要打开它里面的 SKILL.md，而不是目录本身。
               走 openPath 会在资源管理器里打开这层目录，用户还得自己再点进去
               找 SKILL.md —— 而"打开 skill"想看的本来就是那份文件。
               editFile 后端会做目录 → SKILL.md 的解析（见 fpx_edit_file）。 */
            const go = n.item.isDir
              ? api.editFile(n.item.path)
              : api.openPath(n.item.path, 'auto');
            go.catch((e) => onLog(errText(e), true));
          }}
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
            className={`p-btn sm${kind === k ? ' primary' : ''}`}
            
            onClick={() => onKind(k)}
          >
            {k === 'all' ? `全部 ${items.length}` : `${KIND_LABEL[k]} ${counts[k]}`}
          </button>
        ))}
        <button
          className="p-btn sm"
          
          disabled={!root}
          onClick={() => api.openPath(root, 'dir').catch((e) => onLog(errText(e), true))}
        >
          打开目录
        </button>
        {/* 三类目录直达（原版 OpenAgentDir / OpenSkillDir / OpenRuleDir）。
            目录不存时置灰而不是点了报错——不知道为什么打不开最让人困惑。 */}
        {(['agent', 'skill', 'rule'] as const).map((k) => {
          const dir = baseDirOf(k);
          return (
            <button
              key={k}
              className="p-btn sm"
              
              disabled={!dir}
              title={dir ? `打开 ${KIND_LABEL[k]} 目录：${dir}` : `该目录下没有 ${KIND_LABEL[k]}`}
              onClick={() => dir && api.openPath(dir, 'dir').catch((e) => onLog(errText(e), true))}
            >
              {KIND_LABEL[k]}目录
            </button>
          );
        })}
        <button
          className="p-btn sm"
          
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
              <button className="p-btn sm" 
                onClick={() => api.openPath(selected.path, 'containing').catch((e) => onLog(errText(e), true))}>
                所在目录
              </button>
              <button className="p-btn sm" 
                onClick={() => api.editFile(selected.path).catch((e) => onLog(errText(e), true))}>
                外部编辑
              </button>
              <button className="p-btn sm" 
                title="重命名该条目（文件保留扩展名）"
                onClick={() => onRename(selected)}>
                改名
              </button>
              {/* 沙箱内 navigator.clipboard 会被静默拒绝，走后端复制命令 */}
              <button className="p-btn sm" 
                title="复制条目名称"
                onClick={() =>
                  api.copyText(selected.name).then(
                    (ok) => onLog(ok ? `已复制名称：${selected.name}` : '复制失败', !ok),
                    (e) => onLog(errText(e), true),
                  )
                }>
                复制名
              </button>
              <button className="p-btn sm" 
                title="复制完整路径"
                onClick={() =>
                  api.copyText(selected.path).then(
                    (ok) => onLog(ok ? `已复制路径：${selected.path}` : '复制失败', !ok),
                    (e) => onLog(errText(e), true),
                  )
                }>
                复制路径
              </button>
              {/* 「复制名」给的是去扩展名的显示名；这个给磁盘上的真实文件名（带扩展名）。
                  两者在 skill 目录下常常不一样，所以都留着。 */}
              <button className="p-btn sm" 
                title="复制文件名（含扩展名，磁盘上的真实名字）"
                onClick={() => {
                  const fn = fileNameOf(selected.path);
                  api.copyText(fn).then(
                    (ok) => onLog(ok ? `已复制文件名：${fn}` : '复制失败', !ok),
                    (e) => onLog(errText(e), true),
                  );
                }}>
                复制文件名
              </button>
            </div>
          )}
        </div>
        <pre className="fpx-pre">{text || (selected ? '（空文件）' : '左侧点选一个条目查看内容')}</pre>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuFor(menu.node, menu.depth)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
