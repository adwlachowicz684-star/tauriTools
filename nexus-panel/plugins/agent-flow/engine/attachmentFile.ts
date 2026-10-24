/**
 * 附属文件清单的落地 —— 读写磁盘上的那个 JSON。
 *
 * 与任务板并排放：
 *   <导出目录>/tasks-<项目>.json         任务板
 *   <导出目录>/attachments-<项目>.json   本文件
 *
 * 分开两个文件而不是塞进一个，是为了 AI 只看自己要的那份 ——
 * 为了改一条附件去读整个任务板（反过来也一样），
 * 就是"不同任务互相占用上下文"的另一种形式。
 *
 * 读写本身（readBoardFile / writeBoardFile）是通用的文本读写，
 * 直接复用 taskBoardFile 里那两个：它们不认识任务板的数据结构，
 * 只是"读一个文本文件 / 写一个文本文件"。
 */

import {
  readBoardFile, writeBoardFile, isParseableJson,
} from './taskBoardFile';
import { safeFilePart, joinPath } from './exportDir';
import {
  parseAttachments, serializeAttachments, mergeAttachments, emptyAttachments,
  type AttachmentFile,
} from './attachmentStore';

/*
  通用的"读/写一个文本文件"最早写在 taskBoardFile 里（任务板先用上），
  但它们并不认识任务板的数据结构 —— 这里换个中性名字转出去，
  预览层读 md 直接用它，不必知道它原本是给谁写的。

  ⛔ 不要另抄一份：读文件时"不存在算不算错"的口径（见 readBoardFile）
  一旦分叉，同一个文件在任务板和附件两处会给出不同的结果。
*/
export { readBoardFile as readTextFile, writeBoardFile as writeTextFile } from './taskBoardFile';

/*
 * 与任务板**同一份**判据（实现在 taskBoardFile.ts，不另抄）。
 * 两份清单并排放，口径分叉的后果见那边注释里的说明。
 */
export { isParseableJson } from './taskBoardFile';

export function attachmentFileName(projectKey: string, projectName: string): string {
  const label = safeFilePart(projectName || projectKey || 'all', 'all');
  return `attachments-${label}.json`;
}

export function attachmentPathOf(dir: string, projectKey: string, projectName: string): string {
  return joinPath(dir, attachmentFileName(projectKey, projectName));
}

export type AttachSave = {
  file: AttachmentFile;
  overwritten: string[];
  added: string[];
};

/**
 * 落盘。写前**重读一次磁盘**做三方合并 ——
 * 不重读就写会把 AI 刚写进文件的内容无声吞掉（理由见 taskBoardFile）。
 *
 * ⛔ 写前先看文件坏没坏：坏的直接抛错、**一个字节都不写**。
 *    理由与 commitBoard 完全相同（损坏的 JSON 被解成空清单，
 *    合并结果只剩 mine，写回即整份覆盖）。
 */
export async function commitAttachments(
  path: string,
  base: AttachmentFile,
  mine: AttachmentFile,
): Promise<AttachSave> {
  const raw = await readBoardFile(path);
  if (!isParseableJson(raw)) {
    throw new Error(`清单文件已损坏，已中止写入（原文件未改动）：${path}`);
  }
  const theirs = parseAttachments(raw || null, mine.project, mine.projectName);
  const merged = mergeAttachments(base, mine, theirs);
  await writeBoardFile(path, serializeAttachments(merged.file));
  return merged;
}

/**
 * 载入：读不到就当空清单（第一次用）。
 *
 * ⛔ 与 loadBoard 同一口径：文件在但内容坏了不能当空清单 ——
 *    那等于告诉用户「没有附件」，而磁盘上其实有一整份，
 *    照着"空的"加第一条就把还能救的 JSON 整份盖掉了。
 */
export async function loadAttachments(
  path: string,
  project: string,
  projectName: string,
): Promise<AttachmentFile> {
  const raw = await readBoardFile(path);
  if (!raw.trim()) return emptyAttachments(project, projectName);
  if (!isParseableJson(raw)) {
    throw new Error(`清单文件已损坏（未读取，原文件未改动）：${path}`);
  }
  return parseAttachments(raw, project, projectName);
}
