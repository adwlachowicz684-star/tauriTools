import { useState } from 'react';
import { UPDATE_SOURCE_META, type UpdateNodeData, type UpdateTarget } from '../../types';
import { fetchText } from '../../lib/tauri';
import { probeFeedTarget, BILI_REFERER } from '../../engine/updates';
import type { TestState } from './shared';

/**
 * 一张监听目标卡上的「试跑」。
 *
 * ================= 为什么每张卡各有一个 =================
 *
 * 合并之后一个节点可以盯多个目标，"测试"如果只留一个节点级的，
 * 就分不清测的是哪一张 —— 而不同目标的配置各不相同
 * （B站 有 RSS / 接口两种模式，公众号与小红书只能填订阅源）。
 *
 * ================= 为什么不自己拼 URL =================
 *
 * 抓取与判定走 probeFeedTarget（engine/updates.ts），
 * 与正式运行**同一份代码**。各写一份会漂成
 * "试跑说有更新，正式跑却没更新"，而两边都不报错。
 *
 * ================= 为什么不覆盖 GitHub =================
 *
 * GitHub 目标走的是另一种通道（需要注入的拉取能力），
 * 试跑面板拿不到它。硬做一个"点下去其实没查"的按钮比不做更糟，
 * 所以那类卡由调用方显示说明，不给按钮。
 */
export function UpdateTargetTest({ target, d }: {
  target: UpdateTarget;
  d: UpdateNodeData;
}) {
  const [test, setTest] = useState<TestState>({ phase: 'idle' });

  /** 试跑不推进基线 —— 改了基线，正式运行就再也看不到"有更新"了 */
  const run = async () => {
    setTest({ phase: 'running' });
    try {
      const headers: Record<string, string> = {};
      if (d.userAgent) headers['User-Agent'] = d.userAgent;
      if (target.kind === 'bilibili' && target.biliCookie) {
        headers.Cookie = target.biliCookie;
        headers.Referer = BILI_REFERER;
      }

      const r = await probeFeedTarget(
        target,
        { headers, timeoutSec: d.timeoutSec ?? 15, firstRunAsUpdate: d.firstRunAsUpdate === true },
        {
          get: async (u, o) => {
            const res = await fetchText(u, o);
            if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}`);
            return res.text ?? '';
          },
        },
      );

      setTest({
        phase: 'ok',
        text: [
          `结果：${r.updated ? '有更新' : '无更新'}`,
          r.latest ? `最新：${r.latest.title}` : '',
          r.latest?.url ? r.latest.url : '',
          `说明：${r.reason}`,
        ].filter(Boolean).join('\n'),
        updated: r.updated,
      });
    } catch (err) {
      setTest({ phase: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="upd-test">
      <button
        type="button"
        className="insp-size-btn"
        title={`只读取 ${UPDATE_SOURCE_META[target.kind].label} 的最新一条，不改变基线`}
        onClick={run}
        disabled={test.phase === 'running'}
      >
        {test.phase === 'running' ? '请求中…' : '试跑'}
      </button>
      {test.phase === 'ok' ? (
        <pre className={'out' + (test.updated ? ' ok' : '')}>{test.text}</pre>
      ) : null}
      {test.phase === 'err' ? <pre className="out err">{test.text}</pre> : null}
    </div>
  );
}
