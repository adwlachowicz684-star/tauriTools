import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpStateOf, isRunnable, type GlobalMcpServer } from '../engine/mcpServers';
import { readSrc } from './srcScan';

const s = (name: string, extra: Partial<GlobalMcpServer> = {}): GlobalMcpServer =>
  ({ id: 'i', name, ...extra }) as GlobalMcpServer;

/* ============ 行为 ============ */

test('两个都空 → 配置不全', () => {
  const st = mcpStateOf(s('a'));
  assert.equal(st.on, false);
  assert.equal(st.label, '配置不全');
  assert.ok(st.hint.length > 0, '要说清缺什么');
});

test('填了地址 → 已就绪（HTTP 已接上）', () => {
  const st = mcpStateOf(s('a', { url: 'http://x' }));
  assert.equal(st.on, true);
  assert.equal(st.label, '已就绪');
});

/*
 * 这是本轮最关键的一条：
 * stdio 还没接上（stdioSupported() 为 false），所以它**不能**显示"已就绪"——
 * 而它又填得规规矩矩，也不能说成"配置不全"（用户会一直去改一个本来就对的配置）。
 * 必须是第三种状态，且 hint 要指向真正能做的（改 HTTP 地址）。
 */
test('只填 command → stdio 未接入，且提示改用 HTTP', () => {
  const st = mcpStateOf(s('a', { command: 'npx -y x' }));
  assert.equal(st.on, false);
  assert.equal(st.label, 'stdio 未接入');
  assert.ok(st.hint.includes('HTTP'), 'hint 要指向真正能做的事');
});

/*
 * 直击那个假象：stdio 还没接上，却显示"已就绪"。
 *
 * 用户看到绿勾就去用，而这个服务**根本连不上** ——
 * 比显示"未接入"糟得多：后者至少是明确的。
 */
test('只填 command 的服务绝不能显示"已就绪"（它连不上）', () => {
  const st = mcpStateOf(s('a', { command: 'npx -y x' }));
  assert.notEqual(st.label, '已就绪');
  assert.equal(st.on, false, '绿勾意味着能连，而 stdio 连不上');
});

test('stdio 与「配置不全」是两种状态 —— 不能并成一种', () => {
  assert.notEqual(mcpStateOf(s('a')).label, mcpStateOf(s('b', { command: 'x' })).label);
});

test('判据与真正去连时用的是同一份（有 url 就走 http）', () => {
  assert.equal(mcpStateOf(s('a', { command: 'x', url: 'http://x' })).label, '已就绪');
});

/* ============ 源码守卫：三个 prop 都要真的接上 ============ */

/*
 * 这三个 prop 此前**全部没传**：
 *   mcpProtocolReady → 所有服务恒显示"未接入协议"（已由 mcpStateOf 取代）
 *   onMcpRefresh     → 面板上根本没有刷新按钮（onRefresh ? … : null）
 *   mcpRefreshing    → 按钮永远不显示"刷新中…"
 */
test('源码守卫：App 必须把刷新入口传给密钥面板', () => {
  const src = readSrc('App.tsx');
  const i = src.indexOf('<CredentialPanel');
  assert.ok(i >= 0);
  const seg = src.slice(i, i + 900);
  assert.ok(/onMcpRefresh\s*=/.test(seg), '不传就没有刷新按钮 —— 用户改完配置只能干等防抖');
  assert.ok(/mcpRefreshing\s*=/.test(seg), '不传就永远看不到"刷新中…"');
  assert.ok(
    !/mcpProtocolReady/.test(seg),
    'protocolReady 没人传过（恒 undefined）—— 已被按服务的 mcpStateOf 取代',
  );
});

test('源码守卫：面板不许把死 prop 请回来', () => {
  const m = readSrc('components/McpServersPanel.tsx');
  assert.ok(!/protocolReady/.test(m));
  assert.ok(/mcpStateOf/.test(m));
});

test('源码守卫：mcpStateOf 用协议层的传输判据（不是界面页签那套）', () => {
  const src = readSrc('engine/mcpServers.ts');
  const i = src.indexOf('export function mcpStateOf');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/protocolTransportOf/.test(body), '要用 mcpClient 那份（真正去连时用的）');
  assert.ok(
    !/(?<![a-zA-Z])transportOf\(/.test(body),
    '本文件的 transportOf 返回 local/remote，是给页签用的 —— 混用会"面板说能连、连的时候说不能"',
  );
});
