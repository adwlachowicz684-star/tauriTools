/**
 * stale-root.mjs —— 陈旧构建产物的暂存根目录（构建脚本共用）。
 *
 * 为什么必须和项目**同卷**：清掉旧产物只有 rename 这一条路（删除会撞
 * safe-delete 守卫，≥50 个文件直接拒），而 renameSync 跨卷会报 EXDEV。
 * 项目在 E: 盘、os.tmpdir() 在 C: 盘 —— 直接用 tmpdir 就是 EXDEV。
 *
 * 于是暂存根目录取「项目所在盘的根」：E:/_nexus_stale_build。同卷、改名
 * 瞬间完成、不回仓库（不在项目目录内，git 也管不着）。
 */
import { parse } from 'node:path';
import { PATHS } from '../config/nexus.config.mjs';

const drive = parse(PATHS.root).root;          // Windows: 'E:\\'；POSIX: '/'
export const STALE_ROOT = `${drive}_nexus_stale_build`;
