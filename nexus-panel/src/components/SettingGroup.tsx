import { useState, type ReactNode } from 'react';

/**
 * 可折叠的设置分组。
 *
 * 存在理由：设置项一多，一屏放不下，只能往下一直滚 —— 滚到下面连
 * "自己在改哪个插件"都看不出来（标题已经滚出可视区）。
 *
 * 收起态每组只占一行，十几个设置项也只占十来行；展开哪组交给用户决定。
 *
 * 两个刻意的选择：
 *
 *   · **默认收起**（调用方可指定某组默认展开）。默认全展开就失去意义了；
 *     但第一组默认开，否则初次进来是一屏光秃秃的标题行，会以为没内容。
 *
 *   · **用 <button> 而不是 div + onClick**。键盘可达、自带 role，
 *     不写 onClick 在 div 上（那要补 role/tabIndex/onKeyDown 三件套，
 *     漏一件就是"鼠标能点、键盘点不了"）。
 *
 * `aria-expanded` 必须跟着状态走 —— 屏幕阅读器靠它判断展开与否，
 * 写死 true 的话读屏用户会以为内容一直在，而实际上收起时 children 没渲染。
 */
export default function SettingGroup({
  title, badge, hint, defaultOpen = false, children,
}: {
  title: string;
  /** 右侧的小字，通常是个数或状态 */
  badge?: string;
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={'set-group' + (open ? ' open' : '')}>
      <button
        type="button"
        className="set-group-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="set-group-caret" aria-hidden>▸</span>
        <span className="set-group-title">{title}</span>
        {badge ? <span className="set-group-badge">{badge}</span> : null}
      </button>
      {open ? (
        <div className="set-group-body">
          {hint ? <div className="set-group-hint p-muted">{hint}</div> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}
