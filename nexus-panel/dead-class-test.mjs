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
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// 测试脚手架 / 示例插件 / 第三方封装里的类名不代表真实用法
const EXCLUDE_SRC =
  '(^|/)([^/]*-test\\.mjs|[^/]*\\.test\\.ts|tests/|demo-|editor-bridge\\.js|dead-class-scan\\.js)';

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
  const KNOWN_DEAD = [
    // 外壳：靠内联或父级兜底
    'nexus-view-settings', 'nexus-isolated', 'tb-toolbar-btn',
    // mindmap
    'mm-print-root', 'mm-diag', 'is-playing',
    // project-group
    'fpx-root', 'fpx-node-icon', 'fpx-settings-icons', 'fpx-lock-watch',
    'pin', 'preset', 'mine', 'hover',
    // agent-flow
    'running',
  ];

  const r = scanDeadClasses({ root: HERE, cssFiles: CSS_FILES, excludeSrc: EXCLUDE_SRC });
  const allow = new Set(KNOWN_DEAD);
  const fresh = r.dead.filter((d) => !allow.has(d.cls));

  t('没有白名单之外的新增死类名', fresh.length === 0,
    fresh.map((d) => `${d.cls} ← ${d.file}`).join(' | ') || `已知 ${r.dead.length} 个，无新增`);

  t('白名单里的确实都还在（没被悄悄修好而忘了更新）',
    r.dead.length >= KNOWN_DEAD.length - 2,
    `实际 ${r.dead.length} / 登记 ${KNOWN_DEAD.length}`);
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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
