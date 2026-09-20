import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 界面一致性的源码级守卫。
 *
 * 这类问题**测试跑不出来**（界面看着也正常），只有人工比对才发现，
 * 而且改一处忘另一处时不会报错 —— 所以只能用源码级检查盯着。
 *
 * 注意：检查前要剥掉块注释。注释里为了说明"为什么不能这么写"，
 * 正好要把坏写法原样写出来 —— **不剥的话说明本身就会让检查永远失败**。
 */

const ROOT = process.env.AF_SRC || path.resolve(__dirname, '..');
const COMP = path.join(ROOT, 'components');

function stripComments(src: string): string {
  // 只剥 /* */ 块注释；行注释里的中文句号不影响这些检查
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

function read(p: string): string {
  return stripComments(fs.readFileSync(p, 'utf-8'));
}

function comps(): string[] {
  if (!fs.existsSync(COMP)) return [];
  return fs.readdirSync(COMP).filter((f) => f.endsWith('.tsx'));
}

/* ================= 配置状态徽章 ================= */

/*
 * 以前每个卡片都能传 statusText 覆盖"待运行 / 执行中 / 已完成"，
 * 于是这套文案在十几个组件里各摊一份（还夹杂整份重抄）。
 *
 * 现在卡片**只显示配置状态**（就绪 / 缺项 / 缺参数），
 * 运行状态一律看任务窗口 —— statusText 这个口子整个取消。
 *
 * 留着它会变成"能传但没人读"的参数：改它没有任何效果，
 * 而后来的人看不出为什么没效果。
 */
const DEFINER = 'NodeShell.tsx';

test('没有组件再传 statusText（运行状态不在卡片上显示）', () => {
  const bad = comps().filter((f) => /statusText/.test(read(path.join(COMP, f))));
  assert.deepEqual(bad, [], `这些组件还在传 statusText：${bad.join(', ')}`);
});

test('没有组件再引 NODE_STATUS_TEXT（它已随运行状态一起取消）', () => {
  const bad = comps().filter((f) => /NODE_STATUS_TEXT/.test(read(path.join(COMP, f))));
  assert.deepEqual(bad, [], `这些组件还引着 NODE_STATUS_TEXT：${bad.join(', ')}`);
});

test('配置状态的短文案全项目只有一处定义（LEVEL_SHORT）', () => {
  /*
   * 三个词写在卡片组件里的话，改一个词要改十几处；
   * 而这类"同一句话多个副本"的漂移没有任何报错。
   */
  const files = ['engine/nodeValidate.ts', 'components/NodeShell.tsx'];
  const defs = files.filter((f) => /const\s+LEVEL_SHORT\s*(?::[^=]*)?=/.test(read(path.join(ROOT, f))));
  assert.deepEqual(defs, ['engine/nodeValidate.ts'], `LEVEL_SHORT 抄了多份：${defs.join(', ')}`);
  // 卡片必须用它来显示，而不是自己写字面量
  const shell = read(path.join(COMP, DEFINER));
  assert.match(shell, /LEVEL_SHORT\[dot\]/, 'NodeShell 要用 LEVEL_SHORT 显示配置状态');
});

test('圆点在徽章里，不在标题行上当独立元素', () => {
  /*
   * 圆点与徽章说的是同一件事。分开摆时圆点像第二个状态 ——
   * warn 的圆点带光环，视觉上比徽章本身还抢眼。
   */
  const shell = read(path.join(COMP, DEFINER));
  const head = shell.slice(shell.indexOf('node-head'), shell.indexOf('node-line--alert'));
  assert.ok(/node-badge[\s\S]{0,200}node-dot/.test(head), '圆点应在徽章内部');
  // 徽章要在标题之前
  assert.ok(head.indexOf('node-badge') < head.indexOf('node-title'), '徽章应在标题左边');
});

/* ================= 颜色 ================= */

test('卡片不硬编码节点类型色（走注册表）', () => {
  /*
   * 模块卡片以前写死 '#f59e0b'，与注册表里的 color 是两份 ——
   * 改注册表配色时卡片不变，且**没有任何提示**。
   */
  const bad = comps().filter((f) => /typeColor=\{['"]#[0-9a-fA-F]{3,8}['"]/.test(read(path.join(COMP, f))));
  assert.deepEqual(bad, [], `这些组件硬编码了 typeColor：${bad.join(', ')}`);
});

/* ================= 运行时字段清单 ================= */

test('RUNTIME_KEYS 全项目只有一处定义', () => {
  const engines = fs.readdirSync(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.ts'));
  const defs = engines.filter((f) =>
    /const\s+RUNTIME_KEYS\s*=/.test(read(path.join(ROOT, 'engine', f))));
  assert.deepEqual(defs, ['runtimeKeys.ts'], `运行时字段清单抄了多份：${defs.join(', ')}`);
});

test('stripRuntime 的实现只在 runtimeKeys.ts', () => {
  const engines = fs.readdirSync(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.ts'));
  const impl = engines.filter((f) =>
    /function\s+stripRuntime\b/.test(read(path.join(ROOT, 'engine', f))));
  assert.deepEqual(impl, ['runtimeKeys.ts'], `stripRuntime 抄了多份：${impl.join(', ')}`);
});

/* ================= 存储键 ================= */

test('存储键统一 agent-flow 前缀', () => {
  const engines = fs.readdirSync(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.ts'));
  const bad: string[] = [];
  for (const f of engines) {
    const s = read(path.join(ROOT, 'engine', f));
    for (const m of s.matchAll(/_KEY\s*=\s*'([^']+)'/g)) {
      if (!m[1].startsWith('agent-flow')) bad.push(`${f}:${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `这些存储键没有 agent-flow 前缀：${bad.join(', ')}`);
});


/* ================= 密钥清单必须同源 ================= */

/*
 * 保险箱（canvasStore 的 SECRET_FIELDS）与脱敏（sanitize 的 SECRET_PATHS）
 * 曾经是**抄成两份**的清单，而前者少了 'config.token'。
 *
 * 后果：webhook 校验 token 被认出来是密钥，却不会被挖进保险箱 ——
 * 明文留在画布存档与导出文件里，且不报错、测试不红。
 *
 * 这是"同一件事两处写"最危险的一种：抄的是安全清单。
 */
test('SECRET_FIELDS 直接复用 SECRET_PATHS，不再自己抄一份', () => {
  /*
   * 必须先剥注释 —— 本文件的 read() 不剥。
   * 而注释里为说明"以前漏了什么"会把旧数组原样写出来，
   * 不剥的话**把清单改回错的检查依然通过**（假阴性）。
   * 这与 classNames 那条守卫踩的是同一个坑。
   */
  /*
   * 正则用**拼接**构造，不写字面量：
   * 字面量里的 /* 与 *​/ 会被 strip-ts.py 当成注释边界吃掉，
   * 生成的 .mjs 直接语法错误（这是这个脚本第四次带来这类麻烦）。
   */
  const blockComment = new RegExp('/' + '\\*' + '[\\s\\S]*?' + '\\*' + '/', 'g');
  const f = read(path.join(ROOT, 'engine/canvasStore.ts')).replace(blockComment, '');
  assert.ok(
    /const SECRET_FIELDS = SECRET_PATHS;/.test(f),
    '保险箱必须直接用 sanitize 的清单，抄一份就会漏字段',
  );
  assert.ok(
    !/const SECRET_FIELDS = \['llm\.apiKey'/.test(f),
    '不能再出现手写的密钥字段数组',
  );
  assert.ok(
    /import \{ SECRET_PATHS \} from '\.\/sanitize';/.test(f),
    '要从 sanitize 引入',
  );
});

/* ================= 并发刷新要有代号守卫 ================= */

test('MCP 刷新用 seq 守卫，避免旧结果覆盖新结果', () => {
  const app = read(path.join(ROOT, 'App.tsx'));
  assert.ok(/mcpRefreshSeq/.test(app), '并发刷新要有代号');
  /*
   * 匹配**具体那一条** return 语句，不能只查"文件里有这个比较" ——
   * finally 里还有一处 `seq === mcpRefreshSeq.current`，
   * 只查子串的话，把真正的守卫删掉检查依然通过（假阴性）。
   */
  assert.ok(
    /if \(seq !== mcpRefreshSeq\.current\) return;/.test(app),
    '拿到结果后要先确认自己还是最新那次，否则旧刷新会覆盖新结果',
  );
});

/* ================= 异步失败不能被静默吞掉 ================= */

test('startWatch 必须 catch（否则监听失败无任何提示）', () => {
  const app = read(path.join(ROOT, 'App.tsx'));
  const i = app.indexOf('startWatch(');
  assert.ok(i > 0, '要有 startWatch 调用');
  const tail = app.slice(i, i + 600);
  assert.ok(/\.catch\(/.test(tail), 'startWatch 的 Promise 必须 catch');
});

/* ================= 节点 id ================= */

/*
 * 节点 id 形如 `ma` + 时间戳乱码（mamu7obyv93）——
 * 对用户没有意义，看不出是哪个节点，还像出错信息。
 * 它只该出现在**排查的位置**（属性面板），不该占每一张卡片的一行。
 */
test('卡片上不再渲染节点 id', () => {
  const shell = read(path.join(COMP, DEFINER));
  /*
   * 匹配的是"把 id 当文本渲染"这个动作。
   * 不能只查"文件里含 node-id"—— 注释里为了说明为什么挪走，
   * 正好要把这个类名原样写出来，那样检查永远失败（假阴性）。
   */
  const bad = /node-id|\{[^{}]*\bid\b[^{}]*\}\s*<\/span>/.test(shell);
  assert.equal(bad, false, 'NodeShell 又渲染了节点 id');
});

test('节点 id 只在属性面板里可查（可复制）', () => {
  const insp = read(path.join(COMP, 'Inspector.tsx'));
  assert.match(insp, /节点 id/, '属性面板要有「节点 id」行');
  // 能复制才算真能用于排查：光显示一串乱码，还得手打
  assert.match(insp, /clipboard[\s\S]{0,120}writeText/, '「节点 id」要能点一下复制');
});

/* ================= 节点说明浮层 ================= */

/*
 * 说明原先**撑在侧栏列表里**：点开一条把下面的条目整体下推，
 * 收起又跳回来，扫列表时很烦；侧栏只有 260px，结构化说明挤着要折好几行。
 *
 * 现在改成浮层（NodeTip）。守的是"说明**只**在浮层里"——
 * 两处都渲染的话，列表里那块就会自己长回来。
 */
test('侧栏条目下不再内联展开说明块', () => {
  const sb = read(path.join(COMP, 'Sidebar.tsx'));
  /*
   * 匹配"条目 open 就渲染 NodeDesc"这个动作。
   * 不能只查"文件里含 NodeDesc" —— 浮层内容用的就是 NodeDesc，
   * 那样检查永远失败（假阴性）。
   */
  const inline = /\{open \?\s*[\s\S]{0,120}<NodeDesc/.test(sb);
  assert.equal(inline, false, 'Sidebar 又把说明块内联展开了');
});

test('说明浮层用 portal 挂到 body（否则被侧栏滚动区裁掉）', () => {
  const tip = read(path.join(COMP, 'NodeTip.tsx'));
  /*
   * .side-body 有 overflow-y:auto。浮层若渲染在条目下面，
   * 哪怕 position:fixed 也会被它裁剪 —— 只露出侧栏内那一条。
   */
  assert.match(tip, /createPortal\(/, 'NodeTip 必须挂到 document.body');
  assert.match(tip, /position:\s*fixed|className="node-tip"/);
});

test('浮层两种打开方式都通：点击钉住 / 悬停预览', () => {
  const sb = read(path.join(COMP, 'Sidebar.tsx'));
  assert.match(sb, /onMouseEnter[\s\S]{0,80}onHover\(/, '悬停要能打开浮层');
  assert.match(sb, /onClick[\s\S]{0,120}onItemClick\(/, '点击要能打开浮层');
  /*
   * 钉住态与悬停态必须分开：
   * 合成一个开关的话，要么悬停后浮层赖着不走，
   * 要么点开的浮层鼠标一移就没了。
   */
  assert.match(sb, /pinned/, '要区分钉住态与悬停态');
});

test('浮层关闭有兜底：Esc / 点外面 / 滚动', () => {
  const tip = read(path.join(COMP, 'NodeTip.tsx'));
  assert.match(tip, /Escape/, 'Esc 要能关');
  assert.match(tip, /mousedown/, '点浮层外面要能关');
  /*
   * 滚动时锚点失效 —— 用 capture 捕获，
   * 否则侧栏滚动区的滚动事件在冒泡阶段收不到。
   */
  assert.match(tip, /addEventListener\('scroll'[\s\S]{0,40}true\)/, '滚动要用 capture 捕获');
});

/* ================= 大模型参数只留两个框 ================= */

/*
 * 以前每个用到大模型的节点各存一份：服务商、API 地址、模型、API Key、超时。
 * 同一个 key 要填好几遍，换 key 要改好几处，
 * 漏一处表现为"这个节点连的还是旧 key"，且不报错。
 *
 * 现在节点只存「哪个凭据」+「哪个模型」，
 * 地址 / 密钥 / 服务商全在凭据里。
 */
test('大模型面板不再内联填 API Key / 地址 / 服务商', () => {
  const sh = read(path.join(COMP, 'inspectors', 'shared.tsx'));
  /*
   * 匹配"渲染一个输入框绑定 apiKey / baseUrl"这个动作。
   * 不能只查子串 —— 注释里为说明为什么挪走，正好要写这些字段名（假阴性）。
   */
  const inline = /<input[\s\S]{0,400}?\.(apiKey|baseUrl)\b/.test(sh);
  assert.equal(inline, false, '大模型面板又内联填密钥或地址了');
  // 该有的是这两个
  assert.match(sh, /凭据（含 API 地址与密钥）/, '要有凭据选择');
  assert.match(sh, /去凭据中心填写|填写凭据/, '要有去凭据中心填的入口');
});

test('凭据面板能填大模型的地址与模型清单', () => {
  const cp = read(path.join(COMP, 'CredentialPanel.tsx'));
  assert.match(cp, /LLM_META\.baseUrl/, '凭据里要能填 API 地址');
  assert.match(cp, /LLM_META\.models/, '凭据里要能填模型清单');
  // 拉不到时还能手填 —— 只给按钮等于网络一断就没法配
  assert.match(cp, /textarea/, '模型清单要能手填（不能只有拉取按钮）');
});

test('运行时地址与密钥优先取自凭据', () => {
  /*
   * 反过来（节点优先）的话，改凭据的地址不生效，
   * 表现为"改了没反应"，且看不出是节点上那份还在起作用。
   */
  for (const f of ['ocr.ts', 'translate.ts']) {
    const src = read(path.join(ROOT, 'engine', 'runners', f));
    assert.match(src, /resolveLlmFromCredential\(/, `${f} 要从凭据解析配置`);
    assert.match(src, /findCredential\(/, `${f} 要按 credentialId 找凭据`);
  }
});
