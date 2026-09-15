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
import { LAYOUT_THUMBS } from './layout-thumbs.js';
import * as io from './io.js';
import * as store from './store.js';
import * as mi from './mediainfo.js';

const FONTS = ['微软雅黑', '宋体', '黑体', '楷体', 'Arial', 'Consolas', 'sans-serif'];
const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40];
const RADII = [0, 3, 5, 8, 12, 16, 24];
const WIDTHS = [1, 2, 3, 4, 6];

/* --------------------------- 小组件 --------------------------- */

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv']);

const extOf = (name) => String(name || '').split('.').pop().toLowerCase();
const isImageName = (name) => IMAGE_EXTS.has(extOf(name));

/** 按扩展名给一个象形图标。附件卡片上比干巴巴的一行文字直观得多。 */
function fileIcon(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return '🖼';
  if (VIDEO_EXTS.has(ext)) return '🎬';
  if (ext === 'pdf') return '📕';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return '🗜';
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '📗';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📙';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return '🎵';
  if (['txt', 'md', 'log'].includes(ext)) return '📃';
  if (['json', 'xml', 'yml', 'yaml'].includes(ext)) return '🧩';
  return '📄';
}

/* ------------------------- 主题配色条 ------------------------- */

/**
 * 主题预览四色：画布底 / 根节点 / 主节点 / 子节点。
 *
 * 之前每个主题只有一个圆点（根节点色），看不出画布底色和各级节点长什么样 ——
 * 尤其 snow / classic / fish 三者 root 同为 #E9DF98，单看圆点完全分不出来。
 */
function themeSwatch(t) {
  const bg = t?.bg || '#FBFBFB';
  return {
    bg,
    root: t?.root || '#4A90D9',
    main: t?.main || '#DCE9F7',
    // 子节点无填充时透出的是画布底色，按 bg 显示（并标为 transparent）
    sub: t?.sub === 'transparent' ? bg : (t?.sub || '#FFFFFF'),
    subTransparent: t?.sub === 'transparent',
  };
}

/** 自定义主题：palette 字段名与内置主题不同，在这里归一 */
function customSwatch(t) {
  const p = t?.palette || {};
  return themeSwatch({
    bg: p.background || '#FBFBFB',
    root: p.rootBackground || '#4A90D9',
    main: p.mainBackground || '#DCE9F7',
    sub: p.subBackground || p.background || '#FFFFFF',
  });
}

/**
 * 四段颜色条。
 * 段间不留缝也不加分隔线 —— 40px 宽分四段已经很窄，再留缝就成四个孤立色点了。
 */
function swatchBar(s) {
  const seg = (color, title, transparent) =>
    h('span.mm-sw' + (transparent ? '.transparent' : ''), {
      style: { background: color },
      title,
    });
  return h('span.mm-swbar', {},
    seg(s.bg, `画布底色 ${s.bg}`),
    seg(s.root, `根节点 ${s.root}`),
    seg(s.main, `主节点 ${s.main}`),
    seg(s.sub, s.subTransparent ? `子节点 透明（透出 ${s.bg}）` : `子节点 ${s.sub}`, s.subTransparent),
  );
}

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

/**
 * 右侧属性侧栏。
 * ============================================================
 * 对齐 C# 版 MindMapPanel：主体区是两列网格，画布占 Column 0，
 * 侧栏占 Column 1 固定 276px 且**常驻**（XAML 里没有折叠逻辑）。
 *
 * 四个页签（主题 / 标签 / 样式 / 文件）**不在**这里 —— C# 把它们的
 * ToggleButton 放在顶栏最右（Grid.Column=14），由 index.js 的 buildToolbar
 * 生成，通过 opts.onPage 回调与本处的当前页保持高亮同步。
 *
 * 页签也曾短暂地放在侧栏顶部，但那样会占掉侧栏内容约 34px 的可用高度，
 * 且与原版不符，故改回顶栏。
 */
export function buildSide(app, opts = {}) {
  const pages = {};
  let current = null;

  /**
   * 本侧栏实例创建的 Blob URL 池。
   * ============================================================
   * io.getAsset(id, true) 每次调用都**新建一个** URL —— 这是刻意为之
   * （调用方各自持有、各自释放，避免共享 URL 被谁提前 revoke），
   * 代价是每次 refresh（切页、附加/移除附件后重建 DOM）都会漏一批。
   * 视频预览 + 图片缩略图一次就要两个，漏得更快。
   *
   * 侧栏没有 unmount 钩子，统一在 render 重建 DOM 前回收。
   * 挂在实例上而非模块级：模块级单例会被多个侧栏实例互相 revoke 掉还在用的 URL。
   */
  let mediaUrls = [];
  const trackMediaUrl = (u) => { if (u) mediaUrls.push(u); return u; };
  const releaseMediaUrls = () => {
    for (const u of mediaUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
    mediaUrls = [];
  };

  const body = h('div.mm-side.open', {});   // 常驻：初始即带 open
  const el = body;

  /** 切换页。常驻侧栏不再有「再点一次收起」的语义 —— 那会把面板点没。 */
  function open(page) {
    if (!pages[page]) return;
    current = page;
    body.dataset.page = page;      // 标记当前页，便于外部（含测试）判断侧栏停在哪个页
    render();
    opts.onPage?.(page);           // 顶栏页签据此同步高亮
  }

  function render() {
    // 重建 DOM 前先回收上一批 Blob URL —— refresh 会被「附加/移除附件」
    // 反复触发，不回收就会一直攒着（每个视频都是一份完整文件的内存映射）
    releaseMediaUrls();
    body.innerHTML = '';
    body.appendChild(pages[current]());
  }

  function refresh() {
    if (current) render();
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
    // 名称与大小已经显示在卡片上，这里只补卡片放不下的两项，避免重复
    box.innerHTML = '';
    if (!ref) return;                             // 「未附加」由卡片自己表达
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
      ['类型', mi.shortType(a.type, ref.n)],
      ['修改', mi.formatDateTime(a.mtime || a.addedAt)],
    ], '');
  }

  /**
   * 视频元信息：分辨率 / 帧率 / 比特率 / 视频编码 / 音频编码 / 时长。
   * 浏览器只给得出时长与分辨率，帧率和编解码器必须解容器，
   * 所以走 mediainfo.probeVideo；结果写回资产库，下次打开直接读。
   */
  async function fillVideoMeta(vref, box, onMeta) {
    // 名称 / 大小 / 时长 由预览区下方的摘要行显示，这里只列技术参数
    box.innerHTML = '';
    if (!vref) return;                            // 「未附加」由预览区自己表达
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
      ['分辨率', w && h_ ? `${w}×${h_}` : '—'],
      ['帧率', mi.formatFps(meta.frameRate)],
      ['比特率', mi.formatBitrate(meta.bitrate)],
      ['视频编码', vcodec],
      ['音频编码', acodec],
      ['容器', meta.container || '—'],
    ], '');
    // 时长不在表里了，回填给预览区下方的摘要行
    try { onMeta?.(meta); } catch { /* 摘要行写不进去不影响别处 */ }
  }

  /**
   * 附件卡片：图标（图片则直接显示缩略图）+ 名称 + 大小，点一下即打开。
   * 之前的形态是「两行文字 + 三个按钮」，文件长什么样完全看不出来。
   */
  function buildFileCard(ref, onOpen) {
    if (!ref) return h('div.mm-acard.empty', {}, '当前节点未附加文件');

    const name = ref.n || '未命名';
    const iconBox = h('div.mm-acard-icon', {}, fileIcon(name));

    // 图片直接显示缩略图：比一个 🖼 图标有用得多
    if (ref.a && isImageName(name)) {
      safe('读取缩略图', async () => {
        const asset = await io.getAsset(ref.a, true);
        if (!asset?.url) return;
        trackMediaUrl(asset.url);
        iconBox.innerHTML = '';
        iconBox.appendChild(h('img.mm-acard-thumb', { src: asset.url, alt: name }));
      }, () => { /* 缩略图失败不影响卡片本身，留着图标即可 */ })();
    }

    return h('button.mm-acard', { title: '点击打开', onclick: onOpen },
      iconBox,
      h('div.mm-acard-main', {},
        h('div.mm-acard-name', { title: name }, name),
        h('div.mm-acard-sub', {}, io.formatSize(ref.s))),
    );
  }

  /**
   * 视频预览：默认显示首帧，点一下**就地**播放（不再弹浮层）。
   * 返回 { el, setDuration } —— 时长要等媒体头解析完才知道，由 fillVideoMeta 回填。
   */
  function buildVideoPreview(vref) {
    const dur = h('span.mm-vsum-dur', {}, '');
    const box = h('div.mm-vthumb', {});
    const wrap = h('div.mm-vwrap', {},
      box,
      h('div.mm-vsum', {},
        h('span.mm-vsum-name', { title: vref?.n || '' }, vref?.n || '未附加视频'),
        dur,
        h('span.mm-vsum-size', {}, vref?.s ? io.formatSize(vref.s) : '')),
    );
    const setDuration = (d) => { dur.textContent = (d && mi.formatDuration(d)) || ''; };

    /**
     * 三态必须分开说清楚 —— 混在一起就是「视频凭空消失」。
     *
     * 之前只有「有 a」和「没有 a」两态，没有 a 时统一显示「未附加视频」。
     * 但 vref 存在而 vref.a 为空是**另一种情况**：C# 版迁移过来的纯路径引用，
     * 或者 .xmind 里没打包本体 —— 节点上明明挂着视频（画布图标还在画着），
     * 侧栏却说「未附加」，看起来就像视频被一起删掉了。
     */
    if (!vref) {
      box.classList.add('empty');
      box.appendChild(h('div.mm-vthumb-empty', {}, '未附加视频'));
      return { el: wrap, setDuration };
    }
    if (!vref.a) {
      box.classList.add('empty');
      box.appendChild(h('div.mm-vthumb-empty', {}, '旧版本地路径，沙箱内读不到本体'));
      return { el: wrap, setDuration };
    }
    // 加载中先给个说法：整块纯黑会被当成「没了」
    box.classList.add('loading');
    box.appendChild(h('div.mm-vthumb-empty', {}, '读取中…'));

    let video = null;
    const start = () => {
      if (!video) return;
      // 就地播：不换元素、不弹窗。controls 里自带全屏，侧栏里放不下也能看。
      video.controls = true;
      video.muted = false;
      video.currentTime = 0;
      box.classList.add('playing');
      try {
        const p = video.play();
        // 自动播放可能被浏览器策略拒绝；controls 已经出来了，用户能自己点
        if (p && p.catch) p.catch(() => {});
      } catch {
        // 环境根本没实现 play（jsdom 直接抛 Not implemented）。
        // 控件已经挂上，不影响手动播放。
      }
    };

    safe('读取视频', async () => {
      const asset = await io.getAsset(vref.a, true);
      if (!asset?.url) {
        // 清掉「读取中…」再写结论，否则两段文字叠在一起
        box.classList.remove('loading');
        box.classList.add('broken');
        box.innerHTML = '';
        box.appendChild(h('div.mm-vthumb-empty', {}, '视频数据已丢失'));
        return;
      }
      trackMediaUrl(asset.url);
      // preload=metadata 只拉头部：能解出首帧当封面，又不会把整个视频读进内存。
      // #t=0.1 是必要的 —— 不少浏览器不 seek 就不绘制首帧，只显示一片黑。
      video = h('video.mm-vthumb-media', {
        src: asset.url + '#t=0.1',
        preload: 'metadata',
        muted: true,
        playsinline: true,
      });
      video.addEventListener('error', () => {
        box.classList.add('broken');
        app.api.status('视频无法播放（格式可能不受支持）', true);
      });
      // 首帧就绪再撤掉「读取中…」：提前清会让黑块闪一下，看着像加载失败
      video.addEventListener('loadeddata', () => {
        box.classList.remove('loading');
        const t = box.querySelector('.mm-vthumb-empty');
        if (t) t.remove();
      });
      // ▶ 只是个视觉提示，点击交给 box，避免按钮与容器双重触发
      box.innerHTML = '';
      box.appendChild(video);
      box.appendChild(h('div.mm-vthumb-play', {}, '▶'));
      box.classList.remove('loading');
      box.classList.add('ready');
    }, (m) => app.api.status(m, true))();

    box.addEventListener('click', start);
    return { el: wrap, setDuration };
  }

  function pageFile() {
    const ref = app.api.selectedRef('file');
    const vref = app.api.selectedRef('video');
    const fileMeta = h('div.mm-meta', {});
    const videoMeta = h('div.mm-meta', {});
    const vprev = buildVideoPreview(vref);
    // 两个都是 async（要读资产库、解析文件头），失败要可见而非静默
    safe('读取文件信息', () => fillFileMeta(ref, fileMeta), (m) => { app.api.status(m, true); })();
    safe('读取视频信息', () => fillVideoMeta(vref, videoMeta, vprev.setDuration), (m) => { app.api.status(m, true); })();
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
      // 「移除文件不该动视频」这条边界必须守住，而且**失守时要让人看见**。
      // 静默丢掉的话，用户只看到「侧栏空了」，无从判断是显示问题还是真丢了数据。
      const other = kind === 'video' ? 'file' : 'video';
      const hadOther = !!app.api.selectedRef(other);
      app.bridge[kind === 'video' ? 'setVideo' : 'setFile'](null);
      app.api.commit();
      refresh();
      if (hadOther && !app.api.selectedRef(other)) {
        app.api.status(`移除${kind === 'video' ? '视频' : '文件'}时，${kind === 'video' ? '文件' : '视频'}引用也一并丢失了（编辑器的 file/video 是各自独立的 data 字段，不应互相影响）`, true);
      }
    };

    /** 点附件卡片：图片就地预览，其余只能下载（沙箱拿不到真实路径） */
    const openFileCard = () => {
      const r = app.api.selectedRef('file');
      if (!r?.a) { app.api.status('该附件来自旧版路径，无法在沙箱内打开', true); return; }
      safe('打开附件', async () => {
        const asset = await io.getAsset(r.a, true);
        if (!asset?.blob) { app.api.status('附件数据已丢失', true); return; }
        trackMediaUrl(asset.url);
        if (isImageName(r.n) && asset.url) openPreview(app, asset);
        else io.downloadBlob(io.safeFileName(asset.name || r.n || '附件'), asset.blob);
      }, (m) => app.api.status(m, true))();
    };

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      section('文件附件',
        buildFileCard(ref, openFileCard),
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
        // 预览区本身就是播放入口（点一下就地播），不再需要单独的「播放」按钮
        vprev.el,
        vinfo,
        h('div.mm-row', {},
          h('button.mm-btn', {
            onclick: safe('附加视频', () => attach('video'), (m) => app.api.status(m, true)),
          }, '附加视频…'),
          h('button.mm-btn', {
            onclick: safe('下载视频', () => openOne('video'), (m) => app.api.status(m, true)),
            disabled: !vref?.a,
          }, '下载'),
          h('button.mm-btn', { onclick: () => remove('video'), disabled: !vref }, '移除'),
        ),
      ),
      // 备份间隔 / 最多保留 / 布局动画都已移到顶栏「设置」——
      // 它们是与当前节点无关的全局选项，不该挂在「文件」页下。
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
          swatchBar(themeSwatch(t)),
          h('span.name', {}, t.label),
        )),
      ...(app.customThemes || []).map((t) =>
        h('div.mm-theme' + (cur === t.id ? '.on' : ''), {},
          h('span', {
            style: { display: 'flex', cursor: 'pointer' },
            onclick: () => { app.api.applyTheme(t.id); refresh(); },
          }, swatchBar(customSwatch(t))),
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
        // 两列缩略图网格 + 名称，对齐 WPF 原版（UniformGrid Columns="2" + 100×58 缩略图）
        h('div.mm-layouts', {},
          ...LAYOUTS.map((l) =>
            h('button.mm-layout' + (curLayout === l.value ? '.on' : ''), {
              onclick: () => { app.api.applyLayout(l.value); refresh(); },
              title: l.label,
            },
              h('span.mm-layout-thumb', {},
                // 缺图时退化成占位符而不是空白 —— 空白在深色面板上等同于「没这项」
                LAYOUT_THUMBS[l.value]
                  ? h('img', { src: LAYOUT_THUMBS[l.value], alt: l.label, width: '100', height: '40' })
                  : h('span.mm-layout-nothumb', {}, '⁇')),
              h('span.mm-layout-name', {}, l.label))),
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

  // 默认停在「主题」页，与 C# 构造函数里的 ShowSidePage("theme") 一致
  open('theme');
  // close 保留为空实现：侧栏常驻后没有收起语义，但外部（含历史调用点）可能还在调
  return { el, open, close: () => {}, refresh, isOpen: () => true, current: () => current };
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
            onclick: safe('恢复快照', async () => {
              if (!b.sheets) return;
              // A46 恢复会覆盖**当前所有画布**且不可逆 —— 必须确认。
              // 不确认的话，误点一下整份工作就没了。
              const n = (b.sheets || []).length;
              if (!window.confirm(
                `恢复到 ${new Date(b.ts).toLocaleString()} 的快照？\n\n` +
                `当前所有画布将被替换为该快照的 ${n} 张画布，此操作不可撤销。\n` +
                `（恢复前的当前状态会自动另存一份快照，可再回滚）`)) return;
              await app.api.restoreBackup(b);
              dlg.close();
            }, (m) => app.api.status(m, true)),
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

/* ------------------------- 设置 ------------------------- */

/**
 * 设置面板（顶栏「设置」按钮打开）。
 *
 * 备份间隔 / 最多保留份数 / 布局动画这类**与当前节点无关**的全局选项，
 * 原先堆在文件页里 —— 它们不是「文件」的属性，放在那儿既难找，
 * 又把一个常用页签撑得很长。现在统一收到设置里。
 */
export function openSettings(app) {
  const s = app.settings || {};

  // 布局动画按钮就地更新：整体重建会让同面板里的 <select> 失焦
  const animBtn = h('button.mm-btn' + (s.animate ? '.on' : ''), {
    onclick: () => {
      app.api.setAnimate(!app.settings?.animate);
      // 重新读一遍：setAnimate 内部会写回 settings，以它的结果为准
      const on = !!app.settings?.animate;
      animBtn.classList.toggle('on', on);
      animBtn.textContent = on ? '已开启' : '已关闭';
    },
  }, s.animate ? '已开启' : '已关闭');

  const intervalSel = h('select.mm-select', {
    onchange: (e) => app.api.setBackupMinutes(Number(e.target.value)),
    title: '每隔多久比对一次内容并写入快照；关闭则不自动备份',
  }, ...[0, 1, 2, 5, 10, 30].map((m) =>
    h('option', { value: m, selected: Number(s.backupMinutes ?? 2) === m },
      m === 0 ? '关闭' : `${m} 分钟`)));

  const keepSel = h('select.mm-select', {
    onchange: (e) => app.api.setBackupMax(Number(e.target.value)),
    title: '同一份脑图最多保留的快照份数，超出自动删除最旧的一份',
  }, ...[1, 2, 3, 5, 10].map((n) =>
    h('option', { value: n, selected: Number(s.backupMax ?? 3) === n }, `${n} 份`)));

  return dialog('设置', [
    section('备份',
      h('div.mm-row', {}, h('span.mm-label', {}, '自动间隔'), intervalSel),
      h('div.mm-hint', {}, '到点才比对一次；内容与最新快照相同则不写盘，避免空转。'),
      h('div.mm-row', { style: { marginTop: '2px' } }, h('span.mm-label', {}, '最多保留'), keepSel),
      h('div.mm-hint', {}, '调小后立即清理超出部分，无需等下次备份。'),
      h('div.mm-row', { style: { marginTop: '4px' } },
        h('button.mm-btn', { onclick: () => app.api.backupNow() }, '立即备份'),
        h('button.mm-btn', {
          onclick: safe('打开快照', () => openBackups(app), (m) => app.api.status(m, true)),
        }, '历史快照…'),
      ),
    ),
    section('外观',
      h('div.mm-row', {}, h('span.mm-label', {}, '布局动画'), animBtn),
      h('div.mm-hint', {}, '开启后打开画布、展开/收起分支会播 300ms 过渡动画；关闭则直接显示最终布局。'),
    ),
    section('其它',
      h('div.mm-row', {},
        h('button.mm-btn', {
          onclick: () => openShortcuts(app),
          title: '查看编辑器支持的快捷键',
        }, '快捷键…'),
      ),
    ),
  ]);
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
