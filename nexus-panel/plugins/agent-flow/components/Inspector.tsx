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
} from '../types';
import {
  NODE_NEEDS, missingCapabilities, kindForNeed, type Credential,
} from '../engine/credentials';
import {
  candidateRoots, concludeProbe, parseKeywords, parseMessages,
  CONV_SOURCE_META, type ProbeResult,
} from '../engine/conversations';
import { fileOp, tailFile, type FsArgs } from '../lib/tauri';
import { SECRET_POLICY_META, DEFAULT_TRIGGER_CONFIG, type SecretPolicy } from '../types';
import { fetchText } from '../lib/tauri';
import {
  validateRule, validateCondition, simulateCondition, describeRuleExpression,
} from '../engine/condition';
import type { ConditionRule } from '../types';
import { parseFeed, parseBiliApi, detectUpdate, sortByNewest, extractBiliUid, biliApiUrl, BILI_REFERER } from '../engine/updates';
import {
  extractFileRefs, parseManualPaths, buildFileFields, FILE_FIELD_NAMES, FILE_FIELD_HINT,
} from '../engine/files';
import {
  PARAM_SOURCE_META, resolveParam, validateParam, validateParams, makeParam,
  type ParamSource, type NodeParam,
} from '../engine/params';
import {
  PROVIDER_META, TARGET_LANGS, validateConfig,
  type LlmConfig, type LlmProvider,
} from '../engine/llm';
import { canReadImage } from '../lib/tauri';
import type { FlowEdge, FlowNode } from '../flowTypes';

type Props = {
  node: FlowNode | null;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  /** 凭据列表；不传则凭据选择区不显示 */
  credentials?: Credential[];
  /** 打开凭据中心，并聚焦到指定类型 */
  onOpenCredentials?: (kind: string) => void;
  /** 内联密钥的落盘策略 */
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
  /** 后端为「未填 Token」的 webhook 触发器自动生成的校验 Token，按触发器 id 索引 */
  webhookTokens?: Record<string, string>;
};

const OPS = Object.keys(OP_META) as ConditionOp[];

export default function Inspector({
  node, edges, onChange, credentials, onOpenCredentials, webhookTokens,
  secretPolicy, onChangeSecretPolicy,
}: Props) {
  if (!node) {
    return (
      <aside className="inspector">
        <div className="empty-hint">
          选中一个节点来编辑内容
          <br />
          <small>工具栏「+ 任务」添加 CLI 节点，「+ 条件」添加分支判断</small>
        </div>
      </aside>
    );
  }

  /* ---------- 条件节点 ---------- */
  if (isCondition(node.data)) {
    return <ConditionInspector node={node} edges={edges} onChange={onChange} />;
  }

  /* ---------- 触发器节点 ---------- */
  if (isTrigger(node.data)) {
    return <TriggerInspector node={node} onChange={onChange} webhookTokens={webhookTokens} />;
  }

  /* ---------- 并发节点 ---------- */
  if (isParallel(node.data)) {
    return <ParallelInspector node={node} onChange={onChange} />;
  }

  /* ---------- 循环节点 ---------- */
  if (isLoop(node.data)) {
    return <LoopInspector node={node} edges={edges} onChange={onChange} />;
  }

  /* ---------- 文件操作节点 ---------- */
  if (isFs(node.data)) {
    return <FsInspector node={node} edges={edges} onChange={onChange} />;
  }

  /* ---------- 更新检测节点（B站 / 公众号） ---------- */
  if (isUpdate(node.data)) {
    return <UpdateInspector node={node} onChange={onChange} />;
  }

  /* ---------- OCR 节点 ---------- */
  if (isOcr(node.data)) {
    return <OcrInspector node={node} edges={edges} onChange={onChange}
      credentials={credentials} onOpenCredentials={onOpenCredentials}
      secretPolicy={secretPolicy} onChangeSecretPolicy={onChangeSecretPolicy} />;
  }

  /* ---------- 翻译节点 ---------- */
  if (isTranslate(node.data)) {
    return <TranslateInspector node={node} edges={edges} onChange={onChange}
      credentials={credentials} onOpenCredentials={onOpenCredentials}
      secretPolicy={secretPolicy} onChangeSecretPolicy={onChangeSecretPolicy} />;
  }
  if (isGithubUpdate(node.data)) {
    return <GithubUpdateInspector node={node} edges={edges} onChange={onChange}
      credentials={credentials} onOpenCredentials={onOpenCredentials} />;
  }
  if (isGithubPush(node.data)) {
    return <GithubPushInspector node={node} edges={edges} onChange={onChange}
      credentials={credentials} onOpenCredentials={onOpenCredentials} />;
  }

  /* ---------- 任务节点 ---------- */
  const d = node.data as TaskNodeData;
  const upstream = edges.filter((e) => e.target === node.id).map((e) => e.source);
  const insert = (token: string) => onChange(node.id, { prompt: d.prompt + token });

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <label className="field">
        <span>使用 CLI</span>
        <select value={d.cli} onChange={(e) => onChange(node.id, { cli: e.target.value as CliKind })}>
          {(Object.keys(CLI_META) as CliKind[]).map((k) => (
            <option key={k} value={k}>{CLI_META[k].label}</option>
          ))}
        </select>
      </label>

      <div className="field">
        <span>提示词内容</span>
        <div className="var-bar">
          <small>可引用：</small>
          {upstream.map((u) => (
            <button key={u} className="chip" onClick={() => insert(`{{${u}.output}}`)}>
              {`{{${u}.output}}`}
            </button>
          ))}
          <button className="chip" onClick={() => insert('{{input}}')}>{'{{input}}'}</button>
        </div>
        {upstream.length > 0 && (
          <div className="var-bar">
            <small>上游文件（改了哪些）：</small>
            {upstream.map((u) => (
              <button
                key={`${u}-file`}
                className="chip file"
                title={FILE_FIELD_HINT.file}
                onClick={() => insert(`{{${u}.file}}`)}
              >
                {`{{${u}.file}}`}
              </button>
            ))}
            {upstream.map((u) => (
              <button
                key={`${u}-files`}
                className="chip file"
                title={FILE_FIELD_HINT.files}
                onClick={() => insert(`{{${u}.files}}`)}
              >
                {`{{${u}.files}}`}
              </button>
            ))}
            {upstream.map((u) => (
              <button
                key={`${u}-fn`}
                className="chip file"
                title={FILE_FIELD_HINT.fileName}
                onClick={() => insert(`{{${u}.fileName}}`)}
              >
                {`{{${u}.fileName}}`}
              </button>
            ))}
          </div>
        )}
        <textarea
          rows={10}
          value={d.prompt}
          placeholder="例如：审查这段代码的安全性 {{prev.output}}"
          onChange={(e) => onChange(node.id, { prompt: e.target.value })}
        />
      </div>

      <label className="field">
        <span>工作目录（留空用当前目录）</span>
        <input value={d.workdir} placeholder="/path/to/project" onChange={(e) => onChange(node.id, { workdir: e.target.value })} />
      </label>

      <label className="field">
        <span>模型（留空用默认）</span>
        <input value={d.model} placeholder="如 gpt-5 / glm-5.2" onChange={(e) => onChange(node.id, { model: e.target.value })} />
      </label>

      <label className="check">
        <input type="checkbox" checked={d.yolo} onChange={(e) => onChange(node.id, { yolo: e.target.checked })} />
        <span>自动批准工具调用（-y）</span>
      </label>

      <FileParamsPanel node={node} onChange={onChange} />

      <div className="field">
        <span>运行输出</span>
        <pre className="out">{d.output || '（尚未运行）'}</pre>
        {d.error && <pre className="out err">{d.error}</pre>}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

/**
 * 任务节点的「输出参数」面板。
 *
 * 独立成组件是因为它有两块内容（文件参数 + 自定义参数），
 * 塞进上面的主面板会让那个函数长到看不清结构。
 */
function FileParamsPanel({ node, onChange }: {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
}) {
  const d = node.data as TaskNodeData;
  const cfg = d.fileOutput ?? defaultFileOutput();
  const params = d.params ?? [];

  const patchCfg = (patch: Partial<TaskFileOutput>) =>
    onChange(node.id, { fileOutput: { ...cfg, ...patch } });

  const patchParams = (next: NodeParam[]) => onChange(node.id, { params: next });

  /* 预览：用上次输出模拟一次识别，让用户立刻看到效果 */
  const previewRefs = cfg.mode === 'manual'
    ? parseManualPaths(cfg.manualPaths, d.workdir)
    : extractFileRefs(d.output, d.workdir);
  const previewFields = buildFileFields(previewRefs);
  const showPreview = cfg.enabled && (cfg.mode === 'manual' || d.output);

  const paramIssues = validateParams(params);

  return (
    <>
      {/* ---------- 文件参数 ---------- */}
      <div className="field">
        <div className="field-head">
          <span>输出参数 · 文件</span>
          <label className="rule-toggle" title={cfg.enabled ? '停用后下游拿不到文件字段' : '已停用'}>
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => patchCfg({ enabled: e.target.checked })}
            />
          </label>
        </div>
        <small className="dim">
          把「改了哪些文件」传给下游：{FILE_FIELD_NAMES.map((f) => `{{${node.id}.${f}}}`).slice(0, 3).join(' ')} …
        </small>

        {cfg.enabled && (
          <>
            <div className="cond-logic-switch">
              <small className="dim">来源</small>
              <button
                type="button"
                className={'cond-logic-btn' + (cfg.mode === 'auto' ? ' on' : '')}
                style={cfg.mode === 'auto' ? { borderColor: '#06b6d4', color: '#06b6d4' } : undefined}
                title="从 CLI 输出里自动识别路径（尽力而为）"
                onClick={() => patchCfg({ mode: 'auto' })}
              >
                自动识别
              </button>
              <button
                type="button"
                className={'cond-logic-btn' + (cfg.mode === 'manual' ? ' on' : '')}
                style={cfg.mode === 'manual' ? { borderColor: '#a855f7', color: '#a855f7' } : undefined}
                title="识别不准时改为手动指定，一行一个路径"
                onClick={() => patchCfg({ mode: 'manual' })}
              >
                手动指定
              </button>
            </div>

            {cfg.mode === 'manual' ? (
              <textarea
                className="cond-sample"
                rows={3}
                value={cfg.manualPaths}
                placeholder={'src/a.ts\nsrc/b.ts'}
                onChange={(e) => patchCfg({ manualPaths: e.target.value })}
              />
            ) : (
              <div className="cond-hint">
                从本节点的 CLI 输出里识别路径（含斜杠 + 已知扩展名）。识别不准时切「手动指定」
              </div>
            )}

            {showPreview && (
              <div className="file-preview">
                <div className="file-preview-head">
                  识别结果（{previewRefs.length}）
                </div>
                {previewRefs.length === 0 && <div className="dim">没有识别到文件路径</div>}
                {previewRefs.slice(0, 8).map((r) => (
                  <div key={r.abs} className="file-preview-item" title={r.raw}>
                    <span className="file-preview-name">{r.name}</span>
                    <span className="file-preview-path">{r.abs}</span>
                  </div>
                ))}
                {previewRefs.length > 8 && (
                  <div className="dim">…还有 {previewRefs.length - 8} 个</div>
                )}
                {previewRefs.length > 0 && (
                  <div className="file-preview-fields">
                    {`{{${node.id}.file}}`} = {previewFields.file || '（空）'}
                  </div>
                )}
              </div>
            )}

            {d.lastFiles && d.lastFiles.length > 0 && cfg.mode === 'auto' && (
              <div className="cond-hint">上次运行识别到 {d.lastFiles.length} 个文件</div>
            )}
          </>
        )}
      </div>

      {/* ---------- 自定义参数 ---------- */}
      <div className="field">
        <span>自定义参数（可选）</span>
        <small className="dim">
          给输出里的某个值起个名字，下游用 {'{{节点id.参数名}}'} 引用
        </small>

        {params.length === 0 && <div className="dim">还没有参数，点下面按钮添加</div>}

        {params.map((p, i) => {
          const meta = PARAM_SOURCE_META[p.source];
          const issues = validateParam(p);
          const on = p.enabled !== false;
          return (
            <div key={p.id} className={'param-card' + (on ? '' : ' off')}>
              <div className="rule-row">
                <span className="rule-idx">{i + 1}</span>
                <input
                  className="rule-label"
                  value={p.name}
                  placeholder="参数名"
                  onChange={(e) => patchParams(params.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))}
                />
                <label className="rule-toggle" title={on ? '停用这个参数' : '启用'}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => patchParams(params.map((x) => (x.id === p.id ? { ...x, enabled: e.target.checked } : x)))}
                  />
                </label>
                <button
                  className="mini danger"
                  onClick={() => patchParams(params.filter((x) => x.id !== p.id))}
                >
                  删
                </button>
              </div>

              <div className="param-row">
                <select
                  value={p.source}
                  onChange={(e) => patchParams(params.map((x) => (x.id === p.id ? { ...x, source: e.target.value as ParamSource } : x)))}
                  title={meta.hint}
                >
                  {(Object.keys(PARAM_SOURCE_META) as ParamSource[]).map((k) => (
                    <option key={k} value={k}>{PARAM_SOURCE_META[k].label}</option>
                  ))}
                </select>
                {meta.needs === 'pattern' && (
                  <input
                    className="rule-value mono"
                    value={p.pattern ?? ''}
                    placeholder="正则，含捕获组时取第一个组"
                    onChange={(e) => patchParams(params.map((x) => (x.id === p.id ? { ...x, pattern: e.target.value } : x)))}
                  />
                )}
                {meta.needs === 'value' && (
                  <input
                    className="rule-value"
                    value={p.value ?? ''}
                    placeholder="固定值"
                    onChange={(e) => patchParams(params.map((x) => (x.id === p.id ? { ...x, value: e.target.value } : x)))}
                  />
                )}
              </div>

              {p.source !== 'manual' && (
                <div className="param-row">
                  <small className="dim">取第几个</small>
                  <input
                    className="param-index"
                    type="number"
                    min={0}
                    value={p.index ?? 0}
                    title="0 或不填 = 全部（换行分隔）"
                    onChange={(e) => patchParams(params.map((x) => (x.id === p.id ? { ...x, index: Number(e.target.value) || 0 } : x)))}
                  />
                  <small className="dim">（0 = 全部）</small>
                </div>
              )}

              <div className="cond-hint">{meta.hint}</div>

              {/* 预览：用上次输出算一遍，能立刻看出配得对不对 */}
              {p.source === 'regex' && d.output && (
                <div className="param-preview">
                  当前输出下取到：
                  <code>
                    {resolveParam(p, { output: d.output, refs: previewRefs }) || '（空）'}
                  </code>
                </div>
              )}

              {issues.map((it, k) => (
                <div key={k} className={'cond-issue ' + it.level}>{it.message}</div>
              ))}
            </div>
          );
        })}

        <button className="kind-btn" onClick={() => patchParams([...params, makeParam()])}>
          + 添加参数
        </button>

        {paramIssues.length > 0 && (
          <div className="cond-issues">
            <div className="cond-issues-title">配置提示</div>
            {paramIssues.map((it, k) => (
              <div key={k} className={'cond-issue ' + it.level}>{it.message}</div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * 大模型配置的公共区块。
 *
 * OCR 与翻译共用：服务商 / 地址 / 模型 / Key / 超时。
 * needVision 为 true 时会校验"该服务商是否支持图片"，
 * 免得用户配完才发现选了个不支持视觉的模型。
 */
function LlmConfigPanel({
  nodeId, cfg, onChange, needVision, secretPolicy, onChangeSecretPolicy,
}: {
  nodeId: string;
  cfg: LlmConfig;
  onChange: (id: string, patch: Record<string, unknown>) => void;
  needVision: boolean;
  /** 当前密钥落盘策略；不传则不显示这一项 */
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const c = cfg ?? defaultLlmConfig();
  const issues = validateConfig(c, needVision);
  const preset = PROVIDER_META[c.provider] ?? PROVIDER_META.custom;

  const set = (p: Partial<LlmConfig>) => onChange(nodeId, { llm: { ...c, ...p } });

  return (
    <div className="field">
      <span>大模型</span>

      <label className="field">
        <small className="dim">服务商</small>
        <select
          value={c.provider}
          onChange={(e) => set({ provider: e.target.value as LlmProvider, baseUrl: '', model: '' })}
        >
          {(Object.keys(PROVIDER_META) as LlmProvider[]).map((k) => (
            <option key={k} value={k}>{PROVIDER_META[k].label}</option>
          ))}
        </select>
      </label>

      <label className="field">
        <small className="dim">API 地址{` `}
          <span className="dim">（留空用上方服务商的默认值）</span>
        </small>
        <input
          className="mono"
          value={c.baseUrl}
          placeholder={preset.baseUrl || 'https://.../v1/chat/completions'}
          onChange={(e) => set({ baseUrl: e.target.value })}
        />
      </label>

      <label className="field">
        <small className="dim">模型</small>
        <input
          className="mono"
          value={c.model}
          placeholder={preset.model}
          onChange={(e) => set({ model: e.target.value })}
        />
        {preset.hint && <div className="cond-hint">{preset.hint}</div>}
      </label>

      <label className="field">
        <small className="dim">API Key</small>
        <div className="key-row">
          <input
            className="mono"
            type={showKey ? 'text' : 'password'}
            value={c.apiKey}
            placeholder="sk-..."
            onChange={(e) => set({ apiKey: e.target.value })}
          />
          <button className="mini" onClick={() => setShowKey(!showKey)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </label>

      <label className="field">
        <small className="dim">超时（秒）</small>
        <input
          className="param-index"
          type="number"
          min={5}
          value={c.timeoutSec}
          onChange={(e) => set({ timeoutSec: Number(e.target.value) || 60 })}
        />
      </label>

      {issues.length > 0 && (
        <div className="cond-issues">
          <div className="cond-issues-title">配置提示</div>
          {issues.map((it, k) => (
            <div key={k} className={'cond-issue ' + it.level}>{it.message}</div>
          ))}
        </div>
      )}

      {onChangeSecretPolicy ? (
        <label className="field">
          <small className="dim">密钥保存方式</small>
          <select
            value={secretPolicy ?? 'device'}
            onChange={(e) => onChangeSecretPolicy(e.target.value as SecretPolicy)}
          >
            {(Object.keys(SECRET_POLICY_META) as SecretPolicy[]).map((k) => (
              <option key={k} value={k}>{SECRET_POLICY_META[k].label}</option>
            ))}
          </select>
          <div className="cond-hint">{SECRET_POLICY_META[secretPolicy ?? 'device'].hint}</div>
        </label>
      ) : null}

      <div className="tip">
        {c.apiKey ? (
          (secretPolicy ?? 'device') === 'session'
            ? '已填的密钥只留在内存里，关掉面板即清空，本机不留任何痕迹。'
            : '已填的密钥加密存在本机，且不会写进导出的 JSON。注意：这只是抬高偷看成本，'
              + '并非绝对安全 —— 拿到整个数据目录的人仍能解开。要真正隔离，请用凭据中心的口令模式。'
        ) : (
          '密钥不随画布导出（导出时自动挖空）。想多台机器共用或统一改一处，用上面的凭据更省事。'
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OcrInspector({
  node, edges, onChange, credentials, onOpenCredentials,
  secretPolicy, onChangeSecretPolicy,
}: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  credentials?: Credential[];
  onOpenCredentials?: (kind: string) => void;
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
}) {
  const d = node.data as OcrNodeData;
  const upstream = edges.filter((e) => e.target === node.id).map((e) => e.source);
  const insert = (field: 'url' | 'path' | 'prompt', token: string) =>
    onChange(node.id, { [field]: (d[field] ?? '') + token });

  const src = d.imageSource ?? 'url';

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <LlmConfigPanel nodeId={node.id} cfg={d.llm} onChange={onChange} needVision
        secretPolicy={secretPolicy} onChangeSecretPolicy={onChangeSecretPolicy} />

      <CredentialPicker
        nodeKind="ocr"
        value={d.llm.apiKey}
        credentialId={d.credentialId ?? ''}
        credentials={credentials || []}
        onOpenCredentials={onOpenCredentials}
        onChange={(patch) => onChange(node.id, patch)}
      />

      <div className="field">
        <span>图片来源</span>
        <div className="cond-logic-switch">
          {(Object.keys(IMAGE_SOURCE_META) as ImageSource[]).map((k) => {
            const on = src === k;
            return (
              <button
                key={k}
                type="button"
                className={'cond-logic-btn' + (on ? ' on' : '')}
                style={on ? { borderColor: '#f472b6', color: '#f472b6' } : undefined}
                onClick={() => onChange(node.id, { imageSource: k })}
              >
                {IMAGE_SOURCE_META[k].label}
              </button>
            );
          })}
        </div>
        <div className="cond-hint">{IMAGE_SOURCE_META[src].hint}</div>
      </div>

      {src === 'url' ? (
        <label className="field">
          <span>图片地址</span>
          {upstream.length > 0 && (
            <div className="var-bar">
              {upstream.map((u) => (
                <button key={u} className="chip" onClick={() => insert('url', `{{${u}.output}}`)}>
                  {`{{${u}.output}}`}
                </button>
              ))}
            </div>
          )}
          <input
            className="mono"
            value={d.url}
            placeholder="https://.../image.png"
            onChange={(e) => onChange(node.id, { url: e.target.value })}
          />
        </label>
      ) : (
        <label className="field">
          <span>本地路径</span>
          {upstream.length > 0 && (
            <div className="var-bar">
              {upstream.map((u) => (
                <button key={u} className="chip file" onClick={() => insert('path', `{{${u}.file}}`)}>
                  {`{{${u}.file}}`}
                </button>
              ))}
            </div>
          )}
          <input
            className="mono"
            value={d.path}
            placeholder="/path/to/screenshot.png"
            onChange={(e) => onChange(node.id, { path: e.target.value })}
          />
          {!canReadImage() && (
            <div className="cond-issue warn">浏览器模式不能读本地图片，请用桌面端运行</div>
          )}
        </label>
      )}

      <label className="field">
        <span>识别要求</span>
        <textarea
          rows={3}
          value={d.prompt}
          placeholder={defaultOcrPrompt()}
          onChange={(e) => onChange(node.id, { prompt: e.target.value })}
        />
        <small className="dim">留空用上面的默认提示（按原顺序输出，不解释）</small>
      </label>

      <label className="field">
        <span>图片细节</span>
        <select value={d.detail} onChange={(e) => onChange(node.id, { detail: e.target.value })}>
          <option value="auto">自动</option>
          <option value="low">低（省 token）</option>
          <option value="high">高（识别更准）</option>
        </select>
      </label>

      <div className="field">
        <span>识别结果</span>
        <pre className="out">{d.output || '（尚未运行）'}</pre>
        {d.error && <pre className="out err">{d.error}</pre>}
      </div>

      <div className="tip">
        输出可直接被下游引用：{`{{${node.id}.output}}`}
        。识别出的文字也能交给翻译节点继续处理。
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

function TranslateInspector({
  node, edges, onChange, credentials, onOpenCredentials,
  secretPolicy, onChangeSecretPolicy,
}: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  credentials?: Credential[];
  onOpenCredentials?: (kind: string) => void;
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
}) {
  const d = node.data as TranslateNodeData;
  const upstream = edges.filter((e) => e.target === node.id).map((e) => e.source);
  const insert = (token: string) => onChange(node.id, { text: (d.text ?? '') + token });

  const isPreset = TARGET_LANGS.some((l) => l.code === d.targetLang);

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <LlmConfigPanel nodeId={node.id} cfg={d.llm} onChange={onChange} needVision={false}
        secretPolicy={secretPolicy} onChangeSecretPolicy={onChangeSecretPolicy} />

      <CredentialPicker
        nodeKind="translate"
        value={d.llm.apiKey}
        credentialId={d.credentialId ?? ''}
        credentials={credentials || []}
        onOpenCredentials={onOpenCredentials}
        onChange={(patch) => onChange(node.id, patch)}
      />

      <label className="field">
        <span>目标语言</span>
        <div className="var-bar">
          {TARGET_LANGS.map((l) => (
            <button
              key={l.code}
              className={'chip' + (d.targetLang === l.code ? ' file' : '')}
              onClick={() => onChange(node.id, { targetLang: l.code })}
            >
              {l.label}
            </button>
          ))}
        </div>
        <input
          value={isPreset ? '' : d.targetLang}
          placeholder="或自定义，如「简练的文言文」"
          onChange={(e) => onChange(node.id, { targetLang: e.target.value })}
        />
      </label>

      <label className="field">
        <span>源语言</span>
        <input
          value={d.sourceLang === 'auto' ? '' : d.sourceLang}
          placeholder="留空自动识别"
          onChange={(e) => onChange(node.id, { sourceLang: e.target.value.trim() || 'auto' })}
        />
        <small className="dim">留空让模型自动判断；填了能减少误判（如「日语」）</small>
      </label>

      <label className="field">
        <span>待翻译内容</span>
        {upstream.length > 0 && (
          <div className="var-bar">
            {upstream.map((u) => (
              <button key={u} className="chip" onClick={() => insert(`{{${u}.output}}`)}>
                {`{{${u}.output}}`}
              </button>
            ))}
            <button className="chip" onClick={() => insert('{{input}}')}>{'{{input}}'}</button>
          </div>
        )}
        <textarea
          rows={8}
          value={d.text}
          placeholder="要翻译的文本，或引用上游输出"
          onChange={(e) => onChange(node.id, { text: e.target.value })}
        />
      </label>

      <label className="field">
        <span>术语表（可选）</span>
        <textarea
          className="mono"
          rows={3}
          value={d.glossary}
          placeholder={'GPU=图形处理器\nTransformer=变换器'}
          onChange={(e) => onChange(node.id, { glossary: e.target.value })}
        />
        <small className="dim">每行一条「原文=译文」，保证专有名词译法一致</small>
      </label>

      <div className="field">
        <span>翻译结果</span>
        <pre className="out">{d.output || '（尚未运行）'}</pre>
        {d.error && <pre className="out err">{d.error}</pre>}
      </div>

      <div className="tip">
        模型被要求只输出译文，不含解释或代码块标记，结果可直接喂给下游。
        {`{{${node.id}.output}}`}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

function ConditionInspector({ node, edges, onChange }: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
}) {
  const d = node.data as ConditionNodeData;
  const rules = d.rules ?? [];
  const upstream = edges.filter((e) => e.target === node.id).map((e) => e.source);

  /** 试跑用的示例文本 */
  const [sample, setSample] = useState('');

  const patchRules = (next: typeof rules) => onChange(node.id, { rules: next });

  const updateRule = (rid: string, patch: Partial<ConditionRule>) =>
    patchRules(rules.map((r) => (r.id === rid ? { ...r, ...patch } : r)));

  /**
   * 写回某条规则的条件列表。
   *
   * 单条件时同步回 op/value/source —— 老版本读取路径（节点卡片摘要、
   * 悬空引用检测）只看这三个字段，不同步的话摘要会和实际判定不一致。
   */
  const writeConditions = (rid: string, conds: ConditionItem[]) => {
    const rule = rules.find((r) => r.id === rid);
    if (!rule) return;
    const first = conds[0];
    updateRule(rid, {
      conditions: conds,
      op: first?.op ?? rule.op,
      value: first?.value ?? '',
      source: first?.source ?? '',
    });
  };

  const addRule = () => {
    const n = rules.length + 1;
    patchRules([...rules, makeRule({ id: `r${Date.now().toString(36)}`, label: `分支 ${n}`, op: 'contains', value: '' })]);
  };

  const removeRule = (rid: string) => patchRules(rules.filter((r) => r.id !== rid));

  const moveRule = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[idx], next[j]] = [next[j], next[idx]];
    patchRules(next);
  };

  /* ---------- 子条件增删改 ---------- */

  const addCondition = (rid: string) => {
    const rule = rules.find((r) => r.id === rid);
    if (!rule) return;
    const cur = ruleConditions(rule);
    // 新条件继承第一条的来源，省得每条都重选
    writeConditions(rid, [...cur, makeCondition({ source: cur[0]?.source ?? '' })]);
  };

  const updateCondition = (rid: string, cid: string, patch: Partial<ConditionItem>) => {
    const rule = rules.find((r) => r.id === rid);
    if (!rule) return;
    writeConditions(rid, ruleConditions(rule).map((c) => (c.id === cid ? { ...c, ...patch } : c)));
  };

  const removeCondition = (rid: string, cid: string) => {
    const rule = rules.find((r) => r.id === rid);
    if (!rule) return;
    const next = ruleConditions(rule).filter((c) => c.id !== cid);
    // 至少保留一条：全部删光后规则语义不明（空条件返回 false 会让人困惑）
    writeConditions(rid, next.length > 0 ? next : [makeCondition({ source: rule.source })]);
  };

  const issues = validateCondition(d);
  const sim = sample ? simulateCondition(d, sample) : null;

  /** 试跑结果：规则 id → 命中状态 */
  const statusOf = (rid: string): boolean | null | undefined => {
    if (!sim) return undefined;
    const hit = sim.results.find((r) => r.ruleId === rid);
    if (!hit) return undefined;
    // 命中即停：第一条 true 之后的规则不再参与
    const firstTrue = sim.results.findIndex((r) => r.matched === true);
    const idx = sim.results.indexOf(hit);
    if (firstTrue >= 0 && idx > firstTrue) return undefined;
    return hit.matched;
  };

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      {/* ---------- 可视化试跑 ---------- */}
      <div className="field">
        <span>试跑（可选）</span>
        <textarea
          className="cond-sample"
          rows={3}
          value={sample}
          placeholder="粘一段示例文本进来，立刻看到会命中哪条分支"
          onChange={(e) => setSample(e.target.value)}
        />
        {sim && (
          <div className="cond-sim">
            会走：
            <strong className={sim.branchId === DEFAULT_BRANCH ? 'warn' : (sim.branchId ? 'ok' : 'bad')}>
              {sim.branchLabel}
            </strong>
            {sim.branchId === null && <span className="dim">（下游全部跳过）</span>}
          </div>
        )}
        <small className="dim">
          用这段文本逐条试算子，不改变任何配置。规则卡片上会标出命中 / 未命中
        </small>
      </div>

      {/* ---------- 规则列表 ---------- */}
      <div className="field">
        <span>判定规则（从上到下，命中第一条即停止）</span>
        {rules.length === 0 && <div className="dim">还没有规则，点下面按钮添加</div>}

        {rules.map((r, i) => {
          const conds = ruleConditions(r);
          const multi = conds.length > 1;
          const expr = describeRuleExpression(r);
          const ruleIssues = validateRule(r);
          const st = statusOf(r.id);
          const ruleOn = r.enabled !== false;

          return (
            <div
              key={r.id}
              className={
                'rule-card' +
                (st === true ? ' hit' : '') +
                (st === false ? ' miss' : '') +
                (st === null ? ' broken' : '') +
                (ruleOn ? '' : ' off')
              }
            >
              {/* 头：序号 + 分支名 + 开关 + 上下移动 + 删除 */}
              <div className="rule-row">
                <span className="rule-idx">{i + 1}</span>
                <input
                  className="rule-label"
                  value={r.label}
                  placeholder="分支名"
                  onChange={(e) => updateRule(r.id, { label: e.target.value })}
                />
                <label className="rule-toggle" title={ruleOn ? '点一下停用这条规则' : '这条规则已停用'}>
                  <input
                    type="checkbox"
                    checked={ruleOn}
                    onChange={(e) => updateRule(r.id, { enabled: e.target.checked })}
                  />
                </label>
                {st === true && <span className="rule-flag hit" title="这条命中">命中</span>}
                {st === false && <span className="rule-flag miss" title="未命中">未中</span>}
                {st === null && <span className="rule-flag broken" title="配置有误，运行时跳过">跳过</span>}
                <button className="mini" onClick={() => moveRule(i, -1)} disabled={i === 0} title="上移（越靠前越优先）">↑</button>
                <button className="mini" onClick={() => moveRule(i, 1)} disabled={i === rules.length - 1} title="下移">↓</button>
                <button className="mini danger" onClick={() => removeRule(r.id)}>删</button>
              </div>

              {/* 表达式预览：条件 ... AND/OR 条件 */}
              <div className="cond-expr">
                {expr.parts.map((p, k) => (
                  <span key={p.id} className="cond-expr-item">
                    {k > 0 && (
                      <span
                        className="cond-logic"
                        style={{ borderColor: expr.logicColor, color: expr.logicColor }}
                        title={`${expr.logicLabel}：${LOGIC_META[expr.logic].hint}`}
                      >
                        {expr.logic === 'or' ? '或' : '且'}
                      </span>
                    )}
                    <span className={'cond-chip src' + (p.enabled ? '' : ' off')}>{p.sourceText}</span>
                    <span
                      className={'cond-op-badge' + (p.enabled ? '' : ' off')}
                      style={p.enabled ? { borderColor: p.opColor, color: p.opColor } : undefined}
                    >
                      <span className="cond-op-badge-icon">{p.opIcon}</span>
                      {p.opLabel}
                    </span>
                    {p.valueText !== null && (
                      <span className={'cond-chip val' + (p.valueText ? '' : ' empty') + (p.enabled ? '' : ' off')}>
                        {p.valueText ? `「${p.valueText}」` : '（未填）'}
                      </span>
                    )}
                  </span>
                ))}
              </div>

              {/* 多条件时的 AND / OR 切换 */}
              {multi && (
                <div className="cond-logic-switch">
                  <small className="dim">组合方式</small>
                  {(Object.keys(LOGIC_META) as ConditionLogic[]).map((lg) => {
                    const m = LOGIC_META[lg];
                    const on = expr.logic === lg;
                    return (
                      <button
                        key={lg}
                        type="button"
                        className={'cond-logic-btn' + (on ? ' on' : '')}
                        style={on ? { borderColor: m.color, color: m.color, background: `${m.color}1f` } : undefined}
                        title={m.hint}
                        onClick={() => updateRule(r.id, { logic: lg })}
                      >
                        {m.short} · {m.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* ---------- 条件列表 ---------- */}
              <div className="cond-list">
                {conds.map((c, k) => {
                  const meta = OP_META[c.op];
                  const needsValue = meta.needsValue;
                  const on = c.enabled !== false;
                  return (
                    <div key={c.id} className={'cond-item' + (on ? '' : ' off')}>
                      <div className="cond-item-head">
                        <span className="cond-item-idx">{k + 1}</span>
                        <label className="rule-toggle" title={on ? '停用这条条件' : '启用这条条件'}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => updateCondition(r.id, c.id, { enabled: e.target.checked })}
                          />
                        </label>
                        <select
                          className="cond-op-select"
                          value={c.op}
                          onChange={(e) => updateCondition(r.id, c.id, { op: e.target.value as ConditionOp })}
                          title={meta.hint}
                        >
                          {opsByCategory().map(({ category, ops }) => (
                            <optgroup key={category} label={OP_CATEGORY_META[category].label}>
                              {ops.map((op) => (
                                <option key={op} value={op}>
                                  {OP_META[op].icon} {OP_META[op].label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <button
                          className="mini danger"
                          onClick={() => removeCondition(r.id, c.id)}
                          disabled={conds.length <= 1}
                          title={conds.length <= 1 ? '至少保留一条条件' : '删除这条条件'}
                        >
                          删
                        </button>
                      </div>

                      <div className="cond-item-body">
                        {needsValue && (
                          <input
                            className="rule-value"
                            value={c.value}
                            placeholder={meta.example}
                            onChange={(e) => updateCondition(r.id, c.id, { value: e.target.value })}
                          />
                        )}
                        <select
                          className="cond-src-select"
                          value={c.source}
                          onChange={(e) => updateCondition(r.id, c.id, { source: e.target.value })}
                          title="判定哪段文本"
                        >
                          <option value="">全部上游输出</option>
                          <option value="input">全局输入</option>
                          {upstream.map((u) => <option key={u} value={u}>节点 {u}</option>)}
                        </select>
                      </div>

                      <div className="cond-hint">{meta.hint}</div>
                    </div>
                  );
                })}

                <button className="cond-add" onClick={() => addCondition(r.id)}>
                  + 添加条件（{multi ? LOGIC_META[expr.logic].label : '可组合多个条件'}）
                </button>
              </div>

              {/* 配置问题 */}
              {ruleIssues.map((it, k) => (
                <div key={k} className={'cond-issue ' + it.level}>{it.message}</div>
              ))}
            </div>
          );
        })}

        <button className="kind-btn" onClick={addRule}>+ 添加规则</button>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={d.defaultBranch}
          onChange={(e) => onChange(node.id, { defaultBranch: e.target.checked })}
        />
        <span>启用兜底分支（所有规则都未命中时走 {DEFAULT_BRANCH}）</span>
      </label>

      {/* ---------- 整体体检 ---------- */}
      {issues.length > 0 && (
        <div className="cond-issues">
          <div className="cond-issues-title">配置提示</div>
          {issues.map((it, k) => (
            <div key={k} className={'cond-issue ' + it.level}>{it.message}</div>
          ))}
        </div>
      )}

      <div className="field">
        <span>上次判定结果</span>
        <pre className="out">{d.output || '（尚未运行）'}</pre>
        {d.error && <pre className="out err">{d.error}</pre>}
      </div>

      <div className="tip">
        条件节点不调用 CLI、不消耗积分。把各分支的连线接到节点右侧对应的出口上：
        每条规则对应一个出口，兜底单独一个出口。
        <div style={{ marginTop: 6 }}>
          一条规则可含多条条件，用「且 / 或」组合；条件可单独开关，
          临时停一条比删了重建省事。
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

function TriggerInspector({ node, onChange, webhookTokens }: {
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
function ChatConfig({ d, patchConfig }: {
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

function ParallelInspector({ node, onChange }: {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
}) {
  const d = node.data as ParallelNodeData;
  const rules = d.rules ?? [];
  const patchRules = (next: typeof rules) => onChange(node.id, { rules: next });

  const addRule = () => {
    patchRules([...rules, makeParallelRule({ op: 'contains', value: '', concurrency: 2 })]);
  };

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <label className="field">
        <span>并发方式</span>
        <select
          value={d.mode}
          onChange={(e) => onChange(node.id, { mode: e.target.value as ParallelMode })}
        >
          {(Object.keys(MODE_LABEL) as ParallelMode[]).map((m) => (
            <option key={m} value={m}>{MODE_LABEL[m]}</option>
          ))}
        </select>
        <small className="dim">作用于这个节点的所有下游，直到遇到下一个并发节点</small>
      </label>

      {d.mode === 'fixed' && (
        <label className="field">
          <span>并发数（1~16）</span>
          <input
            type="number" min={1} max={16}
            value={d.concurrency}
            onChange={(e) => onChange(node.id, { concurrency: Number(e.target.value) || 1 })}
          />
        </label>
      )}

      {d.mode === 'byRule' && (
        <>
          <div className="field">
            <span>规则（从上到下，命中第一条即用其并发数）</span>
            {rules.length === 0 && <div className="dim">还没有规则</div>}
            {rules.map((r, i) => (
              <div key={r.id} className="rule-card">
                <div className="rule-row">
                  <span className="rule-idx">{i + 1}</span>
                  <select
                    value={r.op}
                    onChange={(e) => patchRules(rules.map((x, j) =>
                      (j === i ? { ...x, op: e.target.value as ConditionOp } : x)))}
                  >
                    {Object.keys(OP_META).map((op) => (
                      <option key={op} value={op}>{OP_META[op as ConditionOp].label}</option>
                    ))}
                  </select>
                  <button
                    className="mini danger"
                    onClick={() => patchRules(rules.filter((_, j) => j !== i))}
                  >
                    删
                  </button>
                </div>
                <div className="rule-row">
                  <input
                    className="rule-value"
                    value={r.value}
                    placeholder="比较值"
                    onChange={(e) => patchRules(rules.map((x, j) =>
                      (j === i ? { ...x, value: e.target.value } : x)))}
                  />
                  <input
                    type="number" min={1} max={16}
                    className="rule-conc"
                    value={r.concurrency}
                    title="命中时的并发数"
                    onChange={(e) => patchRules(rules.map((x, j) =>
                      (j === i ? { ...x, concurrency: Number(e.target.value) || 1 } : x)))}
                  />
                </div>
              </div>
            ))}
            <button className="kind-btn" onClick={addRule}>+ 添加规则</button>
          </div>

          <label className="field">
            <span>兜底并发数（没命中任何规则时）</span>
            <input
              type="number" min={1} max={16}
              value={d.fallbackConcurrency}
              onChange={(e) => onChange(node.id, { fallbackConcurrency: Number(e.target.value) || 1 })}
            />
          </label>
        </>
      )}

      <div className="tip">
        并发节点不调用 CLI、不消耗积分。建议给耗时的 AI 任务设小并发（1~2）
        避免撞限频，给轻量的文件处理设大并发。
      </div>
    </aside>
  );
}

/* ================================================================== */
/* 循环节点                                                            */
/* ================================================================== */

function LoopInspector({ node, edges, onChange }: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: Props['onChange'];
}) {
  const d = node.data as LoopNodeData;
  const upstream = edges.filter((e) => e.target === node.id).map((e) => e.source);
  const meta = LOOP_MODE_META[d.mode];

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <label className="field">
        <span>迭代来源</span>
        <select
          value={d.mode}
          onChange={(e) => onChange(node.id, { mode: e.target.value as LoopMode })}
        >
          {(Object.keys(LOOP_MODE_META) as LoopMode[]).map((k) => (
            <option key={k} value={k}>{LOOP_MODE_META[k].label}</option>
          ))}
        </select>
        <small className="dim">{meta?.hint}</small>
      </label>

      {d.mode === 'times' && (
        <label className="field">
          <span>迭代次数</span>
          <input
            type="number" min={1} max={MAX_LOOP_ITERATIONS}
            value={d.times}
            onChange={(e) => onChange(node.id, {
              times: Math.max(1, Math.min(MAX_LOOP_ITERATIONS, Number(e.target.value) || 1)),
            })}
          />
        </label>
      )}

      {d.mode === 'list' && (
        <>
          <label className="field">
            <span>取哪个上游的输出</span>
            <select
              value={d.source}
              onChange={(e) => onChange(node.id, { source: e.target.value })}
            >
              <option value="">拼接全部上游</option>
              <option value="input">全局输入 {'{{input}}'}</option>
              {upstream.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>分隔符</span>
            <select
              value={d.separator}
              onChange={(e) => onChange(node.id, { separator: e.target.value })}
            >
              <option value="\n">换行</option>
              <option value=",">逗号</option>
              <option value=";">分号</option>
              <option value="\t">制表符</option>
            </select>
            <small className="dim">按此符号把文本切成多项，空项自动跳过</small>
          </label>
        </>
      )}

      {d.mode === 'glob' && (
        <label className="field">
          <span>通配符</span>
          <input
            value={d.pattern}
            placeholder="/path/to/**/*.ts"
            onChange={(e) => onChange(node.id, { pattern: e.target.value })}
          />
          <small className="dim">支持 * 与 **；匹配到的每个文件作为一轮输入</small>
        </label>
      )}

      <label className="field">
        <span>轮数上限（安全闸）</span>
        <input
          type="number" min={1} max={MAX_LOOP_ITERATIONS}
          value={d.maxIterations}
          onChange={(e) => onChange(node.id, {
            maxIterations: Math.max(1, Math.min(MAX_LOOP_ITERATIONS, Number(e.target.value) || 1)),
          })}
        />
        <small className="dim">防止列表过长把 CLI 打爆，上限 {MAX_LOOP_ITERATIONS}</small>
      </label>

      <label className="field">
        <span>某轮失败时</span>
        <select
          value={d.onError}
          onChange={(e) => onChange(node.id, { onError: e.target.value as LoopOnError })}
        >
          <option value="continue">继续下一轮</option>
          <option value="stop">立即停止循环</option>
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={d.collect}
          onChange={(e) => onChange(node.id, { collect: e.target.checked })}
        />
        <span>收集每轮输出</span>
      </label>
      <small className="dim">
        关闭可省内存；轮数多且输出长时建议关闭
      </small>

      <div className="tip">
        <strong>循环体内可用变量</strong>
        <div style={{ marginTop: 6 }}>
          <code>{'{{loop.item}}'}</code> 当前项 ·{' '}
          <code>{'{{loop.index}}'}</code> 下标（从 0）·{' '}
          <code>{'{{loop.count}}'}</code> 总轮数
        </div>
        <div style={{ marginTop: 8 }}>
          节点右侧有<strong>两个出口</strong>：上方「循环体」每轮执行一次，
          下方「结束」在全部迭代完成后执行一次。
        </div>
      </div>
    </aside>
  );
}

/* ================================================================== */
/* 文件操作节点                                                        */
/* ================================================================== */

const FS_OPS = Object.keys(FS_OP_META) as FsOp[];

function FsInspector({ node, edges, onChange }: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: Props['onChange'];
}) {
  const d = node.data as FsNodeData;
  const meta = FS_OP_META[d.op];
  const upstream = edges.filter((e) => e.target === node.id).map((e) => e.source);

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <label className="field">
        <span>操作</span>
        <select
          value={d.op}
          onChange={(e) => onChange(node.id, { op: e.target.value as FsOp })}
        >
          {FS_OPS.map((k) => (
            <option key={k} value={k}>
              {FS_OP_META[k].label}{FS_OP_META[k].destructive ? '（改磁盘）' : ''}
            </option>
          ))}
        </select>
        <small className="dim">{meta?.hint}</small>
      </label>

      <label className="field">
        <span>路径</span>
        <input
          value={d.path}
          placeholder="/abs/or/relative/path"
          onChange={(e) => onChange(node.id, { path: e.target.value })}
        />
        <small className="dim">支持模板变量，如 {'{{upstream.output}}'} / {'{{loop.item}}'}</small>
      </label>

      {meta?.needsTarget && (
        <label className="field">
          <span>目标路径</span>
          <input
            value={d.target}
            placeholder="/path/to/dest"
            onChange={(e) => onChange(node.id, { target: e.target.value })}
          />
        </label>
      )}

      {meta?.needsContent && (
        <label className="field">
          <span>内容</span>
          <textarea
            rows={6}
            value={d.content}
            placeholder="写入的内容，支持 {{模板变量}}"
            onChange={(e) => onChange(node.id, { content: e.target.value })}
          />
        </label>
      )}

      {d.op === 'read' && (
        <label className="field">
          <span>最大读取字节</span>
          <input
            type="number" min={0}
            value={d.maxBytes}
            onChange={(e) => onChange(node.id, { maxBytes: Math.max(0, Number(e.target.value) || 0) })}
          />
          <small className="dim">超出会截断，0 表示不限制</small>
        </label>
      )}

      {d.op === 'list' && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={d.recursive}
              onChange={(e) => onChange(node.id, { recursive: e.target.checked })}
            />
            <span>递归子目录</span>
          </label>
          <label className="field">
            <span>只保留这些后缀（逗号分隔，留空=全部）</span>
            <input
              value={(d.exts ?? []).join(',')}
              placeholder="ts,tsx,md"
              onChange={(e) => onChange(node.id, {
                exts: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              })}
            />
          </label>
        </>
      )}

      {d.op === 'delete' && (
        <label className="check">
          <input
            type="checkbox"
            checked={d.force}
            onChange={(e) => onChange(node.id, { force: e.target.checked })}
          />
          <span>允许删除非空目录</span>
        </label>
      )}

      {meta?.destructive && (
        <label className="check">
          <input
            type="checkbox"
            checked={d.dryRun}
            onChange={(e) => onChange(node.id, { dryRun: e.target.checked })}
          />
          <span>演练模式（只报告不执行）</span>
        </label>
      )}

      {meta?.destructive && !d.dryRun && (
        <div className="tip warn">
          这个操作会<strong>真正改动磁盘</strong>，且无法撤销。
          建议先勾选「演练模式」跑一遍确认路径无误。
        </div>
      )}

      {upstream.length === 0 && (
        <div className="tip">
          还没有上游节点。路径里可以直接写死，也可以接一个上游节点把结果写进文件。
        </div>
      )}
    </aside>
  );
}

/* ================================================================== */
/* 更新检测节点（B站 UP 主 / 微信公众号）                                */
/* ================================================================== */

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'ok'; text: string; updated: boolean }
  | { phase: 'err'; text: string };

function UpdateInspector({ node, onChange }: {
  node: FlowNode;
  onChange: Props['onChange'];
}) {
  const d = node.data as UpdateNodeData;
  const meta = UPDATE_SOURCE_META[d.source];
  const [test, setTest] = useState<TestState>({ phase: 'idle' });

  /**
   * 试跑一次，但不推进基线。
   *
   * 「测试」就该是只读的 —— 如果它把基线改了，
   * 用户点一下再正式运行，就永远看不到"有更新"了。
   */
  const runTest = async () => {
    setTest({ phase: 'running' });
    try {
      let url = '';
      const headers: Record<string, string> = {};
      if (d.userAgent) headers['User-Agent'] = d.userAgent;

      if (d.source === 'bilibili' && d.biliMode === 'api') {
        const uid = extractBiliUid(d.biliUid);
        if (!uid) {
          setTest({ phase: 'err', text: '填一个 UP 主 UID 或 space.bilibili.com 主页链接' });
          return;
        }
        url = biliApiUrl(uid);
        if (d.biliCookie) headers.Cookie = d.biliCookie;
        if (d.source === 'bilibili') headers.Referer = BILI_REFERER;
      } else {
        url = d.feedUrl.trim();
        if (!url) {
          setTest({ phase: 'err', text: '需要先填订阅源地址' });
          return;
        }
      }

      const res = await fetchText(url, { headers, timeoutSec: d.timeoutSec });
      if (!res.ok) {
        setTest({ phase: 'err', text: `请求失败 HTTP ${res.status}` });
        return;
      }

      const parsed = (d.source === 'bilibili' && d.biliMode === 'api')
        ? parseBiliApi(res.text)
        : parseFeed(res.text);
      if (parsed.error) {
        setTest({ phase: 'err', text: parsed.error });
        return;
      }

      const items = sortByNewest(parsed.items);
      const r = detectUpdate({
        items, lastSeenId: d.lastSeenId, firstRunAsUpdate: d.firstRunAsUpdate,
      });
      const line = [
        `结果：${r.updated ? '有更新' : '无更新'}`,
        r.latest ? `最新：${r.latest.title}` : '',
        r.latest?.url ? r.latest.url : '',
        `说明：${r.reason}`,
        parsed.warnings.length ? `提示：${parsed.warnings.join('；')}` : '',
      ].filter(Boolean).join('\n');
      setTest({ phase: 'ok', text: line, updated: r.updated });
    } catch (err) {
      setTest({ phase: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const resetBaseline = () => {
    onChange(node.id, { lastSeenId: '', lastSeenTitle: '', lastUpdated: null, lastCheckedAt: null });
    setTest({ phase: 'idle' });
  };

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <div className="upd-badge-row">
        <span className="upd-icon">{meta.icon}</span>
        <strong>{meta.label}</strong>
        <span className="dim">输出 true / false</span>
      </div>

      {/* ---------- B站 ---------- */}
      {d.source === 'bilibili' && (
        <>
          <label className="field">
            <span>抓取方式</span>
            <select
              value={d.biliMode}
              onChange={(e) => onChange(node.id, { biliMode: e.target.value as BiliMode })}
            >
              <option value="rss">RSS 订阅源（推荐）</option>
              <option value="api">官方接口（风控严格）</option>
            </select>
            <small className="dim">
              {d.biliMode === 'api'
                ? '官方接口风控严格，报 -352 / -403 时请改用 RSS'
                : '推荐。填 RSSHub 之类的地址'}
            </small>
          </label>

          {d.biliMode === 'api' ? (
            <>
              <label className="field">
                <span>UP 主 UID 或主页链接</span>
                <input
                  value={d.biliUid}
                  placeholder="672328094 或 https://space.bilibili.com/672328094"
                  onChange={(e) => onChange(node.id, { biliUid: e.target.value })}
                />
                <small className="dim">
                  {extractBiliUid(d.biliUid)
                    ? `已识别 UID：${extractBiliUid(d.biliUid)}`
                    : '从 space.bilibili.com/数字 里自动提取'}
                </small>
              </label>
              <label className="field">
                <span>Cookie（可选，遇风控时填）</span>
                <input
                  type="password"
                  value={d.biliCookie}
                  placeholder="SESSDATA=xxx; buvid3=xxx"
                  onChange={(e) => onChange(node.id, { biliCookie: e.target.value })}
                />
                <small className="dim">
                  只填 SESSDATA 往往不够，B站 还会看 buvid3 / _uuid —— 把浏览器里整条 Cookie 粘进来最省事
                </small>
              </label>
            </>
          ) : (
            <label className="field">
              <span>RSS 订阅源地址</span>
              <input
                value={d.feedUrl}
                placeholder="https://rsshub.app/bilibili/user/video/672328094"
                onChange={(e) => onChange(node.id, { feedUrl: e.target.value })}
              />
            </label>
          )}
        </>
      )}

      {/* ---------- 公众号 ---------- */}
      {d.source === 'wechat' && (
        <label className="field">
          <span>订阅源地址（RSS / Atom）</span>
          <input
            value={d.feedUrl}
            placeholder="https://wechat2rss.bestblogs.dev/feed/xxxx.xml"
            onChange={(e) => onChange(node.id, { feedUrl: e.target.value })}
          />
          <small className="dim">
            公众号<strong>没有官方开放接口</strong>，需要用第三方桥接生成订阅地址：
            wechat2rss、RSSHub、Feeddd 等。免费源常有调用次数限制，失效时换一个即可。
          </small>
        </label>
      )}

      {/* ---------- 共用 ---------- */}
      <label className="field">
        <span>自定义 User-Agent（可选）</span>
        <input
          value={d.userAgent}
          placeholder="留空用内置浏览器 UA"
          onChange={(e) => onChange(node.id, { userAgent: e.target.value })}
        />
      </label>

      <label className="field">
        <span>超时秒数</span>
        <input
          type="number" min={1} max={120}
          value={d.timeoutSec}
          onChange={(e) => onChange(node.id, {
            timeoutSec: Math.max(1, Math.min(120, Number(e.target.value) || 15)),
          })}
        />
      </label>

      <label className="field">
        <span>输出格式</span>
        <select
          value={d.outputFormat}
          onChange={(e) => onChange(node.id, { outputFormat: e.target.value })}
        >
          <option value="bool">bool（只输出 true / false）</option>
          <option value="detail">detail（附带标题与链接）</option>
        </select>
        <small className="dim">
          接条件节点用 bool，这样 <code>{'equals true'}</code> 才生效
        </small>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={d.firstRunAsUpdate}
          onChange={(e) => onChange(node.id, { firstRunAsUpdate: e.target.checked })}
        />
        <span>首次检查也算更新</span>
      </label>
      <small className="dim">默认关闭：刚配好就触发一次下游通常是误报</small>

      {/* ---------- 基线 ---------- */}
      <div className="upd-baseline">
        <div>
          基线：{d.lastSeenId ? <code>{d.lastSeenId}</code> : <span className="dim">未记录</span>}
        </div>
        {d.lastSeenTitle && <div className="dim">最新：{d.lastSeenTitle}</div>}
        <button className="mini" onClick={resetBaseline} disabled={!d.lastSeenId}>
          重置基线（下次运行重新记录）
        </button>
      </div>

      {/* ---------- 试跑 ---------- */}
      <button className="p-btn" onClick={runTest} disabled={test.phase === 'running'}>
        {test.phase === 'running' ? '检查中…' : '测试连接'}
      </button>
      <small className="dim">只抓取并判定，不会更新基线</small>

      {test.phase !== 'idle' && test.phase !== 'running' && (
        <pre className={`upd-test ${test.phase === 'ok' ? (test.updated ? 'yes' : 'no') : 'err'}`}>
          {test.text}
        </pre>
      )}

      <div className="tip">
        <strong>怎么用</strong>
        <div style={{ marginTop: 6 }}>
          输出 <code>true</code> / <code>false</code>，后面接一个条件节点即可分流：
          <br />
          条件节点来源选本节点，判定「等于 <code>true</code>」。
        </div>
        <div style={{ marginTop: 6 }}>
          下游任务节点还能用 <code>{'{{' + node.id + '.title}}'}</code> 拿到新条目标题，
          <code>{'{{' + node.id + '.url}}'}</code> 拿到链接。
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* GitHub 节点                                                         */
/* ------------------------------------------------------------------ */

const GH_STRATEGY_META: Record<GithubStrategy, { label: string; hint: string }> = {
  api: { label: 'GitHub API', hint: '要令牌；公开库可不填。信息最全' },
  atom: { label: '订阅源', hint: '免令牌，但只能读公开库' },
  cli: { label: '本地 git', hint: '走机器上的 git，免令牌；推送时需要本地仓库' },
};

/**
 * 凭据选择区。
 *
 * 只列出**满足本节点权限要求**的凭据 —— 推送节点不会让你选一把只有读权限的令牌，
 * 从源头避免"选完才在运行时撞 403"。
 */
function CredentialPicker({
  nodeKind, value, credentialId, credentials, onOpenCredentials, onChange,
}: {
  nodeKind: string;
  value: string;
  credentialId: string;
  credentials: Credential[];
  onOpenCredentials?: (kind: string) => void;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const need = NODE_NEEDS[nodeKind] || [];
  const usable = (credentials || []).filter(
    (c) => missingCapabilities(c.capabilities, need).length === 0,
  );
  const wantKind = kindForNeed(need);
  const selected = (credentials || []).find((c) => c.id === credentialId);

  return (
    <div className="gh-cred">
      <div className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>凭据</span>
        <select
          className="p-input"
          value={credentialId || ''}
          onChange={(e) => onChange({ credentialId: e.target.value })}
        >
          <option value="">（不用凭据，用下面内联的密钥）</option>
          {usable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.identity ? ` (@${c.identity})` : ''}
              {c.ambiguous ? ' · 权限待确认' : ''}
            </option>
          ))}
        </select>
      </div>

      {usable.length === 0 ? (
        <div className="gh-note">
          还没有能用于本节点的凭据
          {need.length ? `（需要：${need.join(' / ')}）` : ''}。
          {onOpenCredentials ? (
            <button
              className="link-btn"
              onClick={() => onOpenCredentials(wantKind || 'generic')}
            >
              去凭据中心填写 →
            </button>
          ) : null}
        </div>
      ) : null}

      {selected && selected.ambiguous && need.indexOf('github:write') >= 0 ? (
        <div className="gh-warn">
          这条凭据的权限无法自动判定。若推送时报 403，多半是它没有写权限 ——
          重新申请时勾选 repo（私有库）或 public_repo（公开库）。
        </div>
      ) : null}

      {!credentialId ? (
        <label className="p-row">
          <span className="p-muted" style={{ width: 64, flex: 'none' }}>内联密钥</span>
          <input
            className="p-input"
            type="password"
            value={value || ''}
            onChange={(e) => onChange({ token: e.target.value })}
            placeholder="不推荐：会随画布保存。请在凭据中心统一填写"
          />
        </label>
      ) : null}
    </div>
  );
}

function OrderPicker({
  order, fallback, onChange,
}: {
  order: GithubStrategy[];
  fallback: GithubStrategy[];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const list = order && order.length ? order : fallback;
  const toggle = (s: GithubStrategy) => {
    const has = list.indexOf(s) >= 0;
    const next = has ? list.filter((x) => x !== s) : list.concat(s);
    onChange({ order: next.length ? next : fallback });
  };
  return (
    <div className="p-row" style={{ flexWrap: 'wrap', gap: 6 }}>
      <span className="p-muted" style={{ width: 64, flex: 'none' }}>方案</span>
      {(Object.keys(GH_STRATEGY_META) as GithubStrategy[]).map((s) => (
        <button
          key={s}
          className={`chip ${list.indexOf(s) >= 0 ? 'on' : ''}`}
          onClick={() => toggle(s)}
          title={GH_STRATEGY_META[s].hint}
        >
          {GH_STRATEGY_META[s].label}
        </button>
      ))}
      <span className="p-muted" style={{ fontSize: 11 }}>
        顺序即优先级，前面的失败自动换下一个
      </span>
    </div>
  );
}

function GithubUpdateInspector({
  node, edges, onChange, credentials, onOpenCredentials,
}: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  credentials?: Credential[];
  onOpenCredentials?: (kind: string) => void;
}) {
  const d = node.data as unknown as GithubUpdateNodeData;
  const patch = (p: Record<string, unknown>) => onChange(node.id, p);
  return (
    <>
      <div className="insp-title">
        <input
          className="title-input"
          value={d.label}
          onChange={(e) => patch({ label: e.target.value })}
        />
        <span className="insp-kind">GitHub 更新</span>
      </div>

      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>仓库</span>
        <input className="p-input" style={{ flex: 1 }}
          value={d.owner} placeholder="owner"
          onChange={(e) => patch({ owner: e.target.value })} />
        <span className="p-muted">/</span>
        <input className="p-input" style={{ flex: 1 }}
          value={d.repo} placeholder="repo"
          onChange={(e) => patch({ repo: e.target.value })} />
      </label>

      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>分支</span>
        <input className="p-input"
          value={d.branch} placeholder="留空用默认分支"
          onChange={(e) => patch({ branch: e.target.value })} />
      </label>

      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>基准</span>
        <input className="p-input"
          value={d.base} placeholder="本地 HEAD，留空则只取远端状态"
          onChange={(e) => patch({ base: e.target.value })} />
      </label>

      <CredentialPicker
        nodeKind="github-update"
        value={d.token}
        credentialId={d.credentialId}
        credentials={credentials || []}
        onOpenCredentials={onOpenCredentials}
        onChange={patch}
      />

      <OrderPicker
        order={d.order}
        fallback={['api', 'atom', 'cli']}
        onChange={patch}
      />

      <div className="p-muted" style={{ fontSize: 12, marginTop: 6 }}>
        输出 true / false，条件节点判断「等于 true」即可分流。
        另附 {`{{${node.id}.sha}}`}、{`{{${node.id}.message}}`} 等字段。
      </div>
    </>
  );
}

function GithubPushInspector({
  node, edges, onChange, credentials, onOpenCredentials,
}: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
  credentials?: Credential[];
  onOpenCredentials?: (kind: string) => void;
}) {
  const d = node.data as unknown as GithubPushNodeData;
  const patch = (p: Record<string, unknown>) => onChange(node.id, p);
  return (
    <>
      <div className="insp-title">
        <input
          className="title-input"
          value={d.label}
          onChange={(e) => patch({ label: e.target.value })}
        />
        <span className="insp-kind">GitHub 推送</span>
      </div>

      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>仓库</span>
        <input className="p-input" style={{ flex: 1 }}
          value={d.owner} placeholder="owner"
          onChange={(e) => patch({ owner: e.target.value })} />
        <span className="p-muted">/</span>
        <input className="p-input" style={{ flex: 1 }}
          value={d.repo} placeholder="repo"
          onChange={(e) => patch({ repo: e.target.value })} />
      </label>

      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>分支</span>
        <input className="p-input"
          value={d.branch} placeholder="main"
          onChange={(e) => patch({ branch: e.target.value })} />
      </label>

      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>提交信息</span>
        <input className="p-input"
          value={d.message} placeholder="支持 {{上游.output}}"
          onChange={(e) => patch({ message: e.target.value })} />
      </label>

      <label className="p-col">
        <span className="p-muted">文件（每行一条 路径=内容）</span>
        <textarea
          className="p-input"
          rows={5}
          value={d.filesText}
          placeholder={'README.md=# 标题\nnotes/{{date}}.txt={{上游.output}}'}
          onChange={(e) => patch({ filesText: e.target.value })}
        />
      </label>

      <CredentialPicker
        nodeKind="github-push"
        value={d.token}
        credentialId={d.credentialId}
        credentials={credentials || []}
        onOpenCredentials={onOpenCredentials}
        onChange={patch}
      />

      <OrderPicker
        order={d.order}
        fallback={['api', 'cli']}
        onChange={patch}
      />

      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>本地路径</span>
        <input className="p-input"
          value={d.workdir} placeholder="仅 git 方案需要"
          onChange={(e) => patch({ workdir: e.target.value })} />
      </label>
    </>
  );
}
