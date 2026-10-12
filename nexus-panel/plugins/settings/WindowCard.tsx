import { useCallback, useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';

/**
 * 关闭窗口时的行为
 * ------------------------------------------------------------
 * 点标题栏 ✕ 是"藏到托盘"还是"真正退出"。
 *
 * 装了托盘之后，✕ 还把进程杀掉就与托盘的存在相矛盾 ——
 * 用户既然能从托盘唤回，说明这个应用是常驻型的。所以默认改成"藏"。
 * 但仍要给想真正退出的用户这个选择。
 *
 * 走 ctx.shell.window 而不是直接写 localStorage：
 * 本页在 Vite 模式下是 iframe，隔离态（opaque origin）下 localStorage
 * 不可用，本地读写都会落空 —— 与 FilesCard 不同（那个走 Rust 命令，
 * 两种挂载模式都能穿透），这是**外壳窗口**的状态，必须由外壳持有。
 *
 * 与原生设置页（plugins/settings/index.js 的「窗口」分栏）行为一致。
 */
type CloseAction = 'hide' | 'close';

const OPTS: [CloseAction, string, string][] = [
  ['hide', '隐藏到托盘', '窗口消失但程序还在，点托盘图标即可唤回。适合常驻使用。'],
  ['close', '退出程序', '真正结束进程。下次启动要从头加载。'],
];

export default function WindowCard() {
  const ctx = useNexus();
  const [cur, setCur] = useState<CloseAction>('hide');
  const [err, setErr] = useState<string | null>(null);

  const sh: any = (ctx as any)?.shell?.window ?? null;

  useEffect(() => {
    if (!sh) return;
    let alive = true;
    sh.getCloseAction()
      .then((v: string) => { if (alive) setCur(v === 'close' ? 'close' : 'hide'); })
      .catch((e: any) => { if (alive) setErr(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [sh]);

  /*
   * 先本地反映，桥接慢也不显得卡顿 —— 但**失败必须回滚**。
   *
   * 不回滚的后果：选「退出程序」保存失败时，`cur` 已经变成 'close'，
   * 界面把它画成选中，而外壳里生效的仍是「隐藏到托盘」。
   * 用户看着"退出程序"被选中，就会以为点标题栏 ✕ 会结束进程 ——
   * 而实际上程序只是藏起来。这种"界面说 A、实际是 B"不会报错，
   * 只有底部一行小字提了一句，很容易漏看。
   */
  const pick = useCallback(async (v: CloseAction) => {
    const prev = cur;
    setCur(v);
    setErr(null);
    try {
      /*
       * 拿不到外壳接口时**必须报错**，不能 `sh?.` 静默跳过：
       * 那样界面照样把新选项画成选中，而这一次点击什么都没改 ——
       * 点了有反应（高亮跟着走）、其实没生效，是最难发现的一类。
       */
      if (!sh) throw new Error('拿不到外壳窗口接口（隔离态下读不到），这次选择没能保存');
      /*
       * 用落盘版：setCloseAction 只回新值，本地存储写不进去时它也"成功"，
       * 于是下面根本不会回滚 —— 界面画成「退出程序」、✕ 的提示也跟着改，
       * 而磁盘上还是「隐藏到托盘」，重启后悄悄变回去、一句提示都没有。
       */
      const r = await sh.saveCloseAction(v);
      if (r?.saved === false) {
        throw new Error('这次选择没能保存（浏览器存储不可用：隐私模式或隔离态），重启后会回到原来的设置');
      }
    } catch (e: any) {
      setCur(prev); // 回滚：界面只显示真正生效的那个
      setErr(String(e?.message ?? e));
    }
  }, [sh, cur]);

  return (
    <div className="p-card">
      <h2>关闭窗口时</h2>
      <div style={{ marginTop: '6px' }}>
        {OPTS.map(([v, label, desc]) => (
          <div
            key={v}
            onClick={() => pick(v)}
            style={{
              padding: '10px 12px', marginTop: '8px', borderRadius: 'var(--r-sm)',
              cursor: 'pointer',
              background: v === cur ? 'var(--surface-sunk)' : 'transparent',
              boxShadow: v === cur
                ? 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)'
                : 'none',
            }}
          >
            <div style={{ fontSize: '13px', fontWeight: 600 }}>{label}</div>
            <div className="p-muted" style={{ marginTop: '3px', fontSize: '11px', lineHeight: 1.5 }}>
              {desc}
            </div>
          </div>
        ))}
      </div>
      {err ? (
        <div className="p-muted" style={{ marginTop: '8px', fontSize: '11px', color: 'var(--danger)' }}>
          保存失败：{err}
        </div>
      ) : null}
      <div className="p-muted" style={{ marginTop: '10px', fontSize: '11px', lineHeight: 1.6 }}>
        标题栏 ⇲ 按钮随时可以直接藏到托盘，与这里的选择无关。
      </div>
    </div>
  );
}
