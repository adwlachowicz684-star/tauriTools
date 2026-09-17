import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECS, specOf, canConnect, canStack, blockCatalog, PORT_LABEL } from '../engine/nodeSpec';

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
 * 这条守的是本文件存在的理由：
 * 「上游 → 等待2秒 → 提取」看着天经地义，
 * 但等待节点输出的是"已等待 2000ms"，提取节点取不到任何东西
 * —— 而且不报错（默认给空串）。
 */
test('等待节点接提取：要警告（mark 截断数据）', () => {
  const v = canConnect(specOf('wait'), specOf('extract'));
  assert.equal(v.level, 'warn');
  assert.ok(v.reason && v.reason.includes('状态标记'));
});

test('提示音 / 播放音频 同样截断数据', () => {
  for (const k of ['beep', 'play-audio']) {
    const v = canConnect(specOf(k), specOf('extract'));
    assert.equal(v.level, 'warn', `${k} 应警告`);
  }
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
