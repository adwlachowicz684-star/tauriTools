import { useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import * as S from './lib/store';
import { DEFAULT_CONFIG } from './types';
import type { TbConfig } from './types';

/**
 * 任务管理器 · 设置
 * ------------------------------------------------------------
 * 数据目录 / HTTP 端口 / 访问令牌 / 自动启动 / 审查通知 URL。
 * 改完保存即生效（主视图每 2s 重读文件，配置走 ctx.store + 事件通知）。
 */
export default function Settings() {
  const ctx = useNexus();
  const [cfg, setCfg] = useState<TbConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [serviceOn, setServiceOn] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await S.loadConfig(ctx);
        if (!alive) return;
        setCfg(c);
        setLoaded(true);
        setServiceOn(await S.apiHealth(c));
      } catch (e: any) {
        // 不接住就是未捕获 rejection：界面永远停在「加载中…」，
        // 看不出是配置读不出来，只会以为插件卡住了。
        if (!alive) return;
        setMsg('配置加载失败：' + String(e?.message || e));
        setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ctx]);

  const save = async () => {
    try {
      const prev = cfg;
      const next = await S.saveConfig(ctx, cfg);
      setCfg(next);
      // 服务在跑且配置变了：重启服务让新配置生效。
      // 状态行必须反映真实结果——重启失败时探旧端口兜底，不显示假在线。
      /*
       * dataDir 也在重启条件里：9911 服务启动时把数据目录写进授权表，
       * 运行中改目录不重启的话，AI 的 curl 通道继续读写**旧** tasks.json，
       * 而 UI 与 MCP 网关已走新目录 —— 两库静默分叉，且 ● 仍显示在线。
       * （2026-10-17 深查发现此处漏了 dataDir。）
       */
      if (serviceOn && (
        next.port !== prev.port
        || next.token !== prev.token
        || next.notifyUrl !== prev.notifyUrl
        || next.dataDir !== prev.dataDir
      )) {
        let stopped = true;
        try {
          await S.apiStop(ctx, prev);
        } catch {
          stopped = (await S.apiHealth(prev)) === false;
        }
        let started = false;
        try {
          await S.apiStart(ctx, next);
          started = true;
        } catch (e: any) {
          ctx.toast('服务重启失败：' + String(e?.message || e), 'err');
        }
        setServiceOn(started ? true : await S.apiHealth(stopped ? next : prev));
      } else {
        setServiceOn(await S.apiHealth(next));
      }
      ctx.emit('task-board:config', next); // 通知主视图（约定：<plugin-id>:config）
      setMsg('已保存');
      ctx.toast('设置已保存', 'ok');
    } catch (e: any) {
      setMsg(String(e?.message || e));
      ctx.toast(String(e?.message || e), 'err');
    }
  };

  const pickDir = async () => {
    try {
      // folder-picker 的 pick resolve 的是 { path, action } 对象（取消时 path 为 null），
      // 不是裸字符串——String(r) 会把 dataDir 写成 "[object Object]" 毁掉所有读写
      const r = await ctx.services.call('folder-picker', 'pick', {});
      if (r?.path) setCfg({ ...cfg, dataDir: String(r.path) });
    } catch (e: any) {
      setMsg('选择目录失败：' + String(e?.message || e));
    }
  };

  const toggleService = async () => {
    try {
      if (serviceOn) {
        await S.apiStop(ctx, cfg);
        setServiceOn(false);
      } else {
        await S.apiStart(ctx, cfg);
        setServiceOn(true);
        ctx.toast(`HTTP 服务已启动：127.0.0.1:${cfg.port}`, 'ok');
      }
    } catch (e: any) {
      setMsg(String(e?.message || e));
      ctx.toast(String(e?.message || e), 'err');
    }
  };

  const copyCurl = async () => {
    const text = S.curlExample(cfg);
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast('curl 示例已复制', 'ok');
    } catch {
      setMsg('剪贴板不可用，请手动从下方复制');
    }
  };

  if (!loaded) return <div className="tb-set-wrap">加载中…</div>;

  return (
    <div className="tb-set-wrap">
      <h2>任务管理器设置</h2>

      <label className="tb-sfield">
        <span>数据目录（tasks.json 所在位置）</span>
        <div className="tb-srow">
          <input value={cfg.dataDir} onChange={(e) => setCfg({ ...cfg, dataDir: e.target.value })} />
          <button className="tb-act sm" onClick={pickDir}>
            浏览…
          </button>
          <button
            className="tb-act sm"
            onClick={async () => {
              // 取不到默认目录时（Rust 侧未授权 / 命令缺失）必须说一声：
              // 不接住就是未捕获 rejection，点了按钮界面纹丝不动、也不报错。
              try {
                const dir = await ctx.invoke<string>('tb_default_dir');
                setCfg({ ...cfg, dataDir: dir });
              } catch (e: any) {
                setMsg('取默认目录失败：' + String(e?.message || e));
              }
            }}
          >
            用默认
          </button>
        </div>
        <em>AI 窗口直接读写这个目录下的 tasks.json；改目录等于换一套任务数据。</em>
      </label>

      <div className="tb-srow2">
        <label className="tb-sfield">
          <span>HTTP API 端口</span>
          <input
            type="number"
            min={1024}
            max={65535}
            value={cfg.port}
            onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) || 9911 })}
          />
          <em>AI 窗口 / agent-flow 走 http://127.0.0.1:&lt;端口&gt;/api/tasks</em>
        </label>
        <label className="tb-sfield">
          <span>访问令牌（留空不校验）</span>
          <div className="tb-srow">
            <input value={cfg.token} onChange={(e) => setCfg({ ...cfg, token: e.target.value })} placeholder="（空）" />
            <button className="tb-act sm" onClick={() => setCfg({ ...cfg, token: S.genToken() })}>
              生成
            </button>
          </div>
          <em>防本机其他程序静默调用；请求头 X-TB-Token 带上它</em>
        </label>
      </div>

      <label className="tb-sfield check">
        <input type="checkbox" checked={cfg.autoStart} onChange={(e) => setCfg({ ...cfg, autoStart: e.target.checked })} />
        <span>打开插件时自动启动 HTTP 服务</span>
      </label>

      <label className="tb-sfield">
        <span>审查通知 URL（任务提交审查时 POST）</span>
        <input
          value={cfg.notifyUrl}
          onChange={(e) => setCfg({ ...cfg, notifyUrl: e.target.value })}
          placeholder="http://127.0.0.1:8787/hooks/run（agent-flow webhook 触发器）"
        />
        <em>接 agent-flow 的 webhook 触发器：审查流程自动被触发</em>
      </label>

      <div className="tb-sacts">
        <span className={'tb-svc-state' + (serviceOn ? ' on' : '')}>● {serviceOn ? `服务运行中 127.0.0.1:${cfg.port}` : '服务未启动'}</span>
        <button className="tb-act sm" onClick={toggleService}>
          {serviceOn ? '停止服务' : '启动服务'}
        </button>
        <span className="tb-flex" />
        <button className="tb-act sm" onClick={copyCurl}>
          复制 curl 示例
        </button>
        <button className="tb-act primary" onClick={save}>
          保存
        </button>
      </div>

      {msg && <div className="tb-smsg">{msg}</div>}

      <details className="tb-curl">
        <summary>AI / agent-flow 调用示例（curl）</summary>
        <pre>{S.curlExample(cfg)}</pre>
      </details>

      <details className="tb-curl">
        <summary>MCP 端点（外部 AI 客户端直连，WorkBuddy / Claude 等）</summary>
        <pre>{`端点:  http://127.0.0.1:${cfg.port}/mcp   (Streamable HTTP, JSON-RPC 2.0)
令牌:  ${cfg.token ? `Bearer ${cfg.token}` : '（未设令牌，建议在上方生成）'}

工具:  tb_list_tasks / tb_create_task / tb_get_task
       tb_update_task / tb_add_event / tb_register_agent

WorkBuddy / Claude 等客户端的 MCP 配置示例:
{
  "mcpServers": {
    "task-board": {
      "url": "http://127.0.0.1:${cfg.port}/mcp",
      "headers": { "X-TB-Token": "${cfg.token || '<令牌>'}" }
    }
  }
}`}</pre>
      </details>
    </div>
  );
}
