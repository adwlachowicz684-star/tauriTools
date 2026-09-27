import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import { DEPS_MANIFEST, DEP_STATUS } from '../../js/deps-manifest.js';
import { copyText } from '../../js/clipboard.js';
import {
  canInstall,
  installRuntimeDep,
  listRuntimeDeps,
  loadRuntimeDep,
  removeRuntimeDep,
  specOf,
  safeFileOf,
} from '../../js/runtime-deps.js';

/**
 * 依赖
 * ------------------------------------------------------------
 * 把工具的依赖摆在一处看：声明了什么、实际装了什么、谁在用、还差什么。
 *
 * 【为什么要有这个页签】
 * 本项目反复栽在一种失效上：**源码里 import 了，package.json 里没有**。
 *   · mermaid 装了却没写进 package.json → 别人 clone 后图表渲染失败
 *   · @plantuml/core 被同步覆盖掉 → PlantUML 图一直转圈，控制台只有一句警告
 * 这类问题**不报错、不红、界面退化但不崩**，只有"声明 vs 实际"摆在一起
 * 对照才看得出来。放在各处看，永远只能看到"我这边是好的"。
 *
 * 【数据来自 js/deps-manifest.js，不是运行时读文件】
 * 打包产物里没有 package.json、也没有 node_modules（前端依赖已被 Vite
 * 打进产物）。运行时再去读，dev 下正常、打包后变成"列表永远为空且不报错"。
 * 清单由 npm run deps:scan 在构建期生成，两种模式读到的是同一份。
 *
 * 【"未判定"不是"没做完"】
 * 有些环境里 node_modules 是指向全局目录的软链接，里面装的版本与
 * 本仓库无关。此时一律记 unknown 并说明原因 —— 照常读会满屏假红，
 * 反而会诱使人去改根本没问题的版本号。
 *
 * 【"一键安装"装的是运行时依赖，不是改 package.json】
 * 打包产物里没有 npm，改 package.json 对已发布的工具毫无作用 ——
 * 用户点了"安装"却什么都没发生，是最难解释的一类失败。
 * 所以这里走的是 js/runtime-deps.js 那条链：从 CDN 取 ESM 单文件、
 * 存进工具数据目录、之后由插件动态 import。
 */

type Item = {
  name: string;
  declared: string | null;
  installed: string | null;
  dev: boolean;
  status: string;
  usedBy: string[];
  pinned: boolean;
  note: string;
  install: string;
  kind: 'runtime' | 'dev' | 'rust';
};

const STATUS: Record<string, { label: string; tone: string }> = DEP_STATUS;

/** 有问题的三类：缺失 / 版本不符 / 未声明。其余是提示性的。 */
const ISSUE = new Set(['missing', 'mismatch', 'undeclared']);

const FILTERS: [string, string][] = [
  ['all', '全部'],
  ['issue', '有问题'],
  ['runtime', '运行时'],
  ['dev', '开发时'],
  ['rust', 'Rust'],
];

function itemsOf(): Item[] {
  const m: any = DEPS_MANIFEST;
  const npm: Item[] = (m?.npm ?? []).map((d: any) => ({ ...d, kind: d.dev ? 'dev' : 'runtime' }));
  const und: Item[] = (m?.undeclared ?? []).map((d: any) => ({ ...d, kind: 'runtime' as const }));
  const crates: Item[] = (m?.crates ?? []).map((d: any) => ({ ...d, kind: 'rust' as const }));
  return [...npm, ...und, ...crates];
}

/** 已装记录的键：包名（不含版本）—— 同一包装一次就够，重复没意义。 */
function keyOf(name: string, version: string) {
  return `${name}@${version || ''}`;
}

export default function DepsCard() {
  const ctx = useNexus();
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [installed, setInstalled] = useState<any[]>([]);
  const [rtMissing, setRtMissing] = useState(false);
  const [busy, setBusy] = useState<string>('');
  const [msg, setMsg] = useState<{ k: string; text: string; bad: boolean } | null>(null);

  const all = useMemo(itemsOf, []);
  const m: any = DEPS_MANIFEST;

  const refresh = useCallback(async () => {
    const r = await listRuntimeDeps(ctx);
    setRtMissing(!!r.missing);
    setInstalled(r.list || []);
  }, [ctx]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const installedOf = useCallback(
    (item: Item) => {
      const spec = specOf(item.install);
      if (!spec) return null;
      if (spec.version) {
        const hit = installed.find((d) => d.name === spec.name && d.version === spec.version);
        if (hit) return hit;
      }
      // 声明为范围（^1.2.3）时按包名匹配 —— 已装的是解析后的具体版本
      return installed.find((d) => d.name === spec.name) || null;
    },
    [installed],
  );

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return all.filter((d) => {
      if (filter === 'issue' && !ISSUE.has(d.status)) return false;
      if (filter === 'runtime' && d.kind !== 'runtime') return false;
      if (filter === 'dev' && d.kind !== 'dev') return false;
      if (filter === 'rust' && d.kind !== 'rust') return false;
      if (!kw) return true;
      return d.name.toLowerCase().includes(kw) || (d.usedBy ?? []).join(',').toLowerCase().includes(kw);
    });
  }, [all, filter, q]);

  const issues = all.filter((d) => ISSUE.has(d.status)).length;

  const copy = useCallback(async (text: string) => {
    const ok = await copyText(ctx, text);
    ctx.toast(ok ? '已复制安装命令' : '复制失败 —— 请手动选中命令后复制', ok ? 'ok' : 'err');
  }, [ctx]);

  const doInstall = useCallback(
    async (item: Item) => {
      const spec = specOf(item.install);
      const k = keyOf(spec?.name || item.name, spec?.version || '');
      setBusy(k);
      setMsg(null);
      const r = await installRuntimeDep(ctx, item);
      if (!r.ok) {
        setMsg({ k, text: r.error || '安装失败', bad: true });
        setBusy('');
        return;
      }
      /*
       * 装完必须真 import 一次。
       * "文件在、import 报错"是最常见的假成功 —— CDN 给的 ESM 里可能带
       * 浏览器不认的语法。不在这里验，用户会在某个插件里才看到报错，
       * 而那时已经不知道是哪一步出的问题。
       */
      try {
        await loadRuntimeDep(ctx, r.name!, r.version!, r.file);
        setMsg({ k, text: '已安装并验证可加载', bad: false });
      } catch (e) {
        setMsg({
          k,
          text: `已下载，但这个包加载不了（可能依赖 node 内建模块）：${String((e as any)?.message || e)}`,
          bad: true,
        });
      }
      await refresh();
      setBusy('');
    },
    [ctx, refresh],
  );

  const doRemove = useCallback(
    async (item: Item) => {
      const spec = specOf(item.install);
      if (!spec) return;
      const k = keyOf(spec.name, spec.version || '');
      setBusy(k);
      const r = await removeRuntimeDep(ctx, spec.name, spec.version || '');
      setMsg(r.ok ? { k, text: '已移除', bad: false } : { k, text: r.error || '移除失败', bad: true });
      await refresh();
      setBusy('');
    },
    [ctx, refresh],
  );

  return (
    <div className="p-card">
      <h2>依赖</h2>
      <div className="p-muted" style={{ marginBottom: 'var(--sp-6, 12px)', lineHeight: 1.9 }}>
        工具里的依赖集中在这里看：package.json 的声明、实际装到的版本、以及**谁在用**。
        <br />
        清单由 <span className="p-mono">npm run deps:scan</span> 生成（<span className="p-mono">js/deps-manifest.js</span>），
        改动依赖后重跑一次即可刷新。
        <br />
        <span style={{ color: 'var(--text-mute)' }}>
          「安装」装的是<strong>运行时依赖</strong>：从 CDN 取单文件存进工具内部，之后由插件动态 import —— 不是改
          package.json（打包产物里没有 npm，改了也不生效）。
        </span>
      </div>

      {m?.dirNote ? (
        <div className="p-muted dep-note" style={{ marginBottom: 'var(--sp-6, 12px)' }}>
          {String(m.dirNote)}
        </div>
      ) : null}

      {rtMissing ? (
        <div className="dep-note" style={{ marginBottom: 'var(--sp-6, 12px)', color: 'var(--warn)' }}>
          后端尚未接入运行时依赖（<span className="p-mono">fpx_rt_dep_install</span>），「安装」暂不可用 ——
          请更新到支持该命令的版本，或复制命令后在源码目录执行。
        </div>
      ) : null}

      {installed.length ? (
        <div className="p-muted dep-note" style={{ marginBottom: 'var(--sp-6, 12px)' }}>
          已装进工具内部：{installed.map((d) => `${d.name}@${d.version}`).join('、')}
        </div>
      ) : null}

      <div className="p-grid" style={{ marginBottom: 'var(--sp-6, 12px)' }}>
        <div className="p-stat"><div className="k">总数</div><div className="v">{all.length}</div></div>
        <div className="p-stat"><div className="k">有问题</div><div className="v">{issues}</div></div>
        <div className="p-stat"><div className="k">npm 包</div><div className="v">{(m?.npm ?? []).length}</div></div>
        <div className="p-stat"><div className="k">Rust crate</div><div className="v">{(m?.crates ?? []).length}</div></div>
      </div>

      <div className="p-row dep-filters" style={{ marginBottom: 'var(--sp-6, 12px)' }}>
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            className={`p-btn sm dep-chip${filter === k ? ' on' : ''}`}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
        <input
          className="p-input sm"
          type="text"
          placeholder="搜包名或插件"
          style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-12, 12px)', padding: '0 10px' }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {!list.length ? (
        <div className="p-muted" style={{ padding: '12px 0' }}>没有匹配的依赖。</div>
      ) : list.map((d) => {
        const st = STATUS[d.status] ?? { label: d.status, tone: 'mute' };
        const showCmd = ISSUE.has(d.status) || d.status === 'missing';
        const spec = specOf(d.install);
        const k = keyOf(spec?.name || d.name, spec?.version || '');
        const hit = installedOf(d);
        const can = canInstall(d);
        const running = busy === k;
        return (
          <div
            key={`${d.kind}:${d.name}`}
            className="dep-item"
            style={{
              padding: '10px 12px', marginTop: 'var(--sp-4, 8px)', borderRadius: 'var(--r-sm)',
              background: 'var(--surface-sunk)',
              boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
            }}
          >
            <div className="p-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="p-mono dep-name">{d.name}</span>
                {d.pinned ? <span className="dep-tag" title="精确锁定的版本">锁定</span> : null}
                <span className="dep-tag">{d.kind === 'rust' ? 'crate' : d.kind === 'dev' ? '开发时' : '运行时'}</span>
                {hit ? <span className="dep-tag ok">已装 {hit.version}</span> : null}
              </div>
              <span className={`dep-badge ${st.tone}`}>{st.label}</span>
            </div>

            <div className="dep-meta">
              声明 {d.declared ?? '—'} · 实装 {d.installed ?? '—'}
              {d.usedBy?.length ? ` · 用于 ${d.usedBy.join('、')}` : ''}
            </div>

            {d.note ? <div className="dep-note">{d.note}</div> : null}

            {msg && msg.k === k ? (
              <div className="dep-note" style={{ color: msg.bad ? 'var(--danger)' : 'var(--ok)' }}>
                {msg.text}
              </div>
            ) : null}

            {showCmd ? (
              <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)' }}>
                <code className="p-mono dep-cmd">{d.install}</code>
                <button className="p-btn sm" onClick={() => copy(d.install)}>复制</button>
              </div>
            ) : null}

            {can ? (
              <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)' }}>
                {hit ? (
                  <button className="p-btn sm" disabled={running} onClick={() => doRemove(d)}>
                    {running ? '移除中…' : '移除'}
                  </button>
                ) : (
                  <button
                    className="p-btn sm primary"
                    disabled={running || rtMissing}
                    onClick={() => doInstall(d)}
                    title={rtMissing ? '后端尚未接入' : '从 CDN 装进工具内部'}
                  >
                    {running ? '安装中…' : '安装'}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
