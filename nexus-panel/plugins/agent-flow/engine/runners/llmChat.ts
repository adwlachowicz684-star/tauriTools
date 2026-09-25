import type { LlmChatNodeData } from '../../types';
import { findCredential, resolveSecret } from '../credentials';
import { resolveLlmFromCredential } from '../llmCredential';
import { buildHeaders, parseResponse, type ChatMessage } from '../llm';
import { resolveParams } from '../params';
import { findPane, resolveApiPane } from '../pane';
import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import type { LlmCallResult } from '../runTypes';

/**
 * 大模型 API 节点：发一次 chat completions，把回的文字原样产出。
 *
 * 与 OCR / 翻译的区别只是"消息怎么拼" —— 那两个把消息写死了
 * （必须带图 / 必须带目标语言），这个节点两段都交给用户。
 * 请求构造、响应解析、错误提示与它们完全一致，所以复用同一套 shared 函数。
 */
export async function runLlmChat(ctx: RunContext): Promise<void> {
  const { id, node, opts, emit, graph } = ctx;

  const d = node.data as LlmChatNodeData;

  /*
   * 窗格只影响"节点上没填的项"。
   * 这里先算出生效配置，后面一律用 eff，不再直接读 d ——
   * 混着读的话，窗格继承会在某个字段上悄悄漏掉，
   * 表现为"窗格改了但只有一半生效"。
   */
  const pane = findPane(graph?.nodes ?? [], d.paneId);
  const eff = resolveApiPane(d, pane);

  const prompt = ctx.tpl(d.prompt ?? '');
  const system = ctx.tpl(eff.system ?? '');

  await withNodeRun(ctx, async () => {
    if (!prompt.trim()) {
      throw new NodeFailError('没有填要问的内容（user 提示词）', '', { text: '', chars: '0' });
    }

    /*
     * 地址与密钥优先取自连接；节点上那份 llm 只作兜底。
     * 反过来则"改了连接的地址不生效"，表现为改了没反应。
     */
    const cfg = resolveLlmFromCredential(
      findCredential(opts.credentials ?? [], eff.credentialId), eff.model, { fallback: d.llm },
    );
    /*
     * 没地址必须在这里说出来。
     *
     * 空地址发出去会拿到一段 HTML 或 404，错误信息指向的是
     * "解析响应失败"之类，跟"你没配连接"差了十万八千里 ——
     * 用户会去查响应格式，而不是回来补一条连接。
     */
    if (!cfg.url) {
      throw new NodeFailError(
        '没配大模型：请在连接管理器里加一条大模型凭据，并在节点（或它所属的任务窗格）上选一条',
        '', { text: '', chars: '0' },
      );
    }

    const messages: ChatMessage[] = [];
    if (system.trim()) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: eff.temperature,
      stream: false,
    };
    /*
     * max_tokens 只在填了时才带上。
     * 带 0 上去，部分服务商会直接返回空内容而不是"不限制"，
     * 表现为"填了 0 之后模型一句话都不说"，而界面上 0 看着就是不限。
     */
    if (typeof d.maxTokens === 'number' && d.maxTokens > 0) body.max_tokens = d.maxTokens;
    if (eff.jsonMode) body.response_format = { type: 'json_object' };

    emit({ type: 'node-start', id, rendered: `${cfg.model} · ${prompt.slice(0, 60)}` });

    let res: LlmCallResult;
    try {
      res = await opts.llmCaller!({
        url: cfg.url,
        headers: buildHeaders(resolveSecret(opts.credentials ?? [], eff.credentialId, cfg.apiKey)),
        body,
        timeoutSec: cfg.timeoutSec,
      });
    } catch (err) {
      throw new NodeFailError(err instanceof Error ? err.message : String(err), '', { text: '', chars: '0' });
    }

    const parsed = parseResponse(res.status, res.text);
    if (!parsed.ok) {
      throw new NodeFailError(parsed.error, '', { text: '', chars: '0' });
    }

    const text = parsed.text.trim();
    return {
      output: text,
      fields: {
        text,
        chars: String(text.length),
        ...resolveParams(d.params, { output: text, refs: [] }),
      },
    };
  });
}
