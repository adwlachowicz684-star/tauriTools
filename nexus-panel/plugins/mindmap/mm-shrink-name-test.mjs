/**
 * 存量压缩（shrinkDataUrl）的失败提示必须指得到那一张
 * ============================================================
 * 要防的形状：**提示里报的名字，是一个不存在的文件**。
 *
 * shrinkDataUrl 会把内联的 dataURL 还原成一个临时 File 再走压缩流水线，
 * 早先那句扩展名判据是 `type === 'image/png' ? 'png' : 'jpg'` ——
 * 于是 GIF / SVG / WebP 一律被叫成 `inline.jpg`。这个名字**只出现在失败
 * 提示里**，用户看到的是：
 *
 *     「inline.jpg」是动图（2.1 MB），压缩会丢掉动画，未添加
 *
 * 三处都在说谎：
 *   · 磁盘上、节点上都没有 `inline.jpg` 这个东西；
 *   · 存量压缩并没有"添加"任何图片，说"未添加"会让人以为图被拿掉了
 *     （其实原样留着，压不动总比丢了强）；
 *   · 两张都失败时两条提示长得一模一样，分不清是哪一张。
 *
 * 判据一律**跑真身**（真调 shrinkDataUrl / imageToInline），
 * 不靠"源码里有没有 gif 这几个字" —— 后者证明不了提示里到底是哪个名字。
 */
import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
/* FileReader 只有浏览器有：io.js 用它把 File 读成 dataURL。
   这里补一个最小实现（只做 readAsDataURL 这一件事），不引 jsdom ——
   沙箱里的 jsdom 时有时无，缺依赖时模块加载就崩，而**崩掉的脚本会把
   后面的断言全吃掉**，看着像有红、其实一条都没验。 */
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      const b64 = Buffer.from(buf).toString('base64');
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
      this.onload && this.onload();
    }, () => { this.onerror && this.onerror(); });
  }
};

/* 取自脚本自身位置，不用 process.cwd()：从 nexus-panel 根目录跑（npm script
   就是这么跑的）时 cwd 里没有 io.js，模块加载直接崩。**崩掉的脚本会把后面
   的断言全吃掉**，看着像有红、其实一条都没验 —— 上一版就是这么静默失效的。 */
const HERE = new URL('.', import.meta.url).pathname;
const io = await import(new URL('io.js', import.meta.url).href);
const read = (p) => readFileSync(pjoin(HERE, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
const fails = [];
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
};

/** 造一个"超阈值"的 dataURL：内容无所谓，只要长度够、MIME 对 */
const big = (mime, n = 4000) => `data:${mime};base64,${'A'.repeat(n)}`;

/* ============================================================
   1. extOfMime：扩展名必须跟着真实类型走
   ============================================================ */
t('GIF 用 gif（不再被叫成 jpg）', io.extOfMime('image/gif') === 'gif', io.extOfMime('image/gif'));
t('SVG 用 svg', io.extOfMime('image/svg+xml') === 'svg', io.extOfMime('image/svg+xml'));
t('WebP 用 webp', io.extOfMime('image/webp') === 'webp', io.extOfMime('image/webp'));
t('PNG 仍是 png', io.extOfMime('image/png') === 'png', io.extOfMime('image/png'));
t('JPEG 仍是 jpg', io.extOfMime('image/jpeg') === 'jpg', io.extOfMime('image/jpeg'));
t('认不出的类型兜底 jpg（与旧行为一致，不放大改动面）',
  io.extOfMime('application/octet-stream') === 'jpg', io.extOfMime('application/octet-stream'));
t('空值也兜底 jpg', io.extOfMime('') === 'jpg' && io.extOfMime(undefined) === 'jpg');

/* ============================================================
   2. 跑真身：动图压缩不动时，提示里的名字是真的
   ============================================================ */
{
  /* maxInline 压到极小 → 一定"压不动"，走到报错分支 */
  const r = await io.shrinkDataUrl(big('image/gif'), { maxInline: 16 });
  t('动图压不动时给出失败原因', !!r.error, r.error || JSON.stringify(r));
  t('★ 提示里的扩展名是 .gif（不是编造的 inline.jpg）',
    !!r.error && r.error.includes('.gif') && !r.error.includes('inline.jpg'), r.error);
  t('★ 动作词是「未压缩」而不是「未添加」（存量压缩没在添加任何东西）',
    !!r.error && r.error.includes('未压缩') && !r.error.includes('未添加'), r.error);
}
{
  const r = await io.shrinkDataUrl(big('image/svg+xml'), { maxInline: 16 });
  t('★ 矢量图提示里的扩展名是 .svg', !!r.error && r.error.includes('.svg'), r.error);
  t('矢量图同样说「未压缩」', !!r.error && r.error.includes('未压缩'), r.error);
}
{
  const r = await io.shrinkDataUrl(big('image/png'), { maxInline: 16, maxSource: 8 });
  t('PNG 仍叫 .png（原有行为不变）', !!r.error && r.error.includes('.png'), r.error);
}

/* ============================================================
   3. 调用方传的名字要进提示（多张失败才分得清）
   ============================================================ */
{
  const r = await io.shrinkDataUrl(big('image/gif'), { maxInline: 16, name: '第 2 张' });
  t('★ 调用方给的名字进提示（不再一律 inline）',
    !!r.error && r.error.includes('第 2 张') && !r.error.includes('inline'), r.error);
}

/* ============================================================
   4. 新增路径的默认动作词不能被动过
   ============================================================ */
{
  const f = new File([new Uint8Array(64)], 'demo.gif', { type: 'image/gif' });
  const r = await io.imageToInline(f, { maxInline: 16 });
  t('新增路径仍说「未添加」（默认动作词没被改坏）',
    !!r.error && r.error.includes('未添加') && !r.error.includes('未压缩'), r.error);
  t('新增路径用真实文件名', !!r.error && r.error.includes('demo.gif'), r.error);
}

/* ============================================================
   5. panels.js：存量压缩必须带序号
   ============================================================ */
{
  const src = strip(read('panels.js'));
  const call = /io\.shrinkDataUrl\(list\[i\]([^)]*)\)/.exec(src);
  t('面板调到了存量压缩入口', !!call, call ? call[0] : '未找到');
  t('★ 调用带上 name（否则多张失败的提示一模一样）',
    !!call && /name\s*:\s*`第 \$\{i \+ 1\} 张`|name\s*:\s*[`'"]第/.test(call[1]), call ? call[1] : '');
}

/* ============================================================
   6. io.js：不得再有「非 png 一律 jpg」那句判据
   ============================================================ */
{
  const src = strip(read('io.js'));
  t("不再写死 image/png ? png : jpg 那句（它把 GIF/SVG 都叫成 jpg）",
    !/===\s*'image\/png'\s*\?\s*'png'\s*:\s*'jpg'|!==\s*'image\/png'\s*\?\s*'png'\s*:\s*'jpg'/.test(src));
  t('shrinkDataUrl 走 extOfMime（判据只有一份）',
    /const ext = extOfMime\(type\)/.test(src));
}

console.log(`\n存量压缩提示：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
