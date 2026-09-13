/**
 * 思维导图插件 · 侧栏页面与对话框
 * ============================================================
 * 对应 C# 版 MindMapPanel 的四个侧栏页（文件 / 样式 / 标签 / 主题），
 * 外加自定义主题编辑器、视频播放、备份恢复三个浮层。
 *
 * 所有面板只依赖传入的 app 句柄，不直接持有状态：
 *   app.bridge    编辑器桥接
 *   app.api       插件层能力（状态栏提示 / 提交变更 / 取选中节点…）
 *   app.sheet     当前画布
 */

import { h } from '../../js/plugin-sdk.js';
import { THEMES, LAYOUTS, blankTheme } from './themes.js';
import * as io from './io.js';
import * as store from './store.js';

const FONTS = ['微软雅黑', '宋体', '黑体', '楷体', 'Arial', 'Consolas', 'sans-serif'];
const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40];
const RADII = [0, 3, 5, 8, 12, 16, 24];
const WIDTHS = [1, 2, 3, 4, 6];

/* --------------------------- 小组件 --------------------------- */

function section(title, ...children) {
  return h('div.mm-field', {}, h('h3', {}, title), ...children);
}

function colorRow(label, value, onPick, onClear) {
  const inp = h('input', {
    type: 'color',
    value: value || '#4A90D9',
    style: { position: 'absolute', inset: '0', opacity: '0', width: '100%', height: '100%', cursor: 'pointer' },
    oninput: (e) => onPick(e.target.value),
  });
  const sw = h('button.mm-swatch', {
    style: { background: value || '#4A90D9', position: 'relative' },
    title: label,
    onclick: () => inp.click(),
  }, inp);
  return h('div.mm-row', {},
    h('span.mm-label', { style: { minWidth: '48px' } }, label),
    sw,
    onClear ? h('button.mm-btn.icon', { onclick: onClear, title: `清除${label}` }, '✕') : null,
  );
}

function chips(items, current, onPick) {
  return h('div.mm-grid', {},
    ...items.map((it) =>
      h('button.mm-chip' + (String(current) === String(it.v) ? '.on' : ''), {
        onclick: () => onPick(it.v),
        title: it.t || String(it.v),
      }, it.t || String(it.v))),
  );
}

/* =========================== 侧栏主体 =========================== */

export function buildSide(app) {
  const pages = {};
  let current = null;

  const body = h('div.mm-side', {});
  const el = body;

  function open(page) {
    if (current === page) { close(); return; }
    current = page;
    body.classList.add('open');
    body.innerHTML = '';
    body.appendChild(pages[page]());
  }

  function close() {
    current = null;
    body.classList.remove('open');
    body.innerHTML = '';
  }

  function refresh() {
    if (current) {
      body.innerHTML = '';
      body.appendChild(pages[current]());
    }
  }

  pages.file = pageFile;
  pages.style = pageStyle;
  pages.tag = pageTag;
  pages.theme = pageTheme;

  /* ------------------------- 文件页 ------------------------- */

  function pageFile() {
    const ref = app.api.selectedRef('file');
    const vref = app.api.selectedRef('video');
    const info = h('div.mm-hint', {}, ref ? `已附加：${ref.n || '未命名'}（${io.formatSize(ref.s)}）` : '当前节点未附加文件');
    const vinfo = h('div.mm-hint', {}, vref ? `已附加视频：${vref.n || '未命名'}` : '当前节点未附加视频');

    const attach = async (kind) => {
      const f = await io.pickFile(kind === 'video' ? 'video/*' : '');
      if (!f) return;
      const id = await io.putAsset(f);
      if (!id) { app.api.status('附件保存失败', true); return; }
      const payload = io.encodeRef({ n: f.name, a: id, s: f.size });
      app.bridge[kind === 'video' ? 'setVideo' : 'setFile'](payload);
      app.api.commit();
      refresh();
    };

    const openOne = async (kind) => {
      const r = app.api.selectedRef(kind);
      if (!r?.a) { app.api.status('该附件来自旧版路径，无法在沙箱内打开', true); return; }
      const asset = await io.getAsset(r.a);
      if (!asset?.blob) { app.api.status('附件数据已丢失', true); return; }
      // 下载走的是 blob，不需要 URL；getAsset 顺手建的那个必须释放掉
      if (asset.url) URL.revokeObjectURL(asset.url);
      io.downloadBlob(asset.name || r.n || '附件', asset.blob);
    };

    const remove = (kind) => {
      app.bridge[kind === 'video' ? 'setVideo' : 'setFile'](null);
      app.api.commit();
      refresh();
    };

    const play = async () => {
      const r = app.api.selectedRef('video');
      if (!r?.a) { app.api.status('未附加视频', true); return; }
      const asset = await io.getAsset(r.a);
      if (!asset?.url) { app.api.status('视频数据已丢失', true); return; }
      openVideo(app, asset);
    };

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section('文件附件',
        info,
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: () => attach('file') }, '附加文件…'),
          h('button.mm-btn', { onclick: () => openOne('file'), disabled: !ref?.a }, '下载'),
          h('button.mm-btn', { onclick: () => remove('file'), disabled: !ref }, '移除'),
        ),
      ),
      section('视频附件',
        vinfo,
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: () => attach('video') }, '附加视频…'),
          h('button.mm-btn', { onclick: play, disabled: !vref?.a }, '播放'),
          h('button.mm-btn', { onclick: () => remove('video'), disabled: !vref }, '移除'),
        ),
      ),
      section('备份与恢复',
        h('div.mm-hint', {}, '实时缓存已开启（自动写入本地库）。这里管理历史快照，闪退或从备份回退时用。'),
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: () => app.api.backupNow() }, '立即备份'),
          h('button.mm-btn', { onclick: () => openBackups(app) }, '历史快照…'),
        ),
        h('div.mm-row', { style: { marginTop: '2px' } },
          h('span.mm-label', {}, '自动间隔'),
          h('select.mm-select', {
            onchange: (e) => { app.api.setBackupMinutes(Number(e.target.value)); refresh(); },
          }, ...[0, 1, 2, 5, 10, 30].map((m) =>
            h('option', { value: m, selected: Number(app.settings?.backupMinutes ?? 2) === m },
              m === 0 ? '关闭' : `${m} 分钟`))),
        ),
        h('div.mm-hint', {}, '到点才比对一次；内容与最新快照相同则不写盘，避免空转。'),
      ),

      section('布局动画',
        h('div.mm-row', {},
          h('button.mm-btn' + (app.settings?.animate ? '.on' : ''), {
            onclick: () => { app.api.setAnimate(!app.settings?.animate); refresh(); },
          }, app.settings?.animate ? '已开启' : '已关闭'),
        ),
        h('div.mm-hint', {}, '开启后打开画布、展开/收起分支会播 300ms 过渡动画；关闭则直接显示最终布局。'),
      ),
      section('导入导出',
        h('div.mm-hint', {}, '导出为文件是主要存档方式。XMind 与官方互通（多画布、主题、外框、附件一并打包，换机可还原）；JSON 保留全部私有字段；Markdown 便于人读。'),
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: () => app.api.exportJson() }, '导出 JSON'),
          h('button.mm-btn', { onclick: () => app.api.exportMarkdown() }, '导出 MD'),
          h('button.mm-btn', { onclick: () => app.api.importFile() }, '导入…'),
        ),
      ),
    );
  }

  /* ------------------------- 样式页 ------------------------- */

  function pageStyle() {
    const st = app.api.nodeStyle();
    const set = (patch) => {
      app.bridge.setNodeStyle(patch);
      app.api.commit();
      refresh();
    };

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section('节点填充',
        colorRow('填充', st.fill, (v) => set({ fill: v }), () => set({ fill: null })),
      ),
      section('节点边框',
        colorRow('描边', st.stroke, (v) => set({ stroke: v }), () => set({ stroke: null })),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '线宽'),
          ...WIDTHS.map((w) => h('button.mm-chip' + (Number(st.strokeWidth) === w ? '.on' : ''), {
            onclick: () => set({ strokeWidth: w }),
          }, String(w))),
        ),
      ),
      section('连线',
        colorRow('连线', st.lineColor, (v) => set({ lineColor: v }), () => set({ lineColor: null })),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '线宽'),
          ...WIDTHS.map((w) => h('button.mm-chip' + (Number(st.lineWidth) === w ? '.on' : ''), {
            onclick: () => set({ lineWidth: w }),
          }, String(w))),
        ),
      ),
      section('圆角',
        h('div.mm-row', {},
          ...RADII.map((r) => h('button.mm-chip' + (Number(st.radius) === r ? '.on' : ''), {
            onclick: () => set({ radius: r }),
          }, String(r))),
        ),
      ),
      section('样式刷',
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: () => { app.bridge.copyNodeStyle(); app.api.status('已复制节点样式'); },
            title: '复制选中节点的全部节点级样式到内存剪贴板',
          }, '复制样式'),
          h('button.mm-btn', {
            onclick: () => { app.bridge.pasteNodeStyle(); app.api.commit(); app.api.status('已粘贴节点样式'); },
            title: '把剪贴板里的样式贴到当前选中节点',
          }, '粘贴样式'),
        ),
        h('div.mm-hint', {}, '快捷键 Ctrl+Shift+C / Ctrl+Shift+V（编辑器内置）。剪贴板仅本次会话有效。'),
      ),
      section('清除样式',
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: () => { app.bridge.clearNodeStyle('text'); app.api.commit(); refresh(); } }, '文字'),
          h('button.mm-btn', { onclick: () => { app.bridge.clearNodeStyle('node'); app.api.commit(); refresh(); } }, '节点'),
          h('button.mm-btn', { onclick: () => { app.bridge.clearNodeStyle('border'); app.api.commit(); refresh(); } }, '边框'),
          h('button.mm-btn', { onclick: () => { app.bridge.clearNodeStyle('line'); app.api.commit(); refresh(); } }, '连线'),
        ),
        h('button.mm-btn', {
          style: { marginTop: '4px' },
          onclick: () => {
            for (const s of ['text', 'node', 'border', 'line']) app.bridge.clearNodeStyle(s);
            app.api.commit();
            refresh();
          },
        }, '清除全部样式'),
      ),
    );
  }

  /* ------------------------- 标签页 ------------------------- */

  function pageTag() {
    const items = [];
    for (let i = 1; i <= 9; i++) items.push({ v: i, t: String(i) });

    const pickImage = async () => {
      const f = await io.pickFile('image/*');
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) app.api.status('图片超过 2MB，会让脑图文件明显变大', true);
      const url = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => res(null);
        fr.readAsDataURL(f);
      });
      if (!url) { app.api.status('图片读取失败', true); return; }
      app.bridge.setImage(url);
      app.api.commit();
    };

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section('优先级',
        chips(items, null, (v) => { app.bridge.exec('priority', v); app.api.commit(); }),
        h('button.mm-btn', { onclick: () => { app.bridge.exec('priority', 0); app.api.commit(); } }, '清除优先级'),
      ),
      section('进度',
        chips(items, null, (v) => { app.bridge.exec('progress', v); app.api.commit(); }),
        h('button.mm-btn', { onclick: () => { app.bridge.exec('progress', 0); app.api.commit(); } }, '清除进度'),
      ),
      section('图标',
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: pickImage }, '浏览图片…'),
          h('button.mm-btn', { onclick: () => { app.bridge.setImage(null); app.api.commit(); } }, '清除图标'),
        ),
        h('div.mm-hint', {}, '图片以 dataURL 内联进脑图，随文件一起导出；建议控制在 2MB 内。'),
      ),
      section('超链接',
        h('input.mm-input', {
          placeholder: 'https://…（清空后回车移除）',
          onchange: (e) => {
            const v = e.target.value.trim();
            app.bridge.setHyperlink(v || null);
            app.api.commit();
          },
        }),
      ),
      section('备注',
        h('input.mm-input', {
          placeholder: '节点备注（清空后回车移除）',
          onchange: (e) => {
            const v = e.target.value.trim();
            app.bridge.setNote(v || null);
            app.api.commit();
          },
        }),
      ),
    );
  }

  /* ------------------------- 主题页 ------------------------- */

  function pageTheme() {
    const cur = app.sheet?.theme || 'fresh-blue';
    const curLayout = app.sheet?.layout || 'default';

    const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      ...THEMES.map((t) =>
        h('button.mm-theme' + (cur === t.value ? '.on' : ''), {
          onclick: () => { app.api.applyTheme(t.value); refresh(); },
        },
          h('span.dot', { style: { background: t.root } }),
          h('span.name', {}, t.label),
        )),
      ...(app.customThemes || []).map((t) =>
        h('div.mm-theme' + (cur === t.id ? '.on' : ''), {},
          h('span.dot', { style: { background: t.palette?.rootBackground || '#4A90D9' }, onclick: () => { app.api.applyTheme(t.id); refresh(); } }),
          h('span.name', { onclick: () => { app.api.applyTheme(t.id); refresh(); } }, t.name || t.id),
          h('button.mm-btn.icon', { onclick: () => { openThemeEditor(app, t); }, title: '编辑' }, '✎'),
          h('button.mm-btn.icon', {
            onclick: async () => {
              app.customThemes = (app.customThemes || []).filter((x) => x.id !== t.id);
              await app.api.saveThemes();
              refresh();
            },
            title: '删除',
          }, '✕'),
        )),
    );

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section('配色主题',
        list,
        h('button.mm-btn', { onclick: () => openThemeEditor(app, null) }, '＋ 新建自定义主题'),
      ),
      section('布局模板',
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          ...LAYOUTS.map((l) =>
            h('button.mm-theme' + (curLayout === l.value ? '.on' : ''), {
              onclick: () => { app.api.applyLayout(l.value); refresh(); },
            }, h('span.name', {}, l.label))),
        ),
      ),
      section('视图',
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: () => { app.bridge.exec('arrange'); app.api.commit(); } }, '整理布局'),
          h('button.mm-btn', { onclick: () => { app.bridge.expandToLevel(1); app.api.commit(); } }, '展开一级'),
          h('button.mm-btn', { onclick: () => { app.bridge.expandToLevel(2); app.api.commit(); } }, '二级'),
          h('button.mm-btn', { onclick: () => { app.bridge.expandToLevel(0); app.api.commit(); } }, '全部'),
        ),
      ),
    );
  }

  return { el, open, close, refresh, isOpen: () => !!current, current: () => current };
}

/* =========================== 浮层 =========================== */

/**
 * 通用浮层。
 * @param onClose 关闭时的清理钩子：点遮罩、点关闭按钮、外部调 close() 都会触发，
 *   用于释放 Blob URL 之类的一次性资源。
 */
function dialog(title, children, onClose) {
  const mask = h('div.mm-mask', {});
  let cleaned = false;
  const close = () => {
    if (cleaned) return;
    cleaned = true;
    mask.remove();
    try { onClose?.(); } catch { /* 清理失败不该拦住关闭 */ }
  };
  mask.appendChild(
    h('div.mm-dialog', {},
      h('h3', {}, title),
      ...children,
      h('div.mm-actions', {}, h('button.mm-btn', { onclick: close }, '关闭')),
    ),
  );
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.body.appendChild(mask);
  return { mask, close };
}

/** 自定义主题编辑器 */
export function openThemeEditor(app, theme) {
  const editing = theme ? JSON.parse(JSON.stringify(theme)) : blankTheme('th' + Math.random().toString(36).slice(2, 10), '自定义主题');
  const p = editing.palette || (editing.palette = {});

  const rows = [
    ['背景', 'background'], ['文字色', 'textColor'], ['选中色', 'selectedColor'],
    ['连线色', 'connectColor'], ['根节点底色', 'rootBackground'],
    ['主干底色', 'mainBackground'], ['分支底色', 'subBackground'],
  ];

  const nameInput = h('input.mm-input', { value: editing.name || '', placeholder: '主题名称' });

  const save = async () => {
    editing.name = nameInput.value.trim() || '自定义主题';
    const ok = app.bridge.registerTheme(editing);
    if (!ok) { app.api.status('主题注册失败（编辑器未就绪？）', true); return; }
    const list = (app.customThemes || []).filter((x) => x.id !== editing.id);
    list.push(editing);
    app.customThemes = list;
    await app.api.saveThemes();
    app.api.applyTheme(editing.id);
    dlg.close();
    app.api.toast('主题已保存并应用', 'ok');
  };

  const dlg = dialog(theme ? '编辑主题' : '新建主题', [
    h('div.mm-field', {}, h('span.mm-label', {}, '名称'), nameInput),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      ...rows.map(([label, key]) => {
        let input;
        const sw = h('button.mm-swatch', {
          style: { background: p[key] || '#4A90D9', position: 'relative' },
          onclick: () => input.click(),
        });
        input = h('input', {
          type: 'color',
          value: p[key] || '#4A90D9',
          style: { position: 'absolute', inset: '0', opacity: '0', width: '100%', height: '100%', cursor: 'pointer' },
          oninput: (e) => {
            p[key] = e.target.value;
            sw.style.background = e.target.value;
          },
        });
        sw.appendChild(input);
        return h('div.mm-row', {}, h('span.mm-label', { style: { minWidth: '88px' } }, label), sw,
          h('span.mm-hint', {}, p[key] || ''));
      }),
    ),
    h('div.mm-actions', {}, h('button.mm-btn.primary', { onclick: save }, '保存并应用')),
  ]
  );
  return dlg;
}

/**
 * 视频播放浮层：直接用原生 <video controls>，进度条/音量/全屏由浏览器提供。
 * 关闭时释放 Blob URL —— getAsset() 每次调用都会新建一个，不释放就是内存泄漏
 * （反复点开附件会一直堆积）。
 */
export function openVideo(app, asset) {
  const v = h('video.mm-video', { src: asset.url, controls: true, autoplay: true });
  const release = () => { if (asset.url) URL.revokeObjectURL(asset.url); };
  return dialog(`播放：${asset.name || '视频'}`, [v], release);
}

/** 图片附件预览浮层（点节点图标时，图片比直接下载更直观） */
export function openPreview(app, asset) {
  const img = h('img.mm-preview', { src: asset.url, alt: asset.name || '附件' });
  const save = h('button.mm-btn', {
    onclick: () => io.downloadBlob(asset.name || '附件', asset.blob),
  }, '另存为');
  const release = () => { if (asset.url) URL.revokeObjectURL(asset.url); };
  return dialog(`预览：${asset.name || '附件'}`, [h('div', {}, img, h('div.mm-actions', {}, save))], release);
}

/** 历史快照列表 */
export async function openBackups(app) {
  const list = await store.listBackups();
  const box = h('div.mm-list', {});

  const render = async () => {
    box.innerHTML = '';
    const items = await store.listBackups();
    if (!items.length) {
      box.appendChild(h('div.mm-hint', {}, '暂无快照'));
      return;
    }
    for (const b of items) {
      box.appendChild(
        h('div.mm-item', {},
          h('span.name', {}, `${new Date(b.ts).toLocaleString()} · ${(b.sheets || []).length} 张画布`),
          h('button.mm-btn.icon', {
            onclick: async () => {
              if (b.sheets) await app.api.restoreBackup(b);
              dlg.close();
            },
          }, '恢复'),
        ),
      );
    }
  };
  await render();

  const dlg = dialog('历史快照', [
    h('div.mm-hint', {}, `按时间倒序，最多保留 ${store.BACKUP_KEEP} 份。恢复会覆盖当前所有画布。`),
    box,
    h('div.mm-actions', {},
      h('button.mm-btn', { onclick: async () => { await app.api.backupNow(); await render(); } }, '立即备份'),
      h('button.mm-btn', { onclick: async () => { await store.clearBackups(); await render(); } }, '清空快照'),
    ),
  ]
  );
  return dlg;
}
