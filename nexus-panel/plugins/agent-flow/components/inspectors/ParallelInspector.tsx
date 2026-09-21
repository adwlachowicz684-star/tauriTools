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
import { DEFAULT_TRIGGER_CONFIG } from '../../types';
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

const MODE_LABEL: Record<ParallelMode, string> = {
  fixed: '固定并发数',
  byRule: '按条件决定',
  all: '不限制',
};

export function ParallelInspector({ node, onChange }: {
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
      {/*
       * 名称已上移到通用基础信息区（inspectors/NodeBasics），
       * 连同「存为自定义」一起。以前每个面板各写一份 ——
       * 改文案或改存储方式要同步五处，而漏一处不会报错。
       */}

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
