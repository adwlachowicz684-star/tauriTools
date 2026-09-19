import { useState } from 'react';

/**
 * 发送前确认框（#43）。
 *
 * 面板入口与「侧边栏 / 快捷键」入口**共用这一个** —— 两个入口都会发出指令，
 * 各自写一个确认框的话，改一处忘一处就会出现"从侧边栏发不用确认"的漏洞。
 *
 * 两个细节：
 *
 * 1. **文本可编辑**：确认的意义在于"发出去之前最后看一眼、并能改"。
 *    只读的话，用户发现措辞不对只能取消重来。
 * 2. **「本次不再提示」是会话级**（见 utils/confirmOnce.ts）：
 *    不写进 config。写进去的话，用户勾一次就永久关掉，
 *    等哪天误发一条时，根本想不起来是在这里关的。
 */
export function ChainConfirmDialog({
  actionName, clientName, text, busy, onCancel, onConfirm,
}: {
  actionName: string;
  clientName: string;
  /** 将要发出的指令全文（占位符已替换） */
  text: string;
  busy: boolean;
  onCancel: () => void;
  /** finalText 为编辑后的最终文本；skip 为"本次不再提示" */
  onConfirm: (finalText: string, skip: boolean) => void;
}) {
  const [draft, setDraft] = useState(text);
  const [skip, setSkip] = useState(false);

  return (
    <div className="mask" style={{ zIndex: 1001 }} onMouseDown={onCancel}>
      <div
        className="dialog p-card"
        style={{ width: 620 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 4px' }}>确认发送</h2>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-6, 12px)' }}>
          动作「{actionName}」→ 客户端「{clientName}」。
          下面是即将发出的指令全文，可直接修改。
        </div>
        <textarea
          className="p-input fpx-confirm-text"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        <label className="p-row fpx-confirm-skip">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          <span>本次运行期间不再提示</span>
        </label>
        <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-8, 16px)' }}>
          <button className="p-btn" onClick={onCancel}>取消</button>
          <button
            className="p-btn primary"
            disabled={busy || !draft.trim()}
            onClick={() => onConfirm(draft, skip)}
          >
            {busy ? '发送中…' : '确认发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
