/**
 * 项目元数据的落地 —— 读写 disk 上那个 JSON。
 *
 *   <导出目录>/boardmeta-<项目>.json
 *
 * 与任务板、附件清单并排第三个文件。三个文件按项目配套，
 * 切项目时一起换。
 *
 * ================= 合并策略为什么比任务板简单 =================
 *
 * 任务板要做逐条三方合并，因为 AI 会**批量**往里写几十条任务。
 * 本文件是配置（状态 + 标签），一次改动通常只动一条，
 * 且用户正在设置界面里盯着它 —— 冲突窗口极小。
 *
 * 所以这里按**整份**比较：谁新听谁的，并明确报告"被覆盖了"。
 * 不做逐条合并是因为那需要为每个字段写比对规则（next 数组怎么合？
 * 顺序怎么合？），而收益接近于零。
 *
 * ⛔ 但这不代表可以静默覆盖：用户在界面上改了半天状态名，
 * 被 AI 写的一份旧文件无声盖掉，是最难解释的那种数据丢失。
 * 所以覆盖**必须**回报告诉调用方。
 */

import { safeFilePart, joinPath } from './exportDir';
import {
  parseMeta, serializeMeta, emptyMeta, type BoardMeta,
} from './boardMeta';
import { readTextFile, writeTextFile } from './attachmentFile';
/*
 * "坏没坏"的判据**不在这里另写** —— 复用任务板那一份。
 *
 * 三份清单（tasks / attachments / boardmeta）并排放**在同一个导出目录**里，
 * 口径分叉的后果见 taskBoardFile.ts 里的说明：同一个损坏的文件
 * 在这个面板报"读不出来"、在那个面板当"没有"，是最难自查的不一致。
 * 而这个文件曾经就是那个漏掉的一份（另两份早已守卫）。
 */
import { isParseableJson } from './taskBoardFile';

export function metaFileName(projectKey: string, projectName: string): string {
  const label = safeFilePart(projectName || projectKey || 'all', 'all');
  return `boardmeta-${label}.json`;
}

export function metaPathOf(dir: string, projectKey: string, projectName: string): string {
  return joinPath(dir, metaFileName(projectKey, projectName));
}

export type MetaSave = {
  meta: BoardMeta;
  /** 写入时被磁盘上更新的那份盖掉了 */
  overwritten: boolean;
};

/**
 * 落盘。写前重读一次 —— 不重读就把别人的改动无声吞了。
 *
 * 判据：`theirs.updatedAt > base.updatedAt` 表示我读完之后有人改过。
 * 用户的改动比我的新时，听用户的（他是当面在改的那一方）。
 */
export async function commitMeta(
  path: string,
  base: BoardMeta,
  mine: BoardMeta,
): Promise<MetaSave> {
  const raw = await readTextFile(path);
  /*
   * ⛔ 写前先看文件坏没坏：坏的直接抛错、**一个字节都不写**。
   *
   *    坏文件被 parseMeta 解成默认配置（updatedAt 归 0），于是
   *    `theirs.updatedAt > base.updatedAt` 恒为假 —— 判定成"没人改过"，
   *    照常写回即整份覆盖；而损坏的 JSON 往往手改几行就能救回来。
   *
   *    这一条对**本文件尤其要命**：状态集与标签是用户盯着设置界面
   *    一条条改出来的，一盖就是从头再配一遍，且没有任何提示 ——
   *    不抛错的话调用方拿到 `overwritten: false`（"没覆盖任何东西"），
   *    那句话在文件刚被整份盖掉的这一刻是假的。
   */
  if (!isParseableJson(raw)) {
    throw new Error(`清单文件已损坏，已中止写入（原文件未改动）：${path}`);
  }
  const theirs = parseMeta(raw || null, mine.project, mine.projectName);
  if (raw.trim() && theirs.updatedAt > base.updatedAt) {
    return { meta: theirs, overwritten: true };
  }
  const out: BoardMeta = { ...mine, updatedAt: Date.now() };
  await writeTextFile(path, serializeMeta(out));
  return { meta: out, overwritten: false };
}

/** 载入。读不到返回默认（第一次用时文件本来就没有） */
export async function loadMeta(
  path: string,
  project: string,
  projectName: string,
): Promise<BoardMeta> {
  const raw = await readTextFile(path);
  if (!raw.trim()) return emptyMeta(project, projectName);
  /*
   * ⛔ "文件在、内容是坏的"不能也当默认配置 —— 那等于告诉用户
   *    「这个项目还没配过状态」，而磁盘上其实有一整套。
   *    用户照着"没配过"去加第一条，就把那份还能救的 JSON 整份盖掉了。
   */
  if (!isParseableJson(raw)) {
    throw new Error(`清单文件已损坏（未读取，原文件未改动）：${path}`);
  }
  return parseMeta(raw, project, projectName);
}
