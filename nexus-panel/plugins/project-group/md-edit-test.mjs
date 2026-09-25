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
  /*
   * 顺序断言必须**两端都判存在**：
   * 某端找不到时 indexOf 返回 -1，而 `-1 < 任意正数` 恒真 ——
   * 断言会**空跑**：锚点被改没了，它照样报绿，你以为在验次序，其实什么都没验。
   * 这类空跑靠"剥注释"扫不出来（锚点是代码不是注释），只能显式判 >= 0。
   */
  const iEq = code.indexOf('edited === text');
  const iWrite = code.indexOf('writeText');
  t('该分支在写盘之前', iEq >= 0 && iWrite >= 0 && iEq < iWrite);
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
    /*
     * 结尾锚点原先是分隔注释；改用该段第一个函数签名（代码），
     * 注释改写不至于让整段切片失效。
     */
    const wr = mod.slice(mod.indexOf('pub fn fpx_write_text'), mod.indexOf('pub fn fpx_chain_clients('));
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

console.log('\n=== 7b. macOS 的 .app 编辑器：能列出来就必须能打开 ★★ ===');
{
  const sys = fs.readFileSync(path.join(RS, 'sys.rs'), 'utf8');
  const sysCode = sys.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const ed = fs.readFileSync(path.join(RS, 'editor.rs'), 'utf8');
  const edCode = ed.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /*
   * `editor::enumerate` 用 `exe.exists()` 收候选 —— 注释明写：
   * 「macOS 的 .app 是目录，用 is_file 会把它们全漏掉」。
   * 于是 VS Code.app / Cursor.app **一定**出现在选择列表里。
   * 而 `open_path(mode="editor")` 走 `check_executable`，那条要求 `is_file()`
   * （`looks_like_path` 为真时）。两条规则对 `.app` 判定不一致：
   * 列表里最显眼的几项**点了必然失败**，报「编辑器不可用（可执行文件不存在）」。
   * 用户只会以为"这软件选不了编辑器"，而真相无从查起。
   */
  t('enumerate 用 exists() 收候选（.app 才不会被漏掉）',
    /if exe\.exists\(\) && seen\.insert\(key\)/.test(edCode));
  t('check_executable 要求 is_file（两条规则确实不同，故必须在 open_path 里兜住）',
    /if !p\.is_file\(\) \{\s*\n\s*return Err\(format!\("可执行文件不存在/.test(
      fs.readFileSync(path.join(RS, 'safety.rs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')));

  /* 兜住的方式：走系统 opener `open -a <.app> <文件>` */
  t('open_path 认 .app 目录',
    /editor\.to_lowercase\(\)\.ends_with\("\.app"\) && ep\.is_dir\(\)/.test(sysCode));
  t('用 open -a 启动', /Command::new\("open"\)\s*\n\s*\.args\(\["-a", editor\]\)/.test(sysCode));

  /* **顺序**：必须在 check_executable 之前，否则先被 is_file 判死，分支永远走不到 */
  const iApp = sysCode.indexOf('ends_with(".app")');
  const iChk = sysCode.indexOf('check_executable(Path::new(editor))');
  t('两端的锚点都真实存在', iApp >= 0 && iChk >= 0);
  t('（两端都找到时才比较）.app 分支在 check_executable 之前',
    iApp >= 0 && iChk >= 0 && iApp < iChk);

  /*
   * 不能把 .app 直接交给 `Command::new(editor)` —— 目录不可 exec。
   * 且该分支必须 `return`，不能只是算完往下掉（掉下去就进了 check_executable）。
   *
   * 注意：这条必须像上面那条顺序断言一样**先判锚点存在**。
   * 第一版没判，结果整段被删掉时 indexOf 返回 -1、切片落到文件开头，
   * 断言照样通过 —— 即"护栏本身空跑"，比没有更糟。
   */
  const tail = iApp >= 0 && iChk >= 0 ? sysCode.slice(iApp, iChk) : '';
  t('（锚点都在时才判）.app 分支内不出现 Command::new(editor)',
    iApp >= 0 && iChk >= 0 && !/Command::new\(editor\)/.test(tail));
  t('（锚点都在时才判）.app 分支是 return，不往下掉',
    iApp >= 0 && iChk >= 0 && /return Command::new\("open"\)/.test(tail));

  /* macOS 分支里也要挡 shell 元字符：exe 与路径都来自配置 / 磁盘 */
  t('.app 分支校验编辑器路径', /编辑器路径含不安全字符/.test(sys));
  t('.app 分支校验文件参数', /路径含特殊字符，已拒绝打开/.test(sys));
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
    t('注释：.d.ts 写的是 reject',
      /取消则 reject/.test(dtsTxt));
    /*
     * 这个不一致是**故意不改**的：调用方两边都判，服务改任一种都不会挂。
     * 记录在此，等宿主侧统一时再删掉其中一条分支。
     *
     * 原先这里写的是 `t(..., true)` —— 占位断言，什么都不验。
     * 真正要钉的是"调用方确实两边都判"：只判一边的话，
     * 服务改成另一种语义时调用方会静默走错分支（取消被当成失败，或反之）。
     */
    /*
     * 调用方在 App.tsx（本插件没有 index.tsx）。
     * 用 existsSync 先判：文件挪走时若直接 readFileSync 会抛 ENOENT，
     * 整个套件挂掉 —— 而"套件挂掉"和"断言失败"在报告里长得不一样，
     * 前者容易被当成环境问题忽略掉。
     */
    const callerPath = path.join(HERE, 'App.tsx');
    t('调用方文件存在', fs.existsSync(callerPath), callerPath);
    const caller = fs.existsSync(callerPath)
      ? fs.readFileSync(callerPath, 'utf8')
      : '';
    /*
     * 钉**真实代码**，不能钉注释里的字样 ——
     * 第一版写的 `/已取消/` 只匹配到 App.tsx 注释里那句
     * "实现都是 reject('已取消')"，被断言卫生护栏当场判为"只验注释"。
     * 真正要钉的是调用方对两种取消形态的处理：
     *   - reject → try/catch 兜住，不冒泡成 unhandled rejection
     *   - resolve(null/undefined) → 显式判 == null，退回外部编辑器
     * 少了任一种，用户点个取消就会看到控制台一片红（或静默什么都不发生）。
     */
    t('两种取消形态都认：reject 由 catch 兜住',
      /\.\s*catch\s*\(\(?e\)?\s*=>/.test(caller));
    t('两种取消形态都认：resolve 空值显式判',
      /edited\s*===\s*null\s*\|\|\s*edited\s*===\s*undefined/.test(caller));
    t('取消时退回外部编辑器（不静默）',
      /editFile\(/.test(caller));
    /*
     * 自检：确认上面那条判据不是恒真。
     * 对照串用变量而不是字面正则 —— 字面正则会被断言卫生护栏
     * 当成"应当匹配得上源码"的判据而误报。
     */
    const IMPOSSIBLE = '这段绝不可能出现的字符串';
    t('（自检）判据不是恒真',
      /edited\s*===\s*null/.test(caller) !== caller.includes(IMPOSSIBLE));
  }
}

done();
