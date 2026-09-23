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
  findTruncatedRules, scanDeadClasses,
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
  t('模板串字面量部分', collectUsedClasses('className={`fpx-link-row ${d.state}`}').has('fpx-link-row'));
  t('模板串 ${} 不误取', !collectUsedClasses('className={`a ${undefinedVar}`}').has('undefinedVar'));
  t('三元里的状态类 open',
    collectUsedClasses("className={`fpx-link-arrow${x ? ' open' : ''}`}").has('open'));
  t('hyperscript', collectUsedClasses("h('div.mm-foo.bar', x)").has('mm-foo'));
  t('classList.add', collectUsedClasses("el.classList.add('is-on')").has('is-on'));
  t('属性访问不误取', !collectUsedClasses('a.map(x => x.length)').has('map'));
  t('拼接前缀 level- 不误取',
    !collectUsedClasses('className={`node-dot level-${x}`}').has('level-'));
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
    'nexus-adapted', 'tb-card', 'trig-card']);

  /*
   * 前缀族：agent-flow 触发器 / 节点徽标这一族的类名
   * 多以 `${prefix}-${x}` 动态拼出（trg-icon / trg-name / kind-icon …），
   * 单看成员名在源码里找不到，但整族都在用。
   *
   * 用**前缀规则**而不是逐个枚举：逐个枚举会让白名单随新成员无限膨胀，
   * 而这正是上一节警告过的反模式。整族放行，只盯住"族外"的真废弃。
   */
  const FAMILY = /^(trg|trig|kind|upd|stack|task|insp|node|side)-/;

  const realDead = dead.filter((c) => !TIER.test(c) && !ALIAS.has(c) && !FAMILY.test(c));

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
  const DEAD_BASELINE = 40;
  t('真废弃未继续增加（不超过基线）', realDead.length <= DEAD_BASELINE,
    `当前 ${realDead.length} / 基线 ${DEAD_BASELINE}：${realDead.slice(0, 6).join(', ')}`);

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
  for (const cls of ['p-card', 'fpx-card']) {
    t(`动效基础组已接入 .${cls}`,
      new RegExp('\\.' + cls + '\\b').test(baseSel));
  }
  /* project-group 里那条一模一样的重复 hover 不许复活 */
  const pg = readFileSync(join(ROOT, 'plugins/project-group/style.css'), 'utf8');
  t('project-group 未重复实现悬浮抬升',
    !/\.fpx-card:hover\s*\{[^}]*translateY\(-1px\)/.test(pg));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
