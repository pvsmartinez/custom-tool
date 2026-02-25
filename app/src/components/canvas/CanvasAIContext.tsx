/**
 * React context that bridges the CanvasEditor host with overlay components
 * rendered inside the tldraw tree via InFrontOfTheCanvas.
 *
 * All overlay components (CanvasAIMarkOverlay etc.) read from this context
 * instead of accepting props directly, because InFrontOfTheCanvas does not
 * support arbitrary prop forwarding.
 */
import { createContext } from 'react';
import type { AIEditMark } from '../../types';

export interface CanvasAICtxValue {
  aiMarks: AIEditMark[];
  aiHighlight: boolean;
  aiNavIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onReview: (id: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
export const CanvasAICtx = createContext<CanvasAICtxValue>({
  aiMarks: [],
  aiHighlight: false,
  aiNavIndex: 0,
  onPrev: () => {},
  onNext: () => {},
  onReview: () => {},
});
