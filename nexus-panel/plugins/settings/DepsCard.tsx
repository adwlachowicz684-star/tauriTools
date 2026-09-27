import { useCallback, useMemo, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import { DEPS_MANIFEST, DEP_STATUS } from '../../js/deps-manifest.js';
import { copyText } from '../../js/clipboard.js';

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

export default function DepsCard() {
  const ctx = useNexus();
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');

  const all = useMemo(itemsOf, []);
  const m: any = DEPS_MANIFEST;

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
          一键从远端安装尚未接入：目前给的是可直接执行的安装命令，复制后在源码目录跑即可。
        </span>
      </div>

      {m?.dirNote ? (
        <div className="p-muted dep-note" style={{ marginBottom: 'var(--sp-6, 12px)' }}>
          {String(m.dirNote)}
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
              </div>
              <span className={`dep-badge ${st.tone}`}>{st.label}</span>
            </div>

            <div className="dep-meta">
              声明 {d.declared ?? '—'} · 实装 {d.installed ?? '—'}
              {d.usedBy?.length ? ` · 用于 ${d.usedBy.join('、')}` : ''}
            </div>

            {d.note ? <div className="dep-note">{d.note}</div> : null}

            {showCmd ? (
              <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)' }}>
                <code className="p-mono dep-cmd">{d.install}</code>
                <button className="p-btn sm" onClick={() => copy(d.install)}>复制</button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
