/**
 * 思维导图插件 · 左侧文件库面板
 * ============================================================
 * 画布左侧列出所有「脑图文件」，点击直接打开；可建文件夹，
 * 把文件拖进拖出文件夹做归类。
 *
 * 与既有「属性侧栏」（样式/标签/主题/文件）是两回事：
 *   · 属性侧栏作用于**当前选中的节点**
 *   · 本面板作用于**整个文档**，是切换编辑对象的入口
 *
 * 数据不在这里维护，全部通过 app.api 读写（见 index.js 的 files 一节），
 * 本模块只负责渲染与拖拽交互。
 */

import { h } from '../../js/plugin-sdk.js';

/**
 * 拖拽用的自定义 MIME。
 * 不能用 text/plain —— 页签拖拽排序已经在用它，两者数据会串。
 */
const DND = 'application/x-mm-file';

export function buildFileList(app) {
  const api = app.api;

  let dragId = null;      // 当前被拖动的文件 id

  const bodyEl = h('div.mm-files-body', {});
  const el = h('div.mm-files', {},
    h('div.mm-files-head', {},
      h('span.mm-files-title', {}, '脑图文件'),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button.mm-btn.icon', {
        title: '新建脑图文件',
        onclick: () => api.createFile(null),
      }, '＋'),
      h('button.mm-btn.icon', {
        title: '新建文件夹',
        onclick: () => api.createFolder(),
      }, '📁'),
    ),
    bodyEl,
  );

  /* ---------------------- 单个文件项 ---------------------- */

  function fileItem(f, active) {
    const it = h('div.mm-file-item' + (active ? '.active' : ''), {
      draggable: true,
      title: `${f.name}（可拖到文件夹里）`,
    },
      h('span.mm-file-ic', {}, '🧠'),
      h('span.mm-file-name', {}, f.name),
      h('span.mm-file-ops', {},
        h('button.mm-btn.icon.tiny', {
          title: '重命名',
          onclick: (e) => { e.stopPropagation(); api.renameFile(f.id); },
        }, '✎'),
        h('button.mm-btn.icon.tiny', {
          title: '删除',
          onclick: (e) => { e.stopPropagation(); api.deleteFile(f.id); },
        }, '✕'),
      ),
    );

    it.addEventListener('click', () => api.openFile(f.id));

    it.addEventListener('dragstart', (e) => {
      dragId = f.id;
      it.classList.add('dragging');
      try {
        e.dataTransfer?.setData(DND, f.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      } catch { /* 某些环境不允许写 dataTransfer，靠模块内 dragId 兜底 */ }
    });
    it.addEventListener('dragend', () => {
      dragId = null;
      it.classList.remove('dragging');
      for (const z of bodyEl.querySelectorAll('.drop-on')) z.classList.remove('drop-on');
    });

    return it;
  }

  /* ---------------------- 放置目标 ---------------------- */

  /**
   * 让 target 成为放置区。
   * folderId 为 null 表示「根目录」（把文件移出文件夹）。
   */
  function asDropZone(target, folderId) {
    target.addEventListener('dragover', (e) => {
      // 只接受本面板里的文件拖拽，避免页签拖拽误落进来
      const types = e.dataTransfer?.types;
      if (types && ![...types].includes(DND) && !dragId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      target.classList.add('drop-on');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-on'));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('drop-on');
      let id = dragId;
      try { id = e.dataTransfer?.getData(DND) || id; } catch { /* 忽略 */ }
      if (!id) return;
      api.moveFile(id, folderId);
    });
    return target;
  }

  /* ---------------------- 渲染 ---------------------- */

  function refresh() {
    const { files, folders, currentId } = api.fileState();
    bodyEl.innerHTML = '';

    // 根目录：既是列表也是「移出文件夹」的放置区
    const rootFiles = files.filter((f) => !f.folderId);
    const rootZone = asDropZone(h('div.mm-file-group', {}), null);
    if (!rootFiles.length) {
      rootZone.appendChild(h('div.mm-hint', {}, '（根目录为空）'));
    } else {
      for (const f of rootFiles) rootZone.appendChild(fileItem(f, f.id === currentId));
    }
    bodyEl.appendChild(rootZone);

    for (const fo of folders) {
      const inIt = files.filter((f) => f.folderId === fo.id);
      const collapsed = !!fo.collapsed;

      const header = asDropZone(h('div.mm-folder-head', {
        onclick: () => api.toggleFolder(fo.id),
      },
        h('span.mm-file-ic', {}, collapsed ? '▸' : '▾'),
        h('span.mm-file-ic', {}, '📁'),
        h('span.mm-file-name', {}, fo.name),
        h('span.mm-file-count', {}, String(inIt.length)),
        h('span.mm-file-ops', {},
          h('button.mm-btn.icon.tiny', {
            title: '重命名文件夹',
            onclick: (e) => { e.stopPropagation(); api.renameFolder(fo.id); },
          }, '✎'),
          h('button.mm-btn.icon.tiny', {
            title: '删除文件夹（里面的文件移到根目录）',
            onclick: (e) => { e.stopPropagation(); api.deleteFolder(fo.id); },
          }, '✕'),
        ),
      ), fo.id);

      const block = h('div.mm-folder', {}, header);
      if (!collapsed) {
        const inner = h('div.mm-file-group', {});
        if (!inIt.length) inner.appendChild(h('div.mm-hint', {}, '（空）'));
        else for (const f of inIt) inner.appendChild(fileItem(f, f.id === currentId));
        block.appendChild(inner);
      }
      bodyEl.appendChild(block);
    }

    if (!files.length && !folders.length) {
      bodyEl.appendChild(h('div.mm-hint', {}, '还没有脑图文件，点 ＋ 新建'));
    }
  }

  function setOpen(on) {
    el.classList.toggle('open', !!on);
  }

  return { el, refresh, setOpen };
}
