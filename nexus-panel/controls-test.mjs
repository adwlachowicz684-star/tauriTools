/**
 * 通用控件测试
 * ============================================================
 * 之前每个界面各写各的按钮 / 输入框 / 下拉：.p-btn（167 处引用）、
 * .mm-btn（67 处）、.mm-input / .mm-select / .fpx-select ……
 * 语义完全一样却有多份实现，代价是"改一处漏一处"。
 *
 * 现在统一到 css/controls.css，方式是**选择器组**：
 * .nx-btn / .p-btn / .mm-btn 共用一条规则，现有 DOM 一个都不用改。
 *
 * 这里盯四件事：
 *   1. 统一层的实现本身对不对（尺寸档位、状态、主题变量）
 *   2. 重复定义清理干净没有（同一条规则不该在两处都写）
 *   3. 各界面**有意保留的差异**是否还在（不能为了统一而改变既有观感）
 *   4. 引了控件的文档能不能拿到 controls.css
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const controls = read('css/controls.css');
const shell = read('css/neumorphism.css');
const mm = read('plugins/mindmap/styles.css');

/* 按规则块解析：先剥注释，再用 `}` 切分，取 selector 里含目标类名的那块。
   不能直接用 `\.nx-btn\s*\{` 去匹配 —— 选择器组是多行的
   （`.nx-btn,\n.p-btn,\n.mm-btn {`），目标类名后面跟的是逗号不是花括号。 */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css) => strip(css)
  .split('}')
  .map((chunk) => {
    const i = chunk.lastIndexOf('{');
    return i < 0 ? null : { sel: chunk.slice(0, i), body: chunk.slice(i + 1) };
  })
  .filter(Boolean);

/** 取 selector **恰好以**该类结尾的规则体（避免 .mm-btn.icon 被误算进来） */
const ruleOf = (css, cls) => {
  const r = rules(css).find((x) => x.sel.split(',').some((p) => p.trim().endsWith(cls)));
  return r ? r.body : '';
};
/** 取 selector 里**恰好**等于该类的那条规则的完整 selector 文本 */
const groupOf = (css, cls) => {
  const r = rules(css).find((x) => x.sel.split(',').some((p) => p.trim() === cls));
  return r ? r.sel : '';
};

console.log('=== 1. 选择器组是否真的合并了 ===');
{
  const g = groupOf(controls, '.nx-btn');
  t('.nx-btn / .p-btn / .mm-btn 在同一条规则里',
    /\.nx-btn/.test(g) && /\.p-btn/.test(g) && /\.mm-btn/.test(g),
    g.replace(/\s+/g, ' ').slice(0, 80));
  const gi = groupOf(controls, '.nx-input');
  t('.nx-input / .p-input / .mm-input / .mm-select 在同一条规则里',
    /\.nx-input/.test(gi) && /\.p-input/.test(gi) && /\.mm-input/.test(gi) && /\.mm-select/.test(gi),
    gi.replace(/\s+/g, ' ').slice(0, 90));
}

console.log('\n=== 2. 尺寸档位走变量（新增一档不用重写整条规则）===');
{
  const base = ruleOf(controls, '.nx-btn');
  t('按钮基础档定义 --ctl-h', /--ctl-h:\s*38px/.test(base));
  t('高度/内边距/字号都引用 --ctl-*',
    /height:\s*var\(--ctl-h\)/.test(base)
    && /padding:\s*0 var\(--ctl-pad\)/.test(base)
    && /font-size:\s*var\(--ctl-fs\)/.test(base));
  /* .sm 只覆盖变量 —— 这是"加一档只改变量"的前提 */
  const sm = ruleOf(controls, '.nx-btn.sm');
  t('.sm 档只覆盖变量（不重写整条规则）',
    /--ctl-h:\s*28px/.test(sm) && !/box-shadow|border-radius/.test(sm),
    sm.replace(/\s+/g, ' ').trim().slice(0, 70));
}

console.log('\n=== 3. 状态与主题变量 ===');
{
  const css = controls;
  t('hover 只换色不加粗（并排按钮字重一变会抖）',
    /:hover\s*\{[^}]*color:\s*var\(--accent/.test(css)
    && !/:hover\s*\{[^}]*font-weight/.test(css.replace(/\.nx-btn\.solid:hover[^}]*\}/g, '')));
  t('disabled 态有处理', /:disabled\s*\{[^}]*opacity/.test(css));
  t('实底按钮文字色用 --badge-fg（不写死 #fff）',
    /\.nx-btn\.solid\s*\{[^}]*color:\s*var\(--badge-fg/.test(css)
    && !/\.nx-btn\.solid\s*\{[^}]*#fff/i.test(css));
  t('阴影全部走 --sh-* 变量',
    !/box-shadow:\s*[^;]*rgba?\(/.test(css.replace(/--sh-[a-z-]+:[^;]+;/g, '')));
  t('没有写死颜色（除必要的中性兜底）',
    !/:\s*#[0-9a-f]{3,8}/i.test(css.replace(/--sh-cast[^;]+;/g, ''))
    || /:\s*#[0-9a-f]{3,8}/i.test(css) === false);
  t('圆角走 --r-* 变量', !/border-radius:\s*\d+px/.test(css));
  t('时长走 --dur-* 变量', !/transition:[^;]*\b\d+m?s\b/.test(css));
}

console.log('\n=== 4. 重复定义清理干净 ===');
{
  /* 同一条规则若在两处都写完整实现，改一处就会漏另一处 ——
     这是本次要根治的问题，所以直接查"完整实现的重复" */
  const dupBtn = /\.mm-btn\s*\{[^}]*box-shadow/.test(mm);
  t('mindmap 不再自己写 .mm-btn 的完整实现', !dupBtn);
  t('mindmap 不再自己写 .mm-input / .mm-select',
    !/\.mm-input\s*\{/.test(mm) && !/\.mm-select\s*\{/.test(mm));
  /* 外壳的 .p-btn 完整实现也应已移除 */
  t('外壳不再自己写 .p-btn 的完整实现',
    !/\.p-btn\s*\{[^}]*height/.test(shell));
}

console.log('\n=== 5. 有意保留的差异还在（不能为了统一改观感）===');
{
  t('外壳 .p-input 仍撑满宽度（外壳表单是竖排撑满的）',
    /width:\s*100%/.test(ruleOf(shell, '.p-input')));
  t('外壳 .p-input 仍用更深的内凹',
    /--sh-in-lg/.test(ruleOf(shell, '.p-input')));
  t('外壳 .p-row 仍默认换行、间距 12px',
    /flex-wrap:\s*wrap/.test(ruleOf(shell, '.p-row'))
    && /gap:\s*12px/.test(ruleOf(shell, '.p-row')));
  t('外壳 .p-muted 仍用更弱的 --text-mute',
    /--text-mute/.test(ruleOf(shell, '.p-muted')));
  t('外壳 .p-tag 仍是胶囊圆角（与 .mm-chip 方角有意区分）',
    /--r-pill/.test(ruleOf(shell, '.p-tag')));
  /* 脑图的紧凑档：28px */
  /* .mm-btn 同时出现在基础组（38px）和紧凑组（28px）里 —— 这是刻意的：
     基础组给它全部基础样式，紧凑组只覆盖尺寸变量把档位降下来。
     所以这里要查"有没有一条规则把它设成 28px"，而不是第一条。 */
  const mmBtnH = rules(controls)
    .filter((x) => x.sel.split(',').some((p) => p.trim() === '.mm-btn'))
    .map((x) => x.body).join(';');
  t('脑图按钮走紧凑档 28px', /--ctl-h:\s*28px/.test(mmBtnH));
}

console.log('\n=== 6. 各文档都能拿到 controls.css ===');
{
  const walk = (dir, out = []) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(d.name)) continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  const reaches = (file, depth = 0) => {
    if (depth > 3) return false;
    const txt = readFileSync(file, 'utf8');
    if (/controls\.css/.test(txt)) return true;
    for (const m of txt.matchAll(/@import\s+url\(['"]?([^'")]+)['"]?\)/g)) {
      const n = join(dirname(file), m[1]);
      if (existsSync(n) && reaches(n, depth + 1)) return true;
    }
    return false;
  };
  /* 用了 .mm-btn / .p-btn 之类控件的插件，其样式必须能拿到 controls.css */
  const plugins = ['plugins/mindmap', 'plugins/project-group', 'plugins/agent-flow', 'plugins/settings'];
  const missing = plugins.filter((d) => {
    const dir = join(HERE, d);
    const cssFiles = walk(dir).filter((c) => /\.css$/.test(c));
    // JS/TS 里 import 的也算
    const jsFiles = walk(dir).filter((c) => /\.(jsx?|tsx?)$/.test(c));
    const entries = new Set(cssFiles);
    for (const j of jsFiles) {
      for (const m of readFileSync(j, 'utf8').matchAll(/import\s+['"]([^'"]+\.css)['"]/g)) {
        const p2 = join(dirname(j), m[1]);
        if (existsSync(p2)) entries.add(p2);
      }
    }
    return ![...entries].some((c) => reaches(c));
  });
  t('四个插件都能拿到 controls.css', missing.length === 0,
    missing.join(', ') || '全部已接上');
  t('外壳主样式引入 controls.css', /controls\.css/.test(shell));
}

console.log('\n=== 7. 引用计数（说明统一的价值）===');
{
  const count = (cls) => {
    let n = 0;
    const walk = (dir) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git'].includes(d.name)) continue;
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (/\.(jsx?|tsx?|html)$/.test(p)) {
          n += (readFileSync(p, 'utf8').match(new RegExp(`\\b${cls}\\b`, 'g')) || []).length;
        }
      }
    };
    walk(HERE);
    return n;
  };
  const pb = count('p-btn'), mb = count('mm-btn');
  t(`统一覆盖了 ${pb} 处 .p-btn + ${mb} 处 .mm-btn`, pb > 0 && mb > 0,
    '这些引用一个都不用改，却共用同一份实现');
}

console.log('\n=== 8. 反馈类：空状态 / 加载 / Toast ===');
{
  /* 这三类此前比按钮还散：空状态 6 套实现（.empty / .drawer-empty /
     .empty-hint / .cond-empty / .task-empty / .mm-vthumb-empty / .fpx-empty），
     加载态外壳 .spinner + .plugin-loading、脑图 .mm-loading 各一份。
     统一策略同按钮：基础表现进选择器组，尺寸差异留在各自样式里。 */

  const gEmpty = groupOf(controls, '.nx-empty');
  t('空状态合并进选择器组（含各插件的 6 个类名）',
    ['\.nx-empty', '\.empty', '\.empty-hint', '\.cond-empty',
      '\.task-empty', '\.mm-vthumb-empty', '\.fpx-empty']
      .every((c) => new RegExp(c).test(gEmpty)),
    gEmpty.replace(/\s+/g, ' ').slice(0, 100));
  t('空状态基础表现是弱化色 + 行高 + 居中',
    /color:\s*var\(--text-dim\)/.test(ruleOf(controls, '.nx-empty'))
    && /line-height/.test(ruleOf(controls, '.nx-empty'))
    && /text-align:\s*center/.test(ruleOf(controls, '.nx-empty')));
  t('大空态 .nx-empty.lg 全屏居中',
    /height:\s*100%/.test(ruleOf(controls, '.nx-empty.lg'))
    && /justify-content:\s*center/.test(ruleOf(controls, '.nx-empty.lg')));
  t('.nx-empty-mark 有底板与立体阴影（原来 .empty-mark 有，不能丢）',
    /background:\s*var\(--surface\)/.test(ruleOf(controls, '.nx-empty-mark'))
    && /box-shadow:\s*var\(--sh-out-lg\)/.test(ruleOf(controls, '.nx-empty-mark')));

  /* 转圈：与 .spinner 同组，且尊重减少动效 */
  const gSpin = groupOf(controls, '.nx-spinner');
  t('.nx-spinner / .spinner 在同一条规则里',
    /\.nx-spinner/.test(gSpin) && /\.spinner/.test(gSpin));
  t('转圈动画在减少动效时放慢（转圈是最典型的 vestibular 触发源）',
    /prefers-reduced-motion[\s\S]{0,200}nx-spinner[\s\S]{0,80}animation-duration/.test(controls));
  t('覆盖式加载层 .nx-loading 有淡出态',
    /\.nx-loading\.done\s*\{[^}]*opacity/.test(controls));

  /* Toast：.ok 必须是状态色 --ok，不能是环境色 */
  const gToast = groupOf(controls, '.nx-toast');
  t('.nx-toast / .toast 在同一条规则里',
    /\.nx-toast/.test(gToast) && /\.toast/.test(gToast), gToast.replace(/\s+/g, ' '));
  t('toast 底板用 --surface-overlay（不是 --surface）',
    /background:\s*var\(--surface-overlay\)/.test(ruleOf(controls, '.nx-toast')));
  t('toast 成功色是 --ok 而不是环境色',
    /\.toast\.ok\s*\{[^}]*--ok/.test(controls)
    && !/\.toast\.ok\s*\{[^}]*--env/.test(controls));
  t('Toast 容器不拦点击（右下角不该吃掉操作）',
    /#toasts\s*\{[^}]*pointer-events:\s*none/.test(controls));

  /* 重复定义清理 */
  t('外壳不再自己写 .toast 的完整实现',
    !/\.toast\s*\{[^}]*max-width/.test(shell));
  t('外壳不再自己写 .spinner（已移到 controls）',
    !/\.spinner\s*\{[^}]*animation/.test(shell));
  t('外壳不再自己写 .empty / .empty-mark',
    !/\.empty\s*\{[^}]*height:\s*100%/.test(shell)
    && !/\.empty-mark\s*\{/.test(shell));

  /* DOM 侧：加载层要同时挂两类，只挂一个会丢掉一整层基础样式 */
  const hostJs = read('js/host.js');
  t('加载层同时挂 .nx-loading 与 .plugin-loading',
    /nx-loading plugin-loading|plugin-loading nx-loading/.test(hostJs));
  t('大空态改用 .nx-empty.lg / .nx-empty-mark',
    /nx-empty lg/.test(hostJs) && /nx-empty-mark/.test(hostJs));

  /* 各插件的空状态元素也要挂上 .nx-empty，否则拿不到统一层 */
  const mmJs = read('plugins/mindmap/panels.js');
  t('脑图空状态元素挂了 .nx-empty', /nx-empty\.mm-vthumb-empty/.test(mmJs));
  const pgTsx = read('plugins/project-group/components/CardGrid.tsx');
  t('项目组空状态元素挂了 .nx-empty', /nx-empty fpx-empty/.test(pgTsx));
  const afInsp = read('plugins/agent-flow/components/Inspector.tsx');
  t('agent-flow 空状态元素挂了 .nx-empty', /nx-empty empty-hint/.test(afInsp));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
