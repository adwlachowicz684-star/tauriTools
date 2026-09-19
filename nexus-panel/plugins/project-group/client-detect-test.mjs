/**
 * 客户端「刷新检测」回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/client-detect-test.mjs，然后
 *         node plugins/project-group/client-detect-test.mjs
 *
 * #48 的关键不在那个按钮，而在**结果怎么解读**：
 * 后端 detect() 在"一个都没检出"时会强制塞进 opencode 作为兜底。
 * 所以列表里出现 opencode 有两种可能 —— 真装了，或只是兜底。
 * 不分清楚就显示"检测到 1 个：opencode"，用户会以为自己装好了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const D = await loadTs(path.join(HERE, 'utils/clientDetect.ts'));
const { summarizeDetection, FALLBACK_CLIENT_ID } = D;

const C = (id, name, installed = true) => ({ id, name, installed });

console.log('\n=== 1. 兜底常量 ===');
t('兜底客户端是 opencode（与后端 detect 一致）', FALLBACK_CLIENT_ID === 'opencode');

console.log('\n=== 2. 正常检出 ===');
{
  const r = summarizeDetection([C('cursor', 'Cursor'), C('workbuddy', 'WorkBuddy')]);
  t('数量正确', r.count === 2, String(r.count));
  t('名字串用顿号连接', r.names === 'Cursor、WorkBuddy', r.names);
  t('无提示语', r.hint === '');
  t('不是"只剩兜底"', r.fallbackOnly === false);
}

console.log('\n=== 3. 一个都没检出 → 引导登记 ===');
{
  const r = summarizeDetection([]);
  t('数量为 0', r.count === 0);
  t('名字串为空', r.names === '');
  t('给出去登记自定义客户端的引导', /自定义客户端/.test(r.hint), r.hint);
  t('说明会退回到兜底项', /opencode/.test(r.hint));
  t('不是"只剩兜底"', r.fallbackOnly === false);
}

console.log('\n=== 4. 只剩兜底项 → 必须说清楚（核心）===');
{
  const r = summarizeDetection([C('opencode', 'opencode')]);
  t('数量为 1', r.count === 1);
  t('标记为"只剩兜底"', r.fallbackOnly === true);
  t('提示里点明这可能只是兜底', /兜底/.test(r.hint), r.hint);
  t('提示里点明"并非真的检测到"', /并非真的检测|而非真的/.test(r.hint), r.hint);
}
{
  /* 装了 opencode **还装了别的** → 不是兜底，不该有那条提示 */
  const r = summarizeDetection([C('opencode', 'opencode'), C('cursor', 'Cursor')]);
  t('opencode + 其它 → 不是兜底', r.fallbackOnly === false);
  t('opencode + 其它 → 无提示', r.hint === '');
}

console.log('\n=== 5. installed=false 的项不计入 ===');
{
  /* 后端 detect() 已过滤，但自定义客户端会带 installed:true 强制列出。
     这里守住"按 installed 过滤"这个语义，避免界面把未装的数进去 */
  const r = summarizeDetection([
    C('cursor', 'Cursor', true), C('kimi', 'Kimi', false), C('trae', 'Trae', true),
  ]);
  t('只数 installed 的', r.count === 2, String(r.count));
  t('名字串不含未安装的', !/Kimi/.test(r.names), r.names);
}
{
  const r = summarizeDetection([C('kimi', 'Kimi', false), C('trae', 'Trae', false)]);
  t('全是未安装 → 0 个', r.count === 0);
  t('全是未安装 → 走"一个都没检出"的引导', /自定义客户端/.test(r.hint));
}

console.log('\n=== 6. 健壮性 ===');
{
  t('null 输入不炸', summarizeDetection(null).count === 0);
  t('undefined 输入不炸', summarizeDetection(undefined).count === 0);
  const r = summarizeDetection([C('myai', '')]);
  t('名字缺失时回退到 id', r.names === 'myai', r.names);
}

console.log('\n=== 7. 界面接线 ===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8');
  t('有刷新检测按钮', /刷新检测/.test(dlg));
  t('有检测中状态（不是点了没反应）', /检测中…/.test(dlg));
  t('按钮走 api.chainClients', /await api\.chainClients\(\)/.test(dlg));
  t('检测结果用 summarizeDetection 渲染', /summarizeDetection\(detected\)/.test(dlg));
  t('默认不显示（初始为 null）',
    /useState<ChainClient\[\] \| null>\(null\)/.test(dlg));
  t('检测失败会记日志而不是静默', /检测失败/.test(dlg));
}

done();
