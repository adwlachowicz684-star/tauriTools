/**
 * 自动备份间隔档位（#93，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/backup-interval-test.mjs
 *
 * #93 的价值不在"多几个选项"，而在**最需要它的时候能用**：
 * 刚改完设置、刚调了备份目录，恰恰最想立刻验证一次，
 * 而最短却要等 15 分钟 —— 那就只能手动备份，功能形同虚设。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const dlg = strip(fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8'));
const model = strip(fs.readFileSync(path.join(RS, 'model.rs'), 'utf8'));

console.log('\n=== 1. 补齐 1/2/5/10 分钟 ===');
{
  /* 直接在档位表文本里查，避免只匹配到注释 */
  const body = dlg.slice(dlg.indexOf('const BACKUP_PRESETS'));
  const seg = body.slice(0, body.indexOf('];') + 2);
  for (const v of [1, 2, 5, 10]) {
    t(`有 ${v} 分钟档`, new RegExp(`\\{ value: ${v}, label: '${v} 分钟' \\}`).test(seg));
  }
  /* 原有档位不能丢 */
  for (const v of [15, 30, 60, 120, 360, 720, 1440]) {
    t(`保留 ${v} 分钟档`, new RegExp(`value: ${v},`).test(seg));
  }
  t('有"关闭"（0）', /\{ value: 0, label: '关闭' \}/.test(seg));
}

console.log('\n=== 2. 档位升序（下拉里乱序很难挑）===');
{
  const body = dlg.slice(dlg.indexOf('const BACKUP_PRESETS'));
  const seg = body.slice(0, body.indexOf('];') + 2);
  const vals = [...seg.matchAll(/value: (\d+),/g)].map((m) => Number(m[1]));
  const sorted = [...vals].sort((a, b) => a - b);
  t('档位按值升序', vals.length > 0 && vals.join(',') === sorted.join(','));
  console.log('   档位:', vals.join(' / '));
}

console.log('\n=== 3. 当前值不在档位里时要显示出来（最关键）===');
{
  /* 受控 select 遇到没有的 option 会**显示空白** ——
     用户看不出当前是什么，还以为没设置。与 #63 同源。 */
  t('非档位值动态插入选项',
    /!BACKUP_PRESETS\.some\(\(p\) => p\.value === autoMinutes\) && \(/.test(dlg));
  t('插入的项显示该值', /value=\{autoMinutes\}>\{autoMinutes\} 分钟（自定义）/.test(dlg));
  /* 后端不校验取值，所以这种情况真的会发生 */
  t('注释：后端确实不校验取值', /后端不校验取值/.test(model));
}

console.log('\n=== 4. 后端注释同步 ===');
{
  t('model.rs 注释列出短档位', /预设档位 1\/2\/5\/10\/15\/30\/60\/120\/360\/720\/1440/.test(model));
  t('注释：提示前端要显示自定义值', /前端 select 要把这种值显示出来/.test(model));
}

done();
