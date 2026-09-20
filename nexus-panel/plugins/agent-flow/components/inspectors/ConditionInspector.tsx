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
import SaveAsCustom from './SaveAsCustom';

const OPS = Object.keys(OP_META) as ConditionOp[];

export function ConditionInspector({ node, edges, onChange }: {
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
        <span className="field-label-row">
          节点名称
          <SaveAsCustom node={node} />
        </span>
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
          /* 卡片级错误态：错误文字已经在卡片内逐条列出了，但没有这条
             标记的话，扫视时看不出哪张卡有问题 —— 得把每张卡的文字
             都读一遍。加上 .has-error 后卡片内输入框一起变红，
             一眼就能定位到第几条。 */
          const ruleErrors = ruleIssues.filter((it) => it.level === 'error');
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
                (ruleOn ? '' : ' off') +
                (ruleErrors.length > 0 ? ' has-error' : '')
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
        <div style={{ marginTop: 'var(--sp-3, 6px)' }}>
          一条规则可含多条条件，用「且 / 或」组合；条件可单独开关，
          临时停一条比删了重建省事。
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
