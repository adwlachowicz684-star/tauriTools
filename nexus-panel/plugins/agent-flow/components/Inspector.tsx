import {
  CLI_META, TRIGGER_META, DEFAULT_BRANCH, OP_META, DEFAULT_TRIGGER_CONFIG,
  makeRule, makeParallelRule,
  isCondition, isTrigger, isParallel, isLoop, isFs,
  LOOP_MODE_META, FS_OP_META, MAX_LOOP_ITERATIONS,
  type CliKind, type ConditionOp, type ConditionNodeData,
  type TriggerKind, type TriggerConfig, type TriggerNodeData,
  type ParallelMode, type ParallelNodeData, type TaskNodeData,
  type LoopMode, type LoopNodeData, type LoopOnError,
  type FsOp, type FsNodeData,
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

  /* ---------- 循环节点 ---------- */
  if (isLoop(node.data)) {
    return <LoopInspector node={node} edges={edges} onChange={onChange} />;
  }

  /* ---------- 文件操作节点 ---------- */
  if (isFs(node.data)) {
    return <FsInspector node={node} edges={edges} onChange={onChange} />;
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
              <option value="input">全局输入 {{'{{input}}'}}</option>
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
