import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMessage, parseMessages, parseKeywords, matchKeywords,
  takeNew, newSeenState, candidateRoots, concludeProbe,
  CONV_SOURCE_META,
  type ConvMessage,
} from '../engine/conversations';

const SRC = 'f1';

/* ---------- 解析：单条 ---------- */

test('解析: codebuddy 风格（role 在顶层，content 是数组块）', () => {
  const m = parseMessage(JSON.stringify({
    type: 'user',
    timestamp: '2026-09-15T10:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: '帮我写个备份脚本' }] },
  }), SRC);
  assert.ok(m);
  assert.equal(m!.role, 'user');
  assert.equal(m!.text, '帮我写个备份脚本');
  assert.ok(m!.ts && m!.ts > 0);
});

test('解析: content 是纯字符串', () => {
  const m = parseMessage(JSON.stringify({ role: 'assistant', content: '已经写好了' }), SRC);
  assert.ok(m);
  assert.equal(m!.role, 'assistant');
  assert.equal(m!.text, '已经写好了');
});

test('解析: role 嵌在 message 里（顶层 type 是别的）', () => {
  const m = parseMessage(JSON.stringify({
    type: 'record', message: { role: 'assistant', content: 'hi' },
  }), SRC);
  assert.ok(m);
  assert.equal(m!.role, 'assistant');
});

test('解析: 只取文本块，工具调用不算内容', () => {
  const m = parseMessage(JSON.stringify({
    role: 'assistant',
    content: [
      { type: 'tool_use', name: 'bash' },
      { type: 'text', text: '执行结果如下' },
    ],
  }), SRC);
  assert.equal(m!.text, '执行结果如下');
});

test('解析: 秒级时间戳补成毫秒', () => {
  const m = parseMessage(JSON.stringify({ role: 'user', content: 'x', ts: 1700000000 }), SRC);
  assert.equal(m!.ts, 1700000000000);
});

test('解析: 非法 JSON 返回 null，不抛异常', () => {
  assert.equal(parseMessage('{not json}', SRC), null);
});

test('解析: 非对象、无角色、无文本都返回 null', () => {
  assert.equal(parseMessage('[1,2]', SRC), null);
  assert.equal(parseMessage('{"content":"有文本没角色"}', SRC), null);
  assert.equal(parseMessage('{"role":"user","content":"   "}', SRC), null);
});

test('解析: 去重键优先用 id', () => {
  const m = parseMessage(JSON.stringify({ role: 'user', content: 'x', uuid: 'u-1' }), SRC);
  assert.equal(m!.key, `${SRC}#u-1`);
});

test('解析: 没有 id 时，键对内容敏感（内容不同键不同）', () => {
  const a = parseMessage(JSON.stringify({ role: 'user', content: '你好' }), SRC)!;
  const b = parseMessage(JSON.stringify({ role: 'user', content: '世界' }), SRC)!;
  assert.notEqual(a.key, b.key);
});

/* ---------- 解析：整段 ---------- */

test('解析: 整段跳过第一行（尾部窗口会切出半截 JSON）', () => {
  const content = '{"role":"user","content":"被截断的半截"\n'
    + '{"role":"user","content":"完整的第一条"}\n'
    + '{"role":"assistant","content":"完整第二条"}';
  const msgs = parseMessages(content, SRC);
  assert.equal(msgs.length, 2, '第一行是半截，应丢弃');
  assert.equal(msgs[0].text, '完整的第一条');
});

test('解析: 空内容返回空数组', () => {
  assert.deepEqual(parseMessages('', SRC), []);
});

/* ---------- 增量 ---------- */

test('增量: prime=true 只建基线不返回（历史不该触发流程）', () => {
  const seen = newSeenState();
  const msgs: ConvMessage[] = [
    { role: 'user', text: '旧消息', ts: 1000, key: 'k1' },
  ];
  assert.deepEqual(takeNew(msgs, seen, true), []);
  assert.equal(seen.keys.has('k1'), true, '但要记住，下次不再报');
});

test('增量: 非 prime 时返回新消息', () => {
  const seen = newSeenState();
  takeNew([{ role: 'user', text: 'a', ts: 1, key: 'k1' }], seen, true);
  const out = takeNew([{ role: 'user', text: 'b', ts: 2, key: 'k2' }], seen, false);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'b');
});

test('增量: 轮询窗口重叠不会重复触发', () => {
  const seen = newSeenState();
  const m = { role: 'user', text: '同', ts: 5, key: 'same' };
  assert.equal(takeNew([m], seen, false).length, 1);
  assert.equal(takeNew([m], seen, false).length, 0, '第二次应被去重');
});

test('增量: lastTs 取最大值', () => {
  const seen = newSeenState();
  takeNew([
    { role: 'user', text: 'a', ts: 100, key: 'a' },
    { role: 'user', text: 'b', ts: 300, key: 'b' },
    { role: 'user', text: 'c', ts: 200, key: 'c' },
  ], seen, false);
  assert.equal(seen.lastTs, 300);
});

/* ---------- 关键词 ---------- */

test('关键词: 按行拆分、去空行与注释行', () => {
  assert.deepEqual(parseKeywords('报错\n\n# 这是注释\n失败\n'), ['报错', '失败']);
});

test('关键词: 大小写不敏感', () => {
  const hits = matchKeywords(
    [{ role: 'assistant', text: 'ERROR: 连接超时', ts: 1, key: 'k' }],
    ['error'], 'both',
  );
  assert.equal(hits.length, 1);
});

test('关键词: scope=user 时忽略 AI 说的话', () => {
  const msgs: ConvMessage[] = [
    { role: 'assistant', text: '部署失败', ts: 1, key: 'a' },
    { role: 'user', text: '部署失败', ts: 2, key: 'u' },
  ];
  assert.equal(matchKeywords(msgs, ['部署失败'], 'user').length, 1);
  assert.equal(matchKeywords(msgs, ['部署失败'], 'both').length, 2);
});

test('关键词: 系统消息永不参与匹配', () => {
  const hits = matchKeywords(
    [{ role: 'system', text: '你是助手，遇到报错要提示', ts: 1, key: 's' }],
    ['报错'], 'both',
  );
  assert.equal(hits.length, 0, '系统提示词里的词会误触');
});

test('关键词: 一条消息只报一次（命中多个关键词也只算一次）', () => {
  const hits = matchKeywords(
    [{ role: 'user', text: '报错并且失败了', ts: 1, key: 'k' }],
    ['报错', '失败'], 'both',
  );
  assert.equal(hits.length, 1);
});

test('关键词: excerpt 包含命中词', () => {
  const text = `${'前'.repeat(300)}错误在这里`;
  const hits = matchKeywords([{ role: 'user', text, ts: 1, key: 'k' }], ['错误'], 'both');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].excerpt.includes('错误'), '上下文里应能看到命中词');
  assert.ok(hits[0].excerpt.length <= 200);
});

test('关键词: 关键词列表为空时不匹配', () => {
  const hits = matchKeywords([{ role: 'user', text: 'x', ts: 1, key: 'k' }], [], 'both');
  assert.equal(hits.length, 0);
});

/* ---------- 路径 ---------- */

test('路径: linux 候选包含 CLI 与 Trae IDE', () => {
  const roots = candidateRoots('/home/u', 'linux');
  assert.ok(roots.some((r) => r.kind === 'codebuddy' && r.root === '/home/u/.codebuddy/projects'));
  assert.ok(roots.some((r) => r.kind === 'workbuddy'));
  assert.ok(roots.some((r) => r.kind === 'trae-ide' && r.root.includes('.config/Trae')));
});

test('路径: windows 走 AppData\\Roaming', () => {
  const roots = candidateRoots('C:/Users/u', 'win');
  const t = roots.find((r) => r.kind === 'trae-ide');
  assert.ok(t);
  assert.ok(t!.root.includes('AppData/Roaming'));
});

test('路径: mac 走 Application Support', () => {
  const roots = candidateRoots('/Users/u', 'mac');
  const t = roots.find((r) => r.kind === 'trae-ide');
  assert.ok(t);
  assert.ok(t!.root.includes('Application Support'));
});

test('路径: Trae 各版本目录都在候选里（国际版/国内版/SOLO）', () => {
  const names = candidateRoots('/home/u', 'linux')
    .filter((r) => r.kind === 'trae-ide')
    .map((r) => r.root);
  assert.ok(names.some((n) => n.includes('/Trae/')));
  assert.ok(names.some((n) => n.includes('/Trae CN/')));
  assert.ok(names.some((n) => n.includes('/TRAE SOLO CN/')));
});


/* ---------- 探测结论 ---------- */

test('探测: 明文来源、有文件、解析成功 → 可用', () => {
  const r = concludeProbe('codebuddy', true, 3, 10);
  assert.equal(r.usable, true);
  assert.ok(r.note.includes('可用'));
});

test('探测: 目录不存在 → 不可用，并说清是没找到', () => {
  const r = concludeProbe('codebuddy', false, 0, 0);
  assert.equal(r.usable, false);
  assert.ok(r.note.includes('不存在'));
});

test('探测: 目录在但没文件 → 不可用', () => {
  const r = concludeProbe('codebuddy', true, 0, 0);
  assert.equal(r.usable, false);
  assert.ok(r.note.includes('没有找到对话文件'));
});

test('探测: 有文件但解析不出 → 不可用，提示可能加密', () => {
  const r = concludeProbe('codebuddy', true, 5, 0);
  assert.equal(r.usable, false);
  assert.ok(r.note.includes('解析'), r.note);
});

test('探测: Trae IDE 即使目录存在也判为不可用（SQLite 读不了）', () => {
  const r = concludeProbe('trae-ide', true, 9, 9);
  assert.equal(r.usable, false, '不能因为"找到了文件"就宣称可用');
  assert.ok(r.note.includes('SQLite'), r.note);
});

test('探测: 每个来源都有 label 与 hint', () => {
  for (const [k, v] of Object.entries(CONV_SOURCE_META)) {
    assert.ok(v.label, `${k} 缺 label`);
    assert.ok(v.hint, `${k} 缺 hint`);
  }
});
