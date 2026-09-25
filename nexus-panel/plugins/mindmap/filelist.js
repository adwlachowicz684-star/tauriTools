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
  // 搜索结果区与文件列表**共用同一个底框**（同一个 .mm-files 容器、
  // 同样 186px 宽），两者互斥显示 —— 尺寸天然一致，不用另写一套面板样式
  const searchBodyEl = h('div.mm-files-body', { style: { display: 'none' } });

  const titleEl = h('span.mm-files-title', {}, '脑图文件');
  const newFileBtn = h('button.mm-btn.icon', {
    title: '新建脑图文件',
    onclick: () => api.createFile(null),
  }, '＋');
  const newFolderBtn = h('button.mm-btn.icon', {
    title: '新建文件夹',
    onclick: () => api.createFolder(),
  }, '📁');

  const el = h('div.mm-files', {},
    h('div.mm-files-head', {},
      titleEl,
      h('span', { style: { flex: '1 1 auto' } }),
      newFileBtn,
      newFolderBtn,
    ),
    bodyEl,
    searchBodyEl,
  );

  /* ---------------------- 搜索结果模式 ---------------------- */

  // 两个**独立**面板共用一个底框，同一时刻只有一个占着它：
  //   'files'  → 文件列表
  //   'search' → 搜索结果
  //   null     → 底框收起
  //
  // 不能用「搜索时把文件列表藏起来、取消搜索再放回来」那种单标志做法 ——
  // 那样两者是"替代"关系而不是"两个页签"，收起文件后没法退回搜索结果。
  let panel = null;
  // 是否有**有效**搜索结果。收起搜索面板后仍保留 —— 用户再次收起文件时
  // 要能退回搜索结果，而不是直接把整个底框关掉。
  let hasSearch = false;

  let searchItems = [];
  let searchKw = '';
  let searchTotal = 0;
  let searchActive = 0;

  /** 把 panel 落到 DOM 上：底框开合 + 两个 body 互斥 + 标题与按钮随面板切换 */
  function apply() {
    const p = panel;
    el.classList.toggle('open', !!p);
    bodyEl.style.display = p === 'files' ? '' : 'none';
    searchBodyEl.style.display = p === 'search' ? '' : 'none';

    const isSearch = p === 'search';
    // 切回文件列表时先补一次重建：搜索期间跳过的 refresh 会留下过期内容
    if (p === 'files' && filesDirty) refresh();
    // 标题与「＋ / 📁」随面板切换：搜索结果页没有"新建脑图"的语义，
    // 留着两个按钮会出现"点了没反应"（它们建的仍是文件，但页面不是文件列表）
    titleEl.textContent = isSearch
      ? `搜索结果 ${Number(searchTotal) || searchItems.length} 项`
      : '脑图文件';
    newFileBtn.style.display = isSearch ? 'none' : '';
    newFolderBtn.style.display = isSearch ? 'none' : '';
  }

  /**
   * 打开 / 关闭**文件**面板。
   *
   * 关掉文件时若还有搜索结果，就退回搜索结果 —— 这正是"两个独立页签
   * 共用一个底框"该有的行为：收起一个，底下那个露出来。
   * （原来是直接把整个底框关掉，搜索结果就这么丢了。）
   */
  function showFiles(on) {
    panel = on ? 'files' : (hasSearch ? 'search' : null);
    apply();
  }

  /** 点 📚：当前是文件就收起（有搜索则退回搜索），否则切到文件 */
  function toggleFiles() {
    showFiles(panel !== 'files');
    return panel === 'files';
  }

  /**
   * 渲染搜索结果条目。
   *
   * 命中片段用 <mark> 高亮，但**全程用文本节点构造，不拼 innerHTML** ——
   * 节点文字是用户输入，含 `<img onerror=...>` 时拼字符串就是 XSS。
   */
  function renderSearchItems() {
    searchBodyEl.innerHTML = '';
    const kw = String(searchKw || '').toLowerCase();
    if (!searchItems.length) {
      searchBodyEl.appendChild(h('div.mm-hint', {}, '没有匹配的节点'));
      return;
    }
    searchItems.forEach((text, i) => {
      const item = h('div.mm-search-item' + (i === searchActive ? '.active' : ''), {
        onclick: () => jumpTo(i),
        title: text,
      });
      const src = String(text ?? '');
      const low = src.toLowerCase();
      let pos = 0;
      // kw 为空时绝不能进 indexOf('') 的循环 —— 那是死循环
      if (kw) {
        let hit;
        while ((hit = low.indexOf(kw, pos)) !== -1) {
          if (hit > pos) item.appendChild(document.createTextNode(src.slice(pos, hit)));
          item.appendChild(h('mark', {}, src.slice(hit, hit + kw.length)));
          pos = hit + kw.length;
        }
      }
      if (pos < src.length) item.appendChild(document.createTextNode(src.slice(pos)));
      searchBodyEl.appendChild(item);
    });
  }

  /** 点条目 → 定位到该节点 */
  function jumpTo(i) {
    const ok = app.bridge?.gotoSearchResult(i);
    // 定位失败多半是内容变了、旧索引已失效。这时**不要**假装成功，
    // 否则高亮停在旧项上，用户会以为跳过去的就是这一条。
    if (!ok) { api.status('定位失败：结果已失效，请重新搜索', true); return; }
    searchActive = i;
    renderSearchItems();
  }

  /**
   * 切到搜索结果 / 退出。
   *
   * @param {object|null} res `{kw,total,active,items}`；null 或空列表 = 退出
   */
  function setSearch(res) {
    const items = res?.items;
    const has = Array.isArray(items) && items.length > 0;

    if (!has) {
      // 本来就没有搜索结果、也没占着底框 —— 别白重建一次
      if (!hasSearch && panel !== 'search') return;
      hasSearch = false;
      searchItems = [];
      searchKw = '';
      searchTotal = 0;
      // 真的清空 DOM，不能只靠 display:none —— 残留条目占内存，
      // 且任何按 .mm-search-item 查询的逻辑都会查到上一轮的旧结果
      searchBodyEl.innerHTML = '';
      // 退出搜索：让位给文件列表（若用户开着它），否则整个底框收起
      if (panel === 'search') panel = app.settings?.filesOpen ? 'files' : null;
      apply();
      return;
    }

    hasSearch = true;
    searchItems = items;
    searchKw = String(res.kw || '');
    // 标题显示**真实总数**（编辑器侧超过 200 条只回传前 200 条）
    searchTotal = Number(res.total) || items.length;
    searchActive = Number(res.active) || 0;
    renderSearchItems();
    // 搜索结果出来就占住底框 —— 文件库默认收起，结果藏在收起的框里等于没显示
    panel = 'search';
    apply();
  }

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

  /*
   * 文件列表因为「搜索态下被藏起来了」而跳过重建时，要**记一笔账**。
   *
   * 原实现是直接 return，理由写的是"重建纯属白费（还会把搜索区挤下去）"。
   * 后半句不成立：搜索态下 bodyEl 是 display:none（apply() 里设的），
   * 往里追加子节点不会影响任何可见布局。
   *
   * 真正的问题在**另一头**：跳过期间如果文件有增删/改名/切换当前文件，
   * 之后 showFiles(true) 只做 apply()（切 display），不会重建 ——
   * 于是用户切回文件列表看到的是**过期内容**：
   * 新建的文件不在、删掉的还在、高亮停在切换前的那个文件上。
   * 而 setSearch(null) 那条路径同样会把 panel 置回 'files' 且不重建。
   */
  let filesDirty = false;

  function refresh() {
    if (panel === 'search') { filesDirty = true; return; }
    filesDirty = false;
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

  return {
    el, refresh, setSearch,
    showFiles, toggleFiles,
    isSearchMode: () => panel === 'search',
    isFilesPanel: () => panel === 'files',
    isOpen: () => !!panel,
    /**
     * 是否**还留有**搜索结果（哪怕当前被文件列表盖着）。
     *
     * 必须和 isSearchMode() 分开：那个问的是"当前占着底框的是不是搜索"，
     * 这个问的是"有没有结果可退回"。两者不同 —— 搜索出结果后点 📚，
     * 底框归文件列表，此时 isSearchMode() 是 false 但结果**还在**。
     * 混用的话"再点一次就退回搜索结果"这件事就讲不出来了。
     */
    hasSearchResults: () => hasSearch,
  };
}
