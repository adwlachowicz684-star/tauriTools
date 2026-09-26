import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNode, worstLevel, type IssueLevel } from '../engine/nodeValidate';
import { readSrc } from './srcScan';

/**
 * 节点配置校验 —— 三档预警的判定。
 *
 * 重点测的是**黄与红的分界**：分错比不报更糟。
 * 一片假红会让人学会忽略圆点；该红判黄则会让人以为能跑，结果跑挂。
 */

/** 造一个带 kind 的节点数据，未提及的字段留空 */
function nd(kind: string, extra: Record<string, unknown> = {}) {
  return { data: { kind, label: 'x', status: 'idle', output: '', error: '', ...extra } };
}

const level = (kind: string, extra: Record<string, unknown> = {}): IssueLevel =>
  validateNode(nd(kind, extra)).level;

/* ---------------- 任务 ---------------- */

test('任务：没提示词判红（CLI 无从下手）', () => {
  assert.equal(level('task', { prompt: '' }), 'error');
  assert.equal(level('task', { prompt: '   ' }), 'error');
});

test('任务：没工作目录 / 没模型判黄（有默认值兜底）', () => {
  assert.equal(level('task', { prompt: 'p', workdir: '' }), 'warn');
  assert.equal(level('task', { prompt: 'p', workdir: '/w', model: '' }), 'warn');
});

test('任务：齐全判绿', () => {
  assert.equal(level('task', { prompt: 'p', workdir: '/w', model: 'm' }), 'ok');
});

/* ---------------- 条件 ---------------- */

test('条件：没规则也没兜底判红', () => {
  assert.equal(level('condition', { rules: [], defaultBranch: false }), 'error');
});

test('条件：没规则但有兜底判黄（只会走兜底）', () => {
  assert.equal(level('condition', { rules: [], defaultBranch: true }), 'warn');
});

test('条件：有空规则判黄（永远不命中）', () => {
  assert.equal(level('condition', { rules: [{ id: 'r1', conditions: [] }] }), 'warn');
});

test('条件：规则正常判绿', () => {
  assert.equal(level('condition', {
    rules: [{ id: 'r1', conditions: [{ id: 'c1', left: 'a', op: 'eq', right: 'b' }] }],
  }), 'ok');
});

/* ---------------- 触发器 ---------------- */

test('触发器：没选任何方式判红', () => {
  assert.equal(level('trigger', { triggers: [], config: {} }), 'error');
});

test('触发器：cron 没表达式判红', () => {
  assert.equal(level('trigger', { triggers: ['cron'], config: { cronExpr: '' } }), 'error');
});

test('触发器：watch 没目录判红', () => {
  assert.equal(level('trigger', { triggers: ['watch'], config: { watchDir: '' } }), 'error');
});

test('触发器：间隔小于 10 秒判红', () => {
  assert.equal(level('trigger', { triggers: ['interval'], config: { intervalSec: 5 } }), 'error');
});

test('触发器：配置齐全判绿', () => {
  assert.equal(level('trigger', { triggers: ['cron'], config: { cronExpr: '0 9 * * *' }, enabled: true }), 'ok');
});

test('触发器：停用只判黄（配置没错，只是不开）', () => {
  assert.equal(level('trigger', {
    triggers: ['cron'], config: { cronExpr: '0 9 * * *' }, enabled: false,
  }), 'warn');
});

/* ---------------- 文件 ---------------- */

test('文件：没路径判红', () => {
  assert.equal(level('fs', { op: 'read', path: '' }), 'error');
});

test('文件：copy 没目标路径判红', () => {
  assert.equal(level('fs', { op: 'copy', path: '/a', target: '' }), 'error');
});

test('文件：read 不需要目标路径', () => {
  assert.equal(level('fs', { op: 'read', path: '/a' }), 'ok');
});

/* ---------------- GitHub：拉取与推送的分界 ---------------- */

test('GitHub 拉取：缺令牌判黄（公开仓库还能读）', () => {
  assert.equal(level('github-update', { repo: 'o/r' }), 'warn');
});

/**
 * 这条是黄/红分界最关键的一条：
 * 拉取缺令牌 = 可能受限（黄），推送缺令牌 = 必然失败（红）。
 * 同为"缺令牌"，结论相反，因为推送不可能匿名。
 */
test('GitHub 推送：缺令牌判红（推送不可能匿名）', () => {
  assert.equal(level('github-push', { repo: 'o/r', filesText: 'a.txt' }), 'error');
});

test('GitHub 推送：没填文件判红', () => {
  assert.equal(level('github-push', { repo: 'o/r', filesText: '', token: 't' }), 'error');
});

test('GitHub 推送：齐全判绿', () => {
  assert.equal(level('github-push', { repo: 'o/r', filesText: 'a.txt', token: 't' }), 'ok');
});

test('GitHub 拉取：有凭据判绿', () => {
  assert.equal(level('github-update', { repo: 'o/r', credentialId: 'c1' }), 'ok');
});

/* ---------------- AI 节点 ---------------- */

test('OCR：本地模式没路径判红', () => {
  assert.equal(level('ocr', { imageSource: 'file', path: '' }), 'error');
});

test('OCR：网络模式没地址判红', () => {
  assert.equal(level('ocr', { imageSource: 'url', url: '' }), 'error');
});

test('OCR：没凭据判黄（可能用环境变量）', () => {
  assert.equal(level('ocr', { imageSource: 'file', path: '/a.png', credentialId: '' }), 'warn');
});

/**
 * 翻译的 text 为空不判错：
 * 它可能挂在某个上游后面，靠 {{上游.output}} 取内容。
 * 校验器拿不到边，判断不了有没有上游 —— 宁可漏报也不要误报红。
 */
test('翻译：文本为空不判红（可能来自上游）', () => {
  assert.notEqual(level('translate', { text: '', targetLang: 'en', credentialId: 'c' }), 'error');
});

/* ---------------- 工具节点 ---------------- */

test('等待：时长非法判红', () => {
  assert.equal(level('wait', { ms: 'abc' }), 'error');
  assert.equal(level('wait', { ms: -1 }), 'error');
  assert.equal(level('wait', { ms: 1000 }), 'ok');
});

test('提示音：音量越界判红', () => {
  assert.equal(level('beep', { volume: 5 }), 'error');
  assert.equal(level('beep', { volume: 0.5 }), 'ok');
});

test('播放音频：没路径判红', () => {
  assert.equal(level('play-audio', { path: '' }), 'error');
});

test('当前时间：没格式判红', () => {
  assert.equal(level('clock', { format: '' }), 'error');
});

test('常量：空值只判黄（输出空串，流程仍能跑）', () => {
  assert.equal(level('const', { items: [{ id: 'c0', value: '' }] }), 'warn');
});

test('日志：没有必填项，恒绿', () => {
  assert.equal(level('log', {}), 'ok');
});

/* ---------------- 模块 ---------------- */

test('模块：既没跟库也没脱钩判红', () => {
  assert.equal(level('module', { moduleId: '', inner: null }), 'error');
});

test('模块：跟库或已脱钩都正常', () => {
  assert.equal(level('module', { moduleId: 'md1', inner: null }), 'ok');
  assert.equal(level('module', { moduleId: '', inner: { nodes: [], edges: [] } }), 'ok');
});

/* ---------------- 防御 ---------------- */

test('未知类型返回绿，不乱报', () => {
  assert.equal(level('不存在的类型'), 'ok');
});

test('data 为空不抛异常', () => {
  assert.equal(validateNode({}).level, 'ok');
  assert.equal(validateNode(null).level, 'ok');
  assert.equal(validateNode(undefined).level, 'ok');
});

test('字段结构异常时不崩（校验出错不该让画布白屏）', () => {
  const bad = { data: { kind: 'condition', rules: '不是数组' } };
  assert.doesNotThrow(() => validateNode(bad));
});

test('汇总取最严重的一档', () => {
  assert.equal(worstLevel(['ok', 'warn', 'ok']), 'warn');
  assert.equal(worstLevel(['warn', 'error']), 'error');
  assert.equal(worstLevel(['ok']), 'ok');
  assert.equal(worstLevel([]), 'ok');
});

/* ---------------- 表格四件套 ---------------- */

test('读表格：没路径判红（执行器会抛"没填表格文件路径"）', () => {
  assert.equal(level('tableRead', { path: '' }), 'error');
  assert.equal(level('tableRead', { path: '   ' }), 'error');
});

test('读表格：有路径判绿', () => {
  assert.equal(level('tableRead', { path: '/tmp/a.csv' }), 'ok');
});

test('推导：列名与公式分开报，不合并成一句', () => {
  const r = validateNode(nd('derive', { newCol: '', expr: '' }));
  assert.equal(r.level, 'error');
  assert.equal(r.messages.length, 2);
});

test('推导：齐全判绿', () => {
  assert.equal(level('derive', { newCol: '总价', expr: '单价 * 数量' }), 'ok');
});

test('筛选：没条件判红', () => {
  assert.equal(level('filter', { cond: '' }), 'error');
  assert.equal(level('filter', { cond: '数量 > 0' }), 'ok');
});

test('汇总：没列名判红', () => {
  assert.equal(level('agg', { col: '' }), 'error');
  assert.equal(level('agg', { col: '数量', op: 'sum' }), 'ok');
});

/* ---------------- 变量 ---------------- */

test('变量：没名字判红', () => {
  assert.equal(level('var', { name: '', mode: 'set' }), 'error');
  assert.equal(level('var', { name: 'x', mode: 'set' }), 'ok');
});

test('变量：set 模式值空着不判红（会取上游输出）', () => {
  assert.equal(level('var', { name: 'x', mode: 'set', value: '' }), 'ok');
});

/* ---------------- 覆盖度：有执行器的种类都得有说法 ---------------- */

/**
 * 有执行器的节点种类，要么在 VALIDATORS 里有规则，
 * 要么在下面这份白名单里写清"为什么不需要"。
 *
 * 只做正向对账（登记了 → 规则真存在）抓不到这一类：
 * 表格四件套和变量**压根不在表里**，遍历表时它们根本不出现，
 * 于是四项恒绿、跑到才炸，测试却一直全绿。
 */
const NO_VALIDATOR_NEEDED: Record<string, string> = {
  // 由 engine/argTypes.ts 统一按运算判（缺参 / 错参），不进 VALIDATORS
  math: 'argTypes 按 op 判',
  compare: 'argTypes 按 op 判',
  text: 'argTypes 按 op 判',
  random: 'argTypes 按 op 判',
  // 没有必填项：留空则记上游内容
  log: '无必填项',
  // 只发停止信号
  stop: '无必填项',
  /*
   * 提示词留空有默认值「请输入内容」；
   * 且"用户到底填不填"是运行时才发生的事，编辑期判不了。
   */
  ask: '必填与否取决于运行时输入',
  // 纯接口标记，运行时透传
  canvasIn: '无必填项',
  canvasOut: '无必填项',
};

test('每个有执行器的节点种类都有校验规则，或白名单里写了理由', () => {
  const regSrc = readSrc('engine/runnerRegistry.ts');
  const valSrc = readSrc('engine/nodeValidate.ts');

  const runnersBlock = regSrc.match(/const RUNNERS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(runnersBlock, '没找到 RUNNERS 表');

  const kinds = [...runnersBlock[1].matchAll(/^\s*'?([a-zA-Z][\w-]*)'?:\s*run\w+,/gm)]
    .map((m) => m[1]);
  assert.ok(kinds.length >= 30, `RUNNERS 种类数异常：${kinds.length}`);

  const validatorsBlock = valSrc.match(/const VALIDATORS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(validatorsBlock, '没找到 VALIDATORS 表');
  const covered = new Set(
    [...validatorsBlock[1].matchAll(/^\s*'?([a-zA-Z][\w-]*)'?:\s*v\w+/gm)].map((m) => m[1]),
  );

  const missing = kinds.filter((k) => !covered.has(k) && !NO_VALIDATOR_NEEDED[k]);
  assert.deepEqual(missing, [], `这些种类有执行器却没有校验规则：${missing.join('、')}`);

  // 白名单里不该留已经补上规则的项 —— 留着就会掩盖"规则被摘掉"
  const stale = Object.keys(NO_VALIDATOR_NEEDED).filter((k) => covered.has(k));
  assert.deepEqual(stale, [], `白名单里的这些已经有规则了，该删掉：${stale.join('、')}`);
});
