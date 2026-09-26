/**
 * 新建文件夹对齐原版 FolderCreateService（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/new-folder-align-test.mjs
 *
 * 原版 FolderCreateService 是"GUI 与 MCP 共用同一套校验/解析/落库"的
 * 单一实现源（注释里标 E009）。这里守两处在比对中发现的真实差异。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const R = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const sys = R('../../src-tauri/src/fpx/sys.rs');
const mod = R('../../src-tauri/src/fpx/mod.rs');

console.log('\n=== 1. 创建必须走摘锁窗口（原版 WithUnlockForPath）★★ ===');
{
  /*
   * 原版：
   *   FolderLockService.WithUnlockForPath(full, () => Directory.CreateDirectory(full));
   *
   * 不走窗口的后果：用户给某个目录上了「防写入」后，在这个目录下新建项目
   * 一律失败（deny 会继承到子层级）。而报错只有一句"创建文件夹失败"、
   * **不含原因** —— 用户不知道是自己刚上的锁挡住了自己，只会以为功能坏了。
   *
   * 这正是锁的设计意图：它挡的是第三方（AI 会话进程），
   * 不是本工具代表用户执行的写入。
   */
  const i = mod.indexOf('pub(crate) fn core_create_folder(');
  const b = mod.slice(i, mod.indexOf('\npub(crate) fn ', i + 1) > 0
    ? mod.indexOf('\npub(crate) fn ', i + 1)
    : mod.indexOf('\npub fn ', i + 1));

  t('走 with_unlock', /with_unlock\(dir,/.test(b));
  /* 窗口必须包住"真正的创建"，而不是包住算路径 */
  t('窗口内是 create_folder_at',
    /with_unlock\(dir, &target_key, \|\| sys::create_folder_at\(&target, template\)\)/.test(b));
  /* 窗口的 key 是目标路径本身（摘所有覆盖它的祖先锁） */
  t('窗口 key 是目标路径', /let target_key = target\.to_string_lossy\(\)\.to_string\(\);/.test(b));
  t('先算出目标路径', /let target = sys::resolve_new_target\(parent, name, h\)\?;/.test(b));
  t('旧的单函数入口已不再直接调', !/sys::create_folder\(parent, name, h, template\)/.test(b));
}

console.log('\n=== 2. 模板拷贝也在窗口内（不能只包 CreateDirectory）★ ===');
{
  /*
   * 原版整个 CopyDirectoryRecursive 都在 WithUnlockForPath 里。
   * 只把建目录包进去的话：受保护目录下建完空目录、接着拷模板内容会被 ACL 拒绝，
   * 用户看到的是"新建成功但里面是空的"，而没有任何报错。
   */
  const i = sys.indexOf('pub fn create_folder_at(');
  const b = sys.slice(i, sys.indexOf('\npub fn ', i + 1));
  t('create_folder_at 内含模板拷贝', /copy_tree\(tpl_path, target\)/.test(b));
  t('create_folder_at 内含建目录', /fs::create_dir_all\(target\)/.test(b));
  /* 注释要写清为什么不能拆开 */
  t('注释说明模板也必须在窗口内', /模板拷贝也必须在窗口内/.test(sys));
}

console.log('\n=== 3. 名称不能以句点结尾（原版 ValidateName）★ ===');
{
  /*
   * Windows 会**静默**去掉目录名末尾的句点：输入 `foo.` 实际建出 `foo`。
   * 于是配置里存 `foo.`、磁盘上是 `foo` —— 界面照配置显示带句点，
   * 之后所有按名字去查的操作（打开 / 改名 / 删除）都查不到。
   * 这是"显示与实际不一致"且没有任何报错的一类，必须在入口挡掉。
   */
  const i = sys.indexOf('pub fn validate_name(');
  const b = sys.slice(i, sys.indexOf('\npub fn ', i + 1));
  t('有句点结尾校验', /name\.ends_with\('\.'\)/.test(b));
  t('报错说明后果', /Windows 会静默去掉/.test(b));
  /* . / .. 的旧判定不能丢 */
  t('仍拦 . / ..', /name == "\." \|\| name == "\.\."/.test(b));
  t('仍拦非法字符', /'\\\\' \| '\/' \| ':'/.test(b));
  /* 限长仍在，但判据改成**字符数**了（字节数会把 40 个汉字判成超限，
     而报错写的是"上限 120 字符"）。这里守的是"仍限长"，不是"按字节限长"。 */
  t('仍限长（按字符）', /name\.chars\(\)\.count\(\) > 120/.test(b));
  t('不再按字节限长（反面证据）', !/name\.len\(\) > 120/.test(b));
}

console.log('\n=== 4. 原有语义没被改坏 ===');
{
  t('parent 为空时退到 quick_roots', /let roots = quick_roots\(\);/.test(sys));
  t('目标已存在时报错', /目标已存在/.test(sys));
  t('父目录仍过黑名单', /guard::reject_forbidden_raw\(parent\)\?;/.test(mod));
  t('hierarchy 仍受开关控制',
    /let h = if cfg\.create_path_carries_hierarchy \{ hierarchy \} else \{ None \};/.test(mod));
  /* GUI 与 MCP 两条路都要过同一个核心（原版 E009 单一实现源） */
  t('MCP 也走 core_create_folder', /super::core_create_folder\(&dir, &parent,/.test(R('../../src-tauri/src/fpx/mcp.rs')));
  t('命令也走 core_create_folder', /core_create_folder\(&dir, &parent, &name,/.test(mod));
}

done();
