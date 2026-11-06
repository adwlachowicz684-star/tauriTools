#!/usr/bin/env node
/**
 * 产物链契约守卫：第 13 个仓不能因为「外部工具型」这个历史标签
 * 就游离在所有发版守卫之外，同时共享镜像遍历源仍必须只有 12 个。
 *
 * 判据一律从 scripts/release-chain-contract.mjs 导入（不另写一份），
 * 行为层用合成样本真跑，接线层剥注释走共用 stripCommentsFlatJs
 * —— 注释里原样写着 --clobber 与 PRODUCT_REPOS，不剥会被喂饱。
 */
import fs from 'node:fs';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';
import { IDS } from './scripts/build-plugin-repos.mjs';
import { EXTERNAL_PLUGINS } from './scripts/plugin-repo-map.mjs';
import {
  PRODUCT_IDS, PRODUCT_REPOS, stripYamlComments,
  workflowContract, assetContract,
} from './scripts/release-chain-contract.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
};
const clean = (rel) => stripCommentsFlatJs(fs.readFileSync(rel, 'utf8'));
const has = (rel, re) => re.test(clean(rel));

/* 合规 workflow 样本：与 12 仓 release.yml 的关键形态一致 */
const GOOD_WF = `
name: Plugin Release
env:
  TAG_NAME: v0.1.0
steps:
  - name: 打包
    run: |
      sha256sum "$TARBALL" | tee SHA256SUMS
  - name: 解包回读
    run: |
      python3 - <<'PY'
      import tarfile
      with tarfile.open(sys.argv[1], 'r:gz') as tf: names = tf.getnames()
      PY
  - name: 发布 Release
    run: |
      gh release create "$TAG_NAME" --generate-notes "$TARBALL" SHA256SUMS
  - name: 回读产物完整性
    run: |
      read -r STATE DIGEST SIZE < asset-info.txt
      [ "$STATE" = "uploaded" ] || { echo "::error::asset state=$STATE"; exit 1; }
      case "$DIGEST" in
        sha256:[0-9a-fA-F]*) : ;;
        *) exit 1 ;;
      esac
`;
const compliantAsset = (over = {}) => ({
  tag_name: 'v0.1.0',
  assets: [{
    name: 'nexus-plugin-github-manager-0.1.0.tar.gz',
    state: 'uploaded',
    digest: 'sha256:' + 'a'.repeat(64),
    ...over,
  }],
});

console.log('— ① 集合口径：产物链覆盖 13 仓，共享镜像仍只有 12 仓 —');
t('①a 可安装插件集合恰为 12', IDS.length === 12, `实际 ${IDS.length}`);
t('①b 外部插件集合恰为 1', Object.keys(EXTERNAL_PLUGINS).length === 1);
t('①c 产物链集合恰为 13（12 + 外部）', PRODUCT_IDS.length === 13,
  `实际 ${PRODUCT_IDS.length}`);
t('①d 13 个仓库名互不重复', new Set(PRODUCT_REPOS.map((x) => x.repo)).size === 13);
t('①e 外部仓确实在产物链里',
  PRODUCT_REPOS.some((x) => x.id === 'github-manager'
    && x.repo === 'nexusPanel_plugin_githubManager'));
t('①f 元断言：空集合不会通过 ①c', PRODUCT_IDS.length !== 0);
/* ③e 的原始禁令：四条通道的遍历源不得含外部表 */
for (const rel of [
  'scripts/build-plugin-repos.mjs', 'scripts/refresh-plugin-repos.mjs',
  'scripts/verify-plugin-repos.mjs', 'scripts/publish-plugin-releases.mjs',
  'scripts/retire-plugin-sources.mjs',
]) {
  t(`①g ${rel.split('/').pop()}: 不把外部表并进建仓/刷新/发布遍历源`,
    !has(rel, /Object\.keys\(\s*EXTERNAL_PLUGINS\s*\)/));
}
t('①h 共享镜像遍历源仍是 IDS（不是产物链集合）',
  has('scripts/verify-plugin-repos.mjs', /IDS_TODO/)
  && !has('scripts/verify-plugin-repos.mjs', /PRODUCT_REPOS\s*\.map\([^)]*sharedMirror/));

console.log('— ② workflow 判据：合规通过，四种违约各自报对 —');
const wGood = workflowContract(GOOD_WF);
t('②a 合规样本通过', wGood.ok, wGood.errors.join('; '));
t('②b 注释里写「禁止 --clobber」不算违约',
  workflowContract('# 禁止 --clobber / 同 tag 重传\n' + GOOD_WF).ok);
t('②c 空文本判失败（判据不恒真）', !workflowContract('').ok);
const wClob = workflowContract(GOOD_WF.replace('gh release create', 'gh release upload --clobber'));
t('②d --clobber 被拒且点名同 tag 覆盖', !wClob.ok
  && wClob.errors.some((x) => /clobber/.test(x)), wClob.errors.join('; '));
const wState = workflowContract(GOOD_WF.replace(/\[\s*"\$STATE"\s*=\s*"uploaded"\s*\]/, 'true'));
t('②e 撤掉 state 单独判被拒', !wState.ok
  && wState.errors.some((x) => /state/.test(x)), wState.errors.join('; '));
const wDigest = workflowContract(GOOD_WF.replace(/sha256:\[0-9a-fA-F\]\*/, 'x:*'));
t('②f 撤掉 digest 判据被拒', !wDigest.ok
  && wDigest.errors.some((x) => /digest/.test(x)), wDigest.errors.join('; '));
const wUnpack = workflowContract(GOOD_WF.replace('tarfile.open', 'no_unpack'));
t('②g 撤掉解包回读被拒', !wUnpack.ok
  && wUnpack.errors.some((x) => /解包/.test(x)), wUnpack.errors.join('; '));
t('②h 四种违约互不串味', wClob.errors.length === 1 && wState.errors.length === 1
  && wDigest.errors.length === 1 && wUnpack.errors.length === 1);
/* 注释喂饱反向验证：把合规代码整段换成注释，判据必须红 */
const onlyComment = GOOD_WF.split('\n').map((l) => '# ' + l).join('\n');
t('②i 整段注释化后判据报红（不恒假）', !workflowContract(onlyComment).ok);
t('②j stripYamlComments 只去掉行注释',
  /gh release create/.test(stripYamlComments('# x\n' + GOOD_WF)));

console.log('— ③ release 资产判据：与宿主 pickAsset / verifyAssetDigest 同口径 —');
const aGood = assetContract(compliantAsset(), 'github-manager', '0.1.0');
t('③a 合规 release 通过', aGood.ok, aGood.errors.join('; '));
const aState = assetContract(compliantAsset({ state: 'uploading' }), 'github-manager', '0.1.0');
t('③b state 非 uploaded 被拒', !aState.ok
  && aState.errors.some((x) => /state=/.test(x)), aState.errors.join('; '));
const aNoDigest = assetContract(compliantAsset({ digest: null }), 'github-manager', '0.1.0');
t('③c 缺 digest 被拒', !aNoDigest.ok
  && aNoDigest.errors.some((x) => /digest/.test(x)), aNoDigest.errors.join('; '));
const aFake = assetContract(compliantAsset({ digest: 'sha256:nothex' }), 'github-manager', '0.1.0');
t('③d 假 digest 被拒（格式判据不是只查前缀）', !aFake.ok, aFake.errors.join('; '));
const aName = assetContract({ tag_name: 'v0.1.0', assets: [{ name: 'src.zip', state: 'uploaded', digest: 'sha256:' + 'b'.repeat(64) }] }, 'github-manager', '0.1.0');
t('③e 资产名不符被拒', !aName.ok && aName.errors.some((x) => /产物/.test(x)));
const aTag = assetContract({ ...compliantAsset(), tag_name: 'v0.2.0' }, 'github-manager', '0.1.0');
t('③f tag 与 manifest.version 不一致被拒', !aTag.ok, aTag.errors.join('; '));
t('③g 空 release 判失败（判据不恒真）', !assetContract(null, 'github-manager').ok);
t('③h 元断言：不传 version 时跳过 tag 校验（老 release 仍可装）',
  assetContract({ ...compliantAsset(), tag_name: 'v9.9.9' }, 'github-manager').ok);

console.log('— ④ 接线层：联网探针真的遍历 13 仓 —');
const verifySrc = clean('scripts/verify-plugin-repos.mjs');
t('④a verify 导入了产物链契约模块',
  /release-chain-contract\.mjs/.test(verifySrc));
t('④b verify 真的遍历 PRODUCT_REPOS',
  /for\s*\([^)]*PRODUCT_REPOS/.test(verifySrc)
  || /PRODUCT_REPOS\s*\)/.test(verifySrc));
t('④c verify 调用了 workflowContract / assetContract',
  /workflowContract\(/.test(verifySrc) && /assetContract\(/.test(verifySrc));
t('④d 元断言：注释里提到 PRODUCT_REPOS 不算接线',
  !/PRODUCT_REPOS/.test(stripCommentsFlatJs('// for (const x of PRODUCT_REPOS) {}')));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
