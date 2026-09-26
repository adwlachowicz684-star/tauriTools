import type { LlmChatNodeData, LlmUse } from '../../types';
import { defaultOcrPrompt, LLM_USE_META } from '../../types';
import { findCredential, resolveSecret } from '../credentials';
import { resolveLlmFromCredential } from '../llmCredential';
import {
  buildHeaders, parseResponse, isUsableImageUrl, buildTranslateSystem, TARGET_LANGS,
  type ChatMessage, type ContentPart,
} from '../llm';
import { resolveParams } from '../params';
import { findPane, resolveApiPane } from '../pane';
import type { RunContext } from '../runContext';
import { withNodeRun, NodeFailError } from '../runnerKit';
import type { LlmCallResult } from '../runTypes';

/**
 * 大模型节点：发一次 chat completions，把回的文字原样产出。
 *
 * 三种用途（自由对话 / 图片识别 / 翻译）**共用这一份实现**，差别只在
 * "消息怎么拼"：
 *   - 自由对话：system 与 user 两段都来自节点
 *   - 图片识别：user 是 [文本, 图片] 多模态数组，system 不用
 *   - 翻译：system 由目标语言 / 源语言 / 术语表拼出，user 是待翻译内容
 *
 * 以前这是三个节点三份 runner，请求构造与响应解析各写一遍 ——
 * 改一处请求逻辑要改三遍，漏一处就是"这个节点还是旧行为，且不报错"。
 */
export async function runLlmChat(ctx: RunContext): Promise<void> {
  const { id, node, opts, emit, graph } = ctx;

  const d = node.data as LlmChatNodeData;
  /*
   * 缺省必须是 'chat'：老存档里没有这个字段，
   * 而它们当初的行为正是自由对话。
   */
  const use: LlmUse = d.use ?? 'chat';

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
    /*
     * 三种用途要填的东西不同，空值提示也必须指名 ——
     * 只说"没有填内容"的话，翻译模式下用户会去改"要问的内容"那一栏，
     * 而那一栏在翻译模式下根本不显示。
     */
    if (!prompt.trim()) {
      throw new NodeFailError(
        use === 'translate' ? '没有填待翻译内容' : '没有填要问的内容（user 提示词）',
        '', { text: '', chars: '0' },
      );
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

    /*
     * 图片要先取到地址：本地文件得先读盘转 base64，
     * 而两种来源的失败提示完全不同（没填路径 vs 地址格式不对）。
     */
    let imageUrl = '';
    if (use === 'ocr') {
      if (d.imageSource === 'file') {
        const p = ctx.tpl(d.path ?? '').trim();
        if (!p) {
          throw new NodeFailError('图片来源选的是「本地文件」，但没有填路径', '', { text: '', chars: '0' });
        }
        emit({ type: 'node-start', id, rendered: `读取本地图片 ${p}` });
        try {
          imageUrl = await opts.imageReader!(p);
        } catch (err) {
          throw new NodeFailError(err instanceof Error ? err.message : String(err), '', { text: '', chars: '0' });
        }
      } else {
        imageUrl = ctx.tpl(d.url ?? '').trim();
        if (!imageUrl) {
          throw new NodeFailError('图片来源选的是「网络地址」，但没有填地址', '', { text: '', chars: '0' });
        }
        if (!isUsableImageUrl(imageUrl)) {
          throw new NodeFailError(
            `图片地址无效：${imageUrl.slice(0, 80)}。需要 http(s) 开头，或 data:image/ 开头`,
            '', { text: '', chars: '0' },
          );
        }
      }
    }

    const messages: ChatMessage[] = [];
    if (use === 'translate') {
      /*
       * 翻译的 system 由目标语言拼出 —— 用户只填"翻成什么"，不写提示词。
       * 让用户在翻译节点上手写 system 反而容易写漏"只输出译文"这一句，
       * 结果拿到带解释的回复。
       */
      const target = (d.targetLang ?? '').trim();
      if (!target) {
        throw new NodeFailError('未指定目标语言', '', { text: '', chars: '0' });
      }
      /* 允许填 "日语" 这种中文，也允许填 "ja" */
      const preset = TARGET_LANGS.find((l) => l.code === target);
      const targetText = preset ? preset.label : target;
      const sourceLang = (d.sourceLang ?? 'auto').trim() || 'auto';
      messages.push({
        role: 'system',
        content: buildTranslateSystem(targetText, sourceLang === 'auto' ? '' : sourceLang, d.glossary),
      });
      messages.push({ role: 'user', content: prompt });
    } else if (use === 'ocr') {
      /*
       * 识别要求留空用默认提示（按原顺序输出，不解释）。
       * 提示词走模板，便于"先让上游 agent 说要识别哪张图"。
       */
      const parts: ContentPart[] = [
        { type: 'text', text: prompt.trim() || defaultOcrPrompt() },
        { type: 'image_url', image_url: { url: imageUrl, detail: d.detail ?? 'auto' } },
      ];
      messages.push({ role: 'user', content: parts });
    } else {
      if (system.trim()) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
    }

    /*
     * 图片识别与翻译都刻意**不用窗格的温度**：
     * 这两档要的是稳定复现（读出来的文字、译法一致），
     * 温度一发散，同一张图两次结果不同，而用户只会觉得"这节点不准"。
     */
    const temperature = use === 'chat' ? eff.temperature : use === 'translate' ? 0.2 : 0;

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature,
      stream: false,
    };
    /*
     * max_tokens 只在填了时才带上。
     * 带 0 上去，部分服务商会直接返回空内容而不是"不限制"，
     * 表现为"填了 0 之后模型一句话都不说"，而界面上 0 看着就是不限。
     */
    if (typeof d.maxTokens === 'number' && d.maxTokens > 0) body.max_tokens = d.maxTokens;
    if (eff.jsonMode) body.response_format = { type: 'json_object' };

    /*
     * 日志里带上用途：三种用途失败的排查方向完全不同
     * （没填图 / 语言没选 / 提示词空），不指名的话只能靠猜。
     */
    emit({
      type: 'node-start',
      id,
      rendered: `${LLM_USE_META[use].label} · ${cfg.model} · ${prompt.slice(0, 60)}`,
    });

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
