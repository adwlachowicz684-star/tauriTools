/**
 * 导出目录的设置与落盘路径计算。
 *
 * ================= 为什么要有这个模块 =================
 *
 * 以前导出用的是浏览器 <a download> ——
 * 文件落到系统默认下载目录，**插件自己也不知道在哪**，
 * 日志里只有文件名没有目录，用户找不到文件也不知道该去哪找。
 *
 * 更糟的是那段 try/catch 的 catch 是空的（注释说"退回剪贴板"但没实现），
 * 所以下载被拦时日志照样打印"✅ 已导出" —— **失败伪装成成功**。
 *
 * 现在导出改走 fs_op 写文件：路径由我们决定，结果能确认。
 */
import { defaultKV, type KV } from './kv';

const KEY = 'agent-flow.exportDir.v1';

export type ExportDirSetting = {
  /** 默认导出目录；空串表示没设 */
  dir: string;
};

export type ExportDirSource = 'setting' | 'picked' | 'download';

export function loadExportDir(kv: KV = defaultKV()): string {
  const raw = kv.get(KEY);
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

export function saveExportDir(dir: string, kv: KV = defaultKV()): void {
  kv.set(KEY, String(dir ?? '').trim());
}

/* ------------------------------------------------------------------ */
/* 文件名净化                                                          */
/* ------------------------------------------------------------------ */

/** Windows / macOS 都不接受的文件名字符 */
const BAD_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/**
 * 把画布名变成可用的文件名。
 *
 * 不做净化的话，画布名叫「A/B 测试」时写盘会直接失败，
 * 而失败信息是 Rust 侧的 IO 错误，用户看不懂是自己起的名字有问题。
 */
export function safeFilePart(name: string, fallback = 'canvas'): string {
  const s = String(name ?? '')
    .replace(BAD_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
  return s || fallback;
}

/* ------------------------------------------------------------------ */
/* 路径拼接                                                            */
/* ------------------------------------------------------------------ */

/**
 * 拼出完整导出路径。
 *
 * 统一用 `/` —— Rust 的 std::path 在 Windows 上同样接受正斜杠，
 * 而前端拼 `\` 要处理转义，容易写出错的串。
 */
export function joinPath(dir: string, file: string): string {
  const d = String(dir ?? '').trim().replace(/[\\/]+$/, '');
  const f = String(file ?? '').trim().replace(/^[\\/]+/, '');
  if (!d) return f;
  if (!f) return d;
  return `${d}/${f}`;
}

export function exportFileName(canvasName: string, ext: string): string {
  return `flow-${safeFilePart(canvasName)}.${String(ext ?? 'txt').replace(/^\./, '')}`;
}

/**
 * 决定这次导出写到哪、以及"这个结论是怎么来的"。
 *
 * 来源必须说清楚：告诉用户"用了你设的默认目录"和"临时选的"是两回事 ——
 * 前者下次还生效，后者不是。
 */
export function resolveExportTarget(
  settingDir: string,
  pickedDir: string | null,
  canvasName: string,
  ext: string,
): { path: string; source: ExportDirSource } {
  const file = exportFileName(canvasName, ext);
  const picked = String(pickedDir ?? '').trim();
  const setting = String(settingDir ?? '').trim();

  if (picked) return { path: joinPath(picked, file), source: 'picked' };
  if (setting) return { path: joinPath(setting, file), source: 'setting' };
  /* 没有目录可用时退回浏览器下载 —— 至少文件能出来，但路径不由我们定 */
  return { path: file, source: 'download' };
}

/**
 * 父目录 —— 写文件前要确保它存在。
 *
 * fs_op 的 write 不会自动建目录，目录不存在时是 IO 错误。
 */
export function parentOf(path: string): string {
  const s = String(path ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : s;
}

/** 路径看着像不像绝对路径（用于给用户即时提示，不是安全校验） */
export function looksAbsolute(path: string): boolean {
  const s = String(path ?? '');
  if (!s) return false;
  if (s.startsWith('/')) return true;
  return /^[A-Za-z]:[\\/]/.test(s);
}

/**
 * 判断路径是否落在已授权根目录范围内。
 *
 * ================= 为什么放这里 =================
 *
 * 它是纯逻辑（不碰 Tauri），放 engine 才能被单测覆盖。
 * 而这类"前缀比较"最容易在 Windows 上出错：
 * `\\?\` 前缀、大小写、尾部斜杠，少处理一个就会误判。
 *
 * 注意它**只用于"要不要先申请授权"的决策** ——
 * 真正的放行由 Rust 侧的 canonicalize + starts_with 说了算，
 * 前端判断不算数，不能拿它当安全边界。
 */
function norm(p: string): string {
  let s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  /* Windows canonicalize 后带 \\?\ 前缀，比较前要去掉 */
  s = s.replace(/^\/\/\?\//, '');
  return s.toLowerCase();
}

export function withinRoots(path: string, roots: string[]): boolean {
  const p = norm(path);
  if (!p) return false;
  return (roots ?? []).some((r) => {
    const rr = norm(r);
    if (!rr) return false;
    return p === rr || p.startsWith(rr + '/');
  });
}
