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

console.log('\n=== 4. 兜底项与"真装了"必须分开（核心）===');
{
  /* 真装了 opencode：installed 为 true，就是普通的一个检出项。
     早先按"总数恰为 1 且是 opencode"判成兜底，于是明明装了却被
     告知"这可能只是兜底，而非真的检测到它" —— 主动给出与事实相反的判断。 */
  const r = summarizeDetection([C('opencode', 'opencode', true)]);
  t('真装了 → 数量为 1', r.count === 1);
  t('真装了 → 不算"只剩兜底"', r.fallbackOnly === false);
  t('真装了 → 不显示兜底告警', r.hint === '', r.hint);
  t('真装了 → 名字正常列出', r.names === 'opencode', r.names);
}
{
  /* 后端 detect() 一个都没检出时塞进来的兜底项，installed 为 false。
     这才是真正要说清楚"并非真的检测到它"的场景。 */
  const r = summarizeDetection([C('opencode', 'opencode', false)]);
  t('真兜底 → 数量为 0', r.count === 0);
  t('真兜底 → 标记为"只剩兜底"', r.fallbackOnly === true);
  t('真兜底 → 提示里点明这只是兜底', /兜底/.test(r.hint), r.hint);
  t('真兜底 → 提示里点明"并非真的检测到"', /并非真的检测/.test(r.hint), r.hint);
  t('真兜底 → 仍给出登记引导', /自定义客户端/.test(r.hint), r.hint);
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

console.log('\n=== 8. 内置 id 镜像（与 chain.rs::CLIENTS 一致）===');
{
  const rsPath = path.join(HERE, '../../src-tauri/src/fpx/chain.rs');
  const rs = fs.readFileSync(rsPath, 'utf8');
  const m = rs.match(/pub const CLIENTS: &\[\(&str, &str, &str\)\] = &\[([\s\S]*?)\n\];/);
  t('抓到 chain.rs 的 CLIENTS 表', !!m);
  const ids = [];
  const re = /\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g;
  let x;
  while ((x = re.exec(m[1])) !== null) ids.push(x[1]);
  const mirror = D.BUILTIN_CLIENT_IDS;
  t('前端有内置 id 镜像', Array.isArray(mirror) && mirror.length > 0);
  t('数量一致', mirror.length === ids.length, `${mirror.length} vs ${ids.length}`);
  t('逐个 id 同序一致', mirror.join(',') === ids.join(','), `${mirror.join(',')} | ${ids.join(',')}`);
}

console.log('\n=== 9. 重名判定（重名项会被后端静默忽略）===');
{
  const f = D.isBuiltinClientId;
  t('有重名判定函数', typeof f === 'function');
  t('cursor 是内置 id', f('cursor') === true);
  t('opencode 是内置 id', f('opencode') === true);
  t('myai 不是内置 id', f('myai') === false);
  t('空串不是内置 id', f('') === false);
  t('两端空白先 trim 再比', f('  cursor  ') === true);
  /* 后端是 `x.id == id` 精确比较，前端必须同规则：写成不敏感会把 Cursor 拦下 */
  t('大小写敏感（后端精确比较，Cursor 不是内置 id）', f('Cursor') === false);
}

console.log('\n=== 10. 登记弹窗：重名要拦、保存后要回传 ===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/ChainClientsDialog.tsx'), 'utf8');
  const sd = fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8');
  const st = fs.readFileSync(path.join(HERE, 'Settings.tsx'), 'utf8');

  t('保存前查重名（isBuiltinClientId）', /isBuiltinClientId\(id\)/.test(dlg));
  /* 只钉代码里的文案：上面那句说明注释里也有"与内置客户端重名"，
     按字面量匹配会在整段校验被删掉时照样通过（注释还在） */
  t('重名时报错并说明后果', /请换一个标识/.test(dlg));
  t('重名时 return，不发请求', /setErr\(`「\$\{id\}」与内置客户端重名/.test(dlg));
  t('保存成功后回传最新列表', /onSaved\?\.\(shown\)/.test(dlg));

  /* 不回传则外层 config 不刷新，下次打开拿到旧清单，
     再保存一次会整份覆盖掉先前登记的客户端 —— 静默丢数据 */
  t('设置页收到回传后刷新检测汇总', /setDetected\(shown\)/.test(sd));
  t('设置页收到回传后触发 reload', /onChainClientsChanged\?\.\(\)/.test(sd));
  t('外层真的接了 reload', /onChainClientsChanged=\{\(\) => void load\(\)\}/.test(st));
  t('自定义动作那一路同样接上了', /onChainActionsChanged=\{\(\) => void load\(\)\}/.test(st));
}


done();
