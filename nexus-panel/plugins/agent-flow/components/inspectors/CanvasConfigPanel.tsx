import { useState } from 'react';
import type { CanvasConfig, McpServer } from '../../engine/canvasConfig';
import { validateCanvasConfig } from '../../engine/canvasConfig';
import { mcpChoiceRequired } from '../../engine/canvasConfig';
import {
  type CanvasParam, paramRefsOfNodes, diffParamIssue, ensureParams, isValidParamName,
} from '../../engine/canvasParams';
import { EXPORT_FORMATS } from '../../engine/scriptExport';

/**
 * 画布设置 —— MCP 服务、全局环境变量、导出脚本。
 *
 * 这些都是**画布级**的：属于这张画布，不属于某个节点。
 * 选中节点时面板显示节点的参数，不选中时显示这里。
 */

type Props = {
  config: CanvasConfig;
  onChange: (next: CanvasConfig) => void;
  /**
   * 当前画布的节点 —— 用来扫出"引用了哪些参数、哪些还没定义"。
   *
   * 不给的话面板就只是个普通的参数表，
   * 而缺失检测才是这个功能真正省事的地方：
   * 模块拖进来后一眼看到还缺哪几个。
   */
  nodes?: unknown[];
  /** 模块引用到的参数名（模块本身不在 nodes 里，要单独给） */
  moduleParamRefs?: string[];
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
};

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
  nodes, moduleParamRefs,
}: Props) {
  const [openMcp, setOpenMcp] = useState(true);
  const [openEnv, setOpenEnv] = useState(false);
  const [openExport, setOpenExport] = useState(false);

  const servers = config.mcpServers ?? [];
  const issues = validateCanvasConfig(config);
  const mustPick = mcpChoiceRequired(servers);

  const params: CanvasParam[] = config.params ?? [];
  const setParams = (next: CanvasParam[]) => onChange({ ...config, params: next });

  /*
   * 引用了哪些参数 —— 画布上的节点 + 模块声明的。
   *
   * 模块单独算：模块内部节点不在画布 nodes 里（只有展开时才在），
   * 所以拖一个模块进来，画布侧扫不到它引用的参数 ——
   * 而那恰恰是最该提醒的场景。
   */
  const used = [
    ...new Set([...paramRefsOfNodes(nodes ?? []), ...(moduleParamRefs ?? [])]),
  ];
  const { missing } = diffParamIssue(params, used);
  const badNames = params
    .map((p) => p.name)
    .filter((n) => n.trim() && !isValidParamName(n));

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
              配在这里的服务，画布上的节点都能用。
            </p>

            {servers.length === 0 && (
              <p className="cfg-empty">还没配服务 —— 节点会走它自己的通道（比如 HTTP 请求节点直接发请求）。</p>
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

            {servers.map((s) => (
              <div className="cfg-card" key={s.id}>
                <div className="cfg-row">
                  <input
                    type="text"
                    placeholder="服务名（节点按名字引用）"
                    value={s.name ?? ''}
                    onChange={(ev) => patchServer(s.id, { name: ev.target.value })}
                  />
                  <button
                    type="button"
                    className="cfg-del"
                    title="删除"
                    onClick={() => {
                      onChange({ ...config, mcpServers: servers.filter((x) => x.id !== s.id) });
                      note(`已删除服务「${s.name || '未命名'}」`);
                    }}
                  >
                    ×
                  </button>
                </div>
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
              </div>
            ))}

            <button
              type="button"
              className="cfg-add"
              onClick={() => onChange({ ...config, mcpServers: [...servers, newServer()] })}
            >
              ＋ 加一个服务
            </button>
          </div>
        )}
      </div>

      {/* ---------- 画布参数 ---------- */}
      <div className="cfg-sec">
        <button type="button" className="cfg-title" onClick={() => setOpenEnv(!openEnv)}>
          <span>{openEnv ? '▾' : '▸'}</span>
          画布参数
          <em>{params.length} 个{missing.length ? ` · 缺 ${missing.length}` : ''}</em>
        </button>

        {openEnv && (
          <div className="cfg-body">
            <p className="cfg-hint">
              节点里用 <code>{'{{params.名字}}'}</code> 引用。名字可以用中文 ——
              <code>{'{{params.输出目录}}'}</code> 比拼音清楚。
            </p>
            <p className="cfg-hint">
              模块跨画布复用就靠它：同一句 <code>{'{{params.输出目录}}'}</code>，
              每张画布各填各的值，模块本身不用改。
            </p>

            {/*
              缺失清单 —— 这个功能最省事的一块。

              模块拖进一张新画布，它要的参数这张画布还没定义。
              不列出来的话，用户看到的是"跑出来的路径不对"
              而不是"这个参数没填"—— 排查方向完全不同。
            */}
            {missing.length ? (
              <div className="cfg-warn">
                <div>这些参数被引用了，但这张画布还没定义：</div>
                <div className="cfg-miss-list">
                  {missing.map((n) => <code key={n}>{n}</code>)}
                </div>
                <button
                  type="button"
                  className="cfg-add"
                  onClick={() => setParams(ensureParams(params, missing))}
                >
                  一键补齐（{missing.length} 个）
                </button>
              </div>
            ) : null}

            {params.map((p, i) => (
              <div className="cfg-row" key={`${p.name}#${i}`}>
                <input
                  type="text"
                  className="cfg-k"
                  value={p.name}
                  placeholder="参数名"
                  onChange={(ev) => {
                    const next = [...params];
                    next[i] = { ...p, name: ev.target.value };
                    setParams(next);
                  }}
                />
                <input
                  type="text"
                  className="cfg-mono"
                  value={p.value}
                  placeholder="值"
                  onChange={(ev) => {
                    const next = [...params];
                    next[i] = { ...p, value: ev.target.value };
                    setParams(next);
                  }}
                />
                <input
                  type="text"
                  className="cfg-note"
                  value={p.note ?? ''}
                  placeholder="说明（可选）"
                  title="写给复用的人看：这个参数该填什么"
                  onChange={(ev) => {
                    const next = [...params];
                    next[i] = { ...p, note: ev.target.value };
                    setParams(next);
                  }}
                />
                <button
                  type="button"
                  className="cfg-del"
                  title="删除"
                  onClick={() => setParams(params.filter((_, k) => k !== i))}
                >
                  ×
                </button>
              </div>
            ))}

            {/*
              名字不合法要当场说 ——
              模板里 {{params.a.b}} 这种写法解析不出来，
              而不提示的话用户只会看到"没生效"。
            */}
            {badNames.length ? (
              <p className="cfg-warn">
                这些名字用不了：{badNames.join('、')}
                （只能用中文/字母/数字/下划线，且不能以数字开头）
              </p>
            ) : null}

            <button
              type="button"
              className="cfg-add"
              onClick={() => setParams([...params, { name: '', value: '', note: '' }])}
            >
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
