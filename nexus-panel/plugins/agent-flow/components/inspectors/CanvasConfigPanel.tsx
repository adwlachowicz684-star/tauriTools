import { useState } from 'react';
import type { CanvasConfig, McpServer } from '../../engine/canvasConfig';
import {
  validateCanvasConfig, mcpChoiceRequired,
  mcpEntryDrifted, syncMcpFromLibrary, type McpLibraryEntry,
} from '../../engine/canvasConfig';
import { EXPORT_FORMATS } from '../../engine/scriptExport';
import {
  migrateEnvVars, newParamId, paramKeyOf, type CanvasParamType, type CanvasParam,
} from '../../engine/canvasParams';
import { CONST_TYPE_LABEL, normBoolText } from '../../types';

/**
 * 画布设置 —— MCP 服务、全局环境变量、导出脚本。
 *
 * 这些都是**画布级**的：属于这张画布，不属于某个节点。
 * 选中节点时面板显示节点的参数，不选中时显示这里。
 */

type Props = {
  config: CanvasConfig;
  onChange: (next: CanvasConfig) => void;
  /** 导出脚本；fmt 为空表示让用户选 */
  onExport: (fmt: string) => void;
  /** 给用户的即时反馈 */
  onNote?: (msg: string) => void;
  /* ---- 导出目录 ---- */
  /** 当前默认导出目录；空串表示没设 */
  exportDir: string;
  onChangeExportDir: (dir: string) => void;
  /** 弹目录选择器 */
  onBrowseExportDir: () => void;
  /** 能不能真正写文件（浏览器模式下为 false） */
  canExportToFile: boolean;
  /* ---- 外观 ---- */
  /**
   * 外观模式 —— **插件级偏好**，不是画布级配置。
   *
   * 它放在这里只是因为插件没有别的设置入口，
   * 面板上必须写明"不属于这张画布"，否则用户会以为换张画布就变了。
   */
  themeMode?: 'native' | 'follow';
  onThemeModeChange?: (mode: 'native' | 'follow') => void;
  /* ---- MCP ---- */
  /**
   * 连接管理器里的 MCP 服务库。
   *
   * 服务**怎么连**（命令 / 地址 / 环境变量）在那里配，一处改全图生效；
   * 画布这里只挑「这张画布用哪几个」。
   * 不传的话下拉框没东西可选 —— 那时必须给出去配的入口，见 onOpenMcpLibrary。
   */
  mcpLibrary?: McpLibraryEntry[];
  /** 打开连接管理器并停在「服务」页 */
  onOpenMcpLibrary?: () => void;
};

/** 参数卡的种类。与常量卡共用同一份名字表，不另写一份 */
const PARAM_KINDS: CanvasParamType[] = ['text', 'num', 'bool'];

function newServer(): McpServer {
  return {
    id: `mcp${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
    name: '',
    command: '',
    url: '',
    env: {},
    note: '',
  };
}

function CanvasConfigPanel({
  config, onChange, onExport, onNote,
  exportDir, onChangeExportDir, onBrowseExportDir, canExportToFile,
  themeMode, onThemeModeChange,
  mcpLibrary, onOpenMcpLibrary,
}: Props) {
  const lib = mcpLibrary ?? [];
  const [openMcp, setOpenMcp] = useState(true);
  const [openEnv, setOpenEnv] = useState(false);
  const [openExport, setOpenExport] = useState(false);
  const [openTheme, setOpenTheme] = useState(false);

  const servers = config.mcpServers ?? [];
  const issues = validateCanvasConfig(config);
  const mustPick = mcpChoiceRequired(servers);

  const commitServers = (next: McpServer[]) => onChange({ ...config, mcpServers: next });

  /*
   * 参数卡 —— 显示的是「params + 老 env.vars 合并」的结果。
   *
   * 只显示 params 的话，老存档里填在 env.vars 的变量会从界面上消失，
   * 而运行时（migrateEnvVars）照样读得到 ——
   * 于是"看不见却还在生效"，用户以为删掉了、值却还在替换。
   *
   * 任何编辑都写回 params（整份一起写）：env.vars 原样留着不动，
   * 它是老存档的残留，同名以 params 为准，不会被重复显示。
   */
  const envCards: CanvasParam[] = migrateEnvVars(config.params, config.env?.vars);
  const writeParams = (next: CanvasParam[]) => onChange({ ...config, params: next });

  const patchParam = (i: number, part: Partial<CanvasParam>) =>
    writeParams(envCards.map((t, j) => (j === i ? { ...t, ...part } : t)));

  const removeParamAt = (i: number) => {
    const gone = envCards[i];
    writeParams(envCards.filter((_, j) => j !== i));
    /*
     * 删掉的那张若只存在于老的 env.vars 里，光删 params 是删不掉的 ——
     * 下一轮合并又把它搬回来，表现为"删了又冒出来"。
     */
    const legacyId = String(gone?.id ?? '');
    if (legacyId.startsWith('env:') && config.env?.vars) {
      const vars = { ...(config.env?.vars ?? {}) };
      delete vars[String(gone?.name ?? '').trim()];
      onChange({ ...config, params: envCards.filter((_, j) => j !== i), env: { ...(config.env ?? { vars: {} }), vars } });
    }
  };

  const addParam = () => {
    let i = 1;
    while (envCards.some((p) => (p.name ?? '').trim() === `参数${i}`)) i += 1;
    writeParams([...envCards, { id: newParamId(), name: `参数${i}`, value: '', valueType: 'text', note: '' }]);
  };

  const patchServer = (id: string, patch: Partial<McpServer>) => {
    onChange({
      ...config,
      mcpServers: servers.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  };

  const note = (m: string) => { if (onNote) onNote(m); };

  return (
    <div className="canvas-config">
      <div className="cfg-head">
        <strong>画布设置</strong>
        <small>属于整张画布，不是某个节点</small>
      </div>

      {/* ---------- MCP ---------- */}
      <div className="cfg-sec">
        <button type="button" className="cfg-title" onClick={() => setOpenMcp(!openMcp)}>
          <span>{openMcp ? '▾' : '▸'}</span>
          MCP 服务
          <em>{servers.length} 个</em>
        </button>

        {openMcp && (
          <div className="cfg-body">
            <p className="cfg-hint">
              从连接管理器里挑 —— 服务怎么连（命令 / 地址）在那里配，改一处全图生效。
              这里只决定<strong>这张画布用哪几个</strong>。
            </p>

            {servers.length === 0 && (
              <p className="cfg-empty">还没挑服务 —— 节点会走它自己的通道（比如 HTTP 请求节点直接发请求）。</p>
            )}

            {/*
              只配一个时节点不用选、自动用它；配了多个就必须选。
              这条规则要让用户在**配第二个之前**就看到，
              否则会出现"昨天还能跑、今天加了第二个就全都报错要选"。
            */}
            {mustPick && (
              <p className="cfg-warn">
                配了 {servers.length} 个，用到 MCP 的节点必须指定哪一个。
              </p>
            )}

            {servers.map((s) => {
              /*
               * 选了连接之后，命令 / 地址不再在画布上手填 ——
               * 手填就是又存了一份，改连接管理器时这里不会跟着变，
               * 于是"连接管理器里是对的，这张画布跑的是旧地址"，且不报错。
               */
              const drifted = mcpEntryDrifted(s, lib);
              const gone = Boolean(s.credentialId) && !lib.some((x) => x.id === s.credentialId);
              return (
                <div className="cfg-card" key={s.id}>
                  <div className="cfg-row">
                    <select
                      className="cfg-pick"
                      value={s.credentialId ?? ''}
                      onChange={(ev) => {
                        const cid = ev.target.value;
                        /*
                         * 选「（这张画布自己配）」= 回到手填。
                         *
                         * 这个出口必须有：连接管理器里只有常用的那几个服务，
                         * 临时想试一个只在这张画布上用的地址，没这个口子就配不了。
                         */
                        if (!cid) {
                          patchServer(s.id, { credentialId: undefined });
                          return;
                        }
                        const merged = syncMcpFromLibrary({ ...s, credentialId: cid }, lib);
                        if (!merged) {
                          note('这条连接在连接管理器里已经不在了，去那边重新加一个');
                          return;
                        }
                        commitServers(servers.map((x) => (x.id === s.id ? merged : x)));
                        note(`已选用连接「${merged.name}」`);
                      }}
                    >
                      <option value="">（这张画布自己配）</option>
                      {lib
                        .filter((x) => !x.disabled)
                        .map((x) => (
                          <option key={x.id} value={x.id}>{x.name || '未命名'}</option>
                        ))}
                      {/* 已停用的那条仍要留在选项里 ——
                          否则打开面板时下拉框会跳到第一项，看着像被改掉了，
                          而画布上存的还是停用那条 */}
                      {lib
                        .filter((x) => x.disabled && x.id === s.credentialId)
                        .map((x) => (
                          <option key={x.id} value={x.id}>{x.name || '未命名'}（已停用）</option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="cfg-del"
                      title="从这张画布移除"
                      onClick={() => {
                        /*
                         * 只解除**这张画布**的选用，不删连接管理器里那条 ——
                         * 库是全局的，别的画布还在用。
                         */
                        onChange({ ...config, mcpServers: servers.filter((x) => x.id !== s.id) });
                        note(`已从这张画布移除「${s.name || '未命名'}」`);
                      }}
                    >
                      ×
                    </button>
                  </div>

                  {/*
                    分叉提示：连接管理器里改过了，画布这份还是旧的。
                    不提示的话这张画布会一直跑旧地址，且没有任何报错。
                  */}
                  {drifted ? (
                    <p className="cfg-warn">
                      连接管理器里这条已经改过了 ——
                      <button
                        type="button"
                        className="cfg-link"
                        onClick={() => {
                          const merged = syncMcpFromLibrary(s, lib);
                          if (!merged) { note('这条连接已经不在了'); return; }
                          commitServers(servers.map((x) => (x.id === s.id ? merged : x)));
                          note('已同步为连接管理器里的最新配置');
                        }}
                      >
                        同步过来
                      </button>
                    </p>
                  ) : null}

                  {gone ? (
                    <p className="cfg-warn">这条连接在连接管理器里已经删掉了，去那边重新挑一个。</p>
                  ) : null}

                  {/* 没选连接的（老存档 / 临时自配）才显示手填框 */}
                  {!s.credentialId ? (
                    <>
                      <input
                        type="text"
                        placeholder="服务名（节点按名字引用）"
                        value={s.name ?? ''}
                        onChange={(ev) => patchServer(s.id, { name: ev.target.value })}
                      />
                      <input
                        type="text"
                        className="cfg-mono"
                        placeholder="启动命令，如 npx -y @modelcontextprotocol/server-filesystem /tmp"
                        value={s.command ?? ''}
                        onChange={(ev) => patchServer(s.id, { command: ev.target.value })}
                      />
                      <input
                        type="text"
                        className="cfg-mono"
                        placeholder="或填 HTTP 地址（与命令二选一）"
                        value={s.url ?? ''}
                        onChange={(ev) => patchServer(s.id, { url: ev.target.value })}
                      />
                    </>
                  ) : (
                    <p className="cfg-hint cfg-mono">
                      {s.command ? s.command : (s.url || '（这条连接没填命令或地址）')}
                    </p>
                  )}
                </div>
              );
            })}

            <div className="cfg-row">
              <button
                type="button"
                className="cfg-add"
                onClick={() => onChange({ ...config, mcpServers: [...servers, newServer()] })}
              >
                ＋ 加一个服务
              </button>
              {/*
                去连接管理器加一条新的。
                这个按钮必须有：库里没有想要的服务时，
                用户在这里只能加一个空条目然后手填 —— 那又回到了各处各配一份。
              */}
              <button
                type="button"
                className="cfg-add cfg-add--ghost"
                onClick={() => onOpenMcpLibrary?.()}
              >
                去连接管理器添加
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ---------- 全局环境变量（参数卡） ---------- */}
      <div className="cfg-sec">
        <button type="button" className="cfg-title" onClick={() => setOpenEnv(!openEnv)}>
          <span>{openEnv ? '▾' : '▸'}</span>
          全局环境变量
          <em>{envCards.length} 个</em>
        </button>

        {openEnv && (
          <div className="cfg-body">
            <p className="cfg-hint">
              节点里用 <code>{'{{params.名字}}'}</code> 引用 —— 名字允许中文，
              <code>{'{{env.NAME}}'}</code> 是旧称，仍然认。
            </p>
            {/*
              密钥提示必须写在**填之前** ——
              环境变量是最顺手的填 token 的地方，而这里明文存 localStorage。
            */}
            <p className="cfg-warn">
              不要在这里直接填密钥。要用密钥就填连接管理器的引用，
              明文值会跟着画布存档一起落盘。
            </p>

            {envCards.length === 0 && (
              <p className="cfg-empty">
                还没有参数 —— 同一个模块拖到不同画布上，靠这里的名字各取各的值。
              </p>
            )}

            {envCards.map((t, i) => {
              const vt: CanvasParamType = t.valueType ?? 'text';
              return (
                <div className="trig-card upd-card" key={paramKeyOf(t, i)}>
                  <div className="upd-card-head">
                    <span className="upd-icon">🔧</span>
                    <input
                      className="p-input upd-name-input"
                      value={t.name ?? ''}
                      placeholder={`参数${i + 1}`}
                      title="卡名即 {{params.名字}} 里引用的名字"
                      onChange={(e) => patchParam(i, { name: e.target.value })}
                    />
                    <span className="task-grow" />
                    <button
                      type="button"
                      className="insp-size-btn"
                      title="删掉这一张（其余不受影响）"
                      onClick={() => removeParamAt(i)}
                    >
                      删除
                    </button>
                  </div>

                  <label className="p-row">
                    <span className="p-muted" style={{ width: 64, flex: 'none' }}>种类</span>
                    <select
                      className="p-input"
                      value={vt}
                      onChange={(e) => patchParam(i, { valueType: e.target.value as CanvasParamType })}
                    >
                      {PARAM_KINDS.map((k) => (
                        <option key={k} value={k}>{CONST_TYPE_LABEL[k]}</option>
                      ))}
                    </select>
                  </label>

                  {vt === 'bool' ? (
                    <label className="p-row">
                      <span className="p-muted" style={{ width: 64, flex: 'none' }}>值</span>
                      <select
                        className="p-input"
                        /* 与运行时取值共用同一份规范化 —— 各判一次的话，
                           这里选着「真」、模板里替换出来的却是别的字 */
                        value={normBoolText(t.value)}
                        onChange={(e) => patchParam(i, { value: e.target.value })}
                      >
                        <option value="true">真（true）</option>
                        <option value="false">假（false）</option>
                      </select>
                    </label>
                  ) : vt === 'num' ? (
                    <label className="p-row">
                      <span className="p-muted" style={{ width: 64, flex: 'none' }}>值</span>
                      <input
                        className="p-input"
                        value={t.value ?? ''}
                        placeholder="如 42"
                        onChange={(e) => patchParam(i, { value: e.target.value })}
                      />
                    </label>
                  ) : (
                    <label className="p-col">
                      <span className="p-muted">值</span>
                      <textarea
                        className="p-input"
                        rows={2}
                        value={t.value ?? ''}
                        placeholder="原样填进 {{params.名字}}"
                        onChange={(e) => patchParam(i, { value: e.target.value })}
                      />
                    </label>
                  )}

                  <label className="p-col">
                    <span className="p-muted">说明（可选）</span>
                    <input
                      className="p-input"
                      value={t.note ?? ''}
                      placeholder="这个参数是干什么的 —— 复用给别人时靠它知道该填什么"
                      onChange={(e) => patchParam(i, { note: e.target.value })}
                    />
                  </label>
                </div>
              );
            })}

            <button type="button" className="cfg-add" onClick={addParam}>
              ＋ 加一个参数
            </button>
          </div>
        )}
      </div>

      {/* ---------- 导出 ---------- */}
      <div className="cfg-sec">
        <button type="button" className="cfg-title" onClick={() => setOpenExport(!openExport)}>
          <span>{openExport ? '▾' : '▸'}</span>
          导出为脚本
        </button>

        {openExport && (
          <div className="cfg-body">
            <p className="cfg-hint">
              把整张画布生成一份文件。条件、循环、并发这些翻译不了的部分会
              在生成结果里明确标出，不会静默丢掉。
            </p>
            {/*
               默认导出目录。

               不放的话导出走浏览器下载，落到系统默认下载目录，
               **插件也不知道在哪**，用户找不到文件也不知道该去哪找。
             */}
            <div className="cfg-row">
              <label>默认导出目录</label>
              <div className="cfg-dir">
                <input
                  value={exportDir}
                  onChange={(e) => onChangeExportDir(e.target.value)}
                  placeholder="留空则每次导出时手选"
                />
                <button
                  type="button"
                  className="mini"
                  onClick={onBrowseExportDir}
                  disabled={!canExportToFile}
                  title={canExportToFile ? '浏览选择目录' : '浏览器模式不能写文件，只能下载'}
                >
                  浏览
                </button>
                {exportDir ? (
                  <button type="button" className="mini" onClick={() => onChangeExportDir('')}>
                    清除
                  </button>
                ) : null}
              </div>
              <p className="cfg-hint">
                {canExportToFile
                  ? (exportDir
                    ? '导出时直接写到这里，日志会显示完整路径。'
                    : '没设的话，每次导出会弹目录选择器让你选。')
                  : '当前是浏览器模式，写不了磁盘 —— 导出会走浏览器下载，文件名只有名字、路径不受控。'}
              </p>
            </div>

            {EXPORT_FORMATS.map((f) => (
              <button
                type="button"
                className="cfg-export"
                key={f.id}
                title={f.desc}
                onClick={() => onExport(f.id)}
              >
                {f.label}
                <small>.{f.ext} · {f.desc}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---------- 外观（插件级，不是画布级） ---------- */}
      {themeMode && onThemeModeChange ? (
      <div className="cfg-sec">
        <button type="button" className="cfg-title" onClick={() => setOpenTheme(!openTheme)}>
          <span>{openTheme ? '▾' : '▸'}</span>
          外观
          <em>{themeMode === 'follow' ? '跟随面板' : '原生'}</em>
        </button>

        {openTheme && (
          <div className="cfg-body">
            <p className="cfg-hint">
              这一项属于<strong>整个插件</strong>，换画布不会变。
            </p>
            <div className="cfg-row">
              <select
                value={themeMode}
                onChange={(ev) => onThemeModeChange(ev.target.value as 'native' | 'follow')}
              >
                <option value="follow">跟随面板主题</option>
                <option value="native">原生样式（固定深色）</option>
              </select>
            </div>
            {/*
              这两句是"这个功能是不是废了"的答案，必须写在当场。

              默认的「Agent Flow 深色」主题，其变量值与原生层**逐像素相同**
              —— 所以在没换过面板主题的情况下，两个选项看起来一模一样。
              这不是坏了，是默认值恰好对齐；换一套面板主题才会看出差别。
            */}
            <p className="cfg-hint">
              默认主题下两个选项观感相同 —— 它的配色与原生层是同一套值。
              换成别的面板主题（比如浅色）后，跟随才会跟着变。
            </p>
          </div>
        )}
      </div>
      ) : null}

      {issues.length > 0 && (
        <div className="cfg-issues">
          <strong>这份配置有问题：</strong>
          {issues.map((it, i) => (
            <div key={`${it.field}-${i}`}>· {it.field}：{it.message}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CanvasConfigPanel;
