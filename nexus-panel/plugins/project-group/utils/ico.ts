/**
 * ICO 容器拼装（#7 剪贴板图片入库）
 * ============================================================
 * 只做**容器**，不做编解码 —— 像素缩放与 PNG 编码交给浏览器的 canvas
 * （`canvas.toBlob('image/png')`），那是原生能力，支持所有浏览器能显示的
 * 格式（PNG / JPEG / BMP / WebP…），不必在 Rust 侧再引一套图像库。
 *
 * 为什么必须转成 ICO
 * ------------------------------------------------------------
 * 后端 `fpx_save_icon_data` 存的文件名固定是 `{safe}.ico`。
 * 若把剪贴板里的 **PNG 原样写盘**，得到的是一个"名字叫 .ico、内容却是 PNG"
 * 的文件 —— Windows 资源管理器按 ICO 结构去解析，轻则显示不出来，
 * 重则整个文件夹图标变成空白，而且**没有任何报错**。
 * 所以入库前必须真的产出 ICO。
 *
 * 为什么用 PNG 内嵌而不是 BMP
 * ------------------------------------------------------------
 * Vista 起的 ICO 支持条目数据直接是 PNG（不用手写 BITMAPINFOHEADER +
 * BGRA 行倒置 + AND 掩码）。省掉一整层容易写错的字节操作，
 * 而且 256×256 用 PNG 压缩后体积小得多（256 的 BMP 单条目就是 256KB）。
 *
 * 参考：ICONDIR + ICONDIRENTRY，全部小端。
 */

/** 一个尺寸条目：size 是边长（像素），png 是该尺寸编码后的 PNG 字节 */
export interface IcoEntry {
  size: number;
  png: Uint8Array;
}

/**
 * 拼装 ICO。
 *
 * @param entries 按需要的尺寸给出（可任意顺序，内部不重排 —— 调用方决定顺序）
 */
export function buildIco(entries: IcoEntry[]): Uint8Array {
  const n = entries.length;
  if (n === 0) throw new Error('至少要有一个尺寸');
  if (n > 255) throw new Error('ICO 条目数不能超过 255');

  const HEADER = 6;
  const DIR_ENTRY = 16;
  let total = HEADER + DIR_ENTRY * n;
  for (const e of entries) total += e.png.length;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  // ICONDIR
  dv.setUint16(0, 0, true);   // reserved，必须为 0
  dv.setUint16(2, 1, true);   // type：1 = icon（2 是 cursor）
  dv.setUint16(4, n, true);

  /*
   * 数据区起点必须**先算好**再写条目 ——
   * 每个条目的 imageOffset 都要知道前面所有 PNG 的长度。
   */
  let offset = HEADER + DIR_ENTRY * n;
  entries.forEach((e, i) => {
    const at = HEADER + DIR_ENTRY * i;
    /*
     * 尺寸字段只有 1 字节，**0 表示 256**。
     * 直接写 256 会溢出成 0 —— 恰好也是"256"，但那是巧合不是正确：
     * 若哪天改成写 255 就会变成真的 255px，且不报错。
     * 显式映射才说得清意图。
     *
     * 写成 if 而不是三元 —— 三元里的 `? :` 会被类型剥离器误判成
     * 可选参数标记（`name?: type`），产物留下冒号 → 运行时语法错误。
     */
    let dim = e.size;
    if (dim >= 256) dim = 0;
    dv.setUint8(at, dim);
    dv.setUint8(at + 1, dim);
    dv.setUint8(at + 2, 0);          // 颜色数；32bpp 时为 0
    dv.setUint8(at + 3, 0);          // reserved
    dv.setUint16(at + 4, 1, true);   // planes
    dv.setUint16(at + 6, 32, true);  // bitCount（PNG 内嵌时也要给 32）
    dv.setUint32(at + 8, e.png.length, true);
    dv.setUint32(at + 12, offset, true);

    out.set(e.png, offset);
    offset += e.png.length;
  });

  return out;
}

/**
 * 把 ICO 字节转成 base64（后端 `data_base64` 要的是纯 base64，无 dataURL 前缀）。
 *
 * 分块处理：一次性 `String.fromCharCode(...arr)` 在大数组上会爆调用栈
 * （256×256 的 ICO 轻松超过 10 万个参数）。
 */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** 入库用的尺寸档位：覆盖资源管理器会用到的全部场景 */
export const ICO_SIZES = [16, 32, 48, 256] as const;

/* ---------------------- 浏览器侧：图片 → ICO ---------------------- */

/**
 * 把一个图片文件（PNG / JPEG / BMP / WebP…）转成多尺寸 ICO 的 base64。
 *
 * @param file  来自剪贴板或拖放的图片
 * @param sizes 要生成的尺寸；省略则用 ICO_SIZES
 * @returns 纯 base64（无 dataURL 前缀），可直接交给 `saveIconData`
 */
/*
 * 尺寸固定用 ICO_SIZES，不开放成参数。
 *
 * 不是"少给个选项"，而是：参数带默认值（`sizes: T = X`）或可选（`sizes?: T`）
 * 时，类型剥离器处理不了 —— 产物会留下 `sizes: T = ...` / `sizes?: T`
 * 里的冒号或问号，直接是运行时语法错误。等剥离器支持了再开放。
 */
export async function imageToIcoBase64(file: Blob): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const entries: IcoEntry[] = [];
    for (const size of ICO_SIZES) {
      entries.push({ size, png: await renderPng(img, size) });
    }
    return toBase64(buildIco(entries));
  } finally {
    /*
     * 必须释放：objectURL 不 revoke 会让整个 Blob 一直占着内存，
     * 连着粘贴几张大图就能看出内存涨上去。
     */
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    /* 解码失败要显式报错：不挂 onerror 的话会一直挂着不返回，
       界面表现为"粘贴了但没反应"，且没有任何提示。 */
    img.onerror = () => reject(new Error('图片解码失败（可能不是支持的图片格式）'));
    img.src = src;
  });
}

/**
 * 把图片渲染成指定边长的 PNG。
 *
 * **按原图比例居中缩放并补透明**，不做拉伸 ——
 * 图标绝大多数是正方形，但剪贴板里也常有截图（16:9），
 * 硬拉成正方形会让图标变形到认不出来。
 */
async function renderPng(img: HTMLImageElement, size: number): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');

  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  /*
   * 取**较长边**去适配画布（contain）：短边留出的空隙填透明。
   * 用较短边（cover）会裁掉图像内容 —— 图标被裁掉一角更难看，也认不出。
   */
  const scale = Math.min(size / (sw || size), size / (sh || size));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  ctx.imageSmoothingEnabled = true;
  /* 缩到 16×16 这种尺寸时，不指定 high 会用双线性，细节糊成一团 */
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);

  const blob = await new Promise<Blob | null>((resolve) => {
    c.toBlob((b) => resolve(b), 'image/png');
  });
  if (!blob) throw new Error(`PNG 编码失败（${size}×${size}）`);
  return new Uint8Array(await blob.arrayBuffer());
}
