/**
 * 样式资产损伤扫描：类名维度
 * ============================================================
 * 补的是现有审计**唯一没有的那一维**。
 *
 * 现有 style-audit.js 只查 CSS 变量（`--x` 未定义），不查类名。
 * 而实际踩过的最严重损伤恰恰在类名上：
 *
 *   2026-09-16  d9c899bf 引入 project-group 卡片链接明细的 8 个类
 *   2026-09-16  d23cd76b（2 分钟后）整块覆盖写，全部抹掉
 *   此后 6 天、20+ 次提交无人发现
 *
 * 原因是测试全是**正向断言**（"这条规则里必须有 align-items"），
 * 没有**反向扫描**（"被引用的类名必须有定义"）：
 *   1. 规则被截断 → 字符串还在，正向断言照样匹配
 *   2. 整块覆盖写类名消失 → 没有"类名必须有定义"的断言
 *   3. 写了类名没配样式 → 同上
 *
 * 所以这里做三件事：
 *   A. 死类名：代码里用了、CSS 里没定义
 *   B. 孤儿样式：CSS 里定义了、没人用（提示性，默认不算错）
 *   C. 语法损伤：选择器后紧跟换行再紧跟注释（.mm-rail 那次的特征）
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';

/** 扫目录时的排除项 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build',
  '.tauri', '__pycache__', '.venv', 'venv', 'coverage',
]);

/**
 * 剥注释后再解析 —— 否则注释里写的类名会被当成已定义。
 * 实测：`/* .fpx-links-bar { gap: 8px } *\/` 这种注释会让"已修复"被误判成
 * "已定义"，扫描形同虚设。字符串里的 `}` `{` 也要一并处理。
 */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** 收集一个 CSS 文本里所有已定义的类名（含前缀） */
export function collectDefinedClasses(css) {
  const clean = stripComments(css);
  const out = new Set();
  // 只取选择器部分：从行首/注释后到第一个 {
  const selBlocks = clean.replace(/\{[^}]*\}/g, '\u0000').split('\u0000');
  for (const raw of selBlocks) {
    // 去掉 @media/@supports 等 at-rule 前缀与 keyframes 百分比
    /*
     * 去掉 @ 规则的前言，但**绝不能吞掉后面的选择器**。
     *
     * 原写法 `@[a-z-]+[^{]*` 会一路吃到下一个 `{` 为止：
     *   @import url('...');
     *   @import url('...');  /* 注释 *\/
     *   .fpx-root { ... }
     * —— @import 是**语句型**（以 ; 结尾、没有自己的 {），
     * 于是 `[^{]*` 一直吃到 `.fpx-root` 的 `{`，把 `.fpx-root` 也吞了。
     * 实测：project-group/style.css 第 8 行定义了 .fpx-root，
     * 却被判成死类名，正是这个原因。
     *
     * 分两类处理：
     *   语句型（@import/@charset/@namespace）→ 吃到 `;` 为止
     *   块级型（@media/@supports…）→ 前言吃到它**自己的** `{` 为止，
     *     且把 `{` 一起保留（`\{` 写在匹配里），这样不会越过边界。
     */
    const seg = raw
      .replace(/@(?:import|charset|namespace)[^;]*;/gi, ' ')
      .replace(/@[a-z-]+[^{]*\{/gi, '{')
      .replace(/^\s*\d+%\s*/gm, ' ');
    for (const m of seg.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}

/**
 * 从源码文本里提取被引用的类名。
 *
 * 三种写法都要覆盖，漏一种就会漏报：
 *   1. className="a b"          静态字符串
 *   2. className={`a ${x}`}     模板字符串 —— 字面量部分要取，${} 要剔
 *   3. h('div.mm-foo', ...)       hyperscript 简写
 *   4. classList.add/toggle/remove('x')
 */
export function collectUsedClasses(src) {
  const out = new Set();
  const addTokens = (s) => {
    for (const tok of String(s).split(/\s+/)) {
      const name = tok.trim();
      if (!name || !/^[A-Za-z_-][\w-]*$/.test(name)) continue;
      // 以 - 结尾的是**拼接前缀**（`level-${x}` 取出的 "level-"），不是完整类名。
      // 不排除会报出一堆永远不存在的死类名 —— 必须所有提取分支都过这一关，
      // 只在一处加会漏（实测 level-/size-/status- 就是从另一条分支漏进来的）。
      if (name.endsWith('-')) continue;
      out.add(name);
    }
  };
  // 1+2: className= / class= 的静态串与模板串
  for (const m of src.matchAll(/class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{\s*'([^']*)'\s*\}|\{\s*"([^"]*)"\s*\})/g)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '');
    // 模板串里的 ${} 是运行时拼的，不能当类名（会误报出一堆不存在的）
    for (const part of body.split(/\$\{[^}]*\}/)) addTokens(part);
  }
  /*
   * 2a2: className={'cond-chip src' + (x ? ' off' : '')}
   *      —— 字面量后面是**运算**而不是直接收括号，
   *         上面 `\{\s*'([^']*)'\s*\}` 要求 ' 之后马上是 }，
   *         于是这种写法整个匹配不上，cond-chip / src 会被误报成死类名
   *         （实测：远端新增 ConditionInspector 就是这么写的）。
   *      这里只要求 className= 后紧跟 { 与引号，不再要求右边是 }。
   */
  for (const m of src.matchAll(/class(?:Name)?\s*=\s*\{\s*'([^']*)'/g)) addTokens(m[1]);
  for (const m of src.matchAll(/class(?:Name)?\s*=\s*\{\s*"([^"]*)"/g)) addTokens(m[1]);

  // 2b: 模板串里带 ${} 的，如 `fpx-link-arrow${x ? ' open' : ''}`
  //     —— 两个方向都要取，缺一个就会漏报：
  //       · ${} 外的静态部分 → fpx-link-arrow
  //       · ${} 内三元里的字符串 → open（这是**真实会挂上的状态类**，
  //         只取外面会导致 .open 被误报成死类名）
  for (const m of src.matchAll(/class(?:Name)?\s*=\s*\{`([^`]*)`\}/g)) {
    const body = m[1];
    for (const part of body.split(/\$\{[^}]*\}/)) addTokens(part);
    for (const inner of body.matchAll(/\$\{([^}]*)\}/g)) {
      /*
       * 只取**三元分支里的**字面量，不取条件里的。
       *
       * `className={`fpx-grouptab${tab === 'mine' ? ' active' : ''}`}`
       *   → 'mine' 是**比较值**，不是类名；' active' 才是。
       * 不区分会把 preset / mine / hover / running 这类状态枚举值
       * 全报成死类名（实测 15 个里有 4 个是这么误报的）。
       *
       * 判据：找第一个**不在引号内**的 `?`，它之前是条件（跳过），
       * 之后是分支（取值）。找不到 `?` 说明整个 ${} 是表达式而非类名，
       * 例如 `st-${n.status}`，一律跳过。
       */
      const expr = inner[1];
      /*
       * 改看每个字面量**后面**紧跟的字符，而不是切分 ?/:：
       *   `'success' ?`  → 后面是 ? → 条件值，跳过
       *   `'ok' :`       → 后面是 : → 分支值，取
       *   `'run' :`      → 取
       *   `'running' ?`  → 跳过
       *
       * 用"切分第一个 ?"的老办法处理不了**嵌套三元** ——
       * `a ? 'ok' : b === 'running' ? 'run' : ''` 从第一个 ? 切开后，
       * 右半边仍含 'running'，会误报（实测踩到）。
       */
      for (const s of expr.matchAll(/['"`]([^'"`]*)['"`]/g)) {
        let k = (s.index ?? 0) + s[0].length;
        while (k < expr.length && /\s/.test(expr[k])) k++;
        // 后面紧跟 ? → 是三元的条件值，不是类名
        if (expr[k] === '?') continue;
        addTokens(s[1]);
      }
    }
  }
  // 3: h('div.mm-foo') / h('.mm-foo')
  for (const m of src.matchAll(/\bh\(\s*['"`]([a-zA-Z][\w]*)((?:[.#][\w-]+)*)['"`]/g)) {
    for (const tok of (m[2] || '').split('.')) {
      const name = tok.trim();
      if (name && /^[A-Za-z_-][\w-]*$/.test(name)) out.add(name);
    }
  }
  // 4: classList.add('x') / toggle / remove / contains
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove|contains)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    for (const tok of m[1].split(/\s+/)) {
      const name = tok.trim();
      if (name && /^[A-Za-z_-][\w-]*$/.test(name)) out.add(name);
    }
  }
  /*
   * 5: el('div', 'nx-mask') —— **创建辅助函数**传参
   *
   * 这是 js/dialog.js 的写法（全项目弹窗的唯一实现）：
   *     function el(tag, cls, text) { n.className = cls; ... }
   *     const mask = el('div', 'nx-mask');
   *
   * 类名是**函数参数**，不是 class= / className=，也不是模板串 ——
   * 上面 1~4 条分支**一条都匹配不到**。
   *
   * 后果是双向失明（实测：把 .nx-mask 改成 .nx-maskx，
   * 4 个测试共 375 项断言**全绿**，没有任何一条报红）：
   *   · 方向1（CSS 定义、代码没用）看的是新类名 .nx-maskx，代码里确实没有，
   *     本该报死样式 —— 但旧类名 .nx-mask 已从 CSS 消失，方向1 无从对照；
   *   · 方向2（代码用了、CSS 没定义）看的是旧类名 nx-mask，
   *     而它压根没被提取出来。
   * 两个方向同时失效，弹窗整块失去样式却无人知晓。
   *
   * ==================================================================
   * 必须先看 el 的**定义签名**，不能只看调用形式
   * ==================================================================
   * 全仓有四个文件各自定义了 el，签名分两种：
   *
   *   js/dialog.js                function el(tag, cls, text)        ← 第二参是类名
   *   color-picker/icon-picker/
   *   md-editor 的 index.js       const el = (tag, attrs={}, ...kids) ← 第二参是属性对象
   *
   * 只看"第一个参数是 HTML 标签"会**误报一大片**：
   * 实测第一版修复让 dead-class 从 45 项绿变成 2 项红，
   * 报出的 preview / sv / hue / grid / cell / panes / t / foot 全是
   * 属性键名或标签名 —— 它们根本不是类名。
   *
   * 更值得记的是：当初统计"全仓只有 dialog.js 用 el()"用的就是
   * 同一个只认字面量第二参的正则，等于**用错误前提验证错误前提**，
   * 所以没发现另外三个文件。
   */
  const elTakesClass = /function\s+el\s*\(\s*\w+\s*,\s*cls\b/.test(src)
    || /\bel\s*=\s*\(\s*\w+\s*,\s*cls\b/.test(src)
    || /\bel\s*=\s*function\s*\(\s*\w+\s*,\s*cls\b/.test(src);
  if (elTakesClass) {
    const HTML_TAGS = new Set(['a','button','div','h1','h2','h3','h4','h5','h6','input',
      'label','li','ol','option','p','pre','section','select','span','strong','table',
      'tbody','td','textarea','th','thead','tr','ul','code','em','small','i','b','form']);
    /*
     * 第二参数可能是**拼接**：el('button', 'nx-btn' + (v ? ' primary' : ''))
     * —— 只匹配到第一个字面量会漏掉拼接里的状态类。
     * 所以取**整个第二参数表达式**（限长防失控），
     * 再套用与模板串相同的判据：后面紧跟 `?` 的是条件值，跳过。
     */
    for (const m of src.matchAll(/\bel\(\s*['"`]([a-zA-Z][\w]*)['"`]\s*,\s*([^;]{0,160})/g)) {
      if (!HTML_TAGS.has(String(m[1]).toLowerCase())) continue;
      const expr = m[2];
      for (const sm of expr.matchAll(/['"`]([^'"`]*)['"`]/g)) {
        let k = (sm.index ?? 0) + sm[0].length;
        while (k < expr.length && /\s/.test(expr[k])) k++;
        if (expr[k] === '?') continue;      // 三元的条件值，不是类名
        addTokens(sm[1]);
      }
    }
  }
  return out;
}

/**
 * 语法损伤：选择器后紧跟换行再紧跟注释。
 *
 * 这正是 .mm-rail 那次的特征 —— 覆盖写时规则被截断成
 *   .mm-rail
 *   /* 注释 *\/
 * 后面跟着的已经不是它的规则体了。CSS 里这是合法的（选择器可以换行），
 * 所以语法检查查不出来，但语义上这条规则已经空了。
 */
export function findTruncatedRules(css) {
  const out = [];
  /*
   * 判据：**在剥掉注释的文本上**找"疑似选择器、但后面不跟 { "的行。
   *
   * 为什么必须剥注释再看：
   *   直接在原文上找"选择器 + 换行 + 注释"会误报一大片 ——
   *   实测第一版误报 13 处、几乎全是多行注释块的中间行，
   *   检查等于形同虚设。而截断的本质正是"注释插进了选择器和 { 之间"，
   *   剥掉注释后这个空隙才会暴露成一个裸选择器。
   *
   * 又因为选择器本身就允许换行（`.a,\n.b {`），所以行尾有 `,` 要放行；
   * 下一行以 `,` 开头（续选择器）同样放行。
   */
  const clean = stripComments(css);
  const lines = clean.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const head = raw.trim();
    if (!head || head.includes('{') || head.includes('}')) continue;
    if (head.endsWith(',') || head.endsWith(';')) continue;
    if (!/^[.#a-zA-Z[&:*]/.test(head)) continue;
    // 声明行（prop: value）不算；含 . 的多值声明（如 transition: .2s）要放行
    if (/^[a-z-]+\s*:\s*.+$/i.test(head) && !/^[.#]/.test(head)) continue;
    if (head.length > 120) continue;

    // 找下一个非空行
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length) continue;
    const next = lines[j].trim();
    // 正常：接下来就是规则体，或是续选择器
    if (next.startsWith('{') || next.startsWith(',') || next.endsWith(',')) continue;
    // @media/@keyframes 的下一层选择器也是合法的
    if (/^(@|\d+%\s)/.test(next)) continue;
    out.push(head.slice(-80));
  }
  return out;
}

/** 递归收集指定扩展名的文件 */
export function walkFiles(root, exts) {
  const out = [];
  const go = (dir) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        go(join(dir, e.name));
      } else if (e.isFile() && exts.includes(extname(e.name))) {
        // 压缩产物（kityminder.core.min.js 等）里的类名是第三方内部实现，
        // 扫它只会报出一堆与我们无关的死类名。
        if (/\.min\.(js|mjs)$/.test(e.name)) continue;
        out.push(join(dir, e.name));
      }
    }
  };
  go(root);
  return out;
}

/**
 * 主扫描。
 * @param {object} o
 * @param {string} o.root        仓库/插件根
 * @param {string[]} o.cssFiles  要解析的 CSS（绝对/相对 root）
 * @param {string[]} [o.srcGlobs] 源码目录（默认整个 root）
 * @param {string[]} [o.allowDead] 允许无定义的类名白名单（第三方/动态拼接）
 */
export function scanDeadClasses({ root, cssFiles, srcDirs = null, allowDead = [], excludeSrc = null }) {
  const defined = new Set();
  const cssText = [];
  for (const f of cssFiles) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, 'utf-8');
    cssText.push({ file: f, text: txt });
    for (const c of collectDefinedClasses(txt)) defined.add(c);
  }

  const srcFiles = [];
  // 默认是 ['.'] 而不是 [root] —— 后者会被 join(root, root) 拼成
  // `<root>/<root>`（root 为绝对路径时），路径不存在 → 扫到 0 个文件
  // → used 为空 → 死类名恒为 0，防线等于没开。实测踩到。
  const dirs = srcDirs || ['.'];
  for (const d of dirs) {
    const abs = join(root, d);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      srcFiles.push(...walkFiles(abs, ['.js', '.jsx', '.ts', '.tsx', '.mjs']));
    } else {
      srcFiles.push(abs);
    }
  }

  const used = new Map();   // 类名 -> 首次出现的文件
  const exRe = excludeSrc ? new RegExp(excludeSrc) : null;
  for (const f of srcFiles) {
    const rel = relative(root, f);
    // 测试脚手架 / 示例插件 / 第三方封装里的类名不代表真实用法，
    // 扫进去只会淹没结果（实测 45 个里有一半是这类）。
    if (exRe && exRe.test(rel)) continue;
    let txt = '';
    try { txt = readFileSync(f, 'utf-8'); } catch { continue; }
    for (const c of collectUsedClasses(txt)) {
      if (!used.has(c)) used.set(c, relative(root, f));
    }
  }

  const allow = new Set(allowDead);
  const dead = [];
  for (const [c, f] of used) {
    if (defined.has(c) || allow.has(c)) continue;
    dead.push({ cls: c, file: f });
  }

  const orphan = [];
  for (const c of defined) {
    if (!used.has(c)) orphan.push(c);
  }

  const truncated = [];
  for (const { file, text } of cssText) {
    for (const h of findTruncatedRules(text)) truncated.push({ file, head: h });
  }

  return { defined, used, dead, orphan, truncated };
}
