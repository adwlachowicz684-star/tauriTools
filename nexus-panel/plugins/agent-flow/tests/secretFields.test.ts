import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_PATHS, stripSecrets, hadInlineSecret,
  redactHeadersText, headersHaveSecret, looksLikeSecretHeader,
} from '../engine/sanitize';
import { parseHeaders } from '../engine/headers';
import { redactNodes } from '../engine/canvasStore';
import { readSrc } from './srcScan';

/**
 * 脱敏必须覆盖完整的一份密钥清单 —— 这是密钥**唯一**的防线。
 *
 * 以前 engine/canvasStore.ts 自己抄了一份 SECRET_FIELDS：
 *   ['llm.apiKey', 'token']        ← 少了 'config.token'
 * 而 engine/sanitize.ts 的 SECRET_PATHS 是：
 *   ['token', 'llm.apiKey', 'config.token']
 *
 * 于是 webhook 触发器的校验 token（存在 data.config.token）：
 *   · 被 stripSecrets 认出来（面板提示"不会存进默认"）
 *   · 却**不会被挖空**
 * → 明文留在画布存档与导出文件里。
 *
 * 现在内联密钥**不再落盘**（原保险箱已移除），所以脱敏是唯一的防线：
 * 漏掉一个字段，那个密钥就直接以明文进存档、进导出文件。
 *
 * webhook token 泄露意味着别人能伪造请求触发你的工作流，
 * 而工作流能起 CLI、读写授权目录。
 */

const N = (id: string, data: Record<string, unknown>) => ({ id, data: { ...data } });

test('config.token 会被脱敏（webhook 校验密钥）', () => {
  const out = redactNodes([
    N('t1', { kind: 'trigger', config: { token: 'SECRET123', port: 8787 } }),
  ]) as never[];
  const first = (out as unknown as { data: Record<string, unknown> }[])[0];
  const cfg = out[0].data.config as Record<string, unknown>;
  assert.equal(cfg.token, '', 'webhook token 必须被挖空');
  assert.equal(cfg.port, 8787, '非密钥字段不能被动');
});

test('token（GitHub 节点）仍会被脱敏', () => {
  const out = redactNodes([N('g1', { kind: 'githubUpdate', token: 'ghp_x' })]) as never[];
  assert.equal((out as unknown as { data: Record<string, unknown> }[])[0].data.token, '');
});

test('llm.apiKey 仍会被脱敏', () => {
  const out = redactNodes([N('o1', { kind: 'ocr', llm: { apiKey: 'sk-x', model: 'm' } })]) as never[];
  const llm = (out as unknown as { data: Record<string, unknown> }[])[0].data.llm as Record<string, unknown>;
  assert.equal(llm.apiKey, '');
  assert.equal(llm.model, 'm', '同层的非密钥字段要保留');
});

test('三种密钥都会被挖空（脱敏是唯一防线）', () => {
  /*
   * 内联密钥不再落盘，所以"被挖空"就是它不出存档的全部保障：
   * 少挖一个字段，那个密钥就以明文进了画布存档与导出文件。
   */
  const nodes = [
    N('g1', { kind: 'githubUpdate', token: 'TOK_A' }),
    N('o1', { kind: 'ocr', llm: { apiKey: 'TOK_B' } }),
    N('t1', { kind: 'trigger', config: { token: 'TOK_C' } }),
  ];
  const json = JSON.stringify(redactNodes(nodes));
  assert.equal(json.includes('TOK_A'), false, 'token 要被挖空');
  assert.equal(json.includes('TOK_B'), false, 'llm.apiKey 要被挖空');
  assert.equal(json.includes('TOK_C'), false, 'config.token 要被挖空（以前漏的就是这条）');
});

test('没有密钥时脱敏不改动内容', () => {
  const nodes = [N('n1', { kind: 'log', msg: 'hi' })];
  assert.deepEqual(redactNodes(nodes), nodes);
});

test('非节点形态的数据不会被误改（避免误伤用户文本）', () => {
  /*
   * redactNode 只认 { id, data:{kind} }。
   * 用户让 AI 生成一段含 llm 字样的文本，不该被改写。
   */
  const out = redactNodes([{ id: 'x', data: { kind: 'task', output: 'the llm said token' } }]) as never[];
  assert.equal((out as unknown as { data: Record<string, unknown> }[])[0].data.output, 'the llm said token');
});

/* ---------------- 清单本身 ---------------- */

test('SECRET_PATHS 覆盖三类已知密钥', () => {
  for (const p of ['token', 'llm.apiKey', 'config.token']) {
    assert.ok(
      (SECRET_PATHS as readonly string[]).includes(p),
      `SECRET_PATHS 应包含 ${p}`,
    );
  }
});

/* ---------------- 请求头里的密钥 ---------------- */

/**
 * 请求头是"最顺手写 Authorization: Bearer xxx"的地方。
 *
 * SECRET_PATHS 是三条**固定路径**，认不出"名字由用户随便起"的字段。
 * 于是三处全漏，且每一处都不报错：
 *   · redactNodes    → 明文进 localStorage 与导出的画布文件
 *   · stripSecrets   → 明文进分享出去的自定义预设
 *   · hadInlineSecret → 返回 false，界面不提示（等于暗示"这里安全"）
 *
 * 实测（修之前）：
 *   HTTP headersText     : "Authorization: Bearer sk-live-123\nX-Foo: bar"
 *   hadInlineSecret      : false
 */

const H = (headersText: string) =>
  ({ id: 'h1', data: { kind: 'genericHttp', url: 'https://x', headersText } });

const redactedHeaders = (src: string): string => {
  const out = redactNodes([H(src)]) as unknown as { data: Record<string, unknown> }[];
  return String(out[0].data.headersText ?? '');
};

test('请求头里的 Authorization 会被挖空，普通头不动', () => {
  const text = redactedHeaders('Authorization: Bearer sk-live-123\nX-Foo: bar');
  assert.equal(text.includes('sk-live-123'), false, 'Bearer 令牌必须挖掉');
  assert.equal(text.includes('X-Foo: bar'), true, '普通请求头不能被动');
});

test('Cookie / X-Api-Key 这类也认得出来', () => {
  const text = redactedHeaders('Cookie: session=abc\nX-Api-Key: k-1\nAccept: application/json');
  assert.equal(text.includes('session=abc'), false, 'Cookie 带会话凭据');
  assert.equal(text.includes('k-1'), false);
  assert.equal(text.includes('Accept: application/json'), true);
});

test('挖空只挖值、留名字 —— 用户看得到哪一条要重填', () => {
  assert.equal(redactedHeaders('Authorization: Bearer abc').trim(), 'Authorization:');
});

test('注释行里的令牌也挖（它一样以明文躺在存档里）', () => {
  const text = redactedHeaders('# Authorization: Bearer commented');
  assert.equal(text.includes('commented'), false);
  assert.equal(text.trim().startsWith('#'), true, '注释标记要留着');
});

test('没有请求头密钥时内容原样不动', () => {
  const src = 'Content-Type: application/json\nX-Trace: 1';
  assert.equal(redactedHeaders(src), src);
});

test('stripSecrets 也会挖请求头（预设分享不能把令牌带出去）', () => {
  const out = stripSecrets({ kind: 'genericHttp', headersText: 'Authorization: Bearer sk-1' });
  assert.equal(String(out.headersText).includes('sk-1'), false);
});

test('hadInlineSecret 认得出请求头里的密钥（界面要提示）', () => {
  assert.equal(
    hadInlineSecret({ kind: 'genericHttp', headersText: 'Authorization: Bearer sk-1' }),
    true,
    '有密钥就该提示用户"这部分不会存进去"',
  );
  assert.equal(
    hadInlineSecret({ kind: 'genericHttp', headersText: 'Accept: application/json' }),
    false,
  );
});

test('Authorization / Cookie 必须判为密钥头（它们不含 token 字样）', () => {
  for (const n of ['Authorization', 'authorization', 'Cookie', 'X-Api-Key', 'X-Token']) {
    assert.ok(looksLikeSecretHeader(n), `${n} 应判为密钥头`);
  }
  for (const n of ['Content-Type', 'Accept', 'X-Request-Id']) {
    assert.equal(looksLikeSecretHeader(n), false, `${n} 不该判为密钥头`);
  }
});

/*
 * 端到端守卫：用**执行器同一份解析器**反着验一遍。
 *
 * 为什么这么写：脱敏侧若自己另写一份解析，两份迟早漂移 ——
 * 表现是"执行器真把令牌发出去了，脱敏却没认出来"，而这种漏认不报错。
 * 所以这里走 parseHeaders → 找出密钥头 → 确认脱敏后值真的空了，
 * 顺带确认普通头没被挖过头。
 */
test('守卫: 执行器真会发出的密钥头，脱敏后必须为空', () => {
  const samples = [
    'Authorization: Bearer abc',
    'authorization:bearer abc',
    'X-Token: t\nContent-Type: application/json',
    'Cookie: session=1',
    'X-Api-Key: k\nAccept: */*',
  ];
  for (const s of samples) {
    const before = parseHeaders(s);
    const secretNames = Object.keys(before).filter((n) => looksLikeSecretHeader(n));
    assert.ok(secretNames.length > 0, `样例应当含密钥头: ${JSON.stringify(s)}`);
    const after = parseHeaders(redactHeadersText(s));
    for (const n of secretNames) {
      assert.equal(after[n], '', `${n} 的值必须被挖空`);
    }
    for (const n of Object.keys(before)) {
      if (looksLikeSecretHeader(n)) continue;
      assert.equal(after[n], before[n], `普通头 ${n} 不能被动`);
    }
  }
});

test('守卫: headersHaveSecret 与 redactHeadersText 口径一致', () => {
  for (const s of ['Authorization: Bearer a', 'Accept: */*', '# Authorization: Bearer a', '']) {
    assert.equal(
      redactHeadersText(s) !== s,
      headersHaveSecret(s),
      `有密钥就该改动、没有就不该动: ${JSON.stringify(s)}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 固定路径覆盖不到的那两处                                            */
/* ------------------------------------------------------------------ */

/**
 * SECRET_PATHS 是点号路径枚举，表达不了数组下标，也管不到没进清单的字段。
 * 实测这两处此前是**明文落盘**的：
 *
 *   触发器   entries[].config.token   —— webhook 校验令牌，
 *            泄露意味着别人能伪造请求触发你的工作流（能起 CLI、读写授权目录）
 *   检测更新 biliCookie / targets[].biliCookie —— 整条会话 Cookie，
 *            用来绕过风控，名字里却不含 token / key 字样
 *
 * 两处都不报错：hadInlineSecret 也返回 false，
 * 于是界面上那句"不会存进默认"根本不出现 —— 用户以为自己填的东西是安全的。
 */
test('触发器 entries[].config.token 会被挖空（数组路径）', () => {
  const out = redactNodes([
    N('t1', {
      kind: 'trigger',
      entries: [{ id: 'te1', kind: 'webhook', enabled: true, config: { token: 'WH_SECRET', port: 8787, path: '/hooks/run' } }],
    }),
  ]) as never[];
  const cfg = (out as unknown as { data: Record<string, unknown> }[])[0]
    .data.entries[0].config as Record<string, unknown>;
  assert.equal(cfg.token, '', 'webhook 校验令牌必须被挖空');
  assert.equal(cfg.port, 8787, '同层的非密钥字段要保留');
  assert.equal(cfg.path, '/hooks/run', '同层的非密钥字段要保留');
});

test('biliCookie 会被挖空（顶层与 targets 里）', () => {
  const out = redactNodes([
    N('u1', {
      kind: 'update',
      biliCookie: 'SESSDATA=top',
      targets: [
        { id: 'g1', kind: 'bili', enabled: true, biliUid: '123', biliCookie: 'SESSDATA=inner' },
        { id: 'g2', kind: 'wechat', enabled: true, feedUrl: 'https://example.com/feed.xml' },
      ],
    }),
  ]) as never[];
  const d = (out as unknown as { data: Record<string, unknown> }[])[0].data;
  const t = d.targets as Record<string, unknown>[];
  assert.equal(d.biliCookie, '', '顶层 biliCookie 必须被挖空');
  assert.equal(t[0].biliCookie, '', 'targets 里的 biliCookie 必须被挖空');
  assert.equal(t[0].biliUid, '123', '同层的非密钥字段要保留');
  assert.equal(t[1].feedUrl, 'https://example.com/feed.xml', '普通订阅地址不能被动');
});

test('这两处也会被 hadInlineSecret 认出来（界面提示才出现）', () => {
  /*
   * 只挖空还不够：hadInlineSecret 若返回 false，面板上的
   * "这部分不会存进默认"就不会出现 —— 用户以为填的东西是安全的。
   * 所以它必须与"会不会被挖空"同口径。
   */
  assert.equal(hadInlineSecret({
    kind: 'trigger',
    entries: [{ id: 'te1', kind: 'webhook', config: { token: 'x' } }],
  }), true, '触发器 entries 里的 token 要被认出来');
  assert.equal(hadInlineSecret({ kind: 'update', biliCookie: 'x' }), true, 'biliCookie 要被认出来');
  assert.equal(hadInlineSecret({ kind: 'update', targets: [{ kind: 'bili', biliCookie: 'x' }] }), true);
  assert.equal(hadInlineSecret({ kind: 'log', msg: 'hi' }), false, '没有密钥时不该误报');
});

test('预设分享也会带上这两处（stripSecrets 要一起挖）', () => {
  const s = stripSecrets({
    kind: 'trigger',
    entries: [{ id: 'te1', kind: 'webhook', config: { token: 'WH', port: 8787 } }],
    biliCookie: 'SESS',
  });
  assert.equal((s.entries as Record<string, unknown>[])[0].config.token, '', '预设里的 webhook token 要挖空');
  assert.equal((s.entries as Record<string, unknown>[])[0].config.port, 8787, '非密钥字段要保留');
  assert.equal(s.biliCookie, '', '预设里的 biliCookie 要挖空');
});

/*
 * 取某个导出函数**自己的函数体**，不取整个文件。
 *
 * 以前这条守卫查的是"文件里出现 blankSecretNamed(" —— 那是假守卫：
 * hadInlineSecret 里也调了一次，于是把脱敏那条摘掉，照样匹配得上。
 * 盯不住的守卫比没有更糟：它红的时候人以为是别处的错，绿的时候其实什么也没盯。
 */
function bodyOf(src: string, name: string): string {
  const i = src.indexOf(`export function ${name}(`);
  assert.notEqual(i, -1, `${name} 找不到`);
  const j = src.indexOf('\nexport ', i + 1);
  return j === -1 ? src.slice(i) : src.slice(i, j);
}

test('守卫: redactNode 走了按名字兜底（退化成只靠路径会红）', () => {
  /*
   * 判定本体已收进 ./sanitize（模块 / 变量 / 画布存档共用一份），
   * 所以这里盯的是 sanitize 里的两个节点脱敏入口各自的函数体。
   */
  const san = readSrc('engine/sanitize.ts');
  /*
   * 链条是 redactNodes → redactNodeSecrets → blankSecretNamed：
   * 数组入口只做转发，按名字兜底发生在判定本体里。
   * 所以两处各钉一头 —— 少钉一头，"把兜底摘掉只留路径判定"就抓不住。
   */
  assert.ok(
    /blankSecretNamed\(/.test(bodyOf(san, 'redactNodeSecrets')),
    'redactNodeSecrets 必须走按名字兜底 —— 只靠 SECRET_PATHS 会漏掉数组里的密钥',
  );
  assert.ok(
    /redactNodeSecrets\b/.test(bodyOf(san, 'redactNodes')),
    'redactNodes 必须转发到判定本体，不能自己再实现一遍（抄一份就会漏兜底）',
  );
});

test('守卫: cookie 进了密钥名字清单，且全 engine 只有一份', () => {
  const san = readSrc('engine/sanitize.ts');
  assert.ok(/'cookie'/.test(san), 'sanitize 的 SECRET_NAME_HINTS 要含 cookie');
  /*
   * 以前 canvasStore 里内联过一份 hints（且少了 'api_key'），
   * 那条"两份都要有 cookie"的检查盯的正是那份副本 —— 副本删了它就红，
   * 而红的理由是"守卫盯错了地方"，不是"代码错了"。
   *
   * 现在改为：engine 下不许再有第二份 hints。'passwd' 是这个清单里
   * 最具特征、又不可能因别的原因出现的串，拿它当标记。
   */
  for (const f of ['engine/canvasStore.ts', 'engine/customPresets.ts', 'engine/nodeDefaults.ts']) {
    assert.ok(
      !/'passwd'/.test(readSrc(f)),
      `${f} 里出现了内联的密钥 hints 副本 —— 判据只此一份，抄一份必然漂移`,
    );
  }
});
