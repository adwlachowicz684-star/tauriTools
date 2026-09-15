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

export function TranslateInspector({
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
