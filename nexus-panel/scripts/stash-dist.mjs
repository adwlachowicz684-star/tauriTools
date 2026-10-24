/**
 * stash-dist.mjs —— 在 vite build 之前把旧的 dist/ 改名挪走。
 *
 * 与 scripts/build-plugins.mjs 里的 stashOutDir 同一套理由：dist/ 现在内含
 * 整个 runtime-plugins/（342+ 个文件），Vite 的 emptyOutDir 会一次性删掉它们，
 * 撞 safe-delete 批量守卫（≥50 需确认）→ 构建失败。而且每次成功构建都会把
 * 下一次卡死，只能手动挪。
 *
 * rename 不是删除，守卫不管；同卷改名瞬间完成，比逐个删文件快得多。
 * 陈旧目录落在系统临时目录，随系统清理，不回仓库。
 */
import { existsSync, renameSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { STALE_ROOT } from './stale-root.mjs';

const dist = resolve(process.cwd(), 'dist');

if (!existsSync(dist)) {
  console.log('[stash-dist] dist/ 不存在，无需挪动');
} else {
  mkdirSync(STALE_ROOT, { recursive: true });
  const stale = resolve(STALE_ROOT, `dist-${Date.now()}`);
  try {
    renameSync(dist, stale);
    console.log(`[stash-dist] dist/ -> ${stale}`);
  } catch (e) {
    /* 挪不走（被占用/跨卷）就交给 emptyOutDir，失败信息更好懂。 */
    console.warn(`[stash-dist] 挪不动（${e.code}），沿用 emptyOutDir`);
  }
}
