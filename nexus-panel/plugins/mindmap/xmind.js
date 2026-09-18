/**
 * XMind（.xmind）导入导出
 * ============================================================
 * 直译自 junction_link 的 Services/XMindConverter.cs（949 行），
 * 目的是与 C# 版产出的 .xmind 文件双向互通，故 entry 名、JSON 结构、
 * marker 名、样式字段映射全部保持一致，不做"改进"。
 *
 * 包结构（zip）：
 *   content.json      XMind Zen / 2020+ 标准结构（与 XMind 官方互通）
 *   kityminder.json   本工具无损快照（100% 还原外框/附件等私有字段）
 *   metadata.json     固定 creator 信息
 *   manifest.json     固定文件清单
 *   resources/…       文件/视频附件
 *
 * 读取优先级与 C# 版一致：无损快照 → content.json → content.xml（XMind 8 老版）。
 *
 * 零依赖：zip 容器自己实现，压缩走浏览器原生 CompressionStream('deflate-raw')；
 * 万一环境不支持则回退 method=0（store，不压缩），zip 规范允许，只是文件大些。
 */

/* ============================================================
   一、CRC32
   ============================================================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ============================================================
   二、deflate / inflate（原生 CompressionStream，失败回退 store）
   ============================================================ */

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;   // 不支持 deflate-raw → 调用方改存 store
  }
}

/**
 * 解压上限（单条目）。
 * ============================================================
 * .xmind 是用户从别处拿来的不可信输入，zip 炸弹必须防：
 * 实测全 'A' 的数据压缩比约 1000:1，1MB 的包能解出约 1GB —— 全量进内存直接卡死插件。
 * 这里边读边累计，超 MAX_INFLATE_BYTES 立刻中断并抛错（放弃整个导入）。
 *
 * 64MB 对脑图（content.json 通常几十 KB ~ 几 MB，外加附件）留了充足余量；
 * 真有超大的视频附件，走的是「导入时让用户重新附加」的路径，不影响主流程。
 *
 * 对齐 mediainfo.js 的做法：那里对同等不可信的二进制输入也设了 guard++/depth 上限。
 */
export const MAX_INFLATE_BYTES = 64 * 1024 * 1024;

/** 整个包解压后的总量上限（防止「很多个刚好卡在单条上限下的条目」叠加） */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** 单包的条目数上限。正常 .xmind 只有个位数条目 + 若干附件，1 万条足够宽松 */
export const MAX_ENTRY_COUNT = 10000;

/**
 * 解析递归深度上限。
 * ============================================================
 * 导入的 .xmind 是不可信输入，几 KB 就能构造出上万层嵌套 ——
 * 实测 10000 层直接 RangeError: Maximum call stack size exceeded，整个导入崩掉。
 * 正常脑图极少超过 20 层，MAX_DEPTH 给的余量已经很宽松。
 *
 * 对齐 mediainfo.js 的做法（那里对同等不可信的二进制输入用了 depth < 8 + guard++ < 4096）。
 *
 * 放在文件前部而非紧挨使用处：下面 walkKmTopic / descendantsNamed /
 * buildKmNode / buildKmFromXmlTopic 四处递归都引用它，而它们分布在不同章节，
 * 放在使用点旁边会让其中三处形成「先引用后声明」（const 的 TDZ 在模块求值
 * 完成后虽不触发，但读起来像 bug）。
 */
export const MAX_DEPTH = 200;

/** 单次解析收集的节点总数上限，防「宽而不深」的炸弹 */
export const MAX_NODES = 200000;

async function inflateRaw(bytes, budget = null) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INFLATE_BYTES) {
      // 立刻取消底层流，别让剩余数据继续往内存里灌
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error('XMind 解压超限（zip bomb 防护）：单条目超过 ' + Math.round(MAX_INFLATE_BYTES / 1024 / 1024) + 'MB');
    }
    if (budget) {
      budget.used += value.byteLength;
      if (budget.used > MAX_TOTAL_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error('XMind 解压超限（zip bomb 防护）：整包超过 ' + Math.round(MAX_TOTAL_BYTES / 1024 / 1024) + 'MB');
      }
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.byteLength; }
  return out;
}

/* ============================================================
   三、ZIP 容器读写
   ============================================================ */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');
const decBom = new TextDecoder('utf-8');   // 读端带 BOM 容忍

/** DOS 日期时间：与 C# ZipArchive 写入的时间字段同格式（此处用当前时间） */
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 打包成 zip（Uint8Array）。
 * @param {Array<{name:string, data:Uint8Array}>} files
 */
export async function zipWrite(files) {
  const { time, date } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const raw = f.data;
    const crc = crc32(raw);

    const packed = await deflateRaw(raw);
    const useDeflate = packed != null && packed.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? packed : raw;

    // ---- 本地文件头 ----
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);          // version needed
    lh.setUint16(6, 0, true);           // flags
    lh.setUint16(8, method, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);          // extra len
    const lhBytes = new Uint8Array(lh.buffer);

    chunks.push(lhBytes, nameBytes, body);

    // ---- 中央目录项 ----
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);          // version made by
    ch.setUint16(6, 20, true);          // version needed
    ch.setUint16(8, 0, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);          // extra
    ch.setUint16(32, 0, true);          // comment
    ch.setUint16(34, 0, true);          // disk start
    ch.setUint16(36, 0, true);          // internal attrs
    ch.setUint32(38, 0, true);          // external attrs
    ch.setUint32(42, offset, true);     // local header offset
    central.push(new Uint8Array(ch.buffer), nameBytes);

    offset += lhBytes.length + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of chunks) { out.set(b, p); p += b.length; }
  for (const b of central) { out.set(b, p); p += b.length; }
  out.set(new Uint8Array(eocd.buffer), p);
  return out;
}

/**
 * 解包 zip。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function zipRead(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // 从尾部倒着找 EOCD（末尾可能有注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（未找到 EOCD）');

  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  const out = new Map();

  // 条目数是包里读出来的不可信值：EOCD 用 2 字节存，最大 65535。
  // 正常 .xmind 只有个位数条目 + 若干附件，超 MAX_ENTRY_COUNT 必然异常，直接拒。
  if (count > MAX_ENTRY_COUNT) {
    throw new Error('XMind 条目数异常（' + count + ' 条），拒绝解压');
  }
  // 整包预算：防「很多个刚好卡在单条上限下的条目」叠加成一颗大炸弹
  const budget = { used: 0 };

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = dec.decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));

    // 本地头偏移本身也不可信：越界时 getUint16 抛的是 RangeError，
    // 到用户那里就是一句看不懂的堆栈，这里提前转成明确的中文错误。
    if (localOff < 0 || localOff + 30 > buf.length) {
      throw new Error('XMind 条目头越界：' + name);
    }
    // 本地头里的 name/extra 长度可能与中央目录不一致，以本地头为准
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    // 越界即停：恶意包可让 dataStart + compSize 指到缓冲区外，
    // subarray 会静默截断，后续 inflate 拿到半截数据才报错，排查困难。
    if (dataStart < 0 || dataStart + compSize > buf.length) {
      throw new Error('XMind 条目数据越界：' + name);
    }
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      budget.used += raw.byteLength;
      if (budget.used > MAX_TOTAL_BYTES) {
        throw new Error('XMind 解压超限（zip bomb 防护）：整包超过 ' + Math.round(MAX_TOTAL_BYTES / 1024 / 1024) + 'MB');
      }
      out.set(name, raw);
    } else {
      out.set(name, await inflateRaw(raw, budget));
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ============================================================
   四、XMind 常量与映射（与 C# 版逐项对齐）
   ============================================================ */

const ContentEntry = 'content.json';
const NativeEntry = 'kityminder.json';
const MetadataEntry = 'metadata.json';
const ManifestEntry = 'manifest.json';
const LegacyContentEntry = 'content.xml';

/** XMind 进度标记（完成百分比升序）↔ kityminder progress(0..10) */
const ProgressMarkers = [
  'task-start', 'task-oct', 'task-quarter', 'task-3oct',
  'task-half', 'task-5oct', 'task-3quar', 'task-7oct', 'task-done',
];
const MarkerToProgress = [0, 1, 3, 4, 5, 6, 8, 9, 10];

/** kityminder data 键 → XMind style.properties 键 */
const StyleMap = [
  ['fill', 'svg:fill'],
  ['stroke', 'svg:stroke'],
  ['radius', 'svg:corner-radius'],
  ['forecolor', 'fo:color'],
  ['font-size', 'fo:font-size'],
  ['font-family', 'fo:font-family'],
  ['text-align', 'fo:text-align'],
];

export const XMIND_ENTRIES = { ContentEntry, NativeEntry, MetadataEntry, ManifestEntry, LegacyContentEntry };

/* ---------------- 小工具（对应 C# 的 Str/Num/Bool 等） ---------------- */

const str = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
};

const num = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const bool = (v) => {
  if (v === true) return true;
  const s = str(v);
  return s === '1' || (s != null && s.toLowerCase() === 'true');
};

const safeId = (id) => {
  const s = str(id);
  return s == null || s.trim() === '' ? null : s.trim();
};

const newNodeId = () => 'km' + Math.random().toString(36).slice(2, 12);
const newSheetId = () => 'sh' + Math.random().toString(36).slice(2, 12);
const shortId = (p) => p + Math.random().toString(36).slice(2, 2 + 8);

const pretty = (o) => JSON.stringify(o, null, 2);

/** kityminder progress → XMind marker */
function progressToMarker(progress) {
  const i = Math.max(0, Math.min(ProgressMarkers.length - 1,
    Math.round(Number(progress || 0) / 10 * (ProgressMarkers.length - 1))));
  return ProgressMarkers[i];
}

const toPx = (v) => (/px$/i.test(v.trim()) ? v.trim() : v.trim() + 'px');
const toPt = (v) => (/pt$/i.test(v.trim()) ? v.trim() : v.trim() + 'pt');
const fromPx = (v) => (/px$/i.test(v.trim()) ? v.trim().slice(0, -2).trim() : v.trim());
const fromPt = (v) => (/pt$/i.test(v.trim()) ? v.trim().slice(0, -2).trim() : v.trim());

/** kityminder 尺寸串（"120*80" / "120,80"）→ {w,h} */
function parseSize(s) {
  const t = str(s);
  if (!t) return { w: 0, h: 0 };
  const parts = t.split(/[*xX,\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    const w = num(parts[0]);
    const h = num(parts[1]);
    if (w != null && h != null) return { w, h };
  }
  return { w: 0, h: 0 };
}

/** 本地路径 → file URI。Web 沙箱拿不到真实路径，仅用于兼容 C# 版产出的文件 */
function toFileUri(path) {
  const s = str(path);
  if (!s) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;   // 已是 URI
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s)) {
    return 'file:///' + s.replace(/\\/g, '/').replace(/^\//, '');
  }
  return null;
}

/** file:/// URI → 路径；非 file 协议返回 null */
function fromFileUri(href) {
  const s = str(href);
  if (!s || !/^file:/i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'file:') return null;
    let p = decodeURIComponent(u.pathname || '');
    // Windows：/C:/foo → C:/foo
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p || null;
  } catch {
    return null;
  }
}

/** 包内相对路径引用（resources/…），不是其它协议 */
const isPackRef = (href) => {
  const s = str(href);
  return !!s && /^resources\//i.test(s) && !s.includes('://');
};

/**
 * 把节点的附件字段解析成**列表**。
 *
 * 与 io.js 的 decodeRefList 同构（xmind.js 不 import io，避免循环依赖）。
 * 规则一致：写一定是数组串，读两者都认 —— 老数据（单对象串 / 纯路径串）
 * 包成单元素数组，这样下面三处循环都不用分支。
 */
function refListOf(raw) {
  const v = str(raw);
  if (!v) return [];
  if (v[0] === '[') {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.filter(Boolean);
    } catch { /* 退回单值 */ }
  }
  return [raw];
}

const isVideoName = (n) => /\.(mp4|webm|ogg|ogv|mov|mkv|avi|wmv|flv|m4v)$/i.test(String(n || ''));

/** 文件名净化：非法字符 → 下划线，去首尾空白/点，绝不返回空串 */
function sanitizeFileName(name) {
  let s = String(name || '');
  if (!s) return 'attach';
  s = s.replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '_');
  s = s.trim().replace(/^\.+/, '').replace(/\.+$/, '').trim();
  return s.length ? s : 'attach';
}

/**
 * 剥掉打包时加的 kma_<序号>_ 前缀。
 * 不解掉的话，每次「导出→导入→再导出」都会在文件名上再叠一层前缀
 * （报告.pdf → kma_0_报告.pdf → kma_0_kma_0_报告.pdf …），无限累积。
 */
function stripPackSeq(name) {
  return String(name || '').replace(/^kma_\d+_/, '');
}

/**
 * 从附件引用里取出真实文件名。
 *
 * 两种形态都要支持：
 *   1) 插件版引用串：'{"n":"设计稿.pdf","a":"asFILE001","s":70}' —— 取 n 字段；
 *   2) 文件路径：'D:\\x\\演示.mp4' 或包内 'resources/kma_0_设计稿.pdf' —— 取 basename。
 *
 * 早期版本直接对引用串做 split('/').pop()，把整个 JSON 当文件名，
 * 且末尾是 '}' 导致扩展名丢失 —— 导入后无法按扩展名判断视频，附件放不了。
 */
function assetFileName(refRaw) {
  const s = String(refRaw || '').trim();
  if (!s) return 'attach';
  if (s[0] === '{') {
    try {
      const o = JSON.parse(s);
      const n = o && (o.n || o.name);
      if (n && String(n).trim()) return String(n).trim();
    } catch { /* 不是合法 JSON，按路径处理 */ }
  }
  // 路径：统一分隔符后取最后一段
  return (s.replace(/\\/g, '/').split('/').pop() || 'attach');
}

function parseKm(content) {
  if (content == null) return null;
  try {
    const o = typeof content === 'string' ? JSON.parse(content) : content;
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 对 kityminder 整本逐节点执行 action。节点结构 { data, children:[…] } */
function walkKmNodes(km, action) {
  walkKmTopic(km?.root, action);
}

function walkKmTopic(node, action, depth = 0) {
  if (!node || depth > MAX_DEPTH) return;
  action(node);
  if (Array.isArray(node.children)) for (const c of node.children) walkKmTopic(c, action, depth + 1);
}

/* ============================================================
   五、写：kityminder → content.json
   ============================================================ */

function buildContentJson(sheets, packs) {
  const arr = [];
  for (const s of sheets) {
    const km = parseKm(s.content);
    if (!km) continue;
    arr.push({
      id: s.id,
      class: 'sheet',
      title: s.title,
      rootTopic: buildTopic(km.root, packs),
    });
  }
  if (arr.length === 0) {
    arr.push({
      id: newSheetId(),
      class: 'sheet',
      title: '画布 1',
      rootTopic: buildTopic(null, packs),
    });
  }
  return pretty(arr);
}

function buildTopic(kmNode, packs) {
  const data = kmNode?.data || {};
  const topic = {
    id: safeId(data.id),
    class: 'topic',
    title: str(data.text) ?? '',
  };

  const note = str(data.note);
  if (note) topic.notes = { plain: { content: note } };

  // href：超链接优先；无超链接时把视频/文件附件写入（视频优先）。
  // 已打包的写包内相对路径，未打包的写 file:/// 本地路径。
  let href = str(data.hyperlink);
  if (!href || !href.trim()) {
    let att = str(data.video) || str(data.file);
    if (att && att.trim()) {
      href = packs && packs.has(att) ? packs.get(att) : (toFileUri(att) || att);
    }
  }
  if (href && href.trim()) topic.href = href;

  const markers = [];
  const priority = num(data.priority);
  if (priority >= 1 && priority <= 9) markers.push({ markerId: 'priority-' + Math.round(priority) });
  const progress = num(data.progress);
  if (progress > 0 && progress <= 10) markers.push({ markerId: progressToMarker(progress) });
  if (markers.length) topic.markers = markers;

  const labels = buildLabels(data.labels);
  if (labels) topic.labels = labels;

  const img = buildImage(data);
  if (img) topic.image = img;

  const props = buildStyle(data);
  if (props && Object.keys(props).length) {
    topic.style = { id: shortId('st'), properties: props };
  }

  if (Array.isArray(kmNode?.children) && kmNode.children.length) {
    const attached = [];
    const pairs = [];
    for (const c of kmNode.children) {
      if (!c) continue;
      const child = buildTopic(c, packs);
      attached.push(child);
      pairs.push({ xid: child.id, km: c });
    }
    if (attached.length) {
      topic.children = { attached };
      const bounds = buildBoundaries(pairs);
      if (bounds) topic.boundaries = bounds;
    }
  }
  return topic;
}

function buildLabels(node) {
  if (Array.isArray(node)) {
    const out = node.map(str).filter((s) => s && s.trim());
    return out.length ? out : null;
  }
  const s = str(node);
  return s && s.trim() ? [s] : null;
}

function buildImage(data) {
  const src = str(data.image);
  if (!src || !src.trim()) return null;
  const img = { src };
  const { w, h } = parseSize(data.imageSize);
  if (w > 0) img.width = w;
  if (h > 0) img.height = h;
  const title = str(data.imageTitle);
  if (title && title.trim()) img.title = title;
  return img;
}

/** 把同组外框（boundaryGroup/boundaryLabel）汇总成父节点上的 XMind boundary 区间 */
function buildBoundaries(ordered) {
  const groups = new Map();
  ordered.forEach((item, i) => {
    const d = item.km?.data || {};
    const gid = str(d.boundaryGroup);
    if (!gid) return;
    const label = str(d.boundaryLabel) ?? '';
    const g = groups.get(gid);
    if (g) groups.set(gid, { first: g.first, last: i, label: g.label || label });
    else groups.set(gid, { first: i, last: i, label });
  });
  if (groups.size === 0) return null;

  const arr = [];
  for (const g of groups.values()) {
    const range = g.first === g.last
      ? '(' + ordered[g.first].xid + ')'
      : '(' + ordered[g.first].xid + ',' + ordered[g.last].xid + ')';
    arr.push({ id: shortId('bd'), class: 'boundary', title: g.label, range });
  }
  return arr;
}

function buildStyle(data) {
  const props = {};
  for (const [kmKey, xmKey] of StyleMap) {
    const v = str(data?.[kmKey]);
    if (v == null || !String(v).trim()) continue;
    props[xmKey] = kmKey === 'radius' ? toPx(v) : kmKey === 'font-size' ? toPt(v) : v;
  }
  if (bool(data?.bold)) props['fo:font-weight'] = 'bold';
  if (bool(data?.italic)) props['fo:font-style'] = 'italic';
  if (bool(data?.strikethrough)) props['fo:text-decoration'] = 'line-through';
  else if (bool(data?.underline)) props['fo:text-decoration'] = 'underline';
  return props;
}

/* ============================================================
   六、读：content.json（Zen）→ kityminder
   ============================================================ */

function parseZen(json) {
  let root;
  try {
    root = JSON.parse(json);
  } catch (e) {
    throw new Error('XMind content.json 解析失败：' + e.message);
  }
  const sheetNodes = [];
  if (Array.isArray(root)) sheetNodes.push(...root.filter((x) => x && typeof x === 'object'));
  else if (root && typeof root === 'object') sheetNodes.push(root);

  const sheets = [];
  let index = 0;
  const counter = { n: 0 };
  for (const sn of sheetNodes) {
    if (!sn.rootTopic) continue;
    index++;
    const kmRoot = buildKmNode(sn.rootTopic, 0, counter);
    if (!kmRoot) continue;   // 超深/超量被截断 —— 异常文件，跳过这张画布
    const doc = { root: kmRoot, template: 'default', theme: 'fresh-blue', version: '1.4.43' };
    sheets.push({
      id: safeId(sn.id) || newSheetId(),
      title: str(sn.title) || ('画布 ' + index),
      content: pretty(doc),
      theme: 'fresh-blue',
      layout: 'default',
    });
  }
  return { sheets };
}

function buildKmNode(topic, depth = 0, counter = null) {
  if (depth > MAX_DEPTH) return null;   // 超深截断，与 legacy 档同一标准
  if (counter) {
    // 「宽而不深」的炸弹：几十万个节点同样能让 JSON 序列化/渲染卡死
    counter.n++;
    if (counter.n > MAX_NODES) return null;
  }
  const data = {
    id: safeId(topic.id) || newNodeId(),
    created: Date.now(),
    text: str(topic.title) ?? '',
  };

  const note = str(topic.notes?.plain?.content) ?? str(topic.notes?.plain);
  if (note) data.note = note;

  // href 还原：file:/// → 文件/视频附件（视频按扩展名识别）；包内相对路径先存下来，
  // 稍后由 readXMind 统一解包；其它协议保留为超链接
  const href = str(topic.href);
  const localFile = fromFileUri(href);
  if (localFile) {
    if (isVideoName(localFile)) data.video = localFile;
    else data.file = localFile;
  } else if (isPackRef(href)) {
    data.file = href;
  } else if (href && href.trim()) {
    data.hyperlink = href;
  }

  if (Array.isArray(topic.markers)) {
    for (const m of topic.markers) {
      const mid = str(m?.markerId) ?? str(m);
      if (!mid) continue;
      const pm = /^priority-(\d+)$/.exec(mid);
      if (pm) {
        const p = Number(pm[1]);
        if (p >= 1 && p <= 9) data.priority = p;
      } else {
        const idx = ProgressMarkers.indexOf(mid);
        if (idx >= 0) data.progress = MarkerToProgress[idx];
      }
    }
  }

  if (Array.isArray(topic.labels) && topic.labels.length) {
    const arr = topic.labels.map(str).filter((s) => s && s.trim());
    if (arr.length) data.labels = arr;
  }

  if (topic.image && typeof topic.image === 'object') {
    const src = str(topic.image.src);
    if (src && src.trim()) {
      const w = num(topic.image.width);
      const h = num(topic.image.height);
      data.image = src;
      if (w > 0 && h > 0) data.imageSize = `${Math.round(w)}*${Math.round(h)}`;
      const t = str(topic.image.title);
      if (t && t.trim()) data.imageTitle = t;
    }
  }

  applyStyle(data, topic.style);

  const children = [];
  const pairs = [];
  if (topic.children && typeof topic.children === 'object') {
    for (const key of ['attached', 'detached', 'summary']) {
      const list = topic.children[key];
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (!c) continue;
        const kmChild = buildKmNode(c, depth + 1, counter);
        if (!kmChild) continue;   // 超深/超量被截断
        children.push(kmChild);
        pairs.push({ xid: safeId(c.id) || '', km: kmChild });
      }
    }
  }

  applyBoundaries(pairs, topic.boundaries);
  return { data, children };
}

/** 父节点上的 XMind boundary 区间 → 子节点的 boundaryGroup/boundaryLabel */
function applyBoundaries(pairs, boundaries) {
  if (!Array.isArray(boundaries) || !boundaries.length || !pairs.length) return;
  let seq = 0;
  for (const b of boundaries) {
    if (!b) continue;
    const range = str(b.range);
    if (!range || !range.trim()) continue;
    const ids = range.replace(/[()]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) continue;

    const indices = ids
      .map((id) => pairs.findIndex((p) => p.xid === id))
      .filter((i) => i >= 0);
    if (!indices.length) continue;

    const from = Math.min(...indices);
    const to = Math.max(...indices);
    const gid = 'bg' + ++seq;
    const label = str(b.title) ?? '';
    for (let i = from; i <= to && i < pairs.length; i++) {
      const d = pairs[i].km.data;
      if (!d || str(d.boundaryGroup)) continue;
      d.boundaryGroup = gid;
      d.boundaryLabel = label;
    }
  }
}

function applyStyle(data, style) {
  const props = style?.properties;
  if (!props) return;
  for (const [kmKey, xmKey] of StyleMap) {
    const v = str(props[xmKey]);
    if (v == null || !String(v).trim()) continue;
    data[kmKey] = kmKey === 'radius' ? fromPx(v) : kmKey === 'font-size' ? fromPt(v) : v;
  }
  const weight = str(props['fo:font-weight']);
  if (String(weight).toLowerCase() === 'bold' || (num(props['fo:font-weight']) ?? 0) >= 600) {
    data.bold = true;
  }
  const fs = str(props['fo:font-style']);
  if (String(fs).toLowerCase() === 'italic') data.italic = true;
  const deco = str(props['fo:text-decoration']);
  if (deco) {
    if (/line-through/i.test(deco)) data.strikethrough = true;
    if (/underline/i.test(deco)) data.underline = true;
  }
}

/* ============================================================
   七、读：content.xml（XMind 8 老版）→ kityminder
   ============================================================ */

/** 极简 XML 解析：够用即可，只取元素名/属性/文本/子节点 */
function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('XMind content.xml 解析失败：' + err.textContent);
  return doc;
}

const localName = (el) => (el.localName || el.nodeName || '').replace(/^.*:/, '');

function childrenOf(el, name) {
  const out = [];
  if (!el) return out;
  for (const c of el.children || []) if (localName(c) === name) out.push(c);
  return out;
}

function descendantsNamed(el, name, depth = 0) {
  const out = [];
  if (!el || depth > MAX_DEPTH) return out;
  const walk = (n, d) => {
    if (d > MAX_DEPTH) return;
    for (const c of n.children || []) {
      if (localName(c) === name) out.push(c);
      walk(c, d + 1);
    }
  };
  walk(el, depth);
  return out;
}

function parseLegacy(xml) {
  const doc = parseXml(xml);
  const sheets = [];
  let index = 0;
  for (const sheetEl of descendantsNamed(doc.documentElement, 'sheet')) {
    const topicEls = childrenOf(sheetEl, 'topic');
    if (!topicEls.length) continue;
    index++;
    const kmRoot = buildKmFromXmlTopic(topicEls[0]);
    if (!kmRoot) continue;   // 根节点就超深 —— 异常文件，跳过这张画布
    const titleEl = childrenOf(sheetEl, 'title')[0];
    const title = titleEl?.textContent?.trim();
    const wrapper = { root: kmRoot, template: 'default', theme: 'fresh-blue', version: '1.4.43' };
    sheets.push({
      id: sheetEl.getAttribute('id') || newSheetId(),
      title: title || ('画布 ' + index),
      content: pretty(wrapper),
      theme: 'fresh-blue',
      layout: 'default',
    });
  }
  return { sheets };
}

function buildKmFromXmlTopic(t, depth = 0) {
  if (depth > MAX_DEPTH) return null;   // 超深直接截断，不再下钻
  const data = {
    id: t.getAttribute('id') || newNodeId(),
    created: Date.now(),
    text: childrenOf(t, 'title')[0]?.textContent ?? '',
  };

  const notesEl = childrenOf(t, 'notes')[0];
  if (notesEl) {
    const text = (notesEl.textContent || '').trim();
    if (text) data.note = text;
  }

  const href = t.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || t.getAttribute('href');
  if (href && href.trim()) data.hyperlink = href;

  for (const mr of descendantsNamed(t, 'marker-ref').concat(descendantsNamed(t, 'marker'))) {
    const mid = mr.getAttribute('marker-id') || mr.getAttribute('markerId');
    if (!mid) continue;
    const pm = /^priority-(\d+)$/.exec(mid);
    if (pm) {
      const p = Number(pm[1]);
      if (p >= 1 && p <= 9) data.priority = p;
    } else {
      const idx = ProgressMarkers.indexOf(mid);
      if (idx >= 0) data.progress = MarkerToProgress[idx];
    }
  }

  const labelsEl = childrenOf(t, 'labels')[0];
  if (labelsEl) {
    const arr = childrenOf(labelsEl, 'label')
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean);
    if (arr.length) data.labels = arr;
  }

  const imgEl = descendantsNamed(t, 'img')[0];
  const imgSrc = imgEl?.getAttribute('src')
    || imgEl?.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
  if (imgSrc && imgSrc.trim()) data.image = imgSrc;

  const children = [];
  const pairs = [];
  const topicsEl = childrenOf(t, 'children')[0];
  if (topicsEl) {
    for (const topics of childrenOf(topicsEl, 'topics')) {
      for (const child of childrenOf(topics, 'topic')) {
        const kmChild = buildKmFromXmlTopic(child, depth + 1);
        if (!kmChild) continue;   // 超深被截断
        children.push(kmChild);
        pairs.push({ xid: child.getAttribute('id') || '', km: kmChild });
      }
    }
  }

  applyXmlBoundaries(pairs, childrenOf(t, 'boundaries')[0]);
  return { data, children };
}

/** 老版 boundary 结构各家写法不一，做宽容解析：任意后代的 idref/ref/id 属性或文本里的 id 都收 */
function applyXmlBoundaries(pairs, boundariesEl) {
  if (!boundariesEl || !pairs.length) return;
  let seq = 0;
  for (const b of childrenOf(boundariesEl, 'boundary')) {
    const ids = [];
    const walk = (n) => {
      for (const d of n.children || []) {
        for (const attr of ['idref', 'ref', 'id']) {
          const v = d.getAttribute?.(attr);
          if (v && v.trim()) ids.push(v.trim());
        }
        const ln = localName(d);
        if (ln === 'topic-range' || ln === 'range') {
          const txt = (d.textContent || '').trim();
          if (txt) ids.push(...txt.split(/[\s,;\t\n\r]+/).filter(Boolean));
        }
        walk(d);
      }
    };
    walk(b);
    if (!ids.length) continue;

    const unique = [...new Set(ids)];
    const indices = unique
      .map((id) => pairs.findIndex((p) => p.xid === id))
      .filter((i) => i >= 0);
    if (!indices.length) continue;

    const gid = 'bg' + ++seq;
    const label = childrenOf(b, 'title')[0]?.textContent ?? '';
    for (let i = Math.min(...indices); i <= Math.max(...indices) && i < pairs.length; i++) {
      const d = pairs[i].km.data;
      if (!d || str(d.boundaryGroup)) continue;
      d.boundaryGroup = gid;
      d.boundaryLabel = label;
    }
  }
}

/* ============================================================
   八、对外 API
   ============================================================ */

/**
 * 导出为 .xmind 文件的 Blob。
 *
 * @param {Array} sheets 画布数组 [{id,title,content,theme,layout}]
 * @param {string} activeId 激活画布 id
 * @param {(ref:string)=>Promise<Uint8Array|null>} [loadAsset] 附件读取回调：
 *        传入节点 data.file/video 里存的引用，返回文件字节；返回 null 表示附件不可用（跳过打包）。
 *        不传则不打包附件，仅把引用原样写进 content.json 的 href。
 */
export async function writeXMind(sheets, activeId, loadAsset = null) {
  const list = Array.isArray(sheets) ? sheets : [];

  // 1) 收集附件：把节点上的引用换成包内路径
  const packs = new Map();      // 原引用 → 包内相对路径
  const resources = [];         // { name, data }
  if (loadAsset) {
    let seq = 0;
    for (const s of list) {
      const km = parseKm(s.content);
      if (!km) continue;
      walkKmNodes(km, (node) => {
        const d = node.data;
        if (!d) return;
        for (const key of ['file', 'video']) {
          // 一个节点可挂多个（data 里是 JSON 数组串），逐个打包
          const list = refListOf(d[key]);
          for (const one of list) {
            const p = str(one);
            if (!p || !p.trim() || packs.has(p)) continue;
            // 用真实文件名（引用串取 n 字段 / 路径取 basename），不能直接拿引用串当名字
            const base = stripPackSeq(assetFileName(p));
            const extMatch = /(\.[a-zA-Z0-9]+)$/.exec(base);
            const ext = extMatch ? extMatch[1] : '';
            const baseSafe = sanitizeFileName(base.replace(/(\.[a-zA-Z0-9]+)$/, ''));
            const packName = `resources/kma_${seq}_${baseSafe}${ext}`;
            seq++;
            // 立即读取；读不到就不打包（引用保持原样）
            packs.set(p, packName);
            resources.push({ name: packName, ref: p });
          }
        }
      });
    }
    // 真正读取字节（上面的循环只定了名字）
    const packed = [];
    for (const r of resources) {
      const data = await loadAsset(r.ref);
      if (data && data.length) packed.push({ name: r.name, data });
      else {
        // 附件不可用：回退成"不打包"，把映射撤掉
        for (const [k, v] of packs) if (v === r.name) packs.delete(k);
      }
    }
    resources.length = 0;
    resources.push(...packed);
  }

  // 2) 无损快照：附件引用改写成包内相对路径（与 C# RewriteSnapshot 一致）
  const snapshotSheets = list.map((s) => {
    const km = parseKm(s.content);
    if (!km || packs.size === 0) return { id: s.id, title: s.title, theme: s.theme, layout: s.layout, content: s.content };
    walkKmNodes(km, (node) => {
      const d = node.data;
      if (!d) return;
      for (const key of ['file', 'video']) {
        const list = refListOf(d[key]);
        if (!list.length) continue;
        // 数组串 → 逐项替换 → 写回数组串（保持"写一定是数组"的约定）
        let changed = false;
        const out = list.map((one) => {
          const p = str(one);
          if (p && packs.has(p)) { changed = true; return packs.get(p); }
          return one;
        });
        if (changed) d[key] = JSON.stringify(out);
      }
    });
    return { id: s.id, title: s.title, theme: s.theme, layout: s.layout, content: pretty(km) };
  });

  const files = [
    ...resources.map((r) => ({ name: r.name, data: r.data })),
    { name: ContentEntry, data: enc.encode(buildContentJson(list, packs)) },
    {
      name: NativeEntry,
      data: enc.encode(pretty({
        kind: 'nexus-mindmap-workbook',
        version: 1,
        activeId: activeId || list[0]?.id || '',
        sheets: snapshotSheets,
      })),
    },
    {
      name: MetadataEntry,
      data: enc.encode('{"layoutEngineVersion":"3","creator":{"name":"分配项目组"}}'),
    },
    {
      name: ManifestEntry,
      data: enc.encode('{"file-entries":{"content.json":{},"metadata.json":{},"manifest.json":{}}}'),
    },
  ];

  return new Blob([await zipWrite(files)], { type: 'application/vnd.xmind.workbook' });
}

/**
 * 读取 .xmind 文件。
 *
 * @param {ArrayBuffer|Uint8Array|Blob} input
 * @param {(name:string, data:Uint8Array, meta:object)=>Promise<string|null>} [saveAsset]
 *        附件落地回调：把包内 resources/ 的文件存起来，返回新的引用串；返回 null 则保留包内路径字符串。
 * @returns {Promise<{sheets:Array, activeId:string, source:string, attachments:number}>}
 *          source 标明数据来自哪一档：'native' | 'zen' | 'legacy'
 */
export async function readXMind(input, saveAsset = null) {
  let buf = input;
  if (input instanceof Blob) buf = await input.arrayBuffer();
  const entries = await zipRead(buf);

  const readText = (name) => {
    const d = entries.get(name);
    return d ? decBom.decode(d) : null;
  };

  let wb = null;
  let source = '';

  // 1) 本工具无损快照优先
  const native = readText(NativeEntry);
  if (native) {
    try {
      const o = JSON.parse(native);
      if (Array.isArray(o?.sheets) && o.sheets.length) {
        wb = { sheets: o.sheets, activeId: o.activeId };
        source = 'native';
      }
    } catch { /* 坏快照继续往下走 */ }
  }

  // 2) XMind Zen / 2020+
  if (!wb) {
    const content = readText(ContentEntry);
    if (content) {
      const r = parseZen(content);
      if (r.sheets.length) { wb = r; source = 'zen'; }
    }
  }

  // 3) XMind 8 及更早
  if (!wb) {
    const legacy = readText(LegacyContentEntry);
    if (legacy) {
      const r = parseLegacy(legacy);
      if (r.sheets.length) { wb = r; source = 'legacy'; }
    }
  }

  if (!wb || !wb.sheets?.length) {
    throw new Error('不是有效的 XMind 文件（未找到 content.json / content.xml）');
  }

  // 4) 解包 resources/ 附件：包内引用 → saveAsset 返回的新引用。
  //    先并发落地全部附件，等所有引用都改写完再统一序列化画布，避免半改状态。
  const tasks = [];
  // 记下「画布 ↔ 已解析对象」的配对：改写的是解析出来的对象，
  // 序列化时必须复用同一个对象。若最后再 parseKm(s.content) 一次，
  // 拿到的是未改写的副本，附件引用会原样留在资源包路径上。
  const touched = [];
  // 多附件：每个节点的每个字段一组「等齐了再写回」的占位
  const pending = [];
  let attachments = 0;

  if (saveAsset) {
    for (const s of wb.sheets) {
      const km = parseKm(s.content);
      if (!km) continue;
      touched.push({ sheet: s, km });
      walkKmNodes(km, (node) => {
        const d = node.data;
        if (!d) return;
        for (const key of ['file', 'video']) {
          // 多附件：数组里每一项单独还原；任一项失败不影响其它
          const list = refListOf(d[key]);
          if (!list.length) continue;
          const out = new Array(list.length);
          // 写回必须等所有 saveAsset 都返回后再做（见下方 pending）
          pending.push({ d: d, key: key, out: out });
          list.forEach((one, idx) => {
            const v = str(one);
            out[idx] = one;                       // 先原样占位，失败就保持原引用
            if (!v || !isPackRef(v)) return;
            const data = entries.get(v);
            if (!data) return;
            const name = stripPackSeq(sanitizeFileName(v.split('/').pop() || 'attach'));
            tasks.push(
              Promise.resolve(saveAsset(name, data, { video: key === 'video' }))
                .then((ref) => {
                  if (ref) { out[idx] = ref; attachments++; }
                })
                .catch(() => { /* 单个附件失败不影响整体导入 */ }),
            );
          });
          // 注意：**不能在这里写回**。out[idx] 此刻还是占位值（包内路径），
          // saveAsset 尚未 resolve —— 写进去就把路径固化了，
          // 结果是「导出再导入后附件引用仍是 resources/…，全部打不开」。
        }
      });
    }
  }
  await Promise.all(tasks);
  // **所有引用都回来了才写回** —— 顺序不能反，反了就是路径固化（附件全打不开）
  for (const q of pending) {
    const filled = q.out.filter(Boolean);
    if (filled.length) q.d[q.key] = JSON.stringify(filled);
  }
  for (const t of touched) t.sheet.content = pretty(t.km);

  return {
    sheets: wb.sheets,
    activeId: wb.activeId || wb.sheets[0]?.id || '',
    source,
    attachments,
  };
}

/** 供 UI 判断文件是否是 .xmind */
export const isXMindName = (name) => /\.xmind$/i.test(String(name || ''));
