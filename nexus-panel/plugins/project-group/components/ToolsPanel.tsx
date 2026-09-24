import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import { needConfirm, setSkipConfirm } from '../utils/confirmOnce';
import { ChainConfirmDialog } from './ChainConfirmDialog';
import type {
  BackupResult, CardKind, ChainAction, ChainClient, CaptureResult, EditorCandidate, FpxConfig,
} from '../types';
import { DirDialog } from './DirDialog';
import { Modal } from './ui';

/* ---------------------------- 备份 ---------------------------- */

export function BackupDialog({
  api, config, onClose, onLog, onSaved,
}: {
  api: Api;
  config: FpxConfig;
  onClose: () => void;
  onLog: (m: string, isError?: boolean) => void;
  onSaved: (patch: Partial<FpxConfig>) => void;
}) {
  const [dir, setDir] = useState(config.backupDir ?? '');
  // 项目 / 项目组专属目录；留空则回退到上面的统一根目录
  const [projectDir, setProjectDir] = useState(config.backupProjectDir ?? '');
  const [groupDir, setGroupDir] = useState(config.backupGroupDir ?? '');
  const [appendOnly, setAppendOnly] = useState(config.backupAppendOnly);
  const [busy, setBusy] = useState<CardKind | null>(null);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [picker, setPicker] = useState<'root' | 'project' | 'group' | null>(null);

  const run = async (kind: CardKind) => {
    setBusy(kind);
    setResult(null);
    try {
      const r = await api.backup(kind, dir.trim() || null, appendOnly);
      setResult(r);
      onLog(`备份${kind === 'group' ? '项目组' : '项目'}完成：${r.sources} 个源，新增 ${r.newFiles}、更新 ${r.updatedFiles}`);
      for (const e of r.errors.slice(0, 5)) onLog(e, true);
      onSaved({
        backupDir: dir.trim() || null,
        backupProjectDir: projectDir.trim() || null,
        backupGroupDir: groupDir.trim() || null,
        backupAppendOnly: appendOnly,
      });
    } catch (e) {
      onLog(`备份失败：${errText(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  const dirRow = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    which: 'root' | 'project' | 'group',
    hint: string,
  ) => (
    <div className="fpx-field">
      <label>{label}</label>
      <div className="p-row">
        <input className="p-input" value={value} placeholder={hint}
          onChange={(e) => onChange(e.target.value)} />
        <button className="p-btn" onClick={() => setPicker(which)}>浏览…</button>
        {which !== 'root' && (
          <button className="p-btn" title="清空，回退到统一根目录"
            onClick={() => onChange('')}>清空</button>
        )}
      </div>
    </div>
  );

  return (
    <Modal title="一键备份" onClose={onClose} width={600}>
      {dirRow('备份根目录（留空 = 数据目录下 backup/）', dir, setDir, 'root', '留空使用默认位置')}
      {dirRow('项目备份目录（可选，优先于根目录）', projectDir, setProjectDir, 'project', '留空则放在根目录下')}
      {dirRow('项目组备份目录（可选，优先于根目录）', groupDir, setGroupDir, 'group', '留空则放在根目录下')}

      <label className="fpx-checkline">
        <input type="checkbox" checked={appendOnly}
          onChange={(e) => setAppendOnly(e.target.checked)} />
        <span>只新增 / 更新（取消勾选 = 镜像同步，会删除备份中多余的文件）</span>
      </label>

      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-3, 6px)' }}>
        junction / 符号链接不会跟随，避免循环与重复内容；源与备份目录互相嵌套时会自动跳过该源。
      </div>

      <div className="p-row" style={{ marginTop: 'var(--sp-7, 14px)' }}>
        <button className="p-btn primary" disabled={busy !== null} onClick={() => run('project')}>
          {busy === 'project' ? '备份中…' : '备份全部项目'}
        </button>
        <button className="p-btn primary" disabled={busy !== null} onClick={() => run('group')}>
          {busy === 'group' ? '备份中…' : '备份全部项目组'}
        </button>
      </div>

      {result && (
        <div className="fpx-result">
          <div>目标：{result.target}</div>
          <div>
            源 {result.sources} 个：新增 {result.newFiles}、更新 {result.updatedFiles}、
            删除 {result.deletedFiles}、跳过链接 {result.skippedLinks}、
            缺失源 {result.missingSources}
          </div>
          {result.errors.length > 0 && (
            <details>
              <summary className="p-muted">异常 {result.errors.length} 条</summary>
              <ul className="fpx-errlist">
                {result.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {picker && (
        <DirDialog
          api={api}
          title={picker === 'root' ? '选择备份根目录'
            : picker === 'project' ? '选择项目备份目录' : '选择项目组备份目录'}
          onClose={() => setPicker(null)}
          onPick={(p) => {
            if (picker === 'root') setDir(p);
            else if (picker === 'project') setProjectDir(p);
            else setGroupDir(p);
            setPicker(null);
          }}
        />
      )}
    </Modal>
  );
}

/* ---------------------------- 编辑器选择 ---------------------------- */

export function EditorDialog({
  api, config, onClose, onLog, onSaved,
}: {
  api: Api;
  config: FpxConfig;
  onClose: () => void;
  onLog: (m: string, isError?: boolean) => void;
  onSaved: (patch: Partial<FpxConfig>) => void;
}) {
  const [list, setList] = useState<EditorCandidate[]>([]);
  const [loading, setLoading] = useState(true);

  // 首次打开走缓存（有缓存则秒开）；点「重新搜索」才真扫
  const load = (refresh: boolean) => {
    setLoading(true);
    api.listEditors(refresh)
      .then(setList)
      .catch((e) => onLog(`枚举编辑器失败：${errText(e)}`, true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [api]);

  const pick = async (exe: string) => {
    try {
      await api.setEditor(exe);
      /*
       * 空串 = 跟随系统，后端会存成 None。
       * 这里也要传 null 而不是 ''：本地草稿若是空串，
       * 界面上"跟随系统"那项的 active 判定（!config.editToolPath）
       * 就会判成"没跟随系统"，显示与配置不一致。
       */
      onSaved({ editToolPath: exe || null });
      onLog(exe ? `已设置编辑器：${exe}` : '已改为跟随系统（系统默认程序打开 .md）');
      onClose();
    } catch (e) {
      onLog(`设置失败：${errText(e)}`, true);
    }
  };

  return (
    <Modal title="选择编辑器（打开 .md 用）" onClose={onClose} width={560}>
      <div className="p-row" style={{ justifyContent: 'space-between', marginBottom: 'var(--sp-4, 8px)' }}>
        <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
          {loading ? '正在枚举…' : `共 ${list.length} 个候选`}
        </span>
        <button className="p-btn mini" disabled={loading} onClick={() => load(true)}>
          {loading ? '搜索中…' : '重新搜索'}
        </button>
      </div>
      {loading && <div className="p-muted">正在枚举…</div>}
      {!loading && list.length === 0 && (
        <div className="p-muted">没找到候选编辑器，可在下方手工指定程序路径。</div>
      )}

      <div className="fpx-editorlist">
        {/*
         * #86 「跟随系统」：不选任何编辑器，交给系统默认程序。
         *
         * 后端早已支持（edit_tool_path 为空时 open_default），
         * 缺的只是这个**入口** —— 没有它，用户一旦选过编辑器就退不回去
         * （唯一的办法是手工清空配置），等于这个能力等于不存在。
         *
         * 它必须是**可点的一项**而不是一个"清空"按钮：
         * 用户要在候选列表里看到"当前生效的是跟随系统"，
         * 否则不知道自己现在处于哪种状态。
         */}
        <button
          className={`fpx-editoritem${!config.editToolPath ? ' active' : ''}`}
          onClick={() => pick('')}
          title="不指定编辑器，用系统默认程序打开 .md"
        >
          <span className="fpx-editorname">跟随系统</span>
          <span className="fpx-editorexe p-mono">系统默认程序</span>
        </button>
        {list.map((c) => (
          <button
            key={c.exe}
            className={`fpx-editoritem${config.editToolPath === c.exe ? ' active' : ''}`}
            onClick={() => pick(c.exe)}
            title={c.exe}
          >
            <span className="fpx-editorname">{c.name}</span>
            <span className="fpx-editorexe p-mono">{c.exe}</span>
          </button>
        ))}
      </div>

      <div className="fpx-field" style={{ marginTop: 'var(--sp-6, 12px)' }}>
        <label>手工指定</label>
        <div className="p-row">
          <input className="p-input" defaultValue={config.editToolPath ?? ''}
            placeholder="程序完整路径"
            onKeyDown={(e) => { if (e.key === 'Enter') pick(e.currentTarget.value.trim()); }} />
          <button
            className="p-btn"
            onClick={(e) => {
              const input = e.currentTarget.parentElement?.querySelector('input');
              const v = (input?.value ?? '').trim();
              if (v) pick(v);
            }}
          >
            使用
          </button>
        </div>
      </div>

      <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-6, 12px)' }}>
        <button className="p-btn" onClick={() => pick('')}>恢复系统默认</button>
        <button className="p-btn" onClick={onClose}>关闭</button>
      </div>

    </Modal>
  );
}

/* ---------------------------- Agent 连锁 ---------------------------- */

export function ChainDialog({
  api, config, target, kind, onClose, onLog, onSaved,
}: {
  api: Api;
  config: FpxConfig;
  target: string;
  /** 对象类型：决定用动作的项目侧还是项目组侧模板 */
  kind: CardKind;
  onClose: () => void;
  onLog: (m: string, isError?: boolean) => void;
  onSaved: (patch: Partial<FpxConfig>) => void;
}) {
  const [clients, setClients] = useState<ChainClient[]>([]);
  const [actions, setActions] = useState<ChainAction[]>([]);
  const [actionId, setActionId] = useState('chain');
  // 客户端留空 = 跟随全局默认；这里仅作"本次覆盖"
  const [client, setClient] = useState('');
  // 指令区初始为空表示"用动作自带模板"；一旦编辑就是本次临时覆盖，不落盘
  const [override, setOverride] = useState('');
  const [sending, setSending] = useState(false);
  const [tip, setTip] = useState('');
  /** 发送前确认（#43）：null = 不弹；否则是要确认的指令全文 */
  const [confirm, setConfirm] = useState<{ text: string; skip: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api.chainClients().then(setClients).catch((e) => onLog(errText(e), true));
    api.chainActions()
      .then((list) => {
        setActions(list);
        if (list.length > 0) setActionId(list[0].id);
      })
      .catch((e) => onLog(errText(e), true));
  }, [api, onLog]);

  const current = actions.find((a) => a.id === actionId) ?? null;
  // 本次实际使用的客户端：手动选择优先，其次动作专属，最后全局默认
  const chosen = client || current?.client || config.chainClient || 'opencode';

  /** 真正发出去。confirmText 非空 = 用户在确认框里编辑后的最终文本 */
  const doSend = async (finalText: string) => {
    setSending(true);
    setTip('');
    try {
      const r = await api.chainSendAction(actionId, kind, target, finalText || null, chosen);
      setTip(r.message);
      onLog(r.message, !r.ok);
      // 本次用的客户端写回全局默认，下次开就是它（与旧行为一致）
      if (client) onSaved({ chainClient: client });
    } catch (e) {
      onLog(`发送失败：${errText(e)}`, true);
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (!target) { onLog('请先选中一个项目或项目组', true); return; }
    /* 已经勾了"本次不再提示"就直接发。
       注意：勾选项在确认框里，这里读的是**上一次**的选择 —— 首次必然要确认一次，
       这正是它的语义（看过一次才谈得上"不用再看了"）。 */
    if (!needConfirm()) { await doSend(override); return; }
    setConfirming(true);
    try {
      /* 预览走后端，与真正发送用同一套解析（resolve_prompt）：
         两边各写一套的话，"看到的"和"发出的"迟早会漂。 */
      const text = override.trim()
        || await api.chainPreview(actionId, kind, target);
      setConfirm({ text, skip: false });
    } catch (e) {
      // 预览失败不该拦住发送：退回原来的"直接发"，并把原因记进日志
      onLog(`指令预览失败，直接发送：${errText(e)}`, true);
      await doSend(override);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Modal
      title="发送到 AI 客户端"
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="p-btn" onClick={onClose}>关闭</button>
          <button className="p-btn primary" disabled={sending || confirming || !current} onClick={send}>
            {sending ? '发送中…' : confirming ? '准备中…' : `发送「${current?.name ?? ''}」`}
          </button>
        </>
      }
    >
      <div className="p-mono p-muted" style={{ marginBottom: 'var(--sp-5, 10px)', wordBreak: 'break-all' }}>
        对象：{target || '（未选中）'}
      </div>

      <div className="fpx-field">
        <label>动作</label>
        <div className="fpx-actionpick">
          {actions.map((a) => (
            <button
              key={a.id}
              className={`fpx-actionchip${a.id === actionId ? ' on' : ''}`}
              onClick={() => { setActionId(a.id); setOverride(''); setTip(''); }}
              title={a.builtin ? '内置动作' : '自定义动作'}
            >
              <span className="fpx-actionicon">{a.icon}</span>
              {a.name}
            </button>
          ))}
        </div>
      </div>

      <div className="fpx-field">
        <label>客户端</label>
        <select
          className="p-input"
          value={chosen}
          onChange={(e) => setClient(e.target.value)}
        >
          {clients.length === 0 && (
            <option value={client || 'opencode'}>
              {client || config.chainClient || 'opencode'}
            </option>
          )}
          {/* 当前值不在检测列表里时补一项，避免下拉显示为空 */}
          {chosen && !clients.some((c) => c.id === chosen) && (
            <option value={chosen}>{chosen}（已不再检测到）</option>
          )}
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.installed ? '' : '（未检测到）'}
            </option>
          ))}
        </select>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-2, 4px)' }}>
          {current?.client
            ? `该动作已固定使用「${current.client}」，此处可临时改用别的`
            : '此处选择的会写回全局默认客户端'}
        </div>
      </div>

      <div className="fpx-field">
        <label>
          指令（留空则用动作自带模板；{ '{path}' } / { '{name}' } 会替换）
        </label>
        <textarea
          className="p-input fpx-textarea"
          value={override}
          placeholder={override ? undefined : '（使用动作自带模板）'}
          onChange={(e) => setOverride(e.target.value)}
        />
      </div>

      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
        opencode / Cursor 支持深链接自动预填；VSCode 走命令行；
        Trae 等无外部预填路径的客户端会复制指令并唤起窗口，需手工粘贴。
        各动作的模板可在「设置 → 连锁动作」里改。
      </div>

      {tip && <div className="fpx-result">{tip}</div>}

      {/* 发送前确认（#43）：**显示并可编辑实际要发出的全文**。
          只显示模板原文（满屏 {项目名称}）等于没确认 —— 用户看到的是
          占位符，发出去的是替换后的真值，两者对不上就失去了确认的意义。

          这段上游误插进了 EditorDialog —— 那里的 current / clients /
          chosen / sending / doSend 全都未定义（clients 在整个文件里都不存在）。
          按它用到的变量移回真正所属的 ChainDialog。 */}
      {confirm && (
        <ChainConfirmDialog
          actionName={current?.name ?? ''}
          clientName={clients.find((c) => c.id === chosen)?.name ?? chosen}
          text={confirm.text}
          busy={sending}
          onCancel={() => setConfirm(null)}
          onConfirm={(finalText, skip) => {
            if (skip) setSkipConfirm(true);
            setConfirm(null);
            void doSend(finalText);
          }}
        />
      )}
    </Modal>
  );
}

/* ---------------------------- MCP / 监听 ---------------------------- */

/**
 * 服务面板主体（不带 Modal）：MCP server 启停、受保护目录监听、截图。
 *
 * 这三项都是"开关 / 动作"而非数据，操作即时生效，没有整体保存按钮。
 */
export function ServiceBody({
  api, config, onLog, onSaved, onWatchToggled,
}: {
  api: Api;
  config: FpxConfig;
  onLog: (m: string, isError?: boolean) => void;
  onSaved: (patch: Partial<FpxConfig>) => void;
  /** 通知外层开始/停止轮询拉取监听事件 */
  onWatchToggled: (on: boolean) => void;
}) {
  const [addr, setAddr] = useState('');
  const [mcpOn, setMcpOn] = useState(false);
  const [watchOn, setWatchOn] = useState(config.watchEnabled);
  const [interval, setInterval] = useState(config.watchIntervalSecs || 30);

  useEffect(() => {
    /*
     * 不能 `.catch(() => {})`：取不到状态时按钮停在「启动」，
     * 而 server 可能**正在跑** —— 用户点启动会撞上端口占用，
     * 报错还指不到"其实已经起来了"。说一句，让他先点停止。
     */
    api.mcpStatus()
      .then((s) => setMcpOn(s.running))
      .catch((e) => onLog(`读取 MCP 状态失败（按钮显示的可能不准）：${errText(e)}`, true));
  }, [api, onLog]);

  const toggleMcp = async () => {
    try {
      if (mcpOn) {
        await api.mcpStop();
        setMcpOn(false);
        setAddr('');
        onLog('MCP server 已停止');
      } else {
        const a = await api.mcpStart(0);
        setAddr(a);
        setMcpOn(true);
        onLog(`MCP server 已启动：${a}/mcp`);
      }
    } catch (e) {
      onLog(`MCP 操作失败：${errText(e)}`, true);
    }
  };

  /*
   * `watchStart` / `watchStop` 返回的是 **bool**（真的启/停成功了吗），
   * 不是抛异常。返回 false = 没成功，必须**当成失败处理**。
   *
   * 原来的写法把它当成功：照样 `onSaved({ watchEnabled: true })`
   * 并记一句「已开始监听受保护目录」。于是 ——
   *
   *   1. 配置被写成"启用监听"，但线程根本没起来；
   *   2. 下次进插件，`useState(config.watchEnabled)` 让按钮显示「停止监听」，
   *      而实际没在监听 —— **界面说在监听，其实没有**；
   *   3. 自动恢复那段又是同样的写法，再记一句"已恢复监听"。
   *
   * 后果是：受保护目录被外部改动时**完全没有告警**，而用户从头到尾
   * 看到的是"监听中"。这是"防写入"这条线上最难查的一种失效 ——
   * 没有任何报错，只是该响的警报永远不响。
   *
   * 失败时**不写 watchEnabled**：留着旧值，下次进来还会再试一次；
   * 写成 true 又起不来，等于把"恢复"这条路也堵死了。
   */
  const toggleWatch = async () => {
    try {
      if (watchOn) {
        const ok = await api.watchStop();
        setWatchOn(!ok);
        onWatchToggled(!ok);
        if (!ok) {
          onLog('停止监听失败：监听线程可能仍在运行，请重启插件', true);
          return;
        }
        onSaved({ watchEnabled: false, watchIntervalSecs: interval });
        onLog('已停止监听');
      } else {
        const secs = Math.max(5, interval);
        const ok = await api.watchStart(secs);
        setWatchOn(ok);
        onWatchToggled(ok);
        if (!ok) {
          onLog('开始监听失败：监听线程未能启动，配置未改动', true);
          return;
        }
        onSaved({ watchEnabled: true, watchIntervalSecs: secs });
        onLog(`已开始监听受保护目录（每 ${secs} 秒检查一次）`);
      }
    } catch (e) {
      onLog(`监听操作失败：${errText(e)}`, true);
    }
  };

  const shot = async () => {
    try {
      const r: CaptureResult = await api.captureScreen();
      onLog(`已截图：${r.path}${r.width ? `（${r.width}×${r.height}）` : ''}`);
    } catch (e) {
      onLog(`截图失败：${errText(e)}`, true);
    }
  };

  return (
    <>
      <div className="fpx-field">
        <label>MCP server</label>
        <div className="p-row">
          <button className={mcpOn ? 'p-btn danger' : 'p-btn primary'} onClick={toggleMcp}>
            {mcpOn ? '停止' : '启动'}
          </button>
          {mcpOn && addr && (
            <span className="p-mono">POST http://{addr}/mcp</span>
          )}
        </div>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-2, 4px)' }}>
          仅绑定 127.0.0.1。把上面的地址填进 AI 客户端的 MCP 配置即可调用本插件能力
          （列卡片、建链、扫内容、读文件、备份…）。
        </div>
      </div>

      <div className="fpx-field">
        <label>受保护目录监听</label>
        <div className="p-row">
          <button className={watchOn ? 'p-btn danger' : 'p-btn primary'} onClick={toggleWatch}>
            {watchOn ? '停止监听' : '开始监听'}
          </button>
          <input className="p-input fpx-hex" type="number" min={5} value={interval}
            onChange={(e) => setInterval(Number(e.target.value))} />
          <span className="p-muted">秒（最小 5）</span>
        </div>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-2, 4px)' }}>
          轮询检查 ACL 保护目录的条目数与修改时间，被外部改动时在下方日志告警。
        </div>
      </div>

      <div className="fpx-field">
        <label>截图</label>
        <button className="p-btn" onClick={shot}>截取屏幕到数据目录 shots/</button>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-2, 4px)' }}>
          Windows 走 GDI 直出 BMP；macOS 用 screencapture，Linux 需 ImageMagick / gnome-screenshot / grim。
        </div>
      </div>
    </>
  );
}
