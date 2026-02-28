/**
 * Tests for pure, stateless helpers exported from copilot.ts.
 * The heavy async stuff (streamCopilotChat, runCopilotAgent) relies on the
 * real Copilot API, so we test the logic helpers that underpin them instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  CopilotDiagnosticError,
  modelSupportsVision,
  isBlockedModel,
  familyKey,
  sanitizeLoop,
  estimateTokens,
  isQuotaError,
  getStoredOAuthToken,
  clearOAuthToken,
  modelApiParams,
} from '../services/copilot';
import type { ChatMessage } from '../types';

// ── CopilotDiagnosticError ────────────────────────────────────────────────────
describe('CopilotDiagnosticError', () => {
  it('sets name, message and detail', () => {
    const err = new CopilotDiagnosticError('boom', 'detailed info');
    expect(err.name).toBe('CopilotDiagnosticError');
    expect(err.message).toBe('boom');
    expect(err.detail).toBe('detailed info');
  });

  it('is an instance of Error', () => {
    const err = new CopilotDiagnosticError('x', 'y');
    expect(err).toBeInstanceOf(Error);
  });
});

// ── modelSupportsVision ───────────────────────────────────────────────────────
describe('modelSupportsVision', () => {
  it('returns false for o-series reasoning models', () => {
    expect(modelSupportsVision('o1')).toBe(false);
    expect(modelSupportsVision('o1-mini')).toBe(false);
    expect(modelSupportsVision('o3')).toBe(false);
    expect(modelSupportsVision('o3-mini')).toBe(false);
    expect(modelSupportsVision('o4-mini')).toBe(false);
  });

  it('returns true for GPT, Claude, and Gemini models', () => {
    expect(modelSupportsVision('gpt-4o')).toBe(true);
    expect(modelSupportsVision('gpt-4.1')).toBe(true);
    expect(modelSupportsVision('gpt-4.1-mini')).toBe(true);
    expect(modelSupportsVision('claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsVision('claude-opus-4-5')).toBe(true);
    expect(modelSupportsVision('gemini-2.5-pro')).toBe(true);
  });

  it('only matches the leading "oN" pattern — not arbitrary strings starting with o', () => {
    expect(modelSupportsVision('ollama-mistral')).toBe(true);  // 'ol' not 'o1'
    expect(modelSupportsVision('openai-something')).toBe(true);
  });
});

// ── isBlockedModel ────────────────────────────────────────────────────────────
describe('isBlockedModel', () => {
  it('blocks exact matches', () => {
    expect(isBlockedModel('gpt-4')).toBe(true);
    expect(isBlockedModel('o1-mini')).toBe(true);
  });

  it('blocks models matched by a blocked prefix', () => {
    expect(isBlockedModel('gpt-3.5-turbo')).toBe(true);
    expect(isBlockedModel('gpt-4-turbo-preview')).toBe(true);
    expect(isBlockedModel('gpt-4-32k-0314')).toBe(true);
    expect(isBlockedModel('gpt-4-vision-preview')).toBe(true);
    expect(isBlockedModel('gpt-4-0613')).toBe(true);
    expect(isBlockedModel('text-davinci-003')).toBe(true);
    expect(isBlockedModel('text-embedding-ada-002')).toBe(true);
    expect(isBlockedModel('claude-3-haiku-20240307')).toBe(true);
    expect(isBlockedModel('claude-3-5-sonnet-20241022')).toBe(true);
    expect(isBlockedModel('o1-preview')).toBe(true);
    expect(isBlockedModel('o1-mini-2024-09-12')).toBe(true);
  });

  it('allows current-generation models through', () => {
    expect(isBlockedModel('gpt-4o')).toBe(false);
    expect(isBlockedModel('gpt-4.1')).toBe(false);
    expect(isBlockedModel('gpt-4.1-mini')).toBe(false);
    expect(isBlockedModel('gpt-4o-mini')).toBe(false);
    expect(isBlockedModel('claude-sonnet-4-5')).toBe(false);
    expect(isBlockedModel('claude-opus-4-5')).toBe(false);
    expect(isBlockedModel('claude-haiku-4-5')).toBe(false);
    expect(isBlockedModel('gemini-2.5-pro')).toBe(false);
    expect(isBlockedModel('o3')).toBe(false);
    expect(isBlockedModel('o3-mini')).toBe(false);
  });
});

// ── familyKey ─────────────────────────────────────────────────────────────────
describe('familyKey', () => {
  it('strips trailing 8-digit date stamps', () => {
    expect(familyKey('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet');
    expect(familyKey('gpt-4-0613')).toBe('gpt-4');
  });

  it('strips trailing single-segment minor patch numbers (-5, -6 etc.)', () => {
    expect(familyKey('claude-sonnet-4-5')).toBe('claude-sonnet-4');
    expect(familyKey('claude-sonnet-4-6')).toBe('claude-sonnet-4');
    expect(familyKey('claude-opus-4-5')).toBe('claude-opus-4');
    expect(familyKey('claude-haiku-4-5')).toBe('claude-haiku-4');
  });

  it('leaves models without trailing digits unchanged', () => {
    expect(familyKey('gpt-4o')).toBe('gpt-4o');
    expect(familyKey('gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(familyKey('o3-mini')).toBe('o3-mini');
  });

  it('does not strip non-numeric suffixes like -mini or -nano', () => {
    // gpt-4.1-mini → no trailing digit group ("-mini" is not a bare number)
    expect(familyKey('gpt-4.1-mini')).toBe('gpt-4.1-mini');
  });
});

// ── estimateTokens ────────────────────────────────────────────────────────────
describe('estimateTokens', () => {
  it('returns 0 for an empty message array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('estimates ~1 token per 4 chars of content', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(400) }];
    expect(estimateTokens(msgs)).toBe(100);
  });

  it('strips base64 data URLs before counting (they would massively inflate the estimate)', () => {
    const realContent = 'hello world'; // 11 chars
    const bigBase64 = 'data:image/png;base64,' + 'A'.repeat(100_000);
    const msgs: ChatMessage[] = [
      { role: 'user', content: `${realContent} ${bigBase64}` },
    ];
    // After stripping, content is "hello world [img]" ≈ 18 chars → ≈ 5 tokens
    // Without stripping, it would be ~25k tokens
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeLessThan(50);
    expect(tokens).toBeGreaterThan(0);
  });

  it('accumulates across multiple messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'a'.repeat(80) },
      { role: 'user', content: 'b'.repeat(80) },
    ];
    expect(estimateTokens(msgs)).toBe(40);
  });
});

// ── sanitizeLoop ──────────────────────────────────────────────────────────────
describe('sanitizeLoop', () => {
  it('returns an empty array unchanged', () => {
    expect(sanitizeLoop([])).toEqual([]);
  });

  it('drops orphan tool messages with no preceding assistant tool_call', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'result', tool_call_id: 'call_abc', name: 'read_file' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out.every((m) => m.role !== 'tool')).toBe(true);
  });

  it('keeps a valid tool message that follows an assistant with matching tool_call_id', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'call a tool' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', content: 'file content here', tool_call_id: 'call_1', name: 'read_file' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out.some((m) => m.role === 'tool')).toBe(true);
  });

  it('merges consecutive assistant messages (keeps tool_calls, joins content)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Thinking…' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }],
      },
      // tool response resolves c1 so the merged assistant survives pass 3
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ];
    const out = sanitizeLoop(msgs);
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].tool_calls).toBeDefined();
  });

  it('merges consecutive user messages by joining their content', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'part one' },
      { role: 'user', content: 'part two' },
    ];
    const out = sanitizeLoop(msgs);
    const users = out.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toContain('part one');
    expect(users[0].content).toContain('part two');
  });

  it('strips UI-only fields (items, toolActivities, activeFile) before sending', () => {
    const msg = {
      role: 'user' as const,
      content: 'hello',
      items: [{ type: 'text' as const, content: 'hi' }],
      activeFile: 'notes.md',
    };
    const out = sanitizeLoop([msg]);
    expect((out[0] as any).items).toBeUndefined();
    expect((out[0] as any).activeFile).toBeUndefined();
    expect(out[0].content).toBe('hello');
  });

  it('preserves a properly interleaved conversation unchanged', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Thanks' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

// ── Auth helpers (localStorage) ──────────────────────────────────────────────
describe('getStoredOAuthToken / clearOAuthToken', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when no token is stored', () => {
    expect(getStoredOAuthToken()).toBeNull();
  });

  it('returns the token after it has been written to localStorage', () => {
    localStorage.setItem('copilot-github-oauth-token', 'ghp_test123');
    expect(getStoredOAuthToken()).toBe('ghp_test123');
  });

  it('clearOAuthToken removes the token from localStorage', () => {
    localStorage.setItem('copilot-github-oauth-token', 'ghp_test123');
    clearOAuthToken();
    expect(getStoredOAuthToken()).toBeNull();
  });
});

// ── isQuotaError ─────────────────────────────────────────────────────────────
describe('isQuotaError', () => {
  it('returns true for insufficient_quota', () => {
    expect(isQuotaError('insufficient_quota error')).toBe(true);
  });

  it('returns true for "over their token budget"', () => {
    expect(isQuotaError('User is over their token budget')).toBe(true);
  });

  it('returns true for tokens_quota_exceeded', () => {
    expect(isQuotaError('tokens_quota_exceeded')).toBe(true);
  });

  it('returns true for 429 with quota keyword', () => {
    expect(isQuotaError('429 quota exceeded')).toBe(true);
  });

  it('returns true for 402 with billing keyword', () => {
    expect(isQuotaError('402 billing required')).toBe(true);
  });

  it('returns false for generic network errors', () => {
    expect(isQuotaError('network timeout')).toBe(false);
  });

  it('returns false for 400 bad request', () => {
    expect(isQuotaError('400 bad request')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isQuotaError('INSUFFICIENT_QUOTA')).toBe(true);
  });
});

// ── sanitizeLoop: UI-field stripping ─────────────────────────────────────────
describe('sanitizeLoop — UI-only field stripping', () => {
  it('strips items, activeFile, attachedImage, attachedFile before sending to API', () => {
    const msgs = [
      Object.assign(
        { role: 'user' as const, content: 'hello world' } as ChatMessage,
        {
          activeFile: 'notes.md',
          attachedImage: 'data:image/png;base64,abc123',
          attachedFile: 'doc.pdf',
          items: [{ type: 'text', text: 'hi' }],
        },
      ),
    ];
    const out = sanitizeLoop(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('hello world');
    expect((out[0] as any).activeFile).toBeUndefined();
    expect((out[0] as any).attachedImage).toBeUndefined();
    expect((out[0] as any).attachedFile).toBeUndefined();
    expect((out[0] as any).items).toBeUndefined();
  });

  it('preserves role and content when no UI fields are present', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'clean message' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out[0].content).toBe('clean message');
  });
});

// ── sanitizeLoop: dangling tool_calls (Pass 3) ───────────────────────────────
describe('sanitizeLoop — dangling tool_calls', () => {
  it('drops a trailing assistant message whose tool_calls have no tool responses', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_workspace_file', arguments: '{}' } }],
      },
      // tool response for tc1 was sliced off — dangling assistant
    ];
    const out = sanitizeLoop(msgs);
    expect(out.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('keeps an assistant message when all tool_calls are resolved', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_workspace_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'tc1', content: 'file contents' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out.find((m) => m.role === 'assistant')).toBeDefined();
  });

  it('keeps an assistant with no tool_calls', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out.find((m) => m.role === 'assistant')?.content).toBe('Hi there!');
  });

  it('drops dangling assistant and any partial tool responses before it, then exposes the prior complete exchange', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'step 1' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'tcA', type: 'function', function: { name: 'fn', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'tcA', content: 'result A' },
      { role: 'user', content: 'step 2' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'tcB', type: 'function', function: { name: 'fn2', arguments: '{}' } }],
        // tc B has no tool response — dangling
      },
    ];
    const out = sanitizeLoop(msgs);
    // The dangling assistant (tcB) should be removed
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].tool_calls?.[0].id).toBe('tcA');
  });

  it('drops an assistant whose tool_calls are only partially resolved', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'fn', arguments: '{}' } },
          { id: 'tc2', type: 'function', function: { name: 'fn2', arguments: '{}' } },
        ],
      },
      // Only tc1 resolved, tc2 is missing
      { role: 'tool', tool_call_id: 'tc1', content: 'result 1' },
    ];
    const out = sanitizeLoop(msgs);
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});

// ── modelApiParams ───────────────────────────────────────────────────────────────
describe('modelApiParams', () => {
  it('returns temperature + max_tokens for standard GPT models', () => {
    const p = modelApiParams('gpt-4o', 0.7, 16384);
    expect(p).toEqual({ temperature: 0.7, max_tokens: 16384 });
  });

  it('returns temperature + max_tokens for Claude models', () => {
    const p = modelApiParams('claude-sonnet-4-5', 0.3, 16000);
    expect(p).toEqual({ temperature: 0.3, max_tokens: 16000 });
  });

  it('omits temperature and uses max_completion_tokens for o3', () => {
    const p = modelApiParams('o3', 0.3, 16000);
    expect(p).not.toHaveProperty('temperature');
    expect(p).not.toHaveProperty('max_tokens');
    expect(p).toEqual({ max_completion_tokens: 16000 });
  });

  it('omits temperature and uses max_completion_tokens for o4-mini', () => {
    const p = modelApiParams('o4-mini', 0.3, 16000);
    expect(p).toEqual({ max_completion_tokens: 16000 });
  });

  it('does NOT treat "ollama-..." as o-series', () => {
    const p = modelApiParams('ollama-mistral', 0.5, 4096);
    expect(p).toEqual({ temperature: 0.5, max_tokens: 4096 });
  });

  it('respects the caller-supplied temperature and maxTokens', () => {
    const p = modelApiParams('gpt-4.1', 0.2, 1800);
    expect(p.temperature).toBe(0.2);
    expect(p.max_tokens).toBe(1800);
  });
});
