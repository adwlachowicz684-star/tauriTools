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
import { CredentialPicker, OrderPicker } from './shared';

export function GithubPushInspector({
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
