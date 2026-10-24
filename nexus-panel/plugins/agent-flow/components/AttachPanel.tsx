import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNexus } from '../../../src/nexus-react';
import { confirm } from '../../js/dialog.js';
import { looksAbsolute, joinPath } from '../engine/exportDir';
import { readTextFile } from '../engine/attachmentFile';
import { readImageDataUrl, readAudioDataUrl, canReadImage, canReadAudio } from '../lib/tauri';
import {
  type AttachmentItem, type AttachmentFile,
  kindOf, extOf, ATTACH_KIND_LABEL,
} from '../engine/attachmentStore';
import { probeVideo, formatDuration, formatBitrate, formatFps } from '../../js/media-info.js';

/**
 * 附属文件面板（右栏「文件」页签）。
 *
 * ================= 为什么清单落盘、本体不落盘 =================
 *
 * 清单（谁挂了什么）落盘到导出目录，让 AI 能直接改 —— 这是它的主要用法。
 *
 * 本体**不复制**进工具目录：前端只有写文本的能力（fs_op 的 write 写字符串），
 * 没有"写二进制"的命令，复制一个 200MB 的视频做不到。
 * 把小附件转成 base64 内联进 JSON 更糟 —— 那个 JSON 是给 AI 读的，
 * 塞一段几 MB 的乱码进去，diff 就没法看了。
 *
 * 所以本体留在原处，这里只做索引。代价是文件被移走就打不开，
 * 因此每条都存了 name —— 打不开时至少看得出这里原本挂的是什么。
 *
 * ================= 视频为什么有时只显示信息 =================
 *
 * 共享的解析工具（js/media-info.js，从 mindmap 提取）需要**字节**。
 * 本插件从磁盘读字节只有"图片"和"音频"两条命令，没有视频的：
 *
 *   · 本次会话里人工选进来的 → 浏览器给了 File（就是 Blob）→ 能解析、能播
 *   · 清单里只有路径的（AI 写的 / 上次留下的）→ 读不到字节 → 只显示已记录的信息
 *
 * 两种都如实显示，不假装解析成功。
 */

/*
  类型标签的类名**查表**给，不写成 `k-${kind}`。

  项目里有一条检查：组件用到的类名必须能在样式里找到定义
  （见 tests/classNames.test.ts）。模板拼出来的类名扫描器只认得
  前缀 `k-`，于是每次都会被判成"用了没定义"——而它其实是有样式的。
  查表把完整类名摊开写，扫描器才看得见。
*/
const KIND_CLASS: Record<AttachKind, string> = {
  md: 'att-kind k-md',
  image: 'att-kind k-image',
  video: 'att-kind k-video',
  audio: 'att-kind k-audio',
  other: 'att-kind k-other',
};

export function AttachPanel({
  file, owner, ownerTitle, dir, canWrite, onAdd, onRemove, onReload, notice,
}: {
  file: AttachmentFile;
  /** 当前选中的任务 id。空串表示显示未挂载的那些 */
  owner: string;
  ownerTitle: string;
  dir: string;
  canWrite: boolean;
  onAdd: (item: AttachmentItem) => void;
  onRemove: (id: string) => void;
  onReload: () => void;
  notice: string;
}) {
  const [selId, setSelId] = useState<string | null>(null);
  const [blobs, setBlobs] = useState<Record<string, File>>({});
  const fileInput = useRef<HTMLInputElement | null>(null);

  const items = useMemo(
    () => file.order.map((id) => file.items[id]).filter((it) => !!it && it.owner === owner),
    [file, owner],
  );

  // 换任务 = 换一组文件，旧的选中项在这组里不存在
  useEffect(() => { setSelId(null); }, [owner]);

  /*
    人工添加：<input type="file">（与 mindmap 的 io.pickFile 同款）。
    浏览器给的是 File；真实路径在沙箱里通常拿不到，所以尽力取，
    取不到就只记文件名 —— 界面上会显示"路径未知"，不假装能打开。
  */
  const pick = useCallback(() => {
    const inp = fileInput.current;
    if (!inp) return;
    inp.value = '';
    inp.click();
  }, []);

  const onPicked = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    // 用 Array.from 而不是展开：FileList 在当前编译配置下没有 Symbol.iterator
    const list = e.target.files ? Array.from(e.target.files) : [];
    for (const f of list) {
      const maybePath = (f as unknown as { path?: string }).path;
      const path = typeof maybePath === 'string' && maybePath ? maybePath : f.name;
      const now = Date.now();
      const item: AttachmentItem = {
        id: `att_${now.toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
        owner,
        ownerTitle,
        path,
        name: f.name,
        note: '',
        addedBy: '人',
        addedAt: now,
      };
      onAdd(item);
      // 记住字节：视频要靠它解析元信息，否则只剩路径什么都做不了
      setBlobs((prev) => ({ ...prev, [item.id]: f }));
    }
  }, [onAdd, owner, ownerTitle]);

  const runRemove = async (it: AttachmentItem) => {
    const ok = await confirm({
      title: '移除附件',
      message: `把「${it.name}」从这条任务上移除？\n\n只删清单里这一条，磁盘上的文件不动。`,
      okText: '移除',
      danger: true,
    });
    if (!ok) return;
    onRemove(it.id);
    if (selId === it.id) setSelId(null);
  };

  const sel = selId ? file.items[selId] : null;

  return (
    <div className="att-pane">
      <input
        ref={fileInput}
        type="file"
        multiple
        className="att-file-input"
        onChange={onPicked}
      />

      <div className="att-head">
        <span className="att-title">附属文件</span>
        <span className="task-grow" />
        <button type="button" className="mini" onClick={pick} disabled={!canWrite} title="选本地文件挂到这条任务上">
          + 添加
        </button>
        <button type="button" className="mini" onClick={onReload} title="重新读一次清单文件">
          刷新
        </button>
      </div>

      <div className="att-owner" title={ownerTitle || owner}>
        {owner ? `挂在：${ownerTitle || owner}` : '未挂在任何任务上'}
      </div>

      {notice ? <div className="att-notice">{notice}</div> : null}

      {!canWrite ? (
        <div className="nx-empty att-empty">需要设置导出目录，清单才有地方落盘。</div>
      ) : items.length === 0 ? (
        <div className="nx-empty att-empty">
          这条任务还没有附属文件。点「+ 添加」挂一个，
          <br />
          或直接改清单文件（AI 也能改）。
        </div>
      ) : (
        <div className="att-list">
          {items.map((it) => (
            <div
              key={it.id}
              className={`att-card${selId === it.id ? ' is-active' : ''}`}
              onClick={() => setSelId(it.id)}
            >
              <span className={KIND_CLASS[kindOf(it.name)]}>{ATTACH_KIND_LABEL[kindOf(it.name)]}</span>
              <span className="att-name" title={it.name}>{it.name}</span>
              <span className="att-by">{it.addedBy || '—'}</span>
              <button
                type="button"
                className="att-x"
                title="移除"
                onClick={(e) => { e.stopPropagation(); void runRemove(it); }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {sel ? <AttachPreview item={sel} dir={dir} blob={blobs[sel.id]} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 预览                                                                */
/* ------------------------------------------------------------------ */

function AttachPreview({ item, dir, blob }: {
  item: AttachmentItem;
  dir: string;
  /** 本次会话里选进来的原始文件。只有它有字节 */
  blob?: File;
}) {
  const kind = kindOf(item.name);
  /*
    绝对路径直接用；相对路径拼到导出目录上。
    AI 写清单时未必知道导出目录在哪，拼接能救回一批"路径写错了"。
  */
  const path = useMemo(() => (
    !item.path ? '' : looksAbsolute(item.path) ? item.path : joinPath(dir, item.path)
  ), [item.path, dir]);

  return (
    <div className="att-prev">
      <div className="att-prev-head">
        <span className="att-prev-name" title={item.name}>{item.name}</span>
        <span className="task-grow" />
        <span className="att-prev-ext">{extOf(item.name) || '—'}</span>
      </div>
      <div className="att-prev-path" title={path || item.path}>{path || '（路径未知）'}</div>
      <div className="att-prev-body">
        {!path
          ? <div className="nx-empty">这条附件没有路径，打不开。</div>
          : kind === 'md' ? <MdPreview path={path} />
          : kind === 'image' ? <ImagePreview path={path} name={item.name} />
          : kind === 'audio' ? <AudioPreview path={path} />
          : kind === 'video' ? <VideoPreview path={path} name={item.name} blob={blob} />
          : <OtherPreview path={path} name={item.name} />}
      </div>
    </div>
  );
}

/** md：读文本 → 交给 md-render 服务渲染（与 md-editor 的预览同一条管线） */
function MdPreview({ path }: { path: string }) {
  const ctx = useNexus();
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [raw, setRaw] = useState('');

  useEffect(() => {
    let alive = true;
    setHtml(null); setErr(''); setRaw('');
    void (async () => {
      try {
        const text = await readTextFile(path);
        if (!alive) return;
        setRaw(text);
        /*
          走 md-render 服务，不自己渲染一遍：
          自己渲染就要自己配 remark/rehype 插件（mermaid、plantuml…），
          配出来必然与别处的预览不一致 —— 同一份 md 两个地方显示不一样。
        */
        const out: unknown = await ctx.services.call('md-render', 'renderToHtml', { text });
        if (!alive) return;
        setHtml(typeof out === 'string' ? out : '');
      } catch (e: unknown) {
        if (!alive) return;
        // 渲染服务不可用也要能看到内容 —— 退回纯文本，而不是留一片空白
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [path, ctx]);

  if (html) {
    /*
      innerHTML 是这里唯一可行的渲染方式：md-render 服务返回 HTML 字符串
      （它跑在另一个插件里，给不了 React 元素）。
      内容来自用户自己选的本地文件 —— 不是网络输入。
    */
    return <div className="att-md markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (raw) {
    return (
      <div className="att-md">
        {err ? <div className="att-warn">渲染服务不可用（{err}），以下为纯文本</div> : null}
        <pre className="att-raw">{raw}</pre>
      </div>
    );
  }
  return <div className="nx-empty">{err || '读取中…'}</div>;
}

function ImagePreview({ path, name }: { path: string; name: string }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setUrl(''); setErr('');
    if (!canReadImage()) { setErr('当前是浏览器模式，读不到本地图片'); return; }
    void (async () => {
      try {
        const d = await readImageDataUrl(path);
        if (!alive) return;
        setUrl(d);
      } catch (e: unknown) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [path]);

  if (url) return <img className="att-img" src={url} alt={name} />;
  return <div className="nx-empty">{err || '读取中…'}</div>;
}

function AudioPreview({ path }: { path: string }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setUrl(''); setErr('');
    if (!canReadAudio()) { setErr('当前是浏览器模式，读不到本地音频'); return; }
    void (async () => {
      try {
        const d = await readAudioDataUrl(path);
        if (!alive) return;
        setUrl(d);
      } catch (e: unknown) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [path]);

  if (url) return <audio className="att-audio" src={url} controls />;
  return <div className="nx-empty">{err || '读取中…'}</div>;
}

/**
 * 视频。
 *
 * 有 Blob（本次会话选进来的）→ 用共享工具解析元信息并就地播放；
 * 只有路径 → 读不到字节（无对应读取命令），如实说明。
 */
function VideoPreview({ path, name, blob }: { path: string; name: string; blob?: File }) {
  const [info, setInfo] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    // objectURL 必须回收：每个视频都是一份完整文件的内存映射
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => { URL.revokeObjectURL(u); };
  }, [blob]);

  useEffect(() => {
    let alive = true;
    setInfo(null); setErr('');
    if (!blob) return;
    void (async () => {
      try {
        const mi = await probeVideo(blob);
        if (!alive) return;
        setInfo({
          分辨率: mi.width && mi.height ? `${mi.width}×${mi.height}` : '—',
          时长: formatDuration(mi.duration),
          帧率: formatFps(mi.frameRate),
          比特率: formatBitrate(mi.bitrate),
          视频编码: mi.videoCodec || '—',
          音频编码: mi.audioCodec || '—',
          容器: mi.container || '—',
        });
      } catch (e: unknown) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [blob]);

  if (blob && url) {
    return (
      <div className="att-video">
        <video className="att-video-el" src={url} controls preload="metadata" />
        <div className="att-meta">
          {info
            ? Object.keys(info).map((k) => (
              <div key={k} className="att-meta-row">
                <span className="att-meta-k">{k}</span>
                <span className="att-meta-v">{info[k]}</span>
              </div>
            ))
            : <div className="nx-empty">{err || '解析中…'}</div>}
        </div>
      </div>
    );
  }

  /*
    只有路径的情况。
    ⛔ 不要静默什么都不显示 —— 那看着像"视频功能坏了"，
    实际是"这个文件只有路径、没有字节"，两件事的处置完全不同。
  */
  return (
    <div className="att-video">
      <div className="nx-empty att-empty">
        视频字节读不到，只显示清单里记录的信息。
      </div>
      <div className="att-meta">
        <div className="att-meta-row">
          <span className="att-meta-k">文件名</span>
          <span className="att-meta-v">{name}</span>
        </div>
        <div className="att-meta-row">
          <span className="att-meta-k">路径</span>
          <span className="att-meta-v" title={path}>{path}</span>
        </div>
      </div>
      <div className="att-hint">
        本次会话里用「+ 添加」选进来的视频可以解析元信息并播放；
        清单里只有路径的（AI 写的或上次留下的）读不到字节 ——
        没有对应的读取命令。
      </div>
    </div>
  );
}

function OtherPreview({ path, name }: { path: string; name: string }) {
  return (
    <div className="att-other">
      <div className="nx-empty att-empty">这类文件没有预览，只显示记录的信息。</div>
      <div className="att-meta">
        <div className="att-meta-row">
          <span className="att-meta-k">文件名</span>
          <span className="att-meta-v">{name}</span>
        </div>
        <div className="att-meta-row">
          <span className="att-meta-k">路径</span>
          <span className="att-meta-v" title={path}>{path}</span>
        </div>
      </div>
    </div>
  );
}
