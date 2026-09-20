/**
 * 移除卡片的三勾选（#83，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/remove-card-test.mjs
 *
 * #83 的核心不是"加三个勾选"，而是**只在卡片已不在任何页签里时才清理**。
 * 同一张卡片可以同时登记在多个页签 —— 从页签 A 移除时若顺手清掉图标，
 * 页签 B 里那张也跟着没了图标，而用户只要求移除 A 里的那张。
 * 这种"改了不该改的地方"没有报错，用户只会觉得图标莫名其妙丢了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n=== 1. 后端：命令与参数 ===');
{
  const mod = strip(fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8'));
  t('有 fpx_remove_card', /pub fn fpx_remove_card\(/.test(mod));
  /* 参数是 Option<bool>，旧调用方不带也不会报错 */
  t('keep_link 是 Option', /keep_link: Option<bool>/.test(mod));
  t('keep_icon 是 Option', /keep_icon: Option<bool>/.test(mod));
  t('keep_color 是 Option', /keep_color: Option<bool>/.test(mod));
  t('tab_index 是 Option', /tab_index: Option<usize>/.test(mod));
}

console.log('\n=== 2. 只在"已不在任何页签"时才清理（最关键）===');
{
  const mod = strip(fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8'));
  /* 判定函数：看所有页签里还有没有这张卡 */
  t('有 still 判定', /tabs\.iter\(\)\.any\(\|t\| t\.items\.iter\(\)\.any/.test(mod));
  t('清理前先判 !still', /if !still\(cfg\) \{/.test(mod));
  t('断链也先看 !still', /let unlink = !still\(cfg\)/.test(mod));
  /* **没有"无条件清图标"的写法** */
  t('没有无条件的图标清理',
    !/cfg\.folder_icons\.retain[\s\S]{0,40}?;\s*\n\s*cfg\.folder_gui_icons\.retain/.test(
      mod.slice(mod.indexOf('pub fn fpx_remove_card')).split('!still(cfg)')[0] ?? '',
    ));
}

console.log('\n=== 3. 两套都要清（#13 / #113）===');
{
  const mod = strip(fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8'));
  const body = mod.slice(mod.indexOf('pub fn fpx_remove_card'));
  const seg = body.slice(0, body.indexOf('/// 扫描项目组下的'));
  t('清 folder_icons', /cfg\.folder_icons\.retain/.test(seg));
  t('清 folder_gui_icons', /cfg\.folder_gui_icons\.retain/.test(seg));
  t('清 tag_colors', /cfg\.tag_colors\.retain/.test(seg));
  t('清 tag_gui_colors', /cfg\.tag_gui_colors\.retain/.test(seg));
}

console.log('\n=== 4. 断链只对项目卡 ===');
{
  const mod = strip(fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8'));
  t('断链要求 kind == project', /&& kind == "project"/.test(mod));
  /* 断链会删 junction，放在事务外单独做，失败能抛给前端 */
  t('断链在 with_config 之外', /if need_unlink \{[\s\S]{0,80}?core_remove_link/.test(mod));
}

console.log('\n=== 5. 默认全保留（升级不丢数据）===');
{
  const src = strip(fs.readFileSync(path.join(HERE, 'components/dialogs.tsx'), 'utf8'));
  t('保留链接默认 true', /useState\(true\)[\s\S]{0,200}?useState\(true\)[\s\S]{0,200}?useState\(true\)/.test(src));
  t('三个勾选都在', /保留链接/.test(src) && /保留图标/.test(src) && /保留标签色/.test(src));
  /* 项目组卡没有链接，不该显示这一项 */
  t('保留链接只对项目卡显示', /kind === 'project' && \([\s\S]{0,300}?保留链接/.test(src));
  t('有说明文案', /取消勾选即同时清理对应痕迹/.test(src));
}

console.log('\n=== 6. 三处入口都走弹窗 ===');
{
  const app = strip(fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8'));
  t('入口都改成弹窗', (app.match(/setDialog\(\{ type: 'remove'/g) ?? []).length === 3);
  /* **不再有直接 removeCard 的调用** —— 否则会绕过确认 */
  t('没有直接调 s.removeCard', !/s\.removeCard\(/.test(app));

  const host = strip(fs.readFileSync(path.join(HERE, 'components/Dialogs.tsx'), 'utf8'));
  t('弹窗已渲染', /dialog\.type === 'remove' && \(/.test(host));
  t('确认后调 removeCardFull', /s\.removeCardFull\(/.test(host));
}

console.log('\n=== 7. 前端 api ===');
{
  const api = strip(fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8'));
  t('有 removeCard', /removeCard: \(/.test(api));
  t('调 fpx_remove_card', /'fpx_remove_card'/.test(api));
  t('传 tab_index', /tab_index: tabIndex/.test(api));
  t('传三个 keep', /keep_link: keep\.link, keep_icon: keep\.icon, keep_color: keep\.color/.test(api));
}

done();
