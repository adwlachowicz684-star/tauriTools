import { useState } from 'react';
import type { FlowNode } from '../../flowTypes';
import type { UpdateNodeData } from '../../types';
import { fetchText } from '../../lib/tauri';
import {
  parseFeed, parseBiliApi, detectUpdate, sortByNewest, extractBiliUid, biliApiUrl, BILI_REFERER,
} from '../../engine/updates';

/**
 * 更新检测节点的「测试」与「重置基线」。
 *
 * 从原面板里抽出来是因为它要自己持有 useState —— 而字段描述层是纯数据，
 * 装不下 hook。节点定义用 panelFooter 把它挂在字段清单之后。
 *
 * 测试**不推进基线**：如果点了测试就把基线改了，用户再正式运行
 * 就永远看不到"有更新"了。
 */
export function UpdateTestPanel({ node, onChange }: {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
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
