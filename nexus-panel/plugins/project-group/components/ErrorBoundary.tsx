import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * #195 全局异常兜底。
 *
 * 没有它的时候，任何一个组件在渲染中抛错，React 会**卸载整棵树** ——
 * 界面变成一片空白，用户既看不到错误原因，也没有任何可操作的出口，
 * 只能关掉重开；而重开往往还是同一个错误（错误状态还在磁盘上）。
 *
 * 原版那三条（连续异常超限不再吞 / 后台线程只记日志 / 未观察 Task 标记已观察）
 * 是 WPF 的机制，在本项目里对应的是：
 *   · 渲染异常**不再吞** —— 显示出来，而不是留一片白
 *   · 非渲染路径的异常仍只记日志，不弹窗打断操作
 * 后端 Rust 侧**不适用**：panic 默认就会终止线程，没有"吞掉继续跑"这回事。
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { err: Error | null }
> {
  state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    /* 只记日志：这里不是渲染路径，抛出去也没有人能处理 */
    console.error('[project-group] 渲染异常：', err, info.componentStack);
  }

  render(): ReactNode {
    const err = this.state.err;
    if (!err) return this.props.children;
    return (
      <div className="fpx-crash">
        <div className="fpx-crash-title">
          {this.props.label ?? '界面'}出错了
        </div>
        <pre className="fpx-crash-msg">{err.message || String(err)}</pre>
        {/*
          「重试」按钮是必须的：错误状态多半在磁盘配置里，
          只显示错误而不给出口，用户除了关掉重开别无他法 ——
          而重开往往还是同一个错误。
        */}
        <button
          className="p-btn"
          onClick={() => this.setState({ err: null })}
        >
          重试
        </button>
      </div>
    );
  }
}
