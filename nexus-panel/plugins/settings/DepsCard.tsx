import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import { DEPS_MANIFEST, DEP_STATUS } from '../../js/deps-manifest.js';
import { copyText } from '../../js/clipboard.js';
import {
  blockReasonOf,
  canInstall,
  consumerNoteOf,
  installRuntimeDep,
  listRuntimeDeps,
  loadRuntimeDep,
  removeRuntimeDep,
  specOf,
  safeFileOf,
  installedVersionsOf,
  staleVersionsOf,
  pinnedVersionOf,
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
  /** 运行时取用方（ctx.requireDep）。空数组 = 装了也没人读。 */
  runtimeUsedBy?: string[];
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
  /* 用户手填的版本（键与 busy/msg 一致）。留空 = 用声明里的版本。 */
  const [ver, setVer] = useState<Record<string, string>>({});

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

  /*
   * 一个包可能装着**多份**（换过声明版本后旧文件仍在），所以这里取全部。
   * 只取第一个的后果见 js/runtime-deps.js 的 installedVersionsOf 注释：
   * 界面显示 A、点移除删掉的是 B，刷新后 A 还在 —— 看着像"移除失效"。
   */
  const installedOf = useCallback(
    (item: Item) => installedVersionsOf(installed, item),
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
    async (item: Item, override?: string) => {
      const spec = specOf(item.install);
      const k = keyOf(spec?.name || item.name, spec?.version || '');
      setBusy(k);
      setMsg(null);
      const r = await installRuntimeDep(ctx, item, { version: override });
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
        setMsg({ k, text: `已安装 ${r.version || '最新版'} 并验证可加载`, bad: false });
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

  /*
   * 移除的是**这一条已装记录**，不是"这个包"。
   *
   * 早先按声明版本拼文件名去删，多版本共存时会出现：
   *   界面显示 12.0.0（排序最小的那份）、点移除却删掉 13.0.0
   *   → 刷新后 12.0.0 还在 → 用户看到"移除失效"
   * 现在直接用后端 list 给的真实文件名，删的就是显示的这一行。
   */
  const doRemove = useCallback(
    async (hit: any) => {
      if (!hit) return;
      const name = String(hit.name || '');
      const k = keyOf(name, hit.version || '');
      setBusy(k);
      const r = await removeRuntimeDep(ctx, name, hit.version || '', hit.file);
      setMsg(
        r.ok
          ? { k, text: `已移除 ${name}@${hit.version || '—'}`, bad: false }
          : { k, text: r.error || '移除失败', bad: true },
      );
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
        const nameKey = spec?.name || d.name;
        const k = keyOf(nameKey, spec?.version || '');
        /*
         * 一个包可能装着**多份**（换过声明版本后旧文件仍在），所以取全部。
         * 只取第一个的下场：显示 A、点移除删掉的是 B，刷新后 A 还在 ——
         * 界面上看就是"移除失效"，而且 B 从此没有任何入口能删。
         */
        const hits = installedOf(d);
        const staleNames = new Set(staleVersionsOf(installed, d).map((x) => String(x.version)));
        /** 是否已有与声明一致的那份 —— 没有才显示「安装」。 */
        const hasExact = hits.some((h) => !staleNames.has(String(h.version)));
        const can = canInstall(d);
        /*
         * 不能装时**必须把理由写出来**，不能只是不显示按钮 ——
         * 静默无按钮会被当成"功能没做完"，而真相是"装了会出事"。
         * 只显示被 RT_BLOCKED 拦下的那类（第二份 react 实例、宿主契约包等）：
         * rust / 开发时那两类，标签上已经写了 crate / 开发时，不必重复。
         */
        const why = can ? '' : d.kind === 'runtime' && !d.dev ? blockReasonOf(d) || '' : '';
        /*
         * 能装、但装了没人取用的，必须提前说清楚。
         * 不说的话：用户点了「安装」、看到"已安装并验证可加载"，
         * 而渲染行为一点没变 —— 这种"装成功但没效果"不报错也不红，
         * 只会让人以为功能还没做完。
         */
        const noUse = can ? consumerNoteOf(d) : null;
        const rtUsers = (d.runtimeUsedBy ?? []).filter(Boolean);
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
                {hits.length === 1 ? (
                  <span className="dep-tag ok">已装 {hits[0].version}</span>
                ) : hits.length > 1 ? (
                  <span className="dep-tag warn">已装 {hits.length} 个版本</span>
                ) : null}
              </div>
              <span className={`dep-badge ${st.tone}`}>{st.label}</span>
            </div>

            <div className="dep-meta">
              声明 {d.declared ?? '—'} · 实装 {d.installed ?? '—'}
              {d.usedBy?.length ? ` · 用于 ${d.usedBy.join('、')}` : ''}
            </div>

            {d.note ? <div className="dep-note">{d.note}</div> : null}

            {msg && (msg.k === k || msg.k.startsWith(`${nameKey}@`)) ? (
              <div className="dep-note" style={{ color: msg.bad ? 'var(--danger)' : 'var(--ok)' }}>
                {msg.text}
              </div>
            ) : null}

            {why ? <div className="dep-note dep-blocked">不适合运行时安装 —— {why}</div> : null}

            {noUse ? <div className="dep-note">{noUse}</div> : null}

            {can && !hasExact && rtUsers.length ? (
              <div className="dep-note">装了会被 {rtUsers.join('、')} 取用（优先用装的那份，加载失败自动回退打包版）</div>
            ) : null}

            {/*
             * 已装的每一份都单独列一行、单独可删。
             * 合并成一个「移除」按钮的话，删的是哪一份在界面上无从判断 ——
             * 多版本共存时必然出现"删了没显示的那份、显示的还在"。
             */}
            {hits.length ? (
              <div className="dep-installed">
                {hits.map((h: any) => {
                  const hk = keyOf(h.name || nameKey, h.version || '');
                  const runningThis = busy === hk;
                  const isStale = staleNames.has(String(h.version));
                  return (
                    <div key={hk} className="dep-inst-row">
                      <span className="p-mono dep-inst-ver">{h.version || '—'}</span>
                      {isStale ? (
                        <span className="dep-tag warn" title="声明版本已变，这份是残留的旧文件">与声明不符</span>
                      ) : (
                        <span className="dep-tag ok">已装</span>
                      )}
                      {h.size ? <span className="dep-meta">{Math.max(1, Math.round(h.size / 1024))} KB</span> : null}
                      <button className="p-btn sm" disabled={runningThis} onClick={() => doRemove(h)}>
                        {runningThis ? '移除中…' : '移除'}
                      </button>
                    </div>
                  );
                })}
                {/*
                 * 多份并存是**刻意的**：装新版本不会替你删旧版本。
                 * 留哪个由你决定 —— 想删哪份就点那一行右边的「移除」。
                 * 这句话必须写出来：不说明的话，用户看到两份会以为
                 * "安装没覆盖干净"，而去反复重装（重装同名同版本只会覆盖
                 * 同一份，旧的那份永远不会被清掉）。
                 */}
                {hits.length > 1 ? (
                  <div className="dep-note">
                    装新版本<strong>不会</strong>替你删旧版本 —— 上面每一份都独立保留，留哪个由你决定，
                    想删就点那一行右边的「移除」（不影响构建产物里自带的那份）。
                  </div>
                ) : null}
                {staleNames.size ? (
                  <div className="dep-note">
                    「与声明不符」的是声明版本变动后留下的旧文件，同样只在你说删时才删。
                  </div>
                ) : null}
              </div>
            ) : null}

            {showCmd ? (
              <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)' }}>
                <code className="p-mono dep-cmd">{d.install}</code>
                <button className="p-btn sm" onClick={() => copy(d.install)}>复制</button>
              </div>
            ) : null}

            {can && !hasExact ? (
              <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)' }}>
                {/*
                 * 版本框：默认填声明里归一化后的具体版本（^12.0.0 → 12.0.0），
                 * 用户可以改。
                 *
                 * 【为什么要能改】
                 * 装哪个版本也是"用户说了算"—— 与多版本共存时"留哪个"是同一个
                 * 取舍。后台替他挑，界面上看不出挑了什么。
                 *
                 * 【为什么默认填剥掉 ^ 的具体版本，而不是原样带 ^】
                 * 实测：https://cdn.jsdelivr.net/npm/mermaid@^12.0.0/+esm → 502，
                 *       https://cdn.jsdelivr.net/npm/mermaid@12.0.0/+esm  → 200
                 * 带 ^ 的地址根本取不到东西。而 URL、落盘文件名、列表里显示的
                 * 版本必须指同一个版本，否则会出现"显示 12.0.0、实际装了 12.3.0"。
                 */}
                <input
                  className="p-input dep-ver"
                  style={{ width: '108px', fontSize: 'var(--fs-12, 12px)', padding: '0 8px' }}
                  value={ver[k] ?? (spec ? pinnedVersionOf(spec.version).version : '')}
                  placeholder={spec ? pinnedVersionOf(spec.version).version || '最新' : '版本'}
                  onChange={(e) => setVer({ ...ver, [k]: e.target.value })}
                  title="要装的具体版本号，留空用声明里的版本"
                />
                <button
                  className="p-btn sm primary"
                  disabled={running || rtMissing}
                  onClick={() => doInstall(d, ver[k])}
                  title={rtMissing ? '后端尚未接入' : '从 CDN 装进工具内部'}
                >
                  {running ? '安装中…' : '安装'}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
