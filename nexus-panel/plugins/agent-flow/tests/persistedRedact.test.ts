/*
 * PersistedState / 节点脱敏的两处静默缺口
 *
 * ================= 一、没有 kind 的节点，整个被放过 =================
 *
 * redactNodeSecrets 改之前有一道 `typeof dd.kind !== 'string' → return n`：
 * 没有 kind 就**一个字段都不看**，原样返回。
 *
 * 而 serialize() 的注释写着「这里默认脱敏而不是让调用方自己记得调 ——
 * 密钥泄露属于『忘了就出事』，不该依赖调用方的自觉」。
 * 承诺是无条件的，实现里却有一道逃生门，而且不报错、不提示 ——
 * 界面照常说「密钥不进存档」。
 *
 * 触发面看上去小（正常节点都带 kind），但落在**最需要兜住的那批数据**上：
 * 老存档、手改过的、从文件导入进来的 —— 恰恰是形态最没保证的那些。
 *
 * ================= 二、PersistedState 是摊开的 =================
 *
 * redactSecrets 用 `...state` 摊开：今天只有 canvases / activeId，
 * 两个都不含密钥，所以安全。危险在将来加字段 —— 新字段原样落盘，
 * 若它装的是凭据就是明文外流，且没有任何提示。
 *
 * 所以这里照搬画布配置那一套：类型里每个字段，要么在返回里显式处理，
 * 要么在下面的 PUBLIC_FIELDS 里登记并写明为什么它不含密钥。
 * 加字段的人必须把这个问题回答出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AF_SRC, readSrc } from './srcScan';
import { redactSecrets } from '../engine/canvasStore';
import { redactNodeSecrets } from '../engine/sanitize';

const REL_STORE = path.join('engine', 'canvasStore.ts');

/** PersistedState 类型里声明的字段（带注释，所以要剥） */
function stateFields(): string[] {
  const s = readSrc(REL_STORE);
  const at = s.indexOf('export type PersistedState = {');
  assert.notEqual(at, -1, 'canvasStore.ts 里找不到 PersistedState —— 改名了？');
  const end = s.indexOf('\n};', at);
  const blk = s.slice(at, end);
  const out: string[] = [];
  for (const line of blk.split('\n')) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
    if (m) out.push(m[1]);
  }
  assert.ok(out.length > 0, '没解析出任何字段 —— 类型写法变了？');
  return out;
}

/** 取函数返回的对象字面量的顶层键（支持 `a: 1` 与简写 `a`，剥掉 `...x`） */
function returnedKeys(rel: string, name: string): string[] {
  const s = readSrc(rel);
  const at = s.indexOf('function ' + name);
  assert.notEqual(at, -1, `找不到 function ${name}`);
  const open = s.indexOf('{', at);
  let d = 0;
  let end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d += 1;
    else if (s[i] === '}') {
      d -= 1;
      if (d === 0) { end = i; break; }
    }
  }
  const body = s.slice(open, end + 1);
  const ret = body.lastIndexOf('return {');
  assert.notEqual(ret, -1, `${name} 里找不到 return {`);
  const o2 = body.indexOf('{', ret);
  let d2 = 0;
  let e2 = -1;
  for (let i = o2; i < body.length; i++) {
    if (body[i] === '{') d2 += 1;
    else if (body[i] === '}') {
      d2 -= 1;
      if (d2 === 0) { e2 = i; break; }
    }
  }
  const lit = body.slice(o2 + 1, e2);
  const keys: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of lit) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { keys.push(cur); cur = ''; continue; }
    cur += ch;
  }
  keys.push(cur);
  return keys
    .map((k) => k.split(':')[0].trim())
    .map((k) => k.replace(/^\.\.\./, ''))
    .filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
}

const FIELDS = stateFields();

/*
 * 明确不含密钥的字段。
 *
 * 加字段时如果它确实不含密钥，就在这里登记并写清理由；
 * 如果含，就必须在 redactSecrets 的返回里显式处理它。
 * 两条路都不走 → 下面那条测试会红。
 */
const PUBLIC_FIELDS: Record<string, string> = {
  activeId: '只是当前选中画布的 id，不含任何用户数据',
};

/* ================================================================== */
/* 一、没有 kind 的节点                                                 */
/* ================================================================== */

test('行为: 没有 kind 的节点，密钥也要挖掉', () => {
  const n = { id: 'n1', data: { token: 'ghp_plain' } };
  const r = redactNodeSecrets(n) as { data: Record<string, unknown> };
  assert.equal(r.data.token, '', '没有 kind 就整个放过 —— 明文落盘');
});

test('行为: kind 不是字符串（老存档 / 手改过）也要挖掉', () => {
  const n = { id: 'n1', data: { kind: 123, llm: { apiKey: 'sk_plain' } } };
  const r = redactNodeSecrets(n) as { data: { llm: Record<string, unknown> } };
  assert.equal(r.data.llm.apiKey, '');
});

test('行为: 不带 kind 的节点走的是同一把尺子（请求头 / 名字兜底）', () => {
  const a = redactNodeSecrets({ id: 'n', data: { headersText: 'Authorization: Bearer sk_x' } }) as {
    data: Record<string, unknown>;
  };
  assert.notEqual(a.data.headersText, 'Authorization: Bearer sk_x', '请求头里的密钥要挖');
  const b = redactNodeSecrets({ id: 'n', data: { mySecretThing: 'v' } }) as {
    data: Record<string, unknown>;
  };
  assert.equal(b.data.mySecretThing, '', '名字像密钥的要挖');
});

/* ================================================================== */
/* 二、反例：别把不是密钥的也挖了                                        */
/* ================================================================== */

test('反例: 普通字段不动（防过度修复）', () => {
  /*
   * 只盯"要挖"的话，把 data 整个清空也能通过。
   * 这几条钉住判据的边界：AI 生成的文本里含 llm 字样不该被改。
   */
  const n = {
    id: 'n1',
    data: { kind: 'llm', label: '生成一段含 llm 字样的文本', text: 'llm.apiKey 是示例', maxTokens: 4096 },
  };
  const r = redactNodeSecrets(n) as { data: Record<string, unknown> };
  assert.equal(r.data.label, '生成一段含 llm 字样的文本');
  assert.equal(r.data.text, 'llm.apiKey 是示例');
  assert.equal(r.data.maxTokens, 4096, '数字参数不该被挖（与参数卡同口径）');
});

test('反例: 有 kind 的节点行为不变', () => {
  const n = { id: 'n1', data: { kind: 'github', token: 'ghp_a', repo: 'o/r' } };
  const r = redactNodeSecrets(n) as { data: Record<string, unknown> };
  assert.equal(r.data.token, '');
  assert.equal(r.data.repo, 'o/r');
});

test('反例: data 不是对象时原样返回', () => {
  assert.deepEqual(redactNodeSecrets({ id: 'n', data: 'x' }), { id: 'n', data: 'x' });
  assert.deepEqual(redactNodeSecrets('nope'), 'nope');
});

/* ================================================================== */
/* 三、PersistedState 每个字段都要有说法                                 */
/* ================================================================== */

test('守卫自身: 字段清单解析正常', () => {
  assert.ok(FIELDS.includes('canvases'), 'canvases 没解析出来 —— 后面的断言都不可信');
  assert.ok(FIELDS.includes('activeId'));
});

test('PersistedState 每个字段都要么显式处理、要么登记为不含密钥', () => {
  const keys = returnedKeys(REL_STORE, 'redactSecrets');
  for (const f of FIELDS) {
    const handled = keys.includes(f);
    const declared = Object.prototype.hasOwnProperty.call(PUBLIC_FIELDS, f);
    assert.ok(
      handled || declared,
      `PersistedState.${f} 既没在 redactSecrets 里显式处理（返回键: ${keys.join(',')}），` +
        '也没登记为不含密钥 —— 新字段会原样落盘，若它装的是凭据就是明文外流',
    );
  }
});

test('登记为不含密钥的字段，理由不许为空（防随手登记）', () => {
  for (const k of Object.keys(PUBLIC_FIELDS)) {
    assert.ok(PUBLIC_FIELDS[k].length > 5, `${k} 的理由太短 —— 说清它为什么不含密钥`);
    assert.ok(FIELDS.includes(k), `${k} 已经不在 PersistedState 里了 —— 把登记删掉`);
  }
});

test('行为: 未知字段今天仍会原样落盘（把现状钉住，不是认可它）', () => {
  /*
   * redactSecrets 用 ...state 摊开，所以类型外的字段会跟着走。
   * 这条把**当前事实**记下来：真加了字段，靠上面那条守卫逼出决定，
   * 而不是靠这里（这里红只说明形态变了，不说明安不安全）。
   */
  const st = { canvases: [], activeId: null, weird: 'x' } as never;
  const r = redactSecrets(st) as unknown as Record<string, unknown>;
  assert.equal(r.weird, 'x');
});

test('守卫自身: AF_SRC 指向真仓库', () => {
  assert.ok(AF_SRC.length > 0, 'AF_SRC 是空的');
  assert.ok(readSrc(REL_STORE).length > 2000, '读到的 canvasStore.ts 太短 —— 指错地方了');
});
