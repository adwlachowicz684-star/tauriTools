import { useRef } from 'react';
import {
  GROUP_TITLE, insertAtCursor, placeholdersByGroup, type PlaceholderDef,
} from '../utils/placeholders';

/**
 * 模板编辑框下方的一排占位符插入按钮（#501）。
 *
 * 为什么不做成下拉选择：占位符一共 7 个，全是"点一下插一个"的短操作，
 * 下拉要多点两次；摊平成一排按钮则一眼看全，且能顺带把分组与含义显示出来。
 *
 * 关键在"插到光标处"而不是"追加到末尾" —— 模板是段落文本，
 * 占位符通常要插在句子中间，追加到末尾等于逼用户再去剪切。
 */
export function PlaceholderBar({
  targetRef, value, onChange,
}: {
  /** 要插入的 textarea。必须传 ref，否则拿不到光标位置 */
  targetRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (next: string) => void;
}) {
  /** 插入后要把光标还原到这个位置；见 insertAtCursor 的说明 */
  const caretRef = useRef<number | null>(null);

  const applyCaret = () => {
    const el = targetRef.current;
    const caret = caretRef.current;
    if (!el || caret === null) return;
    caretRef.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  };

  const insert = (p: PlaceholderDef) => {
    const el = targetRef.current;
    const { next, caret } = insertAtCursor(
      value,
      el?.selectionStart ?? null,
      el?.selectionEnd ?? null,
      p.token,
    );
    caretRef.current = caret;
    onChange(next);
    /* 受控组件：onChange 之后 DOM 里的值还没更新，
       要等这一帧提交完再设光标，否则 setSelectionRange 会被随后的重渲染冲掉。
       用 rAF 而不是 setTimeout(0)：后者在标签页后台时会被节流到秒级，
       连续插入会明显卡顿。 */
    requestAnimationFrame(applyCaret);
  };

  return (
    <div className="fpx-ph-bar">
      {placeholdersByGroup().map(({ group, items }) => (
        <div className="fpx-ph-group" key={group}>
          <span className="fpx-ph-group-title">{GROUP_TITLE[group]}</span>
          {items.map((p) => (
            <button
              key={p.token}
              type="button"
              className="p-btn fpx-ph-btn"
              title={`${p.token} —— ${p.hint}（插入到光标处）`}
              onClick={() => insert(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
