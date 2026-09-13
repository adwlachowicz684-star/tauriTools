export interface ToastItem {
  id: number;
  msg: string;
  type: 'info' | 'ok' | 'err';
}

export default function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div id="toasts">
      {items.map((t) => (
        <div key={t.id} className={'toast ' + (t.type === 'info' ? '' : t.type)}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
