import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GithubUpdateNodeData, GithubPushNodeData } from '../types';

/**
 * GitHub 节点卡片。
 *
 * 拉取与推送共用一套样式，靠 kind 区分：两者展示的信息几乎一样
 * （owner/repo/branch + 结果），分开写会有一大半重复。
 */

const STRATEGY_LABEL: Record<string, string> = {
  api: 'API',
  atom: '订阅源',
  cli: 'git',
};

function orderLabel(order: string[] | undefined, fallback: string[]): string {
  const list = order && order.length ? order : fallback || [];
  if (list.length === 0) return '—';
  return list.map((s) => STRATEGY_LABEL[s] || s).join(' → ');
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'success' ? 'ok' : status === 'failed' ? 'bad' : status === 'running' ? 'run' : '';
  return <span className={`dot ${cls}`} />;
}

export function GithubUpdateNode({ data, selected }: NodeProps) {
  const d = data as unknown as GithubUpdateNodeData;
  const target = d.owner && d.repo ? `${d.owner}/${d.repo}` : '（未配置仓库）';
  return (
    <div className={`node-card kind-github ${selected ? 'is-selected' : ''} status-${d.status}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <span className="node-kind">GitHub</span>
        <StatusDot status={d.status} />
      </div>
      <div className="node-title">{d.label || 'GitHub 更新'}</div>
      <div className="node-sub">{target}</div>
      <div className="node-meta">
        <span>{d.branch ? `分支 ${d.branch}` : '默认分支'}</span>
        <span title="依次尝试，前一个失败自动换下一个">
          {orderLabel(d.order, ['api', 'atom', 'cli'])}
        </span>
      </div>
      {d.lastSha ? (
        <div className="node-out">
          {d.lastBranch ? `${d.lastBranch} @ ` : ''}
          {d.lastSha.slice(0, 7)}
          {d.lastVia ? ` · ${d.lastVia}` : ''}
        </div>
      ) : null}
      {d.error ? <div className="node-err">{d.error}</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function GithubPushNode({ data, selected }: NodeProps) {
  const d = data as unknown as GithubPushNodeData;
  const target = d.owner && d.repo ? `${d.owner}/${d.repo}` : '（未配置仓库）';
  const fileCount = (d.filesText || '')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x !== '').length;
  return (
    <div className={`node-card kind-github ${selected ? 'is-selected' : ''} status-${d.status}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <span className="node-kind">GitHub</span>
        <StatusDot status={d.status} />
      </div>
      <div className="node-title">{d.label || 'GitHub 推送'}</div>
      <div className="node-sub">{target}</div>
      <div className="node-meta">
        <span>{d.branch || 'main'}</span>
        <span>{fileCount} 个文件</span>
        <span title="依次尝试，前一个失败自动换下一个">
          {orderLabel(d.order, ['api', 'cli'])}
        </span>
      </div>
      {d.lastCommit ? (
        <div className="node-out">
          {d.lastCommit.slice(0, 7)}
          {d.lastVia ? ` · ${d.lastVia}` : ''}
        </div>
      ) : null}
      {d.error ? <div className="node-err">{d.error}</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
