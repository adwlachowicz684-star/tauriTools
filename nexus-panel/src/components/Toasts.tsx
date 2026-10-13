export interface ToastItem {
  /** nextId() 生成的唯一 ID（crypto.randomUUID 或降级串） */
  id: string;
  msg: string;
  type: 'info' | 'ok' | 'err';
}

export default function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div id="toasts">
      {items.map((t) => (
        /*
         * 与原生壳（js/shell.js 的 toast）挂**同一组类名**：
         * `nx-toast toast` + 状态类。只挂 `.toast` 的话，两个壳就不是
         * 同一套东西了 —— 一旦有人按"遗留名"把 `.toast` 那半清理掉，
         * React 壳的提示条会整条失去底板/圆角/动画（原生壳却没事），
         * 变成叠在插件内容上的裸文字。样式两边共用，类名就该两边一致。
         */
        <div
          key={t.id}
          className={'nx-toast toast' + (t.type === 'info' ? '' : ' ' + t.type)}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
