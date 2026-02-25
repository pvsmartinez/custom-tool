import { describe, it, expect, vi } from 'vitest';
import { mapColor, mapFill, executeCanvasCommands } from '../utils/canvasAI';
import type { Editor } from 'tldraw';

// ── mapColor ──────────────────────────────────────────────────────────────────
describe('mapColor', () => {
  it('passes through recognised color names', () => {
    expect(mapColor('yellow')).toBe('yellow');
    expect(mapColor('blue')).toBe('blue');
    expect(mapColor('green')).toBe('green');
    expect(mapColor('red')).toBe('red');
    expect(mapColor('orange')).toBe('orange');
    expect(mapColor('grey')).toBe('grey');
    expect(mapColor('gray')).toBe('grey');
    expect(mapColor('white')).toBe('white');
    expect(mapColor('black')).toBe('black');
  });

  it('maps aliases to canonical tldraw color names', () => {
    expect(mapColor('purple')).toBe('violet');
    expect(mapColor('lavender')).toBe('light-violet');
    expect(mapColor('pink')).toBe('light-red');
    expect(mapColor('teal')).toBe('light-blue');
  });

  it('is case-insensitive', () => {
    expect(mapColor('YELLOW')).toBe('yellow');
    expect(mapColor('Blue')).toBe('blue');
    expect(mapColor('PURPLE')).toBe('violet');
  });

  it('returns the fallback for unrecognised colors', () => {
    expect(mapColor('magenta')).toBe('yellow');      // default fallback
    expect(mapColor('magenta', 'blue')).toBe('blue'); // custom fallback
    expect(mapColor(undefined)).toBe('yellow');
    expect(mapColor(null)).toBe('yellow');
    expect(mapColor('')).toBe('yellow');
  });

  it('handles non-string inputs gracefully', () => {
    expect(mapColor(42)).toBe('yellow');
    expect(mapColor({})).toBe('yellow');
  });
});

// ── mapFill ───────────────────────────────────────────────────────────────────
describe('mapFill', () => {
  it('accepts all valid tldraw fill values', () => {
    expect(mapFill('none')).toBe('none');
    expect(mapFill('semi')).toBe('semi');
    expect(mapFill('solid')).toBe('solid');
    expect(mapFill('pattern')).toBe('pattern');
  });

  it('is case-insensitive', () => {
    expect(mapFill('SOLID')).toBe('solid');
    expect(mapFill('None')).toBe('none');
    expect(mapFill('SEMI')).toBe('semi');
  });

  it('defaults to "solid" for unrecognised values', () => {
    expect(mapFill('filled')).toBe('solid');
    expect(mapFill('')).toBe('solid');
    expect(mapFill(undefined)).toBe('solid');
    expect(mapFill(null)).toBe('solid');
    expect(mapFill(42)).toBe('solid');
  });
});

// ── executeCanvasCommands ─────────────────────────────────────────────────────
function makeMockEditor(existingShapes: { id: string; type: string; x?: number; y?: number }[] = []): Editor {
  return {
    getCurrentPageShapes: vi.fn(() => existingShapes),
    getCurrentPageShapesSorted: vi.fn(() => existingShapes),
    createShapes: vi.fn(),
    updateShapes: vi.fn(),
    deleteShapes: vi.fn(),
  } as unknown as Editor;
}

describe('executeCanvasCommands', () => {
  it('returns { count: 0, shapeIds: [] } when no canvas block is present', () => {
    const editor = makeMockEditor();
    const result = executeCanvasCommands(editor, 'No canvas block here.');
    expect(result).toEqual({ count: 0, shapeIds: [] });
  });

  it('returns { count: 0, shapeIds: [] } for an empty canvas block', () => {
    const editor = makeMockEditor();
    const result = executeCanvasCommands(editor, '```canvas\n```');
    expect(result).toEqual({ count: 0, shapeIds: [] });
  });

  it('executes add_note command', () => {
    const editor = makeMockEditor();
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"add_note","text":"Hello","x":100,"y":200,"color":"blue"}\n```',
    );
    expect(editor.createShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
    expect(result.shapeIds).toHaveLength(1);
  });

  it('executes add_text command', () => {
    const editor = makeMockEditor();
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"add_text","text":"Title","x":50,"y":50,"color":"black"}\n```',
    );
    expect(editor.createShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
  });

  it('executes add_geo command', () => {
    const editor = makeMockEditor();
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"add_geo","geo":"rectangle","text":"Box","x":0,"y":0,"w":200,"h":120,"color":"green","fill":"solid"}\n```',
    );
    expect(editor.createShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
  });

  it('executes add_slide command', () => {
    const editor = makeMockEditor(); // no existing frames
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"add_slide","name":"Intro"}\n```',
    );
    expect(editor.createShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
  });

  it('executes add_arrow command', () => {
    const editor = makeMockEditor();
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"add_arrow","x1":100,"y1":100,"x2":300,"y2":200,"label":"connects"}\n```',
    );
    expect(editor.createShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
  });

  it('executes delete command when shape exists', () => {
    const shapeId = 'shape:abc123';
    const editor = makeMockEditor([{ id: shapeId, type: 'geo' }]);
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"delete","id":"abc123"}\n```',
    );
    expect(editor.deleteShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
  });

  it('does not crash delete when shape is not found', () => {
    const editor = makeMockEditor([]);
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"delete","id":"notfound"}\n```',
    );
    expect(editor.deleteShapes).not.toHaveBeenCalled();
    expect(result.count).toBe(0);
  });

  it('executes update command', () => {
    const shapeId = 'shape:abc123';
    const editor = makeMockEditor([{ id: shapeId, type: 'note' }]);
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"update","id":"abc123","text":"Updated text"}\n```',
    );
    expect(editor.updateShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
    expect(result.shapeIds).toContain(shapeId);
  });

  it('executes move command', () => {
    const shapeId = 'shape:xyz789';
    const editor = makeMockEditor([{ id: shapeId, type: 'text', x: 0, y: 0 }]);
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"move","id":"xyz789","x":300,"y":400}\n```',
    );
    expect(editor.updateShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
  });

  it('executes clear command', () => {
    const editor = makeMockEditor([
      { id: 'shape:aaa', type: 'note' },
      { id: 'shape:bbb', type: 'text' },
    ]);
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"clear"}\n```',
    );
    expect(editor.deleteShapes).toHaveBeenCalledOnce();
    expect(result.count).toBe(2);
  });

  it('skips malformed / non-JSON lines without throwing', () => {
    const editor = makeMockEditor();
    expect(() =>
      executeCanvasCommands(editor, '```canvas\nnot json\n{"op":"add_note","text":"ok"}\n```'),
    ).not.toThrow();
  });

  it('batches multiple commands and accumulates count', () => {
    const editor = makeMockEditor();
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"add_note","text":"A"}\n{"op":"add_text","text":"B"}\n```',
    );
    expect(result.count).toBe(2);
    expect(editor.createShapes).toHaveBeenCalledTimes(2);
  });

  it('deduplicates shapeIds in the result', () => {
    // Two updates referencing the same shape id should only appear once in shapeIds
    const shapeId = 'shape:abc123';
    const editor = makeMockEditor([{ id: shapeId, type: 'note' }]);
    const result = executeCanvasCommands(
      editor,
      '```canvas\n{"op":"update","id":"abc123","text":"First"}\n{"op":"update","id":"abc123","text":"Second"}\n```',
    );
    const unique = [...new Set(result.shapeIds)];
    expect(result.shapeIds).toEqual(unique);
  });

  it('ignores unknown ops without throwing', () => {
    const editor = makeMockEditor();
    expect(() =>
      executeCanvasCommands(editor, '```canvas\n{"op":"teleport"}\n```'),
    ).not.toThrow();
  });
});

// ── canvasAI context helpers ──────────────────────────────────────────────────
describe('canvasAIContext helpers (indirect)', () => {
  it('add_note falls back to auto-positioned x/y when omitted', () => {
    const editor = makeMockEditor();
    executeCanvasCommands(editor, '```canvas\n{"op":"add_note","text":"no coords"}\n```');
    expect(editor.createShapes).toHaveBeenCalledOnce();
    const [shapes] = (editor.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    const shape = shapes[0];
    // Auto-position formula: 100 + (idx%5)*220, where idx=0 → x=100
    expect(shape.x).toBe(100);
    expect(shape.y).toBe(100);
  });
});
