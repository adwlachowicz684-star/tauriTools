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

export function LoopInspector({ node, edges, onChange }: {
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
