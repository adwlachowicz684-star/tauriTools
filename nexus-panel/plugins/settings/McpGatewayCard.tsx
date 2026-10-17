import { useCallback, useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import { isComposing } from '../../js/ime.js';

/**
 * MCP 网关（统一接入点）
 * ------------------------------------------------------------
 * AI 客户端（WorkBuddy / Claude 等）**只接一次**这里，
 * 各插件的 MCP 工具全部聚合到同一个端点下，工具名形如
 * `project-group__list_projects` / `task-board__tb_list_tasks`。
 *
 * 与既有两个独立端点的关系：
 *   · project-group 设置里的 MCP（fpx）与 task-board 的 9911 **照旧可用**，
 *     这里是新增的统一入口，不替换它们；
 *   · 网关里的内置工具是**直调同一批业务函数**注册的，不是去连那两个端口 ——
 *     所以网关开着时，那两个端点起不起来都不影响这里的工具可用。
 *
 * 为什么自动启动默认开：本功能的目的就是「接入后直接可用」。
 * 暴露面与既有两个本机 server 相同（只绑回环 + 强制令牌）。
 */

/** mcp_gw_status 的返回形状（Rust 侧 mcp_gate.rs 的 mcp_gw_status）。 */
type GwServer = {
  name: string;
  kind: 'native' | 'proxy';
  url: string;
  tools: string[];
  /** 总开关状态：false = 该 server 的全部工具对 AI 客户端不可见 */
  enabled: boolean;
};
type GwStatus = {
  running: boolean;
  addr: string;
  port: number;
  token: string;
  autoStart: boolean;
  servers: GwServer[];
  toolCount: number;
};

/** 新代理注册表单的草稿。 */
type ProxyDraft = { server: string; url: string; token: string };

const BUILTIN_SERVERS = ['project-group', 'task-board'];

export default function McpGatewayCard() {
  const ctx = useNexus();
  const [st, setSt] = useState<GwStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'start' | 'stop' | 'save' | 'register' | 'toggle'>(null);
  /* 配置草稿：拉到时初始化；没拉到（加载中 / 失败）时禁用保存，
     否则会把空端口当成 0 写进去。 */
  const [portDraft, setPortDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [autoDraft, setAutoDraft] = useState(true);
  /* 保存后若改了运行中的端口/令牌，Rust 返回 needRestart ——
     必须显示出来，否则"保存了但没变化"看起来像功能坏了。 */
  const [needRestart, setNeedRestart] = useState(false);
  const [proxy, setProxy] = useState<ProxyDraft>({ server: '', url: '', token: '' });
  const [showToken, setShowToken] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await ctx.invoke<GwStatus>('mcp_gw_status');
      setSt(r);
      setPortDraft(String(r.port ?? ''));
      setTokenDraft(r.token ?? '');
      setAutoDraft(!!r.autoStart);
      setNeedRestart(false);
      setErr(null);
    } catch (e: any) {
      setSt(null);
      setErr(String(e?.message ?? e));
    }
  }, [ctx]);

  useEffect(() => { refresh(); }, [refresh]);

  const start = useCallback(async () => {
    setBusy('start');
    try {
      await ctx.invoke<string>('mcp_gw_start', {});
      ctx.toast('MCP 网关已启动', 'ok');
      await refresh();
    } catch (e: any) {
      ctx.toast(`启动失败：${String(e?.message ?? e)}`, 'err');
    } finally {
      setBusy(null);
    }
  }, [ctx, refresh]);

  const stop = useCallback(async () => {
    setBusy('stop');
    try {
      const clean = await ctx.invoke<boolean>('mcp_gw_stop', {});
      ctx.toast(clean ? 'MCP 网关已停止' : '已发出停止指令，但端口可能仍在监听', clean ? 'ok' : 'warn');
      await refresh();
    } catch (e: any) {
      ctx.toast(`停止失败：${String(e?.message ?? e)}`, 'err');
    } finally {
      setBusy(null);
    }
  }, [ctx, refresh]);

  const save = useCallback(async () => {
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      ctx.toast('端口需在 1024–65535 之间', 'err');
      return;
    }
    setBusy('save');
    try {
      const r: any = await ctx.invoke('mcp_gw_save_config', {
        port,
        token: tokenDraft.trim(),
        autoStart: autoDraft,
      });
      setNeedRestart(!!r?.needRestart);
      ctx.toast(r?.needRestart
        ? '已保存，但端口/令牌要重启网关才生效'
        : '配置已保存', r?.needRestart ? 'warn' : 'ok');
      await refresh();
    } catch (e: any) {
      ctx.toast(`保存失败：${String(e?.message ?? e)}`, 'err');
    } finally {
      setBusy(null);
    }
  }, [ctx, portDraft, tokenDraft, autoDraft, refresh]);

  const register = useCallback(async () => {
    const name = proxy.server.trim();
    const url = proxy.url.trim();
    if (!name || !url) {
      ctx.toast('服务名与地址都要填', 'err');
      return;
    }
    setBusy('register');
    try {
      const r: any = await ctx.invoke('mcp_gw_register', {
        server: name,
        url,
        token: proxy.token.trim(),
      });
      ctx.toast(`已注册「${r?.server ?? name}」，纳入 ${r?.tools ?? 0} 个工具`, 'ok');
      setProxy({ server: '', url: '', token: '' });
      await refresh();
    } catch (e: any) {
      ctx.toast(`注册失败：${String(e?.message ?? e)}`, 'err');
    } finally {
      setBusy(null);
    }
  }, [ctx, proxy, refresh]);

  const unregister = useCallback(async (server: string) => {
    try {
      await ctx.invoke('mcp_gw_unregister', { server });
      ctx.toast(`已移除「${server}」`, 'ok');
      await refresh();
    } catch (e: any) {
      ctx.toast(`移除失败：${String(e?.message ?? e)}`, 'err');
    }
  }, [ctx, refresh]);

  /*
   * 插件 MCP 总开关：整体打开 / 关闭某个 server 的工具。
   *
   * 与「移除」的区别：这个**不碰注册表** —— 服务还在，工具还登记着，
   * 只是对 AI 客户端整体隐身（tools/list 不列、调用报「已关闭」）。
   * 拨回来立刻恢复。适合这些场景：
   *   · 暂时不想让 AI 看到某个插件的全部工具（比如在改那个插件）；
   *   · 插件卸载了 / 打算卸载，先把它的工具关掉（移除会连注册一起删）。
   * 即时生效，不用重启网关（Rust 侧现读 disabled_servers）。
   */
  const toggleServer = useCallback(async (server: string, enabled: boolean) => {
    setBusy('toggle');
    try {
      await ctx.invoke('mcp_gw_set_server_enabled', { server, enabled });
      ctx.toast(enabled ? `已开启「${server}」的全部工具` : `已关闭「${server}」的全部工具`, 'ok');
      await refresh();
    } catch (e: any) {
      ctx.toast(`操作失败：${String(e?.message ?? e)}`, 'err');
    } finally {
      setBusy(null);
    }
  }, [ctx, refresh]);

  const regenToken = useCallback(async () => {
    /*
     * 令牌由 Rust 生成（32 位 hex）。这里借一次保存流程写进去：
     * 先让 Rust 侧生成 —— 做法是保存一个空令牌时 Rust 会自动补一个
     * （见 mcp_gate.rs 的 start/save_config）。但那条路径只在**启动**时
     * 补，save_config 对空令牌是原样写空。所以这里在前端生成：
     * 用 crypto.getRandomValues，与 Rust 侧同强度（32 位 hex）。
     */
    const bytes = new Uint8Array(16);
    (globalThis.crypto ?? (window as any).crypto)?.getRandomValues?.(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex.length !== 32) {
      ctx.toast('当前环境无法生成随机令牌，请手动粘贴一个', 'err');
      return;
    }
    setTokenDraft(hex);
    setShowToken(true);
    ctx.toast('已生成新令牌（点「保存配置」后生效）', 'ok');
  }, [ctx]);

  const cfgText = st
    ? `{\n  "mcpServers": {\n    "nexus-panel": {\n      "url": "http://127.0.0.1:${st.port}/mcp",\n      "headers": { "Authorization": "Bearer ${st.token || '<令牌>'}" }\n    }\n  }\n}`
    : '';

  /* 关掉的 server 的工具不进 AI 的视线 —— 统计区要把这笔账算出来，
     否则"工具总数"和客户端里实际能调的数对不上。 */
  const hiddenServers = st ? st.servers.filter((s) => !s.enabled).length : 0;
  const hiddenTools = st
    ? st.servers.filter((s) => !s.enabled).reduce((n, s) => n + s.tools.length, 0)
    : 0;

  return (
    <div className="p-card">
      <h2>MCP 网关</h2>
      <div className="p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', lineHeight: 1.9 }}>
        统一接入点：AI 客户端只配**这一个**端点，全部插件的 MCP 工具都在里面
        （工具名带 <span className="p-mono">插件名__工具名</span> 前缀）。
        新插件的工具注册进网关后即可直接使用，不需要再改客户端配置。
      </div>

      {err ? (
        <div className="p-muted" style={{ padding: '12px 0', color: 'var(--danger)' }}>
          读取网关状态失败：{err}
        </div>
      ) : st === null ? (
        <div className="p-muted" style={{ padding: '12px 0' }}>载入中…</div>
      ) : (
        <>
          {/* ---------------- 运行状态 ---------------- */}
          <div className="p-row" style={{ gap: 'var(--sp-4, 8px)' }}>
            <span style={{
              fontSize: 'var(--fs-12, 12px)',
              color: st.running ? 'var(--ok)' : 'var(--text-mute)',
            }}>
              ● {st.running ? `运行中 http://${st.addr}/mcp` : '未启动'}
            </span>
            {/* 占位把右侧按钮推到尽头（内联式：项目里没有 .p-flex 这个类） */}
            <span style={{ flex: 1 }} />
            <button
              className="p-btn"
              style={{ flex: 'none', fontSize: 'var(--fs-11, 11px)', padding: '2px 8px' }}
              disabled={busy !== null}
              onClick={refresh}
              title="重新拉取状态"
            >
              ↻
            </button>            {st.running ? (
              <button
                className="p-btn"
                style={{ flex: 'none', fontSize: 'var(--fs-12, 12px)' }}
                disabled={busy !== null}
                onClick={stop}
              >
                {busy === 'stop' ? '停止中…' : '停止'}
              </button>
            ) : (
              <button
                className="p-btn primary"
                style={{ flex: 'none', fontSize: 'var(--fs-12, 12px)' }}
                disabled={busy !== null}
                onClick={start}
              >
                {busy === 'start' ? '启动中…' : '启动'}
              </button>
            )}
          </div>

          {/* ---------------- 统计 ---------------- */}
          <div className="p-grid" style={{ marginTop: 'var(--sp-6, 12px)' }}>
            <div className="p-stat">
              <div className="k">工具总数</div>
              <div className="v" style={{ fontSize: 'var(--fs-15, 15px)' }}>{st.toolCount}</div>
              {/* 关掉 server 后两个数会不一致 —— 不显示"AI 可见"的话，
                  用户按"工具总数"去客户端里找，找不到的那几个像坏了。 */}
              {hiddenTools > 0 ? (
                <div className="k" style={{ marginTop: 'var(--sp-1, 2px)', color: 'var(--warn)' }}>
                  AI 可见 {st.toolCount - hiddenTools}
                </div>
              ) : null}
            </div>
            <div className="p-stat">
              <div className="k">服务数</div>
              <div className="v" style={{ fontSize: 'var(--fs-15, 15px)' }}>{st.servers.length}</div>
              {hiddenServers > 0 ? (
                <div className="k" style={{ marginTop: 'var(--sp-1, 2px)', color: 'var(--warn)' }}>
                  已关闭 {hiddenServers}
                </div>
              ) : null}
            </div>
          </div>

          {/* ---------------- 配置 ---------------- */}
          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>配置</div>
          <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)', gap: 'var(--sp-4, 8px)' }}>
            <span className="p-muted" style={{ width: 56, flex: 'none', fontSize: 'var(--fs-12, 12px)' }}>端口</span>
            <input
              className="p-input sm"
              type="number"
              min={1024}
              max={65535}
              style={{ width: 90, flex: 'none', fontSize: 'var(--fs-12, 12px)', padding: '0 10px' }}
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
              onKeyDown={(e) => { if (isComposing(e.nativeEvent)) return; if (e.key === 'Enter') save(); }}
            />
            <span className="p-muted" style={{ flex: 1, fontSize: 'var(--fs-11, 11px)' }}>
              只监听 127.0.0.1；与 project-group（9905 起）、task-board（9911 起）错开即可
            </span>
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-3, 6px)', gap: 'var(--sp-4, 8px)' }}>
            <span className="p-muted" style={{ width: 56, flex: 'none', fontSize: 'var(--fs-12, 12px)' }}>令牌</span>
            <input
              className="p-input sm p-mono"
              type={showToken ? 'text' : 'password'}
              placeholder="客户端要用它鉴权"
              style={{ flex: 1, fontSize: 'var(--fs-12, 12px)', padding: '0 10px', minWidth: 0 }}
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={(e) => { if (isComposing(e.nativeEvent)) return; if (e.key === 'Enter') save(); }}
            />
            <button
              className="p-btn sm"
              style={{ flex: 'none', fontSize: 'var(--fs-11, 11px)', padding: '2px 8px' }}
              onClick={() => setShowToken((v) => !v)}
              title={showToken ? '隐藏令牌' : '显示令牌'}
            >
              {showToken ? '隐藏' : '显示'}
            </button>
            <button
              className="p-btn sm"
              style={{ flex: 'none', fontSize: 'var(--fs-11, 11px)', padding: '2px 8px' }}
              onClick={regenToken}
              title="生成一个新的随机令牌（保存后生效）"
            >
              重新生成
            </button>
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-3, 6px)', gap: 'var(--sp-4, 8px)' }}>
            <span className="p-muted" style={{ width: 56, flex: 'none', fontSize: 'var(--fs-12, 12px)' }}>启动</span>
            <label className="p-row" style={{ gap: 'var(--sp-2, 4px)', fontSize: 'var(--fs-12, 12px)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoDraft}
                onChange={(e) => setAutoDraft(e.target.checked)}
              />
              <span>随应用自动启动</span>
            </label>
            <span style={{ flex: 1 }} />
            <button
              className="p-btn primary"
              style={{ flex: 'none', fontSize: 'var(--fs-12, 12px)' }}
              disabled={busy !== null}
              onClick={save}
            >
              {busy === 'save' ? '保存中…' : '保存配置'}
            </button>
          </div>
          {needRestart ? (
            <div className="p-muted" style={{ marginTop: 'var(--sp-3, 6px)', color: 'var(--warn)', lineHeight: 1.8 }}>
              端口/令牌改了不会热生效（监听与鉴权用的是启动时那一份）——
              点上面的「停止」再「启动」即可让新配置生效。
            </div>
          ) : null}

          {/* ---------------- 服务清单 ---------------- */}
          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>
            已接入的服务 · {st.servers.length}
          </div>
          <div className="p-muted" style={{ marginTop: 'var(--sp-1, 2px)', fontSize: 'var(--fs-11, 11px)', lineHeight: 1.8 }}>
            每行前面的勾选框是**插件 MCP 总开关**：取消勾选，该插件的全部工具立即从
            AI 客户端消失（服务本身还在，勾回来即刻恢复）—— 插件卸载前后用它临时关停。
          </div>
          {st.servers.length === 0 ? (
            <div className="p-muted" style={{ marginTop: 'var(--sp-4, 8px)' }}>
              一个都没有 —— 内置工具应在启动时自动注册，这不该发生。
            </div>
          ) : st.servers.map((s) => (
            <div
              key={s.name}
              style={{
                marginTop: 'var(--sp-4, 8px)', padding: '10px 12px', borderRadius: 'var(--r-sm)',
                background: 'var(--surface-sunk)',
                boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
                // 关掉的 server 整行压暗：一眼看出"这个插件的工具现在不在网关里"
                opacity: s.enabled ? 1 : 0.55,
              }}
            >
              <div className="p-row" style={{ gap: 'var(--sp-4, 8px)' }}>
                <label
                  className="p-row"
                  style={{ gap: 'var(--sp-2, 4px)', cursor: busy === 'toggle' ? 'default' : 'pointer', flex: 'none' }}
                  title={s.enabled ? '取消勾选 = 关闭这个插件的全部 MCP 工具' : '勾选 = 恢复这个插件的全部 MCP 工具'}
                >
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={busy !== null}
                    onChange={(e) => toggleServer(s.name, e.target.checked)}
                  />
                  <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
                    {s.enabled ? '已开启' : '已关闭'}
                  </span>
                </label>
                <span className="p-mono" style={{ fontSize: 'var(--fs-12, 12px)', color: 'var(--text)' }}>
                  {s.name}
                </span>
                <span className="p-tag" style={{ flex: 'none' }}>
                  {BUILTIN_SERVERS.includes(s.name) ? '内置' : s.kind === 'proxy' ? '代理' : '原生'}
                </span>
                <span className="p-muted" style={{ flex: 1, fontSize: 'var(--fs-11, 11px)' }}>
                  {s.kind === 'proxy' ? s.url : '进程内直调'} · {s.tools.length} 个工具
                </span>
                {!BUILTIN_SERVERS.includes(s.name) ? (
                  <button
                    className="p-btn sm"
                    style={{ flex: 'none', fontSize: 'var(--fs-11, 11px)', padding: '2px 8px' }}
                    title="从网关移除这个服务（内置服务不可移除）"
                    onClick={() => unregister(s.name)}
                  >
                    移除
                  </button>
                ) : null}
              </div>
              <div
                className="p-mono p-muted"
                style={{ marginTop: 'var(--sp-3, 6px)', fontSize: 'var(--fs-11, 11px)', wordBreak: 'break-all', lineHeight: 1.8 }}
              >
                {s.enabled ? s.tools.join('  ·  ') : `（已整体关闭，${s.tools.length} 个工具暂不在 AI 客户端列出）`}
              </div>
            </div>
          ))}

          {/* ---------------- 代理注册 ---------------- */}
          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>接入第三方 MCP 服务</div>
          <div className="p-muted" style={{ marginTop: 'var(--sp-1, 2px)', fontSize: 'var(--fs-11, 11px)', lineHeight: 1.8 }}>
            本机跑的其它 MCP server（http://）可以代理进来：填服务名与地址，
            网关会拉取它的工具清单并冠上 <span className="p-mono">服务名__</span> 前缀。
            内置插件不需要这一步 —— 它们的工具启动时已自动注册。
            <br />
            服务名**建议直接用插件 id**（如 <span className="p-mono">xmind</span>）：
            卸载该插件时，设置页会按这个名字自动清理网关里的服务。
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)', gap: 'var(--sp-4, 8px)' }}>
            <input
              className="p-input sm"
              type="text"
              placeholder="服务名（小写字母/数字/连字符）"
              style={{ width: 180, flex: 'none', fontSize: 'var(--fs-12, 12px)', padding: '0 10px' }}
              value={proxy.server}
              onChange={(e) => setProxy({ ...proxy, server: e.target.value })}
              onKeyDown={(e) => { if (isComposing(e.nativeEvent)) return; if (e.key === 'Enter') register(); }}
            />
            <input
              className="p-input sm p-mono"
              type="text"
              placeholder="http://127.0.0.1:端口/mcp"
              style={{ flex: 1, fontSize: 'var(--fs-12, 12px)', padding: '0 10px', minWidth: 0 }}
              value={proxy.url}
              onChange={(e) => setProxy({ ...proxy, url: e.target.value })}
              onKeyDown={(e) => { if (isComposing(e.nativeEvent)) return; if (e.key === 'Enter') register(); }}
            />
            <input
              className="p-input sm p-mono"
              type="text"
              placeholder="对方令牌（没有可留空）"
              style={{ width: 150, flex: 'none', fontSize: 'var(--fs-12, 12px)', padding: '0 10px' }}
              value={proxy.token}
              onChange={(e) => setProxy({ ...proxy, token: e.target.value })}
              onKeyDown={(e) => { if (isComposing(e.nativeEvent)) return; if (e.key === 'Enter') register(); }}
            />
            <button
              className="p-btn primary"
              style={{ flex: 'none', fontSize: 'var(--fs-12, 12px)' }}
              disabled={busy !== null}
              onClick={register}
            >
              {busy === 'register' ? '注册中…' : '注册'}
            </button>
          </div>

          {/* ---------------- 客户端配置示例 ---------------- */}
          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>AI 客户端配置示例</div>
          <div className="p-muted" style={{ marginTop: 'var(--sp-1, 2px)', fontSize: 'var(--fs-11, 11px)', lineHeight: 1.8 }}>
            把下面这段并进客户端的 mcpServers（WorkBuddy / Claude 等）——
            只需配**一个**端点，全部插件工具都在里面。
          </div>
          <pre
            className="p-mono"
            style={{
              marginTop: 'var(--sp-4, 8px)', padding: '10px 12px', borderRadius: 'var(--r-sm)',
              background: 'var(--surface-sunk)', fontSize: 'var(--fs-11, 11px)',
              color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.8,
            }}
          >{cfgText}</pre>

          <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)', lineHeight: 1.9, fontSize: 'var(--fs-12, 12px)' }}>
            工具名规则：<span className="p-mono">服务名__工具名</span>（双下划线）。
            例如 <span className="p-mono">task-board__tb_list_tasks</span>。
            调用时不带前缀、或前缀不存在，回包里会写明完整清单的查法。
          </div>
        </>
      )}
    </div>
  );
}
