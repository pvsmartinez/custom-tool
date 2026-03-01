import { ArrowClockwise, Snowflake } from '@phosphor-icons/react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { DeviceFlowState } from '../../services/copilot';

// ── Auth screen ───────────────────────────────────────────────────────────────
interface AIAuthScreenProps {
  authStatus: 'unauthenticated' | 'connecting';
  deviceFlow: DeviceFlowState | null;
  error: string | null;
  style?: React.CSSProperties;
  onSignIn: () => void;
}

export function AIAuthScreen({ authStatus, deviceFlow, error, style, onSignIn }: AIAuthScreenProps) {
  return (
    <div className="ai-panel" data-panel="ai" style={style}>
      <div className="ai-panel-header">
        <span className="ai-panel-title"><Snowflake weight="thin" size={14} /> Copilot</span>
      </div>
      <div className="ai-auth-screen">
        <div className="ai-auth-icon"><Snowflake weight="thin" size={48} /></div>
        <div className="ai-auth-title">Connect GitHub Copilot</div>
        {!deviceFlow ? (
          <>
            <p className="ai-auth-desc">
              Sign in with GitHub to use Copilot in this app.
              {error && <><br /><span className="ai-auth-error">{error}</span></>}
            </p>
            <button
              className="ai-auth-btn"
              onClick={onSignIn}
              disabled={authStatus === 'connecting'}
            >
              {authStatus === 'connecting' ? 'Starting…' : 'Sign in with GitHub'}
            </button>
          </>
        ) : (
          <>
            <p className="ai-auth-desc">Open the link below and enter your code:</p>
            <code className="ai-auth-code">{deviceFlow.userCode}</code>
            <button
              className="ai-auth-btn ai-auth-btn--link"
              onClick={() =>
                openUrl(deviceFlow.verificationUri).catch(() =>
                  window.open(deviceFlow.verificationUri, '_blank'),
                )
              }
            >
              Open github.com/login/device ↗
            </button>
            <p className="ai-auth-waiting">
              <ArrowClockwise weight="thin" size={13} /> Waiting for authorization…
            </p>
          </>
        )}
      </div>
    </div>
  );
}
