import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSrc, AF_SRC } from './srcScan';

/**
 * 「参数卡片 → 变量组」改名之后，文档与节点声明的一致性。
 *
 * ================= 这一层的来历 =================
 *
 * 最早叫「参数卡片」，源文件 nodes/cardGroups.ts，节点侧声明
 * `cardGroups`。后来整个机制改名成「变量」，源文件挪到
 * nodes/variableGroups.ts，声明改成 `varGroups`。
 *
 * 而 scripts/gen-node-docs.mjs 还在硬读旧文件，且当时的处理是
 * **"文件不存在就返回空"** —— 于是静默产出 0 组：
 *
 *   · 索引里那一节变成空表，前面还挂着一段描述"拖到节点上会校验
 *     三件事"的说明文（功能已无）
 *   · docs/cards/ 下 4 个孤儿页原封不动留着，每页都写着
 *     "源文件：nodes/cardGroups.ts" —— 那个文件已经不存在
 *
 * 症状是**安静的**：生成器打印"0 个卡片组"，没人会去看。
 * 所以这里的守卫重点不是"文档写得好不好"，而是：
 * 组数不能为 0、页面不能指向不存在的文件、读不到源文件必须抛错。
 */
const CARDS_DIR = path.join(AF_SRC, 'docs', 'cards');

/** 从 nodes/variableGroups.ts 里抓注册的组名 */
function registeredGroups(): string[] {
  const src = readSrc('nodes/variableGroups.ts');
  return [...src.matchAll(/group:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** 扫 defs：dataKind / legacy / varGroups */
function defDecls(): { kind: string; legacy: boolean; varGroups: string[] }[] {
  const dir = path.join(AF_SRC, 'nodes', 'defs');
  const out: { kind: string; legacy: boolean; varGroups: string[] }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.tsx?$/.test(f)) continue;
    const src = readSrc(path.join('nodes', 'defs', f));
    const dk = src.match(/dataKind:\s*'([^']+)'/);
    if (!dk) continue;
    const vg = src.match(/varGroups:\s*\[([^\]]+)\]/);
    out.push({
      kind: dk[1],
      legacy: /legacy\s*:\s*true/.test(src),
      varGroups: vg ? [...vg[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [],
    });
  }
  return out;
}

test('注册了组（扫描正则有效）', () => {
  const gs = registeredGroups();
  assert.ok(gs.length >= 4, `只抓到 ${gs.length} 组，正则可能失效了`);
  for (const g of ['github-repo', 'http-endpoint', 'llm-config', 'workdir']) {
    assert.ok(gs.includes(g), `缺 ${g}`);
  }
});

/**
 * 每个变量组至少被一个**非 legacy** 节点声明。
 *
 * 盲测炸出来的：ocr / translate 都声明了 llm-config，合并出来的
 * llmChat 却没有 —— 于是"几个节点共用一份模型配置"这个能力，
 * 在推荐节点上用不了，只在被标 legacy 的老节点上还能用。
 *
 * 后果是双份且都不报错：属性面板不渲染选择器（fields.tsx 按
 * meta.varGroups 渲染），把模型变量拖上去还会被**明确拒绝**
 * （App 里 checkVarForNode 按同一份声明判定）。
 *
 * 只看"有没有节点声明"抓不到它 —— ocr/translate 仍在，
 * 所以必须把 legacy 排除掉再数。
 */
test('每个变量组至少被一个非 legacy 节点声明（合并漏挂的典型症状）', () => {
  const decls = defDecls();
  assert.ok(decls.length >= 30, `只抓到 ${decls.length} 个节点，正则可能失效了`);

  for (const g of registeredGroups()) {
    const users = decls.filter((d) => d.varGroups.includes(g));
    assert.ok(
      users.some((u) => !u.legacy),
      `变量组 ${g} 只被 legacy 节点声明（${users.map((u) => u.kind).join(', ')}）`
      + ' —— 现行节点上这个能力就没了，多半是合并时漏挂',
    );
  }
});

/**
 * 文档层：卡片页与注册的组一一对应。
 *
 * "0 组"正是这次的症状 —— 生成器静默返回空，页面不写也不删，
 * 于是留下一堆指向已消失源文件的孤儿页。
 */
test('docs/cards 与注册的组一一对应（不能是 0 组、不能有孤儿）', () => {
  const gs = registeredGroups();
  const files = fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'docs/cards 是空的 —— 生成器多半又静默跳过了这一层');

  const names = files.map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepEqual(names, [...gs].sort(), '卡片页与注册的组不一致（有孤儿页或漏生成）');

  for (const f of files) {
    const s = fs.readFileSync(path.join(CARDS_DIR, f), 'utf-8');
    assert.ok(
      !s.includes('nodes/cardGroups.ts'),
      `${f} 还指向已删除的 nodes/cardGroups.ts —— 机制已改名成变量组`,
    );
    assert.ok(s.includes('nodes/variableGroups.ts'), `${f} 没写源文件`);
  }
});

/**
 * 生成器本身：读的是新文件，且读不到就抛错。
 *
 * 上一版"文件不存在就返回空"是这次问题的根 ——
 * 它让"结构性失效"看起来像"这一层本来就没有"。
 */
test('文档生成器读 variableGroups.ts，读不到要抛错而不是静默跳过', () => {
  const src = readSrc('scripts/gen-node-docs.mjs');
  assert.ok(AF_SRC, 'AF_SRC 未设置');

  /*
   * 必须盯**具体的那一行**，不能用 `src.includes('nodes/variableGroups.ts')`
   * 这种整串匹配 —— 源码里写的是
   *   path.join(ROOT, 'nodes', 'variableGroups.ts')
   * 文件名是两个独立的字符串参数，中间隔着 `', '`，
   * 于是"整串"永远匹配不上，而"整串不存在"也永远成立 ——
   * 那样的守卫**永远通过**，比没有守卫更危险。
   *
   * （第一版我就写成了整串匹配：注入故障后它照样报绿。）
   */
  const m = src.match(/const\s+p\s*=\s*path\.join\([^)]*?,\s*'([^']+\.ts)'\s*\);/);
  assert.ok(m, '没解析出采集变量组时读的源文件那一行，正则可能失效了');
  assert.equal(m[1], 'variableGroups.ts', '生成器读的不是 variableGroups.ts');

  assert.ok(
    !/'cardGroups\.ts'/.test(src),
    '生成器还在读已删除的 cardGroups.ts（参数卡片时期的旧文件）',
  );

  /* 读不到就抛错：紧跟在 existsSync 判空之后 */
  const guard = src.match(/if\s*\(!fs\.existsSync\(p\)\)\s*\{[\s\S]{0,200}?\}/);
  assert.ok(guard, '没找到"源文件不存在"的处理分支');
  assert.ok(/throw\s+new\s+Error/.test(guard[0]), '读不到源文件时必须抛错，不能静默返回空');
});
