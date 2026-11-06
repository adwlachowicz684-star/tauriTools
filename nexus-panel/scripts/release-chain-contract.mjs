#!/usr/bin/env node
/**
 * 产物链契约：13 个插件仓共用的发版判据。
 *
 * 为什么单独一份
 * ------------------------------------------------------------
 * 第 47 轮把 github-manager 登记成 EXTERNAL_PLUGINS，注释写的是
 * 「不参与产物链」，于是建仓 / 刷新 / 核验 / 发布四条通道的遍历源
 * IDS = Object.keys(CAMEL) 只认 12 个仓，主仓还专门加守卫把这个
 * 「不覆盖」钉成契约。
 *
 * 第 48 轮起它已经**参与产物链**：插件仓自己有 nexus.plugin.json、
 * v0.1.0 release 和 nexus-plugin-github-manager-0.1.0.tar.gz 资产，
 * 宿主按同一条链路（pickAsset / verifyAssetDigest / plugin-installer）
 * 安装，主仓 CSP 也为它放行了 https://api.github.com。
 *
 * 但「参与产物链」不等于「该进共享镜像」：把外部仓塞进 IDS 会把
 * js/ css/ src/ 推过去覆盖 Node CLI 的真实实现 —— 那条禁令仍然成立。
 * 所以正确切法是：IDS（共享镜像遍历源）保持 12 个不动，另外把
 * **产物链契约核验**独立覆盖 13 个仓。两件事别再混成一句
 * 「不参与产物链」。
 *
 * 分叉是真发生了的：外部仓的 release.yml 用了 12 仓注释明令禁止的
 * --clobber，回读把 state+digest 拼一行用 case 判，缺解包回读与
 * SHA256SUMS，而没有任何守卫会看它一眼。
 */
import { IDS, repoNameFor } from './build-plugin-repos.mjs';
import { EXTERNAL_PLUGINS } from './plugin-repo-map.mjs';

/** 产物流转的全部仓库：12 个可安装 + 已发版的外部工具型。 */
export const PRODUCT_IDS = [...IDS, ...Object.keys(EXTERNAL_PLUGINS)];
export const PRODUCT_REPOS = PRODUCT_IDS.map((id) => ({ id, repo: repoNameFor(id) }));

/** 剥 YAML / shell 行注释。注释里写着「禁止 --clobber」，不剥会被喂饱。 */
export function stripYamlComments(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/**
 * release.yml 的最低发版契约。
 * 判的是「代码里真这么跑」，不是注释里承诺过。
 */
export function workflowContract(text) {
  const code = stripYamlComments(text);
  const errors = [];
  if (!code.trim()) errors.push('空 workflow：判据不许恒真');
  /* 同 tag 覆盖上传：ledger 按 tag 判更新，tag 不变时用户永远停在旧资产，
     而服务端已被悄悄替换。12 仓注释把这个列为最难查的场景。 */
  if (/--clobber/.test(code)) errors.push('用了 --clobber（同 tag 覆盖上传）');
  if (!/\[\s*"\$STATE"\s*=\s*"uploaded"\s*\]/.test(code)) {
    errors.push('回读没单独判 state === uploaded');
  }
  if (!/sha256:/.test(code)) errors.push('回读没单独判 digest 形如 sha256:');
  if (!/tarfile\.open|tar -tzf/.test(code)) {
    errors.push('缺 tarball 解包回读（入口存在 / 条目纯相对）');
  }
  return { ok: errors.length === 0, errors };
}

/** 已发布的 release 是否满足宿主安装链路的最低要求。 */
export function assetContract(release, id, version) {
  const errors = [];
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  if (!assets.length) return { ok: false, errors: ['release 没有任何资产'], asset: null };
  const want = `nexus-plugin-${id}-`;
  const asset = assets.find((a) => String(a.name).startsWith(want)
    && String(a.name).endsWith('.tar.gz')) || null;
  if (!asset) {
    return { ok: false, errors: [`release 里没有 ${want}*.tar.gz 产物`], asset: null };
  }
  if (asset.state !== 'uploaded') {
    errors.push(`asset state=${String(asset.state)}（半成品包会被装进去）`);
  }
  if (!/^sha256:[0-9a-fA-F]{64}$/.test(String(asset.digest || ''))) {
    errors.push(`asset digest 缺失或格式不对（=${String(asset.digest)})`);
  }
  if (version && String(release.tag_name || '').replace(/^v/i, '') !== String(version)) {
    errors.push(`tag=${release.tag_name} 与 manifest.version=${version} 不一致`);
  }
  return { ok: errors.length === 0, errors, asset };
}
