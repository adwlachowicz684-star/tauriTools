/**
 * 任务板的落地 —— 读写磁盘上的那个 JSON 文件。
 *
 * ================= 为什么单独一层 =================
 *
 * engine/taskBoard.ts 是纯逻辑（可单测、不碰 IO）；
 * 这一层只管"文件在哪、怎么读、怎么写、写前怎么合并"。
 * 混在一起的话，每个操作都要先 mock 一个文件系统才能测。
 *
 * ================= 文件名 =================
 *
 *   <导出目录>/tasks-<项目>.json
 *
 * 按项目分文件，是为了 AI 只读自己那一份：
 * 全部塞进一个文件的话，AI 每次都要把别人的任务也读进来 ——
 * 那正是"不同项目的任务互相占用上下文与干扰"。
 *
 * 文件名保留项目名可读的部分，AI 在目录里一眼能认出是哪个项目。
 */

import { fileOp, writeTextFile, ensureDir, canExportToFile } from '../lib/tauri';
import { safeFilePart, joinPath } from './exportDir';
import {
  parseBoard, serializeBoard, mergeBoards, emptyBoard,
  type TaskBoard,
} from './taskBoard';
/*
  ⛔ 判据只有一份，在 textFile.ts —— 这里不再自己定义。
  曾经存在过两份（这份 + textFile 那份），于是：
    附件清单走 textFile 那份，任务清单与元数据走这份。
  两份内容当时一模一样，但从此会各改各的 ——
  哪天只改一边，就会出现"附件清单认坏了、任务清单照旧整份覆盖"
  这种界面上看不出差别的分叉。判据必须只有一个实现。
*/
import { isParseableJson } from './textFile';

/** 项目名里的非法字符换成下划线；空项目名退回 all */
export function boardFileName(projectKey: string, projectName: string): string {
  const label = safeFilePart(projectName || projectKey || 'all', 'all');
  return `tasks-${label}.json`;
}

export function boardPathOf(dir: string, projectKey: string, projectName: string): string {
  return joinPath(dir, boardFileName(projectKey, projectName));
}

export type FsResult = { ok: boolean; text: string };

/*
 * 判据转出去给老调用方（boardMetaFile 及其测试从本文件取）。
 * 实现在 textFile.ts，不另抄一份 —— 理由见上面的 import 注释。
 */
export { isParseableJson };

/** "不存在"的几种说法。Rust 侧与浏览器侧措辞不同，都要认 */
const NOT_FOUND = /不存在|not found|no such|ENOENT/i;

/**
 * 读一个文本文件。
 *
 * 文件**不存在**不算失败 —— 第一次打开某个项目的任务板时它本来就没有。
 * 那种情况返回空串，让上层按空板处理；报错只会让人以为功能坏了。
 */
export async function readBoardFile(path: string): Promise<string> {
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
export async function writeBoardFile(path: string, content: string): Promise<void> {
  if (!canExportToFile()) throw new Error('写文件需要运行在桌面端（当前是浏览器模式）');
  const dir = path.replace(/\/[^/]*$/, '');
  if (dir && dir !== path) {
    const d = await ensureDir(dir);
    if (!d.ok && !/已存在|exists/i.test(d.text)) throw new Error(d.text || `建目录失败：${dir}`);
  }
  const r = await writeTextFile(path, content);
  if (!r.ok) throw new Error(r.text || `写文件失败：${path}`);
}

/* ------------------------------------------------------------------ */
/* 一次「改并落地」                                                     */
/* ------------------------------------------------------------------ */

export type SaveOutcome = {
  board: TaskBoard;
  /** 本次改动被磁盘上的版本盖掉的节点 —— 必须提示，否则改动像凭空消失 */
  overwritten: string[];
  /** 外部新加的 */
  added: string[];
};

/**
 * 把本地改动落到文件，写前**重读一次磁盘**做三方合并。
 *
 * 为什么不直接覆盖：AI 改文件是主路径，它随时可能刚写完。
 * 不重读就写，等于把 AI 那次写入无声吞掉 —— 它不会收到任何提示，
 * 下次读到的又是旧内容，表现为"我明明写了，怎么没了"。
 *
 * 合并判据见 mergeBoards：两边都动了同一条时**外部优先**。
 *
 * base 是"上次读到的内容"，由调用方持有（hook 里存着）。
 *
 * ⛔ 写前先看文件坏没坏：坏的直接抛错、**一个字节都不写**。
 *    坏文件被 parseBoard 解成空清单 → theirs 是空 → 合并结果只剩 mine
 *    → 写回即整份覆盖，手改能救回来的内容永远没了。
 */
export async function commitBoard(
  path: string,
  base: TaskBoard,
  mine: TaskBoard,
): Promise<SaveOutcome> {
  const raw = await readBoardFile(path);
  if (!isParseableJson(raw)) {
    throw new Error(`清单文件已损坏，已中止写入（原文件未改动）：${path}`);
  }
  const theirs = parseBoard(raw || null, mine.project, mine.projectName);
  const merged = mergeBoards(base, mine, theirs);
  await writeBoardFile(path, serializeBoard(merged.board));
  return merged;
}

/**
 * 载入：读不到就当空板（第一次用）。
 *
 * ⛔ 但"文件在、内容是坏的"不能也当空板 —— 那等于告诉用户
 *    「这个项目的任务板是空的」，而磁盘上其实有一整板任务。
 *    用户照着"空的"去添加第一条，就把那份还能救的 JSON 整份盖掉了。
 *    文件不存在（空串）才算第一次用。
 */
export async function loadBoard(
  path: string,
  project: string,
  projectName: string,
): Promise<TaskBoard> {
  const raw = await readBoardFile(path);
  if (!raw.trim()) return emptyBoard(project, projectName);
  if (!isParseableJson(raw)) {
    throw new Error(`清单文件已损坏（未读取，原文件未改动）：${path}`);
  }
  return parseBoard(raw, project, projectName);
}
