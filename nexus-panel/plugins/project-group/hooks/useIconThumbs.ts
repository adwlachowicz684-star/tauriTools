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
    (async () => {
      for (const p of paths) {
        if (!alive || done.current.has(p)) continue;
        done.current.add(p);
        try {
          const uri = await api.iconData(p);
          if (!alive) return;
          setThumbs((m) => ({ ...m, [p]: uri }));
        } catch {
          /* 读不出来就保持占位字符，静默 */
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, api]);

  return thumbs;
}
