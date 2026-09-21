/**
 * 备份目录只读展示「实际生效路径」（#29，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/backup-targets-test.mjs
 *
 * 设置里填的是**规则**，用户看不出最终落在哪儿：
 * 留空时退到数据目录下的 backup/，还要**再按类型加一层子目录**。
 * 那一层光看规则根本猜不到。
 *
 * 所以生效路径必须问后端，前端不能自己推 —— 推出来的会和后端漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const RS = path.join(ROOT, 'src-tauri', 'src', 'fpx');
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(n, 'utf8'));

const mod = R(path.join(RS, 'mod.rs'));
const backup = R(path.join(RS, 'backup.rs'));
const mainrs = strip(fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'main.rs'), 'utf8'));
const api = strip(fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8'));
const types = strip(fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8'));
const dlg = strip(fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8'));
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));

console.log('\n=== 1. 后端给出生效路径 ===');
{
  t('有 fpx_backup_targets 命令', /pub fn fpx_backup_targets\(/.test(mod));
  t('有 BackupTargets 结构', /pub struct BackupTargets/.test(backup));
  t('三个字段：两类 + 数据目录',
    /pub project: String/.test(backup) && /pub group: String/.test(backup)
    && /pub data_dir: String/.test(backup));
}

console.log('\n=== 2. 用同一个 resolver（最关键）===');
{
  /*
   * 显示的路径必须与实际写入的是同一个。
   * 若这里另算一套（哪怕照抄规则），后端改规则时就会漂移 ——
   * 用户照着显示的去查，找不到备份。
   */
  const body = mod.slice(mod.indexOf('pub fn fpx_backup_targets'));
  const seg = body.slice(0, body.indexOf('\n}') + 2);
  t('调 backup::resolve_dir', (seg.match(/backup::resolve_dir/g) || []).length === 2);
  t('两类各算一次', /"project"/.test(seg) && /"group"/.test(seg));
  /* 备份执行处（run）也调的是同一个 resolve_dir —— 这才是"同源"的证明。
     只断言"backup.rs 里有 resolve_dir"没意义：定义在里面当然有。 */
  const runBody = backup.slice(backup.indexOf('pub fn run('));
  t('备份执行处也调同一个 resolve_dir', /resolve_dir\(cfg, data_dir, kind\)/.test(runBody));
}

console.log('\n=== 3. 命令已注册（未注册则运行时报 not found）===');
{
  t('main.rs 里注册了', /fpx::fpx_backup_targets/.test(mainrs));
}

console.log('\n=== 4. 前端接线 ===');
{
  t('api 有 backupTargets', /backupTargets: \(\) => call<BackupTargets>\('fpx_backup_targets'\)/.test(api));
  t('types 有 BackupTargets', /interface BackupTargets/.test(types));
  t('api.ts 导入了该类型', /BackupAutoStatus, BackupResult, BackupTargets/.test(api));
  t('设置里读取', /api\.backupTargets\(\)\.then\(setTargets\)/.test(dlg));
  /* 外壳命令可能不存在，必须静默失败 */
  t('取不到静默失败', /\.catch\(\(\) => setTargets\(null\)\)/.test(dlg));
}

console.log('\n=== 5. 显示要可信 ===');
{
  t('显示项目落点', /\{targets\?\.project \?\? '（未取到）'\}/.test(dlg));
  t('显示项目组落点', /\{targets\?\.group \?\? '（未取到）'\}/.test(dlg));
  t('显示数据目录', /数据目录：\{targets\?\.dataDir/.test(dlg));
  /* 取不到要明说，留空会被当成加载失败 */
  t('取不到时写「未取到」', /（未取到）/.test(dlg));
  /* 长路径靠 title 悬停 */
  t('title 带完整路径', /title=\{targets\?\.project\}/.test(dlg));
}

console.log('\n=== 6. 只读（做成输入框会让人以为能改）===');
{
  t('用 span 不是 input', /<span className="fpx-target-path"/.test(dlg));
  t('没有给这些路径配输入框', !/fpx-target-path"[^>]*\n?[^>]*value=/.test(dlg));
  t('样式：不换行 + 省略号', /\.fpx-target-path[\s\S]*?overflow: hidden; text-overflow: ellipsis; white-space: nowrap/.test(css));
  /* 可选中复制 —— 用户要的就是那个字符串 */
  t('可选中复制', /\.fpx-target-path[\s\S]*?user-select: text/.test(css));
  t('等宽字体（路径对齐好看）', /\.fpx-target-path[\s\S]*?monospace/.test(css));
}

done();
