import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
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

      <div className="p-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        junction / 符号链接不会跟随，避免循环与重复内容；源与备份目录互相嵌套时会自动跳过该源。
      </div>

      <div className="p-row" style={{ marginTop: 14 }}>
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
      onSaved({ editToolPath: exe });
      onLog(`已设置编辑器：${exe}`);
      onClose();
    } catch (e) {
      onLog(`设置失败：${errText(e)}`, true);
    }
  };

  return (
    <Modal title="选择编辑器（打开 .md 用）" onClose={onClose} width={560}>
      <div className="p-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="p-muted" style={{ fontSize: 11.5 }}>
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

      <div className="fpx-field" style={{ marginTop: 12 }}>
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

      <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
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

  const send = async () => {
    if (!target) { onLog('请先选中一个项目或项目组', true); return; }
    setSending(true);
    setTip('');
    try {
      const r = await api.chainSendAction(actionId, kind, target, override || null, chosen);
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

  return (
    <Modal
      title="发送到 AI 客户端"
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="p-btn" onClick={onClose}>关闭</button>
          <button className="p-btn primary" disabled={sending || !current} onClick={send}>
            {sending ? '发送中…' : `发送「${current?.name ?? ''}」`}
          </button>
        </>
      }
    >
      <div className="p-mono p-muted" style={{ marginBottom: 10, wordBreak: 'break-all' }}>
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
        <div className="p-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
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

      <div className="p-muted" style={{ fontSize: 11.5 }}>
        opencode / Cursor 支持深链接自动预填；VSCode 走命令行；
        Trae 等无外部预填路径的客户端会复制指令并唤起窗口，需手工粘贴。
        各动作的模板可在「设置 → 连锁动作」里改。
      </div>

      {tip && <div className="fpx-result">{tip}</div>}
    </Modal>
  );
}

/* ---------------------------- MCP / 监听 ---------------------------- */

export function ServiceDialog({
  api, config, onClose, onLog, onSaved, onWatchToggled,
}: {
  api: Api;
  config: FpxConfig;
  onClose: () => void;
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
    api.mcpStatus().then((s) => setMcpOn(s.running)).catch(() => {});
  }, [api]);

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

  const toggleWatch = async () => {
    try {
      if (watchOn) {
        await api.watchStop();
        setWatchOn(false);
        onWatchToggled(false);
        onSaved({ watchEnabled: false, watchIntervalSecs: interval });
        onLog('已停止监听');
      } else {
        const ok = await api.watchStart(Math.max(5, interval));
        setWatchOn(ok);
        onWatchToggled(ok);
        onSaved({ watchEnabled: true, watchIntervalSecs: interval });
        onLog(`已开始监听受保护目录（每 ${Math.max(5, interval)} 秒检查一次）`);
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
    <Modal title="服务：MCP / 监听 / 截图" onClose={onClose} width={560}>
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
        <div className="p-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
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
        <div className="p-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          轮询检查 ACL 保护目录的条目数与修改时间，被外部改动时在下方日志告警。
        </div>
      </div>

      <div className="fpx-field">
        <label>截图</label>
        <button className="p-btn" onClick={shot}>截取屏幕到数据目录 shots/</button>
        <div className="p-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          Windows 走 GDI 直出 BMP；macOS 用 screencapture，Linux 需 ImageMagick / gnome-screenshot / grim。
        </div>
      </div>

      <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="p-btn" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}
