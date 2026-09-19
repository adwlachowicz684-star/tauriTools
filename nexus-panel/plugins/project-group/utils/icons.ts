import type { CardInfo } from '../types';

/**
 * 卡片**实际显示**的图标（#13）。
 *
 * 界面专属那套优先，为空则回退到资源管理器那套。
 *
 * 为什么单独成一个函数：**缩略图与兜底字形都要用它**。
 * 两处各写一遍 `guiIcon ?? icon` 的话，改优先级时很容易只改一处 ——
 * 表现为"有图标文件的显示新图标、没文件的还显示旧图标"，极难联想到是这个原因。
 */
export function displayIcon(c: CardInfo): string | null {
  return c.guiIcon ?? c.icon;
}
