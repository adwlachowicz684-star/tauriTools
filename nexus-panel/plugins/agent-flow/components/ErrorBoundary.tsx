import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';

/**
 * 渲染出错时的兜底。
 *
 * ================= 为什么必须有这个 =================
 *
 * 曾经：一个触发器节点的数据不合法 → 它的属性面板渲染时抛错 →
 * **整棵 React 树崩掉** —— 表现为「画布整个消失」。
 *
 * 一个节点配错了，不该让整张画布和其余节点跟着不见。
 * 那样连把出错节点删掉的机会都没有，只能重载；
 * 而重载之后，崩之前没来得及保存的东西全丢了。
 *
 * 兜住之后：出错的那一个节点 / 那一块面板显示一行错误，
 * 画布其余部分照常可操作。
 */

type Props = {
  children: ReactNode;
  /** 出错时显示什么。不传则显示默认的一行提示 */
  fallback?: (msg: string) => ReactNode;
  /** 标记是哪一块出的错，进控制台日志 */
  label?: string;
};

type State = { msg: string };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { msg: '' };

  static getDerivedStateFromError(err: unknown): State {
    return { msg: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    /*
     * 完整堆栈只进控制台 —— 界面上放不下，也没人看得懂。
     * 但必须打出来：否则"节点显示渲染出错"却没有线索可查。
     */
    console.error(`[agent-flow] 渲染出错（${this.props.label ?? '未标记'}）`, err, info);
  }

  render() {
    const msg = this.state.msg;
    if (!msg) return this.props.children;
    if (this.props.fallback) return this.props.fallback(msg);
    return (
      <div className="af-crash" title={msg}>
        <span className="af-crash-tag">渲染出错</span>
        <span className="af-crash-msg">{msg}</span>
        {/*
         * 「重试」清空错误态重新渲染。
         * 出错往往是数据不合法，用户在别处改好之后点一下就能恢复，
         * 不必重载整个插件。
         */}
        <button type="button" className="mini" onClick={() => this.setState({ msg: '' })}>
          重试
        </button>
      </div>
    );
  }
}

/**
 * 给节点卡片套一层兜底。
 *
 * 每个节点单独一个边界：某个节点崩了只影响它自己，
 * 其余节点照常显示、照常能拖能删。
 */
export function withCrashGuard<P extends object>(
  Canvas: ComponentType<P>,
  label: string,
): ComponentType<P> {
  function Guarded(props: P) {
    return (
      <ErrorBoundary label={label}>
        <Canvas {...props} />
      </ErrorBoundary>
    );
  }
  return Guarded;
}
