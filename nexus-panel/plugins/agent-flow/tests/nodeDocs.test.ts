import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { blockCatalog, SPECS, CAPABILITY_SIGNATURES } from '../engine/nodeSpec';

/**
 * 控件索引路由表（docs/）的一致性测试。
 *
 * ================= 为什么要这份测试 =================
 *
 * docs/ 是**自动生成**的（scripts/gen-node-docs.mjs）。生成物最怕的不是
 * 生成错，而是**改了代码没重新生成** —— 那时文档继续存在、看着也像那么回事，
 * 但内容与代码不符，而且没人会发现。
 *
 * 这个项目已经为此吃过四次亏（KV 抄 4 份、SECRET_PATHS 抄 2 份、
 * 圆点色抄 2 份、契约把 update 标错），全是"同一件事两处写、漏改一处"。
 *
 * 所以这里不测"文档写得好不好"，只测**文档与当前代码是否一致**。
 */
const SRC = process.env.AF_SRC || '';
const DOCS = path.join(SRC, 'docs');
const nodesDir = path.join(DOCS, 'nodes');

test('AF_SRC 已设置（docs 在仓库里，测试在 $OUT/tests 下跑）', () => {
  assert.ok(SRC, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
});

/* ---------------- 结构完整 ---------------- */

test('三层结构齐全：索引 + 每个控件两页', () => {
  assert.ok(fs.existsSync(path.join(DOCS, 'README.md')), '缺 docs/README.md');
  for (const b of blockCatalog()) {
    for (const suffix of ['', '.params']) {
      const f = path.join(nodesDir, `${b.kind}${suffix}.md`);
      assert.ok(fs.existsSync(f), `缺 ${b.kind}${suffix}.md`);
    }
  }
});

test('文档都标了"自动生成"，避免手改后再被覆盖', () => {
  const files = [path.join(DOCS, 'README.md')];
  for (const b of blockCatalog()) {
    files.push(path.join(nodesDir, `${b.kind}.md`));
    files.push(path.join(nodesDir, `${b.kind}.params.md`));
  }
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf-8');
    assert.ok(s.includes('自动生成'), `${path.basename(f)} 没标"自动生成"`);
  }
});

/* ---------------- 与契约一致（防"改了代码没重新生成"）---------------- */

test('每个控件的说明页：产出 / 接受 / 能力与当前契约一致', () => {
  for (const b of blockCatalog()) {
    const s = fs.readFileSync(path.join(nodesDir, `${b.kind}.md`), 'utf-8');
    assert.ok(
      s.includes(`**产出**：${b.produces}`),
      `${b.kind}.md 的产出写的是旧值（当前应为 ${b.produces}）—— `
      + '改了契约要重跑 scripts/gen-node-docs.mjs',
    );
    const line = s.split('\n').find((l) => l.includes('需要的外部能力')) ?? '';
    // 文档里每个能力名都带反引号，比对前先去掉
    const gotReq = line.replace(/`/g, '');
    if (b.requires.length) {
      for (const r of b.requires) {
        assert.ok(
          gotReq.includes(r),
          `${b.kind}.md 的能力清单缺 ${r}（当前应为 ${b.requires.join(', ')}）—— `
          + '改了 nodeRequires 要重跑 scripts/gen-node-docs.mjs',
        );
      }
    } else {
      assert.ok(gotReq.includes('无'), `${b.kind}.md 不该列出能力（它是纯本地的）`);
    }
  }
});

test('索引里收录了全部控件，一个都不能漏', () => {
  const idx = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf-8');
  for (const b of blockCatalog()) {
    assert.ok(idx.includes(`nodes/${b.kind}.md`), `索引里漏了 ${b.kind}`);
  }
});

test('索引带上了产出/接受（决定能不能接的判据要在第一层就能看到）', () => {
  const idx = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf-8');
  assert.ok(idx.includes('产出'), '索引缺"产出"列');
  assert.ok(idx.includes('接受'), '索引缺"接受"列');
});

/* ---------------- 给 AI 用的部分不能缺 ---------------- */

test('索引带模板变量与能力签名（AI 拼装必需）', () => {
  const idx = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf-8');
  assert.ok(idx.includes('## 模板变量'), '索引缺模板变量');
  assert.ok(idx.includes('{{input}}'), '模板变量里必须有 {{input}}');
  assert.ok(idx.includes('## 能力签名'), '索引缺能力签名');
  for (const k of Object.keys(CAPABILITY_SIGNATURES)) {
    assert.ok(idx.includes(k), `索引的能力签名表里漏了 ${k}`);
  }
});

test('索引带边的写法（branch 在顶层这件事要说清）', () => {
  const idx = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf-8');
  assert.ok(idx.includes('边'), '索引缺边的写法');
  assert.ok(idx.includes('branch'), '索引没提 branch');
});

/* ---------------- 分类与代码一致 ---------------- */

/*
 * 分类标签与 nodes/types.ts 的 NODE_CATEGORY_META 一致。
 *
 * 这里刻意**不用正则**解析：strip-ts.py 剥离类型时会把正则字面量里
 * 的单引号当成字符串边界吃掉，生成的 .mjs 直接语法错误（且只在
 * 跑测试时才暴露）。改成逐行 split，既避开这个坑也好读。
 */
test('索引里的分类标签都来自 NODE_CATEGORY_META（不手写）', () => {
  const src = fs.readFileSync(path.join(SRC, 'nodes', 'types.ts'), 'utf-8');
  const idx = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf-8');

  const labels: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (line.includes('NODE_CATEGORY_META')) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (line.trim() === '};') break;
    const i = line.indexOf('label:');
    if (i < 0) continue;
    const q1 = line.indexOf("'", i);
    const q2 = line.indexOf("'", q1 + 1);
    if (q1 < 0 || q2 < 0) continue;
    labels.push(line.slice(q1 + 1, q2));
  }
  assert.ok(labels.length >= 5, `分类标签只解析到 ${labels.length} 个，解析逻辑坏了`);

  /*
   * 索引里出现的每个二级标题都必须是这些标签之一 ——
   * 若有人手改出一个不在 meta 里的分类名，这里会红。
   */
  const headings = idx
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim());
  const known = new Set([...labels, '连线判据（先看这个）', '模板变量', '边的写法', '能力签名']);
  for (const h of headings) {
    assert.ok(known.has(h), `索引里出现了不在 NODE_CATEGORY_META 里的分类：${h}`);
  }
});

/**
 * 这条守的是"生成器还能跑"。
 * 生成器依赖 build-tests.sh 的产物，契约一改就可能解析失败 ——
 * 失败时不会报错，只是文档停留在旧版本。
 */
test('参数页说明不为空（聚合逻辑没退化）', () => {
  let withHint = 0;
  for (const b of blockCatalog()) {
    if (!SPECS[b.kind]?.manualParams && b.hiddenParams.length === 0) {
      const s = fs.readFileSync(path.join(nodesDir, `${b.kind}.params.md`), 'utf-8');
      if (/\|\s*`.+?`\s*\|\s*(?!—)\S/.test(s)) withHint++;
    }
  }
  assert.ok(withHint > 0, '所有参数页都没说明 —— 字段聚合可能失效了');
});
