/**
 * Configuration and memory workspace tools: workspace config, export targets,
 * export execution, persistent memory (remember), and user interaction (ask_user).
 */

import { readTextFile, writeTextFile, mkdir, exists } from '../../services/fs';
import { runExportTarget } from '../exportWorkspace';
import { safeResolvePath } from './shared';
import { appendPendingTask } from '../../services/mobilePendingTasks';
import type { ToolDefinition, DomainExecutor } from './shared';
import type { ExportTarget, ExportFormat, WorkspaceExportConfig, SidebarButton } from '../../types';

// ── Tool definitions ─────────────────────────────────────────────────────────

export const CONFIG_TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'export_workspace',
      description:
        'Run export targets for this workspace — markdown → PDF, canvas → PNG/PDF, zip bundles, or custom commands. ' +
        'Call this when the user says to export, build, publish, deploy, or produce output files. ' +
        'With no argument it runs all enabled targets. Pass a target name to run just one.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Target name to run, or "all" to run all enabled targets (default: "all").',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_export_targets',
      description:
        'List, add, update, or remove export targets in the workspace Build/Export settings. ' +
        'Use this when the user wants to set up, tweak, or inspect export rules without opening the UI. ' +
        'The config is persisted immediately. ' +
        'action="list" returns all targets as JSON. ' +
        'action="add" creates a new target (name, format, and outputDir required). ' +
        'action="update" patches an existing target by id or name. ' +
        'action="remove" deletes a target by id or name.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: 'Operation to perform.' },
          id:          { type: 'string', description: 'Target id (for update/remove).' },
          name:        { type: 'string', description: 'Target name (required for add; used to find target in update/remove).' },
          description: { type: 'string', description: 'Human/AI readable description of what this target produces.' },
          format: {
            type: 'string',
            enum: ['pdf', 'canvas-png', 'canvas-pdf', 'zip', 'custom'],
            description: 'Export format.',
          },
          include:      { type: 'array', items: { type: 'string' }, description: 'File extensions to match, e.g. ["md"] or ["tldr.json"].' },
          includeFiles: { type: 'array', items: { type: 'string' }, description: 'Pinned specific files (relative paths). Overrides include extensions when set.' },
          excludeFiles: { type: 'array', items: { type: 'string' }, description: 'Relative paths to skip.' },
          outputDir:    { type: 'string', description: 'Output directory relative to workspace root.' },
          customCommand:{ type: 'string', description: 'Shell command for custom format. Use {{input}} and {{output}} placeholders.' },
          enabled:      { type: 'boolean', description: 'Whether this target is included in Export All.' },
          merge:        { type: 'boolean', description: 'Merge all matched files into one output (pdf/canvas-pdf).' },
          mergeName:    { type: 'string', description: 'Filename (no extension) for merged output.' },
          pdfCssFile:      { type: 'string', description: '(PDF only) Workspace-relative path to a .css file appended after default styles.' },
          toc:             { type: 'boolean', description: '(PDF only) Generate a Table of Contents page from H1/H2 headings before the content.' },
          versionOutput:   { type: 'string', enum: ['timestamp', 'counter'], description: '(PDF only) Auto-version the output file.' },
          titlePageTitle:      { type: 'string', description: '(PDF only) Title text for the title page.' },
          titlePageSubtitle:   { type: 'string', description: '(PDF only) Subtitle text for the title page.' },
          titlePageAuthor:     { type: 'string', description: '(PDF only) Author name for the title page.' },
          titlePageVersion:    { type: 'string', description: '(PDF only) Version string for the title page, e.g. "v94".' },
          stripFrontmatter:    { type: 'boolean', description: '(PDF only) Strip YAML front-matter before rendering.' },
          stripDraftSections:  { type: 'boolean', description: '(PDF only) Remove ### Draft sections before rendering.' },
          stripDetails:        { type: 'boolean', description: '(PDF only) Remove <details>…</details> blocks before rendering.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Save a fact, note, or preference to the workspace memory (.cafezin/memory.md) so it persists across chat sessions. ' +
        'Use this proactively whenever the user tells you something important about their project — character names, ' +
        'writing style preferences, world-building facts, glossary terms, plot decisions. ' +
        'The memory file is automatically included in every future conversation in this workspace.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The fact, note, or preference to remember. Be specific and write it so it is self-contained out of context.',
          },
          heading: {
            type: 'string',
            description: 'Category heading to file this under, e.g. "Characters", "Style Preferences", "Plot Notes", "Glossary", "World Building". Creates the section if it does not exist.',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Pause execution and ask the user a clarifying question. Use this when you are genuinely uncertain about ' +
        "the user's intent, need to choose between meaningfully different approaches, or require information " +
        'only the user can provide. Do NOT use it for trivial decisions you can make yourself. ' +
        'Provide 2–5 short option labels when there are distinct choices; omit options for open-ended questions.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The clarifying question to present to the user. Be concise and specific.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional 2–5 short option labels the user can pick. Omit for open-ended questions.',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_workspace',
      description:
        'Read or update workspace-level settings: preferred AI model, preferred AI language, voice-dump inbox file, ' +
        'and custom sidebar quick-action buttons. ' +
        'Actions: list | set_model | set_language | set_inbox | add_button | update_button | remove_button.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'set_model', 'set_language', 'set_inbox', 'add_button', 'update_button', 'remove_button'],
            description: 'Operation to perform.',
          },
          model: {
            type: 'string',
            description:
              'AI model identifier (for set_model). E.g. "gpt-4o", "o3", "claude-opus-4-5". ' +
              'Sets the workspace preferred model — overrides the global default for this workspace.',
          },
          language: {
            type: 'string',
            description:
              'BCP-47 language tag (for set_language). E.g. "pt-BR" (default), "en-US", "es", "fr". ' +
              'Sets the language the AI will use by default in this workspace.',
          },
          inboxFile: {
            type: 'string',
            description:
              'Workspace-relative path to the voice-dump inbox file (for set_inbox). ' +
              'Defaults to "00_Inbox/raw_transcripts.md".',
          },
          id: {
            type: 'string',
            description: 'Button id — required for update_button and remove_button.',
          },
          label: {
            type: 'string',
            description:
              'Short label shown on the sidebar button, e.g. "⊡ Export" ' +
              '(required for add_button; optional for update_button).',
          },
          command: {
            type: 'string',
            description:
              'Shell command executed with the workspace root as cwd (required for add_button, optional for update_button).',
          },
          description: {
            type: 'string',
            description: 'Optional tooltip / description for the button.',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_desktop_task',
      description:
        'Save a task to be executed later on the desktop. ' +
        'Use this ONLY when the user requests something that cannot be done on mobile: ' +
        'running scripts, editing canvas/slides, compiling code, running a local server, etc. ' +
        'Do NOT use this for file edits, markdown writing, or anything the mobile Copilot can do directly. ' +
        'The task will show up as a notification when the user opens this workspace on their computer.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'Clear, actionable description of what should be done on the desktop. ' +
              'Write as if briefing someone: what to do, which file, what the goal is.',
          },
          context: {
            type: 'string',
            description:
              'Optional extra context: relevant file path, code snippet, link, or background info.',
          },
        },
        required: ['description'],
      },
    },
  },
];


export const executeConfigTools: DomainExecutor = async (name, args, ctx) => {
  const {
    workspacePath,
    canvasEditor,
    activeFile,
    workspaceExportConfig,
    workspaceConfig,
    onFileWritten,
    onMemoryWritten,
    onExportConfigChange,
    onWorkspaceConfigChange,
    onAskUser,
  } = ctx;

  switch (name) {

    // ── export_workspace ──────────────────────────────────────────────────
    case 'export_workspace': {
      const targets = workspaceExportConfig?.targets ?? [];
      if (targets.length === 0) {
        return 'No export targets configured. Ask the user to open Export Settings (via the ↓ Export button) and define at least one target, or use configure_export_targets to add one.';
      }
      const targetArg = String(args.target ?? 'all').toLowerCase();
      const toRun = targetArg === 'all'
        ? targets.filter((t) => t.enabled)
        : targets.filter((t) => t.name.toLowerCase() === targetArg || t.id === args.target);

      if (toRun.length === 0) {
        const names = targets.map((t) => `"${t.name}"`).join(', ');
        return `No matching target found for "${args.target ?? 'all'}". Available targets: ${names}`;
      }

      const lines: string[] = [];
      for (const target of toRun) {
        try {
          const result = await runExportTarget({
            workspacePath,
            target,
            canvasEditorRef: canvasEditor,
            activeCanvasRel: typeof activeFile === 'string' ? activeFile : null,
          });
          const okPart  = result.outputs.length > 0 ? `✓ ${result.outputs.join(', ')}` : '';
          const errPart = result.errors.length  > 0 ? `⚠ ${result.errors.join('; ')}` : '';
          lines.push(`[${target.name}] ${[okPart, errPart].filter(Boolean).join(' | ')} (${result.elapsed}ms)`);
        } catch (e) {
          lines.push(`[${target.name}] Failed: ${e}`);
        }
      }
      return lines.join('\n');
    }

    // ── configure_export_targets ──────────────────────────────────────────
    case 'configure_export_targets': {
      const action = String(args.action ?? 'list');
      const currentTargets: ExportTarget[] = workspaceExportConfig?.targets ?? [];

      if (action === 'list') {
        if (currentTargets.length === 0) return 'No export targets configured yet.';
        return JSON.stringify(currentTargets, null, 2);
      }

      if (!onExportConfigChange) {
        return 'Export config changes are not available in this context.';
      }

      if (action === 'add') {
        if (!args.name)   return 'Error: name is required for add.';
        if (!args.format) return 'Error: format is required for add.';
        const hasTitlePage = args.titlePageTitle || args.titlePageSubtitle || args.titlePageAuthor || args.titlePageVersion;
        const titlePage = hasTitlePage ? {
          title:    args.titlePageTitle    ? String(args.titlePageTitle)    : undefined,
          subtitle: args.titlePageSubtitle ? String(args.titlePageSubtitle) : undefined,
          author:   args.titlePageAuthor   ? String(args.titlePageAuthor)   : undefined,
          version:  args.titlePageVersion  ? String(args.titlePageVersion)  : undefined,
        } : undefined;
        const hasPreProcess = args.stripFrontmatter || args.stripDraftSections || args.stripDetails;
        const preProcess = hasPreProcess ? {
          stripFrontmatter:   args.stripFrontmatter   === true ? true : undefined,
          stripDraftSections: args.stripDraftSections === true ? true : undefined,
          stripDetails:       args.stripDetails        === true ? true : undefined,
        } : undefined;
        const newTarget: ExportTarget = {
          id: Math.random().toString(36).slice(2, 9),
          name: String(args.name),
          description: args.description ? String(args.description) : undefined,
          format: String(args.format) as ExportFormat,
          include: Array.isArray(args.include) ? args.include.map(String) : [],
          includeFiles: Array.isArray(args.includeFiles) ? args.includeFiles.map(String) : undefined,
          excludeFiles: Array.isArray(args.excludeFiles) ? args.excludeFiles.map(String) : undefined,
          outputDir: args.outputDir ? String(args.outputDir) : 'dist',
          customCommand: args.customCommand ? String(args.customCommand) : undefined,
          enabled: args.enabled !== false,
          merge: args.merge === true ? true : undefined,
          mergeName: args.mergeName ? String(args.mergeName) : undefined,
          pdfCssFile:    args.pdfCssFile    ? String(args.pdfCssFile)    : undefined,
          toc:           args.toc           === true ? true              : undefined,
          versionOutput: args.versionOutput ? String(args.versionOutput) as ExportTarget['versionOutput'] : undefined,
          titlePage,
          preProcess,
        };
        const next: WorkspaceExportConfig = { targets: [...currentTargets, newTarget] };
        onExportConfigChange(next);
        return `Added target "${newTarget.name}" (id: ${newTarget.id}).`;
      }

      if (action === 'update') {
        const match = currentTargets.find((t) =>
          (args.id && t.id === args.id) || (args.name && t.name.toLowerCase() === String(args.name).toLowerCase())
        );
        if (!match) return `Target not found: ${args.id ?? args.name}`;
        const patch: Partial<ExportTarget> = {};
        if (args.name         !== undefined) patch.name          = String(args.name);
        if (args.description  !== undefined) patch.description   = String(args.description);
        if (args.format       !== undefined) patch.format        = String(args.format) as ExportFormat;
        if (args.include      !== undefined) patch.include       = Array.isArray(args.include) ? args.include.map(String) : [];
        if (args.includeFiles !== undefined) patch.includeFiles  = Array.isArray(args.includeFiles) ? args.includeFiles.map(String) : [];
        if (args.excludeFiles !== undefined) patch.excludeFiles  = Array.isArray(args.excludeFiles) ? args.excludeFiles.map(String) : [];
        if (args.outputDir    !== undefined) patch.outputDir     = String(args.outputDir);
        if (args.customCommand!== undefined) patch.customCommand = String(args.customCommand);
        if (args.enabled      !== undefined) patch.enabled       = Boolean(args.enabled);
        if (args.merge        !== undefined) patch.merge         = Boolean(args.merge);
        if (args.mergeName    !== undefined) patch.mergeName     = String(args.mergeName);
        if (args.pdfCssFile    !== undefined) patch.pdfCssFile    = String(args.pdfCssFile) || undefined;
        if (args.toc           !== undefined) patch.toc           = Boolean(args.toc) || undefined;
        if (args.versionOutput !== undefined) patch.versionOutput = (String(args.versionOutput) || undefined) as ExportTarget['versionOutput'];
        if (args.titlePageTitle !== undefined || args.titlePageSubtitle !== undefined ||
            args.titlePageAuthor !== undefined || args.titlePageVersion !== undefined) {
          const existing = match.titlePage ?? {};
          patch.titlePage = {
            ...existing,
            ...(args.titlePageTitle    !== undefined ? { title:    String(args.titlePageTitle)    || undefined } : {}),
            ...(args.titlePageSubtitle !== undefined ? { subtitle: String(args.titlePageSubtitle) || undefined } : {}),
            ...(args.titlePageAuthor   !== undefined ? { author:   String(args.titlePageAuthor)   || undefined } : {}),
            ...(args.titlePageVersion  !== undefined ? { version:  String(args.titlePageVersion)  || undefined } : {}),
          };
          if (!Object.values(patch.titlePage).some(Boolean)) patch.titlePage = undefined;
        }
        if (args.stripFrontmatter !== undefined || args.stripDraftSections !== undefined || args.stripDetails !== undefined) {
          const existing = match.preProcess ?? {};
          patch.preProcess = {
            ...existing,
            ...(args.stripFrontmatter   !== undefined ? { stripFrontmatter:   Boolean(args.stripFrontmatter)   || undefined } : {}),
            ...(args.stripDraftSections !== undefined ? { stripDraftSections: Boolean(args.stripDraftSections) || undefined } : {}),
            ...(args.stripDetails       !== undefined ? { stripDetails:       Boolean(args.stripDetails)       || undefined } : {}),
          };
          if (!Object.values(patch.preProcess).some(Boolean)) patch.preProcess = undefined;
        }
        const next: WorkspaceExportConfig = {
          targets: currentTargets.map((t) => t.id === match.id ? { ...t, ...patch } : t),
        };
        onExportConfigChange(next);
        return `Updated target "${match.name}".`;
      }

      if (action === 'remove') {
        const match = currentTargets.find((t) =>
          (args.id && t.id === args.id) || (args.name && t.name.toLowerCase() === String(args.name).toLowerCase())
        );
        if (!match) return `Target not found: ${args.id ?? args.name}`;
        const next: WorkspaceExportConfig = { targets: currentTargets.filter((t) => t.id !== match.id) };
        onExportConfigChange(next);
        return `Removed target "${match.name}".`;
      }

      return `Unknown action: ${action}. Use list, add, update, or remove.`;
    }

    // ── remember ──────────────────────────────────────────────────────────
    case 'remember': {
      const memContent = String(args.content ?? '').trim();
      const heading    = String(args.heading  ?? '').trim();
      if (!memContent) return 'Error: content is required.';

      const memRelPath = '.cafezin/memory.md';
      let abs: string;
      try { abs = safeResolvePath(workspacePath, memRelPath); }
      catch (e) { return String(e); }

      const dir = abs.split('/').slice(0, -1).join('/');
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });

      let existing = '';
      try { if (await exists(abs)) existing = await readTextFile(abs); } catch { /* treat as empty */ }

      const sectionTitle = heading || 'Notes';
      const sectionHeader = `## ${sectionTitle}`;
      const idx = existing.indexOf(sectionHeader);
      let updated: string;
      if (idx !== -1) {
        const nextSection = existing.indexOf('\n## ', idx + sectionHeader.length);
        const insertAt = nextSection !== -1 ? nextSection : existing.length;
        updated = existing.slice(0, insertAt).trimEnd() + `\n- ${memContent}\n` + existing.slice(insertAt);
      } else {
        const base = existing.trimEnd();
        updated = (base ? base + '\n\n' : '# Workspace Memory\n\n') + `${sectionHeader}\n- ${memContent}\n`;
      }

      try {
        await writeTextFile(abs, updated);
        onMemoryWritten?.(updated);
        onFileWritten?.(memRelPath);
      } catch (e) {
        return `Error saving memory: ${e}`;
      }
      const preview = memContent.length > 80 ? memContent.slice(0, 80) + '…' : memContent;
      return `Remembered under "${sectionTitle}": "${preview}" (saved to ${memRelPath})`;
    }

    // ── ask_user ───────────────────────────────────────────────────────────
    case 'ask_user': {
      const q = String(args.question ?? '').trim();
      if (!q) return 'Error: question is required.';
      const opts = Array.isArray(args.options)
        ? (args.options as unknown[]).map(String)
        : undefined;
      if (!onAskUser) return '(ask_user not available in this context)';
      const answer = await onAskUser(q, opts);
      return answer || '(no response)';
    }

    // ── configure_workspace ────────────────────────────────────────────────
    case 'configure_workspace': {
      const action = String(args.action ?? 'list');
      const currentButtons: SidebarButton[] = workspaceConfig?.sidebarButtons ?? [];

      if (action === 'list') {
        return JSON.stringify({
          preferredModel: workspaceConfig?.preferredModel ?? null,
          preferredLanguage: workspaceConfig?.preferredLanguage ?? 'pt-BR',
          inboxFile: workspaceConfig?.inboxFile ?? '00_Inbox/raw_transcripts.md',
          sidebarButtons: currentButtons,
        }, null, 2);
      }

      if (!onWorkspaceConfigChange) {
        return 'Workspace config changes are not available in this context.';
      }

      if (action === 'set_model') {
        const model = args.model ? String(args.model).trim() : '';
        if (!model) return 'Error: model is required for set_model.';
        onWorkspaceConfigChange({ preferredModel: model });
        return `Preferred model set to "${model}".`;
      }

      if (action === 'set_language') {
        const language = args.language ? String(args.language).trim() : '';
        if (!language) return 'Error: language is required for set_language (e.g. "pt-BR", "en-US").';
        onWorkspaceConfigChange({ preferredLanguage: language });
        return `Preferred language set to "${language}". The AI will now default to this language in this workspace.`;
      }

      if (action === 'set_inbox') {
        const inboxFile = args.inboxFile ? String(args.inboxFile).trim() : '';
        if (!inboxFile) return 'Error: inboxFile is required for set_inbox.';
        onWorkspaceConfigChange({ inboxFile });
        return `Inbox file set to "${inboxFile}".`;
      }

      if (action === 'add_button') {
        if (!args.label)   return 'Error: label is required for add_button.';
        if (!args.command) return 'Error: command is required for add_button.';
        const MAX_BUTTONS = 5;
        if (currentButtons.length >= MAX_BUTTONS) {
          return `Error: maximum of ${MAX_BUTTONS} sidebar buttons. Remove one first.`;
        }
        const newBtn: SidebarButton = {
          id:          Math.random().toString(36).slice(2, 9),
          label:       String(args.label),
          command:     String(args.command),
          description: args.description ? String(args.description) : undefined,
        };
        onWorkspaceConfigChange({ sidebarButtons: [...currentButtons, newBtn] });
        return `Added sidebar button "${newBtn.label}" (id: ${newBtn.id}).`;
      }

      if (action === 'update_button') {
        const match = currentButtons.find((b) =>
          (args.id && b.id === args.id) || (args.label && b.label === String(args.label))
        );
        if (!match) return `Button not found: ${args.id ?? args.label}`;
        const updated: SidebarButton = {
          ...match,
          ...(args.label       !== undefined ? { label:       String(args.label)       } : {}),
          ...(args.command     !== undefined ? { command:     String(args.command)     } : {}),
          ...(args.description !== undefined ? { description: String(args.description) } : {}),
        };
        onWorkspaceConfigChange({ sidebarButtons: currentButtons.map((b) => b.id === match.id ? updated : b) });
        return `Updated sidebar button "${updated.label}".`;
      }

      if (action === 'remove_button') {
        const match = currentButtons.find((b) =>
          (args.id && b.id === args.id) || (args.label && b.label === String(args.label))
        );
        if (!match) return `Button not found: ${args.id ?? args.label}`;
        onWorkspaceConfigChange({ sidebarButtons: currentButtons.filter((b) => b.id !== match.id) });
        return `Removed sidebar button "${match.label}".`;
      }

      return `Unknown action: ${action}. Use list, set_model, set_language, set_inbox, add_button, update_button, or remove_button.`;
    }

    // ── save_desktop_task ──────────────────────────────────────────────────
    case 'save_desktop_task': {
      const description = String(args.description ?? '').trim();
      if (!description) return 'Error: description is required.';
      const context = args.context ? String(args.context).trim() : undefined;
      try {
        const task = await appendPendingTask(workspacePath, { description, context });
        return `Task saved for desktop (id: ${task.id}). It will appear as a notification when this workspace is opened on the computer.`;
      } catch (e) {
        return `Error saving task: ${e}`;
      }
    }

    default:
      return null;
  }
};
