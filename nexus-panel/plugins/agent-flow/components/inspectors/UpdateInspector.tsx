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
import { SECRET_POLICY_META, DEFAULT_TRIGGER_CONFIG, type SecretPolicy } from '../../types';
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

type Props = {
  node: FlowNode;
  edges: FlowEdge[];
  onChange: (id: string, patch: Record<string, unknown>) => void;
};

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'ok'; text: string; updated: boolean }
  | { phase: 'err'; text: string };

export function UpdateInspector({ node, onChange }: {
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

/* ------------------------------------------------------------------ */
/* GitHub 节点                                                         */
/* ------------------------------------------------------------------ */

const GH_STRATEGY_META: Record<GithubStrategy, { label: string; hint: string }> = {
  api: { label: 'GitHub API', hint: '要令牌；公开库可不填。信息最全' },
  atom: { label: '订阅源', hint: '免令牌，但只能读公开库' },
  cli: { label: '本地 git', hint: '走机器上的 git，免令牌；推送时需要本地仓库' },
};

/**
 * 凭据选择区。
 *
 * 只列出**满足本节点权限要求**的凭据 —— 推送节点不会让你选一把只有读权限的令牌，
 * 从源头避免"选完才在运行时撞 403"。
 */
