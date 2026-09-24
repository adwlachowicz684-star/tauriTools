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
/* 跨卷回退的实现在这里：复制失败必须提前返回、不能接着删源 */
const fsu = fs.readFileSync(path.join(RS, 'fsutil.rs'), 'utf8');

/** 预演分支的源码 */
const dry = cli.slice(cli.indexOf('if dry_run {'), cli.indexOf('let backup_note'));
/** 备份函数 */
/*
 * 两端都用**代码**锚点（函数签名）—— 原先起点用的是文档注释
 * `/// 迁移前把…`，那条注释一改写，切片起点就漂了。
 *
 * 那段"为什么不覆盖"的说明写在函数**前面**，不在函数体里，
 * 所以单独切一份 `bakDoc` 只用来验注释；验代码的断言一律用 `bak`。
 * 早先是"为了让注释断言过"就把起点挪到注释上，结果整段代码断言
 * 都挂在一个注释字面量上 —— 注释一改全片失效。
 */
const bak = cli.slice(cli.indexOf('fn backup_before_migrate'),
                      cli.indexOf('fn remap'));
const bakDoc = cli.slice(cli.lastIndexOf('/**', cli.indexOf('fn backup_before_migrate')),
                         cli.indexOf('fn backup_before_migrate'));
/** 命令分派 */
/* 结尾锚点用代码（函数签名），不用文档注释 —— 注释改写会让切片失效 */
const dispatch = cli.slice(cli.indexOf('pub fn try_handle'), cli.indexOf('fn backup_before_migrate('));

console.log('\n=== 1. dry-run 开关 ===');
{
  t('migrate 签名带 dry_run', /fn migrate\(\s*cfg_path: &str,\s*rec_path: &str,\s*kind: &str,\s*dry_run: bool,/.test(cli));
  t('命令行认 --dry-run', /args\.iter\(\)\.any\(\|a\| a == "--dry-run"\)/.test(cli));
  t('两条迁移命令都认', (cli.match(/a == "--dry-run"/g) || []).length === 2);
  t('注释：文档头写了用法', /--dry-run：只打印计划/.test(cli));
  t('注释：文档头提醒迁移不可逆', /物理搬目录并覆写 config/.test(cli));
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
  /*
   * 位置：必须在计划算完、动手之前。
   * 两端都要判存在 —— 否则把 `let mut plan` 改名后右端变 -1，
   * `正数 > -1` 恒真，这条就空跑了（实测过：改名后 67 项照常全绿）。
   */
  const iDry = cli.indexOf('if dry_run {');
  const iPlan = cli.indexOf('let mut plan');
  const iRename = cli.indexOf('rename_with_fallback');
  t('位置在 plan 之后', iDry >= 0 && iPlan >= 0 && iDry > iPlan);
  t('位置在真正搬迁之前', iDry >= 0 && iRename >= 0 && iDry < iRename);
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
  const bakFlat = bakDoc
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
  /*
   * 这批原本只验「注释里写了这句话」，名字却承诺在验**行为** ——
   * 代码真退化、注释还在的话，断言照样通过：
   * 你以为有覆盖，其实没有（这次全量剥离注释的扫描才暴露出来）。
   *
   * 拆成两条：一条诚实地叫「注释：…」（钉住说明还在，防止后人删掉），
   * 一条验**真实代码**。
   */
  t('注释：为什么排除目标根', /防止把根搬进自己/.test(cli));
  t('排除目标根（防把根搬进自己）',
    /excludes\.push\(reloc_key\(&root\.to_string_lossy\(\)\)\)/.test(cli));
  t('注释：为什么不跟随链接', /不跟随链接：搬迁一个 junction/.test(cli));
  t('不跟随链接（搬 junction 会搬走背后目录）',
    /!super::fsutil::is_real_dir\(Path::new\(p\)\)/.test(cli));
  t('目标已存在则跳过（不覆盖用户文件）',
    /跳过：目标已存在同名目录/.test(cli));
  t('注释：为什么跨卷要退到复制+删除', /跨卷时 rename 会失败/.test(cli));
  t('跨卷回退到"复制+删除"', /rename_with_fallback/.test(cli));
  t('注释：复制没成功就不删源', /复制没成功就不删源/.test(cli));
  /* 真实代码在 fsutil.rs：复制失败要带着"源目录保持原样"提前返回，
     绝不能继续往下删源 —— 所以断言的是那个 `?` 之前的错误信息。 */
  t('复制没成功就不删源（真实代码）', /源目录保持原样/.test(fsu));
  t('图标/标签色/锁 跟着换键', /cfg\.folder_icons = remap/.test(cli));
  t('注释：为什么项目组搬走要重建链接', /指向它的链接全断了/.test(cli));
  t('项目组搬走后重建链接',
    /super::junction::create\(&r\.project, &r\.group, &names\)/.test(cli));
  t('写回失败也如实报出', /搬迁完成但写回 config 失败/.test(cli));
}

console.log('\n=== 8. 未设置父目录时拒绝 ===');
{
  t('没有预设父目录则中止（不知道往哪搬）',
    /未设置「新建\{\}父目录」，无法确定迁移目标根/.test(cli));
}

console.log('\n=== 7. #314 页签名收敛为合法单级片段 ★★ ===');
{
  const i = cli.indexOf('pub fn safe_segment');
  t('safe_segment 存在', i > 0);
  /* 从文档注释开始取（注释在 fn 之前，讲"为什么用 Windows 字符集"） */
  const c0 = cli.lastIndexOf('/**', i);
  const fn = cli.slice(c0 > 0 ? c0 : i, i + 900);

  /* 一、必须挡住能拼出**多层级**或越出目标根的字符。
     页签名直接拿去 root.join(seg)，含 \ 或 / 会拼出多级路径 ——
     项目被搬到用户没指定的地方，而报告里只写"已搬迁"。 */
  t('挡住反斜杠', /'\\\\'/.test(fn));
  t('挡住斜杠', /\| '\/' /.test(fn));
  t('挡住冒号', /\| ':' /.test(fn));
  t('挡住通配符', /\| '\*' /.test(fn));
  t('挡住引号与尖括号', /'"' \| '<' \| '>' \| '\|'/.test(fn));
  t('挡住控制符', /is_control\(\)/.test(fn));
  t('挡住 . 与 ..', /s == "\." \|\| s == "\.\."/.test(fn));
  t('挡住空白', /trim\(\)\.is_empty\(\)/.test(fn));

  /* 二、必须用**Windows** 的非法字符集，而不是"当前平台"的。
     按当前平台判的话，同一份 config 换台机器跑结论就不同。 */
  t('注释说明为何用 Windows 集', /Windows 的/.test(fn) || /当前平台/.test(fn));

  /* 三、计划里被跳过的项目**必须进计划**（原版 continue 掉、连记录都没有） */
  const j = cli.indexOf('struct PlanItem');
  const blk = cli.slice(j, j + 2600);
  t('计划项带 skip 原因', /skip: String/.test(blk));
  t('排除目录也进计划并写明原因', /跳过：排除目录/.test(blk));
  t('链接/不存在也写明原因', /跳过：是链接，不是真实目录/.test(blk) && /跳过：文件夹不存在/.test(blk));
  t('页签名非法时该页签整体不搬', /页签名「\{\}」含非法字符，该页签整体不搬/.test(blk));

  /* 四、跳过项要**计入 skipped**（原版不计，总数对不上 → 用户以为丢了） */
  /* 第二个 `for it in &plan {` 才是执行段（第一个在 dry-run 里） */
  const k = cli.indexOf('for it in &plan {', cli.indexOf('for it in &plan {') + 10);
  const exec = cli.slice(k, k + 700);
  t('执行段把 skip 计入 skipped', exec.indexOf('skipped += 1') > 0 && exec.indexOf('it.skip.clone()') > 0);
  t('执行段 push 出记录（不静默）', /items\.push\(MigItem/.test(exec));

  /* 五、dry-run 同样要显示跳过原因 ——
     预演的意义就是"动手前看清楚"，看不到的跳过等于没预演 */
  const d = cli.indexOf('let mut pre: Vec<MigItem>');
  const dry = cli.slice(d, d + 700);
  t('预演段也输出 skip 原因', dry.indexOf('it.skip.clone()') > 0);

  /* 六、根目录拼接用的是收敛后的 seg，不是原始页签名 */
  t('用收敛后的 seg 拼路径', /root\.join\(&it\.seg\)/.test(cli));

  /* 七、链接重建失败**必须说出来**（此前是 `Err(_) => {}`，完全吞掉）
     —— 报告只写「重建链接 N 条」，失败的那几条既不计进 N 也没有一行提到，
     用户拿到一份干干净净的"完成"报告，而那些链接实际仍指向搬走前的旧位置。 */
  {
    /* 注意：两个锚点都要从 relinked 之后再找 —— `write_json_any`
       在文件前面还有别处，直接 indexOf 会取到前面那个，切片变空 */
    const from = cli.indexOf('let mut relinked = 0');
    const blk = cli.slice(from, cli.indexOf('if let Err(e) = store::write_json_any', from));
    t('取到重建段', blk.length > 0);
    t('重建失败被收集起来', /relink_errors\.push\(/.test(blk));
    /* 必须在**剥掉注释后**再判：说明文字里就写着 `Err(_) => {}` 这几个字，
       不剥的话断言会命中注释 → 永远为真（第 18 次踩到这类空跑） */
    const blkCode = blk.replace(/\/\*[\s\S]*?\*\//g, '');
    t('不再有空的 Err 分支', !/Err\(_\)\s*=>\s*\{\s*\}/.test(blkCode));
    t('错误信息带项目路径与链接名', /\{\}\（\{\}）：\{e\}/.test(blkCode));

    /*
     * 锚点必须是**代码**，不能是 `/// 入口：解析 argv` 这类文档注释：
     * 注释一改写就返回 -1，切片整段失效，而断言看起来还在跑
     * （断言卫生护栏第 2 节正是钉这个）。用 `render` 之后的下一个
     * 顶层函数 `try_handle` 做界。
     */
    const fromR = cli.indexOf('fn render(');
    const r = cli.slice(fromR, cli.indexOf('pub fn try_handle', fromR));
    t('render 收 relink_errors 参数', /relink_errors: &\[String\]/.test(r));
    t('报告里写明失败条数', /重建链接\*\*失败\*\* \{\} 条/.test(r));
    t('报告末尾逐条列出（否则用户不知道是哪几条）', /\[链接重建失败\]/.test(r));
    t('三个调用点都传了', (cli.match(/render\(moved, skipped, failed, relinked, &relink_errors, &items\)/g) ?? []).length === 3);
  }
}

done();
