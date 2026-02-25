import { useState } from 'react';
import type { FileTreeNode } from '../../types';
import { getFileTypeInfo } from '../../utils/fileType';

// File kinds that can be previewed on mobile
const PREVIEWABLE_KINDS = new Set(['markdown', 'pdf', 'image', 'video', 'canvas', 'code']);

function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return '📁';
  const info = getFileTypeInfo(name);
  switch (info.kind) {
    case 'markdown': return '📝';
    case 'canvas':   return '🎨';
    case 'pdf':      return '📄';
    case 'image':    return '🖼';
    case 'video':    return '🎬';
    case 'audio':    return '🎵';
    case 'code':     return '📃';
    default:         return '📎';
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
    return (
      <>
        <div
          className="mb-filenode dir"
          style={{ paddingLeft: `${16 + depth * 18}px` }}
          onClick={() => setExpanded(v => !v)}
        >
          <span className="mb-filenode-chevron">{expanded ? '▾' : '▸'}</span>
          <span className="mb-filenode-icon">📁</span>
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
      <span className="mb-filenode-icon">{fileIcon(node.name, false)}</span>
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
}

export default function MobileFileBrowser({
  workspaceName,
  fileTree,
  selectedPath,
  onFileSelect,
  onRefresh,
}: MobileFileBrowserProps) {
  return (
    <>
      <div className="mb-header">
        <span className="mb-filenode-icon" style={{ fontSize: 20 }}>🗂</span>
        <span className="mb-header-title">{workspaceName}</span>
        <button className="mb-icon-btn" onClick={onRefresh} title="Refresh">↻</button>
      </div>

      <div className="mb-filebrowser">
        <div className="mb-filebrowser-scroll">
          {fileTree.length === 0 ? (
            <div className="mb-empty" style={{ padding: '48px 24px' }}>
              <div className="mb-empty-icon">🗂</div>
              <div className="mb-empty-desc">No files in this workspace yet.</div>
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
