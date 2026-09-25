//! 文件系统通用小工具（跨平台，纯 std）。
//! ------------------------------------------------------------------
//! 抽出这三件事，是因为它们此前在各处被重复实现、且每一处都实现得不完全：
//!
//!   1. **链接点判定**：统一用 `symlink_metadata`，绝不跟随链接。
//!      `path.is_dir()` 会跟随符号链接，于是"是不是目录"这个问题的答案
//!      取决于链接指向哪儿；本项目大量使用 junction / symlink（项目组链接），
//!      跟随判定既会重复拷贝，也可能顺着自指软链无限递归。
//!
//!   2. **递归遍历**：跳过链接点，并用 dev+ino（Windows 退化为规范化路径的哈希）
//!      记录已访问节点。光"跳过链接"不够：两个互为硬链接的普通目录、
//!      或绑定挂载同样能构成环，必须记录已访问集合。
//!
//!   3. **rename**：跨设备（跨卷 / 跨挂载点）时回退到"复制 + 删除"，
//!      而不是直接把失败抛给用户。
//!
//! 注意：这里只提供原语，不做任何授权判断 —— 授权是调用方（fs_op 的根目录白名单、
//! 卡片路径归属）的事，别把两类约束混在一起。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/* ---------------------------- 链接点判定 ---------------------------- */

/// 是否为链接点（Unix symlink / Windows junction 与 symlink）。
///
/// `symlink_metadata` 不跟随链接，因此链接指向的目标不存在也能正确识别
/// —— 断链恰恰是最需要识别出来的场景。
pub fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 是否为"真实目录"（不跟随符号链接）。
pub fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
}

/// 是否为"真实文件"（不跟随符号链接）。
#[allow(dead_code)]
pub fn is_real_file(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}

/* ---------------------------- 递归遍历的环路保护 ---------------------------- */

/// Unix：设备号 + inode 唯一标识一个目录节点。
#[cfg(unix)]
fn node_id(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::symlink_metadata(p).ok()?;
    Some((m.dev(), m.ino()))
}

/// 非 Unix：拿不到稳定的 inode 号，退化为规范化路径的 FNV-1a 哈希。
/// 规范化会解析链接与 `..`，同一目录的不同写法会落到同一个 key。
#[cfg(not(unix))]
fn node_id(p: &Path) -> Option<(u64, u64)> {
    let c = p.canonicalize().ok()?;
    let s = c.to_string_lossy().to_lowercase();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    Some((0, h))
}

/// 递归遍历时的"已访问"记录。
///
/// 用法：进入每个目录前先 `visit`，返回 false 说明这个节点已经走过，应当跳过。
/// 每次新的遍历都要新建一个实例 —— 它是单次遍历的状态，不是全局缓存。
pub struct WalkGuard {
    seen: HashSet<(u64, u64)>,
}

impl WalkGuard {
    pub fn new() -> Self {
        Self { seen: HashSet::new() }
    }

    /// 记录并判断是否首次访问。拿不到节点号时放行（总比漏掉内容好）。
    pub fn visit(&mut self, p: &Path) -> bool {
        match node_id(p) {
            Some(id) => self.seen.insert(id),
            None => true,
        }
    }

    /// 底层集合大小（诊断 / 测试用）。
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    /// 在外部持有的集合上标记并判断是否首次访问。
    ///
    /// 给那些把"已访问集合"作为参数在递归里传递的调用方用（如 backup 的
    /// collect_source）—— 它们没法把整个遍历装进一个 WalkGuard 实例。
    pub fn mark(seen: &mut HashSet<(u64, u64)>, p: &Path) -> bool {
        match node_id(p) {
            Some(id) => seen.insert(id),
            None => true,
        }
    }
}

impl Default for WalkGuard {
    fn default() -> Self {
        Self::new()
    }
}

/* ---------------------------- 递归拷贝 ---------------------------- */

/// 递归拷贝目录树：跳过链接点、带环路保护。
///
/// 链接点一律不复制也不深入 —— 与备份策略一致：本项目用链接把项目组挂到项目下，
/// 复制链接内容既会重复占用空间，也可能绕回自身。
pub fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let mut guard = WalkGuard::new();
    copy_tree_inner(src, dst, &mut guard)
}

fn copy_tree_inner(src: &Path, dst: &Path, guard: &mut WalkGuard) -> Result<(), String> {
    if !guard.visit(src) {
        return Ok(()); // 环：这个节点已经在本次遍历里处理过
    }
    if is_real_dir(src) {
        fs::create_dir_all(dst)
            .map_err(|e| format!("创建目录失败 {}: {e}", dst.display()))?;
        let rd = fs::read_dir(src).map_err(|e| format!("读取目录失败 {}: {e}", src.display()))?;
        for entry in rd.flatten() {
            let s = entry.path();
            if is_link(&s) {
                continue;
            }
            copy_tree_inner(&s, &dst.join(entry.file_name()), guard)?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建父目录失败 {}: {e}", parent.display()))?;
            }
        }
        fs::copy(src, dst)
            .map_err(|e| format!("复制失败 {} → {}: {e}", src.display(), dst.display()))?;
        Ok(())
    }
}

/// 递归删除目录树（链接点不深入，只删链接自身；带环路保护）。
#[allow(dead_code)]
pub fn remove_tree(path: &Path) -> Result<(), String> {
    if is_link(path) || !is_real_dir(path) {
        return fs::remove_file(path).map_err(|e| format!("删除失败 {}: {e}", path.display()));
    }
    let mut guard = WalkGuard::new();
    remove_tree_inner(path, &mut guard)
}

#[allow(dead_code)]
fn remove_tree_inner(path: &Path, guard: &mut WalkGuard) -> Result<(), String> {
    if !guard.visit(path) {
        return Ok(());
    }
    if is_link(path) || !is_real_dir(path) {
        return fs::remove_file(path).map_err(|e| format!("删除失败 {}: {e}", path.display()));
    }
    let rd = fs::read_dir(path).map_err(|e| format!("读取目录失败 {}: {e}", path.display()))?;
    for entry in rd.flatten() {
        let p = entry.path();
        if is_real_dir(&p) && !is_link(&p) {
            remove_tree_inner(&p, guard)?;
        } else {
            let _ = fs::remove_file(&p);
        }
    }
    fs::remove_dir(path).map_err(|e| format!("删除目录失败 {}: {e}", path.display()))
}

/* ---------------------------- rename 与跨设备回退 ---------------------------- */

/// EXDEV（Unix 跨挂载点）
#[cfg(not(windows))]
const CROSS_DEVICE_OS_ERROR: i32 = 18;
/// ERROR_NOT_SAME_DEVICE（Windows 跨卷）
#[cfg(windows)]
const CROSS_DEVICE_OS_ERROR: i32 = 17;

/// 失败原因是否为"跨设备"。
///
/// 不用 `ErrorKind::CrossesDevices`：它在 Rust 1.83 才稳定，
/// 而本项目 `rust-version = 1.77.2`，用了就是硬编译错误。
/// errno 数字在两类平台上都是几十年不变的稳定值，直接比对即可。
fn is_cross_device(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(CROSS_DEVICE_OS_ERROR)
}

/// 移动（重命名）文件或目录；跨设备时自动回退到"复制 + 删除"。
///
/// **失败语义很重要**：复制没成功之前绝不删源 —— 宁可原地不动，也不冒搬丢的风险。
/// 复制成功但删源失败时返回 Err，此时两份数据都在，交由用户手动清理
/// （错误信息里写明具体路径，不说"请自行处理"这种废话）。
pub fn rename_with_fallback(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            if let Some(parent) = dst.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)
                        .map_err(|pe| format!("创建目标父目录失败 {}: {pe}", parent.display()))?;
                }
            }
            if is_real_dir(src) {
                copy_tree(src, dst).map_err(|ce| {
                    format!("跨设备复制未完成，源目录保持原样（{}）: {ce}", src.display())
                })?;
                fs::remove_dir_all(src).map_err(|de| {
                    format!(
                        "已复制到 {}，但删除源目录失败，请手动删除 {}: {de}",
                        dst.display(),
                        src.display()
                    )
                })?;
            } else {
                fs::copy(src, dst).map_err(|ce| {
                    format!("跨设备复制未完成，源文件保持原样（{}）: {ce}", src.display())
                })?;
                fs::remove_file(src).map_err(|de| {
                    format!(
                        "已复制到 {}，但删除源文件失败，请手动删除 {}: {de}",
                        dst.display(),
                        src.display()
                    )
                })?;
            }
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 用文件覆盖目标（临时文件落盘的最后一跳）。
///
/// 与 `rename_with_fallback` 的区别：这里的目标是"覆盖"，源是临时文件，
/// 删不掉也无所谓（留在目录里只是垃圾，不影响正确性），所以删源失败不报错。
/// 用移动语义的函数反而会在"其实已经成功"的情况下误报失败。
pub fn replace_file(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            if let Some(parent) = dst.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)
                        .map_err(|pe| format!("创建父目录失败 {}: {pe}", parent.display()))?;
                }
            }
            fs::copy(src, dst).map_err(|ce| {
                format!("复制 {} → {} 失败: {ce}", src.display(), dst.display())
            })?;
            let _ = fs::remove_file(src);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 是否为"根"（文件系统根或盘符根）。授权/删除类判断里通常要排除。
#[allow(dead_code)]
pub fn is_root(p: &Path) -> bool {
    p.parent().is_none()
}

/// 便于调用方打印：把路径统一成正斜杠形式。
#[allow(dead_code)]
pub fn display_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// 拼接两个路径段（保留 PathBuf 语义，避免手写 format! 拼出重复分隔符）。
#[allow(dead_code)]
pub fn join(base: &Path, name: &str) -> PathBuf {
    base.join(name)
}

/* ---------------------------- 跨进程文件锁 ---------------------------- */
// 放在 fsutil 是因为它是"跨平台、纯 std"的原语，与链接判定、rename 回退同类。

/// 锁文件多久没更新就视为废弃（秒）。
///
/// 定 60 秒的依据：本锁只保护「读配置 → 改 → 写回」这类事务，
/// 按设计都是毫秒级（见 store::with_config 的注释：不要在闭包里做秒级操作）。
/// 60 秒的余量足以覆盖磁盘卡顿、杀毒软件扫描等偶发延迟，
/// 又不至于让一个崩溃进程留下的锁长期堵住所有人。
const LOCK_STALE_SECS: u64 = 60;

/// 抢不到锁时的重试间隔（毫秒）。
const LOCK_RETRY_MS: u64 = 20;

/// 最多等多久（毫秒）。超时直接报错，**不强抢**。
///
/// 为什么不强抢：能在 10 秒内一直占着锁，说明对方真的在做事（或卡住了）。
/// 这时候抢过来写，等于主动制造一次覆盖冲突——而这类冲突的代价是
/// 用户登记整份丢失且不可逆。让用户看到错误、稍后重试，比静默抢锁安全得多。
const LOCK_WAIT_MS: u64 = 10_000;

/// 锁文件的 mtime 是否已旧到可以判定为废弃。
fn lock_is_stale(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        // 读不到元信息（刚好被别人删了）——当作可用，让调用方去抢
        return true;
    };
    let Ok(modified) = meta.modified() else {
        return true;
    };
    let Ok(age) = modified.duration_since(std::time::SystemTime::UNIX_EPOCH) else {
        return true;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.saturating_sub(age.as_secs()) > LOCK_STALE_SECS
}

/// 本次持锁的唯一标识。
///
/// 为什么需要：guard 释放时要能认出"这把锁还是不是我的"。
/// 只用 pid 不够——pid 会复用，本进程退出后新进程可能拿到同一个 pid；
/// 所以再拼上纳秒时间戳与进程内单调序号。
fn owner_token() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let ns = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}-{}", std::process::id(), ns, n)
}

/// 尝试原子地创建锁文件；成功即视为拿到锁。
///
/// 用 `create_new(true)`（底层 `O_EXCL|O_CREAT`）而不是"先 exists 再 create"：
/// 后者存在 TOCTOU 窗口——两个进程都看到"没有"，然后都去创建，都以为自己拿到了。
///
/// 拿到后立刻把 owner token 写进文件：guard 释放时靠它认领，
/// 否则分不清"自己的锁"与"别人刚建的锁"（见 `FileLockGuard::drop`）。
fn try_lock(path: &Path, token: &str) -> std::io::Result<Option<fs::File>> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut f) => {
            use std::io::Write;
            /*
             * 写 token 失败**不能**用 `let _ =` 吞掉，也不能就此返回"拿到锁"。
             *
             * token 是释放时认领这把锁的唯一凭据（见 `FileLockGuard::drop`）。
             * 写不进去的话锁文件是**空的**，于是：
             *   1. 本次调用照样返回 Ok(Some) —— 调用方以为拿到锁，照常写数据；
             *   2. drop 时 read_owner_token 读到 None → 判定"不是我的锁"
             *      → **不删**；
             *   3. 锁文件留在那儿，mtime 是刚写的 → 后续每个实例都判为
             *      "未过期" → 一路等到 LOCK_WAIT_MS 超时，报
             *      「另一个实例可能正在写入」。
             *
             * 于是从这一刻起，之后每一次保存都会挂满等待上限再失败，
             * 而报错指向"是不是还有个实例没关"——完全指向错了地方。
             * 真相只是这一次 writeln! 失败（磁盘满 / 权限），而它被吞了。
             *
             * 拿一把"永远不会被释放"的锁，比直接告诉调用方拿不到更糟：
             * 后者至少报错准确。所以写失败要**删掉刚建的文件**并返回 Err。
             */
            if let Err(e) = writeln!(f, "token={token}") {
                let _ = fs::remove_file(path);
                return Err(e);
            }
            /*
             * pid / 时间只是给人看的诊断信息，写失败不影响互斥
             * （判定一律看 mtime），所以这里可以吞。
             */
            let _ = writeln!(
                f,
                "pid={} at={:?}",
                std::process::id(),
                std::time::SystemTime::now()
            );
            /*
             * flush 同样不能吞：token 必须真的落到盘上。
             * 只在页缓存里、而进程随后崩溃的话，drop 读回来的就是空文件，
             * 后果与上面写失败完全一样（锁永不释放）。
             */
            if let Err(e) = f.flush() {
                let _ = fs::remove_file(path);
                return Err(e);
            }
            Ok(Some(f))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
        Err(e) => Err(e),
    }
}

/**
 * 跨进程互斥锁。
 *
 * 为什么需要它：本程序有**两个独立进程**会写同一份数据——
 *   · GUI 主进程（前端命令、自动备份定时器）
 *   · `exe --mcp` 拉起的 MCP 实例（AI 客户端启动，关窗口只跑服务）
 * 进程内的 `Mutex` 只协调第一个进程内部的线程，完全挡不住第二个进程。
 * 两者同时 load→改→save，后写的会把先写的整份覆盖，且没有任何提示。
 *
 * 为什么不用 OS 命名互斥量（Windows `CreateMutexW` / Unix semaphore）：
 * 那是两套语义不同的 API，都超出 std，还得处理 Windows 会话隔离、
 * Unix 下 System V 与 POSIX 两套实现之类的历史包袱。
 * 本项目坚持纯 std 跨平台，引入它们会把 fsutil 变成平台分支的集合体。
 *
 * 锁文件内容（PID + 时间戳）仅供**诊断**：谁持锁、持了多久。
 * 判定是否过期一律看文件系统 mtime——内容可能写到一半、也可能被别的
 * 程序改过，解析内容做判断不如直接信 mtime 可靠。
 */
pub struct FileLock {
    path: PathBuf,
}

impl FileLock {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// 拿到锁，返回 RAII guard（drop 时自动释放）。
    pub fn lock(&self) -> Result<FileLockGuard, String> {
        let started = std::time::Instant::now();
        // 每次尝试都换新 token：被回收后重抢的那次也带着自己的身份，
        // 不会与别人（或自己上一次）的锁混淆。
        let token = owner_token();
        loop {
            match try_lock(&self.path, &token) {
                Ok(Some(_f)) => {
                    return Ok(FileLockGuard {
                        path: self.path.clone(),
                        token: token.clone(),
                    });
                }
                Ok(None) => {
                    // 锁存在：判断是否废弃，废弃就删掉重来
                    if lock_is_stale(&self.path) {
                        fs::remove_file(&self.path).ok();
                        continue;
                    }
                }
                Err(e) => {
                    let p = self.path.display().to_string();
                    return Err(format!("无法创建锁文件 {p}: {e}"));
                }
            }

            if started.elapsed().as_millis() as u64 > LOCK_WAIT_MS {
                let p = self.path.display().to_string();
                return Err(format!(
                    "等待数据锁超时（{LOCK_WAIT_MS}ms）。\n\
                     另一个实例（{p} 的持有者）可能正在写入或已卡住。\n\
                     请稍后重试；若确认没有其他实例在运行，可删除该锁文件。"
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(LOCK_RETRY_MS));
        }
    }
}

/// 锁的 RAII guard：离开作用域自动释放，panic 时也会释放。
///
/// 自己持有路径副本（不借用 `FileLock`），因此可以自由传递、存入结构体，
/// 也让调用方能做"重入计数"这类包装而不受生命周期限制。
///
/// `token` 是这次持锁的身份，用于释放时认领——见 `Drop` 里的说明。
pub struct FileLockGuard {
    path: PathBuf,
    token: String,
}

/// 读锁文件里的 owner token；读不到或格式不对返回 None。
///
/// 只认第一行 `token=...`。其余行（pid / 时间）是给人看的诊断信息，
/// 不做判定依据——它们可能写到一半，也可能被别的程序改过。
fn read_owner_token(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let first = text.lines().next()?;
    first.strip_prefix("token=").map(|s| s.trim().to_string())
}

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        /* 只删自己创建的那一份。
           ------------------------------------------------------------------
           早先这里只判"锁文件是否 stale"就删，那把两个完全不同的情况混在了一起：

             · 我的锁还在，但已经超过 60 秒（我这边卡了 / 被挂起 / 断点调试）
               → 别人判定为废弃，回收并重建了锁，现在的锁是**他的**
             · 我的锁好端端在那儿

           只判 stale 的话，第一种情况下我会把别人刚建的锁删掉 —— 于是出现了
           两个进程同时持锁，互斥失效，而这类失效的代价是整份登记被覆盖。

           所以真正要问的是"这把锁还是不是我的"：比对 token，不一致就不碰。
           文件已经没了（别人释放了 / 手动删了）同样不碰，删操作本身无害但没必要。

           顺带说明：token 是必需的，不能只靠 pid —— pid 会复用；
           也不能只靠时间戳 —— 同一进程内两次拿锁可能落在同一纳秒区间。 */
        match read_owner_token(&self.path) {
            Some(t) if t == self.token => {
                fs::remove_file(&self.path).ok();
            }
            _ => { /* 不是我的锁（或已被别人接管 / 已消失）：不删 */ }
        }
    }
}
