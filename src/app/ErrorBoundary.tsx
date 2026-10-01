// Error boundary: a crash inside one tab (or one region) shows a calm error card there instead of a blank app;
// the top bar, the other tabs and the user's project stay usable. "Try again" re-mounts the content; the details
// can be copied for a bug report. `resetKey` re-mounts automatically when it changes (another tab, another
// project). The project data is never touched: errors in views cannot lose work.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../ui/common/Button';
import { Icon } from '../ui/common/Icon';

export interface ErrorBoundaryProps {
  /** What failed, for the message: "the Chart tab". */
  where: string;
  children: ReactNode;
  /** When this changes, a shown error is cleared and the children mount again. */
  resetKey?: unknown;
  /** Called once per caught error (logging). */
  onError?(error: unknown, info: ErrorInfo): void;
}

interface State {
  error: unknown;
  resetKey: unknown;
  copied: boolean;
}

function describe(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: 'Error', message: String(error) };
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, resetKey: undefined, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // `null`/`undefined` thrown is still an error.
    return { error: error ?? new Error('Unknown error'), copied: false };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null, copied: false };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private retry = () => this.setState({ error: null, copied: false });

  private copy = async () => {
    const d = describe(this.state.error);
    const text = `${d.name}: ${d.message}\n\n${d.stack ?? ''}\n\nWhere: ${this.props.where}\nURL: ${typeof location === 'undefined' ? '' : location.href}`;
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
    } catch {
      // The clipboard can be refused; the details are on screen anyway.
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const d = describe(this.state.error);
    return (
      <div className="shell-error" role="alert">
        <div className="shell-error__card">
          <span className="shell-error__icon">
            <Icon name="warning" size={24} />
          </span>
          <h2 className="shell-error__title">Something went wrong in {this.props.where}</h2>
          <p className="shell-error__text">Your project is safe — this only affects what is shown here. Try again, or switch to another tab.</p>
          <details className="shell-error__details">
            <summary>Technical details</summary>
            <pre>
              {d.name}: {d.message}
            </pre>
          </details>
          <div className="shell-error__actions">
            <Button variant="primary" icon="refresh" onClick={this.retry}>
              Try again
            </Button>
            <Button variant="ghost" icon={this.state.copied ? 'check' : 'copy'} onClick={() => void this.copy()}>
              {this.state.copied ? 'Copied' : 'Copy details'}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
