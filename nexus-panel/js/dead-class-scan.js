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
  /*
   * 2c: 裸三元 —— className={x.isError ? 'fpx-log-line err' : 'fpx-log-line'}
   *
   * 与 2a2 的区别：2a2 要求 `{` 之后**紧跟引号**，而这里 `{` 之后是条件
   * 表达式（`l.isError ?`），于是整条匹配不上 → fpx-log-line / fpx-picker /
   * fpx-stack-box 这类**确实在挂**的类被判成死样式。
   *
   * 只取三元**分支**里的字面量，不取条件里的：
   *   `tab === 'mine' ? ' on' : ''` 中 'mine' 是比较值，不是类名。
   * 判据是"字面量后面紧跟的字符" —— 紧跟 `?` 的是条件值（跳过），
   * 其余（紧跟 `:` 或 `}`）是分支值（取）。与 2b 用的是同一套判据。
   */
  for (const m of src.matchAll(/class(?:Name)?\s*=\s*\{([^{}]*)\}/g)) {
    const expr = m[1];
    if (!expr.includes('?')) continue;
    for (const s of expr.matchAll(/['"`]([^'"`]*)['"`]/g)) {
      let k = (s.index ?? 0) + s[0].length;
      while (k < expr.length && /\s/.test(expr[k])) k++;
      if (expr[k] === '?') continue; // 条件值，不是类名
      addTokens(s[1]);
    }
  }
  /*
   * 2d: 导出的类名常量 —— export const PUML_BOX_CLASS = 'md-puml-box'
   *
   * 类名被抽成常量后，DOM 上挂的是标识符而不是字面量串，
   * 于是 CSS 里那个类永远"没人用" → 被判成死样式。
   * 只认名字里带 CLASS/CLS 的常量，避免把普通字符串常量也当类名。
   */
  for (const m of src.matchAll(
    /\bconst\s+[A-Za-z_$][\w$]*(?:CLASS|CLS|Cls|Class)[\w$]*\s*=\s*['"`]([^'"`]+)['"`]/g,
  )) {
    addTokens(m[1]);
  }
  /*
   * 3: hyperscript 简写 —— 任意创建辅助函数的 'tag.class' 形式
   *
   * ⚠️ 原来只认 `h(`。而 plugins/folder-picker/module.js 用的是它自己
   * 定义的 `el('div.fp-panel')`，于是这个插件 22 个 fp-* 类名**全部**
   * 被判成死样式 —— 而它们其实一个样式都没有（CSS 里根本没写），
   * 真正该报的是"代码用了、CSS 没定义"，反向失明导致漏报。
   *
   * 这是本项目第 6 次栽在"类名走函数参数、扫描器不认"上
   * （nx-mask / mm-* / dw-* / pg-* …），所以这次不按函数名白名单补，
   * 改成**按形态判**：第一个 . 之前必须是真实 HTML 标签名。
   * 这样 `console.log('a.b')` 之类不会被误取，也不用再逐个加函数名。
   */
  const TAG = 'div|span|button|input|select|textarea|label|a|ul|li|ol|p|h[1-6]|small|code|pre'
    + '|section|header|footer|aside|nav|main|article|table|tr|td|th|img|svg|i|b|strong|em'
    + '|form|option|dialog|figure|figcaption';
  for (const m of src.matchAll(
    new RegExp("\\b[A-Za-z_$][\\w$]*\\(\\s*['\"`](?:" + TAG + ")((?:[.#][\\w-]+)+)['\"`]", 'g'),
  )) {
    for (const tok of (m[1] || '').split(/[.#]/)) {
      const name = tok.trim();
      if (name && /^[A-Za-z_-][\w-]*$/.test(name)) out.add(name);
    }
  }
  /*
   * 4: classList.add('x') / toggle / remove / contains
   *
   * ⚠️ 方法访问必须接受**可选链**写法（`classList?.add`）。
   * 实测（2026-09-29）：host.js 里 `iframe?.classList?.add('revealed')`
   * 是插件 iframe 摘遮罩的唯一入口，而原正则只认 `classList.`，
   * 于是 `revealed` 被判成"全仓 0 引用"。
   *
   * 后果是双向的，且都很隐蔽：
   *   · A 维漏报 —— 真把 .revealed 的样式删了也不报红，
   *     表现是插件 iframe 永远隐身（遮罩摘不掉），不报错、难归因；
   *   · D 维误报 —— 它在用却被列进"真废弃"候选，诱导人去删。
   */
  for (const m of src.matchAll(/classList\??\.(?:add|toggle|remove|contains)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
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
  /*
   * 6: h('button', { class: 'dw-switch', ... }) —— h() 的**属性对象**
   *
   * 与分支 5 同源：类名既不是 class=/className= 的属性值，
   * 也不是 h('div.mm-foo') 的简写，而是作为属性对象的字段值传进去。
   *
   * 这是本仓库 h() 最常见的用法（js/shell.js 里到处都是），
   * 不认的话这些类名一律被判成"CSS 里定义了、代码里没人用" ——
   * 于是往 CSS 里新加的 .dw-* 会被报成死样式，改观感的人只能去改白名单，
   * 白名单一长就再也没人分得清哪条是真废弃。
   *
   * 判据用 \bclass\s*: 而不是匹配 h( 上下文：
   *   · React/JSX 用 className，不会撞；
   *   · 类型声明里的 `class?: string` 是 `class?` 不是 `class:`，也不会撞；
   *   · classList.add 已被分支 4 覆盖，写法不同不冲突。
   */
  for (const m of src.matchAll(/\bclass\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? '');
    for (const part of body.split(/\$\{[^}]*\}/)) addTokens(part);
    /*
     * 模板串里的三元分支（class: `dw-switch${on ? ' on' : ''}`）
     * 也是会真实挂到 DOM 上的类，不取就会漏。
     * 沿用模板串那条分支的判据：后面紧跟 ? 的是**条件值**，跳过。
     */
    for (const inner of body.matchAll(/\$\{([^}]*)\}/g)) {
      const expr = inner[1];
      for (const sm of expr.matchAll(/['"`]([^'"`]*)['"`]/g)) {
        let k = (sm.index ?? 0) + sm[0].length;
        while (k < expr.length && /\s/.test(expr[k])) k++;
        if (expr[k] === '?') continue;
        addTokens(sm[1]);
      }
    }
  }
  /*
   * 6b: class: 'tb-card' + (joined ? ' joined' : '') —— **拼接 + 三元**
   *
   * 分支 6 的正则只吃到紧跟 class: 的**那一个**字符串字面量，
   * 拼接在后面的 `' joined'` `' is-hidden'` 一个都取不到。
   * 实测（2026-09-29）：joined 因此被判"全仓 0 引用"，
   * 只能靠 TIER 白名单兜着 —— 而白名单只压住"报红"，压不住失效：
   * 真把 .tb-card.joined 的规则删掉，静默无声，卡片不再区分
   * "已在右上角"和"还能加"，而没人会往样式上想。
   *
   * 判据与分支 5 / 6 完全同源：字面量后面紧跟 `?` 的是**条件值**，跳过；
   * 其余（紧跟 `:` 或 `)` 或 `}`）是分支值或普通拼接段，取。
   * 不另发明规则，是为了避免"同一语义两套判据"必然产生的漂移。
   */
  for (const m of src.matchAll(/\bclass\s*:\s*["'`][^"'`]*["'`]\s*(\+[^,;\n}]{0,160})/g)) {
    const expr = m[1];
    for (const sm of expr.matchAll(/['"`]([^'"`]*)['"`]/g)) {
      let k = (sm.index ?? 0) + sm[0].length;
      while (k < expr.length && /\s/.test(expr[k])) k++;
      if (expr[k] === '?') continue;
      addTokens(sm[1]);
    }
  }
  /*
   * 7: el('div.fp-panel') —— **类名写在标签串里**（tag.class 简写）
   *
   * 这是 folder-picker 服务（plugins/folder-picker/module.js）的写法：
   *     function el(tag, props = {}, ...kids) {
   *       const [head, ...rest] = String(tag).split('.');
   *       node.className = rest.join(' ');
   *
   * 类名既不是第二参（分支 5 要求 el 的第二参是 cls），
   * 也不是 class= 属性（分支 6 要求属性对象），
   * 而是**第一参里点号后面的那几段**。1~6 一条都匹配不到。
   *
   * 后果与分支 5 那次完全同形（双向失明）：
   *   · 方向1 看新类名（改坏后的 .fp-panelx），代码里确实没有 → 该报死样式，
   *     但旧类名已从 CSS 消失，无从对照；
   *   · 方向2 看旧类名 fp-panel，而它压根没被提取出来。
   * 实测：不认这种写法时，新增的 20 个 .fp-* 全部被报成"真废弃"，
   * 基线从 41 涨到 62 —— 而它们每一个都在用。
   *
   * 【判据必须绑到实现上】
   * 只有当本文件的 el **真的**把 tag 按点号拆开当类名时（`.split('.')`）
   * 才走这条分支。无条件匹配 el('div.xxx') 会把标签名误当类名，
   * 也会把别处"带点的字符串第一参"误判进来。
   */
  const elSplitsTag = /String\s*\(\s*tag\s*\)\s*\.split\s*\(\s*['"`]\.['"`]\s*\)/.test(src)
    || /tag\s*\.split\s*\(\s*['"`]\.['"`]\s*\)/.test(src);
  if (elSplitsTag) {
    /*
     * ⚠️ 字符类里**必须有连字符**：类名普遍带 `-`（fp-panel / md-toc-lv）。
     * 早先写的是 [\w.] —— \w 不含 `-`，于是遇到第一个连字符就停，
     * 后半截吃掉后要求收引号却撞上 `-`，整条匹配失败。
     * 后果是这一个分支**对所有带连字符的类名全部失效**：
     * folder-picker 整份 module.js 提取出 0 个类名，
     * 于是它所有样式都被判成"CSS 定义了、代码没人用"（假死样式），
     * 而反方向 —— 样式真被删了 —— 同样发现不了。两个方向一起瞎。
     */
    for (const m of src.matchAll(/\bel\(\s*['"`]([a-zA-Z][\w.-]*)['"`]/g)) {
      const parts = String(m[1]).split('.');
      if (parts.length < 2) continue;                 // 纯标签，没有类名
      for (const p of parts.slice(1)) addTokens(p);
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
 * 类名在 CSS 里的**出现形态**：独立（`.foo`）还是修饰（`.父.foo`）。
 *
 * 返回 Map<类名, { solo: number, parents: Set<string> }>。
 *
 * 为什么要区分：像 `.nx-row.end`、`.task-bar-in.cancelled`、`.nx-btn.solid`
 * 这类**只在复合选择器里出现**的类，本质是父类的状态修饰档，
 * 命运跟着父类走 —— 父类在用，它就是"暂未使用的档位"；
 * 父类是备用档位（nx-/p-/nm-/mm-），它同样是备用。
 *
 * 把它们当成独立幽灵规则去停用，等于把父类的一档悄悄删掉：
 * 不报错、测试也不红，只有界面上某个状态不再有对应观感时才被发现。
 *
 * 实现上先把规则体去掉（只留选择器），再数每个选择器里有几个点类：
 * 只有它自己 → 独立；还有别人 → 修饰，那些"别人"就是它的父类。
 */
export function analyzeClassForms({ root, cssFiles }) {
  const forms = new Map();
  const touch = (c) => {
    if (!forms.has(c)) forms.set(c, { solo: 0, parents: new Set() });
    return forms.get(c);
  };
  for (const f of cssFiles) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    let txt = '';
    try { txt = stripComments(readFileSync(p, 'utf-8')); } catch { continue; }
    // 去掉规则体：只保留选择器部分，免得 `url(.png)` 之类被当成类名
    const selOnly = txt.replace(/\{[^}]*\}/g, '|');
    for (const sel of selOnly.split('|')) {
      const cs = [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
      if (!cs.length) continue;
      for (const c of cs) {
        const e = touch(c);
        if (cs.length === 1) e.solo += 1;
        else for (const o of cs) if (o !== c) e.parents.add(o);
      }
    }
  }
  return forms;
}

/** 类的名字里带 cls / class（含驼峰变体，如 editCls / ARG_CLASS） */
const CLASS_NISH = /cls|class/i;

/**
 * 收集**类名上下文**里的字符串字面量用到的类名。
 *
 * 针对的是这种写法（agent-flow 的 ArgCell.tsx 真实代码）：
 *
 *   const ARG_CLASS: Record<Role, string> = { val: 'node-arg', op: 'node-arg is-op', ... };
 *   const editCls = isArea ? 'node-arg-area nodrag nopan' : 'node-arg-in nodrag nopan';
 *   const cls = `${className}${edit ? ' is-editable' : ''}${part.key ? ' node-arg-port' : ''}`;
 *
 * 源码里没有 `class="node-arg"`，按 `class=`/`className=` 提取的扫描器
 * 会把它们全判成"CSS 定义了、代码没用"。照着停用会**弄坏正在用的样式**
 * （参数格子的下凹观感、多行参数框），且不报错。
 *
 * 更讽刺的是 ArgCell.tsx 里那段注释：作者**刻意**把 `role-${p.role}`
 * 改成查表，就是为了让"类名必须先在 CSS 里定义"这条守卫能抓到拼错的
 * 类名 —— 而反向守卫（本函数要解决的这一维）当时还不存在，
 * 于是查表写法反而被判成死规则，**正好抵消了作者的用心**。
 *
 * 收窄口径（避免把普通字符串也当类名，实测裸字面量会误伤 27 处）：
 *   1. 字面量所在行、或它所属的对象字面量，名字里得有 cls / class
 *   2. 字面量得**整体**由类名形态的 token 构成（不含 `$ { }` 之外的怪字符）
 *   3. 模板串先剥掉 `${...}` 再分词
 */
export function collectClassLiterals({ root, files }) {
  const out = new Set();
  const add = (s) => {
    /*
     * 模板串里的类名常常**躲在 `${...}` 内部**：
     *   const cls = `${className}${edit ? ' is-editable' : ''}${part.key ? ' node-arg-port' : ''}`;
     *
     * ⚠️ 不能整段剥掉 `${...}` —— 那会把 ' node-arg-port' 一起剥没，
     *    这条真在用的类名又被判成幽灵规则。
     * ⚠️ 也不能直接在原串上按引号切 —— `${... : ''}` 里的空串会让引号
     *    配对错位，实测 ' node-arg-port' 会被切进一段 `}${part.key ? ` 里，
     *    因含 `}$` 被形态检查否掉。
     *
     * 所以只**摘掉 `${` 与 `}` 这两个定界符**保留内部文本，再按引号取串：
     * 里面的 ' is-editable' / ' node-arg-port' 就都能正常取到了。
     */
    const str = String(s).replace(/\$\{/g, ' ').replace(/\}/g, ' ');
    /*
     * ⚠️ 引号内容允许**空串**（`{0,120}` 而不是 `{1,120}`）：
     * `${edit ? ' is-editable' : ''}` 里的 `''` 如果不被单独吃掉，
     * 引号配对就会整体错位一格 —— 实测 ' node-arg-port' 被切进
     * `   part.key ? ` 这种含空格/点的片段里，形态检查否掉，于是漏收。
     */
    const quoted = [...str.matchAll(/'([^'\n]{0,120})'|"([^"\n]{0,120})"/g)]
      .map((m) => m[1] ?? m[2] ?? '');
    // 没有引号串时（裸模板段 `${cls} on`），整段按 token 处理
    const parts = quoted.length ? quoted : [str];
    for (const part of parts) {
      const toks = part.trim().split(/\s+/).filter(Boolean);
      // 一个类名最长 40 字符；整串超过 6 个 token 多半不是类名清单
      if (!toks.length || toks.length > 6) continue;
      if (!toks.every((t) => /^[A-Za-z][\w-]{0,40}$/.test(t))) continue;
      for (const t of toks) out.add(t);
    }
  };
  const LIT = /'([^'\n]{1,120})'|"([^"\n]{1,120})"|`([^`\n]{1,120})`/g;

  for (const f of files) {
    let txt = '';
    try { txt = stripComments(readFileSync(f, 'utf-8')); } catch { continue; }
    const lines = txt.split('\n');

    // 名字含 cls/class 的**对象字面量**：值在后续若干行里
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{/);
      if (!m || !CLASS_NISH.test(m[1])) continue;
      const buf = [];
      let depth = 0;
      for (let j = i; j < lines.length && j < i + 200; j++) {
        buf.push(lines[j]);
        for (const ch of lines[j]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        if (depth <= 0 && j > i) break;
      }
      for (const mm of buf.join('\n').matchAll(LIT)) add(mm[1] || mm[2] || mm[3] || '');
    }
    // 行内含 cls/class 标识符
    for (const line of lines) {
      if (!CLASS_NISH.test(line)) continue;
      for (const mm of line.matchAll(LIT)) add(mm[1] || mm[2] || mm[3] || '');
    }
  }
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
  /*
   * 关于「注释停用」的死规则在这里的去向：
   *
   * 本仓库把死规则定为「注释停用 + 备注」（不直接删，便于整段加回来），
   * 而 collectDefinedClasses **内部已经调用 stripComments**（见其第一行），
   * 所以被注释掉的规则**不会被收进 defined**——停用即等于未定义。
   *
   * 这一点正是下面 orphan（幽灵规则）能度量清理进度的前提：
   * 清掉一处，orphan 就少一处；若哪天有人改成"不剥注释"地提取，
   * 停用就不再生效、进度也无法度量，且不会有任何报错。
   */
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
    /*
     * 必须先剥注释再提取。
     *
     * 收集实现（collectUsedClasses）认 `class="…"` / `className=` 等字面
     * 写法，而**注释里举例**时同样会出现这些写法。不剥的话注释里的
     * 类名会被当成真实用法报出来（实测：md 的 text-of.js 注释里写了
     * `<span class="hljs-keyword">` 举例，被判成"代码用了但没定义"）。
     *
     * 更隐蔽的是它只影响这一条路径：调用方的内联扫描自己剥了注释，
     * 于是同一份代码两套扫描结果不一致 —— 一边报、一边不报，
     * 看起来像随机波动，实际是本函数少了一步。
     */
    for (const c of collectUsedClasses(stripComments(txt))) {
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

  /*
   * 两条**减噪判据**，供调用方判定 orphan 时豁免。
   *
   * 两者都是"误删防线"：orphan 这一维天生容易把在用样式判成死的
   * （修饰档、查表写法），而误停用的后果是界面静默变样且不报错。
   * 放在扫描器里算，是为了让调用方不必各自再 walk 一遍文件 ——
   * 各写一份必然漂移（本仓库已多次栽在这种"两套实现"上）。
   */
  const forms = analyzeClassForms({ root, cssFiles });
  const classLiterals = collectClassLiterals({
    root,
    files: srcFiles.filter((f) => {
      const rel = relative(root, f);
      return !(exRe && exRe.test(rel)) && !/node_modules/.test(rel);
    }),
  });

  const truncated = [];
  for (const { file, text } of cssText) {
    for (const h of findTruncatedRules(text)) truncated.push({ file, head: h });
  }

  return { defined, used, dead, orphan, truncated, forms, classLiterals };
}
