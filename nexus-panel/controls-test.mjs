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
  t('消除了 9px（太小，正文读不清）',
    !/font-size:\s*9px/.test([...all].map((x) => x.text).join('\n')));

  /* 圆角：999px 就是 --r-pill */
  const hard999 = [];
  for (const { f, text } of all) {
    if (/border-radius:\s*999px/.test(text)) hard999.push(f);
  }
  t('999px 圆角改走 --r-pill', hard999.length === 0,
    hard999.join(', ') || '21 处已替换');

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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
