#!/usr/bin/env node
/**
 * 插件 id → 独立 GitHub 仓库名 的**唯一真值源**。
 *
 * 为什么单独一个文件
 * ------------------------------------------------------------
 * 同一份映射此前散在两处：
 *   · build-plugin-repos.mjs 的 CAMEL 表（建仓 / 骨架 / 探针用）
 *   · 各插件仓库 manifest 里的 repo 字符串（骨架生成器自己拼）
 * 主仓 12 份 manifest 却一份都没有 —— 于是「仓库叫什么」这件事
 * 有两个会说谎的地方、还有一个完全没记录的源。
 *
 * 现在收敛成一条链，任何一处写错都会被守卫抓到：
 *   本模块（唯一表）
 *     ├→ gen-plugin-manifest.mjs 派生写入主仓 12 份 manifest.repo
 *     ├→ build-plugin-repos.mjs 生成骨架时**校验**主仓 repo（不再自己拼）
 *     └→ plugin-repo-sync-test.mjs 用独立算法反推期望值逐份比对
 *
 * ⚠️ 仓库名 ≠ 产物名
 * ------------------------------------------------------------
 * 仓库名前缀是 `nexusPanel_plugin_`，产物名前缀是 `nexus-plugin-`
 * （见 js/plugin-store-client.js 的 ASSET_PREFIX）。后者是宿主 pickAsset
 * 的判据，跟着仓库名一起改会让「装了却找不到产物」且不报原因。
 * 新增插件只需补 CAMEL 表；产物前缀不要动。
 */

export const OWNER = 'adwlachowicz684-star';
export const REPO_PREFIX = 'nexusPanel_plugin_';

/** 12 个可安装（iframe）插件的驼峰名。新增插件必须同步补表，否则 fail-closed 拒绝建仓。 */
export const CAMEL = {
  'agent-flow': 'agentFlow',
  'color-picker': 'colorPicker',
  'demo-iframe': 'demoIframe',
  'demo-light': 'demoLight',
  'demo-react': 'demoReact',
  'demo-service': 'demoService',
  'dupview': 'dupview',
  'icon-picker': 'iconPicker',
  'md-editor': 'mdEditor',
  'mindmap': 'mindmap',
  'project-group': 'projectGroup',
  'task-board': 'taskBoard',
};

export function repoNameFor(id) {
  const c = CAMEL[id];
  if (!c) throw new Error(`未登记的插件 id: ${id}（新增插件须同步补 CAMEL 映射）`);
  return `${REPO_PREFIX}${c}`;
}

/** manifest.repo 的完整值：owner/name */
export function repoFieldFor(id) {
  return `${OWNER}/${repoNameFor(id)}`;
}
