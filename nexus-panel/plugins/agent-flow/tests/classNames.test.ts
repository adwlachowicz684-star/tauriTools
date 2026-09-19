import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/*
 * 源码级守卫：组件里用到的 className，必须在 styles.css 里有定义。
 *
 * ================= 为什么需要这条 =================
 *
 * .node-brief 被 4 个卡片用了，但 styles.css 里**根本没有定义** ——
 * 于是那几张卡片的摘要行是裸文本：字号颜色走浏览器默认，
 * 长内容还会把卡片撑破。
 *
 * 这类问题跑测试看不出来（样式不影响逻辑），界面上也只是"有点怪"，
 * 没人会立刻想到是类名没定义。只有这种从源码扫一遍的守卫能逮到。
 *
 * 同类问题的老毛病：同一件事多处写、漏改一处。类名也是。
 */

/*
 * 与 uiConsistency.test.ts 同一套路：源码不在测试目录里，
 * 靠 AF_SRC 指过去；没设就跳过（而不是失败）——
 * 否则在没带源码的环境里跑，每条都会因为"读不到文件"而红，
 * 那是假失败，会掩盖真问题。
 */
const ROOT = process.env.AF_SRC || path.resolve(__dirname, '..');

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
 * 必须先剥掉注释 —— 注释里为了说明"为什么这么改"，正好会把类名原样写出来
 * （比如写"以前 .node-brief 与 .node-sub 并存"）。不剥的话，
 * **把定义删掉后检查依然通过**，因为注释里那个名字冒充了定义 —— 假阴性。
 */
function cssClasses(css: string): Set<string> {
  const set = new Set<string>();
  for (const m of stripComments(css).matchAll(/\.([a-zA-Z][\w-]*)/g)) set.add(m[1]);
  return set;
}

/** 外壳提供的类名（nx- 前缀等），插件自己不定义 */
const EXTERNAL = /^nx-/;

/** 模板字符串拼出来的前缀（后面接变量），真正的值在运行时才知道 */
const DYNAMIC = /^(badge|level|size|status|st|is|has)-?$/;

function usedClasses(src: string): Set<string> {
  const set = new Set<string>();
  // className="..." / className={`...`} / className={'...'}
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

const cssPath = path.join(ROOT, 'styles.css');
const hasSrc = fs.existsSync(cssPath);
const css = hasSrc ? fs.readFileSync(cssPath, 'utf-8') : '';
const defined = cssClasses(css);

test('组件里用到的类名都在 styles.css 里有定义', () => {
  if (!hasSrc) return;
  const missing: string[] = [];
  for (const f of [...walk(path.join(ROOT, 'components')), ...walk(path.join(ROOT, 'nodes'))]) {
    const src = read(f);
    for (const c of usedClasses(src)) {
      if (defined.has(c)) continue;
      if (EXTERNAL.test(c)) continue;
      if (DYNAMIC.test(c)) continue;
      missing.push(`${path.relative(ROOT, f)} → .${c}`);
    }
  }
  assert.deepEqual(missing, [], `这些类名没有样式定义：\n${missing.join('\n')}`);
});

/* ================= 同类信息必须同一套类名 ================= */

/**
 * 卡片主体的"一行摘要"只能有一个类名。
 *
 * 以前 .node-brief 与 .node-sub 并存，而 .node-brief 没定义 ——
 * 于是同样是摘要行，四张卡片长得跟别人不一样。
 */
test('卡片摘要行统一用 .node-brief', () => {
  const bad: string[] = [];
  if (!hasSrc) return;
  for (const f of [...walk(path.join(ROOT, 'components')), ...walk(path.join(ROOT, 'nodes'))]) {
    if (read(f).includes('node-sub')) bad.push(path.relative(ROOT, f));
  }
  assert.deepEqual(bad, [], '还有组件在用 .node-sub（已统一为 .node-brief）');
});

/**
 * 胶囊标签的样式只能有一处。
 *
 * 抄两份的话，改一个忘另一个 —— 同类标签长得不一样，且不报错。
 */
test('胶囊标签样式不重复定义', () => {
  if (!hasSrc) return;
  const rules = [...css.matchAll(/\.node-tag[\s\S]{0,200}?\}/g)].map((m) => m[0]);
  const count = rules.filter((r) => r.includes('border-radius')).length;
  assert.equal(count, 1, '胶囊标签的 border-radius 应只定义一次');
});

test('.node-brief 有定义且能单行截断', () => {
  if (!hasSrc) return;
  const m = css.match(/\.node-brief\s*\{[^}]*\}/);
  assert.ok(m, '.node-brief 必须有样式定义');
  const body = m[0];
  // 缺了这三样，长摘要会把卡片撑破
  assert.ok(body.includes('overflow: hidden'), '缺 overflow: hidden');
  assert.ok(body.includes('text-overflow: ellipsis'), '缺 text-overflow');
  assert.ok(body.includes('white-space: nowrap'), '缺 white-space: nowrap');
});
