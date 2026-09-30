/**
 * 样式资产损伤防线
 * ============================================================
 * 补的是现有审计**唯一没有的那一维：类名**。
 *
 * 背景（2026-09-16 真实事故）：
 *   d9c899bf 引入 project-group 卡片链接明细的 8 个类
 *   d23cd76b（2 分钟后）整块覆盖写，全部抹掉
 *   此后 6 天、20+ 次提交无人发现
 *
 * 为什么现有测试抓不到：
 *   现有断言全是**正向**的（"这条规则里必须有 align-items"），
 *   没有**反向**的（"被引用的类名必须有定义"）。于是三类损伤全部绕过：
 *     1. 规则被截断   → 字符串还在，正向断言照样匹配
 *     2. 覆盖写抹掉类名 → 没有"类名必须有定义"的断言
 *     3. 写了类名没配样式 → 同上
 *
 * 本文件盯三件事：
 *   A. 死类名：代码用了、CSS 没定义
 *   B. 截断规则：选择器后没有规则体（.err-diag-body 那次是真事故）
 *   C. 关键修复不得回退
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
import {
  stripComments, collectDefinedClasses, collectUsedClasses,
  findTruncatedRules, scanDeadClasses, walkFiles,
} from './js/dead-class-scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const rd = (p) => readFileSync(join(HERE, p), 'utf-8');

const CSS_FILES = [
  'css/tokens.css', 'css/controls.css', 'css/neumorphism.css', 'css/dialog.css',
  'plugins/project-group/style.css', 'plugins/agent-flow/styles.css',
  'plugins/mindmap/styles.css', 'plugins/mindmap/editor/kityminder.core.css',
  'plugins/color-picker/style.css', 'plugins/settings/settings.css',
].filter((f) => existsSync(join(HERE, f)));

/*
 * 测试脚手架 / 示例插件 / 第三方封装里的类名不代表真实用法。
 *
 * ⚠️ 分隔符必须**同时认 `/` 与 `\`**：扫描结果里的相对路径在 Windows 上
 * 是 `js\dead-class-scan.js`（反斜杠），而原先只写了 `(^|/)`，
 * 于是在 Windows 上这些排除**一条都没生效** ——
 * 扫描器把自己源码里的 `a`/`b`/`mm-foo` 和 demo 插件的 `num`/`log`/`hero`
 * 全算成死类名，这条断言必然红。Linux 上因为是 `/` 所以看不出问题。
 */
const EXCLUDE_SRC =
  '(^|[/\\\\])([^/\\\\]*-test\\.mjs|[^/\\\\]*\\.test\\.ts|tests[/\\\\]|demo-|editor-bridge\\.js|dead-class-scan\\.js)';

console.log('=== 1. 扫描器自身：必须分得清真假 ===');
{
  t('注释里的类名不算已定义',
    !collectDefinedClasses('/* .fake-a { color: red } */\n.real-b { color: blue }').has('fake-a'));
  t('真定义的能取到',
    collectDefinedClasses('.real-b { color: blue }').has('real-b'));
  t('静态 className', collectUsedClasses('<div className="a b c">').has('b'));
  /*
   * 创建辅助函数传参：el('div', 'nx-mask')
   *
   * js/dialog.js 的写法 —— 它是全项目弹窗的唯一实现，
   * 但类名走的是**函数参数**，class= / 模板串 / h() / classList 四条分支
   * 一条都匹配不到。实测：把 .nx-mask 全局重命名后，4 个测试 375 项
   * 断言**全绿**，弹窗整块失去样式却无人知晓。
   */
  t('创建辅助函数 el(tag, cls) 的类名能取到',
    collectUsedClasses("function el(tag, cls, text){}\nconst m = el('div', 'nx-mask');").has('nx-mask'));
  t('el 第二参是拼接时，前段类名仍能取到',
    collectUsedClasses("function el(tag, cls, text){}\nconst b = el('button', 'nx-btn' + (v ? ' primary' : ''));").has('nx-btn'));
  /*
   * 签名不同就不该取 —— 否则误报一大片。
   * 全仓另三个文件是 `const el = (tag, attrs={}, ...kids)`，
   * 第二参是**属性对象**不是类名；第一版修复没看签名，
   * 把 preview / sv / hue / grid / cell / panes 全报成无样式类名。
   */
  /*
   * ⚠️ 这条原来钉的是 `el('div', { class: 'preview' })` 里 preview **不该**被取。
   * 那是当年修"属性键名被误当类名"时把样例构造错了 ——
   * preview 放在 class 的**值**位置上时，它就是会真实挂到 DOM 的类名，
   * 不取的话这类写法（el/h 的属性对象）全部漏报。
   *
   * 真正要守的是：**键名**不当类名。样例里 preview/sv/hue 当年正是键名。
   * 所以拆成两条，各钉一半。
   */
  t('el 第二参是属性对象时，键名不得当类名（签名必须看）',
    !collectUsedClasses("const el = (tag, attrs = {}, ...kids) => {};\nconst d = el('div', { preview: 1, sv: 2 });").has('preview'));
  t('el 第二参属性对象里的 class 值仍要取',
    collectUsedClasses("const el = (tag, attrs = {}, ...kids) => {};\nconst d = el('div', { class: 'preview' });").has('preview'));
  t('模板串字面量部分', collectUsedClasses('className={`fpx-link-row ${d.state}`}').has('fpx-link-row'));
  t('模板串 ${} 不误取', !collectUsedClasses('className={`a ${undefinedVar}`}').has('undefinedVar'));
  t('三元里的状态类 open',
    collectUsedClasses("className={`fpx-link-arrow${x ? ' open' : ''}`}").has('open'));
  t('hyperscript', collectUsedClasses("h('div.mm-foo.bar', x)").has('mm-foo'));
  /*
   * ⚠️ class: 后的**拼接 + 三元**必须认 —— settings 的插件卡片就写
   * `class: 'tb-card' + (joined ? ' joined' : '') + (hid ? ' is-hidden' : '')`。
   * 只取紧跟 class: 的那一个字面量的话，joined / is-hidden 全是 0 引用，
   * 只能靠 TIER 白名单压住 —— 而白名单压得住报红、压不住失效：
   * 删掉 .tb-card.joined 的规则**一条都不红**（2026-09-29 实测 A/B：
   * 修复前删规则 55/0 全绿，修复后报红并点名 plugins/settings/index.js）。
   */
  t('class: 拼接三元里的分支类要取',
    collectUsedClasses("class: 'tb-card' + (joined ? ' joined' : '')").has('joined'));
  t('class: 拼接三元不取条件里的比较值',
    !collectUsedClasses("class: 'tb-card' + (tab === 'mine' ? ' on' : '')").has('mine'));
  t('classList.add', collectUsedClasses("el.classList.add('is-on')").has('is-on'));
  /*
   * ⚠️ 可选链写法必须认 —— host.js 摘插件 iframe 遮罩的唯一入口就是
   * `iframe?.classList?.add('revealed')`。认不出时 revealed 被判成
   * "全仓 0 引用"：真把 .revealed 样式删了也不报红（插件永远隐身、
   * 不报错），同时它还会混进"真废弃"候选诱导人去删。
   */
  t('classList?.add（可选链）同样要取',
    collectUsedClasses("iframe?.classList?.add('revealed')").has('revealed'));
  t('classList?.toggle / ?.remove 同样要取',
    collectUsedClasses("x?.classList?.toggle('revealed', on)").has('revealed')
    && collectUsedClasses("x?.classList?.remove('revealed')").has('revealed'));
  t('属性访问不误取', !collectUsedClasses('a.map(x => x.length)').has('map'));
  t('拼接前缀 level- 不误取',
    !collectUsedClasses('className={`node-dot level-${x}`}').has('level-'));
  /* 2c：裸三元 className={x ? 'a err' : 'a'}
     —— 少了这条，fpx-log-line / fpx-picker / fpx-stack-box 这类
        确实在挂的类会被判成死样式（实测：三处一起误报）。 */
  t('裸三元两个分支都取到',
    collectUsedClasses("className={x.isError ? 'fpx-log-line err' : 'fpx-log-line'}").has('fpx-log-line'));
  t('裸三元不取条件里的比较值',
    !collectUsedClasses("className={tab === 'mine' ? ' on' : ''}").has('mine'));
  /* 2d：类名抽成导出常量（export const PUML_BOX_CLASS = 'md-puml-box'）
     —— DOM 上挂的是标识符，不认这种写法就永远"没人用"。 */
  t('类名常量能取到',
    collectUsedClasses("export const PUML_BOX_CLASS = 'md-puml-box';").has('md-puml-box'));
  t('普通字符串常量不误取',
    !collectUsedClasses("const GREETING = 'hello world';").has('hello'));
  t('截断规则能查到', findTruncatedRules('.mm-rail\n  /* 注释 */\n  color: red;').length > 0);
  t('正常规则不误报', findTruncatedRules('.mm-rail {\n color: red;\n}').length === 0);
  t('选择器换行合法写法不误报',
    findTruncatedRules('.a,\n.b {\n color: red;\n}').length === 0);
}

console.log('\n=== 2. 实扫：截断规则必须为 0 ===');
{
  const r = scanDeadClasses({ root: HERE, cssFiles: CSS_FILES, excludeSrc: EXCLUDE_SRC });
  t('全部 CSS 无被截断的规则', r.truncated.length === 0,
    r.truncated.map((x) => `${x.file}:${x.head}`).join(' | ') || '0 处');

  /* 破坏验证记录：把 neumorphism.css 里 .err-diag-body 的注释挪到选择器前、
     去掉规则体的 { ，本项应报红。真实事故正是这个形态 ——
     注释插进选择器和 { 之间后，CSS 会把两行连读成后代选择器
     `.err-diag-actions .err-diag-body`，而 DOM 里它们是兄弟节点，
     于是整段样式静默失效。 */
}

console.log('\n=== 3. 实扫：不得有新增死类名 ===');
{
  /*
   * 基线白名单。
   *
   * 这些是**已知**的"写了类名但没配样式"的残骸 —— 多数靠内联 style 或
   * 父级样式兜着，不致命，且修它们要逐个确认视觉后果，不宜混在防线里做。
   * 所以登记在此，让本测试只报**新增**损伤，保证信噪比。
   *
   * 一旦列表里某项被真正修好了，应从此表移除（测试会因此更严）。
   */
  /*
   * 白名单 —— 分两类，理由必须写清，否则就成了"懒得修就加进列表"。
   *
   * 一类：**样式不在 CSS 文件里**（由 JS 运行时注入）。扫描只解析 .css，
   *   所以查不到定义；但样式是真实存在的，不是损伤。
   * 二类：**状态钩子**。只用于标记模式、供外部样式表或后续功能挂钩，
   *   本身不需要本项目内的 CSS。给他们硬编样式等于凭空发明行为。
   */
  const KNOWN_DEAD = [
    // ── 一类：样式由 JS 注入，不在 .css 文件里 ──
    // io.js 打印时动态插入 '@media print' 样式表，含 .mm-print-root
    // （.mm-print-svg 只在 mindmap-test.mjs 里出现，已被 excludeSrc 排除，
    //   故不登记在此 —— 登记了反而会被"都还在"那条判为陈旧）
    'mm-print-root',

    // ── 二类：状态钩子，不配样式是对的 ──
    // 外壳挂在 body 上的模式标记，供外部样式表/扩展使用
    'nexus-view-settings', 'nexus-isolated',
    // 工具栏按钮的标记类（'tb-btn tb-toolbar-btn'），样式由 .tb-btn 承担
    'tb-toolbar-btn',
    /*
     * 目录服务的两个输入框标识（'input.p-input.fp-name'）。
     * 外观由同串的 .p-input 承担、布局由父级 .fp-namerow / .fp-newrow
     * 承担（见 neumorphism.css 里 `.fp-namerow .p-input { flex:1 }`）。
     * 它们只是给 JS 认节点用的钩子，硬编样式等于凭空发明行为。
     */
    /*
     * 前缀拼接：代码写的是 `md-toc-lv${it.level}`，
     * 真实挂到 DOM 上的是 md-toc-lv1 … md-toc-lv6 —— CSS 里六个都有定义。
     * 扫描器取到的是拼接前的字面量 md-toc-lv，精确匹配自然落空。
     */
    'md-toc-lv',
    /*
     * ── 三类：压根不是 CSS 类名 ──
     * xmind 导入时把 XML 节点名写进 JSON 的 class 字段（sheet / topic /
     * boundary），是**数据**不是样式，永远不会有对应 CSS 规则。
     * 不登记会一直被当成"代码用了但没定义"，淹没真正的新增损伤。
     */
    'sheet', 'topic', 'boundary',
  ];

  const r = scanDeadClasses({ root: HERE, cssFiles: CSS_FILES, excludeSrc: EXCLUDE_SRC });
  const allow = new Set(KNOWN_DEAD);
  const fresh = r.dead.filter((d) => !allow.has(d.cls));

  t('没有白名单之外的新增死类名', fresh.length === 0,
    fresh.map((d) => `${d.cls} ← ${d.file}`).join(' | ') || `已知 ${r.dead.length} 个，无新增`);

  /*
   * 反向校验：白名单必须**真的都还在**。
   *
   * 若某项被修好了却忘了从表内移除，这条会红 —— 逼着收紧白名单。
   * 没有这条的话白名单只增不减，慢慢就变成"什么都往里塞"。
   */
  const stale = KNOWN_DEAD.filter((c) => !r.dead.some((d) => d.cls === c));
  t('白名单里的都确实还在（没有悄悄修好却忘了移除）',
    stale.length === 0, stale.join(', ') || `${KNOWN_DEAD.length} 个全部命中`);
}

console.log('\n=== 4. 已修复的 9 处损伤不得回退 ===');
{
  // 4a. project-group 卡片链接明细 8 个类（2026-09-16 被 d23cd76b 抹掉）
  const pg = rd('plugins/project-group/style.css');
  const pgClean = stripComments(pg);
  const pgDefined = collectDefinedClasses(pg);
  const NEED = ['fpx-links-bar', 'fpx-links-toggle', 'fpx-link-row', 'fpx-link-to',
    'fpx-link-group', 'fpx-link-state', 'fpx-link-arrow', 'expandable'];
  const missing = NEED.filter((c) => !pgDefined.has(c));
  t('project-group 链接明细 8 个类都有定义', missing.length === 0,
    missing.join(', ') || `${NEED.length} 个全在`);

  // 这几个类必须仍被使用，否则等于这条断言守了个空
  const grid = rd('plugins/project-group/components/CardGrid.tsx');
  const unused = NEED.filter((c) => !grid.includes(c));
  t('这 8 个类确实还被 CardGrid 使用（断言没守空）', unused.length === 0,
    unused.join(', ') || '全部在用');

  // 关键属性：修复最容易回退的就是这几条（当年丢的就是它们）
  t('.fpx-links-bar 是 flex 行', /\.fpx-links-bar\s*\{[^}]*display:\s*flex/.test(pgClean));
  t('.fpx-links-toggle 是 22px 紧凑档', /\.fpx-links-toggle\s*\{[^}]*height:\s*22px/.test(pgClean));
  t('.fpx-link-state 推到最右', /\.fpx-link-state\s*\{[^}]*margin-left:\s*auto/.test(pgClean));
  t('.fpx-link-group 超长省略', /\.fpx-link-group\s*\{[^}]*text-overflow:\s*ellipsis/.test(pgClean));
  t('.fpx-badge.expandable 有 pointer 手感',
    /\.fpx-badge\.expandable\s*\{[^}]*cursor:\s*pointer/.test(pgClean));

  // 4b. .plugin-wrap-frame
  const neu = stripComments(rd('css/neumorphism.css'));
  const host = rd('js/host.js');
  t('host.js 仍在用 plugin-wrap-frame', host.includes('plugin-wrap-frame'));
  t('plugin-wrap-frame 有定义', /\.plugin-wrap-frame\s*\{[^}]*\}/.test(neu));
}

console.log('\n=== 5. CSS 结构完整性 ===');
{
  for (const f of CSS_FILES) {
    const s = rd(f);
    t(`${f.split('/').slice(-2).join('/')} 括号平衡`, s.count !== undefined
      ? true
      : (s.split('{').length === s.split('}').length),
      `${s.split('{').length - 1} / ${s.split('}').length - 1}`);
  }
}


console.log('\n=== 6. 反向校验：代码用了但 CSS 没定义 ===');
{
  /*
   * 前面几节盯的是"CSS 有定义、代码没用"（死样式，危害是冗余）。
   * 这一节盯反方向：**代码用了、CSS 查无定义** —— 这才是真正的疏漏，
   * 表现是元素裸奔（没有间距、没有边框、位置乱），且不报任何错。
   *
   * 本次全仓扫描的结论是"已清零"，但清零状态必须有人守着：
   * 以后新增一个 className 而忘了补样式，这里会立刻报红。
   */
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (['node_modules', '.git', 'dist', 'target', 'build'].includes(f)) continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(ROOT);
  const css = files.filter((f) => f.endsWith('.css'));
  /* 排除测试文件自身：里面全是 `className="a b c"` 这类**示例串**，
     扫进来会把 a / b / c / mm-foo 全报成"无样式类名"（实测报了 6 个）。
     生产代码才是真正要盯的对象。 */
  /* 排除三类，都是**非生产 UI**，扫进来只会制造噪声：
     · 测试文件 —— 里面全是 `className="a b c"` 这类示例串
     · demo 插件 —— 演示用，样式本就随便
     · *.min.js / editor 第三方库 —— 打包产物，类名由上游决定 */
  /* ⚠️ 路径分隔符必须写 `[/\\]`：walk() 给的是**平台原生**路径，
     Windows 上每个目录分隔都是 `\`。只写 `/` 的话
     `plugins/demo-module/`、`editor/`、`js/dead-class-scan.js`
     这三条**一条都不会命中**，demo 插件与扫描器自身的示例类名
     （mm-foo / num / log / hero）会全部被算成"无样式类名"。
     上一节 EXCLUDE_SRC 踩过同一个坑（2026-09-23）。 */
  const src = files.filter((f) => /\.(tsx|jsx|ts|js|mjs)$/.test(f)
    && !/-test\.mjs$/.test(f) && !/\.test\.(ts|tsx)$/.test(f)
    && !/plugins[/\\]demo-module[/\\]/.test(f)
    && !/\.min\.js$/.test(f) && !/[/\\]editor[/\\]/.test(f)
    /* 扫描器自身也要排除：它的文档注释与单测里用 mm-foo 举例，
       不排除会被自己扫出来（实测报了 1 个）。 */
    && !/js[/\\]dead-class-scan\.js$/.test(f));

  const defined = new Set();
  for (const f of css) {
    for (const c of collectDefinedClasses(readFileSync(f, 'utf8'))) defined.add(c);
  }
  const used = new Set();
  for (const f of src) {
    /*
     * 先剥注释再扫描。
     * dead-class-scan.js 自己的文档注释里就有 `className="a b"` 这类示例，
     * 不剥会把 a / b / mm-foo 报成"无样式类名"（实测报了 6 个）。
     * 生产代码里同样可能用注释举例，所以这一步不能省。
     */
    try {
      for (const c of collectUsedClasses(stripComments(readFileSync(f, 'utf8')))) used.add(c);
    } catch { /* 忽略 */ }
  }

  /* 白名单：这几类是**刻意**没有样式的，不是疏漏。
     · nexus-isolated / nexus-view-settings —— plugin-sdk 打在 body 上的
       状态钩子，供插件 CSS 自行选择要不要响应；外壳不该替插件做视觉决定。
     · mm-print-root / mm-print-svg —— 样式由 io.js 在导出时动态注入，
       静态 CSS 里本来就没有（扫描器只读 .css，看不到运行时注入）。
     · tb-toolbar-btn —— 标记类，视觉由同串里的 .tb-btn 承担。
     · side-picker —— 仅出现在测试里。
     · nx-insp- —— 前缀拼接（nx-insp-top/bottom/left/right 都有定义）。 */
  const ALLOW = new Set([
    'nexus-isolated', 'nexus-view-settings',
    'mm-print-root', 'mm-print-svg',
    'tb-toolbar-btn', 'side-picker', 'nx-insp-',
    /* 与上一节 KNOWN_DEAD 同源，两处理由一致：
       · fp-name/fp-newname —— 标记钩子，视觉由 .p-input、布局由父级承担
       · md-toc-lv         —— 前缀拼接，实际是 md-toc-lv1…lv6（CSS 都有）
       · sheet/topic/boundary —— xmind 的 JSON class 字段，是数据不是样式 */
    'md-toc-lv', 'sheet', 'topic', 'boundary',
  ]);

  const missing = [...used].filter((c) => !defined.has(c) && !ALLOW.has(c));
  t('没有"代码用了但 CSS 没定义"的类名', missing.length === 0,
    missing.slice(0, 6).join(', ') || `${used.size} 个类名全部有定义`);

  /* 白名单反向校验：某项若已被真修好（CSS 里补了定义），
     就必须从表内移除 —— 否则白名单只增不减，慢慢变成"什么都往里塞"。 */
  const stale = [...ALLOW].filter((c) => defined.has(c) && c !== 'nx-insp-');
  t('白名单没有过期项（已被补样式的应移出）', stale.length === 0,
    stale.join(', ') || '无过期项');
}


console.log('\n=== 7. 死样式分类：档位类留用、真废弃清零 ===');
{
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (['node_modules', '.git', 'dist', 'target', 'build'].includes(f)) continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p); else files.push(p);
    }
  };
  walk(ROOT);
  const css = files.filter((f) => f.endsWith('.css'));
  const src = files.filter((f) => /\.(tsx|jsx|ts|js|mjs)$/.test(f)
    && !/-test\.mjs$/.test(f) && !/\.test\.(ts|tsx)$/.test(f)
    && !/plugins\/demo-module\//.test(f)
    && !/\.min\.js$/.test(f) && !/editor\//.test(f)
    && !/js\/dead-class-scan\.js$/.test(f));

  const defined = new Set();
  for (const f of css) for (const c of collectDefinedClasses(readFileSync(f, 'utf8'))) defined.add(c);
  const used = new Set();
  for (const f of src) {
    try { for (const c of collectUsedClasses(stripComments(readFileSync(f, 'utf8')))) used.add(c); } catch {}
  }
  const dead = [...defined].filter((c) => !used.has(c));

  /*
   * 死样式分两类，处理方式完全不同，不能一刀切：
   *
   * ① 档位类 —— 通过拼接或组合使用，扫描器看不见，实际在用。
   *    · 状态档：st-done / st-running / level-ok / size-sm …
   *      （className={'node-badge level-' + x}）
   *    · 修饰档：accent / ok / warn / err / sm / wide / solid / end / between
   *      （.nx-tag.accent 这种组合，单类名在源码里找不到）
   *    · 方向档：drop-before / drop-after / gap-before / horizontal / vertical
   *    这些**不能删**，删了会让对应档位直接失效。
   *
   * ② 真废弃 —— 独立引用 0 次、非档位、非拼接前缀。这类才该清。
   */
  const TIER = /^(st|level|size|drop|gap)-|(^(accent|ok|warn|err|sm|wide|solid|one|three|end|between|horizontal|vertical|hidden|joined|revealed|has-error|no-error|missing|invalid|success|failed|cancelled|file|src|val|yes|lines|cross|snippet|switch|slider|transparent|radio|is-hidden|is-on|is-fn|is-op)$)/;

  /*
   * 还有一类要留：**共享层的三前缀别名**。
   * controls.css 里 `.nx-btn, .p-btn, .mm-btn` 是并列写在同一个
   * 选择器组里的三个同义名，视觉完全相同 —— 共享层提供三个名字，
   * 插件挑一个用即可。当前只有 p-* / mm-* 被实际采用，nx-* 暂时没人用，
   * 但它们不是死代码：删掉会让"第三个可选名"消失，且整组样式仍在
   * （由 p-* 提供），删它既无收益也无从判断将来哪个插件会选它。
   * 所以列为**备用别名**，与真废弃区分开。
   */
  const ALIAS = new Set(['nx-btn', 'nx-input', 'nx-select', 'nx-textarea',
    'nx-tag', 'nx-row', 'nx-muted', 'nx-mono', 'mm-mono', 'mm-input',
    'mm-select', 'mm-chip', 'nx-bgpick', 'nx-bgpick-sw', 'nx-bgpreset',
    'nx-card', 'nx-panel',
    /* 备用通用控件：完整控件而非界面残留，新加设置项时直接挂用 */
    'nx-switch', 'nx-sep', 'nx-spinner', 'nx-loading-inline',
    'nx-loading-inner', 'nx-toasts', 'nx-check', 'nx-range',
    /* 文本截断 / 入场 / 遮罩 / 添加入口：新界面直接挂用 */
    'nx-ellipsis', 'nx-clamp', 'nx-enter', 'nx-mask', 'nx-add',
    'nx-tap',
    /* 拖拽进行中：运行时 classList 添加，静态扫描看不到 */
    'nx-drag-dragging',
    /* fpx-card：CardGrid.tsx 以数组拼接方式挂类，静态扫描看不到但确实在用 */
    'fpx-card',
    /* 对话框部件（dialog.css）与立体基元（nm-*）：
       均已就地标注为"备用"，供新界面直接挂用，不清理 */
    'nx-ok', 'nx-err', 'nx-warn', 'nx-dlg-field', 'nx-dlg-label', 'nx-dlg-err',
    'nm-raised', 'nm-raised-sm', 'nm-inset', 'nm-inset-sm', 'nm-pressed',
    /* 检查器浮层（nx-insp-*）：由 js/inspector.js 运行时拼装插入，
       静态扫描只看 .css 看不到运行时注入，与 mm-print-* 同理 */
    'nx-insp-top', 'nx-insp-bottom', 'nx-insp-left', 'nx-insp-right',
    'nx-insp-name', 'nx-insp-size', 'nx-insp-plugin', 'nx-insp-warn',
    'nx-insp-locked',
    /* react-flow 第三方类名：由库在运行时渲染，源码里搜不到是正常的 */
    'react-flow__handle', 'react-flow__edge', 'react-flow__background-pattern',
    'react-flow__controls', 'react-flow__minimap',
    /* 以拼接/模板方式挂类，静态扫描取不到但实测在用 */
    'tb-card', 'trig-card',
    /*
     * md-puml-box：类名抽成了导出常量（plantuml.js 的 PUML_BOX_CLASS），
     * DOM 上挂的是标识符，扫描器 2d 分支之前取不到字面量 → 被判死样式。
     */
    'md-puml-box']);

  /*
   * 运行时档位类：类名**经变量传递**，静态扫描在原理上取不到
   * （不是扫描器写漏了，是 `dep-badge ${st.tone}` 的值只有运行时才知道）。
   *
   *  · mute —— js/deps-manifest.js 的 DEP_STATUS 里 unused / unknown
   *    两个状态的 tone 值，经 DepsCard.tsx 的 `dep-badge ${st.tone}`
   *    与 index.js 的 `h('span.dep-badge.' + st.tone)` 挂到 DOM 上。
   *
   * 放进白名单只是"不报红"，不等于"有守卫"。所以紧随其后加了
   * 档位值 ↔ 规则 的双向断言：删掉 .dep-badge.mute 会立刻报红，
   * 而不是像 joined 修复前那样静默失效。
   */
  const RUNTIME_TONE = new Set(['mute']);

  /*
   * 前缀族：agent-flow 触发器 / 节点徽标这一族的类名
   * 多以 `${prefix}-${x}` 动态拼出（trg-icon / trg-name / kind-icon …），
   * 单看成员名在源码里找不到，但整族都在用。
   *
   * 用**前缀规则**而不是逐个枚举：逐个枚举会让白名单随新成员无限膨胀，
   * 而这正是上一节警告过的反模式。整族放行，只盯住"族外"的真废弃。
   */
  /*
   * status- 也是拼接族：NodeShell 里写的是 `status-${status}`，
   * 静态扫描只能取到 `status-` 这个碎片，于是 status-success /
   * status-error 这些**确实在用**的类会被当成死样式。
   * 与 trg- / kind- 那族同源，同样按前缀放行。
   */
  const FAMILY = /^(trg|trig|kind|upd|stack|task|insp|node|side|status)-|^md-toc-lv/;

  const realDead = dead.filter((c) => !TIER.test(c) && !ALIAS.has(c) && !FAMILY.test(c)
    && !RUNTIME_TONE.has(c));

  /*
   * 冻结基线而不是要求清零。
   *
   * 存量里剩的大部分是 agent-flow 的**拼接族残留**
   * （trg / cond-ops / pane-dot / ok-line 这类）：它们多半由
   * `${a}-${b}` 动态拼出，静态扫描只能看到碎片，无法确认有没有在用。
   * 逐个人工核实代价很高，且删错会让正在用的档位直接失效。
   *
   * 所以这里不追求清零，改为**只增不减**：新增可以，变多就报红。
   * 与"间距冻结基线"是同一套处理 —— 长期红着的断言等于没有断言。
   */
  /*
   * 40 是当前实测存量，绝大多数是 agent-flow 的拼接族残留。
   * 设为基线即"暂时接受"，但**不代表它们无害** ——
   * 需要一次专项（逐个确认拼接来源）才能真正清干净或确认可用。
   * 在那之前，这条只保证不再变多。
   */
  const DEAD_BASELINE = 41;
  t('真废弃未继续增加（不超过基线）', realDead.length <= DEAD_BASELINE,
    `当前 ${realDead.length} / 基线 ${DEAD_BASELINE}：${realDead.slice(0, 6).join(', ')}`);

  /*
   * 运行时档位类（mute）不能只靠白名单蒙混过关 —— 白名单只压住报红，
   * 压不住"样式被删了没人知道"。这里双向钉死：
   *
   *   ① 每个 tone 值都必须有 .dep-badge.<tone> 规则；
   *   ② 每条 .dep-badge.X 规则都必须对应一个还在用的 tone 值。
   *
   * 少了①：删掉 .dep-badge.mute，徽标颜色静默丢失（不报错）。
   * 少了②：改状态名后旧规则留着，永远没人能发觉它已经没人用。
   *
   * ⚠️ 必须先断言"取到了档位值"。deps-manifest.js 要是改名或改写法，
   * matchAll 返回空集 → ① 恒真，变成假绿（本项目已在 caps.js、
   * 命令一致性上栽过这类"守了个空"）。
   */
  const toneFile = join(ROOT, 'js/deps-manifest.js');
  const toneSrc = existsSync(toneFile) ? readFileSync(toneFile, 'utf8') : '';
  const tones = new Set([...toneSrc.matchAll(/tone:\s*'([^']+)'/g)].map((m) => m[1]));
  t('档位表取到了值（断言没守空）', tones.size >= 3, `取到 ${tones.size} 个：${[...tones].join(', ')}`);

  const cssText = css.map((f) => readFileSync(f, 'utf8')).join('\n');
  const noRule = [...tones].filter((x) => !new RegExp(`\\.dep-badge\\.${x}\\b`).test(cssText));
  t('每个 tone 档位都有对应规则（删了会静默失效）', noRule.length === 0,
    noRule.join(', ') || `${tones.size} 个档位全部有规则`);

  const badgeTones = new Set(
    [...cssText.matchAll(/\.dep-badge\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  const orphanTone = [...badgeTones].filter((x) => !tones.has(x));
  t('没有用不到的 badge 档位规则', orphanTone.length === 0,
    orphanTone.join(', ') || `${badgeTones.size} 条规则全部对应在用档位`);

  /* 白名单反向校验：某项若已在 CSS 里被删掉，就必须移出表内，
     否则白名单只增不减，慢慢变成"什么都往里塞"而失去意义。 */
  const staleAlias = [...ALIAS].filter((c) => !defined.has(c));
  t('备用别名白名单没有过期项', staleAlias.length === 0,
    staleAlias.join(', ') || '无过期项');

  /* 已清理的 12 处不许复活（反向钉死） */
  /* 已清理 11 处（+2 条关联的 hover / 后代规则）。
     注意 mm-mono 不在此列：它在 controls.css 的三前缀别名组里，
     属于上面的 ALIAS，mindmap 里那份独立定义才是被清理的对象。 */
  const CLEANED = ['fpx-color', 'fpx-iconitem', 'fpx-iconlist', 'fpx-iconname',
    'fpx-iconthumb', 'fpx-menu-icon', 'mm-att-ghost', 'mm-att-hi', 'mm-colors',
    'mm-grow', 'cp-actions'];
  const revived = CLEANED.filter((c) => defined.has(c));
  t('已清理的 11 处废弃样式没有复活', revived.length === 0,
    revived.join(', ') || '全部保持清理状态');

  /* ---- 最重要的一条：动效组必须真的接到了在用类名上 ----
     此前 .nx-card / .nx-panel 挂着完整一套交互反馈（悬浮高亮 + 微抬升
     + 按压 + 入场），但这两个类代码里零引用 —— 动效写了，没有一张
     卡片受益。这是死样式里最隐蔽的一类：定义完整、看着合理、实际悬空。
     现在三个插件的实际卡片类都接进来了，这条盯住别再掉。 */
  const ctrl = readFileSync(join(ROOT, 'css/controls.css'), 'utf8');
  /* 只核实在**真实存在**的卡片类：
     .mm-card 已被移除 —— mindmap 里根本没有这个类，
     此前是凭"三插件各一套"的对称性假设加进来的。 */
  /*
   * 必须查**基础 transition 组**（不含 :hover / :active），
   * 不能只查 `.p-card,` 出现次数 —— 摘掉基础组后，
   * .p-card 仍出现在 `.p-card:hover,` 里，宽松的计数照样通过。
   * 实测：用计数法做破坏验证，摘掉 .p-card 后断言仍绿，等于没验证。
   */
  /*
   * 必须先剥注释再切块：`([^{}]+)\{` 会把**注释正文**也当成选择器
   * （上一个块以 } 结束后，注释内容会被一路吃到下一个 { 为止）。
   * 上面那段说明里正好写了 ".p-card —— 外壳控件类"，
   * 于是摘掉真定义后断言仍从注释里找到 .p-card，照样通过 ——
   * 破坏验证形同虚设。与前面"扫描器扫到文档注释里的示例"是同一类坑。
   */
  const ctrlNC = stripComments(ctrl);
  const baseSel = [...ctrlNC.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => /transition:/.test(m[2]) && !/:hover|:active/.test(m[1]))
    .map((m) => m[1]).join(' ');
  for (const cls of ['nx-tap', 'nx-card']) {
    t(`动效基础组已接入 .${cls}`,
      new RegExp('\\.' + cls + '\\b').test(baseSel));
  }

  /*
   * 反向钉死：**纯容器不许有按压反馈**。
   *
   * .p-card 是布局容器（padding + 圆角 + 底色 + 阴影 + 标题样式），
   * settings 里 6 处、shell 里若干处全是静态分区，没有任何 onClick。
   * 上一版把它接进动效组，结果设置面板每个分区底板划过会抬升、
   * 点下去会缩放 —— 点了没反应却有按压动画，看着像坏了。
   *
   * 判据是"是否可交互"，不是"是不是卡片"：
   * 可点的容器要显式挂 .nx-tap，不该靠类名长得像卡片就给反馈。
   */
  const CONTAINERS = ['p-card', 'mm-card', 'nx-panel-body'];
  const wrong = CONTAINERS.filter((c) => new RegExp('\\.' + c + '\\b').test(baseSel));
  t('纯容器类不带交互反馈', wrong.length === 0,
    wrong.join(', ') || '容器与可交互已分开');

  /* .nx-tap 必须存在且有 cursor:pointer —— 显式可点击标记 */
  t('.nx-tap 已定义为可点击标记',
    /\.nx-tap\s*\{[^}]*cursor:\s*pointer/.test(ctrlNC));
  /*
   * .fpx-card **不接**共享层动效组 —— 这是我上一版的错误整合，
   * 本轮返工撤掉。
   *
   * 当时看它 hover 写了 translateY(-1px)，以为是重复实现，
   * 于是删掉、改由共享层统一提供。实际 project-group 有自己
   * **完整的一套三态**：常态外凸(--sh-out-sm) → 悬停抬升(--sh-out-md)
   * → 按下内凹(--sh-in-sm)，并且注释写明三态几何必须一致，
   * 观感才像"同一块材料被按下去"。
   * 共享层只有 hover/active 两态，且 active 是 scale(.97)，
   * 接过来等于把那套三态砍成两种手感。
   *
   * 教训：先读被整合方自己的注释再动手 —— 它写在那儿是有原因的。
   */
  t('共享层动效组不含 .fpx-card（保留其自有三态）',
    !/\.fpx-card\b/.test(baseSel));
}

console.log('\n=== 8. 幽灵规则（CSS 定义了、代码没用）：只增不减 ===');
{
  /*
   * 与上一节是**相反的一维**：
   *   第 7 节盯 dead   —— 代码用了、CSS 没定义（挂了类名没样式）
   *   本节   盯 orphan —— CSS 定义了、代码没用（写了样式没人挂）
   *
   * 此前只有前者有常驻断言，后者全靠临时脚本跑，于是死规则能长期积累
   * （实测存量 125 处）。本轮补上，口径与上一节一致：**不追求清零，
   * 只冻结基线**。
   *
   * 为什么不追求清零：存量里有大量"组合选择器里的修饰类"
   * （.nx-row.end / .task-bar-in.cancelled / .nx-tag.accent），
   * 它们命运跟着父类走，父类是备用档位时它们也是备用；
   * 逐个核实代价极高，而误删会让正在用的档位**静默失效**（不报错）。
   */
  /*
   * 必须**自己跑一次**扫描：上面第 1/2 节的 r 在各自的块作用域里，
   * 这里取不到（写成裸 orphan 会 ReferenceError，整份测试直接崩）。
   */
  const or = scanDeadClasses({ root: HERE, cssFiles: CSS_FILES, excludeSrc: EXCLUDE_SRC });
  const { orphan, defined: orDefined, forms, classLiterals } = or;

  const EXTERNAL = [/^km-/, /^react-flow__/, /^hljs/];
  // 备用档位：跨插件共享、供新界面直接挂用，文档里已就地标注"保留"
  const RESERVED = [/^nx-/, /^nm-/, /^p-/];
  // md 插件整体按约定先不动
  const MD = [/^md-/];

  /*
   * 动态拼接豁免 —— 这是**误删防线**，不是可选优化。
   *
   * 模板串 `task-pill st-${status}` / `node-card size-${size}` 在源码里
   * 永远搜不到完整类名 "st-success"、"size-lg"，但运行时真会生成。
   * 按"`!used.has(c)`"判死的扫描器会把它们全报成幽灵规则；
   * 照着注释停用，节点状态色、徽章色、卡片尺寸会整片失效且不报错。
   *
   * agent-flow 实测踩到：22 处报告里 7 处是这类误判。
   */
  const srcText = [...walkFiles(ROOT, ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.html', '.rs'])]
    .filter((f) => !/\.min\.js$/.test(f))
    .map((f) => { try { return readFileSync(f, 'utf-8'); } catch { return ''; } })
    .join('\n');
  const dynPrefixes = new Set(
    [...srcText.matchAll(/([A-Za-z][\w]*)-\$\{/g)].map((m) => m[1]),
  );
  const isDynamic = (c) => {
    const i = c.indexOf('-');
    return i > 0 && dynPrefixes.has(c.slice(0, i));
  };

  /*
   * 豁免三：修饰类（**从不独立出现**、只在 `.父.子` 里挂过的类）。
   *
   * `.nx-row.end` / `.task-bar-in.cancelled` / `.nx-btn.solid` 这类是父类的
   * 状态档，命运跟着父类走 —— 父类在用它就是"暂未启用的档位"，
   * 父类是备用档位它同样是备用。把它们当独立幽灵规则停用，
   * 等于悄悄删掉父类的一档：不报错、不红，只有某个状态没了观感才发现。
   *
   * 实测这一条就豁免掉 28 处（占未豁免存量的绝大部分），
   * 是存量从 42 降到 0 的主因 —— 也就是说**此前报的 42 处里绝大多数
   * 本来就不该报**。
   */
  const isModifier = (c) => {
    const f = forms.get(c);
    return !!f && f.solo === 0 && f.parents.size > 0;
  };
  /*
   * 豁免四：类名上下文里的字符串字面量（查表 / 类名变量）。
   *
   *   const ARG_CLASS = { val: 'node-arg', op: 'node-arg is-op', ... };
   *   const editCls = isArea ? 'node-arg-area nodrag nopan' : 'node-arg-in nodrag nopan';
   *   const cls = `${className}${...}${part.key ? ' node-arg-port' : ''}`;
   *
   * 源码里没有 `class="node-arg"`，只按 class=/className= 提取的扫描器
   * 会把它们全判成死规则；照着停用会弄坏**正在用**的样式
   * （参数格子的下凹观感、多行参数框），且不报错。
   *
   * ⚠️ 最讽刺的一点：ArgCell.tsx 里那段注释写明作者**刻意**把
   *    `role-${p.role}` 改写成查表，就是为了让"类名必须先在 CSS 里定义"
   *    这条守卫能抓到拼错的类名。而反向守卫（本节）当时还不存在，
   *    查表写法反而被判成死规则 —— 正好抵消了作者的用心。
   *    现在两维都认它，改写成查表的收益才真正兑现。
   */
  const isInClassLiteral = (c) => classLiterals.has(c);

  const orphanRaw = orphan.filter(
    (c) => !isDynamic(c)
      && !EXTERNAL.some((r) => r.test(c))
      && !RESERVED.some((r) => r.test(c))
      && !MD.some((r) => r.test(c)),
  );
  const orphanRest = orphanRaw.filter((c) => !isModifier(c) && !isInClassLiteral(c));

  /*
   * 基线归零。
   *
   * 42 → 0 不是靠放宽口径糊过去的，而是**逐个核实**后的结果：
   *   · 28 处是修饰类（命运跟父类，本来就不该报）→ 扫描器层面豁免
   *   ·  5 处是类名查表/变量写法（真的在用）→ 扫描器层面豁免
   *   ·  7 处是真死规则 → 逐个注释停用并备注（见下）
   *   ·  2 处随上述一起消失
   *
   * ⚠️ 归零后这条就成了硬闸：**新增一处幽灵规则立刻报红**。
   *    若某次新增确属"先写样式后接代码"，请连代码一起提交，
   *    或走修饰类/查表写法让扫描器认得出来 —— 不要上调这个数字。
   */
  const ORPHAN_BASELINE = 0;
  t('幽灵规则未继续增加（不超过基线）', orphanRest.length <= ORPHAN_BASELINE,
    `当前 ${orphanRest.length} / 基线 ${ORPHAN_BASELINE}：${orphanRest.slice(0, 8).join(', ')}`);

  /*
   * 元断言：两条新豁免必须**真的减掉了东西**，而不是空跑。
   *
   * ⚠️ 曾把同类元断言写成 `dynPrefixes.size >= 0`（永远为真），
   *    结果口径失配时防线静默失效、误删事故照旧。这里改成看**实际豁免量**。
   */
  const modCut = orphanRaw.filter(isModifier);
  const litCut = orphanRaw.filter((c) => !isModifier(c) && isInClassLiteral(c));
  t('修饰类豁免有效', modCut.length > 0, `豁免 ${modCut.length} 处：${modCut.slice(0, 5).join(', ')}`);
  t('类名查表豁免有效', litCut.length > 0, `豁免 ${litCut.length} 处：${litCut.slice(0, 5).join(', ')}`);

  /*
   * 定向元断言：node-arg-port **必须**被认成在用。
   * 它藏在 `${part.key ? ' node-arg-port' : ''}` 里，是提取逻辑最容易漏的一档
   * （整段剥 `${...}` 会把它剥没；不处理空串 `''` 会让引号配对错位）。
   * 漏了它就会被当成幽灵规则停用 → 参数端口样式失效且不报错。
   */
  t('模板串内的类名也被认成在用', isInClassLiteral('node-arg-port'),
    'node-arg-port（ArgCell.tsx 的 cls 模板串）');

  /*
   * 已停用的 7 处：必须**停用着、且还能加回来**。
   *
   * 只钉"没在 defined 里"是不够的 —— 直接删掉也满足那条，
   * 而用户明确要求"先注释停用并备注，万一删错了能直接加回来"。
   * 所以两条一起钉：源码里还在（可恢复）+ 不参与解析（确已停用）。
   */
  const AF = rd('plugins/agent-flow/styles.css');
  const STOPPED = ['add-row', 'kind-icon', 'trg', 'switch', 'side-sub', 'key-row', 'task-item'];
  /*
   * ⚠️ 必须钉**规则体**（`.类名 {`），不能只钉"出现过这个字符串"。
   * 第一版写成 `\.add-row[\s,{:.]`，结果把停用备注的标题
   * `/* [幽灵规则 styles.css:1043] .add-row *\/` 也算成了"还在" ——
   * 实测把规则体整段删掉后这条断言**依然全绿**，等于没断言。
   */
  const stillThere = STOPPED.filter((c) => new RegExp(`\\.${c}\\s*\\{`).test(AF));
  const stillActive = STOPPED.filter((c) => orDefined.has(c));
  t('停用的 7 处幽灵规则仍保留在源码里（可加回）', stillThere.length === STOPPED.length,
    `保留 ${stillThere.length}/${STOPPED.length}${stillThere.length < STOPPED.length ? ` 缺失：${STOPPED.filter((c) => !stillThere.includes(c)).join(', ')}` : ''}`);
  t('停用的 7 处幽灵规则确实未参与解析', stillActive.length === 0,
    stillActive.length ? `仍在生效：${stillActive.join(', ')}` : '全部已停用');

  /*
   * 元断言：豁免逻辑必须**真的会豁免**，而不是空跑。
   *
   * ⚠️ 曾写成 `dynPrefixes.size >= 0` —— 那永远为真，等于没有断言；
   *    若模板写法变了（正则失配），豁免静默失效、误删事故照旧。
   *    所以这里造一个必然命中的样例，验证 isDynamic 确实返回 true。
   */
  if (dynPrefixes.size > 0) {
    const probe = `${[...dynPrefixes][0]}-__probe__`;
    t('动态拼接豁免有效', isDynamic(probe), `样例 ${probe} 被豁免`);
    t('动态拼接豁免不过度', !isDynamic('zzz-nomatch'), '无拼接前缀的类不被豁免');
  } else {
    t('无拼接类时豁免函数仍可用', isDynamic('a-b') === false, '不误伤普通类');
  }

  // 元断言：扫描范围得有效，否则 orphan 为空、上面那条永远通过
  t('幽灵规则扫描范围有效', orphan.length > 0 && orDefined.size > 100,
    `orphan ${orphan.length} / defined ${orDefined.size}`);
}

/* ============================================================
 * 第 X 节：剥注释只此一份
 * ------------------------------------------------------------
 * 「注释和代码共用一套字符集，正则分不清」在本项目反复酿成误报：
 *   注释里的类名 → 死类名扫描形同虚设
 *   注释里的旧写法 → 核对远端时误判"修复没生效"
 *   注释停用的幽灵规则 → 令牌守卫把停用块当真规则（.kind-btn 那次）
 *
 * 实现已抽到 test-scan-utils.mjs。这里盯住两件事：
 *   1. 共用实现本身是对的（语义自检）
 *   2. 不许再新增内联副本（冻结基线，只减不增）
 */
{
  const mod = await import('./test-scan-utils.mjs');
  const { stripComments, stripCommentsJs } = mod;

  t('共用模块导出剥注释', typeof stripComments === 'function' && typeof stripCommentsJs === 'function');

  // 语义：替换成空格而不是空串 —— 空串会把 `a/*x*/b` 粘成 `ab`
  t('剥注释用空格不粘连', stripComments('a/*x*/b') === 'a b', JSON.stringify(stripComments('a/*x*/b')));
  t('多行块注释可剥', stripComments('.a{\n/* c1\nc2 */\ncolor:red}').includes('color:red')
    && !stripComments('.a{\n/* c1\nc2 */\ncolor:red}').includes('c1'));
  // 只剥块注释，不动 // —— CSS 无 //，JS 里的 URL 更不能被吞
  t('stripComments 不吞行注释', stripComments('a // b') === 'a // b');
  t('stripCommentsJs 剥行注释', stripCommentsJs('a // b') === 'a ' , JSON.stringify(stripCommentsJs('a // b')));

  /* 冻结基线：存量 55 处：TS 测试 21 处（跑不起来）+ 3 处刻意豁免（见下）+ 共用模块自身 2 处，逐个迁移风险不小，
   * 但**绝不能再多**。新增一份就报红，并指明改用共用模块。
   * 判据排除权威实现本身与本文件（守卫自身含该正则字面量）。 */
  // 匹配源码文本 /\/\*[\s\S]*?\*\//
  const INLINE = /\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//g;
  // 自检：该正则必须能命中权威实现，否则说明判据写错、断言空跑
  const selfTxt = readFileSync('test-scan-utils.mjs', 'utf8');
  t('内联判据自检有效', INLINE.test(selfTxt), '判据必须在权威实现上命中');
  t('判据不误伤无关文本', !INLINE.test('const x = 1; // nothing here'), '普通文本不命中');

  const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.tauri', '__pycache__']);
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(d, e.name)); continue; }
      if (!/\.(mjs|js|ts|tsx)$/.test(e.name)) continue;
      const abs = join(d, e.name);
      if (abs === join(HERE, 'test-scan-utils.mjs') || abs === join(HERE, 'dead-class-test.mjs')) continue;
      let txt;
      try { txt = readFileSync(join(d, e.name), 'utf8'); } catch { continue; }
      const hits = txt.match(INLINE);
      if (hits) total += hits.length;
    }
  };
  walk(HERE);

  const BASELINE = 55;
  t('剥注释不再新增内联副本', total <= BASELINE,
    total > BASELINE
      ? `实测 ${total} 处 > 基线 ${BASELINE}；新增的请改用 import { stripComments } from './test-scan-utils.mjs'`
      : `${total} / ${BASELINE}（存量收敛中）`);
  t('内联副本统计范围有效', total > 0, `实测 ${total} 处`);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
