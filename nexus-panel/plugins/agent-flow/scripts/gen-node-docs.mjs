#!/usr/bin/env node
/**
 * 生成「控件索引路由表」—— 三层 Markdown 文档树。
 *
 * ================= 为什么要自动生成 =================
 *
 * 手写文档必然与代码漂移。这个项目已经为此吃过四次亏：
 *   · KV / defaultKV / loadList 抄了 4 份
 *   · SECRET_PATHS / stripSecrets 抄了 2 份
 *   · 卡片圆点色在 defs 与卡片组件里各写一份
 *   · 节点契约把 update 标成 manualParams，与实际有 fields 的事实不符
 *
 * 前三次都是"漏改一处"，第四次直接让 AI 拼装失败。
 * 所以这份文档**只能**从代码派生，且要有测试盯着一致。
 *
 * ================= 结构（像 skill）=================
 *
 *   docs/README.md              统一索引 —— 五类可拖用的东西都在这里
 *   docs/nodes/<kind>.md        节点说明层：分类、产出/接受、能力、坑
 *   docs/nodes/<kind>.params.md 节点参数层：完整参数表 + 用法
 *   docs/cards/<group>.md       参数卡片组：管哪些字段、用在哪些节点
 *   docs/reuse/*.md             复用件：模块 / 自定义预设 / 默认值
 *
 * 分层的理由：不用一次加载全部。AI 在第一层就能做连接判断
 * （产出/接受都在索引里），只有真要用某个控件时才进下一层取参数。
 *
 * ================= 收录的五类 =================
 *
 * 除了节点，还有四样也是"能拖出来用的"，一并收录 —— 用户可以不用，
 * 但不能没有，而且它们不占多少上下文：
 *
 *   参数卡片   一组参数（如某个仓库地址），拖用后脱钩
 *   模块       多个节点编成的组合，改库全体跟着变
 *   自定义预设 一个配好的节点，从侧栏拖出来用
 *   节点默认值 决定新建的同类节点长什么样
 *
 * 其中「模块」与「自定义预设」最容易混淆，文档里专门做了对照。
 *
 * 用法：bash scripts/run-tests.sh && node scripts/gen-node-docs.mjs
 *
 * （要先跑 run-tests.sh —— 它负责把 TS 编译成 JS，本脚本读的是编译产物。
 *   以前读的是 strip-ts.py 生成的 .mjs，那套已废弃。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
/*
 * run-tests.sh 的 tsc 产物目录。CJS 也能被 await import() 正常导入，
 * 所以这里不用改调用方式，只换目录与扩展名。
 */
const OUT = process.env.AF_OUT || '/tmp/afts';
const DOCS = path.join(ROOT, 'docs');
const NODES_DIR = path.join(DOCS, 'nodes');
const CARDS_DIR = path.join(DOCS, 'cards');
const REUSE_DIR = path.join(DOCS, 'reuse');

/*
 * 必须转成 file:// URL 再 import。
 *
 * 直接 import 一个 Windows 绝对路径（'C:\\…\\nodeSpec.js'）会报
 * ERR_UNSUPPORTED_ESM_URL_SCHEME：盘符被当成协议名。
 * 这不是本脚本的写法问题，而是 ESM 只认 URL —— 所以统一过一遍
 * pathToFileURL（Linux 下它是不变的恒等变换，两边都能跑）。
 */
const outFile = (...parts) => pathToFileURL(path.join(OUT, ...parts)).href;

const spec = await import(outFile('engine', 'nodeSpec.js'));
const api = await import(outFile('engine', 'blockApi.js'));
const req = await import(outFile('engine', 'nodeRequires.js'));

/* ================= 分类 meta ================= */
/* 从 nodes/types.ts 正则取 —— 它是 tsx-free 的纯类型文件 */
const typesSrc = fs.readFileSync(path.join(ROOT, 'nodes', 'types.ts'), 'utf-8');
const catBlock = typesSrc.match(/NODE_CATEGORY_META[^=]*=\s*\{([\s\S]*?)\n\};/);
const CAT_META = {};
for (const m of (catBlock?.[1] ?? '').matchAll(/^\s*'?([a-zA-Z]+)'?:\s*\{\s*label:\s*'([^']+)'/gm)) {
  CAT_META[m[1]] = m[2];
}

/* ================= 从 defs 派生参数 ================= */
function parseFields(file) {
  const src = fs.readFileSync(path.join(ROOT, 'nodes', 'defs', file), 'utf-8');
  const m0 = src.match(/const fields[^=]*=\s*\[/);
  const body = m0 ? src.slice(m0.index + m0[0].length) : src;
  const starts = [...body.matchAll(/\{\s*\n?\s*type:\s*'([a-zA-Z]+)'/g)].map((m) => m.index);
  starts.push(body.length);
  const out = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const seg = body.slice(starts[i], starts[i + 1]);
    const t = seg.match(/type:\s*'([a-zA-Z]+)'/)?.[1];
    if (!t) continue;
    if (t === 'note') {
      // note 是面板上写给用户的提示，常含"这个节点做不到什么"这类关键信息
      const c = seg.match(/content:\s*'([^']*)'/) ?? seg.match(/content:\s*"([^"]*)"/);
      if (c) out.push({ type: 'note', key: null, label: null, placeholder: null, hint: c[1], when: null, extraKeys: [], options: [] });
      continue;
    }
    const key = seg.match(/key:\s*'([^']+)'/)?.[1];
    const label = seg.match(/label:\s*'([^']+)'/)?.[1];
    const ph = seg.match(/placeholder:\s*'([^']*)'/)?.[1];
    const hint = seg.match(/hint:\s*'([^']*)'/)?.[1];
    const when = seg.match(/when:\s*\(([^)]*)\)\s*=>\s*([^,\n]+)/);
    const specKeys = seg.match(/spec:\s*\{\s*keys:\s*\[([^\]]+)\]/);
    /*
     * options 有两种写法：
     *   1. 字面量数组  value:'a', label:'甲'        → 能取到值
     *   2. 函数        options: () => XXX.map(...)  → 取不到具体值
     *
     * 只处理第 1 种会让第 2 种显示成 "undefined / undefined"，
     * 那比留空更糟（看着像有值，实际是 Bug）。所以第 2 种标出常量名，
     * 读者知道去哪查。
     */
    let opts = [...seg.matchAll(/value:\s*'([^']+)',\s*\n?\s*label:\s*'([^']+)'/g)]
      .map((m) => ({ value: m[1], label: m[2], hint: '' }));
    if (opts.length === 0) {
      const dyn = seg.match(/options:\s*\(\)\s*=>\s*([A-Za-z_$][\w$.]*)/);
      if (dyn) opts = [{ value: `动态（${dyn[1]}）`, label: '', hint: '' }];
    }
    out.push({
      type: t,
      key: key ?? null,
      label: label ?? null,
      placeholder: ph ?? null,
      hint: hint ?? null,
      when: when ? `${when[1]} → ${when[2].trim()}` : null,
      extraKeys: specKeys ? [...specKeys[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [],
      options: opts,
    });
  }
  return out;
}

/** defs 文件名 → dataKind */
const defFiles = fs.readdirSync(path.join(ROOT, 'nodes', 'defs'));
const defOf = {};
for (const f of defFiles) {
  const src = fs.readFileSync(path.join(ROOT, 'nodes', 'defs', f), 'utf-8');
  const dkm = src.match(/dataKind:\s*'([^']+)'/);
  if (!dkm) continue;
  const kind = dkm[1];
  const ty = src.match(/type:\s*'([^']+)',\s*\n\s*dataKind/);
  const cat = src.match(/category:\s*'([^']+)'/);
  const sub = src.match(/sub:\s*'([^']+)'/);
  // 同一 dataKind 可能有多个 type（bili / wechat 共用一份 data），都记下来
  (defOf[kind] ??= []).push({
    file: f,
    type: ty?.[1] ?? kind,
    category: cat?.[1] ?? 'custom',
    sub: sub?.[1] ?? null,
  });
}

/*
 * ================= 参数卡片组 =================
 *
 * 收录理由：卡片也是"能拖出来用的" —— 拖到节点上就套用一组参数。
 * 用户可以把当前值存成卡片，之后从面板或卡片库里选。
 *
 * 数据来自 nodes/cardGroups.ts 的 registerCardGroup(...)，
 * 加上各 defs 里 meta.cardGroups 的反向关联（哪些节点能用这组）。
 */
/*
 * 从 .ts 源文件提取类型定义的顶层字段。
 *
 * 复用件页面原先**硬编码**了 ModuleDef / CustomPreset 的结构 ——
 * 那是副本，代码一改文档不变，测试也盯不到，等于我自己犯了那个
 * "同一件事两处写"的老毛病。改成从源文件派生。
 */
function typeFieldsOf(file, typeName) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  const i = src.indexOf(`export type ${typeName} = {`);
  if (i < 0) return null;
  const end = src.indexOf('\n};', i);
  if (end < 0) return null;
  const body = src.slice(i, end);
  const rows = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) continue;
    const m = t.match(/^(\w+)(\??):\s*(.+?);?$/);
    if (!m) continue;
    let comment = '';
    const ci = line.indexOf('//');
    if (ci > 0) comment = line.slice(ci + 2).trim();
    rows.push({ name: m[1], optional: m[2] === '?', type: m[3].replace(/;$/, ''), comment });
  }
  return rows;
}

/** 从 .ts 提取一个导出常量的值（字符串字面量） */
function constValueOf(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  /*
   * 两个坑，都踩过：
   *
   * 1. **模板字符串里不能写 \s** —— 反斜杠被当转义符吃掉，
   *    `\s` 变成 `s`，正则静默失配（不报错，只是匹配不到）。
   *    所以这里用普通字符串拼接 + 双反斜杠。
   * 2. 只有一个等号时，先试的那条（要求两个 `=`）必然落空，
   *    要有兜底。
   */
  const r1 = new RegExp('export const ' + name + '\\s*[:=][^=]*?=\\s*\'([^\']+)\'');
  const r2 = new RegExp('export const ' + name + '\\s*=\\s*\'([^\']+)\'');
  const m = src.match(r1) ?? src.match(r2);
  return m ? m[m.length - 1] : null;
}

function collectCardGroups() {
  const src = fs.readFileSync(path.join(ROOT, 'nodes', 'cardGroups.ts'), 'utf-8');
  const groups = [];

  // 逐个 `const X_GROUP: CardGroupDef = { ... };`
  const blocks = src.split(/const\s+\w+_GROUP\s*:\s*CardGroupDef\s*=\s*\{/).slice(1);
  for (const b of blocks) {
    const g = {
      group: (b.match(/group:\s*'([^']+)'/) ?? [])[1],
      label: (b.match(/label:\s*'([^']+)'/) ?? [])[1],
      name: (b.match(/name:\s*'([^']+)'/) ?? [])[1],
      keys: [...(b.match(/keys:\s*\[([^\]]+)\]/) ?? ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
    };
    if (!g.group) continue;

    // 注释里的说明：取块之前紧邻的 /** ... */（更贴近人写的意图）
    const idx = src.indexOf(b.slice(0, 60));
    const before = src.slice(Math.max(0, idx - 700), idx);
    const cm = [...before.matchAll(/\/\*\*([\s\S]*?)\*\//g)].pop();
    g.desc = cm
      ? cm[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean).join(' ')
      : '';

    /*
     * validate 的失败文案 = "什么情况下这张卡片不能用"。
     *
     * 匹配到块结尾（下一个顶层字段或块结束）为止，而不是找分号 ——
     * 箭头函数体常以逗号结尾（\`validate: (v) => (... ? null : '...'),\`），
     * 按分号找会什么都匹配不到。
     */
    const vIdx = b.indexOf('validate:');
    if (vIdx >= 0) {
      let cut = b.indexOf('\n  };', vIdx);
      if (cut < 0) cut = b.indexOf('\n};', vIdx);
      if (cut < 0) cut = b.length;
      g.invalid = b.slice(vIdx, cut).replace(/\s+/g, ' ').trim();
    } else {
      g.invalid = null;
    }

    // 反向关联：哪些节点声明支持这组
    g.usedBy = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'nodes', 'defs'))) {
      const ds = fs.readFileSync(path.join(ROOT, 'nodes', 'defs', f), 'utf-8');
      const cg = ds.match(/cardGroups:\s*\[([^\]]+)\]/);
      if (!cg) continue;
      const list = [...cg[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      if (!list.includes(g.group)) continue;
      const dk = ds.match(/dataKind:\s*'([^']+)'/)?.[1];
      const lab = ds.match(/label:\s*'([^']+)',\s*\n\s*color/)?.[1];
      if (dk) g.usedBy.push({ kind: dk, label: lab ?? dk });
    }
    groups.push(g);
  }
  return groups;
}

/* ================= 复用件（模块 / 预设 / 默认值）================= */
/*
 * 这三样都是**用户运行时创建**的，没有内置清单 ——
 * 所以文档不列具体条目（列了立刻过期），只说明：
 * 结构长什么样、怎么用、以及它们之间容易混淆的区别。
 */
const MOD_FILE = 'engine/modules.ts';
const CP_FILE = 'engine/customPresets.ts';
const ND_FILE = 'engine/nodeDefaults.ts';

function writeReuse() {
  fs.mkdirSync(REUSE_DIR, { recursive: true });

  fs.writeFileSync(path.join(REUSE_DIR, 'module.md'), `# 模块 — 多个节点编成的一组

> 自动生成，不要手改。源文件：\`engine/modules.ts\`

[← 回到索引](../README.md)

## 它是什么

把画布上多个节点编成一个可复用的模块，之后从侧栏「自定义」分组
直接拖出来用。模块**有自己的节点类型** \`module\`。

## 结构

定义见 \`${MOD_FILE}\` 的 \`ModuleDef\`（**以源文件为准**，下面是自动派生的字段清单）：

${(typeFieldsOf(MOD_FILE, 'ModuleDef') ?? []).map((r) => `- \`${r.name}\`: \`${r.type}\`${r.comment ? ` — ${r.comment}` : ''}`).join('\n') || '（未能解析，请直接读源文件）'}

## 接口：入口与出口（自动推导，不用手工标）

**入口** = 模块内没有上游的内部节点
**出口** = 模块内没有下游的内部节点

由内部结构推导，加删节点时接口自动跟着变 ——
不会出现"手工标了入口但那个节点已经删了"这种对不上的情况。

连线时：外部边接到入口；多入口时连到每个入口；
模块接模块是笛卡尔积。

## 改了会怎样（这是最容易搞混的地方）

| 改哪里 | 结果 |
|---|---|
| 改模块库里的定义 | **所有实例跟着变** |
| 改某个实例内部的节点 | 该实例**脱钩**成独立副本，不再跟随 |

「库是库、实例是实例」 —— 与参数卡片、自定义预设是同一套语义。

## 执行时

展开成内部节点参与拓扑，日志能看到内部每一步、出错能定位到具体节点。
内部节点 id 加实例前缀（\`inst__A\`），内部模板 \`{{A.output}}\`
会自动改写成 \`{{inst__A.output}}\`。

## 注意

- 模块编辑是**借用主画布**做的：进入时把模块内容载入画布，改完存回。
  编辑期间不要切换画布标签 —— 切换会把模块内容当成另一个画布存走。
- 折叠只是隐藏，**节点照常执行**。
`);

  fs.writeFileSync(path.join(REUSE_DIR, 'custom-preset.md'), `# 自定义节点预设 — 一个配好的节点

> 自动生成，不要手改。源文件：\`engine/customPresets.ts\`

[← 回到索引](../README.md)

## 它是什么

把「某个已存在的节点配好一份参数」存成侧栏可复用的条目。
它与基础类型**共用 node.type**，所以执行器、卡片、属性面板全部自动继承。

## 结构

定义见 \`${CP_FILE}\` 的 \`CustomPreset\`（**以源文件为准**，下面是自动派生的字段清单）：

${(typeFieldsOf(CP_FILE, 'CustomPreset') ?? []).map((r) => `- \`${r.name}\`: \`${r.type}\`${r.comment ? ` — ${r.comment}` : ''}`).join('\n') || '（未能解析，请直接读源文件）'}

## 与模块的区别（最容易混淆）

| | 自定义预设 | 模块 |
|---|---|---|
| 装的是什么 | **一个**节点 + 一套参数 | **多个**节点 + 它们之间的连线 |
| node.type | 复用基础类型的 type | 有自己的 \`module\` 类型 |
| 能存连线 | 不能 | 能 |

简单说：预设是"配好的一个积木"，模块是"编好的一组积木"。

## 存的时候会剥掉什么

- 运行时字段：\`status\` / \`output\` / \`error\` / 所有 \`last*\` 前缀
- 显示与布局：\`size\` / \`stackParent\` / \`stackCollapsed\`
- 内联密钥：\`token\` / \`llm.apiKey\` / \`config.token\`

**剥运行时的理由**：不剥的话，把跑过的 HTTP 节点存成预设，
之后每次拖出来的新节点都带着上一次的 \`status='success'\` 和旧 output ——
看起来"已经跑完了"，实际一次都没跑。

**剥密钥的理由**：预设明文存 localStorage，不能当密钥仓库用。
凭据引用（\`credentialId\`）会保留，它只是个 id。

## 导入时会校验

基础节点在本机不存在就跳过，并带回原因（"本机没有「xxx」这种节点"）——
硬塞进去侧栏会出现一个点了没反应的条目，那比不显示更糟。
同 id 视为同一条走更新，重复导入不会堆副本。
`);

  fs.writeFileSync(path.join(REUSE_DIR, 'defaults.md'), `# 节点默认值 — 新建节点长什么样

> 自动生成，不要手改。源文件：\`engine/nodeDefaults.ts\`

[← 回到索引](../README.md)

## 它是什么

属性面板的「设为默认」把当前节点的参数存成这类节点的默认值，
之后**新建**的同类节点都用这套值。已有节点不受影响。

严格说它不是"能拖出来的积木"，但它决定新建节点长什么样，
所以一并收录。

## 按 preset.key 存，不按 node.type

这一点很关键：任务节点有两个变体（WorkBuddy / TraeCode），
侧栏是两条独立预设，靠 \`preset.init()\` 写入不同的 \`cli\`。

若按 type 存一份默认，给 WorkBuddy 变体设的默认会**连带把
TraeCode 变体的 cli 也改掉** —— 而用户根本没碰过那个变体。

存的时候反查节点属于哪条预设（type 相同 + \`init()\` 写进去的字段
都与当前 data 一致）。改过那些字段的节点不属于任何预设，回落到 \`node.type\`。

## 叠加顺序

\`create() → init() → defaults()\`

默认放**最后**盖。反过来会被出厂值盖掉。

## 存之前剥三类字段

1. **运行时**（status / output / error / last*）—— 不剥的话新建节点
   带着 \`status='success'\` 和旧输出，看起来"已经跑完了"
2. **显示与布局**（size / stackParent / stackCollapsed）
   —— 尤其 \`stackParent\`：不剥的话每个新建节点都"嵌合"到一个
   不存在的父节点上，引擎把它转成边，**新节点莫名跑不起来**
3. **内联密钥**（token / llm.apiKey / config.token）——
   默认值明文存 localStorage，不能当密钥仓库用

## 存储键

\`${constValueOf(ND_FILE, 'NODE_DEFAULTS_KEY') ?? '（未能解析，见源文件）'}\`

（自动派生自 \`${ND_FILE}\` 的 \`NODE_DEFAULTS_KEY\`，避免手抄后漂移）
`);
}

/* ================= 生成卡片页 ================= */
function writeCards(groups) {
  fs.mkdirSync(CARDS_DIR, { recursive: true });
  for (const g of groups) {
    let s = `# ${g.label}（${g.group}）

> 自动生成，不要手改。源文件：\`nodes/cardGroups.ts\`

[← 回到索引](../README.md)

## 它管哪些字段

${g.keys.map((k) => `- \`${k}\``).join('\n')}

改其中任一字段 → 节点脱钩成「自定义」。

## 说明

${g.desc || '（无额外说明）'}

## 能用在哪些节点

${g.usedBy.length ? g.usedBy.map((u) => `- [\`${u.kind}\`](../nodes/${u.kind}.params.md)${u.label !== u.kind ? ` — ${u.label}` : ''}`).join('\n') : '（当前没有节点声明支持这组）'}

拖到节点上时会校验：节点必须**声明支持**这个组，否则拒绝并说明原因。
`;

    if (g.invalid) {
      s += `
## 什么情况下这张卡片不能用

校验规则：\`${g.invalid}\`

返回非空即拒绝 —— 这是为了挡住"看着能拖、套上去是空的"这类错配。
`;
    }

    s += `
## 语义

卡片是**模板库**，节点上的是**实例**：

- 点卡片 → 深拷贝一份值进节点
- 之后改节点上的字段 → 该组自动脱钩成「自定义」，卡片本身不变
- 删掉正在用的卡片 → 节点降级为「自定义」，值保留
`;
    fs.writeFileSync(path.join(CARDS_DIR, `${g.group}.md`), s);
  }
}

/* ================= 组装 ================= */
const cards = collectCardGroups();

const blocks = spec.blockCatalog();
const byKind = new Map(blocks.map((b) => [b.kind, b]));

/** 参数：优先派生自 fields；manualParams 的用契约定好的 params */
/**
 * 按 key 聚合所有字段块。
 *
 * 为什么要聚合而不是"见到就记"：custom 块只有 spec.keys、没有 label，
 * 而同一个 key 往往在后面的块里才有真正的 label / hint / placeholder
 * （例：translate 的 sourceLang 在 custom 块里只出现一次，
 *  但另有一个 text 块写着 label「源语言」、hint「留空自动识别」）。
 *
 * 先到先得会让这些说明全部丢失，参数表变成一列光秃秃的 key。
 */
function paramsOf(kind, b) {
  const rows = [];
  const seen = new Set();
  const defs = defOf[kind] ?? [];
  if (!spec.SPECS[kind]?.manualParams) {
    /*
     * 聚合逻辑**不在这里写** —— 调 engine/blockApi 的 deriveParams。
     *
     * 让文档与运行时 API 共用同一份逻辑，"文档里的参数表"和
     * "运行时查到的参数表"才不可能对不上。各写一份必然漂移，
     * 这是这个项目已经踩过四次的坑。
     */
    /*
     * fields 常常**不在主 def 文件里**：
     * bili.ts / wechat.ts 写的是 `fields: () => updateFields`，
     * 真正的清单在同目录的 updateFields.tsx。
     *
     * 只看主文件会让参数表只剩 `source` 一项（那是从契约的 hiddenParams
     * 补的），真正的 biliUid / feedUrl 全丢 —— AI 拼出来会缺参数，
     * 报 "Cannot read properties of undefined (reading 'trim')"。
     */
    const fieldFiles = new Set();
    for (const d of defs) {
      fieldFiles.add(d.file);
      const src = fs.readFileSync(path.join(ROOT, 'nodes', 'defs', d.file), 'utf-8');
      for (const m of src.matchAll(/fields:\s*(?:\(\)\s*=>\s*)?([A-Za-z_$][\w$]*)/g)) {
        const name = m[1];
        for (const f of defFiles) {
          const fs2 = fs.readFileSync(path.join(ROOT, 'nodes', 'defs', f), 'utf-8');
          if (fs2.includes(`export const ${name}`)) fieldFiles.add(f);
        }
      }
    }
    const flat = [];
    for (const ff of fieldFiles) for (const f of parseFields(ff)) flat.push(f);
    const derived = api.deriveParams(flat);
    for (const r of derived.rows) {
      seen.add(r.key);
      rows.push(r);
    }
    rows.notes = derived.notes;
  }
  // 契约里手写的（manualParams 或 hiddenParams）
  for (const p of spec.SPECS[kind]?.params ?? []) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    rows.push({ key: p.key, type: '—', label: null, placeholder: null, hint: p.desc, when: null, options: (p.options ?? []).map((v) => ({ value: v, label: v, hint: '' })), required: p.required });
  }
  for (const p of b.hiddenParams) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    rows.push({
      key: p.key, type: '隐藏（不在面板字段里）', label: null, placeholder: null,
      hint: p.desc, when: null,
      options: (p.options ?? []).map((v) => ({ value: v, label: v, hint: '' })),
    });
  }
  return rows;
}

const PORT_CN = {
  text: '文本', json: 'JSON', bool: '是/否', files: '文件列表',
  mark: '状态标记', any: '透传上游', none: '无输出',
};
const port = (p) => `${p}（${PORT_CN[p] ?? p}）`;
const acc = (a) => (Array.isArray(a) ? a.join(' / ') : a);

/* ================= 第一层：分类索引 ================= */
const order = Object.keys(CAT_META);
const byCat = new Map();
for (const b of blocks) {
  const d = (defOf[b.kind] ?? [])[0];
  const cat = d?.category ?? 'custom';
  (byCat.get(cat) ?? byCat.set(cat, []).get(cat)).push(b);
}

let idx = `# 可拖用的东西 — 统一索引

> 自动生成，**不要手改**。改代码后跑：
> \`bash scripts/build-tests.sh && node scripts/gen-node-docs.mjs\`

这是**第一层**。收录五类能拖出来用的东西：

| 类别 | 装的是什么 | 入口 |
|---|---|---|
| **节点** | 一个积木（${blocks.length} 种） | 下面按分类的表 |
| **参数卡片** | 一组参数（如某个仓库地址） | [卡片](#参数卡片)（${cards.length} 组） |
| **模块** | 多个节点编成的组合 | [module](reuse/module.md) |
| **自定义预设** | 一个配好的节点 | [custom-preset](reuse/custom-preset.md) |
| **节点默认值** | 决定新建节点长什么样 | [defaults](reuse/defaults.md) |

后三样是**用户运行时创建**的，没有内置清单，
所以这里只给「怎么用」的说明，不列具体条目（列了立刻过期）。

`;

idx += `## 连线判据（先看这个）

- \`产出\` 是它交给下游的东西，\`接受\` 是它能吃下的东西
- 判据是**语义上能不能用**，不是物理上能不能连 —— 不合时只会告警，不阻止
- \`mark\` 型（状态标记）插在链中间会**截断**数据，是最容易踩的坑
- 需要外部能力的控件，在浏览器模式下会直接失败（\`能力\` 列有标注）

`;

for (const cat of order) {
  const list = byCat.get(cat);
  if (!list?.length) continue;
  idx += `## ${CAT_META[cat]}\n\n`;
  /*
   * 带「源文件」列是这套文档的立意所在 ——
   * 索引是**路由表**，不是内容副本。要细节就去读源文件，
   * 那里永远最新；这里只放"决定要不要进去"的判据。
   */
  idx += `| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |\n|---|---|---|---|---|---|\n`;
  for (const b of list) {
    const d = (defOf[b.kind] ?? [])[0];
    const sub = d?.sub ?? b.producesDesc;
    const req = b.requires.length ? b.requires.join(', ') : '—';
    const src = d?.file ? `nodes/defs/${d.file}` : '—';
    idx += `| [${b.kind}](nodes/${b.kind}.params.md) | ${port(b.produces)} | ${acc(b.accepts)} | ${req} | ${sub ?? ''} | \`${src}\` |\n`;
  }
  idx += '\n';
}

idx += `## 参数卡片

一组参数存成卡片，拖到节点上就套用。改了节点会**脱钩**成「自定义」。

| 卡片组 | 管哪些字段 | 能用在 |
|---|---|---|
${cards.map((g) => `| [${g.label}](cards/${g.group}.md) | ${g.keys.map((k) => `\`${k}\``).join(', ')} | ${g.usedBy.map((u) => `\`${u.kind}\``).join(', ') || '—'} |`).join('\n')}

拖到节点上会校验三件事：组已注册、节点声明支持这个组、值通过 validate。

## 复用件

| 名字 | 装的是什么 | 与另一个的区别 |
|---|---|---|
| [module](reuse/module.md) | **多个**节点 + 连线 | 与预设的区别：模块能存连线、有自己的 \`module\` 类型 |
| [custom-preset](reuse/custom-preset.md) | **一个**节点 + 一套参数 | 与模块的区别：预设复用基础类型的 type，不能存连线 |
| [defaults](reuse/defaults.md) | 新建节点的默认参数 | 不是能拖的积木，但它决定新建节点长什么样 |

模块与预设都遵循「**库是库、实例是实例**」：改库 → 所有实例跟着变；
改实例 → 该实例脱钩。

`;

idx += `## 模板变量

| 写法 | 含义 |
|---|---|
${spec.TEMPLATE_VARS.map((v) => `| \`${v.syntax}\` | ${v.desc}${v.warn ? ` **⚠ ${v.warn}**` : ''} |`).join('\n')}

## 边的写法

| 字段 | 含义 |
|---|---|
${spec.EDGE_SHAPE.map((e) => `| \`${e.field}\` | ${e.desc} |`).join('\n')}

分支边示例：\`${spec.BRANCH_EDGE_EXAMPLE}\`

## 能力签名

调用这些能力时要按下面的签名来（写错不报错，只表现为奇怪的失败）：

| 能力 | 签名 |
|---|---|
${Object.entries(spec.CAPABILITY_SIGNATURES).map(([k, v]) => `| \`${k}\` | \`${v}\` |`).join('\n')}
`;

/* ================= 第二、三层：每个控件 ================= */
fs.mkdirSync(NODES_DIR, { recursive: true });
fs.mkdirSync(CARDS_DIR, { recursive: true });
fs.mkdirSync(REUSE_DIR, { recursive: true });
let n = 0;
for (const b of blocks) {
  const d = (defOf[b.kind] ?? [])[0];
  const types = (defOf[b.kind] ?? []).map((x) => x.type);
  const cat = d?.category ?? 'custom';
  const srcFile = d?.file ? `nodes/defs/${d.file}` : '（无）';

  /* ---- 第三层：参数详情 ---- */
  /*
   * 说明页被压掉之后（见文件头的"为什么只有两层"），
   * 它那点独有内容搬到参数页头部：分类、node.type、产出/接受、能力、
   * 以及从产出类型推导出的坑。
   */
  const warn = [];
  if (b.produces === 'mark') {
    warn.push('产出是**状态标记**，插在链中间会截断上游数据。下游若要处理上游内容，改用 `{{上游id.output}}` 直接取。');
  }
  if (b.accepts === 'none') {
    warn.push('它**不需要输入**（`接受 = none`），通常作为链的起点。');
  }
  if (Array.isArray(b.accepts) && !b.accepts.includes('any')) {
    warn.push(`它只接受 ${b.accepts.join(' / ')}，其余类型接上去会被告警。`);
  }

  let p = `# ${b.kind} — 参数与使用方式

> 自动生成，**不要手改**。这是 \`${srcFile}\` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：${CAT_META[cat] ?? cat}
- **node.type**：${types.map((t) => `\`${t}\``).join(' / ')}${types.length > 1 ? '（多个 type 共用一份 data）' : ''}
- **源文件**：\`${srcFile}\`
- **产出**：${port(b.produces)}　**接受**：${acc(b.accepts)}
- **需要的外部能力**：${b.requires.length ? b.requires.map((r) => `\`${r}\``).join(', ') : '无（纯本地，浏览器模式也能跑）'}

## 它做什么

${b.producesDesc ?? '（无说明）'}
`;

  if (b.requires.length) {
    p += `\n## 能力签名\n\n${b.requires.map((r) => `- \`${r}\`: \`${spec.CAPABILITY_SIGNATURES[r] ?? '（缺签名说明）'}\``).join('\n')}\n`;
    for (const [k2, list] of Object.entries(req.REQUIRES ?? {})) {
      if (k2 !== b.kind) continue;
      for (const r of list) {
        if (!r.when) continue;
        p += `\n> \`${r.key}\` 是**按需**的：只有满足特定条件时才需要（见参数页）。\n`;
      }
    }
  }
  if (warn.length) p += `\n## 注意\n\n${warn.map((w) => `- ${w}`).join('\n')}\n`;
  p += '\n';
  const params = paramsOf(b.kind, b);
  if (params.notes?.length) {
    p += `## 面板上的提示\n\n${params.notes.map((x) => `> ${x}`).join('\n>\n> ')}\n\n`;
  }
  if (!params.length) {
    p += '这个控件没有可调参数（结构由画布上的连线决定）。\n';
  } else {
    p += `共 ${params.length} 项：\n\n`;
    p += `| 参数 | 类型 | 说明 | 取值 | 显示条件 |\n|---|---|---|---|---|\n`;
    for (const r of params) {
      /*
       * deriveParams 返回的 options 是 string[]（不是 {value,label} 对象）——
       * 按对象取 .value 会全变成 undefined，看起来像"有值但值是 undefined"，
       * 比留空更容易误导。
       */
      const opts = r.options?.length
        ? r.options.map((o) => `\`${typeof o === 'string' ? o : o.value}\``).join(' / ')
        : '—';
      const hint = [r.label, r.hint, r.placeholder ? `占位：${r.placeholder}` : null]
        .filter(Boolean).join('；') || '—';
      p += `| \`${r.key}\`${r.required ? ' **必填**' : ''} | ${r.type} | ${hint} | ${opts} | ${r.when ? `\`${r.when}\`` : '—'} |\n`;
    }
  }

  p += `\n## 建节点的正确方式

用 \`def.create()\`（即 \`makeXxxNode\`）建节点，它会填好默认值。
手工拼 \`{ kind: '${b.kind}' }\` 会缺默认字段 ——
${b.hiddenParams.length ? `本控件尤其要注意 ${b.hiddenParams.map((h) => `\`${h.key}\``).join(' / ')}，它不在面板字段里。` : '本控件没有隐藏字段，但用 create() 仍是推荐做法。'}
`;
  fs.writeFileSync(path.join(NODES_DIR, `${b.kind}.params.md`), p);
  n++;
}

writeCards(cards);
writeReuse();

fs.writeFileSync(path.join(DOCS, 'README.md'), idx);
console.log(`✅ 已生成 docs/：索引 + ${n} 个参数页 + ${cards.length} 个卡片组 + 3 个复用件说明`);
