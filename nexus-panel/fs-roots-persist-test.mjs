/**
 * fs_op 授权持久化回归测试（开发用，可删）
 * ------------------------------------------------------------
 * B3：授权目录此前只活在内存里，重启就回到「只有应用数据目录」的默认状态。
 *
 * 纯 Rust 侧改动，沙盒装不上 cargo，无法编译验证。
 * 本测试只做源码级接线检查，**不能**替代 cargo build。
 *
 * 行为验证：起应用 → 设置里加一个目录 → 重启 → 确认目录还在。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src-tauri/src');
const rs = fs.readFileSync(path.join(SRC, 'af_flow.rs'), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/** 取 fs_op 授权段的源码（从状态定义到 disallow_root 结束） */
const i0 = rs.indexOf('/* ---------------- fs_op 授权的持久化');
const i1 = rs.indexOf('#[tauri::command]\npub fn fs_op');
const seg = rs.slice(i0, i1);

console.log('\n=== 1. 状态结构 ===');
/* loaded 和 roots 必须在**同一个 struct** 里：
   否则两个线程可以同时判定「还没加载」，各自读一遍再各写一次。 */
t('FsRootsState 同时含 loaded 与 roots',
  /struct FsRootsState \{[\s\S]{0,80}loaded: bool,[\s\S]{0,80}roots: Vec<PathBuf>,/.test(rs));
t('static 是 Mutex<FsRootsState>（一把锁保护两个字段）',
  /static FS_ROOTS: OnceLock<Mutex<FsRootsState>>/.test(rs));
t('初始值 loaded=false', /FsRootsState \{ loaded: false, roots: Vec::new\(\) \}/.test(rs));

console.log('\n=== 2. 持久化载体 ===');
/* 独立文件，不塞进 project-group 的 config.json：
   授权是安全边界，不该和插件业务配置共用一个文件。 */
t('用独立的 fs-roots.json', /const FS_ROOTS_FILE: &str = "fs-roots\.json";/.test(rs));
t('持久化 DTO 有 serde 派生', /#\[derive\(Debug, Default, Serialize, Deserialize\)\]\s*struct FsRootsFile/.test(rs));
t('roots 字段有 #[serde(default)]（旧文件/空文件不报错）',
  /#\[serde\(default\)\]\s*roots: Vec<String>,/.test(rs));
t('复用了 store 的公开读写口（不另造一套，避免写出非原子版本）',
  /store::read_json_any/.test(rs) && /store::write_json_any/.test(rs));

console.log('\n=== 3. 加载时必须重新校验（关键：文件内容不可信）===');
/* 文件是用户可编辑的。若加载时不过 is_forbidden_root，
   手工往 JSON 里写 "/" 就能绕过 UI 的限制。 */
t('加载时重新 canonicalize', /let Ok\(canon\) = p\.canonicalize\(\) else \{ continue \};/.test(rs));
t('加载时重新过 is_forbidden_root', /if is_forbidden_root\(&canon\) \{ continue; \}/.test(rs));
const iCanon = rs.indexOf('let Ok(canon) = p.canonicalize() else { continue };');
const iForbid = rs.indexOf('if is_forbidden_root(&canon) { continue; }');
t('顺序：先 canonicalize 再判 forbidden', iCanon > 0 && iForbid > iCanon,
  `canon=${iCanon} forbid=${iForbid}`);
t('读失败当作空列表（首次启动本就没文件，不该报错）',
  /Err\(_\) => return Vec::new\(\)/.test(rs));

console.log('\n=== 4. 保存时排除默认目录 ===');
/* 应用数据目录是动态算的兜底范围，存进去会留下指向旧位置的僵尸条目。 */
t('保存时过滤掉默认数据目录', /Some\(\*r\) != default\.as_ref\(\)/.test(rs));
t('默认目录由 resolve_data_dir 现算（不读缓存状态）',
  /let default = dir\.canonicalize\(\)\.ok\(\);/.test(rs));

console.log('\n=== 5. 锁与 IO 顺序 ===');
/* 别把 MutexGuard 带进文件 IO：写盘可能慢，持锁等 IO 会堵住所有 fs_op。 */
t('persist 里先取快照再 drop(g) 才写盘',
  /let g = fs_roots_lock\(\)[\s\S]*?drop\(g\);[\s\S]*?write_json_any/.test(seg));
t('allow_root 里也先 drop(g) 再写盘',
  /drop\(g\);\s*\/\/ 先放锁再写盘[\s\S]{0,200}persist_fs_roots/.test(rs));
t('写失败只记日志不抛错（内存里已生效，不该让本次操作报错）',
  /eprintln!\("\[fs_op\] 授权列表写入失败/.test(rs));

console.log('\n=== 6. 三个命令都接了持久化 ===');
t('allow_root 落盘', /pub fn af_fs_allow_root[\s\S]*?persist_fs_roots\(&app\);/.test(rs));
t('disallow_root 落盘', /pub fn af_fs_disallow_root[\s\S]*?persist_fs_roots\(&app\);/.test(rs));
/* list_roots 走 snapshot，snapshot 懒加载会读盘 —— 所以不用显式 persist */
t('list_roots 走 snapshot（懒加载即读盘）',
  /pub fn af_fs_list_roots[\s\S]{0,200}fs_roots_snapshot\(&app\)/.test(rs));

console.log('\n=== 7. 懒加载只跑一次 ===');
t('snapshot 里用 !g.loaded 而非 g.roots.is_empty() 判断',
  /if !g\.loaded \{/.test(rs));
/* 用 is_empty() 判断的话：用户授权列表被清空后会再次读盘把旧的读回来 */
t('置位在加载之前（加载失败也不重试，避免每次调用都打磁盘）',
  /g\.loaded = true;[\s\S]{0,200}load_fs_roots/.test(rs));
t('allow_root 后标记 loaded（显式授权不该被随后的懒加载覆盖）',
  /\.loaded = true;[\s\S]{0,120}persist_fs_roots\(&app\);/.test(rs));

console.log('\n=== 8. 旧用法已清理 ===');
for (const [m, label] of [['g.is_empty()', 'g.is_empty()'], ['g.push(', 'g.push()'],
  ['g.iter()', 'g.iter()'], ['g.retain(', 'g.retain()'], ['g.contains(', 'g.contains()']]) {
  t(`无残留 ${label}`, !rs.includes(m));
}
t('三处 snapshot/allow/disallow 都用 g.roots',
  (rs.match(/g\.roots\.(push|contains|retain)/g) || []).length >= 6,
  `${(rs.match(/g\.roots\.(push|contains|retain)/g) || []).length} 处`);

console.log('\n=== 9. 结构 ===');
const lines = rs.split('\n');
let depth = 0, inBlock = false, minD = 0;
for (const ln of lines) {
  let j = 0;
  while (j < ln.length) {
    const c = ln[j];
    if (inBlock) {
      if (ln.substr(j, 2) === '*/') { inBlock = false; j += 2; continue; }
      j++; continue;
    }
    if (ln.substr(j, 2) === '//') break;
    if (ln.substr(j, 2) === '/*') { inBlock = true; j += 2; continue; }
    if (c === '"') {
      j++;
      while (j < ln.length) {
        if (ln[j] === '\\') { j += 2; continue; }
        if (ln[j] === '"') { j++; break; }
        j++;
      }
      continue;
    }
    if (c === "'") {
      const nxt = ln[j + 1] || '';
      if (nxt === '\\') { j += 4; continue; }
      if (ln[j + 2] === "'") { j += 3; continue; }
      j++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth < minD) minD = depth;
    j++;
  }
}
t('af_flow.rs 花括号平衡', depth === 0 && minD === 0, `depth=${depth}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：只检查接线，**不能**替代 cargo build + 重启实测。');
process.exit(fail ? 1 : 0);
