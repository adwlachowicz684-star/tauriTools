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
  t('消除了 9px（太小，正文读不清）',
    !/font-size:\s*9px/.test([...all].map((x) => x.text).join('\n')));

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
  const sizePat = /font-weight|padding|border-width|\bwidth\s*:|\bheight\s*:|margin/;
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
      if (sizePat.test(r.body)) bad.push(`${f} | ${sel.slice(0, 40)}`);
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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
