import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * 出错时显示的那块区域叫什么（「编辑区」「资源管理器」之类），
   * 拼进标题里让人知道是哪一块挂了，而不是整页。
   */
  label: string;
  /** 记录一处错误：接到已有的错误通知通道上（`reportError`）。 */
  onError?: (message: string) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 一块区域的兜底：子树渲染抛异常时，只把这一块换成一句说明，不牵动整棵界面。
 *
 * React 的错误边界必须是 class，且只接**渲染期**同步抛出的异常——
 * 事件处理器、异步回调里的异常它管不着，那些由各自的 try/catch 收。
 *
 * 必须包在每一块能独立失效的区域外面（编辑区、侧栏、底部面板），
 * 而不是只包在根上：根上的边界一旦触发就是整页换成错误页，等于把白屏换成了错误页，
 * 人还是什么都干不了。分块包住，一块挂了别的照常能用。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 栈打进控制台，方便对着开发工具定位；错误本身交给上层记进通知历史。
    console.error(`[${this.props.label}] 渲染异常：`, error, info.componentStack);
    this.props.onError?.(`${this.props.label}: ${error.message}`);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-notice" role="alert">
        <p className="crash-notice-title">这块出错了 / This section crashed</p>
        <p className="crash-notice-text">{error.message}</p>
        <button
          type="button"
          className="text-button"
          onClick={() => this.setState({ error: null })}
        >
          重试 / Retry
        </button>
      </div>
    );
  }
}
