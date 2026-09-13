import { useState } from 'react';
import {
  CLI_META, TRIGGER_META, DEFAULT_BRANCH, OP_META, triggerKindsOf,
  makeRule, makeParallelRule,
  isCondition, isTrigger, isParallel, isLoop, isFs, isUpdate, UPDATE_SOURCE_META,
  opsByCategory, OP_CATEGORY_META,
  LOOP_MODE_META, FS_OP_META, MAX_LOOP_ITERATIONS,
  type CliKind, type ConditionOp, type ConditionNodeData,
  type TriggerKind, type TriggerConfig, type TriggerNodeData,
  type ParallelMode, type ParallelNodeData, type TaskNodeData,
  type LoopMode, type LoopNodeData, type LoopOnError,
  type FsOp, type FsNodeData,
  type UpdateNodeData, type BiliMode,
} from '../types';
import { fetchText } from '../lib/tauri';
import {
  validateRule, validateCondition, simulateCondition, describeRuleParts,
} from '../engine/condition';
import { parseFeed, parseBiliApi, detectUpdate, sortByNewest, extractBiliUid, biliApiUrl, BILI_REFERER } from '../engine/updates';
import type { FlowEdge, FlowNode } from '../flowTypes';

type Props = {
  node: FlowNode | null;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
};

const OPS = Object.keys(OP_META) as ConditionOp[];

export default function Inspector({ node, edges, onChange }: Props) {
  if (!node) {
    return (
      <aside className="inspector">
        <div className="empty-hint">
          选中一个节点来编辑内容
          <br />
          <small>工具栏「+ 任务」添加 CLI 节点，「+ 条件」添加分支判断</small>
        </div>
      </aside>
    );
  }

  /* ---------- 条件节点 ---------- */
  if (isCondition(node.data)) {
    return <ConditionInspector node={node} edges={edges} onChange={onChange} />;
  }

  /* ---------- 触发器节点 ---------- */
  if (isTrigger(node.data)) {
    return <TriggerInspector node={node} onChange={onChange} />;
  }

  /* ---------- 并发节点 ---------- */
  if (isParallel(node.data)) {
    return <ParallelInspector node={node} onChange={onChange} />;
  }

  /* ---------- 循环节点 ---------- */
  if (isLoop(node.data)) {
    return <LoopInspector node={node} edges={edges} onChange={onChange} />;
  }

  /* ---------- 文件操作节点 ---------- */
  if (isFs(node.data)) {
    return <FsInspector node={node} edges={edges} onChange={onChange} />;
  }

  /* ---------- 更新检测节点（B站 / 公众号） ---------- */
  if (isUpdate(node.data)) {
    return <UpdateInspector node={node} onChange={onChange} />;
  }

  /* ---------- 任务节点 ---------- */
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

      <div className="field">
        <span>运行输出</span>
        <pre className="out">{d.output || '（尚未运行）'}</pre>
        {d.error && <pre className="out err">{d.error}</pre>}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

function ConditionInspector({ node, edges, onChange }: {
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

  const updateRule = (rid: string, patch: Partial<(typeof rules)[number]>) =>
    patchRules(rules.map((r) => (r.id === rid ? { ...r, ...patch } : r)));

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

  const issues = validateCondition(d);
  const sim = sample ? simulateCondition(d, sample) : null;

  /** 试跑结果：规则 id → 命中状态；含兜底 */
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
        <span>节点名称</span>
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
          const needsValue = OP_META[r.op]?.needsValue ?? true;
          const meta = OP_META[r.op];
          const parts = describeRuleParts(r);
          const ruleIssues = validateRule(r);
          const st = statusOf(r.id);

          return (
            <div
              key={r.id}
              className={
                'rule-card' +
                (st === true ? ' hit' : '') +
                (st === false ? ' miss' : '') +
                (st === null ? ' broken' : '')
              }
            >
              {/* 头：序号 + 分支名 + 上下移动 + 删除 */}
              <div className="rule-row">
                <span className="rule-idx">{i + 1}</span>
                <input
                  className="rule-label"
                  value={r.label}
                  placeholder="分支名"
                  onChange={(e) => updateRule(r.id, { label: e.target.value })}
                />
                {st === true && <span className="rule-flag hit" title="这条命中">命中</span>}
                {st === false && <span className="rule-flag miss" title="未命中">未中</span>}
                {st === null && <span className="rule-flag broken" title="配置有误，运行时跳过">跳过</span>}
                <button className="mini" onClick={() => moveRule(i, -1)} disabled={i === 0} title="上移（越靠前越优先）">↑</button>
                <button className="mini" onClick={() => moveRule(i, 1)} disabled={i === rules.length - 1} title="下移">↓</button>
                <button className="mini danger" onClick={() => removeRule(r.id)}>删</button>
              </div>

              {/* 可视化表达式：来源 chip + 算子徽章 + 值 chip */}
              <div className="cond-expr">
                <span className="cond-chip src">{parts.sourceText}</span>
                <span className="cond-op-badge" style={{ borderColor: parts.opColor, color: parts.opColor }}>
                  <span className="cond-op-badge-icon">{parts.opIcon}</span>
                  {parts.opLabel}
                </span>
                {needsValue && (
                  <span className={'cond-chip val' + (r.value ? '' : ' empty')}>
                    {r.value ? `「${r.value}」` : '（未填）'}
                  </span>
                )}
              </div>

              {/* 算子选择：分类图标网格，替代纯文字下拉 */}
              <div className="cond-ops">
                {opsByCategory().map(({ category, ops }) => (
                  <div key={category} className="cond-op-group">
                    <div className="cond-op-group-title" title={OP_CATEGORY_META[category].hint}>
                      {OP_CATEGORY_META[category].label}
                    </div>
                    <div className="cond-op-items">
                      {ops.map((op) => {
                        const m = OP_META[op];
                        const on = r.op === op;
                        return (
                          <button
                            key={op}
                            type="button"
                            className={'cond-op-btn' + (on ? ' on' : '')}
                            style={on ? { borderColor: m.color, color: m.color, background: `${m.color}1f` } : undefined}
                            title={`${m.hint}\n例：${m.example}`}
                            onClick={() => updateRule(r.id, { op })}
                          >
                            <span className="cond-op-btn-icon">{m.icon}</span>
                            {m.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* 参数 */}
              <div className="rule-row">
                {needsValue && (
                  <input
                    className="rule-value"
                    value={r.value}
                    placeholder={meta.example}
                    onChange={(e) => updateRule(r.id, { value: e.target.value })}
                  />
                )}
              </div>

              <div className="rule-row">
                <small className="dim">判定来源</small>
                <select value={r.source} onChange={(e) => updateRule(r.id, { source: e.target.value })}>
                  <option value="">全部上游输出（拼接）</option>
                  <option value="input">全局输入 {{'{{input}}'}}</option>
                  {upstream.map((u) => <option key={u} value={u}>节点 {u} 的输出</option>)}
                </select>
              </div>

              {/* 算子语义提示 */}
              <div className="cond-hint">{meta.hint}</div>

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
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

function TriggerInspector({ node, onChange }: {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
}) {
  const d = node.data as TriggerNodeData;
  const patchConfig = (patch: Partial<TriggerConfig>) =>
    onChange(node.id, { config: { ...d.config, ...patch } });

  /** 兼容旧的单值字段：读的时候统一走 triggerKindsOf */
  const selected = triggerKindsOf(d);
  const toggle = (k: TriggerKind, on: boolean) => {
    const next = on
      ? (selected.includes(k) ? selected : [...selected, k])
      : selected.filter((x) => x !== k);
    // 写回时一并清掉旧的 trigger 字段，避免它与 triggers 打架
    onChange(node.id, { triggers: next, trigger: undefined });
  };

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <div className="field">
        <span>触发方式（可多选）</span>
        <div className="trig-multi">
          {(Object.keys(TRIGGER_META) as TriggerKind[]).map((k) => {
            const on = selected.includes(k);
            return (
              <label key={k} className={'trig-check' + (on ? ' on' : '')} title={TRIGGER_META[k].hint}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => toggle(k, e.target.checked)}
                />
                <span className="trig-check-icon">{TRIGGER_META[k].icon}</span>
                <span className="trig-check-label">{TRIGGER_META[k].label}</span>
              </label>
            );
          })}
        </div>
        <small className="dim">
          {selected.length === 0
            ? '一个都没选 —— 这个节点不会触发'
            : selected.length === 1
              ? TRIGGER_META[selected[0]].hint
              : `已选 ${selected.length} 种，任一满足即触发`}
        </small>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={d.enabled !== false}
          onChange={(e) => onChange(node.id, { enabled: e.target.checked })}
        />
        <span>启用这个触发器</span>
      </label>

      {selected.includes('interval') && (
        <label className="field">
          <span>间隔秒数（最小 10，避免把 CLI 打爆）</span>
          <input
            type="number" min={10}
            value={d.config.intervalSec}
            onChange={(e) => patchConfig({ intervalSec: Math.max(10, Number(e.target.value) || 10) })}
          />
        </label>
      )}

      {selected.includes('cron') && (
        <label className="field">
          <span>cron 表达式（分 时 日 月 周）</span>
          <input
            value={d.config.cronExpr}
            placeholder="0 9 * * 1-5"
            onChange={(e) => patchConfig({ cronExpr: e.target.value })}
          />
        </label>
      )}

      {selected.includes('watch') && (
        <>
          <label className="field">
            <span>监听目录</span>
            <input
              value={d.config.watchDir}
              placeholder="/path/to/dir"
              onChange={(e) => patchConfig({ watchDir: e.target.value })}
            />
          </label>
          <label className="field">
            <span>只关心这些后缀（逗号分隔，留空=全部）</span>
            <input
              value={(d.config.watchExts ?? []).join(',')}
              placeholder="py,js,ts"
              onChange={(e) => patchConfig({
                watchExts: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
              })}
            />
          </label>
          <label className="field">
            <span>防抖毫秒</span>
            <input
              type="number" min={0}
              value={d.config.debounceMs}
              onChange={(e) => patchConfig({ debounceMs: Number(e.target.value) || 0 })}
            />
          </label>
        </>
      )}

      {selected.includes('webhook') && (
        <>
          <div className="field row2">
            <label className="field">
              <span>端口</span>
              <input
                type="number"
                value={d.config.port}
                onChange={(e) => patchConfig({ port: Number(e.target.value) || 8787 })}
              />
            </label>
            <label className="field">
              <span>路径</span>
              <input
                value={d.config.path}
                onChange={(e) => patchConfig({ path: e.target.value || '/' })}
              />
            </label>
          </div>
          <div className="url-box">
            <code>{`http://127.0.0.1:${d.config.port}${d.config.path}`}</code>
          </div>
          <label className="field">
            <span>校验 Token（留空=不校验）</span>
            <input value={d.config.token} onChange={(e) => patchConfig({ token: e.target.value })} />
          </label>
        </>
      )}

      <label className="field">
        <span>触发时注入的输入（节点里用 <code>{'{{input}}'}</code> 读取）</span>
        <textarea
          rows={4}
          value={d.input}
          onChange={(e) => onChange(node.id, { input: e.target.value })}
        />
      </label>

      <div className="tip">
        触发器节点是工作流的起点，不消耗积分。它的下游就是要执行的任务链。
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

const MODE_LABEL: Record<ParallelMode, string> = {
  fixed: '固定并发数',
  byRule: '按条件决定',
  all: '不限制',
};

function ParallelInspector({ node, onChange }: {
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
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

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

function LoopInspector({ node, edges, onChange }: {
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

function FsInspector({ node, edges, onChange }: {
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

function UpdateInspector({ node, onChange }: {
  node: FlowNode;
  onChange: Props['onChange'];
}) {
  const d = node.data as UpdateNodeData;
  const meta = UPDATE_SOURCE_META[d.source];
  const [test, setTest] = useState<TestState>({ phase: 'idle' });

  /**
   * 试跑一次，但不推进基线。
   *
   * 「测试」就该是只读的 —— 如果它把基线改了，
   * 用户点一下再正式运行，就永远看不到"有更新"了。
   */
  const runTest = async () => {
    setTest({ phase: 'running' });
    try {
      let url = '';
      const headers: Record<string, string> = {};
      if (d.userAgent) headers['User-Agent'] = d.userAgent;

      if (d.source === 'bilibili' && d.biliMode === 'api') {
        const uid = extractBiliUid(d.biliUid);
        if (!uid) {
          setTest({ phase: 'err', text: '填一个 UP 主 UID 或 space.bilibili.com 主页链接' });
          return;
        }
        url = biliApiUrl(uid);
        if (d.biliCookie) headers.Cookie = d.biliCookie;
        if (d.source === 'bilibili') headers.Referer = BILI_REFERER;
      } else {
        url = d.feedUrl.trim();
        if (!url) {
          setTest({ phase: 'err', text: '需要先填订阅源地址' });
          return;
        }
      }

      const res = await fetchText(url, { headers, timeoutSec: d.timeoutSec });
      if (!res.ok) {
        setTest({ phase: 'err', text: `请求失败 HTTP ${res.status}` });
        return;
      }

      const parsed = (d.source === 'bilibili' && d.biliMode === 'api')
        ? parseBiliApi(res.text)
        : parseFeed(res.text);
      if (parsed.error) {
        setTest({ phase: 'err', text: parsed.error });
        return;
      }

      const items = sortByNewest(parsed.items);
      const r = detectUpdate({
        items, lastSeenId: d.lastSeenId, firstRunAsUpdate: d.firstRunAsUpdate,
      });
      const line = [
        `结果：${r.updated ? '有更新' : '无更新'}`,
        r.latest ? `最新：${r.latest.title}` : '',
        r.latest?.url ? r.latest.url : '',
        `说明：${r.reason}`,
        parsed.warnings.length ? `提示：${parsed.warnings.join('；')}` : '',
      ].filter(Boolean).join('\n');
      setTest({ phase: 'ok', text: line, updated: r.updated });
    } catch (err) {
      setTest({ phase: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const resetBaseline = () => {
    onChange(node.id, { lastSeenId: '', lastSeenTitle: '', lastUpdated: null, lastCheckedAt: null });
    setTest({ phase: 'idle' });
  };

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <div className="upd-badge-row">
        <span className="upd-icon">{meta.icon}</span>
        <strong>{meta.label}</strong>
        <span className="dim">输出 true / false</span>
      </div>

      {/* ---------- B站 ---------- */}
      {d.source === 'bilibili' && (
        <>
          <label className="field">
            <span>抓取方式</span>
            <select
              value={d.biliMode}
              onChange={(e) => onChange(node.id, { biliMode: e.target.value as BiliMode })}
            >
              <option value="rss">RSS 订阅源（推荐）</option>
              <option value="api">官方接口（风控严格）</option>
            </select>
            <small className="dim">
              {d.biliMode === 'api'
                ? '官方接口风控严格，报 -352 / -403 时请改用 RSS'
                : '推荐。填 RSSHub 之类的地址'}
            </small>
          </label>

          {d.biliMode === 'api' ? (
            <>
              <label className="field">
                <span>UP 主 UID 或主页链接</span>
                <input
                  value={d.biliUid}
                  placeholder="672328094 或 https://space.bilibili.com/672328094"
                  onChange={(e) => onChange(node.id, { biliUid: e.target.value })}
                />
                <small className="dim">
                  {extractBiliUid(d.biliUid)
                    ? `已识别 UID：${extractBiliUid(d.biliUid)}`
                    : '从 space.bilibili.com/数字 里自动提取'}
                </small>
              </label>
              <label className="field">
                <span>Cookie（可选，遇风控时填）</span>
                <input
                  type="password"
                  value={d.biliCookie}
                  placeholder="SESSDATA=xxx; buvid3=xxx"
                  onChange={(e) => onChange(node.id, { biliCookie: e.target.value })}
                />
                <small className="dim">
                  只填 SESSDATA 往往不够，B站 还会看 buvid3 / _uuid —— 把浏览器里整条 Cookie 粘进来最省事
                </small>
              </label>
            </>
          ) : (
            <label className="field">
              <span>RSS 订阅源地址</span>
              <input
                value={d.feedUrl}
                placeholder="https://rsshub.app/bilibili/user/video/672328094"
                onChange={(e) => onChange(node.id, { feedUrl: e.target.value })}
              />
            </label>
          )}
        </>
      )}

      {/* ---------- 公众号 ---------- */}
      {d.source === 'wechat' && (
        <label className="field">
          <span>订阅源地址（RSS / Atom）</span>
          <input
            value={d.feedUrl}
            placeholder="https://wechat2rss.bestblogs.dev/feed/xxxx.xml"
            onChange={(e) => onChange(node.id, { feedUrl: e.target.value })}
          />
          <small className="dim">
            公众号<strong>没有官方开放接口</strong>，需要用第三方桥接生成订阅地址：
            wechat2rss、RSSHub、Feeddd 等。免费源常有调用次数限制，失效时换一个即可。
          </small>
        </label>
      )}

      {/* ---------- 共用 ---------- */}
      <label className="field">
        <span>自定义 User-Agent（可选）</span>
        <input
          value={d.userAgent}
          placeholder="留空用内置浏览器 UA"
          onChange={(e) => onChange(node.id, { userAgent: e.target.value })}
        />
      </label>

      <label className="field">
        <span>超时秒数</span>
        <input
          type="number" min={1} max={120}
          value={d.timeoutSec}
          onChange={(e) => onChange(node.id, {
            timeoutSec: Math.max(1, Math.min(120, Number(e.target.value) || 15)),
          })}
        />
      </label>

      <label className="field">
        <span>输出格式</span>
        <select
          value={d.outputFormat}
          onChange={(e) => onChange(node.id, { outputFormat: e.target.value })}
        >
          <option value="bool">bool（只输出 true / false）</option>
          <option value="detail">detail（附带标题与链接）</option>
        </select>
        <small className="dim">
          接条件节点用 bool，这样 <code>{'equals true'}</code> 才生效
        </small>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={d.firstRunAsUpdate}
          onChange={(e) => onChange(node.id, { firstRunAsUpdate: e.target.checked })}
        />
        <span>首次检查也算更新</span>
      </label>
      <small className="dim">默认关闭：刚配好就触发一次下游通常是误报</small>

      {/* ---------- 基线 ---------- */}
      <div className="upd-baseline">
        <div>
          基线：{d.lastSeenId ? <code>{d.lastSeenId}</code> : <span className="dim">未记录</span>}
        </div>
        {d.lastSeenTitle && <div className="dim">最新：{d.lastSeenTitle}</div>}
        <button className="mini" onClick={resetBaseline} disabled={!d.lastSeenId}>
          重置基线（下次运行重新记录）
        </button>
      </div>

      {/* ---------- 试跑 ---------- */}
      <button className="p-btn" onClick={runTest} disabled={test.phase === 'running'}>
        {test.phase === 'running' ? '检查中…' : '测试连接'}
      </button>
      <small className="dim">只抓取并判定，不会更新基线</small>

      {test.phase !== 'idle' && test.phase !== 'running' && (
        <pre className={`upd-test ${test.phase === 'ok' ? (test.updated ? 'yes' : 'no') : 'err'}`}>
          {test.text}
        </pre>
      )}

      <div className="tip">
        <strong>怎么用</strong>
        <div style={{ marginTop: 6 }}>
          输出 <code>true</code> / <code>false</code>，后面接一个条件节点即可分流：
          <br />
          条件节点来源选本节点，判定「等于 <code>true</code>」。
        </div>
        <div style={{ marginTop: 6 }}>
          下游任务节点还能用 <code>{'{{' + node.id + '.title}}'}</code> 拿到新条目标题，
          <code>{'{{' + node.id + '.url}}'}</code> 拿到链接。
        </div>
      </div>
    </aside>
  );
}
