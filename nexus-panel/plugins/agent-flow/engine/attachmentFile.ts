/**
 * 附属文件清单的落地 —— 读写磁盘上的那个 JSON。
 *
 *   <导出目录>/attachments-<项目>.json
 *
 * 按项目分文件，是为了 AI 只读自己那一份 ——
 * 全部塞进一个文件的话，AI 每次都要把别项目的附件也读进来，
 * 那正是"不同项目互相占用上下文"的另一种形式。
 *
 * 读写本身（readTextFile / writeTextFile）是通用的文本读写，
 * 在 engine/textFile.ts —— 那里不认识任何清单的数据结构。
 */

import {
  readTextFile, writeTextFile, isParseableJson,
} from './textFile';
import { safeFilePart, joinPath } from './exportDir';
import {
  parseAttachments, serializeAttachments, mergeAttachments, emptyAttachments,
  type AttachmentFile,
} from './attachmentStore';

/* 转出去给预览层用（读 md 原文）。实现在 textFile.ts，不另抄一份 */
export { readTextFile, writeTextFile, isParseableJson };

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
 * 不重读就写会把 AI 刚写进文件的内容无声吞掉（理由见 textFile）。
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
  const raw = await readTextFile(path);
  if (!isParseableJson(raw)) {
    throw new Error(`清单文件已损坏，已中止写入（原文件未改动）：${path}`);
  }
  const theirs = parseAttachments(raw || null, mine.project, mine.projectName);
  const merged = mergeAttachments(base, mine, theirs);
  await writeTextFile(path, serializeAttachments(merged.file));
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
  const raw = await readTextFile(path);
  if (!raw.trim()) return emptyAttachments(project, projectName);
  if (!isParseableJson(raw)) {
    throw new Error(`清单文件已损坏（未读取，原文件未改动）：${path}`);
  }
  return parseAttachments(raw, project, projectName);
}
