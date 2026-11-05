#!/usr/bin/env node
/**
 * 独立仓 manifest 的派生字段期望值 —— **独立算法**。
 *
 * 为什么不 import gen-plugin-manifest.mjs
 * ------------------------------------------------------------
 * 拿生成器的 derive() 输出去验 12 个插件仓里的 manifest，等于拿生成器
 * 验生成器自己：derive 写错时，期望值和被验对象一起错，守卫照样全绿
 * （本项目反复栽的「自己验自己」）。所以这里从 registry 记录直接按规则
 * 算，与生成器同口径、但实现互不依赖。
 *
 * 主仓 12 份 manifest 已迁出（源码退场），交叉一致的取证对象随之搬到
 * 12 个独立私有仓：由 scripts/verify-plugin-repos.mjs 联网读取，本模块
 * 提供期望值。联网探针刻意不登记 npm script（网络故障会与真实漂移混成
 * 同一种红），离线侧由 plugin-manifest-repos-test.mjs 钉住本模块的判据。
 */
import path from 'node:path';

export const OWNER = 'adwlachowicz684-star';
export const REPO_PREFIX = 'nexusPanel_plugin_';

/** 标准 camelCase：首段原样，后续段首字母大写。与 plugin-repo-sync-test.mjs 同一规则。 */
export function camelOf(id) {
  return id.split('-').map((s, i) => (i ? s.charAt(0).toUpperCase() + s.slice(1) : s)).join('');
}

export function repoNameForId(id) {
  return REPO_PREFIX + camelOf(id);
}

/**
 * 由 registry 记录算出 manifest 应有的派生字段。
 * @param {object} p     registry.plugins 里的一条（iframe）
 * @param {string} root  nexus-panel 项目根（registry.entry 相对它）
 */
export function wantFields(p, root) {
  const plugins = path.join(root, 'plugins');
  return {
    id: p.id,
    name: p.name,
    kind: p.kind || 'app',
    icon: p.icon || '◻',
    description: p.description || '',
    /* registry.entry 是相对项目根的 './plugins/<id>/index.html'；
       manifest.entry 必须相对插件目录 —— 装进来后目录位置会变。 */
    entry: path.relative(path.join(plugins, p.id), path.join(root, p.entry))
      .split(path.sep).join('/'),
    repo: `${OWNER}/${repoNameForId(p.id)}`,
  };
}

/** 逐字段比对；返回不一致项数组（空数组 = 一致）。刻意不比 version 等手工字段。 */
export function fieldDiffs(mf, want) {
  return Object.entries(want)
    .filter(([k, v]) => mf[k] !== v)
    .map(([k, v]) => `${k}=${JSON.stringify(mf[k])} 期望 ${JSON.stringify(v)}`);
}
