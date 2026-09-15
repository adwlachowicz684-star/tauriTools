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
import { LlmConfigPanel, CredentialPicker } from './shared';

export function OcrInspector({
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
