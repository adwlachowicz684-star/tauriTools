import type { NodeProps } from '@xyflow/react';
import {
  UPDATE_SOURCE_META, targetsOf, type UpdateNodeData, type UpdateTarget,
} from '../types';
import type { BiliFlowNode, WechatFlowNode, UpdateFlowNode } from '../flowTypes';
import { NodeShell } from './NodeShell';

/** 这一张卡盯的是谁：不同种类看不同的字段 */
function targetOf(t: UpdateTarget): string {
  if (t.kind === 'bilibili') {
    if ((t.biliMode ?? 'rss') === 'rss') return t.feedUrl || '（未填订阅源）';
    return t.biliUid ? `UID ${t.biliUid}` : '（未填 UID）';
  }
  if (t.kind === 'github') {
    const o = (t.owner ?? '').trim();
    const r = (t.repo ?? '').trim();
    return o || r ? `${o}/${r}` : '（未填仓库）';
  }
  return t.feedUrl || '（未填订阅源）';
}

/** 把长 URL 压成好看的短形式 */
function shortUrl(u: string): string {
  if (!u) return '';
  const s = u.replace(/^https?:\/\//i, '');
  return s.length > 30 ? `${s.slice(0, 29)}…` : s;
}

export default function UpdateNode({
  id, data, selected,
}: NodeProps<BiliFlowNode | WechatFlowNode | UpdateFlowNode>) {
  const d: UpdateNodeData = data;
  const list = targetsOf(d);

  return (
    <NodeShell
      id={id}
      // 本组件服务 bili / wechat / update 三种类型，圆点色按第一个目标取
      type="update"
      typeColor={UPDATE_SOURCE_META[list[0]?.kind ?? 'bilibili'].color}
      data={d}
      selected={selected}
      className="update"
      footExtra={
        <span className="node-line--foot">
          更新检测 · {list.length} 个目标
        </span>
      }
      tag={
        <>
          <span className="upd-icon">🔍</span>
          输出 true / false
        </>
      }
    >
      {/*
       * 每个监听目标一张卡。
       *
       * 以前一个节点就是一个源，三张卡的信息挤在一段纯文本里 ——
       * "哪个源有更新"只能靠读句子，而状态（有/无更新）只有一份，
       * 后跑的那个会把先跑的覆盖掉。
       */}
      <div className="upd-cards">
        {list.map((t) => {
          const meta = UPDATE_SOURCE_META[t.kind];
          const off = t.enabled === false;
          const verdict = t.lastUpdated === null || t.lastUpdated === undefined
            ? null
            : t.lastUpdated
              ? { text: '有更新', cls: 'yes' }
              : { text: '无更新', cls: 'no' };
          return (
            <div className={`trig-card upd-card${off ? ' is-off' : ''}`} key={t.id}>
              <div className="upd-card-head">
                <span className="upd-icon">{meta.icon}</span>
                <span className="upd-card-name">{(t.name ?? '').trim() || meta.label}</span>
                {verdict && <span className={`upd-verdict ${verdict.cls}`}>{verdict.text}</span>}
                {off && <span className="upd-verdict off">停用</span>}
              </div>

              <div className="upd-summary">
                <code title={targetOf(t)}>{shortUrl(targetOf(t))}</code>
              </div>

              {t.error ? (
                <div className="upd-err" title={t.error}>✗ {t.error}</div>
              ) : t.lastSeenTitle ? (
                <div className="upd-latest" title={t.lastSeenTitle}>最新：{t.lastSeenTitle}</div>
              ) : null}

              {t.lastCheckedAt ? (
                <div className="upd-time">
                  {new Date(t.lastCheckedAt).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </NodeShell>
  );
}
