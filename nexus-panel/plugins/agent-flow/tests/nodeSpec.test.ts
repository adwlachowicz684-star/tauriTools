import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SPECS, specOf, canConnect, canStack, blockCatalog, PORT_LABEL,
  TEMPLATE_VARS, CAPABILITY_SIGNATURES, EDGE_SHAPE, BRANCH_EDGE_EXAMPLE,
} from '../engine/nodeSpec';
import { REQUIRES, requiresOf } from '../engine/nodeRequires';
import { UPDATE_SOURCE_KEYS } from '../types';

/** 仓库根；由 run-tests.sh 导出（测试在 $OUT/tests 下跑） */
const AF_SRC = process.env.AF_SRC || '';

/**
 * def 文件里"有没有声明字段清单"。
 *
 * 三种写法都要认：
 *   const fields: FieldDef[] = [ ... ]
 *   const fields = (d, ctx) => [ ... ]        ← task / llmChat
 *   fields: () => updateFields                ← bili / wechat（引用别处）
 *   fields: canvasRefFields                   ← canvasRef（直接引用）
 *
 * 只认前两种会把后两种判成"没有 fields"，于是守卫会要求它们标
 * manualParams —— 那是误报，比漏报更糟。
 */
const hasFieldsDecl = (src: string) =>
  /const\s+fields\s*[:=]/.test(src)
  || /fields:\s*(?:\(\)\s*=>\s*)?[A-Za-z_$][\w$]*/.test(src);

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
    /*
     * legacy 节点要跳过 —— 它们与现行节点**共用 dataKind**
     * （bili.ts / wechat.ts 的 dataKind 都是 'update'），
     * 拿它们的 fields 去约束现行 kind 的契约是错的：
     * 现行 update 走 Inspector、根本没有 fields，而这两个老节点
     * 还带着合并前那套 updateFields。
     *
     * 不跳过的话，这条守卫会逼着 update 不能标 manualParams，
     * 于是文档参数表重新派生出 biliUid / feedUrl 那 8 项废弃字段。
     */
    if (/legacy:\s*true/.test(src)) continue;
    const hasFields = hasFieldsDecl(src);
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
 * 反过来也要钉住：没有 fields 的 kind 必须标 manualParams。
 *
 * update 就是活例 —— 它走 Inspector、自己没有 fields，但 legacy 的
 * bili / wechat 与它共用 dataKind，于是"自动派生"会去读 updateFields.tsx，
 * 把合并前那 8 项（biliUid / biliMode / biliCookie / feedUrl …）排在最前，
 * 真正的 targets 反而挤到最后一行且标成"隐藏"。
 *
 * 照那份文档拼出来的节点去填顶层 biliUid / feedUrl，而 targetsOf() 的
 * 兼容路径会把它们合成一张卡 —— 能跑、不报错，但只能盯一个源。
 */
test('没有 fields 的 kind 要标 manualParams（否则会派生出别人的旧字段）', () => {
  assert.ok(AF_SRC, 'AF_SRC 未设置');
  const dir = path.join(AF_SRC, 'nodes', 'defs');
  const byKind = new Map<string, { has: boolean; legacyOnly: boolean }>();
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf-8');
    const dk = src.match(/dataKind:\s*'([^']+)'/);
    if (!dk) continue;
    const legacy = /legacy:\s*true/.test(src);
    const hasFields = hasFieldsDecl(src);
    const cur = byKind.get(dk[1]) ?? { has: false, legacyOnly: true };
    if (!legacy) {
      cur.legacyOnly = false;
      if (hasFields) cur.has = true;
    }
    byKind.set(dk[1], cur);
  }
  for (const [kind, v] of byKind) {
    const spec = SPECS[kind];
    if (!spec || v.legacyOnly) continue;
    if (!v.has) {
      assert.ok(
        spec.manualParams,
        `${kind} 自己没有 fields（走自定义面板），该标 manualParams —— `
        + '不标的话文档会去派生同 dataKind 的其它文件的字段，拿到的是废弃的那套',
      );
    }
  }
});


/**
 * 更新检测合并成"一个节点盯多平台"之后，契约必须跟着改。
 *
 * 上一版这里写的是单目标时代的 `source` 且只列了 bilibili / wechat。
 * 那份契约会经 blockCatalog() 喂给拼装方，于是拼出来的流程
 * **永远用不上其余 15 个平台**，而老字段靠 targetsOf() 读时合成、
 * 流程照样能跑 —— 不报错，只是能力少了一大截。
 *
 * 平台清单必须与 UPDATE_SOURCE_KEYS 一致，且不能退回 source 那个旧键。
 */
test('update 的契约写的是 targets 数组（不是单目标的 source）', () => {
  /*
   * params 与 hiddenParams 都要看：update 现在标了 manualParams，
   * targets 写在 params 里（它是面板上的卡片列表，不是隐藏字段）。
   * 只看 hiddenParams 的话，把 targets 挪到 params 就会报
   * "缺 targets" —— 那是守卫绑死了位置，不是契约真缺。
   */
  const sp = SPECS['update'];
  const hp = [...(sp?.params ?? []), ...(sp?.hiddenParams ?? [])];
  const tg = hp.find((p) => p.key === 'targets');
  assert.ok(tg, 'update 必须有 targets 的隐藏参数说明（多目标合并后 source 已不是写入路径）');
  assert.ok(
    !hp.some((p) => p.key === 'source'),
    '不该再写 source —— 它是老存档的兼容字段，写出来会误导拼装方往顶层填值',
  );
  assert.ok(
    tg.options && tg.options.includes('bilibili') && !tg.options.includes('bili'),
    `kind 取值写成 ${JSON.stringify(tg.options)} 了 —— `
    + "要填完整拼写 'bilibili'（'bili' 是节点 type，不是 kind 取值）",
  );
  assert.ok(
    tg.desc.includes('feedUrl'),
    '要说明 feedUrl —— 除 youtube / podcast 外都靠第三方订阅源，'
    + '不提的话拼装方不会填，节点会一直解析失败且看不出原因',
  );
});

/**
 * 平台清单必须逐一覆盖，不能只有合并前那两个。
 *
 * 拿 UPDATE_SOURCE_KEYS 对账而不是手抄一份"应该有小红书"——
 * 抄清单本身就会漏，而漏了之后这条守卫照样报绿。
 */
test('update 的平台清单与 UPDATE_SOURCE_KEYS 完全一致', () => {
  const sp = SPECS['update'];
  const hp = [...(sp?.params ?? []), ...(sp?.hiddenParams ?? [])];
  const tg = hp.find((p) => p.key === 'targets');
  assert.ok(tg?.options, 'targets 要给出平台取值');
  assert.deepEqual(
    [...tg.options].sort(),
    [...UPDATE_SOURCE_KEYS].sort(),
    '平台清单与 UPDATE_SOURCE_META 不一致 —— 加平台时漏了契约这一处',
  );
  assert.ok(
    UPDATE_SOURCE_KEYS.length > 2,
    '平台不止两个（这条防的是清单被写死成合并前的 bilibili / wechat）',
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

/**
 * 执行器用到的能力必须在 REQUIRES 里登记。
 *
 * 漏登记的失效方式是**安静**的：界面契约里的 requires 从 REQUIRES 派生，
 * 没登记就显示绿灯；跑起来要么报 "xxx is not a function"（CLI 那种连
 * 自写校验都没有的），要么靠执行器里另一份措辞兜着。两种都查不出来。
 */
test('执行器用到的外部能力都登记在 REQUIRES 里', () => {
  if (!AF_SRC) return;
  const rtSrc = fs.readFileSync(path.join(AF_SRC, 'engine/runTypes.ts'), 'utf-8');
  const m = /export type RunOptions = \{([\s\S]*?)\n\};/.exec(rtSrc);
  assert.ok(m, '读不到 RunOptions');
  /* 可选的函数型字段才是"能力"；params / input 之类是数据，不是能力 */
  const caps = [...m[1].matchAll(/^\s{2}([A-Za-z_]\w*)\??:\s*\(/gm)].map((x) => x[1]);
  const skip = new Set(['askHuman', 'onEvent', 'input']); // 有优雅降级 / 非能力
  const registered = new Set(
    Object.values(REQUIRES).flatMap((l) => (l ?? []).map((r) => r.key)),
  );
  const dir = path.join(AF_SRC, 'engine/runners');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const c of caps) {
      if (skip.has(c)) continue;
      if (!new RegExp(`opts\\.${c}\\b`).test(src)) continue;
      assert.ok(registered.has(c), `${f} 用到了能力 ${c}，但 REQUIRES 里没登记`);
    }
  }
  /* 反向钉住这次补的两条 —— 上面那条是通用扫描，这条保证例子本身在 */
  assert.ok(REQUIRES.task?.some((r) => r.key === 'executor'), 'CLI 要登记命令行执行能力');
  assert.ok(
    REQUIRES.tableRead?.some((r) => r.key === 'tableReader'),
    '读表格要登记表格读取能力',
  );
});

test('读表格不再自己判能力（交给 runnerKit 统一校验）', () => {
  if (!AF_SRC) return;
  const src = fs.readFileSync(path.join(AF_SRC, 'engine/runners/table.ts'), 'utf-8');
  assert.doesNotMatch(
    src,
    /if \(!ctx\.opts\.tableReader\)/,
    '执行器里不该再留一份自写的能力校验',
  );
});

/**
 * 每个注册了的积木都得有契约 —— 反向对账，不靠手抄清单。
 *
 * 原有的"契约覆盖已知的全部积木"只查了 8 个必须项加一个数量下限，
 * 于是**新节点漏写契约时它照样报绿**：漏掉的节点压根不在
 * SPECS 里，遍历 SPECS 自然不会碰到它。
 *
 * 漏契约的后果同样是安静的：specOf 返回 null，canConnect 一律放行，
 * 拼装时的坑一个都拦不住（"等待插在链中间截断数据"正是靠契约拦的）。
 *
 * 所以这里从 nodes/defs 的源码里把 dataKind 全量抓出来，逐一对账。
 */
test('每个注册的积木都有契约（从 defs 源码反向对账）', () => {
  const dir = path.join(AF_SRC, 'nodes', 'defs');
  if (!fs.existsSync(dir)) return;
  const kinds = new Set<string>();
  for (const f of fs.readdirSync(dir)) {
    if (!/\.tsx?$/.test(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf-8');
    if (!/registerNode\(/.test(src)) continue; // 纯字段模块（如 updateFields）不注册节点
    for (const m of src.matchAll(/dataKind:\s*'([a-zA-Z_-]+)'/g)) kinds.add(m[1]);
  }
  assert.ok(kinds.size >= 30, `只抓到 ${kinds.size} 种，正则可能失效了`);

  /*
   * 容器与占位：它们没有端口、不参与执行，specOf 返回 null 是**设计如此**
   * —— 写死在白名单里，是为了让"忘了写契约"和"刻意不写"能分得开。
   */
  const NO_SPEC = new Set(['frame', 'taskPane', 'apiPane']);
  const missing = [...kinds].filter((k) => !NO_SPEC.has(k) && !SPECS[k]);
  assert.deepEqual(missing, [], `这些积木没有契约：${missing.join(', ')}`);
});

/**
 * manualParams 的手写参数说明必须覆盖节点真实可填的字段。
 *
 * 这条是盲测炸出来的：loop 只写了 mode / maxIterations 两个，
 * 而 makeLoopNode 实际初始化 8 个 —— 漏掉的 times / separator /
 * source / pattern / onError / collect 拼装方一概不知，
 * 于是拼出来的循环**永远是默认那一套**（list、3 次、\n、出错继续）。
 *
 * 危害等级比"少几个可选值"高一档：流程能跑、不报错、界面看着也正常，
 * 只是行为永远是默认值，用户只会觉得"这个节点怎么不听我的"。
 *
 * trigger 更极端：契约写的是单值 `mode`，而实际字段早在改成"一个节点
 * 可挂多种触发方式"时就变成了 `triggers` 数组（且最后一种从
 * `conversation` 改名成 `chat`）。拼装方照契约写 `mode: 'webhook'`，
 * 运行时读 `triggers` 得到空数组 —— **这个触发器永远不会触发**。
 *
 * 反向也钉住：契约里写了但实际没有的键同样要报（比如 condition 的
 * `op`，那是规则里的字段，不是节点顶层参数），否则说明又会漂移。
 */
test('manualParams 节点的契约参数与 makeXxxNode 的真实字段对得上', () => {
  /*
   * types.ts 是 ts（不含 JSX），测试链路能直接读源码 ——
   * 但要走 AF_SRC，因为测试跑在 $OUT/tests 下，相对路径到不了仓库。
   */
  const typesSrc = fs.readFileSync(path.join(AF_SRC, 'types.ts'), 'utf-8');

  /** 运行时状态字段：不是参数，拼装方不该写 */
  const RUNTIME = new Set([
    'status', 'output', 'error', 'kind', 'label', 'labelMode',
    'badge', 'collapsed', 'lastFiredAt', 'lastFiredKind',
  ]);

  /** 从 `export function makeXxxNode` 的 return 里抓 data 的字段名 */
  const realFields = (fn: string): Set<string> => {
    const m = typesSrc.match(
      new RegExp(`export function ${fn}\\([\\s\\S]*?\\n\\}`),
    );
    if (!m) return new Set();
    return new Set(
      [...m[0].matchAll(/^\s{6}(\w+):/gm)].map((x) => x[1]).filter((k) => !RUNTIME.has(k)),
    );
  };

  /** manualParams 节点 → 它在 types.ts 里的构造函数名 */
  const FN: Record<string, string> = {
    trigger: 'makeTriggerNode',
    condition: 'makeConditionNode',
    loop: 'makeLoopNode',
    parallel: 'makeParallelNode',
  };

  for (const [dk, fn] of Object.entries(FN)) {
    const spec = SPECS[dk];
    assert.ok(spec, `${dk} 没有契约`);
    assert.ok(spec.manualParams, `${dk} 应该是 manualParams（本条只盯手写说明）`);

    const real = realFields(fn);
    assert.ok(real.size > 0, `${fn} 没抓到字段，正则可能失效了`);

    const declared = new Set([
      ...(spec.params ?? []).map((p) => p.key),
      ...(spec.hiddenParams ?? []).map((p) => p.key),
    ]);

    const missing = [...real].filter((k) => !declared.has(k));
    assert.deepEqual(
      missing, [],
      `${dk} 漏了这些真实字段的参数说明：${missing.join(', ')}`
      + ' —— 拼装方会永远用默认值，且不报错',
    );

    /*
     * 反向：契约写了但实际不存在的键。
     * 例外是 rules 这种嵌套结构里的键（op 属于规则项，不是节点顶层），
     * 只报**顶层**里没有的 —— 用"是否在 real 里"判断会误伤，
     * 所以这里只查"契约声明的顶层键里有没有明显写错的旧名"。
     */
    for (const k of declared) {
      if (k === 'op') continue; // 规则项字段，非节点顶层
      assert.ok(
        real.has(k) || k === 'items',
        `${dk} 契约写了 \`${k}\`，但 ${fn} 里没有这个字段 —— 说明契约已漂移`,
      );
    }
  }

  /* trigger 的取值清单必须与类型一致（conversation 是改版前的旧名） */
  const tg = SPECS['trigger']?.params?.find((p) => p.key === 'triggers');
  assert.ok(tg, 'trigger 必须有 triggers 的说明（mode 是改版前的旧字段）');
  assert.ok(
    !SPECS['trigger']?.params?.some((p) => p.key === 'mode'),
    'trigger 不该再写 mode —— 它已不存在，写出来拼装方会写一个没人读的字段',
  );
  assert.deepEqual(
    [...(tg.options ?? [])].sort(),
    ['chat', 'cron', 'interval', 'manual', 'watch'] .concat(['webhook']).sort(),
    'triggers 的取值清单必须与 TriggerKind 一致（conversation 已改名 chat）',
  );
});
