/**
 * AIPanel — outer shell with auth, shared models, and multi-agent tab bar.
 * The per-session logic lives in AgentSession.tsx.
 */
import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Snowflake } from '@phosphor-icons/react';

import {
  fetchCopilotModels,
  startDeviceFlow,
  getStoredOAuthToken,
  clearOAuthToken,
} from '../services/copilot';
import type { DeviceFlowState } from '../services/copilot';
import { FALLBACK_MODELS } from '../types';
import type { CopilotModelInfo } from '../types';
import type { Workspace, WorkspaceExportConfig, WorkspaceConfig } from '../types';
import type { Editor as TldrawEditor } from 'tldraw';

import { AIAuthScreen } from './ai/AIAuthScreen';
import AgentSession from './AgentSession';
import type { AgentSessionHandle } from './AgentSession';

import './AIPanel.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AIPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrompt?: string;
  initialModel?: string;
  onModelChange?: (model: string) => void;
  onInsert?: (text: string, model: string) => void;
  documentContext?: string;
  agentContext?: string;
  workspacePath?: string;
  workspace?: Workspace | null;
  canvasEditorRef?: React.RefObject<TldrawEditor | null>;
  onFileWritten?: (path: string) => void;
  onMarkRecorded?: (relPath: string, content: string, model: string) => void;
  onCanvasMarkRecorded?: (relPath: string, shapeIds: string[], model: string) => void;
  activeFile?: string;
  rescanFramesRef?: React.MutableRefObject<(() => void) | null>;
  aiMarks?: import('../types').AIEditMark[];
  aiMarkIndex?: number;
  onAIMarkPrev?: () => void;
  onAIMarkNext?: () => void;
  onAIMarkReview?: (id: string) => void;
  workspaceExportConfig?: WorkspaceExportConfig;
  onExportConfigChange?: (config: WorkspaceExportConfig) => void;
  style?: React.CSSProperties;
  onStreamingChange?: (streaming: boolean) => void;
  screenshotTargetRef?: React.RefObject<HTMLElement | null>;
  webPreviewRef?: React.RefObject<{ getScreenshot: () => Promise<string | null> } | null>;
  getActiveHtml?: () => { html: string; absPath: string } | null;
  workspaceConfig?: WorkspaceConfig;
  onWorkspaceConfigChange?: (patch: Partial<WorkspaceConfig>) => void;
}

export interface AIPanelHandle {
  receiveFinderFiles(paths: string[]): void;
}

type AgentStatus = 'idle' | 'thinking' | 'error';

interface AgentTab {
  id: string;
  label: string;
  status: AgentStatus;
}

// ── Main panel ────────────────────────────────────────────────────────────────

const AIPanel = forwardRef<AIPanelHandle, AIPanelProps>(function AIPanel({
  isOpen,
  onClose,
  initialPrompt,
  initialModel,
  onModelChange,
  onInsert,
  documentContext,
  agentContext,
  workspacePath,
  workspace,
  canvasEditorRef,
  onFileWritten,
  onMarkRecorded,
  onCanvasMarkRecorded,
  activeFile,
  rescanFramesRef,
  aiMarks,
  aiMarkIndex,
  onAIMarkPrev,
  onAIMarkNext,
  onAIMarkReview,
  workspaceExportConfig,
  onExportConfigChange,
  workspaceConfig,
  onWorkspaceConfigChange,
  style,
  onStreamingChange,
  screenshotTargetRef,
  webPreviewRef,
  getActiveHtml,
}, ref) {

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [authStatus, setAuthStatus] = useState<'checking' | 'unauthenticated' | 'connecting' | 'authenticated'>('checking');
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setAuthStatus(getStoredOAuthToken() ? 'authenticated' : 'unauthenticated');
  }, [isOpen]);

  async function handleSignIn() {
    setAuthError(null);
    setAuthStatus('connecting');
    setDeviceFlow(null);
    try {
      await startDeviceFlow((state) => setDeviceFlow(state));
      setAuthStatus('authenticated');
      setDeviceFlow(null);
    } catch (err) {
      setAuthError(String(err));
      setAuthStatus('unauthenticated');
      setDeviceFlow(null);
    }
  }

  function handleSignOut() {
    clearOAuthToken();
    setAuthStatus('unauthenticated');
  }

  // ── Shared models (fetched once, available to all agent tabs) ─────────────
  const [availableModels, setAvailableModels] = useState<CopilotModelInfo[]>(FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelsLoadedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    if (authStatus === 'authenticated') modelsLoadedRef.current = false;
    if (modelsLoadedRef.current) return;
    modelsLoadedRef.current = true;
    setModelsLoading(true);
    fetchCopilotModels()
      .then((models) => { setAvailableModels(models); setModelsLoading(false); })
      .catch(() => setModelsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, authStatus]);

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const [tabs, setTabs] = useState<AgentTab[]>([{ id: 'agent-1', label: 'Agente 1', status: 'idle' }]);
  const [activeTabId, setActiveTabId] = useState('agent-1');

  function addTab() {
    const n = tabs.length + 1;
    const id = `agent-${n}-${Date.now()}`;
    const label = `Agente ${n}`;
    setTabs((prev) => [...prev, { id, label, status: 'idle' }]);
    setActiveTabId(id);
  }

  function closeTab(id: string) {
    if (tabs.length === 1) return;
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) setActiveTabId(next[0].id);
      return next;
    });
  }

  // ── Delegate Finder drop to active agent session ──────────────────────────
  const agentRefs = useRef<Map<string, AgentSessionHandle | null>>(new Map());

  useImperativeHandle(ref, () => ({
    receiveFinderFiles(paths: string[]) {
      agentRefs.current.get(activeTabId)?.receiveFinderFiles(paths);
    },
  }));

  // ── Early returns ─────────────────────────────────────────────────────────
  if (!isOpen) return null;

  if (authStatus === 'unauthenticated' || authStatus === 'connecting') {
    return (
      <AIAuthScreen
        authStatus={authStatus}
        deviceFlow={deviceFlow}
        error={authError}
        style={style}
        onSignIn={handleSignIn}
      />
    );
  }

  if (authStatus === 'checking') return null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="ai-panel" data-panel="ai" style={style}>
      {/* Tab bar */}
      <div className="ai-tab-bar">
        {tabs.map((tab) => (
          <div key={tab.id} className={`ai-tab${activeTabId === tab.id ? ' ai-tab--active' : ''} ai-tab--${tab.status}`}>
            <button
              className="ai-tab-label"
              onClick={() => setActiveTabId(tab.id)}
              title={tab.label}
            >
              <span
                className={`ai-tab-dot ai-tab-dot--${tab.status}`}
                aria-label={tab.status === 'thinking' ? 'a trabalhar' : tab.status === 'error' ? 'erro' : 'pronto'}
              />
              {tab.label}
            </button>
            {tabs.length > 1 && (
              <button
                className="ai-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                title="Fechar agente"
              >
                <Snowflake weight="thin" size={10} />
              </button>
            )}
          </div>
        ))}
        <button className="ai-tab-add" onClick={addTab} title="Novo agente">
          +
        </button>
      </div>

      {/* One AgentSession per tab — all mounted, only active visible */}
      {tabs.map((tab) => (
        <AgentSession
          key={tab.id}
          ref={(el) => { agentRefs.current.set(tab.id, el); }}
          agentId={tab.id}
          agentLabel={tab.label}
          isActive={tab.id === activeTabId}
          onNotAuthenticated={() => setAuthStatus('unauthenticated')}
          onSignOut={handleSignOut}
          availableModels={availableModels}
          modelsLoading={modelsLoading}
          onClose={onClose}
          initialPrompt={initialPrompt}
          initialModel={initialModel}
          onModelChange={onModelChange}
          onInsert={onInsert}
          documentContext={documentContext}
          agentContext={agentContext}
          workspacePath={workspacePath}
          workspace={workspace}
          canvasEditorRef={canvasEditorRef}
          onFileWritten={onFileWritten}
          onMarkRecorded={onMarkRecorded}
          onCanvasMarkRecorded={onCanvasMarkRecorded}
          activeFile={activeFile}
          rescanFramesRef={rescanFramesRef}
          aiMarks={aiMarks}
          aiMarkIndex={aiMarkIndex}
          onAIMarkPrev={onAIMarkPrev}
          onAIMarkNext={onAIMarkNext}
          onAIMarkReview={onAIMarkReview}
          workspaceExportConfig={workspaceExportConfig}
          onExportConfigChange={onExportConfigChange}
          onStreamingChange={onStreamingChange}
          onStatusChange={(status) =>
            setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, status } : t))
          }
          screenshotTargetRef={screenshotTargetRef}
          webPreviewRef={webPreviewRef}
          getActiveHtml={getActiveHtml}
          workspaceConfig={workspaceConfig}
          onWorkspaceConfigChange={onWorkspaceConfigChange}
        />
      ))}
    </div>
  );
});

export default AIPanel;
