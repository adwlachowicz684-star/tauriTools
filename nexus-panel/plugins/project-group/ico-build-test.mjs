/**
 * #7 ICO 容器拼装（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/ico-build-test.mjs
 *
 * 为什么值得单测：ICO 是**二进制容器**，写错一个偏移就整文件报废，
 * 而资源管理器只会显示"没图标"，不会告诉你哪里错了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const ico = R('utils/ico.ts');
const cfg = R('components/SettingsDialog.tsx');

console.log('\n=== 1. 动机：非 ICO 必须真转，不能原样写盘 ===');
{
  /* 后端文件名固定 {name}.ico，把 PNG 原样写盘会得到一个"叫 .ico 实为 PNG"的文件 */
  t('入库时判扩展名', /const isIco = lower\.endsWith\('\.ico'\);/.test(cfg));
  t('非 ICO 走转换', /: await imageToIcoBase64\(file\);/.test(cfg));
  t('ICO 原样用', /\? dataUrl\.split\(','\)\[1\] \?\? ''/.test(cfg));
  /* 名字要去掉原扩展名，否则得到 logo.png.ico 这种双后缀 */
  /*
   * 用 indexOf 而不是正则：源码里是 `/\.[^.]+$/`，
   * 写进正则字面量要转义一堆反斜杠，极易写错且写错了**静默为 false**（漏报）。
   */
  t('去掉原扩展名', cfg.indexOf("file.name.replace(/\\.[^.]+$/, '')") >= 0);
  /* 预览仍用原图（最清晰），落盘用 ICO */
  t('预览用原图', /stageWindowIcon\(saved, dataUrl\);/.test(cfg));
  t('提示说明了转换', /（已转为多尺寸 \.ico）/.test(cfg));
}

console.log('\n=== 2. 容器结构（ICONDIR）===');
{
  const { buildIco, toBase64, ICO_SIZES } = await loadTs(path.join(HERE, 'utils/ico.ts'));

  const png1 = new Uint8Array([1, 2, 3, 4]);
  const png2 = new Uint8Array([9, 9, 9]);
  const out = buildIco([
    { size: 16, png: png1 },
    { size: 32, png: png2 },
  ]);
  const dv = new DataView(out.buffer);

  t('reserved 为 0', dv.getUint16(0, true) === 0);
  t('type 为 1（icon）', dv.getUint16(2, true) === 1);
  t('条目数正确', dv.getUint16(4, true) === 2);
  t('总长 = 6 + 16*2 + 数据', out.length === 6 + 32 + 4 + 3);

  /* 第一个条目 */
  t('第1条 宽', dv.getUint8(6) === 16);
  t('第1条 高', dv.getUint8(7) === 16);
  t('第1条 planes=1', dv.getUint16(10, true) === 1);
  t('第1条 bitCount=32', dv.getUint16(12, true) === 32);
  t('第1条 字节数', dv.getUint32(14, true) === 4);
  t('第1条 偏移', dv.getUint32(18, true) === 6 + 32);

  /* 第二个条目：偏移必须跳过第一个的数据 */
  t('第2条 宽', dv.getUint8(22) === 32);
  t('第2条 字节数', dv.getUint32(30, true) === 3);
  t('第2条 偏移接着第1条', dv.getUint32(34, true) === 6 + 32 + 4);

  /* 数据真的写进去了 */
  t('第1条数据正确', out[38] === 1 && out[41] === 4);
  t('第2条数据正确', out[42] === 9 && out[44] === 9);
}

console.log('\n=== 3. 256 必须写成 0（只有 1 字节）===');
{
  const { buildIco } = await loadTs(path.join(HERE, 'utils/ico.ts'));
  const out = buildIco([{ size: 256, png: new Uint8Array([7]) }]);
  const dv = new DataView(out.buffer);
  /* 尺寸字段只有 1 字节，0 才表示 256 */
  t('256 写成 0', dv.getUint8(6) === 0);
  t('高也写 0', dv.getUint8(7) === 0);
  const out2 = buildIco([{ size: 255, png: new Uint8Array([7]) }]);
  t('255 仍写 255', new DataView(out2.buffer).getUint8(6) === 255);
}

console.log('\n=== 4. 边界 ===');
{
  const { buildIco } = await loadTs(path.join(HERE, 'utils/ico.ts'));
  let threw = false;
  try { buildIco([]); } catch { threw = true; }
  t('空条目抛错', threw);
  let threw2 = false;
  try { buildIco(Array.from({ length: 256 }, () => ({ size: 16, png: new Uint8Array([1]) }))); } catch { threw2 = true; }
  t('超过 255 条抛错', threw2);
}

console.log('\n=== 5. base64 ===');
{
  const { toBase64 } = await loadTs(path.join(HERE, 'utils/ico.ts'));
  t('基本编码', toBase64(new Uint8Array([1, 2, 3])) === btoa('\x01\x02\x03'));
  /* 分块：大数组一次性 fromCharCode 会爆调用栈 */
  const big = new Uint8Array(200000).fill(65);
  let threw = false;
  let s = '';
  try { s = toBase64(big); } catch { threw = true; }
  t('大数组不爆栈', !threw && s.length > 0);
  t('长度正确', s === btoa('A'.repeat(200000)));
}

console.log('\n=== 6. 尺寸档位 ===');
{
  const { ICO_SIZES } = await loadTs(path.join(HERE, 'utils/ico.ts'));
  /*
   * 对齐原版 IconConversion 的 { 16, 24, 32, 48, 64, 128, 256 }。
   *
   * 缺 24/64/128 的后果：资源管理器在中等/大/特大图标视图下要取 48 与 256
   * 之间的档位，没有帧就只能放大 32 或缩小 256 —— 图标发虚，
   * 且看不出是"少了档位"造成的，也没有任何报错。
   */
  for (const n of [16, 24, 32, 48, 64, 128, 256]) {
    t(`含 ${n}`, ICO_SIZES.includes(n));
  }
  t('就是这七档（不多不少）', ICO_SIZES.length === 7, `实际 ${ICO_SIZES.length} 档`);
}

console.log('\n=== 7. 源码里的关键注释（防回归）===');
{
  /*
   * 必须读**未剥离**的源码：上面 `ico` 是 strip 掉注释的版本，
   * 在那上面查注释文本永远是 false（漏报）。
   */
  const raw = fs.readFileSync(path.join(HERE, 'utils/ico.ts'), 'utf8');
  t('注释：说明了为什么要转', /叫 \.ico、内容却是 PNG/.test(raw));
  t('注释：说明了 256→0', /0 表示 256/.test(raw));
  t('注释：说明了要 revoke', /必须释放/.test(raw));
  /* 三元里的 ?: 会被剥离器误判 —— 这条注释提醒别改回去 */
  t('注释：提醒避开三元', /三元里的 `\? :` 会被类型剥离器误判/.test(raw));
}

done();
