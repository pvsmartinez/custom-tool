import { useState } from 'react';
import {
  FolderSimple, GlobeSimple, FileText, PaintBrush, FilePdf,
  Image, FilmStrip, SpeakerSimpleHigh, FileCode, Paperclip,
  ArrowClockwise, ArrowsClockwise,
} from '@phosphor-icons/react';
import type { FileTreeNode } from '../../types';
import { getFileTypeInfo } from '../../utils/fileType';

// File kinds that can be previewed on mobile
const PREVIEWABLE_KINDS = new Set(['markdown', 'pdf', 'image', 'video', 'canvas', 'html', 'code']);

function FileIcon({ name, isDir }: { name: string; isDir: boolean }) {
  const sz = 16;
  const w = 'thin' as const;
  if (isDir) return <FolderSimple weight={w} size={sz} />;
  const info = getFileTypeInfo(name);
  switch (info.kind) {
    case 'markdown': return <FileText    weight={w} size={sz} />;
    case 'canvas':   return <PaintBrush  weight={w} size={sz} />;
    case 'pdf':      return <FilePdf     weight={w} size={sz} />;
    case 'image':    return <Image       weight={w} size={sz} />;
    case 'video':    return <FilmStrip   weight={w} size={sz} />;
    case 'audio':    return <SpeakerSimpleHigh weight={w} size={sz} />;
    case 'html':     return <GlobeSimple weight={w} size={sz} />;
    case 'code':     return <FileCode    weight={w} size={sz} />;
    default:         return <Paperclip   weight={w} size={sz} />;
  }
}

function isPreviewable(name: string): boolean {
  return PREVIEWABLE_KINDS.has(getFileTypeInfo(name).kind);
}

interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  selectedPath?: string;
  onSelect: (path: string) => void;
}

function TreeNode({ node, depth, selectedPath, onSelect }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.isDirectory) {
    // Folder that contains an index.html → treat as a renderable webpage
    const webpageChild = node.children?.find(c => c.name === 'index.html');
    if (webpageChild) {
      const selected = webpageChild.path === selectedPath;
      return (
        <div
          className={`mb-filenode file previewable ${selected ? 'selected' : ''}`}
          style={{ paddingLeft: `${16 + depth * 18}px` }}
          onClick={() => onSelect(webpageChild.path)}
        >
          <span className="mb-filenode-chevron" />
          <span className="mb-filenode-icon"><GlobeSimple weight="thin" size={16} /></span>
          <span className="mb-filenode-name">{node.name}</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, letterSpacing: '0.3px', textTransform: 'uppercase' }}>webpage</span>
        </div>
      );
    }

    return (
      <>
        <div
          className="mb-filenode dir"
          style={{ paddingLeft: `${16 + depth * 18}px` }}
          onClick={() => setExpanded(v => !v)}
        >
          <span className="mb-filenode-chevron">{expanded ? '▾' : '▸'}</span>
          <span className="mb-filenode-icon"><FolderSimple weight="thin" size={16} /></span>
          <span className="mb-filenode-name">{node.name}</span>
        </div>
        {expanded && node.children?.map(child => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </>
    );
  }

  const previewa = isPreviewable(node.name);
  const selected = node.path === selectedPath;

  return (
    <div
      className={`mb-filenode file ${previewa ? 'previewable' : ''} ${selected ? 'selected' : ''}`}
      style={{ paddingLeft: `${16 + depth * 18 + 14}px` }}
      onClick={() => previewa && onSelect(node.path)}
    >
      <span className="mb-filenode-icon"><FileIcon name={node.name} isDir={false} /></span>
      <span className="mb-filenode-name">{node.name}</span>
    </div>
  );
}

interface MobileFileBrowserProps {
  workspaceName: string;
  fileTree: FileTreeNode[];
  selectedPath?: string;
  onFileSelect: (path: string) => void;
  onRefresh: () => void;
  /** Called when the user taps the Sync button. Only shown when hasGit is true. */
  onSync?: () => void;
  /** True while a sync operation is in progress. */
  isSyncing?: boolean;
  /** Whether the workspace has a git remote. Hides the sync button when false. */
  hasGit?: boolean;
}

export default function MobileFileBrowser({
  workspaceName,
  fileTree,
  selectedPath,
  onFileSelect,
  onRefresh,
  onSync,
  isSyncing,
  hasGit,
}: MobileFileBrowserProps) {
  return (
    <>
      <div className="mb-header">
        <span className="mb-filenode-icon" style={{ display: 'flex', color: 'var(--text-muted)' }}>
          <FolderSimple weight="thin" size={20} />
        </span>
        <span className="mb-header-title">{workspaceName}</span>
        {hasGit && onSync && (
          <button
            className="mb-icon-btn"
            onClick={onSync}
            disabled={isSyncing}
            title="Sincronizar (pull + push)"
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, padding: '4px 10px', borderRadius: 6 }}
          >
            {isSyncing
              ? <><div className="mb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Sincronizando…</>
              : <><ArrowsClockwise weight="thin" size={16} /> Sync</>
            }
          </button>
        )}
        <button className="mb-icon-btn" onClick={onRefresh} title="Refresh" disabled={isSyncing}>
          <ArrowClockwise weight="thin" size={18} />
        </button>
      </div>

      <div className="mb-filebrowser">
        <div className="mb-filebrowser-scroll">
          {fileTree.length === 0 ? (
            <div className="mb-empty" style={{ padding: '48px 24px' }}>
              <div className="mb-empty-icon"><FolderSimple weight="thin" size={48} /></div>
              <div className="mb-empty-desc">Nenhum arquivo neste workspace.</div>
            </div>
          ) : (
            fileTree.map(node => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                onSelect={onFileSelect}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}
