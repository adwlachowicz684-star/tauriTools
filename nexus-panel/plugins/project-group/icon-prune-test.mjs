/**
 * 预设图标清理回归测试（#12，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/icon-prune-test.mjs
 *
 * #12 最容易做错的两点：
 *   1. 只清当前组 → 用户以为清完了，切到别的组还有破图
 *   2. 把"探测失败/网络抖动"当成"文件不存在" → 一次抖动清空整个图标库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const {
  staleByList, staleByProbe, pruneGroups, totalRemoved,
} = await loadTs(path.join(HERE, 'utils/iconGroups.ts'));

const G = (name, icons) => ({ name, icons });

console.log('\n=== 1. 按清单判定失效（staleByList）===');
{
  const groups = [G('默认', ['ai', '已删除的图标', '上传']), G('分组2', ['ai', '另一个没了'])];
  const stale = staleByList(groups, ['ai', '上传']);
  t('找出 2 个失效项', stale.length === 2, stale.join(','));
  t('清单里的不算失效', !stale.includes('ai') && !stale.includes('上传'));
  t('未分组重复的不重复计入',
    staleByList([G('a', ['x']), G('b', ['x'])], []).length === 1);
  t('都有效时返回空', staleByList([G('a', ['ai'])], ['ai']).length === 0);
  t('空分组返回空', staleByList([], ['ai']).length === 0);
}

console.log('\n=== 2. 文件探测（staleByProbe）===');
{
  const only = new Set(['没了']);
  const load = async (n) => !only.has(n);
  const r = await staleByProbe(['ai', '没了', '上传'], load);
  t('探测出失效的那一个', r.length === 1 && r[0] === '没了', r.join(','));

  /* **抛异常 ≠ 文件不存在** —— 把网络抖动当成失效会清空整个图标库。
     这比留着几张破图严重得多。 */
  const boom = async () => { throw new Error('网络抖动'); };
  const r2 = await staleByProbe(['ai', '上传'], boom);
  t('加载抛异常时不判为失效（防误删）', r2.length === 0, r2.join(','));

  const allFail = async () => false;
  const r3 = await staleByProbe(['a', 'b'], allFail);
  t('明确加载失败才判失效', r3.length === 2);
  t('空名单返回空', (await staleByProbe([], allFail)).length === 0);
}

console.log('\n=== 3. 清理（pruneGroups）===');
{
  const groups = [G('默认', ['ai', 'x', '上传']), G('分组2', ['x', 'y']), G('分组3', ['ai'])];
  const { groups: next, removed } = pruneGroups(groups, ['x']);
  t('清掉第 1 组的 1 个', removed[0] === 1 && next[0].icons.join(',') === 'ai,上传');
  t('清掉第 2 组的 1 个', removed[1] === 1 && next[1].icons.join(',') === 'y');
  /* **跨全部分组清理**，不只当前组 */
  t('第 3 组没失效的不动', removed[2] === 0 && next[2].icons.join(',') === 'ai');
  t('总数正确', totalRemoved(removed) === 2);
  /* 保留顺序（不能打乱剩下的） */
  t('保留剩余顺序', next[0].icons[0] === 'ai' && next[0].icons[1] === '上传');
  t('组名不变', next.map((g) => g.name).join(',') === '默认,分组2,分组3');
  /* 失效名单为空时不改动 */
  const same = pruneGroups(groups, []);
  t('空名单不改任何组', same.groups[0].icons.length === 3 && totalRemoved(same.removed) === 0);
  t('totalRemoved 空数组为 0', totalRemoved([]) === 0);
}

console.log('\n=== 4. 界面接线 ===');
{
  const grid = fs.readFileSync(path.join(HERE, 'components/PresetIconGrid.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  t('有清理按钮', /清理失效/.test(grid));
  /* 只在真的存了分组时才显示 —— 默认组是动态生成的，硬清会清出 0 项 */
  t('默认组（无存储分组）时不显示', /\{hasStoredGroups && \(/.test(grid));
  t('hasStoredGroups 取自 groups.length', /groups\.length > 0/.test(grid));

  /* 两路判据都要有 */
  t('有清单判据', /staleByList\(effective, PRESET_ICON_NAMES\)/.test(grid));
  t('有文件探测判据', /staleByProbe\(/.test(grid));

  /* **没有失效项要明确说**，不能静默 */
  t('无失效项时明确提示', /'没有失效项'/.test(grid));

  /* 清理前确认，且列出名字 */
  t('清理前确认', /confirm\(\{[\s\S]{0,200}?title: '清理失效项'/.test(grid));
  t('确认里列出失效名字', /all\.slice\(0, 8\)\.join/.test(grid));
  t('确认里说明各组分摊', /detail/.test(grid));
  /* 提示报出清理数量 */
  t('日志报出数量', /已清理 \$\{totalRemoved\(removed\)\} 个失效项/.test(grid));

  /*
   * **探测整体失效 ≠ "文件全没了"**。
   *
   * `img.onerror` 分不清 404 与"加载失败"（网络抖动 / 沙箱限制 /
   * 后端图标接口没起来），两者都走 onerror；而 `staleByProbe` 那个
   * try/catch 挡的是 throw，这里 onerror 是 resolve(false)，挡不住。
   * PRESET_ICON_NAMES 是**随插件打包**的内置图标，不可能整批消失 ——
   * "全部探测失败"只可能是探测链路坏了。照原样去确认清理，
   * 会把整组内置图标清空（一次抖动清空整个图标库）。
   */
  t('判定探测是否整体失效',
    /probeTargets\.length > 0 && byProbe\.length === probeTargets\.length/.test(grid));
  t('探测失效时不采信探测结果', /probeBroken \? \[\] : byProbe/.test(grid));
  t('all 用 staleFromProbe', /const all = \[\.\.\.byList, \.\.\.staleFromProbe\]/.test(grid));
  {
    /* 反面证据：all 这一行不得再直接吃 byProbe（注释已剥，只认代码） */
    const allLine = grid.split('\n').find((l) => l.includes('const all =')) ?? '';
    t('all 不再直接用 byProbe', allLine.length > 0 && !allLine.includes('byProbe'), allLine.trim());
  }
  /* 探测坏了要说出来，不能静默当成"没有失效项" */
  t('探测失效时明确报错', /探测未成功/.test(grid));
  t('无失效项与探测失败文案分开',
    /probeBroken \? '探测未成功，未清理任何项' : '没有失效项'/.test(grid));

  /* 用 Image() 探测而不是 fetch —— 显示用的就是 img，判定口径一致 */
  t('用 Image 探测', /new Image\(\)/.test(grid));
  t('onerror 才算失效', /img\.onerror = \(\) => resolve\(false\)/.test(grid));
}

done();
