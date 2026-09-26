/**
 * 账本损坏时不得被空列表覆盖（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/record-corrupt-guard-test.mjs
 *
 * 一条完整的数据销毁链：
 *   账本损坏 → load_records_from_exact 返回 Err → load_records_from 的
 *   unwrap_or_default() 得到**空列表** → 迁移把空列表写回真实账本 →
 *   所有链接记录瞬间蒸发。
 *
 * 两道闸此前同时缺位：
 *   1. `load_records_from_exact` 走 `read_json_any`，只把错误变成 Err，
 *      既不另存现场、也不记进 CORRUPT_SITES —— 原文没有任何副本；
 *   2. `save_records_to` 没有 `guard_against_corrupt`，而守卫恰恰按
 *      CORRUPT_SITES 判断，列表是空的一律放行。
 *
 * 结果是坏掉即彻底丢失：既没有 .corrupt 现场，又被空列表覆盖掉原文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');

/* 取某个函数体：从签名起到下一个顶层 pub fn / 文件尾。
   不切片的话，两条断言会命中文件里别处的同名字样（本文件踩过多次）。 */
const bodyOf = (src, sig) => {
  const a = src.indexOf(sig);
  if (a < 0) return '';
  const b = src.indexOf('\npub fn ', a + sig.length);
  const c = src.indexOf('\nfn ', a + sig.length);
  const cand = [b, c].filter((x) => x > 0);
  return src.slice(a, cand.length ? Math.min(...cand) : src.length);
};

console.log('\n=== 1. 读取：必须走 load_strict（保留现场） ===');
{
  const store = strip(fs.readFileSync(path.join(RS, 'store.rs'), 'utf8'));
  const b = bodyOf(store, 'pub fn load_records_from_exact');
  t('函数体定位成功', b.length > 0);

  /*
   * 关键：走 load_strict 才会 quarantine（另存 .corrupt 现场 + 记进 CORRUPT_SITES）。
   * 用 read_json_any 的话两道闸一起落空。
   */
  t('走 load_strict', /load_strict\s*::\s*<RecordFile>/.test(b));
  t('不再用 read_json_any 读账本（反面证据）', !/read_json_any/.test(b));
  t('处理 Corrupted 分支', /LoadOutcome::Corrupted/.test(b));

  /*
   * 那个"读失败就返回空列表"的宽松版已从 store.rs 删除。
   * 留着它等于留一个会把数据清零的陷阱：下一次有人顺手调用，
   * 整条销毁链就原样重演，而没有任何编译错误提示。
   */
  t('危险的宽松版 load_records_from 已删除', !/pub fn load_records_from\(/.test(store));
}

console.log('\n=== 2. 写入：guard_against_corrupt 必须在 write_json 之前 ===');
{
  const store = strip(fs.readFileSync(path.join(RS, 'store.rs'), 'utf8'));
  const b = bodyOf(store, 'pub fn save_records_to');
  t('函数体定位成功', b.length > 0);

  const ig = b.indexOf('guard_against_corrupt');
  const iw = b.indexOf('write_json');
  /* 两端都必须存在 —— 否则 indexOf 返回 -1 时 `-1 < 正数` 恒真，断言空跑 */
  t('有 guard 也有 write_json（两端判存在）', ig >= 0 && iw >= 0);
  t('守卫在写入之前', ig >= 0 && iw >= 0 && ig < iw);

  /* 与 save_records 同规格：那条早就有守卫，这里不能是例外 */
  const sr = bodyOf(store, 'pub fn save_records(');
  t('save_records 同样有守卫（两条路径一致）', /guard_against_corrupt/.test(sr));
}

console.log('\n=== 3. 迁移：动手前先读账本，损坏即中止 ===');
{
  const cli = strip(fs.readFileSync(path.join(RS, 'cli.rs'), 'utf8'));

  /* 不得再用吞错误的那个版本 */
  t('不再用 load_records_from（吞错误）', !/store::load_records_from\(/.test(cli));
  t('改用 load_records_from_exact', /store::load_records_from_exact/.test(cli));

  /* 必须早退，而不是继续跑完再报错 */
  t('读取失败时 return（未做任何迁移）', /return format!\("账本读取失败/.test(cli));

  /*
   * 顺序：读账本必须早于物理搬目录。放到最后写回那步才检查的话，
   * 目录已经搬走、config 已经改写，停在半完成状态上更难收拾。
   */
  const iRead = cli.indexOf('load_records_from_exact');
  const iMove = cli.indexOf('rename_with_fallback');
  t('有读取也有搬移（两端判存在）', iRead >= 0 && iMove >= 0);
  t('读账本早于搬目录', iRead >= 0 && iMove >= 0 && iRead < iMove);

  /* 备份也要在动手前（原本就是，钉住免得被挪走） */
  const iBackup = cli.indexOf('backup_before_migrate');
  t('备份在搬目录之前', iBackup >= 0 && iMove >= 0 && iBackup < iMove);
}

done();
