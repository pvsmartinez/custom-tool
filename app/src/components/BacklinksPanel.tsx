/**
 * BacklinksPanel — shows backlinks (files that link to this file)
 * and outlinks (files this file links to) for a markdown file.
 *
 * Displayed as a compact collapsible strip at the bottom of the editor area.
 */
import { useState } from 'react';
import type { LinkRef } from '../hooks/useBacklinks';
import './BacklinksPanel.css';

interface BacklinksPanelProps {
  backlinks: LinkRef[];
  outlinks: LinkRef[];
  loading: boolean;
  onOpen: (path: string) => void;
}

export default function BacklinksPanel({ backlinks, outlinks, loading, onOpen }: BacklinksPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const total = backlinks.length + outlinks.length;

  if (loading) return null;
  if (total === 0) return null;

  return (
    <div className={`backlinks-panel${expanded ? ' expanded' : ''}`}>
      <button
        className="backlinks-toggle"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Collapse links' : 'Show backlinks and outlinks'}
      >
        <span className="backlinks-toggle-icon">{expanded ? '⌄' : '⌃'}</span>
        {backlinks.length > 0 && (
          <span className="backlinks-badge backlinks-badge--in" title="Files that link here">
            ← {backlinks.length}
          </span>
        )}
        {outlinks.length > 0 && (
          <span className="backlinks-badge backlinks-badge--out" title="Files this links to">
            → {outlinks.length}
          </span>
        )}
        <span className="backlinks-toggle-label">links</span>
      </button>

      {expanded && (
        <div className="backlinks-body">
          {backlinks.length > 0 && (
            <div className="backlinks-section">
              <div className="backlinks-section-title">← referenced by</div>
              <div className="backlinks-list">
                {backlinks.map((l) => (
                  <button
                    key={l.path}
                    className="backlinks-item"
                    onClick={() => onOpen(l.path)}
                    title={l.path}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {outlinks.length > 0 && (
            <div className="backlinks-section">
              <div className="backlinks-section-title">→ links to</div>
              <div className="backlinks-list">
                {outlinks.map((l) => (
                  <button
                    key={l.path}
                    className="backlinks-item"
                    onClick={() => onOpen(l.path)}
                    title={l.path}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
