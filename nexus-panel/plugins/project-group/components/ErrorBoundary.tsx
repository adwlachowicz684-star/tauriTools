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
  { err: Error | null; repeat: boolean }
> {
  state: { err: Error | null; repeat: boolean } = { err: null, repeat: false };

  /** 上一次出错是不是紧跟在「重试」之后 —— 见 retry() 的说明 */
  private justRetried = false;

  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    /* 只记日志：这里不是渲染路径，抛出去也没有人能处理 */
    console.error('[project-group] 渲染异常：', err, info.componentStack);
    /*
     * 重试后**立刻又错**，必须说出来。
     *
     * 重试的语义是「把子树重新挂一遍」：它只对**子组件内部的一次性坏状态**
     * 有效（重新挂载会重置那些 state）。而错误多半来自喂进来的数据
     * （配置 / 后端快照），重挂一遍拿到的是同一份数据，于是再错一次。
     *
     * 不说出来时用户看到的是：点「重试」→ 界面闪一下 → 又回到同一块错误。
     * 这个表现与「按钮坏了」完全无法区分，他会连点几下然后放弃，
     * 而真正能解决问题的那一步（去改掉坏数据）他根本没被告知存在。
     */
    if (this.justRetried) {
      this.justRetried = false;
      this.setState({ repeat: true });
    }
  }

  /**
   * 「重试」：清掉错误让子树重新挂一次。
   *
   * 不能写成 `this.setState({ err: null })` 就完事 —— 那样重试失败与否
   * 界面长得一模一样，用户无从判断该继续点还是该去查数据。
   */
  retry(): void {
    this.justRetried = true;
    this.setState({ err: null, repeat: false });
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
          重试仍然失败时说明不是一次性的坏状态，而是数据本身有问题
          （多半在磁盘配置里）。这时必须把"再点也没用"讲明白，
          否则用户会把"重试失败"误读成"按钮失灵"，一直点下去。
        */}
        {this.state.repeat && (
          <div className="fpx-crash-hint">
            重试后仍然出错：多半是配置里的数据有问题，重挂界面解决不了 ——
            可去插件设置页改动相关项（或恢复默认）后再回来重试。
          </div>
        )}
        {/*
          「重试」按钮是必须的：错误状态多半在磁盘配置里，
          只显示错误而不给出口，用户除了关掉重开别无他法 ——
          而重开往往还是同一个错误。
        */}
        <button
          className="p-btn"
          onClick={() => this.retry()}
        >
          重试
        </button>
      </div>
    );
  }
}
