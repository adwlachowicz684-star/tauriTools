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
import * as mi from './mediainfo.js';

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

/**
 * 面板内部异步兜底：与 index.js 的 guard() 同职责。
 * 面板层是独立模块，拿不到 index.js 里那个，这里自备一个 ——
 * onclick 拿不到 Promise，失败必须转成状态栏提示，否则界面毫无反应。
 */
function safe(label, fn, onErr) {
  return (...args) => {
    let r;
    try {
      r = fn(...args);
    } catch (e) {
      onErr(`${label}失败：${e?.message || e}`);
      return undefined;
    }
    if (r && typeof r.then === 'function') {
      return r.catch((e) => { onErr(`${label}失败：${e?.message || e}`); });
    }
    return r;
  };
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
    body.dataset.page = page;      // 标记当前页，便于外部（含测试）判断侧栏停在哪个页
    body.innerHTML = '';
    body.appendChild(pages[page]());
  }

  function close() {
    current = null;
    body.classList.remove('open');
    delete body.dataset.page;
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

  /**
   * 附件元信息表。
   * 名称/大小来自节点引用（同步可得），类型与修改时间在资产库里，
   * 视频还要解析文件头 —— 所以整块先占位，异步填完再局部更新，
   * 不阻塞面板首次渲染。
   */
  function metaRow(k, v) {
    const val = v == null || v === '' ? '—' : String(v);
    return h('div.mm-meta-row', {},
      h('span.mm-meta-k', {}, k),
      h('span.mm-meta-v', { title: val }, val));
  }

  function fillMeta(box, rows, empty) {
    box.innerHTML = '';
    if (!rows) {
      box.appendChild(h('div.mm-hint', {}, empty));
      return;
    }
    for (const [k, v] of rows) box.appendChild(metaRow(k, v));
  }

  /** 文件信息：名称 / 大小 / 类型 / 修改时间 */
  async function fillFileMeta(ref, box) {
    if (!ref) { fillMeta(box, null, '当前节点未附加文件'); return; }
    fillMeta(box, [['名称', ref.n], ['大小', io.formatSize(ref.s)]], '');

    if (!ref.a) {
      // C# 版迁移过来的纯路径引用：拿不到本体，也就没有类型与修改时间
      box.appendChild(h('div.mm-hint', {}, '旧版本地路径，沙箱内读不到文件本体'));
      return;
    }
    const a = await io.getAsset(ref.a);          // 只要元信息，不建 URL
    if (!a) {
      box.appendChild(h('div.mm-hint', {}, '附件数据已丢失（可重新附加一次）'));
      return;
    }
    fillMeta(box, [
      ['名称', ref.n],
      ['大小', io.formatSize(a.size ?? ref.s)],
      ['类型', mi.shortType(a.type, ref.n)],
      ['修改', mi.formatDateTime(a.mtime || a.addedAt)],
    ], '');
  }

  /**
   * 视频元信息：分辨率 / 帧率 / 比特率 / 视频编码 / 音频编码 / 时长。
   * 浏览器只给得出时长与分辨率，帧率和编解码器必须解容器，
   * 所以走 mediainfo.probeVideo；结果写回资产库，下次打开直接读。
   */
  async function fillVideoMeta(vref, box) {
    if (!vref) { fillMeta(box, null, '当前节点未附加视频'); return; }
    fillMeta(box, [['名称', vref.n], ['大小', io.formatSize(vref.s)]], '');

    if (!vref.a) {
      box.appendChild(h('div.mm-hint', {}, '旧版本地路径，沙箱内读不到文件本体'));
      return;
    }
    const a = await io.getAsset(vref.a);          // 只要元信息，不建 URL
    if (!a) {
      box.appendChild(h('div.mm-hint', {}, '视频数据已丢失（可重新附加一次）'));
      return;
    }

    let meta = a.meta;
    if (!meta) {
      box.appendChild(h('div.mm-hint', {}, '正在解析媒体信息…'));
      meta = await mi.probeVideo(a.blob);
      await io.saveAssetMeta(vref.a, meta);       // 缓存，避免每次开面板都解析
    }

    const w = meta.width || 0;
    const h_ = meta.height || 0;
    const vcodec = [meta.videoCodec, meta.videoCodecDetail ? `(${meta.videoCodecDetail})` : '']
      .filter(Boolean).join(' ') || '—';
    const acodecParts = [meta.audioCodec, mi.formatChannels(meta.audioChannels)];
    if (meta.audioSampleRate) acodecParts.push(`${(meta.audioSampleRate / 1000).toFixed(meta.audioSampleRate % 1000 ? 1 : 0)} kHz`);
    const acodec = acodecParts.filter(Boolean).join(' · ') || '—';

    fillMeta(box, [
      ['名称', vref.n],
      ['大小', io.formatSize(a.size ?? vref.s)],
      ['时长', mi.formatDuration(meta.duration)],
      ['分辨率', w && h_ ? `${w}×${h_}` : '—'],
      ['帧率', mi.formatFps(meta.frameRate)],
      ['比特率', mi.formatBitrate(meta.bitrate)],
      ['视频编码', vcodec],
      ['音频编码', acodec],
      ['容器', meta.container || '—'],
    ], '');
  }

  function pageFile() {
    const ref = app.api.selectedRef('file');
    const vref = app.api.selectedRef('video');
    const fileMeta = h('div.mm-meta', {}, h('div.mm-hint', {}, '读取中…'));
    const videoMeta = h('div.mm-meta', {}, h('div.mm-hint', {}, '读取中…'));
    // 两个都是 async（要读资产库、解析文件头），失败要可见而非静默
    safe('读取文件信息', () => fillFileMeta(ref, fileMeta), (m) => { app.api.status(m, true); })();
    safe('读取视频信息', () => fillVideoMeta(vref, videoMeta), (m) => { app.api.status(m, true); })();
    const info = fileMeta;
    const vinfo = videoMeta;

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
      // asset.name 与 index.js 的 rec.name 同源（来自导入的 .xmind），
      // 同样要过 safeFileName —— M5 的同类路径，一起修掉保持实践一致。
      io.downloadBlob(io.safeFileName(asset.name || r.n || '附件'), asset.blob);
    };

    const remove = (kind) => {
      app.bridge[kind === 'video' ? 'setVideo' : 'setFile'](null);
      app.api.commit();
      refresh();
    };

    const play = async () => {
      const r = app.api.selectedRef('video');
      if (!r?.a) { app.api.status('未附加视频', true); return; }
      const asset = await io.getAsset(r.a, true);   // 播放需要 Blob URL
      if (!asset?.url) { app.api.status('视频数据已丢失', true); return; }
      openVideo(app, asset);
    };

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section('文件附件',
        info,
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: safe('附加文件', () => attach('file'), (m) => app.api.status(m, true)),
          }, '附加文件…'),
          h('button.mm-btn', {
            onclick: safe('下载附件', () => openOne('file'), (m) => app.api.status(m, true)),
            disabled: !ref?.a,
          }, '下载'),
          h('button.mm-btn', { onclick: () => remove('file'), disabled: !ref }, '移除'),
        ),
      ),
      section('视频附件',
        vinfo,
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: safe('附加视频', () => attach('video'), (m) => app.api.status(m, true)),
          }, '附加视频…'),
          h('button.mm-btn', {
            onclick: safe('播放视频', play, (m) => app.api.status(m, true)),
            disabled: !vref?.a,
          }, '播放'),
          h('button.mm-btn', { onclick: () => remove('video'), disabled: !vref }, '移除'),
        ),
      ),
      section('备份与恢复',
        h('div.mm-hint', {}, '实时缓存已开启（自动写入本地库）。这里管理历史快照，闪退或从备份回退时用。'),
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: () => app.api.backupNow() }, '立即备份'),
          h('button.mm-btn', {
            onclick: safe('打开快照', () => openBackups(app), (m) => app.api.status(m, true)),
          }, '历史快照…'),
          h('button.mm-btn', { onclick: () => openShortcuts(app), title: '查看编辑器支持的快捷键' }, '快捷键…'),
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
        h('div.mm-row', { style: { marginTop: '2px' } },
          h('span.mm-label', {}, '最多保留'),
          h('select.mm-select', {
            onchange: (e) => { app.api.setBackupMax(Number(e.target.value)); refresh(); },
            title: '同一份脑图最多保留的快照份数，超出自动删除最旧的一份',
          }, ...[1, 2, 3, 5, 10].map((n) =>
            h('option', { value: n, selected: Number(app.settings?.backupMax ?? 3) === n }, `${n} 份`))),
        ),
        h('div.mm-hint', {}, '调小后立即清理超出部分，无需等下次备份。'),
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
    // 文字格式走内核命令（bold/italic/…），与节点样式(setnodestyle)是两套机制
    const run = (name, value) => {
      app.bridge?.exec(name, value);
      app.api.commit();
    };

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      // 文字段：C# 版 SidePageStyle 的第一段。原本插件只把它放在顶部工具栏，
      // 工具栏控件太多挤不下，且无法回显当前节点的格式状态（无状态按钮）。
      // 这里补齐，并按 collectNodeStyle 上报的字段回显/高亮当前值。
      section('文字',
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '字体'),
          h('select.mm-select', {
            style: { flex: '1 1 auto' },
            onchange: (e) => run('fontfamily', e.target.value),
          }, ...FONTS.map((f) =>
            h('option', { value: f, selected: st.fontFamily === f }, f))),
        ),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '字号'),
          h('select.mm-select', {
            style: { flex: '1 1 auto' },
            onchange: (e) => run('fontsize', Number(e.target.value)),
          }, ...SIZES.map((n) =>
            h('option', { value: n, selected: Number(st.fontSize) === n }, String(n)))),
        ),
        colorRow('字体色', st.color,
          (v) => run('forecolor', v),
          () => { app.bridge?.clearNodeStyle('text'); app.api.commit(); refresh(); }),
        h('div.mm-row', {},
          h('button.mm-chip' + (st.bold ? '.on' : ''), {
            style: { fontWeight: '700' },
            onclick: () => run('bold'),
            title: '加粗',
          }, 'B'),
          h('button.mm-chip' + (st.italic ? '.on' : ''), {
            style: { fontStyle: 'italic' },
            onclick: () => run('italic'),
            title: '斜体',
          }, 'I'),
          h('button.mm-chip' + (st.strikethrough ? '.on' : ''), {
            style: { textDecoration: 'line-through' },
            onclick: () => run('strikethrough'),
            title: '删除线',
          }, 'S'),
        ),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '水平'),
          ...[['left', '左'], ['center', '中'], ['right', '右']].map(([v, t]) =>
            h('button.mm-chip' + (st.textAlign === v ? '.on' : ''), {
              onclick: () => run('textalign', v),
              title: `水平${t}对齐`,
            }, t)),
        ),
        h('div.mm-row', {},
          h('span.mm-label', { style: { minWidth: '48px' } }, '垂直'),
          ...[['top', '上'], ['middle', '中'], ['bottom', '下']].map(([v, t]) =>
            h('button.mm-chip' + (st.verticalAlign === v ? '.on' : ''), {
              onclick: () => run('valign', v),
              title: `文字垂直${t}对齐`,
            }, t)),
        ),
      ),
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
      // 外观：C# 样式页「外观」段（整理布局 + 清除/复制/粘贴样式）
      section('外观',
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: () => { app.bridge?.exec('resetlayout'); app.api.commit(); app.api.status('布局已整理'); },
            title: '重新排列节点布局（resetlayout）',
          }, '整理布局'),
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

  /* ------------------------- 主题导入 / 导出 ------------------------- */

  /**
   * 导出当前画布使用的自定义主题为 JSON（对齐 C# OnExportThemeClick）。
   * C# 是「导出选中的主题」，插件的主题列表没有独立的选中态（点即应用），
   * 故改为导出当前画布正在用的那个 —— 更符合直觉，也省去一次选择。
   */
  async function exportThemeFile() {
    const id = app.sheet?.theme;
    const t = (app.customThemes || []).find((x) => x.id === id);
    if (!t) {
      app.api.status('当前画布用的是内置主题，无法导出（请先新建或选中自定义主题）', true);
      return;
    }
    const r = await io.saveText(
      `主题-${io.safeFileName(t.name || '未命名')}.json`,
      JSON.stringify(t, null, 2),
      'application/json',
    );
    app.api.status(r === 'error' ? '导出主题失败' : `已导出主题：${t.name || '未命名'}`);
  }

  /** 从 JSON 文件导入自定义主题（对齐 C# OnImportThemeClick，重新生成 id 避免覆盖） */
  async function importThemeFile() {
    const f = await io.pickFile('.json,application/json');
    if (!f) return;
    let t;
    try {
      t = JSON.parse(await io.readText(f));
    } catch {
      app.api.status('导入主题失败：不是合法的 JSON', true);
      return;
    }
    const pal = t?.palette || t;
    if (!t?.name || !pal || typeof pal !== 'object') {
      app.api.status('导入主题失败：文件格式不符（缺少 name / palette）', true);
      return;
    }
    const copy = {
      id: 'custom-' + Math.random().toString(36).slice(2, 10),
      name: String(t.name),
      palette: { ...pal },
    };
    app.customThemes = [...(app.customThemes || []), copy];
    const okSave = await app.api.saveThemes();
    if (!okSave) { app.api.status('导入失败（未写入本地库）', true); return; }
    app.bridge.registerTheme(copy);
    app.api.applyTheme(copy.id);
    refresh();
    app.api.status(`已导入自定义主题：${copy.name}`);
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
            onclick: safe('删除主题', async () => {
              app.customThemes = (app.customThemes || []).filter((x) => x.id !== t.id);
              const ok = await app.api.saveThemes();
              if (!ok) { app.api.status('删除失败（未写入本地库）', true); return; }
              refresh();
            }, (m) => app.api.status(m, true)),
            title: '删除',
          }, '✕'),
        )),
    );

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section('配色主题',
        list,
        h('div.mm-row', {},
          h('button.mm-btn', { onclick: () => openThemeEditor(app, null) }, '＋ 新建'),
          h('button.mm-btn', {
            onclick: safe('导入主题', () => importThemeFile(), (m) => app.api.status(m, true)),
            title: '从 JSON 文件导入自定义主题',
          }, '导入'),
          h('button.mm-btn', {
            onclick: safe('导出主题', () => exportThemeFile(), (m) => app.api.status(m, true)),
            title: '把当前画布使用的自定义主题导出为 JSON',
          }, '导出'),
        ),
        h('div.mm-hint', {}, '导入/导出仅针对自定义主题；内置主题无法导出。'),
      ),
      section('布局模板',
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          ...LAYOUTS.map((l) =>
            h('button.mm-theme' + (curLayout === l.value ? '.on' : ''), {
              onclick: () => { app.api.applyLayout(l.value); refresh(); },
            }, h('span.name', {}, l.label))),
        ),
      ),
      // 注：这里原先有个「整理布局」用 exec('arrange') —— 那是内核拖拽排序模块的内部命令
      // （需要 index 参数），单独执行无效。真正的整理布局是 resetlayout，已在样式页「外观」段。
      section('视图',
        h('div.mm-row', {},
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
    // saveThemes 失败是「返回 false」而非抛异常，不判断就会提示成功实则没存上
    const saved = await app.api.saveThemes();
    if (!saved) { app.api.status('主题保存失败（未写入本地库）', true); return; }
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
    h('div.mm-actions', {}, h('button.mm-btn.primary', {
      onclick: safe('保存主题', save, (m) => app.api.status(m, true)),
    }, '保存并应用')),
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
    onclick: () => io.downloadBlob(io.safeFileName(asset.name || '附件'), asset.blob),
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
    h('div.mm-hint', {}, `按时间倒序，最多保留 ${app.settings?.backupMax ?? store.BACKUP_KEEP} 份。恢复会覆盖当前所有画布。`),
    box,
    h('div.mm-actions', {},
      h('button.mm-btn', { onclick: async () => { await app.api.backupNow(); await render(); } }, '立即备份'),
      h('button.mm-btn', { onclick: async () => { await store.clearBackups(); await render(); } }, '清空快照'),
    ),
  ]
  );
  return dlg;
}

/* ------------------------- 快捷键说明 ------------------------- */

/**
 * 编辑器页面（editor/index.html）实际注册的快捷键。
 * 注：core 另外内置 Ctrl+A 全选、方向键导航、/ 折叠、Alt+1~5 展开层级。
 * 这里只列页面显式注册的，避免把内核行为写成文档后对不上。
 */
const SHORTCUTS = [
  // —— 编辑器页面显式注册（editor/index.html）——
  ['Tab', '插入下级节点并进入编辑'],
  ['Enter', '插入同级节点并进入编辑'],
  ['Delete / Backspace', '删除选中节点（根节点除外）'],
  ['F2', '编辑选中节点文字'],
  ['Ctrl + B', '加粗'],
  ['Ctrl + I', '斜体'],
  ['Ctrl + D', '删除线'],
  ['Ctrl + E', '水平居中'],
  ['Ctrl + L', '水平左对齐'],
  ['Ctrl + R', '水平右对齐'],
  ['Ctrl + Shift + C', '复制节点样式'],
  ['Ctrl + Shift + V', '粘贴节点样式'],
  // —— 页面补齐：内核只登记了键码、未实现行为，由 editor/index.html 实现 ——
  ['↑ / ↓', '在兄弟节点间移动'],
  ['←', '移到父节点（只移动，不折叠）'],
  ['→', '进入第一个子节点（折叠着会先展开）'],
  ['Ctrl + ←', '折叠选中分支'],
  ['Ctrl + →', '展开选中分支'],
  ['/', '折叠 / 展开选中节点（来回切换）'],
  ['Alt + 1~5', '从选中节点展开到第 N 级（更深层收起）'],
  // —— 内核 commandShortcutKeys 注册 ——
  ['Alt + ↑ / ↓', '节点上移 / 下移'],
  ['Shift + Tab', '插入上级节点'],
  ['Ctrl + Shift + L', '整理布局'],
  ['Ctrl + = / -', '画布缩放'],
  ['Ctrl + A', '全选'],
  ['Ctrl + C / X / V', '复制 / 剪切 / 粘贴节点'],
];

/** 快捷键说明浮层：快捷键由编辑器页面注册，插件无法改写，只能如实列出 */
export function openShortcuts(app) {
  const rows = SHORTCUTS.map(([k, d]) =>
    h('div.mm-row', { style: { gap: '10px' } },
      h('code.mm-kbd', {}, k),
      h('span', { style: { fontSize: '12px' } }, d),
    ));
  return dialog('快捷键', [
    h('div.mm-hint', {}, '快捷键由编辑器内核注册，焦点需在画布上才生效。'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' } }, ...rows),
  ]);
}
