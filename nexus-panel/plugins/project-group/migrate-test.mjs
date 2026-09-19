/**
 * 层级迁移的安全性回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/migrate-test.mjs，然后
 *         node plugins/project-group/migrate-test.mjs
 *
 * NEW-12：迁移命令会**物理搬目录**并**覆写 config.json**，
 * 不可逆、且此前没有任何测试。做错一次就是用户的目录结构没了。
 *
 * 本轮补的是两道闸：
 *   · `--dry-run` —— 只算计划、不碰磁盘（跑之前能先看一眼）
 *   · 动手前自动备份 config / link-record 的 .bak 副本
 *
 * 这里守几件容易做错的事：
 *   · 预演必须放在"计划算完、动手之前"，否则展示不出跳过原因
 *   · 预演**不能**有任何写操作
 *   · 备份**不能覆盖**已有备份（连跑两次时第二份才是有用的现场）
 *   · 撞名要换后缀而不是删旧的
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx');
const { t, done } = makeT();

const cli = fs.readFileSync(path.join(RS, 'cli.rs'), 'utf8');

/** 预演分支的源码 */
const dry = cli.slice(cli.indexOf('if dry_run {'), cli.indexOf('let backup_note'));
/** 备份函数 */
/* 从注释起切：那段"为什么不覆盖"的说明写在函数**前面**，
   只切函数体的话注释根本不在切片里 —— 断言会静默失败。 */
const bakStart = cli.lastIndexOf('/// 迁移前把', cli.indexOf('fn backup_before_migrate'));
const bak = cli.slice(bakStart > -1 ? bakStart : cli.indexOf('fn backup_before_migrate'),
                      cli.indexOf('fn remap'));
/** 命令分派 */
const dispatch = cli.slice(cli.indexOf('pub fn try_handle'), cli.indexOf('/// 未显式传路径时'));

console.log('\n=== 1. dry-run 开关 ===');
{
  t('migrate 签名带 dry_run', /fn migrate\(\s*cfg_path: &str,\s*rec_path: &str,\s*kind: &str,\s*dry_run: bool,/.test(cli));
  t('命令行认 --dry-run', /args\.iter\(\)\.any\(\|a\| a == "--dry-run"\)/.test(cli));
  t('两条迁移命令都认', (cli.match(/a == "--dry-run"/g) || []).length === 2);
  t('文档头写了用法', /--dry-run：只打印计划/.test(cli));
  t('文档头提醒迁移不可逆', /物理搬目录并覆写 config/.test(cli));
}

console.log('\n=== 2. 预演不能动任何东西（核心）===');
{
  /* 这些都是"会改磁盘"的调用，预演分支里一个都不该有 */
  for (const [name, re] of [
    ['rename', /rename_with_fallback/],
    ['copy', /fs::copy/],
    ['remove', /fs::remove/],
    ['create_dir', /create_dir_all/],
    ['write', /write_json_any/],
    ['save_records', /save_records_to/],
    ['junction_create', /junction::create/],
    ['junction_remove', /junction::remove/],
  ]) {
    t(`预演不调用 ${name}`, !re.test(dry));
  }
  t('预演只是 return 一个字符串', /return format!\(\s*"预演/.test(dry));
}

console.log('\n=== 3. 预演要展示跳过原因 ===');
{
  t('区分"将搬迁"', /"将搬迁"/.test(dry));
  t('报出"已在目标位置"', /跳过：已在目标位置/.test(dry));
  t('报出"目标已存在同名目录"', /跳过：目标已存在同名目录/.test(dry));
  t('报出"无法解析文件夹名"', /跳过：无法解析文件夹名/.test(dry));
  t('小计里给出将搬迁的数量', /其中将搬迁 \{\} 项/.test(dry));
  /* 位置：必须在计划算完、动手之前 */
  t('位置在 plan 之后', cli.indexOf('if dry_run {') > cli.indexOf('let mut plan'));
  t('位置在真正搬迁之前', cli.indexOf('if dry_run {') < cli.indexOf('rename_with_fallback'));
}

console.log('\n=== 4. 动手前自动备份 ===');
{
  t('backup_before_migrate 存在', /fn backup_before_migrate/.test(cli));
  t('在搬迁之前调用', cli.indexOf('backup_before_migrate(cfg_path') < cli.indexOf('rename_with_fallback'));
  t('config 与 record 都备份', /for src in \[cfg_path, rec_path\]/.test(bak));
  t('带时间戳', /mig-\{stamp\}/.test(bak));
  t('文件不存在就跳过（不因此失败）', /if !p\.exists\(\) \{ continue; \}/.test(bak));
}

console.log('\n=== 5. 备份不能覆盖已有备份（关键）===');
{
  t('撞名时换后缀', /format!\("-\{n\}"\)/.test(bak));
  t('遍历找空位（最多 100 次防死循环）', /for n in 0\.\.100/.test(bak));
  t('遇到已存在就跳过该名字', /if dst\.exists\(\) \{ continue; \}/.test(bak));
  /* 注释会跨行，直接匹配整句会被换行打断 —— 先归一空白再匹配 */
  const bakFlat = bak
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/+\s?/, ''))
    .join('')
    .replace(/\s+/g, '');
  t('注释说明"第二次盖掉第一次等于没备份"',
    bakFlat.includes('第二次要是把第一次的备份盖了，就等于没有备份'));
  /* 反面：绝不能先删再写 */
  t('不删除已有文件', !/remove_file/.test(bak) && !/fs::remove/.test(bak));
}

console.log('\n=== 6. 备份失败的处理 ===');
{
  t('失败只警告、不中止（备份不该堵住主流程）',
    /\[警告\] 备份失败（仍继续）/.test(cli));
  t('成功时告知备份位置（用户才知道去哪找）',
    /已备份原文件：\{\}/.test(cli));
  t('备份说明附在结果里', /format!\("\{\}\\n\{\}", backup_note/.test(cli));
}

console.log('\n=== 7. 原有的保护仍在（没被改坏）===');
{
  t('排除数据目录自身', /excludes\.push\(reloc_key/.test(cli));
  t('排除目标根（防把根搬进自己）', /防止把根搬进自己/.test(cli));
  t('不跟随链接（搬 junction 会搬走背后目录）',
    /不跟随链接：搬迁一个 junction/.test(cli));
  t('目标已存在则跳过（不覆盖用户文件）',
    /跳过：目标已存在同名目录/.test(cli));
  t('跨卷回退到"复制+删除"', /跨卷时 rename 会失败/.test(cli));
  t('复制没成功就不删源', /复制没成功就不删源/.test(cli));
  t('图标/标签色/锁 跟着换键', /cfg\.folder_icons = remap/.test(cli));
  t('项目组搬走后重建链接', /指向它的链接全断了/.test(cli));
  t('写回失败也如实报出', /搬迁完成但写回 config 失败/.test(cli));
}

console.log('\n=== 8. 未设置父目录时拒绝 ===');
{
  t('没有预设父目录则中止（不知道往哪搬）',
    /未设置「新建\{\}父目录」，无法确定迁移目标根/.test(cli));
}

done();
