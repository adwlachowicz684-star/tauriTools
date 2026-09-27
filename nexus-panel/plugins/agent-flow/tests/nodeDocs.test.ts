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
const cardsDir = path.join(DOCS, 'cards');
const reuseDir = path.join(DOCS, 'reuse');

test('AF_SRC 已设置（docs 在仓库里，测试在 $OUT/tests 下跑）', () => {
  assert.ok(SRC, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
});

/* ---------------- 结构完整 ---------------- */

/*
 * 只有两层：索引 + 参数页。
 *
 * 原先还有一层"控件说明页"，但它的独有内容只有 node.type 与从产出
 * 类型推导出的"注意"，其余都和索引/参数页重复 —— 25 页里有大段
 * 模板化填充（"从侧栏拖到画布…"），是噪音不是信息。
 * 压掉后 58 → 33 个文件，信息不丢。
 */
test('两层结构：索引 + 每个控件一个参数页', () => {
  assert.ok(fs.existsSync(path.join(DOCS, 'README.md')), '缺 docs/README.md');
  for (const b of blockCatalog()) {
    assert.ok(
      fs.existsSync(path.join(nodesDir, `${b.kind}.params.md`)),
      `缺 ${b.kind}.params.md`,
    );
  }
});

test('不再生成冗余的说明页（已压成两层）', () => {
  for (const b of blockCatalog()) {
    assert.ok(
      !fs.existsSync(path.join(nodesDir, `${b.kind}.md`)),
      `${b.kind}.md 是压掉的那层说明页，不该再生成`,
    );
  }
});

test('文档都标了"自动生成"，避免手改后再被覆盖', () => {
  const files = [path.join(DOCS, 'README.md')];
  for (const b of blockCatalog()) {
    files.push(path.join(nodesDir, `${b.kind}.params.md`));
  }
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf-8');
    assert.ok(s.includes('自动生成'), `${path.basename(f)} 没标"自动生成"`);
  }
});

/* ---------------- 与契约一致（防"改了代码没重新生成"）---------------- */

test('每个参数页头部：产出 / 接受 / 能力与当前契约一致', () => {
  for (const b of blockCatalog()) {
    const s = fs.readFileSync(path.join(nodesDir, `${b.kind}.params.md`), 'utf-8');
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
    assert.ok(idx.includes(`nodes/${b.kind}.params.md`), `索引里漏了 ${b.kind}`);
  }
});

/**
 * 索引是**路由表**不是内容副本 —— 带源文件路径，
 * 要细节就去读源文件（那里永远最新），这里只放"决定要不要进去"的判据。
 */
test('索引带源文件列（路由，不是副本）', () => {
  const idx = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf-8');
  assert.ok(idx.includes('源文件'), '索引缺"源文件"列');
  assert.ok(idx.includes('nodes/defs/'), '索引没给出 defs 路径');
  for (const b of blockCatalog()) {
    const d = fs.readdirSync(path.join(SRC, 'nodes', 'defs'))
      .find((f) => fs.readFileSync(path.join(SRC, 'nodes', 'defs', f), 'utf-8')
        .includes(`dataKind: '${b.kind}'`));
    if (!d) continue;
    assert.ok(idx.includes(`nodes/defs/${d}`), `索引里 ${b.kind} 的源文件路径不对`);
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
  const known = new Set([
    ...labels,
    // 索引里的固定小节（不是分类）
    '连线判据（先看这个）', '模板变量', '边的写法', '能力签名',
    '变量组', '复用件',
  ]);
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

/* ================= 卡片组 ================= */

test('卡片组：内置的四组都有文档页', () => {
  for (const g of ['github-repo', 'http-endpoint', 'llm-config', 'workdir']) {
    assert.ok(fs.existsSync(path.join(cardsDir, `${g}.md`)), `缺 cards/${g}.md`);
  }
});

test('卡片页说清了"管哪些字段"与"能用在哪些节点"', () => {
  for (const f of fs.readdirSync(cardsDir)) {
    const s = fs.readFileSync(path.join(cardsDir, f), 'utf-8');
    assert.ok(s.includes('它管哪些字段'), `${f} 没说管哪些字段`);
    assert.ok(s.includes('能用在哪些节点'), `${f} 没说能用在哪些节点`);
    assert.ok(s.includes('脱钩'), `${f} 没说脱钩语义`);
  }
});

/**
 * 卡片组是注册进来的（nodes/varGroups.ts），文档按注册项生成 ——
 * 新增一组却没重新生成文档时，这里会红。
 */
test('变量页数量与 variableGroups.ts 的注册项一致', () => {
  const src = fs.readFileSync(path.join(SRC, 'nodes', 'variableGroups.ts'), 'utf-8');
  const registered = [...src.matchAll(/group:\s*'([^']+)'/g)].map((m) => m[1]);
  const files = fs.readdirSync(cardsDir).map((f) => f.replace(/\.md$/, ''));
  assert.equal(files.length, registered.length,
    `卡片页 ${files.length} 个，注册项 ${registered.length} 个 —— 改了 variableGroups.ts 要重新生成`);
  for (const g of new Set(registered)) {
    assert.ok(files.includes(g), `注册了 ${g} 但没有文档页`);
  }
});

/* ================= 复用件 ================= */

/**
 * 复用件页面原先**硬编码**了 ModuleDef / CustomPreset 的结构 ——
 * 那是副本：代码一改文档不变，测试也盯不到。
 * 改成从源文件派生后，这里盯着"解析成功"（解析失败会输出占位文案）。
 */
test('复用件页面的结构是从源文件派生的，不是硬编码副本', () => {
  const m = fs.readFileSync(path.join(reuseDir, 'module.md'), 'utf-8');
  const p = fs.readFileSync(path.join(reuseDir, 'custom-preset.md'), 'utf-8');
  const d = fs.readFileSync(path.join(reuseDir, 'defaults.md'), 'utf-8');
  for (const [name, s] of [['module', m], ['custom-preset', p], ['defaults', d]] as const) {
    assert.ok(!s.includes('未能解析'), `${name}.md 的结构没解析出来 —— 派生失败会静默输出占位文案`);
    assert.ok(s.includes('以源文件为准') || s.includes('自动派生'), `${name}.md 没说明是派生的`);
  }
  // ModuleDef 的字段得真解析出来
  assert.ok(m.includes('`edges`'), 'module.md 没解析出 ModuleDef 的字段');
});

test('复用件：模块 / 自定义预设 / 默认值都有说明页', () => {
  for (const n of ['module', 'custom-preset', 'defaults']) {
    assert.ok(fs.existsSync(path.join(reuseDir, `${n}.md`)), `缺 reuse/${n}.md`);
  }
});

/**
 * 模块与自定义预设最容易混淆 —— 它们都是"存一份以后用"。
 * 文档里必须明确对照，否则 AI（和人）会选错。
 */
test('模块与预设都写清了彼此的区别', () => {
  const m = fs.readFileSync(path.join(reuseDir, 'module.md'), 'utf-8');
  const p = fs.readFileSync(path.join(reuseDir, 'custom-preset.md'), 'utf-8');
  assert.ok(m.includes('自定义预设'), 'module.md 没提自定义预设');
  assert.ok(p.includes('模块'), 'custom-preset.md 没提模块');
  // 两者的核心差别：能不能存连线、有没有自己的 type
  assert.ok(m.includes('连线'), 'module.md 没说连线');
  assert.ok(p.includes('连线'), 'custom-preset.md 没说连线（"不能存连线"是关键区别）');
});

test('模块页以接口为主：写清了入口/出口怎么推导', () => {
  const m = fs.readFileSync(path.join(reuseDir, 'module.md'), 'utf-8');
  assert.ok(m.includes('入口') && m.includes('出口'), '没说入口/出口');
  assert.ok(m.includes('没有上游'), '没说入口 = 没有上游的内部节点');
  assert.ok(m.includes('没有下游'), '没说出口 = 没有下游的内部节点');
});

test('预设页说清了存的时候剥掉什么（尤其是运行时与密钥）', () => {
  const p = fs.readFileSync(path.join(reuseDir, 'custom-preset.md'), 'utf-8');
  assert.ok(p.includes('last*'), '没提 last* 前缀的运行时字段');
  assert.ok(p.includes('apiKey') || p.includes('密钥'), '没提密钥剥离');
});

/* ================= 统一索引 ================= */

test('统一索引收录了全部五类', () => {
  const idx = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf-8');
  for (const k of ['节点', '变量', '模块', '自定义预设', '节点默认值']) {
    assert.ok(idx.includes(k), `索引里漏了「${k}」`);
  }
});

test('索引里五类的链接都指向真实存在的文件', () => {
  const idx = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf-8');
  for (const m of idx.matchAll(/\]\(([a-zA-Z0-9._\/-]+\.md)\)/g)) {
    const target = path.join(DOCS, m[1]);
    assert.ok(fs.existsSync(target), `索引里链到了不存在的 ${m[1]}`);
  }
});

/**
 * 所有页面的回链都要能走通 —— 断链会让"分层路由"失去意义。
 */
test('所有页面的链接都不指向空文件', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (f.endsWith('.md')) files.push(f);
    }
  };
  walk(DOCS);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf-8');
    for (const m of s.matchAll(/\]\((\.{0,2}[a-zA-Z0-9._\/-]*\.md)\)/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      assert.ok(fs.existsSync(target), `${path.relative(DOCS, f)} 链到了不存在的 ${m[1]}`);
    }
  }
});

/**
 * 参数表的"取值"列不能出现 undefined。
 *
 * 踩过两次：
 *  1. options 是函数形式（options: () => XXX.map(...)）时取不到值
 *  2. deriveParams 把 options 收敛成 string[] 后，渲染还按
 *     {value,label} 对象取 .value —— 于是显示 "undefined / undefined"
 *
 * 这种"看着有值、实际是 undefined"比留空更误导。
 */
test('参数表的取值列不能出现 undefined', () => {
  for (const f of fs.readdirSync(nodesDir)) {
    const s = fs.readFileSync(path.join(nodesDir, f), 'utf-8');
    assert.ok(!s.includes('undefined'), `${f} 的参数表里有 undefined`);
  }
});

/**
 * fields 用间接引用时也要解析到（canvasRef 写 `fields: canvasRefFields`）。
 *
 * ================= 为什么不再拿 update 当例子 =================
 *
 * 这条原先断言 update.params.md 含 biliUid / feedUrl —— 那是**合并前**
 * 的形状：当时 update 就是 bili / wechat，共用 updateFields。
 *
 * 合并成多目标之后 update 走 Inspector、自己没有 fields，
 * 而 legacy 的 bili / wechat **dataKind 仍是 'update'**，
 * 于是"自动派生"会去读 updateFields.tsx，把 biliUid 那 8 项废弃字段
 * 排在最前、真正的 targets 挤到最后且标成"隐藏"。
 *
 * 那条断言也就从"防漏"变成了"把错的那版钉成标准" ——
 * 这类守卫比没有守卫更糟：它会逼人把好不容易修对的文档改回去。
 * 所以改成盯 canvasRef，并另加一条反方向的守卫（见文末）。
 */
test('fields 用间接引用时也要解析到（canvasRef 是这类）', () => {
  const s = fs.readFileSync(path.join(nodesDir, 'canvasRef.params.md'), 'utf-8');
  for (const k of ['canvasId', 'displayName']) {
    assert.ok(s.includes(`\`${k}\``), `canvasRef.params.md 缺 ${k} —— fields 的间接引用没跟上`);
  }
});

/**
 * 参数页的**键名**要与契约一致（双向）。
 *
 * ================= 这次踩到的 =================
 *
 * 有一版 task.params.md 里写着「隐藏参数 `zzz`」—— 那是故障注入
 * （把 hiddenParams 的 key 改名，验证守卫接得住）之后**重新生成了文档
 * 却没还原**留下的。它 committed 了，而 2246 条测试全绿：
 * 已有的守卫只比对「产出 / 接受 / 能力」三列，不比对键名。
 *
 * 后果是文档告诉 AI「CLI 节点有个叫 zzz 的隐藏参数」。
 * AI 照着写 `zzz` 字段 → 不报错，窗格就是挂不上。
 * 这是文档类漂移最典型的形态：文档还在、看着也像那么回事、
 * 代码不报错，只是拼出来的流程少了一环。
 *
 * ================= 为什么双向 =================
 *
 * 只查「契约里声明的键文档里都有」抓不到 zzz ——
 * zzz 不在契约里，遍历契约自然碰不到它。
 * 所以还要反过来：文档里出现的隐藏参数键，必须都在契约里。
 */
test('参数页的键名与契约一致（双向，防故障注入残留）', () => {
  for (const b of blockCatalog()) {
    const spec = SPECS[b.kind];
    const declared = [...(spec?.params ?? []), ...(spec?.hiddenParams ?? [])]
      .map((p) => p.key);
    const s = fs.readFileSync(path.join(nodesDir, `${b.kind}.params.md`), 'utf-8');

    for (const k of declared) {
      assert.ok(
        s.includes(`\`${k}\``),
        `${b.kind}.params.md 缺契约里声明的 ${k} —— `
        + '改了 nodeSpec 要重跑 scripts/gen-node-docs.mjs',
      );
    }

    /* 反向：文档里的隐藏参数键必须都在契约里 */
    const okKeys = new Set(declared);
    const hidden = [...s.matchAll(/^\|\s*`([^`]+)`\s*\|\s*隐藏（不在面板字段里）/gm)]
      .map((m) => m[1]);
    for (const k of hidden) {
      assert.ok(
        okKeys.has(k),
        `${b.kind}.params.md 里的隐藏参数 \`${k}\` 不在契约里 —— `
        + '这是与代码不一致的旧版本（故障注入后忘了还原时就是这样）',
      );
    }
  }
});

/**
 * 更新检测的参数表不能出现合并前那套顶层字段。
 *
 * 这是"文档派生"踩的坑：update.tsx 自己没有 fields（走 Inspector），
 * 但 legacy 的 bili.ts / wechat.ts 与它**共用 dataKind 'update'**，
 * 而生成器是按 dataKind 收文件的 —— 于是它会去读 updateFields.tsx，
 * 派生出 biliUid / biliMode / biliCookie / feedUrl 这 8 项旧字段，
 * 排在 targets 前面。
 *
 * 后果不是报错，而是**教错**：照文档去填顶层 biliUid / feedUrl，
 * targetsOf() 的兼容路径会合成一张卡，能跑、不报错，
 * 但只能盯一个源 —— 想盯小红书却拿到默认的那种。
 *
 * 所以盯最终产物（生成的 md），而不是盯中间某个函数。
 */
test('update 的参数表只有 targets，没有合并前的顶层字段', () => {
  const s = fs.readFileSync(path.join(nodesDir, 'update.params.md'), 'utf-8');
  const table = s.slice(s.indexOf('| 参数 |'), s.indexOf('## 具名输出'));
  for (const k of ['biliUid', 'biliMode', 'biliCookie', 'source']) {
    assert.ok(
      !table.includes(`\`${k}\``),
      `update.params.md 的参数表里还有 \`${k}\` —— `
      + '那是合并前单目标时代的顶层字段，写出来会误导拼装方往顶层填值',
    );
  }
  assert.ok(table.includes('`targets`'), 'targets 必须在参数表里（它是唯一数据源）');
});

/**
 * 「最不能少的那几行」必须在参数表里。
 *
 * ================= 这些是怎么丢的 =================
 *
 * 生成器切分字段块用的正则只跳过空白、不认注释：
 *   /\{\s*\n?\s*type:/
 *
 * 而字段块恰恰是"越重要越想写注释"的地方 ——
 * genericHttp 的 url/method 块写了"方法与地址同行"，
 * github_update 的 owner/repo 块写了"两个框同一行"。
 * 于是这两块**被静默跳过**，参数表里没有 url、没有 owner/repo。
 *
 * 后果：拼装方照文档拼出来的 HTTP 节点**不知道要填地址**，
 * 拼出来的仓库更新节点不知道要填哪个仓库。不报错，只是少几行 ——
 * 而少的恰好是最不能少的。
 *
 * 所以这里盯的是最终产物（生成的 md），不是中间某个函数。
 */
const ESSENTIAL: Record<string, string[]> = {
  'generic-http': ['url', 'method'],
  'github-update': ['owner', 'repo'],
  update: ['outputFormat', 'timeoutSec', 'userAgent', 'firstRunAsUpdate'],
};

test('每个节点"最不能少"的参数都在参数表里', () => {
  for (const [kind, keys] of Object.entries(ESSENTIAL)) {
    const s = fs.readFileSync(path.join(nodesDir, `${kind}.params.md`), 'utf-8');
    const table = s.slice(s.indexOf('| 参数 |'), s.indexOf('## 具名输出'));
    for (const k of keys) {
      assert.ok(
        table.includes(`\`${k}\``),
        `${kind}.params.md 的参数表缺 \`${k}\` —— `
        + '这类字段块通常带注释，生成器切分时容易整块跳过',
      );
    }
  }
});
