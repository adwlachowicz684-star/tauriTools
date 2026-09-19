/**
 * 备份目录设置入口回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/backup-dirs-test.mjs，然后
 *         node plugins/project-group/backup-dirs-test.mjs
 *
 * #595：三个备份目录字段（backupDir / backupProjectDir / backupGroupDir）
 * 在 config 与后端里**早就有**，但设置页此前只有两个「打开」按钮、没有输入框，
 * 想分别指定只能手改 config.json —— 与 #49 是同一类缺口（后端齐了，缺界面）。
 *
 * 这里守三件事：
 *   · 三个目录行都接上了（含"浏览"的落点分支）
 *   · 保存时**空串写 null**（后端按"未设置"处理；写空串会被当成有效路径）
 *   · 界面上的顺序说明与后端 resolve_dir 的优先级一致
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const { t, done } = makeT();

const dlg = fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8');
const types = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');

console.log('\n=== 1. 三个字段在 config 里 ===');
for (const f of ['backupDir', 'backupProjectDir', 'backupGroupDir']) {
  t(`types.ts 有 ${f}`, new RegExp(`\\b${f}\\b`).test(types));
}

console.log('\n=== 2. 设置页有三个可编辑的目录行 ===');
{
  /* dirRow 调用：('标签', 值, set值, 'which', '提示') */
  const rows = [...dlg.matchAll(/dirRow\(\s*'([^']*)',\s*(\w+),\s*(set\w+),\s*'(\w+)',/g)];
  t('dirRow 调用共 6 处（新建3 + 备份3）', rows.length === 6, `${rows.length} 处`);

  const byWhich = Object.fromEntries(rows.map((m) => [m[4], { label: m[1], val: m[2], set: m[3] }]));
  t('备份根目录行存在（bu）', !!byWhich.bu, byWhich.bu?.label);
  t('项目备份目录行存在（bp）', !!byWhich.bp, byWhich.bp?.label);
  t('项目组备份目录行存在（bg）', !!byWhich.bg, byWhich.bg?.label);

  t('bu 绑到 backupDir', byWhich.bu?.val === 'backupDir' && byWhich.bu?.set === 'setBackupDir');
  t('bp 绑到 backupProjectDir',
    byWhich.bp?.val === 'backupProjectDir' && byWhich.bp?.set === 'setBackupProjectDir');
  t('bg 绑到 backupGroupDir',
    byWhich.bg?.val === 'backupGroupDir' && byWhich.bg?.set === 'setBackupGroupDir');

  /* 值要来自 config，否则改完再打开设置页会看到空白 —— 像是没保存成功 */
  t('初值取自 config（不是空串写死）',
    /useState\(config\.backupDir \?\? ''\)/.test(dlg)
    && /useState\(config\.backupProjectDir \?\? ''\)/.test(dlg)
    && /useState\(config\.backupGroupDir \?\? ''\)/.test(dlg));
}

console.log('\n=== 3. 浏览按钮的落点分支齐全 ===');
{
  /* dirPicker 的类型要把新增的三个值加进去，否则 TS 直接报错 */
  t("dirPicker 类型含 'bu' | 'bp' | 'bg'",
    /'cp' \| 'cg' \| 'gt' \| 'bu' \| 'bp' \| 'bg'/.test(dlg));
  t('dirRow 的 which 参数类型同步扩充',
    /which: 'cp' \| 'cg' \| 'gt' \| 'bu' \| 'bp' \| 'bg',/.test(dlg));
  for (const [w, setter] of [['bu', 'setBackupDir'], ['bp', 'setBackupProjectDir'], ['bg', 'setBackupGroupDir']]) {
    t(`onPick 处理 ${w} → ${setter}`,
      new RegExp(`dirPicker === '${w}'\\) ${setter}\\(`).test(dlg));
  }
  /* 六个分支都要覆盖到，缺一个就是"点了浏览没反应" */
  const branches = (dlg.match(/dirPicker === '/g) || []).length;
  t('onPick 分支共 5 个 if + 1 个 else（覆盖 6 个 which）',
    branches === 5, `${branches} 个`);
}

console.log('\n=== 4. 保存：空串写 null ===');
{
  for (const f of ['backupDir', 'backupProjectDir', 'backupGroupDir']) {
    const re = new RegExp(`${f}:\\s*${f.replace(/^./, (c) => c)}?\\w*\\.trim\\(\\) \\|\\| null`);
    t(`${f} 保存时 trim() || null`, re.test(dlg), re.test(dlg) ? '' : '未找到');
  }
  /* 必须都进同一个 save()，否则"改了但只有一部分生效" */
  const saveBody = dlg.slice(dlg.indexOf('await onSaved({'), dlg.indexOf('});', dlg.indexOf('await onSaved({')));
  t('三行都在主 save() 的 patch 里',
    ['backupDir:', 'backupProjectDir:', 'backupGroupDir:'].every((k) => saveBody.includes(k)));
  t('save() 里也带了 appendOnly / autoMinutes（备份设置是一组）',
    /backupAppendOnly/.test(saveBody) && /backupAutoMinutes/.test(saveBody));
}

console.log('\n=== 5. 与后端 resolve_dir 的优先级一致 ===');
{
  const rsPath = path.join(ROOT, 'src-tauri/src/fpx/backup.rs');
  if (!fs.existsSync(rsPath)) {
    console.log('（跳过：未找到 backup.rs）');
  } else {
    const rs = fs.readFileSync(rsPath, 'utf8');
    const fn = rs.slice(rs.indexOf('pub fn resolve_dir'), rs.indexOf('pub fn collect_paths'));
    t('resolve_dir 先读专属目录', /backup_group_dir|backup_project_dir/.test(fn));
    t('专属为空才回退统一目录', /backup_dir/.test(fn));
    t('最后回退数据目录 backup/', /data_dir\.join\("backup"\)/.test(fn));
    /* 界面上的说明必须与实际一致，否则用户按说明配置却得到别的结果 */
    t('界面说明写了"留空 = 用数据目录下的 backup/"',
      /留空 = 用数据目录下的 backup\//.test(dlg));
    t('界面说明写了"指定后不再进根目录的子层"',
      /不再进根目录的子层/.test(dlg));
  }
}

console.log('\n=== 6. 「一键备份」弹窗与设置页写法一致 ===');
{
  /* 两处都能改同一批字段。若空串处理不一致，一边清空另一边还会生效 */
  const tools = fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8');
  for (const f of ['backupDir', 'backupProjectDir', 'backupGroupDir']) {
    t(`一键备份弹窗也用 trim() || null（${f}）`,
      new RegExp(`${f}:\\s*\\w+\\.trim\\(\\) \\|\\| null`).test(tools));
  }
}

done();
