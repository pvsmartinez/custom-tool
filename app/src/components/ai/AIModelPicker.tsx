import { useState, useRef, useEffect } from 'react';
import type { CopilotModel, CopilotModelInfo } from '../../types';

// ── Rate badge ────────────────────────────────────────────────────────────────
// Shows billing tier: free (0×), standard (1×), premium (N×)
export function MultiplierBadge({ value }: { value: number }) {
  if (value === 0) return <span className="ai-rate-badge ai-rate-free">free</span>;
  if (value <= 1)  return <span className="ai-rate-badge ai-rate-standard">1×</span>;
  return <span className="ai-rate-badge ai-rate-premium">{value}×</span>;
}

// ── Model picker dropdown ─────────────────────────────────────────────────────
interface ModelPickerProps {
  models: CopilotModelInfo[];
  value: CopilotModel;
  onChange: (id: CopilotModel) => void;
  loading: boolean;
  onSignOut?: () => void;
}

export function ModelPicker({ models, value, onChange, loading, onSignOut }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Keep a ref in sync so the stable listener always sees the latest value
  // without needing to re-register on every open/close toggle.
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (!openRef.current) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // registers once on mount — openRef always tracks current value

  const current = models.find((m) => m.id === value) ?? { id: value, name: value, multiplier: 1, isPremium: false };

  const free     = models.filter((m) => m.multiplier === 0);
  const standard = models.filter((m) => m.multiplier > 0 && m.multiplier <= 1);
  const premium  = models.filter((m) => m.multiplier > 1);
  // Only show group labels when 2+ groups are non-empty
  const nonEmptyGroups = [free, standard, premium].filter((g) => g.length > 0).length;
  const showLabels = nonEmptyGroups > 1;

  function renderGroup(label: string, items: CopilotModelInfo[]) {
    if (items.length === 0) return null;
    return (
      <>
        {showLabels && <div className="ai-model-group-label">{label}</div>}
        {items.map((m) => (
          <button
            key={m.id}
            className={`ai-model-option ${m.id === value ? 'selected' : ''}`}
            onClick={() => { onChange(m.id); setOpen(false); }}
          >
            <span className="ai-model-option-name">
              {m.name}
              {m.vendor && <span className="ai-model-option-vendor">{m.vendor}</span>}
            </span>
            <MultiplierBadge value={m.multiplier} />
          </button>
        ))}
      </>
    );
  }

  return (
    <div className="ai-model-picker" ref={ref}>
      <button
        className="ai-model-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Switch model"
        disabled={loading}
      >
        <span className="ai-model-trigger-name">{loading ? '…' : current.name}</span>
        <MultiplierBadge value={current.multiplier} />
        <span className="ai-model-trigger-caret">▾</span>
      </button>

      {open && (
        <div className="ai-model-menu">
          {renderGroup('Free', free)}
          {renderGroup('Standard', standard)}
          {renderGroup('Premium', premium)}
          {onSignOut && (
            <>
              <div className="ai-model-menu-divider" />
              <button
                className="ai-model-signout-btn"
                onClick={() => { setOpen(false); onSignOut(); }}
              >
                Sign out
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
