import { useState, useRef, useEffect } from 'react';

/**
 * Manages the drag-to-resize behaviour for the sidebar and AI panel.
 * The sidebar resizes from its right edge (delta > 0 = wider).
 * The AI panel resizes from its left edge (delta > 0 = narrower).
 */
export function useDragResize(
  initialSidebarWidth = 220,
  initialAiPanelWidth = 340,
) {
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [aiPanelWidth, setAiPanelWidth] = useState(initialAiPanelWidth);

  const draggingRef = useRef<null | 'sidebar' | 'ai'>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const delta = e.clientX - dragStartX.current;
      if (draggingRef.current === 'sidebar') {
        setSidebarWidth(Math.max(150, Math.min(480, dragStartWidth.current + delta)));
      } else {
        // AI panel resizes from its left edge — dragging left increases width
        setAiPanelWidth(Math.max(260, Math.min(620, dragStartWidth.current - delta)));
      }
    }
    function onMouseUp() {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  function startSidebarDrag(e: React.MouseEvent) {
    draggingRef.current = 'sidebar';
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function startAiDrag(e: React.MouseEvent) {
    draggingRef.current = 'ai';
    dragStartX.current = e.clientX;
    dragStartWidth.current = aiPanelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return { sidebarWidth, aiPanelWidth, startSidebarDrag, startAiDrag };
}
