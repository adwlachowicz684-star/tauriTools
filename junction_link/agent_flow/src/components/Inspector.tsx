import {
  CLI_META, TRIGGER_META, DEFAULT_BRANCH, OP_META, DEFAULT_TRIGGER_CONFIG,
  makeRule, makeParallelRule,
  isCondition, isTrigger, isParallel,
  type CliKind, type ConditionOp, type ConditionNodeData,
  type TriggerKind, type TriggerConfig, type TriggerNodeData,
  type ParallelMode, type ParallelNodeData, type TaskNodeData,
} from '../types';
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

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <div className="field">
        <span>判定规则（从上到下，命中第一条即走该分支）</span>
        {rules.length === 0 && <div className="dim">还没有规则，点下面按钮添加</div>}

        {rules.map((r, i) => {
          const needsValue = OP_META[r.op]?.needsValue ?? true;
          return (
            <div key={r.id} className="rule-card">
              <div className="rule-row">
                <span className="rule-idx">{i + 1}</span>
                <input
                  className="rule-label"
                  value={r.label}
                  placeholder="分支名"
                  onChange={(e) => updateRule(r.id, { label: e.target.value })}
                />
                <button className="mini" onClick={() => moveRule(i, -1)} disabled={i === 0}>↑</button>
                <button className="mini" onClick={() => moveRule(i, 1)} disabled={i === rules.length - 1}>↓</button>
                <button className="mini danger" onClick={() => removeRule(r.id)}>删</button>
              </div>

              <div className="rule-row">
                <select value={r.op} onChange={(e) => updateRule(r.id, { op: e.target.value as ConditionOp })}>
                  {OPS.map((op) => <option key={op} value={op}>{OP_META[op].label}</option>)}
                </select>
                {needsValue && (
                  <input
                    className="rule-value"
                    value={r.value}
                    placeholder="比较值"
                    onChange={(e) => updateRule(r.id, { value: e.target.value })}
                  />
                )}
              </div>

              <div className="rule-row">
                <small className="dim">判定来源</small>
                <select value={r.source} onChange={(e) => updateRule(r.id, { source: e.target.value })}>
                  <option value="">全部上游输出（拼接）</option>
                  <option value="input">全局输入 {'{{input}}'}</option>
                  {upstream.map((u) => <option key={u} value={u}>节点 {u} 的输出</option>)}
                </select>
              </div>
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

      <div className="field">
        <span>判定结果</span>
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

  return (
    <aside className="inspector">
      <label className="field">
        <span>节点名称</span>
        <input value={d.label} onChange={(e) => onChange(node.id, { label: e.target.value })} />
      </label>

      <label className="field">
        <span>触发方式</span>
        <select
          value={d.trigger}
          onChange={(e) => onChange(node.id, {
            trigger: e.target.value as TriggerKind,
            config: { ...DEFAULT_TRIGGER_CONFIG },
          })}
        >
          {(Object.keys(TRIGGER_META) as TriggerKind[]).map((k) => (
            <option key={k} value={k}>{TRIGGER_META[k].label}</option>
          ))}
        </select>
        <small className="dim">{TRIGGER_META[d.trigger]?.hint}</small>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={d.enabled !== false}
          onChange={(e) => onChange(node.id, { enabled: e.target.checked })}
        />
        <span>启用这个触发器</span>
      </label>

      {d.trigger === 'interval' && (
        <label className="field">
          <span>间隔秒数（最小 10，避免把 CLI 打爆）</span>
          <input
            type="number" min={10}
            value={d.config.intervalSec}
            onChange={(e) => patchConfig({ intervalSec: Math.max(10, Number(e.target.value) || 10) })}
          />
        </label>
      )}

      {d.trigger === 'cron' && (
        <label className="field">
          <span>cron 表达式（分 时 日 月 周）</span>
          <input
            value={d.config.cronExpr}
            placeholder="0 9 * * 1-5"
            onChange={(e) => patchConfig({ cronExpr: e.target.value })}
          />
        </label>
      )}

      {d.trigger === 'watch' && (
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

      {d.trigger === 'webhook' && (
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
