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

const GH_STRATEGY_META: Record<GithubStrategy, { label: string; hint: string }> = {
  api: { label: 'GitHub API', hint: '要令牌；公开库可不填。信息最全' },
  atom: { label: '订阅源', hint: '免令牌，但只能读公开库' },
  cli: { label: '本地 git', hint: '走机器上的 git，免令牌；推送时需要本地仓库' },
};

/* 导出是因为 UpdateTestPanel.tsx 要用它声明 useState 的类型 ——
   两个文件描述的是同一次"试跑"的状态机，各写一份迟早会漂。 */
export type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'ok'; text: string; updated: boolean }
  | { phase: 'err'; text: string };

/**
 * 任务节点的「输出参数」面板。
 *
 * 独立成组件是因为它有两块内容（文件参数 + 自定义参数），
 * 塞进上面的主面板会让那个函数长到看不清结构。
 */
/* onChange 与 FieldRenderProps.patch 同为**单参数**（只收 patch）——
   节点 id 由调用方的 patchObj 自带，不需要再传一次。

   这里原先写成 (id, patch) 双参数，而 task.tsx 传的是 p.patch（单参数）。
   于是「+ 添加参数」点下去时，第二个实参被丢弃，patch 变成了节点 id
   字符串 —— params 一个都没写进去，反而把 "task1a2b" 展开成
   {0:'t',1:'a',…} 污染了节点 data。表现是"点了没反应"，
   实际还在悄悄写脏数据。

   而 task.tsx 那边的 `as never` 把类型检查整个绕过，编译器也拦不住。
   两侧都改回单参数，类型才是真对上了。 */
export function FileParamsPanel({ node, onChange }: {
  node: FlowNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const d = node.data as TaskNodeData;
  const cfg = d.fileOutput ?? defaultFileOutput();
  const params = d.params ?? [];

  const patchCfg = (patch: Partial<TaskFileOutput>) =>
    onChange({ fileOutput: { ...cfg, ...patch } });

  const patchParams = (next: NodeParam[]) => onChange({ params: next });

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

/**
 * 大模型配置的公共区块。
 *
 * OCR 与翻译共用：服务商 / 地址 / 模型 / Key / 超时。
 * needVision 为 true 时会校验"该服务商是否支持图片"，
 * 免得用户配完才发现选了个不支持视觉的模型。
 */
/*
 * onChange 统一为**单参数**（只收 patch），与 FileParamsPanel / OrderPicker
 * 一致 —— 见下面 FileParamsPanel 关于"双参数被静默丢弃"的说明。
 *
 * 三个组件签名不一致本身就是这类 bug 的温床：
 * 调用方每次都得先想"这个组件是接一个还是两个参数"，
 * 想错一次就是"点了没反应"，而 `as never` 还会让编译器闭嘴。
 * 统一之后调用方一律写 onChange={p.patch}，没有记错的余地。
 *
 * nodeId 因此不再需要 —— 它本来只是为了让调用方凑出双参数而传的。
 */
export function LlmConfigPanel({
  cfg, onChange, needVision, secretPolicy, onChangeSecretPolicy,
}: {
  cfg: LlmConfig;
  onChange: (patch: Record<string, unknown>) => void;
  needVision: boolean;
  /** 当前密钥落盘策略；不传则不显示这一项 */
  secretPolicy?: SecretPolicy;
  onChangeSecretPolicy?: (p: SecretPolicy) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const c = cfg ?? defaultLlmConfig();
  const issues = validateConfig(c, needVision);
  const preset = PROVIDER_META[c.provider] ?? PROVIDER_META.custom;

  const set = (p: Partial<LlmConfig>) => onChange({ llm: { ...c, ...p } });

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

/**
 * 凭据选择区。
 *
 * 只列出**满足本节点权限要求**的凭据 —— 推送节点不会让你选一把只有读权限的令牌，
 * 从源头避免"选完才在运行时撞 403"。
 */
export function CredentialPicker({
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

export function OrderPicker({
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
    <div className="p-row" style={{ flexWrap: 'wrap', gap: 'var(--sp-3, 6px)' }}>
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
      <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
        顺序即优先级，前面的失败自动换下一个
      </span>
    </div>
  );
}
