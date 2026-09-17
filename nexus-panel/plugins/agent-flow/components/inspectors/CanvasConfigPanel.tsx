import { useState } from 'react';
import type { CanvasConfig, McpServer } from '../../engine/canvasConfig';
import { validateCanvasConfig } from '../../engine/canvasConfig';
import { mcpChoiceRequired } from '../../engine/canvasConfig';
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
  /** 导出脚本；fmt 为空表示让用户选 */
  onExport: (fmt: string) => void;
  /** 给用户的即时反馈 */
  onNote?: (msg: string) => void;
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

export default function CanvasConfigPanel({
  config, onChange, onExport, onNote,
}: Props) {
  const [openMcp, setOpenMcp] = useState(true);
  const [openEnv, setOpenEnv] = useState(false);
  const [openExport, setOpenExport] = useState(false);

  const servers = config.mcpServers ?? [];
  const issues = validateCanvasConfig(config);
  const mustPick = mcpChoiceRequired(servers);

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

      {/* ---------- 环境变量 ---------- */}
      <div className="cfg-sec">
        <button type="button" className="cfg-title" onClick={() => setOpenEnv(!openEnv)}>
          <span>{openEnv ? '▾' : '▸'}</span>
          全局环境变量
          <em>{Object.keys(config.env?.vars ?? {}).length} 个</em>
        </button>

        {openEnv && (
          <div className="cfg-body">
            <p className="cfg-hint">
              节点里用 <code>{'{{env.NAME}}'}</code> 引用。
            </p>
            {/*
              密钥提示必须写在**填之前** ——
              环境变量是最顺手的填 token 的地方，而这里明文存 localStorage。
            */}
            <p className="cfg-warn">
              不要在这里直接填密钥。要用密钥就填凭据中心的引用，
              明文值会跟着画布存档一起落盘。
            </p>

            {Object.entries(config.env?.vars ?? {}).map(([k, val]) => (
              <div className="cfg-row" key={k}>
                <input type="text" className="cfg-k" value={k} readOnly />
                <input
                  type="text"
                  className="cfg-mono"
                  value={val}
                  placeholder="值"
                  onChange={(ev) => {
                    const vars = { ...(config.env?.vars ?? {}) };
                    vars[k] = ev.target.value;
                    onChange({ ...config, env: { ...(config.env ?? { vars: {} }), vars } });
                  }}
                />
                <button
                  type="button"
                  className="cfg-del"
                  title="删除"
                  onClick={() => {
                    const vars = { ...(config.env?.vars ?? {}) };
                    delete vars[k];
                    onChange({ ...config, env: { ...(config.env ?? { vars: {} }), vars } });
                  }}
                >
                  ×
                </button>
              </div>
            ))}

            <button
              type="button"
              className="cfg-add"
              onClick={() => {
                const vars = { ...(config.env?.vars ?? {}) };
                let i = 1;
                while (`VAR_${i}` in vars) i += 1;
                vars[`VAR_${i}`] = '';
                onChange({ ...config, env: { ...(config.env ?? { vars: {} }), vars } });
              }}
            >
              ＋ 加一个变量
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
