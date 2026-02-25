/**
 * Canvas theme system: types, defaults, presets, and editor helpers.
 * Covers slide background colours/images + heading/body text presets.
 */
import type { Editor } from 'tldraw';
import {
  createShapeId, toRichText,
  DefaultColorStyle, DefaultSizeStyle, DefaultFontStyle,
  DefaultTextAlignStyle,
} from 'tldraw';
import type { CanvasTheme, TextStyle, AnyFrame } from './canvasTypes';
import { SLIDE_W, SLIDE_H, TLDRAW_COLORS } from './canvasConstants';

export type { CanvasTheme, TextStyle };

export const DEFAULT_THEME: CanvasTheme = {
  slideBg: 'white',
  heading: { font: 'sans', size: 'xl', color: 'black', align: 'start' },
  body:    { font: 'sans', size: 'm',  color: 'black', align: 'start' },
  defaultLayout: 'title-body',
};

export const PRESET_THEMES: { label: string; theme: CanvasTheme }[] = [
  { label: 'Light',  theme: { slideBg: 'white',        heading: { font: 'sans',  size: 'xl', color: 'black',     align: 'start' }, body: { font: 'sans',  size: 'm', color: 'grey',      align: 'start' } } },
  { label: 'Dark',   theme: { slideBg: 'black',        heading: { font: 'sans',  size: 'xl', color: 'white',     align: 'start' }, body: { font: 'sans',  size: 'm', color: 'grey',      align: 'start' } } },
  { label: 'Navy',   theme: { slideBg: 'blue',         heading: { font: 'sans',  size: 'xl', color: 'white',     align: 'start' }, body: { font: 'sans',  size: 'm', color: 'light-blue', align: 'start' } } },
  { label: 'Violet', theme: { slideBg: 'light-violet', heading: { font: 'serif', size: 'xl', color: 'violet',    align: 'start' }, body: { font: 'serif', size: 'm', color: 'black',     align: 'start' } } },
  { label: 'Warm',   theme: { slideBg: 'light-red',    heading: { font: 'sans',  size: 'xl', color: 'red',       align: 'start' }, body: { font: 'sans',  size: 'm', color: 'black',     align: 'start' } } },
  { label: 'Forest', theme: { slideBg: 'light-green',  heading: { font: 'sans',  size: 'xl', color: 'green',     align: 'start' }, body: { font: 'sans',  size: 'm', color: 'black',     align: 'start' } } },
  { label: 'Retro',  theme: { slideBg: 'yellow',       heading: { font: 'draw',  size: 'xl', color: 'orange',    align: 'start' }, body: { font: 'draw',  size: 'm', color: 'black',     align: 'start' } } },
];

export function loadThemeFromDoc(editor: Editor): CanvasTheme {
  const meta = editor.getDocumentSettings().meta as Record<string, unknown>;
  const t = meta?.theme as Partial<CanvasTheme> | undefined;
  if (!t) return DEFAULT_THEME;
  return {
    slideBg:      (t.slideBg      as string) ?? DEFAULT_THEME.slideBg,
    slideBgImage: (t.slideBgImage as string) ?? '',
    heading: { ...DEFAULT_THEME.heading, ...(t.heading as TextStyle | undefined) },
    body:    { ...DEFAULT_THEME.body,    ...(t.body    as TextStyle | undefined) },
    defaultLayout: (t.defaultLayout as string) ?? 'title-body',
  };
}

export function persistTheme(editor: Editor, theme: CanvasTheme) {
  const existing = editor.getDocumentSettings().meta as Record<string, unknown>;
  editor.updateDocumentSettings({ meta: { ...existing, theme: theme as unknown as ReturnType<typeof editor.getDocumentSettings>['meta'][string] } });
}

export function applyThemeToSlides(editor: Editor, theme: CanvasTheme) {
  const frames = editor.getCurrentPageShapesSorted().filter((s) => s.type === 'frame');
  if (frames.length === 0) return;

  const imageUrl = theme.slideBgImage?.trim() ?? '';
  const useImage = imageUrl.length > 0;

  frames.forEach((frame) => {
    const af = frame as AnyFrame;
    const frameW = af.props.w ?? SLIDE_W;
    const frameH = af.props.h ?? SLIDE_H;
    const childIds = editor.getSortedChildIdsForParent(frame);
    const existingBg = childIds
      .map((id) => editor.getShape(id))
      .find((s) => s?.meta?.isThemeBg === true);

    if (existingBg) {
      if (!useImage && existingBg.type === 'geo') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateShape({ id: existingBg.id, type: 'geo', isLocked: true, props: { color: theme.slideBg as any } as any });
        editor.sendToBack([existingBg.id]);
        return;
      }
      if (useImage && existingBg.type === 'image') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assetId = (existingBg.props as any).assetId;
        const asset = assetId ? editor.getAsset(assetId) : null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentSrc = (asset?.props as any)?.src ?? '';
        if (currentSrc === imageUrl) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          editor.updateShape({ id: existingBg.id, type: 'image', isLocked: true, props: { w: frameW, h: frameH, crop: null } as any });
          editor.sendToBack([existingBg.id]);
          return;
        }
      }
      editor.deleteShapes([existingBg.id]);
    }

    if (useImage) {
      const urlKey = imageUrl.replace(/[^a-zA-Z0-9]/g, '').slice(-24);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assetId = `asset:bg_${urlKey}` as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!editor.getAsset(assetId as any)) {
        const ext = imageUrl.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
        const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
        const mimeType = MIME[ext] ?? 'image/jpeg';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.createAssets([{ id: assetId, typeName: 'asset', type: 'image', props: { name: 'slide-background', src: imageUrl, w: frameW, h: frameH, mimeType, isAnimated: mimeType === 'image/gif' }, meta: {} } as any]);
      }
      const bgId = createShapeId();
      editor.createShape({
        id: bgId, type: 'image', parentId: frame.id, x: 0, y: 0,
        isLocked: true,
        meta: { isThemeBg: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        props: { assetId, w: frameW, h: frameH, crop: null, playing: true, url: '' } as any,
      });
      editor.sendToBack([bgId]);
    } else {
      const bgId = createShapeId();
      editor.createShape({
        id: bgId, type: 'geo', parentId: frame.id, x: 0, y: 0,
        isLocked: true,
        meta: { isThemeBg: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        props: { geo: 'rectangle', w: frameW, h: frameH, fill: 'solid', color: theme.slideBg as any, dash: 'solid', size: 's' } as any,
      });
      editor.sendToBack([bgId]);
    }
  });
  persistTheme(editor, theme);
  // Re-style existing heading/body shapes so theme changes apply immediately
  const allShapes = editor.getCurrentPageShapes();
  for (const shape of allShapes) {
    const role = (shape.meta as Record<string, unknown>)?.textRole as string | undefined;
    if (role !== 'heading' && role !== 'body') continue;
    const s = role === 'heading' ? theme.heading : theme.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alignProp = shape.type === 'text' ? 'textAlign' : 'align';
    editor.updateShape({ id: shape.id, type: shape.type,
      props: { color: s.color, size: s.size, font: s.font, [alignProp]: s.align },
    } as any);
  }
}

/** Ensure all isThemeBg shapes are at the back of their parent frame. */
export function enforceBgAtBack(editor: Editor) {
  const frames = editor.getCurrentPageShapes().filter((s) => s.type === 'frame');
  const toSendBack: ReturnType<typeof createShapeId>[] = [];
  for (const frame of frames) {
    const childIds = editor.getSortedChildIdsForParent(frame.id);
    if (childIds.length < 2) continue;
    const bgId = childIds.find((id) => {
      const s = editor.getShape(id);
      return (s?.meta as Record<string, unknown>)?.isThemeBg === true;
    });
    if (bgId && childIds[0] !== bgId) toSendBack.push(bgId as ReturnType<typeof createShapeId>);
  }
  if (toSendBack.length > 0) editor.sendToBack(toSendBack);
}

/** Set next-shape pen styles to match a heading/body preset; also apply to current selection. */
export function applyTextPreset(editor: Editor, variant: 'heading' | 'body', theme: CanvasTheme) {
  const s = variant === 'heading' ? theme.heading : theme.body;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (prop: any, val: any) => { editor.setStyleForNextShapes(prop, val); };
  set(DefaultFontStyle,      s.font);
  set(DefaultSizeStyle,      s.size);
  set(DefaultColorStyle,     s.color);
  set(DefaultTextAlignStyle, s.align);
  if (editor.getSelectedShapeIds().length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sset = (prop: any, val: any) => editor.setStyleForSelectedShapes(prop, val);
    sset(DefaultFontStyle,      s.font);
    sset(DefaultSizeStyle,      s.size);
    sset(DefaultColorStyle,     s.color);
    sset(DefaultTextAlignStyle, s.align);
  }
}

// ── Slide layout presets ──────────────────────────────────────────────────────

export const SLIDE_LAYOUT_OPTIONS = [
  { id: 'blank',          label: 'Blank',      icon: '□',   desc: 'Empty slide' },
  { id: 'title-only',     label: 'Title',      icon: 'T',   desc: 'Centered title only' },
  { id: 'title-body',     label: 'Title+Body', icon: 'T/B', desc: 'Title + body text' },
  { id: 'title-subtitle', label: 'Centered',   icon: 'T·S', desc: 'Centered title + subtitle' },
  { id: 'two-column',     label: '2 Columns',  icon: '▌▌',  desc: 'Title + two text columns' },
  { id: 'image-right',    label: 'Img Right',  icon: 'T▐',  desc: 'Text left + image placeholder right' },
] as const;

export function applySlideLayout(editor: Editor, frame: AnyFrame, layoutId: string, theme: CanvasTheme) {
  const W = frame.props.w ?? SLIDE_W;
  const H = frame.props.h ?? SLIDE_H;
  const PAD = 80;
  const childIds = editor.getSortedChildIdsForParent(frame.id);
  const toDelete = childIds.filter((id) => {
    const s = editor.getShape(id);
    return s && !!(s.meta as Record<string, unknown>)?.textRole;
  });
  if (toDelete.length) editor.deleteShapes(toDelete);

  type TRole = 'heading' | 'body';
  function mkText(x: number, y: number, w: number, role: TRole, text: string, alignOverride?: string) {
    const s = role === 'heading' ? theme.heading : theme.body;
    const id = createShapeId();
    editor.createShape({
      id, type: 'text', parentId: frame.id as ReturnType<typeof createShapeId>, x, y,
      meta: { textRole: role },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { richText: toRichText(text), color: s.color, size: s.size, font: s.font,
               textAlign: alignOverride ?? s.align, autoSize: false, w } as any,
    } as any);
    return id;
  }

  if (layoutId === 'blank') {
    // intentionally empty
  } else if (layoutId === 'title-only') {
    mkText(PAD, H / 2 - 70, W - PAD * 2, 'heading', 'Title', 'middle');
  } else if (layoutId === 'title-body') {
    mkText(PAD, 100, W - PAD * 2, 'heading', 'Title');
    mkText(PAD, 260, W - PAD * 2, 'body',    'Body text');
  } else if (layoutId === 'title-subtitle') {
    mkText(PAD, H / 2 - 130, W - PAD * 2, 'heading', 'Title',    'middle');
    mkText(PAD, H / 2 +  20, W - PAD * 2, 'body',    'Subtitle', 'middle');
  } else if (layoutId === 'two-column') {
    const colW = (W - PAD * 3) / 2;
    mkText(PAD,              80,  W - PAD * 2, 'heading', 'Title');
    mkText(PAD,              220, colW,        'body',    'Left column\nBody text here');
    mkText(PAD * 2 + colW,  220, colW,        'body',    'Right column\nBody text here');
  } else if (layoutId === 'image-right') {
    const half = (W - PAD * 3) / 2;
    mkText(PAD, 100, half, 'heading', 'Title');
    mkText(PAD, 260, half, 'body',    'Body text');
    const rectId = createShapeId();
    editor.createShape({
      id: rectId, type: 'geo', parentId: frame.id as ReturnType<typeof createShapeId>,
      x: PAD * 2 + half, y: 80,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { geo: 'rectangle', w: half, h: H - 160, fill: 'none', dash: 'dashed', size: 's', color: 'grey' } as any,
    } as any);
  }
}

// Re-export TLDRAW_COLORS so theme panel (CanvasEditor.tsx) can import from one place
export { TLDRAW_COLORS };
