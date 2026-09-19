/**
 * 内置 Markdown 编辑器接入回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/md-edit-test.mjs，然后
 *         node plugins/project-group/md-edit-test.mjs
 *
 * #33：共享服务 `md-editor` 已就位，本项目此前还在用外部编辑器，
 * 且 `App.tsx` 里那句"共用组件尚未就绪"的注释**已经不成立了**。
 *
 * 这里守几件容易做错的事：
 *   · 读→编辑→写回 三段都有各自的错误处理（读失败不该继续走编辑）
 *   · **取消的两种形态都认** —— 服务约定是 resolve(null)，
 *     但三个内置服务的实现都是 reject('已取消')，只认一种就会
 *     变成 unhandled rejection
 *   · 内容没改不写盘（省一次原子写，也避免无谓的 mtime 变化）
 *   · 异步快捷键有兜底 catch（漏了就是控制台一片红、界面毫无反应）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx');
const { t, done } = makeT();

const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');
const api = fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8');
const hk = fs.readFileSync(path.join(HERE, 'hooks/useCardHotkeys.ts'), 'utf8');

/** 取 openMarkdown 的函数体 */
const fn = app.slice(app.indexOf('const openMarkdown'), app.indexOf('const projectCards'));
/** 剥掉注释后的代码（避免"注释里提到某词"被当成"代码里用了它"） */
const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

console.log('\n=== 1. 走内置 md 服务（不再是外部编辑器）===');
t('调 ctx.services.md.edit', /ctx\.services\.md\.edit\(/.test(code));
t('先读文本', /await s\.api\.readText\(contentSel\.path\)/.test(code));
t('再写回', /await s\.api\.writeText\(contentSel\.path, edited\)/.test(code));
t('保存后刷新', /s\.refresh\(\)/.test(code));
t('陈旧注释已去掉（不再写"尚未就绪"）', !/尚未就绪/.test(fn));
t('仍保留外部编辑器作为退回路径', /s\.api\.editFile\(contentSel\.path\)/.test(fn));

console.log('\n=== 2. 三段各有错误处理 ===');
{
  const catches = [...code.matchAll(/catch/g)].length;
  t('多处 catch（读 / 编辑 / 写 各自处理）', catches >= 3, `${catches} 处`);
  t('读失败直接返回、不继续编辑',
    /catch \(e\) \{\s*fail\('读取文件失败', e\);\s*return;/.test(code));
  t('写失败也报出路径上下文', /fail\('写回失败', e\)/.test(code));
  t('fail 同时记日志与 toast',
    /s\.pushLog\(m, true\)/.test(code) && /ctx\.toast\(m, 'err'\)/.test(code));
}

console.log('\n=== 3. 取消的两种形态都认（核心）===');
{
  t('包了 try/catch（接住 reject 形态）',
    /try \{\s*edited = await ctx\.services\.md\.edit/.test(code));
  t('也判了 null / undefined（接住 resolve(null) 形态）',
    /edited === null \|\| edited === undefined/.test(code));
  t('取消时不报红、只记日志', /内置编辑器未返回结果/.test(fn));
  /* 反面：不能把取消当成崩溃 */
  t('取消分支不走 fail（不弹错误提示）',
    !/fail\('.*取消/.test(fn));
}

console.log('\n=== 4. 内容没改不写盘 ===');
{
  t('等于原文时直接返回', /if \(edited === text\)/.test(code));
  t('并说明"内容未变，未写盘"', /内容未变，未写盘/.test(fn));
  t('该分支在写盘之前', code.indexOf('edited === text') < code.indexOf('writeText'));
}

console.log('\n=== 5. 异步快捷键的兜底 ===');
{
  t('run 接受异步 fn', /fn: \(\) => void \| Promise<void>/.test(hk));
  t('统一 void 掉返回值并 catch',
    /typeof \(r as Promise<void>\)\.catch === 'function'/.test(hk));
  t('外层还包了 try/catch', /\} catch \{ \/\* 内部已各自处理/.test(hk));
}

console.log('\n=== 6. 前端接口 ===');
{
  t('api.ts 有 readText', /readText: \(path: string\) => call<string>\('fpx_read_text'/.test(api));
  t('api.ts 有 writeText', /writeText: \(path: string, text: string\) => call<null>\('fpx_write_text'/.test(api));
  t('readText 注释说明二进制会报错', /二进制会报错/.test(api));
  t('writeText 注释说明只能写已存在文件', /只能写回已存在的文件/.test(api));
}

console.log('\n=== 7. 后端命令 ===');
{
  const modPath = path.join(RS, 'mod.rs');
  if (!fs.existsSync(modPath)) { console.log('（跳过：未找到 mod.rs）'); }
  else {
    const mod = fs.readFileSync(modPath, 'utf8');
    t('定义了 fpx_read_text', /pub fn fpx_read_text\(/.test(mod));
    t('定义了 fpx_write_text', /pub fn fpx_write_text\(/.test(mod));
    const rd = mod.slice(mod.indexOf('pub fn fpx_read_text'), mod.indexOf('pub fn fpx_write_text'));
    const wr = mod.slice(mod.indexOf('pub fn fpx_write_text'), mod.indexOf('/* ---------------------------- Agent 连锁'));
    t('读也过路径收口', /ensure_path_in\(&dir, &cfg, &path\)/.test(rd));
    t('写也过路径收口（写比读更该收口）', /ensure_path_in\(&dir, &cfg, &path\)/.test(wr));
    t('二进制拒绝打开（编辑后写回等于损坏）',
      /不是文本文件（含二进制内容）/.test(rd));
    t('剥 BOM 再交给编辑器', /feff/.test(rd));
    t('目录 → SKILL.md（与 edit_file 同一规则）',
      /content::skill_md_of/.test(rd) && /content::skill_md_of/.test(wr));
    t('写回是原子写（临时文件 + replace）',
      /std::fs::write\(&tmp/.test(wr) && /fsutil::replace_file\(&tmp/.test(wr));
    t('拒绝凭空新建文件', /只能写回已存在的文件/.test(wr));
  }
  const mainPath = path.join(RS, '../main.rs');
  if (fs.existsSync(mainPath)) {
    const main = fs.readFileSync(mainPath, 'utf8');
    t('两条都注册进 invoke_handler',
      /fpx::fpx_read_text/.test(main) && /fpx::fpx_write_text/.test(main));
  }
}

console.log('\n=== 8. 服务契约不一致（记录，不在本轮修改）===');
{
  const sdk = path.join(HERE, '../../js/plugin-sdk.js');
  const dts = path.join(HERE, '../../js/plugin-sdk.d.ts');
  const mdSvc = path.join(HERE, '../md-editor/index.js');
  if (fs.existsSync(sdk) && fs.existsSync(mdSvc)) {
    const jsTxt = fs.readFileSync(sdk, 'utf8');
    const dtsTxt = fs.existsSync(dts) ? fs.readFileSync(dts, 'utf8') : '';
    const svc = fs.readFileSync(mdSvc, 'utf8');
    t('sdk 注释说取消 resolve(null)',
      /resolve\(null\) —— \*\*用户取消\*\*/.test(jsTxt));
    t('但 md-editor 实现是 reject(已取消)',
      /reject\(new Error\('已取消'\)\)/.test(svc));
    t('.d.ts 与实际一致（写的是 reject）',
      /取消则 reject/.test(dtsTxt));
    /* 这个不一致是**故意不改**的：调用方两边都判，服务改任一种都不会挂。
       记录在此，等宿主侧统一时再删掉其中一条分支。 */
    t('→ 故调用方两边都判（见第 3 组）', true);
  }
}

done();
