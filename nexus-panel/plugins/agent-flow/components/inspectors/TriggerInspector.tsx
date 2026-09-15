import { useState } from 'react';
import {
  CLI_META, TRIGGER_META, DEFAULT_BRANCH, OP_META, triggerKindsOf,
  makeRule, makeParallelRule,
  isCondition, isTrigger, isParallel, isLoop, isFs, isUpdate, isOcr, isTranslate,
  isGithubUpdate, isGithubPush,
  UPDATE_SOURCE_META, IMAGE_SOURCE_META, defaultOcrPrompt, defaultLlmConfig,
  type ImageSource, type OcrNodeData, type TranslateNodeData,
  opsByCategory, OP_CATEGORY_META, LOGIC_META, makeCondition, ruleConditions,
  type ConditionItem, type ConditionLogic,
  LOOP_MODE_META, FS_OP_META, MAX_LOOP_ITERATIONS, defaultFileOutput,
  type TaskFileOutput,
  type CliKind, type ConditionOp, type ConditionNodeData,
  type TriggerKind, type TriggerConfig, type TriggerNodeData,
  type ParallelMode, type ParallelNodeData, type TaskNodeData,
  type LoopMode, type LoopNodeData, type LoopOnError,
  type FsOp, type FsNodeData,
  type UpdateNodeData, type BiliMode,
  type GithubUpdateNodeData, type GithubPushNodeData, type GithubStrategy,
} from '../../types';
import {
  NODE_NEEDS, missingCapabilities, kindForNeed, type Credential,
} from '../../engine/credentials';
import {
  candidateRoots, concludeProbe, parseKeywords, parseMessages,
  CONV_SOURCE_META, type ProbeResult,
} from '../../engine/conversations';
import { fileOp, tailFile, type FsArgs } from '../../lib/tauri';
import { SECRET_POLICY_META, DEFAULT_TRIGGER_CONFIG, type SecretPolicy } from '../../types';
import { fetchText } from '../../lib/tauri';
import {
  validateRule, validateCondition, simulateCondition, describeRuleExpression,
} from '../../engine/condition';
import type { ConditionRule } from '../../types';
import { parseFeed, parseBiliApi, detectUpdate, sortByNewest, extractBiliUid, biliApiUrl, BILI_REFERER } from '../../engine/updates';
import {
  extractFileRefs, parseManualPaths, buildFileFields, FILE_FIELD_NAMES, FILE_FIELD_HINT,
} from '../../engine/files';
import {
  PARAM_SOURCE_META, resolveParam, validateParam, validateParams, makeParam,
  type ParamSource, type NodeParam,
} from '../../engine/params';
import {
  PROVIDER_META, TARGET_LANGS, validateConfig,
  type LlmConfig, type LlmProvider,
} from '../../engine/llm';
import { canReadImage } from '../../lib/tauri';
import type { FlowEdge, FlowNode } from '../../flowTypes';

export function TriggerInspector({ node, onChange, webhookTokens }: {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
  /** 后端为未填 Token 的 webhook 自动生成的校验 Token。
      从主 Inspector 透传 —— 此前 Props 里声明了却没往下传，
      函数内直接引用会编译不过。 */
  webhookTokens?: Record<string, string>;
}) {
  const d = node.data as TriggerNodeData;
  const patchConfig = (patch: Partial<TriggerConfig>) =>
    onChange(node.id, { config: { ...d.config, ...patch } });

  /** 兼容旧的单值字段：读的时候统一走 triggerKindsOf */
  const selected = triggerKindsOf(d);
  const toggle = (k: TriggerKind, on: boolean) => {
    const next = on
      ? (selected.includes(k) ? selected : [...selected, k])
      : selected.filter((x) => x !== k);
    // 写回时一并清掉旧的 trigger 字段，避免它与 triggers 打架
    onChange(node.id, { triggers: next, trigger: undefined });
  };

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <div className="field">
        <span>触发方式（可多选）</span>
        <div className="trig-multi">
          {(Object.keys(TRIGGER_META) as TriggerKind[]).map((k) => {
            const on = selected.includes(k);
            return (
              <label key={k} className={'trig-check' + (on ? ' on' : '')} title={TRIGGER_META[k].hint}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => toggle(k, e.target.checked)}
                />
                <span className="trig-check-icon">{TRIGGER_META[k].icon}</span>
                <span className="trig-check-label">{TRIGGER_META[k].label}</span>
              </label>
            );
          })}
        </div>
        <small className="dim">
          {selected.length === 0
            ? '一个都没选 —— 这个节点不会触发'
            : selected.length === 1
              ? TRIGGER_META[selected[0]].hint
              : `已选 ${selected.length} 种，任一满足即触发`}
        </small>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={d.enabled !== false}
          onChange={(e) => onChange(node.id, { enabled: e.target.checked })}
        />
        <span>启用这个触发器</span>
      </label>

      {selected.includes('interval') && (
        <label className="field">
          <span>间隔秒数（最小 10，避免把 CLI 打爆）</span>
          <input
            type="number" min={10}
            value={d.config.intervalSec}
            onChange={(e) => patchConfig({ intervalSec: Math.max(10, Number(e.target.value) || 10) })}
          />
        </label>
      )}

      {selected.includes('cron') && (
        <label className="field">
          <span>cron 表达式（分 时 日 月 周）</span>
          <input
            value={d.config.cronExpr}
            placeholder="0 9 * * 1-5"
            onChange={(e) => patchConfig({ cronExpr: e.target.value })}
          />
        </label>
      )}

      {selected.includes('watch') && (
        <>
          <label className="field">
            <span>监听目录</span>
            <input
              value={d.config.watchDir}
              placeholder="/path/to/dir"
              onChange={(e) => patchConfig({ watchDir: e.target.value })}
            />
          </label>
          <label className="field">
            <span>只关心这些后缀（逗号分隔，留空=全部）</span>
            <input
              value={(d.config.watchExts ?? []).join(',')}
              placeholder="py,js,ts"
              onChange={(e) => patchConfig({
                watchExts: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
              })}
            />
          </label>
          <label className="field">
            <span>防抖毫秒</span>
            <input
              type="number" min={0}
              value={d.config.debounceMs}
              onChange={(e) => patchConfig({ debounceMs: Number(e.target.value) || 0 })}
            />
          </label>
        </>
      )}

      {selected.includes('webhook') && (
        <>
          <div className="field row2">
            <label className="field">
              <span>端口</span>
              <input
                type="number"
                value={d.config.port}
                onChange={(e) => patchConfig({ port: Number(e.target.value) || 8787 })}
              />
            </label>
            <label className="field">
              <span>路径</span>
              <input
                value={d.config.path}
                onChange={(e) => patchConfig({ path: e.target.value || '/' })}
              />
            </label>
          </div>
          <div className="url-box">
            <code>{`http://127.0.0.1:${d.config.port}${d.config.path}`}</code>
          </div>
          <label className="field">
            <span>校验 Token（留空=不校验身份，但调用仍需带下方请求头）</span>
            <input value={d.config.token} onChange={(e) => patchConfig({ token: e.target.value })} />
          </label>
          {!d.config.token && webhookTokens?.[node.id] ? (
            <div className="tip">
              未填 Token，后端已自动生成：<code>{webhookTokens[node.id]}</code>
              <br />
              调用时带上请求头 <code>X-Token</code> 或 <code>Authorization: Bearer …</code>。
              留空不等于「不校验」——否则本机任何程序（不只网页）都能触发这条工作流。
              <br />
              例：<code>curl -H 'X-Token: {webhookTokens[node.id]}' http://127.0.0.1:{d.config.port}{d.config.path}</code>
            </div>
          ) : null}
          {!d.config.token && !webhookTokens?.[node.id] && (
            <div className="tip">
              未配 Token 时，调用需带请求头 <code>X-Nexus-Webhook: 1</code>。
              这不是身份校验，而是挡住浏览器里的恶意网页静默触发本端口 ——
              网页加不了自定义头，加了也会因预检失败而发不出去。
              <br />
              例：<code>curl -H 'X-Nexus-Webhook: 1' http://127.0.0.1:{d.config.port}{d.config.path}</code>
            </div>
          )}
        </>
      )}

      {selected.includes('chat') && (
        <ChatConfig node={node} d={d} patchConfig={patchConfig} />
      )}

      <label className="field">
        <span>触发时注入的输入（节点里用 <code>{'{{input}}'}</code> 读取）</span>
        <textarea
          rows={4}
          value={d.input}
          onChange={(e) => onChange(node.id, { input: e.target.value })}
        />
      </label>

      <div className="tip">
        触发器节点是工作流的起点，不消耗积分。它的下游就是要执行的任务链。
      </div>
    </aside>
  );
}

/** 家目录。浏览器里拿不到真实路径，退回空串让探测自然失败并报出来 */
function homeDir(): string {
  const h = (globalThis as { __NEXUS_HOME__?: string }).__NEXUS_HOME__;
  if (typeof h === 'string' && h) return h;
  // Tauri 里通常由 Rust 提供；这里拿不到就退回常见约定，探测会自己验证真假
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.HOME
    ?? (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.USERPROFILE
    ?? '';
}

function platformOf(): 'win' | 'mac' | 'linux' {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/windows/i.test(ua)) return 'win';
  if (/macintosh|mac os x/i.test(ua)) return 'mac';
  return 'linux';
}

/**
 * 「对话触发」的配置 + 探测。
 *
 * 探测是必需的：各家 CLI 把对话放在不同目录、格式还不统一，
 * Trae IDE 更是存在 SQLite 里（新版还加密）。与其让用户照着文档猜路径，
 * 不如扫一遍本机，把"找到没 / 能不能读"如实报出来 ——
 * 尤其是"目录存在但读不了"这种最容易白忙一场的情况。
 */

/**
 * 「对话触发」的配置 + 探测。
 *
 * 探测是必需的：各家 CLI 把对话放在不同目录、格式还不统一，
 * Trae IDE 更是存在 SQLite 里（新版还加密）。与其让用户照着文档猜路径，
 * 不如扫一遍本机，把"找到没 / 能不能读"如实报出来 ——
 * 尤其是"目录存在但读不了"这种最容易白忙一场的情况。
 */
export function ChatConfig({ d, patchConfig }: {
  node: FlowNode;
  d: TriggerNodeData;
  patchConfig: (patch: Partial<TriggerConfig>) => void;
}) {
  const [probing, setProbing] = useState(false);
  const [probeErr, setProbeErr] = useState('');
  const [results, setProbes] = useState<ProbeResult[]>([]);
  const kwCount = parseKeywords(d.config.chatKeywords).length;

  const runProbe = async () => {
    setProbing(true);
    setProbeErr('');
    const out: ProbeResult[] = [];
    const home = homeDir();
    const exts = d.config.chatExts.length > 0 ? d.config.chatExts : ['jsonl'];

    for (const { kind, root } of candidateRoots(home, platformOf())) {
      let exists = false;
      let files: string[] = [];
      try {
        const r = await fileOp({ op: 'list', path: root, recursive: true, exts } as FsArgs);
        exists = true;
        files = r.text.split('\n').map((x) => x.trim()).filter(Boolean);
      } catch {
        exists = false;   // 列目录失败就当不存在，探测不该因为报错中断
      }

      // 抽样：只试最近的一个文件，够判断"能不能解析"了
      let parsed = 0;
      let sample = '';
      if (files.length > 0) {
        sample = files[files.length - 1];
        const content = await tailFile(sample);
        if (content !== null) parsed = parseMessages(content, sample).length;
      }
      const verdict = concludeProbe(kind, exists, files.length, parsed);
      out.push({
        kind, root, exists, files: files.length, parsed, sample,
        usable: verdict.usable, note: verdict.note,
      });
    }

    setProbes(out);
    setProbing(false);

    // 没填目录时，自动用第一个可用的 —— 省一次手抄路径
    const first = out.find((r) => r.usable);
    if (first && !d.config.chatDir.trim()) {
      // 监听目录填"会话文件所在的父目录"：同项目的多个会话都能覆盖
      const parent = first.sample.replace(/[\\/][^\\/]+$/, '');
      patchConfig({ chatDir: parent || first.root });
    }
  };

  return (
    <>
      <div className="field">
        <div className="chat-probe-head">
          <small className="dim">对话来源探测</small>
          <button className="mini" onClick={() => void runProbe()} disabled={probing}>
            {probing ? '扫描中…' : '扫描本机'}
          </button>
        </div>
        <small className="dim">
          各家 CLI 存放位置不同，先扫一遍看清哪些能读 —— 免得配了个读不动的目录白忙一场。
        </small>
        {probeErr ? <div className="chat-probe-err">⚠ {probeErr}</div> : null}
      </div>

      {results.length > 0 ? (
        <div className="chat-probe-list">
          {results.filter((r) => r.exists || r.usable).map((r) => (
            <div key={`${r.kind}:${r.root}`} className={`chat-probe-row ${r.usable ? 'ok' : 'no'}`}>
              <div className="chat-probe-top">
                <span className="chat-probe-name">{CONV_SOURCE_META[r.kind].label}</span>
                <span className="chat-probe-tag">{r.usable ? '可用' : '不可用'}</span>
                {r.usable && r.root ? (
                  <button
                    className="mini"
                    onClick={() => patchConfig({ chatDir: r.root })}
                    title={r.root}
                  >
                    用这个
                  </button>
                ) : null}
              </div>
              <div className="chat-probe-note">{r.note}</div>
              <div className="chat-probe-path">{r.root}</div>
            </div>
          ))}
        </div>
      ) : null}

      <label className="field">
        <span>监听目录</span>
        <input
          value={d.config.chatDir}
          placeholder="/home/你/.codebuddy/projects"
          onChange={(e) => patchConfig({ chatDir: e.target.value })}
        />
      </label>

      <label className="field">
        <span>关键词（一行一个，# 开头为注释）</span>
        <textarea
          rows={4}
          value={d.config.chatKeywords}
          placeholder={'报错\n测试失败\n# 这行是注释'}
          onChange={(e) => patchConfig({ chatKeywords: e.target.value })}
        />
        <div className="cond-hint">
          {kwCount === 0 ? '还没填关键词 —— 这个触发器不会触发' : `已配 ${kwCount} 个关键词，大小写不敏感`}
        </div>
      </label>

      <div className="field row2">
        <label className="field">
          <span>匹配范围</span>
          <select
            value={d.config.chatScope}
            onChange={(e) => patchConfig({ chatScope: e.target.value as 'user' | 'both' })}
          >
            <option value="both">用户 + AI</option>
            <option value="user">只算用户说的</option>
          </select>
        </label>
        <label className="field">
          <span>轮询秒数</span>
          <input
            type="number" min={2}
            value={d.config.chatPollSec}
            onChange={(e) => patchConfig({ chatPollSec: Math.max(2, Number(e.target.value) || 3) })}
          />
        </label>
      </div>

      <label className="field">
        <span>命中内容模板（注入 <code>{'{{input}}'}</code>）</span>
        <textarea
          rows={3}
          value={d.config.chatTemplate}
          placeholder={DEFAULT_TRIGGER_CONFIG.chatTemplate}
          onChange={(e) => patchConfig({ chatTemplate: e.target.value })}
        />
        <div className="cond-hint">
          占位符：<code>{'{{keyword}}'}</code> <code>{'{{role}}'}</code>{' '}
          <code>{'{{text}}'}</code> <code>{'{{excerpt}}'}</code>{' '}
          <code>{'{{file}}'}</code> <code>{'{{time}}'}</code>
        </div>
      </label>

      <div className="tip">
        只读本机对话文件、不外发。首次扫描到的历史消息只作基线，不会触发流程 ——
        只有启动之后新出现的才会。
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

const MODE_LABEL: Record<ParallelMode, string> = {
  fixed: '固定并发数',
  byRule: '按条件决定',
  all: '不限制',
};
