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
import { htmlToPlain, plainToHtml, elToPlain, isCollapsed, fontSizeNum } from './formats.js';

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

/** 单张画布保留的关系线条数上限（BUG 122） */
export const MAX_RELATIONSHIPS = 2000;

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
/** XMind 8 的样式表：topic 只带 `style-id`，真正的属性在 styles.xml 里 */
const LegacyStylesEntry = 'styles.xml';

/**
 * XMind 进度标记（完成百分比升序）↔ kityminder progress(**1..9**）
 *
 * ⓘ kityminder 的 progress 是 **1..9** 而不是 0..10 —— 内核 ProgressRenderer
 *   就是这么画的：`pie.setAngle(-360 * (p - 1) / 8)`，p=1 → 0°（空），
 *   p=9 → -360°（满），且 `check.setVisible(9 === p)` 只在 9 时打勾。
 *   面板徽章的 tooltip 写的也是「进度 3/9」。
 *
 *   早先这里按 0..10 建表（MarkerToProgress = [0,1,3,4,5,6,8,9,10]），于是
 *   ① 本工具导出的 progress 2 回来变 3、7 回来变 8（9 档里 2 档静默改值）；
 *   ② 导入别的软件的 task-done 得到 10 —— 超出取值域，进度条被画成
 *      -405°（而不是 -360°），且不打勾。
 */
const ProgressMarkers = [
  'task-start', 'task-oct', 'task-quarter', 'task-3oct',
  'task-half', 'task-5oct', 'task-3quar', 'task-7oct', 'task-done',
];
/** 9 个标记 ↔ progress 1..9，一一对应（XMind 的 0% 就是 kityminder 的 1） */
const MarkerToProgress = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * 布局 ↔ XMind 的 structureClass（写在 rootTopic 上）
 *
 * ⓘ 只列**有标准对应值**的四种。`default`（思维导图）刻意**不写** ——
 *   XMind 自家的默认图型是 balanced/clockwise 之一，猜错一个就会让文件
 *   在 XMind 里呈现出另一种排布；不写则由 XMind 按它自己的默认来，反而
 *   最接近我们的「思维导图」。`tianpan`（天盘图）XMind 没有对应结构，
 *   同样不写。
 */
const LayoutToStructure = {
  right: 'org.xmind.ui.logic.right',
  structure: 'org.xmind.ui.org-chart.down',
  filetree: 'org.xmind.ui.tree.right',
  'fish-bone': 'org.xmind.ui.fishbone.leftHeaded',
};
const StructureToLayout = Object.fromEntries(
  Object.entries(LayoutToStructure).map(([k, v]) => [v, k]));

/**
 * 本工具**认识**的 XMind 标记：只有 priority-1..9（优先级）和
 * ProgressMarkers（进度）有对应的 kityminder 字段，其余一概没有 ——
 * 内核压根没有 marker 概念（只有 priority / progress 两个 data 键）。
 *
 * ⓘ 不认识的标记不能丢：它们在 XMind 里是**可见内容**（红旗、星星、
 *   问号、人物、月份…），静默丢掉等于改了别人的文件。所以读进来时存进
 *   data.xmarkers，导出时原样写回 —— 本工具不显示它们，但也不会弄丢
 *   （BUG 110）。
 */
const KNOWN_MARKER_ID = /^(priority-[1-9])$/;
/** 写回时才做的白名单：拒绝把任意字符串塞进 markerId */
const SAFE_MARKER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 该标记 id 本工具是否认识（认识=已转成 priority/progress，不必再存） */
function isKnownMarker(mid) {
  return KNOWN_MARKER_ID.test(mid) || ProgressMarkers.indexOf(mid) >= 0;
}

/** 读侧：把不认识的 markerId 收集进 data.xmarkers（去重、保序、上限保护） */
function collectXMarkers(data, mid) {
  if (!mid || isKnownMarker(mid) || !SAFE_MARKER_ID.test(mid)) return;
  const cur = Array.isArray(data.xmarkers) ? data.xmarkers : [];
  if (cur.indexOf(mid) >= 0) return;
  if (cur.length >= 20) return;          // 异常文件里的海量标记，别把 data 撑爆
  data.xmarkers = cur.concat([mid]);
}

/**
 * kityminder **节点级** data 键 → XMind style.properties 键
 *
 * ⓘ 左侧必须取内核真正用的那套键名，不能照抄 XMind / 主题的命名：
 *   · 填充是 `background`（不是 `fill`）—— 主题键是 root-fill / main-fill，
 *     节点级若也用 fill，会被 getStyle 的前缀拼接吃掉，故本项目用 background；
 *   · 描边 / 描边线宽 / 圆角 / 连线色 / 连线宽同理，都带 `node-` 前缀；
 *   · 文字色是 `color`（不是 `forecolor`）—— forecolor 是**命令名**不是 data 键。
 *
 *   早先这里写的是 fill / stroke / radius / forecolor，四个键**内核里一个都不存在**，
 *   于是节点自定义样式在 XMind 往返中几乎全丢：只有字号、字体、水平对齐能回来，
 *   填充、描边、描边线宽、圆角、连线色、连线宽、文字色 7 项静默消失 ——
 *   给用户标红的重要节点导出再打开就变回默认配色，且不报错。
 */
const StyleMap = [
  ['background', 'svg:fill'],
  ['node-stroke', 'svg:stroke'],
  ['node-stroke-width', 'svg:stroke-width'],
  ['node-radius', 'svg:corner-radius'],
  ['node-line-stroke', 'line-color'],
  ['node-line-width', 'line-width'],
  ['color', 'fo:color'],
  ['font-size', 'fo:font-size'],
  ['font-family', 'fo:font-family'],
  ['text-align', 'fo:text-align'],
  /*
   * 垂直对齐 XMind **没有**对应的标准属性（它的节点文字固定居中）。
   * 走私有键保住本工具的往返，避免「设了垂直：下 → 导出再导入 → 变回居中」。
   * 私有键只在真的设了值时才写，别的软件忽略未知键，无害。
   */
  ['vertical-align', 'nexusValign'],
];

/** 这几个键 XMind 里带 px 单位（其余原样，font-size 走 pt） */
const StylePxKeys = new Set(['node-radius', 'node-stroke-width', 'node-line-width']);

export const XMIND_ENTRIES = { ContentEntry, NativeEntry, MetadataEntry, ManifestEntry, LegacyContentEntry, LegacyStylesEntry };

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

/**
 * kityminder progress(**1..9**) → XMind marker
 *
 * progress 1 就是 0%（空饼），9 就是 100%（满饼 + 打勾），故下标 = p - 1。
 * 越界值一律钳到两端：导入别的软件的文件可能给出 0 / 10，不钳会写出
 * undefined 标记。
 */
function progressToMarker(progress) {
  const p = Math.round(Number(progress) || 0);
  const i = Math.max(0, Math.min(ProgressMarkers.length - 1, p - 1));
  return ProgressMarkers[i];
}

const toPx = (v) => (/px$/i.test(v.trim()) ? v.trim() : v.trim() + 'px');
const fromPx = (v) => (/px$/i.test(v.trim()) ? v.trim().slice(0, -2).trim() : v.trim());

/**
 * 字号里的**数字部分**。
 *
 * 只剥单位、不做 pt↔px 换算：本工具写出去的一律是 pt（见 toPt），读回来
 * 剥掉 pt 就与原值一致；别处写 pt 时同样自洽。
 *
 * ⓘ **不能原样保留带单位的值**。内核算文字基线时用的是 `line-height *
 *   font-size`（kityminder.core 里 `l = h*i*g.length-(h-1)*i`）—— 传进去
 *   是 `"20px"` 的话 `1.5 * "20px"` = **NaN**，实测该节点：
 *     `<text y="NaN">`、外层 `transform="translate( 0 NaN )"` → 控制台两条
 *     「Expected length "NaN"」，文字位置整个错乱（包围盒 y=0）。
 *   而 XMind 规范写的是 pt，各类实现/生成工具却常写 px —— 于是「导入别人的
 *   .xmind」就足以触发（BUG 117）。"1.2em"、"large" 同理。
 *
 * ⓘ 拿不到数字（`'large'` 之类）时返回 null：让调用方**不设**这个键，
 *   回落主题默认字号 —— 比塞一个 NaN 进去好得多。
 */
/* fontSizeNum 已提到 formats.js（BUG 127：FreeMind 的 <font SIZE> 同样要剥单位） */

/**
 * 写侧：一律归一成 `<数字>pt`。
 *
 * 存量的 `data['font-size']` 可能是 `"20px"`（早期从别的软件导入时单位没剥
 * 掉，或样式刷复制来的）。原来的 `toPt` 只在**结尾是 pt** 时才不追加 ——
 * `"20px"` 会被拼成 **`"20pxpt"`**，一个根本不存在的单位，写回文件里污染
 * 数据（BUG 117）。
 */
const toPt = (v) => {
  const n = fontSizeNum(v);
  return n ? n + 'pt' : null;
};

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

/**
 * 读 data.imageSize。两种形态都认：
 *
 *   · {width, height} —— 编辑器 image 命令写的，也是**内核 ImageRenderer 读的**
 *     （它直接用 g.width / g.height）。
 *   · "320*240" —— 早先 zen 导入写成这种（历史包袱）。
 *
 * 只认字符串正是「导入后图片不显示」的根因：内核拿到字符串时
 * g.width / g.height 是 undefined，算出的宽高是 0 —— 实测 <image> 的
 * width/height 属性就是 "0"，图上什么都没有，且不报错。
 */
function sizeOf(v) {
  if (v && typeof v === 'object') {
    const w = num(v.width);
    const h = num(v.height);
    return { w: w > 0 ? w : 0, h: h > 0 ? h : 0 };
  }
  return parseSize(v);
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

/**
 * XMind 里的资源引用有两种写法，指向**同一个**包内文件：
 *
 *   · `xap:attachments/xxx.png` —— `xap:` 是 XML 命名空间前缀，**不是**真实路径，
 *     剥掉它才是 zip 里的地址（XMind 8 写 attachments/，XMind 2020+ 常用
 *     resources/）。这是各版本都在用的标准写法。
 *   · `resources/xxx.png` / `attachments/xxx.png` —— 不带前缀。
 *
 * ⓘ 早先这里只认裸 `resources/`，`xap:` 前缀一概不认（BUG 118）。后果分两半：
 *     · 图片 `topic.image.src = "xap:attachments/p.png"` 原样落到 data.image，
 *       内核 <image> 拿它当 URL 加载 → 控制台两条
 *       「net::ERR_UNKNOWN_URL_SCHEME」，节点图**显示不出来**；
 *     · 附件 `href = "xap:resources/r.pdf"` 更是被下面那条 `else` 当成了
 *       **超链接**存起来 —— 附件本体丢失，还多一条打不开的乱码链接。
 *   而包里的字节明明就在（entries 里有），只是取不到。
 */
const packPathOf = (ref) => {
  const s = str(ref);
  if (!s || s.includes('://')) return null;          // http / data 等协议
  const p = s.replace(/^xap:/i, '').trim();
  if (!p || p.startsWith('/')) return null;
  /*
   * 只认这两个资源目录。放宽成"任何相对路径都算"会把裸文件名（`xap:child.png`
   * 之类）也吞进来，改变既有判定；而 XMind 各版本的资源只放这两个目录。
   */
  return /^(resources|attachments)\//i.test(p) ? p : null;
};

/** 包内相对路径引用 → zip 里的真实条目名；不是包内引用返回 null */
const isPackRef = (href) => packPathOf(href) !== null;

/** 图片扩展名 → MIME。认不出的回落 png（内联串总要带个类型，内核才画） */
const ImgMime = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
};

/**
 * 包内图片字节 → dataURI。
 *
 * 图片**不能**走 saveAsset：那返回的是资产引用串（JSON 对象），内核
 * ImageRenderer 直接塞进 <image href>，那样的串加载不出来；而 data.image
 * 在本工具里一律是 dataURI（io.imageToInline 的产物），内联才是一致的。
 *
 * 分块拼串：几十 KB 以上的图片一次性 `apply` 会爆栈。
 */
function bytesToDataUri(bytes, name) {
  if (!bytes || !bytes.length) return null;
  const ext = (/(\.[a-zA-Z0-9]+)$/.exec(String(name || ''))?.[1] || '').slice(1).toLowerCase();
  const mime = ImgMime[ext] || 'image/png';
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  try {
    return 'data:' + mime + ';base64,' + btoa(bin);
  } catch {
    return null;
  }
}

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
 * 取一个话题的备注文本。
 *
 * **plain 优先**（它是纯文本、不含标签）；没有 plain 才回落到 realHTML。
 * 两者都写了时以 plain 为准，本工具自己导出的文件才不会因为多写一份
 * realHTML 而改变往返结果。
 */
function topicNote(notes) {
  const p = str(notes?.plain?.content) ?? str(notes?.plain);
  if (p && p.trim()) return p;
  const h = str(notes?.realHTML?.content) ?? str(notes?.realHTML);
  return h ? htmlToPlain(h) : '';
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

/**
 * 把布局写成 rootTopic.structureClass。
 *
 * 没有对应值的（default / tianpan / 未知）**不写这个键** —— 见 LayoutToStructure。
 */
function withStructure(rootTopic, layout) {
  const sc = LayoutToStructure[str(layout) || ''];
  if (!sc || !rootTopic) return rootTopic;
  rootTopic.structureClass = sc;
  return rootTopic;
}

function buildContentJson(sheets, packs) {
  const arr = [];
  for (const s of sheets) {
    const km = parseKm(s.content);
    if (!km) continue;
    arr.push({
      id: s.id,
      class: 'sheet',
      title: s.title,
      rootTopic: withStructure(buildTopic(km.root, packs), s.layout),
      // BUG 122：关系线原样写回（死链先滤掉，见 buildRelationships）
      ...(rels => (rels ? { relationships: rels } : {}))(buildRelationships(s.xrelationships, km)),
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

/**
 * 保留下来的关系线 → XMind 的 `sheet.relationships`。
 *
 * **死链必须滤掉**：只要有一端不在本画布里（节点被删了、超深被截断、
 * 源文件里这条关系本来就没写 id），写出去就是一条指向不存在的 id 的关系
 * 线 —— 别的软件打开会画出一条挂在空处的线，**比不写更糟**。
 * 与 boundary 那句 `if (!a || !b) return;`（引用不到的 id 写了也是死链）同口径。
 */
function buildRelationships(list, km) {
  if (!Array.isArray(list) || !list.length) return null;
  const ids = new Set();
  walkKmNodes(km, (n) => {
    const i = safeId(n?.data?.id);
    if (i) ids.add(i);
  });
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const a = str(r.end1Id);
    const b = str(r.end2Id);
    if (!a || !b || !ids.has(a) || !ids.has(b)) continue;
    const one = { id: str(r.id) || shortId('rel'), end1Id: a, end2Id: b };
    const t = str(r.title);
    if (t != null) one.title = t;
    out.push(one);
  }
  return out.length ? out : null;
}

function buildTopic(kmNode, packs) {
  const data = kmNode?.data || {};
  const topic = {
    // BUG 136：没有 data.id 的节点（从 .mm / .opml / .md 等交换格式导入
    // 建出来的一律没有 id）导出后 topic.id 是 null —— 而外框与关系线都是
    // **按 id 引用**的，引用不到就整条写不出去（外框静默消失、关系线被当
    // 死链滤掉）。XMind 的 topic 本来就该有 id，缺了就生成一个。
    id: safeId(data.id) || shortId('t'),
    class: 'topic',
    title: str(data.text) ?? '',
  };

  /*
   * **折叠状态走 `branch: "folded"`**。
   *
   * XMind 把这个状态挂在主题上，键是 `branch`、值是字符串 `folded`
   * —— 不是 `folded: true`。早先写侧不写、读侧也不读，于是：
   *
   *   · 文件被别的 XMind 软件存过一遍（本工具的无损快照 kityminder.json
   *     被丢掉）→ 导回时**折叠状态全部丢失**，展开/收起全乱
   *   · 别的软件打开我们导出的文件 → 看不到哪些分支是收起的
   *
   * 折叠是看得见的结构（节点旁那个带数字的小圆点就是折叠徽标），
   * 静默丢掉会让人以为文件被改过。
   *
   * ⓘ 只走 zen 档（content.json）；XMind 8 的 content.xml 那套老格式
   *   折叠字段写法不统一，不在本次范围内。
   */
  if (isCollapsed(kmNode)) topic.branch = 'folded';

  const note = str(data.note);
  /*
   * **plain 与 realHTML 两份都写**。
   *
   * XMind 的规范里备注就是双字段（plain = 纯文本、realHTML = XHTML），
   * 各类实现普遍两份都写以保证跨版本兼容。只写 plain 的话，某些读
   * realHTML 的软件/版本打开我们导出的文件会**看不到备注**。
   *
   * 往返不受影响：读回时 topicNote() 以 plain 为准。
   */
  if (note) topic.notes = { plain: { content: note }, realHTML: { content: plainToHtml(note) } };

  // href：超链接优先；无超链接时把视频/文件附件写入（视频优先）。
  // 已打包的写包内相对路径，未打包的写 file:/// 本地路径。
  let href = str(data.hyperlink);
  if (!href || !href.trim()) {
    /*
     * **必须按列表取**：多附件改造后 data.file / data.video 存的是
     * **JSON 数组串**（写一定是数组），直接 str() 拿到的是整个数组串 ——
     * 它既不在 packs 里（键是单项引用）、也不是路径（toFileUri 返回 null），
     * 于是原样落进 href。实测导出后 content.json 里是：
     *   "href": "[\"{\\\"n\\\":\\\"报告.pdf\\\",...}\"]"
     * 别的 XMind 软件打开就是一串乱码死链；本工具走 zen 档导回时，
     * parseZen 还会把它当成 hyperlink 存起来，附件直接变成乱码链接。
     *
     * content.json 的 href 只能挂一个，取列表第一项（video 优先，与原来一致）。
     */
    const firstRef = (raw) => { const l = refListOf(raw); return l.length ? str(l[0]) : null; };
    const att = firstRef(data.video) || firstRef(data.file);
    if (att && att.trim()) {
      /*
       * **引用不到包内路径时不能原样写出去**。
       *
       * `toFileUri(att) || att` 那个兜底会把「既没打包、又不是本地路径」的
       * 引用串**原样**落进 href —— 而单项引用是 `{"n":"报告.pdf","a":"asDOC1","s":10}`
       * 这样的 JSON。导出后 content.json 里就是一串裸 JSON，
       * 导回时 parseZen 把它当 hyperlink 存起来：**附件变成一条乱码超链接**。
       *
       * 打包失败（附件字节读不出来、引用已成孤儿）是真实会发生的：
       * writeXMind 里 loadAsset 取不到就 `packs.delete` 撤掉映射。
       * 与其写出一条死链，不如这条 href 干脆不写。
       */
      href = packs && packs.has(att) ? packs.get(att) : toFileUri(att);
    }
  }
  if (href && href.trim()) topic.href = href;

  const markers = [];
  const priority = num(data.priority);
  if (priority >= 1 && priority <= 9) markers.push({ markerId: 'priority-' + Math.round(priority) });
  const progress = num(data.progress);
  if (progress > 0 && progress <= 10) markers.push({ markerId: progressToMarker(progress) });
  // BUG 110：导进来的、本工具不认识的标记原样写回（去重、剔掉已认识的）
  const extra = Array.isArray(data.xmarkers) ? data.xmarkers : [];
  for (const mid of extra) {
    if (typeof mid !== 'string' || isKnownMarker(mid) || !SAFE_MARKER_ID.test(mid)) continue;
    if (markers.some((m) => m.markerId === mid)) continue;
    markers.push({ markerId: mid });
  }
  if (markers.length) topic.markers = markers;

  const labels = buildLabels(data.labels);
  if (labels) topic.labels = labels;

  const img = buildImage(data);
  if (img) {
    topic.image = img;
    /*
     * BUG 97：图标 / 图片的区分必须**一起写出去**。
     *
     * 两者在 XMind 里形态完全相同（都是 `topic.image.src = data:image/svg+xml…`），
     * 光看 src 分不出来 —— 判据是节点上的 `data.icon` 标记（见 isIconSrc）。
     * 而它不是 XMind 的字段，buildKmNode 也只重建已知字段，不写出去的话
     * 标记在导出时就断了。
     *
     * 什么时候会真的断：**文件被别的软件打开再存回来**。那时本工具自己
     * 的无损快照 kityminder.json 已经被丢掉（别的软件不认识它），导回只能
     * 走 zen 档 —— 实测导回后 `data.icon` 是 undefined，于是回落 MIME 判据，
     * 用户自己挂的 .svg 图片又被当成图标：侧栏「图片」栏不列出它、
     * 点「清除节点图标」会把它删掉（BUG 95 的四处后果复现）。
     *
     * XMind 规范里没有对应字段，只能带一个私有键。绝大多数实现（含 XMind
     * 官方）对 content.json 的未知字段是直接忽略的，风险可接受；
     * 而且**只在真的区分不出来时才写**（src 是 svg+xml），普通节点不受影响。
     *
     * 判的是**写出去的那张 src** 而不是 data.image：槽位放图标、实际导出
     * 的是横幅里的照片时（BUG 93），标记必须跟着照片走 —— 照片是图片附件，
     * 判成图标的话导回后那张照片就"不算图片"了。
     */
    if (/^data:image\/svg\+xml/i.test(String(img.src))) {
      const slotSrc = str(data.image);
      topic.nexusIcon = img.src === slotSrc ? !!isIconSrc(data, slotSrc) : false;
    }
  }

  const props = buildStyle(data);
  if (props && Object.keys(props).length) {
    topic.style = { id: shortId('st'), properties: props };
  }

  if (Array.isArray(kmNode?.children) && kmNode.children.length) {
    const attached = [];
    const detached = [];
    const pendSummary = [];
    const pairs = [];
    for (const c of kmNode.children) {
      if (!c) continue;
      const child = buildTopic(c, packs);
      /*
       * BUG 141：标注写回 `children.detached`，不能一律塞进 attached
       * （见 buildKmNode 里的实测）。pairs 仍收**全部**子节点：外框的
       * range 引用的是 topic id，跨两个桶也能指到。
       */
      if (c.data && c.data.xcallout) detached.push(child);
      else if (c.data && c.data.xsummary) pendSummary.push({ child, km: c });
      else attached.push(child);
      pairs.push({ xid: child.id, km: c });
    }
    /*
     * BUG 143：概要（summary）必须**双写** —— 话题放 `children.summary`，
     * 同时在父话题上写 `summaries: [{ id, range, topicId }]`。
     *
     * 范围必须能落在**实际的 attached** 上：用户删过兄弟节点后，原来的
     * "(0,4)" 可能已经越界，写出去就是指向错漏的括注（静默错位比降级更糟）。
     * 所以这里夹紧到 attached 的数量；拿不到范围或没有 attached 可概括时
     * **退回 attached**（按普通分支写）—— 至少文字看得见，不会变成一个
     * 没有范围绑定的孤立概要。
     */
    const summaries = [];
    const summaryTopics = [];
    for (const item of pendSummary) {
      const range = clampSummaryRange(item.km?.data?.xsummaryRange, attached.length);
      if (!range) { attached.push(item.child); continue; }   // 退回普通分支
      summaries.push({
        id: safeId(item.km?.data?.xsummaryId) || shortId('sm'),
        range,
        topicId: item.child.id,
      });
      summaryTopics.push(item.child);
    }
    if (attached.length || detached.length || summaryTopics.length) {
      const ch = {};
      if (attached.length) ch.attached = attached;
      if (detached.length) ch.detached = detached;
      if (summaryTopics.length) ch.summary = summaryTopics;
      topic.children = ch;
      if (summaries.length) topic.summaries = summaries;
      const bounds = buildBoundaries(pairs);
      if (bounds) topic.boundaries = bounds;
    }
  }
  return topic;
}

/**
 * 概要范围夹紧到实际可概括的兄弟数。
 *
 * `range` 是零基闭区间字符串（"(0,2)" = 第 0~2 个）。返回 null 表示
 * **没法用**（格式不对 / 没有可概括的兄弟），调用方据此退回 attached。
 */
function clampSummaryRange(raw, n) {
  if (n <= 0) return null;
  const m = /^\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const last = n - 1;
  let s = Number(m[1]);
  let e = Number(m[2]);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  s = Math.min(s, last);
  e = Math.min(e, last);
  if (s > e) s = e;
  return `(${s},${e})`;
}

function buildLabels(node) {
  if (Array.isArray(node)) {
    const out = node.map(str).filter((s) => s && s.trim());
    return out.length ? out : null;
  }
  const s = str(node);
  return s && s.trim() ? [s] : null;
}

/**
 * 槽位里放的是不是**图标**。
 *
 * 与 editor-bridge 的 `_slotKind` 同一套判据：**先看显式标记 `data.icon`，
 * 没有才回落到 MIME**（BUG 95）。
 *
 * 只看 MIME 会把用户自己挂的 .svg 图片当成图标 —— io.imageToInline 对 SVG
 * 是原样内联的，产出的同样是 `data:image/svg+xml`。于是导出时 buildImage
 * 跳过它、去横幅里找照片，**用户的图静默丢失**（槽位只能留一个）。
 *
 * 存量节点没有 icon 字段，才走 MIME 兜底 —— 那时行为与修复前一致。
 */
function isIconSrc(data, u) {
  const flag = data ? data.icon : undefined;
  if (flag !== undefined && flag !== null) return !!flag;
  return !!u && /^data:image\/svg\+xml/i.test(String(u));
}

function buildImage(data) {
  /*
   * 单张在 data.image，多张在 data.images（横幅）—— 两者互斥。
   * 只认 image 的话，挂了 2 张以上的节点导出后 content.json **一张图都没有**，
   * 在别的 XMind 软件里打开就是纯文字节点。
   * XMind 一个 topic 只挂一张图，这里取横幅的第一张。
   *
   * **图标占着 image 槽时，图片附件优先**（BUG 93）。
   *
   * 「图标 + 照片横幅」是 BUG 58 修完之后的**正常状态**：先挂照片、再应用
   * 图标，照片被让位到横幅、图标进槽位。而 buildImage 一律先读 image ——
   * 于是导出到 XMind 时**照片全部静默丢失**，只留一个装饰性的图标：
   *   实测 {image: 图标, images:[照片1,照片2]} → topic.image.src = 图标
   * 照片是用户挂上去的、别处没有副本，图标只是从预设库里点一下就能重选的
   * 装饰 —— 只能留一个时当然留照片。
   */
  let src = str(data.image);
  const many = refListOf(data.images);
  const fromSlot = !!src;
  if (isIconSrc(data, src) && many.length) src = str(many[0]) || src;
  if (!src || !src.trim()) src = many.length ? str(many[0]) : null;
  if (!src || !src.trim()) return null;
  const img = { src };
  /*
   * 尺寸只在**用的就是槽位那张**时才写。
   *
   * imageSize 是内核给槽位图探测出来的（图标也一样，见 panels 里应用图标
   * 那段注释）。槽位放的是图标、实际导出的是横幅里的照片时，把图标的尺寸
   * 套到照片上 —— 图标多是方的、照片多是宽的，在 XMind 里就被拉成方的。
   * 拿不到尺寸反而是安全的：XMind 会按图片自身比例显示。
   */
  const { w, h } = fromSlot && src === str(data.image) ? sizeOf(data.imageSize) : { w: 0, h: 0 };
  if (w > 0) img.width = w;
  if (h > 0) img.height = h;
  const title = str(data.imageTitle);
  if (title && title.trim()) img.title = title;
  return img;
}

/**
 * 把同组外框（boundaryGroup/boundaryLabel）汇总成父节点上的 XMind boundary 区间。
 *
 * **必须按「连续段」拆开写，不能一组只写一个 (first,last)**。
 *
 * XMind 的 range 只能表达「首 → 尾」这一个区间（导回侧也是这么读的：
 * 取所有 id 的下标，然后 min..max 整段应用）。而外框成员是用户 Ctrl 多选
 * 出来的，**完全可以不连续**：给 A、C 加框（跳过 B）时成员下标是 0、2。
 *
 * 写成 (A,C) 的话，导回时 from=0、to=2，中间的 B **也被划进这个外框** ——
 * 实测：A=bg1、B=无、C=bg1 导出再导回变成 A=C=B=bg1。
 * 若 B 本身属于另一组，后处理时它已有 boundaryGroup 会被跳过，
 * 于是 B 留在别人的组里 —— 同样错。
 *
 * 格式表达不了非连续成员，所以一组拆成多段写：每段一个 boundary，
 * 都带本组的 title。导回后各段是各自独立的外框（画面上是几个框而不是
 * 一个框）—— 这是格式限制下的最好结果，至少不会把无关节点框进来。
 */
function buildBoundaries(ordered) {
  const groups = new Map();
  ordered.forEach((item, i) => {
    const d = item.km?.data || {};
    const gid = str(d.boundaryGroup);
    if (!gid) return;
    const label = str(d.boundaryLabel) ?? '';
    const g = groups.get(gid);
    if (g) {
      g.idx.push(i);
      if (!g.label) g.label = label;
    } else {
      groups.set(gid, { idx: [i], label });
    }
  });
  if (groups.size === 0) return null;

  const arr = [];
  for (const g of groups.values()) {
    // ordered 是从 0 递增遍历的，g.idx 天然升序
    let start = g.idx[0];
    let prev = start;
    const flush = (end) => {
      const a = ordered[start] && ordered[start].xid;
      const b = ordered[end] && ordered[end].xid;
      // 引用不到的 id 写了也是死链（导回时 findIndex 全 -1，整条被丢掉）
      if (!a || !b) return;
      const range = start === end ? '(' + a + ')' : '(' + a + ',' + b + ')';
      arr.push({ id: shortId('bd'), class: 'boundary', title: g.label, range });
    };
    for (let k = 1; k < g.idx.length; k++) {
      if (g.idx[k] === prev + 1) {
        prev = g.idx[k];
        continue;
      }
      flush(prev);
      start = g.idx[k];
      prev = start;
    }
    flush(prev);
  }
  return arr.length ? arr : null;
}

function buildStyle(data) {
  const props = {};
  for (const [kmKey, xmKey] of StyleMap) {
    const v = str(data?.[kmKey]);
    if (v == null || !String(v).trim()) continue;
    /*
     * 字号走 toPt，且**拿不到数字就不写**：toPt('large') 返回 null，
     * 写进 properties 就是 `fo:font-size: null`，别的软件打开会当成没有字号
     * —— 那正是想要的（总比写个非法值强）。
     */
    if (kmKey === 'font-size') { const pt = toPt(v); if (pt) props[xmKey] = pt; continue; }
    props[xmKey] = StylePxKeys.has(kmKey) ? toPx(v) : v;
  }
  /*
   * 粗体 / 斜体的 data 键是 font-weight / font-style（与 XMind 同名），
   * 不是面板上报用的 bold / italic —— 后者只是**面板状态对象**的键，
   * 真正落到 node.data 上的是前者。早先读 data?.bold，永远是 undefined。
   *
   * 值要归一化：别的软件可能写 '700' / 700 / 'bold'，一律收敛成 'bold'，
   * 否则导回时 '700' 会被内核当普通字重处理。
   */
  const weight = str(data?.['font-weight']);
  if (weight) {
    const w = String(weight).toLowerCase().trim();
    if (w === 'bold' || (num(weight) ?? 0) >= 600) props['fo:font-weight'] = 'bold';
  }
  const fstyle = str(data?.['font-style']);
  if (fstyle && String(fstyle).toLowerCase().trim() === 'italic') props['fo:font-style'] = 'italic';
  /*
   * 删除线与下划线**可以同时在**（导入别的软件的文件时常见）。
   * 早先写的是 `if (strikethrough) ... else if (underline) ...` ——
   * 两个都有时只写 line-through，下划线静默丢失。
   *
   * fo:text-decoration 本来就是空格分隔的多值属性，两个都写即可；
   * 读回侧 applyStyle 也是分别对 /line-through/ 与 /underline/ 做匹配。
   */
  /*
   * 删除线的 data 键是 font-strikethrough（`!!值` 判断，写入什么值都行）。
   * underline 内核没有对应 data 键（面板也没有下划线控件），但因为导回侧
   * 会把它落成 data.underline，两边成对，往返仍然一致 —— 保留即可。
   */
  const deco = [data?.['font-strikethrough'] ? 'line-through' : '',
    data?.underline ? 'underline' : ''].filter(Boolean).join(' ');
  if (deco) props['fo:text-decoration'] = deco;
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
      // BUG 109：布局也得读回来 —— 早先写死 'default'，于是本工具导出的
      // 「组织结构图」过一遍别的软件，导回就一律变成「思维导图」
      layout: StructureToLayout[str(sn.rootTopic?.structureClass) || ''] || 'default',
      // BUG 122：关系线是**内容**，不读就等于删掉别人的文件。为空时不写这个键
      ...(rel => (rel.length ? { xrelationships: rel } : {}))(readRelationships(sn.relationships)),
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

  // realHTML-only 的备注（别的软件常这么写）也要读出来，见 topicNote 的说明
  const note = topicNote(topic.notes);
  if (note) data.note = note;

  // href 还原：file:/// → 文件/视频附件（视频按扩展名识别）；包内相对路径先存下来，
  // 稍后由 readXMind 统一解包；其它协议保留为超链接
  const href = str(topic.href);
  const localFile = fromFileUri(href);
  if (localFile) {
    if (isVideoName(localFile)) data.video = localFile;
    else data.file = localFile;
  } else if (isPackRef(href)) {
    /*
     * 包内相对路径也要按扩展名分视频 / 文件。
     * 少了这一步，`resources/kma_1_演示.mp4` 会被当成**文件**附件存下来 ——
     * 导入后视频卡片变成普通文件卡片，没有封面也播不了。
     * 包内名字是 `kma_<序号>_<原名>`，扩展名完整保留，判得出来。
     */
    if (isVideoName(href)) data.video = href;
    else data.file = href;
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
        else collectXMarkers(data, mid);   // BUG 110
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
      // BUG 97：读回「这是图标还是用户挂的图片」的标记（见 buildTopic）。
      // 只有布尔值才认 —— 别的软件产出的文件没有这个键，那时保持**不写**，
      // 让 editor-bridge 的 _slotKind 回落到 MIME 判据（与修复前一致，不回归）。
      if (typeof topic.nexusIcon === 'boolean') data.icon = topic.nexusIcon;
      // 必须是 {width,height} 对象：内核 ImageRenderer 直接读 .width/.height
      if (w > 0 && h > 0) data.imageSize = { width: Math.round(w), height: Math.round(h) };
      const t = str(topic.image.title);
      if (t && t.trim()) data.imageTitle = t;
    }
  }

  applyStyle(data, topic.style);

  // BUG 115：折叠状态（`branch: "folded"`）。只认这一个字面值 —— 别的
  // 软件若写了别的取值，不该被当成"已折叠"（宁可展开，不要静默改结构）。
  if (str(topic.branch) === 'folded') data.expandState = 'collapse';

  /*
   * BUG 143：XMind 的**概要**（summary）是「双写」的 —— 除了把概要话题放进
   * 父话题的 `children.summary`，还要在**同一个父话题**上写一条范围描述符：
   *
   *     topic.summaries = [{ id, range: "(0,2)", topicId }]
   *
   * `range` 是**零基闭区间**："(0,2)" 表示概括第 0~2 个 attached 子话题。
   * 两处少写任何一处，产出的是「能在 XMind 里打开、但实际是坏的」文件
   * （概要话题变成没有范围绑定的孤立节点）。
   *
   * 所以这里按 topicId 把描述符收起来，等读到概要话题时配回去。
   */
  const summaryRanges = new Map();
  if (Array.isArray(topic.summaries)) {
    for (const s of topic.summaries) {
      if (!s) continue;
      const tid = safeId(s.topicId) || safeId(s.topicID);
      if (!tid) continue;
      summaryRanges.set(tid, { id: str(s.id), range: str(s.range) });
    }
  }

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
        /*
         * BUG 143：概要（summary）是挂在若干兄弟节点外面的**括注**，
         * **不是分支**。早先 summary 桶与 attached 一视同仁，写侧又一律
         * 写进 attached —— 于是「导入别人的 .xmind → 改一点 → 导出」之后，
         * 所有概要都变成了普通分支：画面上凭空多出一排分支，原始文件的
         * 结构被改掉，且不报错、也不计入任何丢失提示。
         *
         * 与标注（BUG 141）同一套取舍：本工具画不出括注，只**记住**它是
         * 概要、并尽量带回范围，导出时原样写回 —— 不许把别人的文件改掉。
         */
        if (key === 'summary') {
          const info = summaryRanges.get(safeId(c.id) || '');
          /*
           * 拿不到范围就**不标**。概要必须双写（话题 + 范围描述符），只写
           * 话题不写范围产出的是「没有范围绑定的孤立概要」—— 比按普通分支
           * 写更糟（文字在，但 XMind 里画不出来）。那时退回 attached。
           */
          if (info && info.range) {
            kmChild.data.xsummary = true;
            kmChild.data.xsummaryRange = info.range;
            if (info.id) kmChild.data.xsummaryId = info.id;
          }
        }
        /*
         * BUG 141：XMind 的**标注**（callout）写在 `children.detached` 里 ——
         * 它是挂在节点旁边的小气泡，**不是分支**。早先三个桶一视同仁收进
         * children、写侧又一律写进 `attached`，于是「导入别人的 .xmind →
         * 改一点 → 导出」之后，所有标注都变成了普通分支：画面上凭空多出一排
         * 分支，原始文件的结构被改掉，且不报错、也不计入任何丢失提示。
         *
         * 内核没有 callout 这个概念（没法真的画成气泡），所以这里只**记住**
         * 它是标注，导出时写回 `detached` —— 与 xmarkers（BUG 110）、
         * 关系线（BUG 122）同一套取舍：本工具不显示，但不许把别人的文件改掉。
         */
        if (key === 'detached') kmChild.data.xcallout = true;
        children.push(kmChild);
        pairs.push({ xid: safeId(c.id) || '', km: kmChild });
      }
    }
  }

  applyBoundaries(pairs, topic.boundaries, counter);
  return { data, children };
}

/**
 * 父节点上的 XMind boundary 区间 → 子节点的 boundaryGroup/boundaryLabel
 *
 * @param {object} [counter] **整份文件共用**的序号盒（见下面 BUG 140）
 */
function applyBoundaries(pairs, boundaries, counter = null) {
  if (!Array.isArray(boundaries) || !boundaries.length || !pairs.length) return;
  /*
   * BUG 140：组号必须**全文件递增**，不能每个父话题各自从 1 重发。
   *
   * 早先这里写的是 `let seq = 0;`（函数局部变量，每次调用都重置），
   * 于是每个父话题的第一个外框都叫 `bg1`。实测（两个分支各带一组外框）：
   *     分支A 的 A一 / A二 → bg1「甲组」
   *     分支B 的 B一 / B二 → bg1「乙组」  ← 同一个号
   *
   * 而内核是按 **gid 全局**分组的（editor/index.html 里
   * `var _groupNodes = new Map()` 键就是 gid，不区分父节点）——
   * 于是这两组会被并成**一个**大框：A一、A二、B一、B二 六个节点
   * 被同一个矩形圈住，标签取先找到的那个（「甲组」），
   * 「乙组」这个框**凭空消失**。导入别人的 .xmind 就足以触发。
   *
   * ⓘ 组号仍保持 `bg<数字>` 形态，不能换成随机串：内核的 rebuildGroups
   *   靠 `/^bg(\d+)$/` 解析已有组号、把 _boundarySeq 抬到最大值之上，
   *   否则用户之后新建的外框会重号（那一处是另一个已修的 bug）。
   *   现在整份文件递增，最大值就是组数，抬基线依然成立。
   */
  const box = counter || {};
  const nextSeq = () => { box.bgSeq = (Number(box.bgSeq) || 0) + 1; return box.bgSeq; };
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
    const gid = 'bg' + nextSeq();
    const label = str(b.title) ?? '';
    for (let i = from; i <= to && i < pairs.length; i++) {
      const d = pairs[i].km.data;
      if (!d || str(d.boundaryGroup)) continue;
      d.boundaryGroup = gid;
      d.boundaryLabel = label;
    }
  }
}

/**
 * sheet 级的 XMind 关系线：`relationships: [{ id, end1Id, end2Id, title? }]`。
 *
 * **关系线是内容，不是装饰** —— 两个节点之间「有关联、以及关联叫什么」
 * 是用户写进去的。早先读侧一眼不看、写侧也不写，于是：
 *
 *   导入别人的 .xmind（带关系线）→ 本工具改一点 → 导出
 *   → 文件里的关系线**整个没了**，且不报错。
 *
 * 与 BUG 110（标记）同一类：本工具不渲染，但必须原样保住并写回，
 * 否则等于静默破坏别人的文件。
 *
 * 只收白名单字段：`id` / `end1Id` / `end2Id` / `title`。
 * `controlPoints`（折线坐标）不收 —— 本工具不渲染关系线，坐标写回去
 * 也是一堆没人用的数字，反而把脏数据带进别人的文件。
 *
 * 丢掉的条件：缺任一端（死链）、自环（画不出关系）、非对象条目。
 */
function readRelationships(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (out.length >= MAX_RELATIONSHIPS) break;   // 炸弹文件：几万条关系线
    const a = str(r.end1Id);
    const b = str(r.end2Id);
    if (!a || !b || a === b) continue;
    const id = str(r.id);
    const one = { id: id && id.trim() ? id.trim() : shortId('rel'), end1Id: a, end2Id: b };
    const t = str(r.title);
    if (t != null) one.title = t;
    out.push(one);
  }
  return out;
}

function applyStyle(data, style) {
  const props = style?.properties;
  if (!props) return;
  for (const [kmKey, xmKey] of StyleMap) {
    const v = str(props[xmKey]);
    if (v == null || !String(v).trim()) continue;
    /*
     * 同上：字号必须剥掉单位后再落到 data 上（否则内核算出 NaN，见
     * fontSizeNum 的注释）。剥不出来（`'large'`）就**不设**，回落主题默认。
     */
    if (kmKey === 'font-size') { const fs = fontSizeNum(v); if (fs) data[kmKey] = fs; continue; }
    data[kmKey] = StylePxKeys.has(kmKey) ? fromPx(v) : v;
  }
  const weight = str(props['fo:font-weight']);
  if (String(weight).toLowerCase() === 'bold' || (num(props['fo:font-weight']) ?? 0) >= 600) {
    data['font-weight'] = 'bold';
  }
  const fs = str(props['fo:font-style']);
  if (String(fs).toLowerCase() === 'italic') data['font-style'] = 'italic';
  const deco = str(props['fo:text-decoration']);
  if (deco) {
    if (/line-through/i.test(deco)) data['font-strikethrough'] = true;
    // 内核没有下划线 data 键（面板也无此控件），落成 data.underline 只为
    // 与写侧成对，保证「导入 → 再导出」不把它丢掉
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

/**
 * 只在本话题**自己**的范围内找后代：不下钻子话题。
 *
 * 取「节点的标记 / 图片」必须用它，不能用 descendantsNamed ——
 * 后者会一路下钻到整棵子树，于是：
 *
 *   · 父话题没有图片、子话题有 → 父话题**抢到子的图片**（取 [0]，
 *     文档序里子的 <img> 就在那儿），一张图同时出现在两个节点上；
 *   · 父话题的优先级被**子话题的标记覆盖**（遍历是先父后子，
 *     后写的值赢）。实测：父 priority-2、子 priority-1，
 *     导入后父子**都是 1** —— 父的值静默丢失。
 *
 * 老版 content.xml 里 <children>/<topics>/<topic> 就是子话题的边界，
 * 跨过去就属于另一个节点了。
 */
function ownDescendants(el, name) {
  const out = [];
  if (!el) return out;
  const walk = (n, d) => {
    if (d > MAX_DEPTH) return;
    for (const c of n.children || []) {
      const ln = localName(c);
      if (ln === 'children' || ln === 'topics' || ln === 'topic') continue;
      if (ln === name) out.push(c);
      walk(c, d + 1);
    }
  };
  walk(el, 0);
  return out;
}

function parseLegacy(xml, stylesXml = null) {
  const doc = parseXml(xml);
  const styles = parseLegacyStyles(stylesXml);
  const sheets = [];
  let index = 0;
  /*
   * BUG 140：外框组号必须**整份文件共用**同一个序号盒，老档同样如此。
   * 只修 zen 档不修老档的话，从 XMind 8 导入的文件里两个分支的外框
   * 仍然会撞成同一个号（各自从 1 重发），被内核并成一个大框。
   */
  const counter = { bgSeq: 0 };
  for (const sheetEl of descendantsNamed(doc.documentElement, 'sheet')) {
    const topicEls = childrenOf(sheetEl, 'topic');
    if (!topicEls.length) continue;
    index++;
    const kmRoot = buildKmFromXmlTopic(topicEls[0], 0, styles, counter);
    if (!kmRoot) continue;   // 根节点就超深 —— 异常文件，跳过这张画布
    const titleEl = childrenOf(sheetEl, 'title')[0];
    const title = titleEl?.textContent?.trim();
    // 老版 content.xml 把结构类写在根 topic 的 structure-class 属性上
    const legacySc = topicEls[0].getAttribute?.('structure-class');
    const wrapper = { root: kmRoot, template: 'default', theme: 'fresh-blue', version: '1.4.43' };
    const rels = readRelationships(readXmlRelationships(sheetEl));
    sheets.push({
      id: sheetEl.getAttribute('id') || newSheetId(),
      title: title || ('画布 ' + index),
      content: pretty(wrapper),
      theme: 'fresh-blue',
      layout: StructureToLayout[str(legacySc) || ''] || 'default',
      // BUG 137：关系线在老版里也是 sheet 级数据，只走 zen 那条读侧的话，
      // 从 XMind 8 导入的文件里关系线**整条消失**（不报错、也不计入提示）。
      ...(rels.length ? { xrelationships: rels } : {}),
    });
  }
  return { sheets };
}

/**
 * 老版 `<sheet><relationships><relationship end1 end2 [title]/>` → 关系线数组。
 *
 * 端点属性名与 zen 档不同（zen 是 `end1Id` / `end2Id`，老版是 `end1` / `end2`），
 * 标题在老版里两种写法都有（属性 `title` 与子 `<title>`）—— 两种都认。
 * `<controlpoint>`（折线坐标）不收，同 zen 档口径（见 readRelationships）。
 */
function readXmlRelationships(sheetEl) {
  const out = [];
  for (const relsEl of childrenOf(sheetEl, 'relationships')) {
    for (const r of childrenOf(relsEl, 'relationship')) {
      if (!r) continue;
      const t = str(childrenOf(r, 'title')[0]?.textContent) ?? r.getAttribute('title');
      out.push({
        id: r.getAttribute('id'),
        end1Id: r.getAttribute('end1'),
        end2Id: r.getAttribute('end2'),
        title: t === '' ? null : t,
      });
    }
  }
  return out;
}

/**
 * 解析 XMind 8 的 styles.xml → `style-id` → 属性表。
 *
 * ⓘ 老版 content.xml 的 topic **不带任何视觉属性**，只有一个 `style-id`
 *   指向 styles.xml 里的 <style>。不读这个文件，节点自定义样式就**全丢**
 *   —— 而 zen 路径（content.json）早就读得好好的（见 StyleMap）。
 *   两条路只修了一条，于是「从 XMind 8 导入 → 标红的重点节点变成默认色」。
 *
 * **不逐个枚举 XMind 的属性名**：把 <topic-properties> / <font-properties>
 *   上的属性**整张收下来**，交给已有的 applyStyle 挑选它认识的那几个键。
 *   XMind 8 与 zen 在键名上并不完全一致（如圆角/描边各家叫法不同），
 *   枚举反而会漏；且收到不认识的键也无害 —— applyStyle 只认 StyleMap 里的。
 *
 * <style> 可以 `based-on` 继承主样式（主题给的默认配色），要顺着链把父样式
 *   铺在下面、子样式盖在上面；带环保护，坏文件不至于死循环。
 */
function parseLegacyStyles(xml) {
  const map = new Map();
  if (!xml || !xml.trim()) return map;
  let doc;
  try { doc = parseXml(xml); } catch { return map; }   // 坏样式表不该连累正文
  for (const st of descendantsNamed(doc.documentElement, 'style')) {
    const id = st.getAttribute('id');
    if (!id) continue;
    const props = {};
    for (const p of descendantsNamed(st, 'topic-properties')
      .concat(descendantsNamed(st, 'font-properties'))) {
      for (const a of p.attributes || []) {
        const v = String(a.value ?? '').trim();
        // 用带前缀的限定名（svg:fill / fo:color），与 zen 的 properties 键一致
        if (v) props[a.name] = v;
      }
    }
    map.set(id, { props, base: st.getAttribute('based-on') || st.getAttribute('basedOn') || '' });
  }
  return map;
}

/** 顺 based-on 链把样式铺开：先父后子，子覆盖父 */
function resolveLegacyStyle(map, id) {
  if (!id || !map || !map.size) return null;
  const chain = [];
  const seen = new Set();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const e = map.get(cur);
    if (!e) break;
    chain.push(e.props);
    cur = e.base;
  }
  // 从最后一个（最老的祖先）往前铺，保证链的末端优先
  const out = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const k of Object.keys(chain[i])) out[k] = chain[i][k];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 老档 topic 上的概要范围描述符：`<summaries><summary topic-id range/></summaries>`
 *
 * 返回 Map<topicId, {id, range}>。读不到就是空 Map —— 那时概要退回 attached
 * （写侧只写 zen 档，没有范围可依时不硬写，见 buildTopic）。
 */
function xmlSummaryRanges(topicEl) {
  const out = new Map();
  const wrap = childrenOf(topicEl, 'summaries')[0];
  if (!wrap) return out;
  for (const s of childrenOf(wrap, 'summary')) {
    const tid = s.getAttribute?.('topic-id') || s.getAttribute?.('topicId') || s.getAttribute?.('idref');
    if (!tid) continue;
    out.set(tid, { id: str(s.getAttribute?.('id')), range: str(s.getAttribute?.('range')) });
  }
  return out;
}

function buildKmFromXmlTopic(t, depth = 0, styles = null, counter = null) {
  if (depth > MAX_DEPTH) return null;   // 超深直接截断，不再下钻
  const data = {
    id: t.getAttribute('id') || newNodeId(),
    created: Date.now(),
    text: childrenOf(t, 'title')[0]?.textContent ?? '',
  };

  /*
   * BUG 137：折叠状态。老版写在 topic 的 `branch="folded"` 上（与 zen 档的
   * `branch: "folded"` 同一个字段名同一个值），只修 zen 那条读侧的话，
   * 从 XMind 8 导入的画布里**收起的分支全部被摊开** —— 不报错，用户只会
   * 以为"这个软件不认折叠"。
   */
  if (str(t.getAttribute('branch')) === 'folded') data.expandState = 'collapse';

  /*
   * BUG 138：备注。老版把备注写在 `<notes>` 里（纯文本走 `<plain>`，带格式的走
   * `<richcontent TYPE="NOTE">`，后者是 XHTML）。早先这里直接用 `textContent`，
   * 于是 `<br/>` 和 `</p>` 全被抹平 —— 实测「段一<p/>段二」变成「段一段二」、
   * 「行1<br/>行2」变成「行1行2」，导入别人的 XMind 8 文件后备注挤成一团。
   * 而 zen 档同样的内容走 topicNote + htmlToPlain，出来是带换行的 —— 同一份
   * 内容两种档位两种结果。所以这里复用 formats.js 的 elToPlain（与 FreeMind
   * 的 richcontent 同一份逻辑，BUG 113 那次提出的共用）。
   */
  const notesEl = childrenOf(t, 'notes')[0];
  if (notesEl) {
    const plainEl = childrenOf(notesEl, 'plain')[0];
    const richEl = childrenOf(notesEl, 'richcontent')[0];
    const text = elToPlain(plainEl || richEl || notesEl);
    if (text) data.note = text;
  }

  // 视觉属性在 styles.xml 里（topic 只带 style-id），见 parseLegacyStyles
  const st = resolveLegacyStyle(styles, t.getAttribute('style-id'));
  if (st) applyStyle(data, { properties: st });

  const href = t.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || t.getAttribute('href');
  if (href && href.trim()) {
    /*
     * 与 zen 档同口径（BUG 118）：包内引用是**附件**不是链接。
     * XMind 8 把附件写在 xlink:href 上，值形如 `xap:attachments/报告.pdf`；
     * 一律当超链接的话，附件本体丢失、还多一条打不开的链接。
     */
    const localFile = fromFileUri(href);
    if (localFile) {
      if (isVideoName(localFile)) data.video = localFile;
      else data.file = localFile;
    } else if (isPackRef(href)) {
      if (isVideoName(href)) data.video = href;
      else data.file = href;
    } else {
      data.hyperlink = href;
    }
  }

  for (const mr of ownDescendants(t, 'marker-ref').concat(ownDescendants(t, 'marker'))) {
    const mid = mr.getAttribute('marker-id') || mr.getAttribute('markerId');
    if (!mid) continue;
    const pm = /^priority-(\d+)$/.exec(mid);
    if (pm) {
      const p = Number(pm[1]);
      if (p >= 1 && p <= 9) data.priority = p;
    } else {
      const idx = ProgressMarkers.indexOf(mid);
      if (idx >= 0) data.progress = MarkerToProgress[idx];
      else collectXMarkers(data, mid);   // BUG 110
    }
  }

  const labelsEl = childrenOf(t, 'labels')[0];
  if (labelsEl) {
    const arr = childrenOf(labelsEl, 'label')
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean);
    if (arr.length) data.labels = arr;
  }

  const imgEl = ownDescendants(t, 'img')[0];
  const imgSrc = imgEl?.getAttribute('src')
    || imgEl?.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
  if (imgSrc && imgSrc.trim()) {
    data.image = imgSrc;
    // 老版 <img> 常带 width/height；丢了它内核就不画（同 zen 路径）
    const iw = num(imgEl?.getAttribute('width'));
    const ih = num(imgEl?.getAttribute('height'));
    if (iw > 0 && ih > 0) data.imageSize = { width: Math.round(iw), height: Math.round(ih) };
  }

  const children = [];
  const pairs = [];
  const topicsEl = childrenOf(t, 'children')[0];
  /*
   * BUG 143：老档（content.xml）的概要同样要读范围描述符，读不到就退回
   * attached（写侧只写 zen 档，没有范围可依时宁可按分支写，也不写一个
   * 没有范围绑定的孤立概要 —— 见 buildTopic 的说明）。
   */
  const sumRanges = xmlSummaryRanges(t);
  if (topicsEl) {
    for (const topics of childrenOf(topicsEl, 'topics')) {
      // BUG 141：老档的标注同样写在 `<topics type="detached">` 里，与 zen 档同理
      const isDetached = str(topics.getAttribute?.('type')) === 'detached';
      // BUG 143：老档的概要写在 `<topics type="summary">` 里
      const isSummary = str(topics.getAttribute?.('type')) === 'summary';
      for (const child of childrenOf(topics, 'topic')) {
        const kmChild = buildKmFromXmlTopic(child, depth + 1, styles, counter);
        if (!kmChild) continue;   // 超深被截断
        if (isDetached) kmChild.data.xcallout = true;
        else if (isSummary) {
          const info = sumRanges.get(child.getAttribute('id') || '');
          if (info && info.range) {   // 拿不到范围就不标（同上：不写孤立概要）
            kmChild.data.xsummary = true;
            kmChild.data.xsummaryRange = info.range;
            if (info.id) kmChild.data.xsummaryId = info.id;
          }
        }
        children.push(kmChild);
        pairs.push({ xid: child.getAttribute('id') || '', km: kmChild });
      }
    }
  }

  applyXmlBoundaries(pairs, childrenOf(t, 'boundaries')[0], counter);
  return { data, children };
}

/** 老版 boundary 结构各家写法不一，做宽容解析：任意后代的 idref/ref/id 属性或文本里的 id 都收 */
function applyXmlBoundaries(pairs, boundariesEl, counter = null) {
  if (!boundariesEl || !pairs.length) return;
  /*
   * BUG 140：与 zen 档同一条规矩 —— 组号必须**整份文件递增**（见 applyBoundaries
   * 注释里的实测）。早先这里也是 `let seq = 0;`（函数局部变量），老档每个父话题
   * 的第一个外框都叫 `bg1`，两个分支的框会被内核并成一个。
   */
  const box = counter || {};
  const nextSeq = () => { box.bgSeq = (Number(box.bgSeq) || 0) + 1; return box.bgSeq; };
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

    const gid = 'bg' + nextSeq();
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
 * 统计「XMind 装不下」的条目：一个 topic 只能挂 **1 个附件**（href）+ **1 张图**（image）。
 *
 * 这是格式的硬限制，不是实现的疏漏 —— 但**不能静默发生**：
 *   实测一个节点挂 2 个附件 → 导出后 content.json 里只有 1 条 href，
 *   另一个的字节**确实进了 resources/**，却没有任何东西指向它；
 *   在别的 XMind 软件里打开，那个附件就是不存在。
 *   而导出那一句状态栏写的是「XMind 已导出（含 2 个附件）」——
 *   数的是**打包成功的字节数**，不是**能挂到节点上的个数**，等于谎报。
 *
 * 与 workbook.deepNodeCount 同口径：导出时说出来，是唯一能提醒的机会
 * （导入是整体替换，等用户导回来发现少了已经晚了）。
 *
 * 五类损失分开统计，提示才能说清是哪一种：
 *   · blocked      节点上有超链接 → href 被超链接占掉，附件**一个都挂不上**
 *   · unlinked     没有超链接，但附件多于 1 个 → 只有第一个挂得上
 *   · images       图片（槽位 + 横幅合计）多于 1 张 → 只有第一张写进 image
 *   · fmIcons      FreeMind 的 `<icon BUILTIN>`（BUG 127 收在 data.fmIcons）
 *   · fmCloud      FreeMind 的 `<cloud>`（同上，收在 data.fmCloud）
 *
 * ⓘ 后两类是 BUG 135 补的。它们是 BUG 127 才有的数据，而 XMind **没有对应
 *   字段**（XMind 的 marker 是另一套 id，cloud 更没有对应概念），于是：
 *   导入别人的 .mm（带图标 / 外框）→ 导出 .xmind → 全丢，而这里报 0、
 *   界面只说「XMind 已导出」。与 BUG 123 是同一个洞 —— 那次补的是交换格式
 *   的 exchangeLoss，`xmindLossCount` 这条路径一直没人同步。
 *
 * @param {Array} sheets 画布数组（content 为 kityminder JSON 文本或对象）
 * @returns {{blocked:number, unlinked:number, images:number,
 *            fmIcons:number, fmCloud:number}} 0 = 没有损失
 */
export function xmindLossCount(sheets) {
  const out = { blocked: 0, unlinked: 0, images: 0, fmIcons: 0, fmCloud: 0 };
  for (const s of sheets || []) {
    const km = parseKm(s?.content);
    if (!km) continue;              // 坏内容不算 —— 它本来也导不出东西
    walkKmNodes(km, (node) => {
      const d = node?.data;
      if (!d) return;

      /*
       * FreeMind 的图标 / 外框（BUG 135）。
       *
       * 必须放在附件那段**之前** —— 那段末尾有一句 `if (!total) return;`，
       * 没有附件的节点会在那里提前退出，写在这后面就永远数不到。
       */
      for (const one of Array.isArray(d.fmIcons) ? d.fmIcons : []) {
        if (str(one).trim()) out.fmIcons++;
      }
      if (String(d.fmCloud ?? '').trim()) out.fmCloud++;

      // 图片：槽位一张 + 横幅若干张，XMind 只写 src 一个
      const imgs = [];
      const slot = str(d.image);
      if (slot && slot.trim()) imgs.push(slot);
      for (const one of refListOf(d.images)) {
        const v = str(one);
        if (v && v.trim()) imgs.push(v);
      }
      if (imgs.length > 1) out.images += imgs.length - 1;

      // 附件：href 只有一个，且**超链接优先**（见 buildTopic）
      const files = refListOf(d.file);
      const videos = refListOf(d.video);
      const total = files.length + videos.length;
      if (!total) return;
      const hasHref = !!(str(d.hyperlink) || '').trim();
      if (hasHref) out.blocked += total;
      else if (total > 1) out.unlinked += total - 1;
    });
  }
  return out;
}

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
 * @returns {Promise<{sheets:Array, activeId:string, source:string, attachments:number,
 *           inlined:number, assetsFailed:number, imagesFailed:number}>}
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
  //    ⓘ parseZen 只在 JSON.parse 失败时抛错，而这一抛会把整档优先级链打断：
  //    XMind 2020 为向后兼容，包里 content.json 与 content.xml **两份都写**
  //    （2021 起 content.xml 才退化成升级提示），于是 content.json 损坏时
  //    明明还有一份完好的 content.xml，文件却整个导不进来。
  //    与第 1) 档「坏快照继续往下走」同一口径：坏了就往下一档走，别中止。
  let zenErr = null;
  if (!wb) {
    const content = readText(ContentEntry);
    if (content) {
      try {
        const r = parseZen(content);
        if (r.sheets.length) { wb = r; source = 'zen'; }
      } catch (e) {
        // 记下原因：三档都拿不到内容时，它比「不是有效的 XMind 文件」有用得多
        zenErr = e;
      }
    }
  }

  // 3) XMind 8 及更早
  if (!wb) {
    const legacy = readText(LegacyContentEntry);
    if (legacy) {
      // styles.xml 一起读：topic 的视觉属性全在它里面，只读 content.xml
      // 会把节点自定义样式（标红、字号、加粗…）全部丢掉
      const r = parseLegacy(legacy, readText(LegacyStylesEntry));
      if (r.sheets.length) { wb = r; source = 'legacy'; }
    }
  }

  if (!wb || !wb.sheets?.length) {
    // content.json 存在但坏了、且 content.xml 也没救回来时，
    // 说清是哪一档坏的 —— 比一句笼统的「不是有效的 XMind 文件」好定位
    if (zenErr) throw zenErr;
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
  // 内联的图片数（不占 saveAsset，单独计）
  let inlined = 0;
  /*
   * BUG 155：**没还原成功的附件 / 图片必须数出来**。
   *
   * 早先只数成功的（`attachments` / `inlined`），失败的那些留在节点上：
   *   · 附件 → `out[idx]` 保持包内路径（`xap:attachments/视频.mp4`），
   *            那在本地根本不存在。节点上照样显示附件图标，
   *            点开才发现打不开，而界面刚说过「已导入（含 1 个附件）」——
   *            数是成功数，失败的那个**一个字都没提**。
   *   · 图片 → 同理，`d.image` 保持包内路径，画面上一片空白。
   *
   * 真实的失败路径是**配额**：附件字节存进 IndexedDB，配额触顶时
   * `saveAsset` 返回 null（本文件别处的注释已点名这个场景）。
   * 静默失败的后果与 BUG 126（下载没发出去却说「已保存」）同一类：
   * 界面给了一个**不存在**的东西，而用户无从察觉。
   */
  let assetsFailed = 0;
  let imagesFailed = 0;

  for (const s of wb.sheets) {
    const km = parseKm(s.content);
    if (!km) continue;
    touched.push({ sheet: s, km });
    walkKmNodes(km, (node) => {
      const d = node.data;
      if (!d) return;
      /*
       * 图片：包内引用 → 内联 dataURI（**同步**，不依赖 saveAsset）。
       *
       * 必须先于附件那一段做，且不能挪到 `if (saveAsset)` 里 —— 图片能不能
       * 显示跟外部存储没关系，字节本来就在包里；挪进去的话「不传 saveAsset」
       * 的场景（预览 / 只读解析）图片就又不显示了。
       */
      const imgRef = str(d.image);
      const imgPath = imgRef ? packPathOf(imgRef) : null;
      if (imgPath) {
        const uri = bytesToDataUri(entries.get(imgPath), imgPath);
        if (uri) { d.image = uri; inlined++; }
        else imagesFailed++;   // BUG 155：包里没有这张图 → 引用成了死链
      }
      if (!saveAsset) return;
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
          // 剥掉可能的 `xap:` 前缀才是 zip 里的条目名（BUG 118）
          const data = entries.get(packPathOf(v));
          // BUG 155：包里没有这个条目 → 引用就地变成死链，必须数出来
          if (!data) { assetsFailed++; return; }
          const name = stripPackSeq(sanitizeFileName(v.split('/').pop() || 'attach'));
          tasks.push(
            Promise.resolve(saveAsset(name, data, { video: key === 'video' }))
              .then((ref) => {
                if (ref) { out[idx] = ref; attachments++; }
                else assetsFailed++;   // BUG 155：存不进本地库（配额满）
              })
              .catch(() => { assetsFailed++; /* 单个附件失败不影响整体导入 */ }),
          );
        });
        // 注意：**不能在这里写回**。out[idx] 此刻还是占位值（包内路径），
        // saveAsset 尚未 resolve —— 写进去就把路径固化了，
        // 结果是「导出再导入后附件引用仍是 resources/…，全部打不开」。
      }
    });
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
    // 从包里内联出来的图片数（供 UI 提示；不算在 attachments 里）
    inlined,
    // BUG 155：上面两个是**成功数**；这两个是没还原成的，界面必须说
    assetsFailed,
    imagesFailed,
  };
}

/** 供 UI 判断文件是否是 .xmind */
export const isXMindName = (name) => /\.xmind$/i.test(String(name || ''));
