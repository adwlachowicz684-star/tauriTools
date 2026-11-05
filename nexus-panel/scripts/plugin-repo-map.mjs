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

/**
 * 与 12 个可安装插件**并列平级**、但不参与产物链的外部工具型插件。
 *
 * github-manager：用 GitHub API 管理账号下全部仓库的插件（独立 Node 进程 +
 * 本地 Web 仪表盘），不是 iframe 插件，没有可挂载的入口页面。
 *
 * 为什么不塞进 CAMEL：
 *   · build-plugin-repos.mjs 的 IDS = Object.keys(CAMEL)，是建仓 / 骨架 /
 *     增量刷新 / 核验四条通道的遍历源。塞进去会把共享镜像和
 *     nexus.plugin.json 推到这个仓库，覆盖 Node CLI 的真实实现；
 *   · 守卫按 registry 的 12 个 iframe 插件钉住「CAMEL 恰为 12 条」，
 *     多一条会让 12 份 manifest 的交叉校验一起红；
 *   · 给它发 manifest 反而制造假绿：宿主按 repo 去查 release 必然扑空，
 *     界面只显示「这个插件没有可安装版本」。
 * 所以只登记仓库名，不发 manifest / 不发 release 产物，也不进 IDS。
 */
export const EXTERNAL_PLUGINS = {
  'github-manager': 'githubManager',
};

/**
 * 可安装插件与外部工具型插件共用同一个仓库名规则，全表仍只有这一份。
 *
 * ⛔ 两件事不能靠 `CAMEL[id] || EXTERNAL_PLUGINS[id]` 的短路糊过去：
 *   · 同一个 id 同时登记在两张表时，短路会静默以 CAMEL 为准 —— 外部工具
 *     被当成可安装插件，IDS 多一条，共享镜像与 manifest 就会推到它的仓库，
 *     覆盖 Node CLI 的真实实现。这正是上面三条不塞进 CAMEL 的理由之一，
 *     而短路写法让这个错误**不报错、也没有任何仓库名变化**可被察觉
 *     （camelOf('github-manager') 恰好也是 githubManager）。
 *   · 对象字面量直接取值会把原型链上的键当登记项：传 'constructor' 会拿到
 *     Object 函数、拼出一个形似合规的仓库名，而不是 fail-closed 抛错。
 * 所以两边都用 hasOwnProperty 判定，重叠显式拒绝。
 */
export function repoNameFor(id) {
  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const inCamel = has(CAMEL, id);
  const inExternal = has(EXTERNAL_PLUGINS, id);
  if (inCamel && inExternal) {
    throw new Error(`插件 id ${id} 同时登记在 CAMEL 与 EXTERNAL_PLUGINS，`
      + '只能属于其中一类；同时登记会让共享镜像与 manifest 推到外部工具仓');
  }
  const c = inCamel ? CAMEL[id] : (inExternal ? EXTERNAL_PLUGINS[id] : null);
  if (!c) {
    throw new Error(`未登记的插件 id: ${id}（可安装 iframe 插件补 CAMEL；`
      + '不参与产物链的外部工具型插件补 EXTERNAL_PLUGINS）');
  }
  return `${REPO_PREFIX}${c}`;
}

/** manifest.repo 的完整值：owner/name */
export function repoFieldFor(id) {
  return `${OWNER}/${repoNameFor(id)}`;
}
