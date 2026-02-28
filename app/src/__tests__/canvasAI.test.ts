import { describe, it, expect, vi } from 'vitest';
import { mapColor, mapFill, executeCanvasCommands, summarizeCanvas, placeImageOnCanvas } from '../utils/canvasAI';
import type { Editor } from 'tldraw';

// ── mapColor ──────────────────────────────────────────────────────────────────
describe('mapColor', () => {
  it('passes through all canonical tldraw color names unchanged', () => {
    const canonical = ['yellow', 'blue', 'green', 'red', 'orange', 'grey', 'white', 'black',
      'light-blue', 'light-green', 'light-red', 'light-violet', 'violet'];
    for (const c of canonical) expect(mapColor(c)).toBe(c);
  });

  it('maps known aliases to their canonical equivalents', () => {
    expect(mapColor('purple')).toBe('violet');
    expect(mapColor('lavender')).toBe('light-violet');
    expect(mapColor('pink')).toBe('light-red');
    expect(mapColor('teal')).toBe('light-blue');
    expect(mapColor('gray')).toBe('grey');
  });

  it('is case-insensitive', () => {
    expect(mapColor('YELLOW')).toBe('yellow');
    expect(mapColor('PURPLE')).toBe('violet');
    expect(mapColor('Blue')).toBe('blue');
  });

  it('returns the fallback (default yellow) for unknown / empty / null / non-string inputs', () => {
    expect(mapColor('magenta')).toBe('yellow');
    expect(mapColor('')).toBe('yellow');
    expect(mapColor(undefined)).toBe('yellow');
    expect(mapColor(null)).toBe('yellow');
    expect(mapColor(42)).toBe('yellow');
    expect(mapColor({})).toBe('yellow');
  });

  it('accepts a custom fallback that overrides the default', () => {
    expect(mapColor('magenta', 'blue')).toBe('blue');
  });
});

// ── mapFill ───────────────────────────────────────────────────────────────────
describe('mapFill', () => {
  it('accepts all valid tldraw fill values case-insensitively', () => {
    expect(mapFill('none')).toBe('none');
    expect(mapFill('semi')).toBe('semi');
    expect(mapFill('solid')).toBe('solid');
    expect(mapFill('pattern')).toBe('pattern');
    expect(mapFill('SOLID')).toBe('solid');
    expect(mapFill('None')).toBe('none');
  });

  it('defaults to "solid" for any unknown or absent value', () => {
    expect(mapFill('filled')).toBe('solid');
    expect(mapFill('')).toBe('solid');
    expect(mapFill(undefined)).toBe('solid');
    expect(mapFill(null)).toBe('solid');
  });
});

// ── executeCanvasCommands helpers ─────────────────────────────────────────────

type MockShape = { id: string; type: string; x?: number; y?: number; parentId?: string };

function makeMockEditor(existingShapes: MockShape[] = []): Editor {
  return {
    getCurrentPageShapes: vi.fn(() => existingShapes),
    getCurrentPageShapesSorted: vi.fn(() => existingShapes),
    createShapes: vi.fn(),
    updateShapes: vi.fn(),
    deleteShapes: vi.fn(),
    markHistoryStoppingPoint: vi.fn(() => 'mock-mark-id'),
    bailToMark: vi.fn(),
  } as unknown as Editor;
}

function canvas(lines: string) {
  return '```canvas\n' + lines + '\n```';
}

// ── block parsing ──────────────────────────────────────────────────────────────
describe('executeCanvasCommands — block parsing', () => {
  it('returns zero result when no canvas block is present', () => {
    const ed = makeMockEditor();
    expect(executeCanvasCommands(ed, 'No canvas here')).toEqual({ count: 0, shapeIds: [], errors: [] });
  });

  it('returns zero result for an empty canvas block', () => {
    const ed = makeMockEditor();
    expect(executeCanvasCommands(ed, canvas(''))).toEqual({ count: 0, shapeIds: [], errors: [] });
  });

  it('only executes the LAST canvas block when multiple exist', () => {
    // First block = AI "example", second = real commands. Running both would
    // duplicate shapes — only the last must execute.
    const ed = makeMockEditor();
    const text =
      canvas('{"op":"add_note","text":"example"}') +
      '\n\nSome explanation\n\n' +
      canvas('{"op":"add_text","text":"real"}');
    const result = executeCanvasCommands(ed, text);
    expect(result.count).toBe(1);
    expect(ed.createShapes).toHaveBeenCalledOnce();
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].type).toBe('text');
  });

  it('records a parse error and rolls back when any line is malformed JSON', () => {
    const ed = makeMockEditor();
    const result = executeCanvasCommands(
      ed, canvas('not json\n{"op":"add_note","text":"ok"}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.count).toBe(0);
    expect(ed.bailToMark).toHaveBeenCalled();
  });

  it('silently ignores unknown ops (count stays 0, no error)', () => {
    const ed = makeMockEditor();
    const result = executeCanvasCommands(ed, canvas('{"op":"teleport"}'));
    expect(result).toEqual({ count: 0, shapeIds: [], errors: [] });
  });
});

// ── add_slide ─────────────────────────────────────────────────────────────────
describe('executeCanvasCommands — add_slide', () => {
  it('creates a 1280×720 frame at x=0 when no slides exist yet', () => {
    const ed = makeMockEditor();
    const result = executeCanvasCommands(ed, canvas('{"op":"add_slide","name":"Intro"}'));
    expect(result.count).toBe(1);
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].type).toBe('frame');
    expect(shapes[0].props.w).toBe(1280);
    expect(shapes[0].props.h).toBe(720);
    expect(shapes[0].props.name).toBe('Intro');
    expect(shapes[0].x).toBe(0);
  });

  it('positions new slide after the existing frame + gap (0 + 1280 + 80 = 1360)', () => {
    const ed: Editor = {
      getCurrentPageShapes: vi.fn(() => [
        { id: 'shape:f001', type: 'frame', x: 0, y: 0, props: { w: 1280, h: 720, name: 'S1' } },
      ]),
      getCurrentPageShapesSorted: vi.fn(() => []),
      createShapes: vi.fn(),
      updateShapes: vi.fn(),
      deleteShapes: vi.fn(),
      markHistoryStoppingPoint: vi.fn(() => 'mark'),
      bailToMark: vi.fn(),
    } as unknown as Editor;
    executeCanvasCommands(ed, canvas('{"op":"add_slide","name":"Slide 2"}'));
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].x).toBe(1360);
  });

  it('uses a default name when name is omitted', () => {
    const ed = makeMockEditor();
    executeCanvasCommands(ed, canvas('{"op":"add_slide"}'));
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof shapes[0].props.name).toBe('string');
    expect(shapes[0].props.name.length).toBeGreaterThan(0);
  });
});

// ── add shapes ────────────────────────────────────────────────────────────────
describe('executeCanvasCommands — add shapes', () => {
  it('add_note: sets richText, color, explicit coords, and returns shapeId', () => {
    const ed = makeMockEditor();
    const result = executeCanvasCommands(
      ed, canvas('{"op":"add_note","text":"Hello","x":100,"y":200,"color":"blue"}'));
    expect(result.count).toBe(1);
    expect(result.shapeIds).toHaveLength(1);
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].type).toBe('note');
    expect(shapes[0].props.color).toBe('blue');
    expect(shapes[0].x).toBe(100);
    expect(shapes[0].y).toBe(200);
  });

  it('add_note: sets parentId when "slide" matches a frame suffix', () => {
    const frameId = 'shape:abcde12345';
    const ed: Editor = {
      getCurrentPageShapes: vi.fn(() => [{ id: frameId, type: 'frame', x: 0 }]),
      getCurrentPageShapesSorted: vi.fn(() => []),
      createShapes: vi.fn(),
      updateShapes: vi.fn(),
      deleteShapes: vi.fn(),
      markHistoryStoppingPoint: vi.fn(() => 'mark'),
      bailToMark: vi.fn(),
    } as unknown as Editor;
    executeCanvasCommands(ed, canvas('{"op":"add_note","text":"child","slide":"abcde12345"}'));
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].parentId).toBe(frameId);
  });

  it('add_note: no parentId when "slide" field is absent (shape floats on page)', () => {
    const ed = makeMockEditor();
    executeCanvasCommands(ed, canvas('{"op":"add_note","text":"free"}'));
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].parentId).toBeUndefined();
  });

  it('add_note: auto-positions at (100,100) when coords are omitted and canvas is empty', () => {
    const ed = makeMockEditor();
    executeCanvasCommands(ed, canvas('{"op":"add_note","text":"no coords"}'));
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].x).toBe(100);
    expect(shapes[0].y).toBe(100);
  });

  it('add_note: guards against NaN/Infinity — always produces finite coords', () => {
    const ed = makeMockEditor();
    executeCanvasCommands(ed, canvas('{"op":"add_note","text":"bad","x":null,"y":"oops"}'));
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Number.isFinite(shapes[0].x)).toBe(true);
    expect(Number.isFinite(shapes[0].y)).toBe(true);
  });

  it('add_text: creates a text shape with autoSize:true', () => {
    const ed = makeMockEditor();
    executeCanvasCommands(ed, canvas('{"op":"add_text","text":"Title","x":50,"y":50}'));
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].type).toBe('text');
    expect(shapes[0].props.autoSize).toBe(true);
  });

  it('add_geo: creates correct dimensions, geo type, color, and fill', () => {
    const ed = makeMockEditor();
    const result = executeCanvasCommands(
      ed, canvas('{"op":"add_geo","geo":"ellipse","w":300,"h":150,"color":"green","fill":"none"}'));
    expect(result.count).toBe(1);
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].type).toBe('geo');
    expect(shapes[0].props.geo).toBe('ellipse');
    expect(shapes[0].props.w).toBe(300);
    expect(shapes[0].props.h).toBe(150);
    expect(shapes[0].props.color).toBe('green');
    expect(shapes[0].props.fill).toBe('none');
  });

  it('add_geo: invalid geo type aborts the batch and records the error', () => {
    const ed = makeMockEditor();
    const result = executeCanvasCommands(
      ed, canvas('{"op":"add_geo","geo":"platypus"}'));
    expect(result.count).toBe(0);
    expect(result.errors[0]).toMatch(/platypus/i);
    expect(ed.bailToMark).toHaveBeenCalled();
  });

  it('add_arrow: places start at (x1,y1) and encodes end as a relative vector', () => {
    const ed = makeMockEditor();
    executeCanvasCommands(
      ed, canvas('{"op":"add_arrow","x1":100,"y1":100,"x2":300,"y2":200,"label":"step"}'));
    const [shapes] = (ed.createShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shapes[0].type).toBe('arrow');
    expect(shapes[0].x).toBe(100);
    expect(shapes[0].y).toBe(100);
    expect(shapes[0].props.end.x).toBe(200); // 300 - 100
    expect(shapes[0].props.end.y).toBe(100); // 200 - 100
  });
});

// ── update ────────────────────────────────────────────────────────────────────
describe('executeCanvasCommands — update', () => {
  it('updates text/color/fill on a note using richText (not plain .text)', () => {
    const ed = makeMockEditor([{ id: 'shape:abc123', type: 'note', props: { color: 'yellow' } } as unknown as MockShape]);
    const result = executeCanvasCommands(
      ed, canvas('{"op":"update","id":"abc123","text":"New","color":"red","fill":"solid"}'));
    expect(result.count).toBe(1);
    expect(result.shapeIds).toContain('shape:abc123');
    const [updates] = (ed.updateShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updates[0].props.color).toBe('red');
    expect(updates[0].props.fill).toBe('solid');
    // richText should be set via toRichText conversion
    expect(updates[0].props.richText).toBeDefined();
    // plain `.text` must NOT be written — it would corrupt the store
    expect(updates[0].props.text).toBeUndefined();
  });

  it('updates a frame label via props.name, never richText', () => {
    const ed = makeMockEditor([{ id: 'shape:frame1', type: 'frame' }]);
    executeCanvasCommands(
      ed, canvas('{"op":"update","id":"frame1","text":"New Title"}'));
    const [updates] = (ed.updateShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updates[0].props.name).toBe('New Title');
    expect(updates[0].props.richText).toBeUndefined();
  });

  it('returns count:0 without touching updateShapes when no updatable fields provided', () => {
    const ed = makeMockEditor([{ id: 'shape:abc123', type: 'note' }]);
    const result = executeCanvasCommands(
      ed, canvas('{"op":"update","id":"abc123"}'));
    expect(result.count).toBe(0);
    expect(ed.updateShapes).not.toHaveBeenCalled();
  });

  it('rolls back and reports error when id is not found', () => {
    const ed = makeMockEditor([]);
    const result = executeCanvasCommands(
      ed, canvas('{"op":"update","id":"notexist","text":"hi"}'));
    expect(result.count).toBe(0);
    expect(result.errors[0]).toMatch(/notexist/i);
    expect(ed.bailToMark).toHaveBeenCalled();
  });

  it('rolls back with error when "id" field is absent (no accidental first-shape update)', () => {
    const ed = makeMockEditor([{ id: 'shape:shouldnot', type: 'note', props: { color: 'yellow' } } as unknown as MockShape]);
    const result = executeCanvasCommands(
      ed, canvas('{"op":"update","text":"hi"}'));
    expect(result.count).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(ed.updateShapes).not.toHaveBeenCalled();
    expect(ed.bailToMark).toHaveBeenCalled();
  });
});

// ── move ──────────────────────────────────────────────────────────────────────
describe('executeCanvasCommands — move', () => {
  it('repositions a shape to the given x/y', () => {
    const ed = makeMockEditor([{ id: 'shape:xyz789', type: 'text', x: 0, y: 0 }]);
    const result = executeCanvasCommands(ed, canvas('{"op":"move","id":"xyz789","x":300,"y":400}'));
    expect(result.count).toBe(1);
    const [updates] = (ed.updateShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updates[0].x).toBe(300);
    expect(updates[0].y).toBe(400);
  });

  it('coerces string coordinates to numbers ("300" → 300)', () => {
    const ed = makeMockEditor([{ id: 'shape:xyz789', type: 'text', x: 0, y: 0 }]);
    executeCanvasCommands(ed, canvas('{"op":"move","id":"xyz789","x":"300","y":"400"}'));
    const [updates] = (ed.updateShapes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updates[0].x).toBe(300);
    expect(updates[0].y).toBe(400);
  });

  it('rolls back and records error when the target shape does not exist', () => {
    const ed = makeMockEditor([]);
    const result = executeCanvasCommands(ed, canvas('{"op":"move","id":"ghost","x":100,"y":100}'));
    expect(result.count).toBe(0);
    expect(result.errors[0]).toMatch(/ghost/i);
    expect(ed.bailToMark).toHaveBeenCalled();
  });

  it('rolls back with error when "id" field is absent (no accidental first-shape move)', () => {
    const ed = makeMockEditor([{ id: 'shape:shouldnot', type: 'text', x: 0, y: 0 }]);
    const result = executeCanvasCommands(ed, canvas('{"op":"move","x":100,"y":100}'));
    expect(result.count).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(ed.updateShapes).not.toHaveBeenCalled();
    expect(ed.bailToMark).toHaveBeenCalled();
  });
});

// ── delete ────────────────────────────────────────────────────────────────────
describe('executeCanvasCommands — delete', () => {
  it('deletes a shape matched by id suffix', () => {
    const ed = makeMockEditor([{ id: 'shape:abc123', type: 'geo' }]);
    const result = executeCanvasCommands(ed, canvas('{"op":"delete","id":"abc123"}'));
    expect(result.count).toBe(1);
    expect(ed.deleteShapes).toHaveBeenCalledOnce();
  });

  it('silently skips (no error) when shape is not found', () => {
    const ed = makeMockEditor([]);
    const result = executeCanvasCommands(ed, canvas('{"op":"delete","id":"notfound"}'));
    expect(result.count).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(ed.deleteShapes).not.toHaveBeenCalled();
  });

  it('returns count:0 silently when "id" field is absent (no accidental first-shape deletion)', () => {
    const ed = makeMockEditor([{ id: 'shape:shouldnot', type: 'geo' }]);
    const result = executeCanvasCommands(ed, canvas('{"op":"delete"}'));
    expect(result.count).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(ed.deleteShapes).not.toHaveBeenCalled();
  });
});

// ── clear ─────────────────────────────────────────────────────────────────────
describe('executeCanvasCommands — clear', () => {
  it('deletes all shapes when confirm:"yes" is present', () => {
    const ed = makeMockEditor([
      { id: 'shape:a', type: 'note' }, { id: 'shape:b', type: 'text' },
    ]);
    const result = executeCanvasCommands(ed, canvas('{"op":"clear","confirm":"yes"}'));
    expect(result.count).toBe(2);
    expect(ed.deleteShapes).toHaveBeenCalledOnce();
  });

  it('blocks clear silently (not an error) when confirm:"yes" is absent', () => {
    const ed = makeMockEditor([{ id: 'shape:a', type: 'note' }]);
    const result = executeCanvasCommands(ed, canvas('{"op":"clear"}'));
    expect(result.count).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(ed.deleteShapes).not.toHaveBeenCalled();
  });

  it('returns count:0 gracefully when canvas is already empty', () => {
    const ed = makeMockEditor([]);
    const result = executeCanvasCommands(ed, canvas('{"op":"clear","confirm":"yes"}'));
    expect(result.count).toBe(0);
    expect(ed.deleteShapes).not.toHaveBeenCalled();
  });
});

// ── batch behaviour ───────────────────────────────────────────────────────────
describe('executeCanvasCommands — batch behaviour', () => {
  it('accumulates count and shapeIds across multiple successful commands', () => {
    const ed = makeMockEditor();
    const result = executeCanvasCommands(
      ed, canvas('{"op":"add_note","text":"A"}\n{"op":"add_text","text":"B"}'));
    expect(result.count).toBe(2);
    expect(result.shapeIds).toHaveLength(2);
    expect(ed.createShapes).toHaveBeenCalledTimes(2);
  });

  it('deduplicates shapeIds when the same shape is updated multiple times', () => {
    const ed = makeMockEditor([{ id: 'shape:abc123', type: 'note' }]);
    const result = executeCanvasCommands(
      ed,
      canvas('{"op":"update","id":"abc123","text":"First"}\n{"op":"update","id":"abc123","text":"Second"}'),
    );
    expect(result.shapeIds).toHaveLength(1);
    expect(result.shapeIds[0]).toBe('shape:abc123');
  });

  it('all-or-nothing: any single failure rolls back the entire batch', () => {
    const ed = makeMockEditor([{ id: 'shape:good01', type: 'note' }]);
    const result = executeCanvasCommands(
      ed,
      canvas(
        '{"op":"add_note","text":"first"}\n' +
        '{"op":"update","id":"MISSING_ID","text":"fail"}\n' +
        '{"op":"add_text","text":"third"}'
      ),
    );
    expect(result.count).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(ed.bailToMark).toHaveBeenCalledOnce();
  });

  it('marks a history stopping point before every batch (enables Ctrl+Z undo)', () => {
    const ed = makeMockEditor();
    executeCanvasCommands(ed, canvas('{"op":"add_note","text":"x"}'));
    expect(ed.markHistoryStoppingPoint).toHaveBeenCalledWith('canvas-op-batch');
  });
});

// ── summarizeCanvas ───────────────────────────────────────────────────────────
describe('summarizeCanvas', () => {
  function makeReadEditor(shapes: Array<Record<string, unknown>>): Editor {
    return {
      getCurrentPageShapes: vi.fn(() => shapes),
      getCurrentPage: vi.fn(() => ({ name: 'Page 1' })),
    } as unknown as Editor;
  }

  it('returns "empty" message when canvas has no shapes', () => {
    expect(summarizeCanvas(makeReadEditor([]))).toBe('The canvas is currently empty.');
  });

  it('includes the frame name, position, and dimensions in slide summary', () => {
    const ed = makeReadEditor([
      { id: 'shape:frame00001', type: 'frame', x: 0, y: 0,
        props: { w: 1280, h: 720, name: 'Intro' }, parentId: 'page:page' },
    ]);
    const s = summarizeCanvas(ed);
    expect(s).toContain('Intro');
    expect(s).toContain('1280\u00d7720');
    expect(s).toContain('slide 1');
  });

  it('lists child shapes nested under their parent frame', () => {
    const frameId = 'shape:frame00001';
    const ed = makeReadEditor([
      { id: frameId, type: 'frame', x: 0, y: 0,
        props: { w: 1280, h: 720, name: 'S1' }, parentId: 'page:page' },
      { id: 'shape:child00001', type: 'note', x: 100, y: 100, parentId: frameId,
        props: { richText: { text: 'Note A' }, color: 'yellow' } },
    ]);
    const s = summarizeCanvas(ed);
    expect(s).toContain('Note A');
    expect(s.indexOf('Note A')).toBeGreaterThan(s.indexOf('S1'));
  });

  it('labels an empty slide as "(empty slide …)"', () => {
    const ed = makeReadEditor([
      { id: 'shape:frame00001', type: 'frame', x: 0, y: 0,
        props: { w: 1280, h: 720, name: 'Blank' }, parentId: 'page:page' },
    ]);
    expect(summarizeCanvas(ed)).toContain('(empty slide');
  });

  it('describes a geo shape with its type, dimensions, and color', () => {
    const ed = makeReadEditor([
      { id: 'shape:geo000001', type: 'geo', x: 50, y: 80,
        props: { geo: 'rectangle', w: 200, h: 100, color: 'blue', fill: 'solid' } },
    ]);
    const s = summarizeCanvas(ed);
    expect(s).toContain('rectangle');
    expect(s).toContain('200\u00d7100');
    expect(s).toContain('color:blue');
  });

  it('describes an arrow with an arrow indicator', () => {
    const ed = makeReadEditor([
      { id: 'shape:arw000001', type: 'arrow', x: 100, y: 100,
        props: { start: { x: 0, y: 0 }, end: { x: 200, y: 50 }, color: 'grey' } },
    ]);
    expect(summarizeCanvas(ed)).toContain('\u2192');
  });

  it('uses the last 10 characters of a shape ID as its short ID', () => {
    const ed = makeReadEditor([
      { id: 'shape:abcde12345', type: 'note', x: 0, y: 0,
        props: { richText: { text: 'hi' }, color: 'yellow' } },
    ]);
    expect(summarizeCanvas(ed)).toContain('abcde12345');
  });

  it('sorts slides left-to-right by x position, not creation order', () => {
    const ed = makeReadEditor([
      { id: 'shape:slideA00001', type: 'frame', x: 1360, y: 0,
        props: { w: 1280, h: 720, name: 'Slide B' }, parentId: 'page:page' },
      { id: 'shape:slideB00001', type: 'frame', x: 0, y: 0,
        props: { w: 1280, h: 720, name: 'Slide A' }, parentId: 'page:page' },
    ]);
    const s = summarizeCanvas(ed);
    expect(s.indexOf('Slide A')).toBeLessThan(s.indexOf('Slide B'));
  });
});

// ── placeImageOnCanvas ────────────────────────────────────────────────────────
describe('placeImageOnCanvas', () => {
  function makeImageEditor(viewport = { x: 0, y: 0, w: 1920, h: 1080 }): Editor {
    return {
      getViewportPageBounds: vi.fn(() => viewport),
      createAssets: vi.fn(),
      createShape: vi.fn(),
    } as unknown as Editor;
  }

  it('creates exactly one asset and one image shape', () => {
    const ed = makeImageEditor();
    placeImageOnCanvas(ed, 'https://x.com/img.png', 'img.png', 'image/png', 400, 300);
    expect(ed.createAssets).toHaveBeenCalledOnce();
    expect(ed.createShape).toHaveBeenCalledOnce();
  });

  it('places image at explicit x/y when opts.x / opts.y are provided', () => {
    const ed = makeImageEditor();
    placeImageOnCanvas(ed, 'src', 'a.png', 'image/png', 400, 300, { x: 100, y: 200 });
    const [shape] = (ed.createShape as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shape.x).toBe(100);
    expect(shape.y).toBe(200);
  });

  it('centers image on the drop point when dropX/dropY are used', () => {
    // natW=400 (≤800), dispW=400, dispH=300; center on (500,400) → x=300, y=250
    const ed = makeImageEditor();
    placeImageOnCanvas(ed, 'src', 'b.png', 'image/png', 400, 300, { dropX: 500, dropY: 400 });
    const [shape] = (ed.createShape as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shape.x).toBe(300); // 500 - 400/2
    expect(shape.y).toBe(250); // 400 - 300/2
  });

  it('centers in the viewport when no placement hint is given', () => {
    // viewport 1920×1080, dispW=400, dispH=300 → x=760, y=390
    const ed = makeImageEditor({ x: 0, y: 0, w: 1920, h: 1080 });
    placeImageOnCanvas(ed, 'src', 'd.png', 'image/png', 400, 300);
    const [shape] = (ed.createShape as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shape.x).toBe(760); // (1920-400)/2
    expect(shape.y).toBe(390); // (1080-300)/2
  });

  it('caps display width at 800px and scales height proportionally for large images', () => {
    const ed = makeImageEditor();
    placeImageOnCanvas(ed, 'src', 'big.png', 'image/png', 2000, 1000);
    const [shape] = (ed.createShape as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shape.props.w).toBe(800);
    expect(shape.props.h).toBe(400); // 1000 * (800/2000)
  });

  it('respects opts.width to override display width', () => {
    const ed = makeImageEditor();
    placeImageOnCanvas(ed, 'src', 'e.png', 'image/png', 1000, 500, { width: 300 });
    const [shape] = (ed.createShape as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shape.props.w).toBe(300);
    expect(shape.props.h).toBe(150); // 500 * (300/1000)
  });

  it('sets all required tldraw v4.4.0 image props to safe defaults', () => {
    const ed = makeImageEditor();
    placeImageOnCanvas(ed, 'src', 'f.png', 'image/png', 100, 100);
    const [shape] = (ed.createShape as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shape.props.playing).toBe(true);
    expect(shape.props.url).toBe('');
    expect(shape.props.crop).toBeNull();
    expect(shape.props.flipX).toBe(false);
    expect(shape.props.flipY).toBe(false);
    expect(shape.props.altText).toBe('');
  });

  it('stores natural dimensions and mimeType in the asset', () => {
    const ed = makeImageEditor();
    placeImageOnCanvas(ed, 'https://x.com/g.jpg', 'g.jpg', 'image/jpeg', 1200, 800);
    const [assets] = (ed.createAssets as ReturnType<typeof vi.fn>).mock.calls[0];
    const asset = assets[0];
    expect(asset.props.src).toBe('https://x.com/g.jpg');
    expect(asset.props.w).toBe(1200);
    expect(asset.props.h).toBe(800);
    expect(asset.props.mimeType).toBe('image/jpeg');
    expect(asset.props.isAnimated).toBe(false);
  });

  it('marks gif assets as animated', () => {
    const ed = makeImageEditor();
    placeImageOnCanvas(ed, 'src', 'anim.gif', 'image/gif', 300, 200);
    const [assets] = (ed.createAssets as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(assets[0].props.isAnimated).toBe(true);
  });

  it('returns the final { x, y, w, h } of the placed image', () => {
    const ed = makeImageEditor();
    const result = placeImageOnCanvas(ed, 'src', 'h.png', 'image/png', 400, 300, { x: 50, y: 60 });
    expect(result).toEqual({ x: 50, y: 60, w: 400, h: 300 });
  });
});
