/**
 * 通用的「读/写一个文本文件」—— 与任何具体数据结构无关。
 *
 * ================= 为什么单独一层 =================
 *
 * 这几个函数只做"读一个文本文件 / 写一个文本文件"，
 * 不认识任何清单的数据结构 —— 谁都能直接用，不必知道它原本是给谁写的。
 *
 * ================= 只做三件事 =================
 *
 *   读 / 写 / 判断这份文本是不是能解析的 JSON
 *
 * 不涉及"内容长什么样"（那是各清单自己的 parse/serialize 的事）。
 */

import { fileOp, writeTextFile as fsWriteText, ensureDir, canExportToFile } from '../lib/tauri';

export type FsResult = { ok: boolean; text: string };

/** "不存在"的几种说法。Rust 侧与浏览器侧措辞不同，都要认 */
const NOT_FOUND = /不存在|not found|no such|ENOENT/i;

/**
 * 清单文件"坏没坏"的判据。
 *
 * 各清单文件并排放在同一个导出目录里，一旦口径分叉，
 * 同一个损坏的文件在两个面板里一个报"读不出来"、一个当"没有"，
 * 是最难自查的那类不一致。
 *
 * ⛔ 为什么不能靠各清单自己的 parse 判断：
 *    那些函数的契约是"解析不出来就退成空清单"（既有测试钉住了这个行为）。
 *    这个契约对**单条解析**是对的 —— 手改坏了也不至于让整个面板崩掉。
 *    但 commit 路径拿这个"空"当"磁盘上是空的"去三方合并，
 *    合并结果就只剩本地这一份，写回去**把损坏的文件整份盖掉**——
 *    而损坏的 JSON 往往手改几行就能救回来，一盖就永远没了。
 *    所以"能不能解析"必须是一个**独立于解析结果**的 observable 信号。
 *
 * 空文件**不算损坏**（第一次用它本来就是空的），返回 true。
 */
export function isParseableJson(raw: string): boolean {
  const s = String(raw ?? '');
  if (!s.trim()) return true;
  try {
    const v = JSON.parse(s);
    return !!v && typeof v === 'object';
  } catch {
    return false;
  }
}

/**
 * 读一个文本文件。
 *
 * 文件**不存在**不算失败 —— 第一次打开某个清单时它本来就没有。
 * 那种情况返回空串，让上层按空清单处理；报错只会让人以为功能坏了。
 */
export async function readTextFile(path: string): Promise<string> {
  let r: FsResult;
  try {
    r = await fileOp({
      op: 'read', path, target: '', content: '',
      recursive: false, force: false, dryRun: false,
      maxBytes: 20 * 1024 * 1024, exts: [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (NOT_FOUND.test(msg)) return '';
    throw e;
  }
  if (!r.ok) {
    if (NOT_FOUND.test(r.text)) return '';
    throw new Error(r.text || `读不到文件：${path}`);
  }
  return r.text;
}

/**
 * 写文件。父目录不存在就先建 —— fs_op 的 write 不会自动建父目录，
 * 不建的话报的是"路径不存在"，看不出是目录没建还是路径写错。
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  if (!canExportToFile()) throw new Error('写文件需要运行在桌面端（当前是浏览器模式）');
  const dir = path.replace(/\/[^/]*$/, '');
  if (dir && dir !== path) {
    const d = await ensureDir(dir);
    if (!d.ok && !/已存在|exists/i.test(d.text)) throw new Error(d.text || `建目录失败：${dir}`);
  }
  const r = await fsWriteText(path, content);
  if (!r.ok) throw new Error(r.text || `写文件失败：${path}`);
}
