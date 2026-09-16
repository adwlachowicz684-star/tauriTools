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

  const pick = useCallback(async (v: CloseAction) => {
    setCur(v); // 先本地反映，桥接慢也不显得卡顿
    setErr(null);
    try {
      await sh?.setCloseAction(v);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, [sh]);

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
