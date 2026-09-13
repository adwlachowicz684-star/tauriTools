/**
 * 文件 / 媒体元信息探测
 * ============================================================
 * 右侧栏「文件」页签要展示两类信息：
 *
 *   文件信息  —— 名称、大小、类型、修改时间（File 自带，同步可得）
 *   视频元信息 —— 分辨率、帧率、比特率、视频编码、音频编码、时长
 *
 * 第二部分浏览器 API 只给得出一半：
 *   · duration / videoWidth / videoHeight  ← HTMLVideoElement 能拿
 *   · 帧率、编解码器                        ← **拿不到**，必须自己解容器
 *
 * 所以这里自己解析容器头部（MP4 / MOV 的 box 树、WebM 的 EBML），
 * 再与 video 元素拿到的时长、分辨率合并。
 *
 * 设计要点：
 *   · 纯字节解析部分（parseContainer 及其子函数）不碰 DOM，可在 Node 里直接单测；
 *   · 只读文件头尾各 2MB —— 大文件不能整个读进内存；
 *     moov 常在尾部（非流式优化的 mp4），故头尾都要试；
 *   · 任何一步失败都返回已拿到的部分，绝不抛给调用方。
 */

/* --------------------------- 字节读取工具 --------------------------- */

const u8 = (b, o) => (o >= 0 && o < b.length ? b[o] : 0);
const u16 = (b, o) => ((u8(b, o) << 8) | u8(b, o + 1)) & 0xffff;
const u32 = (b, o) => (((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0);
/** 读 4 字符 box type；非可打印字符会出现在损坏文件里，直接原样返回便于排查 */
const tag4 = (b, o) => String.fromCharCode(u8(b, o), u8(b, o + 1), u8(b, o + 2), u8(b, o + 3));
/** 64 位：JS 位运算只到 32 位，用浮点拼（时长/帧数不会溢出精度） */
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const ascii = (b, o, n) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = u8(b, o + i);
    if (c < 0x20 || c > 0x7e) break;
    s += String.fromCharCode(c);
  }
  return s;
};

/* --------------------------- MP4 / MOV --------------------------- */

/** 需要继续往下钻的容器 box */
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'udta']);

/**
 * 遍历 box 列表。
 * size==1 表示 64 位长度（紧接 8 字节 largesize）；size==0 表示延伸到文件尾。
 * 任何一项越界立即停下 —— 损坏文件不该让整个面板崩掉。
 */
function walkBoxes(buf, start, end, onBox, depth = 0) {
  let o = start;
  let guard = 0;
  while (o + 8 <= end && guard++ < 4096) {
    let size = u32(buf, o);
    const type = tag4(buf, o + 4);
    let hdr = 8;
    if (size === 1) {
      size = u64(buf, o + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (!Number.isFinite(size) || size < hdr || o + size > end) break;

    const bodyStart = o + hdr;
    const bodyEnd = o + size;
    onBox(type, bodyStart, bodyEnd, depth);
    if (MP4_CONTAINERS.has(type) && depth < 8) {
      walkBoxes(buf, bodyStart, bodyEnd, onBox, depth + 1);
    }
    o = bodyEnd;
  }
}

/** stsd 里 VideoSampleEntry 固定头部长度（到 compressorname 结束） */
const VIDEO_ENTRY_HDR = 78;
/** stsd 里 AudioSampleEntry 固定头部长度（到 samplerate 结束） */
const AUDIO_ENTRY_HDR = 28;

function parseStsd(buf, s, e, track) {
  const count = u32(buf, s + 4);
  let o = s + 8;                       // 跳过 version/flags(4) + entry_count(4)
  for (let i = 0; i < count && o + 8 <= e; i++) {
    const size = u32(buf, o);
    const fmt = tag4(buf, o + 4);
    if (size < 8 || o + size > e) break;
    const body = o + 8;
    const isVideo = track.kind === 'video';
    const isAudio = track.kind === 'audio';

    if (isVideo) {
      track.format = fmt;
      // width/height 在 entry body 固定偏移处（16.16 之前的 2 字节整数）
      track.width = u16(buf, body + 24);
      track.height = u16(buf, body + 26);
      // 子 box：avcC / hvcC / av1C 里才有编码档位
      walkBoxes(buf, body + VIDEO_ENTRY_HDR, o + size, (t2, b2, e2) => {
        if (t2 === 'avcC' && e2 - b2 >= 4) {
          track.profileIdc = u8(buf, b2 + 1);
          track.levelIdc = u8(buf, b2 + 3);
        } else if ((t2 === 'hvcC' || t2 === 'hev1C') && e2 - b2 >= 13) {
          // general_profile_idc 在 configurationVersion(1) 之后的低 5 位
          track.profileIdc = u8(buf, b2 + 1) & 0x1f;
          track.levelIdc = u8(buf, b2 + 12);
        }
      });
    } else if (isAudio) {
      track.format = fmt;
      track.channels = u16(buf, body + 16);
      track.sampleBits = u16(buf, body + 18);
      // samplerate 是 16.16 定点，整数部分在高 16 位
      track.sampleRate = u16(buf, body + 24) + u16(buf, body + 26) / 65536;
    }
    o += size;
  }
}

function parseTrak(buf, s, e) {
  const t = {
    kind: null, format: null, width: 0, height: 0,
    timescale: 0, duration: 0, samples: 0,
    channels: 0, sampleRate: 0, sampleBits: 0,
  };

  walkBoxes(buf, s, e, (type, bs, be) => {
    if (type !== 'mdia') return;
    walkBoxes(buf, bs, be, (t2, b2, e2) => {
      if (t2 === 'hdlr' && e2 - b2 >= 12) {
        // version/flags(4) + pre_defined(4) + handler_type(4)
        const h = tag4(buf, b2 + 8);
        t.kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : h;
      } else if (t2 === 'mdhd' && e2 - b2 >= 16) {
        const ver = u8(buf, b2);
        if (ver === 1 && e2 - b2 >= 32) {
          t.timescale = u32(buf, b2 + 20);
          t.duration = u64(buf, b2 + 24);
        } else {
          t.timescale = u32(buf, b2 + 12);
          t.duration = u32(buf, b2 + 16);
        }
      } else if (t2 === 'minf') {
        walkBoxes(buf, b2, e2, (t3, b3, e3) => {
          if (t3 !== 'stbl') return;
          walkBoxes(buf, b3, e3, (t4, b4, e4) => {
            if (t4 === 'stsd') {
              parseStsd(buf, b4, e4, t);
            } else if (t4 === 'stts') {
              // entry_count(4) + [sample_count(4) sample_delta(4)]*
              const n = u32(buf, b4 + 4);
              let total = 0;
              for (let i = 0; i < n && b4 + 8 + i * 8 + 4 <= e4; i++) {
                total += u32(buf, b4 + 8 + i * 8);
              }
              t.samples = total;
            }
          });
        });
      }
    });
  });

  return t;
}

/** 解析 moov：全局时长 + 各轨道 */
function parseMoov(buf, s, e, out) {
  walkBoxes(buf, s, e, (type, bs, be) => {
    if (type === 'mvhd' && be - bs >= 16) {
      const ver = u8(buf, bs);
      if (ver === 1 && be - bs >= 32) {
        out.movieTimescale = u32(buf, bs + 20);
        out.durationRaw = u64(buf, bs + 24);
      } else {
        out.movieTimescale = u32(buf, bs + 12);
        out.durationRaw = u32(buf, bs + 16);
      }
      if (out.movieTimescale) out.duration = out.durationRaw / out.movieTimescale;
    } else if (type === 'trak') {
      const t = parseTrak(buf, bs, be);
      if (t.kind) out.tracks.push(t);
    }
  });
}

/**
 * 扫描整个缓冲找 moov —— 用于「从任意偏移切出来的片段」。
 *
 * 为什么需要：moov 常位于文件尾部（非流式优化的 mp4）。读尾部 2MB 时，
 * 片段开头大概率落在 mdat 数据中间，walkBoxes 会把它当成一个 size=0 的
 * box（size==0 意为延伸到文件尾）然后直接停下 —— 于是永远走不到 moov。
 * 这时只能靠特征字节定位。
 */
function findMoov(buf) {
  const M = [0x6d, 0x6f, 0x6f, 0x76];        // 'moov'
  for (let i = 4; i + 4 <= buf.length; i++) {
    if (buf[i] !== M[0] || buf[i + 1] !== M[1] || buf[i + 2] !== M[2] || buf[i + 3] !== M[3]) continue;
    // 紧邻的前 4 字节是 size；校验一下，避免撞上数据里的巧合字节
    const size = u32(buf, i - 4);
    if (size >= 8 && i - 4 + size <= buf.length) return { start: i + 4, end: i - 4 + size };
    // size 为 1（64 位长度）时前面是 8+8 字节，这里也接受，按到缓冲末尾解析
    if (size === 1 && i - 4 + 16 <= buf.length) {
      const big = u64(buf, i - 4 + 8);
      const boxStart = i - 4;
      const end = Math.min(buf.length, boxStart + big);
      if (end > i + 4) return { start: i + 4, end };
    }
  }
  return null;
}

/**
 * 判断是不是 MP4/MOV：ftyp 的 brand，或存在 moov。
 * MOV 用同样的 box 结构（qtff），brand 是 'qt  '，因此一并支持。
 */
export function parseMp4(buf) {
  const out = { container: null, tracks: [], duration: 0, movieTimescale: 0, durationRaw: 0 };
  let brand = '';
  let found = false;

  walkBoxes(buf, 0, buf.length, (type, bs, be) => {
    if (type === 'ftyp') {
      brand = ascii(buf, bs, 4);
      out.container = /^(qt|M4V|mp4|isom|iso2|avc1|dash|MSNV)/i.test(brand) ? 'MP4/MOV' : null;
      out.brand = brand.trim();
    } else if (type === 'moov') {
      parseMoov(buf, bs, be, out);
      found = true;
    }
  });

  // 常规遍历没走到（片段起点落在数据中间），退化为特征字节扫描
  if (!found) {
    const m = findMoov(buf);
    if (m) {
      parseMoov(buf, m.start, m.end, out);
      found = true;
      out.__recovered = true;
    }
  }

  // 没有 ftyp 但找到了 moov（少见的老文件），也认
  if (!out.container && found) out.container = 'MP4/MOV';
  if (!found && !out.container) return null;
  return postProcess(out);
}

function postProcess(out) {
  const v = out.tracks.find((t) => t.kind === 'video');
  const a = out.tracks.find((t) => t.kind === 'audio');

  if (v) {
    out.videoCodec = codecName(v.format);
    out.videoCodecDetail = codecDetail(v);
    if (!out.width && v.width) { out.width = v.width; out.height = v.height; }
    // 帧率 = 总采样数 / 轨道时长（秒）。stts 缺失时回退为 0，交给 video 元素采样。
    if (v.samples && v.timescale && v.duration) {
      const secs = v.duration / v.timescale;
      if (secs > 0) out.frameRate = roundFps(v.samples / secs);
    }
  }
  if (a) {
    out.audioCodec = codecName(a.format);
    out.audioChannels = a.channels;
    out.audioSampleRate = Math.round(a.sampleRate);
  }
  return out;
}

function roundFps(f) {
  if (!f || !isFinite(f)) return 0;
  // 常见帧率对齐，避免 29.97 显示成 29.97002997
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
  for (const c of common) if (Math.abs(f - c) < 0.03) return c;
  return Math.round(f * 1000) / 1000;
}

/** stsd 四字符码 → 人类可读的编码名 */
function codecName(fmt) {
  if (!fmt) return null;
  const f = fmt.trim();
  const map = {
    avc1: 'H.264', avc3: 'H.264', avc4: 'H.264',
    hvc1: 'H.265', hev1: 'H.265',
    av01: 'AV1',
    vp09: 'VP9', vp08: 'VP8',
    mp4a: 'AAC',
    'ac-3': 'Dolby AC-3', 'ec-3': 'Dolby E-AC-3',
    alac: 'ALAC', flac: 'FLAC',
    Opus: 'Opus', opus: 'Opus',
    '.mp3': 'MP3', ms55: 'MP3',
    dtsc: 'DTS', 'dtsh': 'DTS-HD',
    'raw ': 'PCM', lpcm: 'PCM', sowt: 'PCM',
    c608: 'CEA-608', c708: 'CEA-708',
  };
  return map[f] || map[f.toLowerCase()] || f.trim();
}

/** 附加档位信息，如 "High@4.0" */
function codecDetail(track) {
  const name = codecName(track.format);
  if (name === 'H.264' && track.profileIdc) {
    const profiles = {
      66: 'Baseline', 77: 'Main', 88: 'Extended',
      100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4',
    };
    const p = profiles[track.profileIdc] || `Profile ${track.profileIdc}`;
    const lv = track.levelIdc ? (track.levelIdc / 10).toFixed(1) : null;
    return lv ? `${p}@${lv}` : p;
  }
  if (name === 'H.265' && track.profileIdc) {
    const profiles = { 1: 'Main', 2: 'Main 10', 3: 'Main Still' };
    const p = profiles[track.profileIdc] || `Profile ${track.profileIdc}`;
    const lv = track.levelIdc ? (track.levelIdc / 30).toFixed(1) : null;
    return lv ? `${p}@${lv}` : p;
  }
  return null;
}

/* --------------------------- WebM / Matroska --------------------------- */

const EBML = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  DEFAULT_DURATION: 0x23e383,
  DISPLAY_WIDTH: 0x54b0,
  DISPLAY_HEIGHT: 0x54ba,
  AUDIO: 0xe1,
  CHANNELS: 0x9f,
  SAMPLING_FREQ: 0xb5,
  DURATION: 0x4489,
  TIMECODE_SCALE: 0x2ad7b1,
};

/** 读 EBML 变长整数（长度前缀的 1 的个数决定字节数） */
function readVint(buf, o, end) {
  if (o >= end) return null;
  const first = buf[o];
  let len = 0;
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) { len = i + 1; break; }
  }
  if (!len || o + len > end) return null;
  // 未知长度（全 1）只用于 size，这里不接受
  let value = first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + buf[o + i];
  return { value, len, allOnes: (first & (0xff >> len)) === (0xff >> len) && len < 8 ? false : false };
}

/** 读元素 ID：长度前缀原样保留（marker bit 也在里面），便于直接比对常量 */
function readId(buf, o, end) {
  if (o >= end) return null;
  const first = buf[o];
  let len = 0;
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) { len = i + 1; break; }
  }
  if (!len || o + len > end) return null;
  let value = first;
  for (let i = 1; i < len; i++) value = value * 256 + buf[o + i];
  return { value, len };
}

function scanEbml(buf, start, end, onElem, depth = 0) {
  let o = start;
  let guard = 0;
  while (o < end && guard++ < 4096) {
    const id = readId(buf, o, end);
    if (!id) break;
    const sizeV = readVint(buf, o + id.len, end);
    if (!sizeV) break;
    let payloadStart = o + id.len + sizeV.len;
    let payloadEnd;
    if (sizeV.value === (1 << (7 * sizeV.len)) - 1 && sizeV.len < 8) {
      payloadEnd = end;                 // 未知长度，延伸到父级末尾
    } else {
      payloadEnd = payloadStart + sizeV.value;
    }
    if (payloadEnd > end) payloadEnd = end;
    if (payloadStart > end) break;

    onElem(id.value, payloadStart, payloadEnd, depth);
    o = payloadEnd;
  }
}

const WEBM_CODECS = {
  'V_VP8': 'VP8', 'V_VP9': 'VP9', 'V_AV1': 'AV1',
  'V_MPEG4/ISO/AVC': 'H.264', 'V_MPEGH/ISO/HEVC': 'H.265',
  'V_THEORA': 'Theora',
  'A_OPUS': 'Opus', 'A_VORBIS': 'Vorbis', 'A_AAC': 'AAC',
  'A_MPEG/L3': 'MP3', 'A_FLAC': 'FLAC', 'A_PCM/INT/LIT': 'PCM',
  'A_AC3': 'Dolby AC-3', 'A_EAC3': 'Dolby E-AC-3',
};

export function parseWebm(buf) {
  const out = { container: null, tracks: [], duration: 0 };
  let isEbml = false;

  scanEbml(buf, 0, buf.length, (id, s, e) => {
    if (id === 0x1a45dfa3) isEbml = true;
    if (id !== EBML.SEGMENT) return;

    scanEbml(buf, s, e, (id2, s2, e2) => {
      if (id2 === EBML.TRACKS) {
        scanEbml(buf, s2, e2, (id3, s3, e3) => {
          if (id3 !== EBML.TRACK_ENTRY) return;
          const t = { kind: null, codecId: null, width: 0, height: 0, defaultDuration: 0, channels: 0, sampleRate: 0 };
          scanEbml(buf, s3, e3, (id4, s4, e4) => {
            if (id4 === EBML.TRACK_TYPE && e4 > s4) t.kind = buf[s4] === 1 ? 'video' : buf[s4] === 2 ? 'audio' : null;
            else if (id4 === EBML.CODEC_ID) t.codecId = ascii(buf, s4, e4 - s4);
            else if (id4 === EBML.DEFAULT_DURATION && e4 - s4 >= 1) t.defaultDuration = readUintBytes(buf, s4, e4);
            else if (id4 === EBML.VIDEO) {
              scanEbml(buf, s4, e4, (id5, s5, e5) => {
                if (id5 === EBML.PIXEL_WIDTH) t.width = readUintBytes(buf, s5, e5);
                else if (id5 === EBML.PIXEL_HEIGHT) t.height = readUintBytes(buf, s5, e5);
              });
            } else if (id4 === EBML.AUDIO) {
              scanEbml(buf, s4, e4, (id5, s5, e5) => {
                if (id5 === EBML.CHANNELS) t.channels = readUintBytes(buf, s5, e5);
                else if (id5 === EBML.SAMPLING_FREQ) t.sampleRate = readFloatBytes(buf, s5, e5);
              });
            }
          });
          // 显示宽高优先（有黑边裁剪时与存储宽高不同）
          out.tracks.push(t);
        });
      } else if (id2 === EBML.INFO) {
        scanEbml(buf, s2, e2, (id3, s3, e3) => {
          if (id3 === EBML.TIMECODE_SCALE) out.timecodeScale = readUintBytes(buf, s3, e3);
          else if (id3 === EBML.DURATION) out.duration = readFloatBytes(buf, s3, e3);
        });
      }
    });
  });

  if (!isEbml) return null;
  // WebM 的 Duration 单位是 timecode scale 纳秒（默认 1e6，即毫秒）
  if (out.duration && out.timecodeScale) out.duration = (out.duration * out.timecodeScale) / 1e9;
  else if (out.duration) out.duration = out.duration / 1000;   // 默认 ms

  out.container = 'WebM';
  const v = out.tracks.find((t) => t.kind === 'video');
  const a = out.tracks.find((t) => t.kind === 'audio');
  if (v) {
    out.videoCodec = WEBM_CODECS[v.codecId] || v.codecId;
    out.width = v.width;
    out.height = v.height;
    // DefaultDuration 是每帧纳秒数
    if (v.defaultDuration) out.frameRate = roundFps(1e9 / v.defaultDuration);
  }
  if (a) {
    out.audioCodec = WEBM_CODECS[a.codecId] || a.codecId;
    out.audioChannels = a.channels;
    out.audioSampleRate = Math.round(a.sampleRate);
  }
  return out;
}

function readUintBytes(buf, s, e) {
  let v = 0;
  for (let i = s; i < e && i < buf.length; i++) v = v * 256 + buf[i];
  return v;
}

function readFloatBytes(buf, s, e) {
  const n = e - s;
  if (n === 4) return buf.readFloatBE ? buf.readFloatBE(s) : new DataView(buf.buffer, buf.byteOffset + s, 4).getFloat32(0);
  if (n === 8) return buf.readDoubleBE ? buf.readDoubleBE(s) : new DataView(buf.buffer, buf.byteOffset + s, 8).getFloat64(0);
  return 0;
}

/* --------------------------- 对外：容器探测 --------------------------- */

const HEAD_TAIL_BYTES = 2 * 1024 * 1024;   // 头尾各读 2MB

/**
 * 读文件头尾字节，自动识别容器并解析。
 * 纯字节操作，不依赖 DOM，可在 Node 里直接单测。
 *
 * @param {Blob|File} blob
 * @returns {Promise<object|null>}
 */
export async function parseContainer(blob) {
  if (!blob || typeof blob.slice !== 'function' || !blob.size) return null;
  try {
    const head = await readChunk(blob, 0, Math.min(HEAD_TAIL_BYTES, blob.size));
    if (!head) return null;

    // 先试头部（流式优化的 mp4 / webm 的 Tracks 都在头部附近）
    let r = tryParse(head);
    if (r && (r.tracks?.length || r.duration)) return withSource(r, 'head');

    // moov 常在尾部：再读一段尾部，只取其中的 moov 部分重试
    if (blob.size > HEAD_TAIL_BYTES) {
      const tail = await readChunk(blob, Math.max(0, blob.size - HEAD_TAIL_BYTES), blob.size);
      if (tail) {
        const r2 = tryParse(tail);
        if (r2 && (r2.tracks?.length || r2.duration)) return withSource(r2, 'tail');
      }
    }
    return r ? withSource(r, 'head') : null;
  } catch {
    return null;
  }
}

function tryParse(u8arr) {
  try {
    const r = parseMp4(u8arr);
    if (r) return r;
  } catch { /* 继续试下一种 */ }
  try {
    const r = parseWebm(u8arr);
    if (r) return r;
  } catch { /* 都不是 */ }
  return null;
}

function withSource(r, src) {
  r.__source = src;
  return r;
}

async function readChunk(blob, start, end) {
  let part;
  try {
    part = blob.slice(start, end);
  } catch {
    return null;
  }
  // Blob.arrayBuffer() 在部分环境（含 jsdom）不存在，必须留 FileReader 回退；
  // 直接调并在 catch 里返回 null，会让容器解析静默失败、元信息一片空白。
  try {
    if (typeof part.arrayBuffer === 'function') {
      return new Uint8Array(await part.arrayBuffer());
    }
  } catch { /* 落到 FileReader */ }
  if (typeof FileReader === 'undefined') return null;
  return new Promise((resolve) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result));
      fr.onerror = () => resolve(null);
      fr.readAsArrayBuffer(part);
    } catch {
      resolve(null);
    }
  });
}

/* --------------------------- 对外：video 元素探测 --------------------------- */

/**
 * 用 HTMLVideoElement 拿时长与分辨率（容器解析拿不到时需要它兜底）。
 * jsdom 等无解码能力的环境会走 error 或超时，返回 null。
 */
export function probeByElement(blob, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || !blob) { resolve(null); return; }
    let v = null;
    let url = null;
    let settled = false;
    const fin = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (url) URL.revokeObjectURL(url); } catch { /* ignore */ }
      try { if (v) { v.removeAttribute('src'); v.load(); } } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => fin(null), timeoutMs);

    try {
      v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      url = URL.createObjectURL(blob);
      v.onloadedmetadata = () => {
        fin({
          duration: Number.isFinite(v.duration) ? v.duration : 0,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
        });
      };
      v.onerror = () => fin(null);
      v.src = url;
    } catch {
      fin(null);
    }
  });
}

/**
 * 完整视频元信息：容器解析 + video 元素，两者互补。
 * 容器能给编码/帧率；video 元素能给准确的时长与显示分辨率。
 */
export async function probeVideo(blob) {
  const el = await probeByElement(blob);
  const cont = await parseContainer(blob);
  const out = {
    duration: 0, width: 0, height: 0, frameRate: 0,
    bitrate: 0, videoCodec: null, videoCodecDetail: null,
    audioCodec: null, audioChannels: 0, audioSampleRate: 0,
    container: null,
  };

  if (cont) {
    out.container = cont.container;
    out.width = cont.width || 0;
    out.height = cont.height || 0;
    out.frameRate = cont.frameRate || 0;
    out.duration = cont.duration || 0;
    out.videoCodec = cont.videoCodec || null;
    out.videoCodecDetail = cont.videoCodecDetail || null;
    out.audioCodec = cont.audioCodec || null;
    out.audioChannels = cont.audioChannels || 0;
    out.audioSampleRate = cont.audioSampleRate || 0;
  }
  if (el) {
    // 时长：video 元素是解码器实测的，比容器里声明的 mvhd duration 可靠
    // （不少编码器把 mvhd duration 写成 0）。
    if (el.duration) out.duration = el.duration;
  }
  // 分辨率：以容器解析到的为准，video 元素只作兜底。
  // 不能反过来 —— videoWidth 是解码后的「显示尺寸」，遇到旋转元数据（rotate=90）
  // 会给出旋转后的值，而 stsd 里存的才是编码分辨率；且容器解析失败时不该
  // 拿上一个/兜底值冒充。
  if (!out.width && el?.width) { out.width = el.width; out.height = el.height; }
  // 整体比特率只能由「文件字节数 ÷ 时长」算（容器里声明的常不准）
  if (out.duration > 0 && blob?.size) out.bitrate = Math.round((blob.size * 8) / out.duration);
  return out;
}

/* --------------------------- 显示格式化 --------------------------- */

export function formatDuration(sec) {
  const s = Number(sec) || 0;
  if (!isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

export function formatBitrate(bps) {
  const v = Number(bps) || 0;
  if (!v) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + ' kbps';
  return v + ' bps';
}

export function formatFps(f) {
  const v = Number(f) || 0;
  if (!v) return '—';
  return `${v} fps`;
}

export function formatDateTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 声道数的常见叫法 */
export function formatChannels(n) {
  const v = Number(n) || 0;
  if (v === 1) return '单声道';
  if (v === 2) return '立体声';
  if (v === 6) return '5.1';
  if (v === 8) return '7.1';
  return v ? `${v} 声道` : null;
}

/** MIME 太啰嗦时给个简短说法（不改变原值，仅用于展示） */
export function shortType(type, name) {
  const t = String(type || '');
  if (t) return t;
  const ext = String(name || '').split('.').pop();
  return ext && ext !== name ? ext.toUpperCase() : '未知';
}
