/**
 * 链接名「恢复预设 / 保存」的键迁移回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/link-preset-keep-test.mjs
 *
 * 钉的是 #354「置顶 / 备注 / 开关的键一律大小写不敏感」这条约定
 * **在落盘路径上**是否也成立。
 *
 * 背景：#354 原本修了四处（加 / 删 / 查 / 改名迁移），界面上置顶确实生效了
 * （sortByPin 用 pinIndexOf）。但**落盘**还有两条路没跟上：
 *   · resetToPreset() 迁键时用 `in` / `indexOf` 精确比 → 旧大小写不迁移；
 *   · submit() 的 pick() / keptPinned 用 `src[n]` / `includes` 精确取
 *     → 取不到就当成"幽灵项"整条丢掉。
 * 于是"界面上排在最前 / 备注好好的，保存完刷新就没了"，
 * 而日志仍写着「链接名设置已保存」—— 用户数据静默消失。
 *
 * 所以这里**跑真身**而不是断言"源码里有 sameName 这几个字"：
 * 后者证明不了旧大小写那份到底保不保得住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, stripTS, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = await loadTs(path.join(HERE, 'utils/linkAgents.ts'));
const { resetToPreset, pinIndexOf, sameName } = A;
const { t, done } = makeT();

const raw = fs.readFileSync(path.join(HERE, 'components/LinkPanel.tsx'), 'utf8');
/** 剥块注释：判"源码里有没有某个写法"时必须先剥，否则会被注释里的字样喂饱 */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '');

/** 按锚点配平大括号切片（剥注释后的源码，避免锚点落在注释里） */
function sliceFn(s, anchor) {
  const i = s.indexOf(anchor);
  if (i === -1) throw new Error('锚点未命中: ' + anchor);
  let d = 0, j = s.indexOf('{', i);
  if (j === -1) throw new Error('锚点后无 { : ' + anchor);
  for (let k = j; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) return s.slice(i, k + 1); }
  }
  throw new Error('大括号未配平: ' + anchor);
}

console.log('\n=== 1. resetToPreset：置顶键迁移（跑真身）===');
{
  // config 里 pinned 存的是旧大小写（手改过 config / 老版本迁移上来）。
  // 界面上 sortByPin 不敏感命中 → 确实排在最前；恢复预设必须把键迁到原名。
  const rows = [{ original: '.opencode', shown: '.OpenCode' }];
  const cur = {
    renames: { '.opencode': '.OpenCode' },
    vendors: {}, remarks: {}, pinned: ['.OPENCODE'], map: {},
  };
  const out = resetToPreset(rows, cur);
  t('旧大小写的置顶键会迁到原名', out.pinned[0] === '.opencode', JSON.stringify(out.pinned));
  t('迁移后按不敏感判据仍命中当前名', pinIndexOf(out.pinned, '.opencode') !== -1);
}

console.log('\n=== 2. resetToPreset：备注 / 开关 / 厂商键迁移（跑真身）===');
{
  const rows = [{ original: '.opencode', shown: '.OpenCode' }];
  const cur = {
    renames: { '.opencode': '.OpenCode' },
    vendors: { '.OPENCODE': '我改的厂商' },
    remarks: { '.OPENCODE': '我的备注' },
    pinned: [], map: { '.OPENCODE': false },
  };
  const out = resetToPreset(rows, cur);
  t('备注键迁到原名（不丢）', out.remarks['.opencode'] === '我的备注', JSON.stringify(out.remarks));
  t('开关键迁到原名（不丢）', out.map['.opencode'] === false, JSON.stringify(out.map));
  t('厂商覆盖被清掉（回落到预设自带）', !('.OPENCODE' in out.vendors) && !('.opencode' in out.vendors),
    JSON.stringify(out.vendors));
}

console.log('\n=== 3. submit：pick() 取备注（跑真身）===');
{
  /*
   * 从源码切出 submit 内的 pick，剥类型后真跑。
   * 注入 allNames / sameName —— 它们是 pick 的闭包变量。
   */
  const body = stripTS(sliceFn(src, 'const pick = (src'));
  const pick = new Function('sameName', 'allNames', `
    ${body}
    return pick;
  `)(sameName, ['.opencode', '.claude']);

  const r = pick({ '.OPENCODE': '我的备注' });
  t('旧大小写键的备注保住了（不是被当幽灵项丢掉）', r['.opencode'] === '我的备注', JSON.stringify(r));
  t('键写回当前显示名（顺带归一化旧大小写）', Object.keys(r).every((k) => k === '.opencode'), JSON.stringify(r));
  t('确实不在名字里的键仍被剔除（幽灵项照常丢）', pick({ '.ghost': 'x' })['.ghost'] === undefined);
  t('空值不落盘', Object.keys(pick({ '.opencode': '   ' })).length === 0);
}

console.log('\n=== 4. submit：keptPinned 过滤（跑真身）===');
{
  const line = src.split('\n').find((l) => l.includes('const keptPinned'));
  t('源码里能定位到 keptPinned', !!line, line ? line.trim() : '未找到');
  const expr = line.replace(/^\s*const keptPinned\s*=\s*/, '').replace(/;\s*$/, '');
  const keptPinned = new Function('sameName', 'allNames', 'pinned', `return (${expr});`)
    (sameName, ['.opencode', '.claude'], ['.OpenCode']);
  t('旧大小写的置顶不会被过滤掉', keptPinned.length === 1, JSON.stringify(keptPinned));
  t('界面判据与落盘判据一致（否则"看着置顶、保存没了"）',
    pinIndexOf(['.OpenCode'], '.opencode') !== -1 && keptPinned.length === 1);
  const ghost = new Function('sameName', 'allNames', 'pinned', `return (${expr});`)
    (sameName, ['.opencode'], ['.ghost']);
  t('真不在名字里的幽灵置顶照常剔除', ghost.length === 0, JSON.stringify(ghost));
}

console.log('\n=== 5. 结构：不得回到精确查键（均剥注释后判）===');
{
  const ua = fs.readFileSync(path.join(HERE, 'utils/linkAgents.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const resetBody = sliceFn(ua, 'export function resetToPreset');

  t('resetToPreset 不再用 `in map` 精确查键', !/shown\s+in\s+map\b/.test(resetBody));
  t('resetToPreset 不再用 `in remarks` 精确查键', !/shown\s+in\s+remarks\b/.test(resetBody));
  t('resetToPreset 不再用 pinned.indexOf 精确比', !/pinned\.indexOf\(/.test(resetBody));
  t('resetToPreset 用 pinIndexOf（不敏感）', /pinIndexOf\(pinned,\s*shown\)/.test(resetBody));

  const pickBody = sliceFn(src, 'const pick = (src');
  t('pick 不再用 src[n] 精确取', !/src\[n\]/.test(pickBody));
  t('pick 用 sameName 查键', /keys\.find\(\(x\)\s*=>\s*sameName\(x,\s*n\)\)/.test(pickBody));

  const vpBody = sliceFn(src, 'const vendorPick = (src');
  t('vendorPick 不再用 src[n] 精确取', !/src\[n\]/.test(vpBody));

  /*
   * 只钉 keptPinned 那一行本身，不能拿全文件判 ——
   * 改名查重那处（第 159 行）也写着 `allNames.includes(`，
   * 但它后面紧跟着 hasNameCI 不敏感兜底，是另一回事。
   * 全文件判会把合法的那处当成违规（或反过来被它喂饱）。
   */
  const kpLine = src.split('\n').find((l) => l.includes('const keptPinned')) || '';
  t('keptPinned 不再用 allNames.includes 精确比', !/allNames\.includes\(/.test(kpLine), kpLine.trim());
  t('keptPinned 用 sameName（与 sortByPin 同一判据）',
    /allNames\.some\(\(x\)\s*=>\s*sameName\(x,\s*n\)\)/.test(kpLine), kpLine.trim());
}

done();
