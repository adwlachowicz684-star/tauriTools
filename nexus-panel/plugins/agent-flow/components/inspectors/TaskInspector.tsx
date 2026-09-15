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
import { FileParamsPanel } from './shared';

export function TaskInspector({ node, edges, onChange }: {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
}) {
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

