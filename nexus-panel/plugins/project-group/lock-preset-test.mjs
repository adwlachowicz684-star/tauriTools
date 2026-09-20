/**
 * ACL 预设档位回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/lock-preset-test.mjs
 *
 * #22 的核心不是"多了几个按钮"，而是**档位 = 整体设置，不是叠加**。
 * 若做成叠加，从「防删除」切到「防写入」会变成两个都开 ——
 * 用户以为切了档，实际保护越来越重，而界面上看不出来（两个框都勾着）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const U = await loadTs(path.join(HERE, 'utils/lockPresets.ts'));
const { LOCK_PRESETS, CUSTOM_PRESET_ID, presetOf, applyPreset } = U;

console.log('\n=== 1. 档位表 ===');
t('共 5 档', LOCK_PRESETS.length === 5, `${LOCK_PRESETS.length} 档`);
t('id 不重复', new Set(LOCK_PRESETS.map((p) => p.id)).size === 5);
t('组合不重复',
  new Set(LOCK_PRESETS.map((p) => `${p.denyDelete}/${p.denyWrite}/${p.accountOnly}`)).size === 5);
t('每档都有中文名', LOCK_PRESETS.every((p) => p.label && /[一-龥]/.test(p.label)));
t('每档都有说明', LOCK_PRESETS.every((p) => p.hint));
/* 顺序按保护强度递增：无 → 防删 → 防写 → 全保护 */
t('顺序按强度递增（固定排在最后，它是最轻的）',
  LOCK_PRESETS.map((p) => p.id).join(',') === 'none,delete,write,full,account',
  LOCK_PRESETS.map((p) => p.id).join(','));

console.log('\n=== 2. presetOf：开关 → 档位 ===');
t('都关 → none', presetOf(false, false, false) === 'none');
t('仅防删 → delete', presetOf(true, false, false) === 'delete');
t('仅防写 → write', presetOf(false, true, false) === 'write');
t('都开 → full', presetOf(true, true, false) === 'full');
t('仅账面固定 → account', presetOf(false, false, true) === 'account');
/* 固定 + 上锁：两者互不排斥，不属于任何档位 */
t('固定 + 防删 → custom（组合未预设）', presetOf(true, false, true) === CUSTOM_PRESET_ID);
/* 兜底：将来加了第三个开关时不至于乱认档位 */
t('兜底值存在', typeof CUSTOM_PRESET_ID === 'string' && CUSTOM_PRESET_ID === 'custom');

console.log('\n=== 3. applyPreset：档位 → 开关（**整体设置**）===');
/* 关键：切档必须清掉档外选项，不是叠加 */
{
  const a = applyPreset('write');
  t('切到「防写入」= 防删关掉、防写开', a.denyDelete === false && a.denyWrite === true);
  const b = applyPreset('delete');
  t('切到「防删除」= 防删开、防写关掉', b.denyDelete === true && b.denyWrite === false);
  const c = applyPreset('none');
  t('切到「无保护」= 两个都关（可解除全部）',
    c.denyDelete === false && c.denyWrite === false);
  const d = applyPreset('full');
  t('切到「完全保护」= 两个都开', d.denyDelete === true && d.denyWrite === true);
  const e = applyPreset('account');
  t('切到「账面固定」= 两个 ACL 都关、accountOnly 开',
    e.denyDelete === false && e.denyWrite === false && e.accountOnly === true);
  const f = applyPreset('none');
  t('切到「无保护」也会清掉固定', f.accountOnly === false);
}
t('未知档位返回 null（不静默变成一个档）', applyPreset('nope') === null);

console.log('\n=== 4. 往返一致 ===');
for (const p of LOCK_PRESETS) {
  const r = applyPreset(p.id);
  t(`${p.label}：apply 后能认回同一档`,
    presetOf(r.denyDelete, r.denyWrite, r.accountOnly) === p.id);
}

console.log('\n=== 5. 界面接线 ===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/dialogs.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const cssNC = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  t('弹窗渲染档位按钮', /LOCK_PRESETS\.map/.test(dlg));
  /* 档位必须由开关推导，不能另存 state —— 存了就会漂移 */
  t('档位由开关推导（presetOf）', /presetOf\(dd, dw, ao\)/.test(dlg));
  t('没有另设 preset state', !/useState<[^>]*>\(cur\)/.test(dlg));
  /* 点档位走 applyPreset（整体设置） */
  t('点档位走 applyPreset', /applyPreset\(id\)/.test(dlg));
  /* 手动勾框也要能脱离档位 —— 不能只让档位改框、框不能改档位 */
  t('手动勾框仍改开关', /onChange=\{setDd\}/.test(dlg) && /onChange=\{setDw\}/.test(dlg));

  /* 选中态用内凹（与页签一致），不用强调色填底 */
  t('选中档位用内凹', /\.fpx-lock-preset\.active[\s\S]{0,120}?sh-in/.test(cssNC));
  t('档位按钮有常态外凸', /\.fpx-lock-preset\s*\{[^}]*sh-out-sm/.test(cssNC));
  /* 取消/应用按钮仍在，档位不替代它们（应用仍需显式确认） */
  t('仍保留应用按钮', /onApply\(dd, dw, ao\)/.test(dlg));
  t('仍保留取消按钮', /onClick=\{onClose\}[^>]*>取消/.test(dlg));
}


console.log('\n=== #23 弹窗内监控告警开关 ===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/dialogs.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const host = fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /* 必须是可选参数：弹窗在没有监控上下文的地方也能复用 */
  t('参数为可选（watchEnabled?）', /watchEnabled\?: boolean/.test(dlg));
  t('回调为可选（onWatchChange?）', /onWatchChange\?: \(on: boolean\) => void/.test(dlg));
  /* 不传就不渲染 —— 不能渲染一个点了没用的开关 */
  t('没回调时不渲染', /\{onWatchChange && \(/.test(dlg));

  /* 走 updateConfig 而不是 setLock：保护与监控是两件事，
     混进同一次调用会让一个操作产生两种语义 */
  t('宿主用 updateConfig', /onWatchChange=\{\(on\) => s\.updateConfig/.test(host));
  t('宿主没把它塞进 onApply', host.indexOf('onApply={(dd, dw) => s.setLock') < host.indexOf('onWatchChange='));
  /* 初值来自全局配置，不是另起一份状态 */
  t('初值取全局配置', /watchEnabled=\{boot\.config\.watchEnabled\}/.test(host));
}


console.log('\n=== #21 账面固定（与 ACL 是两件事）===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/dialogs.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const host = fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const grid = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rs = fs.readFileSync(
    path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx', 'mod.rs'), 'utf8');
  const app7 = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');

  /* 弹窗：独立勾选项，且与两个 ACL 档位互不排斥 */
  t('弹窗有固定勾选项', /title="账面固定（仅登记，不设系统权限）"/.test(dlg));
  t('勾选后走 setAo', /onChange=\{setAo\}/.test(dlg));
  t('应用时三参一起传', /onApply\(dd, dw, ao\)/.test(dlg));
  t('宿主传 accountOnly', /onApply=\{\(dd, dw, ao\) => s\.setLock/.test(host));
  t('宿主初值取卡片字段', /accountOnly=\{dialog\.card\.accountFixed\}/.test(host));

  /* 后端：Option 而不是 bool —— 旧调用方不带参数不能报错 */
  t('命令参数是 Option<bool>', /account_only: Option<bool>/.test(rs));
  t('用 unwrap_or(false) 兜底', /account_only\.unwrap_or\(false\)/.test(rs));
  /* **从 ACL 切回固定时，原 ACL 必须真的撤掉** ——
     否则系统仍拦着，界面却显示"仅固定"，用户照着界面去删会撞上隐形权限 */
  t('切回固定时会撤掉原 ACL', /if want_acl \|\| prev/.test(rs));
  t('无 ACL 且非固定时不记录（不留空条目）',
    /if want_acl \|\| account_only \{/.test(rs));

  /* #84 / #128 锁与盾牌互斥 */
  t('有 ACL 显示盾牌 🛡', /🛡/.test(grid));
  t('仅固定显示小锁 🔒', /🔒/.test(grid));
  t('两者互斥（三元，不会同显）',
    /c\.locked \? \([\s\S]{0,200}?c\.accountFixed \?/.test(grid));
  /* 盾牌的 title 要说清是 ACL（硬保护） */
  t('盾牌 title 标明 ACL', /title="ACL 已保护/.test(grid));
  t('小锁 title 标明无系统权限', /title="账面固定（仅登记，无系统权限）"/.test(grid));

  /* 前端类型与后端字段都要有（跨端一致由 cross-end-check 兜） */
  t('types.ts 有 accountFixed', /accountFixed\?: boolean/.test(
    fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8')));
  t('LockItem 有 accountOnly', /accountOnly\?: boolean/.test(
    fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8')));
}

done();
