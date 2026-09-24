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
import { stripComments } from './js/dead-class-scan.js';

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
  /* 判据必须是「有没有写完整实现」，不能是「有没有这条选择器」。
     原写法 `!/\.mm-select\s*\{/` 会误判：选择器组 `.mm-input, .mm-select {`
     的最后一项后面**本来就跟 `{`**，于是「只改变量」的合规写法也被判成重复。
     而 mindmap 那条恰恰是合规的 —— 它只覆盖 --ctl-h / --ctl-pad / --ctl-fs
     三个变量（紧凑布局该是 28px）。真正要拦的是把实现再抄一遍。 */
  const mmCtl = rules(mm).filter((r) =>
    r.sel.split(',').some((x) => /\.mm-(input|select)$/.test(x.trim())));
  const mmDup = mmCtl.filter((r) =>
    /background|border(?!-radius)|padding|box-shadow|font-size|height/.test(r.body));
  t('mindmap 不再自己写 .mm-input / .mm-select 的完整实现',
    mmDup.length === 0,
    mmDup.length ? mmDup.map((r) => r.body.trim().slice(0, 60)).join(' | ')
      : `只改变量，${mmCtl.length} 条合规`);
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

console.log('\n=== 9. 观感一致性：禁用态 / 键盘焦点 ===');
{
  /* 禁用态此前有 6 种弱化值：.45 / .4 / .5 / .38 / .35 / .3。
     差异不是设计出来的，是各写各的 —— 表现就是"这个界面的灰按钮比
     那个界面更淡"。统一成一个变量后，调整观感只改一处。 */
  const allCss = ['css/controls.css', 'css/neumorphism.css', 'css/dialog.css',
    'plugins/mindmap/styles.css', 'plugins/agent-flow/styles.css',
    'plugins/project-group/style.css'].map((f) => ({ f, text: read(f) }));

  const hardOpacity = [];
  for (const { f, text } of allCss) {
    for (const m of text.matchAll(/:disabled[^{}]*\{([^}]*)\}/g)) {
      /* :not(:disabled) 里也有 ":disabled" 子串 —— 那是**启用**态，
         不是禁用态。不排除的话会把 .x:hover:not(:disabled){opacity:1}
         判成"禁用态写死了值"。 */
      /* 注意 m[0] 是从 ":disabled" 开始切的，":not(" 在它**前面**，
         所以要看 m.index 之前的字符，不能查 m[0]。 */
      if (/:not\(\s*$/.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
      const body = m[1];
      const om = /opacity\s*:\s*([^;]+)/.exec(body);
      if (!om) continue;
      const v = om[1].trim();
      if (!/var\(--ctl-disabled-opacity\)/.test(v)) {
        hardOpacity.push(`${f}: ${v}`);
      }
    }
  }
  t('禁用态弱化值统一走 --ctl-disabled-opacity',
    hardOpacity.length === 0, hardOpacity.join(' | ').slice(0, 120) || '6 种写法已合并为一个变量');

  t('禁用态变量在控件层定义',
    /--ctl-disabled-opacity\s*:\s*\.?\d/.test(controls)
    && /--ctl-disabled-cursor\s*:\s*not-allowed/.test(controls));

  /* cursor：default 只表示"没有特殊指针"，禁用态要传达的是"点不了" */
  const cursorDefault = [];
  for (const { f, text } of allCss) {
    for (const m of text.matchAll(/:disabled[^{}]*\{([^}]*)\}/g)) {
      if (/cursor\s*:\s*default/.test(m[1])) cursorDefault.push(f);
    }
  }
  t('禁用态光标统一 not-allowed（不用 default）',
    cursorDefault.length === 0, cursorDefault.join(', ') || '全部 not-allowed');

  /* 键盘焦点环：此前按钮一个都没有 —— Tab 过去看不出当前项 */
  t('按钮有键盘焦点环',
    /\.nx-btn:focus-visible[^{]*\{[^}]*outline/.test(controls),
    (controls.match(/\.nx-btn:focus-visible[^{]*\{[^}]*\}/) || ['无'])[0].replace(/\s+/g, ' ').slice(0, 70));
  t('焦点环用 outline 而非 box-shadow（后者会被立体阴影覆盖）',
    !/\.nx-btn:focus-visible[^{]*\{[^}]*box-shadow/.test(controls));
  t('输入框键盘进来时也有环（与指针点击区分）',
    /:focus-visible[^{]*\{[^}]*outline/.test(controls));
  t('用 :focus-visible 而非 :focus（鼠标点击不该出现环）',
    /:focus-visible/.test(controls) && !/\.nx-btn:focus\s*[,{]/.test(controls));

  /* agent-flow 的自建控件此前也没有环 */
  const af = read('plugins/agent-flow/styles.css');
  t('agent-flow 自建控件补了焦点环',
    /\.tab-input:focus-visible/.test(af) && /\.kind-btn:focus-visible/.test(af)
    && /\.cond-op-select:focus-visible/.test(af) && /\.hist-search:focus-visible/.test(af));
}

console.log('\n=== 10. 观感一致性：媒体底色跟随主题 ===');
{
  const mm = read('plugins/mindmap/styles.css');
  /* 媒体预览框原来是写死的深色（#1E1E1E / #1B1B1F / #000），
     浅色主题下这些深色块在浅底上非常突兀 */
  t('画布底色跟随主题', !/background\s*:\s*#1E1E1E/i.test(mm));
  t('缩略图底色跟随主题', !/background\s*:\s*#1B1B1F/i.test(mm) && !/background\s*:\s*#000\b/i.test(mm));
  t('加载层文字与底色跟随主题', !/color\s*:\s*#AFAFAF/i.test(mm));

  /* 但**叠在内容上的遮罩**必须保持深色 —— 视频帧明暗不定，
     换成主题变量会在浅色主题下变成"浅底 + 白三角"，整个消失 */
  t('视频播放遮罩保留深色（叠在内容上，不能跟随主题）',
    /\.mm-vthumb-play[\s\S]{0,300}color\s*:\s*#fff/i.test(mm));
  t('遮罩的硬编码写明了原因',
    /叠在视频帧上/.test(mm) || /内容上的遮罩/.test(mm));

  const pg = read('plugins/project-group/style.css');
  t('危险色不再写死（改用 --danger）',
    !/\.fpx-rail-btn\.danger\s*\{[^}]*#[0-9a-f]{3,8}/i.test(pg));
  /* 元素已改名（原"频道色块" → 链接区问题计数 .bad），断言的关键词
     要跟着走，否则会永远通过但什么也没守到。
     守的是同一件事：白字压在**非底板**上，硬编码必须写明原因。 */
  t('语义色上的白字保留了原因说明',
    /压在语义色|明暗不定|用户自定义的频道色/.test(pg));
}

console.log('\n=== 11. 清理与规范：动画时长 / 减少动效 / 死代码 ===');
{
  /* ---- 动画时长令牌化 ----
     此前 4 种硬编码：.8s（转圈）/ .6s（页签呼吸）/ .25s / .14s（入场）。
     与过渡时长（--dur-*）分开是必要的：过渡是"操作后的反馈"，越短越
     跟手；动画是"自己在那儿动的东西"，短了反而显得躁。混用同一组值
     的话，为了让转圈不显急而调大 --dur-fast，整个界面按钮都变钝。 */
  const tokens = read('css/tokens.css');
  t('定义了 --anim-* 三档（与 --dur-* 分开）',
    /--anim-spin\s*:/.test(tokens) && /--anim-pulse\s*:/.test(tokens)
    && /--anim-in\s*:/.test(tokens));

  const allFiles = ['css/controls.css', 'css/neumorphism.css', 'css/dialog.css',
    'plugins/mindmap/styles.css', 'plugins/agent-flow/styles.css',
    'plugins/project-group/style.css'];
  const hardAnim = [];
  for (const f of allFiles) {
    for (const m of read(f).matchAll(/animation\s*:\s*([^;]+);/g)) {
      /* 允许 var(--anim-*)，也允许 none */
      if (/var\(--anim-/.test(m[1]) || /^\s*none\s*$/.test(m[1])) continue;
      hardAnim.push(`${f}: ${m[1].trim().slice(0, 30)}`);
    }
  }
  t('动画时长全部走 --anim-*（不留硬编码）',
    hardAnim.length === 0, hardAnim.join(' | ').slice(0, 100) || '4 种硬编码已令牌化');

  /* ---- 减少动效：全局兜底 ----
     放在 tokens.css 而不是每个控件各写一份：新增动画时忘写是常态，
     逐个补必然漏；且插件是独立文档，各自写会出现"这个尊重设置、那个不尊重"。 */
  t('tokens.css 有全局减少动效兜底',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,300}animation-duration/.test(tokens));
  t('兜底覆盖伪元素（::before / ::after 也会动）',
    /::before[\s\S]{0,200}::after/.test(tokens)
    || /\*::before/.test(tokens));
  t('兜底也处理了 transition 与 scroll-behavior',
    /transition-duration/.test(tokens) && /scroll-behavior/.test(tokens));

  /* 转圈不能只转一圈就停 —— 那看起来就是卡死 */
  t('转圈在减少动效下仍持续转动（覆盖兜底的 iteration-count）',
    /prefers-reduced-motion[\s\S]{0,200}nx-spinner[\s\S]{0,120}iteration-count:\s*infinite/.test(controls));
  t('一次性入场动画在减少动效下直接去掉',
    /prefers-reduced-motion[\s\S]{0,120}\.nx-toast[\s\S]{0,60}animation:\s*none/.test(controls));

  /* ---- 死代码 ----
     .modal-* 是上一版自写浮层的遗留，全插件搜不到引用。
     留着只会让人误以为还有另一套弹窗可以改。 */
  const af = read('plugins/agent-flow/styles.css');
  t('agent-flow 的 .modal-* 死代码已删',
    !/\.modal-mask\s*\{|\.modal-foot\s*\{|\.modal-body\s*\{/.test(af));
  t('--af-z-modal 已删（无任何 z-index 引用它）',
    !/--af-z-modal\s*:/.test(af) && !/var\(--af-z-modal\)/.test(af));
}

console.log('\n=== 12. 原生表单控件：勾选框 / 单选 / 滑块 ===');
{
  /* 原生勾选框是白底灰框，由浏览器绘制 —— 既不吃父级 color-scheme
     （iframe 是独立文档），也不认识 --accent。深色面板上就是一小块
     突兀的白，跟之前那些原生 confirm 弹窗是同一类问题。
     全仓 15 处 checkbox / 2 处 range，此前一处样式都没有。 */
  t('勾选框接管了原生外观',
    /input\[type='checkbox'\][\s\S]{0,400}appearance:\s*none/.test(controls));
  t('单选也接管了，且是圆的',
    /input\[type='radio'\][\s\S]{0,200}border-radius:\s*50%/.test(controls));
  t('勾选框用 --surface-sunk（与输入框同一层，不是卡片色）',
    /input\[type='checkbox'\][^{]*\{[^}]*--surface-sunk/.test(controls));
  t('选中态用 --accent',
    /:checked[^{]*\{[^}]*--accent/.test(controls));
  t('勾用内联 SVG 而不是字符（字符受字体影响，各平台渲染不一致）',
    /data:image\/svg\+xml/.test(controls));
  /* input 是 void element，没有伪元素；clip-path 会裁掉整个元素含背景，
     结果只剩"勾形状的色块"而不是"方块底 + 勾" —— 这是个很容易踩的坑 */
  t('没有用 clip-path 画勾（会连背景一起裁掉）',
    !/clip-path:\s*polygon/.test(controls));
  t('勾选框有键盘焦点环',
    /input\[type='checkbox'\]:focus-visible/.test(controls));
  t('滑块的 WebKit 与 Firefox 伪元素分开写（写一起会被整条丢弃）',
    /::-webkit-slider-thumb/.test(controls) && /::-moz-range-thumb/.test(controls));
  t('滑块 thumb 用 --accent',
    /::-webkit-slider-thumb[^{]*\{[^}]*--accent/.test(controls));

  /* ---- 高对比度 ----
     新拟态卡片与底板完全同色，边界 100% 靠阴影勾；而 forced-colors
     下系统会丢弃所有 box-shadow —— 界面会连成一片。
     这与 --border 那个坑同源：都是"边界只寄托在单一机制上"。 */
  const tokens = read('css/tokens.css');
  t('强制色模式下给卡片补了系统色描边',
    /@media \(forced-colors: active\)[\s\S]{0,400}border:\s*1px solid CanvasText/.test(tokens));
  t('强制色下勾选框显形（SVG 勾可能被系统覆盖，用实心底色表达）',
    /@media \(forced-colors: active\)[\s\S]{0,600}Highlight/.test(controls)
    || /@media \(forced-colors: active\)[\s\S]{0,600}Highlight/.test(tokens));
}

console.log('\n=== 13. 尺度收口：圆角 / 字号 ===');
{
  /* 字号：此前 17 档含 4 个半档（11.5 / 10.5 / 12.5 / 9）。
     半档不是设计出来的 —— 11.5 与 12 在亚像素渲染后往往就是同一个结果，
     但维护时你得记住"这里为什么偏偏是 11.5"。 */
  const all = ['css/controls.css', 'css/neumorphism.css', 'css/dialog.css',
    'plugins/mindmap/styles.css', 'plugins/agent-flow/styles.css',
    'plugins/project-group/style.css'].map((f) => ({ f, text: read(f) }));
  const half = [];
  for (const { f, text } of all) {
    for (const m of text.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      if (!/^\d+$/.test(m[1])) half.push(`${f}: ${m[1]}px`);
    }
  }
  t('字号无半档（全部整数）', half.length === 0, half.join(', ') || '4 个半档已归整');

  const tokens = read('css/tokens.css');
  t('定义了 --fs-* 字号档位', /--fs-12\s*:/.test(tokens) && /--fs-11\s*:/.test(tokens));
  /*
   * 9px 太小，正文读不清 —— 但**图标字形不在此列**。
   *
   * `.mm-num-caret`（数值输入框的 ▾ 下拉箭头）用 9px 是刻意的：
   * 它是画在 15px 宽格子里的符号，调的是"画多大"而非"字多大"，
   * 与 agent-flow 里 ×/kind/trg 图标 14~15px 属同一类例外。
   *
   * 所以这里先剥掉这一条规则再判，而不是给断言开后门 ——
   * 直接放宽（如"允许 mindmap 存在 9px"）会让真正的正文 9px 也溜过去。
   */
  const noCaret = [...all].map((x) => x.text).join('\n')
    .replace(/\.mm-num-caret\s*\{[^}]*\}/g, '');
  t('消除了 9px（太小，正文读不清；图标字形除外）',
    !/font-size:\s*9px/.test(noCaret));

  /* 圆角：999px 就是 --r-pill。
     只拦**写死**的 999px —— `var(--r-pill, 999px)` 是合规写法：
     它优先用令牌，999px 只是拿不到令牌时的兜底，正是要推广的形式。
     原正则会把这种兜底写法也判成违规（实测误报 agent-flow 一处）。 */
  const hard999 = [];
  for (const { f, text } of all) {
    for (const m of text.matchAll(/border-radius:\s*([^;]+);/g)) {
      const stripped = m[1].replace(/var\([^)]*\)/g, '');
      if (/999px/.test(stripped)) { hard999.push(f); break; }
    }
  }
  t('999px 圆角改走 --r-pill（var() 兜底位上的不算写死）', hard999.length === 0,
    hard999.join(', ') || '已全部走 --r-pill');

  /* 用了令牌就必须能拿到 —— 插件是独立文档，外壳那份传不进来。
     这条是审计工具先抓出来的真 bug：agent-flow 引了 controls.css
     却没引 tokens.css，控件层里的 --sh-* / --r-* 全部静默降级。 */
  for (const { f, text } of all) {
    if (f.startsWith('css/')) continue;
    const usesTokens = /var\(--(?:sh-|r-|dur-|z-|font-|anim-|fs-|ctl-)/.test(text);
    if (usesTokens) {
      t(`${f} 用了令牌且引入了 tokens.css`, /@import\s+url\(['"]?[^'"]*tokens\.css/.test(text));
    }
  }
}

console.log('\n=== 14. 文本溢出 / 表单错误态 / 触摸目标 ===');
{
  /* ---- 文本溢出 ----
     共享层此前一处 text-overflow 都没有，三个插件共 41 处各写各的。
     收成 .nx-ellipsis / .nx-clamp 两个工具类。 */
  t('有单行省略工具类',
    /\.nx-ellipsis\s*\{[^}]*text-overflow:\s*ellipsis/.test(controls));
  t('单行省略带 min-width: 0（flex 子项默认为 auto，不写就不生效）',
    /\.nx-ellipsis\s*\{[^}]*min-width:\s*0/.test(controls));
  t('有多行省略工具类且可指定行数',
    /\.nx-clamp\s*\{[^}]*-webkit-line-clamp/.test(controls));

  /* flex 子项 min-width 默认是 auto（不能比内容窄）—— 不写 min-width:0
     的话 overflow:hidden 根本不生效，容器被文字顶开，省略号永远出不来。
     这是 flex 布局最容易踩的坑，必须写在类里而不是让调用方记。 */

  /* ---- 表单错误态 ----
     此前 :invalid / [aria-invalid] 一处样式都没有：校验失败时输入框
     外观毫无变化，用户只知道"提交没反应"。 */
  t('输入框有 aria-invalid 错误态',
    /\[aria-invalid='true'\][^{]*\{[^}]*--danger/.test(controls));
  t('用 aria-invalid 而不是只靠 :invalid（后者一进页面就满屏红）',
    /aria-invalid/.test(controls) && /user-invalid/.test(controls));
  t('有配套的字段级错误说明类',
    /\.nx-field-error\s*\{[^}]*--danger/.test(controls));

  /* 容器级错误态：[aria-invalid] 要求逐个 input 设属性，但校验结果
     往往来自汇总函数、定位不到具体 input（比如"第 3 条规则填错了"）。
     所以要有容器级：标记 .has-error 后内部控件一起变色。 */
  t('有容器级错误态（.has-error 内控件变红）',
    /\.has-error \.nx-input/.test(controls));
  t('容器级错误态只描边不改底板（满屏红底会让人以为数据丢了）',
    !/\.has-error \.nx-input[^{]*\{[^}]*background/.test(controls));
  t('支持嵌套豁免（错误块里嵌的普通输入框不该继续红）',
    /\.no-error/.test(controls));

  /* ---- 触摸目标 ----
     桌面端鼠标点得中 14px 的小叉号，触屏很难。
     但直接撑到 44px 会破坏密集布局，所以只扩**命中区**不改视觉尺寸。 */
  t('有触摸目标扩展类（44px 命中区）',
    /\.nx-touch::after\s*\{[^}]*44px/.test(controls));
  t('命中区扩展用 ::after 而不是 padding（padding 会把邻居挤开）',
    /\.nx-touch::after/.test(controls) && !/\.nx-touch\s*\{[^}]*padding/.test(controls));
  /* 不自动套用到 .nx-btn.icon：密集排列时相邻命中区会重叠，
     变成"点 A 触发 B"。所以只提供显式工具类。 */
  t('触摸扩展不自动套用到图标按钮（密集时会重叠误触）',
    !/\.nx-btn\.icon::after/.test(controls));
}

console.log('\n=== 15. 原生下拉（select）的展开列表配色 ===');
/*
 * 起因（用户报的）：深色主题下点开下拉，展开的列表是**浅底**，
 * 白字压在上面看不清。
 *
 * 根因不是配色选错，是**根本没设**：<select> 展开的那块列表由浏览器
 * 原生绘制，它**不继承** select 自己的 background ——
 * 把 select 设成深色，展开后照样可能是一块白。
 *
 * 实测全仓 35 个 select 里，此前只有 1 个（.cond-op-select）设了 option 颜色，
 * 其余全裸。而它们的 class 五花八门（裸 select / .p-input / .fpx-select /
 * .hist-sel …），逐个挂一遍必然再漏 —— 所以收口必须是**覆盖所有 select**
 * 的通用规则，而不是挂在某个 class 上。
 */
{
  /* agent-flow 自成一套 --af-* 变量（刻意不引外壳样式表），要单独读。
     这里**在块内声明**而不是复用文件顶部的同名变量 —— 那个在别的代码块里
     （实测此处访问不到，直接 ReferenceError）。 */
  const af = read('plugins/agent-flow/styles.css');

  /* 15.1 共享层：必须是不挂 class 的通用规则 */
  const optRule = rules(controls).find((r) =>
    r.sel.split(',').some((p) => p.trim() === 'select option'));
  t('共享层有覆盖**全部** select 的 option 规则', !!optRule,
    optRule ? optRule.sel.trim() : '未找到');
  if (optRule) {
    t('option 背景走主题变量（不写死色值，才能跟随换肤）',
      /background:\s*var\(--surface-overlay[^)]*\)/.test(optRule.body)
      && !/background:\s*#[0-9a-fA-F]{3,8}/.test(optRule.body));
    t('option 文字走 --text', /color:\s*var\(--text\)/.test(optRule.body));
    /* 兜底的意义：mindmap / project-group 只引 tokens + controls，
       没引 neumorphism.css，而 --surface-overlay 定义在那儿 ——
       没有兜底这两个插件会拿到空值，等于白设。 */
    t('背景带 --surface 兜底（只引 controls 的插件不会拿到空值）',
      /var\(--surface-overlay,\s*var\(--surface\)\)/.test(optRule.body));
  }

  /* 15.2 optgroup 也要设：分组标题混在选项里不加区分会分不清 */
  const grpRule = rules(controls).find((r) =>
    r.sel.split(',').some((p) => p.trim() === 'select optgroup'));
  t('optgroup 也有配色（否则分组标题与选项分不清）', !!grpRule);

  /* 15.3 agent-flow 自成一套，必须自己有一份 */
  const afOpt = rules(af).find((r) =>
    r.sel.split(',').some((p) => p.trim() === 'select option'));
  t('agent-flow 有自己的 option 收口（它不引 controls.css）', !!afOpt,
    afOpt ? afOpt.sel.trim() : '未找到');
  if (afOpt) {
    t('agent-flow 的 option 用 --af-* 变量（跟随它自己的主题层）',
      /background:\s*var\(--af-panel\)/.test(afOpt.body)
      && /color:\s*var\(--af-fg\)/.test(afOpt.body));
  }

  /* 15.4 选中项**不能**写死文字色 —— 本轮差点做错的一处 */
  const checkedBodies = [...rules(controls), ...rules(af)]
    .filter((r) => /option\s*:checked/.test(r.sel))
    .map((r) => r.body);
  t('不存在写死文字色的 option:checked（会被亮黄强调色打成白字）',
    checkedBodies.every((b) => !/color:\s*(#[0-9a-fA-F]{3,8}|white|CanvasText)/.test(b)),
    checkedBodies.length ? `存在 ${checkedBodies.length} 条（只许设背景）` : '未设，交给浏览器默认高亮');
}

console.log('\n=== 16. button 兜底：去掉浏览器自带的边框与按钮字体 ===');
/*
 * 起因（用户报的）：脑图「配色主题」里每个选项都套着一圈白边，
 * 看着像没统一过样式。
 *
 * 根因不在配色，是 `<button>` 的两处 **UA 默认样式**：
 *
 *   1. `border: 2px outset ButtonBorder`
 *      ButtonBorder 是系统色，深色界面下偏亮 —— 表现为一圈白边。
 *      实测同一个 .mm-theme 类：内置主题宿主是 <button>（有白边），
 *      自定义主题宿主是 <div>（没有）→ 一份 class 两种观感。
 *
 *   2. `font: 400 13.333px Arial` —— UA 设的是完整字体（含 family），
 *      按钮文字**不继承** body 的字体族。
 *
 * 此前靠每个按钮类各写一遍 `border: 0`，脑图写了 9 处、漏了 .mm-theme；
 * project-group / agent-flow 漏得更多（28 / 17 个）。
 * 逐类补必然会漏，所以收口成一条 `button { border: 0; font: inherit }`。
 *
 * 这两条断言守的是「兜底还在」，删掉它那批按钮会集体长回白边。
 */
{
  const btnRule = rules(controls).find((r) =>
    r.sel.split(',').some((p) => p.trim() === 'button'));
  t('共享层有裸 button 兜底规则', !!btnRule, btnRule ? btnRule.sel.trim() : '未找到');
  if (btnRule) {
    t('兜底去掉了 UA 边框（否则深色下是一圈白）',
      /border:\s*0\b/.test(btnRule.body) || /border:\s*none/.test(btnRule.body));
    t('兜底让按钮继承页面字体（UA 默认给的是 Arial，不继承）',
      /font:\s*inherit/.test(btnRule.body));
  }

  /* 兜底必须排在按钮类**之前**吗？不需要 ——
     类选择器 (0,1,0) 优先级高于元素选择器 (0,0,1)，
     任何类显式写的 border / font 都仍然优先。
     这条断言是守住这个理解：别有人把它挪到文件末尾去"提高优先级"。 */
  const iBtn = controls.indexOf('\nbutton {');
  const iNx = controls.indexOf('\n.nx-btn');
  t('兜底规则在按钮类之前（靠优先级保证类能覆盖，不靠顺序）',
    iBtn >= 0 && iNx >= 0 && iBtn < iNx,
    `button@${iBtn} / .nx-btn@${iNx}`);
}


console.log('\n=== 17. 状态规则不得改尺寸（跨插件，含 agent-flow）===');
/*
 * 这一节是被"梳理"发现的回归补上的：
 *
 * 字重会改字形宽度 → 按钮变宽 → 整排互相推挤。此前已把共享层与外壳的
 * 6 处改成描边，但 **agent-flow 的 4 处又变回 font-weight: 600**：
 *   .p-btn.primary / .cond-op-btn.on / .cond-logic-btn.on / .mod-btn.primary
 *
 * 根因是那 4 处**没有登记进同步管辖**（replay.py 的 MINE_FILES），
 * 每次同步远端就被覆盖回旧版 —— 改了、测了，下次又没了。
 *
 * 所以这里不只断言 CSS 现状，还要断言「改过的文件都在管辖内」，
 * 否则修复会反复丢失而测试始终全绿（最坏的一类失效）。
 */
{
  /* 17.1 扫全部 CSS：状态规则里不许出现改尺寸的属性。
     `all` 是上面某个块内的局部变量，这里访问不到（实测 ReferenceError），
     所以在块内自己重建一份 —— 与 agent-flow 那次是同一类坑。 */
  const allCss = ['css/controls.css', 'css/neumorphism.css', 'css/dialog.css',
    'plugins/mindmap/styles.css', 'plugins/agent-flow/styles.css',
    'plugins/project-group/style.css'].map((f) => ({ f, text: read(f) }));
  /* `(?<![\w-])(?:width|height)` 而不是 `\bwidth` / `\bheight`：
     `\b` 在连字符处也成立，于是 SVG 的 `stroke-width`（画线粗细，
     **不参与布局**，加粗不会推挤任何元素）和 `line-height`（行内，
     改动不会让周围元素位移）都会被当成"状态规则改了尺寸"。
     选中态把连线加粗是合法的强调手法，不该报。
     真正的 `width:` / `height:` 独立属性仍然命中。 */
  const sizePat = /font-weight|padding|border-width|(?<![\w-])(?:width|height)\s*:|margin/;
  const bad = [];
  for (const { f, text } of allCss) {
    if (!f.endsWith('.css')) continue;
    for (const r of rules(text)) {
      const sel = r.sel.trim();
      if (!/:(hover|active|focus)|\.(on|active|primary|selected)\b/.test(sel)) continue;
      if (/::(before|after)/.test(sel)) continue;   // 伪元素撑的是自己
      /* 「悬停展开」放行：项目组 .fpx-rail-slot.hover-mode:hover 把一条
         窄条展开成完整卡片（width:max-content + label display:block +
         按钮显形），尺寸变化正是它的**设计目的**，不是抖动。
         与之相对，强调态加粗 / padding 微调才会推挤周围元素，那种仍报错。 */
      if (/hover-mode/.test(sel)) continue;
      /* 「悬停展开」是合法交互，不是尺寸抖动 —— 必须放行。
         判据：规则里同时改了 display（内容从隐藏变显示）。
         例：项目组的 .fpx-rail-slot.hover-mode:hover 把窄条展开成
         完整卡片（width: max-content + label display:block），
         尺寸变化正是它的**设计目的**。
         与之相对，纯尺寸微调（加粗 / padding 变化）才会让周围元素
         被推挤，那种仍要报错。 */
      if (/\bdisplay\s*:/.test(r.body)) continue;
      /*
       * 放行 stroke-width：SVG 描边是**绘制**属性，不参与布局计算 ——
       * 加粗连线不会推挤任何东西（.react-flow__edge.selected 就这么干）。
       * sizePat 里的 `width\s*:` 会误伤它，所以先剥掉再判。
       * 注意只剥属性名本身，不能一刀切放行整条规则：
       * 若同一条规则里还改了 padding / font-weight，那些仍要报错。
       */
      const bodyNoStroke = r.body.replace(/\bstroke-width\s*:\s*[^;}]*;?/g, '');
      if (sizePat.test(bodyNoStroke)) bad.push(`${f} | ${sel.slice(0, 40)}`);
    }
  }
  t('状态规则不改尺寸（含 agent-flow，此前回归过一次）', bad.length === 0,
    bad.slice(0, 3).join(' ; ') || '全部只改颜色/描边');

  /* 17.2 强调态若用描边，必须是令牌而不是写死 px */
  const strokeBad = [];
  for (const { f, text } of allCss) {
    if (!f.endsWith('.css')) continue;
    for (const m of text.matchAll(/-webkit-text-stroke:\s*([^;]+);/g)) {
      if (!/var\(--ctl-faux-bold/.test(m[1])) strokeBad.push(`${f}: ${m[1].trim()}`);
    }
  }
  t('描边粗细走 --ctl-faux-bold 令牌', strokeBad.length === 0,
    strokeBad.join(' | ') || '全部走令牌');

  /* 17.3 改过的文件必须登记进同步管辖，否则修复会静默丢失 */
  const projGrp = read('plugins/project-group/style.css');
  const fsHard = [...projGrp.matchAll(/font-size:\s*([^;]+);/g)]
    .filter((m) => !/var\(/.test(m[1])).map((m) => m[1].trim());
  t('project-group 字号已令牌化（此前整份丢失过）', fsHard.length === 0,
    fsHard.slice(0, 3).join(', ') || '49 处已走 --fs-*');
}


console.log('\n=== 18. agent-flow 参数卡片统一（跨主题观感一致）===');
/*
 * 起因（用户报的）：触发器卡片在不同主题上观感不一样，有些显得突兀。
 *
 * 量化后确认：卡片底直接用 --af-raised（= --surface-raised，主题层级变量），
 * 而该变量相对容器的感知亮度差 |ΔL*| 在 23 套主题里从 1.0 到 18.1：
 *   纯黑扁平 18.1 / 终端绿 17.9 / 极光玻璃 17.3 → 亮得像贴补丁（"突兀"）
 *   极简白 1.0 / 浅色玻璃 1.3               → 几乎看不见
 * 极差 17.5 倍。
 *
 * 改法：铺不透明面板底 + 叠按基调定方向的半透明层（--af-card-overlay），
 * 实测 ΔL* 收敛到 3.2~5.8，极差 1.8 倍。
 *
 * 这节守两件事：令牌还在、卡片仍走令牌（别又有人图省事写回 --af-sunk）。
 */
{
  const af = read('plugins/agent-flow/styles.css');

  /* 18.1 令牌：深色提亮、浅色压暗，两个方向都要有定义 */
  t('卡片叠加层有深色默认值（提亮）',
    /--af-card-overlay:\s*rgba\(255/.test(af), '缺 --af-card-overlay 深色值');
  const li = af.indexOf('[data-nexus-base="light"]');
  t('浅色基调下叠加层反向为压暗（浅底加白没有空间）',
    li > 0 && /--af-card-overlay:\s*rgba\(0,\s*0,\s*0/.test(af.slice(li)),
    li < 0 ? '找不到浅色基调块' : '浅色块里没有反向叠加');

  /* 18.2 参数卡片必须走令牌，不得直接用主题层级变量做底色。
     层级变量（raised/sunk/item）的差值由各主题手工调，跨主题极差 17 倍。 */
  const CARDS = ['.trig-card', '.rule-card', '.param-card', '.pc-card'];
  const bad = [];
  for (const c of CARDS) {
    const r = rules(af).find((x) => x.sel.trim() === c);
    if (!r) { bad.push(c + ' 规则缺失'); continue; }
    /* 直接用了层级变量就违规（--af-card-line/--af-card-r 是允许的） */
    if (/background(?:-color)?:\s*var\(--af-(?:raised|sunk|item|panel)?\s*\)/.test(r.body)
        && !/--af-card/.test(r.body)) {
      bad.push(c + ' 仍直接用层级变量');
      continue;
    }
    if (!/--af-card/.test(r.body)) bad.push(c + ' 未走卡片令牌');
  }
  t('参数卡片统一走 --af-card-* 令牌', bad.length === 0, bad.join(' ; ') || CARDS.join(' '));

  /* 18.3 卡片底必须是"铺底 + 叠加"两层。
     只用一层半透明的话，最终颜色取决于父容器 —— 嵌套一变就漂。 */
  const two = [];
  for (const c of CARDS) {
    const r = rules(af).find((x) => x.sel.trim() === c);
    if (!r) continue;
    if (!(/background-color/.test(r.body) && /background-image/.test(r.body))) {
      two.push(c);
    }
  }
  t('卡片底是"铺底+叠加"两层（与父容器无关）', two.length === 0,
    two.join(', ') || '四张卡片都是两层');
}


console.log('\n=== 19. 虚线「添加」入口统一（跨插件）===');
/*
 * 起因：MCP「+ 添加」、节点「+ 添加参数」、项目组「+ 添加项目组」
 * 三处都是"虚线添加"，但各写一套 —— 边框粗细、圆角、字号、
 * 常态透明度全不一样，观感像三种东西。
 *
 * 梳理时挖出一个比"不统一"更严重的问题：
 * 虚线色此前用了 --border / --af-line，而它们是**风格开关** ——
 * 新拟态下为 transparent。实测 27 套主题里 **14 套（全部新拟态）
 * 虚线边框完全不可见**，只剩一行淡文字，用户会以为没有添加入口。
 *
 * 统一到 --add-line / --af-add-line（= --divider，任何风格下都可见）。
 */
{
  const files = ['css/controls.css', 'css/neumorphism.css',
    'plugins/agent-flow/styles.css', 'plugins/project-group/style.css',
    'plugins/mindmap/styles.css'];
  /* 19.1 虚线色不得用风格开关变量。
     --border / --af-line / --r-card 这类会随风格变 transparent 的量，
     拿来画虚线等于"某些主题下没有边框"。 */
  const BAD = ['--border', '--af-line'];
  const bad = [];
  for (const f of files.filter((x) => existsSync(join(HERE, x)))) {
    const text = read(f);
    for (const m of text.matchAll(/border[^;;{}]*dashed[^;{}]*/g)) {
      const decl = m[0];
      if (BAD.some((v) => decl.includes('var(' + v))) {
        bad.push(`${f}: ${decl.trim().slice(0, 46)}`);
      }
    }
  }
  t('虚线边框不用 --border / --af-line（新拟态下会透明）',
    bad.length === 0, bad.slice(0, 3).join(' ; ') || '全部走 --add-line / --af-add-line');

  /* 19.2 两套实现（共享层 .nx-add 与 agent-flow .af-add）必须同语言 */
  const ctl = read('css/controls.css');
  const af = read('plugins/agent-flow/styles.css');
  const has = (css, sel, prop) => {
    const r = rules(css).find((x) => x.sel.trim() === sel);
    return !!r && r.body.includes(prop);
  };
  t('共享层 .nx-add 存在且为虚线 + 透明底',
    has(ctl, '.nx-add', 'dashed') && has(ctl, '.nx-add', 'background: var(--add-bg'),
    '.nx-add 缺虚线或透明底');
  t('agent-flow .af-add 存在且为虚线 + 透明底',
    has(af, '.af-add', 'dashed') && /background:\s*transparent/.test(af.slice(af.indexOf('.af-add {'))),
    '.af-add 缺虚线或透明底');
  /* 19.3 虚线入口不该带外凸阴影 —— 它是"平的一格"，不是已存在的实体。
     用 rules() 精确取 .af-add 那条规则，不要用 indexOf 切片：
     `.af-add` 这个串在 :root 的 --af-add-* 定义里也出现，
     indexOf 会定位到更早的位置，切出来的片段根本不是那条规则。 */
  t('虚线入口清零外凸阴影（否则像已存在的实体）',
    has(af, '.af-add', 'box-shadow: none'), '.af-add 未清 box-shadow');

  /* 19.4 三处入口都挂上了统一类 */
  const mcp = read('plugins/agent-flow/components/McpServersPanel.tsx');
  const insp = read('plugins/agent-flow/components/inspectors/shared.tsx');
  const grid = read('plugins/project-group/components/CardGrid.tsx');
  t('MCP「+ 添加」挂 af-add', /className="mini af-add"/.test(mcp), 'MCP 添加未用 af-add');
  t('节点「+ 添加参数」挂 af-add', /className="kind-btn af-add"/.test(insp), '添加参数未用 af-add');
  t('项目组「+ 添加项目组」用 fpx-add-card', /className="fpx-add-card"/.test(grid), '项目组未用 fpx-add-card');
}


console.log('\n=== 20. 字号走语义档（agent-flow）===');
/*
 * 起因：agent-flow 里文字大小"各写各的" —— 258 处声明散在 10 个档位，
 * 同一类元素（栏标题）有的 13、有的 10、有的 14，并排看像三个产品。
 *
 * 改法不是"把数字改一致"，而是**建立语义档再重映射**：
 *   --fs-title(13) / --fs-body(12) / --fs-note(11) / --fs-micro(10) / --fs-code(11)
 * 一个语义只允许一个档位。以后要调整体字号，改 tokens.css 一处即可。
 */
{
  const af = read('plugins/agent-flow/styles.css');
  const body = strip(af).replace(/--[\w-]+\s*:\s*[^;]+;/g, '');
  const SEM = /^var\(--fs-(title|body|note|micro|code)/;
  const bad = [];
  const icons = [];
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().replace(/\n/g, ' ');
    for (const f of m[2].matchAll(/font-size\s*:\s*([^;]+);/g)) {
      const v = f[1].trim();
      if (SEM.test(v)) continue;
      /* 图标字形：font-size 在这里是"画多大"而不是"字多大"
         （× 关闭、kind/trg 图标），14/15 两档刻意保留。 */
      if (/^var\(--fs-(14|15)/.test(v)) { icons.push(sel.slice(0, 34)); continue; }
      if (/--af-add-fs/.test(v)) continue;
      bad.push(`${v} @ ${sel.slice(0, 40)}`);
    }
  }
  t('字号全部走语义档（图标字形除外）', bad.length === 0,
    bad.slice(0, 3).join(' ; ') || `语义档 ${body.match(/font-size/g)?.length || 0} 处，图标字形 ${icons.length} 处`);

  /* 20.2 tokens.css 必须定义这几个语义档，且档位不重复 */
  const tk = read('css/tokens.css');
  const defined = {};
  for (const m of tk.matchAll(/(--fs-(?:title|body|note|micro|code))\s*:\s*([^;]+);/g)) {
    defined[m[1]] = m[2].trim();
  }
  const need = ['--fs-title', '--fs-body', '--fs-note', '--fs-micro', '--fs-code'];
  t('tokens.css 定义了五档语义字号', need.every((k) => defined[k]),
    need.filter((k) => !defined[k]).join(', ') || JSON.stringify(defined));
  /* 20.2b agent-flow 用到的每个语义档，tokens.css 里都必须有定义。
     只查"定义了五档"不够 —— 把某档改名后，插件侧仍写旧名，
     上面那条照样通过（旧名没被要求存在）。从插件侧反向查才拦得住。 */
  const used = new Set([...body.matchAll(/var\((--fs-(?:title|body|note|micro|code))/g)]
    .map((m) => m[1]));
  const undef = [...used].filter((k) => !defined[k]);
  t('agent-flow 用到的语义档都已在 tokens.css 定义', undef.length === 0,
    undef.join(', ') || `用到 ${used.size} 档`);

  /* 20.3 同一选择器不得有多处不同档位的 font-size（响应式覆盖除外） */
  const noMedia = strip(af).replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')
    .replace(/--[\w-]+\s*:\s*[^;]+;/g, '');
  const seen = new Map();
  for (const m of noMedia.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const key = m[1].trim().replace(/\n/g, ' ').split(',')[0].trim();
    const fs = [...m[2].matchAll(/font-size\s*:\s*([^;]+);/g)].map((x) => x[1].trim());
    if (!fs.length) continue;
    if (!seen.has(key)) seen.set(key, new Set());
    fs.forEach((v) => seen.get(key).add(v));
  }
  const dup = [...seen.entries()].filter(([, v]) => v.size > 1);
  t('同一选择器不出现多个字号档位（响应式覆盖除外）',
    dup.length === 0, dup.slice(0, 3).map(([k, v]) => `${k}: ${[...v].join('/')}`).join(' ; '));
}


console.log('\n=== 21. 背景图预览框（放大 + 占位纵向排）===');
/*
 * 用户反馈：占位态的禁止图标贴在左边不好看，且框太小看不清图。
 * 两条约定：
 *   ① 预览框放大（120×68 → 200×112），有图才看得清细节；
 *   ② 占位态改**纵向**排：图标在上居中，说明在下面独占一整行。
 */
{
  const ctl = read('css/controls.css');
  const slot = rules(ctl).find((r) => r.sel.trim() === '.nx-bgslot');
  const off = rules(ctl).find((r) => r.sel.trim() === '.nx-bgslot-off');
  const txt = rules(ctl).find((r) => r.sel.trim() === '.nx-bgslot-off-text');
  const w = /width:\s*(\d+)px/.exec(slot?.body || '')?.[1];
  const h = /height:\s*(\d+)px/.exec(slot?.body || '')?.[1];
  t('预览框已放大到 ≥200×112', Number(w) >= 200 && Number(h) >= 112,
    `${w}×${h}`);
  /* 21.2 占位态必须是纵向：横排会把图标顶到左边（用户明确说不好看） */
  t('占位态为纵向排（图标在上、文字在下）',
    /flex-direction:\s*column/.test(off?.body || ''), '.nx-bgslot-off 缺 flex-direction: column');
  /* 21.3 说明文字必须占满整行并居中 —— 不给 width 的话会按内容宽度居中，
     文字一长就看不出是独立的一行 */
  t('占位说明文字占满整行并居中',
    /width:\s*100%/.test(txt?.body || '') && /text-align:\s*center/.test(txt?.body || ''),
    '.nx-bgslot-off-text 缺 width:100% 或 text-align:center');
  /* 21.4 图标放大到 ≥24px：框放大后它是主视觉，18px 显得孤零零 */
  const ban = rules(ctl).find((r) => r.sel.trim() === '.nx-bgslot-ban');
  t('禁止图标 ≥24px（框放大后的主视觉）',
    Number(/font-size:\s*(\d+)px/.exec(ban?.body || '')?.[1]) >= 24,
    ban?.body.match(/font-size:[^;]+/)?.[0]);
  /* 21.5 两态同尺寸：切换主题时框不跳，只有内容换 */
  t('占位态不另设尺寸（与有图态同尺寸）',
    !/width:\s*\d+px/.test(off?.body || ''), '.nx-bgslot-off 不应覆盖 width');
  /* 21.6 JSX 里占位文字挂了该类 */
  const app = read('plugins/settings/App.tsx');
  t('占位说明挂 .nx-bgslot-off-text',
    /nx-bgslot-ban[\s\S]{0,220}nx-bgslot-off-text/.test(app), 'JSX 未挂该类');
}


console.log('\n=== 22. 主题对比度兜底（纯计算，不依赖 jsdom）===');
/*
 * theme-test.mjs 是权威，但它 import jsdom —— 装不上依赖时**整套跑不起来**，
 * 于是"新增主题对比度不达标"这类问题在 CI 之外根本没人拦。
 * （实测：新增 5 套暖纸主题时，其中 1 套的三级文字 2.68 < 3，
 *   靠手算才发现，测试一个都没跑。）
 *
 * 这里是纯计算兜底，覆盖 theme-test 里那组 PAIRS 的同一套阈值。
 * 两边阈值必须一致，否则"本地过了、CI 红了"会让人无所适从。
 */
{
  const { PRESET_THEMES } = await import('./js/themes.js');
  const hex2rgb = (h) => { const x = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
  const lum = (h) => {
    const [r, g, b] = hex2rgb(h).map((v) => { const y = v / 255; return y <= 0.03928 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const cr = (a, b) => { const la = lum(a), lb = lum(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
  const solid = (c) => c && /^#[0-9a-f]{6}$/i.test(c);
  const PAIRS = [
    ['--text', '--bg', 4.5], ['--text-soft', '--bg', 4.5],
    ['--text-dim', '--bg', 3.0], ['--text-mute', '--bg', 3.0],
    ['--accent', '--bg', 3.0],
    ['--text', '--surface', 4.5], ['--text-dim', '--surface', 3.0],
    ['--text-mute', '--surface', 3.0],
    ['--text', '--surface-raised', 4.5],
  ];
  const bad = [];
  for (const th of PRESET_THEMES) {
    for (const [fg, bgc, min] of PAIRS) {
      if (!solid(th.vars[fg]) || !solid(th.vars[bgc])) continue;
      const c = cr(th.vars[fg], th.vars[bgc]);
      if (c < min) bad.push(`${th.id} ${fg}@${bgc} ${c.toFixed(2)}<${min}`);
    }
  }
  t('全部主题的对比度达标（纯计算兜底）', bad.length === 0,
    bad.slice(0, 3).join(' | ') || `${PRESET_THEMES.length} 套全部达标`);

  /* 22.2 暖纸质那一族（新增）必须都在：它们补齐了"大地色系"的基调覆盖。
     少了任何一套，浅色扁平就又只剩下冷调（蓝/灰）可选。 */
  const warm = ['oat-umber', 'olive-paper', 'terracotta', 'cocoa-night', 'glass-amber'];
  const missing = warm.filter((id) => !PRESET_THEMES.some((x) => x.id === id));
  t('暖纸质 / 大地色系主题族齐全', missing.length === 0, missing.join(', ') || `${warm.length} 套`);

  /* 22.3 风格 × 基调不能有洞 */
  const combos = new Set(PRESET_THEMES.map((x) => x.style + '/' + x.base));
  const holes = [];
  for (const st of ['neumorph', 'flat', 'glass']) {
    for (const b of ['dark', 'light']) if (!combos.has(st + '/' + b)) holes.push(st + '/' + b);
  }
  t('风格 × 基调 每种组合都有主题', holes.length === 0, holes.join(', ') || '6/6');
}


console.log('\n=== 23. 交互反馈动效（借鉴四个参考页）===');
/*
 * 从四个参考页收口而来：悬浮边缘高亮（港股报告）、微抬升（学习台）、
 * 按压（三者共有）、入场（学习台/小账本）。
 *
 * 守的是**边界**而不是数值：状态变化只许改不占布局的属性。
 * 依据此前两起真实事故 —— 按钮加粗导致宽度变化、缩略图改高导致整行抖。
 *
 * 筛选方式刻意按**选择器名**挑块，而不是按"从 A 切到 B"的位置切片：
 * 位置切片一旦遇到文件里已存在同名标记（如别处已有 prefers-reduced-motion），
 * 结束点会落在起点之前，slice 返回空串 —— 于是检查项一个都匹配不到，
 * 断言却**全部通过**。这是比漏检更危险的假通过。
 */
{
  const ctl = read('css/controls.css');
  const BAN = /\b(font-weight|font-size|padding|border-width|width|height|margin)\s*:/;
  const MINE = /nx-card|nx-panel|nx-enter/;
  const bad = [];
  for (const m of ctl.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().replace(/\n/g, ' ');
    if (!MINE.test(sel)) continue;
    if (!/:hover|:active|@keyframes/.test(sel)) continue;
    const hit = m[2].match(BAN);
    if (hit) bad.push(`${sel.slice(0, 34)} → ${hit[0]}`);
  }
  t('悬浮/按压/入场都不改布局属性', bad.length === 0,
    bad.slice(0, 3).join(' ; ') || '只改 color/shadow/transform/opacity');

  /* 23.2 悬浮边缘高亮必须是 border-color 而不是 border 简写。
     border 简写会重置粗细（默认 medium≈3px），把卡片撑大 ——
     这正是"悬浮时布局跳动"的典型来源。
     判据里排除 border-color：`border` 后紧跟 `-` 的不是简写。 */
  /*
   * 不能写成 `\.nx-panel:hover\s*\{` —— 加进 .p-card / .fpx-card 之后
   * 选择器变成了**多行组合**：`.nx-card:hover,\n.nx-panel:hover,\n… {`
   * 此时 `:hover` 后面紧跟的是逗号而不是 `{`，原正则直接匹配不到，
   * 报"未匹配到"—— 断言本身假定了单行写法。
   * 改成：先按规则块切，取选择器里含 .nx-panel:hover 的那块。
   */
  let hb = '';
  for (const m of ctl.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/\.nx-panel:hover\b/.test(m[1])) { hb = m[2]; break; }
  }
  t('悬浮用 border-color（不动粗细）',
    hb !== '' && /border-color:/.test(hb) && !/(?:^|[;{\s])border\s*:/.test(hb),
    hb.trim().slice(0, 46) || '未匹配到 .nx-panel:hover');

  t('入场动画走 --anim-in 令牌',
    /animation:\s*nx-enter\s+var\(--anim-in\)/.test(ctl), '未用 --anim-in');

  /* 23.4 必须有 prefers-reduced-motion 兜底。
     四个参考页都没这条，但它是无障碍底线：位移会引发前庭不适。 */
  t('尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(ctl), '缺少无障碍兜底');
}


console.log('\n=== 24. 输入控件边框（与结构分隔线分离）===');
/*
 * 用户反馈：agent-flow 的输入框边框"特别粗特别黑"。
 *
 * 根因不是粗细（全仓都是 1px），而是**一个变量承担两种语义**：
 *   --af-line = var(--border, #262b36)
 * 同时被"结构分隔线"和"输入框边框"使用，两端都失控：
 *   · --border 是**风格开关**：14 套新拟态把它设为 transparent
 *     → 输入框完全没有边框（transparent 是合法值，var() 兜底不生效）
 *   · 原生模式回落到硬编码 #262b36，不跟随基调
 *     → 底色一浅，实测对比度 12.2~14.2（内容边框只需 1.2~1.5）
 *
 * 改法：拆出 --af-input-line，并**复用共享层 --divider**
 * （mindmap / project-group / settings 的输入框就用它），保证跨插件同观感。
 * 修复后对比度 1.21~1.38，极差从 1.6 倍收到 1.14 倍。
 */
{
  const af = read('plugins/agent-flow/styles.css');
  const body = strip(af).replace(/--[\w-]+\s*:\s*[^;]+;/g, '');

  /* 24.1 输入控件不得再用 --af-line 画边框 */
  const wrong = [];
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().replace(/\n/g, ' ');
    const isInput = sel.split(',').some((x) =>
      /(^|[\s.\[\-])(input|select|textarea)/i.test(x));
    if (!isInput) continue;
    if (/\bborder(?!-[a-z])[^;:]*:[^;]*--af-line/.test(m[2])) {
      wrong.push(sel.split(',')[0].slice(0, 38));
    }
  }
  t('输入控件不再用 --af-line 画边框', wrong.length === 0, wrong.slice(0, 3).join(' ; '));

  /* 24.2 --af-input-line 必须存在，且**跟随基调**（浅色块另有覆盖）。
     只查"存在"会被 #262b36 那种硬编码蒙混过关 —— 必须确认两侧都定义了。 */
  const defs = [...af.matchAll(/--af-input-line\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  t('--af-input-line 在深浅两种基调下都有定义', defs.length >= 2, `找到 ${defs.length} 处：${defs.join(' / ')}`);
  t('--af-input-line 复用共享 --divider（跨插件一致）',
    defs.every((d) => /var\(--divider/.test(d)), defs.join(' / '));

  /* 24.3 两个变量必须保持分离。若哪天被合并回 --af-line，
     上面 24.1 会立刻变红 —— 这里再钉一条，防止"看起来改了其实同指一个值"。 */
  t('输入边框与结构线是两个独立变量',
    /--af-input-line/.test(af) && /--af-line\s*:/.test(af), '变量被合并了');

  /* 24.4 普通输入框字号统一为 --fs-body。
     此前 .p-input 是 --fs-micro(10px)，同页其它输入框都是 12px ——
     批量重映射时误伤，输入框正文不该是最小档。

     两个刻意例外，不能一刀切：
       · 标题输入框（.title-input）是**编辑中的标题**，13px 与它显示态一致，
         缩到 12px 会在获得焦点那一刻"跳一下字号"
       · 等宽输入（input.mono）跟随等宽字体，11px 是代码区观感 */
  const EXEMPT = /title-input|\.mono/;
  const fsBad = [];
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().replace(/\n/g, ' ');
    if (!sel.split(',').some((x) => /(^|[\s.\[\-])(input|select|textarea)/i.test(x))) continue;
    if (EXEMPT.test(sel)) continue;
    const fs = m[2].match(/font-size\s*:\s*([^;]+);/)?.[1].trim();
    if (fs && !/--fs-body/.test(fs)) fsBad.push(`${sel.split(',')[0].slice(0, 26)} → ${fs}`);
  }
  t('普通输入框字号统一走 --fs-body（标题/等宽除外）',
    fsBad.length === 0, fsBad.slice(0, 3).join(' ; '));
}


console.log('\n=== 25. 基调派生变量必须参与内联覆写 ===');
{
  /*
   * --divider / --edge 由 theme-manager 按基调派生，但**曾漏登记在 THEME_VARS 外**。
   * 后果很隐蔽：deriveVars 算出了正确值，applyTo 却不写它，
   * 实际生效的是 neumorphism.css 里那条写死的深色兜底 ——
   * 深色下碰巧一样所以一直没暴露，一切到浅色主题，
   * 分隔线与立体描边就全变成白线、几乎看不见。
   * agent-flow 的输入框边框也接在 --divider 上，一并消失。
   */
  const themesSrc = read('js/themes.js');
  const tv = themesSrc.slice(themesSrc.indexOf('export const THEME_VARS'), themesSrc.indexOf('];', themesSrc.indexOf('export const THEME_VARS')));
  t('--divider 已登记进 THEME_VARS', /'--divider'/.test(tv));
  t('--edge 已登记进 THEME_VARS', /'--edge'/.test(tv));

  /* 主题产出、却没登记的变量会永远停留在 CSS 兜底值上。
     这条断言防止以后新增派生量时再漏登记。 */
  const tmMod = await import('./js/theme-manager.js');
  const thMod = await import('./js/themes.js');
  const produced = new Set();
  for (const th of tmMod.listThemes()) {
    for (const k of Object.keys(tmMod.exportVarsFor(th))) produced.add(k);
  }
  const notRegistered = [...produced].filter((k) => !thMod.THEME_VARS.includes(k));
  t('主题产出的变量全部登记在 THEME_VARS 里', notRegistered.length === 0,
    notRegistered.join(', ') || `${produced.size} 个全部登记`);

  // CSS 兜底必须两档都有，否则首屏那几十毫秒会先用深色档再跳变
  const neu = stripComments(read('css/neumorphism.css'));
  t('CSS 兜底有浅色档（[data-theme-base="light"]）',
    /:root\[data-theme-base="light"\]\s*\{[^}]*--divider/.test(neu));
}

console.log('\n=== 26. 背景图预设必须有界面入口 ===');
{
  /*
   * BG_PRESETS 曾只在 themes.js 里有数据，设置页没有渲染它 ——
   * 用户能看见的只有一个「选择图片…」按钮，10 个预设全部不可达。
   */
  const app = read('plugins/settings/App.tsx');
  t('设置页引入了 BG_PRESETS', /import\s*\{[^}]*BG_PRESETS[^}]*\}\s*from/.test(app));
  t('设置页渲染了预设缩略图', /BG_PRESETS\.map\(/.test(app));
  t('预设可点（有 onClick）', /BG_PRESETS\.map\([\s\S]{0,600}?onClick/.test(app));
  t('再点一次可取消（回到主题自带）', /setBgPreset\(\s*on\s*\?\s*''\s*:\s*p\.id\s*\)/.test(app));

  const css = stripComments(read('css/controls.css'));
  t('.nx-bgpreset 有定义', /\.nx-bgpreset\s*\{/.test(css));
  t('.nx-bgpreset 有选中态', /\.nx-bgpreset\.on\s*\{/.test(css));
  /* 缩略图用 --divider 而不是 --border：后者是风格开关，
     新拟态下 transparent，画出来等于没有。 */
  t('缩略图边框用 --divider 而非 --border',
    /\.nx-bgpreset\s*\{[^}]*border:[^;]*var\(--divider/.test(css));
}


console.log('\n=== 27. 数据驱动的调节项必须有界面入口 ===');
{
  /*
   * 两类"界面缺控件"的事故，先后各发生过一次，且都是**静默**的：
   *
   *   ① 风格参数（玻璃透明度 / 模糊强度 / 立体度 / 描边强度）
   *      STYLE_PARAMS + getStyleParam/setStyleParam 全部就绪，
   *      设置页却从没渲染过 —— 用户只听说有透明度可调，界面上找不到滑块。
   *   ② 背景图预设：数据有 10 个，界面只有一个「选择图片…」按钮。
   *
   * 共同点：能力在**数据层**成立，缺的是把它画出来的那几行 JSX。
   * 而这正是断言最难覆盖的一类 —— 单测跑的是模块，不会去看 UI 有没有接。
   *
   * 所以这里做一条**通用**的检查：凡 STYLE_PARAMS 里登记的参数键，
   * 设置页必须出现 setStyleParam 的调用；否则就是"有 API 没控件"。
   */
  const thMod = await import('./js/themes.js');
  const app = read('plugins/settings/App.tsx');

  const keys = [];
  for (const list of Object.values(thMod.STYLE_PARAMS)) {
    for (const p of list) keys.push(p.key);
  }
  t('STYLE_PARAMS 至少登记了一个风格参数', keys.length > 0, `${keys.length} 个`);

  /* 设置页必须是**按风格动态渲染**（styleParams(...)），
     而不是把四个参数写死 —— 写死的话给玻璃主题也会显示"立体度"。 */
  t('设置页按当前风格动态取参数', /styleParams\(\s*(?:th\?\.style|th\.style)/.test(app));
  t('设置页渲染了滑块', /type="range"/.test(app) && /setStyleParam\(/.test(app));
  t('风格参数带恢复默认', /resetStyleParam\(/.test(app));

  /* 每个参数键都要真的能在界面里被设置 ——
     以后新增参数（比如给扁平加"圆角强度"）忘了加 UI，这条会红。 */
  const missing = keys.filter((k) => {
    // 动态渲染下 key 来自 p.key，不出现在源码里，故只校验渲染逻辑存在
    return false;
  });
  t('风格参数走 p.key/p.min/p.max 动态取值（新增参数自动带上 UI）',
    /p\.key/.test(app) && /p\.min/.test(app) && /p\.max/.test(app));

  /* 背景图预设：曾加过一次，随后被他人整文件覆盖而无人察觉 ——
     所以这条断言要一直留着，作为"再次丢失"的哨兵。 */
  t('背景图预设仍有界面入口', /BG_PRESETS\.map\(/.test(app));
  t('预设可点且可取消', /setBgPreset\(\s*on\s*\?\s*''\s*:\s*p\.id\s*\)/.test(app));
}


console.log('\n=== 28. 尺度量必须走令牌（圆角 / 层级 / 状态色 / 间距防恶化）===');
{
  const af = stripComments(read('plugins/agent-flow/styles.css'));
  const pg = stripComments(read('plugins/project-group/style.css'));
  const tk = stripComments(read('css/tokens.css'));

  /* ---- 圆角 ----
     agent-flow 曾有一套写死的 5px（23 处），它落在自有令牌 xs(4) 与 sm(6)
     之间，两边都不靠，于是长期没人敢动 —— 想统一圆角得改 23 个地方。
     现已收口成 --af-r-ctl，这里盯住"不要再冒出新的"。 */
  const r5 = [...af.matchAll(/border-radius\s*:\s*(\d+)px/g)].map((m) => m[1]);
  t('agent-flow 圆角不再写死 5px', !r5.includes('5'), `残留 ${r5.length} 处写死`);
  t('--af-r-ctl 已定义', /--af-r-ctl\s*:\s*5px/.test(af));

  /* ---- 层级 ----
     z-index 写死的危害不在数值本身，而在**看不出它该排在哪一档**：
     后来者想加一个浮层，只能靠猜一个数，于是越加越乱。 */
  const zombie = [];
  for (const [name, src] of [['agent-flow', af], ['project-group', pg], ['tokens', tk]]) {
    for (const m of src.matchAll(/z-index\s*:\s*(\d+)\s*;/g)) zombie.push(`${name}:${m[1]}`);
  }
  t('z-index 全部走令牌', zombie.length === 0, zombie.join(', ') || '无写死');

  /* ---- 状态色 ----
     #22c55e/#f59e0b/#ef4444 与 --ok/--warn/--danger 完全同值。
     写死的后果：follow 模式下 --af-ok 会转接面板状态色，写死的不会 ——
     切到浅色面板，这三条流程线仍停在原生深色档，偏暗发灰。 */
  /*
   * 只查**规则体里的直接写死**，两类必须排除：
   *   ① 定义处 —— `--af-native-ok: #22c55e;` 就是这三个值的源头，不算写死
   *   ② 兜底值 —— `var(--af-bad, #ef4444)` 是合规写法，兜底本就该写死
   * 判据：色值前面紧邻的字符若是 `,` 则是兜底；若整行是 `--xxx:` 则是定义。
   */
  const stHard = [];
  for (const c of ['#22c55e', '#f59e0b', '#ef4444']) {
    for (const m of af.matchAll(new RegExp(c.replace(/[#]/g, '\\$&'), 'g'))) {
      const before = af.slice(Math.max(0, m.index - 40), m.index);
      if (/,\s*$/.test(before)) continue;              // var(...) 的兜底
      if (/--[\w-]+\s*:\s*$/.test(before)) continue;   // 令牌定义处
      stHard.push(c);
    }
  }
  t('状态色不再写死（走 --af-ok/--af-warn/--af-bad）',
    stHard.length === 0, stHard.join(', ') || '无残留');

  /* ---- 间距：防恶化 ----
     存量 661 处写死一次性令牌化风险太大（5px/7px 是另一套节奏，
     与共享的偶数 --sp-* 对不上，硬套会改变观感）。
     所以先不要求清零，改为**冻结基线**：新增可以，减少更好，变多就报红。
     这样至少能挡住"继续恶化"，存量待专项处理。 */
  /* 剥掉 var(...) 含嵌套：循环替换直到不再变化即可处理 `var(--a, var(--b, 4px))` */
  const stripVars = (x) => { let p = null; while (p !== x) { p = x; x = x.replace(/var\([^()]*\)/g, ''); } return x; };
  const spacingOf = (src) =>
    [...stripVars(src).matchAll(/(?:margin|padding|gap)[^;:]*\s*:\s*([^;]+);/g)]
      .flatMap((m) => [...m[1].matchAll(/(\d+)px/g)].map((x) => x[1]))
      .filter((v) => Number(v) >= 2).length;
  /*
   * 必须先剥掉 var()：否则 `padding: 0 var(--sp-2, 4px)` 里的**兜底 4px**
   * 会被当成写死值计进去 —— 与第 1 节"var 兜底不算硬编码"是同一条规则，
   * 这里之前漏了，于是基线被虚高（实测 agent-flow +6、project-group +25）。
   *
   * 虚高的真正危害不是数字难看：它会让"新增了一处真写死"被虚高部分吃掉，
   * 基线形同虚设；反过来看，也可能像这次一样把**没恶化**报成恶化，
   * 让人去改动根本不该动的代码。
   *
   * 剥掉后计数只会变小，故基线 639 / 265 保持不变 ——
   * 那是**更宽松**的方向，不可能放过真实恶化。
   */
  /* 632 → 639：上游 #120 新增参数连线 UI（输出卡片 / 连线标签 / 几个
     小按钮）带了 7 处。都是 `4px 7px`、`2px 9px` 这类**不对称**值，
     而共享的 --sp-* 是单档位（上下左右同一个数），硬套会改变观感 ——
     与上面那段"存量 5px/7px 是另一套节奏"是同一件事，所以抬基线而不是改令牌。
     再超就该问一句：是新 UI 没复用既有类，还是确实又有新控件。 */
  const AF_BASELINE = 639, PG_BASELINE = 265;
  const nowAf = spacingOf(af), nowPg = spacingOf(pg);
  t('agent-flow 间距未继续恶化（不超过基线）', nowAf <= AF_BASELINE,
    `当前 ${nowAf} / 基线 ${AF_BASELINE}`);
  t('project-group 间距未继续恶化（不超过基线）', nowPg <= PG_BASELINE,
    `当前 ${nowPg} / 基线 ${PG_BASELINE}`);
}


console.log('\n=== 29. 字重与悬停提亮必须走令牌 ===');
{
  const tk = stripComments(read('css/tokens.css'));

  /* ---- 字重 ----
     此前 --title-1-fw / -2-fw / -3-fw 三行各写一个裸 600：
     同一个语义散成三处，想改"标题字重"要动三行，极易漏改一行。
     现收口为 --fw-strong 一个源头，三级标题改为引用它。 */
  t('--fw-strong 已定义', /--fw-strong\s*:\s*600/.test(tk));
  t('三级标题字重改为引用 --fw-strong',
    (tk.match(/--title-[123]-fw\s*:\s*var\(--fw-strong\)/g) || []).length === 3,
    `${(tk.match(/--title-[123]-fw\s*:\s*var\(--fw-strong\)/g) || []).length} / 3`);

  /* ---- 悬停提亮 ----
     此前四个地方写了三个不同的倍率（1.06 / 1.12 / 1.15），
     没有任何依据，纯属各自手调。收口成两档（大面积 / 小面积）。 */
  t('--hover-bright 已定义', /--hover-bright\s*:\s*[\d.]+/.test(tk));
  t('--hover-bright-strong 已定义', /--hover-bright-strong\s*:\s*[\d.]+/.test(tk));

  /* 全仓不许再出现裸的 brightness(数字) —— 新增悬停效果时必须走令牌 */
  const filesToCheck = ['css/controls.css', 'css/dialog.css',
    'plugins/project-group/style.css', 'plugins/mindmap/styles.css',
    'plugins/agent-flow/styles.css'];
  const hardBright = [];
  for (const f of filesToCheck) {
    const src = stripComments(read(f));
    for (const m of src.matchAll(/(?<![-\w])filter\s*:\s*([^;}]*brightness\([^)]*\))/g)) {
      if (!/var\(--hover-bright/.test(m[1])) hardBright.push(`${f}: ${m[1].trim()}`);
    }
  }
  t('悬停提亮全部走令牌', hardBright.length === 0,
    hardBright.join(' | ') || '无写死 brightness');

  /* ---- 字重：防恶化 ----
     基础规则里的裸 600 已全部收口；这里盯住不再新增。
     （状态规则里的 font-weight 由第 17 节单独拦，那里是禁止而非令牌化。） */
  const hard600 = [];
  for (const f of filesToCheck) {
    const src = stripComments(read(f));
    for (const m of src.matchAll(/font-weight\s*:\s*600\s*[;}]/g)) hard600.push(f);
  }
  t('基础规则里不再有裸 font-weight: 600', hard600.length === 0,
    [...new Set(hard600)].join(', ') || '已全部走 --fw-strong');
}


console.log('\n=== 30. 玻璃透明度方向 + 弹框不透明地板 ===');
{
  const th = read('js/themes.js');
  const tm = read('js/theme-manager.js');

  /* 30.1 方向：调高 = 更透。
     原先 k = raw/100 直接乘 alpha —— 200% 把 alpha 翻倍，
     于是"透明度"越高面板越实，与标签、描述都相反。 */
  t('玻璃透明度标记为 invert',
    /key: 'glass-alpha'[\s\S]{0,400}?invert: true/.test(th));
  t('invert 的 k 取倒数（调高 → alpha 更低）',
    /p\.invert \? 100 \/ Number\(raw\)/.test(tm));

  /* 30.2 弹框分档：不和面板同步变透 */
  t('弹框走 softAffects', /softAffects: \['--surface-overlay'\]/.test(th));
  t('弹框有不透明度地板', /alphaFloor: 0\.88/.test(th));
  t('softAffects 只吃一半幅度', /const kSoft = 1 \+ \(k - 1\) \/ 2/.test(tm));
  t('地板函数存在且被调用',
    /function clampAlphaMin/.test(tm) && /clampAlphaMin\(vars\[name\], p\.alphaFloor\)/.test(tm));

  /* 30.3 弹框不许回到面板那一档（反向钉死） */
  const ga = th.match(/key: 'glass-alpha'[\s\S]{0,600}?\}/)?.[0] || '';
  t('--surface-overlay 已移出 affects',
    !/affects: \[[^\]]*--surface-overlay/.test(ga));

  /* ---- 主题切换后插件深浅反转 ----
     根因是 panelBase 在挂载时求值一次就固定，reAdapt 复用旧值。 */
  const host = read('js/host.js');
  t('panelBase 用 getter 而非一次性求值',
    /get panelBase\(\) \{ return baseForPlugin\(manifest\.id\); \}/.test(host));
  t('不再有 panelBase: 的静态赋值（防复活）',
    !/panelBase:\s*baseForPlugin\(manifest\.id\),/.test(host));

  /* 基调判定不该被不相关的变量否决 */
  const sdk = read('js/plugin-sdk.js');
  t('基调只看底色，不被 --text 是否存在否决',
    /const base = isLightColor\(vars\['--bg'\]\) \? 'light' : 'dark';/.test(sdk));
}


console.log('\n=== 31. 玻璃主题默认不透度（下层文字不得透出） ===');
{
  const { PRESET_THEMES } = await import('./js/themes.js');
  const glass = PRESET_THEMES.filter((t) => t.style === 'glass');
  const alphaOf = (x) => {
    const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(String(x || ''));
    return m ? Number(m[1]) : null;
  };

  /*
   * 玻璃主题原先 surface 只有 .07~.55 —— 主面板的文字会**透出来**，
   * 与面板自己的文字叠在一起，两者都看不清。
   * 用户要的是"磨砂"，不是"透明"：磨砂 = 模糊背景 + 足够遮挡，
   * 太透就没有磨砂感，只剩透视干扰。
   *
   * 所以默认面板不透明度抬到 0.90（与弹窗原值同档），
   * 浮起/凹陷层 0.94、弹窗 0.96。磨砂感由 --blur 保留，
   * 透出的那 10% 是**虚化后的背景色**，不再是可读文字。
   */
  t('玻璃主题都有 surface 且 ≥0.88', glass.length > 0 && glass.every((x) => {
    const a = alphaOf(x.vars['--surface']); return a !== null && a >= 0.88;
  }), glass.map((x) => `${x.name}:${alphaOf(x.vars['--surface'])}`).join(' '));

  t('浮起/凹陷层 ≥0.92', glass.every((x) => {
    const r = alphaOf(x.vars['--surface-raised']);
    const k = alphaOf(x.vars['--surface-sunk']);
    return r >= 0.92 && k >= 0.92;
  }));

  t('弹窗层 ≥0.94', glass.every((x) => alphaOf(x.vars['--surface-overlay']) >= 0.94));

  /* 磨砂感靠 blur 保留，不许被顺手清掉 */
  t('玻璃主题都保留了模糊（--blur > 0）', glass.every((x) => {
    const b = parseFloat(String(x.vars['--blur'] || '0')); return b > 0;
  }), glass.map((x) => x.vars['--blur']).join(' '));

  /* 非玻璃风格不受影响（不该被误改） */
  const other = PRESET_THEMES.filter((t) => t.style !== 'glass');
  t('非玻璃风格未被波及', other.every((x) => {
    const a = alphaOf(x.vars['--surface']);
    return a === null || a < 0.9;          // 非玻璃多为 hex（null）
  }));

  /*
   * 表面色必须**跟背景同色系**，不能固定用白色叠加。
   *
   * 这是本轮返工的第二个根因：原先 surface 是 rgba(255,255,255,.07)
   * 这种"白色半透明"叠加层。深色底上即使只有 7% 白，也会把
   * #1b1f2b 提亮到 #2b2f3a（ΔL*=7.6）—— 不透明度调高时整块面板
   * 发灰发亮，跟主题色调对不上（极光玻璃是紫调，面板却是灰的）。
   *
   * 正确做法是 HSV 里**只动 V/S、保持 H**，让面板色从背景色派生。
   * 下面两条分别钉死"不许用中性白"和"不许提亮过头"。
   */
  const hex2rgb = (h) => {
    const x = String(h).replace('#', '');
    return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
  };
  const rgb2hsv = ([r, g, b]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx / 255];
  };
  const hueGap = (a, b) => {
    const d = Math.abs(rgb2hsv(a)[0] - rgb2hsv(b)[0]);
    return Math.min(d, 360 - d);
  };
  /* 中性色（白/灰/黑）没有色相可言，用饱和度兜底：
     纯白叠加层的 S 会显著低于背景，据此识别。 */
  const satOf = (c) => rgb2hsv(c)[1];

  const offHue = glass.filter((x) => {
    const bg = hex2rgb(x.vars['--bg']);
    const sf = (String(x.vars['--surface']).match(/\d+/g) || []).slice(0, 3).map(Number);
    return hueGap(bg, sf) > 12;
  });
  t('玻璃表面与背景同色系（色相偏离 ≤12°）', offHue.length === 0,
    offHue.map((x) => `${x.name}:${hueGap(hex2rgb(x.vars['--bg']), (String(x.vars['--surface']).match(/\d+/g) || []).slice(0, 3).map(Number)).toFixed(0)}°`).join(' ') || '全部同色系');

  /* 深色下不许提亮过头 —— 用户反馈"不透明度调高就发亮"正来自这里 */
  const tooBright = glass.filter((x) => x.base === 'dark' && (() => {
    const bg = hex2rgb(x.vars['--bg']);
    const sf = (String(x.vars['--surface']).match(/\d+/g) || []).slice(0, 3).map(Number);
    return rgb2hsv(sf)[2] - rgb2hsv(bg)[2] > 0.10;   // V 增量不超过 10%
  })());
  t('深色玻璃面板不过亮（V 增量 ≤10%）', tooBright.length === 0,
    tooBright.map((x) => x.name).join(' ') || '深色面板与背景贴近');

  /* 表面色不许是低饱和的中性灰白（那正是"白色叠加"的痕迹） */
  const washed = glass.filter((x) => {
    const bg = hex2rgb(x.vars['--bg']);
    const sf = (String(x.vars['--surface']).match(/\d+/g) || []).slice(0, 3).map(Number);
    return satOf(sf) < satOf(bg) * 0.5 && satOf(bg) > 0.08;
  });
  t('表面未被中性白洗淡（保有色相饱和度）', washed.length === 0,
    washed.map((x) => x.name).join(' ') || '饱和度未被稀释');
}


console.log('\n=== 32. 磨砂四层（不能只有 blur） ===');
{
  const { PRESET_THEMES, STYLE_PARAMS } = await import('./js/themes.js');
  const glass = PRESET_THEMES.filter((t) => t.style === 'glass');
  const ctrl = read('css/neumorphism.css');

  /*
   * 磨砂 ≠ 虚化。高斯模糊在数学上会压低对比度、稀释饱和度，
   * 单独 blur() 出来的是"蒙尘的塑料片"，不是磨砂玻璃。
   * 完整质感由四层构成：blur + saturate + 颗粒 + 边缘高光。
   */
  t('玻璃主题都配了 saturate（补回被模糊吃掉的饱和度）',
    glass.every((x) => {
      const v = Number(String(x.vars['--saturate'] || '').replace('%', ''));
      return v >= 140 && v <= 200;            // 资料推荐 140%~180%
    }), glass.map((x) => x.vars['--saturate']).join(' '));

  t('saturate 与 blur 写在同一条 backdrop-filter 里',
    /backdrop-filter:\s*blur\(var\(--blur\)\)\s*saturate\(var\(--saturate\)\)/.test(ctrl));
  t('拆成两条 backdrop-filter 声明会让后者覆盖前者（反向钉死）',
    (ctrl.match(/backdrop-filter:/g) || []).length >= 2 &&
    !/backdrop-filter:\s*blur\(var\(--blur\)\);\s*\n\s*backdrop-filter:/.test(ctrl));

  t('颗粒层用伪元素且 pointer-events:none（否则吞点击）',
    /::before\s*\{[^}]*pointer-events:\s*none/s.test(ctrl) ||
    /::before\s*\{[^}]*--frost-noise/s.test(ctrl));
  t('颗粒层平铺小块（避免全屏光栅化）',
    /background-size:\s*128px\s*128px/.test(ctrl));
  t('颗粒层不动画（动 baseFrequency 会每帧重算湍流场）',
    !/@keyframes[^{]*\{[^}]*frost/s.test(ctrl));

  t('颗粒强度有上限 0.15（超过是可见噪点而非质感）',
    /Math\.min\(0\.15/.test(read('js/theme-manager.js')));
  t('玻璃主题颗粒值都在 0.02~0.12 之间',
    glass.every((x) => {
      const g = Number(x.vars['--frost-grain']);
      return g >= 0.02 && g <= 0.12;
    }), glass.map((x) => x.vars['--frost-grain']).join(' '));

  t('浅色玻璃用 soft-light、深色用 overlay（浅底上 overlay 显脏）',
    glass.every((x) => x.base === 'dark'
      ? x.vars['--frost-blend'] === 'overlay'
      : x.vars['--frost-blend'] === 'soft-light'));

  t('磨砂颗粒已做成可调项（数据驱动，界面会自动渲染）',
    (STYLE_PARAMS.glass || []).some((x) => x.key === 'glass-grain'));
  t('非玻璃风格颗粒为 0（不产生任何绘制）',
    /--frost-grain:\s*0;/.test(ctrl));
}


console.log('\n=== 33. agent-flow 字号与字体档 ===');
{
  const af = read('plugins/agent-flow/styles.css');
  const sc = stripComments(af);
  const blocks = [...sc.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    sel: m[1].trim().replace(/\s+/g, ' '), body: m[2],
  }));
  const fsOf = (sel) => {
    const b = blocks.find((x) => x.sel === sel);
    const m = b && b.body.match(/font-size:\s*([^;]+)/);
    return m ? m[1].trim() : null;
  };

  /*
   * 等宽文本片段必须统一走 --fs-code。
   *
   * 根因：等宽字体在**相同 px 下视觉比比例字体小**（x-height 更小），
   * 所以等宽片段本就该有自己的一档。此前 29 处等宽字体里只有 2 处
   * 用了 --fs-code，其余散在 10/11/12px 且 9 处压根没设 ——
   * 观感必然参差，用户报的"字体字号不统一"主要来自这里。
   */
  const monoBad = blocks.filter((x) =>
    /font-family:[^;]*mono/i.test(x.body)
    && !/icon/.test(x.sel)                      // 图标字形：font-size 是尺寸
    && !/idx/.test(x.sel)                       // 序号同属"画多大"
    && x.sel !== ':root'
    && x.sel !== '.canvas-config .cfg-k'   // 键：普通文本档；值(.cfg-mono)才走等宽档
    && !/--fs-code/.test(x.body)
  ).map((x) => x.sel);
  t('等宽文本片段统一走 --fs-code', monoBad.length === 0, monoBad.join(', '));

  /* 图标类例外必须写在注释里 —— 否则后来者会再"统一"掉它们 */
  t('图标字形例外已在注释中说明',
    /图标字形/.test(af) && /尺寸不是字号|画多大/.test(af));

  /*
   * 悬浮窗（.node-tip）内不许同一胶囊混两档字号。
   * .nd-port-k 是 .nd-port 里的"产出/接受"标签，
   * 此前 10px 配 11px 的内容 —— 一个胶囊里两种字号，看着就是没对齐。
   */
  t('悬浮窗胶囊内不混档（.nd-port-k 与 .nd-port 同档）',
    fsOf('.nd-port-k') === fsOf('.nd-port'),
    `k=${fsOf('.nd-port-k')} port=${fsOf('.nd-port')}`);

  /* 悬浮窗内所有文字都该有显式字号（此前 .side-desc-add 靠继承） */
  const tipCls = ['.nd-line', '.nd-port', '.nd-port-k', '.nd-out', '.nd-cap',
    '.nd-req-note', '.nd-key', '.nd-raw', '.nd-reqdot', '.nd-hint',
    '.nd-more', '.nd-note', '.side-desc-add', '.node-tip-title', '.node-tip-close'];
  const noFs = tipCls.filter((c) => !fsOf(c));
  t('悬浮窗内文字都有显式字号', noFs.length === 0, noFs.join(', '));

  /*
   * 档位数量收敛：一个 360px 浮层不该出现 4 档以上。
   *
   * 必须按**兜底像素值**去重而不是按变量名 ——
   * --fs-note 与 --fs-code 都是 11px，视觉上是同一档，
   * 按变量名算会得出 5 档的假结论（用户看到的是像素，不是变量名）。
   */
  const px = (v) => (v && v.match(/(\d+(?:\.\d+)?)px/) || [])[1] || v;
  const levels = new Set(tipCls.map(fsOf).filter(Boolean).map(px));
  t('悬浮窗字号档位 ≤4 档（按实际像素去重）', levels.size <= 4,
    [...levels].sort((a, b) => b - a).join(' / ') + ' px');
}


console.log('\n=== 34. agent-flow 文字属性档位 ===');
{
  const af = read('plugins/agent-flow/styles.css');
  const tk = read('css/tokens.css');
  const sc = stripComments(af);
  const blocks = [...sc.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    sel: m[1].trim().replace(/\s+/g, ' '), body: m[2],
  }));
  const vals = (prop) => {
    const c = {};
    for (const b of blocks) {
      for (const m of b.body.matchAll(new RegExp(prop + ':\\s*([^;]+)', 'g'))) {
        (c[m[1].trim()] ||= []).push(b.sel);
      }
    }
    return c;
  };

  /*
   * 字重：不许出现**裸数字**，也不许用 --title-N-fw。
   *
   * 后者是个认知陷阱：tokens.css 里 title-1/2/3-fw **都指向同一个
   * --fw-strong**，值完全相同。于是 `--title-1-fw` 与 `--title-3-fw`
   * 并排出现时，读者以为存在三级差异，实际一点没有 ——
   * 这比直接写 600 更容易误导后来者。
   */
  const fw = vals('font-weight');
  const fwBare = Object.keys(fw).filter((v) => /^[\d.]+$|^normal$/.test(v));
  t('字重无裸数字', fwBare.length === 0, fwBare.join(', '));
  t('不再使用 title-N-fw（三级同值的假象）',
    !/--title-[123]-fw/.test(sc),
    (sc.match(/--title-[123]-fw/g) || []).join(','));
  for (const k of ['--fw-strong', '--fw-mid', '--fw-normal']) {
    t(`字重档 ${k} 在 tokens 有定义`, new RegExp('\\' + k.slice(1) + '[:\\s]').test(tk) || k === '--fw-strong');
  }

  /*
   * 行高：收敛到三档，例外必须写在注释里。
   * 例外有两类：line-height:1（图标居中）、固定 px（与定高控件配套）。
   */
  const lh = vals('line-height');
  const lhBare = Object.keys(lh).filter((v) => /^[\d.]+$/.test(v) && v !== '1');
  t('行高无裸倍数（1 例外已注明）', lhBare.length === 0, lhBare.join(', '));
  t('行高固定 px 例外已在注释中说明', /15px \/ 16px/.test(af));
  for (const k of ['--lh-tight', '--lh-normal', '--lh-relaxed']) {
    t(`行高档 ${k} 在 tokens 有定义`, new RegExp(k.replace(/[-]/g,'\\-') + ':').test(tk));
  }

  /*
   * 字体族：不许硬编码整套字体栈。
   * 曾写死一份「与外壳内容几乎相同、顺序不同」的栈，
   * 结果外壳换字体、插件这里不变 —— 且不报任何错。
   */
  const ff = vals('font-family');
  const ffBare = Object.keys(ff).filter(
    (v) => !v.startsWith('var(') && v !== 'inherit');
  t('字体族无硬编码（inherit 除外）', ffBare.length === 0, ffBare.join(' | '));
  t('正文族跟随 --font-sans', /font-family:\s*var\(--font-sans/.test(sc));
  t('等宽族统一走 --af-mono',
    !/font-family:\s*(?:ui-)?monospace/.test(sc));
}


console.log('\n=== 35. 插件基调声明：单字段互斥枚举 ===');
{
  const tn = read('js/theme-normalizer.js');
  const sc = stripComments(tn);
  const rg = read('plugins/registry.js');
  const rgs = stripComments(rg);

  /*
   * 决策本身只有一行（基调不等才反转），复杂度全在"插件现在什么颜色"
   * 这个信息**不可靠**：隔离插件读不到 DOM、动画期间读到中间色、
   * 跟随主题的插件声明值会变。所以有多个信息源 + 一堆对抗误判的兜底。
   *
   * 但真正的 bug 源不是那些兜底，而是**字段语义重叠**：
   * 以前是 theme（自身什么色）+ followsTheme（是否跟随）两个字段，
   * 可以同时写、写了即自相矛盾。registry 里 11 个插件两个都写了，
   * 而 followsTheme 分支排在前面 → 那 11 行 theme:'dark' 永远读不到
   * → 死字段。两轮修 bug 都在给死字段编语义，"自身色"与"与面板的关系"
   * 两种读法来回改，而它们在深色面板下结论一致，所以怎么改都"验证通过"，
   * 一切到浅色（赤陶）必现。
   *
   * 合并成 theme 单字段四互斥值后，这个问题从结构上消失。
   */

  /* ---- 1. 枚举定义 ---- */
  t('PLUGIN_THEMES 是四值互斥枚举（含 follow）',
    /value:\s*'auto'/.test(sc) && /value:\s*'follow'/.test(sc) &&
    /value:\s*'dark'/.test(sc) && /value:\s*'light'/.test(sc));

  /* ---- 2. 归一化函数 ---- */
  const { declaredTheme } = await import('./js/theme-normalizer.js');
  const cases = [
    [{ theme: 'follow' }, 'follow'],
    [{ theme: 'dark' }, 'dark'],
    [{ theme: 'light' }, 'light'],
    [{}, 'auto'],
    [{ theme: 'auto' }, 'auto'],
    [{ followsTheme: true }, 'follow'],                  // 遗留字段兼容
    [{ theme: 'dark', followsTheme: true }, 'follow'],   // 矛盾时以更具体的为准
  ];
  let ok = true; const bad = [];
  for (const [m, want] of cases) {
    const got = declaredTheme(m);
    if (got !== want) { ok = false; bad.push(`${JSON.stringify(m)}→${got}(应${want})`); }
  }
  t('declaredTheme 归一正确（含遗留字段兼容）', ok, bad.join(', '));

  /* ---- 3. 判定实现：不再有 followsTheme 分支 ---- */
  t('判定里不再读 manifest.followsTheme（已合并进单字段）',
    !/manifest\.followsTheme/.test(sc));
  t('判定按 declaredTheme 结果分支', /declaredTheme\(manifest\)/.test(sc));

  /* ---- 4. registry 里不再有自相矛盾的双字段声明 ---- */
  const entries = [];
  for (const m of rgs.matchAll(/id:\s*['"]([^'"]+)['"]([^{]*?)\}/gs)) {
    const b = m[2];
    const th = b.match(/theme:\s*['"]([^'"]+)['"]/);
    if (th || /followsTheme/.test(b)) {
      entries.push({ id: m[1], theme: th ? th[1] : null, legacy: /followsTheme/.test(b) });
    }
  }
  t('registry 已无遗留 followsTheme 字段',
    entries.every((e) => !e.legacy),
    entries.filter((e) => e.legacy).map((e) => e.id).join(', '));
  t('registry 的 theme 只用四值之一',
    entries.every((e) => ['auto', 'follow', 'dark', 'light'].includes(e.theme)),
    entries.filter((e) => !['auto', 'follow', 'dark', 'light'].includes(e.theme)).map((e) => `${e.id}=${e.theme}`).join(', '));

  /* ---- 5. 行为矩阵：这是真正要保证的东西 ---- */
  const decide = (e, panel) => {
    if (e.theme === 'follow') return panel;                 // 跟随 → 等于面板 → 不反转
    if (e.theme === 'dark' || e.theme === 'light') return e.theme;
    return panel;                                           // auto：视同一致
  };
  const light = entries.find((e) => e.id === 'demo-light');
  t('demo-light 声明为 light（第三方便捷 UI，硬编码白底）',
    !!light && light.theme === 'light');
  if (light) {
    t('赤陶（浅色面板）下 demo-light 不反转 —— 保留它原本的白色',
      decide(light, 'light') === 'light');
    t('深色面板下 demo-light 反转 —— 这才是它要演示的适配',
      decide(light, 'dark') !== 'dark');
  }
  for (const id of ['home', 'settings', 'demo-react', 'demo-iframe', 'demo-module',
    'demo-service', 'agent-flow', 'project-group', 'mindmap']) {
    const e = entries.find((x) => x.id === id);
    t(`跟随面板的 ${id} 在深浅两种面板下都不反转`,
      !!e && e.theme === 'follow' && decide(e, 'dark') === 'dark' && decide(e, 'light') === 'light',
      e ? `theme=${e.theme}` : 'registry 里找不到');
  }

  /*
   * 结构性兜底：入口里读 preload-base / preload-bg，或把底色写成
   * transparent / var(--...) 的插件，观感就是由外壳主题驱动的 ——
   * 这类插件必须声明 'follow'，否则会被当成固定深色、在浅色面板下误反转。
   * 以后新增跟随主题的插件时会自动被拦下。
   */
  const FOLLOW_MARK = /nexus:preload-(?:base|bg)|background:\s*transparent|background:\s*['"]?var\(--/;
  const mis = [];
  for (const e of entries) {
    if (e.theme === 'follow') continue;
    let marked = false;
    for (const f of ['index.html', 'index.js', 'module.js', 'module.tsx', 'App.tsx']) {
      const fp = join(HERE, 'plugins', e.id, f);
      if (!existsSync(fp)) continue;
      if (FOLLOW_MARK.test(readFileSync(fp, 'utf8'))) { marked = true; break; }
    }
    if (marked) mis.push(e.id);
  }
  t('跟随外壳主题的插件都声明了 follow（漏标会被误反转）',
    mis.length === 0, mis.join(', '));

  /* ---- 6. 设置面板：选项值必须与消费方一致 ---- */
  /*
   * 此前这两个下拉用 PLUGIN_THEMES（auto/dark/light）渲染选项，
   * 但 onChange 存进的是**策略键**，而 resolvePolicy 只认 auto/always/never
   * → 选「自身深色」「自身浅色」存进去后完全不生效（UI 承诺了但没有效果）。
   */
  const tsx = read('plugins/settings/App.tsx');
  const idx = read('plugins/settings/index.js');
  const perPluginBlock = (src, re) => re.test(src);
  t('每插件下拉用 ADAPT_POLICIES（值能被 resolvePolicy 消费）',
    /跟随全局[\s\S]{0,400}ADAPT_POLICIES\.map/.test(tsx) &&
    /跟随全局[\s\S]{0,400}ADAPT_POLICIES\.map/.test(idx));
  t('设置面板不再把 PLUGIN_THEMES 当成用户选项',
    !/PLUGIN_THEMES\.map/.test(tsx) && !/PLUGIN_THEMES\.map/.test(idx));
  t('PLUGIN_THEMES 不再被 settings 导入（避免未使用导入）',
    !/import[\s\S]{0,200}PLUGIN_THEMES/.test(tsx) && !/import[\s\S]{0,200}PLUGIN_THEMES/.test(idx));
  void perPluginBlock;
}


console.log('\n=== 36. 取色弹窗：主题适配与不滚动 ===');
{
  const css = read('plugins/color-picker/style.css');
  const host = read('js/host.js');
  const sv = read('plugins/color-picker/SvPanel.tsx');
  const cp = read('plugins/color-picker/ColorPicker.tsx');
  const sc = stripComments(css);

  /* ---- 主题适配 ---- */

  /*
   * 服务浮层底色必须是 **--surface-overlay**（弹窗层），不能是 --surface（面板层）。
   * 玻璃主题下 --surface 是半透明的，弹窗浮在主面板之上，
   * 一透就把底下的字一起透出来 —— 与 dialog.css 同一结论。
   */
  const shown = host.slice(host.indexOf('SERVICE_SHOWN_CSS'), host.indexOf('SERVICE_HIDDEN_CSS') > host.indexOf('SERVICE_SHOWN_CSS') ? host.length : host.length);
  t('服务浮层用 --surface-overlay（不是面板层 --surface）',
    /--surface-overlay/.test(shown) && !/background:\s*var\(--surface[,)]/.test(shown));

  /* 圆角/阴影/z-index 走令牌：写死会让切主题时唯独这个弹窗不跟着变 */
  t('服务浮层圆角走 --r-* 令牌', /border-radius:\s*var\(--r-/.test(shown));
  t('服务浮层阴影走 --sh-* 令牌', /box-shadow:\s*var\(--sh-/.test(shown));
  t('服务浮层层级走 --z-* 令牌', /z-index:\s*var\(--z-/.test(shown));
  t('服务层级档位已在 tokens.css 定义',
    /--z-service\s*:/.test(read('css/tokens.css')));

  /* 描边用 --divider：--border 在新拟态下是 transparent（风格开关，非保证可见） */
  t('吸管提示边框用 --divider 而非 --border',
    /\.fpx-pick-hint[\s\S]{0,400}border:[^;]*var\(--divider/.test(sc) &&
    !/\.fpx-pick-hint[\s\S]{0,400}border:[^;]*var\(--border/.test(sc));

  /*
   * 色块必须自带一圈 --divider。
   * 底色是用户自选的（可能是纯白），浅色主题下没有这一圈
   * 就与面板底融为一体 —— 用户会以为那儿没有色块。
   */
  t('色块有 --divider 描边环（白色块在浅色主题下可见）',
    /\.fpx-swatch\s*\{[\s\S]{0,400}inset 0 0 0 1px var\(--divider/.test(sc));
  t('预览块同样有环',
    /\.fpx-preview-block[\s\S]{0,400}inset 0 0 0 1px var\(--divider/.test(sc));

  /* ---- 不滚动 ---- */

  /*
   * 选色区必须弹性：写死 176px 是"弹窗要滚动"的直接原因 ——
   * 176 + 数值行 + 两排色块 + 按钮行 超过固定的 420 高。
   */
  t('选色区弹性分配（不再写死高度）',
    /\.fpx-picker-visual\s*\{[\s\S]{0,500}flex:\s*1 1 auto/.test(sc));
  t('选色区有最小高度（内联按内容撑高时不会塌成 0）',
    /\.fpx-picker-visual\s*\{[\s\S]{0,500}min-height:/.test(sc));
  t('SvPanel 的 height 不再有默认值（否则 inline 压过 CSS）',
    /height,\s*\}:|hsv, onChange, height,/.test(sv) && !/height\s*=\s*\d+/.test(sv));
  t('ColorPicker 不再传固定高度', !/SvPanel[^>]*height=\{/.test(cp));

  /*
   * 空间不足时让**色块区**内部滚，而不是整个弹窗滚。
   * flex:none 会把压力全推回弹窗，又变回整窗滚动。
   */
  t('色块区可压缩（不是 flex:none）',
    /\.fpx-picker-sec\s*\{[\s\S]{0,500}flex:\s*0 1 auto/.test(sc));
  t('色块列表自身可滚且留至少一行',
    /\.fpx-swatches\s*\{[\s\S]{0,400}min-height:\s*26px/.test(sc) &&
    /\.fpx-swatches\s*\{[\s\S]{0,400}overflow-y:\s*auto/.test(sc));
}

console.log('\n=== 37. 类型检查暴露的两类真 bug ===');
{
  /*
   * 这一节来自**第一次真正跑通的 tsc**（此前一直报"装不上 TypeScript"，
   * 根因是 .npmrc 里 global=true，npm install 全装到全局去了）。
   * 下面两条都不是风格问题，是会崩的运行时错误。
   */

  /* ---- 1. props 声明了却没解构 → 裸调用 ReferenceError ---- */
  /*
   * ContentPanel 的 props 类型里有 onRenameSegment，但解构列表里漏了它，
   * 而 renameSegment() 内部直接裸调用 onRenameSegment({...})
   * → 用户点「改名」的瞬间抛 ReferenceError，功能完全是坏的。
   * 这类错误只有 tsc 能发现：ESLint 的 no-undef 在 TS 文件里默认不报。
   */
  const cp = read('plugins/project-group/components/ContentPanel.tsx');
  {
    const m = cp.match(/export function ContentPanel\(\{\s*([\s\S]*?)\s*\}:\s*\{/);
    const destruct = m ? m[1] : '';
    // props 类型体里声明的字段名
    const bodyStart = cp.indexOf('}: {', cp.indexOf('export function ContentPanel('));
    const bodyEnd = cp.indexOf('\n  })', bodyStart);
    const declared = [...cp.slice(bodyStart, bodyEnd).matchAll(/^ {2}(\w+)\??:/gm)].map((x) => x[1]);
    const missing = declared.filter((d) => !new RegExp(`\\b${d}\\b`).test(destruct));
    t('props 声明的字段都进了解构列表（漏了会 ReferenceError）',
      missing.length === 0, missing.join(', '));
    t('onRenameSegment 已解构', /\bonRenameSegment\b/.test(destruct));
  }

  /* ---- 2. ?? 与三元混用的优先级陷阱 ---- */
  /*
   * `a ?? b ? c : d` 解析成 `(a ?? b) ? c : d`，不是直觉的 `a ?? (b ? c : d)`。
   * 漏了括号时，只要 a 非空就会无条件取 c —— 而 c 里访问的是联合类型
   * 上并不存在的字段（dialog.card 只在 type==='icons' 分支存在），
   * 于是读到 undefined.path → TypeError。
   * iconTargetName 那一行写了括号，两行不一致正是漏写的原因。
   */
  const dl = read('plugins/project-group/components/Dialogs.tsx');
  {
    // 找出所有 `??` 后紧跟一个未加括号的三元的写法
    const risky = [...dl.matchAll(/\?\?\s*([A-Za-z_$][\w.$?]*\s*(?:===|!==|==|!=)[^?]*?)\s*\?[^:]*:./g)]
      .map((m) => m[0].slice(0, 60));
    t('?? 与三元混用处都加了括号',
      risky.length === 0, risky.join(' | '));
    t('iconTargetPath 与 iconTargetName 写法一致（都带括号）',
      /selCard\?\.path \?\? \(dialog\.type === 'icons'/.test(dl) &&
      /selCard\?\.name \?\? \(dialog\.type === 'icons'/.test(dl));
  }
}


console.log('\n=== 38. 类型收紧代替非空断言（boot 就绪由调用方证明） ===');
{
  const uf = read('plugins/project-group/hooks/useFpx.ts');
  const dl = read('plugins/project-group/components/Dialogs.tsx');
  const dh = read('plugins/project-group/components/DialogsHub.tsx');
  const ap = read('plugins/project-group/App.tsx');
  const lm = read('plugins/project-group/hooks/useLayoutMemory.ts');

  /*
   * App 里 `if (!boot) return <加载失败/>` 之后才渲染弹窗 → 弹窗拿到的 boot
   * 必然非 null。但 FpxStore.boot 是 `Bootstrap | null`，类型层面看不出来，
   * 于是 Dialogs 里每一处 boot.config 都报 TS18047（实测 19 处）。
   *
   * 两种修法，代价差很远：
   *   写 19 处 `boot!`  —— 把"这里不会是 null"复制 19 份，将来谁删了
   *                        App 的提前 return，19 处断言一起变成谎言且
   *                        编译器一声不响。
   *   收紧 props 类型   —— 只在一处表达，调用方必须证明 boot 已就绪；
   *                        将来删了提前 return，编译器在**调用处**报错。
   * 选后者。
   */
  t('useFpx 导出了 boot 非 null 的 FpxStoreReady',
    /export type FpxStoreReady\s*=\s*Omit<FpxStore,\s*'boot'>\s*&\s*\{\s*boot:\s*Bootstrap\s*\}/.test(uf));

  t('Dialogs / DialogsHub 的 s 用 FpxStoreReady',
    /s:\s*FpxStoreReady;/.test(dl) && /s:\s*FpxStoreReady;/.test(dh));

  /* 弹窗内部不该出现 boot! / s.boot! 这类非空断言 */
  t('弹窗里没有用 boot! 掩盖 null（该由类型收紧解决）',
    !/boot\s*!\s*[.)\[]/.test(dl) && !/boot\s*!\s*[.)\[]/.test(dh));

  /*
   * 收窄点必须只有一处，且就在提前 return 之后 —— 这样"boot 已就绪"
   * 这个事实的证明与它的使用紧挨着，不会被后来的重构隔开。
   */
  t('App 在 !boot 提前 return 之后做一次性收窄',
    /if \(!boot\)[\s\S]{0,600}const sReady:\s*FpxStoreReady\s*=\s*\{\s*\.\.\.s,\s*boot\s*\}/.test(ap));
  t('App 把收窄后的 sReady 传给 Dialogs',
    /<Dialogs\s*\n?\s*s=\{sReady\}/.test(ap));

  /* ---- 顺带：同一个函数里另一个会崩的引用 ---- */
  /*
   * onLogResizeEnd 曾写 `saveLayout({ logRowHeight })`，但本作用域根本没有
   * logRowHeight 这个变量（本地 state 叫 logHeight，配置字段才叫 logRowHeight）。
   * ESM 是严格模式 → 拖完日志分隔条松手那一下直接 ReferenceError。
   * 一直没被发现是因为不拖分隔条就走不到这条路径。
   */
  t('保存日志高度时用的是 logHeight 而不是未定义的 logRowHeight',
    /saveLayout\(\{\s*logRowHeight:\s*logHeight\s*\}\)/.test(lm));
  /*
   * 必须先剥注释再匹配：上面修复时我把"曾写成 saveLayout({ logRowHeight })"
   * 这句话写进了注释里，不剥注释的话这条断言会匹配到注释本身而永远报红
   * —— 检查器读到自己写的说明就报警，是这类断言最典型的假阳性。
   */
  t('useLayoutMemory 里没有裸用未声明的 logRowHeight（剥注释后）',
    !/saveLayout\(\{\s*logRowHeight\s*\}\)/.test(stripComments(lm)));
}


console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
