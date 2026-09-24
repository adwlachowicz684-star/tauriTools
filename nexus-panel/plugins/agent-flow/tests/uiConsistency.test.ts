import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSrc } from './srcScan';
import { isNodeDisabled, nodeDisabledOf } from '../engine/nodeDisabled';
import {
  addVariable, applyVarTo, resolveVars, registerVariableGroup,
} from '../engine/variables';

/** 内存 KV：变量引擎各处都可注入，测试里不必碰 localStorage */
function memKV() {
  const map = new Map<string, string>();
  return { map, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
}
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
  /*
   * 走 badgeTextOf(issue) 而不是直接取 LEVEL_SHORT[dot] ——
   * 红圆点有两种成因（缺参 / 错参），文案必须区分，
   * 否则用户看到「缺参」会以为自己忘了填，于是又填一遍。
   */
  assert.match(shell, /badgeTextOf\(issue\)/, 'NodeShell 要走 badgeTextOf 显示配置状态');
  assert.ok(!/LEVEL_SHORT\[dot\]/.test(shell), '不要直接取表 —— 那样区分不出缺参与错参');
});

/*
 * 「错参」必须是引擎算出来的，不是卡片上硬写的词。
 *
 * 硬写的话，改了判定规则而忘了改文案，徽章会显示「缺参」
 * 而提示行说的是类型不对 —— 两处互相矛盾。
 */
test('错参文案由引擎的 typeError 决定', () => {
  const v = read(path.join(ROOT, 'engine/nodeValidate.ts'));
  assert.match(v, /typeError:\s*true/, '类型错误要标出 typeError');
  assert.match(v, /badgeTextOf/, '要有徽章文案函数');
  assert.match(v, /return '错参'/, '错参文案');
});

test('圆点在徽章里，不在标题行上当独立元素', () => {
  /*
   * 圆点与徽章说的是同一件事。分开摆时圆点像第二个状态 ——
   * warn 的圆点带光环，视觉上比徽章本身还抢眼。
   */
  const shell = read(path.join(COMP, DEFINER));
  const head = shell.slice(shell.indexOf('node-head'), shell.indexOf('node-line--alert'));
  assert.ok(/node-badge[\s\S]{0,400}node-dot/.test(head), '圆点应在徽章内部');
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
  const app = readSrc('App.tsx', 'hooks/useMcpRegistry.ts');
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
  /*
   * id 与显示高度已搬进通用基础信息区（inspectors/NodeBasics）。
   * 只读 Inspector.tsx 的话，搬走后这条守卫会**静默失效** ——
   * 失效的样子是"通过"，比报错更危险。
   */
  const insp = readSrc('components/Inspector.tsx', 'components/inspectors/NodeBasics.tsx');
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
  /*
   * 类名现在是模板字符串（要拼 is-hover），所以不能写
   * `className="node-tip"` —— 那样匹配不上，守卫会**假阴性**。
   * 这里匹配"node-tip 这个类名确实被用上"，不关心拼接方式。
   */
  assert.match(tip, /node-tip/, 'NodeTip 要带上 node-tip 类名');
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
  /*
   * 该有的是这两个。
   *
   * 措辞跟着改名走：「凭据」→「连接」，中心改叫「连接管理器」。
   * 匹配时**不写死**单独一个"连接"二字 —— 画布上还有「连线」，
   * 只查 /连接/ 会把连线的改动也当成这条通过（假阴性）。
   * 所以匹配完整的界面短语。
   */
  assert.match(sh, /连接（含 API 地址与密钥）/, '要有连接选择');
  assert.match(sh, /去连接管理器填写|管理连接/, '要有去连接管理器填的入口');
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

/* ================= 任务记录要存判据 ================= */

/*
 * 比较 / 条件节点只输出 true / false。
 * 任务窗口里看到 `true` 却不知道"拿什么跟什么比出来的"，
 * 流程排查到这一步就断了 —— 输出必须带上判据。
 */
test('运算节点产出判据（不只是裸值）', () => {
  const src = read(path.join(ROOT, 'engine', 'runners', 'ops.ts'));
  assert.match(src, /detail:/, '运算要给出 detail');
  assert.match(src, /function opDetail/, '要有判据构造函数');
});

test('条件节点产出判据（命中哪条 + 依据什么）', () => {
  const src = read(path.join(ROOT, 'engine', 'runners', 'condition.ts'));
  assert.match(src, /detail:/, '条件要给出 detail');
  assert.match(src, /function condDetail/, '要有判据构造函数');
});

test('判据能一路存到任务记录并显示出来', () => {
  // 事件 → 任务状态 → 界面，三处少一处就等于没做
  const rt = read(path.join(ROOT, 'engine', 'runTypes.ts'));
  assert.match(rt, /type: 'node-done'[\s\S]{0,200}?detail\?:/, 'node-done 事件要带 detail');
  const tk = read(path.join(ROOT, 'engine', 'tasks.ts'));
  assert.match(tk, /detail\?: string/, 'TaskNodeState 要有 detail');
  assert.match(tk, /n\.detail\s*=/, 'reduce 要把 detail 存下来');
  const td = read(path.join(ROOT, 'components', 'TaskDetail.tsx'));
  assert.match(td, /n\.detail/, '任务详情要显示 detail');
});

/* ================= 凭据中心有 CLI 模型清单 ================= */

/*
 * CLI 走自己的登录态，不需要密钥 —— 但模型名一样要统一管理：
 * 各处手填一份，改模型时要改好几处，漏一处表现为"这个节点还是旧名字"。
 * 所以给它一条**只存模型清单**的凭据。
 */
test('凭据种类里有 CLI 模型清单（不需要密钥）', () => {
  const cr = read(path.join(ROOT, 'engine', 'credentials.ts'));
  assert.match(cr, /'cli'/, 'CredentialKind 要有 cli');
  assert.match(cr, /function isSecretlessKind/, '要有"不需要密钥"的判断');
});

test('无密钥凭据不要求填密钥、也不去校验', () => {
  /*
   * 这两条少一条，用户点保存就会看到一个"密钥不能为空"或"校验失败"，
   * 而这一栏本来就不需要填 —— 卡在这里根本出不去。
   */
  const cp = read(path.join(ROOT, 'components', 'CredentialPanel.tsx'));
  assert.match(cp, /isSecretlessKind\(editing\.kind\)/, '保存时要按种类区分');
  const store = read(path.join(ROOT, 'engine', 'credentialStore.ts'));
  assert.match(store, /x\.kind === 'cli'/, '落盘时要认 cli 种类（否则读回来变成 generic）');
});

test('CLI 的模型下拉同时列 llm 与 cli 两种凭据', () => {
  const sh = read(path.join(COMP, 'inspectors', 'shared.tsx'));
  const body = sh.slice(sh.indexOf('export function CliModelPanel'));
  const panel = body.slice(0, body.indexOf('\nexport function '));
  assert.match(panel, /kind === 'llm' \|\| x\.kind === 'cli'/, '两种凭据都要能提供模型清单');
});

/* ================= CLI 节点：模型不选手填 ================= */

/*
 * CLI 节点的模型以前是手填 text。模型名长且易拼错，
 * 打错一个字符要等 CLI 跑起来才出错，而 CLI 多半只回一句非零退出，
 * 根本看不出是模型名的问题。
 *
 * 现在与 OCR / 翻译 / HTTP 一致：选凭据 → 从它的模型清单里选。
 */
test('CLI 节点的模型走凭据清单，不再手填', () => {
  const def = read(path.join(ROOT, 'nodes', 'defs', 'task.tsx'));
  assert.match(def, /CliModelPanel/, 'CLI 要用凭据 + 模型那个面板');
  /*
   * 不能再出现手填模型的 text 字段。
   * 匹配的是"声明一个 text 字段且 key 是 model"这个动作 ——
   * 注释里正好要写 key: 'model' 来说明为什么改掉，只查子串会被骗过。
   */
  assert.ok(
    !/type:\s*'text'[\s\S]{0,120}?key:\s*'model'/.test(def),
    'CLI 的模型又变成手填了',
  );
});

test('「手填」是动作不是模型名 —— 哨兵值不得落进 model', () => {
  /*
   * 下拉框里那一项「（手填…）」看起来是个选项，但它只是切换的动作。
   * 直接 onChange 下去的话，节点上就存了个 '__manual__'，
   * 跑的时候 CLI 原样收到它，报错还看不出是这儿来的。
   *
   * 这类"哨兵值泄漏"测试跑不出来 —— 界面看着完全正常。
   */
  const sh = read(path.join(COMP, 'inspectors', 'shared.tsx'));
  assert.match(sh, /export function CliModelPanel/, '要有 CliModelPanel');
  // 拦下来：看到哨兵就 setManual，不走 onChange
  assert.match(sh, /__manual__'\)\s*\{\s*setManual\(true\)/, '哨兵要被拦掉并切到手填态');
  /*
   * 反向：不许把它当普通值写下去。
   * 有人"顺手"改成 onChange({ model: v }) 就会命中这一条。
   */
  const bad = /onChange\(\{[^}]*model:\s*v\s*\}\)/.test(sh)
    && !/__manual__'\)\s*\{\s*setManual\(true\)/.test(sh);
  assert.equal(bad, false, '哨兵值被写进 model 了');
});

test('切到手填后还能切回清单（两个方向都要有）', () => {
  /*
   * 只有「手填」没有「从清单选」的话，用户点进去就出不来了，
   * 而清单才是推荐路径 —— 出不来就只能先取消凭据，那会顺带清掉已选的模型。
   */
  const sh = read(path.join(COMP, 'inspectors', 'shared.tsx'));
  const body = sh.slice(sh.indexOf('export function CliModelPanel'));
  const panel = body.slice(0, body.indexOf('\nexport function '));
  assert.match(panel, /'手填'/, '要有切到手填的入口');
  assert.match(panel, /'从清单选'/, '要有切回清单的入口');
});

/* ================= 反向吸附：动的是被拖节点 ================= */

/*
 * 反向吸附（拖 A 到 B 上方）第一版做反了：
 * 把**对方 B**（和它的整串）挪到 A 下面。
 * 用户拖 A，看到的却是 B 跳走 —— 动的是他没碰的那个。
 *
 * 现在移动的是被拖节点自己，对方原地不动、只改 stackParent。
 * 这条守卫盯住消费端不把 stackParent 的写入挂在"有没有位移"上 ——
 * 对方没有位移，挂上去就永远写不进去，表现为"看着嵌上了但没连"。
 */
test('反向吸附时对方的 stackParent 不受"有没有位移"影响', () => {
  const src = readSrc('App.tsx', 'hooks/useStackLayout.ts');
  assert.ok(
    /if \(isAttachChild && attachParent\) data\.stackParent = attachParent;/.test(src),
    'App.tsx 必须无条件给反向吸附的对方写 stackParent（不能包在 `at &&` 里）',
  );
  // 反向分支不得再给对方生成位移
  assert.ok(
    !/attach:\s*\{\s*childId:[^}]*moves:\s*\[[^\]]+\]/.test(read(path.join(ROOT, 'engine', 'stack.ts'))),
    'engine/stack.ts 的反向吸附不得再给对方生成 moves',
  );
});

/* ================= 关闭的节点 ================= */

/*
 * 关掉的节点仍要显示缺参 / 缺项，只是圆点变灰。
 *
 * 把整个徽章去掉的话，用户重新打开时才发现它其实一直没配好 ——
 * 关掉不等于修好。这里是源码级守卫：
 * "缺什么还能不能看见"这件事跑测试看不出来。
 */
test('关闭的节点仍显示缺项徽章，只把圆点变灰', () => {
  const shell = read(path.join(COMP, DEFINER));
  // 徽章文案不受关闭态影响 —— 必须无条件渲染
  assert.ok(
    /\{badgeTextOf\(issue\)\}/.test(shell),
    '徽章文案必须始终渲染（关掉也要看得见缺什么）',
  );
  // 圆点颜色按关闭态分支，且关闭分支不能复用 level 色
  assert.ok(/OFF_DOT_COLOR/.test(shell), '关闭态要有独立的灰点色');
  assert.ok(
    !/is-off[\s\S]{0,120}level-\$\{dot\}/.test(shell),
    '关闭态不得再挂 level-* 类 —— 那会把"缺参"也说成绿的',
  );
});

/* ================= 撤销删除 ================= */

/*
 * 撤销要连选中态一起恢复。
 *
 * 少了它：撤销后节点回来了，但没一个被选中 ——
 * 用户看着画布"变了又说不清变在哪"，而这是唯一能指出恢复内容的线索。
 *
 * 用 readSrc 同时扫 App 与 hook：撤销栈已抽到 hooks/ 下，
 * 只盯一处会在搬走后假通过。
 */
test('撤销删除要恢复选中态', () => {
  const src = readSrc('App.tsx', 'hooks/useDeleteUndo.ts');
  assert.ok(
    /setSelectedId\(undoSnap\.selectedId\)/.test(src),
    '撤销时要恢复 snapshot 里的 selectedId',
  );
});

/*
 * 换画布要清掉撤销栈。
 *
 * 快照里是**上一张画布**的节点与边。不清的话在 B 画布按 Ctrl+Z
 * 会把 A 画布的内容整片恢复过来 —— 用户什么都没删，画布却变了。
 */
test('换画布清空撤销栈', () => {
  const src = readSrc('App.tsx', 'hooks/useDeleteUndo.ts');
  assert.ok(/clearUndo\(\)/.test(src), '换画布时要 clearUndo()');
});

/*
 * 工具栏不再放那一排编辑按钮：
 *   + 任务 / + 条件 / + 并发 / + 触发器 / 删除 / 撤销 / 停止
 *
 * 每一个都与别处重复：
 *   添加 → 侧栏拖拽（或 Ctrl+单击）  删除 → Delete / Backspace
 *   撤销 → Ctrl / Cmd + Z            停止 → 任务详情页
 * 重复入口会互相打架，而"运行工作流"更是直接绕过触发器。
 *
 * 盯源码是因为：这类改动被上游整份覆盖带回来时**不会有任何报错**，
 * 界面上只是多了一排按钮 —— 和之前红点呼吸动画被冲掉是同一类事。
 */
test('工具栏不再有重复的编辑按钮', () => {
  const src = readSrc('App.tsx');
  for (const pat of [
    '>+ 任务<',
    '>+ 条件<',
    '>+ 并发<',
    '>+ 触发器<',
    '↩ 撤销',
    'onClick={addTask}',
    'onClick={deleteSelected}',
  ]) {
    assert.ok(!src.includes(pat), `工具栏不该再有 ${pat}`);
  }
  assert.ok(!/运行工作流/.test(src), '工具栏不该再有「运行工作流」按钮');
});

/*
 * 「外观」开关已从工具栏挪到右侧设置页。
 *
 * 为什么必须挪：默认主题（Agent Flow 深色）的变量值与原生层**逐像素相同**，
 * 所以不选换主题的话，两个选项在界面上长得一模一样。
 * 它摆在工具栏里的样子就是一个**永远拨不动的开关** ——
 * 用户只会得出"这个功能废了"的结论，而实际上它没坏，
 * 只是默认两套值恰好相等。设置页里写了这句说明。
 *
 * 顺带：它属于整个插件、不属于某张画布，跟工具栏上那些
 * "本次运行怎么跑"的东西也不是一类。
 *
 * 盯源码同样是防上游整份覆盖把它带回工具栏。
 */
test('外观开关在设置页，不在工具栏', () => {
  const src = readSrc('App.tsx');
  /*
   * 不能只判"App 里没有 外观 两个字" —— 设置页的说明文案里也有。
   * 要盯的是**工具栏那个 select**：它绑的是 themeMode。
   */
  const toolbar = src.slice(src.indexOf('className="toolbar"'), src.indexOf('className="af-body-row"'));
  assert.ok(
    !/themeMode/.test(toolbar),
    '工具栏不该再有外观下拉框（它已挪到设置页）',
  );

  const cfg = readSrc('components/inspectors/CanvasConfigPanel.tsx');
  assert.ok(
    /外观/.test(cfg) && /onThemeModeChange/.test(cfg),
    '设置页要提供外观开关',
  );
  /*
   * 说明必须跟着一起在 —— 缺了它，用户换到设置页看到的仍是一个
   * "拨了没反应"的开关，等于把困惑从一个地方搬到另一个地方。
   */
  assert.ok(
    /默认主题下两个选项观感相同/.test(cfg),
    '设置页要说明"默认主题下两个选项观感相同"，否则仍会被当成坏了',
  );
});

/*
 * 撤销要有**可见**入口。
 *
 * 工具栏按钮拿掉之后，唯一的回头路是 Ctrl+Z —— 而没人会猜到有这个。
 * 所以删完弹的那条提示上必须能直接撤销，否则"撤销删除"等于失联。
 */
test('删除提示条要给撤销入口', () => {
  const src = readSrc('App.tsx');
  assert.ok(
    /undoSnap \?[\s\S]{0,240}撤销/.test(src),
    '删除提示条上要按 undoSnap 给一个「撤销」按钮',
  );
});

/* ================= 导出目录 ================= */

/*
 * 申请授权后必须**回读**一次确认真的加进去了。
 *
 * Linux 的 Secret Service 就是这类"接受写入但读不出来"的典型，
 * 目录授权同理：调用成功 ≠ 生效。
 * 少了回读，失败会伪装成成功，用户拿到的是一句"导出失败：路径越权"，
 * 而真正的原因（目录不存在 / 不允许授权 / 加进去没生效）全被藏了。
 */
test('授权目录后回读校验', () => {
  const src = readSrc('App.tsx', 'hooks/useExportFlow.ts');
  /*
   * 数**次数**而不是配一条宽松的正则 ——
   * 第一次 listFsRoots（写之前看在不在授权列表里）与回读那次写法几乎一样，
   * 用 `/roots = await listFsRoots()[\s\S]{0,200}withinRoots/` 的话，
   * 把回读删掉仍然会被**前面那次**匹配上（假阴性）。
   * 故障注入时正是这么骗过去的。
   */
  const n = (src.match(/await listFsRoots\(\)/g) ?? []).length;
  assert.ok(n >= 2, `授权后要回读一次 listFsRoots（当前只有 ${n} 处）`);
});

/*
 * 导出失败必须报出来。
 *
 * 以前这里是空的 catch（注释说"退回剪贴板"但没实现），
 * 下载被拦时日志照样打印"✅ 已导出" —— 失败伪装成成功。
 */
test('导出的失败分支都要写日志', () => {
  const src = readSrc('App.tsx', 'hooks/useExportFlow.ts');
  assert.ok(
    /catch \(e\)[\s\S]{0,200}onLog\(`✗ 导出失败/.test(src)
      || /catch \(e\)[\s\S]{0,200}pushLog\(`✗ 导出失败/.test(src),
    '导出失败的 catch 里必须写日志，不能空着',
  );
});

/*
 * 工具栏「导出」不能再自己拼 <a download>。
 *
 * 那是这次"点了没反应"的根因：Tauri 的 webview 不接管下载，
 * 而这条路径**连日志都不打** —— 成功失败都安静，
 * 用户只能说"导出无效"，无从判断是没跑还是跑到哪一步。
 *
 * 现在必须与脚本 / 说明导出共用同一条写盘路径（exportText）。
 */
test('导出走统一写盘，不再自拼下载', () => {
  const app = readSrc('App.tsx');
  assert.ok(
    !/createObjectURL/.test(app),
    'App.tsx 不该再有 createObjectURL —— 导出要走 exportText 统一写盘',
  );
  assert.ok(
    /exportText\(/.test(app),
    '工具栏导出要调用 exportText',
  );
  const hook = readSrc('hooks/useExportFlow.ts');
  assert.ok(
    /exportText/.test(hook) && /startWrite/.test(hook),
    'useExportFlow 要提供 exportText 并接到统一入口上',
  );
});

/*
 * 下载兜底的两个细节，少一个都是"点了没反应"。
 *
 * 同步 revoke 尤其隐蔽：click() 只是派发事件，真正取流是异步的，
 * URL 提前作废 → 下载直接消失，而 try/catch 抓不到（它是"成功"的）。
 */
test('下载兜底要挂进文档并延后 revoke', () => {
  const src = readSrc('hooks/useExportFlow.ts');
  assert.ok(
    /appendChild\(a\)/.test(src),
    'a 要挂进文档再 click —— 游离元素的 click() 在部分内核上不触发下载',
  );
  assert.ok(
    /setTimeout\(\(\) => URL\.revokeObjectURL/.test(src),
    'revoke 必须延后，同步 revoke 会把下载直接作废',
  );
});

/*
 * 回读发现"授权没生效"要明说。
 *
 * 少了这句：失败会伪装成成功，用户拿到的是笼统的"路径越权"，
 * 而真正的原因（目录不存在 / 不允许授权 / 加进去没生效）全被藏了 ——
 * 排查只能靠猜。
 */
test('授权没生效要说清，不能笼统报路径越权', () => {
  const src = readSrc('App.tsx', 'hooks/useExportFlow.ts');
  assert.ok(
    /仍不在授权列表里/.test(src),
    '回读失败时要明说"已提交但仍不在授权列表里"',
  );
});

/* ================= 基础信息区通用化 ================= */

/*
 * 名称只能有一处来源。
 *
 * 以前条件 / 循环 / 并发 / 触发器 / 字段型面板各写一份「节点名称」输入，
 * 加上分发器里那几行，一共五处。漏改一处不报错，只是那个节点的
 * 面板顶部与别人不一样。
 *
 * 用 readSrc 同时扫五个文件：少了谁都不行。
 */
test('节点名称只在通用基础信息区里渲染', () => {
  for (const f of [
    'components/inspectors/ConditionInspector.tsx',
    'components/inspectors/LoopInspector.tsx',
    'components/inspectors/ParallelInspector.tsx',
    'components/inspectors/TriggerInspector.tsx',
    'components/inspectors/fields.tsx',
  ]) {
    const src = readSrc(f);
    /*
     * 不能只查"文件里含 节点名称" —— 为说明为什么挪走，
     * 注释里正好要把这四个字原样写出来（假阴性）。
     * 用 stripComments 剥掉注释再查真正的渲染动作。
     */
    const bare = stripComments(src);
    assert.ok(
      !/节点名称/.test(bare),
      `${f} 又自己渲染了「节点名称」—— 应统一走 NodeBasics`,
    );
  }
  const basics = readSrc('components/inspectors/NodeBasics.tsx');
  assert.match(basics, /title-input/, '通用基础信息区要渲染名称输入框');
});

/*
 * 关闭开关必须认老字段。
 *
 * 触发器历史上另有一个节点级 `enabled`。若 isNodeDisabled 只认 `disabled`，
 * 老存档里 enabled:false 的触发器在通用开关上显示"开启"，
 * 而卡片上仍写着"已停用" —— 一份内容两个说法。
 */
test('关闭开关认触发器老字段 enabled', () => {
  /*
   * 用**行为**断言而不是扫源码。
   *
   * isNodeDisabled 与 nodeDisabledOf 两处写法几乎一样，
   * 只查"文件里含 enabled === false"的话，改坏其中一处
   * 仍会被另一处匹配上（假阴性）—— 故障注入时正是这么骗过去的。
   */
  assert.equal(isNodeDisabled({ data: { enabled: false } }), true, '老字段 enabled:false 要算关闭');
  assert.equal(isNodeDisabled({ data: { disabled: true } }), true, 'disabled:true 要算关闭');
  assert.equal(isNodeDisabled({ data: {} }), false, '没这两个字段就是开着');
  assert.equal(isNodeDisabled({ data: { enabled: undefined } }), false, 'undefined 不能当关闭');
  assert.equal(nodeDisabledOf({ enabled: false }), true, 'nodeDisabledOf 同样要认老字段');
});

/*
 * 启用/停用口径一律 `=== false`，不写 `!x`。
 *
 * 老存档没有 enabled 字段，取到 undefined —— `!undefined` 为真，
 * 于是好端端的触发器显示"已停用"，而属性面板那个勾选框
 * （用的是 !== false）仍显示勾选。这是用户报的"手动触发显示停用"的根因。
 */
test('触发器启用判定不用 !enabled', () => {
  const src = readSrc('components/TriggerNode.tsx', 'engine/nodeValidate.ts');
  const bare = stripComments(src);
  assert.ok(
    !/!d\.enabled/.test(bare),
    '启用判定不能写 !d.enabled —— undefined 会被当成停用',
  );
});

/* ================= 变量（原「参数卡片」）================= */

/*
 * 引用期间节点上**不存**那组字段的值。
 *
 * 留着就变成"第二份值"：改了变量，一部分地方读到新值、
 * 一部分读到节点上的旧值，表现为"改了有时候生效有时候不生效"。
 */
test('引用变量后节点上不再存该组字段的值', () => {
  registerVariableGroup({
    group: 'guard-repo', label: '守卫用', keys: ['owner', 'repo'],
    summary: () => '', validate: () => null,
  });
  const kv = memKV();
  const v = addVariable({ group: 'guard-repo', name: 'R', values: { owner: 'a', repo: 'b' } }, kv);
  const patch = applyVarTo({ label: 'A' }, v);
  assert.equal('owner' in patch, true, '必须显式把旧值清掉，不然节点上留着第二份值');
  assert.equal(patch.owner, undefined);
  // 但解析要能拿回来
  assert.equal(resolveVars({ ...patch }, kv).owner, 'a');
});

/*
 * 改字段要转投到变量本身。
 *
 * 不转投的话，在任一节点上改一下（旧逻辑是"改了就脱钩"），
 * 想让 5 个节点共用一个仓库地址就散了 —— 变量形同虚设。
 */
test('改字段会转投到变量本身（Inspector 统一做）', () => {
  const insp = readSrc('components/Inspector.tsx');
  /*
   * 必须匹配**调用**，不能只查"文件里含 redirectVarPatch"——
   * import 行里也有这个名字，把调用删掉照样通过（假阴性，已踩到）。
   */
  assert.match(insp, /redirectVarPatch\(node\.data/, 'Inspector 要用 redirectVarPatch 转投');
  assert.match(insp, /patchVariableValues\(/, '转投后要真的写进变量');
  // 面板拿到的数据必须是解析后的，否则输入框是空的
  assert.match(insp, /resolveVars\(node\.data\)/, '面板显示前要先解析变量');
});

/*
 * 执行前必须解析。
 *
 * 不解析：GitHub 节点读到空仓库名、HTTP 节点读到空地址，
 * 而用户明明选了变量 —— 只会以为变量功能坏了。
 */
test('执行前解析变量', () => {
  const r = readSrc('engine/runner.ts');
  // 同上：import 里也有 resolveVars，只查名字会被骗过去
  assert.match(r, /resolveVars\(n\.data\)/, 'runGraph 执行前要解析变量');
});

/*
 * 校验前也要解析，否则"引用了变量"会被判成"参数没填"。
 */
test('校验前解析变量', () => {
  const sh = readSrc('components/NodeShell.tsx');
  assert.match(sh, /validateNode\(\{ data: resolveVars\(/, 'NodeShell 校验前要解析变量');
});

/*
 * 三档显示：简不显示 / 标显示名字 / 详显示内容。
 */
test('变量卡扣按显示高度分三档', () => {
  const c = readSrc('components/NodeVarChips.tsx');
  assert.match(c, /size === 'sm'/, '简档不显示');
  assert.match(c, /size === 'lg'/, '详档显示内容');
  // 详档的文本必须限高，否则一个长值能把整张画布顶开
  const css = read(path.join(ROOT, 'styles.css'));
  assert.match(css, /\.node-chip-v[\s\S]{0,200}line-clamp/, '详档文本要限制行数');
});

test('变量作用域：默认画布级，全局要显式打开', () => {
  const v = readSrc('engine/variables.ts');
  assert.match(v, /global === true/, 'global 必须显式为真才算全局（缺省即画布级）');
  // 选择器上要有切换开关
  const p = readSrc('components/inspectors/VariablePicker.tsx');
  assert.match(p, /setVariableGlobal/, '变量上要有全局开关');
});

/* ================= 预设参数 = 卡片 ================= */
/*
 * 节点自带的参数（脚本内容、分支、地址……）也套卡片壳，
 * 与「触发条件卡」「变量卡」同一种长相。
 *
 * 「预设不能增删」是行为不是长相：这里没有 ＋ / × 按钮。
 * 刻意不加"预设"角标 —— 每个参数挂一个只会变成噪音。
 */
test('预设参数套卡片壳（与触发卡、变量卡同一套描边/圆角/底色）', () => {
  const css = read(path.join(ROOT, 'styles.css'));
  assert.match(
    css,
    /\.inspector \.field \{[^}]*border:/,
    '.inspector .field 要有描边 —— 预设参数是一张卡片，不是三行裸排',
  );
  assert.match(
    css,
    /\.inspector \.field \{[^}]*border-radius:/,
    '.inspector .field 要有圆角',
  );
});

/*
 * 卡里再画一圈描边会变成俄罗斯套娃。
 * 触发卡内部（.trig-card）与 row2 里的字段都该复位。
 */
test('卡片里的字段不重复套壳', () => {
  const css = read(path.join(ROOT, 'styles.css'));
  assert.match(
    css,
    /\.inspector \.trig-card \.field \{[^}]*border:\s*0/,
    '触发卡内部的字段要复位，否则卡里套卡',
  );
});

/* ================= 流程图上的变量标注 ================= */
/*
 * 节点框上只显示名字（框窄），点开浮层才摊开「名字 = 值」。
 * 两种布局（画布坐标 / 分层网格）都得有 ——
 * 只做一种的话，切一下视图标注就消失了，看着像坏了。
 */
test('流程图两种布局都标变量', () => {
  const d = readSrc('components/TaskDetail.tsx');
  const hits = d.match(/<FlowVars /g) ?? [];
  assert.ok(hits.length >= 3, `FlowVars 至少要出现 3 次（两种布局 + 浮层），实际 ${hits.length}`);
  assert.match(d, /<FlowVars vars=\{b\.vars\} full \/>/, '浮层里要摊开显示');
});

test('流程图的变量标注存名字不存 id（历史不随变量改名而消失）', () => {
  const v = readSrc('engine/variables.ts');
  assert.match(v, /export function varSnapshotOf/, '要有快照函数');
  assert.doesNotMatch(
    v,
    /varSnapshotOf[\s\S]{0,400}id:/,
    '快照里不该存变量 id —— 变量删掉后老流程图会变空白',
  );
});

/* ================= 顶层视图只剩两个 ================= */

/*
 * 历史并进了任务视图的「已完成」子标签。
 *
 * 它原本占着一个与流程平级的位置，而它与任务的区别只是"跑完没跑完" ——
 * 找一条刚跑完的记录要先想"它现在算任务还是算历史"。
 */
test('不再有顶层「历史」入口', () => {
  const app = readSrc('App.tsx');
  assert.ok(!/setView\('history'\)/.test(app), '又出现顶层历史视图');
  assert.ok(!/view === 'history'/.test(app), '又出现历史视图分支');
});

test('任务视图有自己的两个子标签（与流程的三个库同一套切法）', () => {
  const app = readSrc('App.tsx');
  assert.match(app, /leftTabsFor\(view\)/, '左栏标签要走同一套取法');
  assert.match(app, /TASK_TAB_LABEL/, '任务子标签要有中文名');
  assert.match(app, /setTaskTabRaw/, '子标签要能切');
});

/* ================= 属性面板两段的左右留白 ================= */

/*
 * 基础信息区（.insp-basics）与参数区（.inspector）是**兄弟容器**：
 * 前者不滚动、后者自己滚动，所以留白只能各写各的。
 *
 * 但两段必须对齐 —— 否则基础信息贴着面板边缘、参数卡片却缩进去，
 * 上下看着像两块不同的界面拼起来。
 *
 * 这类问题测试跑不出来（样式不影响逻辑），且改一处忘另一处不报错，
 * 只能靠源码级守卫盯着。历史上这条被上游整份覆盖 styles.css 冲掉过一次。
 */
test('属性面板两段共用同一个左右内边距变量', () => {
  const css = readSrc('styles.css');

  // 变量必须**真的定义过** —— 只写 var(--x, 兜底) 而不定义，
  // 是靠兜底生效的幽灵引用（改变量值不会有任何反应）。
  assert.match(css, /--af-insp-pad:\s*\d/, '--af-insp-pad 要有真实定义，不能只靠兜底');

  const basics = /\.insp-basics\s*\{([^}]*)\}/.exec(css);
  assert.ok(basics, '找不到 .insp-basics 的定义');
  assert.match(basics[1], /padding:\s*0\s+var\(--af-insp-pad/, '.insp-basics 要有横向内边距，且走同一变量');

  const insp = /\.inspector\s*\{([^}]*)\}/.exec(css);
  assert.ok(insp, '找不到 .inspector 的定义');
  assert.match(insp[1], /padding:\s*var\(--af-insp-pad/, '.inspector 要引用同一变量');
});

/*
 * 只给一段加内边距是最典型的改坏方式：
 * 界面看着"已经修好了"（改的那一段确实缩进了），另一段照旧贴边。
 * 所以两段都要断言，缺任一段都得红。
 */
test('两段都真的有留白（不能只改一段）', () => {
  const css = readSrc('styles.css');
  assert.match(css, /\.insp-basics\s*\{[^}]*padding:/, '.insp-basics 缺内边距');
  assert.match(css, /\.inspector\s*\{[^}]*padding:/, '.inspector 缺内边距');
});

/* ============ CSS 变量必须真的能解析（不许静默失效） ============ */

/*
 * ================= 症状 =================
 *
 * 「代码改对了、界面看不出来」：精心调的字号没变、参数下凹只有极弱底色差
 * 看着像不存在、胶囊圆角成了直角 —— 而 grep 类名、查组件接线全都正常。
 *
 * ================= 根因 =================
 *
 * 本文件引用 --fs-note / --fs-body / --sh-in-sm / --r-pill / --ctl-* 等外壳
 * 令牌，它们定义在 css/tokens.css 与 css/controls.css。
 *
 * CSS 规范：var() 引用未定义变量且无兜底 → 该声明在计算值时无效 →
 * 属性退化为初始值（font-size 走继承、box-shadow:none、border-radius:0）。
 * 不报错、不告警，界面只是「看起来没改」。
 *
 * ================= 检查口径（修订过一次） =================
 *
 * 只算**运行时真正加载**的 CSS，而且必须**跟随 @import 展开** ——
 * 本文件第 6~11 行 @import 了 tokens / controls / dialog 三份，
 * neumorphism.css 第 84~88 行同样 @import 了它们。
 *
 * 上一版只把这两个文件的**文本**拼起来扫，不跟 @import，于是把
 * "通过 @import 拿到"误判成"没定义"，报出 19 个并不存在的幽灵变量，
 * 并据此在 main.tsx 多加了一次 tokens.css 的 import（已还原）。
 * **不跟 @import 的扫描比不扫描更糟：它给出的是确定的错误答案。**
 *
 * 带兜底的 var(--x, 值) 放行：失败也有值可用（如 --edge → transparent）。
 * 主题引擎运行时推的变量（--sh-dark / --bg / --text-mute …）由
 * js/theme-manager.js 写到 :root，不在任何 CSS 文件里，同样不算幽灵。
 */
test('agent-flow 的 CSS 变量在运行时加载集里都有定义（无兜底者）', () => {
  const panelRoot = path.join(ROOT, '..', '..'); // nexus-panel/
  /** 跟随 @import 展开 —— 先剥注释，注释里的 @import 不是导入 */
  const expand = (rel: string, seen = new Set<string>()): string => {
    const abs = path.join(panelRoot, rel);
    if (seen.has(abs) || !fs.existsSync(abs)) return '';
    seen.add(abs);
    const src = stripCssComments(fs.readFileSync(abs, 'utf-8'));
    let out = src + '\n';
    for (const m of src.matchAll(/@import\s+url\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      out += expand(path.join(path.dirname(rel), m[1]), seen);
    }
    return out;
  };
  const loaded = ['css/neumorphism.css', 'plugins/agent-flow/styles.css'].map((r) => expand(r));
  assert.ok(loaded.some((x) => x.length > 0), '读不到运行时 CSS，检查口径失效');

  /** 由 js/theme-manager.js 运行时写到 :root，不在任何 CSS 文件里 */
  const THEME_PUSHED = new Set([
    '--accent', '--accent-glow', '--badge-fg', '--bg', '--bg-image', '--blur',
    '--border', '--danger', '--divider', '--edge', '--hairline', '--mask',
    '--ok', '--r-lg', '--r-md', '--r-sm', '--r-xl', '--running', '--scroll-thumb',
    '--sh-dark', '--sh-light', '--surface', '--surface-overlay', '--surface-raised',
    '--surface-sunk', '--text', '--text-dim', '--text-mute', '--text-soft', '--warn',
  ]);

  const defined = new Set<string>();
  for (const c of loaded) {
    for (const m of c.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  }

  const css = readSrc('styles.css');
  const bad = new Set<string>();
  // 只抓**无兜底**的引用：var(--x) 后紧跟右括号
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
    if (!defined.has(m[1]) && !THEME_PUSHED.has(m[1])) bad.add(m[1]);
  }
  assert.deepEqual(
    [...bad], [],
    '这些变量运行时未定义 → 对应声明整条失效（界面看着像没改）：' + [...bad].join(', '),
  );
});

/*
 * 反过来也要盯：上面那条靠"变量能解析"通过，而能解析的前提是
 * **tokens.css / controls.css 真的被引入**。删掉某条 @import，
 * 变量照样能解析（另一处还引着），换个加载顺序才废。
 *
 * 以前这条断言的是"styles.css 里必须本地补一份定义"—— 那恰恰是错的：
 * 本地补一份会**盖掉** @import 进来的同名令牌（同为 :root，文档顺序靠后者胜），
 * 上游改令牌时 agent-flow 不跟着变（--title-*-fw 已经踩过一次）。
 */
test('外壳令牌靠 @import 拿到，而不是本地重复定义', () => {
  const css = readSrc('styles.css');
  assert.match(css, /@import\s+url\(['"]\.\.\/\.\.\/css\/tokens\.css['"]\)/,
    'styles.css 必须 @import tokens.css');
  assert.match(css, /@import\s+url\(['"]\.\.\/\.\.\/css\/controls\.css['"]\)/,
    'styles.css 必须 @import controls.css');
});

/** 剥 CSS 注释：块注释与整行注释都要剥，否则注释里的类名/变量会被当成真引用 */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function re_escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/* ================= 任务流程图要撑到界面底端 ================= */

/*
 * .task-flow-canvas 的高度曾经是内联写死的 Math.min(svgH + 8, 460)。
 *
 * svgH 由节点坐标的包围盒算出：只有两三个节点、或节点都排在同一行时，
 * 它只有一百多像素 —— 画布就那么高，下面一大片空白。
 * 而"流程本来就小"和"窗口没给够地方"在界面上长得一样，
 * 于是看起来像"任务窗口特别小"。
 *
 * 改法是让外层参与 flex 分配、canvas 自己撑满并滚动。
 * 这里盯的是**两端都要改**：只写 CSS 不改组件（内联 style 优先级更高，
 * 会一直压着 CSS），或者只改组件不写 CSS，都会白改。
 */
test('任务流程图不再写死高度（撑到界面底端）', () => {
  const td = read(path.join(COMP, 'TaskDetail.tsx'));
  assert.doesNotMatch(td, /task-flow-canvas[^>]*style=/,
    'task-flow-canvas 还带着内联 style —— 内联优先级高于 CSS，撑不满');
  assert.doesNotMatch(td, /Math\.min\(\s*svgH/,
    'TaskDetail 还在按 svgH 限高（460）—— 节点少时画布只有一百多像素');

  const css = stripCssComments(readSrc('styles.css'));
  const m = css.match(/\.task-flow-canvas\s*\{([^}]*)\}/);
  assert.ok(m, 'styles.css 里没有 .task-flow-canvas');
  assert.match(m[1], /flex:\s*1/, '.task-flow-canvas 必须 flex:1 才能撑满剩余高度');
  assert.match(m[1], /min-height:\s*0/,
    '.task-flow-canvas 缺 min-height:0 —— flex item 默认 min-height:auto，'
    + '内容高时会把父级撑爆而不是在自己内部滚动');

  /* 外层不参与分配的话，剩余空间归 .task-detail，canvas 仍撑不到底端 */
  assert.match(css, /\.task-flow--fill\s*\{[^}]*flex:\s*1/,
    '.task-flow--fill 必须 flex:1（否则 .task-flow 按内容高度排，下面仍是空白）');
  assert.match(td, /className=\{?"task-flow task-flow--fill"/,
    '画布模式的流程图没挂 task-flow--fill —— CSS 写了也不会生效');
});

/* ================= 常量：三种预设，不是一个节点上的下拉框 ================= */

/*
 * 三种常量（文本 / 数字 / 布尔）必须是**三个侧栏预设**。
 *
 * 做成一个节点上的下拉框的话，拖进来的永远是"文本常量"，
 * 想用布尔得先拖进来、再点开面板、再改一项 —— 三步，
 * 而前两步看到的东西（侧栏名、卡片标题）都是错的。
 *
 * 更关键的是：三种常量**产出的值种类不同**（num / bool / text），
 * 不分开就无法参与参数类型校验 —— 数字常量接到「大于」上才合法。
 */
test('常量展开成三种预设（文本/数字/布尔）', () => {
  const def = read(path.join(ROOT, 'nodes', 'defs', 'const.ts'));
  assert.match(def, /presets:/, 'const 没有 presets —— 三种常量在侧栏选不到');
  for (const vt of ['text', 'num', 'bool']) {
    assert.match(def, new RegExp(`'${vt}'`), `预设里没有 ${vt} 常量`);
  }
  /* 产出种类必须按 valueType 走，否则数字常量会被当成文本 */
  const pl = read(path.join(ROOT, 'engine', 'paramLinks.ts'));
  assert.match(pl, /case 'const'/, 'producesArgOf 不认 const —— 三种常量产出同一个种类');
  assert.match(pl, /valueType/, 'producesArgOf 不读 valueType —— 数字常量会被判成文本');
});

/* ================= 输出端口：参数连线从输出卡片拖出 ================= */

/*
 * 以前参数连线的源端是节点右侧那个总出口（裸 'out'），
 * 而它同时是**流程出口**（"我跑完接着跑你"）。
 *
 * 兼用的后果：从它拖到参数格到底是"取个值"还是"接着跑"，
 * 只能靠目标端猜 —— 猜错就是"只想取个值却多出一条执行路径"。
 *
 * 现在输出侧与输入侧对称（out:key ↔ arg:key），
 * 两端都要盯：只改判定不改卡片（没有口子可拖），
 * 或只改卡片不改判定（拖出来画成流程线），都是白改。
 */
test('参数连线走输出端口，流程出口不再兼作参数出口', () => {
  const pl = read(path.join(ROOT, 'engine', 'paramLinks.ts'));
  /* 裸 'out' 必须判成"不是输出端口" */
  const body = pl.slice(pl.indexOf('export function parseOutHandle'));
  assert.match(body.slice(0, 600), /h === OUT_HANDLE\) return null/,
    'parseOutHandle 仍把裸 out 当成输出端口 —— 流程出口会兼作参数出口');

  /* 卡片上必须有 out:xxx 端口可拖 */
  const shell = read(path.join(COMP, 'NodeShell.tsx'));
  assert.match(shell, /outHandleId\(key\)/, '输出卡片上没有输出端口 —— 没有口子可拖');
  assert.match(shell, /outputsOf\(/, '输出端口清单没接上 —— 多输出将来无处登记');

  /* 渲染前必须补老线的 handle，否则"线看不见、值却是对的" */
  const app = read(path.join(ROOT, 'App.tsx'));
  assert.match(app, /normalizeParamEdges\(edges\)/,
    'App 没有规范化参数连线的 handle —— 升级前的线会画不出来');
});

test('输出端口的类名在 styles.css 里有定义', () => {
  const css = stripCssComments(readSrc('styles.css'));
  for (const c of ['node-outs', 'node-out-port', 'node-out-handle']) {
    assert.ok(css.includes(`.${c}`), `styles.css 里没有 .${c} —— 端口画不出来或没有落点`);
  }
});
