import { useEffect, useState } from 'react';
import { isComposing } from '../../js/ime.js';
import { useNexus } from '../../src/nexus-react';
import * as S from './lib/store';
import { currentProject } from './core';
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
  /** 正在编辑文档路径的项目（'' = 关着） */
  const [docsEdit, setDocsEdit] = useState('');
  const [docsDraft, setDocsDraft] = useState('');
  const [newName, setNewName] = useState('');
  /** 改文档路径时旧位置的文件怎么办 */
  const [moveMode, setMoveMode] = useState<'move' | 'keep'>('move');

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

  const renameProject = (c: TbConfig, id: string, name: string): TbConfig => ({
    ...c,
    projects: c.projects.map((p) => (p.id === id ? { ...p, name } : p)),
  });

  const doAddProject = async () => {
    const nm = newName.trim();
    if (!nm) return;
    try {
      /* 数据目录留空 → store 层落到默认目录下的同名子目录。
         建完就提醒设文档路径：那是这个项目最容易漏、漏了又最难补的一项。 */
      const next = await S.addProject(ctx, cfg, nm, '', '');
      setCfg(next);
      setNewName('');
      ctx.emit('task-board:config', next);
      ctx.toast(`已建项目「${currentProject(next).name}」，记得设文档路径`, 'ok');
    } catch (e: any) {
      setMsg(String(e?.message || e));
    }
  };

  /** 改某个项目的数据目录（不动文档） */
  const pickDirFor = async (id: string) => {
    const p = cfg.projects.find((x) => x.id === id);
    if (!p) return;
    try {
      const r = await ctx.services.call('folder-picker', 'pick', {});
      if (!r?.path) return;
      const next = await S.saveConfig(ctx, {
        ...cfg,
        projects: cfg.projects.map((x) => (
          x.id === id ? { ...x, dataDir: String(r.path) } : x
        )),
      });
      setCfg(next);
      ctx.emit('task-board:config', next);
      ctx.toast(`「${p.name}」的数据目录已改`, 'ok');
    } catch (e: any) {
      setMsg(String(e?.message || e));
    }
  };

  /** 保存文档路径（可能带搬家） */
  const doSaveDocs = async () => {
    const id = docsEdit;
    const p = cfg.projects.find((x) => x.id === id);
    if (!p) return;
    try {
      /* 先把目标项目设为当前，再改它的文档路径 ——
         setDocsDir 只作用于当前项目（配置里只有一份当前路径）。 */
      const base = await S.switchProject(ctx, cfg, id);
      /*
        ⛔ 切换**已经落盘了**，所以无论后面成功失败，界面都必须跟到 base。
        不跟的话：磁盘上的当前项目是新的，界面还拿着旧 dataDir 去读 ——
        而授权表已经指向新项目，那次读会被直接拒掉。
        结果是"报了个错，顺带整个面板空了"，没人会对上原因。
      */
      setCfg(base);
      ctx.emit('task-board:config', base);

      const move = moveMode === 'move' && !!p.docsDir && p.docsDir !== docsDraft;
      try {
        const res = await S.setDocsDir(ctx, base, docsDraft.trim(), move);
        setCfg(res.cfg);
        ctx.emit('task-board:config', res.cfg);
        if (res.warning) setMsg(res.warning);
        else if (move) ctx.toast(`文档已整体搬到新位置（${res.moved} 项）`, 'ok');
        else ctx.toast('文档路径已保存', 'ok');
      } catch (e2: any) {
        // 路径没改成，但项目已经切过去了 —— 这句话必须说清，否则用户以为全都没生效
        setMsg(`文档路径没改：${String(e2?.message || e2)}（项目已切到「${p.name}」）`);
      }
      setDocsEdit('');
    } catch (e: any) {
      setMsg(String(e?.message || e));
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

      {/* ---------- 项目 ---------- */}
      <section className="tb-sproj">
        <header className="tb-sproj-head">
          项目
          <em>每个项目一份独立任务库（任务 / 流程 / 标签 / 身份表各自独立）</em>
        </header>

        {cfg.projects.map((p) => {
          const on = p.id === cfg.currentId;
          return (
            <div key={p.id} className={'tb-sproj-row' + (on ? ' on' : '')}>
              <button
                className={'tb-sproj-pick' + (on ? ' on' : '')}
                title={on ? '当前项目' : '切到这个项目'}
                onClick={async () => {
                  try {
                    const next = await S.switchProject(ctx, cfg, p.id);
                    setCfg(next);
                    ctx.emit('task-board:config', next);
                  } catch (e: any) {
                    setMsg(String(e?.message || e));
                  }
                }}
              >
                {on ? '●' : '○'}
              </button>
              <input
                className="tb-sproj-name"
                value={p.name}
                onChange={(ev) => setCfg(renameProject(cfg, p.id, ev.target.value))}
              />
              <span className="tb-sproj-dir" title={p.dataDir || '（未设）'}>
                {p.dataDir || '（未设数据目录）'}
              </span>
              <button className="tb-act sm" onClick={() => pickDirFor(p.id)}>
                改数据目录
              </button>
              <button
                className="tb-act sm"
                onClick={() => {
                  setDocsEdit(p.id);
                  setDocsDraft(p.docsDir || '');
                  setMoveMode('move');
                }}
              >
                {p.docsDir ? '改文档路径' : '设文档路径'}
              </button>
              <button
                className="tb-act sm warn"
                disabled={cfg.projects.length <= 1}
                title={cfg.projects.length <= 1 ? '至少要留一个项目' : '删除这个项目'}
                onClick={async () => {
                  /*
                    删项目不删文档：文档是用户自己的文件，
                    这里只是不再记录它在哪。连带删文件是越界，
                    而且删错了没法撤（不在回收站里）。
                  */
                  if (!window.confirm(
                    `删除项目「${p.name}」？\n\n`
                    + '只删这里的记录，磁盘上的 tasks.json 和文档都不会动。',
                  )) return;
                  try {
                    const next = await S.removeProject(ctx, cfg, p.id);
                    setCfg(next);
                    ctx.emit('task-board:config', next);
                  } catch (e: any) {
                    setMsg(String(e?.message || e));
                  }
                }}
              >
                删除
              </button>
            </div>
          );
        })}

        <div className="tb-sproj-row">
          <input
            className="tb-sproj-name"
            value={newName}
            placeholder="新项目名…"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (!isComposing(e.nativeEvent) && e.key === 'Enter') doAddProject();
            }}
          />
          <button className="tb-act sm" onClick={doAddProject}>
            ＋ 新建项目
          </button>
        </div>

        {/* 文档路径编辑区：改路径时要问清搬不搬 */}
        {docsEdit && cfg.projects.some((x) => x.id === docsEdit) ? (
          <div className="tb-sdocs">
            <div className="tb-sdocs-title">
              「{cfg.projects.find((x) => x.id === docsEdit)!.name}」的文档路径
            </div>
            <div className="tb-srow">
              <input
                value={docsDraft}
                placeholder="选一个目录"
                onChange={(e) => setDocsDraft(e.target.value)}
              />
              <button className="tb-act sm" onClick={async () => {
                const r = await ctx.services.call('folder-picker', 'pick', {});
                if (r?.path) setDocsDraft(String(r.path));
              }}>
                浏览…
              </button>
            </div>
            {(() => {
              const ep = cfg.projects.find((x) => x.id === docsEdit)!;
              if (!ep.docsDir || !docsDraft || ep.docsDir === docsDraft) return null;
              return (
                <div className="tb-sdocs-move">
                  <span>旧位置「{ep.docsDir}」里的文档怎么办？</span>
                  <label className="tb-sfield check">
                    <input
                      type="radio"
                      name="tbmove"
                      checked={moveMode === 'move'}
                      onChange={() => setMoveMode('move')}
                    />
                    <span>整体搬过去（旧位置不留）</span>
                  </label>
                  <label className="tb-sfield check">
                    <input
                      type="radio"
                      name="tbmove"
                      checked={moveMode === 'keep'}
                      onChange={() => setMoveMode('keep')}
                    />
                    <span>只改路径，文件留在原处</span>
                  </label>
                  <em>
                    选"搬"：文档会被移走，旧目录不再有副本 ——
                    两边都留一份的话，下次到底读哪边就说不清了。
                  </em>
                </div>
              );
            })()}
            <div className="tb-srow">
              <button className="tb-act sm" onClick={() => setDocsEdit('')}>
                取消
              </button>
              <button className="tb-act sm primary" onClick={doSaveDocs}>
                保存文档路径
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <label className="tb-sfield">
        <span>当前项目的数据目录（tasks.json 所在位置）</span>
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

      <label className="tb-sfield">
        <span>当前项目的文档路径</span>
        <div className="tb-srow">
          <input
            value={cfg.docsDir}
            onChange={(e) => setCfg({ ...cfg, docsDir: String(e.target.value) })}
            placeholder="（还没设）"
          />
          <button className="tb-act sm" onClick={() => {
            setDocsEdit(cfg.currentId);
            setDocsDraft(cfg.docsDir || '');
            setMoveMode('move');
          }}>
            设置并搬家…
          </button>
        </div>
        <em>
          直接改这里只换记录、不动文件 —— 要连文档一起搬过去，用「设置并搬家…」。
        </em>
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
