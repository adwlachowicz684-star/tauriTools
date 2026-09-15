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

export function GithubUpdateInspector({
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
