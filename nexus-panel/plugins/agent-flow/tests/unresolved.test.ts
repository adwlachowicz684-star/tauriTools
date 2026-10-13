/**
 * 未渲染的模板变量，不能落到"有副作用"的参数上。
 *
 * 运行：bash scripts/run-tests.sh unresolved
 *
 * ================= 这类失效的共同形状 =================
 *
 * 参数支持 {{上游.output}}，编辑期 `{{n1.output}}` 是一个**合法的非空值**，
 * 圆点是绿的（校验只看填了没填）。运行时 n1 没产出，模板原样保留，
 * 于是执行器收到字面量：
 *
 *   路径   → 磁盘上多出一个叫 `{{n1.output}}` 的东西
 *   命令   → 真的执行了一条带字面量的命令（副作用已经发生）
 *   推送   → 字面量被提交到远端仓库，留在提交历史里
 *
 * 三者**都不报错、日志干净**，而结果完全不是用户要的。
 * 所以这里是"跑了但结果是错的"，比直接失败难查得多。
 *
 * ================= 为什么判据只有一处 =================
 *
 * "哪些变量没解析"renderTemplate 早就算出来并记在 missing 里，
 * 由 ctx.render 交出来（见 engine/runContext）。执行器**直接用真实结论**，
 * 不拿正则对着文本重扫 —— 重扫是同一件事的第二份实现，而且更粗糙
 * （正文里本来就带 {{}} 的节点会被误判）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph, type RunEvent } from '../engine/runner';
import { readSrc } from './srcScan';
import { makeGithubPushNode } from '../types';

/* ================================================================== */
/* 跑一个节点，返回「有没有真的调到副作用」与失败原因                    */
/* ================================================================== */

type Outcome = { called: boolean; ok: boolean; error: string };

async function runOne(
  node: Record<string, unknown>,
  opts: Record<string, unknown>,
): Promise<Outcome> {
  const events: RunEvent[] = [];
  await runGraph(
    { nodes: [node], edges: [] } as never,
    { concurrency: 1, onEvent: (e: RunEvent) => events.push(e), ...opts } as never,
  );
  const done = events.filter((e) => e.type === 'node-done');
  const last = done[done.length - 1] as { ok?: boolean; error?: string } | undefined;
  return { called: false, ok: last?.ok !== false, error: String(last?.error ?? '') };
}

/* ================================================================== */
/* 命令行节点                                                          */
/* ================================================================== */

/** 命令行节点：prompt 里写引用，上游不存在 → 引用未解析 */
async function runTaskNode(prompt: string): Promise<Outcome & { ran: boolean }> {
  const events: RunEvent[] = [];
  let ran = false;
  await runGraph(
    { nodes: [{ id: 't1', data: { kind: 'task', label: '命令', cli: 'codebuddy', prompt } }], edges: [] } as never,
    {
      concurrency: 1,
      executor: async () => { ran = true; return 'ok'; },
      onEvent: (e: RunEvent) => events.push(e),
    } as never,
  );
  const done = events.filter((e) => e.type === 'node-done');
  const last = done[done.length - 1] as { ok?: boolean; error?: string } | undefined;
  return { called: ran, ran, ok: last?.ok !== false, error: String(last?.error ?? '') };
}

test('行为：命令里有未渲染变量时不执行（否则真的跑一条带字面量的命令）', async () => {
  const r = await runTaskNode('移动 data 到 {{dest}}');
  assert.equal(r.ran, false, '不该真的交给命令行执行');
  assert.equal(r.ok, false, '要判失败，不能让节点绿着');
  assert.match(r.error, /没渲染出来的模板变量/);
});

/** 反向：只盯"有没有拦"的话，全拦也算通过 —— 正常命令必须真的跑 */
test('行为：命令正常时照常执行', async () => {
  const r = await runTaskNode('echo hi');
  assert.equal(r.ran, true, '正常命令要真的执行');
  assert.equal(r.ok, true);
});

/**
 * 反向中更要紧的一条：**上游产出里带 {{}} 不能误判**。
 *
 * 这正是"重扫文本"那份实现会错的地方：它认的是"渲染后还有 {{}} 形状"，
 * 而上游输出本身就是一段带大括号的文本（写文档/写代码的节点很常见）时，
 * 明明取到了值也会被判成未解析 —— 命令平白不执行。
 * missing 是真实结论，不受输出内容影响。
 */
test('行为：上游产出里带 {{}} 不误判（重扫文本那份实现会错在这）', async () => {
  const events: RunEvent[] = [];
  const ran: string[] = [];
  await runGraph(
    {
      nodes: [
        { id: 'n1', data: { kind: 'task', label: '产出', cli: 'codebuddy', prompt: '写一段' } },
        { id: 'n2', data: { kind: 'task', label: '命令', cli: 'codebuddy', prompt: 'echo {{n1.output}}' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    } as never,
    {
      concurrency: 1,
      executor: async (node: { id: string }) => {
        ran.push(node.id);
        return node.id === 'n1' ? '模板 {{字面量}} 示例' : 'ok';
      },
      onEvent: (e: RunEvent) => events.push(e),
    } as never,
  );
  assert.deepEqual(ran, ['n1', 'n2'], 'n2 引用取到了值，就该照常执行');
  const done = events.filter((e) => e.type === 'node-done');
  assert.equal((done[done.length - 1] as { ok?: boolean }).ok !== false, true);
});

/* ================================================================== */
/* GitHub 推送节点                                                     */
/* ================================================================== */

async function runPushNode(
  partial: Record<string, string>,
): Promise<Outcome & { pushed: boolean }> {
  const events: RunEvent[] = [];
  let pushed = false;
  await runGraph(
    { nodes: [makeGithubPushNode('p1', partial as never)], edges: [] } as never,
    {
      concurrency: 1,
      githubPush: async () => { pushed = true; return { ok: true, commit: 'abc' }; },
      onEvent: (e: RunEvent) => events.push(e),
    } as never,
  );
  const done = events.filter((e) => e.type === 'node-done');
  const last = done[done.length - 1] as { ok?: boolean; error?: string } | undefined;
  return { called: pushed, pushed, ok: last?.ok !== false, error: String(last?.error ?? '') };
}

const basePush = { owner: 'o', repo: 'r', message: 'msg', token: 't' };

test('行为：推送路径未渲染时不推（否则仓库里多出字面量文件）', async () => {
  const r = await runPushNode({ ...basePush, filesText: 'notes/{{date}}.txt=内容' });
  assert.equal(r.pushed, false, '不该推送');
  assert.equal(r.ok, false);
  assert.match(r.error, /没渲染出来的模板变量/);
});

test('行为：推送内容未渲染时不推（字面量会留在提交历史里）', async () => {
  const r = await runPushNode({ ...basePush, filesText: 'a.txt={{n1.output}}' });
  assert.equal(r.pushed, false, '不该推送');
  assert.match(r.error, /没渲染出来的模板变量/);
});

test('行为：提交说明未渲染时不推', async () => {
  const r = await runPushNode({ ...basePush, filesText: 'a.txt=x', message: 'chore: {{msg}}' });
  assert.equal(r.pushed, false, '不该推送');
  assert.match(r.error, /没渲染出来的模板变量/);
});

/** 反向：正常推送必须真的发出去 */
test('行为：推送正常时照常提交', async () => {
  const r = await runPushNode({ ...basePush, filesText: 'a.txt=内容' });
  assert.equal(r.pushed, true, '正常推送要真的发出去');
  assert.equal(r.ok, true);
});

/* ================================================================== */
/* 源码守卫：三处出口都必须接上真实结论                                 */
/* ================================================================== */

const runnerSrc = (f: string): string => readSrc(`engine/runners/${f}`);

/**
 * 为什么不能用"文件里出现过 unresolvedIssue"这种宽判据：
 * 把调用改成 `if (false && ...)`，调用还在、就是不生效 ——
 * 而上面那些**行为测试**会红。这里守的是"接上了"，两者缺一不可。
 */
test('守卫：三个有副作用的出口都接上了未渲染结论', () => {
  for (const f of ['fs.ts', 'task.ts', 'githubPush.ts']) {
    const s = runnerSrc(f);
    assert.ok(s.length > 0, `${f} 读不到源码（AF_SRC 指错会集体假失败）`);
    /*
     * 只认 `.missing` 的来源，不认具体写法：
     * fs.ts 是把 missing 交给 fsRenderIssue（判据在 files.ts），
     * task / push 是自己判 length。判据写法不同，**来源必须一致** ——
     * 而"有没有真的生效"由上面的行为测试兜住，这里只守"接上了"。
     */
    assert.match(s, /\.missing\b/, `${f} 没有用 render 交出来的 missing`);
    assert.match(s, /(unresolvedIssue|fsRenderIssue)\(/, `${f} 没有用统一文案`);
  }
});

/**
 * 执行器不许自己重扫文本 —— 那是同一件事的第二份实现。
 * 只盯 fs/task/push 三个是不够的：将来加的第四处会照抄老写法。
 */
test('守卫：执行器不许拿正则重扫未渲染（判据只能有一处）', () => {
  const files = ['fs.ts', 'task.ts', 'githubPush.ts', 'github.ts', 'genericHttp.ts', 'update.ts'];
  for (const f of files) {
    const s = runnerSrc(f);
    if (!s) continue; // 文件不存在就跳过，别把"读不到"当成通过
    assert.doesNotMatch(s, /tokenRe/, `${f} 不该自己重扫模板`);
  }
});
