import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/*
 * 源码级守卫：卡片信息行的类名。
 *
 * ================= 为什么需要这条 =================
 *
 * 这类问题**测试跑不出来**（样式不影响逻辑），界面上也只是"有点怪"，
 * 没人会立刻想到是类名没定义。只有从源码扫一遍能逮到。
 *
 * 起因：.node-brief 被 4 张卡片用了，styles.css 里却根本没有定义 ——
 * 于是那几张卡片的摘要行是裸文本，长内容还会把卡片撑破。
 * 根因是同类信息分裂成两套名字（node-brief / node-sub），
 * 名字之间看不出是一类东西，其中一套就被整个忘掉了。
 */

/*
 * 与 uiConsistency.test.ts 同一套路：源码不在测试目录里，
 * 靠 AF_SRC 指过去；没设就跳过（而不是失败）——
 * 否则在没带源码的环境里跑，每条都会因为"读不到文件"而红，
 * 那是假失败，会掩盖真问题。
 */
/*
 * 刻意**不用** __dirname 兜底：strip 成 ESM 后 __dirname 不存在，
 * 一引用就 ReferenceError。没给 AF_SRC 就整体跳过（而不是崩）——
 * 在没带源码的环境里崩掉是假失败，会掩盖真问题。
 */
const ROOT = process.env.AF_SRC || '';

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 注释里为了说明"为什么不能这么写"，正好会把坏写法原样写出来 —— 不剥掉说明本身就会让检查永远失败 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

function read(p: string): string {
  return stripComments(fs.readFileSync(p, 'utf-8'));
}

/**
 * CSS 里出现过的类名（含 .a, .b 这种并列定义）。
 *
 * 必须先剥注释 —— 注释里为说明"为什么这么改"会把类名原样写出来，
 * 不剥的话**把定义删掉后检查依然通过**（假阴性）。
 */
function cssClasses(css: string): Set<string> {
  const set = new Set<string>();
  for (const m of stripComments(css).matchAll(/\.([a-zA-Z][\w-]*)/g)) set.add(m[1]);
  return set;
}

/** 外壳提供的类名（nx- 前缀等），插件自己不定义 */
const EXTERNAL = /^nx-/;
/** 模板字符串拼出来的前缀：真正的值运行时才知道 */
const DYNAMIC = /^(badge|level|size|status|st|has)-?$|^is-/;

function usedClasses(src: string): Set<string> {
  const set = new Set<string>();
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    // 去掉 ${expr} 再按空白切分，剩下的就是字面量类名
    const cleaned = raw.replace(/\$\{[^}]*\}/g, ' ');
    for (const c of cleaned.split(/\s+/)) {
      if (/^[a-zA-Z][\w-]*$/.test(c)) set.add(c);
    }
  }
  return set;
}

function sources(): string[] {
  if (!ROOT) return [];
  return [...walk(path.join(ROOT, 'components')), ...walk(path.join(ROOT, 'nodes'))];
}

const cssPath = ROOT ? path.join(ROOT, 'styles.css') : '';
const hasSrc = cssPath !== '' && fs.existsSync(cssPath);
const css = hasSrc ? fs.readFileSync(cssPath, 'utf-8') : '';
const defined = cssClasses(css);

test('组件里用到的类名都在 styles.css 里有定义', () => {
  if (!hasSrc) return;
  const missing: string[] = [];
  for (const f of sources()) {
    for (const c of usedClasses(read(f))) {
      if (defined.has(c)) continue;
      if (EXTERNAL.test(c)) continue;
      if (DYNAMIC.test(c)) continue;
      missing.push(`${path.relative(ROOT, f)} → .${c}`);
    }
  }
  assert.deepEqual(missing, [], `这些类名没有样式定义：\n${missing.join('\n')}`);
});

/* ================= 统一后旧名字不能回来 ================= */

/**
 * 卡片信息行已统一到 node-line 一族（块 + --变体 + __零件），
 * 旧名字之间看不出是一类东西，留着任何一个都可能被新代码抄回去 ——
 * 而抄回去不报错，只是又多一套平行的类名。
 */
const LEGACY = [
  'node-brief', 'node-sub', 'fs-summary', 'fs-path', 'fs-op', 'fs-arrow', 'fs-flag',
  'node-prompt', 'node-model', 'node-meta', 'node-out', 'node-err', 'node-cli',
  'node-files', 'node-files-badge', 'node-tag', 'node-kind', 'node-alert',
];

test('卡片信息行的旧类名不再出现', () => {
  if (!hasSrc) return;
  const bad: string[] = [];
  for (const f of sources()) {
    const src = read(f);
    for (const old of LEGACY) {
      // 只认出现在 className 字符串里的（"x" 或 `x ` 或 `x`），避免误伤无关文本
      if (src.includes(`"${old}"`) || src.includes(` ${old} `) || src.includes(` ${old}\``)) {
        bad.push(`${path.relative(ROOT, f)} → ${old}`);
      }
    }
  }
  assert.deepEqual(bad, [], `这些旧类名已统一成 node-line 一族：\n${bad.join('\n')}`);
});

/* ================= 新体系自身 ================= */

/** 摘要行缺了这三样，长内容会把卡片撑破 */
test('.node-line--brief 有定义且能单行截断', () => {
  if (!hasSrc) return;
  const m = css.match(/\.node-line--brief\s*\{[^}]*\}/);
  assert.ok(m, '.node-line--brief 必须有样式定义');
  assert.ok(m[0].includes('overflow: hidden'), '缺 overflow: hidden');
  assert.ok(m[0].includes('text-overflow: ellipsis'), '缺 text-overflow');
  assert.ok(m[0].includes('white-space: nowrap'), '缺 white-space: nowrap');
});

/** 胶囊标签合成一个 .node-pill，抄两份就会改一个忘另一个 */
test('胶囊标签只定义一次', () => {
  if (!hasSrc) return;
  /*
   * 数"以 .node-pill 开头的规则块"有几个。
   * 不用 /\.node-pill[\s\S]{0,200}?\}/ 这类非贪婪写法 ——
   * 定义块超过 200 字符时它根本匹配不到，于是数出来是 0，
   * 看着像"没定义"，实际是正则截断（假象）。
   */
  const n = [...stripComments(css).matchAll(/(?:^|\n)\.node-pill\s*\{/g)].length;
  assert.equal(n, 1, '.node-pill 只能有一处定义（抄两份就会改一个忘另一个）');
  const at = css.indexOf('.node-pill {');
  assert.ok(at >= 0 && css.slice(at, at + 320).includes('border-radius'), '.node-pill 必须有完整样式');
});

/**
 * "块管节奏、变体管外观" —— 需要基类节奏的变体必须挂在块上。
 *
 * 只写 node-line--brief 而不带 node-line 的话，间距与字号基准就丢了。
 *
 * 反过来，**不是所有变体都要带块**：--foot / --flag / --alert / --err /
 * --lead / --foot / --flag / --alert / --err / --mono 自带 margin 与字号，是独立行，
 * 再挂上基类反而会多出一重 margin（第一版就是这么写错并误报的）。
 */
const NEEDS_BLOCK = ['brief', 'path', 'preview', 'meta'];

test('需要基类节奏的变体都挂了块类名', () => {
  if (!hasSrc) return;
  const bad: string[] = [];
  for (const f of sources()) {
    const src = read(f);
    for (const m of src.matchAll(/className="([^"]*)"/g)) {
      const list = m[1].split(/\s+/);
      const needs = list.some((c) => NEEDS_BLOCK.includes(c.replace('node-line--', '')));
      if (needs && !list.includes('node-line')) bad.push(`${path.relative(ROOT, f)} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], '这些变体必须和块类名 node-line 一起用');
});

/**
 * .node-chip 是**参数卡片**（NodeCardChips，会换色 / 虚线）专用的，
 * 胶囊小标签必须用 .node-pill。
 *
 * 第一版把胶囊命名为 node-chip，于是它与参数卡片**撞名** ——
 * 两边样式互相覆盖。而"必须有定义"这条守卫查不出来：
 * node-chip 确实有定义，只是属于另一族。
 * 撞名只能靠"这个类只允许一个文件用"来盯。
 */
test('.node-chip 只允许参数卡片用', () => {
  if (!hasSrc) return;
  const bad: string[] = [];
  for (const f of sources()) {
    if (path.basename(f) === 'NodeCardChips.tsx') continue;
    const src = read(f);
    if (src.includes('"node-chip"') || /[`\s]node-chip[`\s]/.test(src)) {
      bad.push(path.relative(ROOT, f));
    }
  }
  assert.deepEqual(bad, [], '.node-chip 是参数卡片专用，胶囊标签请用 .node-pill');
});

/* ================= 逐字段「设为默认」 ================= */

/**
 * 字段渲染层必须按 presetKey 逐字段存默认。
 *
 * 以前只有一个"管整个节点"的按钮：想只改一个字段的默认，
 * 得先把整个节点配成想要的样子再整份存 —— 顺带把其它字段当前的值
 * 也一起定死。下面是这条能力的存在性守卫。
 */
test('字段渲染层接了逐字段设为默认', () => {
  if (!hasSrc) return;
  const src = read(path.join(ROOT, 'components/inspectors/fields.tsx'));
  for (const fn of ['setFieldsDefault', 'clearFieldsDefault', 'hasFieldDefault']) {
    assert.ok(src.includes(fn), `fields.tsx 必须用到 ${fn}`);
  }
});

/**
 * presetKey 必须与整节点那个按钮同一套算法。
 *
 * 各算一次的话两边会存到不同的键下 ——
 * 表现为"我单独设了某个字段的默认，顶部却显示没设过默认"。
 */
test('逐字段与整节点用同一个 presetKey 算法', () => {
  if (!hasSrc) return;
  const f = read(path.join(ROOT, 'components/inspectors/fields.tsx'));
  const i = read(path.join(ROOT, 'components/Inspector.tsx'));
  for (const src of [f, i]) {
    assert.ok(src.includes('matchPresetKey'), '两边都该用 matchPresetKey 算键');
    assert.ok(src.includes('allPresets'), '两边都该传 allPresets');
  }
});

/** 密钥字段必须被挡住 —— 默认值是明文落盘的 */
test('逐字段存默认要挡密钥', () => {
  if (!hasSrc) return;
  const src = read(path.join(ROOT, 'engine/nodeDefaults.ts'));
  assert.ok(src.includes('isSecretField'), '缺少 isSecretField');
  assert.ok(
    /setFieldsDefault[\s\S]{0,400}isSecretField/.test(src),
    'setFieldsDefault 里必须过一遍 isSecretField',
  );
});
