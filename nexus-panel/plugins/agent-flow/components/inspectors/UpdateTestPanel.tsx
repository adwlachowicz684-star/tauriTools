import { useState } from 'react';
import type { FlowNode } from '../../flowTypes';
import { UPDATE_SOURCE_META, type UpdateNodeData } from '../../types';
import { fetchText } from '../../lib/tauri';
import { probeFeedTarget, BILI_REFERER } from '../../engine/updates';
import type { UpdateTarget } from '../../types';
import type { TestState } from './shared';

/**
 * 更新检测节点的「测试」与「重置基线」。
 *
 * 从原面板里抽出来是因为它要自己持有 useState —— 而字段描述层是纯数据，
 * 装不下 hook。节点定义用 panelFooter 把它挂在字段清单之后。
 *
 * 测试**不推进基线**：如果点了测试就把基线改了，用户再正式运行
 * 就永远看不到"有更新"了。
 */
/*
 * onChange 统一为单参数（只收 patch）——
 * 与 FileParamsPanel / LlmConfigPanel / OrderPicker 一致。
 * 详见 tests/customRenderSignature.test.ts 里关于"双参数被静默丢弃"的说明：
 * 签名不一致会让调用方每次都要现想"这个组件接几个参数"，
 * 想错就是"点了没反应"。node 仍要传，是因为这里要读它的 data 与 id。
 */
export function UpdateTestPanel({ node, onChange }: {
  node: FlowNode;
  onChange: (patch: Record<string, unknown>) => void;
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
  /**
   * 试跑一次，但不推进基线。
   *
   * 「测试」就该是只读的 —— 如果它把基线改了，
   * 用户点一下再正式运行，就永远看不到"有更新"了。
   *
   * 抓取与判定走 probeFeedTarget（engine/updates.ts），
   * 与正式运行同一份代码 —— 各写一份会漂成
   * "试跑说有更新，正式跑却没更新"，两边都不报错。
   */
  const runTest = async () => {
    setTest({ phase: 'running' });
    try {
      const headers: Record<string, string> = {};
      if (d.userAgent) headers['User-Agent'] = d.userAgent;
      if (d.source === 'bilibili' && d.biliCookie) {
        headers.Cookie = d.biliCookie;
        headers.Referer = BILI_REFERER;
      }

      const t = {
        id: '', kind: d.source, enabled: true,
        biliMode: d.biliMode, biliUid: d.biliUid, biliCookie: d.biliCookie,
        feedUrl: d.feedUrl, lastSeenId: d.lastSeenId,
      } as UpdateTarget;

      const r = await probeFeedTarget(t, { headers, timeoutSec: d.timeoutSec, firstRunAsUpdate: d.firstRunAsUpdate }, {
        get: async (u, o) => {
          const res = await fetchText(u, o);
          if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}`);
          return res.text ?? '';
        },
      });

      const line = [
        `结果：${r.updated ? '有更新' : '无更新'}`,
        r.latest ? `最新：${r.latest.title}` : '',
        r.latest?.url ? r.latest.url : '',
        `说明：${r.reason}`,
      ].filter(Boolean).join('\n');
      setTest({ phase: 'ok', text: line, updated: r.updated });
    } catch (err) {
      setTest({ phase: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const resetBaseline = () => {
    onChange({ lastSeenId: '', lastSeenTitle: '', lastUpdated: null, lastCheckedAt: null });
    setTest({ phase: 'idle' });
  };


  return (
    <>
      <div className="field">
        <span>试跑一次</span>
        <button className="p-btn" onClick={runTest} disabled={test.phase === 'running'}>
          {test.phase === 'running' ? '请求中…' : '测试'}
        </button>
        {test.phase === 'ok' ? (
          <pre className={'out' + (test.updated ? ' ok' : '')}>{test.text}</pre>
        ) : null}
        {test.phase === 'err' ? <pre className="out err">{test.text}</pre> : null}
        <small className="dim">只读取最新一条，不改变基线</small>
      </div>
      <button className="p-btn" onClick={resetBaseline}>重置基线</button>
    </>
  );
}
