import { useRef, useState } from 'react';
import {
  CLI_META, TRIGGER_META, DEFAULT_BRANCH, OP_META,
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
  type TriggerKind, type TriggerConfig, type TriggerNodeData, type TriggerEntry,
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
import { DEFAULT_TRIGGER_CONFIG } from '../../types';
import {
  triggerEntriesOf, addTriggerEntry, removeTriggerEntry,
  patchTriggerEntry, patchEntryConfig, mergeConfig, makeEntryId, entryEnabled,
} from '../../engine/triggerEntries';
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

export function TriggerInspector({ node, onChange, webhookTokens }: {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
  /** 后端为未填 Token 的 webhook 自动生成的校验 Token。
      从主 Inspector 透传 —— 此前 Props 里声明了却没往下传，
      函数内直接引用会编译不过。 */
  webhookTokens?: Record<string, string>;
}) {
  const d = node.data as TriggerNodeData;
  const patchConfig = (patch: Partial<TriggerConfig>) =>
    onChange(node.id, { config: { ...d.config, ...patch } });

  /*
   * 触发**条件卡片**。
   *
   * 以前是一组勾选框：选了哪几种方式，下面才显示哪些字段。
   * 于是所有方式共用同一份 config —— 改「周期」的秒数会顺带改到
   * 别的触发方式也在读的字段，而且看不出"这个节点到底配了几个条件"。
   *
   * 现在每种方式是一张卡，各带自己的 config，可单独停用 / 删除。
   */
  const entries = triggerEntriesOf(d as unknown as Record<string, unknown>);
  const writeEntries = (next: TriggerEntry[]) => {
    // 一并清掉老字段，避免它与 entries 打架（两处都有的话不知道该听谁的）
    onChange(node.id, { entries: next, triggers: undefined, trigger: undefined });
  };
  const patchEntry = (id: string, patch: Partial<TriggerConfig>) =>
    writeEntries(patchEntryConfig(entries, id, patch));
  const seqRef = useRef(0);
  const addEntry = (k: TriggerKind) => {
    seqRef.current += 1;
    writeEntries(addTriggerEntry(entries, k, makeEntryId(seqRef.current)));
  };

  return (
    <aside className="inspector">
      {/*
       * 名称已上移到通用基础信息区（inspectors/NodeBasics），
       * 连同「存为自定义」一起。以前每个面板各写一份 ——
       * 改文案或改存储方式要同步五处，而漏一处不会报错。
       */}

      <div className="field">
        <span className="field-label-row">
          触发条件
          <span className="trig-add">
            {(Object.keys(TRIGGER_META) as TriggerKind[]).map((k) => (
              <button
                key={k}
                type="button"
                className="side-head-btn"
                title={`添加「${TRIGGER_META[k].label}」条件`}
                onClick={() => addEntry(k)}
              >
                ＋{TRIGGER_META[k].label}
              </button>
            ))}
          </span>
        </span>
        {entries.length === 0 ? (
          <div className="trig-empty">
            还没有触发条件 —— 上面点一个添加。一个条件都不会触发时，这个节点不会跑。
          </div>
        ) : (
          <div className="trig-cards">
            {entries.map((e) => (
              <TriggerCard
                key={e.id}
                node={node}
                entry={e}
                base={d.config}
                webhookTokens={webhookTokens}
                onPatch={(patch) => patchEntry(e.id, patch)}
                onToggle={(on) => writeEntries(patchTriggerEntry(entries, e.id, { enabled: on }))}
                onRemove={() => writeEntries(removeTriggerEntry(entries, e.id))}
              />
            ))}
          </div>
        )}
        <small className="dim">
          {entries.length > 1 ? '每张卡独立配置，任一条件满足即触发' : ''}
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

/** 家目录。浏览器里拿不到真实路径，退回空串让探测自然失败并报出来 */
function homeDir(): string {
  const h = (globalThis as { __NEXUS_HOME__?: string }).__NEXUS_HOME__;
  if (typeof h === 'string' && h) return h;
  // Tauri 里通常由 Rust 提供；这里拿不到就退回常见约定，探测会自己验证真假
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.HOME
    ?? (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.USERPROFILE
    ?? '';
}

function platformOf(): 'win' | 'mac' | 'linux' {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/windows/i.test(ua)) return 'win';
  if (/macintosh|mac os x/i.test(ua)) return 'mac';
  return 'linux';
}

/**
 * 「对话触发」的配置 + 探测。
 *
 * 探测是必需的：各家 CLI 把对话放在不同目录、格式还不统一，
 * Trae IDE 更是存在 SQLite 里（新版还加密）。与其让用户照着文档猜路径，
 * 不如扫一遍本机，把"找到没 / 能不能读"如实报出来 ——
 * 尤其是"目录存在但读不了"这种最容易白忙一场的情况。
 */

/**
 * 「对话触发」的配置 + 探测。
 *
 * 探测是必需的：各家 CLI 把对话放在不同目录、格式还不统一，
 * Trae IDE 更是存在 SQLite 里（新版还加密）。与其让用户照着文档猜路径，
 * 不如扫一遍本机，把"找到没 / 能不能读"如实报出来 ——
 * 尤其是"目录存在但读不了"这种最容易白忙一场的情况。
 */
/**
 * 一张触发条件卡。
 *
 * ================= 为什么是卡片 ====================
 *
 * 以前所有触发方式共用节点上同一份 `config`，
 * 界面则是一组勾选框 + "选中才显示"的字段堆。
 *
 * 于是：改「周期」的秒数会顺带改到别的触发方式也在读的字段，
 * 而且看不出这个节点到底配了几个条件 —— 它们没有各自的边界。
 *
 * 现在每张卡自带 config（只写自己关心的字段），
 * 缺的字段由节点默认 config 兜底（mergeConfig）。
 */
export function TriggerCard({ entry, base, node, webhookTokens, onPatch, onToggle, onRemove }: {
  entry: TriggerEntry;
  /** 节点级默认配置：卡片没覆盖的字段用它的 */
  base: TriggerConfig | undefined;
  node: FlowNode;
  webhookTokens?: Record<string, string>;
  onPatch: (patch: Partial<TriggerConfig>) => void;
  onToggle: (on: boolean) => void;
  onRemove: () => void;
}) {
  const meta = TRIGGER_META[entry.kind];
  const cfg = mergeConfig(base, entry.config);
  const on = entryEnabled(entry);
  /* 卡片自己的 config 就是这里的全部 —— 读 d.config 会读到节点默认值，
     表现为"我在卡里改了却没变" */
  const d = { config: cfg } as TriggerNodeData;

  return (
    <div className={'trig-card' + (on ? '' : ' is-off')}>
      <div className="trig-card-head">
        <span className="trig-card-icon">{meta?.icon ?? '⚡'}</span>
        <span className="trig-card-name">{meta?.label ?? entry.kind}</span>
        <span className="task-grow" />
        <button
          type="button"
          className={'side-head-btn' + (on ? ' is-on' : '')}
          onClick={() => onToggle(!on)}
          title={on ? '停用这个条件（其它条件不受影响）' : '启用这个条件'}
        >
          {on ? '已启用' : '已停用'}
        </button>
        <button
          type="button"
          className="side-head-btn"
          onClick={onRemove}
          title="删除这个触发条件"
        >
          删除
        </button>
      </div>

      {entry.kind === 'interval' ? (
        <label className="field">
          <span>间隔秒数（最小 10，避免把 CLI 打爆）</span>
          <input
            type="number" min={10}
            value={cfg.intervalSec}
            onChange={(e) => onPatch({ intervalSec: Math.max(10, Number(e.target.value) || 10) })}
          />
        </label>
      ) : null}

      {entry.kind === 'cron' ? (
        <label className="field">
          <span>cron 表达式（分 时 日 月 周）</span>
          <input
            value={cfg.cronExpr}
            placeholder="0 9 * * 1-5"
            onChange={(e) => onPatch({ cronExpr: e.target.value })}
          />
        </label>
      ) : null}

      {entry.kind === 'watch' ? (
        <>
          <label className="field">
            <span>监听目录</span>
            <input
              value={cfg.watchDir}
              placeholder="/path/to/dir"
              onChange={(e) => onPatch({ watchDir: e.target.value })}
            />
          </label>
          <label className="field">
            <span>只关心这些后缀（逗号分隔，留空=全部）</span>
            <input
              value={(cfg.watchExts ?? []).join(',')}
              placeholder="py,js,ts"
              onChange={(e) => onPatch({
                watchExts: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
              })}
            />
          </label>
          <label className="field">
            <span>防抖毫秒</span>
            <input
              type="number" min={0}
              value={cfg.debounceMs}
              onChange={(e) => onPatch({ debounceMs: Number(e.target.value) || 0 })}
            />
          </label>
        </>
      ) : null}

      {entry.kind === 'webhook' ? (
        <>
          <div className="field row2">
            <label className="field">
              <span>端口</span>
              <input
                type="number"
                value={cfg.port}
                onChange={(e) => onPatch({ port: Number(e.target.value) || 8787 })}
              />
            </label>
            <label className="field">
              <span>路径</span>
              <input
                value={cfg.path}
                onChange={(e) => onPatch({ path: e.target.value || '/' })}
              />
            </label>
          </div>
          <div className="url-box">
            <code>{`http://127.0.0.1:${cfg.port}${cfg.path}`}</code>
          </div>
          <label className="field">
            <span>校验 Token（留空=不校验身份，但调用仍需带下方请求头）</span>
            <input value={cfg.token} onChange={(e) => onPatch({ token: e.target.value })} />
          </label>
          {!cfg.token && webhookTokens?.[node.id] ? (
            <div className="tip">
              未填 Token，后端已自动生成：<code>{webhookTokens[node.id]}</code>
              <br />
              调用时带上请求头 <code>X-Token</code> 或 <code>Authorization: Bearer …</code>。
              留空不等于「不校验」——否则本机任何程序（不只网页）都能触发这条工作流。
            </div>
          ) : null}
          {!cfg.token && !webhookTokens?.[node.id] ? (
            <div className="tip">
              未配 Token 时，调用需带请求头 <code>X-Nexus-Webhook: 1</code>。
              这不是身份校验，而是挡住浏览器里的恶意网页静默触发本端口。
            </div>
          ) : null}
        </>
      ) : null}

      {entry.kind === 'chat' ? (
        <ChatConfig node={node} d={d} patchConfig={onPatch} />
      ) : null}

      {entry.kind === 'manual' ? (
        <div className="cond-hint">点「运行」时立即执行一次。</div>
      ) : null}
    </div>
  );
}

export function ChatConfig({ d, patchConfig }: {
  node: FlowNode;
  d: TriggerNodeData;
  patchConfig: (patch: Partial<TriggerConfig>) => void;
}) {
  const [probing, setProbing] = useState(false);
  const [probeErr, setProbeErr] = useState('');
  const [results, setProbes] = useState<ProbeResult[]>([]);
  const kwCount = parseKeywords(d.config.chatKeywords).length;

  const runProbe = async () => {
    setProbing(true);
    setProbeErr('');
    const out: ProbeResult[] = [];
    const home = homeDir();
    const exts = d.config.chatExts.length > 0 ? d.config.chatExts : ['jsonl'];

    for (const { kind, root } of candidateRoots(home, platformOf())) {
      let exists = false;
      let files: string[] = [];
      try {
        const r = await fileOp({ op: 'list', path: root, recursive: true, exts } as FsArgs);
        exists = true;
        files = r.text.split('\n').map((x) => x.trim()).filter(Boolean);
      } catch {
        exists = false;   // 列目录失败就当不存在，探测不该因为报错中断
      }

      // 抽样：只试最近的一个文件，够判断"能不能解析"了
      let parsed = 0;
      let sample = '';
      if (files.length > 0) {
        sample = files[files.length - 1];
        const content = await tailFile(sample);
        if (content !== null) parsed = parseMessages(content, sample).length;
      }
      const verdict = concludeProbe(kind, exists, files.length, parsed);
      out.push({
        kind, root, exists, files: files.length, parsed, sample,
        usable: verdict.usable, note: verdict.note,
      });
    }

    setProbes(out);
    setProbing(false);

    // 没填目录时，自动用第一个可用的 —— 省一次手抄路径
    const first = out.find((r) => r.usable);
    if (first && !d.config.chatDir.trim()) {
      // 监听目录填"会话文件所在的父目录"：同项目的多个会话都能覆盖
      const parent = first.sample.replace(/[\\/][^\\/]+$/, '');
      patchConfig({ chatDir: parent || first.root });
    }
  };

  return (
    <>
      <div className="field">
        <div className="chat-probe-head">
          <small className="dim">对话来源探测</small>
          <button className="mini" onClick={() => void runProbe()} disabled={probing}>
            {probing ? '扫描中…' : '扫描本机'}
          </button>
        </div>
        <small className="dim">
          各家 CLI 存放位置不同，先扫一遍看清哪些能读 —— 免得配了个读不动的目录白忙一场。
        </small>
        {probeErr ? <div className="chat-probe-err">⚠ {probeErr}</div> : null}
      </div>

      {results.length > 0 ? (
        <div className="chat-probe-list">
          {results.filter((r) => r.exists || r.usable).map((r) => (
            <div key={`${r.kind}:${r.root}`} className={`chat-probe-row ${r.usable ? 'ok' : 'no'}`}>
              <div className="chat-probe-top">
                <span className="chat-probe-name">{CONV_SOURCE_META[r.kind].label}</span>
                <span className="chat-probe-tag">{r.usable ? '可用' : '不可用'}</span>
                {r.usable && r.root ? (
                  <button
                    className="mini"
                    onClick={() => patchConfig({ chatDir: r.root })}
                    title={r.root}
                  >
                    用这个
                  </button>
                ) : null}
              </div>
              <div className="chat-probe-note">{r.note}</div>
              <div className="chat-probe-path">{r.root}</div>
            </div>
          ))}
        </div>
      ) : null}

      <label className="field">
        <span>监听目录</span>
        <input
          value={d.config.chatDir}
          placeholder="/home/你/.codebuddy/projects"
          onChange={(e) => patchConfig({ chatDir: e.target.value })}
        />
      </label>

      <label className="field">
        <span>关键词（一行一个，# 开头为注释）</span>
        <textarea
          rows={4}
          value={d.config.chatKeywords}
          placeholder={'报错\n测试失败\n# 这行是注释'}
          onChange={(e) => patchConfig({ chatKeywords: e.target.value })}
        />
        <div className="cond-hint">
          {kwCount === 0 ? '还没填关键词 —— 这个触发器不会触发' : `已配 ${kwCount} 个关键词，大小写不敏感`}
        </div>
      </label>

      <div className="field row2">
        <label className="field">
          <span>匹配范围</span>
          <select
            value={d.config.chatScope}
            onChange={(e) => patchConfig({ chatScope: e.target.value as 'user' | 'both' })}
          >
            <option value="both">用户 + AI</option>
            <option value="user">只算用户说的</option>
          </select>
        </label>
        <label className="field">
          <span>轮询秒数</span>
          <input
            type="number" min={2}
            value={d.config.chatPollSec}
            onChange={(e) => patchConfig({ chatPollSec: Math.max(2, Number(e.target.value) || 3) })}
          />
        </label>
      </div>

      <label className="field">
        <span>命中内容模板（注入 <code>{'{{input}}'}</code>）</span>
        <textarea
          rows={3}
          value={d.config.chatTemplate}
          placeholder={DEFAULT_TRIGGER_CONFIG.chatTemplate}
          onChange={(e) => patchConfig({ chatTemplate: e.target.value })}
        />
        <div className="cond-hint">
          占位符：<code>{'{{keyword}}'}</code> <code>{'{{role}}'}</code>{' '}
          <code>{'{{text}}'}</code> <code>{'{{excerpt}}'}</code>{' '}
          <code>{'{{file}}'}</code> <code>{'{{time}}'}</code>
        </div>
      </label>

      <div className="tip">
        只读本机对话文件、不外发。首次扫描到的历史消息只作基线，不会触发流程 ——
        只有启动之后新出现的才会。
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

const MODE_LABEL: Record<ParallelMode, string> = {
  fixed: '固定并发数',
  byRule: '按条件决定',
  all: '不限制',
};
