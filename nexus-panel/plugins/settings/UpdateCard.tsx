import { useCallback, useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';

/**
 * 应用更新
 * ------------------------------------------------------------
 * 设置页的「更新」标签页。真正的逻辑在 Rust（src/updater.rs）与
 * 内置服务插件（plugins/updater/）里，这里只负责：选通道、发起、展示结果。
 *
 * 为什么走服务调用而不是直接 ctx.invoke
 * ------------------------------------------------------------
 * updater_check / install / relaunch 三条都是 **M 类**：
 * 能下载并执行外部安装包、能重启本进程。命令白名单里只有 updater
 * 这个内置插件有它们，设置页**没有**（见 js/invoke-policy.js）。
 * 所以这里只能 ctx.services.call('updater', ...) ——
 * 直接 invoke 会被策略拦掉，且报错只说"命令未授权"，看不出该走服务。
 *
 * 四种状态必须分开显示
 * ------------------------------------------------------------
 * Rust 侧刻意返回 state 字符串而不是 hasUpdate 布尔值：
 * 'unconfigured'（没配公钥）/ 'uptodate' / 'available' / 'error'。
 * 布尔下前两者都是 false，界面只能写一句"没有更新"——
 * 而"没配签名公钥"和"已是最新"要做的完全是两件事。
 *
 * 装完不自动重启
 * ------------------------------------------------------------
 * 重启会干掉正在写的东西。所以 install 成功后给一个「立即重启」按钮，
 * 让用户自己决定什么时候重启。
 */

type UpdateState = {
  state: string;
  channel: string;
  current: string;
  latest: string;
  notes: string;
  date: string;
  message: string;
};

const CHANNELS: [string, string][] = [
  ['stable', '正式版'],
  ['beta', '内部测试'],
];

/** 与 plugins/updater/module.js 共用同一个 key —— 两边各写一份就会漂移。 */
const CHANNEL_KEY = 'nexus.updater.channel';

const readChannel = () => {
  try {
    return localStorage.getItem(CHANNEL_KEY) === 'beta' ? 'beta' : 'stable';
  } catch {
    return 'stable'; // 隐私模式 / 隔离态下 localStorage 可能抛错
  }
};

export default function UpdateCard() {
  const ctx = useNexus();
  const [version, setVersion] = useState<string>('…');
  const [channel, setChannel] = useState<string>(readChannel);
  const [busy, setBusy] = useState<null | 'check' | 'install'>(null);
  const [result, setResult] = useState<UpdateState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 装完了、等用户决定何时重启 */
  const [installed, setInstalled] = useState<string | null>(null);

  useEffect(() => {
    ctx.invoke<string>('app_version').then(setVersion).catch(() => setVersion('未知'));
  }, [ctx]);

  const saveChannel = (v: string) => {
    setChannel(v);
    try {
      localStorage.setItem(CHANNEL_KEY, v);
    } catch {
      /* 存不下不影响本次使用 */
    }
    /* 换通道后旧结果不再成立：留着会显示"正式版已是最新"
       而用户其实刚切到内测版。 */
    setResult(null);
    setInstalled(null);
    setErr(null);
  };

  const check = useCallback(async () => {
    if (busy) return;
    setBusy('check');
    setErr(null);
    try {
      const r = await ctx.services.call('updater', 'check', { channel });
      setResult(r as UpdateState);
      setInstalled(null);
    } catch (e: any) {
      setResult(null);
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [ctx, channel, busy]);

  const install = useCallback(async () => {
    if (busy) return;
    setBusy('install');
    setErr(null);
    try {
      const msg = await ctx.services.call('updater', 'install', { channel });
      setInstalled(String(msg ?? '已安装'));
      setResult(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [ctx, channel, busy]);

  const relaunch = useCallback(async () => {
    try {
      await ctx.services.call('updater', 'relaunch', {});
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, [ctx]);

  const st = result?.state;

  return (
    <div className="p-card">
      <h2>更新</h2>

      <div className="p-grid">
        <div className="p-stat">
          <div className="k">当前版本</div>
          <div className="v" style={{ fontSize: 'var(--fs-15, 15px)' }}>{version}</div>
        </div>
        <div className="p-stat">
          <div className="k">更新通道</div>
          <div className="v">
            <select
              className="p-input"
              value={channel}
              onChange={(e) => saveChannel(e.target.value)}
              title="正式版走 updater-stable，内部测试走 updater-beta；两个通道各有一份 latest.json"
            >
              {CHANNELS.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="p-row" style={{ marginTop: 'var(--sp-7, 14px)', gap: 'var(--sp-4, 8px)' }}>
        <button className="p-btn" onClick={check} disabled={busy !== null}>
          {busy === 'check' ? '检查中…' : '检查更新'}
        </button>
        {st === 'available' ? (
          <button className="p-btn" onClick={install} disabled={busy !== null}>
            {busy === 'install' ? '下载并安装中…' : `安装 v${result?.latest ?? ''}`}
          </button>
        ) : null}
        {installed ? (
          <button className="p-btn" onClick={relaunch}>立即重启</button>
        ) : null}
      </div>

      {st === 'unconfigured' ? (
        <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)', lineHeight: 1.9 }}>
          <strong style={{ color: 'var(--warn, #e0a020)' }}>尚未配置签名公钥</strong>
          <br />
          {result?.message}
          <br />
          生成：<code>npx tauri signer generate</code>，把公钥填进
          <code> src-tauri/tauri.conf.json → plugins.updater.pubkey</code> 与
          <code> src-tauri/src/updater.rs → UPDATER_PUBKEY</code>（两处必须一致）。
          私钥只留在构建机，绝不进仓库。详见 <code>docs/更新与签名.md</code>。
        </div>
      ) : null}

      {st === 'uptodate' ? (
        <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>
          已是最新版本（{channel === 'beta' ? '内部测试' : '正式版'}通道）。
        </div>
      ) : null}

      {st === 'available' ? (
        <div style={{ marginTop: 'var(--sp-7, 14px)' }}>
          <div className="p-row" style={{ gap: 'var(--sp-4, 8px)' }}>
            <strong style={{ color: 'var(--ok, #4ec97a)' }}>
              发现新版本 v{result?.latest}
            </strong>
            {result?.date ? <span className="p-muted">{result.date}</span> : null}
          </div>
          {result?.notes ? (
            <pre
              className="upd-notes"
              style={{ marginTop: 'var(--sp-4, 8px)' }}
            >{result.notes}</pre>
          ) : (
            <div className="p-muted" style={{ marginTop: 'var(--sp-4, 8px)' }}>
              本次更新没有发布说明。
            </div>
          )}
        </div>
      ) : null}

      {st === 'error' ? (
        <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)', lineHeight: 1.9 }}>
          <strong style={{ color: 'var(--danger, #ff6b6b)' }}>检查失败</strong>
          <br />
          {result?.message}
          <br />
          两个端点（GitHub → Gitee）都已尝试。
        </div>
      ) : null}

      {installed ? (
        <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)' }}>
          {installed}
        </div>
      ) : null}

      {err ? (
        <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)', color: 'var(--danger, #ff6b6b)' }}>
          {err}
        </div>
      ) : null}

      <div className="p-muted" style={{ marginTop: 'var(--sp-7, 14px)', lineHeight: 1.9, fontSize: 'var(--fs-12, 12px)' }}>
        检查更新会向所选通道的端点发一次请求（GitHub，失败时自动回退 Gitee）。
        安装包安装前会用 minisign 公钥验签，验不过就拒绝安装。
        装完不会自动重启 —— 由你决定什么时候重启。
      </div>
    </div>
  );
}
