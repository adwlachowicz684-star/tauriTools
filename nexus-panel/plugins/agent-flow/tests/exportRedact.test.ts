/*
 * 导出的四种格式都要脱敏
 *
 * ============ 这个洞长什么样 ============
 *
 * 以前只有 toJson 调了 redactNodes，shell / python / markdown 拿到的是
 * **原始节点数据**。于是实测（改之前）：
 *
 *   json      泄露: sk-log-222, sk-const-333
 *   markdown  泄露: sk-live-999, sk-log-222
 *   shell     泄露: sk-live-999, sk-log-222
 *   python    泄露: sk-live-999, sk-log-222
 *
 * sk-live-999 来自 briefOf 那句 `${method} ${url}` ——
 * 说明里写着 `POST https://a.b/v1?api_key=sk-live-999`，
 * 而导出正是"交给别人"的动作。
 *
 * 而本文件那段注释写着「判据走 engine/sanitize 那一套，与工具栏导出、
 * 存模块、设为默认、存预设、复制节点同一套 —— 不在这里另写一份」，
 * 说的是四个出口都要走 —— 实际只走了一个。
 *
 * ============ 常量卡那个洞 ============
 *
 * json 那条路虽然走了 redactNodes，仍泄露 sk-const-333：
 * 常量卡是 { id, name, value } 形态 —— **密钥写在 name 里、值在 value 里**，
 * 而脱敏看的都是**键名**，键名恒为 'value' —— 永远匹配不上。
 *
 * 与参数卡（CanvasParam）是同一个形状，那边靠 paramStoredValue 显式处理了，
 * 这边没有 —— 又是一次"同一形态两个出口，只补了一边"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { exportFlow, EXPORT_FORMATS } from '../engine/scriptExport';
import { stripSecrets, hadInlineSecret } from '../engine/sanitize';
import { readSrc } from './srcScan';

const REL = path.join('engine', 'scriptExport.ts');

const n = (id: string, kind: string, data: Record<string, unknown> = {}) => ({
  id,
  type: kind,
  data: { kind, label: id, status: 'idle', output: '', error: '', ...data },
});
const g = (nodes: unknown[]) => ({ nodes, edges: [] }) as never;

const SECRETS = {
  url: 'sk-live-999',
  constCard: 'sk-const-333',
};

function graph(): never {
  return g([
    n('h1', 'generic-http', {
      method: 'POST',
      url: `https://a.b/v1?api_key=${SECRETS.url}`,
      headersText: 'Authorization: Bearer ghp_header',
    }),
    n('c1', 'const', {
      items: [
        { id: 'i1', name: 'apiKey', value: SECRETS.constCard },
        { id: 'i2', name: '接口地址', value: 'https://x.y/v1?token=sk-card-url' },
      ],
    }),
  ]);
}

/* ================================================================== */
/* 一、正例：四种格式都不能带凭据                                       */
/* ================================================================== */

for (const f of EXPORT_FORMATS) {
  test(`行为: ${f.id} 导出不含地址里的密钥`, () => {
    const t = exportFlow(graph(), f.id).text;
    assert.ok(!t.includes(SECRETS.url), `${f.id} 泄露了 ${SECRETS.url}`);
  });
  test(`行为: ${f.id} 导出不含常量卡里的密钥`, () => {
    const t = exportFlow(graph(), f.id).text;
    assert.ok(!t.includes(SECRETS.constCard), `${f.id} 泄露了 ${SECRETS.constCard}`);
  });
}

test('行为: 常量卡里 url 形态的值只挖凭据，地址本身留着', () => {
  const t = exportFlow(graph(), 'json').text;
  assert.ok(!t.includes('sk-card-url'), '凭据没挖掉');
  assert.ok(t.includes('https://x.y/v1?token='), '地址本身被整份弄丢了');
});

test('行为: 常量卡的密钥要挖空', () => {
  const out = stripSecrets({
    kind: 'const',
    items: [{ id: 'i', name: 'apiKey', value: 'sk-abc' }],
  }) as { items: { value: string }[] };
  assert.equal(out.items[0].value, '');
});

test('行为: hadInlineSecret 跟着 —— 界面提示才会出现', () => {
  assert.ok(hadInlineSecret({
    kind: 'const',
    items: [{ id: 'i', name: 'apiKey', value: 'sk-abc' }],
  }));
});

/* ================================================================== */
/* 二、反例：防过度修复                                                 */
/* ================================================================== */

test('反例: 数字常量卡不能剥（maxTokens 那类）', () => {
  const out = stripSecrets({
    kind: 'const',
    items: [{ id: 'i', name: 'maxTokens', value: '4096', valueType: 'num' }],
  }) as { items: { value: string }[] };
  assert.equal(out.items[0].value, '4096');
});

test('反例: 布尔常量卡不能剥', () => {
  const out = stripSecrets({
    kind: 'const',
    items: [{ id: 'i', name: 'enabled', value: 'true', valueType: 'bool' }],
  }) as { items: { value: string }[] };
  assert.equal(out.items[0].value, 'true');
});

test('反例: 名字不像密钥的普通卡片原样留下', () => {
  const out = stripSecrets({
    kind: 'const',
    items: [{ id: 'i', name: '输出目录', value: 'D:\\项目甲\\out' }],
  }) as { items: { value: string }[] };
  assert.equal(out.items[0].value, 'D:\\项目甲\\out');
});

test('反例: 模板引用不能剥 —— 那是引用不是密钥', () => {
  const out = stripSecrets({
    kind: 'const',
    items: [{ id: 'i', name: '令牌', value: '{{login.token}}' }],
  }) as { items: { value: string }[] };
  assert.equal(out.items[0].value, '{{login.token}}');
});

test('反例: 导出仍然有内容（脱敏不能把脚本掏空）', () => {
  const t = exportFlow(graph(), 'shell').text;
  assert.ok(t.length > 0, 'shell 导出空了');
});

/* ================================================================== */
/* 三、源码守卫                                                         */
/* ================================================================== */

test('守卫: exportFlow 自己先脱敏，而不是只让 toJson 走', () => {
  const s = readSrc(REL);
  assert.ok(s.includes('redactNodes(g.nodes)'), 'exportFlow 没调 redactNodes');
});

test('守卫自身: 源码真的读到了', () => {
  assert.ok(readSrc(REL).length > 20000, 'scriptExport.ts 太短 —— 指错地方了');
});
