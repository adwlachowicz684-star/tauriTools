import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import { resolveSecret } from '../credentials';
import type { HttpRequester } from '../runTypes';
import type { GenericHttpNodeData } from '../../types';
/** 请求头解析走 headers.ts —— 脱敏用的是同一份，各写一份必然漂移 */
import { parseHeaders } from '../headers';

/**
 * 解析请求头文本：每行 `Name: value`，忽略空行与 # 开头的注释行。
 *
 * 搬到了 engine/headers.ts：脱敏也要按同样规则认请求头，
 * 两边各写一份必然漂移（执行器认得、脱敏不认得 = 密钥明文进存档）。
 */

/**
 * 通用 HTTP 请求节点。
 *
 * "参数型自定义节点"的主力：填地址 / 方法 / 请求头 / 请求体就能调任意接口，
 * 接入一个新的外部服务不用再写一份节点定义。
 *
 * 能力由 nodeRequires.ts 声明（httpRequester），缺失时的报错由 withNodeRun
 * 统一给出，这里不重复判断。
 */
export async function runGenericHttp(ctx: RunContext): Promise<void> {
  const { id, node, opts, emit } = ctx;
  const d = node.data as GenericHttpNodeData;

  await withNodeRun(ctx, async () => {
    const url = ctx.tpl(d.url ?? '').trim();
    if (!url) throw new NodeFailError('请填写请求地址');

    const headers = parseHeaders(ctx.tpl(d.headersText ?? ''));

    // 请求体只在有语义的方法上发；GET/DELETE 带 body 会被部分服务端直接拒
    const withBody = d.method === 'POST' || d.method === 'PUT' || d.method === 'PATCH';
    const body = withBody ? ctx.tpl(d.body ?? '') : '';

    if (withBody && d.bodyIsJson && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    // 连接优先于内联：走连接库的令牌不进画布数据，导出时不会带走
    const token = resolveSecret(opts.credentials ?? [], d.credentialId, '');
    if (token && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }

    emit({ type: 'node-start', id, rendered: `${d.method} ${url}` });

    /*
     * 不用 `opts.httpRequester!` 非空断言 —— 这里其实不需要：
     * 能力缺失时 withNodeRun 已经抛过了，能走到这儿说明一定存在。
     * 用 as 收住类型即可，断言反而会掩盖"其实可能没注入"的情况。
     */
    const requester = opts.httpRequester as HttpRequester;
    const res = await requester(url, {
      method: d.method,
      headers,
      body: body || undefined,
      timeoutSec: d.timeoutSec,
      maxBytes: Math.max(1, d.maxBytesKb) * 1024,
      /*
       * 带上本节点的中断信号。
       *
       * 不传的话，超时之后这次请求仍会占满它自己的 timeoutSec：
       * 节点已经标红失败了，界面上却还要再等一会儿才真正结束。
       */
      signal: ctx.signal,
    });

    const fields = {
      status: String(res.status),
      ok: String(res.ok),
      len: String(res.text.length),
    };

    if (!res.ok && d.failOnHttpError) {
      // 带上响应体：多数 API 的错误原因都写在 body 里，只报状态码没法排查
      const brief = res.text.slice(0, 300);
      throw new NodeFailError(
        `请求失败 HTTP ${res.status}${brief ? `：${brief}` : ''}`,
        res.text,
        fields,
      );
    }

    return { output: res.text, fields };
  });
}
