import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSrc } from './srcScan';
import path from 'node:path';

/*
 * 源码级守卫：卡片信息行的类名。
 *
 * ================= 为什么需要这条 =================
 *
 * 这类问题**测试跑不出来**（样式不影响逻辑），界面上也只是"有点怪"，
 * 没人会立刻想到是类名没定义。只有从源码扫一遍能逮到。
 *
 * 起因：.node-brief 被 4 张卡片用了，styles.css 里却根本没有定义 ——
 * 于是那几张卡片的摘要行是裸文本，长内容还会把卡片撑破。
 * 根因是同类信息分裂成两套名字（node-brief / node-sub），
 * 名字之间看不出是一类东西，其中一套就被整个忘掉了。
 */

/*
 * 与 uiConsistency.test.ts 同一套路：源码不在测试目录里，
 * 靠 AF_SRC 指过去；没设就跳过（而不是失败）——
 * 否则在没带源码的环境里跑，每条都会因为"读不到文件"而红，
 * 那是假失败，会掩盖真问题。
 */
/*
 * 刻意**不用** __dirname 兜底：strip 成 ESM 后 __dirname 不存在，
 * 一引用就 ReferenceError。没给 AF_SRC 就整体跳过（而不是崩）——
 * 在没带源码的环境里崩掉是假失败，会掩盖真问题。
 */
const ROOT = process.env.AF_SRC || '';

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 注释里为了说明"为什么不能这么写"，正好会把坏写法原样写出来 —— 不剥掉说明本身就会让检查永远失败 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

function read(p: string): string {
  return stripComments(fs.readFileSync(p, 'utf-8'));
}

/**
 * CSS 里出现过的类名（含 .a, .b 这种并列定义）。
 *
 * 必须先剥注释 —— 注释里为说明"为什么这么改"会把类名原样写出来，
 * 不剥的话**把定义删掉后检查依然通过**（假阴性）。
 */
function cssClasses(css: string): Set<string> {
  const set = new Set<string>();
  for (const m of stripComments(css).matchAll(/\.([a-zA-Z][\w-]*)/g)) set.add(m[1]);
  return set;
}

/** 外壳提供的类名（nx- 前缀等），插件自己不定义 */
const EXTERNAL = /^nx-/;
/** 模板字符串拼出来的前缀：真正的值运行时才知道 */
const DYNAMIC = /^(badge|level|size|status|st|has)-?$|^is-/;

function usedClasses(src: string): Set<string> {
  const set = new Set<string>();
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    // 去掉 ${expr} 再按空白切分，剩下的就是字面量类名
    const cleaned = raw.replace(/\$\{[^}]*\}/g, ' ');
    for (const c of cleaned.split(/\s+/)) {
      if (/^[a-zA-Z][\w-]*$/.test(c)) set.add(c);
    }
  }
  return set;
}

function sources(): string[] {
  if (!ROOT) return [];
  return [...walk(path.join(ROOT, 'components')), ...walk(path.join(ROOT, 'nodes'))];
}

const cssPath = ROOT ? path.join(ROOT, 'styles.css') : '';
const hasSrc = cssPath !== '' && fs.existsSync(cssPath);
const css = hasSrc ? fs.readFileSync(cssPath, 'utf-8') : '';
const defined = cssClasses(css);

test('组件里用到的类名都在 styles.css 里有定义', () => {
  if (!hasSrc) return;
  const missing: string[] = [];
  for (const f of sources()) {
    for (const c of usedClasses(read(f))) {
      if (defined.has(c)) continue;
      if (EXTERNAL.test(c)) continue;
      if (DYNAMIC.test(c)) continue;
      missing.push(`${path.relative(ROOT, f)} → .${c}`);
    }
  }
  assert.deepEqual(missing, [], `这些类名没有样式定义：\n${missing.join('\n')}`);
});

/* ================= 统一后旧名字不能回来 ================= */

/**
 * 卡片信息行已统一到 node-line 一族（块 + --变体 + __零件），
 * 旧名字之间看不出是一类东西，留着任何一个都可能被新代码抄回去 ——
 * 而抄回去不报错，只是又多一套平行的类名。
 */
const LEGACY = [
  'node-brief', 'node-sub', 'fs-summary', 'fs-path', 'fs-op', 'fs-arrow', 'fs-flag',
  'node-prompt', 'node-model', 'node-meta', 'node-out', 'node-err', 'node-cli',
  'node-files', 'node-files-badge', 'node-tag', 'node-kind', 'node-alert',
];

test('卡片信息行的旧类名不再出现', () => {
  if (!hasSrc) return;
  const bad: string[] = [];
  for (const f of sources()) {
    const src = read(f);
    for (const old of LEGACY) {
      // 只认出现在 className 字符串里的（"x" 或 `x ` 或 `x`），避免误伤无关文本
      if (src.includes(`"${old}"`) || src.includes(` ${old} `) || src.includes(` ${old}\``)) {
        bad.push(`${path.relative(ROOT, f)} → ${old}`);
      }
    }
  }
  assert.deepEqual(bad, [], `这些旧类名已统一成 node-line 一族：\n${bad.join('\n')}`);
});

/* ================= 新体系自身 ================= */

/** 摘要行缺了这三样，长内容会把卡片撑破 */
test('.node-line--brief 有定义且能单行截断', () => {
  if (!hasSrc) return;
  const m = css.match(/\.node-line--brief\s*\{[^}]*\}/);
  assert.ok(m, '.node-line--brief 必须有样式定义');
  assert.ok(m[0].includes('overflow: hidden'), '缺 overflow: hidden');
  assert.ok(m[0].includes('text-overflow: ellipsis'), '缺 text-overflow');
  assert.ok(m[0].includes('white-space: nowrap'), '缺 white-space: nowrap');
});

/** 胶囊标签合成一个 .node-pill，抄两份就会改一个忘另一个 */
test('胶囊标签只定义一次', () => {
  if (!hasSrc) return;
  /*
   * 数"以 .node-pill 开头的规则块"有几个。
   * 不用 /\.node-pill[\s\S]{0,200}?\}/ 这类非贪婪写法 ——
   * 定义块超过 200 字符时它根本匹配不到，于是数出来是 0，
   * 看着像"没定义"，实际是正则截断（假象）。
   */
  const n = [...stripComments(css).matchAll(/(?:^|\n)\.node-pill\s*\{/g)].length;
  assert.equal(n, 1, '.node-pill 只能有一处定义（抄两份就会改一个忘另一个）');
  const at = css.indexOf('.node-pill {');
  assert.ok(at >= 0 && css.slice(at, at + 320).includes('border-radius'), '.node-pill 必须有完整样式');
});

/**
 * "块管节奏、变体管外观" —— 需要基类节奏的变体必须挂在块上。
 *
 * 只写 node-line--brief 而不带 node-line 的话，间距与字号基准就丢了。
 *
 * 反过来，**不是所有变体都要带块**：--foot / --flag / --alert / --err /
 * --lead / --foot / --flag / --alert / --err / --mono 自带 margin 与字号，是独立行，
 * 再挂上基类反而会多出一重 margin（第一版就是这么写错并误报的）。
 */
const NEEDS_BLOCK = ['brief', 'path', 'preview', 'meta'];

test('需要基类节奏的变体都挂了块类名', () => {
  if (!hasSrc) return;
  const bad: string[] = [];
  for (const f of sources()) {
    const src = read(f);
    for (const m of src.matchAll(/className="([^"]*)"/g)) {
      const list = m[1].split(/\s+/);
      const needs = list.some((c) => NEEDS_BLOCK.includes(c.replace('node-line--', '')));
      if (needs && !list.includes('node-line')) bad.push(`${path.relative(ROOT, f)} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], '这些变体必须和块类名 node-line 一起用');
});

/**
 * .node-chip 是**参数卡片**（NodeCardChips，会换色 / 虚线）专用的，
 * 胶囊小标签必须用 .node-pill。
 *
 * 第一版把胶囊命名为 node-chip，于是它与参数卡片**撞名** ——
 * 两边样式互相覆盖。而"必须有定义"这条守卫查不出来：
 * node-chip 确实有定义，只是属于另一族。
 * 撞名只能靠"这个类只允许一个文件用"来盯。
 */
test('.node-chip 只允许参数卡片用', () => {
  if (!hasSrc) return;
  const bad: string[] = [];
  for (const f of sources()) {
    if (path.basename(f) === 'NodeCardChips.tsx') continue;
    const src = read(f);
    if (src.includes('"node-chip"') || /[`\s]node-chip[`\s]/.test(src)) {
      bad.push(path.relative(ROOT, f));
    }
  }
  assert.deepEqual(bad, [], '.node-chip 是参数卡片专用，胶囊标签请用 .node-pill');
});

/* ================= 逐字段「设为默认」 ================= */

/**
 * 字段渲染层必须按 presetKey 逐字段存默认。
 *
 * 以前只有一个"管整个节点"的按钮：想只改一个字段的默认，
 * 得先把整个节点配成想要的样子再整份存 —— 顺带把其它字段当前的值
 * 也一起定死。下面是这条能力的存在性守卫。
 */
test('字段渲染层接了逐字段设为默认', () => {
  if (!hasSrc) return;
  const src = read(path.join(ROOT, 'components/inspectors/fields.tsx'));
  for (const fn of ['setFieldsDefault', 'clearFieldsDefault', 'hasFieldDefault']) {
    assert.ok(src.includes(fn), `fields.tsx 必须用到 ${fn}`);
  }
});

/**
 * 不再有「管整个节点」的设为默认按钮。
 *
 * 以前它和逐字段小按钮并存：
 * 顶部一个"设为默认"把整份 data 存成默认，下面每个字段又各有一个。
 * 两条路写进不同的键（一个按 matchPresetKey、一个按字段路径），
 * 于是"我单独设了某个字段的默认，顶部却显示没设过默认"。
 *
 * 而且整体按钮会顺带定死别的字段 —— 只想改一个字段的默认，
 * 得先把整个节点配成想要的样子再整份存。
 *
 * 所以只留逐字段小按钮，键的算法也只剩一处。
 */
test('属性面板不再有整节点的设为默认按钮', () => {
  if (!hasSrc) return;
  const i = read(path.join(ROOT, 'components/Inspector.tsx'));
  assert.ok(!i.includes('setDefault'), 'Inspector 不该再整份存默认');
  assert.ok(!i.includes('hasDefault'), 'Inspector 不该再查整节点默认');
  // 逐字段那条路必须还在 —— 全删了等于功能没了
  const f = read(path.join(ROOT, 'components/inspectors/fields.tsx'));
  assert.ok(f.includes('matchPresetKey'), 'fields.tsx 仍要用 matchPresetKey 算键');
  assert.ok(f.includes('allPresets'), 'fields.tsx 仍要传 allPresets');
});

/** 密钥字段必须被挡住 —— 默认值是明文落盘的 */
test('逐字段存默认要挡密钥', () => {
  if (!hasSrc) return;
  const src = read(path.join(ROOT, 'engine/nodeDefaults.ts'));
  assert.ok(src.includes('isSecretField'), '缺少 isSecretField');
  assert.ok(
    /setFieldsDefault[\s\S]{0,400}isSecretField/.test(src),
    'setFieldsDefault 里必须过一遍 isSecretField',
  );
});

/* ================= 嵌合的直筒观感 ================= */

/*
 * 直筒需要**两块**配合：下方压掉上圆角（.is-stacked）、上方压掉下圆角
 * （.is-stack-top）。只做一半的话两块之间会留一个圆角缺口，看着不像积木。
 *
 * .is-stack-top 以前定义了却没人接上 —— 正是"定义了没用"这类反向问题，
 * 光查"用了没定义"逮不到。
 */
test('.is-stack-top 有定义且被接上', () => {
  if (!hasSrc) return;
  const m = stripComments(css).match(/\.node-card\.is-stack-top\s*\{[^}]*\}/);
  assert.ok(m, '.is-stack-top 必须有样式定义');
  assert.ok(m[0].includes('border-bottom-left-radius'), '缺下圆角压制');

  const shell = read(path.join(ROOT, 'components/NodeShell.tsx'));
  assert.ok(shell.includes('is-stack-top'), 'NodeShell 没有接上 is-stack-top');
  assert.ok(shell.includes('hasStackChild'), 'NodeShell 要读 hasStackChild 才能知道下面有没有块');
});

/** 标记必须算出来塞进 data，否则 NodeShell 扫不到全图 */
test('渲染时算 hasStackChild', () => {
  if (!hasSrc) return;
  /*
   * 嵌合已抽到 hooks/useStackLayout —— App.tsx 与 hook 都扫，
   * 只盯一处会在代码搬走后假通过。
   */
  const app = readSrc('App.tsx', 'hooks/useStackLayout.ts');
  assert.ok(app.includes('stackParentIds'), 'App 要用 stackParentIds 算出下面挂着块的节点');
  assert.ok(app.includes('hasStackChild'), '要把 hasStackChild 塞进 data');
});

/*
 * 不落盘：hasStackChild 是渲染时算的，进了存档就是脏数据。
 * 复制节点会整体 clone data —— 只复制串顶（下级没选中）时，
 * 副本会继承"我下面有块"，底部被压平而实际下面什么都没有。
 */
test('hasStackChild 进了 VIEW_KEYS（不落盘、复制时剥掉）', () => {
  if (!hasSrc) return;
  const san = read(path.join(ROOT, 'engine/sanitize.ts'));
  const m = san.match(/VIEW_KEYS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, '找不到 VIEW_KEYS');
  assert.ok(m[1].includes('hasStackChild'), 'VIEW_KEYS 缺 hasStackChild');
});

/* ================= MCP 服务：全局库，不是画布级 ================= */

/*
 * 以前每张画布各存一份 mcpServers：同一服务在五张画布上要用就配五遍，
 * 改个地址漏一处 → "这张画布连的是旧地址"，**且不报错**。
 * 下面是"归全局库管"的存在性守卫。
 */
test('MCP 服务由全局库管', () => {
  if (!hasSrc) return;
  const store = read(path.join(ROOT, 'engine/mcpServers.ts'));
  assert.ok(store.includes('MCP_SERVERS_KEY'), '缺少全局存储键');
  assert.ok(store.includes('migrateFromCanvases'), '缺迁移：老画布上的服务不能丢');
});

/** 画布配置改动不该再触发 MCP 刷新（改环境变量也会触发就太吵了） */
test('saveCanvasConfig 不再为 MCP 触发刷新', () => {
  if (!hasSrc) return;
  const app = read(path.join(ROOT, 'App.tsx'));
  const i = app.indexOf('const saveCanvasConfig');
  assert.ok(i > 0, '找不到 saveCanvasConfig');
  const body = app.slice(i, i + 1200);
  assert.ok(!body.includes('scheduleMcpRefresh'), 'saveCanvasConfig 里不该再调 scheduleMcpRefresh');
  assert.ok(!body.includes('collectServers'), '不该再从画布配置里扫服务');
});

/** 服务库变了要防抖刷新 —— 改命令算变化（那是换了个服务） */
test('全局服务库变了要触发刷新', () => {
  if (!hasSrc) return;
  const app = read(path.join(ROOT, 'App.tsx'));
  assert.ok(/mcpServers,\s*scheduleMcpRefresh/.test(app), 'effect 要依赖 mcpServers');
  assert.ok(app.includes('toServerRefs'), '要用 toServerRefs 转形状');
});

/** 凭据中心要能看到 MCP 那页 */
test('凭据中心有 MCP 服务页', () => {
  if (!hasSrc) return;
  const p = read(path.join(ROOT, 'components/CredentialPanel.tsx'));
  assert.ok(p.includes('MCP 服务'), '凭据中心缺 MCP 页签');
  assert.ok(p.includes('McpServersPanel'), '没有渲染 MCP 面板');
});

/**
 * 协议没接上时状态位要明说，不能给假绿勾 ——
 * 假绿勾会让用户以为服务已经在跑了。
 */
/* ================= 右栏：上层必须限高 ================= */

/*
 * 曾经的表现：参数设置与运行日志**叠在一起**。
 *
 * 链条是：
 *   .af-right-insp  flex:1 min-height:0   ← 限高了
 *     └ .insp-slot  flex:none             ← 高度=内容高，父级限高失效
 *         └ .inspector  overflow-y:auto   ← 永远不触发（高度没被约束）
 *
 * 于是内容一多就撑出 .af-right-insp，而它没有 overflow:hidden，
 * 直接盖到下面的日志上。
 *
 * 这类问题**测不出来**（要肉眼看到），而且改 CSS 时极易回退 ——
 * 尤其是"整理重复选择器"时按最后生效的值挑，很容易把 flex:none 留下、
 * 把 flex:1 当死代码删掉（我就是这么弄出来的）。
 */

/** 取某个选择器的声明块（剥注释后匹配） */
function ruleOf(sel: string): string {
  const c = stripComments(css);
  const m = c.match(new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
}

test('.af-right-insp 有 overflow:hidden（缺了就会盖住日志）', () => {
  if (!hasSrc) return;
  const r = ruleOf('.af-right-insp');
  assert.ok(r, '找不到 .af-right-insp');
  assert.ok(/overflow\s*:\s*hidden/.test(r), '.af-right-insp 必须有 overflow:hidden 兜底');
});

/** 高度必须受父级约束，否则子级限高全部失效 */
test('.insp-slot 是 flex:1（flex:none 会让内容顶出右栏）', () => {
  if (!hasSrc) return;
  const r = ruleOf('.insp-slot');
  assert.ok(r, '找不到 .insp-slot');
  assert.ok(/flex\s*:\s*1/.test(r), '.insp-slot 必须 flex:1');
  assert.ok(!/flex\s*:\s*none/.test(r), '.insp-slot 不能是 flex:none —— 内容会溢出盖住日志');
  assert.ok(/min-height\s*:\s*0/.test(r), '缺 min-height:0');
});

test('.inspector 自身要能滚动（限高 + overflow-y）', () => {
  if (!hasSrc) return;
  const r = ruleOf('.inspector');
  assert.ok(r, '找不到 .inspector');
  assert.ok(/flex\s*:\s*1/.test(r), '.inspector 必须 flex:1，否则高度不受父级约束');
  assert.ok(/min-height\s*:\s*0/.test(r), '缺 min-height:0');
  assert.ok(/overflow-y\s*:\s*auto/.test(r), '缺 overflow-y:auto');
});

/*
 * 限高只能有一处 —— 以前 .inspector 写 flex:none、
 * 又靠 .insp-slot .inspector 覆盖成 flex:1，两处写就容易漏改一处。
 */
test('限高不写两处（没有 .insp-slot .inspector 这类覆盖）', () => {
  if (!hasSrc) return;
  assert.ok(
    !/\.insp-slot\s+\.inspector\s*\{/.test(stripComments(css)),
    '限高应只在 .inspector 基础定义里，不要再有一条 .insp-slot .inspector 覆盖',
  );
});

test('日志区自己也要能裁剪（内容多时不外溢）', () => {
  if (!hasSrc) return;
  const r = ruleOf('.af-right-log');
  assert.ok(r, '找不到 .af-right-log');
  assert.ok(/overflow\s*:\s*hidden/.test(r), '.af-right-log 缺 overflow:hidden');
});

test('MCP 状态位不假装', () => {
  if (!hasSrc) return;
  const m = read(path.join(ROOT, 'components/McpServersPanel.tsx'));
  assert.ok(m.includes('未接入协议'), '缺"未接入协议"的明确状态');
  /*
   * 必须**真的读 protocolReady**来分支，不能只在 props 里声明了它、
   * 渲染时却写死成功 —— 那样界面上照样是假绿勾，而守卫看不出来。
   */
  assert.ok(
    /!protocolReady\s*\?/.test(m),
    '状态必须由 !protocolReady 分支决定，不能写死成功',
  );
});

/* ================= 侧栏节点说明 ================= */

/*
 * 以前展开只有一句话（def.meta.sub）。而节点能不能用，取决于
 * 三件那句话里没有的事：产出/接受（能跟谁连）、需要的外部能力
 * （浏览器模式下缺了直接失败）、哪些参数必填。
 * 这三样契约里都有，只是没接到界面上 —— 下面是"确实接上了"的守卫。
 */
test('侧栏展开的是结构化说明，不是一句话', () => {
  if (!hasSrc) return;
  const sb = read(path.join(ROOT, 'components/Sidebar.tsx'));
  assert.ok(sb.includes('NodeDesc'), '侧栏没有用 NodeDesc');

  const nd = read(path.join(ROOT, 'components/NodeDesc.tsx'));
  assert.ok(nd.includes('describeBlock'), '说明要取自契约（describeBlock）');
  assert.ok(nd.includes('PORT_LABEL'), '产出要显示可读的端口名');
  assert.ok(nd.includes('requires'), '要显示需要的外部能力');
});

/**
 * 参数表必须与文档 / 运行时 API 同一个函数 ——
 * 各写一份的话"界面上看到的"和"AI 查到的"会不一样。
 */
test('说明里的参数走 deriveParams，不自己拼', () => {
  if (!hasSrc) return;
  const nd = read(path.join(ROOT, 'components/NodeDesc.tsx'));
  assert.ok(nd.includes('fieldLikeOf'), '要经 fieldLikeOf 转换');
  assert.ok(!nd.includes('function fieldLikeOf'), '转换逻辑该在 engine/fieldLike.ts，不在组件里');
});

/** 没契约的节点（模块、MCP 生成节点）展开后也不能一片空白 */
test('没契约时仍有兜底文案', () => {
  if (!hasSrc) return;
  const nd = read(path.join(ROOT, 'components/NodeDesc.tsx'));
  assert.ok(nd.includes('这个节点没有额外说明'), '缺兜底：展开后空白会让人以为界面坏了');
});

/* ================= 「调用画布」不露内部 id ================= */

/*
 * 起因：画布没名字时卡片显示 `cvmamu7obyv93` ——
 * 内部 id 的片段。用户看着像乱码，且完全无法对应到哪张画布。
 *
 * 内部 id 对用户没有任何意义，显示它只会让人以为是故障。
 */
test('画布卡片不再显示 canvasId 的片段', () => {
  if (!hasSrc) return;
  const f = read(path.join(ROOT, 'components/CanvasRefNode.tsx'));
  /*
   * 整份文件里不许出现 .slice( ——
   * 只匹配 `canvasId.slice(` 抓不到：注入时用的是局部变量 cid。
   * 这个文件只有 briefOf 一处文案，禁掉截断不会有副作用。
   */
  assert.ok(!/\.slice\(/.test(f), '不能再截断任何字段来显示');
  assert.ok(!/调用画布 \$\{/.test(f), '不能再有"调用画布 xxx"这种拼 id 的写法');
  assert.ok(f.includes('canvasRefDisplayName'), '显示名要走 engine/canvasRefName');
});

/** 下拉框必须真存在 —— 以前只有一句"在下拉框里选"的说明，控件根本没有 */
test('有真的「选哪张画布」控件', () => {
  if (!hasSrc) return;
  const f = read(path.join(ROOT, 'nodes/defs/canvasRef.ts'));
  assert.ok(/type:\s*'select'/.test(f) && /key:\s*'canvasId'/.test(f),
    'canvasRef 必须有 canvasId 下拉框，否则节点拖出来就配不了');
});

/** 改名要回写，否则显示旧名且无任何提示 */
test('画布改名会同步到引用节点', () => {
  if (!hasSrc) return;
  const f = read(path.join(ROOT, 'App.tsx'));
  assert.ok(f.includes('syncCanvasesRefNames'), '改名后要回写引用节点的名字快照');
});

/* ================= 嵌合落位 ================= */

/*
 * 表现：嵌合后只挪动一点点 → 既不解除、也不归位，
 * 节点停在偏移处，关系还在却看着歪的。
 *
 * 这类问题测不出来（要拖一下才看得到），且改判定条件极易回退，
 * 所以钉一条源码守卫。
 */
test('落位交给 planStackDrop，App 里不再自己判 hit.parentId !== oldParent', () => {
  if (!hasSrc) return;
  const app = read(path.join(ROOT, 'App.tsx'));
  assert.ok(app.includes('planStackDrop'), '要走 engine 的落位规划');
  assert.ok(
    !/hit\.parentId\s*!==\s*oldParent/.test(app),
    '这个条件正是"挪一点点既不解除也不归位"的根因，不能再出现',
  );
});

/** 归位与吸附必须同一个函数算位置，否则"吸上去"和"拖回来"位置不一致 */
test('snapPosOf 只算一次位置（findSnapTarget 复用它）', () => {
  if (!hasSrc) return;
  const st = read(path.join(ROOT, 'engine/stack.ts'));
  assert.ok(/function snapPosOf/.test(st), '要有 snapPosOf');
  assert.ok(/const at = snapPosOf\(n\)/.test(st), 'findSnapTarget 要复用 snapPosOf');
});

/* ================= 拖入触发器后画布消失 ================= */

/*
 * 起因：create 把数据补丁当成"触发方式"传给 makeTriggerNode，
 * 于是 triggers = [undefined]（落盘后 [null]）；
 * 而 triggerKindsOf 只看 length > 0 就原样返回，
 * 面板取 TRIGGER_META[selected[0]].hint 时抛 TypeError，
 * 整棵 React 树崩掉 —— 表现为"画布整个消失"。
 */
test('create 不再把补丁当触发方式传给 makeTriggerNode', () => {
  if (!hasSrc) return;
  const f = read(path.join(ROOT, 'nodes/defs/trigger.ts'));
  assert.ok(
    !/makeTriggerNode\(id,\s*\(?partial/.test(f),
    'makeTriggerNode 的第二个参数是 triggers，不是数据补丁',
  );
});

/** 一个节点渲染出错不该让整张画布跟着消失 */
test('每个节点卡片都套了渲染兜底', () => {
  if (!hasSrc) return;
  const f = read(path.join(ROOT, 'nodes/registry.tsx'));
  /*
   * 必须匹配**赋值处**而不是整份文件含这个词 ——
   * 只查字符串的话，import 语句里也有 withCrashGuard，
   * 把真正的兜底删掉检查依然通过（假阴性）。
   */
  assert.ok(
    /map\[def\.type\]\s*=\s*withCrashGuard/.test(f),
    'buildNodeTypes 要给每个节点套错误边界',
  );
});

/** 面板同样要兜住 —— 崩在面板里会让整棵树一起没 */
test('属性面板也套了渲染兜底', () => {
  if (!hasSrc) return;
  const f = read(path.join(ROOT, 'components/Inspector.tsx'));
  // 同样要匹配包裹处：import 里也有 ErrorBoundary
  assert.ok(
    /<ErrorBoundary[\s\S]*?<Panel/.test(f),
    '面板崩了不该带走整张画布',
  );
});

/* ------------------------------------------------------------------ */
/* 左栏三个库：底板与文字样式必须统一                                    */
/* ------------------------------------------------------------------ */

/*
 * 节点库、模块库、画布库曾经各有一套外壳与条目类名，
 * 切一次标签整个左栏的观感就变一次。
 *
 * 这类不一致**测不出来也看不出报错**，只有人工比对才发现，
 * 所以钉在源码上：三个库必须共用同一组类名。
 */
const LIBS = [
  'components/Sidebar.tsx',
  'components/ModuleLibrary.tsx',
  'components/CanvasLibrary.tsx',
];

function srcOf(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('三个库共用同一个外壳 .side-pane', () => {
  for (const f of LIBS) {
    const t = srcOf(f);
    assert.match(t, /className="side-pane"/, `${f} 要用 .side-pane 作外壳`);
  }
});

test('三个库都有 .side-head 标题行（标题不随内容滚）', () => {
  /*
   * 以前模块库把标题塞在 .side-title（分组级），
   * 于是它的标题比节点库矮一档、颜色更淡 —— 三个库三种标题。
   */
  for (const f of LIBS) {
    const t = srcOf(f);
    assert.match(t, /className="side-head"/, `${f} 要有 .side-head`);
    assert.match(t, /className="side-body"/, `${f} 要有 .side-body 滚动区`);
  }
});

test('三个库的条目都用 .side-item（同一块底板）', () => {
  for (const f of LIBS) {
    assert.match(srcOf(f), /side-item/, `${f} 的条目要用 .side-item`);
  }
});

test('空态统一用 .side-empty，不再拿 .side-sub 当空态', () => {
  /*
   * .side-sub 的本职是"分组下面的一句补充说明"（有缩进与换行规则），
   * 拿它当空态用就是一件事两个语义 —— 改一个会连累另一个。
   */
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.side-empty\s*\{/, '要有 .side-empty');
  for (const f of LIBS) {
    const t = srcOf(f);
    // 三个库都可能出现空态，出现了就必须用 .side-empty
    assert.ok(!/className="side-sub"/.test(t), `${f} 不该再用 .side-sub 当空态`);
  }
});

test('不再有画布库专属的一套类名（af-lib / canvas-library）', () => {
  for (const f of LIBS) {
    const t = srcOf(f);
    assert.ok(!/af-lib/.test(t), `${f} 还残留 af-lib`);
    assert.ok(!/canvas-library/.test(t), `${f} 还残留 canvas-library`);
  }
});

test('.side-head / .side-title / .side-title-ops 在 CSS 里各只有一处定义', () => {
  /*
   * 同一选择器两处写不同值 → 后写的赢，前面那块是死代码，
   * 而且改了没反应会让人以为 CSS 没生效。
   * 统一三库时这三处都撞过，钉住。
   */
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of ['.side-head', '.side-title', '.side-title-ops', '.side-pane']) {
    const n = (css.match(new RegExp(`^\\${sel}\\s*\\{`, 'gm')) ?? []).length;
    assert.equal(n, 1, `.${sel} 应当只有一处定义，实际 ${n} 处`);
  }
});

test('节点库的自定义色块有样式（.side-swatch / .side-picker）', () => {
  /*
   * 色块是新增的控件，忘了写 CSS 的话它会退化成一个无边框的小方块，
   * 界面上只是"看着怪"，没人会想到是样式没定义。
   */
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.side-swatch\s*\{/, '要有 .side-swatch');
  assert.match(css, /\.side-picker\s*\{/, '要有 .side-picker');
});

test('改色走 setColorOverride / 自定义预设自己那份，不各写一套', () => {
  const t = srcOf('components/Sidebar.tsx');
  assert.ok(/setColorOverride/.test(t), '内置类型要写类型级覆盖');
  assert.ok(/saveCustomPresets/.test(t), '自定义预设要写回它自己');
});
