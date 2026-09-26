import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SPECS, specOf, canConnect, canStack, blockCatalog, PORT_LABEL,
  TEMPLATE_VARS, CAPABILITY_SIGNATURES, EDGE_SHAPE, BRANCH_EDGE_EXAMPLE,
} from '../engine/nodeSpec';
import { REQUIRES, requiresOf } from '../engine/nodeRequires';

/** 仓库根；由 run-tests.sh 导出（测试在 $OUT/tests 下跑） */
const AF_SRC = process.env.AF_SRC || '';

/**
 * 节点契约 —— 决定两个积木能不能接。
 *
 * 重点是 'mark' 与 'any' 的区分：前者**截断**上游数据，
 * 后者**透传**。外观上都是"有个输出"，语义相反。
 */

const S = (produces: string, accepts: string | string[]) =>
  ({ produces, accepts } as never);

/* ---------------- 基本取值 ---------------- */

test('specOf 按 dataKind 取得到', () => {
  assert.ok(specOf('extract'));
  assert.ok(specOf('generic-http'));
});

test('specOf：未知类型返回 null，不猜', () => {
  assert.equal(specOf('不存在的类型'), null);
  assert.equal(specOf(''), null);
  assert.equal(specOf(undefined), null);
});

/* ---------------- 覆盖 ---------------- */

test('每个契约都有产出与可接受声明', () => {
  for (const [k, s] of Object.entries(SPECS)) {
    assert.ok(s.produces, `${k} 缺 produces`);
    assert.ok(s.accepts, `${k} 缺 accepts`);
    assert.ok(PORT_LABEL[s.produces], `${k} 的 produces 取值非法`);
  }
});

/**
 * 这条是防止"节点加了、契约没加"。
 * 新节点漏写契约 → canConnect 对它们一律放行 → 拼装时的坑一个都拦不住。
 */
test('契约覆盖已知的全部积木（数量与清单一致）', () => {
  const kinds = Object.keys(SPECS);
  assert.ok(kinds.length >= 20, `只覆盖了 ${kinds.length} 种，疑似漏了新节点`);
  for (const must of ['task', 'condition', 'extract', 'generic-http', 'wait', 'log', 'fs', 'ocr']) {
    assert.ok(kinds.includes(must), `缺 ${must}`);
  }
});

test('blockCatalog 字段完整，可直接给 AI 消费', () => {
  const list = blockCatalog();
  assert.equal(list.length, Object.keys(SPECS).length);
  for (const b of list) {
    assert.ok(b.kind && b.producesDesc, `${b.kind} 信息不全`);
    assert.equal(typeof b.paramsFromFields, 'boolean');
  }
});

/* ---------------- 核心：mark 会截断数据 ---------------- */

/**
 * 等待 / 提示音 / 播放音频 已改成**透传**（状态走运行日志），
 * 所以「上游 → 等待 → 提取」现在是通的。
 *
 * 这两条守的是"别改回去" —— 一旦有人把 output 改回状态文本，
 * 数据链会再次被静默截断：提取取不到东西却不报错。
 */
test('等待节点接提取：正常（已改为透传）', () => {
  const v = canConnect(specOf('wait'), specOf('extract'));
  assert.equal(v.level, 'ok', `不该告警：${v.reason}`);
  assert.equal(specOf('wait')?.produces, 'any', 'wait 的产出必须是透传型');
});

test('提示音 / 播放音频 也是透传，不再截断数据', () => {
  for (const k of ['beep', 'play-audio']) {
    assert.equal(specOf(k)?.produces, 'any', `${k} 应是透传`);
    assert.equal(canConnect(specOf(k), specOf('extract')).level, 'ok');
  }
});

/**
 * 对照：真正会截断数据的仍然是 mark 型（条件节点）。
 * mark / any 两个种类还得留着 —— 条件节点的输出是分支标记，
 * 不是数据，接到提取上依然是空的。
 */
test('mark 型（条件节点）依然会截断数据', () => {
  const v = canConnect(specOf('condition'), specOf('extract'));
  assert.equal(v.level, 'warn');
  assert.ok(v.reason && v.reason.includes('状态标记'));
});

/**
 * 对照：日志标记是**透传**，插在链中间无害。
 * 与 wait 形成对比 —— 这正是 mark / any 分两个种类的意义。
 */
test('日志标记接提取：正常（它是透传）', () => {
  const v = canConnect(specOf('log'), specOf('extract'));
  assert.equal(v.level, 'ok', `不该告警：${v.reason}`);
});

/* ---------------- 其它组合 ---------------- */

test('HTTP → 提取：正常（json 能吃）', () => {
  assert.equal(canConnect(specOf('generic-http'), specOf('extract')).level, 'ok');
});

test('任务 → 翻译：正常（都是文本）', () => {
  assert.equal(canConnect(specOf('task'), specOf('translate')).level, 'ok');
});

test('更新检测 → 条件：正常（bool 给判断用）', () => {
  assert.equal(canConnect(specOf('update'), specOf('condition')).level, 'ok');
});

test('连到不需要输入的节点：提醒（连了也用不上）', () => {
  const v = canConnect(specOf('task'), specOf('clock'));
  assert.equal(v.level, 'warn');
  assert.ok(v.reason && v.reason.includes('不需要输入'));
});

test('类型不符时说明里带上双方端口', () => {
  const v = canConnect(specOf('fs'), specOf('translate'));
  assert.equal(v.level, 'warn');
  assert.ok(v.reason && v.reason.includes('文件'), `提示应说明上游产出：${v.reason}`);
});

test('有一方没契约时放行，不猜', () => {
  assert.equal(canConnect(null, specOf('extract')).level, 'ok');
  assert.equal(canConnect(specOf('task'), null).level, 'ok');
});

/* ---------------- 嵌合用同一判据 ---------------- */

/**
 * 嵌合等价于一条隐式边。若判据与拉线不一致，
 * 会出现"拉线有提示、吸附上去没提示"的割裂。
 */
test('canStack 与 canConnect 结论一致', () => {
  for (const [a, b] of [['wait', 'extract'], ['task', 'translate'], ['log', 'extract']]) {
    assert.equal(
      canStack(specOf(a), specOf(b)).level,
      canConnect(specOf(a), specOf(b)).level,
      `${a}→${b} 两种方式结论应一致`,
    );
  }
});

/* ---------------- 保守性 ---------------- */

/**
 * 刻意不做硬阻止：契约描述的是"语义上能不能用"，
 * 用户可能有我没想到的用法。硬阻止会让"明明能连却连不上"，
 * 比给一条提示更让人困惑。
 */
test('类型不符也只是 warn，不 block', () => {
  for (const a of Object.keys(SPECS)) {
    for (const b of Object.keys(SPECS)) {
      const v = canConnect(specOf(a), specOf(b));
      assert.notEqual(v.level, 'block', `${a}→${b} 不该被硬阻止`);
    }
  }
});


/* ================= 给 AI 的三样补充信息 ================= */

/**
 * 拼装实测里唯一失败的场景就栽在这里：凭直觉写 {{input}} 当上游。
 * 它是**全局输入**，不是上游输出 —— 而且全局输入有值时会"跑通但翻译错内容"。
 */
test('模板变量：{{input}} 必须标明它不是上游输出', () => {
  const v = TEMPLATE_VARS.find((x) => x.syntax === '{{input}}');
  assert.ok(v, '清单里必须有 {{input}}');
  assert.ok(v.warn && v.warn.includes('不是'), '必须写清"不是上游输出"');
});

test('模板变量：{{id.output}} 要说明能取任意已执行节点', () => {
  const v = TEMPLATE_VARS.find((x) => x.syntax.includes('.output'));
  assert.ok(v);
  assert.ok(v.desc.includes('任意'), '要说明不限于直接上游');
});

test('模板变量清单不为空且语法互不重复', () => {
  assert.ok(TEMPLATE_VARS.length >= 5);
  const set = new Set(TEMPLATE_VARS.map((v) => v.syntax));
  assert.equal(set.size, TEMPLATE_VARS.length, '语法有重复');
});

/**
 * requires 是从 nodeRequires 自动回填的，不是手抄 ——
 * 这条盯着"回填真的发生了"，否则 AI 拿到的能力清单全是空的。
 */
test('能力需求：按 kind 从 REQUIRES 自动回填，不手写', () => {
  for (const k of Object.keys(REQUIRES)) {
    const spec = SPECS[k];
    assert.ok(spec, `REQUIRES 里有 ${k}，但契约里没有这条`);
    const want = (REQUIRES[k] ?? []).map((r) => r.key);
    assert.deepEqual(
      spec.requires.slice().sort(),
      [...new Set(want)].sort(),
      `${k} 的能力清单与 nodeRequires 不一致（应自动派生，不能手抄）`,
    );
  }
});

/**
 * 纯本地节点在**默认配置**下不需要任何外部能力（浏览器模式也能跑）。
 *
 * 这里查 requiresOf 而不是静态 SPECS[k].requires：
 * 「播放声音」的能力需求是**条件式**的（只有来源选「本地文件」才要读盘），
 * 静态清单里必然带着那个 key，用静态清单判就会把"系统音效也要装桌面端"
 * 这种误报当成对的 —— 而用户看到的正是运行时判定。
 */
test('能力需求：纯本地节点的 requires 为空（浏览器模式也能跑）', () => {
  for (const k of ['wait', 'log', 'beep', 'clock', 'const', 'extract', 'join', 'gate']) {
    assert.equal(requiresOf({ kind: k }).length, 0, `${k} 不该需要外部能力`);
  }
  /* 条件式需求：选了本地文件才要读盘，选系统音效仍然不要 */
  assert.equal(requiresOf({ kind: 'beep', source: 'preset' }).length, 0,
    '系统音效不该要读盘能力（它不读盘）');
  assert.ok(requiresOf({ kind: 'beep', source: 'file' }).length > 0,
    '本地音频文件必须登记读盘能力');
});

test('能力需求：具体取值正确（AI 据此判断链能否在本机跑）', () => {
  assert.ok(specOf('translate')?.requires.includes('llmCaller'));
  assert.ok(specOf('generic-http')?.requires.includes('httpRequester'));
  assert.ok(specOf('fs')?.requires.includes('fsExecutor'));
});

/**
 * llm 配置不在 fields 里（由 llm-config 卡片组提供），
 * 从字段清单派生时会漏掉 —— AI 手工建节点就会缺这个字段，
 * 报 "Cannot read properties of undefined (reading 'provider')"
 * 这种与真实原因无关的错。
 */
test('隐藏参数：AI 节点要声明 llm 配置', () => {
  for (const k of ['ocr', 'translate']) {
    const hp = SPECS[k]?.hiddenParams ?? [];
    assert.ok(
      hp.some((p) => p.key === 'llm'),
      `${k} 必须声明 llm（它不在 fields 里，派生不出来）`,
    );
  }
});

test('隐藏参数：说明里要指向 def.create()', () => {
  const hp = SPECS['translate']?.hiddenParams ?? [];
  const llm = hp.find((p) => p.key === 'llm');
  assert.ok(llm && llm.desc.includes('create'), '要提示用 def.create() 建节点');
});

/**
 * 条件节点是 AI 拼流程时最需要生成的（"如果有更新就…"），
 * 而它用整体自定义面板、fields 里派生不出来 ——
 * 实测时我因为不知道 ConditionRule 结构只能去看源码。
 */
test('条件节点：规则结构要写清，不能只写"规则列表"', () => {
  const ps = SPECS['condition']?.params ?? [];
  const rules = ps.find((p) => p.key === 'rules');
  assert.ok(rules, '必须有 rules');
  assert.ok(rules.desc.includes('source'), '要说明 source 字段');
  assert.ok(rules.desc.includes('op'), '要说明 op 字段');
  assert.ok(ps.some((p) => p.key === 'op' && p.options?.length), '算子要给出可选取值');
  assert.ok(ps.some((p) => p.key === 'defaultBranch'), '要说明兜底分支');
});

test('blockCatalog 带上 requires 与 hiddenParams', () => {
  for (const b of blockCatalog()) {
    assert.ok(Array.isArray(b.requires), `${b.kind} 缺 requires`);
    assert.ok(Array.isArray(b.hiddenParams), `${b.kind} 缺 hiddenParams`);
  }
});


/**
 * 有 fields 的节点不能标 manualParams。
 *
 * 这条是盲测炸出来的：update 节点（bili/wechat 共用 updateFields）
 * 被标成了 manualParams 且只写了 source，于是 AI 不知道还要填
 * biliUid / feedUrl，跑出来 "Cannot read properties of undefined (reading 'trim')"
 * —— 一个与"参数没填"完全无关的报错，极其难查。
 *
 * 标了 manualParams 就等于告诉 AI"参数只有我列的这几个"，
 * 而实际有 fields 时这个断言是错的，且不会报错。
 *
 * 用源码级检查：defs 是 tsx（含 JSX），测试链路加载不了，
 * 只能读文件判断"有没有声明 fields"。
 */
test('有 fields 的节点不能标 manualParams（参数该自动派生）', () => {
  /* AF_SRC 由 run-tests.sh 导出（测试在 $OUT/tests 下跑，相对路径到不了仓库） */
  assert.ok(AF_SRC, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
  const dir = path.join(AF_SRC, 'nodes', 'defs');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf-8');
    const dk = src.match(/dataKind:\s*'([^']+)'/);
    if (!dk) continue;
    // 有 fields 声明：const fields 或 fields: () => xxx
    const hasFields = /const\s+fields\s*[:=]/.test(src) || /fields:\s*\(\)\s*=>/.test(src);
    const spec = SPECS[dk[1]];
    if (!spec) continue;
    if (hasFields) {
      assert.ok(
        !spec.manualParams,
        `${f}（${dk[1]}）有 fields，不该标 manualParams —— `
        + '标了就等于告诉 AI"参数只有我列的几个"，会漏掉真实参数',
      );
    }
  }
});


/**
 * update 的 source 取值是 'bilibili'（完整拼写），不是 'bili'。
 *
 * 'bili' 是节点的 **type**，'bilibili' 是 data.source 的取值 ——
 * 两者只差一个音节，盲测时写成 'bili' 导致走不进 bilibili 分支，
 * 掉进 wechat 分支去 trim 空的 feedUrl，报
 * "Cannot read properties of undefined (reading 'trim')"，
 * 与"取值写错"完全对不上号。
 */
test('update 的 source 取值必须是 bilibili（完整拼写）', () => {
  const hp = SPECS['update']?.hiddenParams ?? [];
  const src = hp.find((p) => p.key === 'source');
  assert.ok(src, 'update 必须有 source 的隐藏参数说明');
  assert.ok(
    src.options && src.options.includes('bilibili') && !src.options.includes('bili'),
    `source 取值写成 ${JSON.stringify(src.options)} 了 —— `
    + "应为 ['bilibili','wechat']（'bili' 是 type，不是 source 取值）",
  );
});


/**
 * 光说"需要哪个能力"不够，还要说清函数签名。
 * 盲测时给 fetcher 返回了对象（实际要字符串），报
 * "xml.trim is not a function"，与真实原因完全对不上。
 */
test('每个用到的能力都要有签名说明', () => {
  const used = new Set<string>();
  for (const spec of Object.values(SPECS)) {
    for (const r of spec.requires ?? []) used.add(r);
  }
  for (const r of used) {
    assert.ok(
      CAPABILITY_SIGNATURES[r],
      `能力 ${r} 缺签名说明 —— AI 不知道这个函数怎么调`,
    );
  }
});

test('fetcher 的签名要标明返回字符串（不是对象）', () => {
  assert.ok(
    CAPABILITY_SIGNATURES['fetcher'].includes('Promise<string>'),
    'fetcher 返回字符串，写成对象会报 "xxx.trim is not a function"',
  );
});


/**
 * 分支字段在边的**顶层**，不是 data.branch。
 * 写错不报错，只表现为"该剪的没剪"——两条分支全跑了。
 */
test('边结构：branch 是顶层字段，要写清楚', () => {
  const doc = EDGE_SHAPE.find((e) => e.field.includes('branch'));
  assert.ok(doc, '边结构里必须说明 branch');
  assert.ok(doc.field.includes('顶层'), '必须写明是顶层字段');
});

test('边结构：循环出边的 loopRole 也要说明', () => {
  assert.ok(EDGE_SHAPE.some((e) => e.field.includes('loopRole')));
});

test('分支边示例可直接照抄（branch 在顶层）', () => {
  assert.ok(
    BRANCH_EDGE_EXAMPLE.includes("branch: 'r1'")
    && !BRANCH_EDGE_EXAMPLE.includes('data:'),
    '示例里 branch 必须在顶层，不能套在 data 里',
  );
});

/* ================= 侧栏一句话说明 ================= */

/*
 * 「显示说明」会把每个节点下面铺一行说明，那行取的是 meta.sub。
 * 缺了 sub 的节点**整行空白** —— 用户看到别人有、它没有，
 * 只会以为是界面漏了。
 *
 * 这类缺失测试跑不出来（界面看着也正常），只能扫源码。
 */
const DEFS = path.join(process.env.AF_SRC || '.', 'nodes', 'defs');

test('每个节点定义都写了 sub（否则「显示说明」下整行空白）', () => {
  if (!fs.existsSync(DEFS)) return;
  const files = fs.readdirSync(DEFS).filter((f) => /\.tsx?$/.test(f));
  const bad: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(DEFS, f), 'utf-8');
    // 只看注册了节点的那些文件；纯字段模块（如 updateFields）不在此列
    if (!/registerNode\(/.test(src)) continue;
    if (!/sub:/.test(src)) bad.push(f);
  }
  assert.deepEqual(bad, [], `这些节点没写 sub：${bad.join(', ')}`);
});

/*
 * 两处排序必须走同一个 pickBrief —— 各排各的序会出现
 * "点开与不点开看到两句话"，而两句都没错，错的是排了两处。
 */
test('侧栏短说明与展开块顶行都走 pickBrief', () => {
  const root = process.env.AF_SRC || '.';
  for (const rel of ['components/Sidebar.tsx', 'components/NodeDesc.tsx']) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(src, /pickBrief\(/, `${rel} 要调用 pickBrief 取一句话说明`);
  }
});
