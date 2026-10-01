/**
 * config 兜底整理对齐原版 ConfigService.Normalize（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/config-normalize-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripComments as strip } from '../../test-scan-utils.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const store = fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/store.rs'), 'utf8');

console.log('\n=== 1. 空名页签要兜底（原版 t.Name = "页签"）★★ ===');
{
  /*
   * 原版：if (string.IsNullOrWhiteSpace(t.Name)) t.Name = "页签";
   *
   * 不兜底的后果：手改 config.json 把页签名设成空串或纯空格，
   * 界面上那个页签按钮是**空白的、宽度塌到几乎为零** ——
   * 用户不知道它存在、点不中它、也没法给它改名（找不到它在哪）。
   * 它里面的卡片就这样被"藏"起来了，且没有任何报错。
   */
  const i = store.indexOf('fn ensure_default_tabs(');
  const b = store.slice(i, store.indexOf('\nfn ensure_ranges(', i));
  t('项目页签空名兜底', /for t in cfg\.project_tabs\.iter_mut\(\)/.test(b));
  t('项目组页签空名兜底', /for t in cfg\.group_tabs\.iter_mut\(\)/.test(b));
  /* 必须按 trim 后判空，纯空格名同样看不出是什么 */
  t('按 trim 后判空（纯空格也算）', (b.match(/t\.name\.trim\(\)\.is_empty\(\)/g) || []).length === 2);
  t('兜底名是"页签"', (b.match(/t\.name = "页签"\.into\(\)/g) || []).length === 2);
}

console.log('\n=== 2. 图标分组只兜底空名，**绝不能**凭空补一个空分组 ★★ ===');
{
  const i = store.indexOf('fn ensure_default_tabs(');
  const b = store.slice(i, store.indexOf('\nfn ensure_ranges(', i));
  t('分组空名兜底为"分组"', /if g\.name\.trim\(\)\.is_empty\(\) \{ g\.name = "分组"\.into\(\); \}/.test(b));
  /*
   * 反面证据（本轮真踩过）：后端一旦补出空分组，前端那个兜底
   * 就永远不触发 —— 图标区彻底空白，用户既看不到内置图标、
   * 也分不清是"没图标"还是"加载失败"。
   *
   * 这类"后端加兜底、把前端兜底顶掉"的坑没有报错，只有空白。
   */
  t('不补空分组（会顶掉前端的内置图标兜底）', !/if cfg\.icon_groups\.is_empty\(\)/.test(b));
  t('注释写明为什么不能补', /为什么不能补一个空分组/.test(b));
  const grid = fs.readFileSync(path.join(HERE, 'components/PresetIconGrid.tsx'), 'utf8');
  t('前端兜底依赖"一个分组都没有"', /if \(groups\.length > 0\) return groups;/.test(grid));
  t('前端兜底给出全部内置图标', /\{ name: DEFAULT_GROUP, icons: \[\.\.\.PRESET_ICON_NAMES\] \}/.test(grid));
}

console.log('\n=== 3. 原有兜底没被改坏 ===');
{
  const i = store.indexOf('fn ensure_default_tabs(');
  const b = store.slice(i, store.indexOf('\nfn ensure_ranges(', i));
  t('项目页签至少一个', /if cfg\.project_tabs\.is_empty\(\)/.test(b));
  t('项目组页签至少一个', /if cfg\.group_tabs\.is_empty\(\)/.test(b));
  t('新建的叫"默认"', (b.match(/first\.name = "默认"\.into\(\)/g) || []).length === 2);
  t('仍走 load_config', /fn load_config\(dir: &Path\)/.test(store));
  t('ensure_default_tabs 被 load_config 调', /ensure_default_tabs\(&mut cfg\);/.test(store));
  t('ensure_ranges 仍在', /fn ensure_ranges\(/.test(store));
  t('migrate_config 仍在', /migrate_config\(&mut cfg\);/.test(store));
}

console.log('\n=== 4. 写入路径仍安全 ===');
{
  t('损坏时隔离现场而非静默默认', /LoadOutcome::Corrupted/.test(store));
  t('原子写仍在', /replace_file\(&tmp, path\)/.test(store));
  t('写失败清临时文件', /fs::remove_file\(&tmp\)\.ok\(\);/.test(store));
}

console.log('\n=== 5. 路径归一只有一套规则（前端不得自带副本）★★ ===');
{
  /*
   * 历史教训（store.rs 里也写着）：这个文件原先不带分隔符统一，
   * sys.rs 另有一份"无条件小写"，前端 api.ts 又是第三份。
   * **三套规则并存是多个路径匹配 bug 的共同根因**，所以全量扫一遍。
   *
   * 判据取那份最常见的副本：去尾分隔符 + 无条件 toLowerCase。
   * 它与 normalize_key 差两点，而两点**各自**都会改到用户没要求改的东西：
   *   · 无条件小写：非 Windows 上 `Foo` / `foo` 是两个不同目录却被判成同一个
   *     → 查重误拦（加不进去）/ 换绑误判（把别组链接抢过来）；
   *   · 不统一分隔符：`D:\a` 与 `D:/a` 本是一个目录却判成两个
   *     → 查重漏掉（同一文件夹登记进两个页签）/ 已连本组被判成别组（一点确定就被删）。
   */
  const srcFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(HERE, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'preseticons') walk(rel); continue; }
      if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(rel);
    }
  };
  for (const d of ['.', 'components', 'hooks', 'utils']) {
    if (d === '.') {
      for (const e of fs.readdirSync(HERE, { withFileTypes: true })) {
        if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) srcFiles.push(e.name);
      }
    } else walk(d);
  }

  /*
   * 先剥注释再扫：两处修复说明里都**引用了**那段旧代码（要写清它错在哪），
   * 不剥的话这两条说明本身就会命中 —— 那是**假报警**，而假报警比没有更糟：
   * 后来人会学着忽略它，或者为了让报警消失把说明删掉。
   */
  const stripDoc = (s) => strip(s).replace(/^[ \t]*\/\/.*$/gm, '');
  const BAD = /\.replace\(\/\[\\\\\/\]\+\$\/, ''\)\s*\.toLowerCase\(\)/;
  const hits = srcFiles.filter((f) => {
    const s = stripDoc(fs.readFileSync(path.join(HERE, f), 'utf8'));
    return BAD.test(s);
  });
  t('前端没有任何"无条件小写"的路径归一副本', hits.length === 0, hits.join('、'));
  /* 护栏自己不能空跑：扫到 0 个文件等于什么都没验（前面踩过多次） */
  t('确实扫到了源文件', srcFiles.length >= 20, `srcFiles=${srcFiles.length}`);

  /* api.ts 那份是唯一入口：只在 ci 为真时转小写、且统一分隔符 */
  const api = fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8');
  t('normalizeKey 统一分隔符', /replace\(\/\\\\\/g, '\/'\)/.test(api));
  t('normalizeKey 只在 ci 时转小写', /return ci \? s\.toLowerCase\(\) : s;/.test(api));

  /*
   * 两处调用点都要按平台给 ci。
   * 只钉"有 ci 参数"是漏报的 —— 默认 false 也能通过，
   * 而 Windows 上少了大小写不敏感会让 `D:\a` / `d:\A` 判成两个。
   */
  const hook = fs.readFileSync(path.join(HERE, 'hooks/useFpx.ts'), 'utf8');
  const hub = fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8');
  /*
   * 必须限定到 addCard 查重那一段，不能全文件判。
   *
   * 全文件判 `const ci = boot?.platform === 'windows'` 是**空跑**的：
   * 本文件另有两处同样的 ci（删除卡片、内容区），只钉字面量的话，
   * 把查重这处的 ci 去掉，断言照样通过 —— 而 Windows 上少了大小写不敏感，
   * `D:\a` 与 `d:\A` 会被判成两个目录，查重漏掉。
   */
  const iAdd = hook.indexOf('const addCard = useCallback');
  const iOwner = hook.indexOf('const owner = list.findIndex', iAdd);
  const dedup = hook.slice(iAdd, iOwner + 400);
  /*
   * ⚠️ 这条断言曾经是**过期的**，而且过期方式最坏：它钉的是"写法"不是"意图"。
   *
   * 它要求 `const ci = boot?.platform === 'windows';` 出现在 addCard 查重那一段里。
   * 后来那行被**上提到文件最前面**（紧跟 boot）—— 原因写在 useFpx.ts 的注释里：
   *   · 它原先声明在文件后半段，而 createLink / syncLinks 的依赖数组在它**之前**求值；
   *   · `const` 有暂时性死区，那两处读到的是尚未初始化的绑定；
   *   · 结果是 useFpx **首次渲染就抛 ReferenceError** —— 整块崩，不是"这个功能不能用"。
   *
   * 于是这条断言开始恒假、一直红，而它指控的问题**根本不存在**。
   * 它不算"漏报"，是**负的**：真去"修"它，就得把 ci 搬回后半段，
   * 等于把崩溃级 bug 请回来。守着错标准的测试比没有测试更危险。
   *
   * 改为钉真正要保证的两件事（值对、且声明先于使用），写法本身不再钉死。
   */
  const CI_DECL = "const ci = boot?.platform === 'windows';";
  const iCi = hook.indexOf(CI_DECL);
  t('锚点取到查重那一段', iAdd >= 0 && iOwner > iAdd, `iAdd=${iAdd} iOwner=${iOwner}`);
  /* ① 值必须来自平台判断。写死 false 也能"有 ci 参数"，但 Windows 上
   *    `D:\a` / `d:\A` 判成两个目录，查重悄悄漏掉 —— 不报错，只是重复登记。 */
  t('ci 按平台求值（不能写死 true/false）', iCi >= 0 && !/const ci = (true|false);/.test(hook), `iCi=${iCi}`);
  /* ② 声明必须先于 addCard。搬回后半段就是 TDZ，崩溃级。 */
  t('ci 声明在查重段之前（防搬回去触发 TDZ）', iCi >= 0 && iCi < iAdd, `iCi=${iCi} iAdd=${iAdd}`);
  t('查重走 normalizeKey', /normalizeKey\(c\.path, ci\) === normalizeKey\(path, ci\)/.test(dedup));
  t('换绑判定按平台给 ci', /ci=\{boot\.platform === 'windows'\}/.test(hub));
}

done();
