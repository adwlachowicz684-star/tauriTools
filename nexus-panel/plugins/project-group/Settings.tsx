import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import { errText, makeApi } from './api';
import { LinkAgentBody } from './components/LinkPanel';
import { SettingsBody } from './components/SettingsDialog';
import { ServiceBody } from './components/ToolsPanel';
import type { Bootstrap, FpxConfig } from './types';
import {
  FEEDBACK_MAX, clearFeedback, dismissFeedback, feedbackTime, pushFeedback,
  type FeedbackItem,
} from './utils/feedback';

/**
 * 插件设置面板（外壳「⚙ 设置」打开的那一页）。
 * ------------------------------------------------------------
 * 这个组件跑在**另一个**沙箱 iframe 里（init 消息带 view='settings'），
 * 但 useNexus() 拿到的 ctx 与主视图完全一致：同一批后端命令、同一份磁盘配置。
 *
 * 为什么要独立一页：主界面的工具栏已被左操作栏取代，
 * 而「基础设置 / 链接名 / 服务」都属于配置而非日常操作，
 * 塞回主界面只会让工具栏重新臃肿。放到外壳统一的设置入口，
 * 也和其它插件的位置一致，用户不用在每个插件里找不同的入口。
 *
 * 代价是改完之后主视图不知道（两个 iframe 不共享内存），
 * 所以每次保存后 emit 一个事件，主视图监听后自行刷新。
 */
export default function PluginSettings() {
  const ctx = useNexus();
  const api = useMemo(() => makeApi(ctx), [ctx]);

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [err, setErr] = useState('');
  /* #9 面板内的反馈条 */
  const [fbs, setFbs] = useState<FeedbackItem[]>([]);

  const load = useCallback(async () => {
    try {
      setBoot(await api.bootstrap());
      setErr('');
    } catch (e) {
      setErr(errText(e));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const log = useCallback((m: string, isError = false) => {
    /* #9 两处都给：
       · 反馈条 —— 能回看，但**固定在面板顶部**，操作发生在底部时它在屏幕外
       · toast  —— 一闪而过，但立刻出现在视线里
       所以错误**必须**同时 toast（错了要马上知道），普通提示以反馈条为主。
       两者分工不同，不是重复。 */
    setFbs((prev) => pushFeedback(prev, m, isError));
    if (isError) ctx.toast(m, 'err');
  }, [ctx]);

  /**
   * 保存配置：先重读一份再合并 patch 写回。
   *
   * 这里**必须**重读，与主视图相反（主视图用 configRef 乐观推进是为了串起
   * 连续操作）。设置页是低频的，但它与主视图是两个独立进程般的上下文：
   * 主视图可能在这期间改过配置（拖放加了卡片、改了标签色），
   * 拿自己加载时的旧 config 整份写回会把那些改动抹掉。
   */
  const save = useCallback(async (patch: Partial<FpxConfig>) => {
    /*
     * 失败**必须说出来**。此前整段没有 try/catch，而下面六个调用点
     * 全是 `void save(...)` —— 异常一路 reject 出去没人接，变成
     * unhandled rejection：**用户拨了一个开关，界面毫无反应**，
     * 既没 toast 也没反馈条（连"保存失败"都没有）。
     *
     * 保存失败是可能的（磁盘满 / 跨进程锁冲突 / 损坏文件保护拦下写入），
     * 而用户只会以为"这个开关没记住"，反复拨、反复失败。
     *
     * 返回 null 让调用方知道没成；`.then(() => void load())` 那路
     * 会重读一份真实配置，把开关弹回磁盘上的真实值 —— 正是我们要的。
     */
    try {
      const fresh = await api.bootstrap();
      const next: FpxConfig = { ...fresh.config, ...patch };
      const snap = await api.saveConfig(next);
      setBoot((b) => (b ? { ...b, ...snap } : b));
      // 通知主视图：两个 iframe 不共享状态，不通知它那边还是旧数据
      ctx.emit('project-group:config-changed');
      return snap;
    } catch (e) {
      log(`保存失败：${errText(e)}`, true);
      return null;
    }
  }, [api, ctx, log]);

  if (err) {
    return (
      <div className="p-card">
        <h2>加载失败</h2>
        <div className="p-muted">{err}</div>
        <button className="p-btn primary" style={{ marginTop: 'var(--sp-6, 12px)' }} onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  if (!boot) return <div className="p-card"><div className="p-muted">正在加载设置…</div></div>;

  return (
    <>
      {/* #9 操作反馈条：放在**面板最顶部**且吸顶，
          否则滚到下面操作时它就看不见了。
          空列表不渲染（不留一块空白占位）。 */}
      {fbs.length > 0 && (
        <div className="fpx-feedback">
          {fbs.map((f) => (
            <div key={f.id} className={`fpx-feedback-row${f.isError ? ' err' : ''}`}>
              <span className="fpx-feedback-icon">{f.isError ? '⚠' : '✓'}</span>
              <span className="fpx-feedback-text">{f.text}</span>
              <span className="fpx-feedback-at">{feedbackTime(f.at)}</span>
              <button
                type="button"
                className="fpx-feedback-x"
                title="关掉这条"
                onClick={() => setFbs((prev) => dismissFeedback(prev, f.id))}
              >
                ×
              </button>
            </div>
          ))}
          <div className="fpx-feedback-foot">
            <span className="p-muted">
              最近 {fbs.length} 条（最多 {FEEDBACK_MAX} 条）
            </span>
            <button className="p-btn" onClick={() => setFbs(clearFeedback())}>清空</button>
          </div>
        </div>
      )}

      <div className="p-card">
        <h2>基础设置</h2>
        <SettingsBody
          api={api}
          config={boot.config}
          dataDir={boot.dataDir}
          onShowShortcutsChange={(on) => void save({ showShortcuts: on })}
          onDevModeChange={(on) => void save({ devMode: on })}
          onResetLayout={() => void save({
            colStars: null,
            logRowHeight: null,
            tipsPanelHeight: null,
          })}
          onLog={log}
          onSaved={save}
        />
      </div>

      <div className="p-card">
        <h2>Agent 链接名</h2>
        <div className="p-muted" style={{ marginBottom: 'var(--sp-5, 10px)', fontSize: 'var(--fs-11, 11px)' }}>
          哪些 agent 目录会被建链、各自的显示名与厂商标注。改完在下面保存。
        </div>
        <LinkAgentBody
          config={boot.config}
          presetAgents={boot.presetAgents}
          onLog={(m) => log(m)}
          onSave={(next) => {
            void save({
              linkAgents: next.linkAgents,
              customLinkAgents: next.custom,
              linkAgentRemarks: next.remarks,
              linkAgentVendors: next.vendors,
              linkAgentRenames: next.renames,
              linkAgentsPinned: next.pinned,
            }).then(() => void load());
          }}
        />
      </div>

      <div className="p-card">
        <h2>服务</h2>
        <ServiceBody
          api={api}
          config={boot.config}
          onLog={log}
          onSaved={(patch) => { void save(patch); }}
          // 设置页自己不轮询监听事件，主视图那边的开关状态由它自己恢复
          onWatchToggled={() => { ctx.emit('project-group:config-changed'); }}
        />
      </div>
    </>
  );
}
