/**
 * 链接名批量操作回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/link-agents-test.mjs，然后
 *         node plugins/project-group/link-agents-test.mjs
 *
 * 钉住 #64 恢复预设 / #65 全选-全不选 里最容易错的**键迁移**：
 * 恢复预设会把名字从"改名后的显示名"变回"原名"，
 * 而开关 / 备注 / 置顶的键都是显示名 —— 键不跟着迁的话，
 * 置顶会静默失效、备注会被 submit() 当成幽灵项丢掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = await loadTs(path.join(HERE, 'utils/linkAgents.ts'));
const { t, done } = makeT();

const { setAllEnabled, allEnabled, resetToPreset } = A;

console.log('\n=== 1. 全选 / 全不选（#65）===');
{
  const names = ['.a', '.b', '.c'];
  const r = setAllEnabled(names, {}, false);
  t('全不选：每项都写成 false', names.every((n) => r[n] === false), JSON.stringify(r));
  t('全不选后 allEnabled 为假', allEnabled(names, r) === false);
  const r2 = setAllEnabled(names, r, true);
  t('全选：每项都写成 true', names.every((n) => r2[n] === true), JSON.stringify(r2));
  t('全选后 allEnabled 为真', allEnabled(names, r2) === true);
}
{
  // 显式写值而非删键：不依赖"缺失即启用"这个默认值约定
  const r = setAllEnabled(['.a'], { '.a': false }, true);
  t('显式写 true（不靠删键）', r['.a'] === true && Object.keys(r).length === 1);
}
{
  t('空列表时 allEnabled 为假（不是真）', allEnabled([], {}) === false);
  t('部分启用 → allEnabled 为假', allEnabled(['.a', '.b'], { '.a': false }) === false);
  t('未记录的键按启用算', allEnabled(['.a'], {}) === true);
}
{
  // 不影响列表外的键
  const r = setAllEnabled(['.a'], { '.a': false, '.z': false }, true);
  t('不动列表外的键', r['.z'] === false, JSON.stringify(r));
}

console.log('\n=== 2. 恢复预设：名字回到原名 ===');
{
  const rows = [{ original: '.claude', shown: '.claude-x' }];
  const r = resetToPreset(rows, {
    renames: { '.claude': '.claude-x' },
    vendors: {}, remarks: {}, pinned: [], map: {},
  });
  t('清掉改名记录', !('.claude' in r.renames), JSON.stringify(r.renames));
  t('不改动自定义名（本例无）', true);
}
{
  // 没改名的行：只需清掉厂商覆盖
  const rows = [{ original: '.cursor', shown: '.cursor' }];
  const r = resetToPreset(rows, {
    renames: {},
    vendors: { '.cursor': 'Anysphere' },
    remarks: { '.cursor': '好物' },
    pinned: ['.cursor'],
    map: { '.cursor': false },
  });
  t('没改名也清掉厂商覆盖（回落预设值）', !('.cursor' in r.vendors), JSON.stringify(r.vendors));
  t('没改名时备注保留', r.remarks['.cursor'] === '好物');
  t('没改名时置顶保留', r.pinned.includes('.cursor'));
  t('没改名时开关保留', r.map['.cursor'] === false);
}

console.log('\n=== 3. 恢复预设：键必须跟着迁（核心）===');
{
  const rows = [{ original: '.claude', shown: '.claude-x' }];
  const r = resetToPreset(rows, {
    renames: { '.claude': '.claude-x' },
    vendors: { '.claude-x': '自定义厂商' },
    remarks: { '.claude-x': '这是备注' },
    pinned: ['.claude-x'],
    map: { '.claude-x': false },
  });
  t('备注迁到原名上（否则会被当幽灵项丢掉）',
    r.remarks['.claude'] === '这是备注', JSON.stringify(r.remarks));
  t('旧显示名上的备注已清除', !('.claude-x' in r.remarks));
  t('置顶迁到原名上（否则置顶静默失效）',
    r.pinned.includes('.claude'), JSON.stringify(r.pinned));
  t('置顶里不再有旧显示名', !r.pinned.includes('.claude-x'));
  t('开关迁到原名上', r.map['.claude'] === false, JSON.stringify(r.map));
  t('旧显示名上的开关已清除', !('.claude-x' in r.map));
  t('厂商是清掉而不是迁（回落到预设自带值）',
    !('.claude' in r.vendors) && !('.claude-x' in r.vendors));
}

console.log('\n=== 4. 恢复预设：置顶顺序保持不变 ===');
{
  const rows = [
    { original: '.a', shown: '.a-x' },
    { original: '.b', shown: '.b' },
    { original: '.c', shown: '.c-x' },
  ];
  const r = resetToPreset(rows, {
    renames: { '.a': '.a-x', '.c': '.c-x' },
    vendors: {}, remarks: {},
    pinned: ['.c-x', '.b', '.a-x'],
    map: {},
  });
  t('置顶顺序与项数都保持',
    JSON.stringify(r.pinned) === JSON.stringify(['.c', '.b', '.a']),
    JSON.stringify(r.pinned));
}

console.log('\n=== 5. 恢复预设：不产生重复键（幽灵名撞车）===');
{
  // 极端：把 .a 改名为 .b-x，而 .b 又被改名为 .b-x？这里构造改名后与另一原名撞车
  const rows = [
    { original: '.a', shown: '.shared' },
    { original: '.shared', shown: '.shared' },
  ];
  const r = resetToPreset(rows, {
    renames: { '.a': '.shared' },
    vendors: {},
    remarks: { '.shared': '谁的备注' },
    pinned: [],
    map: {},
  });
  t('撞车时不崩', typeof r === 'object');
  t('备注仍在（迁移后至少一个键上有值）',
    Object.keys(r.remarks).length >= 1, JSON.stringify(r.remarks));
}

console.log('\n=== 6. 恢复预设：空输入 ===');
{
  const r = resetToPreset([], { renames: {}, vendors: {}, remarks: {}, pinned: [], map: {} });
  t('无预设行时原样返回', Object.keys(r.renames).length === 0 && r.pinned.length === 0);
}
{
  const rows = [{ original: '.a', shown: '.a' }];
  const r = resetToPreset(rows, {
    renames: {}, vendors: {}, remarks: {}, pinned: [], map: {},
  });
  t('全默认状态调用不出错', r.pinned.length === 0);
}

console.log('\n=== 7. 不改动入参（纯函数）===');
{
  const rows = [{ original: '.a', shown: '.a-x' }];
  const inp = {
    renames: { '.a': '.a-x' },
    vendors: {},
    remarks: { '.a-x': '备注' },
    pinned: ['.a-x'],
    map: { '.a-x': false },
  };
  const snapshot = JSON.stringify(inp);
  resetToPreset(rows, inp);
  t('入参未被修改', JSON.stringify(inp) === snapshot, snapshot);
}


console.log('\n=== 反选（#96）===');
{
  const { invertEnabled, setAllEnabled, allEnabled } = await loadTs(
    path.join(HERE, 'utils/linkAgents.ts'));

  /* 关键：缺失键按"启用"处理 —— 直接 !map[n] 会反错 */
  t('缺失键视为启用 → 反选后为关闭',
    invertEnabled(['a'], {})['a'] === false);
  t('显式启用的 → 反选后关闭', invertEnabled(['a'], { a: true })['a'] === false);
  t('显式关闭的 → 反选后启用', invertEnabled(['a'], { a: false })['a'] === true);

  /* 不改动名单外的键 */
  {
    const m = invertEnabled(['a'], { a: true, z: false });
    t('名单外的键不受影响', m.z === false);
  }
  t('不改动原对象（返回新对象）', (() => {
    const orig = { a: true };
    invertEnabled(['a'], orig);
    return orig.a === true;
  })());

  /* 反两次回到原状 */
  {
    const m0 = { a: true, b: false };
    const m2 = invertEnabled(['a', 'b'], invertEnabled(['a', 'b'], m0));
    t('反两次回到原状', m2.a === m0.a && m2.b === m0.b);
  }
  /* 全选后反选 = 全不选 */
  {
    const names = ['a', 'b', 'c'];
    const all = setAllEnabled(names, {}, true);
    t('全选后反选 = 全不选',
      names.every((n) => invertEnabled(names, all)[n] === false));
  }
  /* 显式写值而非删键（与 setAllEnabled 同一原则） */
  t('显式写值（不删键）', 'a' in invertEnabled(['a'], {}));
}


/* 多个用例都要读这份源码，提到外面声明 ——
   放在某个块里的话，别的块引用会 ReferenceError。 */
const panel = fs.readFileSync(path.join(HERE, 'components/LinkPanel.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n=== #91 链接名大小写不敏感查重 ===');
{
  const { hasNameCI } = await loadTs(path.join(HERE, 'utils/linkAgents.ts'));
  const rs = fs.readFileSync(
    path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx', 'junction.rs'), 'utf8');

  /* 前端纯函数 */
  t('同名（同大小写）判重', hasNameCI(['.opencode'], '.opencode') === true);
  t('仅大小写不同也判重', hasNameCI(['.opencode'], '.OpenCode') === true);
  t('全大写也判重', hasNameCI(['.opencode'], '.OPENCODE') === true);
  t('不同名不误判', hasNameCI(['.opencode'], '.claude') === false);
  t('空名单返回 false', hasNameCI([], '.opencode') === false);
  t('两端空白不影响判定', hasNameCI(['.opencode'], '  .OpenCode  ') === true);

  /* 入口必须用这个守卫，不能回到精确比较 */
  t('入口用 hasNameCI', /hasNameCI\(allNames, name\)/.test(panel));
  t('入口不再用 includes 精确比较', !/allNames\.includes\(name\)/.test(panel));
  /* 提示要说清楚"不区分大小写"，否则用户以为是自己抄错了 */
  t('提示标明不区分大小写', /不区分大小写/.test(panel));

  /* 后端同样要保护：config.json 手写的名字不走前端入口 */
  t('后端 custom_names 用 eq_ignore_ascii_case',
    /x\.eq_ignore_ascii_case\(n\)/.test(rs));
  /* 写法是 `(*p).eq_ignore_ascii_case(n)`（PRESET_AGENTS 元素是 &&str，
     需先解一层）。断言别绑具体括号 —— 只确认"剔预设那行用了不敏感比较"。 */
  /* 用 `.*`（`.` 不跨行）而不是 `[^)]*`：源码里的闭包参数 `|(p, _)| (*p)`
     本身就含 `)`，`[^)]*` 匹配不过去。
     断言别绑具体括号 —— 只确认"剔预设那行用了不敏感比较"。 */
  t('后端剔预设也用 eq_ignore_ascii_case',
    /PRESET_AGENTS\.iter\(\)\.any\(.*eq_ignore_ascii_case\(n\)/.test(rs));
  t('后端合并时去重', /names\.iter\(\)\.any\(\|x\| x\.eq_ignore_ascii_case\(&n\)\)/.test(rs));
}

console.log('\n=== 8. 厂商标注与预设默认一致时不存（对齐原版 ApplyEdit）===');
{
  /* 有 vendorPick */
  t('提交走 vendorPick', /vendors: vendorPick\(vendors\),/.test(panel));
  t('有 vendorPick 定义', /const vendorPick = \(src: Record<string, string>\): Record<string, string> =>/.test(panel));
  /* 只剔除预设项：自定义项没有预设默认 */
  t('建预设厂商映射', /new Map\(presetRows\.map\(\(r\) => \[r\.shown, r\.vendor\]\)\)/.test(panel));
  t('预设为空则不剔除', /if \(pv && v === pv\) continue;/.test(panel));
  /* 边输边删会让受控输入框当场清空 —— 显示与刚输入的不符 */
  t('不在 onChange 里删', !/setVendors\(\(v\) => vendorSet/.test(panel));
  t('onChange 仍是直接写入',
    /setVendors\(\(v\) => \(\{ \.\.\.v, \[p\.shown\]: ev\.target\.value \}\)\)/.test(panel));
  /* 空值仍要剔除（否则 config 里留空串覆盖） */
  t('空值剔除', /if \(!v\) continue;/.test(panel));
}

console.log('\n=== 8. #100 「置顶」与「固定」是两个不同功能，不能统一术语 ★ ===');
{
  /*
   * 状态表原注写「当前统一用『置顶』（是有意的：原版术语混乱）」——
   * **这条注释本身是错的，两处都不成立**：
   *
   *   · 本版**并没有**统一用「置顶」：置顶归置顶（链接名排序），
   *     固定归固定（锁的账面固定），各用各的
   *   · 原版**也并不混乱**：回 `LinkAgentViewModel.cs` / `MainWindow.xaml.cs`
   *     核对，两者是**两个不同功能**，措辞一直分开
   *
   *     | 词 | 含义 | 原版出处 |
   *     |---|---|---|
   *     | 置顶 | 链接名排到列表最前 | AppConfig.cs「置顶的 agent 链接名列表」 |
   *     | 账面固定 | 锁的"仅登记、不落 ACL"档 | MainWindow.xaml.cs「账面固定 / 防删除 / 只读」|
   *
   * 所以这条判 ✅（本来就是对齐的），但**必须钉住**：
   * 哪天有人"统一术语"把两者合并，用户会看到锁的档位写着"置顶"——
   * 两个不同功能共用一个词，而界面上没有任何地方解释它们不是一回事。
   */
  /*
   * 本文件没有全局 `strip`（只有第 206 行一处就地 `.replace`），
   * 直接用会让整个套件 ReferenceError 挂掉 ——
   * 这是**第三次**踩同一个坑（watch-suppress / lock-preset / 本文件）。
   */
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
  const grid = strip(fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8'));
  const link = strip(fs.readFileSync(path.join(HERE, 'components/LinkPanel.tsx'), 'utf8'));

  /* 一、锁那边必须用「固定」（账面固定），不能用「置顶」 */
  const bi = grid.indexOf('fpx-badge pin');
  const bblk = grid.slice(Math.max(0, bi - 400), bi + 300);
  t('锁徽章用「账面固定」', /账面固定/.test(bblk));
  t('锁徽章没被写成「置顶」', !/置顶/.test(bblk), bblk.slice(-200));

  /* 二、链接名那边必须用「置顶」，不能用「固定」 */
  t('链接名排序用「置顶」', /置顶/.test(link));
  /*
   * 允许出现"固定在…"这类描述性短语吗？不允许：
   * 只要 LinkPanel 里出现「固定」二字，就容易和锁的档位混淆。
   * （原版在 LinkPanel 对应处也只用"置顶"。）
   */
  t('链接名那边没混进「固定」', !/固定/.test(link));

  /* 三、两个状态在 config 里是两个不同的键 */
  const types = strip(fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8'));
  /*
   * 键名核对（别写成猜的名字）：
   *   · `linkAgentsPinned` —— 链接名置顶清单（前端 config 字段）
   *   · `accountFixed` —— 卡片上的"账面固定"（types.ts:143）
   *   · `accountOnly` —— 后端 LockItem 的同义字段（types.ts:13）
   * 三者是**两个功能**：置顶是排序，固定是锁的档位。
   */
  t('config 里置顶键是 linkAgentsPinned', /linkAgentsPinned/.test(types));
  t('卡片上固定键是 accountFixed', /accountFixed/.test(types));
  t('后端 LockItem 上是 accountOnly', /accountOnly/.test(types));
  t('置顶与固定确实是两个不同的键', !/accountPinned|PinnedFixed/.test(types));
}

console.log('\n=== #354 置顶名大小写不敏感（同 #91 #204 #310）===');
{
  /*
   * 就地定义：本文件没有全局 `strip`（也没有 `RS`），
   * 直接引用的话是 ReferenceError、整个套件挂掉。
   * 这个坑已踩到第五次，每次都是"别的节里定义过"的错觉 ——
   * 那些是别的文件或局部作用域，不覆盖这里。
   */
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
  const la = strip(fs.readFileSync(path.join(HERE, 'utils/linkAgents.ts'), 'utf8'));
  const lp = strip(fs.readFileSync(path.join(HERE, 'components/LinkPanel.tsx'), 'utf8'));
  const jn = strip(fs.readFileSync(path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx/junction.rs'), 'utf8'));

  /*
   * 原版 `LinkAgentViewModel` 置顶相关四处全是 IgnoreCase：
   *   234: pinned.Contains(it.Name, StringComparer.OrdinalIgnoreCase)
   *   298/355: _config.LinkAgentsPinned.Contains(name, OrdinalIgnoreCase)
   *   356: RemoveAll(n => string.Equals(n, name, OrdinalIgnoreCase))
   *   379: FindIndex(n => string.Equals(n, oldName, OrdinalIgnoreCase))
   *
   * 与链接名查重（#91 / #204 / #310）同一约定：名字一律不区分大小写。
   *
   * 本版此前用 indexOf / includes / `p == name` 精确比较 ——
   * 配置里存的是旧大小写时置顶**静默失效**：不报错、列表也不乱，
   * 只是那一项不在最前面，用户只会以为"置顶没记住"。
   */

  /* 一、共享辅助函数确实忽略了大小写 */
  t('有 sameName（大小写不敏感）',
    /export function sameName\([\s\S]{0,160}toLowerCase\(\)/.test(la));
  t('有 pinIndexOf', /export function pinIndexOf\(/.test(la));
  t('pinIndexOf 走 sameName（不是 indexOf）',
    /return pinned\.findIndex\(\(x\) => sameName\(x, name\)\)/.test(la));

  /* 二、三个用到置顶名的地方都换了 */
  t('togglePin 用 pinIndexOf', /pinIndexOf\(p, n\) !== -1/.test(lp));
  t('togglePin 移除也走 sameName', /p\.filter\(\(x\) => !sameName\(x, n\)\)/.test(lp));
  t('排序用 pinIndexOf', /const pa = pinIndexOf\(pinned, nameOf\(a\.r\)\)/.test(lp));
  t('改名迁移用 pinIndexOf', /const i = pinIndexOf\(p, currentShown\)/.test(lp));

  /* 三、反面证据：不能残留精确比较 */
  /*
   * 只钉"存在 pinIndexOf"是漏报的 —— 下面那行 `p.indexOf` 若留在别处
   * 照样会让置顶失效。必须同时钉"旧的精确比较没有了"。
   */
  t('togglePin 不再用 includes（反面证据）',
    !/p\.includes\(n\) \? p\.filter/.test(lp));
  t('改名迁移不再用 indexOf（反面证据）',
    !/const i = p\.indexOf\(currentShown\)/.test(lp));

  /* 四、Rust 侧同样不敏感（后端排序与前端必须一致，否则两处结果不同） */
  t('Rust pin_rank 用 eq_ignore_ascii_case',
    /position\(\|p\| p\.trim\(\)\.eq_ignore_ascii_case\(n\)\)/.test(jn));
  t('Rust 不再用 p == name（反面证据）',
    !/position\(\|p\| p == name\)/.test(jn));
}

done();
