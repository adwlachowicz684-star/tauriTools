import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSrc } from './srcScan';
import { isNodeDisabled, nodeDisabledOf } from '../engine/nodeDisabled';
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
  // 徽章文案不受关闭态影响 —— LEVEL_SHORT 必须无条件渲染
  assert.ok(
    /\{LEVEL_SHORT\[dot\]\}/.test(shell),
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
