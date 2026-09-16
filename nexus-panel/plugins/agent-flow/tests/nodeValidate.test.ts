import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNode, worstLevel, type IssueLevel } from '../engine/nodeValidate';

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
  assert.equal(level('const', { value: '' }), 'warn');
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
