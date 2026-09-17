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
 * ================= 三层结构（像 skill）=================
 *
 *   docs/README.md              分类索引 —— 只给分类与控件名，外加
 *                               "产出/接受"（决定能不能接的关键判据）
 *   docs/nodes/<kind>.md        控件层 —— 说明、能力、何时用、坑
 *   docs/nodes/<kind>.params.md 参数层 —— 完整参数表、用法示例
 *
 * 分三跳的理由：不用一次加载全部。AI 在第一层就能做连接判断
 * （产出/接受都在索引里），只有真要用某个控件时才进第三层取参数。
 *
 * 用法：bash scripts/build-tests.sh && node scripts/gen-node-docs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = '/tmp/aftest';          // build-tests.sh 的产物目录
const DOCS = path.join(ROOT, 'docs');

const spec = await import(path.join(OUT, 'nodeSpec.mjs'));
const req = await import(path.join(OUT, 'nodeRequires.mjs'));

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
    const opts = [...seg.matchAll(/value:\s*'([^']+)',\s*\n?\s*label:\s*'([^']+)'/g)]
      .map((m) => ({ value: m[1], label: m[2], hint: '' }));
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

/* ================= 组装 ================= */
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
    /* 第一遍：把所有块摊平 */
    const flat = [];
    for (const d of defs) for (const f of parseFields(d.file)) flat.push(f);

    /* 第二遍：按 key 聚合，后出现的块补充前块缺失的说明 */
    const notes = flat.filter((f) => f.type === 'note').map((f) => f.hint);
    const agg = new Map();
    for (const f of flat) {
      if (f.type === 'note') continue;
      for (const k of [f.key, ...f.extraKeys].filter(Boolean)) {
        const cur = agg.get(k) ?? {
          key: k, type: f.type, label: null, placeholder: null,
          hint: null, when: null, options: [],
        };
        // 优先用非 custom 的块：custom 是手写面板的逃生口，说不出字段语义
        if (cur.type === 'custom' && f.type !== 'custom') cur.type = f.type;
        cur.label ??= f.label;
        cur.placeholder ??= f.placeholder;
        cur.hint ??= f.hint;
        cur.when ??= f.when;
        if (f.options?.length && !cur.options.length) cur.options = f.options;
        agg.set(k, cur);
      }
    }
    for (const r of agg.values()) {
      seen.add(r.key);
      // custom 是"手写面板"逃生口，说不出字段语义，给个兜底说明
      if (r.type === 'custom' && !r.hint && !r.label) {
        r.hint = '由手写面板渲染（通常带上游变量插入按钮）';
      }
      rows.push(r);
    }
    if (notes.length) rows.notes = notes;
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

let idx = `# 控件索引

> 自动生成，**不要手改**。改代码后跑：
> \`bash scripts/build-tests.sh && node scripts/gen-node-docs.mjs\`

这是**第一层**：只有分类与控件清单，外加「产出 / 接受」
——这两项是决定两个控件能不能接的判据，所以放在索引里，
不用进到第三层才知道。

要看某个控件的说明 → 点进 \`nodes/<kind>.md\`
要拿它的参数 → 再进 \`nodes/<kind>.params.md\`

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
  idx += `| 控件 | kind | 产出 | 接受 | 能力 | 说明 |\n|---|---|---|---|---|---|\n`;
  for (const b of list) {
    const d = (defOf[b.kind] ?? [])[0];
    const sub = d?.sub ?? b.producesDesc;
    const req = b.requires.length ? b.requires.join(', ') : '—';
    idx += `| [${b.kind}](nodes/${b.kind}.md) | \`${b.kind}\` | ${port(b.produces)} | ${acc(b.accepts)} | ${req} | ${sub ?? ''} |\n`;
  }
  idx += '\n';
}

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
fs.mkdirSync(path.join(DOCS, 'nodes'), { recursive: true });
let n = 0;
for (const b of blocks) {
  const d = (defOf[b.kind] ?? [])[0];
  const types = (defOf[b.kind] ?? []).map((x) => x.type);
  const cat = d?.category ?? 'custom';

  /* ---- 第二层：控件说明 ---- */
  let s = `# ${b.kind}${d?.sub ? ` — ${d.sub}` : ''}

> 自动生成，不要手改。源文件：\`nodes/defs/${d?.file ?? '（无）'}\`

- **分类**：${CAT_META[cat] ?? cat}
- **node.type**：${types.map((t) => `\`${t}\``).join(' / ')}${types.length > 1 ? '（多个 type 共用一份 data）' : ''}
- **产出**：${port(b.produces)}
- **接受**：${acc(b.accepts)}
- **需要的外部能力**：${b.requires.length ? b.requires.map((r) => `\`${r}\``).join(', ') : '无（纯本地，浏览器模式也能跑）'}

## 它做什么

${b.producesDesc ?? '（无说明）'}
`;

  if (b.requires.length) {
    s += `\n## 能力签名\n\n${b.requires.map((r) => `- \`${r}\`: \`${spec.CAPABILITY_SIGNATURES[r] ?? '（缺签名说明）'}\``).join('\n')}\n`;
    /*
     * 有条件的能力（when）要标出来 ——
     * 例：OCR 只在"本地文件"来源时才要 imageReader，网络地址走 URL 直传。
     * 不标的话 AI 会以为任何用法都需要它，从而在浏览器模式下误判不可行。
     */
    for (const [kind, list] of Object.entries(req.REQUIRES ?? {})) {
      if (kind !== b.kind) continue;
      for (const r of list) {
        if (!r.when) continue;
        s += `\n> \`${r.key}\` 是**按需**的：只有在满足特定条件时才需要（见参数页）。\n`;
      }
    }
  }

  const warn = [];
  if (b.produces === 'mark') {
    warn.push('产出是**状态标记**，插在链中间会截断上游数据。下游若要处理上游内容，改用 `{{上游id.output}}` 直接取。');
  }
  if (b.accepts === 'none') {
    warn.push('它**不需要输入**（`接受 = none`），通常作为链的起点。');
  }
  if (Array.isArray(b.accepts) && !b.accepts.includes('any')) {
    warn.push(`它只接受 ${b.accepts.join(' / ')} 类型的数据，其余类型接上去会被告警。`);
  }
  if (warn.length) s += `\n## 注意\n\n${warn.map((w) => `- ${w}`).join('\n')}\n`;

  const params = paramsOf(b.kind, b);
  s += `\n## 参数概览\n\n共 ${params.length} 项。完整表格与用法见 → [${b.kind}.params.md](${b.kind}.params.md)\n`;
  if (params.length) {
    s += `\n${params.slice(0, 8).map((p) => `- \`${p.key}\`${p.label ? `（${p.label}）` : ''}`).join('\n')}`;
    if (params.length > 8) s += `\n- …… 另 ${params.length - 8} 项`;
    s += '\n';
  }

  s += `\n---\n\n[← 回到索引](../README.md)\n`;
  fs.writeFileSync(path.join(DOCS, 'nodes', `${b.kind}.md`), s);

  /* ---- 第三层：参数详情 ---- */
  let p = `# ${b.kind} — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](${b.kind}.md) ｜ [← 回到索引](../README.md)

`;
  if (params.notes?.length) {
    p += `## 面板上的提示\n\n${params.notes.map((x) => `> ${x}`).join('\n>\n> ')}\n\n`;
  }
  if (!params.length) {
    p += '这个控件没有可调参数（结构由画布上的连线决定）。\n';
  } else {
    p += `共 ${params.length} 项：\n\n`;
    p += `| 参数 | 类型 | 说明 | 取值 | 显示条件 |\n|---|---|---|---|---|\n`;
    for (const r of params) {
      const opts = r.options?.length ? r.options.map((o) => `\`${o.value}\``).join(' / ') : '—';
      const hint = [r.label, r.hint, r.placeholder ? `占位：${r.placeholder}` : null]
        .filter(Boolean).join('；') || '—';
      p += `| \`${r.key}\`${r.required ? ' **必填**' : ''} | ${r.type} | ${hint} | ${opts} | ${r.when ? `\`${r.when}\`` : '—'} |\n`;
    }
  }

  p += `\n## 怎么用它

1. 从侧栏「${CAT_META[cat] ?? cat}」分组拖到画布
2. 在属性面板填参数（面板由 \`nodes/defs/${d?.file ?? ''}\` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 \`{{上游id.output}}\`
`;

  if (b.produces === 'text' || b.produces === 'json') {
    p += `\n产出是${PORT_CN[b.produces]}，可以：\n- 直接给下游用（\`{{${b.kind}节点id.output}}\`）\n`;
    if (b.produces === 'json') p += '- 接「extract」节点按 JSON 路径取值\n';
    p += '- 接「condition」节点做判断\n';
  }

  p += `\n## 建节点的正确方式

用 \`def.create()\`（即 \`makeXxxNode\`）建节点，它会填好默认值。
手工拼 \`{ kind: '${b.kind}' }\` 会缺默认字段 ——
${b.hiddenParams.length ? `本控件尤其要注意 ${b.hiddenParams.map((h) => `\`${h.key}\``).join(' / ')}，它不在面板字段里。` : '本控件没有隐藏字段，但用 create() 仍是推荐做法。'}
`;
  fs.writeFileSync(path.join(DOCS, 'nodes', `${b.kind}.params.md`), p);
  n++;
}

fs.writeFileSync(path.join(DOCS, 'README.md'), idx);
console.log(`✅ 已生成 docs/：1 个索引 + ${n} 个控件（各含说明页与参数页）`);
