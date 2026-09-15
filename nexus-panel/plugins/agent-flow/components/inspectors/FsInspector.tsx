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

type Props = {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
};

const FS_OPS = Object.keys(FS_OP_META) as FsOp[];

export function FsInspector({ node, edges, onChange }: {
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
