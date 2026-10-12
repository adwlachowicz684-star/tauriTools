import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNexus } from '../../../src/nexus-react';
import { listDirs, listQuickRoots, listFsRoots, type DirEntryLite } from '../lib/tauri';
import { withinRoots } from '../engine/exportDir';

/**
 * 应用内目录选择器。
 *
 * ================= 为什么不用系统文件对话框 =================
 *
 * 原生对话框要引 tauri-plugin-dialog（改 Cargo.toml、重新编译、过打包），
 * 而这项目里 fpx 模块**已经有**目录浏览能力（fpx_quick_roots / fpx_list_dirs）。
 * 为"选个目录"去动 Rust 依赖，代价与收益不成比例。
 *
 * 而且应用内选择器还有个好处：能把"当前选中的是哪个目录"显示清楚，
 * 系统对话框关掉之后用户就不知道自己选了什么。
 */

type Props = {
  /** 初始目录（通常来自设置） */
  initial?: string;
  title?: string;
  onPick: (dir: string) => void;
  onCancel: () => void;
  /** 同时设为默认目录 */
  onPickAsDefault?: (dir: string) => void;
};

export default function DirPicker({
  initial = '', title = '选择导出目录', onPick, onCancel, onPickAsDefault,
}: Props) {
  /*
   * cwd 与 picked 是两样东西，不能合并成一个：
   *   · cwd    —— 输入框的值，用户随时可以敲一个还打不开的路径
   *   · picked —— 已经成功打开过的目录，才是「选这里」真正交出去的那个
   *
   * 合并的后果（与 project-group/DirDialog 曾犯的同一个洞）：列不出来时只
   * 清 entries 而 cwd 留在上一次的值 → 界面显示的是刚敲的那条路径，交出去
   * 的却是**另一个**目录；反过来若把输入框的值直接交出去，就是一个根本列
   * 不出来的目录。两种情况界面都不报错，而磁盘上真会按它建目录。
   */
  const [cwd, setCwd] = useState(initial);
  const [picked, setPicked] = useState('');
  const [entries, setEntries] = useState<DirEntryLite[]>([]);
  const [roots, setRoots] = useState<DirEntryLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /*
   * 已授权目录 —— fs_op 只写这些目录内的路径。
   * 标出来让用户优先选它们：选了未授权目录会写失败，
   * 而"选的时候看不出来"比失败本身更让人困惑。
   */
  const [authorized, setAuthorized] = useState<string[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /** 授权根是否拉完。委托服务前必须等它 —— 见下方委托的说明。 */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const jobs = [
      listQuickRoots()
        .then((r) => { if (alive.current) setRoots(r); })
        .catch(() => { /* 起点列不出来不影响手动输入 */ }),
      listFsRoots()
        .then((r) => { if (alive.current) setAuthorized(r); })
        .catch(() => { /* 查不到就当全部未授权，不影响使用 */ }),
    ];
    void Promise.allSettled(jobs).then(() => { if (alive.current) setReady(true); });
  }, []);

  const load = useCallback(async (p: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await listDirs(p);
      if (!alive.current) return;
      setEntries(r);
      setCwd(p);
      setPicked(p);
    } catch (e) {
      if (!alive.current) return;
      /*
       * 列不出来**必须**说清楚 ——
       * 最常见的原因是目录不在授权根里（fs_op 的安全收敛），
       * 静默显示空列表会让用户以为"这个文件夹是空的"。
       */
      setErr(`打不开这个目录：${String((e as Error)?.message ?? e)}`);
      setEntries([]);
      /*
       * 没打开就不许选：picked 空了「选这里」会自动变灰（disabled={!picked}），
       * 否则交出去的是一个连列都列不出来的目录。
       * cwd 刻意不动 —— 留着用户刚敲的那条，改一个字符就能重试。
       */
      setPicked('');
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initial) void load(initial);
    else if (roots.length > 0) void load(roots[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, roots.length]);

  /*
   * 委托给全工具统一的 folder-picker 服务（与项目组共用同一份常用文件夹）。
   *
   * 【为什么传 marks / extraAction】
   * 这两样是 agent-flow 特有的语义，不传就等于丢功能：
   *   · marks        —— 「已授权」标记。选了未授权目录会写失败，
   *                     而"选的时候看不出来、写完才报错"比失败本身更让人困惑。
   *   · extraAction  —— 「设为默认」。服务返回 { path, action }，
   *                     action === 'default' 时才同时落默认目录。
   *
   * 【为什么等 ready 才委托】
   * authorized 是异步拉的。不等就委托的话 marks.list 是空数组，
   * 面板里所有目录都显示"未标记"——看着像授权信息丢了，
   * 实际只是委托太早。
   *
   * 【为什么保留下面的旧界面（降级）】
   * 服务条目被同步覆盖掉时，没有兜底就是所有选目录入口同时失灵。
   */
  const [fallback, setFallback] = useState<string | null>(null);
  const delegated = useRef(false);
  const ctx = useNexus();

  useEffect(() => {
    if (!ready) return;
    if (delegated.current) return;   // StrictMode 下 effect 跑两次，不挡会连开两个
    delegated.current = true;
    void (async () => {
      try {
        const ok = await ctx.services.available('folder-picker');
        if (!ok) throw new Error('未找到 folder-picker 服务');
        const r: any = await ctx.services.call('folder-picker', 'pick', {
          title,
          startPath: initial || '',
          allowCreate: true,
          marks: { list: authorized, label: '已授权', hint: '未授权（选中后会自动申请）' },
          extraAction: onPickAsDefault ? { id: 'default', label: '设为默认' } : null,
        });
        if (r?.path) {
          const p = String(r.path);
          if (r.action === 'default' && onPickAsDefault) { onPickAsDefault(p); onPick(p); }
          else onPick(p);
          return;
        }
        onCancel();   // 取消是正常结束，不能弹回旧界面
      } catch (e: any) {
        setFallback(String(e?.message ?? e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // 还在委托中：一个节点都不渲染，否则两套界面叠在一起
  if (fallback === null) return null;

  const up = useMemo(() => {
    /* 优先从已打开的目录往上；还没打开过就退而用输入框那条，失败后也能退回去 */
    const s = String(picked || cwd || '').replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : null;
  }, [cwd, picked]);

  return (
    <div className="dirpicker-mask" onClick={onCancel}>
      <div className="dirpicker" onClick={(e) => e.stopPropagation()}>
        <div className="dirpicker-head">
          <strong>{title}</strong>
          <button className="mini" onClick={onCancel}>取消</button>
        </div>

        <div className="dirpicker-path">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void load(cwd); }}
            placeholder="也可以直接粘贴路径后回车"
          />
          <button className="mini" onClick={() => void load(cwd)} disabled={busy}>
            {busy ? '…' : '打开'}
          </button>
        </div>

        {fallback ? (
          <div className="dirpicker-err">
            ⚠ 统一选择器不可用（{fallback}），已退回内置界面
          </div>
        ) : null}
        {err ? <div className="dirpicker-err">⚠ {err}</div> : null}
        {err && cwd ? (
          /*
           * 不加这句的话：输入框里是自己敲的路径、底部却是「（未选）」、
           * 按钮还灰着，三处各说各的，用户只会以为选择器坏了。
           */
          <div className="dirpicker-err">上方路径尚未打开，已停用「选这里」；改好后点「打开」</div>
        ) : null}

        {roots.length > 0 ? (
          <div className="dirpicker-roots">
            {roots.map((r) => (
              <button
                key={r.path}
                className={`chip${r.path === picked ? ' on' : ''}`}
                onClick={() => void load(r.path)}
              >
                {r.name}
              </button>
            ))}
          </div>
        ) : null}

        <div className="dirpicker-list">
          {up ? (
            <button className="dirpicker-item up" onClick={() => void load(up)}>
              ↩ 上一级
            </button>
          ) : null}
          {entries.length === 0 && !busy && !err ? (
            <div className="dirpicker-empty">这个目录下没有子目录</div>
          ) : null}
          {entries.map((d) => (
            <button
              key={d.path}
              className={`dirpicker-item${withinRoots(d.path, authorized) ? ' ok' : ''}`}
              onClick={() => void load(d.path)}
              onDoubleClick={() => onPick(d.path)}
              title={withinRoots(d.path, authorized) ? '这个目录已授权，可直接写' : '未授权，选中后会自动申请授权'}
            >
              📁 {d.name}
              {withinRoots(d.path, authorized) ? <small className="ok-tag">已授权</small> : null}
              {d.has_child ? <small>▸</small> : null}
            </button>
          ))}
        </div>

        <div className="dirpicker-foot">
          <span className="dirpicker-cur">
            当前：{picked || '（未选）'}
            {picked ? (
              withinRoots(picked, authorized)
                ? ' · 已授权'
                : ' · 未授权（选中后会自动申请）'
            ) : null}
          </span>
          <span className="dirpicker-ops">
            {onPickAsDefault ? (
              <button
                className="mini"
                disabled={!picked}
                onClick={() => { onPickAsDefault(picked); onPick(picked); }}
              >
                设为默认
              </button>
            ) : null}
            <button className="mini primary" disabled={!picked} onClick={() => onPick(picked)}>
              选这里
            </button>
          </span>
        </div>
        <p className="dirpicker-hint">
          双击文件夹可直接选中。标「已授权」的目录可以直接写；未授权的会自动申请，
          申请失败会在日志里说明原因。
        </p>
      </div>
    </div>
  );
}
