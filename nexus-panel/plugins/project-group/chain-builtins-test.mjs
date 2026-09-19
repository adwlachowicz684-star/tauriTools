/**
 * 内置连锁动作默认值回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/chain-builtins-test.mjs，然后
 *         node plugins/project-group/chain-builtins-test.mjs
 *
 * 覆盖 #46 开发者模式 / #47 恢复默认：
 *   · 前后端 BUILTIN 表同数同序同值（漂移护栏）
 *   · 内置动作默认不可删、开发者模式下可删；自定义随时可删
 *   · 恢复默认：内置回出厂值，自定义回 🧩
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const { t, done } = makeT();

const B = await loadTs(path.join(HERE, 'utils/chainBuiltins.ts'));
const {
  BUILTIN_ACTIONS, CUSTOM_DEFAULT_ICON, defaultIconOf, defaultNameOf, canRemove, canRename,
} = B;

console.log('\n=== 1. 内置表本身 ===');
t('四条内置动作', BUILTIN_ACTIONS.length === 4, `${BUILTIN_ACTIONS.length} 条`);
t('id 无重复',
  new Set(BUILTIN_ACTIONS.map((x) => x.id)).size === BUILTIN_ACTIONS.length);
t('每条都有名字与图标',
  BUILTIN_ACTIONS.every((x) => x.name.trim() && x.icon.trim()));
t('自定义默认图标是 🧩', CUSTOM_DEFAULT_ICON === '🧩');
t('内置图标不与自定义默认图标撞车',
  !BUILTIN_ACTIONS.some((x) => x.icon === CUSTOM_DEFAULT_ICON));

console.log('\n=== 2. 与后端 chain.rs::BUILTIN 同数同序同值（漂移护栏）===');
{
  const rsPath = path.join(ROOT, 'src-tauri/src/fpx/chain.rs');
  if (!fs.existsSync(rsPath)) {
    console.log('（跳过：未找到 chain.rs）');
  } else {
    const rs = fs.readFileSync(rsPath, 'utf8');
    const m = rs.match(/pub const BUILTIN: &\[\(&str, &str, &str\)\] = &\[([\s\S]*?)\n\];/);
    t('能解析后端 BUILTIN', !!m);
    if (m) {
      const rsList = [];
      const re = /\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g;
      let x;
      while ((x = re.exec(m[1])) !== null) rsList.push({ id: x[1], name: x[2], icon: x[3] });
      t('条数一致（4）', rsList.length === BUILTIN_ACTIONS.length,
        `后端 ${rsList.length} / 前端 ${BUILTIN_ACTIONS.length}`);
      t('顺序与值完全一致',
        JSON.stringify(rsList) === JSON.stringify(BUILTIN_ACTIONS.map((b) => ({
          id: b.id, name: b.name, icon: b.icon,
        }))),
        JSON.stringify(rsList));
    }
  }
}

console.log('\n=== 3. 恢复默认：图标 ===');
for (const b of BUILTIN_ACTIONS) {
  t(`${b.name} → 默认图标 ${b.icon}`, defaultIconOf(b.id) === b.icon, defaultIconOf(b.id));
}
t('自定义动作 → 🧩', defaultIconOf('') === '🧩');
t('自定义动作（null）→ 🧩', defaultIconOf(null) === '🧩');
t('未知 builtin 也回退 🧩（不返回 undefined）',
  defaultIconOf('nope') === '🧩', String(defaultIconOf('nope')));

console.log('\n=== 4. 恢复默认：名称 ===');
t('内置能取到默认名', defaultNameOf('chain') === '自由任务', defaultNameOf('chain'));
t('自定义没有"默认名" → 空串（界面据此不显示该按钮）',
  defaultNameOf('') === '');
t('未知 builtin → 空串', defaultNameOf('nope') === '');

console.log('\n=== 5. 删除权限（#46 核心）===');
t('内置动作默认不可删', canRemove('chain', false) === false);
t('内置动作在开发者模式下可删', canRemove('chain', true) === true);
t('自定义动作不需要开发者模式也能删', canRemove('', false) === true);
t('自定义动作在开发者模式下照样能删', canRemove('', true) === true);
t('空字符串 builtin 视为自定义', canRemove('   ', false) === true);
t('null builtin 视为自定义', canRemove(null, false) === true);
t('改名始终允许（内置也可改名）', canRename() === true);
{
  /* 穷举：四条内置在任何 devMode 下都要符合"关=不可删、开=可删" */
  let bad = 0;
  for (const b of BUILTIN_ACTIONS) {
    if (canRemove(b.id, false) !== false) bad++;
    if (canRemove(b.id, true) !== true) bad++;
  }
  t('穷举：四条内置的行为都正确', bad === 0, `异常 ${bad} 例`);
}

console.log('\n=== 6. 界面接线 ===');
{
  const panel = fs.readFileSync(path.join(HERE, 'components/ChainActionsPanel.tsx'), 'utf8');
  const settings = fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8');
  t('面板收 devMode 参数', /devMode/.test(panel));
  t('删除判定走 canRemove（不各写一遍）',
    /canRemove\(t\.builtin, devMode\)/.test(panel));
  t('删除按钮的显示也走 canRemove', /canRemove\(cur\.builtin, devMode\)/.test(panel));
  t('设置页把 devMode 传进动作面板', /devMode=\{config\.devMode\}/.test(settings));
  t('设置页有开发者模式勾选项', /开发者模式/.test(settings));
  /* 截取「图标」字段那一段来查，而不是全局搜"恢复默认" ——
     名称区也有一个同名按钮，全局匹配分不清到底哪个区有 */
  const iconSeg = panel.slice(
    panel.indexOf('>图标<'),
    panel.indexOf('fpx-emojis', panel.indexOf('>图标<')),
  );
  t('图标区有恢复默认', iconSeg.length > 0 && /恢复默认/.test(iconSeg),
    `区段 ${iconSeg.length} 字符`);
  t('图标区的恢复默认用的是 defaultIconOf', /defaultIconOf/.test(iconSeg));
  t('名称区用 defaultNameOf 决定是否显示恢复按钮',
    /defaultNameOf\(cur\.builtin\) &&/.test(panel));
}

console.log('\n=== 7. 后端 devMode 字段 ===');
{
  const modelPath = path.join(ROOT, 'src-tauri/src/fpx/model.rs');
  if (!fs.existsSync(modelPath)) {
    console.log('（跳过：未找到 model.rs）');
  } else {
    const rs = fs.readFileSync(modelPath, 'utf8');
    t('Rust 有 dev_mode 字段', /pub dev_mode: bool/.test(rs));
    t('有 serde default（老配置缺字段不炸）',
      /#\[serde\(default\)\]\s*\n\s*pub dev_mode: bool/.test(rs));
    t('Default 里为 false（默认关）', /dev_mode: false/.test(rs));
  }
  const tsPath = path.join(HERE, 'types.ts');
  t('前端 types 有 devMode', /devMode: boolean/.test(fs.readFileSync(tsPath, 'utf8')));
}

done();
