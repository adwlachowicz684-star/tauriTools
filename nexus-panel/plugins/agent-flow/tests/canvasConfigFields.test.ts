/*
 * 画布配置「新增字段」的四处必须一起动
 *
 * ================= 为什么要写这个测试 =================
 *
 * CanvasConfig 是白名单式的：normalizeCanvasConfig 手抄每一个字段，
 * redactCanvasConfig 又手抄一遍。今天这样是安全的 ——
 * 未知字段被整份丢掉，密钥也就跟着没了（不算泄露，算丢数据）。
 *
 * 危险在**将来加字段**的时候，要动四处处：
 *   1. CanvasConfig 类型
 *   2. emptyCanvasConfig()
 *   3. normalizeCanvasConfig 的返回
 *   4. redactCanvasConfig 的返回
 *
 * 漏掉 4 会有两种样子，而且都不报错：
 *   - 手写返回里没它 → 每次存盘/导出都悄悄丢掉这个字段
 *   - 为了"修好上面那条"改成 `...base` 摊开 → 新字段**原样落盘**，
 *     如果它装的是密钥（比如一份新的凭据表），就是明文泄露
 *
 * 所以这里要求：类型里每个字段，四处都得显式出现；
 * 且 redactCanvasConfig **不许**用整体摊开来凑数。
 *
 * 具体到"这个字段到底含不含密钥"，没法靠扫描判 ——
 * 那是加字段的人该回答的问题，本文件只负责逼他把问题回答出来
 * （要么显式脱敏后写进返回，要么显式丢掉并写明为什么）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AF_SRC, readSrc } from './srcScan';
import { redactCanvasConfig, normalizeCanvasConfig } from '../engine/canvasStore';
import { emptyCanvasConfig } from '../engine/canvasConfig';

const REL_CFG = path.join('engine', 'canvasConfig.ts');
const REL_STORE = path.join('engine', 'canvasStore.ts');

/** CanvasConfig 类型里声明的字段（带注释，所以要剥） */
function configFields(): string[] {
  const s = readSrc(REL_CFG);
  const at = s.indexOf('export type CanvasConfig = {');
  assert.notEqual(at, -1, 'canvasConfig.ts 里找不到 CanvasConfig —— 改名了？');
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

/** 取一个具名函数的函数体（花括号配平） */
function fnBody(rel: string, name: string): string {
  const s = readSrc(rel);
  const at = s.indexOf('function ' + name);
  assert.notEqual(at, -1, `找不到 function ${name}`);
  const open = s.indexOf('{', at);
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d += 1;
    else if (s[i] === '}') {
      d -= 1;
      if (d === 0) return s.slice(open, i + 1);
    }
  }
  return '';
}

/**
 * 取返回的对象字面量的**键**（支持 `a: 1` 与 `a` 两种写法）。
 *
 * 第一版只认 `名字:` —— normalizeCanvasConfig 用的是简写 `params`，
 * 于是它报错说"没显式处理 params"，而那是**我的正则错了**，不是代码有问题。
 * 照着那条去改会去动一个本来正确的函数。
 */
function returnedKeys(rel: string, name: string): string[] {
  const body = fnBody(rel, name);
  const at = body.lastIndexOf('return {');
  assert.notEqual(at, -1, `${name} 里找不到 return {`);
  const open = body.indexOf('{', at);
  let d = 0;
  let end = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '{') d += 1;
    else if (body[i] === '}') {
      d -= 1;
      if (d === 0) { end = i; break; }
    }
  }
  const lit = body.slice(open + 1, end);
  /* 按顶层逗号切（嵌套的花括号/方括号里不算） */
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
  return keys.map((k) => k.split(':')[0].trim())
    .map((k) => k.replace(/^\.\.\./, ''))
    .filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
}

const FIELDS = configFields();

test('字段清单解析正常（守卫自身的可信度）', () => {
  assert.ok(FIELDS.includes('mcpServers'), 'mcpServers 没解析出来 —— 后面的断言都不可信');
  assert.ok(FIELDS.includes('env'));
  assert.ok(FIELDS.includes('params'));
});

/* ================================================================== */
/* 四处都要显式出现                                                     */
/* ================================================================== */

test('emptyCanvasConfig 覆盖类型里的每个字段', () => {
  const e = emptyCanvasConfig() as unknown as Record<string, unknown>;
  for (const f of FIELDS) {
    assert.ok(f in e, `emptyCanvasConfig 缺字段 ${f} —— 新字段没登记`);
  }
});

test('normalizeCanvasConfig 的返回里显式列出每个字段', () => {
  const keys = returnedKeys(REL_STORE, 'normalizeCanvasConfig');
  for (const f of FIELDS) {
    assert.ok(keys.includes(f), `normalizeCanvasConfig 没显式处理 ${f} —— 新字段会被静默丢掉（实际返回键: ${keys.join(',')}）`);
  }
});

test('redactCanvasConfig 的返回里显式列出每个字段', () => {
  const keys = returnedKeys(REL_STORE, 'redactCanvasConfig');
  for (const f of FIELDS) {
    assert.ok(keys.includes(f), `redactCanvasConfig 没显式处理 ${f} —— 新字段要么被丢掉、要么原样落盘（实际返回键: ${keys.join(',')}）`);
  }
});

/* ================================================================== */
/* 不许靠整体摊开来凑上面那条                                            */
/* ================================================================== */

test('源码守卫: redactCanvasConfig 不许整体摊开 base', () => {
  /*
   * `return { ...base, mcpServers: ... }` 也能让上面那条通过（摊开里带着新字段），
   * 而那正是最坏的一种：新字段**原样落盘**，脱敏完全没碰到它。
   * 所以这里反过来查：摊开不许有。
   */
  const body = fnBody(REL_STORE, 'redactCanvasConfig');
  assert.ok(
    !/\.\.\.base/.test(body) && !/\.\.\.cfg/.test(body) && !/\.\.\.normalized/.test(body),
    'redactCanvasConfig 用了整体摊开 —— 将来加的字段会原样落盘，脱敏碰不到它',
  );
});

/* ================================================================== */
/* 行为：未知字段今天必须是「丢掉」而不是「原样带过去」                    */
/* ================================================================== */

test('行为: 类型里没有的字段不出现在脱敏结果里', () => {
  /*
   * 这是当前实现的安全底线：白名单之外的东西一律不落盘。
   * 将来若改成"透传未知字段"，这条会红 —— 那时必须同时给出
   * 对未知字段的脱敏处理，否则就是明文泄露。
   */
  const bogus = {
    mcpServers: [],
    env: { vars: {} },
    params: [],
    someNewThing: { token: 'ghp_plain' },
  } as never;
  const r = redactCanvasConfig(bogus) as unknown as Record<string, unknown>;
  assert.ok(!('someNewThing' in r), '未知字段被原样带过去了 —— 那等于没脱敏');
  const n = normalizeCanvasConfig(bogus) as unknown as Record<string, unknown>;
  assert.ok(!('someNewThing' in n), 'normalize 也该丢掉未知字段');
});

test('行为: 三个已知字段各自都被脱敏过（不是原样透传）', () => {
  const cfg = {
    mcpServers: [{ id: 's', name: 'fs', command: 'c', env: { GITHUB_TOKEN: 'ghp_r', PLAIN: 'p' } }],
    env: { vars: { MY_TOKEN: 't', PLAIN_PATH: '/tmp' } },
    params: [
      { id: 'p1', name: 'apiKey', valueType: 'text', value: 'sk-live' },
      { id: 'p2', name: '输出目录', valueType: 'text', value: '/tmp' },
    ],
  } as never;
  const r = redactCanvasConfig(cfg);
  assert.equal(r.mcpServers[0].env?.GITHUB_TOKEN, '', '服务的 env 要脱敏');
  assert.equal(r.mcpServers[0].env?.PLAIN, 'p', '不像密钥的服务环境变量要留着');
  assert.equal(r.env.vars.MY_TOKEN, '', 'env.vars 要脱敏');
  assert.equal(r.env.vars.PLAIN_PATH, '/tmp');
  assert.equal(r.params?.[0].value, '', '参数卡要脱敏');
  assert.equal(r.params?.[1].value, '/tmp');
});

test('守卫自身: AF_SRC 指向的是真仓库（否则上面全是不可信的通过）', () => {
  /*
   * readSrc 读不到文件时会返回空串，而空串会让 indexOf 失败——
   * 但 fnBody 里已经 assert 了找得到函数，所以这里只需确认路径存在。
   */
  assert.ok(AF_SRC.length > 0, 'AF_SRC 是空的');
  assert.ok(readSrc(REL_STORE).length > 100, '读到的 canvasStore.ts 太短 —— 指错地方了');
});
