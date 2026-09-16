import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GithubUpdateNodeData, GithubPushNodeData } from '../types';
import { NodeCardChips } from './NodeCardChips';

/**
 * GitHub 节点卡片。
 *
 * 拉取与推送共用一套样式，靠 kind 区分：两者展示的信息几乎一样
 * （owner/repo/branch + 结果），分开写会有一大半重复。
 *
 * 这里刻意**不套 NodeShell**：本卡片的视觉自成一体 ——
 * 标题在 kind 行的下面（不在同一行）、状态用独立圆点而非文字徽章、
 * 也没有 node-foot。硬套外壳会把这些既有的专门设计压平。
 * 外壳抽的是"多数卡片的共性"，少数自成体系的保留原样更好。
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

/** 两个节点卡片的公共骨架，差异只在标题缺省值与 meta 那几项 */
function GithubCard({
  d, fallbackLabel, meta, out,
}: {
  d: GithubUpdateNodeData | GithubPushNodeData;
  fallbackLabel: string;
  meta: React.ReactNode;
  out: React.ReactNode;
}) {
  const target = d.owner && d.repo ? `${d.owner}/${d.repo}` : '（未配置仓库）';
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <span className="node-kind">GitHub</span>
        <StatusDot status={d.status} />
      </div>
      <div className="node-title">{d.label || fallbackLabel}</div>
      <div className="node-sub">{target}</div>
      {/* 套用的参数卡片，像卡扣一样嵌在节点上 */}
      <NodeCardChips data={d} groups={[{ group: 'github-repo', fallback: '地址' }]} />
      <div className="node-meta">{meta}</div>
      {out}
      {d.error ? <div className="node-err">{d.error}</div> : null}
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export function GithubUpdateNode({ data, selected }: NodeProps) {
  const d = data as unknown as GithubUpdateNodeData;
  return (
    <div className={`node-card kind-github ${selected ? 'is-selected' : ''} status-${d.status}`}>
      <GithubCard
        d={d}
        fallbackLabel="GitHub 更新"
        meta={
          <>
            <span>{d.branch ? `分支 ${d.branch}` : '默认分支'}</span>
            <span title="依次尝试，前一个失败自动换下一个">
              {orderLabel(d.order, ['api', 'atom', 'cli'])}
            </span>
          </>
        }
        out={
          d.lastSha ? (
            <div className="node-out">
              {d.lastBranch ? `${d.lastBranch} @ ` : ''}
              {d.lastSha.slice(0, 7)}
              {d.lastVia ? ` · ${d.lastVia}` : ''}
            </div>
          ) : null
        }
      />
    </div>
  );
}

export function GithubPushNode({ data, selected }: NodeProps) {
  const d = data as unknown as GithubPushNodeData;
  const fileCount = (d.filesText || '')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x !== '').length;
  return (
    <div className={`node-card kind-github ${selected ? 'is-selected' : ''} status-${d.status}`}>
      <GithubCard
        d={d}
        fallbackLabel="GitHub 推送"
        meta={
          <>
            <span>{d.branch || 'main'}</span>
            <span>{fileCount} 个文件</span>
            <span title="依次尝试，前一个失败自动换下一个">
              {orderLabel(d.order, ['api', 'cli'])}
            </span>
          </>
        }
        out={
          d.lastCommit ? (
            <div className="node-out">
              {d.lastCommit.slice(0, 7)}
              {d.lastVia ? ` · ${d.lastVia}` : ''}
            </div>
          ) : null
        }
      />
    </div>
  );
}
