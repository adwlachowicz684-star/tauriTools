import { useEffect, useRef, useState } from 'react';
import type { Api } from '../api';

/**
 * 卡片图标缩略图：路径 → data URI。
 *
 * 卡片上存的图标是本地文件路径，iframe 里用 file:// 会被浏览器拦，
 * 所以逐个问后端要 data URI。按需加载 + 全程缓存，同一路径只取一次。
 * 失败的路径记进 failed，不再反复重试（避免每张卡片都刷一遍 IPC 报错）。
 */
export function useIconThumbs(api: Api, paths: string[]) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const done = useRef<Set<string>>(new Set());

  // 只在路径集合变化时补齐缺失项；thumbs 本身变化不触发，避免无限循环
  const key = paths.join('\u0000');
  useEffect(() => {
    let alive = true;
    /**
     * 本次 effect **已发出但还没回来**的路径。
     *
     * done 必须在**拿到结果之后**才算数，不能在发请求前就加进去：
     * 切页签 / 增删卡片会让 paths 变化，effect 随即被拆掉重建，
     * 那些还在飞的请求永远等不到 `setThumbs`，而若它们此刻已经在 done 里，
     * 下一次进来会被当成"处理过了"直接跳过 ——
     * 那几张卡片的图标从此**永远停在占位符**，既不报错也不重试，
     * 用户只会觉得"这个卡片的图标就是显示不出来"。
     *
     * 所以中断时要把没回来的那些从 done 里摘掉，让下次重新去取。
     * 真失败（catch）则保留在 done 里：那是有意的，不反复重试刷 IPC 报错。
     */
    const pending = new Set<string>();
    (async () => {
      for (const p of paths) {
        if (!alive || done.current.has(p)) continue;
        done.current.add(p);
        pending.add(p);
        try {
          const uri = await api.iconData(p);
          if (!alive) return;
          setThumbs((m) => ({ ...m, [p]: uri }));
        } catch {
          /* 读不出来就保持占位字符，静默（留在 done 里，不反复重试） */
        } finally {
          pending.delete(p);
        }
      }
    })();
    return () => {
      alive = false;
      for (const p of pending) done.current.delete(p);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, api]);

  return thumbs;
}
