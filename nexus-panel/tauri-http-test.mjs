/**
 * 自研 Tauri http 客户端测试（开发用，可删）
 *
 * 覆盖：GET/POST 参数构造 → 分块读取与结束标记 → 无 body 状态码
 *      → maxBytes 截断 → 通道不可用时返回 null → 非 2xx 的 ok 判定
 *
 * 为什么值得测：这段是手写的 IPC 封装，替代了官方 npm 包，
 * 而沙箱里跑不了真实 Tauri —— 只能靠 mock 把流程走一遍。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./tauri-http-mock.mjs', pathToFileURL('./'));

const { state, setMock } = await import('./tauri-http-mock.mjs');
const { fetchText, postJson } = await import('./plugins/agent-flow/lib/tauri.ts');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const enc = new TextEncoder();
/** 按官方协议构造一个响应块：数据 + 1 字节结束标记 */
const chunk = (data, done) => Uint8Array.from([...enc.encode(data), done ? 1 : 0]);

/** 造一个 mock：fetch → rid，fetch_send → 状态，read_body → 依次吐块 */
function mockResponse({ status = 200, chunks: raw = ['hello'], rid = 7 }) {
  let i = 0;
  setMock({
    isTauri: true,
    invoke: async (cmd) => {
      if (cmd === 'plugin:http|fetch') return rid;
      if (cmd === 'plugin:http|fetch_send') return { status, rid: 100 };
      if (cmd === 'plugin:http|fetch_read_body') {
        if (i >= raw.length) return [];
        const c = raw[i++];
        // 字符串按 utf-8 编码，数组按原样
        return Array.from(typeof c === 'string' ? chunk(c, i === raw.length) : c);
      }
      return null;
    },
  });
}

console.log('\n=== 1. GET 基本流程 ===');
mockResponse({ chunks: ['hello world'] });
let r = await fetchText('https://example.com/feed');
t('返回文本正确', r.text === 'hello world', JSON.stringify(r.text));
t('ok 判定正确', r.ok === true && r.status === 200);
const firstCall = state.calls[0];
t('首个 IPC 是 plugin:http|fetch', firstCall.cmd === 'plugin:http|fetch');
t('method 为 GET', firstCall.args.clientConfig.method === 'GET');
t('url 透传', firstCall.args.clientConfig.url === 'https://example.com/feed', firstCall.args.clientConfig.url);
t('headers 转成 [k,v] 数组',
  Array.isArray(firstCall.args.clientConfig.headers)
  && firstCall.args.clientConfig.headers.every((h) => h.length === 2));
t('带上了 UA（B站等源不带会被拒）',
  firstCall.args.clientConfig.headers.some(([k]) => k.toLowerCase() === 'user-agent'));

console.log('\n=== 2. 分块读取与结束标记 ===');
mockResponse({ chunks: ['abc', 'def', 'ghi'] });
r = await fetchText('https://example.com/x');
t('多块按序拼接', r.text === 'abcdefghi', JSON.stringify(r.text));
t('读到结束标记后停止',
  state.calls.filter((c) => c.cmd === 'plugin:http|fetch_read_body').length === 3,
  `读了 ${state.calls.filter((c) => c.cmd === 'plugin:http|fetch_read_body').length} 次`);

console.log('\n=== 3. 无 body 状态码 ===');
mockResponse({ status: 204, chunks: [] });
r = await fetchText('https://example.com/nobody');
t('204 不读响应体', r.text === '' && r.status === 204, `text=${JSON.stringify(r.text)}`);
t('204 不去调 read_body',
  !state.calls.some((c) => c.cmd === 'plugin:http|fetch_read_body'));

console.log('\n=== 4. maxBytes 截断 ===');
// 每块 1000 字节，上限设 2500 —— 应在累计达到上限后停止
const big = 'x'.repeat(1000);
mockResponse({ chunks: Array(20).fill(big) });
r = await fetchText('https://example.com/big', { maxBytes: 2500 });
t('超长响应被截断', r.text.length >= 2000 && r.text.length <= 3000, `实际 ${r.text.length} 字节`);
t('截断后仍释放了响应体',
  state.calls.some((c) => c.cmd === 'plugin:http|fetch_cancel_body'));

console.log('\n=== 5. POST 请求体 ===');
mockResponse({ chunks: ['{"ok":true}'] });
let pj = await postJson('https://api.example.com/v1/chat', { a: 1 }, { 'Content-Type': 'application/json' }, 30);
t('POST 返回文本', pj.text === '{"ok":true}', pj.text);
const pc = state.calls[0];
t('method 为 POST', pc.args.clientConfig.method === 'POST');
t('请求体是字节数组（不是对象）', Array.isArray(pc.args.clientConfig.data));
t('字节数组能还原成原 JSON',
  new TextDecoder().decode(new Uint8Array(pc.args.clientConfig.data)) === '{"a":1}',
  new TextDecoder().decode(new Uint8Array(pc.args.clientConfig.data)));
t('自定义 header 透传',
  pc.args.clientConfig.headers.some(([k, v]) => k === 'Content-Type' && v === 'application/json'));

console.log('\n=== 6. 非 2xx 的 ok 判定 ===');
mockResponse({ status: 404, chunks: ['not found'] });
r = await fetchText('https://example.com/404');
t('404 的 ok 为 false', r.ok === false && r.status === 404);

console.log('\n=== 7. 通道不可用 → 降级 ===');
// invoke 全部抛错（插件未启用 / scope 未放行）
setMock({ isTauri: true, invoke: async () => { throw new Error('command not found'); } });
// 浏览器 fetch 也不可用时应当抛出明确错误，而不是静默返回空
const origFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('网络不可达'); };
let threw = false;
try { await fetchText('https://example.com/x'); } catch { threw = true; }
globalThis.fetch = origFetch;
t('两条通道都失败时抛错（不假装成功）', threw);
t('失败前确实尝试过 Tauri 通道',
  state.calls.some((c) => c.cmd === 'plugin:http|fetch'));

console.log('\n=== 8. 非 Tauri 环境 ===');
setMock({ isTauri: false, invoke: async () => 1 });
globalThis.fetch = async () => new Response('browser', { status: 200 });
r = await fetchText('https://example.com/x');
globalThis.fetch = origFetch;
t('浏览器模式下走原生 fetch', r.text === 'browser', r.text);
t('浏览器模式下不调 IPC',
  !state.calls.some((c) => c.cmd === 'plugin:http|fetch'));

console.log('\n=== 9. 失败原因可区分（A-04） ===');
// 原来一律 catch 成 null，UI 只能说"受 CORS 限制"；
// 现在要能分清"插件没启用"和"域名没放行"，提示才能直指该改的地方。
const { describeHttpFailure } = await import('./plugins/agent-flow/lib/tauri.ts');

const reasonOf = async (errText) => {
  setMock({ isTauri: true, invoke: async () => { throw new Error(errText); } });
  const f = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('浏览器通道也不可用'); };
  let msg = '';
  try { await fetchText('https://example.com/x'); } catch (e) { msg = String(e.message); }
  globalThis.fetch = f;
  return msg;
};

let m = await reasonOf('command not found: plugin:http|fetch');
t('插件未启用 → 提示去注册插件', m.includes('插件未启用'), m);
t('插件未启用 → 不再甩锅给 CORS', !m.includes('请用桌面端运行'), m);

m = await reasonOf('http scope not allowed for url https://example.com');
t('域名未放行 → 提示去加 scope', m.includes('未放行'), m);

m = await reasonOf('connection reset by peer');
t('通道正常但请求失败 → 归到网络问题', m.includes('请求失败'), m);

t('describeHttpFailure 对三类给出不同文案',
  new Set(['no-plugin', 'no-scope', 'request'].map((k) =>
    describeHttpFailure({ kind: k, message: 'x' }))).size === 3);

console.log('\n=== 10. POST 响应体上限（A-03） ===');
// 每块 1MB，共 20 块 —— 不设限会整包进内存
const mb = 'y'.repeat(1024 * 1024);
mockResponse({ chunks: Array(20).fill(mb) });
const before = state.calls.length;
pj = await postJson('https://api.example.com/v1/chat', { a: 1 }, {}, 30);
t('POST 响应被截断在 8MB 内', pj.text.length <= 8 * 1024 * 1024,
  `${(pj.text.length / 1024 / 1024).toFixed(1)}MB`);
t('确实读了数据（不是空返回）', pj.text.length > 0);
t('截断后释放了响应体',
  state.calls.slice(before).some((c) => c.cmd === 'plugin:http|fetch_cancel_body'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
